/**
 * 0.4.2 交接线保命补丁 —— 共享判定 + 服务端保存校验。
 *
 *   node test/handoff-guard.mjs
 *
 * 锁四层：
 *   1. 纯函数 `handoffGuard()` 的口径与边界（−5pp、整数百分位 floor、late/margin、
 *      实际线算不出、autoEnabled=false、limit、非法输入、压缩线冲突）；
 *   2. `lib/actions/settings.js` 的保存校验（带/不带 nativeRatio、兜底 0.4.1 口径、
 *      field 定位、失败不落盘）；
 *   3. 旧设置文件（0.65 已落盘）升级后带 nativeRatio 保存必须被拒（拒绝 + 提示目标值）；
 *   4. 客户端产物：guard 已内联进 lib/client.js、设置页 POST 带 nativeRatio、指示灯有告警文案。
 *
 * 测试用的 profile 目录通过 process.argv 注入（desktop-host 的真实传参方式，
 * 见 dsh/native-compaction.js:resolveProfileDir），全程只写临时目录，不碰 ~/.dsh。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handoffGuard, handoffCapOf, HANDOFF_MARGIN_PP } from '../lib/core/handoff-guard.js';
import { createSettingsStore } from '../lib/actions/settings.js';
import { readNativeCompaction } from '../lib/dsh/native-compaction.js';

/* ------------------------------------------------------------------ *
 * 0. 隔离：临时 profile（控制 autoEnabled / thresholdRatio）
 * ------------------------------------------------------------------ */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-guard-'));
const profileDir = path.join(tmpRoot, 'profile');
fs.mkdirSync(profileDir, { recursive: true });
const patchFile = path.join(profileDir, 'cordis.patch.yml');

/** 写 compaction-basic 配置（内容长度随 auto 变化 → 读缓存 key 必然变化）。 */
function writeProfile({ auto = true, thresholdRatio = 0.8 } = {}) {
  fs.writeFileSync(
    patchFile,
    ['- id: compaction-basic', '  config:', `    auto: ${auto}`, `    thresholdRatio: ${thresholdRatio}`, ''].join('\n'),
    'utf8',
  );
}

writeProfile({ auto: true, thresholdRatio: 0.8 });
// resolveProfileDir 会扫描 argv 里带 cordis.patch.yml 的目录；追加到末尾即可命中。
process.argv.push(profileDir);
assert.equal(readNativeCompaction().autoEnabled, true, '测试 profile 应被识别（autoEnabled=true）');
assert.equal(readNativeCompaction().thresholdRatio, 0.8);

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

/** 取一次 save 抛出的错误（没有抛出就是失败）。 */
function catchError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('期望抛错，但保存成功了');
}

/* ------------------------------------------------------------------ *
 * 1. 纯函数：正常线 / 边界 / late / margin
 * ------------------------------------------------------------------ */

test('0.4.2 guard：deepseek-flash 实际 67.8% → 上限 62%，默认 60% 合规', () => {
  const guard = handoffGuard({ actualRatio: 0.678, configuredRatio: 0.8, handoffRatio: 0.6, compactRatio: 0.4 });
  assert.equal(guard.source, 'actual');
  assert.equal(guard.cap, 0.62);
  assert.equal(guard.capPercent, 62);
  assert.equal(guard.target, 0.62);
  assert.equal(guard.ok, true);
  assert.equal(guard.severity, 'ok');
  assert.equal(guard.reason, 'ok');
  assert.equal(guard.message, '');
  assert.equal(guard.actualPercent, 67.8);
  assert.equal(guard.handoffPercent, 60);
  assert.equal(guard.compactConflict, false);
  // 上限是「参考线 −5pp 后向下取整」：67.8 − 5 = 62.8 → 62（不是四舍五入 63）。
  assert.equal(handoffCapOf(0.678), 0.62);
  assert.equal(HANDOFF_MARGIN_PP, 5);
});

test('0.4.2 guard：边界 62 通过、63 拒绝（warn），拒绝文案带目标值', () => {
  const atCap = handoffGuard({ actualRatio: 0.678, handoffRatio: 0.62, compactRatio: 0.4 });
  assert.equal(atCap.ok, true, '等于上限允许');
  assert.equal(atCap.severity, 'ok');

  const over = handoffGuard({ actualRatio: 0.678, handoffRatio: 0.63, compactRatio: 0.4 });
  assert.equal(over.ok, false);
  assert.equal(over.severity, 'warn');
  assert.equal(over.reason, 'margin');
  assert.ok(over.message.includes('62%'), `文案要给出目标 62%，实际：${over.message}`);
  assert.ok(over.message.includes('67.8%'), `文案要说明实际触发线，实际：${over.message}`);
  assert.ok(over.message.includes('63%'), '文案要说明当前交接线');
  assert.ok(over.message.includes('不足 5 个百分点'), `文案要说明 5pp 余量，实际：${over.message}`);
  assert.equal(over.capPercent, 62);
});

test('0.4.2 guard：65% 在 0.678 下也属 warn（验收 #1 的拒绝值）', () => {
  const guard = handoffGuard({ actualRatio: 0.678, handoffRatio: 0.65, compactRatio: 0.4 });
  assert.equal(guard.ok, false);
  assert.equal(guard.severity, 'warn');
  assert.ok(guard.message.includes('最高可设 62%'));
});

test('0.4.2 guard：等于/高于实际触发线 → late（会在原生压缩之后）', () => {
  const equal = handoffGuard({ actualRatio: 0.678, handoffRatio: 0.678, compactRatio: 0.4 });
  assert.equal(equal.ok, false);
  assert.equal(equal.severity, 'late');
  assert.ok(equal.message.includes('原生压缩之后'));

  const over = handoffGuard({ actualRatio: 0.678, handoffRatio: 0.7, compactRatio: 0.4 });
  assert.equal(over.severity, 'late');
  assert.equal(over.reason, 'late');
  assert.ok(over.message.includes('交接线已晚'));
  assert.ok(over.message.includes('最高可设 62%'));
});

test('0.4.2 guard：模拟低实际线模型（55%）→ 上限 50%，旧 60% 判定为 late、52% 为 warn', () => {
  const guard = handoffGuard({ actualRatio: 0.55, handoffRatio: 0.6, compactRatio: 0.4 });
  assert.equal(guard.cap, 0.5);
  assert.equal(guard.capPercent, 50);
  assert.equal(guard.target, 0.5);
  assert.equal(guard.ok, false);
  // 60% > 实际线 55%：提醒已经晚于原生压缩。
  assert.equal(guard.severity, 'late');
  assert.ok(guard.message.includes('50%'));
  // 52% 在实际线之前、但距原生压缩不足 5pp → warn。
  const margin = handoffGuard({ actualRatio: 0.55, handoffRatio: 0.52, compactRatio: 0.4 });
  assert.equal(margin.severity, 'warn');
  assert.equal(margin.ok, false);
  // 重算到 50% 后合规。
  assert.equal(handoffGuard({ actualRatio: 0.55, handoffRatio: 0.5, compactRatio: 0.4 }).ok, true);
});

test('0.4.2 guard：整数百分位向下取整不因浮点误差少 1（0.62−0.05）', () => {
  assert.equal(handoffCapOf(0.62), 0.57);
  assert.equal(handoffCapOf(0.55), 0.5);
  assert.equal(handoffCapOf(0.678464), 0.62);
  assert.equal(handoffCapOf(0.7), 0.65);
});

/* ------------------------------------------------------------------ *
 * 2. 纯函数：实际线算不出 / 原生关闭 / limit / 非法输入 / 压缩线冲突
 * ------------------------------------------------------------------ */

test('0.4.2 guard：实际线算不出 → 运行时（fallback=none）不告警不阻断', () => {
  const guard = handoffGuard({ actualRatio: null, configuredRatio: 0.8, handoffRatio: 0.7, compactRatio: 0.4 });
  assert.equal(guard.source, null);
  assert.equal(guard.ok, true);
  assert.equal(guard.severity, 'unknown');
  assert.equal(guard.reason, 'no-reference');
  assert.equal(guard.message, '');
  assert.equal(guard.cap, null, '运行时算不出就不给上限（不假装知道）');
});

test('0.4.2 guard：实际线算不出 + 服务端兜底（fallback=configured）→ 配置阈值 −1pp', () => {
  const ok = handoffGuard({ actualRatio: null, configuredRatio: 0.8, handoffRatio: 0.7, compactRatio: 0.4, fallback: 'configured' });
  assert.equal(ok.source, 'configured');
  assert.equal(ok.cap, 0.79);
  assert.equal(ok.ok, true);
  assert.equal(ok.target, null, '没有实际线就不能「按实际线重算」');

  const bad = handoffGuard({ actualRatio: null, configuredRatio: 0.8, handoffRatio: 0.8, compactRatio: 0.4, fallback: 'configured' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'fallback');
  assert.ok(bad.message.includes('79%'), `兜底文案要给出 79%，实际：${bad.message}`);
  assert.ok(bad.message.includes('配置阈值 80%'));
  assert.ok(bad.message.includes('关闭「DSH 原生自动压缩」'));
});

test('0.4.2 guard：autoEnabled=false → 不判定（原生关闭时没有截止线）', () => {
  const guard = handoffGuard({ actualRatio: 0.678, configuredRatio: 0.8, handoffRatio: 0.9, compactRatio: 0.4, autoEnabled: false });
  assert.equal(guard.source, null);
  assert.equal(guard.cap, null);
  assert.equal(guard.ok, true);
  assert.equal(guard.severity, 'unknown');
  assert.equal(guard.message, '');
});

test('0.4.2 guard：limit 夹住过高的上限；参考线太小算不出上限', () => {
  assert.equal(handoffCapOf(0.99), 0.94);
  assert.equal(handoffCapOf(0.99, { limit: 0.8 }), 0.8);
  const capped = handoffGuard({ actualRatio: 0.99, handoffRatio: 0.9, compactRatio: 0.4, limit: 0.8 });
  assert.equal(capped.cap, 0.8);
  assert.equal(capped.ok, false);
  const tiny = handoffGuard({ actualRatio: 0.05, handoffRatio: 0.06, compactRatio: 0.04 });
  assert.equal(tiny.cap, null);
  assert.equal(tiny.reason, 'no-cap');
  assert.equal(tiny.ok, true, '算不出上限时不能阻断');
});

test('0.4.2 guard：非法输入（字符串/NaN/越界）按不可用处理，不抛', () => {
  for (const bad of ['0.678', Number.NaN, Number.POSITIVE_INFINITY, 0, 1, -0.5, null, undefined, {}]) {
    const guard = handoffGuard({ actualRatio: bad, configuredRatio: 0.8, handoffRatio: 0.6, compactRatio: 0.4, fallback: 'configured' });
    assert.equal(guard.source, 'configured', `actualRatio=${String(bad)} 应回落兜底`);
    assert.doesNotThrow(() => handoffGuard({ actualRatio: 0.678, handoffRatio: bad }));
  }
  // 交接线非法 → 不判定（不阻断），也不抛。
  const noHandoff = handoffGuard({ actualRatio: 0.678, handoffRatio: null });
  assert.equal(noHandoff.reason, 'invalid-handoff');
  assert.equal(noHandoff.ok, true);
});

test('0.4.2 guard：重算目标 ≤ 压缩线 → compactConflict + 提示先降压缩线', () => {
  const guard = handoffGuard({ actualRatio: 0.5, handoffRatio: 0.46, compactRatio: 0.45 });
  assert.equal(guard.cap, 0.45);
  assert.equal(guard.compactConflict, true);
  assert.equal(guard.ok, false);
  assert.ok(guard.message.includes('请先把压缩线降到 45% 以下'), `实际：${guard.message}`);
  // 上限高于压缩线时不算冲突。
  assert.equal(handoffGuard({ actualRatio: 0.678, handoffRatio: 0.6, compactRatio: 0.4 }).compactConflict, false);
});

/* ------------------------------------------------------------------ *
 * 3. 服务端保存校验（真实 createSettingsStore + 临时设置文件）
 * ------------------------------------------------------------------ */

function tempStore({ nativeRatio, profile } = {}) {
  if (profile !== undefined) writeProfile(profile);
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'store-'));
  return createSettingsStore({ config: {}, file: path.join(dir, 'compact-relay.json') });
}

function saveHandoff(store, handoffRatio, options) {
  return store.save({ thresholds: { handoffRatio } }, options);
}

test('0.4.2 服务端：带 nativeRatio=0.678 保存 65% → 拒绝并给出 62%，且不落盘', () => {
  const store = tempStore();
  const error = catchError(() => saveHandoff(store, 0.65, { nativeRatio: 0.678 }));
  assert.equal(error.field, 'thresholds.handoffRatio', '错误必须带 field，设置页才能定位');
  assert.ok(error.message.includes('最高可设 62%'), `实际：${error.message}`);
  assert.equal(store.current.thresholds.handoffRatio, 0.6, '被拒后内存配置不变');
  assert.equal(fs.existsSync(store.filePath), false, '被拒后不能落盘');
});

test('0.4.2 服务端：带 nativeRatio 保存 62%（上限）通过、63% 拒绝', () => {
  const store = tempStore();
  const view = saveHandoff(store, 0.62, { nativeRatio: 0.678 });
  assert.equal(view.config.thresholds.handoffRatio, 0.62);
  assert.equal(JSON.parse(fs.readFileSync(store.filePath, 'utf8')).config.thresholds.handoffRatio, 0.62);
  // 同一 store 再保存 63% → 拒绝（现在 0.62 已落盘，被拒不改文件）。
  const error = catchError(() => saveHandoff(store, 0.63, { nativeRatio: 0.678 }));
  assert.ok(error.message.includes('62%'));
  assert.equal(JSON.parse(fs.readFileSync(store.filePath, 'utf8')).config.thresholds.handoffRatio, 0.62);
});

test('0.4.2 服务端：不带 nativeRatio（旧客户端）保存 65% → 维持 0.4.1 兜底，允许', () => {
  const store = tempStore();
  const view = store.save({ thresholds: { handoffRatio: 0.65 } });
  assert.equal(view.config.thresholds.handoffRatio, 0.65);
  // 兜底上限 = 配置阈值 80% −1pp = 79%：0.79 通过、0.80 拒绝。
  const store2 = tempStore();
  assert.equal(store2.save({ thresholds: { handoffRatio: 0.79 } }).config.thresholds.handoffRatio, 0.79);
  const error = catchError(() => store2.save({ thresholds: { handoffRatio: 0.8 } }));
  assert.equal(error.field, 'thresholds.handoffRatio');
  assert.ok(error.message.includes('79%'), `兜底文案要给出 79%，实际：${error.message}`);
});

test('0.4.2 服务端：nativeRatio 非法（字符串/null/越界）→ 退回配置阈值兜底', () => {
  for (const bad of ['0.678', null, 0, 1, Number.NaN]) {
    const store = tempStore();
    const error = catchError(() => saveHandoff(store, 0.85, { nativeRatio: bad }));
    assert.ok(error.message.includes('79%'), `nativeRatio=${String(bad)} 应走兜底 79%，实际：${error.message}`);
    assert.equal(error.message.includes('62%'), false);
  }
});

test('0.4.2 服务端：65% 已落盘（0.4.1 旧文件）→ 带 nativeRatio 再保存被拒；改 62% 后通过', () => {
  const store = tempStore();
  fs.writeFileSync(store.filePath, JSON.stringify({ v: 1, config: { thresholds: { handoffRatio: 0.65 } } }), 'utf8');
  const reloaded = createSettingsStore({ config: {}, file: store.filePath });
  assert.equal(reloaded.current.thresholds.handoffRatio, 0.65, '旧值原样加载（不静默改）');
  const error = catchError(() => saveHandoff(reloaded, 0.65, { nativeRatio: 0.678 }));
  assert.ok(error.message.includes('最高可设 62%'));
  // 注意：保存会重新读旧文件 0.65 再合并 → handoffRatio 仍是 0.65，所以必须显式改成 62。
  const view = saveHandoff(reloaded, 0.62, { nativeRatio: 0.678 });
  assert.equal(view.config.thresholds.handoffRatio, 0.62);
});

test('0.4.2 服务端：模拟低实际线（0.55）→ 60% 被拒、50% 通过；没有压缩线冲突时提示目标值', () => {
  const store = tempStore();
  const error = catchError(() => saveHandoff(store, 0.6, { nativeRatio: 0.55 }));
  assert.ok(error.message.includes('最高可设 50%'), `实际：${error.message}`);
  const view = saveHandoff(store, 0.5, { nativeRatio: 0.55 });
  assert.equal(view.config.thresholds.handoffRatio, 0.5);
});

test('0.4.2 服务端：压缩线冲突（上限 ≤ 压缩线）拒绝并提示先降压缩线', () => {
  const store = tempStore();
  // 先把压缩线设到 45%（45% < 交接线 60% 合法），再用 actual=0.5 → 上限 45% ≤ 压缩线。
  store.save({ thresholds: { compactRatio: 0.45, handoffRatio: 0.6 } });
  const error = catchError(() => saveHandoff(store, 0.46, { nativeRatio: 0.5 }));
  assert.ok(error.message.includes('最高可设 45%'), `实际：${error.message}`);
  assert.ok(error.message.includes('请先把压缩线降到 45% 以下'), `实际：${error.message}`);
});

test('0.4.2 服务端：原生自动压缩关闭 → 不校验（交接线可设 90%）', () => {
  const store = tempStore({ profile: { auto: false } });
  const view = saveHandoff(store, 0.9, { nativeRatio: 0.678 });
  assert.equal(view.config.thresholds.handoffRatio, 0.9);
  // 恢复 profile，避免影响后续用例。
  writeProfile({ auto: true });
});

/* ------------------------------------------------------------------ *
 * 4. 客户端产物 / 源码接线
 * ------------------------------------------------------------------ */

test('0.4.2 客户端：guard 已内联进产物，设置页 POST 带 nativeRatio，指示灯/设置页有告警接线', () => {
  const bundle = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.ok(bundle.includes('handoffGuard'), '构建产物应内联 core/handoff-guard.js');
  assert.ok(bundle.includes('HANDOFF_MARGIN_PP'), '产物应带 5pp 常量');

  const settings = fs.readFileSync(new URL('../lib/client/50-settings.js', import.meta.url), 'utf8');
  assert.ok(settings.includes('nativeRatio'), '设置页保存必须带 nativeRatio（服务端同口径）');
  assert.ok(settings.includes('按实际线重算'), '设置页要有一键重算入口');
  assert.ok(settings.includes('handoffGuard'), '设置页要用共享判定，不许自己算一套');

  const indicator = fs.readFileSync(new URL('../lib/client/30-indicator.js', import.meta.url), 'utf8');
  assert.ok(indicator.includes('handoffGuard'), '指示灯要用共享判定');
  assert.ok(indicator.includes('交接线已晚'), '悬停卡/菜单要有「交接线已晚」告警');
  assert.ok(indicator.includes('data-cr-handoff-warn'), '环上交接刻度旁要有警示标记（不改变分段逻辑）');
});

/* 运行全部用例（异步用例逐个 await；失败即退出非 0）。 */
for (const [name, fn] of cases) {
  try {
    const result = fn();
    if (result !== undefined && typeof result.then === 'function') await result;
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    throw error;
  }
}
