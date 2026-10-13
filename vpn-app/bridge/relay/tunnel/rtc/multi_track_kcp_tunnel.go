package rtc

import (
	"encoding/binary"
	"sync"
	"sync/atomic"
	"time"

	kcp "github.com/xtaci/kcp-go/v5"

	"whitelist-bypass/relay/common"
	"whitelist-bypass/relay/tunnel"
)

// winger: VP8FramePacketBudget — the longest frame a track sends as one RTP packet. The track's packetizer cuts a frame
// at 1200 less the 12-byte RTP header, and its VP8 payloader (headless-client's, as Chrome's: with a picture id) puts a
// 4-byte descriptor before each piece (3 for the first 128 frames, 1 for the very first). A longer frame goes as two
// packets: twice the packets, twice the frames lost (the far side throws away a frame with a piece missing), and a
// late repaired piece no longer saves its frame. The screenshare track's own packetizer cuts the same way.
const VP8FramePacketBudget = 1200 - 12 - 4

const (
	kcpConvBase           = 0x77627374
	kcpUpdateInterval     = 10 * time.Millisecond
	kcpIdleUpdateInterval = 500 * time.Millisecond
	kcpIdleAfterTicks     = 50
	// One KCP segment must ride in a single RTP packet so a dropped packet
	// loses only its own frame, not a two-packet frame that readVP8Track
	// would discard whole. RTP budget - interframe header - 24 XChaCha20
	// nonce - 16 Poly1305 tag - 1 channel tag.
	// winger: the budget is VP8FramePacketBudget (1184), not 1200 - 1: with 1199 bytes every full segment went as two
	// packets, the second of 15 bytes.
	kcpSegmentMTU = VP8FramePacketBudget - tunnel.InterframeHdrLen - 24 - 16 - 1
	// winger: what one TCP read may take on the reliable way: a whole number of full segments (segment data = MTU
	// - 24 KCP header) less the relay frame's own 9 bytes. A plain 1126-byte read made 1135 bytes, two segments of
	// which the second carried 22 bytes and still took a packet of its own: half the call's packets nearly empty.
	// (31833 with the segment of one packet; 32268 before.)
	KCPReadBufSize = 29*(kcpSegmentMTU-24) - 4 - tunnel.WireHeaderLen
	kcpStatsEvery  = 500

	kcpWindowFloor   = 64
	kcpWindowCeiling = 512
	kcpCarrierRTT    = 250 * time.Millisecond
	kcpWaitSndFactor = 2

	kcpChannelReliable byte = 0x00
	kcpChannelRaw      byte = 0x01

	KCPCarrierQueueDepth = kcpWaitSndFactor * kcpWindowCeiling

	// winger: a session the far side may not hear (AddProbedSession) is deaf once what waits on it has had no answer
	// this long while the far side answered on the first session more than kcpDeafMargin after its last answer. Long
	// enough that resends after a short gap (their timeout grows with each) come back first.
	kcpDeafAfter  = 10 * time.Second
	kcpDeafMargin = 3 * time.Second
	kcpProbeEvery = time.Second

	// winger: per segment number, where its last copy went (more than any window, so a slot is long free when reused)
	kcpSnRing = 4096
	// winger: the PUSH segments one KCP packet can hold (only tiny ones come more than one to a packet)
	kcpPushesPerPacket = 48
	// winger: with flightGate, KCP's own windows (its span from the oldest unacked segment, and what the far side may
	// hold out of order) are this many times what may be in flight
	kcpSpanFactor = 2
)

// kcpTuning: how this side runs its reliable sessions. All of it is local: the far side sees ordinary KCP either way,
// so a side with it and an older program without it work together.
type kcpTuning struct {
	// ackEach: every incoming segment answered at once by a packet of its own, as older programs do. Each such packet
	// took a whole frame of the carrier: the joiner's one track spent ~860 of its ~970 frames a second on single acks
	// and they queued up to half a second, so the creator's windows waited on them. Off: acks gather until the next
	// flush (10 ms), dozens to a packet.
	ackEach bool
	// urgent: packets of acks alone, and resends of a copy that a later copy overtook (the far side acked one sent after
	// it: on one track that means lost), go out ahead of the carrier's queue, so neither waits behind a window's worth
	// of data (an ack behind an upload, a lost segment behind the download).
	urgent bool
	// resendGuard: a resend KCP's timer asks for is held while the last copy of that segment is still in the carrier's
	// queue, or left it less than a network round trip ago with nothing sent after it acked yet. KCP starts its timer
	// when it hands a segment over, so with hundreds of segments queued it resent 20-40% of what it sent though nothing
	// was lost.
	resendGuard bool
	// carrierRTT: the window is the carrier's rate times this.
	carrierRTT time.Duration
	// flightGate: the window bounds what is in flight (sent, not acked) rather than KCP's span from the oldest
	// unacked segment, which is twice that: a lost segment then no longer stops the sending while it is repaired.
	flightGate bool
}

// span: KCP's own windows for a window of this many segments in flight.
func (t *MultiTrackKCPTunnel) span(window int) int {
	if t.tuning.flightGate {
		return window * kcpSpanFactor
	}
	return window
}

var kcpTuningDefault = kcpTuning{urgent: true, resendGuard: true, flightGate: true, carrierRTT: kcpCarrierRTT}

func computeKCPWindow(fps, batch int, carrierRTT time.Duration) int {
	rate := fps * batch
	if rate < 1 {
		rate = defaultVP8FPS * defaultVP8Batch
	}
	window := int(float64(rate) * carrierRTT.Seconds())
	if window < kcpWindowFloor {
		return kcpWindowFloor
	}
	if window > kcpWindowCeiling {
		return kcpWindowCeiling
	}
	return window
}

type trackKCPSession struct {
	conv   uint32
	vp8    *VP8DataTunnel
	parent *MultiTrackKCPTunnel
	kcpMu  sync.Mutex
	kcp    *kcp.KCP

	// winger: a session the far side may not hear (AddProbedSession) takes connections only while the far side
	// answers on it; a removed one takes none, and a sender waiting for room on it gives up
	probed  bool
	heard   atomic.Bool
	removed atomic.Bool
	lastIn  atomic.Int64 // monoNow: the far side's last segment on it
	// updateLoop only
	busySince int64 // monoNow: something has waited on it, unanswered, since then (0: nothing waits)

	// winger: what the packets KCP puts out carry and where they went (all under kcpMu)
	sentAny bool
	maxSN   uint32
	copies  [kcpSnRing]segCopy
	rtt     netRTT
	rack    int64 // when the latest-sent copy the far side acked went out (monoNow)

	// winger: the far side's next expected segment, how many past it it has acked one by one, and the segments handed
	// to KCP not yet put out: what is in flight is the rest
	peerUna uint32
	sacked  int
	pending int
	held    []heldResend // winger: resends the guard held, sent once due (releaseHeld)

	// winger: data waiting for room in it, least served connection first (kcp_gate.go)
	gate sessionGate

	fec *fecEncoder // winger: parity for what this session sends, once the far side reads it (fec.go; kcpMu held)
}

// ready: new connections may go on it.
func (s *trackKCPSession) ready() bool {
	return !s.removed.Load() && (!s.probed || s.heard.Load())
}

// segCopy: where a segment's last copy went, and KCP's timestamp on it (the far side's ack echoes it, so an ack tells
// which copy arrived); acked: the far side has it, though one before it is missing.
type segCopy struct {
	place framePlace
	ts    uint32
	acked bool
}

type segPush struct {
	sn, ts uint32
	fresh  bool
}

// outRoute: where a packet from KCP goes.
type outRoute int

const (
	routeQueue outRoute = iota // new data, and resends whose time has come: in turn
	routeAhead                 // acks alone, and resends of copies a later copy overtook: ahead of the queue
	routeHold                  // only resends whose last copy may still arrive: not now
)

// netRTT: the round trip from a copy leaving the carrier to its ack, so the carrier's own queue is left out.
type netRTT struct {
	srtt, rttvar time.Duration
	peak, prev   time.Duration // the largest sample in this half second and in the one before
	peakFrom     time.Time
}

const kcpRTTPeakSpan = 500 * time.Millisecond

func (r *netRTT) sample(d time.Duration, now time.Time) {
	if r.srtt == 0 {
		r.srtt, r.rttvar = d, d/2
	} else {
		diff := r.srtt - d
		if diff < 0 {
			diff = -diff
		}
		r.rttvar = (3*r.rttvar + diff) / 4
		r.srtt = (7*r.srtt + d) / 8
	}
	if now.Sub(r.peakFrom) >= kcpRTTPeakSpan {
		r.prev, r.peak, r.peakFrom = r.peak, 0, now
	}
	r.peak = max(r.peak, d)
}

// timeout: how long after a copy left the carrier, with nothing sent after it acked, a resend is due (0: no samples
// yet). The recent peak keeps a queue that grows on the call's server between samples from making copies that are
// merely slow look lost.
func (r *netRTT) timeout() time.Duration {
	if r.srtt == 0 {
		return 0
	}
	return max(r.srtt+max(4*r.rttvar, 2*kcpUpdateInterval), max(r.peak, r.prev)+2*kcpUpdateInterval)
}

func newTrackKCPSession(parent *MultiTrackKCPTunnel, vp8 *VP8DataTunnel, conv uint32, window int) *trackKCPSession {
	session := &trackKCPSession{
		conv:   conv,
		vp8:    vp8,
		parent: parent,
	}
	session.kcp = kcp.NewKCP(conv, session.output)
	session.kcp.NoDelay(1, 10, 2, 1)
	session.kcp.WndSize(parent.span(window), parent.span(window))
	session.kcp.SetMtu(kcpSegmentMTU)
	return session
}

// output: one packet from KCP onto the carrier (called inside KCP, kcpMu held).
func (s *trackKCPSession) output(buf []byte, size int) {
	if size <= 0 {
		return
	}
	var pushBuf [kcpPushesPerPacket]segPush
	route, pushes := s.route(buf[:size], pushBuf[:])
	if route == routeHold {
		s.parent.heldResends.Add(1)
		s.hold(buf[:size], pushes) // the update loop sends it once due (releaseHeld)
		return
	}
	s.put(buf[:size], route == routeAhead, pushes)
}

// put (kcpMu held): one KCP packet onto the carrier, ahead of the queue or in turn; where its segments went is noted.
func (s *trackKCPSession) put(pkt []byte, ahead bool, pushes []segPush) {
	size := len(pkt)
	var segment []byte
	if enc := s.fec; enc != nil && size > fecConvLen {
		segment = enc.frame(pkt, time.Now()) // winger: numbered for parity (fec.go)
	} else {
		segment = make([]byte, size+1)
		segment[0] = kcpChannelReliable
		copy(segment[1:], pkt)
	}
	s.parent.outputSegments.Add(1)
	var place framePlace
	ok := false
	if ahead {
		place, ok = s.vp8.trySendPlaced(segment, true)
	}
	if !ok {
		place, ok = s.vp8.trySendPlaced(segment, false)
	}
	if !ok {
		s.parent.droppedSegments.Add(1)
	}
	for _, p := range pushes {
		c := &s.copies[p.sn%kcpSnRing]
		if p.fresh {
			*c = segCopy{}
			s.pending = max(s.pending-1, 0)
		} else {
			s.parent.resentSegments.Add(1)
		}
		c.place, c.ts = place, p.ts
	}
}

// winger: a resend the guard held. KCP asks again only on its next timer, which it has meanwhile backed off by half its
// timeout, so a segment lost after all went again that much later than due: the end of an answer, which nothing after
// it shows lost, came on an idle line twice as late as before the guard (p95 198 -> 382 ms at 3% loss). The update
// loop now sends a held resend itself once it is due by the guard's own measure; one the far side has acked meanwhile,
// or that a newer copy covers, is forgotten. KCP's asks stay the bound: each held one goes at most once.
type heldResend struct {
	pkt    []byte
	pushes []segPush
	places []framePlace // where each segment's last copy was when held
}

const kcpHeldMax = 64

// hold (kcpMu held): keep a held resend for releaseHeld.
func (s *trackKCPSession) hold(pkt []byte, pushes []segPush) {
	if len(pushes) == 0 {
		return
	}
	h := heldResend{pkt: append([]byte(nil), pkt...), pushes: append([]segPush(nil), pushes...),
		places: make([]framePlace, len(pushes))}
	for i, p := range pushes {
		h.places[i] = s.copies[p.sn%kcpSnRing].place
	}
	if len(s.held) >= kcpHeldMax {
		copy(s.held, s.held[1:])
		s.held = s.held[:len(s.held)-1]
	}
	s.held = append(s.held, h)
}

// releaseHeld (kcpMu held, each update): held resends now due go out (ahead of the queue when a later copy was acked:
// lost); those no longer needed are forgotten.
func (s *trackKCPSession) releaseHeld(now int64) {
	if len(s.held) == 0 {
		return
	}
	timeout := int64(s.rtt.timeout())
	kept := s.held[:0]
	for _, h := range s.held {
		needed, due, lost := false, false, false
		for i, p := range h.pushes {
			c := &s.copies[p.sn%kcpSnRing]
			if c.place != h.places[i] || !s.inFlight(p.sn) || c.acked {
				continue // a newer copy went, or the far side has it
			}
			needed = true
			switch dep := s.departed(c); {
			case dep < 0 || dep > now+kcpClockSlack:
				due = true
			case dep == 0: // still waits in the carrier
			case dep < s.rack:
				due, lost = true, true
			case timeout == 0 || now-dep >= timeout:
				due = true
			}
		}
		switch {
		case !needed:
		case due:
			s.put(h.pkt, lost && s.parent.tuning.urgent, h.pushes)
		default:
			kept = append(kept, h)
		}
	}
	for i := len(kept); i < len(s.held); i++ {
		s.held[i] = heldResend{}
	}
	s.held = kept
}

// winger: kcpClockSlack: a copy that seems to have left more than this after now did not (the times are monoNow, so
// only a broken clock does that): its resend is not held for it.
const kcpClockSlack = int64(kcpUpdateInterval)

// departed: when a segment's last copy left the carrier (monoNow; 0: it still waits there, -1: unknown or long ago).
func (s *trackKCPSession) departed(c *segCopy) int64 {
	if c.place.seq == 0 {
		return -1
	}
	return s.vp8.departedAt(c.place)
}

// route: where a packet from KCP goes. The track keeps order, so a copy that left before one the far side has acked
// is lost: its resend goes ahead. A resend whose last copy still waits in the carrier, or left too recently to be
// missed, is held: KCP times its resends from when it hands a segment over, queue and all.
func (s *trackKCPSession) route(pkt []byte, buf []segPush) (outRoute, []segPush) {
	tuning := &s.parent.tuning
	pushes := buf[:0]
	var fresh, other, repeat, lost, due bool
	now := monoNow()
	timeout := int64(s.rtt.timeout())
	for len(pkt) >= kcp.IKCP_OVERHEAD {
		cmd := pkt[4]
		ts := binary.LittleEndian.Uint32(pkt[8:12])
		sn := binary.LittleEndian.Uint32(pkt[12:16])
		n := int(binary.LittleEndian.Uint32(pkt[20:24]))
		switch {
		case cmd != kcp.IKCP_CMD_PUSH:
			other = true
		case !s.sentAny || int32(sn-s.maxSN) > 0:
			s.sentAny, s.maxSN = true, sn
			fresh = true
		default:
			repeat = true
			switch dep := s.departed(&s.copies[sn%kcpSnRing]); {
			case dep < 0 || dep > now+kcpClockSlack:
				due = true
			case dep == 0:
			case dep < s.rack:
				lost = true
			case timeout == 0 || now-dep >= timeout:
				due = true
			}
		}
		if cmd == kcp.IKCP_CMD_PUSH && len(pushes) < cap(pushes) {
			pushes = append(pushes, segPush{sn, ts, fresh && int32(sn-s.maxSN) == 0})
		}
		if n < 0 || kcp.IKCP_OVERHEAD+n > len(pkt) {
			break
		}
		pkt = pkt[kcp.IKCP_OVERHEAD+n:]
	}
	switch {
	case fresh:
		return routeQueue, pushes
	case !repeat || lost:
		if tuning.urgent {
			return routeAhead, pushes
		}
		return routeQueue, pushes
	case due || other || !tuning.resendGuard:
		return routeQueue, pushes
	}
	return routeHold, pushes
}

// sampleAcks: acks of our last copies (the timestamp tells which copy) give the network round trip and the latest
// copy known to have arrived.
func (s *trackKCPSession) sampleAcks(pkt []byte) {
	now, mono := time.Now(), monoNow()
	var rtt int64
	if len(pkt) >= kcp.IKCP_OVERHEAD {
		s.advanceUna(binary.LittleEndian.Uint32(pkt[16:20]))
	}
	for len(pkt) >= kcp.IKCP_OVERHEAD {
		cmd := pkt[4]
		ts := binary.LittleEndian.Uint32(pkt[8:12])
		sn := binary.LittleEndian.Uint32(pkt[12:16])
		n := int(binary.LittleEndian.Uint32(pkt[20:24]))
		if c := &s.copies[sn%kcpSnRing]; cmd == kcp.IKCP_CMD_ACK {
			if !c.acked && s.inFlight(sn) {
				c.acked = true
				s.sacked++
			}
			if c.ts == ts {
				if dep := s.departed(c); dep > 0 && mono > dep {
					rtt = mono - dep
					s.rack = max(s.rack, dep)
				}
			}
		}
		if n < 0 || kcp.IKCP_OVERHEAD+n > len(pkt) {
			break
		}
		pkt = pkt[kcp.IKCP_OVERHEAD+n:]
	}
	if rtt > 0 {
		s.rtt.sample(time.Duration(rtt), now)
	}
}

// advanceUna: the far side has everything before una.
func (s *trackKCPSession) advanceUna(una uint32) {
	gap := int32(una - s.peerUna)
	if gap <= 0 || !s.sentAny || int32(una-s.maxSN) > 1 {
		return
	}
	if gap >= kcpSnRing {
		for i := range s.copies {
			s.copies[i].acked = false
		}
		s.peerUna, s.sacked = una, 0
		return
	}
	for ; s.peerUna != una; s.peerUna++ {
		if c := &s.copies[s.peerUna%kcpSnRing]; c.acked {
			c.acked = false
			s.sacked--
		}
	}
}

// inFlight: the segment was sent and the far side has not got all before it.
func (s *trackKCPSession) inFlight(sn uint32) bool {
	return s.sentAny && int32(sn-s.peerUna) >= 0 && int32(sn-s.maxSN) <= 0
}

// flight: segments out and not acked (one acked past a gap counts as arrived).
func (s *trackKCPSession) flight() int {
	if !s.sentAny {
		return 0
	}
	return max(int(s.maxSN+1-s.peerUna)-s.sacked, 0)
}

// trySend: hands the frame to KCP if what is in flight, and waiting in KCP, stays under limit; without the gate, while
// KCP holds less than limit*kcpWaitSndFactor.
func (s *trackKCPSession) trySend(frame []byte, limit int, gate bool) bool {
	s.kcpMu.Lock()
	defer s.kcpMu.Unlock()
	waiting := s.kcp.WaitSnd()
	if gate {
		if s.flight()+s.pending >= limit || waiting >= s.parent.span(limit)*kcpWaitSndFactor {
			return false
		}
	} else if waiting >= limit*kcpWaitSndFactor {
		return false
	}
	s.queue(frame)
	return true
}

func (s *trackKCPSession) setWindow(window int) {
	s.kcpMu.Lock()
	s.kcp.WndSize(s.parent.span(window), s.parent.span(window))
	s.kcpMu.Unlock()
}

func (s *trackKCPSession) send(frame []byte) {
	s.kcpMu.Lock()
	s.queue(frame)
	s.kcpMu.Unlock()
}

// queue: the frame to KCP, counting the segments it makes until they go out (kcpMu held).
func (s *trackKCPSession) queue(frame []byte) {
	const mss = kcpSegmentMTU - kcp.IKCP_OVERHEAD
	if s.kcp.Send(frame) == 0 {
		s.pending += max((len(frame)+mss-1)/mss, 1)
		if s.fec != nil {
			s.fec.queued(len(frame)) // winger: parity waits until all of it has gone out once
		}
	}
	s.kcp.Update()
}

// setFEC (winger): send with parity (stream: this session's index) or plainly.
func (s *trackKCPSession) setFEC(on bool, stream int) {
	s.kcpMu.Lock()
	defer s.kcpMu.Unlock()
	switch {
	case on && s.fec == nil && stream < fecMaxStreams:
		s.fec = newFECEncoder(byte(stream))
	case !on && s.fec != nil:
		s.fec = nil
	}
}

// fecReport (winger): the far side's count of this session's frames.
func (s *trackKCPSession) fecReport(expected, received uint32) {
	s.kcpMu.Lock()
	if s.fec != nil {
		s.fec.report(expected, received)
	}
	s.kcpMu.Unlock()
}

// sendParity (winger, kcpMu held): parity frames go after their group's data on the same track, never waiting for room.
func (s *trackKCPSession) sendParity(frames [][]byte) {
	for _, f := range frames {
		s.parent.fecParity.Add(1)
		if !s.vp8.TrySendData(f) {
			s.parent.droppedSegments.Add(1)
		}
	}
}

func (s *trackKCPSession) input(segment []byte) [][]byte {
	s.kcpMu.Lock()
	s.sampleAcks(segment)
	s.kcp.Input(segment, kcp.IKCP_PACKET_REGULAR, s.parent.tuning.ackEach)
	var messages [][]byte
	for {
		size := s.kcp.PeekSize()
		if size <= 0 {
			break
		}
		// winger: each message is read straight into a buffer of its own (it was read into a shared 128 KB buffer
		// and then copied out: every received byte copied twice)
		message := make([]byte, size)
		n := s.kcp.Recv(message)
		if n <= 0 {
			break
		}
		messages = append(messages, message[:n])
	}
	s.kcpMu.Unlock()
	return messages
}

func (s *trackKCPSession) update() {
	busy := s.gate.hasWaiting() // winger: data waits for room: not an answer's end (asked first: the gate locks first)
	s.kcpMu.Lock()
	s.kcp.Update()
	s.releaseHeld(monoNow())
	if s.fec != nil && !busy && s.fec.due(time.Now()) {
		s.sendParity(s.fec.seal())
	}
	s.kcpMu.Unlock()
}

func (s *trackKCPSession) waitSnd() int {
	s.kcpMu.Lock()
	pending := s.kcp.WaitSnd()
	s.kcpMu.Unlock()
	return pending
}

type MultiTrackKCPTunnel struct {
	mt     *MultiTrackTunnel
	logFn  func(string, ...any)
	tuning kcpTuning

	mu       sync.Mutex
	sessions []*trackKCPSession
	convMap  map[uint32]*trackKCPSession
	connPin  map[uint32]int
	onData   func([]byte)
	onClose  func()

	stopCh     chan struct{}
	stopOnce   sync.Once
	nudge      chan struct{}
	updateIdle atomic.Bool // winger: the update loop ticks slowly and wants a nudge when work comes

	currentWindow atomic.Int32
	sendSessions  atomic.Int32 // winger: how many sessions this side sends on (0: all); the others only receive

	fecOn      atomic.Bool            // winger: this side sends with parity (the far side said it reads it)
	fecDec     map[uint32]*fecDecoder // winger: per conv, once the far side sends with parity (t.mu)
	fecReports time.Time              // updateLoop only

	probe          []byte       // winger: a frame the far side's relay takes as nothing new (AddProbedSession; t.mu)
	lastFirstProbe int64        // updateLoop only (monoNow)
	unanswered     atomic.Int64 // winger: see Unanswered

	sentMessages      atomic.Uint64
	deliveredMessages atomic.Uint64
	outputSegments    atomic.Uint64
	inputSegments     atomic.Uint64
	rawSent           atomic.Uint64
	rawReceived       atomic.Uint64
	droppedSegments   atomic.Uint64
	heldResends       atomic.Uint64
	resentSegments    atomic.Uint64
	fecParity         atomic.Uint64
	fecRecovered      atomic.Uint64
}

func NewMultiTrackKCPTunnel(mt *MultiTrackTunnel, logFn func(string, ...any)) *MultiTrackKCPTunnel {
	return newMultiTrackKCPTunnel(mt, logFn, kcpTuningDefault)
}

func newMultiTrackKCPTunnel(mt *MultiTrackTunnel, logFn func(string, ...any), tuning kcpTuning) *MultiTrackKCPTunnel {
	t := &MultiTrackKCPTunnel{
		mt:      mt,
		logFn:   logFn,
		tuning:  tuning,
		convMap: make(map[uint32]*trackKCPSession),
		connPin: make(map[uint32]int),
		fecDec:  make(map[uint32]*fecDecoder),
		stopCh:  make(chan struct{}),
		nudge:   make(chan struct{}, 1),
	}
	subs := mt.SubTunnels()
	window := kcpWindowFloor
	if len(subs) > 0 {
		window = computeKCPWindow(subs[0].FPS(), subs[0].Batch(), tuning.carrierRTT)
	}
	t.currentWindow.Store(int32(window))
	for i, sub := range subs {
		conv := uint32(kcpConvBase + i)
		session := newTrackKCPSession(t, sub, conv, window)
		t.sessions = append(t.sessions, session)
		t.convMap[conv] = session
	}
	if logFn != nil {
		logFn("kcptunnel: init tracks=%d window=%d queue=%d", len(subs), window, KCPCarrierQueueDepth)
	}
	mt.SetOnData(t.handleDecodedSegment)
	mt.SetOnClose(t.handleInnerClose)
	go t.updateLoop()
	return t
}

func (t *MultiTrackKCPTunnel) SendData(frame []byte) {
	if len(frame) < 9 {
		return
	}
	connID := binary.BigEndian.Uint32(frame[4:8])
	msgType := frame[8]

	if msgType == tunnel.MsgUDP || msgType == tunnel.MsgUDPReply {
		t.sendRaw(connID, frame)
		return
	}

	t.mu.Lock()
	if len(t.sessions) == 0 {
		t.mu.Unlock()
		return
	}
	index, pinned := t.connPin[connID]
	if pinned && index == retiredPin {
		// winger: closed with its session (retire): nothing more of it goes anywhere, the far side would get a stream
		// with a piece missing; its own close is the last word of it
		if msgType == tunnel.MsgClose {
			delete(t.connPin, connID)
		}
		t.mu.Unlock()
		return
	}
	if !pinned || index >= t.sendCount() {
		index = t.pickSession(connID)
		t.connPin[connID] = index
	}
	session := t.sessions[index]
	t.mu.Unlock()

	if msgType == tunnel.MsgData {
		// winger: in turn with the other connections once KCP is full (kcp_gate.go); let go unsent when the session
		// was removed or went deaf (the connection is closed with it) or the tunnel stopped
		if !session.admit(connID, frame, t.stopCh) {
			return
		}
	} else {
		session.send(frame)
	}
	t.sentMessages.Add(1)
	t.wake() // winger: after the send: an update loop that went idle meanwhile either sees this data or gets the nudge

	if msgType == tunnel.MsgClose {
		t.mu.Lock()
		delete(t.connPin, connID)
		t.mu.Unlock()
		session.gate.book.forget(connID)
	}
}

func (t *MultiTrackKCPTunnel) sendRaw(connID uint32, frame []byte) {
	t.mu.Lock()
	if len(t.sessions) == 0 {
		t.mu.Unlock()
		return
	}
	session := t.sessions[t.pickSession(connID)]
	t.mu.Unlock()

	segment := make([]byte, len(frame)+1)
	segment[0] = kcpChannelRaw
	copy(segment[1:], frame)
	t.rawSent.Add(1)
	session.vp8.TrySendData(segment)
}

// sendCount: the sessions new data is spread over (t.mu held). A side that only receives on the others keeps its
// sending where the far side surely listens.
func (t *MultiTrackKCPTunnel) sendCount() int {
	n := len(t.sessions)
	if s := int(t.sendSessions.Load()); s > 0 && s < n {
		return s
	}
	return n
}

// SetSendSessions: send only on the first n sessions (0: on all). winger: the Telemost joiner receives on a second
// session (the creator's screenshare track) but sends on the first alone, so an older creator never gets a session it
// does not have.
func (t *MultiTrackKCPTunnel) SetSendSessions(n int) {
	t.sendSessions.Store(int32(n))
}

// pickSession (t.mu held): the session a connection goes on. While every session it may send on is ready this is the
// same spread as always (connID modulo their number); a session the far side does not hear is left out.
func (t *MultiTrackKCPTunnel) pickSession(connID uint32) int {
	n := t.sendCount()
	ready := 0
	for i := 0; i < n; i++ {
		if t.sessions[i].ready() {
			ready++
		}
	}
	if ready == n || ready == 0 {
		return int(connID % uint32(n))
	}
	k := int(connID % uint32(ready))
	for i := 0; i < n; i++ {
		if t.sessions[i].ready() {
			if k == 0 {
				return i
			}
			k--
		}
	}
	return 0
}

// SessionCount: the reliable sessions now (one per track carrying them).
func (t *MultiTrackKCPTunnel) SessionCount() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.sessions)
}

// ReadySessions: the sessions new connections may go on (a probed one only while the far side answers on it).
func (t *MultiTrackKCPTunnel) ReadySessions() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := 0
	for i := 0; i < t.sendCount(); i++ {
		if t.sessions[i].ready() {
			n++
		}
	}
	return n
}

// retiredPin marks a connection closed with its session: what more it sends is dropped until its own close.
const retiredPin = -1

// retiredConn: the connection was closed with its session (retire).
func (t *MultiTrackKCPTunnel) retiredConn(conn uint32) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	index, pinned := t.connPin[conn]
	return pinned && index == retiredPin
}

// retire (winger): the connections on this session are closed at both ends: the far side is told on a session it
// hears, and this side's relay as if the far side had said so. Their later data is dropped, never carried on another
// session, which would hand the far side a stream with a piece missing. Used when a session is removed or the far
// side stops hearing it.
func (t *MultiTrackKCPTunnel) retire(index int) {
	t.mu.Lock()
	var conns []uint32
	closed := map[uint32]bool{}
	for id, i := range t.connPin {
		if i == index {
			conns = append(conns, id)
			closed[id] = true
			t.connPin[id] = retiredPin
		}
	}
	var gone *trackKCPSession
	if index < len(t.sessions) {
		gone = t.sessions[index]
	}
	callback := t.onData
	t.mu.Unlock()
	if gone != nil {
		gone.gate.drop(closed) // what of theirs waits for room goes unsent
	}
	for _, id := range conns {
		frame := tunnel.EncodeFrame(id, tunnel.MsgClose, nil)
		t.mu.Lock()
		session := t.sessions[t.pickSession(id)]
		t.mu.Unlock()
		session.send(frame)
		if callback != nil {
			callback(frame)
		}
	}
	if len(conns) > 0 {
		t.wake() // winger: the closes may need resending
		if t.logFn != nil {
			t.logFn("kcptunnel: %d connections closed with session %d", len(conns), index)
		}
	}
}

func (t *MultiTrackKCPTunnel) InjectSegment(payload []byte) {
	t.handleDecodedSegment(payload)
}

func (t *MultiTrackKCPTunnel) handleDecodedSegment(payload []byte) {
	if len(payload) < 1 {
		return
	}
	channel := payload[0]
	body := payload[1:]

	if channel == kcpChannelRaw {
		t.mu.Lock()
		callback := t.onData
		t.mu.Unlock()
		if callback == nil {
			return
		}
		t.rawReceived.Add(1)
		callback(body)
		return
	}

	switch channel {
	case kcpChannelFECData, kcpChannelFECParity:
		t.handleFECFrame(channel, body)
		return
	case kcpChannelFECReport:
		t.handleFECReport(body)
		return
	}

	if len(body) < 4 {
		return
	}
	conv := binary.LittleEndian.Uint32(body[0:4])
	t.mu.Lock()
	session := t.convMap[conv]
	t.mu.Unlock()
	t.inputKCP(session, body)
}

// inputKCP: one KCP output of the far side into its session; what that completes goes on to the relay.
func (t *MultiTrackKCPTunnel) inputKCP(session *trackKCPSession, body []byte) {
	if session == nil {
		return
	}
	t.mu.Lock()
	callback := t.onData
	t.mu.Unlock()
	t.inputSegments.Add(1)
	session.lastIn.Store(monoNow())
	if session.probed && session.heard.CompareAndSwap(false, true) && t.logFn != nil {
		t.logFn("kcptunnel: session %d answered by the far side, in use", session.conv-kcpConvBase)
	}
	messages := session.input(body)
	session.pump() // winger: acks may have made room
	t.wake()       // winger: acks to send wait for the update loop's next tick; an idle loop is woken for them
	if callback == nil {
		return
	}
	for _, message := range messages {
		t.deliveredMessages.Add(1)
		callback(message)
	}
}

// handleFECFrame (winger): a data or parity frame of a far side that sends with parity. Data goes into its session at
// once; a parity frame may rebuild lost data of its group, which then goes in the same way.
func (t *MultiTrackKCPTunnel) handleFECFrame(channel byte, body []byte) {
	stream, seq, shard, ok := parseFECData(body)
	parity, isParity := parseFECParity(body)
	if channel == kcpChannelFECParity {
		stream, ok = parity.stream, isParity
	}
	if !ok {
		return
	}
	conv := uint32(kcpConvBase) + uint32(stream)
	t.mu.Lock()
	session := t.convMap[conv]
	dec := t.fecDec[conv]
	if dec == nil && session != nil {
		dec = newFECDecoder(conv, stream)
		t.fecDec[conv] = dec
	}
	t.mu.Unlock()
	if session == nil {
		return
	}
	if channel == kcpChannelFECData {
		dec.data(seq, shard)
		segment := make([]byte, fecConvLen+len(shard))
		binary.LittleEndian.PutUint32(segment, conv)
		copy(segment[fecConvLen:], shard)
		t.inputKCP(session, segment)
		return
	}
	for _, segment := range dec.parity(parity.first, parity.n, parity.m, parity.j, parity.shard) {
		t.fecRecovered.Add(1)
		t.inputKCP(session, segment)
	}
}

// handleFECReport (winger): the far side's count of what it got of one of our sessions.
func (t *MultiTrackKCPTunnel) handleFECReport(body []byte) {
	if len(body) < 5 {
		return
	}
	t.mu.Lock()
	var session *trackKCPSession
	if i := int(body[0]); i < len(t.sessions) {
		session = t.sessions[i]
	}
	t.mu.Unlock()
	if session != nil {
		session.fecReport(uint32(binary.BigEndian.Uint16(body[1:3])), uint32(binary.BigEndian.Uint16(body[3:5])))
	}
}

// SetFEC (winger): send with parity on every session, now and added later. Only once the far side said it reads it
// (tunnel.ConfigFEC): older programs would drop such frames.
func (t *MultiTrackKCPTunnel) SetFEC(on bool) {
	if t.fecOn.Swap(on) == on {
		return
	}
	t.mu.Lock()
	sessions := make([]*trackKCPSession, len(t.sessions))
	copy(sessions, t.sessions)
	t.mu.Unlock()
	for i, session := range sessions {
		session.setFEC(on, i)
	}
	if t.logFn != nil {
		t.logFn("kcptunnel: parity (FEC) on=%v", on)
	}
}

// sendFECReports (winger, updateLoop): tell a far side that sends with parity what we got of each of its sessions.
func (t *MultiTrackKCPTunnel) sendFECReports(now time.Time) {
	if now.Sub(t.fecReports) < fecReportEvery {
		return
	}
	t.fecReports = now
	t.mu.Lock()
	if len(t.fecDec) == 0 || len(t.sessions) == 0 {
		t.mu.Unlock()
		return
	}
	decs := make([]*fecDecoder, 0, len(t.fecDec))
	for _, dec := range t.fecDec {
		decs = append(decs, dec)
	}
	vp8 := t.sessions[0].vp8
	t.mu.Unlock()
	for _, dec := range decs {
		if expected, received := dec.takeReport(); expected > 0 {
			vp8.TrySendData(encodeFECReport(dec.stream, expected, received))
		}
	}
}

func (t *MultiTrackKCPTunnel) SetOnData(fn func([]byte)) {
	t.mu.Lock()
	t.onData = fn
	t.mu.Unlock()
}

func (t *MultiTrackKCPTunnel) SetOnClose(fn func()) {
	t.mu.Lock()
	t.onClose = fn
	t.mu.Unlock()
}

func (t *MultiTrackKCPTunnel) Reconfigure(fps, batch int) {
	t.mt.Reconfigure(fps, batch)
	window := computeKCPWindow(fps, batch, t.tuning.carrierRTT)
	t.applyWindow(window)
	if t.logFn != nil {
		t.logFn("kcptunnel: reconfigure fps=%d batch=%d -> window=%d", fps, batch, window)
	}
}

func (t *MultiTrackKCPTunnel) applyWindow(window int) {
	t.currentWindow.Store(int32(window))
	t.mu.Lock()
	sessions := make([]*trackKCPSession, len(t.sessions))
	copy(sessions, t.sessions)
	t.mu.Unlock()
	for _, session := range sessions {
		session.setWindow(window)
		session.pump()
	}
}

func (t *MultiTrackKCPTunnel) AddSession(sub *VP8DataTunnel) {
	t.addSession(sub, false)
}

// AddProbedSession: a session on a track the far side may not hear yet (winger: the Telemost creator's screenshare,
// which the call forwards to the joiner only once the joiner's slot for it is bound, if ever). `probe` goes on it at
// once, a frame the far side's relay takes as nothing new; connections go on it only once the far side answers on it,
// and are closed should it stop answering while the far side still answers on the first session (see kcpDeafAfter).
// The far side must keep a session for it (ConfigKCPEveryTrack).
func (t *MultiTrackKCPTunnel) AddProbedSession(sub *VP8DataTunnel, probe []byte) {
	t.mu.Lock()
	t.probe = probe
	t.mu.Unlock()
	session := t.addSession(sub, true)
	session.send(probe)
	t.wake()
}

func (t *MultiTrackKCPTunnel) addSession(sub *VP8DataTunnel, probed bool) *trackKCPSession {
	window := int(t.currentWindow.Load())
	t.mu.Lock()
	index := len(t.sessions)
	conv := uint32(kcpConvBase + index)
	session := newTrackKCPSession(t, sub, conv, window)
	session.probed = probed
	t.sessions = append(t.sessions, session)
	t.convMap[conv] = session
	t.mu.Unlock()
	if t.fecOn.Load() {
		session.setFEC(true, index)
	}
	return session
}

// RemoveLastSession: the last session goes; the connections on it are closed (retire) rather than carried on
// another session without what it still held for them.
func (t *MultiTrackKCPTunnel) RemoveLastSession() {
	t.mu.Lock()
	if len(t.sessions) <= 1 {
		t.mu.Unlock()
		return
	}
	index := len(t.sessions) - 1
	last := t.sessions[index]
	last.removed.Store(true)
	t.mu.Unlock()
	t.retire(index)
	t.mu.Lock()
	if index < len(t.sessions) && t.sessions[index] == last {
		t.sessions = t.sessions[:index]
		delete(t.convMap, last.conv)
	}
	t.mu.Unlock()
	last.gate.shut() // winger: what still waits for it would never get room (its connections are closed)
}

func (t *MultiTrackKCPTunnel) Stop() {
	t.stopOnce.Do(func() { close(t.stopCh) })
	t.mt.Stop()
}

func (t *MultiTrackKCPTunnel) StopLayer() {
	t.stopOnce.Do(func() { close(t.stopCh) })
}

func (t *MultiTrackKCPTunnel) handleInnerClose() {
	t.stopOnce.Do(func() { close(t.stopCh) })
	t.mu.Lock()
	callback := t.onClose
	t.mu.Unlock()
	if callback != nil {
		callback()
	}
}

// watchProbed (updateLoop; winger): a probed session whose waiting segments go unanswered for kcpDeafAfter, while the
// far side answers on the first session well after this one's last answer, is deaf (the call stopped forwarding its
// track, or its data channel closed): its connections are closed and new ones go elsewhere until the far side answers
// on it again (its resends get through). A first session with nothing waiting gets the probe now and then, so that a
// far side with nothing to send still says whether it is there.
func (t *MultiTrackKCPTunnel) watchProbed(index int, s, first *trackKCPSession, now int64) {
	if s.busySince == 0 || !s.heard.Load() || s == first {
		return // not in use: nothing on it to close
	}
	quiet := time.Duration(now - s.busySince)
	if quiet < kcpDeafMargin {
		return
	}
	t.mu.Lock()
	probe := t.probe
	t.mu.Unlock()
	if probe != nil && now-t.lastFirstProbe >= int64(kcpProbeEvery) && first.waitSnd() == 0 {
		t.lastFirstProbe = now
		first.send(probe)
	}
	if quiet < kcpDeafAfter || first.lastIn.Load() <= s.busySince+int64(kcpDeafMargin) {
		return
	}
	if s.heard.CompareAndSwap(true, false) {
		if t.logFn != nil {
			t.logFn("kcptunnel: session %d unanswered for %s while the first is answered: not in use until it is", index, quiet.Round(time.Second))
		}
		t.retire(index)
	}
}

// trackBusy (updateLoop): since when something has waited on the session without an answer from the far side on it.
func (s *trackKCPSession) trackBusy(waiting int, now int64) {
	if waiting == 0 || s.removed.Load() {
		s.busySince = 0
		return
	}
	if s.busySince == 0 {
		s.busySince = now
	}
	if last := s.lastIn.Load(); last > s.busySince {
		s.busySince = last
	}
}

// noteUnanswered (updateLoop): the longest something has waited on a session this side sends on with no word from
// the far side on any session meanwhile (Unanswered).
func (t *MultiTrackKCPTunnel) noteUnanswered(sessions []*trackKCPSession, now int64) {
	var heard int64
	for _, s := range sessions {
		if in := s.lastIn.Load(); in > heard {
			heard = in
		}
	}
	n := len(sessions)
	if s := int(t.sendSessions.Load()); s > 0 && s < n {
		n = s
	}
	var worst time.Duration
	for _, s := range sessions[:n] {
		if s.busySince == 0 {
			continue
		}
		if quiet := time.Duration(now - max(s.busySince, heard)); quiet > worst {
			worst = quiet
		}
	}
	t.unanswered.Store(int64(worst))
}

// Unanswered: how long what this side sent has waited with no word at all from the far side (0: nothing waits, or
// the far side speaks). winger: the Telemost joiner reconnects when it grows long — the creator's tunnel may have
// started afresh under it, and an older creator never says so.
func (t *MultiTrackKCPTunnel) Unanswered() time.Duration {
	return time.Duration(t.unanswered.Load())
}

// Done: closed once the reliable layer stops.
func (t *MultiTrackKCPTunnel) Done() <-chan struct{} {
	return t.stopCh
}

// wake: nudge the update loop out of its idle pace. winger: only an idle loop is nudged: every segment received and
// every message sent used to wake it, a goroutine wake-up each, almost always for nothing (it ticks every 10 ms anyway
// while there is work, and keeps that pace while segments come in).
func (t *MultiTrackKCPTunnel) wake() {
	if !t.updateIdle.Load() {
		return
	}
	select {
	case t.nudge <- struct{}{}:
	default:
	}
}

// pendingAll: what the sessions hold to send, and data waiting for room in them.
func (t *MultiTrackKCPTunnel) pendingAll(sessions []*trackKCPSession) int {
	pending := 0
	for _, session := range sessions {
		pending += session.waitSnd()
		if session.gate.hasWaiting() {
			pending++
		}
	}
	return pending
}

func (t *MultiTrackKCPTunnel) updateLoop() {
	ticker := time.NewTicker(kcpUpdateInterval)
	defer ticker.Stop()
	ticks := 0
	idleTicks := 0
	fast := true
	var lastInput uint64
	for {
		select {
		case <-t.stopCh:
			return
		case <-t.nudge:
			idleTicks = 0 // winger: something came or went; acks may be waiting for the next flush
			if !fast {
				fast = true
				t.updateIdle.Store(false)
				ticker.Reset(kcpUpdateInterval)
			}
		case <-ticker.C:
			t.mu.Lock()
			sessions := make([]*trackKCPSession, len(t.sessions))
			copy(sessions, t.sessions)
			t.mu.Unlock()
			pending := 0
			now, mono := time.Now(), monoNow()
			for i, session := range sessions {
				session.update()
				session.pump()
				waiting := session.waitSnd()
				pending += waiting
				if session.gate.hasWaiting() {
					pending++ // winger: data waits for room; keep the quick tick
				}
				if ticks%kcpPruneEvery == 0 {
					session.gate.book.prune(now)
				}
				session.trackBusy(waiting, mono)
				if session.probed {
					t.watchProbed(i, session, sessions[0], mono)
				}
			}
			t.noteUnanswered(sessions, mono)
			t.sendFECReports(now)
			// winger: segments received since the last tick leave acks for the next flush: the loop keeps its quick
			// pace while they come in (they no longer nudge it each)
			if in := t.inputSegments.Load(); in != lastInput {
				lastInput = in
				pending++
			}
			if pending > 0 {
				idleTicks = 0
				if !fast {
					fast = true
					t.updateIdle.Store(false)
					ticker.Reset(kcpUpdateInterval)
				}
			} else if fast {
				idleTicks++
				if idleTicks >= kcpIdleAfterTicks {
					idleTicks = 0
					// say idle first, then look once more: a sender or a segment received either sees the flag and
					// nudges, or is seen here
					t.updateIdle.Store(true)
					if t.pendingAll(sessions) == 0 && t.inputSegments.Load() == lastInput {
						fast = false
						ticker.Reset(kcpIdleUpdateInterval)
					} else {
						t.updateIdle.Store(false)
					}
				}
			}
			ticks++
			if common.Debug && ticks%kcpStatsEvery == 0 && t.logFn != nil {
				t.logFn("kcptunnel: sessions=%d window=%d sent=%d delivered=%d out_segs=%d in_segs=%d raw_out=%d raw_in=%d dropped=%d resent=%d held=%d fec_parity=%d fec_rebuilt=%d",
					len(sessions), t.currentWindow.Load(), t.sentMessages.Load(), t.deliveredMessages.Load(),
					t.outputSegments.Load(), t.inputSegments.Load(),
					t.rawSent.Load(), t.rawReceived.Load(), t.droppedSegments.Load(), t.resentSegments.Load(), t.heldResends.Load(),
					t.fecParity.Load(), t.fecRecovered.Load())
				snmp := kcp.DefaultSnmp.Copy()
				t.logFn("kcptunnel: kcp_out=%d kcp_in=%d retrans=%d fastretrans=%d lost=%d repeat=%d",
					snmp.OutSegs, snmp.InSegs, snmp.RetransSegs, snmp.FastRetransSegs, snmp.LostSegs, snmp.RepeatSegs)
			}
		}
	}
}
