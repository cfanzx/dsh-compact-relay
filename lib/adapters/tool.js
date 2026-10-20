/**
 * 工具入口（0.3.1）—— 让模型判断「这里适合压缩」并记录一个断点。
 *
 * 用户手动标记已删除（作者 2026-10-20 拍板）；现在只有模型这条自动判断路径，
 * 环上把判断位置画成「断点1」（正常区/压缩区分界）。
 */
import { markCompressHint } from '../actions/compress-hint.js';
import engine from '../dsh/engine.js';

/**
 * @param {object} ctx 根上下文（需要 tools 服务）
 * @param {object} deps
 */
export function registerTool(ctx, deps) {
  ctx.tools.register(
    engine.defineTool({
      name: 'mark_stage',
      description:
        '判断「这里适合压缩」并在指示灯上留一个断点（正常区/压缩区的分界）。' +
        '只在同时满足以下条件时调用：① 当前上下文容量已经超过「最小压缩线」（低于它压缩不划算，系统会告诉你）；' +
        '② 还没到「压缩线」（到了系统自己会标记）；③ 当前工作刚好到了一个自然的小节点——一个明确的任务/阶段刚完成，' +
        '适合把之前的旧历史压成摘要、继续往下做。' +
        '不要每个小步骤都调；不要为了凑数调用。每次判断只记一条，压缩或交接后旧记录自动失效。' +
        '调用后告诉用户「我在当前进度处做了一个「这里适合压缩」的判断」。',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(_args, exec) {
        const result = await markCompressHint(deps, { agent: exec?.agent });
        return result.message;
      },
    }),
  );
}
