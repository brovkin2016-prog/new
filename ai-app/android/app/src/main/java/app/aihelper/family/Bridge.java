package app.aihelper.family;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.regex.Pattern;

/** What the page can ask of the phone: window.AIBridge. Answers come back through window.__aiNet. */
final class Bridge {
    private static final Pattern HOST = Pattern.compile("^[a-z0-9-]+(\\.[a-z0-9-]+)+(:\\d{1,5})?$");
    private final MainActivity act;
    private final WebView web;
    private final SharedPreferences prefs;

    Bridge(MainActivity act, WebView web) {
        this.act = act;
        this.web = web;
        this.prefs = act.getSharedPreferences("app", Context.MODE_PRIVATE);
    }

    private void js(String id, String type, String arg) {
        String code = "window.__aiNet&&window.__aiNet(" + JSONObject.quote(id) + "," + JSONObject.quote(type) + ","
                + JSONObject.quote(arg) + ")";
        web.post(() -> web.evaluateJavascript(code, null));
    }

    @JavascriptInterface
    public void request(String id, String path, String headersJson, String body) {
        if (path == null || !path.startsWith("/")) {
            js(id, "fail", "bad path");
            return;
        }
        Map<String, String> headers = new HashMap<>();
        try {
            JSONObject h = new JSONObject(headersJson == null ? "{}" : headersJson);
            for (Iterator<String> it = h.keys(); it.hasNext(); ) {
                String k = it.next();
                headers.put(k, h.getString(k));
            }
        } catch (Exception ignored) {
            // no headers then
        }
        byte[] data = body == null || body.isEmpty() ? null : body.getBytes(StandardCharsets.UTF_8);
        Net.start(data == null ? "GET" : "POST", path, headers, data, new Net.Sink() {
            public void head(int status) { js(id, "head", String.valueOf(status)); }
            public void data(byte[] chunk) { js(id, "data", Base64.encodeToString(chunk, Base64.NO_WRAP)); }
            public void end() { js(id, "end", ""); }
            public void fail(String why) { js(id, "fail", why); }
        });
    }

    @JavascriptInterface
    public void setHost(String host) {
        String h = host == null ? "" : host.trim().toLowerCase();
        if (!HOST.matcher(h).matches()) return;
        prefs.edit().putString("host", h).apply();
        Net.setHost(act, h);
    }

    @JavascriptInterface
    public String getHost() {
        return prefs.getString("host", "");
    }

    @JavascriptInterface
    public String device() {
        return (Build.MANUFACTURER + " " + Build.MODEL).trim();
    }

    @JavascriptInterface
    public String version() {
        return BuildConfig.VERSION_NAME + " (" + BuildConfig.VERSION_CODE + ")";
    }

    @JavascriptInterface
    public String netInfo() {
        return Net.lastProto + (Net.lastVpn ? " vpn" : "");
    }

    @JavascriptInterface
    public void checkUpdate(boolean manual) {
        act.runOnUiThread(() -> Updater.check(act, manual));
    }

    @JavascriptInterface
    public void saveFile(String name, String mime, String b64) {
        byte[] data = Base64.decode(b64, Base64.DEFAULT);
        act.runOnUiThread(() -> Files.save(act, name, mime, data));
    }

    @JavascriptInterface
    public void shareFile(String name, String mime, String b64, String text) {
        byte[] data = Base64.decode(b64, Base64.DEFAULT);
        act.runOnUiThread(() -> Files.share(act, name, mime, data, text));
    }

    @JavascriptInterface
    public void shareApp(String text) {
        Files.shareApp(act, text);  // copies the installed APK here, off the main thread, then opens the share sheet
    }

    @JavascriptInterface
    public void copy(String text) {
        act.runOnUiThread(() -> {
            ClipboardManager cm = (ClipboardManager) act.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("text", text));
        });
    }

    @JavascriptInterface
    public String clipboard() {
        ClipboardManager cm = (ClipboardManager) act.getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null || !cm.hasPrimaryClip() || cm.getPrimaryClip() == null || cm.getPrimaryClip().getItemCount() == 0) return "";
        CharSequence t = cm.getPrimaryClip().getItemAt(0).coerceToText(act);
        return t == null ? "" : t.toString();
    }

    @JavascriptInterface
    public void unlock(String title) {
        act.runOnUiThread(() -> act.unlock(title == null ? "" : title));
    }

    @JavascriptInterface
    public void toast(String text) {
        act.runOnUiThread(() -> Toast.makeText(act, text, Toast.LENGTH_SHORT).show());
    }
}
