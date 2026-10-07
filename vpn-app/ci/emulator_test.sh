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

# the phone's own traffic: a name lookup (UDP DNS) and a web page (TCP), through the tunnel
R=$(adb shell "printf 'GET / HTTP/1.0\r\nHost: example.com\r\n\r\n' | toybox nc -w 15 example.com 80 | head -1")
echo "through the VPN: $R"
echo "$R" | grep -q "HTTP/1" || fail "a web page did not come through the VPN"
sleep 2
grep -E "TCP request|UDP request" /tmp/t/hy.log | tail -5
grep -q "TCP request" /tmp/t/hy.log || fail "the server saw no TCP through the tunnel"
grep -q "UDP request" /tmp/t/hy.log || fail "the server saw no UDP (DNS) through the tunnel"
curl -s http://127.0.0.1:7653/traffic && echo
sleep 3
adb exec-out screencap -p > "$OUT/3-traffic.png"

adb shell am start -n $ACT --ez test_disconnect true
wait_log "stopped" 20 || fail "did not switch off"
sleep 2
adb exec-out screencap -p > "$OUT/4-off.png"
R=$(adb shell "printf 'GET / HTTP/1.0\r\nHost: example.com\r\n\r\n' | toybox nc -w 10 example.com 80 | head -1")
echo "after switching off (straight to the internet): $R"
adb logcat -d -s AIVPN:V > "$OUT/logcat.txt"
grep -c "hy:" "$OUT/logcat.txt"
echo "VPN TEST OK"
