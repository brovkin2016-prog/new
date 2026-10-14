"""Internet search for the family AI helper: a few search pages that need no key (DuckDuckGo, Bing, Wikipedia), then
the text of the pages found. Pages are fetched only from public addresses (never this server's own services or the
home network behind it), small and quickly; their text is material for the answer, never instructions.

    search("курс доллара сегодня") -> ([{"title", "url", "snippet"}, …], "duckduckgo")
    read_page("https://…") -> ("title", "text") or raises
    gather("вопрос", n_pages=3) -> {"engine", "results", "pages": [{"title", "url", "text"}]}
"""
import calendar
import concurrent.futures
import http.client
import ipaddress
import itertools
import json
import re
import socket
import ssl
import time
import zlib
from html import unescape
from html.parser import HTMLParser
from urllib.parse import parse_qs, quote_plus, unquote, urlencode, urljoin, urlsplit

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
TIMEOUT = 8            # seconds for one connection and each read
PAGE_BYTES = 1_500_000  # no more is read of one page
PORTS = (80, 443, 8080, 8443)
SKIP_HOSTS = re.compile(r"(^|\.)(youtube\.com|youtu\.be|vk\.com|tiktok\.com|instagram\.com|facebook\.com|x\.com|twitter\.com)$")


class Blocked(Exception):
    """Not fetched: not a public web address, or not a page."""


# ---------- fetching, only from the public internet ----------

def public_address(host, port):
    """The first public address of a host; Blocked when it has none (a private, local or reserved one only)."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise Blocked(f"адрес не найден: {host}") from e
    for family, _, _, _, sa in infos:
        ip = ipaddress.ip_address(sa[0].split("%")[0])
        if getattr(ip, "ipv4_mapped", None):
            ip = ip.ipv4_mapped
        if ip.is_global and not ip.is_multicast:
            return family, sa
    raise Blocked(f"не публичный адрес: {host}")


def _request(url, method="GET", body=None, headers=None):
    u = urlsplit(url)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise Blocked("не веб-адрес")
    port = u.port or (443 if u.scheme == "https" else 80)
    if port not in PORTS:
        raise Blocked("необычный порт")
    family, sa = public_address(u.hostname, port)
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.settimeout(TIMEOUT)
    try:
        sock.connect(sa)  # the address checked above, not a second look-up that could give another one
        if u.scheme == "https":
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=u.hostname)
    except Exception:
        sock.close()
        raise
    conn = http.client.HTTPConnection(u.hostname, port, timeout=TIMEOUT)
    conn.sock = sock
    path = (u.path or "/") + ("?" + u.query if u.query else "")
    host = u.hostname if port in (80, 443) else f"{u.hostname}:{port}"
    h = {"Host": host, "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
         "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.6", "Accept-Encoding": "gzip, deflate", "Connection": "close"}
    h.update(headers or {})
    conn.request(method, path, body=body, headers=h)
    return conn, conn.getresponse()


def fetch(url, method="GET", data=None, limit=PAGE_BYTES, redirects=5):
    """(final url, content type, bytes) of a public web page; redirects are followed and checked the same way."""
    body = urlencode(data).encode() if data else None
    headers = {"Content-Type": "application/x-www-form-urlencoded"} if body else {}
    for _ in range(redirects + 1):
        conn, r = _request(url, method, body, headers)
        try:
            if r.status in (301, 302, 303, 307, 308) and r.getheader("Location"):
                url = urljoin(url, r.getheader("Location"))
                if r.status in (301, 302, 303):
                    method, body, headers = "GET", None, {}
                continue
            if r.status >= 400:
                raise Blocked(f"страница ответила {r.status}")
            raw = r.read(limit)
            enc = (r.getheader("Content-Encoding") or "").lower()
            if enc in ("gzip", "deflate") and raw:
                # a page cut at the limit is still read as far as it came
                wbits = 16 + zlib.MAX_WBITS if enc == "gzip" else zlib.MAX_WBITS
                try:
                    raw = zlib.decompressobj(wbits).decompress(raw, limit * 4)
                except zlib.error:
                    raw = zlib.decompressobj(-zlib.MAX_WBITS).decompress(raw, limit * 4)
            return url, (r.getheader("Content-Type") or "").lower(), raw[: limit * 4]
        finally:
            conn.close()
    raise Blocked("слишком много переадресаций")


def decode(raw, ctype):
    m = re.search(r"charset=([\w-]+)", ctype) or re.search(rb"<meta[^>]+charset=[\"']?([\w-]+)", raw[:4096], re.I)
    charset = m.group(1) if m else "utf-8"
    if isinstance(charset, bytes):
        charset = charset.decode("ascii", "replace")
    try:
        return raw.decode(charset, "replace")
    except LookupError:
        return raw.decode("utf-8", "replace")


# ---------- a page's readable text ----------

SKIP_TAGS = {"script", "style", "noscript", "svg", "nav", "footer", "header", "aside", "form", "iframe", "template",
             "button", "select", "option", "head"}
BLOCK_TAGS = {"p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "br", "tr", "table", "section",
              "article", "main", "blockquote", "pre", "dd", "dt", "hr", "figcaption", "td", "th"}
VOID = {"br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"}


class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skip, self.title, self.in_title = [], 0, "", False
        self.main_start = None  # where <article> or <main> began in parts
        self.ld, self.in_ld, self.about = [], False, ""  # the page's own data (JSON-LD) and its description

    def handle_starttag(self, tag, attrs):
        if tag in SKIP_TAGS:
            self.skip += 1
        elif tag == "title":
            self.in_title = True
        if tag in BLOCK_TAGS:
            self.parts.append("\n")
        if tag in ("article", "main") and self.main_start is None:
            self.main_start = len(self.parts)
        self._meta(tag, attrs)
        if tag == "script" and "ld+json" in (dict(attrs).get("type") or "").lower() and len(self.ld) < 20:
            self.in_ld = True
            self.ld.append("")

    def handle_startendtag(self, tag, attrs):
        if tag in BLOCK_TAGS:
            self.parts.append("\n")
        self._meta(tag, attrs)

    def _meta(self, tag, attrs):
        if tag == "meta" and not self.about:
            a = dict(attrs)
            if (a.get("name") or a.get("property") or "").lower() in ("description", "og:description"):
                self.about = re.sub(r"\s+", " ", a.get("content") or "").strip()[:400]

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS and self.skip:
            self.skip -= 1
        elif tag == "title":
            self.in_title = False
        if tag in BLOCK_TAGS:
            self.parts.append("\n")
        if tag == "script":
            self.in_ld = False

    def handle_data(self, data):
        if self.in_ld:
            if len(self.ld[-1]) < 200_000:
                self.ld[-1] += data
        elif self.in_title:
            self.title += data
        elif not self.skip:
            self.parts.append(data)


# The page's own data about an event (schema.org in JSON-LD): sports, concert and ticket sites often show the date and
# time only through scripts, and give them there — the match's start is then on the page even though its text is not.
EVENT_STATUS = {"EventCancelled": "отменено", "EventPostponed": "перенесено", "EventRescheduled": "перенесено",
                "EventMovedOnline": "онлайн"}
ISO = re.compile(r"(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?")


def msk_time(value):
    """An ISO date, as people here read it: «15.10.2026 20:45 МСК» (a time with its zone, in Moscow time)."""
    m = ISO.match(str(value or "").strip())
    if not m:
        return str(value or "")[:40]
    y, mo, d, hh, mm, tz = m.groups()
    if hh is None:
        return f"{d}.{mo}.{y}"
    if tz is None:
        return f"{d}.{mo}.{y} {hh}:{mm} (по времени сайта)"
    off = 0 if tz == "Z" else (1 if tz[0] == "+" else -1) * (int(tz[1:3]) * 60 + int(tz[-2:]))
    t = time.gmtime(calendar.timegm((int(y), int(mo), int(d), int(hh), int(mm), 0)) - off * 60 + 3 * 3600)
    return time.strftime("%d.%m.%Y %H:%M МСК", t)


def _name(x):
    if isinstance(x, list):
        return ", ".join(n for n in (_name(y) for y in x[:4]) if n)
    if isinstance(x, dict):
        x = x.get("name") or ""
    return re.sub(r"\s+", " ", str(x or "")).strip()[:120]


def ld_facts(blobs):
    """Lines about the events (and when an article came out) that the page's JSON-LD gives."""
    out, seen = [], set()

    def walk(x, depth):
        if depth > 8 or len(out) >= 40:
            return
        if isinstance(x, list):
            for y in x[:100]:
                walk(y, depth + 1)
            return
        if not isinstance(x, dict):
            return
        kind = x.get("@type")
        kind = " ".join(map(str, kind)) if isinstance(kind, list) else str(kind or "")
        line = ""
        if x.get("startDate"):
            teams = " — ".join(n for n in (_name(x.get("homeTeam")), _name(x.get("awayTeam"))) if n) or _name(x.get("competitor"))
            line = "Событие: " + (_name(x) or teams or kind)
            if teams and teams not in line:
                line += f" ({teams})"
            line += " · начало: " + msk_time(x["startDate"])
            if _name(x.get("location")):
                line += " · место: " + _name(x.get("location"))
            status = str(x.get("eventStatus") or "").rsplit("/", 1)[-1]
            if status in EVENT_STATUS:
                line += " · " + EVENT_STATUS[status]
        elif x.get("datePublished") and re.search(r"Article|Posting|Report", kind):
            line = "Опубликовано: " + msk_time(x.get("dateModified") or x["datePublished"])
        if line and line not in seen:
            seen.add(line)
            out.append(line)
        for k in ("@graph", "subEvent", "mainEntity", "itemListElement", "item", "event", "events"):
            if x.get(k):
                walk(x[k], depth + 1)

    for blob in blobs:
        try:
            walk(json.loads(blob.strip().rstrip(";")), 0)
        except ValueError:
            continue
    return out


def page_text(html):
    """(title, readable text): the article's or main part when the page has a real one, short menu lines dropped; the
    page's own data on its events and its description go first."""
    p = _Text()
    try:
        p.feed(html)
        p.close()
    except Exception:
        pass
    whole = "".join(p.parts)
    main = "".join(p.parts[p.main_start:]) if p.main_start is not None else ""
    text = main if len(main.strip()) > 800 else whole
    lines = []
    for line in text.split("\n"):
        line = re.sub(r"\s+", " ", line).strip()
        # menus and buttons are short; numbers (prices, dates, scores) keep a short line
        if len(line) >= 40 or (len(line) >= 3 and re.search(r"\d", line)) or len(line.split()) >= 5:
            if not lines or lines[-1] != line:
                lines.append(line)
    about = unescape(p.about)
    head = ld_facts(p.ld) + ([about] if len(about) >= 40 and about not in "\n".join(lines[:5]) else [])
    return re.sub(r"\s+", " ", p.title).strip(), "\n".join(head + lines)


# ---------- the part of a long page the question is about ----------

WORD = re.compile(r"[0-9a-zа-яё]+")
STOP = {"что", "как", "где", "когда", "сколько", "какой", "какая", "какое", "какие", "кто", "чем", "это", "для", "или",
        "про", "при", "все", "его", "она", "они", "так", "уже", "еще", "есть", "был", "была", "были", "будет", "the",
        "and", "for", "what", "when", "how", "who", "where", "with"}
WHEN = re.compile(r"\b\d{1,2}:\d{2}\b|\b\d{1,2}\.\d{1,2}\.\d{2,4}\b|\bМСК\b|\b\d{1,2}\s+(?:январ|феврал|март|апрел|ма[яй]|"
                  r"июн|июл|август|сентябр|октябр|ноябр|декабр)", re.I)


def stems(query):
    """The query's words as their beginnings («Спартак» → «спарт»), so that «Спартака» and «Родины» are found too."""
    out = set()
    for w in WORD.findall(query.lower().replace("ё", "е")):
        if w.isdigit() and len(w) >= 2:
            out.add(w)
        elif len(w) >= 3 and w not in STOP:
            out.add(w[:max(3, min(5, len(w) - 2))])
    return out


def focus(text, query, limit):
    """At most limit characters of a page: its beginning, then the lines that have most of the query's words (rarer
    words count more, a date or a time beside them more still) with the lines around them, in the page's order. A
    page that fits, or no query: its beginning, as before."""
    if len(text) <= limit or not query:
        return text[:limit]
    keys = stems(query)
    if not keys:
        return text[:limit]
    lines = []
    for line in text.split("\n"):  # a page in one long line is read sentence by sentence
        while len(line) > 500:
            cut = max(line.rfind(". ", 0, 400), line.rfind("! ", 0, 400), line.rfind("? ", 0, 400))
            cut = cut + 1 if cut > 100 else 400
            lines.append(line[:cut].strip())
            line = line[cut:].strip()
        lines.append(line)
    hits = [{k for k in keys if any(w.startswith(k) for w in WORD.findall(ln.lower().replace("ё", "е")))} for ln in lines]
    common = max(3, len(lines) // 8)
    weight = {k: 1.0 if sum(k in h for h in hits) <= common else 0.4 for k in keys}
    score = []
    for ln, h in zip(lines, hits):
        s = sum(weight[k] for k in h)
        if s:
            s += 1.0 if WHEN.search(ln) else 0.3 if re.search(r"\d", ln) else 0
        score.append(s)
    keep, used = set(), 0
    for i, ln in enumerate(lines):  # the beginning: what the page is
        if used + len(ln) + 1 > min(600, limit // 5):
            break
        keep.add(i)
        used += len(ln) + 1
    for i in sorted((i for i in range(len(lines)) if score[i]), key=lambda i: -score[i]):
        for r in ((2, 1, 0) if score[i] >= 2 else (1, 0)):  # with the lines around it if they fit, else alone
            add = [j for j in range(max(0, i - r), min(len(lines), i + r + 1)) if j not in keep]
            cost = sum(len(lines[j]) + 1 for j in add)
            if used + cost <= limit:
                keep.update(add)
                used += cost
                break
        if used > limit - 100:
            break
    for i, ln in enumerate(lines):  # room left: the page's text on from its beginning, as before
        if used + len(ln) + 1 > limit:
            break
        if i not in keep:
            keep.add(i)
            used += len(ln) + 1
    if not keep:
        return text[:limit]
    out, last = [], -1
    for i in sorted(keep):
        if last >= 0 and i != last + 1:
            out.append("…")
        out.append(lines[i])
        last = i
    return "\n".join(out)[:limit]


def read_page(url, limit=4000, query=None):
    """(title, text up to limit characters) of one public web page; with a query, its part about it (focus)."""
    final, ctype, raw = fetch(url)
    if "pdf" in ctype or final.lower().endswith(".pdf"):
        raise Blocked("PDF")
    if ctype and not any(t in ctype for t in ("html", "text/plain", "xml")):
        raise Blocked("не страница: " + ctype.split(";")[0])
    text = decode(raw, ctype)
    if "text/plain" in ctype:
        return "", focus(text, query, limit)
    title, body = page_text(text)
    return title, focus(body, query, limit)


# ---------- search pages ----------

class _Results(HTMLParser):
    """Collects results by rules: (tag, class part) starts a title link or a snippet; a block class starts a result."""

    def __init__(self, title_rule, snippet_rule, block=None, title_in=None):
        super().__init__(convert_charrefs=True)
        self.title_rule, self.snippet_rule, self.block, self.title_in = title_rule, snippet_rule, block, title_in
        self.results, self.cap, self.depth, self.in_block, self.in_heading = [], None, 0, None, None

    @staticmethod
    def _has(attrs, part):
        return part in (dict(attrs).get("class") or "").split()

    def handle_starttag(self, tag, attrs):
        if tag in VOID:
            return
        self.depth += 1
        a = dict(attrs)
        if self.block and self.in_block is None and self._has(attrs, self.block[1]) and tag == self.block[0]:
            self.in_block = self.depth
            self.results.append({"title": "", "url": "", "snippet": ""})
        if self.title_in and tag == self.title_in and (self.in_block or not self.block):
            self.in_heading = self.depth
        if self.cap:
            return
        cur = self.results[-1] if self.results else None
        is_title = (tag == "a" and self.in_heading and self.in_block and cur is not None and not cur["url"]) if self.title_in \
            else (tag == self.title_rule[0] and self._has(attrs, self.title_rule[1]))
        if is_title:
            if not self.block:
                self.results.append({"title": "", "url": "", "snippet": ""})
            self.results[-1]["url"] = a.get("href") or ""
            self.cap = ("title", self.depth)
        elif self.results and tag == self.snippet_rule[0] and (self.snippet_rule[1] is None or self._has(attrs, self.snippet_rule[1])) \
                and not self.results[-1]["snippet"] and (self.in_block or not self.block):
            self.cap = ("snippet", self.depth)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if self.cap and self.cap[1] == self.depth:
            self.cap = None
        if self.in_heading == self.depth:
            self.in_heading = None
        if self.in_block == self.depth:
            self.in_block = None
        self.depth = max(0, self.depth - 1)

    def handle_data(self, data):
        if self.cap and self.results:
            self.results[-1][self.cap[0]] += data


def _clean(results):
    out, seen = [], set()
    for r in results:
        url = r["url"].strip()
        if url.startswith("//"):
            url = "https:" + url
        u = urlsplit(url)
        if "duckduckgo.com" in (u.hostname or "") and u.path.startswith("/l/"):
            url = unquote(parse_qs(u.query).get("uddg", [""])[0])
        elif "bing.com" in (u.hostname or "") and u.path.startswith("/ck/"):
            enc = parse_qs(u.query).get("u", [""])[0]
            if enc.startswith("a1"):
                import base64
                try:
                    url = base64.urlsafe_b64decode(enc[2:] + "=" * (-len(enc[2:]) % 4)).decode()
                except Exception:
                    url = ""
        u = urlsplit(url)
        if u.scheme not in ("http", "https") or not u.hostname or "duckduckgo.com" in u.hostname or "bing.com" in u.hostname:
            continue
        if url in seen:
            continue
        seen.add(url)
        title = re.sub(r"\s+", " ", unescape(r["title"])).strip()
        snippet = re.sub(r"\s+", " ", unescape(r["snippet"])).strip()
        if title:
            out.append({"title": title[:200], "url": url, "snippet": snippet[:400]})
    return out


def ddg_html(html):
    p = _Results(("a", "result__a"), ("a", "result__snippet"))
    p.feed(html)
    return _clean(p.results)


def ddg_lite(html):
    p = _Results(("a", "result-link"), ("td", "result-snippet"))
    p.feed(html)
    return _clean(p.results)


def bing_rss(xml):
    """Bing's results as RSS: from a datacenter its search page gives results for some other question, its RSS
    (with the Russian market) the real ones."""
    out = []
    for item in re.findall(r"<item>(.*?)</item>", xml, re.S)[:20]:
        get = lambda tag: (re.search(rf"<{tag}>(.*?)</{tag}>", item, re.S) or [None, ""])[1]
        text = lambda s: re.sub(r"<[^>]+>", "", unescape(re.sub(r"<!\[CDATA\[(.*?)\]\]>", r"\1", s, flags=re.S)))
        out.append({"title": text(get("title")), "url": unescape(get("link")).strip(), "snippet": text(get("description"))})
    return _clean(out)


def duckduckgo(query):
    _, ctype, raw = fetch("https://html.duckduckgo.com/html/", "POST", {"q": query, "kl": "ru-ru"})
    found = ddg_html(decode(raw, ctype))
    if not found:
        _, ctype, raw = fetch("https://lite.duckduckgo.com/lite/", "POST", {"q": query, "kl": "ru-ru"})
        found = ddg_lite(decode(raw, ctype))
    return found


def bing(query):
    _, ctype, raw = fetch("https://www.bing.com/search?" + urlencode({"q": query, "format": "rss", "mkt": "ru-RU"}))
    return bing_rss(decode(raw, ctype))


def wikipedia(query):
    out = []
    for lang in ("ru", "en"):
        _, _, raw = fetch(f"https://{lang}.wikipedia.org/w/api.php?" + urlencode(
            {"action": "query", "list": "search", "srsearch": query, "format": "json", "srlimit": "5", "utf8": "1"}))
        for it in json.loads(raw.decode("utf-8", "replace")).get("query", {}).get("search", []):
            snippet = re.sub(r"<[^>]+>", "", it.get("snippet", ""))
            out.append({"title": it["title"], "url": f"https://{lang}.wikipedia.org/wiki/" + quote_plus(it["title"].replace(" ", "_"), safe="_()"),
                        "snippet": unescape(snippet)})
        if out:
            break
    return out


ENGINES = [("duckduckgo", duckduckgo), ("bing", bing), ("wikipedia", wikipedia)]


# words that say little about which pages are the right ones: a page about the Falkland Islands has «время» too
GENERIC = stems("дата время сегодня завтра вчера сейчас начало начнется начинается состоится пройдет расписание "
                "новости матч игра год цена")


def relevant(results, query):
    """The results about the question. A search page that takes the server for a robot may answer some other question
    instead (Bing's page gave the Falkland Islands for «Спартак Родина»): a result whose title and snippet have none of
    the query's words (two of them, for a query of three words or more) is left out."""
    keys = {k for k in stems(query) if k not in GENERIC and not k.isdigit()}
    if not keys:
        return results
    need = 1 if len(keys) <= 2 else 2
    out = []
    for r in results:
        words = WORD.findall((r["title"] + " " + r["snippet"]).lower().replace("ё", "е"))
        if sum(any(w.startswith(k) for w in words) for k in keys) >= need:
            out.append(r)
    return out


def core_query(query):
    """The query without its common words and numbers: «Спартак Родина Кубок России 2026 дата и время матча» →
    «спартак родина кубок россии» (Bing answers that long one with pages about a fever, the short one rightly)."""
    words = []
    for w in WORD.findall(query.lower().replace("ё", "е")):
        k = stems(w)
        if k and not (k & GENERIC) and not w.isdigit():
            words.append(w)
    return " ".join(words)


def search(query, n=8, budget=12.0):
    """The results of the web engines, all asked at once, taken in turns (the first of each, then the second…), only
    those about the question. The web gave fewer than three: once more by the query's main words (core_query), and
    Wikipedia's results after them. ([], None): nothing found."""
    query = query.strip()[:300]
    if not query:
        return [], None
    end = time.time() + budget
    web, wiki, names = _search(query, end)
    short = core_query(query)
    if len(web) < 3 and short and short != query.lower() and end - time.time() > 2:
        web2, wiki2, names2 = _search(short, end)
        web, wiki, names = web + web2, wiki or wiki2, names + names2
    merged, seen = [], set()
    for r in web + wiki:
        if r["url"] not in seen:
            seen.add(r["url"])
            merged.append(r)
    found = [r for r in merged if not SKIP_HOSTS.search(urlsplit(r["url"]).hostname or "")][:n] or merged[:n]
    return found, "+".join(dict.fromkeys(names)) or None


def _search(query, end):
    """(the web engines' results in turns, Wikipedia's — waited for only when the web gave fewer than three, the
    engines that gave something)"""
    pool = concurrent.futures.ThreadPoolExecutor(len(ENGINES))
    futures = [(name, pool.submit(fn, query)) for name, fn in ENGINES]
    got = {}
    try:
        for name, f in futures:
            if name == "wikipedia" and sum(map(len, got.values())) >= 3:
                break
            try:
                got[name] = relevant(f.result(timeout=max(0.1, end - time.time())), query)
            except Exception:
                continue
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    web = [r for row in itertools.zip_longest(*[got.get(name, []) for name, _ in ENGINES if name != "wikipedia"])
           for r in row if r]
    return web, got.get("wikipedia", []), [name for name, _ in ENGINES if got.get(name)]


def gather(query, n_pages=4, page_chars=3500, budget=20.0):
    """Search, then read the first pages that read well (in parallel), each page's part about the query. The search
    results' snippets stay as well, so even pages that did not open still give something."""
    start = time.time()
    results, engine = search(query, budget=min(12.0, budget))
    pages = []
    if results:
        wanted = [r for r in results if not SKIP_HOSTS.search(urlsplit(r["url"]).hostname or "")][: n_pages + 3]
        pool = concurrent.futures.ThreadPoolExecutor(max(1, min(7, len(wanted))))
        futures = [(r, pool.submit(read_page, r["url"], page_chars, query)) for r in wanted]
        try:
            for r, f in futures:
                left = budget - (time.time() - start)
                if left <= 0 or len(pages) >= n_pages:
                    break
                try:
                    title, text = f.result(timeout=left)
                except Exception:
                    continue
                if len(text) >= 200:
                    pages.append({"title": title or r["title"], "url": r["url"], "text": text})
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
    return {"engine": engine, "results": results, "pages": pages}


if __name__ == "__main__":  # python3 websearch.py "вопрос": what the helper would read
    import sys
    got = gather(" ".join(sys.argv[1:]) or "курс доллара ЦБ сегодня")
    print("engine:", got["engine"])
    for r in got["results"]:
        print("-", r["title"], "|", r["url"])
    for p in got["pages"]:
        print("\n==", p["title"], p["url"], len(p["text"]), "chars\n", p["text"][:300])
