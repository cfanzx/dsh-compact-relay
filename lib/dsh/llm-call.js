/**
 * LLM 调用壳（架构 A2）—— 摘要与交接单共用的唯一模型调用入口。
 *
 * 收拢三件事：
 *  1. **预算预检**：调模型前按窗口检查「输入 + 输出 + 余量」，超了直接报 budget，
 *     不白等一次超窗请求（交接尤其容易踩：整段 surface 直接喂）。
 *  2. **超时**：默认 180s，可配置；超时抛 timeout，锁和 inflight 都能释放。
 *  3. **重试分类**：只对 network / 5xx / rate-limit 重试 1 次（带 jitter）；
 *     结构不合格的重试仍留在各自校验器，避免「重试把两层搅在一起」。
 *
 * 只消费公共 API：ctx.llm.stream + engine.BlockAssembler。
 */
import { actionError } from '../core/errors.js';

/** 默认模型调用超时（180 秒）。 */
export const DEFAULT_LLM_TIMEOUT_MS = 180_000;

const RETRYABLE_PATTERN =
  /(?:rate.?limit|too many requests|econnreset|etimedout|eai_again|socket hang up|fetch failed|network error|temporarily unavailable)/i;

/** provider/model → resolveModelInfo 的进程内缓存（Promise，失败即删）。 */
const modelInfoCache = new Map();

/**
 * 读配置里的模型调用超时；没配/非法用默认值。
 * @param {{cfg?:object}} deps
 * @returns {number}
 */
export function llmTimeoutMs(deps) {
  const configured = deps?.cfg?.timeouts?.llmMs;
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LLM_TIMEOUT_MS;
}

/** 测试用：清空模型信息缓存（切换 mock 模型能力时用）。 */
export function clearModelInfoCache() {
  modelInfoCache.clear();
}

async function modelInfoOf(ctx, target) {
  if (ctx?.llm === undefined || typeof ctx.llm.resolveModelInfo !== 'function') return null;
  if (target === null || target === undefined) return null;
  const key = `${target.provider}/${target.model}`;
  let pending = modelInfoCache.get(key);
  if (pending === undefined) {
    pending = Promise.resolve()
      .then(() => ctx.llm.resolveModelInfo(target.provider, target.model))
      .catch(() => null);
    modelInfoCache.set(key, pending);
  }
  const info = await pending;
  if (info === null) modelInfoCache.delete(key);
  return info;
}

/**
 * 当前模型该不该传 reasoningEffort。
 *
 * 2026-10-20 修 P2-5：旧实现两处硬编码 `reasoningEffort:'off'`；非推理模型、
 * 或不支持 off 的模型上 /bc、/handoff 100% 失败。现在只在模型目录明确列出
 * `off` 这个档位时才传（DeepSeek 仍走 off，保持便宜且不被思考 token 吃光上限）；
 * 拿不到模型信息/不支持 off 时交给 adapter 默认值。
 * @param {object} ctx
 * @param {{provider:string, model:string}} target
 * @returns {Promise<'off'|undefined>}
 */
export async function reasoningEffortFor(ctx, target) {
  try {
    const info = await modelInfoOf(ctx, target);
    const efforts = info?.reasoning?.efforts;
    if (!Array.isArray(efforts) || efforts.length === 0) return undefined;
    const ids = efforts
      .map((effort) => (typeof effort === 'string' ? effort : effort?.id))
      .filter((id) => typeof id === 'string');
    return ids.includes('off') ? 'off' : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 调用前预算预检。
 * @param {object} input
 * @param {object} input.ctx
 * @param {{provider:string, model:string}} input.target
 * @param {number|null|undefined} input.inputTokens 输入 token 估算（拿不到就跳过）
 * @param {number} input.maxTokens 输出上限
 * @param {string} [input.label]
 * @param {number} [input.margin] 窗口余量（默认 5%）
 * @returns {Promise<void>}
 */
export async function assertBudget({ ctx, target, inputTokens, maxTokens, label = '模型调用', margin = 0.05 }) {
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return;
  const info = await modelInfoOf(ctx, target);
  const window = info?.context?.contextWindow;
  if (!Number.isFinite(window) || window <= 0) return;
  const needed = inputTokens + (Number.isFinite(maxTokens) ? maxTokens : 0);
  const limit = Math.floor(window * (1 - margin));
  if (needed > limit) {
    throw actionError(
      'budget',
      `${label}输入约 ${inputTokens} token + 输出 ${maxTokens}，超过模型窗口 ${window} 的可用上限 ${limit}；` +
        '请先压缩旧会话或缩小范围',
    );
  }
}

function isAbortError(error) {
  return error !== null && typeof error === 'object' && (error.name === 'AbortError' || error.code === 'cancelled');
}

function isRetryable(error) {
  if (error === null || typeof error !== 'object') return false;
  if (error.code === 'cancelled' || error.code === 'timeout' || error.code === 'budget') return false;
  const status = error.status ?? error.statusCode ?? error.cause?.status;
  if (typeof status === 'number' && (status === 408 || status === 429 || status >= 500)) return true;
  return RETRYABLE_PATTERN.test(String(error.message ?? error));
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 跑一次流式模型调用，返回收集好的 BlockAssembler。
 * @param {object} input
 * @param {object} input.ctx
 * @param {object} input.engine
 * @param {object} input.options 传给 ctx.llm.stream 的选项（不含 signal）
 * @param {AbortSignal} [input.signal] 用户取消信号
 * @param {number} [input.timeoutMs]
 * @param {string} [input.label]
 * @param {boolean} [input.retry] 是否允许网络/5xx 重试一次（默认 true）
 * @returns {Promise<object>} engine.BlockAssembler
 */
export async function callStream({
  ctx,
  engine,
  options,
  signal,
  timeoutMs = DEFAULT_LLM_TIMEOUT_MS,
  label = '模型调用',
  retry = true,
}) {
  const attempt = async () => {
    if (signal?.aborted === true) throw actionError('cancelled', `已取消${label}`);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, timeoutMs));
    const relay = () => controller.abort();
    if (signal !== undefined && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', relay, { once: true });
    }
    try {
      const assembler = new engine.BlockAssembler();
      for await (const chunk of ctx.llm.stream({ ...options, signal: controller.signal })) assembler.push(chunk);
      return assembler;
    } catch (error) {
      if (signal?.aborted === true) throw actionError('cancelled', `已取消${label}`, error);
      if (timedOut) {
        throw actionError(
          'timeout',
          `${label}超时（${Math.round(timeoutMs / 1000)} 秒），已中止；可稍后重试`,
          error,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (signal !== undefined && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', relay);
      }
    }
  };

  try {
    return await attempt();
  } catch (error) {
    if (retry && !isAbortError(error) && isRetryable(error) && signal?.aborted !== true) {
      await sleep(150 + Math.floor(Math.random() * 250));
      return attempt();
    }
    throw error;
  }
}
