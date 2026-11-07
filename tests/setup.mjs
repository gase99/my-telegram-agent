// Prepares an offline test run:
//   1. links the sdk stub into node_modules so the tgcloud modules can import;
//   2. creates tgcloud/lib/config.js from the template when it is missing —
//      that file is gitignored, so a fresh clone would otherwise fail to import
//      settings.js. An existing (real) config.js is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'tests', 'stubs', 'sdk');
const target = path.join(root, 'node_modules', 'sdk');

const configPath = path.join(root, 'tgcloud', 'lib', 'config.js');
if (!fs.existsSync(configPath)) {
  fs.copyFileSync(path.join(root, 'tgcloud', 'lib', 'config.example.js'), configPath);
  console.log('tgcloud/lib/config.js created from config.example.js (empty keys)');
}

fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
console.log('sdk stub linked →', path.relative(root, target));
