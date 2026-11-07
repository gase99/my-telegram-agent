// tgcloud/endpoints/getStatus.js — connection badges for the Mini App top bar.
//
// Response: { model, services: { github, gitlab, gdrive }, pending, activity,
//             capabilities, limits, checkedAt }
//
// `model.providers` lists every AI provider in failover order with its model
// id and whether a key is configured — the Mini App paints those badges from
// it, and the per-request status (`active` / `failed`) comes back from the
// `agent` endpoint.
//
// Each integration reports `{ connected, ... }` and, when it is not connected,
// a Persian `reason`. Probing is parallel and never throws: a broken token must
// render a red badge, not break the terminal.
//
// `activity` is the audit log (`agent_actions`) rolled up into the numbers the
// Mini App's dashboard shows; `capabilities` is what the agent may actually do
// on this deployment, so the UI never advertises an operation whose token is
// missing.

import { EndpointError } from 'sdk';
import * as github from '../lib/github.js';
import * as gitlab from '../lib/gitlab.js';
import * as gdrive from '../lib/gdrive.js';
import {
  integrationStatus,
  isUserAllowed,
  ACCESS_DENIED_MESSAGE,
  MAX_PROMPT_LENGTH,
  redactSecrets,
} from '../lib/security.js';
import { providerCatalog } from '../lib/ai.js';
import { pendingApprovals } from '../lib/approvals.js';
import { recentActions } from '../lib/store.js';
import { listActions } from '../lib/actions.js';
import { settings } from '../lib/settings.js';

const DAY_MS = 24 * 3600 * 1000;

/**
 * Turn audit rows into the counters/streak the dashboard renders.
 * Failures are counted separately so a green "ok" count can never hide a red
 * error count.
 */
function summariseActivity(rows) {
  const now = Date.now();
  const last24h = rows.filter((row) => {
    const created = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
    return Number.isFinite(created.getTime()) && now - created.getTime() < DAY_MS;
  });
  const time = (row) => {
    const created = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
    return Number.isFinite(created.getTime()) ? created.getTime() : 0;
  };
  const services = {};
  for (const row of rows) {
    const key = row.service || 'unknown';
    services[key] = (services[key] || 0) + 1;
  }
  const latest = [...rows].sort((a, b) => time(b) - time(a)).slice(0, 8).map((row) => ({
    service: row.service || '',
    action: row.action || '',
    target: row.target || '',
    ok: row.status === 'ok',
    at: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt || null,
  }));
  return {
    total: rows.length,
    last24h: last24h.length,
    ok: rows.filter((row) => row.status === 'ok').length,
    failed: rows.filter((row) => row.status === 'error').length,
    services,
    latest,
  };
}

/** What the agent can do right now, given the configured integrations. */
function capabilityMap(configured) {
  const catalog = listActions();
  return {
    github: Boolean(configured.github),
    gitlab: Boolean(configured.gitlab),
    gdrive: Boolean(configured.gdrive),
    actions: catalog,
    count: Object.values(catalog).reduce((sum, items) => sum + items.length, 0),
    writeCount: Object.values(catalog).reduce(
      (sum, items) => sum + items.filter((item) => item.write).length,
      0
    ),
  };
}

async function probe(fn) {
  try {
    return await fn();
  } catch (err) {
    return { connected: false, reason: redactSecrets(err?.message || String(err)) };
  }
}

export default async function getStatus(_input, ctx) {
  const userId = ctx?.initData?.user?.id;
  if (!userId) throw new EndpointError('این مینی‌اپ باید از داخل تلگرام باز شود.', { code: 'NO_USER', status: 401 });
  if (!isUserAllowed(userId)) throw new EndpointError(ACCESS_DENIED_MESSAGE, { code: 'FORBIDDEN', status: 403 });

  const configured = integrationStatus();
  const [githubStatus, gitlabStatus, driveStatus, pending, activityRows] = await Promise.all([
    configured.github ? probe(() => github.status()) : Promise.resolve({ connected: false, reason: 'توکن GitHub تنظیم نشده است.' }),
    configured.gitlab ? probe(() => gitlab.status()) : Promise.resolve({ connected: false, reason: 'توکن GitLab تنظیم نشده است.' }),
    configured.gdrive ? probe(() => gdrive.status()) : Promise.resolve({ connected: false, reason: 'سرویس‌اکانت گوگل تنظیم نشده است.' }),
    probe(() => pendingApprovals({ userId })),
    probe(() => recentActions({ userId, limit: 50 })),
  ]);

  const providers = providerCatalog();
  // Retired model ids still look "configured" but answer 404 on the first call.
  const retired = providers.filter((provider) => provider.retiredModel);

  return {
    model: {
      // The first provider in the failover order is the default answerer.
      name: providers.find((provider) => provider.configured)?.model || settings.geminiModel,
      configured: providers.some((provider) => provider.configured),
      order: providers.map((provider) => provider.name),
      timeoutMs: settings.aiTimeoutMs,
      thinkingLevel: settings.aiThinkingLevel,
      providers,
      // [{ name, model, suggestedModel }] — the UI shows a warning for these.
      retiredModels: retired.map((provider) => ({
        name: provider.name,
        model: provider.model,
        suggestedModel: provider.suggestedModel,
      })),
    },
    services: { github: githubStatus, gitlab: gitlabStatus, gdrive: driveStatus },
    pending: Array.isArray(pending) ? pending : [],
    activity: summariseActivity(Array.isArray(activityRows) ? activityRows : []),
    capabilities: capabilityMap(configured),
    limits: {
      maxPromptLength: MAX_PROMPT_LENGTH,
      maxActionsPerTurn: settings.maxActionsPerTurn,
      maxAgentSteps: settings.maxAgentSteps,
      maxHistory: settings.maxHistory,
      requireConfirmation: settings.requireConfirmation,
    },
    checkedAt: new Date().toISOString(),
  };
}
