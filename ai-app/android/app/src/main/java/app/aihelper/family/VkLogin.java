package app.aihelper.family;

import android.app.Activity;
import android.app.Dialog;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The owner's VK account, for the bridge over VK calls: the owner signs in once on VK's own page inside the app (the
 * phone number and the code, as usual). The app takes the page's own cookies of vk.ru — what the bridge program on the
 * family server needs to start a call from this account — and hands them to the family server only. The number and
 * the code are typed into VK's page; the app's own code never sees them.
 */
final class VkLogin {
    static final String SITE = "https://vk.ru/";
    // the cookies of these addresses together are the sign-in (as the bridge project's own app exports them)
    private static final String[] HOSTS = {"https://login.vk.ru", "https://vk.ru", "https://id.vk.ru", "https://api.vk.ru"};
    static final String SESSION = "remixsid";  // there only after signing in

    private VkLogin() {}

    interface Done {
        void done(String cookiesJson);  // null: not signed in
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
        boolean[] finished = {false}, told = {false}, looked = {false};
        TextView info = new TextView(a);
        info.setPadding(24, 10, 24, 10);
        info.setTextSize(13);
        info.setTextColor(0xFF374151);
        info.setBackgroundColor(0xFFFFF7E6);
        info.setText("Войдите в VK своим номером телефона (код придёт по СМС или в VK). Это нужно один раз — потом мост VK "
                + "работает сам. Вход хранится только на вашем сервере.");
        Button ready = new Button(a), close = new Button(a);
        ready.setText("✅ Готово");
        ready.setAllCaps(false);
        close.setText("✕");
        String[] got = {null};
        // the site draws itself with its scripts: if after a while there is nothing on it, say why — once, whether the
        // page finished loading or still hangs
        Runnable look = () -> {
            if (finished[0] || got[0] != null || told[0] || looked[0]) return;
            looked[0] = true;
            w.evaluateJavascript("(function(){var b=document.body;return b?(b.innerText||'').trim().length+'|'"
                    + "+document.querySelectorAll('input,button,a').length:'0|0'})()", r -> {
                String v = r == null ? "" : r.replace("\"", "");
                Log.i("AIVK", "page content " + v);
                if (v.isEmpty() || v.startsWith("0|0") || v.equals("null")) {
                    say(info, "Страница VK пустая — сайт не открылся. Если мобильный интернет работает по «белым "
                            + "спискам», попробуйте через Wi‑Fi или обычный VPN, потом откройте вход снова.");
                }
            });
        };
        Runnable finish = () -> {
            if (finished[0]) return;
            finished[0] = true;
            d.dismiss();
            done.done(got[0]);
        };
        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                String scheme = req.getUrl().getScheme();
                if ("https".equals(scheme) || "http".equals(scheme)) return false;  // VK's own sign-in steps stay in this window
                // «через приложение VK»: the sign-in would land in the VK app, not here
                told[0] = true;
                say(info, "Вход через приложение VK здесь не подходит. Закройте это предложение на странице VK (крестик) "
                        + "и войдите по номеру телефона.");
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (got[0] == null && signedIn()) {
                    Log.i("AIVK", "signed in");
                    info.setText("✅ Вход есть. Нажмите «Готово» — сервер поднимет мост VK.");
                    return;
                }
                view.postDelayed(look, 8000);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, android.webkit.WebResourceError err) {
                if (req.isForMainFrame()) {
                    told[0] = true;
                    say(info, "VK не открылся: " + err.getDescription() + ". Попробуйте через Wi‑Fi или обычный VPN.");
                }
            }
        });
        ready.setOnClickListener(v -> {
            String c = signedIn() ? cookies() : null;
            if (c == null) {
                Toast.makeText(a, "Вход ещё не закончен — войдите в VK и нажмите «Готово»", Toast.LENGTH_LONG).show();
                return;
            }
            got[0] = c;
            finish.run();
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
        Log.i("AIVK", "login page opened");
        w.loadUrl(SITE);
        w.postDelayed(look, 15000);  // a page that never finishes loading is looked at too
    }

    private static void say(TextView info, String text) {
        Log.i("AIVK", "info: " + text);
        info.setText(text);
        info.setVisibility(View.VISIBLE);
    }

    static boolean signedIn() {
        String c = CookieManager.getInstance().getCookie("https://vk.ru");
        return c != null && (c.startsWith(SESSION + "=") || c.contains("; " + SESSION + "="));
    }

    /** The sign-in's cookies of all VK addresses, once each by name, as [{"name", "value"}] — or null. */
    static String cookies() {
        Map<String, String> all = new LinkedHashMap<>();
        for (String h : HOSTS) all.putAll(merge(CookieManager.getInstance().getCookie(h), all));
        return asJson(all);
    }

    /** The cookies of one «name=value; …» line that are not taken yet. */
    static Map<String, String> merge(String line, Map<String, String> taken) {
        Map<String, String> out = new LinkedHashMap<>();
        if (line == null) return out;
        for (String part : line.split(";")) {
            int eq = part.indexOf('=');
            if (eq <= 0) continue;
            String name = part.substring(0, eq).trim(), value = part.substring(eq + 1).trim();
            if (!name.matches("[A-Za-z0-9_.-]{1,64}") || value.length() > 4096 || taken.containsKey(name) || out.containsKey(name)) continue;
            out.put(name, value);
        }
        return out;
    }

    static String asJson(Map<String, String> all) {
        if (!all.containsKey(SESSION)) return null;
        try {
            JSONArray a = new JSONArray();
            for (Map.Entry<String, String> e : all.entrySet()) a.put(new JSONObject().put("name", e.getKey()).put("value", e.getValue()));
            String s = a.toString();
            return s.length() <= 32_000 ? s : null;
        } catch (Exception e) {
            return null;
        }
    }
}
