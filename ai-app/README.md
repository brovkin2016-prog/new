# ИИ-помощник — Android app

A light app for the family AI assistant: chat, homework from a photo ("Учёба"), photo tools, drawing, voice and a
translator. The screens are a web page (`www/`) shipped inside the APK and refreshed from the server, so most changes
need no new APK.

- `www/` — the screens (plain HTML/CSS/JS, no build step). The same page also works in a browser.
- `android/` — the shell: WebView + Cronet. All traffic goes over HTTP/3 (UDP 443), which reaches the server on mobile
  networks that cut TCP to it; TLS on TCP 8443 is the fallback. The app updates itself from the server.
- `ci/` — helpers for the GitHub Actions build: a stand-in server and the emulator test.

CI (`.github/workflows/ai-app.yml`) builds an **unsigned** APK, tests it on an emulator behind a real hysteria server and
publishes it as a release. The server signs it with its own key, so only the server can ship updates to the phones.
