package rtc

import (
	"testing"
	"time"

	"whitelist-bypass/relay/tunnel"
)

// winger: a layer stopped under carriers that a new layer takes over (the Telemost creator's resetForNewPeer, WB
// Stream's and Bitrix24's rearm) puts nothing more on them. The old relay's goroutines still send through it (the
// closes of their connections once their targets are closed, data that was on the way), and KCP puts out what it is
// given and any resend due whenever it is given something: on the shared tracks, with the conv the new layer uses, the
// new far side takes it for the new layer's own.
func TestStoppedLayerPutsNothingOut(t *testing.T) {
	k := newStillTunnel(t)
	cam := k.sessions[0].vp8
	k.SendData(tunnel.EncodeFrame(1, tunnel.MsgData, make([]byte, 2500))) // unacked: resends come due
	for len(cam.sendQueue) > 0 {
		<-cam.sendQueue
		cam.queued.took()
	}
	k.StopLayer()
	time.Sleep(300 * time.Millisecond) // KCP's first resend is due at 200 ms
	k.SendData(tunnel.EncodeFrame(1, tunnel.MsgClose, nil))
	k.SendData(tunnel.EncodeFrame(2, tunnel.MsgData, []byte("late data")))
	k.SendData(tunnel.EncodeFrame(3, tunnel.MsgUDPReply, []byte("late datagram")))
	time.Sleep(50 * time.Millisecond)
	if n := len(cam.sendQueue) + len(cam.urgent); n != 0 {
		t.Fatalf("the stopped layer put %d frames on its carrier", n)
	}
}
