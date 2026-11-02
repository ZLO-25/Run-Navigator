# 陽明山賽事包的路線是怎麼畫出來的

大會沒有公開 GPX，所以用開放資料自己畫（在暫存資料夾執行，需 `pip install pyarrow shapely numpy pillow`）：

```
1_fetch_roads.py  從 Overture Maps（S3，源自 OpenStreetMap）抓陽明山一帶的道路 → roads.parquet
                  （places 主題同法抓地名，用來對地標）
2_route_legs.py   用 graph.py 把道路接成路網，最短路徑串出三段：
                  A 中山樓→冷水坑叉路、B 叉路→往擎天崗、C 叉路→中湖戰備道路→陽金公路→金山
3_build_gpx.py    海拔取 SRTM 1 弧秒（s3 elevation-tiles-prod/skadi/N25/N25E121.hgt）
                  折返點反推：半馬折返＝馬槽橋前 60 m（官方描述）→ 解出第一折返長度
                              全馬再用 42.195 km 解出第二折返位置
                  → route-42k.gpx、route-21k.gpx（再用 tools/build_route.py 產生 route.json）
4_build_map.py    畫離線地圖 map.png
```

```
中山樓 ──A 4.5K──▶ 冷水坑叉路 ──B 0.6K──▶ 第一折返（往擎天崗）
                     │
                     └─ 中湖戰備道路 ─▶ 陽金公路 ─▶ 馬槽橋（半馬折返 11.15K）
                                                  └─▶ 八煙 ─▶ 重光 ─▶ 全馬折返 21.7K
回程：原路回中山樓（不再跑第一折返）
```

已知誤差：全馬折返點算出來在重光派出所後約 0.9 km；新聞一說「重光派出所之前」、
一說「過林口公車亭」。拿到官方 GPX 或實跑軌跡就換掉 route.gpx。
