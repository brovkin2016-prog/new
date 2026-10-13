package rtc

import (
	"sync"
	"time"

	"whitelist-bypass/relay/common"

	"github.com/kulikov0/headless-client/webrtc"
	"github.com/pion/rtcp"
)

// winger: the tunnels that answer keyframe requests for their track (AnswerKeyframeRequests), by that track.
var keyframeTargets sync.Map // webrtc.TrackLocal -> *VP8DataTunnel

// winger: how often a tunnel that answers keyframe requests says what the call's server reported about its track.
const senderFeedbackLogEvery = 60 * time.Second

func keyframeTarget(sender *webrtc.RTPSender) *VP8DataTunnel {
	track := sender.Track()
	if track == nil {
		return nil
	}
	if v, ok := keyframeTargets.Load(track); ok {
		return v.(*VP8DataTunnel)
	}
	return nil
}

// senderFeedback (winger): what the call's server said about one sent track: its keyframe requests, the packets it
// asked again (NACK), its bandwidth estimate (REMB) and the loss it saw (receiver reports). Only counted and logged:
// the bandwidth it reports is not obeyed.
type senderFeedback struct {
	keyframeAsks int
	nackPackets  int
	rembBps      float32
	lossFraction uint8
	reports      int
	since        time.Time
}

// note: one compound RTCP packet; true when it asks for a keyframe.
func (f *senderFeedback) note(pkts []rtcp.Packet) bool {
	keyframe := false
	for _, p := range pkts {
		switch p := p.(type) {
		case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
			keyframe = true
			f.keyframeAsks++
		case *rtcp.TransportLayerNack:
			for _, pair := range p.Nacks {
				f.nackPackets += len(pair.PacketList())
			}
		case *rtcp.ReceiverEstimatedMaximumBitrate:
			f.rembBps = p.Bitrate
		case *rtcp.ReceiverReport:
			for _, r := range p.Reports {
				f.lossFraction = r.FractionLost
				f.reports++
			}
		}
	}
	return keyframe
}

func (f *senderFeedback) maybeLog(t *VP8DataTunnel) {
	if time.Since(f.since) < senderFeedbackLogEvery {
		return
	}
	if t.logFn != nil && (f.keyframeAsks > 0 || f.nackPackets > 0 || f.rembBps > 0 || f.reports > 0) {
		t.logFn("vp8tunnel: the call's server over %s: keyframe requests=%d (keyframes sent %d of %d asked in all) nacked packets=%d remb=%.2f Mbit/s last loss=%.1f%%",
			time.Since(f.since).Round(time.Second), f.keyframeAsks, t.keyframeSent.Load(), t.keyframeAsked.Load(),
			f.nackPackets, float64(f.rembBps)/1e6, float64(f.lossFraction)*100/256)
	}
	*f = senderFeedback{since: time.Now()}
}

// DrainSenderRTCP reads what the call's server sends back about a sent track (the NACK responder and the reports
// need it read). winger: when the track's tunnel answers keyframe requests, a PLI or FIR in it asks that tunnel for one.
func DrainSenderRTCP(sender *webrtc.RTPSender) {
	if sender == nil {
		return
	}
	buf := make([]byte, 1500)
	feedback := senderFeedback{since: time.Now()}
	for {
		n, _, err := sender.Read(buf)
		if err != nil {
			return
		}
		target := keyframeTarget(sender)
		if target == nil {
			continue
		}
		pkts, err := rtcp.Unmarshal(buf[:n])
		if err != nil {
			continue
		}
		if feedback.note(pkts) {
			target.RequestKeyframe()
		}
		feedback.maybeLog(target)
	}
}

func DrainTrack(track *webrtc.TrackRemote) {
	if track == nil {
		return
	}
	buf := make([]byte, common.UDPBufSize)
	for {
		if _, _, err := track.Read(buf); err != nil {
			return
		}
	}
}
