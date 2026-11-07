// tgcloud/lib/ai.js — multi-provider model transport with automatic failover,
// plus the agent action protocol.
//
// Public surface:
//   generateWithFallback(messages, systemPrompt, options)
//                                  → { text, provider, model, usage, attempts }
//   generate(turns, options)       → the same shape (internal turn format)
//   chat(messages, options)        → string
//   runAgent({ userId, prompt })   → { reply, actions, pending, usage, model,
//                                      provider, attempts }
//   providerCatalog()              → [{ name, label, model, configured }]
//   chainFor(order)                → explicit order + omitted keyed providers
//   summariseAttempts(attempts, usedProvider)
//                                  → per-provider status for the Mini App badges
//   parseActions(text)             → [{ service, action, params, reason }]
//   stripActionBlocks(text)        → the answer without the JSON blocks
//
// Transport rules:
//   • every call goes out through `fetch` from `sdk` — no client libraries;
//   • a key never travels in a URL: Gemini uses the `x-goog-api-key` header,
//     Grok, DeepSeek and Kimi (OpenAI-compatible) use `Authorization: Bearer
//     <key>`;
//   • a provider that answers 401/403/404/429/5xx, hangs for AI_TIMEOUT_MS
//     (default 15s) or returns an empty/blocked answer is logged, recorded,
//     and the next provider in AI_FALLBACK_ORDER answers instead;
//   • `runAgent` passes its turn deadline down, so the chain can never outlive
//     the endpoint's wall-clock budget.

import { fetch, db } from 'sdk';
import { findJsonObjects, truncate } from './text.js';
import { SYSTEM_PROMPT, SUMMARY_INSTRUCTION } from './prompt.js';
import { redactSecrets } from './security.js';
import { runAction, isKnownAction, describeAction, MAX_ACTIONS } from './actions.js';
import { agentActions } from '../schema.js';
import {
  settings,
  providerKey,
  providerModel,
  retiredModels,
  AI_PROVIDERS,
} from './settings.js';

// Gemini 2.5+ "thinking" models spend tokens on reasoning; this keeps a turn
// from silently returning an empty candidate.
const THINKING_BUDGET = 0;
// Leave room inside the platform's endpoint limit for the write-back to the DB.
const AGENT_BUDGET_MS = 42000;
const MIN_STEP_MS = 12000;
// A provider must get at least this much of the remaining turn budget to be
// worth starting; below it the chain stops and reports what it has.
const MIN_PROVIDER_BUDGET_MS = 1500;
// Default per-provider deadline (settings.aiTimeoutMs overrides it).
const DEFAULT_TIMEOUT_MS = 15000;

export class AiError extends Error {
  constructor(message, { status = 0, retryable = false, attempts = null } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.retryable = retryable;
    this.attempts = attempts;
  }
}

/** One provider call failed. `kind` says why, and every kind fails over. */
class ProviderError extends Error {
  constructor(message, { provider = '', status = 0, kind = 'http', failover = true } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.kind = kind;
    this.failover = failover;
  }
}

// ── prompt adapters ─────────────────────────────────────────────────────────
//
// The rest of the app speaks one neutral shape:
//   [{ role: 'user'|'assistant'|'system', content: string }]
// Each provider gets a tiny adapter that converts that into its own layout.

const asText = (value) => String(value ?? '').trim();

/**
 * Split a neutral message list into system instructions and user/assistant
 * turns. `text` is accepted as an alias for `content` so the internal Gemini
 * turn shape ({ role, text }) keeps working.
 */
export function splitMessages(messages) {
  const system = [];
  const turns = [];
  for (const raw of messages || []) {
    const role = String(raw?.role ?? 'user').toLowerCase();
    const content = asText(raw?.content ?? raw?.text ?? '');
    if (!content) continue;
    if (role === 'system' || role === 'developer') {
      system.push(content);
      continue;
    }
    turns.push({ role: role === 'assistant' || role === 'model' ? 'assistant' : 'user', content });
  }
  return { system: system.join('\n\n'), turns };
}

/** Merge consecutive same-role turns (Gemini dislikes duplicates). */
function mergeTurns(turns) {
  const merged = [];
  for (const turn of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) last.content += `\n\n${turn.content}`;
    else merged.push({ ...turn });
  }
  return merged;
}

/**
 * Gemini adapter: `contents: [{ role, parts: [{ text }] }]` plus a separate
 * `systemInstruction`. Roles are `user` and `model` (not `assistant`).
 * @returns {{ url:string, headers:object, body:object }}
 */
export function toGeminiRequest(messages, systemPrompt = '', options = {}) {
  const { system, turns } = splitMessages(messages);
  const contents = mergeTurns(turns).map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.content }],
  }));
  // Gemini expects a user turn first; a history that starts with the model is
  // legal but wastes a turn, so drop the leading model message.
  while (contents.length && contents[0].role === 'model') contents.shift();
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'سلام' }] });

  const model = options.model || settings.geminiModel;
  const instructions = [asText(systemPrompt), system].filter(Boolean).join('\n\n');
  const generationConfig = {
    maxOutputTokens: options.maxOutputTokens ?? settings.aiMaxOutputTokens,
  };
  // Gemini 3+ deprecated numeric thinking budgets (`thinkingBudget`) in favour
  // of the discrete `thinkingLevel`; sending a budget to a 3.x/4.x model can
  // answer 400 INVALID_ARGUMENT. Gemini 2.5 and earlier only understand
  // `thinkingBudget`, so each family gets its own knob, and neither is sent
  // when the model is unknown to us.
  const thinking = thinkingConfigFor(model, options.thinkingLevel ?? settings.aiThinkingLevel);
  if (thinking) generationConfig.thinkingConfig = thinking;
  // Custom sampling made no sense for thinking models and is being rejected by
  // Gemini 3.6+; only send it where the call still honours it.
  if (acceptsSamplingParams(model) && (options.temperature ?? settings.aiTemperature) != null) {
    generationConfig.temperature = options.temperature ?? settings.aiTemperature;
  }
  const body = { contents, generationConfig };
  if (instructions) body.systemInstruction = { parts: [{ text: instructions }] };

  return {
    url: `${settings.geminiBaseUrl}/models/${encodeURIComponent(model)}:generateContent`,
    headers: { 'x-goog-api-key': options.apiKey ?? settings.geminiApiKey },
    body,
  };
}

/**
 * OpenAI-compatible adapter (Grok, DeepSeek and Kimi): a flat `messages`
 * array with a leading `system` entry, `max_tokens`, and
 * `Authorization: Bearer <key>`.
 * @returns {{ url:string, headers:object, body:object }}
 */
export function toOpenAIRequest(messages, systemPrompt = '', options = {}) {
  const { system, turns } = splitMessages(messages);
  const model = options.model || '';
  const chat = [];
  const instructions = [asText(systemPrompt), system].filter(Boolean).join('\n\n');
  if (instructions) chat.push({ role: 'system', content: instructions });
  for (const turn of mergeTurns(turns)) chat.push({ role: turn.role, content: turn.content });
  if (!chat.some((entry) => entry.role !== 'system')) chat.push({ role: 'user', content: 'سلام' });

  return {
    url: `${options.baseUrl}/chat/completions`,
    headers: { Authorization: `Bearer ${options.apiKey}` },
    body: {
      model,
      messages: chat,
      stream: false,
      temperature: options.temperature ?? settings.aiTemperature,
      max_tokens: options.maxOutputTokens ?? settings.aiMaxOutputTokens,
      // DeepSeek V4 and Kimi K2.6+ default to *thinking* mode, which is both
      // slower than the 15s failover deadline and billed as output. The chain
      // is a latency fallback, so it explicitly asks for the non-thinking
      // answer ("instant mode" on Moonshot). `xai` models treat unknown fields
      // as errors, so the switch is vendor-gated.
      ...(options.thinking === false && supportsThinkingSwitch(model)
        ? { thinking: { type: 'disabled' } }
        : {}),
    },
  };
}

/**
 * Vendors that accept the OpenAI-extension `thinking: { type }` field to turn
 * reasoning off: DeepSeek V4+ and Moonshot Kimi K2.6+.
 * DeepSeek ids: `deepseek-flash`, `deepseek-v4-pro`, …
 * Kimi ids:     `kimi-k2.6`, `kimi-k3`, `kimi-k2.7-code`, …
 * Grok/xAI rejects unknown fields, so it must never get this one.
 */
function supportsThinkingSwitch(model) {
  const id = String(model || '');
  return /^deepseek/i.test(id) || /^kimi/i.test(id);
}

/** Gemini response → neutral result. */
export function parseGeminiResponse(data) {
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new ProviderError(
      blockReason ? `🛡 درخواست توسط فیلتر ایمنی مدل رد شد (${blockReason})` : 'پاسخ خالی از مدل',
      { provider: 'gemini', kind: blockReason ? 'blocked' : 'empty' }
    );
  }
  const text = (candidate.content?.parts || [])
    .map((part) => part.text || '')
    .join('')
    .trim();
  if (!text) {
    throw new ProviderError(
      candidate.finishReason === 'MAX_TOKENS'
        ? '✂️ پاسخ به سقف توکن رسید و متن کاملی برنگشت'
        : 'پاسخ خالی از مدل',
      { provider: 'gemini', kind: 'empty' }
    );
  }
  return {
    text,
    model: data?.modelVersion || '',
    finishReason: candidate.finishReason || null,
    usage: data?.usageMetadata || null,
  };
}

/** OpenAI-compatible response → neutral result (usage is normalised). */
export function parseOpenAIResponse(data, provider = 'openai') {
  const choice = data?.choices?.[0];
  const text = asText(choice?.message?.content);
  if (!text) {
    throw new ProviderError(
      choice?.finish_reason === 'length'
        ? '✂️ پاسخ به سقف توکن رسید و متن کاملی برنگشت'
        : 'پاسخ خالی از مدل',
      { provider, kind: 'empty' }
    );
  }
  const raw = data?.usage || null;
  return {
    text,
    model: data?.model || '',
    finishReason: choice?.finish_reason || null,
    usage: raw
      ? {
          ...raw,
          // One shape for the UI regardless of provider.
          totalTokenCount: raw.total_tokens ?? raw.totalTokenCount ?? null,
        }
      : null,
  };
}

/**
 * Gemini thinking controls. Two incompatible APIs exist:
 *   • Gemini 3 and later — `thinkingConfig.thinkingLevel` ('low' | 'high'; the
 *     newer models also accept 'minimal' / 'medium'). `thinkingBudget` is
 *     deprecated and can answer 400 INVALID_ARGUMENT.
 *   • Gemini 2.5 and earlier — `thinkingConfig.thinkingBudget` (a number).
 * Sending the wrong one to the wrong family is an error, so we only send a
 * knob when we can tell which family the model belongs to.
 * @returns {object|null} the `thinkingConfig` object, or null to send none.
 */
export function thinkingConfigFor(model, level = 'low') {
  const id = String(model || '').toLowerCase();
  const major = geminiMajor(id);
  if (major === null) return null;
  if (major >= 3) return { thinkingLevel: normaliseThinkingLevel(level) };
  if (major === 2 && /2\.[5-9]/.test(id)) return { thinkingBudget: THINKING_BUDGET };
  return null; // 1.x / 2.0 have no thinking config at all
}

const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high']);

function normaliseThinkingLevel(level) {
  const value = String(level ?? '').toLowerCase().trim();
  return THINKING_LEVELS.has(value) ? value : 'low';
}

/** `gemini-3.5-flash` → 3, `gemini-2.5-flash` → 2, unknown → null. */
function geminiMajor(model) {
  const match = /gemini-(\d+)(?:[.-](\d+))?/.exec(String(model || ''));
  return match ? Number(match[1]) : null;
}

/**
 * Gemini 3.6+ server-defaults temperature/topP/topK and errors on custom
 * values; older families still accept them.
 */
function acceptsSamplingParams(model) {
  const major = geminiMajor(model);
  if (major === null) return true;
  if (major >= 4) return false;
  if (major === 3) {
    const minor = Number(/gemini-3[.-](\d+)/.exec(String(model).toLowerCase())?.[1] ?? 0);
    return minor < 6;
  }
  return true;
}

// ── provider registry ───────────────────────────────────────────────────────

const PROVIDERS = {
  gemini: {
    label: 'Gemini',
    emoji: '✨',
    key: () => settings.geminiApiKey,
    model: () => settings.geminiModel,
    build: (messages, system, options) => toGeminiRequest(messages, system, options),
    parse: (data) => parseGeminiResponse(data),
  },
  grok: {
    label: 'Grok',
    emoji: '🚀',
    key: () => settings.xaiApiKey,
    model: () => settings.xaiModel,
    build: (messages, system, options) =>
      toOpenAIRequest(messages, system, {
        ...options,
        apiKey: options.apiKey ?? settings.xaiApiKey,
        baseUrl: settings.xaiBaseUrl,
      }),
    parse: (data) => parseOpenAIResponse(data, 'grok'),
  },
  deepseek: {
    label: 'DeepSeek',
    emoji: '🐋',
    key: () => settings.deepseekApiKey,
    model: () => settings.deepseekModel,
    build: (messages, system, options) =>
      toOpenAIRequest(messages, system, {
        ...options,
        apiKey: options.apiKey ?? settings.deepseekApiKey,
        baseUrl: settings.deepseekBaseUrl,
        // V4 thinks by default; a failover hop must answer inside its deadline.
        thinking: false,
      }),
    parse: (data) => parseOpenAIResponse(data, 'deepseek'),
  },
  kimi: {
    // Moonshot AI's Kimi. Same OpenAI-compatible shape as Grok and DeepSeek,
    // so the adapter is shared; only the base URL and the thinking switch
    // differ (K2.6+ thinks by default, exactly like DeepSeek V4).
    label: 'Kimi',
    emoji: '🌙',
    key: () => settings.moonshotApiKey,
    model: () => settings.kimiModel,
    build: (messages, system, options) =>
      toOpenAIRequest(messages, system, {
        ...options,
        apiKey: options.apiKey ?? settings.moonshotApiKey,
        baseUrl: settings.kimiBaseUrl,
        thinking: false,
      }),
    parse: (data) => parseOpenAIResponse(data, 'kimi'),
  },
};

/** True when at least one provider has a key. */
export function isConfigured() {
  return AI_PROVIDERS.some((name) => Boolean(providerKey(name)));
}

/** Provider names that actually take part in a request, in fallback order. */
export function fallbackOrder(order = settings.aiFallbackOrder) {
  const names = (Array.isArray(order) ? order : [])
    .map((name) => String(name).toLowerCase().trim())
    .filter((name) => PROVIDERS[name]);
  const unique = [...new Set(names)];
  if (unique.length) return unique;
  const fallback = settings.aiFallbackOrder.filter((name) => PROVIDERS[name]);
  // A config older than the provider registry states no usable order at all.
  return fallback.length ? fallback : [...AI_PROVIDERS];
}

/**
 * The providers a request will actually walk through: the explicit order
 * first, then any provider that has a key but is missing from it.
 *
 * Why: `AI_FALLBACK_ORDER` in a deployed `config.js` may predate a provider
 * (Kimi was added after the first three). Without this, pasting
 * MOONSHOT_API_KEY into an old config would silently never be tried. An
 * explicit position still wins, so a hand-written order is never overturned.
 */
export function chainFor(order = settings.aiFallbackOrder) {
  const explicit = fallbackOrder(order);
  const rest = AI_PROVIDERS.filter((name) => !explicit.includes(name) && Boolean(providerKey(name)));
  return [...explicit, ...rest];
}

/** Everything the status bar needs to draw the model badges. */
export function providerCatalog() {
  // A retired id answers 404 mid-conversation; say so up front instead.
  const retired = new Map(retiredModels().map((item) => [item.provider, item]));
  return chainFor().map((name) => {
    const stale = retired.get(name);
    return {
      name,
      label: PROVIDERS[name].label,
      emoji: PROVIDERS[name].emoji,
      model: providerModel(name),
      configured: Boolean(providerKey(name)),
      retiredModel: Boolean(stale),
      suggestedModel: stale ? stale.replacement : '',
    };
  });
}

/**
 * Per-provider status for one request:
 *   active  — answered the request (green)
 *   failed  — was tried and failed (red)
 *   skipped — no API key configured
 *   idle    — configured, not needed this time
 */
export function summariseAttempts(attempts = [], usedProvider = null) {
  return chainFor().map((name) => {
    const provider = PROVIDERS[name];
    const seen = (attempts || []).filter((attempt) => attempt?.provider === name);
    const last = seen[seen.length - 1] || null;
    let status = 'idle';
    if (name === usedProvider && last?.ok) status = 'active';
    else if (last && !last.ok && !last.skipped) status = 'failed';
    else if (!providerKey(name)) status = 'skipped';
    else if (last?.ok) status = 'active';
    return {
      name,
      label: provider.label,
      emoji: provider.emoji,
      status,
      configured: Boolean(providerKey(name)),
      kind: last?.kind || null,
      message: last?.message || '',
      // How long this provider took on its last try, for the latency chip.
      ms: Number.isFinite(last?.ms) ? last.ms : null,
      // Every attempt of this turn (a retry-free chain has at most one).
      tryCount: seen.length,
    };
  });
}

// ── HTTP transport ──────────────────────────────────────────────────────────

function timersAvailable() {
  return typeof setTimeout === 'function' && typeof clearTimeout === 'function';
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return settings.aiTimeoutMs || DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.floor(n), 1000), 60000);
}

/** How long a provider may take: its own cap, bounded by the turn deadline. */
function providerBudget(timeoutMs, deadline) {
  if (!Number.isFinite(deadline)) return timeoutMs;
  return Math.min(timeoutMs, deadline - Date.now());
}

/**
 * POST JSON through `sdk`'s fetch with a hard deadline. On timeout the request
 * is aborted (`AbortController`, when the isolate provides one) and the caller
 * moves on to the next provider.
 */
async function postJson(url, { headers, body, timeoutMs, providerName }) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
  if (controller) init.signal = controller.signal;

  const seconds = Math.round(timeoutMs / 1000);
  let timer = null;
  let res;
  try {
    if (timersAvailable() && timeoutMs > 0) {
      const guard = new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { controller?.abort(); } catch { /* already aborted */ }
          reject(
            new ProviderError(`⏱ پاسخ در ${seconds} ثانیه نرسید`, {
              provider: providerName,
              status: 408,
              kind: 'timeout',
            })
          );
        }, timeoutMs);
      });
      res = await Promise.race([fetch(url, init), guard]);
    } else {
      res = await fetch(url, init);
    }
  } catch (err) {
    throw asProviderError(err, providerName);
  } finally {
    if (timer && timersAvailable()) clearTimeout(timer);
  }

  let raw = '';
  try {
    raw = await res.text();
  } catch {
    raw = '';
  }
  const data = parseBody(raw);

  if (!res.ok) {
    throw new ProviderError(failureMessage(res.status, data, raw), {
      provider: providerName,
      status: res.status,
      kind: classifyStatus(res.status),
    });
  }
  if (data === null) {
    throw new ProviderError(`🧾 پاسخ JSON نامعتبر (${res.status})`, {
      provider: providerName,
      status: res.status,
      kind: 'invalid_body',
    });
  }
  return data;
}

function parseBody(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** 429 / 403 / 5xx / timeouts / network errors all fail over. */
function classifyStatus(status) {
  if (!status) return 'network';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  if (status === 400 || status === 422) return 'bad_request';
  return 'http';
}

const KIND_LABELS = {
  auth: '🔑 کلید نامعتبر',
  forbidden: '🚫 دسترسی/سهمیه رد شد',
  not_found: '❓ مدل یا مسیر پیدا نشد',
  timeout: '⏱ زمان پاسخ تمام شد',
  rate_limit: '⏳ محدودیت نرخ یا سهمیه',
  server: '🔥 خطای سرور',
  bad_request: '✋ درخواست نامعتبر',
  network: '🌐 خطای شبکه',
  empty: '🫙 پاسخ خالی',
  blocked: '🛡 فیلتر ایمنی',
  invalid_body: '🧾 پاسخ ناخوانا',
  http: '⚠️ خطای HTTP',
  not_configured: '🔌 کلید تنظیم نشده',
  budget: '⌛ زمان نوبت تمام شد',
};

/**
 * One Persian line for a provider failure. The provider name is deliberately
 * absent: callers prefix it (`• Gemini: …` in the final error, the badge title
 * in the Mini App, the attempt label in the log).
 */
function failureMessage(status, data, rawText) {
  const detail = extractProviderMessage(data, rawText).slice(0, 220);
  const label = KIND_LABELS[classifyStatus(status)] || KIND_LABELS.http;
  return `${label} (${status})${detail ? ` — ${detail}` : ''}`;
}

function extractProviderMessage(data, rawText) {
  if (!data) return redactSecrets(String(rawText ?? '').slice(0, 220));
  const raw =
    (data.error && (data.error.message || (typeof data.error === 'string' && data.error))) ||
    data.message ||
    data.error_description ||
    (Array.isArray(data.errors) && data.errors.map((entry) => entry?.message || entry?.code).join('; ')) ||
    '';
  return raw ? redactSecrets(String(raw)) : '';
}

function asProviderError(err, providerName) {
  if (err instanceof ProviderError) {
    if (!err.provider) err.provider = providerName;
    return err;
  }
  const message = redactSecrets(err?.message || String(err) || 'خطای نامشخص');
  const aborted = /abort|cancel/i.test(message);
  return new ProviderError(`🌐 ${aborted ? 'درخواست لغو شد' : `خطای شبکه — ${message}`}`, {
    provider: providerName,
    status: 0,
    kind: aborted ? 'timeout' : 'network',
  });
}

function logFailure(name, provider, error) {
  try {
    const status = error.status ? ` ${error.status}` : '';
    console.warn(`[ai] ${provider.label} (${name}) failed [${error.kind}${status}] → next provider: ${redactSecrets(error.message)}`);
  } catch {
    // Logging must never break the chain.
  }
}

// ── the orchestrator ────────────────────────────────────────────────────────

/**
 * Ask the configured providers in order until one answers.
 *
 * @param {{role:string, content:string}[]} messages  neutral prompt
 * @param {string} [systemPrompt]
 * @param {object} [options]
 * @param {string[]}  [options.providers]     override AI_FALLBACK_ORDER
 * @param {number}    [options.timeoutMs]     per-provider deadline (default 15s)
 * @param {number}    [options.deadline]      absolute epoch ms for the whole chain
 * @param {string}    [options.model]         model id for the first provider only
 * @param {object}    [options.models]        per-provider model overrides
 * @param {number}    [options.temperature]
 * @param {number}    [options.maxOutputTokens]
 * @returns {Promise<{ text:string, provider:string, providerLabel:string,
 *                     model:string, usage:object|null, finishReason:string|null,
 *                     attempts:object[] }>}
 */
export async function generateWithFallback(messages, systemPrompt = '', options = {}) {
  // Only an explicit per-call list is authoritative; otherwise the configured
  // order is extended with every keyed provider so a newer provider is not
  // silently ignored by a stale config.
  const order = options.providers ? fallbackOrder(options.providers) : chainFor();
  const timeoutMs = clampTimeout(options.timeoutMs ?? settings.aiTimeoutMs);
  const attempts = [];

  for (const name of order) {
    const provider = PROVIDERS[name];
    const apiKey = provider.key();

    if (!apiKey) {
      attempts.push({
        provider: name,
        label: provider.label,
        ok: false,
        skipped: true,
        status: 0,
        kind: 'not_configured',
        ms: 0,
        message: 'کلید API تنظیم نشده',
      });
      continue;
    }

    const budget = providerBudget(timeoutMs, options.deadline);
    // Only a shrinking turn budget stops the chain: an explicitly short
    // per-request timeout is the caller's choice and still gets a try.
    if (Number.isFinite(options.deadline) && budget < MIN_PROVIDER_BUDGET_MS) {
      attempts.push({
        provider: name,
        label: provider.label,
        ok: false,
        skipped: false,
        status: 0,
        kind: 'budget',
        ms: 0,
        message: 'زمان نوبت پیش از رسیدن به این ارائه‌دهنده تمام شد',
      });
      continue;
    }

    const models = options.models && typeof options.models === 'object' ? options.models : {};
    const model = models[name] || (name === order[0] ? options.model : '') || provider.model();
    const startedAt = Date.now();

    try {
      const built = provider.build(messages, systemPrompt, {
        ...options,
        apiKey,
        model,
        temperature: options.temperature ?? settings.aiTemperature,
        maxOutputTokens: options.maxOutputTokens ?? settings.aiMaxOutputTokens,
      });
      const data = await postJson(built.url, {
        headers: built.headers,
        body: built.body,
        providerName: name,
        timeoutMs: budget,
      });
      const parsed = provider.parse(data);
      attempts.push({
        provider: name,
        label: provider.label,
        ok: true,
        skipped: false,
        status: 200,
        kind: 'ok',
        ms: Date.now() - startedAt,
        message: '',
      });
      return {
        text: parsed.text,
        provider: name,
        providerLabel: provider.label,
        model: parsed.model || model,
        usage: parsed.usage || null,
        finishReason: parsed.finishReason || null,
        attempts,
      };
    } catch (err) {
      const error = asProviderError(err, name);
      logFailure(name, provider, error);
      attempts.push({
        provider: name,
        label: provider.label,
        ok: false,
        skipped: false,
        status: error.status || 0,
        kind: error.kind,
        ms: Date.now() - startedAt,
        message: redactSecrets(error.message),
      });
    }
  }

  throw allProvidersFailed(attempts);
}

/** One comprehensive error: what each provider said, and what to do next. */
function allProvidersFailed(attempts) {
  const tried = attempts.filter((attempt) => !attempt.skipped);
  const noKeys = attempts.length > 0 && tried.length === 0;

  if (!attempts.length) {
    return new AiError('🤖 هیچ ارائه‌دهنده‌ای در AI_FALLBACK_ORDER تعریف نشده است.', {
      status: 503,
      attempts,
    });
  }

  const message = noKeys
    ? '🤖 هیچ کلید هوش مصنوعی تنظیم نشده است. یکی از GEMINI_API_KEY / XAI_API_KEY / DEEPSEEK_API_KEY / MOONSHOT_API_KEY را در tgcloud/lib/config.js بگذارید.'
    : [
        `🤖 هیچ‌کدام از ${attempts.length} ارائه‌دهنده پاسخ ندادند.`,
        ...attempts.map((attempt) => `• ${attempt.label}: ${attempt.message || attempt.kind}`),
        'کلیدها و سهمیه‌ها را در tgcloud/lib/config.js بررسی کنید (AI_FALLBACK_ORDER).',
      ].join('\n');

  return new AiError(truncate(message, 1200), { status: 503, retryable: true, attempts });
}

/**
 * Low-level completion in the internal turn format.
 * @param {{role:'user'|'model'|'assistant',text:string}[]} turns
 * @param {object} options  see generateWithFallback
 */
export async function generate(turns, options = {}) {
  const messages = (turns || []).map((turn) => ({
    role: turn.role === 'model' ? 'assistant' : turn.role,
    content: String(turn.text ?? turn.content ?? ''),
  }));
  return generateWithFallback(messages, options.system || '', {
    providers: options.providers,
    timeoutMs: options.timeoutMs,
    deadline: options.deadline,
    model: options.model,
    models: options.models,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
  });
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
  // The model expects a user turn first; a history that starts with the model
  // is legal but wastes a turn, so drop the leading model message.
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
  const attempts = [];
  const maxSteps = settings.maxAgentSteps;
  // Endpoints have a wall-clock limit. Stop starting new model round-trips
  // when the turn is close to it; the answer gathered so far is returned
  // rather than truncated by the platform.
  const deadline = Date.now() + budgetMs;
  const timeLeft = () => deadline - Date.now();

  let modelResult = await generate(turns, { system: SYSTEM_PROMPT, deadline });
  attempts.push(...(modelResult.attempts || []));
  let finalText = modelResult.text;
  // Set when work ran but no model narrated it, so the reply is built from the
  // tool results instead of leaking the raw `[نتیجه اجرای عملیات]` payload.
  let narration = null;

  for (let step = 0; step < maxSteps; step++) {
    const requested = parseActions(finalText);
    if (!requested.length) break;
    if (timeLeft() < MIN_STEP_MS) {
      // The model asked for work we have no time to run: say so, and keep any
      // action list out of the reply.
      narration = `⏱ زمان این نوبت تمام شد و ${requested.length} عملیات درخواستی اجرا نشد. دوباره بفرستید یا دامنه کار را کوچک‌تر کنید.`;
      break;
    }

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
          error: 'در انتظار تأیید کاربر؛ عملیات اجرا نشد. به کاربر بگو با دکمه تأیید در مینی‌اپ آن را اجرا کند.',
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

    // Out of time for another round-trip: keep an answer the user can act on
    // instead of the tool payload or a bare "I'll do it" preamble.
    if (timeLeft() < MIN_STEP_MS) {
      narration = fallbackSummary('', events, pending, '⏱ زمان نوبت پیش از خلاصه‌سازی تمام شد.');
      break;
    }
    const summary = await generate(turns, { system: SYSTEM_PROMPT, deadline }).catch((err) => {
      // The work already happened. A dead provider chain must not turn a
      // successful GitHub/Drive operation into an error for the user, so the
      // results are reported directly instead of failing the whole turn.
      // The per-provider detail is already in the log; the user gets one line.
      console.warn(`[ai] summary step failed: ${redactSecrets(err?.message || String(err))}`);
      narration = fallbackSummary('', events, pending, '⚠️ خلاصه‌سازی با مدل ممکن نشد؛ نتیجه عملیات:');
      return null;
    });
    if (!summary) break;
    attempts.push(...(summary.attempts || []));
    modelResult = summary;
    finalText = summary.text;
  }

  // A step limit (`MAX_AGENT_STEPS`) can end the loop with results the model
  // never narrated. Replace that payload with a summary of what really happened.
  if (!narration && events.length) {
    const prose = stripActionBlocks(finalText);
    if (!prose || /\[نتیجه اجرای عملیات\]/.test(finalText) || parseActions(finalText).length) {
      narration = fallbackSummary('', events, pending);
    }
  }

  return {
    reply: narration || stripActionBlocks(finalText),
    raw: finalText,
    actions: events,
    pending,
    model: modelResult?.model || null,
    usage: modelResult?.usage || null,
    // Which provider wrote the last answer, and every attempt of this turn.
    provider: modelResult?.provider || null,
    providerLabel: modelResult?.providerLabel || null,
    attempts,
    // True when the reply was built from tool results (the model never narrated).
    fallback: Boolean(narration),
  };
}

/**
 * The turn ran out of wall-clock budget before the model could narrate its
 * tool results. Build the answer from the results themselves so an executed
 * action (create file, open PR, …) is never reported as a bare "ok, doing it".
 */
function fallbackSummary(text, events, pending, note = '') {
  const prose = stripActionBlocks(text);
  const lines = note ? [note] : [];
  for (const event of events || []) {
    const ok = event.ok ? '✅' : '❌';
    const label = event.label || `${event.service}.${event.action}`;
    const detail = event.ok
      ? toolDetail(event)
      : redactSecrets(event.error || 'خطای نامشخص');
    lines.push(`${ok} ${label}${detail ? ` — ${detail}` : ''}`);
  }
  for (const item of pending || []) {
    lines.push(`⏳ ${item.label} — منتظر تأیید شما در مینی‌اپ`);
  }
  if (!lines.length) return prose;
  return [prose, lines.join('\n')].filter(Boolean).join('\n\n');
}

/** One short human line from a tool result (links and ids first). */
function toolDetail(event) {
  const data = event.data || event.summary || null;
  if (!data || typeof data !== 'object') return typeof data === 'string' ? truncate(data, 160) : '';
  const bits = [];
  if (data.url || data.html_url) bits.push(`🔗 ${data.url || data.html_url}`);
  if (data.path || data.name) bits.push(String(data.path || data.name));
  if (typeof data.content === 'string' && data.content) bits.push(`${data.content.length} کاراکتر`);
  if (Array.isArray(data.entries)) bits.push(`${data.entries.length} مورد`);
  if (Array.isArray(data.items)) bits.push(`${data.items.length} مورد`);
  if (data.branch) bits.push(`شاخه: ${data.branch}`);
  if (data.number) bits.push(`#${data.number}`);
  if (data.commit) bits.push(`commit: ${String(data.commit).slice(0, 7)}`);
  return truncate(bits.join(' • '), 200);
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
