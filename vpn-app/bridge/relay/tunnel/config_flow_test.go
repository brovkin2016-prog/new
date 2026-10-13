package tunnel

import (
	"sync"
	"testing"
	"time"
)

// pipeTunnel hands what one side sends to the other side's OnData, and notes the rate it is told to send at.
type pipeTunnel struct {
	mu     sync.Mutex
	peer   *pipeTunnel
	onData func([]byte)
	fps    int
	batch  int
}

func (p *pipeTunnel) SendData(data []byte) {
	p.peer.mu.Lock()
	fn := p.peer.onData
	p.peer.mu.Unlock()
	if fn != nil {
		go fn(append([]byte(nil), data...))
	}
}
func (p *pipeTunnel) SetOnData(fn func([]byte)) { p.mu.Lock(); p.onData = fn; p.mu.Unlock() }
func (p *pipeTunnel) SetOnClose(func())         {}
func (p *pipeTunnel) Reconfigure(fps, batch int) {
	p.mu.Lock()
	p.fps, p.batch = fps, batch
	p.mu.Unlock()
}

// winger: the creator sends with parity only to a joiner that says it reads it (ConfigFEC); an older joiner's six-byte
// config says nothing of the kind, and a newer joiner followed by an older one turns it off again.
func TestCreatorSeesFECOnlyFromNewerJoiner(t *testing.T) {
	phone, server := &pipeTunnel{}, &pipeTunnel{}
	phone.peer, server.peer = server, phone
	quiet := func(string, ...any) {}
	creator := NewRelayBridge(server, "creator", 1126, quiet)
	defer creator.Reset()
	seen := make(chan byte, 4)
	creator.SetOnPeerConfig(func(int, int, int) { seen <- creator.PeerFlags() })
	for _, c := range []struct {
		config []byte
		fec    bool
	}{
		{EncodeVP8ConfigFlags(24, 45, 2, ConfigKCPEveryTrack|ConfigFEC), true},
		{EncodeVP8Config(24, 45, 2), false}, // an older joiner
		{EncodeVP8ConfigFlags(24, 45, 1, ConfigFEC), true},
		{EncodeVP8ConfigFlags(24, 45, 2, ConfigKCPEveryTrack), false},
	} {
		phone.SendData(c.config)
		select {
		case flags := <-seen:
			if (flags&ConfigFEC != 0) != c.fec {
				t.Fatalf("config %x: creator sees flags %#x, parity %v", c.config, flags, c.fec)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("the creator never took the config")
		}
	}
}

// The phone (joiner) asks for a rate; the creator's side sends at it from then on and says so, which stops the asking.
// DION's phone side relies on this: its server side has always answered it, it was only never asked.
func TestJoinerAsksCreatorForRate(t *testing.T) {
	phone, server := &pipeTunnel{}, &pipeTunnel{}
	phone.peer, server.peer = server, phone
	quiet := func(string, ...any) {}
	creator := NewRelayBridge(server, "creator", 1126, quiet)
	joiner := NewRelayBridge(phone, "joiner", 1126, quiet)
	defer creator.Reset()
	acked := make(chan struct{})
	var once sync.Once
	joiner.SetOnConfigAck(func() { once.Do(func() { close(acked) }) })
	done := make(chan struct{})
	go func() {
		SendVP8ConfigUntilAcked(acked, nil, nil, phone, 24, 20, 1, quiet, "test")
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the creator never acknowledged the rate")
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if server.fps != 24 || server.batch != 20 {
		t.Fatalf("creator sends at fps=%d batch=%d, want 24/20", server.fps, server.batch)
	}
}
