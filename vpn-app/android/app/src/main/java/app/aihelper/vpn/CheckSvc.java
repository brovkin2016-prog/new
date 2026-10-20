package app.aihelper.vpn;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONObject;

/**
 * Keeps Winger going while it checks the bridges (a few minutes), with a notice that says how far it is; when it is
 * done the notice tells how many bridges carry. Started from the screen (the button, or the AI helper asking for the
 * server's Claude); while the VPN is on, the VPN service runs the server's asks itself.
 */
public final class CheckSvc extends Service {
    static final String TASK = "task";
    private static final String CHANNEL = "check";
    private static final int NOTE_ID = 7003;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!BridgeCheck.running.get()) return;
            notifyNow(BridgeCheck.progress.isEmpty() ? "Проверяю мосты…" : BridgeCheck.progress, true);
            main.postDelayed(this, 1000);
        }
    };

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = note("Проверяю мосты…", true);
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTE_ID, n);
        String task = intent == null ? "" : intent.getStringExtra(TASK);
        if (!BridgeCheck.start(this, task, () -> main.post(this::finish))) {
            finish();  // one already runs (the VPN service's): its own report comes
            return START_NOT_STICKY;
        }
        main.postDelayed(tick, 1000);
        return START_NOT_STICKY;
    }

    private void finish() {
        main.removeCallbacks(tick);
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_DETACH);
        JSONObject r = BridgeCheck.last(this);
        if (r != null && BridgeCheck.fresh) notifyNow(result(r), false);
        stopSelf();
    }

    /** «Мосты: 2 из 4 работают» — the notice left when it is done. */
    static String result(JSONObject r) {
        org.json.JSONArray b = r.optJSONArray("bridges");
        int all = b == null ? 0 : b.length(), ok = 0;
        for (int i = 0; i < all; i++) {
            String res = b.optJSONObject(i).optString("result");
            if (res.equals("ok") || res.equals("in_use")) ok++;
        }
        return all == 0 ? "Мостов на этом телефоне нет" : "Мосты: " + ok + " из " + all + " работают — подробно в Winger";
    }

    private void notifyNow(String text, boolean ongoing) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTE_ID, note(text, ongoing));
    }

    private Notification note(String text, boolean ongoing) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
                nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Проверка мостов", NotificationManager.IMPORTANCE_LOW));
            }
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        Intent open = new Intent(this, MainActivity.class).putExtra("show_check", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return b.setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(ongoing ? "Winger проверяет мосты" : "Проверка мостов готова")
                .setContentText(text)
                .setOngoing(ongoing)
                .setAutoCancel(!ongoing)
                .setContentIntent(PendingIntent.getActivity(this, 9, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                .build();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        main.removeCallbacks(tick);
        super.onDestroy();
    }
}
