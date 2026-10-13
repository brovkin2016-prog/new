package telemost

import "testing"

func TestBitrateHints(t *testing.T) {
	sdp := "v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\ns=-\r\nb=AS:6000\r\n" +
		"m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n" +
		"m=video 9 UDP/TLS/RTP/SAVPF 96 97\r\nb=TIAS:2500000\r\na=rtpmap:96 VP8/90000\r\n" +
		"a=fmtp:96 max-fr=30; max-fs=3600;x-google-max-bitrate=2500;x-google-min-bitrate=100\r\n" +
		"a=rtpmap:97 rtx/90000\r\na=fmtp:97 apt=96;x-google-max-bitrate=2500\r\n"
	want := "session b=AS:6000, video b=TIAS:2500000, video max-fr=30, video max-fs=3600, video x-google-max-bitrate=2500, video x-google-min-bitrate=100"
	if got := BitrateHints(sdp); got != want {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
	if got := BitrateHints("v=0\nm=video 9 UDP/TLS/RTP/SAVPF 96\na=fmtp:97 apt=96\n"); got != "none" {
		t.Fatalf("got %q, want none", got)
	}
}
