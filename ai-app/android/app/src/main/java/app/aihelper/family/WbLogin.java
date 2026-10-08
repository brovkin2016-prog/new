package app.aihelper.family;

import android.app.Activity;
import android.app.Dialog;
import android.net.Uri;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The owner's WB Stream account, for the quick bridge: the owner signs in once on WB Stream's own page inside the app
 * (the phone number and the code from the SMS, as usual). The app takes only the access the page itself uses — the
 * «Authorization: Bearer …» of its own requests to stream.wb.ru — and hands it to the family server, which starts the
 * bridge with it. The number and the code are typed into WB's page; the app's own code never sees them.
 */
final class WbLogin {
    static final String SITE = "https://stream.wb.ru";
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9._~+/=-]{40,4096}");
    private static final Pattern JWT = Pattern.compile("eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}");

    private WbLogin() {}

    interface Done {
        void done(String token);  // null: not signed in
    }

    static void open(Activity a, Done done) {
        Dialog d = new Dialog(a, android.R.style.Theme_DeviceDefault_Light_NoActionBar);
        d.requestWindowFeature(Window.FEATURE_NO_TITLE);
        WebView w = new WebView(a);
        w.setBackgroundColor(0xFFFFFFFF);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, true);
        String[] got = {null};
        boolean[] finished = {false};
        TextView info = new TextView(a);
        info.setPadding(24, 10, 24, 10);
        info.setTextSize(13);
        info.setTextColor(0xFF374151);
        info.setBackgroundColor(0xFFFFF7E6);
        info.setText("Войдите в WB Stream своим номером телефона (код придёт по СМС). Это нужно один раз — потом мост WB работает сам.");
        Button ready = new Button(a), close = new Button(a);
        ready.setText("✅ Готово");
        ready.setAllCaps(false);
        close.setText("✕");
        Runnable finish = () -> {
            if (finished[0]) return;
            finished[0] = true;
            d.dismiss();
            done.done(got[0]);
        };
        boolean[] told = {false};
        w.setWebChromeClient(new android.webkit.WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                // the site is written for new browsers: an old built-in one cannot read it and shows a white page
                if (m.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR && m.message().contains("SyntaxError") && !told[0]) {
                    told[0] = true;
                    Log.w("AIWB", "page: " + m.message());
                    say(info, "Встроенный браузер телефона («Android System WebView») устарел — страница WB не рисуется. "
                            + "Обновите «Android System WebView» и Chrome в Google Play или RuStore и откройте вход снова.");
                }
                return true;
            }
        });
        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return false;  // WB's own sign-in steps stay in this window
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // the site draws itself with its scripts: if after a while there is nothing on it, say why
                view.postDelayed(() -> {
                    if (finished[0] || got[0] != null || told[0]) return;
                    view.evaluateJavascript("(function(){var b=document.body;return b?(b.innerText||'').trim().length+'|'"
                            + "+document.querySelectorAll('input,button,a').length:'0|0'})()", r -> {
                        String v = r == null ? "" : r.replace("\"", "");
                        Log.i("AIWB", "page content " + v);
                        if (v.isEmpty() || v.startsWith("0|0") || v.equals("null")) {
                            say(info, "Страница WB пустая — сайт не открылся. Если мобильный интернет работает по «белым "
                                    + "спискам», попробуйте через Wi‑Fi или обычный VPN, потом откройте вход снова.");
                        }
                    });
                }, 8000);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, android.webkit.WebResourceError err) {
                if (req.isForMainFrame()) say(info, "WB Stream не открылся: " + err.getDescription() + ". Попробуйте через Wi‑Fi или обычный VPN.");
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                // the page's own requests to its API carry the access it got after signing in
                Uri u = req.getUrl();
                if (got[0] == null && u != null && "stream.wb.ru".equals(u.getHost())) {
                    String t = bearer(req.getRequestHeaders());
                    if (t != null) {
                        got[0] = t;
                        Log.i("AIWB", "signed in (access " + t.length() + " chars)");
                        a.runOnUiThread(() -> info.setText("✅ Вход есть. Нажмите «Готово» — сервер поднимет мост WB."));
                    }
                }
                return null;
            }
        });
        // not seen in a request yet: the page may keep it in its storage
        ready.setOnClickListener(v -> {
            if (got[0] != null) {
                finish.run();
                return;
            }
            w.evaluateJavascript("(function(){var o={};try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);"
                    + "o[k]=localStorage.getItem(k)}}catch(e){}try{for(var j=0;j<sessionStorage.length;j++){var q=sessionStorage.key(j);"
                    + "o['s:'+q]=sessionStorage.getItem(q)}}catch(e){}return JSON.stringify(o)})()", r -> {
                String t = fromStorage(r);
                if (t != null) {
                    got[0] = t;
                    finish.run();
                } else {
                    Toast.makeText(a, "Вход ещё не закончен — войдите в WB Stream и нажмите «Готово»", Toast.LENGTH_LONG).show();
                }
            });
        });
        close.setOnClickListener(v -> finish.run());
        d.setOnKeyListener((dlg, key, ev) -> {
            if (key != KeyEvent.KEYCODE_BACK || ev.getAction() != KeyEvent.ACTION_UP) return key == KeyEvent.KEYCODE_BACK;
            if (w.canGoBack()) w.goBack();
            else finish.run();
            return true;
        });
        LinearLayout bar = new LinearLayout(a);
        bar.setPadding(12, 12, 12, 12);
        bar.addView(ready, new LinearLayout.LayoutParams(0, -2, 1f));
        bar.addView(close, new LinearLayout.LayoutParams(-2, -2));
        LinearLayout root = new LinearLayout(a);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xFFFFFFFF);
        root.addView(bar, new LinearLayout.LayoutParams(-1, -2));
        root.addView(info, new LinearLayout.LayoutParams(-1, -2));
        root.addView(w, new LinearLayout.LayoutParams(-1, 0, 1f));
        info.setVisibility(View.VISIBLE);
        d.setContentView(root, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (d.getWindow() != null) d.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        d.show();
        Log.i("AIWB", "login page opened");
        w.loadUrl(SITE + "/login");
    }

    private static void say(TextView info, String text) {
        Log.i("AIWB", "info: " + text);
        info.setText(text);
        info.setVisibility(View.VISIBLE);
    }

    /** «Bearer …» of a request, when it looks like an access token. */
    static String bearer(Map<String, String> headers) {
        if (headers == null) return null;
        for (Map.Entry<String, String> e : headers.entrySet()) {
            if (!"authorization".equalsIgnoreCase(e.getKey()) || e.getValue() == null) continue;
            String v = e.getValue().trim();
            if (!v.regionMatches(true, 0, "Bearer ", 0, 7)) continue;
            String t = v.substring(7).trim();
            if (TOKEN.matcher(t).matches()) return t;
        }
        return null;
    }

    /** A JWT kept by the page under a key that says «token» (the access one first), from its storage as JSON. */
    static String fromStorage(String json) {
        if (json == null) return null;
        try {
            String raw = new org.json.JSONTokener(json).nextValue().toString();  // the JS answer is a quoted string
            org.json.JSONObject o = new org.json.JSONObject(raw);
            String best = null;
            for (java.util.Iterator<String> it = o.keys(); it.hasNext(); ) {
                String k = it.next(), v = o.optString(k, "");
                if (!k.toLowerCase().contains("token")) continue;
                Matcher m = JWT.matcher(v);
                if (!m.find()) continue;
                if (best == null || k.toLowerCase().contains("access")) best = m.group();
            }
            return best;
        } catch (Exception e) {
            return null;
        }
    }
}
