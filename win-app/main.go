// Winger for Windows: the family's VPN on a computer — the family server over Hysteria2, or a bridge through a call
// service when the server does not answer; the same logic as Winger on the phone. A Windows service does the work
// (the virtual interface needs the system's rights); the window and the tray icon run as the person.
package main

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

var (
	versionName    = "1.0.0-dev"
	versionCodeStr = "0"
	versionCode, _ = strconv.Atoi(versionCodeStr)
)

func main() {
	mode := ""
	if len(os.Args) > 1 {
		mode = os.Args[1]
	}
	switch mode {
	case "--serve": // in the foreground (development and the tests): --serve [--no-tun]
		tun := !(len(os.Args) > 2 && os.Args[2] == "--no-tun")
		exit(serve(tun, nil))
	case "--selftest":
		exit(selftest(os.Args[2:]))
	default:
		exit(platformMain(mode, os.Args[2:]))
	}
}

func exit(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// serve: the engine, the family server's loop and the window's API; stop closes it all (the VPN goes off with it,
// but «on after a restart» stays as the person left it).
func serve(tun bool, stop <-chan struct{}) error {
	dir := dataDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	OpenJournal(dir)
	Logf("Winger %s starts", versionName)
	st := OpenStore(dir)
	relay, err := relayPath(dir)
	if err != nil {
		Logf("bridge program: %v", err)
	}
	eng := NewEngine(st, dir, relay, straight(), tun)
	fam := &Family{st: st, eng: eng, dataDir: dir}
	eng.fam = fam
	go fam.Loop()
	if st.Get().KeepOn {
		_ = eng.Connect()
	}
	srv := &http.Server{Addr: "127.0.0.1:" + itoa(uiPort), Handler: API(eng, fam, st, UIToken(dir)),
		ReadHeaderTimeout: 10 * time.Second}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	select {
	case err := <-errc:
		eng.Shutdown()
		return err
	case <-stop:
		eng.Shutdown()
		_ = srv.Close()
		return nil
	}
}

// straight: programs whose traffic never enters the virtual interface — this program's own files, plus (tests only)
// WINGER_DIRECT's list: the tests' server runs on the same machine and must reach the internet by itself.
func straight() []string {
	names := ownNames()
	for _, n := range strings.Split(strings.ToLower(os.Getenv("WINGER_DIRECT")), ",") {
		if n = strings.TrimSpace(n); n != "" {
			names = append(names, n)
		}
	}
	return names
}

// selftest (CI): connects with this link and keeps the VPN on; meanwhile other programs' pages must go through the
// virtual interface. --selftest <link> [--only a.exe,b.exe] [--hold seconds] [-- check-program args…]
func selftest(args []string) error {
	if len(args) < 1 {
		return fmt.Errorf("--selftest <ссылка> [--only a.exe] [--hold секунд] [-- программа проверки…]")
	}
	link, only, hold, check := args[0], "", 0, []string(nil)
	for i := 1; i < len(args); i++ {
		switch {
		case args[i] == "--only" && i+1 < len(args):
			only, i = args[i+1], i+1
		case args[i] == "--hold" && i+1 < len(args):
			hold, _ = strconv.Atoi(args[i+1])
			i++
		case args[i] == "--":
			check, i = args[i+1:], len(args)
		}
	}
	dir, _ := os.MkdirTemp("", "winger-test")
	os.Setenv("WINGER_DATA", dir)
	OpenJournal(dir)
	st := OpenStore(dir)
	p, err := ParseLink(link)
	if err != nil {
		return err
	}
	st.Add(p, true)
	if only != "" {
		st.Update(func(s *Settings) { s.OnlyApps, s.Apps = true, strings.Split(strings.ToLower(only), ",") })
	}
	relay, _ := relayPath(dir)
	eng := NewEngine(st, dir, relay, straight(), true)
	if err := eng.Connect(); err != nil {
		return err
	}
	defer eng.Shutdown()
	for i := 0; i < 90 && eng.Status().Phase != "on"; i++ {
		time.Sleep(time.Second)
	}
	fmt.Println("phase:", eng.Status().Phase, eng.Status().Note, "ping", eng.Status().PingMs)
	if eng.Status().Phase != "on" {
		fmt.Println(JournalTail(6 << 10))
		return fmt.Errorf("не подключилось")
	}
	if len(check) > 0 {
		out, err := runCheck(check[0], check[1:]...)
		fmt.Println("check:", out)
		if err != nil {
			fmt.Println(JournalTail(6 << 10))
			return fmt.Errorf("проверка не прошла: %v", err)
		}
	}
	if hold > 0 {
		fmt.Println("holding the VPN on for", hold, "s")
		time.Sleep(time.Duration(hold) * time.Second)
	}
	fmt.Println(JournalTail(6 << 10))
	return nil
}

func dataDirFromEnv() string {
	if d := os.Getenv("WINGER_DATA"); d != "" {
		return d
	}
	return ""
}
