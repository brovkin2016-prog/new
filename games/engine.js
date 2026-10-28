/* Winger Games — the engine every game runs on.
   One 384×216 pixel screen (16:9) scaled by a whole number of device pixels, a fixed 60 Hz game loop, input from touch
   (cross pad, buttons, swipes, taps), keyboard and gamepad, a chiptune synth, a pixel font with Cyrillic, sprite,
   particle and parallax helpers, and the shared screens: start / level picker, pause, results with the family's
   leaderboard. A game is one file that calls WG.game({...}); the API is described in ENGINE.md next to this file.
   Plain JS, no build step, nothing loaded from outside. */
"use strict";
(function () {
  const WG = window.WG = window.WG || {};
  const W = 384, H = 216, STEP = 1 / 60;
  WG.W = W; WG.H = H; WG.STEP = STEP;
  WG.defs = WG.defs || {};
  WG.registry = WG.registry || [];

  // ---------- small things ----------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  WG.util = { clamp, lerp, ease };
  // a small fast seeded random: WG.rng(42)() → 0…1
  WG.rng = function (seed) {
    let s = (seed >>> 0) || 0x9E3779B9;
    return function () {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  };
  WG.canvas = function (w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0);
    c.getContext("2d").imageSmoothingEnabled = false;
    return c;
  };
  WG.store = {
    get(k, d) { try { const v = localStorage.getItem("wg." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("wg." + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  // the helper's theme (Светлая / Тёмная / Как в телефоне) is kept under its "theme" key on the same origin
  WG.applyTheme = function () {
    let t = "system";
    try { t = JSON.parse(localStorage.getItem("theme") || '"system"'); } catch (e) { /* default */ }
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
  };
  WG.applyTheme();

  // ---------- the server: the helper's sign-in (its token, kept by the helper under "token") ----------
  class ApiError extends Error {
    constructor(kind, text, status) { super(text); this.kind = kind; this.status = status || 0; }
  }
  WG.ApiError = ApiError;
  function token() {
    try { const v = localStorage.getItem("token"); return v ? JSON.parse(v) || "" : ""; } catch (e) { return ""; }
  }
  WG.signedIn = () => !!token();
  let nseq = 0;
  const npending = {};
  function nativeSend(path, headers, body) {
    // inside the helper's Android app the network goes through its bridge, as the helper's own pages do
    return new Promise((resolve, reject) => {
      const id = "g" + (++nseq);
      const parts = [];
      let status = 0;
      npending[id] = {
        head: (s) => { status = s; },
        data: (b) => parts.push(b),
        end: () => resolve({ status, text: new TextDecoder().decode(concat(parts)) }),
        fail: () => reject(new ApiError("net", "Нет связи с сервером")),
      };
      window.AIBridge.request(id, path, JSON.stringify(headers), body === null ? "" : body);
    });
  }
  function concat(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  if (!window.__aiNet) {
    window.__aiNet = function (id, type, a) {
      const p = npending[id];
      if (!p) return;
      if (type === "head") p.head(+a);
      else if (type === "data") { const bin = atob(a); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); p.data(u); }
      else if (type === "end") { delete npending[id]; p.end(); }
      else if (type === "fail") { delete npending[id]; p.fail(); }
    };
  }
  // WG.api("/api/games/me") is a GET; WG.api(path, {…}) a POST. Resolves with the answer, or throws an ApiError whose
  // kind is "login" (not signed in), "net" (no connection) or "server" (the server said no; .message is its text).
  WG.api = async function (path, body) {
    const headers = { "Content-Type": "application/json" };
    const t = token();
    if (t) headers.Authorization = "Bearer " + t;
    const payload = body === undefined ? null : JSON.stringify(body);
    let res;
    try {
      if (window.AIBridge && window.AIBridge.request) res = await nativeSend(path, headers, payload);
      else {
        const r = await fetch(path, { method: payload === null ? "GET" : "POST", headers, body: payload === null ? undefined : payload, credentials: "same-origin", cache: "no-store" });
        res = { status: r.status, text: await r.text() };
      }
    } catch (e) {
      throw e instanceof ApiError ? e : new ApiError("net", "Нет связи с сервером");
    }
    let js = {};
    try { js = JSON.parse(res.text || "{}"); } catch (e) { /* not json */ }
    if (res.status === 401) throw new ApiError("login", "Нужно войти", 401);
    if (res.status === 403) throw new ApiError("off", "Игры для этого входа выключены", 403);
    if (res.status !== 200 || js.t === "error") {
      throw new ApiError("server", js.text || js.error || (res.status >= 500 ? "Сервер сейчас не отвечает — попробуйте через минуту." : "Что-то пошло не так — попробуйте ещё раз."), res.status);
    }
    return js;
  };
  // who is playing and their bests: {user:{id,name}, best:{game:{level:score}}}; loaded once, kept fresh after games
  WG.me = null;
  WG.loadMe = async function () {
    const r = await WG.api("/api/games/me");
    WG.me = { user: r.user || { id: "", name: "" }, best: r.best || {}, bestMs: r.best_ms || {} };
    return WG.me;
  };
  // sign-in as the helper does it: the line from the owner's message «домен/код» → POST /api/login → the token kept
  // under the helper's own "token" key, so the helper and the games share one sign-in
  WG.parseLogin = function (text) {
    const s = String(text || "").trim();
    const m = s.match(/([a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?)\s*\/\s*([A-Za-z0-9]{4}-?[A-Za-z0-9]{4})/i);
    if (m) return { host: m[1].toLowerCase(), code: m[2] };
    const c = s.match(/\b([A-Za-z0-9]{4}-?[A-Za-z0-9]{4})\b/);
    return c ? { host: "", code: c[1] } : null;
  };
  WG.login = async function (text) {
    const p = WG.parseLogin(text);
    if (!p) throw new ApiError("code", "Не вижу кода. Скопируйте сообщение от владельца помощника целиком и нажмите «Вставить скопированное».");
    const N = window.AIBridge;
    if (N && N.setHost) {
      const host = p.host || (N.getHost && N.getHost());
      if (!host) throw new ApiError("code", "Нужна вся строка из сообщения, а не только код.");
      N.setHost(host);
    }
    const r = await WG.api("/api/login", { code: p.code, device: N && N.device ? N.device() : navigator.userAgent.slice(0, 60) });
    try { localStorage.setItem("token", JSON.stringify(r.token || "")); } catch (e) { /* private mode */ }
    WG.setGuest(false);
    return r;
  };
  // «Играть без рейтинга»: no sign-in, nothing is sent to the server (kept for this visit only)
  WG.guest = (() => { try { return sessionStorage.getItem("wg.guest") === "1"; } catch (e) { return false; } })();
  WG.setGuest = function (on) {
    WG.guest = !!on;
    try { if (on) sessionStorage.setItem("wg.guest", "1"); else sessionStorage.removeItem("wg.guest"); } catch (e) { /* private mode */ }
  };
  WG.bestOf = function (game, level) {
    const b = WG.me && WG.me.best && WG.me.best[game];
    return b && typeof b[level] === "number" ? b[level] : null;
  };

  // levels against the computer, and the one level of single-player games
  WG.LEVELS = {
    easy: { name: "Лёгкий", hint: "Компьютер часто ошибается", bars: 1 },
    normal: { name: "Средний", hint: "Играет честно, без спешки", bars: 2 },
    hard: { name: "Сложный", hint: "Почти не ошибается", bars: 3 },
    master: { name: "Мастер", hint: "Играет в полную силу", bars: 4 },
    adaptive: { name: "Подстроиться", hint: "Становится сильнее, когда ты выигрываешь", bars: 0 },
  };
  WG.levelName = (l) => (WG.LEVELS[l] ? WG.LEVELS[l].name : l);
  // «Подстроиться»: a skill 0…1 per game kept on this device; games read api.skill and report wins through api.end({won})
  WG.adaptive = {
    get(game) { return clamp(WG.store.get("skill." + game, 0.35), 0, 1); },
    report(game, won) { WG.store.set("skill." + game, clamp(WG.adaptive.get(game) + (won ? 0.08 : -0.06), 0, 1)); },
  };
  // ---------- progress through stages: up to 3 stars a stage; the next opens once the one before is passed ----------
  // Kept on the server (GET/POST /api/games/progress) and on this device per player; whichever knows more wins, and
  // stages this device passed while the server could not take them are sent up on the next get().
  WG.progress = (() => {
    const mem = {};
    const uid = () => (WG.guest || !WG.signedIn() ? "guest" : (WG.me && WG.me.user && WG.me.user.id) || "me");
    const key = (game) => "prog." + uid() + "." + game;
    const maxKey = (st) => Object.keys(st).reduce((m, k) => (st[k] > 0 ? Math.max(m, +k) : m), 0);
    function norm(p) {
      const stages = {};
      for (const [k, v] of Object.entries((p && p.stages) || {})) {
        const n = parseInt(k, 10), st = clamp(Math.round(+v || 0), 0, 3);
        if (n > 0 && st > 0) stages[n] = st;
      }
      return { stages, furthest: Math.max(maxKey(stages), (p && +p.furthest) || 0) };
    }
    function merge(a, b) {
      const st = Object.assign({}, a.stages);
      for (const [k, v] of Object.entries(b.stages)) st[k] = Math.max(st[k] || 0, v);
      return { stages: st, furthest: Math.max(a.furthest || 0, b.furthest || 0, maxKey(st)) };
    }
    function local(game) {
      const k = key(game);
      return mem[k] || (mem[k] = norm(WG.store.get(k, null)));
    }
    function keep(game, p) { mem[key(game)] = p; WG.store.set(key(game), { stages: p.stages, furthest: p.furthest }); }
    const online = () => WG.signedIn() && !WG.guest;
    async function get(game) {
      let p = local(game);
      if (!online()) return p;
      try {
        const srv = norm(await WG.api("/api/games/progress?game=" + encodeURIComponent(game)));
        const behind = Object.entries(p.stages).filter(([k, v]) => (srv.stages[k] || 0) < v).sort((a, b) => a[0] - b[0]);
        p = merge(p, srv);
        keep(game, p);
        // the server takes a stage only once the one before is passed: send them up in order, one after another
        if (behind.length) (async () => {
          for (const [k, v] of behind) {
            try { await WG.api("/api/games/progress", { game, stage: +k, stars: v }); } catch (e) { break; }
          }
        })();
      } catch (e) {
        if (e.kind === "login" || e.kind === "off") throw e; // otherwise: the server keeps no progress yet — this device's copy
      }
      return p;
    }
    // save(game, stage, stars) → {progress, before (stars before), improved}
    async function save(game, stage, stars) {
      stars = clamp(Math.round(stars || 0), 0, 3);
      let p = local(game);
      const before = p.stages[stage] || 0;
      if (stars > before) { p = merge(p, { stages: { [stage]: stars }, furthest: stage }); keep(game, p); }
      if (online() && stars > 0) {
        try { p = merge(p, norm(await WG.api("/api/games/progress", { game, stage, stars }))); keep(game, p); } catch (e) { /* sent again next time */ }
      }
      return { progress: p, before, improved: stars > before };
    }
    const unlocked = (p, n) => n <= 1 || (p.stages[n - 1] || 0) > 0;
    const totalStars = (p) => Object.values(p.stages).reduce((a, b) => a + b, 0);
    // the stage to offer first: the first one not yet passed (or the last)
    const next = (p, count) => { for (let n = 1; n <= count; n++) if (!(p.stages[n] > 0)) return n; return count; };
    return { get, save, local, unlocked, totalStars, next };
  })();

  WG.fmtTime = function (ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };
  WG.fmtNum = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  WG.fmtDate = function (at) {
    if (at === undefined || at === null || at === "") return "";
    let d = typeof at === "number" ? new Date(at < 1e12 ? at * 1000 : at) : new Date(at);
    if (isNaN(d)) return "";
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return "сегодня";
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "вчера";
    return d.getDate() + " " + MONTHS[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : "");
  };
  WG.place = (n) => n + "-е место";

  // ---------- the pixel font: 5×7 capitals, 5-pixel lowercase, Cyrillic + Latin, digits, punctuation ----------
  // Each glyph: rows above the baseline joined by "/", then "|" and the rows below it. "#" is ink.
  const RAW = {
    A: ".###./#...#/#...#/#####/#...#/#...#/#...#", "Б": "#####/#..../#..../####./#...#/#...#/####.",
    B: "####./#...#/#...#/####./#...#/#...#/####.", "Г": "#####/#..../#..../#..../#..../#..../#....",
    "Д": ".###./.#.#./.#.#./.#.#./.#.#./.#.#./#####|#...#", E: "#####/#..../#..../####./#..../#..../#####",
    "Ё": ".#.#./...../#####/#..../#..../####./#..../#..../#####", "Ж": "#..#..#/#..#..#/.#.#.#./..###../.#.#.#./#..#..#/#..#..#",
    "З": ".###./#...#/....#/..##./....#/#...#/.###.", "И": "#...#/#...#/#..##/#.#.#/##..#/#...#/#...#",
    "Й": ".###./...../#...#/#...#/#..##/#.#.#/##..#/#...#/#...#", K: "#...#/#..#./#.#../##.../#.#../#..#./#...#",
    "Л": "..###/.#..#/.#..#/.#..#/.#..#/.#..#/#...#", M: "#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#",
    H: "#...#/#...#/#...#/#####/#...#/#...#/#...#", O: ".###./#...#/#...#/#...#/#...#/#...#/.###.",
    "П": "#####/#...#/#...#/#...#/#...#/#...#/#...#", P: "####./#...#/#...#/####./#..../#..../#....",
    C: ".###./#...#/#..../#..../#..../#...#/.###.", T: "#####/..#../..#../..#../..#../..#../..#..",
    "У": "#...#/#...#/#...#/.####/....#/#...#/.###.", "Ф": "..#../.###./#.#.#/#.#.#/#.#.#/.###./..#..",
    X: "#...#/#...#/.#.#./..#../.#.#./#...#/#...#", "Ц": "#..#./#..#./#..#./#..#./#..#./#..#./#####|....#",
    "Ч": "#...#/#...#/#...#/.####/....#/....#/....#", "Ш": "#.#.#/#.#.#/#.#.#/#.#.#/#.#.#/#.#.#/#####",
    "Щ": "#.#.#./#.#.#./#.#.#./#.#.#./#.#.#./#.#.#./######|.....#", "Ъ": "##.../.#.../.#.../.###./.#..#/.#..#/.###.",
    "Ы": "#....#/#....#/#....#/###..#/#..#.#/#..#.#/###..#", "Ь": "#..../#..../#..../####./#...#/#...#/####.",
    "Э": ".###./#...#/....#/..###/....#/#...#/.###.", "Ю": "#..##./#.#..#/#.#..#/###..#/#.#..#/#.#..#/#..##.",
    "Я": ".####/#...#/#...#/.####/..#.#/.#..#/#...#",
    D: "###../#..#./#...#/#...#/#...#/#..#./###..", F: "#####/#..../#..../####./#..../#..../#....",
    G: ".###./#...#/#..../#.###/#...#/#...#/.####", I: "###/.#./.#./.#./.#./.#./###",
    J: "..###/...#./...#./...#./...#./#..#./.##..", L: "#..../#..../#..../#..../#..../#..../#####",
    N: "#...#/#...#/##..#/#.#.#/#..##/#...#/#...#", Q: ".###./#...#/#...#/#...#/#.#.#/#..#./.##.#",
    R: "####./#...#/#...#/####./#.#../#..#./#...#", S: ".####/#..../#..../.###./....#/....#/####.",
    U: "#...#/#...#/#...#/#...#/#...#/#...#/.###.", V: "#...#/#...#/#...#/#...#/#...#/.#.#./..#..",
    W: "#...#/#...#/#...#/#.#.#/#.#.#/#.#.#/.#.#.", Y: "#...#/#...#/.#.#./..#../..#../..#../..#..",
    Z: "#####/....#/...#./..#../.#.../#..../#####",
    a: ".###./....#/.####/#...#/.####", "б": "..###/.#.../#..../####./#...#/#...#/.###.",
    "в": "####./#...#/####./#...#/####.", "г": "#####/#..../#..../#..../#....",
    "д": ".###./.#.#./.#.#./.#.#./#####|#...#", e: ".###./#...#/#####/#..../.###.",
    "ё": ".#.#./...../.###./#...#/#####/#..../.###.", "ж": "#.#.#/#.#.#/.###./#.#.#/#.#.#",
    "з": "####./....#/.###./....#/####.", "и": "#...#/#..##/#.#.#/##..#/#...#",
    "й": ".###./...../#...#/#..##/#.#.#/##..#/#...#", "к": "#..#./#.#../##.../#.#../#..#.",
    "л": "..###/.#..#/.#..#/.#..#/#...#", "м": "#...#/##.##/#.#.#/#...#/#...#",
    "н": "#...#/#...#/#####/#...#/#...#", o: ".###./#...#/#...#/#...#/.###.",
    "п": "#####/#...#/#...#/#...#/#...#", p: "####./#...#/#...#/#...#/####.|#..../#....",
    c: ".###./#...#/#..../#...#/.###.", "т": "#####/..#../..#../..#../..#..",
    y: "#...#/#...#/#...#/#...#/.####|....#/.###.", "ф": "..#../.###./#.#.#/#.#.#/#.#.#/.###.|..#..",
    x: "#...#/.#.#./..#../.#.#./#...#", "ц": "#..#./#..#./#..#./#..#./#####|....#",
    "ч": "#...#/#...#/.####/....#/....#", "ш": "#.#.#/#.#.#/#.#.#/#.#.#/#####",
    "щ": "#.#.#./#.#.#./#.#.#./#.#.#./######|.....#", "ъ": "##.../.#.../.###./.#..#/.###.",
    "ы": "#....#/#....#/###..#/#..#.#/###..#", "ь": "#..../#..../####./#...#/####.",
    "э": ".###./#...#/..###/#...#/.###.", "ю": "#..##./#.#..#/###..#/#.#..#/#..##.",
    "я": ".####/#...#/.####/.#..#/#...#",
    b: "#..../#..../####./#...#/#...#/#...#/####.", d: "....#/....#/.####/#...#/#...#/#...#/.####",
    f: "..##/.#../####/.#../.#../.#../.#..", g: ".####/#...#/#...#/#...#/.####|....#/.###.",
    h: "#..../#..../####./#...#/#...#/#...#/#...#", i: ".#./.../##./.#./.#./.#./###",
    j: "..#/.../.##/..#/..#/..#/..#|#.#/.#.", k: "#..../#..../#..#./#.#../##.../#.#../#..#.",
    l: "##./.#./.#./.#./.#./.#./###", m: "##.#./#.#.#/#.#.#/#.#.#/#.#.#",
    n: "####./#...#/#...#/#...#/#...#", q: ".####/#...#/#...#/#...#/.####|....#/....#",
    r: "#.##./##..#/#..../#..../#....", s: ".####/#..../.###./....#/####.",
    t: ".#../.#../####/.#../.#../.#../..##", u: "#...#/#...#/#...#/#...#/.####",
    v: "#...#/#...#/#...#/.#.#./..#..", w: "#...#/#...#/#.#.#/#.#.#/.#.#.", z: "#####/...#./..#../.#.../#####",
    0: ".###./#...#/#..##/#.#.#/##..#/#...#/.###.", 1: "..#../.##../..#../..#../..#../..#../.###.",
    2: ".###./#...#/....#/...#./..#../.#.../#####", 3: "#####/...#./..#../...#./....#/#...#/.###.",
    4: "...#./..##./.#.#./#..#./#####/...#./...#.", 5: "#####/#..../####./....#/....#/#...#/.###.",
    6: "..##./.#.../#..../####./#...#/#...#/.###.", 7: "#####/....#/...#./..#../.#.../.#.../.#...",
    8: ".###./#...#/#...#/.###./#...#/#...#/.###.", 9: ".###./#...#/#...#/.####/....#/...#./.##..",
    ".": "#", ",": ".#|#.", ":": "#/./././#", ";": ".#/../../.#|#.", "!": "#/#/#/#/#/./#",
    "?": ".###./#...#/....#/...#./..#../...../..#..", "-": "###/.../.../...", "+": "..#../..#../#####/..#../..#../.....",
    "=": "#####/...../#####/...../.....", "(": ".#/#./#./#./#./#./.#", ")": "#./.#/.#/.#/.#/.#/#.",
    "/": "....#/...#./...#./..#../.#.../.#.../#....", "'": "#/#/././././.", '"': "#.#/#.#/.../.../.../.../...",
    "«": "..../..../.#.#/#.#./.#.#/..../....", "»": "..../..../#.#./.#.#/#.#./..../....",
    "%": "##..#/##.#./...#./..#../.#.../.#.##/#..##", "×": "...../#...#/.#.#./..#../.#.#./#...#/.....",
    "—": "#####/...../...../.....", "–": "####/..../..../....", "…": "#.#.#",
    "*": "...../#.#.#/.###./#####/.###./#.#.#/.....", "<": "...#/..#./.#../#.../.#../..#./...#",
    ">": "#.../.#../..#./...#/..#./.#../#...", "°": ".#./#.#/.#./.../.../.../...", "·": "#/././.",
    "↑": "..#../.###./#.#.#/..#../..#../..#../..#..", "↓": "..#../..#../..#../..#../#.#.#/.###./..#..",
    "←": "...../..#../.#.../#####/.#.../..#../.....", "→": "...../..#../...#./#####/...#./..#../.....",
    "♥": "...../.#.#./#####/#####/.###./..#../.....", "★": "..#../..#../#####/.###./.#.#./#...#/.....",
  };
  const ALIAS = { "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X",
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "№": "N", "−": "-", " ": " ", " ": " ",
    "„": '"', "“": '"', "”": '"', "’": "'", "‘": "'" };
  const GL = {};
  function glyph(ch) {
    if (GL[ch] !== undefined) return GL[ch];
    const raw = RAW[ALIAS[ch] || ch];
    if (raw === undefined) return (GL[ch] = null);
    const [up, down] = raw.split("|");
    const above = up.split("/"), below = down ? down.split("/") : [];
    const rows = above.concat(below);
    const w = Math.max(...rows.map((r) => r.length));
    return (GL[ch] = { w, rows, top: 7 - above.length, h: rows.length });
  }
  const glyphCache = new Map();
  function glyphCanvas(ch, color) {
    const key = ch + "\u0000" + color;
    let c = glyphCache.get(key);
    if (c) return c;
    const gl = glyph(ch);
    c = WG.canvas(gl.w, gl.h);
    const g = c.getContext("2d");
    const cols = Array.isArray(color) ? color : null;
    for (let y = 0; y < gl.h; y++) {
      // a list of colours paints the glyph in horizontal bands, counted from the capital line
      g.fillStyle = cols ? cols[clamp(y + gl.top, 0, cols.length - 1)] : color;
      const r = gl.rows[y];
      for (let x = 0; x < r.length; x++) if (r[x] === "#") g.fillRect(x, y, 1, 1);
    }
    glyphCache.set(key, c);
    return c;
  }
  // width in screen pixels of a line of pixel text
  const SPACES = /[\u00A0\u2007\u202F]/g;  // WG.fmtNum's thin space between thousands: the pixel font's own space
  WG.textWidth = function (s, scale, spacing) {
    const sc = scale || 1, sp = spacing === undefined ? 1 : spacing;
    let w = 0, n = 0;
    for (const ch of String(s).replace(SPACES, " ")) {
      const gl = ch === " " ? null : glyph(ch) || glyph("?");
      w += (gl ? gl.w : 3) + sp; n++;
    }
    return n ? (w - sp) * sc : 0;
  };
  function textRun(g, s, x, y, color, sc, sp) {
    for (const ch of s) {
      if (ch === " ") { x += (3 + sp) * sc; continue; }
      const c = glyph(ch) ? ch : "?";
      const gl = glyph(c);
      g.drawImage(glyphCanvas(c, color), x, y + gl.top * sc, gl.w * sc, gl.h * sc);
      x += (gl.w + sp) * sc;
    }
  }
  // WG.text(g, "ОЧКИ 120", x, y, {color, scale, align:"left|center|right", shadow, outline, spacing, upper})
  // y is the top of the capitals (7 pixels × scale tall); color may be a list for banded lettering. Returns the width.
  WG.text = function (g, s, x, y, o) {
    o = o || {};
    s = String(s).replace(SPACES, " ");
    if (o.upper) s = s.toUpperCase();
    const sc = o.scale || 1, sp = o.spacing === undefined ? 1 : o.spacing;
    const w = WG.textWidth(s, sc, sp);
    if (o.align === "center") x -= Math.floor(w / 2);
    else if (o.align === "right") x -= w;
    x = Math.round(x); y = Math.round(y);
    if (o.outline) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) textRun(g, s, x + dx * sc, y + dy * sc, o.outline, sc, sp);
    if (o.shadow) textRun(g, s, x + sc, y + sc, o.shadow, sc, sp);
    textRun(g, s, x, y, o.color || "#EAF0FA", sc, sp);
    return w;
  };
  // pixel lettering as its own small canvas (for HTML: show it with image-rendering: pixelated at a whole scale)
  WG.textCanvas = function (s, o) {
    o = Object.assign({}, o, { align: "left", scale: 1 });
    const pad = o.outline ? 1 : 0;
    const c = WG.canvas(WG.textWidth(s, 1, o.spacing) + pad * 2 + (o.shadow ? 1 : 0), 11 + pad * 2 + (o.shadow ? 1 : 0));
    WG.text(c.getContext("2d"), s, pad, pad + 2, o);
    return c;
  };

  // ---------- sprites: palette-indexed strings → canvases ----------
  // WG.sprite(["..aa..", ".abba."], {a:"#05291C", b:"#34D399"}, {outline:"#000"}) — "." and " " are clear;
  // rows may also be one string joined by "/". The outline option rings the shape with 1 px of that colour.
  WG.sprite = function (rows, pal, o) {
    o = o || {};
    if (typeof rows === "string") rows = rows.split("/");
    const h = rows.length, w = Math.max(...rows.map((r) => r.length));
    const p = o.outline ? 1 : 0;
    const c = WG.canvas(w + p * 2, h + p * 2), g = c.getContext("2d");
    const solid = (x, y) => x >= 0 && y >= 0 && y < h && x < rows[y].length && !!pal[rows[y][x]];
    if (o.outline) {
      g.fillStyle = o.outline;
      for (let y = -1; y <= h; y++) for (let x = -1; x <= w; x++) {
        if (solid(x, y)) continue;
        if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1) || (o.corners && (solid(x - 1, y - 1) || solid(x + 1, y - 1) || solid(x - 1, y + 1) || solid(x + 1, y + 1)))) g.fillRect(x + p, y + p, 1, 1);
      }
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < rows[y].length; x++) {
      const col = pal[rows[y][x]];
      if (col) { g.fillStyle = col; g.fillRect(x + p, y + p, 1, 1); }
    }
    return c;
  };
  WG.frames = (list, pal, o) => list.map((r) => WG.sprite(r, pal, o));
  WG.flipX = function (src) {
    const c = WG.canvas(src.width, src.height), g = c.getContext("2d");
    g.translate(src.width, 0); g.scale(-1, 1); g.drawImage(src, 0, 0);
    return c;
  };
  WG.flipY = function (src) {
    const c = WG.canvas(src.width, src.height), g = c.getContext("2d");
    g.translate(0, src.height); g.scale(1, -1); g.drawImage(src, 0, 0);
    return c;
  };
  // a quarter turn clockwise, n times (exact pixels)
  WG.rotate = function (src, n) {
    n = ((n % 4) + 4) % 4;
    if (!n) return src;
    const sw = src.width, sh = src.height, odd = n % 2 === 1;
    const c = WG.canvas(odd ? sh : sw, odd ? sw : sh), g = c.getContext("2d");
    g.translate(c.width / 2, c.height / 2); g.rotate(n * Math.PI / 2); g.drawImage(src, -sw / 2, -sh / 2);
    return c;
  };
  // the frame of an animation at time t (seconds): WG.anim(frames, 8, t)
  WG.anim = (frames, fps, t, loop) => frames[loop === false ? Math.min(frames.length - 1, Math.floor(t * fps)) : Math.floor(t * fps) % frames.length];
  // draw a canvas centred on (x, y), optionally flipped/turned beforehand
  WG.draw = (g, img, x, y) => g.drawImage(img, Math.round(x - img.width / 2), Math.round(y - img.height / 2));

  // ---------- the shared palette (Северное сияние at night, in 16-bit steps) ----------
  WG.PAL = {
    void: "#04070F", night: "#0A0F1E", deep: "#0E1730", card: "#121B31", well: "#1D2944", line: "#26324F",
    slate: "#3B4766", field: "#5F6F93", mist: "#A9B6CD", ink: "#EAF0FA", white: "#FFFFFF",
    g0: "#05291C", g1: "#0B4A33", g2: "#127A52", g3: "#1FA874", g4: "#34D399", g5: "#8EF0C6",
    c0: "#0B3B4A", c1: "#0B6E8A", c2: "#22B8CF", c3: "#7FE6F4", c4: "#D2FAFF",
    v0: "#21194A", v1: "#4B3BA8", v2: "#8B7CF6", v3: "#C4BBFF",
    a0: "#2A1E00", a1: "#6B4A0A", a2: "#C98A1B", a3: "#FFD27A", a4: "#FFF0C2",
    r0: "#3D0C17", r1: "#8E1F35", r2: "#D93644", r3: "#FF6B7A", r4: "#FFC2C9",
    w0: "#24170F", w1: "#4E3424", w2: "#7A5236", w3: "#A8774D",
    s0: "#1B2133", s1: "#2C3550", s2: "#46516F", s3: "#6B7694", s4: "#9AA5C0",
  };

  // ---------- art kit: pixel shapes, the aurora sky, ridges, pines ----------
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  const discCache = new Map();
  function discCanvas(r, color) {
    const key = r + "|" + color;
    let c = discCache.get(key);
    if (c) return c;
    const d = Math.max(1, Math.round(r * 2));
    c = WG.canvas(d, d);
    const g = c.getContext("2d");
    g.fillStyle = color;
    const rr = (d / 2) * (d / 2) + d * 0.15;
    for (let y = 0; y < d; y++) for (let x = 0; x < d; x++) {
      const dx = x + 0.5 - d / 2, dy = y + 0.5 - d / 2;
      if (dx * dx + dy * dy <= rr) g.fillRect(x, y, 1, 1);
    }
    discCache.set(key, c);
    return c;
  }
  const art = WG.art = {};
  // a filled pixel circle of radius r centred on (cx, cy)
  art.disc = function (g, cx, cy, r, color) {
    const c = discCanvas(r, color);
    g.drawImage(c, Math.round(cx - c.width / 2), Math.round(cy - c.height / 2));
  };
  // a filled pixel ellipse
  art.ellipse = function (g, cx, cy, rx, ry, color) {
    g.fillStyle = color;
    const y0 = Math.round(cy - ry), y1 = Math.round(cy + ry);
    for (let y = y0; y < y1; y++) {
      const t = (y + 0.5 - cy) / ry;
      const hw = rx * Math.sqrt(Math.max(0, 1 - t * t));
      const x0 = Math.round(cx - hw), x1 = Math.round(cx + hw);
      if (x1 > x0) g.fillRect(x0, y, x1 - x0, 1);
    }
  };
  // ordered-dither one colour over another: level 0…1 of colour b
  art.dither = function (g, x, y, w, h, a, b, level) {
    if (a) { g.fillStyle = a; g.fillRect(x, y, w, h); }
    g.fillStyle = b;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (BAYER[((y + j) & 3) * 4 + ((x + i) & 3)] < level) g.fillRect(x + i, y + j, 1, 1);
  };
  // vertical bands from colour to colour with a dithered seam between each (the 16-bit gradient)
  art.bands = function (g, x, y, w, h, colors) {
    const n = colors.length;
    for (let j = 0; j < h; j++) {
      const f = (j / Math.max(1, h - 1)) * (n - 1);
      const i = Math.min(n - 2, Math.floor(f)), t = f - i;
      g.fillStyle = colors[i]; g.fillRect(x, y + j, w, 1);
      if (t > 0.02) {
        g.fillStyle = colors[i + 1];
        for (let k = 0; k < w; k++) if (BAYER[((y + j) & 3) * 4 + ((x + k) & 3)] < t) g.fillRect(x + k, y + j, 1, 1);
      }
    }
  };
  // a tube along a polyline of points [{x,y}…], stamped every pixel: the body of snakes, worms, ropes, tails.
  // o: {r, outline, fill, shade, light, taper (px at the far end), pattern(d, total) → colour|null, bulge(d) → extra r,
  //     marks: {every, start, end(total), draw(g, x, y, i)}, d0 / total: where this piece starts on a longer body that
  //     is drawn in pieces (through portals) and that body's whole length}
  art.tube = function (g, pts, o) {
    if (pts.length < 2) return;
    const d0 = o.d0 || 0;
    let total = 0;
    const seg = [];
    for (let i = 1; i < pts.length; i++) { const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); seg.push(len); total += len; }
    const T = o.total || d0 + total;
    const samples = [];
    let acc = d0;
    for (let i = 0; i < seg.length; i++) {
      const a = pts[i], b = pts[i + 1], len = seg[i];
      const n = Math.max(1, Math.ceil(len));
      for (let k = 0; k < n; k++) { const t = k / n; samples.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, d: acc + len * t }); }
      acc += len;
    }
    const last = pts[pts.length - 1];
    samples.push({ x: last.x, y: last.y, d: acc });
    const R = o.r || 4, taper = o.taper || 0;
    const radius = (d) => {
      let r = R;
      if (taper && d > T - taper) r = Math.max(1.5, R * ((T - d) / taper) * 0.75 + R * 0.25);
      if (o.bulge) r += o.bulge(d);
      return Math.round(r * 2) / 2;
    };
    // tail first, so the parts nearer the head lie on top
    if (o.outline) for (let i = samples.length - 1; i >= 0; i--) { const s = samples[i]; art.disc(g, s.x, s.y, radius(s.d) + 1, o.outline); }
    for (let i = samples.length - 1; i >= 0; i--) { const s = samples[i]; art.disc(g, s.x, s.y, radius(s.d), o.shade || o.fill); }
    if (o.shade) for (let i = samples.length - 1; i >= 0; i--) { const s = samples[i], r = radius(s.d); if (r > 1.5) art.disc(g, s.x - 0.5, s.y - 0.5, r - 1, o.fill); }
    if (o.pattern) for (let i = samples.length - 1; i >= 0; i--) { const s = samples[i]; const col = o.pattern(s.d, T); if (col) art.disc(g, s.x - 0.5, s.y - 0.5, Math.max(1, radius(s.d) - 2.5), col); }
    if (o.marks) {
      const M = o.marks, end = Math.min(M.end ? M.end(T) : T, acc), from = samples[0].d;
      let si = 0, i = 0;
      for (let d = M.start || 0; d < end; d += M.every, i++) {
        if (d < from) continue;
        while (si < samples.length - 1 && samples[si].d < d) si++;
        M.draw(g, samples[si].x, samples[si].y, i);
      }
    }
    if (o.light) for (let i = samples.length - 1; i >= 0; i--) { const s = samples[i], r = radius(s.d); if (r > 2) g.fillStyle = o.light, g.fillRect(Math.round(s.x - r * 0.45), Math.round(s.y - r * 0.55), 1, 1); }
    return acc;
  };
  // a mountain ridge from x to x+w whose tops lie between y-h and y; filled down to `bottom`
  art.ridge = function (g, x, y, w, h, color, seed, bottom, rough) {
    const rnd = WG.rng(seed || 7);
    const k = [rnd() * 6, rnd() * 6, rnd() * 6];
    g.fillStyle = color;
    for (let i = 0; i < w; i++) {
      const u = (i + x) / 64;
      let v = 0.5 + 0.28 * Math.sin(u * 1.3 + k[0]) + 0.16 * Math.sin(u * 3.1 + k[1]) + (rough || 0.07) * Math.sin(u * 9.7 + k[2]);
      v = clamp(v, 0, 1);
      const top = Math.round(y - h * v);
      g.fillRect(x + i, top, 1, (bottom === undefined ? y : bottom) - top);
    }
  };
  // a row of pixel pine trees along the line y
  art.pines = function (g, x, y, w, color, seed, minH, maxH, gap) {
    const rnd = WG.rng(seed || 11);
    g.fillStyle = color;
    let px = x - 4;
    while (px < x + w + 4) {
      const h = Math.round((minH || 8) + rnd() * ((maxH || 16) - (minH || 8)));
      for (let j = 0; j < h; j++) {
        const t = j / h;
        let half = Math.round(t * h * 0.32 + (j % 3 === 2 ? 1 : 0));
        if (j < 2) half = 0;
        g.fillRect(px - half, y - h + j, half * 2 + 1, 1);
      }
      g.fillRect(px, y, 1, 2);
      px += Math.round((gap || 5) + rnd() * 6);
    }
  };
  art.moon = function (g, cx, cy, r) {
    art.disc(g, cx, cy, r + 1, "#2B3A5E");
    art.disc(g, cx, cy, r, "#DDE7F7");
    art.disc(g, cx + 1, cy + 1, r - 1, "#F4F8FF");
    g.fillStyle = "#B9C6DF";
    g.fillRect(Math.round(cx - r * 0.4), Math.round(cy - r * 0.1), 2, 2);
    g.fillRect(Math.round(cx + r * 0.2), Math.round(cy + r * 0.35), 2, 1);
    g.fillRect(Math.round(cx + r * 0.1), Math.round(cy - r * 0.5), 1, 1);
  };
  // the night sky with the aurora: dithered colour bands, a moving curtain (green below, cyan, violet above),
  // vertical rays, and twinkling stars. Cached and repainted ~15 times a second.
  const skyCache = new Map();
  art.sky = function (g, x, y, w, h, t, o) {
    o = o || {};
    const key = w + "x" + h + ":" + (o.seed || 1) + ":" + (o.top || "") + (o.still ? "s" : "");
    let s = skyCache.get(key);
    if (!s) {
      const c = WG.canvas(w, h);
      s = { c, g: c.getContext("2d"), img: c.getContext("2d").createImageData(w, h), t: -1, stars: [] };
      const rnd = WG.rng(o.seed || 1);
      const n = Math.round(w * h / 140);
      for (let i = 0; i < n; i++) s.stars.push({ x: Math.floor(rnd() * w), y: Math.floor(rnd() * h * 0.9), b: rnd(), p: rnd() * 6.28 });
      skyCache.set(key, s);
    }
    const tq = o.still ? 0 : Math.floor(t * 15) / 15;
    if (s.t !== tq) { paintSky(s, w, h, tq, o); s.t = tq; }
    g.drawImage(s.c, x, y);
  };
  const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  function paintSky(s, w, h, t, o) {
    const d = s.img.data;
    const top = hex(o.top || "#050914"), bot = hex(o.bottom || "#13224A");
    const cG = hex("#34D399"), cC = hex("#22D3EE"), cV = hex("#8B7CF6");
    const amp = o.amount === undefined ? 1 : o.amount;
    const base = o.curtain === undefined ? 0.5 : o.curtain;
    for (let x = 0; x < w; x++) {
      const u = x / 64;
      const yc = h * (base + 0.13 * Math.sin(u * 1.6 + t * 0.35) + 0.08 * Math.sin(u * 4.1 - t * 0.22));
      const th = h * 0.32;
      const ray = 0.55 + 0.45 * Math.sin(x * 0.37 + Math.sin(x * 0.053 + t * 0.5) * 3) * Math.sin(x * 0.11 - t * 0.3);
      const inten = amp * clamp(0.35 + 0.65 * (0.5 + 0.5 * Math.sin(u * 0.9 - t * 0.15)) * ray, 0, 1);
      for (let yy = 0; yy < h; yy++) {
        const f = yy / (h - 1);
        // the ground: banded gradient, dithered between bands
        const band = f * 5, bi = Math.floor(band), bt = band - bi;
        const thr = BAYER[(yy & 3) * 4 + (x & 3)];
        const ff = (bi + (bt > thr ? 1 : 0)) / 5;
        let r = top[0] + (bot[0] - top[0]) * ff, gg = top[1] + (bot[1] - top[1]) * ff, b = top[2] + (bot[2] - top[2]) * ff;
        const dy = (yy - yc) / th;
        let a = dy < 0 ? Math.exp(-dy * dy * 1.6) : Math.exp(-dy * dy * 14);
        a *= inten;
        if (a > 0.04) {
          // colour along the curtain: green at its lower edge, cyan in the middle, violet at the top
          let col;
          if (dy > -0.15) col = cG;
          else if (dy > -0.75) col = cC.map((v, i) => v + (cG[i] - v) * clamp((dy + 0.75) / 0.6, 0, 1));
          else col = cV.map((v, i) => v + (cC[i] - v) * clamp((dy + 1.6) / 0.85, 0, 1));
          const q = Math.floor(a * 4 + thr) / 4; // four dithered steps
          const m = [0, 0.22, 0.42, 0.62, 0.8][Math.min(4, Math.max(0, Math.round(q * 4)))];
          r += (col[0] - r) * m; gg += (col[1] - gg) * m; b += (col[2] - b) * m;
        }
        const k = (yy * w + x) * 4;
        d[k] = r; d[k + 1] = gg; d[k + 2] = b; d[k + 3] = 255;
      }
    }
    s.g.putImageData(s.img, 0, 0);
    for (const st of s.stars) {
      const tw = 0.5 + 0.5 * Math.sin(t * (1.5 + st.b * 2) + st.p);
      if (tw < 0.25) continue;
      s.g.fillStyle = st.b > 0.85 ? "#FFFFFF" : st.b > 0.5 ? "#C9D6F2" : "#7F8FB8";
      s.g.fillRect(st.x, st.y, 1, 1);
      if (st.b > 0.93 && tw > 0.8) {
        s.g.fillStyle = "rgba(201,214,242,.55)";
        s.g.fillRect(st.x - 1, st.y, 1, 1); s.g.fillRect(st.x + 1, st.y, 1, 1);
        s.g.fillRect(st.x, st.y - 1, 1, 1); s.g.fillRect(st.x, st.y + 1, 1, 1);
      }
    }
  }

  // ---------- particles ----------
  // const fx = new WG.Particles(); fx.emit({x, y, n, colors, speed:[a,b], angle:[a,b], life:[a,b], gravity, drag, size, shape});
  // fx.update(dt); fx.draw(g). Shapes: "dot" (default), "spark" (a + that shrinks), "star" (twinkles), "square".
  class Particles {
    constructor(max) { this.max = max || 400; this.list = []; }
    emit(o) {
      const n = o.n || 8;
      const [s0, s1] = o.speed || [20, 60], [a0, a1] = o.angle || [0, Math.PI * 2], [l0, l1] = o.life || [0.4, 0.9];
      for (let i = 0; i < n && this.list.length < this.max; i++) {
        const a = a0 + Math.random() * (a1 - a0), s = s0 + Math.random() * (s1 - s0);
        this.list.push({
          x: o.x + (o.spread ? (Math.random() - 0.5) * o.spread : 0), y: o.y + (o.spread ? (Math.random() - 0.5) * o.spread : 0),
          vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: l0 + Math.random() * (l1 - l0), age: 0,
          color: o.colors ? o.colors[(Math.random() * o.colors.length) | 0] : "#FFFFFF",
          g: o.gravity || 0, drag: o.drag || 0, size: o.size || 1, shape: o.shape || "dot",
        });
      }
    }
    update(dt) {
      const L = this.list;
      for (let i = L.length - 1; i >= 0; i--) {
        const p = L[i];
        p.age += dt;
        if (p.age >= p.life) { L[i] = L[L.length - 1]; L.pop(); continue; }
        p.vy += p.g * dt;
        if (p.drag) { const k = Math.max(0, 1 - p.drag * dt); p.vx *= k; p.vy *= k; }
        p.x += p.vx * dt; p.y += p.vy * dt;
      }
    }
    draw(g) {
      for (const p of this.list) {
        const f = p.age / p.life, x = Math.round(p.x), y = Math.round(p.y);
        g.fillStyle = p.color;
        if (p.shape === "spark") {
          const r = f < 0.5 ? 1 : 0;
          g.fillRect(x, y, 1, 1);
          if (r) { g.fillRect(x - 1, y, 1, 1); g.fillRect(x + 1, y, 1, 1); g.fillRect(x, y - 1, 1, 1); g.fillRect(x, y + 1, 1, 1); }
        } else if (p.shape === "star") {
          if (Math.sin(p.age * 30) > -0.3) {
            g.fillRect(x, y, 1, 1);
            if (f < 0.6) { g.fillRect(x - 1, y, 1, 1); g.fillRect(x + 1, y, 1, 1); g.fillRect(x, y - 1, 1, 1); g.fillRect(x, y + 1, 1, 1); }
            if (f < 0.3) { g.fillRect(x - 2, y, 1, 1); g.fillRect(x + 2, y, 1, 1); g.fillRect(x, y - 2, 1, 1); g.fillRect(x, y + 2, 1, 1); }
          }
        } else {
          const s = p.size > 1 && f > 0.6 ? p.size - 1 : p.size;
          g.fillRect(x, y, s, s);
        }
      }
    }
    clear() { this.list.length = 0; }
  }
  WG.Particles = Particles;

  // ---------- parallax: layers of pictures that tile sideways and move at their own speed ----------
  // new WG.Parallax([{img, speed: 0.2, y: 40}, …]).draw(g, cameraX)
  class Parallax {
    constructor(layers) { this.layers = layers; }
    draw(g, camX, camY) {
      for (const L of this.layers) {
        const w = L.img.width;
        let ox = -Math.round((camX || 0) * L.speed) % w;
        if (ox > 0) ox -= w;
        const y = Math.round((L.y || 0) - (camY || 0) * (L.speedY || 0));
        for (let x = ox; x < W; x += w) g.drawImage(L.img, x, y);
      }
    }
  }
  WG.Parallax = Parallax;

  // ---------- sound: a little 16-bit console (two pulse channels, triangle, noise) ----------
  const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function freq(n) {
    if (typeof n === "number") return n;
    const m = /^([A-G])([#b]?)(-?\d)$/.exec(n);
    if (!m) return 0;
    const semi = NOTE[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + (+m[3] + 1) * 12;
    return 440 * Math.pow(2, (semi - 69) / 12);
  }
  const Sound = WG.sound = {
    ac: null, master: null, sfxBus: null, musBus: null, waves: {}, noise: null, muted: WG.store.get("mute", false), song: null,
    freq,
    ensure() {
      if (this.ac) return this.ac;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { this.ac = new AC(); } catch (e) { return null; }
      const a = this.ac;
      this.master = a.createGain(); this.master.gain.value = this.muted ? 0 : 0.55; this.master.connect(a.destination);
      this.sfxBus = a.createGain(); this.sfxBus.gain.value = 0.9; this.sfxBus.connect(this.master);
      this.musBus = a.createGain(); this.musBus.gain.value = 0.38; this.musBus.connect(this.master);
      for (const [name, duty] of [["p12", 0.125], ["p25", 0.25], ["p50", 0.5]]) {
        const N = 48, re = new Float32Array(N), im = new Float32Array(N);
        for (let k = 1; k < N; k++) re[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
        this.waves[name] = a.createPeriodicWave(re, im);
      }
      const len = a.sampleRate;
      this.noise = a.createBuffer(1, len, a.sampleRate);
      const ch = this.noise.getChannelData(0);
      let lfsr = 1;
      for (let i = 0; i < len; i++) { // a console-style noise: a 15-bit shift register, held for a few samples
        if (i % 4 === 0) { const bit = (lfsr ^ (lfsr >> 1)) & 1; lfsr = (lfsr >> 1) | (bit << 14); }
        ch[i] = (lfsr & 1) ? 0.9 : -0.9;
      }
      return a;
    },
    unlock() { const a = this.ensure(); if (a && a.state === "suspended") a.resume().catch(() => {}); },
    suspend() { if (this.ac && this.ac.state === "running") this.ac.suspend().catch(() => {}); },
    resume() { if (this.ac && this.ac.state === "suspended") this.ac.resume().catch(() => {}); },
    setMuted(m) {
      this.muted = !!m; WG.store.set("mute", this.muted);
      if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.55, this.ac.currentTime, 0.02);
    },
    // one note: {w:"p12|p25|p50|tri|saw|noise", f:Hz or "A4", f2 (slide to), t (delay s), d (length s), v (volume 0…1),
    // a (attack), r (release), sus (level after the attack, 0…1), vib (vibrato Hz), hp/lp (noise filters)}
    tone(o, when, bus) {
      const a = this.ensure();
      if (!a || this.muted && !bus) return;
      const t0 = (when || a.currentTime) + (o.t || 0), d = o.d || 0.1, v = o.v === undefined ? 0.3 : o.v;
      const atk = o.a === undefined ? 0.004 : o.a, rel = o.r === undefined ? 0.05 : o.r, sus = o.sus === undefined ? 1 : o.sus;
      const g = a.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(v, t0 + atk);
      g.gain.linearRampToValueAtTime(v * sus, t0 + Math.max(atk, d));
      g.gain.linearRampToValueAtTime(0, t0 + d + rel);
      let src, out = g;
      if (o.w === "noise") {
        src = a.createBufferSource(); src.buffer = this.noise; src.loop = true;
        src.playbackRate.setValueAtTime(o.f ? freq(o.f) / 1000 : 1, t0);
        if (o.f2) src.playbackRate.exponentialRampToValueAtTime(Math.max(0.01, freq(o.f2) / 1000), t0 + d);
        if (o.hp || o.lp) {
          const fl = a.createBiquadFilter(); fl.type = o.hp ? "highpass" : "lowpass"; fl.frequency.value = o.hp || o.lp;
          src.connect(fl); fl.connect(g);
        } else src.connect(g);
      } else {
        src = a.createOscillator();
        if (o.w === "tri") src.type = "triangle";
        else if (o.w === "saw") src.type = "sawtooth";
        else src.setPeriodicWave(this.waves[o.w] || this.waves.p50);
        const f = freq(o.f);
        src.frequency.setValueAtTime(f, t0);
        if (o.f2) src.frequency.exponentialRampToValueAtTime(Math.max(20, freq(o.f2)), t0 + d);
        if (o.vib) {
          const lfo = a.createOscillator(), lg = a.createGain();
          lfo.frequency.value = o.vib; lg.gain.value = f * 0.02;
          lfo.connect(lg); lg.connect(src.frequency); lfo.start(t0 + 0.08); lfo.stop(t0 + d + rel + 0.05);
        }
        src.connect(g);
      }
      out.connect(bus || this.sfxBus);
      src.start(t0); src.stop(t0 + d + rel + 0.05);
    },
    // a named effect or jingle (see SFX below), or a list of tones
    sfx(name) {
      if (this.muted) return;
      const list = typeof name === "string" ? SFX[name] : name;
      if (!list) return;
      const a = this.ensure();
      if (!a) return;
      const now = a.currentTime + 0.01;
      for (const o of list) this.tone(o, now);
    },
    jingle(name) { this.sfx(name); },
    // music: {bpm, loop:true, ch:[{w:"p25", v:.2, notes:"C5 - E5 . G5 …", sus, r}, {w:"noise", notes:"k . h . s . h ."}]}
    // one token = one sixteenth; "." rest, "-" holds the note before; noise tokens k (kick) s (snare) h (hat) o (open hat)
    music(song) {
      this.stopMusic();
      if (!song) return;
      const a = this.ensure();
      if (!a) return;
      const parsed = song.ch.map((c) => {
        const toks = c.notes.trim().split(/\s+/);
        const ev = new Array(toks.length).fill(null);
        for (let i = 0; i < toks.length; i++) {
          const tk = toks[i];
          if (tk === "." || tk === "-") continue;
          let len = 1;
          while (toks[i + len] === "-") len++;
          ev[i] = { tk, len };
        }
        return { c, ev, n: toks.length };
      });
      const spb = 60 / (song.bpm || 120) / 4;
      const st = { parsed, step: 0, next: a.currentTime + 0.08, spb };
      this.song = st;
      const pump = () => {
        if (this.song !== st) return;
        const ac = this.ac;
        while (st.next < ac.currentTime + 0.2) {
          for (const p of st.parsed) {
            const e = p.ev[st.step % p.n];
            if (!e) continue;
            const v = p.c.v === undefined ? 0.2 : p.c.v;
            if (p.c.w === "noise") {
              const D = DRUM[e.tk];
              if (D) this.tone(Object.assign({}, D, { v: (D.v || 0.3) * v / 0.2 }), st.next, this.musBus);
            } else {
              const f = freq(e.tk);
              if (f) this.tone({ w: p.c.w, f, d: e.len * st.spb * (p.c.gate || 0.85), v, sus: p.c.sus === undefined ? 0.6 : p.c.sus, r: p.c.r === undefined ? 0.04 : p.c.r, vib: p.c.vib }, st.next, this.musBus);
            }
          }
          st.next += st.spb; st.step++;
        }
      };
      st.timer = setInterval(pump, 40);
      pump();
    },
    stopMusic() { if (this.song) { clearInterval(this.song.timer); this.song = null; } },
  };
  const DRUM = {
    k: { w: "tri", f: 150, f2: 40, d: 0.09, v: 0.5, r: 0.02 },
    s: { w: "noise", f: 2400, d: 0.08, v: 0.22, sus: 0.3, r: 0.05, hp: 900 },
    h: { w: "noise", f: 6000, d: 0.02, v: 0.09, r: 0.02, hp: 5000 },
    o: { w: "noise", f: 6000, d: 0.09, v: 0.08, sus: 0.4, r: 0.05, hp: 5000 },
  };
  const SFX = WG.SFX = {
    blip: [{ w: "p12", f: 1320, d: 0.025, v: 0.16 }],
    select: [{ w: "p25", f: 880, d: 0.03, v: 0.18 }, { w: "p25", f: 1320, t: 0.035, d: 0.04, v: 0.16 }],
    confirm: [{ w: "p25", f: "C6", d: 0.05, v: 0.2 }, { w: "p25", f: "G6", t: 0.05, d: 0.09, v: 0.2, sus: 0.5 }],
    back: [{ w: "p25", f: "G5", d: 0.05, v: 0.18 }, { w: "p25", f: "C5", t: 0.05, d: 0.08, v: 0.16 }],
    pause: [{ w: "p50", f: "E6", d: 0.05, v: 0.14 }, { w: "p50", f: "C6", t: 0.06, d: 0.05, v: 0.14 }, { w: "p50", f: "E6", t: 0.12, d: 0.05, v: 0.14 }, { w: "p50", f: "C6", t: 0.18, d: 0.08, v: 0.14 }],
    eat: [{ w: "p25", f: "E6", d: 0.04, v: 0.2 }, { w: "p25", f: "B6", t: 0.04, d: 0.06, v: 0.2, sus: 0.4 }, { w: "noise", f: 3000, d: 0.03, v: 0.06, hp: 3000 }],
    coin: [{ w: "p25", f: "B5", d: 0.05, v: 0.2 }, { w: "p25", f: "E6", t: 0.05, d: 0.25, v: 0.2, sus: 0.4, r: 0.1 }],
    bonus: [{ w: "p25", f: "C6", d: 0.05, v: 0.2 }, { w: "p25", f: "E6", t: 0.05, d: 0.05, v: 0.2 }, { w: "p25", f: "G6", t: 0.1, d: 0.05, v: 0.2 }, { w: "p25", f: "C7", t: 0.15, d: 0.18, v: 0.2, sus: 0.5, r: 0.1 }, { w: "tri", f: "C5", t: 0.15, d: 0.18, v: 0.25 }],
    powerup: [{ w: "p50", f: "C5", f2: "C7", d: 0.35, v: 0.16, vib: 12 }],
    jump: [{ w: "p25", f: "C5", f2: "C6", d: 0.12, v: 0.18, sus: 0.6 }],
    hit: [{ w: "noise", f: 1200, d: 0.06, v: 0.3, sus: 0.3 }, { w: "p50", f: 220, f2: 110, d: 0.08, v: 0.18 }],
    bounce: [{ w: "p50", f: 440, d: 0.03, v: 0.16 }],
    shoot: [{ w: "p12", f: 1600, f2: 400, d: 0.1, v: 0.16 }],
    explode: [{ w: "noise", f: 900, f2: 60, d: 0.45, v: 0.4, sus: 0.4, r: 0.2 }],
    hurt: [{ w: "p50", f: 330, f2: 150, d: 0.18, v: 0.2 }, { w: "noise", f: 800, d: 0.1, v: 0.15 }],
    die: [{ w: "noise", f: 1400, f2: 90, d: 0.4, v: 0.32, sus: 0.5, r: 0.15 }, { w: "p50", f: "E5", f2: "E3", d: 0.55, v: 0.2, sus: 0.7, r: 0.1 }],
    whoosh: [{ w: "noise", f: 300, f2: 2400, d: 0.18, v: 0.12, hp: 600 }],
    card: [{ w: "noise", f: 5000, d: 0.03, v: 0.12, hp: 2500 }],
    place: [{ w: "tri", f: 330, d: 0.05, v: 0.3 }, { w: "noise", f: 2000, d: 0.02, v: 0.06 }],
    tick: [{ w: "p12", f: 2000, d: 0.012, v: 0.08 }],
    count: [{ w: "p50", f: "A5", d: 0.1, v: 0.18, sus: 0.6 }],
    go: [{ w: "p50", f: "A6", d: 0.3, v: 0.2, sus: 0.6, r: 0.1 }, { w: "p25", f: "E6", d: 0.3, v: 0.12 }],
    start: [["C5", 0], ["E5", 0.08], ["G5", 0.16], ["C6", 0.24], ["G5", 0.36], ["C6", 0.44]].map(([f, t], i) => ({ w: "p25", f, t, d: i === 5 ? 0.3 : 0.07, v: 0.18, sus: 0.6, r: 0.06 }))
      .concat([{ w: "tri", f: "C4", d: 0.24, v: 0.25 }, { w: "tri", f: "G3", t: 0.24, d: 0.2, v: 0.25 }, { w: "tri", f: "C4", t: 0.44, d: 0.3, v: 0.25 }]),
    gameover: [["G5", 0], ["D5", 0.16], ["Bb4", 0.32], ["A4", 0.48], ["G4", 0.64]].map(([f, t], i) => ({ w: "p25", f, t, d: i === 4 ? 0.5 : 0.14, v: 0.17, sus: 0.7, r: 0.08, vib: i === 4 ? 6 : 0 }))
      .concat([{ w: "tri", f: "G3", d: 0.3, v: 0.25 }, { w: "tri", f: "D3", t: 0.32, d: 0.3, v: 0.25 }, { w: "tri", f: "G2", t: 0.64, d: 0.5, v: 0.25 }]),
    record: [["C5", 0], ["C5", 0.1], ["C5", 0.2], ["C5", 0.3], ["Ab4", 0.45], ["Bb4", 0.6], ["C5", 0.75], ["Bb4", 0.9], ["C5", 1.0]].map(([f, t], i) => ({ w: "p25", f: freq(f) * 2, t, d: i === 8 ? 0.6 : 0.08, v: 0.17, sus: 0.7, r: 0.08, vib: i === 8 ? 6 : 0 }))
      .concat([{ w: "tri", f: "Ab3", t: 0.45, d: 0.15, v: 0.25 }, { w: "tri", f: "Bb3", t: 0.6, d: 0.15, v: 0.25 }, { w: "tri", f: "C4", t: 0.75, d: 0.85, v: 0.25 }]),
    win: [["C5", 0], ["E5", 0.1], ["G5", 0.2], ["C6", 0.3], ["E6", 0.45], ["G6", 0.55]].map(([f, t], i) => ({ w: "p25", f, t, d: i === 5 ? 0.5 : 0.09, v: 0.17, sus: 0.7, r: 0.1 })),
    lose: [{ w: "p50", f: "C5", d: 0.2, v: 0.16 }, { w: "p50", f: "B4", t: 0.22, d: 0.2, v: 0.16 }, { w: "p50", f: "Bb4", t: 0.44, d: 0.2, v: 0.16 }, { w: "p50", f: "A4", t: 0.66, d: 0.6, v: 0.16, vib: 5 }],
  };

  // ---------- input: keyboard, gamepad, on-screen pad and buttons, swipes, taps ----------
  const BUTTONS = ["up", "down", "left", "right", "a", "b", "start"];
  const KEYS = {
    ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down", ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right",
    KeyZ: "a", Space: "a", Enter: "a", KeyJ: "a", NumpadEnter: "a", KeyX: "b", KeyK: "b", ShiftLeft: "b", ShiftRight: "b",
    Escape: "start", KeyP: "start",
  };
  const Input = WG.input = {
    src: { key: {}, pad: {}, touch: {} }, // held per source
    edgeDown: {}, edgeUp: {}, tap: null, swipe: null, pointer: { x: 0, y: 0, down: false },
    _held(b) { return !!(this.src.key[b] || this.src.pad[b] || this.src.touch[b]); },
    held(b) { return this._held(b); },
    pressed(b) { return !!this.edgeDown[b]; },
    released(b) { return !!this.edgeUp[b]; },
    // the direction pressed this step, if any ("up" | "down" | "left" | "right" | null)
    dir() { for (const d of ["up", "down", "left", "right"]) if (this.edgeDown[d]) return d; return null; },
    any() { for (const b of BUTTONS) if (this.edgeDown[b]) return true; return !!this.tap; },
    set(srcName, b, on) {
      const s = this.src[srcName];
      const was = this._held(b);
      s[b] = on;
      const now = this._held(b);
      if (!was && now) this.edgeDown[b] = true;
      if (was && !now) this.edgeUp[b] = true;
    },
    endStep() { this.edgeDown = {}; this.edgeUp = {}; this.tap = null; this.swipe = null; },
    clear() { this.src = { key: {}, pad: {}, touch: {} }; this.endStep(); },
    padPrev: {},
    pollPad() {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const st = {};
      for (const p of pads) {
        if (!p || !p.connected) continue;
        const b = (i) => !!(p.buttons[i] && p.buttons[i].pressed);
        const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
        st.up = st.up || b(12) || ay < -0.5; st.down = st.down || b(13) || ay > 0.5;
        st.left = st.left || b(14) || ax < -0.5; st.right = st.right || b(15) || ax > 0.5;
        st.a = st.a || b(0) || b(2); st.b = st.b || b(1) || b(3); st.start = st.start || b(9) || b(8);
      }
      const edges = {};
      for (const k of BUTTONS) {
        const on = !!st[k];
        if (on !== !!this.padPrev[k]) { this.set("pad", k, on); if (on) edges[k] = true; }
      }
      this.padPrev = st;
      return edges;
    },
  };

  // ---------- the play screen ----------
  const R = WG.runner = { def: null, inst: null, state: "idle", level: "normal", time: 0, acc: 0, raf: 0, last: 0, shake: 0, shakeT: 0, flashC: null, flashT: 0, flashD: 0, el: null, opts: {} };

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid.nodeType ? kid : String(kid));
    return n;
  }
  function icon(name, cls) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("class", "i" + (cls ? " " + cls : ""));
    s.setAttribute("aria-hidden", "true");
    const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
    u.setAttribute("href", "#i-" + name);
    s.append(u);
    return s;
  }
  WG.ui = { el, icon };
  // pixel lettering as an element, scaled by a whole number
  WG.ui.pixelTitle = function (s, o) {
    o = o || {};
    const c = WG.textCanvas(s, { color: o.color || "#EAF0FA", shadow: o.shadow === undefined ? "#05291C" : o.shadow, outline: o.outline });
    c.className = "px-title" + (o.cls ? " " + o.cls : "");
    c.setAttribute("role", "img");
    c.setAttribute("aria-label", s);
    c.style.setProperty("--pw", c.width);
    c.style.setProperty("--ph", c.height);
    return c;
  };
  // pixel stars: WG.ui.star(on, px) → a canvas shown at a whole scale
  const STAR_ROWS = [".....h.....", "....hhh....", "....hha....", "hhhhhaaaaaa", ".haaaaaaad.", "..aaaaaad..", "..aaaaadd..", ".aaad.addd.", ".aad...ddd.", ".ad.....dd."];
  let STARS = null;
  WG.ui.star = function (on, px) {
    if (!STARS) STARS = {
      on: WG.sprite(STAR_ROWS, { h: "#FFF0C2", a: "#FFD27A", d: "#C98A1B" }, { outline: "#2A1E00" }),
      off: WG.sprite(STAR_ROWS, { h: "#3B4766", a: "#26324F", d: "#1D2944" }, { outline: "#0A0F1E" }),
    };
    const src = on ? STARS.on : STARS.off;
    const c = WG.canvas(src.width, src.height);
    c.getContext("2d").drawImage(src, 0, 0);
    c.className = "px-star" + (on ? " on" : "");
    if (px) c.style.setProperty("--px", px);
    c.setAttribute("aria-hidden", "true");
    return c;
  };
  WG.ui.stars = function (n, px, cls) {
    const box = el("span", { class: "stars" + (cls ? " " + cls : ""), role: "img", "aria-label": n + " из 3 звёзд" });
    for (let i = 0; i < 3; i++) box.append(WG.ui.star(i < n, px));
    return box;
  };
  // the family's leaderboard as one rounded list of rows; highlights the rows with the player's name
  WG.ui.board = function (top, o) {
    o = o || {};
    const me = WG.me && WG.me.user ? WG.me.user.name : "";
    const byTime = o.rank === "time";
    const list = el("ol", { class: "board" + (o.compact ? " compact" : "") });
    (top || []).forEach((r, i) => {
      const mine = typeof r.me === "boolean" ? r.me : !!me && r.name === me;
      list.append(el("li", { class: "brow" + (mine ? " me" : "") + (i < 3 ? " top" + (i + 1) : "") },
        el("span", { class: "bplace", text: String(r.rank || i + 1) }),
        el("span", { class: "bname" }, el("span", { class: "bn", text: r.name || "—" }), mine ? el("span", { class: "byou", text: "это ты" }) : null),
        o.kind === "furthest"
          ? el("span", { class: "bval" }, el("b", { text: (o.stageWord || "Уровень") + " " + (r.stage || 0) }), el("small", { text: ["★ " + (r.stars || 0), WG.fmtDate(r.at)].filter(Boolean).join(" · ") }))
          : el("span", { class: "bval" }, el("b", { text: byTime ? WG.fmtTime(r.ms) : WG.fmtNum(r.score) }), el("small", { text: [!byTime && r.ms ? WG.fmtTime(r.ms) : "", WG.fmtDate(r.at)].filter(Boolean).join(" · ") })),
      ));
    });
    return list;
  };

  function build() {
    if (R.el) return R.el;
    const root = el("section", { class: "play", id: "play", hidden: true, "aria-label": "Игра" });
    const canvas = el("canvas", { class: "screen", width: W, height: H, "aria-label": "Игровое поле" });
    const g = canvas.getContext("2d");
    g.imageSmoothingEnabled = false;
    const back = el("button", { class: "pbtn", "aria-label": "К играм", onclick: () => exitGame() }, icon("back"));
    const title = el("div", { class: "ptitle" }, el("b"), el("span"));
    const mute = el("button", { class: "pbtn", "aria-label": "Звук", "aria-pressed": "false", onclick: () => { Sound.unlock(); Sound.setMuted(!Sound.muted); syncMute(); } });
    const pause = el("button", { class: "pbtn", "aria-label": "Пауза", onclick: () => (R.state === "play" ? pauseGame() : R.state === "pause" ? resumeGame() : null) }, icon("pause"));
    const bar = el("div", { class: "pbar" }, back, title, el("div", { class: "pright" }, mute, pause));
    const stage = el("div", { class: "stage" }, canvas);
    const dpad = el("div", { class: "dpad", "aria-hidden": "true" },
      ...["up", "right", "down", "left"].map((d) => el("span", { class: "arm " + d, "data-d": d }, icon("chev", "c-" + d))),
      el("span", { class: "hub" }));
    const btnA = el("button", { class: "abtn a", "aria-label": "Кнопка А", "data-b": "a" }, el("span"));
    const btnB = el("button", { class: "abtn b", "aria-label": "Кнопка Б", "data-b": "b" }, el("span"));
    const abtns = el("div", { class: "abtns" }, btnB, btnA);
    const hint = el("p", { class: "deck-hint" });
    const deck = el("div", { class: "deck" }, dpad, abtns, hint);
    const ov = el("div", { class: "ov", hidden: true });
    root.append(bar, stage, deck, ov);
    document.body.append(root);
    R.el = { root, canvas, g, bar, title, mute, pause, stage, dpad, abtns, btnA, btnB, deck, hint, ov };
    wireTouch();
    window.addEventListener("resize", () => R.state !== "idle" && fit());
    window.addEventListener("orientationchange", () => setTimeout(() => R.state !== "idle" && fit(), 120));
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", (e) => { const b = KEYS[e.code]; if (b) Input.set("key", b, false); });
    window.addEventListener("blur", () => { Input.clear(); if (R.state === "play") pauseGame(); });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { if (R.state === "play") pauseGame(); Sound.suspend(); } else if (R.state !== "idle") Sound.resume();
    });
    return R.el;
  }
  function syncMute() {
    const m = R.el.mute;
    m.replaceChildren(icon(Sound.muted ? "mute" : "speaker"));
    m.setAttribute("aria-pressed", Sound.muted ? "true" : "false");
    m.setAttribute("aria-label", Sound.muted ? "Включить звук" : "Выключить звук");
  }

  const coarse = () => window.matchMedia && matchMedia("(pointer: coarse)").matches;
  function controlsOf(def) { return Object.assign({ dpad: true, a: false, b: false, swipe: true, landscapeDpad: true }, def.controls || {}); }
  // whole device pixels per screen pixel; falls back to an exact fit when whole steps would waste a quarter of the room
  function scaleFor(aw, ah) {
    const dpr = window.devicePixelRatio || 1;
    const kf = Math.min(aw * dpr / W, ah * dpr / H);
    const k = Math.floor(kf);
    if (k >= 1 && k / kf >= 0.75) return k / dpr;
    return Math.max(0.25, kf) / dpr;
  }
  function fit() {
    const E = R.el, def = R.def;
    if (!def) return;
    const cs = getComputedStyle(E.root);
    const pw = E.root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const ph = E.root.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const portrait = ph > pw * 1.05;
    const touch = coarse();
    const ctl = controlsOf(def);
    const hasCtl = ctl.dpad || ctl.a || ctl.b;
    const BAR = 56, DECK = 236;
    const rotate = portrait && touch && def.portrait === false;
    let mode, s;
    if (portrait) {
      const deck = touch && hasCtl && !rotate;
      mode = deck ? "portrait deck-on" : "portrait";
      s = scaleFor(pw, ph - BAR - (deck ? DECK : 0));
    } else {
      const sa = scaleFor(pw, ph - BAR), sb = scaleFor(pw, ph);
      mode = sa >= sb - 1e-6 ? "landscape bar-above" : "landscape bar-over";
      s = mode.includes("above") ? sa : sb;
      if (touch && hasCtl && ctl.landscapeDpad !== false) mode += " deck-over";
    }
    E.root.className = "play " + mode + (touch ? " touch" : "") + (ctl.dpad ? " has-dpad" : "") + (ctl.a ? " has-a" : "") + (ctl.b ? " has-b" : "");
    E.canvas.style.width = W * s + "px";
    E.canvas.style.height = H * s + "px";
    E.btnA.querySelector("span").textContent = typeof ctl.a === "string" ? ctl.a : "А";
    E.btnB.querySelector("span").textContent = typeof ctl.b === "string" ? ctl.b : "Б";
    E.hint.textContent = def.touchHint || (ctl.swipe ? "Можно и свайпом по полю" : "");
    R.scale = s;
    R.layout = { portrait, touch, dpad: !!ctl.dpad && touch && (portrait ? !rotate : ctl.landscapeDpad !== false) };
    E.btnA.classList.toggle("word", E.btnA.textContent.length > 2);
    E.btnB.classList.toggle("word", E.btnB.textContent.length > 2);
    // a landscape-only game turned upright: ask to turn the phone (the results stay readable either way)
    if (rotate && !R.rotated && R.state !== "over") { R.rotated = true; if (R.state === "play") pauseGame(true); showRotate(); }
    else if (!rotate && R.rotated) {
      R.rotated = false;
      if (R.ovKind === "rotate") { if (R.state === "pause") showPause(); else if (R.state === "start") showStart(); else hideOverlay(); }
    }
  }

  // touch: the cross pad (slide your thumb between directions), the A/B buttons, swipes and taps on the screen
  function wireTouch() {
    const E = R.el;
    let padId = null;
    const padDir = (e) => {
      const r = E.dpad.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      if (Math.hypot(dx, dy) < r.width * 0.12) return null;
      return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
    };
    const setPad = (d) => {
      for (const k of ["up", "down", "left", "right"]) {
        const on = k === d;
        if (!!Input.src.touch[k] !== on) Input.set("touch", k, on);
        E.dpad.querySelector("." + k).classList.toggle("on", on);
      }
    };
    E.dpad.addEventListener("pointerdown", (e) => {
      e.preventDefault(); Sound.unlock();
      padId = e.pointerId; E.dpad.setPointerCapture(e.pointerId); setPad(padDir(e));
    });
    E.dpad.addEventListener("pointermove", (e) => { if (e.pointerId === padId) setPad(padDir(e)); });
    const padUp = (e) => { if (e.pointerId === padId) { padId = null; setPad(null); } };
    E.dpad.addEventListener("pointerup", padUp);
    E.dpad.addEventListener("pointercancel", padUp);
    for (const btn of [E.btnA, E.btnB]) {
      const b = btn.dataset.b;
      btn.addEventListener("pointerdown", (e) => { e.preventDefault(); Sound.unlock(); btn.setPointerCapture(e.pointerId); btn.classList.add("on"); Input.set("touch", b, true); });
      const up = () => { btn.classList.remove("on"); Input.set("touch", b, false); };
      btn.addEventListener("pointerup", up);
      btn.addEventListener("pointercancel", up);
      btn.addEventListener("click", (e) => e.preventDefault());
    }
    // swipes anywhere on the screen or the deck; a tap on the screen becomes input.tap in screen pixels
    let sw = null;
    const onDown = (e) => {
      if (e.target.closest(".dpad, .abtn, .pbtn, .ov")) return;
      Sound.unlock();
      sw = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: false };
      const p = toScreen(e); Input.pointer.x = p.x; Input.pointer.y = p.y; Input.pointer.down = true;
    };
    const onMove = (e) => {
      const p = toScreen(e); Input.pointer.x = p.x; Input.pointer.y = p.y;
      if (!sw || e.pointerId !== sw.id) return;
      const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
      const th = 22;
      if (Math.max(Math.abs(dx), Math.abs(dy)) >= th) {
        const d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
        if (R.def && controlsOf(R.def).swipe) { Input.swipe = d; Input.edgeDown[d] = true; }
        sw.x = e.clientX; sw.y = e.clientY; sw.moved = true;
      }
    };
    const onUp = (e) => {
      Input.pointer.down = false;
      if (!sw || e.pointerId !== sw.id) return;
      if (!sw.moved && Math.hypot(e.clientX - sw.x0, e.clientY - sw.y0) < 12 && e.target === E.canvas) Input.tap = toScreen(e);
      sw = null;
    };
    E.root.addEventListener("pointerdown", onDown);
    E.root.addEventListener("pointermove", onMove);
    E.root.addEventListener("pointerup", onUp);
    E.root.addEventListener("pointercancel", () => { sw = null; Input.pointer.down = false; });
    E.root.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  function toScreen(e) {
    const r = R.el.canvas.getBoundingClientRect();
    return { x: Math.floor((e.clientX - r.left) / r.width * W), y: Math.floor((e.clientY - r.top) / r.height * H) };
  }

  function onKey(e) {
    if (R.state === "idle") return;
    const b = KEYS[e.code];
    Sound.unlock();
    if (R.ovKind) { // menus: arrows move between buttons, Enter/Space press, Esc goes back
      if (navKey(e)) e.preventDefault();
      return;
    }
    if (!b) return;
    e.preventDefault();
    if (!e.repeat) Input.set("key", b, true);
  }
  function navItems() { return [...R.el.ov.querySelectorAll("[data-nav]:not([disabled])")]; }
  // in a grid of tiles (data-grid), up and down jump a whole row
  function navMove(step, vertical) {
    const items = navItems();
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    const cur = items[i];
    if (vertical && cur && cur.hasAttribute("data-grid")) {
      const grid = items.filter((x) => x.hasAttribute("data-grid") && x.parentNode === cur.parentNode);
      const top0 = grid[0].offsetTop;
      const cols = Math.max(1, grid.filter((x) => x.offsetTop === top0).length);
      const gi = grid.indexOf(cur) + step * cols;
      if (gi >= 0 && gi < grid.length) { grid[gi].focus(); Sound.sfx("blip"); return; }
      const out = step > 0 ? items.indexOf(grid[grid.length - 1]) + 1 : items.indexOf(grid[0]) - 1;
      if (out >= 0 && out < items.length) { items[out].focus(); Sound.sfx("blip"); }
      return;
    }
    const n = items[(i < 0 ? 0 : i + step + items.length) % items.length];
    n.focus();
    if (n.getAttribute("role") === "radio") n.click();
    Sound.sfx("blip");
  }
  function navKey(e) {
    const k = e.key;
    if (k === "ArrowDown" || e.code === "KeyS") { navMove(1, true); return true; }
    if (k === "ArrowUp" || e.code === "KeyW") { navMove(-1, true); return true; }
    if (k === "ArrowRight" || e.code === "KeyD") { navMove(1); return true; }
    if (k === "ArrowLeft" || e.code === "KeyA") { navMove(-1); return true; }
    if (k === "Escape") { if (R.ovBack) R.ovBack(); return true; }
    if ((k === "Enter" || k === " ") && !navItems().includes(document.activeElement)) { const p = R.el.ov.querySelector("[data-primary]"); if (p) p.click(); return true; }
    return false;
  }
  function padNav(edges) {
    if (edges.down) navMove(1, true);
    if (edges.up) navMove(-1, true);
    if (edges.right) navMove(1);
    if (edges.left) navMove(-1);
    if (edges.a) { const f = navItems().includes(document.activeElement) ? document.activeElement : R.el.ov.querySelector("[data-primary]"); if (f) f.click(); }
    if (edges.b && R.ovBack) R.ovBack();
    if (edges.start) { const p = R.el.ov.querySelector("[data-primary]"); if (p) p.click(); }
  }

  // ---------- the loop ----------
  function frame(now) {
    R.raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, Math.max(0, (now - R.last) / 1000));
    R.last = now;
    const edges = Input.pollPad();
    if (R.ovKind) padNav(edges);
    if (R.state === "play" && R.inst) {
      R.acc += dt;
      let n = 0;
      while (R.acc >= STEP && n < 6 && R.state === "play") {
        if (Input.pressed("start")) { Input.endStep(); pauseGame(); break; }
        R.time += STEP;
        R.inst.update(STEP);
        if (R.shakeT > 0) R.shakeT -= STEP;
        if (R.flashT > 0) R.flashT -= STEP;
        Input.endStep();
        R.acc -= STEP; n++;
      }
      if (n >= 6) R.acc = 0;
    }
    render();
  }
  function render() {
    const g = R.el.g;
    if (!R.inst) { g.fillStyle = WG.PAL.night; g.fillRect(0, 0, W, H); return; }
    g.save();
    if (R.shakeT > 0 && R.state === "play") {
      const k = R.shake * (R.shakeT / R.shakeD);
      g.translate(Math.round((Math.random() * 2 - 1) * k), Math.round((Math.random() * 2 - 1) * k));
    }
    g.imageSmoothingEnabled = false;
    try { R.inst.draw(g, R.acc / STEP); } catch (e) { console.error(e); }
    g.restore();
    if (R.flashT > 0) {
      g.globalAlpha = clamp(R.flashT / R.flashD, 0, 1) * 0.45;
      g.fillStyle = R.flashC; g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
    }
  }

  // ---------- running a game ----------
  WG.game = function (def) {
    WG.defs[def.id] = def;
    const w = loading[def.id];
    if (w) { delete loading[def.id]; w.resolve(def); }
  };
  const loading = {};
  WG.entry = (id) => WG.registry.find((g) => g.id === id) || null;
  WG.load = function (id) {
    if (WG.defs[id]) return Promise.resolve(WG.defs[id]);
    const entry = WG.entry(id);
    if (!entry) return Promise.reject(new Error("Нет такой игры"));
    if (loading[id]) return loading[id].p;
    let resolve, reject;
    const p = new Promise((a, b) => { resolve = a; reject = b; });
    loading[id] = { p, resolve, reject };
    const s = document.createElement("script");
    s.src = entry.file + (WG.version ? "?v=" + WG.version : "");
    s.onerror = () => { delete loading[id]; reject(new Error("Игра не загрузилась — проверьте связь")); };
    document.head.append(s);
    return p;
  };

  // WG.open("snake", {onExit}) shows the play screen: the start card (or the level picker), then the game
  WG.open = async function (id, opts) {
    build();
    R.opts = opts || {};
    const entry = WG.entry(id);
    R.entry = entry;
    R.state = "loading";
    R.inst = null;
    R.el.root.hidden = false;
    document.documentElement.classList.add("playing");
    R.el.title.firstChild.textContent = entry ? entry.title : "";
    R.el.title.lastChild.textContent = "";
    syncMute();
    cancelAnimationFrame(R.raf);
    R.last = performance.now();
    R.raf = requestAnimationFrame(frame);
    try {
      R.def = await WG.load(id);
    } catch (e) {
      showMessage("Не получилось открыть игру", e.message);
      return;
    }
    R.levels = (entry && entry.levels) || R.def.levels || ["normal"];
    R.level = R.opts.level && R.levels.includes(R.opts.level) ? R.opts.level : (WG.store.get("level." + id, null) || (R.levels.includes("normal") ? "normal" : R.levels[0]));
    if (!R.levels.includes(R.level)) R.level = R.levels[0];
    R.stages = (entry && entry.stages) || R.def.stages || 0;
    R.stage = R.stages ? WG.progress.next(WG.progress.local(id), R.stages) : null;
    if (R.stages && R.opts.stage !== undefined) R.stage = R.opts.stage;
    fit();
    newInstance();
    R.state = "start";
    if (R.rotated) showRotate(); else showStart();
  };
  const stageWord = () => (R.entry && R.entry.stageWord) || "Уровень";
  const stagesWord = () => (R.entry && R.entry.stagesWord) || "уровни";
  const endlessName = () => (R.entry && typeof R.entry.endless === "string" ? R.entry.endless : "Бесконечный");
  function makeApi() {
    const id = R.def.id, level = R.level;
    const api = {
      W, H, id, level, levelName: WG.levelName(level), input: Input,
      best: WG.bestOf(id, level),
      skill: level === "adaptive" ? WG.adaptive.get(id) : { easy: 0.15, normal: 0.45, hard: 0.75, master: 1 }[level],
      get time() { return R.time; },
      sfx: (n) => Sound.sfx(n), jingle: (n) => Sound.jingle(n), music: (s) => Sound.music(s), tone: (o) => Sound.tone(o),
      shake(px, sec) { R.shake = px; R.shakeT = R.shakeD = sec || 0.3; },
      flash(color, sec) { R.flashC = color || "#FFFFFF"; R.flashT = R.flashD = sec || 0.15; },
      end(result) { endGame(result || {}); },
      // stages: api.stage is the stage's number (1…api.stages), or null in the endless / single mode
      stage: R.stage || null, stages: R.stages || 0, mode: R.stage ? "stage" : R.stages ? "endless" : "single",
      clear(result) { clearStage(result || {}); },
      text: WG.text,
    };
    return api;
  }
  function newInstance() {
    if (R.inst && R.inst.destroy) try { R.inst.destroy(); } catch (e) { /* gone */ }
    R.time = 0; R.acc = 0; R.shakeT = 0; R.flashT = 0;
    Input.clear();
    R.api = makeApi();
    R.inst = R.def.create(R.api);
    R.el.title.lastChild.textContent = R.stages ? (R.stage ? stageWord() + " " + R.stage : endlessName()) : R.levels.length > 1 ? WG.levelName(R.level) : "";
  }
  function startPlay() {
    Sound.unlock();
    hideOverlay();
    WG.store.set("level." + R.def.id, R.level);
    if (R.state !== "start") newInstance();
    else if (R.api.level !== R.level || R.api.stage !== (R.stage || null)) newInstance();
    R.state = "play";
    R.last = performance.now();
    Input.clear();
    Sound.resume();
    if (R.def.music) Sound.music(R.def.music);
    if (R.inst.start) R.inst.start();
    R.el.canvas.focus && R.el.canvas.blur();
  }
  function pauseGame(silent) {
    if (R.state !== "play") return;
    R.state = "pause";
    Input.clear();
    if (!silent) Sound.sfx("pause");
    setTimeout(() => R.state === "pause" && Sound.suspend(), 260);
    if (R.inst.pause) R.inst.pause();
    showPause();
  }
  function resumeGame() {
    if (R.state !== "pause" || R.rotated) return;
    hideOverlay();
    Sound.resume();
    R.state = "play";
    R.last = performance.now();
    Input.clear();
    if (R.inst.resume) R.inst.resume();
  }
  function restart() {
    Sound.stopMusic();
    newInstance();
    R.state = "start";
    startPlay();
  }
  function exitGame() {
    Sound.stopMusic();
    if (R.inst && R.inst.destroy) try { R.inst.destroy(); } catch (e) { /* gone */ }
    R.inst = null; R.def = null; R.state = "idle";
    cancelAnimationFrame(R.raf);
    hideOverlay();
    Input.clear();
    if (R.el) R.el.root.hidden = true;
    document.documentElement.classList.remove("playing");
    if (R.opts.onExit) R.opts.onExit(R.result || null, !!R.opts.wantLogin);
    R.result = null;
  }
  WG.close = function () { if (R.state !== "idle") { const f = R.opts.onExit; R.opts.onExit = null; exitGame(); R.opts.onExit = f; } };

  // ---------- the shared screens ----------
  function showOverlay(kind, panel, back) {
    const ov = R.el.ov;
    ov.replaceChildren(panel);
    ov.hidden = false;
    ov.className = "ov ov-" + kind;
    R.ovKind = kind;
    R.ovBack = back || null;
    const f = panel.querySelector("[data-focus]") || panel.querySelector("[data-primary]");
    if (f) setTimeout(() => f.focus({ preventScroll: true }), 30);
  }
  function hideOverlay() {
    if (!R.el) return;
    R.el.ov.hidden = true;
    R.el.ov.replaceChildren();
    R.ovKind = null; R.ovBack = null;
  }
  const btn = (text, ic, onclick, cls, extra) => el("button", Object.assign({ class: "btn " + (cls || "line"), "data-nav": "", onclick: () => { Sound.sfx(cls === "primary" ? "confirm" : "select"); onclick(); } }, extra || {}), ic ? icon(ic) : null, el("span", { text }));

  function levelIcon(l) {
    const L = WG.LEVELS[l] || { bars: 2 };
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "i lvl"); s.setAttribute("aria-hidden", "true");
    if (!L.bars) {
      s.innerHTML = '<path d="M3 15c2.5 0 2.5-6 5-6s2.5 6 5 6 2.5-6 5-6 2.5 3 3 3"/>';
    } else {
      let d = "";
      for (let i = 0; i < 4; i++) d += `<path class="${i < L.bars ? "on" : "off"}" d="M${5 + i * 4.7} 19V${15 - i * 3.3}"/>`;
      s.innerHTML = d;
    }
    return s;
  }
  function gameHead(entry) {
    const head = el("div", { class: "ov-head" });
    head.append(WG.ui.pixelTitle(entry.title.toUpperCase(), { color: R.def.titleColors || ["#D2FAFF", "#D2FAFF", "#7FE6F4", "#7FE6F4", "#34D399", "#34D399", "#1FA874"], shadow: "#05291C", cls: "big" }));
    return head;
  }
  // ---------- stages: the map of stages with stars and locks ----------
  function showStages() {
    const entry = R.entry, def = R.def, N = R.stages;
    const panel = el("div", { class: "panel stages", role: "dialog", "aria-modal": "true", "aria-label": entry.title });
    panel.append(gameHead(entry));
    const sum = el("p", { class: "ov-text stage-sum" });
    const grid = el("div", { class: "stage-grid", role: "list", "aria-label": stagesWord() });
    const btns = el("div", { class: "ov-btns" });
    const paint = (p) => {
      const nx = WG.progress.next(p, N);
      const passed = Object.keys(p.stages).filter((k) => +k <= N).length;
      sum.replaceChildren("Пройдено ", el("b", { text: passed + " из " + N }), " · ", el("span", { class: "star-n", text: "★ " + WG.progress.totalStars(p) + " из " + N * 3 }));
      const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.stage : null;
      grid.replaceChildren();
      for (let n = 1; n <= N; n++) {
        const open = WG.progress.unlocked(p, n), st = p.stages[n] || 0;
        const tile = el("button", { class: "stile" + (st ? " done" : "") + (open ? "" : " locked") + (n === nx && open && !st ? " next" : ""), role: "listitem",
          "data-nav": "", "data-grid": "", "data-stage": n, disabled: open ? null : true,
          "aria-label": stageWord() + " " + n + (open ? (st ? ", " + st + " из 3 звёзд" : ", ещё не пройден") : ", закрыт"),
          onclick: () => { R.stage = n; Sound.sfx("confirm"); startPlay(); } },
        el("b", { text: String(n) }), open ? WG.ui.stars(st) : icon("lock", "lock"));
        grid.append(tile);
      }
      btns.replaceChildren(
        btn((Object.keys(p.stages).length ? "Дальше: " : "Начать: ") + stageWord().toLowerCase() + " " + nx, "play", () => { R.stage = nx; startPlay(); }, "primary", { "data-primary": "" }),
        entry.endless ? btn(endlessName(), "infinity", () => { R.stage = null; startPlay(); }) : null,
        btn("К играм", "back", exitGame));
      const again = focused && grid.querySelector('[data-stage="' + focused + '"]:not([disabled])');
      if (again) again.focus({ preventScroll: true });
    };
    panel.append(sum, grid);
    if (R.levels.length > 1 && (entry.levelPick || def.levelPick) !== "game") panel.append(levelSeg());  // (a game with its own: "game")
    const th = typeof def.touchHowto === "function" ? def.touchHowto(R.layout || {}) : def.touchHowto;
    if (def.howto) panel.append(el("p", { class: "ov-keys", text: def.howto }));
    const hint = coarse() ? th || def.keysHint : def.keysHint;
    if (hint) panel.append(el("p", { class: "ov-keys", text: hint }));
    panel.append(btns);
    paint(WG.progress.local(def.id));
    showOverlay("start", panel, exitGame);
    WG.progress.get(def.id).then((p) => { if (R.ovKind === "start" && R.el.ov.contains(panel)) paint(p); }, () => {});
  }
  // the level against the computer on the stage map: one row, the stages and the endless board both play at it
  function levelSeg() {
    const seg = el("div", { class: "seg", role: "radiogroup", "aria-label": "Уровень" });
    for (const l of R.levels) {
      const b = el("button", { class: l === R.level ? "on" : "", role: "radio", "aria-checked": l === R.level ? "true" : "false", "data-nav": "",
        title: (WG.LEVELS[l] || {}).hint || "",
        onclick: () => {
          R.level = l; WG.store.set("level." + R.def.id, l); Sound.sfx("select");
          for (const x of seg.children) { const on = x === b; x.classList.toggle("on", on); x.setAttribute("aria-checked", on ? "true" : "false"); }
        } }, WG.levelName(l));
      seg.append(b);
    }
    return el("div", { class: "seg-wrap stage-level" }, el("small", { class: "seg-label", text: "Уровень соперников" }), seg);
  }
  function showStart() {
    if (R.stages) return showStages();
    const entry = R.entry, def = R.def;
    const panel = el("div", { class: "panel", role: "dialog", "aria-modal": "true", "aria-label": entry.title });
    panel.append(gameHead(entry));
    if (def.howto) panel.append(el("p", { class: "ov-text", text: def.howto }));
    if (R.levels.length > 1) {
      const list = el("div", { class: "levels", role: "radiogroup", "aria-label": "Уровень" });
      for (const l of R.levels) {
        const best = WG.bestOf(def.id, l);
        const row = el("button", { class: "lrow" + (l === R.level ? " on" : ""), role: "radio", "aria-checked": l === R.level ? "true" : "false", "data-nav": "", "data-focus": l === R.level ? "" : null,
          onclick: () => { R.level = l; for (const r of list.children) { const on = r === row; r.classList.toggle("on", on); r.setAttribute("aria-checked", on ? "true" : "false"); } } },
        el("span", { class: "well" }, levelIcon(l)),
        el("span", { class: "lwords" }, el("b", { text: WG.levelName(l) }), el("small", { text: (WG.LEVELS[l] || {}).hint || "" })),
        best !== null ? el("span", { class: "lbest" }, el("b", { text: WG.fmtNum(best) }), el("small", { text: "твой лучший" })) : null);
        list.append(row);
      }
      panel.append(list);
    } else if (WG.guest || !WG.signedIn()) {
      panel.append(el("p", { class: "ov-keys", text: "Игра без рейтинга — результат не сохранится." }));
    } else {
      const byTime = entry.rank === "time";
      const best = WG.bestOf(def.id, R.level);
      const bestMs = WG.me && WG.me.bestMs && WG.me.bestMs[def.id] ? WG.me.bestMs[def.id][R.level] : null;
      const fame = (WG.fame || []).find((f) => f.game === def.id);
      const facts = el("div", { class: "facts" });
      facts.append(el("div", { class: "fact" }, el("small", { text: byTime ? "Твоё лучшее время" : "Твой лучший" }), el("b", { text: byTime ? (bestMs ? WG.fmtTime(bestMs) : "—") : best !== null ? WG.fmtNum(best) : "—" })));
      if (fame) facts.append(el("div", { class: "fact" }, el("small", { text: "Рекорд семьи" }), el("b", { text: byTime ? WG.fmtTime(fame.ms) : WG.fmtNum(fame.score) }), el("span", { text: fame.name })));
      panel.append(facts);
    }
    const th = typeof def.touchHowto === "function" ? def.touchHowto(R.layout || {}) : def.touchHowto;
    const hint = coarse() ? th || def.keysHint : def.keysHint;
    if (hint) panel.append(el("p", { class: "ov-keys", text: hint }));
    panel.append(el("div", { class: "ov-btns" },
      btn("Играть", "play", startPlay, "primary", { "data-primary": "", "data-focus": R.levels.length > 1 ? null : "" }),
      btn("К играм", "back", exitGame)));
    showOverlay("start", panel, exitGame);
  }
  function showPause() {
    const panel = el("div", { class: "panel slim", role: "dialog", "aria-modal": "true", "aria-label": "Пауза" });
    panel.append(el("div", { class: "ov-head" }, WG.ui.pixelTitle("ПАУЗА", { color: "#EAF0FA", shadow: "#05291C", cls: "big" })));
    panel.append(el("div", { class: "ov-btns col" },
      btn("Продолжить", "play", resumeGame, "primary", { "data-primary": "" }),
      btn("Заново", "refresh", restart),
      btn("К играм", "back", exitGame)));
    showOverlay("pause", panel, resumeGame);
  }
  function showRotate() {
    const panel = el("div", { class: "panel slim rotate", role: "dialog", "aria-modal": "true", "aria-label": "Поверните телефон" },
      el("div", { class: "rot-ic" }, icon("rotate")),
      el("p", { class: "ov-title", text: "Поверните телефон боком" }),
      el("p", { class: "ov-text", text: "Эта игра — для широкого экрана." }),
      el("div", { class: "ov-btns" }, btn("К играм", "back", exitGame)));
    showOverlay("rotate", panel, exitGame);
  }
  function showMessage(title, text) {
    const panel = el("div", { class: "panel slim", role: "alertdialog", "aria-modal": "true" },
      el("p", { class: "ov-title", text: title }), el("p", { class: "ov-text", text }),
      el("div", { class: "ov-btns" }, btn("К играм", "back", exitGame, "primary", { "data-primary": "" })));
    showOverlay("msg", panel, exitGame);
  }

  function clearStage(res) {
    if (R.state !== "play" || !R.stage) return;
    R.state = "over";
    Sound.stopMusic();
    const id = R.def.id, stage = R.stage, stars = clamp(Math.round(res.stars || 1), 1, 3);
    const ms = Math.round(res.ms !== undefined ? res.ms : R.time * 1000);
    R.result = { game: id, stage, stars, ms, score: Math.round(res.score || 0) };
    Sound.sfx("win");
    const before = WG.progress.local(id).stages[stage] || 0;
    showCleared({ res, stage, stars, ms, before });
    WG.progress.save(id, stage, stars).catch(() => {});
  }
  function showCleared(o) {
    const { res, stage, stars, ms, before } = o;
    const last = stage >= R.stages;
    const panel = el("div", { class: "panel slim cleared", role: "dialog", "aria-modal": "true", "aria-label": stageWord() + " " + stage + " пройден" });
    panel.append(el("div", { class: "ov-head" }, WG.ui.pixelTitle((stageWord() + " " + stage + " пройден" + (stageWord().endsWith("а") ? "а" : stageWord().endsWith("е") ? "о" : "") + "!").toUpperCase(),
      { color: ["#FFF0C2", "#FFF0C2", "#FFD27A", "#FFD27A", "#FFD27A", "#C98A1B", "#C98A1B"], shadow: "#2A1E00", cls: "big" })));
    const big = WG.ui.stars(stars, 0, "big");
    [...big.children].forEach((c, i) => { c.style.animationDelay = 0.25 + i * 0.3 + "s"; if (i < stars) setTimeout(() => R.ovKind === "cleared" && Sound.tone({ w: "p25", f: [880, 1175, 1568][i], d: 0.08, v: 0.16, sus: 0.5, r: 0.08 }), 250 + i * 300); });
    panel.append(big);
    const line = [res.score ? WG.fmtNum(res.score) + " " + plural(res.score, "очко", "очка", "очков") : "", WG.fmtTime(ms)].filter(Boolean).join(" · ");
    panel.append(el("p", { class: "ov-text", text: res.line || line }));
    const notes = [];
    if (before && stars > before) notes.push("Лучше прежнего: было " + "★".repeat(before) + "☆".repeat(3 - before));
    if (stars < 3 && res.hint) notes.push(res.hint);
    if (last && !before) notes.push("Все " + stagesWord() + " пройдены!");
    if (WG.guest || !WG.signedIn()) notes.push("Без входа прогресс хранится только на этом устройстве.");
    if (notes.length) panel.append(el("p", { class: "status", text: notes.join(" · ") }));
    const btns = el("div", { class: "ov-btns" });
    if (!last) btns.append(btn("Дальше: " + stageWord().toLowerCase() + " " + (stage + 1), "play", () => { R.stage = stage + 1; restart(); }, "primary", { "data-primary": "" }));
    else if (R.entry.endless) btns.append(btn(endlessName(), "infinity", () => { R.stage = null; restart(); }, "primary", { "data-primary": "" }));
    btns.append(btn("Ещё раз", "refresh", restart, last && !R.entry.endless ? "primary" : "line", last && !R.entry.endless ? { "data-primary": "" } : null));
    btns.append(btn("Все " + stagesWord(), "grid", toStages));
    panel.append(btns);
    showOverlay("cleared", panel, toStages);
  }
  function toStages() { Sound.stopMusic(); newInstance(); R.state = "start"; showStages(); }
  function showNotCleared(res, ms) {
    const panel = el("div", { class: "panel slim", role: "dialog", "aria-modal": "true", "aria-label": stageWord() + " не пройден" });
    panel.append(el("div", { class: "ov-head" }, WG.ui.pixelTitle("НЕ ПОЛУЧИЛОСЬ", { color: ["#EAF0FA", "#EAF0FA", "#EAF0FA", "#A9B6CD", "#A9B6CD", "#A9B6CD", "#7F8FB8"], shadow: "#05291C", cls: "big" })));
    panel.append(el("p", { class: "ov-text", text: res.line || stageWord() + " " + R.stage + " · " + WG.fmtTime(ms) }));
    if (res.hint) panel.append(el("p", { class: "status", text: res.hint }));
    panel.append(el("div", { class: "ov-btns" },
      btn("Ещё раз", "refresh", restart, "primary", { "data-primary": "" }),
      btn("Все " + stagesWord(), "grid", toStages),
      btn("К играм", "back", exitGame)));
    showOverlay("results", panel, toStages);
  }
  function endGame(res) {
    if (R.state !== "play") return;
    if (R.stage) { // a stage ended without being cleared
      R.state = "over"; Sound.stopMusic(); Sound.sfx("lose");
      R.result = null;
      showNotCleared(res, Math.round(res.ms !== undefined ? res.ms : R.time * 1000));
      return;
    }
    R.state = "over";
    Sound.stopMusic();
    const id = R.def.id, level = R.level;
    const byTime = R.entry && R.entry.rank === "time";
    const score = Math.max(0, Math.round(res.score || 0));
    const ms = Math.round(res.ms !== undefined ? res.ms : R.time * 1000);
    if (level === "adaptive" && res.won !== undefined) WG.adaptive.report(id, !!res.won);
    const prev = WG.bestOf(id, level);
    const prevMs = WG.me && WG.me.bestMs && WG.me.bestMs[id] ? WG.me.bestMs[id][level] : null;
    // a time-ranked game (patience, minesweeper) is a record when it is finished (score ≥ 1) faster than before
    let record = byTime ? score > 0 && (prevMs === null || prevMs === undefined || ms < prevMs) : score > 0 && (prev === null || score > prev);
    R.result = { game: id, level, score, ms };
    const base = { res, score, ms, prev, prevMs, record, byTime };
    if (WG.guest || !WG.signedIn()) {
      Sound.sfx(res.won ? "win" : "gameover");
      showResults(Object.assign(base, { record: false, guest: true }));
      return;
    }
    Sound.sfx(record ? "record" : res.won ? "win" : "gameover");
    showResults(Object.assign({}, base, { saving: true }));
    const post = () => WG.api("/api/games/score", { game: id, level, score, ms, meta: res.meta || {} }).then((r) => {
      if (!WG.me) WG.me = { user: { name: "" }, best: {}, bestMs: {} };
      const b = WG.me.best[id] = WG.me.best[id] || {};
      const best = typeof r.best === "number" ? r.best : r.best && typeof r.best[level] === "number" ? r.best[level] : Math.max(score, prev || 0);
      b[level] = byTime ? best : Math.max(best, b[level] || 0);
      if (typeof r.best_ms === "number") { WG.me.bestMs = WG.me.bestMs || {}; (WG.me.bestMs[id] = WG.me.bestMs[id] || {})[level] = r.best_ms; }
      if (typeof r.new === "boolean") record = r.new;
      if (R.state === "over") showResults(Object.assign({}, base, { record, top: r.top || [], rank: r.rank, best: b[level], bestMs: r.best_ms }));
    }, (e) => {
      if (R.state === "over") showResults(Object.assign({}, base, { error: e, retry: post }));
    });
    setTimeout(post, 350);
  }
  function showResults(o) {
    const { res, score, ms, record, byTime } = o;
    const outer = el("div", { class: "panel results", role: "dialog", "aria-modal": "true", "aria-label": "Итоги" });
    const panel = el("div", { class: "res-main" });
    const cols = el("div", { class: "res-cols" }, panel);
    outer.append(cols);
    const head = res.title || (record ? "НОВЫЙ РЕКОРД!" : res.won === true ? "ПОБЕДА!" : res.won === false ? "ПОРАЖЕНИЕ" : "ИГРА ОКОНЧЕНА");
    panel.append(el("div", { class: "ov-head" }, WG.ui.pixelTitle(head, {
      color: record ? ["#FFF0C2", "#FFF0C2", "#FFD27A", "#FFD27A", "#FFD27A", "#C98A1B", "#C98A1B"] : ["#EAF0FA", "#EAF0FA", "#EAF0FA", "#A9B6CD", "#A9B6CD", "#A9B6CD", "#7F8FB8"],
      shadow: record ? "#2A1E00" : "#05291C", cls: "big" })));
    const levelPart = R.levels.length > 1 ? " · " + WG.levelName(R.level) : "";
    panel.append(el("div", { class: "score" + (record ? " rec" : "") },
      el("b", { text: byTime ? WG.fmtTime(ms) : WG.fmtNum(score) }),
      el("span", { text: (byTime ? (score > 0 ? "пройдено" : "не пройдено") : plural(score, "очко", "очка", "очков") + " · " + WG.fmtTime(ms)) + levelPart })));
    const status = el("p", { class: "status", role: "status" });
    if (o.guest) status.textContent = "Без рейтинга: результат не сохраняется. Войдите, чтобы попасть в рейтинг семьи.";
    else if (o.saving) status.append(el("span", { class: "spin", "aria-hidden": "true" }), "Сохраняю результат…");
    else if (o.error) {
      status.classList.add("bad");
      status.append(o.error.kind === "login" ? "Не сохранилось: нужно войти заново." : o.error.kind === "off" ? "Не сохранилось: игры для этого входа выключены." : o.error.kind === "net" ? "Не сохранилось: нет связи с сервером." : "Не сохранилось: " + o.error.message);
    } else {
      const parts = [];
      if (o.rank) parts.push(WG.place(o.rank) + " в семье");
      if (!record && byTime && o.bestMs) parts.push("твоё лучшее время — " + WG.fmtTime(o.bestMs));
      else if (!record && !byTime && o.best) parts.push("твой лучший — " + WG.fmtNum(o.best));
      if (record && byTime && o.prevMs) parts.push("было " + WG.fmtTime(o.prevMs));
      else if (record && !byTime && o.prev !== null && o.prev !== undefined) parts.push("было " + WG.fmtNum(o.prev));
      status.textContent = parts.join(" · ") || "Сохранено";
    }
    panel.append(status);
    if (o.top && o.top.length) {
      cols.append(el("div", { class: "res-side" },
        el("p", { class: "board-h", text: "Лучшие в семье" + levelPart }),
        WG.ui.board(o.top.slice(0, 5), { compact: true, rank: byTime ? "time" : "score" })));
    }
    const btns = el("div", { class: "ov-btns" });
    if (o.error && o.retry && o.error.kind !== "login" && o.error.kind !== "off") btns.append(btn("Повторить", "refresh", () => { showResults(Object.assign({}, o, { error: null, saving: true })); o.retry(); }));
    btns.append(btn("Ещё раз", "refresh", restart, "primary", { "data-primary": "" }));
    if (R.levels.length > 1) btns.append(btn("Уровень", "list", () => { newInstance(); R.state = "start"; showStart(); }));
    if (o.guest || (o.error && o.error.kind === "login")) btns.append(btn("Войти", "key", () => { R.opts.wantLogin = true; exitGame(); }));
    btns.append(btn("К играм", "back", exitGame));
    outer.append(btns);
    showOverlay("results", outer, exitGame);
  }
  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }
  WG.plural = plural;
})();
