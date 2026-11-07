// Links the sdk stub into node_modules so the tgcloud modules can be imported.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'tests', 'stubs', 'sdk');
const target = path.join(root, 'node_modules', 'sdk');

fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
console.log('sdk stub linked →', path.relative(root, target));
