package app.aihelper.vpn;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import hev.htproxy.TProxyService;

/**
 * The VPN: the official Hysteria 2 client runs as a small program and offers a SOCKS5 port on the phone;
 * hev-socks5-tunnel carries everything from the VPN interface to that port. This app itself stays outside the VPN,
 * so the client's own connection to the server never loops back into the tunnel.
 */
public final class VpnSvc extends VpnService {
    static final String START = "app.aihelper.vpn.START", STOP = "app.aihelper.vpn.STOP", PING = "app.aihelper.vpn.PING";
    private static final String TAG = "AIVPN";
    private static final String CHANNEL = "vpn";
    private static final int NOTE_ID = 1;
    private static final String PING_URL = "http://cp.cloudflare.com/generate_204";

    static volatile int socksPort;  // the client's local port while the VPN is on (the app's own update check uses it)

    private final Object lock = new Object();
    private volatile boolean wanted;
    private Thread worker;
    private ParcelFileDescriptor tun;
    private TProxyService hev;
    private Process client;
    private volatile String lastError;
    private volatile CountDownLatch connected;
    private Profile profile;
    private File dir;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? START : intent.getAction();
        if (STOP.equals(action)) {
            Apps.setKeepOn(this, false);  // switched off by hand: it stays off after a reboot too
            stop(null);
            return START_NOT_STICKY;
        }
        if (PING.equals(action)) {
            if (State.phase == State.Phase.ON) new Thread(this::ping, "ping").start();
            return START_STICKY;
        }
        // START, or the system (re)starting us for "always-on VPN"
        Profile p = Profile.chosen(this);
        if (p == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        foreground("Подключаюсь…");
        Apps.setKeepOn(this, true);
        boolean again = intent != null && intent.getBooleanExtra("again", false);  // the list of apps changed
        Thread old;
        synchronized (lock) {
            if (!again && wanted && profile != null && profile.link.equals(p.link)) return START_STICKY;  // already on with it
            old = worker;
            wanted = false;  // another server was chosen: the old connection goes first
        }
        if (old != null) {
            old.interrupt();
            try {
                old.join(3000);
            } catch (InterruptedException ignored) {
                // go on
            }
        }
        stopParts();
        synchronized (lock) {
            profile = p;
            wanted = true;
            dir = getFilesDir();
            worker = new Thread(this::run, "vpn");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onRevoke() {
        Apps.setKeepOn(this, false);  // another VPN app took over: do not take it back after a reboot
        stop("VPN выключен: его забрало другое VPN-приложение или настройки телефона.");
    }

    @Override
    public void onDestroy() {
        stop(null);
        super.onDestroy();
    }

    // ---------- the work: connect, keep it up, say how it goes ----------

    private void run() {
        int fails = 0;
        State.set(State.Phase.CONNECTING, "Подключаюсь к серверу…");
        if (socksPort == 0) socksPort = freePort();
        while (wanted) {
            String err = startClient();
            if (err == null && wanted) {
                if (tun == null && !openTunnel()) return;
                fails = 0;
                State.set(State.Phase.ON, "");
                Log.i(TAG, "connected via " + profile.host);
                ping();
                err = watch();
            }
            killClient();
            if (!wanted) break;
            fails++;
            State.set(tun == null ? State.Phase.CONNECTING : State.Phase.RETRYING, err + " Пробую снова…");
            update();
            if (!sleep(Math.min(30_000L, 1000L << Math.min(fails, 5)))) break;
        }
    }

    /** While the client runs: speeds every second, the response time every 20 s; null-free reason when it stopped. */
    private String watch() {
        long lastPing = SystemClock.elapsedRealtime(), lastStats = 0;
        long prevDown = 0, prevUp = 0;
        int missed = 0;
        while (wanted) {
            if (!sleep(1000)) return "";
            Process p = client;
            if (p == null || !alive(p)) return lastError != null ? lastError : "Клиент VPN остановился.";
            long[] s = statsOrNull();
            long now = SystemClock.elapsedRealtime();
            if (s != null) {
                // the tunnel counts tx for what it reads from the phone's apps (upload), rx for what it gives them (download)
                long dn = s[3], upb = s[1];
                if (lastStats > 0) {
                    double sec = Math.max(0.2, (now - lastStats) / 1000.0);
                    State.downRate = State.downRate * 0.5 + Math.max(0, dn - prevDown) / sec * 0.5;
                    State.upRate = State.upRate * 0.5 + Math.max(0, upb - prevUp) / sec * 0.5;
                }
                prevDown = dn;
                prevUp = upb;
                lastStats = now;
                State.down = dn;
                State.up = upb;
                State.fire();
            }
            if (now - lastPing >= 20_000) {
                lastPing = now;
                ping();
                Log.i(TAG, "traffic down " + State.down + " up " + State.up);
                if (State.pingMs == 0) {
                    missed++;
                    State.set(State.Phase.RETRYING, "Сервер не отвечает…");
                    update();
                    if (missed >= 3) return "Связь с сервером пропала.";  // restart the client: a new network, a new path
                } else if (missed > 0) {
                    missed = 0;
                    State.set(State.Phase.ON, "");
                    update();
                }
            }
        }
        return "";
    }

    /** Starts the Hysteria client and waits until it has reached the server. Null when it has. */
    private String startClient() {
        Profile p = profile;
        String host = p.host;
        try {
            // the client cannot look names up on Android by itself: give it the address
            if (!host.matches("[0-9.]+") && !host.contains(":")) host = InetAddress.getByName(host).getHostAddress();
        } catch (Exception e) {
            return "Нет интернета или не найден сервер «" + p.host + "».";
        }
        File cfg = new File(dir, "client.yaml");
        StringBuilder y = new StringBuilder();
        y.append("server: ").append(q((host.contains(":") ? "[" + host + "]" : host) + ":" + p.ports)).append('\n');
        y.append("auth: ").append(q(p.auth)).append('\n');
        y.append("tls:\n  sni: ").append(q(p.serverName())).append("\n  insecure: ").append(p.insecure).append('\n');
        if (p.pin != null && !p.pin.isEmpty()) y.append("  pinSHA256: ").append(q(p.pin)).append('\n');
        if ("salamander".equalsIgnoreCase(p.obfs)) {
            y.append("obfs:\n  type: salamander\n  salamander:\n    password: ").append(q(p.obfsPassword == null ? "" : p.obfsPassword)).append('\n');
        }
        y.append("quic:\n  keepAlivePeriod: 10s\n");
        y.append("fastOpen: true\n");
        y.append("socks5:\n  listen: 127.0.0.1:").append(socksPort).append('\n');
        try (FileOutputStream out = new FileOutputStream(cfg)) {
            out.write(y.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            return "Не получилось подготовить подключение.";
        }
        lastError = null;
        connected = new CountDownLatch(1);
        try {
            ProcessBuilder pb = new ProcessBuilder(getApplicationInfo().nativeLibraryDir + "/libhysteria.so", "client", "-c",
                    cfg.getAbsolutePath()).directory(dir).redirectErrorStream(true);
            pb.environment().put("HYSTERIA_DISABLE_UPDATE_CHECK", "1");
            pb.environment().put("HYSTERIA_LOG_LEVEL", "info");
            pb.environment().put("HOME", dir.getAbsolutePath());
            Process proc = pb.start();
            synchronized (lock) {
                if (!wanted) {
                    proc.destroy();
                    return "";
                }
                client = proc;
            }
            CountDownLatch up = connected;
            new Thread(() -> read(proc, up), "client-log").start();
            if (!up.await(20, TimeUnit.SECONDS)) return lastError != null ? lastError : "Сервер не отвечает.";
            return alive(proc) ? null : (lastError != null ? lastError : "Не удалось подключиться.");
        } catch (InterruptedException e) {
            return "";
        } catch (Exception e) {
            Log.w(TAG, "client start", e);
            return "Не получилось запустить VPN на этом телефоне.";
        }
    }

    private void read(Process proc, CountDownLatch up) {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) {
                Log.i(TAG, "hy: " + line);
                if (line.contains("connected to server")) up.countDown();
                else if (line.contains("FATAL") || line.contains("ERROR")) lastError = plain(line);
            }
        } catch (Exception ignored) {
            // the program ended
        }
        up.countDown();
    }

    /** The client's error line in words a person understands. */
    static String plain(String line) {
        String l = line.toLowerCase();
        if (l.contains("authentication") || l.contains("auth error") || l.contains("status code: 404"))
            return "Сервер не принял эту ссылку: её удалили или в ней ошибка.";
        if (l.contains("certificate") || l.contains("x509")) return "Сервер показал неверный сертификат.";
        if (l.contains("timeout") || l.contains("no recent network activity") || l.contains("deadline"))
            return "Сервер не отвечает.";
        if (l.contains("network is unreachable") || l.contains("no route")) return "Нет интернета.";
        return "Не удалось подключиться.";
    }

    private boolean openTunnel() {
        if (prepare(this) != null) {  // also makes this app the phone's VPN when permission was given before
            stop("Нет разрешения на VPN: нажмите кнопку и разрешите.");
            return false;
        }
        try {
            Builder b = new Builder().setSession(profile.name).setMtu(8500)
                    .addAddress("198.18.0.1", 32).addRoute("0.0.0.0", 0)
                    .addDnsServer("1.1.1.1").addDnsServer("8.8.8.8");
            try {
                b.addAddress("fc00::1", 128).addRoute("::", 0);  // IPv6 also goes in, so nothing leaks around the VPN
            } catch (IllegalArgumentException ignored) {
                // no IPv6 on this phone
            }
            List<String> only = Apps.through(this);  // only Instagram, Telegram… — or null: everything
            int allowed = 0;
            if (only != null) {
                for (String pkg : only) {
                    try {
                        b.addAllowedApplication(pkg);
                        allowed++;
                    } catch (PackageManager.NameNotFoundException ignored) {
                        // removed meanwhile
                    }
                }
            }
            if (allowed == 0) {
                try {
                    b.addDisallowedApplication(getPackageName());  // everything but this app (its own client goes straight)
                } catch (PackageManager.NameNotFoundException ignored) {
                    // it is this very package
                }
            }
            Log.i(TAG, allowed > 0 ? "through the VPN: " + only : "through the VPN: all apps");
            b.setConfigureIntent(PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                    PendingIntent.FLAG_IMMUTABLE));
            if (Build.VERSION.SDK_INT >= 29) b.setMetered(false);
            ParcelFileDescriptor fd = b.establish();
            if (fd == null) {
                stop("Нет разрешения на VPN: нажмите кнопку ещё раз и разрешите.");
                return false;
            }
            File conf = new File(dir, "tunnel.yaml");
            String y = "tunnel:\n  mtu: 8500\n  ipv4: 198.18.0.1\n  ipv6: 'fc00::1'\n"
                    + "socks5:\n  port: " + socksPort + "\n  address: 127.0.0.1\n  udp: 'udp'\n"
                    + "misc:\n  task-stack-size: 81920\n  log-level: warn\n";
            try (FileOutputStream out = new FileOutputStream(conf)) {
                out.write(y.getBytes(StandardCharsets.UTF_8));
            }
            TProxyService t = new TProxyService();
            synchronized (lock) {
                if (!wanted) {
                    fd.close();
                    return false;
                }
                tun = fd;
                hev = t;
            }
            t.TProxyStartService(conf.getAbsolutePath(), fd.getFd());
            return true;
        } catch (Exception e) {
            Log.w(TAG, "tunnel", e);
            stop("Не получилось включить VPN на этом телефоне.");
            return false;
        }
    }

    /** The response time through the tunnel: the best of two quick requests; 0 when nothing came back. */
    private void ping() {
        int best = 0;
        for (int i = 0; i < 2; i++) {
            long t0 = SystemClock.elapsedRealtime();
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(PING_URL).openConnection(
                        new Proxy(Proxy.Type.SOCKS, new InetSocketAddress("127.0.0.1", socksPort)));
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                c.setUseCaches(false);
                int code = c.getResponseCode();
                int ms = (int) Math.max(1, SystemClock.elapsedRealtime() - t0);
                if (code == 204 || code == 200) best = best == 0 ? ms : Math.min(best, ms);
            } catch (Exception ignored) {
                // no answer this time
            } finally {
                if (c != null) c.disconnect();
            }
        }
        State.pingMs = best;
        State.pingAt = System.currentTimeMillis();
        Log.i(TAG, best > 0 ? "ping " + best + " ms" : "ping failed");
        State.fire();
        update();
    }

    // ---------- stopping ----------

    private void stop(String why) {
        synchronized (lock) {
            wanted = false;
            if (worker != null) worker.interrupt();
            worker = null;
        }
        stopParts();
        socksPort = 0;
        State.set(State.Phase.OFF, why);
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
        Log.i(TAG, "stopped" + (why != null ? ": " + why : ""));
    }

    private void stopParts() {
        TProxyService t;
        ParcelFileDescriptor fd;
        synchronized (lock) {
            t = hev;
            fd = tun;
            hev = null;
            tun = null;
        }
        if (t != null) {
            try {
                t.TProxyStopService();
            } catch (Throwable ignored) {
                // already stopped
            }
        }
        if (fd != null) {
            try {
                fd.close();
            } catch (Exception ignored) {
                // closed
            }
        }
        killClient();
    }

    private void killClient() {
        Process p;
        synchronized (lock) {
            p = client;
            client = null;
        }
        if (p != null) p.destroy();
    }

    // ---------- the notification ----------

    private void foreground(String text) {
        Notification n = note(text);
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTE_ID, n);
    }

    private void update() {
        if (!wanted) return;
        String text;
        switch (State.phase) {
            case ON:
                text = "Защищено" + (State.pingMs > 0 ? " · отклик " + State.pingMs + " мс" : "");
                break;
            case RETRYING:
                text = "Переподключаюсь…";
                break;
            default:
                text = "Подключаюсь…";
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTE_ID, note(text));
    }

    private Bitmap emblem;  // the winged shield, the notification's picture

    @SuppressWarnings("deprecation")
    private Notification note(String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "VPN", NotificationManager.IMPORTANCE_LOW);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this).setPriority(Notification.PRIORITY_LOW);
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent off = PendingIntent.getService(this, 1, new Intent(this, VpnSvc.class).setAction(STOP),
                PendingIntent.FLAG_IMMUTABLE);
        if (emblem == null) emblem = BitmapFactory.decodeResource(getResources(), R.drawable.emblem);
        return b.setSmallIcon(R.drawable.ic_stat)
                .setLargeIcon(emblem)
                .setContentTitle(profile != null ? profile.name : getString(R.string.app_name))
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .setShowWhen(false)
                .addAction(new Notification.Action.Builder(null, "Отключить", off).build())
                .build();
    }

    // ---------- small helpers ----------

    private long[] statsOrNull() {
        TProxyService t = hev;
        if (t == null) return null;
        try {
            return t.TProxyGetStats();
        } catch (Throwable e) {
            return null;
        }
    }

    private static boolean alive(Process p) {
        try {
            p.exitValue();
            return false;
        } catch (IllegalThreadStateException e) {
            return true;
        }
    }

    private boolean sleep(long ms) {
        try {
            Thread.sleep(ms);
            return wanted;
        } catch (InterruptedException e) {
            return false;
        }
    }

    private static int freePort() {
        try (ServerSocket s = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            return s.getLocalPort();
        } catch (Exception e) {
            return 10808;
        }
    }

    /** A YAML string: double quotes, with the backslash and the quote escaped. */
    private static String q(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }
}
