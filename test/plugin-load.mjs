/**
 * 装配冒烟 —— 用 DSH 包的测试替身把 lib/index.js 完整加载一遍。
 *
 *   node test/plugin-load.mjs
 *
 * 验证：apply() 能跑、命令/HTTP 路由/工具注册、state 端点无活动会话时也返回合法 JSON、
 * 设置栏读写与宿主鉴权闸门、/bctest 等命令在无 agent 时返回错误文案。
 *
 * A7 起 fake host 与路由请求替身统一来自 `test/harness/`（DSH 包解析钩子见 harness/dsh-stubs.mjs）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerDshStubHooks } from './harness/dsh-stubs.mjs';
import { callRoute, callRouteAsync, createFakeHost, createTmpDir, openSse } from './harness/host.mjs';
import { createLedgerStore } from '../lib/dsh/ledger.js';
import { createFakeLlm } from './harness/llm.mjs';

// DSH 包 → test/stubs/*：必须在动态 import lib/index.js 之前注册。
registerDshStubHooks();

// M6：交接文档端点用独立临时目录，别去读真实 ~/.dsh/handoffs。
const handoffDir = createTmpDir('relay-load-handoffs-');
// 设置存储：隔离一个 DSH_HOME，别读写真实的 ~/.dsh/compact-relay.json。
const dshHome = createTmpDir('relay-load-home-');
process.env.DSH_HOME = dshHome;
// 0.4.2：用临时 profile 固定 DSH 原生压缩配置（auto=true / thresholdRatio=0.8），
// 让「交接线上限」的服务端校验不依赖本机 ~/.dsh/profiles/desktop。
// desktop-host 也是把 profile 目录当命令行参数传进来（见 dsh/native-compaction.js:resolveProfileDir）。
const profileDir = createTmpDir('relay-load-profile-');
fs.writeFileSync(
  path.join(profileDir, 'cordis.patch.yml'),
  ['- id: compaction-basic', '  config:', '    auto: true', '    thresholdRatio: 0.8', ''].join('\n'),
  'utf8',
);
process.argv.push(profileDir);
// M5 修复：会话已加载但还没有 agent 时，state 也要能用 live session 测出数字。
const liveSession = {
  id: 'session-live',
  log: [],
  surface: { nodes: [] },
  requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
};
// session-later：前两次 get 还拿不到（模拟「会话还没加载」），之后加载完成。
let laterLookups = 0;
const laterSession = {
  id: 'session-later',
  log: [],
  surface: { nodes: [] },
  requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
};
// 0.3.4（BUG-010）：动态提示用例要一个「落在可压缩区间」的会话（200K 窗口里 40K = 20%）。
const cueSession = {
  id: 'session-cue',
  log: [],
  surface: { nodes: [] },
  requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
};
const host = createFakeHost({
  services: {
    agents: { get: () => undefined, list: () => [] },
    sessions: {
      get: (id) => {
        if (id === 'session-live') return liveSession;
        if (id === 'session-later') {
          laterLookups += 1;
          return laterLookups > 2 ? laterSession : undefined;
        }
        if (id === 'session-cue') return cueSession;
        return undefined;
      },
      flush() {},
    },
    // session-cue 用 20% 容量（可压缩区间内），其余会话保持 1234 token（区间外）。
    tokenMeter: {
      measure: (session) =>
        session?.id === 'session-cue'
          ? { totalTokens: 40_000, surfaceTokens: 40_000, nodes: [] }
          : { totalTokens: 1234, surfaceTokens: 1000, nodes: [] },
    },
    llm: createFakeLlm({ modelInfo: { context: { contextWindow: 200_000 } } }),
  },
});
const ctx = host.ctx;
// A4：先放一个「合法 JSON + 非法值」的用户设置文件，验证 apply 不会因此抛错/插件消失。
fs.writeFileSync(
  path.join(dshHome, 'compact-relay.json'),
  JSON.stringify({ thresholds: { compactRatio: 0.9 } }),
  'utf8',
);

const { apply, name, inject } = await import('../lib/index.js');
apply(ctx, {
  handoffDir,
  retention: { recentTailTokens: 0 },
  // GitHub 链接：URL 配了就用（覆盖默认仓库链接）；没配时设置页显示“准备中”。
  links: { tutorial: 'https://github.com/example/relay/blob/main/TUTORIAL.md' },
});

assert.equal(name, 'compact-relay');
assert.equal(Array.isArray(inject), true);
assert.equal(inject.includes('compaction'), false, 'compaction 是 agent 作用域服务，不能放进根插件 inject');
assert.equal(inject.includes('tools'), true, 'M4 需要根级 tools 服务来注册 mark_compress_point');
assert.equal(inject.includes('systemPrompt'), true, '0.3.4 需要根级 systemPrompt 注入「可压缩区间」提示');
assert.deepEqual(
  host.commands.map((definition) => definition.name).sort(),
  ['bc', 'bctest', 'favorite', 'handoff', 'pin', 'unpin'],
);
assert.deepEqual(
  host.routes.map((route) => route.path).sort(),
  [
    '/api/compact-relay-action',
    '/api/compact-relay-chain',
    '/api/compact-relay-diagnostics',
    '/api/compact-relay-diff',
    '/api/compact-relay-handoffs',
    '/api/compact-relay-settings',
    '/api/compact-relay-state',
    '/api/compact-relay-stream',
  ],
);
assert.deepEqual(
  host.eventHandlers.map((entry) => entry.name),
  ['session/event'],
  'M5：状态推送要订阅会话事件',
);
assert.deepEqual(
  host.tools.map((definition) => definition.name),
  ['mark_compress_point'],
  '0.3.4：压缩节点工具必须注册（旧名 mark_stage）',
);

// 0.3.4（BUG-010）：systemPrompt 动态提示 —— 注册 + 区间内文案 + 区间外空串 + 异常安全。
assert.equal(host.promptContexts.length, 1, '应注册一条「可压缩区间」动态 runtime context');
const cueContext = host.promptContexts[0];
assert.equal(cueContext.name, 'compact-relay:compress-cue');
assert.equal(cueContext.order, 300);
assert.equal(typeof cueContext.text, 'function');
// 缓存由 session/event 防抖更新：驱动一条事件后等 150ms 去抖结束。
host.eventHandlers[0].listener({ id: 'session-cue' }, { type: 'user/message' });
await new Promise((resolve) => setTimeout(resolve, 320));
const cueText = cueContext.text({ agent: { id: 'agent-cue', session: { id: 'session-cue' } } });
assert.equal(typeof cueText, 'string');
assert.equal(cueText.includes('mark_compress_point'), true, '区间内提示要点名工具');
assert.equal(cueText.includes('20%'), true, '容量按 5% 桶显示 20%');
// 区间外（session-live 只有 1234/200000 ≈ 0.6%，低于最小压缩线）→ 空串。
host.eventHandlers[0].listener({ id: 'session-live' }, { type: 'user/message' });
await new Promise((resolve) => setTimeout(resolve, 320));
assert.equal(cueContext.text({ agent: { session: { id: 'session-live' } } }), '', '区间外不提示');
// 异常安全：text 回调不能把宿主组装 prompt 搞挂。
assert.equal(cueContext.text(undefined), '');
assert.equal(cueContext.text({ get agent() { throw new Error('boom'); } }), '');
assert.equal(cueContext.text({ agent: { session: { id: 'session-not-loaded' } } }), '', '缓存没有就返回空串');

// M5：SSE 路由能建流、首帧带最新状态（无活动会话时也能给出合法 JSON）。
const streamRes = openSse(host, '/api/compact-relay-stream?sessionId=session-e2e');
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(streamRes.status, 200);
assert.equal(String(streamRes.headers['content-type']).includes('text/event-stream'), true);
assert.equal(streamRes.body.includes(': connected'), true);
assert.equal(streamRes.body.includes('data: '), true, '首帧应带状态 JSON');
const firstFrame = streamRes.body.split('\n\n').find((part) => part.startsWith('data: '));
assert.equal(firstFrame !== undefined, true);
assert.equal(JSON.parse(firstFrame.slice('data: '.length)).advice, 'none');
// 事件到达时不应炸（没有订阅者就静默忽略）。
host.eventHandlers[0].listener({ id: 'session-e2e' }, { type: 'user/message' });

// M5 修复：首帧拿到空状态（会话还没加载）时，要退避重试自动补推，不能停在「未知」。
const laterRes = openSse(host, '/api/compact-relay-stream?sessionId=session-later');
await new Promise((resolve) => setTimeout(resolve, 2200));
const laterFrames = laterRes.body
  .split('\n\n')
  .filter((part) => part.startsWith('data: '))
  .map((part) => JSON.parse(part.slice('data: '.length)));
assert.equal(laterFrames.length >= 2, true, '未就绪时应有补推帧');
assert.equal(laterFrames.at(-1).sessionId, 'session-later', '会话加载后要自动推真数据');
assert.equal(laterFrames.at(-1).pressure, 1234);

const fallbackState = await callRouteAsync(host, '/api/compact-relay-state?sessionId=session-live');
assert.equal(fallbackState.status, 200);
assert.equal(fallbackState.body.sessionId, 'session-live');
assert.equal(fallbackState.body.pressure, 1234, '没有 agent 也要用 live session 测出压力');
assert.equal(fallbackState.body.window, 200_000);
const strayState = await callRouteAsync(host, '/api/compact-relay-state?sessionId=session-not-live');
assert.equal(strayState.body.sessionId, null, '会话不存在时不许回退到别的会话');

const stateRes = callRoute(host, '/api/compact-relay-state');
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(stateRes.status, 200);
const state = JSON.parse(stateRes.body);
assert.equal(state.advice, 'none');
assert.equal(state.pressure, null);
assert.equal(state.busy, false);
assert.equal(state.compressHint, null);
assert.equal(state.level, 'idle');
assert.equal(state.colors.mode, 'auto');
assert.equal(state.colors.autoAdapt, true);
for (const key of ['idle', 'stage', 'pin', 'compact', 'handoff']) {
  assert.equal(typeof state.colors.base[key], 'string', `colors.base.${key} 应该是字符串`);
}
assert.equal(state.colors.base.idle, '#6F7680');
assert.equal(typeof state.thresholds.compactAt, 'number');
// 窗口比例：没有会话路由时窗口回落到 contextWindowFallback=1M → 40%/60% = 40 万/60 万
assert.equal(state.thresholds.window, 1_000_000);
assert.equal(state.thresholds.compactAt, 400_000);
assert.equal(state.thresholds.handoffAt, 600_000);
assert.equal(state.thresholds.compactRatio, 0.4);

// ---- 设置栏端点：读取 / 保存（热生效）/ 校验 / 恢复默认 ----
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readSettings = async () => {
  const res = callRoute(host, '/api/compact-relay-settings');
  await sleep(60);
  return { status: res.status, body: JSON.parse(res.body) };
};
const initialSettings = await readSettings();
assert.equal(initialSettings.status, 200);
assert.equal(initialSettings.body.ok, true);
assert.equal(initialSettings.body.config.thresholds.compactRatio, 0.4);
assert.equal(initialSettings.body.config.colors.base.idle, '#6F7680');
assert.equal(initialSettings.body.config.links.tutorial, 'https://github.com/example/relay/blob/main/TUTORIAL.md');
assert.equal(initialSettings.body.config.links.feedback, 'https://github.com/cfanzx/dsh-compact-relay/issues', '反馈链接默认指向仓库 Issues');
// 版本号跟着 package.json 走，避免每次发版都改测试（0.3.2 起）。
{
  const pkg = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(initialSettings.body.version, pkg.version, '设置接口返回的版本号应与 package.json 一致');
}
// A4：坏设置文件被回落到默认，但错误要可见（apply 没抛错才能走到这里）。
assert.equal(initialSettings.body.settingsError.field, 'thresholds.compactRatio');
assert.equal(initialSettings.body.settingsError.message.includes('压缩提醒线'), true);
assert.equal(initialSettings.body.config.thresholds.compactRatio, 0.4, '坏覆盖层要回落默认');
assert.equal(initialSettings.body.path.startsWith(dshHome), true, '设置文件应落在 DSH_HOME 下');

// 0.4 P1-3：设置端点带出轻账本累计（设置页「累计」一行数字的数据源，与账本文件同源）。
assert.equal(initialSettings.body.ledger.count, 0, '还没有记录时累计为 0');
const ledgerStore = createLedgerStore();
assert.deepEqual(
  ledgerStore.record({ kind: 'compact', durationMs: 1000, beforeTokens: 10000, afterTokens: 5000, beforeRatio: 0.1, afterRatio: 0.05, pinHits: { inRange: 0, total: 0 } }),
  { ok: true },
);
assert.deepEqual(
  ledgerStore.record({
    kind: 'handoff',
    durationMs: 2000,
    beforeTokens: 5000,
    afterTokens: 4000,
    beforeRatio: 0.05,
    afterRatio: 0.04,
    pinHits: { inRange: 1, total: 2 },
    handoff: { path: '/tmp/relay-e2e/handoffs/handoff-1.md', childId: 'session-ledger', started: true },
  }),
  { ok: true },
);
const settingsWithLedger = await readSettings();
assert.equal(settingsWithLedger.body.ledger.count, 2);
assert.equal(settingsWithLedger.body.ledger.compactCount, 1);
assert.equal(settingsWithLedger.body.ledger.handoffCount, 1);
assert.equal(settingsWithLedger.body.ledger.freedTokens, 6000);
assert.equal(settingsWithLedger.body.ledger.avgDurationMs, 1500);
assert.equal(settingsWithLedger.body.ledger.lastAt.length > 0, true, '最近一条的时间也要下发');

const saveSettings = callRoute(host, '/api/compact-relay-settings', {
  method: 'POST',
  body: JSON.stringify({
    thresholds: { compactRatio: 0.3, handoffRatio: 0.55, maxSummaries: 4 },
    retention: { recentTailTokens: 1000 },
    handoffDir,
    colors: { mode: 'dark', autoAdapt: false, base: { idle: '#111111', compact: '#222222', handoff: '#333333', stage: '#444444', pin: '#555555' } },
  }),
});
await sleep(80);
assert.equal(saveSettings.status, 200);
const saved = JSON.parse(saveSettings.body);
assert.equal(saved.config.thresholds.compactRatio, 0.3);
assert.equal(saved.config.colors.mode, 'dark');
assert.equal(saved.config.colors.autoAdapt, false);
assert.equal(saved.config.colors.base.idle, '#111111');
assert.equal(saved.settingsError, null, 'A4：保存成功后清掉设置文件错误');
assert.equal(fs.existsSync(path.join(dshHome, 'compact-relay.json')), true);
const envelope = JSON.parse(fs.readFileSync(path.join(dshHome, 'compact-relay.json'), 'utf8'));
assert.equal(envelope.v, 1, 'A4：磁盘格式为 v1 信封');
assert.equal(envelope.config.colors.base.idle, '#111111');

const stateAfterSave = await callRouteAsync(host, '/api/compact-relay-state?sessionId=session-live');
assert.equal(stateAfterSave.body.thresholds.compactRatio, 0.3, '保存后 state 立即用新配置');
assert.equal(stateAfterSave.body.thresholds.compactAt, 60_000, '200k 窗口 × 30% = 60k');
assert.equal(stateAfterSave.body.colors.base.idle, '#111111');

const badSettings = callRoute(host, '/api/compact-relay-settings', {
  method: 'POST',
  body: JSON.stringify({ thresholds: { compactRatio: 0.7, handoffRatio: 0.6 } }),
});
await sleep(80);
assert.equal(badSettings.status, 400);
assert.equal(JSON.parse(badSettings.body).ok, false, '非法比例必须被拒');

// ---- 0.4.2（P0-2）：服务端保存与 UI 同口径 ----
// 客户端带 nativeRatio（当前模型实际触发线）→ 按「实际线 −5pp」校验交接线；
// 不带（旧客户端）→ 退回配置阈值 −1pp 兜底（0.4.1 行为）。一律 400 + field + 目标值。
const postSettings = async (body) => {
  const res = callRoute(host, '/api/compact-relay-settings', { method: 'POST', body: JSON.stringify(body) });
  await sleep(80);
  return { status: res.status, body: JSON.parse(res.body) };
};
// H1：67.8% 实际线 → 65% 超上限（62%），拒绝并给目标值。
const nativeOver = await postSettings({ thresholds: { handoffRatio: 0.65 }, nativeRatio: 0.678 });
assert.equal(nativeOver.status, 400, '带 nativeRatio 的超限交接线必须被拒');
assert.equal(nativeOver.body.ok, false);
assert.equal(nativeOver.body.field, 'thresholds.handoffRatio', '错误要带 field 供设置页定位');
assert.equal(nativeOver.body.message.includes('最高可设 62%'), true, `文案要给目标值，实际：${nativeOver.body.message}`);
assert.equal(nativeOver.body.message.includes('67.8%'), true, '文案要说明实际触发线');
// H2：62%（上限）通过并落盘。
const nativeAtCap = await postSettings({ thresholds: { handoffRatio: 0.62 }, nativeRatio: 0.678 });
assert.equal(nativeAtCap.status, 200);
assert.equal(nativeAtCap.body.config.thresholds.handoffRatio, 0.62);
// H3：不带 nativeRatio（0.4.1 客户端）保存 65% → 允许（兜底上限 79%）。
const legacySave = await postSettings({ thresholds: { handoffRatio: 0.65 } });
assert.equal(legacySave.status, 200, '旧客户端不带 nativeRatio 不能因为新规则被拒');
assert.equal(legacySave.body.config.thresholds.handoffRatio, 0.65);
// H4：带 nativeRatio 保存 85% → 仍按实际线（62%）而不是配置阈值（79%）拒绝。
const farOver = await postSettings({ thresholds: { handoffRatio: 0.85 }, nativeRatio: 0.678 });
assert.equal(farOver.status, 400);
assert.equal(farOver.body.message.includes('最高可设 62%'), true);
assert.equal(farOver.body.message.includes('79%'), false, '带了实际线就不该再按配置阈值给上限');
// 恢复一次合法值，避免后续用例受 0.85 影响（reset 之前这一步会失败在 resolveConfig 之外）。
const backToDefault = await postSettings({ thresholds: { handoffRatio: 0.6 } });
assert.equal(backToDefault.status, 200);

const crossSiteSettings = callRoute(host, '/api/compact-relay-settings', {
  method: 'POST',
  headers: { 'sec-fetch-site': 'cross-site', origin: 'http://evil.example' },
  body: JSON.stringify({ thresholds: { compactRatio: 0.4 } }),
});
await sleep(80);
assert.equal(crossSiteSettings.status, 403, '跨站写设置必须被拒');

const resetSettings = callRoute(host, '/api/compact-relay-settings', {
  method: 'POST',
  body: JSON.stringify({ reset: true }),
});
await sleep(80);
assert.equal(resetSettings.status, 200);
const resetBody = JSON.parse(resetSettings.body);
assert.equal(resetBody.config.thresholds.compactRatio, 0.4);
assert.equal(resetBody.config.colors.base.idle, '#6F7680');
assert.equal(resetBody.settingsError, null, 'A4：恢复默认后清掉设置文件错误');
assert.equal(fs.existsSync(path.join(dshHome, 'compact-relay.json')), false, '恢复默认要删掉用户覆盖文件');

// ---- 0.4 P0-2：只读诊断端点（GET only / 白名单产物 / 脱敏 / 短字段 issueUrl）----
const diagRes = await callRouteAsync(host, '/api/compact-relay-diagnostics?sessionId=session-live');
assert.equal(diagRes.status, 200);
assert.equal(diagRes.body.ok, true);
assert.equal(diagRes.body.schema, 'dcr-diagnostics/v1');
assert.equal(diagRes.body.json.schema, 'dcr-diagnostics/v1');
assert.equal(typeof diagRes.body.markdown, 'string');
assert.equal(diagRes.body.markdown.includes('诊断信息'), true, 'Markdown 要有人读标题');
assert.equal(typeof diagRes.body.issueUrl, 'string');
assert.equal(diagRes.body.issueUrl.includes('template=bug_report.yml'), true, 'issue URL 要预填 bug 模板');
assert.equal(diagRes.body.issueUrl.length < 7500, true, 'issue URL 必须 < 7500 字符');
assert.equal(diagRes.body.json.runtime.dshVersion, null, '拿不到 DSH 版本就 null，不猜');
assert.notEqual(diagRes.body.json.state, null, '有 live session 时 state 不应为 null');
const diagJsonText = JSON.stringify(diagRes.body.json);
assert.equal(diagJsonText.includes('session-live'), false, '产物里不能出现 sessionId 值');
assert.equal(diagJsonText.includes(dshHome), false, '产物里不能出现任何本机路径');
const diagNoSession = await callRouteAsync(host, '/api/compact-relay-diagnostics');
assert.equal(diagNoSession.status, 200);
assert.equal(diagNoSession.body.json.state, null, '无活动会话时 state 整块为 null');
const diagPost = callRoute(host, '/api/compact-relay-diagnostics', { method: 'POST' });
await sleep(60);
assert.equal(diagPost.status, 405, '诊断端点只读：非 GET 必须 405');

// ---- 2026-10-20 安全：所有插件端点必须先过宿主 connection 鉴权（P0）----
host.setConnectionRejection(401);
const authCases = [
  ['/api/compact-relay-state', { method: 'GET' }],
  ['/api/compact-relay-chain', { method: 'GET' }],
  ['/api/compact-relay-handoffs', { method: 'GET' }],
  ['/api/compact-relay-settings', { method: 'GET' }],
  ['/api/compact-relay-diagnostics', { method: 'GET' }],
  ['/api/compact-relay-action', { method: 'POST', body: JSON.stringify({ action: 'cancel', sessionId: 'session-live' }) }],
];
for (const [path, opts] of authCases) {
  const res = callRoute(host, path, opts);
  await sleep(40);
  assert.equal(res.status, 401, `${path} 未认证必须 401（宿主 token 校验）`);
}
const authStreamRes = openSse(host, '/api/compact-relay-stream?sessionId=session-live');
assert.equal(authStreamRes.status, 401, 'stream 未认证必须 401');
host.setConnectionRejection(403);
const authForbidden = callRoute(host, '/api/compact-relay-settings', { method: 'GET' });
await sleep(40);
assert.equal(authForbidden.status, 403, 'Host/Origin 不信任时 403');
host.setConnectionRejection(undefined);

// P1：Origin:null（sandbox iframe / no-cors POST）必须被跨站校验拒绝。
const nullOriginSettings = callRoute(host, '/api/compact-relay-settings', {
  method: 'POST',
  headers: { 'sec-fetch-site': 'cross-site', origin: 'null' },
  body: JSON.stringify({ thresholds: { compactRatio: 0.4 } }),
});
await sleep(40);
assert.equal(nullOriginSettings.status, 403, 'Origin:null 的跨站请求必须 403');

const noAgentRes = callRoute(host, '/api/compact-relay-action', {
  method: 'POST',
  body: JSON.stringify({ action: 'compact', sessionId: 'session-no-agent' }),
});
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(noAgentRes.status, 409);

// M6：预览/取消同样先经过「有没有活动会话」这一关，无会话一律 409。
const noAgentPreview = callRoute(host, '/api/compact-relay-action', {
  method: 'POST',
  body: JSON.stringify({ action: 'preview', sessionId: 'session-no-agent' }),
});
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(noAgentPreview.status, 409);
const noAgentCancel = callRoute(host, '/api/compact-relay-action', {
  method: 'POST',
  body: JSON.stringify({ action: 'cancel', sessionId: 'session-no-agent' }),
});
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(noAgentCancel.status, 409);
const noAgentPin = callRoute(host, '/api/compact-relay-action', {
  method: 'POST',
  body: JSON.stringify({ action: 'pin-toggle', sessionId: 'session-no-agent' }),
});
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(noAgentPin.status, 409);

// 0.6 预览卡收藏：favorite-mark 按 sessionId+seq 收藏，**不需要活 agent**（归档/关闭会话也能标）。
// 客户端会显式带 active:true（只加不切换）：重复请求幂等，预览数据过期也不会误取消收藏。
const favoriteMarkPayload = { action: 'favorite-mark', sessionId: 'session-archived', seq: 3, active: true };
const favoriteMarkRes = callRoute(host, '/api/compact-relay-action', {
  method: 'POST',
  body: JSON.stringify(favoriteMarkPayload),
});
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(favoriteMarkRes.status, 200, 'favorite-mark 不要求活会话');
const favoriteMark = JSON.parse(favoriteMarkRes.body);
assert.equal(favoriteMark.ok, true);
assert.equal(favoriteMark.active, true);
assert.equal(favoriteMark.seq, 3);
assert.equal(favoriteMark.sessionId, 'session-archived');
const favoriteMarkAgain = callRoute(host, '/api/compact-relay-action', {
  method: 'POST',
  body: JSON.stringify(favoriteMarkPayload),
});
await new Promise((resolve) => setTimeout(resolve, 80));
const favoriteMarkAgainBody = JSON.parse(favoriteMarkAgain.body);
assert.equal(favoriteMarkAgainBody.active, true, 'active:true 幂等只加，不会切换成取消');
assert.equal(favoriteMarkAgainBody.note, 'already');
const favoriteBadActive = callRoute(host, '/api/compact-relay-action', {
  method: 'POST',
  body: JSON.stringify({ action: 'favorite-mark', sessionId: 'session-archived', seq: 3, active: 'yes' }),
});
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(favoriteBadActive.status, 400, 'active 类型错必须 400，不猜');

// 2026-10-19 debug：动作端点必须带 sessionId（缺省/类型错绝不能退化成「最后一个 agent」）。
const noSessionId = callRoute(host, '/api/compact-relay-action', {
  method: 'POST',
  body: JSON.stringify({ action: 'compact' }),
});
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(noSessionId.status, 400);
const badSessionId = callRoute(host, '/api/compact-relay-action', {
  method: 'POST',
  body: JSON.stringify({ action: 'compact', sessionId: 123 }),
});
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(badSessionId.status, 400);
const nullJson = callRoute(host, '/api/compact-relay-action', {
  method: 'POST',
  body: 'null',
  headers: { 'content-type': 'application/json' },
});
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(nullJson.status, 400);
const crossSite = callRoute(host, '/api/compact-relay-action', {
  method: 'POST',
  body: JSON.stringify({ action: 'compact', sessionId: 'session-no-agent' }),
  headers: { 'sec-fetch-site': 'cross-site' },
});
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(crossSite.status, 403);
const tooLarge = callRoute(host, '/api/compact-relay-action', {
  method: 'POST',
  // 0.4 P2-1：action 路由 body 上限放宽到 48KB（要装下两段编辑），超限夹具同步放大到 56KB。
  body: JSON.stringify({ action: 'compact', sessionId: 'session-no-agent', pad: 'x'.repeat(56 * 1024) }),
  headers: { 'content-type': 'application/json' },
});
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(tooLarge.status, 413);
const postState = callRoute(host, '/api/compact-relay-state', { method: 'POST' });
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(postState.status, 405);

// M6：交接文档只读端点 —— 列表 / 单篇 / 非法文件名拒绝。
const emptyDocs = await callRouteAsync(host, '/api/compact-relay-handoffs');
assert.equal(emptyDocs.status, 200);
assert.equal(emptyDocs.body.ok, true);
assert.deepEqual(emptyDocs.body.items, []);
assert.equal(emptyDocs.body.total, 0, '0.3.4（BUG-006）：列表端点要报 total');

const sampleName = 'handoff-2026-10-19T12-31-42-001Z.md';
fs.writeFileSync(
  path.join(handoffDir, sampleName),
  '# 交接单\n\n- 生成时间：2026-10-19T12:31:42.001Z\n- 原会话标题：样本会话\n- 交接单路径：/tmp/x.md\n\n## 目标\n- x\n',
  'utf8',
);
const listedDocs = await callRouteAsync(host, '/api/compact-relay-handoffs?limit=5');
assert.equal(listedDocs.body.items.length, 1);
assert.equal(listedDocs.body.items[0].name, sampleName);
assert.equal(listedDocs.body.items[0].sourceTitle, '样本会话');
assert.equal(listedDocs.body.total, 1);
const docDetail = await callRouteAsync(host, `/api/compact-relay-handoffs?file=${encodeURIComponent(sampleName)}`);
assert.equal(docDetail.status, 200);
assert.equal(docDetail.body.content.includes('## 目标'), true);
const badFile = await callRouteAsync(host, '/api/compact-relay-handoffs?file=..%2Fevil.md');
assert.equal(badFile.status, 404, '目录穿越/非法文件名必须拒绝');
const wrongExt = await callRouteAsync(host, '/api/compact-relay-handoffs?file=other.md');
assert.equal(wrongExt.status, 404);

// 0.3.4（BUG-006）：total 报全量、limit 只控窗口；「加载更多」用 limit=50 看全部。
for (let index = 0; index < 24; index += 1) {
  const name = `handoff-2026-10-19T12-31-42-${String(index + 2).padStart(3, '0')}Z.md`;
  fs.writeFileSync(
    path.join(handoffDir, name),
    `# 交接单 ${index}\n\n- 生成时间：2026-10-19T12:31:42.001Z\n- 原会话标题：样本 ${index}\n\n## 目标\n- x\n`,
    'utf8',
  );
}
const pageDocs = await callRouteAsync(host, '/api/compact-relay-handoffs?limit=20');
assert.equal(pageDocs.body.total, 25, 'total 要报全部交接单数量（不受 limit 截断）');
assert.equal(pageDocs.body.items.length, 20, '默认只回最近 20 份');
const moreDocs = await callRouteAsync(host, '/api/compact-relay-handoffs?limit=50');
assert.equal(moreDocs.body.total, 25);
assert.equal(moreDocs.body.items.length, 25, '加载更多（limit=50）要能看到全部 25 份');
const defaultDocs = await callRouteAsync(host, '/api/compact-relay-handoffs');
assert.equal(defaultDocs.body.items.length, 20, '不传 limit 默认 20');
assert.equal(defaultDocs.body.total, 25);

fs.rmSync(handoffDir, { recursive: true, force: true });

const bcDef = host.commands.find((definition) => definition.name === 'bc');
assert.equal(typeof bcDef.handler, 'function');
assert.equal(typeof bcDef.input?.hint, 'string', '/bc 现在要带 confirm，必须声明 input.hint');
assert.equal(bcDef.input.hint.trim().length > 0, true);
const bcPreviewNoAgent = await bcDef.handler({ rawInput: '', agent: null, signal: undefined, commandId: 'cmd-bc' });
assert.equal(bcPreviewNoAgent.kind, 'error');
const bcConfirmNoAgent = await bcDef.handler({ rawInput: 'confirm', agent: null, signal: undefined, commandId: 'cmd-bc' });
assert.equal(bcConfirmNoAgent.kind, 'error');
const bcBadArg = await bcDef.handler({ rawInput: 'whatever', agent: null, signal: undefined, commandId: 'cmd-bc' });
assert.equal(bcBadArg.kind, 'error');
assert.equal(bcBadArg.text.includes('用法'), true, '参数错误要给出用法');

const handoffDef = host.commands.find((definition) => definition.name === 'handoff');
assert.equal(typeof handoffDef.handler, 'function');
assert.equal(handoffDef.input, undefined, '/handoff 不带参数，不声明 input');
const handoffNoAgent = await handoffDef.handler({ rawInput: '', agent: null, signal: undefined, commandId: 'cmd-handoff' });
assert.equal(handoffNoAgent.kind, 'error');
assert.equal(handoffNoAgent.text.includes('会话'), true);
const handoffWithArgs = await handoffDef.handler({ rawInput: 'all', agent: null, signal: undefined, commandId: 'cmd-handoff' });
assert.equal(handoffWithArgs.kind, 'error');

// M6：钉住消息命令（/pin 钉最近一轮、/pin list、/unpin）。
const pinDef = host.commands.find((definition) => definition.name === 'pin');
assert.equal(typeof pinDef.handler, 'function');
assert.equal(typeof pinDef.input?.hint, 'string', '/pin 要带 list/序号，必须声明 input.hint');
const pinNoAgent = await pinDef.handler({ rawInput: '', agent: null, signal: undefined, commandId: 'cmd-pin' });
assert.equal(pinNoAgent.kind, 'error');
const pinBadArg = await pinDef.handler({ rawInput: 'what', agent: null, signal: undefined, commandId: 'cmd-pin' });
assert.equal(pinBadArg.kind, 'error');
assert.equal(pinBadArg.text.includes('用法'), true);

const pinWrites = [];
const fakePinSession = {
  surface: { nodes: [1] },
  log: [],
  eventAt: () => ({ type: 'user/message', data: { message: { content: [{ type: 'text', text: '要保留的结论' }] } } }),
  appendPluginRecord(type, data) {
    pinWrites.push({ type, data });
    this.log.push({ type, ignorable: true, data, seq: this.log.length });
    return this.log.length;
  },
};
const pinOk = await pinDef.handler({
  rawInput: '',
  agent: { id: 'fake-pin', session: fakePinSession },
  signal: undefined,
  commandId: 'cmd-pin',
});
assert.equal(pinOk.kind, 'success');
assert.equal(pinOk.text.includes('已锁定最近一轮会话'), true);
assert.equal(pinWrites[0].type, 'plugin:compact-relay/pin');
assert.deepEqual(pinWrites[0].data.seqs, [1]);

const pinList = await pinDef.handler({
  rawInput: 'list',
  agent: { id: 'fake-pin', session: fakePinSession },
  signal: undefined,
  commandId: 'cmd-pin',
});
assert.equal(pinList.kind, 'success');
assert.equal(pinList.text.includes('当前已锁定：1 条'), true);

const unpinDef = host.commands.find((definition) => definition.name === 'unpin');
assert.equal(typeof unpinDef.handler, 'function');
assert.equal(unpinDef.input, undefined, '/unpin 不带参数，不声明 input');
const unpinOk = await unpinDef.handler({
  rawInput: '',
  agent: { id: 'fake-pin', session: fakePinSession },
  signal: undefined,
  commandId: 'cmd-unpin',
});
assert.equal(unpinOk.kind, 'success');
assert.equal(unpinOk.text.includes('已全部解锁'), true);
assert.deepEqual(pinWrites.at(-1).data.seqs, []);

const bctest = host.commands.find((definition) => definition.name === 'bctest');
assert.equal(typeof bctest.input?.hint, 'string');
assert.equal(bctest.input.hint.trim().length > 0, true, '带参数的 /bctest 必须声明非空 input.hint，否则 /bctest confirm 会被客户端当普通消息');
const bctestResult = await bctest.handler({
  rawInput: '',
  agent: null,
  signal: undefined,
  commandId: 'cmd-test',
});
assert.equal(bctestResult.kind, 'error');
assert.equal(typeof bctestResult.text, 'string');

const badArg = await bctest.handler({ rawInput: 'whatever', agent: null, signal: undefined, commandId: 'cmd-test' });
assert.equal(badArg.kind, 'error');

const compressPointTool = host.tools.find((definition) => definition.name === 'mark_compress_point');
assert.equal(typeof compressPointTool.execute, 'function');
assert.equal(typeof compressPointTool.description, 'string');
assert.equal(compressPointTool.description.includes('压缩节点'), true, '工具描述要讲清「记录一个压缩节点」');
assert.equal(compressPointTool.description.includes('适合把前面的旧历史压成摘要'), true);
assert.equal(
  compressPointTool.description.includes('系统会告诉你'),
  false,
  '0.3.4 移除「系统会告诉你容量」的假承诺（旧 mark_stage 在 427 个会话里 0 次调用的根因）',
);
// 0.4 P0-1（U5）：工具描述 v2 —— 明确「用户和模型都可以调用」+「被拒不需要致歉」，
// 并保留边界（小步骤不用调用）但不再把抑制性措辞放在条件前面。
assert.equal(compressPointTool.description.includes('用户和模型都可以调用'), true, 'U5：描述要点明用户和模型都可以调用');
assert.equal(compressPointTool.description.includes('被拒不需要致歉'), true, 'U5：描述要说明被拒不需要致歉');
assert.equal(compressPointTool.description.includes('不会改动历史'), true, 'U5：描述要说明被拒零副作用');
assert.equal(compressPointTool.description.includes('典型调用时机'), true, 'U5：描述要给出典型调用时机');
for (const signal of ['功能已实现并验证', '文档已交付', '问题已定位并修复', '准备交接']) {
  assert.equal(compressPointTool.description.includes(signal), true, `工具描述缺少完成信号：${signal}`);
}
assert.equal(compressPointTool.description.includes('不需要每个小步骤都调用'), false, '抑制性措辞要弱化/移除');
// 没有活动会话时返回可读提示（不抛错）。
const noAgentToolText = await compressPointTool.execute({}, {});
assert.equal(typeof noAgentToolText, 'string');
assert.equal(noAgentToolText.includes('没有活动会话'), true);

console.log('PASS  plugin apply：命令/路由/工具注册');
console.log('PASS  mark_compress_point：工具注册 + 描述 v2（用户/模型可调用、被拒不需要致歉、典型时机）+ 无会话提示');
console.log('PASS  systemPrompt 可压缩区间提示：注册/区间内文案/区间外空串/异常安全');
console.log('PASS  state 端点：无会话时合法 JSON');
console.log('PASS  /api/compact-relay-stream：SSE 建流 + 首帧状态 + 未就绪自动补推');
console.log('PASS  action 端点：sessionId 缺失/类型错/非法 JSON/跨站/超大 body 均被拒；无会话时 409（含 preview/cancel/pin-toggle）');
console.log('PASS  /api/compact-relay-handoffs：列表/读取/非法文件名拒绝 + total/加载更多（BUG-006）');
console.log('PASS  /api/compact-relay-settings：读取/保存热生效/非法比例/跨站/恢复默认 + P1-3 账本累计');
console.log('PASS  /api/compact-relay-diagnostics：只读 GET/鉴权/白名单产物/无会话 state=null/非 GET 405');
console.log('PASS  /bc：预览/confirm 参数校验 + input.hint');
console.log('PASS  /pin、/unpin：钉住最近一轮 / 列表 / 清空');
console.log('PASS  /bctest：无 agent / 参数错误都返回 error');
console.log('PASS  /handoff：无 agent / 参数错误都返回 error');
console.log('\n15/15 passed');
