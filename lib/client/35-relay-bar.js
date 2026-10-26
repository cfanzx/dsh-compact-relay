
    /* ---------------- 0.5.0 接力条（v1）：输入框上方一行「已接力自 …」 ---------------- */

    /**
     * 0.5.0 接力条 v1 —— 只做「一行摘要 + 向上弹出的下拉菜单」。
     *
     * 位置：`conversation.input.dock`（list / session scope；宿主文档原文
     *       “Full-width entries above the composer card”，即输入卡上方通栏）。
     * 显示：`readState.chain` 非 null，且这条记录是**本会话的入站记录**
     *       （childId === sessionId）。出站记录（本会话交接给了下一代）不显示
     *       「已接力自」；老宿主/没有 chain 字段时组件返回 null，不占高度。
     * 数据：GET `/api/compact-relay-state?sessionId=…`；
     *       完整链优先 GET `/api/compact-relay-chain?sessionId=…`（一次读全，祖先未加载也行），
     *       老宿主回落逐级 state。会话刚打开、宿主还没装日志
     *       时短重试几次（拿到本会话的 sessionId 后就停，不做常驻轮询/SSE）。
     *       子会话的 relay record 不带 path（F3 只写链号），缺 path 时再只读一次父
     *       会话状态，用父记录里的 path 打开交接单（childId/ordinal 校验）。
     * 交互：点击这一行 → fixed 定位、向上弹出的菜单（不被输入区裁切）：
     *       查看交接单 / 回到原会话 / 路线图（即将上线，占位禁用）。
     */

    /**
     * readState.chain → 接力条可用的最小结构；无效时返回 null（不猜、不补默认值）。
     *
     * 只接受 ordinal 为正整数的链；baseTitle/parentId/path 缺了就保持 null，
     * 由 UI 决定禁用或回落文案。老宿主的响应里没有 chain 字段 → null → 不渲染。
     *
     * @param {object|null|undefined} data `/api/compact-relay-state` 的响应
     * @param {string|undefined} sessionId 当前会话 id（dock 的 session scope 参数）
     * @returns {{ordinal:number, baseTitle:string|null, parentId:string|null, childId:string|null, scheme:'handoff-n'|'history-n'|null, path:string|null}|null}
     */
    function relayBarChainOf(data, sessionId) {
      const chain = relayChainProjectionOf(data);
      if (chain === null) return null;
      // 出站记录（本会话把接力棒交给下一代）：它不是「已接力自」，v1 不显示。
      // childId 缺失时（旧链路记录形态）不据此隐藏，遵守「chain 非 null 就显示」。
      if (chain.childId !== null && typeof sessionId === 'string' && sessionId.length > 0 && chain.childId !== sessionId) return null;
      return chain;
    }

    /**
     * 只做字段投影，不做「是不是本会话入站记录」的判断。
     *
     * 单独拆出来是给「父记录补 path」用：父会话里的同一条记录是出站的
     * （childId=本会话），用 relayBarChainOf 会被入站判断过滤掉，但它的 path
     * 恰恰是子会话要打开的那份交接单。
     *
     * @param {object|null|undefined} data `/api/compact-relay-state` 的响应
     * @returns {{ordinal:number, baseTitle:string|null, parentId:string|null, childId:string|null, scheme:'handoff-n'|'history-n'|null, path:string|null}|null}
     */
    function relayChainProjectionOf(data) {
      if (data === null || typeof data !== 'object' || data.ok === false) return null;
      const chain = data.chain;
      if (chain === null || typeof chain !== 'object') return null;
      if (!Number.isInteger(chain.ordinal) || chain.ordinal <= 0) return null;
      const text = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
      return {
        ordinal: chain.ordinal,
        baseTitle: text(chain.baseTitle),
        parentId: text(chain.parentId),
        childId: text(chain.childId),
        scheme: chain.scheme === 'handoff-n' || chain.scheme === 'history-n' ? chain.scheme : null,
        path: text(chain.path),
      };
    }

    /**
     * 服务端状态里「这一跳」的**出站**投影（0.5.1 DCR-01）。
     *
     * 父会话请求拿到的是它自己的状态：`chain` 是**父会话的入站**记录（它的上一代），
     * `next` 才是它交接给子会话的那条出站记录 —— 子会话要补的交接单 path 在 next 里。
     * 老插件（0.5.0）没有 next 字段，那时 chain 就是「最近一条记录」，直接回落到它，
     * 保证旧服务端仍可用。校验仍在调用方（childId/链号必须对得上）。
     * @param {object|null|undefined} data `/api/compact-relay-state` 的响应
     * @returns {{ordinal:number, baseTitle:string|null, parentId:string|null, childId:string|null, scheme:'handoff-n'|'history-n'|null, path:string|null}|null}
     */
    function relayOutboundProjectionOf(data) {
      if (data === null || typeof data !== 'object' || data.ok === false) return null;
      const next = data.next;
      if (next !== null && next !== undefined) {
        const projection = relayChainProjectionOf({ ok: true, chain: next });
        if (projection !== null) return projection;
      }
      // 老插件：没有 next，chain 就是最近一条记录（出站）。
      return relayChainProjectionOf(data);
    }

    /**
     * 0.5.1 DCR-03：宿主有没有恢复归档会话的接缝（readState.capabilities.unarchive）。
     *
     * 三重取值：true / false / null（老插件没有 capabilities 字段 → 不知道，按「可尝试」
     * 处理，恢复调用本身幂等）。
     * @param {object|null|undefined} data `/api/compact-relay-state` 的响应
     * @returns {boolean|null}
     */
    function relayBarUnarchiveCapabilityOf(data) {
      if (data === null || typeof data !== 'object' || data.ok === false) return null;
      const capabilities = data.capabilities;
      if (capabilities === null || typeof capabilities !== 'object') return null;
      return typeof capabilities.unarchive === 'boolean' ? capabilities.unarchive : null;
    }

    /**
     * 0.5.0：旧会话是否已被交接流程自动归档。
     *
     * 宿主 `readState` 在链有父会话时下发 `parentArchived`（boolean；服务不可用为 null）。
     * 老宿主没有这个字段 → null（客户端按「可尝试恢复」处理，恢复调用本身幂等）。
     * @param {object|null|undefined} data `/api/compact-relay-state` 的响应
     * @returns {boolean|null}
     */
    function relayBarParentArchivedOf(data) {
      if (data === null || typeof data !== 'object' || data.ok === false) return null;
      return typeof data.parentArchived === 'boolean' ? data.parentArchived : null;
    }

    /**
     * 接力条摘要：新链「历史 N：原名」，旧链「交接第 N 次：原名」。
     * @param {object} chain relayBarChainOf 的结果
     * @returns {string}
     */
    function relayBarLabelOf(chain) {
      const baseTitle = chain.baseTitle === null ? '会话' : chain.baseTitle;
      return chain.scheme === 'history-n' ? `历史 ${chain.ordinal}：${baseTitle}` : `交接第 ${chain.ordinal} 次：${baseTitle}`;
    }

    /**
     * 0.5.1 批 3：父会话侧的**出站目标**（`readState.next` 的投影，父→子入口用）。
     *
     * 与 relayOutboundProjectionOf 的区别：这里**不回落到 chain**。老插件没有 next 字段
     * （那里 chain 是「最近一条记录」，可能是本会话的入站记录），拿它当出站目标会生出
     * 「去新会话」却跳回自己的死入口。另外 childId 指回本会话的脏记录也一律不认。
     *
     * @param {object|null|undefined} data `/api/compact-relay-state` 的响应
     * @param {string|undefined} sessionId 当前会话 id
     * @returns {{ordinal:number, baseTitle:string|null, parentId:string|null, childId:string|null, scheme:'handoff-n'|'history-n'|null, path:string|null}|null}
     */
    function relayBarNextOf(data, sessionId) {
      if (data === null || typeof data !== 'object' || data.ok === false) return null;
      if (data.next === null || data.next === undefined) return null;
      const projection = relayChainProjectionOf({ ok: true, chain: data.next });
      if (projection === null || projection.childId === null) return null;
      if (typeof sessionId === 'string' && sessionId.length > 0 && projection.childId === sessionId) return null;
      return projection;
    }

    /**
     * 0.5.1 批 3：出站目标（下一代会话）是否已在归档集合里（readState.nextArchived）。
     *
     * 三重取值：true / false / null（老插件没有这个字段 → 不知道，按「可尝试恢复」处理，
     * unarchive 幂等）。父会话侧「去新会话」据此决定要不要先 unarchive 再 open。
     * @param {object|null|undefined} data `/api/compact-relay-state` 的响应
     * @returns {boolean|null}
     */
    function relayBarNextArchivedOf(data) {
      if (data === null || typeof data !== 'object' || data.ok === false) return null;
      return typeof data.nextArchived === 'boolean' ? data.nextArchived : null;
    }

    /**
     * 交接单绝对路径 → `/api/compact-relay-handoffs?file=` 只接受的 handoff-*.md 文件名。
     * 服务端只认文件名（不是全路径），这里取 basename 并做同一形态校验；不合法 → null。
     * @param {string|null} path
     * @returns {string|null}
     */
    function relayBarDocNameOf(path) {
      if (typeof path !== 'string' || path.length === 0) return null;
      const name = path.split(/[\\/]/).pop();
      return typeof name === 'string' && /^handoff-[0-9A-Za-z][0-9A-Za-z.\-_]*\.md$/.test(name) ? name : null;
    }

    /**
     * 完整交接链最多回看多少跳（0.5.1 批 3）。
     *
     * 硬上限：链路异常成环、或从某个 0.4 老链一路接力下来时，不能让界面无限逐级
     * 打接口。正常用户几跳内就到根，8 跳足够长；到顶时界面明说「只显示最近 8 层」。
     */
    const MAX_CHAIN_HOPS = 8;

    /**
     * 0.5.1 DCR-05：完整交接链一次读完的只读端点。
     *
     * 服务端直接读持久化日志/header（不加载祖先会话），因此重启后祖先都没加载也能
     * 一次拿到整条链；老插件/老宿主没有这个端点时客户端回落到逐级 state 读法。
     */
    const RELAY_CHAIN_ENDPOINT = '/api/compact-relay-chain';

    /**
     * 服务端整链响应 → 行数组；形状不合法返回 null（调用方回落旧逐级读法）。
     *
     * 行只保留画一行需要的字段；`sessionId` 是这一层会话自己的 id（不是 childId）。
     * @param {object|null|undefined} data `/api/compact-relay-chain` 的响应
     * @returns {Array<{sessionId:string, ordinal:number, baseTitle:string|null, scheme:'handoff-n'|'history-n'|null, path:string|null}>|null}
     */
    function relayChainRowsOf(data) {
      if (data === null || typeof data !== 'object' || data.ok !== true || !Array.isArray(data.rows)) return null;
      const rows = [];
      for (const row of data.rows) {
        if (row === null || typeof row !== 'object') continue;
        if (typeof row.sessionId !== 'string' || row.sessionId.length === 0) continue;
        const projection = relayChainProjectionOf({ ok: true, chain: row });
        if (projection === null) continue;
        rows.push({
          sessionId: row.sessionId,
          ordinal: projection.ordinal,
          baseTitle: projection.baseTitle,
          scheme: projection.scheme,
          path: projection.path,
        });
      }
      return rows;
    }

    /** 接力条菜单里的一行（和指示灯菜单同一套视觉，但更轻）。 */
    function relayBarItem(label, sub, key, action, meta = {}) {
      const disabled = meta.disabled === true;
      return h(
        'button',
        {
          type: 'button',
          key,
          role: 'menuitem',
          'data-cr-relay-action': key,
          disabled,
          title: meta.title ?? (disabled ? sub : undefined),
          onClick: () => {
            if (disabled || typeof action !== 'function') return;
            action();
          },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            minHeight: 32,
            padding: '5px 10px',
            border: 'none',
            borderRadius: 8,
            background: 'transparent',
            textAlign: 'left',
            cursor: disabled ? 'default' : 'pointer',
            color: 'var(--dsw-alias-label-primary, inherit)',
            opacity: disabled ? 0.55 : 1,
            font: 'inherit',
          },
          onMouseEnter: (event) => {
            if (!disabled) event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.10))';
          },
          onMouseLeave: (event) => {
            event.currentTarget.style.background = 'transparent';
          },
        },
        h(
          'span',
          { style: { display: 'flex', flexDirection: 'column', gap: 1, flex: 1, minWidth: 0 } },
          h('span', { style: { fontSize: 12, fontWeight: 500 } }, label),
          sub !== null
            ? h(
                'span',
                { style: { fontSize: 10, lineHeight: '14px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' } },
                sub,
              )
            : null,
        ),
        h(
          'span',
          { style: { flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))', whiteSpace: 'nowrap' } },
          meta.right ?? (disabled ? '' : '›'),
        ),
      );
    }

    /**
     * 接力条本体（`conversation.input.dock`，输入卡上方一行）。
     *
     * 0.5.1 批 3 起这一行有两个方向：
     *   - 入站（`chain`，子会话侧）：「已接力自 历史 N：原名」+ 回到原会话 / 完整交接链；
     *   - 出站（`next`，父会话侧）：「已交接给新会话」+ 去新会话；
     *   - 两个都有（中段会话）：同时显示两个方向的入口。
     *
     * @param {object} props ctx.slots.register 注入的 props
     * @param {string} [props.sessionId] 当前会话 id（session scope）
     * @param {(sessionId:string)=>unknown} [props.openSession] 切到某个会话（ctx.uiWorkspace.openSession）
     * @param {(sessionId:string)=>Promise<unknown>|undefined} [props.unarchiveSession] 恢复归档会话
     *   （ctx.uiWorkspace.unarchiveSession；老宿主没有 → 走本插件 HTTP recover 兜底）
     */
    function CompactRelayBar(props) {
      const sessionId = props === null || props === undefined ? undefined : props.sessionId;
      const openSession = props === null || props === undefined ? undefined : props.openSession;
      const unarchiveSession = props === null || props === undefined ? undefined : props.unarchiveSession;
      const hasSession = typeof sessionId === 'string' && sessionId.length > 0;
      const [chain, setChain] = useState(null);
      // 0.5.1 批 3：出站投影（本会话把接力棒交给了谁）。父会话侧据此显示「去新会话」。
      const [next, setNext] = useState(null);
      // null = 宿主没给归档状态（老宿主）；true/false = readState.parentArchived。
      const [parentArchived, setParentArchived] = useState(null);
      // 0.5.1 批 3：出站目标（next.childId）的归档状态（readState.nextArchived）。
      const [nextArchived, setNextArchived] = useState(null);
      // 0.5.1 DCR-03：服务端能不能恢复归档会话（readState.capabilities.unarchive）。
      // null = 老插件没有这个字段（不知道 → 仍显示入口，恢复调用幂等）。
      const [serverUnarchive, setServerUnarchive] = useState(null);
      // 0.5.1 DCR-03：打开菜单时 +1，触发一次静默刷新（别处归档/取消归档能立刻反映）。
      const [refreshKey, setRefreshKey] = useState(0);
      // 0.5.1 批 3：完整交接链（null = 没展开；点「完整交接链」后才逐级去读）。
      const [chainView, setChainView] = useState(null);
      // 上一次渲染时的 sessionId：只有真的换会话才清链（刷新不清，避免闪一下）。
      const lastSessionRef = useRef(null);
      const [open, setOpen] = useState(false);
      const [doc, setDoc] = useState(null);
      const [notice, setNotice] = useState(null);
      const [anchor, setAnchor] = useState(null);
      const theme = useAutoTheme();
      const rootRef = useRef(null);
      const triggerRef = useRef(null);
      const menuRef = useRef(null);
      const docRequestRef = useRef(0);
      const docAbortRef = useRef(null);
      // 完整链接力式的请求序号（关菜单/换会话/重试时让晚到的响应失效）与断点。
      const chainRequestRef = useRef(0);
      const chainResumeRef = useRef(null);

      /** 取消未完成的交接单读取；同时让晚到的响应失效（requestId 对不上）。 */
      const abortDoc = useCallback(() => {
        docRequestRef.current += 1;
        if (docAbortRef.current !== null) {
          try {
            docAbortRef.current.abort();
          } catch {
            /* ignore */
          }
          docAbortRef.current = null;
        }
      }, []);

      // 0.5.1 批 3：完整链的「收摊」——让晚到的逐级响应失效，并丢掉列表与断点。
      const closeChainView = useCallback(() => {
        chainRequestRef.current += 1;
        chainResumeRef.current = null;
        setChainView(null);
      }, []);

      const closeMenu = useCallback(() => {
        abortDoc();
        closeChainView();
        setOpen(false);
        setDoc(null);
        setNotice(null);
      }, [abortDoc, closeChainView]);

      // 从交接单详情回到菜单列表：取消读取，避免「返回后又被晚到的响应撑开」。
      const backToMenu = useCallback(() => {
        abortDoc();
        setDoc(null);
      }, [abortDoc]);

      // 读链状态。会话刚打开时宿主可能还没把日志装进内存（readState.sessionId 为
      // null），这时要重试几次；一旦宿主确认「就是这个会话且没有 chain」就停，
      // 普通会话不会无限打接口。fetch 失败/老宿主没有 chain → setChain(null) → 不渲染。
      useEffect(() => {
        // 换会话/没有会话时才清掉上一条链（dock 组件可能被复用而不是重挂）。
        // 0.5.1 DCR-03：`refreshKey`（打开菜单后刷新）**不清链**——否则菜单一打开、
        // 接力条会先消失再出现。
        const sessionChanged = lastSessionRef.current !== sessionId;
        lastSessionRef.current = sessionId;
        if (sessionChanged) {
          setChain(null);
          setNext(null);
          setParentArchived(null);
          setNextArchived(null);
          setServerUnarchive(null);
          setOpen(false);
          setDoc(null);
          setNotice(null);
          // 换会话：完整链的断点与结果都不再属于当前会话。
          chainRequestRef.current += 1;
          chainResumeRef.current = null;
          setChainView(null);
        }
        if (!hasSession) return undefined;
        let dead = false;
        let timer = 0;
        let attempts = 0;
        // 静默刷新（菜单打开时）：链已经在显示，失败/未加载就不再排队重试，也不清链。
        const silent = sessionChanged === false;
        const url = `/api/compact-relay-state?sessionId=${encodeURIComponent(sessionId)}`;
        const schedule = () => {
          if (dead || silent) return;
          attempts += 1;
          if (attempts > 12) return;
          timer = setTimeout(() => {
            void load();
          }, Math.min(500 * attempts, 3000));
        };
        async function loadParentPath(localChain) {
          try {
            const res = await fetch(`/api/compact-relay-state?sessionId=${encodeURIComponent(localChain.parentId)}`, {
              cache: 'no-store',
            });
            if (dead || !res.ok) return;
            const parentData = await res.json().catch(() => null);
            if (dead) return;
            // 0.5.1 DCR-01：父会话的 chain 是它自己的入站记录，这一跳的出站在 next 里。
            const parentChain = relayOutboundProjectionOf(parentData);
            if (
              parentChain === null ||
              parentChain.childId !== sessionId ||
              parentChain.ordinal !== localChain.ordinal ||
              parentChain.path === null
            ) {
              return;
            }
            setChain((previous) => (previous === null ? previous : { ...previous, path: parentChain.path }));
          } catch {
            /* 父会话读不到（未加载/已归档）：保持「暂无交接单」，不影响接力条本身 */
          }
        }
        async function load() {
          try {
            const res = await fetch(url, { cache: 'no-store' });
            if (dead) return;
            if (!res.ok) {
              // 4xx（鉴权/端点不存在）等下去也不会变；5xx/网络抖动才重试。
              if (res.status >= 400 && res.status < 500) return;
              schedule();
              return;
            }
            const data = await res.json().catch(() => null);
            if (dead) return;
            if (data !== null && typeof data === 'object' && data.ok === false) return;
            const parsed = relayBarChainOf(data, sessionId);
            // 0.5.1 批 3：父会话侧的出站目标。它和 chain 是两条独立的投影：子会话只有
            // chain，父会话只有 next，中段会话两个都有 —— 任一存在就要渲染接力条。
            const outbound = relayBarNextOf(data, sessionId);
            if (parsed !== null || outbound !== null) {
              setChain(parsed);
              setNext(outbound);
              setParentArchived(relayBarParentArchivedOf(data));
              setNextArchived(relayBarNextArchivedOf(data));
              setServerUnarchive(relayBarUnarchiveCapabilityOf(data));
              // F3 的子会话记录不带 path（交接单路径只写在父记录里）：向父会话读回
              // 同一条链，childId 指回本会话且链号一致时才采用它的 path。只读、失败
              // 就保持「暂无交接单」；不碰宿主逻辑，也不改交接流程。
              if (parsed !== null && parsed.path === null && parsed.parentId !== null) void loadParentPath(parsed);
              return;
            }
            // sessionId 对不上/为 null → 宿主还没加载本会话，继续等；对得上 → 确定没有链。
            const loaded =
              data !== null && typeof data === 'object' && typeof data.sessionId === 'string' && data.sessionId === sessionId;
            if (loaded) {
              // 静默刷新时宿主确认「没有链」也不清（保持在显示的接力条，避免误伤）。
              if (!silent) {
                setChain(null);
                setNext(null);
                setParentArchived(null);
                setNextArchived(null);
                setServerUnarchive(null);
              }
            } else schedule();
          } catch {
            /* 宿主不在/网络失败：保持「没有链」—— 不显示，不占高度；稍后再试 */
            schedule();
          }
        }
        void load();
        return () => {
          dead = true;
          if (timer !== 0) clearTimeout(timer);
        };
      }, [hasSession, sessionId, refreshKey]);

      // 菜单打开时按这一行的真实位置重算锚点（滚动/缩放不漂）。
      useEffect(() => {
        if (!open) return undefined;
        const update = () => {
          const root = rootRef.current;
          const el = root === null || root === undefined ? null : root.firstElementChild;
          if (el === null || el === undefined || typeof el.getBoundingClientRect !== 'function') return;
          const rect = el.getBoundingClientRect();
          setAnchor({
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
          });
        };
        update();
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        return () => {
          window.removeEventListener('scroll', update, true);
          window.removeEventListener('resize', update);
        };
      }, [open]);

      // 点外面 / Esc 关闭菜单与交接单查看。
      useEffect(() => {
        if (!open) return undefined;
        const inside = (target) => {
          const root = rootRef.current;
          const menu = menuRef.current;
          return (root !== null && root !== undefined && root.contains(target)) || (menu !== null && menu !== undefined && menu.contains(target));
        };
        const onDown = (event) => {
          if (inside(event.target)) return;
          closeMenu();
        };
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          closeMenu();
          const trigger = triggerRef.current;
          if (trigger !== null && trigger !== undefined && typeof trigger.focus === 'function') {
            window.setTimeout(() => trigger.focus(), 0);
          }
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDown);
          document.removeEventListener('keydown', onKey);
        };
      }, [open, closeMenu]);

      // 打开后把焦点送进第一个可操作项（键盘用户不用再 Tab 找）。
      useEffect(() => {
        if (!open || doc !== null) return;
        const menu = menuRef.current;
        if (menu === null || menu === undefined || typeof menu.querySelector !== 'function') return;
        const first = menu.querySelector('button:not(:disabled)');
        if (first !== null && first !== undefined && typeof first.focus === 'function') first.focus();
      }, [open, doc]);

      const toggleMenu = useCallback((event) => {
        const current = event === null || event === undefined ? null : event.currentTarget;
        if (current !== null && current !== undefined && typeof current.getBoundingClientRect === 'function') {
          const rect = current.getBoundingClientRect();
          setAnchor({
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
          });
        }
        abortDoc();
        setNotice(null);
        setDoc(null);
        // 每次开/关都把完整链收掉：重开菜单从主列表开始（不预加载，也不留旧会话的链）。
        closeChainView();
        // 0.5.1 DCR-03：打开菜单前刷新一次 state —— 归档集合可能在别处被改（侧栏
        // 取消归档 / 另一个窗口归档），沿用打开前的旧状态会让「恢复旧会话」变死入口。
        if (!open) setRefreshKey((key) => key + 1);
        setOpen((value) => !value);
      }, [abortDoc, closeChainView, open]);

      const loadDoc = useCallback(async (name) => {
        if (typeof name !== 'string' || name.length === 0) return;
        if (docAbortRef.current !== null) {
          try {
            docAbortRef.current.abort();
          } catch {
            /* ignore */
          }
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        docAbortRef.current = controller;
        const requestId = ++docRequestRef.current;
        setDoc({ loading: true, name });
        setNotice(null);
        try {
          const res = await fetch(`/api/compact-relay-handoffs?file=${encodeURIComponent(name)}`, {
            cache: 'no-store',
            ...(controller === null ? {} : { signal: controller.signal }),
          });
          const data = await res.json().catch(() => ({}));
          if (requestId !== docRequestRef.current) return;
          if (!res.ok || data.ok === false) throw new Error(data && data.message ? String(data.message) : '读取失败');
          setDoc({
            loading: false,
            name,
            content: typeof data.content === 'string' ? data.content : '',
            path: typeof data.path === 'string' ? data.path : null,
          });
        } catch (error) {
          if (requestId !== docRequestRef.current || (error && error.name === 'AbortError')) return;
          setDoc({
            loading: false,
            name,
            error: '读取失败：' + (error && error.message ? error.message : '未知错误'),
          });
        } finally {
          if (requestId === docRequestRef.current) docAbortRef.current = null;
        }
      }, []);

      /** 切到某个会话（不碰归档状态）；成功发起返回 true。 */
      const openTarget = useCallback(
        (target, failureText) => {
          if (typeof openSession !== 'function') {
            setNotice('这个宿主不支持切换会话，无法自动打开会话。');
            setOpen(true);
            return false;
          }
          const failed = (error) => {
            setNotice(failureText + '：' + (error && error.message ? error.message : '未知错误'));
            setOpen(true);
          };
          try {
            const result = openSession(target);
            if (result !== null && result !== undefined && typeof result.then === 'function') {
              result.catch(failed);
            }
            setOpen(false);
            setDoc(null);
            closeChainView();
            return true;
          } catch (error) {
            failed(error);
            return false;
          }
        },
        [closeChainView, openSession],
      );

      /**
       * 0.5.0 / 0.5.1 DCR-03：恢复归档会话并切过去（父会话、完整链上任意一层、下一代都走这里）。
       *
       * 两条通道：
       *   1. 宿主 Client 侧 `ctx.uiWorkspace.unarchiveSession`（与侧栏「取消归档」同一条
       *      接缝，会同步更新本地归档集合）；
       *   2. 本插件 HTTP `action:'recover'`（服务端 workspaceRegistry.unarchiveSession）——
       *      老宿主没有客户端 API 时的兜底。
       * 失败重试：一轮 unarchive+open 失败后换另一条通道再试一次（只有一条通道时同通道
       * 重试），仍失败才提示错误。unarchive 幂等：重试不会把会话再归档，未归档时是 no-op。
       *
       * @param {string} target 目标会话 id
       * @param {{markParent?:boolean, failureText?:string, restoredText?:string}} [options]
       *   markParent：成功后把本地「父会话归档状态」改成未归档（只有父会话需要）。
       */
      /**
       * 恢复归档会话的两条通道（0.5.1 DCR-03 抽出，DCR-05 的「打开并继续」复用）。
       *
       *   1. 宿主 Client 侧 `ctx.uiWorkspace.unarchiveSession`（与侧栏「取消归档」同一条
       *      接缝，会同步更新本地归档集合）；
       *   2. 本插件 HTTP `action:'recover'`（服务端 workspaceRegistry.unarchiveSession）——
       *      老宿主没有客户端 API 时的兜底。
       *
       * 返回按优先级排好的尝试序列；调用方逐个 await，失败换下一条。
       * @param {string} target 目标会话 id
       * @returns {Array<() => Promise<unknown>>}
       */
      const unarchiveChannels = useCallback(
        (target) => {
          const unarchiveViaHost = async () => {
            if (typeof unarchiveSession !== 'function') throw new Error('这个宿主没有 unarchiveSession');
            await unarchiveSession(target);
          };
          const unarchiveViaHttp = async () => {
            const res = await fetch('/api/compact-relay-action', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              cache: 'no-store',
              body: JSON.stringify({ action: 'recover', sessionId: target }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || data === null || data.ok === false) {
              throw new Error(data !== null && typeof data.message === 'string' ? data.message : '恢复接口不可用');
            }
          };
          // 通道顺序：宿主 API 优先；只有一条通道时同通道重试（「失败重试 unarchive+open」）。
          return typeof unarchiveSession === 'function'
            ? [unarchiveViaHost, unarchiveViaHttp]
            : [unarchiveViaHttp, unarchiveViaHttp];
        },
        [unarchiveSession],
      );

      const restoreAndOpen = useCallback(
        (target, options = {}) => {
          const markParent = options.markParent === true;
          const failureText = typeof options.failureText === 'string' ? options.failureText : '恢复旧会话失败';
          const restoredText =
            typeof options.restoredText === 'string'
              ? options.restoredText
              : '旧会话已恢复，但这个宿主不支持自动切换；请从侧栏打开。';
          setNotice(null);

          const channels = unarchiveChannels(target);

          // 一轮 = unarchive 成功后再 open。open 失败也走下一轮（可能恢复没生效/宿主还没刷新）。
          const attempt = async (unarchive) => {
            await unarchive();
            if (markParent) setParentArchived(false);
            if (typeof openSession !== 'function') {
              setNotice(restoredText);
              setOpen(true);
              return;
            }
            await openSession(target);
            setOpen(false);
            setDoc(null);
            closeChainView();
          };

          return (async () => {
            let failure = null;
            for (const channel of channels) {
              try {
                await attempt(channel);
                return;
              } catch (error) {
                failure = error;
              }
            }
            setNotice(failureText + '：' + (failure && failure.message ? failure.message : '未知错误'));
            setOpen(true);
          })();
        },
        [closeChainView, openSession, unarchiveChannels],
      );

      // 0.5.1 DCR-03：能不能恢复 = 客户端有宿主 API，或服务端说它有 registry.unarchiveSession。
      // serverUnarchive === null（老插件没有 capabilities 字段）按「可尝试」处理（recover 幂等）。
      const canRestore = typeof unarchiveSession === 'function' || serverUnarchive !== false;

      const goParent = useCallback(() => {
        setNotice(null);
        if (chain === null || chain.parentId === null) return;
        // 已归档（true）或宿主没给归档状态（null）：都不能假设「未归档」直接打开 ——
        // 打开被归档的会话会被宿主拒绝，这个入口就成了死路（DCR-03）。
        // 有恢复能力时先 unarchive 再 open（unarchive 幂等，未归档时是 no-op）。
        if (parentArchived !== false && canRestore) {
          void restoreAndOpen(chain.parentId, { markParent: true });
          return;
        }
        openTarget(chain.parentId, '打不开原会话');
      }, [canRestore, chain, openTarget, parentArchived, restoreAndOpen]);

      /**
       * 0.5.1 批 3（TD-01）：父会话侧「去新会话」—— 用出站记录的目标 childId 切过去。
       *
       * 下一代可能已经被用户归档（`nextArchived`），宿主同样拒绝打开归档会话，所以
       * 和「回到原会话」同口径：归档/不知道就先 unarchive 再 open（unarchive 幂等）。
       */
      const goNext = useCallback(() => {
        setNotice(null);
        if (next === null || next.childId === null) return;
        if (nextArchived !== false && canRestore) {
          void restoreAndOpen(next.childId, {
            failureText: '恢复新会话失败',
            restoredText: '新会话已恢复，但这个宿主不支持自动切换；请从侧栏打开。',
          });
          return;
        }
        openTarget(next.childId, '打不开新会话');
      }, [canRestore, next, nextArchived, openTarget, restoreAndOpen]);

      /** 完整链某一层：跳过去（旧会话默认已归档，同口径先恢复再切）。 */
      const openAncestor = useCallback(
        (target) => {
          if (typeof target !== 'string' || target.length === 0) return;
          setNotice(null);
          if (canRestore) {
            void restoreAndOpen(target, {
              failureText: '打不开旧会话',
              restoredText: '旧会话已恢复，但这个宿主不支持自动切换；请从侧栏打开。',
            });
            return;
          }
          openTarget(target, '打不开旧会话');
        },
        [canRestore, openTarget, restoreAndOpen],
      );

      /**
       * 0.5.1 DCR-05：优先让服务端一次读出整条链（只读持久化日志，不加载祖先会话）。
       *
       * 返回 true = 端点可用且已把结果写进 chainView（成功或带 unreadable 的部分结果）；
       * false = 老插件/老宿主没有这个端点、或响应形状不对 —— 调用方回落到旧的逐级读法。
       *
       * 为什么能解决「只显示 1 层」：宿主对未加载的会话返回 `sessionId:null`，旧逐级
       * GET 只能停住；新端点从持久化 header/log 里读，祖先没打开也能列全。
       *
       * @param {number} requestId 与 chainRequestRef 对齐的请求序号（晚到响应作废）
       * @returns {Promise<boolean>}
       */
      const loadChainViaServer = useCallback(
        async (requestId) => {
          let res = null;
          let data = null;
          try {
            res = await fetch(`${RELAY_CHAIN_ENDPOINT}?sessionId=${encodeURIComponent(sessionId)}`, {
              cache: 'no-store',
            });
            if (res.ok) data = await res.json().catch(() => null);
          } catch {
            res = null;
            data = null;
          }
          if (requestId !== chainRequestRef.current) return true;
          if (res === null || !res.ok || data === null || typeof data !== 'object' || data.ok !== true) return false;
          const rows = relayChainRowsOf(data);
          if (rows === null) return false;
          const unreadable = data.unreadable;
          const unreadableId =
            unreadable !== null && typeof unreadable === 'object' && typeof unreadable.sessionId === 'string'
              ? unreadable.sessionId
              : null;
          // not-found = 持久化里根本没有这个会话（已删除/从未落盘）：打开也救不回来，
          // 只给「重试」，不造一个必然失败的入口（与 DCR-03 隐藏死入口同口径）。
          // error = 读日志临时失败：会话可能只是没加载/没落盘，允许「打开并继续」。
          const blocked =
            unreadableId !== null && unreadable.reason !== 'not-found'
              ? { sessionId: unreadableId, reason: 'error' }
              : null;
          // 服务端已经一次读完：这里没有逐级断点，重试就是重发一次整链请求。
          chainResumeRef.current = null;
          setChainView({
            rows,
            loading: false,
            error: unreadableId === null ? null : '无法读取更早的链路',
            done: unreadableId === null && data.done !== false,
            capped: data.capped === true,
            blocked,
          });
          return true;
        },
        [sessionId],
      );

      /**
       * 0.5.1 批 3 / DCR-05：完整交接链 —— **按需**读祖先会话（不预加载、无常驻轮询）。
       *
       * 先走一次整链端点（见上）；老宿主没有端点时回落逐级 state 读法：
       * 每一行来自「下一层（子）会话的入站 chain」，ordinal/baseTitle 正好是那一层会话
       * 改名后的「历史 N：原名」；交接单路径优先用它自己记录里的 path，缺了再向那一层
       * 会话的 state 要出站 next 的 path（和接力条补 path 同口径，childId/链号都要对得上）。
       *
       * 频率口径：点开「完整交接链」后才开始拉；回落路径每层一次 state GET（不并发、不轰炸）；
       * 最多 `MAX_CHAIN_HOPS` 跳；`seen` 按 sessionId 去重（链路万一成环也不会转圈）。
       * 某层读不到就停在断点：已读到的行保留；未加载给「打开并继续」，其它失败给「重试」。
       *
       * @param {{cursor:object|null, childId:string, rows:Array, seen:Set<string>}|null} resume
       *   断点；null/undefined = 从本会话重新开始（先试整链端点）。
       */
      const loadChain = useCallback(
        async (resume) => {
          const requestId = ++chainRequestRef.current;
          // 0.5.1 DCR-05：先试一次整链端点；老宿主没有就回落逐级 state（下面的旧逻辑）。
          if (resume === undefined || resume === null) {
            const handled = await loadChainViaServer(requestId);
            if (handled) return;
            if (requestId !== chainRequestRef.current) return;
          }
          const start =
            resume === undefined || resume === null
              ? {
                  cursor: chain === null ? null : { ...chain },
                  childId: sessionId,
                  rows: [],
                  seen: new Set(typeof sessionId === 'string' && sessionId.length > 0 ? [sessionId] : []),
                }
              : resume;
          let cursor = start.cursor;
          let childId = start.childId;
          let seen = start.seen;
          let rows = start.rows;
          const publish = (patch) => {
            if (requestId !== chainRequestRef.current) return;
            setChainView({ rows, loading: true, error: null, done: false, capped: false, blocked: null, ...patch });
          };
          publish({});
          while (cursor !== null && cursor.parentId !== null) {
            if (rows.length >= MAX_CHAIN_HOPS) {
              publish({ loading: false, done: true, capped: true });
              return;
            }
            const parentId = cursor.parentId;
            if (seen.has(parentId)) {
              // 链路成环/自指：到此为止，不重复列同一条会话。
              publish({ loading: false, done: true, capped: false });
              return;
            }
            let data = null;
            try {
              const res = await fetch(`/api/compact-relay-state?sessionId=${encodeURIComponent(parentId)}`, {
                cache: 'no-store',
              });
              if (requestId !== chainRequestRef.current) return;
              // 4xx（鉴权/端点不存在）与 5xx 一样当作「这一层读不到」：不再自动重试，
              // 交给用户的「重试」入口（自动重试只留给接力条自己那次 state）。
              if (res.ok) data = await res.json().catch(() => null);
            } catch {
              data = null;
            }
            if (requestId !== chainRequestRef.current) return;
            // 读不到 = HTTP/解析失败，或者**宿主还没把这一层加载进内存**（`sessionId` 对不上，
            // 重启后祖先会话通常就是这样 —— 不能把「没加载」当成「没有父会话」到头了）。
            // 两种都停在断点：已读到的行保留。宿主明确回 sessionId:null 时给出可操作入口
            // 「上一层会话未打开 → 打开并继续」（DCR-05 兜底）；其它失败仍只给「重试」。
            const loaded =
              data !== null &&
              typeof data === 'object' &&
              data.ok !== false &&
              typeof data.sessionId === 'string' &&
              data.sessionId === parentId;
            if (!loaded) {
              chainResumeRef.current = { cursor, childId, rows, seen };
              const notLoaded =
                data !== null && typeof data === 'object' && data.ok !== false && data.sessionId === null;
              publish({
                loading: false,
                error: notLoaded ? '上一层会话未打开' : '无法读取更早的链路',
                done: false,
                blocked: notLoaded ? { sessionId: parentId, reason: 'unloaded' } : null,
              });
              return;
            }
            const outbound = relayBarNextOf(data, parentId);
            const path =
              cursor.path !== null
                ? cursor.path
                : outbound !== null && outbound.childId === childId && outbound.ordinal === cursor.ordinal
                  ? outbound.path
                  : null;
            rows = [
              ...rows,
              { sessionId: parentId, ordinal: cursor.ordinal, baseTitle: cursor.baseTitle, scheme: cursor.scheme, path },
            ];
            seen = new Set([...seen, parentId]);
            publish({});
            childId = parentId;
            // 这一层自己的入站 chain 才是「更早的链路」；没有就说明到头了。
            cursor = relayChainProjectionOf(data);
          }
          chainResumeRef.current = null;
          publish({ loading: false, done: true, capped: false });
        },
        [chain, loadChainViaServer, sessionId],
      );

      const openChainList = useCallback(() => {
        setNotice(null);
        setDoc(null);
        chainResumeRef.current = null;
        void loadChain(null);
      }, [loadChain]);

      /** 某层读不到之后的「重试」：从断点继续，已读到的层不重复拉。 */
      const retryChain = useCallback(() => {
        const resume = chainResumeRef.current;
        if (resume === null || resume === undefined) {
          void loadChain(null);
          return;
        }
        void loadChain(resume);
      }, [loadChain]);

      /**
       * 0.5.1 DCR-05 兜底：等宿主把刚刚 openSession 的会话装进内存。
       *
       * 只读 `/api/compact-relay-state?sessionId=`，`sessionId` 对得上才算加载完成；
       * 最多 8 次（约 1 秒）。宿主打开会话需要一点时间，立刻续读会再次撞上「未加载」。
       * @param {string} target 刚打开的会话 id
       * @returns {Promise<boolean>}
       */
      const waitForSessionLoaded = useCallback(async (target) => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            const res = await fetch(`/api/compact-relay-state?sessionId=${encodeURIComponent(target)}`, {
              cache: 'no-store',
            });
            if (res.ok) {
              const data = await res.json().catch(() => null);
              if (
                data !== null &&
                typeof data === 'object' &&
                data.ok !== false &&
                data.sessionId === target
              ) {
                return true;
              }
            }
          } catch {
            /* 宿主还没加载：继续等 */
          }
          if (attempt < 7) await new Promise((resolve) => setTimeout(resolve, 120));
        }
        return false;
      }, []);

      /**
       * 0.5.1 DCR-05 兜底：断点处「打开并继续」。
       *
       *   1. 双通道 unarchive（复用现有；幂等，未归档时 no-op，失败也继续尝试 open）；
       *   2. `openSession(parentId)` 打开上一层会话；
       *   3. 等宿主加载后自动 `loadChain(resume)`；加载不上就提示「已打开，再点完整交接链继续」。
       *
       * 注意：真实宿主打开会话会切路由，组件可能被卸载——此时后续 setState 是 no-op，
       * 不会报错；用户在新会话里点「完整交接链」也能接着看。
       */
      const openAndResumeChain = useCallback(async () => {
        const blocked = chainView === null ? null : chainView.blocked;
        if (blocked === null || blocked === undefined || typeof blocked.sessionId !== 'string') return;
        const target = blocked.sessionId;
        const resume = chainResumeRef.current;
        setNotice(null);
        setChainView((previous) =>
          previous === null ? previous : { ...previous, loading: true, error: null, blocked: null },
        );

        // 先恢复（两条通道都试；都失败也不阻塞打开——也许本来就没归档）。
        for (const channel of unarchiveChannels(target)) {
          try {
            await channel();
            break;
          } catch {
            /* 换下一条通道；仍失败就直接尝试打开 */
          }
        }

        if (typeof openSession !== 'function') {
          setNotice('这个宿主不支持切换会话，无法自动打开上一层会话。');
          setChainView((previous) =>
            previous === null ? previous : { ...previous, loading: false, error: '上一层会话未打开', blocked },
          );
          return;
        }
        try {
          await openSession(target);
        } catch (error) {
          setNotice('打开上一层会话失败：' + (error && error.message ? error.message : '未知错误'));
          setChainView((previous) =>
            previous === null ? previous : { ...previous, loading: false, error: '上一层会话未打开', blocked },
          );
          return;
        }

        if (!(await waitForSessionLoaded(target))) {
          setNotice('已打开上一层会话，再点「完整交接链」继续。');
          setChainView((previous) =>
            previous === null ? previous : { ...previous, loading: false, error: '上一层会话未打开', blocked },
          );
          return;
        }
        await loadChain(resume);
      }, [chainView, loadChain, openSession, unarchiveChannels, waitForSessionLoaded]);

      /** 从完整链返回主菜单（保留断点？不：回主菜单再从主菜单进来就是重新拉一遍）。 */
      const backFromChain = useCallback(() => {
        closeChainView();
      }, [closeChainView]);

      // 两个方向都没有 → 什么都不渲染（不占 composerStack 的高度）。
      if (chain === null && next === null) return null;

      const hasParent = chain !== null && chain.parentId !== null;
      const hasNext = next !== null && next.childId !== null;
      // 父会话侧（只有出站记录）这一行的摘要文案：它没有「已接力自」的来路。
      const label = chain !== null ? relayBarLabelOf(chain) : '已交接给新会话';
      // 「查看交接单」：子会话侧看进站那一跳，父会话侧看出站那一跳（不混用）。
      const docPath = chain !== null ? chain.path : next === null ? null : next.path;
      const docName = relayBarDocNameOf(docPath);
      // 归档状态已知且未归档 → 不需要恢复入口；true（已归档）或 null（老宿主不知道）
      // 都显示——恢复调用幂等，宁可多一个入口，也不让用户的旧会话找不回来。
      // 0.5.1 DCR-03：宿主客户端与服务端都没有恢复能力时**隐藏**入口（点了必然失败）。
      const showRestore = hasParent && parentArchived !== false && canRestore;
      const vw = typeof window === 'undefined' ? 1280 : window.innerWidth;
      const vh = typeof window === 'undefined' ? 900 : window.innerHeight;
      const chainOpen = chainView !== null && doc === null;
      const menuWidth = Math.min(doc !== null ? 420 : chainOpen ? 336 : 272, Math.max(240, vw - 16));
      const estimatedHeight = doc !== null ? 360 : chainOpen ? 380 : 168;
      const anchorTop = anchor === null ? vh - 96 : anchor.top;
      const anchorBottom = anchor === null ? vh - 40 : anchor.bottom;
      const openUp = anchorTop >= Math.min(estimatedHeight, vh - 16) + 12;
      const left = Math.max(8, Math.min(anchor === null ? 8 : anchor.left, Math.max(8, vw - menuWidth - 8)));
      const position = openUp
        ? { left, bottom: Math.max(8, vh - anchorTop + 6) }
        : { left, top: Math.min(Math.max(8, anchorBottom + 6), Math.max(8, vh - Math.min(estimatedHeight, vh - 16) - 8)) };

      const docPanel =
        doc === null
          ? null
          : h(
              'div',
              { role: 'dialog', 'aria-label': '交接单', 'data-cr-relay-doc': '1', style: { display: 'flex', flexDirection: 'column', minHeight: 0 } },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 10px',
                    borderBottom: `1px solid ${theme.panelBorder}`,
                    fontSize: 12,
                    fontWeight: 600,
                  },
                },
                h('span', { style: { flex: 1, minWidth: 0 } }, '交接单'),
                h(
                  'button',
                  {
                    type: 'button',
                    'data-cr-relay-doc-back': '1',
                    onClick: backToMenu,
                    style: { border: `1px solid ${theme.panelBorder}`, borderRadius: 6, padding: '2px 8px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: theme.panelFg },
                  },
                  '← 返回',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    'data-cr-relay-doc-close': '1',
                    onClick: closeMenu,
                    style: { border: `1px solid ${theme.panelBorder}`, borderRadius: 6, padding: '2px 8px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: theme.panelFg },
                  },
                  '关闭',
                ),
              ),
              doc.loading === true
                ? h('div', { style: { padding: '10px 12px', fontSize: 11, color: theme.subText } }, '读取中…')
                : doc.error !== undefined && doc.error !== null
                  ? h('div', { style: { padding: '10px 12px', fontSize: 11, color: COLORS.error } }, String(doc.error))
                  : h(
                      'div',
                      { style: { overflowY: 'auto', overflowX: 'hidden', padding: '8px 12px', fontSize: 11, lineHeight: '16px', maxHeight: 'min(52vh, 320px)', wordBreak: 'break-word' } },
                      renderMarkdownLite(doc.content ?? ''),
                    ),
            );

      /**
       * 完整链的一行：整行点「跳到这一层会话」，行尾单独一个「交接单」入口。
       *
       * 交接单路径只认 handoff-*.md 的 basename（与接力条同一套校验；接口只收
       * basename），没有 path 就禁用——不给必然失败的入口。
       * @param {{sessionId:string, ordinal:number|null, baseTitle:string|null, scheme:string|null, path:string|null}} row
       */
      const chainRowItemOf = (row) => {
        const rowDoc = relayBarDocNameOf(row.path);
        return h(
          'div',
          {
            key: row.sessionId,
            'data-cr-relay-chain-row': row.sessionId,
            style: { display: 'flex', alignItems: 'stretch', gap: 6, borderRadius: 8 },
          },
          h(
            'button',
            {
              type: 'button',
              'data-cr-relay-chain-open': row.sessionId,
              title: `打开 ${relayBarLabelOf(row)}`,
              onClick: () => openAncestor(row.sessionId),
              style: {
                flex: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
                padding: '5px 8px',
                border: 'none',
                borderRadius: 8,
                background: 'transparent',
                textAlign: 'left',
                color: 'var(--dsw-alias-label-primary, inherit)',
                font: 'inherit',
                cursor: 'pointer',
              },
              onMouseEnter: (event) => {
                event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.10))';
              },
              onMouseLeave: (event) => {
                event.currentTarget.style.background = 'transparent';
              },
            },
            h('span', { style: { fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, relayBarLabelOf(row)),
            h(
              'span',
              { style: { fontSize: 10, lineHeight: '14px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' } },
              '打开这个会话（已归档会自动恢复）',
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              'data-cr-relay-chain-doc': row.sessionId,
              disabled: rowDoc === null,
              title: rowDoc === null ? '暂无交接单：这一层没有记录交接单路径' : '打开这一跳的交接单',
              onClick: () => {
                if (rowDoc !== null) void loadDoc(rowDoc);
              },
              style: {
                flex: 'none',
                alignSelf: 'center',
                border: `1px solid ${theme.panelBorder}`,
                borderRadius: 6,
                padding: '3px 8px',
                fontSize: 11,
                background: 'transparent',
                color: 'inherit',
                cursor: rowDoc === null ? 'default' : 'pointer',
                opacity: rowDoc === null ? 0.55 : 1,
              },
            },
            '交接单',
          ),
        );
      };

      /**
       * 完整交接链面板（点「完整交接链」后才出现；doc === null 时替换主列表）。
       *
       * 数据是按需逐级读来的（见 loadChain）：读取中显示进度行，读不到显示错误 +
       * 重试，到 8 跳上限显示「只显示最近 8 层」。「← 返回」回主菜单 —— 出错也只
       * 影响这一块，不阻断其他入口。
       */
      const chainPanel =
        chainView === null
          ? null
          : h(
              'div',
              { 'data-cr-relay-chain': '1', style: { display: 'flex', flexDirection: 'column', minHeight: 0 } },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 10px',
                    borderBottom: `1px solid ${theme.panelBorder}`,
                    fontSize: 12,
                    fontWeight: 600,
                  },
                },
                h('span', { style: { flex: 1, minWidth: 0 } }, '完整交接链'),
                h(
                  'button',
                  {
                    type: 'button',
                    'data-cr-relay-chain-back': '1',
                    onClick: backFromChain,
                    style: { border: `1px solid ${theme.panelBorder}`, borderRadius: 6, padding: '2px 8px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: theme.panelFg },
                  },
                  '← 返回',
                ),
              ),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 5px', overflowY: 'auto', overflowX: 'hidden', maxHeight: 'min(46vh, 300px)' } },
                chainView.rows.map((row) => chainRowItemOf(row)),
                chainView.loading === true
                  ? h(
                      'div',
                      { 'data-cr-relay-chain-loading': '1', style: { padding: '5px 10px', fontSize: 11, color: theme.subText } },
                      '读取更早的链路…',
                    )
                  : null,
                chainView.capped === true
                  ? h(
                      'div',
                      { 'data-cr-relay-chain-capped': '1', style: { padding: '5px 10px', fontSize: 10, color: theme.subText } },
                      `只显示最近 ${MAX_CHAIN_HOPS} 层`,
                    )
                  : null,
                chainView.error !== null
                  ? h(
                      'div',
                      {
                        'data-cr-relay-chain-error': '1',
                        // 0.5.1 DCR-05：断点处是哪一层没读到（空串 = 普通读取失败，没有可打开的会话）。
                        'data-cr-relay-chain-blocked':
                          chainView.blocked === null || chainView.blocked === undefined
                            ? ''
                            : chainView.blocked.sessionId,
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '6px 10px',
                          fontSize: 11,
                          color: 'var(--dsw-alias-state-error-primary, #D92D20)',
                        },
                      },
                      h('span', { style: { flex: 1, minWidth: 0 } }, String(chainView.error)),
                      chainView.blocked !== null && chainView.blocked !== undefined
                        ? h(
                            'button',
                            {
                              type: 'button',
                              'data-cr-relay-chain-open-parent': chainView.blocked.sessionId,
                              onClick: () => {
                                void openAndResumeChain();
                              },
                              title: `打开上一层会话 ${chainView.blocked.sessionId}，加载后自动续读`,
                              style: { flex: 'none', border: `1px solid ${theme.panelBorder}`, borderRadius: 6, padding: '2px 8px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: theme.panelFg },
                            },
                            '打开并继续',
                          )
                        : null,
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-cr-relay-chain-retry': '1',
                          onClick: retryChain,
                          style: { flex: 'none', border: `1px solid ${theme.panelBorder}`, borderRadius: 6, padding: '2px 8px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: theme.panelFg },
                        },
                        '重试',
                      ),
                    )
                  : null,
              ),
            );

      const menu =
        open === true
          ? h(
              'div',
              {
                ref: menuRef,
                role: 'menu',
                'aria-label': '接力菜单',
                'data-cr-relay-menu': '1',
                style: {
                  position: 'fixed',
                  ...position,
                  width: menuWidth,
                  maxWidth: 'calc(100vw - 16px)',
                  maxHeight: 'min(65vh, 460px)',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  padding: doc === null && chainView === null ? 5 : 0,
                  borderRadius: 12,
                  ...panelChrome(theme),
                  color: theme.panelFg,
                  // 顶层：高于指示灯菜单/确认卡（39–44），避免被输入区或其它浮层盖住。
                  zIndex: 60,
                },
              },
              notice !== null
                ? h(
                    'div',
                    { 'data-cr-relay-notice': '1', style: { padding: '7px 10px', fontSize: 11, lineHeight: '15px', color: 'var(--dsw-alias-state-error-primary, #D92D20)' } },
                    notice,
                  )
                : null,
              // 交接单面板 / 完整链面板都替换主列表；「← 返回」按来源回到链列表或主菜单。
              docPanel ??
                chainPanel ??
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column' } },
                  relayBarItem('查看交接单', docName === null ? '这一链没有记录交接单路径' : '打开本次交接的九段交接单', 'doc', () => {
                    void loadDoc(docName);
                  }, {
                    disabled: docName === null,
                    // 需求文案：无 path 时明确提示「暂无交接单」。
                    right: docName === null ? '暂无交接单' : '›',
                    title: docName === null ? '暂无交接单：这条接力记录里没有交接单路径（旧记录，或父会话已不在）' : '打开交接单',
                  }),
                  // 0.5.1 批 3（TD-01）：父会话侧的去向 —— 出站记录里的 childId。
                  hasNext
                    ? relayBarItem('去新会话', '切到这次交接出来的新会话', 'next', goNext, {
                        right: '›',
                        title: `打开新会话 ${next.childId}${nextArchived === true ? '（已归档：打开前先恢复）' : ''}`,
                      })
                    : null,
                  chain !== null
                    ? relayBarItem('回到原会话', hasParent ? '切到上一个会话，继续看那边历史' : '这条记录没有父会话 id', 'parent', goParent, {
                        disabled: !hasParent,
                        right: hasParent ? '›' : '不可用',
                        title: hasParent ? `打开原会话 ${chain.parentId}` : undefined,
                      })
                    : null,
                  showRestore
                    ? relayBarItem(
                        '恢复旧会话',
                        parentArchived === true
                          ? '旧会话已归档：恢复后切回上一代'
                          : '宿主没提供归档状态；恢复调用是幂等的，仍可直接尝试',
                        'unarchive',
                        () => {
                          void restoreAndOpen(chain.parentId, { markParent: true });
                        },
                        {
                          right: parentArchived === true ? '已归档' : '恢复',
                          title: `从归档中恢复旧会话 ${chain.parentId}`,
                        },
                      )
                    : null,
                  hasParent
                    ? relayBarItem('完整交接链', '一次读取整条链，回看前几次会话与交接单', 'chain', openChainList, {
                        right: '›',
                        title: `完整交接链：一次读取整条链（最多 ${MAX_CHAIN_HOPS} 层；祖先未加载也能读）`,
                      })
                    : null,
                  relayBarItem('路线图（即将上线）', '跨会话时间线，0.6 之后', 'roadmap', null, {
                    disabled: true,
                    right: '即将上线',
                  }),
                ),
            )
          : null;

      return h(
        'div',
        {
          ref: rootRef,
          'data-cr-relay-root': '1',
          style: {
            boxSizing: 'border-box',
            flex: 'none',
            // 与宿主 TodoPanel（同一 dock 槽）一致：两侧留出 composer 的边距，
            // 宽度跟着输入卡走，避免通栏压到侧栏。
            width: 'calc(100% - var(--dsh-composer-side-clearance, 16px) * 2 - var(--dsh-composer-dock-inset, 8px) * 4)',
            maxWidth: 'calc(var(--dsh-composer-card-max-width, 920px) - var(--dsh-composer-dock-inset, 8px) * 4)',
            margin: '0 auto',
          },
        },
        // 卡片外观放在内层：backdrop-filter 会给 fixed 子元素造 containing block，
        // 菜单必须留在这一层之外，才能相对视口定位（不被输入区裁切）。
        h(
          'div',
          {
            'data-cr-relay-card': '1',
            style: {
              borderRadius: 'var(--dsw-radius-lg, 12px)',
              border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.24))',
              // 底色/字体全部走 DSH 主题 token：切深浅色不需要重挂组件；老宿主用 theme 兜底。
              background: `var(--dsw-specific-menu, ${theme.panelBg})`,
              backdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
              WebkitBackdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
              boxShadow: 'var(--dsw-elevation-panel, 0 1px 2px rgba(0,0,0,0.06))',
              color: 'var(--dsw-alias-label-primary, inherit)',
              overflow: 'hidden',
            },
          },
          h(
            'button',
            {
              type: 'button',
              ref: triggerRef,
              'data-cr-relay-bar': '1',
              'data-cr-relay-ordinal': String(chain !== null ? chain.ordinal : next.ordinal),
              'data-cr-relay-scheme': (chain !== null ? chain.scheme : next.scheme) ?? '',
              'data-cr-relay-parent': chain === null || chain.parentId === null ? '' : chain.parentId,
              'data-cr-relay-path': docPath ?? '',
              // 空串 = 宿主没给归档状态（老宿主），'true'/'false' = readState.parentArchived。
              'data-cr-relay-parent-archived': parentArchived === null ? '' : String(parentArchived),
              // 0.5.1 批 3：出站目标（父会话侧「去新会话」）与它的归档状态。
              'data-cr-relay-next': hasNext ? next.childId : '',
              'data-cr-relay-next-archived': nextArchived === null ? '' : String(nextArchived),
              'aria-haspopup': 'menu',
              'aria-expanded': open,
              'aria-label': chain !== null ? `已接力自 ${label}，打开接力菜单` : `${label}，打开接力菜单`,
              onClick: toggleMenu,
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                minHeight: 30,
                padding: '3px 10px',
                border: 'none',
                borderRadius: 'inherit',
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
              },
              onMouseEnter: (event) => {
                event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.10))';
              },
              onMouseLeave: (event) => {
                event.currentTarget.style.background = 'transparent';
              },
            },
            h(
              'span',
              { style: { flex: 'none', fontSize: 12, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' } },
              // 末尾留一个空格：flex gap 负责视觉间距，文本内容（读屏/可访问性树）也要读得通。
              // 父会话侧没有「来路」，只显示「已交接给新会话」（见 label）。
              chain !== null ? '已接力自 ' : '',
            ),
            h(
              'span',
              {
                style: {
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13,
                  fontWeight: 500,
                  lineHeight: '20px',
                  color: 'var(--dsw-alias-label-primary, inherit)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              label,
            ),
            h(
              'span',
              {
                'aria-hidden': true,
                style: {
                  flex: 'none',
                  fontSize: 10,
                  lineHeight: 1,
                  color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))',
                  transform: open ? 'rotate(180deg)' : 'none',
                  transition: 'transform 120ms ease',
                },
              },
              '▾',
            ),
          ),
        ),
        menu,
      );
    }
