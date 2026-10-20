/**
 * 标记进度（M4，内部代号「阶段标记」）—— 把「这个阶段完成了」写进会话日志。
 *
 * 只写一条 plugin record：不进模型上下文、不影响 token，压缩/交接都不会碰它。
 * 指示灯读到最新一条后外环变阶段色（默认蓝）；下一次压缩/交接（产生新 checkpoint）之后自动失效。
 */
import { actionError } from '../core/errors.js';
import { STAGE_RECORD_TYPE, normalizeStageLabel } from '../core/stage.js';
import { measurePressure } from '../dsh/pressure.js';

/**
 * @param {{engine:object, ctx?:object, cfg?:object}} deps
 * @param {{agent:object, label?:string}} input
 * @returns {Promise<{label:string, at:number, seq:number, ratio:number|null}>}
 */
export async function markStage(deps, { agent, label } = {}) {
  const session = agent?.session;
  if (session === null || session === undefined) throw actionError('stage', '没有活动会话');
  const normalized = normalizeStageLabel(label);
  const at = Date.now();
  // 0.3.1：记下标记那一刻的容量比例，指示灯才能在环上标出「标记位置」。
  // 测不到（会话刚开 / tokenMeter 不可用）就记 null，环上退化到当前比例。
  const measured = await measurePressure(deps.ctx, agent, {
    windowFallback: deps.cfg?.contextWindowFallback ?? 1_000_000,
  }).catch(() => null);
  const ratio =
    measured !== null && typeof measured === 'object' && typeof measured.ratio === 'number' && Number.isFinite(measured.ratio)
      ? Math.max(0, Math.min(1, measured.ratio))
      : null;
  const seq = deps.engine.appendPluginRecord(session, STAGE_RECORD_TYPE, {
    label: normalized,
    at,
    ...(ratio === null ? {} : { ratio }),
  });
  return { label: normalized, at, seq, ratio };
}
