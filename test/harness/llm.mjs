/**
 * 统一确定性 fake LLM —— 三套 node 测试共用。
 *
 * 只实现插件实际消费的两个公共 API：
 *   - `ctx.llm.stream({messages, maxTokens, reasoningEffort, ...})` → AsyncIterable<chunk>
 *     （chunk 形状与 DSH 一致：text-delta / finish / usage）；
 *   - `ctx.llm.resolveModelInfo(model)` → {context:{contextWindow}, reasoning?}。
 *
 * 可控点：
 *   - routes：按「最后一条消息里的指令文本」分流（摘要 / 交接单 / 其它），每条 route 有
 *     有序 reply 脚本（多个时按次消耗、最后一条复用——与旧测试手写行为一致）；
 *   - route.stream：接管该 route 的流（用于「卡住直到 abort」的取消/超时用例）；
 *   - truncateFirst：该 route 第一次调用返回半截 + finish reason=max-tokens（测截断重试）；
 *   - 所有调用按发生顺序记进 `llm.calls`，字段与旧手搓 record.llmCalls 相同
 *     （kind/messages/maxTokens/reasoningEffort），不额外引入断言面。
 */

/** 单块文本流；finish 传 'max-tokens' 等会补一条 finish chunk。 */
export function textStream(text, finish) {
  return (async function* textChunks() {
    yield { type: 'text-delta', index: 0, text };
    if (finish !== undefined) yield { type: 'finish', reason: { kind: finish } };
  })();
}

/** 按给定 chunk 序列回放（想精确控制多块/usage 时用）。 */
export function chunkStream(chunks) {
  return (async function* givenChunks() {
    for (const chunk of chunks) yield chunk;
  })();
}

/**
 * 「卡住直到被 abort」的流工厂 —— 取消/超时用例共用。
 * 返回的函数可直接赋给 `ctx.llm.stream` 或 `route.stream`。
 * 语义与旧测试一致：没有 signal 时直接结束（不产出任何块）。
 */
export function createStuckStream({ onStart, text = '不该走到这里' } = {}) {
  return function stuckStream(options = {}) {
    return (async function* stuckChunks() {
      if (typeof onStart === 'function') onStart();
      const signal = options.signal;
      if (signal === undefined) return;
      await new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason ?? new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
      yield { type: 'text-delta', index: 0, text };
    })();
  };
}

function instructionOf(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : [];
  const last = messages[messages.length - 1];
  const content = Array.isArray(last?.content) ? last.content : [];
  return content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n');
}

function replyStream(reply) {
  if (typeof reply === 'function') return reply();
  if (typeof reply === 'string') return textStream(reply);
  if (reply !== null && typeof reply === 'object') {
    if (Array.isArray(reply.chunks)) return chunkStream(reply.chunks);
    return textStream(reply.text ?? '', reply.finish);
  }
  throw new Error('fake llm: reply 必须是 string / {text,finish} / {chunks} / function');
}

/**
 * @param {object} [options]
 * @param {Array<object>} [options.routes] 顺序匹配；route = {kind, match({instruction, options}), replies?, stream?, truncateFirst?, truncated?}
 * @param {number} [options.contextWindow]
 * @param {boolean} [options.reasoningSupport] true 时 resolveModelInfo 带 reasoning.efforts（含 off）
 * @param {object} [options.modelInfo] 直接指定 resolveModelInfo 返回值（优先于 contextWindow/reasoningSupport）
 * @returns {{stream: Function, resolveModelInfo: Function, calls: object[], routes: object[], callsOf: Function}}
 */
export function createFakeLlm({ routes = [], contextWindow = 1_000_000, reasoningSupport = true, modelInfo } = {}) {
  const calls = [];
  // 复制 route 与 reply 数组，避免多个用例共享同一份可变夹具。
  const states = routes.map((route) => ({
    ...route,
    replies: Array.isArray(route.replies) ? [...route.replies] : [],
    calls: 0,
  }));
  const info =
    modelInfo ??
    (reasoningSupport
      ? {
          context: { contextWindow },
          reasoning: { efforts: [{ id: 'off' }, { id: 'high' }], defaultEffort: 'high' },
        }
      : { context: { contextWindow } });

  async function resolveModelInfo() {
    return info;
  }

  function stream(options = {}) {
    const instruction = instructionOf(options);
    const route = states.find((candidate) =>
      typeof candidate.match === 'function' ? candidate.match({ instruction, options }) === true : true,
    );
    if (route === undefined) {
      throw new Error(`fake llm: 没有匹配的 route（instruction=${JSON.stringify(instruction.slice(0, 80))}）`);
    }
    route.calls += 1;
    calls.push({
      kind: route.kind,
      messages: options.messages,
      maxTokens: options.maxTokens,
      reasoningEffort: options.reasoningEffort,
    });

    if (typeof route.stream === 'function') {
      return route.stream(options, { call: calls[calls.length - 1], callIndex: route.calls, instruction });
    }
    if (route.truncateFirst === true && route.calls === 1) {
      const truncated = typeof route.truncated === 'function' ? route.truncated() : route.truncated;
      // 截断的默认语义 = 输出到了 maxTokens 上限：只有文本时补一条 finish reason。
      if (typeof truncated === 'string') return textStream(truncated, 'max-tokens');
      return replyStream(truncated ?? '');
    }
    if (route.replies.length === 0) {
      throw new Error(`fake llm: route「${route.kind}」没有配置 reply`);
    }
    // 多个 reply 时按次消耗，剩最后一条后复用（= 旧测试手写的 shift 语义）。
    const reply = route.replies.length > 1 ? route.replies.shift() : route.replies[0];
    return replyStream(reply);
  }

  return {
    stream,
    resolveModelInfo,
    calls,
    routes: states,
    callsOf(kind) {
      return calls.filter((call) => call.kind === kind);
    },
  };
}
