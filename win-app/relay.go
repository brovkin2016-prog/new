package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
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
	lost      bool
}

// StartRelay runs the relay for this bridge; tunnel: "dc" or "video" for WB Stream and Bitrix24.
func StartRelay(path string, p *Profile, tunnel string, socksPort int, home string, onLost func()) (*Relay, error) {
	join, _ := json.Marshal(p.JoinParams(tunnel))
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
	go r.read(stdout, stdin, string(join), onLost)
	go func() {
		_ = cmd.Wait()
		close(r.ended)
	}()
	return r, nil
}

func (r *Relay) read(out io.Reader, in io.Writer, join string, onLost func()) {
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	once := sync.Once{}
	for sc.Scan() {
		line := sc.Text()
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
				_, _ = io.WriteString(in, "JOIN:"+join+"\n")
			case st == "TUNNEL_CONNECTED":
				once.Do(func() { close(r.connected) })
			case st == "TUNNEL_LOST" || st == "RECONNECTING":
				if onLost != nil {
					onLost()
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

// Wait: in the call (nil), or why not.
func (r *Relay) Wait(timeout time.Duration) error {
	select {
	case <-r.connected:
		return nil
	case <-r.ended:
		if e := r.Err(); e != "" {
			return errors.New(e)
		}
		return errors.New("Мост не поднялся.")
	case <-time.After(timeout):
		if e := r.Err(); e != "" {
			return errors.New(e)
		}
		return errors.New("Мост не поднялся: звонок не отвечает.")
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
	if r != nil && r.cmd.Process != nil {
		_ = r.cmd.Process.Kill()
	}
}
