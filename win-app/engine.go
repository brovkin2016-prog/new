package main

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// Status is what the VPN is doing right now, for the window and the tray.
type Status struct {
	Phase  string `json:"phase"` // off, connecting, on, retrying
	Note   string `json:"note"`  // the reason when it is not working, in plain words
	Active string `json:"active"`
	Auto   bool   `json:"auto"` // in use because the chosen one did not answer
	PingMs int    `json:"ping"`
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

func (e *Engine) set(phase, note string) {
	e.mu.Lock()
	e.status.Phase, e.status.Note = phase, note
	if phase == "on" && e.status.Since == 0 {
		e.status.Since = time.Now().Unix()
	}
	if phase == "off" {
		e.status = Status{Phase: "off", Note: note}
	}
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
	e.wanted, e.preferred, e.profile, e.tunnel = true, p, p, p.TunnelMode
	e.status = Status{Phase: "connecting", Active: p.Link}
	e.backWait = backFirst
	e.mu.Unlock()
	e.st.Update(func(s *Settings) { s.KeepOn = true })
	e.stopParts()
	go e.run(g)
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
	e.set("off", "")
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
		e.set("connecting", "Поднимаю мост через "+p.Service()+"… до минуты")
	} else {
		e.set("connecting", "Подключаюсь к серверу…")
	}
	e.quickChoice(g)
	fails := 0
	for e.mine(g) {
		p, tunnel := e.cur()
		err := e.start(g, p, tunnel)
		if err == nil && e.mine(g) {
			fails = 0
			e.set("on", "")
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
			e.switchTo(back, false, "Выбранный сервер снова отвечает — переключаюсь на него…")
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
			e.tunnel = "video" // the data channel does not carry here: the call's video does, a little slower
			e.mu.Unlock()
			fails = 0
			Logf("bridge: the data channel does not carry, trying the video")
			continue
		}
		if fails >= 2 {
			if next := e.nextChoice(p); next != nil {
				what := "пробую «" + next.Name + "»"
				if next.Bridge {
					what = "включаю мост через " + next.Service()
				}
				e.switchTo(next, true, "«"+p.Name+"» не отвечает — "+what+"…")
				fails = 0
				continue
			}
		}
		e.set("retrying", fmt.Sprint(err)+" Пробую снова…")
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
		r, err := StartRelay(e.relayPath, p, tunnel, opts.SocksPort, e.dataDir, func() {
			if e.mine(g) && e.Status().Phase == "on" {
				e.set("retrying", "Мост переподключается к звонку…")
			}
		})
		if err != nil {
			return errors.New("Не получилось запустить мост на этом компьютере.")
		}
		e.mu.Lock()
		e.relay = r
		e.mu.Unlock()
		if err := r.Wait(90 * time.Second); err != nil {
			return err
		}
		e.set("connecting", "Мост в звонке. Проверяю, что через него идут данные…")
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
			Logf("ping %d ms", ms)
			return nil
		}
	}
	if p.Bridge {
		Logf("bridge: in the call, but nothing comes back through it")
		if e.fam != nil && e.fam.SyncBridges(0) > 0 { // the server gave a new call: tried at once
			for _, x := range e.st.Profiles() {
				if x.Bridge && x.Platform == p.Platform && x.Link != p.Link {
					e.mu.Lock()
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
		e.mu.Unlock()
		if ms == 0 {
			failed++
			Logf("ping failed")
			if failed >= 2 {
				return errors.New("Связь с сервером пропала.")
			}
			continue
		}
		failed = 0
		if auto && time.Now().After(back) {
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
	e.switchTo(at, true, "«"+p.Name+"» не отвечает в этой сети — "+what+"…")
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
	if e.preferred != nil && e.preferred.Link == p.Link {
		e.preferred = fresh
	}
	e.mu.Unlock()
	e.switchTo(fresh, false, "Сервер переехал на новый адрес — подключаюсь по новому…")
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

func (e *Engine) switchTo(next *Profile, byItself bool, why string) {
	e.stopParts()
	e.mu.Lock()
	e.profile, e.tunnel = next, next.TunnelMode
	e.status.Active = next.Link
	e.status.Auto = byItself && e.preferred != nil && next.Link != e.preferred.Link
	e.status.Since = 0
	e.backAt = time.Now().Add(e.backWait)
	e.status.Phase, e.status.Note = "connecting", why
	e.mu.Unlock()
	Logf("auto: %s", why)
}

// SpeedOf: Mbit/s through a connection — the one that is on, or a short-lived one to a server that is not.
func (e *Engine) SpeedOf(p *Profile) (float64, error) {
	st := e.Status()
	if st.Phase == "on" && st.Active == p.Link {
		return Speed(e.probePort), nil
	}
	if p.Bridge {
		return 0, errors.New("Мост меряется, когда он включён.")
	}
	var b Box
	port := FreePort()
	if err := b.Start(Config(EngineOptions{Profile: p, ProbePort: port})); err != nil {
		return 0, err
	}
	defer b.Stop()
	if Ping(port, 8*time.Second) == 0 {
		return 0, errors.New("Сервер не отвечает.")
	}
	return Speed(port), nil
}

// Shutdown: off because the service stops (the computer shuts down, an update): «on after a restart» stays.
func (e *Engine) Shutdown() {
	e.mu.Lock()
	e.gen++
	e.wanted = false
	e.mu.Unlock()
	e.stopParts()
	e.set("off", "")
}
