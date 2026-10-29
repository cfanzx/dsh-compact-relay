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
    let favoriteSnapshot = null; // { sessionId, ids, suggested, freshUntil }
    let favoriteSnapshotPending = null;
    let favoriteSnapshotPendingSession = null;
    /** 点亮色（配置 colors.base.favorite；设计稿到位后改配置值即可）。 */
    let favoriteTint = '#F5C542';

    /**
     * 推荐态样式只注入一次：金色呼吸光晕（0.5.3 UI）。
     * 静态 1.5px 细环在长消息流里太容易漏看；改成 2.4s 呼吸 + 更亮的峰值。
     * 系统开了「减少动态效果」就退回静态加亮版本。
     */
    function ensureFavoriteStyle() {
      try {
        if (typeof document === 'undefined' || document.head === null) return;
        if (document.getElementById('dcr-favorite-style') !== null) return;
        const style = document.createElement('style');
        style.id = 'dcr-favorite-style';
        style.textContent =
          '@keyframes dcr-favorite-pulse {' +
          '0%,100% { box-shadow: 0 0 0 2px rgba(245,197,66,0.78), 0 0 6px rgba(245,197,66,0.45); }' +
          '50% { box-shadow: 0 0 0 2.5px rgba(245,197,66,0.98), 0 0 12px rgba(245,197,66,0.85); }' +
          '}' +
          // 与宿主助手消息动作行（._action）完全对齐：基础用 label-tertiary，
          // hover 切 label-secondary + 交互背景（与邻座逐项相同）。
          '.dcr-favorite-star { background: transparent; color: var(--dsw-alias-label-tertiary, currentColor); }' +
          '.dcr-favorite-star:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.16)); color: var(--dsw-alias-label-secondary, currentColor); }' +
          '@media (prefers-reduced-motion: reduce) { .dcr-favorite-star { animation: none !important; } }';
        document.head.appendChild(style);
      } catch (error) {
        /* 样式注入失败不影响收藏功能 */
      }
    }
    ensureFavoriteStyle();

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
          // 0.5.3 P1-6：推荐收藏建议（只点亮星标，不写收藏）。按 messageId 建索引，组件 O(1) 查。
          const suggested = {};
          const suggestList =
            data !== null && typeof data === 'object' && Array.isArray(data.favoriteSuggest) ? data.favoriteSuggest : [];
          for (const item of suggestList) {
            if (item === null || typeof item !== 'object') continue;
            if (typeof item.messageId !== 'string' || item.messageId.length === 0) continue;
            suggested[item.messageId] = {
              score: typeof item.score === 'number' ? item.score : null,
              reason: typeof item.reason === 'string' ? item.reason : '',
            };
          }
          // 只有「没带 sessionId」的兜底请求才信响应里的会话；带了就以请求的为准。
          const effectiveSid =
            sid !== null ? sid : data !== null && typeof data === 'object' && typeof data.sessionId === 'string' ? data.sessionId : null;
          const color = data !== null && typeof data === 'object' && data.colors && data.colors.base ? data.colors.base.favorite : null;
          if (typeof color === 'string' && color.length > 0) favoriteTint = color;
          favoriteSnapshot = {
            sessionId: effectiveSid,
            ids: ids.slice(),
            suggested,
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
      // 已收藏的条目不再算「推荐」（取消收藏后本回合内也不重新点亮，等下一条回复）。
      if (active && favoriteSnapshot.suggested !== null && typeof favoriteSnapshot.suggested === 'object') {
        delete favoriteSnapshot.suggested[messageId];
      }
      favoriteSnapshot.freshUntil = Date.now() + FAVORITE_SNAPSHOT_TTL_MS;
    }

    /** 查某条消息是否有推荐（当前快照会话内）；返回 {score, reason} 或 null。 */
    function favoriteSuggestionOf(sessionId, messageId) {
      if (favoriteSnapshot === null || messageId === null) return null;
      if (favoriteSnapshot.sessionId !== sessionId) return null;
      const suggested = favoriteSnapshot.suggested;
      if (suggested === null || typeof suggested !== 'object') return null;
      const hit = suggested[messageId];
      return hit !== undefined && hit !== null ? hit : null;
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
      const [suggested, setSuggested] = useState(null);

      useEffect(() => {
        if (messageId === null) return undefined;
        let cancelled = false;
        (async () => {
          const ids = await favoriteIdsOf(sessionId);
          if (cancelled || ids === null) return;
          setActive(ids.includes(messageId));
          setSuggested(favoriteSuggestionOf(sessionId, messageId));
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
            if (data.active) setSuggested(null);
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
      const isSuggested = active !== true && suggested !== null;
      const label = active
        ? '取消收藏'
        : isSuggested
          ? `推荐收藏${suggested.score !== null ? `（${suggested.score} 分）` : ''}`
          : '收藏这条';
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
            width: isSuggested ? 'auto' : '28px',
            height: '28px',
            gap: isSuggested ? '4px' : '0',
            padding: isSuggested ? '6px 8px 6px 6px' : '6px',
            margin: '0',
            border: 'none',
            cursor: busy ? 'default' : 'pointer',
            ...(active || isSuggested ? { color: tint } : {}),
            opacity: busy ? 0.5 : 1,
            borderRadius: '8px',
            // 推荐态：金色光晕（只点亮、不自动收藏；点击仍走同一 toggle）。
            boxShadow: isSuggested ? '0 0 0 2px rgba(245,197,66,0.9), 0 0 8px rgba(245,197,66,0.6)' : 'none',
            animation: isSuggested ? 'dcr-favorite-pulse 2.4s ease-in-out infinite' : 'none',
            lineHeight: 1,
            verticalAlign: 'middle',
          },
        },
        h(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 24 24',
            fill: active ? 'currentColor' : 'none',
            stroke: 'currentColor',
            strokeWidth: active ? 0 : 1.8,
            strokeLinejoin: 'round',
          },
          h('path', { d: FAVORITE_STAR_PATH }),
        ),
        // 推荐态：加一个金色「推荐」小标签（用户确认要提高可见度，允许轻微打断阅读）。
        // 标签在按钮内部 —— 点击任意位置都走同一个 toggle，不新增交互面。
        isSuggested
          ? h(
              'span',
              {
                style: {
                  fontSize: '11px',
                  lineHeight: '1.5',
                  letterSpacing: '0.02em',
                  whiteSpace: 'nowrap',
                },
              },
              '推荐',
            )
          : null,
      );
    }
