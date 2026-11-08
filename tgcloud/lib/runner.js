// tgcloud/lib/runner.js — execute Python through the Piston sandbox API.
//
// This module uses the platform SDK's fetch and intentionally has no runtime
// npm dependencies. Code size and request duration are bounded before the
// remote sandbox is called.

import { fetch } from 'sdk';

const PISTON_URL = 'https://emkc.org/api/v2/piston/execute';
const PYTHON_VERSION = '*';
const MAX_CODE_LENGTH = 12000;
const REQUEST_TIMEOUT_MS = 20000;

export async function executeCode(code) {
  if (typeof code !== 'string' || !code.trim()) {
    throw new TypeError('کد پایتون نمی‌تواند خالی باشد.');
  }
  if (code.length > MAX_CODE_LENGTH) {
    throw new RangeError(`کد باید حداکثر ${MAX_CODE_LENGTH} نویسه باشد.`);
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    : null;

  try {
    const response = await fetch(PISTON_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        language: 'python',
        version: PYTHON_VERSION,
        files: [{ name: 'main.py', content: code }],
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (!response?.ok) {
      throw new Error(`Piston پاسخ نامعتبر داد (HTTP ${response?.status || 0}).`);
    }

    const data = await response.json();
    if (!data || typeof data !== 'object' || !data.run || typeof data.run !== 'object') {
      const detail = typeof data?.message === 'string' ? ` ${data.message}` : '';
      throw new Error(`پاسخ Piston ناقص است.${detail}`);
    }

    const run = data.run;
    const output = typeof run.output === 'string' && run.output.length
      ? run.output
      : [run.stdout, run.stderr]
        .filter((part) => typeof part === 'string' && part.length)
        .join(run.stdout && run.stderr ? '\n' : '');

    return output || 'بدون خروجی';
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('زمان اجرای درخواست Piston تمام شد.');
    }
    if (err instanceof TypeError || err instanceof RangeError) throw err;
    throw new Error(err?.message || 'ارتباط با محیط اجرای کد برقرار نشد.');
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
