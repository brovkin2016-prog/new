//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

func platformMain(mode string, _ []string) error {
	return errors.New("Winger для Windows: здесь только --serve и --selftest")
}

func dataDir() string {
	if d := dataDirFromEnv(); d != "" {
		return d
	}
	return "winger-data"
}

func hideWindow(*exec.Cmd) {}

func ownNames() []string { return []string{"winger", "winger-relay"} }

// relayPath: the bridge's program (the tests give it).
func relayPath(string) (string, error) {
	if p := os.Getenv("WINGER_RELAY"); p != "" {
		return p, nil
	}
	return "", errors.New("нет программы моста")
}

// Processes: the running programs' names (here, from /proc — for the tests).
func Processes() []string {
	seen := map[string]bool{}
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		if b, err := os.ReadFile(filepath.Join("/proc", e.Name(), "comm")); err == nil {
			seen[strings.TrimSpace(string(b))+".exe"] = true
		}
	}
	var out []string
	for n := range seen {
		out = append(out, n)
	}
	sort.Strings(out)
	if len(out) > 40 {
		out = out[:40]
	}
	return out
}

func applyUpdate(string) error {
	return errors.New("обновление ставится только на Windows")
}

func runCheck(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}
