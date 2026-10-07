package app.aihelper.family;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Bitmap;
import android.net.Uri;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * The owner's hosting account (HostVDS). The owner signs in once on the hosting's own page inside the app, like in a
 * browser (its checks, a code from the phone — all as usual); the app never sees or keeps the password, only the
 * session the site leaves in the cookies. With that session the app reads the balance from the site's own API, the
 * same one its control panel uses, and hands it to our server, which counts the days and reminds.
 */
final class Hosting {
    static final String SITE = "https://hostvds.com";

    private Hosting() {}

    interface Done {
        void done(boolean ok);
    }

    /** The hosting's sign-in page; done(true) once it has let the owner into the control panel. */
    static void login(Activity a, Done done) {
        Dialog d = new Dialog(a, android.R.style.Theme_DeviceDefault_NoActionBar);
        d.requestWindowFeature(Window.FEATURE_NO_TITLE);
        WebView w = new WebView(a);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
        boolean[] finished = {false};
        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return false;  // sign-in with Google, Yandex and the like stays in this window too
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap icon) {
                Uri u = Uri.parse(url);
                String path = u.getPath() == null ? "" : u.getPath();
                if (!finished[0] && "hostvds.com".equals(u.getHost()) && path.startsWith("/control")) {
                    finished[0] = true;
                    CookieManager.getInstance().flush();
                    d.dismiss();
                    done.done(true);
                }
            }
        });
        d.setOnCancelListener(x -> {
            if (!finished[0]) {
                finished[0] = true;
                done.done(false);
            }
        });
        d.setContentView(w, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        d.show();
        w.loadUrl(SITE + "/login");
    }

    /** Forgets the session: the next check asks to sign in again. */
    static void logout() {
        CookieManager cm = CookieManager.getInstance();
        String all = cm.getCookie(SITE);
        if (all != null) {
            for (String c : all.split(";")) {
                String name = c.split("=", 2)[0].trim();
                if (!name.isEmpty()) cm.setCookie(SITE, name + "=; Max-Age=0; Path=/");
            }
        }
        cm.flush();
    }

    /** {"ok":true,"balance":12.4,"currency":"EUR"} or {"ok":false,"why":"login"|"net"|...}. Blocking: call off the UI thread. */
    static String balance(String userAgent) {
        try {
            JSONObject c = customer(userAgent);
            if (c == null) {  // the short-lived pass may have run out: refresh it once with the long one
                refresh(userAgent);
                c = customer(userAgent);
            }
            if (c == null) return "{\"ok\":false,\"why\":\"login\"}";
            JSONObject out = new JSONObject().put("ok", true);
            if (!c.isNull("balance_eur") && c.has("balance_eur")) out.put("balance", c.getDouble("balance_eur")).put("currency", "EUR");
            else out.put("balance", c.optDouble("balance", 0)).put("currency", "USD");
            return out.toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"why\":\"net\"}";
        }
    }

    private static JSONObject customer(String ua) throws Exception {
        HttpURLConnection h = open("/api/customers/", ua);
        int code = h.getResponseCode();
        if (code != 200) {
            h.disconnect();
            return null;
        }
        JSONArray arr = new JSONArray(read(h));
        h.disconnect();
        return arr.length() > 0 ? arr.getJSONObject(0) : null;  // not signed in: the list is empty
    }

    private static void refresh(String ua) {
        try {
            HttpURLConnection h = open("/api/jwt-refresh/", ua);
            h.setRequestMethod("POST");
            h.setDoOutput(true);
            String csrf = cookie("csrftoken");
            if (csrf != null) h.setRequestProperty("X-CSRFToken", csrf);
            h.setRequestProperty("Content-Type", "application/json");
            try (OutputStream o = h.getOutputStream()) {
                o.write("{}".getBytes(StandardCharsets.UTF_8));
            }
            h.getResponseCode();
            keepCookies(h);
            h.disconnect();
        } catch (Exception ignored) {
            // then the owner signs in again
        }
    }

    private static HttpURLConnection open(String path, String ua) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(SITE + path).openConnection();
        h.setConnectTimeout(15_000);
        h.setReadTimeout(20_000);
        h.setInstanceFollowRedirects(false);
        String cookies = CookieManager.getInstance().getCookie(SITE);
        if (cookies != null) h.setRequestProperty("Cookie", cookies);
        h.setRequestProperty("Accept", "application/json");
        h.setRequestProperty("Referer", SITE + "/control/billing");
        if (ua != null) h.setRequestProperty("User-Agent", ua);
        return h;
    }

    private static void keepCookies(HttpURLConnection h) {
        Map<String, List<String>> head = h.getHeaderFields();
        CookieManager cm = CookieManager.getInstance();
        for (Map.Entry<String, List<String>> e : head.entrySet()) {
            if (e.getKey() != null && e.getKey().equalsIgnoreCase("Set-Cookie")) {
                for (String v : e.getValue()) cm.setCookie(SITE, v);
            }
        }
        cm.flush();
    }

    private static String cookie(String name) {
        String all = CookieManager.getInstance().getCookie(SITE);
        if (all == null) return null;
        for (String c : all.split(";")) {
            String[] kv = c.trim().split("=", 2);
            if (kv.length == 2 && kv[0].equals(name)) return kv[1];
        }
        return null;
    }

    private static String read(HttpURLConnection h) throws Exception {
        try (InputStream in = h.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] b = new byte[8192];
            for (int n; (n = in.read(b)) > 0; ) out.write(b, 0, n);
            return out.toString("UTF-8");
        }
    }
}
