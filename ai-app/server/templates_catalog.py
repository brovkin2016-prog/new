#!/usr/bin/env python3
"""The templates' catalog for the family servers, made anew every run of the CI job: the hand-picked ones (templates.json,
Russian titles, checked by templates_check.py) first, then what the search found by itself — Mixkit clips
(templates_discover.py) and photos (templates_photos.py) with 1–3 faces seen big, the biggest faces first. Titles of
the found ones are in English (title_en): each server puts them into Russian itself. Clips and photos with words of
what a family app should not show, and the ones turned down by eye (templates-deny.json), are left out.
Writes catalog.json and manifest.json (the shapes the servers take: see the server's agent-docs app.md).
   python3 templates_catalog.py templates.json check-manifest.json discover.json photos.json N out/"""
import json, os, re, sys

CUR, CHECKED, DISC, PHOTOS, N, OUT = sys.argv[1:7]
HERE = os.path.dirname(os.path.abspath(__file__))
MAX_VIDEOS, MAX_PHOTOS = 1500, 1500
DENY = re.compile(r"nude|naked|lingerie|underwear|bikini|sexy|erotic|kiss|blood|gun|weapon|rifle|shoot|drug|smok|cigar|"
                  r"beer|wine|alcohol|drunk|cocktail|politic|president|protest|flag|parliament|press-conference|"
                  r"military|soldier|army|funeral|hospital|patient|injur|horror|zombie", re.I)
VTHEME = {  # the search word → the theme of the gallery
    "selfie": "vlog", "vlog": "vlog", "talking to camera": "vlog", "influencer": "vlog", "close up face": "vlog",
    "woman portrait": "vlog", "man portrait": "vlog", "smiling woman": "vlog", "smiling man": "vlog", "makeup": "vlog",
    "friends selfie": "friends", "group of friends": "friends", "people having fun": "friends", "friends": "friends",
    "teenager": "friends", "student": "friends", "couple selfie": "love", "couple": "love", "romantic": "love",
    "love": "love", "valentine": "love", "wedding": "holiday", "bride": "holiday", "wedding dance": "holiday",
    "family selfie": "family", "family": "family", "mother": "family", "father": "family", "grandmother": "family",
    "grandfather": "family", "kids": "kids", "child": "kids", "party": "party", "festival": "party", "carnival": "party",
    "cheers": "party", "dj": "party", "concert": "party", "karaoke": "party", "singing": "party", "birthday": "holiday",
    "celebration": "holiday", "christmas": "holiday", "new year": "holiday", "santa claus": "holiday",
    "halloween": "holiday", "graduation": "holiday", "road trip": "travel", "sunset": "travel", "beach": "travel",
    "travel": "travel", "summer": "travel", "winter": "travel", "snow": "travel", "autumn": "travel", "city": "travel",
    "night city": "travel", "car": "travel", "motorcycle": "travel", "dance": "dance", "dancing in the street": "dance",
    "vertical dance": "dance", "dancing woman": "dance", "dancing man": "dance", "hip hop": "dance", "fashion": "fashion",
    "model": "fashion", "runway": "fashion", "retro": "fashion", "80s": "fashion", "neon": "fashion",
    "superhero": "hero", "action": "hero", "martial arts": "hero", "sword": "hero", "cowboy": "hero", "pirate": "hero",
    "astronaut": "hero", "wizard": "hero", "spy": "hero", "detective": "hero", "boxing": "sport", "football": "sport",
    "basketball": "sport", "soccer fan": "sport", "skateboard": "sport", "fitness": "sport", "gym": "sport",
    "yoga": "sport", "funny": "fun", "laughing": "fun", "surprised": "fun", "cheering": "fun", "winner": "fun",
    "thumbs up": "fun", "waving": "fun", "applause": "fun", "happy": "fun", "gamer": "fun", "cooking": "fun",
    "coffee": "fun", "restaurant": "fun", "shopping": "fun", "office": "fun", "man sunglasses": "fashion"}
PTHEME = [  # a photo's search words → its theme (the first that fits)
    (r"astronaut|superhero|knight|princess|cowboy|pilot|firefighter|rock star", "hero"),
    (r"wedding|bride|christmas|new year|birthday|graduation", "holiday"), (r"couple", "love"),
    (r"family|grandparents|kids|baby", "family"), (r"friends", "friends"),
    (r"beach|mountain|travel|paris|car|motorcycle|autumn|winter|summer|spring", "travel"),
    (r"fitness|football|boxer", "sport"), (r"fashion|magazine|red carpet|vintage|neon|black and white", "fashion"),
    (r"business|doctor|chef|dj", "work"), (r"portrait", "portrait")]
THEMES = {"vlog": "🤳 Селфи и влог", "friends": "👯 С друзьями", "love": "❤️ Вдвоём", "family": "👨‍👩‍👧 Семья",
          "party": "🪩 Вечеринки", "holiday": "🎉 Праздники", "travel": "🌍 Путешествия", "dance": "💃 Танцы",
          "fashion": "👗 Стиль", "sport": "⚽ Спорт", "hero": "🦸 Герои", "kids": "🧸 Детские", "fun": "😂 Эмоции",
          "portrait": "📸 Портрет", "work": "💼 Профессии"}


def load(path, default):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return default


def words_of(page):  # «a-young-woman-taking-a-selfie-41181» → «a young woman taking a selfie»
    slug = page.rstrip("/").rsplit("/", 1)[-1]
    return re.sub(r"-\d+$", "", slug).replace("-", " ").strip()


cur = load(CUR, {})
checked = {t["id"]: t for t in load(CHECKED, {}).get("templates") or [] if isinstance(t, dict) and t.get("id")}
deny = set(load(os.path.join(HERE, "templates-deny.json"), []))
cat, man, ids = [], [], set()
for t in cur.get("templates") or []:  # the hand-picked ones, as checked this run
    c = checked.get(t["id"])
    if not c or not c.get("ok"):
        continue
    cat.append(dict(t, kind="video"))
    man.append({k: c.get(k) for k in ("id", "ok", "url", "seconds", "faces", "face_h", "w", "h", "bytes")} | {"kind": "video"})
    ids.add(t["id"])
videos = [r for r in load(DISC, []) if isinstance(r, dict) and r.get("ok") and r.get("url") and 1 <= (r.get("faces") or 0) <= 3
          and (r.get("face_h") or 0) >= 0.12 and (r.get("duration") or 0) >= 5 and r["id"] not in ids and r["id"] not in deny
          and not DENY.search(r.get("page", "")) and re.fullmatch(r"m\d{1,9}", r["id"])
          and re.fullmatch(r"https://assets\.mixkit\.co/videos/\d+/\d+-(360|720|1080)\.mp4", r["url"])]
videos.sort(key=lambda r: -r["face_h"])
for r in videos[:MAX_VIDEOS]:
    cat.append({"id": r["id"], "kind": "video", "theme": VTHEME.get(r.get("query"), "fun"), "title_en": words_of(r["page"]),
                "page": r["page"], "start": 0})
    man.append({"id": r["id"], "kind": "video", "ok": True, "url": r["url"], "seconds": round(min(15, r["duration"]), 1),
                "faces": r["faces"], "face_h": r["face_h"], "w": r.get("w"), "h": r.get("h")})
    ids.add(r["id"])
photos = [r for r in load(PHOTOS, []) if isinstance(r, dict) and r.get("ok") and 1 <= (r.get("faces") or 0) <= 3
          and (r.get("face_h") or 0) >= 0.08 and r["id"] not in ids and r["id"] not in deny
          and not DENY.search(r.get("words", "") + " " + r.get("page", "")) and re.fullmatch(r"(u[A-Za-z0-9_-]{5,24}|w\d{1,12})", r["id"])
          and re.match(r"https://(images\.unsplash\.com|upload\.wikimedia\.org)/", r.get("url", ""))]
photos.sort(key=lambda r: -r["face_h"])
for r in photos[:MAX_PHOTOS]:
    q = r.get("query", "")
    theme = next((t for pat, t in PTHEME if re.search(pat, q)), "portrait")
    cat.append({"id": r["id"], "kind": "photo", "theme": theme, "title_en": (r.get("words") or q)[:120], "page": r.get("page", "")})
    man.append({"id": r["id"], "kind": "photo", "ok": True, "url": r["url"], "faces": r["faces"], "face_h": r["face_h"],
                "w": r.get("w"), "h": r.get("h")})
    ids.add(r["id"])
used = {t["theme"] for t in cat}
themes = {k: v for k, v in THEMES.items() if k in used} | {k: v for k, v in (cur.get("themes") or {}).items() if k in used and k not in THEMES}
os.makedirs(OUT, exist_ok=True)
json.dump({"version": int(N), "themes": themes, "seconds": cur.get("seconds", 15), "templates": cat},
          open(os.path.join(OUT, "catalog.json"), "w"), ensure_ascii=False, indent=1)
json.dump({"templates": man, "spaces": load(CHECKED, {}).get("spaces") or []}, open(os.path.join(OUT, "manifest.json"), "w"),
          ensure_ascii=False, indent=1)
kinds = {"video": sum(1 for t in cat if t["kind"] == "video"), "photo": sum(1 for t in cat if t["kind"] == "photo")}
print(f"catalog {N}: {kinds['video']} videos ({len([t for t in cat if t['kind'] == 'video' and 'title' in t])} hand-picked), "
      f"{kinds['photo']} photos, themes {sorted(used)}")
