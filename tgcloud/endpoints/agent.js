// tgcloud/endpoints/agent.js — the Mini App's main entry point.
//
// Request:  { prompt: string, chatId?: number }
// Response: { output, actions, pending, usage, historyId }
//
// The caller is identified only by the platform-verified init data. Any write
// action the model requested is either executed and logged, or (for
// destructive ones) returned as a `pending` approval the UI must confirm.

import { EndpointError } from 'sdk';
import { runAgent, isConfigured as aiConfigured } from '../lib/ai.js';
import { ensureChat, addMessage, recentMessages } from '../lib/store.js';
import { isUserAllowed, ACCESS_DENIED_MESSAGE, MAX_PROMPT_LENGTH, redactSecrets } from '../lib/security.js';
import { createApproval, needsApproval } from '../lib/approvals.js';
import { settings } from '../lib/settings.js';

/**
 * An EndpointError is the only way to get a real message to the Mini App: any
 * other exception becomes a generic 500. `code` travels in `parameters` so the
 * UI can branch on it; `status` is advisory metadata for the client.
 */
function fail(description, code, status = 400) {
  return new EndpointError(description, { code, status });
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
    throw fail('کلید Gemini روی سرور تنظیم نشده است. GEMINI_API_KEY را در tgcloud/lib/config.js بگذارید.', 'AI_NOT_CONFIGURED', 503);
  }

  const chat = await ensureChat({ userId, chatId: input?.chatId ?? null, title: prompt });
  const history = await recentMessages({ userId, chatRef: chat.id, limit: settings.maxHistory });

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
    // an empty assistant reply.
    throw fail(redactSecrets(err?.message || 'خطای نامشخص در تماس با مدل'), 'AI_ERROR', 502);
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
