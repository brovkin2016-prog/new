package app.aihelper.vpn;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.view.View;

import java.io.File;

/**
 * Winger's mark at the top of its screen: the winged shield (the same one as on its icon) in one colour, the text's, as
 * in the AI helper (B «Северное сияние»). No portrait any more (v33, the owner: the logo everywhere) — the one an older
 * Winger kept on the phone is removed. The full-colour shield stays on the icon and in the notification.
 */
final class LogoView extends View {
    private final Drawable mark;

    LogoView(Context c, int color) {
        super(c);
        mark = c.getDrawable(R.drawable.logo_mark).mutate();
        mark.setTint(color);
        for (String old : new String[]{"avatar.png", "avatar.webp"}) {
            //noinspection ResultOfMethodCallIgnored
            new File(c.getFilesDir(), old).delete();
        }
        setContentDescription("Winger");
    }

    @Override
    protected void onDraw(Canvas c) {
        // the mark's own proportions (68 × 60), as large as fits
        float w = getWidth(), h = getHeight(), k = Math.min(w / 68f, h / 60f);
        int mw = Math.round(68 * k), mh = Math.round(60 * k), x = Math.round((w - mw) / 2), y = Math.round((h - mh) / 2);
        mark.setBounds(x, y, x + mw, y + mh);
        mark.draw(c);
    }
}
