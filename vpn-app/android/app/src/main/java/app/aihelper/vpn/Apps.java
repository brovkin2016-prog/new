package app.aihelper.vpn;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;

import java.text.Collator;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * What goes through the VPN. By default only the apps that need it (Instagram, Telegram, WhatsApp, YouTube and the
 * like) — the VPN can then stay on all the time, and banks, Gosuslugi, marketplaces and taxis go straight, as if there
 * were no VPN. Any other app on the phone can be ticked too (not by default). Or everything, as before.
 */
final class Apps {
    /** package → the name shown; the ones in OFF_BY_DEFAULT are offered but not ticked. */
    static final Map<String, String> KNOWN = new LinkedHashMap<>();
    private static final Set<String> OFF_BY_DEFAULT = new HashSet<>();

    static {
        String[][] k = {
                {"com.instagram.android", "Instagram"}, {"com.instagram.barcelona", "Threads"},
                {"org.telegram.messenger", "Telegram"}, {"org.telegram.messenger.web", "Telegram"},
                {"org.thunderdog.challegram", "Telegram X"}, {"com.whatsapp", "WhatsApp"}, {"com.whatsapp.w4b", "WhatsApp Business"},
                {"com.google.android.youtube", "YouTube"}, {"com.google.android.apps.youtube.music", "YouTube Music"},
                {"com.facebook.katana", "Facebook"}, {"com.facebook.orca", "Messenger"}, {"com.twitter.android", "X (Twitter)"},
                {"com.discord", "Discord"}, {"org.thoughtcrime.securesms", "Signal"}, {"com.viber.voip", "Viber"},
                {"com.openai.chatgpt", "ChatGPT"}, {"com.anthropic.claude", "Claude"}, {"com.google.android.apps.bard", "Gemini"},
                {"com.zhiliaoapp.musically", "TikTok"}, {"com.ss.android.ugc.trill", "TikTok"}, {"com.linkedin.android", "LinkedIn"},
                {"com.spotify.music", "Spotify"}, {"com.netflix.mediaclient", "Netflix"}, {"com.pinterest", "Pinterest"},
                {"com.reddit.frontpage", "Reddit"}, {"tv.twitch.android.app", "Twitch"}, {"com.snapchat.android", "Snapchat"},
                {"com.patreon.android", "Patreon"}, {"com.android.chrome", "Chrome (весь браузер)"},
        };
        for (String[] a : k) KNOWN.put(a[0], a[1]);
        OFF_BY_DEFAULT.add("com.android.chrome");
    }

    /** The family's AI helper: on a bridge it goes through it whatever is ticked (the emulator test puts another app here). */
    static volatile String aiHelper = "app.aihelper.family";

    private Apps() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("vpn", Context.MODE_PRIVATE);
    }

    /** True: only the chosen apps; false: everything through the VPN. */
    static boolean onlyChosen(Context c) {
        return prefs(c).getBoolean("onlyApps", true);
    }

    static void setOnlyChosen(Context c, boolean only) {
        prefs(c).edit().putBoolean("onlyApps", only).apply();
    }

    /** One app on the phone: its package and the name shown for it. */
    static final class App {
        final String pkg, name;

        App(String pkg, String name) {
            this.pkg = pkg;
            this.name = name;
        }

        @Override
        public String toString() {
            return name;
        }
    }

    /**
     * Every app with an icon on the phone's home screen (but this one): first the known ones, then the other ticked
     * ones, then the rest, by name. Takes a moment on a phone with many apps: not on the screen's thread.
     */
    static List<App> all(Context c) {
        PackageManager pm = c.getPackageManager();
        Map<String, String> found = new HashMap<>();
        Intent main = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        for (ResolveInfo r : pm.queryIntentActivities(main, 0)) {
            String p = r.activityInfo.packageName;
            if (p.equals(c.getPackageName()) || found.containsKey(p)) continue;
            CharSequence n = r.activityInfo.applicationInfo.loadLabel(pm);
            found.put(p, n == null || n.toString().trim().isEmpty() ? p : n.toString().trim());
        }
        List<App> out = new ArrayList<>(), on = new ArrayList<>(), rest = new ArrayList<>();
        for (String p : KNOWN.keySet()) if (found.containsKey(p)) out.add(new App(p, KNOWN.get(p)));
        for (Map.Entry<String, String> e : found.entrySet()) {
            if (KNOWN.containsKey(e.getKey())) continue;
            (chosen(c, e.getKey()) ? on : rest).add(new App(e.getKey(), e.getValue()));
        }
        Collator byName = Collator.getInstance();
        Collections.sort(on, (a, b) -> byName.compare(a.name, b.name));
        Collections.sort(rest, (a, b) -> byName.compare(a.name, b.name));
        out.addAll(on);
        out.addAll(rest);
        return out;
    }

    private static boolean here(PackageManager pm, String pkg) {
        try {
            pm.getPackageInfo(pkg, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;  // not on this phone
        }
    }

    /** The known ones (but Chrome) are ticked unless switched off; any other app only when ticked. */
    private static boolean onByDefault(String pkg) {
        return KNOWN.containsKey(pkg) && !OFF_BY_DEFAULT.contains(pkg);
    }

    static boolean chosen(Context c, String pkg) {
        boolean byDefault = onByDefault(pkg);
        Set<String> s = prefs(c).getStringSet(byDefault ? "appsOff" : "appsOn", new HashSet<>());
        return byDefault != s.contains(pkg);
    }

    static void choose(Context c, String pkg, boolean on) {
        boolean byDefault = onByDefault(pkg);
        String key = byDefault ? "appsOff" : "appsOn";
        Set<String> s = new HashSet<>(prefs(c).getStringSet(key, new HashSet<>()));
        if (byDefault != on) s.add(pkg);
        else s.remove(pkg);
        prefs(c).edit().putStringSet(key, s).apply();
    }

    /** The packages that go through the VPN, or null for all of them (also when none of the chosen ones is here). */
    static List<String> through(Context c) {
        if (!onlyChosen(c)) return null;
        PackageManager pm = c.getPackageManager();
        List<String> out = new ArrayList<>(), more = new ArrayList<>(prefs(c).getStringSet("appsOn", new HashSet<>()));
        Collections.sort(more);
        for (String p : KNOWN.keySet()) if (chosen(c, p) && here(pm, p)) out.add(p);
        for (String p : more) if (!out.contains(p) && chosen(c, p) && here(pm, p)) out.add(p);
        return out.isEmpty() ? null : out;
    }

    /** «Instagram, Telegram, YouTube и ещё 2» for the main screen. */
    static String summary(Context c) {
        if (!onlyChosen(c)) return "Все приложения";
        List<String> on = through(c);
        if (on == null) return "Все приложения (не отмечено ни одно)";
        PackageManager pm = c.getPackageManager();
        List<String> names = new ArrayList<>();
        for (String p : on) {
            String n = KNOWN.get(p);
            if (n == null) {
                try {
                    n = pm.getApplicationLabel(pm.getApplicationInfo(p, 0)).toString();
                } catch (PackageManager.NameNotFoundException e) {
                    n = p;
                }
            }
            if (!names.contains(n)) names.add(n);
        }
        if (names.size() <= 3) return android.text.TextUtils.join(", ", names);
        return android.text.TextUtils.join(", ", names.subList(0, 3)) + " и ещё " + (names.size() - 3);
    }

    /** When the chosen server does not answer, Winger moves to a bridge by itself (and back once the server answers). */
    static boolean autoBridge(Context c) {
        return prefs(c).getBoolean("autoBridge", true);
    }

    static void setAutoBridge(Context c, boolean on) {
        prefs(c).edit().putBoolean("autoBridge", on).apply();
    }

    /** The VPN should come back by itself after a reboot unless the owner of the phone switched it off. */
    static boolean keepOn(Context c) {
        return prefs(c).getBoolean("keepOn", false);
    }

    static void setKeepOn(Context c, boolean on) {
        prefs(c).edit().putBoolean("keepOn", on).apply();
    }
}
