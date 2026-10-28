    /**
     * 收藏星标（0.6）—— 挂在助手消息底部的动作行（conversation.chat.assistant-actions）。
     *
     * 数据：GET /api/compact-relay-state 的 favorites.messageIds（判断是否已收藏）；
     * 点击：POST /api/compact-relay-action { action:'favorite-toggle', messageId }。
     * 设计稿到位后只换下面的 path / 尺寸 / 颜色变量，交互逻辑不动。
     */
    const FAVORITE_STAR_PATH = 'M12 2.8l2.82 5.72 6.31.92-4.57 4.45 1.08 6.29L12 17.2l-5.64 2.98 1.08-6.29-4.57-4.45 6.31-.92z';

    // 收藏状态共享快照：几十个星标组件共用一个请求（避免每条助手消息各发一次 GET）。
    // 30s 内复用；并发挂载共用同一个 pending Promise。
    const FAVORITE_SNAPSHOT_TTL_MS = 30000;
    let favoriteSnapshot = null;
    let favoriteSnapshotPending = null;
    /** 点亮色（配置 colors.base.favorite；设计稿到位后改配置值即可）。 */
    let favoriteTint = '#F5C542';
    /** 当前会话 id（宿主 HTTP action 要求带 sessionId，缺了会报「缺少 sessionId」）。 */
    let favoriteSessionId = null;

    function favoriteIdsOf() {
      if (favoriteSnapshot !== null && Date.now() < favoriteSnapshot.freshUntil) {
        return Promise.resolve(favoriteSnapshot.ids);
      }
      if (favoriteSnapshotPending !== null) return favoriteSnapshotPending;
      favoriteSnapshotPending = (async () => {
        try {
          const res = await fetch('/api/compact-relay-state');
          const data = await res.json();
          const fav = data !== null && typeof data === 'object' ? data.favorites : null;
          const ids = fav !== null && typeof fav === 'object' && Array.isArray(fav.messageIds) ? fav.messageIds : [];
          if (data !== null && typeof data === 'object' && typeof data.sessionId === 'string' && data.sessionId.length > 0) {
            favoriteSessionId = data.sessionId;
          }
          const color = data !== null && typeof data === 'object' && data.colors && data.colors.base ? data.colors.base.favorite : null;
          if (typeof color === 'string' && color.length > 0) favoriteTint = color;
          favoriteSnapshot = { ids: ids.slice(), freshUntil: Date.now() + FAVORITE_SNAPSHOT_TTL_MS };
          return favoriteSnapshot.ids;
        } catch (error) {
          return null;
        } finally {
          favoriteSnapshotPending = null;
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
      const [active, setActive] = useState(false);
      const [busy, setBusy] = useState(false);
      const [tint, setTint] = useState('#F5C542');

      useEffect(() => {
        if (messageId === null) return undefined;
        let cancelled = false;
        (async () => {
          const ids = await favoriteIdsOf();
          if (cancelled || ids === null) return;
          setActive(ids.includes(messageId));
          setTint(favoriteTint);
        })();
        return () => {
          cancelled = true;
        };
      }, [messageId]);

      const toggle = useCallback(async () => {
        if (messageId === null || busy) return;
        setBusy(true);
        try {
          const res = await fetch('/api/compact-relay-action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action: 'favorite-toggle',
              messageId,
              ...(favoriteSessionId === null ? {} : { sessionId: favoriteSessionId }),
            }),
          });
          const data = await res.json();
          if (data !== null && typeof data === 'object' && typeof data.active === 'boolean') {
            setActive(data.active);
            rememberFavorite(messageId, data.active);
          }
        } catch (error) {
          /* 失败保持原状态 */
        } finally {
          setBusy(false);
        }
      }, [messageId, busy]);

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

