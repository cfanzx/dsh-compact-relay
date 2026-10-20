/**
 * A6 压缩历史读侧单测：配对 summary/end/replace，区分已提交/失败/未闭合/旧日志。
 */
import assert from 'node:assert/strict';
import { collectCompactions, latestCompaction } from '../lib/dsh/compaction-log.js';
import { readCompactDiffs } from '../lib/actions/compact-diff.js';

const longSummary = '第一段结论。\n\n第二段包含大量细节：' + '细节'.repeat(160);

function event(seq, type, data, extra = {}) {
  return { seq, type, data, time: 1_700_000_000_000 + seq, ...extra };
}

const log = [
  event(1, 'turn/start', {}),
  // 已提交：summary 10 + end ok + replace 覆盖 10
  event(10, 'compaction/summary', {
    compactionId: 'a',
    summary: longSummary,
    shadowedRange: { start: 2, end: 9 },
    shadowedSeqs: [2, 3, 4, 5, 6, 7, 8, 9],
    shadowedTokenCount: 1234,
    provider: 'deepseek',
    model: 'deepseek-flash',
  }),
  event(11, 'user/message', { role: 'user' }, { sourceEventSeqs: [10, 2, 3] }),
  event(12, 'compaction/end', { compactionId: 'a' }),
  // 失败：summary 20 + end error + replace
  event(20, 'compaction/summary', {
    compactionId: 'b',
    summary: '失败事务的摘要',
    shadowedSeqs: [13, 14],
    shadowedTokenCount: 50,
  }),
  event(21, 'user/message', { role: 'user' }, { sourceEventSeqs: [20, 13, 14] }),
  event(22, 'compaction/end', { compactionId: 'b', error: { name: 'Error', message: 'boom' } }),
  // 未闭合：summary 30 + replace，没有 end
  event(30, 'compaction/summary', { compactionId: 'c', summary: '未闭合', shadowedSeqs: [23] }),
  event(31, 'user/message', { role: 'user' }, { sourceEventSeqs: [30, 23] }),
  // 旧日志（无 compactionId）：有 replace 即算已提交
  event(40, 'compaction/summary', { summary: '旧日志摘要', shadowedSeqs: [32, 33] }),
  event(41, 'user/message', { role: 'user' }, { sourceEventSeqs: [40, 32, 33] }),
  // 幽灵：summary 50 没有 replace
  event(50, 'compaction/summary', { compactionId: 'e', summary: '幽灵', shadowedSeqs: [44] }),
  event(51, 'compaction/end', { compactionId: 'e' }),
  // 幽灵：summary 60 有 end 但无 replace
  event(60, 'compaction/summary', { compactionId: 'f', summary: '另一条幽灵' }),
  event(61, 'compaction/end', { compactionId: 'f' }),
];

const session = { id: 'session-compact-log', log };

const items = collectCompactions(session);
assert.equal(items.length, 6, '默认应返回全部 6 条摘要（最新在前）');
assert.deepEqual(
  items.map((item) => item.seq),
  [60, 50, 40, 30, 20, 10],
  '最新在前',
);
assert.deepEqual(
  items.map((item) => item.committed),
  [false, false, true, false, false, true],
  '提交判定：replace + 无 error end 才算；旧日志无 id 有 replace 算',
);
assert.equal(items[3].open, true, '没有 end 的事务应标记 open');
assert.equal(items[4].error?.message, 'boom', '失败 end 的错误要带出来');
assert.equal(items[0].compactionId, 'f');
assert.equal(items[2].compactionId, null, '旧日志允许没有 compactionId');

const committed = items.find((item) => item.seq === 10);
assert.equal(committed.shadowedCount, 8);
assert.equal(committed.shadowedTokens, 1234);
assert.equal(committed.replaceSeq, 11);
assert.equal(committed.provider, 'deepseek');
assert.equal(committed.model, 'deepseek-flash');
assert.equal(committed.at, 1_700_000_000_010);
assert.equal(committed.previewTruncated, true, '超长摘要要标记截断');
assert.equal(committed.preview.length <= 201, true, '预览最多 200 字 + 省略号');
assert.equal(committed.preview.startsWith('第一段结论。'), true);

// limit / 参数裁剪
const two = collectCompactions(session, { limit: 2 });
assert.deepEqual(two.map((item) => item.seq), [60, 50]);
assert.equal(collectCompactions(session, { limit: 0 }).length, 1, 'limit 下限 1');
assert.equal(collectCompactions(session, { limit: 999 }).length, 6, 'limit 不超过摘要数');
assert.equal(collectCompactions(session, { limit: 2, previewChars: 4 })[0].preview, '另一条幽…');

// latest / 空会话
assert.equal(latestCompaction(session)?.seq, 60);
assert.equal(latestCompaction({ log: [] }), null);
assert.deepEqual(collectCompactions(null), []);

// 真实 DSH 形态：summary 是内容块数组而不是字符串
const blockSession = {
  id: 'session-block',
  log: [
    {
      seq: 1,
      type: 'compaction/summary',
      data: {
        compactionId: 'g',
        summary: [
          { type: 'text', text: '## 目标\n块格式摘要第一段' },
          { type: 'text', text: '第二块内容' },
        ],
        shadowedSeqs: [1, 2],
      },
    },
    { seq: 2, type: 'user/message', data: {}, sourceEventSeqs: [1, 1, 2] },
    { seq: 3, type: 'compaction/end', data: { compactionId: 'g' } },
  ],
};
const blockItem = collectCompactions(blockSession)[0];
assert.equal(blockItem.committed, true);
assert.equal(blockItem.preview, '## 目标 块格式摘要第一段 第二块内容', '真实块数组摘要要能归一成预览');
assert.equal(blockItem.previewTruncated, false);

// actions 层：有 agent / 无 agent
const deps = { ctx: { agents: { get: (id) => (id === session.id ? { id, session } : undefined), list: () => [] } } };
const view = readCompactDiffs(deps, { sessionId: session.id, limit: 3 });
assert.equal(view.ok, true);
assert.equal(view.sessionId, session.id);
assert.equal(view.count, 3);
assert.equal(view.latest.seq, 60);
assert.throws(
  () => readCompactDiffs({ ctx: { agents: { get: () => undefined, list: () => [] } } }, {}),
  (error) => error.code === 'nosession',
  '没有活动会话要报 nosession',
);

console.log('PASS  A6 压缩历史：配对/提交口径/失败与未闭合/预览截断/actions');
