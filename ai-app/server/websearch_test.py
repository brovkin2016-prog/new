"""Tests of websearch.py. Without arguments: offline (the pages' shapes, the guard against internal addresses).
With --live: the real search pages from this machine (the CI does that; the family server's network is alike)."""
import re
import sys
import unittest

import websearch as ws

DDG = """<div class="result results_links results_links_deep web-result">
<h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.cbr.ru%2Fcurrency_base%2F&amp;rut=x">Курсы валют — <b>Банк России</b></a></h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Официальные <b>курсы</b> валют на заданную дату</a></div>
<div class="result result--ad"><h2 class="result__title"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x">Реклама</a></h2></div>
<div class="result"><h2 class="result__title"><a class="result__a" href="https://ru.wikipedia.org/wiki/Рубль">Рубль — Википедия</a></h2>
<a class="result__snippet" href="#">Российский рубль &mdash; валюта</a></div>"""

LITE = """<table><tr><td><a rel="nofollow" href="https://example.org/a" class='result-link'>Пример А</a></td></tr>
<tr><td class='result-snippet'>Первый <b>сниппет</b></td></tr>
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb" class='result-link'>Пример Б</a></td></tr>
<tr><td class='result-snippet'>Второй</td></tr></table>"""

BING = """<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel><title>Bing: курс</title>
<link>http://www.bing.com:80/search?q=x</link><item><title>Новости сайта &amp; курс</title><link>https://site.ru/news</link>
<description>Свежие новости дня: курс доллара</description><pubDate>ср, 14 окт. 2026 00:50:00 GMT</pubDate></item>
<item><title><![CDATA[Другая страница]]></title><link>https://other.ru/page</link><description>Описание другой</description></item>
<item><title>Без адреса</title><link>javascript:alert(1)</link><description>x</description></item></channel></rss>"""

PAGE = """<html><head><title> Курс доллара  </title><script>var x = "не текст";</script><style>p{}</style></head>
<body><nav><a href="/">Главная</a> <a href="/n">Новости</a></nav><header>Шапка сайта</header>
<article><h1>Официальный курс доллара на 12 октября</h1>
<p>Банк России установил официальный курс доллара США на завтра в размере 81,25 рубля, это на 30 копеек больше.</p>
<p>Курс евро составит 94,10 рубля.</p><div>Поделиться</div>""" + "<p>Подробный разбор причин изменения курса и мнения аналитиков о дальнейшей динамике рубля.</p>" * 12 + """
</article><footer>© 2026 Сайт. Все права защищены.</footer></body></html>"""

MATCH = """<html><head><title>Родина — Спартак</title>
<meta name="description" content="Кубок России. Родина и Спартак сыграют 15 октября в 20:45 по московскому времени.">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"SportsEvent","name":"Родина — Спартак",
"startDate":"2026-10-15T20:45:00+03:00","homeTeam":{"@type":"SportsTeam","name":"Родина"},"awayTeam":{"name":"Спартак"},
"location":{"@type":"Place","name":"Арена Химки"}},{"@type":"SportsEvent","name":"Спартак — Родина","startDate":"2026-09-01T16:30:00Z",
"eventStatus":"https://schema.org/EventPostponed"}]}</script>
<script>window.__DATA__ = {"time": "20:45"}</script></head>
<body><div id="app">Загрузка…</div></body></html>"""


class Parsers(unittest.TestCase):
    def test_duckduckgo(self):
        r = ws.ddg_html(DDG)
        self.assertEqual([x["url"] for x in r], ["https://www.cbr.ru/currency_base/", "https://ru.wikipedia.org/wiki/Рубль"])
        self.assertEqual(r[0]["title"], "Курсы валют — Банк России")
        self.assertIn("курсы валют", r[0]["snippet"])
        self.assertEqual(r[1]["snippet"], "Российский рубль — валюта")

    def test_duckduckgo_lite(self):
        r = ws.ddg_lite(LITE)
        self.assertEqual([(x["title"], x["url"]) for x in r], [("Пример А", "https://example.org/a"), ("Пример Б", "https://example.org/b")])
        self.assertEqual(r[0]["snippet"], "Первый сниппет")

    def test_bing(self):
        r = ws.bing_rss(BING)
        self.assertEqual([(x["title"], x["url"]) for x in r], [("Новости сайта & курс", "https://site.ru/news"), ("Другая страница", "https://other.ru/page")])
        self.assertEqual(r[0]["snippet"], "Свежие новости дня: курс доллара")
        self.assertEqual(r[1]["snippet"], "Описание другой")

    def test_relevant(self):
        # a search page that took the server for a robot answers another question: such results are left out
        found = [{"title": "Фолклендские острова — Википедия", "url": "https://a.ru", "snippet": "Местное время и дата"},
                 {"title": "Спартак — Родина, 15 октября", "url": "https://b.ru", "snippet": "Кубок России, начало в 20:45"},
                 {"title": "Родина Спартака", "url": "https://c.ru", "snippet": "история клуба"},
                 {"title": "Спартак", "url": "https://d.ru", "snippet": "новости клуба"}]
        self.assertEqual([r["url"] for r in ws.relevant(found, "Кубок России Спартак Родина дата и время")], ["https://b.ru", "https://c.ru"])
        self.assertEqual([r["url"] for r in ws.relevant(found, "Спартак сегодня")], ["https://b.ru", "https://c.ru", "https://d.ru"])
        self.assertEqual(ws.relevant(found, "дата и время 2026"), found)  # nothing but common words: all stay

    def test_search_merges_engines(self):
        old = ws.ENGINES
        try:
            a = [{"title": f"Спартак {i}", "url": f"https://a.ru/{i}", "snippet": ""} for i in range(3)]
            b = [{"title": "Франция", "url": "https://fr.ru", "snippet": ""}, {"title": "Спартак 0", "url": "https://a.ru/0", "snippet": ""},
                 {"title": "Спартак Б", "url": "https://b.ru", "snippet": ""}]
            asked = []
            wiki = lambda q: asked.append(q) or [{"title": "Спартак (клуб)", "url": "https://w.ru", "snippet": ""}]
            ws.ENGINES = [("duckduckgo", lambda q: a), ("bing", lambda q: b), ("wikipedia", wiki)]
            found, name = ws.search("Спартак")
            self.assertEqual([r["url"] for r in found], ["https://a.ru/0", "https://a.ru/1", "https://b.ru", "https://a.ru/2"])
            self.assertEqual(name, "duckduckgo+bing")
            def down(q):
                raise OSError("blocked")
            ws.ENGINES = [("duckduckgo", down), ("bing", lambda q: b), ("wikipedia", wiki)]
            found, name = ws.search("Спартак")
            self.assertEqual(([r["url"] for r in found], name), (["https://a.ru/0", "https://b.ru", "https://w.ru"], "bing+wikipedia"))
            # a long query that the web does not answer: once more by its main words
            asked = []
            cup = [{"title": f"Спартак — Родина {i}", "url": f"https://cup.ru/{i}", "snippet": "Кубок России"} for i in range(3)]

            def picky(q):
                asked.append(q)
                return cup if q == "спартак родина кубок россии" else [{"title": "Лихорадка", "url": "https://f.ru", "snippet": ""}]
            ws.ENGINES = [("duckduckgo", down), ("bing", picky), ("wikipedia", lambda q: [])]
            found, name = ws.search("Спартак Родина Кубок России 2026 дата и время матча")
            self.assertEqual(asked, ["Спартак Родина Кубок России 2026 дата и время матча", "спартак родина кубок россии"])
            self.assertEqual(([r["url"] for r in found], name), ([r["url"] for r in cup], "bing"))
            ws.ENGINES = [("duckduckgo", down), ("bing", lambda q: b[:1]), ("wikipedia", lambda q: [])]
            self.assertEqual(ws.search("Спартак"), ([], None))
        finally:
            ws.ENGINES = old

    def test_gather_slow_page(self):
        # a slow first page holds nobody up: the others are read meanwhile, and they keep the search's order
        import time
        old = ws.search, ws.read_page
        try:
            res = [{"title": f"Т{i}", "url": f"https://p{i}.ru", "snippet": ""} for i in range(4)]
            ws.search = lambda q, budget=12.0: (res, "duckduckgo")

            def read(url, limit, query):
                time.sleep(3 if "p0" in url else 0.1 if "p2" in url else 0)
                return url, ("текст страницы " * 20) + url
            ws.read_page = read
            t0 = time.time()
            ws.cache.clear()
            got = ws.gather("вопрос", n_pages=2, budget=10)  # p1 and p3 at once, p2 soon after: p1, p2; p0 not waited for
            self.assertLess(time.time() - t0, ws.GRACE + 0.5)
            self.assertEqual([p["url"] for p in got["pages"]], ["https://p1.ru", "https://p2.ru"])
            t0 = time.time()
            ws.cache.clear()
            got = ws.gather("вопрос", n_pages=3, budget=10)  # p1, p2, p3 read, p0 the first and the slow: not waited for
            self.assertLess(time.time() - t0, ws.GRACE + 0.5)
            self.assertEqual([p["url"] for p in got["pages"]], ["https://p1.ru", "https://p2.ru", "https://p3.ru"])
            ws.cache.clear()
            got = ws.gather("вопрос", n_pages=4, budget=1.0)  # not all in time: those read by then
            self.assertEqual([p["url"] for p in got["pages"]], ["https://p1.ru", "https://p2.ru", "https://p3.ru"])
        finally:
            ws.search, ws.read_page = old

    def test_direct_weather(self):
        # the weather from Open-Meteo: the place found by its name's beginning («Казани» → Казань), now, hours, days
        import json as js
        asked = []

        def fake(url):
            asked.append(url)
            if "geocoding" in url:
                name = ws.parse_qs(ws.urlsplit(url).query)["name"][0]
                ok = "Казань".startswith(name) and len(name) >= 4
                return {"results": [{"name": "Казань", "admin1": "Татарстан", "country": "Россия", "latitude": 55.79,
                                     "longitude": 49.12, "population": 1243500}] if ok else []}
            hours = [f"2026-10-14T{h:02d}:00" for h in range(24)] + [f"2026-10-15T{h:02d}:00" for h in range(24)]
            return {"current": {"time": "2026-10-14T21:00", "temperature_2m": 15.9, "apparent_temperature": 14.2,
                                "relative_humidity_2m": 80, "weather_code": 3, "wind_speed_10m": 3.1, "wind_gusts_10m": 7.0},
                    "hourly": {"time": hours, "temperature_2m": [10] * 48, "precipitation_probability": [20] * 48,
                               "weather_code": [61] * 48},
                    "daily": {"time": ["2026-10-14", "2026-10-15"], "weather_code": [3, 61], "temperature_2m_max": [16, 12],
                              "temperature_2m_min": [8, 6], "precipitation_sum": [0, 4.2], "precipitation_probability_max": [10, 80],
                              "wind_speed_10m_max": [4, 6]}}
        old = ws._json
        try:
            ws._json = fake
            pg = ws.direct("погода Казань завтра Какая погода будет завтра в Казани?")
            self.assertEqual(pg["url"], "https://open-meteo.com/")
            self.assertIn("Погода: Казань, Татарстан, Россия", pg["text"])
            self.assertIn("Сейчас: 15.9°C (ощущается как 14.2°C), пасмурно, ветер 3.1 м/с", pg["text"])
            self.assertIn("14.10 21:00 | 10 | 20 | небольшой дождь", pg["text"])
            self.assertIn("чт 15.10 | 6 | 12 | 4.2 (80) | 6 | небольшой дождь", pg["text"])
            del asked[:]
            pg = ws.direct("Какая погода будет завтра в Казани?")  # as asked: «Казани» → «Казан» → Казань
            self.assertIn("Погода: Казань", pg["text"])
            self.assertLessEqual(sum("geocoding" in u for u in asked), 8)
            self.assertIn("ask", ws.direct("какая погода завтра?"))
            self.assertIsNone(ws.direct("будет ли дождь завтра"))  # no «погода», no place: an ordinary search
            for q in ("температура у ребёнка 38", "ветрянка у сына", "угроза взлома", "таблица умножения на 7"):
                self.assertIsNone(ws.direct(q), q)
        finally:
            ws._json = old

    def test_direct_table(self):
        # a league's table: Sports.ru's page, its rows without the crests' empty cells; ESPN's when it does not open
        page = "<h1>Турнирная таблица РПЛ</h1><table><tr><th>#</th><th>Команда</th><th></th><th>И</th><th>О</th></tr>" + "".join(
            f"<tr><td>{i}</td><td>Команда {i}</td><td><img></td><td>10</td><td>{30 - i}</td></tr>" for i in range(1, 17)) + "</table>"
        old = ws.read_page, ws._json
        try:
            got = []
            ws.read_page = lambda url, limit=4000, query=None: got.append(url) or ws.page_text(page)
            pg = ws.direct("таблица чемпионата России по футболу")
            self.assertEqual(got, ["https://www.sports.ru/football/tournament/rfpl/table/"])
            self.assertIn("# | Команда | И | О\n1 | Команда 1 | 10 | 29\n", pg["text"])
            ws.direct("турнирная таблица АПЛ")
            self.assertEqual(got[-1], "https://www.sports.ru/football/tournament/premier-league/table/")
            ws.direct("кто лидирует в РПЛ")
            self.assertEqual(got[-1], "https://www.sports.ru/football/tournament/rfpl/table/")

            def down(url, limit=4000, query=None):
                raise ws.Blocked("403")
            ws.read_page = down
            stats = lambda p, w: [{"abbreviation": k, "displayValue": v} for k, v in
                                  (("GP", "10"), ("W", w), ("D", "1"), ("L", "2"), ("F", "15"), ("A", "8"), ("GD", "+7"), ("P", p))]
            ws._json = lambda url: {"children": [{"standings": {"entries": [
                {"team": {"displayName": f"Team {i}"}, "stats": stats(str(30 - i), "7")} for i in range(1, 17)]}}]}
            pg = ws.direct("таблица РПЛ")
            self.assertIn("1 | Team 1 | 10 | 7 | 1 | 2 | 15:8 | +7 | 29", pg["text"])
            self.assertIn("по-английски", pg["text"])
            self.assertIsNone(ws.direct("таблица КХЛ"))  # (no ESPN for it)
        finally:
            ws.read_page, ws._json = old

    def test_stats_and_cache(self):
        # how each engine answered last (for the owner's «🌐 Поиск» card); the same search within 10 minutes: from memory
        old, old_read = ws.ENGINES, ws.read_page
        try:
            calls = []
            def robot(q):
                raise ws.Blocked("проверка на робота")
            def other(q):
                return [{"title": "Франция", "url": "https://fr.ru", "snippet": ""}]
            def good(q):
                calls.append(q)
                return [{"title": f"Спартак {i}", "url": f"https://s{i}.ru", "snippet": ""} for i in range(3)]
            ws.ENGINES = [("duckduckgo", robot), ("bing", other), ("wikipedia", good)]
            ws.read_page = lambda url, limit=4000, query=None: ("Т", "Спартак " * 60)
            ws.cache.clear()
            got = ws.gather("Спартак")
            self.assertEqual(ws.STATS["duckduckgo"]["why"], "проверка на робота")
            self.assertEqual((ws.STATS["bing"]["ok"], ws.STATS["bing"]["why"]), (False, "выдал чужое"))
            self.assertEqual((ws.STATS["wikipedia"]["ok"], ws.STATS["wikipedia"]["n"]), (True, 3))
            self.assertTrue(got["pages"])
            self.assertIs(ws.gather("  спартак "), got)
            self.assertEqual(len(calls), 1)
        finally:
            ws.ENGINES, ws.read_page = old, old_read
            ws.cache.clear()

    def test_exa(self):
        # the owner's Exa key: Exa asked first, its pages' text used as it came (nothing opened), a refused key said so
        import json as js
        sent = []

        class Resp:
            def __init__(self, status, body):
                self.status, self.body = status, body

            def read(self, n):
                return self.body

            def getheader(self, k, default=None):
                return default

        class Conn:
            def close(self):
                pass
        page = "Матч «Родина» — «Спартак» пройдёт в четверг, 15 октября 2026 года, в 20:45 по Москве. " * 4
        answers = {"status": 200}

        def fake_request(url, method="GET", body=None, headers=None):
            sent.append((url, method, js.loads(body), dict(headers)))
            return Conn(), Resp(answers["status"], js.dumps({"results": [
                {"title": "Родина — Спартак 15 октября", "url": "https://www.sports.ru/m/1", "text": page},
                {"title": "Без адреса", "url": "javascript:1", "text": "x"}]}).encode())
        old = ws._request, ws.EXA_KEY, ws.ENGINES, ws.read_page
        try:
            ws._request, ws.EXA_KEY = fake_request, "exa-key-1"
            ws.ENGINES = [("duckduckgo", lambda q: []), ("bing", lambda q: []), ("wikipedia", lambda q: [])]
            ws.read_page = lambda *a, **k: self.fail("a page with Exa's text was opened")
            ws.cache.clear()
            got = ws.gather("Спартак Родина Кубок России")
            self.assertEqual(sent[0][0], "https://api.exa.ai/search")
            self.assertEqual(sent[0][3]["x-api-key"], "exa-key-1")
            self.assertEqual(sent[0][2]["contents"], {"text": True})
            self.assertEqual(got["engine"], "exa")
            self.assertEqual([r["url"] for r in got["results"]], ["https://www.sports.ru/m/1"])
            self.assertIn("20:45 по Москве", got["pages"][0]["text"])
            answers["status"] = 401
            with self.assertRaises(ws.Blocked) as e:
                ws.exa("x")
            self.assertEqual(str(e.exception), "ключ не принят")
            ws.EXA_KEY = ""
            self.assertNotIn("exa", [n for n, _ in ws.engines()])
        finally:
            ws._request, ws.EXA_KEY, ws.ENGINES, ws.read_page = old
            ws.cache.clear()

    def test_page_text(self):
        title, text = ws.page_text(PAGE)
        self.assertEqual(title, "Курс доллара")
        self.assertIn("81,25 рубля", text)
        self.assertIn("94,10", text)  # a short line with a number stays
        for junk in ("не текст", "Главная", "Шапка", "© 2026", "Поделиться"):
            self.assertNotIn(junk, text)

    def test_tables(self):
        # a standings table: each row one line, cells apart — the team names stay (alone they looked like a menu)
        html = """<article><h2>Турнирная таблица РПЛ</h2><table><thead><tr><th>М</th><th>Команда</th><th>И</th><th>О</th></tr></thead>
        <tbody><tr><td>1</td><td><a href="/z"><div>Зенит</div></a></td><td>12</td><td>27</td></tr>
        <tr><td>2</td><td><span>Спартак</span></td><td>12</td><td>25</td></tr></tbody></table>
        <p>Текст после таблицы, довольно длинный, чтобы остаться в тексте страницы.</p></article>"""
        _, text = ws.page_text(html)
        self.assertEqual(text.split("\n"), ["Турнирная таблица РПЛ", "М | Команда | И | О", "1 | Зенит | 12 | 27", "2 | Спартак | 12 | 25",
                                            "Текст после таблицы, довольно длинный, чтобы остаться в тексте страницы."])

    def test_event_data(self):
        # a sports page that draws the match with scripts: its time is only in JSON-LD and the description
        title, text = ws.page_text(MATCH)
        lines = text.split("\n")
        self.assertEqual(lines[0], "Событие: Родина — Спартак · начало: 15.10.2026 20:45 МСК · место: Арена Химки")
        self.assertIn("Событие: Спартак — Родина · начало: 01.09.2026 19:30 МСК · перенесено", lines)  # UTC → МСК
        self.assertIn("Кубок России. Родина и Спартак сыграют 15 октября в 20:45 по московскому времени.", lines)
        self.assertNotIn("window.__DATA__", text)
        _, feed = ws.page_text("<p>Начало: 20:45</p><p>20:35</p><p>20:34</p><p>20:30</p><p>Родина — Спартак</p><p>15.10</p>")
        self.assertEqual(feed, "Начало: 20:45\nРодина — Спартак\n15.10")  # a feed's column of times goes, a lone date stays
        self.assertEqual(ws.msk_time("2026-10-15"), "15.10.2026")
        self.assertEqual(ws.msk_time("2026-10-15T23:30:00-0200"), "16.10.2026 04:30 МСК")
        self.assertEqual(ws.msk_time("2026-10-15T20:45"), "15.10.2026 20:45 (по времени сайта)")
        self.assertEqual(ws.ld_facts(["{не json", '{"@type":"NewsArticle","datePublished":"2026-10-14T09:00:00Z"}']),
                         ["Опубликовано: 14.10.2026 12:00 МСК"])

    def test_focus(self):
        # a long page: the lines about the question (with their time) come through, not only the page's beginning
        menu = "\n".join(f"Раздел сайта номер {i}: новости, видео, фото и статистика всех турниров" for i in range(120))
        page = ("Футбол — главная страница\n" + menu + "\nКубок России, 1/8 финала\nРодина — Спартак\n15 октября, 20:45\n"
                + menu + "\nЗенит — Ростов, 16 октября 19:00\n" + "\n".join("Длинный текст про другое " * 3 for _ in range(50)))
        got = ws.focus(page, "Кубок России Спартак Родина дата и время", 1500)
        self.assertLessEqual(len(got), 1500)
        self.assertTrue(got.startswith("Футбол — главная страница"))
        self.assertIn("Родина — Спартак\n15 октября, 20:45", got)
        self.assertIn("Кубок России, 1/8 финала", got)
        self.assertIn("…", got)
        self.assertEqual(ws.focus(page, None, 300), page[:300])  # no question: the beginning, as before
        self.assertEqual(ws.focus("коротко", "Спартак", 300), "коротко")
        one_line = "Начало. " * 200 + "Матч Спартака с Родиной начнётся в 20:45. " + "Конец. " * 200
        self.assertIn("20:45", ws.focus(one_line, "Спартак Родина", 600))
        self.assertEqual(ws.stems("Во сколько Спартак — Родина, 2026?"), {"спарт", "роди", "2026"})
        self.assertEqual(ws.core_query("Во сколько начнётся матч Спартак — Родина 1/8 Кубка России 2026, дата и время?"),
                         "спартак родина кубка россии")


class Guard(unittest.TestCase):
    def test_internal_addresses_are_not_fetched(self):
        for url in ("http://127.0.0.1:8080/", "http://localhost/", "http://10.0.0.1/", "http://192.168.1.1/",
                    "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://100.64.0.1/", "http://0.0.0.0/"):
            with self.assertRaises(ws.Blocked, msg=url):
                ws.fetch(url)

    def test_only_web_pages(self):
        for url in ("file:///etc/passwd", "ftp://example.org/x", "http://example.org:22/", "gopher://x/"):
            with self.assertRaises(ws.Blocked, msg=url):
                ws.fetch(url)


class Live(unittest.TestCase):
    """The real search pages (needs the internet)."""

    def test_b_weather(self):  # Open-Meteo, as asked («в Казани»)
        pg = ws.direct("Какая погода будет завтра в Казани?")
        print("weather:\n" + pg["text"][:900])
        self.assertIn("Погода: Казань, Татарстан", pg["text"])
        self.assertGreaterEqual(pg["text"].count("\n"), 12)

    def test_c_tables(self):  # Sports.ru's tables (or ESPN's)
        for q, team in (("таблица РПЛ", "Зенит"), ("турнирная таблица АПЛ", "Арсенал"), ("таблица КХЛ", "СКА"), ("таблица Ла Лиги", "Барселона")):
            pg = ws.direct(q)
            print(f"table «{q}»:", pg and pg["url"], "\n" + (pg["text"][:700] if pg else ""))
            self.assertTrue(pg and team in pg["text"] and pg["text"].count("\n") >= 12, q)

    def test_engines(self):
        works = {}
        for name, fn in ws.ENGINES:
            try:
                found = fn("курс доллара ЦБ")
                works[name] = (len(found), len(ws.relevant(found, "курс доллара ЦБ")), [r["title"][:60] for r in found[:2]])
            except Exception as e:  # one engine down is not a failure, all of them is
                works[name] = repr(e)[:120]
        print("engines (found, about the question, first titles):", works)
        self.assertTrue(any(isinstance(v, tuple) and v[1] >= 2 for v in works.values()), works)

    def test_gather_reads_pages(self):
        got = ws.gather("столица Австралии")
        print("gather:", got["engine"], [p["url"] for p in got["pages"]])
        self.assertTrue(got["results"])
        self.assertTrue(got["pages"], "no page could be read")
        self.assertTrue(any("Канберр" in p["text"] or "Canberra" in p["text"] for p in got["pages"]))

    def test_a_match_time(self):  # first: the way the family server asks, one question now and then
        # «во сколько матч»: the pages read must carry a start time beside the teams, not only their menus
        got = ws.gather("Во сколько кубок России Спартак Родина?")  # as asked: the search makes do with it
        print("match:", got["engine"], [r["title"][:60] for r in got["results"]], [p["url"] for p in got["pages"]])
        for p in got["pages"]:
            print("\n==", p["url"], "\n" + "\n".join(ln for ln in p["text"].split("\n") if ws.WHEN.search(ln))[:800])
        self.assertTrue(got["pages"], "no page could be read")
        about = [r for r in got["results"] if re.search(r"Спартак|Родин", r["title"] + r["snippet"])]
        self.assertGreaterEqual(len(about) * 2, len(got["results"]), got["results"])  # not some other question's pages
        self.assertTrue(any(re.search(r"\b\d{1,2}:\d{2}\b", p["text"]) for p in got["pages"]), "no start time on the pages read")


if __name__ == "__main__":
    live = "--live" in sys.argv
    sys.argv = [a for a in sys.argv if a != "--live"]
    suite = unittest.TestSuite()
    load = unittest.defaultTestLoader.loadTestsFromTestCase
    for case in (Parsers, Guard) + ((Live,) if live else ()):
        suite.addTests(load(case))
    sys.exit(0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1)
