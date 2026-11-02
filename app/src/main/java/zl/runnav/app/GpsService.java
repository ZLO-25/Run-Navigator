package zl.runnav.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.location.GnssStatus;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.speech.tts.TextToSpeech;
import android.widget.RemoteViews;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;

/**
 * 前景服務：螢幕鎖著也持續抓 GPS、對到路線、語音（每 1K、進區段、地標、補給、關門、停下 10 秒）、
 * 震動、記錄分段、判定完賽，並每 5 秒更新通知列（含「你／計畫／關門線」對照圖）。
 *
 * 同時只有一場賽事在定位：pref 的 "active" 記著是哪一場，該場的資料與紀錄都存在它自己的 race_&lt;id&gt;。
 */
public class GpsService extends Service implements LocationListener {
    static final String ACT_START = "start", ACT_STOP = "stop", ACT_TIMER = "timer", ACT_FINISH = "finish";
    static final String CH = "race", EXTRA_RACE = "race";

    interface Listener { void onState(String json); }
    static volatile Listener listener;
    static volatile boolean running;
    static volatile boolean courseDirty = true;

    private LocationManager lm;
    private PowerManager.WakeLock wl;
    private Vibrator vib;
    private TextToSpeech tts; private boolean ttsReady;
    private SharedPreferences pref, rs;      // pref＝個人偏好（全 App 共用）；rs＝這場賽事自己的一格
    private String raceId = "";
    private final Handler h = new Handler(Looper.getMainLooper());
    private Course C = new Course();
    private Tracker T;

    // 狀態
    double acc = -1; long lastFix = 0, lastSave = 0, lastNotif = 0;
    int satsUsed = 0, satsSeen = 0; long lastAnyFix = 0;
    boolean finished = false;
    private GnssStatus.Callback gnssCb;
    String lastAlert = ""; long lastAlertAt = 0;
    double lastSplitS = 0; int lastKm = -1, lastSec = -1; boolean stopped = false;

    static SharedPreferences racePrefs(Context c, String id) { return c.getSharedPreferences("race_" + id, MODE_PRIVATE); }

    @Override public void onCreate() {
        super.onCreate();
        pref = getSharedPreferences("pref", MODE_PRIVATE);
        lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 31) vib = ((VibratorManager) getSystemService(VIBRATOR_MANAGER_SERVICE)).getDefaultVibrator();
        else vib = (Vibrator) getSystemService(VIBRATOR_SERVICE);
        tts = new TextToSpeech(this, st -> { if (st == TextToSpeech.SUCCESS) { int r = tts.setLanguage(Locale.TAIWAN); ttsReady = r >= 0; tts.setSpeechRate(1.05f); } });
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CH, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false); ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC); nm.createNotificationChannel(ch);
    }

    /** 換到某一場賽事：讀它自己的計畫、位置、完賽狀態 */
    void openRace(String id) {
        raceId = id; rs = racePrefs(this, id);
        pref.edit().putString("active", id).apply();
        double s = rs.getFloat("pos", 0); long pt = rs.getLong("posT", 0);
        if (System.currentTimeMillis() - pt > 2 * 3600_000L) s = 0;
        C = Course.parse(rs.getString("course", "")); courseDirty = false;
        T = new Tracker(C, s);
        lastSplitS = s; lastKm = -1; lastSec = -1; stopped = false; lastAlert = "";
        finished = !rs.getString("finished", "").isEmpty();
    }
    void loadCourse() { C = Course.parse(rs.getString("course", "")); courseDirty = false; if (T != null) T.C = C; }

    @Override public int onStartCommand(Intent in, int flags, int id) {
        String a = in == null ? ACT_START : in.getAction();
        if (ACT_STOP.equals(a)) { stopSelf(); return START_NOT_STICKY; }
        if (ACT_TIMER.equals(a) || ACT_FINISH.equals(a)) {
            if (!running || rs == null) { stopSelf(); return START_NOT_STICKY; }
            if (ACT_TIMER.equals(a)) {          // 通知列「我過線了」：以現在為起跑
                rs.edit().putLong("start", System.currentTimeMillis()).remove("splits").remove("finished").apply();
                finished = false; buzz(new long[]{0, 300, 100, 300}); speak("開始計時，加油", true);
            } else finish("manual");           // 畫面「我完賽了」
            updateNotif(); push(state()); return START_STICKY;
        }
        String rid = in == null ? null : in.getStringExtra(EXTRA_RACE);
        if (rid == null || rid.isEmpty()) rid = pref.getString("active", "");
        if (rid.isEmpty()) { stopSelf(); return START_NOT_STICKY; }
        if (!rid.equals(raceId)) openRace(rid);
        else { finished = !rs.getString("finished", "").isEmpty(); if (courseDirty) loadCourse(); }
        if (finished) { rs.edit().remove("finished").apply(); finished = false; }   // 取消完賽、繼續定位
        Notification n = buildNotif("正在搜尋 GPS…", "請到空曠處", null, null);
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION); else startForeground(1, n);
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (wl == null) { wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "runnav:gps"); wl.acquire(10 * 3600_000L); }
            lm.removeUpdates(this);
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, this, Looper.getMainLooper());
            if (Build.VERSION.SDK_INT >= 31 && lm.hasProvider(LocationManager.FUSED_PROVIDER))
                lm.requestLocationUpdates(LocationManager.FUSED_PROVIDER, 1000, 0, this, Looper.getMainLooper());
            if (gnssCb == null) {
                gnssCb = new GnssStatus.Callback() {
                    @Override public void onSatelliteStatusChanged(GnssStatus s) { int u = 0, k = s.getSatelliteCount(); for (int i = 0; i < k; i++) if (s.usedInFix(i)) u++; satsUsed = u; satsSeen = k; }
                    @Override public void onStopped() { satsUsed = satsSeen = 0; }
                };
                lm.registerGnssStatusCallback(gnssCb, h);
            }
        } catch (SecurityException e) { push("{\"err\":\"noperm\"}"); stopSelf(); return START_NOT_STICKY; }
        running = true;
        h.removeCallbacks(tickR); h.removeCallbacks(stopR); h.post(tickR);
        return START_STICKY;
    }

    /** 每秒：重讀計畫（若畫面改過）、檢查停下、推狀態給畫面、每 5 秒更新通知列 */
    private final Runnable tickR = new Runnable() { @Override public void run() {
        if (courseDirty) loadCourse();
        long now = System.currentTimeMillis();
        if (!finished) checkStop(now);
        if (now - lastNotif > 5000) { updateNotif(); lastNotif = now; }
        push(state()); h.postDelayed(this, 1000);
    } };
    private final Runnable stopR = this::stopSelf;

    @Override public void onDestroy() {
        running = false; h.removeCallbacks(tickR); h.removeCallbacks(stopR);
        try { lm.removeUpdates(this); if (gnssCb != null) lm.unregisterGnssStatusCallback(gnssCb); } catch (Exception ignored) { }
        if (wl != null && wl.isHeld()) wl.release();
        if (tts != null) tts.shutdown();
        pref.edit().remove("active").apply();
        push(state());
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent i) { return null; }

    // ---------- GPS → 路線里程 ----------
    @Override public void onLocationChanged(Location p) {
        if (T == null || finished) return;
        long now = System.currentTimeMillis();
        lastAnyFix = now;
        if (p.getAccuracy() > 80) { if (acc < 0 || now - lastFix > 10000) acc = p.getAccuracy(); return; }
        acc = p.getAccuracy(); lastFix = now;
        int r = T.fix(now, p.getLongitude(), p.getLatitude(), p.getAccuracy(), elapsedMin());
        if (r == Tracker.SKIP) return;
        if (r == Tracker.OFF) {
            if (!lastAlert.equals("away")) { speak("你目前不在賽道上", true); lastAlert = "away"; lastAlertAt = now; }
            push(state()); return;
        }
        if (now - lastSave > 20_000) { rs.edit().putFloat("pos", (float) T.curS).putLong("posT", now).apply(); lastSave = now; }
        checkSplits(now);
        if (elapsedMin() >= 0 && T.atFinish()) { finish("auto"); push(state()); return; }
        checkVoice(now); checkAlerts(now);
        push(state());
    }
    @Override public void onProviderDisabled(String p) { push("{\"err\":\"gpsoff\"}"); }
    @Override public void onProviderEnabled(String p) { }

    // ---------- 完賽：記下成績、停語音與偏離提醒、20 秒後停止定位 ----------
    void finish(String how) {
        if (finished) return;
        long now = System.currentTimeMillis();
        double el = elapsedMin();
        try {
            JSONObject f = new JSONObject().put("how", how).put("c", now).put("s", Math.round(T.curS)).put("d", Math.round(T.finDist));
            if (el >= 0) f.put("t", Math.round(el * 60));
            rs.edit().putString("finished", f.toString()).putFloat("pos", (float) T.curS).putLong("posT", now).apply();
        } catch (JSONException ignored) { }
        finished = true;
        buzz(new long[]{0, 500, 150, 500});
        speak("完賽！" + (el >= 0 ? "淨時間" + sayHMS(el * 60) + "。" : "") + "定位會自動停止，辛苦了。", true);
        try { lm.removeUpdates(this); } catch (Exception ignored) { }
        updateNotif(); lastNotif = now;
        h.postDelayed(stopR, 20_000);
    }

    // ---------- 時間 ----------
    long startMs() {
        long s = rs.getLong("start", 0), now = System.currentTimeMillis();
        if (s > 0 && Math.abs(now - s) < 20 * 3600_000L) return s;
        if (C.ok && C.raceWindow(now)) return C.gun + C.delay * 60_000L;
        return 0;
    }
    double elapsedMin() { long s = startMs(); return s == 0 ? -1 : (System.currentTimeMillis() - s) / 60000.0; }
    /** 鳴槍後分鐘（關門用）；練習時＝已跑＋預估延遲 */
    double gunMin() { long now = System.currentTimeMillis(); if (C.raceWindow(now)) return (now - C.gun) / 60000.0; double el = elapsedMin(); return el < 0 ? -1 : el + C.delay; }
    long baseStart() { long s = startMs(); return s != 0 ? s : C.gun + C.delay * 60_000L; }
    double curS() { return T == null ? 0 : T.curS; }

    // ---------- 分段紀錄（通過地標） ----------
    void checkSplits(long now) {
        double emin = elapsedMin(), curS = curS(); if (emin < 0 || !C.ok) { lastSplitS = curS; return; }
        try {
            JSONObject sj = new JSONObject(rs.getString("splits", "{}"));
            boolean changed = false;
            for (int i = 1; i < C.lmKm.length; i++) {
                double m = C.lmKm[i] * 1000;
                if (m > lastSplitS && m <= curS + 1 && !sj.has(C.lmN[i])) {
                    int t = (int) Math.round(emin * 60), plan = (int) Math.round(C.planMin(C.lmKm[i]) * 60);
                    sj.put(C.lmN[i], new JSONObject().put("t", t).put("c", now).put("plan", plan));
                    changed = true;
                    buzz(new long[]{0, 120}); speak(C.lmName[i] + "，" + vsPlan(plan - t) + "。", false);
                }
            }
            if (changed) rs.edit().putString("splits", sj.toString()).apply();
        } catch (JSONException ignored) { }
        lastSplitS = curS;
    }

    // ---------- 語音：每 1K、進入新區段（排隊播放，不互相打斷） ----------
    void checkVoice(long now) {
        double el = elapsedMin(), km = curS() / 1000; int k = (int) Math.floor(km + 1e-6), si = C.secIndex(km);
        if (el < 0 || !C.ok) { lastKm = k; lastSec = si; return; }
        if (lastKm < 0) { lastKm = k; lastSec = si; return; }
        if (si > lastSec) {
            speak("進入區段" + (si + 1) + "，" + C.secFrom[si] + "到" + Course.shortName(C.secTo[si]) + "。" + C.secAct[si], false);
            lastSec = si;
        }
        if (k > lastKm) {
            if (pref.getBoolean("kmv", true) && k >= 1 && k <= C.totalKm()) speak(kmSay(k, el), false);
            lastKm = k;
        }
    }
    String vsPlan(double diffSec) { return (diffSec >= 0 ? "比計畫快" : "比計畫慢") + sayMS(diffSec); }
    String kmSay(int k, double el) {
        String t = k + "公里，" + vsPlan(C.planMin(curS() / 1000) * 60 - el * 60) + "。";
        int nc = C.nextCut(k); double gm = gunMin();
        if (nc >= 0 && gm >= 0) {
            double mar = C.cutMin[nc] - (gm + C.planMin(C.cutKm[nc]) - C.planMin(k));
            if (mar < 15 || k % 5 == 0) t += C.cutName[nc] + "關門餘裕" + Math.max(0, (int) Math.floor(mar)) + "分鐘。";
        }
        return t;
    }
    /** 停下 10 秒（補給、走路）：自動報告位置、區段、計畫與底線 */
    void checkStop(long now) {
        if (T == null || !C.ok || !T.hasHist || !pref.getBoolean("stopv", true) || elapsedMin() < 0 || T.curS > C.R.TOTAL - 100 || now - lastFix > 15000) return;
        long[] first = null, last = T.hist.peekLast();
        for (long[] e : T.hist) if (now - e[0] <= 12000) { first = e; break; }
        if (first == null || last == null) return;
        double moved = (last[1] - first[1]) / 1000.0;
        if (now - first[0] >= 9000 && moved < 8) {
            if (!stopped) { stopped = true; speak(stopSay(), false); updateNotif(); lastNotif = now; }
        } else if (moved > 30) stopped = false;
    }
    String stopSay() {
        double km = curS() / 1000, el = elapsedMin(); int si = C.secIndex(km);
        String to = Course.shortName(C.secTo[si]);
        long planB = baseStart() + (long) (C.planMin(C.secB[si]) * 60000), dl = C.gun + (long) (C.deadlineMin(C.secB[si]) * 60000);
        return "你在" + String.format(Locale.ROOT, "%.1f", km) + "公里，往" + to + "。" + vsPlan(C.planMin(km) * 60 - el * 60) + "。到" + to + "計畫" + C.sayClock(planB) + "，底線" + C.sayClock(dl) + "。" + C.secAct[si];
    }

    // ---------- 提醒（同一事件只提醒一次） ----------
    void checkAlerts(long now) {
        if (!C.ok) return;
        String key = "", say = ""; long[] pat = null; double curS = curS(), km = curS / 1000, gm = gunMin(), dev = T.dev;
        if (dev > 80 && now - lastFix < 20000) { key = "off" + (int) (curS / 500); say = "你離路線" + (int) dev + "公尺，確認有沒有跑錯"; pat = new long[]{0, 400, 200, 400}; }
        else {
            int nc = C.nextCut(km);
            if (nc >= 0 && nc < C.cutKm.length - 1 && gm >= 0 && elapsedMin() >= 0) {
                double left = C.cutMin[nc] - gm, dist = C.cutKm[nc] - km;
                double marPlan = left - (C.planMin(C.cutKm[nc]) - C.planMin(km));   // 照計畫配速跑過去還剩幾分
                if (left > 0 && dist > 0.3 && marPlan < 2) { key = "cut" + nc; say = "關門吃緊，" + C.cutName[nc] + "還有" + (int) left + "分鐘，請加快"; pat = new long[]{0, 400, 200, 400}; }
            }
            if (key.isEmpty()) for (int i = 0; i < C.gelK.length; i++) {
                double d = C.gelK[i] * 1000 - curS;
                if (d > -80 && d < 250 && !C.gelT[i].equals("備用")) { key = "gel" + i; say = C.gelAt[i] + "號水站，站內走路吃" + C.gelT[i].replace("#", "第") + "包能量膠，配水吞下"; pat = new long[]{0, 200, 100, 200}; break; }
            }
            if (key.isEmpty()) for (int i = 0; i < C.aidKm.length; i++) {
                double d = C.aidKm[i] * 1000 - curS;
                if (d > -60 && d < 200) { key = "aid" + C.aidN[i]; say = "前方水站" + C.aidN[i] + "號，有" + C.aidSay[i] + "，靠邊減速"; pat = new long[]{0, 150}; break; }
            }
        }
        if (!key.isEmpty() && !key.equals(lastAlert)) { buzz(pat); speak(say, key.startsWith("off")); lastAlert = key; lastAlertAt = now; updateNotif(); lastNotif = now; }
        if (key.isEmpty() && now - lastAlertAt > 60000) lastAlert = "";
    }

    void buzz(long[] pat) { if (pref.getBoolean("vib", true) && vib != null && pat != null) try { vib.vibrate(VibrationEffect.createWaveform(pat, -1)); } catch (Exception ignored) { } }
    /** urgent＝插隊（離開路線、完賽）；其他一律排隊，不會把正在講的話切掉 */
    void speak(String s, boolean urgent) { s = s.replaceAll("（.*?）", "").replaceAll("(\\d{1,2}):(\\d{2})", "$1點$2分"); if (pref.getBoolean("tts", true) && ttsReady) tts.speak(s, urgent ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD, null, "k" + System.nanoTime()); }

    // ---------- 狀態 JSON（給畫面） ----------
    String state() {
        long now = System.currentTimeMillis();
        try {
            JSONObject o = new JSONObject();
            if (rs == null || T == null) return o.put("running", running).toString();
            long st = rs.getLong("start", 0);
            String fin = rs.getString("finished", "");
            o.put("race", raceId).put("s", T.curS).put("acc", acc).put("dev", T.dev).put("fixAge", lastFix == 0 ? -1 : (now - lastFix) / 1000)
             .put("pace", T.paceSec(now, lastFix)).put("start", st > 0 && Math.abs(now - st) < 20 * 3600_000L ? st : 0).put("splits", new JSONObject(rs.getString("splits", "{}")))
             .put("running", running).put("fix", T.hasHist).put("off", T.off).put("sats", satsUsed).put("satsSeen", satsSeen)
             .put("anyFixAge", lastAnyFix == 0 ? -1 : (now - lastAnyFix) / 1000)
             .put("gpsOn", lm.isProviderEnabled(LocationManager.GPS_PROVIDER));
            if (!fin.isEmpty()) o.put("finished", new JSONObject(fin));
            return o.toString();
        } catch (JSONException e) { return "{}"; }
    }
    void push(String json) { Listener l = listener; if (l != null) l.onState(json); }

    // ---------- 通知列（鎖屏可見）----------
    Notification buildNotif(String title, String text, String big, Bitmap[] strips) {
        Intent i = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE);
        PendingIntent ps = PendingIntent.getService(this, 1, new Intent(this, GpsService.class).setAction(ACT_STOP), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent pt = PendingIntent.getService(this, 2, new Intent(this, GpsService.class).setAction(ACT_TIMER), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder nb = new Notification.Builder(this, CH).setSmallIcon(R.drawable.ic_notif).setContentTitle(title).setContentText(text)
            .setOngoing(true).setOnlyAlertOnce(true).setContentIntent(pi).setCategory(Notification.CATEGORY_NAVIGATION)
            .setVisibility(Notification.VISIBILITY_PUBLIC).setShowWhen(false);
        if (!finished) nb.addAction(new Notification.Action.Builder(null, "我過線了", pt).build());
        nb.addAction(new Notification.Action.Builder(null, "停止定位", ps).build());
        if (strips != null) {
            RemoteViews small = new RemoteViews(getPackageName(), R.layout.notif_small);
            small.setTextViewText(R.id.nTitle, title); small.setTextViewText(R.id.nText, text); small.setImageViewBitmap(R.id.nStrip, strips[0]);
            RemoteViews large = new RemoteViews(getPackageName(), R.layout.notif_big);
            large.setTextViewText(R.id.nTitle, title); large.setTextViewText(R.id.nText, text); large.setTextViewText(R.id.nBig, big); large.setImageViewBitmap(R.id.nStrip, strips[1]);
            nb.setStyle(new Notification.DecoratedCustomViewStyle()).setCustomContentView(small).setCustomBigContentView(large);
        }
        return nb.build();
    }
    void updateNotif() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        String tag = C.shortName.isEmpty() ? "" : C.shortName + "｜";
        if (finished) {
            String f = rs.getString("finished", ""); String txt = "定位即將停止";
            try { JSONObject o = new JSONObject(f); if (o.has("t")) txt = "淨時間 " + hms(o.getLong("t")) + "｜" + txt; } catch (Exception ignored) { }
            nm.notify(1, buildNotif(tag + "完賽！", txt, null, null)); return;
        }
        if (T == null || T.off) { nm.notify(1, buildNotif(tag + "不在賽道上", "距賽道 " + dist(T == null ? 0 : T.dev) + "｜GPS ±" + (int) acc + " m", null, null)); return; }
        if (!T.hasHist || !C.ok) { nm.notify(1, buildNotif(tag + "搜尋 GPS… 衛星 " + satsUsed + "/" + satsSeen, "到空曠處，通常 30–60 秒", null, null)); return; }
        double curS = T.curS, km = curS / 1000, emin = elapsedMin(), gm = gunMin(); int si = C.secIndex(km);
        String title, text, big;
        String sec = "區段 " + (si + 1) + "｜" + Course.shortName(C.secFrom[si]) + " → " + Course.shortName(C.secTo[si]);
        long planB = baseStart() + (long) (C.planMin(C.secB[si]) * 60000), dlB = C.gun + (long) (C.deadlineMin(C.secB[si]) * 60000);
        long nowMs = System.currentTimeMillis();
        if (emin >= 0) {
            double d = C.planMin(km) - emin;
            title = String.format(Locale.ROOT, "%.1fK", km) + "｜" + (d >= 0 ? "快 " : "慢 ") + mmss((int) Math.round(Math.abs(d) * 60));
            int nc = C.nextCut(km);
            if (nc >= 0 && gm >= 0) {
                double ps = T.paceSec(nowMs, lastFix), pace = ps > 0 ? ps / 60 : C.planPace(km);
                double mar = C.cutMin[nc] - (gm + (C.cutKm[nc] - km) * pace);
                title += "｜關門餘裕 " + (mar >= 0 ? (int) Math.floor(mar) + " 分" : "不足");
            }
            double ps = T.paceSec(nowMs, lastFix), pace = ps > 0 ? ps / 60 : C.paceBetween(km, C.secB[si]);
            long predB = baseStart() + (long) ((emin + (C.secB[si] - km) * pace) * 60000);
            text = "到 " + Course.shortName(C.secTo[si]) + "：計畫 " + C.clk(planB) + "｜預計 " + C.clk(predB) + "｜底線 " + C.clk(dlB);
        } else {
            title = String.format(Locale.ROOT, "%.1fK", km) + "｜尚未起跑";
            text = "到 " + Course.shortName(C.secTo[si]) + "：計畫 " + C.clk(planB) + "｜底線 " + C.clk(dlB);
        }
        double g = C.R.grade(curS);
        big = sec + "\n此刻 " + Route.gradeWord(g) + String.format(Locale.ROOT, " %+.0f%%", g) + "｜海拔 " + Math.round(C.R.elev(curS)) + " m\n👉 " + C.secAct[si];
        Bitmap[] strips = new Bitmap[]{Strip.draw(C, curS, emin, gm, false), Strip.draw(C, curS, emin, gm, true)};
        nm.notify(1, buildNotif(title, text, big, strips));
    }

    static String mmss(int sec) { return sec / 60 + ":" + (sec % 60 < 10 ? "0" : "") + sec % 60; }
    static String hms(long sec) { return sec / 3600 + ":" + Course.two(sec % 3600 / 60) + ":" + Course.two(sec % 60); }
    static String sayMS(double sec) { int s = (int) Math.round(Math.abs(sec)), m = s / 60; s %= 60; return (m > 0 ? m + "分" : "") + (s > 0 || m == 0 ? s + "秒" : ""); }
    static String sayHMS(double sec) { int s = (int) Math.round(Math.abs(sec)), hh = s / 3600, m = s % 3600 / 60; return (hh > 0 ? hh + "小時" : "") + m + "分" + (s % 60) + "秒"; }
    static String dist(double m) { return m >= 1000 ? String.format(Locale.ROOT, "%.1fK", m / 1000) : (int) (Math.round(m / 10) * 10) + " m"; }

    static void start(Context c, String raceId) { c.startForegroundService(new Intent(c, GpsService.class).setAction(ACT_START).putExtra(EXTRA_RACE, raceId)); }
    static void stop(Context c) { c.startService(new Intent(c, GpsService.class).setAction(ACT_STOP)); }
    static void finishNow(Context c) { if (running) c.startService(new Intent(c, GpsService.class).setAction(ACT_FINISH)); }
}
