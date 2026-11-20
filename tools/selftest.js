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
    const missingItems = await p.evaluate(() => {
      const miss = [];
      for (const g of getHomeGroups()) {
        const card = document.querySelector(`[data-gid="${g.gid}"]`);
        if (!card || !card.textContent.includes(g.title)) miss.push('群組主卡 ' + g.title);
      }
      for (const r of window.RACES) {
        if (!document.querySelector(`[data-go="${r.id}"], [data-pick][data-rid="${r.id}"]`)) miss.push(r.name);
      }
      return miss;
    });
    for (const m of missingItems) errs.push('首頁清單沒有 ' + m);
    if (!(await p.isVisible('#bGoMetro'))) errs.push('首頁沒有跑步節拍器入口');
    if (!(await p.isVisible('#bHomeMetroPlay'))) errs.push('首頁沒有直接打拍按鈕');
    const sameRow = await p.evaluate(() => {
      const a = document.getElementById('bHomeMetroPlay').getBoundingClientRect();
      const b = document.querySelector('#homeMetroChips button:last-child').getBoundingClientRect();
      return Math.abs(a.top - b.top) < 12;
    });
    if (!sameRow) errs.push('直接打拍與 170–190 捷徑應在同一行');
    const iconCount = await p.locator('#raceList .ricon svg').count();
    if (iconCount !== 10) errs.push('首頁賽事卡片應統一為 10 場（實際 ' + iconCount + '）');
    if ((await p.locator('#homeMetroIcon svg').count()) !== 1) errs.push('首頁節拍器沒有特色圖示');
    // 測試日月潭卡片組別切換（29K → 42.2K → 6K），確認海拔、爬升與路線即時更新
    await p.click('[data-more="sunmoonlake"]');
    await p.waitForTimeout(100);
    if ((await p.getAttribute('[data-more="sunmoonlake"]', 'aria-expanded')) !== 'true') errs.push('首頁 more 展開失敗');
    (await overflow(p)).forEach(x => errs.push(x));
    const sml29Elev = await p.textContent('[data-gid="sunmoonlake"] .rplab');
    await p.click('[data-pick="sunmoonlake"][data-rid="sunmoonlake-42k-2026"]');
    await p.waitForTimeout(100);
    const sml42Card = await p.textContent('[data-gid="sunmoonlake"]');
    const sml42Elev = await p.textContent('[data-gid="sunmoonlake"] .rplab');
    if (!sml42Card.includes('42.2K 全馬') || sml42Elev === sml29Elev) errs.push('日月潭切 42.2K 全馬未更新海拔與路線資訊');
    await p.click('[data-pick="sunmoonlake"][data-rid="sunmoonlake-6k-2026"]');
    await p.waitForTimeout(100);
    const sml6Elev = await p.textContent('[data-gid="sunmoonlake"] .rplab');
    if (!(await p.textContent('[data-gid="sunmoonlake"]')).includes('6K 健走') || sml6Elev === sml42Elev) errs.push('日月潭切 6K 健走未更新海拔與路線資訊');
    await p.click('[data-more="sunmoonlake"]');
    await p.waitForTimeout(100);
    if ((await p.getAttribute('[data-more="sunmoonlake"]', 'aria-expanded')) !== 'false') errs.push('首頁 more 收合失敗');
    (await overflow(p)).forEach(x => errs.push(x));
    const metroOnTop = await p.evaluate(() => {
      const m = document.getElementById('bGoMetro'), l = document.getElementById('raceList');
      return m && l && m.getBoundingClientRect().top < l.getBoundingClientRect().top;
    });
    if (!metroOnTop) errs.push('日常訓練應置於賽事清單上方');
    const groupCheckErrs = await p.evaluate(() => {
      const out = [];
      const gs = getHomeGroups();
      if (gs.length !== 10) out.push('getHomeGroups 數量應為 10，實際 ' + gs.length);
      for (const r of window.RACES) {
        const pf = raceProfile(r);
        if (!pf.grp || !pf.sel) out.push(r.id + ' 缺少對應賽事群組');
      }
      return out;
    });
    errs.push(...groupCheckErrs);
    if (!txt.includes('6:35')) errs.push('首頁日月潭應顯示 6:35 鳴槍');
    await ctx.close();
    // 報名組別持久性＋陽明山統一卡片＋準備頁切換連動計畫與地圖
    {
      const rCtx = await open('home', 390);
      await rCtx.p.waitForTimeout(200);
      await rCtx.p.click('[data-more="kyoto"]');
      await rCtx.p.click('[data-pick="kyoto"][data-rid="kyoto-pair1-2027"]');
      await rCtx.p.reload();
      await rCtx.p.waitForTimeout(200);
      const homeCardTxt = await rCtx.p.textContent('[data-gid="kyoto"]');
      if (!homeCardTxt.includes('接力1棒 27.6K')) errs.push('首頁重載後報名組別跳回預設');
      await rCtx.p.click('[data-go="kyoto-pair1-2027"]');
      await rCtx.p.waitForLoadState('load');
      await rCtx.p.waitForTimeout(200);
      if ((await rCtx.p.inputValue('#regCat')) !== 'kyoto-pair1-2027') errs.push('進入準備頁時報名組別未帶入 kyoto-pair1-2027');
      await rCtx.p.selectOption('#regCat', 'kyoto-pair2-2027');
      await rCtx.p.waitForLoadState('load');
      await rCtx.p.waitForTimeout(200);
      if ((await rCtx.p.inputValue('#regCat')) !== 'kyoto-pair2-2027') errs.push('準備頁切換接力2棒失敗');
      await rCtx.p.click('#tMap');
      if (!(await rCtx.p.getAttribute('#mapimg', 'src')).includes('kyoto-pair2-2027/map.png')) errs.push('接力2棒地圖未切換至專用 map.png');
      // 陽明山只有一張統一卡片，切 21K → 42K → 5K 海拔、路線與點擊進入都正確
      await rCtx.p.evaluate(() => goRace(null));
      await rCtx.p.waitForLoadState('load');
      await rCtx.p.waitForTimeout(200);
      const ymsCards = await rCtx.p.locator('[data-gid="yangmingshan"]').count();
      if (ymsCards !== 1) errs.push('陽明山在首頁應只放一張卡片（實際 ' + ymsCards + '）');
      await rCtx.p.click('[data-more="yangmingshan"]');
      const ym21Elev = await rCtx.p.textContent('[data-gid="yangmingshan"] .rplab');
      await rCtx.p.click('[data-pick="yangmingshan"][data-rid="yangmingshan-5k-2026"]');
      await rCtx.p.waitForTimeout(100);
      const ym5Elev = await rCtx.p.textContent('[data-gid="yangmingshan"] .rplab');
      if (ym5Elev === ym21Elev || !(await rCtx.p.textContent('[data-gid="yangmingshan"]')).includes('6:30')) errs.push('陽明山切 5K 後未更新真實海拔或 6:30 鳴槍');
      await rCtx.p.click('[data-pick="yangmingshan"][data-rid="yangmingshan-42k-2026"]');
      await rCtx.p.waitForTimeout(100);
      if ((await rCtx.p.getAttribute('[data-gid="yangmingshan"]', 'data-go')) !== 'yangmingshan-42k-2026') errs.push('陽明山切 42K 後點擊目標未更新為 42K');
      await rCtx.p.click('[data-rf="42k"]');
      const vis42 = await rCtx.p.evaluate(() => [...document.querySelectorAll('#raceList > .rcard')].filter(c => !c.hidden).map(c => c.dataset.rid));
      if (vis42.length !== 10 || !vis42.includes('yangmingshan-42k-2026')) errs.push('全馬 42K 篩選應將陽明山切到 42K 且顯示 10 場');
      await rCtx.p.click('[data-rf="short"]');
      const visShort = await rCtx.p.evaluate(() => [...document.querySelectorAll('#raceList > .rcard')].filter(c => !c.hidden).map(c => c.dataset.rid));
      if (visShort.includes('tokyo-marathon') || visShort.includes('london-marathon') || visShort.length !== 8) errs.push('半馬・短距離篩選應排除純全馬場次（東京／倫敦），實際 ' + visShort.length);
      await rCtx.p.click('[data-rf="all"]');
      await rCtx.p.click('[data-gid="yangmingshan"] .rname');
      await rCtx.p.waitForLoadState('load');
      await rCtx.p.waitForTimeout(200);
      if ((await rCtx.p.inputValue('#regCat')) !== 'yangmingshan-42k-2026') errs.push('進入陽明山全馬後 regCat 應為 yangmingshan-42k-2026');
      await rCtx.p.selectOption('#regCat', 'yangmingshan-5k-2026');
      await rCtx.p.waitForLoadState('load');
      await rCtx.p.waitForTimeout(200);
      await rCtx.p.click('#tMap');
      if (!rCtx.p.url().includes('yangmingshan-5k-2026') || !(await rCtx.p.getAttribute('#mapimg', 'src')).includes('yangmingshan-5k-2026/map.png')) errs.push('準備頁從陽明山全馬切 5K 應換地圖與賽道');
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
      if ('plan2' in res.course || 'target2' in res.course) {
        errs.push('未設定保底時 course payload 不應含 plan2 / target2');
      }
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
  // ③ PB 與目標建議：純計算、difficulty、收割＋畫面（300 px 與 390 px）
  {
    const pbErrs = [];
    const r1 = globalThis.PREP.riegel(210, 28.8, 42.195, 1.06), r2 = globalThis.PREP.riegel(210, 28.8, 42.195, 1.12);
    if (Math.abs(r1 - 314.8) > 0.2 || Math.abs(r2 - 322.1) > 0.2) pbErrs.push(`riegel 算出 ${r1.toFixed(2)} / ${r2.toFixed(2)}`);
    const expDiff = { 'tokyo-marathon': 1.002, 'nyc-marathon-2027': 1.011, 'kyoto-2027': 1.013, 'sunmoonlake-29k-2026': 1.042, 'yangmingshan-42k-2026': 1.073, 'yangmingshan-21k-2026': 1.081 };
    for (const r of races) {
      const d = globalThis.PREP.difficulty(r);
      if (Math.abs(d - expDiff[r.id]) > 0.002) pbErrs.push(`${r.id} difficulty=${d.toFixed(4)} != ${expDiff[r.id]}`);
    }
    const s1 = globalThis.PREP.suggest({ pbs: [{ k: 'a', d: 28800, t: 12600, date: '2026-11-01', f: 1.042 }], d2: 42.195, f2: 1.013, limit: 360, delay: 15, today: '2026-11-15' });
    if (!s1.ok || s1.ideal !== 315 || s1.floor !== 325 || s1.capped !== false) pbErrs.push('範例1不符：' + JSON.stringify(s1));
    const s2 = globalThis.PREP.suggest({ pbs: [{ k: 'a', d: 28800, t: 13500, date: '2026-11-01', f: 1.042 }], d2: 42.195, f2: 1.013, limit: 360, delay: 15, today: '2026-11-15' });
    if (!s2.ok || s2.ideal !== 340 || s2.floor !== 350 || s2.maxSafe !== 335 || s2.capped !== true) pbErrs.push('範例2不符：' + JSON.stringify(s2));
    const sShortD2 = globalThis.PREP.suggest({ pbs: [{ k: 'a', d: 42195, t: 19800, date: '2026-11-01', f: 1.013 }], d2: 21.0975, f2: 1.081, limit: 240, delay: 5, today: '2026-11-15' });
    if (!sShortD2.ok || !sShortD2.sameOrShorter || Number.isNaN(sShortD2.ideal)) pbErrs.push('D2<=D1 邊界錯誤');
    const sOld = globalThis.PREP.suggest({ pbs: [{ k: 'a', d: 21097.5, t: 8400, date: '2024-01', f: 1.0 }], d2: 42.195, f2: 1.013, limit: 360, delay: 15, today: '2026-11-15' });
    if (!sOld.ok || !sOld.old || Number.isNaN(sOld.ideal)) pbErrs.push('舊 PB 邊界錯誤');
    const sTooShort = globalThis.PREP.suggest({ pbs: [{ k: 'a', d: 3000, t: 900, date: '2026-11-01', f: 1.0 }], d2: 42.195, f2: 1.013, limit: 360, delay: 15, today: '2026-11-15' });
    if (sTooShort.ok || !sTooShort.tooShort) pbErrs.push('D1<5 邊界錯誤');
    const sGap = globalThis.PREP.suggest({ pbs: [{ k: 'a', d: 5000, t: 1800, date: '2026-11-01', f: 1.0 }], d2: 42.195, f2: 1.013, limit: 360, delay: 15, today: '2026-11-15' });
    if (!sGap.ok || !sGap.wideGap || Number.isNaN(sGap.ideal)) pbErrs.push('D2/D1>4.5 邊界錯誤');
    const smlR = races.find(r => r.id === 'sunmoonlake-29k-2026'), kyoR = races.find(r => r.id === 'kyoto-2027');
    const hv = globalThis.PREP.harvestPbs([], [smlR, kyoR], r => r.id === smlR.id ? { t: 12600, c: Date.parse('2026-11-01T10:05:00+08:00') } : { t: 19800, c: Date.parse('2027-02-21T14:30:00+09:00'), demo: true });
    if (hv.pbs.length !== 1 || hv.pbs[0].rid !== 'sunmoonlake-29k-2026' || hv.pbs[0].t !== 12600) pbErrs.push('收割邏輯錯誤：' + JSON.stringify(hv));
    const hvDel = globalThis.PREP.harvestPbs([{ k: hv.pbs[0].k, del: 1 }], [smlR], () => ({ t: 12600, c: Date.parse('2026-11-01T10:05:00+08:00') }));
    if (hvDel.pbs.length !== 1 || !hvDel.pbs[0].del) pbErrs.push('刪除標記後不應重複收割');

    for (const w of [300, 390]) {
      const { p, ctx, errs } = await open('race=kyoto-2027&selftest&today=2026-11-15&pb=28800,12600,1.042', w);
      await p.waitForFunction(() => window.__selftest, null, { timeout: 120000 });
      await p.click('#tPrep'); await p.waitForTimeout(100);
      const sug = await p.textContent('#pbSuggest');
      if (!sug.includes('5:15–5:25')) pbErrs.push(`${w}px 未顯示 5:15–5:25：${sug}`);
      (await overflow(p)).forEach(x => pbErrs.push(`PB建議(${w}) ${x}`));
      await p.click('#bPbWhy'); await p.waitForTimeout(80);
      (await overflow(p)).forEach(x => pbErrs.push(`PB算式展開(${w}) ${x}`));
      if (!(await p.textContent('#pbSuggest')).includes('坡度修正')) pbErrs.push(`${w}px 算式展開缺少坡度修正`);
      await p.click('#bPbApply'); await p.waitForTimeout(80);
      const tv = await p.inputValue('#target');
      if (tv !== '315') pbErrs.push(`${w}px 套用後 #target=${tv} != 315`);
      if (!(await p.textContent('#pgPlan')).includes('5:15')) pbErrs.push(`${w}px 計畫頁未更新為 5:15`);
      if (/NaN|undefined/.test(await p.textContent('#pgPrep'))) pbErrs.push(`${w}px 準備頁出現 NaN`);
      (await overflow(p)).forEach(x => pbErrs.push(`PB套用後(${w}) ${x}`));
      if (w === 300) {
        await p.click('#tRace'); await p.waitForTimeout(50);
        await p.click('#bMore'); await p.waitForTimeout(80);
        await p.click('#bPbAddOpen'); await p.waitForTimeout(80);
        (await overflow(p)).forEach(x => pbErrs.push(`PB手動新增(${w}) ${x}`));
      }
      errs.forEach(x => pbErrs.push(x));
      await ctx.close();
    }
    {
      const { p, ctx } = await open('race=kyoto-2027&selftest&today=2026-11-15&pb=28800,13500,1.042', 300);
      await p.waitForFunction(() => window.__selftest, null, { timeout: 120000 });
      await p.click('#tPrep'); await p.waitForTimeout(100);
      const sug = await p.textContent('#pbSuggest');
      if (!sug.includes('套用 5:35') || !sug.includes('5:40–5:50')) pbErrs.push('撞關門黃色提醒不符：' + sug);
      (await overflow(p)).forEach(x => pbErrs.push(`PB撞關門(300) ${x}`));
      await ctx.close();
    }
    if (pbErrs.length) { fails++; console.log('❌ ③ PB 與目標建議：\n   - ' + pbErrs.join('\n   - ')); }
    else console.log('✅ ③ PB 與目標建議：純計算、difficulty、收割與 300 px 畫面驗收全過');
  }
  // ② 目標時間區間：純計算（plan2 / zone）、保底選項與 300 px 畫面驗收
  {
    const zErrs = [];
    for (const rid of ['kyoto-2027', 'tokyo-marathon']) {
      for (const w of [300, 390]) {
        const { p, ctx, errs } = await open(`race=${rid}&selftest&t2=335`, w);
        await p.waitForFunction(() => window.__selftest, null, { timeout: 25000 });
        const res = await p.evaluate(() => window.__selftest);
        zErrs.push(...errs, ...res.errs);
        if (res.course.target2 !== 335) zErrs.push(`${rid}@${w}: target2 應為 335，實為 ${res.course.target2}`);
        const p1 = res.course.plan, p2 = res.course.plan2;
        if (!Array.isArray(p2) || p2.length !== p1.length) {
          zErrs.push(`${rid}@${w}: plan2 長度不符`);
        } else {
          for (let i = 0; i < p1.length; i++) {
            if (!Number.isFinite(p2[i]) || p2[i] < p1[i] - 1e-9) {
              zErrs.push(`${rid}@${w}: plan2[${i}] (${p2[i]}) < plan[${i}] (${p1[i]})`);
              break;
            }
            if (i > 0 && p2[i] < p2[i - 1] - 1e-9) {
              zErrs.push(`${rid}@${w}: plan2[${i}] 不單調`);
              break;
            }
          }
        }
        if (!res.zones || res.zones.length !== 3 || !res.zones.every(z => z.ahead === 'ahead' && z.in === 'in' && z.behind === 'behind')) {
          zErrs.push(`${rid}@${w}: zones 判定錯誤 ${JSON.stringify(res.zones)}`);
        }
        const finTxt = await p.textContent('#pgFinish');
        if (!finTxt || finTxt.includes('NaN') || finTxt.includes('undefined')) {
          zErrs.push(`${rid}@${w}: #pgFinish 含 NaN/undefined`);
        }
        if (w === 300) {
          (await overflow(p)).forEach(x => zErrs.push(`${rid} finish: ` + x));
          for (const tab of ['#tPrep', '#tPlan', '#tMap']) {
            await p.click(tab);
            await p.waitForTimeout(120);
            (await overflow(p)).forEach(x => zErrs.push(`${rid} ${tab}: ` + x));
          }
        }
        await ctx.close();
      }
    }
    // 準備頁 #target2 選項與時限鎖定檢查
    {
      const { p, ctx, errs } = await open('race=kyoto-2027', 300);
      await p.waitForTimeout(250);
      await p.click('#tPrep');
      await p.waitForTimeout(100);
      zErrs.push(...errs);
      const opts15 = await p.$$eval('#target2 option', els => els.map(e => e.value));
      if (JSON.stringify(opts15) !== JSON.stringify(['0', '335'])) {
        zErrs.push('京都 delay=15, target=330 的 #target2 選項應為 [0,335]，實為 ' + JSON.stringify(opts15));
      }
      await p.selectOption('#target2', '335');
      await p.waitForTimeout(120);
      (await overflow(p)).forEach(x => zErrs.push('京都 target2=335 準備頁: ' + x));
      await p.selectOption('#delay', '20');
      await p.waitForTimeout(120);
      if ((await p.inputValue('#target2')) !== '0') zErrs.push('京都 delay 改 20 後應清空保底');
      if (!(await p.textContent('#target2Note')).includes('這場的時限放不下保底')) {
        zErrs.push('京都無保底空間時應顯示提示');
      }
      (await overflow(p)).forEach(x => zErrs.push('京都無保底準備頁: ' + x));
      await ctx.close();
    }
    {
      const { p, ctx, errs } = await open('race=tokyo-marathon', 300);
      await p.waitForTimeout(250);
      await p.click('#tPrep');
      await p.waitForTimeout(100);
      zErrs.push(...errs);
      const opts = await p.$$eval('#target2 option', els => els.map(e => e.value));
      const exp = ['0', '335', '340', '345', '350', '355', '360', '365', '370'];
      if (JSON.stringify(opts) !== JSON.stringify(exp)) {
        zErrs.push('東京 delay=20, target=330 的 #target2 選項不符：' + JSON.stringify(opts));
      }
      await ctx.close();
    }
    // 首頁顯示區間（5:30–5:35）與 300 px 防爆版檢查
    {
      const { p, ctx, errs } = await open('home', 300);
      await p.waitForTimeout(200);
      await p.evaluate(() => {
        localStorage.setItem('rn_kyoto-2027.target', '330');
        localStorage.setItem('rn_kyoto-2027.target2', '335');
      });
      await p.reload();
      await p.waitForTimeout(200);
      await p.click('[data-more="kyoto"]');
      await p.waitForTimeout(100);
      zErrs.push(...errs);
      const homeCard = await p.textContent('[data-go="kyoto-2027"]');
      if (!homeCard.includes('5:30–5:35')) zErrs.push('首頁應顯示區間 5:30–5:35，實為：' + homeCard);
      (await overflow(p)).forEach(x => zErrs.push('首頁目標區間: ' + x));
      await ctx.close();
    }
    if (zErrs.length) { fails++; console.log('❌ ② 目標時間區間：\n   - ' + zErrs.join('\n   - ')); }
    else console.log('✅ ② 目標時間區間：plan2/zone 計算、保底選項與 300 px 畫面驗收全過');
  }
  await browser.close();
  if (fails) { console.log(`\n${fails} 項沒過，不發佈。`); process.exit(1); }
  console.log('\n全部賽事包示範跑完，沒有錯誤。');
})().catch(e => { console.error(e); process.exit(1); });
