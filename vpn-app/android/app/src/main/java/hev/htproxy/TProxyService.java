package hev.htproxy;

/**
 * hev-socks5-tunnel (the native part): it moves the phone's traffic from the VPN interface to the local SOCKS5 port of
 * the Hysteria client. Its JNI_OnLoad registers these methods on exactly this class name, so it must not move.
 */
public final class TProxyService {
    static {
        System.loadLibrary("hev-socks5-tunnel");
    }

    public native boolean TProxyStartService(String configPath, int fd);

    public native boolean TProxyStopService();

    public native boolean TProxyIsRunning();

    /** {tx packets, tx bytes, rx packets, rx bytes} as the tunnel counts them. */
    public native long[] TProxyGetStats();
}
