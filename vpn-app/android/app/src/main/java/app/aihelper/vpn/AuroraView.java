package app.aihelper.vpn;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BlurMaskFilter;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.RectF;
import android.graphics.Shader;
import android.os.Build;
import android.view.View;

/**
 * The sky over the screen (B «Северное сияние», the same sky as the AI helper's): three soft curtains of light across the
 * top with fine rays in the middle one, and a few stars at night. It never moves (DESIGN.md, «the still sky»); only its
 * colours follow the VPN, fading over: a calm blue-violet sky when off, amber while connecting, the green of «защищено»
 * when on. Drawn once per state into a picture (half size: it is soft anyway).
 */
final class AuroraView extends View {
    // the curtains, in the mock-up's own 1280×320 sky (slices to the screen, its top kept)
    private static final String VIOLET = "M-40 70C260 10 420 120 700 60S1100 0 1320 50L1320 150C1080 110 880 170 700 150S240 110 -40 170Z";
    private static final String GREEN = "M-40 140C180 60 360 180 600 110S1020 30 1320 110L1320 230C1060 170 860 250 600 220S180 190 -40 260Z";
    private static final String CYAN = "M200 120C420 80 600 150 820 100S1100 80 1320 130L1320 200C1100 170 900 220 760 190S420 170 200 200Z";
    private static final String RAYS = "M-40 130C180 50 360 170 600 100S1020 20 1320 100L1320 210C1060 160 860 240 600 210S180 180 -40 250Z";
    private static final float[][] STARS = {{90, 40, 1.2f}, {310, 24, 1}, {760, 20, 1}, {980, 38, 1.2f},
            {1180, 22, 1}, {1240, 70, 1.1f}, {40, 96, 1}};
    // each state's three lights (the top one, the middle band, the lower one) and how strong each is; by day (the helper's
    // «dawn haze») the top light is rose and the lower one sky blue
    private static final int[] ON = {0xFF8B7CF6, 0xFF34D399, 0xFF22D3EE}, ON_DAY = {0xFFF9A8D4, 0xFF34D399, 0xFF7DD3FC};
    private static final int[] OFF = {0xFF8B7CF6, 0xFF5B6CF0, 0xFF22D3EE}, OFF_DAY = {0xFFF9A8D4, 0xFF818CF8, 0xFF7DD3FC};
    private static final int[] WAIT = {0xFF8B7CF6, 0xFFFFC560, 0xFFFF9E7A}, WAIT_DAY = {0xFFFBC2A8, 0xFFFFC560, 0xFF7DD3FC};
    private static final float[] ON_A = {0.55f, 0.8f, 0.6f}, OFF_A = {0.45f, 0.5f, 0.32f}, WAIT_A = {0.45f, 0.7f, 0.3f};

    private final boolean dark;
    private final boolean wide;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
    private final Paint star = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF to = new RectF();
    private State.Phase phase = State.Phase.OFF;
    private Bitmap sky, was;
    private float blend = 1f;
    private ValueAnimator fade;

    AuroraView(Context c, boolean dark, boolean wide) {
        super(c);
        this.dark = dark;
        this.wide = wide;
        star.setColor(0xB3FFFFFF);
    }

    void show(State.Phase p) {
        State.Phase look = p == State.Phase.RETRYING ? State.Phase.CONNECTING : p;
        if (look == phase) return;
        phase = look;
        if (sky == null) return;  // not drawn yet: drawn in its state the first time
        if (was != null) was.recycle();
        was = sky;
        sky = null;
        if (fade != null) fade.cancel();
        blend = 0f;
        fade = ValueAnimator.ofFloat(0f, 1f).setDuration(animations() ? 900 : 0);
        fade.addUpdateListener(a -> {
            blend = (float) a.getAnimatedValue();
            invalidate();
        });
        fade.start();
    }

    private static boolean animations() {
        return Build.VERSION.SDK_INT < 26 || ValueAnimator.areAnimatorsEnabled();
    }

    @Override
    protected void onDetachedFromWindow() {
        if (fade != null) fade.cancel();
        super.onDetachedFromWindow();
    }

    @Override
    protected void onSizeChanged(int w, int h, int ow, int oh) {
        super.onSizeChanged(w, h, ow, oh);
        if (sky != null) sky.recycle();
        if (was != null) was.recycle();
        sky = was = null;
    }

    /** How tall the sky is: one band behind the top (DESIGN.md: 300–320 over Winger's screen), a little more on a tablet. */
    private int skyHeight() {
        float d = getResources().getDisplayMetrics().density;
        return Math.min(getHeight(), Math.round((wide ? 340 : 320) * d));
    }

    @Override
    protected void onDraw(Canvas c) {
        int w = getWidth(), h = skyHeight();
        if (w == 0 || h == 0) return;
        if (sky == null) sky = paint(w, h, phase);
        float d = getResources().getDisplayMetrics().density;
        to.set(0, 0, w, h);
        if (was != null && blend < 1f) {
            paint.setAlpha(Math.round(255 * (1f - blend)));
            c.drawBitmap(was, null, to, paint);
        }
        paint.setAlpha(Math.round(255 * blend));
        c.drawBitmap(sky, null, to, paint);
        if (blend >= 1f && was != null) {
            was.recycle();
            was = null;
        }
        if (dark) {  // the stars, sharp (not in the soft picture)
            float k = Math.max(w / 1280f, h / 320f), ox = (w - 1280 * k) / 2;
            for (float[] s : STARS) {
                float y = s[1] * k;
                if (y < h * 0.5f) c.drawCircle(ox + s[0] * k, y, Math.max(1f, s[2] * d * 0.9f), star);
            }
        }
    }

    /** The sky of one state, at half size. */
    private Bitmap paint(int w, int h, State.Phase p) {
        int bw = Math.max(1, w / 2), bh = Math.max(1, h / 2);
        Bitmap b = Bitmap.createBitmap(bw, bh, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(b);
        float k = Math.max(bw / 1280f, bh / 320f);
        Matrix m = new Matrix();
        m.setScale(k, k);
        m.postTranslate((bw - 1280 * k) / 2, 0);
        int[] col = p == State.Phase.ON ? (dark ? ON : ON_DAY) : p == State.Phase.OFF ? (dark ? OFF : OFF_DAY) : (dark ? WAIT : WAIT_DAY);
        float[] al = p == State.Phase.ON ? ON_A : p == State.Phase.OFF ? OFF_A : WAIT_A;
        float strength = dark ? 0.8f : 0.65f;  // by day: paler
        Paint f = new Paint(Paint.ANTI_ALIAS_FLAG);
        f.setMaskFilter(new BlurMaskFilter(Math.max(1f, 28 * k), BlurMaskFilter.Blur.NORMAL));
        String[] curtains = {VIOLET, GREEN, CYAN};
        for (int i = 0; i < 3; i++) {
            Path path = path(curtains[i]);
            path.transform(m);
            band(f, path, col[i], al[i] * strength);
            c.drawPath(path, f);
        }
        // the rays: fine upright stripes of the middle light, softly blurred, inside its own curtain
        Path rays = path(RAYS);
        rays.transform(m);
        c.save();
        c.clipPath(rays);
        Paint r = new Paint(Paint.ANTI_ALIAS_FLAG);
        r.setMaskFilter(new BlurMaskFilter(Math.max(1f, 8 * k), BlurMaskFilter.Blur.NORMAL));
        band(r, rays, col[1], al[1] * 0.28f * (dark ? 1f : 0.6f));
        float[][] stripes = {{0, 2, 1f}, {7, 4, 0.5f}, {17, 1.5f, 0.8f}, {26, 5, 0.35f}};
        float x0 = (bw - 1280 * k) / 2;
        for (float x = -40; x < 1320; x += 37) {
            for (float[] s : stripes) {
                r.setAlpha(Math.round(255 * s[2]));
                float left = x0 + (x + s[0]) * k;
                c.drawRect(left, 0, left + Math.max(1f, s[1] * k), bh, r);
            }
        }
        c.restore();
        // the sky fades out downwards (whole until a third, gone near its bottom)
        Paint fadeOut = new Paint();
        fadeOut.setShader(new LinearGradient(0, 0.3f * 320 * k, 0, 0.95f * 320 * k, 0xFFFFFFFF, 0x00FFFFFF, Shader.TileMode.CLAMP));
        fadeOut.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.DST_IN));
        c.drawRect(0, 0, bw, bh, fadeOut);
        return b;
    }

    /** A curtain's light: clear at its top and bottom, strongest a little above its middle. */
    private static void band(Paint p, Path path, int color, float a) {
        RectF r = new RectF();
        path.computeBounds(r, true);
        int rgb = color & 0x00FFFFFF, peak = rgb | (Math.round(255 * Math.min(1f, a)) << 24);
        p.setShader(new LinearGradient(0, r.top, 0, r.bottom, new int[]{rgb, peak, rgb}, new float[]{0f, 0.42f, 1f},
                Shader.TileMode.CLAMP));
    }

    /** The few path commands the curtains use (M, L, C, S, Z, absolute), as in SVG. */
    static Path path(String d) {
        Path p = new Path();
        String[] tok = d.replaceAll("([MLCSZ])", " $1 ").replaceAll("(\\d)-", "$1 -").trim().split("[\\s,]+");
        char cmd = 'M';
        float x = 0, y = 0, cx2 = 0, cy2 = 0;
        int i = 0;
        while (i < tok.length) {
            String s = tok[i];
            if (s.length() == 1 && Character.isLetter(s.charAt(0))) {
                cmd = s.charAt(0);
                i++;
                if (cmd == 'Z') {
                    p.close();
                    continue;
                }
            }
            switch (cmd) {
                case 'M':
                    x = Float.parseFloat(tok[i++]);
                    y = Float.parseFloat(tok[i++]);
                    p.moveTo(x, y);
                    cx2 = x;
                    cy2 = y;
                    cmd = 'L';
                    break;
                case 'L':
                    x = Float.parseFloat(tok[i++]);
                    y = Float.parseFloat(tok[i++]);
                    p.lineTo(x, y);
                    cx2 = x;
                    cy2 = y;
                    break;
                case 'C': {
                    float x1 = Float.parseFloat(tok[i++]), y1 = Float.parseFloat(tok[i++]);
                    cx2 = Float.parseFloat(tok[i++]);
                    cy2 = Float.parseFloat(tok[i++]);
                    x = Float.parseFloat(tok[i++]);
                    y = Float.parseFloat(tok[i++]);
                    p.cubicTo(x1, y1, cx2, cy2, x, y);
                    break;
                }
                case 'S': {
                    float x1 = 2 * x - cx2, y1 = 2 * y - cy2;
                    cx2 = Float.parseFloat(tok[i++]);
                    cy2 = Float.parseFloat(tok[i++]);
                    x = Float.parseFloat(tok[i++]);
                    y = Float.parseFloat(tok[i++]);
                    p.cubicTo(x1, y1, cx2, cy2, x, y);
                    break;
                }
                default:
                    i++;
            }
        }
        return p;
    }
}
