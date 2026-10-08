#!/bin/bash
# Runs inside the emulator: install the app, add the test server from a hysteria2:// link (as a tapped link would),
# switch it on, and check that the phone's own traffic (adb shell, not this app) goes through the tunnel to the server.
set -x
mkdir -p "$OUT"
PKG=app.aihelper.vpn.debug
ACT=$PKG/app.aihelper.vpn.MainActivity
LINK='hysteria2://family:test-pass-123@10.0.2.2:4443/?sni=vpn.test.local&insecure=1#Тест'
fail() { echo "FAIL: $*"; adb logcat -d -s AIVPN:V > "$OUT/logcat.txt"; adb exec-out screencap -p > "$OUT/fail.png"; exit 1; }
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

adb shell am start -n $ACT --ez test_disconnect true
wait_log "stopped" 20 || fail "did not switch off"
sleep 2
adb exec-out screencap -p > "$OUT/4-off.png"
R=$(page)
echo "after switching off (straight to the internet): $R"
adb logcat -d -s AIVPN:V > "$OUT/logcat.txt"
grep -c "hy:" "$OUT/logcat.txt"

# only the chosen apps through the VPN: Chrome (on this emulator, not ticked by default) is chosen; the app must see
# it (Android 11+ hides other apps unless the manifest names them), and the shell's own traffic must then go straight
adb logcat -c
adb shell am start -n $ACT --es test_apps com.android.chrome --ez test_connect true
# (YouTube on this emulator image is ticked by default too: the list must name Chrome, and YouTube shows the app sees them)
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

# a real update of the app over itself: the next build (version + 1) through the app's own installer, then
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

# the release build as the family server makes it: the icon picture swapped, re-aligned, signed; it must install
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
