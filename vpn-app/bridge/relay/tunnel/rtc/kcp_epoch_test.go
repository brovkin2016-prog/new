package rtc

import (
	"math/rand"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"whitelist-bypass/relay/tunnel"
)

// winger: a joiner that comes back as a new joiner (a new tunnel, a new epoch) while the creator's layer for its
// earlier tunnel still sends on the same tracks (the creator has not seen the new joiner yet): nothing of that layer is
// taken by the new joiner's sessions. KCP takes a packet's cumulative ack (una) before anything else: the old layer's
// would count the new joiner's first segments (its config) as delivered though the creator never got them, and they
// would never go again; its data would take the places of the new layer's.

// switchWire: a track whose far end can change (the creator's tracks reach the reconnected joiner's new one).
type switchWire struct {
	mu sync.Mutex
	to func([]byte)
}

func (w *switchWire) send(frame []byte) error {
	w.mu.Lock()
	to := w.to
	w.mu.Unlock()
	if to != nil {
		to(append([]byte(nil), frame...))
	}
	return nil
}

func (w *switchWire) set(to func([]byte)) {
	w.mu.Lock()
	w.to = to
	w.mu.Unlock()
}

// staleLayerReachesNewJoiner: the creator's layer served a joiner that uploaded `uploads` messages, with parity and (epochs)
// on the joiner's epoch convs; the joiner comes back, its track not reaching the creator, while the old layer goes on
// sending. What the new joiner's first session still has to send after 3 s, and how many messages it was handed.
func staleLayerReachesNewJoiner(t *testing.T, epochs bool, uploads int) (waiting int, handed int64) {
	t.Helper()
	secret := tunnel.DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/2323232323")
	cobf, _ := tunnel.NewTunnelObfuscator(secret)
	j1obf, _ := tunnel.NewTunnelObfuscator(secret)
	j2obf, _ := tunnel.NewTunnelObfuscator(secret)
	quiet := func(string, ...any) {}
	cam := NewVP8DataTunnelWithQueue(nil, cobf, quiet, KCPCarrierQueueDepth)
	share := NewVP8DataTunnelWithQueue(nil, cobf, quiet, KCPCarrierQueueDepth)
	pub1 := NewVP8DataTunnelWithQueue(nil, j1obf, quiet, KCPCarrierQueueDepth)
	camW, shareW := &switchWire{to: pub1.HandleFrame}, &switchWire{to: pub1.HandleFrame}
	cam.WriteFrame, share.WriteFrame = camW.send, shareW.send
	pub1.WriteFrame = (&lossyWire{rnd: rand.New(rand.NewSource(1)), to: cam.HandleFrame}).send

	cmt := NewMultiTrackTunnel([]*VP8DataTunnel{cam})
	cmt.Start(50, 20)
	k1 := NewMultiTrackKCPTunnel(cmt, nil)
	cmt.AddSubTunnel(share)
	k1.AddSession(share)
	j1mt := NewMultiTrackTunnel([]*VP8DataTunnel{pub1})
	j1mt.Start(50, 20)
	j1 := NewMultiTrackKCPTunnel(j1mt, nil)
	j1.AddSession(pub1)
	j1.SetSendSessions(1)
	t.Cleanup(func() { k1.Stop(); j1.Stop() })
	if epochs {
		j1.AcceptEpochConv(j1obf.LocalEpoch())
		k1.UseEpochConv(j1obf.LocalEpoch())
	}
	k1.SetFEC(true)

	atJoiner, atCreator := newSide(300), newSide(uploads)
	j1.SetOnData(atJoiner.take)
	k1.SetOnData(atCreator.take)
	for i := 0; i < uploads; i++ {
		j1.SendData(msg(uint32(1+i%4), i/4))
	}
	for i := 0; i < 300; i++ {
		k1.SendData(msg(uint32(1+i%16), i/16))
	}
	for _, s := range []*side{atJoiner, atCreator} {
		select {
		case <-s.done:
		case <-time.After(30 * time.Second):
			t.Fatal("the first tunnel did not carry everything")
		}
	}

	// the call drops mid-download; the joiner comes back as a new joiner, heard by no one yet
	j1.Stop()
	pub2 := NewVP8DataTunnelWithQueue(nil, j2obf, quiet, KCPCarrierQueueDepth)
	pub2.WriteFrame = func([]byte) error { return nil }
	j2mt := NewMultiTrackTunnel([]*VP8DataTunnel{pub2})
	j2mt.Start(50, 20)
	j2 := NewMultiTrackKCPTunnel(j2mt, nil)
	j2.AddSession(pub2)
	j2.SetSendSessions(1)
	t.Cleanup(j2.Stop)
	if epochs {
		j2.AcceptEpochConv(j2obf.LocalEpoch())
	}
	var got atomic.Int64
	j2.SetOnData(func([]byte) { got.Add(1) })
	camW.set(pub2.HandleFrame)
	shareW.set(pub2.HandleFrame)
	j2.SendData(tunnel.EncodeVP8ConfigFlags(50, 20, 2, tunnel.ConfigKCPEveryTrack))
	stop := make(chan struct{})
	defer close(stop)
	go func() { // the old joiner's download goes on
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			k1.SendData(msg(uint32(100+2*(i%8)), i/8))
		}
	}()
	time.Sleep(3 * time.Second)
	return j2.sessions[0].waitSnd(), got.Load()
}

// a current joiner and creator: the old layer went on the old joiner's epoch convs, plain frames and parity alike; the
// new joiner takes none of it, even when the old joiner uploaded no more than its config (an ack of 1 that the new
// joiner's own config would make look right)
func TestStaleLayerNotTakenOnEpochConvs(t *testing.T) {
	waiting, handed := staleLayerReachesNewJoiner(t, true, 1)
	if waiting == 0 || handed != 0 {
		t.Fatalf("the new joiner's config counted delivered (%d still to send), %d messages of the old layer handed on", waiting, handed)
	}
}

// a joiner or creator before the epoch convs: the old layer acks more than the new joiner ever sent, and such a
// packet is not another side's of this tunnel
func TestStaleAckPastAllSentNotTaken(t *testing.T) {
	waiting, _ := staleLayerReachesNewJoiner(t, false, 20)
	if waiting == 0 {
		t.Fatal("the old layer's cumulative ack counted the new joiner's config as delivered")
	}
}

// the epoch convs between a current creator and joiner, with parity, over a lossy line; and a current joiner with an
// older creator, which never sends on them
func TestEpochConvs(t *testing.T) {
	for _, creatorToo := range []bool{true, false} {
		p := newPair(t, true, true, 0.05)
		epoch := rand.Uint32() | 1
		p.joiner.AcceptEpochConv(epoch)
		if creatorToo {
			p.creator.UseEpochConv(epoch)
			p.creator.SetFEC(true)
		}
		run(t, p, 2000, 300)
		t.Logf("creator on the epoch convs %v: rebuilt from parity %d", creatorToo, p.joiner.fecRecovered.Load())
	}
}

// the epoch convs are none of the usual ones, and differ between epochs
func TestEpochConvBases(t *testing.T) {
	rnd := rand.New(rand.NewSource(9))
	seen := map[uint32]bool{}
	for range 10000 {
		base := kcpEpochConv(rnd.Uint32())
		if base&0xFF != 0 || base == kcpConvBase&^0xFF {
			t.Fatalf("base %#x: its sessions would meet the usual convs", base)
		}
		seen[base] = true
	}
	if len(seen) < 9990 {
		t.Fatalf("only %d bases for 10000 epochs", len(seen))
	}
}
