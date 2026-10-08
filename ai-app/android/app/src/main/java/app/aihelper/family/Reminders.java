package app.aihelper.family;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.List;

/**
 * Reminders the person asked for in the chat («Напомни завтра в 9 выпить таблетку»). The server only works out when and
 * what; the phone rings by itself at that time (an alarm), with no network needed then. They live in the app's own
 * storage and come back after the phone restarts; a repeating one moves on to its next time.
 */
public final class Reminders extends BroadcastReceiver {
    private static final String TAG = "AIREM", PREFS = "reminders", CHANNEL = "reminders";

    @Override
    public void onReceive(Context c, Intent i) {  // an alarm of this app (not reachable from other apps)
        String id = i.getStringExtra("id");
        if (id != null) fire(c, id);
    }

    /** The phone started, the app was updated, the clock or the time zone changed: every reminder set again. */
    public static final class Boot extends BroadcastReceiver {
        @Override
        public void onReceive(Context c, Intent i) {
            scheduleAll(c);
        }
    }

    /** {"at": unix seconds, "text": "…", "repeat": "none|daily|weekly|monthly"} → the reminder's id, or "" if not valid. */
    static synchronized String add(Context c, String json) {
        try {
            JSONObject in = new JSONObject(json);
            long at = (long) (in.getDouble("at") * 1000);
            String text = in.optString("text", "").trim();
            if (text.isEmpty() || at <= 0) return "";
            byte[] b = new byte[6];
            new SecureRandom().nextBytes(b);
            StringBuilder id = new StringBuilder();
            for (byte x : b) id.append(String.format("%02x", x));
            String repeat = in.optString("repeat", "none");
            if (!repeat.equals("daily") && !repeat.equals("weekly") && !repeat.equals("monthly")) repeat = "none";
            while (at < System.currentTimeMillis() - 60_000 && !repeat.equals("none")) at = next(at, repeat);
            JSONObject r = new JSONObject().put("id", id.toString()).put("at", at).put("text", text.length() > 300 ? text.substring(0, 300) : text)
                    .put("repeat", repeat);
            JSONArray all = load(c);
            all.put(r);
            save(c, all);
            schedule(c, r);
            Log.i(TAG, "added " + id + " at " + at);
            return id.toString();
        } catch (Exception e) {
            Log.w(TAG, "add: " + e);
            return "";
        }
    }

    /** All of them, the nearest first: [{"id", "at" (ms), "text", "repeat"}]. */
    static synchronized String list(Context c) {
        List<JSONObject> rows = new ArrayList<>();
        JSONArray all = load(c);
        for (int i = 0; i < all.length(); i++) rows.add(all.optJSONObject(i));
        Collections.sort(rows, (a, b) -> Long.compare(a.optLong("at"), b.optLong("at")));
        return new JSONArray(rows).toString();
    }

    static synchronized void remove(Context c, String id) {
        JSONArray all = load(c), keep = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject r = all.optJSONObject(i);
            if (r != null && !id.equals(r.optString("id"))) keep.put(r);
        }
        save(c, keep);
        alarms(c).cancel(pending(c, id));
    }

    /** After a restart: every reminder set again; a one-off missed while the phone was off rings now. */
    static synchronized void scheduleAll(Context c) {
        JSONArray all = load(c);
        long now = System.currentTimeMillis();
        for (int i = 0; i < all.length(); i++) {
            JSONObject r = all.optJSONObject(i);
            if (r == null) continue;
            try {
                String repeat = r.optString("repeat", "none");
                long at = r.optLong("at");
                while (!repeat.equals("none") && at < now - 60_000) at = next(at, repeat);
                r.put("at", Math.max(at, now + 5_000));
            } catch (Exception ignored) {
                // left as it was
            }
            schedule(c, r);
        }
        save(c, all);
    }

    private static synchronized void fire(Context c, String id) {
        JSONArray all = load(c), keep = new JSONArray();
        JSONObject hit = null;
        for (int i = 0; i < all.length(); i++) {
            JSONObject r = all.optJSONObject(i);
            if (r == null) continue;
            if (id.equals(r.optString("id"))) {
                hit = r;
                String repeat = r.optString("repeat", "none");
                if (!repeat.equals("none")) {
                    try {
                        long at = r.optLong("at");
                        do at = next(at, repeat); while (at < System.currentTimeMillis());
                        r.put("at", at);
                        keep.put(r);
                        schedule(c, r);
                    } catch (Exception ignored) {
                        // a one-off then
                    }
                }
            } else {
                keep.put(r);
            }
        }
        save(c, keep);
        if (hit != null) {
            Log.i(TAG, "ring " + id);
            notify(c, hit.optString("text"), id.hashCode());
        }
    }

    static long next(long at, String repeat) {
        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(at);
        if (repeat.equals("daily")) cal.add(Calendar.DAY_OF_MONTH, 1);
        else if (repeat.equals("weekly")) cal.add(Calendar.DAY_OF_MONTH, 7);
        else cal.add(Calendar.MONTH, 1);  // 31 Jan → the end of February, as a calendar does
        return cal.getTimeInMillis();
    }

    private static void schedule(Context c, JSONObject r) {
        AlarmManager am = alarms(c);
        PendingIntent pi = pending(c, r.optString("id"));
        long at = r.optLong("at");
        // exact when the phone lets the app (Android 12+ may ask for it); otherwise Android rings within a few minutes
        if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
        else am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
    }

    private static PendingIntent pending(Context c, String id) {
        Intent i = new Intent(c, Reminders.class).putExtra("id", id).setAction("app.aihelper.family.REMIND." + id);
        return PendingIntent.getBroadcast(c, id.hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static AlarmManager alarms(Context c) {
        return (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
    }

    private static JSONArray load(Context c) {
        try {
            return new JSONArray(prefs(c).getString("all", "[]"));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private static void save(Context c, JSONArray all) {
        prefs(c).edit().putString("all", all.toString()).apply();
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @SuppressWarnings("deprecation")
    private static void notify(Context c, String text, int id) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            if (nm.getNotificationChannel(CHANNEL) == null) {
                nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Напоминания", NotificationManager.IMPORTANCE_HIGH));
            }
            b = new Notification.Builder(c, CHANNEL);
        } else {
            b = new Notification.Builder(c).setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        }
        PendingIntent open = PendingIntent.getActivity(c, 0, new Intent(c, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        nm.notify(5000 + (id & 0xffff), b.setSmallIcon(R.drawable.ic_launcher_fg)
                .setContentTitle("⏰ Напоминание")
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setCategory(Notification.CATEGORY_REMINDER)
                .setContentIntent(open)
                .setAutoCancel(true)
                .build());
    }
}
