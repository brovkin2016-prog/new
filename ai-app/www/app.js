/* ИИ-помощник: the app's screens. The same page runs in the Android app (network through window.AIBridge, which
   speaks HTTP/3 to the server) and in a browser (plain fetch). Conversations are kept on the phone in IndexedDB. */
"use strict";
(function () {
  const Native = window.AIBridge || null;
  // a part that is not there (cond ? el(…) : null) is left out, not shown as the word «null»
  const nativeAppend = Element.prototype.append;
  Element.prototype.append = function (...parts) {
    return nativeAppend.apply(this, parts.filter((x) => x !== null && x !== undefined && x !== false));
  };
  const $ = (s, root) => (root || document).querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "html") n.innerHTML = v;
      else if (k === "icon") n.append(icon(v));  // the sprite's icon, before the words
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid.nodeType ? kid : String(kid));
    return n;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- network ----------
  let seq = 0;
  const pending = {};
  window.__aiNet = function (id, type, a) {
    const p = pending[id];
    if (!p) return;
    if (type === "head") p.head(+a);
    else if (type === "data") p.data(fromB64(a));
    else if (type === "end") { delete pending[id]; p.end(); }
    else if (type === "fail") { delete pending[id]; p.fail(new Error(a || "net")); }
  };
  // one-shot answers from the phone (signing in to the hosting, its balance)
  const calls = {};
  window.__aiCall = function (id, ok, text) {
    const c = calls[id];
    if (c) { delete calls[id]; c({ ok, text }); }
  };
  function nativeCall(name) {
    return new Promise((resolve) => { const id = "c" + ++seq; calls[id] = resolve; window.AIBridge[name](id); });
  }
  function fromB64(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function headers() {
    const h = { "Content-Type": "application/json" };
    const t = store.get("token", "");
    if (t) h.Authorization = "Bearer " + t;
    return h;
  }
  // ctl (optional): ctl.cancel() is set to give the request up — the phone's part then fails it at once (its own
  // connection ends by its own timeout; what it still says is not listened to)
  function send(path, body, onStatus, onBytes, extra, ctl) {
    const h = Object.assign(headers(), extra || {});
    if (Native) {
      return new Promise((resolve, reject) => {
        const id = "r" + (++seq);
        pending[id] = { head: onStatus, data: onBytes, end: resolve, fail: reject };
        if (ctl) ctl.cancel = () => {
          if (!pending[id]) return;
          delete pending[id];
          try { if (Native.cancel) Native.cancel(id); } catch (e) { /* an older app */ }
          reject(new Error("stalled"));
        };
        Native.request(id, path, JSON.stringify(h), body === null ? "" : body);
      });
    }
    const ac = typeof AbortController === "function" ? new AbortController() : null;
    if (ctl && ac) ctl.cancel = () => ac.abort();
    return fetch(path, { method: body === null ? "GET" : "POST", headers: h, body: body === null ? undefined : body, signal: ac ? ac.signal : undefined })
      .then(async (r) => {
        onStatus(r.status);
        if (!r.body || !r.body.getReader) { onBytes(new Uint8Array(await r.arrayBuffer())); return; }
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          onBytes(value);
        }
      }, () => { throw new Error("net"); });
  }
  class HttpError extends Error {
    constructor(status, text) {
      super(text || (status >= 500 ? "Сервер сейчас не отвечает — попробуйте через минуту." : status === 413 ? "Файл слишком большой."
        : "Что-то пошло не так — попробуйте ещё раз."));
      this.status = status;
    }
  }
  function bytesToText(parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const all = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    return new TextDecoder().decode(all);
  }
  async function api(path, body) {
    let status = 0;
    const parts = [];
    await send(path, body === null ? null : JSON.stringify(body || {}), (s) => (status = s), (b) => parts.push(b));
    let js = {};
    try { js = JSON.parse(bytesToText(parts) || "{}"); } catch (e) { /* not json */ }
    if (status !== 200) throw new HttpError(status, js.error);
    return js;
  }
  // a pause that ends at once when the phone's internet comes back
  function nap(ms) {
    return new Promise((r) => {
      const done = () => { clearTimeout(t); window.removeEventListener("online", done); r(); };
      const t = setTimeout(done, ms);
      window.addEventListener("online", done);
    });
  }
  const STALL_MS = 40000;  // nothing at all for this long once the answer began (the server pings every 15 s): a dead line
  async function stream(path, body, onEvent) {
    let status = 0, buf = "", last = null, heard = 0;
    const errParts = [];
    const dec = new TextDecoder();
    const ctl = {};
    const watch = setInterval(() => { if (heard && Date.now() - heard > STALL_MS && ctl.cancel) ctl.cancel(); }, 5000);
    await send(path, JSON.stringify(body), (s) => { status = s; heard = Date.now(); }, (b) => {
      heard = Date.now();
      if (status !== 200) { errParts.push(b); return; }
      buf += dec.decode(b, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          let ev;
          try { ev = JSON.parse(line.slice(6)); } catch (e) { continue; }
          if (["done", "error", "quota"].includes(ev.t)) last = ev;
          try { onEvent(ev); } catch (e) { console.error(e); }
        }
      }
    }, null, ctl).catch((e) => { e.started = status === 200; throw e; })  // started: the server took it (else it may never have got there)
      .finally(() => clearInterval(watch));
    if (status !== 200) {
      let js = {};
      try { js = JSON.parse(bytesToText(errParts)); } catch (e) { /* not json */ }
      throw new HttpError(status, js.error);
    }
    if (!last) throw Object.assign(new Error("net"), { started: true });
    return last;
  }
  // a big answer (a clip, a picture) kept on the server: fetched in pieces, and a piece the line broke continues where
  // it stopped instead of from the start (one number's answer never changes, so the pieces always fit)
  const pieces = {};
  async function fetchResult(rid, size, onProgress) {
    const p = pieces[rid] || (pieces[rid] = { parts: [], got: 0 });
    for (let tries = 0; tries < 6; tries++) {
      let status = 0;
      const before = p.got;
      try {
        await send("/api/result?rid=" + rid, null, (s) => {
          status = s;
          if (s === 200) { p.parts = []; p.got = 0; }  // the whole of it after all
        }, (b) => {
          if (status !== 200 && status !== 206) return;
          p.parts.push(b);
          p.got += b.length;
          if (onProgress) onProgress(Math.min(99, Math.floor((p.got / size) * 100)));
        }, p.got ? { Range: "bytes=" + p.got + "-" } : null);
      } catch (e) { /* the line broke: what came is kept */ }
      if (status === 404 || status === 401 || status === 403) { delete pieces[rid]; throw new HttpError(status, status === 404 ? "Ответ уже не найти — спросите ещё раз." : ""); }
      if (p.got >= size && (status === 200 || status === 206 || status === 416)) {
        delete pieces[rid];
        return JSON.parse(bytesToText(p.parts));
      }
      if (p.got > before) tries = -1;  // a piece came: the line works, only a break — the count starts afresh
      await new Promise((r) => setTimeout(r, 1500 * Math.max(1, tries + 1)));
    }
    throw new Error("net");
  }
  // what broke on the way to the server, from the phone's network stack, in plain words
  function netWhy(m) {
    m = String(m || "");
    const words = [
      [/timeout|TIMED_OUT/, "сервер не ответил вовремя"],
      [/NAME_NOT_RESOLVED|NAME_RESOLUTION/, "имя сервера не находится"],
      [/INTERNET_DISCONNECTED/, "на телефоне нет интернета"],
      [/NETWORK_CHANGED/, "сеть телефона сменилась"],
      [/CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_ABORTED|EMPTY_RESPONSE/, "связь обрывается по дороге к серверу"],
      [/CONNECTION_REFUSED/, "сервер не принимает соединение"],
      [/ADDRESS_UNREACHABLE|NETWORK_ACCESS_DENIED|PROXY|TUNNEL/, "сервер недоступен из этой сети"],
      [/CERT|SSL|QUIC_HANDSHAKE/, "сеть вмешивается в защищённое соединение"],
    ];
    for (const [re, t] of words) if (re.test(m)) return t;
    const code = m.match(/net::ERR_[A-Z0-9_]+/);
    return code && ((S.me && S.me.panel) || store.get("wasOwner", false)) ? code[0] : "";  // the raw code: for the owner only
  }
  function problem(e) {
    if (e instanceof HttpError) {
      if (e.status === 401) { setTimeout(() => logout(e.message), 50); return e.message; }
      return e.message;
    }
    const why = netWhy(e && e.message);
    let s = "Нет связи с сервером" + (why ? ": " + why : "") + ". Проверьте интернет и попробуйте ещё раз.";
    // only the owner has bridges in Winger; through one the helper reaches the server where the network lets few sites
    if ((S.me && S.me.panel) || store.get("wasOwner", false)) {
      s += wingerOn() ? " Включаю Winger: он сам пойдёт через мост и возьмёт помощника с собой — через полминуты заработает."
        : " Если открываются только отдельные сайты — включите в Winger мост: помощник пойдёт через него сам.";
    }
    return s;
  }
  // the owner's phone, the server out of reach directly (its address shut by the provider on this network): Winger is
  // switched on — it goes over a bridge by itself and takes this app with it; at most once in 5 minutes
  let wingerAt = 0;
  function wingerOn() {
    if (Date.now() - wingerAt < 5 * 60000) return true;
    try {
      if (!Native || !Native.startWinger || Native.vpnOn() || !Native.wingerHere()) return false;
      wingerAt = Date.now();
      Native.startWinger();
      return true;
    } catch (e) { return false; }
  }

  // ---------- storage: messages of each thread ----------
  const DB = {
    db: null, mem: [], memId: 1,
    open() {
      return new Promise((resolve) => {
        let req;
        try { req = indexedDB.open("ai", 1); } catch (e) { resolve(); return; }
        req.onupgradeneeded = () => {
          const s = req.result.createObjectStore("msgs", { keyPath: "id", autoIncrement: true });
          s.createIndex("thread", "thread");
        };
        req.onsuccess = () => { this.db = req.result; resolve(); };
        req.onerror = () => resolve();
      });
    },
    tx(mode) { return this.db.transaction("msgs", mode).objectStore("msgs"); },
    // a write counts once its transaction is complete (a full phone aborts it after the request itself succeeded)
    write(op, m) {
      return new Promise((res) => {
        let t, r;
        try { t = this.db.transaction("msgs", "readwrite"); r = t.objectStore("msgs")[op](m); } catch (e) { this.full(e); res(0); return; }
        t.oncomplete = () => res(r.result);
        t.onabort = () => { this.full(t.error); res(0); };
      });
    },
    full(e) {
      if (this.told || !e || !/quota/i.test(e.name + " " + e.message)) return;
      this.told = true;
      toast("Память телефона почти заполнена — новые сообщения не сохраняются. Удалите ненужные чаты или файлы на телефоне.", 8000);
    },
    async add(m) {
      if (!this.db) { m.id = this.memId++; this.mem.push(m); return m.id; }
      const id = await this.write("add", m);
      if (id) m.id = id;
      return id;
    },
    put(m) {
      if (!this.db) return Promise.resolve();
      return this.write("put", m);
    },
    del(id) {
      if (!this.db) { this.mem = this.mem.filter((m) => m.id !== id); return Promise.resolve(); }
      return new Promise((res) => { const r = this.tx("readwrite").delete(id); r.onsuccess = r.onerror = () => res(); });
    },
    list(thread) {
      if (!this.db) return Promise.resolve(this.mem.filter((m) => m.thread === thread));
      return new Promise((res) => {
        const r = this.tx("readonly").index("thread").getAll(thread);
        r.onsuccess = () => res(r.result.sort((a, b) => a.id - b.id));
        r.onerror = () => res([]);
      });
    },
    wipe() {  // everything of this phone's person
      if (!this.db) { this.mem = []; return Promise.resolve(); }
      return new Promise((res) => { const r = this.tx("readwrite").clear(); r.onsuccess = r.onerror = () => res(); });
    },
    async clear(thread) {
      for (const m of await this.list(thread)) await this.del(m.id);
    },
    async trim(thread, keep) {
      const all = await this.list(thread);
      for (const m of all.slice(0, Math.max(0, all.length - keep))) await this.del(m.id);
    },
  };

  // ---------- text: markdown and school maths ----------
  const SUP = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "n": "ⁿ", "(": "⁽", ")": "⁾", "x": "ˣ" };
  const SUB = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "n": "ₙ" };
  const TEX = { cdot: "·", times: "×", div: "÷", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", pm: "±", mp: "∓",
    infty: "∞", pi: "π", alpha: "α", beta: "β", gamma: "γ", delta: "δ", Delta: "Δ", epsilon: "ε", varepsilon: "ε", theta: "θ",
    lambda: "λ", mu: "μ", rho: "ρ", sigma: "σ", Sigma: "Σ", phi: "φ", varphi: "φ", omega: "ω", Omega: "Ω", tau: "τ", nu: "ν",
    to: "→", rightarrow: "→", Rightarrow: "⇒", Leftrightarrow: "⇔", leftarrow: "←", iff: "⇔", implies: "⇒", angle: "∠",
    triangle: "△", perp: "⊥", parallel: "∥", in: "∈", notin: "∉", subset: "⊂", cup: "∪", cap: "∩", emptyset: "∅", forall: "∀",
    exists: "∃", int: "∫", iint: "∬", oint: "∮", sum: "∑", prod: "∏", partial: "∂", nabla: "∇", circ: "°", degree: "°", ldots: "…",
    dots: "…", cdots: "⋯", quad: " ", qquad: "  ", lt: "<", gt: ">", neg: "¬", land: "∧", lor: "∨", sim: "∼", equiv: "≡",
    propto: "∝", cong: "≅", Re: "ℜ", Im: "ℑ", mathbb: "", N: "ℕ", Z: "ℤ", Q: "ℚ", R: "ℝ" };
  function supOf(s, map) {
    return [...s].every((c) => map[c]) ? [...s].map((c) => map[c]).join("") : null;
  }
  function tidyMath(t) {
    if (!/[\\$^_]/.test(t)) return t;
    t = t.replace(/\$\$([\s\S]+?)\$\$/g, "$1").replace(/\\\[([\s\S]+?)\\\]/g, "$1").replace(/\\\(([\s\S]+?)\\\)/g, "$1")
      .replace(/(^|[^\\\w])\$([^$\n]+?)\$/g, "$1$2");
    for (let k = 0; k < 3; k++) {
      t = t.replace(/\\(?:d|t)?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (m, a, b) => {
        const p = (x) => (/^[\w.,²³√π]+$/.test(x) ? x : "(" + x + ")");
        return p(a) + "/" + p(b);
      });
      t = t.replace(/\\sqrt\s*\[([^\]]+)\]\s*\{([^{}]*)\}/g, (m, n, x) => (supOf(n, SUP) || n) + "√(" + x + ")")
        .replace(/\\sqrt\s*\{([^{}]*)\}/g, (m, x) => (/^[\w.]+$/.test(x) ? "√" + x : "√(" + x + ")"));
      t = t.replace(/\\(?:text|mathrm|mathbf|textbf|operatorname|mathit)\s*\{([^{}]*)\}/g, "$1");
    }
    t = t.replace(/\^\{\\circ\}|\^\\circ/g, "°").replace(/\\left|\\right|\\displaystyle|\\limits/g, "")
      .replace(/\\([{}%#&_ ])/g, "$1").replace(/\\[,;:!]/g, " ").replace(/\\\\/g, "\n");
    t = t.replace(/\\([A-Za-z]+)/g, (m, w) => (w in TEX ? TEX[w] : ["sin", "cos", "tan", "tg", "ctg", "cot", "log", "ln", "lg", "lim", "max", "min", "exp", "arcsin", "arccos", "arctg", "arctan"].includes(w) ? w : m));
    t = t.replace(/\^\{([^{}]{1,12})\}/g, (m, x) => supOf(x, SUP) || "^(" + x + ")").replace(/\^([0-9n+-])/g, (m, x) => SUP[x])
      .replace(/_\{([^{}]{1,12})\}/g, (m, x) => supOf(x, SUB) || "_" + x).replace(/(?<=[A-Za-zА-Яа-я])_([0-9n])/g, (m, x) => SUB[x]);
    return t;
  }
  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return "\u0000" + (codes.length - 1) + "\u0000"; });
    s = esc(tidyMath(s));
    s = s.replace(/(\d) (?=\d{3}(?!\d))/g, "$1\u00a0").replace(/(\d) (?=[₽%$€]|лет|руб)/g, "$1\u00a0");  // 10 000 ₽ not torn apart
    s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/__(.+?)__/g, "<b>$1</b>")
      .replace(/(^|[\s(«])\*(?!\s)(.+?)(?<!\s)\*(?=[\s).,!?:;»]|$)/g, "$1<i>$2</i>")
      .replace(/(^|[\s(«])_(?!\s)(.+?)(?<!\s)_(?=[\s).,!?:;»]|$)/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => "<code>" + esc(codes[+i]) + "</code>");
  }
  function md(src) {
    const lines = String(src || "").replace(/\r/g, "").split("\n");
    const out = [];
    let i = 0;
    const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
    const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push("<pre><code>" + esc(code.join("\n")) + "</code></pre>");
      } else if (/\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push("<table><tr>" + head.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr>" +
          rows.map((r) => "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") + "</table>");
      } else if (/^#{1,6}\s/.test(line)) {
        const level = line.match(/^#+/)[0].length;
        out.push((level <= 2 ? "<h3>" : "<h4>") + inline(line.replace(/^#+\s*/, "")) + (level <= 2 ? "</h3>" : "</h4>"));
        i++;
      } else if (/^\s*[-*•]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•]\s+/, ""));
        out.push("<ul>" + items.map((x) => "<li>" + inline(x) + "</li>").join("") + "</ul>");
      } else if (/^\s*\d+[.)]\s+/.test(line)) {
        const start = parseInt(line, 10);
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
        out.push('<ol start="' + start + '">' + items.map((x) => "<li>" + inline(x) + "</li>").join("") + "</ol>");
      } else if (/^\s*>/.test(line)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push("<blockquote>" + q.map(inline).join("<br>") + "</blockquote>");
      } else if (!line.trim()) {
        i++;
      } else {
        const p = [];
        while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|[-*•]\s+|\d+[.)]\s+|>)/.test(lines[i]) &&
               !(/\|/.test(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]))) p.push(lines[i++]);
        out.push("<p>" + p.map(inline).join("<br>") + "</p>");
      }
    }
    return out.join("");
  }
  const plain = (t) => tidyMath(String(t || "")).replace(/\*\*|__|`/g, "");

  // ---------- pictures, files, sound ----------
  function b64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",", 2)[1] || "");
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }
  function blobOf(b64s, mime) { return new Blob([fromB64(b64s)], { type: mime }); }
  async function shrink(blob, max, quality) {
    if (blob.type === "image/png" && blob.size < 8e6 && max > 2048) return blob;  // keep transparency for photo tools
    let bmp;
    try { bmp = await createImageBitmap(blob, { imageOrientation: "from-image" }); } catch (e) {
      try { bmp = await createImageBitmap(blob); } catch (e2) { return blob; }
    }
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob((b) => res(b || blob), "image/jpeg", quality));
  }
  const urls = new WeakMap();
  function urlOf(blob) {
    if (!urls.has(blob)) urls.set(blob, URL.createObjectURL(blob));
    return urls.get(blob);
  }
  function pickFile(accept, capture) {
    if (capture) store.set("shotTab", S.tab);  // Android may close the app while the camera is open: the shot comes here
    return new Promise((resolve) => {
      const inp = el("input", { type: "file", accept, capture: capture ? "environment" : null, class: "hidden" });
      inp.addEventListener("change", () => { resolve(inp.files && inp.files[0]); inp.remove(); });
      document.body.append(inp);
      inp.click();
    });
  }
  async function saveBlob(blob, name) {
    if (Native && Native.saveFile) {
      Native.saveFile(name, blob.type || "application/octet-stream", await b64(blob));
      return;
    }
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
  }
  async function shareBlob(blob, name, text) {
    if (Native && Native.shareFile) { Native.shareFile(name, blob.type, await b64(blob), text || ""); return; }
    const f = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [f] })) { navigator.share({ files: [f], text: text || "" }).catch(() => {}); return; }
    saveBlob(blob, name);
  }
  function copyText(t) {
    if (Native && Native.copy) Native.copy(t);
    else if (navigator.clipboard) navigator.clipboard.writeText(t).catch(() => {});
    toast("Скопировано");
  }

  // voice: 16 kHz mono WAV, which the server's recogniser reads directly
  const Rec = {
    on: false, starting: false, sid: 0,  // recording now; asking for the microphone now; which recording this is
    async start() {
      if (this.starting) throw new Error("busy");
      if (this.on) this.stop(false);  // one before still on (a screen closed while it listened): ended, not mixed in
      this.starting = true;
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      } finally { this.starting = false; }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.src = this.ctx.createMediaStreamSource(this.stream);
      this.node = this.ctx.createScriptProcessor(4096, 1, 1);
      this.chunks = [];
      this.node.onaudioprocess = (e) => this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      this.src.connect(this.node);
      this.node.connect(this.ctx.destination);
      this.t0 = Date.now();
      this.on = true;
      return ++this.sid;
    },
    stop(keep) {
      if (!this.on) return null;
      this.on = false;
      try { this.node.disconnect(); this.src.disconnect(); } catch (e) { /* already */ }
      this.stream.getTracks().forEach((t) => t.stop());
      const rate = this.ctx.sampleRate;
      this.ctx.close();
      const chunks = this.chunks;
      this.chunks = [];
      if (!keep) return null;
      let n = 0;
      for (const c of chunks) n += c.length;
      const all = new Float32Array(n);
      let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      const ratio = rate / 16000, len = Math.floor(n / ratio);
      const pcm = new Int16Array(len);
      for (let i = 0; i < len; i++) {
        const a = Math.floor(i * ratio), b = Math.min(n, Math.floor((i + 1) * ratio));
        let s = 0;
        for (let j = a; j < b; j++) s += all[j];
        const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
        pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf);
      const w = (o2, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o2 + i, s.charCodeAt(i)); };
      w(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true);
      dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, "data");
      dv.setUint32(40, pcm.length * 2, true);
      new Int16Array(buf, 44).set(pcm);
      return { blob: new Blob([buf], { type: "audio/wav" }), duration: len / 16000 };
    },
  };
  function playAudio(blob) {
    const a = new Audio(urlOf(blob));
    a.play().catch(() => {});
    return a;
  }

  // ---------- small UI helpers ----------
  // emoji some phones draw as plain black signs without the «picture» mark (U+FE0F): only this app's own words and the
  // server's labels in the family's screens get it (never everywhere: the owner's code matches its texts as they are)
  const emo = (s) => String(s).replace(/(🖼|🌫|🎞|🖌|🗑|🗂|🗣|🛡|🏖|↩|⏹)(?!️)/gu, "$1️");
  // the icons: one sprite in index.html (a 24px grid of strokes, shared with Winger). The sign a button's words began
  // with picks its icon: «📷 Снять фото» → the camera and «Снять фото»; a sign with no icon stays as it was
  const SVGNS = "http://www.w3.org/2000/svg";
  function icon(name) {
    const s = document.createElementNS(SVGNS, "svg"), u = document.createElementNS(SVGNS, "use");
    s.setAttribute("class", "i");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("focusable", "false");
    u.setAttribute("href", "#i-" + name);
    u.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", "#i-" + name);  // (older WebViews)
    s.appendChild(u);
    return s;
  }
  const ICONS = { "⏰": "alarm", "🗣": "translate", "🎉": "cake", "✉": "letter", "💬": "reply", "🍳": "pot", "🧒": "bulb", "💡": "bulb",
    "📋": "copy", "🎁": "gift", "📣": "megaphone", "🧳": "suitcase", "🔎": "search", "🔍": "search", "✨": "sparkle", "🪄": "wand",
    "⬜": "square", "🌫": "fog", "🙂": "smile", "👴": "restore", "🎨": "palette", "📑": "scan", "⬛": "contrast", "🎞": "film", "🌈": "sun",
    "✏": "pen", "✍": "pen", "🖍": "crayon", "🎭": "smile", "🖼": "photo", "🖌": "brush", "🦸": "smile", "🎬": "film", "🔥": "flame",
    "📸": "people", "🧰": "more", "📷": "camera", "📄": "doc", "📝": "doc", "🌐": "globe", "📚": "study", "🧮": "calc", "🎌": "brush",
    "🧸": "smile", "🌻": "brush", "🏖": "sun", "🚶": "user-x", "⏱": "timer", "📖": "study", "✕": "x", "🔑": "key", "🗂": "history", "➕": "plus",
    "🧹": "sweep", "⬇": "download", "📤": "share", "🔊": "speaker", "✂": "scissors", "🔄": "refresh", "↩": "undo", "🗑": "trash",
    "🔔": "bell", "📌": "pin", "⏹": "stop", "🎤": "mic", "➤": "send", "🎮": "gamepad" };
  // the ready tasks by their key (the server's signs: «📋 План» is a plan, not «copy»)
  const IDEA_ICONS = { congrats: "cake", letter: "letter", reply: "reply", recipe: "pot", explain: "bulb", plan: "list", gift: "gift",
    post: "megaphone", trip: "suitcase", check: "search" };
  const iconOf = (e) => ICONS[String(e || "").replace(/[️‍]/g, "")] || "";
  function lead(text) {
    const s = String(text), i = s.indexOf(" "), name = iconOf(i > 0 ? s.slice(0, i) : s);
    if (!name) return [s];
    const rest = i > 0 ? s.slice(i + 1) : "";
    return rest ? [icon(name), el("span", { text: rest })] : [icon(name)];
  }
  // a well with the icon for a sign (or the sign itself when there is no icon for it)
  const well = (cls, sign, name) => el("span", { class: cls }, name || iconOf(sign) ? icon(name || iconOf(sign)) : sign || "•");
  function toast(text, ms) {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    const t = el("div", { class: "toast", role: "status", text });
    document.body.append(t);
    setTimeout(() => t.remove(), ms || Math.min(7000, 1800 + String(text || "").length * 45));
  }
  function sheet(title, build, dismissed) {  // (v40) dismissed: called when it is closed with no choice (×, outside, Back)
    const bg = el("div", { class: "sheet-bg" });
    const close = () => bg.remove();
    const dismiss = () => { if (!bg.isConnected) return; close(); if (dismissed) dismissed(); };
    if (dismissed) bg.close = dismiss;  // the phone's Back button (__aiBack) closes it this way too
    const box = el("div", { class: "sheet" }, el("div", { class: "sheet-head" }, title ? el("h2", { text: title }) : el("span", { style: "flex:1" }),
      el("button", { class: "sheet-x", "aria-label": "Закрыть", onclick: dismiss }, icon("x"))));
    bg.addEventListener("click", (e) => { if (e.target === bg) dismiss(); });
    build(box, close);
    bg.append(box);
    document.body.append(bg);
    return close;
  }
  // a list to choose from: [icon, words, action] items; a plain string is a section's name
  function menu(title, items, dismissed) {
    sheet(title, (box, close) => {
      const list = el("div", { class: "list" });
      for (const it of items) {
        if (!it) continue;
        if (typeof it === "string") { list.append(el("div", { class: "menu-sec", text: it })); continue; }
        list.append(el("button", { onclick: () => { close(); it[2](); } },
          it[0] instanceof Node ? el("span", { class: "ic" }, it[0]) : well("ic", it[0]), el("span", { text: it[1] })));
      }
      box.append(list);
    }, dismissed);
  }
  // a row of a tool: «🪄 Убрать фон» — the icon in its well and the words (the words last: fitTools() measures them);
  // name: an icon chosen by the caller rather than by the sign
  function tool(text, onclick, name) {
    const s = emo(text), i = s.indexOf(" ");
    return el("button", { class: "tool", onclick }, well("ic", i > 0 ? s.slice(0, i) : "", name), el("span", { text: i > 0 ? s.slice(i + 1) : s }));
  }
  // the tiles in a grid: two a row while every word fits its tile, else one a row. The CSS (9.6em columns) does it where
  // a large system font grows «em»; Android's text zoom may grow only the letters, so the words themselves are measured
  // too — whenever the grid is first shown and when its size or its words' size changes («Переводчик», never «Переводчи/к»)
  const toolsSeen = typeof ResizeObserver === "function" ? new ResizeObserver((es) => {
    const grids = new Set(es.map((e) => e.target.closest(".tools") || e.target));
    requestAnimationFrame(() => grids.forEach(fitTools));
  }) : null;
  const toolWords = (g) => [...g.querySelectorAll(".tool > span:last-child")];
  function fitTools(g) {
    if (!g.isConnected) { [g, ...toolWords(g)].forEach((x) => toolsSeen.unobserve(x)); return; }
    if (!g.clientWidth) return;  // on a hidden tab: measured once it is shown
    g.classList.remove("one");
    g.classList.add("probe");  // words unbroken for a moment: one wider than its tile sticks out
    const tight = toolWords(g).some((s) => s.scrollWidth > s.clientWidth + 1);
    g.classList.remove("probe");
    g.classList.toggle("one", tight);
  }
  function tools(...kids) {
    const g = el("div", { class: "tools" }, ...kids);
    if (toolsSeen) [g, ...toolWords(g)].forEach((x) => toolsSeen.observe(x));
    return g;
  }
  function ask(title, placeholder, initial) {
    return new Promise((resolve) => {
      sheet(title, (box, close) => {
        const ta = el("textarea", { class: "input", rows: 3, placeholder });
        ta.value = initial || "";
        const done = () => { const v = ta.value.trim(); close(); resolve(v); };
        box.append(ta, el("div", { style: "height:10px" }), el("button", { class: "btn wide", text: "Готово", onclick: done }));
        setTimeout(() => ta.focus(), 100);
      });
    });
  }
  // «Удалить чат «…»? Переписка удалится с телефона.»: the question on top, the rest under it; danger — a red «yes»
  function confirmBox(text, yes, danger) {
    // cut after the first sentence, but never inside «…»: a chat named «Привет! Подскажи рецепт» stays whole
    text = String(text);
    let cut = -1, depth = 0;
    for (let i = 0; i < text.length - 1; i++) {
      const c = text[i];
      if (c === "«") depth++;
      else if (c === "»") depth = Math.max(0, depth - 1);
      else if (!depth && /[.?!]/.test(c) && /\s/.test(text[i + 1])) { cut = i + 1; break; }
    }
    const rest = cut > 0 ? text.slice(cut).trim() : "";
    const m = rest ? [text, text.slice(0, cut), rest] : null;
    return new Promise((resolve) => {
      sheet(m ? m[1] : text, (box, close) => {
        if (m) box.append(el("p", { class: "muted", style: "font-size:15px;margin:0 0 16px", text: m[2] }));
        box.append(el("div", { class: "big-actions", style: m ? "" : "margin-top:6px" },
          el("button", { class: "btn line", text: "Отмена", onclick: () => { close(); resolve(false); } }),
          el("button", { class: danger ? "btn danger-fill" : "btn", text: yes || "Да", onclick: () => { close(); resolve(true); } })));
      });
    });
  }
  // a row taken away at once, with «↩️ Вернуть» for 5 seconds; then it is gone for good (commit)
  function softDelete(row, said, commit) {
    const kids = [...row.childNodes];
    kids.forEach((k) => k.remove());
    row.classList.add("gone");
    const timer = setTimeout(commit, 5000);
    row.append(el("div", { class: "grow", text: said }), el("button", { class: "act", onclick: () => {
      clearTimeout(timer);
      row.innerHTML = "";
      row.classList.remove("gone");
      kids.forEach((k) => row.append(k));
    } }, ...lead("↩️ Вернуть")));
  }
  function viewer(blob, name, extra) {
    const v = el("div", { class: "viewer" });
    const close = () => v.remove();
    v.append(el("div", { class: "img", onclick: close }, el("img", { src: urlOf(blob) })),
      el("div", { class: "bar2" },
        el("button", { onclick: () => { saveBlob(blob, name); toast("Сохранено"); } }, ...lead("⬇️ Сохранить")),
        el("button", { onclick: () => shareBlob(blob, name) }, ...lead("📤 Поделиться")),
        extra ? el("button", { onclick: () => { close(); extra[1](); } }, ...lead(extra[0])) : null,
        el("button", { onclick: close }, ...lead("✕ Закрыть"))));
    document.body.append(v);
  }
  // the composer's main button: the microphone while there is nothing to send, the arrow once there is (drawn only on change)
  function voiceOrSend(b, send) {
    if (b.dataset.send === (send ? "1" : "") && b.firstChild) return;
    b.dataset.send = send ? "1" : "";
    b.innerHTML = "";
    b.append(icon(send ? "send" : "mic"));
    b.setAttribute("aria-label", send ? "Отправить" : "Сказать голосом");
  }
  function autoGrow(ta) {
    ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = Math.min(140, ta.scrollHeight) + "px"; });
  }

  // ---------- state ----------
  const S = { me: null, tab: store.get("tab", "chat"), msgs: {}, busy: {}, photo: null, scan: [], idea: null, views: {} };
  const THEMES = { system: "Как в телефоне", light: "Светлая", dark: "Тёмная" };
  function applyTheme() {
    const t = store.get("theme", "system");
    if (t === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
  }

  // ---------- sign-in ----------
  function parseLogin(text) {
    const s = String(text || "").trim();
    const m = s.match(/([a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?)\s*\/\s*([A-Za-z0-9]{4}-?[A-Za-z0-9]{4})/i);
    if (m) return { host: m[1].toLowerCase(), code: m[2] };
    const c = s.match(/\b([A-Za-z0-9]{4}-?[A-Za-z0-9]{4})\b/);
    return c ? { host: "", code: c[1] } : null;
  }
  const NO_CODE = "Не вижу кода. Скопируйте сообщение от владельца помощника целиком и нажмите «Вставить скопированное».";  // the button's name as it reads on it
  function renderLogin(message) {
    const app = $("#app");
    app.innerHTML = "";
    const inp = el("input", { class: "input", placeholder: "Строка из сообщения", autocomplete: "off", autocapitalize: "characters", spellcheck: "false" });
    const err = el("div", { class: "msg-err", text: message || "" });
    const go = el("button", { class: "btn line wide", text: "Войти" });
    async function login() {
      const p = parseLogin(inp.value);
      if (!p) { err.textContent = NO_CODE; return; }
      if (Native) {
        const host = p.host || (Native.getHost && Native.getHost());
        if (!host) { err.textContent = "Нужна вся строка из сообщения, а не только код. Скопируйте её целиком и нажмите «Вставить скопированное»."; return; }
        Native.setHost(host);
      }
      go.disabled = true;
      err.textContent = "";
      try {
        const r = await api("/api/login", { code: p.code, device: Native && Native.device ? Native.device() : navigator.userAgent.slice(0, 60) });
        store.set("token", r.token);
        start();
      } catch (e) {
        err.textContent = problem(e);
      }
      go.disabled = false;
    }
    go.onclick = login;
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
    // the usual way: the whole message from the owner is copied — one tap reads it and signs in
    const paste = el("button", { class: "btn wide", onclick: async () => {
      let t = "";
      try { t = Native && Native.clipboard ? Native.clipboard() : await navigator.clipboard.readText(); } catch (e) { /* no access */ }
      if (!t || !t.trim()) { toast("Ничего не скопировано — скопируйте строку из сообщения"); return; }
      inp.value = t.trim();
      if (parseLogin(t)) login(); else err.textContent = NO_CODE;
    } }, ...lead("📋 Вставить скопированное"));
    // the owner without a signed-in phone: a new code to the owner's mailbox, no server console needed
    const mail = el("button", { class: "btn line wide", style: "margin-top:18px", text: "✉️ Я владелец — прислать код на почту", onclick: async () => {
      if (Native) {
        const typed = parseLogin(inp.value);
        let host = (typed && typed.host) || (Native.getHost && Native.getHost());
        if (!host) {
          const h = await ask("Адрес вашего сервера", "Например: vpn.sites-s.ru");
          if (!h) return;
          host = h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        }
        Native.setHost(host);
      }
      mail.disabled = true;
      err.textContent = "";
      try {
        const r = await api("/api/owner_mail", {});
        err.textContent = `✉️ Код отправлен на ${r.to}. Скопируйте строку из письма и нажмите «Вставить скопированное».`;
      } catch (e) {
        err.textContent = problem(e);
      }
      mail.disabled = false;
    } });
    // only on the owner's phone (or after five taps on the star): the family's app shows no owner's buttons
    let taps = 0;
    if (!store.get("wasOwner", false)) mail.classList.add("hidden");
    const logo = el("div", { class: "logo", onclick: () => { if (++taps >= 5) mail.classList.remove("hidden"); } }, icon("logo"));
    app.append(el("div", { class: "login" },
      logo, el("h1", { text: "ИИ-помощник" }),
      el("p", { text: "Отвечает на вопросы, помогает с уроками, улучшает и меняет фото, рисует и переводит." }),
      el("p", { text: "Для входа нужен код — его присылает владелец помощника." }),
      inp, err, paste, go, mail));
  }
  async function logout(message, wipe) {
    try { await api("/api/logout", {}); } catch (e) { /* signed out anyway */ }
    store.set("token", "");
    THREADS.clear();  // the next sign-in builds its screens anew: no thread of these is used again
    if (wipe) {  // (an expired sign-in keeps them: the same person comes back with a new code)
      await DB.wipe();
      for (const k of Object.keys(localStorage)) if (/^(chats|chatCur|pend:)/.test(k) || k.startsWith("ai.pend:") || k.startsWith("ai.chat")) localStorage.removeItem(k);
      S.msgs = {};
    }
    if (Native && Native.setOwner) Native.setOwner("");  // no server notifications on a signed-out phone
    renderLogin(message || "");
  }

  // ---------- the main screen ----------
  // [key, icon, name]
  const TABS = [["chat", "chat", "Чат"], ["study", "study", "Учёба"], ["photo", "photo", "Фото"], ["video", "video", "Видео"], ["more", "more", "Ещё"]];
  // the chat is the helper's home: its header carries the helper's name (the tab below says «Чат»)
  const TITLES = { chat: "Помощник", study: "Учёба", photo: "Фото", video: "Видео", vpn: "Управление", more: "Ещё" };
  // (v41, design B) everyone has «Ещё» as the last tab (reminders, translator, memory, settings) — a tab is found where a
  // ☰ in the header was not; the owner keeps «Управление» before it
  const tabsFor = (me) => (me && me.panel ? TABS.slice(0, 4).concat([["vpn", "shield", "Управление"]], TABS.slice(4)) : TABS);
  // «Управление» is not in this app: the server gives its code only to the owner's signed-in phone
  async function ownerCode() {
    try {
      const r = await api("/api/owner_ui", {});
      return new Function("return (" + r.js + "\n)")();
    } catch (e) {
      return e;
    }
  }
  function ownerView(code) {
    try {
      if (typeof code === "function") {
        return code({ Native, S, api, ask, blobOf, confirmBox, copyText, el, md, nativeCall, problem, refreshTop, shareBlob, sheet,
          store, stream, toast, urlOf, viewer })();
      }
    } catch (e) { code = e; }
    const root = el("div", { class: "view" }, el("div", { class: "scroll" }, el("div", { class: "card" },
      el("p", { text: "Управление не загрузилось: " + problem(code) }),
      el("button", { class: "btn wide", text: "Повторить", onclick: () => location.reload() }))));
    return { root, peek: () => {} };
  }
  async function start() {
    applyTheme();
    try {
      S.me = await api("/api/me", {});
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) { renderLogin(e.message); return; }
      if (e instanceof HttpError && e.status < 500) { renderLogin(problem(e)); return; }
      const app = $("#app");
      app.innerHTML = "";
      app.append(el("div", { class: "login" }, el("div", { class: "logo" }, icon("logo")), el("p", { text: problem(e) }),
        el("button", { class: "btn wide", text: "Повторить", onclick: start })));
      if (Date.now() - wingerAt < 2 * 60000) setTimeout(start, 8000);  // Winger is coming up over a bridge: again by itself
      return;
    }
    document.querySelectorAll(".toast").forEach((t) => t.remove());  // the sign-in screen's words are done with
    const owner = S.me.panel ? ownerCode() : null;  // fetched while the conversations load
    if (S.me.panel) store.set("wasOwner", true);
    await DB.open();
    for (const t of ["chat", "study", "photo", "video"]) S.msgs[t] = await DB.list(t);
    const app = $("#app");
    app.innerHTML = "";
    const shell = el("div", { class: "shell" });
    S.top = el("div", { class: "top" });
    S.viewsEl = el("div", { class: "views" });
    const tabs = el("div", { class: "tabs" + (tabsFor(S.me).length === 6 ? " six" : "") });
    for (const [key, ic, name] of tabsFor(S.me)) {
      tabs.append(el("button", { class: "tab", "data-tab": key, onclick: () => show(key) }, el("span", { class: "ic" }, icon(ic)), el("span", { class: "lb", text: name })));
    }
    shell.append(S.top, S.viewsEl, tabs);
    app.append(shell);
    S.views = { chat: chatView(), study: studyView(), photo: photoView(), video: videoView(), more: moreView() };
    if (S.me.panel) {
      S.views.vpn = ownerView(await owner);
      if (Native && Native.setOwner) {
        Native.setOwner(store.get("token", ""));
        if (!store.get("askedNotify", false) && Native.askNotify) { store.set("askedNotify", true); Native.askNotify(); }
      }
      setTimeout(() => S.views.vpn && S.views.vpn.peek(), 1500);
    }
    for (const v of Object.values(S.views)) S.viewsEl.append(v.root);
    show(tabsFor(S.me).some((t) => t[0] === S.tab) && S.tab !== "vpn" ? S.tab : "chat");
    maTry();  // an app's icon on the home screen brought the helper up: that app now
    shotTry();
  }
  function show(tab) {
    // a notice belongs to the screen it was said on; the owner's code shows one and redraws the same tab right after
    if (tab !== S.tab) document.querySelectorAll(".toast").forEach((t) => t.remove());
    S.tab = tab;
    store.set("tab", tab);
    // the tab is open: its mark «something came while you were away» (see thread().run) has done its job
    document.querySelectorAll(".tab").forEach((b) => { b.classList.toggle("on", b.dataset.tab === tab); if (b.dataset.tab === tab) { b.classList.remove("dot"); b.removeAttribute("aria-label"); } });
    for (const [k, v] of Object.entries(S.views)) v.root.classList.toggle("hidden", k !== tab);
    const v = S.views[tab];
    S.top.innerHTML = "";
    const sub = v.sub ? v.sub() : "";
    S.top.append(el("span", { class: "mark", "aria-hidden": "true" }, icon("logo")),
      el("h1", {}, TITLES[tab], sub || tab === "chat" ? el("span", { class: "sub", text: sub || "для всей семьи" }) : null));
    // a button's sign picks its icon («🗂️ Чаты» → the clock and «Чаты»); a sign alone is a round icon button
    for (const b of v.buttons ? v.buttons() : []) {
      const parts = lead(b[0]), only = parts.length === 1 && parts[0] instanceof Node;
      S.top.append(el("button", { class: "icon-btn pill" + (only ? " only" : ""), title: b[1], "aria-label": only ? b[1] : null, onclick: b[2] }, ...parts));
    }
    if (v.onShow) v.onShow();
  }
  function refreshTop() { if (S.views[S.tab]) show(S.tab); }

  // ---------- reminders: the phone rings by itself (the app's own alarm); the server only works out when and what ----------
  const REMIND_ASK = /^\s*(?:пожалуйста,?\s+)?(напомни|напомнить|поставь\s+напоминание)(?![а-яё])/i;
  function remindSet(r) {
    if (!Native) return "\n\nНапоминания звенят только в приложении «ИИ-помощник» на телефоне.";
    if (!Native.remindAdd) return "\n\nЧтобы телефон напоминал сам, обновите приложение: вкладка «Ещё» → «Проверить обновление».";
    const id = Native.remindAdd(JSON.stringify(r));
    if (!id) return "\n\n⚠️ Не получилось поставить напоминание на телефоне.";
    if (Native.askNotify && !store.get("askedNotify", false)) {
      store.set("askedNotify", true);
      Native.askNotify();
      return "\n\nТелефон напомнит сам, даже без интернета — разрешите приложению уведомления в появившемся окне.";
    }
    // the phone does not let it show notifications: said now, not found out when it never rings
    if (Native.notifyOn && !Native.notifyOn()) {
      if (Native.askNotify) Native.askNotify();
      return "\n\n⚠️ Уведомления приложения выключены — напоминание не прозвенит. Включите: вкладка «Ещё» → «⏰ Напоминания» → «🔔 Включить уведомления».";
    }
    return "\n\nТелефон напомнит сам, даже без интернета. Отменить — вкладка «Ещё» → «⏰ Напоминания».";
  }
  function remindersCard(redraw) {
    const card = el("div", { class: "card" }, el("h3", { text: "⏰ Напоминания" }));
    if (Native.notifyOn && !Native.notifyOn()) {
      card.append(el("div", { style: "font-size:14px;color:var(--danger-ink);margin:0 0 8px", text: "⚠️ Уведомления приложения выключены — напоминания не звенят." }),
        el("button", { class: "btn soft wide", style: "margin-bottom:8px", onclick: () => Native.notifySettings && Native.notifySettings() }, ...lead("🔔 Включить уведомления")));
    }
    let list = [];
    try { list = JSON.parse(Native.reminders() || "[]"); } catch (e) { /* none */ }
    if (!list.length) {
      card.append(el("div", { class: "muted", style: "font-size:14px", text: "Пока нет. Скажите или напишите в чате: «Напомни завтра в 9 выпить таблетку» — телефон напомнит сам, даже без интернета." }));
    }
    const again = { daily: " · каждый день", weekly: " · каждую неделю", monthly: " · каждый месяц" };
    for (const r of list) {
      const at = new Date(r.at).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
      const row = el("div", { class: "row" }, el("div", { class: "grow" }, r.text, el("small", { text: at + (again[r.repeat] || "") })));
      // only this row goes: another row deleted just now keeps its «↩️ Вернуть»; the whole card is drawn again when it
      // is empty (its «Пока нет» words) or was drawn anew meanwhile
      row.append(el("button", { class: "icon-btn", icon: "trash", title: "Удалить", "aria-label": "Удалить", onclick: () => softDelete(row, "Напоминание удалено", () => {
        Native.remindDel(r.id);
        row.remove();
        if (!card.isConnected || !card.querySelector(".row")) redraw();
      }) }));
      card.append(row);
    }
    return card;
  }

  // ---------- conversation threads (chat, study, photo, video) ----------
  function context(thread) {
    const out = [];
    for (const m of S.msgs[thread]) {
      if (m.err || m.role === "note") continue;
      if (m.role === "me" && (m.ctx || m.text)) out.push({ role: "user", text: m.ctx || m.text });
      else if (m.role === "ai" && m.text && !m.result && !m.video) out.push({ role: "model", text: m.text });
    }
    return out.slice(-20);
  }
  function msgEl(m, thread, list) {
    if (m.role === "note") return el("div", { class: "msg note" }, el("div", { class: "bubble", text: m.text }));
    const wrap = el("div", { class: "msg " + (m.role === "me" ? "me" : "ai") + (m.image || m.result || m.video ? " media" : "") });
    const b = el("div", { class: "bubble" + (m.err ? " err" : "") });
    // in Photo a picture opened full screen can be worked on again
    const again = (im, words) => (thread === "photo" ? [words, () => S.views.photo.set(im)] : null);
    if (m.image) b.append(el("img", { class: "thumb", src: urlOf(m.image), alt: "", onclick: () => viewer(m.image, "photo.jpg", again(m.image, "✏️ Изменить это фото")) }));
    if (m.file) b.append(el("div", { class: "file-chip", text: (m.file.startsWith("🎬 ") ? "" : "📄 ") + m.file }));
    if (m.result) {
      b.append(el("img", { class: "result", src: urlOf(m.result), alt: "", onclick: () => viewer(m.result, m.name || "picture.jpg", again(m.result, "✏️ Изменить ещё")) }));
    }
    // «#t=0.1»: the first frame is painted before it is played, not a black box with «0:00»; where the phone does not
    // paint it, the poster stands in: the photo that was brought to life
    if (m.video) {
      const poster = m.poster ? urlOf(m.poster) : null;
      b.append(el("video", { class: "result", controls: true, playsinline: true, preload: "metadata", poster, src: urlOf(m.video) + "#t=0.1" }));
    }
    if (m.pdf) b.append(el("div", { class: "file-chip", style: "background:var(--accent-soft);margin-bottom:6px", text: "📄 " + (m.name || "document.pdf") }));
    if (m.role === "me") { if (m.text) b.append(el("div", { text: m.text })); }
    else if (m.text) b.append(el("div", { html: md(m.text) }));
    if (m.audio) b.append(el("audio", { controls: true, src: urlOf(m.audio) }));
    wrap.append(b);
    // under an answer: the family sees no model's name and no usual mode — only «🌐 интернет», the grade, the checks
    // in Учёба the grade is already on top and in the line over the answers: not a third time here
    const lab = m.label && (S.me.panel ? m.label : m.label.split(" · ").slice(1)
      .filter((x) => x && x !== S.me.modes.chat && !(thread === "study" && /класс|курс|Взрослый/.test(x))).join(" · "));
    if (lab) wrap.append(el("div", { class: "label", text: lab }));
    const act = (text, onclick) => el("button", { class: "act", onclick }, ...lead(text));
    const file = m.result || m.video || m.pdf;
    if (file) {  // a picture, video or PDF that came out: keep it, share it, or (in Photo) work on it further
      wrap.append(el("div", { class: "acts" },
        act("⬇️ Сохранить", () => { saveBlob(file, m.name || "result"); toast("Сохранено"); }),
        act("📤 Поделиться", () => shareBlob(file, m.name || "result")),
        // (v40, the review) a picture with its text («✍️ Переписать аккуратно»: the sheet and the clean text) — the text to copy
        m.text && (m.copy || m.op === "neat") ? act("📋 Копировать", () => copyText(plain(m.text))) : null,
        thread === "photo" && m.result ? act("✏️ Изменить ещё", () => S.views.photo.set(m.result)) : null));
    } else if (m.role === "ai" && m.text && !m.err) {
      // «Короче» and «Подробнее» are about the last answer: only under it, and not while the next one is being written.
      // Under the older answers the buttons stay (and stay 44px tall) but go quiet: no outline over a long talk.
      const all = S.msgs[thread] || [];
      let lastAi = null;
      for (let i = all.length - 1; i >= 0 && !lastAi; i--) if (all[i].role === "ai") lastAi = all[i];
      wrap.append(el("div", { class: "acts" + (m === lastAi ? "" : " quiet") },
        act("📋 Копировать", () => copyText(plain(m.text))),
        S.me.can.speak ? act("🔊 Прочитать вслух", () => speakMsg(m, b)) : null,
        !m.note && m === lastAi && !S.busy[thread] && list && list.ask ? [act("✂️ Короче", () => list.follow("short")), act("➕ Подробнее", () => list.follow("more"))] : null));
    } else if (m.err && list) {
      if (list.canRetry(m)) wrap.append(el("div", { class: "acts" }, act("🔄 Повторить", () => list.retry(m))));
    }
    return wrap;
  }
  async function speakMsg(m, bubble) {
    if (m.audio) { playAudio(m.audio); return; }
    toast("🔊 Озвучиваю…");
    try {
      const ev = await stream("/api/speak", { text: plain(m.text) }, () => {});
      if (ev.t !== "done") { toast(ev.text); return; }
      m.audio = blobOf(ev.audio, "audio/ogg");
      await DB.put(m);
      const a = el("audio", { controls: true, src: urlOf(m.audio) });
      bubble.append(a);
      a.play().catch(() => {});
    } catch (e) { toast(problem(e)); }
  }
  // a thread of messages with a live answer bubble; emptyState: what an empty thread shows, tail: what goes under the
  // last message (both may give null)
  function thread(name, scroll, emptyState, tail) {
    const box = el("div", { class: "msgs" });
    let last = null, liveEl = null;  // the last request (for «Повторить»), the bubble being written now
    const PEND = "pend:" + name;  // the request still out (its number), so that its answer is not lost
    // the bubble of an answer being made: what the server says it is doing, the words as they come, the time it takes
    function live(first, path) {
      const node = el("div", { class: "msg ai" });
      const b = el("div", { class: "bubble" });
      const content = el("div");
      const status = el("div", { class: "status" }, el("span", { class: "spin" }), el("span", { text: first }));
      b.append(content, status);
      if (path === "/api/animate") {
        b.append(el("div", { class: "live-note", text: "Можно перейти в другую вкладку или свернуть приложение — ролик придёт сюда." }));
      }
      node.append(b);
      [...box.children].forEach((c) => { if (c.classList.contains("empty") || c.classList.contains("tail")) c.remove(); });
      box.append(node);
      liveEl = node;
      api2.down();
      let text = "", timer = null, said = first, t0 = Date.now();
      const clock = setInterval(() => {
        const sec = Math.round((Date.now() - t0) / 1000);
        if (sec >= 5 && !status.classList.contains("hidden")) {
          status.lastChild.textContent = said + " · " + (sec < 60 ? sec + " с" : "прошло " + Math.floor(sec / 60) + " мин");
        }
      }, 1000);
      // the words so far: a bold or code mark not closed yet is left out for now («**Отв» shows as «Отв»)
      const unfinished = (t) => {
        for (const mark of ["**", "`"]) {
          const n = t.split(mark).length - 1 - (mark === "`" ? 3 * (t.split("```").length - 1) : 0);
          if (n % 2) { const i = t.lastIndexOf(mark); t = t.slice(0, i) + t.slice(i + mark.length); }
        }
        return t;
      };
      const paint = () => { timer = null; content.innerHTML = md(unfinished(text)); content.lastElementChild && content.lastElementChild.classList.add("typing"); api2.down(); };
      const say = (t) => {
        said = t;
        t0 = Date.now();
        status.lastChild.textContent = t;
        status.classList.remove("hidden");
        if (text) status.style.marginTop = "8px";
      };
      return {
        event(ev) {
          if (ev.t === "status") say(ev.text);
          else if (ev.t === "reset") { text = ""; content.innerHTML = ""; status.style.marginTop = ""; }
          else if (ev.t === "delta") {
            text += ev.text;
            status.classList.add("hidden");
            if (!timer) timer = setTimeout(paint, 90);
          }
        },
        // the answer by its number (rid), whatever the line does: asked now and then (what the server is doing meanwhile,
        // the words written so far); while there is no internet it waits for it (and asks at once when it is back);
        // while the app is put aside nothing is asked. again(): the request sent once more with the same number, when
        // the server says it never had it (the line broke on the way there) — the server never runs one number twice.
        // Without again (the app was closed meanwhile and the request was too big to keep) it says the question did
        // not get there.
        async wait(rid, again, broke) {
          const sayOnce = (t) => { if (t && t !== said) say(t); };  // the clock goes on while the words stay the same
          const offline = "📶 Нет интернета — ответ придёт, когда связь вернётся";
          // (v36) the phone's «no network» is not trusted: under a VPN (Winger switching bridges) the WebView often says
          // «offline» while the line works — the server is asked anyway, «no internet» only when asking really fails
          sayOnce(broke || (said.startsWith("⏳") || said.startsWith("📶") ? said : "⏳ Связь прервалась — ответ ещё готовится и придёт сюда"));
          const until = Date.now() + 2 * 3600e3;
          let pause = 1500, sent = 0;
          while (Date.now() < until) {
            await nap(pause);
            if (document.hidden) await new Promise((r) => document.addEventListener("visibilitychange", function on() { if (!document.hidden) { document.removeEventListener("visibilitychange", on); r(); } }));
            let r;
            try {
              r = await api("/api/job", { rid, lite: true });
              if (r.t === "ready") {
                sayOnce("📥 Ответ готов — загружаю…");
                let shown = -10;
                r = await fetchResult(rid, r.size, (pct) => { if (pct >= shown + 10) { shown = pct; sayOnce(`📥 Ответ готов — загружаю… ${pct}%`); } });
              }
            } catch (e) {
              if (e instanceof HttpError && e.status === 404) {  // the server has no such request: it never got there
                if (!again) return { t: "error", text: "Вопрос не дошёл до сервера — отправьте его ещё раз." };
                if (sent >= 3) return { t: "error", text: "Не получается отправить — связь всё время обрывается. Попробуйте ещё раз чуть позже." };
                sent++;
                sayOnce("📶 Связь прервалась — отправляю ещё раз…");
                try {
                  const end = await again();
                  if (end) return end;
                } catch (x) {
                  if (x instanceof HttpError) return { t: "error", text: problem(x) };  // the server said no
                }
                pause = 2000;
                continue;
              }
              if (e instanceof HttpError && e.status === 401) return { t: "error", text: problem(e) };
              if (!(e instanceof HttpError)) sayOnce(navigator.onLine === false ? offline : "📶 Связь прерывается — жду ответ сервера…");
              pause = Math.min(15000, pause * 1.5);  // no network yet, or asked too often: a little later (woken by «online» at once)
              continue;
            }
            pause = 3000;
            if (r.t !== "working") return r;
            if (r.text) sayOnce(r.text);
            if (r.partial && r.partial !== text) { text = r.partial; status.classList.add("hidden"); paint(); }
          }
          return { t: "error", text: "Ответ так и не пришёл — попробуйте ещё раз." };
        },
        stop() { clearTimeout(timer); clearInterval(clock); node.remove(); },
      };
    }
    // the answer in: kept in the thread, the server told it may forget it, a notice when another tab is open
    async function finish(lv, end, path, mine, rid) {
      lv.stop();
      liveEl = null;
      S.busy[name] = false;
      store.set(PEND, null);
      let out;
      if (end.t === "done") {
        if (mine && end.user) { mine.ctx = end.user; DB.put(mine); }
        if (end.remind) end.text = (end.text || "") + remindSet(end.remind);
        out = await api2.add({ role: "ai", text: end.text || end.caption, label: end.label, note: !!end.note,
          copy: !!(end.text && (end.image || end.pdf)),  // (v40, the review) its own text with a picture: «📋 Копировать» under it
          audio: end.audio ? blobOf(end.audio, "audio/ogg") : null, name: end.name, op: end.op,
          result: end.image ? blobOf(end.image, end.mime) : null, video: end.video ? blobOf(end.video, end.mime) : null,
          // a photo brought to life shows that photo until it is played
          poster: end.video && path === "/api/animate" && last ? last.still : null,
          pdf: end.pdf ? blobOf(end.pdf, "application/pdf") : null });
        // a photoshoot's other pictures: each its own message under the first (saved and opened the same way)
        for (const extra of end.image && Array.isArray(end.more) ? end.more : []) {
          await api2.add({ role: "ai", text: "", name: end.name, result: blobOf(extra, end.mime) });
        }
        if (out.audio) playAudio(out.audio);
      } else {
        out = await api2.add({ role: "ai", text: "⚠️ " + end.text, err: true });
      }
      if (rid) api("/api/job", { rid, ack: true }).catch(() => {});  // (once it is kept here: the server's copy may go)
      // a clip (5–8 min), a picture or an answer that came while another tab is open: a notice where the person is now,
      // and a mark on its tab until it is opened (the chats have their own list: not marked)
      const TAB_OF = { study: "Учёба", photo: "Фото", video: "Видео" };
      if (TAB_OF[name] && S.tab !== name) {
        toast((end.t === "done" ? "✅ Готово" : "⚠️ Не получилось") + " — откройте «" + TAB_OF[name] + "»", 6000);
        const tb = document.querySelector(`.tab[data-tab="${name}"]`);
        if (tb) { tb.classList.add("dot"); tb.setAttribute("aria-label", TAB_OF[name] + " — есть новое"); }
      }
      api2.redraw();
      return out;
    }
    const api2 = {
      box, name,
      redraw() {
        box.innerHTML = "";
        if (!S.msgs[name].length && emptyState && !liveEl) box.append(emptyState());
        for (const m of S.msgs[name]) box.append(msgEl(m, name, api2));
        if (liveEl) box.append(liveEl);
        else if (tail && !S.busy[name]) box.append(tail());
        if (api2.onRedraw) api2.onRedraw();
        api2.down();
      },
      // to the newest message; an empty screen opens at its top. Pictures and clips from the phone's store get their
      // height only when loaded: for a few seconds the screen follows them down, unless the person scrolls by themselves.
      down() {
        if (!box.isConnected) return;  // a chat not on the screen now: the open one is not scrolled for it
        const go = () => { scroll.scrollTop = box.querySelector(".msg") ? scroll.scrollHeight : 0; };
        requestAnimationFrame(go);
        const wait = [...box.querySelectorAll("img, video")].filter((x) => (x.tagName === "IMG" ? !x.complete : x.readyState < 1));
        if (!wait.length) return;
        const until = Date.now() + 4000;
        let moved = false;
        const mark = () => { moved = true; };
        scroll.addEventListener("touchstart", mark, { once: true, passive: true });
        scroll.addEventListener("wheel", mark, { once: true, passive: true });
        for (const x of wait) {
          x.addEventListener(x.tagName === "IMG" ? "load" : "loadedmetadata", () => { if (!moved && Date.now() < until) go(); }, { once: true });
        }
      },
      async add(m) {
        m.thread = name;
        m.ts = Date.now();
        // a photo from the phone is kept as big as it was sent (the photo tools take 3072 px), not as the camera made it
        if (m.role === "me" && m.image instanceof Blob && m.image.size > 400000) {
          m.image = await shrink(m.image, name === "photo" ? 3072 : 1600, 0.9);
        }
        await DB.add(m);
        S.msgs[name].push(m);
        if (S.msgs[name].length > 400) { S.msgs[name] = S.msgs[name].slice(-300); DB.trim(name, 300); }
        if (S.msgs[name].length === 1 && S.tab === name) refreshTop();  // «🧹 Очистить» on top once there is something to clear
        return m;
      },
      // asks the server and shows the answer as it is written. Each request has a number of its own (rid): the server
      // finishes it and keeps the answer even when the phone goes away (another tab, the app put aside or closed, the
      // network gone) — then the answer is fetched by that number (see resume) instead of being lost
      async run(path, body, mine) {
        if (S.busy[name]) { toast("Подождите, ещё отвечаю…"); return null; }
        S.busy[name] = true;
        // «🔄 Повторить» sends the same again with no new bubble of its own: the photo a clip is made from stays known
        if (mine) { await api2.add(mine); api2.redraw(); }  // (first: the clip's poster is the photo as kept, not the camera's)
        last = { path, body, still: mine ? mine.image || null : last && last.body === body ? last.still : null };
        const rid = newRid();
        // the request's number kept (and the request itself when it is small: a question, not a photo or a clip), so
        // that its answer is fetched — or it is sent again — even after the app was closed
        const small = JSON.stringify(body || {}).length < 100000;
        store.set(PEND, { rid, path, at: Date.now(), body: small ? body : null });
        // a picture, a clip or a PDF is first sent off; «Думаю…» is for words, until the server says what it is doing
        const lv = live(/\/api\/(photo|photo_do|draw|animate|pdf|shoot)$/.test(path) ? "Отправляю…" : "Думаю…", path);
        const again = () => stream(path, Object.assign({}, body, { rid }), lv.event).catch((e) => {
          if (e instanceof HttpError) throw e;
          return null;  // broke again (on the way there or back): asked by its number again
        });
        let end, broke = "";
        try {
          end = await stream(path, Object.assign({}, body, { rid }), lv.event);
        } catch (e) {
          if (e instanceof HttpError) end = { t: "error", text: problem(e) };  // the server said no
          else {  // the line broke: the server goes on (or never got it — then it is sent again), its answer is fetched
            end = null;
            if (!e.started) broke = "📶 Связь прервалась — пробую ещё раз…";
          }
        }
        if (!end) end = await lv.wait(rid, again, broke);
        return finish(lv, end, path, mine, rid);
      },
      // a request left unfinished (the app was put aside or closed, the line broke): its answer fetched by its number
      async resume() {
        const p = store.get(PEND, null);
        if (!p || S.busy[name]) return;
        if (!p.rid || Date.now() - (p.at || 0) > 2 * 3600e3) { store.set(PEND, null); return; }
        S.busy[name] = true;
        const lv = live("⏳ Ответ ещё готовится…", p.path);
        const again = p.body ? () => stream(p.path, Object.assign({}, p.body, { rid: p.rid }), lv.event).catch((e) => {
          if (e instanceof HttpError) throw e;
          return null;
        }) : null;
        const end = await lv.wait(p.rid, again);
        await finish(lv, end, p.path, null, p.rid);
      },
      // «🔄 Повторить» under the last answer when it did not come: the same request once more
      canRetry(m) {
        const l = S.msgs[name];
        return !!last && !!m.err && l[l.length - 1] === m && !S.busy[name];
      },
      async retry(m) {
        if (!api2.canRetry(m)) return;
        await DB.del(m.id);
        S.msgs[name].pop();
        api2.redraw();
        await api2.run(last.path, last.body, null);
      },
      follow(kind) {
        const shown = { short: "✂️ Короче", more: "➕ Подробнее" }[kind];
        api2.ask({ followup: kind }, { role: "me", text: shown, ctx: shown });
      },
      ask: null,  // set by the view
      onRedraw: null,  // set by the view that draws something of its own with the thread
    };
    THREADS.set(name, api2);
    setTimeout(() => api2.resume(), 0);  // an answer left out there when the app was closed: fetched now
    return api2;
  }
  // the threads there are now (a chat's own once it is opened): coming back to the app, each fetches what it left out
  const THREADS = new Map();
  const newRid = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (x) => x.toString(16).padStart(2, "0")).join("");
  document.addEventListener("visibilitychange", () => { if (!document.hidden) for (const t of THREADS.values()) t.resume(); });

  // speech to text in place of the input row; onText gets what was said
  async function dictate(row, onText) {
    if (Rec.starting || Rec.on) return;  // a second tap while the first one starts: the one recording is enough
    let sid;
    try { sid = await Rec.start(); } catch (e) { toast("Нет доступа к микрофону"); return; }
    const time = el("span", { class: "time", text: "0:00" });
    const recRow = el("div", { class: "rec" }, el("span", { class: "dot" }), time,
      el("button", { class: "round ghost", icon: "x", "aria-label": "Отменить", onclick: () => finish(false) }),
      el("button", { class: "round main", icon: "check", "aria-label": "Готово", onclick: () => finish(true) }));
    row.replaceWith(recRow);
    const tick = setInterval(() => {
      const s = Math.floor((Date.now() - Rec.t0) / 1000);
      time.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
      if (s >= 290) finish(true);
    }, 300);
    let done = false;
    async function finish(keep) {
      if (done) return;
      done = true;
      clearInterval(tick);
      recRow.replaceWith(row);
      const r = Rec.sid === sid ? Rec.stop(keep) : null;  // (another recording since: this one is over already)
      if (!r || r.duration < 0.6) return;
      hear(r);
    }
    // what was said, the input row showing it is being made out meanwhile (it can take a while when the server is
    // busy); a failure keeps the recording for another try instead of asking to say it all again
    async function hear(r) {
      const wait = el("div", { class: "rec" }, el("span", { class: "spin" }), el("span", { class: "what", text: "Распознаю речь…" }));
      row.replaceWith(wait);
      let ev = null, why = "";
      try {
        ev = await stream("/api/hear", { audio: await b64(r.blob), mime: "audio/wav", duration: r.duration }, () => {});
        if (ev.t !== "done") why = ev.text;
      } catch (e) { why = problem(e); }
      if (!why) { wait.replaceWith(row); onText(ev.text); return; }
      const again = el("div", { class: "rec" }, el("span", { class: "what", text: why }),
        el("button", { class: "round ghost", icon: "x", "aria-label": "Отменить", onclick: () => again.replaceWith(row) }),
        el("button", { class: "round main", icon: "refresh", "aria-label": "Распознать ещё раз", onclick: () => { again.replaceWith(row); hear(r); } }));
      wait.replaceWith(again);
    }
  }

  // ---------- Chat ----------
  // several chats on this phone, each its own thread of messages (the first one keeps the old thread «chat»)
  const CHATS_MAX = 30;
  const chatName = (id) => (id === "main" ? "chat" : "chat:" + id);
  const cut40 = (t) => { t = String(t).replace(/\s+/g, " ").trim(); return t.length > 40 ? t.slice(0, 40).trim() + "…" : t; };
  function chatsAll() {
    const l = store.get("chats", null);
    return Array.isArray(l) && l.length ? l : [{ id: "main", title: "", upd: 0 }];
  }
  function chatTitle(c) {
    if (c.title) return c.title;
    const first = (S.msgs[chatName(c.id)] || []).find((m) => m.role === "me" && m.text);
    return first ? cut40(first.text) : c.id === "main" ? "Первый чат" : "Новый чат";
  }
  const IDEAS_SHOWN = ["congrats", "letter", "reply", "recipe", "explain", "gift"];  // the rest: «Другие задачи»
  function chatView() {
    const root = el("div", { class: "view" });
    const scroll = el("div", { class: "scroll" });
    // (design B) the first screen: the orb to talk to (Winger's power button, the same «on» colour), «Чем помочь?», and
    // the ready tasks as rows of one list — «Другие задачи» the last of them
    const empty = () => el("div", { class: "empty home" },
      el("div", { class: "home-hero" },
        el("button", { class: "orb", "aria-label": "Сказать голосом", icon: "mic", onclick: () => record() }),
        el("h2", { text: "Чем помочь?" }),
        el("p", { text: "Нажмите на шар и скажите — я слушаю. Или напишите внизу; фото и документы — через скрепку." })),
      el("div", { class: "home-tasks" },
        el("h3", { class: "empty-sec", text: "Готовые задачи" }),
        tools(
          Native && Native.remindAdd ? tool("⏰ Напомнить", () => { ta.value = "Напомни "; sync(); ta.focus(); }) : null,
          tool("🗣️ Переводчик", translator),
          IDEAS_SHOWN.filter((k) => S.me.ideas[k]).map((k) => tool(S.me.ideas[k][0], () => pickIdea(k), IDEA_ICONS[k])),
          tool("🧰 Другие задачи", ideasMenu))));
    let cur = store.get("chatCur", "main"), th = null;
    if (!chatsAll().some((c) => c.id === cur)) cur = chatsAll()[0].id;
    const attach = el("div", { class: "attach-row hidden" });
    const chips = el("div", { class: "chips hidden", style: "padding:0 4px 8px;flex-wrap:wrap" });  // all three in sight, no sideways row
    const ideaHint = el("div", { class: "idea-hint hidden" });
    const ta = el("textarea", { rows: 1, placeholder: "Сообщение" });
    autoGrow(ta);
    const clip = el("button", { class: "round ghost", icon: "clip", title: "Прикрепить", "aria-label": "Прикрепить", onclick: attachMenu });
    const act = el("button", { class: "round main" });
    voiceOrSend(act, false);
    const row = el("div", { class: "inrow" }, clip, ta, act);
    const composer = el("div", { class: "composer" }, attach, chips, ideaHint, row);
    root.append(scroll, composer);
    let image = null, doc = null;

    function sync() {
      voiceOrSend(act, !!(ta.value.trim() || image || doc));
      attach.innerHTML = "";
      attach.classList.toggle("hidden", !(image || doc || S.idea));
      if (image) attach.append(el("img", { src: urlOf(image), alt: "" }));
      if (doc) attach.append(el("div", { class: "chip", text: (doc.video ? "🎬 " : "📄 ") + doc.name }));
      if (S.idea) attach.append(el("div", { class: "chip on", text: S.me.ideas[S.idea][0] }));
      if (image || doc || S.idea) attach.append(el("button", { class: "x", icon: "x", "aria-label": "Убрать", onclick: () => { image = doc = null; S.idea = null; sync(); } }));
      ideaHint.textContent = S.idea ? S.me.ideas[S.idea][1] : "";
      ideaHint.classList.toggle("hidden", !S.idea);
      ta.placeholder = S.idea ? "Напишите здесь" : "Сообщение";
      chips.innerHTML = "";
      chips.classList.toggle("hidden", !image);
      if (image) {
        for (const op of ["describe", "ocr", "translate"]) {  // answers in words; tools for the photo itself live in Photo
          if (S.me.ai_ops[op]) chips.append(el("button", { class: "chip", text: S.me.ai_ops[op], onclick: () => sendNow({ op }) }));
        }
      }
    }
    ta.addEventListener("input", sync);
    function pickIdea(k) {
      S.idea = k;
      sync();
      ta.focus();
    }
    function sendNow(extra) {
      const text = ta.value.trim();
      if (!text && !image && !doc && !(extra && extra.op)) {
        if (S.idea) { toast(S.me.ideas[S.idea][1].split(" Например")[0]); ta.focus(); }
        return;
      }
      if (S.busy[chatName(cur)]) { toast("Подождите, ещё отвечаю… Сообщение осталось в поле — отправьте его после ответа."); return; }
      const req = Object.assign({ text }, extra || {});
      if (S.idea) req.idea = S.idea;
      const shown = (extra && extra.op ? S.me.ai_ops[extra.op] + (text ? ": " + text : "") : "") || (S.idea ? S.me.ideas[S.idea][0] + ": " + text : text);
      const mine = { role: "me", text: shown, image, file: doc ? (doc.video ? "🎬 " : "") + doc.name : null };
      const im = image, d = doc;
      ta.value = "";
      ta.style.height = "auto";
      image = doc = null;
      S.idea = null;
      sync();
      th.ask(req, mine, im, d);
    }
    function bind() {  // the thread of the chat that is open now, with its own asking (made once for each chat)
      const name = chatName(cur);
      if (!S.msgs[name]) S.msgs[name] = [];
      const t = THREADS.get(name) || thread(name, scroll, empty);
      t.ask = async (req, mine, im, d) => {
        if (S.busy[name]) { toast("Подождите, ещё отвечаю…"); return; }
        touch((mine && mine.text) || (im ? "📷 Фото" : d ? (d.video ? "🎬 " : "📄 ") + d.name : ""));  // a photo with no words: named too
        if (!im && !d && !req.op && !req.idea && !req.followup && req.text && REMIND_ASK.test(req.text)) {
          let tz = "";
          try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { /* Moscow then */ }
          await t.run("/api/remind", { text: req.text, tz }, mine);  // «напомни …»: the phone rings by itself, in its own time
          return;
        }
        const body = Object.assign({ context: context(name) }, req);
        if (im) body.image = await b64(await shrink(im, 1600, 0.86));  // lighter on a weak line; models see less anyway
        if (d && d.video) body.video = { name: d.name, mime: d.type || "", data: await b64(d) };
        else if (d) body.doc = { name: d.name, mime: d.type || "", data: await b64(d) };
        await t.run(d && d.video ? "/api/chat_video" : "/api/chat", body, mine);  // (a video: a bigger body allowed)
      };
      if (th && th !== t) th.box.replaceWith(t.box); else if (!th) scroll.append(t.box);
      th = t;
      th.redraw();
    }
    function touch(text) {  // the chat's name (its first question) and when it was used, for the list
      const chats = chatsAll();
      let c = chats.find((x) => x.id === cur);
      if (!c) { c = { id: cur, title: "", upd: 0 }; chats.unshift(c); }
      if (!c.title && text && !S.msgs[chatName(cur)].some((m) => m.role === "me")) c.title = cut40(text);
      c.upd = Date.now();
      chats.sort((a, b) => (b.upd || 0) - (a.upd || 0));
      store.set("chats", chats);
      refreshTop();
    }
    async function openChat(id) {
      // a new chat left without a word in it does not stay in the list
      const left = chatsAll().filter((c) => c.id === id || c.id === "main" || c.title || (S.msgs[chatName(c.id)] || []).length);
      if (left.length) store.set("chats", left);
      cur = id;
      store.set("chatCur", id);
      const name = chatName(id);
      if (!S.msgs[name] || !S.msgs[name].length) S.msgs[name] = await DB.list(name);
      bind();
      refreshTop();
    }
    async function newChat() {
      if (!S.msgs[chatName(cur)].length) { toast("Это уже новый чат — пишите"); return; }
      const id = Date.now().toString(36), chats = chatsAll();
      chats.unshift({ id, title: "", upd: Date.now() });
      for (const old of chats.slice(CHATS_MAX)) { await DB.clear(chatName(old.id)); delete S.msgs[chatName(old.id)]; }
      store.set("chats", chats.slice(0, CHATS_MAX));
      await openChat(id);
    }
    async function delChat(c) {
      if (S.busy[chatName(c.id)]) { toast("Этот чат ещё отвечает — удалите его, когда ответ придёт"); return; }
      if (!(await confirmBox(`Удалить чат «${chatTitle(c)}»? Переписка удалится с телефона.`, "Удалить", true))) return;
      await DB.clear(chatName(c.id));
      delete S.msgs[chatName(c.id)];
      let chats = chatsAll().filter((x) => x.id !== c.id);
      if (!chats.length) chats = [{ id: Date.now().toString(36), title: "", upd: Date.now() }];
      store.set("chats", chats);
      if (c.id === cur) await openChat(chats[0].id); else refreshTop();
    }
    function chatsSheet() {
      sheet("🗂️ Чаты", (box, close) => {  // the same sign as the button that opens it
        box.append(el("button", { class: "btn wide", style: "margin-bottom:10px", text: "➕ Новый чат", onclick: () => { close(); newChat(); } }));
        for (const c of chatsAll()) {
          const day = c.upd ? new Date(c.upd).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) : "";
          box.append(el("div", { class: "row chat-row" + (c.id === cur ? " cur" : ""), onclick: () => { close(); openChat(c.id); } },
            el("div", { class: "grow" }, el("span", { class: "t", text: chatTitle(c) }), el("small", { text: c.id === cur ? "открыт сейчас" : day })),
            el("button", { class: "round ghost", icon: "pen", title: "Переименовать", "aria-label": "Переименовать", onclick: async (e) => {
              e.stopPropagation(); close();
              const t = await ask("Название чата", "Например: Ремонт кухни", chatTitle(c));
              if (t) { const chats = chatsAll(); const x = chats.find((y) => y.id === c.id); if (x) { x.title = t.slice(0, 60); store.set("chats", chats); refreshTop(); } }
            } }),
            el("button", { class: "round ghost", icon: "trash", title: "Удалить", "aria-label": "Удалить",
              onclick: (e) => { e.stopPropagation(); close(); delChat(c); } })));
        }
      });
    }
    act.onclick = () => (act.dataset.send ? sendNow() : record());
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); sendNow(); } });

    function record() {
      dictate(row, (t) => (S.idea || S.busy[chatName(cur)] ? ((ta.value = t), sync(), sendNow({ voice: true }))
        : th.ask({ text: t, voice: true }, { role: "me", text: "🎤 " + t, ctx: t })));
    }
    function attachMenu() {
      menu("Прикрепить", [
        ["📷", "Камера", async () => { const f = await pickFile("image/*", true); if (f) { image = f; sync(); } }],
        ["🖼️", "Фото из галереи", async () => { const f = await pickFile("image/*"); if (f) { image = f; sync(); } }],
        ["📄", "Документ: PDF, Word, текст", async () => {
          const f = await pickFile(".pdf,.docx,.doc,.pptx,.ppt,.xlsx,.xls,.odt,.ods,.odp,.rtf,.epub,.txt,.md,.csv,.json,.html,text/*,application/pdf");
          if (f) { if (f.size > 14e6) toast("Файл больше 14 МБ — возьмите поменьше"); else { doc = f; sync(); } }
        }],
        ["💡", "Готовые задачи", ideasMenu],
      ]);
    }
    function ideasMenu() {
      menu("Готовые задачи", Object.entries(S.me.ideas).map(([k, v]) => {
        const s = emo(v[0]), i = s.indexOf(" ");
        return [IDEA_ICONS[k] ? icon(IDEA_ICONS[k]) : s.slice(0, i), s.slice(i + 1), () => pickIdea(k)];
      }));
    }
    bind();
    if (cur !== "main") openChat(cur);
    return {
      root, redraw: () => th.redraw(),
      shot: (f) => { image = f; sync(); },  // a camera shot that came back after Android had closed the app
      // the answer mode first: a long chat title is the one cut short, never the mode
      sub: () => [S.me.mode !== "chat" ? S.me.modes[S.me.mode] : "",
        chatsAll().length > 1 ? chatTitle(chatsAll().find((c) => c.id === cur) || { id: cur }) : ""].filter(Boolean).join(" · "),
      buttons: () => [["🗂️ Чаты", "Чаты", chatsSheet], ["✏️ Новый", "Новый чат", newChat]],
      attachImage(im) { image = im; sync(); },
      onShow: () => th.down(),
    };
  }

  // ---------- Study ----------
  const GRADES = [["1", "1 класс"], ["2", "2 класс"], ["3", "3 класс"], ["4", "4 класс"], ["5", "5 класс"], ["6", "6 класс"], ["7", "7 класс"],
    ["8", "8 класс"], ["9", "9 класс"], ["10", "10 класс"], ["11", "11 класс"], ["s1", "Студент, 1 курс"], ["s2", "Студент, 2 курс"],
    ["s3", "Студент, 3 курс"], ["s4", "Студент, 4+ курс"], ["a", "Взрослый"]];
  const STUDY_MODES = {
    solve: ["🧮 Решить", "Полное решение с объяснением и ответом — как оформляют в школе."],
    explain: ["💡 Объяснить", "Подсказки и объяснение по шагам, без готового ответа — чтобы научиться самому."],
    check: ["🔍 Проверить", "Сфотографируйте своё решение: найду ошибки и объясню, как исправить."],
    essay: ["✍️ Сочинение", "Сочинение, эссе или изложение по теме — под возраст и требования."],
    notes: ["📝 Конспект", "Сфотографируйте параграф: конспект главного и тест из 5 вопросов, чтобы проверить себя."],
    retell: ["📖 Пересказ", "Сфотографируйте текст: пересказ своими словами, план и главная мысль."],
  };
  function studyView() {
    const root = el("div", { class: "view" });
    const scroll = el("div", { class: "scroll" });
    let mode = store.get("studyMode", "solve");
    if (!STUDY_MODES[mode]) mode = "solve";
    let grade = store.get("grade", "5");
    let open = false;  // the grade and the modes shown in full above the answers
    const head = el("div");
    const gradeName = () => (GRADES.find((g) => g[0] === grade) || ["", ""])[1];
    // with typed words the bubble keeps only the mode's sign: «✅ Реши: 2x + 5 = 17», not «✅ Решить: Реши: …»
    const modeSign = () => STUDY_MODES[mode][0].split(" ")[0];
    const tail = () => (S.msgs.study.length ? el("div", { class: "tail big-actions next" },
      el("button", { class: "btn", onclick: () => shoot(true) }, ...lead("📷 Новое задание")),
      el("button", { class: "btn line", onclick: () => shoot(false) }, ...lead("🖼️ Из галереи"))) : null);
    const th = thread("study", scroll, null, tail);
    th.onRedraw = () => drawHead();
    scroll.append(head, th.box);
    const ta = el("textarea", { rows: 1, placeholder: "Ваш вопрос" });
    autoGrow(ta);
    const cam = el("button", { class: "round ghost", icon: "camera", title: "Фото задания", "aria-label": "Фото задания", onclick: () => shoot(true) });
    const act = el("button", { class: "round main" });
    voiceOrSend(act, false);
    const row = el("div", { class: "inrow" }, cam, ta, act);
    const composer = el("div", { class: "composer" }, row);
    root.append(scroll, composer);
    const syncAct = () => voiceOrSend(act, !!ta.value.trim());
    ta.addEventListener("input", syncAct);
    act.onclick = () => (ta.value.trim() ? submit() : dictate(row, (t) => { ta.value = t; submit(); }));

    function drawHead() {
      head.innerHTML = "";
      const has = S.msgs.study.length > 0;
      if (has && !open) {
        head.append(el("button", { class: "card study-line", onclick: () => { open = true; drawHead(); } },
          el("span", { class: "grow mode-line" }, gradeName() + " · ", ...lead(STUDY_MODES[mode][0])), el("span", { class: "muted chev-after", text: "Изменить" }, icon("chev"))));
      } else {
        const sel = el("select", { "aria-label": "Кто учится", onchange: () => { grade = sel.value; store.set("grade", grade); refreshTop(); } });
        for (const [k, v] of GRADES) sel.append(el("option", { value: k, text: v, selected: k === grade }));
        const seg = el("div", { class: "seg grid2", style: "margin-top:8px" });
        for (const [k, v] of Object.entries(STUDY_MODES)) {
          seg.append(el("button", { class: k === mode ? "on" : "", "aria-pressed": k === mode ? "true" : "false",
            onclick: () => { mode = k; store.set("studyMode", k); open = false; drawHead(); } }, ...lead(v[0])));
        }
        head.append(el("div", { class: "card" },
          el("div", { class: "row" }, el("div", { class: "grow" }, "Кто учится"), sel),
          seg, el("div", { class: "study-desc", text: STUDY_MODES[mode][1] })));
        if (!has) {
          head.append(el("div", { class: "big-actions", style: "margin-bottom:12px" },
            el("button", { class: "big primary", onclick: () => shoot(true) }, well("ic", "", "camera"), "Снять задание"),
            el("button", { class: "big", onclick: () => shoot(false) }, well("ic", "", "photo"), "Из галереи")));
        }
      }
      ta.placeholder = mode === "essay" ? "Тема сочинения" : S.msgs.study.length ? "Что непонятно?"
        : mode === "notes" || mode === "retell" ? "Текст или тема" : "Ваш вопрос";
    }
    async function shoot(camera) {
      const f = await pickFile("image/*", camera);
      if (f) solve(f);
    }
    async function solve(im, text) {
      open = false;
      const shown = text ? modeSign() + " " + text : STUDY_MODES[mode][0];
      const body = { mode, grade, text: text || "", context: [] };
      body.image = await b64(await shrink(im, 1800, 0.9));
      await th.run("/api/study", body, { role: "me", text: shown, image: im });
      open = false;
      drawHead();
    }
    function submit() {
      const text = ta.value.trim();
      if (!text) return;
      if (S.busy.study) { toast("Подождите, ещё отвечаю… Вопрос остался в поле."); return; }  // kept, not lost
      ta.value = "";
      ta.style.height = "auto";
      syncAct();
      open = false;
      const follow = S.msgs.study.length > 0 && !["essay", "notes", "retell"].includes(mode);
      th.run("/api/study", { mode: follow ? "ask" : mode, grade, text, context: follow ? context("study") : [] },
        { role: "me", text: follow ? text : modeSign() + " " + text }).then(() => { open = false; drawHead(); });
    }
    th.ask = async (req, mine) => {
      await th.run("/api/study", Object.assign({ mode: "ask", grade, context: context("study"), text: "" }, req), mine);
    };
    th.redraw();
    return {
      root, th, redraw: th.redraw, solve, shot: (f) => solve(f),
      sub: gradeName,
      // «🧹 Очистить» only when there is something to clear (thread.add() puts it on top with the first message)
      buttons: () => (S.msgs.study.length ? [["🧹 Очистить", "Очистить", async () => {
        if (!S.msgs.study.length) { toast("Здесь пока пусто"); return; }
        if (!(await confirmBox("Очистить решения? Задания и ответы удалятся с телефона.", "Очистить", true))) return;
        await DB.clear("study");
        S.msgs.study = [];
        open = false;
        th.redraw();
        refreshTop();
      }]] : []),
      onShow: () => th.down(),
    };
  }

  // ---------- Photo: send a photo and say what to do; without a photo, describe a picture to draw ----------
  // on the chosen photo (each only when the server has it); the rest under «🧰 Другое» or in words. (1040) «coloring»: a
  // colouring page for children; «neat»: a handwritten letter rewritten neatly
  const QUICK = ["enhance", "removebg", "restore", "colorize", "scan", "coloring", "neat"];
  // clearer names for some of the server's tools (only renames: the tools themselves are the server's)
  const OP_NAMES = { restore: "👴 Восстановить старое", scan: "📑 Скан документа", bw: "⬛ Чёрно-белое", cartoon: "🦸 Мульт",
    oil: "🖌️ Картина маслом", blurbg: "🌫️ Размыть фон", vintage: "🎞️ Винтаж", coloring: "🖍️ Раскраска", neat: "📝 Переписать аккуратно" };
  const STYLE_ASKS = { anime: ["🎌", "В стиле аниме", "Перерисуй в стиле аниме"], toon: ["🧸", "Как в мультфильме", "Сделай как кадр из мультфильма Pixar, 3D"],
    gogh: ["🌻", "Как картина Ван Гога", "Перерисуй как картину Ван Гога"], sea: ["🏖️", "Фон — море", "Замени фон на берег моря"],
    people: ["🚶", "Убрать лишних людей", "Убери посторонних людей на заднем плане"] };
  const PHOTO_SECS = [["Фон", ["whitebg", "blurbg", "sea", "people"]], ["Цвет и качество", ["upscale", "vivid", "bw", "vintage"]],
    ["Стиль", ["anime", "toon", "gogh", "sketch", "cartoon", "oil", "sticker"]]];
  const DRAW_HINTS = ["Рыжий кот-космонавт на Луне, акварель", "Уютный домик в снежном лесу ночью", "Открытка с днём рождения для мамы"];
  function photoView() {
    const root = el("div", { class: "view" });
    const scroll = el("div", { class: "scroll" });
    let photo = null;  // the photo chosen now; a job takes it away, the next step is chosen again
    const shootOk = () => !!((S.me.can || {}).shoot || S.me.panel) && !!S.me.shoot;
    const empty = () => (photo ? null : el("div", { class: "empty" }, el("h2", { text: "Что сделать с фото?" }),
      el("p", { text: "Пришлите фото и скажите или напишите, что сделать: «убери фон», «раскрась», «сделай в стиле аниме»." }),
      el("div", { class: "big-actions", style: "margin:16px 0 4px" },
        el("button", { class: "big primary", onclick: () => pick(true) }, well("ic", "", "camera"), "Снять фото"),
        el("button", { class: "big", onclick: () => pick(false) }, well("ic", "", "photo"), "Из галереи"),
        trendsOk() ? el("button", { class: "big wide", onclick: () => trendsSheet(th, "photo") }, well("ic", "", "flame"),
          el("span", {}, "Фото-тренды", el("small", { text: "в один клик: Хэллоуин, фигурка в коробке, обнять себя в детстве" }))) : null,
        shootOk() ? el("button", { class: "big wide", onclick: () => shootSheet(th) }, well("ic", "", "people"),
          el("span", {}, "Фотосессия", el("small", { text: "вы и близкие (до четырёх) на фото по теме: море, Новый год, журнал…" }))) : null,
        has("animate") ? el("button", { class: "big wide", onclick: liven }, well("ic", "", "film"),
          el("span", {}, "Оживить фото", el("small", { text: "фото станет коротким роликом: улыбка, взгляд, лёгкое движение" }))) : null),
      S.me.can.draw ? [el("h3", { class: "empty-sec", text: "Или опишите — я нарисую:" }),
        el("div", { class: "hints" }, DRAW_HINTS.map((t) => el("button", { class: "hint", text: t, onclick: () => { ta.value = t; ta.dispatchEvent(new Event("input")); ta.focus(); } })))] : null));
    const has = (op) => !!(S.me.photo_ops[op] || S.me.ai_ops[op]);
    // the chosen photo, big, with what can be done to it; with no photo under the results, the big ways to the next one
    // (the empty screen with them is gone once there is a result)
    const chosen = () => (photo ? el("div", { class: "tail chosen" },
      el("div", { class: "preview" }, el("img", { src: urlOf(photo), alt: "", onclick: () => viewer(photo, "photo.jpg") }),
        el("button", { class: "x", icon: "x", "aria-label": "Убрать фото", onclick: () => { photo = null; sync(); th.redraw(); refreshTop(); } })),
      el("div", { class: "chosen-q", text: "Что сделать с этим фото?" }),
      tools(QUICK.filter(has).map((op) => tool(label(op), () => runOp(op))),
        tool("✍️ Своё изменение", own),
        has("animate") ? tool("🎬 Оживить", () => runOp("animate")) : null,
        trendsOk() ? tool("🔥 Фото-тренды", () => trendsSheet(th, "photo")) : null,
        shootOk() ? tool("📸 Фотосессия", () => shootSheet(th)) : null,
        tool("🧰 Другое", more)))
      // pages for a PDF being collected: their banner over the input is the next step (no second «📷» here)
      : S.scan.length ? null
      : S.msgs.photo.length ? el("div", { class: "tail big-actions next", style: "grid-template-columns:1fr 1fr" },
        el("div", { class: "menu-sec", style: "grid-column:1/-1;padding:4px 2px 0", text: "Новое фото" }),
        el("button", { class: "btn", onclick: () => pick(true) }, ...lead("📷 Снять фото")),
        el("button", { class: "btn line", onclick: () => pick(false) }, ...lead("🖼️ Из галереи")),
        trendsOk() ? el("button", { class: "btn line", style: "grid-column:1/-1", onclick: () => trendsSheet(th, "photo") }, ...lead("🔥 Фото-тренды")) : null,
        shootOk() ? el("button", { class: "btn line", style: "grid-column:1/-1", onclick: () => shootSheet(th) }, ...lead("📸 Фотосессия")) : null)
      : null);
    const th = thread("photo", scroll, empty, chosen);
    scroll.append(th.box);
    const scanBar = el("div", { class: "banner hidden" });
    const ownHint = el("div", { class: "idea-hint hidden" });  // «✍️ Своё»: what to say, above the input
    const ta = el("textarea", { rows: 1 });
    autoGrow(ta);
    const cam = el("button", { class: "round ghost", icon: "camera", title: "Выбрать фото", "aria-label": "Выбрать фото", onclick: () => menu("Выбрать фото", [
      ["📷", "Снять фото", () => pick(true)], ["🖼️", "Из галереи", () => pick(false)],
      trendsOk() ? ["🔥", "Фото-тренды", () => trendsSheet(th, "photo")] : null,
      shootOk() ? ["📸", "Фотосессия", () => shootSheet(th)] : null]) });
    const act = el("button", { class: "round main" });
    voiceOrSend(act, false);
    const row = el("div", { class: "inrow" }, cam, ta, act);
    root.append(scroll, el("div", { class: "composer" }, scanBar, ownHint, row));

    function label(op) { return OP_NAMES[op] || emo(S.me.photo_ops[op] || S.me.ai_ops[op] || op); }
    // the picture that just came out: words typed after it change it (unless they ask to draw anew)
    function lastPic() {
      const m = S.msgs.photo[S.msgs.photo.length - 1];
      return m && m.role === "ai" && m.result && /^image\//.test(m.result.type || "") ? m.result : null;
    }
    function sync() {
      voiceOrSend(act, !!ta.value.trim());
      // a placeholder stays one line even at a large font (1.3× on 360: under ~16 letters); a longer «how» goes into
      // ownHint above the input
      ta.placeholder = photo ? "Что сделать?" : lastPic() ? "Что изменить?" : S.me.can.draw ? "Что нарисовать?" : "Сначала пришлите фото";
      if (!photo) ownHint.classList.add("hidden");
      scanBar.innerHTML = "";
      scanBar.classList.toggle("hidden", !S.scan.length);
      if (S.scan.length) {
        // while pages are collected, this is the one place for the next step: the tail under the result steps aside.
        // «Собрать PDF» is the filled one; its count is on the line just above (with it, it no longer fits one line at 360)
        scanBar.append(el("span", { class: "grow", icon: "scan" }, ` Страниц для PDF: ${S.scan.length}`),
          el("button", { class: "act", icon: "x", "aria-label": "Убрать страницы", onclick: async () => {
            if (!(await confirmBox(`Убрать собранные страницы (${S.scan.length})? PDF не соберётся.`, "Убрать", true))) return;
            S.scan = [];
            sync();
            th.redraw();
          } }),
          el("div", { class: "banner-acts" },
            el("button", { class: "btn line", onclick: () => menu("Ещё страница", [
              ["📷", "Снять", () => page(true)], ["🖼️", "Из галереи", () => page(false)]]) }, ...lead("📷 Ещё страница")),
            el("button", { class: "btn", onclick: makePdf }, ...lead("📄 Собрать PDF"))));
      }
    }
    ta.addEventListener("input", sync);
    act.onclick = () => (ta.value.trim() ? send() : dictate(row, (t) => { ta.value = t; send(); }));
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); send(); } });
    function own() {
      ta.placeholder = "Что изменить?";  // the examples are in ownHint over it: a placeholder fits one line at a large font
      ownHint.textContent = "Скажите или напишите, что изменить: «сделай зиму», «добавь шляпу»";
      ownHint.classList.remove("hidden");
      ta.focus();
    }
    function more() {
      const edit = !!S.me.ai_ops.edit;  // the AI's styles stand in for the plain «Мульт» and «Масло»
      const ok = (k) => (STYLE_ASKS[k] ? edit : !!S.me.photo_ops[k] && !QUICK.includes(k) && k !== "animate" && !(edit && (k === "cartoon" || k === "oil")));
      const item = (k) => {
        if (STYLE_ASKS[k]) { const [ic, name, words] = STYLE_ASKS[k]; return [ic, name, () => { ta.value = words; send(); }]; }
        const s = label(k), i = s.indexOf(" ");
        return i > 0 ? [s.slice(0, i), s.slice(i + 1), () => runOp(k)] : ["•", s, () => runOp(k)];
      };
      const items = [["✍️", "Своё изменение — скажите или напишите", own]];
      const seen = new Set();
      for (const [sec, keys] of PHOTO_SECS) {
        const here = keys.filter(ok);
        keys.forEach((k) => seen.add(k));
        if (here.length) items.push(sec, ...here.map(item));
      }
      const rest = Object.keys(S.me.photo_ops).filter((k) => !seen.has(k) && ok(k));
      if (rest.length) items.push("Ещё", ...rest.map(item));
      menu("Что сделать с фото", items);
    }
    // while a job is running a new photo would wait unseen under «Думаю…»: say so before the phone's picker opens
    const BUSY = "Подождите, предыдущее фото ещё делается";
    async function pick(camera) {
      if (S.busy.photo) { toast(BUSY); return; }
      const f = await pickFile("image/*", camera);
      if (f) set(f);
    }
    async function liven() {  // (v40) «🎬 Оживить фото» on the empty screen: a photo, then straight to «Оживить»
      if (S.busy.photo) { toast(BUSY); return; }
      const f = await pickFile("image/*", false);
      if (!f) return;
      photo = f;
      // (v40, the review) the length not chosen (×, outside, Back): no photo left chosen unseen — cleared, redrawn as set() does
      runOp("animate", () => { if (photo === f) { photo = null; sync(); th.redraw(); } });
    }
    async function page(camera) {  // one more page for the PDF: straight to «Скан»
      if (S.busy.photo) { toast(BUSY); return; }
      const f = await pickFile("image/*", camera);
      if (!f) return;
      photo = f;
      runOp("scan");
    }
    function set(im) {  // «✏️ Изменить ещё» and the viewer come here too
      if (S.busy.photo) { show("photo"); toast(BUSY); return; }
      photo = im; show("photo"); sync(); th.redraw();
    }
    async function go(path, body, shown) {
      if (S.busy.photo) { toast("Подождите, предыдущее ещё делается"); return; }
      const im = photo;  // the job takes the photo: the next step is chosen anew
      photo = null;
      th.box.querySelectorAll(".tail").forEach((x) => x.remove());
      sync();
      refreshTop();
      if (im) body.image = await b64(await shrink(im, 3072, 0.92));
      const out = await th.run(path, body, { role: "me", image: im, text: shown });
      if (out && out.op === "scan" && out.result) { S.scan.push(out.result); th.redraw(); }
      sync();
    }
    function runOp(op, dismissed) {
      if (op === "animate") menu("Длина ролика", [["⏱️", "5 секунд — быстрее", () => go("/api/animate", { seconds: 5 }, label(op) + " · 5 с")],
        ["🎞️", "10 секунд", () => go("/api/animate", { seconds: 10 }, label(op) + " · 10 с")]], dismissed);  // (v36) up to 10 s
      else go("/api/photo", { op }, label(op));
    }
    function send() {
      const text = ta.value.trim();
      if (!text) return;
      if (S.busy.photo) { toast("Подождите, предыдущее ещё делается"); return; }
      if (!photo && !(/^\s*нарису/i.test(text) && S.me.can.draw)) photo = lastPic();
      if (!photo && !S.me.can.draw) { toast("Сначала пришлите фото: кнопка с фотоаппаратом слева"); return; }
      ta.value = "";
      ta.style.height = "auto";
      ownHint.classList.add("hidden");
      sync();
      if (photo) go("/api/photo_do", { text }, text);
      else go("/api/draw", { prompt: text }, "🎨 " + text);
    }
    async function makePdf() {
      if (S.busy.photo || !S.scan.length) return;
      // one request carries at most 24 MB: the pages that do not fit wait for the next PDF
      let size = 0, k = 0;
      for (const b of S.scan) { size += Math.ceil((b.size || 0) / 3) * 4; if (k && size > 22e6) break; k++; }
      const pages = await Promise.all(S.scan.slice(0, k).map((b) => b64(b)));
      const n = pages.length;
      const out = await th.run("/api/pdf", { pages }, { role: "me", text: `📄 Собрать PDF: ${n} стр.` });
      if (out && out.pdf) {
        out.name = out.name || "scan.pdf";
        S.scan = S.scan.slice(n);
        if (S.scan.length) toast(`Не все страницы влезли в один файл. Остальные (${S.scan.length}) — нажмите «Собрать PDF» ещё раз`);
        sync();
        th.redraw();
      }
    }
    sync();
    th.redraw();
    return {
      root, th, set, redraw: th.redraw, shot: (f) => set(f),
      current: () => photo,  // the photo chosen now (null when none): the trend and photo-session sheets offer it for a face
      // a job started elsewhere (🔥 Фото-тренды, 📸 Фотосессия) takes the choice away too: no «Что сделать с этим фото?» under its result
      drop() { photo = null; ownHint.classList.add("hidden"); sync(); },
      sub: () => (photo ? "фото выбрано" : S.me.can.draw ? "улучшить, изменить, нарисовать" : "улучшить и изменить фото"),
      buttons: () => (S.msgs.photo.length ? [["🧹 Очистить", "Очистить", async () => {
        if (!S.msgs.photo.length) { toast("Здесь пока пусто"); return; }
        if (!(await confirmBox("Удалить все готовые фото и картинки из списка?", "Очистить", true))) return;
        await DB.clear("photo");
        S.msgs.photo = [];
        S.scan = [];  // the pages for a PDF go with the pictures: no banner over an empty screen
        sync();
        th.redraw();
        refreshTop();
      }]] : []),
      onShow: () => th.down(),
    };
  }

  // ---------- «🔥 Тренды» (v34): as on the trend sites — sections, a search, tall cards with «ХИТ»; a card: what it is,
  // the photos it asks for, «Повторить». The result comes into the Фото thread (a video trend: a clip) ----------
  const trendsOk = () => !!((S.me.can || {}).trends || S.me.panel);
  // the panel itself: the Видео tab shows it on its screen (video trends), the Фото tab in a sheet (photo trends)
  function trendsPanel(th, kind, before) {
    let cat = "", q = "", data = null;
    const search = el("input", { class: "input", type: "search", placeholder: "Найти тренд", "aria-label": "Найти тренд",
      oninput: () => { q = search.value.trim().toLowerCase(); paint(); } });
    const chips = el("div", { class: "chips fade" });
    const grid = el("div", { class: "trend-grid" }, el("div", { class: "status gal-msg" }, el("span", { class: "spin" }), el("span", { text: "Загружаю…" })));
    const pics = el("p", { class: "muted hidden", style: "margin:0 0 8px;font-size:13px" });  // (v36) the owner: are the pictures coming
    const box = el("div", { class: "trends" }, el("h2", { class: "trend-title", text: "ТРЕНДЫ" }),
      el("p", { class: "muted", style: "margin:0 0 10px;font-size:15px", text: kind === "video"
        ? "Повторяйте актуальные видео-тренды в один клик — выберите сценарий, загрузите фото и получите готовое видео."
        : "Повторяйте фото-тренды в один клик — выберите тренд, загрузите фото и получите готовый снимок." }),
      search, pics, el("div", { class: "sheet-stick" }, chips), grid);
    function paint() {
      if (!data) return;
      const mine = data.items.filter((t) => t.kind === kind);
      const cats = data.cats.filter((c) => mine.some((t) => t.cats.includes(c)));  // (a section with nothing in it: not shown)
      chips.innerHTML = "";
      for (const c of [""].concat(cats)) {
        chips.append(el("button", { class: "chip" + (c === cat ? " on" : ""), "aria-pressed": c === cat ? "true" : "false",
          text: c || "Все", onclick: () => { cat = c; paint(); } }));
      }
      grid.innerHTML = "";
      const list = mine.filter((t) => (!cat || t.cats.includes(cat)) && (!q || (t.title + " " + t.desc).toLowerCase().includes(q)));
      for (const t of list) {
        // (design B) the picture (cut from the bottom only: its own «ИИ» mark, top left, stays in sight) and the name
        // under it, «ХИТ» beside the name
        grid.append(el("button", { class: "tcard" + (t.hit ? " hit" : ""), "aria-label": t.title + (t.hit ? " — хит" : ""), onclick: () => { if (before) before(); trendCard(th, t); } },
          el("span", { class: "tcard-pic" },
            t.thumb ? el("img", { src: "data:image/jpeg;base64," + t.thumb, alt: "" }) : el("span", { class: "tcard-wait", icon: "sparkle" }),
            t.fresh ? el("span", { class: "tcard-new", text: "НОВОЕ" }) : null,  // (a trend found on the web this week)
            t.clip ? el("span", { class: "tcard-play", "aria-hidden": "true", icon: "play" }) : null),  // (v36) an example clip inside
          el("span", { class: "tcard-name" }, t.title, t.hit ? el("span", { class: "tcard-hit inline", text: "ХИТ" }) : null)));
      }
      if (!list.length) grid.append(el("p", { class: "gal-msg muted", text: q ? "Ничего не нашлось — попробуйте другое слово." : "В этом разделе пока пусто." }));
    }
    api("/api/trends", {}).then((r) => {
      data = r;
      const p = r.pics || {};
      if (S.me.panel && p.all && p.drawn < p.all) {
        pics.textContent = `🎨 Картинки карточек: ${p.drawn} из ${p.all}` + (p.why ? ` — ${p.why}` : " — дорисовываю");
        pics.classList.remove("hidden");
      }
      paint();
    }).catch((e) => {
      grid.innerHTML = "";
      grid.append(el("p", { class: "gal-msg", text: problem(e) }));
    });
    return box;
  }
  function trendsSheet(th, kind) {
    if (S.busy[th.name]) { toast(kind === "video" ? "Подождите, ролик ещё делается" : "Подождите, предыдущее фото ещё делается"); return; }
    if (!trendsOk()) { toast("Тренды пока не включены — их включает владелец помощника.", 5000); return; }
    sheet("", (box, close) => box.append(trendsPanel(th, kind, close)));
  }
  function trendCard(th, t) {
    const photos = t.photos.map(() => null);
    const mine = th.name === "photo" && S.views.photo && S.views.photo.current ? S.views.photo.current() : null;
    if (mine) photos[0] = mine;
    if (S.busy[th.name]) { toast(t.kind === "video" ? "Подождите, ролик ещё делается" : "Подождите, предыдущее фото ещё делается"); return; }
    sheet("", (box, close) => {
      const why = el("div", { class: "why" });
      const rows = el("div");
      const take = async (i, camera) => {
        const f = await pickFile("image/*", camera);
        if (!f) return;
        photos[i] = f;
        if (why.textContent.startsWith("Добавьте")) why.textContent = "";
        paintRows();
      };
      const paintRows = () => {
        rows.innerHTML = "";
        t.photos.forEach((who, i) => {
          const p = photos[i];
          rows.append(el("div", { class: "who-row" },
            el("button", { class: "slot" + (p ? " set" : ""), "aria-label": "Фото: " + who, onclick: () => menu(who, [
              ["📷", "Снять фото", () => take(i, true)], ["🖼️", "Из галереи", () => take(i, false)]]) },
              p ? el("img", { src: urlOf(p), alt: "" }) : el("span", {}, el("b", { class: "plus", text: "+" }), "фото")),
            el("div", { class: "who" }, el("b", { text: who }), el("small", { text: p ? "✓ фото есть" : "лицо крупно и прямо, при хорошем свете" }))));
        });
      };
      const check = el("input", { type: "checkbox", onchange: () => { if (check.checked && why.textContent.startsWith("Поставьте")) why.textContent = ""; } });
      const video = t.kind === "video";
      let secs = 10;  // (v36) the clip's length: 10 s unless 5 is chosen
      let swap = false;  // (v37) «🎭 Я в примере»: the example clip with you in it (MiniMax-H3, with sound, 5 s)
      const schips = el("div", { class: "chips", style: "margin:0 0 6px" });
      const mchips = el("div", { class: "chips how-chips", style: "margin:0 0 6px;flex-wrap:wrap;overflow:visible" });
      const secsHead = el("div", { class: "menu-sec", text: "Длина ролика" });
      const paintSecs = () => {
        schips.innerHTML = "";
        for (const [k, v] of [[10, "10 секунд"], [5, "5 секунд — быстрее"]]) {
          schips.append(el("button", { class: "chip" + (k === secs ? " on" : ""), "aria-pressed": k === secs ? "true" : "false", text: v, onclick: () => { secs = k; paintSecs(); } }));
        }
        mchips.innerHTML = "";
        for (const [k, v] of [[false, "🎬 Оживить сцену"], [true, "🎭 Я в примере · со звуком"]]) {
          mchips.append(el("button", { class: "chip" + (k === swap ? " on" : ""), "aria-pressed": k === swap ? "true" : "false", text: v, onclick: () => { swap = k; paintSecs(); } }));
        }
        schips.style.display = secsHead.style.display = swap ? "none" : "";
      };
      paintSecs();
      const big = el("div", { class: "tcard-big" }, t.thumb ? el("img", { src: "data:image/jpeg;base64," + t.thumb, alt: "" }) : el("span", { class: "tcard-wait", icon: "sparkle" }));
      if (t.clip) {  // (v36) the example clip: what will be made, the card's picture brought to life
        api("/api/trend_clip", { id: t.id }).then((r) => {
          if (!big.isConnected && !document.body.contains(big)) return;
          const v = el("video", { src: "data:" + r.mime + ";base64," + r.video, autoplay: "", loop: "", muted: "", playsinline: "", "aria-label": "Пример ролика" });
          v.muted = true;
          big.innerHTML = "";
          big.append(v, el("span", { class: "tcard-kind", text: "пример" }));
          v.play().catch(() => {});
        }).catch(() => {});
      }
      const goBtn = el("button", { class: "btn wide", text: "Повторить", onclick: async () => {
        if (photos.some((p) => !p)) { why.textContent = "Добавьте фото: " + t.photos.join(", ").toLowerCase() + "."; return; }
        if (!check.checked) { why.textContent = "Поставьте галочку: это ваши фото, или человек согласен."; return; }
        if (video && !(S.me.can || {}).trends_video && !S.me.panel) { why.textContent = "Видео-тренды вам пока не включены — их включает владелец помощника."; return; }
        goBtn.disabled = true;
        goBtn.textContent = "Готовлю фото…";
        why.textContent = "";
        const images = [];
        try {
          for (const p of photos) images.push(await b64(await shrink(p, 1600, 0.9)));
        } catch (e) {
          goBtn.disabled = false;
          goBtn.textContent = "Повторить";
          why.textContent = "Не получилось прочитать фото — выберите другое.";
          return;
        }
        if (!goBtn.isConnected) return;
        close();
        if (th.name === "photo" && S.views.photo && S.views.photo.drop) { S.views.photo.drop(); refreshTop(); }
        await th.run("/api/trend", Object.assign({ trend: t.id, images, consent: true }, video ? (swap ? { swap: true } : { seconds: secs }) : {}),
          { role: "me", image: photos[0], text: "🔥 " + t.title + (video ? (swap ? " · я в ролике" : " · " + secs + " с") : "") });
      } });
      paintRows();
      box.append(
        big,
        el("h2", { class: "trend-name" }, t.title, t.hit ? el("span", { class: "tcard-hit inline", text: "ХИТ" }) : null),
        el("p", { class: "muted", style: "margin:0 0 10px;font-size:15px", text: t.desc }),
        video && t.swap ? el("div", { class: "menu-sec", text: "Как сделать" }) : null, video && t.swap ? mchips : null,
        video ? secsHead : null, video ? schips : null,
        el("div", { class: "menu-sec", text: t.photos.length > 1 ? "Ваши фото" : "Ваше фото" }), rows,
        el("div", { class: "sheet-foot" },
          el("label", { class: "agree" }, check, el("span", { text: t.photos.length > 1 ? "Это мои фото, или люди на них согласны" : "Это моё фото, или человек согласен" })),
          el("p", { class: "muted", style: "margin:4px 0;font-size:13px", text: video ? "Ролик будет готов за 2–6 минут (в ролике-примере — до 10), с пометкой «ИИ»." : "Обычно готово за минуту, с пометкой «ИИ»." }),
          why, goBtn));
    });
  }
  // ---------- «📸 Фотосессия»: a theme (the server's list or one's own words), 1–4 people with a photo each, the shape,
  // 1–4 pictures (v36) — they come into the Фото thread ----------
  function shootSheet(th) {
    if (S.busy[th.name]) { toast("Подождите, предыдущее фото ещё делается"); return; }
    if (!(S.me.can || {}).shoot && !S.me.panel) { toast("Фотосессия пока не включена — её включает владелец помощника.", 5000); return; }
    const themes = S.me.shoot || {};
    const mine = S.views.photo && S.views.photo.current ? S.views.photo.current() : null;
    const photos = [mine || null];  // one row to start; the photo chosen in Фото is the first person's
    let theme = "", aspect = "3:4", count = 4;  // (v36) up to 4 pictures
    sheet("📸 Фотосессия", (box, close) => {
      const why = el("div", { class: "why" });
      // (v29) one's own words first — the server's art director makes a whole scene of them; the themes as tiles under
      // it (a few in sight, the rest a tap away): a tile alone is a ready scene, a tile with words — the theme with one's wishes
      const own = el("textarea", { class: "input", rows: 2, maxlength: "300", style: "resize:none;min-height:64px",
        placeholder: "Опишите фотосессию: например, «мы на яхте в Монако на закате» или «я в образе боярыни зимой»" });
      own.addEventListener("input", () => { if (why.textContent.startsWith("Выберите")) why.textContent = ""; });
      const SHOWN = 6;  // two rows in sight: the people's photos stay on the screen of a small phone
      let allThemes = false;
      const tchips = el("div", { class: "shoot-themes", style: "display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin:0 0 6px" });
      const paintThemes = () => {
        tchips.innerHTML = "";
        const list = Object.entries(themes);
        for (const [k, v] of allThemes ? list : list.slice(0, SHOWN)) {
          tchips.append(el("button", { class: "chip" + (k === theme ? " on" : ""), "aria-pressed": k === theme ? "true" : "false",
            style: "white-space:normal;line-height:1.2;padding:8px 4px;font-size:13px;min-height:48px;text-align:center", text: v, onclick: () => {
              theme = theme === k ? "" : k;
              if (why.textContent.startsWith("Выберите")) why.textContent = "";
              paintThemes();
            } }));
        }
        if (list.length > SHOWN) tchips.append(el("button", { class: "chip", style: "grid-column:span 2;min-height:44px;font-size:14px",
          text: allThemes ? "Свернуть темы ▴" : `Ещё темы (${list.length - SHOWN}) ▾`, onclick: () => { allThemes = !allThemes; paintThemes(); } }));
        tchips.append(surprise);
      };
      const surprise = el("button", { class: "chip", style: "min-height:44px;font-size:14px;padding:6px 4px", text: "🎲 Удиви", "aria-label": "Удиви меня: случайная тема", onclick: () => {
        const keys = Object.keys(themes).filter((k) => k !== theme);
        if (!keys.length) return;
        theme = keys[Math.floor(Math.random() * keys.length)];
        const i = Object.keys(themes).indexOf(theme);
        if (i >= SHOWN) allThemes = true;
        if (why.textContent.startsWith("Выберите")) why.textContent = "";
        paintThemes();
        toast("Тема: " + themes[theme] + " — можно дописать пожелания", 3000);
      } });
      const rows = el("div");
      const addBtn = el("button", { class: "btn line wide", style: "margin:4px 0 10px", text: "+ Ещё человек", onclick: () => { photos.push(null); paintRows(); } });
      const take = async (i, camera) => {
        const f = await pickFile("image/*", camera);
        if (!f) return;
        photos[i] = f;
        if (why.textContent.startsWith("Добавьте")) why.textContent = "";
        paintRows();
      };
      const paintRows = () => {
        rows.innerHTML = "";
        photos.forEach((p, i) => {
          const who = photos.length === 1 ? "Кто на фото" : "Человек " + (i + 1);
          const slot = el("button", { class: "slot" + (p ? " set" : ""), "aria-label": "Фото: " + who, onclick: () => menu(who, [
            ["📷", "Снять фото", () => take(i, true)], ["🖼️", "Из галереи", () => take(i, false)],
            i > 0 ? ["✕", "Убрать этого человека", () => { photos.splice(i, 1); paintRows(); }] : null]) },
            p ? el("img", { src: urlOf(p), alt: "" }) : el("span", {}, el("b", { class: "plus", text: "+" }), "фото"));
          rows.append(el("div", { class: "who-row" }, slot,
            el("div", { class: "who" }, el("b", { text: who }), el("small", { text: p ? "✓ фото есть" : "лицо крупно и прямо, при хорошем свете" }))));
        });
        addBtn.classList.toggle("hidden", photos.length >= 4);  // (v36) up to four people
      };
      const achips = el("div", { class: "chips", style: "margin:0 0 6px" });
      const paintAspect = () => {
        achips.innerHTML = "";
        for (const [k, v] of [["3:4", "Портрет"], ["1:1", "Квадрат"], ["9:16", "Сторис"]]) {
          achips.append(el("button", { class: "chip" + (k === aspect ? " on" : ""), text: v, onclick: () => { aspect = k; paintAspect(); } }));
        }
      };
      const nchips = el("div", { class: "chips", style: "margin:0 0 6px" });
      const paintCount = () => {
        nchips.innerHTML = "";
        for (const k of [1, 2, 3, 4]) {
          nchips.append(el("button", { class: "chip" + (k === count ? " on" : ""), "aria-pressed": k === count ? "true" : "false", text: String(k), "aria-label": "Снимков: " + k, onclick: () => { count = k; paintCount(); } }));
        }
      };
      const check = el("input", { type: "checkbox", onchange: () => { if (check.checked && why.textContent.startsWith("Поставьте")) why.textContent = ""; } });
      const goBtn = el("button", { class: "btn wide", text: "📸 Сделать фотосессию", onclick: async () => {
        const text = own.value.trim();
        const set = photos.filter(Boolean);
        if (!theme && !text) { why.textContent = "Опишите фотосессию или выберите тему."; return; }
        if (!set.length) { why.textContent = "Добавьте хотя бы одно фото."; return; }
        if (!check.checked) { why.textContent = set.length === 1 ? "Поставьте галочку: фото ваше или человек согласен." : "Поставьте галочку: фото ваши или люди согласны."; return; }
        goBtn.disabled = true;
        goBtn.textContent = "Готовлю фото…";
        why.textContent = "";
        const images = [];
        try {
          for (const p of set) images.push(await b64(await shrink(p, 1600, 0.9)));
        } catch (e) {
          goBtn.disabled = false;
          goBtn.textContent = "📸 Сделать фотосессию";
          why.textContent = "Не получилось прочитать фото — выберите другое.";
          return;
        }
        if (!goBtn.isConnected) return;
        close();
        if (S.views.photo && S.views.photo.drop) { S.views.photo.drop(); refreshTop(); }
        const title = theme ? themes[theme] + (text ? ": " + text : "") : "📸 " + text;
        await th.run("/api/shoot", { theme: theme || undefined, text: text || undefined, images, aspect, n: count, consent: true },
          { role: "me", image: set[0], text: title + (set.length > 1 ? " · 👥 " + set.length : "") });
      } });
      paintThemes();
      paintRows();
      paintAspect();
      paintCount();
      box.append(el("p", { class: "muted", style: "margin:0 0 8px;font-size:15px", text: "Опишите, какую фотосессию хотите, или выберите тему, и добавьте фото — до четырёх человек. Снимков — до четырёх, обычно за 1–3 минуты." }),
        el("div", { class: "menu-sec", text: "Кто на фото" }), rows, addBtn,
        el("div", { class: "menu-sec", text: "Какую фотосессию хотите" }), own,
        el("div", { class: "menu-sec", style: "margin-top:8px", text: "Или тема (можно вместе с описанием)" }), tchips,
        el("div", { class: "menu-sec", text: "Формат" }), achips,
        el("div", { class: "menu-sec", text: "Сколько снимков" }), nchips,
        el("div", { class: "sheet-foot" },
          el("label", { class: "agree" }, check, el("span", { text: "Это мои фото, или люди на них согласны" })), why, goBtn));
    });
  }

  // ---------- Video: «🔥 Видео-тренды» ----------
  function videoView() {
    const root = el("div", { class: "view" });
    const scroll = el("div", { class: "scroll" });
    const NOT_ON = "Видео-тренды вам пока не включены — их включает владелец помощника.";
    // (v35) the tab is the trend sites' «Тренды»: the video trends on its screen («Оживить фото» is in Фото, with the photo)
    const empty = () => (!trendsOk() ? el("div", { class: "empty" }, el("h2", { text: "Видео-тренды" }), el("div", { class: "note-card", text: NOT_ON }))
      : el("div", { class: "empty trends-home" }, trendsPanel(th, "video")));
    const th = thread("video", scroll, empty);
    scroll.append(th.box);
    const trBtn = el("button", { class: "btn", onclick: () => trendsSheet(th, "video") }, ...lead("🔥 Видео-тренды"));
    const bar = el("div", { class: "vbar" });
    const paintBar = () => {  // with the clips made under them, the trends a tap away (with none, they are the screen)
      bar.innerHTML = "";
      if (S.msgs.video.length && trendsOk()) bar.append(trBtn);
      bar.classList.toggle("hidden", !bar.childElementCount);
      comp.style.display = bar.childElementCount ? "" : "none";  // (no empty strip over the tabs)
    };
    th.onRedraw = paintBar;  // (after each change: the bar follows)
    const comp = el("div", { class: "composer" }, bar);
    root.append(scroll, comp);
    paintBar();
    th.redraw();
    return {
      root, th, redraw: th.redraw,
      sub: () => (trendsOk() ? "тренды с вами" : "пока не включено"),
      buttons: () => (S.msgs.video.length ? [["🧹 Очистить", "Очистить", async () => {
        if (!S.msgs.video.length) { toast("Здесь пока пусто"); return; }
        if (!(await confirmBox("Удалить все ролики из списка?", "Очистить", true))) return;
        await DB.clear("video");
        S.msgs.video = [];
        th.redraw();
        refreshTop();
      }]] : []),
      onShow: () => {
        paintBar();
        if (!S.msgs.video.length && !S.busy.video) th.redraw(); else th.down();
      },
    };
  }

  // ---------- More: translator, reminders, settings, memory, app ----------
  // ---------- the owner's mini-apps (written by the server's Claude up to server 29; kept to open or take away) ----------
  // Each is one page, shown in a closed frame of its own: it cannot reach this app's sign-in or anything of the page;
  // what it may do goes through window.app (its own storage here, a note, copy, share, a link, a question to the helper).
  const MA_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https:; "
    + "media-src data: blob: https:; font-src data:; connect-src https:";
  const MA_API = '(function(){var n=0,w={};addEventListener("message",function(e){if(e.source!==parent)return;var d=e.data;'
    + 'if(!d||!d.__ma||!w[d.id])return;w[d.id][d.ok?0:1](d.v);delete w[d.id];});function c(op,a){return new Promise(function(r,j){'
    + 'var i=++n;w[i]=[r,j];parent.postMessage({__ma:1,id:i,op:op,args:a},"*");});}window.app={get:function(k){return c("get",[k])},'
    + 'set:function(k,v){return c("set",[k,v])},remove:function(k){return c("remove",[k])},keys:function(){return c("keys",[])},'
    + 'toast:function(t){return c("toast",[t])},copy:function(t){return c("copy",[t])},share:function(t){return c("share",[t])},'
    + 'open:function(u){return c("open",[u])},ask:function(q){return c("ask",[q])},close:function(){return c("close",[])}};})();';
  const maKey = (id, k) => "ma:" + id + ":" + String(k).slice(0, 100);
  const ls = {  // (the phone's storage may refuse: a full disk, a private window)
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { localStorage.setItem(k, v); },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* nothing to remove */ } },
    keys(prefix) { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(prefix)) out.push(k); } } catch (e) { /* none */ } return out; },
  };
  function maPage(html) {  // the app's page with its rules (nothing from outside but https requests) and window.app first
    const head = '<meta http-equiv="Content-Security-Policy" content="' + MA_CSP + '"><script>' + MA_API + "<\/script>";
    const m = /<head[^>]*>/i.exec(html);
    return m ? html.slice(0, m.index + m[0].length) + head + html.slice(m.index + m[0].length) : head + html;
  }
  let maOpen = null;  // the mini-app on the screen: {id, frame, el}
  let maWanted = "";  // asked to open (its icon on the home screen) before the helper was ready
  async function maCall(cur, op, a) {
    switch (op) {
      case "get": { const v = ls.get(maKey(cur.id, a[0])); return v === null ? null : JSON.parse(v); }
      case "set": {
        const v = JSON.stringify(a[1] === undefined ? null : a[1]);
        if (v.length > 200000) throw new Error("значение больше 200 КБ");
        const used = ls.keys("ma:" + cur.id + ":").reduce((n, k) => n + k.length + (ls.get(k) || "").length, 0);
        if (used + v.length > 2000000) throw new Error("место приложения (2 МБ) кончилось");
        ls.set(maKey(cur.id, a[0]), v);
        return true;
      }
      case "remove": ls.del(maKey(cur.id, a[0])); return true;
      case "keys": return ls.keys("ma:" + cur.id + ":").map((k) => k.slice(cur.id.length + 4));
      case "toast": toast(String(a[0]).slice(0, 300), 4000); return true;
      case "copy": copyText(String(a[0]).slice(0, 100000)); return true;
      case "share": {
        const t = String(a[0]).slice(0, 100000);
        if (Native && Native.shareText) Native.shareText(t);
        else if (navigator.share) navigator.share({ text: t }).catch(() => {});
        else copyText(t);
        return true;
      }
      case "open": {
        const u = String(a[0]);
        if (!/^https:\/\/[^\s]+$/.test(u)) throw new Error("открываются только ссылки https://");
        window.open(u, "_blank", "noopener");
        return true;
      }
      case "ask": {  // a question to the helper (the same answers as in the chat, nothing kept there)
        const end = await stream("/api/chat", { text: String(a[0]).slice(0, 8000) }, () => {});
        if (end.t !== "done") throw new Error(end.text || "помощник не ответил");
        return end.text || "";
      }
      case "close": cur.el.close(); return true;
    }
    throw new Error("нет такого: " + op);
  }
  window.addEventListener("message", async (e) => {
    const cur = maOpen;
    if (!cur || e.source !== cur.frame.contentWindow) return;  // only the app on the screen, nothing else
    const d = e.data;
    if (!d || d.__ma !== 1 || typeof d.op !== "string") return;
    const reply = (ok, v) => { try { e.source.postMessage({ __ma: 1, id: d.id, ok, v }, "*"); } catch (er) { /* closed */ } };
    try { reply(true, await maCall(cur, d.op, Array.isArray(d.args) ? d.args : [])); } catch (er) { reply(false, String((er && er.message) || er)); }
  });
  async function openMiniapp(id) {
    let m = null;
    try {
      const r = await api("/api/miniapps", { op: "miniapp", id });
      if (r.t === "done" && r.html) { m = r; try { ls.set("mah:" + id, JSON.stringify(r)); } catch (e) { /* kept next time */ } }
      else if (r.t === "error") { toast(r.text); ls.del("mah:" + id); return; }
    } catch (e) { /* the server is away: the copy kept here */ }
    if (!m) { try { m = JSON.parse(ls.get("mah:" + id) || "null"); } catch (e) { m = null; } }
    if (!m) { toast("Приложение не загрузилось — нет связи с сервером"); return; }
    if (maOpen) maOpen.el.close();
    const frame = el("iframe", { sandbox: "allow-scripts allow-forms allow-modals", title: m.name });
    frame.srcdoc = maPage(m.html);
    const pin = Native && Native.pinApp
      ? el("button", { class: "icon-btn", title: "На главный экран", "aria-label": "На главный экран", icon: "pin", onclick: () => { if (!Native.pinApp(m.id, m.name, m.icon)) toast("Этот телефон не умеет ставить значки"); } })
      : null;
    const box = el("div", { class: "ma-view", role: "dialog", "aria-label": m.name },
      el("div", { class: "ma-head" }, el("button", { class: "icon-btn", "aria-label": "Назад", icon: "back", onclick: () => box.close() }),
        el("b", { class: "grow", text: m.icon + " " + m.name }), pin), frame);
    box.close = () => { box.remove(); if (maOpen && maOpen.el === box) maOpen = null; };
    maOpen = { id: m.id, frame, el: box };
    document.body.append(box);
  }
  window.__aiMiniapp = (id) => { maWanted = String(id || ""); maTry(); };  // the Android app: an app's icon was tapped
  // a camera shot that came back after Android had closed the app (MainActivity.giveShot): to the section it was taken
  // for — chat, «Учёба», «Фото» — once the screens are drawn (start() tries again at its end)
  let shotWanted = "";
  function shotTry() {
    const tab = store.get("shotTab", "");
    const v = shotWanted && S.views && S.views[tab];
    if (!v) return;
    const url = shotWanted;
    shotWanted = "";
    const lost = () => toast("Снимок не дошёл — снимите ещё раз.");
    if (!v.shot) { lost(); return; }
    fetch(url).then((r) => (r.ok ? r.blob() : null)).then((b) => {
      if (!b || !b.size) { lost(); return; }
      if (S.tab !== tab) show(tab);
      v.shot(new File([b], "camera.jpg", { type: "image/jpeg" }));
    }).catch(lost);
  }
  window.__aiShot = (url) => { shotWanted = String(url || ""); shotTry(); };
  function maTry() {
    if (!maWanted || !S.me) return;
    const id = maWanted;
    maWanted = "";
    if (S.me.panel) openMiniapp(id);
  }
  // (v41) «🎮 Игры»: in a browser — the same site, so the same sign-in; the Android app shows only its own screens, so
  // there the phone's browser opens them (TCP 8443, as the owner's links)
  function openGames() {
    if (!Native) { location.href = "/app/games/"; return; }
    const host = Native.getHost ? Native.getHost() : "";
    if (!host) { toast("Адрес сервера не задан — игры не открыть"); return; }
    window.open("https://" + host + ":8443/app/games/", "_blank", "noopener");
  }
  function moreView() {
    const root = el("div", { class: "view" });
    const scroll = el("div", { class: "scroll" });
    root.append(scroll);
    async function setPref(p) {
      try { S.me = await api("/api/prefs", p); draw(); toast("Сохранено"); } catch (e) { draw(); toast(problem(e)); }
    }
    function draw() {
      const me = S.me;
      scroll.innerHTML = "";
      // the owner's «Ещё» is for work: no translator, reminders or memory (the family keeps them)
      if (!me.panel) scroll.append(el("div", { class: "card" },
        el("button", { class: "row", style: "width:100%;text-align:left", onclick: translator },
          well("well", "", "translate"),
          el("div", { class: "grow" }, "Переводчик", el("small", { text: "Скажите фразу — переведу и прочитаю вслух" })),
          el("span", { class: "chev", icon: "chev" }))));
      // the owner's keys: the same list as in «Управление» (its code comes from the server; without it — that tab)
      if (me.panel) scroll.append(el("div", { class: "card" },
        el("button", { class: "row", style: "width:100%;text-align:left", onclick: () => (S.views.vpn && S.views.vpn.keys ? S.views.vpn.keys() : show("vpn")) },
          well("well", "", "key"),
          el("div", { class: "grow" }, "Ключи", el("small", { text: "Все ключи помощника и Claude: какие подключены, каких нет" })),
          el("span", { class: "chev", icon: "chev" }))));
      // (v41) «🎮 Игры»: the family's games with their tables of records — pages of the server (/app/games/)
      scroll.append(el("div", { class: "card" },
        el("button", { class: "row", style: "width:100%;text-align:left", onclick: openGames },
          well("well", "", "gamepad"),
          el("div", { class: "grow" }, "Игры", el("small", { text: "Змейка, теннис, гонки, карты — с рекордами семьи" })),
          el("span", { class: "chev", icon: "chev" }))));
      if (!me.panel && Native && Native.reminders) scroll.append(remindersCard(draw));
      const modeSel = el("select", { "aria-label": "Как отвечать в чате", onchange: () => setPref({ mode: modeSel.value }) });
      for (const [k, v] of Object.entries(me.modes)) modeSel.append(el("option", { value: k, text: v, selected: k === me.mode }));
      const card = el("div", { class: "card" }, el("h3", { text: "Общение" }),
        el("div", { class: "row" }, el("div", { class: "grow" }, "Как отвечать в чате"), modeSel));
      if (me.panel && Object.keys(me.models || {}).length > 2) {  // the models: the owner's business
        const modelSel = el("select", { "aria-label": "Модель", onchange: () => setPref({ model: modelSel.value }) });
        for (const [k, v] of Object.entries(me.models)) modelSel.append(el("option", { value: k, text: v, selected: k === me.model }));
        card.append(el("div", { class: "row" }, el("div", { class: "grow" }, "Модель",
          el("small", { text: me.models.claude ? "Авто — сначала Claude, потом остальные" : "Авто — самая умная из доступных" })), modelSel));
      }
      if (me.can.speak) {
        card.append(el("div", { class: "row" }, el("div", { class: "grow" }, "Отвечать голосом",
          el("small", { text: me.vreply ? "Включено: на голосовой вопрос отвечаю голосом" : "Выключено: отвечаю текстом" })),
          el("button", { class: "toggle" + (me.vreply ? " on" : ""), "aria-label": "Отвечать голосом", "aria-pressed": me.vreply ? "true" : "false",
            onclick: () => setPref({ vreply: !me.vreply }) })));
        if (Object.keys(me.voices).length > 1) {
          const vSel = el("select", { "aria-label": "Голос", onchange: () => setPref({ voice: vSel.value }) });
          for (const [k, v] of Object.entries(me.voices)) vSel.append(el("option", { value: k, text: v, selected: k === me.voice }));
          card.append(el("div", { class: "row" }, el("div", { class: "grow" }, "Голос"), vSel));
        }
      }
      scroll.append(card);
      const mem = el("div", { class: "card" }, el("h3", { text: "🧠 Что я о вас помню" }));
      if (!me.memory.length) mem.append(el("div", { class: "muted", style: "font-size:14px", text: "Пока ничего. Скажите в чате: «Запомни, что…»" }));
      for (const f of me.memory) {
        const row = el("div", { class: "row" }, el("div", { class: "grow", text: f }));
        row.append(el("button", { class: "icon-btn", icon: "x", title: "Забыть", "aria-label": "Забыть", onclick: () => softDelete(row, "Удалено из памяти", async () => {
          const r = await api("/api/memory", { forget: f }).catch(() => null);
          if (!r) { toast("Не получилось забыть — проверьте интернет"); draw(); return; }
          S.me.memory = r.memory;
          row.remove();  // only this row: another one deleted just now keeps its «↩️ Вернуть»
          if (!mem.isConnected || !S.me.memory.length) draw();
        }) }));
        mem.append(row);
      }
      mem.append(el("button", { class: "btn soft wide", style: "margin-top:8px", icon: "plus", onclick: async () => {
        const t = await ask("Что запомнить?", "Например: у меня двое детей, младшему 7 лет");
        if (t) { const r = await api("/api/memory", { add: t }).catch((e) => toast(problem(e))); if (r) { S.me.memory = r.memory; draw(); } }
      } }, "Добавить"));
      if (!me.panel) scroll.append(mem);
      const theme = el("select", { "aria-label": "Тема", onchange: () => { store.set("theme", theme.value); applyTheme(); } });
      for (const [k, v] of Object.entries(THEMES)) theme.append(el("option", { value: k, text: v, selected: k === store.get("theme", "system") }));
      const appCard = el("div", { class: "card" }, el("h3", { text: "Приложение" }),
        el("div", { class: "row" }, el("div", { class: "grow" }, "Вы вошли как", el("small", { text: me.name }))),
        el("div", { class: "row" }, el("div", { class: "grow" }, "Тема"), theme));
      if (Native && Native.version) {
        appCard.append(el("div", { class: "row" }, el("div", { class: "grow" }, "Версия", el("small", { text: Native.version() })),
          el("button", { class: "act", text: "Проверить обновление", onclick: () => Native.checkUpdate(true) })));
        // how the phone reaches the server: the owner's to know, not the family's
        const p = me.panel && Native.netInfo ? Native.netInfo() : "";
        if (p) appCard.append(el("div", { class: "row" }, el("div", { class: "grow" }, "Связь с сервером",
          el("small", { text: p.endsWith(" vpn") ? "Через VPN телефона, TCP 8443 ✓" : p === "h3" ? "HTTP/3 по UDP — быстрый путь ✓"
            : "TCP 8443 — запасной путь (UDP не проходит)" }))));
      }
      appCard.append(el("button", { class: "btn line wide danger", style: "margin-top:10px", text: "Выйти", onclick: async () => {
        if (await confirmBox("Выйти из приложения? Переписка и фото удалятся с этого телефона, для входа снова понадобится код.", "Выйти", true)) logout("", true);
      } }));
      scroll.append(appCard);
    }
    draw();
    return { root, redraw: draw, onShow: () => api("/api/me", {}).then((m) => { S.me = m; draw(); }).catch(() => {}) };
  }


  // the translator: a full screen of its own
  function translator() {
    const me = S.me;
    let target = me.trans || store.get("trLang", "en");
    if (!me.langs[target]) target = Object.keys(me.langs)[0];
    // «…или на английском»
    const hintText = () => "Нажмите и говорите — по-русски или на " + me.langs[target][1].toLowerCase().replace(/ий$/, "ом");
    const scr = el("div", { class: "viewer", style: "background:var(--bg)" });
    const top = el("div", { class: "top" }, el("button", { class: "icon-btn", icon: "back", "aria-label": "Назад", onclick: () => scr.close() }), el("h1", { text: "Переводчик" }));
    const langs = el("div", { class: "chips fade", style: "padding:10px 12px 0" });  // the fade shows there are more to the right
    // what to do, until the first phrase
    const list = el("div", { class: "scroll" }, el("div", { class: "empty tr-empty" },
      el("p", { text: "Выберите язык сверху, нажмите на шар и скажите фразу — перевод появится здесь и прозвучит вслух." })));
    const firstCard = () => list.querySelectorAll(".tr-empty").forEach((x) => x.remove());
    const ta = el("textarea", { rows: 1, placeholder: "Или напишите текст" });
    autoGrow(ta);
    const mic = el("button", { class: "mic-big", icon: "mic", "aria-label": "Говорить" });
    const hint = el("div", { style: "text-align:center;color:var(--muted);font-size:14px;margin:8px 0", text: hintText() });
    const bottom = el("div", { class: "composer" }, mic, hint, el("div", { class: "inrow" }, ta,
      el("button", { class: "round main", icon: "send", "aria-label": "Перевести", onclick: () => {
        const t = ta.value.trim();
        if (!t) return;
        ta.value = "";
        ta.style.height = "auto";
        translate(t, null);
      } })));
    function paintLangs() {
      const x = langs.scrollLeft;  // the row stays where it was scrolled to
      langs.innerHTML = "";
      for (const [k, v] of Object.entries(me.langs)) {
        langs.append(el("button", { class: "chip" + (k === target ? " on" : ""), text: v[0] + " " + v[1], onclick: () => { target = k; store.set("trLang", k); paintLangs(); } }));
      }
      langs.scrollLeft = x;
      if (!recording) hint.textContent = hintText();
    }
    let recording = false;
    paintLangs();
    scr.append(top, langs, list, bottom);
    scr.close = () => { if (recording) { recording = false; Rec.stop(false); } scr.remove(); };  // the microphone never left on
    document.body.append(scr);
    const on = langs.querySelector(".chip.on");  // the language chosen last time is in sight, not behind the fade
    if (on && on.offsetLeft + on.offsetWidth > langs.clientWidth * 0.85) langs.scrollLeft = on.offsetLeft - 12;
    mic.onclick = async () => {
      if (!recording) {
        if (Rec.starting) return;
        try { await Rec.start(); } catch (e) { toast("Нет доступа к микрофону"); return; }
        if (!scr.isConnected) { Rec.stop(false); return; }  // closed while the microphone was being asked for
        recording = true;
        mic.classList.add("on");
        mic.innerHTML = "";
        mic.append(icon("stop"));
        hint.textContent = "Говорите… нажмите ещё раз, когда закончите";
        return;
      }
      recording = false;
      mic.classList.remove("on");
      mic.innerHTML = "";
      mic.append(icon("mic"));
      hint.textContent = hintText();
      const r = Rec.stop(true);
      if (!r || r.duration < 0.6) return;
      const card = el("div", { class: "tr-card" }, el("div", { class: "status" }, el("span", { class: "spin" }), "Слушаю…"));
      firstCard();
      list.append(card);
      list.scrollTop = list.scrollHeight;
      try {
        const ev = await stream("/api/hear", { audio: await b64(r.blob), mime: "audio/wav", duration: r.duration, lang: me.can.listen ? target : null }, () => {});
        card.remove();
        if (ev.t !== "done") { toast(ev.text); return; }
        translate(ev.text, ev.lang);
      } catch (e) { card.remove(); toast(problem(e)); }
    };
    async function translate(text, lang) {
      const card = el("div", { class: "tr-card" }, el("div", { class: "src", text }), el("div", { class: "status" }, el("span", { class: "spin" }), "Перевожу…"));
      firstCard();
      list.append(card);
      list.scrollTop = list.scrollHeight;
      try {
        const ev = await stream("/api/translate", { text, lang, target }, () => {});
        card.innerHTML = "";
        if (ev.t !== "done") { card.append(el("div", { class: "src", text }), el("div", { style: "color:var(--danger-ink)", text: ev.text })); return; }
        const audio = ev.audio ? blobOf(ev.audio, "audio/ogg") : null;
        card.append(el("div", { class: "src", text: ev.src + " " + text }), el("div", { class: "dst", text: ev.dst + " " + ev.translation }),
          el("div", { class: "acts", style: "margin-top:8px" },
            audio ? el("button", { class: "act", onclick: () => playAudio(audio) }, ...lead("🔊 Ещё раз")) : null,
            el("button", { class: "act", onclick: () => copyText(ev.translation) }, ...lead("📋 Копировать"))));
        if (audio) playAudio(audio);
      } catch (e) { card.remove(); toast(problem(e)); }
      list.scrollTop = list.scrollHeight;
    }
  }

  // the Android app calls this when it has shown the update dialog or wants the page to refresh its data
  window.__aiApp = { refresh: () => S.views.more && S.views.more.onShow() };
  // the phone's Back button: close what is open on top, then go back to the chat; false lets the app go to the background
  window.__aiBack = function () {
    const top = [...document.querySelectorAll(".sheet-bg, .viewer, .ma-view")].pop();
    if (top) { if (top.close) top.close(); else top.remove(); return true; }
    if (S.views.chat && S.tab !== "chat") { show("chat"); return true; }
    return false;
  };
  // the Android app reloads the page for its newer screens only when nothing would be lost: nothing typed, picked,
  // recorded or open, no answer on its way (else they are used from the next start)
  window.__aiIdle = () => !Rec.on && !Rec.starting && !Object.values(S.busy).some(Boolean) && !S.scan.length && !S.idea
    && ![...document.querySelectorAll("textarea, input")].some((t) => !["file", "checkbox", "radio", "hidden"].includes(t.type) && t.value.trim())
    && !document.querySelector(".sheet-bg, .viewer, .rec, .attach-row:not(.hidden), .msg.ai .spin");
  window.__aiTest = { md, tidyMath, parseLogin };

  if (store.get("token", "")) start();
  else renderLogin("");
})();
