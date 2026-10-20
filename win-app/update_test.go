//go:build !windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// the family server's update files on a test server; which way each request went (0: straight, else the VPN's port)
func updateServer(t *testing.T, code int, file []byte) (*[]int, *sync.Mutex) {
	t.Helper()
	sum := sha256.Sum256(file)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/winger-win.json":
			fmt.Fprintf(w, `{"code": %d, "name": "1.0.%d", "sha256": "%s"}`, code, code, hex.EncodeToString(sum[:]))
		case "/app/winger-win.exe":
			_, _ = w.Write(file)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	var ways []int
	var mu sync.Mutex
	oldURL, oldClient, oldEvery := updateURL, updateClient, quietEvery
	t.Cleanup(func() { updateURL, updateClient, quietEvery = oldURL, oldClient, oldEvery })
	updateURL = func(_, name string) string { return srv.URL + "/app/" + name }
	updateClient = func(port int, timeout time.Duration) *http.Client {
		mu.Lock()
		ways = append(ways, port)
		mu.Unlock()
		return &http.Client{Timeout: timeout}
	}
	quietEvery = 20 * time.Millisecond
	return &ways, &mu
}

func updateFamily(t *testing.T, on bool, bridge bool) (*Family, *Engine) {
	t.Helper()
	dir := t.TempDir()
	st := OpenStore(dir)
	srv := mustParse(t, "hysteria2://me:pw@vpn.example.ru:443/?sni=vpn.example.ru#Сервер")
	st.Add(srv)
	e := NewEngine(st, dir, "", nil, false)
	if on {
		p := srv
		if bridge {
			p = mustParse(t, "winger-bridge://telemost?link=https%3A%2F%2Ftelemost.yandex.ru%2Fj%2F12345678901234#Мост")
		}
		e.wanted, e.profile, e.status = true, p, Status{Phase: "on", Active: p.Link}
	}
	return &Family{st: st, eng: e, dataDir: dir}, e
}

func waitState(t *testing.T, f *Family, want string) UpdateInfo {
	t.Helper()
	for i := 0; i < 300; i++ {
		if u := f.UpdateInfo(); strings.HasPrefix(u.State, want) {
			return u
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("the update did not come to %q: %+v", want, f.UpdateInfo())
	return UpdateInfo{}
}

// found by itself while the VPN is on: asked and downloaded straight (the VPN left alone), then it waits while programs
// move data and goes in after a quiet minute (here: «installed» is this build's «only on Windows»)
func TestUpdateStraightThenAQuietMinute(t *testing.T) {
	journalIn(t)
	ways, mu := updateServer(t, versionCode+1, []byte("new winger"))
	f, e := updateFamily(t, true, false)
	busy := make(chan struct{})
	go func() { // a film: 100 KB/s through the VPN
		for {
			select {
			case <-busy:
				return
			case <-time.After(5 * time.Millisecond):
				e.box.traffic.down.Add(1000)
			}
		}
	}()
	done := make(chan struct{})
	go func() { f.CheckUpdate(false); close(done) }()
	waitState(t, f, "waiting")
	time.Sleep(200 * time.Millisecond) // 10 looks, all busy
	if u := f.UpdateInfo(); u.State != "waiting" {
		close(busy)
		t.Fatalf("went in while the VPN was busy: %+v", u)
	}
	close(busy)
	<-done
	if u := f.UpdateInfo(); u.State != "failed: обновление ставится только на Windows" {
		t.Fatalf("not put in after a quiet minute: %+v", u)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(*ways) != 2 || (*ways)[0] != 0 || (*ways)[1] != 0 {
		t.Fatalf("not straight (0 is straight): %v", *ways)
	}
	b, _ := os.ReadFile(filepath.Join(f.dataDir, "update", "winger-new.exe"))
	if string(b) != "new winger" {
		t.Fatalf("the downloaded file: %q", b)
	}
}

// the server not reachable straight: through the VPN when it runs on the server — through a bridge only when the person
// asked (a found update does not take a slow bridge over)
func TestUpdateThroughTheVPNNotABridge(t *testing.T) {
	journalIn(t)
	ways, mu := updateServer(t, versionCode+1, []byte("x"))
	straightFails := updateClient
	updateClient = func(port int, timeout time.Duration) *http.Client {
		c := straightFails(port, timeout)
		if port == 0 {
			c.Transport = failing{}
		}
		return c
	}
	f, e := updateFamily(t, true, true)
	f.CheckUpdate(false)
	if u := f.UpdateInfo(); !strings.Contains(u.State, "не ответил") {
		t.Fatalf("on a bridge, found by itself: %+v", u)
	}
	mu.Lock()
	if len(*ways) != 1 || (*ways)[0] != 0 {
		t.Fatalf("on a bridge it went through the bridge: %v", *ways)
	}
	*ways = nil
	mu.Unlock()
	f.CheckUpdate(true)
	waitState(t, f, "failed: обновление ставится только на Windows")
	mu.Lock()
	if p := e.port(); len(*ways) != 3 || (*ways)[1] != p || (*ways)[2] != p {
		t.Fatalf("asked by the person: not through the bridge (port %d): %v", p, *ways)
	}
	mu.Unlock()
}

type failing struct{}

func (failing) RoundTrip(*http.Request) (*http.Response, error) { return nil, fmt.Errorf("blocked") }

// «Проверить обновление» while a found one waits for a quiet minute: in at once
func TestUpdateAskedWhileWaiting(t *testing.T) {
	journalIn(t)
	updateServer(t, versionCode+1, []byte("x"))
	quietEvery = time.Hour
	f, _ := updateFamily(t, true, false)
	go f.CheckUpdate(false)
	waitState(t, f, "waiting")
	f.CheckUpdate(false) // the hourly look meanwhile: changes nothing
	if u := f.UpdateInfo(); u.State != "waiting" {
		t.Fatalf("the hourly look disturbed the waiting one: %+v", u)
	}
	f.CheckUpdate(true)
	waitState(t, f, "failed: обновление ставится только на Windows")
}

// a version put back (it did not run here) is not downloaded again; the next one is; one stuck «ready» (the new program
// never came) is let go after 20 minutes
func TestUpdateBadVersionAndStuck(t *testing.T) {
	journalIn(t)
	ways, mu := updateServer(t, versionCode+1, []byte("x"))
	f, _ := updateFamily(t, false, false)
	if err := os.MkdirAll(filepath.Join(f.dataDir, "rollback"), 0o700); err != nil {
		t.Fatal(err)
	}
	markBadUpdate(f.dataDir, versionCode+1, "служба не заработала")
	f.CheckUpdate(false)
	u := f.UpdateInfo()
	if !strings.Contains(u.State, "не заработала на этом компьютере (служба не заработала)") {
		t.Fatalf("the put-back version: %+v", u)
	}
	mu.Lock()
	if len(*ways) != 1 {
		t.Fatalf("the put-back version was downloaded again: %v", *ways)
	}
	mu.Unlock()
	markBadUpdate(f.dataDir, versionCode, "older")
	f.CheckUpdate(false)
	waitState(t, f, "failed: обновление ставится только на Windows")

	f.mu.Lock()
	f.Update.State, f.updAt = "ready", time.Now()
	f.mu.Unlock()
	f.CheckUpdate(true)
	if u := f.UpdateInfo(); u.State != "ready" {
		t.Fatalf("a fresh «ready» was disturbed: %+v", u)
	}
	f.mu.Lock()
	f.updAt = time.Now().Add(-21 * time.Minute)
	f.mu.Unlock()
	f.CheckUpdate(true)
	waitState(t, f, "failed: обновление ставится только на Windows")
}
