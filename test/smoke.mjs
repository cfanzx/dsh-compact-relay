/**
 * 冒烟测试 —— 不导入任何 DSH 包，纯 node 跑。
 *
 *   node test/smoke.mjs
 *
 * 覆盖：core 纯函数、session-view、替换事务的 append 顺序与 surfaceOp 参数。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contrastRatio, normalizeHex, paletteForBothSchemes, paletteForScheme, resolvePalette } from '../lib/core/colors.js';
import { MIN_COMPRESS_TOKENS, adviceFor, compactionPolicy, compressionMinRatio, ratioOf, thresholdsForWindow } from '../lib/core/policy.js';
import { ringSegments, trimSegment } from '../lib/core/ring.js';
import { COMPRESS_HINT_RECORD_TYPE, compressHintIsActive, latestCompressHint } from '../lib/core/compress-hint.js';
import { applyAutoOverride, parseCompactionOverride } from '../lib/dsh/native-compaction.js';
import { markCompressHint } from '../lib/actions/compress-hint.js';
import { createDiagCounters } from '../lib/dsh/diag-counters.js';
import { selectFullRange, selectTestRange } from '../lib/core/ranges.js';
import { selectCompactableRange } from '../lib/dsh/select-range.js';
import { buildPrefix, surfaceMessages } from '../lib/dsh/prefix.js';
import { measurePressure } from '../lib/dsh/pressure.js';
import { frameSummary, CHECKPOINT_PREAMBLE, SUMMARY_OPEN_TAG } from '../lib/core/prompts.js';
import { HANDOFF_HEADINGS, HANDOFF_SECTIONS, HANDOFF_SECTIONS as HANDOFF_SECTIONS_MODULE, formatDuration, handoffFileName, localTimeOf, renderHandoffDoc } from '../lib/core/handoff-doc.js';
import { HANDOFF_MODEL_SECTIONS, HANDOFF_PROGRAM_SECTIONS, HANDOFF_SPEC } from '../lib/core/handoff-spec.js';
import { buildHandoffProgramSections } from '../lib/core/handoff-facts.js';
import { checkHandoffReadiness } from '../lib/core/readiness.js';
import { changedFilesOf } from '../lib/dsh/session-files.js';
import { errorText, actionError } from '../lib/core/errors.js';
import { REQUIRED_SECTIONS, describeProblems, validateSummary } from '../lib/core/validate-summary.js';
import { describeHandoffProblems, validateHandoff } from '../lib/core/validate-handoff.js';
import { isPlaceholderLine, isPlaceholderText } from '../lib/core/placeholders.js';
import { PIN_RECORD_TYPE, clipRangeByPins, latestPinnedSeqs, normalizePinnedSeqs } from '../lib/core/pins.js';
import { HANDOFF_INSTRUCTION, HANDOFF_PREAMBLE } from '../lib/core/prompts.js';
import { countSummaries, entryState, firstCompactableIdx, lastCheckpointSurfaceIdx, lastCheckpointSurfaceSeq, livePinnedSeqs, pickAgent, surfaceSeqs } from '../lib/dsh/session-view.js';
import { replaceRangeWithSummary } from '../lib/dsh/compact-transaction.js';
import { resolveConfig } from '../lib/config.js';
import { routeOf } from '../lib/dsh/route.js';
import { createSettingsStore } from '../lib/settings-store.js';
import { readState } from '../lib/actions/state.js';
import { createFakeEngine } from './harness/host.mjs';
import { baseSession } from './harness/session.mjs';

let passed = 0;
const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

/* ---------------- core/policy ---------------- */
test('policy: 阈值边界', () => {
  const thresholds = { compactAt: 400_000, handoffAt: 600_000, maxSummaries: 6 };
  assert.equal(adviceFor({ pressure: 399_999, summaries: 0, thresholds }), 'none');
  assert.equal(adviceFor({ pressure: 400_000, summaries: 0, thresholds }), 'compact');
  assert.equal(adviceFor({ pressure: 599_999, summaries: 0, thresholds }), 'compact');
  assert.equal(adviceFor({ pressure: 600_000, summaries: 0, thresholds }), 'handoff');
  assert.equal(adviceFor({ pressure: 10, summaries: 6, thresholds }), 'handoff');
  assert.equal(adviceFor({ pressure: null, summaries: 0, thresholds }), 'none');
  assert.equal(ratioOf(250_000, 1_000_000), 0.25);
  assert.equal(ratioOf(null, 1_000_000), 0);
});

test('policy: 窗口比例换算成绝对阈值（1M / 200k）', () => {
  const ratios = { compactRatio: 0.4, handoffRatio: 0.6, maxSummaries: 6 };
  assert.deepEqual(thresholdsForWindow(ratios, 1_000_000), {
    compactAt: 400_000, handoffAt: 600_000, maxSummaries: 6, compactRatio: 0.4, handoffRatio: 0.6, window: 1_000_000,
  });
  assert.deepEqual(thresholdsForWindow(ratios, 200_000), {
    compactAt: 80_000, handoffAt: 120_000, maxSummaries: 6, compactRatio: 0.4, handoffRatio: 0.6, window: 200_000,
  });
  assert.throws(() => thresholdsForWindow(ratios, 0));
});

test('policy: 泄压阀阈值', () => {
  const thresholds = { maxSummaries: 6 };
  assert.equal(compactionPolicy({ summaries: 0, thresholds }).allowMergeOldSummaries, false);
  assert.equal(compactionPolicy({ summaries: 5, thresholds }).allowMergeOldSummaries, false);
  assert.equal(compactionPolicy({ summaries: 6, thresholds }).allowMergeOldSummaries, true);
});

/* ---------------- core/ranges ---------------- */
test('ranges: 取最近 N 条 + 配对平衡', () => {
  const nodes = [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }];
  const yes = () => true;
  assert.deepEqual(selectTestRange({ nodes, firstIdx: 1, nodeCount: 2, isBalancedBefore: yes, isBalancedAfter: yes }), {
    startSeq: 3,
    endSeq: 4,
    shadowedSeqs: [3, 4],
  });

  const range = selectTestRange({ nodes, firstIdx: 1, nodeCount: 3, isBalancedBefore: yes, isBalancedAfter: yes });
  assert.deepEqual(range.shadowedSeqs, [2, 3, 4]);

  // 起点不平衡 → 往前挪
  const balancedBefore = (seq) => seq === 3;
  assert.deepEqual(
    selectTestRange({ nodes, firstIdx: 1, nodeCount: 2, isBalancedBefore: balancedBefore, isBalancedAfter: yes }).shadowedSeqs,
    [3, 4],
  );

  // 尾部不平衡 → 往前缩
  const balancedAfter = (seq) => seq === 3;
  assert.deepEqual(
    selectTestRange({ nodes, firstIdx: 1, nodeCount: 3, isBalancedBefore: yes, isBalancedAfter: balancedAfter }).shadowedSeqs,
    [2, 3],
  );

  // 只剩 system + 1 条 → 压不了
  const short = [{ seq: 1 }, { seq: 2 }];
  assert.equal(selectTestRange({ nodes: short, firstIdx: 1, nodeCount: 4, isBalancedBefore: yes, isBalancedAfter: yes }), null);
});

test('ranges: M2 跳过旧摘要（不二压）', () => {
  const nodes = [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }, { seq: 5 }, { seq: 6 }];
  const yes = () => true;
  const range = selectFullRange({
    nodes,
    firstIdx: 1,
    checkpointIdx: 2,
    recentTailTokens: 0,
    isBalancedBefore: yes,
    isBalancedAfter: yes,
  });
  assert.deepEqual(range.shadowedSeqs, [4, 5, 6], '只压 checkpoint 之后的内容');
  const none = selectFullRange({
    nodes,
    firstIdx: 1,
    checkpointIdx: 5,
    recentTailTokens: 0,
    isBalancedBefore: yes,
    isBalancedAfter: yes,
  });
  assert.equal(none, null);
});

test('ranges: afterSeq 只压「比 checkpoint 新」的节点（旧尾部排在 checkpoint 后面也不误压）', () => {
  // 真机 2026-10-19 的 surface 形态：replace 把 checkpoint 插到被替换区间的位置，
  // 精压保留的旧尾部（seq 3..5）排在 checkpoint(seq 100) 之后，然后才是新消息。
  const nodes = [{ seq: 1 }, { seq: 100 }, { seq: 3 }, { seq: 4 }, { seq: 5 }, { seq: 200 }, { seq: 201 }, { seq: 202 }];
  const yes = () => true;
  const range = selectFullRange({
    nodes,
    firstIdx: 1,
    afterSeq: 100,
    recentTailTokens: 0,
    isBalancedBefore: yes,
    isBalancedAfter: yes,
  });
  assert.deepEqual(range.shadowedSeqs, [200, 201, 202], '旧尾部 seq 3..5 不在范围里');
  const onlyOld = selectFullRange({
    nodes: [{ seq: 1 }, { seq: 100 }, { seq: 3 }, { seq: 4 }],
    firstIdx: 1,
    afterSeq: 100,
    recentTailTokens: 0,
    isBalancedBefore: yes,
    isBalancedAfter: yes,
  });
  assert.equal(onlyOld, null, 'checkpoint 之后没有新消息 → 不压');
});

/* ---------------- core/prompts & handoff-doc ---------------- */
test('prompts: checkpoint 包帧', () => {
  const blocks = frameSummary([{ type: 'text', text: '总结内容' }]);
  assert.equal(blocks[0].text.includes(CHECKPOINT_PREAMBLE), true);
  assert.equal(blocks[0].text.includes(SUMMARY_OPEN_TAG), true);
  assert.equal(blocks[1].text, '总结内容');
  assert.equal(blocks.at(-1).text, '</compacted-summary>');
});

test('handoff-doc: 六段顺序 + 元信息头', () => {
  const generated = HANDOFF_SECTIONS.map((section) => `## ${section}\n- 内容-${section}`).join('\n');
  const doc = renderHandoffDoc({
    generated,
    sourceSessionId: 's1',
    sourceTitle: '原会话',
    now: new Date('2026-10-19T09:00:00Z'),
    pressure: 123,
    summaries: 2,
    file: '/tmp/x.md',
  });
  const positions = HANDOFF_SECTIONS.map((section) => doc.indexOf(`## ${section}`));
  assert.equal(positions.every((pos) => pos >= 0), true);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.equal(doc.startsWith('# 交接单'), true);
  assert.equal(doc.includes('原会话：s1'), true);
  assert.equal(doc.includes('原会话标题：原会话'), true);
  assert.equal(doc.includes('交接单路径：/tmp/x.md'), true);
  assert.equal(handoffFileName(new Date('2026-10-19T09:00:00Z')).startsWith('handoff-2026-10-19T09-00-00'), true);

  // M6：现场快照（启动时长/工作区/后台任务/模型）写进文档头。
  const withSite = renderHandoffDoc({
    generated,
    sourceSessionId: 's1',
    sourceTitle: '原会话',
    now: new Date('2026-10-19T09:00:00Z'),
    pressure: 123,
    summaries: 2,
    file: '/tmp/x.md',
    site: {
      hostStartedAt: new Date('2026-10-19T05:00:00Z'),
      hostUptimeMs: 4 * 3600 * 1000 + 12 * 60 * 1000,
      cwd: '/tmp/ws',
      git: { branch: 'main', head: 'abc12345' },
      jobs: [{ kind: 'bash', label: 'npm test' }],
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    },
  });
  assert.equal(withSite.includes('运行状态：DSH 本次启动于'), true);
  assert.equal(withSite.includes('已运行 4h12m'), true);
  assert.equal(withSite.includes('工作目录：/tmp/ws（git main@abc12345）'), true);
  assert.equal(withSite.includes('后台任务：1 个可能仍在运行（bash「npm test」）'), true);
  assert.equal(withSite.includes('当前模型：deepseek-official/deepseek-flash'), true);
  assert.equal(doc.includes('现场：'), false, '没有 site 时保持旧格式，不破坏兼容');
  assert.equal(formatDuration(45 * 60 * 1000), '45m');
  assert.equal(formatDuration(12 * 1000), '12s');
  assert.match(localTimeOf(new Date('2026-10-19T09:00:00Z')), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

/* ---------------- core/pins ---------------- */
test('pins: 记录快照 / 规范化 / 按钉住裁剪范围', () => {
  assert.deepEqual(normalizePinnedSeqs([5, 3, 3, -1, 1.5, 7]), [3, 5, 7]);
  assert.deepEqual(normalizePinnedSeqs(undefined), []);

  const events = [
    { type: PIN_RECORD_TYPE, ignorable: true, seq: 10, data: { seqs: [5, 3, 7] } },
  ];
  assert.deepEqual(latestPinnedSeqs(events), [3, 5, 7]);
  events.push({ type: PIN_RECORD_TYPE, ignorable: true, seq: 11, data: { seqs: [] } });
  assert.deepEqual(latestPinnedSeqs(events), [], '最后一条记录是空集合 → 已全部解除');
  assert.deepEqual(latestPinnedSeqs([]), []);
  assert.deepEqual(
    latestPinnedSeqs([{ type: 'plugin:other/stage', ignorable: true, data: { seqs: [1] } }]),
    [],
    '别的插件的 plugin record 不能认',
  );

  const range = { startSeq: 10, endSeq: 14, shadowedSeqs: [10, 11, 12, 13, 14] };
  assert.deepEqual(clipRangeByPins(range, []), range, '没钉住就不动');
  assert.deepEqual(clipRangeByPins(range, [30]), range, '范围外不裁');
  const clipped = clipRangeByPins(range, [13, 14]);
  assert.deepEqual(clipped.shadowedSeqs, [10, 11, 12]);
  assert.equal(clipped.endSeq, 12);
  assert.equal(clipped.pinnedCut, true);
  assert.equal(clipped.pinnedKept, 2);
  assert.equal(clipRangeByPins(range, [10]), null, '钉住挡在最前面 → 本次不压');
  assert.equal(clipRangeByPins(range, [9]), range, '钉在范围之前不影响');
});

test('validate-handoff: 九段齐全/缺段/空段/多余小节/前言/全占位', () => {
  const good = HANDOFF_SECTIONS.map(
    (section) => `## ${section}\n- ${section}：根据最近消息核对，完成 A 并记录 B 的结论（含证据）`,
  ).join('\n');
  const ok = validateHandoff(good);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(Object.keys(ok.sections).sort(), [...HANDOFF_SECTIONS].sort());

  assert.equal(validateHandoff('').problems.includes('交接文档是空的'), true);

  const missing = HANDOFF_SECTIONS.slice(1).map((section) => `## ${section}\n- 内容`).join('\n');
  const missingResult = validateHandoff(missing);
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.problems.some((problem) => problem.includes('缺少小节')), true);

  const emptySection = HANDOFF_SECTIONS.map((section) => `## ${section}\n${section === '总体目标' ? '' : '- 内容'}`).join('\n');
  assert.equal(validateHandoff(emptySection).problems.some((problem) => problem.includes('小节为空')), true);

  const extra = `${good}\n## 额外\n- x`;
  assert.equal(validateHandoff(extra).problems.some((problem) => problem.includes('未定义的小节')), true);

  const preamble = `这是开场白\n${good}`;
  assert.equal(validateHandoff(preamble).problems.some((problem) => problem.includes('多余文字')), true);

  // 2026-10-19 真机踩过：模型全写 (none)，旧校验放行 → 空壳文档被写盘 + 建新会话。
  const placeholderDoc = HANDOFF_SECTIONS.map((section) => `## ${section}\n- (none)`).join('\n');
  const placeholderResult = validateHandoff(placeholderDoc);
  assert.equal(placeholderResult.ok, false, '全部小节占位必须拒绝');
  assert.equal(placeholderResult.problems.some((problem) => problem.includes('占位符')), true);

  // 中文/全角变体也要认出来
  const chinesePlaceholder = HANDOFF_SECTIONS.map((section) => `## ${section}\n（无）`).join('\n');
  assert.equal(validateHandoff(chinesePlaceholder).ok, false);

  // 单段 (none) 是规格允许的，不能误伤
  const mixed = HANDOFF_SECTIONS.map(
    (section) =>
      `## ${section}\n${
        section === '已知问题'
          ? '(none)'
          : `- ${section}：根据最近消息核对，完成 A 并记录 B 的结论（含证据）`
      }`,
  ).join('\n');
  assert.equal(validateHandoff(mixed).ok, true, '只有部分小节占位时应当放行');

  // 2026-10-20 P1 探针：五段 (none) + 一句自然语言空话（旧白名单绕过）必须被拒。
  const naturalLanguagePlaceholder = HANDOFF_SECTIONS.map(
    (section, index) => `## ${section}\n${index === HANDOFF_SECTIONS.length - 1 ? '无明确未决问题。' : '- (none)'}`,
  ).join('\n');
  assert.equal(validateHandoff(naturalLanguagePlaceholder).ok, false, '自然语言空话不能绕过占位校验');

  // A1：writer 只让模型写 7 段；程序段（当前进度/改过的文件）出现也忽略。
  const modelOnly = [
    ...HANDOFF_MODEL_SECTIONS.map((section) => `## ${section}\n- ${section}：根据最近消息核对，完成 A 并记录 B 的结论（含证据）`),
    '## 当前进度\n- 程序段不该由模型写',
    '## 改过的文件\n- /tmp/program.js',
  ].join('\n');
  const modelResult = validateHandoff(modelOnly, { titles: HANDOFF_MODEL_SECTIONS });
  assert.equal(modelResult.ok, true, '只校验 model 段，程序段忽略');
  assert.deepEqual(Object.keys(modelResult.sections).sort(), [...HANDOFF_MODEL_SECTIONS].sort());

  assert.equal(describeHandoffProblems(['a', 'b']), '- a\n- b');
  assert.equal(HANDOFF_INSTRUCTION.includes('## 总体目标'), true);
  assert.equal(HANDOFF_INSTRUCTION.includes('## 当前进度'), false, '程序段不应要求模型输出');
  assert.equal(HANDOFF_INSTRUCTION.includes('## 改过的文件'), false, '程序段不应要求模型输出');
  assert.deepEqual(
    HANDOFF_HEADINGS,
    HANDOFF_SECTIONS.map((section) => `## ${section}`),
  );
});

test('A1: 九段规格表 / 程序段 / readiness / 改过的文件', () => {
  assert.equal(HANDOFF_SECTIONS.length, 9);
  assert.deepEqual(
    HANDOFF_SECTIONS,
    HANDOFF_SPEC.map((section) => section.title),
    '九段顺序以 handoff-spec 为唯一来源',
  );
  assert.deepEqual(HANDOFF_PROGRAM_SECTIONS, ['当前进度', '改过的文件']);

  const facts = buildHandoffProgramSections({
    compressHint: { ratio: 0.25 },
    summaries: 2,
    pressure: 12345,
    pins: { count: 1, seqs: [3] },
    changedFiles: ['/w/a.js'],
    site: { cwd: '/w', jobs: [{ kind: 'bash' }], hostStartedAt: new Date(), hostUptimeMs: 1000 },
  });
  assert.equal(facts['当前进度'].includes('25.0%'), true, '压缩判断点写进当前进度');
  assert.equal(facts['当前进度'].includes('2 次'), true);
  assert.equal(facts['当前进度'].includes('12345'), true);
  assert.equal(facts['当前进度'].includes('1 条'), true);
  assert.equal(facts['当前进度'].includes('1 个'), true);
  assert.equal(facts['改过的文件'], '- a.js', 'cwd 内路径应收成相对路径');

  const emptyFacts = buildHandoffProgramSections({});
  assert.equal(emptyFacts['改过的文件'].includes('没有记录到'), true);

  const fileSession = {
    log: [
      { type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path: '/w/a.js' }) } },
      { type: 'tool/call', data: { name: 'bash', arguments: JSON.stringify({ command: 'echo hi' }) } },
      { type: 'tool/call', data: { name: 'edit', arguments: JSON.stringify({ path: '/w/b.js' }) } },
      { type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path: '/w/a.js' }) } },
    ],
  };
  assert.deepEqual(changedFilesOf(fileSession), ['/w/a.js', '/w/b.js'], '只认写文件工具 + 去重');

  const sections = Object.fromEntries(HANDOFF_SECTIONS.map((title) => [title, `- ${title} 的实质内容`]));
  const ok = checkHandoffReadiness({ sections, surfaceText: '历史', changedFiles: [] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.warnings, []);

  const missing = { ...sections, 已知问题: '' };
  const bad = checkHandoffReadiness({ sections: missing, surfaceText: '历史' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing, ['已知问题']);

  const pathSections = { ...sections, 改过的文件: '- /tmp/not-in-history.js' };
  const warn = checkHandoffReadiness({ sections: pathSections, surfaceText: '历史里没有这个路径', changedFiles: [] });
  assert.equal(warn.ok, true, '路径只警告不阻断');
  assert.equal(warn.warnings.length, 1);
  assert.equal(warn.warnings[0].includes('not-in-history.js'), true);
});

test('prompts: 接棒前言/指令', () => {
  assert.equal(HANDOFF_PREAMBLE.includes('交接单'), true);
  assert.equal(HANDOFF_PREAMBLE.includes('不是用户发言'), true);
  for (const section of HANDOFF_MODEL_SECTIONS) assert.equal(HANDOFF_INSTRUCTION.includes(`## ${section}`), true);
  for (const section of HANDOFF_PROGRAM_SECTIONS) assert.equal(HANDOFF_INSTRUCTION.includes(`## ${section}`), false);
});

test('placeholders: 占位符识别（列表符号/全半角/中英变体）', () => {
  for (const line of ['(none)', '- (none)', '（none）', '（无）', '无', 'N/A', '-', '', '  ']) {
    assert.equal(isPlaceholderLine(line), true, `${JSON.stringify(line)} 应算占位`);
  }
  for (const line of ['无（等待用户拍板）', '- 待办：明天修复', 'none of the above is true', '(none)——所有工作已停']) {
    assert.equal(isPlaceholderLine(line), false, `${JSON.stringify(line)} 不应算占位`);
  }
  assert.equal(isPlaceholderText('\n- (none)\n（无）\n'), true);
  assert.equal(isPlaceholderText('- (none)\n- 真实内容'), false);

  // 2026-10-20 P1：自然语言空话也要认成占位。
  for (const line of ['无明确未决问题。', '暂无待办', '没有其他问题', 'No open questions.', 'Nothing yet.', '当前没有待办事项']) {
    assert.equal(isPlaceholderLine(line), true, `${JSON.stringify(line)} 应算占位`);
  }
  // 带真实信息/限定语的句子不能误伤。
  for (const line of ['无明确截止时间，周五前给回复', '无（等待用户拍板）', 'No additional files were changed.']) {
    assert.equal(isPlaceholderLine(line), false, `${JSON.stringify(line)} 不应算占位`);
  }
});

test('validate-summary: 六段结构校验', () => {
  const good = [
    {
      type: 'text',
      text: REQUIRED_SECTIONS.map((section) => `${section}\n- 关键事实：完成 A 验证，记录 B 结论（含证据）`).join('\n'),
    },
  ];
  assert.deepEqual(validateSummary(good).problems, []);
  assert.equal(validateSummary(good).ok, true);

  const missing = validateSummary([{ type: 'text', text: '## Current Goal\n- x' }]);
  assert.equal(missing.ok, false);
  assert.equal(missing.problems.filter((p) => p.startsWith('missing section')).length, REQUIRED_SECTIONS.length - 1);

  assert.equal(validateSummary([]).problems.includes('empty summary'), true);

  // 真机 2026-10-19 的垃圾摘要：复述任务、六段标题却齐全 → 必须拒绝。
  const echoed = validateSummary([
    {
      type: 'text',
      text: [
        '## Current Goal',
        '- Condense the last 33 messages of the conversation into a resume-ready checkpoint (compaction task).',
        '## Decisions & Facts',
        '- (none)',
        '## Files & Paths',
        '- (none)',
        '## Errors & Fixes',
        '- (none)',
        '## Still Pending',
        '- Produce the checkpoint in the required terse Markdown format with the six sections.',
        '- Keep the output at or under roughly 400 words.',
        '## Open Questions',
        '- (none)',
      ].join('\n'),
    },
  ]);
  assert.equal(echoed.ok, false, '复述指令的摘要必须被拒绝');
  assert.equal(echoed.problems.some((problem) => problem.includes('instruction echo')), true);

  // 六段全 (none)/空 → 没有可用信息，必须拒绝（否则会用垃圾 checkpoint 覆盖真实历史）。
  const placeholderSummary = REQUIRED_SECTIONS.map((section) => `${section}\n- (none)`).join('\n');
  const placeholderResult = validateSummary([{ type: 'text', text: placeholderSummary }]);
  assert.equal(placeholderResult.ok, false, '全占位摘要必须拒绝');
  assert.equal(placeholderResult.problems.some((problem) => problem.includes('placeholder-only summary')), true);

  // 2026-10-20 P1 探针：五段 (none) + 一句「No open questions.」也不能绕过。
  const naturalLanguagePlaceholder = REQUIRED_SECTIONS.map(
    (section, index) => `${section}\n${index === REQUIRED_SECTIONS.length - 1 ? '- No open questions.' : '- (none)'}`,
  ).join('\n');
  const naturalLanguageResult = validateSummary([{ type: 'text', text: naturalLanguagePlaceholder }]);
  assert.equal(naturalLanguageResult.ok, false, '自然语言空话不能绕过占位校验');
  assert.equal(naturalLanguageResult.problems.some((problem) => problem.includes('placeholder-only summary')), true);
  const emptyBodies = validateSummary([{ type: 'text', text: REQUIRED_SECTIONS.join('\n') }]);
  assert.equal(emptyBodies.ok, false, '六段标题齐全但正文全空也要拒绝');

  const nonTextFiltered = validateSummary([...good, { type: 'tool-call' }]);
  assert.equal(nonTextFiltered.ok, true);

  assert.equal(describeProblems(['a', 'b']), '- a\n- b');
});

/* ---------------- core/errors ---------------- */
test('errors: 已知 code 走文案', () => {
  assert.equal(errorText(actionError('busy', 'x')), errorText(actionError('busy', 'y')));
  assert.equal(errorText(new Error('boom')).startsWith('失败：boom'), true);
  // P3 清理新增的三个码：各自有稳定文案，不再落「失败：<原文>」。
  assert.equal(errorText(actionError('shrink', 'x')).includes('摘要比被替换'), true);
  assert.equal(errorText(actionError('pairing', 'x')).includes('工具调用'), true);
  assert.equal(errorText(actionError('nosession', 'x')), '当前没有活动会话。');
});

/* ---------------- core/colors（A8：从 client 上移，首次可单测） ---------------- */
test('colors: 基准色归一化 + 深浅两套派生都过 WCAG 3:1', () => {
  assert.equal(normalizeHex('#ABC', '#000000'), '#aabbcc');
  assert.equal(normalizeHex('#123456', '#000000'), '#123456');
  assert.equal(normalizeHex('red', '#000000'), '#000000');
  assert.equal(normalizeHex(undefined, '#000000'), '#000000');
  const base = { idle: '#6F7680', stage: '#2563EB', pin: '#C026D3', compact: '#C26A00', handoff: '#D92D20' };
  const light = paletteForScheme({ autoAdapt: true, base }, 'light');
  const dark = paletteForScheme({ autoAdapt: true, base }, 'dark');
  for (const key of ['idle', 'stage', 'pin', 'compact', 'handoff']) {
    assert.match(light[key], /^#[0-9a-f]{6}$/);
    assert.match(dark[key], /^#[0-9a-f]{6}$/);
    assert.ok(contrastRatio(light[key], '#ffffff') >= 3, `浅色 ${key} 对比度不足：${light[key]}`);
    assert.ok(contrastRatio(dark[key], '#1c1c22') >= 3, `深色 ${key} 对比度不足：${dark[key]}`);
  }
  // 关自动适配：两套都原样返回基准色（归一化会转小写）
  const lower = (palette) => Object.fromEntries(Object.entries(palette).map(([key, value]) => [key, value.toLowerCase()]));
  assert.deepEqual(paletteForScheme({ autoAdapt: false, base }, 'light'), lower(base));
  assert.deepEqual(paletteForBothSchemes({ autoAdapt: false, base }), { light: lower(base), dark: lower(base) });
  // 旧扁平颜色结构也认；旧结构没有 pin → 用默认锁定色兜底
  assert.equal(paletteForScheme({ autoAdapt: false, idle: '#101010' }, 'light').idle, '#101010');
  assert.equal(paletteForScheme({ autoAdapt: false, idle: '#101010' }, 'light').pin, '#C026D3');
});

test('colors: resolvePalette 优先用 host 下发的两套色板', () => {
  const base = { idle: '#6F7680', stage: '#2563EB', pin: '#C026D3', compact: '#C26A00', handoff: '#D92D20' };
  const palette = paletteForBothSchemes({ autoAdapt: true, base });
  // host 下发了 palette → 直接挑一套，不再本地派生
  assert.deepEqual(resolvePalette({ mode: 'auto', palette }, false), palette.light);
  assert.deepEqual(resolvePalette({ mode: 'auto', palette }, true), palette.dark);
  assert.deepEqual(resolvePalette({ mode: 'dark', palette }, false), palette.dark);
  // 没下发（旧 payload / 设置页未保存编辑）→ 本地派生，结果与 host 一致
  assert.deepEqual(resolvePalette({ autoAdapt: true, base }, false), palette.light);
  assert.deepEqual(resolvePalette({ autoAdapt: true, base }, true), palette.dark);
  // host 下发值不合法时按基准色兜底，不炸
  const broken = resolvePalette({ autoAdapt: false, base, palette: { light: { idle: 'oops' } } }, false);
  assert.equal(broken.idle, base.idle.toLowerCase());
  assert.equal(broken.stage, base.stage.toLowerCase());
});

/* ---------------- config ---------------- */
test('settings: 保存/校验/恢复默认（自己的 JSON 覆盖层）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-settings-'));
  const file = path.join(dir, 'compact-relay.json');
  const store = createSettingsStore({ config: {}, file });
  assert.equal(store.view().config.thresholds.compactRatio, 0.4);
  assert.equal(store.view().config.colors.base.idle, '#6F7680');
  // A8：视图顶层带浅/深两套派生色板（设置页预览可直接用已保存配置的结果）。
  assert.deepEqual(store.view().palettes, paletteForBothSchemes(store.current.colors));

  const saved = store.save({
    thresholds: { compactRatio: 0.3, handoffRatio: 0.55, maxSummaries: 4 },
    retention: { recentTailTokens: 0 },
    handoffDir: path.join(dir, 'handoffs'),
    colors: { mode: 'light', autoAdapt: false, base: { idle: '#123456' } },
  });
  assert.equal(saved.config.thresholds.compactRatio, 0.3);
  assert.equal(saved.config.colors.mode, 'light');
  assert.equal(saved.config.colors.autoAdapt, false);
  assert.equal(saved.config.colors.base.idle, '#123456');
  assert.equal(store.current.thresholds.maxSummaries, 4);
  assert.equal(fs.existsSync(file), true);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  // A4：磁盘格式升级为 {v:1, config:{...}} 信封。
  assert.equal(onDisk.v, 1);
  assert.equal(onDisk.config.thresholds.compactRatio, 0.3);
  // 公开视图由 schema 派生：内部字段不下发设置页。
  assert.equal('summary' in saved.config, false);
  assert.equal('timeouts' in saved.config, false);
  assert.equal('dev' in saved.config, false);
  assert.equal(typeof saved.config.links.tutorial, 'string');

  // 校验失败不落盘、也不改当前配置（中文文案带字段名）
  assert.throws(
    () => store.save({ thresholds: { compactRatio: 0.7, handoffRatio: 0.6 } }),
    /「压缩提醒线」/,
  );
  assert.equal(store.current.thresholds.compactRatio, 0.3);

  store.reset();
  assert.equal(store.current.thresholds.compactRatio, 0.4);
  assert.equal(store.current.colors.autoAdapt, true);
  assert.equal(fs.existsSync(file), false);
});

test('settings: 坏设置文件/旧扁平文件不阻断插件，错误可见且能恢复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-settings-bad-'));
  const file = path.join(dir, 'compact-relay.json');

  // 合法 JSON + 非法值：以前会让插件 apply 直接抛错；现在回落默认并上报字段。
  fs.writeFileSync(file, JSON.stringify({ thresholds: { compactRatio: 0.9 } }), 'utf8');
  const broken = createSettingsStore({ config: {}, file });
  assert.equal(broken.current.thresholds.compactRatio, 0.4);
  assert.notEqual(broken.view().settingsError, null);
  assert.equal(broken.view().settingsError.field, 'thresholds.compactRatio');
  assert.equal(broken.view().settingsError.message.includes('压缩提醒线'), true);
  assert.equal(broken.view().config.thresholds.compactRatio, 0.4, '设置页仍能读到默认配置');

  // 保存一次有效设置：覆盖坏文件并升级成信封。
  const fixed = broken.save({ thresholds: { compactRatio: 0.35 } });
  assert.equal(fixed.settingsError, null);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.v, 1);
  assert.equal(disk.config.thresholds.compactRatio, 0.35);

  // 坏 JSON：回落默认并提示；原文件保留（用户可手动看）。
  fs.writeFileSync(file, '{not json', 'utf8');
  const malformed = createSettingsStore({ config: {}, file });
  assert.equal(malformed.current.thresholds.compactRatio, 0.4);
  assert.equal(malformed.view().settingsError.message.includes('不是合法 JSON'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json', '读取失败不改写原文件');
  malformed.reset();
  assert.equal(fs.existsSync(file), false);

  // 旧扁平文件兼容读；保存时升级信封。
  fs.writeFileSync(file, JSON.stringify({ thresholds: { compactRatio: 0.3, handoffRatio: 0.5 } }), 'utf8');
  const legacy = createSettingsStore({ config: {}, file });
  assert.equal(legacy.view().settingsError, null);
  assert.equal(legacy.current.thresholds.compactRatio, 0.3);
  legacy.save({ retention: { recentTailTokens: 1_000 } });
  const upgraded = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(upgraded.v, 1);
  assert.equal(upgraded.config.thresholds.compactRatio, 0.3);
  assert.equal(upgraded.config.retention.recentTailTokens, 1_000);
});

test('config: 窗口比例阈值 + 兼容旧绝对值 + 校验', () => {
  const cfg = resolveConfig({ dev: { testRangeNodes: 3 } });
  assert.equal(cfg.thresholds.compactRatio, 0.4);
  assert.equal(cfg.thresholds.handoffRatio, 0.6);
  assert.equal(cfg.dev.testRangeNodes, 3);
  assert.equal(cfg.summary.maxTokens, 8192);
  assert.equal(cfg.handoff.maxTokens, 8192);
  // 显式比例优先
  const custom = resolveConfig({ thresholds: { compactRatio: 0.3, handoffRatio: 0.55 } });
  assert.equal(custom.thresholds.compactRatio, 0.3);
  assert.equal(custom.thresholds.handoffRatio, 0.55);
  // 旧版绝对写法按 contextWindowFallback 折算成比例（1M 下 400k/600k = 0.4/0.6）
  const legacy = resolveConfig({ compactAt: 350_000, handoffAt: 650_000 });
  assert.equal(legacy.thresholds.compactRatio, 0.35);
  assert.equal(legacy.thresholds.handoffRatio, 0.65);
  // M5：四状态基准色必须能从配置覆盖（客户端按明暗自动派生两套）。
  assert.equal(cfg.colors.mode, 'auto');
  assert.equal(cfg.colors.autoAdapt, true);
  for (const key of ['idle', 'stage', 'pin', 'compact', 'handoff']) {
    assert.equal(typeof cfg.colors.base[key], 'string', `colors.base.${key} 应该是字符串`);
  }
  // 强制模式 + 关自动适配 + 显式基准色
  const customColors = resolveConfig({ colors: { mode: 'dark', autoAdapt: false, base: { idle: '#111111' } } });
  assert.equal(customColors.colors.mode, 'dark');
  assert.equal(customColors.colors.autoAdapt, false);
  assert.equal(customColors.colors.base.idle, '#111111');
  // 旧扁平颜色结构：当作基准色，默认关自动适配（保持旧观感）
  const legacyColors = resolveConfig({ colors: { idle: '#101010', stage: '#202020', compact: '#303030', handoff: '#404040' } });
  assert.equal(legacyColors.colors.autoAdapt, false);
  assert.equal(legacyColors.colors.base.idle, '#101010');
  // GitHub 链接：默认指向仓库（0.3.1 起仓库已建），覆盖值必须是非空 http(s)
  assert.deepEqual(cfg.links, { tutorial: 'https://github.com/cfanzx/dsh-compact-relay/blob/main/TUTORIAL.md', feedback: 'https://github.com/cfanzx/dsh-compact-relay/issues' });
  const links = resolveConfig({ links: { feedback: 'https://github.com/example/relay/issues/new' } });
  assert.equal(links.links.feedback, 'https://github.com/example/relay/issues/new');
  assert.throws(() => resolveConfig({ links: { tutorial: 'ftp://example.com/x' } }));
  // 校验：颜色模式/自动适配/颜色值都必须合法
  assert.throws(() => resolveConfig({ colors: { mode: 'night' } }));
  assert.throws(() => resolveConfig({ colors: { autoAdapt: 'yes' } }));
  assert.throws(() => resolveConfig({ colors: { base: { idle: '' } } }));
  // 校验：比例必须在 (0,1)、compact < handoff、旧绝对值必须为正
  assert.throws(() => resolveConfig({ thresholds: { compactRatio: 0.7, handoffRatio: 0.6 } }));
  assert.throws(() => resolveConfig({ thresholds: { compactRatio: 1.2 } }), /「压缩提醒线」/);
  assert.throws(() => resolveConfig({ thresholds: { handoffRatio: 0 } }), /「交接提醒线」/);
  assert.throws(() => resolveConfig({ compactAt: -1 }));
  assert.throws(() => resolveConfig({ handoff: { maxTokens: 0 } }));
});

test('P3-01/14：摘要失败带具体原因、changed 提示重新预览（不再吞进「详见日志」）', () => {
  // 摘要失败：固定文案 + actionError 里那句可读原因
  const summary = errorText(actionError('summary', '摘要结构连续 3 次不合格：缺少「已完成」'));
  assert.equal(summary.includes('未能生成有效摘要'), true);
  assert.equal(summary.includes('原因：'), true);
  assert.equal(summary.includes('摘要结构连续 3 次不合格'), true);
  assert.equal(summary.includes('详见日志'), false);
  // 超长原因要截断，不能把整段校验清单倒给用户
  const long = errorText(actionError('summary', '很长的原因'.repeat(80)));
  assert.equal(long.length <= 200, true, `文案不该无限长：${long.length}`);
  // 没有具体原因时退回固定文案
  assert.equal(errorText(actionError('summary', '')), '未能生成有效摘要，本次未做改动。');
  // changed：告诉用户下一步（重新预览），而不是只说「日志里有记录」
  assert.equal(errorText(actionError('changed', '内部')).includes('重新预览'), true);
});

test('P3-02：摘要份数上限必须 ≥1（0 会同时触发恒交接+恒合并，没有意义）', () => {
  assert.throws(() => resolveConfig({ thresholds: { maxSummaries: 0 } }), /「摘要份数上限」/);
  assert.throws(() => resolveConfig({ thresholds: { maxSummaries: -1 } }), /「摘要份数上限」/);
  assert.throws(() => resolveConfig({ thresholds: { maxSummaries: 1.5 } }), /「摘要份数上限」/);
  assert.equal(resolveConfig({ thresholds: { maxSummaries: 1 } }).thresholds.maxSummaries, 1);
});

test('P2-3：失败事务的 summary 不算已压缩（幽灵摘要）', () => {
  const session = baseSession();
  // 失败事务：start → summary → end(error)，没有 replace
  session.append('compaction/start', { compactionId: 'fail-1' });
  const failedSummary = session.append('compaction/summary', { compactionId: 'fail-1', summary: [] });
  session.append('compaction/end', { compactionId: 'fail-1', error: { message: '摘要失败' } });
  assert.equal(countSummaries(session), 0, '失败事务不能算已压缩');

  // 成功事务：summary 被 replace 的 sourceEventSeqs 覆盖 + end 无 error
  session.append('compaction/start', { compactionId: 'ok-1' });
  const okSummary = session.append('compaction/summary', { compactionId: 'ok-1', summary: [] });
  session.append('user/message', { role: 'user', content: [] }, {
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 },
    sourceEventSeqs: [okSummary.seq],
  });
  session.append('compaction/end', { compactionId: 'ok-1' });
  assert.equal(countSummaries(session), 1);

  // 有 summary/end 但没 replace（另一种未提交形态）也不算
  session.append('compaction/start', { compactionId: 'fail-2' });
  session.append('compaction/summary', { compactionId: 'fail-2', summary: [] });
  session.append('compaction/end', { compactionId: 'fail-2' });
  assert.equal(countSummaries(session), 1, '没有 replace 的 summary 不算提交');

  // 无 compactionId 的旧日志：0.5.1 D01 起同样要求 replace（与 compaction-log 同口径）。
  const legacy = baseSession();
  const legacySummary = legacy.append('compaction/summary', { summary: [] });
  assert.equal(countSummaries(legacy), 0, '无 id 且无 replace 的旧日志不算已压缩（D01 统一口径）');
  legacy.append('user/message', { role: 'user', content: [] }, { sourceEventSeqs: [legacySummary.seq] });
  assert.equal(countSummaries(legacy), 1, '旧日志有 replace 仍算已压缩（0.4 兼容）');
});

test('P2-4：切模型后优先读 modelSelection 投影（pending → lastUsed）', () => {
  const session = { requestHeader: () => ({ config: { provider: 'p', model: 'old-model' } }) };
  const projection = (state) => ({
    get(name) {
      if (name !== 'sessionProjections') return undefined;
      return { stateOf: () => state };
    },
  });
  assert.equal(
    routeOf(projection({ lastUsed: { provider: 'p', model: 'old-model' }, pending: { provider: 'p', model: 'new-model' } }), session).model,
    'new-model',
    'pending 优先（刚切但还没发消息）',
  );
  assert.equal(
    routeOf(projection({ lastUsed: { provider: 'p', model: 'new-model' }, pending: null }), session).model,
    'new-model',
    'lastUsed 优先于旧 requestHeader',
  );
  assert.equal(routeOf({ get: () => undefined }, session).model, 'old-model', '投影不可用时回退请求头');
  const blank = { requestHeader: () => undefined };
  assert.equal(routeOf({ get: () => undefined }, blank), null);
});

/* ---------------- fake session / engine（统一到 test/harness，A7） ---------------- */

test('session-view: surface / 摘要计数 / 压缩锁', () => {
  const session = baseSession();
  assert.deepEqual(surfaceSeqs(session), [0, 1, 2, 3]);
  assert.equal(firstCompactableIdx(session), 1);
  assert.equal(countSummaries(session), 0);
  assert.deepEqual(entryState(session), { openTurn: false, lockActive: false, unmatchedStartSeq: null });

  session.append('compaction/start', { compactionId: 'x', turn: null });
  assert.equal(entryState(session).lockActive, true);
  session.append('compaction/end', { compactionId: 'x', turn: null });
  assert.equal(entryState(session).lockActive, false);

  session.append('turn/start', { turn: 1 });
  assert.equal(entryState(session).openTurn, true);
  session.append('turn/end', { turn: 1 });
  assert.equal(entryState(session).openTurn, false);

  // 0.5.1 D01：没有 replace 的 summary 不算已提交（与 compaction-log 同口径）。
  const bare = session.append('compaction/summary', { summary: [] });
  assert.equal(countSummaries(session), 0, '没有 replace 的 summary 不算提交');
  // 补一条覆盖它的 replace 之后才算（surface 顺序不变：head 仍是 system/message）。
  session.append('user/message', { role: 'user', content: [] }, { sourceEventSeqs: [bare.seq] });
  assert.equal(countSummaries(session), 1);
  assert.equal(firstCompactableIdx(session), 1);
});

test('session-view: pickAgent 认 0.2 的 list() 和 0.1 的 values()', () => {
  const a = { id: 's1' };
  const b = { id: 's2' };
  assert.equal(pickAgent({ agents: { list: () => [a, b] } }, undefined), b, '没有 sessionId 取最后一个');
  assert.equal(pickAgent({ agents: { list: () => [a, b], get: (id) => (id === 's1' ? a : undefined) } }, 's1'), a);
  assert.equal(pickAgent({ agents: { values: () => [a, b] } }, undefined), b, '兼容 0.1 的 values()');
  assert.equal(pickAgent({ agents: {} }, undefined), null);
  assert.equal(pickAgent({}, undefined), null);

  // 2026-10-19 真机坑：指定 sessionId 但该会话没 agent 时，绝不能回退到别的会话。
  assert.equal(pickAgent({ agents: { list: () => [a, b], get: () => undefined } }, 's3'), null, '找不到就 null，不许串会话');
  const live = { session: { id: 's2' } };
  assert.equal(pickAgent({ agents: { list: () => [live] } }, 's2'), live, 'list() 里按 session.id 也能命中');
  assert.equal(pickAgent({ agents: { list: () => [a] } }, 'missing'), null, '指定 id 不在时不许退回最后一个（会串会话）');
});

test('session-view: checkpoint 定位不因非 user 节点崩溃', () => {
  const session = baseSession();
  session.seed([
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [] } } },
    { type: 'user/message', data: { source: { kind: 'compact-checkpoint' }, message: {} } },
  ]);
  assert.equal(lastCheckpointSurfaceIdx(session, createFakeEngine().isCompactCheckpointSource), 5);

  const plain = baseSession();
  assert.equal(lastCheckpointSurfaceIdx(plain, createFakeEngine().isCompactCheckpointSource), -1);
});

test('transaction: append 顺序 / surfaceOp / sourceEventSeqs', async () => {
  const session = baseSession();
  const range = { startSeq: 1, endSeq: 2, shadowedSeqs: [1, 2], shadowedTokenCount: 123 };
  const engine = createFakeEngine();
  let summarizedSeqs = null;

  const result = await replaceRangeWithSummary({
    session,
    range,
    engine,
    summarize: async ({ shadowedSeqs }) => {
      summarizedSeqs = shadowedSeqs;
      return { summary: [{ type: 'text', text: '一段摘要' }], provider: 'mock', model: 'mock-model', maxTokens: 64 };
    },
  });

  assert.deepEqual(summarizedSeqs, [1, 2]);
  assert.deepEqual(
    session.log.slice(4).map((event) => event.type),
    ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'],
  );

  const replaceEvent = session.log[6];
  assert.deepEqual(replaceEvent.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 2 });
  assert.deepEqual(replaceEvent.sourceEventSeqs, [4, 5, 1, 2], 'sourceEventSeqs 必须带上全部被遮罩节点与 start/summary');

  assert.deepEqual(session.surface.nodes, [0, 6, 3], 'surface 应替换为摘要节点');
  assert.equal(result.summarySeq, 5);
  assert.equal(result.shadowedTokenCount, 123);
});

test('transaction: 失败也会补 compaction/end', async () => {
  const session = baseSession();
  const engine = createFakeEngine();
  const range = { startSeq: 1, endSeq: 2, shadowedSeqs: [1, 2], shadowedTokenCount: 1 };
  await assert.rejects(
    replaceRangeWithSummary({
      session,
      range,
      engine,
      summarize: async () => {
        throw new Error('llm down');
      },
    }),
  );
  const types = session.log.map((event) => event.type);
  assert.equal(types.includes('compaction/start'), true);
  assert.equal(types.filter((type) => type === 'compaction/end').length, 1);
  assert.equal(entryState(session).lockActive, false, '失败后不能留下压缩锁');
});

test('transaction: 已有未完成压缩 → busy', async () => {
  const session = baseSession();
  session.append('compaction/start', { compactionId: 'x', turn: null });
  await assert.rejects(
    replaceRangeWithSummary({
      session,
      range: { startSeq: 1, endSeq: 2, shadowedSeqs: [1, 2], shadowedTokenCount: 1 },
      engine: createFakeEngine(),
      summarize: async () => ({ summary: [], provider: 'm', model: 'm' }),
    }),
    (error) => error.code === 'busy',
  );
});

test('transaction: 范围在 surface 上不存在 → range', async () => {
  const session = baseSession();
  await assert.rejects(
    replaceRangeWithSummary({
      session,
      range: { startSeq: 9, endSeq: 10, shadowedSeqs: [9, 10], shadowedTokenCount: 1 },
      engine: createFakeEngine(),
      summarize: async () => ({ summary: [{ type: 'text', text: 'x' }], provider: 'm', model: 'm' }),
    }),
    (error) => error.code === 'range',
  );
});

/* ---------------- 0.3.1 环分段 + 断点 ---------------- */
test('0.3.1 环分段：未走满灰 / 阈值断点 / 模型断点优先 / 压缩后断点消失', () => {
  // 未到压缩线：一段灰，无断点。
  let ring = ringSegments(0.3, 0.4, 0.6, null);
  assert.deepEqual(ring.segments, [{ from: 0, to: 0.3, color: 'idle' }]);
  assert.deepEqual(ring.boundaries, []);
  assert.equal(ring.break1, null);

  // 到压缩线（阈值判断）：正常区整段蓝 + 压缩区琥珀 + 断点1。
  ring = ringSegments(0.45, 0.4, 0.6, null);
  assert.equal(ring.break1, 0.4);
  assert.deepEqual(ring.segments, [
    { from: 0, to: 0.4, color: 'stage' },
    { from: 0.4, to: 0.45, color: 'compact' },
  ]);
  assert.deepEqual(ring.boundaries, [{ at: 0.4 }]);

  // 模型在 25% 判断 → 断点1 落在 25%（没到压缩线也算走满）。
  ring = ringSegments(0.35, 0.4, 0.6, 0.25);
  assert.equal(ring.break1, 0.25);
  assert.deepEqual(ring.segments, [
    { from: 0, to: 0.25, color: 'stage' },
    { from: 0.25, to: 0.35, color: 'compact' },
  ]);

  // 模型判断在 45%（阈值先到）→ 断点仍取压缩线 40%。
  ring = ringSegments(0.5, 0.4, 0.6, 0.45);
  assert.equal(ring.break1, 0.4);

  // 越过交接线：红段 + 两个断点。
  ring = ringSegments(0.7, 0.4, 0.6, 0.3);
  assert.deepEqual(ring.boundaries, [{ at: 0.3 }, { at: 0.6 }]);
  assert.deepEqual(ring.segments.map((item) => item.color), ['stage', 'compact', 'handoff']);

  // 压缩后环变短（ratio 回落）→ 断点两侧没颜色，自然消失。
  ring = ringSegments(0.2, 0.4, 0.6, 0.3);
  assert.equal(ring.break1, null);
  assert.deepEqual(ring.boundaries, []);

  // 缺口裁切：首段起点不缩、末段终点不缩（浮点用近似比较）。
  const firstTrim = trimSegment({ from: 0, to: 0.4 }, 0.01, 0.6);
  assert.equal(firstTrim.from, 0);
  assert.ok(Math.abs(firstTrim.to - 0.39) < 1e-9);
  const lastTrim = trimSegment({ from: 0.4, to: 0.6 }, 0.01, 0.6);
  assert.ok(Math.abs(lastTrim.from - 0.41) < 1e-9);
  assert.equal(lastTrim.to, 0.6);
});

test('0.3.1 最小压缩线：配置值与动态下限取较大者', () => {
  // 1M 窗口：(40000+4000)/1M = 4.4% < 配置 5% → 5%
  assert.equal(compressionMinRatio({ minRatio: 0.05 }, { recentTailTokens: 40000 }, 1_000_000), 0.05);
  // 200K 窗口：(40000+4000)/200K = 22% → 22%（小窗口下 5% 根本压不出净收益）
  assert.equal(compressionMinRatio({ minRatio: 0.05 }, { recentTailTokens: 40000 }, 200_000), 0.22);
  // 用户配置更高 → 用配置。
  assert.equal(compressionMinRatio({ minRatio: 0.3 }, { recentTailTokens: 40000 }, 1_000_000), 0.3);
  assert.equal(MIN_COMPRESS_TOKENS, 4000);
  // 配置的 minRatio 必须小于压缩线。
  assert.throws(() => resolveConfig({ thresholds: { compactRatio: 0.4, minRatio: 0.5 } }), /最小压缩线/);
});

test('0.3.1 压缩判断记录：只认自己的类型 / 取最近一条 / checkpoint 后失效', () => {
  const events = [
    { seq: 1, type: 'user/message', data: {} },
    { seq: 2, type: COMPRESS_HINT_RECORD_TYPE, ignorable: true, data: { ratio: 0.25, at: 11 } },
    { seq: 3, type: COMPRESS_HINT_RECORD_TYPE, ignorable: true, data: { ratio: 0.3, at: 22 } },
    { seq: 4, type: 'plugin:other/compress-hint', ignorable: true, data: { ratio: 0.9, at: 33 } },
  ];
  const hint = latestCompressHint(events);
  assert.deepEqual(hint, { ratio: 0.3, at: 22, seq: 3 });
  assert.equal(latestCompressHint([]), null);
  assert.equal(compressHintIsActive(hint, 2), true);
  assert.equal(compressHintIsActive(hint, 3), false);
  assert.equal(compressHintIsActive(null, 2), false);
});

test('0.3.1 / 0.4 P0-1 markCompressHint：最小线以下 / 到压缩线都拒绝，区间内写记录 + 计量 U4', async () => {
  let tokens = 10_000; // 1% < 最小线 5%
  const session = {
    id: 's-hint',
    log: [],
    appendPluginRecord(type, data) {
      this.log.push({ type, ignorable: true, data, seq: this.log.length });
      return this.log.length;
    },
  };
  // 0.4 P0-1（U4）：deps.diag 注入后，每次调用都要记 markCalls / markAccepted / markRejected。
  const diag = createDiagCounters();
  const deps = {
    ctx: {
      tokenMeter: { measure: () => ({ totalTokens: tokens, surfaceTokens: tokens, nodes: [] }) },
      llm: { async resolveModelInfo() { return { context: { contextWindow: 1_000_000 } }; } },
    },
    cfg: resolveConfig({}),
    engine: { appendPluginRecord: (_session, type, data) => session.appendPluginRecord(type, data) },
    diag,
  };
  const countersOf = () => diag.snapshot().counters;
  assert.deepEqual(
    { markCalls: countersOf().markCalls, markAccepted: countersOf().markAccepted, markRejected: countersOf().markRejected },
    { markCalls: 0, markAccepted: 0, markRejected: 0 },
  );
  const agent = { id: 'agent-hint', session };
  let result = await markCompressHint(deps, { agent });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'below-min');
  assert.equal(session.log.length, 0, '被拒不改动任何历史');
  assert.deepEqual(
    { markCalls: countersOf().markCalls, markAccepted: countersOf().markAccepted, markRejected: countersOf().markRejected },
    { markCalls: 1, markAccepted: 0, markRejected: 1 },
    'below-min 被拒也要计数（被拒是零副作用的正常结果）',
  );

  tokens = 420_000; // 42% > 压缩线 40%
  result = await markCompressHint(deps, { agent });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'already-over');
  assert.equal(session.log.length, 0, 'already-over 被拒同样不改历史');

  tokens = 250_000; // 25%：最小线和压缩线之间
  result = await markCompressHint(deps, { agent });
  assert.equal(result.ok, true);
  assert.equal(session.log.length, 1);
  assert.equal(session.log[0].type, 'plugin:compact-relay/compress-hint');
  assert.equal(Math.round(session.log[0].data.ratio * 100), 25);
  assert.deepEqual(
    { markCalls: countersOf().markCalls, markAccepted: countersOf().markAccepted, markRejected: countersOf().markRejected },
    { markCalls: 3, markAccepted: 1, markRejected: 2 },
    'U4：成功 +1 accepted、两次被拒 +2 rejected',
  );

  // 没有活动会话（工具被调用但拿不到 session）：也算一次调用 + 一次被拒。
  result = await markCompressHint(deps, { agent: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-session');
  const finalCounters = countersOf();
  assert.equal(finalCounters.markCalls, 4);
  assert.equal(finalCounters.markAccepted, 1);
  assert.equal(finalCounters.markRejected, 3);
  assert.equal(
    finalCounters.markAccepted + finalCounters.markRejected,
    finalCounters.markCalls,
    '不变式：接受 + 拒绝 = 调用总数',
  );
});

test('0.3.1 原生压缩配置：解析覆盖 / 写入 auto（已有条目改值、没有条目追加）', () => {
  assert.deepEqual(parseCompactionOverride('[]\n'), { found: false });
  const text = [
    "- id: compaction-basic",
    "  name: '@deepseek-ai/dsh-compaction-basic'",
    '  config:',
    '    auto: false',
    '    thresholdRatio: 0.7',
    '- id: other',
    '  name: other',
  ].join('\n');
  assert.deepEqual(parseCompactionOverride(text), { found: true, autoEnabled: false, thresholdRatio: 0.7 });
  // 已有条目：改 auto，其他值不动。
  const changed = applyAutoOverride(text, true);
  assert.match(changed, /auto: true/);
  assert.match(changed, /thresholdRatio: 0.7/);
  // 没有条目：追加到末尾。
  const appended = applyAutoOverride('- id: other\n  name: other\n', false);
  assert.match(appended, /- id: compaction-basic/);
  assert.match(appended, /auto: false/);
  assert.equal(parseCompactionOverride(appended).autoEnabled, false);
  // 已有条目但没有 auto 行：插到 config 下。
  const noAuto = "- id: compaction-basic\n  name: '@deepseek-ai/dsh-compaction-basic'\n  config:\n    thresholdRatio: 0.6\n";
  const inserted = applyAutoOverride(noAuto, false);
  assert.match(inserted, /auto: false/);
  assert.equal(parseCompactionOverride(inserted).autoEnabled, false);
});




test('0.3.1：锁定消息在 state 里带「历史位置」（环上按位置画锁定块，方案 A）', async () => {
  const session = baseSession(); // surface = [0,1,2,3]
  const engine = createFakeEngine();
  const deps = {
    ctx: {
      tokenMeter: { measure: () => ({ totalTokens: 5_000, surfaceTokens: 5_000, nodes: [] }) },
      llm: { async resolveModelInfo() { return { context: { contextWindow: 1_000_000 } }; } },
    },
    cfg: resolveConfig({}),
    lock: { isBusy: () => false },
    engine,
  };
  const agent = { id: session.id, session };
  // 锁 seq1 / seq3；再塞一个已经不在 surface 的过期 seq99（应被过滤）
  session.appendPluginRecord(PIN_RECORD_TYPE, { seqs: [1, 3, 99], at: Date.now() });
  const state = await readState(deps, { agent });
  assert.equal(state.pins.count, 2, '过期 seq 不计入锁定数');
  assert.deepEqual(
    state.pins.marks,
    [
      { seq: 1, ratio: 1 / 3 },
      { seq: 3, ratio: 1 },
    ],
    '按 surface 索引算历史位置，且从早到晚排序',
  );
});



test('P3-12：state 帧带单调 revision（浏览器端据此丢弃晚到的旧帧）', async () => {
  const session = baseSession();
  const engine = createFakeEngine();
  const deps = {
    ctx: {
      agents: { get: () => undefined, list: () => [] },
      sessions: { get: () => undefined },
      tokenMeter: { measure: () => ({ totalTokens: 5_000, surfaceTokens: 5_000, nodes: [] }) },
      llm: { async resolveModelInfo() { return { context: { contextWindow: 1_000_000 } }; } },
    },
    cfg: resolveConfig({}),
    lock: { isBusy: () => false },
    engine,
  };
  const agent = { id: session.id, session };
  const first = await readState(deps, { agent });
  const second = await readState(deps, { agent });
  assert.equal(Number.isInteger(first.revision), true);
  assert.equal(Number.isInteger(second.revision), true);
  assert.equal(second.revision > first.revision, true, '每帧 revision 必须递增');
  // 空状态也有 revision（轮询在会话未就绪时也会返回帧）
  const empty = await readState(deps, {});
  assert.equal(empty.revision > second.revision, true);
});

test('P3-12：state 帧带单调 revision（浏览器端据此丢弃晚到的旧帧）', async () => {
  const session = baseSession();
  const engine = createFakeEngine();
  const deps = {
    ctx: {
      agents: { get: () => undefined, list: () => [] },
      sessions: { get: () => undefined },
      tokenMeter: { measure: () => ({ totalTokens: 5_000, surfaceTokens: 5_000, nodes: [] }) },
      llm: { async resolveModelInfo() { return { context: { contextWindow: 1_000_000 } }; } },
    },
    cfg: resolveConfig({}),
    lock: { isBusy: () => false },
    engine,
  };
  const agent = { id: session.id, session };
  const first = await readState(deps, { agent });
  const second = await readState(deps, { agent });
  assert.equal(Number.isInteger(first.revision), true);
  assert.equal(Number.isInteger(second.revision), true);
  assert.equal(second.revision > first.revision, true, '每帧 revision 必须递增');
  // 空状态也有 revision（轮询在会话未就绪时也会返回帧）
  const empty = await readState(deps, {});
  assert.equal(empty.revision > second.revision, true);
});

/* ---------------- 2026-10-19 分模块 debug 回归 ---------------- */

test('debug: validate-summary 不能被前言/围栏/行内占位绕过（空壳摘要拒绝）', () => {
  const sections = REQUIRED_SECTIONS;
  const normal = sections.map((section) => `${section}\n- 真实内容：完成 A 验证，记录 B 结论（含证据）`).join('\n');
  assert.equal(validateSummary([{ type: 'text', text: normal }]).ok, true);
  const allNone = sections.map((section) => `${section}\n(none)`).join('\n');
  assert.equal(validateSummary([{ type: 'text', text: allNone }]).ok, false);
  const preambleAndFence =
    'Here is the checkpoint:\n```\n' +
    sections.map((section) => `${section}\n(none)`).join('\n') +
    '\n```';
  assert.equal(validateSummary([{ type: 'text', text: preambleAndFence }]).ok, false);
  const inlinePlaceholder = sections.map((section) => `${section} (none)`).join('\n');
  assert.equal(validateSummary([{ type: 'text', text: inlinePlaceholder }]).ok, false);
  const emptyBody = sections.map((section) => `${section}`).join('\n');
  assert.equal(validateSummary([{ type: 'text', text: emptyBody }]).ok, false);
});

test('debug: 占位符变体（括号/暂无内容/待补充/nothing）', () => {
  for (const line of ['（暂无）', '（暂无内容）', '暂无内容', '待补充', 'nothing', 'N/A（无）', '- (none)']) {
    assert.equal(isPlaceholderLine(line), true, `${line} 应算占位`);
  }
  assert.equal(isPlaceholderLine('真实进展：写完契约'), false);
  assert.equal(isPlaceholderText('（暂无）\n- 待补充'), true);
  assert.equal(isPlaceholderText('（暂无）\n- 真实内容'), false);
});

test('debug: validate-handoff 六段顺序颠倒要拒绝', () => {
  const sections = HANDOFF_SECTIONS;
  const good = sections
    .map((section) => `## ${section}\n- ${section}：根据最近消息核对，完成 A 并记录 B 的结论（含证据）`)
    .join('\n');
  assert.equal(validateHandoff(good).ok, true);
  const reversed = [...sections]
    .reverse()
    .map((section) => `## ${section}\n- ${section}：根据最近消息核对，完成 A 并记录 B 的结论（含证据）`)
    .join('\n');
  const result = validateHandoff(reversed);
  assert.equal(result.ok, false);
  assert.equal(result.problems.some((problem) => problem.includes('顺序不对')), true);
});

test('debug: config 的 handoffDir 展开 ~ 且变绝对路径', () => {
  const home = os.homedir();
  assert.equal(resolveConfig({ handoffDir: '~/relay-handoffs' }).handoffDir, path.join(home, 'relay-handoffs'));
  assert.equal(resolveConfig({ handoffDir: 'relative-dir' }).handoffDir, path.resolve('relative-dir'));
  assert.equal(resolveConfig({}).handoffDir, path.join(home, '.dsh', 'handoffs'));
});


test('debug: ranges 对非单调 seq 的 afterSeq 切片返回 null；合并模式保留 surface 顺序', () => {
  const nodes = [{ seq: 1 }, { seq: 5 }, { seq: 2 }, { seq: 3 }];
  const bad = selectFullRange({
    nodes,
    firstIdx: 0,
    afterSeq: 3,
    recentTailTokens: 0,
    isBalancedBefore: () => true,
    isBalancedAfter: () => true,
  });
  assert.equal(bad, null);
  const merge = selectFullRange({
    nodes: [{ seq: 0 }, { seq: 38 }, { seq: 9 }, { seq: 10 }],
    firstIdx: 1,
    recentTailTokens: 0,
    isBalancedBefore: () => true,
    isBalancedAfter: () => true,
  });
  assert.notEqual(merge, null);
  assert.deepEqual(merge.shadowedSeqs, [38, 9, 10], '按 surface 位置切，不按 seq 大小');
});

test('debug: prefix 按 surface 位置回放（checkpoint seq 最大但插在旧尾部前）', () => {
  const events = {
    0: { seq: 0, type: 'system/message' },
    23: { seq: 23, type: 'user/message' },
    9: { seq: 9, type: 'user/message' },
    10: { seq: 10, type: 'user/message' },
  };
  const session = {
    surface: { nodes: [0, 23, 9, 10] },
    eventAt(seq) {
      return events[seq];
    },
    deriveEventMessage(event) {
      return { id: event.seq };
    },
  };
  assert.deepEqual(buildPrefix(session, 23).map((message) => message.id), [0, 23]);
  assert.deepEqual(surfaceMessages(session).map((message) => message.id), [0, 23, 9, 10]);
});

test('debug: 钉住裁剪按成员判定（seq 倒挂范围也能挡住）', () => {
  const range = { startSeq: 38, endSeq: 13, shadowedSeqs: [38, 9, 10, 11, 12, 13] };
  const clipped = clipRangeByPins(range, [11]);
  assert.notEqual(clipped, null);
  assert.deepEqual(clipped.shadowedSeqs, [38, 9, 10]);
  assert.equal(clipped.endSeq, 10);
  assert.equal(clipped.pinnedCut, true);
  assert.equal(clipped.pinnedKept, 1);
});

test('debug: 钉住截断后复检工具配对，不平衡就缩/拒绝', () => {
  const session = {
    id: 'debug-range',
    log: [
      { seq: 0, type: 'system/message' },
      { seq: 1, type: 'user/message' },
      { seq: 2, type: 'assistant/message' },
      { seq: 3, type: 'user/message' },
      { seq: 4, type: 'assistant/message' },
      { seq: 5, type: 'plugin:compact-relay/pin', ignorable: true, data: { seqs: [3] } },
    ],
    surface: { nodes: [0, 1, 2, 3, 4] },
    eventAt(seq) {
      return this.log.find((event) => event.seq === seq);
    },
  };
  const engine = {
    isCompactCheckpointSource: () => false,
    toolPairingBalancedBefore: () => true,
    toolPairingBalancedAfter: (_session, seq) => seq !== 2,
  };
  const cfg = resolveConfig({ retention: { recentTailTokens: 0 } });
  const nodes = session.surface.nodes.map((seq) => ({ seq, heuristicTokens: 10 }));
  const range = selectCompactableRange({ session, nodes, engine, cfg, tokenOf: (node) => node.heuristicTokens });
  assert.notEqual(range, null);
  assert.deepEqual(range.shadowedSeqs, [1], '被钉到 seq3 → 先裁到 [1,2]；终点 2 不平衡 → 再缩到 [1]');
  assert.equal(range.pinnedCut, true);
});

test('debug: resolveModelInfo 失败不永久缓存 fallback 窗口', async () => {
  let calls = 0;
  const ctx = {
    tokenMeter: { measure: () => ({ totalTokens: 3000, surfaceTokens: 2000, nodes: [] }) },
    llm: {
      async resolveModelInfo() {
        calls += 1;
        if (calls === 1) throw new Error('adapter not ready');
        return { context: { contextWindow: 200_000 } };
      },
    },
  };
  const session = {
    id: 'debug-pressure',
    requestHeader: () => ({ config: { provider: 'debug-pressure', model: 'debug-model' } }),
  };
  const agent = { session };
  const first = await measurePressure(ctx, agent, { windowFallback: 1_000_000 });
  assert.equal(first.window, 1_000_000, '首次失败用 fallback');
  const second = await measurePressure(ctx, agent, { windowFallback: 1_000_000 });
  assert.equal(second.window, 200_000, '第二次应重新解析，不再吃 fallback');
  assert.equal(calls, 2);
});

test('debug: 摘要比被遮罩内容大 → shrink 拒绝，历史不动', async () => {
  const session = baseSession();
  const before = [...session.surface.nodes];
  await assert.rejects(
    replaceRangeWithSummary({
      session,
      range: { startSeq: 1, endSeq: 2, shadowedSeqs: [1, 2], shadowedTokenCount: 2 },
      engine: createFakeEngine(),
      estimateMessage: () => 100,
      summarize: async () => ({ summary: [{ type: 'text', text: '很长的摘要' }], provider: 'm', model: 'm' }),
    }),
    (error) => error.code === 'shrink',
  );
  assert.deepEqual(session.surface.nodes, before, '历史不能被替换');
  assert.equal(session.log.some((event) => event.type === 'compaction/summary'), false);
  assert.equal(entryState(session).lockActive, false, '失败不能留下压缩锁');
});

test('debug: livePinnedSeqs 过滤已不在 surface 的过期钉住', () => {
  const session = baseSession(); // surface 0..3
  session.log.push({ seq: 4, type: 'plugin:compact-relay/pin', ignorable: true, data: { seqs: [2, 99] } });
  assert.deepEqual(livePinnedSeqs(session), [2]);
});

test('A9 架构守卫：dsh 层不反向 import actions/，adapters 不直接碰 dsh 细节', () => {
  const read = (relative) => fs.readFileSync(new URL(`../lib/${relative}`, import.meta.url), 'utf8');
  assert.equal(/from '\.\.\/actions\//.test(read('dsh/state-hub.js')), false, 'state-hub 不能 import actions/');
  const http = read('adapters/http.js');
  assert.equal(http.includes("from '../dsh/"), false, 'adapters/http 不能直接 import dsh/');
  const settings = read('actions/settings.js');
  assert.equal(settings.includes("from '../dsh/settings-file.js'"), true, '设置文件读写应落在 dsh 层');
  // 旧导入路径仍可用（兼容 shim）
  assert.equal(read('settings-store.js').includes('actions/settings.js'), true);
});

test('BUG-001/A1/A3 静态守卫：浮层用 DSH token、小字用次级 token、悬停卡允许换行', () => {
  const client = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.equal(client.includes("panelBg: '#ffffff'"), false, '浮层底色不能再写死纯白');
  assert.equal(client.includes('--dsw-menu-surface-fill'), true, '浮层要消费 DSH 菜单材质 token');
  assert.equal(client.includes('backdropFilter: theme.panelBackdrop'), true, '浮层要带 DSH 菜单毛玻璃');
  assert.equal(client.includes('--dsw-alias-bg-overlay'), true, '拿不到菜单 token 时回退 overlay token');
  assert.equal(client.includes('--dsw-alias-label-tertiary'), true, '小字用次级文字 token（对比度交给主题）');
  assert.equal(client.includes('data-ds-theme-source'), true, '主题 observer 要监听 DSH 主题属性');
  assert.equal(client.includes("maxWidth: 'min(320px, calc(100vw - 16px))'"), true, '悬停卡窄窗要收边');
});

test('A6 静态守卫：压缩历史端点 + 只读面板入口', () => {
  const http = fs.readFileSync(new URL('../lib/adapters/http.js', import.meta.url), 'utf8');
  assert.equal(http.includes("path: '/api/compact-relay-diff'"), true, '要做压缩历史只读端点');
  assert.equal(http.includes("hostRejection(webCtx, req)"), true, '新端点也要走宿主鉴权');
  const client = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.equal(client.includes('查看上次压缩'), true, '菜单要有「查看上次压缩」入口');
  assert.equal(client.includes('data-cr-diff'), true, '压缩历史面板要可定位');
  assert.equal(client.includes('/api/compact-relay-diff'), true, '面板要读只读端点');
  assert.equal(client.includes("'aria-label': '压缩记录'"), true, '面板要有可访问名称');
});

/* ---------------- run ---------------- */
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
