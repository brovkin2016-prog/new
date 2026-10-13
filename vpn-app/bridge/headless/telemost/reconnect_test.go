package main

import (
	"sync/atomic"
	"testing"
	"time"

	"whitelist-bypass/relay/tunnel"
	"whitelist-bypass/relay/tunnel/rtc"
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

// The call drops mid-download and the joiner comes back as a new joiner; the creator's camera reaches the new joiner
// 1.5 s before the new joiner's track reaches the creator (its subscription is bound later), so meanwhile the creator's
// old layer goes on sending, to the new joiner. None of it may be taken by the new joiner's sessions: the old layer's
// cumulative ack counted the new joiner's first segments (its config, lost on the way) as delivered though the creator
// never got them, and they never went again; its data took the places of the new layer's.
func TestJoinerReconnectOldLayerStillSending(t *testing.T) {
	rig := newShareRig(t, 0)
	rig.waitReady(t)
	first := connRange(1, 8)
	go rig.send(first, 10)
	rig.waitAll(t, first, 10, 20*time.Second, false)

	old := rig.creator
	stop := make(chan struct{})
	defer close(stop)
	go func() { // a download of the old joiner's, its target still sending
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			case <-old.Done():
				return
			default:
			}
			old.SendData(tunnel.EncodeFrame(100, tunnel.MsgData, shareMsgBody(100, i)))
		}
	}()
	time.Sleep(100 * time.Millisecond)
	rig.joiner.Stop()
	obf, _ := tunnel.NewTunnelObfuscator(rig.secret)
	rig.pubDeaf = true
	rig.joinerUp(obf, 0)
	time.Sleep(1500 * time.Millisecond)
	rig.pubW.deaf.Store(false)
	select {
	case rig.creator = <-rig.connected:
	case <-time.After(10 * time.Second):
		t.Fatal("the creator never heard the new joiner")
	}
	rig.waitReady(t)
	later := connRange(301, 8)
	go rig.send(later, 100)
	rig.waitAll(t, later, 100, 20*time.Second, false)
}

// The reset for a new joiner throws away what the stopped layer still had queued on the tracks: none of it goes out
// afterwards, where it would reach the new joiner first (an older Winger takes it for its new layer's own).
func TestResetDropsTheOldLayersFrames(t *testing.T) {
	secret := tunnel.DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/6767676767")
	cobf, _ := tunnel.NewTunnelObfuscator(secret)
	jobf, _ := tunnel.NewTunnelObfuscator(secret)
	var data atomic.Int64
	cam := rtc.NewVP8DataTunnelWithQueue(nil, cobf, quietLog, rtc.KCPCarrierQueueDepth)
	cam.WriteFrame = func(frame []byte) error {
		if frame[0]&0x01 != 0 { // an interframe: data, not a keepalive
			data.Add(1)
		}
		return nil
	}
	r := NewSFURelay()
	r.SetObfuscator(cobf)
	r.tun = cam
	r.mt = rtc.NewMultiTrackTunnel([]*rtc.VP8DataTunnel{cam})
	r.mt.Start(2, 1) // two frames a second: what the layer puts out waits in the queue
	defer r.mt.Stop()
	layers := make(chan *rtc.MultiTrackKCPTunnel, 1)
	r.OnConnected = func(tun tunnel.DataTunnel) {
		k := tun.(*rtc.MultiTrackKCPTunnel)
		k.SetOnData(func([]byte) {})
		layers <- k
	}
	mt := r.mt
	mt.SetOnData(func(payload []byte) { r.activate(mt, payload) })

	pub := rtc.NewVP8DataTunnelWithQueue(nil, jobf, quietLog, rtc.KCPCarrierQueueDepth)
	pub.WriteFrame = func(frame []byte) error { r.handleVideoFrame(frame); return nil }
	jmt := rtc.NewMultiTrackTunnel([]*rtc.VP8DataTunnel{pub})
	jmt.Start(50, 20)
	joiner := rtc.NewMultiTrackKCPTunnel(jmt, nil)
	defer joiner.Stop()
	joiner.SendData(tunnel.EncodeVP8ConfigFlags(50, 20, 1, 0))
	var layer *rtc.MultiTrackKCPTunnel
	select {
	case layer = <-layers:
	case <-time.After(10 * time.Second):
		t.Fatal("the creator never took the joiner's first segment")
	}
	for i := 0; i < 40; i++ {
		layer.SendData(tunnel.EncodeFrame(7, tunnel.MsgData, make([]byte, 500)))
	}
	time.Sleep(100 * time.Millisecond)
	joiner.Stop() // the old joiner is gone (it would resend its config, and a new layer's frames would count here)
	r.resetForNewPeer()
	before := data.Load()
	r.mt.Reconfigure(50, 20) // the writer at full pace: whatever still waits goes out at once
	time.Sleep(500 * time.Millisecond)
	if n := data.Load() - before; n > 1 {
		t.Fatalf("%d frames of the stopped layer went out after the reset", n)
	}
}

// The creator put a burst on its tracks just before the call dropped, and the joiner comes back as a new joiner, its
// first frames lost on the way. What the stopped layer had queued on the tracks (up to the queue's 1024 frames) went
// out to the new joiner after the reset: its cumulative ack counted the new joiner's config as delivered, and the
// creator's new layer, which never got it, waited at the hole for good. Also for a Winger before the epoch convs, which
// takes the creator's frames on the usual convs only.
func TestJoinerReconnectAfterQueuedBurst(t *testing.T) {
	for _, older := range []bool{true, false} {
		rig := newShareRigOf(t, 0, older)
		rig.waitReady(t)
		for i := 0; i < 20; i++ { // the old joiner uploaded a little
			rig.joiner.SendData(tunnel.EncodeFrame(uint32(1000+i%4), tunnel.MsgData, shareMsgBody(uint32(1000+i%4), i/4)))
		}
		first := connRange(1, 8)
		go rig.send(first, 25)
		rig.waitAll(t, first, 25, 20*time.Second, false)

		old := rig.creator
		for i := 0; i < 200; i++ {
			old.SendData(tunnel.EncodeFrame(100, tunnel.MsgData, shareMsgBody(100, i)))
		}
		rig.joiner.Stop()
		obf, _ := tunnel.NewTunnelObfuscator(rig.secret)
		rig.pubDeaf = true
		rig.joinerUp(obf, 0)
		time.Sleep(50 * time.Millisecond) // its first frames are lost
		rig.pubW.deaf.Store(false)
		select {
		case rig.creator = <-rig.connected:
		case <-time.After(10 * time.Second):
			t.Fatalf("older Winger %v: the creator never heard the new joiner", older)
		}
		rig.waitReady(t)
		later := connRange(301, 8)
		go rig.send(later, 100)
		rig.waitAll(t, later, 100, 20*time.Second, false)
	}
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
