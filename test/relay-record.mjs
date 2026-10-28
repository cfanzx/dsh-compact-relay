/**
 * 0.5.2 S2 `core/relay-record.js` 单测 —— record 只有一个构造点。
 *
 * 为什么需要这个文件（除了 S1 的 `contract-golden.mjs`）：
 * S1 锁的是「真实交接流程产出的 record」，只能覆盖调用方实际走到的组合；
 * 构造器还有一批**只有写点才知道**的条件分支（historyTitle 只在改名生效时写、
 * path 有才带、titleSeq 恒写 null、子记录不写父会话侧字段）。这里用**冻结的
 * 0.5.1 手写写法**当锚点：把重构前 `actions/handoff.js` / `dsh/sessions.js` 里
 * 两个对象字面量原样搬成 `legacyParentRecordOf` / `legacyChildRecordOf`，
 * 对构造器的输出做 deepEqual + `JSON.stringify` 逐字节比较。
 *
 * 锚点故意写得「不好看」（键顺序、`...(cond ? {x} : {})` 的展开位置都保持原样）：
 * 它记录的是**线上字节**，不是代码风格。改锚点 = 改 record 契约，需要迁移方案。
 *
 *   node test/relay-record.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  RELAY_RECORD_ROLES,
  childRelayRecordOf,
  parentRelayRecordOf,
  relayRecordOfForm,
} from '../lib/core/relay-record.js';

/* ================================================================== *
 * 0. 冻结锚点：0.5.1 两个写点的手写写法（逐字符抄自重构前的代码）
 * ================================================================== */

/** 0.5.1 `lib/actions/handoff.js:270-288` 的父记录字面量（含条件展开的位置）。 */
function legacyParentRecordOf({
  parentId,
  childId,
  ordinal,
  at,
  atIso,
  path,
  planId,
  title,
  baseTitle,
  scheme,
  titleSeq,
  historyRename,
  schemeOfPlan,
}) {
  return {
    parentId,
    childId,
    ordinal,
    at,
    atIso,
    parentSessionId: parentId,
    index: ordinal,
    path,
    planId: planId ?? null,
    title,
    baseTitle,
    scheme,
    titleSeq,
    // 0.5.1 的行内条件（historyTitle 只在改名真的生效时写）。
    ...(schemeOfPlan === 'history-n' && (historyRename.renamed || historyRename.reason === 'already')
      ? { historyTitle: historyRename.title }
      : {}),
  };
}

/** 0.5.1 `lib/dsh/sessions.js:449-460` 的子记录字面量（含条件展开的位置）。 */
function legacyChildRecordOf({ parentId, childId, ordinal, baseTitle, title, scheme, titleSeq, path, at, atIso }) {
  return {
    parentId,
    childId,
    ordinal,
    baseTitle,
    title,
    scheme,
    titleSeq,
    ...(typeof path === 'string' && path.length > 0 ? { path } : {}),
    at,
    atIso,
  };
}

/** 冻结锚点与构造器输出必须**逐字节**一致（JSON.stringify 连键顺序 + undefined 语义一起比）。 */
function assertSameBytes(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label}: 与 0.5.1 手写形状不一致（deepEqual）`);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${label}: 键顺序/字节与 0.5.1 手写形状不一致`);
  assert.deepEqual(Object.keys(actual), Object.keys(expected), `${label}: 键顺序不一致`);
  // 任何 undefined 值都会被 JSON.stringify 静默丢弃 → 字节会悄悄变短。
  for (const key of Object.keys(actual)) {
    assert.notEqual(actual[key], undefined, `${label}.${key} 不能是 undefined（会被 JSON 吞掉）`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), actual, `${label}: JSON 往返必须稳定`);
}

const BASE = Object.freeze({
  parentId: 'session-parent',
  childId: 'session-child',
  ordinal: 3,
  baseTitle: '原会话标题',
  title: '原会话标题',
  scheme: 'history-n',
  titleSeq: 7,
  path: '/tmp/handoffs/handoff-2026-10-26T10-00-00-000Z.md',
  at: 1793000000000,
  atIso: '2026-10-26T10:00:00+08:00',
});

/* ================================================================== *
 * 1. 新链正常路径：父/子记录与 0.5.1 手写形状逐字节一致
 * ================================================================== */

{
  const historyRename = { renamed: true, title: '历史 3：原会话标题', titleSeq: 7, reason: null };
  const expectedParent = legacyParentRecordOf({
    ...BASE,
    planId: '703c96c9a7cc102c',
    historyRename,
    schemeOfPlan: 'history-n',
  });
  const actualParent = parentRelayRecordOf({ ...BASE, planId: '703c96c9a7cc102c', historyTitle: '历史 3：原会话标题' });
  assertSameBytes(actualParent, expectedParent, '父记录（新链 + 改名生效 + planId 有值）');
  assert.equal(actualParent.historyTitle, '历史 3：原会话标题');
  assert.equal(actualParent.planId, '703c96c9a7cc102c');
  assert.equal(actualParent.parentSessionId, 'session-parent', '0.3 旧字段双写');
  assert.equal(actualParent.index, 3, '0.3 旧字段双写');

  const expectedChild = legacyChildRecordOf(BASE);
  const actualChild = childRelayRecordOf(BASE);
  assertSameBytes(actualChild, expectedChild, '子记录（新链 + 有 path）');
  assert.deepEqual(Object.keys(actualChild), ['parentId', 'childId', 'ordinal', 'baseTitle', 'title', 'scheme', 'titleSeq', 'path', 'at', 'atIso']);

  // 两跳的真实数字：父记录 titleSeq 是旧会话 rename、子记录是子会话 rename（golden 里也有）。
  assert.equal(actualParent.titleSeq, BASE.titleSeq);
  assert.equal(actualChild.titleSeq, BASE.titleSeq);
}

console.log('PASS  0.5.2 S2 构造器：父/子输出与 0.5.1 手写 record 逐字节一致（含键顺序与双写字段）');

/* ================================================================== *
 * 2. 条件写入 / null 语义 / 角色隔离
 * ================================================================== */

{
  // 2.1 historyTitle：改名没生效（rename 失败 / 旧链 / 服务不可用）→ 不写这个键。
  for (const historyTitle of [undefined, null, '']) {
    const record = parentRelayRecordOf({ ...BASE, historyTitle });
    const expected = legacyParentRecordOf({
      ...BASE,
      historyRename: { renamed: false, title: '历史 3：原会话标题', titleSeq: null, reason: 'failed' },
      schemeOfPlan: 'history-n',
    });
    assert.equal('historyTitle' in record, false, `historyTitle=${JSON.stringify(historyTitle)} 时不能写键`);
    assertSameBytes(record, expected, `父记录（historyTitle=${JSON.stringify(historyTitle)}）`);
  }

  // 2.1b 非字符串/空串也不写（防止调用方把 reason='old-chain' 的 null 标题当值传进来）。
  assert.equal('historyTitle' in parentRelayRecordOf({ ...BASE, historyTitle: 0 }), false);
  assert.equal('historyTitle' in parentRelayRecordOf({ ...BASE, historyTitle: {} }), false);

  // 2.2 planId：父子不同 —— 父恒写（可能 null），子永远没有这个键。
  const parentNullPlan = parentRelayRecordOf({ ...BASE });
  assert.equal('planId' in parentNullPlan, true, '父记录 planId 是恒写键');
  assert.equal(parentNullPlan.planId, null, '没有 planId → 写 null，不是省略');
  const childWithPlanId = childRelayRecordOf({ ...BASE, planId: 'deadbeef', historyTitle: '历史 3：X', parentSessionId: 'x', index: 9 });
  assert.equal('planId' in childWithPlanId, false, '子记录不写 planId（传了也不写）');
  assert.equal('historyTitle' in childWithPlanId, false, '子记录不写 historyTitle（传了也不写）');
  assert.equal('parentSessionId' in childWithPlanId, false, '子记录不写 0.3 旧字段');
  assert.equal('index' in childWithPlanId, false, '子记录不写 0.3 旧字段');

  // 2.3 titleSeq：父子都**显式写 null**（0.4.x 记录没有这个键，0.5.0 起 null 表示「拿不到 eventSeq」）。
  for (const titleSeq of [null, undefined]) {
    const parent = parentRelayRecordOf({ ...BASE, titleSeq });
    const child = childRelayRecordOf({ ...BASE, titleSeq });
    assert.equal('titleSeq' in parent, true, '父记录 titleSeq 必须存在');
    assert.equal(parent.titleSeq, null, 'titleSeq 缺失 → 写 null');
    assert.equal('titleSeq' in child, true, '子记录 titleSeq 必须存在');
    assert.equal(child.titleSeq, null);
  }
  // 0 也不是合法序号（normalize 只认正整数）→ 构造器不替它改值（保持调用方口径）。
  assert.equal(childRelayRecordOf({ ...BASE, titleSeq: 0 }).titleSeq, 0);

  // 2.4 path：父子都「有非空字符串才写键」；空串/非字符串不写（不猜、不写空串）。
  for (const path of [undefined, null, '', 0, {}]) {
    const parent = parentRelayRecordOf({ ...BASE, path });
    const child = childRelayRecordOf({ ...BASE, path });
    assert.equal('path' in parent, false, `父记录 path=${JSON.stringify(path)} 时不能写键`);
    assert.equal('path' in child, false, `子记录 path=${JSON.stringify(path)} 时不能写键`);
    assertSameBytes(child, legacyChildRecordOf({ ...BASE, path }), `子记录（path=${JSON.stringify(path)}）`);
  }

  // 2.5 角色隔离：父记录不会带子记录专属字段形态，反之亦然（键集合互不污染）。
  const parentKeys = Object.keys(parentRelayRecordOf(BASE));
  const childKeys = Object.keys(childRelayRecordOf(BASE));
  assert.deepEqual(parentKeys, ['parentId', 'childId', 'ordinal', 'at', 'atIso', 'parentSessionId', 'index', 'path', 'planId', 'title', 'baseTitle', 'scheme', 'titleSeq']);
  assert.deepEqual(childKeys, ['parentId', 'childId', 'ordinal', 'baseTitle', 'title', 'scheme', 'titleSeq', 'path', 'at', 'atIso']);
  assert.notDeepEqual(parentKeys, childKeys, '父/子键顺序故意不同（JSONL 字节契约）');

  // 2.6 统一入口：两个包装器就是同一个构造器（唯一构造点的证据）。
  assertSameBytes(parentRelayRecordOf(BASE), relayRecordOfForm({ ...BASE, role: 'parent' }), 'parentRelayRecordOf ≡ relayRecordOfForm(role=parent)');
  assertSameBytes(childRelayRecordOf(BASE), relayRecordOfForm({ ...BASE, role: 'child' }), 'childRelayRecordOf ≡ relayRecordOfForm(role=child)');
  // 包装器不能被入参里的 role 覆盖。
  assertSameBytes(parentRelayRecordOf({ ...BASE, role: 'child' }), relayRecordOfForm({ ...BASE, role: 'parent' }), 'parentRelayRecordOf 忽略入参 role');
}

console.log('PASS  0.5.2 S2 条件键：historyTitle 仅改名生效 / planId 仅父 / path 有才带 / titleSeq 恒写 null / 角色隔离');

/* ================================================================== *
 * 3. 纯函数约束（可内联）+ 开发期错误
 * ================================================================== */

{
  // 3.1 零 Node API、零模块依赖：core 模块要能被 build-client 内联到浏览器侧。
  const source = fs.readFileSync(new URL('../lib/core/relay-record.js', import.meta.url), 'utf8');
  // 注释里可以写「不得用 node:」这类说明，扫描前去掉注释，只看代码。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/^\s*import\s/m.test(code), false, 'core/relay-record 不得 import 任何模块（内联约束）');
  assert.equal(/\bnode:/.test(code), false, 'core/relay-record 不得使用 node: 模块');
  assert.equal(/\bprocess\s*\./.test(code), false, 'core/relay-record 不得读 process');
  assert.equal(/\bBuffer\b/.test(code), false, 'core/relay-record 不得用 Buffer');
  assert.equal(/\bDate\s*\.\s*now\b/.test(code), false, 'core/relay-record 不得读时钟（at/atIso 由调用方传入）');
  assert.equal(/\bMath\s*\.\s*random\b/.test(code), false, 'core/relay-record 不得有随机性');
  assert.equal(/\brequire\s*\(/.test(code), false, 'core/relay-record 不得 require');

  // 3.2 构造器是纯的：同一入参两次调用 → 两个对象、同样的字节（没有共享可变状态）。
  const first = parentRelayRecordOf({ ...BASE });
  const second = parentRelayRecordOf({ ...BASE });
  assert.notEqual(first, second, '每次返回新对象（调用方改不坏内部状态）');
  assert.equal(JSON.stringify(first), JSON.stringify(second), '同入参 → 同字节');

  // 3.3 未知 role 属于开发期错误（不是用户输入）：直接抛，不产出一条畸形 record。
  assert.throws(() => relayRecordOfForm({ ...BASE, role: 'child2' }), TypeError);
  assert.throws(() => relayRecordOfForm({ ...BASE }), TypeError);
  assert.throws(() => relayRecordOfForm(), TypeError);
  assert.deepEqual(RELAY_RECORD_ROLES, ['parent', 'child'], '角色常量与写点一一对应');

  // 3.4 深拷贝检查：返回值不引用入参里的对象（父/子记录都是扁平标量，这里只是把契约写清楚）。
  const input = { ...BASE };
  const record = parentRelayRecordOf(input);
  record.parentId = 'mutated';
  assert.equal(input.parentId, 'session-parent', '构造器不能把入参对象挂进 record');
}

console.log('PASS  0.5.2 S2 纯函数约束：零 import/零 Node API/无时钟随机；未知 role 抛 TypeError');
