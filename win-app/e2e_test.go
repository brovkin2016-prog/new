package main

import (
	"io"
	"net/http"
	"net/url"
	"os"
	"testing"
	"time"
)

// WINGER_E2E=<hysteria2 link>: through a real server, a page comes via the connection's local port.
func TestThroughServer(t *testing.T) {
	link := os.Getenv("WINGER_E2E")
	if link == "" {
		t.Skip("no test server")
	}
	p, err := ParseLink(link)
	if err != nil {
		t.Fatal(err)
	}
	var b Box
	if err := b.Start(Config(EngineOptions{Profile: p, ProbePort: 47811})); err != nil {
		t.Fatal(err)
	}
	defer b.Stop()
	px, _ := url.Parse("http://127.0.0.1:47811")
	c := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(px)}, Timeout: 20 * time.Second}
	r, err := c.Get("https://pypi.org/simple/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 200))
	r.Body.Close()
	if r.StatusCode != 200 {
		t.Fatalf("%d %s", r.StatusCode, body)
	}
	t.Logf("through the server: %d, %d bytes read", r.StatusCode, len(body))
}
