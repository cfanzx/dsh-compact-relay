/**
 * 斜杠命令适配层 —— 只做「参数校验 → 调 action → 结果映射」。
 *
 * /bc、/handoff、/pin、/unpin、/bctest 五个入口都不含业务逻辑；
 * 换实现只动 actions 层。
 */
import { betterCompact, previewBetterCompact, takePreviewPlan } from '../actions/better-compact.js';
import { handoff } from '../actions/handoff.js';
import { listPins, pinByIndex, pinLastTurn, unpinAll } from '../actions/pin.js';
import { testCompact } from '../actions/test-compact.js';
import { errorText } from '../core/errors.js';

function success(outcome) {
  return {
    kind: 'success',
    text: typeof outcome?.message === 'string' && outcome.message.length > 0 ? outcome.message : '完成。',
    ...(Number.isFinite(outcome?.summarySeq) ? { sourceEventSeq: outcome.summarySeq } : {}),
    // A5：交接命令把结构化 childId 一并交给命令卡（文本里的 #child= 只是兜底）。
    ...(typeof outcome?.childId === 'string' && outcome.childId.length > 0 ? { childId: outcome.childId } : {}),
  };
}

function failure(error, signal) {
  return { kind: 'error', text: signal?.aborted ? '操作已取消。' : errorText(error) };
}

/**
 * @param {object} ctx
 * @param {{ctx:object, cfg:object, lock:object, engine:object}} deps
 */
export function registerCommands(ctx, deps) {
  const active = new Set();

  const track = (promise) => {
    active.add(promise);
    const retire = () => active.delete(promise);
    promise.then(retire, retire);
    return promise;
  };

  const register = (definition) => {
    ctx.effect(function* () {
      yield async () => {
        await Promise.allSettled(active);
      };
      yield ctx.commands.register(definition);
    }, `compact-relay: /${definition.name} command`);
  };

  register({
    name: 'bc',
    description: '压缩旧会话：把较早会话压成摘要腾出容量，先看压缩预估再确认（/bc confirm）',
    // 与 /bctest 同理：声明 input 才能让「/bc confirm」不被当成普通消息。
    input: { hint: 'confirm' },
    handler: (invocation) =>
      track(
        (async () => {
          const raw = invocation.rawInput.trim();
          if (raw !== '' && raw !== 'confirm') {
            return { kind: 'error', text: '用法：/bc（预览）或 /bc confirm（真正执行）' };
          }
          try {
            if (raw === 'confirm') {
              // A3：确认必须绑定刚才预览的那一段；缓存过期就要求重新预览，不拿新范围冒充旧同意。
              const expected = takePreviewPlan(invocation.agent?.id);
              if (expected === null) {
                return { kind: 'error', text: '预览已过期或还没预览，请先输入 /bc 重新预览，再 /bc confirm。' };
              }
              const outcome = await betterCompact(deps, {
                agent: invocation.agent,
                signal: invocation.signal,
                commandId: invocation.commandId,
                expected,
              });
              return success(outcome);
            }
            const outcome = await previewBetterCompact(deps, { agent: invocation.agent });
            return success(outcome);
          } catch (error) {
            return failure(error, invocation.signal);
          }
        })(),
      ),
  });

  register({
    name: 'handoff',
    description: '交接新会话：生成交接单并开新会话接着聊，旧会话保留（交接前可能压缩）（/handoff）',
    handler: (invocation) =>
      track(
        (async () => {
          if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: '用法：/handoff（不带参数）' };
          try {
            const outcome = await handoff(deps, {
              agent: invocation.agent,
              signal: invocation.signal,
              commandId: invocation.commandId,
            });
            return success(outcome);
          } catch (error) {
            return failure(error, invocation.signal);
          }
        })(),
      ),
  });

  register({
    name: 'pin',
    description: '锁定重要消息：/pin 锁定最近一轮｜/pin list 按序号挑｜/pin clear 全部解锁',
    input: { hint: 'list | 序号 | clear' },
    handler: (invocation) =>
      track(
        (async () => {
          try {
            const raw = invocation.rawInput.trim();
            const lower = raw.toLowerCase();
            const agent = invocation.agent;
            let outcome;
            if (raw === '') outcome = pinLastTurn(deps, { agent });
            else if (lower === 'list') outcome = listPins(deps, { agent });
            else if (lower === 'clear' || lower === 'unpin') outcome = unpinAll(deps, { agent });
            else if (/^\d+$/.test(raw)) outcome = pinByIndex(deps, { agent, index: Number(raw) });
            else outcome = null;
            if (outcome === null) {
              return { kind: 'error', text: '用法：/pin（锁定最近一轮）｜/pin list（看最近 10 条）｜/pin <序号>｜/pin clear（全部解锁）' };
            }
            return success(outcome);
          } catch (error) {
            return failure(error, invocation.signal);
          }
        })(),
      ),
  });

  register({
    name: 'unpin',
    description: '解锁消息：解除锁定，允许后续压缩合并这些消息',
    handler: (invocation) =>
      track(
        (async () => {
          try {
            return success(unpinAll(deps, { agent: invocation.agent }));
          } catch (error) {
            return failure(error, invocation.signal);
          }
        })(),
      ),
  });

  register({
    name: 'bctest',
    description: 'M1 实验：把最近几条历史换成一条摘要（默认只预览，confirm 才执行）',
    // 必须声明 input：DSH 客户端只让「声明了 input」的命令接受带参数的行，
    // 否则 `/bctest confirm` 会被当成普通消息发出去（matchEnter 里 bare=false → void 0）。
    input: { hint: 'confirm' },
    handler: (invocation) =>
      track(
        (async () => {
          const raw = invocation.rawInput.trim();
          if (raw !== '' && raw !== 'confirm') {
            return { kind: 'error', text: '用法：/bctest（预览）或 /bctest confirm（真正执行）' };
          }
          try {
            const outcome = await testCompact(deps, {
              agent: invocation.agent,
              signal: invocation.signal,
              confirm: raw === 'confirm',
              commandId: invocation.commandId,
            });
            return success(outcome);
          } catch (error) {
            return failure(error, invocation.signal);
          }
        })(),
      ),
  });
}
