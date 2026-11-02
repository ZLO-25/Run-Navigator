#!/usr/bin/env python3
"""檢查所有賽事包，並打包成畫面用的 app/src/main/assets/races.js。

賽事包 = app/src/main/assets/races/<id>/ 資料夾：
  race.json   人寫的賽事設定（地標、區段、關門、水站、膠、時區、鳴槍…）
  route.json  tools/build_route.py 產生的路線（每 ~100 m 一點）
  route.gpx   原始路線
  map.png     離線地圖

用法：
  python3 tools/build_races.py          檢查＋重新產生 races.js
  python3 tools/build_races.py --check  只檢查，races.js 不是最新就失敗（給 GitHub Actions 用）
"""
import datetime, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RACES = os.path.join(ROOT, 'app/src/main/assets/races')
OUT = os.path.join(ROOT, 'app/src/main/assets/races.js')

errors = []


def err(rid, msg):
    errors.append(f'[{rid}] {msg}')


def near(a, b, tol=0.011):
    return abs(a - b) <= tol


def check(rid, r, route):
    if r.get('format') != 1:
        err(rid, 'format 必須是 1')
    if r.get('id') != rid:
        err(rid, f'id「{r.get("id")}」要跟資料夾名稱一樣')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,40}', rid):
        err(rid, 'id 只能用小寫英文、數字、減號')
    for k in ('name', 'short', 'time', 'distance_m', 'landmarks', 'sections', 'cutoffs', 'aid', 'gels', 'plan', 'finish', 'params', 'text'):
        if k not in r:
            err(rid, f'缺少欄位 {k}')
    if errors:
        return
    t = r['time']
    try:
        g = datetime.datetime.fromisoformat(t['gun'])
        if g.utcoffset() is None:
            err(rid, 'time.gun 要帶時區，例如 2027-02-21T09:00:00+09:00')
    except Exception:
        err(rid, 'time.gun 不是 ISO 時間')
    total_km = r['distance_m'] / 1000
    # 路線
    n = len(route.get('elev', []))
    if n < 10 or len(route.get('lat', [])) != n or len(route.get('lon', [])) != n:
        err(rid, 'route.json 的 lat/lon/elev 長度不一致或太少')
    if abs(route.get('total_m', 0) - r['distance_m']) > 0.5:
        err(rid, f'route.json total_m {route.get("total_m")} ≠ distance_m {r["distance_m"]}（重跑 build_route.py）')
    # 地標
    lm = r['landmarks']
    if not lm or lm[0]['km'] != 0:
        err(rid, '第一個地標要是起點 km 0')
    if lm and not near(lm[-1]['km'], total_km):
        err(rid, f'最後一個地標要是終點 {total_km} km')
    for a, b in zip(lm, lm[1:]):
        if b['km'] <= a['km']:
            err(rid, f'地標要依公里遞增：{a["name"]} {a["km"]} → {b["name"]} {b["km"]}')
    if len({l['n'] for l in lm}) != len(lm):
        err(rid, '地標編號 n 不能重複（分段紀錄用它當鑰匙）')
    # 區段
    sec = r['sections']
    if not sec or sec[0]['a'] != 0:
        err(rid, '第一個區段要從 0 開始')
    if sec and not near(sec[-1]['b'], total_km):
        err(rid, f'最後一個區段要到終點 {total_km}')
    for a, b in zip(sec, sec[1:]):
        if not near(a['b'], b['a'], 1e-6):
            err(rid, f'區段要接起來：{a["a"]}–{a["b"]} 之後是 {b["a"]}–{b["b"]}')
    for s in sec:
        if s['b'] <= s['a']:
            err(rid, f'區段 {s["a"]}–{s["b"]} 長度要大於 0')
        for k in ('from', 'to', 'terr', 'act'):
            if not s.get(k):
                err(rid, f'區段 {s["a"]}–{s["b"]} 缺 {k}')
    # 關門
    cut = r['cutoffs']
    if not cut or not near(cut[-1]['km'], total_km):
        err(rid, '最後一個關門要是終點')
    if cut and cut[-1]['min'] != t['limit_min']:
        err(rid, f'終點關門 {cut[-1]["min"]} 分 ≠ time.limit_min {t["limit_min"]}')
    for a, b in zip(cut, cut[1:]):
        if b['km'] <= a['km'] or b['min'] <= a['min']:
            err(rid, f'關門要依公里與時間遞增：{a["name"]} → {b["name"]}')
    for c in cut[:-1]:
        if not any(l.get('cut') and near(l['km'], c['km'], 0.05) for l in lm):
            err(rid, f'關門 {c["name"]} {c["km"]}K 沒有對應的地標（地標要標 cut: true）')
    # 水站與膠
    st = r['aid']['stations']
    ns = [a['n'] for a in st]
    if len(set(ns)) != len(ns):
        err(rid, '水站編號 n 重複')
    for a in st:
        if not 0 <= a['km'] <= total_km:
            err(rid, f'水站 {a["n"]} 公里 {a["km"]} 超出路線')
        for c in a['s']:
            if c not in r['aid']['labels']:
                err(rid, f'水站 {a["n"]} 的類型「{c}」沒有在 aid.labels 定義')
    for g in r['gels']:
        a = next((x for x in st if x['n'] == g.get('aid')), None)
        if not a:
            err(rid, f'膠 {g["label"]} 的 aid {g.get("aid")} 找不到水站')
        elif not near(a['km'], g['km'], 0.05):
            err(rid, f'膠 {g["label"]} 在 {g["km"]}K，但 {a["n"]} 號水站在 {a["km"]}K')
    # 配速計畫
    p = r['plan']
    if p.get('model') == 'rows':
        rows = p.get('rows', [])
        if not rows or rows[0][0] != 0 or rows[-1][1] < total_km - 0.01:
            err(rid, 'plan.rows 要從 0 覆蓋到終點')
        for a, b in zip(rows, rows[1:]):
            if not near(a[1], b[0], 1e-6):
                err(rid, 'plan.rows 要接起來')
    elif p.get('model') != 'grade':
        err(rid, 'plan.model 只能是 grade 或 rows')
    f = r['finish']
    if not (20 <= f.get('radius_m', 0) <= 500 and 0.8 <= f.get('min_frac', 0) <= 1):
        err(rid, 'finish.radius_m 要 20–500、min_frac 要 0.8–1')
    for k in ('target', 'delay'):
        o = r['params'][k]
        if o['default'] not in [x['v'] for x in o['options']]:
            err(rid, f'params.{k}.default 不在選項裡')


def build():
    packs = []
    for rid in sorted(os.listdir(RACES)):
        d = os.path.join(RACES, rid)
        if not os.path.isdir(d):
            continue
        try:
            r = json.load(open(os.path.join(d, 'race.json'), encoding='utf8'))
            route = json.load(open(os.path.join(d, 'route.json'), encoding='utf8'))
        except Exception as e:
            err(rid, f'讀不到 race.json / route.json：{e}')
            continue
        for f in ('route.gpx', 'map.png'):
            if not os.path.exists(os.path.join(d, f)):
                err(rid, f'缺少 {f}')
        check(rid, r, route)
        r = dict(r)
        r['route'] = dict(r.get('route', {}), lat=route['lat'], lon=route['lon'], elev=route['elev'], total_m=route['total_m'])
        packs.append(r)
    packs.sort(key=lambda r: datetime.datetime.fromisoformat(r['time']['gun']))
    body = ',\n'.join(json.dumps(p, ensure_ascii=False, separators=(',', ':')) for p in packs)
    return ('/* 由 tools/build_races.py 從 races/<id>/ 產生，請勿手改。內建賽事包。 */\n'
            'window.RACES = [\n' + body + '\n];\n'), packs


if __name__ == '__main__':
    js, packs = build()
    if errors:
        print('賽事包有錯：\n  ' + '\n  '.join(errors))
        sys.exit(1)
    if '--check' in sys.argv:
        cur = open(OUT, encoding='utf8').read() if os.path.exists(OUT) else ''
        if cur != js:
            print('races.js 不是最新：請跑 python3 tools/build_races.py 再提交')
            sys.exit(1)
        print(f'{len(packs)} 個賽事包檢查通過，races.js 是最新的')
    else:
        open(OUT, 'w', encoding='utf8').write(js)
        print(f'{len(packs)} 個賽事包檢查通過 → races.js（{len(js) // 1024} KB）：' + '、'.join(p['id'] for p in packs))
