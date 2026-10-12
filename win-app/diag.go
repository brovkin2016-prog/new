package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
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
	// the bridge program's words: the call (room, its link, the name in it, the key made from it)
	{regexp.MustCompile(`(?i)\b(room|roomid|room_id|alias|peer_id|pid|link|key-source|instance-id|userid|slug|portal)=("[^"]*"|\S+)`), "$1=…"},
	{regexp.MustCompile(`(?i)\b(wbstream|dion)://\S+`), "$1://…"},
}

// webLink: a page's address — its site stays, the rest goes but for the last 3 signs (to tell two calls apart).
var webLink = regexp.MustCompile(`(?i)\b((?:https?|wss?)://[^/\s"'?#]+)([/?#][^\s"']*)`)
var lastSigns = regexp.MustCompile(`([0-9A-Za-z_-]{3})[^0-9A-Za-z_-]*$`)

// Mask hides links, keys and addresses.
func Mask(s string) string {
	for _, m := range masks {
		s = m.re.ReplaceAllString(s, m.with)
	}
	return webLink.ReplaceAllStringFunc(s, func(u string) string {
		m := webLink.FindStringSubmatch(u)
		if m[2] == "/" || strings.HasPrefix(m[2], "/…") {
			return u
		}
		tail := ""
		if t := lastSigns.FindStringSubmatch(m[2]); t != nil {
			tail = t[1]
		}
		return m[1] + "/…" + tail
	})
}

func OpenJournal(dir string) {
	journalPath = filepath.Join(dir, "journal.log")
}

// journalEcho: the self-test (CI) also shows the journal as it goes, so a check cut short still has it.
var journalEcho bool

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
	if journalEcho {
		fmt.Print(line)
	}
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
