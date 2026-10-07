package app.aihelper.vpn;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * What goes through the VPN. By default only the apps that need it (Instagram, Telegram, WhatsApp, YouTube and the
 * like) — the VPN can then stay on all the time, and banks, Gosuslugi, marketplaces and taxis go straight, as if there
 * were no VPN. Or everything, as before.
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

    /** The known apps installed on this phone, in the list's order. */
    static List<String> installed(Context c) {
        PackageManager pm = c.getPackageManager();
        List<String> out = new ArrayList<>();
        for (String p : KNOWN.keySet()) {
            try {
                pm.getPackageInfo(p, 0);
                out.add(p);
            } catch (PackageManager.NameNotFoundException ignored) {
                // not on this phone
            }
        }
        return out;
    }

    static boolean chosen(Context c, String pkg) {
        Set<String> s = prefs(c).getStringSet(OFF_BY_DEFAULT.contains(pkg) ? "appsOn" : "appsOff", new HashSet<>());
        return OFF_BY_DEFAULT.contains(pkg) == s.contains(pkg);  // ticked by default unless switched off, and the reverse
    }

    static void choose(Context c, String pkg, boolean on) {
        String key = OFF_BY_DEFAULT.contains(pkg) ? "appsOn" : "appsOff";
        Set<String> s = new HashSet<>(prefs(c).getStringSet(key, new HashSet<>()));
        if (OFF_BY_DEFAULT.contains(pkg) == on) s.add(pkg);
        else s.remove(pkg);
        prefs(c).edit().putStringSet(key, s).apply();
    }

    /** The packages that go through the VPN, or null for all of them (also when none of the chosen ones is here). */
    static List<String> through(Context c) {
        if (!onlyChosen(c)) return null;
        List<String> out = new ArrayList<>();
        for (String p : installed(c)) if (chosen(c, p)) out.add(p);
        return out.isEmpty() ? null : out;
    }

    /** «Instagram, Telegram, YouTube и ещё 2» for the main screen. */
    static String summary(Context c) {
        if (!onlyChosen(c)) return "Все приложения";
        List<String> on = through(c);
        if (on == null) return "Все приложения (нужных пока не установлено)";
        List<String> names = new ArrayList<>();
        for (String p : on) {
            String n = KNOWN.get(p);
            if (!names.contains(n)) names.add(n);
        }
        if (names.size() <= 3) return android.text.TextUtils.join(", ", names);
        return android.text.TextUtils.join(", ", names.subList(0, 3)) + " и ещё " + (names.size() - 3);
    }

    /** The VPN should come back by itself after a reboot unless the owner of the phone switched it off. */
    static boolean keepOn(Context c) {
        return prefs(c).getBoolean("keepOn", false);
    }

    static void setKeepOn(Context c, boolean on) {
        prefs(c).edit().putBoolean("keepOn", on).apply();
    }
}
