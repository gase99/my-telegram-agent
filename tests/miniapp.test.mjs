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

test('Mini App markdown adds tables, headings, lists and safe links without trusting URLs', () => {
  const ctx = context(false);
  const table = ctx.renderMarkdown('| نام | وضعیت |\n| --- | --- |\n| a.js | ✅ |');
  assert.match(table, /<table class="md-table">/);
  assert.match(table, /<th>نام<\/th>/);
  assert.match(table, /<td>a\.js<\/td>/);

  assert.match(ctx.renderMarkdown('## عنوان'), /class="md-h md-h2"/);
  assert.match(ctx.renderMarkdown('- یک\n1. دو'), /md-dot">•<\/span><span>یک/);
  assert.match(ctx.renderMarkdown('> نقل'), /class="md-quote">نقل/);

  // Only http(s) links become anchors; script/data URLs stay inert text.
  assert.match(ctx.renderMarkdown('[سند](https://example.com/a)'), /href="https:\/\/example\.com\/a"/);
  const unsafe = ctx.renderMarkdown('[x](javascript:alert(1))');
  assert.doesNotMatch(unsafe, /href=/);
  assert.doesNotMatch(ctx.renderMarkdown('<a href="https://x.test" onclick="alert(1)">x</a>'), /<a href|<onclick/);

  // Fenced blocks carry a language badge and a copy button, never raw markup.
  const fenced = ctx.renderMarkdown('```bash\nrm -rf /<script>\n```');
  assert.match(fenced, /class="code-lang">bash</);
  assert.match(fenced, /data-copy-code="1"/);
  assert.doesNotMatch(fenced, /<script>/);
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

test('Mini App ships the modern shell: tabs, live dock, search, settings and toasts', () => {
  for (const id of ['live', 'live-steps', 'live-fill', 'live-elapsed', 'dash-scroll', 'activity-scroll', 'settings-scroll', 'search', 'to-bottom', 'toasts']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} must exist`);
  }
  // Four views, each reachable from a tab, each a panel of its tab.
  for (const view of ['chat', 'dash', 'activity', 'settings']) {
    assert.match(html, new RegExp(`data-view="${view}"`), `${view} tab`);
    assert.match(html, new RegExp(`id="view-${view}"[^>]*role="tabpanel"`), `${view} panel`);
  }
  assert.match(script, /function switchView\(/);
  assert.match(script, /function startLive\(/);
  assert.match(script, /function finishLive\(/);
  assert.match(script, /function applySearch\(/);
  assert.match(script, /function renderDashboard\(/);
  assert.match(script, /function renderActivity\(/);
  assert.match(script, /function renderSettings\(/);
  assert.match(script, /function toast\(/);
  assert.match(script, /setInterval\(tickApprovalCountdowns, 15000\)/);
});

test('Live dock is driven by a timer and never claims server-side progress', () => {
  assert.match(script, /live\.timer = setInterval\(/);
  assert.match(script, /clearInterval\(live\.timer\)/);
  assert.match(script, /clearInterval\(live\.progress\)/);
  // The elapsed clock reads wall time; the stage advance is explicitly an estimate.
  assert.match(script, /\(Date\.now\(\) - live\.startedAt\) \/ 1000/);
  assert.match(html, /#live\.open \{ display: block;/);
  assert.match(script, /panel\.classList\.add\(ok \? 'done' : 'failed'\)/);
});

test('Preferences persist, theme follows Telegram, and reduced motion is honoured', () => {
  assert.match(script, /localStorage\.setItem\('terminal-ai:prefs'/);
  assert.match(script, /tg\?\.colorScheme/);
  assert.match(script, /tg\.onEvent\?\.\('themeChanged'/);
  assert.match(script, /prefs\.haptics/);
  assert.match(script, /tg\?\.HapticFeedback|tg\.HapticFeedback/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(html, /html\[data-motion="off"\]/);
  assert.match(html, /html\[data-compact="on"\]/);
});

test('Copy and reuse read the stored raw message, not innerText', () => {
  assert.match(script, /entry\.__raw = String\(message\.content \|\| ''\)/);
  assert.match(script, /function entryRawText\(/);
  assert.match(script, /copyText\(entryRawText\(/);
  assert.match(script, /fillPrompt\(entryRawText\(/);
  assert.match(script, /document\.execCommand\('copy'\)/);
  assert.match(script, /navigator\.clipboard\?\.writeText/);
});

test('Approval cards count down and are disabled while another decision runs', () => {
  assert.match(script, /function countdownText\(/);
  assert.match(script, /dataset\.expires = item\.expiresAt/);
  assert.match(script, /if \(busy \|\| loading \|\| state\.approveBusy\) return/);
  assert.match(script, /state\.approveBusy = true;/);
  assert.match(script, /refreshPendingBadge\(\)/);
});
