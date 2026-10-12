"""Tests of websearch.py. Without arguments: offline (the pages' shapes, the guard against internal addresses).
With --live: the real search pages from this machine (the CI does that; the family server's network is alike)."""
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

BING = """<ol id="b_results"><li class="b_algo"><div class="b_tpcn"><a href="https://site.ru/">site.ru</a></div>
<h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=1&amp;u=a1aHR0cHM6Ly9zaXRlLnJ1L25ld3M&amp;ntb=1">Новости сайта</a></h2>
<div class="b_caption"><p class="b_lineclamp2">Свежие <strong>новости</strong> дня</p></div></li>
<li class="b_algo"><h2><a href="https://other.ru/page">Другая страница</a></h2><p>Описание другой</p></li>
<li class="b_ad"><h2><a href="https://ads.example/">Реклама</a></h2></li></ol>"""

PAGE = """<html><head><title> Курс доллара  </title><script>var x = "не текст";</script><style>p{}</style></head>
<body><nav><a href="/">Главная</a> <a href="/n">Новости</a></nav><header>Шапка сайта</header>
<article><h1>Официальный курс доллара на 12 октября</h1>
<p>Банк России установил официальный курс доллара США на завтра в размере 81,25 рубля, это на 30 копеек больше.</p>
<p>Курс евро составит 94,10 рубля.</p><div>Поделиться</div>""" + "<p>Подробный разбор причин изменения курса и мнения аналитиков о дальнейшей динамике рубля.</p>" * 12 + """
</article><footer>© 2026 Сайт. Все права защищены.</footer></body></html>"""


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
        r = ws.bing_html(BING)
        self.assertEqual([(x["title"], x["url"]) for x in r], [("Новости сайта", "https://site.ru/news"), ("Другая страница", "https://other.ru/page")])
        self.assertEqual(r[0]["snippet"], "Свежие новости дня")
        self.assertEqual(r[1]["snippet"], "Описание другой")

    def test_page_text(self):
        title, text = ws.page_text(PAGE)
        self.assertEqual(title, "Курс доллара")
        self.assertIn("81,25 рубля", text)
        self.assertIn("94,10", text)  # a short line with a number stays
        for junk in ("не текст", "Главная", "Шапка", "© 2026", "Поделиться"):
            self.assertNotIn(junk, text)


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
                works[name] = len(fn("курс доллара ЦБ"))
            except Exception as e:  # one engine down is not a failure, all of them is
                works[name] = repr(e)[:120]
        print("engines:", works)
        self.assertTrue(any(isinstance(v, int) and v >= 2 for v in works.values()), works)

    def test_gather_reads_pages(self):
        got = ws.gather("столица Австралии")
        print("gather:", got["engine"], [p["url"] for p in got["pages"]])
        self.assertTrue(got["results"])
        self.assertTrue(got["pages"], "no page could be read")
        self.assertTrue(any("Канберр" in p["text"] or "Canberra" in p["text"] for p in got["pages"]))


if __name__ == "__main__":
    live = "--live" in sys.argv
    sys.argv = [a for a in sys.argv if a != "--live"]
    suite = unittest.TestSuite()
    load = unittest.defaultTestLoader.loadTestsFromTestCase
    for case in (Parsers, Guard) + ((Live,) if live else ()):
        suite.addTests(load(case))
    sys.exit(0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1)
