# The owner's bridge in Winger

The relay of [whitelist-bypass](https://github.com/kulikov0/whitelist-bypass) (MIT, see `LICENSE`), version 0.4.4:
`relay/`, `go.mod`, `go.sum` as published, with one change of ours in `relay/tunnel/obfuscator.go` (a frame that does
not decrypt — a damaged one or a stray one from the call's server — may no longer announce a restarted peer, which
reset every connection; `obfuscator_epoch_test.go` covers it). The family server's bridge runs the same fix.

`headless/telemost`, `headless/wbstream`, `headless/dion`, `headless/bitrix` are the same version's creators (the
server side of each bridge), unchanged; built with the fixed relay they carry the fix too. The `bridge` workflow
builds them for Linux and publishes them as `bridge-bins-N`; the family server's installer takes a pinned one.

CI builds `librelay.so` from here for each phone ABI (a plain Linux program) and Winger runs it like the Hysteria
client: `--mode telemost-headless-joiner`, then `JOIN:{…}` on its input once it says `STATUS:READY`, answers to its
`RESOLVE:host` questions, and a SOCKS5 port that the VPN tunnel uses. A `winger-bridge://telemost?link=…` link (the
owner's «Управление» → bridge → «📲 Мост в Winger») makes it Winger's server.
