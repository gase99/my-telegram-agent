// tgcloud/endpoints/getStatus.js — connection badges for the Mini App top bar.
//
// Response: { model, services: { github, gitlab, gdrive }, pending, usage }
//
// `model.providers` lists every AI provider in failover order with its model
// id and whether a key is configured — the Mini App paints those badges from
// it, and the per-request status (`active` / `failed`) comes back from the
// `agent` endpoint.
//
// Each integration reports `{ connected, ... }` and, when it is not connected,
// a Persian `reason`. Probing is parallel and never throws: a broken token must
// render a red badge, not break the terminal.

import { EndpointError } from 'sdk';
import * as github from '../lib/github.js';
import * as gitlab from '../lib/gitlab.js';
import * as gdrive from '../lib/gdrive.js';
import { integrationStatus, isUserAllowed, ACCESS_DENIED_MESSAGE, redactSecrets } from '../lib/security.js';
import { providerCatalog } from '../lib/ai.js';
import { pendingApprovals } from '../lib/approvals.js';
import { settings } from '../lib/settings.js';

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
  const [githubStatus, gitlabStatus, driveStatus, pending] = await Promise.all([
    configured.github ? probe(() => github.status()) : Promise.resolve({ connected: false, reason: 'توکن GitHub تنظیم نشده است.' }),
    configured.gitlab ? probe(() => gitlab.status()) : Promise.resolve({ connected: false, reason: 'توکن GitLab تنظیم نشده است.' }),
    configured.gdrive ? probe(() => gdrive.status()) : Promise.resolve({ connected: false, reason: 'سرویس‌اکانت گوگل تنظیم نشده است.' }),
    probe(() => pendingApprovals({ userId })),
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
    checkedAt: new Date().toISOString(),
  };
}
