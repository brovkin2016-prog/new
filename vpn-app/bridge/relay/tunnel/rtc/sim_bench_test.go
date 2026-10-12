package rtc

import (
	"encoding/binary"
	"math/rand"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"whitelist-bypass/relay/tunnel"
)

// winger: a bench for the Telemost bridge's speed, the same for everyone who measures. A call's server (SFU) is
// modelled per track: a bandwidth cap with a short queue (a frame that would wait longer is dropped), a delay, random
// loss. The creator pushes a bulk download to the joiner the way the relay does: TCP read in chunks of CHUNK bytes,
// each one relay frame. What the joiner gets whole and in order, per second, is the result.
//
//   SIM=1 go test ./relay/tunnel/rtc/ -run TestSimBench -v      (settings by environment, defaults below)
//   FPS=24 BATCH=45 CHUNK=1126 DEPTH=1024 DUAL=1 CAP_MBIT=8 DELAY_MS=60 LOSS=0.01 SECS=8 CONNS=8 RELIABLE=1

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

// simLink: one track's way through the call's server: a cap (bytes per second; 0: none) with up to maxQueue of waiting,
// then the delay; loss before all of it. Order is kept.
type simLink struct {
	mu        sync.Mutex
	rnd       *rand.Rand
	loss      float64
	rate      float64
	maxQueue  time.Duration
	delay     time.Duration
	nextFree  time.Time
	ch        chan simItem
	to        func([]byte)
	sent      atomic.Int64
	dropped   atomic.Int64
	sentBytes atomic.Int64
}

type simItem struct {
	at    time.Time
	frame []byte
}

func newSimLink(seed int64, loss, capMbit float64, delay time.Duration, to func([]byte)) *simLink {
	l := &simLink{rnd: rand.New(rand.NewSource(seed)), loss: loss, rate: capMbit * 1e6 / 8, maxQueue: 150 * time.Millisecond,
		delay: delay, ch: make(chan simItem, 1<<16), to: to}
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

func (l *simLink) send(frame []byte) error {
	l.sent.Add(1)
	l.sentBytes.Add(int64(len(frame)) + 12 + 28) // RTP + UDP/IP on the wire
	now := time.Now()
	l.mu.Lock()
	if l.rnd.Float64() < l.loss {
		l.mu.Unlock()
		l.dropped.Add(1)
		return nil
	}
	depart := now
	if l.rate > 0 {
		if l.nextFree.After(now) {
			depart = l.nextFree
		}
		if depart.Sub(now) > l.maxQueue { // the call's server would not hold it that long: lost
			l.mu.Unlock()
			l.dropped.Add(1)
			return nil
		}
		l.nextFree = depart.Add(time.Duration(float64(len(frame)+40) / l.rate * float64(time.Second)))
	}
	l.mu.Unlock()
	l.ch <- simItem{at: depart.Add(l.delay), frame: append([]byte(nil), frame...)}
	return nil
}

type simResult struct {
	mbit                   float64
	camFrames, shareFrames int64
	dropsCap, dropsQueue   int64
}

// simRun: one measurement with these settings.
func simRun(t testing.TB, fps, batch, chunk, depth int, dual, reliable bool, capMbit, loss float64, delay time.Duration, secs, conns int) simResult {
	secret := tunnel.DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/5050505050")
	cobf, _ := tunnel.NewTunnelObfuscator(secret)
	jobf, _ := tunnel.NewTunnelObfuscator(secret)
	quiet := func(string, ...any) {}
	cam := NewVP8DataTunnelWithQueue(nil, cobf, quiet, depth)
	share := NewVP8DataTunnelWithQueue(nil, cobf, quiet, depth)
	pub := NewVP8DataTunnelWithQueue(nil, jobf, quiet, depth)
	camL := newSimLink(1, loss, capMbit, delay, pub.HandleFrame)
	shareL := newSimLink(2, loss, capMbit, delay, pub.HandleFrame)
	pubL := newSimLink(3, loss, capMbit, delay, cam.HandleFrame)
	cam.WriteFrame, share.WriteFrame, pub.WriteFrame = camL.send, shareL.send, pubL.send

	cmt := NewMultiTrackTunnel([]*VP8DataTunnel{cam})
	cmt.Start(fps, batch)
	jmt := NewMultiTrackTunnel([]*VP8DataTunnel{pub})
	jmt.Start(fps, batch)
	var creator, joiner tunnel.DataTunnel = cmt, jmt
	var ck, jk *MultiTrackKCPTunnel
	if dual {
		cmt.AddSubTunnel(share)
	}
	if reliable {
		ck = NewMultiTrackKCPTunnel(cmt, nil)
		for ck.SessionCount() > 1 {
			ck.RemoveLastSession()
		}
		jk = NewMultiTrackKCPTunnel(jmt, nil)
		if dual {
			ck.AddSession(share)
			jk.AddSession(pub)
			jk.SetSendSessions(1)
		}
		creator, joiner = ck, jk
	}
	var got atomic.Int64
	next := make([]uint32, conns+1)
	var bad atomic.Int64
	joiner.SetOnData(func(data []byte) {
		tunnel.DecodeFrames(data, func(conn uint32, _ byte, payload []byte) {
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
	creator.SetOnData(func([]byte) {})
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for c := 1; c <= conns; c++ {
		wg.Add(1)
		go func(conn uint32) {
			defer wg.Done()
			body := make([]byte, chunk)
			for i := uint32(0); ; i++ {
				select {
				case <-stop:
					return
				default:
				}
				binary.BigEndian.PutUint32(body[0:4], i)
				creator.SendData(tunnel.EncodeFrame(conn, tunnel.MsgData, body))
			}
		}(uint32(c))
	}
	warm := 2 * time.Second
	time.Sleep(warm)
	start := got.Load()
	time.Sleep(time.Duration(secs) * time.Second)
	total := got.Load() - start
	close(stop)
	if ck != nil {
		ck.Stop()
		jk.Stop()
	} else {
		cmt.Stop()
		jmt.Stop()
	}
	if bad.Load() > 0 && reliable {
		t.Errorf("%d messages out of order or lost on the reliable way", bad.Load())
	}
	return simResult{mbit: float64(total) * 8 / 1e6 / float64(secs), camFrames: camL.sent.Load(), shareFrames: shareL.sent.Load(),
		dropsCap: camL.dropped.Load() + shareL.dropped.Load()}
}

func TestSimBench(t *testing.T) {
	if os.Getenv("SIM") == "" {
		t.Skip("SIM=1 to run the speed bench")
	}
	r := simRun(t, envInt("FPS", 24), envInt("BATCH", 45), envInt("CHUNK", 1126), envInt("DEPTH", KCPCarrierQueueDepth),
		envInt("DUAL", 0) == 1, envInt("RELIABLE", 1) == 1, envFloat("CAP_MBIT", 8), envFloat("LOSS", 0.01),
		time.Duration(envInt("DELAY_MS", 60))*time.Millisecond, envInt("SECS", 8), envInt("CONNS", 8))
	t.Logf("RESULT goodput=%.2f Mbit/s camFrames=%d shareFrames=%d dropped(cap+loss)=%d", r.mbit, r.camFrames, r.shareFrames, r.dropsCap)
}
