/**
 * 0.5.6 Phase A：dcr-debug CLI 读侧行为（喂假文件，不起宿主）。
 *
 *   node test/events-cli.mjs
 *
 * 覆盖（总计划 Phase A 验收 7–8）：
 *   - `events` 行数/列/时间原样、`--action` / `--outcome` / `--json` / `--last`；
 *   - `failures` 只出 fail/cancelled，busy/changed 不算失败；
 *   - `show <8 位>` 命中 start/end 两阶段，未知 id 友好 + 退出 0；
 *   - 缺文件 / 坏行文件不崩，未知参数退出 2；
 *   - `state` 读快照；非本机 `--url` 拒绝（退出 2）；
 *   - `export` 片段齐全、脱敏（无绝对路径/sessionId 遮蔽）、内嵌 JSON 可解析、不覆盖已有文件；
 *   - 客户端静态守卫：toast 复制按钮 + 3 处 POST 带 trigger + bundle 已重建。
 *
 * 全程 `os.tmpdir()` + `DSH_HOME`，不碰真实 ~/.dsh（DEVELOPMENT.md 跨平台要求）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = new URL('../scripts/dcr-debug.mjs', import.meta.url).pathname;

function tmpDir(prefix = 'dcr-cli-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function row(overrides) {
  return {
    schema: 'dcr-event/v1',
    id: 'evt-20261030T150000-00000000',
    phase: 'end',
    at: '2026-10-30T15:00:00+08:00',
    action: 'compact',
    trigger: 'ui-menu',
    actor: 'user',
    outcome: 'ok',
    sessionId: 'session-8b0fbefe-1111-2222',
    compactionId: null,
    planId: null,
    childId: null,
    durationMs: 1000,
    code: null,
    message: null,
    context: null,
    v: '0.5.6',
    ...overrides,
  };
}

/** 装一份包含 ok / fail / cancelled / start-only / 坏行的夹具。 */
function makeFixture() {
  const home = tmpDir();
  const file = path.join(home, 'compact-relay-events.jsonl');
  const records = [
    row({
      id: 'evt-20261030T150000-aaaaaaaa',
      phase: 'start',
      at: '2026-10-30T15:00:00+08:00',
      action: 'compact',
      outcome: null,
      durationMs: null,
      context: { tokens: 400000 },
    }),
    row({
      id: 'evt-20261030T150000-aaaaaaaa',
      at: '2026-10-30T15:00:12+08:00',
      durationMs: 12000,
      compactionId: 'c-1234',
      context: { startSeq: 3, endSeq: 9 },
    }),
    row({
      id: 'evt-20261030T154000-bbbbbbbb',
      phase: 'start',
      at: '2026-10-30T15:40:00+08:00',
      action: 'handoff-preview',
      trigger: 'external',
      outcome: null,
      durationMs: null,
    }),
    row({
      id: 'evt-20261030T154000-bbbbbbbb',
      at: '2026-10-30T15:40:02+08:00',
      action: 'handoff-preview',
      trigger: 'external',
      outcome: 'fail',
      code: 'INVALID_REQUEST',
      message: 'DeepSeek Messages tool calls need immediate results 读取 /Users/alice/secret/x.md 失败',
      durationMs: 1832,
      context: { pairingBalanced: false, note: '末条 assistant/message；尾部工具调用未配对' },
    }),
    row({
      id: 'evt-20261030T154500-cccccccc',
      at: '2026-10-30T15:45:00+08:00',
      action: 'compact',
      outcome: 'cancelled',
      code: 'cancelled',
      message: '已取消',
      durationMs: 3000,
    }),
    row({
      id: 'evt-20261030T155000-dddddddd',
      at: '2026-10-30T15:50:00+08:00',
      action: 'preview',
      outcome: 'fail',
      code: 'busy',
      message: '当前会话正在回复中',
      durationMs: 2,
    }),
  ];
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n坏行-not-json\n`, 'utf8');
  fs.writeFileSync(
    path.join(home, 'compact-relay-state.json'),
    JSON.stringify({
      schema: 'dcr-state-snapshot/v1',
      at: '2026-10-30T15:46:00+08:00',
      v: '0.5.6',
      sessionId: 'session-8b0fbefe-1111-2222',
      state: { window: 1048576, tokens: 464337, ratio: 0.443, summaries: 6, pins: 0, advice: 'handoff' },
    }),
    'utf8',
  );
  return { home, file };
}

/** 跑 CLI（隔离 DSH_HOME；不用 /tmp 字面量，全部 os.tmpdir）。 */
function runCli(home, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/* ================================================================== *
 * events
 * ================================================================== */

test('C1 events --last 3：行数正确、时间原样、摘要行含总数/失败数', () => {
  const { home } = makeFixture();
  const result = runCli(home, ['events', '--last', '4']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('2026-10-30T15:40:02+08:00'), true, '时间原样打印文件里的 ISO 串');
  assert.equal(result.stdout.includes('handoff-preview'), true);
  assert.equal(result.stdout.includes('fail'), true);
  assert.equal(result.stdout.includes('失败保护'), false, 'events 摘要不误导');
  assert.equal(result.stdout.includes('下一步：node scripts/dcr-debug.mjs show'), true);
  const summary = result.stdout.split('\n').find((line) => line.includes('条 / 全部'));
  assert.equal(summary.includes('全部 6 条'), true, '坏行不算记录');
});

test('C2 events --action / --outcome 过滤 + cancelled 与 fail 区分', () => {
  const { home } = makeFixture();
  const compact = runCli(home, ['events', '--action', 'compact', '--last', '10']);
  assert.equal(compact.status, 0);
  assert.equal(compact.stdout.includes('handoff-preview'), false);
  assert.equal(compact.stdout.includes('compact'), true);

  const fails = runCli(home, ['events', '--outcome', 'fail', '--json', '--last', '10']);
  assert.equal(fails.status, 0);
  const failRows = JSON.parse(fails.stdout);
  assert.equal(failRows.length, 2);
  assert.equal(failRows.every((row) => row.outcome === 'fail'), true, '--outcome fail 不含 cancelled');
  assert.equal(failRows.some((row) => row.code === 'busy'), true, 'busy 行是 fail 结果（失败投影里再排除）');
});

test('C3 events --json 是数组且行键 = 11 键 schema', () => {
  const { home } = makeFixture();
  const result = runCli(home, ['events', '--json', '--last', '2']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(Array.isArray(parsed), true);
  assert.equal(parsed.length, 2);
  assert.deepEqual(Object.keys(parsed[0]), [
    'id',
    'at',
    'action',
    'trigger',
    'outcome',
    'durationMs',
    'code',
    'message',
    'sessionId',
    'compactionId',
    'context',
  ]);
});

/* ================================================================== *
 * failures
 * ================================================================== */

test('C4 failures：只出 fail/cancelled，排除 busy；带上下文与下一步命令', () => {
  const { home } = makeFixture();
  const result = runCli(home, ['failures']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.includes('INVALID_REQUEST'), true);
  assert.equal(result.stdout.includes('已取消'), true, 'cancelled 也算失败/取消投影');
  assert.equal(result.stdout.includes('当前会话正在回复中'), false, 'busy 不算失败');
  assert.equal(result.stdout.includes('未配对'), true, 'context 原样展示');
  assert.equal(result.stdout.includes('共 2 条失败/取消'), true);
});

/* ================================================================== *
 * show
 * ================================================================== */

test('C5 show 8 位 id：两阶段 + context + 文件行号；未知 id 退出 0', () => {
  const { home } = makeFixture();
  const result = runCli(home, ['show', 'bbbbbbbb']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.includes('start  2026-10-30T15:40:00+08:00'), true);
  assert.equal(result.stdout.includes('end  2026-10-30T15:40:02+08:00'), true);
  assert.equal(result.stdout.includes('pairingBalanced=false'), true);
  assert.equal(result.stdout.includes('记录 : '), true);
  assert.equal(/记录 : .*:3,4/u.test(result.stdout), true, '两行都在文件里');

  const missing = runCli(home, ['show', 'deadbeef']);
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout.includes('没有找到'), true);
});

/* ================================================================== *
 * 缺文件 / 坏行 / 未知参数
 * ================================================================== */

test('C6 缺事件文件：友好提示 + 退出 0；未知参数退出 2', () => {
  const emptyHome = tmpDir();
  const missing = runCli(emptyHome, ['events']);
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout.includes('还没有事件记录'), true);
  const failures = runCli(emptyHome, ['failures']);
  assert.equal(failures.status, 0);
  assert.equal(failures.stdout.includes('还没有事件文件'), true);

  const { home } = makeFixture();
  const bad = runCli(home, ['events', '--nonsense', 'x']);
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout.includes('未知参数'), true);
  const unknown = runCli(home, ['nope']);
  assert.equal(unknown.status, 2);
});

/* ================================================================== *
 * state
 * ================================================================== */

test('C7 state：默认读快照并打印压力/摘要/原生线；非本机 --url 拒绝', () => {
  const { home } = makeFixture();
  const result = runCli(home, ['state']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.includes('source : snapshot'), true);
  assert.equal(result.stdout.includes('464337/1048576'), true);
  assert.equal(result.stdout.includes('44.3%'), true);
  assert.equal(result.stdout.includes('摘要 6'), true);

  const json = runCli(home, ['state', '--json']);
  assert.equal(JSON.parse(json.stdout).schema, 'dcr-state-snapshot/v1');

  const refused = runCli(home, ['state', '--url', 'http://192.168.1.10:60309']);
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout.includes('拒绝非本机地址'), true);

  const empty = runCli(tmpDir(), ['state']);
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout.includes('还没有 state 快照'), true);
});

/* ================================================================== *
 * export
 * ================================================================== */

test('C8 export：8 个二级标题、脱敏（无绝对路径/完整 sessionId）、内嵌 JSON 可解析', () => {
  const { home } = makeFixture();
  const out = path.join(home, 'diag.md');
  const result = runCli(home, ['export', '--out', out]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const text = fs.readFileSync(out, 'utf8');
  for (const heading of ['## 概览', '## 最近动作', '## 最近失败', '## state 快照', '## 文件', '## 机读块（JSON）']) {
    assert.equal(text.includes(heading), true, `缺少标题：${heading}`);
  }
  assert.equal(text.includes('/Users/alice'), false, '外发档必须脱掉绝对路径');
  assert.equal(text.includes('session-8b0fbefe'), false, 'sessionId 只留尾 8 位');
  assert.equal(text.includes('…111-2222'), true);
  assert.equal(text.includes('[REDACTED]'), true);
  assert.equal(text.includes(home), false, '导出内容不写本机 DSH_HOME 绝对路径');
  const match = /```json\n([\s\S]*?)\n```/u.exec(text);
  assert.notEqual(match, null);
  const payload = JSON.parse(match[1]);
  assert.equal(payload.schema, 'dcr-debug-export/v1');
  assert.equal(payload.events.recentFailures.length, 2);
  assert.equal(fs.statSync(out).size < 256 * 1024, true, '总大小 < 256KB');

  // 不覆盖：第二次不带 --force 报错且内容不变；带 --force 才覆盖。
  const before = fs.readFileSync(out, 'utf8');
  const again = runCli(home, ['export', '--out', out]);
  assert.equal(again.status, 2);
  assert.equal(again.stdout.includes('目标已存在'), true);
  assert.equal(fs.readFileSync(out, 'utf8'), before);
  const forced = runCli(home, ['export', '--out', out, '--force']);
  assert.equal(forced.status, 0);
});

/* ================================================================== *
 * 客户端静态守卫（A3 + trigger 贯通 + bundle 重建）
 * ================================================================== */

test('C9 客户端：toast 复制按钮 + 3 处 POST trigger + bundle 已重建', () => {
  const shared = fs.readFileSync(new URL('../lib/client/15-shared.js', import.meta.url), 'utf8');
  const indicator = fs.readFileSync(new URL('../lib/client/30-indicator.js', import.meta.url), 'utf8');
  const bundle = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.equal(shared.includes('failureClipboardTextOf'), true);
  assert.equal(shared.includes('copyTextToClipboard'), true);
  assert.equal(indicator.includes('data-cr-toast-copy'), true);
  assert.equal(indicator.includes("'复制诊断'"), true);
  assert.equal(bundle.includes('data-cr-toast-copy'), true, 'lib/client.js 需要重建');
  assert.equal(bundle.includes('failureClipboardTextOf'), true);
  const triggerCount = (indicator.match(/trigger: 'ui-menu'/gu) ?? []).length;
  assert.equal(triggerCount >= 3, true, `3 处压缩/交接 POST 都要带 trigger，实际 ${triggerCount}`);
  assert.equal(indicator.includes("trigger: 'ui-ring'"), false, '环当前无生产者：保留枚举但不产生');
});

/* run */
let passed = 0;
for (const { name, fn } of cases) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.log(`FAIL  ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${cases.length} passed`);
