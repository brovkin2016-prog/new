package main

import (
	"regexp"
	"testing"
)

func TestConfigs(t *testing.T) {
	srv, _ := ParseLink("hysteria2://me:pw@1.2.3.4:443/?sni=vpn.sites-s.ru#s")
	hop, _ := ParseLink("hysteria2://me:pw@1.2.3.4:20000-30000,40000/?sni=vpn.sites-s.ru&obfs=salamander&obfs-password=x#h")
	br, _ := ParseLink("winger-bridge://telemost?link=https%3A%2F%2Ftelemost.yandex.ru%2Fj%2F12345678901234#b")
	own := []string{"winger.exe", "winger-relay.exe"}
	cases := map[string]EngineOptions{
		"server, all programs":    {Profile: srv, ProbePort: 47801, Own: own, Tun: true},
		"server, chosen programs": {Profile: srv, ProbePort: 47801, Own: own, Tun: true, OnlyApps: []string{"telegram.exe", "chrome.exe"}},
		"server, chosen, Russian sites straight": {Profile: srv, ProbePort: 47801, Own: own, Tun: true, OnlyApps: []string{"chrome.exe"},
			Straight: true, Home: "vpn.sites-s.ru"},
		"bridge, chosen programs": {Profile: br, SocksPort: 47802, ProbePort: 47801, Own: own, Tun: true, OnlyApps: []string{"telegram.exe"},
			Home: "vpn.sites-s.ru"},
		"port hopping and obfs":     {Profile: hop, ProbePort: 47801, Own: own, Tun: true},
		"bridge":                    {Profile: br, SocksPort: 47802, ProbePort: 47801, Own: own, Tun: true},
		"a look at the server only": {Profile: srv, ProbePort: 47803},
	}
	for name, o := range cases {
		if err := Check(Config(o)); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	// through the server, Russian sites in a chosen browser go straight (banks); the family server always through the
	// connection, before them; a bridge carries a chosen program's Russian sites too
	at := func(name string) (home, ru, proc int) {
		home, ru, proc = -1, -1, -1
		for i, r := range Config(cases[name])["route"].(map[string]any)["rules"].([]any) {
			m := r.(map[string]any)
			if d, ok := m["domain"].([]string); ok && d[0] == "vpn.sites-s.ru" && m["outbound"] == "proxy" {
				home = i
			}
			if d, ok := m["domain_suffix"].([]string); ok && d[0] == ".ru" && m["outbound"] == "direct" {
				ru = i
			}
			if p, ok := m["process_path_regex"].([]string); ok && len(p) == 1 && m["outbound"] == "proxy" {
				proc = i
			}
		}
		return
	}
	if h, r, p := at("server, chosen, Russian sites straight"); h < 0 || r < 0 || p < 0 || !(h < r && r < p) {
		t.Fatalf("server: home %d, Russian sites %d, programs %d", h, r, p)
	}
	if h, r, p := at("bridge, chosen programs"); h < 0 || r >= 0 || p < 0 {
		t.Fatalf("bridge: home %d, Russian sites %d (must be none), programs %d", h, r, p)
	}
	c := Config(cases["port hopping and obfs"])
	px := c["outbounds"].([]any)[0].(map[string]any)
	if ports := px["server_ports"].([]string); len(ports) != 2 || ports[0] != "20000:30000" || ports[1] != "40000:40000" || px["password"] != "me:pw" {
		t.Fatalf("%v", px)
	}
	// this program's own checks come in by the local port: through the connection, before «own traffic goes straight»
	rules := Config(cases["server, all programs"])["route"].(map[string]any)["rules"].([]any)
	probe, ownAt := -1, -1
	for i, r := range rules {
		m := r.(map[string]any)
		if in, ok := m["inbound"].([]string); ok && in[0] == "probe-in" {
			probe = i
		}
		if _, ok := m["process_path_regex"]; ok && ownAt < 0 {
			ownAt = i
		}
	}
	if probe < 0 || ownAt < 0 || probe > ownAt {
		t.Fatalf("the local port's rule must come before this program's own: %d, %d", probe, ownAt)
	}
	if Config(cases["server, chosen programs"])["route"].(map[string]any)["final"] != "direct" ||
		Config(cases["server, all programs"])["route"].(map[string]any)["final"] != "proxy" {
		t.Fatal("final")
	}
	// programs get IPv4 addresses only: an IPv6 one breaks the page where the server or the network has no IPv6
	for name, o := range cases {
		if Config(o)["dns"].(map[string]any)["strategy"] != "ipv4_only" {
			t.Errorf("%s: names must be IPv4 only", name)
		}
	}
}

// a program chosen in lower case («telegram.exe») is matched whatever case Windows keeps its file in, and by its whole name
func TestProcNamesAnyCase(t *testing.T) {
	re := regexp.MustCompile(procNames([]string{"telegram.exe"})[0])
	for path, want := range map[string]bool{
		`C:\Users\a\AppData\Roaming\Telegram Desktop\Telegram.exe`: true,
		`C:\Program Files\TELEGRAM.EXE`:                            true,
		`telegram.exe`:                                             true,
		`C:\x\notTelegram.exe`:                                     false,
		`C:\x\Telegram.exe.bak`:                                    false,
	} {
		if re.MatchString(path) != want {
			t.Errorf("%s: want %v", path, want)
		}
	}
}
