/**
 * 交接单生成 —— 让模型看完整 surface 历史，写出九段交接单（A1）。
 *
 * 与 M2 摘要的区别（REQUIREMENTS §三，交接部分）：
 *  - 交接内容由模型写，**不走压缩摘要器**：用独立的九段中文任务书；
 *  - 九段里模型只写七段，「当前进度」「改过的文件」由程序收集后拼进来；
 *  - 输入是「当前 surface 的全部消息」，不截取范围；
 *  - 结构校验失败带 recovery 提示重试一次，仍不合格就拒绝（不建新会话）。
 *
 * 只消费公共 API：ctx.llm.stream + engine.BlockAssembler。
 */
import { actionError } from '../core/errors.js';
import { HANDOFF_INSTRUCTION, handoffRecoveryHint } from '../core/prompts.js';
import { HANDOFF_MODEL_SECTIONS, composeHandoffText } from '../core/handoff-spec.js';
import { describeHandoffProblems, validateHandoff } from '../core/validate-handoff.js';
import { surfaceMessages } from './prefix.js';
import { cacheAlignedControls, callModelAttempt, modelAttemptResult, prepareModelCall } from './model-task.js';

/** 首次 + 1 次带 recovery 提示的重试。 */
const MAX_ATTEMPTS = 2;

/**
 * 生成交接文档正文（九段 markdown，不含元信息头）。
 * @param {object} input
 * @param {object} input.ctx
 * @param {object} input.engine
 * @param {object} input.agent
 * @param {number} input.maxTokens
 * @param {number} [input.inputTokens] 调用前预算预检用的输入 token 估算（整段 surface）
 * @param {number} [input.timeoutMs] 单次模型调用超时（默认 180s）
 * @param {AbortSignal} [input.signal]
 * @param {Record<string,string>} [input.programSections] 程序收集段（当前进度/改过的文件）
 * @returns {Promise<{text: string, sections: Record<string,string>, provider: string, model: string, maxTokens: number, attempts: number, usage?: object}>}
 */
export async function generateHandoffDoc({ ctx, engine, agent, maxTokens, inputTokens, timeoutMs, signal, programSections = {} }) {
  const session = agent?.session;
  const { target, reasoningEffort } = await prepareModelCall({
    ctx,
    session,
    agent,
    inputTokens,
    maxTokens,
    label: '交接单生成',
    code: 'handoff',
    noSessionMessage: '会话不存在，无法生成交接单',
    noTargetMessage: '没有可用的 provider/model，交接单无法生成',
  });

  const prefix = surfaceMessages(session);
  if (prefix.length === 0) throw actionError('handoff', '这个会话还没有可交接的内容（没有模型可见的消息）');

  // reasoningEffort 由 prepareModelCall 决定：优先沿用主请求档位（cache 对齐）；拿不到 header 才回退「支持 off 就 off」。
  const controls = cacheAlignedControls(session, target);
  let lastProblems = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted?.();
    const instruction =
      attempt === 1
        ? HANDOFF_INSTRUCTION
        : `${HANDOFF_INSTRUCTION}\n\n${handoffRecoveryHint(describeHandoffProblems(lastProblems))}`;

    const options = {
      provider: target.provider,
      model: target.model,
      ...controls,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      messages: [...prefix, { role: 'user', content: [{ type: 'text', text: instruction }] }],
      maxTokens,
      sessionId: session.id,
      // 不传 purpose：DSH GenerateOptions 只认 'compaction' | 'session-title'，
      // 交接是第三方调用，标 'handoff' 属类型层非法（运行时虽然不读，也不该留）。
    };

    const { assembler, problem } = await callModelAttempt({
      ctx,
      engine,
      options,
      signal,
      timeoutMs,
      label: '交接单生成',
      code: 'handoff',
    });
    if (problem !== null) {
      if (assembler.finish?.kind === 'max-tokens' && attempt < MAX_ATTEMPTS) {
        lastProblems = ['输出达到 maxTokens 上限被截断（需要更短、更紧凑的交接单）'];
        continue;
      }
      throw problem;
    }

    const text = assembler
      .blocks()
      .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();

    // 模型只负责 7 个 model 段；程序段（当前进度/改过的文件）不信任模型输出。
    const validation = validateHandoff(text, { titles: HANDOFF_MODEL_SECTIONS });
    if (validation.ok) {
      const mergedSections = {
        ...Object.fromEntries(HANDOFF_MODEL_SECTIONS.map((title) => [title, validation.sections[title]])),
        当前进度: programSections['当前进度'],
        改过的文件: programSections['改过的文件'],
      };
      const assembled = composeHandoffText(mergedSections);
      const full = validateHandoff(assembled);
      if (!full.ok) {
        lastProblems = full.problems;
        continue;
      }
      return {
        text: full.text,
        sections: full.sections,
        ...modelAttemptResult({ assembler, options, maxTokens, attempt }),
      };
    }
    lastProblems = validation.problems;
  }

  throw actionError('handoff', `交接单连续 ${MAX_ATTEMPTS} 次结构不合格：${lastProblems.join('；')}`);
}
