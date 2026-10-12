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

const (
	kcpConvBase           = 0x77627374
	kcpUpdateInterval     = 10 * time.Millisecond
	kcpIdleUpdateInterval = 500 * time.Millisecond
	kcpIdleAfterTicks     = 50
	// One KCP segment must ride in a single RTP packet so a dropped packet
	// loses only its own frame, not a two-packet frame that readVP8Track
	// would discard whole. 1200 RTP budget - 1 VP8 descriptor - interframe
	// header - 24 XChaCha20 nonce - 16 Poly1305 tag - 1 channel tag.
	kcpSegmentMTU     = 1200 - 1 - tunnel.InterframeHdrLen - 24 - 16 - 1
	kcpReceiveBufSize = 128 * 1024
	// winger: what one TCP read may take on the reliable way: a whole number of full segments (segment data = MTU
	// - 24 KCP header) less the relay frame's own 9 bytes. A plain 1126-byte read made 1135 bytes, two segments of
	// which the second carried 22 bytes and still took a packet of its own: half the call's packets nearly empty.
	KCPReadBufSize = 29*(kcpSegmentMTU-24) - 4 - tunnel.WireHeaderLen
	kcpStatsEvery  = 500

	kcpWindowFloor      = 64
	kcpWindowCeiling    = 512
	kcpCarrierRTT       = 250 * time.Millisecond
	kcpWaitSndFactor    = 2
	kcpBackpressurePoll = 2 * time.Millisecond

	kcpChannelReliable byte = 0x00
	kcpChannelRaw      byte = 0x01

	KCPCarrierQueueDepth = kcpWaitSndFactor * kcpWindowCeiling

	// winger: a session the far side may not hear (AddProbedSession) is deaf once what waits on it has had no answer
	// this long while the far side answered on the first session more than kcpDeafMargin after its last answer. Long
	// enough that resends after a short gap (their timeout grows with each) come back first.
	kcpDeafAfter  = 10 * time.Second
	kcpDeafMargin = 3 * time.Second
	kcpProbeEvery = time.Second
)

func computeKCPWindow(fps, batch int) int {
	rate := fps * batch
	if rate < 1 {
		rate = defaultVP8FPS * defaultVP8Batch
	}
	window := int(float64(rate) * kcpCarrierRTT.Seconds())
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
}

// ready: new connections may go on it.
func (s *trackKCPSession) ready() bool {
	return !s.removed.Load() && (!s.probed || s.heard.Load())
}

func newTrackKCPSession(parent *MultiTrackKCPTunnel, vp8 *VP8DataTunnel, conv uint32, window int) *trackKCPSession {
	session := &trackKCPSession{
		conv:    conv,
		vp8:     vp8,
		parent:  parent,
		recvBuf: make([]byte, kcpReceiveBufSize),
	}
	session.kcp = kcp.NewKCP(conv, func(buf []byte, size int) {
		if size <= 0 {
			return
		}
		segment := make([]byte, size+1)
		segment[0] = kcpChannelReliable
		copy(segment[1:], buf[:size])
		parent.outputSegments.Add(1)
		if !session.vp8.TrySendData(segment) {
			parent.droppedSegments.Add(1)
		}
	})
	session.kcp.NoDelay(1, 10, 2, 1)
	session.kcp.WndSize(window, window)
	session.kcp.SetMtu(kcpSegmentMTU)
	return session
}

func (s *trackKCPSession) setWindow(window int) {
	s.kcpMu.Lock()
	s.kcp.WndSize(window, window)
	s.kcpMu.Unlock()
}

func (s *trackKCPSession) send(frame []byte) {
	s.kcpMu.Lock()
	s.kcp.Send(frame)
	s.kcp.Update()
	s.kcpMu.Unlock()
}

func (s *trackKCPSession) input(segment []byte) [][]byte {
	s.kcpMu.Lock()
	s.kcp.Input(segment, kcp.IKCP_PACKET_REGULAR, true)
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
	mt    *MultiTrackTunnel
	logFn func(string, ...any)

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

	probe          []byte    // winger: a frame the far side's relay takes as nothing new (AddProbedSession; t.mu)
	lastFirstProbe time.Time // updateLoop only

	sentMessages      atomic.Uint64
	deliveredMessages atomic.Uint64
	outputSegments    atomic.Uint64
	inputSegments     atomic.Uint64
	rawSent           atomic.Uint64
	rawReceived       atomic.Uint64
	droppedSegments   atomic.Uint64
}

func NewMultiTrackKCPTunnel(mt *MultiTrackTunnel, logFn func(string, ...any)) *MultiTrackKCPTunnel {
	t := &MultiTrackKCPTunnel{
		mt:      mt,
		logFn:   logFn,
		convMap: make(map[uint32]*trackKCPSession),
		connPin: make(map[uint32]int),
		stopCh:  make(chan struct{}),
		nudge:   make(chan struct{}, 1),
	}
	subs := mt.SubTunnels()
	window := kcpWindowFloor
	if len(subs) > 0 {
		window = computeKCPWindow(subs[0].FPS(), subs[0].Batch())
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
		sndCap := int(t.currentWindow.Load()) * kcpWaitSndFactor
		for session.waitSnd() >= sndCap {
			if !session.ready() {
				return // winger: its session was removed or went deaf; the connection is closed with it
			}
			select {
			case <-t.stopCh:
				return
			case <-time.After(kcpBackpressurePoll):
			}
		}
	}

	t.sentMessages.Add(1)
	session.send(frame)

	if msgType == tunnel.MsgClose {
		t.mu.Lock()
		delete(t.connPin, connID)
		t.mu.Unlock()
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
	for id, i := range t.connPin {
		if i == index {
			conns = append(conns, id)
			t.connPin[id] = retiredPin
		}
	}
	callback := t.onData
	t.mu.Unlock()
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
	window := computeKCPWindow(fps, batch)
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
func (t *MultiTrackKCPTunnel) watchProbed(index int, s, first *trackKCPSession, waiting int, now time.Time) {
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
	if !s.heard.Load() || s == first {
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
				waiting := session.waitSnd()
				pending += waiting
				if session.probed {
					t.watchProbed(i, session, sessions[0], waiting, now)
				}
			}
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
				t.logFn("kcptunnel: sessions=%d window=%d sent=%d delivered=%d out_segs=%d in_segs=%d raw_out=%d raw_in=%d dropped=%d",
					len(sessions), t.currentWindow.Load(), t.sentMessages.Load(), t.deliveredMessages.Load(),
					t.outputSegments.Load(), t.inputSegments.Load(),
					t.rawSent.Load(), t.rawReceived.Load(), t.droppedSegments.Load())
				snmp := kcp.DefaultSnmp.Copy()
				t.logFn("kcptunnel: kcp_out=%d kcp_in=%d retrans=%d fastretrans=%d lost=%d repeat=%d",
					snmp.OutSegs, snmp.InSegs, snmp.RetransSegs, snmp.FastRetransSegs, snmp.LostSegs, snmp.RepeatSegs)
			}
		}
	}
}
