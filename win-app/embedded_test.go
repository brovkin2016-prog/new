package main

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// a Winger made for one laptop: the program's bytes, then the line as JSON, its length and the mark (as the server
// appends it in appweb.personal_win_exe)
func withLine(t *testing.T, e Embedded) string {
	t.Helper()
	payload, _ := json.Marshal(e)
	n := make([]byte, 8)
	binary.LittleEndian.PutUint64(n, uint64(len(payload)))
	path := filepath.Join(t.TempDir(), "winger.exe")
	b := append([]byte("MZ the program itself"), payload...)
	if err := os.WriteFile(path, append(append(b, n...), embedMagic...), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

const (
	phoneLine  = "hysteria2://owner:phonekey@1.2.3.4:443/?sni=vpn.example.ru#srv-owner"
	laptopLine = "hysteria2://owner-pc:laptopkey@1.2.3.4:443/?sni=vpn.example.ru#srv-owner-pc"
	laptopDoor = "hysteria2://owner-pc:laptopkey@1.2.3.4:31234/?sni=vpn.example.ru&obfs=salamander&obfs-password=" +
		"noisenoisenoise1#srv-owner-pc-obfs"
	otherVPN = "hysteria2://friend:x1@5.6.7.8:443/?sni=other.example.org#friend"
	aBridge  = "winger-bridge://telemost?room=https%3A%2F%2Ftelemost.yandex.ru%2Fj%2F12345678901234#Телемост"
)

func TestEmbeddedLine(t *testing.T) {
	if e, _ := readEmbedded(filepath.Join(t.TempDir(), "none.exe")); e != nil {
		t.Fatal("no file: no line")
	}
	plain := filepath.Join(t.TempDir(), "plain.exe")
	_ = os.WriteFile(plain, []byte("MZ a Winger for anyone, nothing at its end"), 0o644)
	if e, _ := readEmbedded(plain); e != nil {
		t.Fatal("a Winger for anyone carries no line")
	}
	path := withLine(t, Embedded{V: 1, Name: "owner", Links: []string{laptopLine, laptopDoor}})
	e, sum := readEmbedded(path)
	if e == nil || len(e.Links) != 2 || e.Links[0] != laptopLine || len(sum) != 64 {
		t.Fatalf("the built-in line not read: %+v", e)
	}

	// the laptop had the phone's login pasted by hand, another server and a bridge: the phone's goes, the rest stay
	st := OpenStore(t.TempDir())
	for _, l := range []string{phoneLine, otherVPN} {
		p, _ := ParseLink(l)
		st.Add(p)
	}
	if b, err := ParseLink(aBridge); err == nil {
		st.Keep(b)
	}
	if !st.TakeEmbedded(e, sum) {
		t.Fatal("the built-in line not taken")
	}
	links := map[string]bool{}
	for _, sv := range st.Get().Profiles {
		links[sv.Link] = true
	}
	if links[phoneLine] || !links[laptopLine] || !links[laptopDoor] || !links[otherVPN] {
		t.Fatalf("after taking it: %v", links)
	}
	if c := st.Chosen(); c == nil || c.Link != laptopLine {
		t.Fatalf("the laptop's own line must be the chosen one: %+v", c)
	}
	if _, auth := st.HomeHost(); auth != "owner-pc:laptopkey" {
		t.Fatalf("the family server is asked with the laptop's own login, not %q", auth)
	}

	// the same file again (each start of the service): nothing changes; a connection removed later stays removed
	for i, sv := range st.Get().Profiles {
		if sv.Link == laptopDoor {
			st.Remove(i)
			break
		}
	}
	if st.TakeEmbedded(e, sum) {
		t.Fatal("the same file taken twice")
	}
	for _, sv := range st.Get().Profiles {
		if sv.Link == laptopDoor {
			t.Fatal("a connection the person removed came back")
		}
	}

	// a line whose first link is no server (a bridge, a salamander door): not taken
	bad := withLine(t, Embedded{V: 1, Links: []string{laptopDoor}})
	if e2, s2 := readEmbedded(bad); e2 == nil || OpenStore(t.TempDir()).TakeEmbedded(e2, s2) {
		t.Fatal("a door alone is not a laptop's line")
	}
}
