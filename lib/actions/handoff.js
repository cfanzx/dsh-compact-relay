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
import { clipCodeUnits } from '../core/clip.js';
import { actionError } from '../core/errors.js';
import { pinAnchorOf } from '../core/pin-anchors.js';
import { handoffFileName, renderHandoffDoc } from '../core/handoff-doc.js';
import { applyHandoffEdits, editableHandoffView, normalizeHandoffEdits } from '../core/handoff-edit.js';
import { composeHandoffText } from '../core/handoff-spec.js';
import { betterCompactLocked } from './better-compact.js';
import { compressHint, countSummaries, livePinnedSeqs, surfaceSeqs } from '../dsh/session-view.js';
import { measurePressure } from '../dsh/pressure.js';
import { buildSiteSnapshot } from '../dsh/site-info.js';
import { generateHandoffDoc } from '../dsh/handoff-writer.js';
import { buildHandoffProgramSections } from '../core/handoff-facts.js';
import { checkHandoffReadiness } from '../core/readiness.js';
import { parentRelayRecordOf } from '../core/relay-record.js';
import { changedFilesOf } from '../dsh/session-files.js';
import { errorCodeOf, localIso } from '../dsh/diag-counters.js';
import { surfaceMessages } from '../dsh/prefix.js';
import { handoffTitlePlanOf, createHandoffSession, renameHistoryOf, sourceTitleOf } from '../dsh/sessions.js';
import { relayInboundRecordOf, writeRelayRecord } from '../dsh/relay.js';
import { archiveHandoffSource, handoffArchiveNoteOf, isSessionPinned } from '../dsh/handoff-archive.js';
import { withLock } from './lock.js';
import { beginInflight, cancelErrorOf, combinedSignal, finishInflight } from './support.js';
import { withActionEvent } from './evented.js';
import { runIdle } from '../dsh/idle.js';

/**
 * 压缩阶段：能压就压，压不了就带着原因往下走。
 * @returns {Promise<{outcome: object|null, warning: string|null}>}
 */
async function compactFirst(deps, { agent, signal, commandId, log }) {
  try {
    // P1-3：交接内部的压缩不单独记账（避免一次 /handoff 记两条）；由交接记录统一反映。
    return { outcome: await betterCompactLocked(deps, { agent, signal, commandId, ledgerRecord: false }), warning: null };
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
 * @returns {Promise<{session:object, measured:object, now:Date, site:object, summaries:number, pinnedSeqs:number[], pinnedAnchors:Array<{seq:number,role:string,snippet:string}>, changedFiles:string[], programSections:Record<string,string>}>}
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
  // 0.4 P1-2：pin 保留契约锚点 = seq + 角色 + 一句摘要（≤60 字符，不贴原文全文）。
  const pinnedAnchors = pinnedSeqs
    .map((seq) => {
      const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined;
      return event === undefined || event === null ? null : pinAnchorOf(event);
    })
    .filter((anchor) => anchor !== null);
  const changedFiles = changedFilesOf(session);
  const programSections = buildHandoffProgramSections({
    compressHint: compressHint(session),
    summaries,
    pressure: measured.tokens,
    pins: { count: pinnedSeqs.length, seqs: pinnedSeqs, anchors: pinnedAnchors },
    changedFiles,
    site,
  });
  return { session, measured, now, site, summaries, pinnedSeqs, pinnedAnchors, changedFiles, programSections };
}

/**
 * 交接新会话（/handoff、菜单「交接新会话」、命令卡）—— 对外入口 = 诊断埋点采集点。
 *
 * 0.4 P0-2：只在这里数「交接成功/失败 / 耗时 / 错误码」，失败原因只记 code，
 * 不记 message（message 可能带交接单路径/会话内容）。行为与文案不变。
 *
 * @param {{ctx:object, cfg:object, lock:object, engine:object, log?:object, diag?:object}} deps
 * @param {{agent:object, signal?:AbortSignal, commandId?:string, edits?:Record<string,string>, archive?:boolean, confirmUnpin?:boolean}} input
 *   edits 只允许 `{约束?:string, 下一步?:string}`（P2-1；非法字段抛 code='edits'）
 *   archive 默认 true（0.5.0 行为）；false = 只交接不归档
 *   confirmUnpin 默认 false：旧会话在侧栏置顶时，必须显式确认才归档（归档会取消置顶）
 */
export async function handoff(deps, { agent, signal, commandId, edits, archive, confirmUnpin, trigger } = {}) {
  return withActionEvent(
    deps,
    {
      action: 'handoff',
      trigger,
      agent,
      phase: 'llm',
      // 成功返回时补上结构化结果（失败时由 evented 统一采集上下文）。
      resultFields: (outcome) => ({
        childId: typeof outcome?.childId === 'string' ? outcome.childId : undefined,
        context: {
          ready: outcome?.readiness?.ok,
          archive: outcome?.archive?.status,
        },
      }),
    },
    async () => {
      const startedAt = Date.now();
      try {
        const outcome = await runHandoff(deps, { agent, signal, commandId, edits, archive, confirmUnpin });
        deps.diag?.bumpAction('handoff', true);
        return outcome;
      } catch (error) {
        deps.diag?.bumpAction('handoff', false);
        deps.diag?.recordError(errorCodeOf(error), 'handoff');
        throw error;
      } finally {
        deps.diag?.recordDuration('handoff', Date.now() - startedAt);
      }
    },
  );
}

/**
 * 交接流程本体。
 * @param {{ctx:object, cfg:object, lock:object, engine:object, log?:object}} deps
 * @param {{agent:object, signal?:AbortSignal, commandId?:string, edits?:object, archive?:boolean, confirmUnpin?:boolean}} input
 */
async function runHandoff(deps, { agent, signal, commandId, edits, archive, confirmUnpin }) {
  if (agent === undefined || agent === null) throw actionError('handoff', '当前没有打开的会话，无法交接');
  const session = agent.session;
  if (session === undefined) throw actionError('handoff', '没有活动会话，无法交接');

  // 0.4 P2-1：先校验用户编辑（只允许「约束」「下一步」），非法字段在压缩/写盘之前就拒绝。
  const normalizedEdits = normalizeHandoffEdits(edits);

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

      // 0.4 P1-3：轻账本——先记下「压前占用」（交接内部的压缩会改变之后的压力读数）。
      const startedAt = Date.now();
      const beforeMeasured = await measurePressure(deps.ctx, agent, { windowFallback: deps.cfg.contextWindowFallback }).catch(
        () => null,
      );

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

      // 3.2) 0.4 P2-1：套用「约束 / 下一步」两段的用户编辑（预览→确认链路）。
      // 只覆盖这两段；程序/模型生成的其余七段原样保留（前后端都不接受其它字段）。
      const editedSections = applyHandoffEdits(generated.sections, normalizedEdits);
      const editedText = composeHandoffText(editedSections);

      // 3.5) 就绪检查：九段缺段/占位阻断；路径核对只警告，不阻断。
      const readiness = checkHandoffReadiness({
        sections: editedSections,
        surfaceText: JSON.stringify(surfaceMessages(facts.session)),
        changedFiles: facts.changedFiles,
        messageCount: surfaceSeqs(facts.session).length,
      });
      if (!readiness.ok) {
        throw actionError('handoff', `交接单就绪检查未通过：缺少或为空的小节：${readiness.missing.join('、')}`);
      }
      for (const warning of readiness.warnings) deps.log?.warn?.(`compact-relay: 交接单就绪警告：${warning}`);

      // 4) 写盘：文档头带元信息，九段正文 = 模型 7 段 + 程序 2 段 + 用户编辑的两段。
      const titlePlan = handoffTitlePlanOf(deps.ctx, session);
      const file = path.join(deps.cfg.handoffDir, handoffFileName(facts.now));
      const doc = renderHandoffDoc({
        generated: editedText,
        sourceSessionId: facts.session.id,
        sourceTitle: sourceTitleOf(deps.ctx, facts.session),
        now: facts.now,
        pressure: facts.measured.tokens,
        summaries: facts.summaries,
        file,
        // M6：把「宿主刚重启过 / 工作区分支 / 有没有后台任务在跑」写进文档头，
        // 免得接手者按一份出厂即过时的「下一步」干活。
        site: facts.site,
        // 0.4 P2-2：文档头直接写「第 N 次交接」，接手者不用解析标题。
        ordinal: titlePlan.index,
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
      let created;
      try {
        created = await createHandoffSession({
          ctx: deps.ctx,
          engine: deps.engine,
          session,
          agent,
          doc,
          title: titlePlan.title,
          // 0.5.0：交接单已经落盘，把同一个路径写进子会话 relay 记录（接力条
          // 「查看交接单」不再依赖回查父会话）；父记录仍写同一份 path。
          path: file,
          plan: titlePlan,
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

      // 0.5.0 命名反转：新链在**子会话建好之后**把旧会话改名「历史 N：<原名>」，
      // 新会话已经继承干净原名（createHandoffSession 里改名）。旧链（handoff-n）不动，
      // 保持「交接第 N 次：」一个字符不改（链级 cutover）。
      // 改名是可见副作用：失败只 warn，交接照常成功；成功后 renameHistoryOf 内部 flush。
      const historyRename = await renameHistoryOf(deps.ctx, session, {
        index: titlePlan.index,
        baseTitle: titlePlan.baseTitle,
        scheme: titlePlan.scheme,
        log: deps.log,
      });

      // A5：把接力链写成父会话里的结构化记录；写失败不阻断交接（标题解析仍可兜底）。
      // 0.5.2 S2：形状（含 0.3 旧字段双写、planId、条件写入的 historyTitle、**键顺序**）
      // 全部由 core/relay-record 的唯一构造器负责，这里只传语义参数。
      // historyTitle 只在改名真的生效（renamed / already）时传；失败/服务不可用时
      // 不能记一个不存在的标题 —— 构造器对空/非字符串一律不写这个键。
      const relayAt = Date.now();
      const relayWrote = writeRelayRecord(
        deps.engine,
        session,
        parentRelayRecordOf({
          parentId: session.id,
          childId: created.childId,
          ordinal: titlePlan.index,
          at: relayAt,
          atIso: localIso(new Date(relayAt)),
          path: file,
          planId: compactOutcome?.planId,
          title: titlePlan.title,
          baseTitle: titlePlan.baseTitle,
          // 0.6：收藏文件按链根分文件——初代传自己，后代沿用入站记录的 rootId。
          rootId: relayInboundRecordOf(session)?.rootId ?? session.id,
          scheme: titlePlan.scheme,
          titleSeq: historyRename.titleSeq,
          historyTitle:
            titlePlan.scheme === 'history-n' && (historyRename.renamed || historyRename.reason === 'already')
              ? historyRename.title
              : undefined,
        }),
      );
      if (!relayWrote) deps.log?.warn?.('compact-relay: 接力链记录写入失败，下次交接将回退到标题解析');
      // renameHistoryOf 的 flush 发生在父记录之前；这里再 flush 一次，保证旧会话的
      // 「历史 N」标题与这条父记录一起落盘（失败只 warn，不影响交接结果）。
      try {
        await deps.ctx.sessions?.flush?.(session);
      } catch (error) {
        deps.log?.warn?.(`compact-relay: 旧会话接力链记录落盘失败：${error instanceof Error ? error.message : String(error)}`);
      }

      // 0.5.0：交接成功后自动归档旧会话（让列表只剩新会话）。
      // 0.5.1 批 2：archive:false = 只交接不归档；旧会话在侧栏置顶时必须显式
      // confirmUnpin 才归档（宿主归档会在同一次写盘里取消置顶 —— dsh-workspace 源码）。
      // 顺序要求：子会话已建好、旧会话已改名、父记录已 flush —— 全部完成之后才归档；
      // 归档失败只 warn + 在返回文案里说明，绝不回滚/阻断交接。
      // 不传 stopActivity：自动流程不替用户取消旧会话里仍在跑的 turn/subagent/job/schedule；
      // 只对收尾中的 turn 做有限等待重试，仍活跃就保留可见并提示（宁可多一行，不静默杀任务）。
      const archiveRequested = archive !== false;
      let archiveResult;
      if (!archiveRequested) {
        archiveResult = { status: 'skipped', archived: false, activityKinds: [] };
      } else if (isSessionPinned(deps.ctx, session.id) === true && confirmUnpin !== true) {
        archiveResult = { status: 'pinned', archived: false, activityKinds: [] };
        deps.log?.warn?.(
          `compact-relay: 旧会话 ${session.id} 在侧栏置顶，未确认前不自动归档（归档会取消置顶；交接已完成）`,
        );
      } else {
        try {
          archiveResult = await archiveHandoffSource(deps.ctx, session.id, { log: deps.log });
        } catch (error) {
          // archiveHandoffSource 设计上不抛；这里再兜一层，任何替身/内核异常都不影响交接结果。
          deps.log?.warn?.(`compact-relay: 旧会话归档异常：${error instanceof Error ? error.message : String(error)}（交接已完成）`);
          archiveResult = { status: 'failed', archived: false, activityKinds: [] };
        }
      }
      const archiveNote = handoffArchiveNoteOf(archiveResult);

      // BUG-004：失败原因可能是「摘要模型调用了工具」这类可操作信息，以前只写「日志有记录」
      // （用户看不到 host 日志）；这里带上短原因 + 可手动 /bc 的建议。
      // 0.5.1 D03：截断收口到 core/clip（原手写 120 字预算，文案不变）。
      const briefWarning = compactWarning === null ? '' : clipCodeUnits(compactWarning, 120);
      const compactNote =
        compactOutcome !== null && compactOutcome.compacted === true
          ? `已将 ${compactOutcome.shadowedSeqs.length} 条旧会话压成 1 条摘要；`
          : compactOutcome !== null
            ? '没有可压缩内容，交接单基于完整历史；'
            : compactWarning !== null
              ? `压缩失败已跳过（${briefWarning}）；需要的话可先手动 /bc 再交接；`
              : '';

      // 0.4 P1-3：交接成功记一条轻账本（只记数值/路径；不含消息/摘要/交接单正文）。
      try {
        deps.ledger?.record?.({
          kind: 'handoff',
          durationMs: Date.now() - startedAt,
          beforeTokens: beforeMeasured === null ? null : beforeMeasured.tokens,
          afterTokens: facts.measured.tokens,
          beforeRatio: beforeMeasured === null ? null : beforeMeasured.ratio,
          afterRatio: facts.measured.ratio,
          pinHits: { inRange: compactOutcome?.pinnedKept ?? 0, total: facts.pinnedSeqs.length },
          handoff: { path: file, childId: created.childId, started: created.started === true },
        });
      } catch {
        /* 账本静默降级：不能影响交接结果 */
      }

      return {
        ok: true,
        childId: created.childId,
        path: file,
        readiness,
        started: created.started,
        // 0.5.0：归档结果结构化返回（HTTP 暂不下发；客户端看 message/接力条状态即可）。
        archive: { status: archiveResult.status, archived: archiveResult.archived === true },
        message:
          `交接完成：${compactNote}` +
          `交接单已存至 ${file}；` +
          `新会话（${created.childId}）已就绪` +
          (created.started ? '，正在切换。' : '，正在切换（首轮未自动启动，可在新会话里发一条消息继续）。') +
          archiveNote +
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
export async function previewHandoff(deps, { agent, signal, trigger } = {}) {
  if (agent === undefined || agent === null) throw actionError('handoff', '当前没有打开的会话，无法预览交接');
  const session = agent.session;
  if (session === undefined) throw actionError('handoff', '没有活动会话，无法预览交接');

  return withActionEvent(
    deps,
    {
      action: 'handoff-preview',
      trigger,
      agent,
      phase: 'llm',
      resultFields: (outcome) => ({
        context: {
          ready: outcome?.readiness?.ok,
          attempts: outcome?.attempts,
          tokens: outcome?.pressure,
          summaries: outcome?.summaries,
        },
      }),
    },
    async () => {
      // 0.5.6 失败留档 A5：预览也是「一次会打模型的动作」——和压缩执行同语义进 idle 准入。
      // 会话正在回复 → runIdle 抛 busy → HTTP 409，不再把宿主的报文错误变成 500。
      // 配对闸在 dsh/handoff-writer.generateHandoffDoc 里统一做（预览与正式交接同时受益），
      // 这里不重复实现，避免两套判定漂移。
      return runIdle(agent, async (idleSignal) => {
        const facts = await collectHandoffFacts(deps, agent);
        const generated = await generateHandoffDoc({
          ctx: deps.ctx,
          engine: deps.engine,
          agent,
          maxTokens: deps.cfg.handoff.maxTokens,
          inputTokens: facts.measured.tokens,
          timeoutMs: deps.cfg.timeouts?.llmMs,
          signal: signal ?? idleSignal,
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
          // 0.4 P2-1：预览里只暴露「约束」「下一步」两段给客户端编辑（其余段不可改）。
          editable: editableHandoffView(generated.sections),
          // 0.4 P2-2：本次将是第几次交接（链式序号；首次 1）。
          ordinal: handoffTitlePlanOf(deps.ctx, session).index,
          readiness,
          pressure: facts.measured.tokens,
          summaries: facts.summaries,
          changedFiles: facts.changedFiles,
          attempts: generated.attempts,
        };
      });
    },
  );
}
