// tgcloud/lib/gitlab.js — GitLab REST v4 client on the platform fetch.
//
// Same shape as lib/github.js: plain arguments in, a normalised result out,
// `HttpError` with a Persian message on failure. Project may be given as a
// `group/project` path (URL-encoded here) or a numeric id.

import { request, HttpError } from './http.js';
import { base64ToUtf8, utf8ToBase64 } from './encoding.js';
import { settings } from './settings.js';

const API_VERSION = '/api/v4';

function base() {
  return settings.gitlabBaseUrl;
}

function headers(extra = {}) {
  if (!settings.gitlabToken) {
    throw new HttpError('🦊 GitLab پیکربندی نشده است: GITLAB_TOKEN در tgcloud/lib/config.js خالی است.', {
      service: 'GitLab',
      status: 0,
    });
  }
  return {
    Authorization: `Bearer ${settings.gitlabToken}`,
    Accept: 'application/json',
    'User-Agent': 'tgcloud-ai-coding-agent',
    ...extra,
  };
}

function gl(path, options = {}) {
  return request(`${base()}${API_VERSION}${path}`, {
    ...options,
    headers: headers(options.headers),
    service: 'GitLab',
  });
}

/** Project id or `group/project` → the path segment; falls back to the default. */
export function resolveProject(project) {
  const value = String(project ?? '').trim() || settings.gitlabDefaultProject;
  if (!value) {
    throw new HttpError(
      '🦊 پروژه مشخص نشد. `project` را به شکل group/name بدهید یا GITLAB_DEFAULT_PROJECT را تنظیم کنید.',
      { service: 'GitLab', status: 0 }
    );
  }
  const cleaned = value
    .replace(/^https?:\/\/[^/]+\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  return { id: encodeURIComponent(cleaned), fullPath: cleaned };
}

function encodePath(path) {
  return String(path ?? '')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

// ── read ────────────────────────────────────────────────────────────────────

export async function getProject(project) {
  const { id, fullPath } = resolveProject(project);
  const { data } = await gl(`/projects/${id}`);
  return {
    project: data.path_with_namespace || fullPath,
    id: data.id,
    defaultBranch: data.default_branch,
    url: data.web_url,
    visibility: data.visibility,
    description: data.description || '',
  };
}

export async function listFiles({ project, path = '', ref, limit = 100 } = {}) {
  const { id, fullPath } = resolveProject(project);
  const { data } = await gl(`/projects/${id}/repository/tree`, {
    query: {
      path: String(path ?? '').replace(/^\/+|\/+$/g, '') || undefined,
      ref: ref || settings.gitlabDefaultBranch,
      per_page: Math.min(Number(limit) || 100, 100),
      recursive: false,
    },
  });
  return {
    project: fullPath,
    ref: ref || settings.gitlabDefaultBranch,
    entries: (data || []).map((e) => ({ path: e.path, type: e.type === 'tree' ? 'dir' : 'file', id: e.id })),
  };
}

export async function readFile({ project, path, ref } = {}) {
  const { id, fullPath } = resolveProject(project);
  if (!path) throw new HttpError('📄 مسیر فایل (`path`) لازم است.', { service: 'GitLab', status: 422 });
  const { data } = await gl(`/projects/${id}/repository/files/${encodePath(path)}`, {
    query: { ref: ref || settings.gitlabDefaultBranch },
  });
  if (data.encoding === 'base64' && data.content) {
    return { project: fullPath, path: data.file_path, content: base64ToUtf8(data.content), size: data.size, ref: data.ref };
  }
  return { project: fullPath, path: data.file_path, content: data.content || '', ref: data.ref };
}

export async function listCommits({ project, ref, limit = 10 } = {}) {
  const { id, fullPath } = resolveProject(project);
  const { data } = await gl(`/projects/${id}/repository/commits`, {
    query: { ref_name: ref || settings.gitlabDefaultBranch, per_page: Math.min(Number(limit) || 10, 30) },
  });
  return {
    project: fullPath,
    commits: (data || []).map((c) => ({
      sha: c.id,
      shortSha: String(c.short_id || c.id || '').slice(0, 8),
      message: String(c.title || c.message || '').split('\n')[0],
      author: c.author_name,
      date: c.created_at,
    })),
  };
}

// ── write ───────────────────────────────────────────────────────────────────

/**
 * Create, update or delete a file. GitLab picks the verb from the `action`
 * field, not the HTTP method, so all three go through POST /repository/commits
 * which can also carry several changes at once.
 */
export async function commitFiles({ project, branch, message, actions = [] } = {}) {
  const { id, fullPath } = resolveProject(project);
  if (!Array.isArray(actions) || !actions.length) {
    throw new HttpError('📄 هیچ تغییری برای ثبت مشخص نشده است.', { service: 'GitLab', status: 422 });
  }
  const targetBranch = branch || settings.gitlabDefaultBranch;
  const normalised = actions.map((a) => {
    if (!a || !a.action || !a.file_path) {
      throw new HttpError('📄 هر تغییر به `action` و `file_path` نیاز دارد.', { service: 'GitLab', status: 422 });
    }
    return {
      action: a.action, // create | update | delete | move
      file_path: String(a.file_path).replace(/^\/+/, ''),
      ...(a.content !== undefined ? { content: String(a.content) } : {}),
      ...(a.previous_path ? { previous_path: a.previous_path } : {}),
      encoding: 'text',
    };
  });
  const { data } = await gl(`/projects/${id}/repository/commits`, {
    method: 'POST',
    body: { branch: targetBranch, commit_message: message || 'Update via AI agent', actions: normalised },
  });
  return {
    project: fullPath,
    branch: targetBranch,
    commit: data.id,
    shortSha: data.short_id,
    url: data.web_url,
    title: data.title,
  };
}

/** Convenience: write one text file, updating it when it already exists. */
export async function writeFile({ project, path, content, message, branch } = {}) {
  const target = String(path ?? '').replace(/^\/+/, '');
  if (!target) throw new HttpError('📄 مسیر فایل (`path`) لازم است.', { service: 'GitLab', status: 422 });

  let action = 'create';
  try {
    await readFile({ project, path: target, ref: branch });
    action = 'update';
  } catch (err) {
    if (!(err instanceof HttpError) || err.status !== 404) throw err;
  }
  const result = await commitFiles({
    project,
    branch,
    message,
    actions: [{ action, file_path: target, content: content ?? '' }],
  });
  return { ...result, path: target, created: action === 'create' };
}

export async function deleteFile({ project, path, message, branch } = {}) {
  const target = String(path ?? '').replace(/^\/+/, '');
  if (!target) throw new HttpError('📄 مسیر فایل (`path`) لازم است.', { service: 'GitLab', status: 422 });
  const result = await commitFiles({
    project,
    branch,
    message: message || `Delete ${target}`,
    actions: [{ action: 'delete', file_path: target }],
  });
  return { ...result, path: target, deleted: true };
}

export async function createBranch({ project, branch, ref } = {}) {
  const { id, fullPath } = resolveProject(project);
  if (!branch) throw new HttpError('🌿 نام شاخه (`branch`) لازم است.', { service: 'GitLab', status: 422 });
  const from = ref || settings.gitlabDefaultBranch;
  try {
    const { data } = await gl(`/projects/${id}/repository/branches`, {
      method: 'POST',
      body: { branch, ref: from },
    });
    return { project: fullPath, branch: data.name, from, created: true };
  } catch (err) {
    if (err instanceof HttpError && err.status === 400) {
      return { project: fullPath, branch, from, created: false, note: 'شاخه از قبل وجود دارد.' };
    }
    throw err;
  }
}

export async function createMergeRequest({ project, title, sourceBranch, targetBranch, description = '' } = {}) {
  const { id, fullPath } = resolveProject(project);
  if (!title || !sourceBranch) {
    throw new HttpError('🔀 برای Merge Request به `title` و `source_branch` نیاز است.', {
      service: 'GitLab',
      status: 422,
    });
  }
  const { data } = await gl(`/projects/${id}/merge_requests`, {
    method: 'POST',
    body: {
      title,
      source_branch: sourceBranch,
      target_branch: targetBranch || settings.gitlabDefaultBranch,
      description,
    },
  });
  return { project: fullPath, iid: data.iid, url: data.web_url, state: data.state };
}

export async function triggerPipeline({ project, ref } = {}) {
  const { id, fullPath } = resolveProject(project);
  const { data } = await gl(`/projects/${id}/pipeline`, {
    method: 'POST',
    body: { ref: ref || settings.gitlabDefaultBranch },
  });
  return { project: fullPath, pipelineId: data.id, status: data.status, url: data.web_url };
}

export async function status() {
  if (!settings.gitlabToken) return { connected: false, reason: 'GITLAB_TOKEN تنظیم نشده است.' };
  try {
    const { data } = await gl('/user');
    return {
      connected: true,
      login: data.username,
      name: data.name || data.username,
      avatar: data.avatar_url,
      host: base().replace(/^https?:\/\//, ''),
      defaultProject: settings.gitlabDefaultProject || null,
    };
  } catch (err) {
    return { connected: false, reason: err.message };
  }
}

/** Encoded content helper kept for callers that already have bytes. */
export function encodeContent(text) {
  return utf8ToBase64(text);
}
