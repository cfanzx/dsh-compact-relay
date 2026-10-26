/**
 * M3 接棒内核测试 —— 纯 node 跑（不加载真实 DSH，用 mock ctx 串起完整流程）。
 *
 *   node test/handoff.mjs
 *
 * 覆盖 actions/handoff.js 的端到端编排：
 *   先精压（真跑 M2 事务，摘要用 mock LLM）→ 模型写六段文档（mock LLM）
 *   → 写盘 → ctx.agents.create 建新会话（同工作区/preset/模型）
 *   → followup 注入交接文档并起第一轮 → 返回 childId。
 * 还覆盖：文档结构不合格重试后拒绝、精压 busy 中止、挂工作区失败降级、
 * followup 不可用时退回纯 append。
 *
 * A7 起 fake session / engine / llm / ctx 统一来自 `test/harness/`，本文件只保留
 * 交接领域夹具（六段回复样本）与用例断言。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { betterCompact, cancelBetterCompact, previewBetterCompact } from '../lib/actions/better-compact.js';
import { callStream } from '../lib/dsh/llm-call.js';
import { handoff, previewHandoff } from '../lib/actions/handoff.js';
import { createInflight } from '../lib/actions/inflight.js';
import { listPins, pinByIndex, pinLastTurn, togglePin, unpinAll } from '../lib/actions/pin.js';
import { testCompact } from '../lib/actions/test-compact.js';
import { PIN_RECORD_TYPE } from '../lib/core/pins.js';
import { RELAY_RECORD_TYPE } from '../lib/core/relay.js';
import { createLedgerStore } from '../lib/dsh/ledger.js';
import { buildSiteSnapshot, gitInfo, pendingJobs } from '../lib/dsh/site-info.js';
import { livePinnedSeqs } from '../lib/dsh/session-view.js';
import { childTitleOf, createHandoffSession, handoffTitlePlanOf } from '../lib/dsh/sessions.js';
import { relayRecordOf } from '../lib/dsh/relay.js';
import { HANDOFF_PREAMBLE } from '../lib/core/prompts.js';
import { HANDOFF_SECTIONS } from '../lib/core/handoff-doc.js';
import { REQUIRED_SECTIONS } from '../lib/core/validate-summary.js';
import {
  createAgent,
  createFakeEngine,
  createHandoffHost,
  createPluginDeps,
  createTmpDir,
} from './harness/host.mjs';
import { createFakeLlm, createStuckStream } from './harness/llm.mjs';
import { MockSession, baseSourceSession } from './harness/session.mjs';

/* ---------------- 夹具：确定性回复 + fake ctx ---------------- */

function summaryReply() {
  return REQUIRED_SECTIONS.map((section) => `${section}\n- ${section}：根据本轮变更记录关键结论与证据`).join('\n');
}

function handoffReply() {
  return HANDOFF_SECTIONS.map(
    (section) => `## ${section}\n- ${section}的内容：完成验证、记录结论并标注下一步`,
  ).join('\n');
}

/** 2026-10-19 真机事故样本：六段全写 (none)，旧校验放行 → 空壳文档建了新会话。 */
function placeholderHandoffReply() {
  return HANDOFF_SECTIONS.map((section) => `## ${section}\n- (none)`).join('\n');
}

/** 按「最后一条消息含『交接文档』」分流摘要/交接单，脚本语义与旧手搓 stream 相同。 */
function makeHandoffLlm({
  handoffReplies = [handoffReply()],
  summaryReplies = [summaryReply()],
  summaryTruncateFirst = false,
  handoffTruncateFirst = false,
  reasoningSupport = true,
} = {}) {
  return createFakeLlm({
    reasoningSupport,
    routes: [
      {
        kind: 'handoff',
        match: ({ instruction }) => instruction.includes('交接文档'),
        replies: [...handoffReplies],
        truncateFirst: handoffTruncateFirst,
        truncated: '## 目标\n- 写到一半',
      },
      {
        kind: 'summary',
        match: () => true,
        replies: [...summaryReplies],
        truncateFirst: summaryTruncateFirst,
        truncated: '## Current Goal\n- 写',
      },
    ],
  });
}

/** 旧 makeCtx 的等价入口：llm + 业务 ctx + 观测 record 一起返回。 */
function makeCtx({
  handoffReplies,
  summaryReplies,
  summaryTruncateFirst = false,
  handoffTruncateFirst = false,
  reasoningSupport = true,
  ...hostOptions
} = {}) {
  const llm = makeHandoffLlm({ handoffReplies, summaryReplies, summaryTruncateFirst, handoffTruncateFirst, reasoningSupport });
  const engine = createFakeEngine();
  const { ctx, record } = createHandoffHost({ llm, engine, ...hostOptions });
  return { ctx, engine, record };
}

/* ---------------- cases ---------------- */

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

test('BUG-004：摘要第一次误返回工具调用 → 自动重试一次并成功', async () => {
  const session = baseSourceSession();
  const { ctx, engine, record } = makeCtx({
    summaryReplies: [{ text: '', finish: 'tool-calls' }, summaryReply()],
  });
  const ledgerFile = path.join(createTmpDir('relay-ledger-compact-'), 'compact-relay-ledger.jsonl');
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  deps.ledger = createLedgerStore({ file: ledgerFile });
  const outcome = await betterCompact(deps, { agent: createAgent(session) });
  assert.equal(outcome.compacted, true, '工具调用只是模型跑偏，重试后应当成功压缩');
  assert.equal(record.llmCalls.filter((call) => call.kind === 'summary').length, 2, '第一次工具调用后必须重试一次');

  // 0.4 P1-3：压缩成功后轻账本要新增一条字段完整的 compact 记录（只记数值，不含消息/摘要）。
  const compactLines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n');
  assert.equal(compactLines.length, 1, '一次压缩只记一条账本记录（交接内部压缩不会重复记）');
  const compactEntry = JSON.parse(compactLines[0]);
  assert.equal(compactEntry.schema, 'dcr-ledger/v1');
  assert.equal(compactEntry.kind, 'compact');
  assert.equal(typeof compactEntry.at, 'string');
  assert.equal(typeof compactEntry.durationMs, 'number');
  assert.equal(typeof compactEntry.beforeTokens, 'number');
  assert.equal(Number.isInteger(compactEntry.afterTokens), true, '压后占用也要测出来');
  assert.equal(compactEntry.freedTokens, compactEntry.beforeTokens - compactEntry.afterTokens);
  assert.equal(typeof compactEntry.beforeRatio, 'number');
  assert.equal(typeof compactEntry.afterRatio, 'number');
  assert.deepEqual(compactEntry.pinHits, { inRange: 0, total: 0 });
  assert.equal(compactEntry.handoff, null);
  assert.equal(JSON.stringify(compactEntry).includes('已记录压缩节点'), false, '账本不记摘要/消息正文');
});

test('BUG-004：交接前压缩失败 → 完成提示带具体原因和 /bc 建议（不再只说「详见日志」）', async () => {
  const session = baseSourceSession();
  const { ctx, engine } = makeCtx({ summaryReplies: [{ text: '', finish: 'tool-calls' }] });
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  // 0.4 P1-3 降级：账本写失败/抛错绝不能影响交接本体。
  deps.ledger = {
    record() {
      throw new Error('ledger is on fire');
    },
  };
  const result = await handoff(deps, { agent: createAgent(session), commandId: 'cmd-handoff' });
  assert.equal(result.ok, true, '压缩失败不阻塞交接');
  assert.equal(result.message.includes('压缩失败已跳过（'), true);
  assert.equal(result.message.includes('调用工具'), true, '提示要带具体原因');
  assert.equal(result.message.includes('/bc'), true, '提示要给出可操作建议');
});

test('M3 全流程：先精压 → 写成六段文档 → 建子会话 → followup 起轮 → 自动切换用 childId', async () => {
  const session = baseSourceSession();
  const { ctx, engine, record } = makeCtx();
  const handoffDir = createTmpDir('relay-m3-');
  const deps = createPluginDeps({ ctx, engine, handoffDir });
  const ledgerFile = path.join(createTmpDir('relay-ledger-handoff-'), 'compact-relay-ledger.jsonl');
  deps.ledger = createLedgerStore({ file: ledgerFile });

  const result = await handoff(deps, { agent: createAgent(session), commandId: 'cmd-handoff' });

  // 1) 返回：childId + 文档路径 + 已起轮
  assert.match(result.childId, /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(result.path, path.join(handoffDir, path.basename(result.path)));
  assert.equal(result.started, true);
  assert.equal(result.message.includes(result.childId), true);
  assert.equal(result.message.includes(result.path), true);
  assert.equal(result.message.includes('压成 1 条摘要'), true);

  // 2) 文档真的落盘，六段齐全且按顺序，元信息对
  const doc = fs.readFileSync(result.path, 'utf8');
  assert.equal(doc.startsWith('# 交接单'), true);
  assert.equal(doc.includes('原会话：source-session'), true);
  assert.equal(doc.includes('原会话标题：原会话标题'), true);
  // M6：文档头带现场快照（宿主启动时长 / 工作区 / 后台任务 / 模型），别出厂即过时。
  assert.equal(doc.includes('运行状态：DSH 本次启动于'), true, '文档头要写宿主启动现场');
  assert.equal(doc.includes('工作目录：/tmp/relay-test-ws（非 git 仓库）'), true, '工作区与 git 状态');
  assert.equal(doc.includes('后台任务：无'), true, '没有后台任务要写「无」');
  assert.equal(doc.includes('当前模型：mock/mock-model'), true, '现场要记模型路由');
  const positions = HANDOFF_SECTIONS.map((section) => doc.indexOf(`## ${section}`));
  assert.equal(positions.every((pos) => pos > 0), true);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.equal(fs.readdirSync(handoffDir).length, 1);

  // 2.5) 0.4 P1-3：交接成功后轻账本新增一条 handoff 记录（只记数值 + 交接单路径，不含正文）。
  const ledgerLines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n');
  assert.equal(ledgerLines.length, 1, '一次交接只记一条账本记录');
  const handoffEntry = JSON.parse(ledgerLines[0]);
  assert.equal(handoffEntry.schema, 'dcr-ledger/v1');
  assert.equal(handoffEntry.kind, 'handoff');
  assert.equal(typeof handoffEntry.durationMs, 'number');
  assert.equal(Number.isInteger(handoffEntry.beforeTokens), true);
  assert.equal(Number.isInteger(handoffEntry.afterTokens), true);
  assert.equal(handoffEntry.freedTokens, handoffEntry.beforeTokens - handoffEntry.afterTokens);
  assert.deepEqual(handoffEntry.pinHits, { inRange: 0, total: 0 });
  assert.equal(handoffEntry.handoff.path, result.path, '账本要记交接单落盘路径');
  assert.equal(handoffEntry.handoff.childId, result.childId);
  assert.equal(handoffEntry.handoff.started, true);
  assert.equal(JSON.stringify(handoffEntry).includes('## 总体目标'), false, '账本不许包含交接单正文');

  // 3) 先精压：源会话里发生了完整事务，surface 已被摘要替换
  const types = session.log.map((event) => event.type);
  assert.equal(types.includes('compaction/start'), true);
  assert.equal(types.includes('compaction/summary'), true);
  assert.equal(types.includes('compaction/end'), true);
  assert.equal(session.surface.nodes.length, 2, 'system + 一条摘要');
  assert.deepEqual(record.llmCalls.map((call) => call.kind), ['summary', 'handoff'], '先摘要后交接文档');
  for (const call of record.llmCalls) {
    assert.equal(call.reasoningEffort, 'off', '侧调用不该继承源会话的 reasoningEffort（会把 maxTokens 吃光）');
    assert.equal(call.maxTokens, 8192);
  }

  // 4) 新会话：同工作区 / 同 preset / 同模型路由
  assert.equal(record.createCalls.length, 1);
  const create = record.createCalls[0];
  assert.equal(create.sessionId, result.childId);
  assert.deepEqual(create.meta, { cwd: '/tmp/relay-test-ws', parentSession: 'source-session', agentPreset: 'preset-x' });
  assert.deepEqual(create.agentOptions, { provider: 'mock', model: 'mock-model', reasoningEffort: 'max' });
  assert.equal(typeof create.setup, 'function');
  await create.setup({});
  assert.deepEqual(record.resolves, ['preset-x']);
  assert.deepEqual(record.mounts, ['preset-x']);

  // 5) 工作区挂载 + 标题
  assert.deepEqual(record.attached, [{ cwd: '/tmp/relay-test-ws', sessionId: result.childId }]);
  assert.deepEqual(record.renames, [{ sessionId: result.childId, title: '交接第 1 次：原会话标题' }]);

  // 5.5) A5 接力链：父会话日志里要有一条结构化 relay 记录（不读文案）。
  const relayEvents = session.log.filter((event) => event.type === 'plugin:compact-relay/relay');
  assert.equal(relayEvents.length, 1);
  const relay = relayEvents[0].data;
  assert.equal(relay.parentSessionId, 'source-session');
  assert.equal(relay.childId, result.childId);
  assert.equal(relay.index, 1);
  assert.equal(relay.baseTitle, '原会话标题');
  assert.equal(relay.path, result.path);
  assert.equal(relay.title, '交接第 1 次：原会话标题');
  // 0.4 P2-2：接力链元数据补全（canonical 字段 + 本地 ISO 时间），首次交接 ordinal=1。
  assert.equal(relay.parentId, 'source-session');
  assert.equal(relay.ordinal, 1, '首次交接 ordinal=1');
  assert.equal(Number.isInteger(relay.at), true);
  assert.equal(typeof relay.atIso, 'string', '交接记录要带可读的本地时间');
  // 0.4.3 F2：新字段只放行读取；父会话 relay 记录的写出内容保持原样（现网数据安全）。
  assert.equal('scheme' in relay, false);
  assert.equal('titleSeq' in relay, false);
  assert.equal('historyTitle' in relay, false);
  assert.equal(doc.includes('- 交接序号：第 1 次交接'), true, '交接单头要写「第 N 次交接」');
  assert.equal(result.message.includes('#child=' + result.childId), true, '正文要带结构化 childId 兜底');

  // 6) 交接文档作为新会话第一条消息注入，并起了第一轮
  assert.equal(record.followups.length, 1);
  const message = record.followups[0];
  assert.equal(message.source.kind, 'plugin:compact-relay', 'v4 只认 plugin:<name>，kind=plugin 会被拒');
  assert.equal(message.source.form, 'handoff');
  const text = message.content.map((block) => block.text).join('\n');
  assert.equal(text.startsWith(HANDOFF_PREAMBLE), true);
  assert.equal(text.includes('原会话：source-session'), true);
  for (const section of HANDOFF_SECTIONS) assert.equal(text.includes(`## ${section}`), true);
  assert.deepEqual(record.child.log.map((event) => event.type).slice(0, 2), ['user/message', 'turn/start']);

  // 5.7) 0.5.0 F3：子会话自己带一条接力链记录（旧会话改名后链号不靠标题解析）。
  const childRelays = record.child.log.filter((event) => event.type === RELAY_RECORD_TYPE);
  assert.equal(childRelays.length, 1, '子会话日志恰有 1 条 relay 记录');
  const childRelayEvent = childRelays[0];
  const childRelay = childRelayEvent.data;
  assert.equal(childRelayEvent.ignorable, true, '走 plugin record 通道（不进模型上下文）');
  assert.equal(record.child.surface.nodes.includes(childRelayEvent.seq), false, '记录不进模型可见 surface（不算 token）');
  assert.equal(childRelayEvent.seq, record.child.log.length - 1, '写在 followup 之后、flush 之前（日志最后一条）');
  assert.equal(childRelay.parentId, 'source-session');
  assert.equal(childRelay.childId, result.childId);
  assert.equal(childRelay.ordinal, 1, '子会话记录 ordinal=1');
  assert.equal(childRelay.baseTitle, '原会话标题');
  assert.equal(childRelay.title, '交接第 1 次：原会话标题');
  assert.equal(childRelay.scheme, 'handoff-n');
  assert.equal(Number.isInteger(childRelay.at), true);
  assert.equal(typeof childRelay.atIso, 'string', '时间字段与父记录同格式');
  assert.equal(childRelay.titleSeq, null, '默认替身 rename 不返回 eventSeq → null（取不到不猜）');
  assert.equal('historyTitle' in childRelay, false, 'handoff-n 记录不写 historyTitle');
  // 标准读取器能读回新字段；链号从子会话记录推进（这里标题是干净的原题，解析必得 0）。
  const childRead = relayRecordOf(record.child);
  assert.equal(childRead.ordinal, 1);
  assert.equal(childRead.index, 1, 'normalize 补齐 0.3 旧字段别名');
  assert.equal(childRead.parentSessionId, 'source-session');
  assert.equal(childRead.scheme, 'handoff-n');
  assert.equal(childRead.titleSeq, null);
  const nextPlan = handoffTitlePlanOf(ctx, record.child);
  assert.equal(nextPlan.viaRecord, true, '下一次交接必须走 record，不回退标题解析');
  assert.equal(nextPlan.index, 2, '0.5.0 子会话标题变干净后，链号仍靠 record 递增（不重复 1）');
  assert.equal(nextPlan.baseTitle, '原会话标题');
});

test('A1b 交接预览：九段草稿 + 就绪清单，不写盘/不建会话/不压历史', async () => {
  const session = baseSourceSession();
  const { ctx, engine, record } = makeCtx();
  const handoffDir = createTmpDir('relay-a1b-');
  const deps = createPluginDeps({ ctx, engine, handoffDir });
  // 0.4 P1-2：先锁一条消息（seq2 = surface 上的 assistant 消息）→ 交接单程序段要带锚点。
  session.appendPluginRecord(PIN_RECORD_TYPE, { seqs: [2], at: Date.now() });

  const result = await previewHandoff(deps, { agent: createAgent(session) });

  assert.equal(result.ok, true);
  assert.equal(result.readiness.ok, true, '九段齐全，readiness 通过');
  assert.equal(result.readiness.missing.length, 0);
  assert.equal(typeof result.draft, 'string');
  for (const section of HANDOFF_SECTIONS) assert.equal(result.draft.includes(`## ${section}`), true);
  assert.equal(result.draft.includes('## 当前进度'), true);
  assert.equal(result.draft.includes('## 改过的文件'), true);
  // 0.4 P1-2：pin 保留契约——「当前进度」里要有锚点（seq + 角色 + 一句摘要），九段结构不变。
  assert.equal(result.draft.includes('锁定锚点（保留契约'), true, '交接单要列出 pin 保留契约锚点');
  assert.equal(result.draft.includes('seq 2 · 助手'), true, '锚点要带 seq 与角色标签');
  assert.equal(fs.readdirSync(handoffDir).length, 0, '预览不写盘');
  assert.equal(record.createCalls.length, 0, '预览不建会话');
  assert.equal(session.log.some((event) => event.type === 'compaction/start'), false, '预览不压缩');
  assert.deepEqual(record.llmCalls.map((call) => call.kind), ['handoff'], '只调一次交接文档生成');
});

test('P2-1 交接预览可编辑：只让「约束 / 下一步」生效，程序段不可改', async () => {
  // 预览接口暴露两段可编辑视图（客户端只渲染这两段）。
  const previewSession = baseSourceSession();
  const previewContext = makeCtx();
  const previewDeps = createPluginDeps({
    ctx: previewContext.ctx,
    engine: previewContext.engine,
    handoffDir: createTmpDir('relay-p21-preview-'),
  });
  const preview = await previewHandoff(previewDeps, { agent: createAgent(previewSession) });
  assert.deepEqual(preview.editable.titles, ['约束', '下一步'], '只允许编辑两段');
  assert.equal(preview.editable.sections['约束'].includes('约束的内容'), true, '预览带上当前原文');
  assert.equal(preview.editable.note.includes('不能改'), true, '要说明程序生成段不可改');
  assert.equal(preview.ordinal, 1, 'P2-2：预览也知道本次是第几次交接');

  // 确认交接时带编辑 → 落盘内容用编辑后的两段；程序段/其它模型段原样。
  const session = baseSourceSession();
  const { ctx, engine } = makeCtx();
  const handoffDir = createTmpDir('relay-p21-');
  const deps = createPluginDeps({ ctx, engine, handoffDir });
  const result = await handoff(deps, {
    agent: createAgent(session),
    commandId: 'cmd-handoff',
    edits: { 约束: '用户补充的约束：禁止修改公开 API', 下一步: '用户补充的下一步：先跑 npm test 再提交' },
  });
  const doc = fs.readFileSync(result.path, 'utf8');
  assert.equal(doc.includes('## 约束\n用户补充的约束：禁止修改公开 API'), true, '编辑后的约束要写进交接单');
  assert.equal(doc.includes('## 下一步\n用户补充的下一步：先跑 npm test 再提交'), true);
  assert.equal(doc.includes('约束的内容：完成验证'), false, '原约束被覆盖');
  assert.equal(doc.includes('总体目标的内容'), true, '不可编辑段保持模型原文');
  assert.equal(doc.includes('锁定消息：'), true, '程序段（当前进度）保持程序生成内容');

  // 非法字段（程序段）→ code=edits，且在压缩/写盘之前拒绝（零副作用）。
  const badDir = createTmpDir('relay-p21-bad-');
  const badSession = baseSourceSession();
  const bad = makeCtx();
  const badDeps = createPluginDeps({ ctx: bad.ctx, engine: bad.engine, handoffDir: badDir });
  await assert.rejects(
    handoff(badDeps, { agent: createAgent(badSession), edits: { 当前进度: '伪造进度' } }),
    (error) => {
      assert.equal(error.code, 'edits');
      assert.equal(error.message.includes('只能编辑'), true, '错误信息要说明只能改两段');
      return true;
    },
  );
  assert.equal(fs.readdirSync(badDir).length, 0, '非法编辑不写盘');
  assert.equal(badSession.log.some((event) => event.type === 'compaction/start'), false, '非法编辑零副作用（不压缩）');

  // 超长拒绝（不静默截断）。
  await assert.rejects(
    handoff(badDeps, { agent: createAgent(badSession), edits: { 约束: 'x'.repeat(4001) } }),
    (error) => error.code === 'edits',
  );

  // 空编辑 = 用生成原文（回落，不覆盖）。
  const emptySession = baseSourceSession();
  const emptyContext = makeCtx();
  const emptyDeps = createPluginDeps({
    ctx: emptyContext.ctx,
    engine: emptyContext.engine,
    handoffDir: createTmpDir('relay-p21-empty-'),
  });
  const emptyResult = await handoff(emptyDeps, { agent: createAgent(emptySession), edits: { 约束: '   ' } });
  const emptyDoc = fs.readFileSync(emptyResult.path, 'utf8');
  assert.equal(emptyDoc.includes('## 约束\n- 约束的内容：完成验证'), true, '空编辑回落生成原文');
});

test('P2-2 接力链元数据：链式第 2 次交接 ordinal=2、parent 指向正确', async () => {
  const session = baseSourceSession(); // id=source-session，模拟「从子会话继续交接」
  // 上一次交接记录（0.3 旧字段形状也兼容）：本会话由 session-gp 交接而来，是第 1 次交接。
  session.log.push({
    type: 'plugin:compact-relay/relay',
    ignorable: true,
    seq: session.log.length,
    data: {
      parentSessionId: 'session-gp',
      childId: 'source-session',
      index: 1,
      baseTitle: '原会话标题',
      at: 1,
    },
  });
  const { ctx, engine, record } = makeCtx();
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-p22-') });
  const result = await handoff(deps, { agent: createAgent(session), commandId: 'cmd-handoff-2' });

  const relays = session.log.filter((event) => event.type === 'plugin:compact-relay/relay');
  assert.equal(relays.length, 2, '父会话里应追加第二条接力链记录');
  const latest = relays.at(-1).data;
  assert.equal(latest.parentId, 'source-session', 'parent 指向本次交接的父会话');
  assert.equal(latest.childId, result.childId, 'child 指向新建的子会话');
  assert.equal(latest.ordinal, 2, '链式第 2 次交接 ordinal=2');
  assert.equal(latest.index, 2, '旧字段同步（兼容 0.3 读法）');
  assert.equal(typeof latest.atIso, 'string', '带可读本地时间');
  const doc = fs.readFileSync(result.path, 'utf8');
  assert.equal(doc.includes('- 交接序号：第 2 次交接'), true, '交接单头显示第 2 次交接');

  // 0.4.4 F3：子会话记录接着父记录的链（2），不是重新从 1 开始。
  const childRelays = record.child.log.filter((event) => event.type === RELAY_RECORD_TYPE);
  assert.equal(childRelays.length, 1);
  assert.equal(childRelays[0].data.ordinal, 2);
  assert.equal(childRelays[0].data.baseTitle, '原会话标题');
  assert.equal(childRelays[0].data.scheme, 'handoff-n');
  assert.equal(handoffTitlePlanOf(ctx, record.child).index, 3, '第三次交接从子会话记录继续');
});

test('0.4.4 F3：rename 快照的 eventSeq → 子会话记录 titleSeq；0/缺失都不写非法值', async () => {
  {
    const session = baseSourceSession();
    const { ctx, engine, record } = makeCtx({ renameEventSeq: 12 });
    const child = await createHandoffSession({
      ctx,
      engine,
      session,
      doc: '# 交接单\n\n## 目标\n- F3 titleSeq 数字路径',
      title: '交接第 1 次：原会话标题',
    });
    assert.equal(child.childId, record.child.id);
    const relays = record.child.log.filter((event) => event.type === RELAY_RECORD_TYPE);
    assert.equal(relays.length, 1);
    assert.equal(relays[0].data.titleSeq, 12, 'rename 返回的 eventSeq 要写进子会话记录');
    assert.equal(relayRecordOf(record.child).titleSeq, 12, 'normalize 能读回数字 titleSeq');
    assert.equal(
      session.log.some((event) => event.type === RELAY_RECORD_TYPE),
      false,
      'createHandoffSession 只写子会话；父记录由 handoff 编排写',
    );
  }
  {
    const session = baseSourceSession();
    const { ctx, engine, record } = makeCtx({ renameEventSeq: 0 });
    await createHandoffSession({ ctx, engine, session, doc: 'doc', title: '交接第 1 次：原会话标题' });
    const relays = record.child.log.filter((event) => event.type === RELAY_RECORD_TYPE);
    assert.equal(relays[0].data.titleSeq, null, 'eventSeq=0 不在 relay 白名单（正整数）内 → null，不写非法值');
    assert.equal(relayRecordOf(record.child).titleSeq, null);
    assert.equal(relayRecordOf(record.child).ordinal, 1, 'titleSeq 缺失不影响链号');
  }
});

test('0.4.4 F3 端到端：第 1 次交接的子会话再交接 → 第 2 次（标题干净也不重复）', async () => {
  const session = baseSourceSession();
  const { ctx, engine, record } = makeCtx();
  const firstDeps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-f3-chain-1-') });
  await handoff(firstDeps, { agent: createAgent(session) });
  const child = record.child;
  assert.equal(relayRecordOf(child).ordinal, 1, '第 1 次交接的子会话带 ordinal=1 记录');

  // 0.5.0 场景：子会话标题里不再有「交接第 N 次」（fixture 的标题服务恒返回原题）。
  // 没有子会话记录时 splitHandoffTitle('原会话标题') → handedOff=0，会再出「第 1 次」。
  const secondDeps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-f3-chain-2-') });
  const second = await handoff(secondDeps, { agent: createAgent(child) });
  const grandchild = record.child;
  const doc = fs.readFileSync(second.path, 'utf8');
  assert.equal(doc.includes('- 交接序号：第 2 次交接'), true, '第 2 次交接序号必须递增，不重复第 1 次');
  assert.equal(second.childId, grandchild.id);
  assert.equal(relayRecordOf(grandchild).ordinal, 2, '孙会话记录 ordinal=2');
  assert.equal(relayRecordOf(grandchild).baseTitle, '原会话标题');
  assert.equal(grandchild.log.filter((event) => event.type === RELAY_RECORD_TYPE).length, 1);
});

test('M3：文档结构不合格 → 带 recovery 重试一次，仍不合格则拒绝且不建会话', async () => {
  const session = baseSourceSession();
  const { ctx, engine, record } = makeCtx({ handoffReplies: ['只有一段，没有六段', '还是没有六段'] });
  const handoffDir = createTmpDir('relay-m3-');
  const deps = createPluginDeps({ ctx, engine, handoffDir });

  await assert.rejects(handoff(deps, { agent: createAgent(session) }), (error) => {
    assert.equal(error.code, 'handoff');
    assert.equal(/不合格|缺少小节/.test(error.message), true);
    return true;
  });

  // 两次交接文档调用（第二次带 recovery 提示）
  const handoffCalls = record.llmCalls.filter((call) => call.kind === 'handoff');
  assert.equal(handoffCalls.length, 2);
  const retryInstruction = handoffCalls[1].messages.at(-1).content.map((block) => block.text).join('\n');
  assert.equal(retryInstruction.includes('被拒绝'), true);
  assert.equal(record.createCalls.length, 0, '文档不合格不建新会话');
  assert.equal(fs.readdirSync(handoffDir).length, 0, '文档不合格不写盘');
});

test('M3：六段全 (none) 的空壳文档 → 拒绝后再试，重试合格才建会话', async () => {
  const session = baseSourceSession();
  const { ctx, engine, record } = makeCtx({ handoffReplies: [placeholderHandoffReply(), handoffReply()] });
  const handoffDir = createTmpDir('relay-m3-');
  const deps = createPluginDeps({ ctx, engine, handoffDir });

  const result = await handoff(deps, { agent: createAgent(session) });

  // 第一次被判占位符、第二次带原因重试成功
  const handoffCalls = record.llmCalls.filter((call) => call.kind === 'handoff');
  assert.equal(handoffCalls.length, 2);
  const retryInstruction = handoffCalls[1].messages.at(-1).content.map((block) => block.text).join('\n');
  assert.equal(retryInstruction.includes('被拒绝'), true);
  assert.equal(retryInstruction.includes('占位符'), true, '重试指令要说明上次为什么被拒');
  assert.equal(record.createCalls.length, 1, '重试合格后正常建会话');
  const doc = fs.readFileSync(result.path, 'utf8');
  assert.equal(doc.includes('目标的内容'), true);
  assert.equal(/## 目标\n- \(none\)/.test(doc), false, '落盘文档不能是空壳');
});

test('M3：空壳文档连续两次 → 拒绝且不建会话', async () => {
  const session = baseSourceSession();
  const { ctx, engine, record } = makeCtx({
    handoffReplies: [placeholderHandoffReply(), placeholderHandoffReply()],
  });
  const handoffDir = createTmpDir('relay-m3-');
  const deps = createPluginDeps({ ctx, engine, handoffDir });

  await assert.rejects(handoff(deps, { agent: createAgent(session) }), (error) => {
    assert.equal(error.code, 'handoff');
    assert.equal(error.message.includes('占位符'), true);
    return true;
  });
  assert.equal(record.createCalls.length, 0, '空壳文档不建新会话');
  assert.equal(fs.readdirSync(handoffDir).length, 0, '空壳文档不写盘');
});

test('M3：精压 busy（agent 正在跑）→ 直接中止，不写文档不建会话', async () => {
  const session = baseSourceSession();
  const { ctx, engine, record } = makeCtx();
  const handoffDir = createTmpDir('relay-m3-');
  const deps = createPluginDeps({ ctx, engine, handoffDir });
  const agent = createAgent(session, {
    runMaintenance() {
      throw new Error('agent "source-session" already has active work');
    },
  });

  await assert.rejects(handoff(deps, { agent }), (error) => error.code === 'busy');
  assert.equal(record.llmCalls.length, 0);
  assert.equal(record.createCalls.length, 0);
  assert.equal(fs.readdirSync(handoffDir).length, 0);
});

test('M3：挂工作区失败 → 降级但接棒成功', async () => {
  const session = baseSourceSession();
  const { ctx, engine, record } = makeCtx({ registryBroken: true });
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  const warnings = [];
  deps.log = { warn: (message) => warnings.push(message) };

  const result = await handoff(deps, { agent: createAgent(session) });
  assert.equal(typeof result.childId, 'string');
  assert.equal(record.followups.length, 1);
  assert.equal(
    warnings.some((message) => message.includes('挂工作区失败')),
    true,
  );
});

test('M3：agent 不支持 followup → 退回纯 append，报告未起轮', async () => {
  const session = baseSourceSession();
  const { ctx, engine, record } = makeCtx({ childHasFollowup: false });
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  deps.log = { warn() {} };

  const result = await handoff(deps, { agent: createAgent(session) });
  assert.equal(result.started, false);
  assert.equal(result.message.includes('正在切换'), true);
  const child = record.child;
  const userMessages = child.log.filter((event) => event.type === 'user/message');
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0].surfaceOp, 'append');
  assert.equal(child.log.some((event) => event.type === 'turn/start'), false);
});

test('M3：没有可交接的消息 / 没有模型路由 → 明确报错', async () => {
  const empty = new MockSession();
  // 空 surface：generateHandoffDoc 的 prefix 为空 → 报错
  {
    const { ctx, engine } = makeCtx();
    const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
    await assert.rejects(handoff(deps, { agent: createAgent(empty) }), (error) => error.code === 'handoff');
  }
  // 会话 header 没有 preset、requestHeader 空、agent 也没路由 → 建会话时找不到 provider/model
  {
    const session = baseSourceSession();
    session.requestHeader = () => undefined;
    const { ctx, engine } = makeCtx();
    delete ctx.get;
    const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
    const agent = { id: session.id, session, options: {} };
    await assert.rejects(handoff(deps, { agent }), (error) => {
      assert.equal(error.code, 'handoff');
      assert.equal(error.message.includes('provider/model'), true);
      return true;
    });
  }
});

test('M3：摘要输出被截断 → 带“写短”提示自动重试一次后成功', async () => {
  const session = baseSourceSession();
  const { ctx, engine, record } = makeCtx({ summaryTruncateFirst: true });
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  const result = await handoff(deps, { agent: createAgent(session) });

  assert.equal(typeof result.childId, 'string');
  const summaryCalls = record.llmCalls.filter((call) => call.kind === 'summary');
  assert.equal(summaryCalls.length, 2, '截断后应重试一次');
  assert.equal(summaryCalls[0].reasoningEffort, 'off');
  const retryInstruction = summaryCalls[1].messages.at(-1).content.map((block) => block.text).join('\n');
  assert.equal(retryInstruction.includes('截断'), true, '重试指令要说明为什么被拒');
  assert.equal(session.log.some((event) => event.type === 'compaction/end' && event.data?.error !== undefined), false);
});

test('M3：交接文档输出被截断 → 自动重试一次后成功', async () => {
  const session = baseSourceSession();
  const { ctx, engine, record } = makeCtx({ handoffTruncateFirst: true });
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  const result = await handoff(deps, { agent: createAgent(session) });
  assert.equal(typeof result.childId, 'string');
  const handoffCalls = record.llmCalls.filter((call) => call.kind === 'handoff');
  assert.equal(handoffCalls.length, 2);
  assert.equal(handoffCalls[1].reasoningEffort, 'off');
});

test('P2-5：非推理模型不传 reasoningEffort（不再硬编码 off）', async () => {
  const session = baseSourceSession();
  const { ctx, engine, record } = makeCtx({ reasoningSupport: false });
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  await handoff(deps, { agent: createAgent(session) });
  const summaryCall = record.llmCalls.find((call) => call.kind === 'summary');
  const handoffCall = record.llmCalls.find((call) => call.kind === 'handoff');
  assert.equal(summaryCall.reasoningEffort, undefined, '非推理模型不该传 reasoningEffort');
  assert.equal(handoffCall.reasoningEffort, undefined, '交接单调用同理');
});

test('A2 调用壳：超时 → timeout；取消 → cancelled', async () => {
  const engine = createFakeEngine();
  // 卡住直到 abort 的流：harness 的 createStuckStream 覆盖旧手写 generator。
  const timeoutCtx = { llm: { stream: createStuckStream() } };
  await assert.rejects(
    callStream({ ctx: timeoutCtx, engine, options: {}, timeoutMs: 30, label: '测试调用', retry: false }),
    (error) => {
      assert.equal(error.code, 'timeout');
      return true;
    },
  );

  const cancelCtx = { llm: { stream: createStuckStream() } };
  const controller = new AbortController();
  const pending = callStream({
    ctx: cancelCtx,
    engine,
    options: {},
    timeoutMs: 5000,
    label: '测试调用',
    retry: false,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'cancelled');
    return true;
  });
});

/* ---------------- M6：精压预览 / 确认 / 取消 ---------------- */

test('M6 预览：只算范围，不写会话日志', async () => {
  const session = baseSourceSession();
  const { ctx, engine } = makeCtx();
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  const before = session.log.length;

  const preview = await previewBetterCompact(deps, { agent: createAgent(session) });
  assert.equal(preview.ok, true);
  assert.equal(preview.compacted, false);
  assert.notEqual(preview.preview, null);
  assert.equal(preview.preview.nodes > 0, true, '应算出可压条数');
  assert.equal(preview.preview.tokens > 0, true, '应算出可压 token');
  assert.equal(Number.isInteger(preview.preview.startSeq), true);
  assert.equal(preview.preview.endSeq > preview.preview.startSeq, true);
  // 0.3.1：范围太小时预览会换成「建议再聊几轮」并禁用确认，不再给 /bc confirm 提示。
  assert.equal(preview.preview.tooSmall, preview.preview.tokens < 800);
  if (preview.preview.tooSmall) {
    assert.equal(preview.message.includes('这段偏小'), true, '小范围要在预览阶段就提示');
    assert.equal(preview.message.includes('确认执行'), false);
  } else {
    assert.equal(preview.message.includes('确认执行：/bc confirm'), true, '预览文案要告诉用户怎么确认');
  }
  assert.equal(session.log.length, before, '预览不许写任何会话事件');
});

test('A3 确认绑定：预览后范围变化 → changed，且不写历史', async () => {
  const session = baseSourceSession();
  const { ctx, engine } = makeCtx();
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  const agent = createAgent(session);

  const preview = await previewBetterCompact(deps, { agent });
  assert.equal(typeof preview.planId, 'string');
  // 模拟确认期间 agent 又跑完一轮：追加一条 surface 消息。
  session.append('user/message', { message: { role: 'user', content: [] } });
  const after = await previewBetterCompact(deps, { agent });
  assert.notEqual(after.planId, preview.planId, '测试前提：追加消息后压缩范围应变化');

  await assert.rejects(betterCompact(deps, { agent, expected: { planId: preview.planId } }), (error) => {
    assert.equal(error.code, 'changed');
    return true;
  });
  assert.equal(session.log.some((event) => event.type === 'compaction/summary'), false, '范围变了不能偷偷写历史');
  assert.equal(deps.lock.isBusy(agent.id), false, '拒绝后要释放锁');
});

test('M6 确认执行：真正写摘要，登记表与锁都释放', async () => {
  const session = baseSourceSession();
  const { ctx, engine } = makeCtx();
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  deps.inflight = createInflight();
  const agent = createAgent(session);

  const outcome = await betterCompact(deps, { agent });
  assert.equal(outcome.compacted, true);
  assert.equal(session.log.some((event) => event.type === 'compaction/summary'), true);
  assert.equal(deps.inflight.isActive(agent.id), false, '执行完必须清登记（否则下次取消会误伤）');
  assert.equal(deps.lock.isBusy(agent.id), false);
});

test('M6 取消：摘要卡住时 abort → 事务安全收尾、历史不变、锁释放', async () => {
  const session = baseSourceSession();
  const { ctx, engine } = makeCtx();
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  deps.inflight = createInflight();

  // 摘要流卡住，直到收到 abort 才 reject（模拟「正在等模型输出」）。
  let markStarted;
  const summarizeStarted = new Promise((resolve) => {
    markStarted = resolve;
  });
  ctx.llm.routes.find((route) => route.kind === 'summary').stream = createStuckStream({ onStart: markStarted });

  const agent = createAgent(session);
  let rejected;
  const pending = betterCompact(deps, { agent }).catch((error) => {
    rejected = error;
    throw error;
  });
  pending.catch(() => {});
  await summarizeStarted;

  assert.equal(deps.inflight.isActive(agent.id), true, '执行中应有登记');
  const cancel = cancelBetterCompact(deps, { agent });
  assert.equal(cancel.cancelled, true);
  await pending.catch(() => {});

  assert.equal(rejected?.code, 'cancelled', '取消要归一到 cancelled');
  assert.equal(deps.inflight.isActive(agent.id), false, '取消后要清登记');
  assert.equal(deps.lock.isBusy(agent.id), false, '取消后要释放锁');
  assert.equal(session.log.some((event) => event.type === 'compaction/summary'), false, '取消不能落摘要');
  assert.equal(session.log.some((event) => event.type === 'user/message' && event.surfaceOp?.op === 'replace'), false, '取消不能改历史');
  assert.equal(
    session.log.some((event) => event.type === 'compaction/end' && event.data?.error !== undefined),
    true,
    '必须补一条带 error 的 compaction/end（否则会话会被未闭合压缩锁住）',
  );
});

test('P1-4 交接可取消：inflight 登记 handoff，取消后锁释放且不建新会话', async () => {
  const session = baseSourceSession();
  const { ctx, engine, record } = makeCtx();
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  deps.inflight = createInflight();

  // 只让「交接单」这条 route 卡住；摘要调用仍走确定性回复。
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  ctx.llm.routes.find((route) => route.kind === 'handoff').stream = createStuckStream({ onStart: markStarted });

  const agent = createAgent(session);
  let rejected;
  const pending = handoff(deps, { agent }).catch((error) => {
    rejected = error;
    throw error;
  });
  pending.catch(() => {});
  await started;

  assert.equal(deps.inflight.kindOf(agent.id), 'handoff', '交接期间应登记 kind=handoff');
  const cancel = cancelBetterCompact(deps, { agent });
  assert.equal(cancel.cancelled, true);
  assert.equal(cancel.kind, 'handoff');
  assert.equal(cancel.message.includes('交接'), true);
  await pending.catch(() => {});

  assert.equal(rejected?.code, 'cancelled');
  assert.equal(deps.inflight.isActive(agent.id), false);
  assert.equal(deps.lock.isBusy(agent.id), false);
  assert.equal(record.createCalls.length, 0, '取消后不能建新会话');
});

test('P2-2 交接 preflight：目录不可写 → 在压缩前失败，历史不动', async () => {
  const session = baseSourceSession();
  const { ctx, engine } = makeCtx();
  // 平台差异（Windows）：'/dev/null/not-a-dir' 在 Windows 上只是普通路径、管理员下可能建得出来；
  // 改成「拿一个普通文件当父目录」→ 两个平台 mkdir 都会 ENOTDIR，稳定复现不可写。
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-preflight-')), 'blocker-file');
  fs.writeFileSync(blocker, 'x');
  const deps = createPluginDeps({ ctx, engine, handoffDir: path.join(blocker, 'not-a-dir') });
  await assert.rejects(handoff(deps, { agent: createAgent(session) }), (error) => {
    assert.equal(error.code, 'handoff');
    return true;
  });
  assert.equal(session.log.some((event) => event.type === 'compaction/summary'), false, 'preflight 失败不能先压历史');
});

test('M6 预览：宿主正忙时明确返回 busy，不抢锁', async () => {
  const session = baseSourceSession();
  const { ctx, engine } = makeCtx();
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  const agent = createAgent(session);
  deps.lock.tryAcquire(agent.id);
  let code = null;
  try {
    await previewBetterCompact(deps, { agent });
  } catch (error) {
    code = error?.code;
  }
  deps.lock.release(agent.id);
  assert.equal(code, 'busy');
});

test('M6 现场快照：后台任务只算未 settled 的，git 探测不误报', () => {
  const session = new MockSession();
  session.append('job/registered', { jobId: 'j1', kind: 'bash', label: 'npm test' });
  session.append('job/registered', { jobId: 'j2', kind: 'bash', label: '  build\n all  ' });
  session.append('job/settled', { jobId: 'j1' });

  assert.deepEqual(pendingJobs(session), [{ kind: 'bash', label: 'build all' }], '只留没 settled 的，label 折叠空白');

  const snapshot = buildSiteSnapshot({ session, now: new Date() });
  assert.equal(snapshot.cwd, '/tmp/relay-test-ws');
  assert.equal(snapshot.git, null, '临时目录不是 git 仓库');
  assert.deepEqual(snapshot.jobs, [{ kind: 'bash', label: 'build all' }]);
  assert.equal(snapshot.provider, 'mock');
  assert.equal(snapshot.model, 'mock-model');
  assert.equal(snapshot.hostStartedAt instanceof Date, true);
  assert.equal(Number.isFinite(snapshot.hostUptimeMs), true);
});

test('M6 现场快照：git 分支/提交从 .git/HEAD 读出来（不跑 git 命令）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-git-'));
  fs.mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main'), 'abcdef0123456789\n');
  assert.deepEqual(gitInfo(dir), { branch: 'main', head: 'abcdef01' });

  const detached = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-git-'));
  fs.mkdirSync(path.join(detached, '.git'));
  fs.writeFileSync(path.join(detached, '.git', 'HEAD'), '0123456789abcdef\n');
  assert.deepEqual(gitInfo(detached), { branch: null, head: '01234567' });

  // P3-07：.git/HEAD 里的 ref 可以写成相对路径，绝不能按原样拼路径去读仓库外文件。
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-git-'));
  fs.mkdirSync(path.join(evil, '.git'));
  fs.writeFileSync(path.join(evil, '.git', 'HEAD'), 'ref: ../../../../etc/passwd\n');
  assert.deepEqual(gitInfo(evil), { branch: null, head: '' }, '越界 ref 当作读不到，不读文件');
  // 白名单外的怪 ref（绝对路径 / 反斜杠）同样拒绝
  fs.writeFileSync(path.join(evil, '.git', 'HEAD'), 'ref: /etc/passwd\n');
  assert.deepEqual(gitInfo(evil), { branch: null, head: '' });
  fs.rmSync(evil, { recursive: true, force: true });

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(detached, { recursive: true, force: true });
});

/* ---------------- M6：钉住消息 ---------------- */

test('M6 钉住：/pin 钉最近一轮 / list / 按序号 / 取消', () => {
  const session = baseSourceSession(); // surface = [0,1,2,3]，最后一条是 user seq3
  const { ctx, engine } = makeCtx();
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  const agent = createAgent(session);

  const first = pinLastTurn(deps, { agent });
  assert.deepEqual(first.pinned, [3], '钉住最近一轮开头（最后一条 user/message）');
  assert.equal(session.log.some((event) => event.type === PIN_RECORD_TYPE && event.ignorable === true), true);
  const again = pinLastTurn(deps, { agent });
  assert.deepEqual(again.pinned, [3], '重复钉同一轮不重复记');

  const listed = listPins(deps, { agent });
  assert.equal(listed.candidates.length, 4);
  assert.equal(listed.candidates[0].seq, 3, '编号 1 = 最新');
  assert.equal(listed.message.includes('当前已锁定'), true);

  const byIndex = pinByIndex(deps, { agent, index: 2 });
  assert.equal(byIndex.added, 2, '/pin 2 = 列表第 2 条（seq2）');

  const cleared = unpinAll(deps, { agent });
  assert.equal(cleared.cleared, 2);
  assert.deepEqual(cleared.pinned, []);

  const toggled = togglePin(deps, { agent });
  assert.deepEqual(toggled.pinned, [3], 'toggle：没钉住时钉最近一轮');
  const toggledOff = togglePin(deps, { agent });
  assert.deepEqual(toggledOff.pinned, [], 'toggle：有钉住时清空');
});

test('P3-03：锁定快照过期（消息已不在 surface）时，菜单 toggle 不再误作「解锁」', () => {
  const { ctx, engine } = makeCtx();
  const depsOf = () => createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });

  // 场景 A：快照里的 seq 已被原生压缩/清屏带走 → 菜单显示「未锁定」，点击应执行锁定。
  const sessionA = baseSourceSession();
  const depsA = depsOf();
  const agentA = createAgent(sessionA);
  pinByIndex(depsA, { agent: agentA, index: 2 }); // 快照 [2]
  sessionA.surface.nodes = sessionA.surface.nodes.filter((seq) => seq !== 2);
  sessionA.surface.replaceGeneration += 1;
  assert.equal(livePinnedSeqs(sessionA).length, 0, '展示口径应为 0 条有效锁定');
  const toggled = togglePin(depsA, { agent: agentA });
  assert.deepEqual(toggled.pinned, [3], '菜单显示未锁定 → 点击应当锁定，而不是解锁');
  assert.equal(toggled.message.includes('已锁定'), true);

  // 场景 B：显式解锁时，过期快照不算「解锁了几条」，并说明只是清理了过期记录。
  const sessionB = baseSourceSession();
  const depsB = depsOf();
  const agentB = createAgent(sessionB);
  pinByIndex(depsB, { agent: agentB, index: 2 });
  sessionB.surface.nodes = sessionB.surface.nodes.filter((seq) => seq !== 2);
  sessionB.surface.replaceGeneration += 1;
  const expired = unpinAll(depsB, { agent: agentB });
  assert.deepEqual(expired.pinned, []);
  assert.equal(expired.cleared, 0, '过期快照不算解锁条数');
  assert.equal(expired.message.includes('清理过期'), true);
});

test('M6 钉住：精压范围避开被钉消息，被钉消息保留在 surface', async () => {
  const session = baseSourceSession(); // surface 0..3
  const { ctx, engine } = makeCtx();
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  const agent = createAgent(session);
  pinByIndex(deps, { agent, index: 2 }); // 候选 1=seq3、2=seq2 → 钉 seq2

  const preview = await previewBetterCompact(deps, { agent });
  assert.notEqual(preview.preview, null);
  assert.equal(preview.preview.nodes, 1, '只压 seq1（seq2 被钉住，范围截到它之前）');
  assert.equal(preview.message.includes('已跳过 1 条锁定的消息'), true);

  const outcome = await betterCompact(deps, { agent });
  assert.equal(outcome.compacted, true);
  assert.deepEqual(outcome.shadowedSeqs, [1]);
  assert.equal(session.surface.nodes.includes(2), true, '被钉消息必须留在 surface');
  assert.equal(session.surface.nodes.includes(3), true);
  assert.equal(session.surface.nodes.includes(1), false, 'seq1 已被摘要替换');
});

test('M6 钉住：钉住挡在最前面 → 不压，并明确提示被钉住挡住', async () => {
  const session = baseSourceSession();
  const { ctx, engine } = makeCtx();
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  const agent = createAgent(session);
  pinByIndex(deps, { agent, index: 3 }); // 候选 3 = seq1（可压范围的第一个节点）

  const preview = await previewBetterCompact(deps, { agent });
  assert.equal(preview.preview, null);
  assert.equal(preview.message.includes('被「锁定」保护'), true);
  const outcome = await betterCompact(deps, { agent });
  assert.equal(outcome.compacted, false);
  assert.equal(session.surface.nodes.includes(1), true, '历史没动');
});

/* ---------------- 子会话标题：不叠前缀 + 标出第几次交接 ---------------- */

test('M7 标题：第 N 次交接，旧堆叠格式也认得出次数', () => {
  const ctxWith = (title) => ({
    get(name) {
      if (name !== 'sessionTitle') return undefined;
      return { get: () => (title === undefined ? null : { title }) };
    },
  });
  // 第一次交接：干净标题 → 第 1 次
  assert.equal(childTitleOf(ctxWith('dsh-compact-relay M3'), {}), '交接第 1 次：dsh-compact-relay M3');
  // 旧格式叠了一层「接棒：」→ 第 2 次
  assert.equal(childTitleOf(ctxWith('接棒：dsh-compact-relay M3'), {}), '交接第 2 次：dsh-compact-relay M3');
  // 旧格式叠了三层（交接：接棒：接棒：）→ 第 4 次，且原题只剩一次
  assert.equal(childTitleOf(ctxWith('交接：接棒：接棒：dsh-compact-relay M3'), {}), '交接第 4 次：dsh-compact-relay M3');
  // 新格式 → 序号 +1，原题不重复
  assert.equal(childTitleOf(ctxWith('交接第 2 次：dsh-compact-relay M3'), {}), '交接第 3 次：dsh-compact-relay M3');
  // 手改的怪标题（第 0 次 / 空题）也兜住
  assert.equal(childTitleOf(ctxWith('交接第 0 次：X'), {}), '交接第 1 次：X');
  assert.equal(childTitleOf(ctxWith('交接：'), {}), '交接第 2 次：会话');
  // 拿不到原标题 → 第 1 次 + 会话
  assert.equal(childTitleOf(ctxWith(undefined), {}), '交接第 1 次：会话');
  assert.equal(childTitleOf({ get: () => undefined }, {}), '交接第 1 次：会话');
});

test('A5 接力链：relay 记录优先于标题解析，缺字段时有兜底', () => {
  const ctxWith = (title) => ({
    get(name) {
      if (name !== 'sessionTitle') return undefined;
      return { get: () => ({ title }) };
    },
  });
  // 最新记录 index=2 → 第 3 次；原题来自记录，不理会被手改的面板标题。
  const withRecord = {
    log: [
      { type: 'plugin:compact-relay/relay', data: { parentSessionId: 'p', childId: 'session-a', index: 2, baseTitle: '原始标题', at: 1 } },
    ],
  };
  assert.equal(childTitleOf(ctxWith('被手改的面板标题'), withRecord), '交接第 3 次：原始标题');
  // 旧记录没带 baseTitle → 用当前标题解析出的原题兜底。
  const legacyRecord = {
    log: [{ type: 'plugin:compact-relay/relay', data: { childId: 'session-b', index: 1, at: 1 } }],
  };
  assert.equal(childTitleOf(ctxWith('交接第 5 次：原题'), legacyRecord), '交接第 2 次：原题');
});

/* ---------------- 2026-10-19 分模块 debug 回归 ---------------- */

test('debug: /pin list 读得懂 DSH v4 的 user/message 形状', () => {
  const session = new MockSession().seed([
    { type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: '系统提示' }] } } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '真正的用户消息' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '助手回复' }] } } },
  ]);
  const { ctx, engine } = makeCtx();
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  const agent = createAgent(session);
  const listed = listPins(deps, { agent });
  const human = listed.candidates.find((candidate) => candidate.seq === 1);
  assert.notEqual(human, undefined);
  assert.equal(human.preview.includes('真正的用户消息'), true, 'v4 用户消息的 data 本身就是消息');
  assert.equal(human.preview.includes('（无文本）'), false);
  assert.equal(listed.candidates.find((candidate) => candidate.seq === 2).preview.includes('助手回复'), true);
});

test('debug: pinLastTurn 优先锁「人」的消息，不锁 runtime-context 合成消息', () => {
  const session = new MockSession().seed([
    { type: 'system/message', data: { message: { role: 'system', content: [] } } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '人说的话' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [] } } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'runtime context' }], source: { kind: 'runtime-context' } } },
  ]);
  const { ctx, engine } = makeCtx();
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  const result = pinLastTurn(deps, { agent: createAgent(session) });
  assert.deepEqual(result.pinned, [1], '应锁人的最后一句（seq1），而不是最后的 runtime-context（seq3）');
});

test('debug: /unpin 空集合不写 plugin record', () => {
  const session = baseSourceSession();
  const { ctx, engine } = makeCtx();
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  const before = session.log.length;
  const result = unpinAll(deps, { agent: createAgent(session) });
  assert.equal(session.log.length, before, '没有锁定内容时不应追加空快照');
  assert.equal(result.cleared, 0);
  assert.equal(result.message, '当前没有锁定的消息。');
});

test('debug: 压缩已提交但落盘失败 → 交接中止，不建新会话', async () => {
  const session = baseSourceSession();
  const { ctx, engine, record } = makeCtx();
  ctx.sessions.flush = async () => {
    throw new Error('disk full');
  };
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  deps.log = { warn() {} };
  await assert.rejects(handoff(deps, { agent: createAgent(session) }), (error) => error?.code === 'persistence');
  assert.equal(record.createCalls.length, 0, '历史可能已改但未落盘时不能继续建新会话');
});

test('debug: /bctest dry-run 不写历史，confirm 真替换，忙碌时拒绝', async () => {
  const session = baseSourceSession();
  const { ctx, engine } = makeCtx();
  const deps = createPluginDeps({ ctx, engine, handoffDir: createTmpDir('relay-m3-') });
  const agent = createAgent(session);

  const beforeLog = session.log.length;
  const dry = await testCompact(deps, { agent });
  assert.equal(dry.dryRun, true);
  assert.equal(session.log.length, beforeLog, 'dry-run 不写会话日志');
  assert.deepEqual(session.surface.nodes, [0, 1, 2, 3]);

  const done = await testCompact(deps, { agent, confirm: true });
  assert.equal(done.dryRun, false);
  assert.equal(session.log.some((event) => event.type === 'compaction/summary'), true);
  assert.equal(session.surface.nodes.length < 4, true, '历史已被替换成 checkpoint');
  assert.equal(deps.lock.isBusy(agent.id), false, '确认执行后锁要释放');

  assert.equal(deps.lock.tryAcquire(agent.id), true);
  await assert.rejects(testCompact(deps, { agent }), (error) => error.code === 'busy');
  deps.lock.release(agent.id);
});

/* ---------------- run ---------------- */

let passed = 0;
for (const [name, fn] of cases) {
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
