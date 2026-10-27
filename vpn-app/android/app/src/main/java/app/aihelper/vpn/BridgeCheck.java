package app.aihelper.vpn;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.telephony.TelephonyManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The owner's check of the bridges from this phone, asked by the family server's Claude («проверь мосты») or by the
 * button: on the phone's own network (past the VPN, as the operator lets things through) it looks at the sites a
 * white-list lets in or not — Google, Yandex, the call services, the family server — and tries each bridge in a short
 * call of its own: in the call or not, data through it, its response and speed. The report goes to the family server
 * (Claude reads it with srv-phone) and stays here. The bridge in use now is not joined again — one call carries one
 * device, the two would push each other out — its live state is told instead.
 */
final class BridgeCheck {
    static final AtomicBoolean running = new AtomicBoolean();
    static final String QUICK = "quick";    // (v32) the button before connecting: which carry here, no speed, no report
    static volatile long quickAt;           // when the last quick look ended
    static volatile String progress = "";  // what it is doing now, for the notification
    static volatile boolean fresh;         // a report came since the screen last showed one
    static long joinMs = 50_000;            // how long a bridge gets to get into its call (the emulator test: less)
    private static final long POLL_MS = 3 * 60_000L;
    private static volatile long polledAt, startedAt;
    private static final String FILE = "bridge-check.json";

    // the sites: outside a white-list (Google), inside it (Yandex), and the call services the bridges go through
    private static final String[][] SITES = {
            {"Google — вне белых списков", "https://www.gstatic.com/generate_204"},
            {"Яндекс", "https://ya.ru/"},
            {"Телемост", "https://telemost.yandex.ru/"},
            {"Телемост API", "https://cloud-api.yandex.ru/"},
            {"VK", "https://vk.ru/"},
            {"VK API (вход в звонок VK)", "https://api.vk.ru/"},
            {"VK вход", "https://login.vk.ru/"},
            {"WB Stream", "https://stream.wb.ru/"},
            {"DION", "https://dion.vc/"},
            {"DION API", "https://api.dion.vc/"},
            {"Битрикс24", "https://auth2.bitrix24.net/"},
    };

    private BridgeCheck() {}

    /** Starts a check on a thread of its own (one at a time); task: the server's id of the ask, "" for the button. */
    static boolean start(Context ctx, String task, Runnable done) {
        if (!running.compareAndSet(false, true)) return false;
        Context c = ctx.getApplicationContext();
        startedAt = System.currentTimeMillis();
        new Thread(() -> {
            try {
                JSONObject r = run(c, task == null ? "" : task);
                if (QUICK.equals(task)) {
                    quickAt = System.currentTimeMillis();  // its word is in each connection's button (Scout)
                } else {
                    save(c, r);
                    fresh = true;
                    progress = "Отправляю отчёт…";
                }
                State.fire();
            } catch (Exception e) {
                Diag.w(c, "bridge check", e);
            } finally {
                progress = "";
                running.set(false);
                State.fire();
                if (done != null) done.run();
            }
        }, "bridge-check").start();
        return true;
    }

    /** When the last check started (ms), 0: none since Winger started. */
    static long lastStart() {
        return startedAt;
    }

    /** While the VPN is on: now and then (every 3 min) asks the family server whether its Claude wants a check. */
    static void poll(Context ctx) {
        long now = System.currentTimeMillis();
        if (running.get() || now - polledAt < POLL_MS || !Rescue.shown(ctx)) return;
        polledAt = now;
        Context c = ctx.getApplicationContext();
        new Thread(() -> {
            String task = askTask(c);
            if (task != null && !task.isEmpty() && !task.equals(c.getSharedPreferences("vpn", Context.MODE_PRIVATE).getString("checkTask", ""))) {
                Diag.i(c, "bridge check: the server asks for one");
                start(c, task, null);
            }
            sendPending(c);
        }, "check-poll").start();
    }

    // ---------- the check ----------

    static JSONObject run(Context c, String task) throws Exception {
        long t0 = SystemClock.elapsedRealtime();
        boolean quick = QUICK.equals(task);
        if (!task.isEmpty() && !quick) c.getSharedPreferences("vpn", Context.MODE_PRIVATE).edit().putString("checkTask", task).apply();
        Diag.i(c, "bridge check: started" + (quick ? " (before connecting: which carry here)" : task.isEmpty() ? " (the button)" : " (the server's ask)"));
        JSONObject r = new JSONObject().put("v", 1).put("task", task).put("at", System.currentTimeMillis() / 1000)
                .put("app", BuildConfig.VERSION_NAME).put("device", Build.MANUFACTURER + " " + Build.MODEL)
                .put("android", Build.VERSION.RELEASE).put("net", network(c)).put("vpn", vpn(c));
        List<Profile> all = Profile.all(c);
        if (!quick) r.put("sites", sites(c, all));
        // the servers (Hysteria and its salamander door), then the bridges one after another
        JSONArray servers = new JSONArray(), bridges = new JSONArray();
        int nb = 0, nbAll = 0;
        for (Profile p : all) if (p.bridge && !(quick && "vk".equals(p.platformOrDefault()))) nbAll++;
        Process[] carrier = {null};
        int[] carrierPort = {0};
        File dir = new File(c.getFilesDir(), "check");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        try {
            for (Profile p : all) {
                if (p.bridge) continue;
                progress = "Сервер «" + p.name + "»";
                State.fire();
                JSONObject o = new JSONObject().put("name", p.name);
                if (inUse(c, p)) o.put("result", "in_use").put("ping_ms", State.pingMs);
                else if (quick) {
                    int ms = Speed.pingOne(c, p);
                    o.put("result", ms > 0 ? "ok" : "no_answer").put("ping_ms", ms);
                } else o.put("result", "measured").put("line", String.valueOf(Speed.measure(c, p)));
                servers.put(o);
            }
            Scout.waitIdle(90_000);  // a look in the background still in its call: one call at a time
            for (Profile p : all) {
                if (!p.bridge || quick && "vk".equals(p.platformOrDefault())) continue;  // (VK: «I'm not a robot» at every join)
                progress = "Мост «" + p.name + "» (" + (++nb) + " из " + nbAll + ")";
                State.fire();
                JSONObject o = quick ? look(c, p, dir, carrier, carrierPort) : bridge(c, p, dir, carrier, carrierPort, false);
                if (!"in_use".equals(o.optString("result"))) Scout.record(c, Scout.net(c), p, o.optString("result"), o.optInt("ping_ms"), o.optString("way"));
                bridges.put(o);
            }
            r.put("servers", servers).put("bridges", bridges).put("took_s", (SystemClock.elapsedRealtime() - t0) / 1000);
            Diag.i(c, "bridge check: done, " + bridges.length() + " bridges, " + ok(bridges) + " carry");
            if (!quick) r.put("sent", send(c, r, carrierPort[0]));
        } finally {
            if (carrier[0] != null) carrier[0].destroy();
        }
        return r;
    }

    /** The sites straight from this phone, all at once: those a white-list shuts wait their full time. */
    private static JSONArray sites(Context c, List<Profile> all) throws Exception {
        // the sites: the bridges' own addresses too (a Bitrix24 portal, a VK call), only their host — never the call itself
        Set<String> seen = new LinkedHashSet<>();
        List<String[]> look = new ArrayList<>();
        for (String[] s : SITES) {
            seen.add(Uri.parse(s[1]).getHost());
            look.add(s);
        }
        for (Profile p : all) {
            String host = p.bridge && p.joinLink != null && p.joinLink.startsWith("https://") ? Uri.parse(p.joinLink).getHost() : null;
            if (host != null && seen.add(host)) look.add(new String[]{"Адрес моста «" + p.name + "»", "https://" + host + "/"});
        }
        String home = Profile.homeHost(c);
        if (home != null) look.add(new String[]{"Семейный сервер", "https://" + home + ":8443/app/vpn.json"});
        progress = "Сайты напрямую (" + look.size() + ")";
        State.fire();
        JSONObject[] got = new JSONObject[look.size()];  // all at once: those a white-list shuts wait their full time
        ExecutorService pool = Executors.newFixedThreadPool(6);
        for (int i = 0; i < got.length; i++) {
            int k = i;
            pool.execute(() -> {
                try {
                    got[k] = site(look.get(k)[0], look.get(k)[1]);
                } catch (Exception e) {
                    got[k] = null;
                }
            });
        }
        pool.shutdown();
        pool.awaitTermination(60, TimeUnit.SECONDS);
        JSONArray sites = new JSONArray();
        for (JSONObject o : got) if (o != null) sites.put(o);
        return sites;
    }

    private static int ok(JSONArray bridges) {
        int n = 0;
        for (int i = 0; i < bridges.length(); i++) if ("ok".equals(bridges.optJSONObject(i).optString("result"))) n++;
        return n;
    }

    /** The connection in use, or its twin in the same call (the server keeps one of them in it: a look would throw it out). */
    private static boolean inUse(Context c, Profile p) {
        if (State.phase == State.Phase.OFF || State.activeLink == null) return false;
        if (p.link.equals(State.activeLink)) return true;
        for (Profile x : Profile.all(c)) if (x.link.equals(State.activeLink)) return Scout.sameCall(x, p);
        return false;
    }

    /** One site straight from this phone: its answer and time, or why not (no name, no answer, a certificate not its own). */
    static JSONObject site(String name, String url) throws Exception {
        return site(name, url, 8000);
    }

    static JSONObject site(String name, String url, int waitMs) throws Exception {
        JSONObject o = new JSONObject().put("name", name).put("host", Uri.parse(url).getHost());
        long t0 = SystemClock.elapsedRealtime();
        HttpURLConnection h = null;
        try {
            h = (HttpURLConnection) new URL(url).openConnection();
            h.setInstanceFollowRedirects(false);
            h.setConnectTimeout(waitMs);
            h.setReadTimeout(waitMs);
            h.setUseCaches(false);
            int code = h.getResponseCode();
            o.put("ok", true).put("code", code).put("ms", SystemClock.elapsedRealtime() - t0);
        } catch (javax.net.ssl.SSLException e) {
            o.put("ok", false).put("error", "tls").put("detail", cut(e.getMessage()));  // a certificate not the site's: someone in between
        } catch (UnknownHostException e) {
            o.put("ok", false).put("error", "dns");
        } catch (SocketTimeoutException e) {
            o.put("ok", false).put("error", "timeout");
        } catch (ConnectException e) {
            o.put("ok", false).put("error", "refused").put("detail", cut(e.getMessage()));
        } catch (Exception e) {
            String m = String.valueOf(e.getMessage()).toLowerCase(Locale.ROOT);
            o.put("ok", false).put("error", m.contains("reset") ? "reset" : "other").put("detail", cut(e.toString()));
        } finally {
            if (h != null) h.disconnect();
        }
        return o;
    }

    /** One bridge in a short call of its own: in the call, data through it, response and speed; why not, with the relay's
     *  last lines. A bridge that carries is kept as the way for the report until the next one that carries. */
    /** (v32) The scout's look at one bridge: in its call and one request through it — no speed test, nothing kept. */
    static JSONObject scoutOne(Context c, Profile p) throws Exception {
        File dir = new File(c.getFilesDir(), "scout");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return look(c, p, dir, null, null);
    }

    /**
     * (v34) A quick look at one bridge; one with two ways (WB Stream, Bitrix24, DION: the quicker data channel, or the
     * call's video) is looked at the other way too when the quicker one gets nothing back — a network may let only the
     * video through. The result says which way carried ("mode").
     */
    private static JSONObject look(Context c, Profile p, File dir, Process[] carrier, int[] carrierPort) throws Exception {
        JSONObject r = bridge(c, p, dir, carrier, carrierPort, true);
        if (!"no_data".equals(r.optString("result")) || !"dc".equals(p.tunnelMode)) return r;
        Profile v = Profile.find(p.link);
        if (v == null) return r;
        v.tunnelMode = "video";
        JSONObject r2 = bridge(c, v, dir, carrier, carrierPort, true);
        return "ok".equals(r2.optString("result")) ? r2.put("way", "video") : r;  // (not "mode": every look has its label)
    }

    private static JSONObject bridge(Context c, Profile p, File dir, Process[] carrier, int[] carrierPort, boolean light) throws Exception {
        String tunnel = p.tunnelMode.isEmpty() ? "dc" : p.tunnelMode;
        JSONObject o = new JSONObject().put("name", p.name).put("platform", p.platformOrDefault()).put("mode", p.modeLabel(tunnel));
        if (inUse(c, p)) {
            return o.put("result", "in_use").put("phase", State.phase.name()).put("ping_ms", State.pingMs)
                    .put("note", State.note);
        }
        int socks = VpnSvc.freePort();
        String join = p.joinVerb() + p.joinParams(tunnel);
        ProcessBuilder pb = new ProcessBuilder(c.getApplicationInfo().nativeLibraryDir + "/librelay.so",
                "--mode", p.relayMode(), "--ws-port", String.valueOf(VpnSvc.freePort()),
                "--socks-host", "127.0.0.1", "--socks-port", String.valueOf(socks))
                .directory(dir).redirectErrorStream(true);
        pb.environment().put("HOME", dir.getAbsolutePath());
        long t0 = SystemClock.elapsedRealtime();
        Process proc;
        try {
            proc = pb.start();
        } catch (Exception e) {
            return o.put("result", "start_failed").put("error", cut(e.toString()));
        }
        CountDownLatch up = new CountDownLatch(1);
        String[] why = {null};
        boolean[] captcha = {false};
        ArrayDeque<String> tail = new ArrayDeque<>();
        Thread reader = new Thread(() -> read(proc, join, up, why, captcha, tail), "check-relay");
        reader.start();
        boolean keep = false;
        try {
            boolean in = up.await(joinMs, TimeUnit.MILLISECONDS) && why[0] == null && !captcha[0] && alive(proc);
            o.put("join_ms", SystemClock.elapsedRealtime() - t0);
            if (!in) {
                o.put("result", captcha[0] ? "captcha" : why[0] != null ? "error" : !alive(proc) ? "stopped" : "no_join");
                if (why[0] != null) {
                    o.put("error", cut(why[0]));
                    if (!light) {  // (a quick look: on a white-list it may be the network, not the bridge — no restart for that)
                        BridgeSync.stuck(c, p, "check: " + why[0]);  // the call has nobody to take it: the server's side restarted
                        o.put("restarting", true);
                    }
                }
                return o;
            }
            int best = 0;
            for (int i = 0; i < 3 && !(light && best > 0); i++) {  // (the scout: one answer is enough)
                int ms = Speed.probe(socks, 10_000);
                if (ms > 0) best = best == 0 ? ms : Math.min(best, ms);
            }
            if (best == 0) {
                if (light) return o.put("result", "no_data");  // (as above: no restart from a quick look)
                BridgeSync.stuck(c, p, "check: in the call, nothing comes back");  // the server's side restarted
                return o.put("result", "no_data").put("restarting", true);
            }
            if (light) return o.put("result", "ok").put("ping_ms", best);
            double[] s = Speed.download(socks);
            o.put("result", "ok").put("ping_ms", best).put("mbps", Math.round(s[0] * 10) / 10.0).put("first_byte_ms", Math.round(s[1]));
            if (carrier[0] != null) carrier[0].destroy();
            carrier[0] = proc;
            carrierPort[0] = socks;
            keep = true;
            return o;
        } finally {
            if (!keep) proc.destroy();
            synchronized (tail) {
                o.put("log", new JSONArray(tail));
            }
            Diag.i(c, (light ? "scout" : "bridge check") + ": «" + p.name + "» " + o.optString("result")
                    + (o.has("ping_ms") ? ", " + o.optInt("ping_ms") + " ms" : ""));
        }
    }

    /** The relay's talk for one bridge: names it asks for, the call's settings once it is ready, how it went. */
    private static void read(Process proc, String join, CountDownLatch up, String[] why, boolean[] captcha, ArrayDeque<String> tail) {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8));
             Writer w = new OutputStreamWriter(proc.getOutputStream(), StandardCharsets.UTF_8)) {
            for (String line; (line = r.readLine()) != null; ) {
                if (line.startsWith("RESOLVE:")) {
                    String ip = "";
                    try {
                        InetAddress[] all = InetAddress.getAllByName(line.substring(8).trim());
                        InetAddress a = all[0];
                        for (InetAddress x : all) if (x instanceof Inet4Address) { a = x; break; }
                        ip = a.getHostAddress();
                    } catch (Exception e) {
                        keep(tail, "имя не найдено: " + line.substring(8).trim());
                    }
                    w.write(ip + "\n");
                    w.flush();
                    continue;
                }
                if (line.contains("SOCKS CONNECT") || line.contains("drop msgType")) continue;  // each connection: not kept
                keep(tail, line);
                if (!line.startsWith("STATUS:")) continue;
                String st = line.substring(7).trim();
                if (st.equals("READY")) {
                    w.write(join + "\n");
                    w.flush();
                } else if (st.startsWith("CAPTCHA:")) {
                    captcha[0] = true;  // VK wants a person: not now, in the background
                    up.countDown();
                } else if (st.equals("TUNNEL_CONNECTED")) {
                    up.countDown();
                } else if (st.startsWith("ERROR:")) {
                    why[0] = st;
                    up.countDown();
                }
            }
        } catch (Exception ignored) {
            // the program ended
        }
        up.countDown();
    }

    private static boolean alive(Process p) {  // (Process.isAlive: Android 8 and newer)
        try {
            p.exitValue();
            return false;
        } catch (IllegalThreadStateException e) {
            return true;
        }
    }

    private static void keep(ArrayDeque<String> tail, String line) {
        synchronized (tail) {
            // a call's own address or key never goes into the report: only what the relay says about it
            tail.addLast(cut(line.replaceAll("https?://\\S+", "<адрес>").replaceAll("[A-Za-z0-9_-]{24,}", "<…>")));
            while (tail.size() > 25) tail.removeFirst();
        }
    }

    private static String cut(String s) {
        return s == null ? "" : s.length() > 300 ? s.substring(0, 300) + "…" : s;
    }

    /**
     * The phone's own network under the VPN: mobile or Wi-Fi, and the operator. (v37) A Wi-Fi's «mark»: a short hash of
     * its IPv4 subnet, gateway, DNS servers and domain (no location permission, unlike its name); «captive» — behind a
     * sign-in page.
     */
    static JSONObject network(Context c) throws Exception {
        JSONObject o = new JSONObject().put("type", "none");
        ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm != null) {
            // (v37, the review) the network this app really goes by first (it is outside its own VPN): a Wi-Fi with a
            // sign-in page beside the mobile network that carries is not «the network» then
            java.util.List<Network> all = new java.util.ArrayList<>();
            Network active = cm.getActiveNetwork();
            if (active != null) all.add(active);
            for (Network n : cm.getAllNetworks()) if (!n.equals(active)) all.add(n);
            for (Network n : all) {
                NetworkCapabilities nc = cm.getNetworkCapabilities(n);
                if (nc == null || nc.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
                        || !nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue;
                o.put("type", nc.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ? "mobile"
                        : nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ? "wifi" : "other");
                o.put("captive", nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL));
                if (nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    String mark = wifiMark(cm.getLinkProperties(n));
                    if (mark != null) o.put("mark", mark);
                }
                if (n.equals(active) || nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) break;  // the one in use (else Wi-Fi first)
            }
        }
        TelephonyManager tm = (TelephonyManager) c.getSystemService(Context.TELEPHONY_SERVICE);
        if (tm != null) o.put("operator", String.valueOf(tm.getNetworkOperatorName())).put("sim", String.valueOf(tm.getSimOperatorName()));
        return o;
    }

    /** (v37) A Wi-Fi told from another by what it hands out (IPv4 only: IPv6 addresses change by themselves). */
    static String wifiMark(android.net.LinkProperties lp) {
        if (lp == null) return null;
        java.util.TreeSet<String> parts = new java.util.TreeSet<>();
        for (android.net.LinkAddress a : lp.getLinkAddresses()) {
            if (!(a.getAddress() instanceof java.net.Inet4Address)) continue;
            byte[] b = a.getAddress().getAddress();
            int len = a.getPrefixLength(), ip = (b[0] & 255) << 24 | (b[1] & 255) << 16 | (b[2] & 255) << 8 | (b[3] & 255);
            parts.add("net " + Integer.toHexString(len == 0 ? 0 : ip & (-1 << (32 - len))) + "/" + len);
        }
        for (android.net.RouteInfo r : lp.getRoutes())
            if (r.getGateway() instanceof java.net.Inet4Address && !r.getGateway().isAnyLocalAddress()) parts.add("gw " + r.getGateway().getHostAddress());
        for (InetAddress d : lp.getDnsServers()) if (d instanceof java.net.Inet4Address) parts.add("dns " + d.getHostAddress());
        if (lp.getDomains() != null) parts.add("dom " + lp.getDomains());
        if (parts.isEmpty()) return null;
        return String.format(Locale.ROOT, "%08x", android.text.TextUtils.join(";", parts).hashCode());
    }

    private static JSONObject vpn(Context c) throws Exception {
        JSONObject o = new JSONObject().put("phase", State.phase.name()).put("ping_ms", State.pingMs).put("note", State.note);
        for (Profile p : Profile.all(c)) if (p.link.equals(State.activeLink)) o.put("active", p.name).put("bridge", p.bridge);
        return o;
    }

    // ---------- the report ----------

    private static void save(Context c, JSONObject r) {
        try (OutputStream out = new FileOutputStream(new File(c.getFilesDir(), FILE))) {
            out.write(r.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            Diag.w(c, "bridge check save", e);
        }
    }

    /** The last report, or null. */
    static JSONObject last(Context c) {
        File f = new File(c.getFilesDir(), FILE);
        if (!f.isFile()) return null;
        try {
            return new JSONObject(BridgeSync.read(new java.io.FileInputStream(f)));
        } catch (Exception e) {
            return null;
        }
    }

    /** A report that could not go when it was made (no way to the server then): sent now, once there is one. */
    static void sendPending(Context c) {
        JSONObject r = last(c);
        if (r == null || r.optBoolean("sent") || System.currentTimeMillis() / 1000 - r.optLong("at") > 24 * 3600) return;
        try {
            if (send(c, r, 0)) {
                r.put("sent", true);
                save(c, r);
            }
        } catch (Exception ignored) {
            // the next time
        }
    }

    /** To the family server: through the VPN when it is on, then through a bridge that carried in the check, then straight. */
    private static boolean send(Context c, JSONObject r, int viaPort) {
        String host = Profile.homeHost(c), login = BridgeSync.ownLogin(c, host);
        if (host == null || login == null) return false;
        String url = "https://" + host + ":8443/api/winger_check";
        int[] ways = {VpnSvc.socksPort, viaPort, 0};
        for (int i = 0; i < ways.length; i++) {
            if (i < 2 && ways[i] <= 0) continue;
            try {
                JSONObject body = new JSONObject().put("auth", login).put("report", r);
                HttpURLConnection h = post(url, ways[i]);
                try (OutputStream o = h.getOutputStream()) {
                    o.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                int code = h.getResponseCode();
                h.disconnect();
                Diag.i(c, "bridge check: report sent " + code + (i == 0 ? " (through the VPN)" : i == 1 ? " (through a bridge)" : " (straight)"));
                if (code == 200) return true;
                if (code == 403) return false;  // not the owner's login: no other way helps
            } catch (Exception e) {
                Diag.i(c, "bridge check: report not sent " + (i == 0 ? "through the VPN" : i == 1 ? "through a bridge" : "straight") + ": " + e);
            }
        }
        return false;
    }

    /** Asks the server whether its Claude wants a check now: its id, "" for none, null when it did not answer. */
    private static String askTask(Context c) {
        String host = Profile.homeHost(c), login = BridgeSync.ownLogin(c, host);
        if (host == null || login == null) return null;
        try {
            HttpURLConnection h = post("https://" + host + ":8443/api/winger_task", VpnSvc.socksPort);
            try (OutputStream o = h.getOutputStream()) {
                o.write(new JSONObject().put("auth", login).toString().getBytes(StandardCharsets.UTF_8));
            }
            if (h.getResponseCode() != 200) return null;
            String task = new JSONObject(BridgeSync.read(h.getInputStream())).optString("task", "");
            h.disconnect();
            return task;
        } catch (Exception e) {
            return null;
        }
    }

    private static HttpURLConnection post(String url, int socks) throws Exception {
        URL u = new URL(url);
        HttpURLConnection h = (HttpURLConnection) (socks > 0
                ? u.openConnection(new Proxy(Proxy.Type.SOCKS, new InetSocketAddress("127.0.0.1", socks)))
                : u.openConnection());
        h.setConnectTimeout(15_000);
        h.setReadTimeout(30_000);
        h.setUseCaches(false);
        h.setRequestMethod("POST");
        h.setDoOutput(true);
        h.setRequestProperty("Content-Type", "application/json");
        return h;
    }

    /** The report in a few lines for the screen. */
    static String summary(JSONObject r) {
        StringBuilder b = new StringBuilder();
        JSONArray br = r.optJSONArray("bridges");
        if (br != null) {
            for (int i = 0; i < br.length(); i++) {
                JSONObject o = br.optJSONObject(i);
                b.append(line(o)).append('\n');
            }
        }
        JSONArray s = r.optJSONArray("sites");
        if (s != null) {
            b.append("\nСайты напрямую:\n");
            for (int i = 0; i < s.length(); i++) {
                JSONObject o = s.optJSONObject(i);
                b.append(o.optBoolean("ok") ? "✅ " : "❌ ").append(o.optString("name"));
                if (!o.optBoolean("ok")) b.append(" — ").append(siteWhy(o.optString("error")));
                b.append('\n');
            }
        }
        b.append(r.optBoolean("sent") ? "\nОтчёт на сервере — спросите Claude в «Управлении»." : "\nОтчёт уйдёт на сервер, как только будет связь.");
        return b.toString().trim();
    }

    private static final String RESTARTING = " (сервер перезапускает этот мост — проверьте ещё раз через минуту)";

    private static String line(JSONObject o) {
        String n = "«" + o.optString("name") + "»";
        switch (o.optString("result")) {
            case "ok":
                return "✅ " + n + " — работает";  // (the numbers are in the report, for the developer)
            case "in_use":
                return "⏺ " + n + " — сейчас в работе";
            case "captcha":
                return "⚠️ " + n + " — VK просит «я не робот»: пройдите её, подключившись к мосту";
            case "no_data":
                return "❌ " + n + " — в звонке, но данные не идут" + (o.optBoolean("restarting") ? RESTARTING : "");
            case "no_join":
                return "❌ " + n + " — не вошёл в звонок";
            case "error":
                return "❌ " + n + " — ошибка звонка" + (o.optBoolean("restarting") ? RESTARTING : "");
            default:
                return "❌ " + n + " — не запустился";
        }
    }

    private static String siteWhy(String e) {
        switch (e) {
            case "tls":
                return "сертификат не свой (подмена)";
            case "dns":
                return "имя не находится";
            case "timeout":
                return "нет ответа";
            case "refused":
                return "отказ в соединении";
            case "reset":
                return "соединение сброшено";
            default:
                return "не открылся";
        }
    }
}
