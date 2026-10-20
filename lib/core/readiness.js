/**
 * 交接单就绪检查（A1）—— 在写盘/建新会话前给出一份可读清单。
 *
 * 阻断项（missing）：九段缺段/空段/全占位（validate-handoff 已拦，这里再兜一层）。
 * 警告项（warnings）：文档里提到的绝对路径在会话日志里找不到（只警告，不阻断，
 * 避免路径写法不同造成误杀）。
 */
import { HANDOFF_SPEC, HANDOFF_SECTIONS } from './handoff-spec.js';
import { isPlaceholderText } from './placeholders.js';

/** 从文本里抽绝对/家目录路径（只做只读核对，不访问文件系统）。 */
export function pathsInText(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const found = new Set();
  const matches = text.match(/(?<![\w./])(?:~\/|\/Users\/|\/private\/|\/tmp\/)[^\s"'“”‘’()（）\[\]，。；、]+/gu);
  for (const match of matches ?? []) {
    const clean = match.replace(/[`.,;:!?]+$/u, '');
    if (clean.length > 1) found.add(clean);
  }
  return [...found];
}

/**
 * @param {object} input
 * @param {Record<string,string>} input.sections 九段正文
 * @param {string} [input.surfaceText] 会话 surface 的纯文本（用于路径核对）
 * @param {string[]} [input.changedFiles] 程序收集到的文件路径
 * @param {number} [input.messageCount] 会话 surface 里的消息条数（判断内容是否太少）
 * @returns {{ok:boolean, missing:string[], warnings:string[]}}
 */
export function checkHandoffReadiness({ sections, surfaceText = '', changedFiles = [], messageCount = null }) {
  /** @type {string[]} */
  const missing = [];
  for (const spec of HANDOFF_SPEC) {
    if (spec.required !== true) continue;
    const body = (sections?.[spec.title] ?? '').trim();
    if (body.length === 0 || isPlaceholderText(body)) missing.push(spec.title);
  }

  /** @type {string[]} */
  const warnings = [];
  // 0.3.1：会话太短时模型容易把系统提示/格式要求当会话内容写进交接单，先提醒用户。
  if (typeof messageCount === 'number' && messageCount < 8) {
    warnings.push('这个会话内容很少（少于 8 条消息），交接单可能没什么实质内容；建议再聊出些内容后再交接。');
  }
  const known = `${surfaceText}\n${Array.isArray(changedFiles) ? changedFiles.join('\n') : ''}`;
  if (known.trim().length > 0) {
    const mentioned = [];
    for (const title of HANDOFF_SECTIONS) {
      const body = sections?.[title];
      if (typeof body === 'string' && body.length > 0) mentioned.push(...pathsInText(body));
    }
    const seen = new Set();
    for (const file of mentioned) {
      if (seen.has(file)) continue;
      seen.add(file);
      if (!known.includes(file)) warnings.push(`提到的路径在会话历史里找不到：${file}`);
      if (warnings.length >= 5) break;
    }
  }

  return { ok: missing.length === 0, missing, warnings };
}
