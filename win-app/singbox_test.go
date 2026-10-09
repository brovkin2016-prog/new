package main

import "testing"

func TestConfigs(t *testing.T) {
	srv, _ := ParseLink("hysteria2://me:pw@1.2.3.4:443/?sni=vpn.sites-s.ru#s")
	hop, _ := ParseLink("hysteria2://me:pw@1.2.3.4:20000-30000,40000/?sni=vpn.sites-s.ru&obfs=salamander&obfs-password=x#h")
	br, _ := ParseLink("winger-bridge://telemost?link=https%3A%2F%2Ftelemost.yandex.ru%2Fj%2F12345678901234#b")
	own := []string{"winger.exe", "winger-relay.exe"}
	cases := map[string]EngineOptions{
		"server, all programs":      {Profile: srv, ProbePort: 47801, Own: own, Tun: true},
		"server, chosen programs":   {Profile: srv, ProbePort: 47801, Own: own, Tun: true, OnlyApps: []string{"telegram.exe", "chrome.exe"}},
		"port hopping and obfs":     {Profile: hop, ProbePort: 47801, Own: own, Tun: true},
		"bridge":                    {Profile: br, SocksPort: 47802, ProbePort: 47801, Own: own, Tun: true},
		"a look at the server only": {Profile: srv, ProbePort: 47803},
	}
	for name, o := range cases {
		if err := Check(Config(o)); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	c := Config(cases["port hopping and obfs"])
	px := c["outbounds"].([]any)[0].(map[string]any)
	if ports := px["server_ports"].([]string); len(ports) != 2 || ports[0] != "20000:30000" || ports[1] != "40000:40000" || px["password"] != "me:pw" {
		t.Fatalf("%v", px)
	}
	if Config(cases["server, chosen programs"])["route"].(map[string]any)["final"] != "direct" ||
		Config(cases["server, all programs"])["route"].(map[string]any)["final"] != "proxy" {
		t.Fatal("final")
	}
}
