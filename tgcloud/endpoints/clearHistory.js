// tgcloud/endpoints/clearHistory.js — the terminal's `clear` command.
//
// Request:  { confirm: true }
// Response: { ok, cleared }
//
// A destructive call, so it needs an explicit `confirm` from the UI (the
// terminal sends it only after its own two-step prompt).

import { EndpointError } from 'sdk';
import { clearHistory, ensureChat } from '../lib/store.js';
import { isUserAllowed, ACCESS_DENIED_MESSAGE } from '../lib/security.js';

export default async function clearHistoryEndpoint(input, ctx) {
  const userId = ctx?.initData?.user?.id;
  if (!userId) throw new EndpointError('این مینی‌اپ باید از داخل تلگرام باز شود.', { code: 'NO_USER', status: 401 });
  if (!isUserAllowed(userId)) throw new EndpointError(ACCESS_DENIED_MESSAGE, { code: 'FORBIDDEN', status: 403 });
  if (input?.confirm !== true) {
    throw new EndpointError('برای پاک کردن تاریخچه باید تأیید کنید.', { code: 'CONFIRM_REQUIRED' });
  }

  await clearHistory({ userId });
  const chat = await ensureChat({ userId });
  return { ok: true, cleared: true, chatId: chat.id };
}
