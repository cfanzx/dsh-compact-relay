/**
 * 交接新会话（/handoff，代码里沿用 handoff/HO 命名）—— M3 正式版
 * （照 REFERENCES §1.6 WeiYe6 路线，按 DSH 0.2 API 落地）。
 *
 * 流程（REQUIREMENTS §三，交接部分）：
 *   1. 先压缩旧会话一次（复用 M2 的 betterCompact 本体，不二压政策不变）；
 *   2. 让模型看着压缩后的完整 surface 写九段交接单（不是压缩摘要；程序段由代码收集）；
 *   3. 写盘到 cfg.handoffDir（默认 ~/.dsh/handoffs）/handoff-<时间>.md；
 *   4. 在同一工作区建新会话（同 preset、同模型），把交接单注入并起第一轮；
 *   5. 返回新会话 id，客户端据此自动切过去。
 *
 * 失败语义：
 *   - 压缩失败但可继续（结构/范围问题）→ 降级为「不压缩，直接写文档」并记日志；
 *   - 压缩 busy / 用户取消 → 直接中止（会话可能正在跑）；
 *   - 文档生成不合格 → 不建新会话（无副作用，只多一次模型调用）；
 *   - 新会话建好但注入失败 → 报错里带 childId，用户可从侧栏手动打开。
 */
import fs from 'node:fs';
import path from 'node:path';
import { actionError } from '../core/errors.js';
import { handoffFileName, renderHandoffDoc } from '../core/handoff-doc.js';
import { betterCompactLocked } from './better-compact.js';
import { compressHint, countSummaries, livePinnedSeqs, surfaceSeqs } from '../dsh/session-view.js';
import { measurePressure } from '../dsh/pressure.js';
import { buildSiteSnapshot } from '../dsh/site-info.js';
import { generateHandoffDoc } from '../dsh/handoff-writer.js';
import { buildHandoffProgramSections } from '../core/handoff-facts.js';
import { checkHandoffReadiness } from '../core/readiness.js';
import { changedFilesOf } from '../dsh/session-files.js';
import { surfaceMessages } from '../dsh/prefix.js';
import { handoffTitlePlanOf, createHandoffSession, sourceTitleOf } from '../dsh/sessions.js';
import { writeRelayRecord } from '../dsh/relay.js';
import { withLock } from './lock.js';
import { beginInflight, cancelErrorOf, combinedSignal, finishInflight } from './support.js';

/**
 * 压缩阶段：能压就压，压不了就带着原因往下走。
 * @returns {Promise<{outcome: object|null, warning: string|null}>}
 */
async function compactFirst(deps, { agent, signal, commandId, log }) {
  try {
    return { outcome: await betterCompactLocked(deps, { agent, signal, commandId }), warning: null };
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined;
    // 只有「事务开始前/未提交」的失败能降级继续（结构、范围、摘要、内容变化）。
    // commit/persistence 说明历史可能已被改写但没落盘，再写交接单会给出与真实历史不符的文档，
    // 所以直接中止交接（2026-10-19 debug 实测：旧实现会报「压缩失败已跳过」却已替换历史）。
    if (code === 'busy' || code === 'cancelled' || code === 'commit' || code === 'persistence') throw error;
    const warning = error instanceof Error ? error.message : String(error);
    log?.warn?.(`compact-relay: 交接前压缩失败，按当前历史继续：${warning}`);
    return { outcome: null, warning };
  }
}

/**
 * 收集交接单需要的全部会话事实（A1）：压力/现场快照/摘要数/锁定/改过的文件/程序段。
 * @returns {Promise<{session:object, measured:object, now:Date, site:object, summaries:number, pinnedSeqs:number[], changedFiles:string[], programSections:Record<string,string>}>}
 */
async function collectHandoffFacts(deps, agent) {
  const session = agent.session;
  const measured = await measurePressure(deps.ctx, agent, { windowFallback: deps.cfg.contextWindowFallback }).catch(
    () => ({ tokens: null }),
  );
  const now = new Date();
  const site = buildSiteSnapshot({ session, now });
  const summaries = countSummaries(session);
  const pinnedSeqs = livePinnedSeqs(session);
  const changedFiles = changedFilesOf(session);
  const programSections = buildHandoffProgramSections({
    compressHint: compressHint(session),
    summaries,
    pressure: measured.tokens,
    pins: { count: pinnedSeqs.length, seqs: pinnedSeqs },
    changedFiles,
    site,
  });
  return { session, measured, now, site, summaries, pinnedSeqs, changedFiles, programSections };
}

/**
 * @param {{ctx:object, cfg:object, lock:object, engine:object, log?:object}} deps
 * @param {{agent:object, signal?:AbortSignal, commandId?:string}} input
 */
export async function handoff(deps, { agent, signal, commandId }) {
  if (agent === undefined || agent === null) throw actionError('handoff', '当前没有打开的会话，无法交接');
  const session = agent.session;
  if (session === undefined) throw actionError('handoff', '没有活动会话，无法交接');

  return withLock(deps.lock, agent.id, async () => {
    // P1-4：交接登记进 inflight，client 的取消按钮才能真正 abort 模型调用。
    const controller = beginInflight(deps, agent.id, 'handoff');
    const combined = combinedSignal(controller?.signal, signal);

    try {
      // P2-2：先做可失败的 preflight（目录可写），再动历史（压缩）。
      try {
        fs.mkdirSync(deps.cfg.handoffDir, { recursive: true });
        fs.accessSync(deps.cfg.handoffDir, fs.constants.W_OK);
      } catch (error) {
        throw actionError(
          'handoff',
          `交接单目录不可写（${deps.cfg.handoffDir}）：${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }

      // 1) 先压缩旧会话一次（best effort）。
      const { outcome: compactOutcome, warning: compactWarning } = await compactFirst(deps, {
        agent,
        signal: combined,
        commandId,
        log: deps.log,
      });
      combined?.throwIfAborted?.();

      // 2) 收集事实（A1 程序段）+ 预算/文档头用的压力。
      const facts = await collectHandoffFacts(deps, agent);

      // 3) 让模型写七段（压缩后的完整 surface 为输入），程序段由 writer 拼成九段。
      const generated = await generateHandoffDoc({
        ctx: deps.ctx,
        engine: deps.engine,
        agent,
        maxTokens: deps.cfg.handoff.maxTokens,
        inputTokens: facts.measured.tokens,
        timeoutMs: deps.cfg.timeouts?.llmMs,
        signal: combined,
        programSections: facts.programSections,
      });
      combined?.throwIfAborted?.();

      // 3.5) 就绪检查：九段缺段/占位阻断；路径核对只警告，不阻断。
      const readiness = checkHandoffReadiness({
        sections: generated.sections,
        surfaceText: JSON.stringify(surfaceMessages(facts.session)),
        changedFiles: facts.changedFiles,
        messageCount: surfaceSeqs(facts.session).length,
      });
      if (!readiness.ok) {
        throw actionError('handoff', `交接单就绪检查未通过：缺少或为空的小节：${readiness.missing.join('、')}`);
      }
      for (const warning of readiness.warnings) deps.log?.warn?.(`compact-relay: 交接单就绪警告：${warning}`);

      // 4) 写盘：文档头带元信息，九段正文 = 模型 7 段 + 程序 2 段。
      const file = path.join(deps.cfg.handoffDir, handoffFileName(facts.now));
      const doc = renderHandoffDoc({
        generated: generated.text,
        sourceSessionId: facts.session.id,
        sourceTitle: sourceTitleOf(deps.ctx, facts.session),
        now: facts.now,
        pressure: facts.measured.tokens,
        summaries: facts.summaries,
        file,
        // M6：把「宿主刚重启过 / 工作区分支 / 有没有后台任务在跑」写进文档头，
        // 免得接手者按一份出厂即过时的「下一步」干活。
        site: facts.site,
      });
      try {
        fs.writeFileSync(file, doc, 'utf8');
      } catch (error) {
        throw actionError(
          'handoff',
          `交接单写盘失败（${deps.cfg.handoffDir}）：${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }

      // 5) 新会话：同工作区 / 同 preset / 同模型，注入交接单并起第一轮。
      //    A5：标题序号优先读父会话里的 relay 记录（不依赖解析标题文案）。
      const titlePlan = handoffTitlePlanOf(deps.ctx, session);
      let created;
      try {
        created = await createHandoffSession({
          ctx: deps.ctx,
          engine: deps.engine,
          session,
          agent,
          doc,
          title: titlePlan.title,
          log: deps.log,
        });
      } catch (error) {
        // 建会话失败 → 清掉刚写的交接单，避免留孤儿文件（P2-2）。
        try {
          fs.unlinkSync(file);
        } catch {
          /* 清不掉也别盖住原始错误 */
        }
        throw error;
      }

      // A5：把接力链写成父会话里的结构化记录；写失败不阻断交接（标题解析仍可兜底）。
      const relayWrote = writeRelayRecord(deps.engine, session, {
        parentSessionId: session.id,
        childId: created.childId,
        index: titlePlan.index,
        path: file,
        planId: compactOutcome?.planId ?? null,
        at: Date.now(),
        title: titlePlan.title,
        baseTitle: titlePlan.baseTitle,
      });
      if (!relayWrote) deps.log?.warn?.('compact-relay: 接力链记录写入失败，下次交接将回退到标题解析');

      // BUG-004：失败原因可能是「摘要模型调用了工具」这类可操作信息，以前只写「日志有记录」
      // （用户看不到 host 日志）；这里带上短原因 + 可手动 /bc 的建议。
      const briefWarning =
        compactWarning === null
          ? ''
          : compactWarning.length > 120
            ? `${compactWarning.slice(0, 119)}…`
            : compactWarning;
      const compactNote =
        compactOutcome !== null && compactOutcome.compacted === true
          ? `已将 ${compactOutcome.shadowedSeqs.length} 条旧会话压成 1 条摘要；`
          : compactOutcome !== null
            ? '没有可压缩内容，交接单基于完整历史；'
            : compactWarning !== null
              ? `压缩失败已跳过（${briefWarning}）；需要的话可先手动 /bc 再交接；`
              : '';

      return {
        ok: true,
        childId: created.childId,
        path: file,
        readiness,
        started: created.started,
        message:
          `交接完成：${compactNote}` +
          `交接单已存至 ${file}；` +
          `新会话（${created.childId}）已就绪` +
          (created.started ? '，正在切换。' : '，正在切换（首轮未自动启动，可在新会话里发一条消息继续）。') +
          // A5 兜底：结构化 childId 没传下来时，客户端可从文本里提取。
          `\n#child=${created.childId}`,
      };
    } catch (error) {
      // 取消统一收口；已提交/落盘状态不明的错误不许谎报「没改」。
      throw cancelErrorOf(error, combined, '已取消交接；已完成的压缩不会回滚。');
    } finally {
      finishInflight(deps, agent.id, controller);
    }
  });
}

/**
 * 交接预览（A1b）：生成九段草稿 + 就绪清单，但不写盘、不建会话、不改历史。
 *
 * 注意：真实交接会先 best-effort 压缩再重新生成，所以这里只代表「按当前历史
 * 交接会写成什么样」；确认后仍走 handoff() 的完整流程。
 * @param {{ctx:object, cfg:object, engine:object, log?:object}} deps
 * @param {{agent:object, signal?:AbortSignal}} input
 */
export async function previewHandoff(deps, { agent, signal }) {
  if (agent === undefined || agent === null) throw actionError('handoff', '当前没有打开的会话，无法预览交接');
  const session = agent.session;
  if (session === undefined) throw actionError('handoff', '没有活动会话，无法预览交接');

  const facts = await collectHandoffFacts(deps, agent);
  const generated = await generateHandoffDoc({
    ctx: deps.ctx,
    engine: deps.engine,
    agent,
    maxTokens: deps.cfg.handoff.maxTokens,
    inputTokens: facts.measured.tokens,
    timeoutMs: deps.cfg.timeouts?.llmMs,
    signal,
    programSections: facts.programSections,
  });
  const readiness = checkHandoffReadiness({
    sections: generated.sections,
    surfaceText: JSON.stringify(surfaceMessages(facts.session)),
    changedFiles: facts.changedFiles,
    messageCount: surfaceSeqs(facts.session).length,
  });
  if (!readiness.ok) {
    throw actionError('handoff', `交接单就绪检查未通过：缺少或为空的小节：${readiness.missing.join('、')}`);
  }
  return {
    ok: true,
    draft: generated.text,
    readiness,
    pressure: facts.measured.tokens,
    summaries: facts.summaries,
    changedFiles: facts.changedFiles,
    attempts: generated.attempts,
  };
}
