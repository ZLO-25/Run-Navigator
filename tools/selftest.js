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
  // 首頁：日常訓練置頂、每場賽事都要出現在清單（含坡度縮圖與三格規格），且 300 px 不超框
  {
    const { p, ctx, errs } = await open('home&selftest', 300);
    await p.waitForTimeout(250);
    (await overflow(p)).forEach(x => errs.push(x));
    const txt = await p.textContent('#raceList');
    for (const r of races) if (!txt.includes(r.name)) errs.push('首頁清單沒有 ' + r.name);
    if (!(await p.isVisible('#bGoMetro'))) errs.push('首頁沒有跑步節拍器入口');
    if (!(await p.isVisible('#bHomeMetroPlay'))) errs.push('首頁沒有直接打拍按鈕');
    const sameRow = await p.evaluate(() => {
      const a = document.getElementById('bHomeMetroPlay').getBoundingClientRect();
      const b = document.querySelector('#homeMetroChips button:last-child').getBoundingClientRect();
      return Math.abs(a.top - b.top) < 12;
    });
    if (!sameRow) errs.push('直接打拍與 170–190 捷徑應在同一行');
    const iconCount = await p.locator('#raceList .ricon svg').count();
    if (iconCount !== races.length) errs.push('首頁賽事特色圖示數量不符：' + iconCount);
    if ((await p.locator('#homeMetroIcon svg').count()) !== 1) errs.push('首頁節拍器沒有特色圖示');
    await p.click('[data-more="sunmoonlake-29k-2026"]');
    await p.waitForTimeout(100);
    if ((await p.getAttribute('[data-more="sunmoonlake-29k-2026"]', 'aria-expanded')) !== 'true') errs.push('首頁 more 展開失敗');
    (await overflow(p)).forEach(x => errs.push(x));
    await p.click('[data-pick="sunmoonlake-29k-2026"][data-cid="42k"]');
    await p.waitForTimeout(100);
    if (!(await p.textContent('#raceList')).includes('42.2K 全馬')) errs.push('日月潭切換 42.2K 全馬失敗');
    await p.click('[data-more="sunmoonlake-29k-2026"]');
    await p.waitForTimeout(100);
    if ((await p.getAttribute('[data-more="sunmoonlake-29k-2026"]', 'aria-expanded')) !== 'false') errs.push('首頁 more 收合失敗');
    (await overflow(p)).forEach(x => errs.push(x));
    const metroOnTop = await p.evaluate(() => {
      const m = document.getElementById('bGoMetro'), l = document.getElementById('raceList');
      return m && l && m.getBoundingClientRect().top < l.getBoundingClientRect().top;
    });
    if (!metroOnTop) errs.push('日常訓練應置於賽事清單上方');
    await ctx.close();
    const h = await open('home&selftest', 390);
    await h.p.waitForTimeout(250);
    await h.p.screenshot({ path: path.join(out, 'home.png'), fullPage: true });
    await h.ctx.close();
    if (errs.length) { fails++; console.log('❌ 首頁：' + errs.join('；')); } else console.log('✅ 首頁：日常訓練置頂＋' + races.length + ' 場高鑑別度賽事卡片檢查通過');
  }
  // 練習模式：跑步節拍器（功能＋300 px 窄螢幕）
  {
    const { p, ctx, errs } = await open('metro&selftest', 300);
    await p.waitForTimeout(200);
    (await overflow(p)).forEach(x => errs.push(x));
    await p.click('[data-mstep="5"]');
    if ((await p.textContent('#mBpmBig')) !== '185') errs.push('節拍器 +5 後應為 185 BPM');
    await p.click('#bMetroGo');
    await p.waitForTimeout(450);
    const steps = parseInt(await p.textContent('#mSteps'), 10);
    if (!(steps >= 1)) errs.push('節拍器啟動後步數沒有增加');
    (await overflow(p)).forEach(x => errs.push(x));
    await p.click('#bMetroGo');
    await p.click('#bMetroReset');
    if ((await p.textContent('#mSteps')) !== '0 步') errs.push('節拍器歸零後應為 0 步');
    if (errs.length) { fails++; console.log('❌ 跑步節拍器：' + errs.join('；')); } else console.log('✅ 跑步節拍器：功能與 300 px 窄螢幕檢查通過');
    await p.screenshot({ path: path.join(out, 'metro.png'), fullPage: true });
    await ctx.close();
  }
  // 訓練紀錄：匯入 Garmin（英文、中文）與 Strava 的 CSV → 筆數、去重複、分類、月曆、28 天趨勢，且 300 px 不超框
  {
    const fx = n => path.join(root, 'tools/fixtures', n);
    for (const width of [300, 390]) {
      const { p, ctx, errs } = await open('log&selftest', width);
      await p.waitForTimeout(150);
      (await overflow(p)).forEach(x => errs.push('空白狀態 ' + x));
      await p.setInputFiles('#logFile', [fx('garmin-activities.csv'), fx('garmin-activities-zh.csv'), fx('strava-activities.csv')]);
      await p.waitForTimeout(300);
      const msg = await p.textContent('#logMsg');
      if (!msg.includes('新增 68 筆')) errs.push('第一次匯入應新增 68 筆（Garmin 62＋中文 3＋Strava 3）：' + msg);
      if (!msg.includes('Strava') || !msg.includes('Garmin')) errs.push('沒有辨識出 Garmin／Strava 格式：' + msg);
      await p.setInputFiles('#logFile', [fx('strava-activities.csv')]);
      await p.waitForTimeout(200);
      if (!(await p.textContent('#logMsg')).includes('新增 0 筆')) errs.push('同一份 CSV 再匯一次應該不重複新增');
      const kinds = await p.evaluate(() => {
        const L = TL.load(), by = t => L.find(a => a.title === t) || {};
        return { race: by('高雄富邦半馬 比賽').kind, tempo: by('節奏跑 3x2K').kind, iv: by('Intervals 6x800').kind, tm: by('跑步機 輕鬆跑').tm,
          ride: by('Morning Ride').sport, hike: by('合歡北峰').sport, gain: by('大坑 5 號步道').gain, cad: by('Evening Run').cad, nan: JSON.stringify(L).includes('NaN') };
      });
      if (kinds.race !== 'race') errs.push('標題有「比賽」應判為比賽');
      if (kinds.tempo !== 'quality' || kinds.iv !== 'quality') errs.push('節奏跑、Intervals 應判為品質課');
      if (kinds.tm !== 1) errs.push('跑步機沒被標出');
      if (kinds.ride !== 'ride' || kinds.hike !== 'hike') errs.push('單車／健行沒分出來');
      if (kinds.gain !== 1050) errs.push('中文 Garmin「總爬升 1,050」應讀成 1050');
      if (kinds.cad !== 176) errs.push('Strava 單腳步頻 88 應換算成 176');
      if (kinds.nan) errs.push('紀錄裡有 NaN');
      if ((await p.locator('#calBody .tl-chip').count()) < 5) errs.push('月曆沒有畫出跑量色塊');
      if (!(await p.isVisible('#logTrend'))) errs.push('沒有近 28 天趨勢表');
      if ((await p.locator('#logList .tl-row').count()) !== 15) errs.push('紀錄列表第一頁應顯示 15 筆');
      await p.click('[data-lf="race"]');
      if ((await p.locator('#logList .tl-row').count()) !== 1) errs.push('比賽篩選應只剩 1 筆');
      await p.click('[data-lf="all"]');
      await p.click('#bCalPrev'); await p.click('#bCalPrev');
      (await overflow(p)).forEach(x => errs.push(x));
      await p.click('#bCalNext'); await p.click('#bCalNext');
      const bad = await p.evaluate(() => /NaN|undefined/.test(document.getElementById('pgLog').innerText));
      if (bad) errs.push('紀錄頁出現 NaN／undefined');
      (await overflow(p)).forEach(x => errs.push(x));
      if (width === 390) await p.screenshot({ path: path.join(out, 'log.png'), fullPage: true });
      if (errs.length) { fails++; console.log(`❌ 訓練紀錄（${width} px）：` + errs.join('；')); } else console.log(`✅ 訓練紀錄（${width} px）：Garmin／Strava 匯入、去重複、分類、月曆、趨勢通過`);
      await ctx.close();
    }
    const { p, ctx, errs } = await open('home&selftest', 300);
    await p.waitForTimeout(150);
    if (!(await p.isVisible('#homeTL'))) errs.push('首頁沒有訓練總覽卡');
    if (!(await p.isVisible('#bHomeLog'))) errs.push('沒有紀錄時首頁應出現「匯入紀錄」按鈕');
    if (errs.length) { fails++; console.log('❌ 首頁訓練總覽：' + errs.join('；')); } else console.log('✅ 首頁訓練總覽：空白狀態引導匯入');
    await ctx.close();
  }
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
