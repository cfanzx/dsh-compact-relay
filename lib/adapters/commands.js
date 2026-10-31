/**
 * 斜杠命令适配层 —— 只做「参数校验 → 调 action → 结果映射」。
 *
 * /bc、/handoff、/pin、/unpin、/bctest 五个入口都不含业务逻辑；
 * 换实现只动 actions 层。
 */
import { betterCompact, previewBetterCompact, takePreviewPlan } from '../actions/better-compact.js';
import { handoff } from '../actions/handoff.js';
import { listPins, pinByIndex, pinLastTurn, unpinAll } from '../actions/pin.js';
import { favoriteLast, listFavoriteSuggestions, listFavorites, markFavoriteInSession, readFavoriteFull, readFavoriteInfo, unfavoriteByIndex } from '../actions/favorite.js';
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
                // 0.5.6 A：命令入口的归属口径（菜单/外部/原生自动都不走这里）。
                trigger: 'command',
              });
              return success(outcome);
            }
            const outcome = await previewBetterCompact(deps, { agent: invocation.agent, trigger: 'command' });
            return success(outcome);
          } catch (error) {
            return failure(error, invocation.signal);
          }
        })(),
      ),
  });

  register({
    name: 'handoff',
    description: '交接新会话：生成交接单并开新会话接着聊，旧会话保留（/handoff｜/handoff status 查进度）',
    // 必须声明 input：DSH 客户端只让「声明了 input」的命令接受带参数的行，
    // 否则 `/handoff status` 会被当成普通消息发出去（踩坑记录见 /bc、/bctest）。
    input: { hint: 'status [jobId]' },
    handler: (invocation) =>
      track(
        (async () => {
          const raw = invocation.rawInput.trim();
          const statusMatch = /^status(?:\s+(\S+))?$/i.exec(raw);
          if (raw !== '' && statusMatch === null) {
            return { kind: 'error', text: '用法：/handoff（开始交接）或 /handoff status [jobId]（查看进度）' };
          }
          try {
            const table = deps.jobs;
            // 旧装配（手搓 deps 没有 jobs）：保持 0.5.6 的同步交接，不让命令失效。
            if (table === null || table === undefined || typeof table.start !== 'function') {
              if (raw !== '') return { kind: 'error', text: '当前装配没有任务表，无法查询交接进度。' };
              const outcome = await handoff(deps, {
                agent: invocation.agent,
                commandId: invocation.commandId,
                trigger: 'command',
              });
              return success(outcome);
            }

            // 两段式（0.5.7）：命令只负责「起任务 / 查状态」，绝不轮询到结束 ——
            // 命令处理器寿命绑在发起它的 UI 请求上，把 20s 从一次请求挪到一条命令毫无意义。
            if (statusMatch !== null) {
              const requestedId = statusMatch[1];
              const agent = invocation.agent;
              const sessionId = agent?.session?.id ?? agent?.id;
              const job =
                typeof requestedId === 'string'
                  ? table.get(requestedId)
                  : sessionId === undefined
                    ? null
                    : table.latest(sessionId, 'handoff');
              if (job === null) {
                return { kind: 'error', text: '没有找到交接任务（宿主重启会清空任务表，请重新 /handoff）。' };
              }
              const endAt = Number.isFinite(job.endedAt) ? job.endedAt : Date.now();
              const seconds = Math.max(0, Math.round(((endAt - job.startedAt) / 1000) * 10) / 10);
              if (job.status === 'running') {
                return {
                  kind: 'success',
                  text: `交接任务进行中（已 ${seconds}s；任务 ${job.id}）。稍后用 /handoff status 查看结果。`,
                };
              }
              if (job.status === 'done' && job.result !== null && typeof job.result === 'object') {
                return success(job.result);
              }
              if (job.status === 'cancelled') {
                return { kind: 'error', text: `交接已取消（任务 ${job.id}）；已完成的压缩不会回滚。` };
              }
              return {
                kind: 'error',
                text: `交接失败（任务 ${job.id}）：${job.error?.message ?? '未知原因'}`,
              };
            }

            const agent = invocation.agent;
            if (agent === null || agent === undefined) {
              return { kind: 'error', text: '当前没有打开的会话，无法交接' };
            }
            const sessionId = agent.session?.id ?? agent.id;
            const started = table.start({
              kind: 'handoff',
              action: 'handoff',
              sessionId,
              params: {},
              run: ({ signal, jobId }) =>
                handoff(deps, {
                  agent,
                  commandId: invocation.commandId,
                  // 不接 invocation.signal：那是「这一次 UI 请求」的信号，请求正常结束后可能被
                  // abort，会把后台 job 误杀。job 只接自己的 controller（job-cancel 取消）。
                  signal,
                  jobId,
                  trigger: 'command',
                }),
            });
            if (started.busy === true) {
              return {
                kind: 'error',
                text: `上一次交接还在跑（任务 ${started.job.id}），先 /handoff status 查看；要重来请先在界面上取消。`,
              };
            }
            // 命令不起 watchdog：job 表 TTL/取消由 HTTP job-cancel 与插件卸载负责。
            table.launch(started.job.id);
            return {
              kind: 'success',
              text: `已开始交接（任务 ${started.job.id}）。这一步要十几秒，用 /handoff status 查看进度和结果。`,
            };
          } catch (error) {
            return failure(error, invocation.signal);
          }
        })(),
      ),
  });

  register({
    name: 'favorite',
    description: '收藏消息：/favorite 列表｜/favorite mark [序号] 收藏（不带序号=最后一条回复）｜/favorite last 收藏我刚发的｜/favorite <序号> 看体积｜/favorite <序号> read 读原文｜/favorite rm <序号> 取消',
    input: { hint: 'list | mark [序号] | last | suggest | 序号 | 序号 read | rm 序号' },
    handler: (invocation) =>
      track(
        (async () => {
          try {
            const raw = invocation.rawInput.trim();
            const lower = raw.toLowerCase();
            const agent = invocation.agent;
            let outcome = null;
            if (raw === '' || lower === 'list') outcome = listFavorites(deps, { agent });
            else if (lower === 'last') outcome = favoriteLast(deps, { agent });
            else if (lower === 'suggest') outcome = listFavoriteSuggestions(deps, { agent });
            else if (/^mark$/i.test(raw)) outcome = markFavoriteInSession(deps, { agent });
            else if (/^mark\s+\d+$/i.test(raw)) outcome = markFavoriteInSession(deps, { agent, seq: Number(raw.slice(4).trim()) });
            else if (/^\d+$/.test(raw)) outcome = readFavoriteInfo(deps, { agent, index: Number(raw) });
            else {
              const readMatch = /^(\d+)\s+read$/i.exec(raw);
              const rmMatch = /^rm\s+(\d+)$/i.exec(raw);
              if (readMatch !== null) outcome = readFavoriteFull(deps, { agent, index: Number(readMatch[1]) });
              else if (rmMatch !== null) outcome = unfavoriteByIndex(deps, { agent, index: Number(rmMatch[1]) });
            }
            if (outcome === null) {
              return { kind: 'error', text: '用法：/favorite（列表）｜/favorite mark [序号]（收藏，不带序号=最后一条回复）｜/favorite last｜/favorite <序号>（看体积）｜/favorite <序号> read（读原文）｜/favorite rm <序号>（取消）' };
            }
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
              // 0.5.6 D1：/bctest 的归属口径（与 /bc 一致）。
              trigger: 'command',
            });
            return success(outcome);
          } catch (error) {
            return failure(error, invocation.signal);
          }
        })(),
      ),
  });
}
