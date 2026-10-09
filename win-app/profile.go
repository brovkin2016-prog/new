package main

import (
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Profile is one saved connection: the family server (a hysteria2:// link) or a bridge through a call service
// (winger-bridge://…), parsed the same way Winger on the phone does it.
type Profile struct {
	Name   string `json:"name"`
	Link   string `json:"link"`
	Bridge bool   `json:"-"`

	// the server
	Host, Ports, Auth, SNI, Obfs, ObfsPassword, Pin string
	Insecure                                        bool

	// the bridge
	Platform, JoinLink, TunnelMode string
	FPS, Batch                     int
	Reliable, DualTrack            bool
}

var linkRe = regexp.MustCompile(`(?i)(?:hysteria2|hy2|winger-bridge)://[^\s"'<>]+`)

// FindLink takes the first link out of a pasted message.
func FindLink(text string) string {
	return linkRe.FindString(text)
}

// ParseLink reads hysteria2://auth@host:port/?sni=…&insecure=1&obfs=salamander&obfs-password=…&pinSHA256=…#name
// and winger-bridge://service?…#name.
func ParseLink(link string) (*Profile, error) {
	s := strings.TrimSpace(link)
	lower := strings.ToLower(s)
	if strings.HasPrefix(lower, "winger-bridge://") {
		return parseBridge(s)
	}
	if !strings.HasPrefix(lower, "hysteria2://") && !strings.HasPrefix(lower, "hy2://") {
		return nil, errors.New("это не ссылка VPN")
	}
	p := &Profile{Link: s}
	rest := s[strings.Index(s, "://")+3:]
	if i := strings.IndexByte(rest, '#'); i >= 0 {
		p.Name, _ = url.PathUnescape(rest[i+1:])
		p.Name = strings.TrimSpace(p.Name)
		rest = rest[:i]
	}
	query := ""
	if i := strings.IndexByte(rest, '?'); i >= 0 {
		query, rest = rest[i+1:], rest[:i]
	}
	rest = strings.TrimSuffix(rest, "/")
	if i := strings.LastIndexByte(rest, '@'); i >= 0 {
		p.Auth, _ = url.PathUnescape(rest[:i])
		rest = rest[i+1:]
	}
	// host:port, [v6]:port; the port may be a range or a list for port hopping (20000-30000, 443,5000-6000)
	if strings.HasPrefix(rest, "[") {
		end := strings.IndexByte(rest, ']')
		if end < 0 {
			return nil, errors.New("ошибка в адресе")
		}
		p.Host, p.Ports = rest[1:end], "443"
		if end+1 < len(rest) && rest[end+1] == ':' {
			p.Ports = rest[end+2:]
		}
	} else if i := strings.IndexByte(rest, ':'); i >= 0 {
		p.Host, p.Ports = rest[:i], rest[i+1:]
	} else {
		p.Host, p.Ports = rest, "443"
	}
	if p.Host == "" || !regexp.MustCompile(`^[0-9,\-]+$`).MatchString(p.Ports) {
		return nil, errors.New("ошибка в адресе")
	}
	q := queryOf(query)
	p.SNI, p.Obfs, p.ObfsPassword, p.Pin = q["sni"], q["obfs"], q["obfs-password"], q["pinSHA256"]
	p.Insecure = q["insecure"] == "1" || strings.EqualFold(q["insecure"], "true")
	if p.Name == "" {
		p.Name = p.Host
	}
	return p, nil
}

var bridgeRooms = map[string]*regexp.Regexp{
	"telemost": regexp.MustCompile(`^https://telemost(?:\.360)?\.yandex\.(?:ru|com)/j/[0-9A-Za-z_-]{6,64}$`),
	"wbstream": regexp.MustCompile(`^wbstream://[0-9A-Za-z_-]{6,64}$`),
	"dion":     regexp.MustCompile(`^dion://[0-9A-Za-z_-]{4,64}$`),
	"bitrix":   regexp.MustCompile(`^https://[0-9A-Za-z-]{2,63}\.bitrix24\.(?:ru|by|kz|com)/video/[0-9A-Za-z_-]{2,64}$`),
}

// parseBridge reads winger-bridge://telemost?link=…&fps=24&batch=45&reliable=1&dual=0#name,
// winger-bridge://wbstream?room=…&mode=dc#name, winger-bridge://dion?room=…#name, winger-bridge://bitrix?link=…&mode=dc#name
// with each service's own best settings when the link does not say.
func parseBridge(s string) (*Profile, error) {
	p := &Profile{Link: s, Bridge: true}
	rest := s[len("winger-bridge://"):]
	if i := strings.IndexByte(rest, '#'); i >= 0 {
		p.Name, _ = url.PathUnescape(rest[i+1:])
		p.Name = strings.TrimSpace(p.Name)
		rest = rest[:i]
	}
	query := ""
	if i := strings.IndexByte(rest, '?'); i >= 0 {
		query, rest = rest[i+1:], rest[:i]
	}
	p.Platform = strings.ToLower(strings.TrimSuffix(rest, "/"))
	q := queryOf(query)
	switch p.Platform {
	case "telemost", "bitrix":
		p.JoinLink = q["link"]
	case "wbstream", "dion":
		p.JoinLink = q["room"]
	default:
		return nil, errors.New("неизвестный мост")
	}
	if !bridgeRooms[p.Platform].MatchString(p.JoinLink) {
		return nil, errors.New("в ссылке моста нет звонка")
	}
	batch := 30
	if p.Platform == "telemost" {
		batch = 45
	}
	p.FPS = number(q["fps"], 24, 1, 60)
	p.Batch = number(q["batch"], batch, 1, 200)
	p.Reliable = q["reliable"] != "0"
	p.DualTrack = q["dual"] == "1"
	if p.Platform == "wbstream" || p.Platform == "bitrix" {
		p.TunnelMode = "dc"
		if q["mode"] == "video" {
			p.TunnelMode = "video"
		}
	}
	if p.Name == "" {
		p.Name = "Мост · " + p.Service()
	}
	return p, nil
}

// queryOf reads a link's query the way the phone's Winger does: «+» stays a plus (it is in passwords).
func queryOf(query string) map[string]string {
	out := map[string]string{}
	for _, kv := range strings.Split(query, "&") {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		if d, err := url.PathUnescape(v); err == nil {
			v = d
		}
		out[k] = v
	}
	return out
}

func number(v string, dflt, min, max int) int {
	n, err := strconv.Atoi(v)
	if err != nil {
		return dflt
	}
	return max0(min, min0(max, n))
}

func min0(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max0(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// Service is the call service's name for the screen.
func (p *Profile) Service() string {
	switch p.Platform {
	case "wbstream":
		return "WB Stream"
	case "dion":
		return "DION"
	case "bitrix":
		return "Битрикс24"
	default:
		return "Телемост"
	}
}

// UpdateHost is the family server's name (for the app's updates, bridges and the current link), or "" for a bridge
// or a server given by its address only.
func (p *Profile) UpdateHost() string {
	if p.Bridge {
		return ""
	}
	n := p.SNI
	if n == "" {
		n = p.Host
	}
	if regexp.MustCompile(`^[0-9.]+$`).MatchString(n) || strings.Contains(n, ":") {
		return ""
	}
	return n
}

// RelayMode is the relay's mode for this bridge's service.
func (p *Profile) RelayMode() string {
	return p.Platform + "-headless-joiner"
}

// JoinParams is what the relay is told on «JOIN:» for this service (the call, the name in it, the tunnel's settings).
func (p *Profile) JoinParams(tunnel string) map[string]any {
	j := map[string]any{"displayName": "Участник"}
	if p.Platform == "wbstream" || p.Platform == "dion" {
		j["roomId"] = p.JoinLink
	} else {
		j["joinLink"] = p.JoinLink
	}
	if p.Platform != "dion" {
		j["vp8Fps"], j["vp8Batch"], j["reliable"], j["dualTrack"] = p.FPS, p.Batch, p.Reliable, p.DualTrack
		if p.Platform == "wbstream" || p.Platform == "bitrix" {
			j["tunnelMode"] = tunnel
		}
	}
	return j
}

// Same: one bridge per call service (a new call replaces the old one); a server with the same address, ports and
// person (a new key replaces the old one).
func (p *Profile) Same(o *Profile) bool {
	if p.Bridge || o.Bridge {
		return p.Bridge && o.Bridge && p.Platform == o.Platform
	}
	return p.Host == o.Host && p.Ports == o.Ports && (p.Auth == o.Auth || user(p.Auth) != "" && user(p.Auth) == user(o.Auth))
}

func user(auth string) string {
	if i := strings.IndexByte(auth, ':'); i > 0 {
		return auth[:i]
	}
	return ""
}
