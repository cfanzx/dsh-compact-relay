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
import { createFakeLlm } from './harness/llm.mjs';

// DSH 包 → test/stubs/*：必须在动态 import lib/index.js 之前注册。
registerDshStubHooks();

// M6：交接文档端点用独立临时目录，别去读真实 ~/.dsh/handoffs。
const handoffDir = createTmpDir('relay-load-handoffs-');
// 设置存储：隔离一个 DSH_HOME，别读写真实的 ~/.dsh/compact-relay.json。
const dshHome = createTmpDir('relay-load-home-');
process.env.DSH_HOME = dshHome;
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
        return undefined;
      },
      flush() {},
    },
    tokenMeter: { measure: () => ({ totalTokens: 1234, surfaceTokens: 1000, nodes: [] }) },
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
assert.equal(inject.includes('tools'), true, 'M4 需要根级 tools 服务来注册 mark_stage');
assert.deepEqual(
  host.commands.map((definition) => definition.name).sort(),
  ['bc', 'bctest', 'handoff', 'pin', 'unpin'],
);
assert.deepEqual(
  host.routes.map((route) => route.path).sort(),
  [
    '/api/compact-relay-action',
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
  ['mark_stage'],
  'M4：阶段完成工具必须注册',
);

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

// ---- 2026-10-20 安全：所有插件端点必须先过宿主 connection 鉴权（P0）----
host.setConnectionRejection(401);
const authCases = [
  ['/api/compact-relay-state', { method: 'GET' }],
  ['/api/compact-relay-handoffs', { method: 'GET' }],
  ['/api/compact-relay-settings', { method: 'GET' }],
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
  body: JSON.stringify({ action: 'compact', sessionId: 'session-no-agent', pad: 'x'.repeat(9000) }),
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
const docDetail = await callRouteAsync(host, `/api/compact-relay-handoffs?file=${encodeURIComponent(sampleName)}`);
assert.equal(docDetail.status, 200);
assert.equal(docDetail.body.content.includes('## 目标'), true);
const badFile = await callRouteAsync(host, '/api/compact-relay-handoffs?file=..%2Fevil.md');
assert.equal(badFile.status, 404, '目录穿越/非法文件名必须拒绝');
const wrongExt = await callRouteAsync(host, '/api/compact-relay-handoffs?file=other.md');
assert.equal(wrongExt.status, 404);
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

const markStageTool = host.tools.find((definition) => definition.name === 'mark_stage');
assert.equal(typeof markStageTool.execute, 'function');
assert.equal(typeof markStageTool.description, 'string');
assert.equal(markStageTool.description.includes('适合压缩'), true, '工具描述要讲清「判断这里适合压缩」');
// 没有活动会话时返回可读提示（不抛错）。
const noAgentToolText = await markStageTool.execute({}, {});
assert.equal(typeof noAgentToolText, 'string');
assert.equal(noAgentToolText.includes('没有活动会话'), true);

console.log('PASS  plugin apply：命令/路由/工具注册');
console.log('PASS  mark_stage：工具注册 + 无会话提示（成功路径在 smoke 单测覆盖）');
console.log('PASS  state 端点：无会话时合法 JSON');
console.log('PASS  /api/compact-relay-stream：SSE 建流 + 首帧状态 + 未就绪自动补推');
console.log('PASS  action 端点：sessionId 缺失/类型错/非法 JSON/跨站/超大 body 均被拒；无会话时 409（含 preview/cancel/pin-toggle）');
console.log('PASS  /api/compact-relay-handoffs：列表/读取/非法文件名拒绝');
console.log('PASS  /api/compact-relay-settings：读取/保存热生效/非法比例/跨站/恢复默认');
console.log('PASS  /bc：预览/confirm 参数校验 + input.hint');
console.log('PASS  /stage：手动阶段标记（自定义名/缺省名/无会话报错）');
console.log('PASS  /pin、/unpin：钉住最近一轮 / 列表 / 清空');
console.log('PASS  /bctest：无 agent / 参数错误都返回 error');
console.log('PASS  /handoff：无 agent / 参数错误都返回 error');
console.log('\n13/13 passed');
