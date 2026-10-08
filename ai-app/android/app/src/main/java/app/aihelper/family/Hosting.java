package app.aihelper.family;

import android.app.Activity;
import android.app.Dialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Message;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.Toast;

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
import java.util.regex.Matcher;
import java.util.regex.Pattern;

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

    /** The hosting's sign-in page; done(true) once the owner is in (the session works), done(false) if not. */
    static void login(Activity a, Done done) {
        Dialog d = new Dialog(a, android.R.style.Theme_DeviceDefault_NoActionBar);
        d.requestWindowFeature(Window.FEATURE_NO_TITLE);
        FrameLayout frame = new FrameLayout(a);
        WebView w = page(a);
        frame.addView(w, new FrameLayout.LayoutParams(-1, -1));
        boolean[] finished = {false};
        Runnable finish = () -> {
            if (finished[0]) return;
            finished[0] = true;
            CookieManager.getInstance().flush();
            d.dismiss();
            done.done(true);
        };
        String ua = w.getSettings().getUserAgentString();
        // not sure whether the owner got in (closed by «✕» or Back, or «Я вошёл»): the site's own API says
        java.util.function.Consumer<Boolean> check = (closing) -> new Thread(() -> {
            CookieManager.getInstance().flush();
            boolean ok = signedIn(ua);
            a.runOnUiThread(() -> {
                if (finished[0]) return;
                if (ok) finish.run();
                else if (closing) { finished[0] = true; d.dismiss(); done.done(false); }
                else Toast.makeText(a, "Вход ещё не закончен — завершите его на странице HostVDS", Toast.LENGTH_LONG).show();
            });
        }, "hosting-check").start();
        WebViewClient client = new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return false;  // sign-in with Google, Yandex and the like stays in this window too
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap icon) {
                if (inPanel(url)) finish.run();
            }

            @Override
            public void doUpdateVisitedHistory(WebView view, String url, boolean reload) {
                if (inPanel(url)) finish.run();  // the site is an app in the page: after signing in only the address changes
            }
        };
        w.setWebViewClient(client);
        // pop-up windows (sign-in with Google and the like) open over the page and close back to it
        w.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                if (m.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR) Log.w("AIHOST", "page: " + m.message());
                return true;
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, Message msg) {
                WebView pop = page(a);
                pop.setWebViewClient(client);
                pop.setWebChromeClient(new WebChromeClient() {
                    @Override
                    public void onCloseWindow(WebView window) {
                        frame.removeView(window);
                        window.destroy();
                    }
                });
                frame.addView(pop, new FrameLayout.LayoutParams(-1, -1));
                ((WebView.WebViewTransport) msg.obj).setWebView(pop);
                msg.sendToTarget();
                return true;
            }
        });
        // a bar on top: a sign-in link from HostVDS's e-mail opens in the phone's browser, so it can be pasted here
        LinearLayout bar = new LinearLayout(a);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setPadding(12, 12, 12, 12);
        Button paste = button(a, "📋 Ссылка из письма"), ready = button(a, "✅ Я вошёл"), close = button(a, "✕");
        paste.setOnClickListener(v -> {
            ClipboardManager cm = (ClipboardManager) a.getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = cm == null ? null : cm.getPrimaryClip();
            CharSequence t = clip != null && clip.getItemCount() > 0 ? clip.getItemAt(0).coerceToText(a) : null;
            Matcher m = MAIL_LINK.matcher(t == null ? "" : t);
            if (m.find()) w.loadUrl(m.group());
            else Toast.makeText(a, "Скопируйте ссылку для входа из письма HostVDS (долгое нажатие на кнопку в письме → «Копировать ссылку») и нажмите ещё раз",
                    Toast.LENGTH_LONG).show();
        });
        ready.setOnClickListener(v -> check.accept(false));
        close.setOnClickListener(v -> check.accept(true));
        d.setOnKeyListener((dlg, key, ev) -> {
            if (key != KeyEvent.KEYCODE_BACK || ev.getAction() != KeyEvent.ACTION_UP) return key == KeyEvent.KEYCODE_BACK;
            if (frame.getChildCount() > 1) {  // a pop-up on top: close it first
                View top = frame.getChildAt(frame.getChildCount() - 1);
                frame.removeView(top);
                ((WebView) top).destroy();
            } else if (w.canGoBack()) w.goBack();
            else check.accept(true);
            return true;
        });
        bar.addView(paste, new LinearLayout.LayoutParams(0, -2, 1.4f));
        bar.addView(ready, new LinearLayout.LayoutParams(0, -2, 1f));
        bar.addView(close, new LinearLayout.LayoutParams(-2, -2));
        LinearLayout root = new LinearLayout(a);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFFFFFFFF);
        root.addView(bar, new LinearLayout.LayoutParams(-1, -2));
        root.addView(frame, new LinearLayout.LayoutParams(-1, 0, 1f));
        d.setContentView(root, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (d.getWindow() != null) d.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        d.show();
        Log.i("AIHOST", "login page opened");
        w.loadUrl(SITE + "/login");
    }

    private static final Pattern MAIL_LINK = Pattern.compile("https://(?:www\\.)?hostvds\\.com/[^\\s\"'<>]+");

    private static boolean inPanel(String url) {
        Uri u = Uri.parse(url == null ? "" : url);
        String path = u.getPath() == null ? "" : u.getPath();
        return ("hostvds.com".equals(u.getHost()) || "www.hostvds.com".equals(u.getHost())) && path.startsWith("/control");
    }

    /** The page as in the phone's browser: Google and some others refuse sign-in in an app's web view («wv»). */
    private static WebView page(Activity a) {
        WebView w = new WebView(a);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setUserAgentString(s.getUserAgentString().replace("; wv", "").replaceAll(" Version/[0-9.]+", ""));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
        return w;
    }

    private static Button button(Activity a, String text) {
        Button b = new Button(a);
        b.setText(text);
        b.setAllCaps(false);
        return b;
    }

    /** Whether the session in the cookies lets us into the account. Blocking. */
    static boolean signedIn(String ua) {
        try {
            if (customer(ua) != null) return true;
            refresh(ua);
            return customer(ua) != null;
        } catch (Exception e) {
            return false;
        }
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
