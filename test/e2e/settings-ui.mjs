#!/usr/bin/env node
/**
 * 设置页 UI 真机检查（隔离 home + Chrome CDP）：
 *
 *   复制隔离 home → boot 隔离 DSH → 打开 GUI → 新建 blank 会话
 *   → 设置 → 压缩接力：确认小节/两行小字/GitHub 占位/关于卡片
 *   → 改压缩线 + 高对比预设 → 保存 → 校验配置立即生效
 *   → 颜色模式强制浅色 → 校验指示灯外环用派生色 #4b5563
 *
 * 用法（node >= 22）：
 *   node test/e2e/settings-ui.mjs
 *
 * 只读写 /tmp/relay-e2e 与 Chrome 自己开的 tab；结束自动清理。
 */
import * as e2e from './lib.mjs';

const log = (...a) => console.log(...a);
const shot = '/tmp/relay-e2e/compress-relay-settings.png';
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
  log('[4] newSession');
  const session = await e2e.newSession(driver, {});
  log('    session', session.sessionId, 'agent', session.agentAvailable);
  // 新会话打开到界面需要一拍；等指示灯挂载后再取初始颜色。
  await driver.waitFor(`!!document.querySelector('button[data-cr-level]')`, 10_000).catch(() => {});

  const ringBefore = await driver.eval(`(() => {
    const btn = document.querySelector('button[data-cr-level]');
    const circles = btn ? [...btn.querySelectorAll('svg circle')] : [];
    return { level: btn && btn.getAttribute('data-cr-level'), strokes: circles.map((c) => c.getAttribute('stroke')), fills: circles.map((c) => c.getAttribute('fill')) };
  })()`);
  log('保存前指示灯:', JSON.stringify(ringBefore));

  const trigger = await driver.eval(`(() => {
    const avatar = document.querySelector('[data-avatar-status]');
    const btn = avatar && avatar.closest('button');
    if (btn) { btn.click(); return { ok: true, how: 'avatar', aria: btn.getAttribute('aria-label') }; }
    const cands = [...document.querySelectorAll('button')].filter((b) => /菜单|账户|账号|menu/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.title || '')));
    if (cands.length > 0) { cands[0].click(); return { ok: true, how: 'label', aria: cands[0].getAttribute('aria-label') }; }
    return { ok: false, buttons: [...document.querySelectorAll('button')].slice(-30).map((b) => ({ text: (b.innerText || '').trim().slice(0, 20), aria: b.getAttribute('aria-label'), title: b.title })) };
  })()`);
  log('打开账户菜单:', JSON.stringify(trigger));
  if (!trigger.ok) throw new Error('找不到账户菜单入口');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const menuItems = await driver.eval(`[...document.querySelectorAll('[role="menuitem"]')].map((b) => (b.innerText || '').trim())`);
  log('账户菜单:', JSON.stringify(menuItems));
  const opened = await driver.eval(`(() => {
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    const hit = items.find((el) => /^(设置|Settings)$/.test((el.innerText || '').trim())) || items.find((el) => /设置/.test(el.innerText || ''));
    if (!hit) return { ok: false };
    hit.click();
    return { ok: true, text: (hit.innerText || '').trim() };
  })()`);
  log('点击设置:', JSON.stringify(opened));
  if (!opened.ok) throw new Error('账户菜单里没有设置');
  await driver.waitFor(`!!document.querySelector('[role="dialog"]')`, 8000);
  log('[5] 打开设置，等待侧栏');
  await driver.waitFor(`document.querySelector('[role="dialog"]') && document.querySelector('[role="dialog"]').innerText.includes('压缩接力')`, 8000).catch(() => {});
  const navTexts = await driver.eval(`[...document.querySelectorAll('[role="dialog"] nav button')].map((b) => b.innerText.trim())`);
  log('设置侧栏:', JSON.stringify(navTexts));

  const clicked = await driver.eval(`(() => {
    const buttons = [...document.querySelectorAll('[role="dialog"] nav button')];
    const hit = buttons.find((b) => (b.innerText || '').trim() === '压缩接力');
    if (!hit) return false;
    hit.click();
    return true;
  })()`);
  log('点击压缩接力:', clicked);
  if (!clicked) throw new Error('设置侧栏里没有找到「压缩接力」');
  await driver.waitFor(`document.querySelector('[role="dialog"]') && document.querySelector('[role="dialog"]').innerText.includes('作用：')`, 8000);
  const dialogText = await driver.eval(`document.querySelector('[role="dialog"]').innerText`);
  log('--- 设置页文本（前 1200 字）---');
  log(dialogText.slice(0, 1200));
  const purposeCount = (dialogText.match(/作用：/g) || []).length;
  const effectCount = (dialogText.match(/调整后：/g) || []).length;
  log('作用:/调整后: 行数 =', purposeCount, '/', effectCount);
  // UI-002 后设置项：压缩提示 3 + 压缩行为 3 + 原生开关 1 + 颜色与外观 7（模式/自动适配/5 色）= 14。
  if (purposeCount !== 14 || effectCount !== 14) throw new Error(`每个设置应有两行小字，实际 ${purposeCount}/${effectCount}`);
  for (const wanted of ['使用教程（GitHub）', '反馈 / 提 bug（GitHub Issues）', '关于与危险操作', '版本：', '设置文件：', '致谢：DeepSeek Harness']) {
    if (!dialogText.includes(wanted)) throw new Error(`设置页缺少内容：${wanted}`);
  }
  // 0.3.1：仓库已建，links 默认指向 cfanzx/dsh-compact-relay，不应再出现「准备中」占位。
  if (dialogText.includes('准备中')) throw new Error('设置页不应再显示「准备中」占位（links 已有默认值）');

  const counts = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    return {
      numbers: d.querySelectorAll('input[type="number"]').length,
      colors: d.querySelectorAll('input[type="color"]').length,
      selects: d.querySelectorAll('select').length,
      checks: d.querySelectorAll('input[type="checkbox"]').length,
      texts: d.querySelectorAll('input[type="text"]').length,
      buttons: [...d.querySelectorAll('button')].map((b) => (b.innerText || '').trim()).filter(Boolean)
    };
  })()`);
  log('控件数量:', JSON.stringify(counts));

  // 改第一个数字（压缩线）为 25%
  const setRatio = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const input = d.querySelector('input[aria-label="压缩提醒线（百分比）"]');
    if (!input) return 'missing';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '25');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  log('压缩线输入框值:', setRatio);
  // 点高对比预设
  const preset = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = [...d.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === '高对比');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  log('点高对比预设:', preset);
  const saved = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = [...d.querySelectorAll('button')].find((x) => (x.innerText || '').trim().startsWith('保存'));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  log('点保存:', saved);
  await driver.waitFor(`document.querySelector('[role="dialog"]') && document.querySelector('[role="dialog"]').innerText.includes('已保存')`, 8000);
  const remote = await driver.eval(`fetch('/api/compact-relay-settings', { cache: 'no-store' }).then((r) => r.json())`);
  log('保存后设置:', JSON.stringify(remote.config));
  if (Math.abs(remote.config.thresholds.compactRatio - 0.25) > 1e-9) throw new Error('压缩线未保存为 25%');
  if (remote.config.colors.base.idle !== '#4B5563') throw new Error('预设颜色未保存');

  // 滚到颜色区，验证 aria 标签并截图
  const ariaLabels = await driver.eval(`(() => { const d = document.querySelector('[role="dialog"]'); return [...d.querySelectorAll('input,select')].map((x) => x.getAttribute('aria-label')).filter(Boolean); })()`);
  log('控件 aria-label:', JSON.stringify(ariaLabels));
  const scrolled = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const target = [...d.querySelectorAll('*')].find((el) => el.scrollHeight > el.clientHeight + 50);
    if (!target) return false;
    target.scrollTop = target.scrollHeight;
    return { h: target.scrollHeight, c: target.clientHeight };
  })()`);
  log('滚动到颜色区:', JSON.stringify(scrolled));
  await new Promise((resolve) => setTimeout(resolve, 400));
  await driver.screenshot('/tmp/relay-e2e/compress-relay-settings-colors.png');

  // 颜色模式强制「浅色」，保存后外环应使用浅色派生色（#4b5563）
  const modeSet = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const select = d.querySelector('select[aria-label="颜色模式"]');
    if (!select) return 'missing';
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'light');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value;
  })()`);
  log('颜色模式改为:', modeSet);
  await driver.eval(`(() => { const d = document.querySelector('[role="dialog"]'); const b = [...d.querySelectorAll('button')].find((x) => (x.innerText || '').trim().startsWith('保存')); if (b) b.click(); })()`);
  await driver.waitFor(`document.querySelector('[role="dialog"]') && document.querySelector('[role="dialog"]').innerText.includes('已保存')`, 8000);

  // 关掉设置，检查指示灯外环实际颜色（强制浅色 + 高对比预设 → #4b5563）
  await driver.eval(`(() => { const d = document.querySelector('[role="dialog"]'); const b = d && d.querySelector('button[aria-label="关闭"]'); if (b) b.click(); })()`);
  await driver.waitFor(`!document.querySelector('[role="dialog"]')`, 5000).catch(() => {});
  await driver.waitFor(`!!document.querySelector('button[data-cr-level]')`, 10_000).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 600));
  const ringAfter = await driver.eval(`(() => {
    const btn = document.querySelector('button[data-cr-level]');
    const circles = btn ? [...btn.querySelectorAll('svg circle')] : [];
    return { level: btn && btn.getAttribute('data-cr-level'), strokes: circles.map((c) => c.getAttribute('stroke')), fills: circles.map((c) => c.getAttribute('fill')) };
  })()`);
  log('保存后指示灯:', JSON.stringify(ringAfter));
  // 0.3.1 起指示灯颜色画在中心点 fill / 分段 path 上（不再是外环 stroke），两种都算「可见颜色」。
  const paintOf = (ring) => [...(ring.strokes || []), ...(ring.fills || [])];
  if (JSON.stringify(paintOf(ringBefore)) === JSON.stringify(paintOf(ringAfter))) throw new Error('保存颜色后指示灯颜色没变（热更新/派生可能没生效）');
  const ringPaint = paintOf(ringAfter).find((v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v));
  if ((ringPaint || '').toLowerCase() !== '#4b5563') throw new Error(`强制浅色模式下指示灯应为 #4b5563，实际 ${ringPaint}`);

  // 重新打开设置，滚到颜色区截图，验证 aria 标签与恢复默认
  const reopen = await driver.eval(`(() => {
    const avatar = document.querySelector('[data-avatar-status]');
    const btn = avatar && avatar.closest('button');
    if (btn) { btn.click(); return true; }
    return false;
  })()`);
  if (reopen) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await driver.eval(`(() => { const items = [...document.querySelectorAll('[role="menuitem"]')]; const hit = items.find((el) => /设置/.test(el.innerText || '')); if (hit) hit.click(); })()`);
    await driver.waitFor(`!!document.querySelector('[role="dialog"]')`, 8000);
    await driver.eval(`(() => { const nav = [...document.querySelectorAll('[role="dialog"] nav button')]; const hit = nav.find((b) => (b.innerText || '').trim() === '压缩接力'); if (hit) hit.click(); })()`);
    await driver.waitFor(`document.querySelector('[role="dialog"]') && document.querySelector('[role="dialog"]').innerText.includes('颜色模式')`, 8000);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const ariaLabels = await driver.eval(`(() => { const d = document.querySelector('[role="dialog"]'); return [...d.querySelectorAll('input,select')].map((x) => x.getAttribute('aria-label')).filter(Boolean); })()`);
    log('控件 aria-label:', JSON.stringify(ariaLabels));
    const scrolled = await driver.eval(`(() => { const d = document.querySelector('[role="dialog"]'); const scroll = d.querySelector('[class*="content"],[class*="body"]') || d; const target = [...d.querySelectorAll('*')].find((el) => el.scrollHeight > el.clientHeight + 50); if (!target) return false; target.scrollTop = target.scrollHeight; return { h: target.scrollHeight, c: target.clientHeight }; })()`);
    log('滚动到颜色区:', JSON.stringify(scrolled));
    await new Promise((resolve) => setTimeout(resolve, 400));
    await driver.screenshot('/tmp/relay-e2e/compress-relay-settings-colors.png');
    // A4：恢复默认改成二次确认（第一次点「恢复默认」只展开确认条）。
    const reset = await driver.eval(`(() => { const d = document.querySelector('[role="dialog"]'); const b = [...d.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === '恢复默认'); if (!b) return false; b.click(); return true; })()`);
    await driver.waitFor(`document.querySelector('[role="dialog"]') && document.querySelector('[role="dialog"]').innerText.includes('确定恢复默认')`, 8000);
    const resetConfirm = await driver.eval(`(() => { const d = document.querySelector('[role="dialog"]'); const b = [...d.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === '确定恢复'); if (!b) return false; b.click(); return true; })()`);
    await driver.waitFor(`document.querySelector('[role="dialog"]') && document.querySelector('[role="dialog"]').innerText.includes('已恢复默认')`, 8000);
    const afterReset = await driver.eval(`fetch('/api/compact-relay-settings', { cache: 'no-store' }).then((r) => r.json())`);
    log('恢复默认后:', JSON.stringify(afterReset.config));
    if (afterReset.config.thresholds.compactRatio !== 0.4) throw new Error('恢复默认未生效');
  }
  await driver.screenshot(shot);
  log('截图:', shot);
  log('PASS 设置栏 UI：压缩接力小节 / 作用+调整后小字 / 保存热生效 / 预设颜色');
} catch (error) {
  console.error('FAIL', error);
  if (driver) {
    try { console.error('页面异常:', JSON.stringify(driver.pageErrors.slice(-10))); } catch {}
    try { console.error('页面文本:', String(await driver.bodyText()).slice(0, 1200)); } catch {}
  }
  throw error;
} finally {
  try { await e2e.stop(host, driver); } catch {}
  await e2e.killStrayHosts().catch(() => {});
  e2e.cleanupTemp({ purgeHome: true });
}
