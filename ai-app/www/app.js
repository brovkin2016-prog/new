/* ИИ-помощник: the app's screens. The same page runs in the Android app (network through window.AIBridge, which
   speaks HTTP/3 to the server) and in a browser (plain fetch). Conversations are kept on the phone in IndexedDB. */
"use strict";
(function () {
  const Native = window.AIBridge || null;
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
  function problem(e) {
    if (e instanceof HttpError) {
      if (e.status === 401) { setTimeout(() => logout(e.message), 50); return e.message; }
      return e.message;
    }
    return "Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.";
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
    app.append(el("div", { class: "login" },
      el("div", { class: "logo", text: "✦" }), el("h1", { text: "ИИ-помощник" }),
      el("p", { text: "Отвечает на вопросы, решает задания по фото, обрабатывает снимки, рисует и переводит." }),
      el("p", { text: "Для входа нужен код от администратора." }),
      inp, paste, go, err));
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
      return;
    }
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
      S.views.vpn = vpnView();
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
          el("span", { text: names[k] || k }), el("span", { text: max ? `${used} из ${max}` : `${used} · без лимита` })),
          max ? el("div", { class: "bar" }, el("i", { style: `width:${Math.min(100, (100 * used) / max)}%` })) : null));
      }
      lim.append(el("div", { style: "font-size:13px;color:var(--muted);margin-top:6px", text: "Лимиты обнуляются в полночь." }));
      scroll.append(lim);
      const theme = el("select", { onchange: () => { store.set("theme", theme.value); applyTheme(); } });
      for (const [k, v] of Object.entries(THEMES)) theme.append(el("option", { value: k, text: v, selected: k === store.get("theme", "system") }));
      const appCard = el("div", { class: "card" }, el("h3", { text: "Приложение" }),
        el("div", { class: "row" }, el("div", { class: "grow" }, "Вы вошли как", el("small", { text: me.name + (me.vip ? " · без лимитов" : "") }))),
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

  // ---------- the owner's VPN tab: giving people VPN access (bridges and the server stay in Telegram) ----------
  const UNLOCK_MS = 3 * 60 * 1000;
  let unlockedAt = 0, unlocking = null;
  function unlockPhone() {  // the phone's fingerprint or PIN; true, false, or "old" for an app without it
    if (Date.now() - unlockedAt < UNLOCK_MS || !Native) return Promise.resolve(true);
    if (!Native.unlock) return Promise.resolve("old");
    if (!unlocking) {  // one prompt at a time, however many times the tab is shown meanwhile
      unlocking = new Promise((resolve) => {
        window.__aiUnlock = (how) => {
          window.__aiUnlock = null;
          unlocking = null;
          if (how !== "no") unlockedAt = Date.now();
          resolve(how !== "no");
        };
        Native.unlock("Управление сервером");
      });
    }
    return unlocking;
  }
  function bytes(n) {
    n = +n || 0;
    for (const u of ["Б", "КБ", "МБ", "ГБ"]) { if (n < 1024) return (u === "Б" ? n : n.toFixed(1)) + " " + u; n /= 1024; }
    return n.toFixed(1) + " ТБ";
  }
  document.addEventListener("visibilitychange", () => {  // back from the background with the lock expired: ask again
    if (!document.hidden && !unlocking && S.tab === "vpn" && S.views.vpn && Date.now() - unlockedAt >= UNLOCK_MS) S.views.vpn.onShow();
  });
  function ago(ts) {
    const s = Math.max(0, Date.now() / 1000 - ts);
    return s < 3600 ? Math.max(1, Math.round(s / 60)) + " мин" : s < 86400 ? Math.round(s / 3600) + " ч" : Math.round(s / 86400) + " дн.";
  }
  function when(ts) {  // "сегодня 14:05", "вчера 09:12", "3 окт 18:40"
    const d = new Date(ts * 1000), now = new Date();
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
    return days === 0 ? "сегодня " + hm : days === 1 ? "вчера " + hm
      : d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", "") + " " + hm;
  }
  function badge(n) {  // a red count on the Управление tab
    const tab = document.querySelector('.tab[data-tab="vpn"]');
    if (!tab) return;
    let b = tab.querySelector(".badge");
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = el("span", { class: "badge" }); tab.append(b); }
    b.textContent = n > 9 ? "9+" : String(n);
  }
  // the owner's tab «Управление»: the server, VPN for family, and who may use this app (never in a family member's app)
  function vpnView() {
    const root = el("div", { class: "view" });
    const scroll = el("div", { class: "scroll" });
    root.append(scroll);
    let part = store.get("accessPart", "server"), open = false;
    const cache = { server: null, vpn: null, app: null, alerts: null };
    const OPS = { server: "status", vpn: "users", app: "app_list" };
    let data = null;
    const panel = (body, onStatus) => stream("/api/panel", body, (ev) => { if (ev.t === "status" && onStatus) onStatus(ev.text); });
    function locked(text, button, action) {
      scroll.innerHTML = "";
      scroll.append(el("div", { class: "empty" }, el("div", { class: "emoji", text: "🔒" }), el("h2", { text: "Управление" }),
        el("p", { text }), button ? el("button", { class: "btn", text: button, onclick: action }) : null));
    }
    async function enter() {
      locked("Подтвердите, что это вы: отпечатком или PIN телефона.", "Открыть", enter);
      const ok = await unlockPhone();
      if (ok === "old") {
        locked("Для этого раздела нужна новая версия приложения: вход в него — по отпечатку или PIN телефона.", "Обновить приложение",
          () => Native.checkUpdate(true));
        return;
      }
      if (!ok) { locked("Подтвердите, что это вы: отпечатком или PIN телефона.", "Открыть", enter); return; }
      open = true;
      load();
    }
    async function load() {
      if (!open) return;
      const want = part;
      if (!cache[want]) { draw(); scroll.append(el("div", { class: "status", style: "padding:20px" }, el("span", { class: "spin" }), "Загружаю…")); }
      try {
        const [end, ev] = await Promise.all([panel({ op: OPS[want] }), want === "server" ? panel({ op: "alerts", since: 0 }) : null]);
        if (end.t !== "done") throw new HttpError(500, end.text);
        cache[want] = end;
        if (ev && ev.t === "done") cache.alerts = ev.alerts.slice().reverse();
        if (part === want) draw();
      } catch (e) { if (!cache[want]) { draw(); scroll.append(el("p", { class: "status", style: "padding:12px", text: problem(e) })); } else toast(problem(e)); }
    }
    function draw() {
      scroll.innerHTML = "";
      const seg = el("div", { class: "seg", style: "margin-bottom:12px" });
      for (const [k, v] of [["server", "🖥 Сервер"], ["vpn", "🛡 VPN"], ["app", "🤖 Приложение"]]) {
        seg.append(el("button", { class: k === part ? "on" : "", text: v, onclick: () => { part = k; store.set("accessPart", k); refreshTop(); draw(); load(); } }));
      }
      scroll.append(seg);
      data = cache[part];
      if (!data) return;
      if (part === "app") return drawApp(data);
      if (part === "server") return drawServer(data);
      const on = data.users.filter((u) => u.online).length;
      const head = el("div", { class: "card" },
        el("div", { class: "row" }, el("div", { class: "grow" }, (data.vpn ? "🟢 VPN работает" : "🔴 VPN не работает") + " · " + data.host,
          el("small", { text: data.stats ? `Людей: ${data.users.length}, сейчас в сети: ${on}` : `Людей: ${data.users.length}` }))));
      if (data.vless !== null) head.append(el("div", { class: "row" }, el("div", { class: "grow" }, (data.vless ? "🟢" : "🔴") + " Запасной VLESS (TCP 443)",
        el("small", { text: "Когда Hysteria режут, работает он" }))));
      scroll.append(head, el("button", { class: "btn wide", style: "margin:0 0 12px", text: "➕ Выдать VPN", onclick: add }));
      const list = el("div", { class: "card" }, el("h3", { text: "Кому выдан" }));
      for (const u of data.users) {
        list.append(el("button", { class: "row", style: "width:100%;text-align:left", onclick: () => card(u.name) },
          el("span", { style: "font-size:20px", text: u.online ? "🟢" : "⚪" }),
          el("div", { class: "grow" }, u.name + (u.owner ? " 👑" : ""),
            el("small", { text: (u.online ? `в сети, подключений: ${u.online}` : "не в сети") + (u.tx || u.rx ? ` · ↓${bytes(u.tx)} ↑${bytes(u.rx)}` : "") })), "›"));
      }
      scroll.append(list, el("div", { style: "font-size:13px;color:var(--muted);padding:0 4px 12px",
        text: "О каждом добавлении и удалении VPN-бот пишет вам в Telegram. Мосты и сервер — там же." }));
    }
    // ---- the server at a glance, its bridges, traffic, events and the big buttons ----
    function stat(title, value, sub, pct, bad) {
      return el("div", { class: "stat" + (bad ? " bad" : "") }, el("small", { text: title }), el("b", { text: value }),
        pct !== undefined ? el("div", { class: "bar" }, el("i", { style: `width:${Math.max(2, Math.min(100, pct))}%` + (pct > 85 ? ";background:var(--danger)" : "") })) : null,
        sub ? el("small", { text: sub }) : null);
    }
    function dur(sec) {
      if (!sec && sec !== 0) return "";
      sec = Math.max(0, sec);
      return sec < 3600 ? Math.round(sec / 60) + " мин" : sec < 86400 ? Math.floor(sec / 3600) + " ч " + Math.round(sec % 3600 / 60) + " мин"
        : Math.floor(sec / 86400) + " д " + Math.round(sec % 86400 / 3600) + " ч";
    }
    const UNIT = { failed: "остановился", inactive: "выключен", activating: "запускается", deactivating: "останавливается" };
    function drawServer(d) {
      const bad = [];
      if (!d.vpn.ok) bad.push("VPN не работает");
      if (d.vless && !d.vless.ok) bad.push("запасной VLESS не работает");
      const brBad = d.bridges.filter((b) => !b.ok);
      if (brBad.length) bad.push(brBad.length === 1 ? `не работает мост «${brBad[0].label}»` : `не работают мосты: ${brBad.length}`);
      if (d.cert_days !== null && d.cert_days < 10) bad.push(`сертификат кончается через ${d.cert_days} дн.`);
      if (d.disk[1] && d.disk[0] / d.disk[1] > 0.92) bad.push("диск почти заполнен");
      scroll.append(el("div", { class: "card hero" + (bad.length ? " bad" : "") },
        el("div", { class: "emoji", text: bad.length ? "⚠️" : "✅" }),
        el("div", { class: "grow" }, el("b", { text: bad.length ? "Есть проблемы" : "Всё работает" }),
          el("small", { text: bad.length ? bad.join(" · ") : `${d.host} · ${d.ip}` + (d.online !== null ? ` · в сети: ${d.online}` : "") }))));
      const brOk = d.bridges.length - brBad.length;
      scroll.append(el("div", { class: "stats" },
        stat("VPN", d.vpn.ok ? "работает" : "не работает", d.vpn.ok && d.vpn.since ? dur(d.vpn.since) + " без перерыва" : UNIT[d.vpn.state] || d.vpn.state, undefined, !d.vpn.ok),
        stat("Мосты", d.bridges.length ? `${brOk} из ${d.bridges.length}` : "нет", brBad.length ? "есть неработающие" : "", undefined, brBad.length > 0),
        stat("Память", `${Math.round(100 * d.mem[0] / d.mem[1])}%`, `${(d.mem[0] / 1024).toFixed(1)} из ${(d.mem[1] / 1024).toFixed(1)} ГБ`, 100 * d.mem[0] / d.mem[1]),
        stat("Диск", `${Math.round(100 * d.disk[0] / d.disk[1])}%`, `${d.disk[0]} из ${d.disk[1]} ГБ`, 100 * d.disk[0] / d.disk[1]),
        stat("Нагрузка", `${Math.round(100 * d.load[0] / d.cpus)}%`, `ядер: ${d.cpus} · работает ${dur(d.uptime)}`, 100 * d.load[0] / d.cpus),
        stat("Сертификат", d.cert_days !== null ? `ещё ${d.cert_days} дн.` : "?", "продлевается сам", undefined, d.cert_days !== null && d.cert_days < 10)));
      // bridges
      if (d.bridges.length) {
        const card = el("div", { class: "card" }, el("h3", { text: "🌉 Мосты" }));
        for (const b of d.bridges) {
          card.append(el("div", { class: "row" }, el("span", { style: "font-size:18px", text: b.ok ? "🟢" : "🔴" }),
            el("div", { class: "grow" }, b.label, el("small", { text: (b.ok ? "работает " + dur(b.since) : UNIT[b.state] || b.state) + (+b.restarts ? ` · перезапусков: ${b.restarts}` : "") })),
            b.link ? el("button", { class: "icon-btn", title: "Ссылка", text: "🔗", onclick: () => bridgeLink(b) }) : null,
            el("button", { class: "icon-btn", title: "Перезапустить", text: "🔄", onclick: async () => {
              if (await confirmBox(`Перезапустить «${b.label}»? Ссылка останется прежней.`, "Перезапустить")) {
                act({ op: "bridge_restart", id: b.id }, "🔄 Перезапускаю мост…");
              }
            } })));
        }
        const st = d.selftest;
        card.append(el("div", { style: "font-size:13px;color:var(--muted);margin:8px 0", text: !st ? "Автопроверка моста: ещё не было"
          : st.ok ? `Проверка ${when(st.ts)}: ✓ ${st.mbit} Мбит/с, выход ${st.ip}` : `Проверка ${when(st.ts)}: ✗ ${st.err}` }),
          el("div", { class: "big-actions" },
            el("button", { class: "btn line", text: "🧪 Проверить", onclick: () => act({ op: "bridge_test" }, null, (r) => toast(r.selftest && r.selftest.ok ? `✓ Мост работает: ${r.selftest.mbit} Мбит/с` : "✗ Проверка не прошла", 5000)) }),
            el("button", { class: "btn line", text: "✉️ Тест почты", onclick: () => act({ op: "mail_test" }, null, (r) => toast("✉️ Письмо ушло" + (r.to ? " на " + r.to : ""), 5000)) })));
        scroll.append(card);
      }
      scroll.append(trafficCard(), eventsCard(), actionsCard(d));
    }
    function trafficCard() {
      const card = el("div", { class: "card" }, el("h3", { text: "📊 Трафик" }), el("div", { class: "status", text: "…" }));
      panel({ op: "traffic" }).then((t) => {
        if (t.t !== "done") return;
        card.lastChild.remove();
        if (t.month !== null) {
          const pct = 100 * t.month / (t.cap_gb * 1024 ** 3);
          card.append(el("div", { class: "row" }, el("div", { class: "grow" }, "За месяц", el("small", { text: `сегодня ${bytes(t.today)}` })),
            el("b", { text: `${bytes(t.month)} из ${Math.round(t.cap_gb / 1024)} ТБ` })),
          el("div", { class: "bar", style: "margin:2px 0 8px" }, el("i", { style: `width:${Math.max(1, Math.min(100, pct))}%` })));
        }
        const top = t.users.map((u) => [u.name, (u.tx || 0) + (u.rx || 0)]).filter((u) => u[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
        for (const [n, v] of top) card.append(el("div", { class: "row", style: "min-height:34px" }, el("div", { class: "grow", text: n }), el("small", { text: bytes(v) })));
        if (!top.length) card.append(el("small", { style: "color:var(--muted)", text: "С последнего перезапуска VPN трафика ещё не было." }));
      }).catch(() => { card.lastChild.textContent = "не загрузилось"; });
      return card;
    }
    function eventsCard() {
      const items = cache.alerts || [];
      const card = el("div", { class: "card" }, el("h3", { text: "🔔 События" }));
      if (!items.length) card.append(el("small", { style: "color:var(--muted)", text: "Пока тихо. О сбоях и починке напишу сюда и пришлю уведомление." }));
      const seen = store.get("alertsSeen", 0);
      for (const a of items.slice(0, 12)) {
        card.append(el("div", { class: "event " + a.kind + (a.ts > seen && a.kind !== "log" ? " new" : "") },
          el("small", { text: when(a.ts) }), el("div", { text: a.text })));
      }
      if (items.length) store.set("alertsSeen", items[0].ts);
      badge(0);
      return card;
    }
    function actionsCard(d) {
      return el("div", { class: "card" }, el("h3", { text: "⚙️ Сервер" }),
        el("button", { class: "btn line wide", text: "⚡ Скорость сервера", onclick: () => act({ op: "speed" }, null, (r) => toast(`⚡ Скорость сервера: ${r.mbit} Мбит/с`, 6000)) }),
        el("button", { class: "btn line wide", style: "margin-top:8px", text: "💾 Резервная копия на почту", onclick: async () => {
          if (await confirmBox("Сделать резервную копию сейчас? Она придёт на почту через минуту-две.", "Сделать")) act({ op: "backup" }, "💾 Делаю копию — она придёт на почту");
        } }),
        el("button", { class: "btn line wide danger", style: "margin-top:8px", text: "♻️ Перезагрузить сервер", onclick: async () => {
          if (await confirmBox("Перезагрузить сервер? VPN, мосты и помощник пропадут примерно на минуту.", "Перезагрузить")) act({ op: "reboot" }, "♻️ Перезагружаюсь, вернусь через минуту");
        } }),
        el("div", { style: "font-size:13px;color:var(--muted);margin-top:10px", text: d.mail ? "Сбои приходят уведомлением и письмом на почту." : "Почта для оповещений не настроена." }));
    }
    async function act(body, started, done) {  // a server action with its spinner; done(result) when it answers
      if (S.busy.vpn) { toast("Подождите, предыдущее действие ещё идёт"); return; }
      S.busy.vpn = true;
      if (started) toast(started, 4000);
      try {
        const end = await panel(body, (t) => toast(t, 120000));
        if (end.t !== "done") toast("⚠️ " + end.text, 6000);
        else { if (done) done(end); setTimeout(load, 1500); }
      } catch (e) { toast(problem(e)); } finally { S.busy.vpn = false; }
    }
    function bridgeLink(b) {
      sheet("🔗 " + b.label, (box) => {
        box.append(el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 10px", text: "Ссылку вставляют в приложение моста (whitelist-bypass) на этом устройстве." }),
          el("div", { style: "font:12px ui-monospace,monospace;word-break:break-all;background:var(--card);border-radius:10px;padding:10px;margin-bottom:10px", text: b.link }),
          el("div", { class: "big-actions" },
            el("button", { class: "btn", text: "📋 Копировать", onclick: () => copyText(b.link) }),
            el("button", { class: "btn line", text: "📤 Поделиться", onclick: () => (navigator.share ? navigator.share({ text: b.link }).catch(() => copyText(b.link)) : copyText(b.link)) })));
      });
    }

    // the AI app's people: add, send the app and a sign-in code, no limits, switch off, sign out, delete
    function drawApp(d) {
      scroll.append(el("button", { class: "btn wide", style: "margin:0 0 12px", text: "➕ Добавить человека", onclick: addPerson }));
      const list = el("div", { class: "card" }, el("h3", { text: "Кто пользуется приложением" }));
      for (const u of d.users) {
        const now = u.seen && Date.now() / 1000 - u.seen < 900;
        list.append(el("button", { class: "row", style: "width:100%;text-align:left", onclick: () => person(u.id) },
          el("span", { style: "font-size:20px", text: u.off ? "⏸" : now ? "🟢" : "⚪" }),
          el("div", { class: "grow" }, u.name + (u.vip ? " 👑" : "") + (u.id === d.me ? " · вы" : ""),
            el("small", { text: u.off ? "доступ отключён" : !u.seen ? "ещё не входил(а)" + (u.codes ? " · код отправлен" : "")
              : (now ? "сейчас в приложении" : "был(а) " + ago(u.seen) + " назад") + (u.devices > 1 ? ` · телефонов: ${u.devices}` : "") })), "›"));
      }
      scroll.append(list, el("div", { style: "font-size:13px;color:var(--muted);padding:0 4px 12px",
        text: (d.apk && d.apk.name ? `Версия приложения: ${d.apk.name}. ` : "") + "О каждом добавлении, отключении и удалении бот пишет вам в Telegram." }));
    }
    async function appOp(body, done) {
      if (S.busy.vpn) return null;
      S.busy.vpn = true;
      try {
        const end = await panel(body);
        if (end.t !== "done") { toast("⚠️ " + end.text, 5000); return null; }
        if (done) toast(done);
        load();
        return end;
      } catch (e) { toast(problem(e)); return null; } finally { S.busy.vpn = false; }
    }
    async function addPerson() {
      const name = await ask("Как зовут?", "Например: Мама, Саша");
      if (!name) return;
      const r = await appOp({ op: "app_add", name: name.replace(/\s+/g, " ").trim().slice(0, 40) }, null);
      if (r) invite(r);
    }
    async function apkFile() {  // older app versions cannot hand over themselves: fetch the file from the server
      const parts = [];
      let status = 0;
      await send("/app/ai.apk", null, (st) => (status = st), (b) => parts.push(b));
      if (status !== 200) throw new HttpError(status, "Файл приложения ещё не готов на сервере");
      return new Blob(parts, { type: "application/vnd.android.package-archive" });
    }
    function invite(r) {
      const host = (Native && Native.getHost && Native.getHost()) || location.host;
      const line = `${host}/${r.code}`;
      const text = `Привет! Это наш семейный ИИ-помощник 🙂\n1. Установи приложение из файла (если телефон спросит — разреши установку из этого источника).\n`
        + `2. Открой его и вставь код входа (кнопка «📋 Вставить из буфера»):\n${line}\nКод одноразовый, действует ${r.days} дн.`;
      sheet("✉️ Приглашение для «" + r.name + "»", (box, close) => {
        box.append(el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 10px",
          text: "Отправьте приложение и код одним сообщением — в Telegram, WhatsApp или как удобно." }),
          el("div", { style: "font:15px ui-monospace,monospace;text-align:center;background:var(--card);border-radius:12px;padding:12px;margin-bottom:12px", text: line }),
          el("button", { class: "btn wide", text: "📤 Отправить приложение и код", onclick: async () => {
            if (Native && Native.shareApp) { Native.shareApp(text); return; }
            toast("📲 Готовлю файл приложения…", 15000);
            try { shareBlob(await apkFile(), "ИИ-помощник.apk", text); } catch (e) { toast(problem(e)); }
          } }),
          el("div", { style: "height:8px" }),
          el("div", { class: "big-actions" },
            el("button", { class: "btn line", text: "📋 Код", onclick: () => copyText(line) }),
            el("button", { class: "btn line", text: "💬 Только текст", onclick: () => (navigator.share && !Native ? navigator.share({ text }).catch(() => {}) : copyText(text)) })),
          el("div", { style: "font-size:13px;color:var(--muted);margin-top:10px", text: `Код одноразовый, на ${r.days} дн. Второй телефон — новый код в карточке человека.` }));
      });
    }
    function person(id) {
      const d = cache.app;
      const u = d && d.users.find((x) => x.id === id);
      if (!u) return;
      const mine = u.id === d.me;
      const t = u.today || {};
      const lim = (k) => (u.vip ? "" : ` из ${d.limits[k]}`);
      sheet((u.off ? "⏸ " : "🤖 ") + u.name + (u.vip ? " 👑" : ""), (box, close) => {
        const act = (label, fn, cls) => el("button", { class: "btn wide " + (cls || "line"), style: "margin-top:8px", text: label, onclick: async () => { close(); await fn(); } });
        box.append(el("div", { style: "color:var(--muted);font-size:14px;margin:-6px 0 6px",
          text: (u.off ? "Доступ отключён" : !u.seen ? "Ещё не входил(а)" : "Был(а) " + ago(u.seen) + " назад") + ` · телефонов: ${u.devices}` }),
          el("div", { style: "font-size:14px;margin-bottom:6px", text: `Сегодня: вопросов ${t.text || 0}${lim("text")}, картинок ${t.draw || 0}${lim("draw")}, фото ${t.photo || 0}${lim("photo")}` }),
          act(mine ? "🔑 Код для второго телефона" : "🔑 Новый код и приглашение", async () => { const r = await appOp({ op: "app_code", id: u.id }); if (r) invite(r); }, ""),
          act(u.vip ? "👑 Снять «без лимитов»" : "👑 Без лимитов", () => appOp({ op: "app_set", id: u.id, vip: !u.vip }, u.vip ? "Лимиты включены" : "👑 Без лимитов")));
        if (mine) {
          box.append(el("div", { style: "font-size:13px;color:var(--muted);margin-top:10px", text: "Это вы: отключить или удалить свой вход можно только в Telegram-боте." }));
          return;
        }
        box.append(act(u.off ? "▶️ Включить доступ" : "⏸ Отключить доступ", () => appOp({ op: "app_set", id: u.id, off: !u.off }, u.off ? "▶️ Доступ включён" : "⏸ Доступ отключён")),
          act("🚪 Выйти на всех телефонах", async () => {
            if (await confirmBox(`Выйти у «${u.name}» на всех телефонах? Для входа понадобится новый код.`, "Выйти")) appOp({ op: "app_logout", id: u.id }, "🚪 Готово");
          }),
          act("🗑 Удалить из приложения", async () => {
            if (await confirmBox(`Удалить «${u.name}» из приложения? Доступ и память помощника о нём пропадут. VPN не затрагивается.`, "Удалить"))
              appOp({ op: "app_delete", id: u.id }, "🗑 Удалён(а): " + u.name);
          }, "line danger"));
      });
    }
    async function add() {
      if (S.busy.vpn) return;
      const name = await ask("Имя для VPN", "Латиницей, например mama или ivan_phone");
      if (!name) return;
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) { toast("Только латиница, цифры, «_» и «-», до 32 знаков", 4000); return; }
      S.busy.vpn = true;
      toast("⏳ Добавляю «" + name + "»…", 20000);
      try {
        const end = await panel({ op: "add", name });
        if (end.t !== "done") toast("⚠️ " + end.text, 5000);
        else { toast("✅ Выдан VPN: " + name); await load(); card(name, end); }
      } catch (e) { toast(problem(e)); }
      S.busy.vpn = false;
    }
    async function card(name, have) {
      let u = have;
      if (!u) {
        try {
          const end = await panel({ op: "user", name });
          if (end.t !== "done") { toast("⚠️ " + end.text); return; }
          u = end;
        } catch (e) { toast(problem(e)); return; }
      }
      sheet("👤 " + u.name + (u.owner ? " 👑" : ""), (box, close) => {
        box.append(el("div", { style: "color:var(--muted);font-size:14px;margin:-6px 0 10px",
          text: (u.online ? `🟢 в сети, подключений: ${u.online}` : "⚪ не в сети") + ` · ↓${bytes(u.tx)} ↑${bytes(u.rx)}` }));
        const kinds = [["hy2", "Hysteria", "основной, быстрый (UDP)"], ["vless", "VLESS", "запасной, когда режут UDP"]].filter((k) => u.links[k[0]]);
        const pane = el("div");
        const chips = el("div", { class: "chips", style: "margin-bottom:10px" });
        const pick = (k) => {
          chips.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c.dataset.k === k[0]));
          const link = u.links[k[0]];
          const png = u.qr[k[0]] ? blobOf(u.qr[k[0]], "image/png") : null;
          const file = `vpn-${u.name}-${k[1].toLowerCase()}.png`;
          const text = `VPN для ${u.name} (${k[1]}):\n${link}\n\nИмпорт: v2RayTun или v2rayN → «+» → из буфера обмена или по QR-коду.`;
          pane.innerHTML = "";
          pane.append(el("div", { style: "font-size:13px;color:var(--muted);margin-bottom:8px", text: k[1] + " — " + k[2] }),
            png ? el("img", { src: urlOf(png), style: "display:block;width:220px;max-width:70%;margin:0 auto 10px;background:#fff;border-radius:12px;padding:6px",
              onclick: () => viewer(png, file) }) : null,
            el("div", { style: "font:12px ui-monospace,monospace;word-break:break-all;background:var(--card);border-radius:10px;padding:8px;margin-bottom:10px", text: link }),
            el("div", { class: "big-actions" },
              el("button", { class: "btn", text: "📤 Поделиться", onclick: () => (png ? shareBlob(png, file, text) : copyText(text)) }),
              el("button", { class: "btn line", text: "📋 Копировать", onclick: () => copyText(link) })));
        };
        for (const k of kinds) chips.append(el("button", { class: "chip", "data-k": k[0], text: k[1], onclick: () => pick(k) }));
        if (kinds.length > 1) box.append(chips);
        box.append(pane);
        pick(kinds[0]);
        const va = cache.vpn && cache.vpn.vpn_app;
        if (va && u.links.hy2) {
          box.append(el("button", { class: "btn wide", style: "margin-top:14px", text: "📲 Отправить приложение VPN и ссылку", onclick: () => {
            const text = `Привет! Это VPN «Winger» 🛡\n1. Установи приложение «Winger VPN» из файла (если телефон спросит — разреши установку).\n`
              + `2. Скопируй ссылку ниже, открой приложение и нажми «Вставить ссылку».\n${u.links.hy2}\n3. Нажми большую кнопку — готово.`;
            if (Native && Native.shareFromServer) Native.shareFromServer("/app/vpn.apk", "Winger VPN.apk", "application/vnd.android.package-archive", text);
            else { copyText(text); toast("Текст со ссылкой скопирован. Чтобы отправить и сам файл, обновите приложение.", 5000); }
          } }));
        }
        if (!u.owner) {
          box.append(el("button", { class: "btn line wide", style: "margin-top:14px;color:var(--danger)", text: "🗑 Удалить", onclick: async () => {
            if (!(await confirmBox(`Удалить «${u.name}»? Его VPN сразу перестанет работать.`, "Удалить"))) return;
            close();
            toast("⏳ Удаляю «" + u.name + "»…", 20000);
            try {
              const end = await panel({ op: "del", name: u.name });
              toast(end.t === "done" ? "🗑 Удалён: " + u.name : "⚠️ " + end.text, 4000);
              load();
            } catch (e) { toast(problem(e)); }
          } }));
        }
      });
    }
    // unread events for the tab's badge, without opening the tab (and without the fingerprint question)
    async function peek() {
      try {
        const seen = store.get("alertsSeen", 0);
        const ev = await panel({ op: "alerts", since: seen });
        if (ev.t === "done" && S.tab !== "vpn") badge(ev.alerts.filter((a) => a.kind !== "log").length);
      } catch (e) { /* quiet */ }
    }
    return { root, peek, redraw: () => open && draw(),
      sub: () => ({ server: "состояние, мосты, события", vpn: "выдача VPN: ссылки и QR", app: "кто пользуется приложением" })[part],
      buttons: () => (open ? [["🔄", "Обновить", load]] : []),
      onShow: () => (open && Date.now() - unlockedAt < UNLOCK_MS ? load() : (open = false, enter())) };
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
