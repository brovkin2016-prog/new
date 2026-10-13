#!/usr/bin/env python3
"""Finds photo templates — pictures a person's face goes into (a portrait in a studio, a superhero, a wedding, a trip)
— where GitHub's runners can reach the free photo sites: Unsplash's own search (its free licence), Wikimedia Commons
when Unsplash refuses. Each picture is fetched at about 1080 pixels and its faces counted (templates_faces.py); those
with 1–3 faces seen big enough are kept. Writes photos.json (per photo: id, page, url, size, people, the biggest face's
height, the query it came by, its English words) and contact sheets of the kept ones. Nothing of the pictures is kept.
Photos already looked at (the previous run's photos.json, if given) are not fetched again.
   python3 ai-app/server/templates_photos.py out/ [max photos] [previous photos.json]"""
import json, os, re, sys, time, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from templates_faces import faces_image  # noqa: E402

OUT = sys.argv[1]
MAX = int(sys.argv[2]) if len(sys.argv) > 2 else 900
PREV = sys.argv[3] if len(sys.argv) > 3 else ""
os.makedirs(OUT, exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9", "Accept": "application/json"}
# what people make of themselves in a picture
QUERIES = ["studio portrait", "portrait smiling", "business portrait", "fashion portrait", "vintage portrait", "astronaut",
           "superhero costume", "knight armor", "princess dress", "cowboy hat portrait", "pilot uniform", "firefighter",
           "doctor portrait", "chef portrait", "wedding couple", "bride portrait", "couple portrait", "family portrait",
           "friends portrait", "christmas portrait", "new year party", "birthday portrait", "graduation portrait",
           "beach portrait", "mountain portrait", "travel portrait", "paris portrait", "car portrait", "motorcycle portrait",
           "rock star", "dj portrait", "fitness portrait", "football player portrait", "boxer portrait", "magazine cover",
           "red carpet", "kids portrait", "baby portrait", "grandparents portrait", "autumn portrait", "winter portrait",
           "summer portrait", "spring flowers portrait", "neon portrait", "black and white portrait"]
DENY = re.compile(r"nude|naked|lingerie|underwear|bikini|sexy|erotic|blood|gun|weapon|rifle|drug|smok|cigar|beer|"
                  r"alcohol|drunk|politic|president|protest|military|soldier|funeral|hospital|patient|injur", re.I)


def get_json(url, timeout=30):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return json.loads(r.read(4 << 20).decode("utf-8", "replace"))


def unsplash(q, page):
    js = get_json(f"https://unsplash.com/napi/search/photos?query={urllib.parse.quote(q)}&per_page=30&page={page}")
    for p in js.get("results") or []:
        if p.get("premium") or p.get("plus") or not (p.get("urls") or {}).get("raw"):
            continue  # Unsplash+ pictures are paid: not taken
        words = " ".join(str(p.get(k) or "") for k in ("alt_description", "description"))
        yield {"id": "u" + str(p["id"]), "page": (p.get("links") or {}).get("html") or "",
               "url": p["urls"]["raw"] + "&w=1080&fm=jpg&q=85", "w": p.get("width"), "h": p.get("height"),
               "words": words.strip()[:200], "source": "unsplash"}


def commons(q, page):
    url = ("https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6"
           f"&gsrsearch={urllib.parse.quote(q + ' filetype:bitmap')}&gsrlimit=30&gsroffset={(page - 1) * 30}"
           "&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1080")
    js = get_json(url)
    for p in ((js.get("query") or {}).get("pages") or {}).values():
        ii = (p.get("imageinfo") or [{}])[0]
        if ii.get("mime") not in ("image/jpeg", "image/png") or not ii.get("thumburl"):
            continue
        meta = ii.get("extmetadata") or {}
        lic = str((meta.get("LicenseShortName") or {}).get("value") or "")
        if not re.search(r"CC0|Public domain|CC BY", lic, re.I):
            continue
        words = re.sub(r"<[^>]+>", " ", str((meta.get("ImageDescription") or {}).get("value") or p.get("title") or ""))
        yield {"id": "w" + str(p.get("pageid")), "page": ii.get("descriptionurl") or "", "url": ii["thumburl"],
               "w": ii.get("thumbwidth"), "h": ii.get("thumbheight"), "words": " ".join(words.split())[:200],
               "source": "commons", "license": lic}


def listing(seen):
    out, ids, via = [], set(seen), {}
    for q in QUERIES:
        got = 0
        for page in (1, 2, 3):
            for name, fn in (("unsplash", unsplash), ("commons", commons)):
                if via.get(name) == "refused":
                    continue
                try:
                    for c in fn(q, page):
                        if c["id"] not in ids and not DENY.search(c["words"] + " " + c["page"]):
                            ids.add(c["id"])
                            c["query"] = q
                            out.append(c)
                            got += 1
                    via[name] = "ok"
                    break  # Unsplash answered: Commons is not asked for this page
                except Exception as e:
                    print("search", name, q, page, str(e)[:100], flush=True)
                    if via.get(name) != "ok" and ("403" in str(e) or "429" in str(e)):
                        via[name] = "refused"
        print(f"query {q!r}: {got} new photos", flush=True)
    print("sources:", via, flush=True)
    return out


def one(c):
    path = f"{OUT}/{c['id']}.jpg"
    try:
        req = urllib.request.Request(c["url"], headers=dict(UA, Accept="image/*"))
        with urllib.request.urlopen(req, timeout=40) as r, open(path, "wb") as f:
            f.write(r.read(12 << 20))
        people, tallest = faces_image(path, OUT)
        r = dict(c, ok=people is not None, faces=people, face_h=tallest, bytes=os.path.getsize(path))
        if people and 1 <= people <= 3 and tallest >= 0.08:
            from PIL import Image
            im = Image.open(path).convert("RGB")
            im.thumbnail((180, 320))
            im.save(f"{OUT}/t-{c['id']}.jpg", quality=80)
        return r
    except Exception as e:
        return dict(c, ok=False, why=str(e)[:120])
    finally:
        if os.path.exists(path):
            os.remove(path)


def sheets(res):
    from PIL import Image, ImageDraw, ImageFont
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 14)
    except Exception:
        font = ImageFont.load_default()
    good = [r for r in res if os.path.exists(f"{OUT}/t-{r['id']}.jpg")]
    good.sort(key=lambda r: -(r.get("face_h") or 0))
    n = 0
    for at in range(0, len(good), 24):
        sheet = Image.new("RGB", (6 * 180, 4 * 344), "white")
        d = ImageDraw.Draw(sheet)
        for k, r in enumerate(good[at:at + 24]):
            x, y = (k % 6) * 180, (k // 6) * 344
            t = Image.open(f"{OUT}/t-{r['id']}.jpg")
            sheet.paste(t, (x + (180 - t.width) // 2, y + (320 - t.height) // 2))
            d.text((x + 4, y + 322), f"{r['id'][:12]} x{r['faces']} {int(r['face_h'] * 100)}%", fill="black", font=font)
        n += 1
        sheet.save(f"{OUT}/photos-{n}.jpg", quality=82)
    for f in os.listdir(OUT):
        if f.startswith("t-") and f.endswith(".jpg"):
            os.remove(os.path.join(OUT, f))
    return len(good), n


t0 = time.time()
prev = []
if PREV and os.path.exists(PREV):
    try:
        prev = [r for r in json.load(open(PREV)) if isinstance(r, dict) and r.get("id")]
    except ValueError:
        prev = []
cands = listing({r["id"] for r in prev})[:MAX]
print(f"{len(cands)} new photos to look at ({len(prev)} known from before)", flush=True)
res = []
for c in cands:
    r = one(c)
    res.append(r)
    print(("ok   " if r.get("ok") else "FAIL ") + r["id"], r["query"], f"faces={r.get('faces')} h={r.get('face_h')}"
          if r.get("ok") else r.get("why"), flush=True)
    if time.time() - t0 > 30 * 60:
        print("time is up: the rest waits for the next run", flush=True)
        break
good, n = sheets(res)
json.dump(prev + res, open(f"{OUT}/photos.json", "w"), ensure_ascii=False, indent=1)
print(f"{len(res)} photos looked at, {good} new with 1–3 faces seen big ({n} sheets), {len(prev) + len(res)} known in all,"
      f" in {int(time.time() - t0)} s")
