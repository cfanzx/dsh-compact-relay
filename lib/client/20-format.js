
    const fmt = (n) => {
      if (n == null) return '—';
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
      return String(n);
    };

    /** 交接单列表用的本地时间：2026-10-19 20:31。 */
    const fmtTime = (ms) => {
      if (!Number.isFinite(ms)) return '未知时间';
      const d = new Date(ms);
      return (
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` +
        ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      );
    };

    /**
     * 0.4.1：原生自动压缩线「配置阈值 vs 实际触发线」。
     * DSH 按 token 预算触发：min(窗口×配置阈值, 窗口−输出预留−余量)，
     * 所以实际触发点常比配置比例更早（deepseek-flash 配置 80%、实际 67.85%）。
     * autoEnabled=false 时 effective/percentText 为空（未开启），但 actualText 仍给出
     * 「开启后实际会触发多少」，供关闭态文案使用。
     * @param {object|null} native readState 下发的 native 字段
     * @returns {{configured:number|null,configuredText:string|null,actual:number|null,actualText:string,effective:number|null,percentText:string,differs:boolean,autoOff:boolean,why:string}}
     */
    const nativeLineInfo = (native) => {
      const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
      const ratioOf = (value) => {
        const n = num(value);
        return n !== null && n > 0 && n < 1 ? n : null;
      };
      const src = native === null || native === undefined ? null : native;
      const configured = ratioOf(src === null ? null : src.thresholdRatio);
      const actual = ratioOf(src === null ? null : src.ratio);
      const autoOff = src !== null && src.autoEnabled === false;
      const effective = autoOff ? null : actual !== null ? actual : configured;
      const pctText = (value) => {
        const p = value * 100;
        return Math.abs(p - Math.round(p)) < 0.05 ? String(Math.round(p)) : p.toFixed(1);
      };
      const configuredText = configured === null ? null : pctText(configured);
      const actualText = actual === null ? '' : pctText(actual);
      const percentText = effective === null ? '' : pctText(effective);
      const differs = configured !== null && effective !== null && Math.abs(effective - configured) >= 0.005;
      let why = '';
      if (differs) {
        const overridden = src.overridden === true;
        const windowTokens = num(src.contextWindow);
        const reserved = num(src.reservedCompletionTokens);
        const headroom = num(src.headroomTokens);
        // 只有「预算分支确实更小」时，才能把差异归因为输出预留/余量。
        const budgetTokens = windowTokens !== null ? windowTokens - (reserved ?? 0) - (headroom ?? 0) : null;
        const budgetBinding = budgetTokens !== null && configured !== null && budgetTokens < windowTokens * configured;
        const parts = [];
        if (reserved !== null && reserved > 0) parts.push(`模型输出要预留 ${fmt(reserved)}`);
        if (headroom !== null && headroom > 0) parts.push(`DSH 自己还要留 ${fmt(headroom)} 余量`);
        if (overridden) {
          why = `这个模型单独配了阈值（按路由覆盖），实际触发是 ${actualText}%（全局配置 ${configuredText}%）。`;
        } else if (budgetBinding && parts.length > 0) {
          why = `配置阈值 ${configuredText}% 只是理论上限；${parts.join('、')}，所以实际打到 ${percentText}% 就会自动压。`;
        } else if (actual !== null && configured !== null && actual > configured) {
          why = `这个路由的输出预留更小，实际触发晚于配置阈值 ${configuredText}%（实际 ${actualText}%）。`;
        } else {
          why = `实际触发 ${actualText}% 与配置阈值 ${configuredText}% 不同，按宿主 token 预算算的。`;
        }
      }
      return { configured, configuredText, actual, actualText, effective, percentText, differs, autoOff, why };
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /**
     * 交接预览用的轻量 markdown：`## 标题` 渲染成加粗行（去掉 # 前缀），
     * 其余行原样保留。不引第三方渲染器，只求「预览读起来不像源码」。
     * @param {string} text
     * @returns {object[]} React 子节点数组
     */
    const previewLines = (text) =>
      String(text ?? '')
        .split('\n')
        .map((line, index) => {
          const heading = /^#{1,6}\s+(.*)$/.exec(line);
          if (heading !== null) {
            return h('div', { key: `h${index}`, style: { fontWeight: 600, marginTop: index === 0 ? 0 : 8 } }, heading[1]);
          }
          return h('div', { key: `l${index}`, style: { minHeight: '1em' } }, line);
        });

    /** 新会话 id 的形态（宿主文案里用反引号包着 session-<uuid>）。 */
    const CHILD_ID_RE = /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    /**
     * 从命令结果文本里提取新会话 id。
     * @param {string} text
     * @returns {string|null}
     */
    function extractChildId(text) {
      if (typeof text !== 'string') return null;
      const match = CHILD_ID_RE.exec(text);
      return match === null ? null : match[0];
    }

    /** 每个子会话只自动打开一次（历史回放不反复跳转）。 */
    const OPENED_PREFIX = 'dsh.compact-relay.opened.v1';
    function openedKey(childId) {
      return `${OPENED_PREFIX}:${childId}`;
    }
    /** 读「打开过」状态：'1'=已成功打开，'opening'=上次正在打开（刷新后不能当成功）。 */
    function openedValueOf(childId) {
      try {
        return window.localStorage.getItem(openedKey(childId));
      } catch {
        return null;
      }
    }
    function wasOpened(childId) {
      return openedValueOf(childId) === '1';
    }
    function markOpened(childId, value) {
      try {
        window.localStorage.setItem(openedKey(childId), value);
      } catch {
        /* 隐私模式下可写不了，忽略 */
      }
    }
    function clearOpened(childId) {
      try {
        window.localStorage.removeItem(openedKey(childId));
      } catch {
        /* ignore */
      }
    }

    /**
     * 指示灯本体：外环=占用与压缩建议，内圆=交接建议；点击弹菜单。
     *
     * 数据源（M5，实际实现）：宿主订阅 `session/event` 后经自家 SSE 端点
     * `/api/compact-relay-stream` 推送（见 lib/dsh/state-hub.js）；浏览器用
     * EventSource 订阅，连不上或会话未就绪时退回轮询 `/api/compact-relay-state`。
     * 注意：第三方 slot 拿不到官方 `useProjection`（实测），所以不直连官方投影。
