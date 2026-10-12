package tunnel

import (
	"encoding/binary"
	"time"
)

const (
	MsgConnect    byte = 0x01
	MsgConnectOK  byte = 0x02
	MsgConnectErr byte = 0x03
	MsgData       byte = 0x04
	MsgClose      byte = 0x05
	MsgUDP        byte = 0x06
	MsgUDPReply   byte = 0x07
	MsgConfig     byte = 0x08
	MsgConfigAck  byte = 0x09

	WireHeaderLen = 4 + 1

	configResendPeriod = 3 * time.Second
)

const ControlConnID uint32 = 0

type DataTunnel interface {
	SendData(data []byte)
	SetOnData(fn func([]byte))
	SetOnClose(fn func())
	Reconfigure(fps, batch int)
}

func EncodeVP8Config(fps, batch, trackCount int) []byte {
	if fps < 1 {
		fps = 1
	}
	if batch < 1 {
		batch = 1
	}
	if trackCount < 1 {
		trackCount = 1
	}
	if fps > 0xFFFF {
		fps = 0xFFFF
	}
	if batch > 0xFFFF {
		batch = 0xFFFF
	}
	if trackCount > 0xFFFF {
		trackCount = 0xFFFF
	}
	var payload [6]byte
	binary.BigEndian.PutUint16(payload[0:2], uint16(fps))
	binary.BigEndian.PutUint16(payload[2:4], uint16(batch))
	binary.BigEndian.PutUint16(payload[4:6], uint16(trackCount))
	return EncodeFrame(ControlConnID, MsgConfig, payload[:])
}

// winger: a 7th byte of feature flags after trackCount — older programs read the first six and ignore it.
// ConfigKCPEveryTrack: the joiner keeps a reliable (KCP) session for each of the creator's tracks, so the creator may
// carry reliable data on its second (screenshare) track too; without it a second track would only carry keepalives.
const ConfigKCPEveryTrack byte = 0x01

func EncodeVP8ConfigFlags(fps, batch, trackCount int, flags byte) []byte {
	frame := EncodeVP8Config(fps, batch, trackCount)
	if flags == 0 {
		return frame
	}
	out := append(frame, flags)
	binary.BigEndian.PutUint32(out[0:4], uint32(len(out)-4))
	return out
}

// VP8ConfigFlags: the feature flags of a config payload (0 from older joiners).
func VP8ConfigFlags(payload []byte) byte {
	if len(payload) >= 7 {
		return payload[6]
	}
	return 0
}

func DecodeVP8Config(payload []byte) (fps, batch, trackCount int, ok bool) {
	if len(payload) < 4 {
		return 0, 0, 0, false
	}
	fps = int(binary.BigEndian.Uint16(payload[0:2]))
	batch = int(binary.BigEndian.Uint16(payload[2:4]))
	trackCount = 1
	if len(payload) >= 6 {
		trackCount = int(binary.BigEndian.Uint16(payload[4:6]))
	}
	return fps, batch, trackCount, true
}

func SendVP8ConfigUntilAcked(acked, cancel, stopCh <-chan struct{}, tun DataTunnel, fps, batch, trackCount int, logFn func(string, ...any), logPrefix string) {
	SendVP8ConfigFlagsUntilAcked(acked, cancel, stopCh, tun, fps, batch, trackCount, 0, logFn, logPrefix)
}

func SendVP8ConfigFlagsUntilAcked(acked, cancel, stopCh <-chan struct{}, tun DataTunnel, fps, batch, trackCount int, flags byte, logFn func(string, ...any), logPrefix string) {
	tun.SendData(EncodeVP8ConfigFlags(fps, batch, trackCount, flags))
	ticker := time.NewTicker(configResendPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-acked:
			return
		case <-cancel:
			return
		case <-stopCh:
			return
		case <-ticker.C:
			logFn("%s: resending vp8 config fps=%d batch=%d trackCount=%d, no ack yet",
				logPrefix, fps, batch, trackCount)
			tun.SendData(EncodeVP8ConfigFlags(fps, batch, trackCount, flags))
		}
	}
}

func EncodeFrame(connID uint32, msgType byte, payload []byte) []byte {
	buf := make([]byte, 4+5+len(payload))
	binary.BigEndian.PutUint32(buf[0:4], uint32(5+len(payload)))
	binary.BigEndian.PutUint32(buf[4:8], connID)
	buf[8] = msgType
	copy(buf[9:], payload)
	return buf
}

func LooksLikeRelayFrame(payload []byte) bool {
	if len(payload) < 9 {
		return false
	}
	frameLen := binary.BigEndian.Uint32(payload[0:4])
	return frameLen >= 5 && int(frameLen)+4 <= len(payload)
}

func DecodeFrames(data []byte, cb func(connID uint32, msgType byte, payload []byte)) {
	for len(data) >= 4 {
		frameLen := int(binary.BigEndian.Uint32(data[0:4]))
		if frameLen < 5 || 4+frameLen > len(data) {
			return
		}
		connID := binary.BigEndian.Uint32(data[4:8])
		msgType := data[8]
		payload := data[9 : 4+frameLen]
		cb(connID, msgType, payload)
		data = data[4+frameLen:]
	}
}
