package app.aihelper.vpn;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Winger's own journal: connecting, the bridge's states, response times and speeds, errors — to find out why something
 * is slow or does not work. Kept on the phone (the last ~256 KB) and sent to the family server now and then; the server
 * takes it only from the owner's own VPN login and shows it in «Управление» → «Сервер» → «📋 Журнал Winger».
 * Call links, keys and addresses are hidden in it, so it can be pasted into a chat.
 */
final class Diag {
    static final String TAG = "AIVPN";
    private static final long MAX = 256 * 1024, SEND = 96 * 1024, EVERY_MS = 30 * 60_000L;
    private static volatile boolean sending;

    private Diag() {}

    static void i(Context c, String line) {
        Log.i(TAG, line);
        write(c, line);
    }

    static void w(Context c, String line, Throwable e) {
        Log.w(TAG, line, e);
        write(c, line + ": " + e);
    }

    static String mask(String s) {
        s = s.replaceAll("(?i)(hysteria2|hy2|winger-bridge)://\\S+", "$1://…");
        s = s.replaceAll("(telemost\\.yandex\\.(?:ru|com)/j/)[0-9A-Za-z_-]*?([0-9A-Za-z_-]{3})\\b", "$1…$2");
        s = s.replaceAll("(?i)%2Fj%2F[0-9A-Za-z_-]+", "%2Fj%2F…");
        s = s.replaceAll("\\b[0-9a-fA-F]{20,}\\b", "…");
        s = s.replaceAll("\\b(\\d{1,3}\\.\\d{1,3})\\.\\d{1,3}\\.\\d{1,3}\\b", "$1.x.x");
        return s;
    }

    private static synchronized void write(Context c, String line) {
        File f = new File(c.getFilesDir(), "diag.log");
        String l = new SimpleDateFormat("dd.MM HH:mm:ss", Locale.US).format(new Date()) + " " + mask(line) + "\n";
        try (FileOutputStream o = new FileOutputStream(f, true)) {
            o.write(l.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            return;
        }
        if (f.length() > MAX) {  // keep the newer half
            byte[] keep = tailBytes(f, MAX / 2);
            try (FileOutputStream o = new FileOutputStream(f, false)) {
                o.write(keep);
            } catch (Exception ignored) {
                // next time
            }
        }
    }

    private static byte[] tailBytes(File f, long n) {
        try (RandomAccessFile r = new RandomAccessFile(f, "r")) {
            long from = Math.max(0, r.length() - n);
            byte[] b = new byte[(int) (r.length() - from)];
            r.seek(from);
            r.readFully(b);
            int nl = 0;  // from the start of a line
            if (from > 0) while (nl < b.length && b[nl] != '\n') nl++;
            byte[] out = new byte[b.length - Math.min(b.length, nl + (from > 0 ? 1 : 0))];
            System.arraycopy(b, b.length - out.length, out, 0, out.length);
            return out;
        } catch (Exception e) {
            return new byte[0];
        }
    }

    /** Sends the newest part of the journal to the family server (at most every half hour, unless now). */
    static void upload(Context ctx, boolean now) {
        Context c = ctx.getApplicationContext();
        SharedPreferences prefs = c.getSharedPreferences("vpn", Context.MODE_PRIVATE);
        if (sending || (!now && System.currentTimeMillis() - prefs.getLong("diagAt", 0) < EVERY_MS)) return;
        String host = Profile.homeHost(c), login = BridgeSync.ownLogin(c, host);
        File f = new File(c.getFilesDir(), "diag.log");
        if (host == null || login == null || !f.exists()) return;
        sending = true;
        new Thread(() -> {
            try {
                String text = new String(tailBytes(f, SEND), StandardCharsets.UTF_8);
                String app = c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName;
                JSONObject body = new JSONObject().put("auth", login).put("log", text)
                        .put("device", Build.MANUFACTURER + " " + Build.MODEL + ", Android " + Build.VERSION.RELEASE).put("app", app);
                HttpURLConnection h = Updater.open("https://" + host + ":8443/api/winger_log");
                h.setRequestMethod("POST");
                h.setDoOutput(true);
                h.setRequestProperty("Content-Type", "application/json");
                try (OutputStream o = h.getOutputStream()) {
                    o.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                int code = h.getResponseCode();
                h.disconnect();
                if (code == 200) prefs.edit().putLong("diagAt", System.currentTimeMillis()).apply();
                Log.i(TAG, "journal sent: " + code);
            } catch (Exception e) {
                Log.i(TAG, "journal not sent: " + e);
            } finally {
                sending = false;
            }
        }, "diag-send").start();
    }
}
