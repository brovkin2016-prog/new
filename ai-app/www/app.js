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
    constructor(status, text) { super(text || "Ошибка " + status); this.status = status; }
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
    return code ? code[0] : "";
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
  function toast(text, ms) {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    const t = el("div", { class: "toast", text });
    document.body.append(t);
    setTimeout(() => t.remove(), ms || 2600);
  }
  function sheet(title, build) {
    const bg = el("div", { class: "sheet-bg" });
    const box = el("div", { class: "sheet" }, el("div", { class: "grab" }), title ? el("h2", { text: title }) : null);
    const close = () => bg.remove();
    bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
    build(box, close);
    bg.append(box);
    document.body.append(bg);
    return close;
  }
  function menu(title, items) {
    sheet(title, (box, close) => {
      const list = el("div", { class: "list" });
      for (const it of items) {
        if (!it) continue;
        list.append(el("button", { onclick: () => { close(); it[2](); } }, el("span", { class: "ic", text: it[0] }), el("span", { text: it[1] })));
      }
      box.append(list);
    });
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
  function confirmBox(title, yes) {
    return new Promise((resolve) => {
      sheet(title, (box, close) => {
        box.append(el("div", { class: "big-actions" },
          el("button", { class: "btn line", text: "Отмена", onclick: () => { close(); resolve(false); } }),
          el("button", { class: "btn", text: yes || "Да", onclick: () => { close(); resolve(true); } })));
      });
    });
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
  function renderLogin(message) {
    const app = $("#app");
    app.innerHTML = "";
    const inp = el("input", { class: "input", placeholder: "XXXX-XXXX", autocomplete: "off", autocapitalize: "characters", spellcheck: "false" });
    const err = el("div", { class: "msg-err", text: message || "" });
    const go = el("button", { class: "btn wide", text: "Войти" });
    async function login() {
      const p = parseLogin(inp.value);
      if (!p) { err.textContent = "Вставьте код из сообщения администратора."; return; }
      if (Native) {
        const host = p.host || (Native.getHost && Native.getHost());
        if (!host) { err.textContent = "Вставьте строку целиком — вместе с адресом сервера."; return; }
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
    const paste = el("button", { class: "btn soft wide", text: "📋 Вставить из буфера", onclick: async () => {
      let t = "";
      try { t = Native && Native.clipboard ? Native.clipboard() : await navigator.clipboard.readText(); } catch (e) { /* no access */ }
      if (t) { inp.value = t.trim(); if (parseLogin(t)) login(); } else toast("В буфере ничего нет — вставьте вручную");
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
        err.textContent = `✉️ Код отправлен на ${r.to}. Скопируйте строку из письма и нажмите «📋 Вставить из буфера».`;
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
      el("p", { text: "Отвечает на вопросы, решает задания по фото, обрабатывает снимки, рисует и переводит." }),
      el("p", { text: "Для входа нужен код от администратора." }),
      inp, paste, go, err, mail));
  }
  async function logout(message) {
    try { await api("/api/logout", {}); } catch (e) { /* signed out anyway */ }
    store.set("token", "");
    if (Native && Native.setOwner) Native.setOwner("");  // no server notifications on a signed-out phone
    renderLogin(message || "");
  }

  // ---------- the main screen ----------
  const TABS = [["chat", "💬", "Чат"], ["study", "📚", "Учёба"], ["photo", "🖼", "Фото"], ["more", "☰", "Ещё"]];
  const TITLES = { chat: "Чат", study: "Учёба", photo: "Фото и картинки", vpn: "Управление", more: "Ещё" };
  const tabsFor = (me) => (me && me.panel ? TABS.slice(0, 3).concat([["vpn", "🛡", "Управление"]], TABS.slice(3)) : TABS);
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
        return code({ Native, S, api, ask, blobOf, confirmBox, copyText, el, nativeCall, problem, refreshTop, shareBlob, sheet,
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
    const owner = S.me.panel ? ownerCode() : null;  // fetched while the conversations load
    if (S.me.panel) store.set("wasOwner", true);
    await DB.open();
    for (const t of ["chat", "study", "photo"]) S.msgs[t] = await DB.list(t);
    const app = $("#app");
    app.innerHTML = "";
    const shell = el("div", { class: "shell" });
    S.top = el("div", { class: "top" });
    S.viewsEl = el("div", { class: "views" });
    const tabs = el("div", { class: "tabs" });
    for (const [key, ic, name] of tabsFor(S.me)) {
      tabs.append(el("button", { class: "tab", "data-tab": key, onclick: () => show(key) }, el("span", { class: "ic", text: ic }), el("span", { text: name })));
    }
    shell.append(S.top, S.viewsEl, tabs);
    app.append(shell);
    S.views = { chat: chatView(), study: studyView(), photo: photoView(), more: moreView() };
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
    S.tab = tab;
    store.set("tab", tab);
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    for (const [k, v] of Object.entries(S.views)) v.root.classList.toggle("hidden", k !== tab);
    const v = S.views[tab];
    S.top.innerHTML = "";
    const sub = v.sub ? v.sub() : "";
    S.top.append(el("h1", {}, TITLES[tab], sub ? el("span", { class: "sub", text: sub }) : null));
    for (const b of v.buttons ? v.buttons() : []) S.top.append(el("button", { class: "icon-btn", title: b[1], text: b[0], onclick: b[2] }));
    if (v.onShow) v.onShow();
  }
  function refreshTop() { if (S.views[S.tab]) show(S.tab); }

  // ---------- reminders: the phone rings by itself (the app's own alarm); the server only works out when and what ----------
  const REMIND_ASK = /^\s*(?:пожалуйста,?\s+)?(напомни|напомнить|поставь\s+напоминание)(?![а-яё])/i;
  function remindSet(r) {
    if (!(Native && Native.remindAdd)) return "\n\nНапоминание звенит в приложении на телефоне — обновите приложение.";
    const id = Native.remindAdd(JSON.stringify(r));
    if (!id) return "\n\n⚠️ Не получилось поставить напоминание на телефоне.";
    if (Native.askNotify && !store.get("askedNotify", false)) { store.set("askedNotify", true); Native.askNotify(); }
    return "\n\nТелефон напомнит сам, даже без интернета. Отменить — «☰ Ещё» → «⏰ Напоминания».";
  }
  function remindersCard() {
    const card = el("div", { class: "card" }, el("h3", { text: "⏰ Напоминания" }));
    let list = [];
    try { list = JSON.parse(Native.reminders() || "[]"); } catch (e) { /* none */ }
    if (!list.length) {
      card.append(el("small", { style: "color:var(--muted)", text: "Пока нет. Напишите или скажите в чате: «Напомни завтра в 9 выпить таблетку» — телефон напомнит сам, даже без интернета." }));
    }
    const again = { daily: " · каждый день", weekly: " · каждую неделю", monthly: " · каждый месяц" };
    for (const r of list) {
      const at = new Date(r.at).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
      card.append(el("div", { class: "row" }, el("div", { class: "grow" }, r.text, el("small", { text: at + (again[r.repeat] || "") })),
        el("button", { class: "icon-btn", text: "🗑", title: "Удалить", onclick: () => {
          Native.remindDel(r.id); card.replaceWith(remindersCard()); toast("Напоминание удалено");
        } })));
    }
    return card;
  }

  // ---------- conversation threads (chat and study) ----------
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
    const wrap = el("div", { class: "msg " + (m.role === "me" ? "me" : "ai") });
    const b = el("div", { class: "bubble" + (m.err ? " err" : "") });
    if (m.image) b.append(el("img", { class: "thumb", src: urlOf(m.image), onclick: () => viewer(m.image, "photo.jpg") }));
    if (m.file) b.append(el("div", { class: "file-chip", text: "📄 " + m.file }));
    if (m.result) {
      b.append(el("img", { class: "result", src: urlOf(m.result), onclick: () => viewer(m.result, m.name || "picture.jpg") }));
    }
    if (m.video) b.append(el("video", { class: "result", controls: true, playsinline: true, src: urlOf(m.video) }));
    if (m.pdf) b.append(el("div", { class: "file-chip", style: "background:var(--accent-soft);margin-bottom:6px", text: "📄 " + (m.name || "document.pdf") }));
    if (m.role === "me") { if (m.text) b.append(el("div", { text: m.text })); }
    else if (m.text) b.append(el("div", { html: md(m.text) }));
    if (m.audio) b.append(el("audio", { controls: true, src: urlOf(m.audio) }));
    wrap.append(b);
    if (m.label) wrap.append(el("div", { class: "label", text: m.label }));
    const file = m.result || m.video || m.pdf;
    if (file) {  // a picture, video or PDF that came out: keep it, share it, or (in Photo) work on it further
      wrap.append(el("div", { class: "acts" },
        el("button", { class: "act", text: "⬇️ Сохранить", onclick: () => { saveBlob(file, m.name || "result"); toast("Сохранено"); } }),
        el("button", { class: "act", text: "📤 Поделиться", onclick: () => shareBlob(file, m.name || "result") }),
        thread === "photo" && m.result ? el("button", { class: "act", text: "✏️ Дальше", onclick: () => S.views.photo.set(m.result) }) : null));
    } else if (m.role === "ai" && m.text && !m.err) {
      const acts = el("div", { class: "acts" });
      acts.append(el("button", { class: "act", text: "📋 Копировать", onclick: () => copyText(plain(m.text)) }));
      if (S.me.can.speak) acts.append(el("button", { class: "act", text: "🔊", title: "Озвучить", onclick: () => speakMsg(m, thread) }));
      if (!m.note) {
        acts.append(el("button", { class: "act", text: "✂️ Короче", onclick: () => list.follow("short") }),
          el("button", { class: "act", text: "➕ Подробнее", onclick: () => list.follow("more") }));
      }
      wrap.append(acts);
    }
    return wrap;
  }
  async function speakMsg(m, thread) {
    if (m.audio) { playAudio(m.audio); return; }
    toast("🔊 Озвучиваю…");
    try {
      const ev = await stream("/api/speak", { text: plain(m.text) }, () => {});
      if (ev.t !== "done") { toast(ev.text); return; }
      m.audio = blobOf(ev.audio, "audio/ogg");
      await DB.put(m);
      S.views[thread].redraw();
      playAudio(m.audio);
    } catch (e) { toast(problem(e)); }
  }
  // a thread of messages with a live answer bubble; used by Chat, Study and Photo
  function thread(name, scroll, emptyState) {
    const box = el("div", { class: "msgs" });
    const api2 = {
      box,
      redraw() {
        box.innerHTML = "";
        if (!S.msgs[name].length && emptyState) box.append(emptyState());
        for (const m of S.msgs[name]) box.append(msgEl(m, name, api2));
        api2.down();
      },
      down() { requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; }); },
      async add(m) {
        m.thread = name;
        m.ts = Date.now();
        await DB.add(m);
        S.msgs[name].push(m);
        if (S.msgs[name].length > 400) { S.msgs[name] = S.msgs[name].slice(-300); DB.trim(name, 300); }
        return m;
      },
      // asks the server and shows the answer as it is written
      async run(path, body, mine) {
        if (S.busy[name]) { toast("Подождите, ещё отвечаю…"); return null; }
        S.busy[name] = true;
        if (mine) { await api2.add(mine); api2.redraw(); }
        const live = el("div", { class: "msg ai" });
        const b = el("div", { class: "bubble" });
        const content = el("div");
        const status = el("div", { class: "status" }, el("span", { class: "spin" }), el("span", { text: "Думаю…" }));
        b.append(content, status);
        live.append(b);
        if (box.firstChild && box.firstChild.classList.contains("empty")) box.firstChild.remove();
        box.append(live);
        api2.down();
        let text = "", timer = null, said = "Думаю…", t0 = Date.now();
        const clock = setInterval(() => {
          const sec = Math.round((Date.now() - t0) / 1000);
          if (sec >= 5 && !status.classList.contains("hidden")) status.lastChild.textContent = said + " " + sec + " с";
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
      follow(kind) {
        const shown = { short: "✂️ Короче", more: "➕ Подробнее" }[kind];
        api2.ask({ followup: kind }, { role: "me", text: shown, ctx: shown });
      },
      ask: null,  // set by the view
    };
    return api2;
  }

  // speech to text in place of the input row; onText gets what was said
  async function dictate(row, onText) {
    try { await Rec.start(); } catch (e) { toast("Нет доступа к микрофону"); return; }
    const time = el("span", { class: "time", text: "0:00" });
    const recRow = el("div", { class: "rec" }, el("span", { class: "dot" }), time,
      el("button", { class: "round ghost", text: "✕", onclick: () => finish(false) }),
      el("button", { class: "round main", text: "✓", onclick: () => finish(true) }));
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
  function chatView() {
    const root = el("div", { class: "view" });
    const scroll = el("div", { class: "scroll" });
    const empty = () => el("div", { class: "empty" }, el("div", { class: "emoji", text: "✦" }), el("h2", { text: "Спросите что угодно" }),
      el("div", { text: "Пишите, говорите голосом 🎤, присылайте фото и документы 📎" }),
      el("div", { class: "hints" }, ...["Объясни, как работает ипотека", "Составь меню на неделю", "Помоги ответить на письмо"]
        .concat(S.me.can.draw ? ["Нарисуй кота-космонавта на Луне"] : [])
        .map((t) => el("button", { class: "hint", text: t, onclick: () => { ta.value = t; ta.focus(); sync(); } }))));
    const th = thread("chat", scroll, empty);
    scroll.append(th.box);
    const attach = el("div", { class: "attach-row hidden" });
    const chips = el("div", { class: "chips hidden", style: "padding:0 4px 8px" });
    const ta = el("textarea", { rows: 1, placeholder: "Сообщение" });
    autoGrow(ta);
    const clip = el("button", { class: "round ghost", text: "📎", title: "Прикрепить", onclick: attachMenu });
    const act = el("button", { class: "round main", text: "🎤" });
    const row = el("div", { class: "inrow" }, clip, ta, act);
    const composer = el("div", { class: "composer" }, attach, chips, row);
    root.append(scroll, composer);
    let image = null, doc = null;

    function sync() {
      const has = ta.value.trim() || image || doc || S.idea;
      act.textContent = has ? "➤" : "🎤";
      attach.innerHTML = "";
      attach.classList.toggle("hidden", !(image || doc || S.idea));
      if (image) attach.append(el("img", { src: urlOf(image) }));
      if (doc) attach.append(el("div", { class: "chip", text: "📄 " + doc.name }));
      if (S.idea) attach.append(el("div", { class: "chip on", text: S.me.ideas[S.idea][0] }));
      if (image || doc || S.idea) attach.append(el("button", { class: "x", text: "✕", onclick: () => { image = doc = null; S.idea = null; ta.placeholder = "Сообщение"; sync(); } }));
      chips.innerHTML = "";
      chips.classList.toggle("hidden", !image);
      if (image) {
        for (const op of ["describe", "ocr", "translate"]) {  // answers in words; tools for the photo itself live in Photo
          if (S.me.ai_ops[op]) chips.append(el("button", { class: "chip", text: S.me.ai_ops[op], onclick: () => sendNow({ op }) }));
        }
      }
    }
    ta.addEventListener("input", sync);
    function sendNow(extra) {
      const text = ta.value.trim();
      if (!text && !image && !doc && !(extra && extra.op)) return;
      const req = Object.assign({ text }, extra || {});
      if (S.idea) req.idea = S.idea;
      const shown = (extra && extra.op ? S.me.ai_ops[extra.op] + (text ? ": " + text : "") : "") || (S.idea ? S.me.ideas[S.idea][0] + ": " + text : text);
      const mine = { role: "me", text: shown, image, file: doc ? doc.name : null };
      const im = image, d = doc;
      ta.value = "";
      ta.style.height = "auto";
      image = doc = null;
      S.idea = null;
      ta.placeholder = "Сообщение";
      sync();
      th.ask(req, mine, im, d);
    }
    th.ask = async (req, mine, im, d) => {
      if (!im && !d && !req.op && !req.idea && !req.followup && req.text && REMIND_ASK.test(req.text)) {
        await th.run("/api/remind", { text: req.text }, mine);  // «напомни …»: the phone rings by itself
        return;
      }
      const body = Object.assign({ context: context("chat") }, req);
      if (im) body.image = await b64(await shrink(im, 2048, 0.88));
      if (d) body.doc = { name: d.name, mime: d.type || "", data: await b64(d) };
      await th.run("/api/chat", body, mine);
    };
    act.onclick = () => (act.textContent === "➤" ? sendNow() : record());
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); sendNow(); } });

    function record() {
      dictate(row, (text) => th.ask({ text, voice: true }, { role: "me", text: "🎤 " + text, ctx: text }));
    }
    function attachMenu() {
      menu("Прикрепить", [
        ["📷", "Камера", async () => { const f = await pickFile("image/*", true); if (f) { image = f; sync(); } }],
        ["🖼", "Фото из галереи", async () => { const f = await pickFile("image/*"); if (f) { image = f; sync(); } }],
        ["📄", "Документ: PDF, Word, текст", async () => {
          const f = await pickFile(".pdf,.docx,.pptx,.epub,.txt,.md,.csv,.json,.html,text/*,application/pdf");
          if (f) { if (f.size > 14e6) toast("Файл больше 14 МБ"); else { doc = f; sync(); } }
        }],
        ["💡", "Готовые задачи", ideasMenu],
      ]);
    }
    function ideasMenu() {
      menu("Готовые задачи", Object.entries(S.me.ideas).map(([k, v]) => [v[0].split(" ")[0], v[0].split(" ").slice(1).join(" "), () => {
        S.idea = k;
        ta.placeholder = v[1];
        sync();
        ta.focus();
      }]));
    }
    th.redraw();
    return {
      root, redraw: th.redraw,
      sub: () => S.me.modes[S.me.mode],
      buttons: () => [["🧹", "Новый чат", async () => {
        if (!S.msgs.chat.length || !(await confirmBox("Начать новый чат? Эта переписка удалится.", "Новый чат"))) return;
        await DB.clear("chat");
        S.msgs.chat = [];
        th.redraw();
      }]],
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
    let grade = store.get("grade", "5");
    const head = el("div");
    const EMPTY = { notes: ["Сфотографируйте параграф", "Конспект главного и тест, чтобы проверить себя."],
      retell: ["Сфотографируйте текст", "Пересказ своими словами, план и главная мысль."],
      essay: ["Тема сочинения", "Напишите тему или сфотографируйте задание — сочинение под возраст и требования."],
      check: ["Сфотографируйте своё решение", "Найду ошибки и объясню, как исправить."] };
    const empty = () => el("div", { class: "empty" }, el("div", { class: "emoji", text: "📚" }),
      el("h2", { text: (EMPTY[mode] || ["Сфотографируйте задание"])[0] }),
      el("div", { text: (EMPTY[mode] || ["", "Примеры, задачи, упражнения, вопросы по любому предмету — от 1 класса до вуза."])[1] }));
    const th = thread("study", scroll, empty);
    scroll.append(head, th.box);
    const ta = el("textarea", { rows: 1, placeholder: "Задание, тема сочинения или вопрос" });
    autoGrow(ta);
    const cam = el("button", { class: "round ghost", text: "📷", title: "Фото задания", onclick: () => shoot(true) });
    const act = el("button", { class: "round main", text: "➤", onclick: () => submit() });
    const composer = el("div", { class: "composer" }, el("div", { class: "inrow" }, cam, ta, act));
    root.append(scroll, composer);

    function drawHead() {
      head.innerHTML = "";
      const sel = el("select", { onchange: () => { grade = sel.value; store.set("grade", grade); refreshTop(); } });
      for (const [k, v] of GRADES) sel.append(el("option", { value: k, text: v, selected: k === grade }));
      const seg = el("div", { class: "seg grid2" });
      for (const [k, v] of Object.entries(STUDY_MODES)) {
        seg.append(el("button", { class: k === mode ? "on" : "", text: v[0], onclick: () => { mode = k; store.set("studyMode", k); drawHead(); if (!S.msgs.study.length) th.redraw(); } }));
      }
      const card = el("div", { class: "card" },
        el("div", { class: "row" }, el("div", { class: "grow" }, "Кто учится"), sel),
        seg, el("div", { style: "font-size:14px;color:var(--muted);margin-top:8px", text: STUDY_MODES[mode][1] }));
      head.append(card);
      if (!S.msgs.study.length) {
        head.append(el("div", { class: "big-actions", style: "margin-bottom:12px" },
          el("button", { class: "big primary", onclick: () => shoot(true) }, el("span", { class: "ic", text: "📷" }), "Сфотографировать"),
          el("button", { class: "big", onclick: () => shoot(false) }, el("span", { class: "ic", text: "🖼" }), "Из галереи")));
      }
      ta.placeholder = mode === "essay" ? "Тема сочинения и требования" : S.msgs.study.length ? "Спросите про решение"
        : mode === "notes" || mode === "retell" ? "Текст или тема" : "Задание или вопрос";
    }
    async function shoot(camera) {
      const f = await pickFile("image/*", camera);
      if (f) solve(f);
    }
    async function solve(im, text) {
      const shown = STUDY_MODES[mode][0] + (text ? ": " + text : "");
      const body = { mode, grade, text: text || "", context: [] };
      body.image = await b64(await shrink(im, 1800, 0.9));
      await th.run("/api/study", body, { role: "me", text: shown, image: im });
      drawHead();
    }
    function submit() {
      const text = ta.value.trim();
      if (!text) { shoot(true); return; }
      ta.value = "";
      ta.style.height = "auto";
      const follow = S.msgs.study.length > 0 && !["essay", "notes", "retell"].includes(mode);
      th.run("/api/study", { mode: follow ? "ask" : mode, grade, text, context: follow ? context("study") : [] },
        { role: "me", text: follow ? text : STUDY_MODES[mode][0] + ": " + text }).then(drawHead);
    }
    th.ask = async (req, mine) => {
      await th.run("/api/study", Object.assign({ mode: "ask", grade, context: context("study"), text: "" }, req), mine);
    };
    drawHead();
    th.redraw();
    return {
      root, redraw: th.redraw, solve,
      sub: () => (GRADES.find((g) => g[0] === grade) || ["", ""])[1],
      buttons: () => [["🧹", "Очистить", async () => {
        if (!S.msgs.study.length || !(await confirmBox("Очистить решения?", "Очистить"))) return;
        await DB.clear("study");
        S.msgs.study = [];
        th.redraw();
        drawHead();
      }]],
      onShow: () => th.down(),
    };
  }

  // ---------- Photo: send a photo and say what to do; without a photo, describe a picture to draw ----------
  const QUICK = ["enhance", "removebg", "restore", "colorize", "animate", "scan"];  // the rest is under «Ещё» or in words
  const STYLE_ASKS = [["🎌", "В стиле аниме", "Перерисуй в стиле аниме"], ["🧸", "Как мультфильм Pixar", "Сделай как кадр из мультфильма Pixar, 3D"],
    ["🌻", "Как картина Ван Гога", "Перерисуй как картину Ван Гога"], ["🏖", "Фон — море", "Замени фон на берег моря"],
    ["🧹", "Убрать лишних людей", "Убери посторонних людей на заднем плане"]];
  function photoView() {
    const root = el("div", { class: "view" });
    const scroll = el("div", { class: "scroll" });
    const empty = () => el("div", { class: "empty" }, el("div", { class: "emoji", text: "🖼" }), el("h2", { text: "Фото и картинки" }),
      el("div", { text: "Пришлите фото и напишите или скажите 🎤, что сделать: «убери фон», «раскрась», «оживи», «сделай в стиле аниме»."
        + (S.me.can.draw ? " Без фото — опишите картинку, и я её нарисую." : "") }),
      el("div", { class: "big-actions", style: "margin:16px 0 4px" },
        el("button", { class: "big primary", onclick: () => pick(true) }, el("span", { class: "ic", text: "📷" }), "Снять фото"),
        el("button", { class: "big", onclick: () => pick(false) }, el("span", { class: "ic", text: "🖼" }), "Из галереи")),
      S.me.can.draw ? el("div", { class: "hints" }, ...["Рыжий кот-космонавт на Луне, акварель", "Уютный домик в снежном лесу ночью",
        "Открытка с днём рождения для мамы"].map((t) => el("button", { class: "hint", text: "🎨 " + t, onclick: () => { ta.value = t; sync(); ta.focus(); } }))) : null);
    const th = thread("photo", scroll, empty);
    scroll.append(th.box);
    const scanBar = el("div", { class: "banner hidden", style: "margin:0 4px 8px" });
    const attach = el("div", { class: "attach-row hidden" });
    const chips = el("div", { class: "chips hidden", style: "padding:0 4px 8px" });
    const ta = el("textarea", { rows: 1 });
    autoGrow(ta);
    const cam = el("button", { class: "round ghost", text: "📷", title: "Фото", onclick: () => menu("Фото", [
      ["📷", "Снять", () => pick(true)], ["🖼", "Из галереи", () => pick(false)]]) });
    const act = el("button", { class: "round main", text: "🎤" });
    const row = el("div", { class: "inrow" }, cam, ta, act);
    root.append(scroll, el("div", { class: "composer" }, scanBar, attach, chips, row));
    let photo = null;

    function label(op) { return S.me.photo_ops[op] || S.me.ai_ops[op] || op; }
    function sync() {
      act.textContent = ta.value.trim() ? "➤" : "🎤";
      ta.placeholder = photo ? "Что сделать с фото?" : S.me.can.draw ? "Опишите картинку — нарисую" : "Пришлите фото 📷";
      attach.innerHTML = "";
      attach.classList.toggle("hidden", !photo);
      chips.innerHTML = "";
      chips.classList.toggle("hidden", !photo);
      if (photo) {
        attach.append(el("img", { src: urlOf(photo), onclick: () => viewer(photo, "photo.jpg") }),
          el("div", { style: "font-size:13px;color:var(--muted);flex:1", text: "Фото выбрано. Нажмите кнопку или напишите, что сделать" }),
          el("button", { class: "x", text: "✕", onclick: () => { photo = null; sync(); } }));
        for (const op of QUICK) if (S.me.photo_ops[op] || S.me.ai_ops[op]) chips.append(el("button", { class: "chip", text: label(op), onclick: () => runOp(op) }));
        chips.append(el("button", { class: "chip", text: "⋯ Ещё", onclick: more }));
      }
      scanBar.innerHTML = "";
      scanBar.classList.toggle("hidden", !S.scan.length);
      if (S.scan.length) {
        scanBar.append(el("span", { style: "flex:1", text: `📑 Страниц для PDF: ${S.scan.length}` }),
          el("button", { class: "act", text: "📄 Собрать PDF", onclick: makePdf }),
          el("button", { class: "act", text: "✕", onclick: () => { S.scan = []; sync(); } }));
      }
    }
    ta.addEventListener("input", sync);
    act.onclick = () => (ta.value.trim() ? send() : dictate(row, (t) => { ta.value = t; send(); }));
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); send(); } });
    function more() {
      const items = Object.keys(S.me.photo_ops).filter((op) => !QUICK.includes(op))
        .map((op) => { const [ic, ...rest] = label(op).split(" "); return [ic, rest.join(" "), () => runOp(op)]; });
      if (S.me.ai_ops.edit) {
        for (const [ic, name, words] of STYLE_ASKS) items.push([ic, name, () => { ta.value = words; send(); }]);
        items.push(["🪄", "Своё изменение — опишите словами", () => { ta.placeholder = "Например: сделай зиму, добавь шляпу"; ta.focus(); }]);
      }
      menu("Что сделать с фото", items);
    }
    async function pick(camera) {
      const f = await pickFile("image/*", camera);
      if (f) set(f);
    }
    function set(im) { photo = im; show("photo"); sync(); th.down(); }
    async function go(path, body, shown) {
      if (S.busy.photo) { toast("Подождите, предыдущая ещё делается"); return; }
      const im = photo;
      if (im) body.image = await b64(await shrink(im, 3072, 0.92));
      const out = await th.run(path, body, { role: "me", image: im, text: shown });
      if (out && out.op === "scan" && out.result) { S.scan.push(out.result); sync(); }
    }
    function runOp(op) {
      if (op === "animate") go("/api/animate", {}, label(op));
      else go("/api/photo", { op }, label(op));
    }
    function send() {
      const text = ta.value.trim();
      if (!text) return;
      if (!photo && !S.me.can.draw) { toast("Сначала пришлите фото: 📷 слева"); return; }
      ta.value = "";
      ta.style.height = "auto";
      sync();
      if (photo) go("/api/photo_do", { text }, text);
      else go("/api/draw", { prompt: text }, "🎨 " + text);
    }
    async function makePdf() {
      if (S.busy.photo || !S.scan.length) return;
      const pages = await Promise.all(S.scan.map((b) => b64(b)));
      const n = pages.length;
      const out = await th.run("/api/pdf", { pages }, { role: "me", text: `📄 Собрать PDF: ${n} стр.` });
      if (out && out.pdf) { out.name = out.name || "scan.pdf"; S.scan = []; sync(); }
    }
    sync();
    th.redraw();
    return {
      root, set, redraw: th.redraw,
      sub: () => (photo ? "фото выбрано" : "обработка и рисование"),
      buttons: () => [["🧹", "Очистить", async () => {
        if (!S.msgs.photo.length || !(await confirmBox("Удалить все готовые фото и картинки из списка?", "Очистить"))) return;
        await DB.clear("photo");
        S.msgs.photo = [];
        th.redraw();
      }]],
      onShow: () => th.down(),
    };
  }

  // ---------- More: translator, settings, memory, limits, app ----------
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
          el("span", { style: "font-size:24px", text: "🗣" }), el("div", { class: "grow" }, "Переводчик", el("small", { text: "Говорите — переведу и озвучу" })), "›")));
      if (Native && Native.reminders) scroll.append(remindersCard());
      const modeSel = el("select", { onchange: () => setPref({ mode: modeSel.value }) });
      for (const [k, v] of Object.entries(me.modes)) modeSel.append(el("option", { value: k, text: v, selected: k === me.mode }));
      const modelSel = el("select", { onchange: () => setPref({ model: modelSel.value }) });
      for (const [k, v] of Object.entries(me.models)) modelSel.append(el("option", { value: k, text: v, selected: k === me.model }));
      const card = el("div", { class: "card" }, el("h3", { text: "Общение" }),
        el("div", { class: "row" }, el("div", { class: "grow" }, "Режим"), modeSel),
        Object.keys(me.models).length > 2 ? el("div", { class: "row" }, el("div", { class: "grow" }, "Модель", el("small", { text: "Авто — самая умная из доступных" })), modelSel) : null);
      if (me.can.speak) {
        card.append(el("div", { class: "row" }, el("div", { class: "grow" }, "Отвечать голосом", el("small", { text: "На голосовые вопросы" })),
          el("button", { class: "toggle" + (me.vreply ? " on" : ""), onclick: () => setPref({ vreply: !me.vreply }) })));
        if (Object.keys(me.voices).length > 1) {
          const vSel = el("select", { onchange: () => setPref({ voice: vSel.value }) });
          for (const [k, v] of Object.entries(me.voices)) vSel.append(el("option", { value: k, text: v, selected: k === me.voice }));
          card.append(el("div", { class: "row" }, el("div", { class: "grow" }, "Голос"), vSel));
        }
      }
      scroll.append(card);
      const mem = el("div", { class: "card" }, el("h3", { text: "🧠 Что я о вас помню" }));
      if (!me.memory.length) mem.append(el("div", { style: "color:var(--muted);font-size:14px", text: "Пока ничего. Скажите в чате: «Запомни, что…»" }));
      for (const f of me.memory) {
        mem.append(el("div", { class: "row" }, el("div", { class: "grow", text: f }),
          el("button", { class: "icon-btn", text: "✕", onclick: async () => { const r = await api("/api/memory", { forget: f }).catch(() => null); if (r) { S.me.memory = r.memory; draw(); } } })));
      }
      mem.append(el("button", { class: "btn soft wide", style: "margin-top:8px", text: "➕ Добавить", onclick: async () => {
        const t = await ask("Что запомнить?", "Например: у меня двое детей, младшему 7 лет");
        if (t) { const r = await api("/api/memory", { add: t }).catch((e) => toast(problem(e))); if (r) { S.me.memory = r.memory; draw(); } }
      } }));
      scroll.append(mem);
      const lim = el("div", { class: "card" }, el("h3", { text: "📊 Сегодня" }));
      const names = { text: "Вопросы", draw: "Картинки", photo: "Обработка фото", video: "Оживление фото" };
      for (const [k, [used, max]] of Object.entries(me.limits)) {
        if (k === "video" && !me.ai_ops.animate) continue;
        lim.append(el("div", { style: "margin:6px 0" }, el("div", { style: "display:flex;justify-content:space-between;font-size:14px" },
          el("span", { text: names[k] || k }), el("span", { text: max ? `${used} из ${max}` : String(used) })),
          max ? el("div", { class: "bar" }, el("i", { style: `width:${Math.min(100, (100 * used) / max)}%` })) : null));
      }
      lim.append(el("div", { style: "font-size:13px;color:var(--muted);margin-top:6px", text: "Лимиты обнуляются в полночь." }));
      scroll.append(lim);
      const theme = el("select", { onchange: () => { store.set("theme", theme.value); applyTheme(); } });
      for (const [k, v] of Object.entries(THEMES)) theme.append(el("option", { value: k, text: v, selected: k === store.get("theme", "system") }));
      const appCard = el("div", { class: "card" }, el("h3", { text: "Приложение" }),
        el("div", { class: "row" }, el("div", { class: "grow" }, "Вы вошли как", el("small", { text: me.name }))),
        el("div", { class: "row" }, el("div", { class: "grow" }, "Тема"), theme));
      if (Native && Native.version) {
        appCard.append(el("div", { class: "row" }, el("div", { class: "grow" }, "Версия", el("small", { text: Native.version() })),
          el("button", { class: "act", text: "Проверить обновление", onclick: () => Native.checkUpdate(true) })));
        const p = Native.netInfo ? Native.netInfo() : "";
        if (p) appCard.append(el("div", { class: "row" }, el("div", { class: "grow" }, "Связь с сервером",
          el("small", { text: p.endsWith(" vpn") ? "Через VPN телефона, TCP 8443 ✓" : p === "h3" ? "HTTP/3 по UDP — быстрый путь ✓"
            : "TCP 8443 — запасной путь (UDP не проходит)" }))));
      }
      appCard.append(el("button", { class: "btn line wide", style: "margin-top:10px", text: "Выйти", onclick: async () => {
        if (await confirmBox("Выйти из приложения? Для входа снова понадобится код.", "Выйти")) logout("");
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
    const scr = el("div", { class: "viewer", style: "background:var(--bg)" });
    const top = el("div", { class: "top" }, el("button", { class: "icon-btn", text: "←", onclick: () => scr.remove() }), el("h1", { text: "Переводчик" }));
    const langs = el("div", { class: "chips", style: "padding:10px 12px 0" });
    const list = el("div", { class: "scroll" });
    const ta = el("textarea", { rows: 1, placeholder: "Или напишите текст" });
    autoGrow(ta);
    const mic = el("button", { class: "mic-big", text: "🎤" });
    const hint = el("div", { style: "text-align:center;color:var(--muted);font-size:14px;margin:8px 0", text: "Нажмите и говорите — на любом из двух языков" });
    const bottom = el("div", { class: "composer" }, mic, hint, el("div", { class: "inrow" }, ta, el("button", { class: "round main", text: "➤", onclick: () => { const t = ta.value.trim(); if (t) { ta.value = ""; translate(t, null); } } })));
    function paintLangs() {
      langs.innerHTML = "";
      for (const [k, v] of Object.entries(me.langs)) {
        langs.append(el("button", { class: "chip" + (k === target ? " on" : ""), text: v[0] + " " + v[1], onclick: () => { target = k; store.set("trLang", k); paintLangs(); } }));
      }
    }
    paintLangs();
    scr.append(top, langs, list, bottom);
    document.body.append(scr);
    let recording = false;
    mic.onclick = async () => {
      if (!recording) {
        try { await Rec.start(); } catch (e) { toast("Нет доступа к микрофону"); return; }
        recording = true;
        mic.classList.add("on");
        mic.textContent = "⏹";
        hint.textContent = "Говорите… нажмите ещё раз, когда закончите";
        return;
      }
      recording = false;
      mic.classList.remove("on");
      mic.textContent = "🎤";
      hint.textContent = "Нажмите и говорите — на любом из двух языков";
      const r = Rec.stop(true);
      if (!r || r.duration < 0.6) return;
      const card = el("div", { class: "tr-card" }, el("div", { class: "status" }, el("span", { class: "spin" }), "Слушаю…"));
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
            el("button", { class: "act", text: "📋", onclick: () => copyText(ev.translation) })));
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
