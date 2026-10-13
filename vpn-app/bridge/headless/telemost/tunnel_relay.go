package main

import (
	"fmt"
	"log"
	"sync"

	"whitelist-bypass/relay/common"
	tmapi "whitelist-bypass/relay/telemost"
	"whitelist-bypass/relay/tunnel"
	"whitelist-bypass/relay/tunnel/rtc"

	"github.com/kulikov0/headless-client/webrtc"
	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
)

const (
	sharingRTPMTU     = 1200
	sharingVP8PT      = 96
	sharingClockRate  = 90000
	sharingStreamSSRC = 0x1a2b3c4d
	defaultSharingFPS = 24
)

type SFURelay struct {
	pubPC        *webrtc.PeerConnection
	subPC        *webrtc.PeerConnection
	pubRemoteSet bool
	subRemoteSet bool
	pubPending   []webrtc.ICECandidateInit
	subPending   []webrtc.ICECandidateInit
	mu           sync.Mutex

	sampleTrack   *webrtc.TrackLocalStaticSample
	tun           *rtc.VP8DataTunnel
	mt            *rtc.MultiTrackTunnel
	delivered     tunnel.DataTunnel
	obf           *tunnel.TunnelObfuscator
	OnConnected   func(tunnel.DataTunnel)
	OnPubReady    func()
	OnPeerRestart func()
	OnPubICE      func(*webrtc.ICECandidate)
	OnSubICE      func(*webrtc.ICECandidate)

	sharingDC   *webrtc.DataChannel
	shareSub    *rtc.VP8DataTunnel // winger: the screenshare track's tunnel, while it is on
	kcpShare    bool               // winger: the joiner keeps a reliable session for it (ConfigKCPEveryTrack)
	shareSyncMu sync.Mutex         // winger: one syncShareSession at a time (the joiner's config, the data channel)

	readBufSize int
	tunFired    bool
}

type sharingDCSink struct {
	dc         *webrtc.DataChannel
	mu         sync.Mutex
	packetizer rtp.Packetizer
	samples    uint32
}

func (r *SFURelay) SetObfuscator(o *tunnel.TunnelObfuscator) { r.obf = o }

func NewSFURelay() *SFURelay {
	return &SFURelay{}
}

func newSharingDCSink(dc *webrtc.DataChannel, fps int) *sharingDCSink {
	if fps <= 0 {
		fps = defaultSharingFPS
	}
	return &sharingDCSink{
		dc: dc,
		packetizer: rtp.NewPacketizer(sharingRTPMTU, sharingVP8PT, sharingStreamSSRC,
			&codecs.VP8Payloader{EnablePictureID: true}, rtp.NewRandomSequencer(), sharingClockRate),
		samples: uint32(sharingClockRate / fps),
	}
}

func (s *sharingDCSink) sendFrame(frame []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, pkt := range s.packetizer.Packetize(frame, s.samples) {
		raw, err := pkt.Marshal()
		if err != nil {
			continue
		}
		if err := s.dc.Send(raw); err != nil {
			return err
		}
	}
	return nil
}

func (r *SFURelay) AddSharingDataChannel() error {
	if r.pubPC == nil {
		return fmt.Errorf("pub PC nil")
	}
	unordered := false
	dc, err := r.pubPC.CreateDataChannel("sharing", &webrtc.DataChannelInit{Ordered: &unordered})
	if err != nil {
		return err
	}
	r.sharingDC = dc
	sink := newSharingDCSink(dc, defaultSharingFPS)
	keyframe := func() []byte {
		return r.obf.EncodeKeepalive(0)
	}
	dc.OnOpen(func() {
		log.Printf("[ss] creator 'sharing' DC open, registering screenshare sub-tunnel")
		sink.sendFrame(keyframe())
		sub := rtc.NewVP8DataTunnelWithQueue(nil, r.obf, log.Printf, rtc.KCPCarrierQueueDepth)
		sub.WriteFrame = sink.sendFrame
		r.addShareSub(sub)
	})
	dc.OnClose(func() { log.Printf("[ss] creator 'sharing' DC closed") })
	dc.OnError(func(e error) { log.Printf("[ss] creator 'sharing' DC error: %v", e) })
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if len(m.Data) >= 2 && m.Data[0]&0xC0 == 0x80 && m.Data[1] >= 200 && m.Data[1] <= 206 {
			if m.Data[1] == 206 {
				sink.sendFrame(keyframe())
			}
		}
	})
	return nil
}

func (r *SFURelay) RemoveSharingDataChannel() {
	r.mu.Lock()
	r.shareSub = nil
	r.mu.Unlock()
	r.syncShareSession() // its reliable session goes before its track
	if r.mt != nil {
		r.mt.RemoveLastSubTunnel()
	}
	if r.sharingDC != nil {
		r.sharingDC.Close()
		r.sharingDC = nil
	}
}

// addShareSub: the sharing data channel is open; its track joins the tunnel.
func (r *SFURelay) addShareSub(sub *rtc.VP8DataTunnel) {
	if r.mt == nil {
		return
	}
	r.mt.AddSubTunnel(sub)
	r.mu.Lock()
	r.shareSub = sub
	r.mu.Unlock()
	r.syncShareSession()
	log.Printf("[ss] screenshare sub-tunnel live, tracks=%d", r.mt.SubTunnelCount())
}

// SetKCPOnShare: the joiner says it keeps a reliable session for the screenshare track (or, an older one, does not).
func (r *SFURelay) SetKCPOnShare(on bool) {
	r.mu.Lock()
	r.kcpShare = on
	r.mu.Unlock()
	r.syncShareSession()
}

// syncShareSession (winger): the reliable layer carries data on the screenshare track too — doubling what the joiner
// downloads — only while that track is on and the joiner has a session for it; an older joiner would drop it. The
// joiner's config (resent until acknowledged) and the data channel's opening come on different goroutines: one at a
// time, or both would add a session and the second (a third conv) is one the joiner does not have. The session is
// probed: the call forwards the screenshare to the joiner only once the joiner's slot for it is bound (by polling,
// seconds later, or never), and until the joiner answers on it no connection goes there; should the joiner stop
// answering, the connections on it are closed and new ones keep to the camera track.
func (r *SFURelay) syncShareSession() {
	r.shareSyncMu.Lock()
	defer r.shareSyncMu.Unlock()
	r.mu.Lock()
	kcptun, _ := r.delivered.(*rtc.MultiTrackKCPTunnel)
	want := r.kcpShare && r.shareSub != nil
	sub := r.shareSub
	r.mu.Unlock()
	if kcptun == nil {
		return
	}
	have := kcptun.SessionCount() > 1
	switch {
	case want && !have:
		// the probe: "your config is taken", which every joiner's relay takes as nothing new
		kcptun.AddProbedSession(sub, tunnel.EncodeFrame(tunnel.ControlConnID, tunnel.MsgConfigAck, nil))
		log.Printf("[ss] reliable session on the screenshare track, in use once the joiner answers on it")
	case !want && have:
		kcptun.RemoveLastSession()
		log.Printf("[ss] reliable data on the camera track only")
	}
}

func (r *SFURelay) Init(iceServers []webrtc.ICEServer) error {
	config := webrtc.Configuration{ICEServers: iceServers}

	pubPC, err := tmapi.NewPeerConnection(config)
	if err != nil {
		return err
	}
	r.pubPC = pubPC

	sampleTrack, _ := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8},
	)
	r.sampleTrack = sampleTrack

	audioTrack, _ := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus},
	)
	pubPC.AddTransceiverFromTrack(audioTrack, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	videoTr, _ := pubPC.AddTransceiverFromTrack(sampleTrack, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if videoTr != nil {
		go rtc.DrainSenderRTCP(videoTr.Sender())
	}

	pubPC.OnICECandidate(func(cand *webrtc.ICECandidate) {
		if cand == nil || r.OnPubICE == nil {
			return
		}
		r.OnPubICE(cand)
	})

	pubPC.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("[pub] connection state: %s", state.String())
		if state == webrtc.PeerConnectionStateConnected {
			if r.tun == nil {
				log.Println("[relay] starting VP8 publish tunnel on pub PC connected")
				r.tun = rtc.NewVP8DataTunnelWithQueue(r.sampleTrack, r.obf, log.Printf, rtc.KCPCarrierQueueDepth)
				r.tun.AnswerKeyframeRequests() // winger: as the screenshare track below already does
				r.tun.Start(0, 0)
				r.tunFired = false
				r.mt = rtc.NewMultiTrackTunnel([]*rtc.VP8DataTunnel{r.tun})
				r.mt.SetOnData(func(payload []byte) { r.activate(r.mt, payload) })
			}
			if r.OnPubReady != nil {
				r.OnPubReady()
			}
		}
	})

	subPC, err := tmapi.NewPeerConnection(config)
	if err != nil {
		pubPC.Close()
		return err
	}
	r.subPC = subPC

	subPC.OnICECandidate(func(cand *webrtc.ICECandidate) {
		if cand == nil || r.OnSubICE == nil {
			return
		}
		r.OnSubICE(cand)
	})

	subPC.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("[sub] connection state: %s", state.String())
	})

	subPC.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		log.Printf("[sub] remote track: %s", track.Codec().MimeType)
		go r.readTrack(track)
	})

	log.Printf("[relay] pub+sub PCs created (%d ICE servers)", len(iceServers))
	return nil
}

func (r *SFURelay) activate(mt *rtc.MultiTrackTunnel, payload []byte) {
	r.mu.Lock()
	if r.tunFired {
		r.mu.Unlock()
		return
	}
	r.tunFired = true
	r.mu.Unlock()

	var delivered tunnel.DataTunnel = mt
	useKCP := false
	if !tunnel.LooksLikeRelayFrame(payload) {
		kcptun := rtc.NewMultiTrackKCPTunnel(mt, log.Printf)
		for kcptun.SessionCount() > 1 { // winger: the screenshare track's session only once this joiner says it has one
			kcptun.RemoveLastSession()
		}
		delivered = kcptun
		useKCP = true
		log.Println("[relay] per-track kcp reliability active over video tunnel")
	}
	log.Printf("[relay] auto-detected active tunnel: %T", delivered)
	r.mu.Lock()
	r.delivered = delivered
	r.mu.Unlock()
	if r.OnConnected != nil {
		r.OnConnected(delivered)
	}
	if useKCP {
		if kcptun, ok := delivered.(*rtc.MultiTrackKCPTunnel); ok {
			kcptun.InjectSegment(payload)
			// winger: speak first on the new tunnel. This relay may be new under a joiner that kept its tunnel (the
			// call connection came back: initRelay), whose reliable sessions are far past where these start; neither
			// side would ever take the other's segments, and a joiner that is past a window of them hears nothing back
			// at all. A frame of this epoch tells it the creator started afresh (it reconnects as a new joiner); an
			// empty config is what every joiner's relay takes as nothing.
			kcptun.SendData(tunnel.EncodeFrame(tunnel.ControlConnID, tunnel.MsgConfig, nil))
		}
	} else {
		mt.DeliverData(payload)
	}
}

func (r *SFURelay) resetForNewPeer() {
	r.mu.Lock()
	r.tunFired = false
	r.kcpShare = false // a new joiner says anew what it keeps
	mt := r.mt
	old := r.delivered
	r.delivered = nil
	r.mu.Unlock()
	if kcp, ok := old.(*rtc.MultiTrackKCPTunnel); ok {
		kcp.StopLayer()
	}
	if mt != nil {
		mt.SetOnData(func(payload []byte) { r.activate(mt, payload) })
	}
}

func (r *SFURelay) CreatePubOffer() (webrtc.SessionDescription, error) {
	offer, err := r.pubPC.CreateOffer(nil)
	if err != nil {
		return offer, err
	}
	if err := r.pubPC.SetLocalDescription(offer); err != nil {
		return offer, err
	}
	offer.SDP = tmapi.MungeSDPAddVideoContent(offer.SDP)
	return offer, nil
}

func (r *SFURelay) SetPubAnswer(sdp string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	err := r.pubPC.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer, SDP: sdp,
	})
	if err != nil {
		return err
	}
	r.pubRemoteSet = true
	for _, cand := range r.pubPending {
		r.pubPC.AddICECandidate(cand)
	}
	r.pubPending = nil
	return nil
}

func (r *SFURelay) SetSubOffer(sdp string) (webrtc.SessionDescription, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	err := r.subPC.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer, SDP: sdp,
	})
	if err != nil {
		return webrtc.SessionDescription{}, err
	}
	r.subRemoteSet = true
	for _, cand := range r.subPending {
		r.subPC.AddICECandidate(cand)
	}
	r.subPending = nil

	answer, err := r.subPC.CreateAnswer(nil)
	if err != nil {
		return answer, err
	}
	r.subPC.SetLocalDescription(answer)
	return answer, nil
}

func (r *SFURelay) AddPubICECandidate(cand webrtc.ICECandidateInit) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.pubRemoteSet {
		r.pubPending = append(r.pubPending, cand)
		return
	}
	r.pubPC.AddICECandidate(cand)
}

func (r *SFURelay) AddSubICECandidate(cand webrtc.ICECandidateInit) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.subRemoteSet {
		r.subPending = append(r.subPending, cand)
		return
	}
	r.subPC.AddICECandidate(cand)
}

func (r *SFURelay) CreatePubRenegotiate() (webrtc.SessionDescription, error) {
	offer, err := r.pubPC.CreateOffer(&webrtc.OfferOptions{ICERestart: false})
	if err != nil {
		return offer, err
	}
	err = r.pubPC.SetLocalDescription(offer)
	if err != nil {
		return offer, err
	}
	offer.SDP = tmapi.MungeSDPAddVideoContent(offer.SDP)
	r.mu.Lock()
	r.pubRemoteSet = false
	r.pubPending = nil
	r.mu.Unlock()
	return offer, nil
}

func (r *SFURelay) Close() {
	if r.tun != nil {
		r.tun.Stop()
		r.tun = nil
	}
	if r.pubPC != nil {
		r.pubPC.Close()
		r.pubPC = nil
	}
	if r.subPC != nil {
		r.subPC.Close()
		r.subPC = nil
	}
}

func (r *SFURelay) readTrack(track *webrtc.TrackRemote) {
	if track.Codec().MimeType != webrtc.MimeTypeVP8 {
		buf := make([]byte, common.UDPBufSize)
		for {
			if _, _, err := track.Read(buf); err != nil {
				return
			}
		}
	}

	var vp8Pkt codecs.VP8Packet
	var frameBuf []byte
	var lastSeq uint16
	var haveLastSeq bool
	frameValid := false
	var recvCount int
	bufSz := r.readBufSize
	if bufSz <= 0 {
		bufSz = common.RTPBufSize
	}
	buf := make([]byte, bufSz)
	for {
		n, _, err := track.Read(buf)
		if err != nil {
			return
		}
		pkt := &rtp.Packet{}
		if pkt.Unmarshal(buf[:n]) != nil {
			continue
		}
		if haveLastSeq && pkt.SequenceNumber != lastSeq+1 {
			frameValid = false
			frameBuf = frameBuf[:0]
		}
		lastSeq = pkt.SequenceNumber
		haveLastSeq = true

		vp8Payload, err := vp8Pkt.Unmarshal(pkt.Payload)
		if err != nil {
			frameValid = false
			frameBuf = frameBuf[:0]
			continue
		}
		if vp8Pkt.S == 1 {
			frameBuf = frameBuf[:0]
			frameValid = true
		}
		if !frameValid {
			continue
		}
		frameBuf = append(frameBuf, vp8Payload...)
		if !pkt.Marker {
			continue
		}
		recvCount++
		if common.Debug && (recvCount <= 3 || recvCount%200 == 0) {
			log.Printf("[video] recv vp8 frame #%d %d bytes", recvCount, len(frameBuf))
		}

		r.handleVideoFrame(frameBuf)
		frameBuf = frameBuf[:0]
		frameValid = false
	}
}

// handleVideoFrame: one whole frame of the joiner's track. A new joiner (a new epoch) starts the tunnel afresh.
func (r *SFURelay) handleVideoFrame(frame []byte) {
	res := r.obf.Decode(frame)
	if !res.HasFrame || res.SelfEcho {
		return
	}
	if res.PeerRestart {
		log.Printf("[video] peer restart detected, new epoch=0x%08x", res.PeerEpoch)
		r.resetForNewPeer()
		if r.OnPeerRestart != nil {
			r.OnPeerRestart()
		}
	}
	if res.Keepalive || len(res.Payload) == 0 {
		return
	}
	if r.tun != nil && r.tun.OnData != nil {
		r.tun.OnData(res.Payload)
	}
}
