/**
 * 推荐收藏 · 模型打分调用（0.5.3 P1-6）。
 *
 * 位置：`dsh/favorite-watch.js` 在助手消息落地后异步调这里，只判**最后一条**回复。
 * 口径（2026-10-28 验证脚本 v3 定稿）：flash 档、关思考、temperature 0、只回 JSON 分数。
 *
 * 红线：这里只返回分数，**绝不写收藏**；失败一律返回 null（调用方按「不亮」处理，
 * 不抛错、不重试——推荐只是锦上添花，不能因为模型抖动影响主流程）。
 *
 * 与摘要/交接的区别：那两个任务失败要让用户知道（有明确错误码）；推荐失败是静默降级，
 * 所以不套 model-task 的重试/预算循环，只借 callStream 的超时与取消。
 */
import { buildFavoriteScoreSystemPrompt, buildFavoriteScoreUserText, parseFavoriteScore } from '../core/favorite-score.js';
import { callStream } from './llm-call.js';
import { routeOf } from './route.js';

/** 打分输出极短，给 160 token 足够（提示词要求只回一个 JSON）。 */
export const FAVORITE_SCORE_MAX_TOKENS = 160;

/** 单条打分超时；超过就不亮（比主对话慢太多就失去「即时提示」的意义）。 */
export const FAVORITE_SCORE_TIMEOUT_MS = 8_000;

/**
 * 从 BlockAssembler 里取纯文本（只拼 text block；忽略 reason/tool）。
 * @param {object} assembler
 * @returns {string}
 */
function textOfAssembler(assembler) {
  if (assembler === null || typeof assembler !== 'object') return '';
  const blocks = typeof assembler.blocks === 'function' ? assembler.blocks() : [];
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * 给一条助手回复打分（0-100）。任何失败返回 null（不亮），不抛错。
 *
 * @param {{ctx:object, engine:object, log?:object}} deps
 * @param {{agent?:object, text?:string}} input
 * @returns {Promise<{score:number, reason:string, provider:string, model:string}|null>}
 */
export async function scoreFavoriteMessage(deps, { agent, text } = {}) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (body.length === 0) return null;
  const session = agent !== null && typeof agent === 'object' ? agent.session : undefined;
  if (session === undefined || session === null) return null;
  const target = routeOf(deps.ctx, session, agent);
  if (target === null) return null;

  const options = {
    provider: target.provider,
    model: target.model,
    reasoningEffort: 'off',
    temperature: 0,
    maxTokens: FAVORITE_SCORE_MAX_TOKENS,
    messages: [
      { role: 'system', content: [{ type: 'text', text: buildFavoriteScoreSystemPrompt() }] },
      { role: 'user', content: [{ type: 'text', text: buildFavoriteScoreUserText(body) }] },
    ],
  };

  let assembler;
  try {
    assembler = await callStream({
      ctx: deps.ctx,
      engine: deps.engine,
      options,
      timeoutMs: FAVORITE_SCORE_TIMEOUT_MS,
      label: '推荐收藏打分',
      retry: false,
    });
  } catch (error) {
    deps.log?.warn?.(`推荐收藏打分失败（忽略，不亮）：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }

  const parsed = parseFavoriteScore(textOfAssembler(assembler));
  if (parsed === null) {
    deps.log?.warn?.('推荐收藏打分：模型输出解析失败（忽略，不亮）');
    return null;
  }
  return { score: parsed.score, reason: parsed.reason, provider: target.provider, model: target.model };
}

export default scoreFavoriteMessage;
