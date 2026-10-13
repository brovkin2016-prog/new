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
	vk, err := ParseLink("winger-bridge://vk?link=https%3A%2F%2Fvk.com%2Fcall%2Fjoin%2Fabcdefghij0123456789&mode=dc#V")
	if err != nil || vk.RelayMode() != "vk-headless-joiner" || vk.JoinVerb() != "AUTH:" || vk.Service() != "VK" {
		t.Fatalf("vk %v %+v", err, vk)
	}
	if j := vk.JoinParams(vk.TunnelMode); j["joinLink"] != "https://vk.com/call/join/abcdefghij0123456789" || j["tunnelMode"] != "dc" {
		t.Fatalf("vk params %v", j)
	}
	if _, err := ParseLink("winger-bridge://vk?link=https%3A%2F%2Fevil.com%2Fcall%2Fjoin%2Fabcdefghij0123456789#V"); err == nil {
		t.Fatal("a VK bridge to another site must not be taken")
	}
	dn, _ := ParseLink("winger-bridge://dion?room=dion%3A%2F%2Fslug5678#D")
	if j := dn.JoinParams("video"); j["roomId"] != "dion://slug5678" || j["vp8Fps"] != nil {
		t.Fatalf("dion at its own speed %v", j)
	}
	// first twice DION's own 24 × 10 is asked of its server side
	if j := dn.JoinParams(dn.TunnelMode); dn.TunnelMode != "dc" || j["vp8Fps"] != 24 || j["vp8Batch"] != 20 {
		t.Fatalf("dion at the higher speed %s %v", dn.TunnelMode, j)
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

// the owner's two-track trial stays beside the usual Telemost bridge; a new call of the same kind replaces it
func TestBridgeSameKeepsTwoTrackTrialApart(t *testing.T) {
	one, err := ParseLink("winger-bridge://telemost?link=https%3A%2F%2Ftelemost.yandex.ru%2Fj%2F12345678901234&fps=24&batch=45&reliable=1&dual=0#a")
	if err != nil {
		t.Fatal(err)
	}
	two, err := ParseLink("winger-bridge://telemost?link=https%3A%2F%2Ftelemost.yandex.ru%2Fj%2F12345678901234&fps=24&batch=45&reliable=1&dual=1#b")
	if err != nil {
		t.Fatal(err)
	}
	next, err := ParseLink("winger-bridge://telemost?link=https%3A%2F%2Ftelemost.yandex.ru%2Fj%2F99999999999999&fps=24&batch=45&reliable=1&dual=0#c")
	if err != nil {
		t.Fatal(err)
	}
	if one.Same(two) || two.Same(one) {
		t.Fatal("the two-track trial replaced the usual bridge")
	}
	if !one.Same(next) {
		t.Fatal("a new call of the usual bridge did not replace the old one")
	}
}

func mustParse(t *testing.T, link string) *Profile {
	t.Helper()
	p, err := ParseLink(link)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// the server's bridges, as the phone keeps them: not chosen; the same call with other settings stays the person's;
// the two-track trial that Winger before 123 kept in place of the usual bridge gets its own name back
func TestKeepLikeThePhone(t *testing.T) {
	st := OpenStore(t.TempDir())
	const call = "link=https%3A%2F%2Ftelemost.yandex.ru%2Fj%2F12345678901234"
	usual := "winger-bridge://telemost?" + call + "&fps=24&batch=45&reliable=1&dual=0#" + "%D0%9C%D0%BE%D1%81%D1%82%20%C2%B7%20%D0%A2%D0%B5%D0%BB%D0%B5%D0%BC%D0%BE%D1%81%D1%82"
	dual := "winger-bridge://telemost?" + call + "&fps=24&batch=45&reliable=1&dual=1#" + "%D0%9C%D0%BE%D1%81%D1%82%20%C2%B7%20%D0%A2%D0%B5%D0%BB%D0%B5%D0%BC%D0%BE%D1%81%D1%82%20%C2%B7%202%20%D1%82%D1%80%D0%B5%D0%BA%D0%B0%20%28%D0%BF%D1%80%D0%BE%D0%B2%D0%B5%D1%80%D0%BA%D0%B0%29"
	st.Add(mustParse(t, "hysteria2://u:k@vpn.example.ru:443/?sni=vpn.example.ru#Дом"))
	// what Winger 121 left: the two-track link under the usual one's name
	st.Update(func(s *Settings) { s.Profiles = append(s.Profiles, Saved{Name: "Мост · Телемост", Link: dual}) })
	if !st.Keep(mustParse(t, usual)) || !st.Keep(mustParse(t, dual)) {
		t.Fatal("the usual bridge or the name were not put right")
	}
	all := st.Profiles()
	if len(all) != 3 || all[1].Name != "Мост · Телемост · 2 трека (проверка)" || !all[1].DualTrack || all[2].Name != "Мост · Телемост" || all[2].DualTrack {
		t.Fatalf("%+v %+v", all[1], all[2])
	}
	if st.Chosen().Bridge {
		t.Fatal("a bridge from the server was chosen")
	}
	if st.Keep(mustParse(t, usual)) || st.Keep(mustParse(t, dual)) {
		t.Fatal("the same links changed something")
	}
	// the person's own way on the same call stays
	if st.Keep(mustParse(t, "winger-bridge://telemost?"+call+"&fps=20&batch=30&reliable=1&dual=0#x")) {
		t.Fatal("the same call with other settings replaced the person's own")
	}
	// a new call replaces the old one, with the server's name
	if !st.Keep(mustParse(t, "winger-bridge://telemost?link=https%3A%2F%2Ftelemost.yandex.ru%2Fj%2F99999999999999&dual=0#new")) || st.Profiles()[2].Name != "new" {
		t.Fatal("a new call did not replace the old one")
	}
}

// a pasted link is chosen; removing one keeps the one in use chosen, removing the chosen one chooses the first
func TestAddRemoveLikeThePhone(t *testing.T) {
	st := OpenStore(t.TempDir())
	st.Add(mustParse(t, "hysteria2://a:1@one.example.ru:443/#Один"))
	st.Add(mustParse(t, "hysteria2://b:2@two.example.ru:443/#Два"))
	st.Add(mustParse(t, "winger-bridge://vk?link=https%3A%2F%2Fvk.com%2Fcall%2Fjoin%2Fabcdefghijkl#Мост"))
	if st.Get().Current != 2 || !st.Chosen().Bridge {
		t.Fatal("a pasted bridge was not chosen")
	}
	st.Add(mustParse(t, "hysteria2://a:9@one.example.ru:443/#Новый"))
	if all := st.Profiles(); len(all) != 3 || all[0].Name != "Новый" || st.Get().Current != 0 {
		t.Fatalf("the same server and person: replaced with its new name and chosen (%d)", st.Get().Current)
	}
	st.Update(func(s *Settings) { s.Current = 2 })
	st.SetSpeed(st.Profiles()[1].Link, "⚡ 1,0 Мбит/с · 5 мс · 10:00")
	st.Remove(1)
	if st.Get().Current != 1 || !st.Chosen().Bridge || len(st.Get().Speeds) != 0 {
		t.Fatal("the one in use did not stay chosen, or the removed one's speed stayed")
	}
	st.Remove(1)
	if st.Get().Current != 0 || st.Chosen().Name != "Новый" {
		t.Fatal("removing the chosen one did not choose the first")
	}
	if activeIndex(st.Profiles(), "nothing", 5) != 0 {
		t.Fatal("activeIndex")
	}
}

// the tray's one click, as the phone's notification: from a server to the first bridge, from a bridge back to the
// chosen server, else the first server; nothing while off
func TestOtherLikeTheNotification(t *testing.T) {
	st := OpenStore(t.TempDir())
	st.Add(mustParse(t, "hysteria2://a:1@one.example.ru:443/#Один"))
	st.Add(mustParse(t, "winger-bridge://vk?link=https%3A%2F%2Fvk.com%2Fcall%2Fjoin%2Fabcdefghijkl#Мост VK"))
	st.Add(mustParse(t, "hysteria2://b:2@two.example.ru:443/#Два"))
	all := st.Profiles()
	e := NewEngine(st, t.TempDir(), "", nil, false)
	if e.Other() != nil {
		t.Fatal("a switch while off")
	}
	e.wanted, e.profile, e.preferred = true, all[2], all[2]
	if o := e.Other(); o == nil || o.Name != "Мост VK" {
		t.Fatal("from a server: not the bridge")
	}
	e.profile = all[1]
	if o := e.Other(); o == nil || o.Name != "Два" {
		t.Fatal("from a bridge: not the chosen server")
	}
	e.preferred = all[1]
	if o := e.Other(); o == nil || o.Name != "Один" {
		t.Fatal("from a bridge chosen by hand: not the first server")
	}
}
