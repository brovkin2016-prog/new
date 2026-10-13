package tunnel

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"testing"
)

// winger: frames are built in one buffer now; what goes on the wire must stay byte for byte what older programs build
// and read: VP8 header, epoch, 24-byte nonce, sealed payload (data); VP8 header, epoch, random padding (keepalive);
// nonce, sealed payload (EncryptPayload).

// oldEncodeData: the frame as the previous version built it, from a given nonce.
func oldEncodeData(o *TunnelObfuscator, payload, nonce []byte) []byte {
	hdr := make([]byte, InterframeHdrLen)
	copy(hdr, vp8Interframe)
	binary.BigEndian.PutUint32(hdr[vp8InterframeLen:], o.localEpoch)
	out := append([]byte(nil), hdr...)
	out = append(out, nonce...)
	return o.aead.Seal(out, nonce, payload, nil)
}

func TestEncodeDataLayoutUnchanged(t *testing.T) {
	secret := DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/42")
	sender, _ := NewTunnelObfuscator(secret)
	receiver, _ := NewTunnelObfuscator(secret)
	for _, size := range []int{0, 1, 25, 1138, 32277} {
		payload := make([]byte, size)
		rand.Read(payload)
		frame := sender.EncodeData(payload)
		if len(frame) != InterframeHdrLen+24+size+16 {
			t.Fatalf("size %d: frame of %d bytes", size, len(frame))
		}
		nonce := frame[InterframeHdrLen : InterframeHdrLen+24]
		if want := oldEncodeData(sender, payload, nonce); !bytes.Equal(frame, want) {
			t.Fatalf("size %d: frame differs from the old layout", size)
		}
		if size == 0 {
			continue // a frame with an empty payload reads as a keepalive-like frame, as before
		}
		if res := receiver.Decode(frame); !bytes.Equal(res.Payload, payload) {
			t.Fatalf("size %d: decoded %d bytes", size, len(res.Payload))
		}
	}
	a, b := sender.EncodeData([]byte("x")), sender.EncodeData([]byte("x"))
	if bytes.Equal(a[InterframeHdrLen:InterframeHdrLen+24], b[InterframeHdrLen:InterframeHdrLen+24]) {
		t.Fatal("two frames with the same nonce")
	}
}

func TestKeepaliveLayoutUnchanged(t *testing.T) {
	o, _ := NewTunnelObfuscator([]byte("k"))
	for _, pad := range []int{-1, 0, 1, 176} {
		ka := o.EncodeKeepalive(pad)
		want := keepaliveHdrLen + max(pad, 0)
		if len(ka) != want || !bytes.Equal(ka[:vp8KeepaliveLen], vp8Keepalive) ||
			binary.BigEndian.Uint32(ka[vp8KeepaliveLen:]) != o.localEpoch {
			t.Fatalf("pad %d: keepalive % x", pad, ka)
		}
	}
}

func TestEncryptPayloadRoundTrip(t *testing.T) {
	a, _ := NewTunnelObfuscator([]byte("dc"))
	b, _ := NewTunnelObfuscator([]byte("dc"))
	msg := []byte("datachannel message")
	wire := a.EncryptPayload(msg)
	if len(wire) != 24+len(msg)+16 {
		t.Fatalf("wire of %d bytes", len(wire))
	}
	if pt, ok := b.DecryptPayload(wire); !ok || !bytes.Equal(pt, msg) {
		t.Fatalf("round trip: %q %v", pt, ok)
	}
	plain, _ := a.aead.Open(nil, wire[:24], wire[24:], nil)
	if !bytes.Equal(plain, msg) {
		t.Fatal("not nonce followed by the sealed message")
	}
}
