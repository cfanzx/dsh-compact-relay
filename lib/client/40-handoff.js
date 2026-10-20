
    /** 交接结果的一行式展示（放在聊天流里的 /handoff 命令卡）。 */
    function handoffRow(text, tone, action) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 2px',
            fontSize: 12,
            color: tone === 'error' ? COLORS.error : COLORS.subText,
          },
        },
        h('span', { style: { flex: 1, minWidth: 0 } }, text),
        action
          ? h(
              'button',
              {
                type: 'button',
                onClick: action,
                style: {
                  flex: 'none',
                  border: 'none',
                  borderRadius: 6,
                  padding: '2px 8px',
                  background: COLORS.hover,
                  color: 'inherit',
                  fontSize: 11,
                  cursor: 'pointer',
                },
              },
              '重试打开',
            )
          : null,
      );
    }

    /**
     * /handoff 命令卡：命令成功后自动切到新会话。
     * 这个槽把命令的通用卡片替换成我们的卡片（只有 /handoff 这一个 key）。
     */
    function HandoffCard({ node, waitAndOpen }) {
      const outcome = node !== null && typeof node === 'object' ? node.outcome : undefined;
      const outcomeText = outcome !== null && typeof outcome === 'object' && typeof outcome.text === 'string' ? outcome.text : '';
      // A5：优先用命令结果里的结构化 childId；旧宿主没带字段时再从文本 #child= 兜底。
      const childId =
        outcome !== null && typeof outcome === 'object' && typeof outcome.childId === 'string' && outcome.childId.length > 0
          ? outcome.childId
          : extractChildId(outcomeText);
      // P2-C1：区分 opening / opened / failed；刷新后只有 localStorage='1' 才算已打开，
      // 'opening'（上次没走完）要重新尝试，不能直接渲染成功态。
      const [status, setStatus] = useState(() => {
        if (outcome === undefined) return 'running';
        if (outcome !== null && outcome.kind === 'error') return 'error';
        if (childId === null) return 'done';
        return wasOpened(childId) ? 'done' : 'opening';
      });
      const [detail, setDetail] = useState(null);

      const openChild = useCallback(() => {
        if (childId === null) return;
        setStatus('opening');
        setDetail(null);
        waitAndOpen(childId).then(
          () => {
            markOpened(childId, '1');
            setStatus('done');
          },
          (error) => {
            clearOpened(childId);
            setStatus('failed');
            setDetail(String(error && error.message ? error.message : error));
          },
        );
      }, [childId, waitAndOpen]);

      useEffect(() => {
        if (outcome === undefined || outcome === null || outcome.kind !== 'success' || childId === null) return;
        if (wasOpened(childId)) {
          setStatus('done');
          return;
        }
        markOpened(childId, 'opening');
        let alive = true;
        waitAndOpen(childId).then(
          () => {
            markOpened(childId, '1');
            if (alive) setStatus('done');
          },
          (error) => {
            clearOpened(childId);
            if (!alive) return;
            setStatus('failed');
            setDetail(String(error && error.message ? error.message : error));
          },
        );
        return () => {
          alive = false;
        };
      }, [childId, outcome, waitAndOpen]);

      if (status === 'running') return handoffRow('正在交接：压缩旧会话 → 生成交接单 → 打开新会话…');
      if (status === 'error') return handoffRow(outcomeText || '交接失败（详见日志）', 'error');
      if (childId === null) return handoffRow(outcomeText || '交接完成');
      if (status === 'failed') {
        return handoffRow(`新会话已建好（${childId}），自动切换失败：${detail || '未知原因'}`, 'error', openChild);
      }
      if (status === 'opening') return handoffRow(`交接完成，正在打开新会话（${childId}）…`);
      return handoffRow('交接完成：已切到新会话（点指示灯 → 查看交接单 可回看或复制）。');
    }

