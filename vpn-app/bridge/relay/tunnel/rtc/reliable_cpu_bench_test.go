package rtc

import (
	"encoding/binary"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"whitelist-bypass/relay/tunnel"
)

// winger: the CPU cost of the reliable way itself, both sides in one process: relay frame -> KCP -> carrier queue ->
// obfuscation -> (no call: the frame is handed straight over) -> decode -> KCP -> relay frames, and the
// acknowledgements back. The tracks' writers are not started: a pump hands every queued item over as soon as it is
// there, so no ticker limits the rate and what is measured is CPU and allocations per byte. The creator sends on two
// tracks, the joiner on one, as in the Telemost bridge.
//
//   go test ./relay/tunnel/rtc/ -run '^$' -bench ReliablePath -benchmem -cpu 1,4

type reliablePipe struct {
	creator, joiner *MultiTrackKCPTunnel
	links           []pipeLink
	stop            chan struct{}
	wg              sync.WaitGroup
	delivered       atomic.Int64
	frames          atomic.Int64
}

type pipeLink struct {
	from *VP8DataTunnel
	to   *VP8DataTunnel
}

func newReliablePipe(tb testing.TB) *reliablePipe {
	secret := tunnel.DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/5050505050")
	cobf, _ := tunnel.NewTunnelObfuscator(secret)
	jobf, _ := tunnel.NewTunnelObfuscator(secret)
	quiet := func(string, ...any) {}
	cam := NewVP8DataTunnelWithQueue(nil, cobf, quiet, KCPCarrierQueueDepth)
	share := NewVP8DataTunnelWithQueue(nil, cobf, quiet, KCPCarrierQueueDepth)
	pub := NewVP8DataTunnelWithQueue(nil, jobf, quiet, KCPCarrierQueueDepth)
	cmt := NewMultiTrackTunnel([]*VP8DataTunnel{cam})
	ck := NewMultiTrackKCPTunnel(cmt, nil)
	cmt.AddSubTunnel(share)
	ck.AddSession(share)
	jmt := NewMultiTrackTunnel([]*VP8DataTunnel{pub})
	jk := NewMultiTrackKCPTunnel(jmt, nil)
	jk.AddSession(pub)
	jk.SetSendSessions(1)
	p := &reliablePipe{creator: ck, joiner: jk, stop: make(chan struct{}),
		links: []pipeLink{{cam, pub}, {share, pub}, {pub, cam}}}
	jk.SetOnData(func(data []byte) {
		tunnel.DecodeFrames(data, func(_ uint32, _ byte, payload []byte) { p.delivered.Add(int64(len(payload))) })
	})
	ck.SetOnData(func([]byte) {})
	for _, l := range p.links {
		p.wg.Add(1)
		go p.pump(l)
	}
	return p
}

// pump: one track's writer without its ticker: every queued item leaves at once, encoded as the writer does.
func (p *reliablePipe) pump(l pipeLink) {
	defer p.wg.Done()
	for {
		var data []byte
		select { // the short lane ahead of the queue first, as the writer takes it
		case data = <-l.from.urgent:
			l.from.urgentQueued.took()
		default:
			select {
			case <-p.stop:
				return
			case data = <-l.from.urgent:
				l.from.urgentQueued.took()
			case data = <-l.from.sendQueue:
				l.from.queued.took()
			}
		}
		frame := l.from.obf.EncodeData(data)
		p.frames.Add(1)
		l.to.HandleFrame(frame)
	}
}

func (p *reliablePipe) close() {
	close(p.stop)
	p.creator.StopLayer()
	p.joiner.StopLayer()
	p.wg.Wait()
}

func BenchmarkReliablePath(b *testing.B) {
	const conns = 8
	p := newReliablePipe(b)
	defer p.close()
	body := make([]byte, KCPReadBufSize)
	b.SetBytes(int64(len(body)))
	b.ReportAllocs()
	cpuStart := processCPU()
	start := time.Now()
	var seq [conns + 1]uint32
	i := 0
	for b.Loop() {
		conn := uint32(1 + i%conns)
		binary.BigEndian.PutUint32(body[0:4], seq[conn])
		seq[conn]++
		p.creator.SendData(tunnel.EncodeFrame(conn, tunnel.MsgData, body))
		i++
	}
	want := int64(i) * int64(len(body))
	deadline := time.Now().Add(30 * time.Second)
	for p.delivered.Load() < want {
		if time.Now().After(deadline) {
			b.Fatalf("delivered %d of %d bytes", p.delivered.Load(), want)
		}
		time.Sleep(200 * time.Microsecond)
	}
	b.StopTimer()
	cpu := processCPU() - cpuStart
	mb := float64(want) / 1e6
	b.ReportMetric(cpu.Seconds()*1000/mb, "cpu-ms/MB")
	b.ReportMetric(float64(p.frames.Load())/mb, "frames/MB")
	b.ReportMetric(mb*8/time.Since(start).Seconds(), "Mbit/s")
}
