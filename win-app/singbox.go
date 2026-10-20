package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing-box/include"
	"github.com/sagernet/sing-box/option"
	tun "github.com/sagernet/sing-tun"
	"github.com/sagernet/sing/common/bufio"
	sjson "github.com/sagernet/sing/common/json"
	N "github.com/sagernet/sing/common/network"
	"github.com/sagernet/sing/service"
)

// EngineOptions say what sing-box (inside this program) is to carry.
type EngineOptions struct {
	Profile   *Profile
	SocksPort int      // a bridge: the relay's SOCKS port on this computer
	ProbePort int      // a local HTTP/SOCKS port through the connection: checks, the speed test, the family server
	OnlyApps  []string // program files (telegram.exe…) that go through the VPN; empty: all of them
	Straight  bool     // with chosen programs: their Russian sites (.ru, .рф, .su) go straight, as without the VPN
	Home      string   // the family server's name: always through the connection (it may be shut on the network)
	Tun       bool     // false: no virtual interface — the connection is only being looked at
	Own       []string // this program's own files: always straight
	LogFile   string
}

// procNames: programs by their file name, whatever the case of its letters. sing-box compares process_name exactly, and
// Windows keeps a file's own case («Telegram.exe») while the list keeps names in lower case — «telegram.exe» never
// matched, and Telegram went straight past the VPN. A path's last part, any case: «…\Telegram.exe» matches.
func procNames(names []string) []string {
	out := make([]string, 0, len(names))
	for _, n := range names {
		out = append(out, `(?i)(^|[\\/])`+regexp.QuoteMeta(n)+`$`)
	}
	return out
}

// Config is the sing-box configuration (the 1.14 format) for one connection.
func Config(o EngineOptions) map[string]any {
	p := o.Profile
	proxy := map[string]any{"tag": "proxy"}
	if p.Bridge {
		proxy["type"], proxy["server"], proxy["server_port"], proxy["version"] = "socks", "127.0.0.1", o.SocksPort, "5"
	} else {
		proxy["type"], proxy["server"], proxy["password"] = "hysteria2", p.Host, p.Auth
		if strings.ContainsAny(p.Ports, ",-") { // port hopping: 20000-30000 → "20000:30000"
			var ports []string
			for _, r := range strings.Split(p.Ports, ",") {
				if a, b, ok := strings.Cut(r, "-"); ok {
					ports = append(ports, a+":"+b)
				} else if r != "" {
					ports = append(ports, r+":"+r)
				}
			}
			proxy["server_ports"] = ports
		} else {
			port, _ := strconv.Atoi(p.Ports)
			proxy["server_port"] = port
		}
		name := p.SNI
		if name == "" {
			name = p.Host
		}
		proxy["tls"] = map[string]any{"enabled": true, "server_name": name, "insecure": p.Insecure}
		if p.Obfs == "salamander" {
			proxy["obfs"] = map[string]any{"type": "salamander", "password": p.ObfsPassword}
		}
	}
	var inbounds []any
	if o.Tun {
		inbounds = append(inbounds, map[string]any{"type": "tun", "tag": "tun-in", "interface_name": "Winger",
			"address": []string{"172.19.0.1/30", "fdfe:dcba:9876::1/126"}, "mtu": 9000,
			"auto_route": true, "strict_route": true, "stack": "mixed"})
	}
	inbounds = append(inbounds, map[string]any{"type": "mixed", "tag": "probe-in", "listen": "127.0.0.1", "listen_port": o.ProbePort})

	only := len(o.OnlyApps) > 0
	// names: for all programs the far side looks them up (a made-up address here, the name goes with the connection —
	// quick, and nothing the provider's DNS would spoil); with chosen programs only, the others need real addresses:
	// then names are asked through the connection (plain DNS to 1.1.1.1 over it, as on the phone)
	dns := map[string]any{
		"servers": []any{
			map[string]any{"tag": "remote", "type": "udp", "server": "1.1.1.1", "detour": "proxy"},
			map[string]any{"tag": "local", "type": "local"},
			map[string]any{"tag": "fake", "type": "fakeip", "inet4_range": "198.18.0.0/15", "inet6_range": "fc00::/18"},
		},
		"final": "remote",
		// IPv4 only: programs given an IPv6 address would go by it, and a server or a network without IPv6 breaks the
		// page instead of the program falling back
		"strategy": "ipv4_only",
	}
	if !only {
		dns["rules"] = []any{map[string]any{"query_type": []string{"A", "AAAA"}, "server": "fake"}}
	}
	// the local port goes through the connection first of all: this program's own checks come in by it, and must not be
	// taken for this program's own traffic (which goes straight)
	rules := []any{
		map[string]any{"action": "sniff"},
		map[string]any{"inbound": []string{"probe-in"}, "outbound": "proxy"},
		map[string]any{"process_path_regex": procNames(o.Own), "outbound": "direct"},
		map[string]any{"protocol": "dns", "action": "hijack-dns"},
		map[string]any{"ip_is_private": true, "outbound": "direct"},
	}
	final := "proxy"
	if only {
		if o.Home != "" {
			rules = append(rules, map[string]any{"domain": []string{o.Home}, "outbound": "proxy"})
		}
		if o.Straight { // banks, Gosuslugi and the like in a browser: as without the VPN (they dislike a foreign address)
			rules = append(rules, map[string]any{"domain_suffix": []string{".ru", ".xn--p1ai", ".su"}, "outbound": "direct"})
		}
		rules = append(rules, map[string]any{"process_path_regex": procNames(o.OnlyApps), "outbound": "proxy"})
		final = "direct"
	}
	if len(o.Own) == 0 {
		rules = append(rules[:2], rules[3:]...)
	}
	logOpts := map[string]any{"level": "warn", "timestamp": true}
	if o.LogFile != "" {
		logOpts["output"] = o.LogFile
	}
	return map[string]any{
		"log":       logOpts,
		"dns":       dns,
		"inbounds":  inbounds,
		"outbounds": []any{proxy, map[string]any{"type": "direct", "tag": "direct"}},
		"route": map[string]any{"rules": rules, "final": final, "auto_detect_interface": true,
			"default_domain_resolver": "local"},
	}
}

// Box is sing-box running inside this program.
type Box struct {
	mu       sync.Mutex
	instance *box.Box
	cancel   context.CancelFunc
	traffic  traffic
}

// traffic counts the bytes that go through the VPN (all its runs together), for the window's «↓ … ↑ …» line: as on the
// phone, only what the programs send through the tunnel — not what goes straight past it, nor Winger's own checks.
type traffic struct {
	up, down atomic.Int64
	mu       sync.Mutex
	at       time.Time
	lastUp   int64
	lastDown int64
	rateUp   float64
	rateDown float64
}

func counted(m adapter.InboundContext, o adapter.Outbound) bool {
	return o != nil && o.Tag() == "proxy" && m.Inbound != "probe-in"
}

func (t *traffic) RoutedConnection(_ context.Context, conn net.Conn, m adapter.InboundContext, _ adapter.Rule, o adapter.Outbound) net.Conn {
	if !counted(m, o) {
		return conn
	}
	return bufio.NewInt64CounterConn(conn, []*atomic.Int64{&t.up}, []*atomic.Int64{&t.down})
}

func (t *traffic) RoutedPacketConnection(_ context.Context, conn N.PacketConn, m adapter.InboundContext, _ adapter.Rule, o adapter.Outbound) N.PacketConn {
	if !counted(m, o) {
		return conn
	}
	return bufio.NewInt64CounterPacketConn(conn, []*atomic.Int64{&t.up}, nil, []*atomic.Int64{&t.down}, nil)
}

func (t *traffic) RoutedFlow(context.Context, adapter.InboundContext, adapter.Rule, adapter.Outbound) tun.FlowTracker {
	return nil
}

// Rates: bytes a second down and up, over the last second or more (asked more often, the last answer again).
func (b *Box) Rates() (down, up float64) {
	t := &b.traffic
	t.mu.Lock()
	defer t.mu.Unlock()
	now, u, d := time.Now(), t.up.Load(), t.down.Load()
	if sec := now.Sub(t.at).Seconds(); t.at.IsZero() || sec > 10 {
		t.rateUp, t.rateDown = 0, 0
	} else if sec >= 1 {
		t.rateUp, t.rateDown = float64(u-t.lastUp)/sec, float64(d-t.lastDown)/sec
	} else {
		return t.rateDown, t.rateUp
	}
	t.at, t.lastUp, t.lastDown = now, u, d
	return t.rateDown, t.rateUp
}

// Received: the bytes that came down through the VPN to the programs so far (all its runs together) — while they keep
// coming the connection carries, whatever one look at it says.
func (b *Box) Received() int64 {
	return b.traffic.down.Load()
}

var boxCtx = include.Context(context.Background())

// Check reads the configuration the way sing-box does, without starting anything.
func Check(cfg map[string]any) error {
	content, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	options, err := sjson.UnmarshalExtendedContext[option.Options](boxCtx, content)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(service.ExtendContext(boxCtx))
	defer cancel()
	instance, err := box.New(box.Options{Context: ctx, Options: options})
	if err != nil {
		return err
	}
	return instance.Close()
}

// Start runs sing-box with this configuration (the old one, if any, is closed first).
func (b *Box) Start(cfg map[string]any) error {
	b.Stop()
	content, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	options, err := sjson.UnmarshalExtendedContext[option.Options](boxCtx, content)
	if err != nil {
		return fmt.Errorf("настройки: %w", err)
	}
	ctx, cancel := context.WithCancel(service.ExtendContext(boxCtx))
	instance, err := box.New(box.Options{Context: ctx, Options: options})
	if err != nil {
		cancel()
		return err
	}
	instance.Router().AppendTracker(&b.traffic)
	if err := instance.Start(); err != nil {
		cancel()
		_ = instance.Close()
		return err
	}
	b.mu.Lock()
	b.instance, b.cancel = instance, cancel
	b.mu.Unlock()
	return nil
}

// Stop closes it (and the virtual interface with it).
func (b *Box) Stop() {
	b.mu.Lock()
	instance, cancel := b.instance, b.cancel
	b.instance, b.cancel = nil, nil
	b.mu.Unlock()
	if instance != nil {
		cancel()
		_ = instance.Close()
	}
}

// Running says whether sing-box is up.
func (b *Box) Running() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.instance != nil
}
