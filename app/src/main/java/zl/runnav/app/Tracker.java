package zl.runnav.app;

import java.util.ArrayDeque;

/**
 * GPS 一點 → 路線里程。純 Java（不碰 Android），GitHub Actions 可以直接在電腦上把每個賽事包模擬跑一遍。
 *
 * <pre>
 *   GPS 點 ──▶ 精度 &gt; 80 m？──是──▶ 丟掉
 *                 │否
 *                 ▼
 *   在「目前位置附近」找最近、又接近預期里程的路線點（折返段靠預期里程分去程／回程）
 *                 │
 *        離路線 &gt; 300 m？──是──▶ 不在賽道上（off）
 *                 │否
 *                 ▼
 *   更新里程 curS；已跑 ≥ 98% 且離終點 ≤ 100 m ──▶ 到終點（atFinish）
 * </pre>
 */
final class Tracker {
    static final double OFF_M = 300;
    static final double BACK = 0.4;    // 落在預期里程後面，每公尺多扣 0.4 分（比賽不會往回跑）
    Course C;   // 畫面改了計畫（目標、延遲）會換成新的一份，位置與歷史保留
    double curS = 0, dev = -1, finDist = -1;
    boolean hasHist = false, off = false;
    int badJumps = 0;
    final ArrayDeque<long[]> hist = new ArrayDeque<>();    // {時間ms, 里程m*1000}

    Tracker(Course c, double startS) { C = c; curS = startS; }

    static final int SKIP = 0, OFF = 1, OK = 2;

    /** 處理一個 GPS 點。elapsedMin＝已跑分鐘（沒起跑為 -1），用來在第一次定位時猜你大概在哪。 */
    int fix(long now, double lon, double lat, double acc, double elapsedMin) {
        if (acc > 80 || C.R == null) return SKIP;
        Route R = C.R;
        double x = R.toX(lon), y = R.toY(lat);
        double[] b;
        if (hasHist) {
            long[] last = hist.peekLast();
            double dt = last == null ? 1 : Math.max(0.5, (now - last[0]) / 1000.0);
            double sExp = curS + Math.min(5, recentSpeed()) * dt;
            int i0 = (int) Math.floor((curS - 400) / R.STEP), i1 = (int) Math.ceil((curS + Math.max(1500, dt * 8)) / R.STEP);
            b = R.match(x, y, i0, i1, sExp, 0.1, BACK);
            if (b[0] > 150) { double[] g = R.match(x, y, 0, R.N - 2, sExp, 0.02); if (g[0] < b[0] - 30 && g[0] < 100) b = g; }
            if (last != null && Math.abs(b[1] - last[1] / 1000.0) / dt > 8 && badJumps < 3) { badJumps++; return SKIP; }
            badJumps = 0;
            if (b[1] < curS && curS - b[1] < 120) b[1] = curS;
        } else {
            double prior = curS > 0 ? curS : (elapsedMin > 0 ? C.planKm(elapsedMin) * 1000 : 0);
            b = R.match(x, y, 0, R.N - 2, prior, curS > 0 ? 0.05 : 0.01);
        }
        dev = b[0];
        finDist = R.distToFinish(x, y);
        if (dev > OFF_M) { off = true; hasHist = false; hist.clear(); return OFF; }
        off = false; hasHist = true;
        curS = b[1];
        hist.addLast(new long[]{now, (long) (curS * 1000)});
        while (!hist.isEmpty() && now - hist.peekFirst()[0] > 120_000) hist.pollFirst();
        return OK;
    }

    /** 完賽判定：已跑超過 finFrac 的距離，而且人在終點 finR 公尺內 */
    boolean atFinish() { return hasHist && curS >= C.finFrac * C.R.TOTAL && finDist >= 0 && finDist <= C.finR; }

    double recentSpeed() {
        if (hist.size() < 2) return 3;
        long[] last = hist.peekLast(), a = null; int k = 0;
        java.util.Iterator<long[]> it = hist.descendingIterator(); while (it.hasNext() && k < 6) { a = it.next(); k++; }
        double dt = (last[0] - a[0]) / 1000.0; return dt > 3 ? Math.max(0, (last[1] - a[1]) / 1000.0 / dt) : 3;
    }
    /** 近 90 秒配速（秒/km），無法算則 -1、停住為 0 */
    double paceSec(long now, long lastFix) {
        if (hist.size() < 2 || now - lastFix > 20000) return -1;
        long[] old = null; for (long[] e : hist) { if (now - e[0] <= 90000) { old = e; break; } }
        long[] last = hist.peekLast();
        if (old == null || last[0] - old[0] < 30000) return -1;
        double ds = (last[1] - old[1]) / 1000.0; if (ds < 20) return 0;
        return (last[0] - old[0]) / 1000.0 / ds * 1000;
    }
}
