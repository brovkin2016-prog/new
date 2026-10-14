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
  function send(path, body, onStatus, onBytes) {
    if (Native) {
      return new Promise((resolve, reject) => {
        const id = "r" + (++seq);
        pending[id] = { head: onStatus, data: onBytes, end: resolve, fail: reject };
        Native.request(id, path, JSON.stringify(headers()), body === null ? "" : body);
      });
    }
    return fetch(path, { method: body === null ? "GET" : "POST", headers: headers(), body: body === null ? undefined : body })
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
  async function stream(path, body, onEvent) {
    let status = 0, buf = "", last = null;
    const errParts = [];
    const dec = new TextDecoder();
    await send(path, JSON.stringify(body), (s) => (status = s), (b) => {
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
    });
    if (status !== 200) {
      let js = {};
      try { js = JSON.parse(bytesToText(errParts)); } catch (e) { /* not json */ }
      throw new HttpError(status, js.error);
    }
    if (!last) throw new Error("net");
    return last;
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
    add(m) {
      if (!this.db) { m.id = this.memId++; this.mem.push(m); return Promise.resolve(m.id); }
      return new Promise((res) => { const r = this.tx("readwrite").add(m); r.onsuccess = () => res((m.id = r.result)); r.onerror = () => res(0); });
    },
    put(m) {
      if (!this.db) return Promise.resolve();
      return new Promise((res) => { const r = this.tx("readwrite").put(m); r.onsuccess = r.onerror = () => res(); });
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
    async start() {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.src = this.ctx.createMediaStreamSource(this.stream);
      this.node = this.ctx.createScriptProcessor(4096, 1, 1);
      this.chunks = [];
      this.node.onaudioprocess = (e) => this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      this.src.connect(this.node);
      this.node.connect(this.ctx.destination);
      this.t0 = Date.now();
    },
    stop(keep) {
      try { this.node.disconnect(); this.src.disconnect(); } catch (e) { /* already */ }
      this.stream.getTracks().forEach((t) => t.stop());
      const rate = this.ctx.sampleRate;
      this.ctx.close();
      if (!keep) return null;
      let n = 0;
      for (const c of this.chunks) n += c.length;
      const all = new Float32Array(n);
      let o = 0;
      for (const c of this.chunks) { all.set(c, o); o += c.length; }
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
  function toast(text, ms) {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    const t = el("div", { class: "toast", role: "status", text });
    document.body.append(t);
    setTimeout(() => t.remove(), ms || Math.min(7000, 1800 + String(text || "").length * 45));
  }
  function sheet(title, build) {
    const bg = el("div", { class: "sheet-bg" });
    const close = () => bg.remove();
    const box = el("div", { class: "sheet" }, el("div", { class: "sheet-head" }, title ? el("h2", { text: title }) : el("span", { style: "flex:1" }),
      el("button", { class: "sheet-x", "aria-label": "Закрыть", text: "✕", onclick: close })));
    bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
    build(box, close);
    bg.append(box);
    document.body.append(bg);
    return close;
  }
  // a list to choose from: [icon, words, action] items; a plain string is a section's name
  function menu(title, items) {
    sheet(title, (box, close) => {
      const list = el("div", { class: "list" });
      for (const it of items) {
        if (!it) continue;
        if (typeof it === "string") { list.append(el("div", { class: "menu-sec", text: it })); continue; }
        list.append(el("button", { onclick: () => { close(); it[2](); } }, el("span", { class: "ic", text: it[0] }), el("span", { text: it[1] })));
      }
      box.append(list);
    });
  }
  // a big tile of a tool: «🪄 Убрать фон» — the icon and the words
  function tool(text, onclick) {
    const s = emo(text), i = s.indexOf(" ");
    return el("button", { class: "tool", onclick }, el("span", { class: "ic", text: i > 0 ? s.slice(0, i) : "•" }), el("span", { text: i > 0 ? s.slice(i + 1) : s }));
  }
  // the tiles in a grid: two a row while every word fits its tile, else one a row. The CSS (9.6em columns) does it where
  // a large system font grows «em»; Android's text zoom may grow only the letters, so the words themselves are measured
  // too — whenever the grid is first shown and when its size changes («Переводчик», never «Переводчи/к»)
  const toolsSeen = typeof ResizeObserver === "function" ? new ResizeObserver((es) => requestAnimationFrame(() => es.forEach((e) => fitTools(e.target)))) : null;
  function fitTools(g) {
    if (!g.isConnected) { toolsSeen.unobserve(g); return; }
    if (!g.clientWidth) return;  // on a hidden tab: measured once it is shown
    g.classList.remove("one");
    g.classList.add("probe");  // words unbroken for a moment: one wider than its tile sticks out
    const tight = [...g.querySelectorAll(".tool > span:last-child")].some((s) => s.scrollWidth > s.clientWidth + 1);
    g.classList.remove("probe");
    g.classList.toggle("one", tight);
  }
  function tools(...kids) {
    const g = el("div", { class: "tools" }, ...kids);
    if (toolsSeen) toolsSeen.observe(g);
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
    row.append(el("div", { class: "grow", text: said }), el("button", { class: "act", text: "↩️ Вернуть", onclick: () => {
      clearTimeout(timer);
      row.innerHTML = "";
      row.classList.remove("gone");
      kids.forEach((k) => row.append(k));
    } }));
  }
  function viewer(blob, name, extra) {
    const v = el("div", { class: "viewer" });
    const close = () => v.remove();
    v.append(el("div", { class: "img", onclick: close }, el("img", { src: urlOf(blob) })),
      el("div", { class: "bar2" },
        el("button", { text: "⬇️ Сохранить", onclick: () => { saveBlob(blob, name); toast("Сохранено"); } }),
        el("button", { text: "📤 Поделиться", onclick: () => shareBlob(blob, name) }),
        extra ? el("button", { text: extra[0], onclick: () => { close(); extra[1](); } }) : null,
        el("button", { text: "✕ Закрыть", onclick: close })));
    document.body.append(v);
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
  const NO_CODE = "Не вижу кода. Скопируйте сообщение от владельца помощника целиком и нажмите «📋 Вставить скопированное».";
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
        if (!host) { err.textContent = "Нужна вся строка из сообщения, а не только код. Скопируйте её целиком и нажмите «📋 Вставить скопированное»."; return; }
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
    const paste = el("button", { class: "btn wide", text: "📋 Вставить скопированное", onclick: async () => {
      let t = "";
      try { t = Native && Native.clipboard ? Native.clipboard() : await navigator.clipboard.readText(); } catch (e) { /* no access */ }
      if (!t || !t.trim()) { toast("Ничего не скопировано — скопируйте строку из сообщения"); return; }
      inp.value = t.trim();
      if (parseLogin(t)) login(); else err.textContent = NO_CODE;
    } });
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
        err.textContent = `✉️ Код отправлен на ${r.to}. Скопируйте строку из письма и нажмите «📋 Вставить скопированное».`;
      } catch (e) {
        err.textContent = problem(e);
      }
      mail.disabled = false;
    } });
    // only on the owner's phone (or after five taps on the star): the family's app shows no owner's buttons
    let taps = 0;
    if (!store.get("wasOwner", false)) mail.classList.add("hidden");
    const logo = el("div", { class: "logo", text: "✦", onclick: () => { if (++taps >= 5) mail.classList.remove("hidden"); } });
    app.append(el("div", { class: "login" },
      logo, el("h1", { text: "ИИ-помощник" }),
      el("p", { text: "Отвечает на вопросы, помогает с уроками, улучшает и меняет фото, рисует и переводит." }),
      el("p", { text: "Для входа нужен код — его присылает владелец помощника." }),
      inp, err, paste, go, mail));
  }
  async function logout(message) {
    try { await api("/api/logout", {}); } catch (e) { /* signed out anyway */ }
    store.set("token", "");
    if (Native && Native.setOwner) Native.setOwner("");  // no server notifications on a signed-out phone
    renderLogin(message || "");
  }

  // ---------- the main screen ----------
  const TABS = [["chat", "💬", "Чат"], ["study", "📚", "Учёба"], ["photo", "🖼️", "Фото"], ["video", "🎬", "Видео"], ["more", "☰", "Ещё"]];
  const TITLES = { chat: "Чат", study: "Учёба", photo: "Фото", video: "Видео", vpn: "Управление", more: "Ещё" };
  const tabsFor = (me) => (me && me.panel ? TABS.slice(0, 4).concat([["vpn", "🛡️", "Управление"]], TABS.slice(4)) : TABS);
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
      if (e instanceof HttpError) { if (e.status !== 401) renderLogin(problem(e)); else renderLogin(e.message); return; }
      const app = $("#app");
      app.innerHTML = "";
      app.append(el("div", { class: "login" }, el("div", { class: "logo", text: "✦" }), el("p", { text: problem(e) }),
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
      tabs.append(el("button", { class: "tab", "data-tab": key, onclick: () => show(key) }, el("span", { class: "ic", text: ic }), el("span", { text: name })));
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
  }
  function show(tab) {
    // a notice belongs to the screen it was said on; the owner's code shows one and redraws the same tab right after
    if (tab !== S.tab) document.querySelectorAll(".toast").forEach((t) => t.remove());
    S.tab = tab;
    store.set("tab", tab);
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    for (const [k, v] of Object.entries(S.views)) v.root.classList.toggle("hidden", k !== tab);
    const v = S.views[tab];
    S.top.innerHTML = "";
    const sub = v.sub ? v.sub() : "";
    S.top.append(el("h1", {}, TITLES[tab], sub ? el("span", { class: "sub", text: sub }) : null));
    for (const b of v.buttons ? v.buttons() : []) S.top.append(el("button", { class: "icon-btn pill", title: b[1], onclick: b[2] }, b[0]));
    if (v.onShow) v.onShow();
  }
  function refreshTop() { if (S.views[S.tab]) show(S.tab); }

  // ---------- reminders: the phone rings by itself (the app's own alarm); the server only works out when and what ----------
  const REMIND_ASK = /^\s*(?:пожалуйста,?\s+)?(напомни|напомнить|поставь\s+напоминание)(?![а-яё])/i;
  function remindSet(r) {
    if (!Native) return "\n\nНапоминания звенят только в приложении «ИИ-помощник» на телефоне.";
    if (!Native.remindAdd) return "\n\nЧтобы телефон напоминал сам, обновите приложение: «☰ Ещё» → «Проверить обновление».";
    const id = Native.remindAdd(JSON.stringify(r));
    if (!id) return "\n\n⚠️ Не получилось поставить напоминание на телефоне.";
    if (Native.askNotify && !store.get("askedNotify", false)) { store.set("askedNotify", true); Native.askNotify(); }
    return "\n\nТелефон напомнит сам, даже без интернета. Отменить — «☰ Ещё» → «⏰ Напоминания».";
  }
  function remindersCard(redraw) {
    const card = el("div", { class: "card" }, el("h3", { text: "⏰ Напоминания" }));
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
      row.append(el("button", { class: "icon-btn", text: "🗑️", title: "Удалить", onclick: () => softDelete(row, "Напоминание удалено", () => {
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
    if (m.file) b.append(el("div", { class: "file-chip", text: "📄 " + m.file }));
    if (m.result) {
      b.append(el("img", { class: "result", src: urlOf(m.result), alt: "", onclick: () => viewer(m.result, m.name || "picture.jpg", again(m.result, "✏️ Изменить ещё")) }));
    }
    // «#t=0.1»: the first frame is painted before it is played, not a black box with «0:00»
    if (m.video) b.append(el("video", { class: "result", controls: true, playsinline: true, preload: "metadata", src: urlOf(m.video) + "#t=0.1" }));
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
    const act = (text, onclick) => el("button", { class: "act", text, onclick });
    const file = m.result || m.video || m.pdf;
    if (file) {  // a picture, video or PDF that came out: keep it, share it, or (in Photo) work on it further
      const view = S.views[thread];
      wrap.append(el("div", { class: "acts" },
        act("⬇️ Сохранить", () => { saveBlob(file, m.name || "result"); toast("Сохранено"); }),
        act("📤 Поделиться", () => shareBlob(file, m.name || "result")),
        thread === "photo" && m.result ? act("✏️ Изменить ещё", () => S.views.photo.set(m.result)) : null,
        m.tpl && view && view.th ? act("🔁 С другими фото", () => whoIsWho(m.tpl.kind, m.tpl, view.th)) : null));
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
      // a clip or a picture with faces that did not come out: «🔁 С другими фото» first — the same photos again would
      // only fail once more after the same minutes
      const v = S.views[thread];
      const redo = m.tpl && v && v.th ? act("🔁 С другими фото", () => whoIsWho(m.tpl.kind, m.tpl, v.th)) : null;
      const again = list.canRetry(m) ? act("🔄 Повторить", () => list.retry(m)) : null;
      if (redo || again) wrap.append(el("div", { class: "acts" }, redo, again));
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
        await DB.add(m);
        S.msgs[name].push(m);
        if (S.msgs[name].length > 400) { S.msgs[name] = S.msgs[name].slice(-300); DB.trim(name, 300); }
        if (S.msgs[name].length === 1 && S.tab === name) refreshTop();  // «🧹 Очистить» on top once there is something to clear
        return m;
      },
      // asks the server and shows the answer as it is written
      async run(path, body, mine) {
        if (S.busy[name]) { toast("Подождите, ещё отвечаю…"); return null; }
        S.busy[name] = true;
        last = { path, body };
        if (mine) { await api2.add(mine); api2.redraw(); }
        const live = el("div", { class: "msg ai" });
        const b = el("div", { class: "bubble" });
        const content = el("div");
        // a picture, a clip or a PDF is first sent off; «Думаю…» is for words, until the server says what it is doing
        const first = /\/api\/(photo|photo_do|draw|tphoto|tvideo|animate|pdf)$/.test(path) ? "Отправляю…" : "Думаю…";
        const status = el("div", { class: "status" }, el("span", { class: "spin" }), el("span", { text: first }));
        b.append(content, status);
        if (path === "/api/tvideo" || path === "/api/animate") {
          b.append(el("div", { class: "live-note", text: "Можно свернуть приложение, но не закрывайте его — ролик придёт сюда." }));
        }
        live.append(b);
        [...box.children].forEach((c) => { if (c.classList.contains("empty") || c.classList.contains("tail")) c.remove(); });
        box.append(live);
        liveEl = live;
        api2.down();
        let text = "", timer = null, said = first, t0 = Date.now();
        const clock = setInterval(() => {
          const sec = Math.round((Date.now() - t0) / 1000);
          if (sec >= 5 && !status.classList.contains("hidden")) {
            status.lastChild.textContent = said + " · " + (sec < 60 ? sec + " с" : "прошло " + Math.floor(sec / 60) + " мин");
          }
        }, 1000);
        const paint = () => { timer = null; content.innerHTML = md(text); content.lastElementChild && content.lastElementChild.classList.add("typing"); api2.down(); };
        let end;
        try {
          end = await stream(path, body, (ev) => {
            if (ev.t === "status") {
              said = ev.text;
              t0 = Date.now();
              status.lastChild.textContent = ev.text;
              status.classList.remove("hidden");
              if (text) status.style.marginTop = "8px";
            } else if (ev.t === "reset") { text = ""; content.innerHTML = ""; status.style.marginTop = ""; }
            else if (ev.t === "delta") {
              text += ev.text;
              status.classList.add("hidden");
              if (!timer) timer = setTimeout(paint, 90);
            }
          });
        } catch (e) {
          end = { t: "error", text: problem(e) };
        }
        clearTimeout(timer);
        clearInterval(clock);
        liveEl = null;
        live.remove();
        S.busy[name] = false;
        let out;
        if (end.t === "done") {
          if (mine && end.user) { mine.ctx = end.user; DB.put(mine); }
          if (end.remind) end.text = (end.text || "") + remindSet(end.remind);
          out = await api2.add({ role: "ai", text: end.text || end.caption, label: end.label, note: !!end.note,
            audio: end.audio ? blobOf(end.audio, "audio/ogg") : null, name: end.name, op: end.op,
            result: end.image ? blobOf(end.image, end.mime) : null, video: end.video ? blobOf(end.video, end.mime) : null,
            pdf: end.pdf ? blobOf(end.pdf, "application/pdf") : null });
          if (out.audio) playAudio(out.audio);
        } else {
          out = await api2.add({ role: "ai", text: "⚠️ " + end.text, err: true });
        }
        api2.redraw();
        return out;
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
        api2.run(last.path, last.body, null);
      },
      follow(kind) {
        const shown = { short: "✂️ Короче", more: "➕ Подробнее" }[kind];
        api2.ask({ followup: kind }, { role: "me", text: shown, ctx: shown });
      },
      ask: null,  // set by the view
      onRedraw: null,  // set by the view that draws something of its own with the thread
    };
    return api2;
  }

  // speech to text in place of the input row; onText gets what was said
  async function dictate(row, onText) {
    try { await Rec.start(); } catch (e) { toast("Нет доступа к микрофону"); return; }
    const time = el("span", { class: "time", text: "0:00" });
    const recRow = el("div", { class: "rec" }, el("span", { class: "dot" }), time,
      el("button", { class: "round ghost", text: "✕", "aria-label": "Отменить", onclick: () => finish(false) }),
      el("button", { class: "round main", text: "✓", "aria-label": "Готово", onclick: () => finish(true) }));
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
      const r = Rec.stop(keep);
      if (!r || r.duration < 0.6) return;
      toast("🎧 Слушаю…");
      try {
        const ev = await stream("/api/hear", { audio: await b64(r.blob), mime: "audio/wav", duration: r.duration }, () => {});
        if (ev.t !== "done") { toast(ev.text); return; }
        onText(ev.text);
      } catch (e) { toast(problem(e)); }
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
  const IDEAS_SHOWN = ["congrats", "letter", "reply", "recipe", "explain", "gift"];  // the rest: «💡 Другие готовые задачи»
  function chatView() {
    const root = el("div", { class: "view" });
    const scroll = el("div", { class: "scroll" });
    const empty = () => el("div", { class: "empty" }, el("div", { class: "emoji", text: "✦" }), el("h2", { text: "Спросите что угодно" }),
      el("p", { text: "Пишите или нажмите 🎤 и говорите. Фото и документы — через 📎." }),
      el("p", { class: "empty-sec", text: "Готовые задачи" }),
      tools(
        Native && Native.remindAdd ? tool("⏰ Напомнить", () => { ta.value = "Напомни "; sync(); ta.focus(); }) : null,
        tool("🗣️ Переводчик", translator),
        IDEAS_SHOWN.filter((k) => S.me.ideas[k]).map((k) => tool(S.me.ideas[k][0], () => pickIdea(k)))),
      el("button", { class: "btn line wide", style: "margin-top:12px", text: "💡 Другие готовые задачи", onclick: ideasMenu }));
    let cur = store.get("chatCur", "main"), th = null;
    if (!chatsAll().some((c) => c.id === cur)) cur = chatsAll()[0].id;
    const attach = el("div", { class: "attach-row hidden" });
    const chips = el("div", { class: "chips hidden", style: "padding:0 4px 8px;flex-wrap:wrap" });  // all three in sight, no sideways row
    const ideaHint = el("div", { class: "idea-hint hidden" });
    const ta = el("textarea", { rows: 1, placeholder: "Сообщение" });
    autoGrow(ta);
    const clip = el("button", { class: "round ghost", text: "📎", title: "Прикрепить", onclick: attachMenu });
    const act = el("button", { class: "round main", text: "🎤" });
    const row = el("div", { class: "inrow" }, clip, ta, act);
    const composer = el("div", { class: "composer" }, attach, chips, ideaHint, row);
    root.append(scroll, composer);
    let image = null, doc = null;

    function sync() {
      const has = ta.value.trim() || image || doc;
      act.textContent = has ? "➤" : "🎤";
      act.setAttribute("aria-label", has ? "Отправить" : "Сказать голосом");
      attach.innerHTML = "";
      attach.classList.toggle("hidden", !(image || doc || S.idea));
      if (image) attach.append(el("img", { src: urlOf(image), alt: "" }));
      if (doc) attach.append(el("div", { class: "chip", text: "📄 " + doc.name }));
      if (S.idea) attach.append(el("div", { class: "chip on", text: S.me.ideas[S.idea][0] }));
      if (image || doc || S.idea) attach.append(el("button", { class: "x", text: "✕", "aria-label": "Убрать", onclick: () => { image = doc = null; S.idea = null; sync(); } }));
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
      const req = Object.assign({ text }, extra || {});
      if (S.idea) req.idea = S.idea;
      const shown = (extra && extra.op ? S.me.ai_ops[extra.op] + (text ? ": " + text : "") : "") || (S.idea ? S.me.ideas[S.idea][0] + ": " + text : text);
      const mine = { role: "me", text: shown, image, file: doc ? doc.name : null };
      const im = image, d = doc;
      ta.value = "";
      ta.style.height = "auto";
      image = doc = null;
      S.idea = null;
      sync();
      th.ask(req, mine, im, d);
    }
    function bind() {  // the thread of the chat that is open now, with its own asking
      const name = chatName(cur);
      if (!S.msgs[name]) S.msgs[name] = [];
      const t = thread(name, scroll, empty);
      t.ask = async (req, mine, im, d) => {
        touch(mine && mine.text);
        if (!im && !d && !req.op && !req.idea && !req.followup && req.text && REMIND_ASK.test(req.text)) {
          await t.run("/api/remind", { text: req.text }, mine);  // «напомни …»: the phone rings by itself
          return;
        }
        const body = Object.assign({ context: context(name) }, req);
        if (im) body.image = await b64(await shrink(im, 2048, 0.88));
        if (d) body.doc = { name: d.name, mime: d.type || "", data: await b64(d) };
        await t.run("/api/chat", body, mine);
      };
      if (th) th.box.replaceWith(t.box); else scroll.append(t.box);
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
            el("button", { class: "round ghost", text: "✏️", title: "Переименовать", "aria-label": "Переименовать", onclick: async (e) => {
              e.stopPropagation(); close();
              const t = await ask("Название чата", "Например: Ремонт кухни", chatTitle(c));
              if (t) { const chats = chatsAll(); const x = chats.find((y) => y.id === c.id); if (x) { x.title = t.slice(0, 60); store.set("chats", chats); refreshTop(); } }
            } }),
            el("button", { class: "round ghost", text: "🗑️", title: "Удалить", "aria-label": "Удалить",
              onclick: (e) => { e.stopPropagation(); close(); delChat(c); } })));
        }
      });
    }
    act.onclick = () => (act.textContent === "➤" ? sendNow() : record());
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); sendNow(); } });

    function record() {
      dictate(row, (t) => (S.idea ? ((ta.value = t), sendNow({ voice: true }))
        : th.ask({ text: t, voice: true }, { role: "me", text: "🎤 " + t, ctx: t })));
    }
    function attachMenu() {
      menu("Прикрепить", [
        ["📷", "Камера", async () => { const f = await pickFile("image/*", true); if (f) { image = f; sync(); } }],
        ["🖼️", "Фото из галереи", async () => { const f = await pickFile("image/*"); if (f) { image = f; sync(); } }],
        ["📄", "Документ: PDF, Word, текст", async () => {
          const f = await pickFile(".pdf,.docx,.pptx,.epub,.txt,.md,.csv,.json,.html,text/*,application/pdf");
          if (f) { if (f.size > 14e6) toast("Файл больше 14 МБ — возьмите поменьше"); else { doc = f; sync(); } }
        }],
        ["💡", "Готовые задачи", ideasMenu],
      ]);
    }
    function ideasMenu() {
      menu("Готовые задачи", Object.entries(S.me.ideas).map(([k, v]) => {
        const s = emo(v[0]), i = s.indexOf(" ");
        return [s.slice(0, i), s.slice(i + 1), () => pickIdea(k)];
      }));
    }
    bind();
    if (cur !== "main") openChat(cur);
    return {
      root, redraw: () => th.redraw(),
      // the answer mode first: a long chat title is the one cut short, never the mode
      sub: () => [S.me.mode !== "chat" ? S.me.modes[S.me.mode] : "",
        chatsAll().length > 1 ? chatTitle(chatsAll().find((c) => c.id === cur) || { id: cur }) : ""].filter(Boolean).join(" · "),
      buttons: () => [["🗂️ Чаты", "Чаты", chatsSheet], ["➕ Новый", "Новый чат", newChat]],
      attachImage(im) { image = im; sync(); },
      onShow: () => th.down(),
    };
  }

  // ---------- Study ----------
  const GRADES = [["1", "1 класс"], ["2", "2 класс"], ["3", "3 класс"], ["4", "4 класс"], ["5", "5 класс"], ["6", "6 класс"], ["7", "7 класс"],
    ["8", "8 класс"], ["9", "9 класс"], ["10", "10 класс"], ["11", "11 класс"], ["s1", "Студент, 1 курс"], ["s2", "Студент, 2 курс"],
    ["s3", "Студент, 3 курс"], ["s4", "Студент, 4+ курс"], ["a", "Взрослый"]];
  const STUDY_MODES = {
    solve: ["✅ Решить", "Полное решение с объяснением и ответом — как оформляют в школе."],
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
      el("button", { class: "btn", text: "📷 Новое задание", onclick: () => shoot(true) }),
      el("button", { class: "btn line", text: "🖼️ Из галереи", onclick: () => shoot(false) })) : null);
    const th = thread("study", scroll, null, tail);
    th.onRedraw = () => drawHead();
    scroll.append(head, th.box);
    const ta = el("textarea", { rows: 1, placeholder: "Задание, тема сочинения или вопрос" });
    autoGrow(ta);
    const cam = el("button", { class: "round ghost", text: "📷", title: "Фото задания", onclick: () => shoot(true) });
    const act = el("button", { class: "round main", text: "🎤", "aria-label": "Сказать голосом" });
    const row = el("div", { class: "inrow" }, cam, ta, act);
    const composer = el("div", { class: "composer" }, row);
    root.append(scroll, composer);
    const syncAct = () => {
      const has = !!ta.value.trim();
      act.textContent = has ? "➤" : "🎤";
      act.setAttribute("aria-label", has ? "Отправить" : "Сказать голосом");
    };
    ta.addEventListener("input", syncAct);
    act.onclick = () => (ta.value.trim() ? submit() : dictate(row, (t) => { ta.value = t; submit(); }));

    function drawHead() {
      head.innerHTML = "";
      const has = S.msgs.study.length > 0;
      if (has && !open) {
        head.append(el("button", { class: "card study-line", onclick: () => { open = true; drawHead(); } },
          el("span", { class: "grow", text: gradeName() + " · " + STUDY_MODES[mode][0] }), el("span", { class: "muted", text: "Изменить ›" })));
      } else {
        const sel = el("select", { "aria-label": "Кто учится", onchange: () => { grade = sel.value; store.set("grade", grade); refreshTop(); } });
        for (const [k, v] of GRADES) sel.append(el("option", { value: k, text: v, selected: k === grade }));
        const seg = el("div", { class: "seg grid2", style: "margin-top:8px" });
        for (const [k, v] of Object.entries(STUDY_MODES)) {
          seg.append(el("button", { class: k === mode ? "on" : "", "aria-pressed": k === mode ? "true" : "false", text: v[0],
            onclick: () => { mode = k; store.set("studyMode", k); open = false; drawHead(); } }));
        }
        head.append(el("div", { class: "card" },
          el("div", { class: "row" }, el("div", { class: "grow" }, "Кто учится"), sel),
          seg, el("div", { class: "study-desc", text: STUDY_MODES[mode][1] })));
        if (!has) {
          head.append(el("div", { class: "big-actions", style: "margin-bottom:12px" },
            el("button", { class: "big primary", onclick: () => shoot(true) }, el("span", { class: "ic", text: "📷" }), "Снять задание"),
            el("button", { class: "big", onclick: () => shoot(false) }, el("span", { class: "ic", text: "🖼️" }), "Из галереи")));
        }
      }
      ta.placeholder = mode === "essay" ? "Тема сочинения" : S.msgs.study.length ? "Спросите про решение"
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
      root, th, redraw: th.redraw, solve,
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
  const QUICK = ["enhance", "removebg", "restore", "colorize", "scan"];  // on the chosen photo; the rest under «⋯ Другое» or in words
  // clearer names for some of the server's tools (only renames: the tools themselves are the server's)
  const OP_NAMES = { restore: "👴 Восстановить старое", scan: "📑 Скан документа", bw: "⬛ Чёрно-белое", cartoon: "🦸 Мульт",
    oil: "🖌️ Картина маслом", blurbg: "🌫️ Размыть фон", vintage: "🎞️ Винтаж" };
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
    const tplOk = () => !!(S.me.can.tvideo || S.me.panel);
    const empty = () => (photo ? null : el("div", { class: "empty" }, el("h2", { text: "Что сделать с фото?" }),
      el("p", { text: "Пришлите фото и скажите или напишите, что сделать: «убери фон», «раскрась», «сделай в стиле аниме»." }),
      el("div", { class: "big-actions", style: "margin:16px 0 4px" },
        el("button", { class: "big primary", onclick: () => pick(true) }, el("span", { class: "ic", text: "📷" }), "Снять фото"),
        el("button", { class: "big", onclick: () => pick(false) }, el("span", { class: "ic", text: "🖼️" }), "Из галереи"),
        tplOk() ? el("button", { class: "big wide", onclick: () => templatesSheet("photo", th) }, el("span", { class: "ic", text: "🎭" }),
          el("span", {}, "Я на фото", el("small", { text: "вы на готовой картинке: в сказке, в космосе, на празднике" }))) : null),
      S.me.can.draw ? [el("p", { class: "empty-sec", text: "🎨 Или опишите — я нарисую:" }),
        el("div", { class: "hints" }, DRAW_HINTS.map((t) => el("button", { class: "hint", text: t, onclick: () => { ta.value = t; ta.dispatchEvent(new Event("input")); ta.focus(); } })))] : null));
    const has = (op) => !!(S.me.photo_ops[op] || S.me.ai_ops[op]);
    // the chosen photo, big, with what can be done to it; with no photo under the results, the big ways to the next one
    // (the empty screen with them is gone once there is a result)
    const chosen = () => (photo ? el("div", { class: "tail chosen" },
      el("div", { class: "preview" }, el("img", { src: urlOf(photo), alt: "", onclick: () => viewer(photo, "photo.jpg") }),
        el("button", { class: "x", text: "✕", "aria-label": "Убрать фото", onclick: () => { photo = null; sync(); th.redraw(); refreshTop(); } })),
      el("div", { class: "chosen-q", text: "Что сделать с этим фото?" }),
      tools(QUICK.filter(has).map((op) => tool(label(op), () => runOp(op))),
        tool("✍️ Своё изменение", own), tool("⋯ Другое", more)))
      // pages for a PDF being collected: their banner over the input is the next step (no second «📷» here)
      : S.scan.length ? null
      : S.msgs.photo.length ? el("div", { class: "tail big-actions next", style: "grid-template-columns:1fr 1fr" },
        el("div", { class: "menu-sec", style: "grid-column:1/-1;padding:4px 2px 0", text: "Новое фото" }),
        el("button", { class: "btn", text: "📷 Снять фото", onclick: () => pick(true) }),
        el("button", { class: "btn line", text: "🖼️ Из галереи", onclick: () => pick(false) }),
        tplOk() ? el("button", { class: "btn line", style: "grid-column:1/-1", text: "🎭 Я на фото", onclick: () => templatesSheet("photo", th) }) : null)
      : null);
    const th = thread("photo", scroll, empty, chosen);
    scroll.append(th.box);
    const scanBar = el("div", { class: "banner hidden" });
    const ownHint = el("div", { class: "idea-hint hidden" });  // «✍️ Своё»: what to say, above the input
    const ta = el("textarea", { rows: 1 });
    autoGrow(ta);
    const cam = el("button", { class: "round ghost", text: "📷", title: "Выбрать фото", onclick: () => menu("Выбрать фото", [
      ["📷", "Снять фото", () => pick(true)], ["🖼️", "Из галереи", () => pick(false)],
      tplOk() ? ["🎭", "Я на фото", () => templatesSheet("photo", th)] : null]) });
    const act = el("button", { class: "round main", text: "🎤" });
    const row = el("div", { class: "inrow" }, cam, ta, act);
    root.append(scroll, el("div", { class: "composer" }, scanBar, ownHint, row));

    function label(op) { return OP_NAMES[op] || emo(S.me.photo_ops[op] || S.me.ai_ops[op] || op); }
    function sync() {
      const typed = !!ta.value.trim();
      act.textContent = typed ? "➤" : "🎤";
      act.setAttribute("aria-label", typed ? "Отправить" : "Сказать голосом");
      // a placeholder stays one line (under ~22 letters); a longer «how» goes into ownHint above the input
      ta.placeholder = photo ? "Что сделать?" : S.me.can.draw ? "Что нарисовать?" : "Пришлите фото 📷";
      if (!photo) ownHint.classList.add("hidden");
      scanBar.innerHTML = "";
      scanBar.classList.toggle("hidden", !S.scan.length);
      if (S.scan.length) {
        // while pages are collected, this is the one place for the next step: the tail under the result steps aside.
        // «Собрать PDF» is the filled one; its count is on the line just above (with it, it no longer fits one line at 360)
        scanBar.append(el("span", { class: "grow", text: `📑 Страниц для PDF: ${S.scan.length}` }),
          el("button", { class: "act", text: "✕", "aria-label": "Убрать страницы", onclick: async () => {
            if (!(await confirmBox(`Убрать собранные страницы (${S.scan.length})? PDF не соберётся.`, "Убрать", true))) return;
            S.scan = [];
            sync();
            th.redraw();
          } }),
          el("div", { class: "banner-acts" },
            el("button", { class: "btn line", text: "📷 Ещё страница", onclick: () => menu("Ещё страница", [
              ["📷", "Снять", () => page(true)], ["🖼️", "Из галереи", () => page(false)]]) }),
            el("button", { class: "btn", text: "📄 Собрать PDF", onclick: makePdf })));
      }
    }
    ta.addEventListener("input", sync);
    act.onclick = () => (ta.value.trim() ? send() : dictate(row, (t) => { ta.value = t; send(); }));
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); send(); } });
    function own() {
      ta.placeholder = "Например: сделай зиму";
      ownHint.textContent = "Скажите 🎤 или напишите, что изменить: «сделай зиму», «добавь шляпу»";
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
      if (out && out.op === "scan" && out.result) { S.scan.push(out.result); sync(); th.redraw(); }
    }
    function runOp(op) {
      if (op === "animate") go("/api/animate", {}, label(op));
      else go("/api/photo", { op }, label(op));
    }
    function send() {
      const text = ta.value.trim();
      if (!text) return;
      if (S.busy.photo) { toast("Подождите, предыдущее ещё делается"); return; }
      if (!photo && !S.me.can.draw) { toast("Сначала пришлите фото: 📷 слева"); return; }
      ta.value = "";
      ta.style.height = "auto";
      ownHint.classList.add("hidden");
      sync();
      if (photo) go("/api/photo_do", { text }, text);
      else go("/api/draw", { prompt: text }, "🎨 " + text);
    }
    async function makePdf() {
      if (S.busy.photo || !S.scan.length) return;
      const pages = await Promise.all(S.scan.map((b) => b64(b)));
      const n = pages.length;
      const out = await th.run("/api/pdf", { pages }, { role: "me", text: `📄 Собрать PDF: ${n} стр.` });
      if (out && out.pdf) { out.name = out.name || "scan.pdf"; S.scan = []; sync(); th.redraw(); }
    }
    sync();
    th.redraw();
    return {
      root, th, set, redraw: th.redraw,
      // a job started elsewhere (🎭 Я на фото) takes the choice away too: no «Что сделать с этим фото?» under its result
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
      onShow: () => { gal.photo = null; th.down(); },
    };
  }

  // ---------- «🎭 Я в ролике» (Видео) and «🎭 Я на фото» (Фото): a gallery of templates, then who is who ----------
  // Templates are short clips on the server, by theme; the server finds up to 3 faces, a photo is chosen for any of them
  // (the rest stay as they are) with consent, and the server swaps faces on its own CPU in 5–8 min. An own clip up to
  // 20 s works too. Photo templates («Я на фото») share the gallery and who-is-who code.
  const TPL = {
    video: { title: "🎭 Я в ролике", path: "/api/tvideo", go: "🎬 Сделать ролик", find: "🔎 Ищу лица в ролике…",
      off: "«Я в ролике» пока не включено — его включает владелец помощника.",
      hint: "Выберите ролик — потом покажете, кого в нём заменить на себя или родных. Подойдёт и свой ролик с телефона, до 20 секунд.",
      none: "Готовых роликов пока нет — загляните позже.", busy: "Подождите, ролик ещё делается",
      foot: "Ролик будет готов обычно через несколько минут, не больше 8, и появится здесь. Приложение можно свернуть, но не закрывайте его." },
    photo: { title: "🎭 Я на фото", path: "/api/tphoto", go: "✨ Создать картинку", find: "🔎 Ищу лица на картинке…",
      off: "«Я на фото» пока не включено — его включает владелец помощника.",
      hint: "Выберите картинку — потом покажете, кого на ней заменить на себя или родных.",
      none: "Готовых картинок пока нет — загляните позже.", busy: "Подождите, предыдущее фото ещё делается",
      foot: "Обычно до полуминуты. Готовая картинка появится здесь, во вкладке «Фото»." } };
  // «1 секунду», «3 секунды», «6 секунд»
  const secs = (k) => k + " " + (k % 10 === 1 && k % 100 !== 11 ? "секунду"
    : k % 10 >= 2 && k % 10 <= 4 && (k % 100 < 12 || k % 100 > 14) ? "секунды" : "секунд");
  // what the gallery loaded this visit of the tab: {theme, page, items, more, total, themes, can, note}; the tab's onShow forgets it
  const gal = { video: null, photo: null };
  // The owner reads the server's own words. The family reads them too while the feature is on («Шаблоны ещё
  // загружаются…»), but when it is off they read this app's «not on yet» for that kind: the server's reasons then name
  // programs (ffmpeg) or say «Видео» in the photo gallery — on purpose, unlike «when can is false, show note».
  const noteFor = (kind, st) => (S.me.panel ? st.note || TPL[kind].none : !st.can ? TPL[kind].off : st.note || TPL[kind].none);
  function templatesSheet(kind, th) {
    const T = TPL[kind];
    if (S.busy[th.name]) { toast(T.busy); return; }
    if (!S.me.can.tvideo && !S.me.panel) { toast(T.off, 5000); return; }
    sheet(T.title, (box, close) => {
      if (!gal[kind]) gal[kind] = { theme: store.get("tplTheme:" + kind, ""), page: 0, items: [], more: false, total: 0, themes: {}, can: true, note: "", loaded: false, ticket: 0 };
      const st = gal[kind];
      const chips = el("div", { class: "chips" });
      const stick = el("div", { class: "sheet-stick" }, chips);
      const note = el("div", { class: "note-card hidden" });
      const grid = el("div", { class: "tpl-grid" + (kind === "photo" ? " photo" : "") });
      const hint = el("p", { class: "muted", style: "margin:0 0 4px;font-size:15px", text: T.hint });
      box.append(hint, stick, note, grid);
      let loading = 0, err = null, errPage = 1;
      const group = (x) => (x.people || 1) > 1;  // «👥 Компанией»: for two or three
      const fits = (x) => st.theme !== "group" || group(x);
      const tile = (x) => {
        const n = Math.min(3, Math.max(1, x.people || 1));
        return el("button", { class: "tpl", "aria-label": x.title, onclick: () => { close(); whoIsWho(kind, { id: x.id, title: x.title, thumb: x.thumb }, th); } },
          x.thumb ? el("img", { src: "data:image/jpeg;base64," + x.thumb, alt: "" }) : null,
          n > 1 ? el("span", { class: "ppl", text: "👥 " + n }) : null, el("span", { class: "name", text: x.title }));
      };
      function paint() {
        chips.innerHTML = "";
        for (const [k, v] of [["", "Все"], ["group", "👥 Компанией"]].concat(Object.entries(st.themes || {}))) {
          chips.append(el("button", { class: "chip" + (k === st.theme ? " on" : ""), "aria-pressed": k === st.theme ? "true" : "false",
            text: k && k !== "group" ? emo(v) : v, onclick: () => pick(k) }));
        }
        const off = st.loaded && !st.can;
        hint.classList.toggle("hidden", off);  // «Выберите картинку…» over «not on yet» would ask for what cannot be done
        stick.classList.toggle("hidden", off || !st.loaded);
        grid.classList.toggle("hidden", off);
        note.classList.toggle("hidden", !off);
        note.textContent = off ? noteFor(kind, st) : "";
        grid.innerHTML = "";
        if (off) return;
        if (kind === "video") {
          grid.append(el("button", { class: "tpl own", onclick: () => { close(); ownClip(th); } },
            el("span", { class: "plus", text: "+" }), el("span", { class: "name", text: "Свой ролик" })));
        }
        if (loading === 1 || (!st.loaded && !err)) {
          grid.append(el("div", { class: "status gal-msg" }, el("span", { class: "spin" }), el("span", { text: "Загружаю…" })));
          return;
        }
        const list = st.items.filter(fits);
        for (const x of list) grid.append(tile(x));
        if (err) {
          grid.append(el("p", { class: "gal-msg", text: problem(err) }),
            el("button", { class: "btn line gal-msg", text: "🔄 Повторить", onclick: () => load(errPage) }));
          return;
        }
        if (!list.length) grid.append(el("p", { class: "gal-msg muted", text: st.theme ? "В этой теме пока пусто." : noteFor(kind, st) }));
        if (st.more) {
          grid.append(el("button", { class: "btn line wide more", disabled: !!loading,
            text: loading ? "Загружаю…" : st.theme === "group" ? "Показать ещё" : "Показать ещё · осталось " + Math.max(0, st.total - st.items.length),
            onclick: () => load(st.page + 1) }));
        }
      }
      async function load(page) {
        const my = ++st.ticket;
        loading = page;
        err = null;
        paint();
        let added = 0, pages = 0;
        try {
          for (;;) {
            const r = await api("/api/templates", { kind, theme: st.theme && st.theme !== "group" ? st.theme : undefined, page });
            if (my !== st.ticket) return;  // another chip was tapped meanwhile
            const items = r.items || [];
            st.items = page === 1 ? items : st.items.concat(items);
            Object.assign(st, { page: r.page || page, more: !!r.more, total: r.total || 0, themes: r.themes || {}, can: r.can !== false,
              note: r.note || "", loaded: true });
            if (page === 1 && st.theme && st.theme !== "group" && Object.keys(st.themes).length && !(st.theme in st.themes)) {
              st.theme = "";  // the theme kept from last time is gone: all of them
              store.set("tplTheme:" + kind, "");
              continue;
            }
            added += items.filter(fits).length;
            // «Компанией» is picked out here from the pages: a few pages more, so that there is something to see
            if (st.theme === "group" && st.more && added < 6 && ++pages < 4) { page = st.page + 1; continue; }
            break;
          }
        } catch (e) {
          if (my !== st.ticket) return;
          err = e;
          errPage = page;
        }
        loading = 0;
        paint();
      }
      function pick(k) {
        st.theme = k;
        store.set("tplTheme:" + kind, k);
        st.items = [];
        st.more = false;
        load(1);
      }
      if (st.loaded) paint(); else load(1);
    });
  }
  async function ownClip(th) {
    const f = await pickFile("video/*", false);
    if (!f) return;
    if (f.size > 40 * 1024 * 1024) { toast("Ролик слишком большой — возьмите короче, до 20 секунд", 5000); return; }
    whoIsWho("video", { own: true, title: "Свой ролик", clip: f }, th);
  }
  // who is who: the server finds the people (each one's face), a photo is chosen for one or more of them (the rest stay
  // as they are), with the word that the photos may be used; then the clip or the picture comes into the thread
  function whoIsWho(kind, tpl, th) {
    const T = TPL[kind];
    if (S.busy[th.name]) { toast(T.busy); return; }
    const photos = [];
    let found = null;
    sheet("🎭 " + tpl.title, async (box, close) => {
      const said = el("span", { text: tpl.own ? "Загружаю ролик и ищу в нём лица… до минуты" : T.find });
      const wait = el("div", { class: "status", style: "margin:8px 0 14px" }, el("span", { class: "spin" }), said);
      // big while the faces are looked for; smaller once they are there, so the face rows fit over the foot on a 640px phone
      const big = tpl.thumb ? el("img", { class: "tpl-big" + (kind === "photo" ? " photo" : ""), src: "data:image/jpeg;base64," + tpl.thumb, alt: "" }) : null;
      box.append(big, wait);
      // a stream: the server says it is still looking (a minute for a clip it has not seen), then who is in it
      try {
        found = await stream("/api/tfaces", tpl.own ? { clip: await b64(tpl.clip) } : { template: tpl.id }, (ev) => {
          if (ev.t === "status" && ev.text) said.textContent = ev.text;
        });
        if (found.t !== "done") throw new HttpError(200, found.text || (kind === "photo" ? "Не получилось найти лица на картинке." : "Не получилось найти лица в ролике."));
        if (!found.faces || !found.faces.length) throw new HttpError(200, kind === "photo" ? "На картинке не нашлось лиц." : "В ролике не нашлось лиц.");
      } catch (e) {
        wait.replaceWith(el("p", { style: "margin:4px 0 12px", text: problem(e) }),
          el("button", { class: "btn line wide", text: kind === "photo" ? "↩️ Выбрать другую картинку" : "↩️ Выбрать другой ролик", onclick: () => {
            close();
            if (tpl.own) ownClip(th); else templatesSheet(kind, th);
          } }));
        return;
      }
      const n = Math.min(3, found.faces.length);
      const NO_TICK = n === 1 ? "Поставьте галочку: фото ваше или человек согласен." : "Поставьте галочку: фото ваши или люди согласны.";
      const names = kind === "video" ? (n === 1 ? ["Человек в ролике"] : ["Человек 1", "Человек 2", "Человек 3"])
        : n === 1 ? ["Человек на картинке"] : n === 2 ? ["Слева", "Справа"] : ["Слева", "В центре", "Справа"];
      const why = el("div", { class: "why" });
      const check = el("input", { type: "checkbox", onchange: () => { if (check.checked && why.textContent === NO_TICK) why.textContent = ""; } });
      const rows = el("div");
      const take = async (i, camera) => {
        const f = await pickFile("image/*", camera);
        if (!f) return;
        photos[i] = f;
        if (why.textContent.startsWith("Нажмите")) why.textContent = "";
        paintRows();
      };
      const paintRows = () => {
        rows.innerHTML = "";
        found.faces.slice(0, n).forEach((p, i) => {
          const who = names[i];
          const slot = el("button", { class: "slot" + (photos[i] ? " set" : ""), "aria-label": "Фото для: " + who, onclick: () => menu(who, [
            ["📷", "Снять фото", () => take(i, true)], ["🖼️", "Из галереи", () => take(i, false)],
            photos[i] ? ["↩️", "Оставить как есть", () => { photos[i] = null; paintRows(); }] : null]) },
            photos[i] ? el("img", { src: urlOf(photos[i]), alt: "" }) : el("span", {}, el("b", { class: "plus", text: "+" }), "фото"));
          rows.append(el("div", { class: "who-row" },
            el("img", { class: "face", src: "data:image/jpeg;base64," + p.thumb, alt: "" }), el("span", { class: "arrow", text: "→" }), slot,
            el("div", { class: "who" }, el("b", { text: who }),
              el("small", { text: photos[i] ? "✓ ваше фото" : n === 1 ? "нажмите «+\u00a0фото»" : "останется как есть" }),
              kind === "video" && p.on ? el("small", { text: "на экране " + secs(Math.max(1, Math.round(p.on))) }) : null)));
        });
      };
      paintRows();
      const where = kind === "video" ? "В ролике" : "На картинке";
      const hint = n === 1 ? "Нажмите «+\u00a0фото» и выберите своё фото: одно лицо, крупно, при хорошем свете."
        : `${where} ${n} человека. Нажмите «+\u00a0фото» у тех, кого заменить. Фото\u00a0— одно лицо, крупно, при хорошем свете.`;
      const goBtn = el("button", { class: "btn wide", text: T.go, onclick: async () => {
        if (!photos.some(Boolean)) { why.textContent = "Нажмите «+\u00a0фото» и выберите хотя бы одно фото."; return; }
        if (!check.checked) { why.textContent = NO_TICK; return; }
        // the photos are made smaller first (a second or two on an old phone): the sheet stays, the button says so
        goBtn.disabled = true;
        goBtn.textContent = "Готовлю фото…";
        why.textContent = "";
        const images = [];
        try {
          for (let i = 0; i < n; i++) images.push(photos[i] ? await b64(await shrink(photos[i], 2048, 0.92)) : null);
        } catch (e) {
          goBtn.disabled = false;
          goBtn.textContent = T.go;
          why.textContent = "Не получилось прочитать фото — выберите другое.";
          return;
        }
        if (!goBtn.isConnected) return;  // closed with ✕ meanwhile: nothing is sent
        close();
        const first = photos.find(Boolean);
        const many = photos.filter(Boolean).length;
        if (kind === "photo" && S.views.photo && S.views.photo.drop) { S.views.photo.drop(); refreshTop(); }
        const out = await th.run(T.path, { analysis: found.analysis, images, consent: true },
          { role: "me", image: first, text: "🎭 " + tpl.title + (many > 1 ? " · 👥 " + many : "") });
        if (out && !tpl.own) {  // «🔁 С другими фото» under it (a failed one too): the same template once more
          out.tpl = { kind, id: tpl.id, title: tpl.title, thumb: tpl.thumb };  // the picture too: the second run looks like the first
          await DB.put(out);
          th.redraw();
        }
      } });
      // how long it takes is read before the faces; the last thing over the sticky foot is a face row, so its fade hides
      // nothing that is only said there
      wait.replaceWith(el("p", { style: "margin:4px 0 6px", text: (found.note ? found.note + " " : "") + hint }),
        el("p", { class: "muted", style: "font-size:14px;margin:0 0 8px", text: T.foot }), rows,
        el("div", { class: "sheet-foot" },
          el("label", { class: "agree" }, check, el("span", { text: n === 1 ? "Это моё фото, или человек на фото согласен" : "Это мои фото, или люди на них согласны" })),
          why, goBtn));
      if (big) big.classList.add("small");
    });
  }

  // ---------- Video: «🎭 Я в ролике» and «🖼️ Оживить фото» ----------
  function videoView() {
    const root = el("div", { class: "view" });
    const scroll = el("div", { class: "scroll" });
    const NOT_ON = "Видео вам пока не включено — его включает владелец помощника.";
    const tv = () => !!S.me.can.tvideo;
    const an = () => !!((S.me.ai_ops || {}).animate || (S.me.photo_ops || {}).animate);
    const empty = () => {
      const box = el("div", { class: "empty", style: "text-align:left" }, el("h2", { text: "Ролики с вами" }));
      if (!tv() && !an() && !S.me.panel) { box.append(el("div", { class: "note-card", "data-off": "tv an", text: NOT_ON })); return box; }
      const feat = (on, k, title, words, offWords) => el("p", { class: "feat" + (on ? "" : " off"), "data-off": on ? null : k },
        el("b", { text: title }), " — " + words, on ? null : el("small", { text: offWords }));
      box.append(
        feat(tv(), "tv", "🎭 Я в ролике", "выберите готовый ролик или свой (до 20 секунд). В нём можно заменить до трёх человек: на каждого — своё фото. Ролик готов обычно через несколько минут, не больше 8.",
          S.me.panel ? "Пока не работает — нажмите «🎭 Я в ролике» внизу, чтобы узнать почему." : "Пока не включено."),
        feat(an(), "an", "🖼️ Оживить фото", "выберите фото, где хорошо видно лицо, и оно начнёт двигаться. Готово через 1–3 минуты.", "Пока не включено."));
      return box;
    };
    const th = thread("video", scroll, empty);
    scroll.append(th.box);
    // a tap on a switched-off button: the words on the screen that already say so light up; with no such words (the
    // clips cover them) a short notice says whom to ask
    function offTap(k, name) {
      const said = th.box.querySelector(`.empty [data-off~="${k}"]`);
      if (said) {
        said.classList.remove("nudge");
        void said.offsetWidth;  // the light runs again on every tap
        said.classList.add("nudge");
        said.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return;
      }
      toast(S.me.panel ? `«${name}» пока не работает — его подключают в «Управлении».` : `Попросите владельца помощника включить «${name}».`, 4000);
    }
    const tvBtn = el("button", { class: "btn", text: "🎭 Я в ролике", onclick: () => {
      if (!tv() && !S.me.panel) { offTap("tv", "Я в ролике"); return; }
      templatesSheet("video", th);
    } });
    const anBtn = el("button", { class: "btn line", text: "🖼️ Оживить фото", onclick: animate });
    const paintBar = () => { tvBtn.classList.toggle("off", !tv()); anBtn.classList.toggle("off", !an()); };
    root.append(scroll, el("div", { class: "composer" }, el("div", { class: "vbar" }, tvBtn, anBtn)));
    async function animate() {
      if (!an()) { offTap("an", "Оживить фото"); return; }
      if (S.busy.video) { toast("Подождите, ролик ещё делается"); return; }
      const f = await pickFile("image/*", false);
      if (!f) return;
      await th.run("/api/animate", { image: await b64(await shrink(f, 3072, 0.92)) }, { role: "me", image: f, text: "🖼️ Оживить фото" });
    }
    paintBar();
    th.redraw();
    return {
      root, th, redraw: th.redraw,
      sub: () => (tv() || an() || S.me.panel ? "ролики с вами и ожившие фото" : "пока не включено"),
      buttons: () => (S.msgs.video.length ? [["🧹 Очистить", "Очистить", async () => {
        if (!S.msgs.video.length) { toast("Здесь пока пусто"); return; }
        if (!(await confirmBox("Удалить все ролики из списка?", "Очистить", true))) return;
        await DB.clear("video");
        S.msgs.video = [];
        th.redraw();
        refreshTop();
      }]] : []),
      onShow: () => {
        gal.video = null;
        paintBar();
        if (!S.msgs.video.length && !S.busy.video) th.redraw(); else th.down();
      },
    };
  }

  // ---------- More: translator, reminders, settings, memory, app ----------
  function moreView() {
    const root = el("div", { class: "view" });
    const scroll = el("div", { class: "scroll" });
    root.append(scroll);
    async function setPref(p) {
      try { S.me = await api("/api/prefs", p); draw(); toast("Сохранено"); } catch (e) { toast(problem(e)); }
    }
    function draw() {
      const me = S.me;
      scroll.innerHTML = "";
      scroll.append(el("div", { class: "card" },
        el("button", { class: "row", style: "width:100%;text-align:left", onclick: translator },
          el("span", { style: "font-size:24px", text: "🗣️" }),
          el("div", { class: "grow" }, "Переводчик", el("small", { text: "Скажите фразу — переведу и прочитаю вслух" })),
          el("span", { class: "muted", style: "font-size:22px", text: "›" }))));
      if (Native && Native.reminders) scroll.append(remindersCard(draw));
      const modeSel = el("select", { "aria-label": "Как отвечать в чате", onchange: () => setPref({ mode: modeSel.value }) });
      for (const [k, v] of Object.entries(me.modes).filter(([k]) => me.panel || k !== "coder" || k === me.mode)) {
        modeSel.append(el("option", { value: k, text: v, selected: k === me.mode }));
      }
      const card = el("div", { class: "card" }, el("h3", { text: "Общение" }),
        el("div", { class: "row" }, el("div", { class: "grow" }, "Как отвечать в чате"), modeSel));
      if (me.panel && Object.keys(me.models || {}).length > 2) {  // the models: the owner's business
        const modelSel = el("select", { "aria-label": "Модель", onchange: () => setPref({ model: modelSel.value }) });
        for (const [k, v] of Object.entries(me.models)) modelSel.append(el("option", { value: k, text: v, selected: k === me.model }));
        card.append(el("div", { class: "row" }, el("div", { class: "grow" }, "Модель", el("small", { text: "Авто — самая умная из доступных" })), modelSel));
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
        row.append(el("button", { class: "icon-btn", text: "✕", title: "Забыть", "aria-label": "Забыть", onclick: () => softDelete(row, "Удалено из памяти", async () => {
          const r = await api("/api/memory", { forget: f }).catch(() => null);
          if (!r) { toast("Не получилось забыть — проверьте интернет"); draw(); return; }
          S.me.memory = r.memory;
          row.remove();  // only this row: another one deleted just now keeps its «↩️ Вернуть»
          if (!mem.isConnected || !S.me.memory.length) draw();
        }) }));
        mem.append(row);
      }
      mem.append(el("button", { class: "btn soft wide", style: "margin-top:8px", text: "➕ Добавить", onclick: async () => {
        const t = await ask("Что запомнить?", "Например: у меня двое детей, младшему 7 лет");
        if (t) { const r = await api("/api/memory", { add: t }).catch((e) => toast(problem(e))); if (r) { S.me.memory = r.memory; draw(); } }
      } }));
      scroll.append(mem);
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
        if (await confirmBox("Выйти из приложения? Для входа снова понадобится код.", "Выйти", true)) logout("");
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
    const top = el("div", { class: "top" }, el("button", { class: "icon-btn", text: "←", "aria-label": "Назад", onclick: () => scr.remove() }), el("h1", { text: "Переводчик" }));
    const langs = el("div", { class: "chips fade", style: "padding:10px 12px 0" });  // the fade shows there are more to the right
    // what to do, until the first phrase
    const list = el("div", { class: "scroll" }, el("div", { class: "empty tr-empty" },
      el("p", { text: "Выберите язык сверху, нажмите 🎤 и скажите фразу — перевод появится здесь и прозвучит вслух." })));
    const firstCard = () => list.querySelectorAll(".tr-empty").forEach((x) => x.remove());
    const ta = el("textarea", { rows: 1, placeholder: "Или напишите текст" });
    autoGrow(ta);
    const mic = el("button", { class: "mic-big", text: "🎤", "aria-label": "Говорить" });
    const hint = el("div", { style: "text-align:center;color:var(--muted);font-size:14px;margin:8px 0", text: hintText() });
    const bottom = el("div", { class: "composer" }, mic, hint, el("div", { class: "inrow" }, ta,
      el("button", { class: "round main", text: "➤", "aria-label": "Перевести", onclick: () => {
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
    document.body.append(scr);
    const on = langs.querySelector(".chip.on");  // the language chosen last time is in sight, not behind the fade
    if (on && on.offsetLeft + on.offsetWidth > langs.clientWidth * 0.85) langs.scrollLeft = on.offsetLeft - 12;
    mic.onclick = async () => {
      if (!recording) {
        try { await Rec.start(); } catch (e) { toast("Нет доступа к микрофону"); return; }
        recording = true;
        mic.classList.add("on");
        mic.textContent = "⏹️";
        hint.textContent = "Говорите… нажмите ещё раз, когда закончите";
        return;
      }
      recording = false;
      mic.classList.remove("on");
      mic.textContent = "🎤";
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
        if (ev.t !== "done") { card.append(el("div", { class: "src", text }), el("div", { style: "color:var(--danger)", text: ev.text })); return; }
        const audio = ev.audio ? blobOf(ev.audio, "audio/ogg") : null;
        card.append(el("div", { class: "src", text: ev.src + " " + text }), el("div", { class: "dst", text: ev.dst + " " + ev.translation }),
          el("div", { class: "acts", style: "margin-top:8px" },
            audio ? el("button", { class: "act", text: "🔊 Ещё раз", onclick: () => playAudio(audio) }) : null,
            el("button", { class: "act", text: "📋 Копировать", onclick: () => copyText(ev.translation) })));
        if (audio) playAudio(audio);
      } catch (e) { card.remove(); toast(problem(e)); }
      list.scrollTop = list.scrollHeight;
    }
  }

  // the Android app calls this when it has shown the update dialog or wants the page to refresh its data
  window.__aiApp = { refresh: () => S.views.more && S.views.more.onShow() };
  // the phone's Back button: close what is open on top, then go back to the chat; false lets the app go to the background
  window.__aiBack = function () {
    const top = [...document.querySelectorAll(".sheet-bg, .viewer")].pop();
    if (top) { top.remove(); return true; }
    if (S.views.chat && S.tab !== "chat") { show("chat"); return true; }
    return false;
  };
  window.__aiTest = { md, tidyMath, parseLogin };

  if (store.get("token", "")) start();
  else renderLogin("");
})();
