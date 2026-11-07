// tgcloud/schema.js — database tables for the AI Coding Agent.
//
// A table is a named export; the platform discovers them and applies the
// changes on `npx tgcloud migrate`. No foreign keys are supported by the
// runtime: every `*_id` column is a logical link enforced by app code.

import { table, integer, text, json, index, sql } from 'sdk/db';

// One conversation per Telegram user. `chatId` is the private chat the bot
// talks in (equal to `userId` in a private chat, different in a group).
export const chats = table('chats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().unique(),
  chatId: integer('chat_id'),
  title: text('title'),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

// Conversation history. `chatId` existed before the agent rewrite and stays
// populated (the Telegram handler keeps writing it); `userId` + `chatRef` are
// the canonical keys the Mini App reads.
export const messages = table(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    chatId: integer('chat_id').notNull(),
    userId: integer('user_id'),
    chatRef: integer('chat_ref'),
    role: text('role').notNull(), // 'user' | 'assistant' | 'system'
    content: text('content').notNull(),
    created: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  },
  (t) => ({
    chatIdx: index('idx_messages_chat').on(t.chatId),
    userIdx: index('idx_messages_user').on(t.userId),
  })
);

// Audit log of every repository / Drive operation the agent performed, so the
// terminal can show what actually happened and nothing runs unrecorded.
export const agentActions = table(
  'agent_actions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(),
    messageId: integer('message_id'),
    service: text('service').notNull(), // 'github' | 'gitlab' | 'gdrive'
    action: text('action').notNull(),
    target: text('target'),
    status: text('status').notNull(), // 'ok' | 'error' | 'pending'
    summary: text('summary'),
    createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  },
  (t) => ({
    userActionIdx: index('idx_actions_user').on(t.userId),
    messageIdx: index('idx_actions_message').on(t.messageId),
  })
);

// Operations waiting for the user's explicit approval (see REQUIRE_CONFIRMATION
// in lib/config.js). A row is single-use: it is deleted as soon as the user
// approves or rejects it, so a token cannot be replayed.
export const approvals = table(
  'approvals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    token: text('token').notNull().unique(),
    userId: integer('user_id').notNull(),
    payload: json('payload').notNull(),
    status: text('status').notNull().default('pending'), // pending | approved | rejected | expired
    createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  },
  (t) => ({
    userIdx: index('idx_approvals_user').on(t.userId),
  })
);
