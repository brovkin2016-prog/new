package rtc

import (
	"bytes"
	"encoding/binary"
	"math/rand"
	"testing"
	"time"
)

// winger: the reliable layer's parity frames (fec.go): what the receiving side rebuilds is exactly what was lost,
// frames keep within the size of a plain one, a restarted sender is not mixed up with the old one, and two sides
// that agreed on it carry a download whole and in order over a lossy line.

const testConv = kcpConvBase + 1

// kcpOutput: one KCP output as a session puts it out: a data segment of n bytes, or (n < 0) -n acks in a row.
func kcpOutput(rnd *rand.Rand, n int) []byte {
	segment := func(cmd byte, data []byte) []byte {
		s := make([]byte, 24+len(data))
		binary.LittleEndian.PutUint32(s[0:], testConv)
		s[4] = cmd
		binary.LittleEndian.PutUint32(s[8:], rnd.Uint32())  // ts
		binary.LittleEndian.PutUint32(s[12:], rnd.Uint32()) // sn
		binary.LittleEndian.PutUint32(s[20:], uint32(len(data)))
		copy(s[24:], data)
		return s
	}
	if n < 0 {
		var out []byte
		for range -n {
			out = append(out, segment(82, nil)...)
		}
		return out
	}
	data := make([]byte, n)
	rnd.Read(data)
	return segment(81, data)
}

// fecLine: answers (each a run of KCP outputs, the session quiet after it) from an encoder to a decoder; drop says
// which data frames (counted over all answers) never arrive.
func fecLine(t *testing.T, e *fecEncoder, answers [][][]byte, drop map[int]bool) (rebuilt [][]byte, parity int) {
	t.Helper()
	d := newFECDecoder(testConv, 1)
	var frames, outputs [][]byte
	now := time.Now()
	for _, answer := range answers {
		for _, out := range answer {
			outputs = append(outputs, out)
			frames = append(frames, e.frame(out, now))
		}
		if !e.due(now.Add(fecQuietAfter)) {
			t.Fatal("an answer's end not taken for one")
		}
		frames = append(frames, e.seal()...)
	}
	data := 0
	for _, f := range frames {
		switch f[0] {
		case kcpChannelFECData:
			if len(f) != len(outputs[data]) {
				t.Fatalf("data frame of %d bytes for an output of %d", len(f), len(outputs[data]))
			}
			stream, seq, shard, ok := parseFECData(f[1:])
			if !ok || stream != 1 {
				t.Fatalf("data frame not read back: stream %d ok %v", stream, ok)
			}
			if !drop[data] {
				d.data(seq, shard)
			}
			data++
		case kcpChannelFECParity:
			parity++
			p, ok := parseFECParity(f[1:])
			if !ok || p.stream != 1 {
				t.Fatalf("parity frame not read back")
			}
			rebuilt = append(rebuilt, d.parity(p.first, p.n, p.m, p.j, p.shard)...)
		default:
			t.Fatalf("frame on channel %#x", f[0])
		}
	}
	return rebuilt, parity
}

func TestFECRebuildsWhatWasLost(t *testing.T) {
	rnd := rand.New(rand.NewSource(1))
	answer := func(n int) [][]byte {
		var outs [][]byte
		for i := range n {
			switch {
			case i%7 == 3:
				outs = append(outs, kcpOutput(rnd, -3)) // acks alone
			default:
				outs = append(outs, kcpOutput(rnd, 50+rnd.Intn(kcpSegmentMTU-24-50)))
			}
		}
		return append(outs, kcpOutput(rnd, kcpSegmentMTU-24)) // the longest a session puts out
	}
	// answers of 10, 16, 21 (a full group mid-answer, then 5) and 4 frames
	answers := [][][]byte{answer(9), answer(15), answer(20), answer(3)}
	var outputs [][]byte
	for _, a := range answers {
		outputs = append(outputs, a...)
	}
	e := newFECEncoder(1)
	e.loss = 0.03
	// one lost in each of the first two answers; in the third one in its full group (no parity there) and one in its
	// end; two in the last answer, which has one parity frame
	drop := map[int]bool{2: true, 20: true, 30: true, 45: true, 48: true, 50: true}
	rebuilt, parity := fecLine(t, e, answers, drop)
	if parity != 4 {
		t.Fatalf("%d parity frames, want 4 (one per answer)", parity)
	}
	want := [][]byte{outputs[2], outputs[20], outputs[45]}
	if len(rebuilt) != len(want) {
		t.Fatalf("rebuilt %d outputs, want %d", len(rebuilt), len(want))
	}
	for i := range want {
		if !bytes.Equal(rebuilt[i], want[i]) {
			t.Fatalf("output %d rebuilt wrong (%d bytes, want %d)", i, len(rebuilt[i]), len(want[i]))
		}
	}
}

// a short answer (one frame, the usual end of a burst) gets its parity frame and comes back when lost
func TestFECRebuildsOneFrameAnswer(t *testing.T) {
	rnd := rand.New(rand.NewSource(5))
	e := newFECEncoder(1)
	e.loss = 0.02
	out := kcpOutput(rnd, 700)
	rebuilt, parity := fecLine(t, e, [][][]byte{{out}}, map[int]bool{0: true})
	if parity != 1 || len(rebuilt) != 1 || !bytes.Equal(rebuilt[0], out) {
		t.Fatalf("%d parity frames, %d outputs rebuilt", parity, len(rebuilt))
	}
}

// parity waits until all the session was given has gone out once: a pause mid-download (data still waiting for the
// window) is not the end of an answer, and a resend does not count as sent anew
func TestFECParityWaitsForTheEnd(t *testing.T) {
	push := func(sn uint32) []byte {
		s := make([]byte, 24+100)
		binary.LittleEndian.PutUint32(s[0:], testConv)
		s[4] = 81
		binary.LittleEndian.PutUint32(s[12:], sn)
		binary.LittleEndian.PutUint32(s[20:], 100)
		return s
	}
	e := newFECEncoder(1)
	e.loss = 0.02
	const mss = kcpSegmentMTU - 24
	e.queued(2*mss + 1) // three segments
	now := time.Now()
	e.frame(push(7), now)
	e.frame(push(8), now)
	e.frame(push(7), now) // a resend
	later := now.Add(10 * fecQuietAfter)
	if e.due(later) {
		t.Fatal("parity while a segment still waits to go out")
	}
	e.frame(push(9), now)
	if !e.due(later) || e.due(now) {
		t.Fatal("the end of the answer not taken for one only after a quiet moment")
	}
	if len(e.seal()) != 1 {
		t.Fatal("no parity frame at the end of the answer")
	}
}

// a parity frame is never longer than the longest plain frame (channel byte and output), a data frame a byte shorter:
// the parity costs no RTP packet more
func TestFECFramesKeepTheirSize(t *testing.T) {
	rnd := rand.New(rand.NewSource(2))
	e := newFECEncoder(0)
	e.loss = 0.12
	longest := kcpOutput(rnd, kcpSegmentMTU-24)
	now := time.Now()
	for range 15 {
		e.frame(kcpOutput(rnd, 300), now)
	}
	if f := e.frame(longest, now); len(f) != len(longest) {
		t.Fatalf("data frame %d bytes, plain %d", len(f), 1+len(longest))
	}
	parity := e.seal()
	if len(parity) != 2 {
		t.Fatalf("%d parity frames at 12%% loss, want 2", len(parity))
	}
	for _, f := range parity {
		if len(f) > 1+len(longest) {
			t.Fatalf("parity frame %d bytes, the longest plain one %d", len(f), 1+len(longest))
		}
	}
}

// the parity an answer's end gets follows the loss the far side reports: none on a clean line, none on a full queue
func TestFECParityFollowsLoss(t *testing.T) {
	e := newFECEncoder(0)
	for _, c := range []struct {
		loss   float64
		parity int
	}{{0, 0}, {0.01, 1}, {0.03, 1}, {0.06, 1}, {0.12, 2}, {0.3, 0}} {
		for range 20 {
			e.report(1000, uint32(1000*(1-c.loss)))
		}
		if parity := fecParityFor(e.loss); parity != c.parity {
			t.Fatalf("loss %.2f (estimated %.3f): %d parity frames, want %d", c.loss, e.loss, parity, c.parity)
		}
	}
}

// a sender that starts anew (another seq) does not get its frames rebuilt from the old one's
func TestFECNewSenderNotMixedUp(t *testing.T) {
	rnd := rand.New(rand.NewSource(3))
	d := newFECDecoder(testConv, 0)
	old := newFECEncoder(0)
	old.loss = 0.06
	now := time.Now()
	for range 10 {
		f := old.frame(kcpOutput(rnd, 200), now)
		_, seq, shard, _ := parseFECData(f[1:])
		d.data(seq, shard)
	}
	fresh := newFECEncoder(0)
	fresh.seq = old.seq + fecRing // far from where the old one stopped
	fresh.loss = 0.06
	var outs [][]byte
	var frames [][]byte
	for range 4 {
		out := kcpOutput(rnd, 400)
		outs = append(outs, out)
		frames = append(frames, fresh.frame(out, now))
	}
	frames = append(frames, fresh.seal()...)
	var rebuilt [][]byte
	for i, f := range frames {
		if i == 1 {
			continue // lost
		}
		if f[0] == kcpChannelFECData {
			_, seq, shard, _ := parseFECData(f[1:])
			d.data(seq, shard)
			continue
		}
		p, _ := parseFECParity(f[1:])
		rebuilt = append(rebuilt, d.parity(p.first, p.n, p.m, p.j, p.shard)...)
	}
	if len(rebuilt) != 1 || !bytes.Equal(rebuilt[0], outs[1]) {
		t.Fatalf("rebuilt %d outputs, want the one lost", len(rebuilt))
	}
}

func TestTrimKCPOutput(t *testing.T) {
	rnd := rand.New(rand.NewSource(4))
	out := append(kcpOutput(rnd, -2), kcpOutput(rnd, 100)...)
	padded := append(append([]byte(nil), out...), make([]byte, 300)...)
	if got := trimKCPOutput(padded, testConv); !bytes.Equal(got, out) {
		t.Fatalf("trimmed to %d bytes, want %d", len(got), len(out))
	}
	if trimKCPOutput(make([]byte, 100), testConv) != nil {
		t.Fatal("zeros taken for an output")
	}
}

// both newer, the creator sending with parity: a download over a lossy line arrives whole and in order
func TestTelemostReliableWithFEC(t *testing.T) {
	p := newPair(t, true, true, 0.08)
	p.creator.SetFEC(true)
	run(t, p, 3000, 400)
	t.Logf("download: parity frames %d, frames rebuilt %d", p.creator.fecParity.Load(), p.joiner.fecRecovered.Load())
}

// both newer, answers with pauses between them over a lossy line: they arrive whole and in order, and lost last frames
// come back from parity
func TestTelemostFECAnswers(t *testing.T) {
	p := newPair(t, true, true, 0.08)
	p.creator.SetFEC(true)
	const answers, parts = 150, 2
	atJoiner := newSide(answers * parts)
	p.joiner.SetOnData(atJoiner.take)
	p.creator.SetOnData(func([]byte) {})
	for i := range answers {
		for j := range parts {
			p.creator.SendData(msg(uint32(1+i%16), (i/16)*parts+j))
		}
		time.Sleep(4 * fecQuietAfter)
	}
	select {
	case <-atJoiner.done:
	case <-time.After(60 * time.Second):
		atJoiner.mu.Lock()
		t.Fatalf("joiner got %d of %d messages", atJoiner.n, answers*parts)
	}
	for conn, got := range atJoiner.got {
		for i, m := range got {
			if !bytes.Equal(m, msg(conn, i)) {
				t.Fatalf("connection %d: message %d out of order or damaged", conn, i)
			}
		}
	}
	t.Logf("answers: parity frames %d, frames rebuilt %d", p.creator.fecParity.Load(), p.joiner.fecRecovered.Load())
	if p.creator.fecParity.Load() < answers/2 || p.joiner.fecRecovered.Load() == 0 {
		t.Fatal("answers' ends got no parity, or no lost frame came back from it")
	}
}

// a newer Winger with an older creator (it never sends with parity): nothing changes, and the joiner sends no reports
// (an older creator would not know them)
func TestTelemostFECJoinerWithOlderCreator(t *testing.T) {
	p := newPair(t, true, true, 0.05)
	run(t, p, 1500, 400)
	p.joiner.mu.Lock()
	decoders := len(p.joiner.fecDec)
	p.joiner.mu.Unlock()
	if decoders != 0 || p.joiner.fecParity.Load() != 0 {
		t.Fatalf("joiner keeps %d parity readers with no parity sent", decoders)
	}
}
