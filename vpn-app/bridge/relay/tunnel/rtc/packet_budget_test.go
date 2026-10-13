package rtc

import (
	"bytes"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"

	"whitelist-bypass/relay/common"
	"whitelist-bypass/relay/tunnel"
)

// winger: every frame the bridge sends must go as one RTP packet. The tracks cut a frame the way this packetizer does
// (1200 MTU, VP8 descriptor with a picture id, as headless-client's payloader and the creator's screenshare sink);
// a frame cut in two loses twice as often and costs a packet more.

func trackPacketizer() rtp.Packetizer {
	p := rtp.NewPacketizer(1200, 96, 1, &codecs.VP8Payloader{EnablePictureID: true}, rtp.NewRandomSequencer(), 90000)
	for i := 0; i < 300; i++ { // past the first 128 frames, where the picture id takes its full 2 bytes
		p.Packetize([]byte{0}, 1)
	}
	return p
}

func TestFramesFitOneRTPPacket(t *testing.T) {
	obf, _ := tunnel.NewTunnelObfuscator([]byte("budget"))
	p := trackPacketizer()
	packets := func(frame []byte) int { return len(p.Packetize(frame, 1)) }

	if n := packets(make([]byte, VP8FramePacketBudget)); n != 1 {
		t.Fatalf("a frame of the budget went as %d packets", n)
	}
	if n := packets(make([]byte, VP8FramePacketBudget+1)); n != 2 {
		t.Fatalf("the budget is not exact: one byte more went as %d packets", n)
	}
	segment := append([]byte{kcpChannelReliable}, make([]byte, kcpSegmentMTU)...)
	if n := packets(obf.EncodeData(segment)); n != 1 {
		t.Fatalf("a full reliable segment went as %d packets", n)
	}
	read := tunnel.EncodeFrame(7, tunnel.MsgData, make([]byte, common.VP8BufSize))
	if n := packets(obf.EncodeData(read)); n != 1 {
		t.Fatalf("a full %d-byte read went as %d packets", common.VP8BufSize, n)
	}
	if n := packets(obf.EncodeKeepalive(keepalivePadMax)); n != 1 {
		t.Fatalf("a keepalive went as %d packets", n)
	}
}

// TestReliableTrackSendsOnePacketFrames: a download through the reliable layer, as the creator reads it, puts no frame
// on the track that takes two packets, and nothing is lost on the way.
func TestReliableTrackSendsOnePacketFrames(t *testing.T) {
	secret := tunnel.DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/1184118411")
	cobf, _ := tunnel.NewTunnelObfuscator(secret)
	jobf, _ := tunnel.NewTunnelObfuscator(secret)
	quiet := func(string, ...any) {}
	cam := NewVP8DataTunnelWithQueue(nil, cobf, quiet, KCPCarrierQueueDepth)
	pub := NewVP8DataTunnelWithQueue(nil, jobf, quiet, KCPCarrierQueueDepth)

	var mu sync.Mutex
	p := trackPacketizer()
	frames, split := 0, 0
	cam.WriteFrame = func(frame []byte) error {
		mu.Lock()
		frames++
		if len(p.Packetize(frame, 1)) > 1 {
			split++
		}
		mu.Unlock()
		pub.HandleFrame(append([]byte(nil), frame...))
		return nil
	}
	pub.WriteFrame = func(frame []byte) error {
		cam.HandleFrame(append([]byte(nil), frame...))
		return nil
	}
	cmt := NewMultiTrackTunnel([]*VP8DataTunnel{cam})
	cmt.Start(50, 20)
	jmt := NewMultiTrackTunnel([]*VP8DataTunnel{pub})
	jmt.Start(50, 20)
	creator := NewMultiTrackKCPTunnel(cmt, nil)
	joiner := NewMultiTrackKCPTunnel(jmt, nil)
	t.Cleanup(func() { creator.Stop(); joiner.Stop() })

	const reads = 8
	body := bytes.Repeat([]byte("winger"), KCPReadBufSize/6+1)[:KCPReadBufSize]
	var got bytes.Buffer
	done := make(chan struct{})
	joiner.SetOnData(func(data []byte) {
		tunnel.DecodeFrames(data, func(_ uint32, _ byte, payload []byte) {
			mu.Lock()
			got.Write(payload)
			full := got.Len() == reads*len(body)
			mu.Unlock()
			if full {
				close(done)
			}
		})
	})
	creator.SetOnData(func([]byte) {})
	for i := 0; i < reads; i++ {
		creator.SendData(tunnel.EncodeFrame(3, tunnel.MsgData, body))
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the download did not arrive")
	}
	mu.Lock()
	defer mu.Unlock()
	if !bytes.Equal(got.Bytes(), bytes.Repeat(body, reads)) {
		t.Fatal("the download arrived changed")
	}
	if split > 0 {
		t.Fatalf("%d of %d frames on the track went as two RTP packets", split, frames)
	}
	if want := reads * (len(body) + 9) / (kcpSegmentMTU - 24); frames < want {
		t.Fatalf("only %d frames for %d full segments", frames, want)
	}
}
