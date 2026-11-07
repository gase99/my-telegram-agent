// tgcloud/handlers/callback_query.js — inline buttons sent by handlers/message.js
//
//   status      → show which integrations are configured
//   clear_ask   → ask before deleting the conversation
//   clear_yes   → delete it
//
// Every callback is answered (Telegram spins the button until then), and the
// user is re-checked here: callback data is client-supplied, the `from` id is
// not.

import { api, db } from 'sdk';
import { and, eq, isNull } from 'sdk/db';
import { messages } from '../schema.js';
import { isUserAllowed, ACCESS_DENIED_MESSAGE, integrationStatus } from '../lib/security.js';

export default async function (query) {
  const data = String(query?.data || '');
  const userId = query?.from?.id;
  const chatId = query?.message?.chat?.id;
  const messageId = query?.message?.message_id;

  try {
    if (!userId || !isUserAllowed(userId)) {
      await api.answerCallbackQuery({ callback_query_id: query.id, text: ACCESS_DENIED_MESSAGE, show_alert: true });
      return;
    }

    if (data === 'status') {
      const state = integrationStatus();
      const text = [
        `${state.gemini ? '🟢' : '🔴'} Gemini`,
        `${state.github ? '🟢' : '🔴'} GitHub`,
        `${state.gitlab ? '🟢' : '🔴'} GitLab`,
        `${state.gdrive ? '🟢' : '🔴'} Google Drive`,
      ].join(' · ');
      await api.answerCallbackQuery({ callback_query_id: query.id, text, show_alert: true });
      return;
    }

    if (data === 'clear_ask') {
      await api.answerCallbackQuery({ callback_query_id: query.id });
      await api.editMessageReplyMarkup({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ بله، پاک کن', callback_data: 'clear_yes' },
              { text: '↩️ انصراف', callback_data: 'clear_no' },
            ],
          ],
        },
      }).catch(() => {});
      return;
    }

    if (data === 'clear_no') {
      await api.answerCallbackQuery({ callback_query_id: query.id, text: 'لغو شد.' });
      await api.editMessageReplyMarkup({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }

    if (data === 'clear_yes') {
      await db.delete(messages).where(eq(messages.userId, userId)).run();
      await db.delete(messages).where(and(eq(messages.chatId, chatId), isNull(messages.userId))).run();
      await api.answerCallbackQuery({ callback_query_id: query.id, text: '🧹 تاریخچه پاک شد.' });
      await api.editMessageReplyMarkup({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }

    await api.answerCallbackQuery({ callback_query_id: query.id, text: 'این دکمه دیگر فعال نیست.' });
  } catch (err) {
    // Never leave the button spinning.
    await api.answerCallbackQuery({ callback_query_id: query.id, text: 'خطا در پردازش درخواست.' }).catch(() => {});
    throw err;
  }
}
