// tgcloud/lib/github.js — GitHub REST v3 client, built on the platform fetch.
//
// Only the operations the coding agent needs. Every function takes plain
// arguments and throws `HttpError` (already translated to a Persian message)
// on failure, so callers never parse status codes themselves.

import { request, HttpError } from './http.js';
import { base64ToUtf8, utf8ToBase64, bytesToBase64 } from './encoding.js';
import { settings } from './settings.js';

const API = 'https://api.github.com';
const ACCEPT = 'application/vnd.github+json';
const API_VERSION = '2022-11-28';

/** GitHub's base64 is UTF-8 inside, and arrives with newlines every 60 chars. */
const MAX_INLINE_FILE_BYTES = 900 * 1024; // contents API caps at 1 MB
const MAX_TREE_ENTRIES = 400;

function token() {
  return settings.githubToken;
}

function authHeaders() {
  if (!token()) {
    throw new HttpError('🐙 GitHub پیکربندی نشده است: GITHUB_TOKEN در tgcloud/lib/config.js خالی است.', {
      service: 'GitHub',
      status: 0,
    });
  }
  return {
    Authorization: `Bearer ${token()}`,
    Accept: ACCEPT,
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'tgcloud-ai-coding-agent',
  };
}

function gh(path, options = {}) {
  return request(`${API}${path}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
    service: 'GitHub',
  });
}

/** `owner/repo`, falling back to the configured default. */
export function resolveRepo(repo) {
  const value = String(repo ?? '').trim() || settings.githubDefaultRepo;
  if (!value) {
    throw new HttpError(
      '📦 مخزن مشخص نشد. `repo` را به شکل owner/name بدهید یا GITHUB_DEFAULT_REPO را تنظیم کنید.',
      { service: 'GitHub', status: 0 }
    );
  }
  const parts = value.replace(/^https?:\/\/[^/]+\//i, '').replace(/\.git$/i, '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new HttpError(`📦 نام مخزن نامعتبر است: «${value}» — قالب درست: owner/name`, {
      service: 'GitHub',
      status: 422,
    });
  }
  return { owner: parts[0], repo: parts[1], fullName: `${parts[0]}/${parts[1]}` };
}

function encodePath(path) {
  return String(path ?? '')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

function repoApi(fullName) {
  return `/repos/${fullName}`;
}

// ── read operations ─────────────────────────────────────────────────────────

/** Repository metadata. Also validates the token can see the repo. */
export async function getRepo(repo) {
  const { fullName } = resolveRepo(repo);
  const { data } = await gh(repoApi(fullName));
  return {
    fullName: data.full_name,
    private: data.private,
    defaultBranch: data.default_branch,
    url: data.html_url,
    description: data.description || '',
    language: data.language || '',
    stars: data.stargazers_count || 0,
    permissions: data.permissions || null,
  };
}

/** Flat file listing from the git tree (one request for the whole repo). */
export async function listFiles({ repo, path = '', ref, limit = 120 } = {}) {
  const { fullName } = resolveRepo(repo);
  const branch = ref || settings.githubDefaultBranch || 'HEAD';
  const { data } = await gh(`${repoApi(fullName)}/git/trees/${encodeURIComponent(branch)}`, {
    query: { recursive: 1 },
  });
  const prefix = String(path ?? '').replace(/^\/+|\/+$/g, '');
  const entries = (data.tree || [])
    .filter((entry) => entry.type === 'blob' || entry.type === 'tree')
    .filter((entry) => (prefix ? entry.path === prefix || entry.path.startsWith(`${prefix}/`) : true))
    // The tree API caps a page at 100 000 entries and its own `per_page` rules,
    // but a huge listing is useless in a chat: clamp to the display budget.
    .slice(0, Math.min(Number(limit) || 120, MAX_TREE_ENTRIES))
    .map((entry) => ({ path: entry.path, type: entry.type === 'tree' ? 'dir' : 'file', size: entry.size || 0 }));
  return {
    repo: fullName,
    ref: branch,
    truncated: Boolean(data.truncated),
    count: entries.length,
    entries,
  };
}

/** File contents as UTF-8 text. Binary files are reported, not returned. */
export async function readFile({ repo, path, ref } = {}) {
  const { fullName } = resolveRepo(repo);
  if (!path) throw new HttpError('📄 مسیر فایل (`path`) لازم است.', { service: 'GitHub', status: 422 });
  const { data } = await gh(`${repoApi(fullName)}/contents/${encodePath(path)}`, {
    query: { ref: ref || undefined },
  });
  if (Array.isArray(data)) {
    return {
      repo: fullName,
      path,
      type: 'dir',
      entries: data.slice(0, 200).map((item) => `${item.type === 'dir' ? '📁' : '📄'} ${item.path}`),
    };
  }
  if ((data.size || 0) > MAX_INLINE_FILE_BYTES) {
    throw new HttpError(`📄 فایل «${path}» بزرگ‌تر از ۱ مگابایت است و با این API خوانده نمی‌شود.`, {
      service: 'GitHub',
      status: 413,
    });
  }
  const content = data.content ? base64ToUtf8(data.content.replace(/\s/g, '')) : '';
  return {
    repo: fullName,
    path: data.path,
    type: 'file',
    sha: data.sha,
    size: data.size,
    encoding: data.encoding,
    content,
  };
}

/** Recent commits on a branch. */
export async function listCommits({ repo, ref, limit = 10 } = {}) {
  const { fullName } = resolveRepo(repo);
  const { data } = await gh(`${repoApi(fullName)}/commits`, {
    query: { sha: ref || settings.githubDefaultBranch, per_page: Math.min(Number(limit) || 10, 30) },
  });
  return {
    repo: fullName,
    commits: (data || []).map((c) => ({
      sha: c.sha,
      shortSha: String(c.sha || '').slice(0, 7),
      message: String(c.commit?.message || '').split('\n')[0],
      author: c.commit?.author?.name || c.author?.login || '?',
      date: c.commit?.author?.date || '',
    })),
  };
}

/** Issues and pull requests (GitHub returns both from /issues). */
export async function listIssues({ repo, state = 'open', limit = 10 } = {}) {
  const { fullName } = resolveRepo(repo);
  const { data } = await gh(`${repoApi(fullName)}/issues`, {
    query: { state, per_page: Math.min(Number(limit) || 10, 30) },
  });
  return {
    repo: fullName,
    issues: (data || []).map((i) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      isPullRequest: Boolean(i.pull_request),
      user: i.user?.login,
      url: i.html_url,
    })),
  };
}

/** Latest Actions runs, newest first. */
export async function listWorkflowRuns({ repo, limit = 5, workflow } = {}) {
  const { fullName } = resolveRepo(repo);
  const path = workflow
    ? `${repoApi(fullName)}/actions/workflows/${encodeURIComponent(workflow)}/runs`
    : `${repoApi(fullName)}/actions/runs`;
  const { data } = await gh(path, { query: { per_page: Math.min(Number(limit) || 5, 20) } });
  return {
    repo: fullName,
    runs: (data?.workflow_runs || []).map((run) => ({
      id: run.id,
      name: run.name,
      workflow: run.path,
      status: run.status,
      conclusion: run.conclusion,
      branch: run.head_branch,
      url: run.html_url,
      createdAt: run.created_at,
    })),
  };
}

// ── write operations ────────────────────────────────────────────────────────

/** True when the path already exists on the branch (used before confirming an overwrite). */
export async function fileExists({ repo, path, ref } = {}) {
  try {
    const file = await readFile({ repo, path, ref });
    return file.type === 'file' ? file.sha : null;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Create or update a file in one commit. When `sha` is omitted and the file
 * exists, its sha is read first — that turns "update" into one well-defined
 * operation instead of a 422 from GitHub.
 */
export async function writeFile({
  repo,
  path,
  content,
  message,
  branch,
  sha,
  returnOnly = false,
} = {}) {
  const { fullName } = resolveRepo(repo);
  if (!path) throw new HttpError('📄 مسیر فایل (`path`) لازم است.', { service: 'GitHub', status: 422 });
  const targetBranch = branch || settings.githubDefaultBranch || undefined;

  let existingSha = sha || null;
  if (!existingSha) existingSha = await fileExists({ repo, path, ref: targetBranch });

  const body = {
    message: message || `${existingSha ? 'Update' : 'Add'} ${path}`,
    content: utf8ToBase64(content ?? ''),
    ...(targetBranch ? { branch: targetBranch } : {}),
    ...(existingSha ? { sha: existingSha } : {}),
  };

  if (returnOnly) return { repo: fullName, path, branch: targetBranch, sha: existingSha, exists: Boolean(existingSha) };

  const { data } = await gh(`${repoApi(fullName)}/contents/${encodePath(path)}`, {
    method: 'PUT',
    body,
  });
  return {
    repo: fullName,
    path: data.content?.path || path,
    branch: targetBranch || data.commit?.sha,
    created: !existingSha,
    commit: data.commit?.sha,
    commitUrl: data.commit?.html_url,
    url: data.content?.html_url,
  };
}

/** Delete a file. Requires its blob sha, which is read automatically when absent. */
export async function deleteFile({ repo, path, message, branch, sha } = {}) {
  const { fullName } = resolveRepo(repo);
  if (!path) throw new HttpError('📄 مسیر فایل (`path`) لازم است.', { service: 'GitHub', status: 422 });
  const targetBranch = branch || settings.githubDefaultBranch || undefined;
  const blobSha = sha || (await fileExists({ repo, path, ref: targetBranch }));
  if (!blobSha) throw new HttpError(`📄 فایل «${path}» پیدا نشد.`, { service: 'GitHub', status: 404 });

  const { data } = await gh(`${repoApi(fullName)}/contents/${encodePath(path)}`, {
    method: 'DELETE',
    body: {
      message: message || `Delete ${path}`,
      sha: blobSha,
      ...(targetBranch ? { branch: targetBranch } : {}),
    },
  });
  return { repo: fullName, path, deleted: true, commit: data.commit?.sha, commitUrl: data.commit?.html_url };
}

/** Create a branch from `from` (default: the repo's default branch). */
export async function createBranch({ repo, branch, from } = {}) {
  const { fullName } = resolveRepo(repo);
  if (!branch) throw new HttpError('🌿 نام شاخه (`branch`) لازم است.', { service: 'GitHub', status: 422 });

  const base = from || (await getRepo(fullName)).defaultBranch;
  const { data: ref } = await gh(`${repoApi(fullName)}/git/ref/heads/${encodePath(base)}`);
  const sha = ref.object?.sha;
  if (!sha) throw new HttpError(`🌿 شاخه «${base}» پیدا نشد.`, { service: 'GitHub', status: 404 });

  try {
    const { data } = await gh(`${repoApi(fullName)}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${branch}`, sha },
    });
    return { repo: fullName, branch, from: base, sha: data.object?.sha, created: true };
  } catch (err) {
    // 422 = ref already exists; treat as success so retries are idempotent.
    if (err instanceof HttpError && err.status === 422) {
      return { repo: fullName, branch, from: base, sha, created: false, note: 'شاخه از قبل وجود داشت.' };
    }
    throw err;
  }
}

/** Open a pull request. */
export async function createPullRequest({ repo, title, head, base, body = '' } = {}) {
  const { fullName } = resolveRepo(repo);
  if (!title || !head) {
    throw new HttpError('🔀 برای ساخت Pull Request به `title` و `head` نیاز است.', {
      service: 'GitHub',
      status: 422,
    });
  }
  const baseBranch = base || (await getRepo(fullName)).defaultBranch;
  try {
    const { data } = await gh(`${repoApi(fullName)}/pulls`, {
      method: 'POST',
      body: { title, head, base: baseBranch, body },
    });
    return { repo: fullName, number: data.number, url: data.html_url, head, base: baseBranch, state: data.state };
  } catch (err) {
    if (err instanceof HttpError && err.status === 422) {
      throw new HttpError(
        `🔀 Pull Request ساخته نشد (422): ممکن است از قبل وجود داشته باشد یا شاخه «${head}» نباشد.`,
        { service: 'GitHub', status: 422, details: err.details }
      );
    }
    throw err;
  }
}

/** Create an issue. */
export async function createIssue({ repo, title, body = '', labels = [] } = {}) {
  const { fullName } = resolveRepo(repo);
  if (!title) throw new HttpError('🐞 عنوان Issue لازم است.', { service: 'GitHub', status: 422 });
  const { data } = await gh(`${repoApi(fullName)}/issues`, {
    method: 'POST',
    body: { title, body, labels: Array.isArray(labels) ? labels : [] },
  });
  return { repo: fullName, number: data.number, url: data.html_url, state: data.state };
}

/** Dispatch a workflow (workflow_dispatch event). */
export async function triggerWorkflow({ repo, workflow, ref, inputs = {} } = {}) {
  const { fullName } = resolveRepo(repo);
  if (!workflow) {
    throw new HttpError('⚙️ شناسه یا نام فایل workflow لازم است (مثلاً deploy.yml).', {
      service: 'GitHub',
      status: 422,
    });
  }
  const branch = ref || settings.githubDefaultBranch;
  await gh(`${repoApi(fullName)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    method: 'POST',
    body: { ref: branch, inputs: inputs && typeof inputs === 'object' ? inputs : {} },
    allowStatus: [204],
  });
  return {
    repo: fullName,
    workflow,
    ref: branch,
    dispatched: true,
    note: 'workflow_dispatch ارسال شد؛ اجرای آن چند ثانیه بعد ظاهر می‌شود.',
  };
}

/** Token identity + rate limit, for the Mini App status bar. */
export async function status() {
  if (!settings.githubToken) return { connected: false, reason: 'GITHUB_TOKEN تنظیم نشده است.' };
  try {
    const [{ data: user }, { data: rate }] = await Promise.all([
      gh('/user'),
      gh('/rate_limit'),
    ]);
    return {
      connected: true,
      login: user.login,
      name: user.name || user.login,
      avatar: user.avatar_url,
      scopes: 'token valid',
      rateRemaining: rate?.rate?.remaining ?? null,
      rateLimit: rate?.rate?.limit ?? null,
      defaultRepo: settings.githubDefaultRepo || null,
    };
  } catch (err) {
    return { connected: false, reason: err.message };
  }
}

/** Upload binary content (an image, a zip) to a repository path. */
export async function putBinaryFile({ repo, path, bytes, message, branch } = {}) {
  const { fullName } = resolveRepo(repo);
  if (!path) throw new HttpError('📄 مسیر فایل (`path`) لازم است.', { service: 'GitHub', status: 422 });
  const binary = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  const existingSha = await fileExists({ repo, path, ref: branch });
  const { data } = await gh(`${repoApi(fullName)}/contents/${encodePath(path)}`, {
    method: 'PUT',
    body: {
      message: message || `${existingSha ? 'Update' : 'Add'} ${path}`,
      content: bytesToBase64(binary),
      ...(branch ? { branch } : {}),
      ...(existingSha ? { sha: existingSha } : {}),
    },
  });
  return { repo: fullName, path, commit: data.commit?.sha, url: data.content?.html_url };
}
