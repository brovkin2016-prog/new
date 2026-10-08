package app.aihelper.vpn;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** A Hysteria 2 server from a hysteria2:// link, and the saved list of them. */
final class Profile {
    private static final Pattern LINK = Pattern.compile("(?:hysteria2|hy2)://[^\\s\"'<>]+", Pattern.CASE_INSENSITIVE);

    String name, link, host, ports, auth, sni, obfs, obfsPassword, pin;
    boolean insecure;

    /** The first hysteria2:// link anywhere in the text (a message, a QR code), or null. */
    static Profile find(String text) {
        if (text == null) return null;
        Matcher m = LINK.matcher(text);
        return m.find() ? parse(m.group()) : null;
    }

    /** Reads hysteria2://auth@host:port/?sni=…&insecure=1&obfs=salamander&obfs-password=…&pinSHA256=…#name */
    static Profile parse(String link) {
        try {
            String s = link.trim();
            String rest = s.substring(s.indexOf("://") + 3);
            Profile p = new Profile();
            p.link = s;
            int hash = rest.indexOf('#');
            if (hash >= 0) {
                p.name = Uri.decode(rest.substring(hash + 1)).trim();
                rest = rest.substring(0, hash);
            }
            String query = "";
            int q = rest.indexOf('?');
            if (q >= 0) {
                query = rest.substring(q + 1);
                rest = rest.substring(0, q);
            }
            if (rest.endsWith("/")) rest = rest.substring(0, rest.length() - 1);
            int at = rest.lastIndexOf('@');
            if (at >= 0) {
                p.auth = Uri.decode(rest.substring(0, at));
                rest = rest.substring(at + 1);
            } else {
                p.auth = "";
            }
            // host:port, [v6]:port; the port may be a range or a list for port hopping (20000-30000, 443,5000-6000)
            if (rest.startsWith("[")) {
                int end = rest.indexOf(']');
                p.host = rest.substring(1, end);
                p.ports = end + 1 < rest.length() && rest.charAt(end + 1) == ':' ? rest.substring(end + 2) : "443";
            } else {
                int colon = rest.indexOf(':');
                p.host = colon >= 0 ? rest.substring(0, colon) : rest;
                p.ports = colon >= 0 ? rest.substring(colon + 1) : "443";
            }
            if (p.host.isEmpty() || !p.ports.matches("[0-9,\\-]+")) return null;
            for (String kv : query.split("&")) {
                int eq = kv.indexOf('=');
                if (eq < 0) continue;
                String k = kv.substring(0, eq), v = Uri.decode(kv.substring(eq + 1));
                switch (k) {
                    case "sni": p.sni = v; break;
                    case "insecure": p.insecure = v.equals("1") || v.equalsIgnoreCase("true"); break;
                    case "obfs": p.obfs = v; break;
                    case "obfs-password": p.obfsPassword = v; break;
                    case "pinSHA256": p.pin = v; break;
                    default: break;
                }
            }
            if (p.name == null || p.name.isEmpty()) p.name = p.host;
            return p;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** The server name the certificate is for: the link's sni, else its host. */
    String serverName() {
        return sni != null && !sni.isEmpty() ? sni : host;
    }

    /** Where the app's own update lives on this server (only when the link names a domain). */
    String updateHost() {
        String n = serverName();
        return n.matches("[0-9.]+") || n.contains(":") ? null : n;
    }

    // ---------- the saved list ----------

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("vpn", Context.MODE_PRIVATE);
    }

    static List<Profile> all(Context c) {
        List<Profile> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(prefs(c).getString("profiles", "[]"));
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                Profile p = parse(o.getString("link"));
                if (p == null) continue;
                p.name = o.optString("name", p.name);
                out.add(p);
            }
        } catch (Exception ignored) {
            // nothing saved yet
        }
        return out;
    }

    static void save(Context c, List<Profile> list) {
        JSONArray a = new JSONArray();
        try {
            for (Profile p : list) a.put(new JSONObject().put("link", p.link).put("name", p.name));
        } catch (Exception ignored) {
            // strings only
        }
        prefs(c).edit().putString("profiles", a.toString()).apply();
    }

    static int current(Context c) {
        return prefs(c).getInt("current", 0);
    }

    static void select(Context c, int i) {
        prefs(c).edit().putInt("current", i).apply();
    }

    static Profile chosen(Context c) {
        List<Profile> all = all(c);
        if (all.isEmpty()) return null;
        return all.get(Math.max(0, Math.min(current(c), all.size() - 1)));
    }

    /** Adds the link (or refreshes it when the same server and login are already there) and makes it the current one. */
    private static boolean sameUser(String a, String b) {
        int i = a.indexOf(':'), j = b.indexOf(':');
        return i > 0 && j > 0 && a.substring(0, i).equals(b.substring(0, j));
    }

    static Profile add(Context c, Profile p) {
        List<Profile> list = all(c);
        int at = -1;
        for (int i = 0; i < list.size(); i++) {
            Profile o = list.get(i);
            // the same server and the same person (hysteria2://name:key@…): a new key replaces the old one, no dead copy stays
            if (o.host.equals(p.host) && o.ports.equals(p.ports) && (o.auth.equals(p.auth) || sameUser(o.auth, p.auth))) at = i;
        }
        if (at >= 0) list.set(at, p);
        else list.add(p);
        save(c, list);
        select(c, at >= 0 ? at : list.size() - 1);
        return p;
    }
}
