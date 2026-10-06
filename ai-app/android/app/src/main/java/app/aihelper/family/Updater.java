package app.aihelper.family;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.widget.ProgressBar;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * The app updates itself from the server: /app/apk.json says which version is there, /app/ai.apk is the file.
 * The APK is checked against the SHA-256 from apk.json; Android also checks it is signed with the same key.
 */
final class Updater {
    private static final long EVERY_MS = 6 * 3600_000L;
    private static volatile boolean busy;

    private Updater() {}

    static void check(Activity a, boolean manual) {
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
        ProgressBar bar = new ProgressBar(a, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setPadding(48, 24, 48, 24);
        AlertDialog dlg = new AlertDialog.Builder(a).setTitle("Загружаю обновление…").setView(bar).setCancelable(false).show();
        long size = Math.max(1, info.optLong("size", 1));
        File dir = new File(a.getCacheDir(), "update");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File apk = new File(dir, "ai.apk");
        new Thread(() -> {
            String err = null;
            try (FileOutputStream out = new FileOutputStream(apk)) {
                MessageDigest sha = MessageDigest.getInstance("SHA-256");
                long[] got = {0};
                int[] status = {0};
                boolean[] ok = {false};
                String[] why = {null};
                java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
                Net.start("GET", "/app/ai.apk", null, null, new Net.Sink() {
                    public void head(int s) { status[0] = s; }
                    public void data(byte[] chunk) {
                        try {
                            out.write(chunk);
                            sha.update(chunk);
                            got[0] += chunk.length;
                            int pct = (int) Math.min(100, got[0] * 100 / size);
                            a.runOnUiThread(() -> bar.setProgress(pct));
                        } catch (Exception e) {
                            why[0] = e.getMessage();
                        }
                    }
                    public void end() { ok[0] = true; done.countDown(); }
                    public void fail(String w) { why[0] = w; done.countDown(); }
                });
                done.await();
                if (!ok[0] || status[0] != 200) {
                    err = "не скачалось" + (why[0] != null ? ": " + why[0] : status[0] != 0 ? " (" + status[0] + ")" : "");
                } else {
                    StringBuilder hex = new StringBuilder();
                    for (byte b : sha.digest()) hex.append(String.format("%02x", b));
                    if (!hex.toString().equalsIgnoreCase(info.optString("sha256", ""))) err = "файл повреждён при загрузке";
                }
            } catch (Exception e) {
                err = e.getMessage();
            }
            String fail = err;
            a.runOnUiThread(() -> {
                dlg.dismiss();
                if (fail != null) {
                    Toast.makeText(a, "Обновление: " + fail + ". Попробуйте позже.", Toast.LENGTH_LONG).show();
                    return;
                }
                Uri uri = FileProvider.getUriForFile(a, Files.authority(a), apk);
                a.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK));
            });
        }, "update-download").start();
    }
}
