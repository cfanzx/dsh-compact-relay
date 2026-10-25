#!/usr/bin/env node
/**
 * 0.4.2 设置页 UX 真浏览器点验（隔离 home + Chrome CDP，不碰真 ~/.dsh）：
 *
 *   1. 打开设置 → 压缩接力；
 *   2. 断言保存工具条在页面顶部时就已经固定在视口底部（position:sticky，不用滚到页尾），
 *      并且按钮组与状态文字同一行（不错位）、整条不过高（紧凑）；
 *   3. 交接线改 65（上限 62）→ 点工具条里的保存：
 *      - 真实服务端（隔离环境能算出 actual 线时）应拒绝，粘性条 + 交接线行内都出现红色文案；
 *      - 算不出 actual 线时（隔离环境没模型路由），用页面内 fetch 替身返回同口径 400，
 *        只验证「客户端把失败显示在哪」；服务端真实拒绝由 test/settings-ux.mjs 的 HTTP 用例覆盖；
 *   4. 断言被拒后设置接口仍是 60%（没静默落盘）；
 *   5. 0.4.2 真机 bug 回归（「输入 80 他直接改成 99」）：
 *      - 真实键盘输入（focus → onFocus 全选 → 输入 80），断言输入框是 80、不是 99；
 *      - 点保存 → 两处红字（条内 + 行内），输入框仍是 80，设置没被落盘；
 *      - 再输入 62 → 保存成功（真实服务端 200），GET 回来是 0.62，未保存指示归零；
 *   6. 截图（错误态 / 成功态）存到 default-workspace/2026-10-25-收尾/；
 *   7. 滚到页面最底部，断言工具条仍在视口内（随时能点）。
 *
 * 用法（node >= 22）：
 *   node test/e2e/settings-ux.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import * as e2e from './lib.mjs';

const log = (...a) => console.log(...a);
const SHOT_DIR = '/Users/fanzixiao/Documents/deepseek-harness/default-workspace/2026-10-25-收尾';
const shotErrorDark = path.join(SHOT_DIR, '设置页-交接线80-保存被拒-深色.png');
const shotErrorLight = path.join(SHOT_DIR, '设置页-交接线80-保存被拒-浅色.png');
const shotSuccessLight = path.join(SHOT_DIR, '设置页-交接线62-保存成功-浅色.png');
let host = null;
let driver = null;

/**
 * 真鼠标点进交接线输入框（触发 onFocus/onClick 全选），再像真键盘一样输入。
 * 用真实 click 而不是 el.focus()：用户就是这么点的，全选也必须在「浏览器把光标落到点击位置」之后仍然成立。
 */
async function clickHandoffInput() {
  const box = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const input = d && d.querySelector('input[aria-label="交接提醒线（百分比）"]');
    if (!input) return null;
    input.scrollIntoView({ block: 'center' });
    const r = input.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`);
  if (box === null) throw new Error('找不到可见的交接线输入框');
  const { x, y } = JSON.parse(box);
  await driver.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await driver.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function typeHandoff(text) {
  await clickHandoffInput();
  const focused = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    return d.contains(document.activeElement) && document.activeElement.getAttribute('aria-label') === '交接提醒线（百分比）';
  })()`);
  if (!focused) throw new Error('点了但交接线输入框没拿到焦点');
  await driver.cdp.send('Input.insertText', { text: String(text) });
  await new Promise((resolve) => setTimeout(resolve, 250));
  return driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const input = d.querySelector('input[aria-label="交接提醒线（百分比）"]');
    return input ? input.value : null;
  })()`);
}

try {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  log('[1] prepareEnv');
  await e2e.prepareEnv({ installTimeoutMs: 180_000 });
  log('[2] startHost');
  host = await e2e.startHost({ timeoutMs: 120_000 });
  log('    host', host.baseUrl);
  log('[3] openGui');
  driver = await e2e.openGui(host.url, { host });
  log('[4] 复用启动时自动恢复的会话（本用例只验设置页，不必新建会话）');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const sessions = await e2e.listSessions(driver).catch(() => []);
  const active = sessions[0] ?? null;
  log('    sessions', sessions.length, 'active', active && active.sessionId, 'agent', active && active.agentAvailable);
  await driver.waitFor(`!!document.querySelector('button[data-cr-level]')`, 10_000).catch(() => {});

  // 与设置页 load() 同一路径：不带 sessionId 的 state 取「当前活动会话」的原生实际线。
  const state = await driver.eval(`fetch('/api/compact-relay-state', { cache: 'no-store' }).then((r) => r.json())`);
  const actualRatio = state && state.native && typeof state.native.ratio === 'number' ? state.native.ratio : null;
  const capPercent = actualRatio === null ? null : Math.floor(actualRatio * 100 - 5 + 1e-9);
  log('state.native.ratio =', actualRatio, '→ cap', capPercent, 'autoEnabled =', state && state.native && state.native.autoEnabled);

  log('[5] 打开设置 → 压缩接力');
  const openSettings = await driver.eval(`(() => {
    const avatar = document.querySelector('[data-avatar-status]');
    const btn = avatar && avatar.closest('button');
    if (btn) { btn.click(); return { ok: true, how: 'avatar' }; }
    const cands = [...document.querySelectorAll('button')].filter((b) => /菜单|账户|账号|menu/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.title || '')));
    if (cands.length > 0) { cands[0].click(); return { ok: true, how: 'label', aria: cands[0].getAttribute('aria-label') }; }
    return { ok: false };
  })()`);
  log('打开账户菜单:', JSON.stringify(openSettings));
  if (!openSettings.ok) throw new Error('找不到账户菜单入口');
  await new Promise((resolve) => setTimeout(resolve, 500));
  await driver.eval(`(() => {
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    const hit = items.find((el) => /^(设置|Settings)$/.test((el.innerText || '').trim())) || items.find((el) => /设置/.test(el.innerText || ''));
    if (hit) hit.click();
  })()`);
  await driver.waitFor(`!!document.querySelector('[role="dialog"]')`, 8000);
  await driver.eval(`(() => {
    const nav = [...document.querySelectorAll('[role="dialog"] nav button')];
    const hit = nav.find((b) => (b.innerText || '').trim() === '压缩接力');
    if (hit) hit.click();
  })()`);
  await driver.waitFor(`!!document.querySelector('[data-cr-savebar]')`, 10_000);
  await new Promise((resolve) => setTimeout(resolve, 500));

  // ---- 1) 页面顶部时工具条就固定可见（bug 2 的验收点）----
  const atTop = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const bar = d.querySelector('[data-cr-savebar]');
    const scroller = [...d.querySelectorAll('*')].find((el) => el.scrollHeight > el.clientHeight + 50) || d;
    const b = bar.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    const save = bar.querySelector('[data-cr-save]');
    const dirtyEl = bar.querySelector('[data-cr-dirty]');
    return {
      position: getComputedStyle(bar).position,
      bottom: Math.round(b.bottom),
      scrollerBottom: Math.round(s.bottom),
      scrollerTop: Math.round(s.top),
      visible: b.top >= s.top - 1 && b.bottom <= s.bottom + 1,
      hasSave: !!save,
      hasReset: !!bar.querySelector('[data-cr-reset]'),
      hasDirty: !!dirtyEl,
      saveRight: Math.round(save.getBoundingClientRect().right),
      dirtyLeft: Math.round(dirtyEl.getBoundingClientRect().left),
      barHeight: Math.round(b.height),
      scrollTop: scroller.scrollTop,
    };
  })()`);
  log('顶部时保存工具条:', JSON.stringify(atTop));
  if (atTop.position !== 'sticky') throw new Error(`保存工具条应为 position:sticky，实际 ${atTop.position}`);
  if (!atTop.visible) throw new Error(`页面顶部时工具条不在视口内：${JSON.stringify(atTop)}`);
  if (!atTop.hasSave || !atTop.hasReset || !atTop.hasDirty) throw new Error('工具条缺少保存/恢复默认/未保存指示');
  // 视觉打磨：按钮组与状态文字在同一行（未保存指示在保存按钮右侧，不折行错位），整条不过高。
  if (!(atTop.dirtyLeft > atTop.saveRight)) throw new Error(`保存按钮与状态文字没对齐：${JSON.stringify(atTop)}`);
  if (atTop.barHeight > 96) throw new Error(`保存工具条过高（${atTop.barHeight}px），不够紧凑`);

  // ---- 2) 交接线改 65（上限 62）：真实键盘输入 ----
  const typed65 = await typeHandoff('65');
  log('交接线输入值:', typed65);
  if (typed65 !== '65') throw new Error(`交接线输入框没改到 65，实际 ${typed65}`);
  const dirty = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const el = d.querySelector('[data-cr-dirty]');
    return el ? { flag: el.getAttribute('data-cr-dirty'), text: el.innerText } : null;
  })()`);
  log('未保存指示:', JSON.stringify(dirty));
  if (dirty === null || dirty.flag !== '1') throw new Error('改过交接线后工具条应显示「有未保存的修改」');

  // ---- 3) 点保存（不滚动，工具条就在视口底部）----
  const simulated = actualRatio === null;
  if (simulated) {
    // 隔离环境算不出 actual 线：用「与 guard 同口径」的 400 替身驱动 UI 的失败显示。
    await driver.eval(`(() => {
      const original = window.fetch;
      window.fetch = async (url, options) => {
        if (String(url) === '/api/compact-relay-settings' && options && options.method === 'POST') {
          const body = JSON.parse(options.body || '{}');
          const ratio = body && body.thresholds && typeof body.thresholds.handoffRatio === 'number' ? body.thresholds.handoffRatio : null;
          if (ratio !== null && ratio > 0.62) {
            const pct = Math.round(ratio * 1000) / 10;
            return new Response(JSON.stringify({ ok: false, field: 'thresholds.handoffRatio',
              message: '交接线偏晚：当前模型实际触发 67.8%，交接线 ' + pct + '% 距原生压缩不足 5 个百分点；最高可设 62%。' }),
              { status: 400, headers: { 'content-type': 'application/json' } });
          }
        }
        return original(url, options);
      };
      return true;
    })()`);
  }
  const clickSave = async () => {
    const clicked = await driver.eval(`(() => {
      const d = document.querySelector('[role="dialog"]');
      const b = d.querySelector('[data-cr-savebar] [data-cr-save]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!clicked) throw new Error('点不到粘性条里的保存按钮');
  };
  const readResult = () => driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const bar = d.querySelector('[data-cr-savebar]');
    const status = d.querySelector('[data-cr-save-status]');
    const inline = d.querySelector('[data-cr-handoff-error]');
    const warning = d.querySelector('[data-cr-handoff-late]');
    const input = d.querySelector('input[aria-label="交接提醒线（百分比）"]');
    const b = bar.getBoundingClientRect();
    const scroller = [...d.querySelectorAll('*')].find((el) => el.scrollHeight > el.clientHeight + 50) || d;
    const s = scroller.getBoundingClientRect();
    return {
      status: status ? status.getAttribute('data-cr-save-status') : null,
      statusText: status ? status.innerText : '',
      inlineText: inline ? inline.innerText : '',
      warningText: warning ? warning.innerText : '',
      barVisible: b.top >= s.top - 1 && b.bottom <= s.bottom + 1,
      dirty: (d.querySelector('[data-cr-dirty]') || {}).innerText || '',
      handoffValue: input ? input.value : '',
      handoffMax: input ? input.max : '',
      capChip: (d.querySelector('[data-cr-handoff-cap-chip]') || {}).innerText || '',
    };
  })()`);

  await clickSave();
  await driver.waitFor(`(() => { const d = document.querySelector('[role="dialog"]'); const s = d && d.querySelector('[data-cr-save-status]'); return !!s && s.innerText.length > 0; })()`, 10_000);
  const result = await readResult();
  log('65 保存结果:', JSON.stringify(result));

  if (!simulated) {
    // 真实服务端拒绝：粘性条 + 交接线行内都必须有红色文案。
    if (!(65 > capPercent)) throw new Error(`用例前提不成立：65 应大于上限 ${capPercent}`);
    if (result.status !== 'error') throw new Error(`真实服务端应拒绝 65%（actual=${actualRatio}），实际 status=${result.status}`);
    if (result.inlineText === '') throw new Error('交接线行内没有出现错误提示');
    if (!result.statusText.includes(`最高可设 ${capPercent}%`)) throw new Error(`粘性条错误文案缺目标值：${result.statusText}`);
    if (!result.inlineText.includes(`最高可设 ${capPercent}%`)) throw new Error(`行内错误文案缺目标值：${result.inlineText}`);
    if (!result.inlineText.includes(String(Math.round(actualRatio * 1000) / 10))) {
      throw new Error(`行内错误文案缺实际触发线：${result.inlineText}`);
    }
  } else {
    // 隔离环境算不出 actual 线：至少验证客户端会把 400 的 field/message 渲染到两处。
    if (result.status !== 'error' || result.inlineText === '') {
      throw new Error(`模拟 400 后错误没有同时出现在粘性条与交接线行内：${JSON.stringify(result)}`);
    }
    if (!result.statusText.includes('最高可设 62%') || !result.inlineText.includes('最高可设 62%')) {
      throw new Error(`两处错误都应带目标值 62%：${JSON.stringify(result)}`);
    }
  }
  if (result.handoffValue !== '65') throw new Error(`保存失败后表单不该被清空，实际输入值 ${result.handoffValue}`);
  if (!result.barVisible) throw new Error('保存后工具条不在视口内');

  // ---- 4) 被拒后没有静默落盘 ----
  const remote = await driver.eval(`fetch('/api/compact-relay-settings', { cache: 'no-store' }).then((r) => r.json())`);
  log('被拒后设置:', JSON.stringify(remote.config.thresholds));
  if (remote.config.thresholds.handoffRatio !== 0.6) {
    throw new Error(`保存被拒但设置被改了：handoffRatio=${remote.config.thresholds.handoffRatio}（应仍为 0.6）`);
  }

  /* ==================================================================== *
   * 5) 0.4.2 真机 bug 回归：输入 80 不被改成 99，保存被拒，再改 62 成功
   * ==================================================================== */

  const typed80 = await typeHandoff('80');
  log('[6] 输入 80 → 输入框值:', typed80, '（旧 bug 会变成 99）');
  if (typed80 !== '80') throw new Error(`输入 80 后输入框应仍是 80，实际 ${typed80}`);
  const after80 = await readResult();
  log('输入 80 后:', JSON.stringify({ warning: after80.warningText, capChip: after80.capChip, max: after80.handoffMax, dirty: after80.dirty }));
  if (after80.handoffValue !== '80') throw new Error(`输入框被改写了：${after80.handoffValue}`);
  // input.max 必须跟着当前上限（真机 62%；隔离环境可能按配置阈值兜底成 79%）保持一致。
  const chipCap = (after80.capChip.match(/(\d+)%/) || [])[1];
  const expectedMax = chipCap === undefined ? '100' : chipCap;
  if (after80.handoffMax !== expectedMax) {
    throw new Error(`input 的 max 应与上限徽标一致（${expectedMax}），实际 ${after80.handoffMax}`);
  }

  await clickSave();
  await driver.waitFor(`(() => { const d = document.querySelector('[role="dialog"]'); const s = d && d.querySelector('[data-cr-save-status]'); return !!s && s.getAttribute('data-cr-save-status') === 'error'; })()`, 10_000);
  const rejected80 = await readResult();
  log('80 保存结果:', JSON.stringify({ status: rejected80.status, statusText: rejected80.statusText, inlineText: rejected80.inlineText, value: rejected80.handoffValue }));
  if (rejected80.status !== 'error') throw new Error('80 保存应被拒绝');
  if (rejected80.inlineText === '') throw new Error('80 被拒后交接线行内没有错误提示');
  if (!/最高(可设|只能设到) \d+%/.test(rejected80.statusText)) throw new Error(`条内错误缺目标值：${rejected80.statusText}`);
  if (!/最高(可设|只能设到) \d+%/.test(rejected80.inlineText)) throw new Error(`行内错误缺目标值：${rejected80.inlineText}`);
  if (rejected80.handoffValue !== '80') throw new Error(`被拒后输入框应仍是用户输入的 80，实际 ${rejected80.handoffValue}`);

  const stillThere = await driver.eval(`fetch('/api/compact-relay-settings', { cache: 'no-store' }).then((r) => r.json())`);
  if (stillThere.config.thresholds.handoffRatio !== 0.6) {
    throw new Error(`80 被拒后设置被改了：${stillThere.config.thresholds.handoffRatio}（应仍为 0.6）`);
  }
  await driver.screenshot(shotErrorDark);
  log('截图（错误态·深色）:', shotErrorDark);

  /* ==================================================================== *
   * 5.5) 深色 / 浅色都能看（用现有 DSH token；headless Chrome 默认深色）
   * ==================================================================== */
  const themeProbe = () => driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const bar = d.querySelector('[data-cr-savebar]');
    const status = d.querySelector('[data-cr-save-status]');
    const cs = getComputedStyle(bar);
    const nums = (cs.backgroundColor.match(/[\\d.]+/g) || []).map(Number);
    const lum = nums.length >= 3 ? Math.round(0.299 * nums[0] + 0.587 * nums[1] + 0.114 * nums[2]) : null;
    const sc = status ? getComputedStyle(status).color : '';
    const scNums = (sc.match(/[\\d.]+/g) || []).map(Number);
    return JSON.stringify({
      barBg: cs.backgroundColor,
      barLum: lum,
      barBorderTop: (cs.borderTopWidth || '') + ' ' + (cs.borderTopColor || ''),
      statusColor: sc,
      statusBg: status ? getComputedStyle(status).backgroundColor : '',
      statusRedDominant: scNums.length >= 3 ? scNums[0] > scNums[1] + 60 && scNums[0] > 120 : false,
      dialogDark: document.body.dataset.dsDarkTheme !== undefined,
    });
  })()`);
  const darkProbe = JSON.parse(await themeProbe());
  await driver.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await new Promise((resolve) => setTimeout(resolve, 600));
  const lightProbe = JSON.parse(await themeProbe());
  log('主题探针 深色:', JSON.stringify(darkProbe));
  log('主题探针 浅色:', JSON.stringify(lightProbe));
  if (!(darkProbe.barLum < 90)) throw new Error(`深色下保存条底色不够深：${JSON.stringify(darkProbe)}`);
  if (!(lightProbe.barLum > 190)) throw new Error(`浅色下保存条底色不够浅：${JSON.stringify(lightProbe)}`);
  if (!lightProbe.statusRedDominant) throw new Error(`浅色下错误文字不是红色：${JSON.stringify(lightProbe)}`);
  if (!darkProbe.statusRedDominant) throw new Error(`深色下错误文字不是红色：${JSON.stringify(darkProbe)}`);
  await driver.screenshot(shotErrorLight);
  log('截图（错误态·浅色）:', shotErrorLight);

  // 用户按提示改成上限内（62，或本环境算出的实测上限）→ 真实保存成功。
  const successPercent = capPercent === null ? 62 : Math.min(62, capPercent);
  const typed62 = await typeHandoff(String(successPercent));
  log('[7] 输入', successPercent, '→ 输入框值:', typed62);
  if (typed62 !== String(successPercent)) throw new Error(`输入 ${successPercent} 后输入框应原样保留，实际 ${typed62}`);
  const inlineGone = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    return !d.querySelector('[data-cr-handoff-error]');
  })()`);
  if (!inlineGone) throw new Error('重新输入后旧的保存失败提示应消失');

  await clickSave();
  await driver.waitFor(`(() => { const d = document.querySelector('[role="dialog"]'); const s = d && d.querySelector('[data-cr-save-status]'); return !!s && s.getAttribute('data-cr-save-status') === 'ok'; })()`, 10_000);
  const saved = await readResult();
  log('62 保存结果:', JSON.stringify({ status: saved.status, statusText: saved.statusText, value: saved.handoffValue, dirty: saved.dirty }));
  if (saved.status !== 'ok' || !saved.statusText.includes('已保存')) throw new Error(`62 保存应成功：${JSON.stringify(saved)}`);
  if (saved.handoffValue !== String(successPercent)) throw new Error(`保存成功后输入框应显示 ${successPercent}，实际 ${saved.handoffValue}`);
  if (saved.dirty !== '已是最新') throw new Error(`保存成功后不应再有未保存修改：${saved.dirty}`);

  const persisted = await driver.eval(`fetch('/api/compact-relay-settings', { cache: 'no-store' }).then((r) => r.json())`);
  log('保存后设置:', JSON.stringify(persisted.config.thresholds));
  if (Math.abs(persisted.config.thresholds.handoffRatio - successPercent / 100) > 1e-9) {
    throw new Error(`${successPercent} 没有落盘：${persisted.config.thresholds.handoffRatio}`);
  }
  if (saved.barVisible === false) throw new Error('保存成功后工具条不在视口内');
  await driver.screenshot(shotSuccessLight);
  log('截图（成功态·浅色）:', shotSuccessLight);

  // ---- 6) 滚到页面最底部，工具条仍在视口内 ----
  const atBottom = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const scroller = [...d.querySelectorAll('*')].find((el) => el.scrollHeight > el.clientHeight + 50) || d;
    scroller.scrollTop = scroller.scrollHeight;
    const bar = d.querySelector('[data-cr-savebar]');
    const b = bar.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    return { visible: b.top >= s.top - 1 && b.bottom <= s.bottom + 1, scrollTop: scroller.scrollTop };
  })()`);
  log('滚到底后工具条:', JSON.stringify(atBottom));
  if (!atBottom.visible) throw new Error('滚到页面底部后工具条不可见');

  log('PASS 设置页 UX：粘性保存条常驻视口/未保存指示/交接线输入 80 不被改写成 99/80 被拒时条内+行内双处报错/62 保存成功/被拒不落盘');
  log('截图:', shotErrorDark, '|', shotErrorLight, '|', shotSuccessLight);
  if (simulated) log('注意：隔离环境 state.native.ratio 为空，UI 的 400 拒绝文案用「与 guard 同口径」的 fetch 替身生成；真实服务端 62% 口径由 test/settings-ux.mjs 的 HTTP 用例覆盖（nativeRatio=0.678）。');
} catch (error) {
  console.error('FAIL', error);
  if (driver) {
    try {
      console.error('页面异常:', JSON.stringify(driver.pageErrors.slice(-10)));
    } catch {}
    try {
      console.error('页面文本:', String(await driver.bodyText()).slice(0, 1500));
    } catch {}
  }
  throw error;
} finally {
  try {
    await e2e.stop(host, driver);
  } catch {}
  await e2e.killStrayHosts().catch(() => {});
  e2e.cleanupTemp({ purgeHome: true });
}
