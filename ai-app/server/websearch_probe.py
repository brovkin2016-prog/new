"""What each search page gives for a question (CI only, to see which engines answer from a datacenter)."""
import re
import time
from urllib.parse import urlencode

import websearch as ws

QUERIES = ["Кубок России Спартак Родина дата и время", "Спартак Родина Кубок России", "курс доллара ЦБ сегодня"]


def raw(url, method="GET", data=None):
    try:
        final, ctype, body = ws.fetch(url, method, data)
        return final, ws.decode(body, ctype)
    except Exception as e:  # noqa: BLE001
        return None, repr(e)[:200]


def show(name, final, html, parser=None, marker=None):
    title = re.search(r"<title>(.*?)</title>", html or "", re.S)
    print(f"--- {name}: {final} len={len(html or '')} title={title.group(1).strip()[:80] if title else '-'}")
    if parser and final:
        try:
            for r in parser(html)[:4]:
                print("    *", r["title"][:90], "|", r["url"][:90])
        except Exception as e:  # noqa: BLE001
            print("    parser:", e)
    if marker and final:
        i = html.find(marker)
        print("    raw@", marker, i, ":", re.sub(r"\s+", " ", html[max(0, i):max(0, i) + 2500]) if i >= 0 else html[:300])


for q in QUERIES:
    print(f"\n======== {q}")
    show("ddg html", *raw("https://html.duckduckgo.com/html/", "POST", {"q": q, "kl": "ru-ru"}), ws.ddg_html)
    time.sleep(3)
    show("ddg lite", *raw("https://lite.duckduckgo.com/lite/", "POST", {"q": q, "kl": "ru-ru"}), ws.ddg_lite)
    time.sleep(3)
    show("bing now", *raw("https://www.bing.com/search?" + urlencode({"q": q, "setlang": "ru", "cc": "RU", "count": "10"})), ws.bing_html)
    show("bing plain", *raw("https://www.bing.com/search?" + urlencode({"q": q})), ws.bing_html)
    show("bing mkt", *raw("https://www.bing.com/search?" + urlencode({"q": q, "mkt": "ru-RU", "form": "QBLH"})), ws.bing_html)
    if q == QUERIES[0]:
        show("yahoo", *raw("https://search.yahoo.com/search?" + urlencode({"p": q})), None, 'class="compTitle')
        show("mojeek", *raw("https://www.mojeek.com/search?" + urlencode({"q": q})), None, 'class="results-standard')
        show("brave", *raw("https://search.brave.com/search?" + urlencode({"q": q, "source": "web"})), None, 'data-type="web"')
        show("yandex", *raw("https://yandex.ru/search/?" + urlencode({"text": q})), None, 'serp-item')
        show("startpage", *raw("https://www.startpage.com/sp/search?" + urlencode({"query": q})), None, 'class="result')
