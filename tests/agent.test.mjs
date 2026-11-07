// tests/agent.test.mjs — offline tests for the tgcloud modules.
//
// `npm test` links tests/stubs/sdk into node_modules and runs every *.test.mjs
// with Node's built-in runner. The stub records Bot API calls and lets a test
// inject canned HTTP responses, so nothing here needs Telegram or a token.

import test from 'node:test';
import assert from 'node:assert/strict';

import { __resetDatabase, __setFetchMock, sentMessages } from 'sdk';
import {
  parseActions,
  stripActionBlocks,
  toTurns,
  runAgent,
  generateWithFallback,
  summariseAttempts,
  providerCatalog,
  toGeminiRequest,
  toOpenAIRequest,
} from '../tgcloud/lib/ai.js';
import { isKnownAction, runAction, describeAction } from '../tgcloud/lib/actions.js';
import { redactSecrets, isUserAllowed, integrationStatus } from '../tgcloud/lib/security.js';
import { ensureChat, addMessage, recentMessages, historyPage, clearHistory } from '../tgcloud/lib/store.js';
import { createApproval, approve, pendingApprovals, needsApproval } from '../tgcloud/lib/approvals.js';
import { sha256, parseRsaPrivateKey, rsaSignSha256, signJwt, createServiceAccountAssertion } from '../tgcloud/lib/jwt.js';
import { utf8ToBase64, base64ToUtf8, bytesToBase64, base64ToBytes, pemToDer } from '../tgcloud/lib/encoding.js';
import { findJsonObjects, stripTelegramMarkdown, byteLength, truncate } from '../tgcloud/lib/text.js';
import { resolveRepo } from '../tgcloud/lib/github.js';
import agentEndpoint from '../tgcloud/endpoints/agent.js';
import getHistory from '../tgcloud/endpoints/getHistory.js';
import approveEndpoint from '../tgcloud/endpoints/approve.js';
import clearHistoryEndpoint from '../tgcloud/endpoints/clearHistory.js';
import messageHandler from '../tgcloud/handlers/message.js';
import callbackHandler from '../tgcloud/handlers/callback_query.js';
import { settings } from '../tgcloud/lib/settings.js';

const USER = { id: 424242, first_name: 'Ali', username: 'ali' };
const ctxFor = (user = USER) => ({ initData: { user } });

// A fake HTTP layer: each test registers the responses it expects.
function mockHttp(routes) {
  const calls = [];
  __setFetchMock(async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body, headers: init.headers || {} });
    const match = routes.find(
      (route) =>
        String(url).includes(route.match) &&
        (!route.method || String(init.method || 'GET').toUpperCase() === route.method)
    );
    if (!match) throw new Error(`unexpected request: ${url}`);
    const body = typeof match.reply === 'string' ? match.reply : JSON.stringify(match.reply ?? {});
    return new Response(body, { status: match.status || 200, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

// ── encoding ────────────────────────────────────────────────────────────────

test('base64 round-trips UTF-8 including Persian text', () => {
  const samples = ['hello', 'سلام دنیا', 'emoji 🚀✓', 'line\nbreak\ttab', ''];
  for (const sample of samples) {
    assert.equal(base64ToUtf8(utf8ToBase64(sample)), sample);
  }
  assert.equal(utf8ToBase64('abc'), 'YWJj');
  assert.equal(bytesToBase64(new Uint8Array([0, 255, 128]), { urlSafe: true, pad: false }), 'AP-A');
});

test('base64 decoder rejects garbage', () => {
  assert.throws(() => base64ToBytes('not base64 !!'), /Invalid base64/);
  assert.deepEqual(Array.from(base64ToBytes('')), []);
});

test('pemToDer strips headers and literal \\n escapes', () => {
  const fake = '-----BEGIN PRIVATE KEY-----\\nYWJj\\n-----END PRIVATE KEY-----';
  assert.equal(new TextDecoder().decode(pemToDer(fake)), 'abc');
});

// ── JWT / crypto ────────────────────────────────────────────────────────────

test('sha256 matches the FIPS vectors', () => {
  const hex = (input) => Array.from(sha256(input)).map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('RSA PKCS#8 keys parse and sign with a verifiable signature shape', async () => {
  const { privateKey } = await import('node:crypto').then(({ generateKeyPairSync }) =>
    generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
  );
  const key = parseRsaPrivateKey(privateKey);
  assert.ok(key.n > 0n && key.d > 0n && key.e === 65537n);
  const signature = rsaSignSha256('payload', key);
  assert.equal(signature.length, 256);

  const jwt = await signJwt({ sub: 'x' }, privateKey);
  assert.equal(jwt.split('.').length, 3);
  const assertion = await createServiceAccountAssertion(
    { client_email: 'bot@example.iam.gserviceaccount.com', private_key: privateKey },
    ['https://www.googleapis.com/auth/drive']
  );
  const payload = JSON.parse(base64ToUtf8(assertion.split('.')[1]));
  assert.equal(payload.iss, 'bot@example.iam.gserviceaccount.com');
  assert.match(payload.scope, /auth\/drive/);
  assert.ok(payload.exp > payload.iat);
});

// ── text helpers ────────────────────────────────────────────────────────────

test('findJsonObjects ignores braces inside strings and code', () => {
  const text = 'pre {"a":{"b":"}{"}} post {"c":1} broken {x:}';
  const found = findJsonObjects(text).map((item) => item.value);
  assert.deepEqual(found, [{ a: { b: '}{' } }, { c: 1 }]);
});

test('telegram markdown is neutralised without eating file names', () => {
  const out = stripTelegramMarkdown('**bold** and file_name.py and `code`');
  assert.equal(out, 'bold and file_name.py and code');
});

test('byteLength counts UTF-8 bytes, truncate caps length', () => {
  assert.equal(byteLength('سلام'), 8);
  assert.equal(byteLength('ab'), 2);
  assert.ok(truncate('x'.repeat(50), 20).length <= 40);
});

// ── action protocol ─────────────────────────────────────────────────────────

test('parseActions reads fenced action blocks and batches', () => {
  const single = parseActions('ok\n```action\n{"service":"github","action":"read_file","params":{"path":"README.md"}}\n```');
  assert.equal(single.length, 1);
  assert.equal(single[0].service, 'github');
  assert.equal(single[0].params.path, 'README.md');

  const batch = parseActions(
    '```action\n{"actions":[{"service":"gdrive","action":"create_folder","params":{"name":"x"}},{"service":"github","action":"create_pr","params":{"title":"t","head":"h"}}]}\n```'
  );
  assert.deepEqual(batch.map((a) => a.action), ['create_folder', 'create_pr']);
});

test('parseActions drops unknown or malformed operations', () => {
  const actions = parseActions(
    '```action\n{"actions":[{"service":"github","action":"drop_database","params":{}},{"service":"nope","action":"read_file"},{"service":"github","action":"read_file","params":{}}]}\n```'
  );
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'read_file');
  assert.equal(isKnownAction('github', 'drop_database'), false);
});

test('a broken action fence is not silently half-executed', () => {
  // The model escaped its newlines wrong: the fence exists but is not JSON.
  const text = 'ok ```action\n{"actions":[{"service":"github","action":"create_file","params":{"path":"a.js","content":"l1\nl2"}}]}\n``` done';
  assert.equal(parseActions(text).length, 0, 'nothing is executed from a malformed block');
});

test('parseActions caps the number of operations per turn', () => {
  const many = { actions: Array.from({ length: 12 }, () => ({ service: 'github', action: 'read_file', params: { path: 'a' } })) };
  assert.ok(parseActions(`\`\`\`action\n${JSON.stringify(many)}\n\`\`\``).length <= 4);
});

test('stripActionBlocks returns only the prose answer', () => {
  const text = 'دارم فایل را می‌سازم.\n```action\n{"service":"github","action":"create_file","params":{"path":"a"}}\n```\nبعد نتیجه را می‌گویم.';
  assert.equal(stripActionBlocks(text), 'دارم فایل را می‌سازم.\n\nبعد نتیجه را می‌گویم.');
});

test('toTurns merges consecutive roles and never starts with the model', () => {
  const turns = toTurns([
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'one' },
    { role: 'user', content: 'two' },
    { role: 'assistant', content: 'reply' },
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, 'one\n\ntwo');
  assert.equal(turns[1].role, 'model');
});

test('describeAction is human readable', () => {
  const label = describeAction({ service: 'github', action: 'create_file', params: { repo: 'acme/site', path: 'src/a.js' } });
  assert.match(label, /acme\/site/);
  assert.match(label, /src\/a\.js/);
});

// ── security ────────────────────────────────────────────────────────────────

test('redactSecrets masks token shapes', () => {
  const text = 'token ghp_abcdefghijklmnopqrstuvwxyz0123 and glpat-abcdefghijklmnop and AIza' + 'a'.repeat(35);
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes('ghp_'));
  assert.ok(!redacted.includes('glpat-'));
  assert.ok(!redacted.includes('AIza'));
  assert.match(redacted, /\[REDACTED\]/);
});

test('redactSecrets hides the configured private key', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEsecret\n-----END PRIVATE KEY-----';
  assert.ok(!redactSecrets(`key: ${pem}`).includes('MIIEsecret'));
});

test('allowlist: empty means everyone, a list is enforced', () => {
  assert.equal(isUserAllowed(1), true);
  const original = settings.allowedUserIds;
  settings.allowedUserIds = [999];
  try {
    assert.equal(isUserAllowed(999), true);
    assert.equal(isUserAllowed(1), false);
    assert.equal(isUserAllowed(undefined), false);
  } finally {
    settings.allowedUserIds = original;
  }
});

test('integrationStatus only reports booleans', () => {
  const status = integrationStatus();
  for (const key of ['gemini', 'github', 'gitlab', 'gdrive']) {
    assert.equal(typeof status[key], 'boolean');
  }
});

test('resolveRepo accepts owner/name and rejects junk', () => {
  assert.deepEqual(resolveRepo('https://github.com/acme/site.git'), { owner: 'acme', repo: 'site', fullName: 'acme/site' });
  assert.throws(() => resolveRepo('site'), /نام مخزن نامعتبر/);
});

/** A real (throwaway) RSA key, so the JWT path is exercised end to end. */
async function throwawayKey() {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey;
}

// ── persistence ─────────────────────────────────────────────────────────────

test('conversation rows are stored and read back in order', async () => {
  __resetDatabase();
  const chat = await ensureChat({ userId: 7, chatId: 7, title: 'first message' });
  assert.equal(chat.userId, 7);

  const same = await ensureChat({ userId: 7, chatId: 7 });
  assert.equal(same.id, chat.id);

  await addMessage({ userId: 7, chatRef: chat.id, role: 'user', content: 'سلام' });
  await addMessage({ userId: 7, chatRef: chat.id, role: 'assistant', content: 'درود' });

  const recent = await recentMessages({ userId: 7, chatRef: chat.id });
  assert.deepEqual(recent.map((row) => row.content), ['سلام', 'درود']);

  const page = await historyPage({ userId: 7, chatRef: chat.id, limit: 1 });
  assert.equal(page.length, 1);
  assert.equal(page[0].content, 'درود');
  assert.ok(page[0].createdAt);

  const before = await historyPage({ userId: 7, chatRef: chat.id, limit: 5, before: page[0].id });
  assert.deepEqual(before.map((m) => m.content), ['سلام']);

  await clearHistory({ userId: 7 });
  assert.equal((await recentMessages({ userId: 7, chatRef: chat.id })).length, 0);
});

// ── approvals ───────────────────────────────────────────────────────────────

test('destructive actions need approval and tokens are single use', async () => {
  __resetDatabase();
  mockHttp([{ match: 'api.github.com', reply: { ok: true } }]);

  assert.equal(needsApproval({ service: 'github', action: 'delete_file' }), true);
  assert.equal(needsApproval({ service: 'github', action: 'read_file' }), false);
  assert.equal(needsApproval({ service: 'gdrive', action: 'trash_file' }), true);

  const action = { service: 'gdrive', action: 'trash_file', params: { fileId: 'abc' } };
  const approval = await createApproval({ userId: 11, action, reason: 'test' });
  assert.match(approval.token, /^apr_/);
  assert.equal((await pendingApprovals({ userId: 11 })).length, 1);

  // Someone else's token is rejected.
  await assert.rejects(() => approve({ token: approval.token, userId: 12 }), /پیدا نشد|منقضی/);

  // A service account is required for Drive; give the test a throwaway RSA key.
  const originalAccount = settings.googleServiceAccount;
  settings.googleServiceAccount = {
    client_email: 'test@example.iam.gserviceaccount.com',
    private_key: await throwawayKey(),
    token_uri: 'https://oauth2.googleapis.com/token',
  };
  const routes = mockHttp([
    { match: 'oauth2.googleapis.com/token', method: 'POST', reply: { access_token: 'ya29.fake', expires_in: 3600 } },
    { match: 'googleapis.com/drive/v3/files/abc', reply: { id: 'abc', name: 'x', trashed: true } },
  ]);
  try {
    const result = await approve({ token: approval.token, userId: 11 });
    assert.equal(result.outcome.ok, true, result.outcome.error);
    assert.equal(result.outcome.data.trashed, true);
    assert.ok(routes.some((call) => call.method === 'PATCH'));
    const tokenCall = routes.find((call) => call.url.includes('oauth2'));
    assert.match(tokenCall.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
    assert.ok(!tokenCall.body.includes('PRIVATE KEY'));
  } finally {
    settings.googleServiceAccount = originalAccount;
  }

  // Replaying the same token fails.
  await assert.rejects(() => approve({ token: approval.token, userId: 11 }), /پیدا نشد|استفاده/);
  assert.equal((await pendingApprovals({ userId: 11 })).length, 0);
});

test('unknown actions never execute', async () => {
  const outcome = await runAction({ service: 'github', action: 'rm_rf', params: {} }, { userId: 1 });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /ناشناخته/);
});

// ── endpoints ───────────────────────────────────────────────────────────────

test('agent endpoint rejects anonymous and empty requests', async () => {
  await assert.rejects(() => agentEndpoint({ prompt: 'hi' }, { initData: {} }), /تلگرام/);
  await assert.rejects(() => agentEndpoint({ prompt: '   ' }, ctxFor()), /خالی/);
});

test('agent endpoint reports a missing API key instead of crashing', async () => {
  __resetDatabase();
  if (settings.geminiApiKey || settings.xaiApiKey || settings.deepseekApiKey) return; // a real key is configured in this checkout
  await assert.rejects(() => agentEndpoint({ prompt: 'سلام' }, ctxFor()), (err) => {
    assert.equal(err.code, 'AI_NOT_CONFIGURED');
    return true;
  });
});

test('getHistory returns this user\'s messages only', async () => {
  __resetDatabase();
  const chat = await ensureChat({ userId: USER.id });
  await addMessage({ userId: USER.id, chatRef: chat.id, role: 'user', content: 'mine' });
  const other = await ensureChat({ userId: 999 });
  await addMessage({ userId: 999, chatRef: other.id, role: 'user', content: 'not mine' });

  const result = await getHistory({ limit: 10 }, ctxFor());
  assert.deepEqual(result.messages.map((m) => m.content), ['mine']);
  assert.equal(result.user.username, 'ali');
});

test('clearHistory demands confirmation', async () => {
  __resetDatabase();
  await ensureChat({ userId: USER.id });
  await assert.rejects(() => clearHistoryEndpoint({}, ctxFor()), /تأیید/);
  const result = await clearHistoryEndpoint({ confirm: true }, ctxFor());
  assert.equal(result.cleared, true);
});

// ── handlers ────────────────────────────────────────────────────────────────

test('/start sends a welcome with an inline button', async () => {
  __resetDatabase();
  sentMessages.length = 0;
  await messageHandler({ chat: { id: USER.id }, from: USER, text: '/start' });
  const message = sentMessages.find((call) => call.method === 'sendMessage');
  assert.ok(message, 'a message was sent');
  assert.match(message.params.text, /TERMINAL-AI/);
  assert.ok(message.params.reply_markup);
});

test('/status lists integrations as plain text', async () => {
  __resetDatabase();
  sentMessages.length = 0;
  await messageHandler({ chat: { id: USER.id }, from: USER, text: '/status' });
  const message = sentMessages.find((call) => call.method === 'sendMessage');
  assert.match(message.params.text, /GitHub/);
  assert.match(message.params.text, /GitLab/);
  assert.doesNotMatch(message.params.text, /glpat-/);
});

test('callback queries are always answered', async () => {
  sentMessages.length = 0;
  await callbackHandler({ id: 'cb1', from: USER, data: 'status', message: { chat: { id: USER.id }, message_id: 5 } });
  assert.ok(sentMessages.some((call) => call.method === 'answerCallbackQuery'));
});

test('callback from a forbidden user gets an alert, not an action', async () => {
  sentMessages.length = 0;
  const original = settings.allowedUserIds;
  settings.allowedUserIds = [777];
  try {
    await callbackHandler({ id: 'cb2', from: USER, data: 'clear_yes', message: { chat: { id: USER.id }, message_id: 5 } });
    const answer = sentMessages.find((call) => call.method === 'answerCallbackQuery');
    assert.equal(answer.params.show_alert, true);
    assert.ok(!sentMessages.some((call) => call.method === 'editMessageReplyMarkup'));
  } finally {
    settings.allowedUserIds = original;
  }
});

// ── agent loop with a stubbed model ─────────────────────────────────────────

test('runAgent executes requested actions and records them', async () => {
  __resetDatabase();
  const originalKey = settings.geminiApiKey;
  settings.geminiApiKey = 'test-key';
  try {
    let turn = 0;
    __setFetchMock(async (url, init = {}) => {
      if (String(url).includes('generativelanguage')) {
        turn += 1;
        const body =
          turn === 1
            ? {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text:
                            'در حال ساخت فایل.\n```action\n{"service":"gdrive","action":"create_folder","params":{"name":"demo"}}\n```',
                        },
                      ],
                    },
                    finishReason: 'STOP',
                  },
                ],
                usageMetadata: { totalTokenCount: 42 },
                modelVersion: 'gemini-test',
              }
            : {
                candidates: [{ content: { parts: [{ text: 'پوشه «demo» ساخته شد ✅' }] }, finishReason: 'STOP' }],
                usageMetadata: { totalTokenCount: 55 },
                modelVersion: 'gemini-test',
              };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (String(url).includes('oauth2') || String(url).includes('token')) {
        return new Response(JSON.stringify({ access_token: 'fake', expires_in: 3600 }), { status: 200 });
      }
      if (String(url).includes('googleapis.com/drive/v3/files')) {
        return new Response(JSON.stringify({ id: 'folder-1', name: 'demo', webViewLink: 'https://drive/x' }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    });

    // No service account configured → the Drive call fails cleanly, the turn survives.
    const originalAccount = settings.googleServiceAccount;
    settings.googleServiceAccount = null;

    const result = await runAgent({ userId: 77, history: [], prompt: 'یک پوشه بساز' });
    assert.match(result.reply, /demo/);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].service, 'gdrive');
    // No service account configured → the action fails cleanly, the turn survives.
    assert.equal(result.actions[0].ok, false);
    assert.match(result.actions[0].error, /GOOGLE_SERVICE_ACCOUNT/);
    settings.googleServiceAccount = originalAccount;
  } finally {
    settings.geminiApiKey = originalKey;
    __setFetchMock(null);
  }
});

test('a GitHub write is executed against the REST API with the token in a header', async () => {
  const originalToken = settings.githubToken;
  settings.githubToken = 'ghp_testtokenvalue000000000000000000';
  try {
    const calls = mockHttp([
      // The file does not exist yet: the GET probe 404s, the PUT creates it.
      { match: '/contents/', method: 'GET', status: 404, reply: { message: 'Not Found' } },
      { match: '/contents/', method: 'PUT', reply: { content: { path: 'a.txt', html_url: 'https://github.com/x' }, commit: { sha: 'deadbeef' } } },
    ]);
    const outcome = await runAction(
      { service: 'github', action: 'create_file', params: { repo: 'acme/site', path: 'a.txt', content: 'سلام' } },
      { userId: 5 }
    );
    assert.equal(outcome.ok, true, outcome.error);
    const put = calls.find((call) => call.method === 'PUT');
    assert.ok(put, 'a PUT was issued');
    assert.equal(put.headers.Authorization, `Bearer ${settings.githubToken}`);
    assert.ok(!put.url.includes(settings.githubToken), 'token never appears in the URL');
    const body = JSON.parse(put.body);
    assert.equal(base64ToUtf8(body.content), 'سلام');
  } finally {
    settings.githubToken = originalToken;
    __setFetchMock(null);
  }
});

test('provider errors are translated, not leaked', async () => {
  const originalToken = settings.githubToken;
  settings.githubToken = 'ghp_testtokenvalue000000000000000000';
  try {
    mockHttp([{ match: 'api.github.com', status: 401, reply: { message: 'Bad credentials' } }]);
    const outcome = await runAction({ service: 'github', action: 'get_repo', params: { repo: 'acme/site' } }, { userId: 5 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /401/);
    assert.ok(!outcome.error.includes(settings.githubToken));
  } finally {
    settings.githubToken = originalToken;
    __setFetchMock(null);
  }
});


// ── provider failover ───────────────────────────────────────────────────────

/** Run `fn` with temporary AI settings; always restores the checkout's values. */
async function withAi(overrides, fn) {
  const saved = {
    geminiApiKey: settings.geminiApiKey,
    xaiApiKey: settings.xaiApiKey,
    deepseekApiKey: settings.deepseekApiKey,
    aiFallbackOrder: settings.aiFallbackOrder,
    aiTimeoutMs: settings.aiTimeoutMs,
  };
  Object.assign(settings, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(settings, saved);
  }
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('failover: a 429 from Gemini is answered by Grok', async () => {
  await withAi(
    { geminiApiKey: 'gemini-key', xaiApiKey: 'xai-key', deepseekApiKey: '', aiFallbackOrder: ['gemini', 'grok', 'deepseek'] },
    async () => {
      const calls = [];
      __setFetchMock(async (url, init = {}) => {
        calls.push({ url: String(url), body: JSON.parse(init.body || '{}'), headers: init.headers || {} });
        if (String(url).includes('generativelanguage')) {
          return jsonResponse({ error: { code: 429, message: 'Quota exceeded' } }, 429);
        }
        return jsonResponse({
          model: 'grok-test',
          choices: [{ message: { role: 'assistant', content: 'سلام از Grok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
        });
      });

      try {
        const result = await generateWithFallback([{ role: 'user', content: 'سلام' }], 'SYS');
        assert.equal(result.provider, 'grok');
        assert.equal(result.providerLabel, 'Grok');
        assert.equal(result.text, 'سلام از Grok');
        assert.equal(result.usage.totalTokenCount, 8, 'OpenAI usage is normalised for the UI');
        assert.deepEqual(result.attempts.map((a) => [a.provider, a.kind]), [
          ['gemini', 'rate_limit'],
          ['grok', 'ok'],
        ]);

        // The OpenAI-compatible request shape: Bearer auth, system first.
        const grok = calls.find((call) => call.url.includes('api.x.ai'));
        assert.equal(grok.url, 'https://api.x.ai/v1/chat/completions');
        assert.equal(grok.headers.Authorization, 'Bearer xai-key');
        assert.equal(grok.body.messages[0].role, 'system');
        assert.equal(grok.body.messages[0].content, 'SYS');
        assert.equal(grok.body.model, settings.xaiModel);
        // Keys never travel in a URL.
        assert.ok(!calls.some((call) => call.url.includes('xai-key') || call.url.includes('gemini-key')));
        // Gemini is called with a header, not a query string.
        const gemini = calls.find((call) => call.url.includes('generativelanguage'));
        assert.equal(gemini.headers['x-goog-api-key'], 'gemini-key');
        assert.match(gemini.url, /:generateContent$/);
      } finally {
        __setFetchMock(null);
      }
    }
  );
});

test('failover: a 403 and a 5xx both fall through to the next provider', async () => {
  await withAi(
    { geminiApiKey: 'g', xaiApiKey: 'x', deepseekApiKey: 'd', aiFallbackOrder: ['gemini', 'grok', 'deepseek'] },
    async () => {
      __setFetchMock(async (url) => {
        if (String(url).includes('generativelanguage')) return jsonResponse({ error: { message: 'quota' } }, 403);
        if (String(url).includes('api.x.ai')) return jsonResponse({ error: { message: 'down' } }, 503);
        return jsonResponse({ choices: [{ message: { content: 'پاسخ از DeepSeek' }, finish_reason: 'stop' }], model: 'deepseek-chat' });
      });
      try {
        const result = await generateWithFallback([{ role: 'user', content: 'hi' }]);
        assert.equal(result.provider, 'deepseek');
        assert.deepEqual(result.attempts.map((a) => a.kind), ['forbidden', 'server', 'ok']);
      } finally {
        __setFetchMock(null);
      }
    }
  );
});

test('prompt adapters build the documented request shapes', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: 'ok' },
  ];

  const gemini = toGeminiRequest(messages, 'SYS', { model: 'gemini-3.5-flash', apiKey: 'k' });
  assert.match(gemini.url, /\/models\/gemini-3\.5-flash:generateContent$/);
  assert.equal(gemini.headers['x-goog-api-key'], 'k');
  assert.deepEqual(gemini.body.contents.map((c) => c.role), ['user', 'model']);
  assert.deepEqual(gemini.body.contents[0].parts, [{ text: 'hi\n\nagain' }]);
  assert.equal(gemini.body.systemInstruction.parts[0].text, 'SYS\n\nsys');
  assert.equal(gemini.body.generationConfig.thinkingConfig.thinkingBudget, 0);

  const openai = toOpenAIRequest(messages, 'SYS', {
    model: 'deepseek-chat',
    apiKey: 'd',
    baseUrl: 'https://api.deepseek.com',
  });
  assert.equal(openai.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(openai.headers.Authorization, 'Bearer d');
  assert.deepEqual(openai.body.messages.map((m) => m.role), ['system', 'user', 'assistant']);
  assert.equal(openai.body.messages[0].content, 'SYS\n\nsys');
  assert.equal(openai.body.max_tokens, settings.aiMaxOutputTokens);
  assert.equal(openai.body.stream, false);
});

test('all providers failing produces one comprehensive, redacted error', async () => {
  await withAi(
    { geminiApiKey: 'g', xaiApiKey: 'x', deepseekApiKey: 'd', aiFallbackOrder: ['gemini', 'grok', 'deepseek'] },
    async () => {
      __setFetchMock(async (url) => {
        if (String(url).includes('generativelanguage')) return jsonResponse({ error: { message: 'boom' } }, 500);
        if (String(url).includes('api.x.ai')) {
          return jsonResponse({ error: { message: 'bad key sk-abcdefghijklmnopqrstuvwxyz012345' } }, 401);
        }
        return jsonResponse({ error: { message: 'slow down' } }, 429);
      });
      try {
        await assert.rejects(
          () => generateWithFallback([{ role: 'user', content: 'hi' }]),
          (err) => {
            assert.equal(err.name, 'AiError');
            assert.match(err.message, /Gemini/);
            assert.match(err.message, /Grok/);
            assert.match(err.message, /DeepSeek/);
            assert.match(err.message, /500/);
            assert.match(err.message, /429/);
            assert.ok(!err.message.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), 'provider key is redacted');
            assert.equal(err.attempts.length, 3);
            return true;
          }
        );
      } finally {
        __setFetchMock(null);
      }
    }
  );
});

test('a hanging provider is abandoned at its deadline and the next one answers', async () => {
  await withAi(
    { geminiApiKey: 'g', xaiApiKey: 'x', deepseekApiKey: '', aiFallbackOrder: ['gemini', 'grok'], aiTimeoutMs: 1000 },
    async () => {
      __setFetchMock(async (url) => {
        if (String(url).includes('generativelanguage')) return new Promise(() => {}); // never resolves
        return jsonResponse({ choices: [{ message: { content: 'از Grok' }, finish_reason: 'stop' }] });
      });
      try {
        const started = Date.now();
        const result = await generateWithFallback([{ role: 'user', content: 'hi' }], '', { timeoutMs: 1000 });
        assert.equal(result.provider, 'grok');
        assert.equal(result.attempts[0].kind, 'timeout');
        assert.ok(Date.now() - started < 5000, 'the chain did not wait for the hanging provider');
      } finally {
        __setFetchMock(null);
      }
    }
  );
});

test('an empty answer is treated as a failure, a missing key as a skip', async () => {
  await withAi(
    { geminiApiKey: 'g', xaiApiKey: '', deepseekApiKey: 'd', aiFallbackOrder: ['gemini', 'grok', 'deepseek'] },
    async () => {
      __setFetchMock(async (url) => {
        if (String(url).includes('generativelanguage')) {
          return jsonResponse({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }] });
        }
        return jsonResponse({ choices: [{ message: { content: 'از DeepSeek' }, finish_reason: 'stop' }] });
      });
      try {
        const result = await generateWithFallback([{ role: 'user', content: 'hi' }]);
        assert.equal(result.provider, 'deepseek');
        assert.equal(result.attempts[0].kind, 'empty');
        assert.equal(result.attempts[1].skipped, true, 'a provider without a key is skipped, not failed');
      } finally {
        __setFetchMock(null);
      }
    }
  );
});

test('summariseAttempts paints active / failed / skipped badges in order', async () => {
  await withAi(
    { geminiApiKey: 'g', xaiApiKey: 'x', deepseekApiKey: '', aiFallbackOrder: ['gemini', 'grok', 'deepseek'] },
    async () => {
      const providers = summariseAttempts(
        [
          { provider: 'gemini', ok: false, status: 429, kind: 'rate_limit', message: 'quota' },
          { provider: 'grok', ok: true, status: 200, kind: 'ok', message: '' },
        ],
        'grok'
      );
      assert.deepEqual(providers.map((p) => [p.name, p.status]), [
        ['gemini', 'failed'],
        ['grok', 'active'],
        ['deepseek', 'skipped'],
      ]);
      assert.equal(providerCatalog().length, 3);
    }
  );
});

test('the agent endpoint returns the provider that answered', async () => {
  __resetDatabase();
  await withAi(
    { geminiApiKey: 'g', xaiApiKey: 'x', deepseekApiKey: 'd', aiFallbackOrder: ['gemini', 'grok', 'deepseek'] },
    async () => {
      __setFetchMock(async (url) => {
        if (String(url).includes('generativelanguage')) return jsonResponse({ error: { message: 'quota' } }, 429);
        if (String(url).includes('api.x.ai')) return jsonResponse({ error: { message: 'down' } }, 503);
        return jsonResponse({ choices: [{ message: { content: 'پاسخ از DeepSeek ✅' }, finish_reason: 'stop' }], model: 'deepseek-chat' });
      });
      try {
        const result = await agentEndpoint({ prompt: 'سلام' }, ctxFor());
        assert.equal(result.provider, 'deepseek');
        assert.equal(result.providerLabel, 'DeepSeek');
        assert.equal(result.model, 'deepseek-chat');
        assert.equal(result.output, 'پاسخ از DeepSeek ✅');
        assert.deepEqual(result.providers.map((p) => p.status), ['failed', 'failed', 'active']);
      } finally {
        __setFetchMock(null);
      }
    }
  );
});

test('the agent endpoint surfaces the failed chain when every provider fails', async () => {
  __resetDatabase();
  await withAi(
    { geminiApiKey: 'g', xaiApiKey: 'x', deepseekApiKey: 'd', aiFallbackOrder: ['gemini', 'grok', 'deepseek'] },
    async () => {
      __setFetchMock(async () => jsonResponse({ error: { message: 'quota' } }, 429));
      try {
        await assert.rejects(
          () => agentEndpoint({ prompt: 'سلام' }, ctxFor()),
          (err) => {
            assert.equal(err.code, 'AI_ERROR');
            assert.match(err.message, /Gemini/);
            assert.deepEqual(err.parameters.providers.map((p) => p.status), ['failed', 'failed', 'failed']);
            return true;
          }
        );
      } finally {
        __setFetchMock(null);
      }
    }
  );
});
