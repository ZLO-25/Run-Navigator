#!/usr/bin/env node
/*
 * 發版保護（畫面端）：用無頭瀏覽器打開 App 的畫面，把每個賽事包用示範模式從起點跑到終點。
 *
 *   races.js 裡每一場 ──▶ index.html#race=<id>&selftest
 *                           │  示範模式照計畫跑完全程（時間快轉）
 *                           ▼
 *        檢查：每 1K 語音、進區段語音、每個地標分段、每個水站提醒、終點自動完賽、畫面沒有 NaN
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
  const open = async hash => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
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
  for (const r of races) {
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
