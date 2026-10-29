/**
 * 0.5.2 L 项：**强制归档旧会话**（显式用户确认后才停止后台任务）。
 *
 * 背景：自动归档（`dsh/handoff-archive.js:archiveHandoffSource`）在旧会话还有
 * turn/subagent/job/schedule 时**故意不归档**（`status:'active'`）—— 静默杀后台任务
 * 比「旧会话多留一行」破坏性大得多。但这也意味着「旧会话一直有任务在跑」时用户
 * 没有清理出路（0.5.x 补丁计划 P4）。这里补的就是那条**显式**出路：
 *
 *   - 只有 `confirmStop === true`（用户在二次确认里点过「强制归档（停止任务）」）
 *     才会调用 `workspaceRegistry.archiveSession(sessionId, { stopActivity: true })`；
 *   - 没有确认 → 直接拒绝（不静默降级成普通归档，也不静默停止任务）；
 *   - 旧会话在侧栏置顶时要求 `confirmUnpin === true`（宿主归档会在同一次写盘里
 *     取消置顶），否则返回 `pinned` + 现有置顶文案，**不归档**；
 *   - 失败抛可读错误（`code:'force-archive'`），不吞、不假装成功。
 *
 * 宿主实证（`@deepseek-ai/dsh-workspace/lib/index.js`）：
 *   - `archiveSession(id)` 先跑 `workspace/session-activity` waterfall，有 provider
 *     报活就抛 `WorkspaceActiveSessionError`（带 `activity` 数组）；
 *   - `archiveSession(id, { stopActivity:true })` 跳过活动检查、先写归档集合，再
 *     `workspace/session-stop` 停止旧会话的 turn/subagent/job/schedule；
 *   - 归档与置顶互斥：同一笔写盘会把该 id 从 `pinnedSessionIds` 移除。
 */
import { actionError } from '../core/errors.js';
import {
  archivedSessionIdsOf,
  handoffArchiveNoteOf,
  isSessionArchived,
  isSessionPinned,
  workspaceRegistryOf,
} from '../dsh/handoff-archive.js';

function errorMessageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 强制归档旧会话（会停止它上面正在跑的 turn / subagent / job / schedule）。
 *
 * 返回值（全部 `ok:true`；失败一律抛 `actionError('force-archive', …)`）：
 *   - `status:'archived'`  刚写入归档集合（已停止任务）；
 *   - `status:'already'`   之前就已经归档（幂等，不再写盘、不再停任务）；
 *   - `status:'pinned'`    已置顶且未确认取消置顶 —— **没有归档**，note 是现有置顶文案。
 * 三种情况的 `note` 都复用 `handoffArchiveNoteOf`（与交接自动归档同一套告知文案）。
 *
 * @param {{ctx:object, log?:{warn?:Function}}} deps
 * @param {{sessionId:string, confirmStop:boolean, confirmUnpin?:boolean}} input
 *   sessionId 是**旧会话** id（不是当前会话）；confirmStop 必须是 true（二次确认的凭证）。
 * @returns {Promise<{ok:true, status:'archived'|'already'|'pinned', archived:boolean, note:string, archivedCount:number|null, newlyArchived:string[], stopActivity?:'done'|'skipped'|'failed'}>}
 */
export async function forceArchiveSession(deps, { sessionId, confirmStop, confirmUnpin } = {}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw actionError('force-archive', '缺少要强制归档的会话 id', undefined, 400);
  }

  const registry = workspaceRegistryOf(deps.ctx);
  if (registry === null || typeof registry.archiveSession !== 'function') {
    throw actionError('force-archive', '当前 DSH 宿主没有 Workspace 归档接口，无法强制归档旧会话', undefined, 503);
  }

  const archivedCountOf = () => {
    const ids = archivedSessionIdsOf(deps.ctx);
    return Array.isArray(ids) ? ids.length : null;
  };

  // 0.5.3 P2-1：幂等判断在 confirmStop 之前 —— 已归档 + 不带确认应回 already（200），
  // 不再因为「没带二次确认」先 400（devgod 052 真机：已归档会话点归档直接报错）。
  if (isSessionArchived(deps.ctx, sessionId) === true) {
    const base = handoffArchiveNoteOf({ status: 'already', archived: true });
    // 0.5.3 P2-下：already 防漏杀加固 —— 归档会话可能在归档前还有后台任务残留。
    // 用户这次显式要求「强制归档」时，补跑一次 stopActivity 兜底（幂等）；未要求则明确
    // 报告「本次未执行 stopActivity」，不假装已经停干净。
    if (confirmStop === true) {
      try {
        await registry.archiveSession(sessionId, { stopActivity: true });
        return {
          ok: true,
          status: 'already',
          archived: true,
          stopActivity: 'done',
          note: `${base}（本次已补停旧会话上的任务）`,
          archivedCount: archivedCountOf(),
          newlyArchived: [],
        };
      } catch (error) {
        deps.log?.warn?.(`compact-relay: 补停归档会话 ${sessionId} 的任务失败：${errorMessageOf(error)}`);
        return {
          ok: true,
          status: 'already',
          archived: true,
          stopActivity: 'failed',
          note: `${base}（补停任务失败：${errorMessageOf(error)}）`,
          archivedCount: archivedCountOf(),
          newlyArchived: [],
        };
      }
    }
    return {
      ok: true,
      status: 'already',
      archived: true,
      stopActivity: 'skipped',
      note: `${base}（本次未执行 stopActivity）`,
      archivedCount: archivedCountOf(),
      newlyArchived: [],
    };
  }

  // 防御性：真正要归档的路径仍然要求显式确认（HTTP 层与客户端都会带）。
  if (confirmStop !== true) {
    throw actionError(
      'force-archive',
      '强制归档会停止旧会话上正在跑的任务，需要显式确认（confirmStop:true）',
      undefined,
      400,
    );
  }

  // 置顶保护：归档会取消置顶（宿主在同一笔写盘里做），必须用户单独确认；
  // 读不到置顶集合（null）时不猜 —— 按「未置顶」继续，由宿主自己决定。
  if (confirmUnpin !== true && isSessionPinned(deps.ctx, sessionId) === true) {
    deps.log?.warn?.(
      `compact-relay: 旧会话 ${sessionId} 在侧栏置顶，未确认取消置顶前不强制归档（归档会取消置顶）`,
    );
    return {
      ok: true,
      status: 'pinned',
      archived: false,
      // 0.5.2 审查 P1-3：本场景没有「交接确认」可点，不能复用交接流程的 pinned 文案。
      note: '旧会话已置顶，本次未归档（归档会取消置顶）；确认「仍然归档（取消置顶）」后才会归档并可恢复。',
      archivedCount: archivedCountOf(),
      newlyArchived: [],
    };
  }

  try {
    // 唯一允许传 stopActivity 的地方：用户已确认「会停止旧会话上正在跑的任务」。
    await registry.archiveSession(sessionId, { stopActivity: true });
  } catch (error) {
    deps.log?.warn?.(`compact-relay: 强制归档旧会话 ${sessionId} 失败：${errorMessageOf(error)}`);
    const unknown = error !== null && typeof error === 'object' && error.name === 'WorkspaceUnknownSessionError';
    throw actionError(
      'force-archive',
      unknown
        ? `强制归档失败：宿主里找不到这个会话（${errorMessageOf(error)}）`
        : `强制归档失败：${errorMessageOf(error)}`,
      error,
      unknown ? 404 : 500,
    );
  }

  return {
    ok: true,
    status: 'archived',
    archived: true,
    note: handoffArchiveNoteOf({ status: 'archived', archived: true }),
    // 0.5.3 P3-a：不再回全量归档集合（142 条 ≈ 7KB，随归档线性增长，客户端根本不读）。
    // 只回数量 + 本次新归档的 id，语义与体积都对。
    archivedCount: archivedCountOf(),
    newlyArchived: [sessionId],
  };
}
