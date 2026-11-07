// tgcloud/lib/store.js — conversation persistence shared by the bot and the Mini App.
//
// Every row carries `chatId` (the legacy/Telegram column), `userId` and
// `chatRef` (the `chats` row). The Mini App reads by userId + chatRef; the
// Telegram handler keeps writing chatId, so the same conversation is visible
// from both places.

import { db } from 'sdk';
import { and, desc, eq, isNull, lt, or } from 'sdk/db';
import { chats, messages, agentActions } from '../schema.js';
import { truncate } from './text.js';
import { settings } from './settings.js';

/** The user's conversation row, created on first use. */
export async function ensureChat({ userId, chatId = null, title = null }) {
  if (!userId) throw new Error('ensureChat: userId لازم است');
  const existing = await db.select().from(chats).where(eq(chats.userId, userId)).get();

  if (existing) {
    const patch = {};
    if (chatId && existing.chatId !== chatId) patch.chatId = chatId;
    if (title && !existing.title) patch.title = truncate(title, 120);
    if (Object.keys(patch).length) {
      await db.update(chats).set({ ...patch, updatedAt: new Date() }).where(eq(chats.id, existing.id)).run();
      return { ...existing, ...patch };
    }
    return existing;
  }

  const rows = await db
    .insert(chats)
    .values({ userId, chatId: chatId ?? null, title: title ? truncate(title, 120) : null })
    .returning();
  return rows[0];
}

/** Append one message and bump the conversation timestamp. */
export async function addMessage({ userId, chatRef, chatId, role, content }) {
  const rows = await db
    .insert(messages)
    .values({
      chatId: chatId ?? userId,
      userId,
      chatRef: chatRef ?? null,
      role,
      content: String(content ?? ''),
    })
    .returning();
  if (chatRef) {
    await db.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, chatRef)).run();
  }
  return rows[0];
}

/**
 * Most recent messages, oldest first — the shape callers feed to the model.
 * Falls back to chatId-only rows (written before `userId` existed) so old
 * conversation history is not lost.
 */
export async function recentMessages({ userId, chatRef, limit = settings.maxHistory }) {
  const cap = Math.min(Math.max(Number(limit) || settings.maxHistory, 1), 100);
  const rows = await db
    .select()
    .from(messages)
    .where(byUser({ userId, chatRef }))
    .orderBy(desc(messages.id))
    .limit(cap)
    .all();
  return rows.reverse();
}

/** Paginated history for the terminal: `before` is an exclusive message id. */
export async function historyPage({ userId, chatRef, limit = 40, before = null }) {
  const cap = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const base = byUser({ userId, chatRef });
  const where = before ? and(base, lt(messages.id, Number(before))) : base;
  const rows = await db
    .select()
    .from(messages)
    .where(where)
    .orderBy(desc(messages.id))
    .limit(cap)
    .all();
  return rows.reverse().map(toClientMessage);
}

/** Wire shape for the Mini App: no internals, stable timestamps. */
export function toClientMessage(row) {
  return {
    id: row.id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    createdAt: row.created instanceof Date ? row.created.toISOString() : row.created || null,
  };
}

/**
 * Rows belonging to this conversation. The `userId` column is set on every new
 * row; `chatRef` narrows to the current conversation when known, and an
 * `OR chatId` branch keeps pre-agent rows (chatId only) readable.
 */
function byUser({ userId, chatRef }) {
  const legacy = and(eq(messages.chatId, userId), isNull(messages.userId));
  const own = chatRef ? and(eq(messages.userId, userId), eq(messages.chatRef, chatRef)) : eq(messages.userId, userId);
  return or(own, legacy);
}

/** Rows written by the pre-agent handler: chatId set, userId null. */
export async function legacyMessages({ chatId, limit = settings.maxHistory }) {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), isNull(messages.userId)))
    .orderBy(desc(messages.id))
    .limit(Math.min(Number(limit) || settings.maxHistory, 100))
    .all();
}

/** Adopt legacy rows into the current conversation (idempotent). */
export async function claimLegacyMessages({ userId, chatId, chatRef }) {
  await db
    .update(messages)
    .set({ userId, chatRef })
    .where(and(eq(messages.chatId, chatId), isNull(messages.userId)))
    .run();
}

/** Wipe a user's conversation. */
export async function clearHistory({ userId }) {
  await db.delete(messages).where(eq(messages.userId, userId)).run();
  await db.delete(messages).where(and(eq(messages.chatId, userId), isNull(messages.userId))).run();
  await db.update(chats).set({ updatedAt: new Date() }).where(eq(chats.userId, userId)).run();
}

/** Audit rows for the terminal's "what did the agent do" panel. */
export async function recentActions({ userId, limit = 20 }) {
  return db
    .select()
    .from(agentActions)
    .where(eq(agentActions.userId, userId))
    .orderBy(desc(agentActions.id))
    .limit(Math.min(Number(limit) || 20, 50))
    .all();
}

/** Counts for the Mini App header. */
export async function conversationStats({ userId }) {
  const total = await db.$count(messages, eq(messages.userId, userId));
  const chat = await db.select().from(chats).where(eq(chats.userId, userId)).get();
  return { total, chatId: chat?.id ?? null, title: chat?.title || null, updatedAt: chat?.updatedAt || null };
}

