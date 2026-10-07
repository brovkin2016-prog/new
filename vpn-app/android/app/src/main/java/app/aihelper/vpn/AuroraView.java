package app.aihelper.vpn;

import android.animation.ArgbEvaluator;
import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.view.View;
import android.view.animation.LinearInterpolator;

/**
 * The background: three soft lights drifting slowly, like an aurora. Their colours follow the VPN: violet and blue
 * when off, amber while connecting, green and teal when protected. It moves only while the screen is visible.
 */
final class AuroraView extends View {
    private static final int[] OFF = {0xFF6366F1, 0xFF22D3EE, 0xFFA855F7};
    private static final int[] WAIT = {0xFFF59E0B, 0xFFFB7185, 0xFFFBBF24};
    private static final int[] ON = {0xFF10B981, 0xFF22D3EE, 0xFF34D399};
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final ArgbEvaluator mix = new ArgbEvaluator();
    private final boolean dark;
    private final int[] from = OFF.clone(), to = OFF.clone(), now = OFF.clone();
    private float t, blend = 1f;
    private ValueAnimator drift, fade;

    AuroraView(Context c, boolean dark) {
        super(c);
        this.dark = dark;
    }

    void show(State.Phase p) {
        int[] target = p == State.Phase.ON ? ON : p == State.Phase.OFF ? OFF : WAIT;
        if (target[0] == to[0]) return;
        System.arraycopy(now, 0, from, 0, 3);
        System.arraycopy(target, 0, to, 0, 3);
        if (fade != null) fade.cancel();
        fade = ValueAnimator.ofFloat(0f, 1f).setDuration(900);
        fade.addUpdateListener(a -> {
            blend = (float) a.getAnimatedValue();
            invalidate();
        });
        fade.start();
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        drift = ValueAnimator.ofFloat(0f, 1f).setDuration(24_000);
        drift.setRepeatCount(ValueAnimator.INFINITE);
        drift.setInterpolator(new LinearInterpolator());
        drift.addUpdateListener(a -> {
            t = (float) a.getAnimatedValue();
            invalidate();
        });
        drift.start();
    }

    @Override
    protected void onDetachedFromWindow() {
        if (drift != null) drift.cancel();
        if (fade != null) fade.cancel();
        super.onDetachedFromWindow();
    }

    @Override
    protected void onVisibilityChanged(View changed, int visibility) {
        super.onVisibilityChanged(changed, visibility);
        if (drift == null) return;
        if (visibility == VISIBLE && isShown()) drift.resume();
        else drift.pause();
    }

    @Override
    protected void onDraw(Canvas c) {
        float w = getWidth(), h = getHeight();
        if (w == 0) return;
        for (int i = 0; i < 3; i++) now[i] = (int) mix.evaluate(blend, from[i], to[i]);
        double a = t * 2 * Math.PI;
        // each light moves on its own slow loop; together they never quite repeat
        light(c, w * (0.25f + 0.12f * (float) Math.sin(a)), h * (0.18f + 0.06f * (float) Math.cos(a * 2)), w * 0.75f, now[0]);
        light(c, w * (0.8f + 0.1f * (float) Math.cos(a)), h * (0.32f + 0.08f * (float) Math.sin(a)), w * 0.65f, now[1]);
        light(c, w * (0.5f + 0.18f * (float) Math.sin(a * 3 + 1)), h * (0.62f + 0.05f * (float) Math.cos(a)), w * 0.7f, now[2]);
    }

    private void light(Canvas c, float x, float y, float r, int color) {
        int alpha = dark ? 0x55 : 0x3A;
        paint.setShader(new RadialGradient(x, y, r, new int[]{(color & 0x00FFFFFF) | (alpha << 24), color & 0x00FFFFFF},
                null, Shader.TileMode.CLAMP));
        c.drawCircle(x, y, r, paint);
    }
}
