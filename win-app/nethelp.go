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
// own lookups go into the VPN when it is on, and get made-up addresses there).
var directResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
	var d net.Dialer
	for _, server := range []string{"77.88.8.8:53", "8.8.8.8:53", "1.1.1.1:53"} {
		if c, err := d.DialContext(ctx, "udp", server); err == nil {
			return c, nil
		}
	}
	return nil, errors.New("нет DNS")
}}

var directDialer = &net.Dialer{Timeout: 10 * time.Second, Resolver: directResolver}

// Resolve gives one address for a name (IPv4 first), straight.
func Resolve(name string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	ips, err := directResolver.LookupIPAddr(ctx, name)
	if err != nil || len(ips) == 0 {
		return "", errors.New("не найден " + name)
	}
	for _, ip := range ips {
		if ip.IP.To4() != nil {
			return ip.IP.String(), nil
		}
	}
	return ips[0].IP.String(), nil
}

// client: through the connection's local port when it is up (the family server may be out of reach straight), else
// straight.
func client(probePort int, timeout time.Duration) *http.Client {
	tr := &http.Transport{DialContext: directDialer.DialContext, TLSHandshakeTimeout: 10 * time.Second}
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

// Speed: Mbit/s of an 8-second download through the connection (0 when nothing came).
func Speed(probePort int) float64 {
	c := client(probePort, 12*time.Second)
	t := time.Now()
	r, err := c.Get("https://speed.cloudflare.com/__down?bytes=50000000")
	if err != nil {
		return 0
	}
	defer r.Body.Close()
	var n int64
	buf := make([]byte, 64<<10)
	for time.Since(t) < 8*time.Second {
		k, err := r.Body.Read(buf)
		n += int64(k)
		if err != nil {
			break
		}
	}
	sec := time.Since(t).Seconds()
	if sec <= 0 || n == 0 {
		return 0
	}
	return float64(n) * 8 / sec / 1e6
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
