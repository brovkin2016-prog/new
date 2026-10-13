package main

import (
	"bytes"
	"encoding/binary"
	"math/rand"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"whitelist-bypass/relay/tunnel"
	"whitelist-bypass/relay/tunnel/rtc"
)

// winger: the creator's reliable session on its screenshare track, end to end in memory: the creator (SFURelay, as the
// server runs it) with its camera and screenshare tracks, a newer Winger with one track that keeps a session for each
// of the creator's tracks. The call may forward the screenshare to the joiner late (its slot is bound by polling), not
// at all, or stop forwarding it midway.

type shareWire struct {
	mu     sync.Mutex
	rnd    *rand.Rand
	loss   float64
	deaf   atomic.Bool // the call forwards nothing on this track
	frames atomic.Int64
	to     func([]byte)
}

func (w *shareWire) send(frame []byte) error {
	w.frames.Add(1)
	if w.deaf.Load() {
		return nil
	}
	w.mu.Lock()
	drop := w.rnd.Float64() < w.loss
	to := w.to
	w.mu.Unlock()
	if !drop && to != nil {
		to(append([]byte(nil), frame...))
	}
	return nil
}

// setTo: where the call delivers this track now (a reconnected joiner's new track).
func (w *shareWire) setTo(to func([]byte)) {
	w.mu.Lock()
	w.to = to
	w.mu.Unlock()
}

// joinerEnd: what the joiner's relay gets, per connection: data in order, and whether it was closed.
type joinerEnd struct {
	mu     sync.Mutex
	got    map[uint32][][]byte
	closed map[uint32]bool
	damage []string
}

func (e *joinerEnd) take(data []byte) {
	tunnel.DecodeFrames(data, func(conn uint32, msgType byte, payload []byte) {
		e.mu.Lock()
		defer e.mu.Unlock()
		switch msgType {
		case tunnel.MsgData:
			if e.closed[conn] {
				return // after its close: the joiner's relay drops it too
			}
			i := len(e.got[conn])
			if !bytes.Equal(payload, shareMsgBody(conn, i)) {
				e.damage = append(e.damage, "connection "+string(rune('A'+conn%26))+": message out of order or damaged")
				return
			}
			e.got[conn] = append(e.got[conn], append([]byte(nil), payload...))
		case tunnel.MsgClose:
			e.closed[conn] = true
		}
	})
}

func (e *joinerEnd) count(conn uint32) (int, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.got[conn]), e.closed[conn]
}

func shareMsgBody(conn uint32, i int) []byte {
	body := bytes.Repeat([]byte{byte(conn), byte(i)}, 300)
	binary.BigEndian.PutUint32(body[0:4], uint32(i))
	return body
}

type shareRig struct {
	relay           *SFURelay
	creator         *rtc.MultiTrackKCPTunnel
	joiner          *rtc.MultiTrackKCPTunnel
	share           *rtc.VP8DataTunnel
	camW, shareW    *shareWire
	pub             *rtc.VP8DataTunnel // the joiner's track
	pubW            *shareWire
	end             *joinerEnd
	closedByCreator sync.Map
	connected       chan *rtc.MultiTrackKCPTunnel
	secret          []byte
	joinerObf       *tunnel.TunnelObfuscator
	joinerHeard     atomic.Int32 // the joiner's tunnel saw the creator's start afresh (a new epoch)
	mu              sync.Mutex
	stops           []func()
}

var quietLog = func(string, ...any) {}

// newShareRig: the joiner connects and says it keeps a session per track (ConfigKCPEveryTrack); the creator turns its
// screenshare track on as the server does when the sharing data channel opens. The joiner's track reaches the creator
// the way the server reads it (handleVideoFrame).
func newShareRig(t *testing.T, loss float64) *shareRig {
	t.Helper()
	rig := &shareRig{end: &joinerEnd{got: map[uint32][][]byte{}, closed: map[uint32]bool{}},
		connected: make(chan *rtc.MultiTrackKCPTunnel, 4), secret: tunnel.DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/4242424242")}
	t.Cleanup(func() {
		rig.mu.Lock()
		defer rig.mu.Unlock()
		for _, stop := range rig.stops {
			stop()
		}
	})
	rig.creatorUp(loss)
	jobf, _ := tunnel.NewTunnelObfuscator(rig.secret)
	rig.joinerConnects(t, jobf, loss)
	// the sharing data channel opens: its track and, the joiner keeping a session for it, its reliable session
	rig.relay.addShareSub(rig.share)
	return rig
}

func (rig *shareRig) onStop(stop func()) {
	rig.mu.Lock()
	rig.stops = append(rig.stops, stop)
	rig.mu.Unlock()
}

// creatorUp: the creator's relay as initRelay makes it (an epoch of its own) with its camera and screenshare tracks,
// reaching the joiner's track if there is one; called again, the creator starts afresh (its call connection came
// back) under the same joiner.
func (rig *shareRig) creatorUp(loss float64) {
	cobf, _ := tunnel.NewTunnelObfuscator(rig.secret)
	cam := rtc.NewVP8DataTunnelWithQueue(nil, cobf, quietLog, rtc.KCPCarrierQueueDepth)
	share := rtc.NewVP8DataTunnelWithQueue(nil, cobf, quietLog, rtc.KCPCarrierQueueDepth)
	rig.share = share
	rig.camW = &shareWire{rnd: rand.New(rand.NewSource(11)), loss: loss}
	rig.shareW = &shareWire{rnd: rand.New(rand.NewSource(12)), loss: loss}
	if rig.pub != nil {
		rig.camW.setTo(rig.pub.HandleFrame)
		rig.shareW.setTo(rig.pub.HandleFrame)
	}
	cam.WriteFrame, share.WriteFrame = rig.camW.send, rig.shareW.send

	r := NewSFURelay()
	r.SetObfuscator(cobf)
	r.tun = cam
	r.mt = rtc.NewMultiTrackTunnel([]*rtc.VP8DataTunnel{cam})
	r.mt.Start(50, 20)
	rig.onStop(r.mt.Stop)
	r.OnConnected = func(tun tunnel.DataTunnel) {
		k := tun.(*rtc.MultiTrackKCPTunnel)
		rig.onStop(k.Stop)
		// the creator's relay: the joiner's config, and a close this side's relay is told of
		k.SetOnData(func(data []byte) {
			tunnel.DecodeFrames(data, func(conn uint32, msgType byte, payload []byte) {
				switch {
				case conn == tunnel.ControlConnID && msgType == tunnel.MsgConfig:
					r.SetKCPOnShare(tunnel.VP8ConfigFlags(payload)&tunnel.ConfigKCPEveryTrack != 0)
				case msgType == tunnel.MsgClose:
					rig.closedByCreator.Store(conn, true)
				}
			})
		})
		rig.connected <- k
	}
	mt := r.mt
	mt.SetOnData(func(payload []byte) { r.activate(mt, payload) })
	rig.relay = r
	if rig.pubW != nil {
		rig.pubW.setTo(r.handleVideoFrame)
	}
}

// joinerConnects: the joiner's track and reliable layer as initPC makes them (a session per creator track, sending on
// the first), its config, and the creator's tunnel that comes of it. obf: the joiner's tunnel identity (its epoch).
func (rig *shareRig) joinerConnects(t *testing.T, obf *tunnel.TunnelObfuscator, loss float64) {
	t.Helper()
	rig.joinerUp(obf, loss)
	select {
	case rig.creator = <-rig.connected:
	case <-time.After(10 * time.Second):
		t.Fatal("the creator never took the joiner's config")
	}
}

// joinerUp: the joiner's side of joinerConnects, without waiting for the creator.
func (rig *shareRig) joinerUp(obf *tunnel.TunnelObfuscator, loss float64) {
	rig.joinerObf = obf
	pub := rtc.NewVP8DataTunnelWithQueue(nil, obf, quietLog, rtc.KCPCarrierQueueDepth)
	rig.pub = pub
	rig.pubW = &shareWire{rnd: rand.New(rand.NewSource(13)), loss: loss, to: rig.relay.handleVideoFrame}
	pub.WriteFrame = rig.pubW.send
	jmt := rtc.NewMultiTrackTunnel([]*rtc.VP8DataTunnel{pub})
	jmt.SetOnPeerRestart(func() { rig.joinerHeard.Add(1) })
	jmt.Start(50, 20)
	rig.joiner = rtc.NewMultiTrackKCPTunnel(jmt, nil)
	rig.onStop(rig.joiner.Stop)
	rig.joiner.AddSession(pub)
	rig.joiner.SetSendSessions(1)
	rig.joiner.SetOnData(rig.end.take)
	// winger: the creator's tracks reach the new track only once it is wired: the creator's writers would otherwise
	// hand it frames while its tunnels are still being built (a data race)
	rig.camW.setTo(pub.HandleFrame)
	rig.shareW.setTo(pub.HandleFrame)
	rig.joiner.SendData(tunnel.EncodeVP8ConfigFlags(50, 20, 2, tunnel.ConfigKCPEveryTrack))
}

// waitReady: the creator's screenshare session is in use.
func (rig *shareRig) waitReady(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for rig.creator.ReadySessions() < 2 {
		if time.Now().After(deadline) {
			t.Fatal("the screenshare session was never taken into use")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// send: `per` messages on each of the connections, one after another as the relay's read loops would.
func (rig *shareRig) send(conns []uint32, per int) {
	creator := rig.creator
	var wg sync.WaitGroup
	for _, c := range conns {
		wg.Add(1)
		go func(conn uint32) {
			defer wg.Done()
			for i := 0; i < per; i++ {
				creator.SendData(tunnel.EncodeFrame(conn, tunnel.MsgData, shareMsgBody(conn, i)))
			}
		}(c)
	}
	wg.Wait()
}

// waitAll: every connection gets all `per` messages, or (allowClose) is closed on both ends without a gap before.
func (rig *shareRig) waitAll(t *testing.T, conns []uint32, per int, within time.Duration, allowClose bool) (closed int) {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		done, closed := 0, 0
		var stuck []uint32
		for _, c := range conns {
			n, wasClosed := rig.end.count(c)
			_, creatorClosed := rig.closedByCreator.Load(c)
			switch {
			case n == per:
				done++
			case allowClose && wasClosed && creatorClosed:
				closed++
			default:
				stuck = append(stuck, c)
			}
		}
		rig.end.mu.Lock()
		damage := append([]string(nil), rig.end.damage...)
		rig.end.mu.Unlock()
		if len(damage) > 0 {
			t.Fatalf("%d damaged deliveries, first: %s", len(damage), damage[0])
		}
		if len(stuck) == 0 {
			return closed
		}
		if time.Now().After(deadline) {
			for _, c := range stuck {
				n, wasClosed := rig.end.count(c)
				t.Errorf("connection %d: %d of %d messages, closed at the joiner %v", c, n, per, wasClosed)
			}
			t.FailNow()
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func connRange(from, n int) []uint32 {
	out := make([]uint32, n)
	for i := range out {
		out[i] = uint32(from + i)
	}
	return out
}

// The call does not forward the screenshare to the joiner (its slot not bound yet, or never): nothing may wait for it.
// A connection put on the screenshare session before the joiner was heard on it would hang for as long.
func TestShareSessionUnheardCarriesNothing(t *testing.T) {
	rig := newShareRig(t, 0.01)
	rig.shareW.deaf.Store(true)
	conns := connRange(1, 16)
	go rig.send(conns, 60)
	rig.waitAll(t, conns, 60, 20*time.Second, false)
}

// The screenshare reaches the joiner a few seconds late (as when its slot is bound by the joiner's polling): the
// connections opened meanwhile do not wait for it, and once it is heard it carries its half.
func TestShareSessionLateBindingNoWait(t *testing.T) {
	rig := newShareRig(t, 0.01)
	rig.shareW.deaf.Store(true)
	first := connRange(1, 8)
	start := time.Now()
	go rig.send(first, 20)
	rig.waitAll(t, first, 20, 20*time.Second, false)
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("connections opened before the screenshare was forwarded took %s", took)
	}
	rig.shareW.deaf.Store(false)
	deadline := time.Now().Add(10 * time.Second)
	for rig.creator.ReadySessions() < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("the screenshare session was never taken into use once forwarded")
		}
		time.Sleep(20 * time.Millisecond)
	}
	before := rig.shareW.frames.Load()
	later := connRange(101, 8)
	go rig.send(later, 200)
	rig.waitAll(t, later, 200, 30*time.Second, false)
	if rig.shareW.frames.Load()-before < 200 {
		t.Fatalf("the screenshare track carried almost nothing once forwarded (%d frames)", rig.shareW.frames.Load()-before)
	}
}

// Many configs and the data channel's opening at once (the joiner resends its config until acknowledged): one
// screenshare session, never a third the joiner does not have.
func TestShareSessionAddedOnce(t *testing.T) {
	quiet := func(string, ...any) {}
	obf, _ := tunnel.NewTunnelObfuscator(tunnel.DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/1010101010"))
	for iter := 0; iter < 3000; iter++ {
		cam := rtc.NewVP8DataTunnel(nil, obf, quiet)
		share := rtc.NewVP8DataTunnel(nil, obf, quiet)
		k := rtc.NewMultiTrackKCPTunnel(rtc.NewMultiTrackTunnel([]*rtc.VP8DataTunnel{cam}), nil)
		r := NewSFURelay()
		r.delivered = k
		r.shareSub = share
		start := make(chan struct{})
		var wg sync.WaitGroup
		for g := 0; g < 8; g++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				r.SetKCPOnShare(true)
			}()
		}
		close(start)
		wg.Wait()
		n := k.SessionCount()
		k.Stop()
		if n != 2 {
			t.Fatalf("iteration %d: %d reliable sessions for two tracks", iter, n)
		}
	}
}

// The joiner turns the screenshare off while a download runs on it: what was on its session is closed on both ends,
// never handed on with a piece missing; the other connections finish.
func TestShareSessionRemovedUnderLoad(t *testing.T) {
	rig := newShareRig(t, 0)
	rig.waitReady(t)
	conns := connRange(1, 8)
	go func() {
		time.Sleep(300 * time.Millisecond)
		rig.relay.RemoveSharingDataChannel()
	}()
	go rig.send(conns, 400)
	closed := rig.waitAll(t, conns, 400, 30*time.Second, true)
	t.Logf("%d of %d connections closed with the screenshare session", closed, len(conns))
}

// The call stops forwarding the screenshare midway: the connections on it are closed on both ends instead of hanging,
// and connections opened afterwards go where the joiner hears.
func TestShareSessionGoesDeafMidway(t *testing.T) {
	rig := newShareRig(t, 0.01)
	rig.waitReady(t)
	conns := connRange(1, 8)
	go func() {
		time.Sleep(300 * time.Millisecond)
		rig.shareW.deaf.Store(true)
	}()
	go rig.send(conns, 400)
	closed := rig.waitAll(t, conns, 400, 40*time.Second, true)
	if closed == 0 {
		t.Fatalf("no connection was on the screenshare session")
	}
	later := connRange(201, 8)
	start := time.Now()
	go rig.send(later, 20)
	rig.waitAll(t, later, 20, 20*time.Second, false)
	t.Logf("%d connections closed with the deaf session; later ones took %s", closed, time.Since(start))
}
