package main

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// the journal: the call's room, link and key are hidden; a page's site stays
func TestMaskBridgeWords(t *testing.T) {
	for in, want := range map[string]string{
		`vk-joiner: obf key-source="https://vk.com/call/join/AbCdEf123456" localEpoch=0x1`:    `vk-joiner: obf key-source=… localEpoch=0x1`,
		`wbstream-joiner: room=0123456789abcdef mode=dc`:                                      `wbstream-joiner: room=… mode=dc`,
		`bitrix-joiner: roomId=77 mediaServer=wss://m1.example.ru/ws?token=secret987`:         `bitrix-joiner: roomId=… mediaServer=wss://m1.example.ru/…987`,
		`telemost-joiner: getting connection for https://telemost.yandex.ru/j/12345678901234`: `telemost-joiner: getting connection for https://telemost.yandex.ru/…234`,
		`bridge: resolve telemost.yandex.ru -> 87.250.250.1`:                                  `bridge: resolve telemost.yandex.ru -> 87.250.x.x`,
		`dion-joiner: dion://slug5678 joined`:                                                 `dion-joiner: dion://… joined`,
		`bridge: CAPTCHA:http://127.0.0.1:5555/`:                                              `bridge: CAPTCHA:http://127.0.x.x:5555/`,
	} {
		if got := Mask(in); got != want {
			t.Errorf("Mask(%q)\n got %q\nwant %q", in, got, want)
		}
	}
}

// a stand-in bridge program: the lines a real one writes, at its pace
func fakeRelay(t *testing.T, script string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "relay.sh")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func journalIn(t *testing.T) string {
	t.Helper()
	d := t.TempDir()
	OpenJournal(d)
	t.Cleanup(func() { journalPath = "" })
	return filepath.Join(d, "journal.log")
}

// VK asks for a person: the wait goes on past its usual time; once in the call the check is gone; a lost call and its
// return are told; every SOCKS connection is counted, not written
func TestRelayCaptchaAndReconnect(t *testing.T) {
	jp := journalIn(t)
	path := fakeRelay(t, `echo "STATUS:READY"
read join
echo "STATUS:CAPTCHA:http://127.0.0.1:5555/"
sleep 1
echo "STATUS:Captcha solved, retrying..."
sleep 1.5
echo "STATUS:TUNNEL_CONNECTED"
for i in 1 2 3; do echo "2026/10/12 10:00:0$i relay: SOCKS CONNECT $i -> ex.com:443"; echo "relay: SOCKS CONNECTED $i -> ex.com:443 rdy_wait=1ms"; echo "relay: SOCKS $i first send 10B to tunnel"; done
echo "relay: SOCKS CONNECT 4 -> ex.com:443"
echo "relay: SOCKS CONNECT 4 failed after 1s: x"
echo "STATUS:TUNNEL_LOST"
sleep 0.3
echo "STATUS:TUNNEL_CONNECTED"
sleep 30
`)
	var mu sync.Mutex
	var links []bool
	p := &Profile{Bridge: true, Platform: "vk", Link: "winger-bridge://vk?link=x"}
	r, err := StartRelay(path, p, "", FreePort(), t.TempDir(), func(up bool) { mu.Lock(); links = append(links, up); mu.Unlock() })
	if err != nil {
		t.Fatal(err)
	}
	defer r.Stop()
	time.Sleep(500 * time.Millisecond)
	if Captcha() != "http://127.0.0.1:5555/" {
		t.Fatalf("captcha not shown: %q", Captcha())
	}
	time.Sleep(1100 * time.Millisecond)
	if Captcha() != "" {
		t.Fatalf("captcha still shown once VK took the tick: %q", Captcha())
	}
	if err := r.Wait(time.Second); err != nil { // its own time is 1 s, the check and the call took 2.5 s
		t.Fatalf("the wait did not give the person time: %v", err)
	}
	time.Sleep(time.Second)
	if Captcha() != "" {
		t.Fatalf("captcha still shown once in the call: %q", Captcha())
	}
	mu.Lock()
	got := append([]bool(nil), links...)
	mu.Unlock()
	if len(got) != 2 || got[0] || !got[1] {
		t.Fatalf("lost and back not told: %v", got)
	}
	r.Stop()
	select {
	case <-r.ended:
	case <-time.After(5 * time.Second):
		t.Fatal("not stopped")
	}
	time.Sleep(200 * time.Millisecond)
	b, _ := os.ReadFile(jp)
	j := string(b)
	if strings.Contains(j, "SOCKS CONNECT") || !strings.Contains(j, "bridge: 4 connections through it, 1 did not open") {
		t.Fatalf("SOCKS lines not counted:\n%s", j)
	}
	if !strings.Contains(j, "bridge: TUNNEL_CONNECTED") {
		t.Fatalf("states not written:\n%s", j)
	}
}

// no captcha: the usual wait; a bridge program's end takes away only its own check
func TestRelayWaitAndCaptchaOwner(t *testing.T) {
	journalIn(t)
	slow := fakeRelay(t, "echo STATUS:READY\nread join\nsleep 30\n")
	p := &Profile{Bridge: true, Platform: "telemost", Link: "winger-bridge://telemost?link=x"}
	r, err := StartRelay(slow, p, "", FreePort(), t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t0 := time.Now()
	if err := r.Wait(time.Second); err == nil || time.Since(t0) > 3*time.Second {
		t.Fatalf("wait: %v after %s", err, time.Since(t0))
	}
	setCaptcha(&Relay{}, "http://127.0.0.1:6000/") // a newer bridge program's check
	r.Stop()
	<-r.ended
	if Captcha() != "http://127.0.0.1:6000/" {
		t.Fatalf("another bridge's check was taken away: %q", Captcha())
	}
	setCaptcha(nil, "")
	captchaMu.Lock()
	captchaURL, captchaBy = "", nil
	captchaMu.Unlock()
}

// names: the next DNS when one does not answer (here: one that never answers, then one of the test's own)
func TestLookupFallsBack(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	go func() { // answers every question with 192.0.2.7
		buf := make([]byte, 512)
		for {
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			q := buf[:n]
			end := 12
			for end < n && q[end] != 0 {
				end += int(q[end]) + 1
			}
			end += 5
			if end > n {
				continue
			}
			resp := append([]byte{}, q[:end]...)
			resp[2], resp[3] = 0x81, 0x80
			resp[6], resp[7] = 0, 0
			if q[end-3] == 1 { // A
				resp[7] = 1
				resp = append(resp, 0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 7)
			}
			resp[8], resp[9], resp[10], resp[11] = 0, 0, 0, 0
			_, _ = pc.WriteTo(resp, from)
		}
	}()
	old := directResolvers
	defer func() { directResolvers = old }()
	dead, _ := net.ListenPacket("udp", "127.0.0.1:0") // takes questions, says nothing
	defer dead.Close()
	directResolvers = []*net.Resolver{resolverVia(dead.LocalAddr().String()), resolverVia(pc.LocalAddr().String())}
	t0 := time.Now()
	ip, err := Resolve("call.example.com")
	if err != nil || ip != "192.0.2.7" {
		t.Fatalf("%q %v", ip, err)
	}
	t.Logf("the second DNS answered after %s", time.Since(t0).Round(time.Millisecond))
}
