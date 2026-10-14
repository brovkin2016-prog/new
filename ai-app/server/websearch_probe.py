"""What the data sources give from a datacenter (CI only, temporary)."""
import json
import re
from urllib.parse import urlencode

import websearch as ws


def get(url):
    try:
        final, ctype, body = ws.fetch(url)
        return final, ws.decode(body, ctype)
    except Exception as e:  # noqa: BLE001
        return None, repr(e)[:200]


for name in ("Казань", "Казани", "Санкт-Петербург", "Нижний Новгород", "Сочи"):
    f, body = get("https://geocoding-api.open-meteo.com/v1/search?" + urlencode({"name": name, "count": 3, "language": "ru"}))
    try:
        res = json.loads(body).get("results") or []
        print("geo", name, [(r["name"], r.get("admin1"), r.get("country_code"), r.get("population")) for r in res])
    except Exception:  # noqa: BLE001
        print("geo", name, f, body[:200])
f, body = get("https://api.open-meteo.com/v1/forecast?latitude=55.79&longitude=49.12&timezone=auto&forecast_days=3"
              "&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum")
print("forecast", f is not None, body[:500])
for url in ("https://site.api.espn.com/apis/v2/sports/soccer/rus.1/standings",
            "https://www.sports.ru/football/tournament/rfpl/table/",
            "https://www.championat.com/football/_russiapl.html",
            "https://www.sport-express.ru/football/rus/premier/table/",
            "https://soccer365.ru/competitions/608/"):
    f, body = get(url)
    print("\n####", url, f, len(body))
    if f and url.endswith("standings"):
        try:
            js = json.loads(body)
            print(js.get("name"), js.get("abbreviation"), str(js)[:300])
            ent = js["children"][0]["standings"]["entries"]
            for e in ent[:4]:
                print("  ", e["team"]["displayName"], [(s.get("abbreviation"), s.get("displayValue")) for s in e["stats"]][:10])
        except Exception as e:  # noqa: BLE001
            print("espn parse:", e, body[:300])
    elif f:
        title, text = ws.page_text(body)
        rows = [ln for ln in text.split("\n") if ln.count(" | ") >= 3]
        print(title, "| rows:", len(rows))
        print("\n".join(rows[:8]))
for page in ("Чемпионат России по футболу 2026/2027",):
    f, body = get("https://ru.wikipedia.org/w/api.php?" + urlencode({"action": "parse", "page": page, "prop": "text", "format": "json", "redirects": 1}))
    try:
        html = json.loads(body)["parse"]["text"]["*"]
        title, text = ws.page_text(html)
        rows = [ln for ln in text.split("\n") if ln.count(" | ") >= 5]
        print("\n#### wiki", page, len(html), "rows:", len(rows))
        print("\n".join(rows[:22]))
    except Exception as e:  # noqa: BLE001
        print("wiki", e, body[:200])
