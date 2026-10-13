package rtc

import (
	"encoding/binary"
	"math/rand"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	kcp "github.com/xtaci/kcp-go/v5"

	"whitelist-bypass/relay/tunnel"
)

// winger: a bench for the Telemost bridge's speed, the same for everyone who measures. A call's server (SFU) is
// modelled per track: a bandwidth cap with a short queue (a frame that would wait longer is dropped), a delay, random
// loss. The creator pushes a bulk download to the joiner the way the relay does: TCP read in chunks of CHUNK bytes,
// each one relay frame. What the joiner gets whole and in order, per second, is the result.
//
//   SIM=1 go test ./relay/tunnel/rtc/ -run TestSimBench -v      (settings by environment, defaults below)
//   FPS=24 BATCH=45 CHUNK=1126 DEPTH=1024 DUAL=1 CAP_MBIT=8 DELAY_MS=60 LOSS=0.01 SECS=8 CONNS=8 RELIABLE=1
//
// Everything below is off by default, so a run without it measures what the bench always measured:
//
//   CHUNK=kcp          the reliable way's whole-segment read of this version (KCPReadBufSize)
//   PKT=1 (or RTP=1)   a frame goes as the RTP packets the tracks' packetizer cuts it into (1200 less the 12-byte RTP
//                      header and a 4-byte VP8 descriptor with the picture id), each lost, queued and charged on its own
//                      (RTP header, header extension, SRTP tag, UDP/IP); the far side keeps a frame only when all its
//                      packets came, as the track readers do. NACK_MS=n: the call's server repairs a lost packet n ms
//                      later (WebRTC servers do on the NACKs pion sends); a late packet makes a frame only on its own, so
//                      a repair saves a one-packet frame, never a piece of a longer one
//   PROBE_MS=200       every n ms a new connection on the creator says "connected" (MsgConnectOK) and sends its first
//                      small answer (PROBE_BYTES, 300) and its close, the way a page's first reply goes; how long the
//                      answer takes to reach the joiner (one way, one clock) is reported as p50/p95/max while the
//                      downloads run. Probes still on their way at the end get up to 5 s more; one that never came
//                      counts as the time it waited
//   UPCONNS=n          the joiner uploads on n connections of its own beside the download (Winger sending while it
//                      receives); the upload's goodput is reported too
//   CAP_STEPS=8,3,8    the cap changes during the measured time (equal parts; the warm-up at the first value)
//   DELAY_STEPS=60,300 the delay likewise (order still kept: a frame never overtakes one sent before it)
//   JITTER_MS=n        a random extra delay up to n ms on every frame (order kept)
//   GATE_MS=n PLI=1    every n ms (about) the server re-binds each track and forwards nothing of it until a keyframe
//                      passes, asking the sender for one (PLI) on the way and again each second while it waits, as
//                      mediasoup, LiveKit and Jitsi do (whether Telemost's server does is not known); PLI=0: the
//                      camera tracks ignore the requests (the screenshare's sink always answered them)
//
// Besides the goodput it reports frames per second on every track, the link's drops (random loss apart from a full
// queue), segments the reliable layer could not queue on the carrier, KCP's resends by cause (timer, later acks,
// later acks with nothing new to send) and the segments the far side already had, and the CPU both sides used while
// measuring (cores, milliseconds per delivered megabyte; GOMAXPROCS=1 shows it on one core).

func envInt(k string, d int) int {
	if v, err := strconv.Atoi(os.Getenv(k)); err == nil {
		return v
	}
	return d
}

func envFloat(k string, d float64) float64 {
	if v, err := strconv.ParseFloat(os.Getenv(k), 64); err == nil {
		return v
	}
	return d
}

// envFloats: a comma-separated list (nil when unset or empty).
func envFloats(k string) []float64 {
	var out []float64
	for _, f := range strings.Split(os.Getenv(k), ",") {
		if v, err := strconv.ParseFloat(strings.TrimSpace(f), 64); err == nil {
			out = append(out, v)
		}
	}
	return out
}

// simLink: one track's way through the call's server: a cap (bytes per second; 0: none) with up to maxQueue of waiting,
// then the delay; loss before all of it. Order is kept.
type simLink struct {
	mu          sync.Mutex
	rnd         *rand.Rand
	loss        float64
	rate        float64
	maxQueue    time.Duration
	delay       time.Duration
	jitter      time.Duration
	nextFree    time.Time
	lastArrival time.Time
	ch          chan simItem
	to          func([]byte)
	rtp         rtp.Packetizer // PKT=1
	nack        time.Duration
	sent        atomic.Int64
	packets     atomic.Int64
	repaired    atomic.Int64
	dropped     atomic.Int64
	droppedFull atomic.Int64 // of dropped: the queue was full (the rest: random loss)
	sentBytes   atomic.Int64

	// winger: GATE_MS (see above)
	gateEvery time.Duration
	nextGate  time.Time
	unsynced  bool
	lastPLI   time.Time
	onPLI     func()
	gated     atomic.Int64
}

// simKeyframe: a VP8 frame whose first byte's lowest bit (P) is 0: the tunnel's keepalives.
func simKeyframe(frame []byte) bool { return len(frame) > 0 && frame[0]&0x01 == 0 }

// heldBack (l.mu held): the server waits for a keyframe on this track and holds the frame back (GATE_MS).
func (l *simLink) heldBack(now time.Time, frame []byte) bool {
	if l.gateEvery <= 0 {
		return false
	}
	if l.nextGate.IsZero() {
		l.nextGate = now.Add(time.Duration(l.rnd.Int63n(int64(l.gateEvery))))
	}
	if now.After(l.nextGate) {
		l.unsynced, l.lastPLI = true, time.Time{}
		l.nextGate = now.Add(l.gateEvery)
	}
	if l.unsynced && simKeyframe(frame) {
		l.unsynced = false
	}
	if !l.unsynced {
		return false
	}
	if now.Sub(l.lastPLI) >= time.Second && l.onPLI != nil {
		l.lastPLI = now
		time.AfterFunc(l.delay, l.onPLI)
	}
	l.gated.Add(1)
	return true
}

// simRTPOverhead: what an RTP packet carries on the wire besides its payload: RTP header 12, header extension 8
// (transport-wide sequence), SRTP tag 10, UDP/IP 28.
const simRTPOverhead = 12 + 8 + 10 + 28

type simItem struct {
	at    time.Time
	frame []byte
}

func newSimLink(seed int64, loss, capMbit float64, delay time.Duration, to func([]byte)) *simLink {
	l := &simLink{rnd: rand.New(rand.NewSource(seed)), loss: loss, rate: capMbit * 1e6 / 8, maxQueue: 150 * time.Millisecond,
		delay: delay, ch: make(chan simItem, 1<<16), to: to,
		jitter: time.Duration(envInt("JITTER_MS", 0)) * time.Millisecond}
	if envInt("PKT", 0) == 1 || envInt("RTP", 0) == 1 {
		l.rtp = rtp.NewPacketizer(1200, 96, uint32(seed), &codecs.VP8Payloader{EnablePictureID: true}, rtp.NewRandomSequencer(), 90000)
		l.nack = time.Duration(envInt("NACK_MS", 0)) * time.Millisecond
	}
	go func() {
		for it := range l.ch {
			if d := time.Until(it.at); d > 0 {
				time.Sleep(d)
			}
			l.to(it.frame)
		}
	}()
	return l
}

func (l *simLink) set(capMbit float64, delay time.Duration) {
	l.mu.Lock()
	l.rate = capMbit * 1e6 / 8
	l.delay = delay
	l.mu.Unlock()
}

// queueAt (l.mu held): when this many bytes leave the capped queue, or false when they would wait too long.
func (l *simLink) queueAt(now time.Time, size int) (time.Time, bool) {
	if l.rate <= 0 {
		return now, true
	}
	depart := now
	if l.nextFree.After(now) {
		depart = l.nextFree
	}
	if depart.Sub(now) > l.maxQueue { // the call's server would not hold it that long: lost
		return now, false
	}
	l.nextFree = depart.Add(time.Duration(float64(size) / l.rate * float64(time.Second)))
	return depart, true
}

// arrivalAt (l.mu held): when what left the queue at depart reaches the far side; never before what was sent earlier.
func (l *simLink) arrivalAt(depart time.Time) time.Time {
	at := depart.Add(l.delay)
	if l.jitter > 0 {
		at = at.Add(time.Duration(l.rnd.Int63n(int64(l.jitter))))
	}
	if at.Before(l.lastArrival) {
		at = l.lastArrival
	}
	l.lastArrival = at
	return at
}

func (l *simLink) send(frame []byte) error {
	if l.rtp != nil {
		return l.sendRTP(frame)
	}
	l.sent.Add(1)
	l.packets.Add(1)
	l.sentBytes.Add(int64(len(frame)) + 12 + 28) // RTP + UDP/IP on the wire
	now := time.Now()
	l.mu.Lock()
	if l.rnd.Float64() < l.loss {
		l.mu.Unlock()
		l.dropped.Add(1)
		return nil
	}
	if l.heldBack(now, frame) {
		l.mu.Unlock()
		return nil
	}
	depart, ok := l.queueAt(now, len(frame)+40)
	if !ok {
		l.mu.Unlock()
		l.dropped.Add(1)
		l.droppedFull.Add(1)
		return nil
	}
	at := l.arrivalAt(depart)
	l.mu.Unlock()
	l.ch <- simItem{at: at, frame: append([]byte(nil), frame...)}
	return nil
}

// sendRTP: the frame as its RTP packets; it arrives with its last packet, and only if none was lost (or, one packet
// long, its repair came).
func (l *simLink) sendRTP(frame []byte) error {
	l.sent.Add(1)
	now := time.Now()
	l.mu.Lock()
	if l.heldBack(now, frame) {
		l.mu.Unlock()
		return nil
	}
	pkts := l.rtp.Packetize(frame, 1)
	whole, full, repair := len(pkts) > 0, false, false
	last := now
	for _, p := range pkts {
		size := len(p.Payload) + simRTPOverhead
		l.packets.Add(1)
		l.sentBytes.Add(int64(size))
		if l.rnd.Float64() < l.loss {
			if l.nack > 0 && len(pkts) == 1 {
				if again, ok := l.queueAt(now.Add(l.nack), size); ok && l.rnd.Float64() >= l.loss {
					repair, last = true, again
					continue
				}
			}
			whole = false
			continue
		}
		depart, ok := l.queueAt(now, size)
		if !ok {
			whole, full = false, true
			continue
		}
		last = depart
	}
	if !whole {
		l.mu.Unlock()
		l.dropped.Add(1)
		if full {
			l.droppedFull.Add(1)
		}
		return nil
	}
	copied := append([]byte(nil), frame...)
	if repair {
		at := last.Add(l.delay)
		l.mu.Unlock()
		l.repaired.Add(1)
		time.AfterFunc(time.Until(at), func() { l.to(copied) })
		return nil
	}
	at := l.arrivalAt(last)
	l.mu.Unlock()
	l.ch <- simItem{at: at, frame: copied}
	return nil
}

type simConfig struct {
	fps, batch, chunk, depth int
	dual, reliable           bool
	capSteps                 []float64       // Mbit/s per equal part of the measured time (the first also warms up)
	delaySteps               []time.Duration // likewise
	loss                     float64
	secs, conns, upConns     int
	probeEvery               time.Duration
	probeBytes               int
}

// step: the cap and the delay of part i of the measured time.
func (c simConfig) step(i int) (float64, time.Duration) {
	return c.capSteps[min(i, len(c.capSteps)-1)], c.delaySteps[min(i, len(c.delaySteps)-1)]
}

type simResult struct {
	mbit, upMbit              float64
	phaseMbit                 []float64
	camRate, shareRate        float64 // frames per second while measured
	pubRate                   float64
	dropsLoss, dropsFull      int64 // the creator's tracks: random loss, a full queue
	pubDrops                  int64
	thrownCreator, thrownJoin uint64 // segments the reliable layer could not queue on the carrier
	segsOut, resent           uint64 // KCP's own count, both sides together
	rto, fast, early          uint64 // resends by timer, by later acks, by later acks with nothing new to send
	repeat                    uint64 // segments the receiving side already had
	packets, repaired         int64  // the creator's RTP packets (PKT=1), its frames the call's server repaired (NACK_MS)
	probeCtl, probeData       []time.Duration
	probeSent                 int
	gated                     int64         // GATE_MS: frames the server held back waiting for a keyframe
	cpu                       time.Duration // process CPU time during the measured seconds
	delivered                 int64         // payload bytes delivered (down and up) during them
}

const simProbeBase = uint32(1 << 24) // the probe connections' ids, far above the bulk ones

// simRun: one measurement with these settings.
func simRun(t testing.TB, c simConfig) simResult {
	secret := tunnel.DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/5050505050")
	cobf, _ := tunnel.NewTunnelObfuscator(secret)
	jobf, _ := tunnel.NewTunnelObfuscator(secret)
	quiet := func(string, ...any) {}
	cam := NewVP8DataTunnelWithQueue(nil, cobf, quiet, c.depth)
	share := NewVP8DataTunnelWithQueue(nil, cobf, quiet, c.depth)
	pub := NewVP8DataTunnelWithQueue(nil, jobf, quiet, c.depth)
	cap0, delay0 := c.step(0)
	camL := newSimLink(1, c.loss, cap0, delay0, pub.HandleFrame)
	shareL := newSimLink(2, c.loss, cap0, delay0, pub.HandleFrame)
	pubL := newSimLink(3, c.loss, cap0, delay0, cam.HandleFrame)
	links := []*simLink{camL, shareL, pubL}
	cam.WriteFrame, share.WriteFrame, pub.WriteFrame = camL.send, shareL.send, pubL.send
	if gate := time.Duration(envInt("GATE_MS", 0)) * time.Millisecond; gate > 0 {
		answer := envInt("PLI", 1) == 1
		camL.gateEvery, shareL.gateEvery, pubL.gateEvery = gate, gate, gate
		shareL.onPLI = func() { share.RequestKeyframe() }
		camL.onPLI = func() {
			if answer {
				cam.RequestKeyframe()
			}
		}
		pubL.onPLI = func() {
			if answer {
				pub.RequestKeyframe()
			}
		}
	}

	cmt := NewMultiTrackTunnel([]*VP8DataTunnel{cam})
	cmt.Start(c.fps, c.batch)
	jmt := NewMultiTrackTunnel([]*VP8DataTunnel{pub})
	jmt.Start(c.fps, c.batch)
	var creator, joiner tunnel.DataTunnel = cmt, jmt
	var ck, jk *MultiTrackKCPTunnel
	if c.dual {
		cmt.AddSubTunnel(share)
	}
	if c.reliable {
		ck = NewMultiTrackKCPTunnel(cmt, nil)
		for ck.SessionCount() > 1 {
			ck.RemoveLastSession()
		}
		jk = NewMultiTrackKCPTunnel(jmt, nil)
		if c.dual {
			// as the creator does: the screenshare session takes connections once the joiner answers on it
			ck.AddProbedSession(share, tunnel.EncodeFrame(tunnel.ControlConnID, tunnel.MsgConfigAck, nil))
			jk.AddSession(pub)
			jk.SetSendSessions(1)
		}
		creator, joiner = ck, jk
	}
	conns := c.conns
	var got atomic.Int64
	next := make([]uint32, conns+1)
	var bad atomic.Int64
	var probeMu sync.Mutex
	probeAt := map[uint32]time.Time{}       // when each probe connection began
	probeCtl := map[uint32]time.Duration{}  // its MsgConnectOK's way
	probeData := map[uint32]time.Duration{} // its first answer's way
	joiner.SetOnData(func(data []byte) {
		tunnel.DecodeFrames(data, func(conn uint32, msgType byte, payload []byte) {
			if conn >= simProbeBase {
				now := time.Now()
				probeMu.Lock()
				if at, ok := probeAt[conn]; ok {
					switch msgType {
					case tunnel.MsgConnectOK:
						probeCtl[conn] = now.Sub(at)
					case tunnel.MsgData:
						if _, seen := probeData[conn]; !seen {
							probeData[conn] = now.Sub(at)
						}
					}
				}
				probeMu.Unlock()
				return
			}
			if int(conn) > conns || len(payload) < 4 {
				return
			}
			if binary.BigEndian.Uint32(payload[0:4]) != next[conn] {
				bad.Add(1)
			}
			next[conn]++
			got.Add(int64(len(payload)))
		})
	})
	var upGot atomic.Int64
	creator.SetOnData(func(data []byte) {
		tunnel.DecodeFrames(data, func(conn uint32, _ byte, payload []byte) {
			if int(conn) > conns && int(conn) <= conns+c.upConns {
				upGot.Add(int64(len(payload)))
			}
		})
	})
	// the downloads start once the call is up: here, once the joiner has answered on every session (a round trip)
	for deadline := time.Now().Add(3 * time.Second); ck != nil && ck.ReadySessions() < ck.SessionCount() && time.Now().Before(deadline); {
		time.Sleep(10 * time.Millisecond)
	}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	bulk := func(side tunnel.DataTunnel, conn uint32) {
		defer wg.Done()
		body := make([]byte, c.chunk)
		for i := uint32(0); ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			if len(body) >= 4 {
				binary.BigEndian.PutUint32(body[0:4], i)
			}
			side.SendData(tunnel.EncodeFrame(conn, tunnel.MsgData, body))
		}
	}
	for conn := 1; conn <= conns; conn++ {
		wg.Add(1)
		go bulk(creator, uint32(conn))
	}
	for conn := conns + 1; conn <= conns+c.upConns; conn++ {
		wg.Add(1)
		go bulk(joiner, uint32(conn))
	}
	warm := 2 * time.Second
	time.Sleep(warm)

	probeStop := make(chan struct{})
	var probes []uint32
	if c.probeEvery > 0 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tick := time.NewTicker(c.probeEvery)
			defer tick.Stop()
			for id := simProbeBase; ; id++ {
				select {
				case <-probeStop:
					return
				case <-tick.C:
				}
				probeMu.Lock()
				probeAt[id] = time.Now()
				probes = append(probes, id)
				probeMu.Unlock()
				go func(id uint32) { // each one its own connection, as the relay's are
					creator.SendData(tunnel.EncodeFrame(id, tunnel.MsgConnectOK, nil))
					creator.SendData(tunnel.EncodeFrame(id, tunnel.MsgData, make([]byte, c.probeBytes)))
					creator.SendData(tunnel.EncodeFrame(id, tunnel.MsgClose, nil))
				}(id)
			}
		}()
	}

	snmp0 := kcp.DefaultSnmp.Copy()
	sent0 := [3]int64{camL.sent.Load(), shareL.sent.Load(), pubL.sent.Load()}
	loss0 := camL.dropped.Load() + shareL.dropped.Load()
	full0 := camL.droppedFull.Load() + shareL.droppedFull.Load()
	pubDrops0 := pubL.dropped.Load()
	pkts0, rep0 := camL.packets.Load()+shareL.packets.Load(), camL.repaired.Load()+shareL.repaired.Load()
	var thrown0 [2]uint64
	if ck != nil {
		thrown0 = [2]uint64{ck.droppedSegments.Load(), jk.droppedSegments.Load()}
	}
	start, upStart := got.Load(), upGot.Load()
	cpuStart := processCPU()
	parts := max(len(c.capSteps), len(c.delaySteps))
	phase := time.Duration(c.secs) * time.Second / time.Duration(parts)
	var phaseMbit []float64
	for i := 0; i < parts; i++ {
		if i > 0 {
			capMbit, delay := c.step(i)
			for _, l := range links {
				l.set(capMbit, delay)
			}
		}
		p0 := got.Load()
		time.Sleep(phase)
		phaseMbit = append(phaseMbit, float64(got.Load()-p0)*8/1e6/phase.Seconds())
	}
	total, upTotal := got.Load()-start, upGot.Load()-upStart
	cpu := processCPU() - cpuStart
	snmp1 := kcp.DefaultSnmp.Copy()
	secs := float64(c.secs)
	r := simResult{mbit: float64(total) * 8 / 1e6 / secs, upMbit: float64(upTotal) * 8 / 1e6 / secs, phaseMbit: phaseMbit,
		camRate:   float64(camL.sent.Load()-sent0[0]) / secs,
		shareRate: float64(shareL.sent.Load()-sent0[1]) / secs,
		pubRate:   float64(pubL.sent.Load()-sent0[2]) / secs,
		dropsFull: camL.droppedFull.Load() + shareL.droppedFull.Load() - full0,
		pubDrops:  pubL.dropped.Load() - pubDrops0,
		segsOut:   snmp1.OutSegs - snmp0.OutSegs, resent: snmp1.RetransSegs - snmp0.RetransSegs,
		rto: snmp1.LostSegs - snmp0.LostSegs, fast: snmp1.FastRetransSegs - snmp0.FastRetransSegs,
		early: snmp1.EarlyRetransSegs - snmp0.EarlyRetransSegs, repeat: snmp1.RepeatSegs - snmp0.RepeatSegs,
		packets:  camL.packets.Load() + shareL.packets.Load() - pkts0,
		repaired: camL.repaired.Load() + shareL.repaired.Load() - rep0,
		gated:    camL.gated.Load() + shareL.gated.Load() + pubL.gated.Load(),
		cpu:      cpu, delivered: total + upTotal}
	r.dropsLoss = camL.dropped.Load() + shareL.dropped.Load() - loss0 - r.dropsFull
	if ck != nil {
		r.thrownCreator, r.thrownJoin = ck.droppedSegments.Load()-thrown0[0], jk.droppedSegments.Load()-thrown0[1]
	}

	close(probeStop)
	// the last probes still on their way get up to 5 s more under the same load
	for until := time.Now().Add(5 * time.Second); c.probeEvery > 0 && time.Now().Before(until); time.Sleep(20 * time.Millisecond) {
		probeMu.Lock()
		done := len(probeData) >= len(probes)
		probeMu.Unlock()
		if done {
			break
		}
	}
	close(stop)
	if ck != nil {
		ck.Stop()
		jk.Stop()
	} else {
		cmt.Stop()
		jmt.Stop()
	}
	if bad.Load() > 0 && c.reliable {
		t.Errorf("%d messages out of order or lost on the reliable way", bad.Load())
	}
	probeMu.Lock()
	r.probeSent = len(probes)
	for _, id := range probes {
		never := time.Since(probeAt[id])
		for _, p := range []struct {
			got map[uint32]time.Duration
			out *[]time.Duration
		}{{probeCtl, &r.probeCtl}, {probeData, &r.probeData}} {
			if d, ok := p.got[id]; ok {
				*p.out = append(*p.out, d)
			} else {
				*p.out = append(*p.out, never)
			}
		}
	}
	probeMu.Unlock()
	slices.Sort(r.probeCtl)
	slices.Sort(r.probeData)
	return r
}

// pct: the p-th percentile (0..100) of sorted delays (0 when there are none).
func pct(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	return sorted[int(float64(len(sorted)-1)*p/100)]
}

func TestSimBench(t *testing.T) {
	if os.Getenv("SIM") == "" {
		t.Skip("SIM=1 to run the speed bench")
	}
	chunk := envInt("CHUNK", 1126)
	if os.Getenv("CHUNK") == "kcp" { // winger: what the creator reads on the reliable way in this version
		chunk = KCPReadBufSize
	}
	c := simConfig{fps: envInt("FPS", 24), batch: envInt("BATCH", 45), chunk: chunk,
		depth: envInt("DEPTH", KCPCarrierQueueDepth), dual: envInt("DUAL", 0) == 1, reliable: envInt("RELIABLE", 1) == 1,
		capSteps: []float64{envFloat("CAP_MBIT", 8)}, loss: envFloat("LOSS", 0.01),
		delaySteps: []time.Duration{time.Duration(envInt("DELAY_MS", 60)) * time.Millisecond},
		secs:       envInt("SECS", 8), conns: envInt("CONNS", 8), upConns: envInt("UPCONNS", 0),
		probeEvery: time.Duration(envInt("PROBE_MS", 0)) * time.Millisecond, probeBytes: envInt("PROBE_BYTES", 300)}
	if steps := envFloats("CAP_STEPS"); len(steps) > 0 {
		c.capSteps = steps
	}
	if steps := envFloats("DELAY_STEPS"); len(steps) > 0 {
		c.delaySteps = nil
		for _, ms := range steps {
			c.delaySteps = append(c.delaySteps, time.Duration(ms*float64(time.Millisecond)))
		}
	}
	r := simRun(t, c)
	phases := ""
	if len(r.phaseMbit) > 1 {
		for _, m := range r.phaseMbit {
			phases += " " + strconv.FormatFloat(m, 'f', 2, 64)
		}
		phases = " phases=" + strings.TrimSpace(phases)
	}
	t.Logf("RESULT goodput=%.2f Mbit/s%s up=%.2f Mbit/s frames/s cam=%.0f share=%.0f pub=%.0f",
		r.mbit, phases, r.upMbit, r.camRate, r.shareRate, r.pubRate)
	t.Logf("DROPS link loss=%d full=%d joinerTrack=%d thrown(creator/joiner)=%d/%d rtpPackets=%d repaired=%d",
		r.dropsLoss, r.dropsFull, r.pubDrops, r.thrownCreator, r.thrownJoin, r.packets, r.repaired)
	t.Logf("RESENDS kcpOut=%d resent=%d (rto %d fast %d early %d) repeat=%d", r.segsOut, r.resent, r.rto, r.fast, r.early, r.repeat)
	if r.probeSent > 0 {
		ms := func(d time.Duration) int64 { return d.Milliseconds() }
		t.Logf("PROBE n=%d first-answer p50=%dms p95=%dms max=%dms connect-ok p50=%dms p95=%dms", r.probeSent,
			ms(pct(r.probeData, 50)), ms(pct(r.probeData, 95)), ms(pct(r.probeData, 100)), ms(pct(r.probeCtl, 50)), ms(pct(r.probeCtl, 95)))
	}
	perMB := 0.0
	if r.delivered > 0 {
		perMB = r.cpu.Seconds() * 1000 / (float64(r.delivered) / 1e6)
	}
	t.Logf("CPU cores=%.2f ms/MB=%.1f (GOMAXPROCS=%d)", r.cpu.Seconds()/float64(c.secs), perMB, runtime.GOMAXPROCS(0))
	if r.gated > 0 {
		t.Logf("GATE frames held back by the server waiting for a keyframe: %d", r.gated)
	}
}
