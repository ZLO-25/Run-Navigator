#!/usr/bin/env python3
"""畫東京馬拉松 2027 的離線路線地圖 races/tokyo-2027/map.png（沒有底圖，只畫路線、坡度、地標、關門、水站）。
改自 Kyoto-Run 的 tools/build_map.py，但資料全部從賽事包 race.json／route.json 讀，不寫死。
折返段：每一條線都往行進方向的右側偏移一點，去程、回程就不會疊在一起。
重跑：python3 tools/maps/tokyo-2027.py（需要 matplotlib 與 Noto Sans CJK 字型）
"""
import json, math, os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.collections import LineCollection

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PACK = os.path.join(ROOT, 'app/src/main/assets/races/tokyo-2027')
RACE = json.load(open(os.path.join(PACK, 'race.json'), encoding='utf8'))
R = json.load(open(os.path.join(PACK, 'route.json')))
for f in font_manager.findSystemFonts():
    if 'NotoSansCJK' in f and ('Regular' in f or 'Bold' in f):
        font_manager.fontManager.addfont(f)
plt.rcParams['font.family'] = ['Noto Sans CJK TC', 'Noto Sans CJK JP', 'sans-serif']

N = len(R['lat']); STEP = R['total_m'] / (N - 1)
LAT0 = (min(R['lat']) + max(R['lat'])) / 2; LON0 = (min(R['lon']) + max(R['lon'])) / 2; CX = math.cos(math.radians(LAT0))
X = [(l - LON0) * CX * 111.32 for l in R['lon']]   # km
Y = [(l - LAT0) * 110.574 for l in R['lat']]
E = R['elev']

def es(i):
    return sum(E[max(0, min(N - 1, i + k))] for k in range(-2, 3)) / 5

def grade(i):
    a, b = max(0, i - 2), min(N - 1, i + 2)
    return (es(b) - es(a)) / ((b - a) * STEP) * 100

OFF = 0.06   # 右側偏移 60 m（東京的去回程多半是同一條路）
OX, OY = [], []
for i in range(N):
    a, b = max(0, i - 1), min(N - 1, i + 1)
    dx, dy = X[b] - X[a], Y[b] - Y[a]; L = math.hypot(dx, dy) or 1
    OX.append(X[i] + dy / L * OFF); OY.append(Y[i] - dx / L * OFF)

COL = {'up3': '#c62828', 'up2': '#e8604c', 'up1': '#f2a3a2', 'flat': '#6b7378', 'dn1': '#9ec5f4', 'dn2': '#3987e5', 'dn3': '#184f95'}
def gk(g):
    return 'up3' if g >= 7 else 'up2' if g >= 4 else 'up1' if g >= 2 else 'dn3' if g <= -7 else 'dn2' if g <= -4 else 'dn1' if g <= -1 else 'flat'

fig, ax = plt.subplots(figsize=(13, 10), dpi=150)
fig.patch.set_facecolor('#f9f9f7'); ax.set_facecolor('#f9f9f7')
segs = [[(OX[i], OY[i]), (OX[i + 1], OY[i + 1])] for i in range(N - 1)]
ax.add_collection(LineCollection(segs, colors='#ffffff', linewidths=7, zorder=1, capstyle='round'))
ax.add_collection(LineCollection(segs, colors=[COL[gk(grade(i))] for i in range(N - 1)], linewidths=3.6, zorder=2, capstyle='round'))

def at(km):
    i = min(N - 1, round(km * 1000 / STEP)); return OX[i], OY[i]

TOT = R['total_m'] / 1000
for k in range(1, int(TOT), 2):   # 行進方向箭頭（每 2 km）
    i = round(k * 1000 / STEP); j = min(N - 1, i + 1)
    ax.annotate('', xy=(OX[j], OY[j]), xytext=(OX[i], OY[i]), arrowprops=dict(arrowstyle='-|>', color='#222', lw=1.1, mutation_scale=12), zorder=3)
placed = []
for k in range(5, int(TOT), 5):   # 公里標（每 5 km）
    x, y = at(k)
    ax.text(x, y, f'{k}K', fontsize=8.5, fontweight='bold', color='#333', ha='left', va='bottom', zorder=6,
            bbox=dict(boxstyle='round,pad=0.12', fc='#ffffffcc', ec='none'))
ST = RACE['aid']['stations']
for a in ST:
    x, y = at(a['km']); ax.plot(x, y, 'o', ms=6.5, color='#1c6fbf', mec='white', mew=1.4, zorder=5)
GUN = RACE['time']['gun'][:10]
cl = lambda m: f"{(9 * 60 + 10 + m) // 60}:{(9 * 60 + 10 + m) % 60:02d}"
CUT = {round(c['km'], 2): c for c in RACE['cutoffs']}
LM = []
for l in RACE['landmarks']:
    if l.get('cut'):
        c = CUT[round(l['km'], 2)]; LM.append((l['n'].replace('關', ''), f"{l['name']} {cl(c['min'])}", l['km'], 1))
    else:
        LM.append((l['n'], l['name'], l['km'], 0))

def place(x, y, text, fs):
    w = len(text) * 0.0115 * fs + 0.08; h = 0.015 * fs + 0.05
    best = None
    for dx, dy, ha, va in [(0.16, 0, 'left', 'center'), (-0.16, 0, 'right', 'center'), (0, 0.16, 'center', 'bottom'), (0, -0.16, 'center', 'top'),
                           (0.13, 0.13, 'left', 'bottom'), (-0.13, 0.13, 'right', 'bottom'), (0.13, -0.13, 'left', 'top'), (-0.13, -0.13, 'right', 'top'),
                           (0.45, 0, 'left', 'center'), (-0.45, 0, 'right', 'center'), (0, 0.4, 'center', 'bottom'), (0, -0.4, 'center', 'top')]:
        x0 = x + dx - (w if ha == 'right' else w / 2 if ha == 'center' else 0); y0 = y + dy - (h if va == 'top' else h / 2 if va == 'center' else 0)
        bx = (x0, y0, x0 + w, y0 + h)
        sc = sum(1 for i in range(N) if bx[0] - 0.04 < OX[i] < bx[2] + 0.04 and bx[1] - 0.04 < OY[i] < bx[3] + 0.04)
        sc += 40 * sum(1 for q in placed if not (bx[2] < q[0] or bx[0] > q[2] or bx[3] < q[1] or bx[1] > q[3]))
        sc += 0.5 * (abs(dx) + abs(dy) > 0.3)
        if bx[0] < min(X) - 0.4 or bx[2] > max(X) + 0.4: sc += 30
        if best is None or sc < best[0]: best = (sc, dx, dy, ha, va, bx)
    placed.append(best[5]); return best[1:5]
for n, name, k, cut in LM:
    x, y = at(k)
    ax.plot(x, y, 'o', ms=15, color='#c93a30' if cut else '#101312', mec='white', mew=1.8, zorder=7)
    ax.text(x, y, n, color='white', fontsize=7.5 if len(n) > 1 else 8.5, fontweight='bold', ha='center', va='center', zorder=8)
    placed.append((x - 0.1, y - 0.1, x + 0.1, y + 0.1))
SEEN = set()
for n, name, k, cut in sorted(LM, key=lambda t: -t[3]):
    if name in SEEN and not cut: continue   # 回程同名地標（日本橋、日比谷）只標一次
    SEEN.add(name)
    x, y = at(k); t = ('關門' + n + ' ' if cut else '') + name
    dx, dy, ha, va = place(x, y, t, 9.5)
    ax.text(x + dx, y + dy, t, fontsize=9.5, fontweight='bold', ha=ha, va=va, color='#c93a30' if cut else '#101312', zorder=9,
            bbox=dict(boxstyle='round,pad=0.18', fc='#ffffffdd', ec='none'))
xs, ys = min(X), min(Y)
ax.plot([max(X) - 1.2, max(X) - 0.2], [ys - 0.15, ys - 0.15], color='#101312', lw=3)
ax.text(max(X) - 0.7, ys - 0.1, '1 km', ha='center', va='bottom', fontsize=10)
ax.annotate('N', xy=(max(X) - 0.1, ys + 1.2), xytext=(max(X) - 0.1, ys + 0.6), ha='center', fontsize=13, fontweight='bold',
            arrowprops=dict(arrowstyle='-|>', lw=2, color='#101312'))
leg = [('#e8604c', '上坡（橋）'), ('#6b7378', '平路'), ('#9ec5f4', '緩下'), ('#1c6fbf', f'● 水站（{len(ST)} 處）')]
for j, (c, t) in enumerate(leg):
    yy = ys + 1.6 - j * 0.3
    if '●' in t: ax.plot([xs + 0.2], [yy], 'o', color=c, ms=7, mec='white')
    else: ax.plot([xs, xs + 0.4], [yy, yy], color=c, lw=5)
    ax.text(xs + 0.5, yy, t.replace('● ', ''), va='center', fontsize=10)
lim = RACE['time']['limit_min'] // 60
ax.text(xs, max(Y) + 0.42, f'{RACE["name"]} 路線（3/7 9:10 鳴槍・{lim} 小時關門）', fontsize=15, fontweight='bold')
ax.text(xs, max(Y) + 0.2, '紅圈＝關門（2026 年時刻），白圈＝地標，箭頭＝行進方向；去回同一條路的路段，兩條線各畫在行進方向右側', fontsize=9.5, color='#5a6460')
ax.set_aspect('equal'); ax.axis('off')
ax.set_xlim(xs - 0.3, max(X) + 0.3); ax.set_ylim(ys - 0.4, max(Y) + 0.65)
out = os.path.join(PACK, 'map.png')
fig.savefig(out, bbox_inches='tight', pad_inches=0.15, facecolor=fig.get_facecolor())
print('map →', out)
