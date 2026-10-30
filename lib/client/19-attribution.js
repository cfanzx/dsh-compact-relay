    /* @inline core/attribution-label.js */

    /**
     * 0.5.6-D2：压缩归属的界面侧派生（纯函数，唯一数据源 = state.lastCompaction）。
     *
     * 服务端 `readState.lastCompaction` 的形状是冻结的（core/attribution.ATTRIBUTION_ROW_KEYS），
     * 这里只做白名单投影：类型不对/缺键 → null（不知道），绝不根据 summaries、时间、
     * 事件顺序等旁证猜一个触发者。
     */

    /** 毫秒 → 本地 `HH:MM`；时间不可用 → ''（不显示假时间）。 */
    const attributionClockOf = (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
      const d = new Date(ms);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    };

    /**
     * state.lastCompaction → 界面用的小对象；不是对象 → null。
     * @param {unknown} row 服务端下发的归属行
     */
    const lastCompactionViewOf = (row) => {
      if (row === null || row === undefined || typeof row !== 'object' || Array.isArray(row)) return null;
      const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
      const range = row.range !== null && typeof row.range === 'object' ? row.range : {};
      const at = typeof row.at === 'string' && row.at.length > 0 ? row.at : null;
      const atMs = at === null ? NaN : Date.parse(at);
      return {
        compactionId: typeof row.compactionId === 'string' && row.compactionId.length > 0 ? row.compactionId : null,
        // 存归一后的枚举（不是中文名）：渲染时再查文案，口径与检查/投影一致。
        trigger: normalizeTriggerKey(row.trigger),
        actor: typeof row.actor === 'string' && row.actor.length > 0 ? row.actor.toLowerCase() : 'unknown',
        at,
        atMs: Number.isFinite(atMs) ? atMs : null,
        count: num(range.count),
        tokens: num(range.tokens),
        merged: typeof row.merged === 'boolean' ? row.merged : null,
        outcome: typeof row.outcome === 'string' && row.outcome.length > 0 ? row.outcome : null,
      };
    };

    /** 悬停卡一行：`上次压缩：菜单压缩·用户 · 22 条 / 32.5k · 15:40`。 */
    const lastCompactionTextOf = (view) => {
      if (view === null) return '';
      const head = `${triggerLabelOf(view.trigger)}·${actorLabelOf(view.actor)}`;
      const count = view.count === null ? '条数未知' : `${Math.round(view.count)} 条`;
      const tokens = tokensShortOf(view.tokens);
      const parts = [head, tokens === null ? count : `${count} / ${tokens}`];
      const clock = attributionClockOf(view.atMs);
      if (clock !== '') parts.push(clock);
      return `上次压缩：${parts.join(' · ')}`;
    };

    /**
     * 「查看上次压缩」面板里每条压缩的归属行。
     *
     * 只有 compactionId **完全相同**才认（服务端只下发最近一条归属，历史条目不猜）；
     * 其余一律「来源不明（无归属记录）」。
     * @param {object} entry 压缩历史条目（含 compactionId|null）
     * @param {object|null} lastView state.lastCompaction 的投影
     */
    const diffAttributionOf = (entry, lastView) => {
      const id =
        entry !== null && typeof entry === 'object' && typeof entry.compactionId === 'string' && entry.compactionId.length > 0
          ? entry.compactionId
          : null;
      if (id !== null && lastView !== null && lastView.compactionId === id) {
        return { text: `归属：${attributionLabelOf(lastView)}`, trigger: lastView.trigger };
      }
      return { text: `归属：${NO_ATTRIBUTION_LABEL}`, trigger: 'unknown' };
    };
