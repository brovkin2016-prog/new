package app.aihelper.vpn;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.SweepGradient;
import android.graphics.drawable.Drawable;
import android.view.View;
import android.view.animation.LinearInterpolator;
import android.view.animation.OvershootInterpolator;

/** The shield with the letter, with a slowly turning ring of aurora light around it; it springs in at start. */
final class LogoView extends View {
    private final Drawable shield;
    private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Matrix turn = new Matrix();
    private float angle;
    private ValueAnimator spin;

    LogoView(Context c) {
        super(c);
        shield = c.getDrawable(R.drawable.ic_launcher_fg);
        ring.setStyle(Paint.Style.STROKE);
        ring.setStrokeCap(Paint.Cap.ROUND);
        setScaleX(0.4f);
        setScaleY(0.4f);
        setAlpha(0f);
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        animate().scaleX(1f).scaleY(1f).alpha(1f).setStartDelay(120).setDuration(650)
                .setInterpolator(new OvershootInterpolator(2.2f)).start();
        spin = ValueAnimator.ofFloat(0f, 360f).setDuration(6000);
        spin.setRepeatCount(ValueAnimator.INFINITE);
        spin.setInterpolator(new LinearInterpolator());
        spin.addUpdateListener(a -> {
            angle = (float) a.getAnimatedValue();
            invalidate();
        });
        spin.start();
    }

    @Override
    protected void onDetachedFromWindow() {
        if (spin != null) spin.cancel();
        super.onDetachedFromWindow();
    }

    @Override
    protected void onDraw(Canvas c) {
        float s = Math.min(getWidth(), getHeight()), cx = getWidth() / 2f, cy = getHeight() / 2f;
        float r = s * 0.46f;
        SweepGradient g = new SweepGradient(cx, cy, new int[]{0x0022D3EE, 0xFF22D3EE, 0xFF6366F1, 0xFFA855F7, 0x00A855F7},
                new float[]{0f, 0.25f, 0.5f, 0.75f, 1f});
        turn.setRotate(angle, cx, cy);
        g.setLocalMatrix(turn);
        ring.setShader(g);
        ring.setStrokeWidth(s * 0.045f);
        c.drawCircle(cx, cy, r, ring);
        // the icon art has room around it; draw it a bit larger than the view's inner circle
        int pad = Math.round(s * -0.08f);
        shield.setBounds(pad, pad, getWidth() - pad, getHeight() - pad);
        shield.draw(c);
    }
}
