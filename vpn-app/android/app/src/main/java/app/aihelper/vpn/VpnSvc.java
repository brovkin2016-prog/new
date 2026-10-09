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
import java.util.ArrayList;
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
    private Profile profile;   // the connection in use
    private Profile preferred; // the one the person chose; Winger goes back to it when it answers again
    private String tunnel = "dc";  // WB Stream / Bitrix: the data channel first, the video if it does not carry
    private long backAt, backWait = BACK_FIRST, returnedAt;
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
        // START, or the system (re)starting us for "always-on VPN"; «use»: the notification's switch to another connection
        String use = intent == null ? null : intent.getStringExtra("use");
        if (use != null) {
            List<Profile> all = Profile.all(this);
            for (int i = 0; i < all.size(); i++) if (all.get(i).link.equals(use)) Profile.select(this, i);
        }
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
            preferred = p;
            tunnel = p.tunnelMode.isEmpty() ? "dc" : p.tunnelMode;
            backWait = testBackMs > 0 ? testBackMs : BACK_FIRST;
            State.activeLink = p.link;
            State.auto = false;
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
    private static final String BACK = "Выбранный сервер снова отвечает.";
    private static final long BACK_FIRST = 10 * 60_000L, BACK_MAX = 2 * 3600_000L;
    private static final String MAPDNS = "198.18.0.2";
    static volatile boolean testMapdns;  // the emulator test only: the bridge's way with names, tried on the server
    static volatile long testBackMs;      // the emulator test only: how soon to look whether the chosen server is back
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
                    android.net.NetworkCapabilities c = cm.getNetworkCapabilities(n);
                    String kind = c == null ? "?" : c.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) ? "Wi-Fi"
                            : c.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR) ? "mobile" : "other";
                    Diag.i(VpnSvc.this, "network changed → " + kind);
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
        State.set(State.Phase.CONNECTING, profile.bridge ? "Поднимаю мост через " + service(profile) + "… до минуты" : "Подключаюсь к серверу…");
        if (socksPort == 0) socksPort = freePort();
        quickChoice();
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
                if (!profile.bridge && returnedAt > 0 && SystemClock.elapsedRealtime() - returnedAt > 30 * 60_000L) {
                    backWait = testBackMs > 0 ? testBackMs : BACK_FIRST;  // the chosen server held for a while: the usual wait again
                }
                State.set(State.Phase.ON, "");
                Diag.i(this, "connected via " + profile.host + (profile.bridge ? " (" + profile.platformOrDefault() + ", " + tunnel + ")" : ""));
                ping();
                err = watch(own[0]);
            }
            killClient(own[0]);  // only its own: a newer worker's client is not touched
            if (!mine()) break;
            if (BACK.equals(err)) {  // the chosen server answers again: back to it
                returnedAt = SystemClock.elapsedRealtime();
                switchTo(preferred, false, "Выбранный сервер снова отвечает — переключаюсь на него…");
                fails = 0;
                if (!sleep(300)) break;
                continue;
            }
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
            if (profile.bridge && "dc".equals(tunnel) && fails >= 2 && !profile.tunnelMode.isEmpty()) {
                tunnel = "video";  // the data channel does not carry here: the call's video does, a little slower
                fails = 0;
                Diag.i(this, "bridge: the data channel does not carry, trying the video");
                continue;
            }
            Profile next = fails >= 2 ? nextChoice() : null;
            if (next != null) {
                if (returnedAt > 0 && SystemClock.elapsedRealtime() - returnedAt < 10 * 60_000L) {
                    backWait = Math.min(BACK_MAX, backWait * 2);  // back too soon last time: wait longer before the next try
                }
                switchTo(next, true, (next.bridge ? "«" + profile.name + "» не отвечает — включаю мост через " + service(next)
                        : "«" + profile.name + "» не отвечает — пробую «" + next.name + "»") + "…");
                fails = 0;
                if (!sleep(500)) break;
                continue;
            }
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
                backAt = 0;  // another network: the chosen server may answer on it, look now
                // a phone may flip between Wi-Fi and mobile data, or its network may blink, without the connection
                // breaking (the server takes it from the new address): it is made anew only when nothing comes back
                // through it; the bridge's call finds its way back by itself
                if (!profile.bridge) {
                    if (!sleep(2000)) return "";
                    int ms = probe(6000);
                    if (ms == 0 && mine()) ms = probe(6000);
                    if (!mine()) return "";
                    if (ms == 0) return NET_CHANGED;
                    Diag.i(this, "network changed, the connection holds (" + ms + " ms)");
                }
            }
            Profile chosen = preferred;
            if (chosen != null && !chosen.bridge && !chosen.link.equals(profile.link) && Apps.autoBridge(this)) {
                long t = SystemClock.elapsedRealtime();
                if (backAt == 0 || t >= backAt) {
                    backAt = t + backWait;
                    if (probeServer(chosen)) return BACK;
                    if (!mine()) return "";
                }
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
        String y = clientConfig(p, host, socksPort);
        try (FileOutputStream out = new FileOutputStream(cfg)) {
            out.write(y.getBytes(StandardCharsets.UTF_8));
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

    /** The Hysteria client's settings for a server, its local SOCKS5 port given. */
    static String clientConfig(Profile p, String host, int port) {
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
        y.append("socks5:\n  listen: 127.0.0.1:").append(port).append('\n');
        return y.toString();
    }

    /**
     * Does the chosen server answer on this network now? A second, short-lived client tries it — past the VPN, as this
     * app is never inside its own tunnel — while the bridge keeps carrying everything.
     */
    private boolean probeServer(Profile p) {
        Process proc = null;
        try {
            String host = p.host;
            if (!host.matches("[0-9.]+") && !host.contains(":")) host = InetAddress.getByName(host).getHostAddress();
            File cfg = new File(dir, "probe.yaml");
            try (FileOutputStream out = new FileOutputStream(cfg)) {
                out.write(clientConfig(p, host, freePort()).getBytes(StandardCharsets.UTF_8));
            }
            ProcessBuilder pb = new ProcessBuilder(getApplicationInfo().nativeLibraryDir + "/libhysteria.so", "client", "-c",
                    cfg.getAbsolutePath()).directory(dir).redirectErrorStream(true);
            pb.environment().put("HYSTERIA_DISABLE_UPDATE_CHECK", "1");
            pb.environment().put("HYSTERIA_LOG_LEVEL", "info");
            pb.environment().put("HOME", dir.getAbsolutePath());
            Process pr = pb.start();
            proc = pr;
            CountDownLatch ok = new CountDownLatch(1);
            new Thread(() -> {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(pr.getInputStream(), StandardCharsets.UTF_8))) {
                    for (String line; (line = r.readLine()) != null; ) if (line.contains("connected to server")) ok.countDown();
                } catch (Exception ignored) {
                    // the probe ended
                }
            }, "probe-log").start();
            boolean up = ok.await(12, TimeUnit.SECONDS);
            Diag.i(this, "auto: «" + p.name + "» " + (up ? "answers again" : "still does not answer"));
            return up;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        } catch (Exception e) {
            return false;
        } finally {
            if (proc != null) proc.destroy();
        }
    }

    /**
     * At the start, when a bridge is there to fall back on: a server whose address the provider shut answers nothing at
     * all, and a minute of failed tries would go by before the move — each server is looked at once (a few seconds) and
     * the first one that answers, or else the bridge, is taken at once. The chosen server is looked at again later (BACK).
     */
    private void quickChoice() {
        if (profile.bridge || !Apps.autoBridge(this) || preferred == null || !preferred.link.equals(profile.link)) return;
        boolean bridge = false;
        for (Profile x : Profile.all(this)) bridge |= x.bridge;
        if (!bridge) return;
        Profile at = profile;
        for (int i = 0; i < 6 && !at.bridge && mine() && !probeServer(at); i++) {
            Profile next = nextChoice(at);
            if (next == null || next.link.equals(preferred.link)) return;
            at = next;
        }
        if (!mine() || at.link.equals(profile.link)) return;
        switchTo(at, true, (at.bridge ? "«" + profile.name + "» не отвечает в этой сети — включаю мост через " + service(at)
                : "«" + profile.name + "» не отвечает — пробую «" + at.name + "»") + "…");
    }

    /** The next connection to try when the one in use does not answer: the chosen one, other servers, then bridges. */
    private Profile nextChoice() {
        return nextChoice(profile);
    }

    private Profile nextChoice(Profile from) {
        if (!Apps.autoBridge(this) || preferred == null) return null;
        List<Profile> order = new java.util.ArrayList<>();
        order.add(preferred);
        for (Profile x : Profile.all(this)) if (!x.bridge && !x.link.equals(preferred.link)) order.add(x);
        for (Profile x : Profile.all(this)) if (x.bridge && !x.link.equals(preferred.link)) order.add(x);
        if (order.size() < 2) return null;
        int at = 0;
        for (int i = 0; i < order.size(); i++) if (order.get(i).link.equals(from.link)) at = i;
        return order.get((at + 1) % order.size());
    }

    /** Moves to another connection: the old one closes (its tunnel too — a bridge's has other settings), this one opens. */
    private void switchTo(Profile next, boolean byItself, String why) {
        synchronized (lock) {
            if (!wanted || worker != Thread.currentThread()) return;
            profile = next;
            tunnel = next.tunnelMode.isEmpty() ? "dc" : next.tunnelMode;
        }
        stopParts();
        State.activeLink = next.link;
        State.auto = byItself && preferred != null && !next.link.equals(preferred.link);
        backAt = SystemClock.elapsedRealtime() + backWait;
        Diag.i(this, "auto: " + why);
        State.set(State.Phase.CONNECTING, why);
        update();
    }

    /** «Телемоста», «WB Stream»… for the lines on the screen. */
    static String service(Profile p) {
        switch (p.platformOrDefault()) {
            case "wbstream":
                return "WB Stream";
            case "dion":
                return "DION";
            case "bitrix":
                return "Битрикс24";
            default:
                return "звонок Телемоста";
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
            String join = p.joinParams(tunnel);
            ProcessBuilder pb = new ProcessBuilder(getApplicationInfo().nativeLibraryDir + "/librelay.so",
                    "--mode", p.relayMode(), "--ws-port", String.valueOf(freePort()),
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
            State.set(State.Phase.CONNECTING, "Мост в звонке. Проверяю, что через него идут данные…");
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
                Profile fresh = null;  // this service's bridge as the server has it now
                for (Profile x : Profile.all(this)) if (x.bridge && x.platformOrDefault().equals(p.platformOrDefault())) fresh = x;
                if (fresh != null && !fresh.link.equals(p.link)) {
                    synchronized (lock) {
                        if (worker == Thread.currentThread()) {
                            if (preferred != null && preferred.link.equals(p.link)) preferred = fresh;
                            profile = fresh;
                        }
                    }
                    State.activeLink = fresh.link;
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
            // on a bridge the phone's own way to the family server is most likely shut as well (a mobile network open
            // only to a list of sites): the AI helper, which talks to that server alone, goes through the bridge too
            if (only != null && mapped && !only.contains(Apps.aiHelper)) {
                only = new ArrayList<>(only);
                only.add(Apps.aiHelper);
            }
            int allowed = 0;
            boolean ai = false;
            if (only != null) {
                for (String pkg : only) {
                    try {
                        b.addAllowedApplication(pkg);
                        allowed++;
                        ai |= pkg.equals(Apps.aiHelper);
                    } catch (PackageManager.NameNotFoundException ignored) {
                        // removed meanwhile (or the AI helper is not on this phone)
                    }
                }
            }
            if (ai && mapped) Diag.i(this, "the AI helper goes through the bridge too");
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
                text = "Защищено" + (State.pingMs > 0 ? " · отклик " + State.pingMs + " мс" : "")
                        + (State.auto ? " · сам перешёл: выбранный не отвечал" : "");
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
        b.setSmallIcon(R.drawable.ic_stat)
                .setLargeIcon(emblem)
                .setContentTitle(profile != null ? profile.name : getString(R.string.app_name))
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .setShowWhen(false)
                .addAction(new Notification.Action.Builder(null, "Отключить", off).build());
        // one tap to the other kind of connection: to a bridge from the server, to the server from a bridge
        Profile now = profile, other = null;
        if (now != null && now.bridge) {  // back to a server: the chosen one when it is one, else the first server
            if (preferred != null && !preferred.bridge) other = preferred;
            else for (Profile x : Profile.all(this)) if (!x.bridge) { other = x; break; }
        } else if (now != null) {
            for (Profile x : Profile.all(this)) if (x.bridge) { other = x; break; }
        }
        if (other != null) {
            Intent go = new Intent(this, VpnSvc.class).setAction(START).putExtra("use", other.link);
            PendingIntent sw = Build.VERSION.SDK_INT >= 26
                    ? PendingIntent.getForegroundService(this, 2, go, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)
                    : PendingIntent.getService(this, 2, go, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            b.addAction(new Notification.Action.Builder(null, other.bridge ? "Через мост" : "Через сервер", sw).build());
        }
        return b.build();
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

    static int freePort() {
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
