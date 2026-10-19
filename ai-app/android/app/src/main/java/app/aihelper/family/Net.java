package app.aihelper.family;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import org.chromium.net.CronetException;
import org.chromium.net.ExperimentalCronetEngine;
import org.chromium.net.UploadDataProvider;
import org.chromium.net.UploadDataSink;
import org.chromium.net.UploadDataProviders;
import org.chromium.net.UrlRequest;
import org.chromium.net.UrlResponseInfo;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * All traffic to the server, through Chrome's network stack (Cronet). It speaks HTTP/3 over UDP 443 first: mobile
 * networks that drop TCP to the server still let it through (the server's VPN listens there and hands everything that
 * is not a VPN login to the assistant). When UDP does not work, the same request goes over TLS on TCP 8443.
 * With a VPN on the phone the request travels inside the tunnel, where only TCP 8443 reaches the server: it goes first.
 */
final class Net {
    /** A started request, to be called off (an update download the person cancelled). */
    interface Handle {
        void cancel();
    }

    interface Sink {
        void head(int status);
        void data(byte[] chunk);
        void end();
        void fail(String why);
    }

    private static final String TAG = "AINet";
    private static final long CONNECT_MS = 20_000;   // no answer at all by then: give up on this way
    private static final long FIRST_MS = 6_000;      // ... but the first way gets less: the other one is tried sooner
    private static final long REMEMBER_MS = 30 * 60_000;  // UDP did not work: TCP first for this long
    private static final long IDLE_MS = 90_000;      // the server pings every 15 s while it works
    private static final int BIG = 64 * 1024;         // a photo or a recording: its upload may take a while on a slow uplink
    private static final long MOVING_MS = 30_000;     // ... and is given this long after its last part went out
    private static final ExecutorService pool = Executors.newCachedThreadPool();
    private static final Handler timers = new Handler(Looper.getMainLooper());
    private static volatile ExperimentalCronetEngine engine;
    private static Context app;
    private static String engineHost = "";
    private static volatile long preferTcpUntil = 0;
    static volatile String host = "";
    static volatile String lastProto = "";  // what the last answer came over: h3 (UDP), h2 or http/1.1 (TCP 8443)
    static volatile boolean lastVpn;       // ... and whether a VPN on the phone carried it

    private Net() {}

    static synchronized void setHost(Context ctx, String h) {
        app = ctx.getApplicationContext();
        host = h == null ? "" : h.trim();
        if (host.isEmpty() || host.equals(engineHost)) return;
        String name = host.contains(":") ? host.substring(0, host.indexOf(':')) : host;
        File dir = new File(ctx.getCacheDir(), "cronet");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        ExperimentalCronetEngine.Builder b = new ExperimentalCronetEngine.Builder(ctx.getApplicationContext());
        b.enableQuic(true).enableHttp2(true).enableBrotli(true)
                .setStoragePath(dir.getAbsolutePath())
                .enableHttpCache(ExperimentalCronetEngine.Builder.HTTP_CACHE_DISK_NO_HTTP, 1 << 20)  // keeps QUIC keys for 0-RTT
                .addQuicHint(name, 443, 443)
                .setUserAgent("AIApp/" + BuildConfig.VERSION_NAME + " (Android)");
        if (!BuildConfig.TEST_HOST_RULES.isEmpty()) {
            // the emulator test's server has a test CA; Chrome allows QUIC only to publicly trusted roots unless told
            b.setExperimentalOptions("{\"HostResolverRules\":{\"host_resolver_rules\":\"" + BuildConfig.TEST_HOST_RULES
                    + "\"},\"QUIC\":{\"allow_unknown_root_cert\":true}}");
        }
        if (engine != null) {
            try {
                engine.shutdown();
            } catch (RuntimeException e) {
                Log.i(TAG, "old engine still busy, left to finish: " + e.getMessage());
            }
        }
        engine = b.build();
        engineHost = host;
    }

    private static String base(boolean tcp) {
        String name = host.contains(":") ? host.substring(0, host.indexOf(':')) : host;
        return tcp ? "https://" + name + ":8443" : "https://" + name;
    }

    /** Starts a request; the sink hears the status, the body as it arrives, and the end. */
    static Handle start(String method, String path, Map<String, String> headers, byte[] body, Sink sink) {
        if (engine == null || host.isEmpty()) {
            sink.fail("no host");
            return () -> { };
        }
        boolean vpn = vpnOn();
        Call c = new Call(method, path, headers, body, sink, vpn || System.currentTimeMillis() < preferTcpUntil, vpn);
        c.go();
        return c;
    }

    /** A VPN app on the phone is carrying the traffic (Hysteria, VLESS or any other). */
    static boolean vpnOn() {
        try {
            ConnectivityManager cm = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network n = cm == null ? null : cm.getActiveNetwork();
            NetworkCapabilities c = n == null ? null : cm.getNetworkCapabilities(n);
            return c != null && c.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** A small GET, waiting for the whole answer; null when it failed or the status was not 200. */
    static byte[] get(String path, long timeoutMs) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int[] status = {0};
        boolean[] ok = {false};
        CountDownLatch done = new CountDownLatch(1);
        start("GET", path, null, null, new Sink() {
            public void head(int s) { status[0] = s; }
            public void data(byte[] chunk) { out.write(chunk, 0, chunk.length); }
            public void end() { ok[0] = true; done.countDown(); }
            public void fail(String why) { done.countDown(); }
        });
        try {
            if (!done.await(timeoutMs, TimeUnit.MILLISECONDS)) return null;
        } catch (InterruptedException e) {
            return null;
        }
        return ok[0] && status[0] == 200 ? out.toByteArray() : null;
    }

    /** A body handed to the network as before, telling each time a part of it has gone out. */
    private static final class Moving extends UploadDataProvider {
        private final UploadDataProvider in;
        private final Runnable moved;

        Moving(UploadDataProvider in, Runnable moved) {
            this.in = in;
            this.moved = moved;
        }

        @Override
        public long getLength() throws IOException {
            return in.getLength();
        }

        @Override
        public void read(UploadDataSink sink, ByteBuffer buf) throws IOException {
            in.read(sink, buf);
            moved.run();
        }

        @Override
        public void rewind(UploadDataSink sink) throws IOException {
            in.rewind(sink);
        }

        @Override
        public void close() throws IOException {
            in.close();
        }
    }

    private static final class Call extends UrlRequest.Callback implements Handle {
        final String method, path;
        final Map<String, String> headers;
        final byte[] body;
        final Sink sink;
        volatile boolean tcp, triedOther, started, timedOut, stopped;
        final boolean vpn;
        UrlRequest req;
        volatile int tries;     // this request's try (QUIC, then TCP): a part read for an earlier one changes nothing
        volatile long deadline; // when the connect timeout fires (uptime)
        // (an answer already coming is never cut: a part's late moved() may have set it again just as it began)
        final Runnable connectTimeout = () -> { if (started) return; timedOut = true; if (req != null) req.cancel(); };
        final Runnable idleTimeout = () -> { timedOut = true; if (req != null) req.cancel(); };

        Call(String method, String path, Map<String, String> headers, byte[] body, Sink sink, boolean tcp, boolean vpn) {
            this.vpn = vpn;
            this.method = method;
            this.path = path;
            this.headers = headers;
            this.body = body;
            this.sink = sink;
            this.tcp = tcp;
        }

        void go() {
            started = false;
            timedOut = false;
            UrlRequest.Builder rb = engine.newUrlRequestBuilder(base(tcp) + path, this, pool).setHttpMethod(method);
            boolean type = false;
            if (headers != null) {
                for (Map.Entry<String, String> h : headers.entrySet()) {
                    rb.addHeader(h.getKey(), h.getValue());
                    type |= h.getKey().equalsIgnoreCase("Content-Type");
                }
            }
            int t = ++tries;
            if (body != null) {
                if (!type) rb.addHeader("Content-Type", "application/json");
                UploadDataProvider up = UploadDataProviders.create(body);
                rb.setUploadDataProvider(body.length > BIG ? new Moving(up, () -> moved(t)) : up, pool);
            }
            req = rb.build();
            // QUIC that gets no answer is usually UDP dropped by the network: TCP is tried after a few seconds, not 20
            // (with a VPN on the phone only TCP goes anyway, so it is given the full time)
            long wait = triedOther || vpn ? CONNECT_MS : FIRST_MS;
            deadline = SystemClock.uptimeMillis() + wait + (body == null ? 0 : body.length / 50);  // ~50 kB/s ...
            timers.postAtTime(connectTimeout, deadline);
            req.start();
        }

        /** ... or slower: while a big body still goes out part by part the network carries it, and the wait starts
         *  again (a weak 3G uplink took 8 full uploads before «связь всё время обрывается»). */
        private void moved(int t) {
            if (t != tries || started || stopped) return;
            long until = SystemClock.uptimeMillis() + MOVING_MS;
            if (until < deadline + 1000) return;  // (not moved for every part: once a second is plenty)
            deadline = until;
            timers.removeCallbacks(connectTimeout);
            timers.postAtTime(connectTimeout, until);
        }

        @Override
        public void cancel() {
            stopped = true;
            timers.removeCallbacks(connectTimeout);
            timers.removeCallbacks(idleTimeout);
            UrlRequest q = req;
            if (q != null) q.cancel();
        }

        private boolean retry(String why) {
            if (started || triedOther || stopped) return false;
            Log.i(TAG, (tcp ? "TCP" : "QUIC") + " failed (" + why + "), trying " + (tcp ? "QUIC" : "TCP 8443"));
            triedOther = true;
            tcp = !tcp;
            go();
            return true;
        }

        @Override
        public void onRedirectReceived(UrlRequest r, UrlResponseInfo info, String location) {
            r.followRedirect();
        }

        @Override
        public void onResponseStarted(UrlRequest r, UrlResponseInfo info) {
            started = true;
            timers.removeCallbacks(connectTimeout);
            timers.postDelayed(idleTimeout, IDLE_MS);
            if (!vpn) preferTcpUntil = tcp ? System.currentTimeMillis() + REMEMBER_MS : 0;
            lastProto = info.getNegotiatedProtocol();
            lastVpn = vpn;
            if (BuildConfig.DEBUG) Log.i(TAG, path + " " + info.getHttpStatusCode() + " via " + info.getNegotiatedProtocol());
            sink.head(info.getHttpStatusCode());
            r.read(ByteBuffer.allocateDirect(32 * 1024));
        }

        @Override
        public void onReadCompleted(UrlRequest r, UrlResponseInfo info, ByteBuffer buf) {
            timers.removeCallbacks(idleTimeout);
            timers.postDelayed(idleTimeout, IDLE_MS);
            buf.flip();
            byte[] chunk = new byte[buf.remaining()];
            buf.get(chunk);
            if (chunk.length > 0) sink.data(chunk);
            buf.clear();
            r.read(buf);
        }

        @Override
        public void onSucceeded(UrlRequest r, UrlResponseInfo info) {
            timers.removeCallbacks(connectTimeout);
            timers.removeCallbacks(idleTimeout);
            sink.end();
        }

        @Override
        public void onFailed(UrlRequest r, UrlResponseInfo info, CronetException e) {
            timers.removeCallbacks(connectTimeout);
            timers.removeCallbacks(idleTimeout);
            if (!retry(e.getMessage())) sink.fail(e.getMessage() == null ? "net" : e.getMessage());
        }

        @Override
        public void onCanceled(UrlRequest r, UrlResponseInfo info) {
            timers.removeCallbacks(connectTimeout);
            timers.removeCallbacks(idleTimeout);
            if (stopped) sink.fail("cancelled");
            else if (!(timedOut && retry("timeout"))) sink.fail("timeout");
        }
    }
}
