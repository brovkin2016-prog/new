package app.aihelper.vpn;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
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
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import org.json.JSONObject;

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
            worker = null;   // the old worker sees it is no longer the one and leaves, touching nothing
        }
        if (old != null) old.interrupt();
        stopParts();  // its client and tunnel go now: a ping or a lookup it is blocked in ends at once
        if (old != null) {
            try {
                old.join(3000);
            } catch (InterruptedException ignored) {
                // go on: it no longer acts once it notices
            }
        }
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

    private static final String NET_CHANGED = "Сеть сменилась.";
    private static final String MAPDNS = "198.18.0.2";
    static volatile boolean testMapdns;  // the emulator test only: the bridge's way with names, tried on the server
    private volatile boolean netChanged;
    private ConnectivityManager.NetworkCallback netWatch;

    @Override
    public void onCreate() {
        super.onCreate();
        // the phone moved to another network (Wi-Fi ↔ mobile): the connection is opened anew at once, not after a minute
        // of missed answers (this app is outside its own VPN, so its network is the phone's real one)
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (cm == null) return;
        netWatch = new ConnectivityManager.NetworkCallback() {
            private Network last;

            @Override
            public void onAvailable(Network n) {
                if (last != null && !last.equals(n)) {
                    netChanged = true;
                    Diag.i(VpnSvc.this, "network changed");
                }
                last = n;
            }
        };
        try {
            cm.registerDefaultNetworkCallback(netWatch);
        } catch (RuntimeException e) {
            netWatch = null;
        }
    }

    @Override
    public void onDestroy() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (cm != null && netWatch != null) {
            try {
                cm.unregisterNetworkCallback(netWatch);
            } catch (RuntimeException ignored) {
                // not registered
            }
        }
        boolean on;
        synchronized (lock) {
            on = wanted || worker != null;
        }
        if (on) stop(null);
        else stopParts();  // already stopped: the reason it stopped stays on the screen
        super.onDestroy();
    }

    /** This thread is the current worker and the VPN is still wanted. */
    private boolean mine() {
        synchronized (lock) {
            return wanted && worker == Thread.currentThread();
        }
    }

    // ---------- the work: connect, keep it up, say how it goes ----------

    private void run() {
        int fails = 0;
        State.set(State.Phase.CONNECTING, profile.bridge ? "Поднимаю мост через звонок Телемоста… до минуты" : "Подключаюсь к серверу…");
        if (socksPort == 0) socksPort = freePort();
        while (mine()) {
            Process[] own = {null};
            String err = profile.bridge ? startBridge(own) : startClient(own);
            if (err == null && mine()) {
                if (tun == null && !openTunnel()) {
                    killClient(own[0]);
                    return;
                }
                if (!mine()) {
                    killClient(own[0]);
                    break;
                }
                fails = 0;
                State.set(State.Phase.ON, "");
                Diag.i(this, "connected via " + profile.host);
                ping();
                err = watch(own[0]);
            }
            killClient(own[0]);  // only its own: a newer worker's client is not touched
            if (!mine()) break;
            if (NET_CHANGED.equals(err)) {  // not a failure: straight back on the new network
                fails = 0;
                Diag.i(this, "reconnecting on the new network");
                State.set(State.Phase.RETRYING, "Сеть сменилась — переподключаюсь…");
                update();
                if (!sleep(300)) break;
                continue;
            }
            fails++;
            Diag.i(this, "retry " + fails + ": " + err);
            State.set(tun == null ? State.Phase.CONNECTING : State.Phase.RETRYING, err + " Пробую снова…");
            update();
            if (!sleep(Math.min(30_000L, 1000L << Math.min(fails, 5)))) break;
        }
    }

    /** While the client runs: speeds every second, the response time every 20 s; null-free reason when it stopped. */
    private String watch(Process p) {
        long lastPing = SystemClock.elapsedRealtime(), lastStats = 0;
        long prevDown = 0, prevUp = 0;
        int missed = 0;
        netChanged = false;  // this connection was made on the network there is now
        while (mine()) {
            if (!sleep(1000)) return "";
            if (netChanged) {
                netChanged = false;
                // the bridge's call finds its way back by itself; the server's connection is made anew at once
                if (!profile.bridge) return NET_CHANGED;
            }
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
                Diag.i(this, "traffic down " + State.down + " up " + State.up + ", now " + Math.round(State.downRate / 1024)
                        + "/" + Math.round(State.upRate / 1024) + " KB/s" + (profile.bridge ? " (bridge)" : ""));
                Diag.upload(this, false);  // now and then the journal goes to the family server
                Updater.background(this, profile.bridge);  // a newer Winger: fetched now and then, put in while the screen is off
                if (!mine()) return "";  // switched off while it was pinging: the screen says «off», not «retrying»
                TProxyService t = hev;
                if (t == null || !t.TProxyIsRunning()) {
                    stopParts();  // the tunnel is opened anew on the next round
                    return "Туннель остановился.";
                }
                if (State.pingMs == 0) {
                    missed++;
                    State.set(State.Phase.RETRYING, "Сервер не отвечает…");
                    update();
                    // restart the client: a new network, a new path (the bridge first tries to get back into the call itself)
                    if (missed >= (profile.bridge ? 6 : 3)) return "Связь с сервером пропала.";
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
    private String startClient(Process[] own) {
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
                if (!wanted || worker != Thread.currentThread()) {
                    proc.destroy();
                    return "";
                }
                client = proc;
            }
            own[0] = proc;
            CountDownLatch up = connected;
            new Thread(() -> read(proc, up), "client-log").start();
            if (!up.await(20, TimeUnit.SECONDS)) return lastError != null ? lastError : "Сервер не отвечает.";
            return alive(proc) ? null : (lastError != null ? lastError : "Не удалось подключиться.");
        } catch (InterruptedException e) {
            return "";
        } catch (Exception e) {
            Diag.w(this, "client start", e);
            return "Не получилось запустить VPN на этом телефоне.";
        }
    }

    /**
     * The owner's bridge for days when only «white-listed» services work: the relay of the whitelist-bypass project
     * (MIT, built from vpn-app/bridge) joins the Yandex Telemost call the family server keeps open and carries the
     * traffic as the call's video; like the Hysteria client it offers a SOCKS5 port here. It asks this app for names
     * (RESOLVE:host — Android does not let it look them up) and takes the call's settings once it is ready.
     */
    private String startBridge(Process[] own) {
        Profile p = profile;
        lastError = null;
        connected = new CountDownLatch(1);
        try {
            String join = new JSONObject().put("joinLink", p.joinLink).put("displayName", "Участник")
                    .put("vp8Fps", p.fps).put("vp8Batch", p.batch).put("reliable", p.reliable).put("dualTrack", p.dualTrack)
                    .toString();
            ProcessBuilder pb = new ProcessBuilder(getApplicationInfo().nativeLibraryDir + "/librelay.so",
                    "--mode", "telemost-headless-joiner", "--ws-port", String.valueOf(freePort()),
                    "--socks-host", "127.0.0.1", "--socks-port", String.valueOf(socksPort))
                    .directory(dir).redirectErrorStream(true);
            pb.environment().put("HOME", dir.getAbsolutePath());
            Process proc = pb.start();
            synchronized (lock) {
                if (!wanted || worker != Thread.currentThread()) {
                    proc.destroy();
                    return "";
                }
                client = proc;
            }
            own[0] = proc;
            CountDownLatch up = connected;
            new Thread(() -> readBridge(proc, up, join), "bridge-log").start();
            if (!up.await(90, TimeUnit.SECONDS)) return lastError != null ? lastError : "Мост не поднялся: звонок не отвечает.";
            if (!alive(proc)) return lastError != null ? lastError : "Мост не поднялся.";
            // being in the call is not enough: the bridge counts only when a request really comes back through it
            State.set(State.Phase.CONNECTING, "Звонок есть. Проверяю, что через мост идут данные…");
            update();
            for (int i = 0; i < 4 && mine() && alive(proc); i++) {
                int ms = probe(10_000);
                if (ms > 0) {
                    Diag.i(this, "bridge: data flows, " + ms + " ms");
                    return null;
                }
            }
            if (!mine()) return "";
            Diag.i(this, "bridge: in the call, but nothing comes back through it (the server's side of the bridge is not there?)");
            Diag.upload(this, true, true);  // the journal goes now, past the bridge
            if (BridgeSync.refreshNow(this)) {
                Profile fresh = Profile.chosen(this);
                if (fresh != null && fresh.bridge && !fresh.link.equals(p.link)) {
                    synchronized (lock) {
                        if (worker == Thread.currentThread()) profile = fresh;
                    }
                    Diag.i(this, "bridge: the server gave a new call, trying it");
                    return "Мост на сервере сменил звонок — подключаюсь к новому.";
                }
            }
            return "Звонок есть, но мост на сервере не отвечает.";
        } catch (InterruptedException e) {
            return "";
        } catch (Exception e) {
            Diag.w(this, "bridge start", e);
            return "Не получилось запустить мост на этом телефоне.";
        }
    }

    private void readBridge(Process proc, CountDownLatch up, String join) {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8));
             Writer w = new OutputStreamWriter(proc.getOutputStream(), StandardCharsets.UTF_8)) {
            for (String line; (line = r.readLine()) != null; ) {
                if (line.startsWith("RESOLVE:")) {
                    String name = line.substring(8).trim(), ip = "";
                    try {
                        InetAddress[] all = InetAddress.getAllByName(name);
                        InetAddress a = all[0];
                        for (InetAddress x : all) if (x instanceof Inet4Address) { a = x; break; }
                        ip = a.getHostAddress();
                    } catch (Exception e) {
                        lastError = "Нет интернета: не найден «" + name + "».";
                    }
                    Diag.i(this, "bridge: resolve " + name + " -> " + ip);
                    w.write(ip + "\n");
                    w.flush();
                } else if (line.startsWith("STATUS:")) {
                    String st = line.substring(7).trim();
                    Diag.i(this, "bridge: " + st);
                    if (st.equals("READY")) {
                        w.write("JOIN:" + join + "\n");
                        w.flush();
                    } else if (st.equals("TUNNEL_CONNECTED")) {
                        up.countDown();
                    } else if (st.equals("TUNNEL_LOST") || st.equals("RECONNECTING")) {
                        if (up.getCount() == 0 && mine()) {
                            State.set(State.Phase.RETRYING, "Мост переподключается к звонку…");
                            update();
                        }
                    } else if (st.startsWith("ERROR:")) {
                        lastError = st.toLowerCase().contains("not found") || st.contains("404")
                                ? "Звонок моста не найден: попросите на сервере новую ссылку моста."
                                : "Мост не подключился к звонку Телемоста.";
                        proc.destroy();  // a new try from the start
                    }
                } else {
                    Diag.i(this, "relay: " + line);
                }
            }
        } catch (Exception ignored) {
            // the program ended
        }
        up.countDown();
    }

    private void read(Process proc, CountDownLatch up) {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) {
                Diag.i(this, "hy: " + line);
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
            fail("Нет разрешения на VPN: нажмите кнопку и разрешите.");
            return false;
        }
        try {
            // over the bridge the names are looked up on the server's side (the tunnel's own small DNS answers at once and
            // the connection carries the name): no separate trip through the call for each name, and no UDP needed for it
            boolean mapped = profile.bridge || testMapdns;
            Builder b = new Builder().setSession(profile.name).setMtu(8500)
                    .addAddress("198.18.0.1", 32).addRoute("0.0.0.0", 0);
            if (mapped) b.addDnsServer(MAPDNS);
            else b.addDnsServer("1.1.1.1").addDnsServer("8.8.8.8");
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
            Diag.i(this, allowed > 0 ? "through the VPN: " + only : "through the VPN: all apps");
            b.setConfigureIntent(PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                    PendingIntent.FLAG_IMMUTABLE));
            if (Build.VERSION.SDK_INT >= 29) b.setMetered(false);
            ParcelFileDescriptor fd = b.establish();
            if (fd == null) {
                fail("Нет разрешения на VPN: нажмите кнопку ещё раз и разрешите.");
                return false;
            }
            File conf = new File(dir, "tunnel.yaml");
            String y = "tunnel:\n  mtu: 8500\n  ipv4: 198.18.0.1\n  ipv6: 'fc00::1'\n"
                    + "socks5:\n  port: " + socksPort + "\n  address: 127.0.0.1\n  udp: 'udp'\n"
                    + (mapped ? "mapdns:\n  address: " + MAPDNS + "\n  port: 53\n  network: 100.64.0.0\n  netmask: 255.192.0.0\n"
                    + "  cache-size: 10000\n" : "")
                    + "misc:\n  task-stack-size: 81920\n  log-level: warn\n";
            try (FileOutputStream out = new FileOutputStream(conf)) {
                out.write(y.getBytes(StandardCharsets.UTF_8));
            }
            TProxyService t = new TProxyService();
            synchronized (lock) {
                if (!wanted || worker != Thread.currentThread()) {
                    fd.close();
                    return false;
                }
                tun = fd;
                hev = t;
            }
            if (!t.TProxyStartService(conf.getAbsolutePath(), fd.getFd())) {
                fail("Не получилось включить VPN на этом телефоне.");
                return false;
            }
            return true;
        } catch (Exception e) {
            Diag.w(this, "tunnel", e);
            fail("Не получилось включить VPN на этом телефоне.");
            return false;
        }
    }

    /** One request through the local proxy, so through the server or the bridge: its time in ms, 0 when none came back. */
    private int probe(int timeoutMs) {
        long t0 = SystemClock.elapsedRealtime();
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(PING_URL).openConnection(
                    new Proxy(Proxy.Type.SOCKS, new InetSocketAddress("127.0.0.1", socksPort)));
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setUseCaches(false);
            int code = c.getResponseCode();
            return code == 204 || code == 200 ? (int) Math.max(1, SystemClock.elapsedRealtime() - t0) : 0;
        } catch (Exception e) {
            return 0;  // no answer this time
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** The response time through the tunnel: the best of two quick requests; 0 when nothing came back. */
    private void ping() {
        int best = 0;
        for (int i = 0; i < 2; i++) {
            int ms = probe(8000);
            if (ms > 0) best = best == 0 ? ms : Math.min(best, ms);
        }
        State.pingMs = best;
        State.pingAt = System.currentTimeMillis();
        Diag.i(this, best > 0 ? "ping " + best + " ms" : "ping failed");
        State.fire();
        update();
    }

    // ---------- stopping ----------

    /** The worker's own failure stops the VPN, unless a newer start has already replaced this worker. */
    private void fail(String why) {
        if (mine()) stop(why);
    }

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
        Diag.i(this, "stopped" + (why != null ? ": " + why : ""));
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

    /** A worker's own client; the shared field is cleared only when it still points at it. */
    private void killClient(Process p) {
        if (p == null) return;
        synchronized (lock) {
            if (client == p) client = null;
        }
        p.destroy();
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
