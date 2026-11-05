import { db } from 'sdk';
import { eq, desc } from 'sdk/db';
import { messages } from '../schema.js';

export default async function (input, ctx) {
  const user = ctx.initData.user;
  const chatId = user.id; // در چت خصوصی، آیدی کاربر همان آیدی چت است
  
  const history = await db.select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.id))
    .limit(20)
    .all();
    
  return history.reverse(); // برگرداندن به ترتیب قدیمی به جدید
}
