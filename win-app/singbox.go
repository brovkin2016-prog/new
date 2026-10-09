package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/include"
	"github.com/sagernet/sing-box/option"
	sjson "github.com/sagernet/sing/common/json"
	"github.com/sagernet/sing/service"
)

// EngineOptions say what sing-box (inside this program) is to carry.
type EngineOptions struct {
	Profile   *Profile
	SocksPort int      // a bridge: the relay's SOCKS port on this computer
	ProbePort int      // a local HTTP/SOCKS port through the connection: checks, the speed test, the family server
	OnlyApps  []string // program files (telegram.exe…) that go through the VPN; empty: all of them
	Tun       bool     // false: no virtual interface — the connection is only being looked at
	Own       []string // this program's own files: always straight
	LogFile   string
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
	// then names are asked through the connection
	dns := map[string]any{
		"servers": []any{
			map[string]any{"tag": "remote", "type": "tls", "server": "8.8.8.8", "detour": "proxy"},
			map[string]any{"tag": "local", "type": "local"},
			map[string]any{"tag": "fake", "type": "fakeip", "inet4_range": "198.18.0.0/15", "inet6_range": "fc00::/18"},
		},
		"final":    "remote",
		"strategy": "prefer_ipv4",
	}
	if !only {
		dns["rules"] = []any{map[string]any{"query_type": []string{"A", "AAAA"}, "server": "fake"}}
	}
	// the local port goes through the connection first of all: this program's own checks come in by it, and must not be
	// taken for this program's own traffic (which goes straight)
	rules := []any{
		map[string]any{"action": "sniff"},
		map[string]any{"inbound": []string{"probe-in"}, "outbound": "proxy"},
		map[string]any{"process_name": o.Own, "outbound": "direct"},
		map[string]any{"protocol": "dns", "action": "hijack-dns"},
		map[string]any{"ip_is_private": true, "outbound": "direct"},
	}
	final := "proxy"
	if only {
		rules = append(rules, map[string]any{"process_name": o.OnlyApps, "outbound": "proxy"})
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
