#!/usr/bin/env python3
"""為世界大滿貫賽事包產生離線路線地圖 races/<id>/map.png。

改自 tools/maps/nyc.py，讀取 race.json 與 route.json 自動繪製路線、坡度、地標、關門與水站。
用法：python tools/maps/majors.py boston-marathon london-marathon sydney-marathon berlin-marathon chicago-marathon
"""
import datetime
import json
import math
import os
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.collections import LineCollection

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
for f in font_manager.findSystemFonts():
    if any(k in f for k in ('NotoSansCJK', 'NotoSansTC', 'msjh')):
        try:
            font_manager.fontManager.addfont(f)
        except Exception:
            pass
plt.rcParams['font.family'] = ['Noto Sans TC', 'Noto Sans CJK TC', 'Microsoft JhengHei', 'sans-serif']

COL = {
    'up3': '#c62828',
    'up2': '#e8604c',
    'up1': '#f2a3a2',
    'flat': '#6b7378',
    'dn1': '#9ec5f4',
    'dn2': '#3987e5',
    'dn3': '#184f95',
}


def gk(g):
    return (
        'up3' if g >= 7 else
        'up2' if g >= 4 else
        'up1' if g >= 2 else
        'dn3' if g <= -7 else
        'dn2' if g <= -4 else
        'dn1' if g <= -2 else
        'flat'
    )


def draw(rid):
    pack = os.path.join(ROOT, 'app', 'src', 'main', 'assets', 'races', rid)
    race = json.load(open(os.path.join(pack, 'race.json'), encoding='utf8'))
    route = json.load(open(os.path.join(pack, 'route.json'), encoding='utf8'))
    n = len(route['lat'])
    step = route['total_m'] / (n - 1)
    tot = route['total_m'] / 1000
    lat0 = (min(route['lat']) + max(route['lat'])) / 2
    lon0 = (min(route['lon']) + max(route['lon'])) / 2
    cx = math.cos(math.radians(lat0))
    xs = [(l - lon0) * cx * 111.32 for l in route['lon']]
    ys = [(l - lat0) * 110.574 for l in route['lat']]
    elev = route['elev']
    span = max(max(xs) - min(xs), max(ys) - min(ys))
    sc = span / 20

    es = lambda i: sum(elev[max(0, min(n - 1, i + k))] for k in range(-2, 3)) / 5
    grade = lambda i: (es(min(n - 1, i + 2)) - es(max(0, i - 2))) / ((min(n - 1, i + 2) - max(0, i - 2)) * step) * 100

    off = 0.06 * sc if race.get('route', {}).get('out_and_back') else 0.0
    ox, oy = [], []
    for i in range(n):
        a, b = max(0, i - 1), min(n - 1, i + 1)
        dx, dy = xs[b] - xs[a], ys[b] - ys[a]
        length = math.hypot(dx, dy) or 1
        ox.append(xs[i] + dy / length * off)
        oy.append(ys[i] - dx / length * off)

    w = max(xs) - min(xs)
    h = max(ys) - min(ys)
    fig, ax = plt.subplots(figsize=(10, 10 * min(2.2, max(0.75, (h + 1.5 * sc) / (w + 1.5 * sc)))), dpi=150)
    fig.patch.set_facecolor('#f9f9f7')
    ax.set_facecolor('#f9f9f7')

    segs = [[(ox[i], oy[i]), (ox[i + 1], oy[i + 1])] for i in range(n - 1)]
    ax.add_collection(LineCollection(segs, colors='#ffffff', linewidths=7, zorder=1, capstyle='round'))
    ax.add_collection(LineCollection(segs, colors=[COL[gk(grade(i))] for i in range(n - 1)], linewidths=3.6, zorder=2, capstyle='round'))

    at = lambda km: (ox[min(n - 1, round(km * 1000 / step))], oy[min(n - 1, round(km * 1000 / step))])
    for k in range(1, int(tot), 2):
        i = round(k * 1000 / step)
        j = min(n - 1, i + 1)
        ax.annotate('', xy=(ox[j], oy[j]), xytext=(ox[i], oy[i]),
                    arrowprops=dict(arrowstyle='-|>', color='#222', lw=1.1, mutation_scale=12), zorder=3)
    for k in range(5, int(tot) + 1, 5):
        x, y = at(k)
        ax.text(x, y, f'{k}K', fontsize=8.5, fontweight='bold', color='#333', ha='left', va='bottom', zorder=6,
                bbox=dict(boxstyle='round,pad=0.12', fc='#ffffffcc', ec='none'))

    stations = race['aid']['stations']
    for a in stations:
        x, y = at(a['km'])
        ax.plot(x, y, 'o', ms=6.5, color='#1c6fbf', mec='white', mew=1.4, zorder=5)

    gun = datetime.datetime.fromisoformat(race['time']['gun'])
    cl = lambda m: (gun + datetime.timedelta(minutes=m)).strftime('%H:%M').lstrip('0') or '0:00'
    cut_map = {round(c['km'], 2): c for c in race['cutoffs']}
    lm = []
    for l in race['landmarks']:
        if l.get('cut') and round(l['km'], 2) in cut_map:
            c = cut_map[round(l['km'], 2)]
            short_n = l['n'][-1] if l['n'].startswith(('關', '掃')) else l['n']
            pre = '掃把車' if l['n'].startswith('掃') else '關門'
            lm.append((short_n, f"{l['name']} {cl(c['min'])}", l['km'], 1, pre))
        else:
            lm.append((l['n'], l['name'], l['km'], 0, ''))

    placed = []
    d1, d2 = 0.26 * sc, 0.56 * sc
    xmin, ymin = min(xs), min(ys)

    # Reserve all landmark circles first so legend/scale bar/labels avoid them
    lm_pts = []
    for num_lbl, name, k, cut, pre in lm:
        x, y = at(k)
        lm_pts.append((x, y))
        placed.append((x - 0.24 * sc, y - 0.24 * sc, x + 0.24 * sc, y + 0.24 * sc))

    # Auto-pick legend corner (top-left, bottom-left, top-right, bottom-right)
    leg_h = 3.2 * sc
    leg_w = 3.6 * sc
    leg_cands = [
        (xmin, max(ys)),
        (xmin, ymin + leg_h),
        (max(xs) - leg_w, max(ys)),
    ]
    lx, ly_top = min(
        leg_cands,
        key=lambda c: (
            sum(1 for i in range(n) if c[0] - 0.3 * sc < ox[i] < c[0] + leg_w + 0.3 * sc and c[1] - leg_h - 0.2 * sc < oy[i] < c[1] + 0.3 * sc)
            + 20 * sum(1 for px, py in lm_pts if c[0] - 0.5 * sc < px < c[0] + leg_w + 0.5 * sc and c[1] - leg_h - 0.3 * sc < py < c[1] + 0.4 * sc)
        )
    )
    placed.append((lx - 0.15 * sc, ly_top - leg_h - 0.15 * sc, lx + leg_w, ly_top + 0.25 * sc))

    # Reserve scale bar + north arrow area avoiding route, legend, and landmark dots
    cands = [
        (max(xs) - 1.2 * sc, ymin),
        (xmin + 0.2 * sc, ymin),
        (xmin + 0.5 * (max(xs) - xmin), ymin),
        (max(xs) - 1.2 * sc, ymin + h * 0.45),
    ]
    bx_s, by_s = min(
        cands,
        key=lambda c: (
            sum(1 for i in range(n) if c[0] - 0.4 * sc < xs[i] < c[0] + 1.4 * sc and c[1] - 0.6 * sc < ys[i] < c[1] + 2.7 * sc)
            + 30 * sum(1 for px, py in lm_pts if c[0] - 0.5 * sc < px < c[0] + 1.5 * sc and c[1] - 0.6 * sc < py < c[1] + 2.7 * sc)
            + 80 * (not (c[0] + 1.4 * sc < lx or c[0] > lx + leg_w or c[1] + 2.7 * sc < ly_top - leg_h or c[1] - 0.6 * sc > ly_top))
        )
    )
    placed.append((bx_s - 0.25 * sc, by_s - 0.45 * sc, bx_s + 1.45 * sc, by_s + 2.65 * sc))

    def text_w(text, fs):
        units = sum(1.1 if ord(ch) > 127 else 0.62 for ch in text)
        return units * 0.0115 * fs * sc * 1.55 + 0.18 * sc

    def place(x, y, text, fs):
        bw = text_w(text, fs)
        bh = (0.0155 * fs + 0.05) * sc * 1.75
        best = None
        offsets = [
            (d1, 0, 'left', 'center'), (-d1, 0, 'right', 'center'),
            (0, d1, 'center', 'bottom'), (0, -d1, 'center', 'top'),
            (d1, d1, 'left', 'bottom'), (-d1, d1, 'right', 'bottom'),
            (d1, -d1, 'left', 'top'), (-d1, -d1, 'right', 'top'),
            (d2, 0, 'left', 'center'), (-d2, 0, 'right', 'center'),
            (0, d2, 'center', 'bottom'), (0, -d2, 'center', 'top'),
            (d2, d2, 'left', 'bottom'), (-d2, d2, 'right', 'bottom'),
            (d2, -d2, 'left', 'top'), (-d2, -d2, 'right', 'top'),
        ]
        for dx, dy, ha, va in offsets:
            x0 = x + dx - (bw if ha == 'right' else bw / 2 if ha == 'center' else 0)
            y0 = y + dy - (bh if va == 'top' else bh / 2 if va == 'center' else 0)
            bx = (x0, y0, x0 + bw, y0 + bh)
            score = sum(1 for i in range(n) if bx[0] - 0.04 < ox[i] < bx[2] + 0.04 and bx[1] - 0.04 < oy[i] < bx[3] + 0.04)
            score += 120 * sum(1 for q in placed if not (bx[2] < q[0] or bx[0] > q[2] or bx[3] < q[1] or bx[1] > q[3]))
            score += 1.2 * math.hypot(dx, dy) / sc
            if bx[0] < min(xs) - 2.5 * sc or bx[2] > max(xs) + 2.5 * sc:
                score += 60
            if bx[3] > max(ys) + 0.9 * sc or bx[1] < ymin - 0.9 * sc:
                score += 80
            if best is None or score < best[0]:
                best = (score, dx, dy, ha, va, bx)
        placed.append(best[5])
        return best[1:5]

    for num_lbl, name, k, cut, pre in lm:
        x, y = at(k)
        ax.plot(x, y, 'o', ms=15, color='#c93a30' if cut else '#101312', mec='white', mew=1.8, zorder=7)
        ax.text(x, y, num_lbl, color='white', fontsize=7.5 if len(num_lbl) > 1 else 8.5, fontweight='bold', ha='center', va='center', zorder=8)

    for num_lbl, name, k, cut, pre in sorted(lm, key=lambda t: (-t[3], t[2])):
        x, y = at(k)
        txt = (f'{pre}{num_lbl} ' if cut else '') + name
        dx, dy, ha, va = place(x, y, txt, 9.5)
        ax.text(x + dx, y + dy, txt, fontsize=9.5, fontweight='bold', ha=ha, va=va,
                color='#c93a30' if cut else '#101312', zorder=9,
                bbox=dict(boxstyle='round,pad=0.18', fc='#ffffffdd', ec='none'))

    ax.plot([bx_s, bx_s + 1.0], [by_s - 0.3 * sc, by_s - 0.3 * sc], color='#101312', lw=3)
    ax.text(bx_s + 0.5, by_s - 0.25 * sc, '1 km', ha='center', va='bottom', fontsize=10)
    ax.annotate('N', xy=(bx_s + 1.0, by_s + 2.4 * sc), xytext=(bx_s + 1.0, by_s + 1.2 * sc), ha='center',
                fontsize=13, fontweight='bold', arrowprops=dict(arrowstyle='-|>', lw=2, color='#101312'))

    leg = [('#e8604c', '上坡 4–7%'), ('#f2a3a2', '緩上 2–4%'), ('#6b7378', '平路'), ('#9ec5f4', '緩下'), ('#3987e5', '下坡'), ('#1c6fbf', f'水站（{len(stations)} 處）')]
    for j, (c, t) in enumerate(leg):
        yy = ly_top - j * 0.56 * sc
        if '水站' in t:
            ax.plot([lx + 0.4 * sc], [yy], 'o', color=c, ms=7, mec='white')
        else:
            ax.plot([lx, lx + 0.8 * sc], [yy, yy], color=c, lw=5)
        ax.text(lx + 1.0 * sc, yy, t, va='center', fontsize=10)

    tz_lbl = race['time'].get('tz_label', '')
    cut_note = race['text'].get('cut_title_note', '關門／收尾參考')
    ax.text(xmin, max(ys) + 1.75 * sc, f'{race["name"]} 路線（{gun.month}/{gun.day} {cl(0)} 開跑・{cut_note}，{tz_lbl}）', fontsize=13, fontweight='bold')
    ax.text(xmin, max(ys) + 1.2 * sc, '紅圈＝關門／收尾線，黑圈＝地標，藍點＝水站，箭頭＝行進方向', fontsize=9.5, color='#5a6460')
    ax.set_aspect('equal')
    ax.axis('off')
    ax.set_xlim(xmin - 0.5 * sc, max(xs) + 0.5 * sc)
    ax.set_ylim(ymin - 0.9 * sc, max(ys) + 2.25 * sc)
    out = os.path.join(pack, 'map.png')
    fig.savefig(out, bbox_inches='tight', pad_inches=0.15, facecolor=fig.get_facecolor())
    plt.close(fig)
    print(f'{out} -> {os.path.getsize(out) // 1024} KB')


if __name__ == '__main__':
    ids = sys.argv[1:] or ['boston-marathon', 'london-marathon', 'sydney-marathon', 'berlin-marathon', 'chicago-marathon']
    for rid in ids:
        draw(rid)
