#!/bin/bash
# Runs inside the emulator job: installs the debug app, lets it sign in and ask a question through
# hysteria's HTTP/3 (UDP 443), then again with UDP blocked so it has to use TLS on TCP 8443.
set -x
OUT=${OUT:-/tmp/out}
mkdir -p "$OUT"
# Chrome speaks QUIC only to certificates from roots that ship with the system, not user-added ones: put the
# test CA into the emulator's system store (the emulator runs with -writable-system)
adb root; sleep 3
adb shell avbctl disable-verification >/dev/null 2>&1 || true
adb disable-verity >/dev/null 2>&1 || true
adb reboot
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done
adb root; sleep 3
adb remount
HASH=$(openssl x509 -subject_hash_old -noout -in "$CA")
adb push "$CA" "/system/etc/security/cacerts/$HASH.0"
adb shell chmod 644 "/system/etc/security/cacerts/$HASH.0"
SYSCA=no
adb shell ls "/system/etc/security/cacerts/$HASH.0" && SYSCA=yes
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
grep -q 'AITEST answer: Привет' "$OUT/quic.log" || { echo "QUIC run: no answer"; exit 1; }
if grep -q 'via h3' "$OUT/quic.log"; then echo "QUIC: HTTP/3 ✓"
elif [ $SYSCA = yes ]; then echo "QUIC run went over TCP although the CA is a system one"; exit 1
else echo "QUIC not verified: the test CA could not be made a system one (answers came over TCP 8443)"; fi
grep -q 'AITEST answer: Привет' "$OUT/tcp.log" || { echo "TCP fallback run failed"; exit 1; }
echo "EMULATOR OK"
