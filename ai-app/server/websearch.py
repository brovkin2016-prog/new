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
import os
import re
import socket
import ssl
import subprocess
import tempfile
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


# what a page's own request may not set: the connection's (this side sets them) and the person's (no cookies are sent)
RELAY_DROP = {"host", "connection", "content-length", "transfer-encoding", "te", "upgrade", "keep-alive", "accept-encoding",
              "cookie", "origin", "referer", "proxy-authorization", "proxy-connection", "trailer", "expect"}


def relay(url, method="GET", body=None, headers=None, limit=3 * 1024 * 1024, redirects=5):
    """A request of the owner's mini-app passed on (the phone's frame cannot reach most sites: they do not allow other
    pages to read them, and on a day without mobile internet nothing outside is reached): only public addresses, as
    fetch(); every answer comes back, an error page too. → (status, reason, final url, content type, bytes)."""
    hdrs = {str(k)[:100]: str(v)[:4000] for k, v in list((headers or {}).items())[:30]
            if str(k).lower() not in RELAY_DROP and not str(k).lower().startswith(("sec-", "proxy-")) and not set("\r\n") & set(str(k) + str(v))}
    if body is not None and not any(k.lower() == "content-type" for k in hdrs):
        hdrs["Content-Type"] = "text/plain;charset=UTF-8"  # as a browser sends a text
    for _ in range(redirects + 1):
        conn, r = _request(url, method, body, hdrs)
        try:
            if r.status in (301, 302, 303, 307, 308) and r.getheader("Location"):
                url = urljoin(url, r.getheader("Location"))
                if r.status in (301, 302, 303) and method != "HEAD":
                    method, body = "GET", None
                    hdrs = {k: v for k, v in hdrs.items() if k.lower() != "content-type"}
                continue
            raw = r.read(limit + 1) if method != "HEAD" else b""
            if len(raw) > limit:
                raise Blocked(f"ответ больше {limit // (1024 * 1024)} МБ")
            enc = (r.getheader("Content-Encoding") or "").lower()
            if enc in ("gzip", "deflate") and raw:
                wbits = 16 + zlib.MAX_WBITS if enc == "gzip" else zlib.MAX_WBITS
                try:
                    d = zlib.decompressobj(wbits)
                    raw = d.decompress(raw, limit + 1)
                except zlib.error:
                    d = zlib.decompressobj(-zlib.MAX_WBITS)
                    raw = d.decompress(raw, limit + 1)
                if len(raw) > limit or d.unconsumed_tail:
                    raise Blocked(f"ответ больше {limit // (1024 * 1024)} МБ")
            return r.status, r.reason or "", url, (r.getheader("Content-Type") or ""), raw
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
              "article", "main", "blockquote", "pre", "dd", "dt", "hr", "figcaption"}
VOID = {"br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"}


class _Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skip, self.title, self.in_title = [], 0, "", False
        self.main_start = None  # where <article> or <main> began in parts
        self.about = ""  # the page's description
        self.cells, self.in_cell = 0, 0  # a table's row is one line: «1 | Зенит | 12 | 27»

    def handle_starttag(self, tag, attrs):
        if tag in SKIP_TAGS:
            self.skip += 1
        elif tag == "title":
            self.in_title = True
        if tag == "tr":
            self.cells, self.in_cell = 0, 0
        if tag in ("td", "th"):
            self.parts.append(" | " if self.cells else "\n")
            self.cells += 1
            self.in_cell += 1
        elif tag in BLOCK_TAGS and not self.in_cell:
            self.parts.append("\n\x01" if tag in ("h1", "h2", "h3", "h4") else "\n")  # (a heading stays, short or not)
        if tag in ("article", "main") and self.main_start is None:
            self.main_start = len(self.parts)
        self._meta(tag, attrs)

    def handle_startendtag(self, tag, attrs):
        if tag in BLOCK_TAGS and not self.in_cell:
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
        if tag in ("td", "th"):
            self.in_cell = max(0, self.in_cell - 1)
        elif tag in BLOCK_TAGS and not self.in_cell:
            self.parts.append("\n")

    def handle_data(self, data):
        if self.in_title:
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


LD_JSON = re.compile(r"<script\b[^>]*ld\+json[^>]*>(.*?)</script\s*>", re.S | re.I)
NOISE = re.compile(r"<(script|style|svg|noscript|template)\b.*?</\1\s*>", re.S | re.I)


def page_text(html):
    """(title, readable text): the article's or main part when the page has a real one, short menu lines dropped; the
    page's own data on its events and its description go first. Scripts and styles are cut out before the page is
    read (the parser is slow on the megabytes of them a sports page has)."""
    ld = [b for b in LD_JSON.findall(html)[:20] if len(b) < 200_000]
    html = NOISE.sub(" ", html)
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
        heading = line.startswith("\x01")
        line = re.sub(r"\s+", " ", line.replace("\x01", "")).strip()
        # menus and buttons are short; numbers (prices, dates, scores) and «A — B» (a match, a route) keep a short line
        if len(line) >= 40 or (len(line) >= 3 and re.search(r"\d", line)) or len(line.split()) >= 5 \
                or re.search(r"\w\s[—–-]\s\w", line) or (heading and len(line) >= 3):
            if not lines or lines[-1] != line:
                lines.append(line)
    bare = [bool(re.fullmatch(r"[\d:.,/ -]+", ln)) for ln in lines]  # a news feed's times: «20:35», «20:34», …
    lines = [ln for i, ln in enumerate(lines) if not (bare[i] and sum(bare[max(0, i - 2):i + 3]) >= 3)]
    about = unescape(p.about)
    head = ld_facts(ld) + ([about] if len(about) >= 40 and about not in "\n".join(lines[:5]) else [])
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
    words = [WORD.findall(ln.lower().replace("ё", "е")) for ln in lines]
    hits = [{k for k in keys if any(w.startswith(k) for w in ws)} for ws in words]
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
    """(title, text up to limit characters) of one public web page; with a query, its part about it (focus). (v37) A page
    whose text its own scripts draw (almost nothing in the HTML) is read once more by a small browser (moli)."""
    final, ctype, raw = fetch(url)
    if "pdf" in ctype or final.lower().endswith(".pdf"):
        raise Blocked("PDF")
    if ctype and not any(t in ctype for t in ("html", "text/plain", "xml")):
        raise Blocked("не страница: " + ctype.split(";")[0])
    text = decode(raw, ctype)
    if "text/plain" in ctype:
        return "", focus(text, query, limit)
    title, body = page_text(text)
    if len(body) < 300 and "<script" in text.lower():
        drawn = js_page(final)
        if drawn and len(drawn) > len(body) + 100:
            body = drawn
    return title, focus(body, query, limit)


# ---------- (v37) a page its scripts draw: moli, a small headless browser (~50 MB, Apache-2.0/MIT) ----------
# Only the pages that came back almost empty; only public addresses (its own guard against private and local addresses,
# and this server's own public addresses too); writing only in its temporary folder (FENCE: the helper's sandbox);
# 15 s and 3 MB at most; its output is text, its scripts' requests stay in it.
MOLI = os.environ.get("WEB_MOLI", "/opt/aibot/moli/moli")
MOLI_SEC = 15
FENCE = None  # set by the helper: the command fenced in (aibot.fenced); none — moli is not run at all
_own = []
# (v37, the review) besides moli's «private networks»: the shared, link-local and unique-local ranges, said outright
ALWAYS_BLOCKED = ["0.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "::1/128", "fc00::/7", "fe80::/10"]


def own_cidrs():
    """This server's own addresses (a page's script must not reach the server through them either): its domain's
    addresses (behind a provider's NAT the public one is on no interface), the address it goes out from, and those on its
    interfaces when `ip` may run (the helper's unit has no netlink). Kept once something was found."""
    if _own:
        return _own[0]
    found = set()

    def add(a):
        try:
            ip = ipaddress.ip_address(a.split("%")[0])
            found.add(f"{ip}/{32 if ip.version == 4 else 128}")
        except ValueError:
            pass
    dom = os.environ.get("APP_DOMAIN", "").strip()
    if dom:
        try:
            for info in socket.getaddrinfo(dom, None):
                add(info[4][0])
        except OSError:
            pass
    for fam, probe in ((socket.AF_INET, ("1.1.1.1", 53)), (socket.AF_INET6, ("2606:4700:4700::1111", 53))):
        try:  # (a UDP «connect» sends nothing: it only picks the way out)
            with socket.socket(fam, socket.SOCK_DGRAM) as so:
                so.connect(probe)
                add(so.getsockname()[0])
        except OSError:
            pass
    try:
        out = subprocess.run(["ip", "-o", "addr", "show", "scope", "global"], capture_output=True, text=True, timeout=5).stdout
        for m in re.finditer(r"\binet6?\s+([0-9a-fA-F:.]+)/", out):
            add(m.group(1))
    except (OSError, subprocess.SubprocessError):
        pass
    if found:
        _own.append(sorted(found))
    return sorted(found)


def js_page(url):
    """The text of a page as its scripts draw it, or "" (no moli here, not a public address, nothing in time). (v37, the
    review) Only fenced in (the helper's sandbox) and never as root: srv-agent (root) loads this file for its own search —
    there pages are read without scripts."""
    if FENCE is None or os.geteuid() == 0 or not (os.path.isfile(MOLI) and os.access(MOLI, os.X_OK)):
        return ""
    try:
        u = urlsplit(url)
        if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password:
            return ""
        public_address(u.hostname, u.port or (443 if u.scheme == "https" else 80))
    except (Blocked, ValueError, OSError):
        return ""
    cmd = [MOLI, "fetch", "--block-private-networks", "--dump", "markdown", "--timeout", str(MOLI_SEC * 1000),
           "--http-max-response-size", "3000000", "--disable-subframes", "-H", "User-Agent: " + UA]
    # one --block-cidrs, the ranges comma-joined (moli takes the flag once: a second one fails the whole run)
    cmd += ["--block-cidrs", ",".join(ALWAYS_BLOCKED + own_cidrs())]
    cmd.append(url)
    with tempfile.TemporaryDirectory(prefix="moli-") as tmp:
        try:
            p = subprocess.run(FENCE(cmd) if FENCE else cmd, capture_output=True, timeout=MOLI_SEC + 10, cwd=tmp,
                               env={"PATH": "/usr/bin:/bin", "HOME": tmp, "TMPDIR": tmp, "MOLI_BLOCK_PRIVATE_NETWORKS": "1"})
        except (OSError, subprocess.SubprocessError):
            return ""
    if p.returncode != 0:
        return ""
    text = p.stdout[:PAGE_BYTES].decode("utf-8", "replace")
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)  # pictures
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)  # links: their words only
    return re.sub(r"[ \t]+", " ", re.sub(r"\n{3,}", "\n\n", text)).strip()


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
    html = decode(raw, ctype)
    found = ddg_html(html)
    if not found and re.search(r"anomaly|challenge|captcha", html, re.I):  # its robot check: the lite page would get one too
        raise Blocked("проверка на робота")
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


EXA_KEY = ""  # the owner's Exa key (set by the server): a search made for AI, the pages' text in the answer
EXA_TEXT = 20000  # characters of each page's text Exa gives


def exa(query, key=None, n=8):
    """Exa's results with their pages' text («text»): none of the pages need opening then. key: another than EXA_KEY
    (the owner's new one, checked before it is kept)."""
    body = json.dumps({"query": query, "type": "auto", "numResults": n, "contents": {"text": True}}).encode()
    try:
        conn, r = _request("https://api.exa.ai/search", "POST", body, {"x-api-key": key or EXA_KEY, "Content-Type": "application/json",
                                                                        "Accept": "application/json"})
        try:
            raw = r.read(4_000_000)
            status = r.status
            if (r.getheader("Content-Encoding") or "").lower() == "gzip":
                raw = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(raw)
        finally:
            conn.close()
    except (OSError, http.client.HTTPException) as e:
        raise Blocked("нет связи") from e
    if status in (401, 403):
        raise Blocked("ключ не принят")
    if status in (402, 429):
        raise Blocked("лимит исчерпан")
    if status >= 400:
        raise Blocked(f"ответ {status}")
    out = []
    for it in json.loads(raw.decode("utf-8", "replace")).get("results") or []:
        text = re.sub(r"[ \t]+", " ", str(it.get("text") or "")).strip()[:EXA_TEXT]
        out.append({"title": str(it.get("title") or it.get("url") or ""), "url": str(it.get("url") or ""),
                    "snippet": re.sub(r"\s+", " ", text)[:400], "text": text})
    return [dict(r, title=re.sub(r"\s+", " ", r["title"]).strip()[:200]) for r in out
            if r["url"].startswith(("http://", "https://")) and r["title"]]


ENGINES = [("duckduckgo", duckduckgo), ("bing", bing), ("wikipedia", wikipedia)]


def engines():
    """The engines asked, in their order: Exa first when the owner gave its key."""
    return ([("exa", exa)] if EXA_KEY else []) + ENGINES
STATS = {}  # engine -> how it answered last: {"at", "ok", "n" (results about the question), "why" (when not)}


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
    asked = engines()
    pool = concurrent.futures.ThreadPoolExecutor(len(asked))
    futures = [(name, pool.submit(fn, query)) for name, fn in asked]
    got = {}
    try:
        for name, f in futures:
            if name == "wikipedia" and sum(map(len, got.values())) >= 3:
                break
            try:
                found = f.result(timeout=max(0.1, end - time.time()))
            except Exception as e:
                why = "не ответил вовремя" if isinstance(e, concurrent.futures.TimeoutError) else \
                    str(e)[:80] if isinstance(e, Blocked) else "нет связи"
                STATS[name] = {"at": int(time.time()), "ok": False, "n": 0, "why": why}
                continue
            got[name] = relevant(found, query)
            STATS[name] = {"at": int(time.time()), "ok": bool(got[name]), "n": len(got[name]),
                           "why": "" if got[name] else "выдал чужое" if found else "ничего не нашёл"}
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    web = [r for row in itertools.zip_longest(*[got.get(name, []) for name, _ in asked if name != "wikipedia"])
           for r in row if r]
    return web, got.get("wikipedia", []), [name for name, _ in asked if got.get(name)]


GRACE = 1.5  # seconds


CACHE_SEC = 600
cache = {}  # query -> (time, gather's result): the same search within 10 minutes is not made again


def gather(query, n_pages=4, page_chars=3500, budget=20.0):
    """Search, then read the first pages that read well (in parallel), each page's part about the query. The search
    results' snippets stay as well, so even pages that did not open still give something."""
    key, start = re.sub(r"\s+", " ", query.lower()).strip(), time.time()
    if key in cache and start - cache[key][0] < CACHE_SEC:
        return cache[key][1]
    got = _gather(query, n_pages, page_chars, budget, start)
    if got["pages"]:
        for k in [k for k, v in cache.items() if start - v[0] >= CACHE_SEC] + list(cache)[:max(0, len(cache) - 200)]:
            cache.pop(k, None)
        cache[key] = (start, got)
    return got


def _gather(query, n_pages, page_chars, budget, start):
    results, engine = search(query, budget=min(12.0, budget))
    pages = []
    if results:
        wanted = [r for r in results if not SKIP_HOSTS.search(urlsplit(r["url"]).hostname or "")][: n_pages + 3]
        read, tried = {}, {}
        for i, r in enumerate(wanted):  # pages whose text came with the results (Exa's): nothing to open
            if len(r.get("text") or "") >= 200:
                read[i], tried[i] = (r["title"], focus(r["text"], query, page_chars)), True
        pool = concurrent.futures.ThreadPoolExecutor(max(1, min(7, len(wanted))))
        futures = {pool.submit(read_page, r["url"], page_chars, query): i for i, r in enumerate(wanted) if i not in tried}
        pending, grace = set(futures), None

        def enough():  # the first n_pages that read well, with none before them unread
            ok = 0
            for j in range(len(wanted)):
                if j not in tried:
                    return False
                ok += tried[j]
                if ok >= n_pages:
                    return True
            return False

        try:  # the pages as they come; once there are enough, the better-placed ones still reading get GRACE more
            while pending and not enough():
                if grace is None and len(read) >= n_pages:
                    grace = time.time() + GRACE
                end = start + budget if grace is None else min(start + budget, grace)
                if time.time() >= end:
                    break
                done, pending = concurrent.futures.wait(pending, timeout=end - time.time(),
                                                        return_when=concurrent.futures.FIRST_COMPLETED)
                for f in done:
                    try:
                        title, text = f.result()
                    except Exception:
                        title, text = "", ""
                    tried[futures[f]] = len(text) >= 200
                    if tried[futures[f]]:
                        read[futures[f]] = (title, text)
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
        for i in sorted(read):
            title, text = read[i]
            if len(pages) < n_pages and all(p["text"] != text for p in pages):  # (one article on two addresses: once)
                pages.append({"title": title or wanted[i]["title"], "url": wanted[i]["url"], "text": text})
    return {"engine": engine, "results": results, "pages": pages}


# ---------- straight from the source: the weather, a league's table ----------
# Questions a search page answers badly (a forecast, a standings table), answered from the source itself: Open-Meteo
# (free, no key) for the weather; Sports.ru's table page (ESPN's data when it does not open) for a league.

WEATHER_ASK = re.compile(r"погод|дожд|\bснег|осадк|\bветер\b|\bветр[аеуы]?\b|\bгроз[аыу]?\b|заморозк", re.I)
WEATHER_WORDS = re.compile(r"^(?:погод\w*|прогноз\w*|температур\w*|градус\w*|дожд\w*|снег\w*|осадк\w*|ветр\w*|ветер|"
                           r"гроз\w*|завтра|сегодня|послезавтра|сейчас|выходн\w*|недел\w*|утр\w*|вечер\w*|ночь\w*|днем|"
                           r"какая|какой|будет|будут|ли|в|во|на|по|для|и|а|что|там|за|через|дня|дней|дни|часов|часам|"
                           r"\d+)$", re.I)
WMO = {0: "ясно", 1: "в основном ясно", 2: "переменная облачность", 3: "пасмурно", 45: "туман", 48: "туман с изморозью",
       51: "слабая морось", 53: "морось", 55: "сильная морось", 56: "ледяная морось", 57: "ледяная морось",
       61: "небольшой дождь", 63: "дождь", 65: "сильный дождь", 66: "ледяной дождь", 67: "ледяной дождь",
       71: "небольшой снег", 73: "снег", 75: "сильный снег", 77: "снежная крупа", 80: "ливень", 81: "ливни",
       82: "сильные ливни", 85: "снегопад", 86: "сильный снегопад", 95: "гроза", 96: "гроза с градом", 99: "гроза с градом"}
DAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"]


def _json(url):
    _, _, raw = fetch(url, limit=600_000)
    return json.loads(raw.decode("utf-8", "replace"))


def place(words):
    """The place a question names, as Open-Meteo knows it ({"name", "admin1", "country", "latitude", …}): two words
    together («Нижний Новгород»), then each word as it is and without its ending («Казани» → «Казан» → Казань); of the
    places a name gives, the most populous. At most 8 look-ups."""
    tries = [" ".join(words[i:i + 2]) for i in range(len(words) - 1)]
    for w in words:
        tries += [w] + ([w[:-1]] if len(w) >= 5 else []) + ([w[:-2]] if len(w) >= 7 else [])
    for name in list(dict.fromkeys(tries))[:8]:
        found = _json("https://geocoding-api.open-meteo.com/v1/search?" +
                      urlencode({"name": name, "count": 5, "language": "ru"})).get("results") or []
        found = [r for r in found if r.get("name", "").lower().startswith(name.lower()[:4])]
        if found:
            return max(found, key=lambda r: r.get("population") or 0)
    return None


def weather_page(text):
    """The forecast for the place the question names: now, by hours for today and tomorrow, by days for a week.
    None: not a question about the weather; {"ask": …} when it names no place (the person is asked which)."""
    if not WEATHER_ASK.search(text):
        return None
    words = [w for w in re.findall(r"[A-Za-zА-Яа-яЁё-]+", text) if not WEATHER_WORDS.match(w) and len(w) >= 3]
    where = place(list(dict.fromkeys(words))[:6]) if words else None
    if not where:  # «погода» and no place: the person is asked; only «дождь» or «снег»: an ordinary search
        return {"ask": "Человек спрашивает о погоде, но город не назван (или такого не нашлось): спроси коротко, "
                       "для какого города."} if re.search(r"погод", text, re.I) else None
    data = _json("https://api.open-meteo.com/v1/forecast?" + urlencode({
        "latitude": where["latitude"], "longitude": where["longitude"], "timezone": "auto", "forecast_days": 7,
        "wind_speed_unit": "ms",
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m",
        "hourly": "temperature_2m,precipitation_probability,weather_code",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,"
                 "wind_speed_10m_max"}))
    cur, hourly, daily = data.get("current") or {}, data.get("hourly") or {}, data.get("daily") or {}
    name = ", ".join(x for x in (where.get("name"), where.get("admin1"), where.get("country")) if x)
    lines = [f"Погода: {name}. Местное время сейчас: {str(cur.get('time', '')).replace('T', ' ')}.",
             f"Сейчас: {cur.get('temperature_2m')}°C (ощущается как {cur.get('apparent_temperature')}°C), "
             f"{WMO.get(cur.get('weather_code'), '—')}, ветер {cur.get('wind_speed_10m')} м/с (порывы {cur.get('wind_gusts_10m')}), "
             f"влажность {cur.get('relative_humidity_2m')}%.", "", "По часам:", "Время | °C | Осадки, % | Погода"]
    now = str(cur.get("time", ""))[:13]
    for i, at in enumerate(hourly.get("time") or []):
        if at[:13] >= now and int(at[11:13]) % 3 == 0 and len(lines) < 22:
            lines.append(f"{at[8:10]}.{at[5:7]} {at[11:16]} | {hourly['temperature_2m'][i]} | "
                         f"{hourly['precipitation_probability'][i]} | {WMO.get(hourly['weather_code'][i], '—')}")
    lines += ["", "По дням:", "День | Ночью °C | Днём °C | Осадки, мм (вероятность, %) | Ветер, м/с | Погода"]
    for i, day in enumerate(daily.get("time") or []):
        wd = DAYS[time.strptime(day, "%Y-%m-%d").tm_wday]
        lines.append(f"{wd} {day[8:10]}.{day[5:7]} | {daily['temperature_2m_min'][i]} | {daily['temperature_2m_max'][i]} | "
                     f"{daily['precipitation_sum'][i]} ({daily['precipitation_probability_max'][i]}) | "
                     f"{daily['wind_speed_10m_max'][i]} | {WMO.get(daily['weather_code'][i], '—')}")
    return {"title": f"Прогноз погоды: {where.get('name')} (Open-Meteo)", "url": "https://open-meteo.com/", "text": "\n".join(lines)}


TABLE_ASK = re.compile(r"таблиц|турнирн|положени\w*\s+команд|кто\s+(?:лидир|первы|на\s+первом)|сколько\s+очков|"
                       r"какое\s+место|на\s+каком\s+месте", re.I)
LEAGUES = [  # (the words that name it, Sports.ru's table page, ESPN's league, its name)
    (r"рпл|рфпл|премьер[- ]?лиг\w*\s+росс|чемпионат\w*\s+росс|российск\w+\s+премьер", "football/tournament/rfpl", "rus.1", "РПЛ"),
    (r"\bапл\b|англи|премьер[- ]?лиг\w*\s+англ", "football/tournament/premier-league", "eng.1", "АПЛ"),
    (r"испан|ла\s*лиг|laliga", "football/tournament/la-liga", "esp.1", "Ла Лига"),
    (r"германи|бундеслиг", "football/tournament/bundesliga", "ger.1", "Бундеслига"),
    (r"итали|сери[яи]\s+а\b", "football/tournament/seria-a", "ita.1", "Серия А"),
    (r"франци|лиг[аеи]\s+1\b", "football/tournament/ligue-1", "fra.1", "Лига 1"),
    (r"\bкхл\b", "hockey/tournament/khl", None, "КХЛ"),
]


def table_page(text):
    """The standings table of the league the question asks about (the Russian one when it says just «чемпионат» or
    «футбол»), as rows «1 | Динамо | 10 | … | 22». None: not such a question, or no table could be had."""
    if not TABLE_ASK.search(text):
        return None
    league = next((lg for lg in LEAGUES if re.search(lg[0], text, re.I)), None)
    if league is None and re.search(r"чемпионат|футбол|премьер[- ]?лиг", text, re.I):
        league = LEAGUES[0]
    if league is None:
        return None
    _, path, espn, name = league
    url = f"https://www.sports.ru/{path}/table/"
    try:
        title, body = read_page(url, 100_000)
        rows = [ln for ln in body.split("\n") if ln.count(" | ") >= 3]
        if len(rows) >= 6:
            rows = [re.sub(r"\s*\|(?:\s*\|)*\s*", " | ", r).strip(" |") for r in rows]  # (empty cells: the crests)
            return {"title": title or f"Турнирная таблица: {name}", "url": url, "text": f"Турнирная таблица {name}:\n" + "\n".join(rows[:45])}
    except Exception:
        pass
    if not espn:
        return None
    data = _json(f"https://site.api.espn.com/apis/v2/sports/soccer/{espn}/standings")
    entries = ((data.get("children") or [{}])[0].get("standings") or {}).get("entries") or []
    stat = lambda e, k: next((s.get("displayValue") for s in e.get("stats", []) if s.get("abbreviation") == k), "")
    rows = ["# | Команда | И | В | Н | П | Мячи | Разница | Очки"]
    for i, e in enumerate(entries):  # (in the table's order)
        rows.append(f"{i + 1} | {e['team']['displayName']} | {stat(e, 'GP')} | {stat(e, 'W')} | {stat(e, 'D')} | {stat(e, 'L')} | "
                    f"{stat(e, 'F')}:{stat(e, 'A')} | {stat(e, 'GD')} | {stat(e, 'P')}")
    if len(rows) < 6:
        return None
    return {"title": f"Турнирная таблица: {name} (ESPN)", "url": f"https://www.espn.com/soccer/standings/_/league/{espn}",
            "text": f"Турнирная таблица {name} (названия команд по-английски — переведи):\n" + "\n".join(rows)}


def direct(text):
    """The weather or a league's table straight from its source (None: the question is about something else)."""
    for fn in (weather_page, table_page):
        try:
            got = fn(text)
        except Exception:
            got = None
        if got:
            return got
    return None


if __name__ == "__main__":  # python3 websearch.py "вопрос": what the helper would read
    import sys
    got = gather(" ".join(sys.argv[1:]) or "курс доллара ЦБ сегодня")
    print("engine:", got["engine"])
    for r in got["results"]:
        print("-", r["title"], "|", r["url"])
    for p in got["pages"]:
        print("\n==", p["title"], p["url"], len(p["text"]), "chars\n", p["text"][:300])
