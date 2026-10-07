package app.aihelper.family;

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
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.concurrent.CountDownLatch;

/**
 * The app updates itself from the server: /app/apk.json says which version is there, /app/ai.apk is the file.
 * The download resumes where it broke (a few tries), the file is checked against the SHA-256 from apk.json and
 * against the signing key of the installed app, and it is installed through the system's package installer, so a
 * refusal comes back with its real reason instead of a bare "App not installed".
 */
final class Updater {
    private static final long EVERY_MS = 6 * 3600_000L;
    private static final String RESULT = "app.aihelper.family.INSTALL_RESULT";
    private static final int TRIES = 6;
    private static volatile boolean busy, cancelled;
    private static WeakReference<Activity> current = new WeakReference<>(null);

    private Updater() {}

    static void check(Activity a, boolean manual) {
        current = new WeakReference<>(a);
        SharedPreferences prefs = a.getSharedPreferences("app", Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        if (busy || Net.host.isEmpty() || (!manual && now - prefs.getLong("updateCheck", 0) < EVERY_MS)) return;
        busy = true;
        if (manual) Toast.makeText(a, "Проверяю обновление…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            JSONObject info = null;
            try {
                byte[] raw = Net.get("/app/apk.json", 20_000);
                if (raw != null) info = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            } catch (Exception ignored) {
                // no info: nothing to offer
            }
            JSONObject found = info;
            a.runOnUiThread(() -> {
                busy = false;
                if (a.isFinishing()) return;
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
                        .setMessage((notes.isEmpty() ? "Доступно обновление приложения." : notes) + "\n\nРазмер: "
                                + Math.max(1, found.optLong("size", 0) / 1_000_000) + " МБ")
                        .setPositiveButton("Обновить", (d, w) -> download(a, found))
                        .setNegativeButton("Позже", null)
                        .show();
            });
        }, "update-check").start();
    }

    private static void download(Activity a, JSONObject info) {
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
        cancelled = false;
        AlertDialog dlg = new AlertDialog.Builder(a).setTitle("Загружаю обновление " + info.optString("name", ""))
                .setView(box).setCancelable(false)
                .setNegativeButton("Отмена", (d, w) -> cancelled = true).show();
        long size = Math.max(1, info.optLong("size", 1));
        String want = info.optString("sha256", "");
        File dir = new File(a.getCacheDir(), "update");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File apk = new File(dir, "ai-" + info.optInt("code", 0) + ".apk");  // a broken download of this version resumes
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) if (!f.equals(apk)) //noinspection ResultOfMethodCallIgnored
            f.delete();
        new Thread(() -> {
            String err = null;
            for (int t = 0; t < TRIES && !cancelled; t++) {
                if (apk.length() >= size) break;
                if (t > 0) {
                    int n = t;
                    a.runOnUiThread(() -> line.setText("Связь прервалась, продолжаю… (попытка " + (n + 1) + " из " + TRIES + ")"));
                    sleep(1500L * t);
                }
                err = fetch(a, apk, size, bar, line);
                if (err == null && apk.length() >= size) break;
            }
            if (cancelled) err = "отменено";
            else if (apk.length() < size && err == null) err = "файл скачался не целиком";
            if (err == null) {
                a.runOnUiThread(() -> line.setText("Проверяю файл…"));
                if (!want.equalsIgnoreCase(sha256(apk))) {
                    //noinspection ResultOfMethodCallIgnored
                    apk.delete();  // next time from the start
                    err = "файл повреждён при загрузке";
                }
            }
            String fail = err;
            boolean otherKey = fail == null && !sameSigner(a, apk);
            a.runOnUiThread(() -> {
                dlg.dismiss();
                if (fail != null) {
                    if (cancelled) return;
                    new AlertDialog.Builder(a).setTitle("Обновление не скачалось")
                            .setMessage("Причина: " + fail + ".\n\nСкачанная часть сохранена — при повторе загрузка продолжится с места обрыва.")
                            .setPositiveButton("Повторить", (d, w) -> download(a, info))
                            .setNegativeButton("Позже", null).show();
                    return;
                }
                if (otherKey) {
                    otherKeyHelp(a, apk);
                    return;
                }
                install(a, apk);
            });
        }, "update-download").start();
    }

    /** One pass: continues the file from its current length (Range), or starts over when the server sends it whole. */
    private static String fetch(Activity a, File apk, long size, ProgressBar bar, TextView line) {
        long have = apk.length();
        Map<String, String> h = new HashMap<>();
        if (have > 0) h.put("Range", "bytes=" + have + "-");
        int[] status = {0};
        boolean[] ok = {false};
        String[] why = {null};
        long[] got = {have};
        OutputStream[] out = {null};
        CountDownLatch done = new CountDownLatch(1);
        Net.start("GET", "/app/ai.apk", h, null, new Net.Sink() {
            public void head(int s) {
                status[0] = s;
                try {
                    if (s == 206) out[0] = new FileOutputStream(apk, true);
                    else if (s == 200) {
                        got[0] = 0;
                        out[0] = new FileOutputStream(apk, false);
                    }
                } catch (Exception e) {
                    why[0] = e.getMessage();
                }
            }
            public void data(byte[] chunk) {
                if (out[0] == null || cancelled) return;
                try {
                    out[0].write(chunk);
                    got[0] += chunk.length;
                    long g = got[0];
                    a.runOnUiThread(() -> {
                        bar.setProgress((int) Math.min(1000, g * 1000 / size));
                        line.setText(String.format(java.util.Locale.ROOT, "%.1f из %.1f МБ", g / 1e6, size / 1e6));
                    });
                } catch (Exception e) {
                    why[0] = e.getMessage();
                }
            }
            public void end() { ok[0] = true; done.countDown(); }
            public void fail(String w) { why[0] = w; done.countDown(); }
        });
        try {
            done.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        try {
            if (out[0] != null) out[0].close();
        } catch (Exception ignored) {
            // the next pass looks at the file length anyway
        }
        if (status[0] == 416) {  // the file here is longer than the server's: start over
            //noinspection ResultOfMethodCallIgnored
            apk.delete();
            return "файл на сервере сменился";
        }
        if (status[0] != 200 && status[0] != 206) return status[0] == 0 ? "нет связи с сервером" + (why[0] != null ? " (" + why[0] + ")" : "") : "сервер ответил " + status[0];
        return ok[0] ? null : "связь прервалась" + (why[0] != null ? " (" + why[0] + ")" : "");
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
            Signature[] a = mine.signatures, b = theirs.signatures;
            return new HashSet<>(Arrays.asList(a)).equals(new HashSet<>(Arrays.asList(b)));
        } catch (Exception e) {
            return true;
        }
    }

    private static void otherKeyHelp(Activity a, File apk) {
        new AlertDialog.Builder(a).setTitle("Нужна переустановка")
                .setMessage("Новая версия подписана другим ключом, чем установленная (так бывает, если сервер "
                        + "переустанавливали с нуля). Поверх старой Android её не поставит.\n\n"
                        + "1. Нажмите «Сохранить файл» — он ляжет в «Загрузки».\n"
                        + "2. Удалите это приложение.\n"
                        + "3. Откройте файл из «Загрузок» и установите.\n"
                        + "4. Войдите новым кодом: владелец получит его на сервере командой aiapp-owner, "
                        + "остальным его даст владелец в «Управление» → «Приложение».")
                .setPositiveButton("Сохранить файл", (d, w) -> {
                    try {
                        Files.save(a, "ИИ-помощник.apk", "application/vnd.android.package-archive", readAll(apk));
                    } catch (Exception e) {
                        Toast.makeText(a, "Не сохранилось: " + e.getMessage(), Toast.LENGTH_LONG).show();
                    }
                })
                .setNeutralButton("Удалить приложение", (d, w) -> a.startActivity(
                        new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + a.getPackageName()))))
                .setNegativeButton("Закрыть", null).show();
    }

    /** Through the system's package installer: the answer comes back with its status and reason. */
    private static void install(Activity a, File apk) {
        Context app = a.getApplicationContext();
        try {
            PackageInstaller pi = app.getPackageManager().getPackageInstaller();
            PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
            p.setAppPackageName(app.getPackageName());
            p.setSize(apk.length());
            int id = pi.createSession(p);
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
        } catch (Exception e) {
            new AlertDialog.Builder(a).setTitle("Не получилось начать установку")
                    .setMessage(String.valueOf(e.getMessage())).setPositiveButton("OK", null).show();
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
                if (a != null && !a.isFinishing()) {
                    new AlertDialog.Builder(a).setTitle("Не установилось").setMessage(text).setPositiveButton("OK", null).show();
                } else {
                    Toast.makeText(c, text, Toast.LENGTH_LONG).show();
                }
            }
        };
        if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(r, new IntentFilter(RESULT), Context.RECEIVER_NOT_EXPORTED);
        else app.registerReceiver(r, new IntentFilter(RESULT));
    }

    private static byte[] readAll(File f) throws java.io.IOException {
        try (InputStream in = new FileInputStream(f); java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream()) {
            byte[] buf = new byte[65536];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        }
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

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
