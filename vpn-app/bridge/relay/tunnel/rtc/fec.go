package rtc

import (
	"encoding/binary"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/klauspost/reedsolomon"
	kcp "github.com/xtaci/kcp-go/v5"
)

// winger: forward error correction for the reliable layer, for the end of what a session sends. Each KCP segment rides
// one frame. A frame lost in the middle of a download is noticed by the acks of the frames after it and resent within
// about a round trip; the last frames of an answer (the end of a page, of a reply) have nothing after them, so their
// loss waits for KCP's timer, hundreds of milliseconds while the far side holds the rest of the answer. With FEC the
// sender numbers a session's frames in groups of up to 16, and when the session has sent all it was given and stays
// quiet for a moment, the open group gets a Reed-Solomon parity frame (two at high loss) from which the far side
// rebuilds a lost frame of it at once, even when the group is that one frame. Parity goes only where nothing waits to
// be sent, so it never takes a download's room (on a capped call every frame counts; mid-download, resends already
// work); a group that fills up gets none. How much follows the loss the far side measures and reports back: nothing on
// a clean line, nothing past 15% either (that is a full queue in the call's server, which more frames would only fill).
//
// Frames on the wire (only between two sides that agreed on it, tunnel.ConfigFEC):
//
//	data:   0x02 | stream | seq u16 | the KCP output without its 4-byte conv
//	parity: 0x03 | stream<<4 | n-1 | first seq u16 | m<<4 | j | parity shard j of the group's n outputs (less conv)
//	report: 0x04 | stream | frames expected u16 | frames received u16      (the receiving side, every 250 ms)
//
// The stream is the session's index (its conv less kcpConvBase), which stands for the conv the data frame leaves out:
// a data frame is one byte shorter than a plain one, a parity frame no longer than the longest plain one, so neither
// needs an RTP packet more than before. Data frames are handed on at once; only what was lost waits for the parity.
// The output's first length goes XORed with the conv left out, so the receiving side reads it right only with the conv
// it went with: a frame of another layer's (another conv: AcceptEpochConv), rebuilt or not, is never taken for its own.

const (
	kcpChannelFECData   byte = 0x02
	kcpChannelFECParity byte = 0x03
	kcpChannelFECReport byte = 0x04

	fecConvLen     = 4 // the conv a data frame leaves out, and the header it puts in its place
	fecParityHdr   = 5
	fecMaxStreams  = 16
	fecGroupData   = 16                // data frames per group at most
	fecQuietAfter  = kcpUpdateInterval // all sent and nothing added for this long: the end of an answer
	fecReportEvery = 250 * time.Millisecond
	fecReportMin   = 32  // frames a loss estimate needs before it counts
	fecRing        = 256 // data frames the receiving side keeps for rebuilding (a group's parity follows it at once)
	fecMaxGroups   = 64
	fecInitialLoss = 0.01
	fecLossGain    = 0.4
)

// fecParityFor: parity frames for the group that ends an answer, at a measured loss. Past 15% the loss is a full queue
// somewhere, not a noisy line, and parity would only add to it: KCP's resends go on.
func fecParityFor(loss float64) int {
	switch {
	case loss < 0.003 || loss >= 0.15:
		return 0
	case loss < 0.08:
		return 1
	default:
		return 2
	}
}

type fecCodecs map[[2]int]reedsolomon.Encoder

func (c *fecCodecs) get(n, m int) reedsolomon.Encoder {
	if *c == nil {
		*c = fecCodecs{}
	}
	key := [2]int{n, m}
	if enc, ok := (*c)[key]; ok {
		return enc
	}
	enc, err := reedsolomon.New(n, m)
	if err != nil {
		enc = nil
	}
	(*c)[key] = enc
	return enc
}

// fecEncoder: the sending side of one session (used under the session's kcpMu).
type fecEncoder struct {
	stream byte
	seq    uint16
	first  uint16
	group  [][]byte
	added  time.Time
	codecs fecCodecs

	// what the session was given and has not sent once yet, in segments; the newest segment number sent
	unsent  int
	nextSN  uint32
	sentAny bool

	loss            float64
	repExp, repRecv uint32
}

func newFECEncoder(stream byte) *fecEncoder {
	return &fecEncoder{stream: stream, seq: uint16(rand.Uint32()), loss: fecInitialLoss}
}

// queued: the session was given a message of n bytes (KCP cuts it into segments of its MSS).
func (e *fecEncoder) queued(n int) {
	const mss = kcpSegmentMTU - kcp.IKCP_OVERHEAD
	e.unsent += max((n+mss-1)/mss, 1)
}

// frame: the carrier frame for one KCP output (which starts with the session's conv).
func (e *fecEncoder) frame(out []byte, now time.Time) []byte {
	for seg := out; len(seg) >= kcp.IKCP_OVERHEAD; {
		sn, n := binary.LittleEndian.Uint32(seg[12:]), int(binary.LittleEndian.Uint32(seg[20:]))
		if seg[4] == kcp.IKCP_CMD_PUSH && (!e.sentAny || int32(sn-e.nextSN) >= 0) { // sent for the first time
			e.sentAny, e.nextSN = true, sn+1
			e.unsent = max(e.unsent-1, 0)
		}
		if n < 0 || kcp.IKCP_OVERHEAD+n > len(seg) {
			break
		}
		seg = seg[kcp.IKCP_OVERHEAD+n:]
	}
	f := make([]byte, len(out))
	f[0] = kcpChannelFECData
	f[1] = e.stream
	binary.BigEndian.PutUint16(f[2:4], e.seq)
	copy(f[fecConvLen:], out[fecConvLen:])
	if len(out) >= kcp.IKCP_OVERHEAD {
		binary.LittleEndian.PutUint32(f[20:24], binary.LittleEndian.Uint32(out[20:24])^binary.LittleEndian.Uint32(out))
	}
	if fecParityFor(e.loss) > 0 {
		if len(e.group) >= fecGroupData { // a full group the answer goes on past: closed, without parity
			e.group = e.group[:0]
		}
		if len(e.group) == 0 {
			e.first = e.seq
		}
		e.group = append(e.group, f[fecConvLen:])
		e.added = now
	}
	e.seq++
	return f
}

// due: the open group ends an answer: all the session was given has gone out once, and nothing came for a moment.
func (e *fecEncoder) due(now time.Time) bool {
	return len(e.group) > 0 && e.unsent == 0 && now.Sub(e.added) >= fecQuietAfter
}

// seal: the parity frames of the group that ends an answer, which closes.
func (e *fecEncoder) seal() [][]byte {
	n, m := len(e.group), fecParityFor(e.loss)
	group := e.group
	e.group = e.group[:0]
	if n == 0 || m == 0 {
		return nil
	}
	size := 0
	for _, s := range group {
		size = max(size, len(s))
	}
	shards := make([][]byte, n+m)
	for i, s := range group {
		if len(s) == size {
			shards[i] = s
			continue
		}
		padded := make([]byte, size)
		copy(padded, s)
		shards[i] = padded
	}
	frames := make([][]byte, m)
	for j := range m {
		f := make([]byte, fecParityHdr+size)
		f[0] = kcpChannelFECParity
		f[1] = e.stream<<4 | byte(n-1)
		binary.BigEndian.PutUint16(f[2:4], e.first)
		f[4] = byte(m)<<4 | byte(j)
		frames[j] = f
		shards[n+j] = f[fecParityHdr:]
	}
	enc := e.codecs.get(n, m)
	if enc == nil || enc.Encode(shards) != nil {
		return nil
	}
	return frames
}

// report: what the far side got of this session's frames lately; the parity follows the loss it shows.
func (e *fecEncoder) report(expected, received uint32) {
	e.repExp += expected
	e.repRecv += min(received, expected)
	if e.repExp < fecReportMin {
		return
	}
	sample := 1 - float64(e.repRecv)/float64(e.repExp)
	e.repExp, e.repRecv = 0, 0
	e.loss += (sample - e.loss) * fecLossGain
}

// fecDecoder: the receiving side of one session.
type fecDecoder struct {
	mu        sync.Mutex
	conv      uint32
	alt       uint32 // winger: the session's other conv the far side may send on (AcceptEpochConv; 0: none)
	stream    byte
	ring      [fecRing]fecSlot
	groups    map[uint16]*fecGroup
	started   bool
	highest   uint16
	expected  uint32
	received  uint32
	recovered uint64
	codecs    fecCodecs
}

type fecSlot struct {
	seq  uint16
	data []byte // nil: not here
}

type fecGroup struct {
	n, m   int
	parity [][]byte
	done   bool
}

func newFECDecoder(conv uint32, stream byte) *fecDecoder {
	return &fecDecoder{conv: conv, stream: stream, groups: map[uint16]*fecGroup{}}
}

func (d *fecDecoder) reset() {
	d.ring = [fecRing]fecSlot{}
	clear(d.groups)
}

// advance (d.mu held): seq was sent, and span frames up to it if this is the first news; the frames counted as
// expected follow the newest one known. One far from it is a sender that started anew: what is kept goes.
func (d *fecDecoder) advance(seq uint16, span uint32) {
	ahead := int16(seq - d.highest)
	switch {
	case !d.started || ahead > fecRing/2 || ahead < -fecRing/2:
		d.reset()
		d.started = true
		d.highest = seq
		d.expected += span
	case ahead > 0:
		d.expected += uint32(ahead)
		d.highest = seq
	}
}

// data: a data frame's seq and what it carries after its header; the KCP output it holds, nil if it is not this
// session's (winger: another layer's frame, which is not counted either).
func (d *fecDecoder) data(seq uint16, shard []byte) []byte {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := d.restore(shard, false)
	if out == nil {
		return nil
	}
	d.advance(seq, 1)
	d.received++
	d.ring[seq%fecRing] = fecSlot{seq: seq, data: shard}
	return out
}

// restore (d.mu held; winger): the KCP output a frame's shard holds (the output less its conv, its first length XORed
// with that conv), with whichever of this session's convs it went with; nil if none (another layer's frame) or not
// whole. rebuilt: from parity, zeros after it.
func (d *fecDecoder) restore(shard []byte, rebuilt bool) []byte {
	if fecConvLen+len(shard) < kcp.IKCP_OVERHEAD {
		return nil
	}
	seg := make([]byte, fecConvLen+len(shard))
	copy(seg[fecConvLen:], shard)
	folded := binary.LittleEndian.Uint32(seg[20:24])
	for _, conv := range [2]uint32{d.alt, d.conv} {
		if conv == 0 {
			continue
		}
		binary.LittleEndian.PutUint32(seg, conv)
		binary.LittleEndian.PutUint32(seg[20:24], folded^conv)
		if out := trimKCPOutput(seg, conv); out != nil && (rebuilt || len(out) == len(seg)) {
			return out
		}
	}
	return nil
}

// parity: one parity frame; the outputs (conv restored) it rebuilt, if any. It also tells which frames were sent: a
// group may have lost all its data (an answer of one frame, often).
func (d *fecDecoder) parity(first uint16, n, m, j int, shard []byte) [][]byte {
	d.mu.Lock()
	defer d.mu.Unlock()
	if j >= m || n > fecGroupData {
		return nil
	}
	d.advance(first+uint16(n-1), uint32(n))
	g := d.groups[first]
	if g == nil {
		if len(d.groups) >= fecMaxGroups {
			for k := range d.groups {
				if int16(d.highest-k) >= fecRing/4 || d.groups[k].done {
					delete(d.groups, k)
				}
			}
		}
		g = &fecGroup{n: n, m: m, parity: make([][]byte, m)}
		d.groups[first] = g
	}
	if g.done || g.n != n || g.m != m || g.parity[j] != nil {
		return nil
	}
	g.parity[j] = shard
	var missing []int
	for i := range n {
		seq := first + uint16(i)
		if s := d.ring[seq%fecRing]; s.data == nil || s.seq != seq {
			missing = append(missing, i)
		}
	}
	if len(missing) == 0 {
		g.done = true
		return nil
	}
	have := 0
	for _, p := range g.parity {
		if p != nil {
			have++
		}
	}
	if len(missing) > have {
		return nil
	}
	g.done = true
	size := len(shard)
	shards := make([][]byte, n+m)
	for i := range n {
		seq := first + uint16(i)
		s := d.ring[seq%fecRing]
		if s.data == nil || s.seq != seq {
			continue
		}
		if len(s.data) > size {
			return nil
		}
		padded := make([]byte, size)
		copy(padded, s.data)
		shards[i] = padded
	}
	for k, p := range g.parity {
		if len(p) == size {
			shards[n+k] = p
		}
	}
	enc := d.codecs.get(n, m)
	if enc == nil || enc.ReconstructData(shards) != nil {
		return nil
	}
	var out [][]byte
	for _, i := range missing {
		seg := d.restore(shards[i], true)
		if seg == nil {
			continue
		}
		seq := first + uint16(i)
		d.ring[seq%fecRing] = fecSlot{seq: seq, data: shards[i][:len(seg)-fecConvLen]}
		d.recovered++
		out = append(out, seg)
	}
	return out
}

// takeReport: the frames expected and received since the last report.
func (d *fecDecoder) takeReport() (expected, received uint32) {
	d.mu.Lock()
	defer d.mu.Unlock()
	expected, received = d.expected, d.received
	d.expected, d.received = 0, 0
	return expected, received
}

// trimKCPOutput: a rebuilt output without the zeros it was padded with (KCP segments carry their own length).
func trimKCPOutput(seg []byte, conv uint32) []byte {
	off := 0
	for off+24 <= len(seg) && binary.LittleEndian.Uint32(seg[off:]) == conv {
		end := off + 24 + int(binary.LittleEndian.Uint32(seg[off+20:]))
		if end > len(seg) || end < off {
			return nil
		}
		off = end
	}
	if off == 0 {
		return nil
	}
	return seg[:off]
}

// parseFECData: a data frame's body (after the channel byte): its stream, seq and the output less its conv.
func parseFECData(body []byte) (stream byte, seq uint16, shard []byte, ok bool) {
	if len(body) < fecConvLen-1 {
		return 0, 0, nil, false
	}
	return body[0] & 0x0f, binary.BigEndian.Uint16(body[1:3]), body[fecConvLen-1:], true
}

// fecParityFrame: a parity frame's body (after the channel byte), read.
type fecParityFrame struct {
	stream  byte
	first   uint16
	n, m, j int
	shard   []byte
}

func parseFECParity(body []byte) (p fecParityFrame, ok bool) {
	if len(body) < fecParityHdr {
		return p, false
	}
	p = fecParityFrame{stream: body[0] >> 4, n: int(body[0]&0x0f) + 1, first: binary.BigEndian.Uint16(body[1:3]),
		m: int(body[3] >> 4), j: int(body[3] & 0x0f), shard: body[fecParityHdr-1:]}
	return p, p.m > 0 && p.j < p.m
}

func encodeFECReport(stream byte, expected, received uint32) []byte {
	f := make([]byte, 6)
	f[0] = kcpChannelFECReport
	f[1] = stream
	binary.BigEndian.PutUint16(f[2:4], uint16(min(expected, 0xFFFF)))
	binary.BigEndian.PutUint16(f[4:6], uint16(min(received, 0xFFFF)))
	return f
}
