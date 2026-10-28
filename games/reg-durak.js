/* Дурак — the registry entry of «durak», its cover, and the card art that the game itself (durak.js) also uses:
   WG.durakArt.face(card), .back(), .mini(), .trump(card), .suit(s, size). Cards are 31×43, drawn by code: cream
   paper, 16-bit pips, court cards as small double-ended portraits, a night-blue back with the winged W shield. */
"use strict";
(function () {
  const { art } = WG;
  const CW = 31, CH = 43;
  // suits: 0 пики ♠, 1 трефы ♣, 2 бубны ♦, 3 червы ♥; ranks 6…14 (6–10, В, Д, К, Т); card id = suit * 9 + rank - 6
  const PAPER = { out: "#14182A", paper: "#F3ECD8", light: "#FFFDF4", shade: "#D9CCAC", shade2: "#B7A784" };
  const RED = { m: "#D93644", d: "#8E1F35", h: "#FF8F8F" };
  const BLK = { m: "#252C4D", d: "#0E1226", h: "#6B7694" };
  const SUITCOL = (s) => (s >= 2 ? RED : BLK);
  // the court cards' clothes by suit: violet spades, green clubs, amber diamonds, red hearts
  const ROBE = [
    { c: "#5B49C4", C: "#2C2275", l: "#9D8FFA", g: "#7FE6F4", h: "#2A2F4F", H: "#151A30", bg: "#E6E3F7" },
    { c: "#1F9A6C", C: "#0B4A33", l: "#7EE3B8", g: "#FFD27A", h: "#6A4428", H: "#3E2716", bg: "#DFF1E6" },
    { c: "#E0832E", C: "#8A3F12", l: "#FFC07A", g: "#7FE6F4", h: "#E0B04A", H: "#9A6A1C", bg: "#F8EBD6" },
    { c: "#D93644", C: "#7E1A2E", l: "#FF8F8F", g: "#8EF0C6", h: "#A3462A", H: "#5E2414", bg: "#F8E1E1" },
  ];

  // ---------- suits: hand-set at 5 px, drawn from shapes at larger sizes ----------
  const SMALL = {
    0: ["..#..", ".###.", "#####", "#####", "..#..", ".###."],
    1: [".###.", ".###.", "#####", "#####", "#.#.#", "..#.."],
    2: ["..#..", ".###.", "#####", "#####", ".###.", "..#.."],
    3: [".#.#.", "#####", "#####", "#####", ".###.", "..#.."],
  };
  function inSuit(s, n, x, y) {
    // x, y: pixel centres in 0…n; the shapes fill an n×n box
    const c = n / 2;
    const disc = (cx, cy, r) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
    if (s === 2) return Math.abs(x - c) / (n * 0.44) + Math.abs(y - c) / (n * 0.53) <= 1;
    if (s === 3) {
      const r = n * 0.27;
      if (disc(c - n * 0.22, n * 0.3, r) || disc(c + n * 0.22, n * 0.3, r)) return true;
      if (y >= n * 0.3 && y <= n * 0.98) { const hw = (n * 0.49) * (1 - (y - n * 0.3) / (n * 0.68)); return Math.abs(x - c) <= hw; }
      return false;
    }
    if (s === 0) {
      // an upturned heart over a flared stem
      const yy = (n * 0.8 - y) / 0.8;
      if (yy >= 0 && inSuit(3, n, x, yy)) return true;
      if (y > n * 0.62) { const hw = 0.6 + (y - n * 0.62) / (n * 0.38) * n * 0.21; return Math.abs(x - c) <= hw; }
      return false;
    }
    // clubs: three round leaves and a flared stem
    const r = n * 0.215;
    if (disc(c, n * 0.24, r) || disc(c - n * 0.25, n * 0.56, r) || disc(c + n * 0.25, n * 0.56, r) || disc(c, n * 0.5, n * 0.13)) return true;
    if (y > n * 0.6) { const hw = 0.6 + (y - n * 0.6) / (n * 0.4) * n * 0.2; return Math.abs(x - c) <= hw; }
    return false;
  }
  const suitCache = {};
  function suit(s, n, o) {
    o = o || {};
    const key = s + "/" + n + "/" + (o.col || "") + (o.flip ? "f" : "") + (o.ring || "");
    if (suitCache[key]) return suitCache[key];
    const P = o.col || SUITCOL(s);
    let mask;
    if (n <= 5) mask = SMALL[s].map((r) => [...r].map((ch) => ch === "#"));
    else {
      mask = [];
      for (let y = 0; y < n; y++) { const row = []; for (let x = 0; x < n; x++) row.push(inSuit(s, n, x + 0.5, y + 0.5)); mask.push(row); }
    }
    const h = mask.length, w = mask[0].length, pad = o.ring ? 1 : 0;
    const c = WG.canvas(w + pad * 2, h + pad * 2), g = c.getContext("2d");
    const M = (x, y) => y >= 0 && y < h && x >= 0 && x < w && mask[y][x];
    if (o.ring) {
      g.fillStyle = o.ring;
      for (let y = -1; y <= h; y++) for (let x = -1; x <= w; x++) if (!M(x, y) && (M(x - 1, y) || M(x + 1, y) || M(x, y - 1) || M(x, y + 1))) g.fillRect(x + pad, y + pad, 1, 1);
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!M(x, y)) continue;
      let col = P.m;
      if (n > 5) {
        if (!M(x + 1, y) || !M(x, y + 1) || !M(x + 1, y + 1)) col = P.d;
        else if (!M(x - 1, y - 1) || !M(x - 1, y) || !M(x, y - 1)) col = P.h;
      } else if (y === h - 1 || !M(x + 1, y)) col = P.d;
      g.fillStyle = col; g.fillRect(x + pad, y + pad, 1, 1);
    }
    if (n >= 9) { // a shine on the upper left
      const sx = Math.round(n * (s === 3 ? 0.22 : 0.36)), sy = Math.round(n * (s === 3 ? 0.22 : s === 2 ? 0.3 : 0.2));
      g.fillStyle = "#FFFFFF"; if (M(sx, sy)) g.fillRect(sx + pad, sy + pad, 1, 1); if (M(sx, sy + 1)) g.fillRect(sx + pad, sy + 1 + pad, 1, 1);
    }
    const out = o.flip ? WG.flipY(c) : c;
    suitCache[key] = out;
    return out;
  }

  // ---------- rank lettering, 3×5 (10 and Д a little wider) ----------
  const RANK = {
    6: ["###", "#..", "###", "#.#", "###"], 7: ["###", "..#", "..#", ".#.", ".#."], 8: ["###", "#.#", "###", "#.#", "###"],
    9: ["###", "#.#", "###", "..#", "###"], 10: ["#.###", "#.#.#", "#.#.#", "#.#.#", "#.###"],
    11: ["##.", "#.#", "##.", "#.#", "##."], 12: [".##.", ".#.#", ".#.#", "####", "#..#"],
    13: ["#.#", "#.#", "##.", "#.#", "#.#"], 14: ["###", ".#.", ".#.", ".#.", ".#."],
  };
  const RANK_NAME = { 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "В", 12: "Д", 13: "К", 14: "Т" };
  function rankImg(r, col) {
    return WG.sprite(RANK[r], { "#": col });
  }

  // ---------- court portraits: the upper half, 15×16; the card shows it twice, turned about the middle ----------
  const COURT = {
    11: [ // В — a young squire in a feathered beret
      ".........ff....",
      "....cccc.fF....",
      "..cccccccccf...",
      ".cllcccccccCC..",
      "..ttTttTttTtt..",
      "..hhssssssshh..",
      "..hssesssesSh..",
      "..hssssSsssSh..",
      "..hsssmmsssSh..",
      "...hsssssssh...",
      "....SSsssSS....",
      "..cwwwSSSwwwc..",
      ".cclwwwtwwwlcC.",
      "ccllllctclllcCC",
      "cclllcctcclccCC",
      "cclllccgcclccCC",
    ],
    12: [ // Д — a lady with a tiara and long braids
      "......tgt......",
      "...hhtttttHh...",
      "..hhhhhhhhhHH..",
      ".hhhsssssssHHh.",
      ".hhssssssssShh.",
      ".hhssesssesShh.",
      ".hhssssSsssShh.",
      ".hhsssmmmssShh.",
      ".hhhhsssssShhh.",
      ".hhhhcSSScchhh.",
      "hhhlcwtgtwccHhh",
      "hhllccwwwccCCHh",
      "hcllltcccclCCCh",
      "hclllcccctcCCCH",
      ".clllctcccclCC.",
      "ccllllcgcccCCCC",
    ],
    13: [ // К — a bearded king in a crown
      "...t...t...t...",
      "...tt.tgt.tt...",
      "...ttttttttt...",
      "...TgTTgTTgT...",
      "..hssssssssSh..",
      "..hssesssesSh..",
      "..hssssSsssSh..",
      "..hHHHmmmHHHh..",
      "...hhhhhhhhh...",
      "..chhhhHhhhhc..",
      ".cclhhhhhhhlcc.",
      "cclltthhhttlcCC",
      "cclllttHtttlcCC",
      "ccllwtgtwlcccCC",
      "ccllcwwwwwcccCC",
      "cclllcccccllcCC",
    ],
  };
  const SKIN = { s: "#F6CBA8", S: "#D69A7A", e: "#1B2133", m: "#C0394F", w: "#FFFDF4", t: "#FFD27A", T: "#C98A1B", f: "#FFFFFF", F: "#C4BBFF" };
  function courtHalf(rank, s) {
    const R = ROBE[s];
    const pal = Object.assign({}, SKIN, { c: R.c, C: R.C, l: R.l, g: R.g, h: R.h, H: R.H });
    if (rank === 13) Object.assign(pal, { h: ["#EAF0FA", "#3B2A1C", "#F0D29A", "#C9D6F2"][s], H: ["#A9B6CD", "#24170F", "#C98A1B", "#8F9BB8"][s] });
    return WG.sprite(COURT[rank], pal);
  }

  // ---------- the winged shield with W ----------
  const EMBLEM = [
    "c.........ooooo.........c",
    "cc.......oLLLLLo.......cc",
    ".ccc....oLdgggdLo....ccc.",
    "..cccc..ogdgggdGo..cccc..",
    "..wcccc.ogdgdgdGo.ccccw..",
    "...wwccoogdgdgdGoocwww...",
    "....wwcc.oggdgdGo.ccww...",
    ".....ww..ogdggdGo..ww....",
    "..........ogggGo.........",
    "...........ogGo..........",
    "............oo...........",
  ];
  const emblemImg = () => WG.sprite(EMBLEM, { o: "#05291C", L: "#8EF0C6", g: "#34D399", G: "#1FA874", d: "#05291C", c: "#7FE6F4", w: "#D2FAFF" }, { outline: "#0A0F1E" });

  // ---------- the cards ----------
  function blank(g, w, h, fill, light, shade, out) {
    // rounded corners: the outline is cut at each corner
    g.fillStyle = out;
    g.fillRect(2, 0, w - 4, h); g.fillRect(0, 2, w, h - 4); g.fillRect(1, 1, w - 2, h - 2);
    g.fillStyle = fill;
    g.fillRect(2, 1, w - 4, h - 2); g.fillRect(1, 2, w - 2, h - 4);
    g.fillStyle = light; g.fillRect(2, 1, w - 4, 1); g.fillRect(1, 2, 1, h - 4);
    g.fillStyle = shade; g.fillRect(2, h - 2, w - 4, 1); g.fillRect(w - 2, 2, 1, h - 4);
  }
  const faces = {};
  function face(id) {
    if (faces[id]) return faces[id];
    const s = Math.floor(id / 9), r = (id % 9) + 6, P = SUITCOL(s);
    const c = WG.canvas(CW, CH), g = c.getContext("2d");
    blank(g, CW, CH, PAPER.paper, PAPER.light, PAPER.shade, PAPER.out);
    // the corner index: rank over a small pip, and the same turned at the lower right
    const ri = rankImg(r, P.m), pip = suit(s, 5), pipF = suit(s, 5, { flip: true });
    const rx = 2 + Math.floor((5 - ri.width) / 2) + (r === 10 ? 0 : 0);
    g.drawImage(ri, rx, 3); g.drawImage(pip, 2, 9);
    const riF = WG.rotate(ri, 2);
    g.drawImage(riF, CW - 2 - 5 + Math.ceil((5 - ri.width) / 2), CH - 3 - 5); g.drawImage(pipF, CW - 7, CH - 9 - pipF.height);
    if (r <= 10) {
      const L = 8, M = 13, Rr = 18, mid = 19;
      const rows4 = [4, 14, 24, 34], rows3 = [4, 19, 34];
      const at = [];
      if (r <= 8) for (const y of rows3) at.push([L, y], [Rr, y]);
      else for (const y of rows4) at.push([L, y], [Rr, y]);
      if (r === 7) at.push([M, 11]);
      if (r === 8) at.push([M, 11], [M, 27]);
      if (r === 9) at.push([M, mid]);
      if (r === 10) at.push([M, 9], [M, 29]);
      const big = suit(s, 5), bigF = suit(s, 5, { flip: true });
      for (const [x, y] of at) g.drawImage(y > mid ? bigF : big, x, y);
    } else if (r === 14) {
      // the ace: a large pip in a ring of northern lights
      const ring = ["#8B7CF6", "#22B8CF", "#34D399", "#7FE6F4"];
      for (let i = 0; i < 28; i++) {
        const a = (i / 28) * Math.PI * 2, rr = 11;
        g.fillStyle = ring[i % 4];
        g.fillRect(Math.round(15 + Math.cos(a) * rr * 0.8), Math.round(21 + Math.sin(a) * rr), 1, 1);
      }
      for (const [x, y] of [[15, 7], [15, 35], [6, 21], [24, 21]]) { g.fillStyle = "#C98A1B"; g.fillRect(x, y - 1, 1, 3); g.fillRect(x - 1, y, 3, 1); g.fillStyle = "#FFD27A"; g.fillRect(x, y, 1, 1); }
      const big = suit(s, s === 3 || s === 2 ? 13 : 13, { ring: s === 0 ? "#FFD27A" : null });
      g.drawImage(big, Math.round(15.5 - big.width / 2), Math.round(21.5 - big.height / 2));
    } else {
      // a court card: a framed portrait, double-ended
      const R = ROBE[s];
      g.fillStyle = P.m; g.fillRect(7, 4, 17, 35);
      g.fillStyle = R.bg; g.fillRect(8, 5, 15, 33);
      const half = courtHalf(r, s);
      g.drawImage(half, 8, 5);
      g.drawImage(WG.rotate(half, 2), 8, 22);
      g.fillStyle = P.m; g.fillRect(8, 21, 15, 1);
      g.fillStyle = "#FFD27A"; g.fillRect(7, 21, 1, 1); g.fillRect(23, 21, 1, 1);
    }
    faces[id] = c;
    return c;
  }
  let BACK = null, MINI = null;
  function back() {
    if (BACK) return BACK;
    const c = WG.canvas(CW, CH), g = c.getContext("2d");
    blank(g, CW, CH, "#17213A", "#3B4766", "#0E1730", "#04070F");
    // a fine lattice and a double frame
    g.fillStyle = "#1D2944";
    for (let y = 3; y < CH - 3; y++) for (let x = 3; x < CW - 3; x++) if ((x + y) % 4 === 0 || (x - y + 400) % 4 === 0) g.fillRect(x, y, 1, 1);
    g.fillStyle = "#22B8CF"; g.fillRect(3, 3, CW - 6, 1); g.fillRect(3, CH - 4, CW - 6, 1); g.fillRect(3, 3, 1, CH - 6); g.fillRect(CW - 4, 3, 1, CH - 6);
    g.fillStyle = "#0B6E8A"; g.fillRect(5, 5, CW - 10, 1); g.fillRect(5, CH - 6, CW - 10, 1); g.fillRect(5, 5, 1, CH - 10); g.fillRect(CW - 6, 5, 1, CH - 10);
    // an aurora band behind the emblem
    const band = ["#4B3BA8", "#21194A", "#0B4A33", "#127A52", "#0B4A33", "#21194A"];
    for (let y = 15; y < 28; y++) { g.fillStyle = band[(y - 15) % band.length]; for (let x = 6; x < CW - 6; x++) if ((x + y) % 2 === 0) g.fillRect(x, y, 1, 1); }
    const em = emblemImg();
    g.drawImage(em, Math.round((CW - em.width) / 2), 14);
    for (const [x, y] of [[8, 9], [22, 9], [8, 33], [22, 33], [15, 9], [15, 33]]) { g.fillStyle = "#7FE6F4"; g.fillRect(x, y, 1, 1); g.fillStyle = "#3B4766"; g.fillRect(x - 1, y, 1, 1); g.fillRect(x + 1, y, 1, 1); g.fillRect(x, y - 1, 1, 1); g.fillRect(x, y + 1, 1, 1); }
    BACK = c;
    return c;
  }
  // the opponent's cards across the table look smaller: a 19×27 back drawn on its own pixels
  function mini() {
    if (MINI) return MINI;
    const w = 19, h = 27, c = WG.canvas(w, h), g = c.getContext("2d");
    blank(g, w, h, "#17213A", "#3B4766", "#0E1730", "#04070F");
    g.fillStyle = "#1D2944";
    for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) if ((x + y) % 4 === 0) g.fillRect(x, y, 1, 1);
    g.fillStyle = "#22B8CF"; g.fillRect(2, 2, w - 4, 1); g.fillRect(2, h - 3, w - 4, 1); g.fillRect(2, 2, 1, h - 4); g.fillRect(w - 3, 2, 1, h - 4);
    const sh = WG.sprite(["cc.ooooo.cc", ".ccoLLLocc.", "..wogdgow..", "...ogdgo...", "....ogo....", ".....o....."], { o: "#05291C", L: "#8EF0C6", g: "#34D399", d: "#05291C", c: "#7FE6F4", w: "#D2FAFF" });
    g.fillStyle = "#4B3BA8"; for (let x = 3; x < w - 3; x += 2) g.fillRect(x, 11, 1, 1);
    g.drawImage(sh, 4, 10);
    MINI = c;
    return c;
  }
  // the trump card lies across under the deck
  const trumps = {};
  function trump(id) { return trumps[id] || (trumps[id] = WG.rotate(face(id), 1)); }
  WG.durakArt = { CW, CH, face, back, mini, trump, suit, emblem: emblemImg, RANK_NAME, SUITCOL, ROBE };

  // ---------- the cover: a felt table under the lamp, a hand fanned out ----------
  function cover(g, w, h) {
    // the room
    art.bands(g, 0, 0, w, 22, ["#0A0F1E", "#121B31", "#17213A"]);
    for (let x = 4; x < w; x += 8) { g.fillStyle = "#1D2944"; g.fillRect(x, 2, 1, 18); }
    // a window on the aurora
    art.sky(g, 6, 2, 30, 16, 0, { still: true, seed: 12, top: "#04070F", bottom: "#142449", curtain: 0.75 });
    art.pines(g, 6, 18, 30, "#0A1530", 4, 3, 7, 4);
    g.fillStyle = "#4E3424"; g.fillRect(5, 1, 32, 1); g.fillRect(5, 18, 32, 2); g.fillRect(5, 1, 1, 18); g.fillRect(36, 1, 1, 18); g.fillRect(20, 2, 1, 16);
    g.fillStyle = "#7A5236"; g.fillRect(5, 18, 32, 1);
    // the table: a wooden rim, then felt lit from above
    g.fillStyle = "#24170F"; g.fillRect(0, 20, w, 5);
    g.fillStyle = "#7A5236"; g.fillRect(0, 21, w, 2); g.fillStyle = "#A8774D"; g.fillRect(0, 21, w, 1);
    art.bands(g, 0, 25, w, h - 25, ["#0E3A33", "#145046", "#165A4E", "#145046", "#0E3A33"]);
    const rnd = WG.rng(31);
    for (let k = 0; k < 140; k++) { g.fillStyle = rnd() > 0.5 ? "#1A6355" : "#0B3029"; g.fillRect(Math.floor(rnd() * w), 25 + Math.floor(rnd() * (h - 25)), 1, 1); }
    art.dither(g, 30, 30, 68, 34, null, "rgba(255,240,194,.10)", 0.5);
    // the lamp's shade at the top
    g.fillStyle = "#04070F"; g.fillRect(63, 0, 2, 3);
    g.fillStyle = "#0B4A33"; g.fillRect(52, 3, 24, 4); g.fillStyle = "#1FA874"; g.fillRect(54, 3, 20, 1);
    g.fillStyle = "#FFF0C2"; g.fillRect(53, 7, 22, 1); g.fillStyle = "#FFD27A"; g.fillRect(56, 8, 16, 1);
    g.fillStyle = "rgba(255,210,122,.07)"; g.beginPath(); g.moveTo(53, 8); g.lineTo(75, 8); g.lineTo(96, 20); g.lineTo(32, 20); g.closePath(); g.fill();
    // the deck with the trump across under it; two attacks on the felt, each beaten — the second by a trump
    const shadow = (x, y, w, hh) => { g.fillStyle = "rgba(4,10,9,.42)"; g.fillRect(x + 2, y + 3, w, hh - 1); };
    shadow(2, 40, CH, CW); g.drawImage(trump(3 * 9 + 8), 1, 40);
    shadow(11, 27, CW, CH);
    for (let i = 0; i < 4; i++) g.drawImage(back(), 13 - i, 28 - i);
    const pairs = [[44, 26, 1 * 9 + 3, 1 * 9 + 6], [84, 26, 2 * 9 + 7, 3 * 9 + 2]];
    for (const [x, y, a1, d1] of pairs) {
      shadow(x, y, CW, CH); g.drawImage(face(a1), x, y);
      shadow(x + 7, y + 9, CW, CH); g.drawImage(face(d1), x + 7, y + 9);
    }
    // a spark where the trump landed
    for (const [x, y, c] of [[116, 33, "#FFF0C2"], [121, 44, "#7FE6F4"], [82, 30, "#FFD27A"], [40, 24, "#FFF0C2"]]) {
      g.fillStyle = c; g.fillRect(x, y, 1, 1); g.fillStyle = "rgba(255,240,194,.55)"; g.fillRect(x - 1, y, 1, 1); g.fillRect(x + 1, y, 1, 1); g.fillRect(x, y - 1, 1, 1); g.fillRect(x, y + 1, 1, 1);
    }
  }

  WG.registry.push({
    id: "durak", title: "Дурак", genre: "cards", levels: WG.VS_CPU, file: "durak.js", cover,
    stages: 10, stageWord: "Соперник", stagesWord: "соперники", endless: "Свободная игра",
    blurb: "Подкидной дурак на 36 карт против компьютера: лига из десяти соперников, серии до двух побед — и свободная игра на рекорд побед подряд.",
  });
})();
