package zl.runnav.app;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 一場賽事的資料與配速計畫。由畫面（index.html）讀賽事包、算好計畫後透過 Android.setCourse() 傳進來，
 * 存在這場賽事自己的儲存格（race_&lt;id&gt;），背景服務的語音、通知列都用這一份，保證和畫面上看到的一模一樣。
 */
final class Course {
    String id = "", name = "", shortName = "", tzShort = "";
    long gun = 0, tzOff = 0;                 // 鳴槍（UTC 毫秒）、賽事當地時區與 UTC 的差（毫秒）
    double limit = 360;                      // 總時限（鳴槍後分鐘）
    double finR = 100, finFrac = 0.98;       // 完賽判定：終點幾公尺內、已跑幾成距離
    Route R;

    int target = 330, delay = 15;
    double[] plan = new double[0];           // 每個路線點的計畫累積分鐘（從過起跑線起算）
    double[] secA, secB; String[] secFrom, secTo, secTerr, secAct;
    String[] lmN, lmName; double[] lmKm; boolean[] lmCut;
    double[] cutKm, cutMin; String[] cutName;
    int[] aidN; double[] aidKm; String[] aidName, aidSay;
    double[] gelK; String[] gelT; int[] gelAt;
    boolean ok;

    static double[] arr(JSONArray a) throws org.json.JSONException { double[] r = new double[a.length()]; for (int i = 0; i < r.length; i++) r[i] = a.getDouble(i); return r; }

    static Course parse(String json) {
        Course c = new Course();
        if (json == null || json.isEmpty()) return c;
        try {
            JSONObject o = new JSONObject(json);
            c.id = o.getString("id"); c.name = o.optString("name"); c.shortName = o.optString("short"); c.tzShort = o.optString("tzShort");
            c.gun = o.getLong("gun"); c.tzOff = o.getLong("tzOff") * 60_000L; c.limit = o.getDouble("limit");
            c.finR = o.optDouble("finR", 100); c.finFrac = o.optDouble("finFrac", 0.98);
            JSONObject r = o.getJSONObject("route");
            c.R = new Route(arr(r.getJSONArray("lat")), arr(r.getJSONArray("lon")), arr(r.getJSONArray("elev")), r.getDouble("total"), r.getDouble("lat0"), r.getDouble("lon0"));
            c.target = o.optInt("target", 330); c.delay = o.optInt("delay", 0);
            c.plan = arr(o.getJSONArray("plan"));
            JSONArray s = o.getJSONArray("sec"); int n = s.length();
            c.secA = new double[n]; c.secB = new double[n]; c.secFrom = new String[n]; c.secTo = new String[n]; c.secTerr = new String[n]; c.secAct = new String[n];
            for (int i = 0; i < n; i++) { JSONObject e = s.getJSONObject(i); c.secA[i] = e.getDouble("a"); c.secB[i] = e.getDouble("b"); c.secFrom[i] = e.getString("from"); c.secTo[i] = e.getString("to"); c.secTerr[i] = e.optString("terr"); c.secAct[i] = e.optString("act"); }
            JSONArray l = o.getJSONArray("lm"); n = l.length();
            c.lmN = new String[n]; c.lmName = new String[n]; c.lmKm = new double[n]; c.lmCut = new boolean[n];
            for (int i = 0; i < n; i++) { JSONObject e = l.getJSONObject(i); c.lmN[i] = e.getString("n"); c.lmName[i] = e.getString("name"); c.lmKm[i] = e.getDouble("km"); c.lmCut[i] = e.optBoolean("cut", false); }
            JSONArray k = o.getJSONArray("cut"); n = k.length();
            c.cutKm = new double[n]; c.cutMin = new double[n]; c.cutName = new String[n];
            for (int i = 0; i < n; i++) { JSONObject e = k.getJSONObject(i); c.cutKm[i] = e.getDouble("km"); c.cutMin[i] = e.getDouble("min"); c.cutName[i] = e.getString("name"); }
            JSONArray a = o.getJSONArray("aid"); n = a.length();
            c.aidN = new int[n]; c.aidKm = new double[n]; c.aidName = new String[n]; c.aidSay = new String[n];
            for (int i = 0; i < n; i++) { JSONObject e = a.getJSONObject(i); c.aidN[i] = e.getInt("n"); c.aidKm[i] = e.getDouble("km"); c.aidName[i] = e.getString("name"); c.aidSay[i] = e.optString("say", "水"); }
            JSONArray g = o.getJSONArray("gel"); n = g.length();
            c.gelK = new double[n]; c.gelT = new String[n]; c.gelAt = new int[n];
            for (int i = 0; i < n; i++) { JSONObject e = g.getJSONObject(i); c.gelK[i] = e.getDouble("k"); c.gelT[i] = e.getString("t"); c.gelAt[i] = e.getInt("at"); }
            c.ok = c.plan.length == c.R.N && c.secA.length > 0 && c.gun > 0;
        } catch (Exception e) { c.ok = false; }
        return c;
    }

    double totalKm() { return R == null ? 0 : R.TOTAL / 1000; }

    // ---- 計畫 ----
    double planMin(double km) { return ok ? R.interp(plan, km * 1000) : km * target / Math.max(1, totalKm()); }
    double planTotal() { return ok ? plan[R.N - 1] : target; }
    double planKm(double min) {
        if (!ok) return 0;
        if (min <= 0) return 0; if (min >= planTotal()) return R.TOTAL / 1000;
        int lo = 0, hi = R.N - 1; while (hi - lo > 1) { int m = (lo + hi) >>> 1; if (plan[m] < min) lo = m; else hi = m; }
        return (lo + (min - plan[lo]) / (plan[hi] - plan[lo])) * R.STEP / 1000;
    }
    double paceBetween(double a, double b) { return (planMin(b) - planMin(a)) / Math.max(0.01, b - a); }
    double planPace(double km) { return paceBetween(Math.max(0, km - 0.25), Math.min(totalKm(), km + 0.25)); }

    // ---- 區段、關門 ----
    int secIndex(double km) { if (secA == null) return -1; for (int i = 0; i < secB.length; i++) if (km < secB[i]) return i; return secB.length - 1; }
    int nextCut(double km) { if (cutKm == null) return -1; for (int i = 0; i < cutKm.length; i++) if (cutKm[i] > km + 0.02) return i; return -1; }
    boolean isCut(double km) { if (cutKm == null) return false; for (double k : cutKm) if (Math.abs(k - km) < 0.05) return true; return false; }
    /** 剛好踩關門的人到 km 的時刻（鳴槍後分鐘），關門之間線性推算 */
    double deadlineMin(double km) {
        double pk = 0, pm = 0;
        for (int i = 0; i < cutKm.length; i++) { if (km <= cutKm[i] + 1e-9) return pm + (km - pk) / (cutKm[i] - pk) * (cutMin[i] - pm); pk = cutKm[i]; pm = cutMin[i]; }
        return limit;
    }
    /** 鳴槍後 gm 分鐘時，剛好踩關門的人在哪（km） */
    double cutLineKm(double gm) {
        if (gm <= 0) return 0; double pk = 0, pm = 0;
        for (int i = 0; i < cutKm.length; i++) { if (gm <= cutMin[i]) return pk + (gm - pm) / (cutMin[i] - pm) * (cutKm[i] - pk); pk = cutKm[i]; pm = cutMin[i]; }
        return totalKm();
    }
    /** 比賽日：鳴槍前 12 小時到鳴槍後（時限＋3 小時） */
    boolean raceWindow(long now) { return now > gun - 12 * 3600_000L && now < gun + (long) ((limit + 180) * 60_000L); }
    static String shortName(String s) { return s.replaceAll("（.*?）", ""); }

    // ---- 時刻（一律用賽事當地時間） ----
    String clk(long ms) { long t = (ms + tzOff) % 86_400_000L; if (t < 0) t += 86_400_000L; long m = t / 60000; return (m / 60) + ":" + two(m % 60); }
    String sayClock(long ms) { long t = (ms + tzOff) % 86_400_000L; if (t < 0) t += 86_400_000L; long m = t / 60000; return (m / 60) + "點" + two(m % 60) + "分"; }
    static String two(long v) { return v < 10 ? "0" + v : String.valueOf(v); }
}
