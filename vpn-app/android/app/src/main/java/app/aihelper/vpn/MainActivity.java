package app.aihelper.vpn;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.content.res.ColorStateList;
import android.net.VpnService;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

import java.util.List;

/** One screen: the big button, how the connection is, the server, and adding a server from a QR code or a link. */
public class MainActivity extends Activity implements State.Listener {
    private static final int REQ_VPN = 1, REQ_IMAGE = 2, REQ_NOTIFY = 3;
    private boolean dark;
    private int text, muted, card, accent;
    private PowerButton power;
    private AuroraView aurora;
    private AvatarView avatar;
    private TextView status, detail, ping, serverName, serverChange, appsName;
    private LinearLayout serverCard, appsCard;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        text = dark ? 0xFFF3F4F6 : 0xFF111827;
        muted = dark ? 0xFF9CA3AF : 0xFF6B7280;
        card = dark ? 0xE01A2029 : 0xEBFFFFFF;  // cards let the aurora shine through a little
        accent = dark ? 0xFF34D399 : 0xFF0E9F6E;
        build();
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
        root.setPadding(dp(20), dp(28), dp(20), dp(20));
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        frame.addView(root, new FrameLayout.LayoutParams(-1, -1));

        // the name: the owner's living portrait (or the shield), «Winger» in the aurora's colours, whose VPN it is
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        avatar = new AvatarView(this);
        head.addView(avatar, new LinearLayout.LayoutParams(dp(68), dp(68)));
        LinearLayout names = new LinearLayout(this);
        names.setOrientation(LinearLayout.VERTICAL);
        names.setPadding(dp(12), 0, 0, 0);
        TextView title = label(getString(R.string.brand), 28, text, true);
        title.setGravity(Gravity.START);
        title.getPaint().setShader(new android.graphics.LinearGradient(0, 0, dp(130), 0,
                new int[]{0xFF22D3EE, 0xFF6366F1, 0xFFA855F7}, null, android.graphics.Shader.TileMode.CLAMP));
        title.setLetterSpacing(0.02f);
        names.addView(title, new LinearLayout.LayoutParams(-2, -2));
        TextView sub = label(getString(R.string.full_name), 14, muted, false);
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
        root.addView(power, new LinearLayout.LayoutParams(dp(230), dp(230)));

        status = label("", 24, text, true);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
        lp.topMargin = dp(18);
        root.addView(status, lp);
        detail = label("", 15, muted, false);
        detail.setGravity(Gravity.CENTER);
        lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = dp(6);
        root.addView(detail, lp);

        ping = label("", 15, text, true);
        ping.setPadding(dp(16), dp(8), dp(16), dp(8));
        ping.setOnClickListener(v -> {
            if (State.phase == State.Phase.ON) {
                ping.setText("Проверяю отклик…");
                startService(new Intent(this, VpnSvc.class).setAction(VpnSvc.PING));
            }
        });
        lp = new LinearLayout.LayoutParams(-2, -2);
        lp.topMargin = dp(14);
        root.addView(ping, lp);
        root.addView(new View(this), new LinearLayout.LayoutParams(1, 0, 1f));

        serverCard = new LinearLayout(this);
        serverCard.setOrientation(LinearLayout.HORIZONTAL);
        serverCard.setGravity(Gravity.CENTER_VERTICAL);
        serverCard.setPadding(dp(18), dp(14), dp(18), dp(14));
        serverCard.setBackground(press(round(card, 18, 0), 18));
        serverCard.setOnClickListener(v -> choose());
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.addView(label("Сервер", 13, muted, false), new LinearLayout.LayoutParams(-2, -2));
        serverName = label("", 17, text, true);
        serverName.setSingleLine(true);
        col.addView(serverName, new LinearLayout.LayoutParams(-2, -2));
        serverCard.addView(col, new LinearLayout.LayoutParams(0, -2, 1f));
        serverChange = label("Сменить", 15, accent, true);
        serverCard.addView(serverChange, new LinearLayout.LayoutParams(-2, -2));
        lp = new LinearLayout.LayoutParams(-1, -2);
        lp.bottomMargin = dp(8);
        root.addView(serverCard, lp);

        // which apps go through it: by default only Instagram, Telegram, YouTube… — the rest straight, as without a VPN
        appsCard = new LinearLayout(this);
        appsCard.setOrientation(LinearLayout.HORIZONTAL);
        appsCard.setGravity(Gravity.CENTER_VERTICAL);
        appsCard.setPadding(dp(18), dp(10), dp(18), dp(10));
        appsCard.setBackground(press(round(card, 18, 0), 18));
        appsCard.setOnClickListener(v -> chooseApps());
        col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.addView(label("Через VPN", 13, muted, false), new LinearLayout.LayoutParams(-2, -2));
        appsName = label("", 15, text, true);
        appsName.setSingleLine(true);
        appsName.setEllipsize(android.text.TextUtils.TruncateAt.END);
        col.addView(appsName, new LinearLayout.LayoutParams(-2, -2));
        appsCard.addView(col, new LinearLayout.LayoutParams(0, -2, 1f));
        appsCard.addView(label("Изменить", 15, accent, true), new LinearLayout.LayoutParams(-2, -2));
        lp = new LinearLayout.LayoutParams(-1, -2);
        lp.bottomMargin = dp(12);
        root.addView(appsCard, lp);

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
        root.addView(row, new LinearLayout.LayoutParams(-1, -2));
        TextView fromImage = label("🖼  QR-код из картинки или скриншота", 15, muted, false);
        fromImage.setPadding(dp(12), dp(14), dp(12), dp(4));
        fromImage.setOnClickListener(v -> pickImage());
        root.addView(fromImage, new LinearLayout.LayoutParams(-2, -2));
        setContentView(frame);
        // the screen comes in softly: each part rises into place, one after another
        for (int i = 0; i < root.getChildCount(); i++) {
            View v = root.getChildAt(i);
            v.setAlpha(0f);
            v.setTranslationY(dp(18));
            v.animate().alpha(1f).translationY(0).setStartDelay(80L + i * 45L).setDuration(420)
                    .setInterpolator(new android.view.animation.DecelerateInterpolator()).start();
        }
    }

    @Override
    public void changed() {
        Profile p = Profile.chosen(this);
        List<Profile> all = Profile.all(this);
        boolean has = p != null;
        power.show(State.phase, has);
        aurora.show(State.phase);
        serverCard.setVisibility(has ? View.VISIBLE : View.GONE);
        appsCard.setVisibility(has ? View.VISIBLE : View.GONE);
        if (has) {
            serverName.setText(p.name);
            serverChange.setText(all.size() > 1 ? "Сменить" : "⋯");
            appsName.setText(Apps.summary(this));
        }
        String st, dt;
        switch (State.phase) {
            case ON:
                st = "Защищено";
                dt = "Включено " + since() + "\n↓\u00a0" + rate(State.downRate) + "   ↑\u00a0" + rate(State.upRate);
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
            ping.setText("●  " + t);
            ping.setTextColor(color);
            ping.setBackground(press(round(card, 20, (color & 0x00FFFFFF) | 0x55000000), 20));
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
        String testApps = BuildConfig.DEBUG ? i.getStringExtra("test_apps") : null;  // the emulator test only
        if (testApps != null) {
            Apps.setOnlyChosen(this, true);
            for (String pkg : testApps.split(",")) Apps.choose(this, pkg.trim(), true);
            appsChanged();
        }
        if (BuildConfig.DEBUG && i.getBooleanExtra("test_connect", false)) connect();   // the emulator test only
        if (BuildConfig.DEBUG && i.getBooleanExtra("test_install", false)) Updater.testInstall(this);
        if (BuildConfig.DEBUG && i.getBooleanExtra("test_disconnect", false)) {
            startService(new Intent(this, VpnSvc.class).setAction(VpnSvc.STOP));
        }
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
        Toast.makeText(this, "Добавлен сервер «" + p.name + "»", Toast.LENGTH_SHORT).show();
        if (was) start();  // it was on: go on with the new server
        changed();
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

    private void choose() {
        List<Profile> all = Profile.all(this);
        if (all.isEmpty()) return;
        String[] names = new String[all.size()];
        for (int i = 0; i < names.length; i++) names[i] = all.get(i).name;
        int cur = Math.max(0, Math.min(Profile.current(this), all.size() - 1));
        int[] picked = {cur};
        new AlertDialog.Builder(this)
                .setTitle("Сервер")
                .setSingleChoiceItems(names, cur, (d, w) -> picked[0] = w)
                .setPositiveButton("Готово", (d, w) -> {
                    if (picked[0] == cur) return;
                    Profile.select(this, picked[0]);
                    if (State.phase != State.Phase.OFF) start();
                    changed();
                })
                .setNeutralButton("Удалить", (d, w) -> remove(all, picked[0]))
                .setNegativeButton("Отмена", null)
                .show();
    }

    private void remove(List<Profile> all, int i) {
        new AlertDialog.Builder(this)
                .setMessage("Удалить сервер «" + all.get(i).name + "» из приложения?")
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

    private void chooseApps() {
        String[] modes = {
                "Только нужные: Instagram, Telegram, YouTube… Банки, Госуслуги, маркетплейсы — напрямую",
                "Все приложения"};
        boolean only = Apps.onlyChosen(this);
        int[] picked = {only ? 0 : 1};
        new AlertDialog.Builder(this)
                .setTitle("Что пускать через VPN")
                .setSingleChoiceItems(modes, picked[0], (d, w) -> picked[0] = w)
                .setPositiveButton("Готово", (d, w) -> {
                    if ((picked[0] == 0) == only) return;
                    Apps.setOnlyChosen(this, picked[0] == 0);
                    appsChanged();
                })
                .setNeutralButton("Какие приложения", (d, w) -> pickApps())
                .setNegativeButton("Отмена", null)
                .show();
    }

    private void pickApps() {
        List<String> here = Apps.installed(this);
        if (here.isEmpty()) {
            new AlertDialog.Builder(this)
                    .setTitle("Через VPN")
                    .setMessage("На телефоне пока нет ни Instagram, ни Telegram, ни YouTube и других таких приложений. "
                            + "Установите нужное — оно само пойдёт через VPN. А пока через VPN идут все приложения.")
                    .setPositiveButton("Понятно", null)
                    .show();
            return;
        }
        String[] names = new String[here.size()];
        boolean[] on = new boolean[here.size()];
        for (int i = 0; i < names.length; i++) {
            names[i] = Apps.KNOWN.get(here.get(i));
            on[i] = Apps.chosen(this, here.get(i));
        }
        new AlertDialog.Builder(this)
                .setTitle("Через VPN — только эти")
                .setMultiChoiceItems(names, on, (d, w, checked) -> on[w] = checked)
                .setPositiveButton("Готово", (d, w) -> {
                    for (int i = 0; i < names.length; i++) Apps.choose(this, here.get(i), on[i]);
                    Apps.setOnlyChosen(this, true);
                    appsChanged();
                })
                .setNegativeButton("Отмена", null)
                .show();
    }

    /** Takes effect at once: when on, the tunnel is opened again with the new list. */
    private void appsChanged() {
        changed();
        if (State.phase == State.Phase.OFF) return;
        Intent i = new Intent(this, VpnSvc.class).setAction(VpnSvc.START).putExtra("again", true);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
        else startService(i);
        Toast.makeText(this, "Готово: " + Apps.summary(this), Toast.LENGTH_SHORT).show();
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
