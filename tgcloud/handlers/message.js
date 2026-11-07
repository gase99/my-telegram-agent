// tgcloud/handlers/message.js — every text message in the bot's chats.
//
// /start, /app  → a button that opens the Mini App (+ the chat menu button)
// /status       → which integrations are wired up
// /clear        → wipe the conversation
// anything else → the same agent the Mini App uses, answered in plain text
//
// The platform calls the default export with the Message payload; the full
// Update is on `ctx.update`.

import { api, db } from 'sdk';
import { and, eq, isNull } from 'sdk/db';
import { messages } from '../schema.js';
import { runAgent } from '../lib/ai.js';
import { ensureChat, addMessage, recentMessages } from '../lib/store.js';
import { isUserAllowed, ACCESS_DENIED_MESSAGE, integrationStatus, redactSecrets } from '../lib/security.js';
import { needsApproval } from '../lib/approvals.js';
import { stripTelegramMarkdown, truncate } from '../lib/text.js';
import { settings } from '../lib/settings.js';

const WELCOME = `🤖 <b>TERMINAL-AI</b> — ایجنت کدنویس

می‌توانم کد بنویسم و واقعاً در GitHub، GitLab و Google Drive کار کنم:
• «یک فایل README برای مخزن من بساز»
• «آخرین کامیت‌های پروژه را نشان بده»
• «این تست را در گیت‌هاب آپلود کن و PR بزن»

برای تجربه کامل (ترمینال، تأیید عملیات، وضعیت اتصال) مینی‌اپ را باز کنید.
همین‌جا هم می‌توانید مستقیم پیام بدهید.`;

export default async function (msg, ctx) {
  const chatId = msg.chat?.id;
  const userId = msg.from?.id || chatId;
  const text = String(msg.text ?? '').trim();
  if (!chatId || !text) return;

  if (!isUserAllowed(userId)) {
    await sendSafe(chatId, ACCESS_DENIED_MESSAGE);
    return;
  }

  const chat = await ensureChat({ userId, chatId, title: text });
  // Rows written by the previous handler have chatId and no userId; adopt them
  // so the conversation is continuous for users who already have history.
  await adoptLegacyRows({ userId, chatId, chatRef: chat.id });

  // ── commands ──────────────────────────────────────────────────────────────
  if (text.startsWith('/')) {
    await handleCommand({ chatId, userId, text });
    return;
  }

  await addMessage({ userId, chatRef: chat.id, chatId, role: 'user', content: text });

  const history = await recentMessages({ userId, chatRef: chat.id, limit: settings.maxHistory });

  let typing = startTyping(chatId);
  let result;
  try {
    result = await runAgent({
      userId,
      history: history.map((row) => ({ role: row.role, content: row.content })),
      prompt: text,
      needsConfirmation: (action) => needsApproval(action, { requireConfirmation: settings.requireConfirmation }),
    });
  } catch (err) {
    await sendSafe(chatId, `❌ ${redactReasons(err)}`);
    return;
  } finally {
    await typing.stop();
  }

  let reply = result.reply || '✅ انجام شد.';

  // The model may have asked for destructive work: point at the Mini App.
  if (result.pending?.length) {
    const lines = result.pending.map((item) => `• ${item.label}`).join('\n');
    reply += `\n\n⚠️ این عملیات به تأیید شما نیاز دارد:\n${lines}\nبرای تأیید، مینی‌اپ را باز کنید.`;
  }

  await addMessage({ userId, chatRef: chat.id, chatId, role: 'assistant', content: reply });
  await sendSafe(chatId, reply);
}

// ── commands ────────────────────────────────────────────────────────────────

async function handleCommand({ chatId, userId, text }) {
  const [command, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();

  if (command === '/start' || command === '/app') {
    await sendWelcome(chatId);
    return;
  }
  if (command === '/help') {
    await sendSafe(chatId, WELCOME);
    return;
  }
  if (command === '/status') {
    const state = integrationStatus();
    const lines = [
      `${state.gemini ? '🟢' : '🔴'} Gemini — ${state.gemini ? 'متصل' : 'کلید تنظیم نشده'}`,
      `${state.github ? '🟢' : '🔴'} GitHub — ${state.github ? 'توکن موجود' : 'توکن تنظیم نشده'}`,
      `${state.gitlab ? '🟢' : '🔴'} GitLab — ${state.gitlab ? 'توکن موجود' : 'توکن تنظیم نشده'}`,
      `${state.gdrive ? '🟢' : '🔴'} Google Drive — ${state.gdrive ? 'سرویس‌اکانت موجود' : 'تنظیم نشده'}`,
    ];
    await sendSafe(chatId, `⚙️ وضعیت اتصال‌ها\n\n${lines.join('\n')}`);
    return;
  }
  if (command === '/clear') {
    await db.delete(messages).where(eq(messages.userId, userId)).run();
    await db.delete(messages).where(and(eq(messages.chatId, chatId), isNull(messages.userId))).run();
    await sendSafe(chatId, '🧹 تاریخچه گفتگو پاک شد.');
    return;
  }
  if (command === '/id') {
    await sendSafe(chatId, `🆔 شناسه تلگرام شما: <code>${userId}</code>`);
    return;
  }
  // Unknown command: answer with the command list, plus a hint about the text.
  await sendSafe(
    chatId,
    `دستور «${command}» شناخته نشد.\n\nدستورهای موجود:\n/start — شروع و باز کردن مینی‌اپ\n/status — وضعیت اتصال‌ها\n/clear — پاک کردن تاریخچه\n/id — نمایش شناسه تلگرام\n\nبرای گفتگو با ایجنت، پیام را بدون / بفرستید.${arg ? '' : ''}`
  );
}

async function sendWelcome(chatId) {
  const miniapp = settings.miniappUrl;
  const keyboard = miniapp
    ? {
        inline_keyboard: [
          [{ text: '🖥 باز کردن TERMINAL-AI', web_app: { url: miniapp } }],
          [
            { text: '⚙️ وضعیت', callback_data: 'status' },
            { text: '🧹 پاک کردن', callback_data: 'clear_ask' },
          ],
        ],
      }
    : {
        inline_keyboard: [
          [
            { text: '⚙️ وضعیت', callback_data: 'status' },
            { text: '🧹 پاک کردن', callback_data: 'clear_ask' },
          ],
        ],
      };

  await api.sendMessage({
    chat_id: chatId,
    text: miniapp
      ? WELCOME
      : `${WELCOME}\n\n⚠️ آدرس مینی‌اپ تنظیم نشده است. آدرس «Static» را از خروجی <code>npx tgcloud push</code> در MINIAPP_URL داخل <code>tgcloud/lib/config.js</code> بگذارید.`,
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });

  // The persistent menu button gives one-tap access to the Mini App.
  if (miniapp) {
    try {
      await api.setChatMenuButton({
        chat_id: chatId,
        menu_button: { type: 'web_app', text: 'TERMINAL-AI', web_app: { url: miniapp } },
      });
    } catch {
      // Bot API < 6.0 or a webhook that cannot set it: the inline button works.
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Rows from the previous handler carry chatId and no userId. */
async function adoptLegacyRows({ userId, chatId, chatRef }) {
  try {
    await db
      .update(messages)
      .set({ userId, chatRef })
      .where(and(eq(messages.chatId, chatId), isNull(messages.userId)))
      .run();
  } catch {
    // History adoption is best effort; a failure must not block the reply.
  }
}

/**
 * Show "typing…" for as long as the model works. The Bot API clears the
 * indicator after ~5s, so it is re-sent on an interval; with no timers in the
 * isolate it degrades to a single send.
 */
function startTyping(chatId) {
  let stopped = false;
  let timer = null;
  const send = () =>
    api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});

  send();
  if (typeof setInterval === 'function') {
    timer = setInterval(() => {
      if (!stopped) send();
    }, 4500);
  }
  return {
    async stop() {
      stopped = true;
      if (timer && typeof clearInterval === 'function') clearInterval(timer);
    },
  };
}

/**
 * Send text as HTML after escaping it: model output is untrusted, and a stray
 * `*`/`_` in legacy Markdown makes Telegram reject the whole message.
 */
async function sendSafe(chatId, text, { replyMarkup } = {}) {
  const escaped = escapeTags(stripTelegramMarkdown(text));
  const payload = {
    chat_id: chatId,
    text: truncate(escaped, 3800),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  try {
    await api.sendMessage(payload);
  } catch (err) {
    // Anything the Bot API rejects (bad entity, overflow) is retried as plain text.
    const plain = truncate(stripTelegramMarkdown(text), 3800);
    try {
      await api.sendMessage({ chat_id: chatId, text: plain, reply_markup: replyMarkup });
    } catch (second) {
      throw second;
    }
  }
}

function escapeTags(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function redactReasons(err) {
  const message = redactSecrets(err?.message || String(err));
  return message || 'خطای نامشخص رخ داد.';
}
