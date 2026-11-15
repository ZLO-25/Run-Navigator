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
    const catSyncErrs = await p.evaluate(() => {
      const out = [];
      for (const r of window.RACES) {
        const c = getRaceCats(r)[0];
        const g = Date.parse(r.time.gun), off = tzOffMs(r), d = new Date(g + off);
        const gun = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
        if (c.limit_min !== r.time.limit_min) out.push(r.id + ' 時限不一致');
        if (c.def_target !== r.params.target.default) out.push(r.id + ' 預設目標不一致');
        if (c.gun_txt && c.gun_txt !== gun) out.push(r.id + ' 鳴槍不一致 ' + c.gun_txt + '!=' + gun);
      }
      return out;
    });
    errs.push(...catSyncErrs);
    if (!txt.includes('06:35')) errs.push('首頁日月潭應顯示 06:35 鳴槍');
    await ctx.close();
    // 報名組別持久性：選組別 → 重新載入 → 仍是剛選的組別（獨立無痕 context，不寫回主環境）
    {
      const rCtx = await open('home', 390);
      await rCtx.p.waitForTimeout(200);
      await rCtx.p.click('[data-more="kyoto-2027"]');
      await rCtx.p.click('[data-pick="kyoto-2027"][data-cid="pair1"]');
      await rCtx.p.reload();
      await rCtx.p.waitForTimeout(200);
      const homeCardTxt = await rCtx.p.textContent('[data-go="kyoto-2027"]');
      if (!homeCardTxt.includes('接力1棒 27.6K')) errs.push('首頁重載後報名組別跳回預設');
      await rCtx.p.click('[data-go="kyoto-2027"]');
      await rCtx.p.waitForLoadState('load');
      await rCtx.p.waitForTimeout(200);
      if ((await rCtx.p.inputValue('#regCat')) !== 'pair1') errs.push('進入準備頁時報名組別未帶入 pair1');
      await rCtx.p.selectOption('#regCat', 'pair2');
      await rCtx.p.reload();
      await rCtx.p.waitForTimeout(200);
      if ((await rCtx.p.inputValue('#regCat')) !== 'pair2') errs.push('準備頁重載後報名組別未保留 pair2');
      await rCtx.ctx.close();
    }
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
  // ① 備賽週期計畫：純計算＋性質檢查＋畫面（300 px 與 390 px）
  {
    const prepErrs = [];
    require(path.join(root, 'app/src/main/assets/prep.js'));
    const ex = globalThis.PREP.cycle({ n: 14, d: 42.195, target: 330, wk0: 25, long0: 16, s: '2026-11-16' });
    const expW = [25, 27, 29, 24, 32, 35, 38, 30, 41, 44, 48, 36, 26, 17];
    const expL = [16, 17, 18, 13, 19, 20, 21, 15, 22, 23, 24, 16, 11, '比賽'];
    if (ex.Lmax !== 24 || ex.wkPeak !== 48) prepErrs.push(`範例 Lmax=${ex.Lmax} wkPeak=${ex.wkPeak}`);
    ex.weeks.forEach((w, i) => {
      if (w.wk !== expW[i] || w.long !== expL[i]) prepErrs.push(`第${i + 1}週 ${w.wk}/${w.long} != ${expW[i]}/${expL[i]}`);
    });
    const moExp = { '2026-11': 56, '2026-12': 138, '2027-01': 179, '2027-02': 79 };
    for (const [k, v] of Object.entries(moExp)) if (ex.months[k] !== v) prepErrs.push(`${k} 月目標 ${ex.months[k]} != ${v}`);
    for (const N of [1, 2, 3, 6, 8, 12, 14, 20, 24]) {
      for (const D of [42.195, 21.0975, 28.8]) {
        const c = globalThis.PREP.cycle({ n: N, d: D, target: D >= 40 ? 330 : D >= 25 ? 255 : 195, wk0: 25, long0: 12 });
        const pSum = c.phases.base + c.phases.build + c.phases.peak + c.phases.taper;
        if (pSum !== N) prepErrs.push(`N=${N} D=${D} 階段總和 ${pSum}`);
        let prevNonRec = null;
        c.weeks.forEach((w, idx) => {
          if (Number.isNaN(w.wk) || (typeof w.long === 'number' && Number.isNaN(w.long))) prepErrs.push(`N=${N} D=${D} 第${idx + 1}週 NaN`);
          if (typeof w.long === 'number' && w.long > c.Lmax) prepErrs.push(`N=${N} D=${D} 長跑 ${w.long} > Lmax ${c.Lmax}`);
          if (idx < N - c.phases.taper && !w.rec) {
            if (prevNonRec != null && w.wk > prevNonRec * 1.10 + 1) prepErrs.push(`N=${N} D=${D} 週量跳太多 ${prevNonRec}->${w.wk}`);
            prevNonRec = w.wk;
          }
        });
        if (c.weeks[N - 1].long !== '比賽') prepErrs.push(`N=${N} D=${D} 最後一週長跑應為比賽`);
      }
    }
    // 畫面驗收：2026-11-16（300 與 390 + 展開 14 週表）、2027-01-27、2027-02-18、2027-02-22、2027-02-10
    for (const w of [300, 390]) {
      const { p, ctx, errs } = await open('race=kyoto-2027&selftest&today=2026-11-16&cycle=25,16', w);
      await p.waitForFunction(() => window.__selftest, null, { timeout: 120000 });
      await p.click('#tPrep'); await p.waitForTimeout(150);
      const t = await p.textContent('#prepCycleTop');
      for (const s of ['倒數第 14 週', '基礎期', '25 km', '16 km']) if (!t.includes(s)) prepErrs.push(`11/16(${w}) 缺「${s}」`);
      (await overflow(p)).forEach(x => prepErrs.push(`11/16(${w}) ${x}`));
      await p.click('#bCycTbl'); await p.waitForTimeout(100);
      (await overflow(p)).forEach(x => prepErrs.push(`11/16展開(${w}) ${x}`));
      if (w === 390 && !(await p.textContent('#prepCycleTop')).includes('11/16')) prepErrs.push('課表展開缺少 11/16');
      errs.forEach(x => prepErrs.push(x));
      await ctx.close();
    }
    {
      const { p, ctx } = await open('race=kyoto-2027&selftest&today=2027-01-27&cycle=25,16,2026-11-16,14', 390);
      await p.waitForFunction(() => window.__selftest, null, { timeout: 120000 });
      await p.click('#tPrep'); await p.waitForTimeout(100);
      const t = await p.textContent('#prepCycleTop');
      for (const s of ['倒數第 4 週', '巔峰期', '48 km', '24 km']) if (!t.includes(s)) prepErrs.push(`01/27 缺「${s}」`);
      await ctx.close();
    }
    {
      const { p, ctx } = await open('race=kyoto-2027&selftest&today=2027-02-18&cycle=25,16,2026-11-16,14', 300);
      await p.waitForFunction(() => window.__selftest, null, { timeout: 120000 });
      await p.click('#tPrep'); await p.waitForTimeout(100);
      const lowTxt = await p.textContent('#prepCycleLow');
      if ((await p.textContent('#prepCycleTop')).trim() !== '') prepErrs.push('02/18 備賽卡應移到下方');
      if (!lowTxt.includes('減量期') || !lowTxt.includes('倒數第 1 週') || !lowTxt.includes('17 km')) prepErrs.push('02/18 收合列文字不符：' + lowTxt);
      (await overflow(p)).forEach(x => prepErrs.push(`02/18(300) ${x}`));
      await ctx.close();
    }
    {
      const { p, ctx } = await open('race=kyoto-2027&selftest&today=2027-02-22&cycle=25,16,2026-11-16,14', 390);
      await p.waitForFunction(() => window.__selftest, null, { timeout: 120000 });
      await p.click('#tPrep'); await p.waitForTimeout(100);
      if ((await p.textContent('#prepCycleTop')).trim() !== '' || (await p.textContent('#prepCycleLow')).trim() !== '') prepErrs.push('賽後不應顯示備賽卡');
      await ctx.close();
    }
    {
      const { p, ctx } = await open('race=kyoto-2027&selftest&today=2027-02-10', 300);
      await p.waitForFunction(() => window.__selftest, null, { timeout: 120000 });
      await p.click('#tPrep'); await p.waitForTimeout(100);
      if (!(await p.textContent('#prepCycleTop')).includes('離比賽太近')) prepErrs.push('2 週前未顯示「離比賽太近」');
      (await overflow(p)).forEach(x => prepErrs.push(`02/10(300) ${x}`));
      await ctx.close();
    }
    if (prepErrs.length) { fails++; console.log('❌ ① 備賽週期計畫：\n   - ' + prepErrs.join('\n   - ')); }
    else console.log('✅ ① 備賽週期計畫：純計算、性質檢查與 300 px 畫面驗收全過');
  }
  await browser.close();
  if (fails) { console.log(`\n${fails} 項沒過，不發佈。`); process.exit(1); }
  console.log('\n全部賽事包示範跑完，沒有錯誤。');
})().catch(e => { console.error(e); process.exit(1); });
