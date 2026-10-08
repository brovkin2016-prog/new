package app.aihelper.vpn;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * How fast a connection is: a download through it for a few seconds (Cloudflare's speed test file), and how long the
 * first byte took. The connection in use is measured as it is; another server through a short-lived client of its
 * own, past the VPN, so what is on now is not touched. A bridge is measured while it is on.
 */
final class Speed {
    private static final String FILE = "https://speed.cloudflare.com/__down?bytes=50000000";
    private static final long LIMIT_MS = 8000;

    private Speed() {}

    /** «⚡ 23,4 Мбит/с · 45 мс», or null when the connection could not be measured. Saved for its button. */
    static String measure(Context c, Profile p) {
        boolean active = State.phase == State.Phase.ON && p.link.equals(State.activeLink) && VpnSvc.socksPort > 0;
        Process temp = null;
        int port = VpnSvc.socksPort;
        try {
            if (!active) {
                if (p.bridge) return null;
                port = VpnSvc.freePort();
                temp = tempClient(c, p, port);
                if (temp == null) {
                    Diag.i(c, "speed: «" + p.name + "» does not answer");
                    save(c, p, "⚡ не отвечает");
                    return "⚡ не отвечает";
                }
            }
            double[] r = download(port);
            String line = r[0] <= 0 ? "⚡ ничего не скачалось"
                    : String.format(Locale.ROOT, "⚡ %.1f Мбит/с · %d мс", r[0], Math.round(r[1])).replace('.', ',');
            Diag.i(c, String.format(Locale.ROOT, "speed: «%s» %.2f Mbit/s, first byte %d ms%s", p.name, r[0], Math.round(r[1]),
                    active ? "" : " (a separate test client)"));
            save(c, p, line);
            return line;
        } finally {
            if (temp != null) temp.destroy();
        }
    }

    /** The last measurement of this connection, with its time: «⚡ 23,4 Мбит/с · 45 мс · 15:03». */
    static String last(Context c, Profile p) {
        return prefs(c).getString("speed:" + p.link.hashCode(), null);
    }

    private static void save(Context c, Profile p, String line) {
        String at = new java.text.SimpleDateFormat("HH:mm", Locale.ROOT).format(new java.util.Date());
        prefs(c).edit().putString("speed:" + p.link.hashCode(), line + " · " + at).apply();
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("speed", Context.MODE_PRIVATE);
    }

    /** {Mbit/s, ms to the first byte}: reads for up to 8 s through the local SOCKS5 port. */
    private static double[] download(int port) {
        HttpURLConnection h = null;
        try {
            long t0 = SystemClock.elapsedRealtime();
            h = (HttpURLConnection) new URL(FILE).openConnection(new Proxy(Proxy.Type.SOCKS, new InetSocketAddress("127.0.0.1", port)));
            h.setConnectTimeout(15_000);
            h.setReadTimeout(10_000);
            h.setUseCaches(false);
            try (InputStream in = h.getInputStream()) {
                byte[] b = new byte[64 * 1024];
                int n = in.read(b);
                if (n <= 0) return new double[]{0, 0};
                long first = SystemClock.elapsedRealtime(), bytes = n, end = first + LIMIT_MS;
                while (SystemClock.elapsedRealtime() < end && (n = in.read(b)) > 0) bytes += n;
                double sec = Math.max(0.2, (SystemClock.elapsedRealtime() - first) / 1000.0);
                return new double[]{bytes * 8 / 1e6 / sec, first - t0};
            }
        } catch (Exception e) {
            return new double[]{0, 0};
        } finally {
            if (h != null) h.disconnect();
        }
    }

    /** A short-lived Hysteria client for a server that is not on now, past the VPN; null when it does not connect. */
    private static Process tempClient(Context c, Profile p, int port) {
        try {
            String host = p.host;
            if (!host.matches("[0-9.]+") && !host.contains(":")) host = InetAddress.getByName(host).getHostAddress();
            File dir = c.getFilesDir();
            File cfg = new File(dir, "speed.yaml");
            try (FileOutputStream out = new FileOutputStream(cfg)) {
                out.write(VpnSvc.clientConfig(p, host, port).getBytes(StandardCharsets.UTF_8));
            }
            ProcessBuilder pb = new ProcessBuilder(c.getApplicationInfo().nativeLibraryDir + "/libhysteria.so", "client", "-c",
                    cfg.getAbsolutePath()).directory(dir).redirectErrorStream(true);
            pb.environment().put("HYSTERIA_DISABLE_UPDATE_CHECK", "1");
            pb.environment().put("HYSTERIA_LOG_LEVEL", "info");
            pb.environment().put("HOME", dir.getAbsolutePath());
            Process proc = pb.start();
            CountDownLatch ok = new CountDownLatch(1);
            new Thread(() -> {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
                    for (String line; (line = r.readLine()) != null; ) if (line.contains("connected to server")) ok.countDown();
                } catch (Exception ignored) {
                    // the client ended
                }
            }, "speed-log").start();
            if (ok.await(12, TimeUnit.SECONDS)) return proc;
            proc.destroy();
            return null;
        } catch (Exception e) {
            return null;
        }
    }
}
