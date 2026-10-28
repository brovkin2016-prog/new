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
  const Y_NEAR = 190, Y_FAR = 67;
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
    { name: "Тима", gen: "Тимы", title: "Новичок", sk: 0.05, style: "novice", look: "tima", tip: "Только учится: бегает неспеша и часто бьёт мимо." },
    { name: "Соня", gen: "Сони", title: "Дворовая", sk: 0.2, style: "steady", look: "sonya", tip: "Бьёт аккуратно в центр и ждёт твоей ошибки." },
    { name: "Гриша", gen: "Гриши", title: "Силач", sk: 0.34, style: "power", look: "grisha", tip: "Лупит изо всех сил — и нередко мимо корта." },
    { name: "Алиса", gen: "Алисы", title: "Сетка", sk: 0.5, style: "net", look: "alisa", tip: "Рвётся к сетке и играет укороченные." },
    { name: "Макс", gen: "Макса", title: "Стена", sk: 0.62, style: "wall", look: "max", tip: "Достаёт всё подряд. Пробей свечой или в угол." },
    { name: "Рита", gen: "Риты", title: "Королева корта", sk: 0.8, style: "allcourt", look: "rita", tip: "Играет умно: гоняет тебя по углам." },
    { name: "Лев", gen: "Льва", title: "Мастер", sk: 0.97, style: "master", look: "lev", tip: "Быстрый, точный и хитрый. Удачи!" },
  ];
  const TRAIN = { name: "Тренер", gen: "Тренера", title: "Тренировка", style: "allcourt", look: "max" };

  // ---------- the court, drawn once with perspective, lines and dithered light ----------
  const OFFX = 16, PADX = 4;
  function paintCourt() {
    const CW = W + OFFX * 2, c = WG.canvas(CW, H), g = c.getContext("2d");
    const img = g.createImageData(CW, H), d = img.data;
    const COURT = ["#0A2F4A", "#0C3F61", "#0F5078", "#136290", "#1A76A6", "#2389BB"].map(hexRGB);
    const APRON = ["#0A2A25", "#0D3A31", "#114A3D", "#175C4C", "#1F705C", "#2A856C"].map(hexRGB);
    const LINE = ["#8FA9C2", "#B7CCE0", "#DCEAF6", "#F4FAFF"].map(hexRGB);
    const WALL = ["#080D1C", "#0C1428", "#111B36"].map(hexRGB);
    const lineRows = [HL, -HL, SBOX, -SBOX].map((z) => gy(z));
    for (let y = 40; y < H; y++) {
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
  const STAND_TOP = 14, BOARD_Y = 33;
  function paintStands(excited) {
    const WW = W + PADX * 2;
    const c = WG.canvas(WW, 46), g = c.getContext("2d");
    const rnd = WG.rng(excited ? 4141 : 4141); // the same crowd, raised arms on the second picture
    // the mountains and pines behind the roof
    art.ridge(g, 0, 16, WW, 11, "#0F1B3D", 3, 22, 0.1);
    art.ridge(g, 0, 17, WW, 6, "#0B1330", 8, 22, 0.05);
    art.pines(g, 0, 17, WW, "#070D22", 12, 3, 7, 4);
    // roof edge with its row of lamps
    g.fillStyle = "#0A0E1D"; g.fillRect(0, STAND_TOP - 3, WW, 4);
    g.fillStyle = "#1D2944"; g.fillRect(0, STAND_TOP - 3, WW, 1);
    g.fillStyle = "#06091A"; g.fillRect(0, STAND_TOP + 1, WW, 1);
    for (let x = 4; x < WW; x += 8) { g.fillStyle = "#FFF4C8"; g.fillRect(x, STAND_TOP, 2, 1); g.fillStyle = "rgba(255,244,200,.25)"; g.fillRect(x - 1, STAND_TOP + 1, 4, 1); }
    // the dark back wall of the stands, lit from below by the court
    art.bands(g, 0, STAND_TOP + 2, WW, BOARD_Y - STAND_TOP - 2, ["#090D1F", "#10173A", "#1A2150"]);
    // tiers of spectators, the nearest row drawn last
    const rows = [16, 19, 22, 25, 28];
    rows.forEach((y, ri) => {
      g.fillStyle = ri % 2 ? "#161C3E" : "#12183A"; g.fillRect(0, y + 3, WW, 1);
      const lit = 0.42 + ri * 0.1;
      for (let x = 1 + (ri % 3); x < WW - 2; x += 3 + ((x * 7 + ri) % 3 === 0 ? 1 : 0)) {
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
    for (const x of [0, 95, 191, 288, 381]) { g.fillStyle = "#0A0E1D"; g.fillRect(x, STAND_TOP + 1, 3, BOARD_Y - STAND_TOP - 2); g.fillStyle = "#1D2944"; g.fillRect(x, STAND_TOP + 1, 1, BOARD_Y - STAND_TOP - 2); }
    // ad boards along the far wall
    g.fillStyle = "#06091A"; g.fillRect(0, BOARD_Y - 1, WW, 9);
    const bw = 48;
    for (let i = 0; i * bw < WW; i++) {
      const [txt, bg, fg] = BOARDS[i % BOARDS.length];
      g.fillStyle = tone(bg, 0.85); g.fillRect(i * bw + 1, BOARD_Y, bw - 2, 7);
      g.fillStyle = tone(bg, 1.05); g.fillRect(i * bw + 1, BOARD_Y, bw - 2, 1);
      g.fillStyle = tone(bg, 0.5); g.fillRect(i * bw + 1, BOARD_Y + 6, bw - 2, 1);
      if (i > 0 && (i + 1) * bw < WW - 8) WG.text(g, txt, i * bw + 1 + Math.floor((bw - 2 - WG.textWidth(txt)) / 2), BOARD_Y, { color: tone(fg, 0.78) });
      else { g.fillStyle = tone(fg, 0.5); for (let k = 3; k < bw - 4; k += 4) g.fillRect(i * bw + k, BOARD_Y + 3, 2, 1); }
    }
    g.fillStyle = "#26324F"; g.fillRect(0, BOARD_Y + 7, WW, 1);
    return c;
  }
  function paintMasts() {
    const c = WG.canvas(W + PADX * 2, 46), g = c.getContext("2d");
    for (const mx of [13 + PADX, 370 + PADX]) {
      // lattice mast
      g.fillStyle = "#0A0E1D"; g.fillRect(mx, 8, 2, 38); g.fillRect(mx + 5, 8, 2, 38);
      for (let y = 10; y < 44; y += 6) { g.fillStyle = "#1D2944"; for (let i = 0; i < 5; i++) g.fillRect(mx + 1 + i, y + (((y / 6) | 0) % 2 ? i : 4 - i), 1, 1); }
      g.fillStyle = "#26324F"; g.fillRect(mx - 1, 44, 9, 2);
      g.fillStyle = "#0A0E1D"; g.fillRect(mx - 3, 2, 13, 8);
      g.fillStyle = "#26324F"; g.fillRect(mx - 3, 2, 13, 1);
    }
    return c;
  }
  // the lamps themselves and their glare, drawn over the dark corners
  function paintLamps() {
    const c = WG.canvas(W + PADX * 2, 46), g = c.getContext("2d");
    for (const mx of [13 + PADX, 370 + PADX]) {
      art.dither(g, mx - 12, -6, 31, 24, null, "rgba(255,240,194,.30)", 0.4);
      art.dither(g, mx - 7, -2, 21, 15, null, "rgba(255,240,194,.35)", 0.5);
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
    // the little desk with its screen
    g.fillStyle = "#0A0F1E"; g.fillRect(0, 12, 5, 4); g.fillStyle = "#34D399"; g.fillRect(1, 13, 3, 2);
    return c;
  }

  // the corners of the picture go dark by dithered steps, and the floodlights lay faint beams over the court
  function paintVignette() {
    const c = WG.canvas(W, H), g = c.getContext("2d");
    g.fillStyle = "rgba(2,5,14,.78)";
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = (x - 192) / 192, dy = (y - 112) / 112;
      const d = Math.sqrt(dx * dx * 0.55 + dy * dy * 0.9);
      const a = clamp((d - 0.78) / 0.5, 0, 1) * 0.5;
      if (a > BAY[(y & 3) * 4 + (x & 3)]) g.fillRect(x, y, 1, 1);
    }
    return c;
  }
  function paintBeams() {
    const c = WG.canvas(W, H), g = c.getContext("2d");
    g.fillStyle = "rgba(255,240,200,.07)";
    for (const [lx, tx] of [[19, 150], [365, 236]]) {
      for (let y = 12; y < 176; y++) {
        const k = (y - 12) / 164, cx = lerp(lx, tx, Math.pow(k, 0.85)), hw = 3 + k * 46;
        const lvl = 0.55 * (1 - k * 0.75);
        for (let x = Math.floor(cx - hw); x <= cx + hw; x++) {
          const e = 1 - Math.abs(x - cx) / hw;
          if (e * lvl > BAY[(y & 3) * 4 + (x & 3)] * 0.55) g.fillRect(x, y, 1, 1);
        }
      }
    }
    return c;
  }
  // two ball kids waiting at the far corners
  const KID = WG.sprite([
    "..kkk...",
    ".kcccck.",
    ".kssssk.",
    ".kskksk.",
    "..kkkk..",
    ".kbbbbk.",
    "kbbbbbbk",
    "ksbbbbsk",
    ".kbbbbk.",
    ".kddddk.",
    ".kd..dk.",
    ".kk..kk.",
  ], { k: "#070B18", c: "#2F6FA0", s: "#F0C29B", b: "#22B8CF", d: "#1B2133" });
  let COURT = null, STANDS = null, STANDS_UP = null, MASTS = null, LAMPS = null, NET = null, CHAIR = null, VIGN = null, BEAMS = null;
  function ensureArt() { if (COURT) return; COURT = paintCourt(); STANDS = paintStands(false); STANDS_UP = paintStands(true); MASTS = paintMasts(); LAMPS = paintLamps(); NET = paintNet(); CHAIR = paintChair(); VIGN = paintVignette(); BEAMS = paintBeams(); }

  // ---------- the player: a figure built from pixel tubes, so it can run, stretch and swing smoothly ----------
  const OUT = "#070B18";
  const FIG = 0.98; // the whole figure's size
  const BASE = { hy: 16.4, sx: 0, sy: 0, rhx: 3.8, rhy: 19.0, lhx: -1.0, lhy: 20.4, ra: 8, rl: 0.95, lfx: -3.6, lfy: 0, rfx: 3.6, rfy: 0, hdx: 0, hdy: 0, two: 0 };
  const POSE = (o) => Object.assign({}, BASE, o);
  const POSES = {
    ready: POSE({ rhx: 7.6, rhy: 17.0, ra: 6, rl: 0.95, lhx: -6.2, lhy: 17.4 }),
    wind: POSE({ hy: 15.2, sx: 1.6, sy: 0.3, rhx: 10.8, rhy: 25.0, ra: 68, rl: 0.6, lhx: -3.2, lhy: 24.0, lfx: -3.2, lfy: 1.4, rfx: 5.4, rfy: 0, hdx: 0.8 }),
    hit: POSE({ hy: 14.6, sx: -0.6, sy: -0.2, rhx: 9.6, rhy: 20.4, ra: 82, rl: 1, lhx: -4.8, lhy: 23.2, lfx: -4.6, lfy: 2.4, rfx: 5.6, rfy: -0.4, hdx: -0.4 }),
    follow: POSE({ hy: 15.6, sx: -2, sy: 0.6, rhx: -6.4, rhy: 28.6, ra: -30, rl: 0.85, lhx: -8.8, lhy: 25.6, lfx: -4.0, lfy: 0, rfx: 3.4, rfy: 1.4, hdx: -1.1 }),
    // a deep, low reach (for the drop shot and the low ball)
    low: POSE({ hy: 11.5, sx: 1.2, sy: -0.6, rhx: 10.0, rhy: 9.5, ra: 100, rl: 1, lhx: -3.4, lhy: 17.4, lfx: -5.2, lfy: 0, rfx: 6.0, rfy: -0.8, hdy: -0.6 }),
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


  // a tube whose radius changes along its length (points are screen points)
  function taper(g, pts, r0, r1, fill, U) {
    const q = (r) => Math.max(1, Math.round(r * U * 2) / 2);
    const lens = []; let tot = 0;
    for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); lens.push(l); tot += l; }
    const sm = []; let acc = 0;
    for (let i = 0; i < lens.length; i++) {
      const n = Math.max(1, Math.ceil(lens[i] * 1.3));
      for (let k = 0; k < n; k++) { const f = k / n; sm.push({ x: pts[i].x + (pts[i + 1].x - pts[i].x) * f, y: pts[i].y + (pts[i + 1].y - pts[i].y) * f, t: tot ? (acc + lens[i] * f) / tot : 0 }); }
      acc += lens[i];
    }
    const last = pts[pts.length - 1]; sm.push({ x: last.x, y: last.y, t: 1 });
    const shade = tone(fill, 0.68);
    for (const s of sm) art.disc(g, s.x, s.y, q(lerp(r0, r1, s.t)) + 1, OUT);
    for (const s of sm) { const r = q(lerp(r0, r1, s.t)); art.disc(g, s.x, s.y, r, r > 1.5 ? shade : fill); }
    for (const s of sm) { const r = q(lerp(r0, r1, s.t)); if (r > 1.5) art.disc(g, s.x - 0.5, s.y - 0.5, r - 1, fill); }
  }
  // two-bone leg or arm: returns [root, joint, end]
  function ik(root, end, l1, l2, bend, flat) {
    const dx = end[0] - root[0], dy = end[1] - root[1];
    let d = Math.hypot(dx, dy) || 0.001;
    const ux = dx / d, uy = dy / d;
    d = Math.min(d, l1 + l2 - 0.15);
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a)) * (flat || 1);
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
  // view = +1: seen from behind (the near player); −1: from the front (the far one, whose right hand is on our left)
  function drawFigure(g, L, view, X, Y, sc, P, extra) {
    extra = extra || {};
    const U = Math.pow(sc, 0.82) * FIG, S = view;
    X = Math.round(X); Y = Math.round(Y);
    const pt = (lx, ly) => ({ x: X + S * lx * U, y: Y - ly * U });
    const pa = (a) => a.map((q) => pt(q[0], q[1]));
    const skin = L.skin, hair = L.hair;
    const R = (v) => Math.round(v);
    // the shadow on the court
    art.ellipse(g, X, Y + 1, R(8.6 * U), Math.max(2, R(2.8 * U)), "rgba(2,8,20,.42)");
    art.ellipse(g, X, Y + 1, R(5.8 * U), Math.max(1, R(1.8 * U)), "rgba(2,8,20,.32)");
    const hy = P.hy;
    const hipL = [-2.3, hy], hipR = [2.3, hy];
    const legs = [[hipL, [P.lfx, P.lfy], -1], [hipR, [P.rfx, P.rfy], 1]].sort((a, b) => b[1][1] - a[1][1]);
    // legs: the one planted farther up the court first
    for (const [hip, foot, side] of legs) {
      const ch = ik(hip, foot, 8.2, 8.6, [side, 0.25], 0.55);
      taper(g, pa(ch), 1.95, 1.3, skin, U);
      taper(g, pa([[ch[2][0], ch[2][1] + 3.4], ch[2]]), 1.55, 1.55, L.sock, U);
      const f = pt(foot[0] + side * 0.4, foot[1] + 0.2);
      art.ellipse(g, f.x, f.y, R(3.3 * U + 1), Math.max(2, R(1.9 * U + 1)), OUT);
      art.ellipse(g, f.x, f.y, R(3.3 * U), Math.max(1, R(1.9 * U)), L.shoe);
      g.fillStyle = tone(L.shoe, 0.62); g.fillRect(R(f.x - 3 * U), R(f.y + Math.max(0, 1.1 * U - 0.2)), Math.max(2, R(6 * U)), 1);
    }
    // shorts or a skirt
    if (L.skirt) {
      const top = pt(0, hy + 1.2), bot = pt(0, hy - 4.8);
      const rows = Math.max(3, R(bot.y - top.y));
      const wf = (j) => R((4.4 + (j / rows) * 3.0) * U);
      for (let j = 0; j <= rows; j++) { g.fillStyle = OUT; g.fillRect(top.x - wf(j) - 1, top.y + j, wf(j) * 2 + 3, 1); }
      g.fillStyle = OUT; g.fillRect(top.x - wf(rows), top.y + rows + 1, wf(rows) * 2 + 1, 1);
      for (let j = 0; j <= rows; j++) {
        const w = wf(j);
        g.fillStyle = j >= rows - 1 ? tone(L.shorts, 0.72) : L.shorts; g.fillRect(top.x - w, top.y + j, w * 2 + 1, 1);
        g.fillStyle = tone(L.shorts, 1.25); g.fillRect(top.x - w, top.y + j, 1, 1);
        if (j % 3 === 1) { g.fillStyle = tone(L.shorts, 0.8); g.fillRect(top.x - Math.round(w * 0.3), top.y + j, 1, 1); g.fillRect(top.x + Math.round(w * 0.45), top.y + j, 1, 1); }
      }
      g.fillStyle = L.trim; g.fillRect(top.x - wf(rows) + 1, top.y + rows - 1, wf(rows) * 2 - 1, 1);
    } else {
      for (const [hip, , side] of legs) {
        taper(g, pa([[hip[0] + side * 0.1, hy + 1.0], [hip[0] + side * 0.6, hy - 4.4]]), 2.6, 2.7, L.shorts, U);
        const a = pt(hip[0] + side * 2.2, hy - 0.2), b = pt(hip[0] + side * 2.5, hy - 4.2);
        g.fillStyle = L.trim; g.fillRect(R(Math.min(a.x, b.x)) + (side * S > 0 ? 0 : 0), R(a.y), 1, Math.max(2, R(b.y - a.y)));
      }
    }
    // torso: a trapezoid from the shoulders to the waist
    const shY = hy + 11.5 + P.sy, shX = P.sx;
    {
      const yt = Y - (shY + 1.3) * U, yb = Y - (hy + 0.4) * U, xt = X + S * shX * U;
      const sh = 5.3 * U, wh = 3.8 * U;
      const y0 = R(yt), y1 = R(yb), n = Math.max(1, y1 - y0);
      const edge = [];
      for (let y = y0; y <= y1; y++) {
        const k = (y - y0) / n;
        const half = lerp(sh, wh, Math.pow(k, 0.85)), cx = lerp(xt, X, k);
        edge.push([R(cx - half), R(cx + half)]);
      }
      for (let i = 0; i < edge.length; i++) {
        const [a, b] = edge[i], y = y0 + i;
        g.fillStyle = OUT; g.fillRect(i === 0 ? a : a - 1, y, (i === 0 ? b - a : b - a + 2) + 1, 1);
      }
      g.fillStyle = OUT; g.fillRect(edge[0][0] + 1, y0 - 1, edge[0][1] - edge[0][0] - 1, 1); g.fillRect(edge[edge.length - 1][0], y1 + 1, edge[edge.length - 1][1] - edge[edge.length - 1][0] + 1, 1);
      for (let i = 0; i < edge.length; i++) {
        const [a, b] = edge[i], y = y0 + i, w = b - a + 1;
        g.fillStyle = L.shirt; g.fillRect(a, y, w, 1);
        g.fillStyle = tone(L.shirt, 0.72); g.fillRect(Math.max(a, b - 1), y, Math.min(2, w), 1);
        if (w > 5 && (y + a) % 2 === 0) { g.fillStyle = tone(L.shirt, 0.72); g.fillRect(b - 2, y, 1, 1); }
        g.fillStyle = tone(L.shirt, 1.22); g.fillRect(a, y, 1, 1);
        if (i === 0) { g.fillStyle = tone(L.shirt, 1.25); g.fillRect(a + 1, y, w - 2, 1); }
        if (i === edge.length - 1) { g.fillStyle = tone(L.shirt, 0.72); g.fillRect(a, y, w, 1); }
      }
      // the trim: a yoke across the upper back / a collar and a stripe across the chest
      g.fillStyle = L.trim;
      const ry = Math.min(edge.length - 1, Math.max(1, R(n * 0.32)));
      g.fillRect(edge[ry][0] + 1, y0 + ry, edge[ry][1] - edge[ry][0] - 1, 1);
      if (view > 0) { const c = R((edge[ry + 1][0] + edge[ry + 1][1]) / 2); g.fillStyle = tone(L.shirt, 0.62); g.fillRect(c - 1, y0 + 1, 3, 1); g.fillRect(c, y0 + 2, 1, 1); }
      else { g.fillStyle = tone(L.shirt, 0.6); const c = R((edge[1][0] + edge[1][1]) / 2); g.fillRect(c - 1, y0 + 1, 3, 1); g.fillRect(c, y0 + 2, 1, 1); }
    }
    // arms
    const sR = [shX + 5.3, shY - 0.2], sLf = [shX - 5.3, shY - 0.2];
    const armR = ik(sR, [P.rhx, P.rhy], 5.7, 6.1, [0.8, -1], 0.9), armL = ik(sLf, [P.lhx, P.lhy], 5.7, 6.1, [-0.8, -1], 0.9);
    const drawArm = (arm) => {
      taper(g, pa(arm), 1.35, 1.15, skin, U);
      const m = [arm[0][0] + (arm[1][0] - arm[0][0]) * 0.8, arm[0][1] + (arm[1][1] - arm[0][1]) * 0.8];
      taper(g, pa([arm[0], m]), 1.85, 1.65, L.shirt, U);
      const mp = pt(m[0], m[1]); g.fillStyle = L.trim; g.fillRect(R(mp.x) - 1, R(mp.y), 3, 1);
      const hd = pt(arm[2][0], arm[2][1]);
      art.disc(g, hd.x, hd.y, Math.max(1, 1.15 * U), skin);
    };
    const racketNow = () => { const hd = pt(armR[2][0], armR[2][1]); drawRacket(g, hd.x, hd.y, P.ra, P.rl, U, S, L.racket); };
    // head
    const drawHead = () => {
      const c = pt(shX * 0.7 + P.hdx, shY + 5.8 + P.hdy);
      const cx = R(c.x), cy = R(c.y);
      const Rr = Math.max(3, R(4.4 * U));
      const wAt = (j) => Math.round(Math.sqrt(Math.max(0, (Rr + 0.35) * (Rr + 0.35) - j * j)));
      const rows = (fn) => { for (let j = -Rr; j <= Rr; j++) fn(j, wAt(j)); };
      // the neck, then the outline of the head
      g.fillStyle = OUT; g.fillRect(cx - 2, cy + Rr - 1, 5, 3);
      g.fillStyle = tone(skin, 0.8); g.fillRect(cx - 1, cy + Rr - 1, 3, 2);
      g.fillStyle = OUT;
      rows((j, w) => g.fillRect(cx - w - 1, cy + j, 2 * w + 3, 1));
      g.fillRect(cx - wAt(-Rr), cy - Rr - 1, 2 * wAt(-Rr) + 1, 1);
      g.fillRect(cx - wAt(Rr), cy + Rr + 1, 2 * wAt(Rr) + 1, 1);
      const long = L.hairStyle === "pony" || L.hairStyle === "long";
      if (view > 0) {
        // seen from behind: all hair, the ears peeking out, a band or a cap
        rows((j, w) => { g.fillStyle = hair; g.fillRect(cx - w, cy + j, 2 * w + 1, 1); g.fillStyle = tone(hair, 0.68); g.fillRect(cx + w - 1, cy + j, 2, 1); });
        g.fillStyle = tone(hair, 1.6); g.fillRect(cx - R(Rr * 0.55), cy - R(Rr * 0.7), Math.max(1, R(Rr * 0.6)), 1);
        g.fillStyle = tone(hair, 1.25); g.fillRect(cx - R(Rr * 0.7), cy - R(Rr * 0.35), 1, 1);
        g.fillStyle = skin; g.fillRect(cx - wAt(1), cy + 1, 1, Math.max(1, R(Rr * 0.4))); g.fillRect(cx + wAt(1), cy + 1, 1, Math.max(1, R(Rr * 0.4)));
        if (L.cap) {
          rows((j, w) => { if (j <= R(Rr * 0.2)) { g.fillStyle = L.cap; g.fillRect(cx - w, cy + j, 2 * w + 1, 1); g.fillStyle = tone(L.cap, 0.68); g.fillRect(cx + w - 1, cy + j, 2, 1); } });
          g.fillStyle = tone(L.cap, 1.45); g.fillRect(cx - R(Rr * 0.55), cy - R(Rr * 0.7), Math.max(1, R(Rr * 0.6)), 1);
          g.fillStyle = tone(L.cap, 0.55); g.fillRect(cx - wAt(R(Rr * 0.2)), cy + R(Rr * 0.2) + 1 - 1, 2 * wAt(R(Rr * 0.2)) + 1, 1);
          g.fillStyle = tone(L.cap, 1.25); g.fillRect(cx, cy - Rr, 1, 1);
        } else if (L.band) {
          rows((j, w) => { if (j === -1 || (j === 0 && Rr >= 4)) { g.fillStyle = L.band; g.fillRect(cx - w, cy + j, 2 * w + 1, 1); } });
        }
        if (long) {
          const sw = extra.swing || 0, tail = L.hairStyle === "long" ? 8.5 : 6;
          taper(g, [{ x: cx + sw * 0.3 * U, y: cy + Rr * 0.4 }, { x: cx + sw * 1.2 * U, y: cy + Rr * 0.4 + tail * U * 0.55 }, { x: cx + sw * 2 * U, y: cy + Rr * 0.4 + tail * U }], L.hairStyle === "long" ? 2.4 : 1.5, 1.1, hair, U);
        }
      } else {
        // the face looks at us: skin, hair on top, a cap with its peak, eyes and a mouth
        rows((j, w) => { g.fillStyle = skin; g.fillRect(cx - w, cy + j, 2 * w + 1, 1); g.fillStyle = tone(skin, 0.8); g.fillRect(cx + w, cy + j, 1, 1); });
        const hj = -R(Rr * 0.2);          // the hairline
        rows((j, w) => {
          if (j <= hj) { g.fillStyle = hair; g.fillRect(cx - w, cy + j, 2 * w + 1, 1); }
          else if (j <= hj + 1 && Rr >= 4) { g.fillStyle = hair; g.fillRect(cx - w, cy + j, 1, 1); g.fillRect(cx + w, cy + j, 1, 1); }
        });
        g.fillStyle = tone(hair, 1.55); g.fillRect(cx - R(Rr * 0.5), cy - R(Rr * 0.75), Math.max(1, R(Rr * 0.5)), 1);
        if (L.cap) {
          rows((j, w) => { if (j <= hj) { g.fillStyle = L.cap; g.fillRect(cx - w, cy + j, 2 * w + 1, 1); } });
          g.fillStyle = tone(L.cap, 1.45); g.fillRect(cx - R(Rr * 0.5), cy - R(Rr * 0.75), Math.max(1, R(Rr * 0.5)), 1);
          const bw = wAt(hj) + 1;
          g.fillStyle = OUT; g.fillRect(cx - bw - 1, cy + hj, 2 * bw + 3, 3);
          g.fillStyle = tone(L.cap, 1.2); g.fillRect(cx - bw, cy + hj + 1, 2 * bw + 1, 1);
          g.fillStyle = tone(L.cap, 0.7); g.fillRect(cx - bw, cy + hj + 2 - (Rr >= 4 ? 0 : 1), 2 * bw + 1, 1);
        } else if (L.band) {
          rows((j, w) => { if (j === hj + 1) { g.fillStyle = L.band; g.fillRect(cx - w, cy + j, 2 * w + 1, 1); } });
        }
        const ey = cy + R(Rr * 0.2), ex = Math.max(1, R(Rr * 0.42));
        g.fillStyle = "#0A0F1E";
        if (extra.blink) { g.fillRect(cx - ex - (Rr >= 4 ? 1 : 0), ey + 1, 2, 1); g.fillRect(cx + ex - (Rr >= 4 ? 0 : 0), ey + 1, 2, 1); }
        else { g.fillRect(cx - ex, ey, 1, Rr >= 4 ? 2 : 1); g.fillRect(cx + ex, ey, 1, Rr >= 4 ? 2 : 1); }
        const my = cy + Math.max(2, R(Rr * 0.62)) + (Rr >= 4 ? 1 : 0);
        if (extra.mood === "happy") { g.fillStyle = "#7A1830"; g.fillRect(cx - 1, my, 3, 1); if (Rr >= 4) { g.fillStyle = "#FFFFFF"; g.fillRect(cx, my, 1, 1); } }
        else if (extra.mood === "sad") { g.fillStyle = tone(skin, 0.5); g.fillRect(cx - 1, my + 1, 3, 1); g.fillRect(cx - 1, my + 2, 1, 1); g.fillRect(cx + 1, my + 2, 1, 1); }
        else { g.fillStyle = tone(skin, 0.55); g.fillRect(cx, my, 1, 1); }
        if (long) {
          const sw = extra.swing || 0;
          for (const sd of [-1, 1]) taper(g, [{ x: cx + sd * (wAt(hj + 1) + 0.5), y: cy + hj + 1 }, { x: cx + sd * (wAt(hj + 1) + 1.2) + sw * 0.4 * sd, y: cy + Rr + (L.hairStyle === "long" ? 5 : 2) * U }], 1.2, 1.0, hair, U);
        }
      }
    };
    if (view > 0) { drawArm(armL); drawHead(); racketNow(); drawArm(armR); }
    else { drawHead(); drawArm(armL); racketNow(); drawArm(armR); }
  }

  // ---------- sound ----------
  const clap = (() => { const r = WG.rng(5), o = []; for (let i = 0; i < 10; i++) o.push({ w: "noise", f: 4000 + r() * 900, t: i * 0.055 + r() * 0.03, d: 0.05, v: 0.045 + r() * 0.04, hp: 2400 }); return o; })();
  Object.assign(WG.SFX, {
    t_hit: [{ w: "noise", f: 2400, d: 0.05, v: 0.3, hp: 1400, r: 0.03 }, { w: "p50", f: 200, f2: 120, d: 0.06, v: 0.2, r: 0.03 }],
    t_hard: [{ w: "noise", f: 3200, d: 0.07, v: 0.4, hp: 1000 }, { w: "p50", f: 280, f2: 90, d: 0.09, v: 0.24 }, { w: "tri", f: 120, f2: 60, d: 0.1, v: 0.32 }],
    t_soft: [{ w: "noise", f: 1600, d: 0.04, v: 0.2, hp: 900 }, { w: "p50", f: 150, f2: 100, d: 0.05, v: 0.14 }],
    t_bounce: [{ w: "tri", f: 330, f2: 210, d: 0.035, v: 0.22 }, { w: "noise", f: 900, d: 0.02, v: 0.08, hp: 700 }],
    t_net: [{ w: "noise", f: 500, d: 0.18, v: 0.22, lp: 1200, r: 0.1 }, { w: "tri", f: 90, f2: 60, d: 0.12, v: 0.2 }],
    t_serve: [{ w: "noise", f: 300, f2: 3000, d: 0.15, v: 0.1, hp: 500 }],
    t_toss: [{ w: "p12", f: 700, f2: 1150, d: 0.09, v: 0.08 }],
    t_out: [{ w: "p50", f: "A3", d: 0.12, v: 0.16 }, { w: "p50", f: "F3", t: 0.14, d: 0.26, v: 0.16, vib: 6 }],
    t_clap: clap,
    t_point: [{ w: "p25", f: "E6", d: 0.05, v: 0.16 }, { w: "p25", f: "B6", t: 0.05, d: 0.16, v: 0.16, sus: 0.5, r: 0.08 }],
    t_lost: [{ w: "p50", f: "E5", d: 0.1, v: 0.14 }, { w: "p50", f: "C5", t: 0.11, d: 0.22, v: 0.14, sus: 0.6, r: 0.1 }],
    t_game: [["C5", 0], ["E5", 0.07], ["G5", 0.14], ["C6", 0.21], ["E6", 0.28], ["G6", 0.36]].map(([f, t], i) => ({ w: "p25", f, t, d: i === 5 ? 0.35 : 0.07, v: 0.17, sus: 0.7, r: 0.08 })),
    t_perfect: [{ w: "p12", f: "C7", d: 0.04, v: 0.1 }, { w: "p12", f: "E7", t: 0.04, d: 0.04, v: 0.1 }, { w: "p12", f: "G7", t: 0.08, d: 0.09, v: 0.1, r: 0.06 }],
  });
  const bar = (s) => { const t = s.trim().split(/\s+/); while (t.length < 16) t.push("."); return t.slice(0, 16).join(" "); };
  const MUSIC = (() => {
    const CH = { C: ["C5", "E5", "G5", "C3", "C4"], G: ["B4", "D5", "G5", "G2", "G3"], Am: ["A4", "C5", "E5", "A2", "A3"], F: ["A4", "C5", "F5", "F2", "F3"] };
    const prog = ["C", "G", "Am", "F", "C", "G", "F", "G"];
    const lead = [
      "E5 . G5 . C6 - . G5 E5 . G5 - - . . .", "D5 . G5 . B5 - . G5 D5 . B5 - A5 G5 . .", "C6 . A5 . E5 - . A5 C6 . E6 - D6 C6 . .", "A5 . C6 . F6 - . E6 D6 . C6 - A5 . G5 .",
      "E6 . G5 . C6 . E6 . G6 - . E6 C6 - - .", "D6 . B5 . G5 . B5 . D6 - . B5 G5 - - .", "C6 . A5 . F5 . A5 . C6 . D6 . E6 . F6 .", "G6 - . D6 B5 . G5 . B5 - D6 - G6 - - -",
    ].map(bar);
    const arp = prog.map((c) => { const [a, b, d] = CH[c]; return bar([a, b, d, b, a, b, d, b, a, b, d, b, a, b, d, b].join(" ")); });
    const bass = prog.map((c) => { const r = CH[c][3], o = CH[c][4]; return bar([r, ".", r, ".", r, ".", o, ".", r, ".", r, ".", o, ".", r, "."].join(" ")); });
    const A = bar("k . h . s . h . k . h . s . h h"), B = bar("k . h k s . h . k k h . s . h o");
    return {
      bpm: 128,
      ch: [
        { w: "p25", v: 0.1, sus: 0.5, notes: lead.join(" ") },
        { w: "p12", v: 0.04, sus: 0.3, notes: arp.join(" ") },
        { w: "tri", v: 0.2, sus: 0.8, notes: bass.join(" ") },
        { w: "noise", v: 0.14, notes: [A, B, A, B, A, B, A, B].join(" ") },
      ],
    };
  })();
  const GOLD_T = ["#FFF0C2", "#FFF0C2", "#FFD27A", "#FFD27A", "#FFD27A", "#C98A1B", "#C98A1B"];
  const INK_T = ["#FFFFFF", "#FFFFFF", "#EAF0FA", "#EAF0FA", "#C9D6F2", "#C9D6F2", "#A9B6CD"];

  // ---------- how each of them plays ----------
  // open: how often it goes for the open corner; lob / drop / flat: how often; net: how eagerly it comes to the net;
  // margin: how far inside the lines it aims; power: pace; scat: how wild its shots are; speed: running
  const STYLES = {
    novice: { open: 0.05, lob: 0, drop: 0, flat: 0, net: 0, margin: 2.8, power: 0.86, scat: 1.3, speed: 0.93 },
    steady: { open: 0.22, lob: 0.1, drop: 0, flat: 0.05, net: 0, margin: 2.0, power: 0.93, scat: 1.0, speed: 1.0 },
    power: { open: 0.35, lob: 0, drop: 0, flat: 0.6, net: 0, margin: 0.8, power: 1.12, scat: 1.35, speed: 1.0 },
    net: { open: 0.45, lob: 0.08, drop: 0.3, flat: 0.1, net: 0.85, margin: 1.3, power: 0.97, scat: 1.0, speed: 1.02 },
    wall: { open: 0.3, lob: 0.3, drop: 0.05, flat: 0.02, net: 0, margin: 1.5, power: 0.9, scat: 0.78, speed: 1.1 },
    allcourt: { open: 0.6, lob: 0.15, drop: 0.15, flat: 0.25, net: 0.3, margin: 1.2, power: 1.0, scat: 0.95, speed: 1.03 },
    master: { open: 0.8, lob: 0.2, drop: 0.2, flat: 0.3, net: 0.35, margin: 0.9, power: 1.05, scat: 0.85, speed: 1.05 },
  };
  const SHOTS = {
    // v: pace in m/s, depth: how far past the net it aims, spin, clear: the least height over the net, sx / sz: how wild
    drive: { v: 29, depth: 8.2, spin: 0.35, clear: 0.42, sx: 1, sz: 1 },
    flat: { v: 35, depth: 9.5, spin: 0.05, clear: 0.2, sx: 1.2, sz: 1.3 },
    drop: { v: 11, depth: 3.1, spin: -0.9, clear: 0.34, sx: 0.55, sz: 0.55 },
    lob: { v: 12, depth: 10.3, spin: 0.2, clear: 3.3, sx: 0.8, sz: 0.7 },
    smash: { v: 32, depth: 7.4, spin: 0, clear: 0.15, sx: 0.8, sz: 0.85 },
    volley: { v: 20, depth: 7.4, spin: 0, clear: 0.35, sx: 1.05, sz: 0.9 },
    serve1: { v: 28, depth: 5.0, spin: 0.1, clear: 0.2, sx: 1, sz: 1 },
    serve2: { v: 21, depth: 4.6, spin: 0.7, clear: 0.55, sx: 0.5, sz: 0.5 },
  };
  const CT = 0.06, WIN = 0.22; // a swing: the soonest it can hit, the latest

  WG.game({
    id: "tennis",
    portrait: false,
    controls: { dpad: true, a: "Удар", b: "Свеча", swipe: false, landscapeDpad: true },
    howto: "Матч до четырёх геймов: гейм — до четырёх очков, при 3:3 решает один мяч. Бей так, чтобы соперник не дотянулся. Нажал «Удар» чуть раньше — мяч закрутится и нырнёт («Лифт»), чуть позже — подрежется («Слайс»). Каждый из семи соперников сильнее предыдущего.",
    keysHint: "Стрелки или WASD — бег. Пробел или Z — подача и удар: жми, когда мяч рядом. Вверх + удар — сильный, вниз + удар — укороченный, X — свеча.",
    touchHowto: (l) => (l.dpad ? "Крестовина — бег, «Удар» — подача и удар (жми, когда мяч рядом), «Свеча» — высокий мяч." : "Тяни палец по корту — бег, касание — удар."),
    titleColors: ["#FFF0C2", "#FFF0C2", "#E8FF5A", "#E8FF5A", "#9BC91E", "#9BC91E", "#5F8A12"],
    stageNames: OPPS.map((o) => o.name),
    music: MUSIC,
    create(api) {
      ensureArt();
      const ST = api.stage ? OPPS[api.stage - 1] : null;
      const train = !ST;
      const opp = ST || TRAIN;
      const inp = api.input;
      const fx = new WG.Particles(700);
      const S = {
        t: 0, phase: "idle", pt: 0, over: false, overT: 0, readyT: 0, banner: null, ended: false,
        pts: [0, 0], games: [0, 0], total: [0, 0], server: 1, serveNo: 1, pointNo: 0, gamePts: 0,
        rally: 0, bestRally: 0, score: 0, lives: 3, streak: 0, playMs: 0,
        sv: { stage: "wait", t: 0, delay: 0.9, hitT: 0.6 }, intro: 0, freeze: 0, cam: 0, flash: 0, calls: [], pops: [],
        crowd: 0, tipT: 0, helped: 0, shotId: 0, aiSk: ST ? ST.sk : Math.max(0.08, api.skill * 0.7), bot: null,
        hist: [], gameBanner: null, afterT: 0, pendingGame: null, lastLabel: null,
      };
      // the stage's strength can be nudged by the level a player picked (or «Подстроиться»)
      if (ST) S.aiSk = clamp(ST.sk + (api.skill - 0.45) * 0.45, 0.02, 1);
      const mk = (side, look) => ({
        side, look, x: 0, z: side * 12.6, px: 0, pz: side * 12.6, vx: 0, vz: 0, rp: 0, sw: null, swCd: 0, bufT: 0, bufK: null,
        mood: null, moodT: 0, blink: 1 + Math.random() * 2, srv: null, hair: 0, hand: 1,
        sk: 0.5, style: "allcourt", st: STYLES.allcourt, netMode: false, plan: null, planShot: -1, planAt: 0, lastDn: 9, reach: 0,
      });
      const ME = mk(1, LOOKS.me), CPU = mk(-1, LOOKS[opp.look]);
      ME.z = ME.pz = 12.8; CPU.z = CPU.pz = -12.8;
      CPU.style = opp.style; CPU.st = STYLES[opp.style]; CPU.sk = S.aiSk;
      const actor = (side) => (side > 0 ? ME : CPU);
      const idx = (side) => (side > 0 ? 0 : 1);
      const B = { x: 0, y: 1, z: 0, vx: 0, vy: 0, vz: 0, spin: 0, px: 0, py: 1, pz: 0, live: false, held: true, hitter: 0, bounces: 0, isServe: false, net: false, shotId: 0, hitT: 0, trail: [], kind: "drive", lob: false };
      const marks = []; // ball marks on the court, fading

      // ----- the opponent's numbers, from one strength 0…1 -----
      const aiNums = (a) => {
        const sk = a.sk, st = a.st, k = Math.pow(sk, 0.8);
        return {
          speed: (4.5 + 3.9 * sk) * st.speed, react: 0.4 - 0.34 * sk, err: 1.35 * Math.pow(1 - sk, 1.1) + 0.12,
          sx: lerp(1.75, 0.24, k) * st.scat, sz: lerp(2.3, 0.34, k) * st.scat, pace: st.power * (0.9 + 0.12 * sk), tmErr: 0.5 * (1 - sk),
        };
      };
      CPU.ai = true; CPU.n = aiNums(CPU);
      const refreshAI = () => { CPU.sk = S.aiSk; CPU.n = aiNums(CPU); };

      // ----- geometry -----
      const dnAt = (a, b) => {
        const sg = b.x >= a.x ? 1 : -1;
        const ix = a.x + sg * 0.8, iz = a.z - a.side * 0.45;
        const ex = (b.x - ix) / 1.25, ez = ((b.z - iz) * a.side) / 1.15;
        const eh = b.y - 0.95, ey = eh >= 0 ? eh / 1.75 : eh / 0.95;
        return { dn: Math.sqrt(ex * ex + ez * ez + ey * ey), ez, ex, ey };
      };
      const canHit = (a) => B.live && !B.net && !S.over && B.hitter !== a.side && !(B.isServe && B.bounces === 0) && B.z * a.side > -0.6;

      // ----- the ball -----
      function solveShot(b0, tx, tz, T, spin, clear) {
        const ge = G + SPINK * spin;
        let vx, vy, vz;
        for (let i = 0; i < 40; i++) {
          vx = (tx - b0.x) / T; vz = (tz - b0.z) / T; vy = (0.5 * ge * T * T - b0.y) / T;
          if (b0.z * tz < 0 && Math.abs(vz) > 0.01) {
            const tn = -b0.z / vz, xn = b0.x + vx * tn;
            const hn = b0.y + vy * tn - 0.5 * ge * tn * tn;
            if (hn >= netTop(xn) + clear) break;
          } else break;
          T += 0.04;
        }
        return { vx, vy, vz, T };
      }
      function launch(a, kind, tx, tz, o) {
        const sh = SHOTS[kind];
        const sx = o.sx * sh.sx, sz = o.sz * sh.sz;
        tx += gauss() * sx; tz += gauss() * sz;
        const b0 = { x: B.x, y: B.y, z: B.z };
        const dist = Math.hypot(tx - b0.x, tz - b0.z);
        let T = kind === "lob" ? 1.3 + dist * 0.017 : dist / (sh.v * o.pace);
        T = clamp(T, 0.32, 3.6);
        const sol = solveShot(b0, tx, tz, T, o.spin, sh.clear + 0.4 * (1 - o.q));
        B.vx = sol.vx; B.vz = sol.vz; B.vy = sol.vy + gauss() * o.sv;
        B.spin = o.spin; B.hitter = a.side; B.bounces = 0; B.live = true; B.held = false; B.net = false; B.kind = kind;
        B.isServe = kind === "serve1" || kind === "serve2"; B.lob = kind === "lob";
        B.shotId = ++S.shotId; B.hitT = S.t; B.trail.length = 0;
        return Math.hypot(B.vx, B.vz);
      }
      function spark(x, y, z, n, colors, sp) {
        const p = project(x, y, z);
        fx.emit({ x: p.x, y: p.y, n, colors, speed: sp || [20, 70], life: [0.15, 0.4], drag: 3, shape: "spark" });
      }
      function dust(x, z, power) {
        const p = project(x, 0, z);
        fx.emit({ x: p.x, y: p.y, n: 3 + Math.round(power), colors: ["#DCEAF6", "#8FA9C2", "#CFE0F2"], speed: [6, 26 + power * 4], angle: [-Math.PI * 0.95, -Math.PI * 0.05], life: [0.15, 0.4], gravity: 40, drag: 2 });
        marks.push({ x, z, t: 0 });
        if (marks.length > 14) marks.shift();
      }

      // ----- scoring -----
      const ptsText = (p) => ["0", "15", "30", "40"][Math.min(3, p)];
      const decider = () => !train && S.pts[0] === 3 && S.pts[1] === 3;
      function say(text, color, scale, t) { S.banner = { text, color: color || GOLD_T, scale: scale || 3, t: 0, life: t || 1.3 }; }
      function pop(x, y, z, text, color) { const p = project(x, y, z); S.pops.push({ x: p.x, y: p.y, text, color, t: 0 }); }
      function endPoint(winner, call) {
        if (S.over) return;
        S.over = true; S.overT = 0; B.live = false;
        const me = winner > 0;
        const wi = idx(winner);
        S.total[wi]++;
        const callTxt = call || "";
        const long = S.rally >= 6;
        if (S.rally > S.bestRally) S.bestRally = S.rally;
        if (me) {
          ME.mood = "happy"; CPU.mood = "sad";
          if (!callTxt) say("ОЧКО!", GOLD_T, 2, 0.9);
          api.sfx("t_point"); api.sfx("t_clap");
          S.crowd = 1.6;
          fx.emit({ x: 192, y: 100, n: 26, colors: ["#FFF0C2", "#FFD27A", "#8EF0C6", "#7FE6F4", "#FFFFFF"], speed: [30, 110], angle: [-Math.PI, 0], life: [0.5, 1.1], gravity: 70, drag: 1.2, shape: "star" });
        } else {
          ME.mood = "sad"; CPU.mood = "happy";
          api.sfx("t_lost");
          S.crowd = 0.8;
        }
        S.lastWinner = winner;
        S.hist.push([winner, call || (B.bounces >= 2 ? "w" : "?"), S.rally, B.hitter, +B.x.toFixed(1), +B.z.toFixed(1)]);
        if (!train) {
          S.pts[wi]++;
          if (S.pts[wi] >= 4) { S.pendingGame = winner; }
        } else if (me) {
          S.streak++;
          const gain = 10 + (long ? 5 : 0);
          S.score += gain;
          S.aiSk = clamp(S.aiSk + 0.035, 0, 1); refreshAI();
          pop(ME.x, 2.4, ME.z, "+" + gain, "#FFF0C2");
        } else {
          S.lives--; S.streak = 0;
        }
        if (callTxt) say(callTxt, me ? GOLD_T : INK_T, 2, 1.4);
      }

      // ----- hits -----
      function hitFx(a, kind, q, pace) {
        const hard = kind === "flat" || kind === "smash" || pace > 27;
        api.sfx(hard ? "t_hard" : q < 0.3 ? "t_soft" : "t_hit");
        spark(B.x, B.y, B.z, hard ? 14 : 8, hard ? ["#FFFFFF", "#FFF0C2", "#E8FF5A"] : ["#FFFFFF", "#E8FF5A", "#BFD0E4"], hard ? [30, 110] : [20, 70]);
        if (hard) { api.shake(a.side > 0 ? 1.6 : 1, 0.1); S.freeze = a.side > 0 ? 2 : 1; }
        if (q > 0.84 && a.side > 0) {
          api.sfx("t_perfect");
          const p = project(B.x, B.y, B.z);
          fx.emit({ x: p.x, y: p.y, n: 12, colors: ["#FFF0C2", "#FFD27A", "#FFFFFF"], speed: [20, 70], life: [0.3, 0.6], drag: 3, shape: "star" });
          S.pops.push({ x: p.x, y: p.y - 10, text: "ИДЕАЛЬНО!", color: "#FFD27A", t: 0 });
        }
      }
      function snapOf(dn) { return { dn: dn.dn, ez: dn.ez, x: B.x, y: B.y, z: B.z, vx: B.vx, vy: B.vy, vz: B.vz, spin: B.spin, bounces: B.bounces, t: 0 }; }
      function commitSwing(a, snap) {
        const sw = a.sw;
        B.x = snap.x; B.y = snap.y; B.z = snap.z; B.vx = snap.vx; B.vy = snap.vy; B.vz = snap.vz; B.spin = snap.spin;
        sw.commit = true; sw.ct = 0; sw.low = snap.y < 0.5; sw.over = snap.y > 2.15 && sw.kind !== "lob";
        a.hand = sw.hand = (snap.x >= a.x ? 1 : -1) * (a.side > 0 ? 1 : -1);
        const early = clamp((snap.t - CT) / 0.12, 0, 1), late = clamp(Math.max(0, snap.ez) / 1.15, 0, 1);
        let tm = clamp(early - late, -1, 1);
        if (a.ai) tm = clamp(tm + gauss() * a.n.tmErr, -1, 1);
        const q = clamp(1.04 - 0.78 * snap.dn, 0.08, 1) * (1 - 0.14 * Math.abs(tm));
        S.rally++;
        if (!a.ai) shootHuman(a, snap, q, tm); else shootAI(a, snap, q, tm);
      }
      function shootHuman(a, snap, q, tm) {
        const up = inp.held("up"), down = inp.held("down");
        const aimX = (inp.held("right") ? 1 : 0) - (inp.held("left") ? 1 : 0);
        let kind = a.sw.kind === "lob" ? "lob" : up ? "flat" : down ? "drop" : "drive";
        if (a.sw.over && kind !== "lob") kind = "smash";
        else if (kind === "drive" && B.bounces === 0 && Math.abs(a.z) < 8) kind = "volley";
        const sh = SHOTS[kind];
        const shift = sgn(snap.x - a.x) * tm * 1.1;
        let tx = aimX * 2.85 + (aimX === 0 ? -0.35 * a.x : 0) + shift;
        tx = clamp(tx, -HW + 0.55, HW - 0.55);
        let depth = sh.depth + (kind === "drive" ? (up ? 1 : 0) * 1.9 : 0);
        if (kind === "smash") depth += (up ? 1.5 : down ? -2.5 : 0);
        const tz = -a.side * depth;
        let spin = sh.spin;
        if (kind === "drive" || kind === "volley") spin = clamp(0.08 + 0.85 * tm + (snap.y - 0.95) * 0.3, -0.85, 0.95);
        const pace = 0.84 + 0.3 * q;
        const sv = 0.12 + 0.6 * (1 - q);
        const sp = launch(a, kind, tx, tz, { sx: 0.22 + 1.5 * (1 - q), sz: 0.3 + 2.1 * (1 - q), pace, spin, sv, q });
        hitFx(a, kind, q, sp);
        S.lastLabel = { text: kind === "drive" || kind === "volley" ? (spin > 0.45 ? "ЛИФТ" : spin < -0.3 ? "СЛАЙС" : "") : kind === "flat" ? "ЖЁСТКО" : kind === "lob" ? "СВЕЧА" : kind === "drop" ? "УКОРОТ" : kind === "smash" ? "СМЭШ!" : "", t: 0, spin };
        if (S.lastLabel.text) { const p = project(a.x, 2.7, a.z); S.pops.push({ x: p.x, y: p.y, text: S.lastLabel.text, color: spin > 0.45 ? "#7FE6F4" : spin < -0.3 ? "#C4BBFF" : "#FFF0C2", t: 0 }); }
      }
      // what the computer decides to play at the moment of the hit
      function shootAI(a, snap, q, tm) {
        const foe = actor(-a.side), st = a.st, sk = a.sk;
        const nearNet = Math.abs(a.z) < 8.5, foeNet = Math.abs(foe.z) < 7.2, foeDeep = Math.abs(foe.z) > 10.6, foeWide = Math.abs(foe.x) > 2.4;
        const pressure = snap.dn > 0.72 || q < 0.45;
        let kind = "drive";
        const r = Math.random;
        if (B.y > 2.15) kind = "smash";
        else if (a.style === "wall" && pressure && r() < 0.55) kind = "lob";
        else if (foeNet && r() < st.lob * (0.5 + sk) + 0.3 * sk) kind = "lob";
        else if (!pressure && (foeDeep || foeWide) && (nearNet || a.netMode) && r() < st.drop * (0.5 + 1.1 * sk) * 1.5) kind = "drop";
        else if (!pressure && foeDeep && r() < st.drop * 0.35 * sk) kind = "drop";
        else if (q > 0.5 && !pressure && r() < st.flat * (0.4 + sk)) kind = "flat";
        else if (B.bounces === 0 && nearNet) kind = "volley";
        const sh = SHOTS[kind];
        const open = foe.x > 0.3 ? -1 : foe.x < -0.3 ? 1 : (Math.random() < 0.5 ? -1 : 1);
        const maxX = Math.max(0.6, HW - st.margin * (1.1 - 0.4 * sk));
        const useOpen = Math.random() < st.open * (0.25 + 0.75 * sk);
        let tx = useOpen ? open * rand(maxX * 0.55, maxX) : rand(-maxX * 0.45, maxX * 0.45);
        if (kind === "lob" || kind === "drop") tx = open * rand(0.6, Math.min(maxX, 3));
        let depth = sh.depth;
        if (kind === "drive" || kind === "flat" || kind === "volley") depth = clamp(HL - st.margin - rand(0, 1.3) * (1 - sk), 5.5, HL - 0.7);
        if (kind === "lob") depth = HL - 1.4 - rand(0, 1.2) * (1 - sk);
        const tz = -a.side * depth;
        let spin = sh.spin;
        if (kind === "drive" || kind === "volley") spin = clamp(0.1 + 0.35 * sk + tm * 0.5 + (a.style === "wall" && Math.random() < 0.35 ? -0.7 : 0), -0.85, 0.95);
        const qq = clamp(q * (0.9 + 0.1 * sk), 0.1, 1);
        const stretch = 1 + 1.1 * (1 - qq);
        const sp = launch(a, kind, tx, tz, { sx: a.n.sx * stretch, sz: a.n.sz * stretch, pace: a.n.pace * (0.84 + 0.3 * qq), spin, sv: (0.12 + 0.55 * (1 - qq)) * (0.5 + 0.8 * st.scat) * (1.15 - 0.6 * sk), q: qq });
        hitFx(a, kind, qq, sp);
        // coming to the net: after a short ball, or now and then after a deep one for those who love it
        if (st.net > 0 && kind !== "lob" && !pressure && Math.random() < st.net * (Math.abs(a.z) < 10.4 ? 0.9 : 0.3) * (0.5 + 0.5 * sk)) a.netMode = true;
        if (kind === "lob") a.netMode = false;
        a.plan = null;
      }
      function startSwing(a, kind) {
        if (a.sw || a.swCd > 0) { a.bufT = 0.14; a.bufK = kind; return; }
        a.sw = { t: 0, kind, commit: false, ct: 0, best: null, miss: false, hand: a.hand, over: false, low: false };
      }
      function updateSwing(a, dt) {
        const sw = a.sw;
        if (!sw) return;
        if (!sw.commit && !sw.miss) {
          sw.t += dt;
          if (canHit(a) && sw.t >= CT) {
            const d = dnAt(a, B);
            if (d.dn <= 1.3) {
              if (!sw.best || d.dn < sw.best.dn) { sw.best = snapOf(d); sw.best.t = sw.t; }
              else if (d.dn > sw.best.dn + 0.015) commitSwing(a, sw.best);
            }
          }
          if (!sw.commit && sw.t >= WIN) {
            if (sw.best && canHit(a)) commitSwing(a, sw.best);
            else {
              sw.miss = true; sw.ct = 0; api.sfx("whoosh");
              if (!a.ai && B.live && B.hitter === -a.side && B.z * a.side > -4) { const p = project(a.x, 2.6, a.z); S.pops.push({ x: p.x, y: p.y, text: "МИМО", color: "#A9B6CD", t: 0 }); }
            }
          }
        } else {
          sw.ct += dt;
          if (sw.ct > 0.36) { a.sw = null; a.swCd = 0.04; if (a.bufT > 0) { a.bufT = 0; startSwing(a, a.bufK || "drive"); } }
        }
      }

      // ----- the serve -----
      const serverX = () => {
        const deuce = (S.total[0] + S.total[1]) % 2 === 0;
        return S.server * (deuce ? 1 : -1) * 2.2;
      };
      const boxSign = () => -Math.sign(serverX() || 1);
      function setupPoint() {
        const srv = actor(S.server), rcv = actor(-S.server);
        S.over = false; S.overT = 0; S.rally = 0; S.pendingGame = null;
        S.sv = { stage: "wait", t: 0, delay: rand(0.2, 0.4), hitT: 0.6 + gauss() * 0.04 * (1 - srv.sk), aim: 0 };
        S.serveNo = 1; S.phase = "ready"; S.readyT = 0;
        S.from = { s: [srv.x, srv.z], r: [rcv.x, rcv.z] };
        srv.tgt = [serverX(), srv.side * 12.9];
        rcv.tgt = [boxSign() * 1.8, rcv.side * 12.5];
        for (const a of [ME, CPU]) { a.sw = null; a.mood = null; a.srv = null; a.plan = null; a.netMode = false; a.bufT = 0; a.swCd = 0; }
        B.live = false; B.held = true; B.net = false; B.hitter = 0; B.trail.length = 0; B.vx = B.vy = B.vz = 0;
        holdBall();
        if (decider()) say("РЕШАЮЩИЙ МЯЧ", GOLD_T, 2, 1.6);
      }
      function holdBall() {
        const a = actor(S.server);
        B.x = a.x - a.side * 0.35; B.y = 1.2; B.z = a.z - a.side * 0.3; B.px = B.x; B.py = B.y; B.pz = B.z; B.spin = 0;
      }
      function tossBall() {
        const a = actor(S.server);
        S.sv.stage = "toss"; S.sv.t = 0;
        B.held = false; B.live = false; B.vx = 0; B.vz = 0; B.vy = 5.95; B.y = 1.5; B.spin = 0;
        api.sfx("t_toss");
        a.srv = { t: 0 };
      }
      function serveFault(why) {
        B.live = false;
        if (S.serveNo === 1) {
          S.serveNo = 2; S.phase = "retry"; S.readyT = 0;
          say(why || "ОШИБКА", INK_T, 2, 1.1); api.sfx("t_out");
        } else {
          api.sfx("t_out");
          endPoint(-S.server, "ДВОЙНАЯ ОШИБКА");
        }
      }
      function serveHit() {
        const a = actor(S.server), sv = S.sv;
        const dtp = sv.t - 0.602;
        const q = clamp(1 - Math.abs(dtp) / 0.3, 0.1, 1);
        const kind = S.serveNo === 1 ? "serve1" : "serve2";
        const sh = SHOTS[kind];
        const bs = boxSign();
        let aimX = 0, aimZ = 0;
        if (!a.ai) {
          aimX = (inp.held("right") ? 1 : 0) - (inp.held("left") ? 1 : 0);
          aimZ = (inp.held("up") ? 1 : 0) - (inp.held("down") ? 1 : 0);
        } else {
          const foe = actor(-a.side);
          aimX = Math.random() < 0.55 ? (foe.x > 0 ? -1 : 1) : 0;
          if (Math.random() < 0.25) aimX = bs;
          aimZ = Math.random() < 0.3 ? 1 : 0;
        }
        // the box is on the side bs; "right" on the screen is +x for the near server and the far server sees it mirrored
        let tx = bs * 2.06 + aimX * 1.45;
        tx = bs > 0 ? clamp(tx, 0.4, HW - 0.35) : clamp(tx, -HW + 0.35, -0.4);
        const tz = -a.side * (sh.depth + aimZ * 0.85);
        B.x = a.x - a.side * 0.1; B.z = a.z - a.side * 0.3;
        B.y = clamp(B.y, 2.0, 3.6);
        const qq = a.ai ? clamp(0.5 + 0.45 * a.sk + gauss() * 0.14 * (1.1 - a.sk), 0.12, 1) : q;
        const wild = S.serveNo === 1 ? 1 : 0.55;
        const pace = (a.ai ? lerp(0.78, 1.0, a.sk) : 0.8 + 0.22 * qq) * (qq > 0.75 ? 1.02 : 1);
        const sp = launch(a, kind, tx, tz, { sx: (0.2 + 1.5 * (1 - qq)) * wild, sz: (0.28 + 2.0 * (1 - qq)) * wild, pace, spin: sh.spin, sv: (0.1 + 0.55 * (1 - qq)) * wild, q: qq });
        B.isServe = true;
        sv.stage = "hit"; a.srv = { t: 0, hit: true };
        S.phase = "rally"; S.rally = 1;
        api.sfx("t_serve"); api.sfx(sp > 28 ? "t_hard" : "t_hit");
        spark(B.x, B.y, B.z, 10, ["#FFFFFF", "#FFF0C2", "#E8FF5A"], [30, 100]);
        if (sp > 28) api.shake(1.4, 0.1);
        if (!a.ai && qq > 0.84) { api.sfx("t_perfect"); S.pops.push({ x: 192, y: 150, text: "ИДЕАЛЬНАЯ ПОДАЧА!", color: "#FFD27A", t: 0 }); }
      }

      // ----- ball physics -----
      function bounce() {
        const spd = -B.vy;
        B.y = 0;
        if (spd > 1.2) {
          api.sfx([{ w: "tri", f: 190 + Math.min(spd, 14) * 10, f2: 140 + Math.min(spd, 14) * 6, d: 0.035, v: Math.min(0.22, 0.08 + spd * 0.012) }, { w: "noise", f: 900, d: 0.02, v: 0.06, hp: 700 }]);
          dust(B.x, B.z, Math.min(4, spd * 0.3));
        }
        B.bounces++;
        if (B.live && !S.over) {
          const h = B.hitter, bx = B.x, bz = B.z;
          const inX = Math.abs(bx) <= HW + 0.07, inZ = Math.abs(bz) <= HL + 0.07, oppSide = bz * h < 0;
          if (B.bounces === 1) {
            let ok = inX && inZ && oppSide;
            if (ok && B.isServe) ok = Math.abs(bz) <= SBOX + 0.07 && (boxSign() > 0 ? bx >= -0.05 : bx <= 0.05);
            if (!ok) {
              B.live = false;
              if (B.isServe) serveFault(oppSide && inX && inZ ? "НЕ В КВАДРАТ" : "АУТ");
              else { api.sfx("t_out"); endPoint(-h, oppSide ? "АУТ" : "НЕДОЛЁТ"); }
            } else if (Math.abs(Math.abs(bx) - HW) < 0.12 || Math.abs(Math.abs(bz) - HL) < 0.12 || (B.isServe && Math.abs(Math.abs(bz) - SBOX) < 0.12)) {
              spark(bx, 0.1, bz, 8, ["#FFFFFF", "#DCEAF6"], [10, 40]);
              if (B.hitter > 0 && B.kind !== "serve1") pop(bx, 0.6, bz, "НА ЛИНИИ!", "#FFF0C2");
            }
          } else if (B.bounces >= 2) {
            const ace = S.rally <= 1;
            endPoint(h, ace ? "ЭЙС!" : S.rally > 8 ? "ОТЛИЧНЫЙ РОЗЫГРЫШ" : "");
          }
        }
        const sp = B.spin;
        B.vy = spd * (0.74 + 0.08 * Math.max(0, sp) - 0.1 * Math.max(0, -sp));
        const kz = sp > 0 ? 1 + 0.07 * sp : 1 + 0.3 * sp;
        B.vx *= kz; B.vz *= kz;
        B.spin *= 0.5;
        if (B.vy < 1.3) B.vy = 0;
      }
      function netHit(cx, cy) {
        B.net = true;
        B.z = Math.sign(B.z || 1) * 0.12;
        B.vz = -B.vz * 0.12; B.vx *= 0.25; B.vy = Math.max(B.vy * 0.2, 1.0);
        api.sfx("t_net"); api.shake(1.2, 0.12);
        const p = project(cx, cy, 0);
        fx.emit({ x: p.x, y: p.y, n: 7, colors: ["#EAF0FA", "#9AA5C0", "#46516F"], speed: [8, 30], life: [0.2, 0.5], drag: 3 });
        NETSHAKE = 0.35;
        if (B.live && !S.over) {
          B.live = false;
          if (B.isServe) serveFault("СЕТКА");
          else endPoint(-B.hitter, "СЕТКА");
        }
      }
      let NETSHAKE = 0;
      function stepBall(dt) {
        B.px = B.x; B.py = B.y; B.pz = B.z;
        const n = 2, h = dt / n;
        for (let i = 0; i < n; i++) {
          const ox = B.x, oy = B.y, oz = B.z;
          B.vy -= (G + SPINK * B.spin) * h;
          B.x += B.vx * h; B.y += B.vy * h; B.z += B.vz * h;
          if (!B.net && (oz > 0) !== (B.z > 0) && oz !== B.z) {
            const f = oz / (oz - B.z), cx = ox + (B.x - ox) * f, cy = oy + (B.y - oy) * f;
            if (Math.abs(cx) < POST + 0.2 && cy - BALL_R < netTop(cx)) netHit(cx, cy);
          }
          if (B.y < 0 && B.vy < 0) bounce();
        }
        if (Math.abs(B.z) > 40 || Math.abs(B.x) > 30) { B.vx = B.vz = 0; }
        if (B.live && B.bounces >= 1 && Math.abs(B.z) > 24 && !S.over) endPoint(B.hitter, S.rally <= 1 ? "ЭЙС!" : "");
        // the trail
        const sp = Math.hypot(B.vx, B.vz);
        if (sp > 10 && B.live) { B.trail.push({ x: B.x, y: B.y, z: B.z }); if (B.trail.length > 7) B.trail.shift(); } else if (B.trail.length) B.trail.shift();
      }
      // a copy of the ball's flight for the computer to read: [{t, x, y, z, vy, b}]
      function forecast(maxT) {
        const s = { x: B.x, y: B.y, z: B.z, vx: B.vx, vy: B.vy, vz: B.vz, spin: B.spin }, out = [];
        let bn = B.bounces, t = 0;
        const h = 1 / 30;
        while (t < maxT) {
          s.vy -= (G + SPINK * s.spin) * h; s.x += s.vx * h; s.y += s.vy * h; s.z += s.vz * h; t += h;
          if (s.y < 0 && s.vy < 0) {
            const sp = s.spin, spd = -s.vy;
            s.y = 0; bn++;
            s.vy = spd * (0.74 + 0.08 * Math.max(0, sp) - 0.1 * Math.max(0, -sp));
            const kz = sp > 0 ? 1 + 0.07 * sp : 1 + 0.3 * sp; s.vx *= kz; s.vz *= kz; s.spin *= 0.5;
          }
          out.push({ t, x: s.x, y: s.y, z: s.z, vy: s.vy, b: bn });
        }
        return out;
      }

      // ----- moving -----
      function moveActor(a, tx, tz, dt, vmax, snap) {
        const dx = tx - a.x, dz = tz - a.z, d = Math.hypot(dx, dz);
        const want = Math.min(vmax, d * (snap || 9));
        const wx = d > 0.001 ? (dx / d) * want : 0, wz = d > 0.001 ? (dz / d) * want : 0;
        accel(a, wx, wz, dt, 40);
      }
      function accel(a, wx, wz, dt, acc) {
        const ax = wx - a.vx, az = wz - a.vz, dd = Math.hypot(ax, az), maxd = acc * dt;
        if (dd > maxd) { a.vx += (ax / dd) * maxd; a.vz += (az / dd) * maxd; } else { a.vx = wx; a.vz = wz; }
      }
      function bounds(a) {
        a.x = clamp(a.x, -5.35, 5.35);
        a.z = a.side > 0 ? clamp(a.z, 1.0, 14.0) : clamp(a.z, -14.0, -1.0);
      }
      function integrate(a, dt) {
        a.px = a.x; a.pz = a.z;
        const slow = a.sw ? (a.sw.commit || a.sw.miss ? 0.5 : 0.7) : 1;
        a.x += a.vx * dt * slow; a.z += a.vz * dt * slow;
        bounds(a);
        const sp = Math.hypot(a.vx, a.vz);
        a.rp += dt * (3 + sp * 1.25);
      }
      // the player's own legs: keys, pad, or a finger dragged over the court
      let drag = null;
      function humanMove(dt) {
        let ix = (inp.held("right") ? 1 : 0) - (inp.held("left") ? 1 : 0), iz = (inp.held("down") ? 1 : 0) - (inp.held("up") ? 1 : 0);
        const ptr = inp.pointer;
        if (ptr && ptr.down) {
          if (!drag) drag = { x0: ptr.x, y0: ptr.y };
          const dx = ptr.x - drag.x0, dy = ptr.y - drag.y0;
          if (Math.hypot(dx, dy) > 7) { ix += clamp(dx / 26, -1, 1); iz += clamp(dy / 26, -1, 1); }
        } else drag = null;
        const m = Math.hypot(ix, iz);
        if (m > 1) { ix /= m; iz /= m; }
        accel(ME, ix * 7.4, iz * 7.4 * 0.9, dt, 46);
      }
      const homeOf = (a) => {
        const foe = actor(-a.side);
        if (a.netMode) return [clamp(foe.x * 0.3, -1.6, 1.6), a.side * 3.1];
        return [clamp(foe.x * 0.42 + (B.hitter === foe.side ? B.x * 0.2 : 0), -2.4, 2.4), a.side * 12.0];
      };
      function aiMove(a, dt) {
        const incoming = B.live && B.hitter === -a.side && !S.over;
        let tgt = homeOf(a);
        if (incoming) {
          if (a.planShot !== B.shotId) { a.planShot = B.shotId; a.plan = null; a.planAt = B.hitT + a.n.react * (B.isServe ? 0.45 : 1); }
          if (!a.plan && S.t >= a.planAt) a.plan = aiIntercept(a);
          if (a.plan) tgt = a.plan;
        }
        if (incoming && a.netMode && B.lob === true) a.netMode = false;
        moveActor(a, tgt[0], tgt[1], dt, a.n.speed, 8);
        if (incoming && !a.sw && a.swCd <= 0 && canHit(a)) {
          const d0 = dnAt(a, B);
          const fut = { x: B.x + B.vx * 0.1, y: Math.max(0, B.y + B.vy * 0.1 - 4.9 * 0.01), z: B.z + B.vz * 0.1 };
          const d1 = dnAt(a, fut);
          if (Math.min(d0.dn, d1.dn) < 0.95) startSwing(a, "ai");
        }
      }
      // where the computer will wait for the ball: its read of the flight, with a little human error
      function aiIntercept(a) {
        const tr = forecast(2.6), sd = a.side;
        let pick = null;
        const wantVolley = a.netMode;
        for (const s of tr) {
          const dist = s.z * sd;
          if (dist < 1.2) continue;
          if (wantVolley && s.b === B.bounces && s.y > 0.7 && s.y < 2.0 && dist > 2 && dist < 8) { pick = s; break; }
          if (s.b > B.bounces && s.y < 1.5 && s.vy <= 0.5 && dist < 14.2) { pick = s; break; }
        }
        if (!pick) {
          for (let i = tr.length - 1; i >= 0; i--) if (tr[i].z * sd < 14.2) { pick = tr[i]; break; }
          if (!pick) pick = tr[tr.length - 1];
        }
        const e = a.n.err;
        return [clamp(pick.x - sd * 0.8 + gauss() * e, -5.2, 5.2), clamp(pick.z + sd * 0.45 + gauss() * e * 0.5, sd > 0 ? 1.2 : -13.8, sd > 0 ? 13.8 : -1.2)];
      }

      // ----- the match -----
      function startGameAfter() {
        const g = S.pendingGame;
        if (g === null) return false;
        const wi = idx(g);
        S.games[wi]++;
        S.pts = [0, 0];
        S.server = -S.server;
        say(g > 0 ? "ГЕЙМ — ТЫ!" : "ГЕЙМ — " + opp.name.toUpperCase(), g > 0 ? GOLD_T : INK_T, 3, 1.3);
        api.sfx("t_game");
        if (g > 0) api.flash("#FFF0C2", 0.1);
        S.pendingGame = null;
        if (S.games[0] >= 4 || S.games[1] >= 4) { finishMatch(S.games[0] >= 4); return true; }
        return false;
      }
      function finishMatch(won) {
        S.phase = "matchover"; S.endT = 0; S.won = won;
        ME.mood = won ? "happy" : "sad"; CPU.mood = won ? "sad" : "happy";
        say(won ? "ПОБЕДА!" : "ПОРАЖЕНИЕ", won ? GOLD_T : INK_T, 4, 2.6);
        api.sfx(won ? "win" : "lose"); S.crowd = won ? 3 : 1;
        if (won) api.flash("#FFF0C2", 0.18);
        if (won) fx.emit({ x: 192, y: 90, n: 50, colors: ["#FFF0C2", "#FFD27A", "#FFFFFF", "#8EF0C6", "#7FE6F4"], speed: [30, 140], angle: [-Math.PI, 0], life: [0.6, 1.4], gravity: 80, drag: 1, shape: "star" });
      }
      const clock = () => WG.fmtTime(S.playMs);
      function resolveMatch() {
        if (S.ended) return;
        S.ended = true;
        const gl = S.games[0] + ":" + S.games[1], pl = S.total[0] + ":" + S.total[1];
        const meta = { games: S.games, points: S.total, rally: S.bestRally, opp: opp.name };
        if (S.won) {
          const lost = S.games[1];
          const stars = lost === 0 ? 3 : lost <= 2 ? 2 : 1;
          const hint = stars === 1 ? "★★ — проиграй не больше двух геймов" : stars === 2 ? "★★★ — выиграй всухую, не отдав ни гейма" : "";
          api.clear({ stars, score: S.total[0] * 10 + 40 * stars, ms: Math.round(S.playMs), line: "Счёт " + gl + " по геймам · " + pl + " по очкам · " + clock(), hint, meta });
        } else {
          api.end({ score: S.total[0] * 10, ms: Math.round(S.playMs), won: false, line: "Счёт " + gl + " · против " + opp.gen, hint: opp.tip, meta });
        }
      }
      function resolveTraining() {
        if (S.ended) return;
        S.ended = true;
        api.end({ score: S.score, ms: Math.round(S.playMs), won: S.total[0] >= 8, meta: { points: S.total[0], rally: S.bestRally } });
      }
      function nextPoint() {
        if (S.phase === "matchover") return;
        if (train) {
          if (S.lives <= 0) { S.phase = "matchover"; S.endT = 0; S.won = false; say("КОНЕЦ ТРЕНИРОВКИ", INK_T, 2, 2.6); return; }
          S.pointNo++; S.server = S.pointNo % 2 === 0 ? 1 : -1;
        } else if (startGameAfter()) return;
        setupPoint();
      }

      // ----- the poses of the day -----
      function poseOf(a) {
        const sp = Math.hypot(a.vx, a.vz), sn = Math.min(1, sp / 7);
        if (a.sw) {
          const sw = a.sw;
          let p;
          if (sw.over) {
            if (!sw.commit && !sw.miss) p = mixPose(POSES.ready, POSES.trophy, easeIO(Math.min(1, sw.t / 0.1)));
            else { const t = sw.ct; p = t < 0.04 ? mixPose(POSES.trophy, POSES.smash, t / 0.04) : t < 0.2 ? mixPose(POSES.smash, POSES.sfollow, easeIO((t - 0.04) / 0.16)) : mixPose(POSES.sfollow, POSES.ready, easeIO(Math.min(1, (t - 0.2) / 0.16))); }
          } else {
            const hitP = sw.low ? POSES.low : POSES.hit;
            if (!sw.commit && !sw.miss) p = mixPose(POSES.ready, POSES.wind, easeIO(Math.min(1, sw.t / 0.07)));
            else { const t = sw.ct; p = t < 0.035 ? mixPose(POSES.wind, hitP, t / 0.035) : t < 0.16 ? mixPose(hitP, POSES.follow, easeIO((t - 0.035) / 0.125)) : mixPose(POSES.follow, POSES.ready, easeIO(Math.min(1, (t - 0.16) / 0.2))); }
          }
          return sw.hand < 0 ? mirrorPose(p) : p;
        }
        if (a.srv) {
          const t = a.srv.t;
          if (a.srv.hit) return t < 0.05 ? mixPose(POSES.trophy, POSES.smash, t / 0.05) : t < 0.24 ? mixPose(POSES.smash, POSES.sfollow, easeIO((t - 0.05) / 0.19)) : mixPose(POSES.sfollow, POSES.ready, easeIO(Math.min(1, (t - 0.24) / 0.2)));
          return t < 0.2 ? mixPose(POSES.ready, POSES.toss, easeIO(t / 0.2)) : mixPose(POSES.toss, POSES.trophy, easeIO(Math.min(1, (t - 0.2) / 0.34)));
        }
        if (a.mood === "happy" && S.phase !== "ready") { const k = 0.5 + 0.5 * Math.sin(S.t * 9); const p = mixPose(POSES.ready, POSES.cheer, 0.85); p.hy += k * 1.3; return p; }
        if (a.mood === "sad" && S.phase !== "ready") return mixPose(POSES.ready, POSES.sad, 0.9);
        const p = Object.assign({}, POSES.ready);
        if (a.sv_ready) { p.lhx = -2.0; p.lhy = 21.4; }
        const lat = clamp(a.vx / 7, -1, 1), fwd = clamp(-a.vz / 7, -1, 1);
        if (sn > 0.04) {
          const cyc = [0, 1].map((i) => { const ph = a.rp + i * Math.PI; return { lift: Math.max(0, Math.sin(ph)) * 5.6 * sn, st: Math.cos(ph) }; });
          const lf = cyc[0], rf = cyc[1];
          p.lfx = -3.0 + lat * lf.st * 4.6 - lat * 0.8; p.rfx = 3.0 + lat * rf.st * 4.6 - lat * 0.8;
          p.lfy = lf.lift + lf.st * fwd * 3.0; p.rfy = rf.lift + rf.st * fwd * 3.0;
          p.hy = 16.4 - 1.3 * sn + Math.abs(Math.sin(a.rp * 2)) * 1.1 * sn;
          p.sx = lat * 2.2;
          p.rhx += lat * 1.2; p.lhx += lat * 1.2;
          const sw2 = Math.sin(a.rp);
          p.lhy += sw2 * 1.6 * sn; p.rhy += -sw2 * 0.8 * sn;
          p.hdx = lat * 0.6;
        } else {
          p.hy += Math.sin(S.t * 3 + a.side) * 0.35;
        }
        return p;
      }
      const hairSwing = (a) => clamp(-a.vx * 0.35 + Math.sin(S.t * 5) * 0.4, -2.5, 2.5);

      function ensureStart() { S.phase = "intro"; S.intro = 0; }

      return {
        _state: S, _ball: B, _me: ME, _cpu: CPU, _api: api, _cfg: { OPPS, STYLES },
        _bot(sk, style) {
          S.bot = sk === null ? null : sk;
          ME.ai = sk !== null; if (sk !== null) { ME.sk = sk; ME.st = STYLES[style || "allcourt"]; ME.n = aiNums(ME); }
        },
        start() { ensureStart(); api.sfx("start"); },
        pause() { drag = null; },
        update(dt) {
          S.t += dt;
          fx.update(dt);
          S.cam += (clamp(-B.x * 0.9, -5, 5) - S.cam) * Math.min(1, dt * 2.5);
          for (const p of S.pops) p.t += dt;
          S.pops = S.pops.filter((p) => p.t < 1.0);
          for (const m of marks) m.t += dt;
          if (S.banner) { S.banner.t += dt; if (S.banner.t > S.banner.life) S.banner = null; }
          if (S.crowd > 0) S.crowd -= dt;
          if (NETSHAKE > 0) NETSHAKE -= dt;
          for (const a of [ME, CPU]) {
            const spd = Math.hypot(a.vx, a.vz);
            a.dustT = (a.dustT || 0) - dt;
            if (spd > 5.2 && a.dustT <= 0 && S.phase !== "intro") {
              a.dustT = 0.11;
              const p = project(a.x - a.vx * 0.02, 0, a.z);
              fx.emit({ x: p.x, y: p.y, n: 2, colors: ["#DCEAF6", "#8FA9C2"], speed: [3, 12], angle: [-Math.PI * 0.9, -Math.PI * 0.1], life: [0.15, 0.35], gravity: 20, drag: 2 });
            }
          }
          for (const a of [ME, CPU]) { a.blink -= dt; if (a.blink < -0.12) a.blink = 2 + Math.random() * 3; a.swCd = Math.max(0, a.swCd - dt); a.bufT = Math.max(0, a.bufT - dt); if (a.srv) a.srv.t += dt; }
          if (S.freeze > 0) { S.freeze--; if (inp.pressed("a") || inp.tap) S.pendA = true; if (inp.pressed("b")) S.pendB = true; return; }
          const A_ = inp.pressed("a") || !!inp.tap || S.pendA, B_ = inp.pressed("b") || S.pendB;
          S.pendA = S.pendB = false;
          const bot = S.bot;
          if (S.phase === "intro") {
            S.intro += dt;
            const L0 = ST ? 2.6 : 1.6;
            if (S.intro > L0 || (S.intro > 0.7 && A_)) { setupPoint(); S.pointNo = 0; }
            return;
          }
          if (S.phase === "matchover") {
            S.endT += dt;
            for (const a of [ME, CPU]) { a.px = a.x; a.pz = a.z; a.vx *= 0.9; a.vz *= 0.9; }
            stepBall(dt);
            if (S.endT > 2.7) { if (train) resolveTraining(); else resolveMatch(); }
            return;
          }
          S.playMs += dt * 1000;
          const srv = actor(S.server), rcv = actor(-S.server);
          // ---- getting ready: walk to the places for the serve
          if (S.phase === "ready") {
            S.readyT += dt;
            for (const a of [srv, rcv]) {
              a.px = a.x; a.pz = a.z;
              moveActor(a, a.tgt[0], a.tgt[1], dt, 6.5, 6);
              a.x += a.vx * dt; a.z += a.vz * dt;
              a.rp += dt * (3 + Math.hypot(a.vx, a.vz) * 1.25);
              if (a.mood && S.readyT > 0.5) a.mood = null;
            }
            holdBall();
            if (S.readyT > 0.5) { for (const a of [ME, CPU]) a.mood = null; }
            const arrived = Math.hypot(srv.tgt[0] - srv.x, srv.tgt[1] - srv.z) < 0.4 && Math.hypot(rcv.tgt[0] - rcv.x, rcv.tgt[1] - rcv.z) < 0.5;
            if ((S.readyT > 0.3 && arrived) || S.readyT > 1.1) { S.phase = "serve"; S.sv.t = 0; srv.vx = srv.vz = 0; }
            return;
          }
          if (S.phase === "retry") {
            S.readyT += dt;
            stepBall(dt);
            if (S.readyT > 0.65) { S.phase = "serve"; S.sv = { stage: "wait", t: 0, delay: rand(0.25, 0.45), hitT: 0.6 + gauss() * 0.04 * (1 - srv.sk), aim: 0 }; B.live = false; B.held = true; B.net = false; B.vx = B.vy = B.vz = 0; srv.srv = null; holdBall(); }
            for (const a of [ME, CPU]) { a.px = a.x; a.pz = a.z; a.vx *= 0.8; a.vz *= 0.8; }
            return;
          }
          // ---- the serve itself
          if (S.phase === "serve") {
            const sv = S.sv, human = srv === ME && !bot;
            for (const a of [ME, CPU]) a.px = a.x, a.pz = a.z;
            // the receiver may shuffle a little while the server prepares
            if (rcv === ME && !ME.ai) { humanMove(dt); integrate(ME, dt); }
            else { aiHoverReceiver(rcv, dt); }
            if (sv.stage === "wait") {
              holdBall();
              sv.t += dt;
              srv.sv_ready = true;
              if (human) { S.tipT += dt; if (A_) { tossBall(); srv.sv_ready = false; } }
              else if (sv.t > sv.delay) { tossBall(); srv.sv_ready = false; }
              srv.vx = srv.vz = 0;
            } else if (sv.stage === "toss") {
              sv.t += dt;
              stepBall(dt);
              if (human && A_ && sv.t > 0.2) serveHit();
              else if (!human && sv.t >= sv.hitT) serveHit();
              else if (B.y < 1.15 && B.vy < 0) { B.held = true; sv.stage = "wait"; sv.t = 0; sv.delay = 0.3; srv.srv = null; holdBall(); if (human) say("МЯЧ УПАЛ — ЕЩЁ РАЗ", INK_T, 1, 1.1); }
            }
            return;
          }
          // ---- the rally
          for (const a of [ME, CPU]) { a.px = a.x; a.pz = a.z; }
          if (!S.over) {
            if (bot === null || bot === undefined) {
              humanMove(dt);
              if (A_) startSwing(ME, "drive");
              else if (B_) startSwing(ME, "lob");
            } else aiMove(ME, dt);
            aiMove(CPU, dt);
          } else {
            for (const a of [ME, CPU]) { a.vx *= 0.88; a.vz *= 0.88; }
          }
          for (const a of [ME, CPU]) { integrate(a, dt); if (a.srv && a.srv.hit && a.srv.t > 0.5) a.srv = null; updateSwing(a, dt); }
          stepBall(dt);
          if (S.over) {
            S.overT += dt;
            if (S.overT > 0.85 || (S.overT > 0.4 && A_)) nextPoint();
          }
        },
        draw(g, alpha) { drawScene(g, alpha); },
      };

      // the receiver waits at the baseline, drifting toward the middle
      function aiHoverReceiver(a, dt) {
        a.px = a.x; a.pz = a.z;
        moveActor(a, a.tgt[0], a.tgt[1], dt, 3, 4);
        integrate(a, dt);
      }
      // ----- drawing -----
      function project(x, y, z) { const m = mpp(z); return { x: CX + x * m, y: gy(z) - y * m * HK, m }; }
      function drawScene(g, alpha) {
        const t = S.t;
        const cam = Math.round(S.cam);
        g.fillStyle = "#04070F"; g.fillRect(0, 0, W, H);
        art.sky(g, 0, 0, 384, 30, t, { seed: 7, top: "#04070F", bottom: "#142449", curtain: 0.5, amount: 1 });
        g.drawImage(COURT, cam - OFFX, 0);
        g.save(); g.translate(Math.round(cam * 0.4) - PADX, 0);
        g.drawImage(S.crowd > 0 && Math.floor(t * 6) % 2 ? STANDS_UP : STANDS, 0, 0);
        g.drawImage(MASTS, 0, 0);
        crowdFlash(g, t);
        g.restore();
        g.save(); g.translate(cam, 0); g.drawImage(BEAMS, 0, 0); g.restore();
        drawWorld(g, alpha, cam);
        g.drawImage(VIGN, 0, 0);
        g.drawImage(LAMPS, Math.round(cam * 0.4) - PADX, 0);
        drawHud(g);
      }
      function crowdFlash(g, t) {
        const k = Math.floor(t * 8);
        for (let i = 0; i < 3; i++) {
          const h = hash(k + i * 17, i * 5 + 3);
          if (h < 0.5) continue;
          const x = Math.floor(hash(k, i + 40) * 380) + 2, y = 16 + Math.floor(hash(k, i + 90) * 16);
          g.fillStyle = "#FFFFFF"; g.fillRect(x, y, 1, 1);
          g.fillStyle = "rgba(255,255,255,.45)"; g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3);
        }
      }
      function ballScreen(alpha) {
        const x = lerp(B.px, B.x, alpha), y = lerp(B.py, B.y, alpha), z = lerp(B.pz, B.z, alpha);
        return { x, y, z };
      }
      function drawBall(g, alpha) {
        const b = ballScreen(alpha);
        const p = project(b.x, b.y, b.z);
        const r = Math.max(1.5, Math.round(p.m * 0.078 * 2) / 2);
        // the trail
        const col = B.spin > 0.45 ? "#7FE6F4" : B.spin < -0.3 ? "#C4BBFF" : "#FFF9C4";
        for (let i = 0; i < B.trail.length; i++) {
          const q = project(B.trail[i].x, B.trail[i].y, B.trail[i].z), k = (i + 1) / (B.trail.length + 1);
          g.globalAlpha = 0.12 + 0.4 * k;
          art.disc(g, q.x, q.y, Math.max(1, r * (0.45 + 0.4 * k)), col);
        }
        g.globalAlpha = 1;
        art.disc(g, p.x, p.y, r + 1, "rgba(6,18,10,.85)");
        art.disc(g, p.x, p.y, r, "#9BC91E");
        art.disc(g, p.x - 0.5, p.y - 0.5, Math.max(1, r - 1), "#E8FF5A");
        g.fillStyle = "#FFFFE0"; g.fillRect(Math.round(p.x - r * 0.45), Math.round(p.y - r * 0.55), 1, 1);
        // a seam that turns with the spin
        if (r >= 2.5) { g.fillStyle = "#F4FAC8"; const s = Math.floor(S.t * 20 * (1 + Math.abs(B.spin))) % 3; g.fillRect(Math.round(p.x) - 1 + s % 2, Math.round(p.y) + 1, 2, 1); }
        // when it flies above the picture
        if (p.y < 4) { g.fillStyle = "#E8FF5A"; g.fillRect(Math.round(p.x) - 2, 1, 5, 1); g.fillRect(Math.round(p.x) - 1, 2, 3, 1); g.fillRect(Math.round(p.x), 3, 1, 1); }
      }
      function drawBallShadow(g, alpha) {
        const b = ballScreen(alpha);
        const p = project(b.x, 0, b.z), k = 1 / (1 + b.y * 0.22);
        const w = Math.max(1, Math.round(p.m * 0.085 * (1 + b.y * 0.05) * 1)), h = Math.max(1, Math.round(w * 0.45));
        art.ellipse(g, p.x, p.y, w, Math.max(1, h), "rgba(2,8,18," + (0.2 + 0.4 * k).toFixed(2) + ")");
      }
      function drawActor(g, a, alpha) {
        const x = lerp(a.px, a.x, alpha), z = lerp(a.pz, a.z, alpha);
        const p = project(x, 0, z);
        const P = poseOf(a);
        if (B.held && actor(S.server) === a) { /* the ball in the hand is drawn after */ }
        drawFigure(g, a.look, a.side > 0 ? 1 : -1, p.x, p.y, p.m / MPP0, P, { blink: a.blink < 0, swing: hairSwing(a), mood: a.mood });
        a._hand = { x: p.x, y: p.y, U: (p.m / MPP0) * FIG, P };
      }
      function drawHeldBall(g) {
        const a = actor(S.server);
        if (!a._hand || (S.phase !== "serve" && S.phase !== "ready" && S.phase !== "retry") || !B.held) return;
        const h = a._hand, sg = a.side > 0 ? 1 : -1;
        const x = h.x + sg * (h.P.lhx) * h.U, y = h.y - (h.P.lhy + 1.4) * h.U;
        art.disc(g, x, y, 2, "rgba(6,18,10,.85)"); art.disc(g, x, y, 1.5, "#E8FF5A"); g.fillStyle = "#FFFFE0"; g.fillRect(Math.round(x) - 1, Math.round(y) - 1, 1, 1);
      }
      function drawWorld(g, alpha, cam) {
        g.save(); g.translate(cam, 0);
        // ball marks on the court
        for (const m of marks) {
          if (m.t > 3) continue;
          const p = project(m.x, 0, m.z); const k = 1 - m.t / 3;
          g.fillStyle = "rgba(232,255,90," + (0.28 * k).toFixed(2) + ")"; g.fillRect(Math.round(p.x - 1), Math.round(p.y), Math.max(2, Math.round(p.m * 0.1)), 1);
        }
        drawBallShadow(g, alpha);
        for (const sd of [-1, 1]) {
          const p = project(sd * 6.9, 0, -13.6), bob = Math.floor(S.t * 1.4 + sd) % 2;
          art.ellipse(g, p.x, p.y + 1, 5, 2, "rgba(2,8,20,.4)");
          g.drawImage(KID, Math.round(p.x - 4), Math.round(p.y - 12 + bob));
        }
        drawActor(g, CPU, alpha);
        // the far side of the net: the ball behind it is seen through the mesh
        const bz = lerp(B.pz, B.z, alpha);
        const showBall = S.phase !== "intro" && S.phase !== "ready";
        if (showBall && bz < 0 && !B.held) drawBall(g, alpha);
        {
          const cxp = 192 - Math.round(6.7 * mpp(0)) - 9, cyp = Math.round(gy(0)) - 36;
          g.drawImage(CHAIR, cxp, cyp);
          g.drawImage(UMP, cxp + 5 + clamp(Math.round(B.x / 3), -1, 1), cyp + 6);
        }
        const shk = NETSHAKE > 0 ? Math.round(Math.sin(NETSHAKE * 60) * 1) : 0;
        g.drawImage(NET.c, CX - NET.ox, NET.y0 - NET.oy + shk);
        drawActor(g, ME, alpha);
        drawHeldBall(g);
        if (showBall && bz >= 0 && !B.held) drawBall(g, alpha);
        fx.draw(g);
        drawPops(g);
        g.restore();
      }
      function drawPops(g) {
        for (const p of S.pops) {
          const k = p.t / 1.0, y = p.y - Math.round(k * 14);
          if (k > 0.75 && Math.floor(p.t * 18) % 2) continue;
          WG.text(g, p.text, p.x, y, { align: "center", color: p.color, outline: "#04070F" });
        }
      }

      // ----- the scoreboard and the rest of the screen furniture -----
      function panel(g, x, y, w, h) {
        g.fillStyle = "rgba(6,10,24,.84)"; g.fillRect(x, y, w, h);
        g.fillStyle = "#26324F"; g.fillRect(x, y, w, 1); g.fillRect(x, y + h - 1, w, 1); g.fillRect(x, y, 1, h); g.fillRect(x + w - 1, y, 1, h);
        g.fillStyle = "#34D399"; g.fillRect(x + 1, y + 1, 2, h - 2);
      }
      function ballIcon(g, x, y) { art.disc(g, x, y, 2.5, "#9BC91E"); art.disc(g, x - 0.5, y - 0.5, 1.5, "#E8FF5A"); g.fillStyle = "#FFFFE0"; g.fillRect(x - 1, y - 1, 1, 1); }
      function drawHud(g) {
        if (S.phase === "intro") return drawIntro(g);
        if (train) {
          panel(g, 3, 3, 98, 25);
          WG.text(g, "ТРЕНИРОВКА", 9, 6, { color: "#A9B6CD", shadow: "#04070F" });
          WG.text(g, "ОЧКИ", 9, 16, { color: "#8EF0C6", shadow: "#04070F" });
          WG.text(g, WG.fmtNum(S.score), 40, 14, { scale: 2, color: INK_T, shadow: "#04070F" });
          for (let i = 0; i < 3; i++) ballIcon(g, 380 - 8 - i * 9, 8);
          for (let i = 0; i < 3 - Math.max(0, S.lives); i++) { g.fillStyle = "rgba(4,7,15,.85)"; g.fillRect(380 - 8 - i * 9 - 3, 5, 7, 7); }
          const best = api.best;
          const label = best !== null && best !== undefined ? (S.score > best ? "НОВЫЙ РЕКОРД!" : "РЕКОРД " + WG.fmtNum(best)) : "СЕРИЯ " + S.streak;
          WG.text(g, label, 380, 17, { align: "right", color: best !== null && S.score > best ? "#FFD27A" : "#A9B6CD", shadow: "#04070F" });
        } else {
          panel(g, 3, 3, 96, 23);
          const sv = S.server;
          WG.text(g, "ВЫ", 15, 6, { color: "#EAF0FA", shadow: "#04070F" });
          WG.text(g, opp.name.toUpperCase(), 15, 16, { color: "#C9D6F2", shadow: "#04070F" });
          if (sv > 0) ballIcon(g, 11, 9); else ballIcon(g, 11, 19);
          WG.text(g, String(S.games[0]), 64, 6, { align: "right", scale: 1, color: "#FFD27A", shadow: "#04070F" });
          WG.text(g, String(S.games[1]), 64, 16, { align: "right", color: "#FFD27A", shadow: "#04070F" });
          g.fillStyle = "#26324F"; g.fillRect(68, 5, 1, 17);
          WG.text(g, ptsText(S.pts[0]), 92, 6, { align: "right", color: INK_T, shadow: "#04070F" });
          WG.text(g, ptsText(S.pts[1]), 92, 16, { align: "right", color: INK_T, shadow: "#04070F" });
          // the stage and the stars still in reach
          const lost = S.games[1];
          const n = lost === 0 ? 3 : lost <= 2 ? 2 : 1;
          WG.text(g, "МАТЧ " + api.stage + " ИЗ 7", 192, 3, { align: "center", color: "#C9D6F2", outline: "#04070F" });
          for (let i = 0; i < 3; i++) WG.text(g, "★", 192 - 10 + i * 8, 12, { color: i < n ? "#FFD27A" : "#3B4766", outline: "#04070F" });
        }
        if (S.rally >= 4 && S.phase === "rally" && !S.over) WG.text(g, "РОЗЫГРЫШ " + S.rally, 192, 23, { align: "center", color: "#EAF0FA", outline: "#04070F" });
        // the serve prompts
        if (S.phase === "serve" && S.server > 0 && !ME.ai) drawServeUi(g);
        if (S.phase === "serve" && S.server < 0 && S.total[0] + S.total[1] < 2 && !ME.ai) WG.text(g, "ПРИНИМАЙ: БЕГИ К МЯЧУ И ЖМИ «УДАР»", 192, 200, { align: "center", color: "#A9B6CD", shadow: "#04070F" });
        if (S.banner) drawBanner(g);
      }
      function drawServeUi(g) {
        const sv = S.sv;
        if (S.serveNo === 2) WG.text(g, "ВТОРАЯ ПОДАЧА", 192, 36, { align: "center", color: "#FFD27A", shadow: "#04070F" });
        if (sv.stage === "wait") {
          const early = S.total[0] + S.total[1] < 3;
          WG.text(g, early ? "УДАР — ПОДБРОСИТЬ МЯЧ" : "ПОДАЧА", 192, 203, { align: "center", color: "#FFD27A", shadow: "#04070F" });
          if (early) WG.text(g, "← → — КУДА ПОДАВАТЬ", 192, 193, { align: "center", color: "#A9B6CD", shadow: "#04070F" });
        } else if (sv.stage === "toss") {
          // the timing gauge: strike when the ball stops at the top
          const x0 = 148, w = 88, y = 203;
          g.fillStyle = "rgba(6,10,24,.85)"; g.fillRect(x0 - 2, y - 2, w + 4, 9);
          g.fillStyle = "#26324F"; g.fillRect(x0, y, w, 5);
          const zone = (a, b, c) => { g.fillStyle = c; g.fillRect(x0 + Math.round(a * w), y, Math.round((b - a) * w), 5); };
          const map = (tt) => clamp((tt - 0.15) / 0.9, 0, 1);
          zone(map(0.45), map(0.76), "#1FA874"); zone(map(0.55), map(0.65), "#FFD27A");
          const cx = x0 + Math.round(map(sv.t) * w);
          g.fillStyle = "#FFFFFF"; g.fillRect(cx, y - 2, 1, 9);
          WG.text(g, "УДАР!", 192, 192, { align: "center", color: sv.t > 0.5 && sv.t < 0.7 ? "#FFD27A" : "#A9B6CD", shadow: "#04070F" });
        }
      }
      function drawBanner(g) {
        const b = S.banner, k = b.t / b.life;
        const pop = b.t < 0.12 ? 1 + (1 - b.t / 0.12) * 0.5 : 1;
        const sc = Math.max(1, Math.round(b.scale * pop));
        if (k > 0.85 && Math.floor(b.t * 20) % 2) return;
        WG.text(g, b.text, 192, 78 - Math.round(sc * 3.5) - Math.round(k * 4), { scale: sc, align: "center", color: b.color, outline: "#04070F" });
      }
      function wrapText(text, maxPx) {
        const words = text.split(" "), lines = [];
        let cur = "";
        for (const w of words) { const t = cur ? cur + " " + w : w; if (WG.textWidth(t) > maxPx && cur) { lines.push(cur); cur = w; } else cur = t; }
        if (cur) lines.push(cur);
        return lines;
      }
      function statBar(g, x, y, label, v, color, lw) {
        WG.text(g, label, x, y, { color: "#A9B6CD", shadow: "#04070F" });
        const n = clamp(Math.round(v * 5), 1, 5), bx = x + lw;
        for (let i = 0; i < 5; i++) { g.fillStyle = i < n ? color : "#26324F"; g.fillRect(bx + i * 5, y, 4, 6); if (i < n) { g.fillStyle = tone(color, 1.35); g.fillRect(bx + i * 5, y, 4, 1); } }
      }
      function drawIntro(g) {
        const T0 = ST ? 2.2 : 1.2;
        const k = Math.min(1, S.intro / 0.35), out = S.intro > T0 ? Math.min(1, (S.intro - T0) / 0.4) : 0;
        const a = k * (1 - out), slide = Math.round((1 - Math.min(1, S.intro / 0.5)) * 40);
        g.fillStyle = "rgba(4,7,15," + (0.78 * a).toFixed(2) + ")"; g.fillRect(0, 46, W, 104);
        g.fillStyle = "rgba(52,211,153," + a.toFixed(2) + ")"; g.fillRect(0, 46, W, 1); g.fillRect(0, 149, W, 1);
        g.globalAlpha = a;
        // the two of them, on their toes, over the line
        drawFigure(g, ME.look, 1, 54 - slide, 146, 1.55, POSES.ready, { blink: false });
        drawFigure(g, CPU.look, -1, 330 + slide, 146, 1.55, POSES.ready, { blink: Math.floor(S.intro * 3) % 7 === 0 });
        if (ST) {
          WG.text(g, "МАТЧ " + api.stage + " ИЗ 7", 192, 52, { align: "center", color: "#8EF0C6", shadow: "#04070F" });
          WG.text(g, "ВЫ  ПРОТИВ  " + opp.gen.toUpperCase(), 192, 63, { align: "center", scale: 2, color: INK_T, shadow: "#04070F" });
          WG.text(g, "«" + opp.title.toUpperCase() + "»", 192, 83, { align: "center", color: "#FFD27A", shadow: "#04070F" });
          const lines = wrapText(opp.tip, 190);
          lines.slice(0, 2).forEach((ln, i) => WG.text(g, ln, 192, 98 + i * 9, { align: "center", color: "#C9D6F2", shadow: "#04070F" }));
          const n = CPU.n, st = CPU.st;
          statBar(g, 104, 120, "БЕГ", (n.speed - 4) / 5, "#34D399", 28);
          statBar(g, 104, 129, "СИЛА", (n.pace - 0.72) / 0.5, "#FF6B7A", 28);
          statBar(g, 196, 120, "ТОЧНОСТЬ", 1 - (n.sx - 0.2) / 1.6, "#7FE6F4", 52);
          statBar(g, 196, 129, "ХИТРОСТЬ", (st.open + st.lob + st.drop + st.net) / 1.9 + 0.05, "#C4BBFF", 52);
          WG.text(g, "★★★ — БЕЗ ПОТЕРЯННЫХ ГЕЙМОВ", 192, 139, { align: "center", color: "#7F8FB8", shadow: "#04070F" });
        } else {
          WG.text(g, "ТРЕНИРОВКА", 192, 62, { align: "center", scale: 3, color: GOLD_T, outline: "#2A1E00" });
          WG.text(g, "КАЖДОЕ ВЫИГРАННОЕ ОЧКО — В ЗАЧЁТ", 192, 94, { align: "center", color: "#C9D6F2", shadow: "#04070F" });
          WG.text(g, "ТРИ ОШИБКИ — КОНЕЦ", 192, 105, { align: "center", color: "#C9D6F2", shadow: "#04070F" });
          WG.text(g, "СОПЕРНИК С КАЖДЫМ ОЧКОМ СИЛЬНЕЕ", 192, 120, { align: "center", color: "#7F8FB8", shadow: "#04070F" });
        }
        g.globalAlpha = 1;
      }
    },
  });
})();
