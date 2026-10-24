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
 *
 * 0.4 P0-1（方案 §3.3）：Win 173 会话 cue 注入 18 次、工具 0 调用 → 描述 v2：
 *  - 明确「用户和模型都可以调用」（不只是模型的自发动作）；
 *  - 「被拒不需要致歉」：拒绝零副作用、不改历史、不需要重试或道歉（降低调用心理成本）；
 *  - 给出典型调用时机；把「不需要每个小步骤都调用」弱化后挪到句尾，不再抢在条件前面。
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
        '用户和模型都可以调用；不确定时调用是安全的：工具会自己判断容量，太早或已到压缩线会拒绝，' +
        '被拒不需要致歉、不会改动历史、也不影响会话，不需要重试。' +
        '典型调用时机：阶段完成（功能已实现并验证 / 文档已交付 / 问题已定位并修复）、准备交接前、长任务中途确认可回退点。' +
        '调用后工具会返回当前容量与判断结果；每次判断只记一条，压缩或交接后旧记录自动失效。小步骤不用调用。',
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
