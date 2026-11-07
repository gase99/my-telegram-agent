// tgcloud/endpoints/getStatus.js — connection badges for the Mini App top bar.
//
// Response: { model, services: { github, gitlab, gdrive }, pending, usage }
//
// Each integration reports `{ connected, ... }` and, when it is not connected,
// a Persian `reason`. Probing is parallel and never throws: a broken token must
// render a red badge, not break the terminal.

import { EndpointError } from 'sdk';
import * as github from '../lib/github.js';
import * as gitlab from '../lib/gitlab.js';
import * as gdrive from '../lib/gdrive.js';
import { integrationStatus, isUserAllowed, ACCESS_DENIED_MESSAGE, redactSecrets } from '../lib/security.js';
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

  return {
    model: { name: settings.geminiModel, configured: configured.gemini },
    services: { github: githubStatus, gitlab: gitlabStatus, gdrive: driveStatus },
    pending: Array.isArray(pending) ? pending : [],
    checkedAt: new Date().toISOString(),
  };
}
