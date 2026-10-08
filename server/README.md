# Family server updates

The server installer is private. Each version is encrypted with this server's own public key (`update-key.pub`, kept
here once the owner has sent it) and published by the `server` workflow as the release `server-vNN`:

- `release/installer.enc` — the installer, AES-256 (the key below decrypts it);
- `release/key.enc` — that AES key, encrypted with RSA-OAEP for `update-key.pub`;
- `release/release.json` — version, SHA-256 of the plain installer, the key's fingerprint, what is new.

On the server `srv-update check` (a timer, twice a day) finds the newest `server-vNN` made for its key, and the owner
presses «⬆️ Обновить» in the app: `srv-update apply` downloads, decrypts with its private key, checks the SHA-256 and
the version inside, and runs the installer with nobody at the keyboard (AUTO=1).
