# Secure headless dev box on Ubuntu 22.04 (EU VPS)

Target state:

- SSH only with keys, only as `dev`, and **only through WireGuard** — port 22 is closed on the public IP.
- WireGuard is the single public service (UDP 51820). It stays silent to anyone without a valid key.
- Node.js LTS runs under `dev` without root. The AI coding assistant cannot use `sudo` without a password.
- `tmux` keeps sessions alive across disconnects.

Placeholders — replace before running:

| Placeholder | Meaning |
|---|---|
| `203.0.113.10` | VPS public IPv4 |
| `dev` | your non-root user |
| `10.8.0.0/24` | WireGuard subnet (`10.8.0.1` = VPS, `10.8.0.2` = laptop) |

> **Ubuntu 24.04:** every step works unchanged, with two differences.
> - sshd is socket-activated. `systemctl restart ssh` still applies the settings from step 1.3. Only a change of `Port` or `ListenAddress` needs `sudo systemctl daemon-reload && sudo systemctl restart ssh.socket`.
> - The apt `nodejs` package is 18 (EOL), so still use nvm.

> **Work in this order.** Keep one SSH session open until the next step is verified from a **new**
> terminal. Check that the provider's web/VNC/serial console works before you start. It is your
> only way back in if you lock yourself out.

---

## 0. Base system (as root)

```bash
apt update && apt full-upgrade -y
apt install -y unattended-upgrades ca-certificates curl gnupg
dpkg-reconfigure --priority=low unattended-upgrades   # answer "Yes"
timedatectl set-timezone Europe/Berlin                # or UTC; correct time matters for logs
```

**Security:** unattended-upgrades applies security patches daily. Kernel updates still need a
reboot. Watch for `/var/run/reboot-required`. You can also set `Unattended-Upgrade::Automatic-Reboot "true";`
in `/etc/apt/apt.conf.d/50unattended-upgrades`, but a reboot kills your tmux sessions.

---

## 1. Non-root sudo user + SSH keys only

### 1.1 Create the user (on the VPS, as root)

```bash
adduser dev              # set a long, unique password: you use it for sudo and the provider console, never for SSH
usermod -aG sudo dev
```

### 1.2 Create a key and install it (on your laptop)

```bash
ssh-keygen -t ed25519 -a 100 -f ~/.ssh/id_ed25519_devbox -C "dev@laptop-$(date +%F)"
ssh-copy-id -i ~/.ssh/id_ed25519_devbox.pub dev@203.0.113.10
ssh -i ~/.ssh/id_ed25519_devbox dev@203.0.113.10          # must log in without a password prompt
```

If `ssh-copy-id` is missing (Windows), append the `.pub` content to `/home/dev/.ssh/authorized_keys` yourself and run:

```bash
chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys
```

- **Why Ed25519:** a small, fast key that resists weak-randomness failures better than ECDSA.
- **Why `-a 100`:** 100 KDF rounds slow down brute force of the passphrase if the private key file is stolen. Always set a passphrase and use `ssh-agent` locally.

### 1.3 Harden sshd

On Ubuntu 22.04, `/etc/ssh/sshd_config` includes `sshd_config.d/*.conf` **at the top**, and for
each option sshd uses the **first** value it reads. A file named `00-*.conf` therefore overrides
both the main file and cloud-init's `50-cloud-init.conf`, which often sets `PasswordAuthentication yes`.

```bash
sudo tee /etc/ssh/sshd_config.d/00-hardening.conf >/dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowUsers dev

MaxAuthTries 3
LoginGraceTime 20
ClientAliveInterval 300
ClientAliveCountMax 2

X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding local
PermitTunnel no
EOF

sudo sshd -t                                   # syntax check; no output means OK
sudo sshd -T | grep -Ei '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|allowusers|authenticationmethods) '
sudo systemctl restart ssh
```

Verify from a **new** terminal while the old session stays open:

```bash
ssh -i ~/.ssh/id_ed25519_devbox dev@203.0.113.10                                       # works
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password dev@203.0.113.10   # Permission denied (publickey)
ssh root@203.0.113.10                                                                   # Permission denied
```

Then lock root's password and remove its keys:

```bash
sudo passwd -l root
sudo truncate -s0 /root/.ssh/authorized_keys 2>/dev/null || true
```

What each setting protects against:

| Setting | Threat removed |
|---|---|
| `PermitRootLogin no` | Attackers must guess a username and still can't land directly as uid 0. Every privileged action goes through `sudo`, which leaves an audit trail. |
| `PasswordAuthentication no`, `KbdInteractiveAuthentication no` | Ends credential stuffing and brute force. The only way in is a private key. |
| `AllowUsers dev` | Service or system accounts that someone later gives a shell can't log in over SSH. |
| `AllowAgentForwarding no` | Root on the VPS, or a compromised process running as `dev` (including an AI agent), can't use your laptop's keys through the forwarded agent socket. Give the VPS its own scoped deploy key or token for GitHub instead. |
| `AllowTcpForwarding local` | `ssh -L 5173:localhost:5173 devbox` still works for viewing dev servers. Remote and reverse forwarding, which could expose laptop services to the VPS, is blocked. Section 6.2 allows it for specific MCP ports only. |

---

## 2. WireGuard tunnel

This setup is **split-tunnel, host-only**: the laptop reaches `10.8.0.1` (the VPS) and nothing
else. There is no IP forwarding and no NAT, so the VPS is not a router or VPN exit, and a stolen
peer key reaches only this one host.

### 2.1 Install and create server keys (VPS)

```bash
sudo apt install -y wireguard
sudo sh -c 'umask 077; cd /etc/wireguard && wg genkey | tee server.key | wg pubkey > server.pub'
sudo cat /etc/wireguard/server.pub      # copy this, the laptop needs it
```

### 2.2 Create client keys (laptop)

Generate the keys on the device that will use them. The private key never leaves the laptop.

```bash
# Linux/macOS with wireguard-tools
umask 077
wg genkey | tee devbox.key | wg pubkey > devbox.pub
wg genpsk > devbox.psk      # pre-shared key: shared secret, copy to the VPS over your SSH session
```

The Windows, macOS and iOS WireGuard apps generate the key pair themselves (*Add empty tunnel*). Copy the public key they show.

### 2.3 `/etc/wireguard/wg0.conf` (VPS)

```bash
sudoedit /etc/wireguard/wg0.conf
```

```ini
[Interface]
Address    = 10.8.0.1/24
ListenPort = 51820
PrivateKey = <contents of /etc/wireguard/server.key>
SaveConfig = false

[Peer]
# laptop
PublicKey    = <contents of devbox.pub>
PresharedKey = <contents of devbox.psk>
AllowedIPs   = 10.8.0.2/32
```

```bash
sudo chmod 600 /etc/wireguard/wg0.conf
sudo systemctl enable --now wg-quick@wg0
sudo wg show                   # interface up, peer listed
sysctl net.ipv4.ip_forward     # 0 = the VPS is not a router (Docker flips it to 1, see step 3)
```

If the provider has a cloud firewall (for example Hetzner Cloud Firewall or OVH Network Firewall), allow **UDP 51820** there too.

### 2.4 Client config (laptop): `devbox.conf`

```ini
[Interface]
Address    = 10.8.0.2/32
PrivateKey = <contents of devbox.key>
# No DNS= line: split tunnel, the laptop keeps its own DNS resolver.

[Peer]
PublicKey           = <contents of server.pub>
PresharedKey        = <contents of devbox.psk>
Endpoint            = 203.0.113.10:51820
AllowedIPs          = 10.8.0.1/32
PersistentKeepalive = 25
```

```bash
# Linux
sudo install -m 600 devbox.conf /etc/wireguard/devbox.conf
sudo wg-quick up devbox
ping -c3 10.8.0.1
ssh -i ~/.ssh/id_ed25519_devbox dev@10.8.0.1     # SSH over the tunnel
```

On macOS or Windows, import `devbox.conf` into the WireGuard app and activate it.

Laptop `~/.ssh/config`:

```sshconfig
Host devbox
    HostName 10.8.0.1
    User dev
    IdentityFile ~/.ssh/id_ed25519_devbox
    IdentitiesOnly yes
    ServerAliveInterval 60
```

### 2.5 Adding or revoking a device

Edit `wg0.conf` (add or remove a `[Peer]` block with a unique `/32`), then run:

```bash
sudo systemctl reload wg-quick@wg0     # applies the change with wg syncconf; existing tunnels stay up
```

What WireGuard's design gives you:

- **It stays silent.** WireGuard drops any packet without a valid key and never replies, so port scans can't find it. That makes UDP 51820 a far smaller target than a public sshd.
- **Cryptokey routing.** A packet arriving on `wg0` from `10.8.0.2` is accepted only if the laptop's key authenticated it. The firewall rule in step 3 can therefore trust the source address.
- **PresharedKey.** Adds a symmetric secret on top of Curve25519, as a hedge against future quantum attacks on recorded traffic. Use a different PSK for each peer.
- **Key hygiene.** `umask 077`, mode `600` configs, one key pair per device. Revoke a lost device by deleting its peer.

---

## 3. UFW: SSH only via `wg0`

The order matters: add the WireGuard rule and a **temporary** public SSH rule before you enable the firewall.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 51820/udp comment 'WireGuard'
sudo ufw allow in on wg0 from 10.8.0.0/24 to any port 22 proto tcp comment 'SSH via WireGuard only'
sudo ufw allow 22/tcp comment 'TEMP bootstrap - delete after WG test'
sudo ufw enable
sudo ufw status verbose
```

In a **new** terminal with the tunnel up, check that `ssh devbox` works. Then remove the public rule:

```bash
sudo ufw delete allow 22/tcp
sudo ufw status numbered
```

Expected state:

```
To                         Action      From
--                         ------      ----
51820/udp                  ALLOW IN    Anywhere
22/tcp on wg0              ALLOW IN    10.8.0.0/24
51820/udp (v6)             ALLOW IN    Anywhere (v6)
```

Your current session over the public IP survives this, because UFW keeps `ESTABLISHED` connections.
New ones are dropped. Check from the laptop **with WireGuard down**:

```bash
nc -vz -w5 203.0.113.10 22      # times out
nmap -Pn -p22 203.0.113.10      # 22/tcp filtered
```

**Security:** the public attack surface is now one silent UDP port. Brute force, sshd pre-auth
bugs and scanner noise can't reach sshd. `fail2ban` is no longer needed for SSH. To reach a
dev server, prefer `ssh -L`. If you must open a port, scope it the same way:
`sudo ufw allow in on wg0 to any port 5173 proto tcp`.

**Optional hardening (with a trade-off):** add `ListenAddress 10.8.0.1` to sshd so it doesn't even
bind to the public IP. The catch: if `wg0` fails to come up at boot, sshd fails too and only the
provider console gets you back in. The UFW rule already gives the same protection, so skip this
unless you really need it.

### ⚠️ Docker bypasses UFW

Docker writes its own iptables NAT/FORWARD rules. A published port such as `ports: ["5432:5432"]`
therefore reaches the internet **even with `default deny incoming`**. This repo's
`docker-compose.yml` publishes Postgres (5432), Redis (6379), 8000, 3000 and 5173 like that.
On this VPS, bind them to loopback or to the tunnel address:

```yaml
ports: ["127.0.0.1:5432:5432"]     # reachable only from the VPS itself or via ssh -L
ports: ["10.8.0.1:5173:5173"]      # reachable only over WireGuard
```

Audit what is actually listening with `sudo ss -tulpn` and `sudo iptables -L DOCKER -n`.

---

## 4. Node.js LTS + AI coding assistant

### 4.1 Build tools

```bash
sudo apt install -y build-essential git ripgrep jq unzip
```

Do **not** install `apt install nodejs`: Ubuntu 22.04 ships Node 12, which is end-of-life.

### 4.2 Node via nvm (as `dev`, no sudo)

```bash
NVM_VERSION=v0.40.8      # latest tag in Sep 2026: https://github.com/nvm-sh/nvm/releases
curl -fsSLo /tmp/nvm-install.sh "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh"
less /tmp/nvm-install.sh # read it before running it
bash /tmp/nvm-install.sh && rm /tmp/nvm-install.sh
source ~/.bashrc

nvm install --lts        # Active LTS; in Sep 2026 that is 24.x "Krypton"
nvm alias default 'lts/*'
node -v && npm -v
```

Upgrading to a new LTS later: `nvm install --lts --reinstall-packages-from=current`.

**Why nvm rather than NodeSource/apt:** everything lives in `~/.nvm` and belongs to `dev`, so
`npm install -g` never needs `sudo`. With a root-owned Node, global installs run package
`postinstall` scripts **as root**, which is a supply-chain risk. The downside is that apt
doesn't update Node, so you run the upgrade above yourself.

### 4.3 Install Claude Code (Anthropic CLI)

Install from Anthropic's signed apt repository. The package is installed by root, so the agent,
which runs as `dev`, can't modify its own binary. Updates come through `apt` (the `upd` alias).

```bash
sudo install -d -m 0755 /etc/apt/keyrings
sudo curl -fsSL https://downloads.claude.ai/keys/claude-code.asc -o /etc/apt/keyrings/claude-code.asc
gpg --show-keys /etc/apt/keyrings/claude-code.asc
# fingerprint MUST be 31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE, otherwise stop here
echo "deb [signed-by=/etc/apt/keyrings/claude-code.asc] https://downloads.claude.ai/claude-code/apt/stable stable main" \
  | sudo tee /etc/apt/sources.list.d/claude-code.list
sudo apt update && sudo apt install -y claude-code
claude --version && claude doctor
```

Alternatives:

- `curl -fsSL https://claude.ai/install.sh | bash`: installs to `~/.local`, auto-updates.
- `npm install -g @anthropic-ai/claude-code`: needs Node ≥ 22; never run it with `sudo`.

Both put the binary somewhere `dev` can write to.

### 4.4 API key via environment variable

The key lives in a mode-600 file, and `~/.bashrc` exports it as `ANTHROPIC_API_KEY` (see the
`.bashrc` section). The key never appears in `.bashrc` itself, so your dotfiles are safe to share,
and it doesn't go through the command line or shell history:

```bash
mkdir -p ~/.config/secrets && chmod 700 ~/.config/secrets
read -rsp 'Anthropic API key: ' KEY; echo
printf 'ANTHROPIC_API_KEY=%q\n' "$KEY" > ~/.config/secrets/ai.env; unset KEY
chmod 600 ~/.config/secrets/ai.env
source ~/.bashrc && claude    # first launch asks once to approve the key; check it with /status
```

- `ANTHROPIC_API_KEY` takes precedence over a claude.ai subscription login, so usage is billed to the Console/API account. To use a Pro/Max plan, unset the variable and run `/login`. On a headless VPS, open the URL on your laptop and paste the code back.
- **Trade-off:** an exported variable reaches every process started from your shell. That includes the commands the agent runs and `postinstall` scripts. To keep the key out of the environment, don't export it. Put the bare key in a 600 file and set `"apiKeyHelper": "cat ~/.config/secrets/anthropic.key"` in `~/.claude/settings.json`. This hides the key from environment dumps, but not from a process that runs as `dev` and reads files.

### 4.5 Security implications of running an AI agent

- **The agent runs as `dev`.** Every command it executes has `dev`'s rights: your home, your repos, your keys on the VPS. Never give `dev` `NOPASSWD` sudo. With a sudo password, the agent can't become root without you. Check with `sudo -k; sudo -n true`, which should print "a password is required".
- **No agent forwarding.** This is enforced in 1.3. For git, use a fine-grained token or deploy key limited to the repos you need, and set an expiry.
- **Secrets.** Keep `.env` files out of git (the repo already provides `.env.example`) and out of prompts. Use the assistant's permission or allow-list settings so it asks before running commands or editing files.
- **Data residency.** The VPS is in the EU, but prompts and code sent to the AI vendor leave it. If the code or data includes personal data, check the vendor's DPA and region options (GDPR).
- **Isolation (optional):** for untrusted repos, run the agent as a second user without sudo, or inside a container.

### 4.6 Swap (VPS with ≤ 2 GB RAM)

`npm install`, TypeScript builds and Docker can run out of memory on a small VPS. Add compressed
RAM swap (zram, uses no disk) plus a small swapfile as a fallback:

```bash
sudo apt install -y zram-tools
printf 'ALGO=zstd\nPERCENT=50\n' | sudo tee /etc/default/zramswap && sudo systemctl restart zramswap

sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile      # 2G if the disk is ≥ 40 GB
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
swapon --show                                                   # zram (prio 100) is used first
```

---

## 5. tmux: persistent sessions

```bash
sudo apt install -y tmux      # 3.2a on 22.04
```

### `~/.tmux.conf`

```tmux
# Prefix Ctrl-a
unbind C-b
set -g prefix C-a
bind C-a send-prefix

set -g mouse on
set -g history-limit 50000
set -g base-index 1
setw -g pane-base-index 1
set -g renumber-windows on
set -sg escape-time 10
set -g focus-events on
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",xterm-256color:RGB"
setw -g mode-keys vi

# "external": tmux copy-mode can push to your local clipboard (OSC 52),
# but programs inside tmux (including the AI agent) cannot write to it.
set -g set-clipboard external

# New panes/windows open in the current directory
bind | split-window -h -c "#{pane_current_path}"
bind - split-window -v -c "#{pane_current_path}"
bind c new-window -c "#{pane_current_path}"
bind r source-file ~/.tmux.conf \; display "tmux.conf reloaded"

set -g status-left  "#[bold]#S#[default] | "
set -g status-right "#H | %Y-%m-%d %H:%M"
```

Everyday use:

- Detach: `Ctrl-a d`. You can close the laptop and the processes keep running.
- Reattach: `ta`.
- List sessions: `tmux ls`.

Security notes:

- The tmux socket is `/tmp/tmux-$(id -u)/default` in a `0700` directory, so other users can't attach. Don't loosen its permissions or share sockets with `-S` in world-writable paths.
- Sessions keep running after disconnect, and so does a running agent. The scrollback also keeps anything printed on screen, secrets included. Clear it with `Ctrl-a :clear-history` and kill sessions you no longer need.
- Ubuntu's logind has `KillUserProcesses=no`, so tmux survives logout but **not a reboot**.

---

## 6. MCP servers over SSH tunnels

Only MCP servers with the **HTTP/SSE transport** need a port. A **stdio** server runs as a child
process of `claude` on the same host, so it needs no tunnel:

```bash
claude mcp add --transport stdio --scope user <name> -- npx -y <package>
claude mcp list
```

Keep both ends of every tunnel on `127.0.0.1`. UFW always allows `lo`, so no new firewall rules are needed.

### 6.1 MCP server on the VPS, client on the laptop: `ssh -L`

Example: an HTTP MCP server on the VPS at `127.0.0.1:8931`, used from the laptop (Claude Desktop or a local `claude`).
The server must bind to `127.0.0.1`, **not** `0.0.0.0`. In Docker, publish it as `127.0.0.1:8931:8931`
(see "Docker bypasses UFW").

```bash
# laptop
ssh -N -L 127.0.0.1:8931:127.0.0.1:8931 devbox
claude mcp add --transport http vps-tools http://127.0.0.1:8931/mcp
```

`AllowTcpForwarding local` from step 1.3 already allows this.

### 6.2 MCP server on the laptop, Claude Code on the VPS: `ssh -R`

Example: an MCP server that must run next to your local apps or intranet, listening on the laptop at `127.0.0.1:3845`.
Enable remote forwarding on the VPS, restricted to the listed ports:

```bash
# VPS
sudo sed -i 's/^AllowTcpForwarding local$/AllowTcpForwarding yes/' /etc/ssh/sshd_config.d/00-hardening.conf
sudo tee /etc/ssh/sshd_config.d/10-mcp-forwarding.conf >/dev/null <<'EOF'
# ssh -R may listen only on these ports (always loopback: GatewayPorts stays "no")
PermitListen 3845
# ssh -L may reach only services on the VPS itself; the VPS can't be used as a jump host
PermitOpen localhost:* 127.0.0.1:*
EOF
sudo sshd -t && sudo systemctl reload ssh
sudo sshd -T | grep -Ei '^(allowtcpforwarding|permitlisten|permitopen|gatewayports) '
```

```bash
# laptop
ssh -N -R 3845:127.0.0.1:3845 devbox
# VPS
claude mcp add --transport http --scope user laptop-tools http://127.0.0.1:3845/mcp
```

**Security:** any local process on the VPS can reach the forwarded `127.0.0.1:3845`. That
includes the agent, other users and containers on the host network, so the tunnel is a path
from the VPS into your laptop. To limit that:

- Forward only the ports you need. Add each new one to `PermitListen`.
- Require a token on the MCP server if it supports one (`--header "Authorization: Bearer …"`, typed with a leading space so it stays out of history).
- Keep the tunnel up only while you use it.

### 6.3 Tunnel profile (laptop `~/.ssh/config`)

Use a separate alias for the tunnel. If the forwards lived on `devbox`, every normal `ssh devbox` would try
to bind the same ports, and the second session would fail:

```sshconfig
Host devbox-mcp
    HostName 10.8.0.1
    User dev
    IdentityFile ~/.ssh/id_ed25519_devbox
    IdentitiesOnly yes
    ExitOnForwardFailure yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
    LocalForward  127.0.0.1:8931 127.0.0.1:8931
    RemoteForward 3845 127.0.0.1:3845
```

```bash
ssh -fN devbox-mcp              # background, no shell, so tmux doesn't auto-attach
pkill -f 'ssh -fN devbox-mcp'   # stop
```

For automatic reconnects, use `autossh -M 0 -fN devbox-mcp`. Inside `claude`, `/mcp` shows server
status and reconnects a server after the tunnel comes back.

---

## 7. Minimal profile: small VPS shared with other services

Written for a 1 vCPU / 2 GB / 10 GB VPS that already runs other workloads. Goals: add no more than
about 0.5 GB of disk, cap the agent's RAM and CPU so it can't starve the existing services, and not
break their access.

### 7.1 Inventory first

```bash
sudo ss -tulpn                                   # public listeners: each one needs a UFW allow rule
sudo ufw status; sudo nft list ruleset | head -40
getent passwd | awk -F: '$7 ~ /sh$/ {print $1}'  # accounts with a login shell
sudo sh -c 'awk "{print FILENAME\": \"\$NF}" /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys 2>/dev/null'   # who can log in
df -h /; sudo du -xh --max-depth=1 / 2>/dev/null | sort -h | tail -8
journalctl --disk-usage; snap list 2>/dev/null
```

Adjust the hardening steps to what you find:

- **UFW (step 3).** Before `ufw enable`, add `allow` rules for every public service in use, for example `sudo ufw allow 80,443/tcp` and any panel port. Otherwise `default deny incoming` takes those services offline.
- **SSH (step 1.3).** `AllowUsers dev`, `PermitRootLogin no` and moving SSH behind WireGuard block every other login: deploy scripts, rsync/SFTP backups, panel users. Add those accounts to `AllowUsers`. For automation that connects from outside, keep a scoped rule such as `sudo ufw allow from <backup-ip> to any port 22 proto tcp`. Where root must log in, use `PermitRootLogin prohibit-password`.

### 7.2 Free disk space

Keep at least 1 GB free at all times. At 100 % disk, the other services' databases and logs start failing.

```bash
sudo apt clean && sudo apt autoremove --purge -y       # package cache + old kernels
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\n' | sudo tee /etc/systemd/journald.conf.d/size.conf
sudo systemctl restart systemd-journald && sudo journalctl --vacuum-size=100M
sudo snap set system refresh.retain=2 2>/dev/null     # snapd keeps fewer old revisions
docker system df 2>/dev/null                           # if Docker is used: check, prune only what you recognize
```

### 7.3 What to install

| Component | Disk | RAM | Decision |
|---|---|---|---|
| WireGuard, tmux, zram-tools | < 10 MB | ~0 | install |
| Claude Code, apt package (§4.3) | ~0.25 GB | 0.3–0.5 GB while running | install. apt keeps one version; the native installer keeps several |
| Node.js via nvm (§4.2) | ~0.2 GB | only while running | **skip** unless you need JS projects or `npx` MCP servers. Claude Code does not need Node |
| Swapfile (§4.6) | 1 GB | — | **skip**, use zram only (below) |
| This repo's docker-compose stack | 5+ GB | 2+ GB | **not on this VPS** |

```bash
sudo apt install -y wireguard tmux zram-tools
printf 'ALGO=zstd\nPERCENT=50\n' | sudo tee /etc/default/zramswap && sudo systemctl restart zramswap
# then Claude Code per §4.3, followed by:
sudo apt clean
mkdir -p ~/.claude && echo '{ "cleanupPeriodDays": 7 }' > ~/.claude/settings.json   # prune old session transcripts
```

If `~/.claude/settings.json` already exists, add the key to it instead of overwriting the file.

### 7.4 Cap the agent

Run Claude Code in its own cgroup. The limits also cover everything the agent starts (`npm install`, builds, tests):

```bash
sudo loginctl enable-linger dev     # keep the user systemd instance up, so this also works from tmux after reconnects
```

```bash
# ~/.bashrc
alias cc='systemd-run --user --scope --quiet -p MemoryHigh=600M -p MemoryMax=900M -p CPUQuota=50% claude'
```

- **`MemoryHigh`.** Above this level the kernel throttles the scope and reclaims its memory.
- **`MemoryMax`.** A hard ceiling. When it is hit, the OOM killer acts **inside this scope only**, so it never kills the other services.
- **`CPUQuota=50%`.** Leaves at least half of the single vCPU to the existing workloads.
- **Monitoring.** Watch live usage with `systemd-cgtop`, and check headroom with `free -h; df -h /`.

---

## `~/.bashrc` additions

Append these lines. The nvm installer has already added its own lines, so don't duplicate them.

```bash
# ---- devbox ----
export EDITOR=vim
export HISTCONTROL=ignoreboth          # a command starting with a space is not saved to history
export HISTSIZE=10000 HISTFILESIZE=20000
shopt -s histappend

# Anthropic API key -> ANTHROPIC_API_KEY for all shells (the value lives in a 600 file, not here)
if [ -r "$HOME/.config/secrets/ai.env" ]; then
  set -a; . "$HOME/.config/secrets/ai.env"; set +a
fi

# tmux
alias ta='tmux new-session -A -s main'
alias tai='tmux new-session -A -s ai -c "$PWD"'     # separate session for the agent
alias tl='tmux ls'

# ops / security checks
alias fw='sudo ufw status verbose'
alias wgs='sudo wg show'
alias ports='sudo ss -tulpn'
alias sshlog='sudo journalctl -u ssh --since "24h ago" --no-pager | tail -n 50'
alias upd='sudo apt update && sudo apt full-upgrade'
alias needreboot='[ -f /var/run/reboot-required ] && cat /var/run/reboot-required.pkgs || echo "no reboot needed"'
alias ll='ls -alF'

# Auto-attach tmux on interactive SSH logins (keep this block LAST).
# Not `exec tmux`: if tmux breaks you still get a plain shell instead of being locked out.
# $SSH_TTY is unset for scp/rsync/non-interactive ssh, so those don't trigger it.
if [[ $- == *i* && -n "$SSH_TTY" && -z "$TMUX" ]] && command -v tmux >/dev/null; then
  tmux new-session -A -s main
fi
```

---

## Final checklist

| Check | Expected |
|---|---|
| `sudo sshd -T \| grep -E '^(permitrootlogin\|passwordauthentication) '` | `no` / `no` |
| `nc -vz -w5 203.0.113.10 22` from outside, WG down | timeout |
| `ssh devbox`, WG up | logs in, lands in tmux `main` |
| `sudo wg show` | recent `latest handshake` |
| `sudo ufw status` | only `51820/udp` + `22/tcp on wg0` |
| `sudo ss -tulpn` | nothing unexpected on `0.0.0.0` / `[::]`; check Docker ports too |
| `sysctl net.ipv4.ip_forward` | `0` (unless Docker is installed, which sets it to 1; then bind its ports as in step 3) |
| `sudo -k; sudo -n true` | "a password is required" |
| `node -v` | `v24.x` |
| `claude doctor` | no errors |
| `ss -tln \| grep -E '3845\|8931'` (tunnel up) | `127.0.0.1` only, never `0.0.0.0` |

## Lockout recovery

1. Open the provider's web, VNC or serial console and log in as `dev` with the password from step 1.1.
2. `sudo systemctl status wg-quick@wg0`: fix it and `sudo systemctl restart wg-quick@wg0`.
3. As a last resort: `sudo ufw allow 22/tcp`. Fix the problem, then delete the rule again.
