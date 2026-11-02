package zl.runnav.app;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Random;

/**
 * 發版保護（Java 端）：用畫面算出來的計畫（setCourse 的 JSON），把每個賽事包「假裝跑一遍」。
 *
 *   照計畫配速沿路線前進，每秒產生一個 GPS 點（加 ±8 m 雜訊）
 *     → 交給背景服務同一個 Tracker 對位
 *     → 檢查：對位誤差、有沒有誤判「不在賽道上」、折返段有沒有跳到另一條腿、終點有沒有自動完賽
 *
 * 用法：java -cp ... zl.runnav.app.TrackerCheck course-kyoto.json course-sml.json
 */
public class TrackerCheck {
    public static void main(String[] args) throws Exception {
        int fails = 0;
        // 每場跑 6 種情境：慢／照計畫／快 × GPS 誤差 8 m／15 m（雜訊用固定種子，每次結果一樣）
        double[][] cases = {{1, 8, 42}, {1.25, 8, 7}, {0.8, 8, 11}, {1, 15, 3}, {1.25, 15, 5}, {0.8, 15, 9}};
        for (String f : args) { String js = Files.readString(Path.of(f)); for (double[] c : cases) fails += check(js, c[0], c[1], (long) c[2]); }
        if (fails > 0) { System.out.println("❌ Java 對位檢查失敗 " + fails + " 項"); System.exit(1); }
        System.out.println("✅ Java 對位檢查全部通過");
    }

    static double[] lonlat(Route R, double s) {
        double f = Math.max(0, Math.min(R.TOTAL, s)) / R.STEP; int i = Math.min(R.N - 2, (int) Math.floor(f)); double t = f - i;
        double x = R.PX[i] + (R.PX[i + 1] - R.PX[i]) * t, y = R.PY[i] + (R.PY[i + 1] - R.PY[i]) * t;
        return new double[]{x / (R.CX * 111320) + R.LON0, y / 110574 + R.LAT0};
    }

    static int check(String json, double slow, double sigma, long seed) {
        Course C = Course.parse(json);
        String id = C.id;
        if (!C.ok) { System.out.println("[" + id + "] ❌ course JSON 解析失敗"); return 1; }
        Route R = C.R;
        Tracker T = new Tracker(C, 0);
        Random rnd = new Random(seed);
        long t0 = 1_000_000_000_000L;
        int n = 0, ok = 0, off = 0, within50 = 0, back = 0; double maxErr = 0, finishAt = -1, prevS = 0;
        double total = C.planTotal() * 60 * slow, nx = 0, ny = 0, worstAt = 0;
        for (int sec = 0; sec <= total + 120; sec++) {
            double el = sec / 60.0, sTrue = Math.min(R.TOTAL, C.planKm(el / slow) * 1000);
            double[] p = lonlat(R, sTrue);
            // GPS 誤差會「慢慢飄」而不是每秒亂跳：用 AR(1) 雜訊，標準差約 8 m
            nx = 0.95 * nx + 0.312 * sigma * rnd.nextGaussian(); ny = 0.95 * ny + 0.312 * sigma * rnd.nextGaussian();
            double lon = p[0] + nx / (R.CX * 111320), lat = p[1] + ny / 110574;
            int r = T.fix(t0 + sec * 1000L, lon, lat, sigma, el);
            n++;
            if (r == Tracker.OFF) off++;
            if (r == Tracker.OK) {
                ok++;
                double e = Math.abs(T.curS - sTrue); if (e > maxErr) { maxErr = e; worstAt = sTrue; } if (e <= 50) within50++;
                if (T.curS < prevS - 1) back++;
                prevS = T.curS;
                if (finishAt < 0 && T.atFinish()) finishAt = sTrue;
            }
        }
        // 完賽後在終點旁邊 60 m 處休息：不能被當成「不在賽道上」
        double[] fp = lonlat(R, R.TOTAL);
        int restOff = 0;
        for (int sec = 0; sec < 300; sec++) {
            int r = T.fix(t0 + (long) (total + 200 + sec) * 1000L, fp[0] + 60 / (R.CX * 111320), fp[1], 8, (total + 200 + sec) / 60);
            if (r == Tracker.OFF) restOff++;
        }
        int fails = 0;
        StringBuilder sb = new StringBuilder();
        double pct = 100.0 * within50 / Math.max(1, ok);
        sb.append(String.format("[%s 配速×%.2f、誤差 %.0f m] %d 點、對到 %d 點；誤差 ≤50 m 的比例 %.1f%%、最大誤差 %.0f m；不在賽道上 %d 次；倒退 %d 次；",
            id, slow, sigma, n, ok, pct, maxErr, off, back));
        if (pct < 98) { fails++; sb.append("❌誤差太大 "); }
        double lim = sigma > 10 ? 300 : 150;    // GPS 很差（15 m）時，山路之字彎偶爾會短暫對到隔壁那一彎，容許到 300 m
        if (maxErr > lim) { fails++; sb.append(String.format("❌有跳到別段（最大誤差>%.0f m，在 %.2fK）", lim, worstAt / 1000)); }
        if (off > 0) { fails++; sb.append("❌誤判不在賽道上 "); }
        if (finishAt < 0) { fails++; sb.append("❌終點沒有自動完賽 "); }
        else {
            sb.append(String.format("在 %.0f m 判定完賽（全程 %.0f m）；", finishAt, R.TOTAL));
            if (finishAt < C.finFrac * R.TOTAL) { fails++; sb.append("❌太早判定完賽 "); }
        }
        if (restOff > 0) { fails++; sb.append("❌終點旁休息被判不在賽道上 "); }
        System.out.println(sb + (fails == 0 ? " ✅" : ""));
        return fails;
    }
}
