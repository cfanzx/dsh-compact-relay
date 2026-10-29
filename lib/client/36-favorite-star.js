    /**
     * 收藏星标（0.6）—— 挂在助手消息底部的动作行（conversation.chat.assistant-actions）。
     *
     * 数据：GET /api/compact-relay-state?sessionId=… 的 favorites.messageIds（判断是否已收藏）；
     * 点击：POST /api/compact-relay-action { action:'favorite-toggle', messageId, sessionId }。
     *
     * 2026-10-29 真机 BUG：以前 state 请求不带 sessionId，宿主回「最后一个活 agent」的会话
     * （多工作区同时开着时那是别的会话）→ 点星 POST 到错会话 → 「找不到这条消息」→ 点了没反应。
     * 现在会话 id 只认 slot 的 session 作用域注入（register 的 inject），state 也按它请求。
     * 另外：点失败要出声（宿主可能回「已被压缩」/「没有活动会话」），不再静默。
     */
    const FAVORITE_STAR_PATH = 'M12 2.8l2.82 5.72 6.31.92-4.57 4.45 1.08 6.29L12 17.2l-5.64 2.98 1.08-6.29-4.57-4.45 6.31-.92z';

    // 收藏状态共享快照：几十个星标组件共用一个请求（避免每条助手消息各发一次 GET）。
    // 30s 内复用；并发挂载共用同一个 pending Promise。快照按 sessionId 区分（切会话不会串）。
    const FAVORITE_SNAPSHOT_TTL_MS = 30000;
    let favoriteSnapshot = null; // { sessionId, ids, freshUntil }
    let favoriteSnapshotPending = null;
    let favoriteSnapshotPendingSession = null;
    /** 点亮色（配置 colors.base.favorite；设计稿到位后改配置值即可）。 */
    let favoriteTint = '#F5C542';

    /** 轻提示：收藏失败/被压缩时告诉用户一声（不依赖宿主 toast API）。 */
    function favoriteNotify(text) {
      try {
        if (typeof document === 'undefined' || document.body === null) return;
        const el = document.createElement('div');
        el.textContent = text;
        el.style.cssText =
          'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483000;max-width:80vw;' +
          'padding:8px 14px;border-radius:8px;background:rgba(30,30,30,0.92);color:#fff;font-size:13px;' +
          'line-height:1.4;box-shadow:0 6px 24px rgba(0,0,0,0.25);pointer-events:none;';
        document.body.appendChild(el);
        setTimeout(() => {
          try {
            el.remove();
          } catch (error) {
            /* ignore */
          }
        }, 4000);
      } catch (error) {
        /* 提示失败不影响收藏 */
      }
    }

    /**
     * 收藏列表（按会话缓存）。
     * @param {string|null} sessionId 当前会话（来自 slot 注入；拿不到就退回旧行为）
     * @returns {Promise<string[]|null>}
     */
    function favoriteIdsOf(sessionId) {
      const sid = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
      if (favoriteSnapshot !== null && favoriteSnapshot.sessionId === sid && Date.now() < favoriteSnapshot.freshUntil) {
        return Promise.resolve(favoriteSnapshot.ids);
      }
      if (favoriteSnapshotPending !== null && favoriteSnapshotPendingSession === sid) return favoriteSnapshotPending;
      favoriteSnapshotPendingSession = sid;
      favoriteSnapshotPending = (async () => {
        try {
          const url =
            sid === null ? '/api/compact-relay-state' : `/api/compact-relay-state?sessionId=${encodeURIComponent(sid)}`;
          const res = await fetch(url);
          const data = await res.json();
          const fav = data !== null && typeof data === 'object' ? data.favorites : null;
          const ids = fav !== null && typeof fav === 'object' && Array.isArray(fav.messageIds) ? fav.messageIds : [];
          // 只有「没带 sessionId」的兜底请求才信响应里的会话；带了就以请求的为准。
          const effectiveSid =
            sid !== null ? sid : data !== null && typeof data === 'object' && typeof data.sessionId === 'string' ? data.sessionId : null;
          const color = data !== null && typeof data === 'object' && data.colors && data.colors.base ? data.colors.base.favorite : null;
          if (typeof color === 'string' && color.length > 0) favoriteTint = color;
          favoriteSnapshot = {
            sessionId: effectiveSid,
            ids: ids.slice(),
            freshUntil: Date.now() + FAVORITE_SNAPSHOT_TTL_MS,
          };
          return favoriteSnapshot.ids;
        } catch (error) {
          return null;
        } finally {
          favoriteSnapshotPending = null;
          favoriteSnapshotPendingSession = null;
        }
      })();
      return favoriteSnapshotPending;
    }

    // 点击后同步共享快照，避免同屏其它星标（或稍后挂载的）显示旧状态。
    function rememberFavorite(messageId, active) {
      if (favoriteSnapshot === null) return;
      const ids = favoriteSnapshot.ids;
      const index = ids.indexOf(messageId);
      if (active && index === -1) ids.push(messageId);
      else if (!active && index !== -1) ids.splice(index, 1);
      favoriteSnapshot.freshUntil = Date.now() + FAVORITE_SNAPSHOT_TTL_MS;
    }

    function FavoriteStar(props) {
      const messageId =
        props !== null && props !== undefined && typeof props.messageId === 'string' ? props.messageId : null;
      const sessionId =
        props !== null && props !== undefined && typeof props.sessionId === 'string' && props.sessionId.length > 0
          ? props.sessionId
          : null;
      const [active, setActive] = useState(false);
      const [busy, setBusy] = useState(false);
      const [tint, setTint] = useState('#F5C542');

      useEffect(() => {
        if (messageId === null) return undefined;
        let cancelled = false;
        (async () => {
          const ids = await favoriteIdsOf(sessionId);
          if (cancelled || ids === null) return;
          setActive(ids.includes(messageId));
          setTint(favoriteTint);
        })();
        return () => {
          cancelled = true;
        };
      }, [messageId, sessionId]);

      const toggle = useCallback(async () => {
        if (messageId === null || busy) return undefined;
        setBusy(true);
        try {
          const res = await fetch('/api/compact-relay-action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action: 'favorite-toggle',
              messageId,
              ...(sessionId === null ? {} : { sessionId }),
            }),
          });
          const data = await res.json();
          if (data !== null && typeof data === 'object' && typeof data.active === 'boolean') {
            setActive(data.active);
            rememberFavorite(messageId, data.active);
            return undefined;
          }
          // 失败要出声：宿主回「找不到这条消息（会话可能被压缩过）」等具体原因。
          const message =
            data !== null && typeof data === 'object' && typeof data.message === 'string' && data.message.length > 0
              ? data.message
              : '收藏失败：请重试';
          favoriteNotify(message);
          return undefined;
        } catch (error) {
          favoriteNotify('收藏失败：网络或宿主不可用');
          return undefined;
        } finally {
          setBusy(false);
        }
      }, [messageId, sessionId, busy]);

      if (messageId === null) return null;
      const label = active ? '取消收藏' : '收藏这条';
      return h(
        'button',
        {
          type: 'button',
          className: 'dcr-favorite-star',
          title: label,
          'aria-label': label,
          'aria-pressed': active ? 'true' : 'false',
          onClick: toggle,
          disabled: busy,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '20px',
            height: '20px',
            padding: '0',
            margin: '0 2px',
            border: 'none',
            background: 'transparent',
            cursor: busy ? 'default' : 'pointer',
            color: active ? tint : 'currentColor',
            opacity: busy ? 0.5 : active ? 1 : 0.65,
            lineHeight: 1,
            verticalAlign: 'middle',
          },
        },
        h(
          'svg',
          {
            width: 15,
            height: 15,
            viewBox: '0 0 24 24',
            fill: active ? 'currentColor' : 'none',
            stroke: 'currentColor',
            strokeWidth: active ? 0 : 1.8,
            strokeLinejoin: 'round',
          },
          h('path', { d: FAVORITE_STAR_PATH }),
        ),
      );
    }
