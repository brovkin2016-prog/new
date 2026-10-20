#!/bin/bash
# Runs on a Windows machine (GitHub's): a real hysteria server here, then Winger for Windows switches the virtual
# interface on — other programs' pages must go through the server (by name), only the chosen ones when so set; the
# bridge's program starts and asks for names; the installed service is driven by the window's API, then removed.
set -x
export MSYS_NO_PATHCONV=1  # Git Bash would turn «/CN=…» into a Windows path
OUT=${OUT:-out}
mkdir -p "$OUT"
step() { echo "$(date +%T) $*" >> "$OUT/progress.txt"; }
# a log's end as a note in the run's summary (readable from outside even when the release with the logs is not made)
note() { [ -s "$1" ] && echo "::warning title=$(basename "$1")::$(tail -c 2500 "$1" | sed 's/\x1b\[[0-9;]*m//g' | tr -d '\r' | sed ':a;N;$!ba;s/%/%25/g;s/\n/%0A/g')"; }
fail() { echo "FAIL: $*"; for f in "$OUT"/network.txt "$OUT"/double-click.txt "$OUT"/selftest*.log "$OUT"/hysteria.log "$OUT"/bridge.log "$OUT"/service.txt "$OUT"/service-journal.log; do note "$f"; done
  echo "::error::$*"; exit 1; }
CURL=C:/Windows/System32/curl.exe  # handed to Winger too, so a Windows path; Windows' own curl: just another program, not Winger
export WINGER_QUIET=1
# the tests' server runs on this same machine: with Winger on, its own way out would come back into the virtual
# interface (a loop no real laptop has — there the server is far away), so it goes straight
export WINGER_DIRECT=hysteria.exe

step "a real hysteria server on this machine"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 -subj '/CN=vpn.test.local' \
  -addext 'subjectAltName=DNS:vpn.test.local' -keyout key.pem -out cert.pem
cat > hy.yaml <<EOT
listen: :4443
tls:
  cert: cert.pem
  key: key.pem
auth:
  type: userpass
  userpass:
    family: "test-pass-123"
EOT
netsh advfirewall firewall add rule name=hy-test dir=in action=allow protocol=UDP localport=4443 >/dev/null
[ -s cert.pem ] || fail "no test certificate"
HYSTERIA_LOG_LEVEL=debug ./hysteria.exe server -c hy.yaml > "$OUT/hysteria.log" 2>&1 &
sleep 3
grep -q "server up and running" "$OUT/hysteria.log" || { cat "$OUT/hysteria.log"; fail "the test server did not start"; }
IP=$(powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { \$_.InterfaceAlias -notmatch 'Loopback' -and \$_.IPAddress -notmatch '^169\.' } | Select-Object -First 1).IPAddress" | tr -d '\r')
echo "server at $IP"
for hp in "8.8.8.8 853" "1.1.1.1 443" "1.1.1.1 53"; do  # what this machine's own network lets out (for reading a failure)
  set -- $hp
  echo "$1:$2 $(powershell -NoProfile -Command "(Test-NetConnection $1 -Port $2 -WarningAction SilentlyContinue).TcpTestSucceeded" | tr -d '\r')" >> "$OUT/network.txt"
done
cat "$OUT/network.txt"
LINK="hysteria2://family:test-pass-123@$IP:4443/?sni=vpn.test.local&insecure=1#CI"

step "Windows' own antivirus looks at Winger (an unknown program may be taken for a threat)"
MP="/c/Program Files/Windows Defender/MpCmdRun.exe"
if [ -f "$MP" ]; then
  timeout 300 "$MP" -SignatureUpdate > "$OUT/defender.txt" 2>&1
  for f in winger.exe bin/winger-relay.exe; do
    timeout 300 "$MP" -Scan -ScanType 3 -File "$(cygpath -w "$PWD/$f")" -DisableRemediation >> "$OUT/defender.txt" 2>&1
    echo "$f: Defender's answer $?" >> "$OUT/defender.txt"
  done
else
  echo "no Defender on this machine" > "$OUT/defender.txt"
fi
grep -E "answer|found|Threat|no Defender" "$OUT/defender.txt"; note "$OUT/defender.txt"

step "the virtual interface: another program's page goes through the server, by its name"
./winger-console.exe --selftest "$LINK" -- "$CURL" -s -o NUL -w "%{http_code}" --max-time 30 https://www.example.com/ > "$OUT/selftest.log" 2>&1
cat "$OUT/selftest.log"
grep -q "check: 200" "$OUT/selftest.log" || fail "no page came through the VPN"
grep -qE 'reqAddr.*(cloudflare|gstatic)' "$OUT/hysteria.log" || fail "Winger's own check did not go through the server"
grep -q 'reqAddr.*example\.com' "$OUT/hysteria.log" || fail "the server did not carry the page by its name"
echo "virtual interface: a page through the server ✓"

step "only the chosen programs: curl through the VPN, PowerShell straight"
./winger-console.exe --selftest "$LINK" --only curl.exe --hold 25 > "$OUT/selftest-only.log" 2>&1 &
SELF=$!
for _ in $(seq 1 100); do grep -q "^phase: " "$OUT/selftest-only.log" && break; sleep 1; done
grep -q "^phase: on" "$OUT/selftest-only.log" || { sleep 3; cat "$OUT/selftest-only.log"; fail "did not come on (only chosen programs)"; }
# with chosen programs only, names are real addresses (no made-up ones) and the server is given the address: compare those
C=$("$CURL" -s -o NUL -w "%{http_code} %{remote_ip}" --max-time 30 https://www.wikipedia.org/)
CIP=${C#* }; C=${C%% *}
cat > ps-check.ps1 <<'EOT'
$ips = [System.Net.Dns]::GetHostAddresses('www.python.org') | ForEach-Object { $_.IPAddressToString }
try { $c = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 https://www.python.org/).StatusCode } catch { $c = 0 }
"$c " + ($ips -join ' ')
EOT
P=$(powershell -NoProfile -ExecutionPolicy Bypass -File ps-check.ps1 | tr -d '\r')
PIPS=${P#* }; P=${P%% *}
wait $SELF
cat "$OUT/selftest-only.log"
echo "curl: $C via $CIP, powershell: $P ($PIPS)"
[ "$C" = 200 ] || fail "the chosen program got no page"
[ "$P" = 200 ] || fail "a program not chosen got no page (it must go straight)"
[ -n "$CIP" ] && grep -qF "\"reqAddr\": \"$CIP:443\"" "$OUT/hysteria.log" || fail "the chosen program did not go through the server"
for ip in $PIPS; do
  grep -qF "\"reqAddr\": \"$ip:443\"" "$OUT/hysteria.log" && fail "a program not chosen went through the server"
done
grep -q 'reqAddr.*python\.org' "$OUT/hysteria.log" && fail "a program not chosen went through the server"
echo "only chosen programs ✓"

step "the bridge's program: starts, takes the call's settings, asks for Telemost's address"
timeout 60 ./winger-console.exe --selftest 'winger-bridge://telemost?link=https%3A%2F%2Ftelemost.yandex.ru%2Fj%2F12345678901234#B' > "$OUT/bridge.log" 2>&1
grep -E "bridge|relay" "$OUT/bridge.log" | head -20
grep -q "bridge: READY" "$OUT/bridge.log" || fail "the bridge's program did not start"
grep -qE "bridge: resolve [a-z.-]+yandex[a-z.]* -> [0-9]" "$OUT/bridge.log" || fail "the bridge's program got no address"
taskkill /im winger-relay.exe /f >/dev/null 2>&1
echo "bridge program ✓"

step "installed: the service starts, the window's API drives it, then it is removed"
./winger.exe --install
reg add 'HKLM\SYSTEM\CurrentControlSet\Services\Winger' /v Environment /t REG_MULTI_SZ /d WINGER_DIRECT=hysteria.exe /f
net stop Winger && net start Winger  # the service now knows about the tests' server (above)
sc query Winger | tee "$OUT/service.txt" | grep -q RUNNING || fail "the service does not run after the install"
for _ in $(seq 1 40); do [ -s /c/ProgramData/Winger/ui-token ] && break; sleep 0.5; done
T=$(cat /c/ProgramData/Winger/ui-token)
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:47710/api/state)" = 403 ] || fail "the API answers without the key"
api() { curl -s -b "wt=$T" -H "Content-Type: application/json" -X POST -d "$2" "http://127.0.0.1:47710/api/$1"; }
api add "{\"text\": \"Ваш VPN: $LINK\"}" | tee -a "$OUT/service.txt"
# a new Winger sends only the standard programs through the server; the test's curl must go through it: all programs
curl -s -b "wt=$T" http://127.0.0.1:47710/api/state | grep -q '"onlyApps":true' || fail "a new Winger: the standard programs are not ticked"
api apps '{"bridge": false, "only": false, "apps": []}' | tee -a "$OUT/service.txt"
api connect '{}' | tee -a "$OUT/service.txt"
for _ in $(seq 1 60); do curl -s -b "wt=$T" http://127.0.0.1:47710/api/state | grep -q '"phase":"on"' && break; sleep 1; done
curl -s -b "wt=$T" http://127.0.0.1:47710/api/state | tee -a "$OUT/service.txt" | grep -q '"phase":"on"' || fail "the service did not come on"
[ "$("$CURL" -s -o NUL -w '%{http_code}' --max-time 30 https://www.mozilla.org/)" = 200 ] || fail "no page through the service's VPN"
grep -q 'reqAddr.*mozilla\.org' "$OUT/hysteria.log" || fail "the service's VPN did not carry the page"
# the window as Windows draws it (its fonts, emoji, scroll bars, 100 % and 150 % scale): pictures to look at, no test
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
if [ -x "$EDGE" ]; then
  for sc in 1 1.25 1.5; do
    "$EDGE" --headless=new --disable-gpu --no-first-run --window-size=500,868 --force-device-scale-factor=$sc \
      --virtual-time-budget=6000 --user-data-dir="$(cygpath -w "$OUT/edge-$sc")" \
      --screenshot="$(cygpath -w "$OUT/window-$sc.png")" "http://127.0.0.1:47710/?t=$T" > /dev/null 2>&1 || true
    rm -rf "$OUT/edge-$sc"
  done
  ls -la "$OUT"/window-*.png 2>/dev/null || echo "no window pictures"
fi

step "an update while the VPN is on: the new program in place, the VPN back by itself, the icon from the new program"
# as the service does it (applyUpdate): the new file, run with --replace; it watches the new service before it ends
UP1=$((CODE + 1)); UP2=$((CODE + 2))
state() { curl -s -m 5 -b "wt=$T" http://127.0.0.1:47710/api/state; }
# (by the program's name: the PowerShell asking has «--tray» in its own command line too)
trays() { powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { \$_.Name -like 'winger*' -and \$_.CommandLine -like '*--tray*' }).ProcessId" | tr -d '\r' | sort; }
# (an icon left running would hold this script's output open: the step would hang to its time limit)
upfail() { cp /c/ProgramData/Winger/journal.log "$OUT/service-journal.log" 2>/dev/null; note "$OUT/update.txt"
  for p in $(trays); do taskkill /pid "$p" /f > /dev/null 2>&1; done; fail "$@"; }
"/c/Program Files/Winger/winger.exe" --tray > /dev/null 2>&1 &  # the icon by the clock, as after a sign-in (the old program's)
sleep 8
TRAY_OLD=$(trays)
echo "icon before: $TRAY_OLD" | tee "$OUT/update.txt"
T0=$(date +%s)
timeout 300 ./winger-up1.exe --replace 'C:\Program Files\Winger\winger.exe'
echo "replace (1.0.$UP1) ended with $? after $(( $(date +%s) - T0 )) s" | tee -a "$OUT/update.txt"
state | tee -a "$OUT/update.txt" | grep -q "\"version\":\"1.0.$UP1\"" || upfail "after the update the service is not the new version"
for _ in $(seq 1 60); do state | grep -q '"phase":"on"' && break; sleep 1; done
state | grep -q '"phase":"on"' || upfail "the VPN did not come back on after the update"
[ "$("$CURL" -s -o NUL -w '%{http_code}' --max-time 30 https://www.example.org/)" = 200 ] || upfail "no page through the VPN after the update"
grep -q 'reqAddr.*example\.org' "$OUT/hysteria.log" || upfail "after the update the page did not go through the VPN"
grep "update: 1.0.$UP1 runs" /c/ProgramData/Winger/journal.log | tee -a "$OUT/update.txt" | grep -q . || upfail "the journal does not say the new version runs"
for _ in $(seq 1 30); do TRAY_NEW=$(trays); [ -n "$TRAY_NEW" ] && [ "$TRAY_NEW" != "$TRAY_OLD" ] && break; sleep 1; done
echo "icon after: $TRAY_NEW" | tee -a "$OUT/update.txt"
[ -n "$TRAY_OLD" ] || upfail "the old icon did not start (nothing to compare)"
{ [ -n "$TRAY_NEW" ] && ! echo "$TRAY_NEW" | grep -qx "$TRAY_OLD"; } || upfail "the icon by the clock did not move to the new program"

step "a new version whose service does not run: put back, the VPN on again, not taken a second time"
reg add 'HKLM\SYSTEM\CurrentControlSet\Services\Winger' /v Environment /t REG_MULTI_SZ /d "WINGER_DIRECT=hysteria.exe\\0WINGER_FAIL_VERSION=$UP2" /f
T0=$(date +%s)
timeout 400 ./winger-up2.exe --replace 'C:\Program Files\Winger\winger.exe'
RC=$?
echo "replace (1.0.$UP2, broken) ended with $RC after $(( $(date +%s) - T0 )) s" | tee -a "$OUT/update.txt"
[ "$RC" != 0 ] || upfail "a new version that does not run was kept"
for _ in $(seq 1 60); do state | grep -q '"phase":"on"' && break; sleep 1; done
state | tee -a "$OUT/update.txt" | grep -q "\"version\":\"1.0.$UP1\"" || upfail "after a failed update the earlier version is not back"
state | grep -q '"phase":"on"' || upfail "the VPN did not come back on after the earlier version was put back"
[ "$("$CURL" -s -o NUL -w '%{http_code}' --max-time 30 https://www.example.net/)" = 200 ] || upfail "no page through the VPN after the put-back"
cat /c/ProgramData/Winger/rollback/bad.json | tee -a "$OUT/update.txt" | grep -q "\"code\":$UP2" || upfail "the version that did not run is not marked"
PID=$(sc queryex Winger | grep -i pid | tr -dc 0-9)
T0=$(date +%s)
timeout 60 ./winger-up2.exe --replace 'C:\Program Files\Winger\winger.exe'
RC=$?
[ "$RC" != 0 ] && [ $(( $(date +%s) - T0 )) -lt 20 ] || upfail "the marked version was tried again ($RC)"
[ "$(sc queryex Winger | grep -i pid | tr -dc 0-9)" = "$PID" ] || upfail "the marked version's try stopped the service"
reg add 'HKLM\SYSTEM\CurrentControlSet\Services\Winger' /v Environment /t REG_MULTI_SZ /d WINGER_DIRECT=hysteria.exe /f
for p in $(trays); do taskkill /pid "$p" /f > /dev/null 2>&1; done  # the double-click below starts its own icon
echo "update ✓"
api disconnect '{}'
cp /c/ProgramData/Winger/journal.log "$OUT/service-journal.log" 2>/dev/null
"/c/Program Files/Winger/winger.exe" --uninstall
sleep 5
sc query Winger >/dev/null 2>&1 && fail "the service is still there after removing"
echo "service ✓"

step "a double-click, as a person does it: Winger installs itself, then its icon and its window come up"
sleep 3  # the removed one's own clean-up is finished
# the Winger made for one laptop in «Управление»: the laptop's own VPN line at the program's end (JSON, its length in 8
# bytes little-endian, «WGRPROF1») — after the install it is the chosen connection and the phone's login (the one the
# service test above left in the settings) is gone
OWN='{"v":1,"name":"CI","links":["hysteria2://family-pc:laptop-pass@'"$IP"':4443/?sni=vpn.test.local&insecure=1#CI-laptop"]}'
N=${#OWN}
cp winger.exe winger-own.exe
printf '%s' "$OWN" >> winger-own.exe
printf "$(printf '\\%03o\\%03o' $((N & 255)) $((N >> 8 & 255)))\\0\\0\\0\\0\\0\\0WGRPROF1" >> winger-own.exe
timeout 240 ./winger-own.exe; echo "double-click: Winger ended with $?"
cat > procs.ps1 <<'EOT'
Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'winger.exe','msedge.exe' } | ForEach-Object { $_.CommandLine }
EOT
P=$(powershell -NoProfile -ExecutionPolicy Bypass -File procs.ps1 | tr -d '\r')
echo "$P" | grep -i winger | head -5 > "$OUT/double-click.txt"
sc query Winger | tee -a "$OUT/double-click.txt" | grep -q RUNNING || fail "after a double-click the service does not run"
echo "$P" | grep -q -- "--tray" || fail "after a double-click there is no icon by the clock"
echo "$P" | grep -q -- "--app=http://127.0.0.1:47710/?t=" || fail "after a double-click Winger's window did not open"
T=$(cat /c/ProgramData/Winger/ui-token)
curl -s -b "wt=$T" http://127.0.0.1:47710/api/state | tee "$OUT/own-line.txt" | grep -q '"name":"CI-laptop"' \
  || fail "the laptop's own line built into Winger was not taken"
grep -q '"name":"CI"' "$OUT/own-line.txt" && fail "the phone's login stayed next to the laptop's own line"
grep -q 'own VPN line built into this Winger: taken' /c/ProgramData/Winger/journal.log || fail "the journal does not say the line was taken"
# the real window on this computer's screen (a small one: it has to fit), as a person sees it: a picture, no test
sleep 8
cat > shot.ps1 <<'EOT'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($args[0])
"screen $($b.Width)x$($b.Height), work area $([System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea)"
EOT
timeout 60 powershell -NoProfile -ExecutionPolicy Bypass -File shot.ps1 "$(cygpath -w "$OUT/desktop.png")" > "$OUT/desktop.txt" 2>&1 || true
taskkill /im msedge.exe /f >/dev/null 2>&1
"/c/Program Files/Winger/winger.exe" --uninstall
sleep 5
echo "double-click ✓"
step "done"
