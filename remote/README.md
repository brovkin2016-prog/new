# Remote desktop to the owner's laptop (RustDesk)

Two PowerShell templates that the family server (appweb) fills in and hands out. The owner copies a one-line
command from the app («Управление» → «Сервер» → «Удалённый доступ») and pastes it into an ordinary PowerShell window:

```
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; irm '<API>/api/remote/host.ps1?t=<TOKEN>' | iex"
```

| File | Runs on | Does |
|---|---|---|
| `host.ps1` | the owner's Windows 11 laptop (the one to be reached) | asks Windows for administrator rights (relaunches the same line with `-Verb RunAs`, built by `Get-RelaunchArguments`; that window retries the fetch on a weak line and, when it still fails, says why and waits for Enter instead of closing); installs the official RustDesk 1.5.0 MSI as a service (pinned SHA-256 + Authenticode signer `PURSLANE`; skipped when 1.5.0 or newer is there); points it at our hbbs/hbbr and their key; sets the permanent password and hardening options; keeps the laptop awake on mains power (no sleep, lid does nothing); reads the laptop's RustDesk ID and posts it to `/api/remote/hello` |
| `client.ps1` | another Windows laptop (connects) | no admin rights; the official portable 1.5.0 EXE (pinned SHA-256 + signer) saved as `%LOCALAPPDATA%\FamilyRemote\rustdesk-host=<HOST>,key=<KEY>,.exe` (RustDesk takes the server and key from its own file name); "Optimize reaction time" defaults in `%APPDATA%\RustDesk\config\RustDesk_default.toml` (merged); a desktop shortcut «Ноутбук (удалённо)» with `--connect <ID>`; the password on the clipboard for the first connection («Запомнить пароль») |

Both are Windows PowerShell 5.1 (no PS 7 syntax), print short Russian lines, never print the password, stop with one
Russian line and a non-zero exit code on any failure, and are safe to run again.

## Placeholders

Filled by appweb (`remote_script_text`), each inside PowerShell `'…'`; appweb refuses values with a single quote
(typographic ones too) or a line break, and refuses a template with an unfilled `{{NAME}}` left, so the templates
contain no other `{{…}}` text, not even in comments.

| Name | Value | In |
|---|---|---|
| `HOST` | the server's domain | both |
| `KEY` | the hbbs public key (`/etc/aibot/rustdesk.pub`; hbbs never makes one with `/`, which the file-name trick needs: its `gen_sk` makes a new pair until the public half has none — `rustdesk-utils genkeypair` does not, so the server's key must only ever be hbbs' own) | both |
| `PASSWORD` | the laptop's permanent password, 24 × `[A-Za-z0-9]` | both (client: clipboard only) |
| `TOKEN` | 32 hex: the token the script was fetched with, for the elevated window's fetch and `/hello` | host |
| `API` | `https://<domain>:8443` | host |
| `ID` | the laptop's RustDesk ID, or empty (client.ps1 then says to set the laptop up first) | client |

A command is worth little once used (it travels to the laptop through a messenger and stays there): host.ps1 and
`/hello` take "host" tokens, client.ps1 "client" ones, each good for a day while unused. Once host.ps1 is given out the
host commands shown so far end within 2 hours; once the laptop has said its ID (or client.ps1 is given out) the commands
of that kind end within 10 minutes, and the app shows a new one. A new password ends them all; the password before
stays in the app (and on the laptop) until the laptop's next `/hello`.

The phone connects with `rustdesk://<ID>@<HOST>?key=<KEY, percent-encoded>`: RustDesk 1.5.0 takes the server and key
from the link itself (`urlLinkToCmdArgs`, then `other_server` in `client.rs`), so the phone needs no set-up of its own;
the relay comes from the laptop. A bare `+` in the key would turn into a space.

Serve them as `text/plain; charset=utf-8` **without a BOM**: `irm | iex` keeps a leading BOM and PowerShell then
fails on the first line (appweb reads the files with `utf-8-sig`).

## RustDesk details the scripts rely on (checked in the 1.5.0 source)

- `rustdesk.exe --config/--option/--password/--get-id` talk to the service through the named pipe
  `\\.\pipe\RustDesk\query`. When the pipe does not answer, `--config`/`--option` quietly save into the *calling
  user's* config and `--get-id` makes up a local ID, so host.ps1 waits for the pipe first and afterwards checks the
  service's own `C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config\RustDesk2.toml`.
- The ID is stored encrypted (`enc_id` in `RustDesk.toml`), so it is read with `--get-id`, until two reads agree:
  on its first sign-up the server may answer UUID_MISMATCH and the laptop takes a new ID.
- The MSI creates and starts the service unless the installing user's own `RustDesk2.toml` says `stop-service`;
  host.ps1 then runs `--install-service`.
- With no API server set, clients try `http://HOST:21114` (RustDesk Pro only); the OSS server has none and the
  firewall drops it: harmless.

## Versions

RustDesk 1.5.0 (`rustdesk-1.5.0-x86_64.msi` `624FE792…580495`, `rustdesk-1.5.0-x86_64.exe` `85557772…5e8bb47`),
server 1.1.16. To move to a newer client: change `$Version` and the SHA-256 in both scripts and in the CI check.

## CI

`.github/workflows/remote.yml` (windows-latest; on pushes to `remote/**`; publishes nothing): parses both scripts with
Windows PowerShell 5.1 and checks the placeholders; starts the OSS server for Windows
(`rustdesk-server-windows-x86_64-unsigned.zip` 1.1.16, SHA-256 pinned) on 127.0.0.1 and a stand-in for appweb's API;
then runs the owner's exact one-line commands: client.ps1 before the laptop is set up (must stop), host.ps1 (service
running, the service's settings, the ID heard by the API, the same ID signed up in hbbs' database), host.ps1 again
(no reinstall), client.ps1 (the specially named EXE, the shortcut's target and `--connect <id>`, merged defaults) and
again (no new download); then a real connection: the portable copy started as the shortcut starts it (with
`--password`, for the test only) must log in to the laptop's service through our hbbs with our key (its notes on the
peer get the laptop's platform and name, which only a login brings; hbbs logs no "invalid key"); and the relaunch
line from host.ps1's own `Get-RelaunchArguments`, run by Windows PowerShell 5.1 the way Windows runs it (minus the
question: the runner is an administrator), must set the laptop up again, and with an old token say so and wait for
Enter. The log ends go into the run's notes when it fails.
