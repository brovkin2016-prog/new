package tunnel

import (
	"bytes"
	"testing"
)

// winger: the cost of one carrier frame on each side: what the writer does per frame (EncodeData), what the reader does
// per frame (Decode), and the relay framing of one TCP read. Sizes: a full reliable segment with its channel byte, an
// acknowledgement-only output, a whole-segment TCP read.
//
//   go test ./relay/tunnel/ -run '^$' -bench 'Obfuscator|Frames' -benchmem

const (
	benchSegment = 1 + 1137 // channel byte + one full KCP segment
	benchAck     = 1 + 24   // channel byte + one KCP ack
	benchRead    = 32268
)

func benchObfuscators(b *testing.B) (*TunnelObfuscator, *TunnelObfuscator) {
	secret := DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/5050505050")
	a, err := NewTunnelObfuscator(secret)
	if err != nil {
		b.Fatal(err)
	}
	c, err := NewTunnelObfuscator(secret)
	if err != nil {
		b.Fatal(err)
	}
	return a, c
}

func BenchmarkObfuscatorEncodeData(b *testing.B) {
	for _, size := range []int{benchAck, benchSegment} {
		b.Run(sizeName(size), func(b *testing.B) {
			o, _ := benchObfuscators(b)
			payload := bytes.Repeat([]byte{0x5a}, size)
			b.SetBytes(int64(size))
			b.ReportAllocs()
			for b.Loop() {
				if o.EncodeData(payload) == nil {
					b.Fatal("encode failed")
				}
			}
		})
	}
}

func BenchmarkObfuscatorDecode(b *testing.B) {
	for _, size := range []int{benchAck, benchSegment} {
		b.Run(sizeName(size), func(b *testing.B) {
			o, peer := benchObfuscators(b)
			frame := o.EncodeData(bytes.Repeat([]byte{0x5a}, size))
			work := make([]byte, len(frame))
			b.SetBytes(int64(size))
			b.ReportAllocs()
			for b.Loop() {
				copy(work, frame) // a fresh received frame each time, as the track reader hands it on
				if res := peer.Decode(work); len(res.Payload) != size {
					b.Fatal("decode failed")
				}
			}
		})
	}
}

func BenchmarkObfuscatorKeepalive(b *testing.B) {
	o, _ := benchObfuscators(b)
	b.ReportAllocs()
	for b.Loop() {
		o.EncodeKeepalive(100)
	}
}

func BenchmarkFramesEncodeDecode(b *testing.B) {
	body := bytes.Repeat([]byte{0x33}, benchRead)
	b.SetBytes(benchRead)
	b.ReportAllocs()
	var n int
	for b.Loop() {
		frame := EncodeFrame(7, MsgData, body)
		DecodeFrames(frame, func(_ uint32, _ byte, payload []byte) { n += len(payload) })
	}
	if n == 0 {
		b.Fatal("nothing decoded")
	}
}

func sizeName(size int) string {
	switch size {
	case benchAck:
		return "ack"
	case benchSegment:
		return "segment"
	}
	return "other"
}
