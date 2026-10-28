package app.aihelper.vpn;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.os.Build;
import android.view.View;
import android.view.animation.LinearInterpolator;

/**
 * The big round on/off button (B «Северное сияние», the same object as the helper's listening orb, DESIGN.md): a round
 * in the one «включено» colour with two quiet rings around it when protected, amber with a running arc while it connects
 * (the only thing that moves), and when off a calm but clearly pressable round (its own surface, a firm edge, a bright
 * sign).
 */
final class PowerButton extends View {
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint edge = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint icon = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint spin = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF box = new RectF();
    private final boolean dark;
    private final int on, onInk, onRing, amber, amberInk, offFill, offEdge, offIcon;
    private State.Phase phase = State.Phase.OFF;
    private boolean usable = true;
    private float angle;
    private ValueAnimator anim;

    PowerButton(Context c, boolean dark) {
        super(c);
        this.dark = dark;
        on = c.getColor(R.color.on);
        onInk = c.getColor(R.color.on_ink);
        onRing = c.getColor(R.color.on_text);  // the rings: the green, darker by day (as the helper's orb)
        amber = c.getColor(R.color.amber);
        amberInk = c.getColor(R.color.amber_ink);
        offFill = c.getColor(R.color.surf2);
        offEdge = c.getColor(R.color.line_strong);
        offIcon = c.getColor(R.color.text);
        icon.setStyle(Paint.Style.STROKE);
        icon.setStrokeCap(Paint.Cap.ROUND);
        spin.setStyle(Paint.Style.STROKE);
        spin.setStrokeCap(Paint.Cap.ROUND);
        ring.setStyle(Paint.Style.STROKE);
        edge.setStyle(Paint.Style.STROKE);
        setLayerType(LAYER_TYPE_SOFTWARE, null);  // the shadow under the button needs it
        setClickable(true);
        setFocusable(true);
        setContentDescription("Включить или выключить VPN");
    }

    void show(State.Phase p, boolean has) {
        if (p == phase && has == usable) return;
        phase = p;
        usable = has;
        boolean moving = (p == State.Phase.CONNECTING || p == State.Phase.RETRYING) && animations();
        if (moving && anim == null) {
            anim = ValueAnimator.ofFloat(0f, 1f);
            anim.setDuration(2400);
            anim.setRepeatCount(ValueAnimator.INFINITE);
            anim.setInterpolator(new LinearInterpolator());
            anim.addUpdateListener(a -> {
                float f = (float) a.getAnimatedValue();
                angle = f * 720f;  // the arc while connecting: two turns a loop
                invalidate();
            });
            anim.start();
            if (getWindowVisibility() != VISIBLE) anim.pause();  // Winger is behind other apps: it moves once seen
        } else if (!moving && anim != null) {
            anim.cancel();
            anim = null;
        }
        invalidate();
    }

    /** Android's «remove animations» (and the emulator test's off switch): the button stands still. */
    private static boolean animations() {
        return Build.VERSION.SDK_INT < 26 || ValueAnimator.areAnimatorsEnabled();
    }

    @Override
    protected void onWindowVisibilityChanged(int v) {
        super.onWindowVisibilityChanged(v);
        // not drawn while Winger is behind other apps or the screen is off: the battery is not spent on it
        if (anim != null) {
            if (v == VISIBLE) anim.resume();
            else anim.pause();
        }
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
        float orb = r / 1.68f;  // the round; its two rings at 1.32 and 1.68 of it (as on the mock-up and in the helper)
        boolean waiting = phase == State.Phase.CONNECTING || phase == State.Phase.RETRYING;
        int body, ink, rim;
        if (phase == State.Phase.ON) {
            body = on;
            ink = onInk;
            rim = onRing;
        } else if (waiting) {
            body = amber;
            ink = amberInk;
            rim = amber;
        } else {
            body = offFill;
            ink = offIcon;  // (with nothing to switch yet it opens adding one: the same pressable look)
            rim = offEdge;
        }
        // the two rings: the inner one firmer
        ring.setStrokeWidth(dp(1.5f));
        ring.setColor(alpha(rim, phase == State.Phase.OFF ? 0.55f : 0.42f));
        c.drawCircle(cx, cy, orb * 1.32f, ring);
        ring.setColor(alpha(rim, phase == State.Phase.OFF ? 0.22f : 0.16f));
        c.drawCircle(cx, cy, orb * 1.68f - dp(1), ring);
        // the round, with a soft shadow below it
        fill.setColor(body);
        fill.setShadowLayer(dp(12), 0, dp(10), dark ? 0x99000000 : 0x4D0D1630);  // the orb's shadow (DESIGN.md), on the sky
        c.drawCircle(cx, cy, orb, fill);
        if (phase == State.Phase.OFF) {  // off: a firm edge, so it reads as a button, not as something greyed out
            edge.setStrokeWidth(dp(1.5f));
            edge.setColor(offEdge);
            c.drawCircle(cx, cy, orb - dp(0.75f), edge);
        }
        // the power sign (the icon set's «power»: 24 grid, its size .38 of the round)
        float s = orb * 2 * 0.38f / 24f, ox = cx - 12 * s, oy = cy - 12 * s;
        icon.setColor(ink);
        icon.setStrokeWidth(Math.max(dp(2), 1.9f * s));
        c.drawLine(ox + 12 * s, oy + 3 * s, ox + 12 * s, oy + 11 * s, icon);
        box.set(ox + 4 * s, oy + 4.32f * s, ox + 20 * s, oy + 20.32f * s);
        c.drawArc(box, -45.6f, 271.2f, false, icon);
        // a running arc on the inner ring while it connects
        if (waiting) {
            spin.setColor(amber);
            spin.setStrokeWidth(dp(3));
            float sr = orb * 1.32f;
            box.set(cx - sr, cy - sr, cx + sr, cy + sr);
            c.drawArc(box, angle, 70, false, spin);
        }
    }

    private static int alpha(int color, float a) {
        return (color & 0x00FFFFFF) | (Math.round(255 * Math.max(0f, Math.min(1f, a))) << 24);
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
