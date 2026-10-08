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
# a real update of the app over itself: the next build (version + 1) through the app's own installer, then
# Android's «install the update?» answered by a tap — the way a phone gets every update (1.0.115 failed here)
vcode() { adb shell dumpsys package $PKG | grep -o "versionCode=[0-9]*" | head -1 | tr -dc '0-9'; }
# a reminder: set for 5 s from now, the phone rings by itself (an alarm and a notification), the app in the background
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS 2>/dev/null || true
adb logcat -c
adb shell am start -n $PKG/app.aihelper.family.MainActivity --ez test_remind true
sleep 2
adb shell input keyevent KEYCODE_HOME  # in the background (not force-stopped: that would take its alarms away)
sleep 12
adb logcat -d -s AIREM:V | tee "$OUT/remind.log"
adb shell dumpsys notification --noredact > "$OUT/notifications.txt" 2>/dev/null
grep -q "ring " "$OUT/remind.log" || { echo "the reminder did not ring"; exit 1; }
grep -q "Тест: выпить таблетку" "$OUT/notifications.txt" || { echo "the reminder's notification is not there"; exit 1; }
echo "reminder: rang and shown"

# the owner's HostVDS sign-in: the real site's page must show inside the app (not a white screen), with the bar on top
adb logcat -c
adb shell am start -n $PKG/app.aihelper.family.MainActivity --ez test_hosting true
sleep 20
adb exec-out screencap -p > "$OUT/hosting.png"
adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
adb shell cat /sdcard/ui.xml > "$OUT/hosting.xml"
adb logcat -d -s AIHOST:V | tee "$OUT/hosting.log"
grep -qE "Ссылка из письма|Нужно обновить встроенный браузер" "$OUT/hosting.xml" || { echo "the HostVDS sign-in window did not open"; exit 1; }
# what the page itself shows (the site is outside: only reported, a site down is not this app's fault)
WORDS=$(tr '>' '\n' < "$OUT/hosting.xml" | grep -oE '(text|content-desc)="[^"]{2,60}"' | grep -vE 'Ссылка из письма|Я вошёл|="✕"|встроенный браузер|Обновить|Закрыть|WebView' | head -15 | tr '\n' ' ')
echo "hosting page shows: ${WORDS:-NOTHING (white screen?)}"
# never a white page without a word: the site shows, or (this emulator's built-in browser is old) the app says what to update
if grep -q "Нужно обновить встроенный браузер" "$OUT/hosting.xml"; then echo "hosting: old WebView — the app explains how to update it"
elif [ -z "$WORDS" ]; then echo "white HostVDS page and no explanation"; exit 1; fi
adb shell input keyevent KEYCODE_BACK
sleep 3
adb shell am force-stop $PKG

if [ -n "${NEXT_APK:-}" ]; then
  OLD=$(vcode)
  adb push "$NEXT_APK" /data/local/tmp/next.apk
  adb shell "cat /data/local/tmp/next.apk | run-as $PKG sh -c 'mkdir -p cache/update && cat > cache/update/test.apk'"
  adb shell appops set $PKG REQUEST_INSTALL_PACKAGES allow
  adb logcat -c
  adb shell am start -n $PKG/app.aihelper.family.MainActivity --ez test_install true
  NEW=
  for _ in $(seq 1 30); do
    sleep 2
    NEW=$(vcode)
    [ "${NEW:-0}" -gt "${OLD:-0}" ] && break
    if adb logcat -d -s AIUPD:V | grep -E "install: |install status [1-7] "; then echo "the update did not install"; exit 1; fi
    adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
    B=$(adb shell cat /sdcard/ui.xml | tr '>' '\n' | grep -E 'resource-id="android:id/button1"|text="(Update|Install|UPDATE|INSTALL|Обновить|Установить)"' \
      | grep -oE 'bounds="\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]"' | head -1 | tr -c '0-9' ' ')
    if [ -n "$B" ]; then
      read -r X1 Y1 X2 Y2 <<< "$B"
      adb shell input tap $(((X1 + X2) / 2)) $(((Y1 + Y2) / 2))
    fi
  done
  adb exec-out screencap -p > "$OUT/update.png"
  adb logcat -d -s AIUPD:V > "$OUT/update.log"
  echo "update: version $OLD -> $NEW"
  [ "${NEW:-0}" -gt "${OLD:-0}" ] || { echo "the update did not install (still version $NEW)"; exit 1; }
fi
echo "EMULATOR OK"
