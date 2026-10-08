package app.aihelper.vpn;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The app updates itself from the family server named in its link: /app/vpn.json says which version is there,
 * /app/vpn.apk is the file. With the VPN on, it goes through the tunnel. A broken download continues where it
 * stopped (a few tries), the file is checked against its SHA-256 and against this app's signing key, and it is
 * installed through the system's package installer, so a refusal comes back with its real reason.
 */
final class Updater {
    private static final long EVERY_MS = 6 * 3600_000L;
    private static final String RESULT = "app.aihelper.vpn.INSTALL_RESULT";
    private static final int TRIES = 6;
    private static volatile boolean busy, downloading;
    private static WeakReference<Activity> current = new WeakReference<>(null);

    private Updater() {}

    static HttpURLConnection open(String url) throws Exception {
        int port = VpnSvc.socksPort;
        URL u = new URL(url);
        HttpURLConnection c = (HttpURLConnection) (port > 0
                ? u.openConnection(new Proxy(Proxy.Type.SOCKS, new InetSocketAddress("127.0.0.1", port)))
                : u.openConnection());
        c.setConnectTimeout(15_000);
        c.setReadTimeout(30_000);
        c.setUseCaches(false);
        return c;
    }

    static void check(Activity a, boolean manual) {
        current = new WeakReference<>(a);
        String host = Profile.homeHost(a);
        SharedPreferences prefs = a.getSharedPreferences("vpn", Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        if (busy || host == null || (!manual && now - prefs.getLong("updateCheck", 0) < EVERY_MS)) return;
        busy = true;
        String base = "https://" + host + ":8443/app/";
        new Thread(() -> {
            JSONObject info = null;
            try {
                HttpURLConnection c = open(base + "vpn.json");
                if (c.getResponseCode() == 200) {
                    try (InputStream in = c.getInputStream()) {
                        ByteArrayOutputStream buf = new ByteArrayOutputStream();
                        byte[] b = new byte[8192];
                        for (int n; (n = in.read(b)) > 0; ) buf.write(b, 0, n);
                        info = new JSONObject(buf.toString("UTF-8"));
                    }
                }
                c.disconnect();
            } catch (Exception ignored) {
                // no answer: try another time
            }
            JSONObject found = info;
            a.runOnUiThread(() -> {
                busy = false;
                if (!alive(a)) return;
                if (found == null) {
                    if (manual) Toast.makeText(a, "Сервер не ответил — попробуйте позже", Toast.LENGTH_LONG).show();
                    return;
                }
                prefs.edit().putLong("updateCheck", now).apply();
                if (found.optInt("code", 0) <= BuildConfig.VERSION_CODE) {
                    if (manual) Toast.makeText(a, "У вас последняя версия", Toast.LENGTH_SHORT).show();
                    return;
                }
                String notes = found.optString("notes", "");
                new AlertDialog.Builder(a)
                        .setTitle("Новая версия " + found.optString("name", ""))
                        .setMessage((notes.isEmpty() ? "Доступно обновление." : notes) + "\n\nРазмер: "
                                + Math.max(1, found.optLong("size", 0) / 1_000_000) + " МБ")
                        .setPositiveButton("Обновить", (d, w) -> download(a, base, found))
                        .setNegativeButton("Позже", null)
                        .show();
            });
        }, "update-check").start();
    }

    /** The screen can still show a dialog (not closed, not destroyed by a rotation or a language change). */
    private static boolean alive(Activity a) {
        return a != null && !a.isFinishing() && !a.isDestroyed();
    }

    private static void download(Activity a, String base, JSONObject info) {
        if (downloading) {
            Toast.makeText(a, "Обновление уже загружается", Toast.LENGTH_SHORT).show();
            return;
        }
        if (Build.VERSION.SDK_INT >= 26 && !a.getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(a)
                    .setTitle("Нужно одно разрешение")
                    .setMessage("Чтобы приложение могло обновляться само, разрешите ему установку приложений, "
                            + "затем вернитесь и нажмите «Обновить» ещё раз.")
                    .setPositiveButton("Открыть настройки", (d, w) -> a.startActivity(new Intent(
                            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName()))))
                    .setNegativeButton("Отмена", null)
                    .show();
            return;
        }
        int pad = (int) (20 * a.getResources().getDisplayMetrics().density);
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(pad, pad / 2, pad, 0);
        ProgressBar bar = new ProgressBar(a, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(1000);
        TextView line = new TextView(a);
        line.setPadding(0, pad / 3, 0, 0);
        line.setText("Подключаюсь…");
        box.addView(bar);
        box.addView(line);
        AtomicBoolean stop = new AtomicBoolean();  // this download's own: a new one after «Отмена» starts clean
        downloading = true;
        AlertDialog dlg = new AlertDialog.Builder(a).setTitle("Загружаю обновление " + info.optString("name", ""))
                .setView(box).setCancelable(false)
                .setNegativeButton("Отмена", (d, w) -> stop.set(true)).show();
        long size = Math.max(1, info.optLong("size", 1));
        String want = info.optString("sha256", "");
        File dir = new File(a.getCacheDir(), "update");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File apk = new File(dir, "vpn-" + info.optInt("code", 0) + ".apk");  // a broken download of this version resumes
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) if (!f.equals(apk)) //noinspection ResultOfMethodCallIgnored
            f.delete();
        new Thread(() -> {
            String err = null;
            for (int t = 0; t < TRIES && !stop.get(); t++) {
                if (apk.length() >= size) break;
                if (t > 0) {
                    int n = t;
                    a.runOnUiThread(() -> line.setText("Связь прервалась, продолжаю… (попытка " + (n + 1) + " из " + TRIES + ")"));
                    try {
                        Thread.sleep(1500L * t);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }
                err = fetch(a, base + "vpn.apk", apk, size, bar, line, stop);
                if (err == null && apk.length() >= size) break;
            }
            if (stop.get()) err = "отменено";
            else if (apk.length() < size && err == null) err = "файл скачался не целиком";
            if (err == null && !want.equalsIgnoreCase(sha256(apk))) {
                //noinspection ResultOfMethodCallIgnored
                apk.delete();  // next time from the start
                err = "файл повреждён при загрузке";
            }
            String fail = err;
            boolean otherKey = fail == null && !sameSigner(a, apk);
            a.runOnUiThread(() -> {
                downloading = false;
                if (alive(a)) dlg.dismiss();
                if (stop.get()) return;
                if (fail != null) {
                    if (!alive(a)) return;
                    new AlertDialog.Builder(a).setTitle("Обновление не скачалось")
                            .setMessage("Причина: " + fail + ".\n\nСкачанная часть сохранена — при повторе загрузка продолжится с места обрыва.")
                            .setPositiveButton("Повторить", (d, w) -> download(a, base, info))
                            .setNegativeButton("Позже", null).show();
                    return;
                }
                if (otherKey) {
                    if (!alive(a)) return;
                    new AlertDialog.Builder(a).setTitle("Нужна переустановка")
                            .setMessage("Новая версия подписана другим ключом (сервер переустанавливали с нуля). Удалите это "
                                    + "приложение и поставьте его заново из файла, который пришлёт владелец, затем вставьте ссылку.")
                            .setPositiveButton("Удалить приложение", (d, w) -> a.startActivity(
                                    new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + a.getPackageName()))))
                            .setNegativeButton("Закрыть", null).show();
                    return;
                }
                install(a, apk);
            });
        }, "update-download").start();
    }

    /** One pass: continues the file from its current length (Range), or starts over when the server sends it whole. */
    private static String fetch(Activity a, String url, File apk, long size, ProgressBar bar, TextView line, AtomicBoolean stop) {
        long have = apk.length();
        HttpURLConnection c = null;
        try {
            c = open(url);
            if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
            int code = c.getResponseCode();
            if (code == 416) {
                //noinspection ResultOfMethodCallIgnored
                apk.delete();
                return "файл на сервере сменился";
            }
            if (code != 200 && code != 206) return "сервер ответил " + code;
            long got = code == 206 ? have : 0;
            try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(apk, code == 206)) {
                byte[] b = new byte[64 * 1024];
                for (int n; !stop.get() && (n = in.read(b)) > 0; ) {
                    out.write(b, 0, n);
                    got += n;
                    long g = got;
                    a.runOnUiThread(() -> {
                        bar.setProgress((int) Math.min(1000, g * 1000 / size));
                        line.setText(String.format(java.util.Locale.ROOT, "%.1f из %.1f МБ", g / 1e6, size / 1e6));
                    });
                }
            }
            return null;
        } catch (Exception e) {
            return "связь прервалась";
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** The new file must be signed with the same key as this app, or Android refuses it with a bare "not installed". */
    @SuppressWarnings("deprecation")
    private static boolean sameSigner(Context c, File apk) {
        try {
            PackageManager pm = c.getPackageManager();
            if (Build.VERSION.SDK_INT >= 28) {
                PackageInfo mine = pm.getPackageInfo(c.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
                PackageInfo theirs = pm.getPackageArchiveInfo(apk.getPath(), PackageManager.GET_SIGNING_CERTIFICATES);
                if (theirs == null || theirs.signingInfo == null || mine.signingInfo == null) return true;  // cannot tell
                return new HashSet<>(Arrays.asList(mine.signingInfo.getApkContentsSigners()))
                        .equals(new HashSet<>(Arrays.asList(theirs.signingInfo.getApkContentsSigners())));
            }
            PackageInfo mine = pm.getPackageInfo(c.getPackageName(), PackageManager.GET_SIGNATURES);
            PackageInfo theirs = pm.getPackageArchiveInfo(apk.getPath(), PackageManager.GET_SIGNATURES);
            if (theirs == null || theirs.signatures == null || theirs.signatures.length == 0) return true;
            return new HashSet<>(Arrays.asList(mine.signatures)).equals(new HashSet<>(Arrays.asList(theirs.signatures)));
        } catch (Exception e) {
            return true;
        }
    }

    /** The emulator test only: installs the newer build it put into the cache, the same way as a real update. */
    static void testInstall(Activity a) {
        current = new WeakReference<>(a);
        install(a, new File(a.getCacheDir(), "update/test.apk"));
    }

    /** Through the system's package installer: the answer comes back with its status and reason. */
    private static void install(Activity a, File apk) {
        Context app = a.getApplicationContext();
        new Thread(() -> {
            String err = write(app, apk);
            if (err == null) return;
            a.runOnUiThread(() -> {
                if (alive(a)) {
                    new AlertDialog.Builder(a).setTitle("Не получилось начать установку")
                            .setMessage(err).setPositiveButton("OK", null).show();
                } else {
                    Toast.makeText(app, "Не получилось начать установку: " + err, Toast.LENGTH_LONG).show();
                }
            });
        }, "update-install").start();
    }

    /** Hands the file to Android's installer (the copy takes a few seconds: not on the screen's thread). Null when done. */
    private static String write(Context app, File apk) {
        PackageInstaller pi = app.getPackageManager().getPackageInstaller();
        int id = -1;
        try {
            PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            p.setAppPackageName(app.getPackageName());
            p.setSize(apk.length());
            id = pi.createSession(p);
            try (PackageInstaller.Session s = pi.openSession(id)) {
                // the file goes in and its stream is closed exactly once, before the commit
                try (InputStream in = new FileInputStream(apk); OutputStream out = s.openWrite("base.apk", 0, apk.length())) {
                    byte[] buf = new byte[65536];
                    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                    s.fsync(out);
                }
                listen(app);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                PendingIntent pend = PendingIntent.getBroadcast(app, id, new Intent(RESULT).setPackage(app.getPackageName()), flags);
                s.commit(pend.getIntentSender());
            }
            return null;
        } catch (Exception e) {
            Log.w("AIVPN", "install: " + e);
            if (id >= 0) {
                try {
                    pi.abandonSession(id);  // not left half-written in the phone's installer
                } catch (Exception ignored) {
                    // committed or gone already
                }
            }
            return String.valueOf(e.getMessage());
        }
    }

    private static boolean listening;

    private static synchronized void listen(Context app) {
        if (listening) return;
        listening = true;
        BroadcastReceiver r = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                int status = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
                Log.i("AIVPN", "install status " + status + " " + i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
                if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                    @SuppressWarnings("deprecation")
                    Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
                    if (confirm != null) c.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    return;
                }
                if (status == PackageInstaller.STATUS_SUCCESS || status == PackageInstaller.STATUS_FAILURE_ABORTED) return;
                String why;
                switch (status) {
                    case PackageInstaller.STATUS_FAILURE_CONFLICT:
                        why = "конфликт с установленной версией — обычно это другой ключ подписи. Удалите приложение и поставьте файл заново.";
                        break;
                    case PackageInstaller.STATUS_FAILURE_STORAGE:
                        why = "на телефоне мало места. Освободите 50–100 МБ и повторите.";
                        break;
                    case PackageInstaller.STATUS_FAILURE_INVALID:
                        why = "файл повреждён. Повторите обновление — он скачается заново.";
                        break;
                    case PackageInstaller.STATUS_FAILURE_INCOMPATIBLE:
                        why = "эта версия не подходит к телефону.";
                        break;
                    case PackageInstaller.STATUS_FAILURE_BLOCKED:
                        why = "установку запретил телефон (Play Защита или ограничения).";
                        break;
                    default:
                        why = "Android отказал.";
                }
                String detail = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
                Activity a = current.get();
                String text = "Обновление не установлено: " + why + (detail != null ? "\n\n(" + detail + ")" : "");
                if (alive(a)) {
                    new AlertDialog.Builder(a).setTitle("Не установилось").setMessage(text).setPositiveButton("OK", null).show();
                } else {
                    Toast.makeText(c, text, Toast.LENGTH_LONG).show();
                }
            }
        };
        if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(r, new IntentFilter(RESULT), Context.RECEIVER_NOT_EXPORTED);
        else app.registerReceiver(r, new IntentFilter(RESULT));
    }

    private static String sha256(File f) {
        try (InputStream in = new FileInputStream(f)) {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[65536];
            for (int n; (n = in.read(buf)) > 0; ) sha.update(buf, 0, n);
            StringBuilder hex = new StringBuilder();
            for (byte b : sha.digest()) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (Exception e) {
            return "";
        }
    }
}
