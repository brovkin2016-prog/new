package joiner

import (
	"testing"

	"whitelist-bypass/relay/tunnel"
)

// winger: a reconnect (resetSessionState) gives the Telemost joiner a new epoch for the same call and has its config
// go again: the creator takes it as a new joiner and starts its tunnel afresh, as the joiner's new tunnel does. With
// the old epoch the creator's reliable sessions took the new ones' segments as old and nothing got through
// (headless/telemost TestJoinerReconnectStartsAfresh).
func TestTelemostReconnectRenewsEpoch(t *testing.T) {
	j := NewTelemostHeadlessJoiner(func(string, ...any) {}, nil, nil, nil, nil, nil)
	j.joinLink = "https://telemost.yandex.ru/j/7777777777"
	secret := tunnel.DeriveSecretFromJoinLink(j.joinLink)
	first, err := tunnel.NewTunnelObfuscator(secret)
	if err != nil {
		t.Fatal(err)
	}
	j.obf = first
	j.configAck.arm()
	j.configAck.mark()

	j.resetSessionState()

	if j.obf == first || j.obf.LocalEpoch() == first.LocalEpoch() {
		t.Fatalf("the reconnect kept the old epoch 0x%08x", first.LocalEpoch())
	}
	if j.configAck.acknowledged() {
		t.Fatal("the config would not go again after the reconnect")
	}
	creator, _ := tunnel.NewTunnelObfuscator(secret)
	if res := creator.Decode(first.EncodeData([]byte("before"))); !res.HasFrame || res.PeerRestart {
		t.Fatalf("the creator did not take the joiner's first frame: %+v", res)
	}
	res := creator.Decode(j.obf.EncodeData([]byte("after")))
	if !res.HasFrame || !res.PeerRestart || string(res.Payload) != "after" {
		t.Fatalf("the creator does not see a new joiner after the reconnect: %+v", res)
	}
}
