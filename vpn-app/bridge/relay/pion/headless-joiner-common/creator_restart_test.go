package joiner

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"whitelist-bypass/relay/tunnel"
	"whitelist-bypass/relay/tunnel/rtc"
)

// winger: a frame of a new creator epoch on the reliable tunnel (the creator's relay started afresh under this joiner,
// and a newer creator speaks first on its new tunnel) makes the Telemost joiner reconnect as a new joiner, once; the
// creator's frames as before do not (headless/telemost TestCreatorRestartJoinerNotices: the rest of the way).
func TestTelemostReconnectsWhenCreatorStartsAfresh(t *testing.T) {
	logs := make(chan string, 64)
	j := NewTelemostHeadlessJoiner(func(f string, a ...any) {
		select {
		case logs <- fmt.Sprintf(f, a...):
		default:
		}
	}, nil, nil, nil, nil, nil)
	secret := tunnel.DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/5656565656")
	jobf, _ := tunnel.NewTunnelObfuscator(secret)
	creator, _ := tunnel.NewTunnelObfuscator(secret)
	restarted, _ := tunnel.NewTunnelObfuscator(secret)
	pub := rtc.NewVP8DataTunnel(nil, jobf, func(string, ...any) {})
	mt := rtc.NewMultiTrackTunnel([]*rtc.VP8DataTunnel{pub})
	kcpTun := rtc.NewMultiTrackKCPTunnel(mt, nil)
	defer kcpTun.StopLayer()
	j.watchCreatorRestart(mt, kcpTun)

	reconnects := func(within time.Duration) int {
		n := 0
		deadline := time.After(within)
		for {
			select {
			case line := <-logs:
				if strings.Contains(line, "reconnecting as a new joiner") {
					n++
				}
			case <-deadline:
				return n
			}
		}
	}
	for i := 0; i < 3; i++ {
		pub.HandleFrame(creator.EncodeData([]byte{1}))
	}
	if n := reconnects(300 * time.Millisecond); n != 0 {
		t.Fatalf("the creator's own frames made the joiner reconnect (%d)", n)
	}
	for i := 0; i < 3; i++ {
		pub.HandleFrame(restarted.EncodeData([]byte{1}))
		pub.HandleFrame(creator.EncodeData([]byte{1})) // a late frame of the old relay
	}
	if n := reconnects(500 * time.Millisecond); n != 1 {
		t.Fatalf("the creator's new epoch made the joiner reconnect %d times, want once", n)
	}
}
