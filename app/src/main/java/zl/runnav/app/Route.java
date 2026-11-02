package zl.runnav.app;

/**
 * 一場賽事的路線幾何：海拔、坡度、GPS 對位。與 assets/index.html 的 JS 同一套算法。
 * 路線資料來自賽事包的 route.json（由畫面透過 setCourse 一起傳進來），不再寫死在程式裡。
 */
final class Route {
    final int N;
    final double TOTAL, STEP;
    final double LAT0, LON0, CX;
    final double[] PX, PY, ES, ES3;

    Route(double[] lat, double[] lon, double[] elev, double total, double lat0, double lon0) {
        N = elev.length; TOTAL = total; STEP = total / (N - 1);
        LAT0 = lat0; LON0 = lon0; CX = Math.cos(Math.toRadians(LAT0));
        PX = new double[N]; PY = new double[N]; ES = new double[N]; ES3 = new double[N];
        for (int i = 0; i < N; i++) { PX[i] = toX(lon[i]); PY[i] = toY(lat[i]); }
        for (int i = 0; i < N; i++) {
            double s = 0; for (int k = -2; k <= 2; k++) s += elev[Math.max(0, Math.min(N - 1, i + k))]; ES[i] = s / 5;
            ES3[i] = (elev[Math.max(0, i - 1)] + elev[i] + elev[Math.min(N - 1, i + 1)]) / 3;
        }
    }
    double toX(double lon) { return (lon - LON0) * CX * 111320; }
    double toY(double lat) { return (lat - LAT0) * 110574; }

    double interp(double[] a, double s) {
        s = Math.max(0, Math.min(TOTAL, s));
        double f = s / STEP; int i = Math.min(N - 2, (int) Math.floor(f)); double t = f - i;
        return a[i] + (a[i + 1] - a[i]) * t;
    }
    double elev(double s) { return interp(ES, s); }
    double elev3(double s) { return interp(ES3, s); }
    double grade(double s) {
        double a = Math.max(0, s - 150), b = Math.min(TOTAL, s + 150);
        return (elev(b) - elev(a)) / (b - a) * 100;
    }
    static String gradeWord(double g) { return g >= 7 ? "陡上" : g >= 4 ? "上坡" : g >= 2 ? "緩上" : g <= -7 ? "陡下" : g <= -4 ? "下坡" : g <= -2 ? "緩下" : "平路"; }
    /** 平面座標 (x,y) 到終點的直線距離（公尺），完賽判定用 */
    double distToFinish(double x, double y) { return Math.hypot(x - PX[N - 1], y - PY[N - 1]); }

    /**
     * 在路線片段 [i0,i1] 找「離得近、又接近預期里程 sExp」的點；回傳 {距離 m, 路線里程 m}。
     * 折返段（例如京都北山通、丸太町、今出川）去程回程只隔一條馬路，所以用預期里程（w＝每偏離 1 m 加幾分）來分辨。
     * 比賽不會往回跑：落在預期里程「後面」的點再多扣 wBack 分。短折返（例如烏丸）去回程在 GPX 上是同一條線，
     * 只靠 w 會變成平手、被雜訊拉回去程；加了 wBack 就會往前選。
     */
    double[] match(double x, double y, int i0, int i1, double sExp, double w) { return match(x, y, i0, i1, sExp, w, 0); }
    double[] match(double x, double y, int i0, int i1, double sExp, double w, double wBack) {
        double bd = 1e9, bs = 0, bsc = 1e18;
        for (int i = Math.max(0, i0); i <= Math.min(N - 2, i1); i++) {
            double ax = PX[i], ay = PY[i], dx = PX[i + 1] - ax, dy = PY[i + 1] - ay, L2 = dx * dx + dy * dy;
            double t = L2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
            double d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy)), s = (i + t) * STEP;
            double sc = d + (sExp < 0 ? 0 : w * Math.abs(s - sExp) + wBack * Math.max(0, sExp - s));
            if (sc < bsc) { bsc = sc; bd = d; bs = s; }
        }
        return new double[]{bd, bs};
    }
}
