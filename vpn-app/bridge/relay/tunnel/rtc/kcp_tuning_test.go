package rtc

import (
	"sync"
	"testing"
	"time"

	"whitelist-bypass/relay/tunnel"
)

// winger: the reliable layer's tuning (kcpTuning) is local to each side, so a newer side and an older one
// (kcpTuningOlder) must still carry everything whole and in order both ways; and each part of it must do what it is for.

// a newer creator with an older Winger: one that keeps a session for both of the creator's tracks, and one before that
func TestTunedCreatorOlderJoiner(t *testing.T) {
	for _, share := range []bool{true, false} {
		p := newPairTuned(t, share, share, 0.02, KCPCarrierQueueDepth, kcpTuningDefault, kcpTuningOlder)
		run(t, p, 1500, 400)
	}
}

// an older creator (with the screenshare session and without) with a newer Winger
func TestOlderCreatorTunedJoiner(t *testing.T) {
	for _, share := range []bool{true, false} {
		p := newPairTuned(t, share, true, 0.02, KCPCarrierQueueDepth, kcpTuningOlder, kcpTuningDefault)
		run(t, p, 1500, 400)
	}
}

// the joiner answers a download with a few packets of many acks each, not a frame of its one track per segment
func TestAcksGatheredIntoFewFrames(t *testing.T) {
	type counts struct{ down, up int }
	got := map[string]counts{}
	for name, joiner := range map[string]kcpTuning{"tuned": kcpTuningDefault, "older": kcpTuningOlder} {
		p := newPairTuned(t, true, true, 0, KCPCarrierQueueDepth, kcpTuningDefault, joiner)
		run(t, p, 3000, 16)
		got[name] = counts{p.cam.count() + p.share.count(), p.pub.count()}
		t.Logf("%s joiner: %d frames down, %d frames up", name, got[name].down, got[name].up)
	}
	if tuned := got["tuned"]; tuned.up*4 > tuned.down {
		t.Fatalf("the joiner still answers almost frame for frame: %d up for %d down", tuned.up, tuned.down)
	}
	if older := got["older"]; older.up*2 < older.down {
		t.Fatalf("the older way should answer each segment: %d up for %d down", older.up, older.down)
	}
}

// on a wire that loses nothing the creator sends next to nothing twice, though a window's worth waits in its queue
func TestNoResendsWithoutLoss(t *testing.T) {
	for name, tuning := range map[string]kcpTuning{"tuned": kcpTuningDefault, "older": kcpTuningOlder} {
		p := newPairTuned(t, true, true, 0, KCPCarrierQueueDepth, tuning, tuning)
		run(t, p, 4000, 50)
		out, resent, held := p.creator.outputSegments.Load(), p.creator.resentSegments.Load(), p.creator.heldResends.Load()
		t.Logf("%s: %d packets out, %d of them resends, %d resends held back", name, out, resent, held)
		// the race detector's stalls (tens of ms on round trips of a few) count as due: a looser bound there
		if name == "tuned" && resent*100 > out*raceBound {
			t.Fatalf("%d of %d packets were resends with nothing lost", resent, out)
		}
	}
}

// after a lossy transfer what each session counts in flight, acked past a gap and waiting comes back to nothing (a
// count that leaked would stop the sending for good)
func TestFlightCountsSettle(t *testing.T) {
	p := newPair(t, true, true, 0.05)
	run(t, p, 2000, 200)
	p.creator.mu.Lock()
	sessions := append([]*trackKCPSession(nil), p.creator.sessions...)
	p.creator.mu.Unlock()
	deadline := time.Now().Add(10 * time.Second)
	for i, s := range sessions {
		for {
			s.kcpMu.Lock()
			flight, pending, sacked := s.flight(), s.pending, s.sacked
			s.kcpMu.Unlock()
			if flight == 0 && pending == 0 && sacked == 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("session %d: %d in flight, %d waiting, %d acked past a gap long after all arrived", i, flight, pending, sacked)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
}

// what goes ahead of the queue leaves first, and each frame's departure is known once it has left
func TestUrgentFramesGoFirst(t *testing.T) {
	secret := tunnel.DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/7777777777")
	obf, _ := tunnel.NewTunnelObfuscator(secret)
	peer, _ := tunnel.NewTunnelObfuscator(secret)
	tun := NewVP8DataTunnelWithQueue(nil, obf, func(string, ...any) {}, KCPCarrierQueueDepth)
	var mu sync.Mutex
	var order []byte
	tun.WriteFrame = func(frame []byte) error {
		if res := peer.Decode(frame); res.HasFrame && !res.Keepalive && len(res.Payload) > 0 {
			mu.Lock()
			order = append(order, res.Payload[0])
			mu.Unlock()
		}
		return nil
	}
	var places []framePlace
	for i := byte(1); i <= 5; i++ {
		place, ok := tun.trySendPlaced([]byte{i}, false)
		if !ok {
			t.Fatal("no room in the queue")
		}
		places = append(places, place)
	}
	urgent, ok := tun.trySendPlaced([]byte{9}, true)
	if !ok {
		t.Fatal("no room ahead of the queue")
	}
	if tun.departedAt(urgent) != 0 || tun.departedAt(places[0]) != 0 {
		t.Fatal("frames counted as gone before the writer ran")
	}
	tun.Start(50, 20)
	defer tun.Stop()
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		n := len(order)
		mu.Unlock()
		if n == 6 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d of 6 frames went out", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if order[0] != 9 {
		t.Fatalf("the urgent frame went out at place %v", order)
	}
	for i, place := range append(places, urgent) {
		if tun.departedAt(place) <= 0 {
			t.Fatalf("frame %d: no departure time after it went out", i)
		}
	}
	if !(tun.departedAt(urgent) <= tun.departedAt(places[0]) && tun.departedAt(places[0]) <= tun.departedAt(places[4])) {
		t.Fatal("departure times out of order")
	}
}
