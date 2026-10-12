"""Internet search for the family AI helper: a few search pages that need no key (DuckDuckGo, Bing, Wikipedia), then
the text of the pages found. Pages are fetched only from public addresses (never this server's own services or the
home network behind it), small and quickly; their text is material for the answer, never instructions.

    search("курс доллара сегодня") -> ([{"title", "url", "snippet"}, …], "duckduckgo")
    read_page("https://…") -> ("title", "text") or raises
    gather("вопрос", n_pages=3) -> {"engine", "results", "pages": [{"title", "url", "text"}]}
"""
import concurrent.futures
import http.client
import ipaddress
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

    def handle_starttag(self, tag, attrs):
        if tag in SKIP_TAGS:
            self.skip += 1
        elif tag == "title":
            self.in_title = True
        if tag in BLOCK_TAGS:
            self.parts.append("\n")
        if tag in ("article", "main") and self.main_start is None:
            self.main_start = len(self.parts)

    def handle_startendtag(self, tag, attrs):
        if tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in SKIP_TAGS and self.skip:
            self.skip -= 1
        elif tag == "title":
            self.in_title = False
        if tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        elif not self.skip:
            self.parts.append(data)


def page_text(html):
    """(title, readable text): the article's or main part when the page has a real one, short menu lines dropped."""
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
    return re.sub(r"\s+", " ", p.title).strip(), "\n".join(lines)


def read_page(url, limit=4000):
    """(title, text up to limit characters) of one public web page."""
    final, ctype, raw = fetch(url)
    if "pdf" in ctype or final.lower().endswith(".pdf"):
        raise Blocked("PDF")
    if ctype and not any(t in ctype for t in ("html", "text/plain", "xml")):
        raise Blocked("не страница: " + ctype.split(";")[0])
    text = decode(raw, ctype)
    if "text/plain" in ctype:
        return "", text[:limit]
    title, body = page_text(text)
    return title, body[:limit]


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


def bing_html(html):
    p = _Results(None, ("p", None), block=("li", "b_algo"), title_in="h2")
    p.feed(html)
    return _clean(p.results)


def duckduckgo(query):
    _, ctype, raw = fetch("https://html.duckduckgo.com/html/", "POST", {"q": query, "kl": "ru-ru"})
    found = ddg_html(decode(raw, ctype))
    if not found:
        _, ctype, raw = fetch("https://lite.duckduckgo.com/lite/", "POST", {"q": query, "kl": "ru-ru"})
        found = ddg_lite(decode(raw, ctype))
    return found


def bing(query):
    _, ctype, raw = fetch("https://www.bing.com/search?" + urlencode({"q": query, "setlang": "ru", "cc": "RU", "count": "10"}))
    return bing_html(decode(raw, ctype))


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


def search(query, n=6, budget=12.0):
    """The first engine (in this order) that finds at least two pages; all are asked at once, so a slow one costs
    nothing. ([], None) when none found anything."""
    query = query.strip()[:300]
    if not query:
        return [], None
    pool = concurrent.futures.ThreadPoolExecutor(len(ENGINES))
    futures = [(name, pool.submit(fn, query)) for name, fn in ENGINES]
    end = time.time() + budget
    best = ([], None)
    try:
        for name, f in futures:
            try:
                found = f.result(timeout=max(0.1, end - time.time()))
            except Exception:
                continue
            found = [r for r in found if not SKIP_HOSTS.search(urlsplit(r["url"]).hostname or "")][:n] or found[:n]
            if len(found) >= 2:
                return found, name
            if found and not best[0]:
                best = (found, name)
        return best
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def gather(query, n_pages=3, page_chars=3500, budget=20.0):
    """Search, then read the first pages that read well (in parallel). The search results' snippets stay as well,
    so even pages that did not open still give something."""
    start = time.time()
    results, engine = search(query, budget=min(12.0, budget))
    pages = []
    if results:
        pool = concurrent.futures.ThreadPoolExecutor(min(5, len(results)))
        wanted = [r for r in results if not SKIP_HOSTS.search(urlsplit(r["url"]).hostname or "")][: n_pages + 2]
        futures = [(r, pool.submit(read_page, r["url"], page_chars)) for r in wanted]
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
