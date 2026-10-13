package main

import (
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

//go:embed web
var webFiles embed.FS

const uiPort = 47710

// UIToken: the window's key (a file only this computer's people can read): other programs and pages cannot drive the VPN.
func UIToken(dir string) string {
	path := filepath.Join(dir, "ui-token")
	if b, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(b))) >= 32 {
		return strings.TrimSpace(string(b))
	}
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	t := hex.EncodeToString(b)
	_ = os.WriteFile(path, []byte(t), 0o644)
	return t
}

type connView struct {
	Name    string `json:"name"`
	Bridge  bool   `json:"bridge"`
	Service string `json:"service"`
	Chosen  bool   `json:"chosen"`
	Active  bool   `json:"active"`
	Speed   string `json:"speed,omitempty"` // the last speed check, with its time
	Ping    string `json:"ping,omitempty"`  // the last response time, with its time
}

// activeIndex: the row of the connection in use now (the chosen one, or the one Winger moved to by itself).
func activeIndex(all []*Profile, active string, current int) int {
	for i, p := range all {
		if p.Link == active {
			return i
		}
	}
	return max(0, min(current, len(all)-1))
}

// API is the window's side of things: the state, the buttons, the settings.
func API(eng *Engine, fam *Family, st *Store, token string) http.Handler {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(webFiles, "web")
	files := http.FileServer(http.FS(sub))
	reply := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(v)
	}
	fail := func(w http.ResponseWriter, msg string) {
		w.WriteHeader(400)
		reply(w, map[string]string{"error": msg})
	}
	body := func(r *http.Request) map[string]any {
		m := map[string]any{}
		_ = json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&m)
		return m
	}
	index := func(r *http.Request) int {
		m := body(r)
		i, _ := m["i"].(float64)
		return int(i)
	}
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		s, status, all := st.Get(), eng.Status(), st.Profiles()
		cur := max(0, min(s.Current, len(all)-1))
		conns, name := []connView{}, ""
		for i, p := range all {
			c := connView{Name: p.Name, Bridge: p.Bridge, Service: p.Service(), Chosen: i == cur,
				Active: status.Phase != "off" && status.Active == p.Link, Speed: s.Speeds[p.Link], Ping: s.Pings[p.Link]}
			if c.Active {
				name = p.Name
			}
			conns = append(conns, c)
		}
		down, up := eng.Rates()
		other := ""
		if o := eng.Other(); o != nil {
			other = map[bool]string{true: "Через мост", false: "Через сервер"}[o.Bridge]
		}
		reply(w, map[string]any{"status": status, "conns": conns, "onlyApps": s.OnlyApps, "apps": s.Apps,
			"auto": !s.Manual, "version": versionName, "update": fam.UpdateInfo(), "captcha": Captcha(),
			"down": down, "up": up, "activeName": name, "switch": other})
	})
	mux.HandleFunc("/api/connect", func(w http.ResponseWriter, r *http.Request) {
		if err := eng.Connect(); err != nil {
			fail(w, err.Error())
			return
		}
		reply(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/disconnect", func(w http.ResponseWriter, r *http.Request) {
		eng.Disconnect()
		reply(w, map[string]bool{"ok": true})
	})
	// a connection's button, as on the phone: on through it (switching over from another one), or off when it is the
	// one in use
	mux.HandleFunc("/api/use", func(w http.ResponseWriter, r *http.Request) {
		i := index(r)
		all := st.Profiles()
		if i < 0 || i >= len(all) {
			fail(w, "нет такого подключения")
			return
		}
		status := eng.Status()
		if status.Phase != "off" && i == activeIndex(all, status.Active, st.Get().Current) {
			eng.Disconnect()
			reply(w, map[string]bool{"ok": true, "off": true})
			return
		}
		st.Update(func(s *Settings) { s.Current = i })
		_ = eng.Connect() // on, or over from the old connection to this one
		reply(w, map[string]bool{"ok": true})
	})
	// the tray's one click to the other kind of connection (the phone's notification button «Через мост» / «Через сервер»)
	mux.HandleFunc("/api/switch", func(w http.ResponseWriter, r *http.Request) {
		o := eng.Other()
		if o == nil {
			fail(w, "некуда переключаться")
			return
		}
		at := -1
		for i, p := range st.Profiles() {
			if p.Link == o.Link {
				at = i
			}
		}
		if at < 0 {
			fail(w, "нет такого подключения")
			return
		}
		st.Update(func(s *Settings) { s.Current = at })
		_ = eng.Connect()
		reply(w, map[string]bool{"ok": true})
	})
	// a link the person pasted: added (or put in place of the same one) and chosen; on — over to it at once
	mux.HandleFunc("/api/add", func(w http.ResponseWriter, r *http.Request) {
		text, _ := body(r)["text"].(string)
		link := FindLink(text)
		p, err := ParseLink(link)
		if link == "" || err != nil {
			f := strings.ToLower(strings.TrimSpace(text))
			if strings.HasPrefix(f, "vless://") || strings.HasPrefix(f, "vmess://") {
				fail(w, "Это ссылка другого типа. Нужна ссылка, которая начинается с hysteria2://")
			} else {
				fail(w, "Это не ссылка VPN. Нужна ссылка, которая начинается с hysteria2://")
			}
			return
		}
		now := eng.Status()
		st.Add(p)
		Logf("added %s", map[bool]string{true: "a bridge", false: "a server"}[p.Bridge])
		if now.Phase != "off" && now.Active != p.Link { // on: over to it (the one in use already: nothing to do)
			_ = eng.Connect()
		}
		reply(w, map[string]any{"ok": true, "bridge": p.Bridge, "name": p.Name})
	})
	mux.HandleFunc("/api/remove", func(w http.ResponseWriter, r *http.Request) {
		i := index(r)
		all := st.Profiles()
		if i < 0 || i >= len(all) {
			fail(w, "нет такого подключения")
			return
		}
		if cur := max(0, min(st.Get().Current, len(all)-1)); i == cur && eng.Status().Phase != "off" {
			eng.Disconnect() // the chosen one goes: off, as on the phone
		}
		st.Remove(i)
		reply(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/speed", func(w http.ResponseWriter, r *http.Request) {
		i := index(r)
		all := st.Profiles()
		if i < 0 || i >= len(all) {
			fail(w, "нет такого подключения")
			return
		}
		line, err := eng.SpeedOf(all[i])
		if err != nil {
			fail(w, err.Error())
			return
		}
		reply(w, map[string]any{"line": line})
	})
	mux.HandleFunc("/api/pingall", func(w http.ResponseWriter, r *http.Request) {
		eng.PingAll()
		reply(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		eng.PingNow()
		reply(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/apps", func(w http.ResponseWriter, r *http.Request) {
		m := body(r)
		only, _ := m["only"].(bool)
		var apps []string
		if list, ok := m["apps"].([]any); ok {
			for _, a := range list {
				if s, ok := a.(string); ok && strings.HasSuffix(strings.ToLower(s), ".exe") && len(s) < 100 {
					apps = append(apps, strings.ToLower(filepath.Base(s)))
				}
			}
		}
		sort.Strings(apps)
		st.Update(func(s *Settings) { s.OnlyApps, s.Apps = only && len(apps) > 0, apps })
		eng.Restart()
		reply(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/processes", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"processes": Processes()})
	})
	mux.HandleFunc("/api/auto", func(w http.ResponseWriter, r *http.Request) {
		on, _ := body(r)["on"].(bool)
		st.Update(func(s *Settings) { s.Manual = !on })
		reply(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/update", func(w http.ResponseWriter, r *http.Request) {
		go fam.CheckUpdate()
		go fam.SyncBridges(0)
		reply(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/journal", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]string{"text": Report(eng, st)})
	})
	return guard(mux, files, token)
}

// guard: only this computer's own window (its key in a cookie), only by the address it was opened at.
func guard(api http.Handler, files http.Handler, token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.Host)
		if host != "127.0.0.1" && host != "localhost" {
			http.Error(w, "нет", 403)
			return
		}
		if t := r.URL.Query().Get("t"); t != "" && subtle.ConstantTimeCompare([]byte(t), []byte(token)) == 1 {
			http.SetCookie(w, &http.Cookie{Name: "wt", Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		c, err := r.Cookie("wt")
		if err != nil || subtle.ConstantTimeCompare([]byte(c.Value), []byte(token)) != 1 {
			http.Error(w, "Откройте Winger из меню «Пуск» или значка у часов.", 403)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if r.Method != http.MethodGet && r.Header.Get("Content-Type") != "application/json" {
				http.Error(w, "нет", 415) // a page from elsewhere cannot post plain forms here
				return
			}
			api.ServeHTTP(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
}

// Report: the journal's newest part with what Winger knows now, to paste into a chat (nothing private in it).
func Report(eng *Engine, st *Store) string {
	s, status := st.Get(), eng.Status()
	var b strings.Builder
	b.WriteString("Winger для Windows " + versionName + "\n")
	b.WriteString("VPN: " + status.Phase)
	if status.Note != "" {
		b.WriteString(" — " + status.Note)
	}
	if status.Auto {
		b.WriteString(" (выбран сам)")
	}
	b.WriteString("\nподключений: " + itoa(len(s.Profiles)))
	if s.OnlyApps {
		b.WriteString(", через VPN только: " + strings.Join(s.Apps, ", "))
	}
	host, _ := st.HomeHost()
	if host != "" {
		c := client(0, 10*time.Second)
		t := time.Now()
		r, err := c.Get("https://" + host + ":8443/app/version.json")
		if err == nil {
			r.Body.Close()
			b.WriteString("\nсервер напрямую (TCP 8443): ответ " + itoa(r.StatusCode) + " за " + itoa(int(time.Since(t).Milliseconds())) + " мс")
		} else {
			b.WriteString("\nсервер напрямую (TCP 8443): НЕ отвечает — " + strings.ReplaceAll(err.Error(), host, "сервер"))
		}
	}
	b.WriteString("\n--- журнал ---\n" + JournalTail(12<<10))
	return Mask(b.String())
}
