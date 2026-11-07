// tgcloud/lib/actions.js — whitelist + executor for model-requested actions.
//
// This is the trust boundary: the model only chooses a name from ALLOWED and
// supplies plain parameters, which are validated here and then passed to the
// typed functions in github.js / gitlab.js / gdrive.js. There is no generic
// "call this URL" action and no way for a parameter to change the host.

import * as github from './github.js';
import * as gitlab from './gitlab.js';
import * as gdrive from './gdrive.js';
import { HttpError } from './http.js';
import { redactSecrets } from './security.js';
import { normalizeRepoPath } from './text.js';
import { settings } from './settings.js';

export const MAX_ACTIONS = settings.maxActionsPerTurn;

/** Actions that change state — blocked when a caller passes allowWrites:false. */
const WRITE_ACTIONS = new Set([
  'create_file',
  'update_file',
  'delete_file',
  'create_branch',
  'create_pr',
  'create_issue',
  'create_mr',
  'trigger_workflow',
  'trigger_pipeline',
  'upload_file',
  'create_folder',
  'trash_file',
  'share_file',
]);

const CATALOG = {
  github: {
    get_repo: { write: false, handler: (p) => github.getRepo(p.repo) },
    list_files: { write: false, handler: (p) => github.listFiles({ repo: p.repo, path: p.path, ref: p.ref, limit: num(p.limit, 120) }) },
    read_file: { write: false, handler: (p) => github.readFile({ repo: p.repo, path: req(p.path, 'path'), ref: p.ref }) },
    list_commits: { write: false, handler: (p) => github.listCommits({ repo: p.repo, ref: p.ref, limit: num(p.limit, 10) }) },
    list_issues: { write: false, handler: (p) => github.listIssues({ repo: p.repo, state: p.state, limit: num(p.limit, 10) }) },
    list_runs: { write: false, handler: (p) => github.listWorkflowRuns({ repo: p.repo, limit: num(p.limit, 5), workflow: p.workflow }) },
    create_file: {
      write: true,
      handler: (p) => github.writeFile({ repo: p.repo, path: req(p.path, 'path'), content: str(p.content), message: p.message, branch: p.branch }),
    },
    update_file: {
      write: true,
      handler: (p) => github.writeFile({ repo: p.repo, path: req(p.path, 'path'), content: str(p.content), message: p.message, branch: p.branch }),
    },
    delete_file: {
      write: true,
      handler: (p) => github.deleteFile({ repo: p.repo, path: req(p.path, 'path'), message: p.message, branch: p.branch }),
    },
    create_branch: { write: true, handler: (p) => github.createBranch({ repo: p.repo, branch: req(p.branch, 'branch'), from: p.from }) },
    create_pr: {
      write: true,
      handler: (p) => github.createPullRequest({ repo: p.repo, title: req(p.title, 'title'), head: req(p.head, 'head'), base: p.base, body: p.body }),
    },
    create_issue: {
      write: true,
      handler: (p) => github.createIssue({ repo: p.repo, title: req(p.title, 'title'), body: p.body, labels: p.labels }),
    },
    trigger_workflow: {
      write: true,
      handler: (p) => github.triggerWorkflow({ repo: p.repo, workflow: req(p.workflow, 'workflow'), ref: p.ref, inputs: p.inputs }),
    },
  },
  gitlab: {
    get_project: { write: false, handler: (p) => gitlab.getProject(p.project) },
    list_files: { write: false, handler: (p) => gitlab.listFiles({ project: p.project, path: p.path, ref: p.ref, limit: num(p.limit, 100) }) },
    read_file: { write: false, handler: (p) => gitlab.readFile({ project: p.project, path: req(p.path, 'path'), ref: p.ref }) },
    list_commits: { write: false, handler: (p) => gitlab.listCommits({ project: p.project, ref: p.ref, limit: num(p.limit, 10) }) },
    create_file: {
      write: true,
      handler: (p) => gitlab.writeFile({ project: p.project, path: req(p.path, 'path'), content: str(p.content), message: p.message, branch: p.branch }),
    },
    update_file: {
      write: true,
      handler: (p) => gitlab.writeFile({ project: p.project, path: req(p.path, 'path'), content: str(p.content), message: p.message, branch: p.branch }),
    },
    delete_file: {
      write: true,
      handler: (p) => gitlab.deleteFile({ project: p.project, path: req(p.path, 'path'), message: p.message, branch: p.branch }),
    },
    create_branch: { write: true, handler: (p) => gitlab.createBranch({ project: p.project, branch: req(p.branch, 'branch'), ref: p.ref }) },
    create_mr: {
      write: true,
      handler: (p) =>
        gitlab.createMergeRequest({
          project: p.project,
          title: req(p.title, 'title'),
          sourceBranch: req(p.source_branch || p.head, 'source_branch'),
          targetBranch: p.target_branch || p.base,
          description: p.description || p.body,
        }),
    },
    trigger_pipeline: { write: true, handler: (p) => gitlab.triggerPipeline({ project: p.project, ref: p.ref }) },
  },
  gdrive: {
    list_files: { write: false, handler: (p) => gdrive.listFiles({ folderId: p.folderId, limit: num(p.limit, 30), nameContains: p.nameContains }) },
    search_files: { write: false, handler: (p) => gdrive.searchFiles({ query: req(p.query, 'query'), limit: num(p.limit, 20) }) },
    read_file: { write: false, handler: (p) => gdrive.readFile({ fileId: req(p.fileId, 'fileId') }) },
    upload_file: {
      write: true,
      handler: (p) =>
        gdrive.uploadTextFile({ name: req(p.name, 'name'), content: str(p.content), folderId: p.folderId, mimeType: p.mimeType }),
    },
    update_file: { write: true, handler: (p) => gdrive.updateTextFile({ fileId: req(p.fileId, 'fileId'), content: str(p.content) }) },
    create_folder: { write: true, handler: (p) => gdrive.createFolder({ name: req(p.name, 'name'), parentId: p.parentId }) },
    trash_file: { write: true, handler: (p) => gdrive.trashFile({ fileId: req(p.fileId, 'fileId') }) },
    share_file: {
      write: true,
      handler: (p) => gdrive.shareFile({ fileId: req(p.fileId, 'fileId'), email: req(p.email, 'email'), role: p.role || 'reader' }),
    },
  },
};

function req(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new HttpError(`پارامتر «${name}» لازم است.`, { status: 422, service: 'Agent' });
  return text;
}

function str(value) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : String(value);
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** True when the model may request this action. */
export function isKnownAction(service, action) {
  return Boolean(CATALOG[service] && CATALOG[service][action]);
}

/** Every action name, for the system prompt / tests. */
export function listActions() {
  const out = {};
  for (const [service, actions] of Object.entries(CATALOG)) {
    out[service] = Object.entries(actions).map(([name, def]) => ({
      name,
      write: def.write || WRITE_ACTIONS.has(name),
    }));
  }
  return out;
}

/** Persian label shown in the terminal while an action runs. */
export function describeAction(action) {
  const p = action?.params || {};
  const where = normalizeRepoPath(p.repo || p.project || '');
  const target = p.path || p.name || p.fileId || p.branch || p.workflow || p.query || '';
  const parts = [where, target].filter(Boolean);
  const icons = { github: '🐙', gitlab: '🦊', gdrive: '📁' };
  return `${icons[action.service] || '⚙️'} ${action.action}${parts.length ? ` — ${parts.join(' › ')}` : ''}`;
}

/**
 * Execute one action.
 * @returns {{ok:boolean, data?:any, error?:string, target?:string}}
 */
export async function runAction(action, { userId, allowWrites = true } = {}) {
  const service = String(action?.service || '').toLowerCase();
  const name = String(action?.action || '');
  const definition = CATALOG[service]?.[name];
  if (!definition) {
    return { ok: false, error: `عملیات ناشناخته: ${service}.${name}` };
  }
  if (!allowWrites && definition.write) {
    return { ok: false, error: `عملیات «${name}» نیازمند تأیید است و در این مرحله اجرا نشد.` };
  }
  try {
    const data = await definition.handler(action.params || {});
    return { ok: true, data: summarise(data), target: describeAction(action) };
  } catch (err) {
    return {
      ok: false,
      error: redactSecrets(err?.message || String(err)),
      status: err?.status || 0,
      target: describeAction(action),
    };
  }
}

/**
 * Keep tool output small enough to feed back to the model: file bodies are
 * truncated, listings are capped. The terminal still gets the full summary
 * through `describeAction` and the stored audit row.
 */
function summarise(data, { maxText = 6000 } = {}) {
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object') return data;
  const out = Array.isArray(data) ? data.slice(0, 50) : { ...data };
  if (typeof out.content === 'string' && out.content.length > maxText) {
    out.content = `${out.content.slice(0, maxText)}\n… (${out.content.length - maxText} chars cut)`;
    out.truncated = true;
  }
  if (Array.isArray(out.entries) && out.entries.length > 100) out.entries = out.entries.slice(0, 100);
  return out;
}

