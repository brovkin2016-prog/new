package main

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Status is what the VPN is doing right now, for the window and the tray.
type Status struct {
	Phase  string `json:"phase"` // off, connecting, on, retrying
	Note   string `json:"note"`  // the reason when it is not working, in plain words
	Active string `json:"active"`
	Auto   bool   `json:"auto"` // in use because the chosen one did not answer
	PingMs int    `json:"ping"` // -1: being checked, 0: no answer
	Since  int64  `json:"since"`
}

var errBack = errors.New("back")

const (
	backFirst = 10 * time.Minute
	backMax   = 2 * time.Hour
)

// Engine connects and keeps the connection: the server, or a bridge when the server does not answer.
type Engine struct {
	st        *Store
	fam       *Family
	dataDir   string
	relayPath string
	own       []string
	tun       bool

	mu        sync.Mutex
	status    Status
	gen       int
	wanted    bool
	preferred *Profile
	profile   *Profile
	tunnel    string
	backWait  time.Duration
	backAt    time.Time
	box       Box
	relay     *Relay
	probePort int
	runDone   chan struct{} // closed when the latest run has ended
	pinging   atomic.Bool   // PingAll at work
	pingedAll atomic.Int64  // when it last finished (unix seconds)
}

func NewEngine(st *Store, dataDir, relayPath string, own []string, tun bool) *Engine {
	return &Engine{st: st, dataDir: dataDir, relayPath: relayPath, own: own, tun: tun, status: Status{Phase: "off"},
		probePort: FreePort(), backWait: backFirst}
}

// Status is a copy of the current state.
func (e *Engine) Status() Status {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.status
}

// ProbePort: the connection's local port while it is on (0 when off) — the family server is asked through it.
func (e *Engine) ProbePort() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.status.Phase == "on" {
		return e.probePort
	}
	return 0
}

// set: what this run (g) is doing now — a run already replaced (off, another connection) changes nothing.
func (e *Engine) set(g int, phase, note string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.gen != g || !e.wanted {
		return
	}
	e.status.Phase, e.status.Note = phase, note
	if phase == "on" && e.status.Since == 0 {
		e.status.Since = time.Now().Unix()
	}
}

// off: the status once switched off.
func (e *Engine) off() {
	e.mu.Lock()
	e.status = Status{Phase: "off"}
	e.mu.Unlock()
}

func (e *Engine) mine(g int) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.wanted && e.gen == g
}

func (e *Engine) cur() (*Profile, string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.profile, e.tunnel
}

// Connect switches the VPN on with the chosen connection (or this one: Use).
func (e *Engine) Connect() error {
	p := e.st.Chosen()
	if p == nil {
		return errors.New("Сначала добавьте подключение: вставьте ссылку.")
	}
	e.mu.Lock()
	e.gen++
	g := e.gen
	since := int64(0)
	if e.wanted { // over from another connection: «Включено N мин» goes on, as on the phone (only off starts it again)
		since = e.status.Since
	}
	e.wanted, e.preferred, e.profile, e.tunnel = true, p, p, p.TunnelMode
	e.status = Status{Phase: "connecting", Active: p.Link, PingMs: -1, Since: since}
	e.backWait = backFirst
	prev, done := e.runDone, make(chan struct{})
	e.runDone = done
	e.mu.Unlock()
	e.st.Update(func(s *Settings) { s.KeepOn = true })
	e.stopParts()
	go func() {
		defer close(done)
		if prev != nil { // the run before has ended first: its last clean-up never stops this one's connection
			<-prev
		}
		e.run(g)
	}()
	return nil
}

// Disconnect switches it off.
func (e *Engine) Disconnect() {
	e.mu.Lock()
	e.gen++
	e.wanted = false
	e.mu.Unlock()
	e.st.Update(func(s *Settings) { s.KeepOn = false })
	e.stopParts()
	e.off()
	Logf("stopped")
}

// Restart: on again with what is chosen now (another connection, other programs).
func (e *Engine) Restart() {
	e.mu.Lock()
	on := e.wanted
	e.mu.Unlock()
	if on {
		_ = e.Connect()
	}
}

func (e *Engine) stopParts() {
	e.mu.Lock()
	r := e.relay
	e.relay = nil
	e.mu.Unlock()
	e.box.Stop()
	r.Stop()
}

func (e *Engine) sleep(g int, d time.Duration) bool {
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		if !e.mine(g) {
			return false
		}
		time.Sleep(200 * time.Millisecond)
	}
	return e.mine(g)
}

func (e *Engine) run(g int) {
	p, _ := e.cur()
	if p.Bridge {
		e.set(g, "connecting", "Поднимаю мост через "+p.Service()+"… до минуты")
	} else {
		e.set(g, "connecting", "Подключаюсь к серверу…")
	}
	e.quickChoice(g)
	fails := 0
	for e.mine(g) {
		p, tunnel := e.cur()
		err := e.start(g, p, tunnel)
		if err == nil && e.mine(g) {
			fails = 0
			e.set(g, "on", "")
			Logf("connected via %s%s", p.Host+p.Platform, map[bool]string{true: " (" + tunnel + ")"}[p.Bridge])
			err = e.watch(g)
		}
		e.stopParts()
		if !e.mine(g) {
			return
		}
		if errors.Is(err, errBack) {
			e.mu.Lock()
			back := e.preferred
			e.mu.Unlock()
			e.switchTo(g, back, false, "Выбранный сервер снова отвечает — переключаюсь на него…")
			continue
		}
		fails++
		Logf("retry %d: %v", fails, err)
		if !p.Bridge && fails == 1 && e.moved(g, p) {
			fails = 0
			continue
		}
		if p.Bridge && tunnel == "dc" && fails >= 2 && p.TunnelMode != "" {
			e.mu.Lock()
			if e.gen == g {
				e.tunnel = "video" // the data channel does not carry here: the call's video does, a little slower
			}
			e.mu.Unlock()
			fails = 0
			if p.Platform == "dion" {
				Logf("bridge: DION does not carry at the higher speed, back to its usual one")
			} else {
				Logf("bridge: the data channel does not carry, trying the video")
			}
			continue
		}
		if fails >= 2 {
			if next := e.nextChoice(p); next != nil {
				what := "пробую «" + next.Name + "»"
				if next.Bridge {
					what = "включаю мост через " + next.Service()
				}
				e.switchTo(g, next, true, "«"+p.Name+"» не отвечает — "+what+"…")
				fails = 0
				continue
			}
		}
		e.set(g, "retrying", fmt.Sprint(err)+" Пробую снова…")
		if !e.sleep(g, min(30*time.Second, time.Second<<min(fails, 5))) {
			return
		}
	}
}

// start brings one connection up and checks a page really comes through it.
func (e *Engine) start(g int, p *Profile, tunnel string) error {
	s := e.st.Get()
	opts := EngineOptions{Profile: p, ProbePort: e.probePort, Tun: e.tun, Own: e.own}
	if s.OnlyApps && len(s.Apps) > 0 {
		opts.OnlyApps = s.Apps
	}
	if p.Bridge {
		opts.SocksPort = FreePort()
		var me *Relay
		r, err := StartRelay(e.relayPath, p, tunnel, opts.SocksPort, e.dataDir, func(up bool) { e.bridgeLink(g, &me, up) })
		if err != nil {
			return errors.New("Не получилось запустить мост на этом компьютере.")
		}
		e.mu.Lock()
		stale := e.gen != g || !e.wanted
		if !stale {
			e.relay, me = r, r
		}
		e.mu.Unlock()
		if stale { // switched off or over while it started: it is not left running
			r.Stop()
			return nil
		}
		if err := r.Wait(90 * time.Second); err != nil {
			return err
		}
		e.set(g, "connecting", "Мост в звонке. Проверяю, что через него идут данные…")
	}
	if !e.mine(g) {
		return nil
	}
	if err := e.box.Start(Config(opts)); err != nil {
		Logf("start: %v", err)
		return errors.New("Не получилось включить VPN на этом компьютере.")
	}
	for i := 0; i < 4 && e.mine(g); i++ {
		if ms := Ping(e.probePort, 10*time.Second); ms > 0 {
			e.mu.Lock()
			e.status.PingMs = ms
			e.mu.Unlock()
			e.st.SetPing(p.Link, ms)
			Logf("ping %d ms", ms)
			return nil
		}
	}
	if p.Bridge {
		Logf("bridge: in the call, but nothing comes back through it")
		if e.fam != nil && e.fam.SyncBridges(0) > 0 { // the server gave a new call: tried at once
			for _, x := range e.st.Profiles() {
				if x.Bridge && x.Platform == p.Platform && x.DualTrack == p.DualTrack && x.Link != p.Link {
					e.mu.Lock()
					if e.gen != g || !e.wanted {
						e.mu.Unlock()
						return errors.New("Мост выключен.")
					}
					if e.preferred != nil && e.preferred.Link == p.Link {
						e.preferred = x
					}
					e.profile = x
					e.status.Active = x.Link
					e.mu.Unlock()
					return errors.New("Мост на сервере сменил звонок — подключаюсь к новому.")
				}
			}
		}
		return errors.New("Звонок есть, но мост на сервере не отвечает.")
	}
	return errors.New("Сервер не отвечает.")
}

// watch keeps an eye on the connection: a page every 30 s; the chosen server looked at again when another one is used.
func (e *Engine) watch(g int) error {
	failed := 0
	for e.sleep(g, 30*time.Second) {
		e.mu.Lock()
		r, auto, back := e.relay, e.status.Auto, e.backAt
		e.mu.Unlock()
		if r != nil && !r.Alive() {
			return errors.New("Мост остановился.")
		}
		ms := Ping(e.probePort, 10*time.Second)
		e.mu.Lock()
		e.status.PingMs = ms
		p := e.profile
		e.mu.Unlock()
		if p != nil {
			e.st.SetPing(p.Link, ms)
		}
		if ms == 0 {
			failed++
			Logf("ping failed")
			if failed >= 2 {
				return errors.New("Связь с сервером пропала.")
			}
			continue
		}
		failed = 0
		e.mu.Lock()
		if e.gen == g && e.wanted && e.status.Phase == "retrying" { // the bridge got back into its call: pages come again
			e.status.Phase, e.status.Note = "on", ""
		}
		e.mu.Unlock()
		if auto && time.Now().After(back) && !e.st.Get().Manual { // the automatic choice switched off: stays where it is
			e.mu.Lock()
			pref := e.preferred
			e.mu.Unlock()
			if pref != nil && !pref.Bridge && e.probeServer(pref) {
				Logf("auto: «%s» answers again", pref.Name)
				return errBack
			}
			e.mu.Lock()
			e.backWait = min(backMax, e.backWait*2)
			e.backAt = time.Now().Add(e.backWait)
			e.mu.Unlock()
		}
	}
	return nil
}

const bridgeBack = "Мост переподключается к звонку…"

// bridgeLink: the bridge lost its call for a while (up false) or is back in it (up true) — said in the status.
func (e *Engine) bridgeLink(g int, me **Relay, up bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.gen != g || !e.wanted || *me == nil || e.relay != *me {
		return
	}
	switch {
	case !up && e.status.Phase == "on":
		e.status.Phase, e.status.Note = "retrying", bridgeBack
	case up && e.status.Phase == "retrying" && e.status.Note == bridgeBack:
		e.status.Phase, e.status.Note = "on", ""
		Logf("bridge: back in the call")
	}
}

// probeServer: a short-lived connection to this server, past the VPN — does a page come through it?
func (e *Engine) probeServer(p *Profile) bool {
	var b Box
	port := FreePort()
	if err := b.Start(Config(EngineOptions{Profile: p, ProbePort: port})); err != nil {
		return false
	}
	defer b.Stop()
	return Ping(port, 8*time.Second) > 0
}

// quickChoice: at the start, when a bridge is there to fall back on — a server whose address the provider shut answers
// nothing at all: each server is looked at once and the first one that answers, or else the bridge, is taken at once.
func (e *Engine) quickChoice(g int) {
	e.mu.Lock()
	p, pref := e.profile, e.preferred
	e.mu.Unlock()
	if p.Bridge || e.st.Get().Manual || pref == nil || pref.Link != p.Link {
		return
	}
	bridge := false
	for _, x := range e.st.Profiles() {
		bridge = bridge || x.Bridge
	}
	if !bridge {
		return
	}
	at := p
	for i := 0; i < 6 && !at.Bridge && e.mine(g) && !e.probeServer(at); i++ {
		if i == 0 && e.moved(g, at) {
			return
		}
		next := e.nextChoiceFrom(at)
		if next == nil || next.Link == pref.Link {
			return
		}
		at = next
	}
	if !e.mine(g) || at.Link == p.Link {
		return
	}
	what := "пробую «" + at.Name + "»"
	if at.Bridge {
		what = "включаю мост через " + at.Service()
	}
	e.switchTo(g, at, true, "«"+p.Name+"» не отвечает в этой сети — "+what+"…")
}

// moved: the family server may have moved to a new address (its name follows it) — the saved link is renewed from
// the server and, when the server answers there, used.
func (e *Engine) moved(g int, p *Profile) bool {
	if e.fam == nil {
		return false
	}
	fresh := e.fam.RenewNow(p)
	if fresh == nil || !e.mine(g) || !e.probeServer(fresh) {
		return false
	}
	e.mu.Lock()
	if e.gen == g && e.preferred != nil && e.preferred.Link == p.Link {
		e.preferred = fresh
	}
	e.mu.Unlock()
	e.switchTo(g, fresh, false, "Сервер переехал на новый адрес — подключаюсь по новому…")
	return true
}

func (e *Engine) nextChoice(from *Profile) *Profile {
	if e.st.Get().Manual {
		return nil
	}
	return e.nextChoiceFrom(from)
}

// nextChoiceFrom: the chosen one, other servers, then bridges — the one after this.
func (e *Engine) nextChoiceFrom(from *Profile) *Profile {
	e.mu.Lock()
	pref := e.preferred
	e.mu.Unlock()
	if pref == nil {
		return nil
	}
	order := []*Profile{pref}
	all := e.st.Profiles()
	for _, x := range all {
		if !x.Bridge && x.Link != pref.Link {
			order = append(order, x)
		}
	}
	for _, x := range all {
		if x.Bridge && x.Link != pref.Link {
			order = append(order, x)
		}
	}
	if len(order) < 2 {
		return nil
	}
	at := 0
	for i, x := range order {
		if x.Link == from.Link {
			at = i
		}
	}
	return order[(at+1)%len(order)]
}

func (e *Engine) switchTo(g int, next *Profile, byItself bool, why string) {
	if !e.mine(g) {
		return
	}
	e.stopParts()
	e.mu.Lock()
	if e.gen != g || !e.wanted {
		e.mu.Unlock()
		return
	}
	e.profile, e.tunnel = next, next.TunnelMode
	e.status.Active = next.Link
	e.status.Auto = byItself && e.preferred != nil && next.Link != e.preferred.Link
	e.status.PingMs = -1
	e.backAt = time.Now().Add(e.backWait)
	e.status.Phase, e.status.Note = "connecting", why
	e.mu.Unlock()
	Logf("auto: %s", why)
}

const bridgeSpeedOff = "Скорость моста проверяется, когда он включён: включите его кнопкой и проверьте снова"

// SpeedOf: how fast a connection is, as its row on the phone says it — «⚡ 23,4 Мбит/с · 45 мс», «⚡ не отвечает»,
// «⚡ ничего не скачалось» — measured through the one that is on, or a short-lived client of a server that is not (what
// is on is not touched); kept with its time for the row. A bridge is measured while it is on.
func (e *Engine) SpeedOf(p *Profile) (string, error) {
	st := e.Status()
	port := e.probePort
	if st.Phase != "on" || st.Active != p.Link {
		if p.Bridge {
			return "", errors.New(bridgeSpeedOff)
		}
		var b Box
		port = FreePort()
		err := b.Start(Config(EngineOptions{Profile: p, ProbePort: port}))
		if err == nil {
			defer b.Stop()
		}
		if err != nil || Ping(port, 8*time.Second) == 0 {
			Logf("speed «%s»: does not answer", p.Name)
			e.st.SetSpeed(p.Link, "⚡ не отвечает · "+time.Now().Format("15:04"))
			return "⚡ не отвечает", nil
		}
	}
	mbit, ms := Speed(port)
	line := "⚡ ничего не скачалось"
	if mbit > 0 {
		line = strings.Replace(fmt.Sprintf("⚡ %.1f Мбит/с · %d мс", mbit, ms), ".", ",", 1)
	}
	Logf("speed «%s»: %.2f Mbit/s, first byte %d ms", p.Name, mbit, ms)
	e.st.SetSpeed(p.Link, line+" · "+time.Now().Format("15:04"))
	return line, nil
}

// PingNow: the response time looked at again (a click on it in the window), while the VPN is on; back when it is known.
func (e *Engine) PingNow() {
	e.mu.Lock()
	g, on := e.gen, e.status.Phase == "on"
	e.mu.Unlock()
	if !on {
		return
	}
	ms := Ping(e.probePort, 10*time.Second)
	e.mu.Lock()
	p := e.profile
	if e.gen == g && e.wanted {
		e.status.PingMs = ms
	}
	e.mu.Unlock()
	if p != nil {
		e.st.SetPing(p.Link, ms)
	}
}

// PingAll: the response time of every server that is not in use now, as the phone does it when its screen opens (at
// most once a minute): each through a short-lived connection of its own, past the VPN, one after another in the
// background. A bridge keeps the one it had when it was last on (it would have to get into its call to be asked).
func (e *Engine) PingAll() {
	if time.Since(time.Unix(e.pingedAll.Load(), 0)) < time.Minute || !e.pinging.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer func() { e.pingedAll.Store(time.Now().Unix()); e.pinging.Store(false) }()
		for _, p := range e.st.Profiles() {
			st := e.Status()
			if p.Bridge || st.Phase == "on" && st.Active == p.Link {
				continue
			}
			best := 0
			var b Box
			port := FreePort()
			if b.Start(Config(EngineOptions{Profile: p, ProbePort: port})) == nil {
				for i := 0; i < 2; i++ {
					if ms := Ping(port, 6*time.Second); ms > 0 && (best == 0 || ms < best) {
						best = ms
					}
				}
				b.Stop()
			}
			e.st.SetPing(p.Link, best)
			Logf("ping «%s»: %d ms (a separate test connection)", p.Name, best)
		}
	}()
}

// Rates: bytes a second down and up through the VPN now.
func (e *Engine) Rates() (down, up float64) {
	return e.box.Rates()
}

// Other: the phone notification's one-tap switch — from a server to the first bridge, from a bridge back to the chosen
// server (else the first one); nil while the VPN is off or there is nothing to switch to.
func (e *Engine) Other() *Profile {
	e.mu.Lock()
	now, pref, on := e.profile, e.preferred, e.wanted
	e.mu.Unlock()
	if !on || now == nil {
		return nil
	}
	all := e.st.Profiles()
	for _, x := range all {
		if now.Bridge && pref != nil && !pref.Bridge && x.Link == pref.Link {
			return x
		}
	}
	for _, x := range all {
		if x.Bridge != now.Bridge {
			return x
		}
	}
	return nil
}

// Shutdown: off because the service stops (the computer shuts down, an update): «on after a restart» stays.
func (e *Engine) Shutdown() {
	e.mu.Lock()
	e.gen++
	e.wanted = false
	done := e.runDone
	e.mu.Unlock()
	e.stopParts()
	if done != nil { // the run ends first (a few seconds at most): nothing it starts is left behind
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
		e.stopParts()
	}
	e.off()
}
