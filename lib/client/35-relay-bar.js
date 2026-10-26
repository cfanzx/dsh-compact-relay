
    /* ---------------- 0.5.0 接力条（v1）：输入框上方一行「已接力自 …」 ---------------- */

    /**
     * 0.5.0 接力条 v1 —— 只做「一行摘要 + 向上弹出的下拉菜单」。
     *
     * 位置：`conversation.input.dock`（list / session scope；宿主文档原文
     *       “Full-width entries above the composer card”，即输入卡上方通栏）。
     * 显示：`readState.chain` 非 null，且这条记录是**本会话的入站记录**
     *       （childId === sessionId）。出站记录（本会话交接给了下一代）不显示
     *       「已接力自」；老宿主/没有 chain 字段时组件返回 null，不占高度。
     * 数据：GET `/api/compact-relay-state?sessionId=…`。会话刚打开、宿主还没装日志
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
     * 接力条摘要：新链「历史 N：原名」，旧链「交接第 N 次：原名」。
     * @param {object} chain relayBarChainOf 的结果
     * @returns {string}
     */
    function relayBarLabelOf(chain) {
      const baseTitle = chain.baseTitle === null ? '会话' : chain.baseTitle;
      return chain.scheme === 'history-n' ? `历史 ${chain.ordinal}：${baseTitle}` : `交接第 ${chain.ordinal} 次：${baseTitle}`;
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
     * @param {object} props ctx.slots.register 注入的 props
     * @param {string} [props.sessionId] 当前会话 id（session scope）
     * @param {(sessionId:string)=>unknown} [props.openSession] 切到某个会话（ctx.uiWorkspace.openSession）
     */
    function CompactRelayBar(props) {
      const sessionId = props === null || props === undefined ? undefined : props.sessionId;
      const openSession = props === null || props === undefined ? undefined : props.openSession;
      const hasSession = typeof sessionId === 'string' && sessionId.length > 0;
      const [chain, setChain] = useState(null);
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

      const closeMenu = useCallback(() => {
        abortDoc();
        setOpen(false);
        setDoc(null);
        setNotice(null);
      }, [abortDoc]);

      // 从交接单详情回到菜单列表：取消读取，避免「返回后又被晚到的响应撑开」。
      const backToMenu = useCallback(() => {
        abortDoc();
        setDoc(null);
      }, [abortDoc]);

      // 读链状态。会话刚打开时宿主可能还没把日志装进内存（readState.sessionId 为
      // null），这时要重试几次；一旦宿主确认「就是这个会话且没有 chain」就停，
      // 普通会话不会无限打接口。fetch 失败/老宿主没有 chain → setChain(null) → 不渲染。
      useEffect(() => {
        // 换会话/没有会话时先清掉上一条链（dock 组件可能被复用而不是重挂）。
        setChain(null);
        setOpen(false);
        setDoc(null);
        setNotice(null);
        if (!hasSession) return undefined;
        let dead = false;
        let timer = 0;
        let attempts = 0;
        const url = `/api/compact-relay-state?sessionId=${encodeURIComponent(sessionId)}`;
        const schedule = () => {
          if (dead) return;
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
            const parentChain = relayChainProjectionOf(parentData);
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
            if (parsed !== null) {
              setChain(parsed);
              // F3 的子会话记录不带 path（交接单路径只写在父记录里）：向父会话读回
              // 同一条链，childId 指回本会话且链号一致时才采用它的 path。只读、失败
              // 就保持「暂无交接单」；不碰宿主逻辑，也不改交接流程。
              if (parsed.path === null && parsed.parentId !== null) void loadParentPath(parsed);
              return;
            }
            // sessionId 对不上/为 null → 宿主还没加载本会话，继续等；对得上 → 确定没有链。
            const loaded =
              data !== null && typeof data === 'object' && typeof data.sessionId === 'string' && data.sessionId === sessionId;
            if (loaded) setChain(null);
            else schedule();
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
      }, [hasSession, sessionId]);

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
        setOpen((value) => !value);
      }, [abortDoc]);

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

      const goParent = useCallback(() => {
        setNotice(null);
        if (chain === null || chain.parentId === null) return;
        if (typeof openSession !== 'function') {
          setNotice('这个宿主不支持切换会话，无法自动打开原会话。');
          return;
        }
        try {
          const result = openSession(chain.parentId);
          if (result !== null && result !== undefined && typeof result.then === 'function') {
            result.catch((error) => {
              setNotice('打不开原会话：' + (error && error.message ? error.message : '未知错误'));
              setOpen(true);
            });
          }
          setOpen(false);
          setDoc(null);
        } catch (error) {
          setNotice('打不开原会话：' + (error && error.message ? error.message : '未知错误'));
        }
      }, [chain, openSession]);

      // 无链 → 什么都不渲染（不占 composerStack 的高度）。
      if (chain === null) return null;

      const label = relayBarLabelOf(chain);
      const docName = relayBarDocNameOf(chain.path);
      const hasParent = chain.parentId !== null;
      const vw = typeof window === 'undefined' ? 1280 : window.innerWidth;
      const vh = typeof window === 'undefined' ? 900 : window.innerHeight;
      const menuWidth = Math.min(doc === null ? 272 : 420, Math.max(240, vw - 16));
      const estimatedHeight = doc === null ? 168 : 360;
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
                  padding: doc === null ? 5 : 0,
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
              docPanel ??
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
                  relayBarItem('回到原会话', hasParent ? '切到上一个会话，继续看那边历史' : '这条记录没有父会话 id', 'parent', goParent, {
                    disabled: !hasParent,
                    right: hasParent ? '›' : '不可用',
                    title: hasParent ? `打开原会话 ${chain.parentId}` : undefined,
                  }),
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
              'data-cr-relay-ordinal': String(chain.ordinal),
              'data-cr-relay-scheme': chain.scheme ?? '',
              'data-cr-relay-parent': chain.parentId ?? '',
              'data-cr-relay-path': chain.path ?? '',
              'aria-haspopup': 'menu',
              'aria-expanded': open,
              'aria-label': `已接力自 ${label}，打开接力菜单`,
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
              '已接力自 ',
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
