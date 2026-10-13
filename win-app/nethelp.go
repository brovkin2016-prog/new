package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"
)

// direct is how this program reaches the internet by itself: names asked straight from a public DNS (the computer's
// own lookups go into the VPN when it is on, and get made-up addresses there) — the next one when one does not answer.
var dnsServers = []string{"77.88.8.8:53", "8.8.8.8:53", "1.1.1.1:53"}

func resolverVia(server string) *net.Resolver {
	return &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, server)
	}}
}

var directResolvers = func() (rs []*net.Resolver) {
	for _, s := range dnsServers {
		rs = append(rs, resolverVia(s))
	}
	return
}()

// lookup: the name's addresses (IPv4 first) from the first public DNS that answers.
func lookup(ctx context.Context, name string) ([]net.IP, error) {
	if ip := net.ParseIP(name); ip != nil {
		return []net.IP{ip}, nil
	}
	err := errors.New("нет DNS")
	for _, r := range directResolvers {
		c, cancel := context.WithTimeout(ctx, 3*time.Second)
		var ips []net.IPAddr
		ips, err = r.LookupIPAddr(c, name)
		cancel()
		if err == nil && len(ips) > 0 {
			var v4, v6 []net.IP
			for _, ip := range ips {
				if ip.IP.To4() != nil {
					v4 = append(v4, ip.IP)
				} else {
					v6 = append(v6, ip.IP)
				}
			}
			return append(v4, v6...), nil
		}
		var dnsErr *net.DNSError
		if ctx.Err() != nil || errors.As(err, &dnsErr) && dnsErr.IsNotFound { // no such name: the same everywhere
			break
		}
	}
	return nil, err
}

// dialDirect: straight to the name's address, past the VPN's own lookups.
func dialDirect(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	ips, err := lookup(ctx, host)
	if err != nil {
		return nil, err
	}
	d := net.Dialer{Timeout: 10 * time.Second}
	for _, ip := range ips {
		var c net.Conn
		if c, err = d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port)); err == nil {
			return c, nil
		}
	}
	return nil, err
}

// Resolve gives one address for a name (IPv4 first), straight.
func Resolve(name string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ips, err := lookup(ctx, name)
	if err != nil || len(ips) == 0 {
		return "", errors.New("не найден " + name)
	}
	return ips[0].String(), nil
}

// client: through the connection's local port when it is up (the family server may be out of reach straight), else
// straight.
func client(probePort int, timeout time.Duration) *http.Client {
	tr := &http.Transport{DialContext: dialDirect, TLSHandshakeTimeout: 10 * time.Second}
	if probePort > 0 {
		px, _ := url.Parse("http://127.0.0.1:" + itoa(probePort))
		tr = &http.Transport{Proxy: http.ProxyURL(px), TLSHandshakeTimeout: 10 * time.Second}
	}
	return &http.Client{Transport: tr, Timeout: timeout}
}

// Ping: a tiny page through the connection; its time in ms, or 0 when nothing came back.
func Ping(probePort int, timeout time.Duration) int {
	c := client(probePort, timeout)
	urls := []string{"http://cp.cloudflare.com/generate_204", "http://www.gstatic.com/generate_204"}
	if u := os.Getenv("WINGER_PING_URL"); u != "" { // the tests' own page
		urls = []string{u}
	}
	for _, u := range urls {
		t := time.Now()
		r, err := c.Get(u)
		if err != nil {
			continue
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, 1024))
		r.Body.Close()
		if r.StatusCode == 204 || r.StatusCode == 200 {
			ms := int(time.Since(t).Milliseconds())
			if ms < 1 {
				ms = 1
			}
			return ms
		}
	}
	return 0
}

// Speed, as the phone measures it: Mbit/s over 8 seconds of download counted from its first byte, and the ms to that
// first byte (0, 0 when nothing came).
func Speed(probePort int) (float64, int) {
	c := client(probePort, 30*time.Second)
	t0 := time.Now()
	r, err := c.Get("https://speed.cloudflare.com/__down?bytes=50000000")
	if err != nil {
		return 0, 0
	}
	defer r.Body.Close()
	buf := make([]byte, 64<<10)
	var got int64
	var first time.Time
	for first.IsZero() {
		k, err := r.Body.Read(buf)
		if k > 0 {
			first, got = time.Now(), int64(k)
		}
		if err != nil {
			if first.IsZero() {
				return 0, 0
			}
			break
		}
	}
	for time.Since(first) < 8*time.Second {
		k, err := r.Body.Read(buf)
		got += int64(k)
		if err != nil {
			break
		}
	}
	sec := max(0.2, time.Since(first).Seconds())
	return float64(got) * 8 / 1e6 / sec, max(1, int(first.Sub(t0).Milliseconds()))
}

// FreePort: a free TCP port on this computer.
func FreePort() int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 47900
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func itoa(n int) string {
	return fmtInt(n)
}

func fmtInt(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
