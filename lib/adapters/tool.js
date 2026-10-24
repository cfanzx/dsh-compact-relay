/**
 * 工具入口（0.3.1，0.3.4 改名 mark_compress_point）—— 让模型记录一个「压缩节点」。
 *
 * 用户手动标记已删除（作者 2026-10-20 拍板）；现在只有模型这条自动判断路径，
 * 环上把判断位置画成「断点1」（正常区/压缩区分界）。
 *
 * BUG-010 复盘：旧描述 `mark_stage` 写「系统会告诉你容量」但系统从没说过，
 * 模型无法判断条件 → 427 个真实会话 0 次调用。0.3.4 起由宿主每轮注入可压缩区间
 * 提示（lib/adapters/prompt.js），工具描述只描述「它自己会做什么」：
 * 服务端工具会返回当前容量并复核区间，太低/到线都拒绝且不改历史。
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
      name: 'mark_compress_point',
      description:
        '记录一个「压缩节点」：在指示灯环上标出「这里适合把前面的旧历史压成摘要」。' +
        '在你刚完成一个明确的任务/阶段、并且认为之后可以安全地压缩旧历史继续往下做时调用。' +
        '不确定当前是否合适时也可以调用：工具会返回当前上下文容量并做判断，' +
        '容量太低（压缩不划算）或已经到压缩线（直接建议用户压缩即可）会被拒绝，拒绝不会改动任何历史。' +
        '不需要每个小步骤都调用。每次判断只记一条，压缩或交接后旧记录自动失效。',
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
