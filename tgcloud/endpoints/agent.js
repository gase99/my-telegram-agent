// tgcloud/endpoints/agent.js — the Mini App's main entry point.
//
// Request:  { prompt: string, chatId?: number }
// Response: { output, provider, providerLabel, providers[], actions, pending,
//             usage, model, historyId }
//
// The caller is identified only by the platform-verified init data. Any write
// action the model requested is either executed and logged, or (for
// destructive ones) returned as a `pending` approval the UI must confirm.
//
// `provider` is the model that actually answered (gemini · grok · deepseek);
// `providers` carries the same information per provider plus the ones that
// failed over this request, so the status bar can paint green/red badges.

import { EndpointError } from 'sdk';
import { runAgent, isConfigured as aiConfigured, summariseAttempts, providerCatalog } from '../lib/ai.js';
import { ensureChat, addMessage, recentMessages } from '../lib/store.js';
import { isUserAllowed, ACCESS_DENIED_MESSAGE, MAX_PROMPT_LENGTH, redactSecrets } from '../lib/security.js';
import { createApproval, needsApproval } from '../lib/approvals.js';
import { settings } from '../lib/settings.js';

/**
 * An EndpointError is the only way to get a real message to the Mini App: any
 * other exception becomes a generic 500. `code` travels in `parameters` so the
 * UI can branch on it; `status` is advisory metadata for the client.
 */
function fail(description, code, status = 400, parameters = {}) {
  return new EndpointError(description, { code, status, ...parameters });
}

export default async function agentEndpoint(input, ctx) {
  const user = ctx?.initData?.user;
  const userId = user?.id;
  if (!userId) throw fail('این مینی‌اپ باید از داخل تلگرام باز شود.', 'NO_USER');
  if (!isUserAllowed(userId)) throw fail(ACCESS_DENIED_MESSAGE, 'FORBIDDEN');

  const prompt = String(input?.prompt ?? '').trim();
  if (!prompt) throw fail('متن درخواست خالی است.', 'EMPTY_PROMPT');
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw fail(`متن درخواست بیش از حد طولانی است (حداکثر ${MAX_PROMPT_LENGTH} کاراکتر).`, 'PROMPT_TOO_LONG');
  }
  if (!aiConfigured()) {
    throw fail(
      'هیچ کلید هوش مصنوعی روی سرور تنظیم نشده است. یکی از GEMINI_API_KEY / XAI_API_KEY / DEEPSEEK_API_KEY / MOONSHOT_API_KEY را در tgcloud/lib/config.js بگذارید.',
      'AI_NOT_CONFIGURED',
      503,
      { providers: providerCatalog() }
    );
  }

  const chat = await ensureChat({ userId, chatId: input?.chatId ?? null, title: prompt });
  // Read before writing: the stored copy of this prompt must not appear twice
  // in the transcript the model sees (once as history, once as the new turn).
  const history = await recentMessages({ userId, chatRef: chat.id, limit: Math.max(settings.maxHistory - 1, 1) });

  await addMessage({ userId, chatRef: chat.id, role: 'user', content: prompt });

  let result;
  try {
    result = await runAgent({
      userId,
      history,
      prompt,
      needsConfirmation: (action) => needsApproval(action, { requireConfirmation: settings.requireConfirmation }),
    });
  } catch (err) {
    // The turn failed: keep the user's message, tell them why, do not store
    // an empty assistant reply. Per-provider details travel along so the UI
    // can mark the badges that were tried.
    throw fail(redactSecrets(err?.message || 'خطای نامشخص در تماس با مدل'), 'AI_ERROR', 502, {
      attempts: err?.attempts || null,
      providers: summariseAttempts(err?.attempts || [], null),
    });
  }

  const reply = result.reply || '✅ انجام شد.';

  // Destructive work waits for a one-time approval token per action.
  const pending = [];
  for (const item of result.pending || []) {
    pending.push(await createApproval({ userId, action: item.action, reason: item.reason }));
  }

  const assistantRow = await addMessage({ userId, chatRef: chat.id, role: 'assistant', content: reply });

  return {
    output: reply,
    // Which model wrote this answer — the Mini App shows it as
    // "[System: Handled by Grok 🚀]".
    provider: result.provider || null,
    providerLabel: result.providerLabel || null,
    providers: summariseAttempts(result.attempts, result.provider),
    historyId: assistantRow.id,
    actions: (result.actions || []).map((event) => ({
      service: event.service,
      action: event.action,
      label: event.label,
      ok: Boolean(event.ok),
      needsApproval: Boolean(event.needsApproval),
      error: event.error ? redactSecrets(event.error) : null,
      target: event.target || null,
    })),
    pending,
    usage: result.usage || null,
    model: result.model || null,
  };
}
