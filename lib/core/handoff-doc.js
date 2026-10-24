/**
 * 交接单 —— 纯数据 → markdown。
 *
 * 九段标题的唯一来源是 core/handoff-spec.js（A1）；这里只保留渲染与文件命名，
 * action / HTTP / 测试共用同一个 HANDOFF_SECTIONS。
 * M3 起文档内容由模型写（core/prompts.js 的 HANDOFF_INSTRUCTION），
 * 这里把模型输出 + 程序收集段装进带元信息的文档壳。
 */
import { HANDOFF_SECTIONS } from './handoff-spec.js';

export { HANDOFF_SECTIONS };

/** 九段在 markdown 里的完整标题行。 */
export const HANDOFF_HEADINGS = Object.freeze(HANDOFF_SECTIONS.map((section) => `## ${section}`));

/**
 * 生成交接单文件名（时间戳安全）。
 * @param {Date} [date]
 * @returns {string}
 */
export function handoffFileName(date = new Date()) {
  return `handoff-${date.toISOString().replace(/[:.]/g, '-')}.md`;
}

const pad2 = (value) => String(value).padStart(2, '0');

/**
 * 本地时间（带时区偏移），例如 2026-10-19T20:31:42+08:00。
 * @param {Date} date
 * @returns {string}
 */
export function localTimeOf(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '未知';
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

/**
 * 人类可读时长：3h12m / 45m / 12s。
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  if (total >= 3600) return `${Math.floor(total / 3600)}h${pad2(Math.floor((total % 3600) / 60))}m`;
  if (total >= 60) return `${Math.floor(total / 60)}m`;
  return `${total}s`;
}

/**
 * 文档头里的「现场快照」行（没有 site 就一行都不加，向后兼容）。
 * @param {object|undefined} site
 * @returns {string[]}
 */
function siteLines(site) {
  if (site === null || typeof site !== 'object') return [];
  const lines = [];

  if (site.hostStartedAt instanceof Date && Number.isFinite(site.hostUptimeMs)) {
    lines.push(
      `- 运行状态：DSH 本次启动于 ${localTimeOf(site.hostStartedAt)}，已运行 ${formatDuration(site.hostUptimeMs)}`,
    );
  }
  if (typeof site.cwd === 'string' && site.cwd.length > 0) {
    const git = site.git;
    const gitText =
      git === null || typeof git !== 'object'
        ? '非 git 仓库'
        : git.branch !== null && git.branch !== undefined
          ? `git ${git.branch}${git.head ? `@${git.head}` : ''}`
          : `git 分离头${git.head ? ` @${git.head}` : ''}`;
    lines.push(`- 工作目录：${site.cwd}（${gitText}）`);
  }
  if (Array.isArray(site.jobs)) {
    if (site.jobs.length === 0) {
      lines.push('- 后台任务：无');
    } else {
      const shown = site.jobs
        .slice(0, 3)
        .map((job) => `${job.kind}${job.label ? `「${job.label}」` : ''}`)
        .join('、');
      const more = site.jobs.length > 3 ? ` 等 ${site.jobs.length} 个` : '';
      lines.push(`- 后台任务：${site.jobs.length} 个可能仍在运行（${shown}${more}）`);
    }
  }
  if (typeof site.provider === 'string' || typeof site.model === 'string') {
    lines.push(`- 当前模型：${site.provider ?? '未知'}/${site.model ?? '未知'}`);
  }
  return lines;
}

/**
 * 把模型写的九段正文装进交接单（带元信息头）。
 * @param {object} input
 * @param {string} input.generated 模型输出的九段正文
 * @param {string} [input.sourceSessionId] 原会话 id
 * @param {string} [input.sourceTitle] 原会话标题
 * @param {Date} [input.now]
 * @param {number|null} [input.pressure] 写文档时的上下文压力（token）
 * @param {number} [input.summaries] 原会话已发生的压缩摘要份数
 * @param {string} input.file 本文件绝对路径（写进文档头，方便回查）
 * @param {object} [input.site] 现场快照（dsh/site-info.buildSiteSnapshot 的产物）
 * @param {number} [input.ordinal] 0.4 P2-2：本次是第几次交接（链式序号，首次 1）
 * @returns {string}
 */
export function renderHandoffDoc({
  generated,
  sourceSessionId,
  sourceTitle,
  now = new Date(),
  pressure,
  summaries,
  file,
  site,
  ordinal,
}) {
  const lines = [
    '# 交接单',
    '',
    `- 生成时间：${now.toISOString()}（本地 ${localTimeOf(now)}）`,
    ...siteLines(site),
    `- 原会话：${sourceSessionId ?? '未知'}`,
    `- 原会话标题：${sourceTitle ?? '（未命名）'}`,
    // 0.4 P2-2：接力链元数据可读化——文档头直接写「第 N 次交接」，接手者不用解析标题。
    ...(Number.isInteger(ordinal) && ordinal > 0 ? [`- 交接序号：第 ${ordinal} 次交接`] : []),
    `- 已压缩次数：${summaries ?? 0}`,
    `- 交接时已用容量：${pressure ?? '未知'}`,
    `- 交接单路径：${file ?? '（未落盘）'}`,
    '',
    String(generated ?? '').trim(),
    '',
  ];
  return lines.join('\n');
}
