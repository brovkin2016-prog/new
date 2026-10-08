package app.aihelper.vpn;

import android.app.PendingIntent;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.net.VpnService;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/** The tile in the phone's shade: Winger on or off without opening the app, through the connection chosen in it. */
public final class VpnTile extends TileService implements State.Listener {
    @Override
    public void onStartListening() {
        State.listen(this);
        changed();
    }

    @Override
    public void onStopListening() {
        State.unlisten(this);
    }

    @Override
    public void changed() {
        Tile t = getQsTile();
        if (t == null) return;
        Profile p = Profile.chosen(this);
        State.Phase ph = State.phase;
        t.setState(p == null ? Tile.STATE_UNAVAILABLE : ph == State.Phase.OFF ? Tile.STATE_INACTIVE : Tile.STATE_ACTIVE);
        t.setLabel(getString(R.string.brand));
        t.setIcon(Icon.createWithResource(this, R.drawable.ic_stat));
        if (Build.VERSION.SDK_INT >= 29) {
            String now = p == null ? "добавьте подключение" : p.name;
            if (ph == State.Phase.ON) {
                for (Profile x : Profile.all(this)) if (x.link.equals(State.activeLink)) now = x.name;
            } else if (ph != State.Phase.OFF) {
                now = "подключаюсь…";
            }
            t.setSubtitle(now);
        }
        t.updateTile();
    }

    @Override
    public void onClick() {
        if (State.phase != State.Phase.OFF) {
            startService(new Intent(this, VpnSvc.class).setAction(VpnSvc.STOP));
            return;
        }
        // no connection yet, or Android has not been asked about the VPN: the app does it, with its own questions
        if (Profile.chosen(this) == null || VpnService.prepare(this) != null) {
            openApp();
            return;
        }
        Intent i = new Intent(this, VpnSvc.class).setAction(VpnSvc.START);
        try {
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
            else startService(i);
        } catch (RuntimeException e) {
            openApp();  // the phone does not let it start from here: the app switches it on
        }
    }

    @SuppressWarnings("deprecation")
    private void openApp() {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra("connect", true);
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 3, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        } else {
            startActivityAndCollapse(i);
        }
    }
}
