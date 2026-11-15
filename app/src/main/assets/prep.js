(function (g) {
  'use strict';

  function parseYMD(s) {
    const [y, m, d] = String(s).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  }
  function fmtYMD(ms) {
    const d = new Date(ms);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function addDays(s, n) { return fmtYMD(parseYMD(s) + n * 86400000); }
  function diffDays(fromYmd, toYmd) { return Math.round((parseYMD(toYmd) - parseYMD(fromYmd)) / 86400000); }

  /**
   * 依比賽日與今天算備賽週數與第一週星期一。
   * 賽前 ≤ 1 天之內（或 d mod 7 ≤ 1）從下一週起算；超過 24 週回傳 status='early'。
   */
  function startInfo(raceDay, today) {
    const days = diffDays(today, raceDay);
    if (days < 0) return { status: 'after', days };
    const W = Math.floor(days / 7) + 1;
    const N = days <= 1 ? 1 : (days % 7 <= 1 ? W - 1 : W);
    if (N > 24) return { status: 'early', days, W, N, waitWeeks: N - 24 };
    const s = addDays(raceDay, -(N * 7 - 1));
    return { status: 'ok', days, W, N, s };
  }

  const FOCUS = {
    '基礎': '全部用「能講完整句子」的速度跑，週末長跑不求快。',
    '強化': '每週一次「有點喘但還能撐」的節奏跑 20–30 分鐘，或找坡練上坡；其他照舊輕鬆。',
    '巔峰': '長跑後半段用比賽配速（MP）跑 6–10K；穿比賽的鞋和衣服，照計畫吃膠、喝水。',
    '減量': '跑量減少、不補課、不試新東西；多睡。最後一週只跑 2–3 次短的。',
    '恢復': '這週刻意少跑，是計畫的一部分，不是偷懶。'
  };

  /**
   * 產生 N 週保守備賽課表（不碰 DOM 與儲存）。
   * 參數：{ n, d, target, wk0, long0, s? }
   */
  function cycle(opts) {
    const N = Math.max(1, Math.min(24, Math.round(Number(opts.n))));
    const D = Number(opts.d);
    const target = Number(opts.target);
    const wk0 = Math.max(1, Number(opts.wk0));
    const long0 = Math.max(1, Number(opts.long0));
    const s = opts.s || null;

    const fullTaper = D >= 30;
    const baseT = fullTaper ? 3 : 2;
    const T = Math.min(N, baseT);
    const P = Math.min(N - T, N >= 12 ? 3 : N >= 8 ? 2 : 1);
    const rest = Math.max(0, N - T - P);
    const B = Math.ceil(rest / 2);
    const A = rest - B;
    const buildLen = N - T;

    const mp = target / D;
    const easy = mp * 1.10;
    const lcap = D >= 40 ? 30 : D >= 25 ? Math.round(0.8 * D) : Math.round(0.85 * D);
    const Lmax = Math.max(long0, Math.min(lcap, Math.floor(210 / easy)));

    const isRec = i => i < buildLen && (i + 1) % 4 === 0 && i < buildLen - 1;
    let nonRec = 0;
    for (let i = 0; i < buildLen; i++) if (!isRec(i)) nonRec++;
    const k = Math.max(0, nonRec - 1);
    const wkPeak = k > 0 ? Math.max(wk0, Math.min(wk0 * Math.pow(1.10, k), Lmax * 2, 60)) : wk0;
    const g = k > 0 ? Math.pow(wkPeak / wk0, 1 / k) : 1;

    const tW = fullTaper ? [0.75, 0.55, 0.35] : [0.70, 0.45];
    const tL = fullTaper ? [0.65, 0.45] : [0.60];
    const tOff = baseT - T;

    const weeks = [];
    let j = 0, prevW = wk0, prevL = long0;
    for (let i = 0; i < N; i++) {
      const phase = i < A ? '基礎' : i < A + B ? '強化' : i < A + B + P ? '巔峰' : '減量';
      let wk, lng, rec = false;
      if (i < buildLen) {
        if (isRec(i)) {
          rec = true;
          wk = Math.round(prevW * 0.8);
          lng = Math.round(prevL * 0.7);
        } else {
          prevW = k > 0 ? wk0 * Math.pow(g, j) : wk0;
          prevL = k > 0 ? long0 + (Lmax - long0) * j / k : Math.min(Lmax, long0);
          wk = Math.round(prevW);
          lng = Math.round(prevL);
          j++;
        }
      } else {
        const ti = i - buildLen + tOff;
        wk = Math.round(wkPeak * tW[ti]);
        lng = i === N - 1 ? '比賽' : Math.round(Lmax * tL[ti]);
      }
      const start = s ? addDays(s, i * 7) : null;
      const end = s ? addDays(s, i * 7 + 6) : null;
      weeks.push({
        i, w: N - i, phase, rec, wk, long: lng, start, end,
        focus: FOCUS[rec ? '恢復' : phase]
      });
    }

    const months = {};
    if (s) {
      for (const wk of weeks) {
        const ms0 = parseYMD(wk.start);
        for (let d = 0; d < 7; d++) {
          const ym = fmtYMD(ms0 + d * 86400000).slice(0, 7);
          months[ym] = (months[ym] || 0) + wk.wk / 7;
        }
      }
      for (const ym of Object.keys(months)) months[ym] = Math.round(months[ym]);
    }

    return {
      n: N, d: D, target, wk0, long0, s,
      phases: { base: A, build: B, peak: P, taper: T },
      lcap, Lmax, wkPeak: Math.round(wkPeak),
      highLongRatio: Lmax > wkPeak * 0.6,
      taperOnly: N <= 3,
      weeks, months
    };
  }

  /**
   * 依路線海拔算坡度難度係數 F（與引擎 weight() 同斜率模型：上坡 +4%/1%、下坡 -1.4%/1%，不含擁擠與疲勞）。
   */
  function difficulty(race) {
    const raw = (race && race.route && race.route.elev) || [];
    const n = raw.length, total = Number(race && race.distance_m) || 0;
    if (n < 2 || total <= 0) return 1.0;
    const step = total / (n - 1);
    const es = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -2; k <= 2; k++) sum += raw[Math.max(0, Math.min(n - 1, i + k))];
      es[i] = sum / 5;
    }
    let wSum = 0;
    for (let i = 0; i < n - 1; i++) {
      const g = Math.max(-8, Math.min(12, (es[i + 1] - es[i]) / step * 100));
      wSum += g > 0 ? 1 + 0.04 * g : 1 + 0.014 * g;
    }
    return wSum / (n - 1);
  }

  function riegel(t1Min, d1Km, d2Km, exp) {
    const e = exp == null ? 1.06 : Number(exp);
    if (!(t1Min > 0 && d1Km > 0 && d2Km > 0)) return NaN;
    return t1Min * Math.pow(d2Km / d1Km, e);
  }

  function pbSortMs(dateStr) {
    const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(String(dateStr || '').trim());
    if (!m) return 0;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 15);
  }

  function isRecent12Mo(dateStr, today) {
    const m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(String(dateStr || '').trim());
    const tm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(today || '').trim());
    if (!m || !tm) return false;
    const y = Number(m[1]), mo = Number(m[2]);
    const ty = Number(tm[1]), tmo = Number(tm[2]), td = Number(tm[3]);
    if (m[3]) {
      return diffDays(dateStr, today) <= 366;
    }
    const diffMo = (ty * 12 + tmo) - (y * 12 + mo);
    return diffMo <= 12;
  }

  /**
   * 依 PB 清單與目標賽事參數換算建議目標（理想 / 保底 / 安全上限）。
   * 參數：{ pbs, d2, f2, limit, delay, today? }
   */
  function suggest(opts) {
    const pbs = Array.isArray(opts && opts.pbs) ? opts.pbs : [];
    const D2 = Number(opts && opts.d2);
    const F2 = Number(opts && opts.f2) > 0 ? Number(opts.f2) : 1.0;
    const limit = Number(opts && opts.limit) || 360;
    const delay = Number(opts && opts.delay) || 0;
    const today = (opts && opts.today) || fmtYMD(Date.now());
    const active = pbs.filter(p => p && !p.del && Number(p.d) > 0 && Number(p.t) > 0);
    if (!active.length || !(D2 > 0)) return { ok: false, empty: true, pbsCount: 0 };

    const maxD1 = Math.max(...active.map(p => Number(p.d) / 1000));
    const usable = active.filter(p => Number(p.d) / 1000 >= 5);
    if (!usable.length) return { ok: false, tooShort: true, empty: false, pbsCount: active.length };

    const novice = D2 > maxD1 * 1.2;
    const nMul = novice ? 1.03 : 1.00;
    const maxSafe = Math.max(0, Math.floor((limit - 6 - delay) / 5) * 5);

    const evals = usable.map(pb => {
      const D1 = Number(pb.d) / 1000;
      const T1 = Number(pb.t) / 60;
      const F1 = Number(pb.f) > 0 ? Number(pb.f) : 1.0;
      const T1f = T1 / F1;
      const e2 = D2 <= D1 ? 1.06 : 1.12;
      const rawIdeal = riegel(T1f, D1, D2, 1.06) * F2 * nMul;
      const rawFloor = riegel(T1f, D1, D2, e2) * F2 * nMul;
      return {
        pb, D1, T1, F1, rawIdeal, rawFloor,
        recent: isRecent12Mo(pb.date, today),
        sortMs: pbSortMs(pb.date)
      };
    });

    const recents = evals.filter(x => x.recent);
    let picked, old = false;
    if (recents.length) {
      recents.sort((a, b) => a.rawIdeal - b.rawIdeal || b.sortMs - a.sortMs);
      picked = recents[0];
    } else {
      evals.sort((a, b) => b.sortMs - a.sortMs || a.rawIdeal - b.rawIdeal);
      picked = evals[0];
      old = true;
    }

    const ideal = Math.round(picked.rawIdeal / 5) * 5;
    const floor = Math.max(Math.ceil(picked.rawFloor / 5) * 5, ideal + 10);
    const capped = ideal > maxSafe;
    const applyTarget = Math.min(ideal, maxSafe);
    const floorCapped = Math.min(floor, maxSafe);
    const applyFloor = floorCapped > applyTarget ? floorCapped : 0;
    const wideGap = D2 / picked.D1 > 4.5;
    const baseRiegel = Math.round(riegel(picked.T1, picked.D1, D2, 1.06) / 5) * 5;

    return {
      ok: true,
      pb: picked.pb,
      d1: picked.D1,
      t1Min: picked.T1,
      f1: picked.F1,
      d2: D2,
      f2: F2,
      ideal,
      floor,
      maxSafe,
      capped,
      applyTarget,
      applyFloor,
      novice,
      old,
      wideGap,
      sameOrShorter: D2 <= picked.D1,
      baseRiegel,
      slopePct: Math.round((F2 / picked.F1 - 1) * 100),
      rawIdeal: picked.rawIdeal,
      rawFloor: picked.rawFloor
    };
  }

  function raceTzOffMs(race) {
    const m = /([+-])(\d\d):?(\d\d)$/.exec((race && race.time && race.time.gun) || '');
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000 : 8 * 3600e3;
  }

  /**
   * 從各賽事完賽紀錄收割非示範的完賽時間進共用 PB（同一場同一天只留一筆，尊重已刪除紀錄）。
   */
  function harvestPbs(existingPbs, races, getFin) {
    const out = Array.isArray(existingPbs) ? existingPbs.map(x => Object.assign({}, x)) : [];
    let changed = false;
    for (const r of races || []) {
      if (!r || !r.id) continue;
      const fin = typeof getFin === 'function' ? getFin(r) : r.finished;
      if (!fin || fin.demo || !(Number(fin.t) > 0)) continue;
      const date = fin.c > 0
        ? fmtYMD(Number(fin.c) + raceTzOffMs(r))
        : (r.time && r.time.gun ? String(r.time.gun).slice(0, 10) : fmtYMD(Date.now()));
      const k = r.id + '@' + date;
      const idx = out.findIndex(x => x && x.k === k);
      if (idx >= 0 && out[idx].del) continue;
      const entry = {
        k,
        src: 'race',
        rid: r.id,
        name: r.short || r.name || r.id,
        d: Math.round(Number(r.distance_m) || 0),
        t: Math.round(Number(fin.t)),
        date,
        f: Math.round(difficulty(r) * 1000) / 1000
      };
      if (idx === -1) {
        out.push(entry);
        changed = true;
      } else if (!out[idx].del && entry.t < out[idx].t) {
        out[idx] = entry;
        changed = true;
      }
    }
    return { pbs: out, changed };
  }

  g.PREP = Object.assign(g.PREP || {}, {
    parseYMD, fmtYMD, addDays, diffDays, startInfo, cycle,
    difficulty, riegel, suggest, harvestPbs
  });
})(typeof window !== 'undefined' ? window : globalThis);
