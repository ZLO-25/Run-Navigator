package zl.runnav.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

/** 畫面外殼：WebView 載入 assets/index.html（先出現賽事清單），透過 Android 橋接取得服務狀態。 */
public class MainActivity extends Activity {
    private WebView web;
    private SharedPreferences sp;
    private static final int REQ_LOC = 1, REQ_NOTIF = 2;
    private boolean pendingStart = false;
    private String pendingRace = "";

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        sp = getSharedPreferences("pref", MODE_PRIVATE);   // 個人偏好（全 App 共用）
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setAllowFileAccess(true);
        s.setTextZoom(100); s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.setBackgroundColor(0xFF0B0F11);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, String url) {
                if (url.startsWith("file:")) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) { }
                return true;
            }
        });
        web.addJavascriptInterface(new Bridge(), "Android");
        web.loadUrl("file:///android_asset/index.html");
        setContentView(web);
    }

    @Override protected void onResume() {
        super.onResume();
        GpsService.listener = json -> runOnUiThread(() -> web.evaluateJavascript("window.onNativeState&&window.onNativeState(" + json + ")", null));
        applyKeepOn();
    }
    @Override protected void onPause() { super.onPause(); GpsService.listener = null; }

    void applyKeepOn() {
        if (sp.getBoolean("keepOn", false)) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    // ---------- 權限流程：定位 → 通知 → 啟動服務 ----------
    void startRace(String id) {
        pendingRace = id;
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            pendingStart = true;
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOC);
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            pendingStart = true; requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF); return;
        }
        pendingStart = false;
        GpsService.start(this, pendingRace);
        askIgnoreBattery();
    }
    @Override public void onRequestPermissionsResult(int req, String[] p, int[] r) {
        super.onRequestPermissionsResult(req, p, r);
        if (req == REQ_LOC) {
            if (r.length > 0 && r[0] == PackageManager.PERMISSION_GRANTED) { if (pendingStart) startRace(pendingRace); }
            else web.evaluateJavascript("window.onNativeState&&window.onNativeState({err:'noperm'})", null);
        } else if (req == REQ_NOTIF && pendingStart) { pendingStart = false; GpsService.start(this, pendingRace); askIgnoreBattery(); }
    }
    void askIgnoreBattery() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (!pm.isIgnoringBatteryOptimizations(getPackageName()) && !sp.getBoolean("askedBat", false)) {
                sp.edit().putBoolean("askedBat", true).apply();
                startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
            }
        } catch (Exception ignored) { }
    }

    /** JS 可呼叫的介面。個人偏好存 pref（全 App 共用），賽事參數與紀錄存 race_<id>（每場各一格）。 */
    static final java.util.Set<String> SHARED = new java.util.HashSet<>(java.util.Arrays.asList("name", "vib", "tts", "kmv", "stopv", "keepOn", "theme", "win"));
    static final java.util.Set<String> BOOLS = new java.util.HashSet<>(java.util.Arrays.asList("vib", "tts", "kmv", "stopv", "keepOn"));
    SharedPreferences race(String id) { return GpsService.racePrefs(this, id); }
    class Bridge {
        /** 開始定位這一場。另一場正在定位時不會啟動，回傳那一場的 id（畫面會先請你停止它）。 */
        @JavascriptInterface public String start(String id) {
            String act = activeRace();
            if (!act.isEmpty() && !act.equals(id)) return act;
            runOnUiThread(() -> startRace(id)); return "";
        }
        @JavascriptInterface public void stop() { GpsService.stop(MainActivity.this); }
        @JavascriptInterface public boolean isRunning() { return GpsService.running; }
        /** 正在定位的是哪一場（沒有就是空字串） */
        @JavascriptInterface public String activeRace() { return GpsService.running ? sp.getString("active", "") : ""; }
        @JavascriptInterface public String getPrefs(String id) {
            try {
                SharedPreferences r = race(id);
                JSONObject o = new JSONObject().put("vib", sp.getBoolean("vib", true)).put("tts", sp.getBoolean("tts", true))
                    .put("kmv", sp.getBoolean("kmv", true)).put("stopv", sp.getBoolean("stopv", true))
                    .put("keepOn", sp.getBoolean("keepOn", false)).put("name", sp.getString("name", "")).put("theme", sp.getString("theme", "")).put("win", sp.getString("win", ""))
                    .put("start", r.getLong("start", 0)).put("splits", new JSONObject(r.getString("splits", "{}")));
                if (r.contains("target")) o.put("target", r.getInt("target", 0));
                if (r.contains("delay")) o.put("delay", r.getInt("delay", 0));
                String f = r.getString("finished", ""); if (!f.isEmpty()) o.put("finished", new JSONObject(f));
                return o.toString();
            } catch (Exception e) { return "{}"; }
        }
        @JavascriptInterface public void setPref(String id, String k, String v) {
            SharedPreferences.Editor e = SHARED.contains(k) ? sp.edit() : race(id).edit();
            if (v == null || v.equals("null")) e.remove(k);
            else switch (k) {
                case "target": case "delay": e.putInt(k, Integer.parseInt(v)); break;
                case "start": e.putLong(k, Long.parseLong(v)); break;
                default: if (BOOLS.contains(k)) e.putBoolean(k, "1".equals(v)); else e.putString(k, v);
            }
            e.apply();
            if ("keepOn".equals(k)) runOnUiThread(MainActivity.this::applyKeepOn);
        }
        /** 畫面算好的路線計畫（路線、區段、關門、水站、每點計畫分鐘），存進那一場自己的儲存格，背景服務用同一份 */
        @JavascriptInterface public void setCourse(String json) {
            try {
                String id = new JSONObject(json).getString("id");
                race(id).edit().putString("course", json).commit();
                if (id.equals(sp.getString("active", ""))) GpsService.courseDirty = true;
            } catch (Exception ignored) { }
        }
        @JavascriptInterface public void adjustStart(String id, long ms) { if (ms <= 0) race(id).edit().remove("start").apply(); else race(id).edit().putLong("start", ms).apply(); }
        @JavascriptInterface public void clearSplits(String id) { race(id).edit().remove("splits").apply(); }
        @JavascriptInterface public void setStart(String id, long ms) { if (ms <= 0) race(id).edit().remove("start").remove("splits").remove("finished").apply(); else race(id).edit().putLong("start", ms).remove("splits").remove("finished").apply(); }
        /** 「我完賽了」：正在定位這一場就交給背景服務記成績並停止；沒在定位就只記下 */
        @JavascriptInterface public void finish(String id, String json) {
            if (id.equals(activeRace())) GpsService.finishNow(MainActivity.this);
            else race(id).edit().putString("finished", json).apply();
        }
        @JavascriptInterface public void unfinish(String id) { race(id).edit().remove("finished").apply(); }
        @JavascriptInterface public void testVibrate() { try { android.os.Vibrator v = Build.VERSION.SDK_INT >= 31 ? ((android.os.VibratorManager) getSystemService(VIBRATOR_MANAGER_SERVICE)).getDefaultVibrator() : (android.os.Vibrator) getSystemService(VIBRATOR_SERVICE); v.vibrate(android.os.VibrationEffect.createWaveform(new long[]{0, 200, 100, 200}, -1)); } catch (Exception ignored) { } }
        @JavascriptInterface public void testSpeak() {
            runOnUiThread(() -> { final android.speech.tts.TextToSpeech[] t = new android.speech.tts.TextToSpeech[1];
                t[0] = new android.speech.tts.TextToSpeech(MainActivity.this, st -> { if (st == android.speech.tts.TextToSpeech.SUCCESS) { t[0].setLanguage(java.util.Locale.TAIWAN); t[0].speak("語音測試。18公里，比計畫快2分10秒。下一個關門餘裕35分鐘", android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "t"); } }); });
        }
        @JavascriptInterface public void copy(String text) { runOnUiThread(() -> { android.content.ClipboardManager cm = (android.content.ClipboardManager) getSystemService(CLIPBOARD_SERVICE); cm.setPrimaryClip(android.content.ClipData.newPlainText("splits", text)); }); }
        @JavascriptInterface public void openSettings() { try { startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))); } catch (Exception ignored) { } }
    }

    /** 返回鍵：在某一場賽事裡 → 回賽事清單；已在清單 → App 退到背景（定位照常） */
    @Override public void onBackPressed() {
        web.evaluateJavascript("window.onBack?window.onBack():false", r -> { if (!"true".equals(r)) moveTaskToBack(true); });
    }
}
