/**
 * 模型任务公共装配/收尾 —— 摘要器（dsh/summarizer.js）与交接单生成
 * （dsh/handoff-writer.js）共用的一小段「模型调用前后」逻辑。
 *
 * 两个任务不是同一种产物（一个压成六段摘要、一个写九段交接单，校验/重试规则
 * 也不同），所以**不合并重试循环**；但下面四件事完全一样、以前各写一遍：
 *   1. 前置：会话存在性 → 解析 provider/model 路由 → 窗口预算预检 → 推理档位；
 *   2. cache 对齐参数：复用上次请求的 temperature/stop，但**绝不继承 reasoningEffort**
 *      （2026-10-19 真机坑：会话最后请求是 max 思考，摘要沿用 max → maxTokens 被思考吃光）；
 *   3. 单次流式调用 + finishProblem 归一（超限/工具调用/中断）；
 *   4. 成功结果的公共元信息（provider/model/maxTokens/attempts/usage）。
 *
 * 只消费 dsh 层模块，不 import @deepseek-ai/*。
 */
import { actionError } from '../core/errors.js';
import { assertBudget, callStream, reasoningEffortFor } from './llm-call.js';
import { cacheControls, routeOf } from './route.js';
import { finishProblem } from './stream.js';

/**
 * 模型调用前置：会话 → 路由 → 预算 → 推理档位。
 *
 * 错误码/文案由调用方给：摘要器报 'summary'、交接单报 'handoff'，保持各自入口的
 * 用户可见文案逐字不变（这里只是把顺序收在一处）。
 *
 * @param {object} input
 * @param {object} input.ctx
 * @param {object|undefined} input.session
 * @param {object} input.agent
 * @param {number} [input.inputTokens] 输入 token 估算（拿不到就跳过预算预检）
 * @param {number} input.maxTokens
 * @param {string} input.label 给预算报错用的任务名
 * @param {string} input.code 动作错误码
 * @param {string} input.noSessionMessage 会话不存在时的用户可见错误文案
 * @param {string} input.noTargetMessage 拿不到 provider/model 时的用户可见错误文案
 * @returns {Promise<{target:{provider:string, model:string}, reasoningEffort:'off'|undefined}>}
 */
export async function prepareModelCall({
  ctx,
  session,
  agent,
  inputTokens,
  maxTokens,
  label,
  code,
  noSessionMessage,
  noTargetMessage,
}) {
  if (session === undefined) throw actionError(code, noSessionMessage);

  const target = routeOf(ctx, session, agent);
  if (target === null) throw actionError(code, noTargetMessage);

  // 架构 A2：调模型前先做窗口预算预检；超窗直接报 budget，不白等一次失败请求。
  await assertBudget({ ctx, target, inputTokens, maxTokens, label });
  // P2-5：只有模型目录明确支持 off 才传；非推理/不支持 off 的模型交给 adapter 默认。
  const reasoningEffort = await reasoningEffortFor(ctx, target);

  return { target, reasoningEffort };
}

/**
 * cache 对齐参数：复用上次请求的 temperature/stop，**不要继承 reasoningEffort**。
 *
 * 2026-10-19 真机踩的坑：会话最后请求是 reasoningEffort=max，摘要调用沿用 max，
 * 思考 token 把 maxTokens(4096) 吃光 → finish=max-tokens → 「摘要在输出上限处被截断」。
 * 摘要/交接单本身都不需要长思考，是否固定 off 由模型能力决定（见 prepareModelCall）。
 *
 * @param {object} session
 * @param {{provider:string, model:string}} target
 * @returns {object}
 */
export function cacheAlignedControls(session, target) {
  const { reasoningEffort: _ignored, ...controls } = cacheControls(session, target);
  return controls;
}

/**
 * 跑一次流式调用并把终止原因归一成可读错误（不抛；调用方决定重试/抛出）。
 * @param {object} input
 * @param {object} input.ctx
 * @param {object} input.engine
 * @param {object} input.options 传给 ctx.llm.stream 的选项（不含 signal）
 * @param {AbortSignal} [input.signal]
 * @param {number} [input.timeoutMs]
 * @param {string} input.label
 * @param {string} input.code
 * @returns {Promise<{assembler:object, problem:Error|null}>}
 */
export async function callModelAttempt({ ctx, engine, options, signal, timeoutMs, label, code }) {
  const assembler = await callStream({ ctx, engine, options, signal, timeoutMs, label });
  return { assembler, problem: finishProblem(assembler, { code, label }) };
}

/**
 * 成功结果的公共元信息（两个任务返回结构里逐字相同的那一段）。
 * @param {object} input
 * @param {object} input.assembler
 * @param {{provider:string, model:string}} input.options
 * @param {number} input.maxTokens
 * @param {number} input.attempt
 * @returns {{provider:string, model:string, maxTokens:number, attempts:number, usage?:object}}
 */
export function modelAttemptResult({ assembler, options, maxTokens, attempt }) {
  return {
    provider: options.provider,
    model: options.model,
    maxTokens,
    attempts: attempt,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  };
}
