# Winger VPN («VPN от Бровкина Алексея») — Android app

A one-button VPN for the family server: add the server from a QR code (camera or a picture) or a `hysteria2://` link
(pasted, or tapped in a messenger), press the big button, see the response time and the speed. Nothing else to set.

- The official Hysteria 2 client (`apernet/hysteria`, pinned with its SHA-256) runs as a small program inside the app
  and offers a SOCKS5 port on the phone; `hev-socks5-tunnel` (pinned tag) carries the phone's traffic from the VPN
  interface to it, TCP and UDP. The app itself stays outside the VPN, so the client's own connection never loops.
- The response time is a real request through the tunnel every 20 s; after three misses the client restarts.
- Updates come from the family server named in the link (`/app/vpn.json`, `/app/vpn.apk`), through the tunnel when on.

CI (`.github/workflows/vpn-app.yml`) builds an **unsigned** APK, tests it on an emulator against a real hysteria server
(the phone's own DNS and web traffic must reach the server through the tunnel) and publishes it as a release. The family
server signs it with its own key.
