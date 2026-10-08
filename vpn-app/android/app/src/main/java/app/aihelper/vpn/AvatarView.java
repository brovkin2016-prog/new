package app.aihelper.vpn;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RadialGradient;
import android.graphics.Rect;
import android.graphics.Shader;
import android.graphics.ImageDecoder;
import android.graphics.SweepGradient;
import android.graphics.drawable.AnimatedImageDrawable;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.view.View;
import android.view.animation.LinearInterpolator;
import android.view.animation.OvershootInterpolator;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;

/**
 * The owner's portrait in a circle: an aurora drifts behind the photo, a ring of light turns around, and the picture breathes
 * a little. The photo lives on the family server, not in the app: it comes from /app/vpn-avatar.png and is kept on the
 * phone. On Android 9 and newer the living one comes too (/app/vpn-avatar.webp: the face winks and smiles now and
 * then). Until a picture has come, the portrait from the app's own icon stands in (the server puts it there when it
 * signs the app), and the winged shield only when there is none.
 */
final class AvatarView extends View {
    private static final long EVERY_MS = 24 * 3600_000L;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
    private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Matrix turn = new Matrix();
    private final Path clip = new Path();
    private final Rect dst = new Rect();
    private final Drawable emblem;  // the winged shield
    private final File file, live;
    private Bitmap photo;
    private final Bitmap iconPhoto;  // the portrait the server put into the icon: the sky and the face, full square
    private final Rect iconSrc = new Rect();
    private Drawable moving;  // the living portrait (an animated WebP), Android 9+
    private float t;
    private ValueAnimator anim;

    AvatarView(Context c) {
        super(c);
        emblem = c.getDrawable(R.drawable.emblem);
        file = new File(c.getFilesDir(), "avatar.png");
        live = new File(c.getFilesDir(), "avatar.webp");
        photo = BitmapFactory.decodeFile(file.getAbsolutePath());
        moving = decodeLive();
        Bitmap ic = BitmapFactory.decodeResource(c.getResources(), R.drawable.ic_owner);
        iconPhoto = ic != null && ic.getWidth() > 8 ? ic : null;  // the repository's placeholder is 1x1
        if (iconPhoto != null) {  // the icon shows its middle two thirds; so does the circle
            int w = iconPhoto.getWidth(), h = iconPhoto.getHeight();
            iconSrc.set(w / 6, h / 6, w - w / 6, h - h / 6);
        }
        ring.setStyle(Paint.Style.STROKE);
        ring.setStrokeCap(Paint.Cap.ROUND);
        setScaleX(0.4f);
        setScaleY(0.4f);
        setAlpha(0f);
    }

    /** Fetches the portrait from the server named in the link (through the tunnel when the VPN is on), once a day. */
    void refresh(Profile p) {
        String host = Profile.homeHost(getContext());
        if (host == null) return;
        if (photo != null && System.currentTimeMillis() - file.lastModified() < EVERY_MS) return;
        new Thread(() -> {
            String base = "https://" + host + ":8443/app/vpn-avatar.";
            int code = fetch(base + "png", file);
            Bitmap bmp = code == 200 ? BitmapFactory.decodeFile(file.getAbsolutePath()) : null;
            if (bmp != null) {
                post(() -> {
                    photo = bmp;
                    invalidate();
                });
            } else if (code == 404) {
                post(() -> {  // the owner took the photo away
                    photo = null;
                    invalidate();
                });
            }
            if (Build.VERSION.SDK_INT >= 28 && code != -1) {
                int lc = fetch(base + "webp", live);
                if (lc == 200 || lc == 404) post(() -> {
                    stopLive();
                    moving = decodeLive();
                    if (isAttachedToWindow()) startLive();
                    invalidate();
                });
            }
        }, "avatar").start();
    }

    /** Downloads url into dst: 200 saved, 404 removed (the owner took it away), -1 no answer; anything else keeps dst. */
    private static int fetch(String url, File dst) {
        try {
            int port = VpnSvc.socksPort;
            URL u = new URL(url);
            HttpURLConnection c = (HttpURLConnection) (port > 0
                    ? u.openConnection(new Proxy(Proxy.Type.SOCKS, new InetSocketAddress("127.0.0.1", port)))
                    : u.openConnection());
            c.setConnectTimeout(15_000);
            c.setReadTimeout(20_000);
            int code = c.getResponseCode();
            if (code == 200) {
                File tmp = new File(dst.getPath() + ".new");
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(tmp)) {
                    byte[] b = new byte[16384];
                    for (int n; (n = in.read(b)) > 0; ) out.write(b, 0, n);
                }
                if (!tmp.renameTo(dst)) code = 500;
            } else if (code == 404) {
                if (!dst.delete() && dst.exists()) code = 500;
            }
            c.disconnect();
            return code;
        } catch (Exception e) {
            return -1;  // try again next time
        }
    }

    private Drawable decodeLive() {
        if (Build.VERSION.SDK_INT < 28 || !live.exists()) return null;
        try {
            Drawable d = ImageDecoder.decodeDrawable(ImageDecoder.createSource(live));
            if (d instanceof AnimatedImageDrawable) ((AnimatedImageDrawable) d).setRepeatCount(AnimatedImageDrawable.REPEAT_INFINITE);
            d.setCallback(this);
            return d;
        } catch (Exception e) {
            return null;  // a broken file: the still photo stays
        }
    }

    private void startLive() {
        if (Build.VERSION.SDK_INT >= 28 && moving instanceof AnimatedImageDrawable) ((AnimatedImageDrawable) moving).start();
    }

    private void stopLive() {
        if (Build.VERSION.SDK_INT >= 28 && moving instanceof AnimatedImageDrawable) ((AnimatedImageDrawable) moving).stop();
    }

    @Override
    protected boolean verifyDrawable(Drawable who) {
        return who == moving || super.verifyDrawable(who);
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
        startLive();
    }

    @Override
    protected void onDetachedFromWindow() {
        if (anim != null) anim.cancel();
        stopLive();
        super.onDetachedFromWindow();
    }

    @Override
    protected void onDraw(Canvas c) {
        float s = Math.min(getWidth(), getHeight()), cx = getWidth() / 2f, cy = getHeight() / 2f;
        float ringR = s * 0.47f, r = s * 0.42f;
        double a = t * 2 * Math.PI;
        if (photo == null && moving == null && iconPhoto == null) {  // no portrait: the winged shield, floating gently
            float lift = s * 0.025f * (float) Math.sin(a * 2), half = s * 0.56f;
            emblem.setBounds(Math.round(cx - half), Math.round(cy - half + lift), Math.round(cx + half), Math.round(cy + half + lift));
            emblem.draw(c);
            return;
        }
        // the turning ring of light
        SweepGradient g = new SweepGradient(cx, cy, new int[]{0x0022D3EE, 0xFF22D3EE, 0xFF6366F1, 0xFFA855F7, 0x00A855F7},
                new float[]{0f, 0.25f, 0.5f, 0.75f, 1f});
        turn.setRotate(t * 720f, cx, cy);
        g.setLocalMatrix(turn);
        ring.setShader(g);
        ring.setStrokeWidth(s * 0.04f);
        c.drawCircle(cx, cy, ringR, ring);
        // inside the circle: night sky, three drifting lights, then the portrait, breathing a little
        c.save();
        clip.reset();
        clip.addCircle(cx, cy, r, Path.Direction.CW);
        c.clipPath(clip);
        paint.setShader(null);
        paint.setColor(0xFF0B1026);
        c.drawCircle(cx, cy, r, paint);
        blob(c, cx + r * 0.5f * (float) Math.sin(a), cy - r * 0.45f + r * 0.2f * (float) Math.cos(a * 2), r * 1.1f, 0xFF22D3EE);
        blob(c, cx + r * 0.55f * (float) Math.cos(a), cy + r * 0.1f * (float) Math.sin(a), r * 1.0f, 0xFF6366F1);
        blob(c, cx - r * 0.4f * (float) Math.sin(a * 2 + 1), cy + r * 0.7f, r * 1.0f, 0xFFA855F7);
        paint.setShader(null);
        float breathe = 1f + 0.018f * (float) Math.sin(a * 2);
        float half = r * breathe;
        dst.set(Math.round(cx - half), Math.round(cy - half * 0.98f), Math.round(cx + half), Math.round(cy + half * 1.02f));
        if (moving != null) {
            moving.setBounds(dst);
            moving.draw(c);
        } else if (photo == null) {
            c.drawBitmap(iconPhoto, iconSrc, dst, paint);
        } else {
            c.drawBitmap(photo, null, dst, paint);
        }
        c.restore();
    }

    private void blob(Canvas c, float x, float y, float r, int color) {
        paint.setShader(new RadialGradient(x, y, r, new int[]{(color & 0x00FFFFFF) | 0xB0000000, color & 0x00FFFFFF},
                null, Shader.TileMode.CLAMP));
        c.drawCircle(x, y, r, paint);
    }
}
