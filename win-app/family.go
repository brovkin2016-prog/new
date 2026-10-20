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
	stuckAt   map[string]time.Time // a service's bridge last said to be stuck (Stuck)
	journalAt time.Time            // the journal last sent
	updAt     time.Time            // the update last went to downloading / waiting / ready (one stuck there is let go)
	updNow    chan struct{}        // «Проверить обновление» while a new version waits for a quiet minute: in now
}

// UpdateInfo is the newest Winger for Windows the family server has.
type UpdateInfo struct {
	Code    int    `json:"code"`
	Name    string `json:"name"`
	SHA256  string `json:"sha256"`
	Notes   string `json:"notes"`
	Checked int64  `json:"checked"`
	State   string `json:"state"` // "", "latest", "downloading", "waiting", "ready", "failed: …"
}

// the family server's update files and the way to them (the tests' own server); how often a waiting update looks
// whether the VPN is quiet
var (
	updateURL    = func(host, file string) string { return "https://" + host + ":8443/app/" + file }
	updateClient = client
	quietEvery   = 15 * time.Second
)

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

// busyUpdate: a check already on it (not one stuck: after 20 minutes it is let go). Called with f.mu held.
func (f *Family) busyUpdate() bool {
	switch f.Update.State {
	case "waiting":
		return true
	case "downloading", "ready":
		return time.Since(f.updAt) < 20*time.Minute
	}
	return false
}

// CheckUpdate asks the family server for a newer Winger for Windows and, when there is one, puts it in. What came of it
// is in Update.State (the window says it after «Проверить обновление»). The server is asked straight first (the VPN
// stays free), then through the VPN when it runs on the server — through a bridge only when the person asked (a bridge
// is slow: the file would take it over for long). Asked by the person, the new version goes in at once; found by itself,
// at a quiet minute (the VPN off, or next to nothing through it), so no call or film breaks off for the restart. A
// version that did not run on this computer (put back by --replace) is not taken again: the next one is waited for.
func (f *Family) CheckUpdate(asked bool) {
	f.mu.Lock()
	if f.busyUpdate() {
		if asked && f.Update.State == "waiting" && f.updNow != nil {
			f.Update.Checked = time.Now().Unix()
			select {
			case f.updNow <- struct{}{}:
			default:
			}
		}
		f.mu.Unlock()
		return
	}
	f.mu.Unlock()
	said := func(state string) {
		f.mu.Lock()
		if !f.busyUpdate() {
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
	ports := []int{0}
	if p := f.eng.ProbePort(); p > 0 && (asked || !f.eng.OnBridge()) {
		ports = append(ports, p)
	}
	var info UpdateInfo
	port, ok := -1, false
	for _, p := range ports {
		r, err := updateClient(p, 30*time.Second).Get(updateURL(host, "winger-win.json"))
		if err != nil {
			Logf("update check (%s): %v", map[bool]string{true: "straight", false: "through the VPN"}[p == 0], err)
			continue
		}
		ok = r.StatusCode == 200 && json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&info) == nil
		r.Body.Close()
		port = p
		break
	}
	switch {
	case port < 0:
		said("failed: семейный сервер не ответил — проверьте интернет и попробуйте ещё раз")
		return
	case !ok || len(info.SHA256) != 64 && info.Code > versionCode:
		said("failed: семейный сервер не дал сведений о версии")
		return
	case info.Code <= versionCode:
		said("latest")
		return
	}
	if code, why := badUpdate(f.dataDir); code == info.Code {
		said("failed: версия " + info.Name + " не заработала на этом компьютере (" + why + ") — работает прежняя, Winger подождёт следующую")
		return
	}
	f.mu.Lock()
	if f.busyUpdate() { // another check got here first
		f.mu.Unlock()
		return
	}
	info.Checked, info.State = time.Now().Unix(), "downloading"
	f.Update, f.updAt = info, time.Now()
	f.mu.Unlock()
	Logf("update: version %s found, downloading", info.Name)
	path, err := f.download(updateClient(port, 0), updateURL(host, "winger-win.exe"), info.SHA256)
	f.mu.Lock()
	if err != nil {
		f.Update.State = "failed: " + err.Error()
		f.mu.Unlock()
		Logf("update: %v", err)
		return
	}
	now := make(chan struct{}, 1)
	f.Update.State, f.updAt, f.updNow = "waiting", time.Now(), now
	f.mu.Unlock()
	if !asked {
		Logf("update: %s downloaded, waiting for a quiet minute", info.Name)
		f.waitQuiet(now)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Update.State, f.updAt, f.updNow = "ready", time.Now(), nil
	Logf("update: installing %s", info.Name)
	if err := applyUpdate(path); err != nil {
		f.Update.State = "failed: " + err.Error()
		Logf("update: %v", err)
	}
}

// badUpdate: the version that did not run on this computer and was put back (its code and why), 0 when none. Kept in
// the folder --replace keeps the earlier program in (only SYSTEM and Administrators write there).
func badUpdate(dir string) (int, string) {
	var bad struct {
		Code int    `json:"code"`
		Why  string `json:"why"`
	}
	b, err := os.ReadFile(filepath.Join(dir, "rollback", "bad.json"))
	if err != nil || json.Unmarshal(b, &bad) != nil {
		return 0, ""
	}
	return bad.Code, bad.Why
}

func markBadUpdate(dir string, code int, why string) {
	b, _ := json.Marshal(map[string]any{"code": code, "why": why, "at": time.Now().Unix()})
	_ = os.WriteFile(filepath.Join(dir, "rollback", "bad.json"), b, 0o644)
}

// waitQuiet: until a minute with the VPN off or next to nothing through it (under 20 KB/s), or the person asks for the
// update now; a day at most.
func (f *Family) waitQuiet(now <-chan struct{}) {
	quiet, last := 0, f.eng.Moved()
	for end := time.Now().Add(24 * time.Hour); quiet < 4 && time.Now().Before(end); {
		select {
		case <-now:
			return
		case <-time.After(quietEvery):
		}
		moved := f.eng.Moved()
		rate := float64(moved-last) / quietEvery.Seconds()
		last = moved
		if f.eng.Status().Phase != "on" || rate < 20<<10 {
			quiet++
		} else {
			quiet = 0
		}
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

// Stuck tells the family server this laptop's bridge of a service is in its call but the server's side does not answer:
// the server restarts that bridge's own program (its call is kept, so the link stays). Past the VPN first (the bridge is
// what does not work), then through it; at most once in 10 minutes for a service (the server keeps the same limit).
func (f *Family) Stuck(platform, why string) {
	f.mu.Lock()
	if f.stuckAt == nil {
		f.stuckAt = map[string]time.Time{}
	}
	if t, ok := f.stuckAt[platform]; ok && time.Since(t) < 10*time.Minute {
		f.mu.Unlock()
		return
	}
	f.stuckAt[platform] = time.Now()
	f.mu.Unlock()
	host, auth := f.st.HomeHost()
	if host == "" || auth == "" {
		return
	}
	if len(why) > 160 {
		why = why[:160]
	}
	b, _ := json.Marshal(map[string]string{"auth": auth, "device": "laptop", "platform": platform, "why": Mask(why)})
	for _, port := range []int{0, f.eng.ProbePort()} {
		r, err := client(port, 25*time.Second).Post("https://"+host+":8443/api/winger_stuck", "application/json", bytes.NewReader(b))
		if err != nil {
			Logf("bridge %s: telling the server it is stuck: %v", platform, err)
			continue
		}
		said, _ := io.ReadAll(io.LimitReader(r.Body, 512))
		r.Body.Close()
		Logf("bridge %s: the server was told it is stuck (%s) — %d %s", platform, why, r.StatusCode, strings.TrimSpace(string(said)))
		return
	}
}

// SendJournal sends the newest part of this laptop's journal to the family server (now, or at most every half hour): it
// keeps it apart from the phone's, days of it, only from the owner's own laptop line; nothing secret is in it (masked).
func (f *Family) SendJournal(now bool) {
	f.mu.Lock()
	if !now && time.Since(f.journalAt) < 30*time.Minute {
		f.mu.Unlock()
		return
	}
	f.journalAt = time.Now()
	f.mu.Unlock()
	_, auth := f.st.HomeHost()
	text := JournalTail(96 << 10)
	if auth == "" || text == "" {
		return
	}
	var out struct {
		OK bool `json:"ok"`
	}
	f.post("/api/winger_log", map[string]string{"auth": auth, "log": text, "kind": "laptop", "device": "Windows",
		"app": versionName}, &out)
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
			go f.CheckUpdate(false) // a new version may wait for a quiet minute: the bridges are not held up meanwhile
		case f.Preparing() || !f.hasBridge() && time.Since(lastBridges) >= 20*time.Minute:
			lastBridges = time.Now()
			f.SyncBridges(0)
		}
		f.SendJournal(false)
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
