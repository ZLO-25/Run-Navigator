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

  g.PREP = Object.assign(g.PREP || {}, {
    parseYMD, fmtYMD, addDays, diffDays, startInfo, cycle
  });
})(typeof window !== 'undefined' ? window : globalThis);
