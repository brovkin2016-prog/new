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
	return st
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
	i := st.Get().Current
	if i < 0 || i >= len(all) {
		i = 0
	}
	return all[i]
}

// Add adds a link (or renews it when the same server and person, or a bridge of the same service, is there).
// choose: it becomes the chosen one. Returns the profile and whether anything changed.
func (st *Store) Add(p *Profile, choose bool) bool {
	changed := false
	st.Update(func(s *Settings) {
		chosen := ""
		if s.Current >= 0 && s.Current < len(s.Profiles) {
			chosen = s.Profiles[s.Current].Link
		}
		at := -1
		for i, sv := range s.Profiles {
			if o, err := ParseLink(sv.Link); err == nil && o.Same(p) {
				at = i
			}
		}
		item := Saved{Name: p.Name, Link: p.Link}
		switch {
		case at >= 0 && s.Profiles[at].Link == p.Link:
		case at >= 0:
			item.Name = s.Profiles[at].Name // a new call or key of the same: its name stays
			if chosen == s.Profiles[at].Link {
				chosen = p.Link
			}
			s.Profiles[at], changed = item, true
		default:
			s.Profiles, at, changed = append(s.Profiles, item), len(s.Profiles), true
		}
		if choose {
			s.Current = at
			return
		}
		for i, sv := range s.Profiles {
			if sv.Link == chosen {
				s.Current = i
			}
		}
	})
	return changed
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

// Remove takes a connection away.
func (st *Store) Remove(i int) {
	st.Update(func(s *Settings) {
		if i < 0 || i >= len(s.Profiles) {
			return
		}
		s.Profiles = append(s.Profiles[:i], s.Profiles[i+1:]...)
		if s.Current >= i && s.Current > 0 {
			s.Current--
		}
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
