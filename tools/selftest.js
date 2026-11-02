#!/usr/bin/env node
/*
 * 發版保護（畫面端）：用無頭瀏覽器打開 App 的畫面，把每個賽事包用示範模式從起點跑到終點。
 *
 *   races.js 裡每一場 ──▶ index.html#race=<id>&selftest
 *                           │  示範模式照計畫跑完全程（時間快轉）
 *                           ▼
 *        檢查：每 1K 語音、進區段語音、每個地標分段、每個水站提醒、終點自動完賽、畫面沒有 NaN
 *        再用比最窄手機還窄一點的寬度（300 px）跑一次，邊跑邊量：任何一格字超出框 → 失敗
 *                           │
 *                           ▼
 *        把畫面算出的 course JSON 存到 build/selftest/，給 Java 端（TrackerCheck）再跑一次對位
 *
 * 任何一場出錯 → 結束碼 1 → GitHub Actions 不發佈 APK。
 * 用法：node tools/selftest.js   （需要 playwright 與 chromium）
 */
const path = require('path'), fs = require('fs');
const { chromium } = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const page0 = 'file://' + path.join(root, 'app/src/main/assets/index.html');
  const out = path.join(root, 'build/selftest'); fs.mkdirSync(out, { recursive: true });
  const races = (() => { const w = {}; new Function('window', fs.readFileSync(path.join(root, 'app/src/main/assets/races.js'), 'utf8'))(w); return w.RACES; })();
  const opts = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {};
  const browser = await chromium.launch(opts);
  let fails = 0;
  const open = async (hash, width = 390) => {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } });
    const p = await ctx.newPage(); const errs = [];
    p.on('pageerror', e => errs.push(String(e)));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|navigator\.vibrate/.test(m.text())) errs.push(m.text()); });   // 網頁版的圖示、manifest 只在 Pages 上才有
    await p.goto(page0 + '#' + hash);
    return { p, ctx, errs };
  };
  // 首頁：每場賽事都要出現在清單
  {
    const { p, ctx, errs } = await open('home');
    await p.waitForTimeout(300);
    const txt = await p.textContent('#raceList');
    for (const r of races) if (!txt.includes(r.name)) errs.push('首頁清單沒有 ' + r.name);
    if (errs.length) { fails++; console.log('❌ 首頁：' + errs.join('；')); } else console.log('✅ 首頁：' + races.length + ' 場賽事都在清單上');
    await p.screenshot({ path: path.join(out, 'home.png'), fullPage: true });
    await ctx.close();
  }
  // 量「字超出框」：不換行的字比框寬、或整頁出現左右捲動
  const overflow = p => p.evaluate(() => {
    const o = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) {
      // 找出是誰撐寬了頁面：右邊超出螢幕、而且自己的子元素都沒超出的那一層
      const wide = [...document.querySelectorAll('body *')].filter(e => e.offsetParent && e.getBoundingClientRect().right > innerWidth + 1);
      const leaf = wide.filter(e => !wide.some(k => k !== e && e.contains(k)));
      o.push('整頁出現左右捲動：' + leaf.slice(0, 4).map(e => `#${e.id || e.className || e.tagName}「${e.textContent.trim().slice(0, 16)}」右緣 ${Math.round(e.getBoundingClientRect().right)} > 螢幕 ${innerWidth}`).join('；'));
    }
    for (const e of document.querySelectorAll('body *')) {
      if (!e.offsetParent || e.tagName === 'CANVAS' || e.clientWidth === 0) continue;
      const cs = getComputedStyle(e);
      if (cs.overflowX !== 'visible') continue;
      if (e.children.length && cs.whiteSpace !== 'nowrap') continue;
      if (e.scrollWidth > e.clientWidth + 1) o.push(`#${e.id || e.className}「${e.textContent.trim().slice(0, 16)}」寬 ${e.scrollWidth} > 框 ${e.clientWidth}`);
    }
    return o;
  });
  for (const r of races) {
    // 窄螢幕：示範跑全程，每 0.2 秒量一次，最後每個分頁再量一次
    {
      const { p, ctx } = await open('race=' + r.id + '&selftest', 300); const seen = new Set();
      for (let k = 0; k < 600; k++) {
        (await overflow(p)).forEach(x => seen.add(x));
        if (await p.evaluate(() => !!window.__selftest)) break;
        await p.waitForTimeout(200);
      }
      for (const t of ['tRace', 'tPrep', 'tPlan', 'tMap']) { if (await p.isVisible('#' + t)) { await p.click('#' + t); await p.waitForTimeout(200); (await overflow(p)).forEach(x => seen.add(x)); } }
      if (seen.size) { fails++; console.log(`❌ ${r.id} 窄螢幕 300 px 字超出框：\n   - ` + [...seen].slice(0, 12).join('\n   - ')); }
      else console.log(`✅ ${r.id}：300 px 窄螢幕沒有字超出框`);
      await ctx.close();
    }
    const { p, ctx, errs } = await open('race=' + r.id + '&selftest');
    try { await p.waitForFunction(() => window.__selftest, null, { timeout: 120000 }); } catch (e) { errs.push('示範跑不完（逾時）'); }
    const res = await p.evaluate(() => window.__selftest || null);
    if (res) {
      errs.push(...res.errs);
      fs.writeFileSync(path.join(out, 'course-' + r.id + '.json'), JSON.stringify(res.course));
    }
    await p.screenshot({ path: path.join(out, 'finish-' + r.id + '.png'), fullPage: true });
    if (errs.length) { fails++; console.log(`❌ ${r.id}：\n   - ` + errs.join('\n   - ')); }
    else console.log(`✅ ${r.id}：完賽 ${Math.floor(res.finT / 3600)}:${String(Math.floor(res.finT % 3600 / 60)).padStart(2, '0')}:${String(res.finT % 60).padStart(2, '0')}（計畫 ${res.planTotal.toFixed(1)} 分），語音 ${res.said} 句，例如「${res.sample[0]}」`);
    await ctx.close();
    // 賽事準備頁截圖（給人看）
    const v = await open('race=' + r.id);
    await v.p.waitForTimeout(300);
    if (v.errs.length) { fails++; console.log(`❌ ${r.id} 準備頁：` + v.errs.join('；')); }
    await v.p.screenshot({ path: path.join(out, 'prep-' + r.id + '.png'), fullPage: true });
    await v.ctx.close();
  }
  await browser.close();
  if (fails) { console.log(`\n${fails} 項沒過，不發佈。`); process.exit(1); }
  console.log('\n全部賽事包示範跑完，沒有錯誤。');
})().catch(e => { console.error(e); process.exit(1); });
