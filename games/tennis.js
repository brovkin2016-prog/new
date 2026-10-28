/* Теннис — a floodlit court at night under the aurora. You against the computer: a short set (first to 4 games, a
   point is first to 4, no advantage) in the «Кубок» of seven matches, or the endless «Тренировка» (points on the board).
   Seen from behind the near baseline with the court in perspective; the ball has a real height, a shadow, a bounce and
   spin that comes from when you press. Written against the Winger Games engine (engine.js, ENGINE.md). */
"use strict";
(function () {
  const { art } = WG;
  const clamp = WG.util.clamp, lerp = WG.util.lerp;
  const W = 384, H = 216;

  // ---------- the world: metres on the court, projected onto the 384×216 screen ----------
  // x across (−left … +right as the near player sees it), z along (−far … +near), y up. The near baseline is z = +HL.
  const HL = 11.885, HW = 4.115, SBOX = 6.4, NETH = 0.914, POST = 5.03;
  const ZCAM = 50.66, MPP0 = 34, D0 = ZCAM - HL, FOC = MPP0 * D0, CX = 192;
  const Y_NEAR = 183, Y_FAR = 62;
  const KG = (Y_NEAR - Y_FAR) / (1 / D0 - 1 / (ZCAM + HL));
  const HOR = Y_NEAR - KG / D0;
  const HK = 0.62; // pixels per metre of height, relative to those across
  const mpp = (z) => FOC / (ZCAM - z);
  const gy = (z) => HOR + KG / (ZCAM - z);
  const G = 9.8, SPINK = 3.0, BALL_R = 0.11;
  const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.2831853 * v); };
  const rand = (a, b) => a + Math.random() * (b - a);
  const sgn = (v) => (v < 0 ? -1 : 1);
  const netTop = (x) => NETH + 0.156 * Math.pow(Math.min(1, Math.abs(x) / POST), 2);

  // ---------- colour helpers ----------
  const hexRGB = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const rgbHex = (r, g, b) => "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const toneCache = {};
  // k < 1 darker (with a cool shadow), k > 1 lighter
  function tone(c, k) {
    const key = c + "|" + k;
    if (toneCache[key]) return toneCache[key];
    const [r, g, b] = hexRGB(c);
    const o = k < 1 ? rgbHex(r * k * 0.96, g * k, b * Math.min(1.25, k * 1.12 + 0.04)) : rgbHex(r + (255 - r) * (k - 1), g + (255 - g) * (k - 1), b + (255 - b) * (k - 1));
    return (toneCache[key] = o);
  }
  const BAY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  const hash = (x, y) => { let h = (Math.imul(x + 101, 73856093) ^ Math.imul(y + 211, 19349663)) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; return (h >>> 8) / 16777216; };

  // ---------- the people ----------
  const LOOKS = {
    me: { skin: "#F0C29B", hair: "#2B1B12", shirt: "#34D399", trim: "#D8FFE9", shorts: "#0B4A33", shoe: "#F4FAFF", sock: "#F4FAFF", racket: "#34D399", hairStyle: "short", band: "#D8FFE9" },
    tima: { skin: "#F2CBA6", hair: "#D9A441", shirt: "#FFD27A", trim: "#FFF0C2", shorts: "#46516F", shoe: "#F4FAFF", sock: "#F4FAFF", racket: "#FFD27A", hairStyle: "short" },
    sonya: { skin: "#E9B98F", hair: "#5B3A22", shirt: "#C4BBFF", trim: "#EDE9FF", shorts: "#4B3BA8", shoe: "#F4FAFF", sock: "#EDE9FF", racket: "#8B7CF6", hairStyle: "pony", skirt: true, band: "#8B7CF6" },
    grisha: { skin: "#C98F5E", hair: "#1A1210", shirt: "#FF6B7A", trim: "#FFC2C9", shorts: "#3D0C17", shoe: "#F4FAFF", sock: "#FFC2C9", racket: "#FF6B7A", hairStyle: "short", band: "#FFC2C9" },
    alisa: { skin: "#F2CBA6", hair: "#E0A24A", shirt: "#FF9AAE", trim: "#FFE1E5", shorts: "#8E1F35", shoe: "#F4FAFF", sock: "#FFE1E5", racket: "#FF6B7A", hairStyle: "pony", skirt: true, cap: "#FF6B7A" },
    max: { skin: "#8D5A3B", hair: "#120C0A", shirt: "#FF9F43", trim: "#FFE1B8", shorts: "#2A1E00", shoe: "#F4FAFF", sock: "#FFE1B8", racket: "#FF9F43", hairStyle: "short", cap: "#FF9F43" },
    rita: { skin: "#F0C29B", hair: "#EFE7D2", shirt: "#22B8CF", trim: "#D2FAFF", shorts: "#0B3B4A", shoe: "#F4FAFF", sock: "#D2FAFF", racket: "#7FE6F4", hairStyle: "long", skirt: true, band: "#D2FAFF" },
    lev: { skin: "#E3B188", hair: "#C9D6F2", shirt: "#252C45", trim: "#FFD27A", shorts: "#1B2133", shoe: "#FFF0C2", sock: "#FFD27A", racket: "#FFD27A", hairStyle: "short", cap: "#252C45" },
  };
  // the seven of the cup, each stronger and each playing in their own way
  const OPPS = [
    { name: "Тима", title: "Новичок", sk: 0.05, style: "novice", look: "tima", tip: "Только учится: бегает неспеша и часто бьёт мимо." },
    { name: "Соня", title: "Дворовая", sk: 0.2, style: "steady", look: "sonya", tip: "Бьёт аккуратно в центр и ждёт твоей ошибки." },
    { name: "Гриша", title: "Силач", sk: 0.34, style: "power", look: "grisha", tip: "Лупит изо всех сил — и нередко мимо корта." },
    { name: "Алиса", title: "Сетка", sk: 0.5, style: "net", look: "alisa", tip: "Рвётся к сетке и играет укороченные." },
    { name: "Макс", title: "Стена", sk: 0.62, style: "wall", look: "max", tip: "Достаёт всё подряд. Пробей свечой или в угол." },
    { name: "Рита", title: "Королева корта", sk: 0.8, style: "allcourt", look: "rita", tip: "Играет умно: гоняет тебя по углам." },
    { name: "Лев", title: "Мастер", sk: 0.97, style: "master", look: "lev", tip: "Быстрый, точный и хитрый. Удачи!" },
  ];
  const TRAIN = { name: "Тренер", title: "Тренировка", style: "allcourt", look: "max" };

  // ---------- the court, drawn once with perspective, lines and dithered light ----------
  const OFFX = 16;
  function paintCourt() {
    const CW = W + OFFX * 2, c = WG.canvas(CW, H), g = c.getContext("2d");
    const img = g.createImageData(CW, H), d = img.data;
    const COURT = ["#0A2F4A", "#0C3F61", "#0F5078", "#136290", "#1A76A6", "#2389BB"].map(hexRGB);
    const APRON = ["#0A2A25", "#0D3A31", "#114A3D", "#175C4C", "#1F705C", "#2A856C"].map(hexRGB);
    const LINE = ["#8FA9C2", "#B7CCE0", "#DCEAF6", "#F4FAFF"].map(hexRGB);
    const WALL = ["#080D1C", "#0C1428", "#111B36"].map(hexRGB);
    const lineRows = [HL, -HL, SBOX, -SBOX].map((z) => gy(z));
    for (let y = 42; y < H; y++) {
      const dd = KG / (y + 0.5 - HOR), Z = ZCAM - dd, m = FOC / dd;
      const u = clamp((Z + HL) / (2 * HL), 0, 1);
      const hwx = (0.52 + 0.5 * u) / m; // half the width of a vertical line, in metres
      const thick = 0.78 + 0.42 * u;
      const rowLine = lineRows.map((ly) => Math.abs(y + 0.5 - ly) <= thick);
      const nearBase = rowLine[0] || rowLine[1], nearSvc = rowLine[2] || rowLine[3];
      for (let xs = 0; xs < CW; xs++) {
        const X = (xs - OFFX + 0.5 - CX) / m;
        const ax = Math.abs(X), az = Math.abs(Z);
        const inCourt = ax <= HW + hwx && az <= HL + 0.03;
        const inApron = ax <= 8.3 && az <= 18.6;
        let col;
        let b = 0.5 + 0.5 * Math.exp(-(X * X / 58 + (Z + 0.5) * (Z + 0.5) / 330));
        b += 0.09 * Math.exp(-((ax - 7) * (ax - 7) / 14 + (az - 15) * (az - 15) / 16));
        b *= 0.9 + 0.1 * (1 - az / 20);
        if (!inApron) {
          // the low wall at the side of the apron
          const edge = ax - 8.3;
          const wi = edge < 0.35 ? 2 : (y + xs) & 1 && edge < 1.2 ? 1 : 0;
          col = WALL[wi];
          if (edge < 0.12) col = [0x2C, 0x35, 0x50];
        } else {
          let t = clamp((b - 0.42) / 0.62, 0, 1);
          const wear = 1 - 0.1 * Math.exp(-(X * X / 7 + (az - 11.3) * (az - 11.3) / 1.4));
          t *= wear * (inCourt ? 1 : 0.84);
          const ramp = inCourt ? COURT : APRON;
          const v = t * (ramp.length - 1), base = Math.floor(v);
          let idx = base + (v - base > BAY[(y & 3) * 4 + (xs & 3)] ? 1 : 0);
          const n = hash(xs, y);
          if (n < 0.014) idx -= 1; else if (n > 0.986) idx += 1;
          col = ramp[clamp(idx, 0, ramp.length - 1)];
          // the white lines
          let on = false;
          if (az <= HL + 0.05) {
            if (Math.abs(ax - HW) <= hwx) on = true;                              // sidelines
            if (ax <= 0.001 + hwx && az <= SBOX) on = true;                       // centre service line
            if (ax <= hwx && az >= HL - 0.35) on = true;                          // centre marks
          }
          if (ax <= HW + hwx && (nearBase && az > HL - 1.2 || nearSvc && az < SBOX + 1.2 && az > SBOX - 1.2)) on = true;
          if (on) col = LINE[clamp(Math.floor(t * 3.99 + 0.35), 0, 3)];
        }
        const k = (y * CW + xs) * 4;
        d[k] = col[0]; d[k + 1] = col[1]; d[k + 2] = col[2]; d[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    // a few ball marks and scuffs worn into the court near the baselines
    const rnd = WG.rng(77);
    for (let i = 0; i < 70; i++) {
      const Z = (rnd() < 0.5 ? -1 : 1) * (rnd() * 9 + 2.5), X = (rnd() - 0.5) * 8;
      const px = Math.round(CX + OFFX + X * mpp(Z)), py = Math.round(gy(Z));
      g.fillStyle = rnd() < 0.5 ? "rgba(220,236,248,.07)" : "rgba(4,10,24,.14)";
      g.fillRect(px, py, 1 + (rnd() < 0.5 ? 1 : 0), 1);
    }
    return c;
  }

  // ---------- the stands, the ad boards and the floodlight masts behind the far baseline ----------
  const CROWD_COLORS = ["#7C4DB5", "#C85A6A", "#3A8FB5", "#D9A441", "#5BAE8F", "#B8C4D8", "#8F7A66", "#E8E1D0", "#4B3BA8", "#2F6FA0"];
  const SKINS = ["#F0C29B", "#E3B188", "#C98F5E", "#8D5A3B", "#F2CBA6"];
  const BOARDS = [
    ["ВИНГЕР", "#0B4A33", "#8EF0C6"], ["АВРОРА", "#21194A", "#C4BBFF"], ["СЕВЕР", "#0B3B4A", "#7FE6F4"], ["ЧАЙ", "#6B4A0A", "#FFF0C2"],
    ["ВИНГЕР", "#0B4A33", "#8EF0C6"], ["ПОЛЮС", "#3D0C17", "#FFC2C9"], ["АВРОРА", "#21194A", "#C4BBFF"], ["СЕВЕР", "#0B3B4A", "#7FE6F4"],
  ];
  const STAND_TOP = 15, BOARD_Y = 37;
  function paintStands(excited) {
    const c = WG.canvas(W, 46), g = c.getContext("2d");
    const rnd = WG.rng(excited ? 4141 : 4141); // the same crowd, raised arms on the second picture
    // the mountains and pines behind the roof
    art.ridge(g, 0, 16, W, 11, "#0F1B3D", 3, 22, 0.1);
    art.ridge(g, 0, 17, W, 6, "#0B1330", 8, 22, 0.05);
    art.pines(g, 0, 17, W, "#070D22", 12, 3, 7, 4);
    // roof edge with its row of lamps
    g.fillStyle = "#0A0E1D"; g.fillRect(0, STAND_TOP - 3, W, 4);
    g.fillStyle = "#1D2944"; g.fillRect(0, STAND_TOP - 3, W, 1);
    g.fillStyle = "#06091A"; g.fillRect(0, STAND_TOP + 1, W, 1);
    for (let x = 4; x < W; x += 8) { g.fillStyle = "#FFF4C8"; g.fillRect(x, STAND_TOP, 2, 1); g.fillStyle = "rgba(255,244,200,.25)"; g.fillRect(x - 1, STAND_TOP + 1, 4, 1); }
    // the dark back wall of the stands, lit from below by the court
    art.bands(g, 0, STAND_TOP + 2, W, BOARD_Y - STAND_TOP - 2, ["#090D1F", "#10173A", "#1A2150"]);
    // tiers of spectators, the nearest row drawn last
    const rows = [16, 19, 22, 25, 28, 31, 34];
    rows.forEach((y, ri) => {
      g.fillStyle = ri % 2 ? "#161C3E" : "#12183A"; g.fillRect(0, y + 3, W, 1);
      const lit = 0.55 + ri * 0.075;
      for (let x = 1 + (ri % 3); x < W - 2; x += 3 + ((x * 7 + ri) % 3 === 0 ? 1 : 0)) {
        if (rnd() < 0.1) continue;
        const shirt = CROWD_COLORS[(rnd() * CROWD_COLORS.length) | 0], skin = SKINS[(rnd() * SKINS.length) | 0];
        const up = excited && rnd() < 0.45 ? 1 : 0;
        g.fillStyle = tone(shirt, 0.5 + lit * 0.45); g.fillRect(x - 1, y + 2 - up, 4, 2 + up);
        g.fillStyle = tone(skin, 0.45 + lit * 0.4); g.fillRect(x, y - up, 2, 2);
        if (rnd() < 0.18) { g.fillStyle = tone(["#1B2133", "#8E1F35", "#0B4A33", "#C98A1B"][(rnd() * 4) | 0], 0.8); g.fillRect(x, y - 1 - up, 2, 1); }
        if (up) { g.fillStyle = tone(skin, 0.7); g.fillRect(x - 1, y - 2, 1, 2); if (rnd() < 0.5) g.fillRect(x + 2, y - 2, 1, 2); }
        if (rnd() < 0.05) { g.fillStyle = "#FFD27A"; g.fillRect(x + 1, y + 1, 1, 1); }
      }
    });
    // pillars
    for (const x of [0, 95, 191, 288, 381]) { g.fillStyle = "#0A0E1D"; g.fillRect(x, STAND_TOP + 1, 3, BOARD_Y - STAND_TOP); g.fillStyle = "#1D2944"; g.fillRect(x, STAND_TOP + 1, 1, BOARD_Y - STAND_TOP); }
    // ad boards along the far wall
    g.fillStyle = "#06091A"; g.fillRect(0, BOARD_Y - 1, W, 9);
    const bw = 48;
    for (let i = 0; i * bw < W; i++) {
      const [txt, bg, fg] = BOARDS[i % BOARDS.length];
      g.fillStyle = bg; g.fillRect(i * bw + 1, BOARD_Y, bw - 2, 7);
      g.fillStyle = tone(bg, 1.28); g.fillRect(i * bw + 1, BOARD_Y, bw - 2, 1);
      g.fillStyle = tone(bg, 0.6); g.fillRect(i * bw + 1, BOARD_Y + 6, bw - 2, 1);
      WG.text(g, txt, i * bw + 1 + Math.floor((bw - 2 - WG.textWidth(txt)) / 2), BOARD_Y, { color: fg });
    }
    g.fillStyle = "#26324F"; g.fillRect(0, BOARD_Y + 7, W, 1);
    return c;
  }
  function paintMasts() {
    const c = WG.canvas(W, 46), g = c.getContext("2d");
    for (const mx of [13, 370]) {
      // lattice mast
      g.fillStyle = "#0A0E1D"; g.fillRect(mx, 8, 2, 38); g.fillRect(mx + 5, 8, 2, 38);
      for (let y = 10; y < 44; y += 6) { g.fillStyle = "#1D2944"; for (let i = 0; i < 5; i++) g.fillRect(mx + 1 + i, y + (((y / 6) | 0) % 2 ? i : 4 - i), 1, 1); }
      g.fillStyle = "#26324F"; g.fillRect(mx - 1, 44, 9, 2);
      // the lamp bank
      art.dither(g, mx - 12, -6, 31, 24, null, "rgba(255,240,194,.30)", 0.4);
      art.dither(g, mx - 7, -2, 21, 15, null, "rgba(255,240,194,.35)", 0.5);
      g.fillStyle = "#0A0E1D"; g.fillRect(mx - 3, 2, 13, 8);
      g.fillStyle = "#26324F"; g.fillRect(mx - 3, 2, 13, 1);
      for (let j = 0; j < 2; j++) for (let i = 0; i < 4; i++) { g.fillStyle = "#FFF9DD"; g.fillRect(mx - 2 + i * 3, 3 + j * 3, 2, 2); g.fillStyle = "#FFD27A"; g.fillRect(mx - 2 + i * 3, 4 + j * 3, 2, 1); }
    }
    return c;
  }

  // ---------- the net with its posts (drawn once), the umpire's chair ----------
  function paintNet() {
    const m = mpp(0), half = Math.round(POST * m), y0 = Math.round(gy(0));
    const NW = half * 2 + 12, NHt = Math.ceil(1.14 * m * HK) + 8;
    const c = WG.canvas(NW, NHt), g = c.getContext("2d");
    const ox = half + 6, base = NHt - 5; // the ground line inside the canvas
    const hp = (h) => Math.round(h * m * HK);
    // the soft shadow it throws on the court
    art.dither(g, 6, base + 1, NW - 12, 3, null, "rgba(0,8,20,.55)", 0.55);
    // the mesh
    for (let x = -half; x <= half; x++) {
      const top = hp(netTop(x / m)), bot = hp(0.05);
      for (let y = bot; y <= top - 2; y++) {
        const sx = ox + x, sy = base - y;
        const diag = (x + y * 2 + 300) % 4 === 0 || (x - y * 2 + 300) % 4 === 0;
        g.fillStyle = diag ? "rgba(170,196,224,.55)" : "rgba(6,12,30,.5)";
        g.fillRect(sx, sy, 1, 1);
      }
      // the white top tape and the dark cable at the bottom
      g.fillStyle = "#EAF0FA"; g.fillRect(ox + x, base - top, 1, 2);
      g.fillStyle = "#9AA5C0"; g.fillRect(ox + x, base - top + 2, 1, 1);
      g.fillStyle = "#0A0F1E"; g.fillRect(ox + x, base - bot, 1, 1);
    }
    // the centre strap
    g.fillStyle = "#EAF0FA"; g.fillRect(ox - 1, base - hp(NETH) + 2, 2, hp(NETH) - hp(0.05) - 2);
    g.fillStyle = "#9AA5C0"; g.fillRect(ox + 1, base - hp(NETH) + 2, 1, hp(NETH) - hp(0.05) - 2);
    // the posts
    for (const sd of [-1, 1]) {
      const px = ox + sd * half - 1, top = hp(netTop(POST) + 0.1);
      g.fillStyle = "#0A0F1E"; g.fillRect(px - 1, base - top, 5, top + 2);
      g.fillStyle = "#46516F"; g.fillRect(px, base - top + 1, 3, top + 1);
      g.fillStyle = "#9AA5C0"; g.fillRect(px, base - top + 1, 1, top + 1);
      g.fillStyle = "#2C3550"; g.fillRect(px + 2, base - top + 1, 1, top + 1);
      g.fillStyle = "#EAF0FA"; g.fillRect(px, base - top, 3, 1);
    }
    return { c, ox, oy: base, y0, half };
  }
  const UMP = WG.sprite([
    "..kkkk..",
    ".kcccck.",
    ".kssssk.",
    ".ksesek.",
    "..kssk..",
    ".kwwwwk.",
    "kwwwwwwk",
    "kwwwwwwk",
    ".kwwwwk.",
    ".kbbbbk.",
  ], { k: "#0A0F1E", c: "#34D399", s: "#F0C29B", e: "#2B1B12", w: "#EAF0FA", b: "#46516F" });
  function paintChair() {
    const c = WG.canvas(18, 38), g = c.getContext("2d");
    g.fillStyle = "#0A0F1E";
    g.fillRect(2, 18, 2, 20); g.fillRect(14, 18, 2, 20); g.fillRect(2, 18, 14, 3);
    g.fillStyle = "#6B7694"; g.fillRect(3, 19, 1, 19); g.fillRect(14, 19, 1, 19); g.fillRect(3, 19, 12, 1);
    g.fillStyle = "#46516F"; for (let i = 0; i < 16; i++) { g.fillRect(4 + (i * 10 / 16 | 0), 22 + i, 1, 1); g.fillRect(13 - (i * 10 / 16 | 0), 22 + i, 1, 1); }
    g.fillStyle = "#0A0F1E"; g.fillRect(0, 16, 18, 4);
    g.fillStyle = "#2476B4"; g.fillRect(1, 16, 16, 2); g.fillStyle = "#7FE6F4"; g.fillRect(1, 16, 16, 1);
    g.fillStyle = "#0A0F1E"; g.fillRect(2, 8, 14, 9);
    g.drawImage(UMP, 5, 6);
    // the little desk with its screen
    g.fillStyle = "#0A0F1E"; g.fillRect(0, 12, 5, 4); g.fillStyle = "#34D399"; g.fillRect(1, 13, 3, 2);
    return c;
  }

  // ---------- the player: a figure built from pixel tubes, so it can run, stretch and swing smoothly ----------
  const OUT = "#070B18";
  const FIG = 0.92; // the whole figure's size
  const BASE = { hy: 16.4, sx: 0, sy: 0, rhx: 3.8, rhy: 19.0, lhx: -1.0, lhy: 20.4, ra: 8, rl: 0.95, lfx: -3.6, lfy: 0, rfx: 3.6, rfy: 0, hdx: 0, hdy: 0, two: 0 };
  const POSE = (o) => Object.assign({}, BASE, o);
  const POSES = {
    ready: POSE({}),
    wind: POSE({ hy: 15.2, sx: 1.6, sy: 0.3, rhx: 10.6, rhy: 24.2, ra: 58, rl: 0.55, lhx: -3.2, lhy: 24.0, lfx: -3.2, lfy: 1.4, rfx: 5.4, rfy: 0, hdx: 0.8 }),
    hit: POSE({ hy: 14.6, sx: -0.6, sy: -0.2, rhx: 7.2, rhy: 18.2, ra: -64, rl: 1, lhx: -4.8, lhy: 23.2, lfx: -4.6, lfy: 2.4, rfx: 5.6, rfy: -0.4, hdx: -0.4 }),
    follow: POSE({ hy: 15.6, sx: -2, sy: 0.6, rhx: -5.4, rhy: 29.6, ra: 26, rl: 0.8, lhx: -8.8, lhy: 25.6, lfx: -4.0, lfy: 0, rfx: 3.4, rfy: 1.4, hdx: -1.1 }),
    // a deep, low reach (for the drop shot and the low ball)
    low: POSE({ hy: 11.5, sx: 1.2, sy: -0.6, rhx: 9.4, rhy: 9.0, ra: -78, rl: 1, lhx: -3.4, lhy: 17.4, lfx: -5.2, lfy: 0, rfx: 6.0, rfy: -0.8, hdy: -0.6 }),
    toss: POSE({ hy: 15.6, sx: 0, rhx: 7.2, rhy: 24.6, ra: 95, rl: 0.42, lhx: -2.6, lhy: 38.6, lfx: -3.6, lfy: 0, rfx: 3.6, rfy: 0, hdy: 0.3 }),
    trophy: POSE({ hy: 13.8, sx: 0.8, sy: 0.4, rhx: 7.6, rhy: 33.8, ra: 158, rl: 0.5, lhx: -3.2, lhy: 38.4, lfx: -3.8, lfy: 0, rfx: 3.8, rfy: 0 }),
    smash: POSE({ hy: 16.9, sx: 0.4, sy: 0.7, rhx: 2.8, rhy: 45.0, ra: 6, rl: 1, lhx: -4.4, lhy: 31.6, lfx: -3.6, lfy: 2.6, rfx: 3.8, rfy: 3.0, hdy: 0.4 }),
    sfollow: POSE({ hy: 15.2, sx: -1.6, sy: -0.4, rhx: -5.4, rhy: 23.6, ra: -72, rl: 0.9, lhx: -6.4, lhy: 26.2, lfx: -3.4, lfy: 0.6, rfx: 3.6, rfy: 1.6, hdx: -0.6 }),
    cheer: POSE({ hy: 16.4, rhx: 7.6, rhy: 42.2, ra: 14, rl: 1, lhx: -7.4, lhy: 40.8, lfx: -4.0, rfx: 4.0 }),
    sad: POSE({ hy: 15.2, sy: -2.2, rhx: 4.4, rhy: 12.6, ra: 152, rl: 1, lhx: -3.4, lhy: 14.2, lfx: -3.4, rfx: 3.4, hdy: -1.6 }),
  };
  const PKEYS = Object.keys(BASE);
  function mixPose(a, b, k) { const o = {}; for (const key of PKEYS) o[key] = a[key] + (b[key] - a[key]) * k; return o; }
  function mirrorPose(p) {
    return Object.assign({}, p, { sx: -p.sx, rhx: -p.rhx, lhx: -p.lhx, ra: -p.ra, lfx: -p.rfx, rfx: -p.lfx, lfy: p.rfy, rfy: p.lfy, hdx: -p.hdx });
  }
  const easeIO = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

  function limb(g, pts, r, fill, U) {
    g.save();
    art.tube(g, pts, { r: Math.max(1.5, Math.round(r * U * 2) / 2), outline: OUT, fill, shade: tone(fill, 0.72), light: tone(fill, 1.3) });
    g.restore();
  }
  // two-bone leg or arm: returns [root, joint, end]
  function ik(root, end, l1, l2, bend) {
    let dx = end[0] - root[0], dy = end[1] - root[1];
    let d = Math.hypot(dx, dy) || 0.001;
    const ux = dx / d, uy = dy / d;
    d = Math.min(d, l1 + l2 - 0.15);
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    let nx = -uy, ny = ux;
    if (nx * bend[0] + ny * bend[1] < 0) { nx = -nx; ny = -ny; }
    return [root, [root[0] + ux * a + nx * h, root[1] + uy * a + ny * h], [root[0] + ux * d, root[1] + uy * d]];
  }
  function ringPoints(cx, cy, ax, ay, bx, by, rx, ry, n) {
    const out = [];
    for (let i = 0; i < n; i++) { const t = (i / n) * 6.2832; out.push([cx + ax * ry * Math.cos(t) + bx * rx * Math.sin(t), cy + ay * ry * Math.cos(t) + by * rx * Math.sin(t)]); }
    return out;
  }
  function drawRacket(g, hx, hy, ang, rl, U, S, col) {
    const a = (ang * Math.PI) / 180;
    const dx = Math.sin(a) * S, dy = -Math.cos(a);
    const px = -dy, py = dx;
    const gl = 5.6 * U * Math.max(0.5, rl), ry = 5.3 * U * Math.max(0.55, rl), rx = 3.7 * U;
    const tx = hx + dx * gl, ty = hy + dy * gl;
    const cx = tx + dx * ry, cy = ty + dy * ry;
    // the grip and the throat
    g.fillStyle = OUT;
    const n = Math.max(2, Math.ceil(gl));
    for (let i = 0; i <= n; i++) g.fillRect(Math.round(hx + (tx - hx) * i / n) - 1, Math.round(hy + (ty - hy) * i / n) - 1, 3, 3);
    const ring = ringPoints(cx, cy, dx, dy, px, py, rx, ry, 34);
    for (const [x, y] of ring) g.fillRect(Math.round(x) - 1, Math.round(y) - 1, 3, 3);
    g.fillStyle = "#3A4466";
    for (let i = 0; i <= n; i++) g.fillRect(Math.round(hx + (tx - hx) * i / n), Math.round(hy + (ty - hy) * i / n), 1, 1);
    // the strings: a faint lattice inside the frame
    for (let j = -Math.floor(ry); j <= ry; j++) for (let i = -Math.floor(rx); i <= rx; i++) {
      if ((i + j) & 1) continue;
      if ((i * i) / (rx * rx) + (j * j) / (ry * ry) > 0.8) continue;
      g.fillStyle = "rgba(214,236,250,.5)";
      g.fillRect(Math.round(cx + dx * j + px * i), Math.round(cy + dy * j + py * i), 1, 1);
    }
    g.fillStyle = col;
    for (const [x, y] of ring) g.fillRect(Math.round(x), Math.round(y), 1, 1);
    g.fillStyle = tone(col, 1.5);
    for (let i = 0; i < 6; i++) { const [x, y] = ring[(i + 28) % 34]; g.fillRect(Math.round(x), Math.round(y), 1, 1); }
  }
  // view = +1: seen from behind (the near player); −1: seen from the front (the far one, whose right hand is on our left)
  function drawFigure(g, L, view, X, Y, sc, P, extra) {
    const U = sc * FIG, S = view;
    X = Math.round(X); Y = Math.round(Y);
    const pt = (lx, ly) => ({ x: X + S * lx * U, y: Y - ly * U });
    const pa = (a) => a.map((q) => pt(q[0], q[1]));
    const skin = L.skin, hair = L.hair;
    // the shadow
    art.ellipse(g, X, Y + 1, Math.round(8.4 * U), Math.max(2, Math.round(2.7 * U)), "rgba(2,8,20,.45)");
    art.ellipse(g, X, Y + 1, Math.round(5.6 * U), Math.max(1, Math.round(1.7 * U)), "rgba(2,8,20,.35)");
    const hy = P.hy;
    const hipL = [-2.5, hy], hipR = [2.5, hy];
    const fL = [P.lfx, P.lfy], fR = [P.rfx, P.rfy];
    // legs, back one first
    const legs = [[hipL, fL, -1], [hipR, fR, 1]].sort((a, b) => b[1][1] - a[1][1]);
    for (const [hip, foot, side] of legs) {
      const chain = ik(hip, foot, [side, 0.35], 8.2, 8.6);
      limb(g, pa([chain[0], chain[1]]), 2.4, skin, U);
      limb(g, pa([chain[1], chain[2]]), 2.1, skin, U);
      limb(g, pa([[chain[2][0], chain[2][1] + 3.6], chain[2]]), 2.35, L.sock, U);
      const f = pt(foot[0] + side * 0.5, foot[1] + 0.2);
      art.ellipse(g, f.x, f.y, Math.round(3.2 * U + 1), Math.max(2, Math.round(1.9 * U + 0.5)), OUT);
      art.ellipse(g, f.x, f.y, Math.round(3.2 * U), Math.max(1, Math.round(1.7 * U - 0.3)), L.shoe);
      g.fillStyle = tone(L.shoe, 0.6); g.fillRect(Math.round(f.x - 2 * U), Math.round(f.y + 1), Math.max(2, Math.round(4 * U)), 1);
    }
    // shorts or skirt
    if (L.skirt) {
      const top = pt(0, hy + 1.2), bot = pt(0, hy - 4.6);
      const rows = Math.max(3, Math.round(bot.y - top.y));
      for (let j = 0; j <= rows; j++) {
        const w = Math.round((4.2 + (j / rows) * 3.2) * U);
        g.fillStyle = OUT; g.fillRect(Math.round(top.x - w - 1), Math.round(top.y + j), w * 2 + 3, 1);
      }
      for (let j = 0; j <= rows; j++) {
        const w = Math.round((4.2 + (j / rows) * 3.2) * U);
        g.fillStyle = j === rows ? tone(L.shorts, 0.7) : j > rows - 2 ? tone(L.shorts, 1.18) : L.shorts;
        g.fillRect(Math.round(top.x - w), Math.round(top.y + j), w * 2 + 1, 1);
      }
      g.fillStyle = L.trim; g.fillRect(Math.round(top.x - 4 * U), Math.round(bot.y), Math.max(1, Math.round(8 * U)), 1);
    } else {
      for (const [hip, , side] of legs) limb(g, pa([[hip[0] + side * 0.1, hy + 0.9], [hip[0] + side * 0.5, hy - 4.4]]), 3.0, L.shorts, U);
    }
    // torso: tapered from the shoulders to the waist
    const shY = hy + 11.7 + P.sy, shX = P.sx;
    limb(g, pa([[shX, shY - 0.2], [shX * 0.5, hy + 2.6], [0, hy + 0.4]]), 4.4, L.shirt, U);
    limb(g, pa([[shX - 3.6, shY - 0.4], [shX + 3.6, shY - 0.4]]), 2.7, L.shirt, U);
    // a stripe of trim down the back or across the chest
    const tl = pt(shX - 3.4, shY - 3), tr = pt(shX + 3.4, shY - 3);
    g.fillStyle = L.trim;
    if (view > 0) {
      for (let j = 0; j < Math.round(5 * U); j++) { g.fillRect(Math.round(pt(shX * (1 - j / 8), shY - 2.2).x), Math.round(pt(0, shY - 1.2).y) + j, 1, 1); }
    } else {
      g.fillRect(Math.round(Math.min(tl.x, tr.x)), Math.round(tl.y), Math.max(2, Math.round(Math.abs(tr.x - tl.x))), 1);
    }
    // arms
    const sR = [shX + 5.2, shY - 0.6], sLf = [shX - 5.2, shY - 0.6];
    const handR = [P.rhx, P.rhy], handL = [P.lhx, P.lhy];
    const armR = ik(sR, handR, 5.7, 6.1, [0.8, -1]), armL = ik(sLf, handL, 5.7, 6.1, [-0.8, -1]);
    const drawArm = (arm, side) => {
      limb(g, pa([arm[1], arm[2]]), 1.9, skin, U);
      limb(g, pa([arm[0], arm[1]]), 2.4, L.shirt, U);
      const hd = pt(arm[2][0], arm[2][1]);
      art.disc(g, hd.x, hd.y, Math.max(1.5, 1.45 * U), skin);
    };
    const racketNow = () => { const hd = pt(handR[0], handR[1]); drawRacket(g, hd.x, hd.y, P.ra, P.rl, U, S, L.racket); };
    if (view > 0) {
      drawArm(armL, -1);
      drawHead();
      racketNow(); drawArm(armR, 1);
    } else {
      drawHead();
      drawArm(armL, -1);
      racketNow(); drawArm(armR, 1);
    }
    function drawHead() {
      const c = pt(shX * 0.7 + P.hdx, shY + 5.9 + P.hdy);
      // neck
      art.disc(g, c.x, c.y + 4.3 * U, Math.max(1.5, 1.9 * U), OUT);
      art.disc(g, c.x, c.y + 4.3 * U, Math.max(1, 1.5 * U), tone(skin, 0.85));
      const R = 4.5 * U;
      art.disc(g, c.x, c.y, R + 1, OUT);
      if (view > 0) {
        art.disc(g, c.x, c.y, R, hair);
        art.disc(g, c.x - 0.5, c.y - 0.5, R - 1, tone(hair, 1.0));
        g.fillStyle = tone(hair, 1.45); g.fillRect(Math.round(c.x - R * 0.55), Math.round(c.y - R * 0.6), Math.max(1, Math.round(R * 0.7)), 1);
        g.fillStyle = skin; g.fillRect(Math.round(c.x - R), Math.round(c.y + 0.5), 1, Math.max(1, Math.round(1.6 * U))); g.fillRect(Math.round(c.x + R - 1), Math.round(c.y + 0.5), 1, Math.max(1, Math.round(1.6 * U)));
        if (L.cap) {
          art.disc(g, c.x, c.y - R * 0.12, R * 0.98, L.cap);
          g.fillStyle = OUT; g.fillRect(Math.round(c.x - R), Math.round(c.y + R * 0.18), Math.round(R * 2) + 1, 1);
          g.fillStyle = tone(L.cap, 1.35); g.fillRect(Math.round(c.x - R * 0.5), Math.round(c.y - R * 0.7), Math.max(1, Math.round(R * 0.6)), 1);
          g.fillStyle = tone(L.cap, 0.7); g.fillRect(Math.round(c.x - R + 1), Math.round(c.y + R * 0.18) + 1, Math.round(R * 2) - 1, 1);
        } else if (L.band) {
          g.fillStyle = L.band; g.fillRect(Math.round(c.x - R + 1), Math.round(c.y - 0.5), Math.round(R * 2) - 1, Math.max(1, Math.round(1 * U)));
        }
        if (L.hairStyle === "pony" || L.hairStyle === "long") {
          const sw = (extra && extra.swing) || 0;
          const tail = L.hairStyle === "long" ? 8.5 : 6.4;
          limb(g, [{ x: c.x + sw * 0.4 * U, y: c.y + 1.6 }, { x: c.x + sw * 1.4 * U, y: c.y + 1.6 + tail * U * 0.6 }, { x: c.x + sw * 2.2 * U, y: c.y + 1.6 + tail * U }], L.hairStyle === "long" ? 2.6 : 1.6, hair, U);
        }
      } else {
        // the face looks at us
        art.disc(g, c.x, c.y, R, skin);
        art.disc(g, c.x - 0.5, c.y - 0.5, R - 1, tone(skin, 1.06));
        // hair over the top and the sides
        const hc = L.cap || hair;
        g.fillStyle = hair;
        for (let j = -Math.round(R); j <= Math.round(R * 0.15); j++) {
          const w = Math.sqrt(Math.max(0, R * R - j * j));
          if (j < -R * 0.3) g.fillRect(Math.round(c.x - w), Math.round(c.y + j), Math.round(w * 2), 1);
          else { g.fillRect(Math.round(c.x - w), Math.round(c.y + j), Math.max(1, Math.round(w * 0.32)), 1); g.fillRect(Math.round(c.x + w - w * 0.32), Math.round(c.y + j), Math.max(1, Math.round(w * 0.32)), 1); }
        }
        g.fillStyle = tone(hair, 1.4); g.fillRect(Math.round(c.x - R * 0.5), Math.round(c.y - R * 0.78), Math.max(1, Math.round(R * 0.5)), 1);
        if (L.cap) {
          for (let j = -Math.round(R); j <= Math.round(-R * 0.25); j++) { const w = Math.sqrt(Math.max(0, R * R - j * j)); g.fillStyle = L.cap; g.fillRect(Math.round(c.x - w), Math.round(c.y + j), Math.round(w * 2), 1); }
          const bw = Math.round(R * 1.7);
          g.fillStyle = OUT; g.fillRect(Math.round(c.x - bw / 2) - 1, Math.round(c.y - R * 0.25), bw + 2, 3);
          g.fillStyle = tone(L.cap, 1.2); g.fillRect(Math.round(c.x - bw / 2), Math.round(c.y - R * 0.25) + 1, bw, 1);
          g.fillStyle = tone(L.cap, 0.7); g.fillRect(Math.round(c.x - bw / 2), Math.round(c.y - R * 0.25) + 2, bw, 1);
        } else if (L.band) {
          g.fillStyle = L.band; g.fillRect(Math.round(c.x - R + 1), Math.round(c.y - R * 0.3), Math.round(R * 2) - 1, 1);
        }
        const ey = Math.round(c.y + R * 0.05), ex = Math.max(1, Math.round(R * 0.4));
        if (R > 3.1) {
          const blink = extra && extra.blink;
          g.fillStyle = "#0A0F1E";
          if (blink) { g.fillRect(Math.round(c.x - ex) - 1, ey + 1, 2, 1); g.fillRect(Math.round(c.x + ex), ey + 1, 2, 1); }
          else { g.fillRect(Math.round(c.x - ex), ey, 1, 2); g.fillRect(Math.round(c.x + ex), ey, 1, 2); }
          g.fillStyle = tone(skin, 0.6); g.fillRect(Math.round(c.x), ey + Math.max(1, Math.round(R * 0.4)), 1, 1);
          const mouth = extra && extra.mood;
          g.fillStyle = mouth === "sad" ? tone(skin, 0.55) : "#7A1830";
          if (mouth === "happy") { g.fillRect(Math.round(c.x) - 1, ey + Math.round(R * 0.62), 3, 1); g.fillStyle = "#FFFFFF"; g.fillRect(Math.round(c.x), ey + Math.round(R * 0.62), 1, 1); }
          else if (mouth === "sad") { g.fillRect(Math.round(c.x) - 1, ey + Math.round(R * 0.66), 3, 1); g.fillRect(Math.round(c.x) - 1, ey + Math.round(R * 0.66) + 1, 1, 1); g.fillRect(Math.round(c.x) + 1, ey + Math.round(R * 0.66) + 1, 1, 1); }
          else g.fillRect(Math.round(c.x), ey + Math.round(R * 0.62), 1, 1);
        } else {
          g.fillStyle = "#0A0F1E"; g.fillRect(Math.round(c.x - 1), Math.round(c.y), 1, 1); g.fillRect(Math.round(c.x + 1), Math.round(c.y), 1, 1);
        }
        if (L.hairStyle === "pony" || L.hairStyle === "long") {
          const sw = (extra && extra.swing) || 0;
          limb(g, [{ x: c.x - R * 0.95, y: c.y - R * 0.2 }, { x: c.x - R * 1.15 + sw * 0.6, y: c.y + R * 0.9 }], 1.5, hair, U);
          limb(g, [{ x: c.x + R * 0.95, y: c.y - R * 0.2 }, { x: c.x + R * 1.15 + sw * 0.6, y: c.y + R * 0.9 }], 1.5, hair, U);
        }
      }
      void hc;
    }
  }
  let COURT = null, STANDS = null, STANDS2 = null, MASTS = null, NET = null, CHAIR = null;
  WG.game({
    id: "tennis", portrait: false,
    controls: { dpad: true, a: "Удар", b: "Свеча", swipe: false, landscapeDpad: true },
    howto: "debug", keysHint: "debug",
    create(api) {
      if (!COURT) { COURT = paintCourt(); STANDS = paintStands(false); STANDS2 = paintStands(true); MASTS = paintMasts(); NET = paintNet(); CHAIR = paintChair(); }
      const S = { t: 0, dbg: { near: "ready", far: "ready", nx: 1.5, nz: 12.4, fx: -1, fz: -12.6 } };
      window.__dbg = S.dbg;
      return {
        _state: S,
        start() {},
        update(dt) { S.t += dt; },
        draw(g) {
          g.fillStyle = "#04070F"; g.fillRect(0, 0, W, H);
          art.sky(g, 0, 0, 384, 40, S.t, { seed: 7, top: "#04070F", bottom: "#142449", curtain: 0.5, amount: 1 });
          g.drawImage(COURT, -OFFX, 0);
          g.drawImage(STANDS, 0, 0);
          g.drawImage(MASTS, 0, 0);
          g.drawImage(CHAIR, 192 - Math.round(6.6 * mpp(0)) - 9, Math.round(gy(0)) - 36);
          const D = S.dbg;
          const L = LOOKS[D.farLook || "grisha"], L2 = LOOKS.me;
          drawFigure(g, L, -1, CX + D.fx * mpp(D.fz), gy(D.fz), mpp(D.fz) / MPP0, POSES[D.far] || mixPose(POSES.ready, POSES.wind, 0), {});
          g.drawImage(NET.c, CX - NET.ox, NET.y0 - NET.oy);
          drawFigure(g, L2, 1, CX + D.nx * mpp(D.nz), gy(D.nz), mpp(D.nz) / MPP0, POSES[D.near] || POSES.ready, {});
        },
      };
    },
  });
})();
