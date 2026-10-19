package app.aihelper.vpn;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;

/**
 * «🛟 Спасение сервера»: the family server's rescue console (https://DOMAIN:9443, the owner only), opened in the browser
 * already signed in — for days when the AI app, its «Управление» or the chat with Claude there broke. The server gives a
 * one-time link (3 minutes) for the owner's own VPN login; asked past the VPN first (it may be what is broken), then
 * through it. Nothing is kept here.
 */
final class Rescue {
    private Rescue() {}

    static boolean shown(Context c) {
        return c.getSharedPreferences("vpn", Context.MODE_PRIVATE).getBoolean("owner", false);
    }

    static void open(Activity a) {
        Context c = a.getApplicationContext();
        String host = Profile.homeHost(c), login = BridgeSync.ownLogin(c, host);
        if (host == null || login == null) {
            Toast.makeText(a, "В Winger нет подключения к семейному серверу", Toast.LENGTH_LONG).show();
            return;
        }
        Toast.makeText(a, "Открываю спасательную консоль…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            String url = null, why = "Сервер не ответил";
            for (boolean direct : new boolean[] {true, false}) {
                try {
                    HttpURLConnection h = Updater.open("https://" + host + ":9443/api/ticket", direct);
                    h.setConnectTimeout(10_000);
                    h.setReadTimeout(20_000);
                    h.setRequestMethod("POST");
                    h.setDoOutput(true);
                    h.setRequestProperty("Content-Type", "application/json");
                    h.setRequestProperty("X-Rescue", "1");
                    try (OutputStream o = h.getOutputStream()) {
                        o.write(new JSONObject().put("auth", login).toString().getBytes(StandardCharsets.UTF_8));
                    }
                    int code = h.getResponseCode();
                    if (code == 200) url = new JSONObject(BridgeSync.read(h.getInputStream())).optString("url");
                    h.disconnect();
                    if (code == 200) break;
                    why = code == 401 ? "Спасательная консоль — только для владельца сервера"
                            : code == 429 ? "Слишком много попыток входа — попробуйте через 10 минут" : "Консоль ответила " + code;
                    if (code == 401 || code == 429) break;
                } catch (Exception e) {
                    why = "Спасательная консоль не отвечает (порт 9443): " + e.getClass().getSimpleName()
                            + ". Если сервер перезагружается — через пару минут ещё раз.";
                }
            }
            Diag.i(c, "rescue console: " + (url != null && url.startsWith("https://") ? "opened" : why));  // never the link
            String go = url, told = why;
            a.runOnUiThread(() -> {
                if (go == null || !go.startsWith("https://")) {
                    Toast.makeText(a, told, Toast.LENGTH_LONG).show();
                    return;
                }
                try {
                    a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(go)));
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(a, "Нет браузера, чтобы открыть консоль", Toast.LENGTH_LONG).show();
                }
            });
        }, "rescue").start();
    }
}
