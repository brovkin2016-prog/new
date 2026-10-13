package rtc

import (
	"testing"
	"time"

	"whitelist-bypass/relay/tunnel"
)

// winger: a step of the wall clock (an NTP or network time correction on a phone, a laptop that wakes up) must not
// stop the tunnel. The times the reliable layer keeps (when a copy left the carrier, the far side's last word) and the
// carrier's last keyframe were wall-clock readings: after a backward step every copy that left before it looked as if
// it left in the future, and with nothing sent after it acked the guard held its resend for as long as the step; KCP
// delivers in order, so the whole session stood still. Here the step is made the way it showed: the departures taken
// before it are that much later than the clock the layer reads.

const clockStep = 3 * time.Second

func TestHeldResendAfterClockStep(t *testing.T) {
	k := newStillTunnel(t)
	s := k.sessions[0]
	cam := s.vp8
	k.SendData(tunnel.EncodeFrame(1, tunnel.MsgData, make([]byte, 2500))) // three segments
	var seqs []uint64
	for deadline := time.Now().Add(time.Second); len(seqs) < 3; {
		select {
		case <-cam.sendQueue:
			cam.queued.took()
			seqs = append(seqs, cam.queued.out.Load())
		case <-time.After(time.Until(deadline)):
			t.Fatalf("only %d of the message's frames reached the carrier", len(seqs))
		}
	}
	for _, seq := range seqs {
		at := &cam.queued.at[seq%departRing]
		at.Store(at.Load() + int64(clockStep))
	}
	s.kcpMu.Lock()
	s.rtt = netRTT{srtt: 100 * time.Millisecond, rttvar: 5 * time.Millisecond, peak: 120 * time.Millisecond, peakFrom: time.Now()}
	s.kcpMu.Unlock()
	start := time.Now()
	select {
	case <-cam.sendQueue:
	case <-cam.urgent:
	case <-time.After(clockStep - 500*time.Millisecond):
		t.Fatalf("no resend within %s after a clock step of %s (held %d)", clockStep-500*time.Millisecond, clockStep, k.heldResends.Load())
	}
	t.Logf("the first resend after %s", time.Since(start).Round(time.Millisecond))
}

// the times the layer keeps are on a clock no step moves
func TestDeparturesOnMonotonicClock(t *testing.T) {
	var d departures
	seq := d.put()
	before := monoNow()
	d.took()
	after := monoNow()
	if at := d.when(seq); at < before || at > after {
		t.Fatalf("departure %d is not on the layer's clock [%d, %d]", at, before, after)
	}
}

// the call's server asks for a keyframe just after a clock step: it is answered, not refused for as long as the step
func TestKeyframeRequestAfterClockStep(t *testing.T) {
	tun, log, _ := busyTunnel(t)
	from := log.len()
	if !tun.RequestKeyframe() {
		t.Fatal("the first request was refused")
	}
	waitFor(t, "the asked keyframe", func() bool { k, _ := log.keyframesSince(from); return k > 0 })
	time.Sleep(keyframeMinInterval + 100*time.Millisecond)
	tun.lastKeyframe.Store(tun.lastKeyframe.Load() + int64(clockStep))
	if !tun.RequestKeyframe() {
		t.Fatalf("a request %s after the last keyframe was refused after a clock step of %s", keyframeMinInterval+100*time.Millisecond, clockStep)
	}
}
