package tunnel

import (
	"crypto/rand"
	"testing"
)

func TestStrayFrameIsNotPeerRestart(t *testing.T) {
	secret := DeriveSecretFromJoinLink("https://telemost.yandex.ru/j/123")
	creator, _ := NewTunnelObfuscator(secret)
	joiner, _ := NewTunnelObfuscator(secret)

	if r := creator.Decode(joiner.EncodeData([]byte("hello"))); r.PeerRestart || string(r.Payload) != "hello" {
		t.Fatalf("first frame: %+v", r)
	}
	// a damaged or foreign frame: right first byte, random rest
	junk := joiner.EncodeData([]byte("payload-for-junk"))
	rand.Read(junk[1:])
	if r := creator.Decode(junk); r.PeerRestart || r.Payload != nil {
		t.Fatalf("junk frame caused a restart: %+v", r)
	}
	ka := joiner.EncodeKeepalive(8)
	rand.Read(ka[1:])
	if r := creator.Decode(ka); r.PeerRestart {
		t.Fatalf("junk keepalive caused a restart: %+v", r)
	}
	if r := creator.Decode(joiner.EncodeData([]byte("again"))); r.PeerRestart || string(r.Payload) != "again" {
		t.Fatalf("real frame after junk: %+v", r)
	}
	// a real restart: the joiner comes back with a new epoch
	joiner2, _ := NewTunnelObfuscator(secret)
	if r := creator.Decode(joiner2.EncodeKeepalive(8)); r.PeerRestart {
		t.Fatalf("keepalive alone must not reset: %+v", r)
	}
	if r := creator.Decode(joiner2.EncodeData([]byte("new"))); !r.PeerRestart || string(r.Payload) != "new" {
		t.Fatalf("new peer not detected: %+v", r)
	}
	if r := creator.Decode(joiner2.EncodeData([]byte("x"))); r.PeerRestart {
		t.Fatalf("restart reported twice: %+v", r)
	}
	// own frames echoed back are ignored
	if r := creator.Decode(creator.EncodeData([]byte("me"))); !r.SelfEcho {
		t.Fatalf("self echo: %+v", r)
	}
}
