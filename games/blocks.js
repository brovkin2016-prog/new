/* Падающие блоки — a crystal well under the aurora: stack the seven four-cell shapes into full rows.
   10×20 well, rotation with wall kicks, hold, three next, ghost, soft/hard drop, level speed-up every 10 lines, combos.
   Written against the Winger Games engine (engine.js, ENGINE.md). Our own game and our own names. */
"use strict";
(function () {
  const { art, PAL } = WG;
  const COLS = 10, ROWS = 22, HID = 2, VIS = 20, C = 10; // 22 rows, the top two are hidden above the well
  const WX = 142, WY = 8, WW = COLS * C, WH = VIS * C;     // the well's inner rectangle on the 384×216 screen
  const ORDER = "IJLOSTZ";
  const cl = WG.util.clamp, ease = WG.util.ease;
  const num = (n) => WG.fmtNum(n).replace(/\s/g, " ");

  // ---------- colours: each shape gets a base and the bevel tones are derived ----------
  const hexRGB = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const mix = (a, b, t) => {
    const A = hexRGB(a), B = hexRGB(b);
    return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("");
  };
  const BASE = { I: "#5ED6EA", J: "#6F8BFF", L: "#FF9F5A", O: "#FFD27A", S: "#34D399", T: "#A08CFF", Z: "#FF6B7A", X: "#6B7694" };
  const TONES = {};
  for (const k of Object.keys(BASE)) {
    const b = BASE[k];
    TONES[k] = { hi: mix(b, "#FFFFFF", 0.78), lt: mix(b, "#FFFFFF", 0.42), b, md: mix(b, "#04070F", 0.18), sh: mix(b, "#04070F", 0.4), dk: mix(b, "#04070F", 0.68) };
  }
  // a beveled block: light edge top-left, dark edge bottom-right, a lit face with a gleam
  const tileCache = {};
  function tile(k, n) {
    const key = k + n;
    if (tileCache[key]) return tileCache[key];
    const c = WG.canvas(n, n), g = c.getContext("2d"), T = TONES[k];
    const px = (x, y, col) => { g.fillStyle = col; g.fillRect(x, y, 1, 1); };
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const ring = Math.min(x, y, n - 1 - x, n - 1 - y);
      let col;
      if (ring === 0) col = x + y < n - 1 ? (x === 0 || y === 0 ? T.lt : T.b) : T.dk;
      else if (ring === 1 && n >= 8) col = x + y < n - 1 ? T.hi : T.sh;
      else {
        const f = (x + y) / (2 * n);
        col = f < 0.3 ? T.lt : f < 0.62 ? T.b : T.md;
        if (n >= 8 && (x + y) % 2 === 0 && f > 0.34 && f < 0.5) col = T.b;
      }
      px(x, y, col);
    }
    if (n >= 8) { px(2, 2, "#FFFFFF"); px(3, 2, T.hi); px(2, 3, T.hi); px(n - 3, n - 3, T.sh); }
    else if (n >= 6) px(1, 1, "#FFFFFF");
    return (tileCache[key] = c);
  }
  const ghostCache = {};
  function ghostTile(k) {
    if (ghostCache[k]) return ghostCache[k];
    const c = WG.canvas(C, C), g = c.getContext("2d");
    g.fillStyle = BASE[k]; g.globalAlpha = 0.14; g.fillRect(0, 0, C, C);
    g.globalAlpha = 0.85;
    g.fillRect(0, 0, C, 1); g.fillRect(0, C - 1, C, 1); g.fillRect(0, 0, 1, C); g.fillRect(C - 1, 0, 1, C);
    g.globalAlpha = 0.4; g.fillStyle = TONES[k].lt; g.fillRect(2, 2, 2, 1); g.fillRect(2, 2, 1, 2);
    return (ghostCache[k] = c);
  }

  // ---------- the seven shapes, SRS-style boxes and wall-kick tables ----------
  const SHAPE0 = {
    I: [[0, 1], [1, 1], [2, 1], [3, 1]], J: [[0, 0], [0, 1], [1, 1], [2, 1]], L: [[2, 0], [0, 1], [1, 1], [2, 1]],
    O: [[1, 0], [2, 0], [1, 1], [2, 1]], S: [[1, 0], [2, 0], [0, 1], [1, 1]], T: [[1, 0], [0, 1], [1, 1], [2, 1]], Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
  };
  const ROT = {};
  for (const k of ORDER) {
    const n = k === "I" ? 4 : 3;
    ROT[k] = [SHAPE0[k]];
    for (let r = 1; r < 4; r++) ROT[k][r] = ROT[k][r - 1].map(([x, y]) => (k === "O" ? [x, y] : [n - 1 - y, x]));
  }
  // kicks as [dx, dy] with y up (the usual tables); flipped when applied
  const KICK = {
    "01": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]], "10": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    "12": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]], "21": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    "23": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]], "32": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    "30": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]], "03": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  };
  const KICK_I = {
    "01": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]], "10": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
    "12": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]], "21": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
    "23": [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]], "32": [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
    "30": [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]], "03": [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  };

  // ---------- the level themes: the sky changes every level ----------
  const THEMES = [
    { sky: { seed: 5, top: "#04070F", bottom: "#142449", curtain: 0.5 }, acc: "#34D399", acc2: "#7FE6F4", far: "#15234A", mid: "#0F1A38", pine: "#0A1530" },
    { sky: { seed: 6, top: "#0A0620", bottom: "#2A1B5E", curtain: 0.46 }, acc: "#A08CFF", acc2: "#C4BBFF", far: "#251A55", mid: "#1A1240", pine: "#100B2C" },
    { sky: { seed: 7, top: "#031418", bottom: "#0B3B4A", curtain: 0.52 }, acc: "#22B8CF", acc2: "#D2FAFF", far: "#0C3340", mid: "#08242E", pine: "#051820" },
    { sky: { seed: 8, top: "#14060C", bottom: "#4A1A34", curtain: 0.48 }, acc: "#FF6B7A", acc2: "#FFC2C9", far: "#3A1530", mid: "#290E24", pine: "#1A0817" },
    { sky: { seed: 9, top: "#0F0B02", bottom: "#4A3410", curtain: 0.5 }, acc: "#FFD27A", acc2: "#FFF0C2", far: "#3A2A10", mid: "#291C0A", pine: "#1A1206" },
    { sky: { seed: 10, top: "#03140C", bottom: "#0B4A33", curtain: 0.54 }, acc: "#8EF0C6", acc2: "#D8FFE9", far: "#0C3A2A", mid: "#082A1E", pine: "#041C14" },
  ];
  const SKY_H = 130;

  // ---------- music: an original little theme in A minor (a lead, an arpeggio, a bass, drums) ----------
  function buildSong() {
    const bars = [["A", "C", "E"], ["F", "A", "C"], ["C", "E", "G"], ["G", "B", "D"], ["D", "F", "A"], ["A", "C", "E"], ["F", "A", "C"], ["E", "G#", "B"]];
    const lead = [
      "E5 - . C5 E5 - A5 - G5 . E5 . C5 . . .", "F5 - . A5 C6 - A5 - G5 . F5 . C5 . . .", "E5 - G5 - C6 - . G5 E5 . G5 . E5 . . .", "D5 - G5 - B5 - G5 - D6 - . B5 G5 . D5 .",
      "D5 - F5 - A5 - D6 - C6 . A5 . F5 . D5 .", "C5 - E5 - A5 - C6 - B5 . A5 . E5 . C5 .", "A5 - C6 - F6 - E6 - C6 . A5 . C6 . F5 .", "B5 - G#5 - E5 - G#5 - B5 - . - E6 - - -",
    ].join(" ");
    const root = ["A", "F", "C", "G", "D", "A", "F", "E"];
    const LET = "CDEFGAB";
    const up = (chord) => { let oct = 4, prev = -1; return chord.map((n) => { const li = LET.indexOf(n[0]); if (li < prev) oct++; prev = li; return n + oct; }); };
    const arp = bars.map((b) => { const n = up(b); const hi = b[1][0] + (LET.indexOf(b[1][0]) < LET.indexOf(b[0][0]) ? 6 : 5); void hi; return [n[0], n[1], n[2], n[1].replace(/\d/, (d) => +d + 1)].join(" "); }).map((s) => (s + " ").repeat(4).trim()).join(" ");
    const bass = root.map((r) => `${r}2 . ${r}3 . ${r}2 . ${r}3 . ${r}2 . ${r}3 . ${r}2 . ${r}3 .`).join(" ");
    const drums = ["k . h . s . h . k . h k s . h h", "k . h . s . h . k . h k s . h o"].join(" ").repeat(1);
    return { bpm: 144, ch: [
      { w: "p25", v: 0.11, sus: 0.55, notes: lead },
      { w: "p12", v: 0.045, sus: 0.3, notes: arp },
      { w: "tri", v: 0.2, sus: 0.8, notes: bass },
      { w: "noise", v: 0.17, notes: drums },
    ] };
  }
  const MUSIC = buildSong();

  // ---------- the scenery, drawn once per theme ----------
  const sceneCache = {};
  function scene(i) {
    if (sceneCache[i]) return sceneCache[i];
    const T = THEMES[i], mk = (w, h) => WG.canvas(w, h);
    const far = mk(448, 100), mid = mk(448, 90), near = mk(448, 60), lake = mk(384, 32);
    const capCol = mix(T.far, "#DDE7F7", 0.4), capCol2 = mix(T.far, "#DDE7F7", 0.2);
    const fg = far.getContext("2d");
    art.ridge(fg, 0, 74, 448, 46, T.far, 3 + i, 100, 0.12);
    // snow caps: the highest cells of each column get a light dithered crown
    const img = fg.getImageData(0, 0, 448, 100).data;
    for (let x = 0; x < 448; x++) {
      let top = 0; while (top < 100 && !img[(top * 448 + x) * 4 + 3]) top++;
      for (let d = 0; d < 7; d++) {
        const y = top + d, thr = (7 - d) / 9;
        if (((x * 7 + y * 13) % 8) / 8 < thr) { fg.fillStyle = d < 2 ? capCol : capCol2; fg.fillRect(x, y, 1, 1); }
      }
    }
    art.ridge(mid.getContext("2d"), 0, 62, 448, 30, T.mid, 9 + i, 90, 0.05);
    art.pines(mid.getContext("2d"), 0, 74, 448, T.pine, 21 + i, 6, 15, 6);
    art.pines(near.getContext("2d"), 0, 58, 448, mix(T.pine, "#000000", 0.45), 34 + i, 12, 26, 11);
    art.bands(lake.getContext("2d"), 0, 0, 384, 32, [T.mid, mix(T.mid, T.sky.bottom, 0.5), mix(T.pine, "#000000", 0.5)]);
    art.dither(lake.getContext("2d"), 0, 0, 384, 4, null, T.pine, 0.6);
    return (sceneCache[i] = { far, mid, near, lake });
  }

  // ---------- static pieces of the interface ----------
  let FRAME = null, WELL = null;
  function paintWell() {
    const c = WG.canvas(WW, WH), g = c.getContext("2d");
    art.bands(g, 0, 0, WW, WH, ["#060B1A", "#0A1228", "#0D1A33", "#0F2438"]);
    // the faint cell grid
    for (let y = 1; y < VIS; y++) for (let x = 1; x < COLS; x++) { g.fillStyle = "rgba(127,230,244,.16)"; g.fillRect(x * C, y * C, 1, 1); }
    for (let x = 1; x < COLS; x++) { g.fillStyle = "rgba(127,230,244,.05)"; g.fillRect(x * C, 0, 1, WH); }
    for (let y = 1; y < VIS; y++) { g.fillStyle = "rgba(127,230,244,.04)"; g.fillRect(0, y * C, WW, 1); }
    art.dither(g, 0, 0, WW, 3, null, "#000000", 0.5);
    art.dither(g, 0, WH - 6, WW, 6, null, "#34D399", 0.05);
    return c;
  }
  function paintFrame() {
    const c = WG.canvas(WG.W, WG.H), g = c.getContext("2d");
    const x0 = WX - 5, y0 = WY - 5, w = WW + 10, h = WH + 10;
    const edge = "#04070F", dk = "#1D2944", md = "#3B4766", lt = "#5F6F93", hi = "#A9B6CD";
    g.fillStyle = edge; g.fillRect(x0 - 1, y0 - 1, w + 2, h + 2);
    g.fillStyle = md; g.fillRect(x0, y0, w, h);
    g.fillStyle = lt; g.fillRect(x0, y0, w, 1); g.fillRect(x0, y0, 1, h);
    g.fillStyle = hi; g.fillRect(x0 + 1, y0 + 1, w - 2, 1); g.fillRect(x0 + 1, y0 + 1, 1, h - 2);
    g.fillStyle = dk; g.fillRect(x0 + w - 1, y0, 1, h); g.fillRect(x0, y0 + h - 1, w, 1);
    // ice rivets along the sides
    for (let y = y0 + 8; y < y0 + h - 6; y += 20) for (const x of [x0 + 2, x0 + w - 4]) {
      g.fillStyle = dk; g.fillRect(x, y, 2, 2); g.fillStyle = hi; g.fillRect(x, y, 1, 1);
    }
    for (let x = x0 + 12; x < x0 + w - 8; x += 20) for (const y of [y0 + 2, y0 + h - 4]) {
      g.fillStyle = dk; g.fillRect(x, y, 2, 2); g.fillStyle = hi; g.fillRect(x, y, 1, 1);
    }
    // the well's own cut: a dark inner lip, and the hole itself
    g.clearRect(WX, WY, WW, WH);
    g.fillStyle = edge; g.fillRect(WX - 1, WY - 1, WW + 2, 1); g.fillRect(WX - 1, WY - 1, 1, WH + 2); g.fillRect(WX + WW, WY - 1, 1, WH + 2); g.fillRect(WX - 1, WY + WH, WW + 2, 1);
    // gems on the four corners
    for (const [x, y] of [[x0 + 1, y0 + 1], [x0 + w - 4, y0 + 1], [x0 + 1, y0 + h - 4], [x0 + w - 4, y0 + h - 4]]) {
      g.fillStyle = "#0B6E8A"; g.fillRect(x, y, 3, 3); g.fillStyle = "#7FE6F4"; g.fillRect(x, y, 2, 2); g.fillStyle = "#FFFFFF"; g.fillRect(x, y, 1, 1);
    }
    return c;
  }
  function panel(g, x, y, w, h, title, acc) {
    g.fillStyle = "rgba(6,10,24,.66)"; g.fillRect(x + 1, y, w - 2, h); g.fillRect(x, y + 1, w, h - 2);
    g.fillStyle = "#26324F"; g.fillRect(x + 1, y, w - 2, 1); g.fillRect(x + 1, y + h - 1, w - 2, 1); g.fillRect(x, y + 1, 1, h - 2); g.fillRect(x + w - 1, y + 1, 1, h - 2);
    g.fillStyle = "#3B4766"; g.fillRect(x + 2, y + 1, w - 4, 1);
    if (title) {
      WG.text(g, title, x + w / 2, y + 5, { align: "center", color: "#A9B6CD" });
      g.fillStyle = acc; g.fillRect(x + 8, y + 14, w - 16, 1);
      g.fillStyle = "rgba(255,255,255,.35)"; g.fillRect(x + 8, y + 14, 6, 1);
    }
  }

  const GOLD_T = ["#FFF0C2", "#FFF0C2", "#FFD27A", "#FFD27A", "#FFD27A", "#C98A1B", "#C98A1B"];
  const INK_T = ["#FFFFFF", "#FFFFFF", "#EAF0FA", "#EAF0FA", "#C9D6F2", "#C9D6F2", "#A9B6CD"];
  const MINT_T = ["#D8FFE9", "#D8FFE9", "#8EF0C6", "#8EF0C6", "#3BDB9E", "#3BDB9E", "#1FA874"];
  const LINE_WORDS = ["", "ЛИНИЯ", "ДВЕ ЛИНИИ", "ТРИ ЛИНИИ", "ЧЕТЫРЕ ЛИНИИ!"];
  const LINE_PTS = [0, 100, 300, 500, 800];

  // ---------- the game ----------
  WG.game({
    id: "blocks",
    portrait: false,
    controls: { dpad: true, a: "Поворот", b: "Запас", swipe: true, landscapeDpad: true },
    howto: "Складывай падающие фигуры в сплошные ряды: ряд исчезает, а скорость растёт каждые 10 рядов. Придержи фигуру про запас и смотри, что идёт дальше.",
    keysHint: "←→ — сдвиг, ↓ — ускорить, ↑ или X — поворот, Z — назад, Пробел — сбросить, C или Shift — запас, Esc — пауза.",
    touchHowto: (l) => (l.dpad ? "Крестовина: ←→ сдвиг, ↓ ускорить, ↑ сбросить. Кнопки: поворот и запас." : "Свайп влево-вправо — сдвиг, вниз — ускорить, вверх — сбросить, касание — поворот, касание «запаса» — запас."),
    titleColors: ["#D8FFE9", "#D8FFE9", "#7FE6F4", "#7FE6F4", "#A08CFF", "#A08CFF", "#6F8BFF"],
    music: MUSIC,
    create(api) {
      if (!FRAME) { FRAME = paintFrame(); WELL = paintWell(); }
      const fx = new WG.Particles(700), amb = new WG.Particles(120);
      const rnd = WG.rng(Date.now() & 0xffff);
      const coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
      const S = {
        t: 0, phase: "idle", countT: 0, grid: [], piece: null, hold: null, holdUsed: false, queue: [], bag: [],
        score: 0, lines: 0, level: 1, combo: -1, b2b: false, gAcc: 0, lockT: 0, resets: 0, lowY: 0, das: 0, dasDir: 0,
        clearRows: null, clearT: 0, clearRank: 0, collapse: null, entryT: 0, flashes: [], trails: [], pops: [], banner: null,
        overT: 0, overRow: 0, ended: false, playMs: 0, pieces: 0, tetrises: 0, theme: 0, themeBlend: 0, prevTheme: 0, shineT: 0,
        cam: 0, camT: 0, ambT: 0, lastDrop: 0, cmds: [], kEdge: {},
      };
      for (let y = 0; y < ROWS; y++) S.grid.push(new Array(COLS).fill(0));

      // ----- helpers -----
      const gravity = () => { const L = S.level - 1; return Math.max(1 / 60 / 3, Math.pow(0.8 - L * 0.007, L) * 0.9); };
      function refill() {
        while (S.queue.length < 8) {
          const bag = ORDER.split("");
          for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
          S.queue.push(...bag);
        }
      }
      refill();
      const cells = (p) => ROT[p.k][p.r];
      function collides(k, r, x, y) {
        for (const [cx, cy] of ROT[k][r]) {
          const gx = x + cx, gy = y + cy;
          if (gx < 0 || gx >= COLS || gy >= ROWS) return true;
          if (gy >= 0 && S.grid[gy][gx]) return true;
        }
        return false;
      }
      const landY = (p) => { let y = p.y; while (!collides(p.k, p.r, p.x, y + 1)) y++; return y; };
      const sfxMove = () => api.tone({ w: "p12", f: 300, d: 0.018, v: 0.05 });
      function pop(text, color, scale, y) { S.pops.push({ text, color, scale: scale || 1, y: y === undefined ? 70 : y, t: 0, life: 1.2 }); }
      function spawn(k) {
        refill();
        const kind = k || S.queue.shift();
        S.piece = { k: kind, r: 0, x: 3, y: 1 };
        S.holdUsed = k ? S.holdUsed : false;
        S.gAcc = 0; S.lockT = 0; S.resets = 0; S.lowY = 2; S.lastDrop = 0;
        S.pieces++;
        refill();
        if (collides(kind, 0, 3, 1)) { gameOver(); return false; }
        // an early start: slide down one when there is room (the usual spawn drop)
        if (!collides(kind, 0, 3, 2)) S.piece.y = 2;
        return true;
      }
      const grounded = () => collides(S.piece.k, S.piece.r, S.piece.x, S.piece.y + 1);
      function touched() { // a successful move or turn while resting restarts the lock timer (up to 15 times)
        if (grounded() && S.resets < 15) { S.lockT = 0; S.resets++; }
      }
      function shift(dx) {
        const p = S.piece;
        if (collides(p.k, p.r, p.x + dx, p.y)) return false;
        p.x += dx; touched(); sfxMove(); S.camT = (p.x + 1.5 - 4.5) / 4.5;
        return true;
      }
      function turn(dir) {
        const p = S.piece;
        if (p.k === "O") { api.tone({ w: "p25", f: 440, d: 0.03, v: 0.04 }); return true; }
        const nr = (p.r + dir + 4) % 4, table = (p.k === "I" ? KICK_I : KICK)["" + p.r + nr];
        for (const [dx, dy] of table) {
          if (!collides(p.k, nr, p.x + dx, p.y - dy)) {
            p.r = nr; p.x += dx; p.y -= dy; touched();
            api.tone({ w: "p25", f: dir > 0 ? 520 : 470, f2: dir > 0 ? 740 : 330, d: 0.05, v: 0.07 });
            return true;
          }
        }
        return false;
      }
      function doHold() {
        if (S.holdUsed || !S.piece) return;
        const cur = S.piece.k;
        api.tone({ w: "p25", f: 420, f2: 250, d: 0.09, v: 0.08 });
        const prev = S.hold;
        S.hold = cur; S.holdUsed = true;
        const was = S.holdUsed;
        if (prev) spawn(prev); else spawn();
        S.holdUsed = was;
        fx.emit({ x: 70, y: 36, n: 8, colors: [TONES[cur].lt, "#FFFFFF"], speed: [10, 40], life: [0.2, 0.4], drag: 3, shape: "spark" });
      }
      function hardDrop() {
        const p = S.piece, y = landY(p), dist = y - p.y;
        if (dist > 0) {
          S.trails.push({ k: p.k, cs: cells(p).map(([cx, cy]) => [p.x + cx, p.y + cy]), d: dist, t: 0 });
          S.score += 2 * dist;
        }
        p.y = y;
        api.tone({ w: "tri", f: 190, f2: 60, d: 0.12, v: 0.26 });
        api.tone({ w: "noise", d: 0.06, v: 0.1, lp: 3000 });
        api.shake(1.5 + Math.min(2, dist / 8), 0.1);
        lock(true);
      }
      function lock(hard) {
        const p = S.piece, col = ORDER.indexOf(p.k) + 1;
        let above = true;
        for (const [cx, cy] of cells(p)) {
          const gx = p.x + cx, gy = p.y + cy;
          if (gy >= HID) above = false;
          if (gy >= 0) S.grid[gy][gx] = col;
          S.flashes.push({ x: gx, y: gy, t: 0 });
          if (gy >= HID) fx.emit({ x: WX + gx * C + 5, y: WY + (gy - HID + 1) * C - 1, n: hard ? 2 : 1, colors: [TONES[p.k].lt, "#FFFFFF", "#A9B6CD"], speed: [8, 30], angle: [-Math.PI * 0.9, -Math.PI * 0.1], life: [0.15, 0.35], drag: 2, shape: "dot" });
        }
        if (!hard) api.tone({ w: "tri", f: 150, f2: 80, d: 0.08, v: 0.18 });
        S.piece = null;
        if (above) { gameOver(); return; }
        const full = [];
        for (let y = 0; y < ROWS; y++) if (S.grid[y].every((v) => v)) full.push(y);
        if (full.length) {
          S.phase = "clear"; S.clearRows = full; S.clearT = 0; S.clearRank = 0;
          api.sfx("coin");
        } else {
          S.combo = -1;
          S.phase = "play"; S.entryT = 0.04;
          if (S.hold === null && false) return;
        }
      }
      function finishClear() {
        const rows = S.clearRows, n = rows.length;
        // rows above each cleared one fall by the number of cleared rows below them
        const shifts = new Array(ROWS).fill(0);
        for (let y = 0; y < ROWS; y++) shifts[y] = rows.filter((r) => r > y).length;
        const keep = [];
        for (let y = 0; y < ROWS; y++) if (!rows.includes(y)) keep.push(S.grid[y]);
        const fresh = rows.map(() => new Array(COLS).fill(0));
        S.grid = fresh.concat(keep);
        const rs = new Array(ROWS).fill(0);
        for (let y = 0; y < ROWS; y++) if (!rows.includes(y)) rs[y + shifts[y]] = shifts[y];
        S.collapse = { t: 0, dur: 0.16, shifts: rs };
        // score
        const lvl = S.level;
        S.combo++;
        let pts = LINE_PTS[n] * lvl;
        const b2bNow = n === 4 && S.b2b;
        if (b2bNow) pts = Math.round(pts * 1.5);
        if (n === 4) { S.b2b = true; S.tetrises++; } else S.b2b = false;
        let comboPts = 0;
        if (S.combo > 0) comboPts = 50 * S.combo * lvl;
        const allClear = S.grid.every((row) => row.every((v) => !v));
        const acPts = allClear ? 1000 * lvl : 0;
        S.score += pts + comboPts + acPts;
        S.lines += n;
        // feedback
        const mid = WY + ((rows[0] + rows[n - 1]) / 2 - HID + 0.5) * C;
        pop(LINE_WORDS[n], n === 4 ? GOLD_T : INK_T, n === 4 ? 2 : 1, 62);
        pop("+" + (pts + comboPts + acPts), "#FFD27A", 1, 78);
        if (b2bNow) pop("ЦЕПОЧКА ЧЕТВЁРОК ×1,5", "#8EF0C6", 1, 90);
        if (S.combo > 0) pop("КОМБО ×" + S.combo, "#7FE6F4", 1, b2bNow ? 102 : 90);
        if (allClear) { pop("ЧИСТОЕ ПОЛЕ!", GOLD_T, 2, 118); api.flash("#FFF0C2", 0.35); }
        api.shake(n >= 4 ? 5 : n * 1.2, n >= 4 ? 0.4 : 0.2);
        api.flash(n >= 4 ? "#D8FFE9" : "#FFFFFF", n >= 4 ? 0.22 : 0.08);
        const notes = ["C5", "E5", "G5", "C6", "E6", "G6"];
        const upto = n === 4 ? 6 : n + 2;
        for (let i = 0; i < upto; i++) api.tone({ w: "p25", f: notes[i], t: i * 0.055, d: 0.12, v: 0.1 });
        if (n === 4) api.sfx("bonus");
        if (S.lines >= S.level * 10) levelUp();
        S.phase = "collapse";
        S.themeGlow = 1;
        return mid;
      }
      function levelUp() {
        S.level = 1 + Math.floor(S.lines / 10);
        S.prevTheme = S.theme; S.theme = (S.level - 1) % THEMES.length; S.themeBlend = 0;
        S.banner = { text: "УРОВЕНЬ " + S.level, t: 0 };
        api.sfx("powerup");
        api.flash(THEMES[S.theme].acc2, 0.18);
        fx.emit({ x: WX + WW / 2, y: WY + WH / 2, n: 40, colors: [THEMES[S.theme].acc, THEMES[S.theme].acc2, "#FFFFFF"], speed: [30, 130], life: [0.5, 1.2], drag: 2, shape: "star" });
      }
      function gameOver() {
        if (S.phase === "over") return;
        S.phase = "over"; S.overT = 0; S.overRow = ROWS; S.piece = null;
        api.sfx("die");
        api.shake(4, 0.35);
        api.flash("#FF6B7A", 0.2);
      }

      // ----- extra keys, read by the game itself (the engine maps only a few) -----
      const onKey = (e) => {
        if (WG.runner.state !== "play" || e.repeat) return;
        const c = e.code, kk = S.kEdge;
        if (c === "ArrowUp" || c === "KeyW") { S.cmds.push("cw"); kk.up = (kk.up || 0) + 1; }
        else if (c === "KeyX" || c === "KeyK") { S.cmds.push(c === "KeyX" ? "cw" : "hold"); kk.b = (kk.b || 0) + 1; }
        else if (c === "Enter" || c === "KeyJ" || c === "NumpadEnter") { S.cmds.push("cw"); kk.a = (kk.a || 0) + 1; }
        else if (c === "KeyZ") { S.cmds.push("ccw"); kk.a = (kk.a || 0) + 1; }
        else if (c === "Space") { S.cmds.push("drop"); kk.a = (kk.a || 0) + 1; }
        else if (c === "ShiftLeft" || c === "ShiftRight") { S.cmds.push("hold"); kk.b = (kk.b || 0) + 1; }
        else if (c === "KeyC") S.cmds.push("hold");
        else if (c === "KeyQ") S.cmds.push("ccw");
      };
      window.addEventListener("keydown", onKey);
      // a button the engine reports as pressed is the keyboard's when the keyboard's own handler saw it this step
      const fromKey = (b) => { if (S.kEdge[b] > 0) { S.kEdge[b]--; return true; } return false; };

      // ----- the hold box and the drop chip answer taps (touch) -----
      const HOLD_R = [20, 8, 108, 52];
      const inRect = (t, r) => t.x >= r[0] && t.x < r[0] + r[2] && t.y >= r[1] && t.y < r[1] + r[3];

      function playInput(dt) {
        const inp = api.input;
        // commands from the keyboard
        while (S.cmds.length) {
          const c = S.cmds.shift();
          if (!S.piece) continue;
          if (c === "cw") turn(1); else if (c === "ccw") turn(-1); else if (c === "hold") doHold(); else if (c === "drop") { hardDrop(); return; }
        }
        if (!S.piece) return;
        // buttons (touch, gamepad); keys already came through the commands
        if (inp.pressed("a") && !fromKey("a")) turn(1);
        if (inp.pressed("b") && !fromKey("b")) doHold();
        if (inp.pressed("up") && !fromKey("up")) { hardDrop(); return; }
        if (inp.tap) {
          if (inRect(inp.tap, HOLD_R)) doHold();
          else turn(1);
        }
        if (!S.piece) return;
        // sideways: once, then auto-repeat while held
        const dl = inp.held("left"), dr = inp.held("right");
        if (inp.pressed("left")) { S.dasDir = -1; S.das = 0.16; shift(-1); }
        else if (inp.pressed("right")) { S.dasDir = 1; S.das = 0.16; shift(1); }
        else if (S.dasDir === -1 && !dl) S.dasDir = dr ? 1 : 0;
        else if (S.dasDir === 1 && !dr) S.dasDir = dl ? -1 : 0;
        else if (S.dasDir) {
          S.das -= dt;
          while (S.das <= 0) { S.das += 0.045; if (!shift(S.dasDir)) break; }
        }
        // a swipe down or a pressed ↓ is one quick step
        if (inp.pressed("down") && !collides(S.piece.k, S.piece.r, S.piece.x, S.piece.y + 1)) {
          S.piece.y++; S.score += 1; S.gAcc = 0; S.lowY = Math.max(S.lowY, S.piece.y);
          api.tone({ w: "p12", f: 250, d: 0.015, v: 0.04 });
        }
      }
      function playStep(dt) {
        const p = S.piece;
        if (!p) return;
        const inp = api.input;
        const soft = inp.held("down");
        const g = gravity();
        const iv = soft ? Math.min(g, 0.035) : g;
        S.gAcc += dt;
        while (S.gAcc >= iv) {
          if (collides(p.k, p.r, p.x, p.y + 1)) { S.gAcc = 0; break; }
          S.gAcc -= iv; p.y++;
          if (soft) S.score += 1;
          if (p.y > S.lowY) { S.lowY = p.y; S.resets = 0; }
        }
        if (collides(p.k, p.r, p.x, p.y + 1)) {
          S.lockT += dt;
          if (S.lockT >= 0.5 || (soft && S.lockT >= 0.22)) lock(false);
        } else S.lockT = 0;
      }

      return {
        _state: S,
        _api: api,
        _test: { collides, spawn, lock, hardDrop, turn, shift, doHold, landY, finishClear, cells, gravity },
        start() { S.phase = "count"; S.countT = 0; api.sfx("start"); },
        pause() { S.cmds.length = 0; },
        resume() { S.cmds.length = 0; S.dasDir = 0; },
        destroy() { window.removeEventListener("keydown", onKey); },
        update(dt) {
          S.t += dt;
          if (S.phase !== "play") { S.kEdge = {}; S.cmds.length = 0; }
          fx.update(dt); amb.update(dt);
          for (const f of S.flashes) f.t += dt;
          S.flashes = S.flashes.filter((f) => f.t < 0.16);
          for (const tr of S.trails) tr.t += dt;
          S.trails = S.trails.filter((tr) => tr.t < 0.2);
          for (const p of S.pops) p.t += dt;
          S.pops = S.pops.filter((p) => p.t < p.life);
          if (S.banner) { S.banner.t += dt; if (S.banner.t > 1.6) S.banner = null; }
          if (S.themeBlend < 1) S.themeBlend = Math.min(1, S.themeBlend + dt * 1.2);
          S.cam += (S.camT - S.cam) * Math.min(1, dt * 3);
          S.ambT -= dt;
          if (S.ambT <= 0) { S.ambT = 0.22; amb.emit({ x: Math.random() * 384, y: -2, n: 1, colors: ["#FFFFFF", "#C9D6F2", "#8EF0C6"], speed: [5, 12], angle: [1.3, 1.8], life: [12, 20], size: 1 }); }
          for (const p of amb.list) p.vx += Math.sin(S.t * 0.8 + p.y * 0.05) * 0.15;

          if (S.phase === "count") {
            const before = S.countT;
            S.countT += dt;
            for (const m of [0.5, 1.0]) if (before < m && S.countT >= m) api.sfx("count");
            if (before < 1.5 && S.countT >= 1.5) { api.sfx("go"); S.phase = "play"; spawn(); }
            return;
          }
          if (S.phase === "play") {
            S.playMs += dt * 1000;
            if (S.entryT > 0) { S.entryT -= dt; if (S.entryT <= 0 && !S.piece) spawn(); return; }
            if (!S.piece) { spawn(); return; }
            playInput(dt);
            S.kEdge = {};
            if (S.piece) playStep(dt);
            return;
          }
          S.playMs += S.phase === "over" ? 0 : dt * 1000;
          if (S.phase === "clear") {
            S.clearT += dt;
            // the cells blow away from the middle outward
            const rank = Math.min(5, Math.floor(Math.max(0, S.clearT - 0.2) / 0.045) + (S.clearT >= 0.2 ? 1 : 0));
            while (S.clearRank < rank) {
              const r = S.clearRank++;
              for (const y of S.clearRows) {
                for (const x of [4 - r, 5 + r]) {
                  const col = S.grid[y][x]; if (!col) continue;
                  const T = TONES[ORDER[col - 1] || "X"];
                  fx.emit({ x: WX + x * C + 5, y: WY + (y - HID) * C + 5, n: 7, colors: [T.hi, T.lt, T.b, "#FFFFFF"], speed: [25, 100], life: [0.3, 0.7], gravity: 160, drag: 1.2, shape: "spark", spread: 6 });
                }
              }
              if (r % 2 === 0) api.tone({ w: "noise", d: 0.03, v: 0.06, hp: 3000 });
            }
            if (S.clearT >= 0.2 + 5 * 0.045 + 0.04) finishClear();
            return;
          }
          if (S.phase === "collapse") {
            S.collapse.t += dt;
            if (S.collapse.t >= S.collapse.dur) {
              S.collapse = null; S.phase = "play"; S.entryT = 0.05;
              api.tone({ w: "tri", f: 120, f2: 70, d: 0.07, v: 0.15 });
            }
            return;
          }
          if (S.phase === "over") {
            S.overT += dt;
            const want = Math.max(0, ROWS - Math.floor(S.overT / 0.04));
            while (S.overRow > want && S.overRow > HID) {
              S.overRow--;
              if (S.overRow < ROWS) {
                const y = S.overRow;
                for (let x = 0; x < COLS; x++) {
                  if (S.grid[y][x]) S.grid[y][x] = 8;
                  if (x % 3 === 0) fx.emit({ x: WX + x * C + 5, y: WY + (y - HID) * C + 5, n: 1, colors: ["#6B7694", "#9AA5C0", "#FFFFFF"], speed: [10, 40], life: [0.2, 0.5], drag: 3, shape: "dot" });
                }
              }
              if (S.overRow % 3 === 0) api.tone({ w: "p12", f: 100 + S.overRow * 28, d: 0.02, v: 0.06 });
            }
            if (!S.ended && S.overT > 0.04 * VIS + 0.9) {
              S.ended = true;
              api.end({ score: S.score, ms: Math.round(S.playMs), meta: { lines: S.lines, level: S.level, tetrises: S.tetrises } });
            }
          }
        },
        draw(g, alpha) {
          const T = S.themeBlend < 1 ? THEMES[S.prevTheme] : THEMES[S.theme];
          const TH = THEMES[S.theme];
          drawBackdrop(g);
          // the frame and the well
          g.drawImage(WELL, WX, WY);
          drawBoard(g);
          g.drawImage(FRAME, 0, 0);
          // glowing inner lip in the level's colour
          g.fillStyle = TH.acc; g.fillRect(WX - 1, WY - 1, WW + 2, 1); g.fillRect(WX - 1, WY - 1, 1, WH + 2);
          g.fillStyle = mix(TH.acc, "#04070F", 0.55); g.fillRect(WX + WW, WY - 1, 1, WH + 2); g.fillRect(WX - 1, WY + WH, WW + 2, 1);
          if (S.piece) drawActive(g);
          drawTrails(g);
          fx.draw(g);
          drawHud(g, TH);
          drawPops(g);
          if (S.phase === "count") drawCount(g);
          if (S.phase === "idle") { /* the start card is on top */ }
          if (S.phase === "over" && S.overT > 0.04 * VIS + 0.1) WG.text(g, "КОНЕЦ ИГРЫ", WX + WW / 2, WY + 90, { scale: 2, align: "center", color: ["#FFC2C9", "#FFC2C9", "#FF6B7A", "#FF6B7A", "#D93644", "#D93644", "#8E1F35"], outline: "#1B0A10" });
          void T; void alpha;
        },
      };

      // ----- drawing -----
      function drawBackdrop(g) {
        const th = THEMES[S.theme], sc = scene(S.theme);
        const blend = S.themeBlend;
        art.sky(g, 0, 0, 384, SKY_H, S.t, Object.assign({}, th.sky, { amount: 1 }));
        if (blend < 1) { g.globalAlpha = 1 - blend; art.sky(g, 0, 0, 384, SKY_H, S.t, Object.assign({}, THEMES[S.prevTheme].sky, { amount: 1 })); g.globalAlpha = 1; }
        const sway = Math.sin(S.t * 0.15) * 0.5 + S.cam * 0.9;
        art.moon(g, 372 - Math.round(sway * 2), 20, 6);
        g.fillStyle = th.far; g.fillRect(0, SKY_H - 2, 384, 90);
        const layer = (img, y, k) => g.drawImage(img, Math.round(-32 - sway * k), y);
        layer(sc.far, 58, 3);
        g.fillStyle = th.mid; g.fillRect(0, 168, 384, 48);
        layer(sc.mid, 96, 7);
        // the frozen lake with the aurora's shimmer
        g.drawImage(sc.lake, 0, 184);
        for (let i = 0; i < 9; i++) {
          const y = 187 + i * 3 + (i * i) % 2;
          const w = 14 + ((i * 37) % 30) + Math.round(Math.sin(S.t * 1.3 + i) * 6), x = Math.round(((i * 71 + 40) % 340) + Math.sin(S.t * 0.7 + i * 2) * 8);
          g.fillStyle = i % 2 ? th.acc : th.acc2; g.globalAlpha = 0.16 + 0.12 * Math.sin(S.t * 2 + i);
          g.fillRect(x, y, w, 1);
          g.globalAlpha = 1;
        }
        layer(sc.near, 168, 12);
        amb.draw(g);
      }
      function cellXY(x, y, off) { return [WX + x * C, WY + (y - HID) * C + (off || 0)]; }
      function drawBoard(g) {
        const clearing = S.phase === "clear";
        for (let y = HID; y < ROWS; y++) {
          const row = S.grid[y];
          const isClear = clearing && S.clearRows.includes(y);
          let off = 0;
          if (S.phase === "collapse" && S.collapse) off = -S.collapse.shifts[y] * C * (1 - ease(Math.min(1, S.collapse.t / S.collapse.dur)));
          for (let x = 0; x < COLS; x++) {
            const v = row[x]; if (!v) continue;
            const [px, py] = cellXY(x, y, Math.round(off));
            if (isClear) {
              const rank = Math.min(4 - x, x - 5) < 0 ? Math.min(Math.abs(x - 4), Math.abs(x - 5)) : 0;
              const r = x <= 4 ? 4 - x : x - 5;
              if (S.clearT >= 0.2 + r * 0.045) continue; // gone, already burst
              const flashOn = S.clearT < 0.2 && Math.floor(S.clearT * 30) % 2 === 0;
              if (flashOn) { g.fillStyle = "#FFFFFF"; g.fillRect(px, py, C, C); }
              else g.drawImage(tile(ORDER[v - 1] || "X", C), px, py);
              void rank;
              continue;
            }
            g.drawImage(tile(ORDER[v - 1] || "X", C), px, py);
          }
        }
        // a white sweep across the cleared rows
        if (clearing && S.clearT < 0.45) {
          for (const y of S.clearRows) {
            const k = cl((S.clearT - 0.12) / 0.2, 0, 1);
            if (k > 0 && k < 1) {
              const w = Math.round(WW * k), cx = WX + WW / 2, py = WY + (y - HID) * C;
              g.fillStyle = "rgba(255,255,255,.7)"; g.fillRect(cx - w / 2, py + 4, w, 2);
            }
          }
        }
        // the lock flash on settled cells
        for (const f of S.flashes) {
          if (f.y < HID) continue;
          const [px, py] = cellXY(f.x, f.y);
          g.fillStyle = "rgba(255,255,255," + (0.6 * (1 - f.t / 0.16)).toFixed(2) + ")"; g.fillRect(px, py, C, C);
        }
      }
      function drawActive(g) {
        const p = S.piece, gy = landY(p);
        const showGhost = gy > p.y || true;
        if (showGhost) for (const [cx, cy] of cells(p)) {
          const y = gy + cy; if (y < HID) continue;
          const [px, py] = cellXY(p.x + cx, y);
          g.drawImage(ghostTile(p.k), px, py);
        }
        // the piece about to lock pulses
        const pulse = grounded() ? 0.25 * Math.abs(Math.sin(S.lockT * 18)) * (S.lockT / 0.5 + 0.3) : 0;
        for (const [cx, cy] of cells(p)) {
          const y = p.y + cy; if (y < 1) continue;
          const [px, py] = cellXY(p.x + cx, y);
          if (y < HID) g.globalAlpha = 0.55;
          g.drawImage(tile(p.k, C), px, py);
          if (pulse > 0 && y >= HID) { g.fillStyle = "rgba(255,255,255," + pulse.toFixed(2) + ")"; g.fillRect(px, py, C, C); }
          g.globalAlpha = 1;
        }
      }
      function drawTrails(g) {
        for (const tr of S.trails) {
          const a = 1 - tr.t / 0.2, T = TONES[tr.k], cols = {};
          for (const [x, y] of tr.cs) cols[x] = Math.min(cols[x] === undefined ? 99 : cols[x], y);
          for (const x of Object.keys(cols)) {
            const y0 = WY + (cols[x] - HID) * C, h = tr.d * C;
            for (let j = 0; j < h; j += 2) {
              const f = j / h; // brighter near the piece, gone toward where it started
              g.fillStyle = f > 0.5 ? T.hi : T.lt; g.globalAlpha = a * (0.1 + 0.45 * f);
              g.fillRect(WX + x * C + 4, Math.max(WY, y0 + j), 2, 2);
            }
            g.globalAlpha = 1;
          }
        }
      }
      function drawMini(g, k, cx, cy, size, alpha) {
        const cs = SHAPE0[k];
        let x0 = 9, x1 = -1, y0 = 9, y1 = -1;
        for (const [x, y] of cs) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        const w = (x1 - x0 + 1) * size, h = (y1 - y0 + 1) * size;
        const t = tile(k, size);
        g.globalAlpha = alpha === undefined ? 1 : alpha;
        for (const [x, y] of cs) g.drawImage(t, Math.round(cx - w / 2 + (x - x0) * size), Math.round(cy - h / 2 + (y - y0) * size));
        g.globalAlpha = 1;
      }
      function drawHud(g, th) {
        // left: hold and the numbers
        panel(g, 20, 8, 108, 52, "ЗАПАС", th.acc);
        if (S.hold) drawMini(g, S.hold, 74, 40, 8, S.holdUsed ? 0.35 : 1);
        else WG.text(g, "ПУСТО", 74, 36, { align: "center", color: "#3B4766" });
        panel(g, 20, 66, 108, 86, null, th.acc);
        const best = api.best;
        WG.text(g, "ОЧКИ", 28, 73, { color: "#A9B6CD" });
        WG.text(g, num(S.score), 120, 83, { scale: 2, align: "right", color: INK_T, shadow: "#04070F" });
        WG.text(g, "УРОВЕНЬ", 28, 103, { color: "#A9B6CD" });
        WG.text(g, S.level, 120, 103, { align: "right", color: GOLD_T, shadow: "#04070F" });
        WG.text(g, "РЯДЫ", 28, 117, { color: "#A9B6CD" });
        WG.text(g, S.lines, 120, 117, { align: "right", color: INK_T, shadow: "#04070F" });
        const rec = best !== null && best !== undefined;
        if (rec && S.score > best) WG.text(g, "НОВЫЙ РЕКОРД!", 74, 135, { align: "center", color: Math.floor(S.t * 4) % 2 ? "#FFD27A" : "#FFF0C2" });
        else if (rec) { WG.text(g, "РЕКОРД", 28, 135, { color: "#A9B6CD" }); WG.text(g, num(best), 120, 135, { align: "right", color: "#8EF0C6" }); }
        else WG.text(g, "ПЕРВАЯ ИГРА", 74, 135, { align: "center", color: "#5F6F93" });
        // right: next three, progress to the next level, combo
        panel(g, 256, 8, 108, 100, "ДАЛЬШЕ", th.acc);
        drawMini(g, S.queue[0], 310, 38, 8);
        g.fillStyle = "#26324F"; g.fillRect(268, 56, 84, 1);
        drawMini(g, S.queue[1], 310, 70, 6, 0.9);
        drawMini(g, S.queue[2], 310, 91, 6, 0.75);
        panel(g, 256, 112, 108, 38, null, th.acc);
        const into = S.lines % 10;
        WG.text(g, "ДО УРОВНЯ " + (S.level + 1), 310, 118, { align: "center", color: "#A9B6CD" });
        g.fillStyle = "#04070F"; g.fillRect(264, 130, 92, 8);
        g.fillStyle = "#1D2944"; g.fillRect(265, 131, 90, 6);
        const fill = Math.round(90 * into / 10);
        if (fill > 0) { g.fillStyle = th.acc; g.fillRect(265, 131, fill, 6); g.fillStyle = "rgba(255,255,255,.5)"; g.fillRect(265, 131, fill, 1); }
        for (let i = 1; i < 10; i++) { g.fillStyle = "#04070F"; g.fillRect(265 + i * 9, 131, 1, 6); }
        WG.text(g, S.combo > 0 ? "КОМБО ×" + S.combo : S.b2b ? "ЦЕПОЧКА ×1,5" : "", 310, 141, { align: "center", color: S.combo > 0 ? "#7FE6F4" : "#8EF0C6" });
        if (coarse && false) void 0;
      }
      function drawPops(g) {
        for (const p of S.pops) {
          const k = p.t / p.life;
          const up = Math.round(ease(Math.min(1, k * 2)) * 8);
          const blink = k > 0.8 && Math.floor(p.t * 20) % 2;
          if (blink) continue;
          const sc = p.scale;
          WG.text(g, p.text, WX + WW / 2, WY + p.y - up, { scale: sc, align: "center", color: p.color, outline: "#04070F" });
        }
        if (S.banner) {
          const b = S.banner, k = b.t / 1.6;
          const slide = Math.round((1 - ease(Math.min(1, b.t * 4))) * 30);
          if (k < 0.85 || Math.floor(b.t * 16) % 2) {
            const y = WY + 30 - slide;
            g.fillStyle = "rgba(4,7,15,.55)"; g.fillRect(WX, y - 5, WW, 24);
            g.fillStyle = THEMES[S.theme].acc; g.fillRect(WX, y - 5, WW, 1); g.fillRect(WX, y + 18, WW, 1);
            WG.text(g, b.text, WX + WW / 2, y, { scale: 2, align: "center", color: GOLD_T, outline: "#2A1E00" });
          }
        }
      }
      function drawCount(g) {
        const c = S.countT;
        const label = c < 0.5 ? "3" : c < 1.0 ? "2" : c < 1.5 ? "1" : "ВПЕРЁД!";
        const k = (c % 0.5) / 0.5;
        const y = WY + 80 - Math.round((1 - ease(Math.min(1, k * 2))) * 6);
        WG.text(g, label, WX + WW / 2, y, { scale: label.length > 1 ? 2 : 5, align: "center", color: GOLD_T, outline: "#2A1E00" });
      }
    },
  });
})();
