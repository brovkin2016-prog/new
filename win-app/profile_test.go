package main

import (
	"strings"
	"testing"
)

func TestServerLink(t *testing.T) {
	p, err := ParseLink("hysteria2://me:pw+x%2F1@1.2.3.4:443/?sni=vpn.sites-s.ru&obfs=salamander&obfs-password=a+b#%D0%A1%D0%B5%D1%80%D0%B2%D0%B5%D1%80")
	if err != nil || p.Bridge || p.Host != "1.2.3.4" || p.Ports != "443" || p.Auth != "me:pw+x/1" || p.SNI != "vpn.sites-s.ru" ||
		p.Obfs != "salamander" || p.ObfsPassword != "a+b" || p.Name != "Сервер" || p.UpdateHost() != "vpn.sites-s.ru" {
		t.Fatalf("%+v %v", p, err)
	}
	h, _ := ParseLink("hysteria2://me:pw@1.2.3.4:20000-30000/?sni=vpn.sites-s.ru#hop")
	if h.Ports != "20000-30000" || !h.Same(&Profile{Host: "1.2.3.4", Ports: "20000-30000", Auth: "me:other"}) || h.Same(p) {
		t.Fatalf("hop %+v", h)
	}
	for _, bad := range []string{"vless://x@1.2.3.4:443", "hysteria2://me:pw@:443", "hysteria2://me:pw@h:abc", ""} {
		if _, err := ParseLink(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	if FindLink("Ваш VPN:\nhysteria2://a:b@1.2.3.4:443/?sni=x.ru#n\nИмпорт…") != "hysteria2://a:b@1.2.3.4:443/?sni=x.ru#n" {
		t.Fatal("link not found in a message")
	}
}

func TestBridgeLinks(t *testing.T) {
	tm, err := ParseLink("winger-bridge://telemost?link=https%3A%2F%2Ftelemost.yandex.ru%2Fj%2F12345678901234&fps=24&batch=45&reliable=1&dual=0#%D0%9C%D0%BE%D1%81%D1%82")
	if err != nil || !tm.Bridge || tm.Platform != "telemost" || tm.JoinLink != "https://telemost.yandex.ru/j/12345678901234" ||
		tm.Batch != 45 || tm.TunnelMode != "" || tm.RelayMode() != "telemost-headless-joiner" || tm.Name != "Мост" {
		t.Fatalf("%+v %v", tm, err)
	}
	if j := tm.JoinParams("dc"); j["joinLink"] != tm.JoinLink || j["vp8Batch"] != 45 || j["tunnelMode"] != nil {
		t.Fatalf("join %v", j)
	}
	wb, _ := ParseLink("winger-bridge://wbstream?room=wbstream%3A%2F%2F0123456789abcdef&mode=dc#WB")
	if wb.TunnelMode != "dc" || wb.Batch != 30 || wb.JoinParams("video")["roomId"] != "wbstream://0123456789abcdef" ||
		wb.JoinParams("video")["tunnelMode"] != "video" {
		t.Fatalf("wb %+v", wb)
	}
	dn, _ := ParseLink("winger-bridge://dion?room=dion%3A%2F%2Fslug5678#D")
	if j := dn.JoinParams(""); j["roomId"] != "dion://slug5678" || j["vp8Fps"] != nil {
		t.Fatalf("dion %v", j)
	}
	if _, err := ParseLink("winger-bridge://telemost?link=https%3A%2F%2Fevil.example%2Fj%2F123456"); err == nil {
		t.Fatal("a call that is not Telemost's was taken")
	}
	if !tm.Same(&Profile{Bridge: true, Platform: "telemost"}) || tm.Same(wb) {
		t.Fatal("one bridge per service")
	}
	if !strings.HasPrefix(wb.Service(), "WB") {
		t.Fatal(wb.Service())
	}
}
