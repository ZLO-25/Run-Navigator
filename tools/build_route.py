#!/usr/bin/env python3
"""從賽事包的 route.gpx 產生 route.json（縮放到官方距離、每 ~100 m 一點）。

用法：python3 tools/build_route.py app/src/main/assets/races/<id>
  - 讀 race.json 的 distance_m（官方距離）
  - 量出 GPX 全長 → 等比縮放成官方距離 → 每 ~100 m 取一點
  - 寫出同資料夾的 route.json（畫面與背景服務都讀這一份）
"""
import json, math, os, re, sys


def dist(p, q):
    R = 6371000
    la1, lo1, la2, lo2 = map(math.radians, (p[0], p[1], q[0], q[1]))
    return 2 * R * math.asin(math.sqrt(math.sin((la2 - la1) / 2) ** 2 +
                                       math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))


def build(pack_dir):
    race = json.load(open(os.path.join(pack_dir, 'race.json'), encoding='utf8'))
    if race.get('route', {}).get('no_rebuild'):
        print(f'{race["id"]}: 跳過（{race["route"]["no_rebuild"]}）')
        return
    total = float(race['distance_m'])
    t = open(os.path.join(pack_dir, 'route.gpx'), encoding='utf8').read()
    P = [(float(a), float(b), float(e)) for a, b, e in
         re.findall(r'lat="([-\d.]+)" lon="([-\d.]+)"[^>]*>\s*<ele>([-\d.]+)</ele>', t)]
    if len(P) < 2:
        raise SystemExit('route.gpx 讀不到含海拔的點（需要 <trkpt lat lon><ele>）')
    cum = [0.0]
    for i in range(len(P) - 1):
        cum.append(cum[-1] + dist(P[i], P[i + 1]))
    K = total / cum[-1]
    N = int(round(total / 100)) + 1
    STEP = total / (N - 1)
    lat, lon, ele = [], [], []
    j = 0
    for i in range(N):
        s = i * STEP / K
        while j < len(P) - 2 and cum[j + 1] < s:
            j += 1
        seg = cum[j + 1] - cum[j]
        f = max(0.0, min(1.0, (s - cum[j]) / seg if seg > 0 else 0))
        lat.append(round(P[j][0] + (P[j + 1][0] - P[j][0]) * f, 6))
        lon.append(round(P[j][1] + (P[j + 1][1] - P[j][1]) * f, 6))
        ele.append(round(P[j][2] + (P[j + 1][2] - P[j][2]) * f, 1))
    out = {'total_m': total, 'lat': lat, 'lon': lon, 'elev': ele}
    with open(os.path.join(pack_dir, 'route.json'), 'w', encoding='utf8') as f:
        json.dump(out, f, separators=(', ', ': '))
        f.write('\n')
    print(f'{race["id"]}: GPX 原長 {cum[-1]:.0f} m → 縮放 {K:.4f}；{N} 點，間距 {STEP:.2f} m；海拔 {min(ele)}–{max(ele)} m')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    for d in sys.argv[1:]:
        build(d)
