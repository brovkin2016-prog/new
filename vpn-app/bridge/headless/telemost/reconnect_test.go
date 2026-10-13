package main

import (
	"testing"
	"time"

	"whitelist-bypass/relay/tunnel"
)

// winger: the joiner's call connection drops and it comes back (the same Winger, initPC makes it a new tunnel): its
// reliable layer starts from the first segment again. It comes back with a new epoch (renewEpoch), which the creator
// takes as a new joiner and starts afresh too: everything works again, on both tracks. With the old epoch the creator
// kept its reliable sessions, which took every new segment as one they already had: nothing got through either way
// until Winger was restarted.
func TestJoinerReconnectStartsAfresh(t *testing.T) {
	rig := newShareRig(t, 0.01)
	rig.waitReady(t)
	first := connRange(1, 8)
	go rig.send(first, 300)
	rig.waitAll(t, first, 300, 30*time.Second, false)

	rig.joiner.Stop()
	obf, _ := tunnel.NewTunnelObfuscator(rig.secret) // what renewEpoch makes
	rig.joinerConnects(t, obf, 0.01)
	rig.waitReady(t)
	later := connRange(301, 8)
	start := time.Now()
	go rig.send(later, 100)
	rig.waitAll(t, later, 100, 20*time.Second, false)
	t.Logf("after the reconnect: %d connections x 100 messages in %s", len(later), time.Since(start).Round(time.Millisecond))
}

// The creator's old reliable layer, stopped when the joiner came back as a new joiner, still gets what the old relay's
// goroutines send through it: the closes of the old connections once Reset closed their targets. None of it may reach
// the new joiner: the old layer is young (its numbers within the new joiner's window) and the new joiner would take it
// for the new layer's own, the new layer's segments of the same numbers then dropped as repeats.
func TestJoinerReconnectOldLayerSilent(t *testing.T) {
	rig := newShareRig(t, 0)
	rig.waitReady(t)
	first := connRange(1, 8)
	go rig.send(first, 10)
	rig.waitAll(t, first, 10, 20*time.Second, false)
	time.Sleep(time.Second) // a quiet tunnel before the drop: the old layer's update loop idles

	old := rig.creator
	rig.joiner.Stop()
	obf, _ := tunnel.NewTunnelObfuscator(rig.secret)
	rig.joinerConnects(t, obf, 0)
	for _, c := range first {
		old.SendData(tunnel.EncodeFrame(c, tunnel.MsgClose, nil))
	}
	rig.waitReady(t)
	later := connRange(301, 8)
	go rig.send(later, 100)
	rig.waitAll(t, later, 100, 20*time.Second, false)
}
