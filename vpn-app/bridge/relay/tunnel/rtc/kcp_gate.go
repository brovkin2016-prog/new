package rtc

import (
	"math"
	"sync"
	"time"
)

// winger: browsing while a download runs. A connection's data used to go into KCP as soon as there was room for it,
// whoever asked first: every download's sender polled for room every 2 ms, and a new page's first answer waited its
// turn among them behind a window's worth of segments. Now the data that finds no room waits here, a message per
// connection, and when room opens (acks came, the window grew, a tick passed) the connection that put in least lately
// goes first: a new page before a long download, downloads among themselves by turns. Only the order between
// connections changes, each one's own messages keep theirs; control messages (connect, close) never wait here.
// Sender side only, nothing changes on the wire.

const (
	// how fast a connection's recent sending is forgotten when choosing whose data goes into KCP next
	kcpLoadHalfLife = time.Second
	kcpPruneEvery   = 1000 // update ticks between dropping the accounts of long-quiet connections
)

// gateItem: a connection's data message waiting for room; done closes once it is in KCP (sent) or never will be.
type gateItem struct {
	conn  uint32
	frame []byte
	done  chan struct{}
	sent  bool
}

// sessionGate: what waits for room in one session's KCP (lock order: gate.mu, then the tunnel's mu, book.mu or kcpMu).
type sessionGate struct {
	mu      sync.Mutex
	waiting []*gateItem
	closed  bool
	book    connBook
}

// connBook: what each connection put into KCP lately, in bytes halving every kcpLoadHalfLife.
type connBook struct {
	mu    sync.Mutex
	conns map[uint32]*connLoad
}

type connLoad struct {
	bytes float64
	at    time.Time
}

func (b *connBook) load(conn uint32, now time.Time) float64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.loadLocked(conn, now)
}

func (b *connBook) loadLocked(conn uint32, now time.Time) float64 {
	l := b.conns[conn]
	if l == nil {
		return 0
	}
	return l.bytes * math.Exp2(-now.Sub(l.at).Seconds()/kcpLoadHalfLife.Seconds())
}

func (b *connBook) charge(conn uint32, n int, now time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.conns == nil {
		b.conns = make(map[uint32]*connLoad)
	}
	l := b.conns[conn]
	if l == nil {
		l = &connLoad{}
		b.conns[conn] = l
	}
	l.bytes = b.loadLocked(conn, now) + float64(n)
	l.at = now
}

// forget: a closed connection's account goes.
func (b *connBook) forget(conn uint32) {
	b.mu.Lock()
	delete(b.conns, conn)
	b.mu.Unlock()
}

// prune: the accounts of connections quiet long enough to weigh nothing go (one never closed would stay forever).
func (b *connBook) prune(now time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for conn := range b.conns {
		if b.loadLocked(conn, now) < 1 {
			delete(b.conns, conn)
		}
	}
}

// admit: puts conn's data frame into KCP once there is room and its turn has come; false if the session went (or
// the connection was closed with it) or the tunnel stopped first.
func (s *trackKCPSession) admit(conn uint32, frame []byte, stop <-chan struct{}) bool {
	g := &s.gate
	g.mu.Lock()
	// winger: whether the connection was closed with its session (retire) is asked here, under the gate's lock: retire
	// marks its connections before it lets go what waits for them (drop), so a sender that read its session before
	// retire is either let go by drop or sees the mark. Asked before (in SendData alone), a sender that came just after
	// drop waited on a deaf session for an answer that would not come, or put a closed connection's data into it.
	if g.closed || s.parent.retiredConn(conn) {
		g.mu.Unlock()
		return false
	}
	if len(g.waiting) == 0 && s.trySendNow(frame) {
		g.mu.Unlock()
		g.book.charge(conn, len(frame), time.Now())
		return true
	}
	it := &gateItem{conn: conn, frame: frame, done: make(chan struct{})}
	g.waiting = append(g.waiting, it)
	g.mu.Unlock()
	s.pump()
	s.parent.wake() // an idle update loop pumps the gate again on its quick ticks
	select {
	case <-it.done:
		return it.sent
	case <-stop:
		return false
	}
}

// trySendNow: the frame into KCP if there is room for it now.
func (s *trackKCPSession) trySendNow(frame []byte) bool {
	return s.trySend(frame, int(s.parent.currentWindow.Load()), s.parent.tuning.flightGate)
}

// pump: moves waiting data into KCP while there is room, least served connection first.
func (s *trackKCPSession) pump() {
	g := &s.gate
	g.mu.Lock()
	defer g.mu.Unlock()
	for len(g.waiting) > 0 && !g.closed {
		now := time.Now()
		i := g.nextLocked(now)
		it := g.waiting[i]
		if !s.trySendNow(it.frame) {
			return
		}
		g.waiting = append(g.waiting[:i], g.waiting[i+1:]...)
		g.book.charge(it.conn, len(it.frame), now)
		it.sent = true
		close(it.done)
	}
}

// nextLocked: the waiting message to go first: that of the connection which put in least lately; among equals the one
// waiting longest (so a connection's own messages keep their order).
func (g *sessionGate) nextLocked(now time.Time) int {
	best, bestLoad := 0, g.book.load(g.waiting[0].conn, now)
	for i, it := range g.waiting[1:] {
		if l := g.book.load(it.conn, now); l < bestLoad {
			best, bestLoad = i+1, l
		}
	}
	return best
}

// shut: the session is gone; what waits for it is let go unsent.
func (g *sessionGate) shut() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed = true
	for _, it := range g.waiting {
		close(it.done)
	}
	g.waiting = nil
}

// drop: these connections were closed with the session (retire); what of theirs waits is let go unsent.
func (g *sessionGate) drop(conns map[uint32]bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	kept := g.waiting[:0]
	for _, it := range g.waiting {
		if conns[it.conn] {
			close(it.done)
			continue
		}
		kept = append(kept, it)
	}
	for i := len(kept); i < len(g.waiting); i++ {
		g.waiting[i] = nil
	}
	g.waiting = kept
}

func (g *sessionGate) hasWaiting() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.waiting) > 0
}
