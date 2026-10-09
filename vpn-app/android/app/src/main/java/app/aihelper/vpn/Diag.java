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
import java.util.List;
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

    /**
     * The journal's newest part with a check of the ways to the family server right now, to be pasted into a chat when
     * the server itself is out of reach (then the journal cannot be sent to it). Runs the checks: not on the main thread.
     */
    static String report(Context ctx) {
        Context c = ctx.getApplicationContext();
        StringBuilder s = new StringBuilder("Winger ");
        try {
            s.append(c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName);
        } catch (Exception ignored) {
            s.append('?');
        }
        s.append(", ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append(", Android ").append(Build.VERSION.RELEASE);
        s.append("\nсеть телефона: ").append(network(c));
        Profile on = State.activeLink.isEmpty() ? null : Profile.parse(State.activeLink);
        s.append("\nVPN: ").append(State.phase).append(on == null ? "" : on.bridge ? ", мост " + on.platformOrDefault() : ", сервер")
                .append(State.auto ? " (выбран сам)" : "").append(State.note.isEmpty() ? "" : " — " + State.note);
        try {
            c.getPackageManager().getPackageInfo(Apps.aiHelper, 0);
            List<String> through = Apps.through(c);
            s.append("\nИИ-помощник: установлен, ").append(State.phase == State.Phase.OFF ? "идёт напрямую (VPN выключен)"
                    : through == null || through.contains(Apps.aiHelper) || (on != null && on.bridge) ? "идёт через VPN" : "идёт напрямую");
        } catch (Exception e) {
            s.append("\nИИ-помощник: не установлен");
        }
        String host = Profile.homeHost(c);
        if (host == null) {
            s.append("\nсемейный сервер: нет его ссылки");
        } else {
            String name = host.contains(":") ? host.substring(0, host.indexOf(':')) : host;
            try {
                long t = System.currentTimeMillis();
                int n = java.net.InetAddress.getAllByName(name).length;
                s.append("\nимя сервера: находится (").append(n).append(" адр., ").append(System.currentTimeMillis() - t).append(" мс)");
            } catch (Exception e) {
                s.append("\nимя сервера: НЕ находится — ").append(e.getClass().getSimpleName());
            }
            String url = "https://" + host + ":8443/app/version.json";
            s.append("\nсервер напрямую (TCP 8443, как ИИ-помощник): ").append(reach(url, true, name));
            if (VpnSvc.socksPort > 0) s.append("\nсервер через включённое подключение: ").append(reach(url, false, name));
        }
        File f = new File(c.getFilesDir(), "diag.log");
        s.append("\n--- журнал ---\n").append(f.exists() ? new String(tailBytes(f, 12 * 1024), StandardCharsets.UTF_8) : "(пуст)\n");
        return mask(s.toString());
    }

    private static String reach(String url, boolean direct, String name) {
        long t = System.currentTimeMillis();
        try {
            HttpURLConnection h = Updater.open(url, direct);
            h.setConnectTimeout(10_000);
            h.setReadTimeout(10_000);
            int code = h.getResponseCode();
            h.disconnect();
            return (code == 200 ? "отвечает" : "ответ " + code) + " за " + (System.currentTimeMillis() - t) + " мс";
        } catch (Exception e) {
            return "НЕ отвечает за " + (System.currentTimeMillis() - t) / 1000 + " с — " + String.valueOf(e).replace(name, "сервер");
        }
    }

    private static String network(Context c) {
        try {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
            // the phone's default network first (this app is never inside its own VPN, so it is the real one): with
            // Wi-Fi on, mobile data is often up as well and would be named wrongly
            android.net.Network active = cm.getActiveNetwork();
            String kind = kind(active == null ? null : cm.getNetworkCapabilities(active));
            if (kind != null) return kind;
            for (android.net.Network n : cm.getAllNetworks()) {
                kind = kind(cm.getNetworkCapabilities(n));
                if (kind != null) return kind;
            }
            return "нет";
        } catch (Exception e) {
            return "?";
        }
    }

    private static String kind(android.net.NetworkCapabilities k) {
        if (k == null || k.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)
                || !k.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)) return null;
        if (k.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI)) return "Wi-Fi";
        if (k.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR)) return "мобильная";
        return "другая";
    }

    /** Sends the newest part of the journal to the family server (at most every half hour, unless now). */
    static void upload(Context ctx, boolean now) {
        upload(ctx, now, false);
    }

    /** Direct: past the VPN, for when the connection itself is what does not work. */
    static void upload(Context ctx, boolean now, boolean direct) {
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
                HttpURLConnection h = Updater.open("https://" + host + ":8443/api/winger_log", direct);
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
