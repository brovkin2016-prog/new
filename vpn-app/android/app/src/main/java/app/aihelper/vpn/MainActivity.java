package app.aihelper.vpn;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.content.res.ColorStateList;
import android.net.VpnService;
import android.os.Build;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** One screen: the big button and how the connection is; the connections in one list (a tap: on through it); the settings
 *  below (which apps, adding a connection, the update, the journal). The first time: adding a connection from a QR code or
 *  a link is the one thing to do. */
public class MainActivity extends Activity implements State.Listener {
    private static final int REQ_VPN = 1, REQ_IMAGE = 2, REQ_NOTIFY = 3;
    private boolean dark;
    private int text, muted, card, accent;
    private PowerButton power;
    private AuroraView aurora;
    private AvatarView avatar;
    private TextView status, detail, ping, appsName, bridgeAppsName, hint, connsHead, checkVal;
    private LinearLayout conns, appsCard, bridgeAppsCard, addRow, firstAdd, rescueRow, checkRow;
    private boolean checkAsked;  // the button here started the check: its result is shown here when it is done
    private String connsKey = "";
    private String captchaShown = "";  // the check page last opened by itself (closed by hand: not again)
    private final List<LinearLayout> connRows = new ArrayList<>();
    private final List<TextView> connNotes = new ArrayList<>();
    private final List<TextView> connChips = new ArrayList<>();
    private final List<View> connDots = new ArrayList<>();
    private int line;  // the thin lines between a list's rows

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        text = dark ? 0xFFF3F4F6 : 0xFF111827;
        muted = dark ? 0xFF9CA3AF : 0xFF6B7280;
        card = dark ? 0xE01A2029 : 0xEBFFFFFF;  // cards let the aurora shine through a little
        accent = dark ? 0xFF34D399 : 0xFF0E9F6E;
        line = dark ? 0x22FFFFFF : 0x14000000;
        boolean packaged = packagedProfile();
        build();
        if (packaged) Toast.makeText(this, "Подключение уже внутри — нажмите большую кнопку", Toast.LENGTH_LONG).show();
        offerTile();
        // a link that opened the app counts once: not again when Android recreates the screen or reopens it from Recents
        if (saved == null && (getIntent().getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0) handle(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handle(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        State.listen(this);
        changed();
        avatar.refresh(Profile.chosen(this));
        Updater.check(this, false);
        BridgeSync.run(this, false);  // the owner's bridge, kept ready (nobody else gets one)
        Speed.pingAll(this, () -> runOnUiThread(this::changed));  // every server's response time
        Diag.upload(this, false);  // the journal to the family server (it keeps the owner's only)
        if (Rescue.shown(this)) new Thread(() -> BridgeCheck.sendPending(this), "check-send").start();  // a report made offline
    }

    @Override
    protected void onPause() {
        State.unlisten(this);
        super.onPause();
    }

    // ---------- the screen ----------

    private void build() {
        FrameLayout frame = new FrameLayout(this);
        aurora = new AuroraView(this, dark);
        frame.addView(aurora, new FrameLayout.LayoutParams(-1, -1));
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(22), dp(18), dp(20));
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        // on a short screen everything still fits: it scrolls; on a tall one the spacers share the room
        ScrollView scroller = new ScrollView(this);
        scroller.setFillViewport(true);
        scroller.setVerticalScrollBarEnabled(false);
        scroller.addView(root, new FrameLayout.LayoutParams(-1, -1));
        frame.addView(scroller, new FrameLayout.LayoutParams(-1, -1));

        // the name: the owner's living portrait (or the shield), «Winger» in the aurora's colours, whose VPN it is
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        avatar = new AvatarView(this);
        head.addView(avatar, new LinearLayout.LayoutParams(dp(54), dp(54)));
        LinearLayout names = new LinearLayout(this);
        names.setOrientation(LinearLayout.VERTICAL);
        names.setPadding(dp(10), 0, 0, 0);
        TextView title = label(getString(R.string.brand), 24, text, true);
        title.setGravity(Gravity.START);
        title.getPaint().setShader(new android.graphics.LinearGradient(0, 0, dp(110), 0,
                new int[]{0xFF22D3EE, 0xFF6366F1, 0xFFA855F7}, null, android.graphics.Shader.TileMode.CLAMP));
        title.setLetterSpacing(0.02f);
        names.addView(title, new LinearLayout.LayoutParams(-2, -2));
        TextView sub = label(getString(R.string.full_name), 13, muted, false);
        sub.setGravity(Gravity.START);
        names.addView(sub, new LinearLayout.LayoutParams(-2, -2));
        head.addView(names, new LinearLayout.LayoutParams(0, -2, 1f));
        root.addView(head, new LinearLayout.LayoutParams(-1, -2));

        root.addView(new View(this), new LinearLayout.LayoutParams(1, 0, 1f));
        power = new PowerButton(this, dark);
        power.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            toggle();
        });
        int big = getResources().getConfiguration().screenHeightDp < 720 ? 164 : 200;  // a smaller button on a short screen
        root.addView(power, new LinearLayout.LayoutParams(dp(big), dp(big)));

        status = label("", 24, text, true);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
        lp.topMargin = dp(14);
        root.addView(status, lp);
        detail = label("", 14, muted, false);
        detail.setGravity(Gravity.CENTER);
        lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = dp(4);
        root.addView(detail, lp);

        // the response time, a small chip (a tap: checked again)
        ping = label("", 13, text, true);
        ping.setPadding(dp(12), dp(5), dp(12), dp(5));
        ping.setOnClickListener(v -> {
            if (State.phase == State.Phase.ON) {
                ping.setText("Проверяю отклик…");
                startService(new Intent(this, VpnSvc.class).setAction(VpnSvc.PING));
            }
        });
        lp = new LinearLayout.LayoutParams(-2, -2);
        lp.topMargin = dp(8);
        root.addView(ping, lp);
        root.addView(new View(this), new LinearLayout.LayoutParams(1, 0, 1f));

        // the first time: adding a connection is the one thing to do — two big buttons
        firstAdd = new LinearLayout(this);
        firstAdd.setOrientation(LinearLayout.VERTICAL);
        firstAdd.setGravity(Gravity.CENTER_HORIZONTAL);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        TextView scan = button("📷  Сканировать QR", true);
        scan.setOnClickListener(v -> scan());
        TextView paste = button("📋  Вставить ссылку", false);
        paste.setOnClickListener(v -> paste());
        LinearLayout.LayoutParams half = new LinearLayout.LayoutParams(0, dp(54), 1f);
        half.rightMargin = dp(6);
        row.addView(scan, half);
        half = new LinearLayout.LayoutParams(0, dp(54), 1f);
        half.leftMargin = dp(6);
        row.addView(paste, half);
        firstAdd.addView(row, new LinearLayout.LayoutParams(-1, -2));
        TextView fromImage = label("🖼  QR-код из картинки или скриншота", 15, muted, false);
        fromImage.setPadding(dp(12), dp(14), dp(12), dp(4));
        fromImage.setOnClickListener(v -> pickImage());
        firstAdd.addView(fromImage, new LinearLayout.LayoutParams(-2, -2));
        root.addView(firstAdd, new LinearLayout.LayoutParams(-1, -2));

        // the connections, one list: a tap switches on through that one, a tap on the one that is on switches it off
        connsHead = section("Подключение");
        root.addView(connsHead, sectionParams());
        conns = list();
        root.addView(conns, new LinearLayout.LayoutParams(-1, -2));
        hint = label("", 13, muted, false);
        hint.setGravity(Gravity.START);
        hint.setPadding(dp(8), dp(6), dp(8), 0);
        root.addView(hint, new LinearLayout.LayoutParams(-1, -2));

        // the settings: which apps go through it, adding a connection, the update, the journal (and the owner's rescue)
        root.addView(section("Настройки"), sectionParams());
        LinearLayout settings = list();
        // a list of its own for the server and for a bridge: the two are for different things
        appsName = label("", 13, muted, false);
        appsName.setSingleLine(true);
        appsName.setEllipsize(android.text.TextUtils.TruncateAt.END);
        appsName.setMaxWidth(dp(120));  // «Через сервер» stays on one line on a narrow phone
        appsCard = setting("🧩", "Через сервер", appsName, v -> chooseApps(false));
        addTo(settings, appsCard);
        bridgeAppsName = label("", 13, muted, false);
        bridgeAppsName.setSingleLine(true);
        bridgeAppsName.setEllipsize(android.text.TextUtils.TruncateAt.END);
        bridgeAppsName.setMaxWidth(dp(120));  // «Через сервер» stays on one line on a narrow phone
        bridgeAppsCard = setting("🌉", "Через мост", bridgeAppsName, v -> chooseApps(true));
        addTo(settings, bridgeAppsCard);
        // (v32) a bridge that carries here now, by itself, when the connection in use stops carrying
        TextView autoName = label(Apps.autoBridge(this) ? "вкл." : "выкл.", 13, muted, false);
        addTo(settings, setting("🔀", "Сам переходить на рабочий мост", autoName, v -> {
            boolean on = !Apps.autoBridge(this);
            Apps.setAutoBridge(this, on);
            autoName.setText(on ? "вкл." : "выкл.");
            Toast.makeText(this, on ? "Если подключение перестанет работать, Winger сам перейдёт на мост, который работает в этой сети"
                    : "Winger останется на выбранном подключении; на мост — кнопкой «Через мост»", Toast.LENGTH_LONG).show();
        }));
        addRow = setting("➕", "Добавить подключение", null, v -> addMenu());
        addTo(settings, addRow);
        // which Winger this is, and a check right now (otherwise it looks for a new version every few hours by itself)
        addTo(settings, setting("🔄", "Проверить обновление", label("Winger " + BuildConfig.VERSION_NAME, 13, muted, false), v -> {
            Toast.makeText(this, "Проверяю обновление…", Toast.LENGTH_SHORT).show();
            Updater.check(this, true);
            BridgeSync.run(this, true);
            Diag.upload(this, true);
        }));
        // when the family server is out of reach the journal cannot go to it: copied here, it goes into a chat
        addTo(settings, setting("📋", "Скопировать журнал и проверку связи", null, v -> copyJournal()));
        // the owner's only: the bridges checked from this phone, on its own network (the family server's Claude reads the report)
        checkVal = label("", 13, muted, false);
        checkRow = setting("🔬", "Проверить мосты с этого телефона", checkVal, v -> startCheck("", true));
        addTo(settings, checkRow);
        // the owner's only: the family server's rescue console in the browser (shown once the server says it is the owner)
        rescueRow = setting("🆘", "Спасение сервера: консоль в браузере", null, v -> Rescue.open(this));
        addTo(settings, rescueRow);
        root.addView(settings, new LinearLayout.LayoutParams(-1, -2));
        setContentView(frame);
        // the screen comes in softly: each part rises into place, one after another
        for (int i = 0; i < root.getChildCount(); i++) {
            View v = root.getChildAt(i);
            v.setAlpha(0f);
            v.setTranslationY(dp(18));
            v.animate().alpha(1f).translationY(0).setStartDelay(80L + i * 40L).setDuration(400)
                    .setInterpolator(new android.view.animation.DecelerateInterpolator()).start();
        }
    }

    /** A small grey heading over a list («ПОДКЛЮЧЕНИЕ», «НАСТРОЙКИ»). */
    private TextView section(String name) {
        TextView h = label(name.toUpperCase(Locale.ROOT), 12, muted, true);
        h.setGravity(Gravity.START);
        h.setLetterSpacing(0.06f);
        h.setPadding(dp(8), 0, dp(8), 0);
        return h;
    }

    private LinearLayout.LayoutParams sectionParams() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = dp(18);
        lp.bottomMargin = dp(6);
        return lp;
    }

    /** One rounded card for a list's rows (a press's ripple stays inside its corners). */
    private LinearLayout list() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setBackground(round(card, 18, 0));
        l.setClipToOutline(true);
        return l;
    }

    /** A row into a list, a thin line above it when it is not the first. */
    private void addTo(LinearLayout list, View row) {
        if (list.getChildCount() > 0) {
            View sep = new View(this);
            sep.setBackgroundColor(line);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, Math.max(1, dp(1) / 2));
            lp.leftMargin = dp(16);
            list.addView(sep, lp);
        }
        list.addView(row, new LinearLayout.LayoutParams(-1, -2));
    }

    /** A settings row: its sign, its name, what it is now (grey, on the right), and ›. */
    private LinearLayout setting(String icon, String name, TextView value, View.OnClickListener click) {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setPadding(dp(14), dp(13), dp(12), dp(13));
        r.setMinimumHeight(dp(52));
        r.setBackground(press(round(0x00000000, 0, 0), 0));
        r.addView(label(icon, 18, text, false), new LinearLayout.LayoutParams(dp(30), -2));
        TextView n = label(name, 15, text, false);
        n.setGravity(Gravity.START);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, -2, 1f);
        lp.leftMargin = dp(6);
        r.addView(n, lp);
        if (value != null) {
            lp = new LinearLayout.LayoutParams(-2, -2);
            lp.leftMargin = dp(8);
            r.addView(value, lp);
        }
        lp = new LinearLayout.LayoutParams(-2, -2);
        lp.leftMargin = dp(8);
        r.addView(label("›", 20, muted, false), lp);
        r.setOnClickListener(click);
        return r;
    }

    /** «Добавить подключение»: from a QR code, a link, or a QR code in a picture. */
    private void addMenu() {
        String[] ways = {"📷  Сканировать QR-код", "📋  Вставить ссылку", "🖼  QR-код из картинки или скриншота"};
        new AlertDialog.Builder(this)
                .setTitle("Добавить подключение")
                .setItems(ways, (d, w) -> {
                    if (w == 0) scan();
                    else if (w == 1) paste();
                    else pickImage();
                })
                .setNegativeButton("Отмена", null)
                .show();
    }

    @Override
    public void changed() {
        String check = State.captcha;  // VK asks the bridge for a person: its check opens at once while Winger is in front
        if (!check.isEmpty() && !check.equals(captchaShown)) {
            captchaShown = check;
            startActivity(new Intent(this, CaptchaActivity.class).putExtra(CaptchaActivity.URL, check));
        }
        Profile p = Profile.chosen(this);
        List<Profile> all = Profile.all(this);
        boolean has = p != null;
        power.show(State.phase, has);
        aurora.show(State.phase);
        conns.setVisibility(has ? View.VISIBLE : View.GONE);
        connsHead.setVisibility(has ? View.VISIBLE : View.GONE);
        hint.setVisibility(has ? View.VISIBLE : View.GONE);
        firstAdd.setVisibility(has ? View.GONE : View.VISIBLE);
        setRow(appsCard, has);
        boolean bridges = false;
        if (has) for (Profile x : Profile.all(this)) bridges |= x.bridge;
        setRow(bridgeAppsCard, bridges);
        setRow(addRow, has);
        setRow(rescueRow, Rescue.shown(this));
        setRow(checkRow, Rescue.shown(this));
        checkVal.setText(BridgeCheck.running.get() ? "идёт…" : "");
        if (checkAsked && BridgeCheck.fresh && !BridgeCheck.running.get()) {
            checkAsked = false;
            showCheck();
        }
        if (has) {
            showConns(all);
            appsName.setText(Apps.summary(this, false));
            bridgeAppsName.setText(Apps.summary(this, true));
        }
        String st, dt;
        switch (State.phase) {
            case ON:
                st = "Защищено";
                dt = "Включено " + since() + " · ↓\u00a0" + rate(State.downRate) + " · ↑\u00a0" + rate(State.upRate);
                status.setTextColor(accent);
                break;
            case CONNECTING:
                st = "Подключаюсь…";
                dt = State.note.isEmpty() ? "Это занимает несколько секунд" : State.note;
                status.setTextColor(0xFFD97706);
                break;
            case RETRYING:
                st = "Переподключаюсь…";
                dt = State.note;
                status.setTextColor(0xFFD97706);
                break;
            default:
                status.setTextColor(text);
                if (!has) {
                    st = "Добавьте VPN";
                    dt = "Отсканируйте QR-код или вставьте ссылку, которую вам прислали";
                } else {
                    st = "Выключено";
                    dt = State.note.isEmpty() ? "Нажмите на кнопку, чтобы включить" : State.note;
                }
        }
        status.setText(st);
        detail.setText(dt);
        detail.setTextColor(State.phase == State.Phase.OFF && !State.note.isEmpty() ? 0xFFDC2626 : muted);
        if (State.phase == State.Phase.OFF) {
            ping.setVisibility(View.INVISIBLE);
        } else {
            ping.setVisibility(View.VISIBLE);
            int ms = State.pingMs, color;
            String t;
            if (ms < 0) {
                t = "Отклик: проверяю…";
                color = muted;
            } else if (ms == 0) {
                t = "Отклик: нет ответа";
                color = 0xFFDC2626;
            } else {
                t = "Отклик " + ms + " мс";
                color = ms < 150 ? 0xFF10B981 : ms < 400 ? 0xFFF59E0B : 0xFFDC2626;
            }
            ping.setText("● " + t);
            ping.setTextColor(color);
            ping.setBackground(press(round((color & 0x00FFFFFF) | 0x22000000, 14, 0), 14));
        }
    }

    // ---------- turning it on and off ----------

    private void toggle() {
        if (Profile.chosen(this) == null) {
            paste();
            return;
        }
        if (State.phase != State.Phase.OFF) {
            startService(new Intent(this, VpnSvc.class).setAction(VpnSvc.STOP));
            return;
        }
        connect();
    }

    /** Asks for the VPN permission once (Android's own question), then switches on. */
    private void connect() {
        Intent ask = VpnService.prepare(this);
        if (ask != null) startActivityForResult(ask, REQ_VPN);
        else start();
    }

    private void start() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && !getSharedPreferences("vpn", MODE_PRIVATE).getBoolean("askedNotify", false)) {
            getSharedPreferences("vpn", MODE_PRIVATE).edit().putBoolean("askedNotify", true).apply();
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
        }
        State.set(State.Phase.CONNECTING, "");
        Intent i = new Intent(this, VpnSvc.class).setAction(VpnSvc.START);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
        else startService(i);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_VPN) {
            if (res == RESULT_OK) start();
            else Toast.makeText(this, "Без разрешения VPN не включится", Toast.LENGTH_LONG).show();
            return;
        }
        if (req == REQ_IMAGE) {
            if (res != RESULT_OK || data == null || data.getData() == null) return;
            android.net.Uri uri = data.getData();
            new Thread(() -> {
                String found = Qr.fromImage(this, uri);
                runOnUiThread(() -> {
                    if (found == null) Toast.makeText(this, "На картинке не нашёл QR-код", Toast.LENGTH_LONG).show();
                    else add(found);
                });
            }).start();
            return;
        }
        IntentResult r = IntentIntegrator.parseActivityResult(req, res, data);
        if (r != null && r.getContents() != null) add(r.getContents());
    }

    // ---------- adding and choosing servers ----------

    private void handle(Intent i) {
        if (i == null) return;
        if (Intent.ACTION_VIEW.equals(i.getAction()) && i.getDataString() != null) add(i.getDataString());
        if (BuildConfig.DEBUG && i.getBooleanExtra("test_all", false)) {  // the emulator test only
            Apps.setOnlyChosen(this, false, false);
            Apps.setOnlyChosen(this, true, false);
        }
        if (BuildConfig.DEBUG) VpnSvc.testMapdns = i.getBooleanExtra("test_mapdns", false);  // the emulator test only
        if (BuildConfig.DEBUG && i.hasExtra("test_back")) VpnSvc.testBackMs = i.getLongExtra("test_back", 0);  // the emulator test only
        if (BuildConfig.DEBUG && i.hasExtra("test_ai")) Apps.aiHelper = i.getStringExtra("test_ai");  // the emulator test only
        String testRenew = BuildConfig.DEBUG ? i.getStringExtra("test_renew") : null;  // the emulator test only
        if (testRenew != null) {
            Profile f = Profile.parse(testRenew);
            boolean renewed = f != null && Profile.renew(this, f.auth, f, null, null);
            Profile now = Profile.chosen(this);
            Diag.i(this, "renew: " + renewed + " · chosen «" + (now == null ? "" : now.name) + "» " + (now == null ? "" : now.link.contains("moved=1")));
            changed();
        }
        String testDoor = BuildConfig.DEBUG ? i.getStringExtra("test_door") : null;  // the emulator test only
        if (testDoor != null) {  // the server's answer with its salamander door beside the chosen server's link
            Profile f = Profile.chosen(this), door = Profile.parse(testDoor);
            int before = Profile.all(this).size();
            if (f != null && door != null) BridgeSync.take(this, door.auth, f, null, door);
            Profile now = Profile.chosen(this);
            Diag.i(this, "door: kept " + (Profile.all(this).size() > before) + " · chosen «" + (now == null ? "" : now.name) + "»");
            changed();
        }
        if (BuildConfig.DEBUG && i.getBooleanExtra("test_journal", false)) {  // the emulator test only
            new Thread(() -> Diag.i(this, "report: " + Diag.report(this).split("\n--- ")[0].replace('\n', '|')), "journal-test").start();
        }
        String testRemove = BuildConfig.DEBUG ? i.getStringExtra("test_remove") : null;  // the emulator test only
        if (testRemove != null) {
            List<Profile> all = Profile.all(this);
            for (int k = all.size() - 1; k >= 0; k--) if (all.get(k).name.equals(testRemove)) all.remove(k);
            Profile.save(this, all);
            Profile.select(this, 0);
            changed();
        }
        String testSpeed = BuildConfig.DEBUG ? i.getStringExtra("test_speed") : null;  // the emulator test only
        if (testSpeed != null) for (Profile p : Profile.all(this)) if (p.name.equals(testSpeed)) speed(p);
        String testSelect = BuildConfig.DEBUG ? i.getStringExtra("test_select") : null;  // the emulator test only
        if (testSelect != null) {
            List<Profile> all = Profile.all(this);
            for (int k = 0; k < all.size(); k++) if (all.get(k).name.equals(testSelect)) Profile.select(this, k);
            changed();
        }
        String testApps = BuildConfig.DEBUG ? i.getStringExtra("test_apps") : null;  // the emulator test only
        if (testApps != null) {
            for (boolean bridge : new boolean[]{false, true}) {
                Apps.setOnlyChosen(this, bridge, true);
                for (String pkg : testApps.split(",")) Apps.choose(this, bridge, pkg.trim(), true);
            }
            appsChanged();
        }
        if (i.getBooleanExtra("connect", false) && Profile.chosen(this) != null && State.phase == State.Phase.OFF) connect();  // the tile
        // the AI helper asks for the family server's Claude: the bridges checked from this phone (the owner's only); started
        // here, before the screen may go back below — a check starts from the front
        String check = i.getStringExtra("check_bridges");
        if (check != null && Rescue.shown(this)) startCheck(check, false);
        // the AI helper switches Winger on when its server does not answer, and the person goes straight back to it
        // (unless Android still has to ask for the VPN: then this screen stays for the answer)
        if (i.getBooleanExtra("back", false) && VpnService.prepare(this) == null) moveTaskToBack(true);
        if (BuildConfig.DEBUG && i.hasExtra("test_check_join")) BridgeCheck.joinMs = i.getLongExtra("test_check_join", 50_000);  // the emulator test only
        if (BuildConfig.DEBUG && i.hasExtra("test_check")) startCheck(i.getStringExtra("test_check"), true);  // the emulator test only
        if (i.getBooleanExtra("show_check", false)) showCheck();
        String testPick = BuildConfig.DEBUG ? i.getStringExtra("test_pick") : null;  // the emulator test only
        if (testPick != null) pickApps(false, testPick);
        String testBridge = BuildConfig.DEBUG ? i.getStringExtra("test_bridge") : null;  // the emulator test only
        if (testBridge != null) add(testBridge);
        if (BuildConfig.DEBUG && i.hasExtra("test_auto")) Apps.setAutoBridge(this, i.getBooleanExtra("test_auto", true));  // (the test)
        if (BuildConfig.DEBUG && i.getBooleanExtra("test_connect", false)) connect();   // the emulator test only
        if (BuildConfig.DEBUG && i.getBooleanExtra("test_install", false)) Updater.testInstall(this);
        if (BuildConfig.DEBUG && i.getBooleanExtra("test_disconnect", false)) {
            startService(new Intent(this, VpnSvc.class).setAction(VpnSvc.STOP));
        }
    }

    /** A «Winger VPN» made for one person carries their connection (assets/winger-profile.txt, put in by the family
     *  server before it signs the app): it becomes the server on the first start, so the person only presses the button.
     *  Once: a server the person removes later does not come back. */
    private boolean packagedProfile() {
        String link;
        try (InputStream in = getAssets().open("winger-profile.txt")) {
            byte[] b = new byte[4096];
            int n = 0, r;
            while (n < b.length && (r = in.read(b, n, b.length - n)) > 0) n += r;
            link = new String(b, 0, n, StandardCharsets.UTF_8).trim();
        } catch (IOException e) {
            return false;  // the usual app: no connection inside
        }
        SharedPreferences prefs = getSharedPreferences("vpn", MODE_PRIVATE);
        if (link.equals(prefs.getString("packagedLink", ""))) return false;
        Profile p = Profile.find(link);
        if (p == null) return false;
        Profile.add(this, p);
        prefs.edit().putString("packagedLink", link).apply();
        Log.i("AIVPN", "profile from the package: " + p.name);
        return true;
    }

    private void add(String found) {
        Profile p = Profile.find(found);
        if (p == null) {
            String f = found == null ? "" : found.trim().toLowerCase();
            Toast.makeText(this, f.startsWith("vless://") || f.startsWith("vmess://")
                    ? "Это ссылка другого типа. Нужна ссылка, которая начинается с hysteria2://"
                    : "Это не ссылка VPN. Нужна ссылка, которая начинается с hysteria2://", Toast.LENGTH_LONG).show();
            return;
        }
        boolean was = State.phase != State.Phase.OFF;
        Profile.add(this, p);
        Toast.makeText(this, (p.bridge ? "Добавлен мост «" : "Добавлен сервер «") + p.name + "»", Toast.LENGTH_SHORT).show();
        if (was) start();  // it was on: go on with the new server
        changed();
    }

    private void copyJournal() {
        Toast.makeText(this, "Проверяю связь с сервером…", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            String report = Diag.report(this);
            Diag.i(this, "journal copied (" + report.length() + " chars)");
            runOnUiThread(() -> {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (cm != null) cm.setPrimaryClip(android.content.ClipData.newPlainText("Winger", report));
                Toast.makeText(this, "Скопировано — вставьте в чат. Ключей и адресов в нём нет", Toast.LENGTH_LONG).show();
            });
        }, "journal-copy").start();
    }

    private void scan() {
        new IntentIntegrator(this)
                .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
                .setPrompt("Наведите камеру на QR-код VPN")
                .setBeepEnabled(false)
                .setOrientationLocked(false)
                .initiateScan();
    }

    private void pickImage() {
        Intent i = new Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(Intent.createChooser(i, "Картинка с QR-кодом"), REQ_IMAGE);
    }

    private void paste() {
        EditText in = new EditText(this);
        in.setHint("hysteria2://…");
        in.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        in.setMinLines(2);
        ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null && cm.getPrimaryClip().getItemCount() > 0) {
            CharSequence clip = cm.getPrimaryClip().getItemAt(0).coerceToText(this);
            if (clip != null && Profile.find(clip.toString()) != null) in.setText(clip);
        }
        LinearLayout box = new LinearLayout(this);
        box.setPadding(dp(20), dp(8), dp(20), 0);
        box.addView(in, new LinearLayout.LayoutParams(-1, -2));
        new AlertDialog.Builder(this)
                .setTitle("Ссылка VPN")
                .setMessage("Вставьте ссылку из сообщения. Можно вставить сообщение целиком — ссылку я найду.")
                .setView(box)
                .setPositiveButton("Добавить", (d, w) -> add(in.getText().toString()))
                .setNegativeButton("Отмена", null)
                .show();
    }

    /** Once, on Android 13+: «add Winger to the shade?» — then it is switched on and off from there. */
    private void offerTile() {
        SharedPreferences prefs = getSharedPreferences("vpn", MODE_PRIVATE);
        if (Build.VERSION.SDK_INT < 33 || prefs.getBoolean("tileAsked", false) || Profile.chosen(this) == null) return;
        prefs.edit().putBoolean("tileAsked", true).apply();
        android.app.StatusBarManager sb = getSystemService(android.app.StatusBarManager.class);
        if (sb == null) return;
        try {
            sb.requestAddTileService(new android.content.ComponentName(this, VpnTile.class), getString(R.string.brand),
                    android.graphics.drawable.Icon.createWithResource(this, R.drawable.ic_stat), getMainExecutor(), r -> { });
        } catch (RuntimeException ignored) {
            // the phone does not offer it: the tile is still in the shade's editor
        }
    }

    /** A settings row shown or hidden; each thin line stays only between two rows that are shown. */
    private void setRow(View row, boolean show) {
        row.setVisibility(show ? View.VISIBLE : View.GONE);
        ViewGroup list = (ViewGroup) row.getParent();
        boolean before = false;  // a row shown above
        for (int i = 0; i < list.getChildCount(); i++) {
            View v = list.getChildAt(i);
            if (v instanceof LinearLayout) {  // a row
                before |= v.getVisibility() == View.VISIBLE;
                continue;
            }
            View next = i + 1 < list.getChildCount() ? list.getChildAt(i + 1) : null;  // a line: above the next row
            v.setVisibility(before && next != null && next.getVisibility() == View.VISIBLE ? View.VISIBLE : View.GONE);
        }
    }

    /** The bridges checked from this phone (a few minutes, in the background with a notice); mine: asked here — its
     *  result is shown here. An ask from outside (the AI helper) is taken at most once a minute. */
    private void startCheck(String task, boolean mine) {
        if (BridgeCheck.running.get()) {
            if (mine) Toast.makeText(this, "Проверка уже идёт — её ход в уведомлении", Toast.LENGTH_SHORT).show();
            return;
        }
        if (!mine && System.currentTimeMillis() - BridgeCheck.lastStart() < 60_000) return;
        checkAsked |= mine;
        Intent s = new Intent(this, CheckSvc.class).putExtra(CheckSvc.TASK, task == null ? "" : task);
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(s);
            else startService(s);
        } catch (RuntimeException e) {
            Diag.w(this, "bridge check start", e);
            return;
        }
        if (mine) Toast.makeText(this, "Проверяю мосты — несколько минут, ход в уведомлении", Toast.LENGTH_LONG).show();
        changed();
    }

    /** The last check's report, in a few lines. */
    private void showCheck() {
        org.json.JSONObject r = BridgeCheck.last(this);
        BridgeCheck.fresh = false;
        if (r == null || isFinishing()) return;
        String when = new java.text.SimpleDateFormat("dd.MM HH:mm", Locale.ROOT).format(new java.util.Date(r.optLong("at") * 1000));
        new AlertDialog.Builder(this).setTitle("Проверка мостов · " + when).setMessage(BridgeCheck.summary(r))
                .setPositiveButton("Понятно", null).show();
    }

    /** «⏱ отклик 85 мс · 15:03» → «85 мс · 15:03»; «⚡ 23,4 Мбит/с · 45 мс» stays with its ⚡ (one row's short line). */
    private static String shortLine(String s) {
        if (s == null) return null;
        return s.replaceFirst("^⏱\\s*отклик\\s*", "").replaceFirst("^⚡\\s*", "⚡ ");
    }

    /** The connections' rows: made again only when the list changes; their mark, line and state follow the VPN. Each row:
     *  a mark (filled: the one in use), its sign, its name, one short line (its response time and speed, or what a bridge
     *  goes through), what it is doing now on the right, and ⚡ for its speed. A long press removes it. */
    private void showConns(List<Profile> all) {
        StringBuilder key = new StringBuilder();
        for (Profile p : all) key.append(p.bridge ? "b|" : "s|").append(p.name).append('\n');
        if (!key.toString().equals(connsKey)) {
            connsKey = key.toString();
            conns.removeAllViews();
            connRows.clear();
            connNotes.clear();
            connChips.clear();
            connDots.clear();
            for (int i = 0; i < all.size(); i++) {
                Profile p = all.get(i);
                int at = i;
                LinearLayout row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setGravity(Gravity.CENTER_VERTICAL);
                row.setPadding(dp(14), dp(11), dp(4), dp(11));
                row.setMinimumHeight(dp(60));
                row.setBackground(press(round(0x00000000, 0, 0), 0));
                row.setOnClickListener(v -> {
                    v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
                    use(at);
                });
                row.setOnLongClickListener(v -> {
                    remove(Profile.all(this), at);
                    return true;
                });
                View dot = new View(this);
                row.addView(dot, new LinearLayout.LayoutParams(dp(18), dp(18)));
                LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(dp(34), -2);
                ip.leftMargin = dp(6);
                row.addView(label(p.bridge ? "🌉" : "🌐", 20, text, false), ip);
                LinearLayout col = new LinearLayout(this);
                col.setOrientation(LinearLayout.VERTICAL);
                TextView name = label(p.name, 16, text, true);
                name.setGravity(Gravity.START);
                name.setSingleLine(true);
                name.setEllipsize(android.text.TextUtils.TruncateAt.END);
                col.addView(name, new LinearLayout.LayoutParams(-2, -2));
                TextView note = label("", 13, muted, false);
                note.setGravity(Gravity.START);
                note.setSingleLine(true);
                note.setEllipsize(android.text.TextUtils.TruncateAt.END);
                col.addView(note, new LinearLayout.LayoutParams(-2, -2));
                LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(0, -2, 1f);
                cp.leftMargin = dp(4);
                row.addView(col, cp);
                TextView chip = label("", 12, accent, true);
                chip.setPadding(dp(9), dp(3), dp(9), dp(3));
                chip.setSingleLine(true);
                LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(-2, -2);
                hp.leftMargin = dp(6);
                row.addView(chip, hp);
                // its speed check: a small round button
                TextView fast = label("⚡", 16, text, false);
                fast.setGravity(Gravity.CENTER);
                fast.setBackground(press(round(0x00000000, 20, 0), 20));
                fast.setContentDescription("Проверить скорость");
                fast.setOnClickListener(v -> speed(Profile.all(this).get(at)));
                LinearLayout.LayoutParams fp = new LinearLayout.LayoutParams(dp(40), dp(40));
                fp.leftMargin = dp(2);
                row.addView(fast, fp);
                addTo(conns, row);
                connRows.add(row);
                connNotes.add(note);
                connChips.add(chip);
                connDots.add(dot);
            }
        }
        int cur = Math.max(0, Math.min(Profile.current(this), all.size() - 1));
        int act = activeIndex(all);
        boolean on = State.phase != State.Phase.OFF;
        for (int i = 0; i < connRows.size() && i < all.size(); i++) {
            Profile p = all.get(i);
            String chip = "";
            int chipColor = accent, ring = dark ? 0xFF3B4556 : 0xFFD1D5DB, width = 2;
            if (on && i == act && State.phase == State.Phase.ON) {
                chip = State.auto ? "Включено само" : "Включено";
                ring = accent;
                width = 5;
            } else if (on && i == act) {
                chip = State.phase == State.Phase.CONNECTING ? "Подключаюсь…" : "Переподключаюсь…";
                chipColor = ring = 0xFFD97706;
                width = 5;
            } else if (on && i == cur) {
                chip = "Не отвечает";
                chipColor = 0xFFD97706;
                ring = muted;
            } else if (i == cur) {
                ring = muted;
            }
            // its line: the response time (live for the one in use) and the last speed; a bridge: what it goes through
            List<String> parts = new ArrayList<>();
            if (p.bridge) parts.add("мост через " + VpnSvc.service(p));
            String pg = on && i == act && State.phase == State.Phase.ON && State.pingMs > 0 ? State.pingMs + " мс"
                    : shortLine(Speed.lastPing(this, p));
            if (pg != null) parts.add(pg);
            String sp = shortLine(Speed.last(this, p));
            if (sp != null) parts.add(sp);
            String note = parts.isEmpty() ? "сервер" : android.text.TextUtils.join(" · ", parts);
            TextView n = connNotes.get(i);
            TextView c = connChips.get(i);
            if (!note.contentEquals(n.getText()) || !chip.contentEquals(c.getText())) {
                Log.i("AIVPN", "button «" + p.name + "»: " + (chip.isEmpty() ? "" : chip + " · ") + note);
            }
            n.setText(note);
            c.setText(chip);
            c.setVisibility(chip.isEmpty() ? View.GONE : View.VISIBLE);
            c.setTextColor(chipColor);
            c.setBackground(round((chipColor & 0x00FFFFFF) | 0x22000000, 12, 0));
            View dot = connDots.get(i);
            Object was = dot.getTag();
            int mark = ring * 31 + width;
            if (was == null || (Integer) was != mark) {  // drawn again only when it changes
                dot.setTag(mark);
                GradientDrawable g = new GradientDrawable();
                g.setShape(GradientDrawable.OVAL);
                g.setColor(0x00000000);
                g.setStroke(dp(width), ring);
                dot.setBackground(g);
            }
        }
        // what a tap does, said once under the list (and why another one is on by itself)
        String h = State.auto && State.phase == State.Phase.ON ? "Выбранное подключение не отвечает — Winger включил другое сам."
                : on ? "Нажмите на включённое, чтобы выключить, или на другое — чтобы перейти на него."
                : all.size() > 1 ? "Нажмите на подключение — Winger включится через него. Удалить — долгое нажатие."
                : "Удалить подключение — долгое нажатие на него.";
        if (!h.contentEquals(hint.getText())) hint.setText(h);
    }

    /** The row of the connection in use now (the chosen one, or the one Winger moved to by itself). */
    private int activeIndex(List<Profile> all) {
        for (int i = 0; i < all.size(); i++) if (all.get(i).link.equals(State.activeLink)) return i;
        return Math.max(0, Math.min(Profile.current(this), all.size() - 1));
    }

    /** A connection's button: on through it (switching over from another one), or off when it is the one in use. */
    private void use(int at) {
        if (at == activeIndex(Profile.all(this)) && State.phase != State.Phase.OFF) {
            startService(new Intent(this, VpnSvc.class).setAction(VpnSvc.STOP));
            return;
        }
        Profile.select(this, at);
        changed();
        if (State.phase != State.Phase.OFF) start();  // the service closes the old connection and opens this one
        else connect();
    }

    /** The speed of one connection, measured off the screen's thread; the result stays on its button. */
    private void speed(Profile p) {
        boolean active = State.phase == State.Phase.ON && p.link.equals(State.activeLink);
        if (p.bridge && !active) {
            Toast.makeText(this, "Скорость моста проверяется, когда он включён: включите его кнопкой и проверьте снова",
                    Toast.LENGTH_LONG).show();
            return;
        }
        Toast.makeText(this, "⚡ Проверяю скорость «" + p.name + "»… около 10 секунд", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            String r = Speed.measure(this, p);
            runOnUiThread(() -> {
                connsKey = "";  // the buttons are drawn again with the result
                changed();
                Toast.makeText(this, "«" + p.name + "»: " + (r == null ? "не получилось проверить" : r), Toast.LENGTH_LONG).show();
            });
        }, "speed").start();
    }

    private void remove(List<Profile> all, int i) {
        new AlertDialog.Builder(this)
                .setMessage("Удалить подключение «" + all.get(i).name + "» из приложения?")
                .setPositiveButton("Удалить", (d, w) -> {
                    int cur = Math.max(0, Math.min(Profile.current(this), all.size() - 1));
                    if (i == cur && State.phase != State.Phase.OFF) startService(new Intent(this, VpnSvc.class).setAction(VpnSvc.STOP));
                    all.remove(i);
                    Profile.save(this, all);
                    Profile.select(this, i < cur ? cur - 1 : i == cur ? 0 : cur);  // the server in use stays chosen
                    changed();
                })
                .setNegativeButton("Отмена", null)
                .show();
    }

    // ---------- which apps go through the VPN ----------

    /** What goes through the server (bridge: through a bridge): the standard list and any other ticked apps, or all. */
    private void chooseApps(boolean bridge) {
        String[] modes = bridge ? new String[]{
                "Только отмеченные: Telegram, WhatsApp, Instagram, ChatGPT… и любые другие. Мост медленный — видео лучше не "
                        + "пускать; разрешённые в эти дни сайты (банки, Госуслуги, Яндекс, VK) — напрямую",
                "Все приложения"} : new String[]{
                "Только отмеченные: Instagram, Telegram, YouTube… и любые другие. Банки, Госуслуги, маркетплейсы — напрямую",
                "Все приложения"};
        boolean only = Apps.onlyChosen(this, bridge);
        int[] picked = {only ? 0 : 1};
        new AlertDialog.Builder(this)
                .setTitle(bridge ? "Что пускать через мост" : "Что пускать через сервер")
                .setSingleChoiceItems(modes, picked[0], (d, w) -> picked[0] = w)
                .setPositiveButton("Готово", (d, w) -> {
                    if ((picked[0] == 0) == only) return;
                    Apps.setOnlyChosen(this, bridge, picked[0] == 0);
                    appsChanged();
                })
                .setNeutralButton("Какие приложения", (d, w) -> pickApps(bridge, null))
                .setNegativeButton("Отмена", null)
                .show();
    }

    /** Every app on the phone, ticked or not, with a search; the list is gathered off the screen's thread. */
    private void pickApps(boolean bridge, String query) {
        new Thread(() -> {
            List<Apps.App> all = Apps.all(this, bridge);
            Set<String> on = new HashSet<>();
            for (Apps.App a : all) if (Apps.chosen(this, bridge, a.pkg)) on.add(a.pkg);
            runOnUiThread(() -> {
                if (!isFinishing() && !isDestroyed()) showApps(bridge, all, on, query);
            });
        }, "apps").start();
    }

    private void showApps(boolean bridge, List<Apps.App> all, Set<String> on, String query) {
        AlertDialog.Builder b = new AlertDialog.Builder(this);
        Context dc = b.getContext();
        PackageManager pm = getPackageManager();
        EditText search = new EditText(dc);
        search.setHint("Поиск по названию");
        search.setSingleLine(true);
        search.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        List<Apps.App> shown = new ArrayList<>();
        Map<String, Drawable> icons = new HashMap<>();
        ArrayAdapter<Apps.App> adapter = new ArrayAdapter<Apps.App>(dc, android.R.layout.simple_list_item_multiple_choice, shown) {
            @Override
            public View getView(int pos, View convert, ViewGroup parent) {
                TextView v = (TextView) super.getView(pos, convert, parent);
                String pkg = shown.get(pos).pkg;
                Drawable d = icons.get(pkg);
                if (d == null) {
                    try {
                        d = pm.getApplicationIcon(pkg);
                    } catch (PackageManager.NameNotFoundException e) {
                        d = new ColorDrawable(0);
                    }
                    d.setBounds(0, 0, dp(32), dp(32));
                    icons.put(pkg, d);
                }
                v.setCompoundDrawablesRelative(d, null, null, null);
                v.setCompoundDrawablePadding(dp(14));
                return v;
            }
        };
        ListView list = new ListView(dc);
        list.setChoiceMode(ListView.CHOICE_MODE_MULTIPLE);
        list.setAdapter(adapter);
        LinearLayout box = new LinearLayout(dc);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(16), dp(4), dp(16), 0);
        box.addView(search, new LinearLayout.LayoutParams(-1, -2));
        box.addView(list, new LinearLayout.LayoutParams(-1, getResources().getDisplayMetrics().heightPixels * 55 / 100));
        AlertDialog dialog = b.setTitle(appsTitle(bridge, on.size()))
                .setView(box)
                .setPositiveButton("Готово", (d, w) -> {
                    for (Apps.App a : all) Apps.choose(this, bridge, a.pkg, on.contains(a.pkg));
                    Apps.setOnlyChosen(this, bridge, true);
                    appsChanged();
                })
                .setNegativeButton("Отмена", null)
                .create();
        Runnable filter = () -> {
            String q = search.getText().toString().trim().toLowerCase(Locale.ROOT);
            shown.clear();
            for (Apps.App a : all) {
                if (q.isEmpty() || a.name.toLowerCase(Locale.ROOT).contains(q) || a.pkg.contains(q)) shown.add(a);
            }
            adapter.notifyDataSetChanged();
            for (int i = 0; i < shown.size(); i++) list.setItemChecked(i, on.contains(shown.get(i).pkg));
        };
        list.setOnItemClickListener((p, v, pos, id) -> {
            if (list.isItemChecked(pos)) on.add(shown.get(pos).pkg);
            else on.remove(shown.get(pos).pkg);
            dialog.setTitle(appsTitle(bridge, on.size()));
        });
        search.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence t, int start, int count, int after) {}

            @Override
            public void onTextChanged(CharSequence t, int start, int before, int count) {}

            @Override
            public void afterTextChanged(Editable e) {
                filter.run();
            }
        });
        if (query != null) search.setText(query);
        filter.run();
        dialog.show();
        Log.i("AIVPN", "apps to pick: " + all.size() + ", shown " + shown.size());
    }

    private static String appsTitle(boolean bridge, int n) {
        String where = bridge ? "Через мост" : "Через сервер";
        return n == 0 ? where + " — отметьте приложения" : where + " — отмечено: " + n;
    }

    /** Takes effect at once: when on, the tunnel is opened again with the new list. */
    private void appsChanged() {
        changed();
        if (State.phase == State.Phase.OFF) return;
        Intent i = new Intent(this, VpnSvc.class).setAction(VpnSvc.START).putExtra("again", true);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
        else startService(i);
        Toast.makeText(this, "Готово", Toast.LENGTH_SHORT).show();
    }

    // ---------- looks ----------

    private TextView label(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return t;
    }

    private TextView button(String s, boolean filled) {
        TextView b = label(s, 15, filled ? 0xFFFFFFFF : text, true);
        b.setBackground(press(round(filled ? accent : card, 16, filled ? 0 : (dark ? 0xFF2A3341 : 0xFFE5E7EB)), 16));
        return b;
    }

    private GradientDrawable round(int color, int radiusDp, int stroke) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(dp(radiusDp));
        if (stroke != 0) g.setStroke(dp(1), stroke);
        return g;
    }

    private RippleDrawable press(GradientDrawable bg, int radiusDp) {
        GradientDrawable mask = round(0xFFFFFFFF, radiusDp, 0);
        return new RippleDrawable(ColorStateList.valueOf(dark ? 0x33FFFFFF : 0x22000000), bg, mask);
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private static String rate(double bps) {
        if (bps < 1024) return "0\u00a0КБ/с";
        if (bps < 1024 * 1024) return Math.round(bps / 1024) + "\u00a0КБ/с";
        return String.format(java.util.Locale.ROOT, "%.1f\u00a0МБ/с", bps / 1024 / 1024).replace('.', ',');
    }

    private static String since() {
        if (State.since == 0) return "сейчас";
        long min = (System.currentTimeMillis() - State.since) / 60_000;
        if (min < 1) return "только что";
        if (min < 60) return min + " мин";
        return min / 60 + " ч " + min % 60 + " мин";
    }
}
