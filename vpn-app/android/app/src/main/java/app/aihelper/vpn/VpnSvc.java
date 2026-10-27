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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
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
    static final String PING_URL = "http://cp.cloudflare.com/generate_204";

    static volatile int socksPort;  // the client's local port while the VPN is on (the app's own update check uses it)

    private final Object lock = new Object();
    // the old connection is closed and the new one opened here, one switch after another, not on the screen's thread
    private final ExecutorService switcher = Executors.newSingleThreadExecutor();
    private int asked;  // under lock: every start and stop counts it up; a switch that is no longer the newest does nothing
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
    private volatile long captchaAt;  // when VK asked for «I am not a robot» on this start (0: it did not)
    private volatile boolean noData;  // this start got into the call, but nothing came back through it
    private int dcFails;  // starts in a row the quicker way did not carry (only those, not a lost network)
    private long fellBackAt;  // when it went to the slower way (it tries the quicker one again after a while)
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
        int my;
        synchronized (lock) {
            if (!again && wanted && profile != null && profile.link.equals(p.link)) {
                wake = true;  // (waiting after a round with nothing carrying: once more now)
                update();  // already on with it: the notification says «Подключаюсь…» from foreground() above, put back how it is
                return START_STICKY;
            }
            old = worker;
            wanted = false;  // another server was chosen: the old connection goes first
            worker = null;   // the old worker sees it is no longer the one and leaves, touching nothing
            my = ++asked;
        }
        if (old != null) old.interrupt();
        switcher.execute(() -> open(p, old, my));
        return START_STICKY;
    }

    /** Waits for the old connection to go (up to 3 s), then opens the chosen one, unless it was stopped or changed meanwhile. */
    private void open(Profile p, Thread old, int my) {
        stopParts();  // its client and tunnel go now: a ping or a lookup it is blocked in ends at once
        if (old != null) {
            try {
                old.join(3000);
            } catch (InterruptedException ignored) {
                // go on: it no longer acts once it notices
            }
        }
        synchronized (lock) {
            if (asked != my) return;  // switched off, or another connection chosen, while the old one was going
            profile = p;
            preferred = p;
            tunnel = p.tunnelMode.isEmpty() ? "dc" : p.tunnelMode;
            fellBackAt = 0;
            if ("dc".equals(p.tunnelMode) && "video".equals(Scout.mode(this, p))) {
                tunnel = "video";  // (v34) here only the call's video carried lately: the quicker way tried again in half an hour
                fellBackAt = SystemClock.elapsedRealtime();
            }
            backWait = testBackMs > 0 ? testBackMs : BACK_FIRST;
            State.activeLink = p.link;
            State.auto = false;
            wanted = true;
            dir = getFilesDir();
            worker = new Thread(this::run, "vpn");
            worker.start();
        }
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
            asked++;  // a switch still waiting does not open anything on a closed service
        }
        if (on) stop(null);
        else stopParts();  // already stopped: the reason it stopped stays on the screen
        unwatchScreen();
        switcher.shutdown();
        super.onDestroy();
    }

    /** This thread is the current worker and the VPN is still wanted. */
    private static final String NEW_CALL = "Мост на сервере сменил звонок — подключаюсь к новому.";
    private volatile boolean wake;  // pressed again while it waits after a round with nothing carrying: try at once
    private volatile boolean carried;  // the connection in use has carried a request (not just shaken hands)

    /** How many ways one turn has: the servers and the bridges, the chosen one included. */
    private int autoLimit() {
        return Math.max(2, Profile.all(this).size());
    }

    private boolean mine() {
        synchronized (lock) {
            return wanted && worker == Thread.currentThread();
        }
    }

    // ---------- the work: connect, keep it up, say how it goes ----------

    private void run() {
        int fails = 0;
        int autoMisses = 0;  // ways tried by itself in a row, none of them carrying
        State.set(State.Phase.CONNECTING, profile.bridge ? "Поднимаю мост через " + service(profile) + "… до минуты" : "Подключаюсь к серверу…");
        if (socksPort == 0) socksPort = freePort();
        quickChoice();
        while (mine()) {
            Process[] own = {null};
            if (profile.bridge && "video".equals(tunnel) && fellBackAt > 0 && SystemClock.elapsedRealtime() - fellBackAt > 30 * 60_000L
                    && !profile.tunnelMode.isEmpty() && !"video".equals(profile.tunnelMode)) {
                tunnel = profile.tunnelMode;  // half an hour on the slower way: the quicker one may carry again
                fellBackAt = 0;
                Diag.i(this, "bridge: trying the quicker way again");
            }
            long since = 0;
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
                // a bridge is «in» only once data came back through it; the server's handshake alone proves nothing (a
                // white-list lets it through and then nothing more): its failures are forgotten only after a real answer
                if (profile.bridge) fails = 0;
                carried = false;
                if (!profile.bridge && returnedAt > 0 && SystemClock.elapsedRealtime() - returnedAt > 30 * 60_000L) {
                    backWait = testBackMs > 0 ? testBackMs : BACK_FIRST;  // the chosen server held for a while: the usual wait again
                }
                since = SystemClock.elapsedRealtime();
                State.set(State.Phase.ON, "");
                watchScreen();  // (v37) asleep the connection holds: the processor kept awake while the screen is off
                Diag.i(this, "connected via " + profile.host + (profile.bridge ? " (" + profile.platformOrDefault() + ", " + profile.modeLabel(tunnel) + ")" : ""));
                ping();
                err = watch(own[0]);
                // it did carry, and for a while (a white-list may let the very first requests through): a failure now is a
                // new one, not the same again
                if (carried && SystemClock.elapsedRealtime() - since >= 2 * 60_000L) {
                    fails = 0;
                    autoMisses = 0;
                }
            }
            killClient(own[0]);  // only its own: a newer worker's client is not touched
            captchaDone();  // its program is gone: so is the check page it showed
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
                autoMisses = 0;  // another network: the ways are new again
                Diag.i(this, "reconnecting on the new network");
                State.set(State.Phase.RETRYING, "Сеть сменилась — переподключаюсь…");
                update();
                if (!sleep(300)) break;
                continue;
            }
            fails++;
            Diag.i(this, "retry " + fails + ": " + err);
            if (!profile.bridge && fails == 1 && moved(profile)) {  // at its new address: no failure, straight on
                fails = 0;
                if (!sleep(300)) break;
                continue;
            }
            if (profile.bridge && "dc".equals(tunnel) && !profile.tunnelMode.isEmpty()) {
                // the quicker way's own failures only: in the call and nothing came back, or a session that died soon
                // (a lost network, a new call from the server or a slow captcha are not its fault)
                long held = since > 0 ? SystemClock.elapsedRealtime() - since : -1;
                if (noData || (held >= 0 && held < 5 * 60_000L)) dcFails++;
                else if (held >= 5 * 60_000L) dcFails = 0;
            }
            if (profile.bridge && "dc".equals(tunnel) && dcFails >= 2 && !profile.tunnelMode.isEmpty()) {
                tunnel = "video";  // the data channel does not carry here: the call's video does, a little slower
                fellBackAt = SystemClock.elapsedRealtime();
                dcFails = 0;
                fails = 0;
                Diag.i(this, "dion".equals(profile.platform) ? "bridge: DION does not carry at the higher speed, back to its usual one"
                        : "bridge: the data channel does not carry, trying the video");
                continue;
            }
            Profile next = fails >= 2 ? nextChoice() : null;
            // (this network's word, once the next one is chosen: put last now, the failed bridge would bring the dead chosen
            // server back between each two bridges; a new call from the server has not been tried yet)
            if (profile.bridge && fails >= 1 && !NEW_CALL.equals(err)) Scout.record(this, profile, noData ? "no_data" : "error", 0);
            if (next != null && ++autoMisses > autoLimit()) {
                // every way tried in turn and none carried: no running round and round — a longer wait, then once more (at
                // once on another network, or when the connection is pressed again)
                autoMisses = 0;
                Diag.i(this, "auto: nothing carries here now — waiting 5 minutes before trying again");
                State.set(State.Phase.RETRYING, "Сейчас не работает ни одно подключение — попробую снова через 5 минут…");
                update();
                netChanged = false;
                wake = false;
                long until = SystemClock.elapsedRealtime() + 5 * 60_000L;
                boolean on = true;
                while (on && !netChanged && !wake && SystemClock.elapsedRealtime() < until) on = sleep(2000);
                if (!on) break;
                if (netChanged || wake) Diag.i(this, netChanged ? "auto: the network changed — trying again now" : "auto: pressed again — trying again now");
                fails = 0;
                continue;
            }
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
                long kbDown = Math.round(State.downRate / 1024), kbUp = Math.round(State.upRate / 1024);
                // a quiet line every 20 s filled the journal (a day of it is what the server keeps): written when
                // something goes through, else every 5 minutes
                if (kbDown + kbUp > 0 || now - lastTrafficLog >= 5 * 60_000L) {
                    lastTrafficLog = now;
                    Diag.i(this, "traffic down " + State.down + " up " + State.up + ", now " + kbDown + "/" + kbUp + " KB/s"
                            + (profile.bridge ? " (bridge)" : ""));
                }
                Diag.upload(this, false);  // now and then the journal goes to the family server
                Updater.background(this, profile.bridge);  // a newer Winger: fetched now and then, put in while the screen is off
                BridgeCheck.poll(this);  // the family server's Claude may want the bridges checked from this phone (the owner's)
                if (State.pingMs > 0) Scout.maybe(this, profile);  // (v32) which other bridges carry here now
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
        // a phone that dozes a little (Xiaomi, Android power saving) keeps its connection: the server waits as long.
        // (v37) Hysteria 2.11+ looks like Chrome by default and then fixes the wait at 30 s: behind salamander nothing of
        // it shows anyway, so there it is off and the 90 s hold; a plain door keeps the look (its keep-alive every 10 s
        // and the processor kept awake hold it)
        y.append("quic:\n  keepAlivePeriod: 10s\n  maxIdleTimeout: 90s\n");
        if ("salamander".equalsIgnoreCase(p.obfs)) y.append("  disableChromeParrot: true\n");
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
            int port = freePort();
            try (FileOutputStream out = new FileOutputStream(cfg)) {
                out.write(clientConfig(p, host, port).getBytes(StandardCharsets.UTF_8));
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
            // the handshake, then a request through it: a white-list lets the first through and stops the rest
            boolean shook = ok.await(12, TimeUnit.SECONDS);
            boolean up = shook && (Speed.probe(port, 8000) > 0 || sleep(500) && Speed.probe(port, 8000) > 0);  // (its SOCKS port may open a moment later)
            Diag.i(this, "auto: «" + p.name + "» " + (up ? "answers again" : shook ? "shakes hands but carries nothing" : "still does not answer"));
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
    private static volatile String pickedLink;
    private static volatile long pickedAt;

    /** (v34) The person tapped this connection just now: it is tried first, whatever this network said of it lately. */
    static void picked(String link) {
        pickedLink = link;
        pickedAt = SystemClock.elapsedRealtime();
    }

    private void quickChoice() {
        if (!Apps.autoBridge(this) || preferred == null || !preferred.link.equals(profile.link)) return;
        boolean byHand = profile.link.equals(pickedLink) && SystemClock.elapsedRealtime() - pickedAt < 30_000L;
        if (byHand && Boolean.FALSE.equals(Scout.carries(this, profile))) {
            Diag.i(this, "auto: «" + profile.name + "» chosen by hand — tried first, though it did not carry here lately");
        } else if (Boolean.FALSE.equals(Scout.carries(this, profile))) {
            // (v32) the chosen one was just seen not carrying on this network and another one was seen carrying: that one
            // first, no two failed tries on the chosen one before it
            Profile best = Scout.best(this, profile);
            if (best != null && mine()) {
                switchTo(best, true, (best.bridge ? "«" + profile.name + "» не работает в этой сети — включаю мост через " + service(best)
                        : "«" + profile.name + "» не работает в этой сети — пробую «" + best.name + "»") + "…");
                return;
            }
        }
        if (profile.bridge) return;
        boolean bridge = false;
        for (Profile x : Profile.all(this)) bridge |= x.bridge;
        if (!bridge) return;
        Profile at = profile;
        for (int i = 0; i < 6 && !at.bridge && mine() && !probeServer(at); i++) {
            if (i == 0 && moved(at)) return;  // the chosen server is there, at its new address
            Profile next = nextChoice(at);
            if (next == null || next.link.equals(preferred.link)) return;
            at = next;
        }
        if (!mine() || at.link.equals(profile.link)) return;
        switchTo(at, true, (at.bridge ? "«" + profile.name + "» не отвечает в этой сети — включаю мост через " + service(at)
                : "«" + profile.name + "» не отвечает — пробую «" + at.name + "»") + "…");
    }

    /**
     * The family server may have moved to a new address (its name follows it): the saved link is renewed from the server
     * and, when the server answers there, used. True when it switched to it.
     */
    private boolean moved(Profile p) {
        Profile fresh = BridgeSync.renewNow(this, p);
        if (fresh == null || !mine() || !probeServer(fresh)) return false;
        synchronized (lock) {
            if (preferred != null && preferred.link.equals(p.link)) preferred = fresh;
        }
        switchTo(fresh, false, "Сервер переехал на новый адрес — подключаюсь по новому…");
        return true;
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
        // the bridges (v32): those carrying here now by the scout first, then the one that last carried data (in the last
        // 3 days), those just seen failing here last (Scout.rank) — not a slow or dead one before a working one
        android.content.SharedPreferences v = getSharedPreferences("vpn", MODE_PRIVATE);
        String good = System.currentTimeMillis() - v.getLong("goodBridgeAt", 0) < 3 * 86_400_000L ? v.getString("goodBridge", "") : "";
        List<Profile> bridges = new java.util.ArrayList<>();
        for (Profile x : Profile.all(this)) if (x.bridge && !x.link.equals(preferred.link)) bridges.add(x);
        order.addAll(Scout.rank(this, bridges, good));
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
            dcFails = 0;
            fellBackAt = 0;
            if ("dc".equals(next.tunnelMode) && "video".equals(Scout.mode(this, next))) {
                tunnel = "video";  // (v34) here only the call's video carried lately: the quicker way tried again in half an hour
                fellBackAt = SystemClock.elapsedRealtime();
            }
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
            case "vk":
                return "VK";
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
        captchaAt = 0;
        noData = false;
        connected = new CountDownLatch(1);
        Thread me = Thread.currentThread();
        try {
            String join = p.joinVerb() + p.joinParams(tunnel);
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
            new Thread(() -> readBridge(proc, up, join, me, p), "bridge-log").start();
            long deadline = SystemClock.elapsedRealtime() + 90_000;
            while (!up.await(1, TimeUnit.SECONDS)) {  // a VK check («I am not a robot») gets five minutes for the person
                if (captchaAt > 0) deadline = Math.max(deadline, captchaAt + 300_000);
                if (!mine()) return "";
                if (SystemClock.elapsedRealtime() > deadline) return lastError != null ? lastError : "Мост не поднялся: звонок не отвечает.";
            }
            if (!alive(proc)) return lastError != null ? lastError : "Мост не поднялся.";
            // being in the call is not enough: the bridge counts only when a request really comes back through it
            State.set(State.Phase.CONNECTING, "Мост в звонке. Проверяю, что через него идут данные…");
            update();
            for (int i = 0; i < 4 && mine() && alive(proc); i++) {
                int ms = probe(10_000);
                if (ms > 0) {
                    Diag.i(this, "bridge: data flows, " + ms + " ms");
                    // the bridge that really carried (this one, still the worker's): first next time the server does not answer
                    if (mine()) getSharedPreferences("vpn", MODE_PRIVATE).edit().putString("goodBridge", p.link)
                            .putLong("goodBridgeAt", System.currentTimeMillis()).apply();
                    Scout.record(this, Scout.net(this), p, "ok", ms, "video".equals(tunnel) && "dc".equals(p.tunnelMode) ? "video" : "");
                    return null;
                }
            }
            if (!mine()) return "";
            Diag.i(this, "bridge: in the call, but nothing comes back through it (the server's side of the bridge is not there?)");
            noData = true;
            BridgeSync.stuck(this, p, "in the call, nothing comes back");  // the server restarts its side; the next try may work
            Diag.upload(this, true, true);  // the journal goes now, past the bridge
            if (BridgeSync.refreshNow(this)) {
                Profile fresh = null;  // this service's bridge as the server has it now
                for (Profile x : Profile.all(this)) if (x.bridge && x.platformOrDefault().equals(p.platformOrDefault()) && x.dualTrack == p.dualTrack) fresh = x;
                if (fresh != null && !fresh.link.equals(p.link)) {
                    synchronized (lock) {
                        if (worker == Thread.currentThread()) {
                            if (preferred != null && preferred.link.equals(p.link)) preferred = fresh;
                            profile = fresh;
                        }
                    }
                    State.activeLink = fresh.link;
                    Diag.i(this, "bridge: the server gave a new call, trying it");
                    noData = false;  // not the way's fault: another call
                    return NEW_CALL;
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

    /** The relay's line for each connection through the bridge: counted, not written one by one (tens a second would push
     *  the bridges' own story — which one was tried, why it failed — out of the journal). */
    private static final java.util.regex.Pattern CHATTER = java.util.regex.Pattern.compile("relay(\\[\\w+\\])?: (SOCKS |drop msgType)");

    private boolean mine(Thread t) {
        synchronized (lock) {
            return wanted && worker == t;
        }
    }

    private void readBridge(Process proc, CountDownLatch up, String join, Thread owner, Profile p) {
        int[] n = new int[3];  // connections asked for, opened, given no answer by the far side
        long[] since = {SystemClock.elapsedRealtime()};
        long[] silent = {0};  // when the server's side last left the tunnel unanswered (the relay rejoins then)
        try (BufferedReader r = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8));
             Writer w = new OutputStreamWriter(proc.getOutputStream(), StandardCharsets.UTF_8)) {
            for (String line; (line = r.readLine()) != null; ) {
                if (CHATTER.matcher(line).find()) {
                    if (line.contains(" TIMEOUT")) n[2]++;
                    else if (line.contains("SOCKS CONNECTED")) n[1]++;
                    else if (line.contains("SOCKS CONNECT ")) n[0]++;
                    if (SystemClock.elapsedRealtime() - since[0] >= 20_000) chatter(n, since);
                    continue;
                }
                chatter(n, since);
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
                        w.write(join + "\n");
                        w.flush();
                    } else if (st.startsWith("CAPTCHA:")) {
                        captcha(st.substring(8).trim());  // VK wants a person: «I am not a robot», shown on this phone
                    } else if (st.startsWith("Captcha solved")) {  // VK took the tick (its page itself shows no change)
                        captchaDone();
                        if (mine(owner)) {
                            State.set(State.Phase.CONNECTING, "Проверка VK пройдена — вхожу в звонок…");
                            update();
                        }
                    } else if (st.equals("TUNNEL_CONNECTED")) {
                        captchaDone();
                        up.countDown();
                    } else if (st.equals("TUNNEL_LOST") || st.equals("RECONNECTING")) {
                        if (up.getCount() == 0 && mine(owner)) {  // (this thread is the log's: whose start it is, it is told)
                            State.set(State.Phase.RETRYING, "Мост переподключается к звонку…");
                            update();
                        }
                    } else if (st.startsWith("ERROR:")) {
                        lastError = st.toLowerCase().contains("not found") || st.contains("404")
                                ? "Звонок моста не найден: попросите на сервере новую ссылку моста."
                                : "Мост не подключился к звонку (" + service(profile) + ").";
                        BridgeSync.stuck(this, p, st);  // («organizer not in the room»: the server's side is not in its call)
                        proc.destroy();  // a new try from the start
                    }
                } else {
                    Diag.i(this, "relay: " + line);
                    if (line.contains("has not answered the reliable tunnel")) {
                        long now = SystemClock.elapsedRealtime();
                        if (silent[0] > 0 && now - silent[0] < 5 * 60_000L) BridgeSync.stuck(this, p, "the server's side does not answer the tunnel");
                        silent[0] = now;
                    }
                }
            }
        } catch (Exception ignored) {
            // the program ended
        }
        chatter(n, since);
        up.countDown();
    }

    private static final int CAPTCHA_NOTE = 7002;

    /**
     * VK lets the bridge into its call as a guest, but now and then asks for «I am not a robot» first. The bridge's
     * program shows that check on a page of its own on this phone (127.0.0.1): Winger's own window shows it (at once
     * when Winger is on the screen, else from the notice); once it is passed the bridge goes on by itself.
     */
    private void captcha(String url) {
        if (!url.matches(CaptchaActivity.LOCAL)) return;  // only the bridge program's own page
        captchaAt = SystemClock.elapsedRealtime();
        Diag.i(this, "bridge: VK asks to confirm a person (captcha), Winger shows it");
        State.captcha = url;
        State.set(State.Phase.CONNECTING, "VK просит подтвердить, что вы не робот: откройте Winger или уведомление «Мост VK».");
        update();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            if (nm.getNotificationChannel("captcha") == null) {
                nm.createNotificationChannel(new NotificationChannel("captcha", "Подтверждения для моста", NotificationManager.IMPORTANCE_HIGH));
            }
            b = new Notification.Builder(this, "captcha");
        } else {
            b = new Notification.Builder(this);
        }
        Intent view = new Intent(this, CaptchaActivity.class).putExtra(CaptchaActivity.URL, url)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent open = PendingIntent.getActivity(this, 8, view, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        nm.notify(CAPTCHA_NOTE, b.setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("Мост VK: подтвердите, что вы не робот")
                .setContentText("Нажмите — проверка VK откроется в Winger, после неё мост подключится сам")
                .setContentIntent(open)
                .setAutoCancel(true)
                .build());
    }

    private void captchaDone() {
        if (!State.captcha.isEmpty()) {
            State.captcha = "";
            State.fire();  // Winger's check window closes
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(CAPTCHA_NOTE);
    }

    /** The counted connections since the last time, as one line of the journal. */
    private void chatter(int[] n, long[] since) {
        if (n[0] + n[1] + n[2] > 0) {
            Diag.i(this, "relay: connections asked for " + n[0] + ", opened " + n[1] + ", no answer from the far side " + n[2]
                    + " (" + (SystemClock.elapsedRealtime() - since[0]) / 1000 + " s)");
        }
        n[0] = n[1] = n[2] = 0;
        since[0] = SystemClock.elapsedRealtime();
    }

    private void read(Process proc, CountDownLatch up) {
        long v6Since = 0;
        int v6 = 0;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = r.readLine()) != null; ) {
                // a site with an IPv6 address is tried that way first; a server without IPv6 says no at once and the
                // app goes on by IPv4: one line a minute, not dozens
                if (line.contains("dial tcp6") && line.contains("network is unreachable")) {
                    long now = SystemClock.elapsedRealtime();
                    if (v6 > 0 && now - v6Since < 60_000) {
                        v6++;
                        continue;
                    }
                    if (v6 > 1) Diag.i(this, "hy: " + (v6 - 1) + " more IPv6 tries in that minute");
                    Diag.i(this, "hy: a site was asked by IPv6, the server has none: the apps go on by IPv4 (said once a minute)");
                    v6Since = now;
                    v6 = 1;
                    continue;
                }
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
            List<String> only = Apps.through(this, profile.bridge);  // the server's list or the bridge's — or null: everything
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
            Diag.i(this, (profile.bridge ? "through the bridge: " : "through the server: ") + (allowed > 0 ? only : "all apps"));
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

    private long lastTrafficLog, lastPingLogAt;
    private int lastPingLogged;

    /** The response time through the tunnel: the best of two quick requests; 0 when nothing came back. */
    private void ping() {
        int best = 0;
        for (int i = 0; i < 2; i++) {
            int ms = probe(8000);
            if (ms > 0) best = best == 0 ? ms : Math.min(best, ms);
        }
        if (best > 0) carried = true;
        State.pingMs = best;
        State.pingAt = System.currentTimeMillis();
        Profile p = profile;
        if (p != null) Speed.savePing(this, p, best);  // its row keeps it, also once another connection is in use
        long now = SystemClock.elapsedRealtime();  // a steady one every 5 minutes; a change (half as much again) at once
        if (best == 0 || lastPingLogged == 0 || Math.abs(best - lastPingLogged) * 2 > lastPingLogged || now - lastPingLogAt >= 5 * 60_000L) {
            lastPingLogged = best;
            lastPingLogAt = now;
            Diag.i(this, best > 0 ? "ping " + best + " ms" : "ping failed");
        }
        State.fire();
        update();
    }

    // ---------- stopping ----------

    /** The worker's own failure stops the VPN, unless a newer start has already replaced this worker. */
    private void fail(String why) {
        if (mine()) stop(why);
    }

    // ---------- (v37) «Не рвать во сне»: the processor awake while the VPN is on and the screen is off ----------
    // Asleep, the phone stops the client's keep-alive: after 30–90 s the server and the operator's NAT forget the
    // connection, and nothing reaches the phone until it wakes. A partial wake lock (the screen stays off) only while
    // connected with the screen off; released when the screen comes on, the VPN goes off or the setting is off.
    private android.os.PowerManager.WakeLock awake;
    private android.content.BroadcastReceiver screen;

    private void keepAwake(boolean screenOff) {
        boolean on = Apps.keepAwake(this);
        synchronized (lock) {
            boolean want = screenOff && wanted && on;
            if (want && awake == null) {
                android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
                if (pm == null) return;
                awake = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "winger:tunnel");
                awake.setReferenceCounted(false);
                awake.acquire();
                Diag.i(this, "screen off: kept awake (the connection holds)");
            } else if (!want && awake != null) {
                if (awake.isHeld()) awake.release();
                awake = null;
            }
        }
    }

    private void watchScreen() {
        synchronized (lock) {
            if (screen != null) return;
            screen = new android.content.BroadcastReceiver() {
                @Override
                public void onReceive(android.content.Context c, Intent i) {
                    keepAwake(Intent.ACTION_SCREEN_OFF.equals(i.getAction()));
                }
            };
            android.content.IntentFilter f = new android.content.IntentFilter(Intent.ACTION_SCREEN_OFF);
            f.addAction(Intent.ACTION_SCREEN_ON);
            registerReceiver(screen, f);
        }
        android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
        keepAwake(pm != null && !pm.isInteractive());  // started with the screen already off (after a reboot)
    }

    private void unwatchScreen() {
        synchronized (lock) {
            if (screen != null) {
                try {
                    unregisterReceiver(screen);
                } catch (RuntimeException ignored) {
                    // not registered
                }
                screen = null;
            }
        }
        keepAwake(false);
    }

    private void stop(String why) {
        unwatchScreen();
        synchronized (lock) {
            asked++;  // a switch still waiting does not open anything after this
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
        captchaDone();  // off or another connection: the check page of the bridge program is gone
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
