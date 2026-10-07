package app.aihelper.vpn;

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

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.URL;
import java.security.MessageDigest;

/**
 * The app updates itself from the family server named in its link: /app/vpn.json says which version is there,
 * /app/vpn.apk is the file (checked against its SHA-256; Android also checks it is signed with the same key).
 * With the VPN on, it goes through the tunnel.
 */
final class Updater {
    private static final long EVERY_MS = 6 * 3600_000L;
    private static volatile boolean busy;

    private Updater() {}

    private static HttpURLConnection open(String url) throws Exception {
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
        Profile p = Profile.chosen(a);
        String host = p == null ? null : p.updateHost();
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
                        .setMessage((notes.isEmpty() ? "Доступно обновление." : notes) + "\n\nРазмер: "
                                + Math.max(1, found.optLong("size", 0) / 1_000_000) + " МБ")
                        .setPositiveButton("Обновить", (d, w) -> download(a, base, found))
                        .setNegativeButton("Позже", null)
                        .show();
            });
        }, "update-check").start();
    }

    private static void download(Activity a, String base, JSONObject info) {
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
        File apk = new File(dir, "vpn.apk");
        new Thread(() -> {
            String err = null;
            try {
                HttpURLConnection c = open(base + "vpn.apk");
                if (c.getResponseCode() != 200) {
                    err = "не скачалось (" + c.getResponseCode() + ")";
                } else {
                    MessageDigest sha = MessageDigest.getInstance("SHA-256");
                    long got = 0;
                    try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
                        byte[] b = new byte[64 * 1024];
                        for (int n; (n = in.read(b)) > 0; ) {
                            out.write(b, 0, n);
                            sha.update(b, 0, n);
                            got += n;
                            int pct = (int) Math.min(100, got * 100 / size);
                            a.runOnUiThread(() -> bar.setProgress(pct));
                        }
                    }
                    StringBuilder hex = new StringBuilder();
                    for (byte x : sha.digest()) hex.append(String.format("%02x", x));
                    if (!hex.toString().equalsIgnoreCase(info.optString("sha256", ""))) err = "файл повреждён при загрузке";
                }
                c.disconnect();
            } catch (Exception e) {
                err = "нет связи с сервером";
            }
            String fail = err;
            a.runOnUiThread(() -> {
                dlg.dismiss();
                if (fail != null) {
                    Toast.makeText(a, "Обновление: " + fail + ". Попробуйте позже.", Toast.LENGTH_LONG).show();
                    return;
                }
                Uri uri = FileProvider.getUriForFile(a, a.getPackageName() + ".files", apk);
                a.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK));
            });
        }, "update-download").start();
    }
}
