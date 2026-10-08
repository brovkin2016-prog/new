package app.aihelper.vpn;

import android.os.Handler;
import android.os.Looper;

import java.util.concurrent.CopyOnWriteArrayList;

/** What the VPN is doing right now; the screen and the notification listen to it. */
final class State {
    enum Phase { OFF, CONNECTING, ON, RETRYING }

    interface Listener {
        void changed();
    }

    static volatile Phase phase = Phase.OFF;
    static volatile String note = "";      // the reason when it is not working, in plain words
    static volatile int pingMs = -1;       // the last response time through the tunnel; -1: not measured, 0: no answer
    static volatile long pingAt;
    static volatile long since;            // when it last came ON
    static volatile long down, up;         // bytes through the tunnel since it came on
    static volatile double downRate, upRate;  // bytes per second, smoothed
    static volatile String activeLink = "";  // the connection in use now (it may be the bridge Winger moved to by itself)
    static volatile boolean auto;            // in use because the chosen one did not answer

    private static final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private static final Handler main = new Handler(Looper.getMainLooper());

    private State() {}

    static void set(Phase p, String why) {
        phase = p;
        note = why == null ? "" : why;
        if (p == Phase.ON && since == 0) since = System.currentTimeMillis();
        if (p == Phase.OFF) {
            activeLink = "";
            auto = false;
            since = 0;
            pingMs = -1;
            down = up = 0;
            downRate = upRate = 0;
        }
        fire();
    }

    static void fire() {
        main.post(() -> {
            for (Listener l : listeners) l.changed();
        });
    }

    static void listen(Listener l) {
        listeners.add(l);
    }

    static void unlisten(Listener l) {
        listeners.remove(l);
    }
}
