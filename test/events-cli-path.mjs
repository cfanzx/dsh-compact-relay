/** Regression: the CLI test harness must accept OS paths, not URL-encoded pathnames. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcr-cli-path-'));
const copy = path.join(temp, '中文 源码');
fs.mkdirSync(path.join(copy, 'test'), { recursive: true });
for (const dir of ['lib', 'scripts']) fs.cpSync(path.join(source, dir), path.join(copy, dir), { recursive: true });
fs.copyFileSync(path.join(source, 'package.json'), path.join(copy, 'package.json'));
fs.copyFileSync(path.join(source, 'test/events-cli.mjs'), path.join(copy, 'test/events-cli.mjs'));
const result = spawnSync(process.execPath, ['test/events-cli.mjs'], { cwd: copy, encoding: 'utf8', timeout: 30_000 });
assert.equal(result.error, undefined);
assert.equal(result.status, 0, result.stdout + result.stderr);
assert.match(result.stdout, /9\/9 passed/u);
console.log('PASS  CLI harness in an isolated Chinese + space directory (9/9)');
// Keep the isolated reproduction available for inspection; it never contains user sessions.
console.log(`Isolated fixture: ${copy}`);
