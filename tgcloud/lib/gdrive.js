// tgcloud/lib/gdrive.js — Google Drive v3 with a service account.
//
// A service account authenticates with a signed JWT that is exchanged for an
// access token (RFC 7523). The token is cached for the life of the isolate, so
// a multi-step agent turn pays for the exchange once. The folder you want the
// bot to use must be shared with the service account's `client_email`.

import { request, HttpError } from './http.js';
import { createServiceAccountAssertion } from './jwt.js';
import { utf8Decode, utf8Encode, base64ToBytes, bytesToBase64 } from './encoding.js';
import { settings } from './settings.js';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPES = ['https://www.googleapis.com/auth/drive'];

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const TEXT_MIME = 'text/plain; charset=utf-8';

let tokenCache = null; // { token, expiresAt }

/** The service account, whether it was given as an object or as JSON text. */
export function serviceAccount() {
  return settings.googleServiceAccount;
}

async function accessToken() {
  const account = serviceAccount();
  if (!account) {
    throw new HttpError(
      '📁 Google Drive پیکربندی نشده است: GOOGLE_SERVICE_ACCOUNT در tgcloud/lib/config.js خالی است.',
      { service: 'Drive', status: 0 }
    );
  }
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.token;

  const assertion = await createServiceAccountAssertion(account, SCOPES);
  const { data } = await request(account.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    service: 'Google OAuth',
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    retries: 1,
  });
  if (!data?.access_token) throw new HttpError('📁 دریافت توکن گوگل ناموفق بود.', { service: 'Drive', status: 401 });

  tokenCache = {
    token: data.access_token,
    expiresAt: now + Math.max(60, Number(data.expires_in) || 3600) * 1000,
  };
  return tokenCache.token;
}

async function drive(path, options = {}) {
  const token = await accessToken();
  return request(`${DRIVE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    service: 'Drive',
  });
}

/** Escape a value for Drive's `q` query language (single quotes). */
function q(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Files in a folder (default: the configured folder, else the SA's root). */
export async function listFiles({ folderId = settings.googleDriveFolderId, limit = 30, nameContains } = {}) {
  const clauses = ['trashed = false'];
  if (folderId) clauses.push(`'${q(folderId)}' in parents`);
  if (nameContains) clauses.push(`name contains '${q(nameContains)}'`);
  const { data } = await drive('/files', {
    query: {
      q: clauses.join(' and '),
      pageSize: Math.min(Number(limit) || 30, 100),
      fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink,parents)',
      orderBy: 'modifiedTime desc',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    },
  });
  return {
    folderId: folderId || 'root',
    files: (data.files || []).map((f) => ({
      id: f.id,
      name: f.name,
      type: f.mimeType === FOLDER_MIME ? 'folder' : 'file',
      mimeType: f.mimeType,
      size: f.size ? Number(f.size) : 0,
      modifiedTime: f.modifiedTime,
      url: f.webViewLink,
    })),
  };
}

/** Search across Drive by name. */
export async function searchFiles({ query: text, limit = 20 } = {}) {
  if (!text) throw new HttpError('🔎 عبارت جست‌وجو خالی است.', { service: 'Drive', status: 422 });
  const { data } = await drive('/files', {
    query: {
      q: `trashed = false and name contains '${q(text)}'`,
      pageSize: Math.min(Number(limit) || 20, 50),
      fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink)',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    },
  });
  return {
    query: text,
    files: (data.files || []).map((f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: f.size ? Number(f.size) : 0,
      modifiedTime: f.modifiedTime,
      url: f.webViewLink,
    })),
  };
}

/** Metadata for one file. */
export async function getFile({ fileId } = {}) {
  if (!fileId) throw new HttpError('📄 شناسه فایل (`fileId`) لازم است.', { service: 'Drive', status: 422 });
  const { data } = await drive(`/files/${encodeURIComponent(fileId)}`, {
    query: { fields: 'id,name,mimeType,size,modifiedTime,webViewLink,parents', supportsAllDrives: 'true' },
  });
  return data;
}

/** Download text content. Google Docs are exported as plain text. */
export async function readFile({ fileId } = {}) {
  if (!fileId) throw new HttpError('📄 شناسه فایل (`fileId`) لازم است.', { service: 'Drive', status: 422 });
  const meta = await getFile({ fileId });

  if (String(meta.mimeType || '').startsWith('application/vnd.google-apps')) {
    const { data } = await drive(`/files/${encodeURIComponent(fileId)}/export`, {
      query: { mimeType: 'text/plain' },
    });
    return { ...meta, content: typeof data === 'string' ? data : '' };
  }
  if ((meta.size ? Number(meta.size) : 0) > 1024 * 1024) {
    throw new HttpError(`📄 فایل «${meta.name}» بزرگ‌تر از ۱ مگابایت است.`, { service: 'Drive', status: 413 });
  }

  const token = await accessToken();
  const res = await request(`${DRIVE}/files/${encodeURIComponent(fileId)}`, {
    query: { alt: 'media', supportsAllDrives: 'true' },
    headers: { Authorization: `Bearer ${token}` },
    service: 'Drive',
  });
  const text = res.data === null ? res.text : JSON.stringify(res.data);
  return { ...meta, content: text };
}

/**
 * Upload a text file. Created in `folderId` (default: the configured folder).
 * Two calls — metadata, then media — which keeps both paths trivially correct.
 */
export async function uploadTextFile({ name, content, folderId = settings.googleDriveFolderId, mimeType = TEXT_MIME } = {}) {
  if (!name) throw new HttpError('📄 نام فایل (`name`) لازم است.', { service: 'Drive', status: 422 });
  const metadata = {
    name,
    mimeType,
    ...(folderId ? { parents: [folderId] } : {}),
  };
  const { data } = await drive('/files', {
    method: 'POST',
    body: metadata,
    query: { fields: 'id,name,webViewLink,parents', supportsAllDrives: 'true' },
  });

  const token = await accessToken();
  await request(`${UPLOAD}/files/${encodeURIComponent(data.id)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType || TEXT_MIME },
    body: String(content ?? ''),
    query: { uploadType: 'media', supportsAllDrives: 'true' },
    service: 'Drive',
  });

  return { id: data.id, name: data.name, url: data.webViewLink, folderId: folderId || 'root', bytes: String(content ?? '').length };
}

/** Upload bytes (an image, a zip) with the same two-step flow. */
export async function uploadBinaryFile({ name, bytes, folderId = settings.googleDriveFolderId, mimeType = 'application/octet-stream' } = {}) {
  if (!name) throw new HttpError('📄 نام فایل (`name`) لازم است.', { service: 'Drive', status: 422 });
  const metadata = { name, mimeType, ...(folderId ? { parents: [folderId] } : {}) };
  const { data } = await drive('/files', {
    method: 'POST',
    body: metadata,
    query: { fields: 'id,name,webViewLink', supportsAllDrives: 'true' },
  });
  const token = await accessToken();
  const binary = bytes instanceof Uint8Array ? bytes : base64ToBytes(bytes);
  await request(`${UPLOAD}/files/${encodeURIComponent(data.id)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
    body: binary,
    query: { uploadType: 'media', supportsAllDrives: 'true' },
    service: 'Drive',
  });
  return { id: data.id, name: data.name, url: data.webViewLink, size: binary.length };
}

/** Replace the content of an existing file. */
export async function updateTextFile({ fileId, content, mimeType = TEXT_MIME } = {}) {
  if (!fileId) throw new HttpError('📄 شناسه فایل (`fileId`) لازم است.', { service: 'Drive', status: 422 });
  const token = await accessToken();
  await request(`${UPLOAD}/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': mimeType },
    body: String(content ?? ''),
    query: { uploadType: 'media', supportsAllDrives: 'true' },
    service: 'Drive',
  });
  return { id: fileId, updated: true, bytes: String(content ?? '').length };
}

/** Create a folder (inside `parentId`, default: the configured folder). */
export async function createFolder({ name, parentId = settings.googleDriveFolderId } = {}) {
  if (!name) throw new HttpError('📁 نام پوشه لازم است.', { service: 'Drive', status: 422 });
  const { data } = await drive('/files', {
    method: 'POST',
    body: {
      name,
      mimeType: FOLDER_MIME,
      ...(parentId ? { parents: [parentId] } : {}),
    },
    query: { fields: 'id,name,webViewLink', supportsAllDrives: 'true' },
  });
  return { id: data.id, name: data.name, url: data.webViewLink, parentId: parentId || 'root' };
}

/** Move a file to the trash (recoverable — Drive keeps it for 30 days). */
export async function trashFile({ fileId } = {}) {
  if (!fileId) throw new HttpError('📄 شناسه فایل (`fileId`) لازم است.', { service: 'Drive', status: 422 });
  const { data } = await drive(`/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    body: { trashed: true },
    query: { fields: 'id,name,trashed', supportsAllDrives: 'true' },
  });
  return { id: data.id, name: data.name, trashed: true };
}

/** Share a file with an email address. */
export async function shareFile({ fileId, email, role = 'reader' } = {}) {
  if (!fileId || !email) throw new HttpError('👥 برای اشتراک‌گذاری به fileId و email نیاز است.', {
    service: 'Drive',
    status: 422,
  });
  const { data } = await drive(`/files/${encodeURIComponent(fileId)}/permissions`, {
    method: 'POST',
    body: { type: 'user', role, emailAddress: email },
    query: { fields: 'id,role,type', sendNotificationEmail: 'true', supportsAllDrives: 'true' },
  });
  return { fileId, permissionId: data.id, role: data.role, email };
}

/** Service-account identity + whether the configured folder is reachable. */
export async function status() {
  const account = serviceAccount();
  if (!account) return { connected: false, reason: 'GOOGLE_SERVICE_ACCOUNT تنظیم نشده است.' };
  try {
    const about = await drive('/about', { query: { fields: 'user(emailAddress,displayName)' } });
    let folder = null;
    if (settings.googleDriveFolderId) {
      try {
        folder = await getFile({ fileId: settings.googleDriveFolderId });
      } catch (err) {
        folder = { error: err.message };
      }
    }
    return {
      connected: true,
      email: about?.data?.user?.emailAddress || account.client_email,
      displayName: about?.data?.user?.displayName || '',
      folder: folder && !folder.error ? { id: folder.id, name: folder.name } : null,
      folderError: folder?.error || null,
    };
  } catch (err) {
    return { connected: false, reason: err.message };
  }
}

/** Re-encode a string as base64 (exported for tools that need Drive-ready bytes). */
export function toBase64Content(text) {
  return bytesToBase64(utf8Encode(String(text ?? '')));
}

/** Decode base64 payloads coming from the model. */
export function fromBase64(encoded) {
  return utf8Decode(base64ToBytes(encoded));
}
