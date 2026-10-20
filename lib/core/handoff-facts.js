/**
 * 交接单「程序收集段」—— 纯函数，把会话事实拼成两段 markdown 要点。
 *
 * 只做事实陈述，不解释、不推测；拿不到的数据写「未知」。
 * 输入来自 handoff action：compressHint（模型判断点）/摘要数/压力/锁定/现场快照/改过的文件。
 */

/** 把绝对路径收成相对 cwd 的短路径（cwd 之外保留绝对）。 */
function shortPath(file, cwd) {
  if (typeof file !== 'string' || file.length === 0) return '';
  if (typeof cwd === 'string' && cwd.length > 0 && file.startsWith(`${cwd}/`)) return file.slice(cwd.length + 1);
  return file.replace(/^\/Users\/[^/]+\//u, '~/');
}

/**
 * @param {object} facts
 * @param {object|null} [facts.compressHint] 模型判断「这里适合压缩」的产物
 * @param {number} [facts.summaries] 已压缩次数
 * @param {number|null} [facts.pressure] 已用容量（token）
 * @param {{count:number, seqs:number[]}|null} [facts.pins] 锁定消息
 * @param {string[]} [facts.changedFiles] 本会话写/改过的文件
 * @param {object|null} [facts.site] buildSiteSnapshot 的产物
 * @returns {Record<string,string>} 标题 → 正文
 */
export function buildHandoffProgramSections(facts = {}) {
  const { compressHint, summaries, pressure, pins, changedFiles, site } = facts;
  const cwd = site !== null && typeof site === 'object' ? site.cwd : undefined;

  const jobs = site !== null && typeof site === 'object' && Array.isArray(site.jobs) ? site.jobs : [];
  const progressLines = [
    `- 压缩判断点：${compressHint !== null && compressHint !== undefined && typeof compressHint.ratio === 'number' ? `模型在 ${(compressHint.ratio * 100).toFixed(1)}% 处判断过「适合压缩」` : '未判断'}`,
    `- 已压缩：${Number.isFinite(summaries) ? summaries : 0} 次`,
    `- 已用容量：${Number.isFinite(pressure) ? pressure : '未知'}`,
    `- 锁定消息：${pins !== null && pins !== undefined && Number.isFinite(pins.count) ? `${pins.count} 条` : '无'}`,
    `- 后台任务：${jobs.length === 0 ? '无' : `${jobs.length} 个可能仍在运行`}`,
  ];
  if (site !== null && typeof site === 'object' && typeof site.cwd === 'string') {
    progressLines.push(`- 工作目录：${site.cwd}`);
  }

  const fileList = Array.isArray(changedFiles) ? changedFiles.filter((file) => typeof file === 'string' && file.length > 0) : [];
  const fileLines =
    fileList.length === 0
      ? ['- 本会话日志里没有记录到写文件工具调用（以「已完成」「下一步」里的说明为准）']
      : fileList.map((file) => `- ${shortPath(file, cwd)}`);

  return {
    当前进度: progressLines.join('\n'),
    改过的文件: fileLines.join('\n'),
  };
}
