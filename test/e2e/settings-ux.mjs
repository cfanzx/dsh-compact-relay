#!/usr/bin/env node
/**
 * 0.4.2 设置页 UX 真浏览器点验（隔离 home + Chrome CDP，不碰真 ~/.dsh）：
 *
 *   1. 打开设置 → 压缩接力；
 *   2. 断言保存工具条在页面顶部时就已经固定在视口底部（position:sticky，不用滚到页尾）；
 *   3. 把交接线改成 65（上限 62）→ 点工具条里的保存：
 *      - 真实服务端（隔离环境能算出 actual 线时）应拒绝，粘性条 + 交接线行内都出现红色文案；
 *      - 算不出 actual 线时（隔离环境没模型路由），用页面内 fetch 替身返回同口径 400，
 *        只验证「客户端把失败显示在哪」；服务端真实拒绝由 test/settings-ux.mjs 的 HTTP 用例覆盖；
 *   4. 断言被拒后设置接口仍是 60%（没静默落盘）；
 *   5. 滚到页面最底部，断言工具条仍在视口内（随时能点）。
 *
 * 用法（node >= 22）：
 *   node test/e2e/settings-ux.mjs
 */
import * as e2e from './lib.mjs';

const log = (...a) => console.log(...a);
const shot = '/tmp/relay-e2e/compress-relay-settings-savebar.png';
let host = null;
let driver = null;

try {
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
    return {
      position: getComputedStyle(bar).position,
      bottom: Math.round(b.bottom),
      scrollerBottom: Math.round(s.bottom),
      scrollerTop: Math.round(s.top),
      visible: b.top >= s.top - 1 && b.bottom <= s.bottom + 1,
      hasSave: !!bar.querySelector('[data-cr-save]'),
      hasReset: !!bar.querySelector('[data-cr-reset]'),
      hasDirty: !!bar.querySelector('[data-cr-dirty]'),
      scrollTop: scroller.scrollTop,
    };
  })()`);
  log('顶部时保存工具条:', JSON.stringify(atTop));
  if (atTop.position !== 'sticky') throw new Error(`保存工具条应为 position:sticky，实际 ${atTop.position}`);
  if (!atTop.visible) throw new Error(`页面顶部时工具条不在视口内：${JSON.stringify(atTop)}`);
  if (!atTop.hasSave || !atTop.hasReset || !atTop.hasDirty) throw new Error('工具条缺少保存/恢复默认/未保存指示');

  // ---- 2) 交接线改 65（React 受控输入要原生 setter + input 事件）----
  const typed = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const input = d.querySelector('input[aria-label="交接提醒线（百分比）"]');
    if (!input) return 'missing';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '65');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  log('交接线输入值:', typed);
  if (typed !== '65') throw new Error('交接线输入框没改到 65');
  await new Promise((resolve) => setTimeout(resolve, 300));
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
    await driver.eval(`(() => {
      const original = window.fetch;
      window.fetch = async (url, options) => {
        if (String(url) === '/api/compact-relay-settings' && options && options.method === 'POST') {
          return new Response(JSON.stringify({ ok: false, field: 'thresholds.handoffRatio',
            message: '当前模型实际触发 67.8%，交接线 65% 会在原生压缩之后（交接线应比实际触发线至少早 5 个百分点）；最高可设 62%。' }),
            { status: 400, headers: { 'content-type': 'application/json' } });
        }
        return original(url, options);
      };
      return true;
    })()`);
  }
  const clicked = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = d.querySelector('[data-cr-savebar] [data-cr-save]');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!clicked) throw new Error('点不到粘性条里的保存按钮');

  await driver.waitFor(`(() => { const d = document.querySelector('[role="dialog"]'); const s = d && d.querySelector('[data-cr-save-status]'); return !!s && s.innerText.length > 0; })()`, 10_000);
  const result = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const bar = d.querySelector('[data-cr-savebar]');
    const status = d.querySelector('[data-cr-save-status]');
    const inline = d.querySelector('[data-cr-handoff-error]');
    const warning = d.querySelector('[data-cr-handoff-late]');
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
      handoffValue: (d.querySelector('input[aria-label="交接提醒线（百分比）"]') || {}).value || '',
    };
  })()`);
  log('保存结果:', JSON.stringify(result));

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
  }
  if (result.handoffValue !== '65') throw new Error(`保存失败后表单不该被清空，实际输入值 ${result.handoffValue}`);
  if (!result.barVisible) throw new Error('保存后工具条不在视口内');

  // ---- 4) 被拒后没有静默落盘 ----
  const remote = await driver.eval(`fetch('/api/compact-relay-settings', { cache: 'no-store' }).then((r) => r.json())`);
  log('被拒后设置:', JSON.stringify(remote.config.thresholds));
  if (remote.config.thresholds.handoffRatio !== 0.6) {
    throw new Error(`保存被拒但设置被改了：handoffRatio=${remote.config.thresholds.handoffRatio}（应仍为 0.6）`);
  }

  await driver.screenshot(shot);

  // ---- 5) 滚到页面最底部，工具条仍在视口内 ----
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

  log('PASS 设置页 UX：粘性保存条常驻视口/未保存指示/保存失败在条内与交接线行内可见/被拒不落盘');
  log('截图:', shot);
  if (simulated) log('注意：隔离环境 state.native.ratio 为空，UI 拒绝路径用 fetch 替身模拟；真实服务端拒绝见 test/settings-ux.mjs。');
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
