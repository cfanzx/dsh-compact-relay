/**
 * 收藏单测补齐（0.5.3 P0-4）：
 *   - core/favorites.js 纯函数：记录校验、JSONL 解析、add/remove 集合、标题、摘要目录、推荐占位；
 *   - dsh/favorites-file.js 文件层：读写/坏行容忍/上限重写、命名解析（新名优先、旧名兼容）、
 *     收藏投影（state）、压缩快照写读去重、无活会话时的链根解析。
 *
 * 全程在临时 DSH_HOME 里跑，不碰真实收藏。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dcr-fav-unit-'));
process.env.DSH_HOME = tmpHome;

const { FAVORITE_SCHEMA, normalizeFavoriteRecord, parseFavoriteLines, applyFavoriteOps, countFavorites, favoriteSeqsOf, buildFavoriteTitle, buildFavoriteDirectoryLines, appendFavoriteDirectory, suggestFavorites } =
  await import('../lib/core/favorites.js');
const { canonicalFavoritesFileOf, legacyFavoritesFilesOf, favoritesFileForRoot, favoritesFileOf, readFavoritesFile, appendFavoriteRecord, favoriteMapOf, favoriteMapForRoot, favoriteStateOf, snapshotFileOf, appendSnapshotEntries, snapshotTextFor, rootSessionIdOfId } =
  await import('../lib/dsh/favorites-file.js');

const rec = (over = {}) => ({ schema: FAVORITE_SCHEMA, op: 'add', sessionId: 'session-aaaa1111', seq: 3, at: 1, ...over });

// 1) 记录校验：形状不对一律 null（读侧跳过坏行）
assert.equal(normalizeFavoriteRecord(rec()).seq, 3);
assert.equal(normalizeFavoriteRecord(rec({ schema: 'other/v1' })), null);
assert.equal(normalizeFavoriteRecord(rec({ op: 'toggle' })), null);
assert.equal(normalizeFavoriteRecord(rec({ seq: 1.5 })), null);
assert.equal(normalizeFavoriteRecord(rec({ seq: -1 })), null);
assert.equal(normalizeFavoriteRecord(rec({ sessionId: '' })), null);
assert.equal(normalizeFavoriteRecord(null), null);

// 2) JSONL 解析：半截行/非 JSON 行跳过，不毁全部
const parsed = parseFavoriteLines(`${JSON.stringify(rec())}\n{broken\n${JSON.stringify(rec({ op: 'remove', seq: 3 }))}\n`);
assert.equal(parsed.length, 2);

// 3) add/remove 应用：按时间顺序、remove 未知 seq 无害、空集合清掉
const map = applyFavoriteOps([
  rec({ sessionId: 'session-a', seq: 1 }),
  rec({ sessionId: 'session-a', seq: 2 }),
  rec({ sessionId: 'session-b', seq: 5 }),
  rec({ op: 'remove', sessionId: 'session-a', seq: 1 }),
  rec({ op: 'remove', sessionId: 'session-b', seq: 9 }),
]);
assert.deepEqual(favoriteSeqsOf(map, 'session-a'), [2]);
assert.deepEqual(favoriteSeqsOf(map, 'session-b'), [5]);
assert.equal(countFavorites(map), 2);
assert.deepEqual(favoriteSeqsOf(applyFavoriteOps([rec(), rec({ op: 'remove' })]), 'session-aaaa1111'), []);

// 4) 标题：短文本原样、长文本截断带省略号、无文本兜底
assert.equal(buildFavoriteTitle({ data: { content: '短标题' } }), '短标题');
assert.equal(buildFavoriteTitle({ data: { content: 'x'.repeat(200) } }).endsWith('…'), true);
assert.equal(buildFavoriteTitle(undefined), '（无文本）');

// 5) 目录行：截断 + 尾部提示
const dirLines = buildFavoriteDirectoryLines(
  Array.from({ length: 25 }, (_, index) => ({ index: index + 1, role: '助手', title: `t${index}` })),
  20,
);
assert.equal(dirLines.length, 21);
assert.match(dirLines[20], /等 25 条/);

// 6) 摘要目录块：无收藏原样返回、有收藏追加独立文本块
const base = [{ type: 'text', text: '摘要正文' }];
assert.deepEqual(appendFavoriteDirectory(base, []), base);
const withDir = appendFavoriteDirectory(base, ['- 收藏 1 · [助手] x']);
assert.equal(withDir.length, 2);
assert.match(withDir[1].text, /收藏（本段）/);
assert.match(withDir[1].text, /\/favorite <序号>/);

// 7) 推荐收藏仍是接口占位（不自动收藏、返回空）
assert.deepEqual(suggestFavorites([{ seq: 1, type: 'assistant/message' }]), []);

// 8) 文件读取：不存在 → []；坏行跳过
assert.deepEqual(readFavoritesFile(path.join(tmpHome, 'nope.jsonl')), []);
const badFile = path.join(tmpHome, 'bad.jsonl');
fs.writeFileSync(badFile, `${JSON.stringify(rec())}\nnot-json\n`, 'utf8');
assert.equal(readFavoritesFile(badFile).length, 1);

// 9) 追加记录：自动建目录、可连续追加
const fileA = path.join(tmpHome, 'dcr-favorites', 'root0001.jsonl');
assert.equal(appendFavoriteRecord(rec({ seq: 11 }), fileA).ok, true);
assert.equal(appendFavoriteRecord(rec({ seq: 12 }), fileA).ok, true);
assert.equal(readFavoritesFile(fileA).length, 2);

// 10) 命名解析：新名 `<短id>.jsonl`；旧名 `<标题>-<短id>.jsonl` 只读兼容、不拆文件
const legacyPath = path.join(tmpHome, 'dcr-favorites', '工作名-root0002.jsonl');
fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
fs.writeFileSync(legacyPath, `${JSON.stringify(rec({ sessionId: 'session-child', seq: 4 }))}\n`, 'utf8');
assert.equal(canonicalFavoritesFileOf('session-root0002'), path.join(tmpHome, 'dcr-favorites', 'root0002.jsonl'));
assert.deepEqual(legacyFavoritesFilesOf('session-root0002'), [legacyPath]);
assert.equal(favoritesFileForRoot('session-root0002'), legacyPath); // 只有旧名 → 继续用旧名
assert.equal(favoritesFileForRoot('session-root0003'), path.join(tmpHome, 'dcr-favorites', 'root0003.jsonl')); // 都没有 → 新名

// 11) 收藏投影：活会话按 header.parentSession 认链根读旧文件；state 只下发 seq + messageId
const session = {
  id: 'session-child',
  header: { parentSession: 'session-root0002' },
  log: [
    { seq: 4, type: 'assistant/message', data: { message: { id: 'msg-4' } } },
    { seq: 5, type: 'assistant/message', data: { message: { id: 'msg-5' } } },
  ],
};
assert.equal(favoritesFileOf(undefined, session), legacyPath);
assert.deepEqual([...favoriteMapOf({}, session).get('session-child')], [4]);
const state = favoriteStateOf({}, session);
assert.deepEqual(state.seqs, [4]);
assert.deepEqual(state.messageIds, ['msg-4']);
assert.equal(state.count, 1);
assert.equal(favoriteStateOf({}, null).count, 0);

// 12) 压缩快照：写入一次、同 seq 去重、读回正文一致
const snapFile = snapshotFileOf({}, { id: 'session-root0002', header: { parentSession: 'session-root0002' } });
const firstWrite = appendSnapshotEntries(snapFile, [
  { seq: 4, role: '助手', title: '旧结论', text: '旧结论原文\n第二行', at: 1000 },
]);
assert.equal(firstWrite.written, 1);
assert.equal(appendSnapshotEntries(snapFile, [{ seq: 4, role: '助手', title: '旧结论', text: '旧结论原文\n第二行', at: 1000 }]).written, 0);
assert.equal(snapshotTextFor(snapFile, 4), '旧结论原文\n第二行');
assert.equal(snapshotTextFor(snapFile, 99), null);
assert.equal(appendSnapshotEntries(snapFile, []).written, 0);

// 13) 无活会话的链根解析：parentSession 一路向上；没有 registry / 读不到 → 退回 sessionId
const headers = {
  'session-child2': { parentSession: 'session-child1' },
  'session-child1': { parentSession: 'session-root0009' },
};
const ctx = { get: (name) => (name === 'workspaceRegistry' ? { readSessionHeader: async (id) => { if (headers[id] === undefined) throw new Error('no such session'); return headers[id]; } } : undefined) };
assert.equal(await rootSessionIdOfId(ctx, 'session-child2'), 'session-root0009');
assert.equal(await rootSessionIdOfId({ get: () => undefined }, 'session-lone0001'), 'session-lone0001');
assert.equal(await rootSessionIdOfId(ctx, 'session-lost0001'), 'session-lost0001');
assert.equal(await rootSessionIdOfId(ctx, ''), null);

// 14) 上限重写：不设 500 条上限就写爆 → 追加到 2×上限后只保留最近上限条
const cappedFile = path.join(tmpHome, 'dcr-favorites', 'capped.jsonl');
for (let index = 0; index < 1002; index += 1) appendFavoriteRecord(rec({ seq: index }), cappedFile);
const capped = readFavoritesFile(cappedFile);
assert.equal(capped.length, 501); // 第 1001 次追加触发重写，只留最近 500 条，再加 1 条
assert.equal(capped[0].seq, 501);
assert.equal(capped.at(-1).seq, 1001);

console.log('PASS  收藏纯函数：记录校验 / 坏行解析 / add-remove / 标题 / 摘要目录 / 推荐占位');
console.log('PASS  收藏文件层：新名优先+旧名兼容 / 追加与上限重写 / 收藏投影 / 快照去重读回');
console.log('PASS  收藏链根解析：无活会话按 parentSession 向上；读不到退回自身（不猜不抛）');
console.log('favorites-unit：14/14 通过');
