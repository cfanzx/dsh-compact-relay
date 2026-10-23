
    /**
     * 跨片段共享的浮层 / 指示灯环小部件（30-indicator 与 50-settings 共用）。
     *
     * 为什么单独一个片段：这些几何/材质在「指示灯」和「设置页教学卡片」里各画过一遍，
     * 以前是两份点坐标/弧线 path/原生线刻度/闪烁 keyframes。放在 15 号片段（按文件名
     * 排序在 10-runtime 之后、20-format/30-indicator/50-settings 之前），函数声明会
     * 提升，后面的片段可直接调用；常量在使用点（组件渲染时）早已初始化。
     */

    /**
     * 环上比例 → SVG 坐标（viewBox 0 0 20 20，圆心 10,10，半径用 10-runtime 的 RADIUS）。
     * @param {number} value 0–1 的比例
     * @returns {[number, number]}
     */
    function ringPoint(value) {
      const angle = value * Math.PI * 2 - Math.PI / 2;
      return [10 + RADIUS * Math.cos(angle), 10 + RADIUS * Math.sin(angle)];
    }

    /**
     * 环上两比例之间的弧线 path（0.5 以上用大弧标志）。
     * @param {number} from
     * @param {number} to
     * @returns {string}
     */
    function ringArcPath(from, to) {
      const [x1, y1] = ringPoint(from);
      const [x2, y2] = ringPoint(to);
      const large = to - from > 0.5 ? 1 : 0;
      return `M ${x1.toFixed(3)} ${y1.toFixed(3)} A ${RADIUS} ${RADIUS} 0 ${large} 1 ${x2.toFixed(3)} ${y2.toFixed(3)}`;
    }

    /**
     * DSH 原生自动压缩线的「径向刻度」：穿过环带的一条短线（内 5.6 → 外 9.6）。
     * 指示灯与设置页教学图用同一套几何，只是描边/属性不同。
     * @param {number} value 合法的原生阈值比例（0.02–1 之间，调用方先校验）
     * @returns {{x1:number, y1:number, x2:number, y2:number}}
     */
    function nativeTickAt(value) {
      const angle = value * Math.PI * 2 - Math.PI / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      return { x1: 10 + 5.6 * cos, y1: 10 + 5.6 * sin, x2: 10 + 9.6 * cos, y2: 10 + 9.6 * sin };
    }

    /** 越过原生自动压缩线后「整环红色闪烁」的 keyframes（指示灯/教学图共用一份）。 */
    const NATIVE_ALERT_CSS = '@keyframes cr-native-alert { 0%,100% { opacity: 1 } 50% { opacity: 0.15 } } @media (prefers-reduced-motion: reduce) { [data-cr-native-alert] { animation: none !important; opacity: 0.85 !important; } }';

    /**
     * 浮层外观（菜单 / 悬停卡 / 确认卡 / 交接单面板 / 历史面板 / toast 共用）。
     * 主题色由 10-runtime 的 detectTheme() 给出（BUG-001：优先 DSH 主题 token）。
     * @param {object} theme detectTheme() 的返回值
     * @returns {{background:string, backdropFilter:string, WebkitBackdropFilter:string, border:string, boxShadow:string}}
     */
    function panelChrome(theme) {
      return {
        background: theme.panelBg,
        backdropFilter: theme.panelBackdrop,
        WebkitBackdropFilter: theme.panelBackdrop,
        border: `1px solid ${theme.panelBorder}`,
        boxShadow: theme.panelShadow,
      };
    }
