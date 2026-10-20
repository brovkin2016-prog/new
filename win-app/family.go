package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Family: what the family server gives this computer by the VPN login it has — the bridges meant for it, its own current
// link when the server moved to a new address, and new versions of Winger for Windows.
type Family struct {
	st        *Store
	eng       *Engine
	dataDir   string
	mu        sync.Mutex
	Update    UpdateInfo
	preparing bool
}

// UpdateInfo is the newest Winger for Windows the family server has.
type UpdateInfo struct {
	Code    int    `json:"code"`
	Name    string `json:"name"`
	SHA256  string `json:"sha256"`
	Notes   string `json:"notes"`
	Checked int64  `json:"checked"`
	State   string `json:"state"` // "", "latest", "downloading", "ready", "failed: …"
}

func (f *Family) post(path string, body any, out any) bool {
	host, _ := f.st.HomeHost()
	if host == "" {
		return false
	}
	b, _ := json.Marshal(body)
	c := client(f.eng.ProbePort(), 25*time.Second)
	r, err := c.Post("https://"+host+":8443"+path, "application/json", bytes.NewReader(b))
	if err != nil {
		Logf("family server %s: %v", path, err)
		return false
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		Logf("family server %s: %d", path, r.StatusCode)
		return false
	}
	return json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(out) == nil
}

// SyncBridges keeps the bridges meant for this computer; the number of new or changed ones. The laptop has bridges of
// its own (one call carries one device: on the phone's bridge the two push each other out of the call again and
// again); the server makes them when this computer first asks (preparing). A bridge it had from before (the phone's)
// is taken over in place by the laptop's own of the same service — and when the VPN runs on it, it goes on on the new.
func (f *Family) SyncBridges(_ int) int {
	_, auth := f.st.HomeHost()
	if auth == "" {
		return 0
	}
	var out struct {
		Links     []string `json:"links"`
		Preparing bool     `json:"preparing"`
	}
	if !f.post("/api/winger_bridge", map[string]string{"auth": auth, "device": "laptop"}, &out) {
		return 0
	}
	f.mu.Lock()
	f.preparing = out.Preparing
	f.mu.Unlock()
	if !out.Preparing { // this laptop's own calls: no other bridge is gone to by itself
		calls := []string{}
		for _, l := range out.Links {
			if p, err := ParseLink(l); err == nil && p.Bridge {
				calls = append(calls, p.Platform+"|"+p.JoinLink)
			}
		}
		f.st.Update(func(s *Settings) { s.LaptopCalls = calls })
	}
	n := 0
	for _, l := range out.Links {
		if p, err := ParseLink(l); err == nil && p.Bridge && f.st.Keep(p) {
			n++
		}
	}
	Logf("bridges from the server: %d, new %d%s", len(out.Links), n, map[bool]string{true: " (the laptop's own are being made)"}[out.Preparing])
	if st := f.eng.Status(); n > 0 && st.Phase != "off" && st.Active != "" && !f.st.Has(st.Active) {
		// the bridge in use was renewed: on again on its new link (the same service, chosen as with a tap on it)
		if was, err := ParseLink(st.Active); err == nil {
			for i, p := range f.st.Profiles() {
				if p.Same(was) {
					f.st.Update(func(s *Settings) { s.Current = i })
					Logf("bridge: the one in use was renewed (the laptop's own) — on again on it")
					_ = f.eng.Connect()
					break
				}
			}
		}
	}
	if st := f.eng.Status(); !out.Preparing && st.Phase != "off" {
		if was, err := ParseLink(st.Active); err == nil && was.Bridge && !ownCall(out.Links, was) {
			// most likely the phone's (pasted by hand, or kept from before): one call carries one device, so the two
			// push each other out of it again and again
			Logf("bridge: the one in use is not this laptop's own (the phone's? the two push each other out of the call)")
		}
	}
	return n
}

// ownCall: the bridge's call is among these links (the server's for this laptop).
func ownCall(links []string, p *Profile) bool {
	for _, l := range links {
		if o, err := ParseLink(l); err == nil && o.Bridge && o.Platform == p.Platform && o.JoinLink == p.JoinLink {
			return true
		}
	}
	return false
}

// Preparing: the server is making this laptop's own bridges.
func (f *Family) Preparing() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.preparing
}

// SyncServer: the family server, asked by its name, gives this computer's own current links for this login: when it
// moved to a new address the saved ones are renewed in place, and its salamander door («маскировка»: Hysteria with
// salamander on its own port) is kept as one more connection — after the renewal, so a door already there (at the old
// address too) is renewed in place, not added again. Whether the saved links were renewed.
func (f *Family) SyncServer(auth string) bool {
	if auth == "" {
		return false
	}
	var out struct {
		Link  string `json:"link"`
		Hop   string `json:"hop"`
		Obfs  string `json:"obfs"`
		Owner *bool  `json:"owner"`
	}
	if !f.post("/api/winger_profile", map[string]string{"auth": auth}, &out) {
		return false
	}
	if out.Owner != nil && f.st.Get().Owner != *out.Owner {
		f.st.Update(func(s *Settings) { s.Owner = *out.Owner })
	}
	main, err := ParseLink(out.Link)
	if err != nil {
		return false
	}
	hop, _ := ParseLink(out.Hop)
	door, _ := ParseLink(out.Obfs)
	if door != nil && (door.Bridge || door.Obfs != "salamander" || door.Auth != auth) {
		door = nil
	}
	changed := f.st.Renew(auth, main, hop, door)
	if changed {
		Logf("the family server moved: its link renewed")
	}
	if door != nil && f.st.Keep(door) {
		Logf("the server's salamander door kept as a connection")
	}
	return changed
}

// RescueLink: a one-time link (3 minutes) into the family server's rescue console (https://DOMAIN:9443, the owner only)
// for this computer's VPN login — for days when the AI app or its «Управление» broke. Asked past the VPN first (it may be
// what is broken), then through it. The link, or why there is none.
func (f *Family) RescueLink() (string, string) {
	host, auth := f.st.HomeHost()
	if host == "" || auth == "" {
		return "", "В Winger нет подключения к семейному серверу"
	}
	body, _ := json.Marshal(map[string]string{"auth": auth})
	why := "Спасательная консоль не отвечает (порт 9443). Если сервер перезагружается — через пару минут ещё раз."
	ports := []int{0}
	if p := f.eng.ProbePort(); p > 0 {
		ports = append(ports, p)
	}
	for _, port := range ports {
		req, _ := http.NewRequest(http.MethodPost, "https://"+host+":9443/api/ticket", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Rescue", "1")
		r, err := client(port, 20*time.Second).Do(req)
		if err != nil {
			Logf("rescue console: %v", err)
			continue
		}
		var out struct {
			URL string `json:"url"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&out)
		r.Body.Close()
		switch {
		case r.StatusCode == 200 && strings.HasPrefix(out.URL, "https://"):
			Logf("rescue console: opened") // never the link: it lets in
			return out.URL, ""
		case r.StatusCode == 401:
			return "", "Спасательная консоль — только для владельца сервера"
		case r.StatusCode == 429:
			return "", "Слишком много попыток входа — попробуйте через 10 минут"
		}
		why = fmt.Sprintf("Спасательная консоль ответила %d", r.StatusCode)
		Logf("rescue console: %d", r.StatusCode)
	}
	return "", why
}

// RenewNow: this connection's own current link from the family server (see SyncServer). The renewed connection, or nil
// when nothing changed.
func (f *Family) RenewNow(p *Profile) *Profile {
	if p == nil || p.Bridge || p.Auth == "" || !f.SyncServer(p.Auth) {
		return nil
	}
	for _, x := range f.st.Profiles() {
		if !x.Bridge && x.Auth == p.Auth && x.Ports == p.Ports {
			return x
		}
	}
	return nil
}

// CheckUpdate asks the family server for a newer Winger for Windows and, when there is one, gets it ready. What came of
// it is in Update.State (the window says it after «Проверить обновление»).
func (f *Family) CheckUpdate() {
	said := func(state string) {
		f.mu.Lock()
		if f.Update.State != "downloading" && f.Update.State != "ready" {
			f.Update.State = state
		}
		f.Update.Checked = time.Now().Unix()
		f.mu.Unlock()
	}
	host, _ := f.st.HomeHost()
	if host == "" {
		said("failed: сначала добавьте подключение — новые версии Winger приходят с вашего сервера по нему")
		return
	}
	c := client(f.eng.ProbePort(), 30*time.Second)
	r, err := c.Get("https://" + host + ":8443/app/winger-win.json")
	if err != nil {
		Logf("update check: %v", err)
		said("failed: семейный сервер не ответил — проверьте интернет и попробуйте ещё раз")
		return
	}
	var info UpdateInfo
	ok := r.StatusCode == 200 && json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&info) == nil
	r.Body.Close()
	switch {
	case !ok || len(info.SHA256) != 64 && info.Code > versionCode:
		said("failed: семейный сервер не дал сведений о версии")
		return
	case info.Code <= versionCode:
		said("latest")
		return
	}
	f.mu.Lock()
	if f.Update.State == "downloading" || f.Update.State == "ready" { // a check already on it
		f.mu.Unlock()
		return
	}
	info.Checked, info.State = time.Now().Unix(), "downloading"
	f.Update = info
	f.mu.Unlock()
	Logf("update: version %s found, downloading", info.Name)
	path, err := f.download(c, "https://"+host+":8443/app/winger-win.exe", info.SHA256)
	f.mu.Lock()
	defer f.mu.Unlock()
	if err != nil {
		f.Update.State = "failed: " + err.Error()
		Logf("update: %v", err)
		return
	}
	f.Update.State = "ready"
	Logf("update: ready, installing")
	if err := applyUpdate(path); err != nil {
		f.Update.State = "failed: " + err.Error()
		Logf("update: %v", err)
	}
}

func (f *Family) download(c *http.Client, url, want string) (string, error) {
	c.Timeout = 15 * time.Minute
	r, err := c.Get(url)
	if err != nil {
		return "", err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return "", errStr("сервер ответил " + itoa(r.StatusCode))
	}
	dir := filepath.Join(f.dataDir, "update")
	if err := privateDir(dir); err != nil { // the service runs what is there: only its own folder will do
		return "", err
	}
	path := filepath.Join(dir, "winger-new.exe")
	out, err := os.Create(path)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(out, h), io.LimitReader(r.Body, 300<<20))
	out.Close()
	if err != nil {
		return "", err
	}
	if hex.EncodeToString(h.Sum(nil)) != want {
		_ = os.Remove(path)
		return "", errStr("файл пришёл не тот (контрольная сумма)")
	}
	return path, nil
}

// Loop: a minute after the start, then every hour; the bridges every 20 minutes while there is none yet (as the phone),
// every 5 while the server makes the laptop's own.
func (f *Family) Loop() {
	time.Sleep(time.Minute)
	var last, lastBridges time.Time
	for {
		switch {
		case last.IsZero() || time.Since(last) >= time.Hour:
			last, lastBridges = time.Now(), time.Now()
			f.SyncBridges(0)
			if _, auth := f.st.HomeHost(); auth != "" { // the family server's own login (a bridge may be the chosen one)
				f.SyncServer(auth)
			}
			f.CheckUpdate()
		case f.Preparing() || !f.hasBridge() && time.Since(lastBridges) >= 20*time.Minute:
			lastBridges = time.Now()
			f.SyncBridges(0)
		}
		time.Sleep(5 * time.Minute)
	}
}

func (f *Family) hasBridge() bool {
	for _, p := range f.st.Profiles() {
		if p.Bridge {
			return true
		}
	}
	return false
}

func (f *Family) UpdateInfo() UpdateInfo {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Update
}

type errStr string

func (e errStr) Error() string { return string(e) }
