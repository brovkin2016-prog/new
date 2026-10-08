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
wait_log() {  # text, seconds
  for _ in $(seq 1 "$2"); do adb logcat -d -s AIVPN:V | grep -q "$1" && return 0; sleep 1; done
  return 1
}

adb install -r -g "$APK" || fail "install"
adb shell appops set $PKG ACTIVATE_VPN allow  # the "allow VPN" question, answered for the test
adb logcat -c
adb shell "am start -a android.intent.action.VIEW -d '$LINK' -n $ACT"
sleep 3
adb exec-out screencap -p > "$OUT/1-added.png"
adb shell am start -n $ACT --ez test_all true --ez test_connect true  # first everything through the VPN
wait_log "through the VPN: all apps" 60 || fail "not all apps through the VPN"
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

# the speed of a connection: the one that is on, through itself
step "the speed of a connection: the one that is on, through itself"
adb shell am start -n $ACT --es test_speed Тест >/dev/null
wait_log "speed: «Тест» [0-9]" 40 || fail "no speed for the connection that is on"
adb logcat -d -s AIVPN:I | grep "speed: «Тест»" | tail -1
adb logcat -d -s AIVPN:I | grep "speed: «Тест»" | tail -1 | grep -qE "speed: «Тест» (0\.0[1-9]|0\.[1-9]|[1-9])" || fail "the speed test downloaded nothing"
adb exec-out screencap -p > "$OUT/3a-speed.png"

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
wait_log "through the VPN: \[.*com\.android\.chrome" 60 || fail "the chosen app did not reach the VPN (is it visible to the app?)"
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
adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
adb shell cat /sdcard/ui.xml | grep -qE 'text="(Settings|Настройки)"' || fail "the picker does not show Settings"
adb exec-out screencap -p > "$OUT/4a-pick.png"
adb shell input keyevent KEYCODE_BACK
adb shell input keyevent KEYCODE_BACK
adb logcat -c
adb shell am start -n $ACT --es test_apps com.android.settings --ez test_connect true
wait_log "through the VPN: \[.*com\.android\.settings" 60 || fail "an app outside the known list did not reach the VPN"
wait_log "connected via" 60 || fail "no connection with an app outside the known list"
adb shell am start -n $ACT --ez test_disconnect true
wait_log "stopped" 20 || fail "did not switch off (an app outside the known list)"
echo "any app: the picker lists the phone's apps, Settings ticked goes through the VPN"

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
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
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
adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
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

# the automatic choice: the chosen server does not answer → Winger moves to another one by itself; once the chosen one
step "the automatic choice: the chosen server does not answer → Winger moves to another one by i"
# answers again (a second test server comes up on its port), it goes back to it
DEAD='hysteria2://family:test-pass-123@10.0.2.2:4999/?sni=vpn.test.local&insecure=1#Запасной'
adb logcat -c
adb shell "am start -a android.intent.action.VIEW -d '$DEAD' -n $ACT" >/dev/null
sleep 2
adb shell am start -n $ACT --el test_back 20000 --ez test_connect true >/dev/null
wait_log "auto: «Запасной» не отвечает" 150 || fail "did not move on by itself when the chosen server did not answer"
wait_log "connected via 10.0.2.2" 60 || fail "the other server did not connect after the automatic move"
sleep 2
adb exec-out screencap -p > "$OUT/7-auto.png"
# (the screen is read from what it logs: while the VPN is on its button glows, and uiautomator cannot read a moving screen)
step "(the screen is read from what it logs: while the VPN is on its button glows, and uiautomat"
wait_log "button «Тест»: ● Включено само" 15 || fail "the screen does not say it moved by itself"
sed -e 's/^listen: :4443/listen: :4999/' -e '/^trafficStats:/,$d' /tmp/t/hy.yaml > /tmp/t/hy2.yaml
( cd /tmp/t && HYSTERIA_LOG_LEVEL=info nohup ./hysteria server -c hy2.yaml < /dev/null > hy2.log 2>&1 & )
wait_log "auto: «Запасной» answers again" 120 || fail "did not notice the chosen server answering again"
wait_log "Выбранный сервер снова отвечает" 30 || fail "did not go back to the chosen server"
for _ in $(seq 1 60); do [ "$(adb logcat -d -s AIVPN:I | grep -c 'connected via 10.0.2.2')" -ge 2 ] && break; sleep 1; done
[ "$(adb logcat -d -s AIVPN:I | grep -c 'connected via 10.0.2.2')" -ge 2 ] || fail "not connected again through the chosen server"
grep -q "client connected" /tmp/t/hy2.log || fail "the chosen server saw no connection"
adb shell am start -n $ACT --ez test_disconnect true >/dev/null
wait_log "stopped" 20 || fail "did not switch off (automatic choice)"
pkill -f "hysteria server -c hy2.yaml" || true  # the second test server is not needed further (nor left running)
echo "automatic choice: moved to the other server by itself, went back once the chosen one answered"

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
grep -q "wbstream-joiner: room=wbstream://0123456789abcdef" "$OUT/bridge-wb.log" || fail "the WB Stream relay did not take the room"
adb shell am start -n $ACT --ez test_disconnect true >/dev/null
sleep 3
echo "bridge WB Stream: relay started in its mode, room taken"
adb shell "am start -n $ACT --es test_remove МостWB" >/dev/null; sleep 1
adb shell am start -n $ACT --es test_remove Запасной >/dev/null; sleep 1

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
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
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
