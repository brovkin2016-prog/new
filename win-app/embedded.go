package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
)

// A Winger for Windows made for one laptop («Управление» → a person → «💻 Ноутбук (Windows)») carries that laptop's own
// VPN line at its end: JSON, its length (8 bytes, little-endian) and «WGRPROF1». The service takes it in once — the same
// file again changes nothing, and a connection the person removed later is not brought back. The laptop's line takes
// the place of the server connections of another login on the same server (most likely the phone's, pasted by hand):
// a phone and a laptop on one login get in each other's way.
const embedMagic = "WGRPROF1"

type Embedded struct {
	V     int      `json:"v"`
	Name  string   `json:"name"`
	Links []string `json:"links"`
}

// readEmbedded: the line built into this file, and the fingerprint of what was built in; nil when there is none.
func readEmbedded(path string) (*Embedded, string) {
	f, err := os.Open(path)
	if err != nil {
		return nil, ""
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.Size() < 16 {
		return nil, ""
	}
	tail := make([]byte, 16)
	if _, err := f.ReadAt(tail, fi.Size()-16); err != nil || string(tail[8:]) != embedMagic {
		return nil, ""
	}
	n := int64(binary.LittleEndian.Uint64(tail[:8]))
	if n <= 0 || n > 64<<10 || n > fi.Size()-16 {
		return nil, ""
	}
	payload := make([]byte, n)
	if _, err := f.ReadAt(payload, fi.Size()-16-n); err != nil && err != io.EOF {
		return nil, ""
	}
	var e Embedded
	if json.Unmarshal(payload, &e) != nil || e.V != 1 || len(e.Links) == 0 {
		return nil, ""
	}
	sum := sha256.Sum256(payload)
	return &e, hex.EncodeToString(sum[:])
}

// TakeEmbedded puts the built-in line among the connections (once per file) and chooses its main link. Whether it did.
func (st *Store) TakeEmbedded(e *Embedded, sum string) bool {
	var list []*Profile
	for _, l := range e.Links {
		if p, err := ParseLink(l); err == nil && !p.Bridge {
			list = append(list, p)
		}
	}
	if len(list) == 0 || list[0].Obfs != "" {
		return false
	}
	main := list[0]
	took := false
	st.Update(func(s *Settings) {
		if s.Embedded == sum {
			return
		}
		keep := s.Profiles[:0:0]
		for _, sv := range s.Profiles {
			o, err := ParseLink(sv.Link)
			if err == nil && !o.Bridge && o.UpdateHost() != "" && o.UpdateHost() == main.UpdateHost() && user(o.Auth) != user(main.Auth) {
				continue // another login of this server (the phone's): the laptop has its own now
			}
			keep = append(keep, sv)
		}
		s.Profiles = keep
		for _, p := range list {
			item := Saved{Name: p.Name, Link: p.Link}
			if at := same(s.Profiles, p); at >= 0 {
				s.Profiles[at] = item
			} else {
				s.Profiles = append(s.Profiles, item)
			}
		}
		s.Current = same(s.Profiles, main)
		s.Embedded, took = sum, true
	})
	return took
}

// takeOwnLine: at the service's start, the line built into the installed program, if there is one.
func takeOwnLine(st *Store) {
	self, err := os.Executable()
	if err != nil {
		return
	}
	if e, sum := readEmbedded(self); e != nil && st.TakeEmbedded(e, sum) {
		Logf("the laptop's own VPN line built into this Winger: taken (%d connections)", len(e.Links))
	}
}
