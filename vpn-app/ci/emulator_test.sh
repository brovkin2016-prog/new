#!/bin/bash
# Runs inside the emulator: install the app, add the test server from a hysteria2:// link (as a tapped link would),
# switch it on, and check that the phone's own traffic (adb shell, not this app) goes through the tunnel to the server.
set -x
mkdir -p "$OUT"
PKG=app.aihelper.vpn.debug
ACT=$PKG/app.aihelper.vpn.MainActivity
LINK='hysteria2://family:test-pass-123@10.0.2.2:4443/?sni=vpn.test.local&insecure=1#Тест'
step() { echo "$(date +%T) $*" >> "$OUT/progress.txt"; }  # what the test was doing, kept with the release
fail() { echo "FAIL: $*"; echo "::error::$*"; adb logcat -d -s AIVPN:V > "$OUT/logcat.txt"; adb exec-out screencap -p > "$OUT/fail.png"; exit 1; }
# the screen's tree into the file; a system «… isn't responding» window over it (now and then the emulator's own
# launcher) is answered «Wait» first, so the check looks at Winger, not at it
dump() {
  local t xy
  for _ in 1 2 3; do
    adb shell uiautomator dump "$1" >/dev/null 2>&1
    t=$(adb shell cat "$1")
    echo "$t" | grep -qE "isn't responding|не отвечает" || return 0
    xy=$(echo "$t" | grep -oE 'text="(Wait|Подождать)"[^>]*bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | grep -oE '\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]' \
      | head -1 | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\1 \2 \3 \4/' | awk '{print int(($1+$3)/2), int(($2+$4)/2)}')
    [ -n "$xy" ] && adb shell input tap $xy
    sleep 2
  done
}
wait_log() {  # text, seconds
  for _ in $(seq 1 "$2"); do adb logcat -d -s AIVPN:V | grep -q "$1" && return 0; sleep 1; done
  return 1
}

adb install -r -g "$APK" || fail "install"
adb shell appops set $PKG ACTIVATE_VPN allow  # the "allow VPN" question, answered for the test
adb shell dumpsys deviceidle whitelist +$PKG  # (v37) Android's battery saving off for Winger (its own question, answered)
adb logcat -c
adb shell "am start -a android.intent.action.VIEW -d '$LINK' -n $ACT"
sleep 3
adb exec-out screencap -p > "$OUT/1-added.png"
adb shell am start -n $ACT --ez test_auto false --ez test_all true --ez test_connect true  # first everything through the VPN (no going over by itself until its own step)
wait_log "through the \(server\|bridge\): all apps" 60 || fail "not all apps through the VPN"
wait_log "connected via" 60 || fail "no connection to the server"
wait_log "ping [0-9]* ms" 40 || fail "no response time through the tunnel"
sleep 2
adb exec-out screencap -p > "$OUT/2-on.png"

# the phone's own traffic through the tunnel: a web page (TCP) and a plain DNS question over UDP
step "the phone's own traffic through the tunnel: a web page (TCP) and a plain DNS question over"
# (Android itself asks DNS over TLS, i.e. TCP 853, so UDP is checked on purpose)
# stdin stays open a few seconds: toybox nc may quit on its EOF before the answer has come
page() { adb shell "( printf 'GET / HTTP/1.0\r\nHost: example.com\r\n\r\n'; sleep 6 ) | toybox nc -w 15 example.com 80 | head -1"; }
TUNNELED() { grep -cE 'TCP request.*[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:80"' /tmp/t/hy.log; }  # by address: the tunnel's, not the app's pings
B0=$(TUNNELED)
for _ in 1 2 3; do R=$(page); echo "$R" | grep -q "HTTP/1" && break; sleep 2; done
echo "through the VPN: $R"
echo "$R" | grep -q "HTTP/1" || fail "a web page did not come through the VPN"
[ "$(TUNNELED)" -gt "$B0" ] || fail "the page did not go through the tunnel"
sleep 2
N=$(adb shell "( printf '\022\064\001\000\000\001\000\000\000\000\000\000\007example\003com\000\000\001\000\001'; sleep 3 ) | toybox timeout 8 toybox nc -u 8.8.8.8 53 | toybox wc -c" | tr -dc '0-9')
echo "UDP DNS answer through the VPN: ${N:-0} bytes"
grep -E "TCP request|UDP request" /tmp/t/hy.log | grep -v ":443\"" | tail -6
grep -q "TCP request.*:80\"" /tmp/t/hy.log || fail "the server saw no web page through the tunnel"
grep -q "UDP request" /tmp/t/hy.log || fail "the server saw no UDP through the tunnel"
[ "${N:-0}" -gt 20 ] || echo "note: the shell's own UDP test tool gave no answer (the phone's DNS over UDP above is the check)"
curl -s http://127.0.0.1:7653/traffic && echo
sleep 3
adb exec-out screencap -p > "$OUT/3-traffic.png"

# (v37) asleep the connection holds: the screen off, Android's deep sleep (Doze) forced for two minutes — the processor
# kept awake by Winger, the tunnel not reopened, a page through it at once after
step "asleep: the screen off, deep sleep forced, the tunnel holds"
adb logcat -c
adb shell input keyevent KEYCODE_SLEEP
wait_log "screen off: kept awake" 20 || fail "the screen went off but Winger did not keep the connection awake"
# (v37, the review) not only its word: Android itself holds Winger's wake lock now
adb shell dumpsys power | grep -q "winger:tunnel" || fail "the screen went off but no wake lock of Winger's is held"
adb shell dumpsys deviceidle force-idle >/dev/null
sleep 120
adb shell dumpsys deviceidle unforce >/dev/null
B1=$(TUNNELED)
R=$(page)
echo "after two minutes of deep sleep: $R"
echo "$R" | grep -q "HTTP/1" || fail "after deep sleep no page came through the VPN"
[ "$(TUNNELED)" -gt "$B1" ] || fail "after deep sleep the page did not go through the tunnel"
adb logcat -d -s AIVPN:V | grep -E "retry [0-9]|reconnecting" && fail "the tunnel was reopened during deep sleep (it should have held)"
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard >/dev/null 2>&1
echo "asleep: the connection held through two minutes of deep sleep"

# the speed of a connection: the one that is on, through itself
step "the speed of a connection: the one that is on, through itself"
adb shell am start -n $ACT --es test_speed Тест >/dev/null
wait_log "speed: «Тест» [0-9]" 40 || fail "no speed for the connection that is on"
adb logcat -d -s AIVPN:I | grep "speed: «Тест»" | tail -1
adb logcat -d -s AIVPN:I | grep "speed: «Тест»" | tail -1 | grep -qE "speed: «Тест» (0\.0[1-9]|0\.[1-9]|[1-9])" || fail "the speed test downloaded nothing"
adb exec-out screencap -p > "$OUT/3a-speed.png"

# the phone moves between networks (Wi-Fi off and on again): the VPN must stay on — made anew only if the
# connection really broke — and not go round and round reconnecting
step "network changes: Wi-Fi off and on, the VPN stays on"
adb logcat -c
adb shell svc wifi disable; sleep 12
adb shell svc wifi enable; sleep 15
adb logcat -d -s AIVPN:I | grep -E "network changed|connection holds|reconnecting on the new network|connected via|retry" | tee "$OUT/netchange.log"
grep -q "network changed" "$OUT/netchange.log" || echo "note: this emulator did not report a network change"
for _ in 1 2 3; do R=$(page); echo "$R" | grep -q "HTTP/1" && break; sleep 3; done
echo "after the network changes: $R"
echo "$R" | grep -q "HTTP/1" || fail "no page through the VPN after the network changed"
[ "$(grep -c "reconnecting on the new network" "$OUT/netchange.log")" -le 2 ] || fail "the VPN went round reconnecting after the network changed"
grep -q "retry" "$OUT/netchange.log" && fail "a network change counted as a failure (retry)"
echo "network change: the VPN stayed on ($(grep -c 'connection holds' "$OUT/netchange.log") held, $(grep -c 'reconnecting on the new network' "$OUT/netchange.log") made anew)"

adb shell am start -n $ACT --ez test_disconnect true
wait_log "stopped" 20 || fail "did not switch off"
sleep 2
adb exec-out screencap -p > "$OUT/4-off.png"

# and of a connection that is not on: through a short-lived client of its own
step "and of a connection that is not on: through a short-lived client of its own"
adb logcat -c
adb shell am start -n $ACT --es test_speed Тест >/dev/null
wait_log "speed: «Тест» [0-9].*separate test client" 50 || fail "no speed for a connection that is not on"
adb logcat -d -s AIVPN:I | grep "speed: «Тест»" | tail -1

# the bridge's way with names (the tunnel's own DNS answers, the connection carries the name, the far side looks it up):
step "the bridge's way with names (the tunnel's own DNS answers, the connection carries the name"
# tried with the server here, as CI has no real call
adb logcat -c
adb shell am start -n $ACT --ez test_all true --ez test_mapdns true --ez test_connect true
wait_log "connected via" 60 || fail "no connection with names looked up on the far side"
for _ in 1 2 3; do R=$(page); echo "$R" | grep -q "HTTP/1" && break; sleep 2; done
echo "names on the far side: $R"
echo "$R" | grep -q "HTTP/1" || fail "a web page did not come with names looked up on the far side"
grep -q 'TCP request.*example\.com:80"' /tmp/t/hy.log || fail "the name did not reach the server (mapped DNS)"
adb shell am start -n $ACT --ez test_disconnect true
wait_log "stopped" 20 || fail "did not switch off (mapped DNS)"
echo "mapped DNS: the page came, the server got the name itself"
R=$(page)
echo "after switching off (straight to the internet): $R"
adb logcat -d -s AIVPN:V > "$OUT/logcat.txt"
grep -c "hy:" "$OUT/logcat.txt"

# only the chosen apps through the VPN: Chrome (on this emulator, not ticked by default) is chosen; the app must see
step "only the chosen apps through the VPN: Chrome (on this emulator, not ticked by default) is "
# it (Android 11+ hides other apps unless the manifest names them), and the shell's own traffic must then go straight
adb logcat -c
adb shell am start -n $ACT --es test_apps com.android.chrome --ez test_connect true
# (YouTube on this emulator image is ticked by default too: the list must name Chrome, and YouTube shows the app sees them)
step "(YouTube on this emulator image is ticked by default too: the list must name Chrome, and Y"
wait_log "through the \(server\|bridge\): \[.*com\.android\.chrome" 60 || fail "the chosen app did not reach the VPN (is it visible to the app?)"
wait_log "connected via" 60 || fail "no connection with only the chosen apps"
sleep 2
BEFORE=$(TUNNELED)
R=$(page)
echo "only Chrome through the VPN, the shell straight: $R"
sleep 2
AFTER=$(TUNNELED)
[ "$AFTER" = "$BEFORE" ] || fail "the shell's traffic went through the VPN although only Chrome was chosen"
adb exec-out screencap -p > "$OUT/4a-apps.png"
adb shell am start -n $ACT --ez test_disconnect true
wait_log "stopped" 20 || fail "did not switch off (only the chosen apps)"

# any app on the phone can be ticked, not only the known ones: the picker lists them (search «sett» → Settings), and a
step "any app on the phone can be ticked, not only the known ones: the picker lists them (search"
# ticked one (Settings) reaches the VPN
adb logcat -c
adb shell am start -n $ACT --es test_pick sett
wait_log "apps to pick: .*shown [1-9]" 20 || fail "the picker did not list the phone's apps"
adb logcat -d -s AIVPN:I | grep "apps to pick"
sleep 2
dump /sdcard/ui.xml
adb shell cat /sdcard/ui.xml | grep -qE 'text="(Settings|Настройки)"' || fail "the picker does not show Settings"
adb exec-out screencap -p > "$OUT/4a-pick.png"
adb shell input keyevent KEYCODE_BACK
adb shell input keyevent KEYCODE_BACK
adb logcat -c
adb shell am start -n $ACT --es test_apps com.android.settings --ez test_connect true
wait_log "through the \(server\|bridge\): \[.*com\.android\.settings" 60 || fail "an app outside the known list did not reach the VPN"
wait_log "connected via" 60 || fail "no connection with an app outside the known list"
adb shell am start -n $ACT --ez test_disconnect true
wait_log "stopped" 20 || fail "did not switch off (an app outside the known list)"
echo "any app: the picker lists the phone's apps, Settings ticked goes through the VPN"

# on a bridge the AI helper goes through it whatever is ticked (the phone's own way to the family server is most likely
step "on a bridge the AI helper goes through it whatever is ticked"
# shut then); another app stands in for it here, and the bridge's way is tried on the server, as above
AI=$(for p in com.android.contacts com.android.camera2 com.android.documentsui com.android.dialer com.android.calendar; do
  adb shell pm path $p 2>/dev/null | grep -q package: && { echo $p; break; }; done)
[ -n "$AI" ] || fail "no app on this emulator to stand in for the AI helper"
# (a mark in the journal, not «logcat -c»: the clearing does not always take, and an older line must not answer)
mark() { M="mark-$RANDOM$RANDOM"; adb shell log -t AIVPN "$M"; }
since() { adb logcat -d -s AIVPN:V | awk -v m="$M" 'f; index($0, m) {f=1}'; }
wait_since() { for _ in $(seq 1 "$2"); do since | grep -q "$1" && return 0; sleep 1; done; return 1; }
mark
adb shell am start -n $ACT --es test_ai $AI --ez test_mapdns true --ez test_connect true >/dev/null
wait_since "connected via" 60 || fail "no connection on the bridge's way (the AI helper's check)"
since | grep "through the \(server\|bridge\): \[" | tail -1 | grep -q "$AI" || fail "the AI helper did not go through the bridge's way"
since | grep -q "the AI helper goes through the bridge too" || fail "the AI helper's way through the bridge is not in the journal"
mark
adb shell am start -n $ACT --ez test_disconnect true >/dev/null
wait_since "stopped" 20 || fail "did not switch off (the AI helper's way)"
mark
adb shell am start -n $ACT --ez test_connect true >/dev/null
wait_since "connected via" 60 || fail "no connection through the server after the bridge's way"
L=$(since | grep "through the \(server\|bridge\): \[" | tail -1)
[ -n "$L" ] || fail "no tunnel through the server after the bridge's way"
echo "$L" | grep -q "$AI" && fail "the AI helper went through the server although not ticked"
mark
adb shell am start -n $ACT --ez test_disconnect true >/dev/null
wait_since "stopped" 20 || fail "did not switch off (after the AI helper's way)"
echo "AI helper ($AI standing in): through the bridge's way, not through the server unless ticked"

# the journal with a check of the way to the server, copied for a chat when the server is out of reach
step "the journal with a check of the way to the server, copied for a chat"
mark
adb shell am start -n $ACT --es test_ai $AI --ez test_journal true >/dev/null
wait_since "report: Winger" 40 || fail "the journal's report did not come"
since | grep "report: Winger" | tail -1 | tee "$OUT/report.log"
grep -q "ИИ-помощник: установлен" "$OUT/report.log" || fail "the report does not see the AI helper"
grep -q "сеть телефона: Wi-Fi" "$OUT/report.log" || fail "the report does not name the phone's network (Wi-Fi here)"
grep -qE "[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+|hysteria2://" "$OUT/report.log" && fail "the report shows an address or a link"
adb shell am start -n $ACT --es test_ai app.aihelper.family >/dev/null
echo "journal report: $(cut -c1-300 "$OUT/report.log")"

# the AI helper switches Winger on when its server does not answer: Winger connects and gives the screen straight back
step "the AI helper switches Winger on: it connects and gives the screen back"
mark
adb shell am start -n $ACT --ez connect true --ez back true >/dev/null
wait_since "connected via" 60 || fail "Winger did not connect when switched on from outside"
sleep 2
TOP=$(adb shell dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity" | head -2)
echo "on top now: $TOP"
echo "$TOP" | grep -q "$PKG/" && fail "Winger kept the screen although it was asked to give it back"
mark
adb shell am start -n $ACT --ez test_disconnect true >/dev/null
wait_since "stopped" 20 || fail "did not switch off (switched on from outside)"
echo "switched on from outside: connected, the screen given back"

# the family server moved to a new address: the saved server, found by its login, takes the new link in place
step "the family server moved: the saved server takes the new link in place, its name stays"
NEWLINK='hysteria2://family:test-pass-123@10.0.2.2:4443/?sni=vpn.test.local&insecure=1&moved=1#Новое'
mark
adb shell "am start -n $ACT --es test_renew '$NEWLINK'" >/dev/null
wait_since "renew: true · chosen «Тест» true" 20 || fail "the saved server did not take the new link in place (name and choice kept)"
mark
adb shell "am start -n $ACT --es test_renew '$NEWLINK'" >/dev/null
wait_since "renew: false" 20 || fail "the same link again changed something"
mark
adb shell "am start -n $ACT --es test_renew 'hysteria2://stranger:other-pass@10.0.2.2:4443/?sni=vpn.test.local&insecure=1#Чужой'" >/dev/null
wait_since "renew: false · chosen «Тест» true" 20 || fail "a link with another login replaced the saved server"
mark
adb shell am start -n $ACT --ez test_connect true >/dev/null
wait_since "connected via 10.0.2.2" 60 || fail "no connection with the renewed link"
mark
adb shell am start -n $ACT --ez test_disconnect true >/dev/null
wait_since "stopped" 20 || fail "did not switch off (renewed link)"
echo "server moved: the saved server took the new link in place, its name and choice kept; another login changes nothing"

# the server's salamander door («маскировка»): Winger keeps it as one more connection without choosing it, once only,
# and gets through it (the test server's second hysteria, with salamander on 4444)
step "the server's salamander door: kept once as a connection, and Winger gets through it"
DOOR='hysteria2://family:test-pass-123@10.0.2.2:4444/?sni=vpn.test.local&insecure=1&obfs=salamander&obfs-password=Salam-test-0123456789#Маскировка'
mark
adb shell "am start -n $ACT --es test_door '$DOOR'" >/dev/null
wait_since "door: kept true · chosen «Тест»" 20 || fail "the salamander door was not kept (or it took the choice)"
mark
adb shell "am start -n $ACT --es test_door '$DOOR'" >/dev/null
wait_since "door: kept false" 20 || fail "the same door was added twice"
mark
adb shell am start -n $ACT --es test_select Маскировка >/dev/null
sleep 1
adb shell am start -n $ACT --ez test_connect true >/dev/null
wait_since "connected via 10.0.2.2" 60 || fail "no connection through the salamander door"
grep -q "client connected" /tmp/t/hy-obfs.log || fail "the salamander server saw no connection"
mark
adb shell am start -n $ACT --ez test_disconnect true >/dev/null
wait_since "stopped" 20 || fail "did not switch off (salamander door)"
adb shell am start -n $ACT --es test_remove Маскировка >/dev/null  # the steps below count the connections there are
adb shell am start -n $ACT --es test_select Тест >/dev/null
sleep 1
echo "salamander door: kept once, not chosen by itself, connected through it"

# (v37) the server's gecko door (the test server's third hysteria, gecko on 4446): kept once as a connection, beside the
# salamander one, not chosen by itself — and Winger's client speaks it
step "a gecko door (v37): kept once as a connection, Winger connects through it"
GECKO='hysteria2://family:test-pass-123@10.0.2.2:4446/?sni=vpn.test.local&insecure=1&obfs=gecko&obfs-password=Gecko-test-0123456789#Геккон'
mark
adb shell "am start -n $ACT --es test_door '$GECKO'" >/dev/null
wait_since "door: kept true · chosen «Тест»" 20 || fail "the gecko door was not kept (or it took the choice)"
since | grep -q "the server's gecko door kept as a connection" || fail "the gecko door not taken as the gecko one"
mark
adb shell "am start -n $ACT --es test_door '$GECKO'" >/dev/null
wait_since "door: kept false" 20 || fail "the same gecko door was added twice"
adb shell am start -n $ACT --es test_select Геккон >/dev/null
sleep 1
mark
adb shell am start -n $ACT --ez test_connect true >/dev/null
wait_since "connected via 10.0.2.2" 60 || fail "no connection through the gecko door"
grep -q "client connected" /tmp/t/hy-gecko.log || fail "the gecko server saw no connection"
mark
adb shell am start -n $ACT --ez test_disconnect true >/dev/null
wait_since "stopped" 20 || fail "did not switch off (gecko door)"
adb shell am start -n $ACT --es test_remove Геккон >/dev/null  # the steps below count the connections there are
adb shell am start -n $ACT --es test_select Тест >/dev/null
sleep 1
echo "gecko door: connected through it"

# a real update of the app over itself: the next build (version + 1) through the app's own installer, then
step "a real update of the app over itself: the next build (version + 1) through the app's own i"
# Android's «install the update?» answered by a tap — the way a phone gets every update
vcode() { adb shell dumpsys package $PKG | grep -o "versionCode=[0-9]*" | head -1 | tr -dc '0-9'; }
if [ -n "${NEXT_APK:-}" ]; then
  OLD=$(vcode)
  adb push "$NEXT_APK" /data/local/tmp/next.apk
  adb shell "cat /data/local/tmp/next.apk | run-as $PKG sh -c 'mkdir -p cache/update && cat > cache/update/test.apk'"
  adb shell appops set $PKG REQUEST_INSTALL_PACKAGES allow
  adb logcat -c
  adb shell am start -n $ACT --ez test_install true
  NEW=
  for _ in $(seq 1 30); do
    sleep 2
    NEW=$(vcode)
    [ "${NEW:-0}" -gt "${OLD:-0}" ] && break
    adb logcat -d -s AIVPN:V | grep -E "install: |install status [1-7] " && fail "the update did not install"
    dump /sdcard/ui.xml
    B=$(adb shell cat /sdcard/ui.xml | tr '>' '\n' | grep -E 'resource-id="android:id/button1"|text="(Update|Install|UPDATE|INSTALL|Обновить|Установить)"' \
      | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | head -1 | tr -c '0-9' ' ')
    if [ -n "$B" ]; then
      read -r X1 Y1 X2 Y2 <<< "$B"
      adb shell input tap $(((X1 + X2) / 2)) $(((Y1 + Y2) / 2))
    fi
  done
  adb exec-out screencap -p > "$OUT/4b-update.png"
  echo "update: version $OLD -> $NEW"
  [ "${NEW:-0}" -gt "${OLD:-0}" ] || fail "the update did not install (still version $NEW)"
fi

# the owner's bridge: a winger-bridge:// link starts the whitelist-bypass relay instead of Hysteria; it must take the
step "the owner's bridge: a winger-bridge:// link starts the whitelist-bypass relay instead of H"
# call's settings and ask the app for Telemost's address (the call itself needs the family server's Yandex account,
# so here a made-up call is refused by Telemost — the point is that everything up to the call works)
BRIDGE='winger-bridge://telemost?link=https%3A%2F%2Ftelemost.yandex.ru%2Fj%2F12345678901234&fps=24&batch=45&reliable=1#Мост CI'
adb logcat -c
adb shell "am start -n $ACT --es test_bridge '$BRIDGE' --ez test_connect true" >/dev/null
for _ in $(seq 1 40); do adb logcat -d -s AIVPN:V | grep -q "bridge: resolve" && break; sleep 1; done
sleep 5
adb logcat -d -s AIVPN:V | grep -E "bridge|relay" | head -20 | tee "$OUT/bridge.log"
grep -q "bridge: READY" "$OUT/bridge.log" || fail "the bridge relay did not start"
grep -q "bridge: CONNECTING" "$OUT/bridge.log" || fail "the bridge relay did not take the call's settings"
grep -qE "bridge: resolve [a-z.-]+yandex[a-z.]* -> [0-9.]+" "$OUT/bridge.log" || fail "the bridge relay got no address from the app"
adb exec-out screencap -p > "$OUT/6-bridge.png"
adb shell am start -n $ACT --ez test_disconnect true >/dev/null
sleep 3
echo "bridge: relay started, settings taken, addresses answered"

# a button for each connection: the server's and the bridge's are on the screen; a tap on the server's switches on
step "a button for each connection: the server's and the bridge's are on the screen; a tap on th"
# through the server
adb logcat -c
adb shell am start -n $ACT >/dev/null
sleep 3
dump /sdcard/ui.xml
adb shell cat /sdcard/ui.xml > "$OUT/conns.xml"
grep -q 'text="Тест"' "$OUT/conns.xml" || fail "no button for the server"
grep -q 'text="Мост' "$OUT/conns.xml" || fail "no button for the bridge"
B=$(tr '>' '\n' < "$OUT/conns.xml" | grep 'text="Тест"' | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | head -1 | tr -c '0-9' ' ')
read -r X1 Y1 X2 Y2 <<< "$B"
adb shell input tap $(((X1 + X2) / 2)) $(((Y1 + Y2) / 2))
wait_log "connected via 10.0.2.2" 60 || fail "the server's button did not switch on through the server"
sleep 2
adb exec-out screencap -p > "$OUT/6a-conns.png"
adb shell am start -n $ACT --ez test_disconnect true >/dev/null
wait_log "stopped" 20 || fail "did not switch off (the connection's button)"
echo "connection buttons: the server's and the bridge's shown, the server's switches on through it"

# «🔀 Сам выбирать мост» on (v32, the default): the chosen server does not answer → after it failed twice
# Winger moves to a bridge by itself (the scout's ranking; here the test's bridge, which has no call: it fails too)
step "by itself on (v32): the chosen server does not answer twice → the next one that may carry"
DEAD='hysteria2://family:test-pass-123@10.0.2.2:4999/?sni=vpn.test.local&insecure=1#Запасной'
adb logcat -c
adb shell "am start -a android.intent.action.VIEW -d '$DEAD' -n $ACT" >/dev/null
sleep 2
mark
adb shell am start -n $ACT --ez test_auto true --ez test_connect true >/dev/null
wait_since "auto: «Запасной» не \(отвечает\|работает в этой сети\) — \(включаю мост через\|пробую «\)" 150 || fail "did not move on by itself when the chosen server did not answer"
since | sed '/auto: /,$d' | grep -q "connected via" && fail "took the dead server's handshake for a connection"
adb shell am start -n $ACT --ez test_disconnect true >/dev/null
wait_log "stopped" 20 || fail "did not switch off (by itself to a bridge)"
echo "by itself to a bridge: the dead chosen server left after two failures, a bridge tried"

# (v37) a white-list here (only white-listed sites open: Google shut, Yandex open — made by the test): the chosen
# server does not answer there either (it is «Запасной», a dead one, here), so a bridge at once — no minute of its failed
# tries first; then the same «white-list» with a server that does answer (Google shut for some other reason): it stays
step "a white-list here (v37): a bridge at once; Google shut but the server answers: it stays"
adb logcat -c
mark
adb shell am start -n $ACT --es test_select Запасной --ez test_auto true --ez test_white true --ez test_connect true >/dev/null
wait_since "auto: В этой сети открыты только сайты из белого списка — включаю мост через" 90 || fail "a white-list: did not go to a bridge at once"
since | grep -q "network: a white-list" || fail "a white-list: not said in the journal"
since | sed '/auto: /,$d' | grep -q "retry [0-9]" && fail "a white-list: the dead server was tried over and over first"
adb shell am start -n $ACT --ez test_disconnect true --ez test_white false >/dev/null
wait_log "stopped" 20 || fail "did not switch off (a white-list)"
mark
adb shell am start -n $ACT --es test_select Тест --ez test_auto true --ez test_white true --ez test_connect true >/dev/null
wait_since "not a white-list, it stays" 60 || fail "Google shut but the server answers: it did not stay"
wait_since "connected via 10.0.2.2" 60 || fail "Google shut but the server answers: not connected through it"
since | grep -q "auto: В этой сети открыты только сайты из белого списка" && fail "Google shut but the server answers: went to a bridge"
adb shell am start -n $ACT --ez test_disconnect true --ez test_white false >/dev/null
wait_log "stopped" 20 || fail "did not switch off (Google shut, server answers)"
adb shell am start -n $ACT --es test_select Запасной >/dev/null  # (the next step: «Запасной» chosen again)
sleep 1
echo "white-list: a bridge at once; Google shut but the server answers: it stays"

# switched off (as it was from 13.10, the owner: it ran over all the connections): the chosen server does not answer →
# Winger stays on it and tries again, its button says so; once it answers (a second test server comes up on its port) it is on
step "no going over by itself (switched off): the chosen server does not answer → Winger stays on it and tries"
adb logcat -c
mark
adb shell am start -n $ACT --ez test_auto false --ez test_connect true >/dev/null
wait_since "retry 2: " 120 || fail "did not try the chosen server again when it did not answer"
since | grep -q "auto: " && fail "moved to another connection by itself"
since | grep -q "connected via" && fail "connected somewhere while the chosen server does not answer"
wait_since "button «Запасной»: \(Подключаюсь\|Переподключаюсь\)" 15 || fail "the chosen one's button does not say it is trying again"
adb exec-out screencap -p > "$OUT/7-stays.png"
sed -e 's/^listen: :4443/listen: :4999/' -e '/^trafficStats:/,$d' /tmp/t/hy.yaml > /tmp/t/hy2.yaml
( cd /tmp/t && HYSTERIA_LOG_LEVEL=info nohup ./hysteria server -c hy2.yaml < /dev/null > hy2.log 2>&1 & )
wait_since "connected via 10.0.2.2" 90 || fail "not connected once the chosen server answered"
grep -q "client connected" /tmp/t/hy2.log || fail "the chosen server saw no connection"
since | grep -q "auto: " && fail "moved to another connection by itself"
adb shell am start -n $ACT --ez test_disconnect true >/dev/null
wait_log "stopped" 20 || fail "did not switch off (the chosen server)"
pkill -f "hysteria server -c hy2.yaml" || true  # the second test server is not needed further (nor left running)
echo "no going over by itself: stayed on the chosen server, tried again, connected once it answered"

# the shade's tile: Winger on and off without opening the app (if this Android's shell can press a tile)
step "the shade's tile: Winger on and off without opening the app (if this Android's shell can p"
adb shell am start -n $ACT --es test_select Тест >/dev/null
sleep 2
adb shell am force-stop $PKG
adb logcat -c
timeout 20 adb shell cmd statusbar add-tile $PKG/.VpnTile >/dev/null 2>&1
if ! OUTT=$(timeout 20 adb shell cmd statusbar click-tile $PKG/.VpnTile 2>&1) || printf "%s" "$OUTT" | grep -qiE "unknown|error|exception"; then
  echo "note: this emulator's shell cannot press a tile"
else
  wait_log "connected via" 60 || fail "the tile did not switch the VPN on"
  timeout 20 adb shell cmd statusbar click-tile $PKG/.VpnTile >/dev/null 2>&1
  wait_log "stopped" 20 || fail "the tile did not switch the VPN off"
  echo "tile: on and off from the shade"
fi

# other call services for the bridge: a WB Stream bridge starts the relay in its own mode with its room and the data
step "other call services for the bridge: a WB Stream bridge starts the relay in its own mode wi"
# channel first (the call itself needs the family server's WB account, as with Telemost)
WB='winger-bridge://wbstream?room=wbstream%3A%2F%2F0123456789abcdef&mode=dc#МостWB'
adb logcat -c
adb shell "am start -n $ACT --es test_bridge '$WB' --ez test_connect true" >/dev/null
for _ in $(seq 1 40); do adb logcat -d -s AIVPN:V | grep -q "wbstream-joiner: room=" && break; sleep 1; done
adb logcat -d -s AIVPN:V | grep -E "bridge|relay" | head -12 | tee "$OUT/bridge-wb.log"
grep -q "bridge: READY" "$OUT/bridge-wb.log" || fail "the WB Stream relay did not start"
# the room as the creator knows it (the bare id: the tunnel's key comes from it on both sides), not the whole link
grep -q "wbstream-joiner: room=0123456789abcdef " "$OUT/bridge-wb.log" || fail "the WB Stream relay did not take the room as its bare id"
adb shell am start -n $ACT --ez test_disconnect true >/dev/null
sleep 3
echo "bridge WB Stream: relay started in its mode, room taken"
adb shell "am start -n $ACT --es test_remove МостWB" >/dev/null; sleep 1

# DION: by itself 24 × 10 packets a second reach the phone; the relay is given twice that to ask of the server's side
step "DION: the relay is given the higher speed to ask of the server's side"
DN='winger-bridge://dion?room=dion%3A%2F%2Fabc-def-ghi#МостDION'
adb logcat -c
adb shell "am start -n $ACT --es test_bridge '$DN' --ez test_connect true" >/dev/null
for _ in $(seq 1 40); do adb logcat -d -s AIVPN:V | grep -q "dion-joiner: room=" && break; sleep 1; done
adb logcat -d -s AIVPN:V | grep -E "bridge|relay" | head -12 | tee "$OUT/bridge-dion.log"
grep -q "bridge: READY" "$OUT/bridge-dion.log" || fail "the DION relay did not start"
grep -q "dion-joiner: room=abc-def-ghi name=.* vp8Fps=24 vp8Batch=20" "$OUT/bridge-dion.log" || fail "the DION relay did not take the higher speed"
adb shell am start -n $ACT --ez test_disconnect true >/dev/null
sleep 3
echo "bridge DION: relay started with the higher speed to ask for"
adb shell "am start -n $ACT --es test_remove МостDION" >/dev/null; sleep 1

# VK: the phone gets into the call as a guest by itself (the relay's «AUTH:»), asking the app for VK's addresses; the
# call is made up here, so VK refuses it later — the point is that everything up to the call works
step "VK: the relay signs in to the call as a guest by itself and asks for VK's address"
VK='winger-bridge://vk?link=https%3A%2F%2Fvk.com%2Fcall%2Fjoin%2Fabcdefghij0123456789&mode=dc#МостVK'
adb logcat -c
adb shell "am start -n $ACT --es test_bridge '$VK' --ez test_connect true" >/dev/null
for _ in $(seq 1 40); do adb logcat -d -s AIVPN:V | grep -q "bridge: resolve login.vk" && break; sleep 1; done
sleep 3
adb logcat -d -s AIVPN:V | grep -E "bridge|relay" | head -16 | tee "$OUT/bridge-vk.log"
grep -q "bridge: READY" "$OUT/bridge-vk.log" || fail "the VK relay did not start"
grep -q "vk-auth: appID=" "$OUT/bridge-vk.log" || fail "the VK relay did not take the call's settings (AUTH:)"
grep -qE "bridge: resolve login\.vk\.(ru|com) -> [0-9.]+" "$OUT/bridge-vk.log" || fail "the VK relay got no address from the app"
# VK may ask this phone for «I am not a robot» (a guest from a data centre often is): then Winger's own window shows
# VK's page at once (Winger is on the screen); the tick is pressed as a person would, and what followed is kept
step "VK: «I am not a robot», if asked, opens inside Winger"
for _ in $(seq 1 45); do adb logcat -d -s AIVPN:V | grep -qE "bridge: CAPTCHA:|bridge: ERROR|VK API error|vk-auth: OK.ru" && break; sleep 1; done
resumed() { adb shell dumpsys activity activities | grep -E "(mResumedActivity|topResumedActivity)" | grep -q "$1"; }
if adb logcat -d -s AIVPN:V | grep -q "bridge: CAPTCHA:"; then
  for _ in $(seq 1 15); do resumed CaptchaActivity && break; sleep 1; done
  resumed CaptchaActivity || fail "VK's check did not open inside Winger"
  wait_log "VK's check page shown in Winger" 40 || fail "VK's check page did not load inside Winger"
  sleep 4
  adb exec-out screencap -p > "$OUT/8-captcha.png"
  dump /sdcard/cap.xml
  adb shell cat /sdcard/cap.xml > "$OUT/captcha-ui.xml"
  B=$(grep -o '<node [^>]*checkable="true"[^>]*>' "$OUT/captcha-ui.xml" | grep -o 'bounds="[^"]*"' | head -1)
  [ -n "$B" ] || B=$(grep -o '<node [^>]*[Рр]обот[^>]*>' "$OUT/captcha-ui.xml" | grep -o 'bounds="[^"]*"' | head -1)
  if [ -n "$B" ]; then
    read -r X1 Y1 X2 Y2 < <(echo "$B" | tr -c '0-9' ' ')
    adb shell input tap $(((X1 + X2) / 2)) $(((Y1 + Y2) / 2))
    sleep 15
    adb exec-out screencap -p > "$OUT/8a-captcha-tick.png"
    echo "VK check: ticked at $B"
  else
    echo "note: no tick found on VK's page (see 8-captcha.png)"
  fi
  adb logcat -d -s AIVPN:V | grep -E "captcha|vk-auth" | tee "$OUT/captcha.log"
  adb shell am start -n $ACT --ez test_disconnect true >/dev/null
  for _ in $(seq 1 10); do resumed CaptchaActivity || break; sleep 1; done
  resumed CaptchaActivity && fail "Winger's check window stayed after the bridge was switched off"
  echo "VK check: shown inside Winger, closed with the bridge"
else
  echo "note: VK did not ask for «I am not a robot» here"
  adb logcat -d -s AIVPN:V | grep -E "vk-auth|bridge: ERROR" | tail -5
  adb shell am start -n $ACT --ez test_disconnect true >/dev/null
fi
sleep 3
echo "bridge VK: relay started, guest sign-in begun, addresses answered"
adb shell "am start -n $ACT --es test_remove МостVK" >/dev/null; sleep 1
adb shell am start -n $ACT --es test_remove Запасной >/dev/null; sleep 1

# the bridges checked from the phone (the family server's Claude asks, srv-phone): each bridge in a short call of its own,
# the sites straight from the phone, a report — here the call is not real: «not in the call» or the service's error
step "the bridges checked from the phone: a bridge in a short call of its own, the sites, a report"
adb shell am start -n $ACT --ez test_disconnect true >/dev/null; sleep 2
CHK='winger-bridge://telemost?link=https%3A%2F%2Ftelemost.yandex.ru%2Fj%2F98765432109876&fps=24&batch=45#МостПроверка'
adb shell "am start -n $ACT --es test_bridge '$CHK'" >/dev/null; sleep 2
adb logcat -c
adb shell "am start -n $ACT --el test_check_join 8000 --es test_check ci1" >/dev/null
for _ in $(seq 1 240); do adb logcat -d -s AIVPN:V | grep -q "bridge check: done" && break; sleep 1; done
adb logcat -d -s AIVPN:V | grep "bridge check" | tee "$OUT/check.log"
grep -q "bridge check: started (the server's ask)" "$OUT/check.log" || fail "the check did not start"
grep -qE "bridge check: «МостПроверка» (no_join|error)" "$OUT/check.log" || fail "the bridge was not tried in a call of its own"
grep -qE "bridge check: done, [0-9]+ bridges, 0 carry" "$OUT/check.log" || fail "the check did not finish"
sleep 2
dump /sdcard/ui.xml
adb shell cat /sdcard/ui.xml | grep -q 'Проверка мостов' || fail "the check's result is not shown"
adb shell cat /sdcard/ui.xml | grep -qE 'МостПроверка» — (не вошёл в звонок|ошибка звонка)' || fail "the bridge's line is not in the result"
adb exec-out screencap -p > "$OUT/9-check.png"
adb shell input keyevent KEYCODE_BACK

# before connecting (v32): «🔎 Что работает здесь» — the servers asked, each bridge (not VK) in a short call
# with one request; each one's button then says it: the response time of one that carries (v33), «Здесь не работает»
step "before connecting: which work here (v32): a quick look, each one's button says it in words"
adb logcat -c
adb shell "am start -n $ACT --el test_check_join 8000 --es test_check quick" >/dev/null
for _ in $(seq 1 180); do adb logcat -d -s AIVPN:V | grep -q "quick look: " && break; sleep 1; done
adb logcat -d -s AIVPN:V | grep "bridge check\|scout\|quick look\|ping «" | tee "$OUT/quick.log"
grep -q "bridge check: started (before connecting: which carry here)" "$OUT/quick.log" || fail "the quick look did not start"
grep -qE "scout: «МостПроверка» (no_join|error)" "$OUT/quick.log" || fail "the quick look did not try the bridge in a call of its own"
grep -qE "quick look: [0-9]+ carry here, [1-9][0-9]* do not" "$OUT/quick.log" || fail "the quick look did not tell what it found"
sleep 2
dump /sdcard/ui.xml
adb shell cat /sdcard/ui.xml > "$OUT/quick.xml"
grep -q 'text="Здесь не работает' "$OUT/quick.xml" || fail "the bridge's button does not say it does not work here"
grep -qE 'text="[0-9]+ мс' "$OUT/quick.xml" || fail "the server's response time is not under its name (v33)"
adb exec-out screencap -p > "$OUT/9a-quick.png"
# the whole screen for a look at it (the settings below, the dark theme): pictures only, nothing checked
read -r SW SH <<< "$(adb shell wm size | grep -oE '[0-9]+x[0-9]+' | tail -1 | tr x ' ')"
UP="$((SW / 2)) $((SH * 8 / 10)) $((SW / 2)) $((SH * 2 / 10))"; DOWN="$((SW / 2)) $((SH * 2 / 10)) $((SW / 2)) $((SH * 8 / 10))"
adb shell input swipe $UP 400; sleep 1
adb exec-out screencap -p > "$OUT/9b-settings.png"
adb shell input swipe $DOWN 400; sleep 1
adb shell cmd uimode night yes >/dev/null 2>&1; sleep 3
adb exec-out screencap -p > "$OUT/9c-dark.png"
adb shell input swipe $UP 400; sleep 1
adb exec-out screencap -p > "$OUT/9d-dark-settings.png"
adb shell cmd uimode night no >/dev/null 2>&1; sleep 2
echo "quick look: the servers and the bridge looked at, the buttons say it in words"
adb shell "am start -n $ACT --es test_remove МостПроверка" >/dev/null; sleep 1
echo "bridge check: a call of its own tried, sites looked at, the result shown"

# the release build as the family server makes it: the icon picture swapped, re-aligned, signed; it must install
step "the release build as the family server makes it: the icon picture swapped, re-aligned, sig"
if [ -n "${ICON_APK:-}" ]; then
  adb install -r "$ICON_APK" || fail "the APK with the swapped icon did not install"
  adb shell pm path app.aihelper.vpn | grep -q "base.apk" || fail "the APK with the swapped icon is not installed"
  # the connection inside the APK becomes the server on the first start, once
  adb logcat -c
  adb shell am start -n app.aihelper.vpn/.MainActivity >/dev/null
  for _ in $(seq 1 20); do adb logcat -d -s AIVPN:I | grep -q "profile from the package" && break; sleep 1; done
  adb logcat -d -s AIVPN:I | grep "profile from the package: CI Test" || fail "the connection inside the APK was not taken"
  sleep 2
  dump /sdcard/ui.xml
  adb shell cat /sdcard/ui.xml | grep -q 'text="CI Test"' || fail "the server from the APK is not shown"
  adb exec-out screencap -p > "$OUT/5-packaged.png"
  adb shell am force-stop app.aihelper.vpn
  adb shell am start -n app.aihelper.vpn/.MainActivity >/dev/null
  sleep 4
  [ "$(adb logcat -d -s AIVPN:I | grep -c "profile from the package")" = 1 ] || fail "the connection inside the APK was added twice"
  echo "packaged connection: taken once, shown"
  adb shell input keyevent KEYCODE_HOME
  read -r W H < <(adb shell wm size | grep -o "[0-9]*x[0-9]*" | tail -1 | tr x ' ')
  adb shell input swipe $((W / 2)) $((H * 9 / 10)) $((W / 2)) $((H / 5)) 300  # open the list of apps
  sleep 3
  adb exec-out screencap -p > "$OUT/5-icon.png"
fi
echo "VPN TEST OK"
