import test from 'node:test';
import assert from 'node:assert/strict';

import { __setFetchMock } from 'sdk';
import { executeCode } from '../tgcloud/lib/runner.js';
import agentEndpoint from '../tgcloud/endpoints/agent.js';

const context = { initData: { user: { id: 424242 } } };

test('executeCode calls the Piston Python endpoint through sdk fetch', async () => {
  const calls = [];
  __setFetchMock(async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      language: 'python',
      run: { stdout: '2\n', stderr: '', output: '2\n', code: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  try {
    assert.equal(await executeCode('print(1 + 1)'), '2\n');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://emkc.org/api/v2/piston/execute');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      language: 'python',
      version: '*',
      files: [{ name: 'main.py', content: 'print(1 + 1)' }],
    });
  } finally {
    __setFetchMock(null);
  }
});

test('executeCode validates input and surfaces HTTP failures', async () => {
  await assert.rejects(() => executeCode('   '), /نمی‌تواند خالی/);
  await assert.rejects(() => executeCode('x'.repeat(12001)), /حداکثر/);

  __setFetchMock(async () => new Response('{}', { status: 503 }));
  try {
    await assert.rejects(() => executeCode('print("hello")'), /HTTP 503/);
  } finally {
    __setFetchMock(null);
  }
});

test('agent endpoint accepts execute and returns its result without an AI provider', async () => {
  __setFetchMock(async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.language, 'python');
    assert.equal(body.files[0].content, 'print("telegram")');
    return new Response(JSON.stringify({ run: { output: 'telegram', stdout: 'telegram', stderr: '', code: 0 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  try {
    const result = await agentEndpoint({ action: 'execute', prompt: 'print("telegram")' }, context);
    assert.equal(result.action, 'execute');
    assert.equal(result.language, 'python');
    assert.equal(result.output, 'telegram');
    assert.equal(result.response, 'telegram');
    assert.equal(typeof result.elapsedMs, 'number');
  } finally {
    __setFetchMock(null);
  }
});
