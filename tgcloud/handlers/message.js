import { api, db } from 'sdk';
import { eq, desc } from 'sdk/db';
import { messages } from '../schema.js';
import { chat } from '../lib/beatapi.js';

export default async function (msg) {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  await db.insert(messages).values({ chatId: chatId, role: 'user', content: text }).run();

  const history = await db.select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.id))
    .limit(20)
    .all();

  const ctx = history.reverse().map(function(m) { return { role: m.role, content: m.content }; });

  let reply;
  try {
    reply = await chat(ctx);
  } catch (e) {
    await api.sendMessage({ chat_id: chatId, text: '❌ یک خطا رخ داد: ' + e.message });
    return;
  }

  await db.insert(messages).values({ chatId: chatId, role: 'assistant', content: reply }).run();
  
  await api.sendMessage({ 
    chat_id: chatId, 
    text: reply,
    parse_mode: 'Markdown' 
  });
}
