#!/usr/bin/env python3
"""The video templates (ai-app/server/templates.json), checked where GitHub's runners can reach the free stock sites:
each page's direct video file is found (Mixkit's CDN, the Pexels page's own file links), a few seconds are fetched and
cut the way the family server will cut them (ffmpeg: up to the catalog's seconds, 9:16, 480×854). Nothing of the videos is
kept or published — only manifest.json: per template the file's address that worked (or why none did), its size and
shape. The family server downloads the templates itself from those addresses.
Also asks the Hugging Face Spaces that put a person into a template for their API (names and inputs).
   python3 ai-app/server/templates_check.py ai-app/server/templates.json out/"""
import json, os, re, subprocess, sys, time, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from templates_faces import faces  # noqa: E402

CAT, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"}
LIMIT = 80 << 20  # a file bigger than this is not taken (a 4K original): the server would fetch it again and again


def get(url, limit=4 << 20, timeout=40):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.geturl(), r.headers.get("Content-Type", ""), int(r.headers.get("Content-Length") or 0), r.read(limit)


def candidates(page):
    """Direct video addresses for a stock page, the likeliest first."""
    out = []
    num = page.rstrip("/").rsplit("-", 1)[-1]
    try:
        _, _, _, _, html = get(page)
        html = html.decode("utf-8", "replace")
        if "mixkit.co" in page:
            links = sorted(set(re.findall(r"https://assets\.mixkit\.co/[^\"'\s<>]+?\.mp4", html)))
            out += sorted(links, key=lambda u: (("720" not in u and "large" not in u), len(u)))
        else:
            links = sorted(set(re.findall(r"https://videos\.pexels\.com/video-files/[^\"'\s<>]+?\.mp4", html)))

            def rank(u):  # about 720 lines: enough for 480×854, small to fetch
                m = re.search(r"_(\d{3,4})_(\d{3,4})_", u)
                side = min(int(m.group(1)), int(m.group(2))) if m else 9999
                return (abs(side - 720), u)
            out += sorted(links, key=rank)
    except Exception as e:
        out.append("page-error:" + str(e)[:120])
    if "mixkit.co" in page:
        out += [f"https://assets.mixkit.co/videos/{num}/{num}-720.mp4", f"https://assets.mixkit.co/videos/{num}/{num}-1080.mp4"]
    else:
        out += [f"https://www.pexels.com/download/video/{num}/"]
    seen, uniq = set(), []
    for u in out:
        if u not in seen:
            seen.add(u)
            uniq.append(u)
    return uniq


def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
                        "-of", "json", path], capture_output=True, text=True)
    js = json.loads(r.stdout or "{}")
    s = (js.get("streams") or [{}])[0]
    return float((js.get("format") or {}).get("duration") or 0), s.get("width"), s.get("height")


def check(t, seconds):
    tried = []
    for url in candidates(t["page"]):
        if url.startswith("page-error:"):
            tried.append(url)
            continue
        try:
            status, final, ctype, size, _ = get(url, limit=1, timeout=30)
            if size and size > LIMIT:
                tried.append(f"{url} too big {size >> 20} MB")
                continue
            path = f"{OUT}/{t['id']}.mp4"
            urllib.request.urlretrieve(final, path)
            size = os.path.getsize(path)
            if size > LIMIT:
                tried.append(f"{url} too big {size >> 20} MB")
                os.remove(path)
                continue
            dur, w, h = probe(path)
            secs = round(min(seconds, dur - t.get("start", 0)), 1)  # the whole clip when it is shorter
            cut = f"{OUT}/{t['id']}.cut.mp4"
            r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(t.get("start", 0)), "-i", path, "-t", str(secs),
                                "-vf", "scale=480:854:force_original_aspect_ratio=increase,crop=480:854,fps=25",
                                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "96k", cut],
                               capture_output=True, text=True)
            ok = r.returncode == 0 and os.path.exists(cut) and secs >= 4 and probe(cut)[0] > secs - 1.5
            people, counts, tallest = faces(cut, secs, OUT) if ok else (None, [], 0)
            for p in (path, cut):
                if os.path.exists(p):
                    os.remove(p)
            if ok:
                return {"id": t["id"], "ok": True, "url": final if "pexels.com/download" not in url else final,
                        "source": url, "bytes": size, "duration": round(dur, 1), "seconds": secs, "w": w, "h": h,
                        "faces": people, "face_counts": counts, "face_h": tallest, "tried": tried}
            tried.append(f"{url} cut failed or shorter than 4 s ({dur:.1f} s): {r.stderr[-160:]}")
        except Exception as e:
            tried.append(f"{url} {str(e)[:120]}")
    return {"id": t["id"], "ok": False, "tried": tried}


def space_api(space):
    try:
        from gradio_client import Client
        c = Client(space, verbose=False)
        return {"space": space, "ok": True, "api": c.view_api(return_format="dict", print_info=False)}
    except Exception as e:
        return {"space": space, "ok": False, "why": str(e)[:400]}


cat = json.load(open(CAT))
res, t0 = [], time.time()
for t in cat["templates"]:
    r = check(t, cat.get("seconds", 15))
    r["title"] = t["title"]
    res.append(r)
    print(("ok   " if r["ok"] else "FAIL ") + t["id"], t["title"], f"faces={r.get('faces')} {r.get('face_counts')}" if r["ok"] else "",
          r.get("url", "") or "; ".join(r["tried"])[:300], flush=True)
spaces = [space_api(s) for s in ("alexnasa/Wan2.2-Animate-ZEROGPU", "hugging-apps/wan2-2-animate-2-14b")]
for s in spaces:
    print("space", s["space"], "ok" if s["ok"] else "FAIL " + s.get("why", ""), flush=True)
json.dump({"checked": int(time.time()), "templates": res, "spaces": spaces}, open(f"{OUT}/manifest.json", "w"), ensure_ascii=False, indent=1)
good = sum(1 for r in res if r["ok"])
fit = sum(1 for r in res if r["ok"] and 1 <= (r.get("faces") or 0) <= 3)
print(f"{good} of {len(res)} templates ok ({fit} with 1–3 faces) in {int(time.time() - t0)} s")
