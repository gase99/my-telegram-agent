// tests/project.test.mjs — whole-project smoke and Mini App regression checks.
// These tests stay offline and use only Node built-ins (never runtime tgcloud code).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chainFor } from '../tgcloud/lib/ai.js';
import { configuredProviders, settings } from '../tgcloud/lib/settings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(root, 'tgcloud');

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

const runtimeFiles = walk(runtimeRoot)
  .filter((file) => file.endsWith('.js') && !file.endsWith(`${path.sep}config.js`))
  .sort();
const relative = (file) => path.relative(root, file).split(path.sep).join('/');

// Loading (not merely regex-scanning) every module catches broken syntax,
// missing relative .js imports, missing sdk exports and top-level exceptions.
test('every tgcloud runtime module loads with the offline SDK stub', async (t) => {
  assert.ok(runtimeFiles.length >= 20, 'the runtime inventory itself is present');
  for (const file of runtimeFiles) {
    await t.test(relative(file), async () => {
      const module = await import(pathToFileURL(file).href);
      assert.ok(module && typeof module === 'object');
    });
  }
});

test('tgcloud runtime uses only sdk and relative modules, never npm or Node built-ins', () => {
  for (const file of runtimeFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const specifiers = [];
    const staticImport = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
    const dynamicImport = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const pattern of [staticImport, dynamicImport]) {
      for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
    }
    for (const specifier of specifiers) {
      assert.ok(
        specifier === 'sdk' || specifier.startsWith('sdk/') || specifier.startsWith('.'),
        `${relative(file)} has forbidden runtime import: ${specifier}`
      );
    }
    assert.doesNotMatch(source, /\brequire\s*\(/, `${relative(file)} uses CommonJS require`);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, 'there are no production npm dependencies');
});

test('chainFor and configuredProviders both append an omitted keyed provider', () => {
  const saved = {
    geminiApiKey: settings.geminiApiKey,
    xaiApiKey: settings.xaiApiKey,
    deepseekApiKey: settings.deepseekApiKey,
    moonshotApiKey: settings.moonshotApiKey,
    aiFallbackOrder: settings.aiFallbackOrder,
  };
  Object.assign(settings, {
    geminiApiKey: 'gemini-test',
    xaiApiKey: '',
    deepseekApiKey: '',
    moonshotApiKey: 'moonshot-test',
    aiFallbackOrder: ['gemini'],
  });
  try {
    assert.deepEqual(chainFor(), ['gemini', 'kimi']);
    assert.deepEqual(configuredProviders(), ['gemini', 'kimi']);
    assert.deepEqual(chainFor(['kimi', 'gemini']), ['kimi', 'gemini'], 'an explicit position wins');
  } finally {
    Object.assign(settings, saved);
  }
});

test('Kimi configuration template and settings defaults stay aligned', () => {
  const template = fs.readFileSync(path.join(runtimeRoot, 'lib', 'config.example.js'), 'utf8');
  assert.match(template, /export const MOONSHOT_API_KEY = '';/);
  assert.match(template, /export const KIMI_MODEL = 'kimi-k2\.6';/);
  assert.match(template, /export const KIMI_BASE_URL = 'https:\/\/api\.moonshot\.ai\/v1';/);
  assert.equal(settings.kimiModel, 'kimi-k2.6');
  assert.equal(settings.kimiBaseUrl, 'https://api.moonshot.ai/v1');

  const source = fs.readFileSync(path.join(runtimeRoot, 'lib', 'settings.js'), 'utf8');
  assert.match(
    source,
    /str\(config\.MOONSHOT_API_KEY\) \|\| str\(config\.KIMI_API_KEY\)/,
    'an empty MOONSHOT_API_KEY must not mask KIMI_API_KEY'
  );
});

const html = fs.readFileSync(path.join(root, 'miniapp', 'index.html'), 'utf8');

test('Mini App inline JavaScript parses and all element ids are unique', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/i.test(match[1]));
  assert.ok(scripts.length > 0, 'the application script exists');
  for (const [, , source] of scripts) new vm.Script(source, { filename: 'miniapp/index.html:inline-script' });

  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate HTML ids make badge/splash updates ambiguous');
  assert.ok(ids.includes('terminal') && ids.includes('input') && ids.includes('splash'));
  assert.doesNotMatch(html, /(?:localhost|127\.0\.0\.1)/i, 'Mini App must use Telegram endpoint names');
});

test('Splash Screen has the requested content, theme, animation and 3-second dismissal', () => {
  const splash = html.slice(html.indexOf('<div class="splash"'), html.indexOf('<header>'));
  assert.ok(splash.length > 0);
  assert.match(html, /\.splash\s*\{[\s\S]*?z-index:\s*9999;/);
  assert.match(html, /\.splash\s*\{[\s\S]*?background:\s*#0d1117;/);
  assert.match(splash, /به دستیار برنامه‌نویسی هوشمند خوش آمدید 👋/);
  assert.match(splash, /در حال راه‌اندازی هسته هوش مصنوعی\.\.\./);
  assert.match(splash, /class="splash-star"/);
  assert.match(splash, /class="splash-progress-fill"/);

  const models = ['Gemini', 'ChatGPT', 'Claude', 'DeepSeek', 'Grok', 'Kimi'];
  let previous = -1;
  for (const model of models) {
    const index = splash.indexOf(`>${model}<`);
    assert.ok(index > previous, `${model} appears once in the requested sequence`);
    previous = index;
  }
  assert.equal((splash.match(/class="splash-separator"/g) || []).length, 5, 'five bullets separate six models');
  assert.match(html, /animation:\s*splashProgress 3s\s/);
  assert.match(html, /setTimeout\(dismissSplash, 3000\)/);
  assert.match(html, /splash\.classList\.add\('is-leaving'\)/);
  assert.match(html, /setTimeout\(removeSplash, 700\)/, 'removal also works without transitionend');
});

test('Mini App keeps Telegram chrome, keyboard and LTR code regressions covered', () => {
  assert.match(html, /env\(safe-area-inset-top,\s*0px\)/);
  assert.match(html, /env\(safe-area-inset-bottom,\s*0px\)/);
  assert.match(html, /var\(--tg-content-safe-area-inset-top,\s*0px\)/);
  assert.match(html, /height:\s*100dvh;/);
  assert.match(html, /body\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/);
  assert.match(html, /footer\s*\{[\s\S]*?var\(--safe-bottom\)/);
  assert.match(html, /visualViewport\?\.addEventListener\('resize', syncViewport/);
  assert.match(html, /pre\.code\s*\{[\s\S]*?direction:\s*ltr;[\s\S]*?text-align:\s*left;/);
  assert.match(html, /pre\.code code\s*\{[\s\S]*?direction:\s*ltr;[\s\S]*?text-align:\s*left;/);
  assert.match(html, /\.entry-body \.inline-code\s*\{[\s\S]*?direction:\s*ltr;[\s\S]*?unicode-bidi:\s*isolate;/);
});

test('Kimi badge and green/red provider verdict rendering remain wired', () => {
  assert.match(html, /data-model="kimi"[^>]*>[\s\S]*?🌙 Kimi/);
  assert.match(html, /kimi:\s*\{\s*icon:\s*'🌙',\s*name:\s*'Kimi'\s*\}/);
  assert.match(html, /item\.status === 'active'\) setModelBadge\(item\.name, 'active'/);
  assert.match(html, /item\.status === 'failed'\) setModelBadge\(item\.name, 'failed'/);
  assert.match(html, /\.badge\.model\.active\s*\{[\s\S]*?color:\s*var\(--green\)/);
  assert.match(html, /\.badge\.model\.failed\s*\{[\s\S]*?color:\s*var\(--red\)/);
});

test('tgcloud serves the single static Mini App without a build step', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tgcloud.jsonc'), 'utf8'));
  assert.equal(manifest.static, 'miniapp');
  assert.ok(fs.existsSync(path.join(root, manifest.static, 'index.html')));
});
