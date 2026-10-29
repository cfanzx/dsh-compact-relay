/**
 * 收藏动作层单测（2026-10-29 真机 BUG 回归）：
 *   - seqOfMessageId：助手消息按 data.message.id 认、用户消息按 data.id 认；
 *   - ownerAgentOfMessage：按 messageId 反查所属活会话（唯一命中才算数）；
 *   - toggleFavorite：传错 agent（多会话时客户端带错 sessionId）也能落到正确会话；
 *   - 找不到 / 多个候选时给明确错误，不静默收藏到错会话。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markFavoriteBySeq, markFavoriteInSession, ownerAgentOfMessage, seqOfMessageId, toggleFavorite } from '../lib/actions/favorite.js';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dcr-favorite-'));
process.env.DSH_HOME = tmpHome;

function makeSession(id, events) {
  const log = events.map((item, index) => ({
    seq: index + 1,
    type: item.type,
    data: item.type === 'assistant/message' ? { message: { id: item.id, role: 'assistant', content: [] } } : { id: item.id },
  }));
  return { id, log, eventAt: (seq) => log.find((event) => event.seq === seq) };
}

function makeDeps(agents) {
  return { ctx: { agents: { list: () => agents } } };
}

const assistantId = 'msg-assistant-1';
const userId = 'msg-user-1';

const sessionA = makeSession('session-aaaa1111', [
  { type: 'user/message', id: userId },
  { type: 'assistant/message', id: 'msg-other' },
]);
const sessionB = makeSession('session-bbbb2222', [{ type: 'assistant/message', id: assistantId }]);
const agentA = { id: 'session-aaaa1111', session: sessionA };
const agentB = { id: 'session-bbbb2222', session: sessionB };
const deps = makeDeps([agentA, agentB]);

// 1) id 映射：助手走 message.id，用户走 data.id
assert.equal(seqOfMessageId(sessionA, userId), 1);
assert.equal(seqOfMessageId(sessionA, 'msg-other'), 2);
assert.equal(seqOfMessageId(sessionA, assistantId), null);

// 2) 反查所属会话
assert.equal(ownerAgentOfMessage(deps, assistantId), agentB);
assert.equal(ownerAgentOfMessage(deps, 'msg-missing'), null);

// 3) 传错 agent 也能收藏到正确会话（老 bug：POST 带错 sessionId → 静默失败）
const added = toggleFavorite(deps, { agent: agentA, messageId: assistantId });
assert.equal(added.active, true);
assert.equal(added.seq, 1);
const files = fs.readdirSync(path.join(tmpHome, 'dcr-favorites'));
assert.equal(files.length, 1);
const records = fs
  .readFileSync(path.join(tmpHome, 'dcr-favorites', files[0]), 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));
assert.equal(records.length, 1);
assert.equal(records[0].sessionId, 'session-bbbb2222');
assert.equal(records[0].op, 'add');
assert.equal(records[0].seq, 1);

// 4) 取消收藏：按 messageId 反查，不依赖客户端 sessionId
const removed = toggleFavorite(deps, { messageId: assistantId });
assert.equal(removed.active, false);
assert.equal(removed.count, 0);

// 5) 找不到 / 多个候选 → 明确报错（不静默、不错收）
assert.throws(
  () => toggleFavorite(deps, { agent: agentA, messageId: 'msg-missing' }),
  (error) => error.code === 'favorite' && /找不到/.test(error.message),
);
const dupA = makeSession('session-cccc3333', [{ type: 'assistant/message', id: 'msg-dup' }]);
const dupB = makeSession('session-dddd4444', [{ type: 'assistant/message', id: 'msg-dup' }]);
const dupDeps = makeDeps([
  { id: 'session-cccc3333', session: dupA },
  { id: 'session-dddd4444', session: dupB },
]);
assert.equal(ownerAgentOfMessage(dupDeps, 'msg-dup'), null);
// 传「不含这条消息」的第三个 agent 才会走反查；两个候选都有 → 拒绝收藏。
const agentE = { id: 'session-eeee5555', session: makeSession('session-eeee5555', []) };
assert.throws(
  () => toggleFavorite(dupDeps, { agent: agentE, messageId: 'msg-dup' }),
  (error) => error.code === 'favorite',
);

// 6) 无活会话按 sessionId+seq 标记：链根用 readSessionHeader 的 parentSession 链解析
const headers = {
  'session-child2': { parentSession: 'session-child1' },
  'session-child1': { parentSession: 'session-root0001' },
};
const markDeps = {
  ctx: {
    get: (name) =>
      name === 'workspaceRegistry'
        ? {
            readSessionHeader: async (id) => {
              if (headers[id] === undefined) throw new Error('no such session');
              return headers[id];
            },
          }
        : undefined,
  },
};
const marked = await markFavoriteBySeq(markDeps, { sessionId: 'session-child2', seq: 7 });
assert.equal(marked.active, true);
assert.equal(marked.count, 1);
const canonical = path.join(tmpHome, 'dcr-favorites', 'root0001.jsonl');
assert.equal(fs.existsSync(canonical), true);
const readLines = () =>
  fs
    .readFileSync(canonical, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
assert.equal(readLines()[0].sessionId, 'session-child2');
assert.equal(readLines()[0].seq, 7);

// 7) 显式 active:true 幂等：已是目标状态不重复写
const again = await markFavoriteBySeq(markDeps, { sessionId: 'session-child2', seq: 7, active: true });
assert.equal(again.active, true);
assert.equal(again.note, 'already');
assert.equal(readLines().length, 1);

// 8) 省略 active = 切换：再点一次就取消；显式 active:false 已达标也幂等
const toggledOff = await markFavoriteBySeq(markDeps, { sessionId: 'session-child2', seq: 7 });
assert.equal(toggledOff.active, false);
assert.equal(toggledOff.count, 0);
assert.equal(readLines().length, 2);
const offAgain = await markFavoriteBySeq(markDeps, { sessionId: 'session-child2', seq: 7, active: false });
assert.equal(offAgain.note, 'already');
assert.equal(readLines().length, 2);

// 9) 旧文件名只读兼容：有「标题-短id」文件就继续写它，不另建规范文件
fs.mkdirSync(path.join(tmpHome, 'dcr-favorites'), { recursive: true });
const legacyFile = path.join(tmpHome, 'dcr-favorites', '旧标题-abcd1234.jsonl');
fs.writeFileSync(
  legacyFile,
  `${JSON.stringify({ schema: 'dcr-favorite/v1', op: 'add', sessionId: 'session-abcd1234', seq: 3, at: 1 })}\n`,
  'utf8',
);
const legacyDeps = { ctx: { get: () => undefined } }; // 没有 registry：解析不到根 → 按 sessionId 当根
await markFavoriteBySeq(legacyDeps, { sessionId: 'session-abcd1234', seq: 9 });
const legacyLines = fs
  .readFileSync(legacyFile, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0);
assert.equal(legacyLines.length, 2);
assert.equal(fs.existsSync(path.join(tmpHome, 'dcr-favorites', 'abcd1234.jsonl')), false);

// 10) 命令 /favorite mark：不带 seq = 最后一条已完成助手回复
const cmdSession = makeSession('session-cmd00001', [
  { type: 'user/message', id: 'u1' },
  { type: 'assistant/message', id: 'a1' },
  { type: 'user/message', id: 'u2' },
  { type: 'assistant/message', id: 'a2' },
]);
const cmdDeps = { ctx: { agents: { list: () => [] } } };
const cmdAgent = { id: 'session-cmd00001', session: cmdSession };
const cmdMarked = markFavoriteInSession(cmdDeps, { agent: cmdAgent });
assert.equal(cmdMarked.active, true);
assert.equal(cmdMarked.seq, 4); // a2 的 seq
assert.equal(markFavoriteInSession(cmdDeps, { agent: cmdAgent }).note, 'already');

// 11) 指定不存在的 seq / 非法参数 → 明确报错（不静默）
assert.throws(
  () => markFavoriteInSession(cmdDeps, { agent: cmdAgent, seq: 999 }),
  (error) => error.code === 'favorite' && /没有 seq 999/.test(error.message),
);
await assert.rejects(
  () => markFavoriteBySeq(markDeps, { sessionId: 'session-child2', seq: Number.NaN }),
  (error) => error.code === 'favorite',
);
await assert.rejects(() => markFavoriteBySeq(markDeps, { seq: 1 }), (error) => error.code === 'favorite');

// 12) P0-3 兜底：已被压走、但原文还在日志里 → 标的时候当场写快照
const snapSession = {
  id: 'session-cmd00002',
  log: [
    { seq: 1, type: 'user/message', data: { id: 'su1', source: { kind: 'user' }, content: '问题' } },
    { seq: 2, type: 'assistant/message', data: { message: { id: 'sa-old', content: [{ type: 'text', text: '旧结论原文' }] } } },
    { seq: 3, type: 'user/message', data: { id: 'su2', source: { kind: 'user' }, content: '继续' } },
    { seq: 4, type: 'assistant/message', data: { message: { id: 'sa-new', content: [{ type: 'text', text: '新回复' }] } } },
  ],
  surface: { nodes: [3, 4] },
  eventAt(seq) {
    return this.log.find((event) => event.seq === seq);
  },
};
const snapAgent = { id: snapSession.id, session: snapSession };
const snapDeps = { ctx: { agents: { list: () => [] } } };
const snapMarked = markFavoriteInSession(snapDeps, { agent: snapAgent, seq: 2 });
assert.equal(snapMarked.active, true);
assert.equal(snapMarked.snapshot, 'written');
const snapFile = path.join(tmpHome, 'dcr-favorites', 'snapshots', 'cmd00002.md');
assert.equal(fs.existsSync(snapFile), true);
assert.match(fs.readFileSync(snapFile, 'utf8'), /旧结论原文/);
const snapAgain = markFavoriteInSession(snapDeps, { agent: snapAgent, seq: 2 });
assert.equal(snapAgain.note, 'already');
assert.equal(snapAgain.snapshot, 'present');
const liveMarked = markFavoriteInSession(snapDeps, { agent: snapAgent, seq: 4 });
assert.equal(liveMarked.snapshot, 'none'); // 还在界面上：不需要兜底

console.log('PASS  收藏动作：messageId 反查会话 + 传错 agent 自愈 + 候选不唯一/找不到时明确报错');
console.log('PASS  收藏标记解耦：无活会话按 sessionId+seq 写标记（链根解析/规范文件名/幂等/旧名兼容/命令 mark）');
console.log('PASS  收藏补标兜底：已压走但日志还在 → 标记时当场写快照（可读回原文）');
console.log('favorite：12/12 通过');
