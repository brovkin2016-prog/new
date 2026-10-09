//go:build windows

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\Winger`

func platformMain(mode string, args []string) error {
	switch mode {
	case "--service":
		return runService()
	case "--tray":
		return runTray()
	case "--install":
		err := install()
		if err != nil {
			message("Winger не установился: " + err.Error())
		}
		return err
	case "--uninstall":
		return uninstall()
	case "--replace":
		if len(args) < 1 {
			return errors.New("--replace <куда>")
		}
		return replace(args[0])
	case "--open", "":
		return openApp()
	}
	return fmt.Errorf("неизвестно: %s", mode)
}

// openApp: what a click on Winger does — install it once (one «allow» from Windows), then the tray icon and the window.
func openApp() error {
	self, _ := os.Executable()
	if !serviceInstalled() || !strings.EqualFold(filepath.Clean(self), filepath.Clean(installedExe())) && newerThanInstalled(self) {
		if err := elevate(self, "--install"); err != nil {
			message("Чтобы Winger мог включать VPN, Windows один раз спросит разрешение. Запустите Winger ещё раз и нажмите «Да».")
			return err
		}
	}
	startTray()
	return openWindow()
}

// newerThanInstalled: this file is another one than the installed (a new download): install it over.
func newerThanInstalled(self string) bool {
	a, err1 := os.ReadFile(self)
	b, err2 := os.ReadFile(installedExe())
	return err1 != nil || err2 != nil || len(a) != len(b) || string(a) != string(b)
}

func serviceInstalled() bool {
	m, err := mgr.Connect()
	if err != nil {
		// without the rights to look: the service answers on its port when it is there
		return uiAnswers()
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return false
	}
	s.Close()
	return true
}

// elevate runs this program with the system's rights (Windows asks the person once) and waits for it.
func elevate(exe string, arg string) error {
	ps := fmt.Sprintf("$p = Start-Process -FilePath '%s' -ArgumentList '%s' -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
		strings.ReplaceAll(exe, "'", "''"), arg)
	cmd := exec.Command("powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps)
	hideWindow(cmd)
	if err := cmd.Run(); err != nil {
		return errDeclined
	}
	return nil
}

func install() error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("нет прав администратора: %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err == nil {
		stopService(s)
	}
	if err := os.MkdirAll(installDir(), 0o755); err != nil {
		return err
	}
	if !strings.EqualFold(filepath.Clean(self), filepath.Clean(installedExe())) {
		if err := copyFile(self, installedExe()); err != nil {
			return fmt.Errorf("не скопировался: %w", err)
		}
	}
	if s == nil {
		s, err = m.CreateService(serviceName, installedExe(), mgr.Config{DisplayName: "Winger VPN",
			Description: "VPN семьи: сервер или мост, когда сервер не отвечает", StartType: mgr.StartAutomatic}, "--service")
		if err != nil {
			return fmt.Errorf("служба не создалась: %w", err)
		}
	}
	defer s.Close()
	_ = s.SetRecoveryActions([]mgr.RecoveryAction{{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second}, {Type: mgr.ServiceRestart, Delay: 30 * time.Second}}, 86400)
	if err := s.Start(); err != nil {
		return fmt.Errorf("служба не запустилась: %w", err)
	}
	// the tray icon for everyone at sign-in, Winger in the Start menu and in «Apps» (to remove it)
	if k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE); err == nil {
		_ = k.SetStringValue("WingerTray", `"`+installedExe()+`" --tray`)
		k.Close()
	}
	if k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, uninstallKey, registry.SET_VALUE); err == nil {
		_ = k.SetStringValue("DisplayName", "Winger VPN")
		_ = k.SetStringValue("DisplayVersion", versionName)
		_ = k.SetStringValue("Publisher", "Семья")
		_ = k.SetStringValue("DisplayIcon", installedExe())
		_ = k.SetStringValue("UninstallString", `"`+installedExe()+`" --uninstall`)
		_ = k.SetDWordValue("NoModify", 1)
		_ = k.SetDWordValue("NoRepair", 1)
		k.Close()
	}
	shortcut()
	return nil
}

func shortcut() {
	lnk := filepath.Join(os.Getenv("ProgramData"), `Microsoft\Windows\Start Menu\Programs\Winger.lnk`)
	ps := fmt.Sprintf("$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%s');$s.TargetPath='%s';$s.Arguments='--open';$s.IconLocation='%s,0';$s.Description='VPN семьи';$s.Save()",
		lnk, installedExe(), installedExe())
	cmd := exec.Command("powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps)
	hideWindow(cmd)
	_ = cmd.Run()
}

func stopService(s *mgr.Service) {
	st, err := s.Control(svc.Stop)
	for i := 0; err == nil && st.State != svc.Stopped && i < 60; i++ {
		time.Sleep(500 * time.Millisecond)
		st, err = s.Query()
	}
}

func uninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		self, _ := os.Executable()
		return elevate(self, "--uninstall")
	}
	defer m.Disconnect()
	if s, err := m.OpenService(serviceName); err == nil {
		stopService(s)
		_ = s.Delete()
		s.Close()
	}
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, `Software\Microsoft\Windows\CurrentVersion\Run`, registry.SET_VALUE); err == nil {
		_ = k.DeleteValue("WingerTray")
		k.Close()
	}
	_ = registry.DeleteKey(registry.LOCAL_MACHINE, uninstallKey)
	_ = os.Remove(filepath.Join(os.Getenv("ProgramData"), `Microsoft\Windows\Start Menu\Programs\Winger.lnk`))
	// the running file goes a moment later; the settings stay (a new install finds the connections)
	cmd := exec.Command("cmd", "/c", "timeout /t 3 /nobreak >nul & taskkill /im winger.exe /f >nul 2>&1 & rmdir /s /q \""+installDir()+"\"")
	hideWindow(cmd)
	cmd.SysProcAttr.CreationFlags |= windows.DETACHED_PROCESS
	_ = cmd.Start()
	message("Winger удалён.")
	return nil
}

// replace (an update, run by the service): stops the service, puts this file in place of the installed one, starts it.
func replace(target string) error {
	time.Sleep(2 * time.Second)
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return err
	}
	defer s.Close()
	stopService(s)
	self, _ := os.Executable()
	for i := 0; i < 20; i++ {
		if err = copyFile(self, target); err == nil {
			break
		}
		time.Sleep(time.Second)
	}
	if err != nil {
		_ = s.Start()
		return err
	}
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, uninstallKey, registry.SET_VALUE); err == nil {
		_ = k.SetStringValue("DisplayVersion", versionName)
		k.Close()
	}
	return s.Start()
}

// applyUpdate (in the service): the new file, checked, replaces this one from a process of its own.
func applyUpdate(path string) error {
	cmd := exec.Command(path, "--replace", installedExe())
	hideWindow(cmd)
	cmd.SysProcAttr.CreationFlags |= windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP
	return cmd.Start()
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := to + ".new"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	_ = os.Remove(to)
	return os.Rename(tmp, to)
}
