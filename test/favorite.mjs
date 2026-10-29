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
import { ownerAgentOfMessage, seqOfMessageId, toggleFavorite } from '../lib/actions/favorite.js';

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

console.log('PASS  收藏动作：messageId 反查会话 + 传错 agent 自愈 + 候选不唯一/找不到时明确报错');
console.log('favorite：5/5 通过');
