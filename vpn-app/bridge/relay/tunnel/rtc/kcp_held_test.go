package rtc

import (
	"testing"
	"time"

	"whitelist-bypass/relay/tunnel"
)

// winger: a resend the guard holds (its last copy left too recently to be missed) goes out once it is due by the
// guard's own measure, not at KCP's next timer, which KCP has backed off meanwhile. Here no ack ever comes: the
// message's copies leave the carrier at once, the network round trip is set so that the guard's timeout is ~270 ms,
// KCP asks to resend at its first timeout (200 ms: held) and would ask again only at ~500 ms.
func TestHeldResendGoesWhenDue(t *testing.T) {
	k := newStillTunnel(t)
	s := k.sessions[0]
	cam := s.vp8
	k.SendData(tunnel.EncodeFrame(1, tunnel.MsgData, make([]byte, 2500))) // three segments
	sent := 0
	for deadline := time.Now().Add(time.Second); sent < 3; {
		select {
		case <-cam.sendQueue:
			cam.queued.took()
			sent++
		case <-time.After(time.Until(deadline)):
			t.Fatalf("only %d of the message's frames reached the carrier", sent)
		}
	}
	left := time.Now()
	s.kcpMu.Lock()
	s.rtt = netRTT{srtt: 100 * time.Millisecond, rttvar: 5 * time.Millisecond, peak: 250 * time.Millisecond, peakFrom: left}
	timeout := s.rtt.timeout()
	s.kcpMu.Unlock()

	select {
	case <-cam.sendQueue:
		took := time.Since(left)
		t.Logf("guard's timeout %s; the resend reached the carrier after %s (held %d)", timeout, took.Round(time.Millisecond), k.heldResends.Load())
		if took < timeout-20*time.Millisecond {
			t.Fatalf("resent after %s, before the guard's timeout %s", took.Round(time.Millisecond), timeout)
		}
		if took > timeout+120*time.Millisecond {
			t.Fatalf("resent after %s: it waited for KCP's next timer, not its own due time %s", took.Round(time.Millisecond), timeout)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the held resend never went")
	}
	if k.heldResends.Load() == 0 {
		t.Fatal("KCP's first ask was not held: the test did not test the release")
	}
}
