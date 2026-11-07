// tgcloud/endpoints/approve.js — run (or drop) a pending destructive action.
//
// Request:  { token: string, decision?: 'approve' | 'reject' }
// Response: { ok, output, action? }
//
// The approval row is single-use and bound to the verified caller's user id, so
// a token cannot be replayed or used by somebody else.

import { EndpointError } from 'sdk';
import { approve, reject, pendingApprovals } from '../lib/approvals.js';
import { addMessage, ensureChat } from '../lib/store.js';
import { isUserAllowed, ACCESS_DENIED_MESSAGE, redactSecrets } from '../lib/security.js';
import { describeAction } from '../lib/actions.js';

export default async function approveEndpoint(input, ctx) {
  const userId = ctx?.initData?.user?.id;
  if (!userId) throw new EndpointError('این مینی‌اپ باید از داخل تلگرام باز شود.', { code: 'NO_USER', status: 401 });
  if (!isUserAllowed(userId)) throw new EndpointError(ACCESS_DENIED_MESSAGE, { code: 'FORBIDDEN', status: 403 });

  const token = String(input?.token ?? '').trim();
  if (!token) throw new EndpointError('توکن درخواست مشخص نیست.', { code: 'NO_TOKEN' });

  const decision = String(input?.decision || 'approve').toLowerCase();
  const chat = await ensureChat({ userId });

  if (decision === 'reject') {
    await reject({ token, userId });
    return { ok: true, output: '⛔️ درخواست لغو شد و هیچ تغییری اعمال نشد.' };
  }

  let result;
  try {
    result = await approve({ token, userId });
  } catch (err) {
    throw new EndpointError(redactSecrets(err?.message || 'اجرای درخواست ناموفق بود.'), {
      code: 'APPROVAL_FAILED',
    });
  }

  const label = describeAction(result.action);
  const output = result.outcome?.ok
    ? `✅ انجام شد: ${label}\n${summarise(result.outcome.data)}`
    : `❌ اجرا ناموفق بود: ${label}\n${result.outcome?.error || 'خطای نامشخص'}`;

  if (result.outcome?.data?.url) {
    // Keep the link in history so the terminal can show it again later.
    await addMessage({ userId, chatRef: chat.id, role: 'assistant', content: output });
  } else {
    await addMessage({ userId, chatRef: chat.id, role: 'assistant', content: output });
  }

  return {
    ok: Boolean(result.outcome?.ok),
    output,
    action: {
      label,
      service: result.action?.service,
      action: result.action?.action,
      url: result.outcome?.data?.url || null,
    },
    remaining: await pendingApprovals({ userId }),
  };
}

/** One short human line from a tool result — links first, then the essentials. */
function summarise(data) {
  if (!data || typeof data !== 'object') return '';
  const bits = [];
  if (data.url) bits.push(`🔗 ${data.url}`);
  if (data.commit) bits.push(`commit: ${String(data.commit).slice(0, 7)}`);
  if (data.path) bits.push(`مسیر: ${data.path}`);
  if (data.name) bits.push(`نام: ${data.name}`);
  if (data.id && !data.url) bits.push(`شناسه: ${data.id}`);
  if (data.deleted) bits.push('حذف شد');
  if (data.trashed) bits.push('به سبد بازیافت منتقل شد');
  return bits.join(' • ');
}
