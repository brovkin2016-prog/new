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
adb shell am start -n $ACT --ez test_connect true
wait_log "connected via" 60 || fail "no connection to the server"
wait_log "ping [0-9]* ms" 40 || fail "no response time through the tunnel"
sleep 2
adb exec-out screencap -p > "$OUT/2-on.png"

# the phone's own traffic through the tunnel: a web page (TCP) and a plain DNS question over UDP
# (Android itself asks DNS over TLS, i.e. TCP 853, so UDP is checked on purpose)
# stdin stays open a few seconds: toybox nc may quit on its EOF before the answer has come
page() { adb shell "( printf 'GET / HTTP/1.0\r\nHost: example.com\r\n\r\n'; sleep 6 ) | toybox nc -w 15 example.com 80 | head -1"; }
for _ in 1 2 3; do R=$(page); echo "$R" | grep -q "HTTP/1" && break; sleep 2; done
echo "through the VPN: $R"
echo "$R" | grep -q "HTTP/1" || fail "a web page did not come through the VPN"
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

# the release build as the family server makes it: the icon picture swapped, re-aligned, signed; it must install
if [ -n "${ICON_APK:-}" ]; then
  adb install -r "$ICON_APK" || fail "the APK with the swapped icon did not install"
  adb shell pm path app.aihelper.vpn | grep -q "base.apk" || fail "the APK with the swapped icon is not installed"
  adb shell input keyevent KEYCODE_HOME
  read -r W H < <(adb shell wm size | grep -o "[0-9]*x[0-9]*" | tail -1 | tr x ' ')
  adb shell input swipe $((W / 2)) $((H * 9 / 10)) $((W / 2)) $((H / 5)) 300  # open the list of apps
  sleep 3
  adb exec-out screencap -p > "$OUT/5-icon.png"
fi
echo "VPN TEST OK"
