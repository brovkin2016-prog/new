package rtc

import (
	"testing"
	"time"

	"whitelist-bypass/relay/tunnel"
)

// winger: the reliable layer's send gate. Nothing leaves the track here and no ack ever comes, so KCP's room only opens
// when the test opens it, one message at a time.

func newStillTunnel(t *testing.T) *MultiTrackKCPTunnel {
	t.Helper()
	obf, _ := tunnel.NewTunnelObfuscator(tunnel.DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/1212121212"))
	cam := NewVP8DataTunnelWithQueue(nil, obf, func(string, ...any) {}, KCPCarrierQueueDepth)
	k := NewMultiTrackKCPTunnel(NewMultiTrackTunnel([]*VP8DataTunnel{cam}), nil)
	t.Cleanup(k.Stop)
	return k
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); !cond(); time.Sleep(time.Millisecond) {
		if time.Now().After(end) {
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func waitingCount(s *trackKCPSession) int {
	s.gate.mu.Lock()
	defer s.gate.mu.Unlock()
	return len(s.gate.waiting)
}

// openOne: room for one more message, then the gate is pumped.
func openOne(k *MultiTrackKCPTunnel, s *trackKCPSession) {
	k.currentWindow.Store(int32(s.waitSnd() + 1))
	s.pump()
}

func bulkFrame(conn uint32) []byte {
	return tunnel.EncodeFrame(conn, tunnel.MsgData, make([]byte, KCPReadBufSize))
}

// a new connection's first answer goes in before two downloads that waited longer; the downloads then by who sent less
func TestGateNewConnectionFirst(t *testing.T) {
	k := newStillTunnel(t)
	s := k.sessions[0]
	for s.waitSnd() < int(k.currentWindow.Load()) { // download 1 fills the window
		k.SendData(bulkFrame(1))
	}
	s.gate.book.charge(2, 10*KCPReadBufSize, time.Now()) // download 2 has sent more than download 1 lately

	order := make(chan uint32, 3)
	send := func(conn uint32, frame []byte, waiting int) {
		go func() {
			k.SendData(frame)
			order <- conn
		}()
		waitUntil(t, "the message to wait", func() bool { return waitingCount(s) == waiting })
	}
	send(2, bulkFrame(2), 1)
	send(1, bulkFrame(1), 2)
	send(3, tunnel.EncodeFrame(3, tunnel.MsgData, []byte("HTTP/1.1 200 OK")), 3)

	for _, want := range []uint32{3, 1, 2} {
		openOne(k, s)
		select {
		case got := <-order:
			if got != want {
				t.Fatalf("connection %d went in, want %d", got, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("nothing went in, want connection %d", want)
		}
	}
}

// control messages (connect, close) never wait for room
func TestGateControlNeverWaits(t *testing.T) {
	k := newStillTunnel(t)
	s := k.sessions[0]
	for s.waitSnd() < int(k.currentWindow.Load()) {
		k.SendData(bulkFrame(1))
	}
	done := make(chan struct{})
	go func() {
		k.SendData(tunnel.EncodeFrame(9, tunnel.MsgConnectOK, nil))
		k.SendData(tunnel.EncodeFrame(9, tunnel.MsgClose, nil))
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a control message waited for room")
	}
}

// a sender waiting for room is let go when the tunnel stops, or when its session goes
func TestGateLetsGoOnStop(t *testing.T) {
	k := newStillTunnel(t)
	s := k.sessions[0]
	for s.waitSnd() < int(k.currentWindow.Load()) {
		k.SendData(bulkFrame(1))
	}
	done := make(chan struct{})
	go func() {
		k.SendData(bulkFrame(1))
		close(done)
	}()
	waitUntil(t, "the message to wait", func() bool { return waitingCount(s) == 1 })
	k.Stop()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the sender stayed blocked after Stop")
	}

	k2 := newStillTunnel(t)
	share := NewVP8DataTunnelWithQueue(nil, nil, func(string, ...any) {}, KCPCarrierQueueDepth)
	k2.AddSession(share)
	s2 := k2.sessions[1]
	for s2.waitSnd() < int(k2.currentWindow.Load()) {
		k2.SendData(bulkFrame(1)) // connection 1 rides the second session
	}
	done2 := make(chan struct{})
	go func() {
		k2.SendData(bulkFrame(1))
		close(done2)
	}()
	waitUntil(t, "the message to wait", func() bool { return waitingCount(s2) == 1 })
	k2.RemoveLastSession()
	select {
	case <-done2:
	case <-time.After(5 * time.Second):
		t.Fatal("the sender stayed blocked after its session went")
	}
}

// a sender that read its connection's session just before the far side stopped hearing it (retire, from watchProbed)
// and asks for room just after: it is let go, its data not put into the deaf session, whether the session is full or
// has room
func TestGateRetireRaceLetsGo(t *testing.T) {
	for _, full := range []bool{true, false} {
		k := newStillTunnel(t)
		share := NewVP8DataTunnelWithQueue(nil, nil, func(string, ...any) {}, KCPCarrierQueueDepth)
		k.mt.AddSubTunnel(share)
		k.AddProbedSession(share, tunnel.EncodeFrame(tunnel.ControlConnID, tunnel.MsgConfigAck, nil))
		s1 := k.sessions[1]
		s1.heard.Store(true)
		k.mu.Lock()
		k.connPin[5] = 1
		k.mu.Unlock()
		body := bulkFrame(5)
		if full {
			for s1.trySendNow(body) {
			}
		}
		before := s1.waitSnd()

		// SendData's first step: the connection's session
		k.mu.Lock()
		session := k.sessions[k.connPin[5]]
		k.mu.Unlock()
		// watchProbed finds the session deaf
		s1.heard.Store(false)
		k.retire(1)
		// SendData's second step
		done := make(chan bool, 1)
		go func() { done <- session.admit(5, body, k.stopCh) }()
		select {
		case sent := <-done:
			if sent {
				t.Fatalf("full=%v: a retired connection's data went into the deaf session", full)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("full=%v: a sender that raced the retire still waits after 3 s (gate waiting=%v)", full, s1.gate.hasWaiting())
		}
		if after := s1.waitSnd(); after != before {
			t.Fatalf("full=%v: the deaf session holds %d segments more", full, after-before)
		}
	}
}
