package app.aihelper.vpn;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * VK's «I am not a robot» for the VK bridge, inside Winger: the bridge program's own page (127.0.0.1) in a window of
 * this app. No browser to pick, Winger stays in front (a phone saving its battery does not hold the bridge program
 * back meanwhile), and the window closes by itself once the bridge is in the call.
 */
public class CaptchaActivity extends Activity implements State.Listener {
    static final String URL = "url";
    static final String LOCAL = "http://127\\.0\\.0\\.1:[0-9]{2,5}/";
    private WebView web;
    private String url;
    private ProgressBar bar;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        url = getIntent().getStringExtra(URL);
        if (url == null || !url.matches(LOCAL)) {
            finish();
            return;
        }
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int text = dark ? 0xFFF3F4F6 : 0xFF111827, muted = dark ? 0xFF9CA3AF : 0xFF6B7280;
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.setPadding(dp(16), dp(14), dp(10), dp(8));
        LinearLayout words = new LinearLayout(this);
        words.setOrientation(LinearLayout.VERTICAL);
        TextView title = new TextView(this);
        title.setText("Мост VK: вы не робот?");
        title.setTextColor(text);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        TextView hint = new TextView(this);
        hint.setText("Отметьте галочку ниже (если VK покажет задание — выполните его). Мост подключится сам, окно закроется.");
        hint.setTextColor(muted);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        TextView browser = new TextView(this);  // a phone whose built-in web view is too old for VK's page
        browser.setText("Пусто или не грузится? Открыть в браузере");
        browser.setTextColor(0xFF6366F1);
        browser.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        browser.setPadding(0, dp(6), 0, dp(2));
        browser.setOnClickListener(v -> {
            Diag.i(this, "bridge: VK's check opened in the browser instead");
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (RuntimeException e) {
                Toast.makeText(this, "Нет браузера на телефоне", Toast.LENGTH_SHORT).show();
            }
        });
        words.addView(title);
        words.addView(hint);
        words.addView(browser);
        head.addView(words, new LinearLayout.LayoutParams(0, -2, 1));
        TextView close = new TextView(this);
        close.setText("Закрыть");
        close.setTextColor(0xFF6366F1);
        close.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        close.setPadding(dp(12), dp(10), dp(8), dp(10));
        close.setOnClickListener(v -> finish());
        head.addView(close);
        root.addView(head);
        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        root.addView(bar, new LinearLayout.LayoutParams(-1, dp(3)));

        web = new WebView(this);
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);  // the emulator test looks inside
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setSupportMultipleWindows(false);  // a page that opens a new window stays in this one
        CookieManager.getInstance().setAcceptCookie(true);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                return !"http".equals(u.getScheme()) && !"https".equals(u.getScheme());  // vk:// and the like: not here
            }

            private boolean said;  // the page finishes its loads many times over: told once

            @Override
            public void onPageFinished(WebView v, String u) {
                if (said) return;
                said = true;
                Diag.i(CaptchaActivity.this, "bridge: VK's check page shown in Winger");
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) Diag.i(CaptchaActivity.this, "bridge: VK's check page did not load: " + err.getDescription());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            private int told;

            @Override
            public void onProgressChanged(WebView v, int p) {
                bar.setProgress(p);
                bar.setVisibility(p < 100 ? View.VISIBLE : View.INVISIBLE);
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {  // why a page stays blank: its errors, the first few
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR && told++ < 8) {
                    String s = m.message();
                    Diag.i(CaptchaActivity.this, "bridge: VK's check page: " + (s.length() > 200 ? s.substring(0, 200) : s));
                }
                return false;
            }
        });
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            android.content.pm.PackageInfo wv = WebView.getCurrentWebViewPackage();
            if (wv != null) Diag.i(this, "bridge: VK's check in Winger, web view " + wv.versionName);
        }
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xFFFFFFFF);  // VK's page is light
        web.setBackground(bg);
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);
        web.loadUrl(url);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String u = intent.getStringExtra(URL);
        if (web != null && u != null && u.matches(LOCAL) && !u.equals(url)) {
            url = u;
            web.loadUrl(u);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web == null) return;
        State.listen(this);
        if (State.captcha.isEmpty()) {  // an old notice: the check is no longer asked for
            Toast.makeText(this, "Проверка VK уже не нужна", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }
        changed();
    }

    @Override
    protected void onPause() {
        State.unlisten(this);
        super.onPause();
    }

    @Override
    public void changed() {
        String now = State.captcha;
        if (now.isEmpty()) {  // the bridge is in the call (or it was switched off): nothing to confirm any more
            if (State.phase != State.Phase.OFF) Toast.makeText(this, "✅ Проверка пройдена — мост подключается", Toast.LENGTH_SHORT).show();
            finish();
        } else if (!now.equals(url)) {  // a new try of the bridge asks again: its new page
            url = now;
            web.loadUrl(now);
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.stopLoading();
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
