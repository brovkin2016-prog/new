package main

import (
	"testing"
	"time"

	"whitelist-bypass/relay/tunnel"
)

// winger: the creator's call connection comes back (its WebSocket reconnects to the same call: initRelay makes a new
// relay with an epoch of its own and a fresh reliable layer) under a joiner that keeps its tunnel. The joiner's
// reliable sessions are far past where the creator's new ones start: neither side takes the other's segments and the
// tunnel hangs until Winger is restarted, with nothing on the joiner's side noticing. The creator now speaks first on
// its new tunnel, so the joiner sees at once that it started afresh (and reconnects as a new joiner, renewEpoch);
// after that everything works again.
func TestCreatorRestartJoinerNotices(t *testing.T) {
	rig := newShareRig(t, 0.01)
	rig.waitReady(t)
	// the joiner has sent more than a window of segments (a page's requests, an upload)
	for i := 0; i < 400; i++ {
		rig.joiner.SendData(tunnel.EncodeFrame(uint32(1000+i%8), tunnel.MsgData, shareMsgBody(uint32(1000+i%8), i/8)))
	}
	first := connRange(1, 8)
	go rig.send(first, 100)
	rig.waitAll(t, first, 100, 30*time.Second, false)

	rig.creatorUp(0.01)
	heardBefore := rig.joinerHeard.Load()
	// the user opens a page: the joiner's request goes on its old tunnel to the creator's new one
	rig.joiner.SendData(tunnel.EncodeFrame(2001, tunnel.MsgConnect, []byte("example.com:443")))
	deadline := time.Now().Add(3 * time.Second)
	for rig.joinerHeard.Load() == heardBefore {
		if time.Now().After(deadline) {
			t.Fatal("the joiner's tunnel never saw that the creator started afresh: it would hang until Winger is restarted")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// the joiner reconnects as a new joiner (renewEpoch); the creator's sharing data channel opens again. The tunnel
	// the new creator made for the old joiner's request is of no more use.
	for len(rig.connected) > 0 {
		<-rig.connected
	}
	rig.joiner.Stop()
	obf, _ := tunnel.NewTunnelObfuscator(rig.secret)
	rig.joinerConnects(t, obf, 0.01)
	rig.relay.addShareSub(rig.share)
	rig.waitReady(t)
	later := connRange(301, 8)
	go rig.send(later, 100)
	rig.waitAll(t, later, 100, 20*time.Second, false)
}
