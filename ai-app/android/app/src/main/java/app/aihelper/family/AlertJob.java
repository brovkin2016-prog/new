package app.aihelper.family;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * For the owner only: every 15 minutes or so asks the server what happened (a bridge down, the VPN back, a backup
 * ready) and shows it as a phone notification. Nothing runs for anyone else.
 */
public final class AlertJob extends JobService {
    private static final int JOB = 42;
    private static final String CHANNEL = "alerts";

    static void schedule(Context c, String token) {
        SharedPreferences p = c.getSharedPreferences("app", Context.MODE_PRIVATE);
        JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (token == null || token.isEmpty()) {
            p.edit().remove("ownerToken").apply();
            if (js != null) js.cancel(JOB);
            return;
        }
        boolean same = token.equals(p.getString("ownerToken", ""));
        p.edit().putString("ownerToken", token).apply();
        if (js == null || (same && js.getPendingJob(JOB) != null)) return;
        if (since(p) == 0) setSince(p, System.currentTimeMillis() / 1000.0);
        js.schedule(new JobInfo.Builder(JOB, new ComponentName(c, AlertJob.class))
                .setPeriodic(15 * 60 * 1000L)
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setPersisted(true)
                .build());
    }

    @Override
    public boolean onStartJob(JobParameters params) {
        new Thread(() -> {
            try {
                check(this);
            } catch (Exception ignored) {
                // try next time
            }
            jobFinished(params, false);
        }, "alerts").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }

    private static void check(Context c) throws Exception {
        SharedPreferences p = c.getSharedPreferences("app", Context.MODE_PRIVATE);
        String token = p.getString("ownerToken", ""), host = p.getString("host", "");
        if (token.isEmpty() || host.isEmpty()) return;
        Net.setHost(c, host);
        double since = since(p);
        Map<String, String> h = new HashMap<>();
        h.put("Authorization", "Bearer " + token);
        h.put("Content-Type", "application/json");
        byte[] body = new JSONObject().put("op", "alerts").put("since", since).toString().getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int[] status = {0};
        CountDownLatch done = new CountDownLatch(1);
        Net.start("POST", "/api/panel", h, body, new Net.Sink() {
            public void head(int s) { status[0] = s; }
            public void data(byte[] chunk) { out.write(chunk, 0, chunk.length); }
            public void end() { done.countDown(); }
            public void fail(String why) { done.countDown(); }
        });
        if (!done.await(60, TimeUnit.SECONDS) || status[0] != 200) return;
        JSONObject last = null;
        for (String line : out.toString("UTF-8").split("\n")) {
            if (!line.startsWith("data: ")) continue;
            JSONObject ev = new JSONObject(line.substring(6));
            if ("done".equals(ev.optString("t"))) last = ev;
        }
        if (last == null) return;
        JSONArray items = last.optJSONArray("alerts");
        double now = last.optDouble("now", since);
        if (items != null) {
            for (int i = 0; i < items.length(); i++) {
                JSONObject a = items.getJSONObject(i);
                if (!"log".equals(a.optString("kind"))) notify(c, a.optString("text"), (int) (a.optDouble("ts") % 100000));
            }
        }
        setSince(p, now);
    }

    /** Since when the alerts were seen, in seconds. Kept as text: a float has only 128-second steps at today's dates,
     *  which showed some alerts twice or never; the old float value is read once and then replaced. */
    private static double since(SharedPreferences p) {
        String s = p.getString("alertsAt", null);
        if (s != null) {
            try {
                return Double.parseDouble(s);
            } catch (NumberFormatException ignored) {
                // written by hand: start again from the old value
            }
        }
        return p.getFloat("alertsSince", 0);
    }

    private static void setSince(SharedPreferences p, double v) {
        p.edit().putString("alertsAt", Double.toString(v)).apply();
    }

    @SuppressWarnings("deprecation")
    private static void notify(Context c, String text, int id) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || text.isEmpty()) return;
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            if (nm.getNotificationChannel(CHANNEL) == null) {
                nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Сервер", NotificationManager.IMPORTANCE_HIGH));
            }
            b = new Notification.Builder(c, CHANNEL);
        } else {
            b = new Notification.Builder(c).setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        }
        int nl = text.indexOf('\n');
        PendingIntent open = PendingIntent.getActivity(c, 0, new Intent(c, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        nm.notify(1000 + id, b.setSmallIcon(R.drawable.ic_launcher_fg)
                .setContentTitle(nl > 0 ? text.substring(0, nl) : text)
                .setContentText(nl > 0 ? text.substring(nl + 1) : "Сервер")
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .setAutoCancel(true)
                .build());
    }
}
