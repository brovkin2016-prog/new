package app.aihelper.family;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceResponse;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * The app's screens are a web page. A copy ships inside the APK; newer ones come from the server (/app/version.json
 * lists the files) and are used from the next start, so the look and features change without a new APK.
 */
final class WebAssets {
    static final String ORIGIN_HOST = "appassets.androidplatform.net";  // reserved for in-app pages, never fetched
    private static final String TAG = "AIWeb";
    private static final Map<String, String> TYPES = new HashMap<>();

    static {
        TYPES.put("html", "text/html");
        TYPES.put("js", "text/javascript");
        TYPES.put("css", "text/css");
        TYPES.put("svg", "image/svg+xml");
        TYPES.put("json", "application/json");
        TYPES.put("webmanifest", "application/manifest+json");
        TYPES.put("png", "image/png");
        TYPES.put("woff2", "font/woff2");
    }

    private final Context ctx;
    private final SharedPreferences prefs;
    private volatile boolean fresh;  // newer screens were downloaded and wait for a reload

    WebAssets(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.prefs = ctx.getSharedPreferences("app", Context.MODE_PRIVATE);
        if (prefs.getInt("wwwApk", 0) != BuildConfig.VERSION_CODE) {  // a new APK brings its own, newer copy
            wipe(dir("www"));
            prefs.edit().putInt("wwwApk", BuildConfig.VERSION_CODE).remove("wwwVersion").apply();
        }
    }

    private File dir(String name) {
        return new File(ctx.getFilesDir(), name);
    }

    private static void wipe(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) wipe(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    WebResourceResponse serve(Uri url) {
        String path = url.getPath() == null ? "" : url.getPath().replaceFirst("^/+", "");
        if (path.isEmpty()) path = "index.html";
        if (path.contains("..")) return notFound();
        String ext = path.contains(".") ? path.substring(path.lastIndexOf('.') + 1) : "";
        String mime = TYPES.containsKey(ext) ? TYPES.get(ext) : "application/octet-stream";
        try {
            InputStream in;
            File f = new File(dir("www"), path);
            if (f.isFile()) in = new FileInputStream(f);
            else in = ctx.getAssets().open("www/" + path);
            WebResourceResponse r = new WebResourceResponse(mime, "utf-8", in);
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-cache");
            r.setResponseHeaders(h);
            return r;
        } catch (Exception e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(),
                new ByteArrayInputStream(new byte[0]));
    }

    private String current() {
        String v = prefs.getString("wwwVersion", null);
        if (v != null) return v;
        try (InputStream in = ctx.getAssets().open("www/version.json")) {
            byte[] b = new byte[in.available()];
            int n = in.read(b);
            return new JSONObject(new String(b, 0, Math.max(n, 0), StandardCharsets.UTF_8)).optString("v", "");
        } catch (Exception e) {
            return "";
        }
    }

    /** True once after newer screens arrived: the page may be reloaded to show them. */
    boolean takeFresh() {
        boolean f = fresh;
        fresh = false;
        return f;
    }

    /** Downloads the server's newer screens in the background; they are used from the next reload. */
    void refresh() {
        new Thread(() -> {
            try {
                byte[] raw = Net.get("/app/version.json", 20_000);
                if (raw == null) return;
                JSONObject js = new JSONObject(new String(raw, StandardCharsets.UTF_8));
                String v = js.optString("v", "");
                if (v.isEmpty() || v.equals(current())) return;
                JSONArray files = js.getJSONArray("files");
                File tmp = dir("www-new");
                wipe(tmp);
                for (int i = 0; i < files.length(); i++) {
                    String name = files.getString(i);
                    if (name.contains("..") || name.startsWith("/")) return;
                    byte[] data = Net.get("/app/" + name, 60_000);
                    if (data == null) return;
                    File f = new File(tmp, name);
                    //noinspection ResultOfMethodCallIgnored
                    f.getParentFile().mkdirs();
                    try (FileOutputStream out = new FileOutputStream(f)) {
                        out.write(data);
                    }
                }
                File www = dir("www");
                wipe(www);
                if (tmp.renameTo(www)) {
                    prefs.edit().putString("wwwVersion", v).apply();
                    fresh = true;
                    Log.i(TAG, "screens updated to " + v);
                }
            } catch (Exception e) {
                Log.w(TAG, "refresh: " + e);
            }
        }, "www-refresh").start();
    }
}
