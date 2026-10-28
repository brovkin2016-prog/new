#!/usr/bin/env python3
"""Winger Games — a stand-in server for checking the games without the real backend.

Serves the games at /app/games/ and the helper's shared files (fonts.css, the aurora pictures) at /app/, and answers
the four game endpoints from memory, plus /api/login, as the real server does:

  GET  /api/games/me                         → {"t":"done","user":{"id","name"},"best":{game:{level:score}},"best_ms":{…}}
  POST /api/games/score {game,level,score,ms,meta}
                                             → {"t":"done","best","best_ms","new","rank","top":[{name,score,ms,at,me}]}
  GET  /api/games/top?game=&level=&n=20      → {"t":"done","top":[…],"me":{"rank","score","ms"}|null}
  GET  /api/games/fame                       → {"t":"done","items":[{game,level,name,score,ms,at}]}
  GET  /api/games/progress?game=             → {"t":"done","stages":{"1":3,"2":1},"furthest":2}
  POST /api/games/progress {game,stage,stars} → {"t":"done","stages":{…},"furthest"}
  GET  /api/games/top?game=&kind=furthest     → rows {name,stage,stars,at,me} (furthest stage, then total stars)
  POST /api/login {code}                     → {"token":"test"} for any code that looks like XXXX-XXXX

--no-progress answers the progress endpoints with 404, as a server without them would (the client keeps progress
on the device then, and sends it up once the server has them).

Signed in = header «Authorization: Bearer <anything>»; «Bearer off» answers 403 (games switched off); none → 401.
/dev/login opens the games already signed in as the test user (puts the token where the helper keeps it).

    python3 games/dev/fake_server.py [--port 8765] [--empty] [--no-progress]
"""
import argparse
import json
import mimetypes
import os
import re
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
GAMES = os.path.dirname(HERE)
HELPER = os.path.normpath(os.path.join(GAMES, "..", "ai-app", "www"))
ME = {"id": "u1", "name": "Тест"}
TIME_RANKED = {"patience", "spider", "minesweeper"}
LEVELS = {"easy", "normal", "hard", "master", "adaptive"}
# best result per (game, level, user): {"score", "ms", "at", "name"}
BEST = {}
# stages passed per (game, user): {"stages": {n: stars}, "at", "name"}
PROG = {}
NO_PROGRESS = False


def seed():
    now = int(time.time())
    rows = [
        ("snake", "normal", "u2", "Лена", 340, 151000, now - 3600 * 5),
        ("snake", "normal", "u3", "Миша", 260, 122000, now - 86400),
        ("snake", "normal", "u4", "Бабушка Валя", 180, 140000, now - 86400 * 3),
        ("snake", "normal", "u5", "Папа", 150, 98000, now - 86400 * 6),
        ("snake", "normal", "u1", "Тест", 120, 87000, now - 86400 * 2),
        ("snake", "normal", "u6", "Алёна", 90, 64000, now - 86400 * 9),
    ]
    for game, level, uid, name, score, ms, at in rows:
        BEST[(game, level, uid)] = {"score": score, "ms": ms, "at": at, "name": name}
    for uid, name, stars, ago in [("u2", "Лена", [3, 3, 2, 3, 2, 1, 2], 2), ("u3", "Миша", [3, 2, 2, 1, 1], 30),
                                  ("u4", "Бабушка Валя", [2, 1], 80), ("u1", "Тест", [3, 1], 50)]:
        PROG[("snake", uid)] = {"stages": {i + 1: s for i, s in enumerate(stars)}, "at": now - 3600 * ago, "name": name}


def progress_of(game, uid):
    p = PROG.get((game, uid), {"stages": {}})
    st = p["stages"]
    return {"stages": {str(k): v for k, v in sorted(st.items())}, "furthest": max(st) if st else 0}


def furthest_rows(game, n):
    rows = []
    for (g, uid), p in PROG.items():
        if g != game or not p["stages"]:
            continue
        rows.append({"name": p["name"], "stage": max(p["stages"]), "stars": sum(p["stages"].values()), "at": p["at"], "me": uid == ME["id"]})
    rows.sort(key=lambda r: (-r["stage"], -r["stars"], r["at"]))
    return rows[:n]


def better(game, a, b):
    """True when result a beats result b."""
    if game in TIME_RANKED:
        return a["score"] > 0 and (b["score"] <= 0 or a["ms"] < b["ms"])
    return a["score"] > b["score"] or (a["score"] == b["score"] and a["ms"] < b["ms"])


def ranked(game, level):
    rows = [(uid, r) for (g, l, uid), r in BEST.items() if g == game and l == level]
    if game in TIME_RANKED:
        rows = [x for x in rows if x[1]["score"] > 0]
        rows.sort(key=lambda x: (x[1]["ms"], x[1]["at"]))
    else:
        rows.sort(key=lambda x: (-x[1]["score"], x[1]["ms"], x[1]["at"]))
    return rows


def top_rows(game, level, n):
    return [{"name": r["name"], "score": r["score"], "ms": r["ms"], "at": r["at"], "me": uid == ME["id"]}
            for uid, r in ranked(game, level)[:n]]


def my_rank(game, level):
    for i, (uid, r) in enumerate(ranked(game, level)):
        if uid == ME["id"]:
            return {"rank": i + 1, "score": r["score"], "ms": r["ms"]}
    return None


class H(BaseHTTPRequestHandler):
    server_version = "fake-games/1"

    def log_message(self, fmt, *args):
        if os.environ.get("QUIET"):
            return
        super().log_message(fmt, *args)

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def who(self):
        auth = self.headers.get("Authorization", "")
        tok = auth[7:].strip() if auth.startswith("Bearer ") else ""
        if not tok:
            self.send_json({"error": "Нужно войти"}, 401)
            return None
        if tok == "off":
            self.send_json({"error": "Игры выключены"}, 403)
            return None
        return ME

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 4096:
            return None
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return None

    # ---------- GET ----------
    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        if p in ("/", "/app/games"):
            return self.redirect("/app/games/")
        if p == "/dev/login":
            page = ('<!doctype html><meta charset="utf-8"><script>localStorage.setItem("token", JSON.stringify("test"));'
                    'location.replace("/app/games/");</script>')
            data = page.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        if p.startswith("/api/games/"):
            if not self.who():
                return
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            if p == "/api/games/me":
                best, best_ms = {}, {}
                for (g, l, uid), r in BEST.items():
                    if uid == ME["id"]:
                        best.setdefault(g, {})[l] = r["score"]
                        best_ms.setdefault(g, {})[l] = r["ms"]
                return self.send_json({"t": "done", "user": ME, "best": best, "best_ms": best_ms})
            if p == "/api/games/progress":
                if NO_PROGRESS:
                    return self.send_json({"error": "нет такого"}, 404)
                return self.send_json(dict(t="done", **progress_of(q.get("game", ""), ME["id"])))
            if p == "/api/games/top":
                game, level = q.get("game", ""), q.get("level", "")
                n = max(1, min(50, int(q.get("n", "20") or 20)))
                if q.get("kind") == "furthest":
                    if NO_PROGRESS:
                        return self.send_json({"error": "нет такого"}, 404)
                    rows = furthest_rows(game, 1000)
                    mine = next(({"rank": i + 1, "stage": r["stage"], "stars": r["stars"]} for i, r in enumerate(rows) if r["me"]), None)
                    return self.send_json({"t": "done", "top": rows[:n], "me": mine})
                return self.send_json({"t": "done", "top": top_rows(game, level, n), "me": my_rank(game, level)})
            if p == "/api/games/fame":
                items = []
                for game in sorted({g for (g, _, _) in BEST}):
                    best = None
                    for level in LEVELS:
                        rows = ranked(game, level)
                        if rows and (best is None or better(game, rows[0][1], best[1])):
                            best = (level, rows[0][1])
                    if best:
                        lvl, r = best
                        items.append({"game": game, "level": lvl, "name": r["name"], "score": r["score"], "ms": r["ms"], "at": r["at"]})
                return self.send_json({"t": "done", "items": items})
            return self.send_json({"error": "нет такого"}, 404)
        return self.static(p)

    # ---------- POST ----------
    def do_POST(self):
        p = urlparse(self.path).path
        data = self.body()
        if data is None:
            return self.send_json({"error": "слишком большой запрос"}, 413)
        if p == "/api/login":
            if re.fullmatch(r"[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}", str(data.get("code", ""))):
                return self.send_json({"token": "test"})
            return self.send_json({"error": "Код не подошёл"}, 401)
        if p == "/api/games/progress":
            if NO_PROGRESS:
                return self.send_json({"error": "нет такого"}, 404)
            if not self.who():
                return
            game = str(data.get("game", ""))
            try:
                stage, stars = int(data.get("stage", 0)), int(data.get("stars", 0))
            except (TypeError, ValueError):
                return self.send_json({"t": "error", "text": "Не понято", "why": "stage"})
            if not re.fullmatch(r"[a-z0-9_-]{1,32}", game) or not 1 <= stage <= 99:
                return self.send_json({"t": "error", "text": "Не понято", "why": "stage"})
            if not 1 <= stars <= 3:
                return self.send_json({"t": "error", "text": "Пройденный уровень — хотя бы одна звезда", "why": "stars"})
            rec = PROG.setdefault((game, ME["id"]), {"stages": {}, "at": int(time.time()), "name": ME["name"]})
            if stage > 1 and not rec["stages"].get(stage - 1):
                return self.send_json({"t": "error", "text": "Этот уровень ещё закрыт", "why": "locked"})
            if stars > rec["stages"].get(stage, 0):
                rec["stages"][stage] = stars
                rec["at"] = int(time.time())
            return self.send_json(dict(t="done", **progress_of(game, ME["id"])))
        if p == "/api/games/score":
            if not self.who():
                return
            game, level = str(data.get("game", "")), str(data.get("level", ""))
            if not re.fullmatch(r"[a-z0-9_-]{1,32}", game):
                return self.send_json({"t": "error", "text": "Нет такой игры", "why": "game"})
            if level not in LEVELS:
                return self.send_json({"t": "error", "text": "Нет такого уровня", "why": "level"})
            try:
                score, ms = int(data.get("score", -1)), int(data.get("ms", -1))
            except (TypeError, ValueError):
                return self.send_json({"t": "error", "text": "Результат не понят", "why": "score"})
            if score < 0 or ms < 0:
                return self.send_json({"t": "error", "text": "Результат не понят", "why": "score"})
            if len(json.dumps(data.get("meta", {}), ensure_ascii=False)) > 300:
                return self.send_json({"t": "error", "text": "Слишком много подробностей", "why": "meta"})
            if game == "snake" and score > ms / 1000 * 40 + 60:
                return self.send_json({"t": "error", "text": "Слишком много очков за такое время", "why": "implausible"})
            key = (game, level, ME["id"])
            new = {"score": score, "ms": ms, "at": int(time.time()), "name": ME["name"]}
            old = BEST.get(key)
            is_new = (score > 0) and (old is None or better(game, new, old))
            if is_new:
                BEST[key] = new
            cur = BEST.get(key) or new
            mr = my_rank(game, level)
            return self.send_json({"t": "done", "best": cur["score"], "best_ms": cur["ms"], "new": is_new,
                                   "rank": mr["rank"] if mr else None, "top": top_rows(game, level, 10)})
        return self.send_json({"error": "нет такого"}, 404)

    # ---------- files ----------
    def redirect(self, to):
        self.send_response(302)
        self.send_header("Location", to)
        self.end_headers()

    def static(self, p):
        if p.startswith("/app/games/"):
            root, rel = GAMES, p[len("/app/games/"):] or "index.html"
        elif p.startswith("/app/"):
            root, rel = HELPER, p[len("/app/"):] or "index.html"
        else:
            return self.send_json({"error": "нет такого"}, 404)
        full = os.path.normpath(os.path.join(root, rel))
        if not full.startswith(root + os.sep) or not os.path.isfile(full):
            return self.send_json({"error": "нет такого файла"}, 404)
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".webmanifest"):
            ctype = "application/manifest+json"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml", "application/manifest+json"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--empty", action="store_true", help="start with no results")
    ap.add_argument("--no-progress", action="store_true", help="answer the progress endpoints with 404")
    a = ap.parse_args()
    global NO_PROGRESS
    NO_PROGRESS = a.no_progress
    if not a.empty:
        seed()
    srv = ThreadingHTTPServer(("localhost", a.port), H)
    print(f"Winger Games: http://localhost:{a.port}/dev/login  (signed in)  ·  http://localhost:{a.port}/app/games/")
    srv.serve_forever()


if __name__ == "__main__":
    main()
