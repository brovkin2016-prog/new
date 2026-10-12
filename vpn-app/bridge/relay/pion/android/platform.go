package android

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/kulikov0/headless-client/webrtc"
	"whitelist-bypass/relay/common"
)

var stdinReader = bufio.NewReader(os.Stdin)
var stdinMu sync.Mutex

func ReadStdinLine() (string, error) {
	stdinMu.Lock()
	defer stdinMu.Unlock()
	line, err := stdinReader.ReadString('\n')
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(line), nil
}

// one lookup at a time: the app answers RESOLVE lines in order, so a question and its answer must not interleave
// with another lookup's (two at once could each take the other's address)
var resolveMu sync.Mutex

func RequestResolve(hostname string) (string, error) {
	resolveMu.Lock()
	defer resolveMu.Unlock()
	stdinMu.Lock()
	fmt.Printf("RESOLVE:%s\n", hostname)
	stdinMu.Unlock()
	line, err := ReadStdinLine()
	if err != nil {
		return "", fmt.Errorf("read resolve response: %w", err)
	}
	if line == "" {
		return "", fmt.Errorf("empty resolve for %s", hostname)
	}
	return line, nil
}

type StatusEmitter struct{}

func (StatusEmitter) EmitStatus(status string)   { common.EmitStatus(status) }
func (StatusEmitter) EmitStatusError(msg string) { common.EmitStatusError(msg) }

type PCConfigurer struct{}

func (PCConfigurer) ConfigureSettingEngine(settingEngine *webrtc.SettingEngine) {
	settingEngine.SetNet(&common.AndroidNet{})
}
