#!/usr/bin/env python3
"""A stand-in for the assistant's server in the emulator test: signs in with TEST-CODE, answers in a stream."""
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WWW = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "www")
ME = {"name": "Тест", "vip": False, "limits": {"text": [0, 100], "draw": [0, 15], "photo": [0, 40], "video": [0, 5]},
      "mode": "chat", "model": "auto", "modes": {"chat": "💬 Собеседник"}, "models": {"auto": "✨ Авто"}, "vreply": False,
      "trans": None, "voice": "irina", "voices": {}, "langs": {"en": ["🇬🇧", "Английский"]}, "ideas": {}, "styles": {},
      "photo_ops": {"bw": "⬛ Ч/Б"}, "ai_ops": {"describe": "🔍 Что на фото"},
      "can": {"draw": False, "speak": False, "hear": False, "listen": False, "pdf": False}, "memory": []}


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        print("stub:", self.command, self.path, flush=True)

    def send(self, code, data, ctype="application/json"):
        data = json.dumps(data, ensure_ascii=False).encode() if not isinstance(data, bytes) else data
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/app/"):
            name = path[5:] or "index.html"
            if name == "apk.json":
                return self.send(200, {"code": 1, "name": "1.0.1", "size": 1, "sha256": "0"})
            f = os.path.join(WWW, name)
            if os.path.isfile(f) and ".." not in name:
                return self.send(200, open(f, "rb").read(), "text/plain")
        self.send(200, b"<html>plain site</html>", "text/html")

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        if self.path == "/api/login":
            ok = body.get("code", "").replace("-", "").upper() == "TESTCODE"
            return self.send(200 if ok else 403, {"token": "tok", "name": "Тест"} if ok else {"error": "Неверный код"})
        if self.headers.get("Authorization") != "Bearer tok":
            return self.send(401, {"error": "Нужно войти"})
        if self.path == "/api/me":
            return self.send(200, ME)
        if self.path == "/api/chat":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            for w in "Привет! Это ответ сервера через приложение.".split(" "):
                self.wfile.write(b"data: " + json.dumps({"t": "delta", "text": w + " "}, ensure_ascii=False).encode() + b"\n\n")
                self.wfile.flush()
                time.sleep(0.2)
            done = {"t": "done", "text": "Привет! Это ответ сервера через приложение.", "label": "🧪 тест", "user": body.get("text", "")}
            self.wfile.write(b"data: " + json.dumps(done, ensure_ascii=False).encode() + b"\n\n")
            self.close_connection = True
            return
        self.send(404, {"error": "нет"})


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
