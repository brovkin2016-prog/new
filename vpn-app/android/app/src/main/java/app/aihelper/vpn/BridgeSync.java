package app.aihelper.vpn;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;

/**
 * The owner's bridge kept ready in Winger, with nothing to set up: Winger shows the family server the VPN login it
 * already has, and the server answers with the owner's Telemost bridge (the call and its settings) only when that login
 * is the owner's own — anybody else gets nothing. Fetched while the internet is normal, so it is there on a shutdown day.
 */
final class BridgeSync {
    private static final long EVERY_MS = 6 * 3600_000L;
    private static volatile boolean busy;

    private BridgeSync() {}

    static void run(Context ctx, boolean now) {
        Context c = ctx.getApplicationContext();
        SharedPreferences prefs = c.getSharedPreferences("vpn", Context.MODE_PRIVATE);
        boolean have = false;
        for (Profile p : Profile.all(c)) have |= p.bridge;
        // without a bridge yet it looks again soon (the server may have just got it); with one, a few times a day
        long every = have ? EVERY_MS : 20 * 60_000L;
        if (busy || (!now && System.currentTimeMillis() - prefs.getLong("bridgeSync", 0) < every)) return;
        String host = Profile.homeHost(c), auth = ownLogin(c, host);
        if (auth == null) {
            Diag.i(c, "bridge sync: no own VPN login with the family server's name here");
            return;
        }
        busy = true;
        String login = auth;
        new Thread(() -> {
            try {
                HttpURLConnection h = Updater.open("https://" + host + ":8443/api/winger_bridge");
                h.setRequestMethod("POST");
                h.setDoOutput(true);
                h.setRequestProperty("Content-Type", "application/json");
                try (OutputStream o = h.getOutputStream()) {
                    o.write(new JSONObject().put("auth", login).toString().getBytes(StandardCharsets.UTF_8));
                }
                int code = h.getResponseCode();
                if (code != 200) Diag.i(c, "bridge sync: the server answered " + code);
                if (code == 200) {
                    JSONArray links = new JSONObject(read(h.getInputStream())).optJSONArray("links");
                    int added = 0;
                    for (int i = 0; links != null && i < links.length(); i++) {
                        Profile p = Profile.parse(links.optString(i));
                        if (p != null && p.bridge && Profile.keep(c, p)) added++;
                    }
                    prefs.edit().putLong("bridgeSync", System.currentTimeMillis()).apply();
                    Diag.i(c, "bridge from the server: " + (links == null ? 0 : links.length()) + ", new " + added);
                }
                h.disconnect();
            } catch (Exception e) {
                Diag.i(c, "bridge sync: " + e);
            } finally {
                busy = false;
            }
        }, "bridge-sync").start();
    }

    /** The VPN login this phone has on the family server (name:key from its hysteria2:// link), or null. */
    static String ownLogin(Context c, String host) {
        if (host == null) return null;
        for (Profile p : Profile.all(c)) {
            if (!p.bridge && host.equals(p.updateHost()) && p.auth != null && p.auth.indexOf(':') > 0) return p.auth;
        }
        return null;
    }

    private static String read(InputStream in) throws Exception {
        try (InputStream i = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] b = new byte[4096];
            for (int n; (n = i.read(b)) > 0; ) out.write(b, 0, n);
            return out.toString("UTF-8");
        }
    }
}
