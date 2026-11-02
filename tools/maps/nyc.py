#!/usr/bin/env python3
"""畫紐約市馬拉松（nyc-marathon-2027）的離線路線地圖 races/<id>/map.png。
沒有底圖，只畫路線、坡度、地標、關門／掃把車、水站；資料全部從賽事包 race.json／route.json 讀。
改自 Kyoto-Run 的 tools/build_map.py（同東京版 tools/maps/tokyo-2027.py 的做法）。
重跑：python3 tools/maps/nyc.py nyc-marathon-2027（需要 matplotlib 與 Noto Sans CJK 字型）
"""
import datetime, json, math, os, sys
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.collections import LineCollection

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
for f in font_manager.findSystemFonts():
    if 'NotoSansCJK' in f and ('Regular' in f or 'Bold' in f):
        font_manager.fontManager.addfont(f)
plt.rcParams['font.family'] = ['Noto Sans CJK TC', 'sans-serif']
COL = {'up3': '#c62828', 'up2': '#e8604c', 'up1': '#f2a3a2', 'flat': '#6b7378', 'dn1': '#9ec5f4', 'dn2': '#3987e5', 'dn3': '#184f95'}


def gk(g):
    return 'up3' if g >= 7 else 'up2' if g >= 4 else 'up1' if g >= 2 else 'dn3' if g <= -7 else 'dn2' if g <= -4 else 'dn1' if g <= -2 else 'flat'


def draw(rid):
    pack = os.path.join(ROOT, 'app/src/main/assets/races', rid)
    RACE = json.load(open(os.path.join(pack, 'race.json'), encoding='utf8'))
    R = json.load(open(os.path.join(pack, 'route.json'), encoding='utf8'))
    N = len(R['lat']); STEP = R['total_m'] / (N - 1); TOT = R['total_m'] / 1000
    LAT0 = (min(R['lat']) + max(R['lat'])) / 2; LON0 = (min(R['lon']) + max(R['lon'])) / 2; CX = math.cos(math.radians(LAT0))
    X = [(l - LON0) * CX * 111.32 for l in R['lon']]
    Y = [(l - LAT0) * 110.574 for l in R['lat']]
    E = R['elev']
    span = max(max(X) - min(X), max(Y) - min(Y))
    sc = span / 20            # 字與偏移依地圖大小縮放（全馬約 20 km 寬）
    es = lambda i: sum(E[max(0, min(N - 1, i + k))] for k in range(-2, 3)) / 5
    grade = lambda i: (es(min(N - 1, i + 2)) - es(max(0, i - 2))) / ((min(N - 1, i + 2) - max(0, i - 2)) * STEP) * 100
    OFF = 0.06 * sc           # 往行進方向右側偏移，去回程、相鄰平行路段不疊在一起
    OX, OY = [], []
    for i in range(N):
        a, b = max(0, i - 1), min(N - 1, i + 1)
        dx, dy = X[b] - X[a], Y[b] - Y[a]; L = math.hypot(dx, dy) or 1
        OX.append(X[i] + dy / L * OFF); OY.append(Y[i] - dx / L * OFF)
    W = max(X) - min(X); H = max(Y) - min(Y)
    fig, ax = plt.subplots(figsize=(10, 10 * min(2.2, max(0.8, (H + 1.5 * sc) / (W + 1.5 * sc)))), dpi=150)
    fig.patch.set_facecolor('#f9f9f7'); ax.set_facecolor('#f9f9f7')
    segs = [[(OX[i], OY[i]), (OX[i + 1], OY[i + 1])] for i in range(N - 1)]
    ax.add_collection(LineCollection(segs, colors='#ffffff', linewidths=7, zorder=1, capstyle='round'))
    ax.add_collection(LineCollection(segs, colors=[COL[gk(grade(i))] for i in range(N - 1)], linewidths=3.6, zorder=2, capstyle='round'))
    at = lambda km: (OX[min(N - 1, round(km * 1000 / STEP))], OY[min(N - 1, round(km * 1000 / STEP))])
    for k in range(1, int(TOT), 2):
        i = round(k * 1000 / STEP); j = min(N - 1, i + 1)
        ax.annotate('', xy=(OX[j], OY[j]), xytext=(OX[i], OY[i]), arrowprops=dict(arrowstyle='-|>', color='#222', lw=1.1, mutation_scale=12), zorder=3)
    for k in range(5, int(TOT) + 1, 5):
        x, y = at(k)
        ax.text(x, y, f'{k}K', fontsize=8.5, fontweight='bold', color='#333', ha='left', va='bottom', zorder=6,
                bbox=dict(boxstyle='round,pad=0.12', fc='#ffffffcc', ec='none'))
    ST = RACE['aid']['stations']
    for a in ST:
        x, y = at(a['km']); ax.plot(x, y, 'o', ms=6.5, color='#1c6fbf', mec='white', mew=1.4, zorder=5)
    gun = datetime.datetime.fromisoformat(RACE['time']['gun'])
    cl = lambda m: (gun + datetime.timedelta(minutes=m)).strftime('%H:%M').lstrip('0')
    CUT = {round(c['km'], 2): c for c in RACE['cutoffs']}
    LM = []
    for l in RACE['landmarks']:
        if l.get('cut'):
            c = CUT[round(l['km'], 2)]
            LM.append((l['n'][-1], f"{l['name']} {cl(c['min'])}", l['km'], 1, l['n'][:-1]))
        else:
            LM.append((l['n'], l['name'], l['km'], 0, ''))
    placed = []
    d1, d2 = 0.32 * sc, 0.9 * sc

    def place(x, y, text, fs):
        w = len(text) * 0.0115 * fs * sc * 1.6 + 0.08 * sc; h = (0.015 * fs + 0.05) * sc * 1.6
        best = None
        for dx, dy, ha, va in [(d1, 0, 'left', 'center'), (-d1, 0, 'right', 'center'), (0, d1, 'center', 'bottom'), (0, -d1, 'center', 'top'),
                               (d1, d1, 'left', 'bottom'), (-d1, d1, 'right', 'bottom'), (d1, -d1, 'left', 'top'), (-d1, -d1, 'right', 'top'),
                               (d2, 0, 'left', 'center'), (-d2, 0, 'right', 'center'), (0, d2, 'center', 'bottom'), (0, -d2, 'center', 'top')]:
            x0 = x + dx - (w if ha == 'right' else w / 2 if ha == 'center' else 0); y0 = y + dy - (h if va == 'top' else h / 2 if va == 'center' else 0)
            bx = (x0, y0, x0 + w, y0 + h)
            s = sum(1 for i in range(N) if bx[0] - 0.04 < OX[i] < bx[2] + 0.04 and bx[1] - 0.04 < OY[i] < bx[3] + 0.04)
            s += 40 * sum(1 for q in placed if not (bx[2] < q[0] or bx[0] > q[2] or bx[3] < q[1] or bx[1] > q[3]))
            s += 0.5 * (abs(dx) + abs(dy) > d1 * 1.5)
            if bx[0] < min(X) - 3 * sc or bx[2] > max(X) + 3 * sc: s += 30
            if best is None or s < best[0]: best = (s, dx, dy, ha, va, bx)
        placed.append(best[5]); return best[1:5]
    for n, name, k, cut, pre in LM:
        x, y = at(k)
        ax.plot(x, y, 'o', ms=15, color='#c93a30' if cut else '#101312', mec='white', mew=1.8, zorder=7)
        ax.text(x, y, n, color='white', fontsize=7.5 if len(n) > 1 else 8.5, fontweight='bold', ha='center', va='center', zorder=8)
        placed.append((x - 0.2 * sc, y - 0.2 * sc, x + 0.2 * sc, y + 0.2 * sc))
    for n, name, k, cut, pre in sorted(LM, key=lambda t: -t[3]):
        x, y = at(k); t = (('掃把車' if pre == '掃' else '關門') + n + ' ' if cut else '') + name
        dx, dy, ha, va = place(x, y, t, 9.5)
        ax.text(x + dx, y + dy, t, fontsize=9.5, fontweight='bold', ha=ha, va=va, color='#c93a30' if cut else '#101312', zorder=9,
                bbox=dict(boxstyle='round,pad=0.18', fc='#ffffffdd', ec='none'))
    xs, ys = min(X), min(Y)
    # 比例尺與指北放在路線最少的角落（下右／下左／中右）
    cands = [(max(X) - 1.2, ys), (xs + 0.2, ys), (max(X) - 1.2, ys + H * 0.45)]
    bx, by = min(cands, key=lambda c: sum(1 for i in range(N) if c[0] - 0.3 < X[i] < c[0] + 1.3 and c[1] - 0.6 * sc < Y[i] < c[1] + 2.6 * sc))
    ax.plot([bx, bx + 1.0], [by - 0.3 * sc, by - 0.3 * sc], color='#101312', lw=3)
    ax.text(bx + 0.5, by - 0.25 * sc, '1 km', ha='center', va='bottom', fontsize=10)
    ax.annotate('N', xy=(bx + 1.0, by + 2.4 * sc), xytext=(bx + 1.0, by + 1.2 * sc), ha='center', fontsize=13, fontweight='bold',
                arrowprops=dict(arrowstyle='-|>', lw=2, color='#101312'))
    leg = [('#e8604c', '上坡 4–7%（橋）'), ('#f2a3a2', '緩上 2–4%'), ('#6b7378', '平路'), ('#9ec5f4', '緩下'), ('#3987e5', '下坡'), ('#1c6fbf', f'● 水站（{len(ST)} 處）')]
    for j, (c, t) in enumerate(leg):
        yy = max(Y) - j * 0.6 * sc
        if '●' in t: ax.plot([xs + 0.4 * sc], [yy], 'o', color=c, ms=7, mec='white')
        else: ax.plot([xs, xs + 0.8 * sc], [yy, yy], color=c, lw=5)
        ax.text(xs + 1.0 * sc, yy, t.replace('● ', ''), va='center', fontsize=10)
    lim = RACE['time']['limit_min']
    ax.text(xs, max(Y) + 1.1 * sc, f'{RACE["name"]} 路線（{gun.month}/{gun.day} {cl(0)} 第 1 波・{cl(lim)} 終點關閉，紐約時間）', fontsize=14, fontweight='bold')
    ax.text(xs, max(Y) + 0.6 * sc, '紅圈＝' + ('掃把車（16 分/英里）' if any(l['n'].startswith('掃') for l in RACE['landmarks']) else '關門（2026 年時刻）') +
            '，白圈＝地標，箭頭＝行進方向；相鄰平行路段各畫在行進方向右側', fontsize=9.5, color='#5a6460')
    ax.set_aspect('equal'); ax.axis('off')
    ax.set_xlim(xs - 0.5 * sc, max(X) + 0.5 * sc); ax.set_ylim(ys - 0.8 * sc, max(Y) + 1.5 * sc)
    out = os.path.join(pack, 'map.png')
    fig.savefig(out, bbox_inches='tight', pad_inches=0.15, facecolor=fig.get_facecolor())
    plt.close(fig)
    print('map →', out)


if __name__ == '__main__':
    for rid in sys.argv[1:] or ['nyc-marathon-2027']:
        draw(rid)
