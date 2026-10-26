/**
 * 统一 fake Session —— 按 DSH 0.2 的公开语义实现，三套 node 测试共用。
 *
 *   - `log`：append-only 事件日志，seq 单调递增（= 事件在数组里的下标）；
 *   - `surface.nodes`：模型可见节点的 seq 列表，**顺序按 surface 位置**，不按 seq 大小排序
 *     （压缩替换后会出现「新 checkpoint（seq 最大）插在旧尾部前面」的非单调 surface）；
 *   - `append(type, data, opts)`：追加日志；message 事件按 opts.surfaceOp 维护 surface：
 *       * 缺省 / 'append'：插到 surface 末尾；
 *       * {op:'replace', startSeq, endSeq}：用新事件 seq 替换 surface 上 [startSeq..endSeq] 这段，
 *         并递增 surface.replaceGeneration（与 DSH 替换事务的观测面一致）；
 *   - `appendPluginRecord(type, data)`：append + ignorable:true，返回 seq（不进模型可见 surface）；
 *   - 故障注入：构造时传 `failAppendOn`（1-based 的 append 序号，可传 number / number[] / 判定函数）
 *     让第 N 次 append 抛错，且**日志与 surface 保持原样**（原子失败，便于测事务的失败路径）。
 *
 * 这个 fake 的语义由 `test/contract.mjs` 表驱动锁定；它只覆盖 node 测试用到的公开 API，
 * e2e（真实 DSH）负责兜底 fake 与真机之间的剩余距离。
 */

const MESSAGE_TYPES = new Set(['system/message', 'user/message', 'assistant/message']);
const DERIVABLE_TYPES = new Set([...MESSAGE_TYPES, 'tool/result']);

function appendFaultAt(failAppendOn, callIndex) {
  if (failAppendOn === undefined || failAppendOn === null) return false;
  if (typeof failAppendOn === 'function') return failAppendOn(callIndex) === true;
  if (Array.isArray(failAppendOn)) return failAppendOn.includes(callIndex);
  return failAppendOn === callIndex;
}

function faultError(failAppendError, callIndex, type) {
  if (typeof failAppendError === 'function') return failAppendError(callIndex);
  if (failAppendError instanceof Error) return failAppendError;
  if (typeof failAppendError === 'string') return new Error(failAppendError);
  return new Error(`模拟 append 失败（第 ${callIndex} 次：${type}）`);
}

/** count 从 1 开始；返回 injection 句柄，可用于契约测试里显式检查计数。 */
export class MockSession {
  constructor({ id = 'mock-session', cwd = '/tmp/relay-test-ws', agentPreset = 'preset-x', header, events = [], failAppendOn, failAppendError } = {}) {
    this.id = id;
    // handoff 的 M6 现场快照依赖 header.cwd；传 undefined 表示「这个会话没有该字段」。
    // 0.5.1 DCR-02：老链兜底要读宿主会话头的血缘字段（parentSession / isSeeded / origin），
    // 夹具用 `header` 显式补（和 DSH 的 SessionHeader 同名字段）。
    this.header = {
      ...(cwd === undefined ? {} : { cwd }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
      ...(header === null || typeof header !== 'object' ? {} : header),
    };
    this.log = [];
    this.surface = { nodes: [], replaceGeneration: 0 };
    /** 所有 append（含 appendPluginRecord）的累计序号，从 1 开始。 */
    this.appendCalls = 0;
    this.failAppendOn = failAppendOn;
    this.failAppendError = failAppendError;
    if (events.length > 0) this.seed(events);
  }

  /** 批量写入历史事件；显式传入的 seq 生效（夹具可以造非连续 seq）。 */
  seed(events) {
    for (const event of events) {
      const entry = { seq: this.log.length, time: Date.now(), ...event };
      this.log.push(entry);
      if (MESSAGE_TYPES.has(entry.type)) this.surface.nodes.push(entry.seq);
    }
    return this;
  }

  append(type, data, opts = {}) {
    this.appendCalls += 1;
    if (appendFaultAt(this.failAppendOn, this.appendCalls)) {
      throw faultError(this.failAppendError, this.appendCalls, type);
    }

    // 先校验再写入：失败必须原子（日志/surface 都不能留半截），真实 Session 也不会接受坏 surfaceOp。
    const isMessage = MESSAGE_TYPES.has(type);
    const surfaceOp = opts.surfaceOp;
    let replaceSpan = null;
    if (isMessage && surfaceOp !== undefined && surfaceOp !== 'append' && surfaceOp?.op === 'replace') {
      const nodes = this.surface.nodes;
      const startIdx = nodes.indexOf(surfaceOp.startSeq);
      const endIdx = nodes.indexOf(surfaceOp.endSeq);
      if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
        throw new Error(
          `mock session: surfaceOp replace 的范围不在 surface 上（${surfaceOp.startSeq}..${surfaceOp.endSeq}）`,
        );
      }
      replaceSpan = { startIdx, endIdx };
    }

    const event = {
      type,
      seq: this.log.length,
      time: Date.now(),
      data,
      ...(opts.ignorable === true ? { ignorable: true } : {}),
      ...(surfaceOp === undefined ? {} : { surfaceOp }),
      ...(opts.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: opts.sourceEventSeqs }),
    };
    this.log.push(event);

    if (isMessage) {
      if (replaceSpan !== null) {
        this.surface.nodes.splice(replaceSpan.startIdx, replaceSpan.endIdx - replaceSpan.startIdx + 1, event.seq);
        this.surface.replaceGeneration += 1;
      } else {
        this.surface.nodes.push(event.seq);
      }
    }
    return event;
  }

  eventAt(seq) {
    return this.log[seq];
  }

  appendPluginRecord(type, data) {
    return this.append(type, data, { ignorable: true }).seq;
  }

  snapshotEvents() {
    return this.log.slice();
  }

  requestHeader() {
    return { config: { provider: 'mock', model: 'mock-model', reasoningEffort: 'max' } };
  }

  toolHistory() {
    return [];
  }

  /** 与 DSH Session 同形：非模型可见事件返回 null（prefix 回放只看消息）。 */
  deriveEventMessage(event) {
    if (event === null || typeof event !== 'object' || !DERIVABLE_TYPES.has(event.type)) return null;
    return { role: 'user', content: [{ type: 'text', text: `event-${event.seq}` }] };
  }

  get seq() {
    return this.log.length;
  }
}

export function createSession(options) {
  return new MockSession(options);
}

/** 与 handoff 测试初始夹具同形的四条空消息（system + user + assistant + user）。 */
export function seedBaseMessages(session) {
  return session.seed([
    { type: 'system/message', data: { message: { role: 'system', content: [] } } },
    { type: 'user/message', data: { message: { role: 'user', content: [] } } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [] } } },
    { type: 'user/message', data: { message: { role: 'user', content: [] } } },
  ]);
}

/** surface = [0,1,2,3]，id 用 mock-session（smoke 的纯 core 夹具）。 */
export function baseSession(options = {}) {
  return seedBaseMessages(new MockSession(options));
}

/** 交接流程夹具：source-session / 临时工作区 / preset-x。 */
export function baseSourceSession(options = {}) {
  return seedBaseMessages(
    new MockSession({ id: 'source-session', cwd: '/tmp/relay-test-ws', agentPreset: 'preset-x', ...options }),
  );
}
