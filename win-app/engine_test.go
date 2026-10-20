package main

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// one look with nothing back is not a break; programs' data that still comes is not one either; several looks in a
// row with nothing at all are — 3 for a server, 4 for a bridge; pages that never come while data does, after a long while
func TestHealthBreaksOnlyWhenNothingComesBack(t *testing.T) {
	h := newHealth(false)
	for i, l := range []struct{ answered, flowed bool }{{false, false}, {true, false}, {false, false}, {false, false},
		{false, true}, {false, false}, {false, false}} {
		if err := h.look(l.answered, l.flowed); err != nil {
			t.Fatalf("server, look %d: broken too soon: %v", i+1, err)
		}
	}
	if err := h.look(false, false); err == nil {
		t.Fatal("server: 3 looks in a row with nothing back did not break it")
	}
	b := newHealth(true)
	for i := 0; i < missesBridge-1; i++ {
		if err := b.look(false, false); err != nil {
			t.Fatalf("bridge, look %d: broken too soon: %v", i+1, err)
		}
	}
	if err := b.look(false, false); err == nil {
		t.Fatal("bridge: 4 looks in a row with nothing back did not break it")
	}
	s := newHealth(false)
	for i := 0; i < noPageMax-1; i++ {
		if err := s.look(false, true); err != nil {
			t.Fatalf("data still comes, look %d: broken: %v", i+1, err)
		}
	}
	if err := s.look(false, true); err == nil || !strings.Contains(err.Error(), "страницы") {
		t.Fatalf("pages that never come while data does: %v", err)
	}
}

// the watch itself: a page now and then not coming, or not coming while a download goes on, does not make the
// connection anew (it did after 2 such looks); the window says «retrying» while it waits, «on» once pages come again
func TestWatchWaitsOutBlips(t *testing.T) {
	jp := journalIn(t)
	oldEvery, oldPage := lookEvery, pageThrough
	t.Cleanup(func() { lookEvery, pageThrough = oldEvery, oldPage })
	lookEvery = 0
	st := OpenStore(t.TempDir())
	srv := mustParse(t, "hysteria2://a:1@one.example.ru:443/#Один")
	e := NewEngine(st, t.TempDir(), "", nil, false)
	run := func(bridge bool, script []int, flows map[int]bool) (looks int, phases []string, err error) {
		e.mu.Lock()
		e.gen++
		g := e.gen
		e.wanted, e.profile, e.status = true, srv, Status{Phase: "on", Active: srv.Link}
		e.mu.Unlock()
		pageThrough = func(int, time.Duration) int {
			phases = append(phases, e.Status().Phase) // what the look before left
			looks++
			if flows[looks] {
				e.box.traffic.down.Add(1500)
			}
			if looks > len(script) {
				e.mu.Lock()
				e.wanted = false // the script is over: off, the watch ends
				e.mu.Unlock()
				return 0
			}
			return script[looks-1]
		}
		err = e.watch(g, bridge)
		return
	}

	// the old watch gave up at the 4th look (2 in a row): now 3 in a row with nothing at all back, so the 9th
	looks, phases, err := run(false, []int{0, 50, 0, 0, 50, 0, 0, 0, 0}, map[int]bool{6: true})
	if err == nil || looks != 9 {
		t.Fatalf("server: made anew after %d looks (%v), want after the 9th", looks, err)
	}
	if want := "on on on on retrying on on on retrying"; strings.Join(phases, " ") != want {
		t.Fatalf("server: the window said %v, want %s", phases, want)
	}
	b, _ := os.ReadFile(jp)
	if j := string(b); !strings.Contains(j, "ping failed (1 of 3)") || !strings.Contains(j, "still comes through it: it holds") ||
		!strings.Contains(j, "ping failed (3 of 3, 4 in a row without a page): made anew") {
		t.Fatalf("the journal does not tell the looks apart:\n%s", j)
	}

	// a bridge: its call gets back by itself — 3 looks in a row with nothing back are waited out, the 4th is not
	looks, _, err = run(true, []int{0, 0, 0, 80, 0, 0, 0, 0}, nil)
	if err == nil || looks != 8 {
		t.Fatalf("bridge: made anew after %d looks (%v), want after the 8th", looks, err)
	}

	// pages come again for good: nothing is made anew, the watch goes on until it is switched off
	looks, phases, err = run(false, []int{0, 0, 40, 40, 40}, nil)
	if err != nil || looks != 6 || phases[3] != "on" {
		t.Fatalf("a short break made it anew: %v after %d looks, %v", err, looks, phases)
	}
}

// a connection that keeps breaking soon after it comes up is tried again less and less often (it was tried every 2 s,
// round and round); one that held a while starts the count afresh
func TestRetriesSlowDownWhenItKeepsBreaking(t *testing.T) {
	fails := 0
	var waits []string
	for i := 0; i < 6; i++ { // up a minute, then broken — as run() counts it
		fails = failsAfterUp(fails, time.Minute)
		fails++
		waits = append(waits, retryWait(fails).String())
	}
	if got := strings.Join(waits, " "); got != "2s 4s 8s 16s 30s 30s" {
		t.Fatalf("the waits: %s", got)
	}
	fails = failsAfterUp(fails, steadyFor)
	fails++
	if fails != 1 || retryWait(fails) != 2*time.Second {
		t.Fatalf("one that held %s did not start afresh: %d", steadyFor, fails)
	}
}

// the bridge goes over to the call's video only for the data channel's own failures: not for a call that does not
// answer, a captcha or a lost network
func TestDcFaultsOnlyItsOwn(t *testing.T) {
	other := errors.New("Мост не поднялся: звонок не отвечает.")
	if n := dcFaults(dcFaults(0, other, 0), other, 0); n != 0 {
		t.Fatalf("a call that does not answer counted: %d", n)
	}
	if n := dcFaults(dcFaults(0, errNoData, 0), errNoData, 0); n != 2 {
		t.Fatalf("nothing through it twice: %d", n)
	}
	if n := dcFaults(1, other, time.Minute); n != 2 {
		t.Fatalf("a session that died soon: %d", n)
	}
	if n := dcFaults(1, other, 10*time.Minute); n != 0 {
		t.Fatalf("one that held a while did not start afresh: %d", n)
	}
}

// the family server moved and the hourly look renewed its link while the VPN went on on the old one: once the old
// address stops answering, the renewed link is the one to go to (the server itself has nothing newer to say by then)
func TestRenewedMeanwhileIsFound(t *testing.T) {
	st := OpenStore(t.TempDir())
	old := mustParse(t, "hysteria2://u:k@1.1.1.1:443/?sni=vpn.example.ru#Дом")
	st.Add(old)
	st.Add(mustParse(t, "hysteria2://x:y@2.2.2.2:443/?sni=other.example.ru#Другой"))
	st.Update(func(s *Settings) { s.Current = 0 })
	e := NewEngine(st, t.TempDir(), "", nil, false)
	if e.renewedMeanwhile(old) != nil {
		t.Fatal("not renewed, yet something was found")
	}
	if !st.Renew("u:k", mustParse(t, "hysteria2://u:k@3.3.3.3:443/?sni=vpn.example.ru#Дом"), nil, nil) {
		t.Fatal("not renewed")
	}
	if got := e.renewedMeanwhile(old); got == nil || got.Host != "3.3.3.3" || got.Name != "Дом" {
		t.Fatalf("the renewed link was not found: %+v", got)
	}
	st.Update(func(s *Settings) { s.Current = 1 }) // another server chosen: not taken for this one's new address
	if e.renewedMeanwhile(old) != nil {
		t.Fatal("another server was taken for the renewed one")
	}
}

// the programs' setting changes what the VPN carries only when the list in use changes: a click on the mode it is in
// already, or the same list saved again (in another order), does not make the connection anew; the server and a bridge
// each have their own
func TestCarriedOnlyWhatIsInUse(t *testing.T) {
	all := Settings{Apps: []string{"telegram.exe"}}
	only := Settings{OnlyApps: true, Apps: []string{"telegram.exe", "chrome.exe"}, BridgeOnly: true, BridgeApps: []string{"whatsapp.exe"}}
	same := Settings{OnlyApps: true, Apps: []string{"chrome.exe", "telegram.exe"}}
	if all.For(false) != nil || (Settings{OnlyApps: true}).For(false) != nil || all.For(true) != nil {
		t.Fatal("all programs: nothing chosen")
	}
	if got := only.For(false); len(got) != 2 || got[0] != "chrome.exe" || same.For(false)[0] != "chrome.exe" {
		t.Fatalf("%v", got)
	}
	if got := only.For(true); len(got) != 1 || got[0] != "whatsapp.exe" {
		t.Fatalf("a bridge's own list: %v", got)
	}
	if only.Apps[0] != "telegram.exe" {
		t.Fatal("the settings' own list was changed")
	}
}

// Winger before 1.0.140 started with all programs and had one list: the standard ones now, a list chosen before kept
// as the server's, a bridge's own list the standard one; once only
func TestTwoLists(t *testing.T) {
	old := Settings{}
	if !twoLists(&old) || !old.OnlyApps || len(old.Apps) != len(standardApps[false]) || !old.BridgeOnly ||
		len(old.BridgeApps) != len(standardApps[true]) || old.AppsSet != 1 {
		t.Fatalf("the old start: %+v", old)
	}
	chosen := Settings{OnlyApps: true, Apps: []string{"telegram.exe"}}
	twoLists(&chosen)
	if len(chosen.Apps) != 1 || chosen.Apps[0] != "telegram.exe" || len(chosen.BridgeApps) == 0 {
		t.Fatalf("a list chosen before: %+v", chosen)
	}
	chosen.OnlyApps = false // «all programs» chosen now: stays so
	if twoLists(&chosen) || chosen.OnlyApps {
		t.Fatal("taken again")
	}
	for _, n := range standardApps[true] {
		if n == "spotify.exe" || n == "discord.exe" {
			t.Fatal("a bridge is slow: no music or voice-call programs by default")
		}
	}
	if st := OpenStore(t.TempDir()); !st.Get().OnlyApps || st.Get().AppsSet != 1 {
		t.Fatal("a new Winger: the standard lists")
	}
}
