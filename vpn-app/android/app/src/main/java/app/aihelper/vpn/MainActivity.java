package app.aihelper.vpn;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
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
import android.widget.ImageView;
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

/** One screen (B «Северное сияние», one style with the AI helper): the big button and how the connection is; the
 *  connections in one list (a tap: on through it; «⋯»: its speed, or removing it); the settings below (which apps, adding
 *  a connection, the update; the owner's: the journal, the bridges' check, the rescue). The first time: adding a
 *  connection from a QR code or a link is the one thing to do. A tablet on its side: the button on the left, the lists on
 *  the right. */
public class MainActivity extends Activity implements State.Listener {
    private static final int REQ_VPN = 1, REQ_IMAGE = 2, REQ_NOTIFY = 3;
    private boolean dark, wide, shown;
    private int builtWidth;  // the width (dp) the screen was laid out for: turned or resized, laid out again
    private float builtScale;  // and the phone's text size it was laid out with
    // the colour roles (res/values, values-night): the same names as the helper's and Winger for Windows' tokens
    private int text, text2, surf, surf2, well, line, lineStrong, on, onInk, onTint, onText, accent, accentInk, cyan, amber, amberInk,
            amberText, bad;
    private Typeface regular, medium, semibold, bold;  // Onest, the family's face
    private PowerButton power;
    private AuroraView aurora;
    private TextView status, detail, ping, appsName, bridgeAppsName, hint, connsHead, checkVal, scoutVal, autoSub, sleepSub;
    private LinearLayout conns, appsCard, bridgeAppsCard, addRow, firstAdd, rescueRow, checkRow, scoutRow, journalRow;
    private android.widget.Switch autoSwitch, sleepSwitch;
    private android.widget.PopupWindow menu;  // a connection's «⋯»
    private int pingLook;  // the response time's chip as drawn last (drawn again only when it changes)
    private boolean checkAsked;  // the button here started the check: its result is shown here when it is done
    private long quickAsked;  // (v32) when «Что работает здесь» was pressed: its word is told once done
    private String connsKey = "";
    // (v33) while the screen is open, once a minute: each server's response time and one speed that is due (Speed.auto)
    private final android.os.Handler ticker = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            Runnable redraw = () -> runOnUiThread(MainActivity.this::changed);
            Speed.pingAll(MainActivity.this, redraw);
            Speed.auto(MainActivity.this, redraw);
            ticker.postDelayed(this, 60_000);
        }
    };
    private String captchaShown = "";  // the check page last opened by itself (closed by hand: not again)
    private final List<LinearLayout> connRows = new ArrayList<>();
    private final List<TextView> connNotes = new ArrayList<>();
    private final List<FrameLayout> connWells = new ArrayList<>();

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        // a phone keeps the screen upright; a tablet turns with the hand (its landscape: two columns)
        if (getResources().getConfiguration().smallestScreenWidthDp < 600) setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        looks();
        boolean packaged = packagedProfile();
        build();
        if (packaged) Toast.makeText(this, "Подключение уже внутри — нажмите большую кнопку", Toast.LENGTH_LONG).show();
        offerTile();
        // a link that opened the app counts once: not again when Android recreates the screen or reopens it from Recents
        if (saved == null && (getIntent().getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0) handle(getIntent());
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        // the phone's dark theme switched while Winger is open (it keeps itself through such changes): drawn again in it
        if (((c.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES) != dark) {
            recreate();
            return;
        }
        // turned (a tablet), resized (split screen) or another text size: laid out again for it
        if (wide(c) != wide || c.screenWidthDp != builtWidth || c.fontScale != builtScale) {
            connsKey = "";
            pingLook = 0;
            build();
            changed();
        }
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
        paintSleep();  // (v37) back from Android's battery screen: what it says now
        Updater.check(this, false);
        BridgeSync.run(this, false);  // the owner's bridge, kept ready (nobody else gets one)
        ticker.removeCallbacks(tick);
        ticker.post(tick);  // every server's response time, and the speeds that are due — again each minute while open
        Diag.upload(this, false);  // the journal to the family server (it keeps the owner's only), from every phone
        if (Rescue.shown(this)) new Thread(() -> BridgeCheck.sendPending(this), "check-send").start();  // a report made offline
    }

    @Override
    protected void onPause() {
        ticker.removeCallbacks(tick);
        State.unlisten(this);
        if (menu != null) menu.dismiss();
        super.onPause();
    }

    // ---------- the screen ----------

    /** A tablet on its side (or any wide window): two columns. */
    private static boolean wide(Configuration c) {
        return c.screenWidthDp >= 720 && c.screenWidthDp > c.screenHeightDp;
    }

    /** The colours and the face, once. */
    private void looks() {
        text = getColor(R.color.text);
        text2 = getColor(R.color.text2);
        surf = getColor(R.color.surf);
        surf2 = getColor(R.color.surf2);
        well = getColor(R.color.well);
        line = getColor(R.color.line);
        lineStrong = getColor(R.color.line_strong);
        on = getColor(R.color.on);
        onInk = getColor(R.color.on_ink);
        onTint = getColor(R.color.on_tint);
        onText = getColor(R.color.on_text);
        accent = getColor(R.color.accent);
        accentInk = getColor(R.color.accent_ink);
        cyan = getColor(R.color.cyan);
        amber = getColor(R.color.amber);
        amberInk = getColor(R.color.amber_ink);
        amberText = getColor(R.color.amber_text);
        bad = getColor(R.color.bad);
        regular = font(R.font.onest_400, Typeface.DEFAULT);
        medium = font(R.font.onest_500, Typeface.create("sans-serif-medium", Typeface.NORMAL));
        semibold = font(R.font.onest_600, Typeface.create("sans-serif-medium", Typeface.NORMAL));
        bold = font(R.font.onest_700, Typeface.DEFAULT_BOLD);
    }

    private Typeface font(int res, Typeface otherwise) {
        try {
            Typeface t = androidx.core.content.res.ResourcesCompat.getFont(this, res);
            if (t != null) return t;
        } catch (RuntimeException e) {
            Log.w("AIVPN", "font: " + e);
        }
        return otherwise;
    }

    private void build() {
        Configuration cfg = getResources().getConfiguration();
        wide = wide(cfg);
        builtWidth = cfg.screenWidthDp;
        builtScale = cfg.fontScale;
        if (menu != null) menu.dismiss();
        int gutter = dp(cfg.screenWidthDp < 360 ? 16 : 20);
        FrameLayout frame = new FrameLayout(this);
        aurora = new AuroraView(this, dark, wide);
        frame.addView(aurora, new FrameLayout.LayoutParams(-1, -1));

        // the name: the winged shield in the text's colour, «Winger», whose VPN it is
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        head.setMinimumHeight(dp(56));
        head.addView(new LogoView(this, text), new LinearLayout.LayoutParams(dp(47), dp(41)));
        LinearLayout names = new LinearLayout(this);
        names.setOrientation(LinearLayout.VERTICAL);
        names.setPadding(dp(12), 0, 0, 0);
        TextView title = label(getString(R.string.brand), 21, text, semibold);
        title.setGravity(Gravity.START);
        title.setLetterSpacing(-0.01f);
        names.addView(title, new LinearLayout.LayoutParams(-2, -2));
        TextView sub = label(getString(R.string.full_name), 13, text2, regular);
        sub.setGravity(Gravity.START);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
        lp.topMargin = dp(2);
        names.addView(sub, lp);
        head.addView(names, new LinearLayout.LayoutParams(0, -2, 1f));

        // the button and how it is
        LinearLayout hero = new LinearLayout(this);
        hero.setOrientation(LinearLayout.VERTICAL);
        hero.setGravity(Gravity.CENTER_HORIZONTAL);
        power = new PowerButton(this, dark);
        power.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            toggle();
        });
        int big = wide ? 240 : cfg.screenHeightDp < 720 ? 164 : 200;  // a smaller button on a short screen
        hero.addView(power, new LinearLayout.LayoutParams(dp(big), dp(big)));
        status = label("", wide ? 34 : 28, text, bold);  // (DESIGN.md: the display size)
        status.setLetterSpacing(-0.01f);
        lp = new LinearLayout.LayoutParams(-2, -2);
        lp.topMargin = dp(8);
        hero.addView(status, lp);
        detail = label("", 14, text2, regular);
        lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = dp(6);
        hero.addView(detail, lp);
        // the response time, a small chip (a tap: checked again)
        ping = label("", 14, onText, semibold);
        ping.setPadding(dp(14), dp(6), dp(14), dp(6));
        ping.setOnClickListener(v -> {
            if (State.phase == State.Phase.ON) {
                ping.setText("Проверяю отклик…");
                startService(new Intent(this, VpnSvc.class).setAction(VpnSvc.PING));
            }
        });
        lp = new LinearLayout.LayoutParams(-2, -2);
        lp.topMargin = dp(10);
        hero.addView(ping, lp);

        // the first time: adding a connection is the one thing to do — two big buttons, and a picture as a quiet third way
        firstAdd = new LinearLayout(this);
        firstAdd.setOrientation(LinearLayout.VERTICAL);
        firstAdd.setGravity(Gravity.CENTER_HORIZONTAL);
        firstAdd.addView(pill(R.drawable.i_qr, "Сканировать QR-код", true, v -> scan()), new LinearLayout.LayoutParams(-1, dp(48)));
        lp = new LinearLayout.LayoutParams(-1, dp(48));
        lp.topMargin = dp(10);
        firstAdd.addView(pill(R.drawable.i_paste, "Вставить ссылку", false, v -> paste()), lp);
        LinearLayout fromImage = new LinearLayout(this);
        fromImage.setGravity(Gravity.CENTER);
        fromImage.setPadding(dp(14), dp(12), dp(14), dp(12));
        fromImage.setMinimumHeight(dp(48));
        fromImage.setBackground(press(round(0x00000000, 24, 0), 24));
        fromImage.addView(icon(R.drawable.i_photo, text2), new LinearLayout.LayoutParams(dp(20), dp(20)));
        TextView fromText = label("QR-код из картинки или скриншота", 15, text2, medium);
        lp = new LinearLayout.LayoutParams(-2, -2);
        lp.leftMargin = dp(8);
        fromImage.addView(fromText, lp);
        fromImage.setOnClickListener(v -> pickImage());
        lp = new LinearLayout.LayoutParams(-2, -2);
        lp.topMargin = dp(6);
        firstAdd.addView(fromImage, lp);

        // the connections, one list: a tap switches on through that one, a tap on the one that is on switches it off
        LinearLayout lists = new LinearLayout(this);
        lists.setOrientation(LinearLayout.VERTICAL);
        connsHead = section("Подключение");
        lists.addView(connsHead, sectionParams());
        conns = list();
        lists.addView(conns, new LinearLayout.LayoutParams(-1, -2));
        hint = label("", 14, text2, regular);
        hint.setGravity(Gravity.START);
        hint.setPadding(dp(4), dp(8), dp(4), 0);
        lists.addView(hint, new LinearLayout.LayoutParams(-1, -2));
        // (v32) before connecting: which of them carry on this network now — each one's line then says so, no numbers
        LinearLayout scoutCard = list();
        scoutVal = subLabel();
        scoutRow = setting(R.drawable.i_search, "Что работает здесь", scoutVal, v -> startCheck(BridgeCheck.QUICK, true));
        addTo(scoutCard, scoutRow);
        lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = dp(12);
        lists.addView(scoutCard, lp);

        // the settings: which apps go through it, two switches, adding a connection, the update (and the owner's own)
        lists.addView(section("Настройки"), sectionParams());
        LinearLayout settings = list();
        // a list of its own for the server and for a bridge: the two are for different things
        appsName = subLabel();
        appsCard = setting(R.drawable.i_layers, "Какие приложения", appsName, v -> chooseApps(false));
        addTo(settings, appsCard);
        bridgeAppsName = subLabel();
        bridgeAppsCard = setting(R.drawable.i_phone, "Приложения через мост", bridgeAppsName, v -> chooseApps(true));
        addTo(settings, bridgeAppsCard);
        // (v32) a bridge that carries here now, by itself, when the connection in use stops carrying
        autoSub = subLabel();
        autoSwitch = toggleView();
        addTo(settings, switchRow(R.drawable.i_shuffle, "Сам выбирать мост", autoSub, autoSwitch, v -> {
            Apps.setAutoBridge(this, !Apps.autoBridge(this));
            paintAuto();
        }));
        paintAuto();
        // (v37) the connection holds while the screen is off: the processor kept awake while the VPN is on and the screen
        // off, and Android's battery saving off for Winger (else it cuts the network of a sleeping phone)
        sleepSub = subLabel();
        sleepSwitch = toggleView();
        addTo(settings, switchRow(R.drawable.i_moon, "Работать при выключенном экране", sleepSub, sleepSwitch, v -> sleepTapped()));
        paintSleep();
        addRow = setting(R.drawable.i_plus, "Добавить подключение", null, v -> addMenu());
        addTo(settings, addRow);
        // which Winger this is, and a check right now (otherwise it looks for a new version every few hours by itself)
        TextView version = subLabel();
        sub(version, "Версия " + BuildConfig.VERSION_NAME);
        addTo(settings, setting(R.drawable.i_refresh, "Обновления", version, v -> {
            Toast.makeText(this, "Проверяю обновление…", Toast.LENGTH_SHORT).show();
            Updater.check(this, true);
            BridgeSync.run(this, true);
            Diag.upload(this, true);
        }));
        // the owner's only (the family server says whose login this is): the journal copied into a chat, for when the
        // family server is out of reach (every phone still sends its journal to the server by itself)
        journalRow = setting(R.drawable.i_copy, "Скопировать журнал", null, v -> copyJournal());
        addTo(settings, journalRow);
        // the owner's only: the bridges checked from this phone, on its own network (the family server's Claude reads the report)
        checkVal = subLabel();
        checkRow = setting(R.drawable.i_pulse, "Проверить мосты с этого телефона", checkVal, v -> startCheck("", true));
        addTo(settings, checkRow);
        // the owner's only: the family server's rescue console in the browser (shown once the server says it is the owner)
        TextView rescueSub = subLabel();
        sub(rescueSub, "Консоль в браузере");
        rescueRow = setting(R.drawable.i_lifebuoy, "Спасение сервера", rescueSub, v -> Rescue.open(this));
        addTo(settings, rescueRow);
        lists.addView(settings, new LinearLayout.LayoutParams(-1, -2));

        View content;
        if (!wide) {
            // a phone (and a tablet held upright): one column; on a tall screen the spacers share the room, on a short
            // one it scrolls
            LinearLayout root = new LinearLayout(this);
            root.setOrientation(LinearLayout.VERTICAL);
            root.setPadding(gutter, dp(10), gutter, dp(24));
            root.addView(head, new LinearLayout.LayoutParams(-1, -2));
            root.addView(new View(this), new LinearLayout.LayoutParams(1, dp(12), 1f));
            root.addView(hero, new LinearLayout.LayoutParams(-1, -2));
            root.addView(new View(this), new LinearLayout.LayoutParams(1, dp(8), 1f));
            lp = new LinearLayout.LayoutParams(-1, -2);
            lp.topMargin = dp(16);
            root.addView(firstAdd, lp);
            root.addView(lists, new LinearLayout.LayoutParams(-1, -2));
            content = scroller(root, cfg.screenWidthDp > 600 ? dp(600) : -1);
        } else {
            // a tablet on its side: the name and the button on the left, the lists on the right (each scrolls by itself)
            LinearLayout left = new LinearLayout(this);
            left.setOrientation(LinearLayout.VERTICAL);
            left.setPadding(dp(40), dp(10), dp(24), dp(24));
            left.addView(head, new LinearLayout.LayoutParams(-1, -2));
            left.addView(new View(this), new LinearLayout.LayoutParams(1, dp(12), 1f));
            left.addView(hero, new LinearLayout.LayoutParams(-1, -2));
            lp = new LinearLayout.LayoutParams(Math.min(dp(380), (getResources().getDisplayMetrics().widthPixels / 2) - dp(64)), -2);
            lp.gravity = Gravity.CENTER_HORIZONTAL;
            lp.topMargin = dp(24);
            left.addView(firstAdd, lp);
            left.addView(new View(this), new LinearLayout.LayoutParams(1, dp(12), 1f));
            LinearLayout right = new LinearLayout(this);
            right.setOrientation(LinearLayout.VERTICAL);
            right.setPadding(dp(24), dp(58), dp(40), dp(24));
            right.addView(lists, new LinearLayout.LayoutParams(-1, -2));
            LinearLayout two = new LinearLayout(this);
            two.setOrientation(LinearLayout.HORIZONTAL);
            two.addView(scroller(left, -1), new LinearLayout.LayoutParams(0, -1, 1f));
            two.addView(scroller(right, -1), new LinearLayout.LayoutParams(0, -1, 1.1f));
            content = two;
        }
        frame.addView(content, new FrameLayout.LayoutParams(-1, -1));
        setContentView(frame);
        if (!shown) {  // the screen comes in once, softly (not again when it is laid out anew)
            shown = true;
            content.setAlpha(0f);
            content.animate().alpha(1f).setDuration(360).setInterpolator(new android.view.animation.DecelerateInterpolator(2f)).start();
        }
    }

    /** A column that scrolls when it does not fit (and fills the screen when it does: its spacers share the room). */
    private ScrollView scroller(View column, int width) {
        ScrollView s = new ScrollView(this);
        s.setFillViewport(true);
        s.setVerticalScrollBarEnabled(false);
        s.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        s.addView(column, new FrameLayout.LayoutParams(width, -1, Gravity.CENTER_HORIZONTAL));
        return s;
    }

    /** Android does not cut Winger's network in deep sleep (its battery saving is off for it). */
    private boolean batteryFree() {
        android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
        return Build.VERSION.SDK_INT < 23 || pm == null || pm.isIgnoringBatteryOptimizations(getPackageName());
    }

    /** «Сам выбирать мост»: its switch, and what it does now, in words. */
    private void paintAuto() {
        boolean at = Apps.autoBridge(this);
        autoSwitch.setChecked(at);
        sub(autoSub, at ? "Если связь пропадёт — перейдёт на мост, который здесь работает" : "Остаётся на выбранном подключении");
    }

    /** «Работать при выключенном экране»: its switch, and whether Android still may put Winger to sleep. */
    private void paintSleep() {
        if (sleepSwitch == null) return;
        boolean at = Apps.keepAwake(this), free = batteryFree();
        sleepSwitch.setChecked(at);
        sub(sleepSub, !at ? "Во сне связь может засыпать" : free ? "Связь не рвётся во сне" : "Android может усыплять — нажмите, чтобы разрешить");
        sleepSub.setTextColor(at && !free ? amberText : text2);
    }

    private void sleepTapped() {
        if (Apps.keepAwake(this) && !batteryFree()) {  // on, but Android may still cut it: allow it, or switch it off
            new AlertDialog.Builder(this).setTitle("Работать при выключенном экране")
                    .setMessage("Включено, но Android всё ещё может усыплять Winger. Разрешите ему работать без ограничений "
                            + "батареи — или выключите эту настройку.")
                    .setPositiveButton("Разрешить", (d, w) -> askBattery())
                    .setNegativeButton("Выключить", (d, w) -> {
                        Apps.setKeepAwake(this, false);
                        paintSleep();
                    })
                    .setNeutralButton("Отмена", null).show();
            return;
        }
        boolean at = !Apps.keepAwake(this);
        Apps.setKeepAwake(this, at);
        paintSleep();
        if (at && !batteryFree()) askBattery();
    }

    /** Android's own question: Winger without battery saving (a VPN that must not sleep). */
    private void askBattery() {
        try {
            startActivity(new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    android.net.Uri.parse("package:" + getPackageName())));
            Toast.makeText(this, "Нажмите «Разрешить»: иначе Android во сне отключает интернет у Winger", Toast.LENGTH_LONG).show();
        } catch (RuntimeException e) {  // a phone without that screen: its list of apps instead
            try {
                startActivity(new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                Toast.makeText(this, "Найдите Winger и выберите «Не экономить» / «Без ограничений»", Toast.LENGTH_LONG).show();
            } catch (RuntimeException ignored) {
                Toast.makeText(this, "Откройте Настройки → Батарея → Winger → «Без ограничений»", Toast.LENGTH_LONG).show();
            }
        }
    }

    /** A heading over a list («Подключение», «Настройки»). */
    private TextView section(String name) {
        TextView h = label(name, wide ? 20 : 17, text, semibold);
        h.setGravity(Gravity.START);
        h.setPadding(dp(4), 0, dp(4), 0);
        return h;
    }

    private LinearLayout.LayoutParams sectionParams() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = dp(22);
        lp.bottomMargin = dp(10);
        return lp;
    }

    /** One rounded list for rows, with a hairline edge (a press's ripple stays inside its corners). */
    private LinearLayout list() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setBackground(round(surf, 20, line));
        l.setClipToOutline(true);
        return l;
    }

    /** A row into a list, a thin line above it when it is not the first. */
    private void addTo(LinearLayout list, View row) {
        if (list.getChildCount() > 0) {
            View sep = new View(this);
            sep.setBackgroundColor(line);
            list.addView(sep, new LinearLayout.LayoutParams(-1, Math.max(1, dp(1))));
        }
        list.addView(row, new LinearLayout.LayoutParams(-1, -2));
    }

    /** A row's start, the same on every list and on Windows: its sign in a round well, its name, and under the name what
     *  it is now (a second line, so nothing is cut on a narrow phone). */
    private LinearLayout row(int icon, String name, TextView sub) {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setPadding(dp(16), dp(10), dp(14), dp(10));
        r.setMinimumHeight(dp(60));
        r.setBackground(press(round(0x00000000, 0, 0), 0));
        r.addView(well(icon), new LinearLayout.LayoutParams(dp(38), dp(38)));
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        TextView n = label(name, wide ? 17 : 16, text, medium);  // (a little larger on a tablet)
        n.setGravity(Gravity.START);
        n.setMaxLines(2);
        col.addView(n, new LinearLayout.LayoutParams(-1, -2));
        if (sub != null) {
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
            lp.topMargin = dp(1);
            col.addView(sub, lp);
        }
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(0, -2, 1f);
        cp.leftMargin = dp(14);
        r.addView(col, cp);
        return r;
    }

    /** A settings row that opens something: the row's start and ›. */
    private LinearLayout setting(int icon, String name, TextView sub, View.OnClickListener click) {
        LinearLayout r = row(icon, name, sub);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(20), dp(20));
        lp.leftMargin = dp(8);
        r.addView(icon(R.drawable.i_chev, text2), lp);
        r.setOnClickListener(click);
        return r;
    }

    /** A settings row that is on or off: the row's start and a switch (the whole row switches it). */
    private LinearLayout switchRow(int icon, String name, TextView sub, android.widget.Switch sw, View.OnClickListener click) {
        LinearLayout r = row(icon, name, sub);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
        lp.leftMargin = dp(8);
        r.addView(sw, lp);
        r.setOnClickListener(click);
        r.setAccessibilityDelegate(new View.AccessibilityDelegate() {
            @Override
            public void onInitializeAccessibilityNodeInfo(View host, android.view.accessibility.AccessibilityNodeInfo info) {
                super.onInitializeAccessibilityNodeInfo(host, info);
                info.setClassName(android.widget.Switch.class.getName());
                info.setCheckable(true);
                info.setChecked(sw.isChecked());
            }
        });
        return r;
    }

    /** The platform's own switch in the family's colours: on — the «включено» green (darker by day, for contrast). */
    private android.widget.Switch toggleView() {
        android.widget.Switch s = new android.widget.Switch(this);
        s.setClickable(false);  // the row switches it (and says so to TalkBack)
        s.setFocusable(false);
        s.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        int[][] states = {{android.R.attr.state_checked}, {}};
        s.setThumbTintList(new ColorStateList(states, new int[]{accent, dark ? text2 : 0xFFFFFFFF}));
        s.setTrackTintList(new ColorStateList(states, new int[]{(accent & 0x00FFFFFF) | 0x80000000, lineStrong}));
        return s;
    }

    /** A sign in its round well (the colour of the connection's state, for a connection's row). */
    private FrameLayout well(int icon) {
        FrameLayout w = new FrameLayout(this);
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(well);
        w.setBackground(g);
        w.addView(icon(icon, cyan), new FrameLayout.LayoutParams(dp(22), dp(22), Gravity.CENTER));
        return w;
    }

    /** One of Winger's icons (24 grid, stroke 1.8: the same set as on Windows), in a colour. */
    private ImageView icon(int res, int color) {
        ImageView v = new ImageView(this);
        v.setImageResource(res);
        v.setImageTintList(ColorStateList.valueOf(color));
        v.setScaleType(ImageView.ScaleType.FIT_CENTER);
        v.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        return v;
    }

    /** A row's second line: grey, up to three lines; hidden while it has nothing to say. */
    private TextView subLabel() {
        TextView t = label("", 14, text2, regular);
        t.setGravity(Gravity.START);
        t.setMaxLines(3);
        t.setEllipsize(android.text.TextUtils.TruncateAt.END);
        t.setVisibility(View.GONE);
        return t;
    }

    private static void sub(TextView v, CharSequence s) {
        if (!s.toString().contentEquals(v.getText())) v.setText(s);
        v.setVisibility(s.length() == 0 ? View.GONE : View.VISIBLE);
    }

    /** A button (DESIGN.md: 16 corners, 48 tall): filled with the accent (the one thing to do), or a line one. */
    private LinearLayout pill(int icon, String s, boolean filled, View.OnClickListener click) {
        LinearLayout b = new LinearLayout(this);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(18), 0, dp(18), 0);
        b.setBackground(press(round(filled ? accent : surf, 16, filled ? 0 : lineStrong), 16));
        b.addView(icon(icon, filled ? accentInk : cyan), new LinearLayout.LayoutParams(dp(20), dp(20)));
        TextView t = label(s, 16, filled ? accentInk : text, semibold);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
        lp.leftMargin = dp(10);
        b.addView(t, lp);
        b.setOnClickListener(click);
        return b;
    }

    /** «Добавить подключение»: from a QR code, a link, or a QR code in a picture. */
    private void addMenu() {
        String[] ways = {"Сканировать QR-код", "Вставить ссылку", "QR-код из картинки или скриншота"};
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
        if (!has) hint.setVisibility(View.GONE);  // (with connections: showConns says what a tap does, when it is worth saying)
        firstAdd.setVisibility(has ? View.GONE : View.VISIBLE);
        setRow(appsCard, has);
        boolean bridges = false;
        if (has) for (Profile x : Profile.all(this)) bridges |= x.bridge;
        setRow(bridgeAppsCard, bridges);
        setRow(addRow, has);
        boolean owner = Rescue.shown(this);  // the family server said this phone's login is the owner's
        setRow(rescueRow, owner);
        setRow(checkRow, owner);
        setRow(journalRow, owner);  // the owner's only (everyone's journal still goes to the server by itself)
        sub(checkVal, BridgeCheck.running.get() ? "идёт…" : "");
        boolean canScout = false;  // two ways or more, one of them a bridge to look at (VK is not), and Winger off
        for (Profile x : Profile.all(this)) canScout |= x.bridge && !"vk".equals(x.platformOrDefault());
        setRow(scoutRow, canScout && Profile.all(this).size() > 1 && (State.phase == State.Phase.OFF || quickAsked > 0));
        java.util.regex.Matcher pm = java.util.regex.Pattern.compile("\\((\\d+ из \\d+)\\)").matcher(BridgeCheck.progress);
        String sv = quickAsked > 0 && BridgeCheck.running.get() ? (pm.find() ? pm.group(1) : "идёт…") : "";
        sub(scoutVal, sv);
        if (quickAsked > 0 && BridgeCheck.quickAt > quickAsked && !BridgeCheck.running.get()) {
            quickAsked = 0;
            scoutSaid();
        } else if (quickAsked > 0 && System.currentTimeMillis() - quickAsked > 10 * 60_000L) {
            quickAsked = 0;  // it never started (another check was running): nothing to tell
        }
        if (checkAsked && BridgeCheck.fresh && !BridgeCheck.running.get()) {
            checkAsked = false;
            showCheck();
        }
        if (has) {
            showConns(all);
            sub(appsName, Apps.summary(this, false));
            sub(bridgeAppsName, Apps.summary(this, true));
        }
        String st, dt;
        switch (State.phase) {
            case ON:
                st = "Защищено";
                dt = "Включено " + since() + " · ↓\u00a0" + rate(State.downRate) + " · ↑\u00a0" + rate(State.upRate);
                status.setTextColor(onText);
                break;
            case CONNECTING:
                st = "Подключаюсь…";
                dt = State.note.isEmpty() ? "Это занимает несколько секунд" : State.note;
                status.setTextColor(amberText);
                break;
            case RETRYING:
                st = "Переподключаюсь…";
                dt = State.note;
                status.setTextColor(amberText);
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
        detail.setTextColor(State.phase == State.Phase.OFF && !State.note.isEmpty() ? bad : text2);
        if (State.phase == State.Phase.OFF) {
            ping.setVisibility(View.INVISIBLE);
        } else {
            ping.setVisibility(View.VISIBLE);
            int ms = State.pingMs, look;  // 1 checking, 2 good, 3 slow, 4 no answer or bad
            String t;
            if (ms < 0) {
                t = "Отклик: проверяю…";
                look = 1;
            } else if (ms == 0) {
                t = "Отклик: нет ответа";
                look = 4;
            } else {
                t = "Отклик " + ms + " мс";
                look = ms < 150 ? 2 : ms < 400 ? 3 : 4;
            }
            if (!t.contentEquals(ping.getText())) ping.setText(t);
            if (look != pingLook) {  // its colours: the «включено» green when good, amber when slow, red when bad
                pingLook = look;
                int fg = look == 1 ? text2 : look == 2 ? onText : look == 3 ? amberText : bad;
                int bg = look == 1 ? well : look == 2 ? onTint : look == 3 ? (amber & 0x00FFFFFF) | (dark ? 0x29000000 : 0x59000000)
                        : (bad & 0x00FFFFFF) | 0x24000000;
                ping.setTextColor(fg);
                ping.setBackground(press(round(bg, 16, 0), 16));
            }
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
        // (v37) the first time on: Android's battery saving off for Winger, asked once (else a sleeping phone loses it)
        if (Apps.keepAwake(this) && !batteryFree() && !getSharedPreferences("vpn", MODE_PRIVATE).getBoolean("askedBattery", false)) {
            getSharedPreferences("vpn", MODE_PRIVATE).edit().putBoolean("askedBattery", true).apply();
            ticker.postDelayed(this::askBattery, 1500);
        }
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
            boolean renewed = f != null && Profile.renew(this, f.auth, f, null, null, null);
            Profile now = Profile.chosen(this);
            Diag.i(this, "renew: " + renewed + " · chosen «" + (now == null ? "" : now.name) + "» " + (now == null ? "" : now.link.contains("moved=1")));
            changed();
        }
        String testDoor = BuildConfig.DEBUG ? i.getStringExtra("test_door") : null;  // the emulator test only
        if (testDoor != null) {  // the server's answer for the login of this link (v39: no extra doors any more)
            Profile f = Profile.chosen(this), door = Profile.parse(testDoor);
            int before = Profile.all(this).size();
            if (f != null && door != null) BridgeSync.take(this, door.auth, f, null);
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
        if (BuildConfig.DEBUG && i.hasExtra("test_white")) {  // (the test) a white-list made or undone; nothing «tapped by hand»
            Scout.testWhite(i.getBooleanExtra("test_white", false));  // just now (a tap a step before would be tried first)
            VpnSvc.picked(null);
        }
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
        boolean quick = BridgeCheck.QUICK.equals(task);
        if (quick) quickAsked = System.currentTimeMillis();
        else checkAsked |= mine;
        Intent s = new Intent(this, CheckSvc.class).putExtra(CheckSvc.TASK, task == null ? "" : task);
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(s);
            else startService(s);
        } catch (RuntimeException e) {
            Diag.w(this, "bridge check start", e);
            return;
        }
        if (mine) Toast.makeText(this, quick ? "Проверяю, какие подключения работают здесь — 1–3 минуты"
                : "Проверяю мосты — несколько минут, ход в уведомлении", Toast.LENGTH_LONG).show();
        changed();
    }

    /** (v32) What the quick look found, in one line: which carry here and which do not. */
    private void scoutSaid() {
        List<String> yes = new ArrayList<>(), no = new ArrayList<>();
        for (Profile p : Profile.all(this)) {
            Boolean c = Scout.carries(this, p);
            if (c != null) (c ? yes : no).add("«" + p.name + "»");
        }
        String t = yes.isEmpty() ? "Здесь сейчас не работает ни одно подключение — попробуйте позже или другую сеть"
                : "Работают здесь: " + android.text.TextUtils.join(", ", yes)
                + (no.isEmpty() ? "" : ". Не работают: " + android.text.TextUtils.join(", ", no));
        Diag.i(this, "quick look: " + yes.size() + " carry here, " + no.size() + " do not");
        Toast.makeText(this, t, Toast.LENGTH_LONG).show();
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

    /** «45 Мбит/с», «3,1 Мбит/с», «0,4 Мбит/с». */
    private static String mbit(double mb) {
        return (mb >= 10 ? String.valueOf(Math.round(mb)) : String.format(Locale.ROOT, "%.1f", mb).replace('.', ',')) + " Мбит/с";
    }

    /** A bridge's service, short: «Телемост», «WB Stream», «DION», «Битрикс24», «VK». */
    private static String platformName(Profile p) {
        return "telemost".equals(p.platformOrDefault()) ? "Телемост" : VpnSvc.service(p);
    }

    /** The connections' rows: made again only when the list changes; their well, line and state follow the VPN. Each row
     *  (the same as on Windows): its sign in a well (the «включено» green when it is the one in use, amber while it
     *  connects, a ring when it is the chosen one), its name, under it what it is doing now or whether it carries here, in
     *  words, with its response time and speed; and «⋯» — its speed, or removing it. A long press removes it too. */
    private void showConns(List<Profile> all) {
        StringBuilder key = new StringBuilder();
        for (Profile p : all) key.append(p.bridge ? "b|" : "s|").append(p.name).append('\n');
        if (!key.toString().equals(connsKey)) {
            connsKey = key.toString();
            if (menu != null) menu.dismiss();
            conns.removeAllViews();
            connRows.clear();
            connNotes.clear();
            connWells.clear();
            for (int i = 0; i < all.size(); i++) {
                Profile p = all.get(i);
                int at = i;
                LinearLayout row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setGravity(Gravity.CENTER_VERTICAL);
                row.setPadding(dp(16), dp(10), dp(4), dp(10));
                row.setMinimumHeight(dp(68));
                GradientDrawable tint = round(0x00000000, 0, 0);  // the selected tint, on the row in use
                row.setBackground(press(tint, 0));
                row.setTag(tint);
                row.setOnClickListener(v -> {
                    v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
                    use(at);
                });
                row.setOnLongClickListener(v -> {
                    remove(Profile.all(this), at);
                    return true;
                });
                FrameLayout w = well(p.bridge ? R.drawable.i_phone : R.drawable.i_server);  // a bridge: through a call
                row.addView(w, new LinearLayout.LayoutParams(dp(40), dp(40)));
                LinearLayout col = new LinearLayout(this);
                col.setOrientation(LinearLayout.VERTICAL);
                TextView name = label(p.name, wide ? 17 : 16, text, medium);
                name.setGravity(Gravity.START);
                name.setSingleLine(true);
                name.setEllipsize(android.text.TextUtils.TruncateAt.END);
                col.addView(name, new LinearLayout.LayoutParams(-1, -2));
                TextView note = label("", 14, text2, regular);
                note.setGravity(Gravity.START);
                note.setMaxLines(2);
                note.setEllipsize(android.text.TextUtils.TruncateAt.END);
                LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(-1, -2);
                np.topMargin = dp(1);
                col.addView(note, np);
                LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(0, -2, 1f);
                cp.leftMargin = dp(14);
                row.addView(col, cp);
                // «⋯»: its speed, or removing it (in plain sight, not only under a long press)
                ImageView more = icon(R.drawable.i_dots, text2);
                more.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
                more.setPadding(dp(12), dp(12), dp(12), dp(12));
                more.setBackground(press(round(0x00000000, 24, 0), 24));
                more.setContentDescription("Скорость или удалить «" + p.name + "»");
                more.setOnClickListener(v -> rowMenu(v, at));
                row.addView(more, new LinearLayout.LayoutParams(dp(48), dp(48)));
                addTo(conns, row);
                connRows.add(row);
                connNotes.add(note);
                connWells.add(w);
            }
        }
        int cur = Math.max(0, Math.min(Profile.current(this), all.size() - 1));
        int act = activeIndex(all);
        boolean on = State.phase != State.Phase.OFF;
        for (int i = 0; i < connRows.size() && i < all.size(); i++) {
            Profile p = all.get(i);
            String chip = "";
            int chipColor = onText, look = 0;  // 0 plain, 1 the chosen one (its well tinted), 2 in use (on), 3 connecting
            if (on && i == act && State.phase == State.Phase.ON) {
                chip = State.auto ? "Включено само" : "Включено";
                look = 2;
            } else if (on && i == act) {
                chip = State.phase == State.Phase.CONNECTING ? "Подключаюсь…" : "Переподключаюсь…";
                chipColor = amberText;
                look = 3;
            } else if (on && i == cur) {
                chip = "Не отвечает";
                chipColor = amberText;
                look = 1;
            } else if (i == cur) {
                look = 1;
            }
            Boolean here = chip.isEmpty() ? Scout.carries(this, p) : null;  // (v32) what this network said lately: words, no numbers
            if (here != null) {
                chip = here ? "Работает здесь" : "Здесь не работает";
                chipColor = here ? onText : text2;
            }
            // its line under the name (the name is never cut for it): what it is doing now, its response time (in the colour
            // of how good it is) and its speed — live for the one in use, the others' from the last minutes (v33); when there
            // are no numbers, whether it carries here, or what it is
            boolean live = on && i == act && State.phase == State.Phase.ON;
            org.json.JSONObject seen = Scout.seen(this, p);
            boolean carries = Boolean.TRUE.equals(here);
            int ms = live ? State.pingMs : carries && seen != null ? seen.optInt("ms") : 0;
            double mb = live || carries || chip.isEmpty() ? Speed.mbps(this, p) : -1;  // (not for one that does not answer)
            if (carries && ms > 0) chip = "";  // its numbers say it carries
            String pingText = ms > 0 ? ms + " мс" : "", speedText = mb > 0 ? mbit(mb) : "";
            String what = p.bridge ? platformName(p) : "сервер";
            if (p.bridge && p.name.toLowerCase(Locale.ROOT).contains(what.toLowerCase(Locale.ROOT))) what = "";  // «Мост · Телемост»: said
            List<String> parts = new ArrayList<>();
            if (!chip.isEmpty()) parts.add(chip);
            if (!pingText.isEmpty()) parts.add(pingText);
            if (!speedText.isEmpty()) parts.add(speedText);
            if (parts.isEmpty()) parts.add(p.bridge ? "мост" + (what.isEmpty() ? "" : " · " + what) : what);
            else if (pingText.isEmpty() && speedText.isEmpty() && !what.isEmpty()) parts.add(what);
            String note = android.text.TextUtils.join(" · ", parts);
            TextView n = connNotes.get(i);
            if (!note.contentEquals(n.getText())) {
                Log.i("AIVPN", "button «" + p.name + "»: " + note);
                android.text.SpannableString styled = new android.text.SpannableString(note);
                if (!chip.isEmpty()) {
                    styled.setSpan(new android.text.style.ForegroundColorSpan(chipColor), 0, chip.length(), 0);
                    styled.setSpan(new Face(semibold), 0, chip.length(), 0);
                }
                int at = pingText.isEmpty() ? -1 : note.indexOf(pingText);
                if (at >= 0) {
                    int c = ms < 150 ? onText : ms < 400 ? amberText : bad;  // (as the response time at the top)
                    styled.setSpan(new android.text.style.ForegroundColorSpan(c), at, at + pingText.length(), 0);
                    styled.setSpan(new Face(semibold), at, at + pingText.length(), 0);
                }
                n.setText(styled);
            }
            FrameLayout w = connWells.get(i);
            Object was = w.getTag();
            if (was == null || (Integer) was != look) {  // drawn again only when it changes (DESIGN.md: a selected thing
                w.setTag(look);                          // changes fill, never its border)
                GradientDrawable g = (GradientDrawable) w.getBackground();
                // (this.on: the colour; on here is «the VPN is on»)
                g.setColor(look == 2 ? this.on : look == 3 ? amber : look == 1 ? onTint : well);
                ((ImageView) w.getChildAt(0)).setImageTintList(ColorStateList.valueOf(
                        look == 2 ? onInk : look == 3 ? amberInk : look == 1 ? onText : cyan));
                ((GradientDrawable) connRows.get(i).getTag()).setColor(look == 2 ? onTint : 0x00000000);  // the row in use: tinted
                n.setTextColor(look == 2 ? onText : text2);  // and its second line in the accent («Включено · 17 мс»)
                n.setTypeface(look == 2 ? medium : regular);
            }
        }
        // what a tap does, said once under the list (and why another one is on by itself)
        String h = State.auto && State.phase == State.Phase.ON ? "Выбранное подключение не отвечает — Winger включил другое сам."
                : on ? "Нажмите на включённое — выключить, на другое — перейти на него."
                : all.size() > 1 ? "Нажмите на подключение — Winger включится через него." : "";
        if (!h.contentEquals(hint.getText())) hint.setText(h);
        hint.setVisibility(h.isEmpty() ? View.GONE : View.VISIBLE);
    }

    /** «⋯» on a connection's row: a small menu by it — its speed, or removing it. */
    private void rowMenu(View anchor, int at) {
        if (menu != null) menu.dismiss();
        List<Profile> all = Profile.all(this);
        if (at >= all.size()) return;
        Profile p = all.get(at);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(0, dp(6), 0, dp(6));
        int width = dp(236);
        android.widget.PopupWindow pw = new android.widget.PopupWindow(box, width, ViewGroup.LayoutParams.WRAP_CONTENT, true);
        box.addView(menuItem(R.drawable.i_speed, "Скорость", text, cyan, () -> {
            pw.dismiss();
            speed(p);
        }));
        box.addView(menuItem(R.drawable.i_trash, "Удалить", bad, bad, () -> {
            pw.dismiss();
            remove(Profile.all(this), at);
        }));
        pw.setBackgroundDrawable(round(surf2, 16, line));
        pw.setElevation(dp(12));
        pw.setOutsideTouchable(true);
        pw.setOnDismissListener(() -> {
            if (menu == pw) menu = null;
        });
        menu = pw;
        pw.showAsDropDown(anchor, anchor.getWidth() - width - dp(4), -dp(8));
    }

    private LinearLayout menuItem(int icon, String s, int color, int iconColor, Runnable click) {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setPadding(dp(18), 0, dp(18), 0);
        r.setMinimumHeight(dp(52));
        r.setBackground(press(round(0x00000000, 0, 0), 0));
        r.addView(icon(icon, iconColor), new LinearLayout.LayoutParams(dp(22), dp(22)));
        TextView t = label(s, 16, color, medium);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, -2, 1f);
        lp.leftMargin = dp(14);
        t.setGravity(Gravity.START);
        r.addView(t, lp);
        r.setOnClickListener(v -> click.run());
        return r;
    }

    /** A part of a line in another weight of the family's face (any Android: no TypefaceSpan(Typeface) needed). */
    private static final class Face extends android.text.style.MetricAffectingSpan {
        private final Typeface face;

        Face(Typeface face) {
            this.face = face;
        }

        @Override
        public void updateDrawState(android.text.TextPaint p) {
            p.setTypeface(face);
        }

        @Override
        public void updateMeasureState(android.text.TextPaint p) {
            p.setTypeface(face);
        }
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
        VpnSvc.picked(Profile.all(this).get(at).link);  // (v34) chosen by hand: tried first even if it did not carry here lately
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
        Toast.makeText(this, "Проверяю скорость «" + p.name + "»… около 10 секунд", Toast.LENGTH_SHORT).show();
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

    /** Text in the family's face (Onest), in sp: it follows the phone's own text size. */
    private TextView label(String s, int sp, int color, Typeface face) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        t.setTypeface(face);
        t.setIncludeFontPadding(false);
        t.setLineSpacing(0, 1.12f);
        return t;
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
        return new RippleDrawable(ColorStateList.valueOf(getColor(R.color.ripple)), bg, mask);
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
