#!/bin/bash
# Runs inside the emulator job: installs the debug app, lets it sign in and ask a question through
# hysteria's HTTP/3 (UDP 443), then again with UDP blocked so it has to use TLS on TCP 8443.
set -x
OUT=${OUT:-/tmp/out}
mkdir -p "$OUT"
adb install -r "$APK" || exit 1
PKG=app.aihelper.family.debug
run() {  # $1 name
  adb shell pm clear $PKG
  adb shell pm grant $PKG android.permission.RECORD_AUDIO
  adb logcat -c
  adb shell am start -n $PKG/app.aihelper.family.MainActivity
  sleep 60
  adb exec-out screencap -p > "$OUT/$1.png"
  adb logcat -d -s AITEST AINet AIWeb AIWebConsole chromium:E AndroidRuntime:E > "$OUT/$1.log"
  adb shell am force-stop $PKG
}
run quic
sudo iptables -I INPUT -p udp --dport 443 -j DROP
run tcp
sudo iptables -D INPUT -p udp --dport 443 -j DROP
cat "$OUT/quic.log" "$OUT/tcp.log" | grep -E 'AITEST|via|failed|FATAL' | head -40
grep -q 'AITEST answer: Привет' "$OUT/quic.log" && grep -q 'via h3' "$OUT/quic.log" || { echo "QUIC run failed"; exit 1; }
grep -q 'AITEST answer: Привет' "$OUT/tcp.log" || { echo "TCP fallback run failed"; exit 1; }
echo "EMULATOR OK"
