#!/bin/bash
# Runs on a Windows machine (GitHub's): a real hysteria server here, then Winger for Windows switches the virtual
# interface on — other programs' pages must go through the server (by name), only the chosen ones when so set; the
# bridge's program starts and asks for names; the installed service is driven by the window's API, then removed.
set -x
OUT=${OUT:-out}
mkdir -p "$OUT"
step() { echo "$(date +%T) $*" >> "$OUT/progress.txt"; }
fail() { echo "FAIL: $*"; echo "::error::$*"; exit 1; }
CURL=/c/Windows/System32/curl.exe  # Windows' own curl: just another program, not Winger
export WINGER_QUIET=1

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
HYSTERIA_LOG_LEVEL=debug ./hysteria.exe server -c hy.yaml > "$OUT/hysteria.log" 2>&1 &
sleep 3
IP=$(powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { \$_.InterfaceAlias -notmatch 'Loopback' -and \$_.IPAddress -notmatch '^169\.' } | Select-Object -First 1).IPAddress" | tr -d '\r')
echo "server at $IP"
LINK="hysteria2://family:test-pass-123@$IP:4443/?sni=vpn.test.local&insecure=1#CI"

step "the virtual interface: another program's page goes through the server, by its name"
./winger-console.exe --selftest "$LINK" -- "$CURL" -s -o NUL -w "%{http_code}" --max-time 30 https://www.example.com/ > "$OUT/selftest.log" 2>&1
cat "$OUT/selftest.log"
grep -q "check: 200" "$OUT/selftest.log" || fail "no page came through the VPN"
grep -q 'reqAddr.*example\.com' "$OUT/hysteria.log" || fail "the server did not carry the page by its name"
echo "virtual interface: a page through the server ✓"

step "only the chosen programs: curl through the VPN, PowerShell straight"
./winger-console.exe --selftest "$LINK" --only curl.exe --hold 25 > "$OUT/selftest-only.log" 2>&1 &
SELF=$!
for _ in $(seq 1 60); do grep -q "^phase: on" "$OUT/selftest-only.log" && break; sleep 1; done
grep -q "^phase: on" "$OUT/selftest-only.log" || { cat "$OUT/selftest-only.log"; fail "did not come on (only chosen programs)"; }
C=$("$CURL" -s -o NUL -w "%{http_code}" --max-time 30 https://www.wikipedia.org/)
P=$(powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 https://www.python.org/).StatusCode } catch { 0 }" | tr -d '\r')
wait $SELF
cat "$OUT/selftest-only.log"
echo "curl: $C, powershell: $P"
[ "$C" = 200 ] || fail "the chosen program got no page"
[ "$P" = 200 ] || fail "a program not chosen got no page (it must go straight)"
grep -q 'reqAddr.*wikipedia\.org' "$OUT/hysteria.log" || fail "the chosen program did not go through the server"
grep -q 'reqAddr.*python\.org' "$OUT/hysteria.log" && fail "a program not chosen went through the server"
echo "only chosen programs ✓"

step "the bridge's program: starts, takes the call's settings, asks for Telemost's address"
timeout 60 ./winger-console.exe --selftest 'winger-bridge://telemost?link=https%3A%2F%2Ftelemost.yandex.ru%2Fj%2F12345678901234#B' > "$OUT/bridge.log" 2>&1
grep -E "bridge|relay" "$OUT/bridge.log" | head -20
grep -q "bridge: READY" "$OUT/bridge.log" || fail "the bridge's program did not start"
grep -qE "bridge: resolve [a-z.-]+yandex[a-z.]* -> [0-9]" "$OUT/bridge.log" || fail "the bridge's program got no address"
echo "bridge program ✓"

step "installed: the service starts, the window's API drives it, then it is removed"
./winger.exe --install
sc query Winger | tee "$OUT/service.txt" | grep -q RUNNING || fail "the service does not run after the install"
for _ in $(seq 1 40); do [ -s /c/ProgramData/Winger/ui-token ] && break; sleep 0.5; done
T=$(cat /c/ProgramData/Winger/ui-token)
[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:47710/api/state)" = 403 ] || fail "the API answers without the key"
api() { curl -s -b "wt=$T" -H "Content-Type: application/json" -X POST -d "$2" "http://127.0.0.1:47710/api/$1"; }
api add "{\"text\": \"Ваш VPN: $LINK\"}" | tee -a "$OUT/service.txt"
api connect '{}' | tee -a "$OUT/service.txt"
for _ in $(seq 1 60); do curl -s -b "wt=$T" http://127.0.0.1:47710/api/state | grep -q '"phase":"on"' && break; sleep 1; done
curl -s -b "wt=$T" http://127.0.0.1:47710/api/state | tee -a "$OUT/service.txt" | grep -q '"phase":"on"' || fail "the service did not come on"
[ "$("$CURL" -s -o NUL -w '%{http_code}' --max-time 30 https://www.mozilla.org/)" = 200 ] || fail "no page through the service's VPN"
grep -q 'reqAddr.*mozilla\.org' "$OUT/hysteria.log" || fail "the service's VPN did not carry the page"
api disconnect '{}'
cp /c/ProgramData/Winger/journal.log "$OUT/service-journal.log" 2>/dev/null
"/c/Program Files/Winger/winger.exe" --uninstall
sleep 5
sc query Winger >/dev/null 2>&1 && fail "the service is still there after removing"
echo "service ✓"
step "done"
