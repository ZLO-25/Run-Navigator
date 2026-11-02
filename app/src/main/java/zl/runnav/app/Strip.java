package zl.runnav.app;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.DashPathEffect;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;

/**
 * 通知列（鎖屏）上的「區段對照線」：A 點 → B 點的地形，標出 你●、計畫的你▲、關門線┆。
 * 跟 App 首頁那條線是同一個東西，鎖屏點亮螢幕就能看。自帶深色底，亮暗主題都看得清楚。
 */
final class Strip {
    static final int BG = 0xFF161C1F, FG = 0xFFF4F6F5, SUB = 0xFF9FB0B6, BAD = 0xFFFF6B5E, PLAN = 0xFFC9A7FF, AID = 0xFF5AB8FF, OK = 0xFF3DDC97;

    static int gradeColor(double g) {
        return g >= 7 ? 0xFFFF5F52 : g >= 4 ? 0xFFF58A6E : g >= 2 ? 0xFFA9605A : g <= -7 ? 0xFF7DC0FF : g <= -4 ? 0xFF4A9BF0 : g <= -2 ? 0xFF4F7FAE : 0xFF4B575C;
    }

    /** big=true：有地形剖面與 A/B 文字；false：只有一條細線（摺疊的通知） */
    static Bitmap draw(Course c, double sM, double elMin, double gm, boolean big) {
        int W = 1000, H = big ? 250 : 96;
        Bitmap bm = Bitmap.createBitmap(W, H, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(bm);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(BG); cv.drawRoundRect(new RectF(0, 0, W, H), 22, 22, p);
        int si = c.secIndex(sM / 1000); if (si < 0) return bm;
        double k0 = c.secA[si], k1 = c.secB[si];
        float padL = 24, padR = 24, top = big ? 52 : 34, base = big ? H - 58 : H - 26;
        float span = W - padL - padR;
        java.util.function.DoubleUnaryOperator X = k -> padL + (k - k0) / (k1 - k0) * span;

        if (big) {   // 地形剖面
            double mn = 1e9, mx = -1e9; for (double m = k0 * 1000; m <= k1 * 1000; m += 20) { double e = c.R.elev3(m); mn = Math.min(mn, e); mx = Math.max(mx, e); }
            double rng = Math.max(14, mx - mn), lo = mn - rng * 0.15, hi = lo + rng * 1.3;
            double stp = Math.max(10, (k1 - k0) * 1000 / span * 2);
            for (double m = k0 * 1000; m < k1 * 1000; m += stp) {
                float x = (float) X.applyAsDouble(m / 1000), x2 = (float) X.applyAsDouble(Math.min(k1, (m + stp) / 1000));
                float y = (float) (top + (1 - (c.R.elev3(m) - lo) / (hi - lo)) * (base - top));
                p.setColor(gradeColor(c.R.grade(m))); cv.drawRect(x, y, x2 + 0.8f, base, p);
            }
        } else { p.setColor(0xFF28323A); cv.drawRect(padL, base - 7, W - padR, base + 7, p); }
        // 水站
        p.setColor(AID);
        for (double k : c.aidKm) if (k > k0 && k < k1) cv.drawCircle((float) X.applyAsDouble(k), base - (big ? 12 : 0), big ? 9 : 7, p);
        // A / B
        p.setTextSize(big ? 30 : 0);
        if (big) {
            p.setColor(SUB); p.setFakeBoldText(true);
            String a = "A " + trim(c.secA[si]) + "K " + Course.shortName(c.secFrom[si]), b = Course.shortName(c.secTo[si]) + " " + trim(c.secB[si]) + "K B";
            p.setTextAlign(Paint.Align.RIGHT); cv.drawText(b, W - padR, H - 16, p);
            float room = span - p.measureText(b) - 20; p.setTextAlign(Paint.Align.LEFT);
            while (a.length() > 6 && p.measureText(a) > room) a = a.substring(0, a.length() - 2) + "…";
            cv.drawText(a, padL, H - 16, p);
        }
        p.setTextSize(big ? 28 : 24); p.setFakeBoldText(true);
        float yCut = big ? 26 : 22, yPlan = big ? 26 : 22;
        // 關門線
        if (gm > 0) {
            double ck = c.cutLineKm(gm);
            if (ck >= k0 && ck <= k1) {
                float x = (float) X.applyAsDouble(ck);
                Paint d = new Paint(Paint.ANTI_ALIAS_FLAG); d.setColor(BAD); d.setStrokeWidth(5); d.setStyle(Paint.Style.STROKE); d.setPathEffect(new DashPathEffect(new float[]{12, 9}, 0));
                cv.drawLine(x, top - 6, x, base + 8, d);
                p.setColor(BAD); p.setTextAlign(x > W - 140 ? Paint.Align.RIGHT : Paint.Align.LEFT); cv.drawText("關門線", x + (x > W - 140 ? -8 : 8), yCut + 8, p);
            } else edge(cv, p, ck < k0, BAD, "關門線" + (ck < k0 ? "後方 " : "前方 ") + trim1(Math.abs(ck - sM / 1000)) + "K", yCut + 8, W, padL, padR);
            yPlan = big ? 60 : 22;
        }
        // 計畫的你
        if (elMin >= 0) {
            double pk = c.planKm(elMin);
            if (pk >= k0 && pk <= k1) {
                float x = (float) X.applyAsDouble(pk), y = big ? (float) yAt(c, pk * 1000, k0, k1, top, base) : base;
                p.setColor(PLAN); Path t = new Path(); t.moveTo(x, y - 6); t.lineTo(x - 14, y - 30); t.lineTo(x + 14, y - 30); t.close(); cv.drawPath(t, p);
            } else if (!big || gm <= 0 || Math.abs(pk - c.cutLineKm(gm)) > 0.01) {
                if (big) edge(cv, p, pk < k0, PLAN, "計畫" + (pk < k0 ? "後方 " : "前方 ") + trim1(Math.abs(pk - sM / 1000)) + "K", yPlan + 8, W, padL, padR);
            }
        }
        // 你
        float x = (float) X.applyAsDouble(sM / 1000), y = big ? (float) yAt(c, sM, k0, k1, top, base) : base;
        p.setColor(BG); cv.drawCircle(x, y, big ? 17 : 15, p);
        p.setColor(FG); cv.drawCircle(x, y, big ? 12 : 11, p);
        return bm;
    }
    private static double yAt(Course c, double s, double k0, double k1, float top, float base) {
        double mn = 1e9, mx = -1e9; for (double m = k0 * 1000; m <= k1 * 1000; m += 20) { double e = c.R.elev3(m); mn = Math.min(mn, e); mx = Math.max(mx, e); }
        double rng = Math.max(14, mx - mn), lo = mn - rng * 0.15, hi = lo + rng * 1.3;
        return top + (1 - (c.R.elev3(s) - lo) / (hi - lo)) * (base - top);
    }
    private static void edge(Canvas cv, Paint p, boolean left, int color, String txt, float y, int W, float padL, float padR) {
        p.setColor(color); p.setTextAlign(left ? Paint.Align.LEFT : Paint.Align.RIGHT);
        cv.drawText(left ? "◀ " + txt : txt + " ▶", left ? padL : W - padR, y, p);
    }
    static String trim(double v) { return Math.abs(v - Math.round(v)) < 1e-6 ? String.valueOf((long) Math.round(v)) : String.valueOf(v); }
    static String trim1(double v) { return String.format(java.util.Locale.ROOT, "%.1f", v); }
}
