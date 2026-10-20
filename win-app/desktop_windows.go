//go:build windows

package main

import (
	_ "embed"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"fyne.io/systray"
	"golang.org/x/sys/windows"
)

//go:embed winger.ico
var iconOn []byte

//go:embed winger-off.ico
var iconOff []byte

func uiURL() string { return "http://127.0.0.1:" + itoa(uiPort) }

func token() string {
	for i := 0; i < 40; i++ { // the service writes it when it starts
		if b, err := os.ReadFile(filepath.Join(dataDir(), "ui-token")); err == nil && len(strings.TrimSpace(string(b))) >= 32 {
			return strings.TrimSpace(string(b))
		}
		time.Sleep(250 * time.Millisecond)
	}
	return ""
}

func uiAnswers() bool {
	c := &http.Client{Timeout: 2 * time.Second}
	r, err := c.Get(uiURL() + "/")
	if err != nil {
		return false
	}
	r.Body.Close()
	return true
}

// openWindow: Winger's window — Edge as an app (no address bar), with a profile of its own; on a computer without the
// new Edge (an old Windows) Chrome or Yandex Browser the same way; the usual browser only when there is none of them (an
// old Internet Explorer cannot draw the window). The first start of the service takes a while (the antivirus looks at
// its new files): waited for.
func openWindow() error {
	for i := 0; i < 180 && !uiAnswers(); i++ {
		time.Sleep(500 * time.Millisecond)
	}
	t := token()
	if t == "" {
		message("Служба Winger не отвечает. Перезагрузите компьютер; не поможет — установите Winger заново.")
		return errStr("нет ключа окна")
	}
	url := uiURL() + "/?t=" + t + "#win" // the page fits a window so marked into the screen (the mark survives the redirect)
	profile := filepath.Join(os.Getenv("LOCALAPPDATA"), "Winger", "window")
	for _, p := range []string{os.Getenv("ProgramFiles(x86)") + `\Microsoft\Edge\Application\msedge.exe`,
		os.Getenv("ProgramFiles") + `\Microsoft\Edge\Application\msedge.exe`,
		os.Getenv("LOCALAPPDATA") + `\Microsoft\Edge\Application\msedge.exe`,
		os.Getenv("ProgramFiles") + `\Google\Chrome\Application\chrome.exe`,
		os.Getenv("ProgramFiles(x86)") + `\Google\Chrome\Application\chrome.exe`,
		os.Getenv("LOCALAPPDATA") + `\Google\Chrome\Application\chrome.exe`,
		os.Getenv("LOCALAPPDATA") + `\Yandex\YandexBrowser\Application\browser.exe`} {
		if _, err := os.Stat(p); err == nil {
			if exec.Command(p, "--app="+url, "--window-size=500,900", "--user-data-dir="+profile,
				"--no-first-run", "--no-default-browser-check", "--disable-features=Translate").Start() == nil {
				return nil
			}
		}
	}
	if err := exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start(); err != nil {
		message("Не открылось окно Winger: " + err.Error())
		return err
	}
	return nil
}

func startTray() {
	exe := installedExe()
	if _, err := os.Stat(exe); err != nil {
		exe, _ = os.Executable()
	}
	cmd := exec.Command(exe, "--tray")
	hideWindow(cmd)
	_ = cmd.Start()
}

// api: the tray's own call to the service (with the window's key)
func api(path string) ([]byte, error) {
	req := uiRequest(uiURL(), path, token())
	c := &http.Client{Timeout: map[bool]time.Duration{true: 60 * time.Second, false: 5 * time.Second}[path == "rescue"]}
	r, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	b, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err == nil && r.StatusCode != http.StatusOK {
		err = errStr(r.Status)
	}
	return b, err
}

var captchaInState = regexp.MustCompile(`"captcha":"(http://127\.0\.0\.1:[0-9]{2,5}/)"`)

// runTray: the icon by the clock — one per person (a second start just leaves).
func runTray() error {
	name, _ := windows.UTF16PtrFromString(`Local\WingerTray`)
	h, err := windows.CreateMutex(nil, false, name)
	if err == windows.ERROR_ALREADY_EXISTS {
		return nil
	}
	var gone sync.Once
	defer gone.Do(func() { windows.CloseHandle(h) })
	// an update put a new version in: this icon (the old program) gives way to the new program's own — once for that
	// version (should the installed file be another version than the service, no icon starts after icon)
	go func() {
		for {
			time.Sleep(10 * time.Second)
			v, _ := serviceSays()
			if v == "" || v == versionName || os.Getenv("WINGER_TRAY_FOR") == v {
				continue
			}
			gone.Do(func() { windows.CloseHandle(h) })
			cmd := exec.Command(installedExe(), "--tray")
			cmd.Env = append(os.Environ(), "WINGER_TRAY_FOR="+v)
			hideWindow(cmd)
			if err := cmd.Start(); err != nil {
				return // this icon stays
			}
			systray.Quit()
			time.Sleep(5 * time.Second)
			os.Exit(0)
		}
	}()
	systray.Run(func() {
		systray.SetIcon(iconOff)
		systray.SetTitle("Winger")
		systray.SetTooltip("Winger")
		open := systray.AddMenuItem("Открыть Winger", "")
		toggle := systray.AddMenuItem("Включить VPN", "")
		// the phone notification's one tap: to a bridge from the server, to the server from a bridge
		other := systray.AddMenuItem("Через мост", "")
		other.Hide()
		// the owner's only: the family server's rescue console, when the AI app or its «Управление» broke
		rescue := systray.AddMenuItem("Спасение сервера", "Консоль в браузере: починка сервера без приложения")
		rescue.Hide()
		systray.AddSeparator()
		quit := systray.AddMenuItem("Выйти", "VPN выключится, значок уйдёт; снова — ярлык Winger")
		shown, was := "", ""
		var updating time.Time // a new version was being put in: the service's short absence is that, not «off»
		go func() {
			for {
				b, err := api("state")
				// VK's «I am not a robot» page, once per page: the person sees it without opening the window
				if m := captchaInState.FindSubmatch(b); err == nil && m != nil && string(m[1]) != shown {
					shown = string(m[1])
					_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", shown).Start()
				} else if err == nil && m == nil {
					shown = "" // passed: the next check, even on the same page, opens again
				}
				var s struct {
					Status struct {
						Phase  string `json:"phase"`
						Auto   bool   `json:"auto"`
						PingMs int    `json:"ping"`
					} `json:"status"`
					ActiveName string `json:"activeName"`
					Switch     string `json:"switch"`
					Owner      bool   `json:"owner"`
					Update     struct {
						State string `json:"state"`
					} `json:"update"`
				}
				if err != nil || json.Unmarshal(b, &s) != nil {
					s.Status.Phase = "off"
					if time.Since(updating) < 3*time.Minute {
						s.Status.Phase = "updating"
					}
				} else if s.Update.State == "ready" {
					updating = time.Now()
				}
				// as the phone's notification: the connection's name, then «Защищено · отклик N мс» or what it is doing
				tip, title := "Winger: выключен", "Выключить VPN"
				switch s.Status.Phase {
				case "on":
					tip = "Защищено"
					if s.Status.PingMs > 0 {
						tip += " · отклик " + itoa(s.Status.PingMs) + " мс"
					}
					if s.Status.Auto {
						tip += " · сам перешёл: выбранный не отвечал"
					}
				case "connecting":
					tip = "Подключаюсь…"
				case "retrying":
					tip = "Переподключаюсь…"
				case "updating":
					tip = "Winger обновляется — VPN вернётся сам"
				default:
					title = "Включить VPN"
				}
				if s.Status.Phase != "off" && s.ActiveName != "" {
					tip = s.ActiveName + "\n" + tip
				}
				if s.Owner {
					rescue.Show()
				} else {
					rescue.Hide()
				}
				if now := s.Status.Phase + "|" + tip + "|" + s.Switch; now != was {
					was = now
					if s.Status.Phase == "on" {
						systray.SetIcon(iconOn)
					} else {
						systray.SetIcon(iconOff)
					}
					systray.SetTooltip(tip)
					toggle.SetTitle(title)
					if s.Switch != "" {
						other.SetTitle(s.Switch)
						other.Show()
					} else {
						other.Hide()
					}
				}
				time.Sleep(3 * time.Second)
			}
		}()
		go func() {
			for {
				select {
				case <-open.ClickedCh:
					_ = openWindow()
				case <-toggle.ClickedCh:
					// (the service not answering: nothing is switched — once every click here went «off»)
					if b, err := api("state"); err == nil && strings.Contains(string(b), `"phase":"off"`) {
						_, _ = api("connect")
					} else if err == nil {
						_, _ = api("disconnect")
					}
				case <-other.ClickedCh:
					_, _ = api("switch")
				case <-rescue.ClickedCh:
					b, err := api("rescue")
					var out struct {
						URL   string `json:"url"`
						Error string `json:"error"`
					}
					if err == nil && json.Unmarshal(b, &out) == nil && strings.HasPrefix(out.URL, "https://") {
						_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", out.URL).Start()
					} else if out.Error != "" {
						message(out.Error)
					} else {
						message("Спасательная консоль не открылась — Winger не отвечает, попробуйте ещё раз")
					}
				case <-quit.ClickedCh:
					// out of Winger: the VPN off (it does not come back by itself after a restart either), the icon gone
					if b, _ := api("state"); !strings.Contains(string(b), `"phase":"off"`) {
						_, _ = api("disconnect")
					}
					systray.Quit()
				}
			}
		}()
	}, func() {})
	return nil
}
