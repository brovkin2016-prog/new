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

    /** This network: «wifi/t2», «mobile/t2» (its kind and the SIM's operator). */
    static String net(Context c) {
        try {
            JSONObject n = BridgeCheck.network(c);
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

    /** ... on that network (the one there was when the look began: a look that ends on another network is not its word). */
    static synchronized void record(Context c, String key, Profile p, String result, int ms, String mode) {
        try {
            JSONObject all = new JSONObject(prefs(c).getString(key, "{}"));
            String id = String.valueOf(p.link.hashCode());
            JSONObject was = all.optJSONObject(id);
            int same = was != null && result.equals(was.optString("r")) ? was.optInt("n") + 1 : 0;  // the same word again
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
        return o != null && System.currentTimeMillis() - o.optLong("at") < FRESH ? o : null;
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
                    long every = s != null && s.optInt("n") >= 2 ? 2 * EVERY : EVERY;  // the same word again and again: less often
                    if (System.currentTimeMillis() - at >= every && at < oldest) {
                        oldest = at;
                        due = p;
                    }
                }
                if (due == null) return;
                String key = net(app);
                JSONObject r = BridgeCheck.scoutOne(app, due);
                String res = r.optString("result", "error");
                if (!"in_use".equals(res) && key.equals(net(app))) record(app, key, due, res, r.optInt("ping_ms"), r.optString("mode"));
            } catch (Exception e) {
                Diag.i(app, "scout: " + e);
            } finally {
                lastAt = System.currentTimeMillis();
                running.set(false);
            }
        }, "scout").start();
    }
}
