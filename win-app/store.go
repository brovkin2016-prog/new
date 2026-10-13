package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Saved is a connection as it is kept: its link and the name the person sees.
type Saved struct {
	Name string `json:"name"`
	Link string `json:"link"`
}

// Settings are everything Winger keeps between starts.
type Settings struct {
	Profiles []Saved  `json:"profiles"`
	Current  int      `json:"current"`
	OnlyApps bool     `json:"onlyApps"` // only the chosen programs through the VPN
	Apps     []string `json:"apps"`     // their files: telegram.exe, chrome.exe…
	Manual   bool     `json:"manual"`   // the automatic choice switched off
	KeepOn   bool     `json:"keepOn"`   // on again after a restart of the computer
	// the last speed check of each connection (by its link), as its row shows it: «⚡ 23,4 Мбит/с · 45 мс · 15:03»
	Speeds map[string]string `json:"speeds,omitempty"`
}

// Store keeps the settings in a file in Winger's data folder.
type Store struct {
	mu   sync.Mutex
	path string
	s    Settings
}

func OpenStore(dir string) *Store {
	st := &Store{path: filepath.Join(dir, "settings.json")}
	if b, err := os.ReadFile(st.path); err == nil {
		_ = json.Unmarshal(b, &st.s)
	}
	if dualNames(st.s.Profiles) {
		st.save()
	}
	return st
}

// dualNames: Winger before 123 kept the two-track Telemost trial in place of the usual bridge, under the usual one's
// name — such a row gets the name its own link carries («… 2 трека (проверка)»). Whether any changed.
func dualNames(list []Saved) bool {
	changed := false
	for i, sv := range list {
		if p, err := ParseLink(sv.Link); err == nil && p.Bridge && p.DualTrack && p.Name != "" && sv.Name != p.Name {
			list[i].Name, changed = p.Name, true
		}
	}
	return changed
}

func (st *Store) save() {
	b, _ := json.MarshalIndent(st.s, "", " ")
	tmp := st.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, st.path)
	}
}

// Get is a copy of the settings.
func (st *Store) Get() Settings {
	st.mu.Lock()
	defer st.mu.Unlock()
	s := st.s
	s.Profiles = append([]Saved(nil), st.s.Profiles...)
	s.Apps = append([]string(nil), st.s.Apps...)
	s.Speeds = map[string]string{}
	for k, v := range st.s.Speeds {
		s.Speeds[k] = v
	}
	return s
}

// Update changes the settings and keeps them.
func (st *Store) Update(f func(s *Settings)) {
	st.mu.Lock()
	defer st.mu.Unlock()
	f(&st.s)
	st.save()
}

// Profiles are the saved connections, read.
func (st *Store) Profiles() []*Profile {
	var out []*Profile
	for _, sv := range st.Get().Profiles {
		if p, err := ParseLink(sv.Link); err == nil {
			if sv.Name != "" {
				p.Name = sv.Name
			}
			out = append(out, p)
		}
	}
	return out
}

// Chosen is the connection the person chose (nil when there is none).
func (st *Store) Chosen() *Profile {
	all := st.Profiles()
	if len(all) == 0 {
		return nil
	}
	return all[max(0, min(st.Get().Current, len(all)-1))]
}

// Add: a link the person added (as Winger on the phone does it) — it replaces the same server and person, or the
// bridge of the same service and track count, else comes last; it becomes the chosen one either way.
func (st *Store) Add(p *Profile) {
	st.Update(func(s *Settings) {
		at := same(s.Profiles, p)
		item := Saved{Name: p.Name, Link: p.Link}
		if at >= 0 {
			s.Profiles[at] = item
		} else {
			s.Profiles, at = append(s.Profiles, item), len(s.Profiles)
		}
		s.Current = at
	})
}

// Keep: a bridge the family server keeps ready for this computer — added or renewed without choosing it (the phone's
// rule): the same link stays; the same call with other settings stays as it is (the person's own way, say the video on
// a network where the data channel does not carry); a new call of the service replaces it, with the server's name.
// The name the server gives is put right on the same link too: Winger before 123 kept the two-track trial in place of
// the usual Telemost bridge, under the usual one's name. Whether anything changed.
func (st *Store) Keep(p *Profile) bool {
	changed := false
	st.Update(func(s *Settings) {
		chosen := ""
		if s.Current >= 0 && s.Current < len(s.Profiles) {
			chosen = s.Profiles[s.Current].Link
		}
		changed = dualNames(s.Profiles)
		at := same(s.Profiles, p)
		if at >= 0 {
			o, _ := ParseLink(s.Profiles[at].Link)
			switch {
			case s.Profiles[at].Link == p.Link:
				if s.Profiles[at].Name != p.Name {
					s.Profiles[at].Name, changed = p.Name, true
				}
				return
			case o != nil && o.JoinLink != "" && o.JoinLink == p.JoinLink:
				return
			}
			s.Profiles[at] = Saved{Name: p.Name, Link: p.Link}
		} else {
			s.Profiles = append(s.Profiles, Saved{Name: p.Name, Link: p.Link})
		}
		changed = true
		for i, sv := range s.Profiles {
			if sv.Link == chosen {
				s.Current = i
			}
		}
	})
	return changed
}

// same: where the same connection already is (-1: nowhere) — the last one, as on the phone.
func same(list []Saved, p *Profile) int {
	at := -1
	for i, sv := range list {
		if o, err := ParseLink(sv.Link); err == nil && o.Same(p) {
			at = i
		}
	}
	return at
}

// Renew: the family server moved to a new address — the saved server with this login takes the link the server gives
// now, in place (its name, place and choice stay; the main link and the port-hopping one are kept apart).
func (st *Store) Renew(auth string, main, hop *Profile) bool {
	changed := false
	st.Update(func(s *Settings) {
		for i, sv := range s.Profiles {
			o, err := ParseLink(sv.Link)
			if err != nil || o.Bridge || o.Auth != auth {
				continue
			}
			fresh := main
			if strings.Contains(o.Ports, "-") {
				fresh = hop
			}
			if fresh == nil || fresh.Bridge || fresh.Auth != auth || fresh.Link == sv.Link {
				continue
			}
			s.Profiles[i].Link, changed = fresh.Link, true
		}
	})
	return changed
}

// Remove takes a connection away; the one in use stays chosen, and when the chosen one goes, the first one is.
func (st *Store) Remove(i int) {
	st.Update(func(s *Settings) {
		if i < 0 || i >= len(s.Profiles) {
			return
		}
		cur := max(0, min(s.Current, len(s.Profiles)-1))
		delete(s.Speeds, s.Profiles[i].Link)
		s.Profiles = append(s.Profiles[:i], s.Profiles[i+1:]...)
		switch {
		case i < cur:
			s.Current = cur - 1
		case i == cur:
			s.Current = 0
		default:
			s.Current = cur
		}
	})
}

// SetSpeed keeps a connection's last speed check for its row.
func (st *Store) SetSpeed(link, line string) {
	st.Update(func(s *Settings) {
		if s.Speeds == nil {
			s.Speeds = map[string]string{}
		}
		s.Speeds[link] = line
	})
}

// HomeHost is the family server's name: the chosen server's, else any saved one's.
func (st *Store) HomeHost() (host, auth string) {
	if p := st.Chosen(); p != nil && p.UpdateHost() != "" {
		return p.UpdateHost(), p.Auth
	}
	for _, p := range st.Profiles() {
		if p.UpdateHost() != "" {
			return p.UpdateHost(), p.Auth
		}
	}
	return "", ""
}
