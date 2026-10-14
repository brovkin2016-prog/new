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

    def test_page_text(self):
        title, text = ws.page_text(PAGE)
        self.assertEqual(title, "Курс доллара")
        self.assertIn("81,25 рубля", text)
        self.assertIn("94,10", text)  # a short line with a number stays
        for junk in ("не текст", "Главная", "Шапка", "© 2026", "Поделиться"):
            self.assertNotIn(junk, text)

    def test_event_data(self):
        # a sports page that draws the match with scripts: its time is only in JSON-LD and the description
        title, text = ws.page_text(MATCH)
        lines = text.split("\n")
        self.assertEqual(lines[0], "Событие: Родина — Спартак · начало: 15.10.2026 20:45 МСК · место: Арена Химки")
        self.assertIn("Событие: Спартак — Родина · начало: 01.09.2026 19:30 МСК · перенесено", lines)  # UTC → МСК
        self.assertIn("Кубок России. Родина и Спартак сыграют 15 октября в 20:45 по московскому времени.", lines)
        self.assertNotIn("window.__DATA__", text)
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

    def test_match_time(self):
        # «во сколько матч»: the pages read must carry a start time beside the teams, not only their menus
        for q in ("Спартак Родина Кубок России 2026 дата и время матча", "Спартак Родина Кубок России"):
            try:
                found = ws.bing(q)
                print("bing:", q, len(found), len(ws.relevant(found, q)), [r["title"][:50] for r in found[:5]])
            except Exception as e:  # noqa: BLE001
                print("bing:", q, repr(e)[:200])
        got = ws.gather("Во сколько кубок России Спартак Родина?")  # as asked: the search makes do with it
        print("match:", got["engine"], [p["url"] for p in got["pages"]])
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
