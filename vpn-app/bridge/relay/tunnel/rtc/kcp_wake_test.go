package rtc

import (
	"testing"
	"time"
)

// winger: the update loop is nudged only when it has gone idle (500 ms ticks); new data and new segments must still
// bring it back, and the acknowledgements it flushes must not wait for an idle tick.

func waitIdleState(t *testing.T, what string, limit time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// an idle update loop is nudged back to its 10 ms pace by the next message sent and by the next segment received
func TestIdleUpdateLoopWoken(t *testing.T) {
	p := newPair(t, false, false, 0)
	atJoiner := newSide(2)
	p.joiner.SetOnData(atJoiner.take)
	p.creator.SetOnData(func([]byte) {})
	waitIdleState(t, "the creator's update loop going idle", 3*time.Second, p.creator.updateIdle.Load)
	p.creator.SendData(msg(1, 0))
	waitIdleState(t, "the update loop woken by a send", time.Second, func() bool { return !p.creator.updateIdle.Load() })
	waitIdleState(t, "the joiner's update loop going idle", 3*time.Second, p.joiner.updateIdle.Load)
	p.creator.SendData(msg(1, 1))
	waitIdleState(t, "the joiner's loop woken by what it received", time.Second, func() bool { return !p.joiner.updateIdle.Load() })
	select {
	case <-atJoiner.done:
	case <-time.After(5 * time.Second):
		t.Fatal("messages sent to an idle pair did not arrive")
	}
}

// a message to an idle joiner is acknowledged within a few quick ticks, not at the idle loop's next 500 ms tick
// (acks are gathered for the next flush, so the flush must come)
func TestAckFromIdleSideIsPrompt(t *testing.T) {
	p := newPair(t, false, false, 0)
	p.joiner.SetOnData(func([]byte) {})
	p.creator.SetOnData(func([]byte) {})
	for round := 0; round < 3; round++ {
		waitIdleState(t, "both update loops going idle", 3*time.Second, func() bool {
			return p.creator.updateIdle.Load() && p.joiner.updateIdle.Load()
		})
		start := time.Now()
		p.creator.SendData(msg(1, round))
		waitIdleState(t, "the creator's message acknowledged", 2*time.Second, func() bool {
			return p.creator.sessions[0].waitSnd() == 0
		})
		took := time.Since(start)
		t.Logf("round %d: acknowledged after %s", round, took.Round(time.Millisecond))
		if took > 250*time.Millisecond {
			t.Fatalf("round %d: the ack took %s: it waited for an idle tick", round, took.Round(time.Millisecond))
		}
	}
}
