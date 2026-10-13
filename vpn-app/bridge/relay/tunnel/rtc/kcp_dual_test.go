package rtc

import (
	"bytes"
	"encoding/binary"
	"math/rand"
	"sync"
	"testing"
	"time"

	"whitelist-bypass/relay/tunnel"
)

// winger: the Telemost bridge's reliable layer over two tracks. The creator sends on its camera and on its screenshare
// track; the joiner (Winger) publishes one track, keeps a reliable session for each of the creator's tracks and sends
// on the first only. Frames are carried in memory here, a few of them lost on the way.

type lossyWire struct {
	mu     sync.Mutex
	rnd    *rand.Rand
	loss   float64
	frames int
	to     func([]byte)
}

func (w *lossyWire) send(frame []byte) error {
	w.mu.Lock()
	w.frames++
	drop := w.rnd.Float64() < w.loss
	w.mu.Unlock()
	if !drop {
		w.to(append([]byte(nil), frame...))
	}
	return nil
}

func (w *lossyWire) count() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.frames
}

type side struct {
	mu   sync.Mutex
	got  map[uint32][][]byte
	n    int
	done chan struct{}
	want int
}

func newSide(want int) *side {
	return &side{got: map[uint32][][]byte{}, done: make(chan struct{}), want: want}
}

func (s *side) take(frame []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := binary.BigEndian.Uint32(frame[4:8])
	s.got[id] = append(s.got[id], frame)
	s.n++
	if s.n == s.want {
		close(s.done)
	}
}

func msg(conn uint32, i int) []byte {
	body := bytes.Repeat([]byte{byte(conn), byte(i)}, 400)
	binary.BigEndian.PutUint32(body[0:4], uint32(i))
	return tunnel.EncodeFrame(conn, tunnel.MsgData, body)
}

type pair struct {
	creator, joiner *MultiTrackKCPTunnel
	cam, share      *lossyWire
}

// newPair: a creator with a camera and a screenshare track and a joiner with one track; creatorShare/joinerShare: each
// side keeps the second reliable session (a newer program) or not (an older one).
func newPair(t *testing.T, creatorShare, joinerShare bool, loss float64) *pair {
	return newPairDepth(t, creatorShare, joinerShare, loss, KCPCarrierQueueDepth)
}

func newPairDepth(t *testing.T, creatorShare, joinerShare bool, loss float64, depth int) *pair {
	t.Helper()
	secret := tunnel.DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/7777777777")
	cobf, _ := tunnel.NewTunnelObfuscator(secret)
	jobf, _ := tunnel.NewTunnelObfuscator(secret)
	quiet := func(string, ...any) {}
	cam := NewVP8DataTunnelWithQueue(nil, cobf, quiet, depth)
	share := NewVP8DataTunnelWithQueue(nil, cobf, quiet, depth)
	pub := NewVP8DataTunnelWithQueue(nil, jobf, quiet, depth)
	// winger: each wire draws its losses from a source of its own (one shared by the three, each under its own lock,
	// was a data race under -race)
	camW := &lossyWire{rnd: rand.New(rand.NewSource(7)), loss: loss, to: pub.HandleFrame}
	shareW := &lossyWire{rnd: rand.New(rand.NewSource(8)), loss: loss, to: pub.HandleFrame}
	pubW := &lossyWire{rnd: rand.New(rand.NewSource(9)), loss: loss, to: cam.HandleFrame}
	cam.WriteFrame, share.WriteFrame, pub.WriteFrame = camW.send, shareW.send, pubW.send

	cmt := NewMultiTrackTunnel([]*VP8DataTunnel{cam})
	cmt.Start(50, 20)
	ckcp := NewMultiTrackKCPTunnel(cmt, nil)
	cmt.AddSubTunnel(share) // the screenshare track is on in every case: what differs is who keeps a session for it
	if creatorShare {
		ckcp.AddSession(share)
	}
	jmt := NewMultiTrackTunnel([]*VP8DataTunnel{pub})
	jmt.Start(50, 20)
	jkcp := NewMultiTrackKCPTunnel(jmt, nil)
	if joinerShare {
		jkcp.AddSession(pub)
		jkcp.SetSendSessions(1)
	}
	t.Cleanup(func() { ckcp.Stop(); jkcp.Stop() })
	return &pair{creator: ckcp, joiner: jkcp, cam: camW, share: shareW}
}

// run: the creator sends `down` messages over 16 connections, the joiner `up`; both arrive whole and in order.
func run(t *testing.T, p *pair, down, up int) {
	t.Helper()
	atJoiner, atCreator := newSide(down), newSide(up)
	p.joiner.SetOnData(atJoiner.take)
	p.creator.SetOnData(atCreator.take)
	go func() {
		for i := 0; i < up; i++ {
			p.joiner.SendData(msg(uint32(1+i%16), i/16))
		}
	}()
	for i := 0; i < down; i++ {
		p.creator.SendData(msg(uint32(1+i%16), i/16))
	}
	for name, s := range map[string]*side{"joiner": atJoiner, "creator": atCreator} {
		select {
		case <-s.done:
		case <-time.After(60 * time.Second):
			s.mu.Lock()
			t.Fatalf("%s got %d of %d messages", name, s.n, s.want)
		}
	}
	for conn, got := range atJoiner.got {
		for i, m := range got {
			if !bytes.Equal(m, msg(conn, i)) {
				t.Fatalf("connection %d: message %d out of order or damaged", conn, i)
			}
		}
	}
}

// both newer: the download rides on both of the creator's tracks
func TestTelemostReliableOnBothTracks(t *testing.T) {
	p := newPair(t, true, true, 0.02)
	run(t, p, 3000, 400)
	cam, share := p.cam.count(), p.share.count()
	t.Logf("frames: camera %d, screenshare %d", cam, share)
	if share < cam/3 {
		t.Fatalf("the screenshare track carried almost nothing (%d frames against %d)", share, cam)
	}
}

// a newer Winger with an older creator: everything still arrives (the joiner sends only where the creator listens)
func TestTelemostNewJoinerOldCreator(t *testing.T) {
	p := newPair(t, false, true, 0.02)
	run(t, p, 1500, 400)
}

// an older Winger with a newer creator that heard no flag from it: the creator keeps to one session, all arrives
func TestTelemostOldJoinerCreatorWithoutFlag(t *testing.T) {
	p := newPair(t, false, false, 0.02)
	run(t, p, 1500, 400)
}

// the deeper queue: the reliable layer may put its whole window (the far side allows hundreds) on the track at once;
// with 128 frames of room part of it was thrown away and had to go again
func TestReliableBurstNotThrownAway(t *testing.T) {
	drops := map[int]uint64{}
	for _, depth := range []int{sendQueueDepth, KCPCarrierQueueDepth} {
		p := newPairDepth(t, false, false, 0, depth)
		run(t, p, 3000, 50)
		drops[depth] = p.creator.droppedSegments.Load()
		t.Logf("queue %d: %d segments thrown away", depth, drops[depth])
	}
	if drops[KCPCarrierQueueDepth]*10 > drops[sendQueueDepth] {
		t.Fatalf("the deeper queue did not help: %d thrown away against %d", drops[KCPCarrierQueueDepth], drops[sendQueueDepth])
	}
}
