/**
 * 接力链 record 的**唯一构造点**（0.5.2 S2）。
 *
 * 为什么要有这个模块：0.5.1 之前父记录在 `actions/handoff.js` 手写 13–14 个键、
 * 子记录在 `dsh/sessions.js` 手写 9–10 个键 —— 两个写点各拼一份，加字段要改两处，
 * 漏一处就是静默降级（读侧 `normalizeRelayRecord` 对缺失/非法字段一律当没有）。
 * 现在「一条 record 长什么样」只有这一处实现，两个写点只负责传语义参数。
 *
 * ⚠️ **这是 record 的字节契约，不是普通的对象字面量，不许「统一美化」**：
 *   1. 键的**插入顺序**就是 `JSON.stringify` 的顺序（会话日志是 JSONL）。父/子两套
 *      顺序**故意不同**，都必须逐字节保留 —— `test/contract-golden.mjs` 锁住了顺序；
 *   2. 父记录多写 0.3 旧字段 `parentSessionId` / `index`（canonical 是 `parentId` /
 *      `ordinal`，新写入双写，旧记录仍按旧名可读）；
 *   3. 父记录写 `planId`（可能为 **null**）；子记录**没有**这个键；
 *   4. 父记录 `historyTitle` **条件写入**（改名没真的生效就不写这个键，不能记一个
 *      不存在的标题）；子记录没有这个键；
 *   5. 父/子 `path` 都是**条件写入**（`typeof path === 'string' && path.length > 0`）：
 *      子记录在旧调用方/落盘失败时拿不到交接单，就不写键、不写空串；父记录的调用方
 *      保证交接单已落盘（`path.join(handoffDir, handoffFileName(...))`，必然非空），
 *      所以父记录实际总是带 path —— golden 里有断言；
 *   6. 父/子都写 `titleSeq`，**即使为 null**（不是「省略 null」的统一策略：
 *      0.4.x 记录没有这个键，0.5.0 起显式写 null 表示「拿不到宿主 eventSeq」）。
 *
 * 纯函数：不读文件/环境/时间，不 import 任何 `node:` 模块；`atIso` 由调用方按本地
 * 时区口径算好传进来（core 不依赖 dsh 层），保证可在浏览器侧内联（build-client）。
 */

/** record 的两个角色（写点只有这两个：交接的父会话、新建的子会话）。 */
export const RELAY_RECORD_ROLES = Object.freeze(['parent', 'child']);

/**
 * 按角色产出一条 relay record（唯一构造）。
 *
 * 两个角色共用的字段：`parentId` / `childId` / `ordinal` / `title` / `baseTitle` /
 * `scheme` / `titleSeq` / `at` / `atIso`（`title` 是本次新会话标题）。
 *
 * @param {object} input
 * @param {'parent'|'child'} input.role 父记录（旧会话日志）还是子记录（新会话日志）
 * @param {string} input.parentId 父会话 id（写 `parentId`，parent 另写 `parentSessionId`）
 * @param {string} input.childId 子会话 id
 * @param {number} input.ordinal 链号（parent 另写 `index`）
 * @param {string} input.title 本次新会话标题
 * @param {string} input.baseTitle 链上原始标题（不带序号前缀）
 * @param {'handoff-n'|'history-n'} input.scheme 本次链的命名方案
 * @param {number|null} [input.titleSeq] 本次 rename 的宿主 eventSeq（拿不到就是 null）
 * @param {string} [input.path] 交接单路径（非空字符串才写键）
 * @param {string|null} [input.planId] 压缩计划 id（**仅 parent**；null 表示这次没压缩）
 * @param {string} [input.historyTitle] 旧会话改名后的「历史 N」标题（**仅 parent**，且只在改名生效时传）
 * @param {number} input.at 记录时间（epoch ms）
 * @param {string} input.atIso 记录时间（本地 ISO，含时区偏移）
 * @returns {object} 可直接交给 `engine.appendPluginRecord` 的 record
 */
export function relayRecordOfForm({
  role,
  parentId,
  childId,
  ordinal,
  baseTitle,
  title,
  scheme,
  titleSeq = null,
  path,
  planId,
  historyTitle,
  rootId,
  at,
  atIso,
} = {}) {
  if (role === 'parent') {
    return {
      parentId,
      childId,
      ordinal,
      at,
      atIso,
      // 0.3 旧字段双写（旧记录只读兼容）；顺序与 0.5.1 手写写法逐字节一致。
      parentSessionId: parentId,
      index: ordinal,
      ...(typeof path === 'string' && path.length > 0 ? { path } : {}),
      planId: planId ?? null,
      title,
      baseTitle,
      scheme,
      titleSeq,
      // 改名真的生效（renamed / already）时调用方才传 historyTitle；空串也当没有。
      ...(typeof historyTitle === 'string' && historyTitle.length > 0 ? { historyTitle } : {}),
      // 0.6：链根会话 id（收藏文件按链根定位）。
      ...(typeof rootId === 'string' && rootId.length > 0 ? { rootId } : {}),
    };
  }
  if (role === 'child') {
    return {
      parentId,
      childId,
      ordinal,
      baseTitle,
      title,
      scheme,
      titleSeq,
      // 旧调用方/落盘失败拿不到交接单 → 不写这个键（不猜、不写空串）。
      ...(typeof path === 'string' && path.length > 0 ? { path } : {}),
      at,
      atIso,
    };
  }
  // 角色是代码常量，传错属于开发期错误（不是用户输入），直接抛。
  throw new TypeError(`relayRecordOfForm: 未知 role「${String(role)}」（只认 ${RELAY_RECORD_ROLES.join(' / ')}）`);
}

/**
 * 父记录（写在**旧会话**日志里；子会话建好、旧会话改名之后）。
 *
 * 多写 0.3 旧字段 `parentSessionId` / `index` 和 `planId`，可选 `historyTitle`。
 * @param {Omit<Parameters<typeof relayRecordOfForm>[0], 'role'>} input
 * @returns {object}
 */
export function parentRelayRecordOf(input = {}) {
  return relayRecordOfForm({ ...input, role: 'parent' });
}

/**
 * 子记录（写在**新会话**日志里；`followup` 之后、`flush` 之前）。
 *
 * 只写 canonical 字段 + `titleSeq` + 条件 `path`；不写 `parentSessionId` / `index` /
 * `planId` / `historyTitle`（这些是父会话侧的旧字段/审计字段）。
 * @param {Omit<Parameters<typeof relayRecordOfForm>[0], 'role'>} input
 * @returns {object}
 */
export function childRelayRecordOf(input = {}) {
  return relayRecordOfForm({ ...input, role: 'child' });
}
