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
    // (v33) the look by itself while the screen is open: a shorter one (10 MB at most, 4 s; the owner's mobile internet has
    // no limit) — the button's ⚡ is the full one
    private static final String FILE_SHORT = "https://speed.cloudflare.com/__down?bytes=10000000";
    private static final long SHORT_MS = 4000;
    static final long AUTO_ON = 5 * 60_000L, AUTO_OTHER = 10 * 60_000L;  // the one in use again after, the other servers after
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
                    saveMbps(c, p, 0);
                    Diag.i(c, "speed: «" + p.name + "» does not answer");
                    save(c, p, "⚡ не отвечает");
                    return "⚡ не отвечает";
                }
            }
            double[] r = download(port);
            saveMbps(c, p, r[0]);
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

    /** The last response time of this connection, with its time: «⏱ отклик 85 мс · 15:03» (or «⏱ не отвечает · …»). */
    static String lastPing(Context c, Profile p) {
        return prefs(c).getString("ping:" + p.link.hashCode(), null);
    }

    static void savePing(Context c, Profile p, int ms) {
        String at = new java.text.SimpleDateFormat("HH:mm", Locale.ROOT).format(new java.util.Date());
        prefs(c).edit().putString("ping:" + p.link.hashCode(), (ms > 0 ? "⏱ отклик " + ms + " мс" : "⏱ не отвечает") + " · " + at).apply();
    }

    private static final java.util.concurrent.atomic.AtomicBoolean pinging = new java.util.concurrent.atomic.AtomicBoolean();
    private static volatile long pingedAll;

    /**
     * The response time of every server that is not in use now, at once when the screen opens (at most once a minute):
     * each through a short-lived client of its own, past the VPN, one after another in the background; done() after each.
     * A bridge keeps the one it had when it was last on (it would have to get into its call to be asked).
     */
    static void pingAll(Context c, Runnable done) {
        if (System.currentTimeMillis() - pingedAll < 60_000 || !pinging.compareAndSet(false, true)) return;
        Context app = c.getApplicationContext();
        new Thread(() -> {
            try {
                for (Profile p : Profile.all(app)) {
                    boolean active = State.phase == State.Phase.ON && p.link.equals(State.activeLink);
                    if (p.bridge || active) continue;
                    pingOne(app, p);
                    done.run();
                }
            } finally {
                pingedAll = System.currentTimeMillis();
                pinging.set(false);
            }
        }, "ping-all").start();
    }

    /** One server through a short-lived client of its own, past the VPN: its response time (0: none), kept for its button
     *  and as this network's word for it (Scout). */
    static int pingOne(Context c, Profile p) {
        int port = VpnSvc.freePort();
        Process temp = tempClient(c, p, port, "ping.yaml");
        int best = 0;
        try {
            for (int i = 0; temp != null && i < 2; i++) {
                int ms = probe(port, 6000);
                if (ms > 0) best = best == 0 ? ms : Math.min(best, ms);
            }
        } finally {
            if (temp != null) temp.destroy();
        }
        savePing(c, p, best);
        Scout.record(c, p, best > 0 ? "ok" : "no_answer", best);
        Diag.i(c, "ping «" + p.name + "»: " + (best > 0 ? best + " ms" : "no answer") + " (a separate test client)");
        return best;
    }

    /** One request through a local SOCKS port: its time in ms, 0 when none came back. */
    static int probe(int port, int timeoutMs) {
        long t0 = SystemClock.elapsedRealtime();
        HttpURLConnection h = null;
        try {
            h = (HttpURLConnection) new URL(VpnSvc.PING_URL).openConnection(new Proxy(Proxy.Type.SOCKS, new InetSocketAddress("127.0.0.1", port)));
            h.setConnectTimeout(timeoutMs);
            h.setReadTimeout(timeoutMs);
            h.setUseCaches(false);
            int code = h.getResponseCode();
            return code == 204 || code == 200 ? (int) Math.max(1, SystemClock.elapsedRealtime() - t0) : 0;
        } catch (Exception e) {
            return 0;
        } finally {
            if (h != null) h.disconnect();
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

    /** (v33) The speed as a number for the connection's line: Mbit/s and when it was measured. */
    private static void saveMbps(Context c, Profile p, double mbps) {
        prefs(c).edit().putFloat("mbps:" + p.link.hashCode(), (float) mbps).putLong("mbpsAt:" + p.link.hashCode(), System.currentTimeMillis()).apply();
    }

    /** Its speed (Mbit/s) if measured in the last two hours; -1: none (0: nothing came through). */
    static double mbps(Context c, Profile p) {
        long at = prefs(c).getLong("mbpsAt:" + p.link.hashCode(), 0);
        return System.currentTimeMillis() - at < 2 * 3600_000L ? prefs(c).getFloat("mbps:" + p.link.hashCode(), -1f) : -1;
    }

    private static long mbpsAt(Context c, Profile p) {
        return prefs(c).getLong("mbpsAt:" + p.link.hashCode(), 0);
    }

    private static final java.util.concurrent.atomic.AtomicBoolean measuring = new java.util.concurrent.atomic.AtomicBoolean();

    /**
     * (v33) While Winger's screen is open, once a minute: one connection whose speed is due is measured by a short look —
     * the one in use every 5 minutes, the other servers every 10 (each through a short-lived client of its own).
     * A bridge not in use cannot be measured without its call: it keeps the speed it had when it was on. Not during a
     * check of the bridges (one call at a time). done() after it.
     */
    static void auto(Context c, Runnable done) {
        if (BridgeCheck.running.get() || !measuring.compareAndSet(false, true)) return;
        Context app = c.getApplicationContext();
        new Thread(() -> {
            try {
                long now = System.currentTimeMillis();
                Profile due = null;
                boolean active = false;
                for (Profile p : Profile.all(app)) {
                    boolean on = State.phase == State.Phase.ON && p.link.equals(State.activeLink) && VpnSvc.socksPort > 0;
                    if (on && now - mbpsAt(app, p) >= AUTO_ON) {
                        due = p;
                        active = true;
                        break;
                    }
                    if (!on && !p.bridge && due == null && now - mbpsAt(app, p) >= AUTO_OTHER) due = p;
                }
                if (due == null) return;
                Process temp = null;
                int port = VpnSvc.socksPort;
                try {
                    if (!active) {
                        port = VpnSvc.freePort();
                        temp = tempClient(app, due, port, "ping.yaml");
                        if (temp == null) {
                            saveMbps(app, due, 0);
                            return;
                        }
                    }
                    double[] r = download(port, FILE_SHORT, SHORT_MS);
                    saveMbps(app, due, r[0]);
                    Diag.i(app, String.format(Locale.ROOT, "speed (by itself): «%s» %.1f Mbit/s", due.name, r[0]));
                } finally {
                    if (temp != null) temp.destroy();
                }
            } catch (Exception e) {
                Diag.i(app, "speed (by itself): " + e);
            } finally {
                measuring.set(false);
                done.run();
            }
        }, "speed-auto").start();
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("speed", Context.MODE_PRIVATE);
    }

    /** {Mbit/s, ms to the first byte}: reads for up to 8 s through the local SOCKS5 port. */
    static double[] download(int port) {
        return download(port, FILE, LIMIT_MS);
    }

    static double[] download(int port, String file, long limitMs) {
        HttpURLConnection h = null;
        try {
            long t0 = SystemClock.elapsedRealtime();
            h = (HttpURLConnection) new URL(file).openConnection(new Proxy(Proxy.Type.SOCKS, new InetSocketAddress("127.0.0.1", port)));
            h.setConnectTimeout(15_000);
            h.setReadTimeout(10_000);
            h.setUseCaches(false);
            try (InputStream in = h.getInputStream()) {
                byte[] b = new byte[64 * 1024];
                int n = in.read(b);
                if (n <= 0) return new double[]{0, 0};
                long first = SystemClock.elapsedRealtime(), bytes = n, end = first + limitMs;
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
        return tempClient(c, p, port, "speed.yaml");
    }

    /** cfg: its settings file's name (the speed test and the response times may run at once). */
    private static Process tempClient(Context c, Profile p, int port, String cfgName) {
        try {
            String host = p.host;
            if (!host.matches("[0-9.]+") && !host.contains(":")) host = InetAddress.getByName(host).getHostAddress();
            File dir = c.getFilesDir();
            // (v34) a file of its own for each client: two at once (a response time and a speed by itself) wrote the same one,
            // and one of them asked the other's port — «no answer» in a moment
            File cfg = new File(dir, cfgName.replace(".yaml", "-" + port + ".yaml"));
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
            boolean up = ok.await(12, TimeUnit.SECONDS);
            //noinspection ResultOfMethodCallIgnored
            cfg.delete();  // (read when it started)
            // (v34) «connected to server» comes before its own port is open: a request at once was refused, and a server that
            // works read «no answer» — its port open first (3 s at most)
            for (long until = SystemClock.elapsedRealtime() + 3000; up && SystemClock.elapsedRealtime() < until; ) {
                try (java.net.Socket probe = new java.net.Socket()) {
                    probe.connect(new InetSocketAddress("127.0.0.1", port), 300);
                    break;
                } catch (java.io.IOException notYet) {
                    Thread.sleep(50);
                }
            }
            if (up) return proc;
            proc.destroy();
            return null;
        } catch (Exception e) {
            return null;
        }
    }
}
