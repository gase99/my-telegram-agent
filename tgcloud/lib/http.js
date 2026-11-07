// tgcloud/lib/http.js — one HTTP entry point for GitHub, GitLab and Google.
//
// Everything goes through the platform `fetch`; there is no npm client library
// in the isolate. Features we need from an API client and get here:
//   • JSON body handling that never throws on an empty/non-JSON body
//   • retry with backoff on 429 / 5xx (honouring Retry-After)
//   • a timeout guard (when the isolate provides setTimeout)
//   • errors that carry status + a redacted provider message, never the token

import { fetch } from 'sdk';
import { redactSecrets } from './security.js';

export class HttpError extends Error {
  constructor(message, { status = 0, service = 'http', details = null, retryable = false } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.service = service;
    this.details = details;
    this.retryable = retryable;
  }
}

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RETRIES = 2;
const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function hasTimers() {
  return typeof setTimeout === 'function' && typeof clearTimeout === 'function';
}

/** Wait `ms`; resolves immediately when the runtime has no timers. */
export function sleep(ms) {
  if (!hasTimers() || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  if (!hasTimers() || !ms) return promise;
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new HttpError(`درخواست پس از ${Math.round(ms / 1000)} ثانیه قطع شد`, { status: 408, retryable: true })),
      ms
    );
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function retryDelayMs(res, attempt) {
  const header = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 20) * 1000;
  return 500 * Math.pow(2, attempt); // 500ms, 1s
}

function buildUrl(url, query) {
  if (!query) return url;
  const params = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  if (!params.length) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${params.join('&')}`;
}

/**
 * Perform a request. Returns `{ ok, status, headers, data, text, url }` for
 * successful calls; throws `HttpError` for HTTP failures.
 *
 * @param {string} url
 * @param {object} options
 * @param {string}   [options.method]   HTTP verb, default GET
 * @param {object}   [options.headers]  extra headers
 * @param {any}      [options.body]     object (JSON-encoded) or string/Uint8Array
 * @param {object}   [options.query]    query-string values (undefined skipped)
 * @param {string}   [options.service]  name used in error messages
 * @param {number}   [options.timeoutMs]
 * @param {number}   [options.retries]
 * @param {boolean}  [options.allowStatus] treat these statuses as success
 */
export async function request(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    query,
    service = 'http',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = MAX_RETRIES,
    allowStatus = [],
  } = options;

  const finalUrl = buildUrl(url, query);
  const outgoing = { ...headers };
  let payload;

  if (body !== undefined && body !== null) {
    if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      if (!outgoing['Content-Type'] && !outgoing['content-type']) {
        outgoing['Content-Type'] = 'application/json';
      }
    }
  }

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await withTimeout(
        fetch(finalUrl, { method, headers: outgoing, body: payload }),
        timeoutMs
      );
    } catch (err) {
      lastError = new HttpError(networkMessage(service, err), { status: 0, service, retryable: true });
      if (attempt < retries) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      throw lastError;
    }

    if (res.ok || allowStatus.includes(res.status)) {
      const parsed = await readBody(res);
      return { ok: res.ok, status: res.status, headers: res.headers, url: res.url || finalUrl, ...parsed };
    }

    const parsed = await readBody(res);
    const details = parsed.data ?? parsed.text ?? null;
    lastError = new HttpError(describeHttpFailure(service, res.status, details), {
      status: res.status,
      service,
      details,
      retryable: RETRY_STATUSES.has(res.status),
    });

    if (RETRY_STATUSES.has(res.status) && attempt < retries) {
      await sleep(retryDelayMs(res, attempt));
      continue;
    }
    throw lastError;
  }

  throw lastError ?? new HttpError(`${service}: درخواست ناموفق بود`, { service });
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return { data: null, text: '' };
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { data: null, text };
  try {
    return { data: JSON.parse(trimmed), text };
  } catch {
    return { data: null, text };
  }
}

function networkMessage(service, err) {
  const raw = err && err.message ? err.message : String(err);
  const safe = redactSecrets(raw);
  if (/timeout|timed out|cancel/i.test(safe)) return `⏱ ${service}: زمان پاسخ‌دهی سرویس به پایان رسید.`;
  if (/ENOTFOUND|dns|resolve/i.test(safe)) return `🌐 ${service}: نام دامنه پیدا نشد.`;
  if (/SSRF|blocked|not allowed/i.test(safe)) return `🚫 ${service}: دسترسی شبکه به این آدرس مجاز نیست.`;
  return `🌐 ${service}: خطای شبکه — ${safe}`;
}

/** Turn a provider error payload into one Persian line. */
function describeHttpFailure(service, status, details) {
  const providerMessage = extractProviderMessage(details);
  const suffix = providerMessage ? ` — ${providerMessage}` : '';
  switch (status) {
    case 400:
      return `${service}: درخواست نامعتبر است${suffix}`;
    case 401:
      return `${service}: توکن معتبر نیست یا منقضی شده است (401)${suffix}`;
    case 403:
      return `${service}: دسترسی رد شد؛ مجوز (scope) توکن را بررسی کنید (403)${suffix}`;
    case 404:
      return `${service}: منبع پیدا نشد (404)${suffix}`;
    case 409:
      return `${service}: تداخل نسخه (409) — فایل یا شاخه تغییر کرده است${suffix}`;
    case 422:
      return `${service}: داده ارسالی پذیرفته نشد (422)${suffix}`;
    case 429:
      return `${service}: محدودیت نرخ درخواست؛ کمی بعد دوباره تلاش کنید (429)${suffix}`;
    default:
      return `${service}: خطای ${status}${suffix}`;
  }
}

function extractProviderMessage(details) {
  if (!details) return '';
  const raw =
    (typeof details === 'string' && details) ||
    details.message ||
    details.error_description ||
    (details.error && details.error.message) ||
    (Array.isArray(details.errors) && details.errors.map((e) => e.message || e.code).join('; ')) ||
    (details.error && typeof details.error === 'string' && details.error) ||
    '';
  return redactSecrets(String(raw)).slice(0, 300);
}
