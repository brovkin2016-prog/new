package app.aihelper.vpn;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Which bridges carry here and now (v32). While a connection is up and holds, now and then each other bridge is tried in
 * a short call of its own (in the call, one request through it: BridgeCheck.scoutOne) — one bridge at a time, each at
 * most every half hour — and what it said is kept for this network (Wi-Fi or mobile and its operator: a white-list in
 * the morning is not the evening's Wi-Fi). The bridge in use is counted too. When the connection in use stops carrying,
 * the next one is a bridge that carries here now (VpnSvc.nextChoice), never first one just seen failing here. VK asks a
 * person to prove they are one at every join: it is not looked at, and it comes last. Before connecting, the button
 * «🔎 Что работает здесь» looks at all of them at once (BridgeCheck, QUICK); each connection's button
 * then says «Работает здесь» or «Здесь не работает» — no numbers.
 */
final class Scout {
    static final long EVERY = 30 * 60_000L;  // each bridge looked at again after this long (an hour once it said the same twice)
    static final long FRESH = 60 * 60_000L;  // what one said counts for this long
    private static final AtomicBoolean running = new AtomicBoolean();
    private static volatile long lastAt;

    private Scout() {}

    /**
     * This network: «mobile/t2» (its kind and the SIM's operator); (v37) a Wi-Fi by its own marks («wifi/3fa2…»: its
     * addresses, gateway, DNS and domain — the home's and the work's Wi-Fi are not one network any more), no
     * location permission needed.
     */
    static String net(Context c) {
        try {
            JSONObject n = BridgeCheck.network(c);
            if ("wifi".equals(n.optString("type")) && !n.optString("mark").isEmpty()) return "wifi/" + n.optString("mark");
            String op = n.optString("sim", "");
            if (op.isEmpty() || "null".equals(op)) op = n.optString("operator", "");
            return n.optString("type", "none") + "/" + op.toLowerCase(Locale.ROOT);
        } catch (Exception e) {
            return "none/";
        }
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("scout", Context.MODE_PRIVATE);
    }

    /** What a bridge did here: "ok" with its response time, or why not (no_data, no_join, error, captcha, stopped). */
    static void record(Context c, Profile p, String result, int ms) {
        record(c, net(c), p, result, ms, "");
    }

    /**
     * ... on that network (the one there was when the look began: a look that ends on another network is not its word).
     * (v37) Behind a Wi-Fi's sign-in page (a café, a train) nothing gets through until the person signs in: a failure there
     * is not the bridge's, and it is not kept.
     */
    static synchronized void record(Context c, String key, Profile p, String result, int ms, String mode) {
        try {
            if (!"ok".equals(result) && BridgeCheck.network(c).optBoolean("captive")) return;
            JSONObject all = new JSONObject(prefs(c).getString(key, "{}"));
            String id = String.valueOf(p.link.hashCode());
            JSONObject was = all.optJSONObject(id);
            String before = was == null ? "" : was.optString("r");
            // the same word again (v37: any «does not carry» after another counts as the same)
            int same = was != null && (result.equals(before) || !"ok".equals(result) && !before.isEmpty() && !"ok".equals(before))
                    ? was.optInt("n") + 1 : 0;
            JSONObject o = new JSONObject().put("r", result).put("ms", ms).put("at", System.currentTimeMillis()).put("n", same);
            if (mode != null && !mode.isEmpty()) o.put("m", mode);  // (v34) the way that carried here: "video"
            all.put(id, o);
            prefs(c).edit().putString(key, all.toString()).apply();
        } catch (Exception ignored) {
            // nothing kept: the next look says it again
        }
    }

    private static JSONObject raw(Context c, Profile p) {
        try {
            return new JSONObject(prefs(c).getString(net(c), "{}")).optJSONObject(String.valueOf(p.link.hashCode()));
        } catch (Exception e) {
            return null;
        }
    }

    /** A bridge's word here, if fresh; null when it was not looked at lately. */
    static JSONObject seen(Context c, Profile p) {
        JSONObject o = raw(c, p);
        return o != null && System.currentTimeMillis() - o.optLong("at") < Math.max(FRESH, pause(o)) ? o : null;
    }

    /**
     * (v37) How long until a bridge is looked at again: one that carries — half an hour (an hour once it said so twice);
     * one that does not, again and again — longer each time (30 min, 1 h, 2 h, 4 h at most: each look is a call), and
     * its «does not carry here» counts for as long. It is still tried in turn when nothing else carries.
     */
    static long pause(JSONObject s) {
        if (s == null) return 0;
        int n = Math.max(0, s.optInt("n"));
        if ("ok".equals(s.optString("r"))) return n >= 2 ? 2 * EVERY : EVERY;
        return EVERY << Math.min(n, 3);
    }

    // ---------- (v37) a white-list here: only the sites on it open (Google does not, Yandex does) ----------
    static final long VERDICT = 30 * 60_000L;  // what the look said counts for this long on this network
    private static final java.util.Map<String, long[]> verdicts = new java.util.concurrent.ConcurrentHashMap<>();
    private static volatile String outside = "https://www.gstatic.com/generate_204", inside = "https://ya.ru/";

    /** The emulator test only: «a white-list here» made (a shut address for Google's) or undone; the words kept go. */
    static void testWhite(boolean on) {
        outside = on ? "https://10.0.2.2:1/" : "https://www.gstatic.com/generate_204";
        inside = on ? "https://www.gstatic.com/generate_204" : "https://ya.ru/";
        verdicts.clear();
    }

    /**
     * True when this network lets only white-listed sites through (Google shut, Yandex open): then the servers' doors
     * are shut as well (the white-list goes by address) and a bridge is the way at once — no minute of the servers'
     * failed tries first. Looked at in a few seconds (both sites at once, straight from this phone), kept half an hour
     * for this network; no internet at all — no word kept.
     */
    static boolean whiteList(Context c) {
        String key = net(c);
        long[] v = verdicts.get(key);
        if (v != null && System.currentTimeMillis() - v[0] < VERDICT) return v[1] == 1;
        boolean[] ok = new boolean[2];
        String out = outside, in = inside;
        Thread g = new Thread(() -> ok[0] = opens("Google", out), "white-g");
        Thread y = new Thread(() -> ok[1] = opens("Яндекс", in), "white-y");
        g.start();
        y.start();
        try {
            g.join(8000);
            y.join(8000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
        boolean white = !ok[0] && ok[1];
        if ((ok[0] || ok[1]) && key.equals(net(c))) verdicts.put(key, new long[]{System.currentTimeMillis(), white ? 1 : 0});
        Diag.i(c, "network: " + (white ? "a white-list (Google shut, Yandex open) — bridges first" : ok[0] ? "open" : "no internet"));
        return white;
    }

    /** The word kept for this network, without looking: true — a white-list here lately. */
    static boolean whiteListSeen(Context c) {
        long[] v = verdicts.get(net(c));
        return v != null && v[1] == 1 && System.currentTimeMillis() - v[0] < VERDICT;
    }

    private static boolean opens(String name, String url) {
        try {
            return BridgeCheck.site(name, url, 3000).optBoolean("ok");
        } catch (Exception e) {
            return false;
        }
    }

    /** For a connection's button: true — it carried here lately, false — it did not, null — not looked at (or VK). */
    static Boolean carries(Context c, Profile p) {
        return carries(p, seen(c, p));
    }

    private static Boolean carries(Profile p, JSONObject s) {
        if (p.bridge && "vk".equals(p.platformOrDefault())) return null;
        return s == null ? null : "ok".equals(s.optString("r"));
    }

    /** (v34) The way a bridge carried here lately when only the call's video did: "video"; null otherwise. */
    static String mode(Context c, Profile p) {
        JSONObject s = seen(c, p);
        return s != null && "ok".equals(s.optString("r")) && !s.optString("m").isEmpty() ? s.optString("m") : null;
    }

    /** The same call (a bridge and its twin with other settings, say «2 трека»): the server keeps one of them in it. */
    static boolean sameCall(Profile a, Profile b) {
        return a.link.equals(b.link) || a.bridge && b.bridge && a.joinLink != null && a.joinLink.equals(b.joinLink);
    }

    /** The quickest connection that carried here lately, other than this one (VK aside); null: none. */
    static Profile best(Context c, Profile not) {
        Profile best = null;
        int bestMs = Integer.MAX_VALUE;
        for (Profile p : Profile.all(c)) {
            JSONObject s = seen(c, p);  // (once: it may go stale or the network change between two looks)
            if (p.link.equals(not.link) || !Boolean.TRUE.equals(carries(p, s))) continue;
            int ms = s.optInt("ms", Integer.MAX_VALUE);
            if (ms <= 0) ms = Integer.MAX_VALUE - 1;
            if (best == null || ms < bestMs) {
                best = p;
                bestMs = ms;
            }
        }
        return best;
    }

    /** Waits (at most ms) for a look in the background to end: a check of its own does not run two calls at once. */
    static void waitIdle(long ms) throws InterruptedException {
        long until = System.currentTimeMillis() + ms;
        while (running.get() && System.currentTimeMillis() < until) Thread.sleep(500);
    }

    /**
     * The bridges, the best first: those carrying here now (the quickest first), then those not looked at lately (the
     * one that last carried first), then those just seen failing here, VK last of all.
     */
    static List<Profile> rank(Context c, List<Profile> bridges, String good) {
        List<Profile> ok = new ArrayList<>(), unknown = new ArrayList<>(), bad = new ArrayList<>(), vk = new ArrayList<>();
        java.util.Map<Profile, Integer> ms = new java.util.HashMap<>();  // (taken once: the sort does not look again)
        for (Profile p : bridges) {
            JSONObject s = seen(c, p);
            if ("vk".equals(p.platformOrDefault())) vk.add(p);
            else if (s == null) {
                if (p.link.equals(good)) unknown.add(0, p);
                else unknown.add(p);
            } else if ("ok".equals(s.optString("r"))) {
                ok.add(p);
                ms.put(p, s.optInt("ms"));
            } else bad.add(p);
        }
        java.util.Collections.sort(ok, (a, b) -> Integer.compare(ms.get(a), ms.get(b)));
        List<Profile> out = new ArrayList<>(ok);
        out.addAll(unknown);
        out.addAll(bad);
        out.addAll(vk);
        return out;
    }

    /**
     * Every 20 s while a connection holds and the screen is on (a phone in a pocket needs no ranking, and each look is a
     * call): one bridge that is due looked at in the background, at most one a minute — never the one in use nor its
     * twin in the same call (the server keeps one of them in it: the look would throw the connection out).
     */
    static void maybe(Context c, Profile active) {
        android.os.PowerManager pm = (android.os.PowerManager) c.getSystemService(Context.POWER_SERVICE);
        if (!Apps.autoBridge(c) || BridgeCheck.running.get() || System.currentTimeMillis() - lastAt < 60_000L
                || pm != null && !pm.isInteractive() || !running.compareAndSet(false, true)) return;
        Context app = c.getApplicationContext();
        new Thread(() -> {
            try {
                Profile due = null;
                long oldest = Long.MAX_VALUE;
                for (Profile p : Profile.all(app)) {
                    if (!p.bridge || sameCall(p, active) || "vk".equals(p.platformOrDefault())) continue;
                    JSONObject s = raw(app, p);
                    long at = s == null ? 0 : s.optLong("at");
                    if (System.currentTimeMillis() - at >= pause(s) && at < oldest) {  // the same word again and again: less often
                        oldest = at;
                        due = p;
                    }
                }
                if (due == null) return;
                String key = net(app);
                JSONObject r = BridgeCheck.scoutOne(app, due);
                String res = r.optString("result", "error");
                if (!"in_use".equals(res) && key.equals(net(app))) record(app, key, due, res, r.optInt("ping_ms"), r.optString("way"));
            } catch (Exception e) {
                Diag.i(app, "scout: " + e);
            } finally {
                lastAt = System.currentTimeMillis();
                running.set(false);
            }
        }, "scout").start();
    }
}
