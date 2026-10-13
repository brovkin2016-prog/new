package rtc

import (
	"sync"
	"testing"
	"time"

	"github.com/kulikov0/headless-client/webrtc"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"

	"whitelist-bypass/relay/tunnel"
)

// winger: the call's server asks a sent track for a keyframe (PLI/FIR); the tunnel answers with a keepalive, which is
// VP8's keyframe and which every version of the far side reads as a keepalive.

type frameLog struct {
	mu     sync.Mutex
	frames [][]byte
}

func (l *frameLog) write(frame []byte) error {
	l.mu.Lock()
	l.frames = append(l.frames, append([]byte(nil), frame...))
	l.mu.Unlock()
	return nil
}

// keyframesSince: the keyframe-shaped frames (VP8 P bit 0) among those written from index `from` on, and the count.
func (l *frameLog) keyframesSince(from int) (keyframes, total int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, f := range l.frames[from:] {
		if f[0]&0x01 == 0 {
			keyframes++
		}
	}
	return keyframes, len(l.frames)
}

func (l *frameLog) len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.frames)
}

func busyTunnel(t *testing.T) (*VP8DataTunnel, *frameLog, *tunnel.TunnelObfuscator) {
	t.Helper()
	secret := tunnel.DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/1212121212")
	sender, _ := tunnel.NewTunnelObfuscator(secret)
	receiver, _ := tunnel.NewTunnelObfuscator(secret)
	log := &frameLog{}
	tun := NewVP8DataTunnelWithQueue(nil, sender, func(string, ...any) {}, KCPCarrierQueueDepth)
	tun.WriteFrame = log.write
	tun.Start(50, 20) // a frame each millisecond
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() { // never idle: the queue always holds data
		defer close(done)
		payload := make([]byte, 1000)
		for {
			select {
			case <-stop:
				return
			default:
			}
			tun.SendData(payload)
		}
	}()
	t.Cleanup(func() { close(stop); tun.Stop(); <-done })
	return tun, log, receiver
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestKeyframeOnRequestWhileBusy(t *testing.T) {
	tun, log, receiver := busyTunnel(t)
	time.Sleep(400 * time.Millisecond) // busy long enough: no keyframe of its own
	from := log.len()
	time.Sleep(200 * time.Millisecond)
	if k, n := log.keyframesSince(from); k != 0 {
		t.Fatalf("a busy writer sent %d keyframes of %d frames unasked; this test needs it busy", k, n-from)
	}

	from = log.len()
	if !tun.RequestKeyframe() {
		t.Fatal("the first request was refused")
	}
	waitFor(t, "the asked keyframe", func() bool { k, _ := log.keyframesSince(from); return k > 0 })

	if tun.RequestKeyframe() {
		t.Fatal("a second request within 300 ms was taken")
	}
	time.Sleep(keyframeMinInterval + 20*time.Millisecond)
	from = log.len()
	if !tun.RequestKeyframe() {
		t.Fatal("a request after 300 ms was refused")
	}
	waitFor(t, "the second keyframe", func() bool { k, _ := log.keyframesSince(from); return k > 0 })

	// what the far side makes of them, whatever its version: keepalives, no data, no restarted peer
	log.mu.Lock()
	frames := append([][]byte(nil), log.frames...)
	log.mu.Unlock()
	data, keyframes := 0, 0
	for _, f := range frames {
		res := receiver.Decode(f)
		if !res.HasFrame || res.PeerRestart || res.SelfEcho {
			t.Fatalf("frame %x... read as %+v", f[:4], res)
		}
		if f[0]&0x01 == 0 {
			keyframes++
			if !res.Keepalive || len(res.Payload) != 0 {
				t.Fatalf("a keyframe was not read as a keepalive: %+v", res)
			}
		} else if len(res.Payload) == 1000 {
			data++
		}
	}
	if tun.keyframeSent.Load() != 2 || data == 0 {
		t.Fatalf("keyframes answered %d (want 2), data frames %d", tun.keyframeSent.Load(), data)
	}
	t.Logf("%d frames: %d data, %d keyframes", len(frames), data, keyframes)
}

func TestKeyframeOnRequestWhileIdle(t *testing.T) {
	secret := tunnel.DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/3434343434")
	obf, _ := tunnel.NewTunnelObfuscator(secret)
	log := &frameLog{}
	tun := NewVP8DataTunnelWithQueue(nil, obf, func(string, ...any) {}, KCPCarrierQueueDepth)
	tun.WriteFrame = log.write
	tun.Start(50, 20)
	defer tun.Stop()
	time.Sleep(keyframeMinInterval + 100*time.Millisecond) // idle: the writer sleeps between its own keepalives
	from := log.len()
	for tries := 0; ; tries++ {
		tun.lastKeyframe.Store(0) // as if its last keepalive were long ago (one of its own may come in between)
		if tun.RequestKeyframe() {
			break
		}
		if tries == 10 {
			t.Fatal("refused")
		}
	}
	waitFor(t, "the asked keyframe", func() bool { return tun.keyframeSent.Load() == 1 })
	if k, _ := log.keyframesSince(from); k == 0 {
		t.Fatal("no keyframe written")
	}
}

func TestSenderFeedbackAsksForKeyframes(t *testing.T) {
	var f senderFeedback
	for _, c := range []struct {
		pkts []rtcp.Packet
		want bool
	}{
		{[]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: 1}}, true},
		{[]rtcp.Packet{&rtcp.ReceiverReport{Reports: []rtcp.ReceptionReport{{SSRC: 1, FractionLost: 64}}},
			&rtcp.FullIntraRequest{FIR: []rtcp.FIREntry{{SSRC: 1}}}}, true},
		{[]rtcp.Packet{&rtcp.TransportLayerNack{MediaSSRC: 1, Nacks: []rtcp.NackPair{{PacketID: 10, LostPackets: 0b101}}}}, false},
		{[]rtcp.Packet{&rtcp.ReceiverEstimatedMaximumBitrate{Bitrate: 2.5e6, SSRCs: []uint32{1}}}, false},
	} {
		// as they come off the wire
		raw, err := rtcp.Marshal(c.pkts)
		if err != nil {
			t.Fatal(err)
		}
		pkts, err := rtcp.Unmarshal(raw)
		if err != nil {
			t.Fatal(err)
		}
		if got := f.note(pkts); got != c.want {
			t.Fatalf("%T...: keyframe asked %v, want %v", c.pkts[0], got, c.want)
		}
	}
	if f.keyframeAsks != 2 || f.nackPackets != 3 || f.rembBps != 2.5e6 || f.lossFraction != 64 {
		t.Fatalf("counted %+v", f)
	}
}

// only a tunnel that asked for them gets its track's keyframe requests, and not after it stopped
func TestKeyframeTargetsFollowTheTunnel(t *testing.T) {
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8})
	if err != nil {
		t.Fatal(err)
	}
	obf, _ := tunnel.NewTunnelObfuscator([]byte("secret"))
	tun := NewVP8DataTunnelWithQueue(track, obf, func(string, ...any) {}, KCPCarrierQueueDepth)
	if _, ok := keyframeTargets.Load(webrtc.TrackLocal(track)); ok {
		t.Fatal("registered before asking")
	}
	tun.AnswerKeyframeRequests()
	tun.Start(24, 45)
	if v, ok := keyframeTargets.Load(webrtc.TrackLocal(track)); !ok || v.(*VP8DataTunnel) != tun {
		t.Fatal("not registered")
	}
	tun.Stop()
	if _, ok := keyframeTargets.Load(webrtc.TrackLocal(track)); ok {
		t.Fatal("still registered after stop")
	}
}

// the reliable layer over both tracks, every side's tracks asked for keyframes all the time: everything still arrives
// whole and in order, for a newer joiner and creator and for each of them with an older other side
func TestTelemostReliableWithKeyframeRequests(t *testing.T) {
	for _, c := range []struct {
		name                      string
		creatorShare, joinerShare bool
	}{{"both newer", true, true}, {"newer joiner, older creator", false, true}, {"older joiner, newer creator", false, false}} {
		t.Run(c.name, func(t *testing.T) {
			p := newPair(t, c.creatorShare, c.joinerShare, 0.02)
			tunnels := append(p.creator.mt.SubTunnels(), p.joiner.mt.SubTunnels()...)
			stop := make(chan struct{})
			done := make(chan struct{})
			go func() {
				defer close(done)
				for {
					select {
					case <-stop:
						return
					case <-time.After(5 * time.Millisecond):
					}
					for _, tun := range tunnels {
						tun.RequestKeyframe()
					}
				}
			}()
			run(t, p, 1500, 300)
			close(stop)
			<-done
			sent := uint64(0)
			for _, tun := range tunnels {
				sent += tun.keyframeSent.Load()
			}
			if sent == 0 {
				t.Fatal("no keyframe was answered")
			}
			t.Logf("keyframes answered: %d", sent)
		})
	}
}

// through real WebRTC stacks, as in a call: the receiving side sends a PLI for the track, the sending side's tunnel
// gets it by way of DrainSenderRTCP
func TestKeyframeRequestOverPeerConnection(t *testing.T) {
	newAPI := func() *webrtc.API {
		m := &webrtc.MediaEngine{}
		if err := m.RegisterDefaultCodecs(); err != nil {
			t.Fatal(err)
		}
		r := &interceptor.Registry{}
		if err := webrtc.RegisterDefaultInterceptors(m, r); err != nil {
			t.Fatal(err)
		}
		var se webrtc.SettingEngine
		se.SetIncludeLoopbackCandidate(true)
		return webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(r), webrtc.WithSettingEngine(se))
	}
	spc, err := newAPI().NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer spc.Close()
	rpc, err := newAPI().NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer rpc.Close()
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8})
	if err != nil {
		t.Fatal(err)
	}
	sender, err := spc.AddTrack(track)
	if err != nil {
		t.Fatal(err)
	}
	go DrainSenderRTCP(sender)
	obf, _ := tunnel.NewTunnelObfuscator([]byte("secret"))
	tun := NewVP8DataTunnelWithQueue(track, obf, func(string, ...any) {}, KCPCarrierQueueDepth)
	tun.AnswerKeyframeRequests()
	tun.Start(24, 45)
	defer tun.Stop()

	ssrc := make(chan webrtc.SSRC, 1)
	rpc.OnTrack(func(tr *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		ssrc <- tr.SSRC()
		DrainTrack(tr)
	})
	offer, err := spc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(spc)
	if err := spc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	if err := rpc.SetRemoteDescription(*spc.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	answer, err := rpc.CreateAnswer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered = webrtc.GatheringCompletePromise(rpc)
	if err := rpc.SetLocalDescription(answer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	if err := spc.SetRemoteDescription(*rpc.LocalDescription()); err != nil {
		t.Fatal(err)
	}
	var media webrtc.SSRC
	select {
	case media = <-ssrc:
	case <-time.After(10 * time.Second):
		t.Skip("the two peers did not connect on this machine")
	}
	deadline := time.Now().Add(5 * time.Second)
	for tun.keyframeAsked.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("the PLI never reached the tunnel")
		}
		if err := rpc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(media)}}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
