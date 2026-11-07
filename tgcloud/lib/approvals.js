// tgcloud/lib/approvals.js — human confirmation for destructive actions.
//
// A model can ask for `delete_file`; the user has to say yes. The pending
// operation is stored, the Mini App shows a confirm card with a token, and only
// `approve()` executes it. The row is deleted inside the approve call, so a
// token can be used once even if the request is replayed.

import { db } from 'sdk';
import { and, eq, lt } from 'sdk/db';
import { approvals } from '../schema.js';
import { runAction, isKnownAction, describeAction } from './actions.js';
import { sha256Hex } from './jwt.js';

/** How long a stored approval stays actionable (see expireOld). */
export const APPROVAL_TTL_HOURS = 24;

/** Actions that always need a confirmation, whatever the config says. */
const ALWAYS_CONFIRM = new Set(['delete_file', 'trash_file', 'share_file', 'trigger_workflow', 'trigger_pipeline']);

/** Should this action wait for the user? */
export function needsApproval(action, { requireConfirmation = true } = {}) {
  if (!requireConfirmation) return ALWAYS_CONFIRM.has(action?.action);
  if (action?.service === 'github' || action?.service === 'gitlab') {
    return ALWAYS_CONFIRM.has(action.action) || action.action === 'update_file';
  }
  return ALWAYS_CONFIRM.has(action?.action);
}

function newToken(payload) {
  // Deterministic input + a random salt, hashed: unique per call, unguessable
  // enough for a single-use confirmation token.
  const salt = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
  return `apr_${sha256Hex(`${salt}:${JSON.stringify(payload)}:${Date.now()}`).slice(0, 40)}`;
}

/**
 * Store a pending action and return what the Mini App needs to render the card.
 * The token is the only handle the client gets; the payload stays server-side.
 */
export async function createApproval({ userId, action, reason = '' }) {
  if (!isKnownAction(action?.service, action?.action)) {
    throw new Error(`عملیات ناشناخته: ${action?.service}.${action?.action}`);
  }
  const payload = { action, reason, label: describeAction(action) };
  const token = newToken(payload);
  await db.insert(approvals).values({ token, userId, payload, status: 'pending' }).run();
  const target = action.params?.path || action.params?.branch || action.params?.name || action.params?.fileId || '';
  return {
    token,
    label: payload.label,
    service: action.service,
    action: action.action,
    reason,
    params: action.params || {},
    target,
    createdAt: new Date().toISOString(),
    // The card counts down against the same window expireOld() prunes.
    expiresAt: toIso(new Date(), APPROVAL_TTL_HOURS),
  };
}

/** Pending approvals of a user, newest first (for the Mini App on reload). */
export async function pendingApprovals({ userId }) {
  const rows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.userId, userId), eq(approvals.status, 'pending')))
    .all();
  return rows.map((row) => {
    const params = row.payload?.action?.params || {};
    const createdAt = row.createdAt ?? row.created;
    return {
      token: row.token,
      label: row.payload?.label || describeAction(row.payload?.action || {}),
      reason: row.payload?.reason || '',
      service: row.payload?.action?.service || '',
      action: row.payload?.action?.action || '',
      params,
      // Same precedence as createApproval(), so a reloaded card looks identical.
      target: params.path || params.branch || params.name || params.fileId || '',
      createdAt: createdAt instanceof Date ? createdAt.toISOString() : createdAt || null,
      // Lets the Mini App count down instead of guessing a lifetime.
      expiresAt: toIso(createdAt, APPROVAL_TTL_HOURS),
    };
  });
}

function toIso(value, addHours = 0) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() + addHours * 3600 * 1000).toISOString();
}

/**
 * Execute a pending action. Returns `{ ok, data }` or throws when the token is
 * unknown, already used, or belongs to another user.
 */
export async function approve({ token, userId }) {
  const row = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.token, String(token || '')), eq(approvals.userId, userId)))
    .get();
  if (!row) throw new Error('این درخواست پیدا نشد یا منقضی شده است.');
  if (row.status !== 'pending') throw new Error('این درخواست قبلاً استفاده شده است.');

  // Claim it first: a concurrent second call loses the race and gets null.
  const claimed = await db
    .update(approvals)
    .set({ status: 'approved' })
    .where(and(eq(approvals.id, row.id), eq(approvals.status, 'pending')))
    .returning({ id: approvals.id });
  if (!claimed.length) throw new Error('این درخواست قبلاً استفاده شده است.');

  const action = row.payload?.action;
  const outcome = await runAction(action, { userId, allowWrites: true });
  await db.delete(approvals).where(eq(approvals.id, row.id)).run();
  return { outcome, action };
}

/** Drop a pending action without running it. */
export async function reject({ token, userId }) {
  const row = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.token, String(token || '')), eq(approvals.userId, userId)))
    .get();
  if (!row) return { ok: true, alreadyGone: true };
  await db.delete(approvals).where(eq(approvals.id, row.id)).run();
  return { ok: true, rejected: true };
}

/** Housekeeping: forget pendings older than `hours` (best effort). */
export async function expireOld({ hours = 24 } = {}) {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000);
  await db.delete(approvals).where(and(eq(approvals.status, 'pending'), ltCreated(cutoff))).run();
}

function ltCreated(date) {
  return lt(approvals.createdAt, date);
}
