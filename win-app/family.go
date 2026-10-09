package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Family: what the family server gives this computer by the VPN login it has — the bridges meant for it, its own current
// link when the server moved to a new address, and new versions of Winger for Windows.
type Family struct {
	st      *Store
	eng     *Engine
	dataDir string
	mu      sync.Mutex
	Update  UpdateInfo
}

// UpdateInfo is the newest Winger for Windows the family server has.
type UpdateInfo struct {
	Code    int    `json:"code"`
	Name    string `json:"name"`
	SHA256  string `json:"sha256"`
	Notes   string `json:"notes"`
	Checked int64  `json:"checked"`
	State   string `json:"state"` // "", "downloading", "ready", "failed: …"
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

// SyncBridges keeps the bridges meant for this computer; the number of new or changed ones.
func (f *Family) SyncBridges(_ int) int {
	_, auth := f.st.HomeHost()
	if auth == "" {
		return 0
	}
	var out struct {
		Links []string `json:"links"`
	}
	if !f.post("/api/winger_bridge", map[string]string{"auth": auth}, &out) {
		return 0
	}
	n := 0
	for _, l := range out.Links {
		if p, err := ParseLink(l); err == nil && p.Bridge && f.st.Add(p, false) {
			n++
		}
	}
	Logf("bridges from the server: %d, new %d", len(out.Links), n)
	return n
}

// RenewNow: the family server, asked by its name, gives this computer's own current link; when it moved to a new
// address the saved server is renewed in place. The renewed connection, or nil when nothing changed.
func (f *Family) RenewNow(p *Profile) *Profile {
	if p == nil || p.Bridge || p.Auth == "" {
		return nil
	}
	var out struct {
		Link string `json:"link"`
		Hop  string `json:"hop"`
	}
	if !f.post("/api/winger_profile", map[string]string{"auth": p.Auth}, &out) {
		return nil
	}
	main, err := ParseLink(out.Link)
	if err != nil {
		return nil
	}
	hop, _ := ParseLink(out.Hop)
	if !f.st.Renew(p.Auth, main, hop) {
		return nil
	}
	Logf("the family server moved: its link renewed")
	for _, x := range f.st.Profiles() {
		if !x.Bridge && x.Auth == p.Auth && x.Ports == p.Ports {
			return x
		}
	}
	return nil
}

// CheckUpdate asks the family server for a newer Winger for Windows and, when there is one, gets it ready.
func (f *Family) CheckUpdate() {
	host, _ := f.st.HomeHost()
	if host == "" {
		return
	}
	c := client(f.eng.ProbePort(), 30*time.Second)
	r, err := c.Get("https://" + host + ":8443/app/winger-win.json")
	if err != nil {
		Logf("update check: %v", err)
		return
	}
	var info UpdateInfo
	ok := r.StatusCode == 200 && json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&info) == nil
	r.Body.Close()
	f.mu.Lock()
	f.Update.Checked = time.Now().Unix()
	f.mu.Unlock()
	if !ok || info.Code <= versionCode || len(info.SHA256) != 64 {
		return
	}
	f.mu.Lock()
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
	_ = os.MkdirAll(dir, 0o700)
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

// Loop: a minute after the start, then every hour.
func (f *Family) Loop() {
	time.Sleep(time.Minute)
	for {
		f.SyncBridges(0)
		if p := f.st.Chosen(); p != nil && !p.Bridge {
			f.RenewNow(p)
		}
		f.CheckUpdate()
		time.Sleep(time.Hour)
	}
}

func (f *Family) UpdateInfo() UpdateInfo {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Update
}

type errStr string

func (e errStr) Error() string { return string(e) }
