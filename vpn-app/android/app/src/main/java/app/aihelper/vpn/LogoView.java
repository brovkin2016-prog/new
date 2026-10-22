package app.aihelper.vpn;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.view.View;
import android.view.animation.LinearInterpolator;
import android.view.animation.OvershootInterpolator;

import java.io.File;

/**
 * Winger's logo at the top of its screen: the winged shield, floating gently (the same one as on its icon). No portrait
 * any more (v33, the owner: the logo everywhere) — the one an older Winger kept on the phone is removed.
 */
final class LogoView extends View {
    private final Drawable emblem;
    private float t;
    private ValueAnimator anim;

    LogoView(Context c) {
        super(c);
        emblem = c.getDrawable(R.drawable.emblem);
        for (String old : new String[]{"avatar.png", "avatar.webp"}) {
            //noinspection ResultOfMethodCallIgnored
            new File(c.getFilesDir(), old).delete();
        }
        setScaleX(0.4f);
        setScaleY(0.4f);
        setAlpha(0f);
        setContentDescription("Winger");
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        animate().scaleX(1f).scaleY(1f).alpha(1f).setStartDelay(120).setDuration(700)
                .setInterpolator(new OvershootInterpolator(2f)).start();
        anim = ValueAnimator.ofFloat(0f, 1f).setDuration(9000);
        anim.setRepeatCount(ValueAnimator.INFINITE);
        anim.setInterpolator(new LinearInterpolator());
        anim.addUpdateListener(a -> {
            t = (float) a.getAnimatedValue();
            invalidate();
        });
        anim.start();
        if (getWindowVisibility() != VISIBLE) onWindowVisibilityChanged(getWindowVisibility());
    }

    @Override
    protected void onWindowVisibilityChanged(int v) {
        super.onWindowVisibilityChanged(v);
        // not drawn while Winger is behind other apps or the screen is off: the battery is not spent on it
        if (anim == null) return;
        if (v == VISIBLE) anim.resume();
        else anim.pause();
    }

    @Override
    protected void onDetachedFromWindow() {
        if (anim != null) anim.cancel();
        super.onDetachedFromWindow();
    }

    @Override
    protected void onDraw(Canvas c) {
        float s = Math.min(getWidth(), getHeight()), cx = getWidth() / 2f, cy = getHeight() / 2f;
        float lift = s * 0.025f * (float) Math.sin(t * 4 * Math.PI), half = s * 0.56f;
        emblem.setBounds(Math.round(cx - half), Math.round(cy - half + lift), Math.round(cx + half), Math.round(cy + half + lift));
        emblem.draw(c);
    }
}
