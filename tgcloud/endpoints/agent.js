// tgcloud/endpoints/agent.js — authenticated Mini App chat and Python execution.
//
// Requests use the verified Telegram identity from ctx.initData; a client-sent
// user id is never trusted. Chat history is read before the new prompt is
// inserted, because runAgent receives the prompt separately.

import { EndpointError } from 'sdk';
import { runAgent, summariseAttempts } from '../lib/ai.js';
import { createApproval, needsApproval, pendingApprovals } from '../lib/approvals.js';
import { ensureChat, recentMessages, addMessage } from '../lib/store.js';
import { isUserAllowed, ACCESS_DENIED_MESSAGE, MAX_PROMPT_LENGTH, redactSecrets } from '../lib/security.js';
import { executeCode } from '../lib/runner.js';

const MAX_EXECUTABLE_CODE_LENGTH = 12000;

export default async function agent(input, ctx) {
  const userId = ctx?.initData?.user?.id;
  if (!userId) {
    throw new EndpointError('این مینی‌اپ باید از داخل تلگرام باز شود.', {
      code: 'NO_USER',
      status: 401,
    });
  }
  if (!isUserAllowed(userId)) {
    throw new EndpointError(ACCESS_DENIED_MESSAGE, { code: 'FORBIDDEN', status: 403 });
  }

  const action = typeof input?.action === 'string' ? input.action.toLowerCase() : 'chat';
  const rawPrompt = typeof input?.prompt === 'string' ? input.prompt : '';
  const prompt = action === 'execute' ? rawPrompt : rawPrompt.trim();
  if (!prompt.trim()) {
    throw new EndpointError('پیام نمی‌تواند خالی باشد.', { code: 'EMPTY_PROMPT', status: 400 });
  }

  if (action === 'execute') {
    if (prompt.length > MAX_EXECUTABLE_CODE_LENGTH) {
      throw new EndpointError(`کد باید حداکثر ${MAX_EXECUTABLE_CODE_LENGTH} نویسه باشد.`, {
        code: 'CODE_TOO_LONG',
        status: 413,
      });
    }

    const startedAt = Date.now();
    try {
      const output = await executeCode(prompt);
      return {
        output,
        response: output,
        action: 'execute',
        language: 'python',
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      throw new EndpointError(redactSecrets(err?.message || 'اجرای کد ناموفق بود.'), {
        code: 'EXECUTION_FAILED',
        status: 502,
      });
    }
  }

  if (action !== 'chat') {
    throw new EndpointError('نوع درخواست پشتیبانی نمی‌شود.', { code: 'INVALID_ACTION', status: 400 });
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new EndpointError(`پیام باید حداکثر ${MAX_PROMPT_LENGTH} نویسه باشد.`, {
      code: 'PROMPT_TOO_LONG',
      status: 413,
    });
  }

  const startedAt = Date.now();
  const chat = await ensureChat({ userId });
  const history = await recentMessages({ userId, chatRef: chat.id });
  await addMessage({ userId, chatRef: chat.id, role: 'user', content: prompt });

  let result;
  try {
    result = await runAgent({
      userId,
      history,
      prompt,
      needsConfirmation: (requested) => needsApproval(requested),
    });
  } catch (err) {
    const attempts = Array.isArray(err?.attempts) ? err.attempts : [];
    const noConfiguredProvider = attempts.length > 0 && attempts.every((attempt) => attempt.skipped);
    const providers = summariseAttempts(attempts);
    const code = noConfiguredProvider ? 'AI_NOT_CONFIGURED' : 'AI_ERROR';
    throw new EndpointError(redactSecrets(err?.message || 'پاسخی از هوش مصنوعی دریافت نشد.'), {
      code,
      status: noConfiguredProvider ? 503 : Number(err?.status) || 502,
      providers,
      attempts,
    });
  }

  for (const item of result.pending || []) {
    await createApproval({
      userId,
      action: item.action,
      reason: item.reason || '',
    });
  }

  const output = String(result.reply ?? '');
  await addMessage({ userId, chatRef: chat.id, role: 'assistant', content: output });

  const attempts = Array.isArray(result.attempts) ? result.attempts : [];
  const providers = summariseAttempts(attempts, result.provider || null);
  const pending = await pendingApprovals({ userId });

  return {
    output,
    actions: result.actions || [],
    pending,
    provider: result.provider || null,
    providerLabel: result.providerLabel || null,
    model: result.model || null,
    usage: result.usage || null,
    providers,
    fallback: Boolean(result.fallback),
    elapsedMs: Date.now() - startedAt,
    trace: attempts.map((attempt) => ({
      provider: attempt.provider,
      label: attempt.label,
      ok: Boolean(attempt.ok),
      skipped: Boolean(attempt.skipped),
      status: Number(attempt.status) || 0,
      kind: attempt.kind || '',
      ms: Number.isFinite(attempt.ms) ? attempt.ms : 0,
      message: redactSecrets(attempt.message || ''),
    })),
  };
}
