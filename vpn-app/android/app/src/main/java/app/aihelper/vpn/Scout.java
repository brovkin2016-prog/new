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
 * person to prove they are one at every join: it is not looked at, and it comes last.
 */
final class Scout {
    static final long EVERY = 30 * 60_000L;  // each bridge looked at again after this long
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
    static synchronized void record(Context c, Profile p, String result, int ms) {
        try {
            String key = net(c);
            JSONObject all = new JSONObject(prefs(c).getString(key, "{}"));
            all.put(String.valueOf(p.link.hashCode()), new JSONObject().put("r", result).put("ms", ms).put("at", System.currentTimeMillis()));
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

    /**
     * The bridges, the best first: those carrying here now (the quickest first), then those not looked at lately (the
     * one that last carried first), then those just seen failing here, VK last of all.
     */
    static List<Profile> rank(Context c, List<Profile> bridges, String good) {
        List<Profile> ok = new ArrayList<>(), unknown = new ArrayList<>(), bad = new ArrayList<>(), vk = new ArrayList<>();
        for (Profile p : bridges) {
            JSONObject s = seen(c, p);
            if ("vk".equals(p.platformOrDefault())) vk.add(p);
            else if (s == null) {
                if (p.link.equals(good)) unknown.add(0, p);
                else unknown.add(p);
            } else if ("ok".equals(s.optString("r"))) ok.add(p);
            else bad.add(p);
        }
        java.util.Collections.sort(ok, (a, b) -> Integer.compare(seen(c, a).optInt("ms"), seen(c, b).optInt("ms")));
        List<Profile> out = new ArrayList<>(ok);
        out.addAll(unknown);
        out.addAll(bad);
        out.addAll(vk);
        return out;
    }

    /** Every 20 s while a connection holds: one bridge that is due looked at in the background (at most one a minute). */
    static void maybe(Context c, String activeLink) {
        if (!Apps.autoBridge(c) || BridgeCheck.running.get() || System.currentTimeMillis() - lastAt < 60_000L
                || !running.compareAndSet(false, true)) return;
        Context app = c.getApplicationContext();
        new Thread(() -> {
            try {
                Profile due = null;
                long oldest = Long.MAX_VALUE;
                for (Profile p : Profile.all(app)) {
                    if (!p.bridge || p.link.equals(activeLink) || "vk".equals(p.platformOrDefault())) continue;
                    JSONObject s = raw(app, p);
                    long at = s == null ? 0 : s.optLong("at");
                    if (System.currentTimeMillis() - at >= EVERY && at < oldest) {
                        oldest = at;
                        due = p;
                    }
                }
                if (due == null) return;
                JSONObject r = BridgeCheck.scoutOne(app, due);
                record(app, due, r.optString("result", "error"), r.optInt("ping_ms"));
            } catch (Exception e) {
                Diag.i(app, "scout: " + e);
            } finally {
                lastAt = System.currentTimeMillis();
                running.set(false);
            }
        }, "scout").start();
    }
}
