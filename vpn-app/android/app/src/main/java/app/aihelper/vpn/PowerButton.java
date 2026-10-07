package app.aihelper.vpn;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.view.View;
import android.view.animation.LinearInterpolator;

/** The big round on/off button: calm when off, amber with a running arc while it connects, green with waves when on. */
final class PowerButton extends View {
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint icon = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint spin = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint wave = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF box = new RectF();
    private final boolean dark;
    private State.Phase phase = State.Phase.OFF;
    private boolean enabledLook = true;
    private float angle, glow;
    private ValueAnimator anim;

    PowerButton(Context c, boolean dark) {
        super(c);
        this.dark = dark;
        icon.setStyle(Paint.Style.STROKE);
        icon.setStrokeCap(Paint.Cap.ROUND);
        spin.setStyle(Paint.Style.STROKE);
        spin.setStrokeCap(Paint.Cap.ROUND);
        ring.setStyle(Paint.Style.FILL);
        wave.setStyle(Paint.Style.STROKE);
        setLayerType(LAYER_TYPE_SOFTWARE, null);  // the shadow under the button needs it
        setClickable(true);
        setFocusable(true);
        setContentDescription("Включить или выключить VPN");
    }

    void show(State.Phase p, boolean usable) {
        if (p == phase && usable == enabledLook) return;
        phase = p;
        enabledLook = usable;
        boolean moving = p == State.Phase.CONNECTING || p == State.Phase.RETRYING || p == State.Phase.ON;
        if (moving && anim == null) {
            anim = ValueAnimator.ofFloat(0f, 1f);
            anim.setDuration(2200);
            anim.setRepeatCount(ValueAnimator.INFINITE);
            anim.setInterpolator(new LinearInterpolator());
            anim.addUpdateListener(a -> {
                float f = (float) a.getAnimatedValue();
                angle = f * 360f;
                glow = (float) (0.5 + 0.5 * Math.sin(f * 2 * Math.PI));
                invalidate();
            });
            anim.start();
        } else if (!moving && anim != null) {
            anim.cancel();
            anim = null;
        }
        invalidate();
    }

    @Override
    protected void onDetachedFromWindow() {
        if (anim != null) anim.cancel();
        anim = null;
        super.onDetachedFromWindow();
    }

    @Override
    protected void onMeasure(int w, int h) {
        int size = Math.min(MeasureSpec.getSize(w), dp(230));
        setMeasuredDimension(size, size);
    }

    @Override
    protected void onDraw(Canvas c) {
        float cx = getWidth() / 2f, cy = getHeight() / 2f, r = Math.min(cx, cy);
        float inner = r * 0.74f;
        int top, bottom, glowColor, iconColor;
        switch (phase) {
            case ON:
                top = 0xFF34D399; bottom = 0xFF059669; glowColor = 0x3334D399; iconColor = 0xFFFFFFFF;
                break;
            case CONNECTING:
            case RETRYING:
                top = 0xFFFBBF24; bottom = 0xFFD97706; glowColor = 0x33FBBF24; iconColor = 0xFFFFFFFF;
                break;
            default:
                top = dark ? 0xFF2A3341 : 0xFFFFFFFF;
                bottom = dark ? 0xFF1C232E : 0xFFE9ECF3;
                glowColor = dark ? 0x14FFFFFF : 0x0F1F2937;
                iconColor = enabledLook ? (dark ? 0xFFCBD5E1 : 0xFF64748B) : (dark ? 0xFF475569 : 0xFFCBD5E1);
        }
        // protected: two waves leave the button, one after the other
        if (phase == State.Phase.ON) {
            for (int i = 0; i < 2; i++) {
                float f = (angle / 360f + i * 0.5f) % 1f;
                wave.setColor(0x34D399 | ((int) (0x90 * (1 - f)) << 24));
                wave.setStrokeWidth(r * 0.025f * (1.4f - f));
                c.drawCircle(cx, cy, inner + (r - inner) * 0.2f + (r * 0.98f - inner) * f, wave);
            }
        }
        // a soft halo; it breathes while connected or connecting
        float halo = phase == State.Phase.OFF ? r * 0.9f : r * (0.86f + 0.1f * glow);
        ring.setColor(glowColor);
        c.drawCircle(cx, cy, halo, ring);
        ring.setColor(phase == State.Phase.OFF ? glowColor : (glowColor & 0x00FFFFFF) | 0x55000000);
        c.drawCircle(cx, cy, inner + r * 0.06f, ring);
        fill.setShader(new LinearGradient(cx, cy - inner, cx, cy + inner, top, bottom, Shader.TileMode.CLAMP));
        fill.setShadowLayer(dp(10), 0, dp(4), phase == State.Phase.OFF ? 0x22000000 : 0x33000000);
        c.drawCircle(cx, cy, inner, fill);
        // the power sign
        float ir = inner * 0.36f;
        icon.setColor(iconColor);
        icon.setStrokeWidth(inner * 0.085f);
        box.set(cx - ir, cy - ir + inner * 0.04f, cx + ir, cy + ir + inner * 0.04f);
        c.drawArc(box, -60, 300, false, icon);
        c.drawLine(cx, cy - ir * 1.25f, cx, cy - ir * 0.15f, icon);
        // a running arc while it connects
        if (phase == State.Phase.CONNECTING || phase == State.Phase.RETRYING) {
            spin.setColor(0xFFFBBF24);
            spin.setStrokeWidth(r * 0.05f);
            float sr = inner + r * 0.13f;
            box.set(cx - sr, cy - sr, cx + sr, cy + sr);
            c.drawArc(box, angle, 80, false, spin);
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
