import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../miniapp/index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
// Exercise the actual dependency-free renderer and SDK adapter, not copies.
const helpers = script.slice(script.indexOf('function escapeHtml'), script.indexOf('function notify'));
function context(connected, call) {
  const sandbox = { connected, tg: { Serverless: { call } } };
  vm.createContext(sandbox);
  vm.runInContext(helpers, sandbox);
  return sandbox;
}

test('Mini App escapes untrusted HTML in prose, inline code and fenced code', () => {
  const ctx = context(false);
  for (const text of ['<img src=x onerror=alert(1)>', '`<script>alert(1)</script>`', '```html\n<script>alert(1)</script>```']) {
    const rendered = ctx.renderMarkdown(text);
    assert.doesNotMatch(rendered, /<script|<img|onerror="/);
    assert.match(rendered, /&lt;/);
  }
  assert.match(ctx.renderMarkdown('**سلام** `git status`'), /<strong>سلام<\/strong>/);
  assert.match(ctx.renderMarkdown('```js\nconst x = 1;```'), /<pre class="code"><code>const x = 1;/);
});

test('Mini App SDK adapter passes endpoint name and payload and resolves callback result', async () => {
  const ctx = context(true, (name, input, callback) => {
    assert.equal(name, 'agent');
    assert.equal(input.prompt, 'سلام');
    callback(null, { output: 'پاسخ' });
  });
  assert.equal((await ctx.call('agent', { prompt: 'سلام' })).output, 'پاسخ');
});

test('Mini App SDK adapter preserves endpoint errors and rejects outside Telegram', async () => {
  const error = { message: 'اجازه ندارید', parameters: { code: 'FORBIDDEN' } };
  const ctx = context(true, (_name, _input, callback) => callback(error));
  await assert.rejects(ctx.call('getHistory'), value => value === error);
  await assert.rejects(context(false).call('agent'), /تلگرام/);
});

test('Mini App binds real endpoints, explicit destructive confirmation, and IME-safe input', () => {
  for (const name of ['agent', 'getHistory', 'getStatus', 'approve', 'clearHistory']) {
    assert.ok(script.includes(`call('${name}'`), `${name} must be wired`);
  }
  assert.match(script, /window\.confirm\(/);
  assert.match(script, /call\('clearHistory',\{confirm:true\}\)/);
  assert.match(script, /!event\.isComposing/);
  assert.match(script, /if \(busy \|\| loading/);
  assert.doesNotMatch(html, /onclick=/);
});
