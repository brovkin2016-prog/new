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
		s, status := st.Get(), eng.Status()
		conns := []connView{}
		for i, p := range st.Profiles() {
			conns = append(conns, connView{Name: p.Name, Bridge: p.Bridge, Service: p.Service(), Chosen: i == s.Current,
				Active: status.Phase != "off" && status.Active == p.Link})
		}
		reply(w, map[string]any{"status": status, "conns": conns, "onlyApps": s.OnlyApps, "apps": s.Apps,
			"auto": !s.Manual, "version": versionName, "update": fam.UpdateInfo()})
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
	mux.HandleFunc("/api/use", func(w http.ResponseWriter, r *http.Request) {
		i := index(r)
		if i < 0 || i >= len(st.Profiles()) {
			fail(w, "нет такого подключения")
			return
		}
		st.Update(func(s *Settings) { s.Current = i })
		_ = eng.Connect()
		reply(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/add", func(w http.ResponseWriter, r *http.Request) {
		text, _ := body(r)["text"].(string)
		link := FindLink(text)
		p, err := ParseLink(link)
		if link == "" || err != nil {
			fail(w, "В тексте нет ссылки VPN или моста (hysteria2:// или winger-bridge://).")
			return
		}
		st.Add(p, !p.Bridge || len(st.Profiles()) == 0)
		Logf("added %s", map[bool]string{true: "a bridge", false: "a server"}[p.Bridge])
		reply(w, map[string]any{"ok": true, "bridge": p.Bridge, "name": p.Name})
	})
	mux.HandleFunc("/api/remove", func(w http.ResponseWriter, r *http.Request) {
		i := index(r)
		all := st.Profiles()
		if i < 0 || i >= len(all) {
			fail(w, "нет такого подключения")
			return
		}
		if s := eng.Status(); s.Phase != "off" && s.Active == all[i].Link {
			eng.Disconnect()
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
		mbit, err := eng.SpeedOf(all[i])
		if err != nil {
			fail(w, err.Error())
			return
		}
		Logf("speed «%s»: %.1f Mbit/s", all[i].Name, mbit)
		reply(w, map[string]any{"mbit": mbit})
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
