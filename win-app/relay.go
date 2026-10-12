package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Relay is the bridge's program (the whitelist-bypass relay, built from vpn-app/bridge): it joins the call the family
// server keeps open and carries the traffic through it, offering a SOCKS port here. It asks this program for names
// (RESOLVE:host) and takes the call's settings once it is ready (JOIN:{…}).
type Relay struct {
	cmd       *exec.Cmd
	connected chan struct{}
	ended     chan struct{}
	mu        sync.Mutex
	err       string
	captchaAt time.Time // when VK last asked for a person
}

// StartRelay runs the relay for this bridge; tunnel: "dc" or "video" for WB Stream and Bitrix24. onLink: the call lost
// for a while (false) or back (true).
func StartRelay(path string, p *Profile, tunnel string, socksPort int, home string, onLink func(up bool)) (*Relay, error) {
	params, _ := json.Marshal(p.JoinParams(tunnel))
	join := p.JoinVerb() + string(params)
	cmd := exec.Command(path, "--mode", p.RelayMode(), "--ws-port", itoa(FreePort()),
		"--socks-host", "127.0.0.1", "--socks-port", itoa(socksPort))
	cmd.Env = append(os.Environ(), "HOME="+home, "USERPROFILE="+home)
	hideWindow(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	r := &Relay{cmd: cmd, connected: make(chan struct{}), ended: make(chan struct{})}
	ownChild(cmd.Process)
	go r.read(stdout, stdin, join, onLink)
	go func() {
		_ = cmd.Wait()
		setCaptcha(r, "")
		close(r.ended)
	}()
	return r, nil
}

// socksChatter: a line per connection of every program — counted, not written, so the journal keeps what matters
var socksChatter = regexp.MustCompile(`relay: SOCKS (CONNECT|CONNECTED|UDP|\d+ )`)
var socksFailed = regexp.MustCompile(`relay: SOCKS CONNECT \d+ (failed|TIMEOUT)`)

func (r *Relay) read(out io.Reader, in io.Writer, join string, onLink func(up bool)) {
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	once, inCall := sync.Once{}, false
	conns, failed, since := 0, 0, time.Now()
	tell := func() {
		if conns > 0 {
			Logf("bridge: %d connections through it, %d did not open (%d min)", conns, failed, max(1, int(time.Since(since).Minutes()+0.5)))
		}
		conns, failed, since = 0, 0, time.Now()
	}
	defer tell()
	for sc.Scan() {
		line := sc.Text()
		if socksChatter.MatchString(line) {
			if strings.Contains(line, "SOCKS CONNECT ") && strings.Contains(line, " -> ") {
				conns++
			}
			if socksFailed.MatchString(line) {
				failed++
			}
			if time.Since(since) >= 5*time.Minute {
				tell()
			}
			continue
		}
		switch {
		case strings.HasPrefix(line, "RESOLVE:"):
			name := strings.TrimSpace(line[8:])
			ip, err := Resolve(name)
			if err != nil {
				r.setErr("Нет интернета: не найден «" + name + "».")
			}
			Logf("bridge: resolve %s -> %s", name, ip)
			_, _ = io.WriteString(in, ip+"\n")
		case strings.HasPrefix(line, "STATUS:"):
			st := strings.TrimSpace(line[7:])
			Logf("bridge: %s", st)
			switch {
			case st == "READY":
				_, _ = io.WriteString(in, join+"\n")
			case strings.HasPrefix(st, "CAPTCHA:"):
				// VK wants a person first: the check is a page of the relay's own here; the window and the icon open it
				if u := strings.TrimSpace(st[8:]); captchaPage.MatchString(u) {
					r.mu.Lock()
					r.captchaAt = time.Now()
					r.mu.Unlock()
					setCaptcha(r, u)
				}
			case st == "TUNNEL_CONNECTED":
				setCaptcha(r, "")
				r.mu.Lock()
				r.captchaAt = time.Time{}
				r.mu.Unlock()
				once.Do(func() { close(r.connected) })
				if inCall && onLink != nil {
					onLink(true)
				}
				inCall = true
			case st == "TUNNEL_LOST" || st == "RECONNECTING":
				if onLink != nil {
					onLink(false)
				}
			case strings.HasPrefix(st, "ERROR:"):
				if strings.Contains(strings.ToLower(st), "not found") || strings.Contains(st, "404") {
					r.setErr("Звонок моста не найден: попросите на сервере новую ссылку моста.")
				} else {
					r.setErr("Мост не подключился к звонку.")
				}
				r.Stop()
			}
		default:
			Logf("relay: %s", line)
		}
	}
}

var (
	captchaPage = regexp.MustCompile(`^http://127\.0\.0\.1:[0-9]{2,5}/$`)
	captchaMu   sync.Mutex
	captchaURL  string
	captchaBy   *Relay
)

// setCaptcha: VK's «I am not a robot» page of this bridge program, waiting for the person ("": none any more — only
// its own page is taken away, not one a newer bridge program shows).
func setCaptcha(r *Relay, u string) {
	captchaMu.Lock()
	defer captchaMu.Unlock()
	if u == "" {
		if captchaBy == r {
			captchaURL, captchaBy = "", nil
		}
		return
	}
	if u != captchaURL {
		Logf("bridge: VK asks to confirm a person (captcha) — the window shows it")
	}
	captchaURL, captchaBy = u, r
}

// Captcha is the page waiting for the person, or "".
func Captcha() string {
	captchaMu.Lock()
	defer captchaMu.Unlock()
	return captchaURL
}

func (r *Relay) setErr(s string) {
	r.mu.Lock()
	r.err = s
	r.mu.Unlock()
}

// Err is why it did not come up, in plain words ("" when nothing is known).
func (r *Relay) Err() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.err
}

// captchaTime: how long the person has for VK's check once it is shown.
const captchaTime = 5 * time.Minute

// Wait: in the call (nil), or why not. While VK's check waits for the person, the wait is longer.
func (r *Relay) Wait(timeout time.Duration) error {
	end := time.Now().Add(timeout)
	for {
		r.mu.Lock()
		if t := r.captchaAt.Add(captchaTime); !r.captchaAt.IsZero() && t.After(end) {
			end = t
		}
		r.mu.Unlock()
		left := time.Until(end)
		if left <= 0 {
			if e := r.Err(); e != "" {
				return errors.New(e)
			}
			r.mu.Lock()
			asked := !r.captchaAt.IsZero()
			r.mu.Unlock()
			if asked {
				return errors.New("VK ждал проверку «я не робот», её не прошли — пробую снова.")
			}
			return errors.New("Мост не поднялся: звонок не отвечает.")
		}
		select {
		case <-r.connected:
			return nil
		case <-r.ended:
			if e := r.Err(); e != "" {
				return errors.New(e)
			}
			return errors.New("Мост не поднялся.")
		case <-time.After(min(left, time.Second)):
		}
	}
}

// Alive: the relay still runs.
func (r *Relay) Alive() bool {
	select {
	case <-r.ended:
		return false
	default:
		return true
	}
}

// Stop ends it.
func (r *Relay) Stop() {
	if r == nil {
		return
	}
	setCaptcha(r, "")
	if r.cmd.Process != nil {
		_ = r.cmd.Process.Kill()
	}
}
