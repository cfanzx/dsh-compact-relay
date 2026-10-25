    /* ---------------- 设置栏：压缩接力 ---------------- */

    /** 颜色预设：点一下同时改 4 个基准色。 */
    const COLOR_PRESETS = [
      { id: 'classic', label: '经典', base: { idle: '#6F7680', compact: '#C26A00', handoff: '#D92D20', stage: '#2563EB', pin: '#C026D3' } },
      { id: 'contrast', label: '高对比', base: { idle: '#4B5563', compact: '#92400E', handoff: '#B91C1C', stage: '#1D4ED8', pin: '#A21CAF' } },
      { id: 'soft', label: '柔和', base: { idle: '#7D8794', compact: '#B45309', handoff: '#D05A55', stage: '#3B82F6', pin: '#D946EF' } },
    ];

    const settingsHintStyle = { margin: 0, fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' };
    const settingsLabelStyle = { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' };
    const settingsInputStyle = {
      height: 28,
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.3))',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      color: 'inherit',
      fontSize: 12,
      padding: '0 8px',
      maxWidth: 320,
    };
    const settingsButtonStyle = {
      height: 30,
      borderRadius: 7,
      border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.3))',
      background: 'transparent',
      color: 'inherit',
      fontSize: 12,
      padding: '0 12px',
      cursor: 'pointer',
    };

    /** 不可变地设置对象里的某个路径。 */
    function setIn(object, path, value) {
      if (path.length === 1) return { ...object, [path[0]]: value };
      return { ...object, [path[0]]: setIn(object[path[0]] ?? {}, path.slice(1), value) };
    }

    /** 一行设置：标签 + 作用小字 + 调整后的变化小字 + 控件。 */
    function settingsRow(label, purpose, effect, control) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 18 } },
        h('div', { style: settingsLabelStyle }, label),
        h('p', { style: settingsHintStyle }, `作用：${purpose}`),
        h('p', { style: settingsHintStyle }, `调整后：${effect}`),
        h('div', { style: { marginTop: 6 } }, control),
      );
    }

    /** 区块标题：设置页按权重分区块（UI-002），标题前一条细分隔线。 */
    function sectionHeading(title) {
      return h(
        'div',
        { style: { marginTop: 26, paddingTop: 14, borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))', fontSize: 14, fontWeight: 700, color: 'var(--dsw-alias-label-primary, inherit)' } },
        title,
      );
    }

    /** 色块预览：显示一个颜色在浅/深界面里分别会变成什么样。 */
    function colorPreviewRow(baseColor) {
      const light = paletteForScheme({ autoAdapt: true, base: { ...DEFAULT_BASE, idle: baseColor, compact: baseColor, handoff: baseColor, stage: baseColor } }, 'light');
      const dark = paletteForScheme({ autoAdapt: true, base: { ...DEFAULT_BASE, idle: baseColor, compact: baseColor, handoff: baseColor, stage: baseColor } }, 'dark');
      const swatch = (label, color) =>
        h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' } },
          h('i', { style: { width: 10, height: 10, borderRadius: 999, background: color, display: 'inline-block' } }),
          `${label} ${color}`,
        );
      return h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 } }, swatch('浅色', light.idle), swatch('深色', dark.idle));
    }

    /** GitHub 外链；URL 还没配置时显示“准备中”占位（先预留接口）。 */
    function githubLink(label, url, placeholder) {
      const style = { fontSize: 12, color: 'var(--dsw-alias-state-business-primary, #2563eb)', textDecoration: 'underline', cursor: 'pointer' };
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        return h('a', { href: url, target: '_blank', rel: 'noreferrer noopener', style }, label);
      }
      return h('span', { style: { ...settingsHintStyle, fontSize: 12 } }, placeholder);
    }

    /** 颜色选择控件：色盘 + 浅/深预览。 */
    function colorField(value, onChange, label) {
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
        h('input', {
          type: 'color',
          'aria-label': label,
          value: normalizeHex(value, '#888888'),
          onChange: (event) => onChange(event.target.value),
          style: { width: 36, height: 28, padding: 2, border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,0.3))', borderRadius: 6, background: 'transparent' },
        }),
        colorPreviewRow(normalizeHex(value, '#888888')),
      );
    }

    /** 设置栏面板：阈值 / 压缩 / 颜色。 */
    function CompactRelaySettings() {
      const [form, setForm] = useState(null);
      /** 已保存表单的 JSON 快照：用来提示「有未保存的修改」。 */
      const [savedSnapshot, setSavedSnapshot] = useState(null);
      const [version, setVersion] = useState('');
      const [status, setStatus] = useState(null);
      const [saving, setSaving] = useState(false);
      /** A4：设置文件有问题时后端仍返回默认配置 + 错误说明，这里在顶部提示。 */
      const [settingsError, setSettingsError] = useState(null);
      /** A4：恢复默认是删文件，二次确认后才执行。 */
      const [confirmReset, setConfirmReset] = useState(false);
      /** 0.3.1：DSH 原生自动压缩配置（读 profile + 默认值）与开关确认。 */
      const [native, setNative] = useState(null);
      /** UI-002：设置文件路径（「关于与危险操作」区块展示）。 */
      const [settingsPath, setSettingsPath] = useState('');
      /** 0.4 P1-3：轻账本累计数字（独立账本文件算出来的；null = 没有数据/读不到，显示引导文案）。 */
      const [ledger, setLedger] = useState(null);
      const [confirmNative, setConfirmNative] = useState(null); // null | 'disable' | 'enable'
      /** 0.4.2：按实际线重算交接线（先二次确认，{ratio,percent}）。 */
      const [confirmRecalc, setConfirmRecalc] = useState(null);
      const [nativeBusy, setNativeBusy] = useState(false);
      /** UI-003：结果提示就地显示在开关旁（以前只写页面底部，用户看不到）。 */
      const [nativeStatus, setNativeStatus] = useState(null);
      /** 作者 2026-10-20：设置页「再看一次初次引导」的就地提示。 */
      const [onboardingNotice, setOnboardingNotice] = useState(null);
      const nativeConfirmRef = useRef(null);
      /**
       * 0.4 P0-2：诊断信息（只在本机生成；可预览/复制，插件不会把它发到任何地方）。
       * diagData 是端点返回的 {schema,version,generatedAt,markdown,json,issueUrl}。
       */
      const [diagData, setDiagData] = useState(null);
      const [diagLoading, setDiagLoading] = useState(false);
      const [diagOpen, setDiagOpen] = useState(false);
      /** 弹层顶部说明卡：只在本会话第一次生成时出现一次。 */
      const [diagIntroSeen, setDiagIntroSeen] = useState(false);
      const [diagStatus, setDiagStatus] = useState(null);
      /** 复制/打开结果的小 toast 计时器（A4：成功与失败都要有 toast 反馈）。 */
      const diagToastTimer = useRef(null);

      /** 就地提示 + 4.2 秒后自动消失的 toast。 */
      const flashDiagStatus = useCallback((next) => {
        setDiagStatus(next);
        if (diagToastTimer.current !== null) clearTimeout(diagToastTimer.current);
        diagToastTimer.current = setTimeout(() => setDiagStatus(null), 4200);
      }, []);

      useEffect(
        () => () => {
          if (diagToastTimer.current !== null) clearTimeout(diagToastTimer.current);
        },
        [],
      );

      /** 0.4.1：设置接口只给「配置阈值」，实际触发线要从 state 接口补（同一套 readState 数据）。 */
      const nativeLineExtra = useRef(null);
      const mergeNative = useCallback((view) => {
        if (view === null || view === undefined) return null;
        const extra = nativeLineExtra.current;
        return extra === null ? view : { ...view, ...extra };
      }, []);

      /** 把服务端返回的 view 落到表单：同时更新「已保存」快照和设置文件错误。 */
      const applyLoaded = useCallback((data) => {
        setForm(data.config);
        setSavedSnapshot(JSON.stringify(data.config));
        setSettingsError(data.settingsError ?? null);
        setNative(mergeNative(data.native && typeof data.native === 'object' ? data.native : null));
        if (typeof data.version === 'string') setVersion(data.version);
        if (typeof data.path === 'string') setSettingsPath(data.path);
        setLedger(data.ledger !== null && typeof data.ledger === 'object' ? data.ledger : null);
      }, [mergeNative]);

      const load = useCallback(async () => {
        try {
          const [settingsRes, stateRes] = await Promise.all([
            fetch('/api/compact-relay-settings', { cache: 'no-store' }),
            fetch('/api/compact-relay-state', { cache: 'no-store' }).catch(() => null),
          ]);
          const data = await settingsRes.json().catch(() => ({}));
          if (!settingsRes.ok || data.ok === false) throw new Error(data && data.message ? String(data.message) : '读取设置失败');
          // 0.4.1：补上实际触发线相关字段（配置接口没有这些，只有 state 接口有）。
          let extra = null;
          if (stateRes !== null && stateRes.ok) {
            const stateData = await stateRes.json().catch(() => ({}));
            const sn = stateData !== null && stateData.native !== null && typeof stateData.native === 'object' ? stateData.native : null;
            if (sn !== null) {
              extra = {
                ratio: typeof sn.ratio === 'number' ? sn.ratio : null,
                thresholdTokens: typeof sn.thresholdTokens === 'number' ? sn.thresholdTokens : null,
                contextWindow: typeof sn.contextWindow === 'number' ? sn.contextWindow : null,
                reservedCompletionTokens: typeof sn.reservedCompletionTokens === 'number' ? sn.reservedCompletionTokens : null,
                headroomTokens: typeof sn.headroomTokens === 'number' ? sn.headroomTokens : null,
                overridden: sn.overridden === true,
                route: sn.route !== null && typeof sn.route === 'object' ? sn.route : null,
              };
            }
          }
          nativeLineExtra.current = extra;
          applyLoaded(data);
          setStatus(null);
        } catch (error) {
          setStatus({ error: true, text: `读取设置失败：${error && error.message ? error.message : '未知错误'}` });
        }
      }, [applyLoaded]);

      useEffect(() => {
        void load();
      }, [load]);

      const patch = (path, value) => {
        setForm((prev) => (prev === null ? prev : setIn(prev, path, value)));
        setConfirmReset(false);
        setConfirmRecalc(null);
      };

      /** 表单与已保存快照不一致 → 有未保存修改。 */
      const dirty = form !== null && savedSnapshot !== null && JSON.stringify(form) !== savedSnapshot;

      /**
       * 保存设置。0.4.2：body 带上 `nativeRatio`（当前模型实际触发线），
       * 服务端据此按「实际线 −5pp」同口径校验交接线；算不出/原生关闭时不带（服务端兜底）。
       * @param {object} [override] 「按实际线重算」用：一次性覆盖表单（不依赖 setState 的异步生效）
       */
      const save = useCallback(async (override) => {
        if (form === null || saving) return;
        const payload = override !== undefined && override !== null ? override : form;
        setSaving(true);
        setStatus(null);
        setConfirmReset(false);
        try {
          const info = nativeLineInfo(native);
          const nativeRatio = native !== null && native.autoEnabled !== false && info.actual !== null ? info.actual : null;
          const res = await fetch('/api/compact-relay-settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(nativeRatio === null ? payload : { ...payload, nativeRatio }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) throw new Error(data && data.message ? String(data.message) : '保存失败');
          applyLoaded(data);
          setStatus({ text: '已保存（立即生效，不需要重启）' });
        } catch (error) {
          setStatus({ error: true, text: `保存失败：${error && error.message ? error.message : '未知错误'}` });
        } finally {
          setSaving(false);
        }
      }, [form, saving, applyLoaded, native]);

      /** 恢复默认 = 删除用户设置文件；先二次确认，避免误点丢掉配色。 */
      const reset = useCallback(async () => {
        if (saving) return;
        setSaving(true);
        setStatus(null);
        try {
          const res = await fetch('/api/compact-relay-settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reset: true }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false) throw new Error(data && data.message ? String(data.message) : '恢复默认失败');
          applyLoaded(data);
          setConfirmReset(false);
          setStatus({ text: '已恢复默认设置' });
        } catch (error) {
          setStatus({ error: true, text: `恢复默认失败：${error && error.message ? error.message : '未知错误'}` });
        } finally {
          setSaving(false);
        }
      }, [saving, applyLoaded]);

      /**
       * 0.4.2：「按实际线重算」——目标 = 实际触发线 −5pp（整数百分位，guard 已算好）。
       * 二次确认后一次性保存（不走 patch + save 的异步状态，避免发出旧表单）。
       */
      const applyRecalc = useCallback(async () => {
        if (form === null || confirmRecalc === null || saving) return;
        const next = setIn(form, ['thresholds', 'handoffRatio'], confirmRecalc.ratio);
        setConfirmRecalc(null);
        await save(next);
      }, [form, confirmRecalc, saving, save]);

      /** 0.3.1：关闭/恢复 DSH 原生自动压缩（写 profile 配置，备份后重启生效）。 */
      const applyNative = useCallback(
        async (enabled) => {
          if (nativeBusy) return;
          setNativeBusy(true);
          setNativeStatus(null);
          try {
            const res = await fetch('/api/compact-relay-action', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'native-auto', enabled }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.ok === false) throw new Error(data && data.message ? String(data.message) : '调整失败');
            setConfirmNative(null);
            setNativeStatus({ text: data.message ?? (enabled ? '已恢复 DSH 原生自动压缩' : '已关闭 DSH 原生自动压缩') });
            await load();
          } catch (error) {
            setNativeStatus({ error: true, text: `调整失败：${error && error.message ? error.message : '未知错误'}` });
          } finally {
            setNativeBusy(false);
          }
        },
        [nativeBusy, load],
      );

      // UI-003：确认块出现时滚进视野（以前它渲染在设置页底部以外，用户以为「点了没反应」）。
      useEffect(() => {
        if (confirmNative !== null && nativeConfirmRef.current && typeof nativeConfirmRef.current.scrollIntoView === 'function') {
          nativeConfirmRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }, [confirmNative]);

      /**
       * 0.4 P0-2：生成诊断信息。
       *
       * 唯一的网络调用是同源只读 GET（`/api/compact-relay-diagnostics`，仅此一次）；
       * 产物由宿主生成（白名单 + 已脱敏），这里只负责展示/复制。
       */
      const generateDiagnostics = useCallback(
        async ({ openPreview = true } = {}) => {
          if (diagLoading) return null;
          setDiagLoading(true);
          setDiagStatus(null);
          try {
            const res = await fetch('/api/compact-relay-diagnostics', { cache: 'no-store' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.ok === false) throw new Error(data && data.message ? String(data.message) : '生成失败');
            setDiagData(data);
            if (openPreview) setDiagOpen(true);
            return data;
          } catch (error) {
            setDiagStatus({ error: true, text: `生成失败：${error && error.message ? error.message : '未知错误'}` });
            return null;
          } finally {
            setDiagLoading(false);
          }
        },
        [diagLoading],
      );

      /** 「打开问题报告页」：没生成就先生成，再打开宿主拼好的短字段 URL（不碰诊断正文）。 */
      const openIssueReport = useCallback(async () => {
        let data = diagData;
        if (data === null || typeof data.issueUrl !== 'string') data = await generateDiagnostics({ openPreview: false });
        if (data === null || typeof data.issueUrl !== 'string') return;
        try {
          window.open(data.issueUrl, '_blank', 'noopener');
        } catch {
          flashDiagStatus({ error: true, text: '打开问题报告页失败：新窗口被浏览器拦截了' });
        }
      }, [diagData, generateDiagnostics, flashDiagStatus]);

      /** 复制 Markdown / JSON：统一走 navigator.clipboard?.writeText，失败就地提示。 */
      const copyDiagnostics = useCallback(
        (format) => {
          if (diagData === null) {
            flashDiagStatus({ error: true, text: '还没有可复制的诊断信息，请先生成' });
            return;
          }
          const text =
            format === 'json' ? JSON.stringify(diagData.json, null, 2) : typeof diagData.markdown === 'string' ? diagData.markdown : '';
          if (typeof text !== 'string' || text.length === 0) {
            flashDiagStatus({ error: true, text: '还没有可复制的诊断信息，请先生成' });
            return;
          }
          const done = () => flashDiagStatus({ text: '已复制诊断信息（脱敏）' });
          const failed = () => flashDiagStatus({ error: true, text: '复制失败：浏览器不允许访问剪贴板，可手动选中预览文本' });
          try {
            const written = navigator.clipboard?.writeText(text);
            if (written !== undefined && typeof written.then === 'function') written.then(done, failed);
            else done();
          } catch {
            failed();
          }
        },
        [diagData, flashDiagStatus],
      );

      const closeDiagnosticsPreview = useCallback(() => {
        setDiagOpen(false);
        setDiagIntroSeen(true);
      }, []);

      if (form === null) {
        return h(
          'div',
          { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))', padding: '8px 0' } },
          status && status.error ? status.text : '读取设置中…',
        );
      }

      const percent = (ratio) => Math.round(ratio * 100);
      const compactPercent = percent(form.thresholds.compactRatio);
      const handoffPercent = percent(form.thresholds.handoffRatio);
      const count = (value) => (Number.isFinite(value) ? value : 0);
      // 0.4 P1-3：轻账本一行累计数字（只读；数据来自宿主账本，与账本文件同源）。
      const ledgerLine = (() => {
        if (ledger === null) return '累计：暂无记录（完成一次压缩/交接后开始统计）';
        const freed = count(ledger.freedTokens);
        const freedText = freed >= 1_000_000 ? `${(freed / 1_000_000).toFixed(1)}M` : freed >= 1000 ? `${(freed / 1000).toFixed(1)}K` : String(freed);
        const avg = ledger.avgDurationMs !== null && Number.isFinite(ledger.avgDurationMs) ? `${(ledger.avgDurationMs / 1000).toFixed(1)}s` : '—';
        return `累计：已压缩 ${count(ledger.compactCount)} 次 · 交接 ${count(ledger.handoffCount)} 次 · 腾出约 ${freedText} tokens · 平均耗时 ${avg}`;
      })();

      const autoOnNative = native !== null && native.autoEnabled !== false;
      // 0.4.1：配置阈值（thresholdRatio）只是理论上限；实际触发线由宿主按 token 预算算。
      const nativeInfo = nativeLineInfo(native);
      const nativePercent = nativeInfo.configured !== null ? Math.round(nativeInfo.configured * 100) : 80;
      // 原生压缩已关闭时 effective/percentText 为空：回落到「开启后实际会触发多少」，再回落配置阈值。
      const nativeActualText = nativeInfo.percentText !== '' ? nativeInfo.percentText : nativeInfo.actualText !== '' ? nativeInfo.actualText : nativeInfo.configuredText !== null ? nativeInfo.configuredText : String(nativePercent);
      /**
       * 0.4.2（P0-1/P1）：交接线硬上限 = 实际触发线 −5pp（整数百分位），与后台 save() 同一份判定。
       * 实际线算不出时退回配置阈值 −1pp 兜底（与 0.4.1 一致，仅限制输入上限，不告警）。
       * 注意：这里读 nativeInfo.actual（真实触发线），不能用 effective（autoOff/算不出时它会回落配置阈值）。
       */
      const handoffGuardInfo = handoffGuard({
        actualRatio: nativeInfo.actual,
        configuredRatio: nativeInfo.configured,
        handoffRatio: form.thresholds.handoffRatio,
        compactRatio: form.thresholds.compactRatio,
        autoEnabled: autoOnNative,
        fallback: 'configured',
      });
      const handoffCapPercent = handoffGuardInfo.capPercent;
      const handoffLate = handoffGuardInfo.source === 'actual' && handoffGuardInfo.ok === false;
      const handoffCapHint =
        handoffGuardInfo.source === 'actual'
          ? `当前模型实际触发 ${nativeInfo.actualText}%，最高可设 ${handoffCapPercent}%（实际触发线 −5pp）。`
          : autoOnNative && handoffCapPercent !== null
            ? `实际触发线未知（会话未就绪或算不出），暂按配置阈值最高 ${handoffCapPercent}%。`
            : '';
      const handoffNativeWarning = handoffLate ? `⚠ ${handoffGuardInfo.message}` : '';
      // 重算目标 ≤ 压缩线时（保持「交接线 > 压缩线」现有约束）点按钮直接拒绝并提示先降压缩线。
      const handoffRecalcConflict =
        handoffGuardInfo.compactConflict && handoffCapPercent !== null
          ? `按实际线重算目标 ${handoffCapPercent}% 不高于压缩线 ${compactPercent}%，请先把压缩线降到 ${handoffCapPercent}% 以下。`
          : '';
      const previewLight = paletteForScheme(form.colors, 'light');
      const previewDark = paletteForScheme(form.colors, 'dark');
      // 0.4 P0-2：诊断预览弹层复用指示灯那套浮层材质（15-shared.panelChrome）。
      const theme = detectTheme();
      const banner = settingsError === null ? null : h(
        'div',
        { style: { marginBottom: 14, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-state-warning-primary, #d97706)', background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))' } },
        h(
          'div',
          { style: { fontSize: 12, color: 'var(--dsw-alias-state-warning-primary, #b45309)' } },
          `设置文件有误${settingsError.field ? `（${settingsError.field}）` : ''}：${settingsError.message}`,
        ),
        h('div', { style: { ...settingsHintStyle, marginTop: 4 } }, '已按默认设置启动；点「恢复默认」会删除这个文件。'),
      );

      const swatch = (color, scheme) =>
        h('span', {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))',
          },
        }, h('i', { style: { width: 10, height: 10, borderRadius: 999, background: color, display: 'inline-block' } }), scheme);

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', maxWidth: 680, padding: '4px 0 20px' } },
        h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, '压缩接力'),
        h(
          'p',
          { style: { margin: '0 0 4px', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.95))' } },
          '功能：看上下文容量、到线提醒并帮你压缩旧会话 / 交接新会话、锁定重要消息；边界：只动本插件的压缩与交接历史，不改模型回复，也不接管 DSH 原生自动压缩（只在本页开关、改了要重启）。',
        ),
        h('p', { style: { ...settingsHintStyle, marginBottom: 10 } }, '这里改的设置立即生效，不需要重启。阈值按窗口比例算：换不同上下文窗口的模型会自动缩放。'),
        banner,
        sectionHeading('压缩提示'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', paddingLeft: 16, borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))' }, 'data-cr-group': '压缩提示' },
          settingsRow(
            '最小压缩线',
            '低于这条线，压缩不划算（摘要可能比原文还大），模型不会建议压缩，环上也不出断点。',
            '它会随「保留近期原文」和模型窗口自动抬高，保证压缩一定有净收益；不用细调，默认 5% 就行。',
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                type: 'number', min: 1, max: 60, step: 1, value: Math.round(form.thresholds.minRatio * 100), 'aria-label': '最小压缩线（百分比）', style: { ...settingsInputStyle, width: 90 },
                onChange: (event) => patch(['thresholds', 'minRatio'], Math.min(0.6, Math.max(0.01, Number(event.target.value) / 100))),
              }),
              h('span', { style: settingsHintStyle }, '% 窗口'),
            ),
          ),
          settingsRow(
            '压缩提醒线',
            '指示灯到这条线开始变琥珀色，菜单也会建议「压缩旧会话」。',
            '调高 → 更晚提醒、压得更少但上下文更长；调低 → 更早提醒、压得更勤。',
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                type: 'number', min: 5, max: 95, step: 1, value: compactPercent, 'aria-label': '压缩提醒线（百分比）', style: { ...settingsInputStyle, width: 90 },
                onChange: (event) => patch(['thresholds', 'compactRatio'], Math.min(0.95, Math.max(0.05, Number(event.target.value) / 100))),
              }),
              h('span', { style: settingsHintStyle }, '% 窗口'),
              h('span', { style: settingsHintStyle }, `（1M 窗口 ≈ ${Math.round(1000000 * form.thresholds.compactRatio / 1000)}K）`),
            ),
          ),
          settingsRow(
            '交接提醒线',
            '到这条线内圆亮红点，菜单建议「交接新会话」。',
            `调高 → 更晚换会话、单会话更久；调低 → 更早换会话、单会话更短。必须大于压缩线。${handoffCapHint}${handoffNativeWarning}`,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('input', {
                type: 'number',
                min: 5,
                max: handoffCapPercent !== null ? handoffCapPercent : 99,
                step: 1,
                value: handoffPercent,
                'aria-label': '交接提醒线（百分比）',
                style: { ...settingsInputStyle, width: 90 },
                onChange: (event) => {
                  // 0.4.2：不再静默夹紧到上限——超限由保存时「拒绝 + 提示目标值」处理（范围定稿）。
                  const raw = Number(event.target.value) / 100;
                  if (!Number.isFinite(raw)) return;
                  patch(['thresholds', 'handoffRatio'], Math.min(0.99, Math.max(0.05, raw)));
                },
              }),
              h('span', { style: settingsHintStyle }, '% 窗口'),
              h('span', { style: settingsHintStyle }, `（1M 窗口 ≈ ${Math.round(1000000 * form.thresholds.handoffRatio / 1000)}K）`),
              // 0.4.2（P0-1）：违规时给「按实际线重算」——目标 = 实际触发线 −5pp（整数百分位），保存前二次确认。
              handoffLate && handoffCapPercent !== null
                ? h('button', {
                    type: 'button',
                    'data-cr-recalc': '1',
                    disabled: saving,
                    title: `按当前模型实际触发线 ${nativeInfo.actualText}% 重算：最高可设 ${handoffCapPercent}%`,
                    style: { ...settingsButtonStyle, height: 26, fontSize: 11, padding: '0 10px', cursor: saving ? 'wait' : 'pointer' },
                    onClick: () => {
                      if (handoffRecalcConflict !== '') {
                        setConfirmRecalc(null);
                        setStatus({ error: true, text: handoffRecalcConflict });
                        return;
                      }
                      setStatus(null);
                      setConfirmRecalc({ ratio: handoffGuardInfo.target, percent: handoffCapPercent });
                    },
                  }, `按实际线重算（${handoffCapPercent}%）`)
                : null,
            ),
          ),
          confirmRecalc === null
            ? null
            : h(
                'div',
                {
                  'data-cr-recalc-confirm': '1',
                  style: {
                    margin: '0 0 14px',
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--dsw-alias-state-warning-primary, #d97706)',
                    background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
                  },
                },
                h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4 } }, `确认把「交接提醒线」改为 ${confirmRecalc.percent}%？`),
                h(
                  'div',
                  { style: { ...settingsHintStyle, marginBottom: 8 } },
                  `当前模型实际触发 ${nativeInfo.actualText}%，按「实际线 −5pp」向下取整到 ${confirmRecalc.percent}%；` +
                    '点「确认重算」会立即保存生效（不改压缩线、不动其它设置）。',
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8 } },
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: saving,
                      'data-cr-recalc-ok': '1',
                      style: { padding: '4px 12px', borderRadius: 6, border: '1px solid #d97706', background: '#d97706', color: '#fff', cursor: saving ? 'wait' : 'pointer', fontSize: 12 },
                      onClick: () => {
                        void applyRecalc();
                      },
                    },
                    saving ? '保存中…' : '确认重算',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: saving,
                      style: { padding: '4px 12px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))', background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)', cursor: 'pointer', fontSize: 12 },
                      onClick: () => setConfirmRecalc(null),
                    },
                    '取消',
                  ),
                ),
              ),
        ),
        sectionHeading('压缩行为'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', paddingLeft: 16, borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))' }, 'data-cr-group': '压缩行为' },
          settingsRow(
            '摘要份数上限',
            '会话里压缩摘要到这么多份后，也建议交接；下次压缩会把旧摘要一并合并。',
            '调高 → 可以多压几轮再交接；调低 → 更早交接，旧摘要更早被合并。',
            h('input', {
              type: 'number', min: 0, max: 20, step: 1, value: count(form.thresholds.maxSummaries), 'aria-label': '摘要份数上限', style: { ...settingsInputStyle, width: 90 },
              onChange: (event) => patch(['thresholds', 'maxSummaries'], Math.max(0, Math.round(Number(event.target.value)))),
            }),
          ),
          settingsRow(
            '保留近期原文',
            '压缩时，这段 token 范围内的近期消息保持原文，不压成摘要。',
            '调高 → 保留更多原文、压缩后省得更少；调低 → 压得更狠、可能丢掉近期细节。',
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('input', {
                type: 'number', min: 0, max: 200000, step: 1000, value: count(form.retention.recentTailTokens), 'aria-label': '保留近期原文（token）', style: { ...settingsInputStyle, width: 120 },
                onChange: (event) => patch(['retention', 'recentTailTokens'], Math.max(0, Math.round(Number(event.target.value)))),
              }),
              h('span', { style: settingsHintStyle }, 'token'),
            ),
          ),
          settingsRow(
            '交接单目录',
            '/handoff 生成的九段交接单保存到这里。',
            '改到别的目录后，旧交接单不会自动搬过去；「查看交接单」只列新目录。',
            h('input', {
              type: 'text', 'aria-label': '交接单目录', value: form.handoffDir, style: { ...settingsInputStyle, width: '100%' },
              onChange: (event) => patch(['handoffDir'], event.target.value),
            }),
          ),
        ),
        sectionHeading('DSH 原生自动压缩'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', paddingLeft: 16, borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))' }, 'data-cr-group': 'DSH 原生自动压缩' },
          settingsRow(
            '自动压缩开关',
            native === null
              ? '正在读取 DSH 配置…'
              : autoOnNative
                ? `当前开启：容量到 ${nativeActualText}% 时，DSH 会自己把历史压成摘要（不读本插件的锁定）。`
                : '当前已关闭：DSH 不再自动压历史，只有你主动压缩/交接才会动历史。',
            autoOnNative
              ? `开启时：容量到 ${nativeActualText}% DSH 会自己压历史（不读锁定）；关闭后：只在你主动压缩/交接时才动历史。${nativeInfo.differs ? `（${nativeInfo.why}）` : ''}`
              : '开启后：DSH 会在容量到原生阈值时自动压历史，可能压掉锁定的消息；本插件的提醒照常。',
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
              h(
                'button',
                {
                  type: 'button',
                  role: 'switch',
                  'aria-checked': autoOnNative ? 'true' : 'false',
                  'aria-label': 'DSH 原生自动压缩开关',
                  'data-cr-native-switch': autoOnNative ? 'on' : 'off',
                  disabled: native === null || nativeBusy,
                  onClick: () => {
                    setNativeStatus(null);
                    setConfirmNative(autoOnNative ? 'disable' : 'enable');
                  },
                  style: {
                    position: 'relative',
                    width: 42,
                    height: 24,
                    padding: 0,
                    borderRadius: 999,
                    flex: '0 0 auto',
                    border: `1px solid ${autoOnNative ? 'transparent' : 'var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))'}`,
                    background: autoOnNative ? '#2563EB' : 'rgba(127,127,127,0.25)',
                    cursor: native === null || nativeBusy ? 'wait' : 'pointer',
                    transition: 'background 160ms ease',
                  },
                },
                h('span', {
                  'aria-hidden': true,
                  style: {
                    position: 'absolute',
                    top: 3,
                    left: autoOnNative ? 21 : 3,
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: '#fff',
                    transition: 'left 160ms ease',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
                  },
                }),
              ),
              h('span', { style: { fontSize: 12, fontWeight: 600, minWidth: 44 } }, native === null ? '读取中…' : nativeBusy ? '处理中…' : autoOnNative ? '已开启' : '已关闭'),
              h('span', { style: settingsHintStyle }, native !== null
                ? (nativeInfo.autoOff
                  ? (nativeInfo.actualText !== ''
                    ? `原生阈值 配置 ${nativeInfo.configuredText ?? nativePercent}%（已关闭；开启后实际触发 ${nativeInfo.actualText}%）`
                    : `原生阈值 配置 ${nativeInfo.configuredText ?? nativePercent}%（已关闭）`)
                  : (nativeInfo.differs ? `原生阈值 配置 ${nativeInfo.configuredText}%（实际触发 ${nativeInfo.percentText}%）` : `原生阈值 ${nativeActualText}%`))
                : ''),
              nativeStatus === null
                ? null
                : h(
                    'span',
                    {
                      'data-cr-native-status': nativeStatus.error ? 'error' : 'ok',
                      style: {
                        fontSize: 11,
                        lineHeight: '16px',
                        color: nativeStatus.error ? 'var(--dsw-alias-state-error-primary, #D92D20)' : 'var(--dsw-alias-state-success-primary, #15803D)',
                      },
                    },
                    nativeStatus.text,
                  ),
            ),
          ),
          confirmNative === null
            ? null
            : h(
                'div',
                {
                  ref: nativeConfirmRef,
                  style: {
                    margin: '0 0 14px',
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--dsw-alias-state-warning-primary, #d97706)',
                    background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
                  },
                },
                h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4 } }, confirmNative === 'disable' ? '确认关闭 DSH 原生自动压缩？' : '确认恢复 DSH 原生自动压缩？'),
                h(
                  'div',
                  { style: { ...settingsHintStyle, marginBottom: 8 } },
                  confirmNative === 'disable'
                    ? `操作内容：在 DSH profile 的 cordis.patch.yml 里把 compaction-basic 的 auto 改为 false（写前备份原文件，可回滚）。` +
                      `改变：DSH 不再在容量到 ${nativeActualText}% 时自动压缩历史；锁定的消息不会被压掉；本插件的提醒和手动压缩照常。需要重启 DSH 生效。`
                    : `操作内容：在 DSH profile 的 cordis.patch.yml 里把 compaction-basic 的 auto 改回 true（写前备份，可回滚）。` +
                      `改变：DSH 重新在容量到 ${nativeActualText}% 时自动压历史，可能压掉锁定的消息。需要重启 DSH 生效。`,
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8 } },
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: nativeBusy,
                      style: { padding: '4px 12px', borderRadius: 6, border: '1px solid #d97706', background: '#d97706', color: '#fff', cursor: nativeBusy ? 'wait' : 'pointer', fontSize: 12 },
                      onClick: () => {
                        void applyNative(confirmNative === 'enable');
                      },
                    },
                    nativeBusy ? '处理中…' : '确认调整',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: nativeBusy,
                      style: { padding: '4px 12px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))', background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)', cursor: 'pointer', fontSize: 12 },
                      onClick: () => setConfirmNative(null),
                    },
                    '取消',
                  ),
                ),
              ),
        ),
        sectionHeading('颜色与外观'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', paddingLeft: 16, borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))' }, 'data-cr-group': '颜色与外观' },
          h(
            'p',
            { style: { ...settingsHintStyle, marginBottom: 12 } },
            '当前预览：',
            swatch(previewLight.idle, '浅色'),
            ' ',
            swatch(previewDark.idle, '深色'),
            '（按你选的基准色自动派生；下面每行也会显示该颜色的两套结果）',
          ),
          settingsRow(
            '颜色模式',
            '指示灯颜色跟随界面浅色/深色自动切换。',
            '自动 → 跟随界面明暗；浅色/深色 → 强制使用对应一套配色。',
            h('select', {
              'aria-label': '颜色模式', value: form.colors.mode, style: { ...settingsInputStyle, width: 140 },
              onChange: (event) => patch(['colors', 'mode'], event.target.value),
            },
              h('option', { value: 'auto' }, '自动（跟随界面）'),
              h('option', { value: 'light' }, '浅色'),
              h('option', { value: 'dark' }, '深色'),
            ),
          ),
          settingsRow(
            '自动适配颜色',
            '按界面明暗自动调整你选的颜色明度，保证细色环看得清。',
            '开 → 只选 3 个基准色即可；关 → 颜色原样用于两种界面（需要自己保证对比度）。',
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 } },
              h('input', {
                type: 'checkbox', 'aria-label': '自动适配颜色', checked: form.colors.autoAdapt !== false,
                onChange: (event) => patch(['colors', 'autoAdapt'], event.target.checked),
              }),
              '开启自动适配（推荐）',
            ),
          ),
          h('p', { style: { ...settingsHintStyle, margin: '2px 0 6px' } }, '预设：'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 } },
            COLOR_PRESETS.map((preset) =>
              h('button', {
                key: preset.id, type: 'button', style: settingsButtonStyle,
                onClick: () => patch(['colors', 'base'], { ...preset.base }),
              }, preset.label),
            ),
          ),
          settingsRow(
            '默认颜色（① 正常）',
            '没到任何线时的外环颜色。',
            '换更显眼的色 → 平时更容易注意到指示灯；换更淡的色 → 更安静。',
            colorField(form.colors.base.idle, (value) => patch(['colors', 'base', 'idle'], value), '默认颜色'),
          ),
          settingsRow(
            '填满颜色（② 正常区走满）',
            '正常区（从 0 到第一个断点）走满后整段变成这个颜色。',
            '换成和压缩色（琥珀）差别大的颜色（如蓝）→ 越线时更醒目；换成接近灰色 → 更安静。',
            colorField(form.colors.base.stage, (value) => patch(['colors', 'base', 'stage'], value), '填满颜色'),
          ),
          settingsRow(
            '调整颜色（③ 该压缩）',
            '到压缩线后的外环颜色，提示该压缩旧会话了。',
            '调暖/调亮 → 提醒更强；接近默认色 → 提醒更弱。',
            colorField(form.colors.base.compact, (value) => patch(['colors', 'base', 'compact'], value), '调整颜色'),
          ),
          settingsRow(
            '上限颜色（④ 该交接）',
            '到交接线时的内圆红点（外环到线时也用它）。',
            '调成更醒目的红 → 交接信号更强；换其他色 → 和「该压缩」的区分度会变化。',
            colorField(form.colors.base.handoff, (value) => patch(['colors', 'base', 'handoff'], value), '上限颜色'),
          ),
          settingsRow(
            '锁定颜色（⑤ 锁定的消息）',
            '锁定重要消息后，指示灯环上按消息位置显示的块；最重要的信号，默认用最醒目的品红。',
            '换成更醒目的反差色 → 锁定位置一眼可见；换成接近默认色 → 更安静（但可能看不清标记）。',
            colorField(form.colors.base.pin, (value) => patch(['colors', 'base', 'pin'], value), '锁定颜色'),
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' } },
            h('button', { type: 'button', style: { ...settingsButtonStyle, background: 'var(--dsw-alias-button-primary, #2563eb)', color: '#fff', border: 'none' }, disabled: saving, onClick: () => void save() }, saving ? '保存中…' : dirty ? '保存修改' : '保存'),
            dirty ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-warning-primary, #b45309)' } }, '有未保存的修改') : null,
            status !== null ? h('span', { style: { fontSize: 11, color: status.error ? 'var(--dsw-alias-state-error-primary, #d92d20)' : 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' } }, status.text) : null,
            h('span', { style: settingsHintStyle }, '改完点这里保存；恢复默认在页面最底部。'),
          ),
        ),
        sectionHeading('帮助'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', paddingLeft: 16, borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))' }, 'data-cr-group': '帮助' },
          // 0.3.1：教学卡片——几个示意小环 + 一句说明（不是截图，SVG 随用户配色/阈值变）。
          (() => {
            // BUG-009（2026-10-20）：每个示例环单独构造参数——比例按各自语义取、hint 用 null；
            // 不再共用 minRatio + 0.12 的假断点（那会让 5 个环的断点全挤在同一处、颜色也对不上）。
            const demoRatio = (ratio, hintRatio) => ringSegments(ratio, form.thresholds.compactRatio, form.thresholds.handoffRatio, hintRatio ?? null);
            // 点坐标/弧线 path 是共享几何（15-shared.js 的 ringPoint / ringArcPath）。
            const colorOf = (key) =>
              key === 'stage' ? previewLight.stage : key === 'compact' ? previewLight.compact : key === 'handoff' ? previewLight.handoff : previewLight.idle;
            const demoRing = (ring, options = {}) => {
              // 断点缺口：真实断点 + 示例专用缺口（「走满正常区」在压缩线上补一个，示意「到线就是断点1」）。
              const gap = 0.012;
              const gaps = [...ring.boundaries.map((boundary) => boundary.at), ...(options.extraGaps ?? [])];
              // 原生自动压缩线：和指示灯一样用「径向紫色刻度 + 底色描边」；越过线后整环红色闪烁。
              const nativeAt =
                typeof options.nativeAt === 'number' && options.nativeAt > 0.02 && options.nativeAt < 1 ? options.nativeAt : null;
              const nativeTick = nativeAt === null ? null : nativeTickAt(nativeAt);
              const nativeCrossed = nativeAt !== null && ring.ratio > nativeAt + 1e-9;
              return h(
                'svg',
                { viewBox: '0 0 20 20', width: 46, height: 46, 'aria-hidden': true, style: { display: 'block' } },
                h('circle', { cx: 10, cy: 10, r: 8, fill: 'none', stroke: 'rgba(127,127,127,0.28)', strokeWidth: 2 }),
                ...ring.segments
                  .filter((segment) => segment.to - segment.from > 0.001)
                  .map((segment, index) => {
                    // 和真实指示灯一致：首段从 0 画起、末段画到当前进度，都不让缺口。
                    const from = segment.from <= 1e-9 ? segment.from : segment.from + gap;
                    const to = Math.abs(segment.to - ring.ratio) < 1e-9 ? segment.to : segment.to - gap;
                    if (to - from <= 0.001) return null;
                    return h('path', { key: index, d: ringArcPath(from, to), fill: 'none', stroke: colorOf(segment.color), strokeWidth: 2, strokeLinecap: 'round', 'data-cr-demo': segment.color });
                  })
                  .filter((node) => node !== null),
                // 断点缺口用「背景色小段」强调一下（教学图里看得清）
                ...gaps.map((at, index) =>
                  h('path', { key: `b${index}`, d: ringArcPath(at - 0.01, at + 0.01), fill: 'none', stroke: 'var(--dsw-alias-bg-base, #fff)', strokeWidth: 3, 'data-cr-demo-gap': String(at) }),
                ),
                // 越过原生压缩线：整环红色闪烁（教学图里也演示出来）。
                ...(nativeCrossed
                  ? [
                      h('style', { key: 'native-alert-style' }, NATIVE_ALERT_CSS),
                      h('circle', {
                        key: 'native-alert',
                        cx: 10,
                        cy: 10,
                        r: 8,
                        fill: 'none',
                        stroke: previewLight.handoff,
                        strokeWidth: 2.4,
                        strokeLinecap: 'round',
                        style: { animation: 'cr-native-alert 1s ease-in-out infinite' },
                        'data-cr-native-alert': '1',
                      }),
                    ]
                  : []),
                ...(nativeTick === null
                  ? []
                  : [
                      h('line', { key: 'native-casing', ...nativeTick, stroke: 'var(--dsw-alias-bg-base, #fff)', strokeWidth: 4.2, strokeLinecap: 'round', opacity: 0.92 }),
                      h('line', { key: 'native-line', ...nativeTick, stroke: NATIVE_LINE_COLOR, strokeWidth: 2.2, strokeLinecap: 'round', 'data-cr-demo-native': String(nativeAt) }),
                    ]),
              );
            };
            const compactRatio = form.thresholds.compactRatio;
            const handoffRatio = form.thresholds.handoffRatio;
            const legend = [
              // 每个示例的 ratio / hint 都按它要说明的状态单独给，不再共用 hint。
              { ratio: Math.max(0.045, form.thresholds.minRatio * 0.9), hint: null, title: '还没到最小线', text: '灰：正常，别急着压' },
              { ratio: compactRatio, hint: null, extraGaps: [compactRatio], title: '走满正常区', text: '蓝 + 断点1（该压缩的位置）' },
              { ratio: compactRatio + 0.08, hint: null, title: '进入压缩区', text: '琥珀：建议压缩旧会话' },
              { ratio: handoffRatio + 0.15, hint: null, title: '越过交接线', text: '红：建议交接新会话' },
            ];
            if (native !== null && native.autoEnabled !== false && nativeInfo.effective !== null) {
              legend.push({
                ratio: Math.min(0.95, nativeInfo.effective + 0.06),
                hint: null,
                nativeAt: nativeInfo.effective,
                title: '原生自动压缩线',
                text: nativeInfo.differs
                  ? `实际 ${nativeInfo.percentText}%：DSH 会自己压历史（配置阈值 ${nativeInfo.configuredText}%，越过整环红色闪烁）`
                  : `${nativeInfo.percentText}%：DSH 会自己压历史（越过整环红色闪烁）`,
              });
            }
            return h(
              'div',
              { style: { marginBottom: 16, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.25))', background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.04))' } },
              h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '指示灯怎么看'),
              h(
                'div',
                { style: { display: 'flex', gap: 16, flexWrap: 'wrap' } },
                ...legend.map((item) =>
                  h(
                    'div',
                    { key: item.title, 'data-cr-demo-item': item.title, style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 150 } },
                    demoRing(demoRatio(Math.min(0.95, item.ratio), item.hint), { extraGaps: item.extraGaps, nativeAt: item.nativeAt }),
                    h(
                      'div',
                      { style: { fontSize: 11, lineHeight: '15px' } },
                      h('div', { style: { fontWeight: 600 } }, item.title),
                      h('div', { style: { color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' } }, item.text),
                    ),
                  ),
                ),
              ),
              h('div', { style: { ...settingsHintStyle, marginTop: 6 } }, '断点=小缺口：我判断「这里适合压缩」的位置（模型判断或到线自动出现）；压缩后环变短，断点自然消失。'),
            );
          })(),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 } },
            h(
              'button',
              {
                type: 'button',
                style: settingsButtonStyle,
                'data-cr-replay-onboarding': '1',
                onClick: () => {
                  try {
                    window.dispatchEvent(new CustomEvent('compact-relay:replay-onboarding', { detail: { pulseMs: 9000, toastMs: 20000 } }));
                  } catch {
                    /* ignore */
                  }
                  setOnboardingNotice('已重新播放：关掉设置页后，指示灯会呼吸光晕并再弹一次引导（提示约 20 秒）。');
                },
              },
              '再看一次初次引导',
            ),
            onboardingNotice === null
              ? null
              : h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.9))' } }, onboardingNotice),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 18 } },
            githubLink('使用教程（GitHub）', form.links?.tutorial, '使用教程：未配置链接'),
            githubLink('反馈 / 提 bug（GitHub Issues）', form.links?.feedback, '反馈 / 提 bug：未配置链接'),
            // 2026-10-20：0.3.1 已发布到 npm，帮助区直接给包页面入口。
            githubLink('npm 包页面', 'https://www.npmjs.com/package/dsh-compact-relay', ''),
          ),
          // 0.4 P0-2：诊断信息 —— 本机生成、白名单、已脱敏；只提供「生成/预览/复制」。
          h(
            'div',
            { style: { marginBottom: 18, paddingTop: 12, borderTop: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,0.25))' }, 'data-cr-diagnostics': '1' },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, '诊断信息'),
            h('p', { style: { ...settingsHintStyle, margin: '0 0 2px' } }, '只在本机生成，不会自动外发；生成后可以先预览，再决定把哪部分粘贴到哪里。'),
            h(
              'p',
              { style: settingsHintStyle },
              '内容只有版本、平台、配置数值、状态摘要、计数、耗时与错误码；不含聊天内容、摘要、交接单正文、文件路径、用户名、会话 id、密钥或 cookie。',
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 } },
              h(
                'button',
                {
                  type: 'button',
                  'data-cr-diagnostics-generate': '1',
                  style: settingsButtonStyle,
                  disabled: diagLoading,
                  onClick: () => void generateDiagnostics(),
                },
                diagLoading ? '生成中…' : '生成并预览',
              ),
              h(
                'button',
                { type: 'button', 'data-cr-diagnostics-issue': '1', style: settingsButtonStyle, onClick: () => void openIssueReport() },
                '打开问题报告页',
              ),
              diagStatus === null
                ? null
                : h(
                    'span',
                    {
                      'data-cr-diagnostics-status': diagStatus.error ? 'error' : 'ok',
                      style: {
                        fontSize: 11,
                        lineHeight: '16px',
                        color: diagStatus.error ? 'var(--dsw-alias-state-error-primary, #D92D20)' : 'var(--dsw-alias-state-success-primary, #15803D)',
                      },
                    },
                    diagStatus.text,
                  ),
            ),
            h('p', { style: { ...settingsHintStyle, marginTop: 6 } }, 'issue 页是公开的；粘贴前请自己再看一眼。'),
          ),
        ),
        sectionHeading('关于与危险操作'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', paddingLeft: 16, borderLeft: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))' }, 'data-cr-group': '关于与危险操作' },
          h('p', { style: settingsHintStyle }, `版本：${version || '—'}`),
          h('p', { style: settingsHintStyle, 'data-cr-ledger': '1' }, ledgerLine),
          h('p', { style: settingsHintStyle }, `设置文件：${settingsPath || '—'}`),
          h('p', { style: { ...settingsHintStyle, marginTop: 8 } }, '输入框左侧的上下文指示灯：看容量、提醒压缩/交接、锁住重要消息；到线了用 /bc 或 /handoff，重要内容用 /pin 锁住。'),
          h('p', { style: settingsHintStyle }, '遇到 bug 或想提改进：走上面「帮助」里的 GitHub Issues；也欢迎直接发邮件。'),
          h('p', { style: settingsHintStyle }, '联系方式：cfanzx@136.com（合作、安全问题，以及不便公开讨论的事项）。'),
          h('p', { style: settingsHintStyle }, 'npm 包页面：https://www.npmjs.com/package/dsh-compact-relay'),
          h('p', { style: settingsHintStyle }, '致谢：DeepSeek Harness；设置栏实现参考了 dsh-plugin-memory；也谢谢帮忙测试的朋友们。'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 20, paddingTop: 14, borderTop: '1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,0.25))', flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-state-error-primary, #d92d20)' } }, '危险操作'),
            confirmReset
              ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                  h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary, #d92d20)' } }, '确定恢复默认？（会删除你的设置文件）'),
                  h('button', { type: 'button', style: settingsButtonStyle, disabled: saving, onClick: () => void reset() }, '确定恢复'),
                  h('button', { type: 'button', style: settingsButtonStyle, disabled: saving, onClick: () => setConfirmReset(false) }, '取消'),
                )
              : h('button', { type: 'button', style: settingsButtonStyle, disabled: saving, onClick: () => setConfirmReset(true) }, '恢复默认'),
          ),
        ),
        // 0.4 P0-2：诊断信息预览弹层（只读等宽文本 + 复制 Markdown/JSON）。
        // 只有用户点了「生成并预览」/「打开问题报告页」才会出现；关掉后本次会话不再显示首次说明卡。
        diagOpen && diagData !== null
          ? h(
              'div',
              {
                'data-cr-diagnostics-modal': '1',
                style: {
                  position: 'fixed',
                  inset: 0,
                  zIndex: 60,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 24,
                  background: 'rgba(0,0,0,0.36)',
                },
              },
              h(
                'div',
                {
                  role: 'dialog',
                  'aria-modal': 'true',
                  'aria-label': '诊断信息预览（脱敏）',
                  style: {
                    ...panelChrome(theme),
                    display: 'flex',
                    flexDirection: 'column',
                    width: '100%',
                    maxWidth: 760,
                    maxHeight: '80vh',
                    borderRadius: 12,
                    padding: '14px 16px',
                  },
                },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
                  h('div', { style: { fontSize: 13, fontWeight: 700, color: 'var(--dsw-alias-label-primary, inherit)' } }, '诊断信息预览（脱敏）'),
                  h('button', { type: 'button', style: settingsButtonStyle, onClick: closeDiagnosticsPreview }, '关闭'),
                ),
                diagIntroSeen
                  ? null
                  : h(
                      'div',
                      {
                        style: {
                          marginTop: 10,
                          padding: '8px 10px',
                          borderRadius: 8,
                          border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.25))',
                          background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
                        },
                      },
                      h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 4 } }, '第一次生成：先看三点'),
                      h(
                        'p',
                        { style: settingsHintStyle },
                        '① 只在本机生成，插件不会自己发到任何地方；② 只有数值、枚举与错误码，不含聊天内容与文件路径；③ issue 页是公开的，粘贴前请自己再看一眼。',
                      ),
                    ),
                h(
                  'pre',
                  {
                    'data-cr-diagnostics-preview': '1',
                    'aria-label': '诊断信息 Markdown 预览（只读）',
                    style: {
                      flex: 1,
                      minHeight: 120,
                      overflow: 'auto',
                      margin: '10px 0',
                      padding: 10,
                      borderRadius: 8,
                      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.2))',
                      background: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.06))',
                      color: 'inherit',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                      fontSize: 11,
                      lineHeight: '16px',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      userSelect: 'text',
                    },
                  },
                  typeof diagData.markdown === 'string' && diagData.markdown.length > 0 ? diagData.markdown : '（没有内容）',
                ),
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                  h(
                    'button',
                    { type: 'button', 'data-cr-diagnostics-copy': 'markdown', style: settingsButtonStyle, onClick: () => copyDiagnostics('markdown') },
                    '复制 Markdown',
                  ),
                  h(
                    'button',
                    { type: 'button', 'data-cr-diagnostics-copy': 'json', style: settingsButtonStyle, onClick: () => copyDiagnostics('json') },
                    '复制 JSON',
                  ),
                  h('span', { style: settingsHintStyle }, 'issue 是公开的；粘贴前请自己再看一眼。'),
                  diagStatus === null
                    ? null
                    : h(
                        'span',
                        {
                          'data-cr-diagnostics-copy-status': diagStatus.error ? 'error' : 'ok',
                          style: {
                            fontSize: 11,
                            lineHeight: '16px',
                            color: diagStatus.error
                              ? 'var(--dsw-alias-state-error-primary, #D92D20)'
                              : 'var(--dsw-alias-state-success-primary, #15803D)',
                          },
                        },
                        diagStatus.text,
                      ),
                ),
              ),
            )
          : null,
        // A4：复制/打开结果的短 toast（成功与失败都提示；自动消失，不挡操作）。
        diagStatus === null
          ? null
          : h(
              'div',
              {
                'data-cr-diagnostics-toast': diagStatus.error ? 'error' : 'ok',
                role: 'status',
                style: {
                  ...panelChrome(theme),
                  position: 'fixed',
                  right: 24,
                  bottom: 24,
                  zIndex: 70,
                  maxWidth: 360,
                  padding: '8px 12px',
                  borderRadius: 8,
                  fontSize: 12,
                  lineHeight: '17px',
                  color: diagStatus.error ? 'var(--dsw-alias-state-error-primary, #D92D20)' : 'var(--dsw-alias-label-primary, inherit)',
                },
              },
              diagStatus.text,
            ),
      );
    }
