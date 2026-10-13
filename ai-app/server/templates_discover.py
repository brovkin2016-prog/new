#!/usr/bin/env python3
"""Finds more video templates on Mixkit (free stock clips, free to use) where GitHub's runners can reach it: walks the
tag and search pages below, takes each clip's 720p file, cuts 5 seconds the way the family server will (9:16, 480×854)
and counts the people in it (templates_faces.py). Writes discover.json (per clip: id, page, size, people, the biggest
face's height) and contact sheets of the clips with 1–3 visible faces, each tile labelled with its id and people, to
pick the templates from by eye. Nothing of the videos is kept.
   python3 ai-app/server/templates_discover.py out/ [max clips] [previous discover.json]"""
import json, os, re, subprocess, sys, time, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from templates_faces import faces  # noqa: E402

OUT = sys.argv[1]
MAX = int(sys.argv[2]) if len(sys.argv) > 2 else 1200
PREV = sys.argv[3] if len(sys.argv) > 3 else ""  # the previous run's discover.json: the clips there are not looked at again
SECONDS = 5
os.makedirs(OUT, exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"}
# reels as people post them (selfie and vlog shots with big faces, friends, trips) and what they make of themselves:
# dances, film heroes, holidays, sport, fashion, couples, kids
QUERIES = list(dict.fromkeys([
    "selfie", "vlog", "talking to camera", "influencer", "friends selfie", "couple selfie", "family selfie", "road trip",
    "sunset", "smiling woman", "smiling man", "man sunglasses", "woman portrait", "man portrait", "close up face", "happy",
    "laughing", "surprised", "cheering", "winner", "thumbs up", "waving", "applause", "group of friends",
    "people having fun", "teenager", "student", "dancing in the street", "vertical dance", "dance", "dancing woman",
    "dancing man", "hip hop", "party", "festival", "carnival", "cheers", "birthday", "celebration", "christmas", "new year",
    "santa claus", "halloween", "valentine", "wedding", "bride", "wedding dance", "graduation", "superhero", "action",
    "martial arts", "boxing", "sword", "cowboy", "pirate", "astronaut", "wizard", "spy", "detective", "football",
    "basketball", "soccer fan", "skateboard", "fitness", "gym", "yoga", "beach", "travel", "summer", "winter", "snow",
    "autumn", "city", "night city", "car", "motorcycle", "fashion", "model", "runway", "makeup", "couple", "romantic",
    "love", "friends", "family", "mother", "father", "grandmother", "grandfather", "kids", "child", "funny", "singing",
    "karaoke", "dj", "concert", "gamer", "cooking", "coffee", "restaurant", "shopping", "office", "retro", "80s", "neon"]))


def get(url, timeout=40):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(6 << 20).decode("utf-8", "replace")


def pages(q):
    slug = q.replace(" ", "-")
    yield f"https://mixkit.co/free-stock-video/{slug}/"
    yield f"https://mixkit.co/free-stock-video/{slug}/?page=2"
    for n in (1, 2, 3, 4):
        yield f"https://mixkit.co/free-stock-video/discover/{urllib.parse.quote(slug)}/" + (f"?page={n}" if n > 1 else "")


def listing(known=()):
    """(id, page, query) of the clips on the tag and search pages, the first query's first; known ones left out."""
    seen, out = set(known), []
    for q in QUERIES:
        got = 0
        for page in pages(q):
            try:
                html = get(page)
            except Exception as e:
                print("page", page, str(e)[:80], flush=True)
                continue
            for slug, num in re.findall(r'href="(?:https://mixkit\.co)?/free-stock-video/([a-z0-9-]+?)-(\d+)/"', html):
                if num not in seen:
                    seen.add(num)
                    out.append((num, f"https://mixkit.co/free-stock-video/{slug}-{num}/", q))
                    got += 1
        print(f"query {q!r}: {got} new clips", flush=True)
    return out


def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
                        "-of", "json", path], capture_output=True, text=True)
    js = json.loads(r.stdout or "{}")
    s = (js.get("streams") or [{}])[0]
    return float((js.get("format") or {}).get("duration") or 0), s.get("width"), s.get("height")


def one(num, page, q):
    src, cut = f"{OUT}/{num}.mp4", f"{OUT}/{num}.cut.mp4"
    try:
        for size in ("720", "360", "1080"):
            url = f"https://assets.mixkit.co/videos/{num}/{num}-{size}.mp4"
            try:
                req = urllib.request.Request(url, headers=UA)
                with urllib.request.urlopen(req, timeout=60) as r, open(src, "wb") as f:
                    f.write(r.read(60 << 20))
                break
            except Exception:
                url = None
        if not url:
            return {"id": "m" + num, "page": page, "query": q, "ok": False, "why": "no file"}
        dur, w, h = probe(src)
        if dur < SECONDS:
            return {"id": "m" + num, "page": page, "query": q, "ok": False, "why": f"short {dur:.1f} s"}
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-t", str(SECONDS),
                            "-vf", "scale=480:854:force_original_aspect_ratio=increase,crop=480:854,fps=25",
                            "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", cut], capture_output=True, text=True)
        if r.returncode:
            return {"id": "m" + num, "page": page, "query": q, "ok": False, "why": "cut: " + r.stderr[-120:]}
        people, counts, tallest = faces(cut, SECONDS, OUT, keep=f"{OUT}/t-{num}.jpg")
        return {"id": "m" + num, "page": page, "query": q, "ok": True, "url": url, "w": w, "h": h, "duration": round(dur, 1),
                "faces": people, "face_counts": counts, "face_h": tallest}
    finally:
        for p in (src, cut):
            if os.path.exists(p):
                os.remove(p)


def sheets(res):
    """Contact sheets of the clips with 1–3 faces, the biggest faces first: 6 × 4 tiles, id and people under each."""
    from PIL import Image, ImageDraw, ImageFont
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 16)
    except Exception:
        font = ImageFont.load_default()
    good = [r for r in res if r.get("ok") and 1 <= (r.get("faces") or 0) <= 3 and os.path.exists(f"{OUT}/t-{r['id'][1:]}.jpg")]
    good.sort(key=lambda r: -r["face_h"])
    n = 0
    for at in range(0, len(good), 24):
        sheet = Image.new("RGB", (6 * 180, 4 * 344), "white")
        d = ImageDraw.Draw(sheet)
        for k, r in enumerate(good[at:at + 24]):
            x, y = (k % 6) * 180, (k // 6) * 344
            sheet.paste(Image.open(f"{OUT}/t-{r['id'][1:]}.jpg"), (x, y))
            d.text((x + 4, y + 322), f"{r['id']}  x{r['faces']}  {int(r['face_h'] * 100)}%", fill="black", font=font)
        n += 1
        sheet.save(f"{OUT}/sheet-{n}.jpg", quality=82)
    for f in os.listdir(OUT):
        if f.startswith("t-") and f.endswith(".jpg"):
            os.remove(os.path.join(OUT, f))
    return len(good), n


t0 = time.time()
prev = []
if PREV and os.path.exists(PREV):
    try:
        prev = [r for r in json.load(open(PREV)) if isinstance(r, dict) and str(r.get("id", "")).startswith("m")]
    except ValueError:
        prev = []
clips = listing({r["id"][1:] for r in prev})[:MAX]
print(f"{len(clips)} new clips to look at ({len(prev)} known from before)", flush=True)
res = []
for num, page, q in clips:
    r = one(num, page, q)
    res.append(r)
    print(("ok   " if r["ok"] else "FAIL ") + r["id"], q, f"faces={r.get('faces')} {r.get('face_counts')} h={r.get('face_h')}"
          if r["ok"] else r["why"], page.rsplit("/", 2)[-2], flush=True)
    if time.time() - t0 > 45 * 60:
        print("time is up: the rest waits for the next run", flush=True)
        break
json.dump(prev + res, open(f"{OUT}/discover.json", "w"), ensure_ascii=False, indent=1)
good, n = sheets(res)
print(f"{len(res)} new clips looked at, {good} with 1–3 faces ({n} sheets), {len(prev) + len(res)} known in all,"
      f" in {int(time.time() - t0)} s")
