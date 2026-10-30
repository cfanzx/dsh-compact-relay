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
  // 每个设置项都该有「作用/调整后」两行小字。数量随功能演进（0.5.3 收藏后 14 → 19），
  // 别钉死具体条数：只要求两行成对、且不少于 14（历史上限）。
  if (purposeCount !== effectCount || purposeCount < 14) {
    throw new Error(`每个设置应有两行小字，实际 ${purposeCount}/${effectCount}`);
  }
  for (const wanted of [
    '使用教程（GitHub）',
    '反馈 / 提 bug（GitHub Issues）',
    'npm 包页面',
    '关于与危险操作',
    '版本：',
    '设置文件：',
    '联系方式：cfanzx@136.com',
    '致谢：DeepSeek Harness',
  ]) {
    if (!dialogText.includes(wanted)) throw new Error(`设置页缺少内容：${wanted}`);
  }
  // 0.3.1：仓库已建，links 默认指向 cfanzx/dsh-compact-relay，不应再出现「准备中」占位；外链要真的是 <a href>。
  if (dialogText.includes('准备中')) throw new Error('设置页不应再显示「准备中」占位（links 已有默认值）');
  const helpLinks = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    return [...d.querySelectorAll('a')].map((a) => ({ text: (a.innerText || '').trim(), href: a.getAttribute('href') || '' }));
  })()`);
  const wantedHrefs = [
    ['使用教程（GitHub）', 'github.com/cfanzx/dsh-compact-relay/blob/main/TUTORIAL.md'],
    ['反馈 / 提 bug（GitHub Issues）', 'github.com/cfanzx/dsh-compact-relay/issues'],
    ['npm 包页面', 'npmjs.com/package/dsh-compact-relay'],
  ];
  for (const [label, hrefPart] of wantedHrefs) {
    const hit = helpLinks.find((a) => a.text === label);
    if (!hit) throw new Error(`设置页缺少外链：${label}`);
    if (!hit.href.includes(hrefPart)) throw new Error(`外链地址不对：${label} → ${hit.href}`);
  }

  // ---- 0.4 P0-2：诊断信息真机检查（本机生成 / 预览 / 复制；不真点开 issue 页）----
  log('[5.5] 诊断信息入口');
  const diagEntry = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const block = d.querySelector('[data-cr-diagnostics]');
    const buttonTexts = [...d.querySelectorAll('button')].map((b) => (b.innerText || '').trim());
    return {
      hasBlock: !!block,
      blockText: block ? block.innerText : '',
      hasGenerate: buttonTexts.includes('生成并预览'),
      hasIssue: buttonTexts.includes('打开问题报告页'),
      hasForbiddenButton: buttonTexts.some((text) => /发送|上传|上报/.test(text)),
    };
  })()`);
  const diagEntryBrief = {
    hasBlock: diagEntry.hasBlock,
    hasGenerate: diagEntry.hasGenerate,
    hasIssue: diagEntry.hasIssue,
    hasForbiddenButton: diagEntry.hasForbiddenButton,
  };
  log('诊断信息入口:', JSON.stringify(diagEntryBrief));
  if (!diagEntry.hasBlock || !diagEntry.hasGenerate || !diagEntry.hasIssue) {
    throw new Error('帮助区缺少「诊断信息」入口或两个按钮（生成并预览 / 打开问题报告页）');
  }
  if (diagEntry.hasForbiddenButton) throw new Error('按钮文案出现禁词（发送/上传/上报）');
  if (/(发送|上传|上报)/.test(diagEntry.blockText)) throw new Error('诊断说明区出现禁词（发送/上传/上报）');

  const errorsBeforeDiag = driver.pageErrors.length;
  const diagClicked = await driver.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = [...d.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === '生成并预览');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!diagClicked) throw new Error('点不到「生成并预览」');
  await driver.waitFor(`!!document.querySelector('[data-cr-diagnostics-modal]')`, 15_000);
  const preview = await driver.eval(`(() => {
    const modal = document.querySelector('[data-cr-diagnostics-modal]');
    const dialog = modal ? modal.querySelector('[role="dialog"]') : null;
    const pre = modal ? modal.querySelector('[data-cr-diagnostics-preview]') : null;
    const content = pre ? pre.innerText : '';
    const modalText = modal ? modal.innerText : '';
    return {
      ariaLabel: dialog ? dialog.getAttribute('aria-label') : null,
      content,
      buttons: modal ? [...modal.querySelectorAll('button')].map((b) => (b.innerText || '').trim()) : [],
      hasSchema: content.includes('dcr-diagnostics/v1'),
      hasMasked: /脱敏/.test(modalText),
      hasSessionId: /session-[0-9a-z]{8,}/i.test(content) || content.includes('sessionId'),
      hasAbsPath: content.includes('/Users/') || /(^|[\\s"'(])\\/(home|root|private|var|opt|etc|tmp)\\//m.test(content) || content.includes(${JSON.stringify(e2e.ISOLATED_HOME)}),
    };
  })()`);
  const previewBrief = {
    ariaLabel: preview.ariaLabel,
    buttons: preview.buttons,
    hasSchema: preview.hasSchema,
    hasMasked: preview.hasMasked,
    hasSessionId: preview.hasSessionId,
    hasAbsPath: preview.hasAbsPath,
    contentChars: preview.content.length,
  };
  log('诊断预览:', JSON.stringify(previewBrief));
  if (preview.ariaLabel !== '诊断信息预览（脱敏）') throw new Error(`预览弹层 aria-label 不对：${preview.ariaLabel}`);
  if (!preview.hasSchema) throw new Error('预览内容缺少 dcr-diagnostics/v1');
  if (!preview.hasMasked) throw new Error('预览内容缺少「脱敏」字样');
  if (preview.hasSessionId) throw new Error('预览内容出现 sessionId 值（脱敏失败）');
  if (preview.hasAbsPath) throw new Error('预览内容出现绝对路径（脱敏失败）');
  for (const wantedButton of ['复制 Markdown', '复制 JSON', '关闭']) {
    if (!preview.buttons.includes(wantedButton)) throw new Error(`预览弹层缺少按钮：${wantedButton}`);
  }
  await driver.screenshot('/tmp/relay-e2e/compress-relay-diagnostics-preview.png');

  // headless 剪贴板可能被拒：只要有点击反馈（成功或失败提示）即可，不许无反应/崩溃。
  const copyClicked = await driver.eval(`(() => {
    const modal = document.querySelector('[data-cr-diagnostics-modal]');
    const b = modal && [...modal.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === '复制 Markdown');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!copyClicked) throw new Error('弹层里没有「复制 Markdown」');
  const copyFeedback = await driver.eval(`new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const el = document.querySelector('[data-cr-diagnostics-copy-status],[data-cr-diagnostics-toast]');
      const text = el ? (el.innerText || '').trim() : '';
      if (text) { resolve(text); return; }
      if (Date.now() - started > 6000) { resolve(''); return; }
      setTimeout(tick, 100);
    };
    tick();
  })`);
  log('复制 Markdown 反馈:', JSON.stringify(copyFeedback));
  if (!copyFeedback.startsWith('已复制') && !copyFeedback.startsWith('复制失败')) {
    throw new Error(`复制 Markdown 没有可识别的成功/失败反馈：${copyFeedback || '(无)'}`);
  }
  const newPageErrors = driver.pageErrors.slice(errorsBeforeDiag);
  if (newPageErrors.length > 0) throw new Error(`诊断弹层操作出现未捕获异常：${newPageErrors.join(' | ')}`);

  // 关掉预览弹层，继续原有测试（弹层不残留）。
  await driver.eval(`(() => {
    const modal = document.querySelector('[data-cr-diagnostics-modal]');
    const b = modal && [...modal.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === '关闭');
    if (b) b.click();
    return true;
  })()`);
  await driver.waitFor(`!document.querySelector('[data-cr-diagnostics-modal]')`, 5000);

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
  log('PASS 诊断信息：入口按钮/生成并预览弹层/dcr-diagnostics/v1/脱敏字样/无 sessionId 与路径/复制反馈', JSON.stringify(copyFeedback));
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
