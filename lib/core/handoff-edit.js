/**
 * 交接预览「两段可编辑」（0.4 P2-1）—— 纯函数，零依赖。
 *
 * 只有 `约束` / `下一步` 两段允许用户改；其它七段一律来自模型或程序，**前后端都不接受覆盖**。
 * 校验口径（方案 P2-1）：
 *  - 非法字段（程序生成段/拼错的段名/非对象）→ 抛 `actionError('edits', …)`，由 HTTP 适配层回 400；
 *  - 值必须是字符串；trim 后为空 → 视为「没改」，回落生成后的原文（不覆盖）；
 *  - 单段长度上限 `HANDOFF_EDIT_MAX_CHARS`，超限拒绝（不截断，避免用户以为保存成功）；
 *  - 只有用户确认交接时才应用（本模块只算覆盖结果，不写盘）。
 */
import { actionError } from './errors.js';
import { HANDOFF_EDITABLE_SECTIONS } from './handoff-spec.js';

/** 单段编辑长度上限（字符）。 */
export const HANDOFF_EDIT_MAX_CHARS = 4000;

/**
 * 校验并规整用户编辑。只返回「真正要覆盖」的段（空值已剔除）。
 *
 * @param {unknown} edits 客户端提交的 { 段标题: 文本 }
 * @returns {Record<string, string>} 段标题 → trim 后的新正文（可能为空对象）
 * @throws {Error & {code:'edits'}} 非法字段/类型/超长
 */
export function normalizeHandoffEdits(edits) {
  if (edits === undefined || edits === null) return {};
  if (typeof edits !== 'object' || Array.isArray(edits)) {
    throw actionError('edits', '编辑内容必须是一个对象（只允许「约束」「下一步」两段）');
  }
  const allowed = new Set(HANDOFF_EDITABLE_SECTIONS);
  const out = {};
  for (const [title, raw] of Object.entries(edits)) {
    if (!allowed.has(title)) {
      const program = title === '当前进度' || title === '改过的文件' ? '（程序生成的段）' : '';
      throw actionError(
        'edits',
        `只能编辑「${HANDOFF_EDITABLE_SECTIONS.join('」「')}」两段，不能改「${title}」${program}；其余段落由模型/程序生成`,
      );
    }
    if (typeof raw !== 'string') {
      throw actionError('edits', `「${title}」的编辑内容必须是字符串`);
    }
    const text = raw.trim();
    if (text.length === 0) continue; // 空值回落原文
    if (text.length > HANDOFF_EDIT_MAX_CHARS) {
      throw actionError('edits', `「${title}」超过长度上限 ${HANDOFF_EDIT_MAX_CHARS} 字符（当前 ${text.length}）`);
    }
    out[title] = text;
  }
  return out;
}

/**
 * 把编辑覆盖到生成后的九段上（只动可编辑段，返回新对象，不改入参）。
 * @param {Record<string,string>} sections 生成后的九段（标题 → 正文）
 * @param {Record<string,string>} edits normalizeHandoffEdits 的产物
 * @returns {Record<string,string>} 覆盖后的九段（新对象）
 */
export function applyHandoffEdits(sections, edits) {
  const source = sections !== null && typeof sections === 'object' ? sections : {};
  const overrides = edits !== null && typeof edits === 'object' ? edits : {};
  const out = { ...source };
  for (const title of HANDOFF_EDITABLE_SECTIONS) {
    const text = overrides[title];
    if (typeof text === 'string' && text.trim().length > 0) out[title] = text.trim();
  }
  return out;
}

/**
 * 预览接口给客户端的「可编辑段」信息（客户端只渲染这两段 textarea）。
 * @param {Record<string,string>} sections 生成后的九段
 * @returns {{titles:string[], maxChars:number, note:string, sections:Record<string,string>}}
 */
export function editableHandoffView(sections) {
  const source = sections !== null && typeof sections === 'object' ? sections : {};
  const picked = {};
  for (const title of HANDOFF_EDITABLE_SECTIONS) {
    picked[title] = typeof source[title] === 'string' ? source[title] : '';
  }
  return {
    titles: [...HANDOFF_EDITABLE_SECTIONS],
    maxChars: HANDOFF_EDIT_MAX_CHARS,
    note: '只允许编辑这两段；总体目标 / 当前进度 / 改过的文件等由模型或程序生成，不能改（留空 = 使用原文）。',
    sections: picked,
  };
}
