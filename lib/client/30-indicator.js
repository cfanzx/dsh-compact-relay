     */
    function CompactRelayIndicator(props) {
      const { sessionId, waitAndOpen } = props;
      const hasSession = typeof sessionId === 'string' && sessionId.length > 0;
      const [state, setState] = useState({
        advice: 'none',
        pressure: null,
        window: null,
        summaries: 0,
        colors: null,
        compactRange: undefined,
        busy: false,
        // 0.5.1 批 2：stale = 被压缩带走的 pin（失效标注）；atRisk = 下一次原生压缩会覆盖的 pin。
        pins: { count: 0, seqs: [], marks: [], stale: { count: 0, seqs: [], native: 0, other: 0, unknown: 0 }, atRisk: null },
        compressHint: null,
        native: null,
        sessionPinned: null,
      });
      // 0.4 P2-3：原生自动压缩的「有效线」——优先真实触发线（thresholdTokens/window），
      // 老宿主/算不出时回落 thresholdRatio（窗口比例）。
      const effectiveNativeRatio = (native) => {
        if (native === null || native === undefined || native.autoEnabled === false) return null;
        if (typeof native.ratio === 'number' && Number.isFinite(native.ratio) && native.ratio > 0 && native.ratio < 1) return native.ratio;
        if (typeof native.thresholdRatio === 'number' && Number.isFinite(native.thresholdRatio) && native.thresholdRatio > 0) return native.thresholdRatio;
        return null;
      };
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      const [hover, setHover] = useState(false);
      // 0.3.1：首次使用引导（只出现一次）+ 指示灯脉冲，解决「根本不知道那有个按钮」。
      const [onboarding, setOnboarding] = useState(false);
      const [pulseOn, setPulseOn] = useState(false);
      const [onboardingPulseMs, setOnboardingPulseMs] = useState(4800);
      // 悬停卡/菜单/提示的锚点（fixed 定位，躲开 composer 的 overflow 裁剪）。
      const [anchor, setAnchor] = useState(null);
      const theme = useAutoTheme();
      const [toast, setToast] = useState(null);
      // M6：压缩确认卡（先预览、再确认）与执行中取消。
      const [preview, setPreview] = useState(null);
      const previewRef = useRef(null);
      const previewAbortRef = useRef(null);
      const runAbortRef = useRef(null);
      // M6：交接单列表（菜单入口，只读）。
      const [docs, setDocs] = useState(null);
      const docsRef = useRef(null);
      const rootRef = useRef(null);
      const toastRef = useRef(null);
      // P2-A2：焦点管理（打开弹出层先进第一个可操作项，Esc/点外关闭后回到指示灯）。
      const triggerRef = useRef(null);
      const menuRef = useRef(null);
      // P2-C3/C4：交接单详情的请求序号与 AbortController（防乱序/防关闭后被撑开）。
      const docsRequestRef = useRef(0);
      const docsAbortRef = useRef(null);
      // A6：压缩历史面板（菜单入口，只读）。
      const [diff, setDiff] = useState(null);
      const diffRef = useRef(null);
      const diffAbortRef = useRef(null);
      const diffRequestRef = useRef(0);
      const closeDocs = useCallback(() => {
        docsRequestRef.current += 1;
        if (docsAbortRef.current !== null) {
          try {
            docsAbortRef.current.abort();
          } catch {
            /* ignore */
          }
          docsAbortRef.current = null;
        }
        setDocs(null);
      }, []);

      const closeDiff = useCallback(() => {
        diffRequestRef.current += 1;
        if (diffAbortRef.current !== null) {
          try {
            diffAbortRef.current.abort();
          } catch {
            /* ignore */
          }
          diffAbortRef.current = null;
        }
        setDiff(null);
      }, []);
      // A1b：交接预览（九段草稿 + 就绪清单），只读不落盘。
      const [handoffPreview, setHandoffPreview] = useState(null);
      /** 0.4 P2-1：交接预览里「约束 / 下一步」两段的编辑值（键=段标题；空值回落原文）。 */
      const [handoffEditValues, setHandoffEditValues] = useState({});
      // 0.5.1 批 2：交接后是否归档旧会话（默认开 = 0.5.0 行为；可取消）。
      const [archiveWanted, setArchiveWanted] = useState(true);
      const handoffPreviewRef = useRef(null);
      const handoffPreviewAbortRef = useRef(null);
      const closeHandoffPreview = useCallback(() => {
        if (handoffPreviewAbortRef.current !== null) {
          try {
            handoffPreviewAbortRef.current.abort();
          } catch {
            /* ignore */
          }
          handoffPreviewAbortRef.current = null;
        }
        setHandoffPreview(null);
      }, []);
	
      const rememberAnchor = useCallback((el) => {
        if (el === null || el === undefined) return;
        const rect = el.getBoundingClientRect();
        setAnchor({
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
        });
      }, []);
      // 滚动/缩放时锚点会漂，重算一次。
      useEffect(() => {
        if (!hover && !open && toast === null) return undefined;
        const update = () => {
          const el = rootRef.current;
          if (el !== null && el !== undefined) rememberAnchor(el.firstElementChild ?? el);
        };
        update();
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        return () => {
          window.removeEventListener('scroll', update, true);
          window.removeEventListener('resize', update);
        };
      }, [hover, open, toast, rememberAnchor]);

      // toast 宽度是 max-content，渲染前估不准：渲染后量一次，超出视口就把 left 收回来。
      useEffect(() => {
        if (toast === null) return;
        const el = toastRef.current;
        if (el === null) return;
        const margin = 8;
        const rect = el.getBoundingClientRect();
        let left = rect.left;
        if (rect.right > window.innerWidth - margin) left = window.innerWidth - margin - rect.width;
        if (left < margin) left = margin;
        if (left !== rect.left) el.style.left = `${Math.round(left)}px`;
      }, [toast, anchor]);

      const url =
        typeof sessionId === 'string' && sessionId.length > 0
          ? `/api/compact-relay-state?sessionId=${encodeURIComponent(sessionId)}`
          : '/api/compact-relay-state';

      const applierRef = useRef(() => {});
      // 0.3.7：最后一帧（SSE 帧或轮询响应）的到达时间。远程/代理链路可能让 SSE
      // 「onopen 已连上、之后却一帧都不来」地静默挂住，表现为压缩后界面不刷新
      // （Win 远程客户端实测：手动刷新才变）。帧静默超时后由兜底轮询补拉。
      const lastFrameAtRef = useRef(0);
      const fetchState = useCallback(async () => {
        if (!hasSession) return;
          try {
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            if (data && typeof data === 'object') {
              lastFrameAtRef.current = Date.now();
              applierRef.current(data);
            }
          } catch {
            /* host 不在就保持上一次状态 */
          }
      }, [url, hasSession]);

      // 状态应用函数（轮询与 SSE 共用同一份映射）。
      const readyRef = useRef(false);
      // P3-12：轮询响应与 SSE 帧都可能晚到；host 每帧带单调 revision，只接受更新的帧。
      // 旧 host（没有 revision）保持原行为，不因为拿不到号就丢帧。
      const lastRevisionRef = useRef(-1);
      const applyState = useCallback((data) => {
        if (data === null || typeof data !== 'object') return;
        if (data.ok === false) return;
        const revision = Number.isInteger(data.revision) ? data.revision : null;
        if (revision !== null) {
          if (revision <= lastRevisionRef.current) return;
          lastRevisionRef.current = revision;
        }
        readyRef.current = typeof data.sessionId === 'string' && data.sessionId.length > 0;
        setState({
          sessionId: typeof data.sessionId === 'string' && data.sessionId.length > 0 ? data.sessionId : null,
          level: typeof data.level === 'string' && data.level.length > 0 ? data.level : null,
          advice: data.advice || 'none',
          pressure: data.pressure ?? null,
          window: data.window ?? 1_000_000,
          summaries: data.summaries ?? 0,
          busy: data.busy === true,
          thresholds: data.thresholds && typeof data.thresholds === 'object' ? data.thresholds : null,
          pins:
            data.pins && typeof data.pins === 'object'
              ? {
                  count: Number(data.pins.count) || 0,
                  seqs: Array.isArray(data.pins.seqs) ? data.pins.seqs.filter((seq) => Number.isInteger(seq)) : [],
                  // 0.3.1 起下发、0.5.1 起环上不再画：锁定消息在历史里的相对位置（0–1）。
                  // 位置标记归 0.6 时间线（数据面保留，0.6 的 timeline 直接消费）。
                  marks: Array.isArray(data.pins.marks)
                    ? data.pins.marks
                        .filter((item) => item !== null && typeof item === 'object' && typeof item.ratio === 'number' && Number.isFinite(item.ratio))
                        .map((item) => ({ seq: Number.isInteger(item.seq) ? item.seq : -1, ratio: Math.max(0, Math.min(1, item.ratio)) }))
                        .slice(0, 20)
                    : [],
                  // 0.5.1 批 2（C 方案）：被压缩带走、已不在 surface 上的 pin（不假装还在，也不消失）。
                  stale:
                    data.pins.stale && typeof data.pins.stale === 'object'
                      ? {
                          count: Number(data.pins.stale.count) || 0,
                          seqs: Array.isArray(data.pins.stale.seqs) ? data.pins.stale.seqs.filter((seq) => Number.isInteger(seq)) : [],
                          native: Number(data.pins.stale.native) || 0,
                          other: Number(data.pins.stale.other) || 0,
                          unknown: Number(data.pins.stale.unknown) || 0,
                        }
                      : { count: 0, seqs: [], native: 0, other: 0, unknown: 0 },
                  // 0.5.1 批 2：原生压缩预判会覆盖的 pin（事前提示；null = 无风险）。
                  atRisk:
                    data.pins.atRisk && typeof data.pins.atRisk === 'object' && Number(data.pins.atRisk.count) > 0
                      ? {
                          count: Number(data.pins.atRisk.count) || 0,
                          seqs: Array.isArray(data.pins.atRisk.seqs) ? data.pins.atRisk.seqs.filter((seq) => Number.isInteger(seq)) : [],
                        }
                      : null,
                }
              : { count: 0, seqs: [], marks: [], stale: { count: 0, seqs: [], native: 0, other: 0, unknown: 0 }, atRisk: null },
          // 0.3.1：模型判断的「这里适合压缩」位置（0–1）；没有或已失效为 null。
          compressHint:
            data.compressHint && typeof data.compressHint === 'object' && typeof data.compressHint.ratio === 'number' && Number.isFinite(data.compressHint.ratio)
              ? { ratio: Math.max(0, Math.min(1, data.compressHint.ratio)), at: typeof data.compressHint.at === 'number' ? data.compressHint.at : 0 }
              : null,
          // 0.3.1：DSH 原生自动压缩配置（环上的报警最高阈值 / 引导文案 / 设置页）。
          native:
            data.native && typeof data.native === 'object'
              ? {
                  autoEnabled: data.native.autoEnabled !== false,
                  thresholdRatio:
                    typeof data.native.thresholdRatio === 'number' && Number.isFinite(data.native.thresholdRatio)
                      ? Math.max(0, Math.min(1, data.native.thresholdRatio))
                      : 0.8,
                  // 0.4 P2-3：真实触发线（thresholdTokens/window）；宿主算不出时为 null。
                  ratio:
                    typeof data.native.ratio === 'number' && Number.isFinite(data.native.ratio)
                      ? Math.max(0, Math.min(1, data.native.ratio))
                      : null,
                  thresholdTokens:
                    typeof data.native.thresholdTokens === 'number' && Number.isFinite(data.native.thresholdTokens)
                      ? data.native.thresholdTokens
                      : null,
                  contextWindow:
                    typeof data.native.contextWindow === 'number' && Number.isFinite(data.native.contextWindow)
                      ? data.native.contextWindow
                      : null,
                  headroomTokens:
                    typeof data.native.headroomTokens === 'number' && Number.isFinite(data.native.headroomTokens)
                      ? data.native.headroomTokens
                      : null,
                  // 0.4.1：悬停卡解释「为什么实际触发比配置阈值早」要用到输出预留。
                  reservedCompletionTokens:
                    typeof data.native.reservedCompletionTokens === 'number' && Number.isFinite(data.native.reservedCompletionTokens)
                      ? data.native.reservedCompletionTokens
                      : null,
                  overridden: data.native.overridden === true,
                  route:
                    data.native.route && typeof data.native.route === 'object' && typeof data.native.route.model === 'string'
                      ? { provider: String(data.native.route.provider ?? ''), model: data.native.route.model }
                      : null,
                }
              : null,
          colors: data.colors && typeof data.colors === 'object' ? data.colors : null,
          // undefined=宿主没给（未知，保留可点）；null=明确没有可压范围；object=可压多少。
          compactRange:
            data.compactRange === undefined
              ? undefined
              : data.compactRange === null
                ? null
                : {
                    nodes: Number(data.compactRange.nodes) || 0,
                    tokens: Number(data.compactRange.tokens) || 0,
                    startSeq: data.compactRange.startSeq ?? null,
                    endSeq: data.compactRange.endSeq ?? null,
                  },
          // 0.3.5：范围存在但会话没有活 agent —— 菜单据此显示「会话未激活…」而不是
          // 「暂无可压缩内容」（applyState 只保留白名单字段，新字段必须显式透传）。
          compactRangeReason: data.compactRangeReason === 'no_agent' ? 'no_agent' : null,
          // 0.5.1 批 2：本会话是否在侧栏置顶（true/false/null=宿主读不到）。
          sessionPinned: data.sessionPinned === true ? true : data.sessionPinned === false ? false : null,
        });
      }, []);

      applierRef.current = applyState;

      // M5 实时推送：EventSource 订阅 `/api/compact-relay-stream`。
      // 后端在每条会话事件后去抖推一次状态；连不上就自动退回轮询。
      const [streamLive, setStreamLive] = useState(false);
      const streamLiveRef = useRef(false);
      useEffect(() => {
        if (!hasSession || typeof EventSource !== 'function') return;
        const streamUrl = url.replace('/api/compact-relay-state', '/api/compact-relay-stream');
        let source;
        try {
          source = new EventSource(streamUrl);
        } catch {
          return;
        }
        let dead = false;
        source.onopen = () => {
          if (dead) return;
          streamLiveRef.current = true;
          setStreamLive(true);
          lastFrameAtRef.current = Date.now();
          // 0.3.7：刚连上先拉一次，补齐「断开期间错过的帧」（重连场景）。
          void fetchState();
        };
        source.onmessage = (event) => {
          lastFrameAtRef.current = Date.now();
          try {
            applyState(JSON.parse(event.data));
          } catch {
            /* 坏帧忽略，下一帧再来 */
          }
        };
        source.onerror = () => {
          if (dead) return;
          streamLiveRef.current = false;
          setStreamLive(false);
          try {
            source.close();
          } catch {
            /* ignore */
          }
        };
        return () => {
          dead = true;
          streamLiveRef.current = false;
          setStreamLive(false);
          try {
            source.close();
          } catch {
            /* ignore */
          }
        };
      }, [url, applyState, hasSession]);

      // 兜底轮询：
      //  - 还没就绪（会话刚打开 / 没有 agent）→ 1.5s 快轮询（修「重启后停在上下文未知」）；
      //  - 已就绪但 SSE 没连上 → 5s 轮询兜底；
      //  - 已就绪且 SSE 活着 → 5s 计时器只检查「帧是否静默超时」；
      //  - 0.3.7：SSE 活着但 30s 没来帧（远程/代理链路静默挂住）→ 补拉一次，
      //    修「压缩后远程客户端不刷新、要手动刷新才变」。
      useEffect(() => {
        if (!hasSession) return;
        let timer;
        let dead = false;
        const tick = () => {
          if (dead) return;
          const sseSilent = streamLiveRef.current && Date.now() - lastFrameAtRef.current > 30000;
          if (!readyRef.current || !streamLiveRef.current || sseSilent) void fetchState();
          timer = setTimeout(tick, readyRef.current ? 5000 : 1500);
        };
        tick();
        return () => {
          dead = true;
          clearTimeout(timer);
        };
      }, [fetchState, hasSession]);

      // 0.3.7：窗口重新可见 / 重新获得焦点 / 网络恢复时拉一次——覆盖「页面被挂起后
      // 计时器被节流、SSE 断流」的场景（远程客户端切走再切回来也会走到这里）。
      useEffect(() => {
        if (!hasSession) return;
        const refresh = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          void fetchState();
        };
        document.addEventListener('visibilitychange', refresh);
        window.addEventListener('focus', refresh);
        window.addEventListener('online', refresh);
        return () => {
          document.removeEventListener('visibilitychange', refresh);
          window.removeEventListener('focus', refresh);
          window.removeEventListener('online', refresh);
        };
      }, [fetchState, hasSession]);


      // 点外面 / Esc 关闭菜单、压缩确认卡与交接单面板。
      useEffect(() => {
        if (!open && preview === null && docs === null && diff === null && handoffPreview === null) return;
        const inside = (target) => {
          const inRoot = rootRef.current !== null && rootRef.current.contains(target);
          const inPreview = previewRef.current !== null && previewRef.current.contains(target);
          const inDocs = docsRef.current !== null && docsRef.current.contains(target);
          const inDiff = diffRef.current !== null && diffRef.current.contains(target);
          const inHandoff = handoffPreviewRef.current !== null && handoffPreviewRef.current.contains(target);
          return inRoot || inPreview || inDocs || inDiff || inHandoff;
        };
        const onDown = (e) => {
          if (inside(e.target)) return;
          setOpen(false);
          setPreview(null);
          closeDocs();
          closeDiff();
          closeHandoffPreview();
          window.setTimeout(() => triggerRef.current?.focus?.(), 0);
        };
        const onKey = (e) => {
          if (e.key !== 'Escape') return;
          setOpen(false);
          setPreview(null);
          closeDocs();
          closeDiff();
          closeHandoffPreview();
          window.setTimeout(() => triggerRef.current?.focus?.(), 0);
          if (previewAbortRef.current !== null) {
            try {
              previewAbortRef.current.abort();
            } catch {
              /* ignore */
            }
            previewAbortRef.current = null;
          }
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDown);
          document.removeEventListener('keydown', onKey);
        };
      }, [open, preview, docs, diff, handoffPreview, closeDocs, closeDiff, closeHandoffPreview]);

      // P2-A2：弹出层打开后把焦点送进第一个可操作按钮（键盘用户不用再 Tab 找）。
      useEffect(() => {
        const target = open
          ? menuRef.current
          : preview !== null
            ? previewRef.current
            : docs !== null
              ? docsRef.current
              : diff !== null
                ? diffRef.current
                : handoffPreview !== null
                  ? handoffPreviewRef.current
                  : null;
        if (target === null) return;
        const first = typeof target.querySelector === 'function' ? target.querySelector('button:not(:disabled)') : null;
        if (first !== null && typeof first.focus === 'function') first.focus();
      }, [open, preview, docs, diff, handoffPreview]);

      const adviseCompact = state.advice === 'compact';
      const adviseHandoff = state.advice === 'handoff';
      const pressureValue = state.pressure;
      const windowValue = state.window;
      const ratio = pressureValue && windowValue ? Math.min(1, pressureValue / windowValue) : 0;

      // M6：锁定集合（宿主下发的 count/seqs；默认空）。
      const pins = state.pins !== null && typeof state.pins === 'object' ? state.pins : { count: 0, seqs: [] };
      // 0.5.1 批 2（C 方案）：失效 pin（快照里有、surface 上已被压缩带走）与原生压缩预判风险。
      const pinStale =
        pins.stale !== null && typeof pins.stale === 'object'
          ? pins.stale
          : { count: 0, seqs: [], native: 0, other: 0, unknown: 0 };
      const pinStaleCount = Number.isInteger(pinStale.count) && pinStale.count > 0 ? pinStale.count : 0;
      // 失效原因口径与 core/pin-health.staleCauseTextOf 一致（客户端只拿计数，不重读日志）。
      const staleCauseText =
        pinStale.native > 0 && pinStale.other === 0 && pinStale.unknown === 0
          ? '随原生压缩移除'
          : pinStale.native === 0 && pinStale.other > 0 && pinStale.unknown === 0
            ? '随压缩移除'
            : pinStale.native === 0 && pinStale.other === 0 && pinStale.unknown > 0
              ? '随历史变化失效'
              : '随压缩或历史变化失效';
      const staleLabel = pinStaleCount > 0 ? `已失效 ${pinStaleCount} 条（${staleCauseText}）` : '';
      const pinRisk =
        pins.atRisk !== null && typeof pins.atRisk === 'object' && Number(pins.atRisk.count) > 0
          ? { count: Number(pins.atRisk.count) || 0, seqs: Array.isArray(pins.atRisk.seqs) ? pins.atRisk.seqs : [] }
          : null;
      const pinRiskLabel = pinRisk !== null ? `原生压缩预计覆盖 ${pinRisk.count} 条锁定消息` : '';
      // 0.5.1 批 2：交接前「归档会取消置顶」确认的数据源（null=宿主读不到，不弹确认）。
      const sessionPinned = state.sessionPinned === true;
      // 0.3.1：阶段标记功能已删（作者拍板），ring level 只看建议。
      const level = typeof state.level === 'string' ? state.level : adviseHandoff ? 'handoff' : adviseCompact ? 'compact' : 'idle';

      // 颜色：host 下发 3 个基准色 + 自动适配开关；这里按当前界面明暗派生两套，
      // 保证同一套基准色在浅色/深色界面都看得清（设置里也可强制模式）。
      const palette = resolvePalette(state.colors, theme.dark);

      // 0.3.1：环不再整体变色，而是按「容量区间」分段上色 + 断点（规则见 core/ring.js）。
      // 正常区 0→压缩线：没走满灰、走满蓝；压缩区→琥珀；交接区→红；断点=区间交界的小缺口。
      const compactAt = state.thresholds !== null && typeof state.thresholds === 'object' ? state.thresholds.compactAt : null;
      const compactRatio =
        state.thresholds !== null && typeof state.thresholds === 'object' && typeof state.thresholds.compactRatio === 'number'
          ? state.thresholds.compactRatio
          : typeof compactAt === 'number' && typeof windowValue === 'number' && windowValue > 0
            ? compactAt / windowValue
            : 0.4;
      const handoffRatio =
        state.thresholds !== null && typeof state.thresholds === 'object' && typeof state.thresholds.handoffRatio === 'number'
          ? state.thresholds.handoffRatio
          : 0.6;
      // 0.3.1：模型判断的「这里适合压缩」位置 → 断点1（优先于阈值）；失效的 hint 由 host 过滤。
      const hintRatio = state.compressHint && typeof state.compressHint.ratio === 'number' ? state.compressHint.ratio : null;
      const ring = ringSegments(ratio, compactRatio, handoffRatio, hintRatio);
      /**
       * 0.4.2（P0-1）：交接线是否已晚 —— 硬上限 = 实际触发线 −5pp（与后台 save() 同一份判定）。
       * 只在宿主算出实际触发线（native.ratio）且原生自动压缩开启时判定；
       * 算不出时按范围定稿「不告警、不阻断」。
       */
      const handoffGuardInfo = handoffGuard({
        actualRatio: state.native === null ? null : state.native.ratio,
        configuredRatio: state.native === null ? null : state.native.thresholdRatio,
        handoffRatio,
        compactRatio,
        autoEnabled: state.native === null ? true : state.native.autoEnabled !== false,
      });
      const handoffLate = handoffGuardInfo.source === 'actual' && handoffGuardInfo.ok === false;
      const handoffWarnText = handoffLate
        ? `⚠ 交接线已晚：实际触发 ${handoffGuardInfo.actualPercent}%，交接线 ${handoffGuardInfo.handoffPercent}% 会在原生压缩之后（最高 ${handoffGuardInfo.capPercent}%）`
        : '';
      // DSH 原生自动压缩线（报警最高阈值）：开着时在环上画一个「径向刻度」（不是沿环的弧），
      // 用紫色 + 主题底色描边——刻意不用五级配色里的颜色，保证在任何分段颜色上都看得清。
      // 越过原生线后：整环红色闪烁（作者 2026-10-20 反馈）。
      const nativeAuto = effectiveNativeRatio(state.native);
      const nativeValid = nativeAuto !== null && nativeAuto > 0.02 && nativeAuto < 1;
      const nativeCrossed = nativeValid && ratio > nativeAuto;
      // 断点缺口：0.9 SVG 单位（≈6.4°），折算成比例；段太短时缺口会吃掉整段，就跳过该段。
      const ringGapRatio = 0.9 / CIRC;
      // 点坐标/弧线 path 是共享几何（15-shared.js 的 ringPoint / ringArcPath）。
      const ringNodes = ring.segments
        .map((segment, index) => {
          const trimmed = trimSegment(segment, ringGapRatio, ring.ratio);
          if (trimmed.to - trimmed.from <= 0.001) return null;
          return h('path', {
            key: `ring-${index}`,
            d: ringArcPath(trimmed.from, trimmed.to),
            fill: 'none',
            stroke: palette[segment.color],
            strokeWidth: 2,
            strokeLinecap: 'round',
            'data-cr-seg': segment.color,
            style: { transition: 'stroke 200ms ease' },
          });
        })
        .filter((node) => node !== null);
      // DSH 原生自动压缩线：径向紫色刻度 + 越过线后整环红色闪烁。
      // 刻度用一条「穿过环带」的短线（内 5.6 → 外 9.6）+ 一圈主题底色描边，避免和红色分段糊在一起。
      const nativeNodes = [];
      if (nativeValid) {
        const tick = nativeTickAt(nativeAuto);
        // 越过原生压缩线：整环红色闪烁（1s 呼吸）；prefers-reduced-motion 下改为常亮红色（不闪）。
        if (nativeCrossed) {
          nativeNodes.push(
            h('style', { key: 'native-alert-style' }, NATIVE_ALERT_CSS),
            h('circle', {
              key: 'native-alert',
              cx: 10,
              cy: 10,
              r: RADIUS,
              fill: 'none',
              stroke: palette.handoff,
              strokeWidth: 2.6,
              strokeLinecap: 'round',
              style: { animation: 'cr-native-alert 1s ease-in-out infinite' },
              'data-cr-native-alert': '1',
            }),
          );
        }
        nativeNodes.push(
          h('line', {
            key: 'native-tick-casing',
            ...tick,
            stroke: theme.dark ? '#26262c' : '#ffffff',
            strokeWidth: 4.2,
            strokeLinecap: 'round',
            opacity: 0.92,
          }),
          h('line', {
            key: 'native-tick',
            ...tick,
            stroke: NATIVE_LINE_COLOR,
            strokeWidth: 2.2,
            strokeLinecap: 'round',
            'data-cr-native-line': String(nativeAuto),
          }),
        );
      }
      // 0.4.2（P1）：交接线已晚时，在环上「交接刻度」旁加一个小警示（径向短线 + 小点）。
      // 只加节点，不改环的分段/断点逻辑（范围定稿：A/B/C 画法不并进 0.4.2）。
      const handoffWarnNodes = [];
      if (handoffLate) {
        const tick = nativeTickAt(handoffRatio); // 复用同一套径向几何，位置换成交接线
        const warnAngle = handoffRatio * Math.PI * 2 - Math.PI / 2;
        handoffWarnNodes.push(
          h('line', {
            key: 'handoff-warn-casing',
            ...tick,
            stroke: theme.dark ? '#26262c' : '#ffffff',
            strokeWidth: 4.4,
            strokeLinecap: 'round',
            opacity: 0.92,
          }),
          h('line', {
            key: 'handoff-warn',
            ...tick,
            stroke: palette.handoff,
            strokeWidth: 2.2,
            strokeLinecap: 'round',
            'data-cr-handoff-warn': '1',
          }),
          h('circle', {
            key: 'handoff-warn-dot',
            cx: Number((10 + 9.4 * Math.cos(warnAngle)).toFixed(3)),
            cy: Number((10 + 9.4 * Math.sin(warnAngle)).toFixed(3)),
            r: 1.05,
            fill: palette.handoff,
            'data-cr-handoff-warn-dot': '1',
          }),
        );
      }
      // 平时给中心一点可见的灰点；交接时红点（外环已分段，红点强调该交接）。
      const dotColor = adviseHandoff ? palette.handoff : palette.idle;
      // 0.5.1 设计定稿（用户拍板）：环只表达容量，不再画 pin 位置块。
      // 位置标记（state.pins.marks）归 0.6 时间线：数据面仍读取（见上方状态归一化），
      // 环上不画；锁定状态只用悬停卡/菜单的「已锁定 N 条 / 已失效 M 条」表达。

      // 忙碌 = 本组件正在跑动作，或宿主侧锁已占用（另一个窗口在压/接）。
      const hostBusy = state.busy === true;
      const effectiveBusy = busy || hostBusy;

      // P2-C2：toast 只保留一个 timer；新提示先清旧 timer，按类型决定停留时长。
      const toastTimerRef = useRef(null);
      const toastSeqRef = useRef(0);
      const showToast = useCallback((value, ms = 6000) => {
        if (toastTimerRef.current !== null) {
          clearTimeout(toastTimerRef.current);
          toastTimerRef.current = null;
        }
        const seq = ++toastSeqRef.current;
        setToast(value);
        if (ms > 0) {
          toastTimerRef.current = setTimeout(() => {
            if (toastSeqRef.current === seq) {
              toastTimerRef.current = null;
              setToast(null);
            }
          }, ms);
        }
      }, []);
      useEffect(
        () => () => {
          if (toastTimerRef.current !== null) {
            clearTimeout(toastTimerRef.current);
            toastTimerRef.current = null;
          }
        },
        [],
      );

      // 0.3.1：首次使用引导——只在第一次打开会话时出现一次（localStorage 记住），
      // 配合指示灯呼吸光晕，解决「指示灯太安静、新用户不知道这里有个菜单」。
      // 设置页「再看一次初次引导」按钮通过 window 事件重播（两个组件同页，用事件解耦）。
      const onboardingText = useCallback(() => {
        const nativeRatio = effectiveNativeRatio(state.native);
        const nativePart =
          nativeRatio === null
            ? 'DSH 原生自动压缩已关闭'
            : `DSH 原生自动压缩线在 ${(nativeRatio * 100).toFixed(1)}%，到那之前先压缩或交接更稳`;
        return `这是上下文指示灯：点它压缩旧会话、收藏重要回复、交接新会话。${nativePart}。环上的小缺口是我判断「该压缩」的位置（模型判断或到线自动出现）。重要的结论/路径先点星收藏，压缩时会把原文写进摘要目录和快照（DSH 原生自动压缩不认收藏，被它压走的消息建议交接前留档）。交接后会默认自动归档旧会话（侧栏收起，可取消勾选「交接后归档」；旧会话在侧栏置顶时会先问你，因为归档会取消置顶）。`;
      }, [state.native]);

      /** 播放一次引导：呼吸光晕 + 提示。手动重播用更长时间（用户要关掉设置页才看得到）。 */
      const playOnboarding = useCallback(
        (options = {}) => {
          const pulseMs = typeof options.pulseMs === 'number' && options.pulseMs > 0 ? options.pulseMs : 4800;
          const toastMs = typeof options.toastMs === 'number' && options.toastMs > 0 ? options.toastMs : 15000;
          setPulseOn(false);
          setOnboarding(false);
          setOnboardingPulseMs(pulseMs);
          // 先复位再拉起：重复点击也能从头开始呼吸光晕。
          window.setTimeout(() => {
            setOnboarding(true);
            showToast(onboardingText(), toastMs);
          }, 30);
        },
        [onboardingText, showToast],
      );

      // 首次自动播放（localStorage 记住，只弹一次）。
      useEffect(() => {
        if (!hasSession) return undefined;
        let seen = true;
        try {
          seen = window.localStorage.getItem('compact-relay:onboarded') === '1';
        } catch {
          seen = true; // 隐私模式读不到 localStorage 就当看过，别每次弹
        }
        if (seen) return undefined;
        const timer = setTimeout(() => {
          try {
            window.localStorage.setItem('compact-relay:onboarded', '1');
          } catch {
            /* ignore */
          }
          playOnboarding();
        }, 1200);
        return () => clearTimeout(timer);
      }, [hasSession, playOnboarding]);

      // 设置页「再看一次初次引导」→ 重播（手动触发给更长时间：光晕 9s、提示 20s）。
      useEffect(() => {
        const onReplay = (event) => {
          const detail = event !== null && typeof event === 'object' && event.detail !== null && typeof event.detail === 'object' ? event.detail : {};
          playOnboarding({ pulseMs: 9000, toastMs: 20000, ...detail });
        };
        window.addEventListener('compact-relay:replay-onboarding', onReplay);
        return () => window.removeEventListener('compact-relay:replay-onboarding', onReplay);
      }, [playOnboarding]);

      // 0.4.2（P1）：换模型后首次发现「交接线已晚」弹一次提示（同路由不重复打扰）。
      // 只在「观察到路由变化」（localStorage 记着上一次的 provider/model）时弹；
      // 首次见到某路由不弹（不是换模型导致的），设置页有常驻提示兜底。
      useEffect(() => {
        if (state.native === null || state.native.route === null) return;
        const key = `${state.native.route.provider || ''}/${state.native.route.model}`;
        let previous = null;
        try {
          previous = window.localStorage.getItem('dsh.compact-relay.route.v1');
        } catch {
          previous = null; // 隐私模式：不记、不弹，避免反复打扰
          return;
        }
        if (previous === key) return;
        try {
          window.localStorage.setItem('dsh.compact-relay.route.v1', key);
        } catch {
          /* ignore */
        }
        if (previous === null || previous === '' || !handoffLate) return;
        showToast(`已切换到 ${state.native.route.model}：${handoffWarnText.replace('⚠ ', '')}。可在「设置 → 压缩接力」一键重算。`, 10000);
      }, [state.native, handoffLate, handoffWarnText, showToast]);

      // 引导光晕：默认 4 次呼吸后自动停（手动重播时按传入时长）。
      useEffect(() => {
        if (!onboarding) return undefined;
        const blink = setInterval(() => setPulseOn((value) => !value), 600);
        const stop = setTimeout(() => {
          clearInterval(blink);
          setPulseOn(false);
        }, onboardingPulseMs);
        return () => {
          clearInterval(blink);
          clearTimeout(stop);
          setPulseOn(false);
        };
      }, [onboarding, onboardingPulseMs]);

      // M6：执行中取消——先 abort 本地请求，再让 host 中止事务（历史不变）。
      const cancelRun = useCallback(() => {
        const controller = runAbortRef.current;
        if (controller !== null) {
          try {
            controller.abort();
          } catch {
            /* ignore */
          }
        }
        showToast({ text: '正在取消…（已提交的部分不会回滚）' }, 0);
        void fetch('/api/compact-relay-action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'cancel', ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}) }),
        }).catch(() => {});
      }, [sessionId]);

      // M6：预览——只算「能压哪段、多少 token」，不写历史。
      const startPreview = useCallback(async () => {
        if (effectiveBusy) return;
        setOpen(false);
        setHandoffPreview(null);
        setPreview({ loading: true });
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        previewAbortRef.current = controller;
        try {
          const res = await fetch('/api/compact-relay-action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'preview', ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}) }),
            ...(controller === null ? {} : { signal: controller.signal }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false || data.preview == null) {
            setPreview(null);
            showToast(data && data.message ? String(data.message) : '压缩预估失败：现在没有能压缩的内容');
            return;
          }
          setPreview({ data });
        } catch (error) {
          setPreview(null);
          if (error && error.name === 'AbortError') return;
          showToast('压缩预估失败：' + (error && error.message ? error.message : '未知错误'), 8000);
        } finally {
          previewAbortRef.current = null;
        }
      }, [effectiveBusy, sessionId, showToast]);

      // A1b：交接预览——生成九段草稿 + 就绪清单，不写盘、不建会话、不改历史。
      const startHandoffPreview = useCallback(async () => {
        if (effectiveBusy) return;
        setOpen(false);
        setPreview(null);
        closeDocs();
        closeDiff();
        setHandoffEditValues({});
        setArchiveWanted(true);
        setHandoffPreview({ loading: true });
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        handoffPreviewAbortRef.current = controller;
        try {
          const res = await fetch('/api/compact-relay-action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'handoff-preview', ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}) }),
            ...(controller === null ? {} : { signal: controller.signal }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) {
            setHandoffPreview(null);
            showToast(data && data.message ? String(data.message) : '交接预览失败：没有拿到草稿', 6000);
            return;
          }
          setHandoffPreview({ data });
        } catch (error) {
          setHandoffPreview(null);
          if (error && error.name === 'AbortError') return;
          showToast('交接预览失败：' + (error && error.message ? error.message : '未知错误'), 8000);
        } finally {
          handoffPreviewAbortRef.current = null;
        }
      }, [effectiveBusy, sessionId, showToast, closeDocs, closeDiff]);

      // M6：交接单列表（菜单入口）——只读接口，点开可看全文/复制路径。
      // P2-C3/C4：请求带序号 + AbortController；只接受「仍然是当前选中文件」的响应。
      // 0.3.4（BUG-006）：列表先取最近 20 份，「加载更多」再把 limit 提到 50；
      // 端点返回 total，界面据此显示「共 N 份（显示最近 M）」并在无更多时隐藏按钮。
      const loadDocs = useCallback(async (limit = 20) => {
        setOpen(false);
        setPreview(null);
        closeDiff();
        if (docsAbortRef.current !== null) {
          try {
            docsAbortRef.current.abort();
          } catch {
            /* ignore */
          }
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        docsAbortRef.current = controller;
        const reqId = ++docsRequestRef.current;
        setDocs({ loading: true });
        try {
          const res = await fetch(`/api/compact-relay-handoffs?limit=${limit}`, {
            cache: 'no-store',
            ...(controller === null ? {} : { signal: controller.signal }),
          });
          const data = await res.json().catch(() => ({}));
          if (reqId !== docsRequestRef.current) return;
          if (!res.ok || data.ok === false) {
            setDocs({ error: data && data.message ? String(data.message) : '读取交接单失败' });
            return;
          }
          const items = Array.isArray(data.items) ? data.items : [];
          const total = typeof data.total === 'number' && Number.isFinite(data.total) ? data.total : items.length;
          setDocs({ items, total, limit, selected: null });
        } catch (error) {
          if (reqId !== docsRequestRef.current || (error && error.name === 'AbortError')) return;
          setDocs({ error: '读取交接单失败：' + (error && error.message ? error.message : '未知错误') });
        }
      }, [closeDiff]);

      // A6：压缩历史（菜单入口）——只读，压了哪些条 / 摘要预览 / 省了多少容量。
      const loadDiff = useCallback(async () => {
        setOpen(false);
        setPreview(null);
        closeDocs();
        if (diffAbortRef.current !== null) {
          try {
            diffAbortRef.current.abort();
          } catch {
            /* ignore */
          }
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        diffAbortRef.current = controller;
        const reqId = ++diffRequestRef.current;
        setDiff({ loading: true });
        try {
          const query = new URLSearchParams({ limit: '10' });
          if (typeof sessionId === 'string' && sessionId.length > 0) query.set('sessionId', sessionId);
          const res = await fetch(`/api/compact-relay-diff?${query.toString()}`, {
            cache: 'no-store',
            ...(controller === null ? {} : { signal: controller.signal }),
          });
          const data = await res.json().catch(() => ({}));
          if (reqId !== diffRequestRef.current) return;
          if (!res.ok || data.ok === false) {
            setDiff({ error: data && data.message ? String(data.message) : '读取压缩历史失败' });
            return;
          }
          const items = Array.isArray(data.items) ? data.items : [];
          if (items.length === 0) {
            setDiff(null);
            showToast('还没有压缩记录；执行一次「压缩旧会话」后就能在这里回看。', 5000);
            return;
          }
          setDiff({ items });
        } catch (error) {
          if (reqId !== diffRequestRef.current || (error && error.name === 'AbortError')) return;
          setDiff({ error: '读取压缩历史失败：' + (error && error.message ? error.message : '未知错误') });
        }
      }, [closeDocs, sessionId, showToast]);

      const openDoc = useCallback(async (name) => {
        if (docsAbortRef.current !== null) {
          try {
            docsAbortRef.current.abort();
          } catch {
            /* ignore */
          }
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        docsAbortRef.current = controller;
        const reqId = ++docsRequestRef.current;
        setDocs((prev) => (prev === null ? null : { ...prev, selected: name, contentLoading: true, content: null, contentError: null }));
        try {
          const res = await fetch(`/api/compact-relay-handoffs?file=${encodeURIComponent(name)}`, {
            cache: 'no-store',
            ...(controller === null ? {} : { signal: controller.signal }),
          });
          const data = await res.json().catch(() => ({}));
          if (reqId !== docsRequestRef.current) return;
          if (!res.ok || data.ok === false) throw new Error(data && data.message ? String(data.message) : '读取失败');
          setDocs((prev) =>
            prev === null || prev.selected !== name
              ? prev
              : {
                  ...prev,
                  contentLoading: false,
                  content: typeof data.content === 'string' ? data.content : '',
                  docPath: typeof data.path === 'string' ? data.path : null,
                },
          );
        } catch (error) {
          if (reqId !== docsRequestRef.current || (error && error.name === 'AbortError')) return;
          setDocs((prev) =>
            prev === null || prev.selected !== name
              ? prev
              : { ...prev, contentLoading: false, contentError: '读取失败：' + (error && error.message ? error.message : '未知错误') },
          );
        }
      }, []);

      const copyDocPath = useCallback(() => {
        const items = docs !== null && Array.isArray(docs.items) ? docs.items : [];
        const selected = docs !== null && typeof docs.selected === 'string' ? docs.selected : null;
        const item = selected === null ? undefined : items.find((candidate) => candidate.name === selected);
        const target = (docs !== null && typeof docs.docPath === 'string' && docs.docPath.length > 0 ? docs.docPath : undefined) ?? item?.path;
        if (typeof target !== 'string' || target.length === 0) return;
        try {
          const written = navigator.clipboard?.writeText(target);
          if (written !== undefined && typeof written.then === 'function') {
            written.then(
              () => showToast('已复制路径：' + target, 4000),
              () => showToast('复制失败：' + target, 5000),
            );
          } else {
            showToast('已复制路径：' + target, 4000);
          }
        } catch {
          showToast('复制失败：' + target, 5000);
        }
      }, [docs]);

      // M6：菜单一层入口——有锁定就清空，没有就锁最近一轮。
      const togglePins = useCallback(async () => {
        if (effectiveBusy) return;
        setOpen(false);
        setBusy(true);
        try {
          const res = await fetch('/api/compact-relay-action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'pin-toggle', ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}) }),
          });
          const data = await res.json().catch(() => ({}));
          showToast(data && data.message ? String(data.message) : res.ok ? '已更新锁定状态' : '锁定操作失败', 6000);
        } catch (error) {
          showToast('锁定操作失败：' + (error && error.message ? error.message : '未知错误'), 8000);
        } finally {
          setBusy(false);
        }
      }, [effectiveBusy, sessionId]);

      const run = useCallback(
        async (action, extra) => {
          // A3：确认必须带预览时拿到的 planId，宿主重算不一致会以 changed 拒绝。
          const expected =
            action === 'compact' && preview !== null && preview.loading !== true && typeof preview.data?.planId === 'string'
              ? { planId: preview.data.planId }
              : undefined;
          setBusy(true);
          setOpen(false);
          setPreview(null);
          setHandoffPreview(null);
          const controller = typeof AbortController === 'function' ? new AbortController() : null;
          runAbortRef.current = controller;
          // 立刻给反馈：不等结果回来，先告诉用户「在做了」；压缩/交接都可取消。
          const runningText =
            action === 'compact'
              ? '正在压缩旧会话…（通常需几秒，可随时取消）'
              : '正在交接…（先压缩旧会话、再生成交接单，约需十几秒）';
          showToast({ text: runningText, cancel: true }, 0);
          try {
            const res = await fetch('/api/compact-relay-action', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                action,
                ...(expected === undefined ? {} : { expected }),
                // 0.4 P2-1：`extra.edits` = 只含用户真正改过的「约束/下一步」两段。
                ...(extra !== undefined && extra !== null && typeof extra === 'object' ? extra : {}),
                ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}),
              }),
              ...(controller === null ? {} : { signal: controller.signal }),
            });
            const data = await res.json().catch(() => ({}));
            if (data && data.code === 'changed') {
              // 范围变了：提示并自动重开确认卡，让用户看新范围再决定。
              showToast(data.message ? String(data.message) : '压缩范围已变，请重新预估。', 6000);
              void startPreview();
            } else if (action === 'handoff' && data && typeof data.childId === 'string') {
              showToast('交接单已生成，正在打开新会话…', 0);
              try {
                await waitAndOpen(data.childId);
                // 0.5.1 批 2：归档有三种结果（归档 / 按选择不归档 / 置顶未确认不归档），
                // 成功提示要如实说清旧会话去哪了，不能一律说「仍保留」。
                const archiveStatus = data.archive !== null && typeof data.archive === 'object' ? data.archive.status : null;
                showToast(
                  archiveStatus === 'archived' || archiveStatus === 'already'
                    ? '已切换到新会话；旧会话已归档（可在新会话「恢复旧会话」找回）。'
                    : archiveStatus === 'skipped'
                      ? '已切换到新会话；按你的选择未归档旧会话（仍在列表里，置顶保持）。'
                      : archiveStatus === 'pinned'
                        ? '已切换到新会话；旧会话已置顶，本次未自动归档（归档会取消置顶）。'
                        : '已切换到新会话；旧会话归档未完成（仍在列表里）。',
                  8000,
                );
              } catch (error) {
                showToast(`交接单已生成，但自动切换新会话失败：${error && error.message ? error.message : '未知原因'}（新会话 ${data.childId}）`, 8000);
              }
            } else if (data && data.cancelled === true) {
              showToast(data.message ? String(data.message) : '已取消，会话记录没有改动。', 6000);
            } else {
              showToast(data && data.message ? String(data.message) : action === 'compact' ? '已开始压缩' : '已开始交接', 6000);
            }
          } catch (error) {
            if (error && error.name === 'AbortError') showToast('已取消请求（若已提交，会话记录以历史为准）。', 5000);
            else showToast('操作失败：' + (error && error.message ? error.message : '未知错误'), 8000);
          } finally {
            setBusy(false);
            runAbortRef.current = null;
          }
        },
        [sessionId, waitAndOpen, preview, startPreview],
      );

      const adviceText = adviseHandoff ? '建议交接' : adviseCompact ? '建议压缩' : '正常';
      // 0.3.1：模型判断的断点位置（「这里适合压缩」）；DSH 原生自动压缩线（报警最高阈值）。
      const compressHintText =
        state.compressHint !== null && typeof state.compressHint.ratio === 'number'
          ? `压缩判断点 ${(state.compressHint.ratio * 100).toFixed(0)}%`
          : '';
      const nativeEffective = effectiveNativeRatio(state.native);
      const nativeDetail =
        state.native !== null && state.native.thresholdTokens !== null && state.native.contextWindow !== null
          ? `（${fmt(state.native.thresholdTokens)} / ${fmt(state.native.contextWindow)}${
              state.native.route !== null ? `，${state.native.route.provider}/${state.native.route.model}` : ''
            }${state.native.overridden ? '，按路由覆盖' : ''}）`
          : '';
      const nativeInfo = nativeLineInfo(state.native);
      const nativeLineText =
        nativeEffective !== null
          ? `原生自动压缩线 ${(nativeEffective * 100).toFixed(1)}%${nativeDetail}${
              nativeInfo.differs ? `；${nativeInfo.why}` : ''
            }${ratio > nativeEffective ? '（已越过：整环红色闪烁）' : ''}`
          : 'DSH 原生自动压缩已关闭';
      const pressureKnown = pressureValue !== null;
      const title =
        (pressureKnown
          ? `会话容量已用 ${(ratio * 100).toFixed(1)}%（${fmt(pressureValue)} / ${fmt(windowValue)}）`
          : '正在读取会话容量（会话刚打开，请稍候）') +
        `，已压缩 ${state.summaries} 次｜${adviceText}` +
        (compressHintText !== '' ? `｜${compressHintText}` : '') +
        (nativeLineText !== '' ? `｜${nativeLineText}` : '') +
        (handoffWarnText !== '' ? `｜${handoffWarnText}` : '') +
        (effectiveBusy ? '｜处理中…' : '');

      // 浮层定位：fixed（不受 composer 裁剪）+ 视口左右收边 + 上方空间不够时翻到下方。
      const vw = typeof window === 'undefined' ? 1280 : window.innerWidth;
      const vh = typeof window === 'undefined' ? 900 : window.innerHeight;
      const clampLeft = (estimatedWidth) =>
        anchor === null ? 8 : Math.max(8, Math.min(anchor.left, Math.max(8, vw - estimatedWidth - 8)));
      // 浮层定位：先按「估计高度」判断上方放不放得下，放不下就翻到下方并夹在视口内。
      // 只估宽度会让 340~520px 高的面板在矮视口里顶出屏幕（2026-10-20 预览卡实测）。
      const floatPos = (estimatedWidth, estimatedHeight = 340) => {
        if (anchor === null) return { left: 8, top: 12 };
        const margin = 8;
        const above = anchor.top >= estimatedHeight + margin * 2;
        const top = above
          ? anchor.top - margin
          : Math.max(margin, Math.min(anchor.bottom + margin, vh - estimatedHeight - margin));
        return {
          left: clampLeft(estimatedWidth),
          top,
          ...(above ? { transform: 'translateY(-100%)' } : {}),
        };
      };

      // 悬停数字（规格 §2）：自绘小卡，比原生 title 快、可控制格式。
      const tooltip =
        hover && !open && anchor !== null
          ? h(
              'div',
              {
                'data-cr-tooltip': '1',
                style: {
                  position: 'fixed',
                  ...floatPos(320, 140),
                  maxWidth: 'min(320px, calc(100vw - 16px))',
                  whiteSpace: 'normal',
                  wordBreak: 'break-word',
                  padding: '6px 9px',
                  borderRadius: 8,
                  ...panelChrome(theme),
                  color: theme.panelFg,
                  fontSize: 11,
                  lineHeight: '16px',
                  zIndex: 39,
                  pointerEvents: 'none',
                },
              },
              h(
                'div',
                null,
                pressureKnown
                  ? `会话容量已用 ${(ratio * 100).toFixed(1)}%（${fmt(pressureValue)} / ${fmt(windowValue)}）`
                  : '正在读取会话容量（会话刚打开，请稍候）',
              ),
              h(
                'div',
                { style: { color: theme.subText } },
                `已压缩 ${state.summaries} 次 · ${adviceText}${compressHintText !== '' ? ` · ${compressHintText}` : ''}${nativeLineText !== '' ? ` · ${nativeLineText}` : ''}${effectiveBusy ? ' · 处理中…' : ''}`,
              ),
              // 0.4.2：交接线晚于原生压缩时，悬停卡里给一行显式警示（只告警，不改设置）。
              handoffWarnText !== ''
                ? h('div', { 'data-cr-handoff-warn-text': '1', style: { marginTop: 2, color: palette.handoff } }, handoffWarnText)
                : null,
            )
          : null;

      const svg = h(
        'svg',
        { viewBox: '0 0 20 20', width: 20, height: 20, 'aria-hidden': true, style: { display: 'block' } },
        h('circle', { cx: 10, cy: 10, r: RADIUS, fill: 'none', stroke: COLORS.track, strokeWidth: 2, opacity: 0.18 }),
        // 0.3.1：分段弧（正常区灰/蓝 → 压缩区琥珀 → 交接区红），区间之间留缺口当断点。
        ...ringNodes,
        h('circle', {
          cx: 10,
          cy: 10,
          r: 3,
          fill: dotColor,
          'data-cr-dot': adviseHandoff ? 'handoff' : level,
          style: {
            transition: 'fill 200ms ease',
            filter: adviseHandoff ? `drop-shadow(0 0 3px ${palette.handoff})` : 'none',
          },
        }),
        // 0.3.1：DSH 原生自动压缩线（刻度/危险区）。
        ...nativeNodes,
        // 0.4.2：交接线已晚的警示标记（交接刻度旁的小短线 + 小点，不改分段逻辑）。
        ...handoffWarnNodes,
        // 0.5.1 定稿：pin 位置块不画（位置标记归 0.6 时间线；环只表达容量）。
      );

      const trigger = h(
        'button',
        {
          type: 'button',
          ref: triggerRef,
          onClick: (e) => {
            rememberAnchor(e.currentTarget);
            setPreview(null);
            closeDocs();
            setOpen((v) => !v);
          },
          disabled: effectiveBusy,
          'aria-label': title,
          onMouseEnter: (e) => {
            rememberAnchor(e.currentTarget);
            setHover(true);
          },
          onMouseLeave: () => setHover(false),
          onFocus: (e) => {
            rememberAnchor(e.currentTarget);
            setHover(true);
          },
          onBlur: () => setHover(false),
          'data-cr-level': level,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          // 供端到端测试取证：stream=SSE 实时推送，poll=降级轮询。
          'data-cr-source': streamLive ? 'stream' : 'poll',
          'data-cr-tokens': pressureValue == null ? '' : String(pressureValue),
          // 取证用：注入到组件的会话 id / 最近一次状态里的会话 id（排查「未知」时看这俩）。
          'data-cr-session': typeof sessionId === 'string' ? sessionId : '',
          'data-cr-state-session': typeof state.sessionId === 'string' ? state.sessionId : '',
          'data-cr-summaries': String(state.summaries),
          'data-cr-pins': String(pins.count),
          // 0.5.1 批 2：失效 pin / 原生压缩预判风险（取证 + 端到端断言用）。
          'data-cr-pins-stale': String(pinStaleCount),
          'data-cr-pins-risk': pinRisk === null ? '' : String(pinRisk.count),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            padding: 0,
            border: 'none',
            borderRadius: 8,
            background: 'transparent',
            cursor: effectiveBusy ? 'wait' : 'pointer',
            color: 'inherit',
            opacity: effectiveBusy ? 0.5 : 1,
            position: 'relative',
            // 0.3.1：首次引导时做几次呼吸光晕，引导结束后恢复安静。
            boxShadow: pulseOn ? `0 0 0 5px ${palette.stage}33` : '0 0 0 0 transparent',
            transition: 'box-shadow 600ms ease',
          },
        },
        svg,
      );

      // B 方案（2026-10-20 设计评审拍板）：压缩/交接保留两行说明，其余 4 项压成单行，
      // 关键状态放右侧；说明原文仍保留在 title 里，悬停可看。
      const item = (label, sub, action, accent, meta = {}) => {
        const disabled = effectiveBusy || meta.disabled === true;
        const oneLine = meta.oneLine === true;
        return h(
          'button',
          {
            type: 'button',
            key: action,
            role: 'menuitem',
            'data-cr-item': action,
            disabled,
            // 禁用态的两行条目也把说明挂到 title：鼠标悬停能读到完整原因（含数字）。
            title: meta.title ?? (oneLine || disabled ? (meta.note ?? sub) : undefined),
            onClick: () => {
              if (disabled) return;
              // M6：压缩项先走预览（meta.onClick），其余动作直接执行。
              if (typeof meta.onClick === 'function') {
                meta.onClick();
                return;
              }
              void run(action);
            },
            style: {
              display: 'flex',
              flexDirection: oneLine ? 'row' : 'column',
              alignItems: oneLine ? 'center' : 'flex-start',
              justifyContent: oneLine ? 'space-between' : 'flex-start',
              gap: oneLine ? 10 : 2,
              width: '100%',
              padding: oneLine ? '6px 10px' : '8px 10px',
              border: 'none',
              borderRadius: 8,
              background: 'transparent',
              cursor: disabled ? 'default' : 'pointer',
              textAlign: 'left',
              color: theme.panelFg,
              opacity: disabled ? 0.5 : 1,
            },
            onMouseEnter: (e) => {
              if (!disabled) e.currentTarget.style.background = theme.hover;
            },
            onMouseLeave: (e) => {
              e.currentTarget.style.background = 'transparent';
            },
          },
          h('span', { style: { fontSize: 13, fontWeight: 500, color: accent || theme.panelFg } }, label),
          oneLine
            ? h(
                'span',
                {
                  style: {
                    fontSize: meta.right === undefined ? 15 : 11,
                    lineHeight: 1,
                    color: theme.subText,
                    whiteSpace: 'nowrap',
                    marginLeft: 'auto',
                    maxWidth: 132,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  },
                },
                meta.right ?? '›',
              )
            : h('span', { style: { fontSize: 11, color: theme.subText } }, meta.note ?? sub),
        );
      };

      // 0.5.1 批 2：交接菜单项的提示（原生压缩预判风险优先于「交接线已晚」，两条都有就并排）。
      const handoffItemNote = handoffLate ? handoffWarnText : '';
      const handoffItemTitle = handoffLate ? handoffGuardInfo.message : undefined;
      // undefined=宿主没上报（老版本/未知）；null=明确没有可压范围；object=可压多少。
      const rangeInfo = state.compactRange;
      // 0.3.5：有可压范围、但会话还没有活 agent（passivized live session）——preview 需要
      // 活 agent，所以按钮仍禁用，但文案要说清「发一条消息唤醒 agent」，不能再报「暂无可压缩内容」。
      const passiveRangeNote =
        rangeInfo !== null && rangeInfo !== undefined && state.compactRangeReason === 'no_agent'
          ? `会话未激活：发一条消息唤醒 agent 后可压 ${rangeInfo.nodes} 条 · 约 ${fmt(rangeInfo.tokens)} tokens`
          : null;
      const panel = open
        ? h(
            'div',
            {
              ref: menuRef,
              role: 'menu',
              'aria-label': '压缩接力菜单',
              style: {
                position: 'fixed',
                ...floatPos(268, 340),
                width: 268,
                maxWidth: 'calc(100vw - 16px)',
                maxHeight: 'min(70vh, 340px)',
                overflowY: 'auto',
                padding: 6,
                borderRadius: 12,
                ...panelChrome(theme),
                zIndex: 40,
              },
            },
            h(
              'div',
              { style: { padding: '6px 10px 4px', fontSize: 11, color: theme.subText } },
              pressureKnown
                ? `已用 ${(ratio * 100).toFixed(1)}% · 已压缩 ${state.summaries} 次`
                : `容量未知 · 已压缩 ${state.summaries} 次`,
            ),
            item(
              '压缩旧会话',
              '把较早会话压成摘要，腾出容量（先预估再确认，/bc）',
              'compact',
              adviseCompact ? palette.compact : null,
              {
                ...(rangeInfo === null
                  ? {
                      disabled: true,
                      note: '暂无可压缩内容（会话太短，或近期会话需保留原文）',
                    }
                  : passiveRangeNote !== null
                    ? { disabled: true, title: passiveRangeNote, note: passiveRangeNote }
                    : rangeInfo !== undefined
                      ? { note: `可压 ${rangeInfo.nodes} 条 · 约 ${fmt(rangeInfo.tokens)} tokens · 点击先看压缩预估` }
                      : { note: '点击先看压缩预估（范围/容量）' }),
                onClick: () => {
                  void startPreview();
                },
              },
            ),
            item(
              '交接新会话',
              '生成交接单并开新会话接着聊，旧会话保留（/handoff）',
              'handoff',
              palette.handoff,
              hasSession
                ? {
                    onClick: () => {
                      void startHandoffPreview();
                    },
                    // 0.4.2（P1）：交接线晚于原生压缩时，菜单项旁直接标出来（只告警，仍可点）。
                    // 0.5.1 批 2：原生压缩预计覆盖 pin 时，这里优先提示「先交接保留」。
                    ...(handoffItemNote !== '' ? { note: handoffItemNote, ...(handoffItemTitle === undefined ? {} : { title: handoffItemTitle }) } : {}),
                  }
                : { disabled: true, note: '会话刚打开，请稍候' },
            ),
            item('查看交接单', '翻看历史交接单、复制文件路径', 'docs', null, {
              oneLine: true,
              onClick: () => {
                void loadDocs();
              },
            }),
            hasSession
              ? item('查看上次压缩', '只读：压了哪些条、摘要预览、省了多少容量', 'diff', null, {
                  oneLine: true,
                  onClick: () => {
                    void loadDiff();
                  },
                })
              : item('查看上次压缩', '只读：压了哪些条、摘要预览、省了多少容量', 'diff', null, {
                  oneLine: true,
                  disabled: true,
                  right: '未就绪',
                  note: '会话还没就绪',
                }),
          )
        : null;

      // M6：确认卡——预览结果 + 「取消 / 确认执行」，点外面关闭。
      // 预览接口的外层是 { ok, message, preview:{nodes,tokens,…} }，卡片要读里层 preview。
      const previewRange = preview?.data?.preview ?? null;
      // 0.3.1：范围太小时预览阶段就拦下（服务端已按 800 tokens 判定），不让用户白确认一次。
      const previewTooSmall = previewRange !== null && previewRange.tooSmall === true;
      const confirmPanel =
        preview === null
          ? null
          : h(
              'div',
              {
                ref: previewRef,
                role: 'dialog',
                'aria-label': '确认压缩',
                'data-cr-preview': '1',
                style: {
                  position: 'fixed',
                  ...floatPos(300, 320),
                  width: 300,
                  maxWidth: 'calc(100vw - 16px)',
                  padding: '10px 12px',
                  borderRadius: 12,
                  maxHeight: 'min(70vh, 440px)',
                  overflowY: 'auto',
                  ...panelChrome(theme),
                  color: theme.panelFg,
                  zIndex: 42,
                },
              },
              preview.loading === true
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                    h('div', { style: { fontSize: 12, fontWeight: 600 } }, '正在估算可压缩的范围…'),
                    h('div', { style: { fontSize: 11, color: theme.subText } }, '只估算范围和容量；摘要内容确认后才生成，不在这里展示。'),
                  )
                : h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                    h('div', { style: { fontSize: 12, fontWeight: 600 } }, '确认压缩'),
                    h(
                      'div',
                      { style: { fontSize: 11, lineHeight: '17px', color: theme.subText } },
                      `将把 ${previewRange?.nodes ?? '—'} 条旧会话压成 1 条摘要（腾出约 ${fmt(previewRange?.tokens)} tokens）。`,
                      previewTooSmall
                        ? h(
                            'div',
                            { style: { marginTop: 4, color: '#b45309' } },
                            '这段太小，压了可能反而更大。建议先继续聊几轮，或把「保留近期原文」调小后再压缩。',
                          )
                        : null,
                      h('br'),
                      '只估算范围和容量；摘要内容确认后才生成，不在这里展示。压缩后旧会话将替换为摘要，无法还原为原文。',
                    ),
                    h(
                      'div',
                      { style: { display: 'flex', justifyContent: 'flex-end', gap: 6 } },
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-cr-confirm-cancel': '1',
                          onClick: () => setPreview(null),
                          style: {
                            border: `1px solid ${theme.panelBorder}`,
                            borderRadius: 7,
                            padding: '4px 10px',
                            fontSize: 11,
                            cursor: 'pointer',
                            background: 'transparent',
                            color: theme.panelFg,
                          },
                        },
                        '取消',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-cr-confirm-run': '1',
                          disabled: previewTooSmall,
                          onClick: () => {
                            if (previewTooSmall) return;
                            void run('compact');
                          },
                          style: {
                            border: 'none',
                            borderRadius: 7,
                            padding: '4px 10px',
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: previewTooSmall ? 'not-allowed' : 'pointer',
                            opacity: previewTooSmall ? 0.5 : 1,
                            background: palette.compact,
                            color: '#ffffff',
                          },
                        },
                        '确认压缩',
                      ),
                    ),
                  ),
            );

      // M6：交接单面板（列表 → 单篇全文，只读）。
      const smallBtnStyle = {
        border: `1px solid ${theme.panelBorder}`,
        borderRadius: 6,
        padding: '2px 8px',
        fontSize: 11,
        cursor: 'pointer',
        background: 'transparent',
        color: theme.panelFg,
      };
      // A1b：交接预览卡——九段草稿 + 就绪清单；确认才走完整交接（会先压缩再重新生成）。
      const handoffData = handoffPreview !== null && handoffPreview.loading !== true ? handoffPreview.data : null;
      const handoffReadiness = handoffData !== null && typeof handoffData === 'object' ? handoffData.readiness : null;
      const handoffDraft = handoffData !== null && typeof handoffData === 'object' && typeof handoffData.draft === 'string' ? handoffData.draft : '';
      /**
       * 0.5.1 批 2：交接确认统一入口 —— 只把「用户真的改过、且非空」的两段发给宿主；
       * includeArchive/confirmUnpin 由归档开关和置顶确认决定（服务端还会再兜一层）。
       */
      const beginHandoff = (options = {}) => {
        const editable = handoffData !== null && typeof handoffData === 'object' ? handoffData.editable : null;
        const edits = {};
        if (editable !== null && typeof editable === 'object' && Array.isArray(editable.titles)) {
          for (const title of editable.titles) {
            const original = typeof editable.sections?.[title] === 'string' ? editable.sections[title].trim() : '';
            const current = typeof handoffEditValues[title] === 'string' ? handoffEditValues[title].trim() : '';
            if (current.length > 0 && current !== original) edits[title] = current;
          }
        }
        closeHandoffPreview();
        void run('handoff', {
          archive: options.archive !== false,
          ...(options.confirmUnpin === true ? { confirmUnpin: true } : {}),
          ...(Object.keys(edits).length > 0 ? { edits } : {}),
        });
      };
      const handoffPanel =
        handoffPreview === null
          ? null
          : h(
              'div',
              {
                ref: handoffPreviewRef,
                role: 'dialog',
                'aria-label': '交接预览',
                'data-cr-handoff-preview': '1',
                style: {
                  position: 'fixed',
                  ...floatPos(360, 520),
                  width: 360,
                  maxWidth: 'calc(100vw - 16px)',
                  maxHeight: 'min(72vh, 520px)',
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  padding: '10px 12px',
                  borderRadius: 12,
                  ...panelChrome(theme),
                  color: theme.panelFg,
                  zIndex: 44,
                },
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', { style: { flex: 1, fontSize: 12, fontWeight: 600 } }, '交接预览'),
                h('button', { type: 'button', onClick: closeHandoffPreview, style: smallBtnStyle }, '关闭'),
              ),
              handoffPreview.loading === true
                ? h('div', { style: { fontSize: 11, color: theme.subText } }, '正在生成九段草稿并做就绪检查…（只预览，不写盘、不建会话）')
                : h(
                    'div',
                    {
                      'data-cr-handoff-body': '1',
                      style: { display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, flexShrink: 0 },
                    },
                    h(
                      'div',
                      {
                        style: {
                          fontSize: 11,
                          lineHeight: '17px',
                          color: handoffReadiness !== null && handoffReadiness.ok === true ? theme.subText : '#b45309',
                        },
                      },
                      handoffReadiness !== null && handoffReadiness.ok === true
                        ? '就绪检查：九段齐全，可以交接。'
                        : '就绪检查未通过：' + (handoffReadiness?.missing ?? []).join('、'),
                      handoffReadiness !== null && Array.isArray(handoffReadiness.warnings) && handoffReadiness.warnings.length > 0
                        ? h('div', { style: { marginTop: 4 } }, '警告：' + handoffReadiness.warnings.slice(0, 3).join('；'))
                        : null,
                    ),
                    h(
                      'div',
                      {
                        'data-cr-handoff-draft': '1',
                        style: {
                          fontSize: 11,
                          lineHeight: '16px',
                          overflow: 'auto',
                          maxHeight: 220,
                          flexShrink: 0,
                          border: `1px solid ${theme.panelBorder}`,
                          borderRadius: 8,
                          padding: '6px 8px',
                          background: theme.hover,
                        },
                      },
                      ...previewLines(
                        handoffDraft.length > 1500
                          ? `${handoffDraft.slice(0, 1500)}\n…（已截断，确认后生成完整交接单）`
                          : handoffDraft,
                      ),
                    ),
                    // 0.4 P2-1：只允许编辑「约束」「下一步」两段；其余段由模型/程序生成，UI 不给入口。
                    handoffData !== null && typeof handoffData === 'object' && handoffData.editable !== null && typeof handoffData.editable === 'object'
                      ? h(
                          'div',
                          { 'data-cr-handoff-editable': '1', style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                          h('div', { style: { fontSize: 11, fontWeight: 600 } }, '可编辑两段（改完点「确认交接」才生效）'),
                          ...(Array.isArray(handoffData.editable.titles) ? handoffData.editable.titles : []).map((title) => {
                            const original = typeof handoffData.editable.sections?.[title] === 'string' ? handoffData.editable.sections[title] : '';
                            return h(
                              'label',
                              { key: `handoff-edit-${title}`, style: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 } },
                              h('span', { style: { color: theme.subText } }, `${title}（留空 = 使用原文）`),
                              h('textarea', {
                                'data-cr-handoff-edit': title,
                                value: typeof handoffEditValues[title] === 'string' ? handoffEditValues[title] : original,
                                rows: 3,
                                maxLength: Number.isInteger(handoffData.editable.maxChars) ? handoffData.editable.maxChars : 4000,
                                onChange: (event) => {
                                  const value = event.target.value;
                                  setHandoffEditValues((previous) => ({ ...previous, [title]: value }));
                                },
                                style: {
                                  width: '100%',
                                  boxSizing: 'border-box',
                                  resize: 'vertical',
                                  fontFamily: 'inherit',
                                  fontSize: 11,
                                  lineHeight: '16px',
                                  color: 'inherit',
                                  background: 'transparent',
                                  border: `1px solid ${theme.panelBorder}`,
                                  borderRadius: 6,
                                  padding: '4px 6px',
                                },
                              }),
                            );
                          }),
                          h('div', { style: { fontSize: 10, lineHeight: '14px', color: theme.subText } }, handoffData.editable.note ?? '程序生成的段不可改。'),
                        )
                      : null,
                    // 0.5.1 批 2：归档开关（默认开 = 0.5.0 行为；取消后只交接、不归档）。
                    h(
                      'label',
                      {
                        'data-cr-handoff-archive-row': '1',
                        style: { display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 11, lineHeight: '16px', color: theme.subText },
                      },
                      h('input', {
                        type: 'checkbox',
                        'data-cr-handoff-archive': '1',
                        checked: archiveWanted,
                        onChange: (event) => setArchiveWanted(event.target.checked === true),
                        style: { marginTop: 2 },
                      }),
                      h(
                        'span',
                        null,
                        '交接后自动归档旧会话（默认开；新会话建好后旧会话从侧栏收起，可在新会话「恢复旧会话」找回）。取消勾选 = 只交接、旧会话留在列表里。',
                      ),
                    ),
                    // 0.5.1 批 2：置顶保护 —— 宿主归档会在同一次写盘里取消置顶，必须用户确认。
                    sessionPinned && archiveWanted
                      ? h(
                          'div',
                          {
                            'data-cr-handoff-pinned-warning': '1',
                            style: {
                              fontSize: 11,
                              lineHeight: '16px',
                              padding: '6px 8px',
                              borderRadius: 8,
                              border: `1px solid ${palette.handoff}`,
                              color: palette.handoff,
                              background: theme.hover,
                            },
                          },
                          '旧会话已在侧栏置顶：归档会取消置顶（宿主行为）。要归档请点「交接并归档（取消置顶）」；想保留置顶就点「只交接，保留置顶」。',
                        )
                      : null,
                    h(
                      'div',
                      { style: { fontSize: 11, color: theme.subText } },
                      '确认后会先压缩旧会话，再按压缩后的历史生成最终交接单；预览不落盘。归档开关只影响旧会话是否从侧栏收起，不影响交接单本身。',
                    ),
                    h(
                      'div',
                      { style: { display: 'flex', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' } },
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-cr-handoff-cancel': '1',
                          onClick: closeHandoffPreview,
                          style: { ...smallBtnStyle, borderRadius: 7, padding: '4px 10px' },
                        },
                        '取消',
                      ),
                      // 置顶 + 勾选归档：给两个明确出口（归档并取消置顶 / 只交接保留置顶）。
                      sessionPinned && archiveWanted
                        ? h(
                            'button',
                            {
                              type: 'button',
                              'data-cr-handoff-keep': '1',
                              onClick: () => beginHandoff({ archive: false }),
                              style: { ...smallBtnStyle, borderRadius: 7, padding: '4px 10px' },
                            },
                            '只交接，保留置顶',
                          )
                        : null,
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-cr-handoff-run': '1',
                          onClick: () => beginHandoff(sessionPinned && archiveWanted ? { archive: true, confirmUnpin: true } : { archive: archiveWanted }),
                          style: {
                            border: 'none',
                            borderRadius: 7,
                            padding: '4px 10px',
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: 'pointer',
                            background: palette.handoff,
                            color: '#ffffff',
                          },
                        },
                        sessionPinned && archiveWanted
                          ? '交接并归档（取消置顶）'
                          : archiveWanted
                            ? '确认交接（归档旧会话）'
                            : '确认交接（不归档）',
                      ),
                    ),
                  ),
            );

      // 0.3.4（BUG-006）：total 与当前窗口（20/50），用于列表底部与「加载更多」。
      const docsItems = docs !== null && Array.isArray(docs.items) ? docs.items : [];
      const docsTotal =
        docs !== null && typeof docs.total === 'number' && Number.isFinite(docs.total)
          ? docs.total
          : docsItems.length;
      const docsPanel =
        docs === null
          ? null
          : h(
              'div',
              {
                ref: docsRef,
                role: 'dialog',
                'aria-label': '交接单',
                'data-cr-docs': '1',
                style: {
                  position: 'fixed',
                  ...floatPos(360, 520),
                  width: 360,
                  maxWidth: 'calc(100vw - 16px)',
                  maxHeight: 'min(70vh, 480px)',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  borderRadius: 12,
                  ...panelChrome(theme),
                  color: theme.panelFg,
                  zIndex: 43,
                },
              },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 10px',
                    borderBottom: `1px solid ${theme.panelBorder}`,
                    fontSize: 12,
                    fontWeight: 600,
                  },
                },
                h(
                  'span',
                  { style: { flex: 1, minWidth: 0 } },
                  docs.selected !== undefined && docs.selected !== null
                    ? '交接单详情'
                    : `历史交接单（${docsTotal}）`,
                ),
                h('button', { type: 'button', 'data-cr-docs-close': '1', onClick: closeDocs, style: smallBtnStyle }, '关闭'),
              ),
              docs.loading === true
                ? h('div', { style: { padding: '10px 12px', fontSize: 11, color: theme.subText } }, '读取中…')
                : docs.selected !== undefined && docs.selected !== null
                  ? h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', minHeight: 0 } },
                      h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', flexWrap: 'wrap' } },
                        h(
                          'button',
                          {
                            type: 'button',
                            onClick: () => setDocs((prev) => (prev === null ? null : { ...prev, selected: null })),
                            style: smallBtnStyle,
                          },
                          '← 列表',
                        ),
                        h('button', { type: 'button', 'data-cr-docs-copy': '1', onClick: copyDocPath, style: smallBtnStyle }, '复制路径'),
                        h(
                          'span',
                          {
                            style: {
                              flex: 1,
                              minWidth: 0,
                              fontSize: 10,
                              color: theme.subText,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            },
                          },
                          docs.docPath ?? '',
                        ),
                      ),
                      h(
                        'div',
                        {
                          // 0.3.4（BUG-005）：交接单详情从 <pre> 纯文本改成轻量 markdown 渲染。
                          // 解析器是 core/markdown-lite.js（构建时内联），渲染只产生 React
                          // 文本节点，不生成 HTML、不引第三方依赖。
                          'data-cr-doc-content': '1',
                          style: {
                            margin: 0,
                            padding: '8px 12px',
                            overflowY: 'auto',
                            overflowX: 'hidden',
                            wordBreak: 'break-word',
                            fontSize: 11,
                            lineHeight: '16px',
                            maxHeight: 'min(50vh, 320px)',
                          },
                        },
                        docs.contentLoading === true
                          ? '读取中…'
                          : docs.contentError !== undefined && docs.contentError !== null
                            ? h('div', { style: { color: COLORS.error } }, String(docs.contentError))
                            : renderMarkdownLite(docs.content ?? ''),
                      ),
                    )
                  : h(
                      'div',
                      { style: { overflowY: 'auto', padding: 4 } },
                      docs.error !== undefined && docs.error !== null
                        ? h('div', { style: { padding: '8px 10px', fontSize: 11, color: COLORS.error } }, String(docs.error))
                        : docsItems.length > 0
                          ? [...docsItems.map((entry) =>
                              h(
                                'button',
                                {
                                  key: entry.name,
                                  type: 'button',
                                  'data-cr-doc-item': entry.name,
                                  onClick: () => {
                                    void openDoc(entry.name);
                                  },
                                  style: {
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'flex-start',
                                    gap: 2,
                                    width: '100%',
                                    padding: '7px 9px',
                                    border: 'none',
                                    borderRadius: 8,
                                    background: 'transparent',
                                    textAlign: 'left',
                                    cursor: 'pointer',
                                    color: theme.panelFg,
                                    fontSize: 12,
                                  },
                                  onMouseEnter: (event) => {
                                    event.currentTarget.style.background = theme.hover;
                                  },
                                  onMouseLeave: (event) => {
                                    event.currentTarget.style.background = 'transparent';
                                  },
                                },
                                h(
                                  'span',
                                  { style: { fontWeight: 500, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                                  entry.sourceTitle || entry.name,
                                ),
                                h(
                                  'span',
                                  { style: { fontSize: 10, color: theme.subText } },
                                  `${fmtTime(entry.mtime)} · ${Math.max(1, Math.round((Number(entry.size) || 0) / 1024))}KB · ${entry.name}`,
                                ),
                              ),
                            ),
                            h(
                              'div',
                              {
                                key: 'docs-footer',
                                style: {
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  padding: '6px 10px',
                                  borderTop: `1px solid ${theme.panelBorder}`,
                                  fontSize: 10,
                                  color: theme.subText,
                                },
                              },
                              h('span', { style: { flex: 1, minWidth: 0 } }, `共 ${docsTotal} 份（显示最近 ${docsItems.length}）`),
                              docsItems.length < docsTotal && docsItems.length < 50
                                ? h(
                                    'button',
                                    {
                                      type: 'button',
                                      'data-cr-docs-more': '1',
                                      onClick: () => {
                                        void loadDocs(50);
                                      },
                                      style: smallBtnStyle,
                                    },
                                    '加载更多',
                                  )
                                : null,
                            ),
                          ]
                          : h(
                              'div',
                              { style: { padding: '10px 12px', fontSize: 11, color: theme.subText } },
                              '还没有交接单；执行一次「交接新会话」（/handoff）后会自动保存在这里。',
                            ),
                    ),
            );

      // A6：压缩历史面板（只读）——范围、摘要预览、容量、是否已提交。
      const diffStatus = (entry) => {
        if (entry.committed === true) return '已提交';
        if (entry.open === true) return '未闭合';
        if (entry.error !== null && entry.error !== undefined) return '失败';
        return '未提交';
      };
      const diffPanel =
        diff === null
          ? null
          : h(
              'div',
              {
                ref: diffRef,
                role: 'dialog',
                'aria-label': '压缩记录',
                'data-cr-diff': '1',
                style: {
                  position: 'fixed',
                  ...floatPos(360, 520),
                  width: 360,
                  maxWidth: 'calc(100vw - 16px)',
                  maxHeight: 'min(70vh, 480px)',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  borderRadius: 12,
                  ...panelChrome(theme),
                  color: theme.panelFg,
                  zIndex: 43,
                },
              },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 10px',
                    borderBottom: `1px solid ${theme.panelBorder}`,
                    fontSize: 12,
                    fontWeight: 600,
                  },
                },
                h('span', { style: { flex: 1, minWidth: 0 } }, `压缩记录（最近 ${Array.isArray(diff.items) ? diff.items.length : 0} 次）`),
                h('button', { type: 'button', 'data-cr-diff-close': '1', onClick: closeDiff, style: smallBtnStyle }, '关闭'),
              ),
              diff.loading === true
                ? h('div', { style: { padding: '10px 12px', fontSize: 11, color: theme.subText } }, '读取中…')
                : diff.error !== undefined && diff.error !== null
                  ? h('div', { style: { padding: '10px 12px', fontSize: 11, color: COLORS.error } }, String(diff.error))
                  : Array.isArray(diff.items) && diff.items.length > 0
                    ? h(
                        'div',
                        { style: { overflowY: 'auto', padding: 4 } },
                        diff.items.map((entry, index) =>
                          h(
                            'div',
                            {
                              key: `${entry.seq ?? index}`,
                              'data-cr-diff-item': String(entry.seq ?? index),
                              style: {
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 3,
                                padding: '7px 9px',
                                borderRadius: 8,
                              },
                            },
                            h(
                              'span',
                              { style: { fontSize: 12, fontWeight: 600 } },
                              `${index === 0 ? '最近一次' : `第 ${index + 1} 近`} · ${diffStatus(entry)}`,
                            ),
                            h(
                              'span',
                              { style: { fontSize: 10, color: theme.subText } },
                              `${entry.shadowedCount ?? 0} 条旧会话 → 1 条摘要 · 约 ${fmt(entry.shadowedTokens)} tokens · ${fmtTime(entry.at)}`,
                            ),
                            h(
                              'span',
                              { style: { fontSize: 11, lineHeight: '16px', color: entry.error ? COLORS.error : theme.subText, whiteSpace: 'normal', wordBreak: 'break-word' } },
                              entry.error ? `错误：${entry.error.message ?? entry.error.name ?? '未知'}` : entry.preview || '（摘要为空）',
                            ),
                          ),
                        ),
                      )
                    : h('div', { style: { padding: '10px 12px', fontSize: 11, color: theme.subText } }, '还没有压缩记录。'),
            );

      const toastText =
        typeof toast === 'string'
          ? toast
          : toast !== null && typeof toast === 'object' && typeof toast.text === 'string'
            ? toast.text
            : '';

      return h(
        'div',
        { ref: rootRef, style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h('span', { style: { position: 'relative', display: 'inline-flex' } }, trigger, tooltip),
        panel,
        confirmPanel,
        handoffPanel,
        docsPanel,
        diffPanel,
        toastText.length > 0
          ? h(
              'div',
              {
                ref: toastRef,
                role: 'status',
                'data-cr-toast': '1',
                style: {
                  position: 'fixed',
                  // 贴着指示灯显示（操作结果就在手边），拿不到锚点才回退到顶部居中。
                  ...(anchor === null ? { top: 12, left: '50%', transform: 'translateX(-50%)' } : floatPos(360)),
                  width: 'max-content',
                  maxWidth: 'min(460px, calc(100vw - 24px))',
                  whiteSpace: 'normal',
                  wordBreak: 'break-word',
                  textAlign: 'left',
                  padding: '8px 12px',
                  borderRadius: 10,
                  ...panelChrome(theme),
                  color: theme.panelFg,
                  borderLeft: `3px solid ${/失败|错误|无法|没有可|不满足|拒绝|未知/.test(toastText) ? COLORS.ringAdviseHandoff : '#2fb344'}`,
                  fontSize: 12,
                  lineHeight: '18px',
                  zIndex: 41,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                },
              },
              h('span', { style: { flex: 1, minWidth: 0 } }, toastText),
              // 压缩执行中给一个「取消」——点了就 abort 事务（历史不变）。
              toast !== null && typeof toast === 'object' && toast.cancel === true
                ? h(
                    'button',
                    {
                      type: 'button',
                      'data-cr-toast-cancel': '1',
                      onClick: cancelRun,
                      style: { ...smallBtnStyle, flex: 'none' },
                    },
                    '取消',
                  )
                : null,
            )
          : null,
      );
    }
