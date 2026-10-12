//go:build windows

package main

import (
	_ "embed"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
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

// openWindow: Winger's window — Edge as an app (no address bar), with a profile of its own; the usual browser when
// there is no Edge. The first start of the service takes a while (the antivirus looks at its new files): waited for.
func openWindow() error {
	for i := 0; i < 180 && !uiAnswers(); i++ {
		time.Sleep(500 * time.Millisecond)
	}
	t := token()
	if t == "" {
		message("Служба Winger не отвечает. Перезагрузите компьютер; не поможет — установите Winger заново.")
		return errStr("нет ключа окна")
	}
	url := uiURL() + "/?t=" + t
	profile := filepath.Join(os.Getenv("LOCALAPPDATA"), "Winger", "window")
	for _, p := range []string{os.Getenv("ProgramFiles(x86)") + `\Microsoft\Edge\Application\msedge.exe`,
		os.Getenv("ProgramFiles") + `\Microsoft\Edge\Application\msedge.exe`,
		os.Getenv("LOCALAPPDATA") + `\Microsoft\Edge\Application\msedge.exe`} {
		if _, err := os.Stat(p); err == nil {
			if exec.Command(p, "--app="+url, "--window-size=470,900", "--user-data-dir="+profile,
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
	req, _ := http.NewRequest(http.MethodPost, uiURL()+"/api/"+path, strings.NewReader("{}"))
	if path == "state" {
		req.Method, req.Body = http.MethodGet, nil
	}
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "wt", Value: token()})
	c := &http.Client{Timeout: 5 * time.Second}
	r, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	return io.ReadAll(io.LimitReader(r.Body, 1<<20))
}

var captchaInState = regexp.MustCompile(`"captcha":"(http://127\.0\.0\.1:[0-9]{2,5}/)"`)

// runTray: the icon by the clock — one per person (a second start just leaves).
func runTray() error {
	name, _ := windows.UTF16PtrFromString(`Local\WingerTray`)
	h, err := windows.CreateMutex(nil, false, name)
	if err == windows.ERROR_ALREADY_EXISTS {
		return nil
	}
	defer windows.CloseHandle(h)
	systray.Run(func() {
		systray.SetIcon(iconOff)
		systray.SetTitle("Winger")
		systray.SetTooltip("Winger")
		open := systray.AddMenuItem("Открыть Winger", "")
		toggle := systray.AddMenuItem("Включить VPN", "")
		systray.AddSeparator()
		quit := systray.AddMenuItem("Убрать значок", "VPN продолжит работать")
		on, shown := false, ""
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
				now := err == nil && strings.Contains(string(b), `"phase":"on"`)
				busy := err == nil && (strings.Contains(string(b), `"phase":"connecting"`) || strings.Contains(string(b), `"phase":"retrying"`))
				if now != on || busy {
					on = now
					if on {
						systray.SetIcon(iconOn)
						systray.SetTooltip("Winger: VPN включён")
						toggle.SetTitle("Выключить VPN")
					} else {
						systray.SetIcon(iconOff)
						systray.SetTooltip(map[bool]string{true: "Winger: подключаюсь…", false: "Winger: выключен"}[busy])
						toggle.SetTitle(map[bool]string{true: "Выключить VPN", false: "Включить VPN"}[busy])
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
					if b, _ := api("state"); strings.Contains(string(b), `"phase":"off"`) {
						_, _ = api("connect")
					} else {
						_, _ = api("disconnect")
					}
				case <-quit.ClickedCh:
					systray.Quit()
				}
			}
		}()
	}, func() {})
	return nil
}
