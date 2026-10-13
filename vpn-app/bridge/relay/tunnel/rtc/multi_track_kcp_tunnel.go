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
	kcpSegmentMTU     = VP8FramePacketBudget - tunnel.InterframeHdrLen - 24 - 16 - 1
	kcpReceiveBufSize = 128 * 1024
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
	conv    uint32
	vp8     *VP8DataTunnel
	parent  *MultiTrackKCPTunnel
	kcpMu   sync.Mutex
	kcp     *kcp.KCP
	recvBuf []byte

	// winger: a session the far side may not hear (AddProbedSession) takes connections only while the far side
	// answers on it; a removed one takes none, and a sender waiting for room on it gives up
	probed  bool
	heard   atomic.Bool
	removed atomic.Bool
	lastIn  atomic.Int64 // unix ns: the far side's last segment on it
	// updateLoop only
	busySince time.Time // something has waited on it, unanswered, since then (zero: nothing waits)

	// winger: what the packets KCP puts out carry and where they went (all under kcpMu)
	sentAny bool
	maxSN   uint32
	copies  [kcpSnRing]segCopy
	rtt     netRTT
	rack    int64 // when the latest-sent copy the far side acked went out

	// winger: the far side's next expected segment, how many past it it has acked one by one, and the segments handed
	// to KCP not yet put out: what is in flight is the rest
	peerUna uint32
	sacked  int
	pending int

	// winger: data waiting for room in it, least served connection first (kcp_gate.go)
	gate sessionGate
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
		conv:    conv,
		vp8:     vp8,
		parent:  parent,
		recvBuf: make([]byte, kcpReceiveBufSize),
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
		s.parent.heldResends.Add(1) // KCP tries again on its timer
		return
	}
	segment := make([]byte, size+1)
	segment[0] = kcpChannelReliable
	copy(segment[1:], buf[:size])
	s.parent.outputSegments.Add(1)
	var place framePlace
	ok := false
	if route == routeAhead {
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

// departed: when a segment's last copy left the carrier (0: it still waits there, -1: unknown or long ago).
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
	now := time.Now().UnixNano()
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
			case dep < 0:
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
	now := time.Now()
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
				if dep := s.departed(c); dep > 0 && now.UnixNano() > dep {
					rtt = now.UnixNano() - dep
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
	}
	s.kcp.Update()
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
		if size > len(s.recvBuf) {
			s.recvBuf = make([]byte, size)
		}
		n := s.kcp.Recv(s.recvBuf)
		if n <= 0 {
			break
		}
		message := make([]byte, n)
		copy(message, s.recvBuf[:n])
		messages = append(messages, message)
	}
	s.kcpMu.Unlock()
	return messages
}

func (s *trackKCPSession) update() {
	s.kcpMu.Lock()
	s.kcp.Update()
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

	stopCh   chan struct{}
	stopOnce sync.Once
	nudge    chan struct{}

	currentWindow atomic.Int32
	sendSessions  atomic.Int32 // winger: how many sessions this side sends on (0: all); the others only receive

	probe          []byte       // winger: a frame the far side's relay takes as nothing new (AddProbedSession; t.mu)
	lastFirstProbe time.Time    // updateLoop only
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
	t.wake()

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
	if len(conns) > 0 && t.logFn != nil {
		t.logFn("kcptunnel: %d connections closed with session %d", len(conns), index)
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

	if len(body) < 4 {
		return
	}
	conv := binary.LittleEndian.Uint32(body[0:4])
	t.mu.Lock()
	session := t.convMap[conv]
	callback := t.onData
	t.mu.Unlock()
	if session == nil {
		return
	}
	t.inputSegments.Add(1)
	t.wake()
	session.lastIn.Store(time.Now().UnixNano())
	if session.probed && session.heard.CompareAndSwap(false, true) && t.logFn != nil {
		t.logFn("kcptunnel: session %d answered by the far side, in use", conv-kcpConvBase)
	}
	messages := session.input(body)
	session.pump() // winger: acks may have made room
	if callback == nil {
		return
	}
	for _, message := range messages {
		t.deliveredMessages.Add(1)
		callback(message)
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
	conv := uint32(kcpConvBase + len(t.sessions))
	session := newTrackKCPSession(t, sub, conv, window)
	session.probed = probed
	t.sessions = append(t.sessions, session)
	t.convMap[conv] = session
	t.mu.Unlock()
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
func (t *MultiTrackKCPTunnel) watchProbed(index int, s, first *trackKCPSession, now time.Time) {
	if s.busySince.IsZero() || !s.heard.Load() || s == first {
		return // not in use: nothing on it to close
	}
	quiet := now.Sub(s.busySince)
	if quiet < kcpDeafMargin {
		return
	}
	t.mu.Lock()
	probe := t.probe
	t.mu.Unlock()
	if probe != nil && now.Sub(t.lastFirstProbe) >= kcpProbeEvery && first.waitSnd() == 0 {
		t.lastFirstProbe = now
		first.send(probe)
	}
	if quiet < kcpDeafAfter || !time.Unix(0, first.lastIn.Load()).After(s.busySince.Add(kcpDeafMargin)) {
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
func (s *trackKCPSession) trackBusy(waiting int, now time.Time) {
	if waiting == 0 || s.removed.Load() {
		s.busySince = time.Time{}
		return
	}
	if s.busySince.IsZero() {
		s.busySince = now
	}
	if last := time.Unix(0, s.lastIn.Load()); last.After(s.busySince) {
		s.busySince = last
	}
}

// noteUnanswered (updateLoop): the longest something has waited on a session this side sends on with no word from
// the far side on any session meanwhile (Unanswered).
func (t *MultiTrackKCPTunnel) noteUnanswered(sessions []*trackKCPSession, now time.Time) {
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
		if s.busySince.IsZero() {
			continue
		}
		since := s.busySince
		if last := time.Unix(0, heard); last.After(since) {
			since = last
		}
		if quiet := now.Sub(since); quiet > worst {
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

func (t *MultiTrackKCPTunnel) wake() {
	select {
	case t.nudge <- struct{}{}:
	default:
	}
}

func (t *MultiTrackKCPTunnel) updateLoop() {
	ticker := time.NewTicker(kcpUpdateInterval)
	defer ticker.Stop()
	ticks := 0
	idleTicks := 0
	fast := true
	for {
		select {
		case <-t.stopCh:
			return
		case <-t.nudge:
			idleTicks = 0 // winger: something came or went; acks may be waiting for the next flush
			if !fast {
				fast = true
				idleTicks = 0
				ticker.Reset(kcpUpdateInterval)
			}
		case <-ticker.C:
			t.mu.Lock()
			sessions := make([]*trackKCPSession, len(t.sessions))
			copy(sessions, t.sessions)
			t.mu.Unlock()
			pending := 0
			now := time.Now()
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
				session.trackBusy(waiting, now)
				if session.probed {
					t.watchProbed(i, session, sessions[0], now)
				}
			}
			t.noteUnanswered(sessions, now)
			if pending > 0 {
				idleTicks = 0
				if !fast {
					fast = true
					ticker.Reset(kcpUpdateInterval)
				}
			} else if fast {
				idleTicks++
				if idleTicks >= kcpIdleAfterTicks {
					fast = false
					idleTicks = 0
					ticker.Reset(kcpIdleUpdateInterval)
				}
			}
			ticks++
			if common.Debug && ticks%kcpStatsEvery == 0 && t.logFn != nil {
				t.logFn("kcptunnel: sessions=%d window=%d sent=%d delivered=%d out_segs=%d in_segs=%d raw_out=%d raw_in=%d dropped=%d resent=%d held=%d",
					len(sessions), t.currentWindow.Load(), t.sentMessages.Load(), t.deliveredMessages.Load(),
					t.outputSegments.Load(), t.inputSegments.Load(),
					t.rawSent.Load(), t.rawReceived.Load(), t.droppedSegments.Load(), t.resentSegments.Load(), t.heldResends.Load())
				snmp := kcp.DefaultSnmp.Copy()
				t.logFn("kcptunnel: kcp_out=%d kcp_in=%d retrans=%d fastretrans=%d lost=%d repeat=%d",
					snmp.OutSegs, snmp.InSegs, snmp.RetransSegs, snmp.FastRetransSegs, snmp.LostSegs, snmp.RepeatSegs)
			}
		}
	}
}
