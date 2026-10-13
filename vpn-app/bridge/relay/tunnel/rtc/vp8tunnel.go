package rtc

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/kulikov0/headless-client/webrtc"
	"github.com/kulikov0/headless-client/webrtc/pkg/media"

	"whitelist-bypass/relay/common"
	"whitelist-bypass/relay/tunnel"
)

const (
	defaultVP8FPS       = 24
	defaultVP8Batch     = 30
	keepaliveIdlePeriod = 100 * time.Millisecond
	keepaliveIdleMin    = 60 * time.Millisecond
	keepaliveIdleMax    = 200 * time.Millisecond
	keepalivePadMax     = 176
	sendQueueDepth      = 128
	// winger: a few frames that go out ahead of the queue (the reliable layer's acks and quick resends); more than this
	// at once wait in the queue like the rest
	urgentQueueDepth = 16
	// winger: how many of the last frames' departure times are kept (more than the deepest queue)
	departRing = 4096

	paceBatchFloorPercent = 80
	paceDriftMin          = 5 * time.Second
	paceDriftMax          = 20 * time.Second

	idleSpinTicks = 40

	// winger: a browser's encoder makes at most one keyframe per 300 ms however often it is asked
	keyframeMinInterval = 300 * time.Millisecond
)

type VP8DataTunnel struct {
	track     *webrtc.TrackLocalStaticSample
	logFn     func(string, ...any)
	obf       *tunnel.TunnelObfuscator
	stopCh    chan struct{}
	sendQueue chan []byte
	urgent    chan []byte
	cfgChan   chan struct{}

	stopOnce sync.Once
	running  atomic.Bool

	cfgMu           sync.Mutex
	fps             int
	batch           int
	keepaliveMin    time.Duration
	keepaliveMax    time.Duration
	keepalivePadMax int

	sentFrames      atomic.Uint64
	recvFrames      atomic.Uint64
	keepaliveFrames atomic.Uint64

	queued       departures
	urgentQueued departures
	dropReq      chan chan int // winger: DropQueued, done by the writer (which alone takes frames)

	// winger: a keyframe the call's server asked for (PLI/FIR), sent ahead of the queued data
	keyframeWanted atomic.Bool
	keyframeNudge  chan struct{}
	lastKeyframe   atomic.Int64
	keyframeAsked  atomic.Uint64
	keyframeSent   atomic.Uint64

	OnData        func([]byte)
	OnClose       func()
	OnPeerRestart func()

	WriteFrame func([]byte) error
}

func (t *VP8DataTunnel) SetOnData(fn func([]byte))  { t.OnData = fn }
func (t *VP8DataTunnel) SetOnClose(fn func())       { t.OnClose = fn }
func (t *VP8DataTunnel) SetOnPeerRestart(fn func()) { t.OnPeerRestart = fn }

func NewVP8DataTunnel(track *webrtc.TrackLocalStaticSample, obf *tunnel.TunnelObfuscator, logFn func(string, ...any)) *VP8DataTunnel {
	return NewVP8DataTunnelWithQueue(track, obf, logFn, sendQueueDepth)
}

func NewVP8DataTunnelWithQueue(track *webrtc.TrackLocalStaticSample, obf *tunnel.TunnelObfuscator, logFn func(string, ...any), queueDepth int) *VP8DataTunnel {
	if queueDepth < sendQueueDepth {
		queueDepth = sendQueueDepth
	}
	return &VP8DataTunnel{
		track:           track,
		obf:             obf,
		logFn:           logFn,
		stopCh:          make(chan struct{}),
		sendQueue:       make(chan []byte, queueDepth),
		urgent:          make(chan []byte, urgentQueueDepth),
		cfgChan:         make(chan struct{}, 1),
		keyframeNudge:   make(chan struct{}, 1),
		dropReq:         make(chan chan int),
		fps:             defaultVP8FPS,
		batch:           defaultVP8Batch,
		keepaliveMin:    keepaliveIdleMin,
		keepaliveMax:    keepaliveIdleMax,
		keepalivePadMax: keepalivePadMax,
	}
}

func (t *VP8DataTunnel) nextKeepalive(sampleInterval time.Duration) (ticks, padLen int) {
	t.cfgMu.Lock()
	minPeriod, maxPeriod, padMax := t.keepaliveMin, t.keepaliveMax, t.keepalivePadMax
	t.cfgMu.Unlock()
	ticks = int(common.DurationInRange(minPeriod, maxPeriod) / sampleInterval)
	if ticks < 1 {
		ticks = 1
	}
	return ticks, common.IntInRange(0, padMax)
}

func (t *VP8DataTunnel) Reconfigure(fps, batch int) {
	if fps <= 0 && batch <= 0 {
		return
	}
	t.cfgMu.Lock()
	changed := false
	if fps > 0 && t.fps != fps {
		t.fps = fps
		changed = true
	}
	if batch > 0 && t.batch != batch {
		t.batch = batch
		changed = true
	}
	newFPS, newBatch := t.fps, t.batch
	t.cfgMu.Unlock()
	if !changed {
		return
	}
	t.logFn("vp8tunnel: reconfigure fps=%d batch=%d", newFPS, newBatch)
	select {
	case t.cfgChan <- struct{}{}:
	default:
	}
}

func (t *VP8DataTunnel) FPS() int {
	t.cfgMu.Lock()
	defer t.cfgMu.Unlock()
	return t.fps
}

func (t *VP8DataTunnel) Batch() int {
	t.cfgMu.Lock()
	defer t.cfgMu.Unlock()
	return t.batch
}

func (t *VP8DataTunnel) SendData(data []byte) {
	if len(data) == 0 {
		return
	}
	select {
	case t.sendQueue <- data:
		t.queued.put()
	case <-t.stopCh:
	}
}

func (t *VP8DataTunnel) TrySendData(data []byte) bool {
	_, ok := t.trySendPlaced(data, false)
	return ok
}

// winger: the reliable layer wants to know when each of its frames actually went out (its timers otherwise count the
// time a frame waits in the queue as time on the way).

// framePlace: a frame's place in the queue or in the short lane ahead of it (seq 0: nowhere).
type framePlace struct {
	seq    uint64
	urgent bool
}

// winger: monoNow: the clock the carrier and the reliable layer keep their times on, nanoseconds since the program
// started, never 0 or -1 (they mean "waits" and "unknown"). They were wall-clock readings: a step of the wall clock (an
// NTP or network time correction on a phone, a laptop that wakes up) made a copy that left before a backward step look
// as if it left in the future, and the resend guard held its resend for as long as the step; a forward step made the
// far side look silent that much longer.
var monoStart = time.Now()

func monoNow() int64 { return int64(time.Since(monoStart)) + 1 }

// departures: when the frames taken from one queue went out, by their place in it. The writer alone takes frames.
type departures struct {
	in, out atomic.Uint64
	at      [departRing]atomic.Int64
}

// put: one frame more in the queue; its place (give or take a frame another sender put in at the same moment).
func (d *departures) put() uint64 { return d.in.Add(1) }

// took: the writer took the next frame: its time first, then the count that shows it.
func (d *departures) took() {
	seq := d.out.Load() + 1
	d.at[seq%departRing].Store(monoNow())
	d.out.Store(seq)
}

// when: when the frame at this place went out (monoNow); 0 while it waits, -1 when unknown or long ago.
func (d *departures) when(seq uint64) int64 {
	done := d.out.Load()
	if seq > done {
		return 0
	}
	if seq == 0 || done-seq >= departRing-1 {
		return -1
	}
	return d.at[seq%departRing].Load()
}

// trySendPlaced: TrySendData, or with urgent ahead of everything queued (false: no room); and where the frame went.
func (t *VP8DataTunnel) trySendPlaced(data []byte, urgent bool) (framePlace, bool) {
	if len(data) == 0 {
		return framePlace{}, true
	}
	if urgent {
		select {
		case t.urgent <- data:
			return framePlace{seq: t.urgentQueued.put(), urgent: true}, true
		default:
			return framePlace{}, false
		}
	}
	select {
	case t.sendQueue <- data:
		return framePlace{seq: t.queued.put()}, true
	case <-t.stopCh:
		return framePlace{}, false
	default:
		return framePlace{}, false
	}
}

// DropQueued (winger): what waits in the queue and in the lane ahead of it is thrown away, counted as gone; how many
// frames. The Telemost creator does it when a new joiner comes: what waits is the stopped layer's, and the new joiner
// would take it for its new layer's own. The writer, which alone takes frames, does it, so every later frame keeps its
// place in departures.
func (t *VP8DataTunnel) DropQueued() int {
	if !t.running.Load() {
		return t.dropQueued()
	}
	reply := make(chan int, 1)
	select {
	case t.dropReq <- reply:
		return <-reply
	case <-t.stopCh:
		return 0
	}
}

func (t *VP8DataTunnel) dropQueued() int {
	for n := 0; ; n++ {
		select {
		case <-t.urgent:
			t.urgentQueued.took()
		case <-t.sendQueue:
			t.queued.took()
		default:
			return n
		}
	}
}

// departedAt: when the frame put there went out (0: it still waits, -1: unknown or long ago).
func (t *VP8DataTunnel) departedAt(p framePlace) int64 {
	if p.urgent {
		return t.urgentQueued.when(p.seq)
	}
	return t.queued.when(p.seq)
}

func (t *VP8DataTunnel) Start(fps, batch int) {
	t.cfgMu.Lock()
	if fps > 0 {
		t.fps = fps
	}
	if batch > 0 {
		t.batch = batch
	}
	t.cfgMu.Unlock()
	if !t.running.CompareAndSwap(false, true) {
		return
	}
	go t.writerLoop()
}

// RequestKeyframe (winger): the call's server asked this track for a picture (a PLI or FIR). A keepalive is a VP8
// keyframe, and every version of the far side reads it as a keepalive; but a busy writer sends only interframes, and a
// server that waits for a keyframe before it forwards a track (a new or re-bound subscriber) would hold everything
// back until the tunnel fell idle. So one goes out at the next tick, ahead of the queued data. False: too soon after
// the last keyframe, as a browser would ignore it too.
func (t *VP8DataTunnel) RequestKeyframe() bool {
	t.keyframeAsked.Add(1)
	// winger: a last keyframe that looks later than now is not to be trusted (the clock moved): the request is taken
	if last := t.lastKeyframe.Load(); last != 0 {
		if since := monoNow() - last; since >= 0 && since < int64(keyframeMinInterval) {
			return false
		}
	}
	t.keyframeWanted.Store(true)
	select {
	case t.keyframeNudge <- struct{}{}:
	default:
	}
	return true
}

// AnswerKeyframeRequests (winger): the call server's keyframe requests for this tunnel's track (read by
// DrainSenderRTCP) come to RequestKeyframe while the tunnel runs.
func (t *VP8DataTunnel) AnswerKeyframeRequests() {
	if t.track != nil {
		keyframeTargets.Store(webrtc.TrackLocal(t.track), t)
	}
}

func (t *VP8DataTunnel) Stop() {
	if t.track != nil {
		keyframeTargets.CompareAndDelete(webrtc.TrackLocal(t.track), t)
	}
	if !t.running.CompareAndSwap(true, false) {
		return
	}
	t.stopOnce.Do(func() { close(t.stopCh) })
	if t.OnClose != nil {
		t.OnClose()
	}
}

func (t *VP8DataTunnel) currentRate() (fps, batch int) {
	t.cfgMu.Lock()
	defer t.cfgMu.Unlock()
	return t.fps, t.batch
}

func sampleIntervalFor(fps, batch int) time.Duration {
	if fps < 1 {
		fps = 1
	}
	frameInterval := time.Second / time.Duration(fps)
	interval := frameInterval
	if batch > 1 {
		interval = frameInterval / time.Duration(batch)
	}
	if interval <= 0 {
		interval = time.Millisecond
	}
	return interval
}

func pacedBatchFor(batch int) int {
	if batch <= 1 {
		return batch
	}
	floor := batch * paceBatchFloorPercent / 100
	if floor < 1 {
		floor = 1
	}
	return common.IntInRange(floor, batch)
}

func (t *VP8DataTunnel) writerLoop() {
	for {
		fps, batch := t.currentRate()
		pacedBatch := pacedBatchFor(batch)
		sampleInterval := sampleIntervalFor(fps, pacedBatch)
		keepaliveEvery, keepalivePad := t.nextKeepalive(sampleInterval)
		t.logFn("vp8tunnel: writer (re)started fps=%d batch=%d pacedBatch=%d sampleInterval=%s keepaliveEvery=%d",
			fps, batch, pacedBatch, sampleInterval, keepaliveEvery)

		ticker := time.NewTicker(sampleInterval)
		drift := time.NewTimer(common.DurationInRange(paceDriftMin, paceDriftMax))
		idle := time.NewTimer(time.Hour)
		if !idle.Stop() {
			<-idle.C
		}
		idleTicks := 0
		spinning := true
		reconfigure := false

		emit := func(sample []byte, isKeepalive bool) {
			if sample == nil {
				return
			}
			if isKeepalive { // winger: noted before it goes, so a request that crosses it on the wire is not taken twice
				t.lastKeyframe.Store(monoNow())
			}
			if t.WriteFrame != nil {
				if err := t.WriteFrame(sample); err != nil {
					if common.Debug {
						t.logFn("vp8tunnel: WriteFrame error: %v", err)
					}
					return
				}
			} else if err := t.track.WriteSample(media.Sample{Data: sample, Duration: sampleInterval}); err != nil {
				if common.Debug {
					t.logFn("vp8tunnel: WriteSample error: %v", err)
				}
				return
			}
			n := t.sentFrames.Add(1)
			if isKeepalive {
				t.keepaliveFrames.Add(1)
			}
			if common.Debug && (n <= 5 || n%500 == 0) {
				keepalives := t.keepaliveFrames.Load()
				t.logFn("vp8tunnel: sent frame #%d size=%d data=%d keepalive=%d", n, len(sample), n-keepalives, keepalives)
			}
		}

		repace := func() {
			pacedBatch = pacedBatchFor(batch)
			sampleInterval = sampleIntervalFor(fps, pacedBatch)
			if spinning {
				ticker.Reset(sampleInterval)
			}
			keepaliveEvery, keepalivePad = t.nextKeepalive(sampleInterval)
			drift.Reset(common.DurationInRange(paceDriftMin, paceDriftMax))
			if common.Debug {
				t.logFn("vp8tunnel: pace drift pacedBatch=%d/%d sampleInterval=%s", pacedBatch, batch, sampleInterval)
			}
		}

		for !reconfigure {
			if spinning {
				select {
				case <-t.stopCh:
					ticker.Stop()
					drift.Stop()
					idle.Stop()
					return
				case <-t.cfgChan:
					reconfigure = true
				case <-drift.C:
					repace()
				case reply := <-t.dropReq:
					reply <- t.dropQueued()
				case <-ticker.C:
					if t.keyframeWanted.Swap(false) {
						emit(t.obf.EncodeKeepalive(keepalivePad), true)
						t.keyframeSent.Add(1)
						idleTicks = 0
						continue
					}
					select {
					case data := <-t.urgent:
						t.urgentQueued.took()
						emit(t.obf.EncodeData(data), false)
						idleTicks = 0
						continue
					default:
					}
					select {
					case data := <-t.sendQueue:
						t.queued.took()
						emit(t.obf.EncodeData(data), false)
						idleTicks = 0
					default:
						idleTicks++
						switch {
						case idleTicks >= keepaliveEvery:
							idleTicks = 0
							emit(t.obf.EncodeKeepalive(keepalivePad), true)
							keepaliveEvery, keepalivePad = t.nextKeepalive(sampleInterval)
						case idleTicks >= idleSpinTicks:
							ticker.Stop()
							spinning = false
							idle.Reset(time.Duration(keepaliveEvery-idleTicks) * sampleInterval)
						}
					}
				}
				continue
			}

			select {
			case <-t.stopCh:
				drift.Stop()
				idle.Stop()
				return
			case <-t.cfgChan:
				reconfigure = true
			case <-drift.C:
				repace()
			case reply := <-t.dropReq:
				reply <- t.dropQueued()
			case data := <-t.urgent:
				t.urgentQueued.took()
				if !idle.Stop() {
					select {
					case <-idle.C:
					default:
					}
				}
				emit(t.obf.EncodeData(data), false)
				idleTicks = 0
				spinning = true
				ticker.Reset(sampleInterval)
			case data := <-t.sendQueue:
				t.queued.took()
				if !idle.Stop() {
					select {
					case <-idle.C:
					default:
					}
				}
				emit(t.obf.EncodeData(data), false)
				idleTicks = 0
				spinning = true
				ticker.Reset(sampleInterval)
			case <-idle.C:
				idleTicks = 0
				emit(t.obf.EncodeKeepalive(keepalivePad), true)
				keepaliveEvery, keepalivePad = t.nextKeepalive(sampleInterval)
				idle.Reset(time.Duration(keepaliveEvery) * sampleInterval)
			case <-t.keyframeNudge:
				if t.keyframeWanted.Swap(false) {
					if !idle.Stop() {
						select {
						case <-idle.C:
						default:
						}
					}
					idleTicks = 0
					emit(t.obf.EncodeKeepalive(keepalivePad), true)
					t.keyframeSent.Add(1)
					keepaliveEvery, keepalivePad = t.nextKeepalive(sampleInterval)
					idle.Reset(time.Duration(keepaliveEvery) * sampleInterval)
				}
			}
		}
		ticker.Stop()
		drift.Stop()
		idle.Stop()
	}
}

func (t *VP8DataTunnel) HandleFrame(frame []byte) {
	res := t.obf.Decode(frame)
	if !res.HasFrame {
		return
	}
	if res.SelfEcho {
		return
	}
	if res.PeerRestart {
		t.logFn("vp8tunnel: peer restart detected, new epoch=0x%08x", res.PeerEpoch)
		if t.OnPeerRestart != nil {
			t.OnPeerRestart()
		}
	}
	if res.Keepalive || len(res.Payload) == 0 {
		return
	}
	n := t.recvFrames.Add(1)
	if common.Debug && (n <= 5 || n%500 == 0) {
		t.logFn("vp8tunnel: recv frame #%d size=%d", n, len(res.Payload))
	}
	if t.OnData != nil {
		t.OnData(res.Payload)
	}
}
