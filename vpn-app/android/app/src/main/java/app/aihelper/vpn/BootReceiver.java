package app.aihelper.vpn;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;

/** After a reboot (or an update of the app) the VPN comes back by itself, unless it was switched off by hand. */
public final class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        String a = i.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(a)) return;
        if (!Apps.keepOn(c) || Profile.chosen(c) == null || VpnService.prepare(c) != null) return;
        Intent s = new Intent(c, VpnSvc.class).setAction(VpnSvc.START);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(s);
        else c.startService(s);
    }
}
