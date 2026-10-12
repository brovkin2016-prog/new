package rtc

import (
	"bytes"
	"testing"
	"time"

	"whitelist-bypass/relay/tunnel"
)

// winger: the plain way (no reliable layer: VK's video, Telemost with reliable=0) never throws a frame away, its
// sender waits for room; so a page's request sent while a download runs waits behind everything queued before it. The
// carrier there keeps the old depth: KCPCarrierQueueDepth (room for the reliable layer's bursts) would hold it over a
// second at VK's 24 x 30 frames a second, for no more speed.
func TestPlainWayKeepsShortQueue(t *testing.T) {
	secret := tunnel.DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/3030303030")
	quiet := func(string, ...any) {}
	behindDownload := func(tun *VP8DataTunnel) time.Duration {
		obf, _ := tunnel.NewTunnelObfuscator(secret)
		peer, _ := tunnel.NewTunnelObfuscator(secret)
		tun.obf = obf
		got := make(chan time.Time, 1)
		tun.WriteFrame = func(frame []byte) error {
			if res := peer.Decode(frame); string(res.Payload) == "request" {
				select {
				case got <- time.Now():
				default:
				}
			}
			return nil
		}
		tun.Start(24, 30)
		stop := make(chan struct{})
		defer tun.Stop()
		defer close(stop)
		bulk := bytes.Repeat([]byte{7}, 1000)
		go func() {
			for {
				select {
				case <-stop:
					return
				default:
				}
				tun.SendData(bulk)
			}
		}()
		time.Sleep(300 * time.Millisecond)
		start := time.Now()
		tun.SendData([]byte("request"))
		select {
		case at := <-got:
			return at.Sub(start)
		case <-time.After(5 * time.Second):
			return 5 * time.Second
		}
	}
	plain := behindDownload(NewVP8DataTunnel(nil, nil, quiet))
	deep := behindDownload(NewVP8DataTunnelWithQueue(nil, nil, quiet, KCPCarrierQueueDepth))
	t.Logf("a request behind a download waits %s with the plain queue, %s with the reliable layer's", plain.Round(time.Millisecond), deep.Round(time.Millisecond))
	if plain > 400*time.Millisecond {
		t.Fatalf("a request behind a download waits %s on the plain way", plain.Round(time.Millisecond))
	}
}
