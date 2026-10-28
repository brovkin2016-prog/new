/* Змейка — a garden at night under the aurora: collect apples, don't hit the stone wall or yourself.
   The snake moves cell by cell but is drawn as a smooth tube between the cells; it speeds up as it grows.
   Written against the Winger Games engine (engine.js, ENGINE.md). */
"use strict";
(function () {
  const { art, PAL } = WG;
  const CELL = 12, COLS = 30, ROWS = 13, OX = 12, OY = 50;
  const FX0 = OX, FY0 = OY, FX1 = OX + COLS * CELL, FY1 = OY + ROWS * CELL; // the field: 12…372 × 50…206
  const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const OPP = { up: "down", down: "up", left: "right", right: "left" };
  const SNAKE = { out: "#04231A", shade: "#13865B", fill: "#3BDB9E", light: "#C8FBE3", spot: "#1A9C6B", spot2: "#7FE6F4" };

  // ---------- sprites ----------
  const appleRows = [
    "....sGg...",
    "....sggG..",
    ".....s....",
    "..lr.rrr..",
    ".lhlrrrrrr",
    "lhhlrrrrrd",
    "lhlrrrrrrd",
    "llrrrrrrdd",
    "lrrrrrrrdd",
    ".rrrrrrdd.",
    ".rrrrrddd.",
    "..dd.dd...",
  ];
  const APPLE = WG.sprite(appleRows, { s: "#7A5236", g: "#34D399", G: "#127A52", l: "#FF8A97", h: "#FFE1E5", r: "#E0475B", d: "#9E2340" }, { outline: "#2A0912" });
  const goldRows = [
    "....sGg...",
    "....sggG..",
    ".....s....",
    "..lr.rrr..",
    ".lhlrrrrrr",
    "lhhlrrrrrd",
    "lhlrrrrrrd",
    "llrrrrrrdd",
    "lrrrrrrrdd",
    ".rrrrrrdd.",
    ".rrrrrddd.",
    "..dd.dd...",
  ];
  const GOLD = WG.sprite(goldRows, { s: "#7A5236", g: "#34D399", G: "#127A52", l: "#FFF0C2", h: "#FFFFFF", r: "#FFD27A", d: "#C98A1B" }, { outline: "#3A2600" });
  const SHADOW = WG.sprite(["..####..", "########", "..####.."], { "#": "rgba(0,12,10,.45)" });
  const FLOWERS = [
    WG.sprite([".w.", "wyw", ".w."], { w: "#EAF0FA", y: "#FFD27A" }),
    WG.sprite([".v.", "vyv", ".v."], { v: "#C4BBFF", y: "#FFF0C2" }),
    WG.sprite([".p.", "pwp", ".p."], { p: "#FF8F8F", w: "#FFF0C2" }),
    WG.sprite(["c.c", ".y.", "c.c"], { c: "#7FE6F4", y: "#FFFFFF" }),
  ];
  const STEM = "#2E7D5B";
  const MUSH = WG.sprite([".rrr.", "rwrrr", "rrrwr", ".#c#.", "..c.."], { r: "#D93644", w: "#FFE1E5", c: "#EAF0FA", "#": "#9AA5C0" }, { outline: "#1B0A10" });
  const MUSH2 = WG.sprite([".bbb.", "bbbwb", ".#c#.", "..c.."], { b: "#8B7CF6", w: "#C4BBFF", c: "#EAF0FA", "#": "#9AA5C0" }, { outline: "#120C2A" });
  const PEBBLE = WG.sprite([".hs.", "hsss", "sssd", ".dd."], { h: "#9AA5C0", s: "#6B7694", d: "#46516F" });
  const TUFT = WG.sprite(["..l.l..", "l.g.g.l", ".ggggg.", "..ggg.."], { l: "#3E9A78", g: "#2A7A5C" });
  const CLOVER = WG.sprite([".g.g.", "ggggg", ".ggg.", "..s.."], { g: "#2F8F66", s: "#1E6B4C" });

  // the head, facing right, in a 23×23 square whose centre pixel (11, 11) sits on the body's centre line.
  // Its half-height by column: as wide as the body at the neck (col 5), widest at the jaw, a round snout at col 20.
  const OUT = SNAKE.out;
  const HW = { 5: 5, 6: 5, 7: 6, 8: 6, 9: 7, 10: 7, 11: 7, 12: 7, 13: 7, 14: 6, 15: 6, 16: 5, 17: 5, 18: 4, 19: 3, 20: 2 };
  const inHead = (x, y) => (x < 5 ? x >= 0 && Math.abs(y - 11) <= 5 : HW[x] !== undefined && Math.abs(y - 11) <= HW[x]);
  function headCanvas(f) {
    const c = WG.canvas(23, 23), g = c.getContext("2d");
    for (let x = 5; x <= 20; x++) for (let y = 0; y < 23; y++) {
      if (!inHead(x, y)) continue;
      const edge = !inHead(x + 1, y) || !inHead(x, y - 1) || !inHead(x, y + 1);
      const hw = HW[x], dy = y - 11;
      let col = SNAKE.fill;
      if (edge) col = OUT;
      else if (dy >= hw - 1 || !inHead(x + 2, y)) col = SNAKE.shade;
      else if (dy <= -(hw - 1) && x < 17) col = "#8EF0C6";
      g.fillStyle = col; g.fillRect(x, y, 1, 1);
    }
    // the crown: a darker arrow of scales pointing forward, and the shine
    g.fillStyle = SNAKE.spot;
    for (const [x, y] of [[6, 8], [7, 9], [8, 10], [9, 11], [8, 12], [7, 13], [6, 14], [11, 11], [12, 11]]) g.fillRect(x, y, 1, 1);
    g.fillStyle = SNAKE.spot2; g.fillRect(10, 11, 1, 1);
    g.fillStyle = SNAKE.light; g.fillRect(8, 6, 3, 1); g.fillRect(7, 7, 1, 1);
    // the eyes bulge a little over the head's outline, top and bottom
    for (const top of [true, false]) {
      const Y = (y) => (top ? y : 22 - y);
      g.fillStyle = OUT;
      for (let y = 4; y <= 8; y++) for (let x = 12; x <= 16; x++) {
        if ((y === 4 || y === 8) && (x === 12 || x === 16)) continue;
        g.fillRect(x, Y(y), 1, 1);
      }
      if (f.blink) {
        g.fillStyle = SNAKE.shade; g.fillRect(13, Math.min(Y(5), Y(7)), 3, 3);
        g.fillStyle = OUT; g.fillRect(13, Y(6), 3, 1);
      } else {
        g.fillStyle = "#FFFFFF"; g.fillRect(13, Math.min(Y(5), Y(7)), 3, 3);
        g.fillStyle = "#0A0F1E"; g.fillRect(14, Math.min(Y(6), Y(7)), 2, 2);
      }
    }
    // the nostrils
    g.fillStyle = OUT; g.fillRect(19, 10, 1, 1); g.fillRect(19, 12, 1, 1);
    if (f.mouth) {
      g.fillStyle = OUT; g.fillRect(18, 9, 3, 5);
      g.fillStyle = "#7A1830"; g.fillRect(19, 10, 2, 3);
      g.fillStyle = "#FFFFFF"; g.fillRect(18, 10, 1, 1); g.fillRect(18, 12, 1, 1);
    }
    if (f.tongue) {
      g.fillStyle = "#FF4D6A";
      g.fillRect(21, 11, f.tongue === 1 ? 1 : 2, 1);
      if (f.tongue === 2) { g.fillRect(22, 10, 1, 1); g.fillRect(22, 12, 1, 1); }
    }
    return c;
  }
  // scales along the back: a diamond, then a small one
  const SCALE1 = WG.sprite(["..d..", ".dcd.", "dcCcd", ".dcd.", "..d.."], { d: "#127A52", c: "#1FA874", C: "#7FE6F4" });
  const SCALE2 = WG.sprite([".d.", "dcd", ".d."], { d: "#127A52", c: "#1FA874" });
  // turned by mirroring where possible, so the moonlight stays on the head's upper-left side
  const HEADS = {};
  for (const key of ["", "b", "t1", "t2", "m"]) {
    const f = { blink: key === "b", tongue: key === "t1" ? 1 : key === "t2" ? 2 : 0, mouth: key === "m" };
    const right = headCanvas(f), up = WG.rotate(right, 3);
    HEADS[key] = { right, left: WG.flipX(right), up, down: WG.flipY(up) };
  }

  // ---------- the scenery, drawn once ----------
  function stoneRow(g, x0, y0, w, h, blockW, seed) {
    const rnd = WG.rng(seed);
    g.fillStyle = "#1B2133"; g.fillRect(x0, y0, w, h);
    let x = x0 - Math.floor(rnd() * blockW);
    while (x < x0 + w) {
      const bw = blockW - 2 + Math.floor(rnd() * 5);
      const a = Math.max(x0, x + 1), b = Math.min(x0 + w, x + bw);
      if (b > a) {
        const tone = rnd();
        g.fillStyle = tone > 0.66 ? "#525D7D" : tone > 0.33 ? "#4A5573" : "#434D6A"; g.fillRect(a, y0 + 1, b - a, h - 2);
        g.fillStyle = "#7782A2"; g.fillRect(a, y0 + 1, b - a, 1);
        g.fillStyle = "#2C3550"; g.fillRect(a, y0 + h - 2, b - a, 1);
        if (rnd() > 0.5) { g.fillStyle = "#5E6A8C"; g.fillRect(a + 1, y0 + 2, 1, 1); }
      }
      x += bw;
    }
  }
  function stoneCol(g, x0, y0, w, h, seed) {
    const rnd = WG.rng(seed);
    g.fillStyle = "#1B2133"; g.fillRect(x0, y0, w, h);
    let y = y0 - Math.floor(rnd() * 8);
    while (y < y0 + h) {
      const bh = 7 + Math.floor(rnd() * 6);
      const a = Math.max(y0, y + 1), b = Math.min(y0 + h, y + bh);
      if (b > a) {
        const tone = rnd();
        g.fillStyle = tone > 0.5 ? "#4A5573" : "#434D6A"; g.fillRect(x0 + 1, a, w - 2, b - a);
        g.fillStyle = "#7782A2"; g.fillRect(x0 + 1, a, w - 2, 1); g.fillRect(x0 + 1, a, 1, b - a);
        g.fillStyle = "#2C3550"; g.fillRect(x0 + w - 2, a + 1, 1, b - a - 1);
      }
      y += bh;
    }
  }
  function moss(g, x, y, w, seed, down) {
    const rnd = WG.rng(seed);
    for (let i = 0; i < w; i++) {
      if (rnd() < 0.55) continue;
      const h = 1 + Math.floor(rnd() * 2);
      g.fillStyle = rnd() > 0.5 ? "#1FA874" : "#127A52";
      g.fillRect(x + i, down ? y : y - h + 1, 1, h);
    }
  }
  function bush(g, x, y, w, h, seed) {
    const rnd = WG.rng(seed);
    g.fillStyle = "#0B2019"; g.fillRect(x, y, w, h);
    for (let i = 0; i < (w * h) / 6; i++) {
      const px = x + Math.floor(rnd() * w), py = y + Math.floor(rnd() * h);
      g.fillStyle = rnd() > 0.5 ? "#123A2D" : "#0F2E24";
      g.fillRect(px, py, 2, 2);
      if (rnd() > 0.85) { g.fillStyle = "#1E5A44"; g.fillRect(px, py, 1, 1); }
    }
  }
  function paintGround() {
    const c = WG.canvas(WG.W, WG.H), g = c.getContext("2d");
    const rnd = WG.rng(20261028);
    // the hedges outside the wall
    bush(g, 0, 40, 6, 176, 3); bush(g, 378, 40, 6, 176, 4); bush(g, 0, 212, 384, 4, 5);
    // the lawn: a two-tone checker of moonlit grass
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
      g.fillStyle = (i + j) % 2 ? "#17443A" : "#1A4B40";
      g.fillRect(FX0 + i * CELL, FY0 + j * CELL, CELL, CELL);
    }
    // blades and specks
    for (let k = 0; k < 900; k++) {
      const x = FX0 + Math.floor(rnd() * COLS * CELL), y = FY0 + 2 + Math.floor(rnd() * (ROWS * CELL - 2));
      const r = rnd();
      if (r < 0.45) { g.fillStyle = "#235E4E"; g.fillRect(x, y, 1, 2); g.fillRect(x + 1, y + 1, 1, 1); }
      else if (r < 0.7) { g.fillStyle = "#2A6D58"; g.fillRect(x, y, 1, 1); }
      else if (r < 0.9) { g.fillStyle = "#123832"; g.fillRect(x, y, 2, 1); }
      else { g.fillStyle = "#2F7A62"; g.fillRect(x, y, 1, 2); g.fillRect(x - 1, y + 1, 1, 1); g.fillRect(x + 1, y, 1, 1); }
    }
    // moonlight from above: the rows under the wall in its shadow, a soft lighter band lower down
    art.dither(g, FX0, FY0, COLS * CELL, 3, null, "#0C2620", 0.75);
    art.dither(g, FX0, FY0 + 3, COLS * CELL, 3, null, "#0C2620", 0.3);
    // decorations (they are only grass to the snake)
    for (let k = 0; k < 22; k++) {
      const x = FX0 + 2 + Math.floor(rnd() * (COLS * CELL - 6)), y = FY0 + 6 + Math.floor(rnd() * (ROWS * CELL - 10));
      g.fillStyle = STEM; g.fillRect(x + 1, y + 3, 1, 2);
      g.drawImage(FLOWERS[k % FLOWERS.length], x, y);
    }
    for (let k = 0; k < 10; k++) g.drawImage(PEBBLE, FX0 + Math.floor(rnd() * (COLS * CELL - 4)), FY0 + 4 + Math.floor(rnd() * (ROWS * CELL - 6)));
    for (let k = 0; k < 12; k++) g.drawImage(TUFT, FX0 + Math.floor(rnd() * (COLS * CELL - 7)), FY0 + 5 + Math.floor(rnd() * (ROWS * CELL - 9)));
    // the lawn darkens a little toward the wall all round
    art.dither(g, FX0, FY1 - 3, COLS * CELL, 3, null, "#0C2620", 0.3);
    art.dither(g, FX0, FY0, 3, ROWS * CELL, null, "#0C2620", 0.35);
    art.dither(g, FX1 - 3, FY0, 3, ROWS * CELL, null, "#0C2620", 0.35);
    for (let k = 0; k < 7; k++) g.drawImage(CLOVER, FX0 + Math.floor(rnd() * (COLS * CELL - 5)), FY0 + 4 + Math.floor(rnd() * (ROWS * CELL - 6)));
    // mushrooms grow along the wall
    const spots = [[FX0 + 3, FY0 + 4, MUSH], [FX0 + 40, FY0 + 2, MUSH2], [FX1 - 12, FY0 + 3, MUSH], [FX1 - 9, FY1 - 9, MUSH2], [FX0 + 2, FY1 - 9, MUSH], [FX0 + 182, FY1 - 8, MUSH2]];
    for (const [x, y, m] of spots) g.drawImage(m, x, y);
    // the stone wall: the top and bottom rows show their face, the sides their tops
    stoneRow(g, 6, FY0 - 7, 372, 7, 12, 11);
    moss(g, 6, FY0 - 7, 372, 12, false);
    stoneRow(g, 6, FY1, 372, 6, 12, 13);
    moss(g, 6, FY1, 372, 14, true);
    stoneCol(g, 6, FY0, 6, FY1 - FY0, 15);
    stoneCol(g, FX1, FY0, 6, FY1 - FY0, 16);
    // corner posts with caps
    for (const [x, y] of [[4, FY0 - 9], [FX1 - 2, FY0 - 9], [4, FY1 - 2], [FX1 - 2, FY1 - 2]]) {
      g.fillStyle = "#1B2133"; g.fillRect(x, y, 10, 10);
      g.fillStyle = "#5A6688"; g.fillRect(x + 1, y + 1, 8, 8);
      g.fillStyle = "#8590B0"; g.fillRect(x + 1, y + 1, 8, 1); g.fillRect(x + 1, y + 1, 1, 8);
      g.fillStyle = "#353F5C"; g.fillRect(x + 8, y + 2, 1, 7); g.fillRect(x + 2, y + 8, 7, 1);
      g.fillStyle = "#6E7A9C"; g.fillRect(x + 3, y + 3, 4, 4);
      g.fillStyle = "#1FA874"; g.fillRect(x + 2, y + 1, 2, 1);
    }
    return c;
  }
  function paintHorizon() {
    // what stands between the sky and the wall: far mountains, the moon's hill, a line of pines
    const c = WG.canvas(WG.W, 46), g = c.getContext("2d");
    art.ridge(g, 0, 40, 384, 18, "#15234A", 3, 46, 0.1);
    art.ridge(g, 0, 43, 384, 9, "#0F1A38", 9, 46, 0.05);
    art.pines(g, 0, 44, 384, "#0A1530", 21, 6, 13, 6);
    art.pines(g, 3, 46, 384, "#07101F", 34, 4, 8, 9);
    return c;
  }
  let GROUND = null, HORIZON = null;

  // ---------- the ten fields: "#" stone, a digit a portal (two cells with one digit lead into each other) ----------
  // goal: apples to collect; k: how much harder the field is to cross (stretches the times for the stars)
  const D = ".".repeat(COLS);
  const STAGES = [
    { name: "Камешки", goal: 6, k: 1, map: [D, D, ".....#........#.........#.....", D, D, D, D, D, D, D, ".....#.........#........#.....", D, D] },
    { name: "Грядки", goal: 7, k: 1, map: [D, D, D, "........############..........", D, D, D, D, D, "..........############........", D, D, D] },
    { name: "Портал", goal: 8, k: 1.1, map: ["...............#..............", "...............#..............", "...1...........#..............", "...............#..............", "...............#..............", D, D, D, "...............#..............", "...............#..............", "...............#..........1...", "...............#..............", "...............#.............."] },
    { name: "Колодец", goal: 9, k: 1.15, map: [D, D, D, "...........###..###...........", "...........#......#...........", "...........#...1..#...........", D, "...........#......#...........", "...........#......#...........", "...........###..###...........", "...1..........................", D, D] },
    { name: "Две ограды", goal: 10, k: 1.15, map: [D, "...........................1..", D, D, "########################......", D, D, D, "......########################", D, D, "..1...........................", D] },
    { name: "Лабиринт", goal: 10, k: 1.35, start: [3, 8, "up"], map: [".......#...........#..........", ".......#...........#..........", ".......#...........#........1.", ".......#...........#..........", ".......#.....#.....#.....#....", ".......#.....#.....#.....#....", ".......#.....#.....#.....#....", ".......#.....#.....#.....#....", ".......#.....#.....#.....#....", ".............#...........#....", "..........1..#...........#....", ".............#...........#....", ".............#...........#...."] },
    { name: "Крест", goal: 11, k: 1.25, start: [4, 2, "right"], map: [D, "..............##..............", "..............##..........1...", "..........2...##..............", "..............##..............", "..............##..............", "........##############........", "..............##..............", "..............##..............", "..............##..............", "...1..........##..........2...", "..............##..............", D] },
    { name: "Четыре комнаты", goal: 12, k: 1.3, start: [4, 3, "right"], map: ["...............#..............", "...............#..............", "...........2..............1...", D, "...............#..............", "...............#..............", "######..##############..######", "...............#..............", "...............#..............", D, "...1......................2...", "...............#..............", "...............#.............."] },
    { name: "Змеиный ход", goal: 13, k: 1.45, start: [8, 1, "right"], map: [D, ".1............................", D, "#########################.....", D, D, ".....#########################", D, D, "#########################.....", D, "............................1.", D] },
    { name: "Ночной сад", goal: 15, k: 1.35, start: [3, 6, "right"], map: [D, ".2............................", ".....##..................##...", ".....#.....######.........#...", D, D, "..........1........1..........", D, D, ".....#.....######.........#...", ".....##..................##...", "............................2.", D] },
  ];
  // seconds for ★★★ and ★★ on a field
  const par = (st) => ({ p3: Math.round(st.goal * 3.0 * st.k + 4), p2: Math.round(st.goal * 4.6 * st.k + 8) });
  const PORTAL_COLORS = {
    1: { dark: "#06222B", deep: "#0B4A5C", a: "#D2FAFF", b: "#22B8CF", c: "#7FE6F4", glow: "rgba(127,230,244,.22)" },
    2: { dark: "#150F38", deep: "#2E2470", a: "#EDE9FF", b: "#8B7CF6", c: "#C4BBFF", glow: "rgba(196,187,255,.22)" },
  };
  function parseField(st) {
    const blocks = new Set(), portals = new Map(), list = [], byDigit = {};
    if (st) st.map.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === "#") blocks.add(x + "," + y);
      else if (/\d/.test(ch)) (byDigit[ch] = byDigit[ch] || []).push([x, y]);
    }));
    for (const [dg, [a, b]] of Object.entries(byDigit)) {
      portals.set(a.join(","), b); portals.set(b.join(","), a);
      list.push({ x: a[0], y: a[1], col: PORTAL_COLORS[dg] || PORTAL_COLORS[1] }, { x: b[0], y: b[1], col: PORTAL_COLORS[dg] || PORTAL_COLORS[1] });
    }
    return { blocks, portals, list };
  }
  // stones on the lawn: mossy blocks that join into walls, with a shadow on the grass
  const layers = {};
  function paintField(n, F) {
    if (layers[n]) return layers[n];
    const c = WG.canvas(WG.W, WG.H), g = c.getContext("2d");
    const B = (x, y) => F.blocks.has(x + "," + y);
    const rnd = WG.rng(500 + n);
    for (const k of F.blocks) {
      const [x, y] = k.split(",").map(Number), X = FX0 + x * CELL, Y = FY0 + y * CELL;
      if (!B(x, y + 1) && y + 1 < ROWS) art.dither(g, X + 1, Y + CELL, CELL, 3, null, "#0A221C", 0.7);
      if (!B(x + 1, y) && x + 1 < COLS) art.dither(g, X + CELL, Y + 3, 2, CELL - 1, null, "#0A221C", 0.55);
    }
    for (const k of F.blocks) {
      const [x, y] = k.split(",").map(Number), X = FX0 + x * CELL, Y = FY0 + y * CELL;
      const up = B(x, y - 1), dn = B(x, y + 1), lf = B(x - 1, y), rt = B(x + 1, y);
      const face = dn ? 0 : 4; // the front face shows where nothing stands below
      g.fillStyle = "#525D7D"; g.fillRect(X, Y, CELL, CELL - face);
      if (face) { g.fillStyle = "#3A4460"; g.fillRect(X, Y + CELL - face, CELL, face); g.fillStyle = "#2C3550"; g.fillRect(X, Y + CELL - 1, CELL, 1); }
      // joints between the stones
      g.fillStyle = "#434D6A";
      const o = (x + y) % 2 ? 6 : 3;
      if (CELL - face > 5) { g.fillRect(X, Y + 5, CELL, 1); g.fillRect(X + o, Y, 1, 5); g.fillRect(X + ((o + 5) % CELL), Y + 6, 1, CELL - face - 6); }
      if (face) { g.fillStyle = "#2F3852"; g.fillRect(X + ((o + 2) % CELL), Y + CELL - face, 1, face - 1); }
      // light from the upper left, the outline where the stone meets grass
      g.fillStyle = "#7782A2";
      if (!up) g.fillRect(X, Y, CELL, 1);
      if (!lf) g.fillRect(X, Y, 1, CELL - face);
      g.fillStyle = "#1B2133";
      if (!up) g.fillRect(X, Y - 1, CELL, 1);
      if (!dn) g.fillRect(X, Y + CELL, CELL, 1);
      if (!lf) g.fillRect(X - 1, Y, 1, CELL);
      if (!rt) g.fillRect(X + CELL, Y, 1, CELL);
      if (!rt) { g.fillStyle = "#353F5C"; g.fillRect(X + CELL - 1, Y + 1, 1, CELL - face - 1); }
      if (!up) for (let i = 0; i < CELL; i++) if (rnd() < 0.35) { g.fillStyle = rnd() > 0.5 ? "#1FA874" : "#127A52"; g.fillRect(X + i, Y - 1, 1, rnd() > 0.6 ? 2 : 1); }
    }
    return (layers[n] = c);
  }
  function drawPortal(g, p, t, front) {
    const x = FX0 + p.x * CELL + 6, y = FY0 + p.y * CELL + 6, C = p.col;
    if (!front) {
      const r = 7 + Math.round(Math.sin(t * 3 + p.x));
      art.dither(g, x - r, y - r, r * 2 + 1, r * 2 + 1, null, C.glow, 0.45);
      art.disc(g, x, y, 5.5, C.dark);
      art.disc(g, x, y, 3.5, C.deep);
      for (let i = 0; i < 3; i++) { const a = -t * 4 + i * 2.09; g.fillStyle = C.c; g.fillRect(Math.round(x + Math.cos(a) * 2), Math.round(y + Math.sin(a) * 2), 1, 1); }
      g.fillStyle = C.a; g.fillRect(x, y, 1, 1);
    }
    for (let i = 0; i < 12; i++) {
      const a = t * 2.4 + (i / 12) * Math.PI * 2;
      g.fillStyle = i % 3 === 0 ? C.a : i % 3 === 1 ? C.b : C.c;
      g.fillRect(Math.round(x + Math.cos(a) * 5.5), Math.round(y + Math.sin(a) * 5.5), 1, 1);
    }
  }

  // ---------- music ----------
  const MUSIC = {
    bpm: 136,
    ch: [
      { w: "p25", v: 0.12, sus: 0.5, notes: "E5 . G5 . C6 . G5 . A5 - G5 . E5 . D5 . C5 . E5 . G5 . E5 . F5 - E5 . D5 . . . E5 . G5 . C6 . D6 . E6 - D6 . C6 . A5 . G5 . E5 . D5 . E5 . C5 - - - . . . ." },
      { w: "p12", v: 0.05, sus: 0.3, notes: "C6 G5 E5 G5 C6 G5 E5 G5 C6 G5 E5 G5 B5 G5 D5 G5 A5 F5 C5 F5 A5 F5 C5 F5 B5 G5 D5 G5 B5 G5 D5 G5 A5 E5 C5 E5 A5 E5 C5 E5 A5 F5 C5 F5 A5 F5 C5 F5 G5 D5 B4 D5 G5 D5 B4 D5 C6 G5 E5 G5 C6 . . ." },
      { w: "tri", v: 0.22, sus: 0.8, notes: "C3 . C4 . C3 . C4 . C3 . C4 . G2 . G3 . F2 . F3 . F2 . F3 . G2 . G3 . G2 . G3 . A2 . A3 . A2 . A3 . F2 . F3 . F2 . F3 . G2 . G3 . G2 . B2 . C3 . C4 . C3 . . ." },
      { w: "noise", v: 0.2, notes: "k . h . s . h . k . h k s . h h" },
    ],
  };
  const GOLD_T = ["#FFF0C2", "#FFF0C2", "#FFD27A", "#FFD27A", "#FFD27A", "#C98A1B", "#C98A1B"];
  const INK_T = ["#FFFFFF", "#FFFFFF", "#EAF0FA", "#EAF0FA", "#C9D6F2", "#C9D6F2", "#A9B6CD"];

  // ---------- the game ----------
  WG.game({
    id: "snake",
    portrait: true,
    controls: { dpad: true, a: false, b: false, swipe: true, landscapeDpad: false },
    howto: "Собирай яблоки и расти. Не врезайся в камни и в собственный хвост; порталы переносят на другую сторону поля.",
    keysHint: "Стрелки или WASD — поворот, Esc — пауза.",
    touchHowto: (l) => (l.dpad ? "Проведите пальцем по полю или нажимайте крестовину." : "Проведите пальцем по полю — змейка повернёт туда же."),
    titleColors: ["#D8FFE9", "#D8FFE9", "#8EF0C6", "#8EF0C6", "#3BDB9E", "#3BDB9E", "#1FA874"],
    stageNames: STAGES.map((s) => s.name),
    music: MUSIC,
    create(api) {
      if (!GROUND) { GROUND = paintGround(); HORIZON = paintHorizon(); }
      const ST = api.stage ? STAGES[api.stage - 1] : null; // null: the endless garden
      const F = parseField(ST);
      const LAYER = ST ? paintField(api.stage, F) : null;
      const PAR = ST ? par(ST) : null;
      const fx = new WG.Particles(500);
      const [sx, sy, sd] = (ST && ST.start) || [8, 6, "right"];
      const S = {
        t: 0, phase: "idle", countT: 0, cells: [], prevTail: null, dir: sd, moveDir: sd, queue: [], acc: 0, grow: 0,
        stepT: ST ? 0.15 - (api.stage - 1) * 0.0025 : 0.15, food: null, gold: null, swallowed: null, score: 0, apples: 0,
        deadT: 0, wonT: 0, bulges: [], pops: [], ended: false, blinkT: 2, tongueT: 1, sparkT: 0, burned: 0, playMs: 0, steps: 0,
      };
      const flies = [];
      const frnd = WG.rng(77);
      for (let i = 0; i < 7; i++) flies.push({ x: 20 + frnd() * 340, y: 60 + frnd() * 140, p: frnd() * 6.28, s: 0.4 + frnd() * 0.6 });
      const [ddx, ddy] = DIRS[sd];
      for (let i = 0; i < 4; i++) S.cells.push([sx - ddx * i, sy - ddy * i]);
      S.prevTail = [sx - ddx * 4, sy - ddy * 4];

      const cx = (i) => FX0 + i * CELL + 6;
      const cy = (j) => FY0 + j * CELL + 6;
      const K = (x, y) => x + "," + y;
      const occupied = (x, y, skipTail) => {
        const n = S.cells.length - (skipTail ? 1 : 0);
        for (let i = 0; i < n; i++) if (S.cells[i][0] === x && S.cells[i][1] === y) return true;
        return false;
      };
      const solid = (x, y) => F.blocks.has(K(x, y)) || F.portals.has(K(x, y));
      function freeCell(minDist) {
        const [hx, hy] = S.cells[0];
        const ok = (x, y) => !occupied(x, y) && !solid(x, y) && !(S.food && S.food.x === x && S.food.y === y) && !(S.gold && S.gold.x === x && S.gold.y === y);
        for (let tries = 0; tries < 500; tries++) {
          const x = Math.floor(Math.random() * COLS), y = Math.floor(Math.random() * ROWS);
          if (ok(x, y) && Math.abs(x - hx) + Math.abs(y - hy) >= (minDist || 3)) return { x, y };
        }
        for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (ok(x, y)) return { x, y };
        return null;
      }
      if (!ST) S.food = { x: 19, y: 6, born: 0 };
      else { const f = freeCell(5); S.food = f && { x: f.x, y: f.y, born: 0 }; }

      function pop(x, y, text, color) { S.pops.push({ x, y, text, color, t: 0 }); }
      const secs = () => S.playMs / 1000;
      const starsNow = () => (!PAR ? 0 : secs() <= PAR.p3 ? 3 : secs() <= PAR.p2 ? 2 : 1);
      const clock = (sec) => Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0");
      function die() {
        S.phase = "dead"; S.deadT = 0; S.burned = 0;
        api.sfx("die");
        api.shake(4, 0.35);
        api.flash("#FF6B7A", 0.18);
        const [hx, hy] = S.cells[0];
        fx.emit({ x: cx(hx), y: cy(hy), n: 26, colors: ["#FFFFFF", "#FFD27A", "#FF6B7A"], speed: [30, 110], life: [0.3, 0.8], drag: 3, shape: "spark" });
      }
      function win() {
        S.phase = "won"; S.wonT = 0;
        const [hx, hy] = S.cells[0];
        api.flash("#FFF0C2", 0.2);
        fx.emit({ x: cx(hx), y: cy(hy), n: 40, colors: ["#FFF0C2", "#FFD27A", "#FFFFFF", "#8EF0C6"], speed: [30, 120], life: [0.5, 1.2], drag: 2, shape: "star" });
      }
      function step() {
        while (S.queue.length) {
          const nd = S.queue.shift();
          if (nd !== OPP[S.dir] && nd !== S.dir) { S.dir = nd; break; }
        }
        const [dx, dy] = DIRS[S.dir];
        const [hx, hy] = S.cells[0];
        // standing in a portal: the next step comes out of its pair
        const via = F.portals.get(K(hx, hy));
        const bx = via ? via[0] : hx, by = via ? via[1] : hy;
        const nx = bx + dx, ny = by + dy;
        if (nx < 0 || ny < 0 || nx >= COLS || ny >= ROWS || F.blocks.has(K(nx, ny)) || occupied(nx, ny, S.grow === 0)) { die(); return; }
        if (via) {
          api.sfx("whoosh");
          fx.emit({ x: cx(bx), y: cy(by), n: 10, colors: ["#D2FAFF", "#7FE6F4", "#C4BBFF"], speed: [15, 40], life: [0.25, 0.5], drag: 4 });
        }
        S.moveDir = S.dir;
        S.cells.unshift([nx, ny]);
        S.steps++;
        if (S.grow > 0) { S.grow--; S.prevTail = S.cells[S.cells.length - 1].slice(); }
        else S.prevTail = S.cells.pop();
        for (const b of S.bulges) b.steps++;
        S.bulges = S.bulges.filter((b) => b.steps < S.cells.length + 1);
        const ate = (f) => f && f.x === nx && f.y === ny;
        if (ate(S.food)) {
          S.apples++;
          const value = 10 * (1 + Math.floor((S.apples - 1) / 10));
          S.score += value;
          S.grow += 1;
          S.swallowed = { x: nx, y: ny, img: APPLE, t: 0 };
          S.bulges.push({ steps: 0 });
          api.sfx("eat");
          fx.emit({ x: cx(nx), y: cy(ny), n: 14, colors: ["#FF8A97", "#FFE1E5", "#E0475B", "#34D399"], speed: [25, 70], life: [0.25, 0.6], drag: 4 });
          pop(cx(nx), cy(ny) - 10, "+" + value, "#FFE1E5");
          S.stepT = Math.max(0.072, S.stepT - (ST ? 0.0022 : 0.0028));
          S.food = null;
          if (ST && S.apples >= ST.goal) { win(); return; }
          const f = freeCell(4);
          if (f) S.food = { x: f.x, y: f.y, born: S.t };
          if (S.apples % 5 === 0 && !S.gold) { const gc = freeCell(5); if (gc) S.gold = { x: gc.x, y: gc.y, born: S.t, ttl: 7 }; }
        } else if (ate(S.gold)) {
          const value = 50 + 10 * Math.floor(S.apples / 10);
          S.score += value;
          S.grow += 2;
          S.swallowed = { x: nx, y: ny, img: GOLD, t: 0 };
          S.bulges.push({ steps: 0, big: true });
          api.sfx("bonus");
          fx.emit({ x: cx(nx), y: cy(ny), n: 26, colors: ["#FFF0C2", "#FFD27A", "#FFFFFF", "#C98A1B"], speed: [30, 90], life: [0.3, 0.9], drag: 3, shape: "star" });
          pop(cx(nx), cy(ny) - 10, "+" + value, "#FFD27A");
          S.gold = null;
        }
      }
      function steer() {
        const d = api.input.dir();
        if (!d) return;
        const last = S.queue.length ? S.queue[S.queue.length - 1] : S.dir;
        if (d === last || d === OPP[last]) return;
        if (S.queue.length < 3) S.queue.push(d);
        if (S.phase === "run") api.sfx("tick");
      }

      return {
        _state: S, _field: F, // for automated checks (games/dev)
        start() { S.phase = "count"; S.countT = 0; api.sfx("start"); },
        update(dt) {
          S.t += dt;
          fx.update(dt);
          for (const p of S.pops) p.t += dt;
          S.pops = S.pops.filter((p) => p.t < 0.9);
          S.blinkT -= dt; if (S.blinkT < -0.12) S.blinkT = 2 + Math.random() * 3;
          S.tongueT -= dt; if (S.tongueT < -0.35) S.tongueT = 0.9 + Math.random() * 1.6;
          if (S.swallowed) { S.swallowed.t += dt; if (S.swallowed.t > S.stepT * 0.7) S.swallowed = null; }
          S.sparkT -= dt;
          if (S.sparkT <= 0 && S.phase !== "dead") {
            S.sparkT = 0.35;
            if (S.food) fx.emit({ x: cx(S.food.x) + (Math.random() * 12 - 6), y: cy(S.food.y) + (Math.random() * 10 - 6), n: 1, colors: ["#FFFFFF", "#FFE1E5"], speed: [2, 6], angle: [-2, -1], life: [0.5, 0.8], shape: "star" });
            if (S.gold) fx.emit({ x: cx(S.gold.x) + (Math.random() * 14 - 7), y: cy(S.gold.y) + (Math.random() * 12 - 7), n: 2, colors: ["#FFFFFF", "#FFD27A"], speed: [2, 8], angle: [-2, -1], life: [0.5, 0.9], shape: "star" });
          }
          if (S.gold && S.t - S.gold.born > S.gold.ttl) {
            fx.emit({ x: cx(S.gold.x), y: cy(S.gold.y), n: 10, colors: ["#C98A1B", "#6B4A0A"], speed: [10, 30], life: [0.3, 0.5] });
            S.gold = null;
          }
          for (const f of flies) { f.p += dt * f.s; f.x += Math.cos(f.p * 0.7) * 6 * dt; f.y += Math.sin(f.p) * 4 * dt; if (f.x < 14) f.x = 370; if (f.x > 370) f.x = 14; }
          if (S.phase === "count") {
            steer();
            const before = S.countT;
            S.countT += dt;
            for (const m of [0.6, 1.2]) if (before < m && S.countT >= m) api.sfx("count");
            if (before < 1.8 && S.countT >= 1.8) { api.sfx("go"); S.phase = "run"; step(); S.acc = 0; }
            return;
          }
          if (S.phase === "run") {
            S.playMs += dt * 1000;
            steer();
            S.acc += dt;
            while (S.acc >= S.stepT && S.phase === "run") { S.acc -= S.stepT; step(); }
            if (S.countT < 2.6) S.countT += dt;
            return;
          }
          if (S.phase === "won") {
            S.wonT += dt;
            if (!S.ended && S.wonT > 1.3) {
              S.ended = true;
              const stars = starsNow();
              const hint = stars === 1 ? "★★ — быстрее " + clock(PAR.p2) : stars === 2 ? "★★★ — быстрее " + clock(PAR.p3) : "";
              api.clear({ stars, score: S.score, ms: Math.round(S.playMs), hint, line: S.apples + " яблок · " + clock(secs()), meta: { apples: S.apples, length: S.cells.length } });
            }
            return;
          }
          if (S.phase === "dead") {
            S.deadT += dt;
            const want = Math.min(S.cells.length, Math.floor(Math.max(0, S.deadT - 0.45) / 0.035));
            while (S.burned < want) {
              const [x, y] = S.cells[S.burned];
              fx.emit({ x: cx(x), y: cy(y), n: 5, colors: [SNAKE.fill, SNAKE.light, SNAKE.shade, "#FFFFFF"], speed: [10, 45], life: [0.3, 0.7], drag: 3 });
              S.burned++;
              if (S.burned % 3 === 0) api.tone({ w: "p12", f: 900 - S.burned * 8, d: 0.02, v: 0.06 });
            }
            if (!S.ended && S.deadT > 0.9 + S.cells.length * 0.035) {
              S.ended = true;
              const meta = { apples: S.apples, length: S.cells.length };
              if (ST) api.end({ score: S.score, ms: Math.round(S.playMs), meta, line: "Съедено " + S.apples + " из " + ST.goal + " яблок · " + clock(secs()), hint: "Поле " + api.stage + " — «" + ST.name + "»" });
              else api.end({ score: S.score, ms: Math.round(S.playMs), meta });
            }
          }
        },
        draw(g, alpha) {
          const t = S.t;
          art.sky(g, 0, 0, 384, 46, t, { seed: 5, top: "#04070F", bottom: "#142449", curtain: 0.62, amount: 0.95 });
          art.moon(g, 262, 13, 6);
          g.drawImage(HORIZON, 0, 0);
          g.drawImage(GROUND, 0, 0);
          if (LAYER) g.drawImage(LAYER, 0, 0);
          for (const p of F.list) drawPortal(g, p, t, false);
          drawFood(g, t);
          drawSnake(g, alpha);
          for (const p of F.list) drawPortal(g, p, t, true);
          fx.draw(g);
          for (const f of flies) {
            if (Math.sin(t * 2.2 + f.p * 3) <= 0.1) continue;
            const x = Math.round(f.x), y = Math.round(f.y);
            g.fillStyle = "rgba(255,210,122,.35)"; g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3);
            g.fillStyle = "#FFF0C2"; g.fillRect(x, y, 1, 1);
          }
          for (const p of S.pops) {
            const k = p.t / 0.9;
            WG.text(g, p.text, p.x, p.y - Math.round(k * 12), { align: "center", color: k > 0.7 && Math.floor(p.t * 20) % 2 ? "#A9B6CD" : p.color, shadow: "#04231A" });
          }
          drawHud(g);
          if (S.phase === "count") drawCount(g);
          if (S.phase === "won" && S.wonT > 0.2 && !S.ended) WG.text(g, "ПОЛЕ ПРОЙДЕНО!", 192, 112, { scale: 3, align: "center", color: GOLD_T, outline: "#2A1E00" });
        },
      };

      function drawFood(g, t) {
        const bob = (f) => Math.round(Math.sin((t - f.born) * 4) * 1);
        if (S.food) {
          const x = cx(S.food.x), y = cy(S.food.y);
          const age = t - S.food.born;
          g.drawImage(SHADOW, x - 4, y + 5);
          if (age < 0.25) {
            const s = Math.max(1, Math.round(APPLE.width * (age / 0.25)));
            g.drawImage(APPLE, Math.round(x - s / 2 + 1), Math.round(y - s / 2 + 1), s, Math.round(s * APPLE.height / APPLE.width));
          } else g.drawImage(APPLE, x - 5, y - 8 + bob(S.food));
        }
        if (S.gold) {
          const x = cx(S.gold.x), y = cy(S.gold.y);
          const left = S.gold.ttl - (t - S.gold.born);
          if (left > 2 || Math.floor(t * 8) % 2) {
            const r = 7 + Math.round(Math.sin(t * 6));
            art.dither(g, x - r, y - r, r * 2, r * 2, null, "rgba(255,210,122,.25)", 0.5);
            g.drawImage(SHADOW, x - 4, y + 5);
            g.drawImage(GOLD, x - 5, y - 8 + bob(S.gold));
          }
          const n = Math.ceil((left / S.gold.ttl) * 12);
          g.fillStyle = "#FFD27A";
          for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + (i / 12) * Math.PI * 2; g.fillRect(Math.round(x + Math.cos(a) * 9), Math.round(y - 1 + Math.sin(a) * 9), 1, 1); }
        }
        if (S.swallowed) {
          const x = cx(S.swallowed.x), y = cy(S.swallowed.y), k = 1 - S.swallowed.t / (S.stepT * 0.7);
          const w = Math.max(2, Math.round(S.swallowed.img.width * k)), h = Math.max(2, Math.round(S.swallowed.img.height * k));
          g.drawImage(S.swallowed.img, Math.round(x - w / 2), Math.round(y - h / 2 - 2), w, h);
        }
      }
      // the body as one or more pieces: a piece ends where the snake goes into a portal and starts where it comes out
      function bodyRuns(f, skip) {
        const C = S.cells, n = C.length;
        const P = (c) => ({ x: cx(c[0]), y: cy(c[1]) });
        const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;
        const lerpP = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
        const pairOf = (c) => F.portals.get(K(c[0], c[1]));
        const runs = [];
        let run;
        if (skip) run = [P(C[skip])];
        else {
          // the head glides from the cell before (or out of the portal it came through) toward its new cell
          const from = near(C[1], C[0]) ? C[1] : pairOf(C[1]) || C[1];
          run = [lerpP(P(from), P(C[0]), f)];
        }
        for (let i = Math.max(1, skip + 1); i < n; i++) {
          if (near(C[i - 1], C[i])) run.push(P(C[i]));
          else { const b = pairOf(C[i]); if (b) run.push(P(b)); runs.push(run); run = [P(C[i])]; }
        }
        const T = S.prevTail, L = C[n - 1];
        if (near(T, L)) run.push(lerpP(P(T), P(L), f));
        else if (!(T[0] === L[0] && T[1] === L[1])) { const b = pairOf(T); if (b) run.push(lerpP(P(b), P(L), f)); }
        runs.push(run);
        return runs;
      }
      function drawSnake(g, alpha) {
        if (S.phase === "dead" && S.burned >= S.cells.length) return;
        const moving = S.phase === "run";
        const f = moving ? Math.min(1, (S.acc + (alpha || 0) * WG.STEP) / S.stepT) : 1;
        const runs = bodyRuns(f, S.phase === "dead" ? S.burned : 0);
        const lens = runs.map((r) => { let L = 0; for (let i = 1; i < r.length; i++) L += Math.hypot(r[i].x - r[i - 1].x, r[i].y - r[i - 1].y); return L; });
        const total = lens.reduce((a, b) => a + b, 0);
        const flash = S.phase === "dead" && Math.floor(S.deadT * 16) % 2 === 0;
        const bulgeAt = S.bulges.map((b) => ({ d: (b.steps + f) * CELL - 6, big: b.big }));
        // the scales stay put on the body as it slides: counted from the distance travelled
        const travel = (S.steps + f) * CELL;
        let markStart = travel % 7;
        while (markStart < 10) markStart += 7;
        const markK = Math.round((travel - markStart) / 7) + 1000;
        const o = {
          r: 4.5, outline: flash ? "#FFFFFF" : SNAKE.out, fill: SNAKE.fill, shade: SNAKE.shade, light: SNAKE.light, taper: 22, total,
          marks: { every: 7, start: markStart, end: (tot) => tot - 12,
            draw: (gg, x, y, i) => { const m = (markK - i) % 2 ? SCALE2 : SCALE1; gg.drawImage(m, Math.round(x - m.width / 2), Math.round(y - m.height / 2)); } },
          bulge: (d) => { let r = 0; for (const b of bulgeAt) { const x = (d - b.d) / 5; r += Math.max(0, (b.big ? 2 : 1.5) * Math.exp(-x * x)); } return r; },
        };
        // the tail's pieces first, so the head's lie on top
        let d0 = total;
        for (let i = runs.length - 1; i >= 0; i--) { d0 -= lens[i]; art.tube(g, runs[i], Object.assign({}, o, { d0 })); }
        if (S.phase === "dead" && S.burned > 0) return;
        const head = runs[0][0];
        const C = S.cells;
        const d = moving || S.phase === "dead" || S.phase === "won" ? S.moveDir : S.dir;
        let key = "";
        const ahead = S.food && (() => { const [dx, dy] = DIRS[d]; for (let k = 1; k <= 2; k++) if (C[0][0] + dx * k === S.food.x && C[0][1] + dy * k === S.food.y) return true; return false; })();
        if (S.phase === "dead") key = "b";
        else if (ahead && moving) key = "m";
        else if (S.blinkT < 0 || (S.phase === "won" && Math.floor(S.wonT * 6) % 3 === 0)) key = "b";
        else if (S.tongueT < 0) key = S.tongueT > -0.08 || S.tongueT < -0.27 ? "t1" : "t2";
        g.drawImage(HEADS[key][d], Math.round(head.x - 11), Math.round(head.y - 11));
      }
      function drawHud(g) {
        g.drawImage(APPLE, 7, 4);
        WG.text(g, WG.fmtNum(S.score), 21, 5, { scale: 2, color: INK_T, shadow: "#04070F" });
        const sec = Math.floor(S.playMs / 1000);
        WG.text(g, clock(sec), 377, 5, { scale: 2, align: "right", color: INK_T, shadow: "#04070F" });
        if (ST) {
          // the field, the apples still to find, and the stars still in reach
          WG.text(g, "ПОЛЕ " + api.stage, 192, 4, { align: "center", color: "#A9B6CD", shadow: "#04070F" });
          const txt = S.apples + "/" + ST.goal;
          const w = WG.textWidth(txt) + 12;
          g.drawImage(APPLE, Math.round(192 - w / 2) - 1, 12);
          WG.text(g, txt, Math.round(192 - w / 2) + 12, 15, { color: S.apples >= ST.goal ? "#FFD27A" : "#EAF0FA", shadow: "#04070F" });
          const n = starsNow(), tw = WG.textWidth(clock(sec), 2);
          for (let i = 0; i < 3; i++) WG.text(g, "★", 377 - tw - 30 + i * 7, 9, { color: i < n ? "#FFD27A" : "#2C3550", shadow: "#04070F" });
        } else {
          const best = api.best;
          const label = best !== null && best !== undefined ? (S.score > best ? "НОВЫЙ РЕКОРД!" : "РЕКОРД " + WG.fmtNum(best)) : "ЯБЛОК " + S.apples;
          WG.text(g, label, 192, 8, { align: "center", color: best !== null && S.score > best ? "#FFD27A" : "#A9B6CD", shadow: "#04070F" });
        }
      }
      function drawCount(g) {
        const c = S.countT;
        if (ST) {
          // the field's name and goal above the count
          WG.text(g, "ПОЛЕ " + api.stage + " · " + ST.name.toUpperCase(), 192, 64, { scale: 2, align: "center", color: INK_T, outline: "#04231A" });
          WG.text(g, "СОБЕРИ " + ST.goal + " ЯБЛОК", 192, 84, { align: "center", color: "#FFD27A", outline: "#2A1E00" });
        }
        const label = c < 0.6 ? "3" : c < 1.2 ? "2" : c < 1.8 ? "1" : "ВПЕРЁД!";
        const k = c < 1.8 ? (c % 0.6) / 0.6 : (c - 1.8) / 0.8;
        const scale = c < 1.8 ? 5 : 3;
        const y = 124 - Math.round(scale * 3.5) - (c < 1.8 ? Math.round((1 - WG.util.ease(k * 2)) * 6) : 0);
        if (c >= 1.8 && Math.floor(c * 12) % 2 && k > 0.6) return;
        WG.text(g, label, 192, y, { scale, align: "center", color: GOLD_T, outline: "#2A1E00" });
      }
    },
  });
})();
