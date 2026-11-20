package zl.runnav.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;

import org.json.JSONObject;

/**
 * 節拍器前景服務（mediaPlayback）：鎖屏、切到背景或練習模式未開 GPS 時也不會被系統凍結。
 * 省電設計：
 *  1. 點擊波形預先合成快取，播放迴圈不做浮點三角／指數運算；
 *  2. AudioTrack 每次寫入整拍靜音尾段（每拍僅喚醒 ~3 次，而非每秒 43 次）；
 *  3. 純震動模式（snd="off"）不開 AudioTrack、關閉音訊 DSP 耗電；
 *  4. WakeLock 僅在打拍期間持有，停拍／倒數結束立即釋放並 stopSelf()。
 */
public class MetroService extends Service {
    static final String ACT_START = "metro_start", ACT_STOP = "metro_stop";
    static final String CH = "metro";
    static final int NOTIF_ID = 2;

    interface Listener { void onChanged(String json); }
    static volatile Listener listener;

    static volatile boolean running = false;
    static volatile int mBpm = 0, mAcc = 2, mGen = 0;
    static volatile String mSnd = "wood";
    static volatile boolean mVib = false;
    static volatile int mDurSec = 0;
    static volatile long mStartMono = 0, mStopMono = 0;
    static volatile long mBeatCount = 0;

    private PowerManager.WakeLock wl;
    private Vibrator vib;
    private Thread audioThread;

    @Override public void onCreate() {
        super.onCreate();
        vib = Build.VERSION.SDK_INT >= 31
            ? ((VibratorManager) getSystemService(VIBRATOR_MANAGER_SERVICE)).getDefaultVibrator()
            : (Vibrator) getSystemService(VIBRATOR_SERVICE);
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CH, "跑步節拍器", NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);
    }

    @Override public int onStartCommand(Intent in, int flags, int startId) {
        String act = in == null ? ACT_STOP : in.getAction();
        if (ACT_STOP.equals(act)) {
            stopState();
            stopSelf();
            return START_NOT_STICKY;
        }
        int bpm = in.getIntExtra("bpm", mBpm > 0 ? mBpm : 180);
        int acc = in.getIntExtra("acc", mAcc);
        String snd = in.getStringExtra("snd");
        if (snd == null) snd = mSnd;
        boolean vibOn = in.getBooleanExtra("vib", mVib);
        int remSec = in.getIntExtra("rem", 0);

        if (bpm <= 0 || ("off".equals(snd) && !vibOn)) {
            stopState();
            stopSelf();
            return START_NOT_STICKY;
        }

        boolean wasRunning;
        int myGen;
        synchronized (MetroService.class) {
            wasRunning = running && audioThread != null && audioThread.isAlive();
            mBpm = Math.max(120, Math.min(240, bpm));
            mAcc = Math.max(1, acc);
            mSnd = snd;
            mVib = vibOn;
            mDurSec = Math.max(0, remSec);
            long nowMono = SystemClock.elapsedRealtime();
            if (!wasRunning) {
                mStartMono = nowMono;
                mBeatCount = 0;
            }
            mStopMono = remSec > 0 ? nowMono + remSec * 1000L : 0;
            running = true;
            if (!wasRunning) {
                myGen = ++mGen;
            } else {
                myGen = mGen;
            }
        }

        Notification n = buildNotif();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(NOTIF_ID, n);

        if (!wasRunning) {
            acquireWake();
            startLoop(myGen);
        }
        notifyListener();
        return START_NOT_STICKY;
    }

    private void acquireWake() {
        try {
            if (wl == null) {
                PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "runnav:metro");
            }
            if (!wl.isHeld()) wl.acquire(6 * 3600_000L);
        } catch (Exception ignored) { }
    }

    private void releaseWake() {
        try { if (wl != null && wl.isHeld()) wl.release(); } catch (Exception ignored) { }
    }

    private static synchronized void stopState() {
        running = false;
        mBpm = 0;
        mStopMono = 0;
        mDurSec = 0;
        mGen++;
    }

    @Override public void onDestroy() {
        stopState();
        releaseWake();
        notifyListener();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private void startLoop(final int myGen) {
        audioThread = new Thread(() -> runLoop(myGen), "runnav-metro");
        audioThread.setPriority(Thread.MAX_PRIORITY);
        audioThread.start();
    }

    private void runLoop(final int myGen) {
        final int SR = 16000;
        AudioTrack at = null;
        String cachedSnd = "";
        short[] clickAccFull = null, clickNormFull = null;
        short[] clickAccDuck = null, clickNormDuck = null;
        short[] beatBuf = new short[SR]; // 足以容納最低 120 BPM (8000 samples) 的整拍緩衝
        double sampleErr = 0.0;
        long nextVibMono = SystemClock.elapsedRealtime();

        try {
            while (running && mGen == myGen && mBpm > 0) {
                long nowMono = SystemClock.elapsedRealtime();
                long sa = mStopMono;
                if (sa > 0 && nowMono >= sa) {
                    if (vib != null) {
                        try { vib.vibrate(VibrationEffect.createWaveform(new long[]{0, 300, 120, 300}, -1)); } catch (Exception ignored) { }
                    }
                    break;
                }

                int b = mBpm, a = mAcc;
                String s = mSnd;
                boolean vibOn = mVib;
                long beatIdx = mBeatCount;
                boolean isAcc = a > 1 && (beatIdx % a == 0);

                // 純震動模式（聲音＝關閉）：不建立 AudioTrack，直接單拍休眠震動最省電
                if ("off".equals(s)) {
                    if (at != null) {
                        try { at.stop(); at.release(); } catch (Exception ignored) { }
                        at = null;
                    }
                    if (!vibOn) break;
                    long wait = nextVibMono - SystemClock.elapsedRealtime();
                    if (wait > 0) {
                        try { Thread.sleep(Math.min(wait, 250)); } catch (InterruptedException ignored) { break; }
                        continue;
                    }
                    try { vib.vibrate(VibrationEffect.createOneShot(isAcc ? 25 : 15, isAcc ? 180 : 100)); } catch (Exception ignored) { }
                    mBeatCount = beatIdx + 1;
                    long stepMs = Math.round(60000.0 / b);
                    nextVibMono = Math.max(SystemClock.elapsedRealtime() + stepMs / 2, nextVibMono + stepMs);
                    continue;
                }

                // 聲音模式：延遲初始化 AudioTrack；若切換音效才重算短短 20 ms 點擊波形
                if (at == null) {
                    int minBuf = AudioTrack.getMinBufferSize(SR, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
                    at = new AudioTrack.Builder()
                        .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                        .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(SR).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                        .setBufferSizeInBytes(Math.max(minBuf, 4096))
                        .setTransferMode(AudioTrack.MODE_STREAM)
                        .build();
                    at.play();
                }

                if (!s.equals(cachedSnd)) {
                    cachedSnd = s;
                    clickAccFull = synthClick(SR, s, true, 1.0);
                    clickNormFull = synthClick(SR, s, false, 1.0);
                    clickAccDuck = synthClick(SR, s, true, 0.28);
                    clickNormDuck = synthClick(SR, s, false, 0.28);
                }

                if (vibOn && vib != null) {
                    try { vib.vibrate(VibrationEffect.createOneShot(isAcc ? 25 : 15, isAcc ? 180 : 100)); } catch (Exception ignored) { }
                }

                boolean duck = GpsService.ttsSpeaking;
                short[] clk = isAcc ? (duck ? clickAccDuck : clickAccFull) : (duck ? clickNormDuck : clickNormFull);

                double exactSamples = (SR * 60.0 / b) + sampleErr;
                int total = Math.max(1600, Math.min(beatBuf.length, (int) Math.floor(exactSamples)));
                sampleErr = exactSamples - total;

                int copyLen = Math.min(clk.length, total);
                System.arraycopy(clk, 0, beatBuf, 0, copyLen);
                java.util.Arrays.fill(beatBuf, copyLen, total, (short) 0);

                // 分段寫入整拍（最多 4096 samples = ~256 ms），兼顧省電少喚醒與 BPM 即時調整
                int pos = 0;
                while (pos < total && running && mGen == myGen && mBpm > 0 && !"off".equals(mSnd)) {
                    int n = Math.min(4096, total - pos);
                    int w = at.write(beatBuf, pos, n);
                    if (w < 0) break;
                    pos += Math.max(1, w);
                }
                mBeatCount = beatIdx + 1;
            }
        } catch (Exception ignored) {
        } finally {
            if (at != null) { try { at.stop(); at.release(); } catch (Exception ignored) { } }
            boolean stillSame;
            synchronized (MetroService.class) {
                stillSame = (mGen == myGen);
                if (stillSame) stopState();
            }
            releaseWake();
            if (stillSame) {
                notifyListener();
                stopSelf();
            }
        }
    }

    private static short[] synthClick(int sr, String s, boolean isAcc, double scale) {
        int len = "soft".equals(s) ? 240 : 340; // ~15-21 ms
        double freq = "beep".equals(s) ? (isAcc ? 1320.0 : 880.0) : "soft".equals(s) ? (isAcc ? 720.0 : 540.0) : (isAcc ? 1150.0 : 860.0);
        double decay = "beep".equals(s) ? 130.0 : "soft".equals(s) ? 65.0 : 76.0;
        double amp = (isAcc ? 0.95 : 0.68) * scale;
        short[] out = new short[len];
        for (int i = 0; i < len; i++) {
            double ph = 2.0 * Math.PI * freq * i / sr;
            double w = Math.sin(ph) + ("wood".equals(s) ? 0.32 * Math.sin(2.0 * ph) : 0.0);
            double env = Math.sin(Math.PI * Math.min(1.0, i / 18.0) * 0.5) * Math.exp(-i / decay);
            int v = (int) Math.round(w * env * amp * 24000);
            out[i] = (short) Math.max(-32767, Math.min(32767, v));
        }
        return out;
    }

    private Notification buildNotif() {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 10, open, PendingIntent.FLAG_IMMUTABLE);
        PendingIntent pStop = PendingIntent.getService(this, 11, new Intent(this, MetroService.class).setAction(ACT_STOP), PendingIntent.FLAG_IMMUTABLE);
        String zone = mBpm < 165 ? "輕鬆慢跑" : mBpm < 175 ? "穩定長跑" : mBpm <= 185 ? "標準步頻" : "高頻推進";
        String sndTxt = "off".equals(mSnd) ? "純震動" : ("beep".equals(mSnd) ? "電子音" : ("soft".equals(mSnd) ? "柔和" : "木魚"));
        String title = "跑步節拍器｜" + mBpm + " BPM（" + zone + "）";
        String text = sndTxt + (mVib ? "＋震動" : "") + (mDurSec > 0 ? "・倒數約 " + Math.max(1, (mDurSec + 59) / 60) + " 分" : "・鎖屏持續打拍中");
        return new Notification.Builder(this, CH)
            .setSmallIcon(R.drawable.ic_notif)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(pi)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(new Notification.Action.Builder(null, "停止節拍", pStop).build())
            .build();
    }

    static void notifyListener() {
        Listener l = listener;
        if (l != null) l.onChanged(stateJson());
    }

    static String stateJson() {
        try {
            boolean on = running && mBpm > 0;
            long now = SystemClock.elapsedRealtime();
            long elMs = on ? Math.max(0, now - mStartMono) : 0;
            int remSec = (on && mStopMono > 0) ? Math.max(0, (int) Math.ceil((mStopMono - now) / 1000.0)) : 0;
            return new JSONObject()
                .put("on", on)
                .put("bpm", mBpm > 0 ? mBpm : 180)
                .put("acc", mAcc)
                .put("snd", mSnd)
                .put("vib", mVib)
                .put("beat", mBeatCount)
                .put("elapsedMs", elMs)
                .put("remSec", remSec)
                .toString();
        } catch (Exception e) {
            return "{\"on\":false}";
        }
    }

    static void startOrUpdate(Context c, int bpm, int acc, String snd, boolean vibOn, int remainSec) {
        if (bpm <= 0 || ("off".equals(snd) && !vibOn)) { stop(c); return; }
        Intent i = new Intent(c, MetroService.class).setAction(ACT_START)
            .putExtra("bpm", bpm).putExtra("acc", acc).putExtra("snd", snd == null ? "wood" : snd)
            .putExtra("vib", vibOn).putExtra("rem", Math.max(0, remainSec));
        c.startForegroundService(i);
    }

    static void stop(Context c) {
        if (!running) { stopState(); notifyListener(); return; }
        try { c.startService(new Intent(c, MetroService.class).setAction(ACT_STOP)); }
        catch (Exception ignored) { stopState(); notifyListener(); }
    }
}
