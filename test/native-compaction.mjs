/**
 * 0.3.6（BUG-012）原生自动压缩线解析作用域单测。
 *
 * 真实事故（Windows 会话 session-1f90f5ee，2026-10-23）：profile 的
 * `compaction-basic` 块里 `config.modelPolicies`（mac-unc / qwen35-unc-64k）写了
 * `thresholdRatio: 0.5`；旧解析只按「下一个顶层 - 条目」截断，把嵌套层里的 0.5
 * 当成这个插件的全局线 → 指示灯误报 50%。
 *
 * 现在只认 `config:` 的直接子键（按缩进判断），更深的嵌套层一律忽略；
 * applyAutoOverride 的写入口径与解析一致（不写进 modelPolicies 等嵌套里）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NATIVE_DEFAULTS,
  applyAutoOverride,
  parseCompactionOverride,
  readNativeCompaction,
} from '../lib/dsh/native-compaction.js';

const linesOf = (...lines) => lines.join('\n');

function tempProfileWith(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcr-native-compaction-'));
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), text, 'utf8');
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * ① config 直属 thresholdRatio 生效
 * ------------------------------------------------------------------ */

const directText = linesOf(
  '- id: compaction-basic',
  "  name: '@deepseek-ai/dsh-compaction-basic'",
  '  config:',
  '    auto: false',
  '    thresholdRatio: 0.7',
  '- id: other',
  '  name: other',
);
assert.deepEqual(parseCompactionOverride(directText), { found: true, autoEnabled: false, thresholdRatio: 0.7 });
{
  const dir = tempProfileWith(directText);
  const current = readNativeCompaction(dir);
  assert.equal(current.autoEnabled, false);
  assert.equal(current.thresholdRatio, 0.7, 'config 直属阈值要生效');
  cleanup(dir);
}

/* ------------------------------------------------------------------ *
 * ② config.modelPolicies 嵌套 thresholdRatio 被忽略（回落默认 0.8）
 * ------------------------------------------------------------------ */

const nestedOnly = linesOf(
  '- id: compaction-basic',
  "  name: '@deepseek-ai/dsh-compaction-basic'",
  '  config:',
  '    auto: true',
  '    modelPolicies:',
  '      mac-unc:',
  '        thresholdRatio: 0.5',
  '      qwen35-unc-64k:',
  '        thresholdRatio: 0.6',
  '- id: other',
  '  name: other',
);
assert.deepEqual(
  parseCompactionOverride(nestedOnly),
  { found: true, autoEnabled: true },
  '嵌套层里的 thresholdRatio 不是插件全局线，不能出现在 override 里',
);
{
  const dir = tempProfileWith(nestedOnly);
  const current = readNativeCompaction(dir);
  assert.equal(current.autoEnabled, true);
  assert.equal(
    current.thresholdRatio,
    NATIVE_DEFAULTS.thresholdRatio,
    '只有嵌套配置时必须回落默认 80%，不能误报成 50%',
  );
  cleanup(dir);
}

/* ------------------------------------------------------------------ *
 * ③ 嵌套 + 直属同时存在：取直属（嵌套忽略）
 * ------------------------------------------------------------------ */

const mixed = linesOf(
  '- id: compaction-basic',
  "  name: '@deepseek-ai/dsh-compaction-basic'",
  '  config:',
  '    auto: true',
  '    thresholdRatio: 0.75',
  '    modelPolicies:',
  '      mac-unc:',
  '        thresholdRatio: 0.5',
  '- id: other',
);
assert.deepEqual(parseCompactionOverride(mixed), { found: true, autoEnabled: true, thresholdRatio: 0.75 });

/* ------------------------------------------------------------------ *
 * ④ 多个嵌套层（map 里套 list 再套 map）也只忽略
 * ------------------------------------------------------------------ */

const deepNested = linesOf(
  '- id: compaction-basic',
  '  config:',
  '    modelPolicies:',
  '      mac-unc:',
  '        limits:',
  '          - thresholdRatio: 0.5',
  '            note: nested-list',
  '        thresholdRatio: 0.4',
  '- id: other',
);
assert.deepEqual(parseCompactionOverride(deepNested), { found: true }, '任意深度的嵌套层都不能被读成全局线');

/* ------------------------------------------------------------------ *
 * ⑤ 无 config / 无该条目
 * ------------------------------------------------------------------ */

const noConfig = linesOf(
  '- id: compaction-basic',
  "  name: '@deepseek-ai/dsh-compaction-basic'",
  '- id: other',
);
assert.deepEqual(parseCompactionOverride(noConfig), { found: true }, '没有 config: 时 found=true 但无覆盖（读侧回落默认）');
assert.deepEqual(parseCompactionOverride('- id: other\n  name: other\n'), { found: false });
assert.deepEqual(parseCompactionOverride(''), { found: false });
assert.deepEqual(parseCompactionOverride('[]\n'), { found: false });
{
  const dir = tempProfileWith(noConfig);
  const current = readNativeCompaction(dir);
  assert.equal(current.autoEnabled, NATIVE_DEFAULTS.autoEnabled);
  assert.equal(current.thresholdRatio, NATIVE_DEFAULTS.thresholdRatio);
  cleanup(dir);
}

/* ------------------------------------------------------------------ *
 * ⑥ CRLF：解析与 apply 都要保持 CRLF
 * ------------------------------------------------------------------ */

const crlfText = directText.replace(/\n/g, '\r\n');
assert.deepEqual(parseCompactionOverride(crlfText), { found: true, autoEnabled: false, thresholdRatio: 0.7 });
{
  const changedCrlf = applyAutoOverride(crlfText, true);
  assert.equal(changedCrlf.includes('\r\n'), true, 'CRLF 文件 apply 后仍是 CRLF');
  assert.equal(/(^|[^\r])\n/.test(changedCrlf), false, '不能混入裸 LF');
  assert.equal(parseCompactionOverride(changedCrlf).autoEnabled, true);
  assert.equal(parseCompactionOverride(changedCrlf).thresholdRatio, 0.7);
}

/* ------------------------------------------------------------------ *
 * ⑦ applyAutoOverride 后 parse 能读回，且不破坏 modelPolicies 嵌套
 * ------------------------------------------------------------------ */

const withNested = linesOf(
  '- id: compaction-basic',
  "  name: '@deepseek-ai/dsh-compaction-basic'",
  '  config:',
  '    auto: true',
  '    thresholdRatio: 0.8',
  '    modelPolicies:',
  '      mac-unc:',
  '        thresholdRatio: 0.5',
  '- id: other',
  '  name: other',
);
{
  const changed = applyAutoOverride(withNested, false);
  assert.match(changed, /auto: false/);
  const parsed = parseCompactionOverride(changed);
  assert.equal(parsed.autoEnabled, false, 'apply 后 parse 要能读回 auto');
  assert.equal(parsed.thresholdRatio, 0.8, 'apply 不能动到直属 thresholdRatio');
  assert.match(changed, /modelPolicies:/);
  assert.match(changed, /mac-unc:/);
  assert.match(changed, /thresholdRatio: 0.5/, '嵌套的 modelPolicies 配置必须原样保留');
  // 再切回 true，仍能读回，且嵌套不变。
  const back = applyAutoOverride(changed, true);
  assert.equal(parseCompactionOverride(back).autoEnabled, true);
  assert.match(back, /thresholdRatio: 0.5/);
}
{
  // 只有嵌套、没有直属 auto：apply 要插到 config 直属子键处，不能插进 modelPolicies。
  const inserted = applyAutoOverride(nestedOnly, false);
  const parsed = parseCompactionOverride(inserted);
  assert.equal(parsed.autoEnabled, false, '插入的 auto 必须是 config 直属子键');
  assert.equal(parsed.thresholdRatio, undefined, '嵌套 thresholdRatio 仍不能被读成全局线');
  assert.match(inserted, /modelPolicies:/);
  assert.match(inserted, /thresholdRatio: 0.5/);
  const dir = tempProfileWith(inserted);
  const current = readNativeCompaction(dir);
  assert.equal(current.autoEnabled, false);
  assert.equal(current.thresholdRatio, NATIVE_DEFAULTS.thresholdRatio);
  cleanup(dir);
}
{
  // 条目存在但没有 config: → apply 补一个 config:，auto 写在直接子键处，parse 能读回。
  const inserted = applyAutoOverride(noConfig, true);
  assert.equal(parseCompactionOverride(inserted).autoEnabled, true);
  assert.match(inserted, /config:/);
  assert.doesNotMatch(inserted, /thresholdRatio:/);
}
{
  // 没有 compaction-basic 条目 → 追加一个完整条目，parse 能读回。
  const appended = applyAutoOverride('- id: other\n  name: other\n', false);
  assert.match(appended, /- id: compaction-basic/);
  assert.equal(parseCompactionOverride(appended).autoEnabled, false);
}
{
  // 多个 compaction-basic 条目：按描述取第一个。
  const twoEntries = linesOf(
    '- id: compaction-basic',
    '  config:',
    '    thresholdRatio: 0.6',
    '- id: compaction-basic',
    '  config:',
    '    thresholdRatio: 0.9',
  );
  assert.deepEqual(parseCompactionOverride(twoEntries), { found: true, thresholdRatio: 0.6 });
  const changed = applyAutoOverride(twoEntries, false);
  assert.equal(parseCompactionOverride(changed).autoEnabled, false);
  assert.equal(parseCompactionOverride(changed).thresholdRatio, 0.6, 'apply 也只改第一个条目');
}

/* ------------------------------------------------------------------ *
 * ⑧ 引号/注释兼容（现有写法不被破坏）
 * ------------------------------------------------------------------ */

const quoted = linesOf(
  '- id: compaction-basic',
  '  config:',
  "    auto: false # 注释",
  "    thresholdRatio: '0.55'  # 引号+注释",
);
assert.deepEqual(parseCompactionOverride(quoted), { found: true, autoEnabled: false, thresholdRatio: 0.55 });

console.log('PASS  0.3.6 原生压缩线解析：config 直属生效 + 嵌套 modelPolicies 忽略（默认 0.8）');
console.log('PASS  0.3.6 原生压缩线解析：嵌套+直属取直属 / 多层嵌套 / 无 config / 无条目 / CRLF / 引号注释');
console.log('PASS  0.3.6 applyAutoOverride：写 config 直接子键 + 保留 modelPolicies + 回读一致');
