/**
 * 错误 → 用户可读文案的唯一映射。
 *
 * 命令、HTTP、工具三个入口都用这里的文案，不各写一套。
 */

/** 已知失败类别 → 一句话。 */
const MESSAGES = Object.freeze({
  busy: '当前会话正在压缩、交接或正在回复中，请稍后再试。',
  cancelled: '操作已取消。',
  changed: '要压缩的会话内容在压缩过程中变了，本次未提交；请重新预览后再确认。',
  summary: '未能生成有效摘要，本次未做改动。',
  commit: '保存时出错，会话记录可能未完全更新——重试前请先检查当前会话内容。',
  persistence: '压缩完成但会话未保存成功，请注意备份。',
  range: '暂无可安全压缩的会话内容（会话太短，或有工具任务尚未执行完）。',
  unsupported: '当前 DSH 不支持这个操作所需的接口。',
  nosession: '当前没有活动会话。',
  pairing: '压缩范围会切断配对的工具调用，本次未执行（换一段或稍后重试）。',
  shrink: '摘要比被替换的内容还大，本次未提交；先继续聊几轮，或把「保留近期原文」调小一点，再来压缩。',
  stage: '没法标记进度：当前没有打开的会话。',
});

/**
 * 给一次动作失败打上稳定的 code。
 * @param {string} code
 * @param {string} message
 * @param {unknown} [cause]
 * @returns {Error & {code: string}}
 */
export function actionError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

/**
 * 把任意错误映射成入口可以直接用的文案。
 * @param {unknown} error
 * @returns {string}
 */
export function errorText(error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined;
  if (typeof code === 'string' && MESSAGES[code] !== undefined) {
    const base = MESSAGES[code];
    // P3-01：摘要失败的「具体原因」（结构不合格几次、被截断等）就写在 actionError 的
    // message 里，以前被固定文案吞掉、用户只看到「详见日志」却没有日志可看。
    // 只对 summary 附带原因（其它 code 的 message 是内部措辞）；截断防止把整段
    // 模型输出/校验清单倒给用户，原因本身也是中文可读的。
    if (code === 'summary' && error instanceof Error && typeof error.message === 'string' && error.message.length > 0) {
      const detail = error.message.length > 140 ? `${error.message.slice(0, 139)}…` : error.message;
      return `${base}原因：${detail}`;
    }
    return base;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `失败：${message}`;
}
