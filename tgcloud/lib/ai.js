// tgcloud/lib/ai.js — Gemini wrapper plus the agent action protocol.
//
// Public surface:
//   chat(messages, options)      → string                 plain completion
//   runAgent({ userId, prompt }) → { reply, actions, pending, usage, model }
//   parseActions(text)           → [{ service, action, params, reason }]
//   stripActionBlocks(text)      → the answer without the JSON blocks
//
// Gemini's REST API is called with the platform `fetch`; the key only ever
// travels in the `x-goog-api-key` header, never in a URL that could end up in
// an error message.

import { request, HttpError } from './http.js';
import { findJsonObjects, truncate } from './text.js';
import { SYSTEM_PROMPT, SUMMARY_INSTRUCTION } from './prompt.js';
import { redactSecrets } from './security.js';
import { runAction, isKnownAction, describeAction, MAX_ACTIONS } from './actions.js';
import { db } from 'sdk';
import { agentActions } from '../schema.js';
import { settings } from './settings.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

function modelName() {
  return settings.geminiModel;
}
// Gemini 2.5+ "thinking" models spend tokens on reasoning; this keeps a turn
// from silently returning an empty candidate.
const THINKING_BUDGET = 0;
// Leave room inside the platform's endpoint limit for the write-back to the DB.
const AGENT_BUDGET_MS = 42000;
const MIN_STEP_MS = 12000;

export class AiError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** True when the model is configured; endpoints use it for a friendly error. */
export function isConfigured() {
  return Boolean(settings.geminiApiKey);
}

/**
 * Low-level completion.
 * @param {{role:'user'|'model',text:string}[]} turns
 * @param {object} options
 * @param {string} [options.system]      system instruction
 * @param {string} [options.model]
 * @param {number} [options.temperature]
 * @param {number} [options.maxOutputTokens]
 */
export async function generate(turns, options = {}) {
  if (!settings.geminiApiKey) {
    throw new AiError('🤖 کلید Gemini تنظیم نشده است: GEMINI_API_KEY در tgcloud/lib/config.js خالی است.', {
      status: 503,
    });
  }
  const model = options.model || modelName();
  const body = {
    contents: turns.map((turn) => ({
      role: turn.role === 'assistant' || turn.role === 'model' ? 'model' : 'user',
      parts: [{ text: String(turn.text ?? '') }],
    })),
    generationConfig: {
      temperature: options.temperature ?? settings.geminiTemperature,
      maxOutputTokens: options.maxOutputTokens ?? settings.geminiMaxOutputTokens,
      // 3.x flash models are thinking models: without a budget they can return
      // only reasoning tokens and an empty text part.
      ...(isThinkingModel(model) ? { thinkingConfig: { thinkingBudget: THINKING_BUDGET } } : {}),
    },
  };
  if (options.system) body.systemInstruction = { parts: [{ text: options.system }] };

  let res;
  try {
    res = await request(`${API_ROOT}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': settings.geminiApiKey, 'Content-Type': 'application/json' },
      body,
      service: 'Gemini',
      timeoutMs: 60000,
      retries: 1,
    });
  } catch (err) {
    throw new AiError(translateGeminiError(err), { status: err.status || 0, retryable: err.retryable });
  }

  const data = res.data;
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new AiError(
      blockReason
        ? `🛡 درخواست توسط فیلتر ایمنی مدل رد شد (${blockReason}).`
        : '🤖 پاسخ خالی از مدل دریافت شد. دوباره تلاش کنید.'
    );
  }
  const text = (candidate.content?.parts || [])
    .map((part) => part.text || '')
    .join('')
    .trim();

  if (!text && candidate.finishReason === 'MAX_TOKENS') {
    throw new AiError('✂️ پاسخ مدل به سقف توکن رسید؛ سؤال را کوتاه‌تر کنید یا GEMINI_MAX_OUTPUT_TOKENS را افزایش دهید.');
  }

  return {
    text,
    model: data.modelVersion || model,
    finishReason: candidate.finishReason,
    usage: data.usageMetadata || null,
  };
}

function isThinkingModel(model) {
  return /gemini-(2\.5|[3-9])/.test(String(model));
}

function translateGeminiError(err) {
  if (err instanceof HttpError) {
    if (err.status === 429) return '⏳ سهمیه درخواست Gemini پر شده است؛ چند دقیقه بعد دوباره امتحان کنید.';
    if (err.status === 400 || err.status === 404) {
      return `🤖 مدل «${modelName()}» در دسترس نیست یا درخواست نامعتبر بود. GEMINI_MODEL را در config.js بررسی کنید.`;
    }
    if (err.status === 403) return '🔑 دسترسی به Gemini رد شد؛ کلید API و محدودیت‌های آن را بررسی کنید.';
    return redactSecrets(err.message);
  }
  return redactSecrets(err?.message || 'خطای نامشخص در تماس با Gemini');
}

/** Turn stored rows into alternating turns, merging consecutive same-role items. */
export function toTurns(messages) {
  const turns = [];
  for (const message of messages || []) {
    const role = message.role === 'assistant' ? 'model' : 'user';
    const text = String(message.content ?? '').trim();
    if (!text) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text += `\n\n${text}`;
    else turns.push({ role, text });
  }
  // Gemini expects a user turn first; a history that starts with the model is
  // legal but wastes a turn, so drop the leading model message.
  while (turns.length && turns[0].role === 'model') turns.shift();
  return turns;
}

// ── action protocol ─────────────────────────────────────────────────────────

const ACTION_BLOCK = /```(?:action|json:action|tool|tool_call)\s*([\s\S]*?)```/gi;

/**
 * Extract the actions a model answer requests.
 * Accepts a fenced ```action block, a bare `{"actions":[...]}` object, or a
 * single `{"service":...}` object. Anything unknown is ignored, not executed.
 */
export function parseActions(text) {
  const source = String(text ?? '');
  const candidates = [];

  ACTION_BLOCK.lastIndex = 0;
  let blocks = 0;
  let match;
  while ((match = ACTION_BLOCK.exec(source)) !== null) {
    blocks += 1;
    for (const found of findJsonObjects(match[1])) candidates.push(found.value);
  }

  // Only fall back to a whole-text scan when the model used no action fence at
  // all. If a fence exists but its JSON is broken, the code samples around it
  // must not be mistaken for operations — a partial execution is worse than
  // none, because the model never learns what failed.
  if (!blocks) {
    for (const found of findJsonObjects(source)) candidates.push(found.value);
  }

  const actions = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const list = Array.isArray(candidate.actions) ? candidate.actions : [candidate];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const service = String(entry.service || '').toLowerCase();
      const action = String(entry.action || '');
      if (!service || !action) continue;
      if (!isKnownAction(service, action)) continue;
      const params = entry.params && typeof entry.params === 'object' ? entry.params : {};
      actions.push({
        service,
        action,
        params,
        reason: typeof entry.reason === 'string' ? entry.reason : '',
      });
      if (actions.length >= MAX_ACTIONS) return actions;
    }
  }
  return actions;
}

/** The user-facing answer: the action blocks removed. */
export function stripActionBlocks(text) {
  return String(text ?? '')
    .replace(ACTION_BLOCK, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── agent loop ──────────────────────────────────────────────────────────────

/**
 * One agent turn: the model answers, its requested actions are executed, the
 * results are fed back, and the model summarises. Bounded by MAX_AGENT_STEPS
 * and MAX_ACTIONS_PER_TURN so a model loop can never run away.
 *
 * @param {object} args
 * @param {number} args.userId           Telegram user, for the audit log
 * @param {Array}  args.history          previous messages ({role, content})
 * @param {string} args.prompt           the new user message
 * @param {(text:string)=>void} [args.onToolEvent] progress callback
 */
export async function runAgent({
  userId,
  history = [],
  prompt,
  onToolEvent,
  needsConfirmation = () => false,
  budgetMs = AGENT_BUDGET_MS,
}) {
  const turns = toTurns([...history, { role: 'user', content: prompt }]);
  const events = [];
  const pending = [];
  const maxSteps = settings.maxAgentSteps;
  // Endpoints have a wall-clock limit. Stop starting new model round-trips
  // when the turn is close to it; the answer gathered so far is returned
  // rather than truncated by the platform.
  const deadline = Date.now() + budgetMs;
  const timeLeft = () => deadline - Date.now();

  let modelResult = await generate(turns, { system: SYSTEM_PROMPT });
  let finalText = modelResult.text;

  for (let step = 0; step < maxSteps; step++) {
    const requested = parseActions(finalText);
    if (!requested.length) break;
    if (timeLeft() < MIN_STEP_MS) break;

    const results = [];
    for (const action of requested.slice(0, MAX_ACTIONS)) {
      const label = describeAction(action);
      if (onToolEvent) onToolEvent({ phase: 'start', label, action });

      let outcome;
      if (needsConfirmation(action)) {
        // Nothing runs yet: the endpoint turns this into an approval card.
        pending.push({ action, label, reason: action.reason || '' });
        outcome = {
          ok: false,
          needsApproval: true,
          error: 'در انتظار تأیید کاربر؛ عملیات اجرا نشد. به کاربر بگو با دکمه تأیید در مینیاپ آن را اجرا کند.',
        };
      } else {
        try {
          outcome = await runAction(action, { userId, allowWrites: true });
        } catch (err) {
          outcome = { ok: false, error: redactSecrets(err?.message || String(err)) };
        }
      }

      events.push({ ...action, label, ...outcome });
      if (!outcome.needsApproval) await recordAction(userId, action, outcome);
      if (onToolEvent) onToolEvent({ phase: 'end', label, action, outcome });
      results.push({ request: { service: action.service, action: action.action, params: sanitiseParams(action.params) }, outcome });
    }

    // The action payload is replaced by its results; the model narrates them.
    finalText = `${stripActionBlocks(finalText)}\n\n[نتیجه اجرای عملیات]\n${truncate(
      JSON.stringify(results, null, 2),
      12000
    )}`;

    turns.push({ role: 'model', text: finalText });
    turns.push({ role: 'user', text: SUMMARY_INSTRUCTION });

    if (timeLeft() < MIN_STEP_MS) break;
    modelResult = await generate(turns, { system: SYSTEM_PROMPT });
    finalText = modelResult.text;
  }

  return {
    reply: stripActionBlocks(finalText),
    raw: finalText,
    actions: events,
    pending,
    model: modelResult.model,
    usage: modelResult.usage,
  };
}

/** Never store a whole file body in the audit log. */
function sanitiseParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (typeof value === 'string' && value.length > 500) out[key] = `${value.slice(0, 200)}… (${value.length} chars)`;
    else out[key] = value;
  }
  return out;
}

async function recordAction(userId, action, outcome) {
  try {
    await db
      .insert(agentActions)
      .values({
        userId,
        service: action.service,
        action: action.action,
        target: outcome?.target || describeTarget(action),
        status: outcome?.ok ? 'ok' : 'error',
        summary: truncate(outcome?.ok ? JSON.stringify(outcome.data ?? outcome.summary ?? '') : outcome?.error || '', 900),
      })
      .run();
  } catch {
    // The audit log must never break a turn that otherwise succeeded.
  }
}

function describeTarget(action) {
  const p = action.params || {};
  return [p.repo || p.project || p.fileId, p.path || p.name || p.branch || p.folderId].filter(Boolean).join(' › ');
}

/** Plain chat completion used by the Telegram handler (no tools). */
export async function chat(messages, options = {}) {
  const result = await generate(toTurns(messages), { system: SYSTEM_PROMPT, ...options });
  return result.text;
}
