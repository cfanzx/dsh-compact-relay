/**
 * 摘要调用 —— 唯一调 ctx.llm.stream() 的地方。
 *
 * M2 起两个关键改进（来源见 REFERENCES.md）：
 *  1. **cache 对齐**：回放「surface 从头到压缩范围末尾」的完整前缀，再追加
 *     range notice + 指令；指令位置之前的 token 与上一次请求一致，能命中
 *     provider 的 KV cache。另复用上次请求的 reasoningEffort/temperature/stop。
 *  2. **结构校验 + 重试**：摘要必须包含 6 个固定小节；不合格就带 recovery
 *     提示重试一次，仍不合格则拒绝提交（M1 实测模型会编造/漏段）。
 */
import { actionError } from '../core/errors.js';
import { rangeNotice, recoveryHint } from '../core/prompts.js';
import { REQUIRED_SECTIONS, describeProblems, validateSummary } from '../core/validate-summary.js';
import { buildPrefix } from './prefix.js';
import { cacheAlignedControls, callModelAttempt, modelAttemptResult, prepareModelCall } from './model-task.js';

/** 最多尝试次数（首次 + 1 次带 recovery 提示的重试）。 */
const MAX_ATTEMPTS = 2;

/** 目标区段在回放里占几条消息（可能少于 surface 节点数）。 */
function regionMessageCount(session, shadowedSeqs) {
  let count = 0;
  for (const seq of shadowedSeqs) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    if (session.deriveEventMessage(event)) count += 1;
  }
  return count;
}

/**
 * 把一段 surface 历史压成结构化 checkpoint。
 * @param {object} input
 * @param {object} input.ctx
 * @param {object} input.engine
 * @param {object} input.agent
 * @param {number[]} input.shadowedSeqs 要被替换掉的 surface seq（升序）
 * @param {number} input.endSeq 压缩范围最后一条的 seq（回放前缀到此为止）
 * @param {string} input.instruction
 * @param {number} input.maxTokens
 * @param {number} [input.inputTokens] 调用前预算预检用的输入 token 估算（可选）
 * @param {number} [input.timeoutMs] 单次模型调用超时（默认 180s）
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{summary: {type:string,text:string}[], provider:string, model:string, maxTokens:number, attempts:number, usage?:object}>}
 */
export async function summarize({
  ctx,
  engine,
  agent,
  shadowedSeqs,
  endSeq,
  instruction,
  maxTokens,
  inputTokens,
  timeoutMs,
  signal,
  requiredSections = REQUIRED_SECTIONS,
}) {
  const session = agent?.session;
  const { target, reasoningEffort } = await prepareModelCall({
    ctx,
    session,
    agent,
    inputTokens,
    maxTokens,
    label: '压缩摘要',
    code: 'summary',
    noSessionMessage: '会话不存在，无法生成摘要',
    noTargetMessage: '没有可用的 provider/model，无法发起压缩',
  });

  const regionCount = regionMessageCount(session, shadowedSeqs);
  if (regionCount === 0) throw actionError('summary', '没有可摘要的消息');

  const prefix = buildPrefix(session, endSeq);
  if (prefix.length === 0) throw actionError('summary', '回放前缀为空');

  const header = session.requestHeader?.();
  const controls = cacheAlignedControls(session, target);
  const baseInstruction = `${rangeNotice(regionCount)}\n\n${instruction}`;

  let lastProblems = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted?.();
    const instructionText =
      attempt === 1 ? baseInstruction : `${baseInstruction}\n\n${recoveryHint(describeProblems(lastProblems))}`;
    const options = {
      provider: target.provider,
      model: target.model,
      ...controls,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      messages: [...prefix, { role: 'user', content: [{ type: 'text', text: instructionText }] }],
      toolHistory: typeof session.toolHistory === 'function' ? session.toolHistory() : undefined,
      ...(Array.isArray(header?.tools) ? { tools: [...header.tools] } : {}),
      maxTokens,
      sessionId: session.id,
      purpose: 'compaction',
    };

    const { assembler, problem } = await callModelAttempt({
      ctx,
      engine,
      options,
      signal,
      timeoutMs,
      label: '压缩摘要',
      code: 'summary',
    });
    if (problem !== null) {
      // 输出被截断 → 还有尝试机会时，带着「写短一点」的提示重试一次（真机 2026-10-19 踩过）。
      if (assembler.finish?.kind === 'max-tokens' && attempt < MAX_ATTEMPTS) {
        lastProblems = ['输出达到 maxTokens 上限被截断（需要更短、更紧凑的摘要）'];
        continue;
      }
      // BUG-004：模型偶尔把摘要请求当成工具任务（返回 tool-call）。历史没动、重试安全，
      // 带上「只输出正文、不要调用工具」的提示再试一次；仍失败才报错（文案会带原因）。
      if (assembler.finish?.kind === 'tool-calls' && attempt < MAX_ATTEMPTS) {
        lastProblems = ['上次响应尝试调用工具；这次只输出摘要正文（六段中文），不要调用任何工具'];
        continue;
      }
      throw problem;
    }

    const validation = validateSummary(assembler.blocks(), { requiredSections });
    if (validation.ok) {
      return {
        summary: validation.summary,
        ...modelAttemptResult({ assembler, options, maxTokens, attempt }),
      };
    }
    lastProblems = validation.problems;
  }

  throw actionError('summary', `摘要结构连续 ${MAX_ATTEMPTS} 次不合格：${lastProblems.join('；')}`);
}
