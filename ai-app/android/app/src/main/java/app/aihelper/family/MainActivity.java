package app.aihelper.family;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;

/** One screen: the assistant's web page, with the phone's camera, microphone, files and network behind it. */
public class MainActivity extends Activity {
    private static final int REQ_CAMERA = 1, REQ_FILE = 2, REQ_MIC = 3, REQ_UNLOCK = 4;
    private static final String START = "https://" + WebAssets.ORIGIN_HOST + "/index.html";
    private WebView web;
    private WebAssets assets;
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;
    private PermissionRequest micRequest;
    private boolean tested;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        String host = getSharedPreferences("app", MODE_PRIVATE).getString("host", "");
        if (!host.isEmpty()) Net.setHost(this, host);
        assets = new WebAssets(this);
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " AIApp/" + BuildConfig.VERSION_NAME);
        web.addJavascriptInterface(new Bridge(this, web), "AIBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                return WebAssets.ORIGIN_HOST.equals(u.getHost()) ? assets.serve(u) : null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (WebAssets.ORIGIN_HOST.equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (ActivityNotFoundException ignored) {
                    // nothing can open it
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!BuildConfig.TEST_LOGIN.isEmpty() && !tested) {
                    tested = true;
                    selfTest();
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest r) {
                runOnUiThread(() -> {
                    boolean mic = false;
                    for (String res : r.getResources()) mic |= PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res);
                    if (!mic) {
                        r.deny();
                    } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        r.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        micRequest = r;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                boolean imagesOnly = true;
                for (String t : params.getAcceptTypes()) imagesOnly &= t != null && t.startsWith("image");
                try {
                    if (params.isCaptureEnabled() && imagesOnly) {
                        File dir = new File(getCacheDir(), "camera");
                        //noinspection ResultOfMethodCallIgnored
                        dir.mkdirs();
                        File f = new File(dir, "photo-" + System.currentTimeMillis() + ".jpg");
                        cameraUri = FileProvider.getUriForFile(MainActivity.this, Files.authority(MainActivity.this), f);
                        Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, cameraUri)
                                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivityForResult(i, REQ_CAMERA);
                    } else {
                        Intent i = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE)
                                .setType(imagesOnly ? "image/*" : "*/*");
                        startActivityForResult(Intent.createChooser(i, "Выберите файл"), REQ_FILE);
                    }
                } catch (Exception e) {
                    fileCallback = null;
                    cb.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "Не открылось: " + e.getMessage(), Toast.LENGTH_LONG).show();
                }
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                if (BuildConfig.DEBUG || m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    Log.i(m.message().startsWith("AITEST") ? "AITEST" : "AIWebConsole", m.message() + " @" + m.lineNumber());
                }
                return true;
            }
        });
        if (saved != null) web.restoreState(saved);
        else web.loadUrl(START);
        assets.refresh();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        if (assets.takeFresh()) web.reload();
        Updater.check(this, false);
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // the page closes its own panels first; on the main chat the app goes to the background, keeping its state
        web.evaluateJavascript("window.__aiBack ? window.__aiBack() : false", v -> {
            if (!"true".equals(v)) moveTaskToBack(true);
        });
    }

    /** The phone's own lock (fingerprint, face, PIN) before a private part of the page; the page hears ok, no or none. */
    @SuppressWarnings("deprecation")
    void unlock(String title) {
        KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        Intent i = km == null || !km.isDeviceSecure() ? null
                : km.createConfirmDeviceCredentialIntent(title, "Подтвердите, что это вы");
        if (i == null) {
            unlocked("none");  // the phone has no screen lock: nothing to ask
            return;
        }
        try {
            startActivityForResult(i, REQ_UNLOCK);
        } catch (ActivityNotFoundException e) {
            unlocked("none");
        }
    }

    private void unlocked(String how) {
        web.evaluateJavascript("window.__aiUnlock&&window.__aiUnlock(" + JSONObject.quote(how) + ")", null);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_UNLOCK) {
            unlocked(res == RESULT_OK ? "ok" : "no");
            return;
        }
        if (fileCallback == null) return;
        Uri[] out = null;
        if (res == RESULT_OK) {
            if (req == REQ_CAMERA && cameraUri != null) out = new Uri[]{cameraUri};
            else if (req == REQ_FILE && data != null && data.getData() != null) out = new Uri[]{data.getData()};
        }
        fileCallback.onReceiveValue(out);
        fileCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        if (req == REQ_MIC && micRequest != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
                micRequest.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            } else {
                micRequest.deny();
                Toast.makeText(this, "Без доступа к микрофону голос не работает", Toast.LENGTH_LONG).show();
            }
            micRequest = null;
        }
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    /** Debug builds for the emulator test only: sign in, ask a question, report what came back. */
    private void selfTest() {
        Handler h = new Handler(Looper.getMainLooper());
        String login = JSONObject.quote(BuildConfig.TEST_LOGIN);
        h.postDelayed(() -> web.evaluateJavascript(
                "(function(){var i=document.querySelector('.login input'); if(!i){console.log('AITEST no login screen');return;}"
                        + "i.value=" + login + "; [...document.querySelectorAll('button')].find(b=>b.textContent==='Войти').click();"
                        + "console.log('AITEST login sent');})()", null), 1500);
        h.postDelayed(() -> web.evaluateJavascript(
                "(function(){var t=document.querySelector('.composer textarea'); if(!t){console.log('AITEST no chat: '"
                        + "+document.body.innerText.slice(0,200));return;} t.value='Привет из теста'; t.dispatchEvent(new Event('input'));"
                        + "document.querySelector('.composer .round.main').click(); console.log('AITEST question sent');})()", null), 30000);
        h.postDelayed(() -> web.evaluateJavascript(
                "(function(){var a=[...document.querySelectorAll('.msg.ai .bubble')].pop();"
                        + "console.log('AITEST answer: '+(a?a.innerText.slice(0,120):'none'));})()", null), 48000);
    }
}
