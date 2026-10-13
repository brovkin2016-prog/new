package rtc

import (
	"sync"
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

// what waits on a carrier is thrown away (the Telemost creator's reset for a new joiner): none of it goes out, and a
// frame put in afterwards keeps its place (its departure is known once it has left, not before)
func TestDropQueuedKeepsPlaces(t *testing.T) {
	secret := tunnel.DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/8989898989")
	obf, _ := tunnel.NewTunnelObfuscator(secret)
	peer, _ := tunnel.NewTunnelObfuscator(secret)
	tun := NewVP8DataTunnelWithQueue(nil, obf, func(string, ...any) {}, KCPCarrierQueueDepth)
	var mu sync.Mutex
	var sent []byte
	tun.WriteFrame = func(frame []byte) error {
		if res := peer.Decode(frame); res.HasFrame && !res.Keepalive && len(res.Payload) > 0 {
			mu.Lock()
			sent = append(sent, res.Payload[0])
			mu.Unlock()
		}
		return nil
	}
	for i := byte(1); i <= 20; i++ {
		tun.trySendPlaced([]byte{i}, false)
	}
	tun.trySendPlaced([]byte{99}, true)
	tun.Start(2, 1) // a frame each half second: nothing goes before the drop
	defer tun.Stop()
	if n := tun.DropQueued(); n != 21 {
		t.Fatalf("%d frames thrown away, want 21", n)
	}
	place, ok := tun.trySendPlaced([]byte{42}, false)
	if !ok || tun.departedAt(place) != 0 {
		t.Fatalf("a frame put in after the drop counted as gone before it went")
	}
	tun.Reconfigure(50, 20)
	waitUntil(t, "the frame to go out", func() bool { return tun.departedAt(place) > 0 })
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(sent) != 1 || sent[0] != 42 {
		t.Fatalf("frames sent after the drop: %v, want only the one put in after it", sent)
	}
}
