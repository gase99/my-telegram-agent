// tgcloud/endpoints/getHistory.js — history for the Mini App terminal.
//
// Request:  { limit?: number, before?: number }
// Response: { messages: [{id, role, content, createdAt}], hasMore, chatId }
//
// Newest page first on the wire is avoided deliberately: the terminal appends
// the array as-is, so the array is always oldest → newest.

import { EndpointError } from 'sdk';
import { historyPage, ensureChat, conversationStats } from '../lib/store.js';
import { isUserAllowed, ACCESS_DENIED_MESSAGE } from '../lib/security.js';

export default async function getHistory(input, ctx) {
  const userId = ctx?.initData?.user?.id;
  if (!userId) throw new EndpointError('این مینی‌اپ باید از داخل تلگرام باز شود.', { code: 'NO_USER', status: 401 });
  if (!isUserAllowed(userId)) throw new EndpointError(ACCESS_DENIED_MESSAGE, { code: 'FORBIDDEN', status: 403 });

  const limit = Math.min(Math.max(Number(input?.limit) || 40, 1), 100);
  const before = Number(input?.before) > 0 ? Number(input.before) : null;

  const chat = await ensureChat({ userId });
  const messages = await historyPage({ userId, chatRef: chat.id, limit, before });
  const stats = await conversationStats({ userId });

  return {
    chatId: chat.id,
    messages,
    hasMore: messages.length === limit,
    total: stats.total,
    // The terminal shows this as the prompt host, e.g. "user@terminal:~$".
    user: {
      id: userId,
      name: [ctx.initData.user.first_name, ctx.initData.user.last_name].filter(Boolean).join(' ') || null,
      username: ctx.initData.user.username || null,
    },
  };
}
