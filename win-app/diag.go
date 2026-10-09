package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

// The journal: connecting, the bridge's states, response times, errors — to find out why something is slow or does not
// work. Links, keys and addresses are hidden in it, so it can be pasted into a chat.
var (
	journalMu   sync.Mutex
	journalPath string
)

const journalMax = 256 << 10

var masks = []struct {
	re   *regexp.Regexp
	with string
}{
	{regexp.MustCompile(`(?i)(hysteria2|hy2|winger-bridge)://\S+`), "$1://…"},
	{regexp.MustCompile(`(telemost\.yandex\.(?:ru|com)/j/)[0-9A-Za-z_-]*?([0-9A-Za-z_-]{3})\b`), "$1…$2"},
	{regexp.MustCompile(`(?i)%2Fj%2F[0-9A-Za-z_-]+`), "%2Fj%2F…"},
	{regexp.MustCompile(`\b[0-9a-fA-F]{20,}\b`), "…"},
	{regexp.MustCompile(`\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b`), "$1.x.x"},
	{regexp.MustCompile(`("auth"\s*:\s*")[^"]*`), "$1…"},
}

// Mask hides links, keys and addresses.
func Mask(s string) string {
	for _, m := range masks {
		s = m.re.ReplaceAllString(s, m.with)
	}
	return s
}

func OpenJournal(dir string) {
	journalPath = filepath.Join(dir, "journal.log")
}

// Logf writes a line to the journal (masked).
func Logf(format string, a ...any) {
	line := time.Now().Format("02.01 15:04:05") + " " + Mask(fmt.Sprintf(format, a...)) + "\n"
	if journalPath == "" {
		fmt.Print(line)
		return
	}
	journalMu.Lock()
	defer journalMu.Unlock()
	f, err := os.OpenFile(journalPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	_, _ = f.WriteString(line)
	st, _ := f.Stat()
	f.Close()
	if st != nil && st.Size() > journalMax {
		if b, err := os.ReadFile(journalPath); err == nil && len(b) > journalMax/2 {
			b = b[len(b)-journalMax/2:]
			for i, c := range b {
				if c == '\n' {
					b = b[i+1:]
					break
				}
			}
			_ = os.WriteFile(journalPath, b, 0o600)
		}
	}
}

// JournalTail is the newest part of the journal.
func JournalTail(n int) string {
	journalMu.Lock()
	defer journalMu.Unlock()
	b, err := os.ReadFile(journalPath)
	if err != nil {
		return ""
	}
	if len(b) > n {
		b = b[len(b)-n:]
		for i, c := range b {
			if c == '\n' {
				b = b[i+1:]
				break
			}
		}
	}
	return string(b)
}
