# Run Navigator（馬拉松賽道定位）

一支 APK、一套引擎、多個賽事包。跑步時不用看手機：每 1K、進區段、地標、水站、關門都會語音＋震動；停下來瞄一眼就知道「我在哪、比計畫快還慢、離關門還有多久」。

> 開工前先讀 [docs/HANDOFF.md](docs/HANDOFF.md)（交接文件）。M1 計畫與賽事包格式：[docs/M1-PLAN.md](docs/M1-PLAN.md)。

```
          ┌──────────── 一套引擎（app/src/main/） ────────────┐
          │  畫面 index.html ──setCourse──▶ 背景服務 GpsService │
          │  （首頁清單、準備、跑步中、完賽）   GPS 對位、語音、通知列 │
          └──────────────────────▲────────────────────────────┘
                                 │ 讀
            ┌────────────────────┼─────────────────────┐
     races/kyoto-2027/   races/sunmoonlake-29k-2026/   （以後：匯入的新賽事）
     race.json＋route.json＋route.gpx＋map.png
```

## 取得 APK
- **正式版**：推到 `main` → Actions「Build APK」→ Releases「Run Navigator 最新版」下載 `RunNavigator-v*.apk`。
- **PR 測試版**：PR 的 Actions 頁面最下方 Artifacts → `RunNavigator-v*-test`（套件名稱 `zl.runnav.app.debug`，可跟正式版同時裝）。
- 套件名稱 `zl.runnav.app`，跟舊的 `tw.kyoto42k.locator`、`tw.sml29k.locator` 不同，三支可以並存。舊京都 App 要保留到新 App 實跑測試通過。

## 發版保護（每次推送自動跑，任何一項沒過就不發佈）
| 步驟 | 做什麼 | 指令 |
|---|---|---|
| ① 賽事包檢查 | 公里數遞增、區段接起來、關門對到地標、膠對到水站、races.js 是最新 | `python3 tools/build_races.py --check` |
| ② 畫面示範 | 無頭瀏覽器把每個賽事包從起點跑到終點：每 1K／區段／地標／水站語音、終點自動完賽 | `node tools/selftest.js` |
| ③ 背景對位 | 每個賽事包 × 3 種配速 × 2 種 GPS 誤差，檢查折返段不會跳腿、終點會完賽、終點旁休息不誤報 | 見 `.github/workflows/build.yml` |

## 改賽事包之後
```
python3 tools/build_route.py app/src/main/assets/races/<id>   # 換了 route.gpx 才需要
python3 tools/build_races.py                                   # 檢查並重新打包 races.js（一定要跑）
```

## 專案結構
```
app/src/main/assets/index.html     畫面（首頁清單＋賽事頁；與網頁版同一份）
app/src/main/assets/races/<id>/    賽事包
app/src/main/assets/races.js       由 build_races.py 產生（畫面讀這個）
app/src/main/java/zl/runnav/app/
  Route.java      路線幾何、坡度、對位（折返段：預期里程＋不往回跑）
  Tracker.java    GPS 一點 → 路線里程、完賽判定（純 Java，可在電腦上測）
  Course.java     畫面傳來的賽事資料與計畫
  GpsService.java 前景服務：語音、震動、分段、通知列、完賽後自動停止
  Strip.java      通知列的「你／計畫／關門線」對照圖
  MainActivity.java WebView＋JS 橋接（存檔分 pref 共用／race_<id> 每場一格）
tools/             賽事包工具與發版保護
web/               網頁版的 manifest、離線快取、圖示
```
