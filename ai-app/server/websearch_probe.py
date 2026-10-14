"""What each search page gives for a question (CI only, to see which engines answer from a datacenter)."""
import json
import re
from urllib.parse import quote, urlencode

import websearch as ws

Q = "Спартак Родина Кубок России"


def raw(url, method="GET", data=None, headers=None):
    try:
        if headers:
            conn, r = ws._request(url, method, None, headers)
            try:
                return url + f" [{r.status}]", ws.decode(r.read(2_000_000), r.getheader("Content-Type") or "")
            finally:
                conn.close()
        final, ctype, body = ws.fetch(url, method, data)
        return final, ws.decode(body, ctype)
    except Exception as e:  # noqa: BLE001
        return None, repr(e)[:300]


def show(name, final, html, parser=None, marker=None, n=1500):
    title = re.search(r"<title[^>]*>(.*?)</title>", html or "", re.S)
    print(f"--- {name}: {final} len={len(html or '')} title={title.group(1).strip()[:80] if title else '-'}")
    if not final:
        print("    error:", html)
        return
    if parser:
        try:
            for r in parser(html)[:4]:
                print("    *", r["title"][:90], "|", r["url"][:90])
        except Exception as e:  # noqa: BLE001
            print("    parser:", e)
    if marker:
        i = html.find(marker)
        print("    raw@", marker, i, ":", re.sub(r"\s+", " ", html[max(0, i):max(0, i) + n]) if i >= 0 else re.sub(r"\s+", " ", html[:600]))


show("ddg html POST", *raw("https://html.duckduckgo.com/html/", "POST", {"q": Q, "kl": "ru-ru"}), ws.ddg_html, "anomaly", 300)
show("ddg html GET", *raw("https://html.duckduckgo.com/html/?" + urlencode({"q": Q, "kl": "ru-ru"})), ws.ddg_html)
final, page = raw("https://duckduckgo.com/?" + urlencode({"q": Q}))
vqd = re.search(r"vqd=[\"']?([\d-]+)", page or "")
print("ddg vqd:", vqd.group(1) if vqd else None)
if vqd:
    show("ddg d.js", *raw("https://links.duckduckgo.com/d.js?" + urlencode({"q": Q, "vqd": vqd.group(1), "kl": "ru-ru", "l": "ru-ru",
                                                                               "s": "0", "df": "", "ex": "-1"})), None, "DDG.pageLayout.load('d'", 1500)
show("bing rss", *raw("https://www.bing.com/search?" + urlencode({"q": Q, "format": "rss", "setlang": "ru"})), None, "<item>", 1500)
show("bing rss mkt", *raw("https://www.bing.com/search?" + urlencode({"q": Q, "format": "rss", "mkt": "ru-RU"})), None, "<item>", 800)
show("bing cookie", *raw("https://www.bing.com/search?" + urlencode({"q": Q}), headers={"Cookie": "SRCHHPGUSR=SRCHLANG=ru; _EDGE_S=mkt=ru-ru"}), ws.bing_html)
show("mojeek", *raw("https://www.mojeek.com/search?" + urlencode({"q": Q})), None, 'class="results-standard', 1500)
show("yahoo", *raw("https://search.yahoo.com/search?" + urlencode({"p": Q})), None, 'compTitle', 1500)
show("brave", *raw("https://search.brave.com/search?" + urlencode({"q": Q})), None, 'snippet', 1200)
show("qwant", *raw("https://api.qwant.com/v3/search/web?" + urlencode({"q": Q, "count": "10", "locale": "ru_RU", "offset": "0", "device": "desktop"})), None, '"items"', 1200)
show("ecosia", *raw("https://www.ecosia.org/search?" + urlencode({"q": Q})), None, 'result', 600)
show("mail.ru", *raw("https://go.mail.ru/search?" + urlencode({"q": Q})), None, 'result', 800)
show("searx.be", *raw("https://searx.be/search?" + urlencode({"q": Q, "format": "json"})), None, '"results"', 600)
show("sports.ru search", *raw("https://www.sports.ru/search/?" + urlencode({"query": Q})), None, 'Родина', 600)
show("wiki", *raw("https://ru.wikipedia.org/w/api.php?" + urlencode({"action": "query", "list": "search", "srsearch": Q, "format": "json"})), None, '"search"', 300)
