/*
 * 訓練紀錄：匯入 Garmin／Strava 匯出的 CSV → 存在手機 → 首頁總覽、紀錄頁（月曆、28 天趨勢、列表）
 *
 *   Garmin Connect 網頁「活動」→ 匯出 CSV ─┐
 *   Strava「下載帳號資料」裡的 activities.csv ─┼─▶ TL.parse() 自動辨識格式 ─▶ TL.merge() 去重複 ─▶ TL.save()
 *                                            │
 *                                            └─ 每筆存成 {t 日期, hm 時刻, sport 運動, kind 種類, km, sec, hr, cad, gain, title}
 *
 * 種類（kind，只對跑步）：比賽 race ＞ 品質課 quality（標題有間歇、節奏…）＞ 長跑 long（≥ 15 km）＞ 輕鬆跑 easy
 * 儲存：APK 存在原生 store（跟賽事參數分開）；網頁版存 localStorage rn_tlog。示範（selftest）只放記憶體。
 * 這支檔案不碰定位、語音、賽事包，比賽日的功能完全不受影響。
 */
'use strict';
(function () {
  const p2 = n => String(n).padStart(2, '0');
  const LONG_KM = 15;
  const KIND = {
    easy: { name: '輕鬆跑', col: 'var(--aid)' },
    quality: { name: '品質課', col: 'var(--bad)' },
    long: { name: '長跑', col: 'var(--plan)' },
    race: { name: '比賽', col: 'var(--warn)' },
    cross: { name: '交叉訓練', col: 'var(--ok)' }
  };
  const SPORT = { run: '跑步', ride: '單車', hike: '登山健行', walk: '走路', other: '其他' };

  /* ---------- 儲存 ---------- */
  const NATIVE = !!(window.Android && window.Android.getStore);
  const SELFTEST = /(^|[#&])selftest/.test(location.hash);
  const mem = {};
  function sget(k) {
    if (SELFTEST) return mem[k] == null ? null : mem[k];
    try { return NATIVE ? Android.getStore(k) : localStorage.getItem('rn_' + k); } catch (e) { return null; }
  }
  function sset(k, v) {
    if (SELFTEST) { mem[k] = v; return; }
    try {
      if (NATIVE) Android.setStore(k, v);
      else if (v == null) localStorage.removeItem('rn_' + k); else localStorage.setItem('rn_' + k, v);
    } catch (e) { }
  }

  /* ---------- CSV 讀取（支援引號、逗號、換行、BOM） ---------- */
  function csvRows(text) {
    text = text.replace(/^﻿/, '');
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(f); f = ''; if (row.some(x => x.trim() !== '')) rows.push(row); row = [];
      } else f += c;
    }
    row.push(f); if (row.some(x => x.trim() !== '')) rows.push(row);
    return rows;
  }
  const num = s => { s = String(s == null ? '' : s).replace(/,/g, '').trim(); if (!s || s === '--') return null; const v = parseFloat(s); return isFinite(v) ? v : null; };
  // "1:34:12"、"27:05"、"00:27:05.3"、或純秒數 → 秒
  function dur(s) {
    s = String(s == null ? '' : s).trim(); if (!s || s === '--') return null;
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s));
    const a = s.split(':').map(parseFloat); if (a.some(x => !isFinite(x))) return null;
    return Math.round(a.length === 3 ? a[0] * 3600 + a[1] * 60 + a[2] : a.length === 2 ? a[0] * 60 + a[1] : a[0]);
  }
  // 依名稱找欄位（中英文都試；同名欄位取第一個，Strava 第一個 Distance 是公里）
  function col(head, names) {
    const h = head.map(x => x.trim().toLowerCase());
    for (const n of names) { const i = h.indexOf(n.toLowerCase()); if (i >= 0) return i; }
    return -1;
  }
  function sportOf(type, title) {
    const s = (type + ' ' + (title || '')).toLowerCase();
    const t = String(type).toLowerCase();
    if (/run|跑/.test(t)) return 'run';
    if (/cycl|ride|bik|騎|自行車|單車/.test(t)) return 'ride';
    if (/hik|健行|登山|mountaineer|爬山/.test(t)) return 'hike';
    if (/walk|步行|健走|散步/.test(t)) return 'walk';
    if (!t && /run|跑/.test(s)) return 'run';
    return 'other';
  }
  function kindOf(sport, title, km) {
    if (sport !== 'run') return 'cross';
    const s = String(title || '');
    if (/race|比賽|賽事|馬拉松|marathon|半馬|全馬/i.test(s)) return 'race';
    if (/間歇|節奏|tempo|interval|閾值|threshold|repeat|fartlek|法特雷克|速度|track|漸速|\d+\s*[x×*]\s*\d+/i.test(s)) return 'quality';
    if (km >= LONG_KM) return 'long';
    return 'easy';
  }
  // 日期：Garmin "2026-11-10 06:12:33"（當地時間）；Strava "Nov 10, 2026, 10:12:33 PM"（UTC）
  function when(s, utc) {
    s = String(s || '').trim();
    const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (m && !utc) return { t: m[1] + '-' + p2(m[2]) + '-' + p2(m[3]), hm: m[4] ? p2(m[4]) + ':' + m[5] : '' };
    const ms = Date.parse(utc && !/utc|gmt|z$|[+-]\d\d:?\d\d$/i.test(s) ? s + ' UTC' : s);
    if (!isFinite(ms)) return null;
    const d = new Date(ms);
    return { t: d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()), hm: p2(d.getHours()) + ':' + p2(d.getMinutes()) };
  }

  /** 解析一份 CSV。回傳 {src, items, skipped} 或 {err} */
  function parse(text) {
    const rows = csvRows(text);
    if (rows.length < 2) return { err: '檔案是空的，或不是 CSV' };
    const head = rows[0];
    const strava = col(head, ['Activity ID']) >= 0 && col(head, ['Activity Date']) >= 0;
    const C = strava ? {
      type: col(head, ['Activity Type']), date: col(head, ['Activity Date']), title: col(head, ['Activity Name']),
      dist: col(head, ['Distance']), time: col(head, ['Moving Time', 'Elapsed Time']), hr: col(head, ['Average Heart Rate']),
      cad: col(head, ['Average Cadence']), gain: col(head, ['Elevation Gain'])
    } : {
      type: col(head, ['Activity Type', '活動類型', '活動類別', '活動种类', '活动类型']), date: col(head, ['Date', '日期']),
      title: col(head, ['Title', '標題', '标题', '名稱']), dist: col(head, ['Distance', '距離', '距离']),
      time: col(head, ['Time', '時間', '时间', 'Moving Time', '移動時間', 'Elapsed Time', '經過時間']),
      hr: col(head, ['Avg HR', '平均心率']), cad: col(head, ['Avg Run Cadence', '平均跑步步頻', '平均步頻', '平均跑步踏頻']),
      gain: col(head, ['Total Ascent', '總爬升', '总爬升', '總上升'])
    };
    if (C.date < 0 || C.dist < 0) return { err: '看不出是 Garmin 或 Strava 的活動 CSV（找不到「日期」或「距離」欄）' };
    const items = []; let skipped = 0;
    for (const r of rows.slice(1)) {
      const w = when(r[C.date], strava); if (!w) { skipped++; continue; }
      const type = C.type >= 0 ? r[C.type] : '', title = C.title >= 0 ? (r[C.title] || '').trim() : '';
      const sport = sportOf(type, title);
      let km = num(r[C.dist]) || 0;
      if (km > 300) km = km / 1000;            // 游泳等以公尺計的距離
      const sec = C.time >= 0 ? dur(r[C.time]) : null;
      if (!km && !sec) { skipped++; continue; }
      let cad = C.cad >= 0 ? num(r[C.cad]) : null;
      if (strava && cad && cad < 120 && sport === 'run') cad *= 2;   // Strava 跑步步頻是單腳
      items.push({
        t: w.t, hm: w.hm, sport, kind: kindOf(sport, title, km), tm: /treadmill|跑步機|indoor|室內/i.test(type) ? 1 : 0,
        km: Math.round(km * 100) / 100, sec: sec || 0,
        hr: C.hr >= 0 ? num(r[C.hr]) : null, cad: cad ? Math.round(cad) : null, gain: C.gain >= 0 ? num(r[C.gain]) : null,
        title: title.slice(0, 60), src: strava ? 'strava' : 'garmin'
      });
    }
    return { src: strava ? 'Strava' : 'Garmin', items, skipped };
  }

  /* ---------- 紀錄本體 ---------- */
  const keyOf = a => a.t + ' ' + (a.hm || '') + ' ' + Math.round(a.km * 10);
  function load() { try { return JSON.parse(sget('tlog')) || []; } catch (e) { return []; } }
  function save(list) { list.sort((a, b) => (b.t + b.hm).localeCompare(a.t + a.hm)); sset('tlog', JSON.stringify(list)); }
  function merge(items) {
    const list = load(), seen = new Set(list.map(keyOf)); let added = 0, dup = 0;
    for (const a of items) { const k = keyOf(a); if (seen.has(k)) { dup++; continue; } seen.add(k); list.push(a); added++; }
    save(list);
    return { added, dup, total: list.length };
  }
  function goal() { const v = Number(sget('tgoal')); return v > 0 ? v : 150; }
  function setGoal(v) { sset('tgoal', String(v)); }

  /* ---------- 統計 ---------- */
  const ymd = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
  function range(list, from, to) { return list.filter(a => a.t >= from && a.t <= to); }
  function window28(list, today) {
    const t = new Date(today + 'T12:00:00'), a = ymd(addDays(t, -27)), b = ymd(addDays(t, -28)), c = ymd(addDays(t, -55));
    const stat = L => {
      const runs = L.filter(x => x.sport === 'run'), nr = runs.filter(x => x.kind !== 'race');
      const rk = sum(runs, x => x.km), rs = sum(runs.filter(x => x.sec), x => x.sec), rkt = sum(runs.filter(x => x.sec), x => x.km);
      return {
        km: rk, hours: sum(L, x => x.sec) / 3600, longest: nr.length ? Math.max(...nr.map(x => x.km)) : 0,
        days: new Set(runs.map(x => x.t)).size, pace: rkt > 0 ? rs / rkt : null
      };
    };
    return { now: stat(range(list, a, today)), prev: stat(range(list, c, b)) };
  }
  function streak(list, today) {
    const days = new Set(list.map(a => a.t));
    let cur = 0, d = new Date(today + 'T12:00:00');
    if (!days.has(today)) d = addDays(d, -1);             // 今天還沒練不算斷
    while (days.has(ymd(d))) { cur++; d = addDays(d, -1); }
    let best = 0, run = 0, prev = null;
    for (const t of [...days].sort()) {
      run = prev && ymd(addDays(new Date(prev + 'T12:00:00'), 1)) === t ? run + 1 : 1;
      best = Math.max(best, run); prev = t;
    }
    return { cur, best };
  }
  function summary(list, today) {
    const ym = today.slice(0, 7), y = today.slice(0, 4);
    const mon = list.filter(a => a.t.startsWith(ym)), yr = list.filter(a => a.t.startsWith(y));
    const runs = L => L.filter(a => a.sport === 'run');
    return {
      monthKm: sum(runs(mon), a => a.km), monthRuns: runs(mon).length, monthCross: mon.filter(a => a.sport !== 'run').length,
      yearKm: sum(runs(yr), a => a.km), yearRuns: runs(yr).length,
      w: window28(list, today), st: streak(list, today), goal: goal(), last: list[0] || null
    };
  }

  /* ---------- 顯示小工具 ---------- */
  const f1 = v => (Math.round(v * 10) / 10).toFixed(1);
  const paceTxt = s => s ? Math.floor(s / 60) + ':' + p2(Math.round(s % 60)) : '—';
  const durTxt = s => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? h + 'h' + p2(m) + 'm' : m + 'm' + p2(s % 60) + 's'; };
  function chg(now, prev, lowerBetter) {
    if (!prev) return now ? '<span class="tl-up">新</span>' : '<span class="tl-flat">—</span>';
    const r = (now - prev) / prev, pct = Math.round(r * 100);
    if (Math.abs(r) < 0.05) return '<span class="tl-flat">■ 持平</span>';
    const good = lowerBetter ? r < 0 : r > 0;
    return `<span class="${good ? 'tl-up' : 'tl-down'}">${r > 0 ? '▲' : '▼'} ${Math.abs(pct)}%</span>`;
  }

  /** 首頁總覽卡的 HTML（沒紀錄時是引導匯入） */
  function homeCard(today) {
    const list = load();
    if (!list.length) {
      return `<div class="tl-empty"><div><b>還沒有練跑紀錄</b><div class="note">匯入 Garmin 或 Strava 的 CSV，這裡就會出現本月跑量、連續訓練天數和近 28 天趨勢。</div></div>` +
        `<button class="small" id="bHomeLog">📥 匯入紀錄</button></div>`;
    }
    const s = summary(list, today), pct = Math.min(100, s.monthKm / s.goal * 100);
    const m = Number(today.slice(5, 7));
    return `<div class="tl-mon"><div><div class="lab">${m} 月跑量</div><div class="tl-big"><b>${f1(s.monthKm)}</b><span> / ${s.goal} km</span></div></div>` +
      `<div class="tl-go">${s.monthRuns} 次跑步${s.monthCross ? '<br>' + s.monthCross + ' 次交叉' : ''}</div></div>` +
      `<div class="tl-bar" role="img" aria-label="本月目標完成 ${Math.round(pct)}%"><i style="width:${pct}%"></i></div>` +
      `<div class="tgt3">` +
      `<div><div class="t">${today.slice(0, 4)} 年累計</div><div class="v">${Math.round(s.yearKm)} km</div></div>` +
      `<div><div class="t">連續訓練</div><div class="v">${s.st.cur} 天</div><div class="tl-s">最長 ${s.st.best} 天</div></div>` +
      `<div><div class="t">近 28 天</div><div class="v">${Math.round(s.w.now.km)} km</div><div class="tl-s">${chg(s.w.now.km, s.w.prev.km)}</div></div>` +
      `</div>`;
  }

  /** 月曆：週一開頭；每天一顆色塊＝當天跑量，顏色＝種類（比賽＞品質＞長跑＞輕鬆），只有交叉訓練顯示綠點 */
  function calendar(list, y, m, today) {
    const ym = y + '-' + p2(m), first = new Date(y, m - 1, 1), days = new Date(y, m, 0).getDate();
    const lead = (first.getDay() + 6) % 7, rank = { race: 4, quality: 3, long: 2, easy: 1 };
    const byDay = {};
    for (const a of list) if (a.t.startsWith(ym)) (byDay[a.t] = byDay[a.t] || []).push(a);
    let h = '<div class="tl-cal">' + '一二三四五六日'.split('').map((w, i) => `<div class="tl-wd${i > 4 ? ' we' : ''}">${w}</div>`).join('');
    for (let i = 0; i < lead; i++) h += '<div></div>';
    let tot = 0;
    for (let d = 1; d <= days; d++) {
      const t = ym + '-' + p2(d), L = byDay[t] || [], runs = L.filter(a => a.sport === 'run');
      const km = sum(runs, a => a.km); tot += km;
      const top = runs.sort((a, b) => rank[b.kind] - rank[a.kind])[0];
      const wd = (lead + d - 1) % 7;
      const chip = top ? `<span class="tl-chip" style="--kc:${KIND[top.kind].col}">${km >= 10 ? Math.round(km) : f1(km)}</span>` : L.length ? `<span class="tl-dot" title="交叉訓練"></span>` : '';
      h += `<div class="tl-day${t === today ? ' today' : ''}${wd > 4 ? ' we' : ''}"><span class="tl-dn">${d}</span>${chip}</div>`;
    }
    h += '</div>';
    return { html: h, km: tot };
  }

  window.TL = { parse, load, save, merge, goal, setGoal, summary, homeCard, calendar, KIND, SPORT, f1, paceTxt, durTxt, chg, sset, sget, LONG_KM };
})();
