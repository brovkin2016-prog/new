//go:build windows

package main

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

//go:embed bin/winger-relay.exe
var relayExe []byte

const serviceName = "Winger"

func dataDir() string {
	if d := dataDirFromEnv(); d != "" {
		return d
	}
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	return filepath.Join(pd, "Winger")
}

func installDir() string {
	pf := os.Getenv("ProgramFiles")
	if pf == "" {
		pf = `C:\Program Files`
	}
	return filepath.Join(pf, "Winger")
}

func installedExe() string { return filepath.Join(installDir(), "winger.exe") }

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}

// ownNames: this program's own files (whatever it is called) — their traffic always goes straight.
func ownNames() []string {
	names := []string{"winger.exe", "winger-relay.exe"}
	if self, err := os.Executable(); err == nil {
		if n := strings.ToLower(filepath.Base(self)); n != "winger.exe" {
			names = append(names, n)
		}
	}
	return names
}

// relayPath: the bridge's program, put next to the data from inside this one (renewed when it changed).
func relayPath(dir string) (string, error) {
	if p := os.Getenv("WINGER_RELAY"); p != "" {
		return p, nil
	}
	bin := filepath.Join(dir, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(bin, "winger-relay.exe")
	want := sha256.Sum256(relayExe)
	if b, err := os.ReadFile(path); err == nil {
		if sha256.Sum256(b) == want {
			return path, nil
		}
	}
	tmp := path + ".new"
	if err := os.WriteFile(tmp, relayExe, 0o755); err != nil {
		return "", err
	}
	_ = os.Remove(path)
	return path, os.Rename(tmp, path)
}

// the system's own programs: never offered in the list of programs
var systemProcs = map[string]bool{"system": true, "registry": true, "smss.exe": true, "csrss.exe": true, "wininit.exe": true,
	"services.exe": true, "lsass.exe": true, "winlogon.exe": true, "svchost.exe": true, "fontdrvhost.exe": true, "dwm.exe": true,
	"conhost.exe": true, "runtimebroker.exe": true, "sihost.exe": true, "taskhostw.exe": true, "ctfmon.exe": true,
	"explorer.exe": true, "searchhost.exe": true, "searchindexer.exe": true, "startmenuexperiencehost.exe": true,
	"shellexperiencehost.exe": true, "textinputhost.exe": true, "dllhost.exe": true, "smartscreen.exe": true,
	"securityhealthsystray.exe": true, "applicationframehost.exe": true, "widgets.exe": true, "lockapp.exe": true,
	"systemsettings.exe": true, "userinit.exe": true, "audiodg.exe": true, "spoolsv.exe": true, "wudfhost.exe": true,
	"winger.exe": true, "winger-relay.exe": true, "msedgewebview2.exe": true, "backgroundtaskhost.exe": true,
	"phoneexperiencehost.exe": true, "crossdeviceresume.exe": true, "memory compression": true, "secure system": true}

// Processes: the programs the person runs now (their session, not the system's).
func Processes() []string {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	seen := map[string]bool{}
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		var session uint32
		if windows.ProcessIdToSessionId(e.ProcessID, &session) != nil || session == 0 {
			continue
		}
		name := strings.ToLower(windows.UTF16ToString(e.ExeFile[:]))
		if name != "" && !systemProcs[name] && strings.HasSuffix(name, ".exe") {
			seen[name] = true
		}
	}
	var out []string
	for n := range seen {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// childJob: the helpers this program starts end with it, however it ends (stopped, killed, crashed) — Windows closes
// the job with the program and ends what is in it.
var (
	childJobOnce sync.Once
	childJob     windows.Handle
)

func ownChild(p *os.Process) {
	if p == nil {
		return
	}
	childJobOnce.Do(func() {
		h, err := windows.CreateJobObject(nil, nil)
		if err != nil {
			return
		}
		info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE}}
		if _, err := windows.SetInformationJobObject(h, windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
			windows.CloseHandle(h)
			return
		}
		childJob = h
	})
	if childJob == 0 {
		return
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(p.Pid))
	if err != nil {
		return
	}
	defer windows.CloseHandle(h)
	if err := windows.AssignProcessToJobObject(childJob, h); err != nil {
		Logf("bridge: not tied to Winger: %v", err)
	}
}

// endLeftRelays: a bridge program left by an earlier Winger (one that was killed before it could end it) holds on to
// its call — ended when the service starts.
func endLeftRelays() {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return
	}
	defer windows.CloseHandle(snap)
	var e windows.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	for err = windows.Process32First(snap, &e); err == nil; err = windows.Process32Next(snap, &e) {
		if !strings.EqualFold(windows.UTF16ToString(e.ExeFile[:]), "winger-relay.exe") {
			continue
		}
		if h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, e.ProcessID); err == nil {
			if windows.TerminateProcess(h, 1) == nil {
				Logf("bridge: ended a bridge program left from before")
			}
			windows.CloseHandle(h)
		}
	}
}

func runCheck(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	hideWindow(cmd)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return strings.TrimSpace(out.String()), err
}

func message(text string) {
	if os.Getenv("WINGER_QUIET") != "" { // the tests: nobody to press «OK»
		Logf("message: %s", text)
		return
	}
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString("Winger")
	_, _ = windows.MessageBox(0, t, c, windows.MB_OK|windows.MB_ICONINFORMATION)
}

var errDeclined = errors.New("установка отменена")

// privateDir: a folder only SYSTEM and Administrators can write to, made afresh (one that was there — perhaps made by an
// ordinary user beforehand, with their own rights — goes first; if it cannot go, nothing is put there)
func privateDir(dir string) error {
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
	if err != nil {
		return err
	}
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return err
	}
	return windows.CreateDirectory(p, &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd})
}
