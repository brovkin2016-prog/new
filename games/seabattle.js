/* Морской бой — 10×10, the Russian fleet (1×4, 2×3, 3×2, 4×1; ships never touch, even by a corner), a fleet set by hand
   (drag, tap to turn) or by «Авто», then turns: a hit or a sunk ship gives the same side another shot, a miss passes the turn.
   The sea, the ships, the admirals' portraits and the explosions are all drawn by code under the northern lights.
   Campaign «Адмиралы»: ten admirals, each with a computer of their own; free battle: five levels, the score is 100 − shots.
   Written against the Winger Games engine (engine.js, ENGINE.md). */
"use strict";
(function () {
  const { art, PAL } = WG;
  const clamp = WG.util.clamp, lerp = WG.util.lerp, ease = WG.util.ease;
  const N = 10;
  const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
  const CLASS_NAME = { 1: "катер", 2: "эсминец", 3: "крейсер", 4: "линкор" };
  const CLASS_UP = { 1: "КАТЕР", 2: "ЭСМИНЕЦ", 3: "КРЕЙСЕР", 4: "ЛИНКОР" };
  const LETTERS = "АБВГДЕЖЗИК";
  const idx = (x, y) => y * N + x;

  // ======================================================================================================
  //  the rules: boards, ships, shots
  // ======================================================================================================
  const shipCells = (s) => {
    const out = [];
    for (let i = 0; i < s.len; i++) out.push([s.x + (s.dir === 0 ? i : 0), s.y + (s.dir === 1 ? i : 0)]);
    return out;
  };
  // grid: Int8Array(100) of ship ids (−1 empty). Can a ship of `len` stand at (x, y)? Nothing of another ship within one cell.
  function fits(grid, len, x, y, dir) {
    for (let i = 0; i < len; i++) {
      const cx = x + (dir === 0 ? i : 0), cy = y + (dir === 1 ? i : 0);
      if (cx < 0 || cy < 0 || cx >= N || cy >= N) return false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < N && ny < N && grid[idx(nx, ny)] >= 0) return false;
      }
    }
    return true;
  }
  function gridOf(ships, except) {
    const grid = new Int8Array(100).fill(-1);
    ships.forEach((s, i) => { if (s.placed !== false && i !== except) for (const [x, y] of shipCells(s)) grid[idx(x, y)] = i; });
    return grid;
  }
  // where the computer puts its fleet: how it likes to hide
  function weightOf(style, ship, grid, rnd) {
    const cells = shipCells(ship);
    const edge = cells.filter(([x, y]) => x === 0 || y === 0 || x === N - 1 || y === N - 1).length;
    if (style === "edge") return 0.25 + (edge / ship.len) * 3;
    if (style === "centre") return edge ? 0.12 : 1 + cells.reduce((a, [x, y]) => a + Math.min(x, y, N - 1 - x, N - 1 - y), 0) / ship.len * 0.3;
    if (style === "spread") {
      let near = 9;
      for (const [x, y] of cells) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < N && ny < N && grid[idx(nx, ny)] >= 0) near = Math.min(near, Math.max(Math.abs(dx), Math.abs(dy)));
      }
      return 0.4 + Math.min(near, 5) * (edge ? 0.5 : 1);
    }
    return 1;
  }
  function randomFleet(rnd, style) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const ships = [];
      const grid = new Int8Array(100).fill(-1);
      let ok = true;
      for (const len of FLEET) {
        const st = style === "smart" ? ["random", "spread", "spread", "centre", "centre", "edge"][(rnd() * 6) | 0] : style || "random";
        const cands = [];
        for (let dir = 0; dir < 2; dir++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
          if (len === 1 && dir === 1) continue;
          if (!fits(grid, len, x, y, dir)) continue;
          const s = { len, x, y, dir };
          cands.push({ s, w: weightOf(st, s, grid, rnd) });
        }
        if (!cands.length) { ok = false; break; }
        let tot = 0;
        for (const c of cands) tot += c.w;
        let r = rnd() * tot, pick = cands[cands.length - 1];
        for (const c of cands) { r -= c.w; if (r <= 0) { pick = c; break; } }
        const id = ships.length;
        ships.push({ len, x: pick.s.x, y: pick.s.y, dir: pick.s.dir, placed: true });
        for (const [x, y] of shipCells(pick.s)) grid[idx(x, y)] = id;
      }
      if (ok) return ships;
    }
    throw new Error("fleet");
  }
  // a board = its ships + what has been shot at it (0 not yet, 1 miss, 2 hit, 3 water around a sunk ship)
  function makeBoard(ships) {
    const b = { ships: ships.map((s) => ({ len: s.len, x: s.x, y: s.y, dir: s.dir, hits: 0, sunk: false })), grid: null, shot: new Uint8Array(100), left: ships.length, shots: 0 };
    b.grid = gridOf(b.ships);
    return b;
  }
  // a shot: → {r: "miss" | "hit" | "sunk", ship, autos: [[x, y]…] (water marked around a sunk ship)}
  function shoot(b, x, y) {
    const i = idx(x, y);
    if (b.shot[i]) return null;
    b.shots++;
    const sid = b.grid[i];
    if (sid < 0) { b.shot[i] = 1; return { r: "miss", x, y }; }
    const s = b.ships[sid];
    b.shot[i] = 2; s.hits++;
    if (s.hits < s.len) return { r: "hit", x, y, ship: s, sid };
    s.sunk = true; b.left--;
    const autos = [];
    for (const [cx, cy] of shipCells(s)) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && ny >= 0 && nx < N && ny < N && !b.shot[idx(nx, ny)]) { b.shot[idx(nx, ny)] = 3; autos.push([nx, ny]); }
    }
    return { r: "sunk", x, y, ship: s, sid, autos };
  }

  // ======================================================================================================
  //  the computer's mind: one function, shaped by a config (strategy, slips, thinking time, how it hides)
  //    mode: random | hunt (random search, then finish the ship) | parity (every other cell) | sweep (diagonal lines at
  //          the biggest ship's step) | density (counts every way the ships still left could stand)
  //    slip: the chance each shot is a random one instead of the thought-out one      diag: knows a hit's corners are water
  //    forget: the chance a hit is forgotten at once (the wounded ship is left, searched for again from scratch)
  //    prior: how much it expects ships along the edges (people like them)           delay: seconds of thought
  // ======================================================================================================
  function aiState(rnd) { return { par: (rnd() * 2) | 0, off: (rnd() * 4) | 0, seen: new Set(), lost: new Set() }; }
  function aiChoose(cfg, b, rnd, st) {
    const shot = b.shot;
    const open = [];
    for (let i = 0; i < 100; i++) if (!shot[i]) open.push(i);
    if (!open.length) return null;
    const pickOf = (list) => list[(rnd() * list.length) | 0];
    const toXY = (i) => ({ x: i % N, y: (i / N) | 0 });
    // hits not yet part of a sunk ship, and the cells known to be water
    const hits = [];
    for (let i = 0; i < 100; i++) if (shot[i] === 2 && !b.ships[b.grid[i]].sunk) {
      // a careless captain sometimes loses track of a wounded ship and goes back to searching
      if (!st.seen.has(i)) { st.seen.add(i); if (cfg.forget && rnd() < cfg.forget) st.lost.add(i); }
      if (!st.lost.has(i)) hits.push(i);
    }
    const water = new Uint8Array(100);
    if (cfg.diag) for (const i of hits) {
      const x = i % N, y = (i / N) | 0;
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < N && ny < N) water[idx(nx, ny)] = 1; }
    }
    const live = open.filter((i) => !water[i]);
    const pool = live.length ? live : open;
    if (cfg.mode === "random") return toXY(pickOf(pool));
    if (cfg.slip && rnd() < cfg.slip) return toXY(pickOf(pool));
    const left = b.ships.filter((s) => !s.sunk).map((s) => s.len);
    const minL = Math.min(...left), maxL = Math.max(...left);
    // finishing a ship: continue along a line of hits, else feel around a single one
    if (hits.length && cfg.mode !== "density") {
      const set = new Set(hits);
      // the biggest connected group of hits
      const seen = new Set();
      let best = [];
      for (const h of hits) {
        if (seen.has(h)) continue;
        const group = [], stack = [h];
        seen.add(h);
        while (stack.length) {
          const c = stack.pop();
          group.push(c);
          const x = c % N, y = (c / N) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
            const j = idx(nx, ny);
            if (set.has(j) && !seen.has(j)) { seen.add(j); stack.push(j); }
          }
        }
        if (group.length > best.length) best = group;
      }
      const xs = best.map((c) => c % N), ys = best.map((c) => (c / N) | 0);
      const cand = [];
      const add = (x, y) => { if (x >= 0 && y >= 0 && x < N && y < N && !shot[idx(x, y)] && !water[idx(x, y)]) cand.push(idx(x, y)); };
      if (best.length >= 2) {
        if (Math.min(...ys) === Math.max(...ys)) { add(Math.min(...xs) - 1, ys[0]); add(Math.max(...xs) + 1, ys[0]); }
        else { add(xs[0], Math.min(...ys) - 1); add(xs[0], Math.max(...ys) + 1); }
      } else add(xs[0] - 1, ys[0]), add(xs[0] + 1, ys[0]), add(xs[0], ys[0] - 1), add(xs[0], ys[0] + 1);
      if (cand.length) return toXY(pickOf(cand));
    }
    if (cfg.mode === "hunt") return toXY(pickOf(pool));
    if (cfg.mode === "parity") {
      const p = minL >= 2 ? pool.filter((i) => (((i % N) + ((i / N) | 0)) & 1) === st.par) : pool;
      return toXY(pickOf(p.length ? p : pool));
    }
    if (cfg.mode === "sweep") {
      const m = Math.max(2, maxL);
      const p = pool.filter((i) => (((i % N) + ((i / N) | 0) + st.off) % m) === 0);
      if (p.length) return toXY(pickOf(p));
      const q = pool.filter((i) => (((i % N) + ((i / N) | 0)) & 1) === st.par);
      return toXY(pickOf(q.length ? q : pool));
    }
    // density: every way each ship still afloat could lie across the cells not yet ruled out; target mode wants a hit covered
    const hitSet = new Set(hits);
    const score = new Float64Array(100);
    for (const len of left) for (let dir = 0; dir < 2; dir++) {
      if (len === 1 && dir === 1) continue;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if ((dir === 0 ? x + len : x + 1) > N || (dir === 1 ? y + len : y + 1) > N) continue;
        let ok = true, cover = 0;
        const cells = [];
        for (let k = 0; k < len; k++) {
          const c = idx(x + (dir === 0 ? k : 0), y + (dir === 1 ? k : 0));
          if (shot[c] === 1 || shot[c] === 3 || water[c] || (shot[c] === 2 && !hitSet.has(c) && b.ships[b.grid[c]].sunk)) { ok = false; break; }
          if (hitSet.has(c)) cover++;
          cells.push(c);
        }
        if (!ok) continue;
        if (hits.length && !cover) continue;
        const w = hits.length ? Math.pow(8, cover) : 1;
        for (const c of cells) if (!shot[c]) score[c] += w;
      }
    }
    let bestS = -1, bestC = [];
    for (const i of open) {
      if (water[i]) continue;
      let s = score[i];
      if (!hits.length && cfg.prior) {
        const x = i % N, y = (i / N) | 0;
        const e = x === 0 || y === 0 || x === N - 1 || y === N - 1 ? 1 : x === 1 || y === 1 || x === N - 2 || y === N - 2 ? 0.35 : 0;
        s *= 1 + cfg.prior * e;
      }
      if (s > bestS + 1e-9) { bestS = s; bestC = [i]; } else if (Math.abs(s - bestS) <= 1e-9) bestC.push(i);
    }
    return toXY(pickOf(bestC.length && bestS > 0 ? bestC : pool));
  }

  // the five free-battle levels (adaptive blends them by the player's rating) and the ten admirals
  function levelConfig(level, skill) {
    switch (level) {
      case "easy": return { mode: "random", slip: 0, diag: false, prior: 0, delay: [1.0, 1.6], hide: "edge" };
      case "normal": return { mode: "hunt", slip: 0.1, forget: 0.5, diag: false, prior: 0, delay: [0.8, 1.3], hide: "random" };
      case "hard": return { mode: "parity", slip: 0.04, forget: 0.1, diag: true, prior: 0, delay: [0.6, 1.0], hide: "spread" };
      case "master": return { mode: "density", slip: 0, diag: true, prior: 0.5, delay: [0.45, 0.8], hide: "smart" };
      default: {
        const s = clamp(skill === undefined ? 0.35 : skill, 0, 1);
        return {
          mode: s < 0.2 ? "random" : s < 0.45 ? "hunt" : s < 0.7 ? "parity" : "density",
          slip: lerp(0.15, 0, s), forget: lerp(0.6, 0, s), diag: s >= 0.55, prior: s >= 0.85 ? 0.5 : 0, delay: [lerp(1.2, 0.45, s), lerp(1.7, 0.8, s)],
          hide: s < 0.25 ? "edge" : s < 0.5 ? "random" : s < 0.8 ? "spread" : "smart",
        };
      }
    }
  }
  // shots a win may take for the second star, the computer's habits, and the admiral's look (see the portraits below)
  const ADMIRALS = [
    { name: "Тихон", rank: "Юнга", par: 80, cfg: { mode: "random", slip: 0, diag: false, prior: 0, delay: [1.1, 1.7], hide: "edge" },
      quote: "Я только учусь! Стреляю наугад.", how: "Стреляет наугад", look: "yunga" },
    { name: "Гром", rank: "Боцман", par: 76, cfg: { mode: "hunt", slip: 0.2, forget: 0.75, diag: false, prior: 0, delay: [0.9, 1.5], hide: "random" },
      quote: "Попал — добиваю! Если не отвлекусь.", how: "Добивает, но часто мажет", look: "bosun" },
    { name: "Морошка", rank: "Капитан", par: 72, cfg: { mode: "hunt", slip: 0.1, forget: 0.4, diag: false, prior: 0, delay: [0.85, 1.3], hide: "random" },
      quote: "Нашла корабль — не отпущу.", how: "Находит и добивает", look: "captain" },
    { name: "Север", rank: "Штурман", par: 68, cfg: { mode: "parity", slip: 0.1, forget: 0.3, diag: false, prior: 0, delay: [0.75, 1.2], hide: "random" },
      quote: "Смотрю через клетку — так быстрее.", how: "Ищет через клетку", look: "navigator" },
    { name: "Белуха", rank: "Адмирал", par: 64, cfg: { mode: "parity", slip: 0.04, forget: 0.12, diag: true, prior: 0, delay: [0.7, 1.1], hide: "spread" },
      quote: "Углы — вода. Я это знаю с юности.", how: "Через клетку, углы знает", look: "beluga" },
    { name: "Вьюга", rank: "Мичман", par: 62, cfg: { mode: "sweep", slip: 0.03, forget: 0.1, diag: true, prior: 0, delay: [0.6, 1.0], hide: "edge" },
      quote: "Иду по косым линиям.", how: "Прочёсывает по диагоналям", look: "blizzard" },
    { name: "Айсберг", rank: "Командор", par: 60, cfg: { mode: "density", slip: 0.08, forget: 0.08, diag: true, prior: 0, delay: [0.65, 1.0], hide: "spread" },
      quote: "Считаю, где поместится корабль.", how: "Считает возможные места", look: "iceberg" },
    { name: "Полярис", rank: "Адмирал", par: 58, cfg: { mode: "density", slip: 0.03, diag: true, prior: 0.3, delay: [0.55, 0.9], hide: "centre" },
      quote: "Прячусь в центре. Там искать трудно.", how: "Считает и прячется в центре", look: "polaris" },
    { name: "Метель", rank: "Адмирал", par: 55, cfg: { mode: "density", slip: 0, diag: true, prior: 0.6, delay: [0.5, 0.8], hide: "smart" },
      quote: "Люди любят края. Я знаю, где вы.", how: "Считает и ждёт ваши привычки", look: "storm" },
    { name: "Аврора", rank: "Великий адмирал", par: 52, cfg: { mode: "density", slip: 0, diag: true, prior: 1, delay: [0.4, 0.7], hide: "smart" },
      quote: "Я не ошибаюсь. Удивите меня.", how: "Играет без ошибок", look: "aurora" },
  ];

  // ======================================================================================================
  //  pixel art: ships seen from above, water, frames, flames — all drawn by code, nothing loaded
  // ======================================================================================================
  const INK = ["#FFFFFF", "#FFFFFF", "#EAF0FA", "#EAF0FA", "#C9D6F2", "#C9D6F2", "#A9B6CD"];
  const GOLD_T = ["#FFF0C2", "#FFF0C2", "#FFD27A", "#FFD27A", "#FFD27A", "#C98A1B", "#C98A1B"];
  const CYAN_T = ["#D2FAFF", "#D2FAFF", "#7FE6F4", "#7FE6F4", "#22B8CF", "#22B8CF", "#0B6E8A"];
  const RED_T = ["#FFC2C9", "#FFC2C9", "#FF6B7A", "#FF6B7A", "#D93644", "#D93644", "#8E1F35"];
  const GREEN_T = ["#D8FFE9", "#D8FFE9", "#8EF0C6", "#8EF0C6", "#34D399", "#34D399", "#1FA874"];
  const HULL = { out: "#0A1020", rail: "#EAF0FA", railD: "#7F8CAE", sideD: "#2C3550", deck: "#98A5C5", deckL: "#B0BCD6", deckD: "#7F8CAE", plank: "#8794B6" };
  const ACCENT = { 1: ["#FFD27A", "#C98A1B"], 2: ["#7FE6F4", "#22B8CF"], 3: ["#C4BBFF", "#8B7CF6"], 4: ["#8EF0C6", "#34D399"] };
  const rgba = (hex, a) => "rgba(" + parseInt(hex.slice(1, 3), 16) + "," + parseInt(hex.slice(3, 5), 16) + "," + parseInt(hex.slice(5, 7), 16) + "," + a + ")";

  // one ship, bow to the right, `len` cells long on a cell of C pixels. All its parts are placed by fractions of the length.
  function paintShip(len, C) {
    const H = C % 2 ? C : C - 1, W = C * len;
    const c = WG.canvas(W, H), g = c.getContext("2d");
    const s = C / 15, cy = (H - 1) / 2;
    const hw = Math.max(2, Math.round([2.7, 3.7, 4.7, 5.8][len - 1] * s));
    const x0 = Math.max(1, Math.round(s)), x1 = W - 1 - x0;
    const bowL = Math.round(Math.min(hw * 2.3 + 1, (x1 - x0) * 0.3)), sternL = Math.max(2, Math.round(hw * 0.7));
    const half = (x) => {
      let h = hw;
      if (x > x1 - bowL) { const u = (x - (x1 - bowL)) / bowL; h = hw * (1 - Math.pow(u, 1.75)); }
      if (x < x0 + sternL) { const u = (x0 + sternL - x) / sternL; h = hw * (1 - 0.32 * u * u); }
      return h;
    };
    const top = [], bot = [];
    for (let x = x0; x <= x1; x++) { const h = half(x); top[x] = Math.round(cy - h); bot[x] = Math.round(cy + h); }
    const inside = (x, y) => x >= x0 && x <= x1 && y >= top[x] && y <= bot[x];
    const depthAt = (x, y) => { // steps to the water (1 = the edge itself)
      for (let d = 1; d <= 4; d++) {
        if (!inside(x - d, y) || !inside(x + d, y) || !inside(x, y - d) || !inside(x, y + d)) return d;
      }
      return 5;
    };
    const P = (col, x, y, w, h) => { g.fillStyle = col; g.fillRect(Math.round(x), Math.round(y), w || 1, h || 1); };
    for (let x = x0; x <= x1; x++) for (let y = top[x]; y <= bot[x]; y++) {
      const d = depthAt(x, y);
      let col;
      if (d === 1) col = HULL.out;
      else if (d === 2) col = y <= cy ? HULL.rail : HULL.railD;
      else {
        const k = (y - cy) / Math.max(1, hw);
        col = k < -0.35 ? HULL.deckL : k > 0.4 ? HULL.deckD : HULL.deck;
        if (len > 1 && (x - x0) % 5 === 4 && d > 2 && Math.abs(k) < 0.8) col = HULL.plank;
      }
      P(col, x, y);
    }
    const acc = ACCENT[len];
    const sh = (x, y, w, h) => { g.fillStyle = "rgba(10,16,32,.4)"; g.fillRect(Math.round(x + 1), Math.round(y + 1), w, h); };
    // a gun turret: its barrels (the shadow first), then the round housing lit from the upper left
    const turret = (x, r, bar, back) => {
      const tx = Math.round(x), ty = Math.round(cy), gap = bar > 1 ? Math.max(2, Math.round(r * 0.9)) : 0;
      const blen = Math.round(r * 1.1) + (r > 1 ? 1 : 0);
      for (let pass = 0; pass < 2; pass++) for (let i = 0; i < bar; i++) {
        const by = Math.round(ty + (i - (bar - 1) / 2) * gap);
        const bx = back ? tx - r - blen : tx;
        g.fillStyle = pass ? "#141A2B" : "rgba(10,16,32,.4)";
        g.fillRect(bx + (pass ? 0 : 1), by + (pass ? 0 : 1), r + blen, 1);
        if (pass) { g.fillStyle = "#3B4766"; g.fillRect(back ? bx : tx + r + blen - 1, by, 1, 1); }
      }
      art.disc(g, tx + 1, ty + 1, r + 0.5, "rgba(10,16,32,.45)");
      art.disc(g, tx, ty, r + 0.5, "#141A2B");
      art.disc(g, tx, ty, r - 0.4, "#3B4766");
      art.disc(g, tx - 0.5, ty - 0.5, Math.max(1, r - 1.4), "#5F6F93");
      g.fillStyle = "#C9D6F2"; g.fillRect(tx - Math.round(r * 0.5), ty - Math.round(r * 0.5), 1, 1);
      if (r >= 3) { g.fillStyle = acc[0]; g.fillRect(tx + 1, ty - 1, 1, 1); }
    };
    const bridge = (x, w, h, tall) => {
      const bx = Math.round(x - w / 2), by = Math.round(cy - h / 2);
      sh(bx, by, w, h);
      P("#141A2B", bx - 1, by - 1, w + 2, h + 2);
      P("#566182", bx, by, w, h);
      P("#DCE4F4", bx, by, w - 1, h - 1);
      P("#FFFFFF", bx, by, w - 2, 1);
      if (tall) P(acc[0], bx + 1, by + 2, w - 3, 1);
      P("#3B4766", bx + w - 2, by + 1, 1, Math.max(1, h - 2));
      P("#0B3B4A", bx + w - 2, by + 2, 1, Math.max(1, h - 4));
      P(acc[1], bx, by + h - 2, w - 2, 1);
    };
    const funnel = (x, r) => {
      const fx = Math.round(x), fy = Math.round(cy);
      art.disc(g, fx + 1, fy + 1, r + 0.5, "rgba(10,16,32,.45)");
      art.disc(g, fx, fy, r + 0.5, "#141A2B");
      art.disc(g, fx, fy, r - 0.3, acc[1]);
      art.disc(g, fx - 0.5, fy - 0.5, Math.max(1, r - 1.1), acc[0]);
      art.disc(g, fx + 0.5, fy + 0.5, Math.max(1, r - 1.9), "#0A1020");
    };
    const mast = (x) => {
      const mx = Math.round(x), my = Math.round(cy);
      P("rgba(10,16,32,.4)", mx - 3, my + 1, 7, 1);
      P("#FFFFFF", mx - 3, my, 7, 1);
      P("#141A2B", mx, my - 1, 1, 3);
    };
    const boat = (x, side) => {
      const by = Math.round(cy + side * (hw - 2.5));
      P("#7A3A12", Math.round(x), by, 4, 2); P("#FFB36B", Math.round(x), by, 4, 1);
    };
    const wk = (x) => Math.round(x0 + (x1 - x0) * x);
    if (len === 1) {
      sh(wk(0.28), cy - 1, 5, 3); P("#141A2B", wk(0.28) - 1, cy - 2, 7, 5);
      P("#DCE4F4", wk(0.28), cy - 1, 5, 3); P(acc[0], wk(0.28), cy - 1, 5, 1); P("#0B3B4A", wk(0.28) + 4, cy, 1, 1);
      turret(wk(0.78), 1, 1, false);
    } else if (len === 2) {
      turret(wk(0.8), 2, 1, false); turret(wk(0.09), 2, 1, true);
      funnel(wk(0.34), 2); bridge(wk(0.52), 7, 5, false);
      boat(wk(0.24), -1); boat(wk(0.24), 1);
    } else if (len === 3) {
      turret(wk(0.84), 2, 2, false); turret(wk(0.72), 2, 2, false); turret(wk(0.07), 2, 2, true);
      funnel(wk(0.27), 2); bridge(wk(0.45), 9, 7, true); funnel(wk(0.6), 2);
      mast(wk(0.45)); boat(wk(0.17), -1); boat(wk(0.17), 1);
    } else {
      turret(wk(0.85), 3, 2, false); turret(wk(0.72), 3, 2, false); turret(wk(0.09), 3, 2, true); turret(wk(0.2), 3, 2, true);
      funnel(wk(0.36), 2.5); bridge(wk(0.49), 9, 9, true); funnel(wk(0.62), 2.5);
      mast(wk(0.49)); boat(wk(0.29), -1); boat(wk(0.29), 1);
    }
    // the pennant at the stern
    P(acc[0], x0 + 1, cy - 1, 2, 2); P("#FFFFFF", x0 + 1, cy - 1, 1, 1);
    return c;
  }
  // the burnt wreck of a sunk ship: dark, with holes and a few embers
  function charred(src, seed) {
    const w = src.width, h = src.height, c = WG.canvas(w, h), g = c.getContext("2d");
    g.drawImage(src, 0, 0);
    const img = g.getImageData(0, 0, w, h), d = img.data, rnd = WG.rng(seed || 3);
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const L = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) / 255;
      const q = Math.floor(L * 4) / 4; // four steps, like a palette
      d[i] = 18 + q * 78; d[i + 1] = 13 + q * 52; d[i + 2] = 14 + q * 48;
      const r = rnd();
      if (r < 0.07) d[i + 3] = 0;
      else if (r > 0.985) { d[i] = 255; d[i + 1] = 120 + (rnd() * 90) | 0; d[i + 2] = 40; }
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  function silhouette(src, color) {
    const c = WG.canvas(src.width, src.height), g = c.getContext("2d");
    g.drawImage(src, 0, 0);
    g.globalCompositeOperation = "source-in"; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
    return c;
  }
  // foam round the hull in two frames (swapped a few times a second)
  function foamOf(src, seed) {
    const w = src.width, h = src.height;
    const sg = src.getContext("2d").getImageData(0, 0, w, h).data;
    const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && sg[(y * w + x) * 4 + 3] > 0;
    const out = [];
    for (let f = 0; f < 2; f++) {
      const c = WG.canvas(w + 2, h + 2), g = c.getContext("2d"), rnd = WG.rng(seed + f * 17);
      for (let y = -1; y <= h; y++) for (let x = -1; x <= w; x++) {
        if (solid(x, y)) continue;
        if (!(solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) continue;
        const bow = x > w * 0.82;
        if (rnd() < (bow ? 0.55 : 0.12)) { g.fillStyle = rnd() > 0.45 ? "rgba(210,250,255,.8)" : "rgba(127,230,244,.6)"; g.fillRect(x + 1, y + 1, 1, 1); }
      }
      // a short wake behind the stern
      for (let i = 0; i < 5; i++) { g.fillStyle = "rgba(210,250,255," + (0.5 - i * 0.09) + ")"; g.fillRect(0, 1 + Math.floor(h / 2) + (i % 2 ? 1 : -1) * (i > 0 ? 1 : 0) + f, 1, 1); }
      out.push(c);
    }
    return out;
  }
  const SHIP_SPRITES = {}; // key C → {len → {h: canvas, v: canvas, ...}}
  function shipSet(C) {
    if (SHIP_SPRITES[C]) return SHIP_SPRITES[C];
    const set = {};
    for (let len = 1; len <= 4; len++) {
      const base = paintShip(len, C);
      const wreck = charred(base, 11 + len);
      const make = (img) => ({ h: img, v: WG.rotate(img, 3) });
      const shade = silhouette(base, "rgba(3,14,30,.5)");
      const foam = foamOf(base, 40 + len);
      set[len] = {
        ship: make(base), wreck: make(wreck), shade: make(shade), glow: make(silhouette(base, "#FFFFFF")),
        foam: [make(foam[0]), make(foam[1])],
      };
    }
    return (SHIP_SPRITES[C] = set);
  }

  // ---------- the water ----------
  const TILES = {};
  function waterTiles(C) {
    if (TILES[C]) return TILES[C];
    const tones = [["#0F4468", "#13557D", "#2A86AE", "#6FD0E6"], ["#0D3D5F", "#114E75", "#2478A0", "#5CC2DA"]];
    const out = tones.map((T, ti) => {
      const frames = [];
      for (let f = 0; f < 4; f++) {
        const c = WG.canvas(C, C), g = c.getContext("2d"), rnd = WG.rng(100 + ti * 9 + f * 31 + C);
        g.fillStyle = T[0]; g.fillRect(0, 0, C, C);
        art.dither(g, 0, 0, C, Math.ceil(C / 2), null, T[1], 0.5);
        for (let k = 0; k < 3; k++) { // the little crests
          const y = 2 + ((rnd() * (C - 5)) | 0), x = 1 + ((rnd() * (C - 7)) | 0), w = 3 + ((rnd() * 4) | 0);
          g.fillStyle = T[2]; g.fillRect(x, y, w, 1);
          if (k === 0 && (f & 1)) { g.fillStyle = T[3]; g.fillRect(x + 1, y, Math.max(1, w - 3), 1); }
        }
        if (f === 0 || f === 2) { g.fillStyle = T[3]; g.fillRect(1 + ((rnd() * (C - 3)) | 0), 1 + ((rnd() * (C - 3)) | 0), 1, 1); }
        // the chart's lines
        g.fillStyle = "rgba(4,24,44,.55)"; g.fillRect(C - 1, 0, 1, C); g.fillRect(0, C - 1, C, 1);
        g.fillStyle = "rgba(160,225,245,.13)"; g.fillRect(0, 0, C - 1, 1); g.fillRect(0, 0, 1, C - 1);
        frames.push(c);
      }
      return frames;
    });
    return (TILES[C] = out);
  }
  // the brass-and-steel frame of a chart
  function frame(g, x, y, w, h, o) {
    o = o || {};
    g.fillStyle = "#0A0F1E"; g.fillRect(x - 3, y - 3, w + 6, h + 6);
    g.fillStyle = "#566182"; g.fillRect(x - 2, y - 2, w + 4, h + 4);
    g.fillStyle = "#B4C0D8"; g.fillRect(x - 2, y - 2, w + 4, 1); g.fillRect(x - 2, y - 2, 1, h + 4);
    g.fillStyle = "#2C3550"; g.fillRect(x - 2, y + h + 1, w + 4, 1); g.fillRect(x + w + 1, y - 2, 1, h + 4);
    g.fillStyle = "#0A0F1E"; g.fillRect(x - 1, y - 1, w + 2, h + 2);
    const ac = o.accent || "#FFD27A";
    for (const [rx, ry] of [[x - 3, y - 3], [x + w + 1, y - 3], [x - 3, y + h + 1], [x + w + 1, y + h + 1]]) { g.fillStyle = ac; g.fillRect(rx + 1, ry + 1, 1, 1); g.fillStyle = "#8B5A0A"; g.fillRect(rx + 2, ry + 2, 1, 1); }
  }
  // a dark plate with a lit edge, for the texts over the sea
  function plate(g, x, y, w, h, o) {
    o = o || {};
    g.fillStyle = "rgba(4,10,24,.62)"; g.fillRect(x, y, w, h);
    g.fillStyle = "#0A0F1E"; g.fillRect(x - 1, y + 1, 1, h - 2); g.fillRect(x + w, y + 1, 1, h - 2); g.fillRect(x + 1, y - 1, w - 2, 1); g.fillRect(x + 1, y + h, w - 2, 1);
    g.fillStyle = o.edge || "#46516F"; g.fillRect(x + 1, y, w - 2, 1); g.fillRect(x, y + 1, 1, h - 2);
    g.fillStyle = "#1D2944"; g.fillRect(x + 1, y + h - 1, w - 2, 1); g.fillRect(x + w - 1, y + 1, 1, h - 2);
  }

  // ---------- the scenery: aurora, mountains, the lighthouse, the sea ----------
  let BG = null;
  function paintBackground() {
    const hor = WG.canvas(384, 50), hg = hor.getContext("2d");
    art.ridge(hg, 0, 44, 384, 16, "#16264F", 3, 50, 0.1);
    art.ridge(hg, 0, 46, 384, 9, "#101C3E", 9, 50, 0.05);
    // snow on the far peaks
    const rnd = WG.rng(5);
    for (let i = 0; i < 70; i++) { const x = (rnd() * 384) | 0; for (let y = 24; y < 46; y++) { const d = hg.getImageData(x, y, 1, 1).data; if (d[3]) { hg.fillStyle = "#3A4F86"; hg.fillRect(x, y, 1 + ((rnd() * 2) | 0), 1); break; } } }
    art.pines(hg, 0, 47, 384, "#0A1530", 21, 3, 7, 5);
    // the lighthouse on its rock
    hg.fillStyle = "#0A1020"; hg.fillRect(22, 40, 18, 7); hg.fillRect(25, 38, 12, 3);
    hg.fillStyle = "#26324F"; hg.fillRect(23, 41, 16, 5);
    for (let i = 0; i < 7; i++) { hg.fillStyle = i % 2 ? "#D93644" : "#EAF0FA"; hg.fillRect(29, 24 + i * 2, 4, 2); }
    hg.fillStyle = "#0A1020"; hg.fillRect(28, 23, 6, 1); hg.fillRect(28, 38, 6, 1); hg.fillRect(28, 24, 1, 14); hg.fillRect(33, 24, 1, 14);
    hg.fillStyle = "#1B2133"; hg.fillRect(27, 20, 8, 4); hg.fillStyle = "#FFD27A"; hg.fillRect(29, 21, 4, 2);
    hg.fillStyle = "#0A1020"; hg.fillRect(30, 17, 2, 3);
    // the sea: light at the horizon, deep below
    const sea = WG.canvas(384, 216), sg = sea.getContext("2d");
    art.bands(sg, 0, 46, 384, 170, ["#1B6E94", "#0F4A6E", "#0A3252", "#071F3A", "#061428"]);
    // far ice floes
    for (let i = 0; i < 14; i++) {
      const x = (rnd() * 384) | 0, y = 52 + ((rnd() * 40) | 0), w = 6 + ((rnd() * 14) | 0);
      sg.fillStyle = "rgba(210,250,255,.28)"; sg.fillRect(x, y, w, 1);
      sg.fillStyle = "rgba(210,250,255,.14)"; sg.fillRect(x + 1, y + 1, w - 2, 1);
    }
    return { hor, sea };
  }
  // animated: the crests running over the sea and the aurora's reflection
  function drawSea(g, t) {
    g.drawImage(BG.sea, 0, 0);
    // the aurora's glow on the water: slow green and violet columns
    for (let k = 0; k < 9; k++) {
      const x = ((k * 53 + t * (4 + (k % 3) * 2)) % 420) - 18, w = 22 + (k % 4) * 9;
      const col = k % 3 === 0 ? "rgba(52,211,153,.2)" : k % 3 === 1 ? "rgba(127,230,244,.16)" : "rgba(139,124,246,.15)";
      art.dither(g, Math.round(x), 46, w, 30 + (k % 3) * 8, null, col, 0.5);
    }
    // crests
    for (let y = 50, r = 0; y < 216; y += 4, r++) {
      const depth = (y - 46) / 170, spd = 6 + depth * 20, len = 5 + Math.round(depth * 10);
      for (let k = 0; k < 7; k++) {
        const base = (r * 37 + k * 61) % 420;
        const x = ((base + t * spd * (r % 2 ? 1 : -1)) % 420 + 420) % 420 - 18;
        const a = 0.1 + depth * 0.12;
        g.fillStyle = (r + k) % 5 === 0 ? "rgba(210,250,255," + (a + 0.1) + ")" : "rgba(127,230,244," + a + ")";
        g.fillRect(Math.round(x), y + ((r * 3 + k) % 3), len, 1);
      }
    }
  }
  const GULL = [
    WG.sprite(["x.....x", ".x...x.", "..xxx.."], { x: "#C9D6F2" }),
    WG.sprite(["..xxx..", ".x...x.", "x.....x"], { x: "#C9D6F2" }),
  ];
  function drawSky(g, t, still) {
    art.sky(g, 0, 0, 384, 48, t, { seed: 5, top: "#04070F", bottom: "#142449", curtain: 0.7, amount: 1 });
    g.drawImage(BG.hor, 0, 0);
    // the lighthouse's beam
    const ph = (t * 0.45) % 1;
    const bright = Math.max(0, Math.sin(ph * Math.PI * 2));
    if (bright > 0.15) {
      g.fillStyle = "rgba(255,240,194," + (0.1 + bright * 0.22) + ")";
      const dir = Math.cos(ph * Math.PI * 2) > 0 ? 1 : -1;
      for (let i = 0; i < 40; i += 2) g.fillRect(dir > 0 ? 32 + i : 30 - i, 21 - ((i * 0.1) | 0), 2, 2 + ((i * 0.12) | 0));
    }
    g.fillStyle = bright > 0.2 ? "#FFF0C2" : "#C98A1B"; g.fillRect(29, 21, 4, 2);
    // gulls
    for (let k = 0; k < 3; k++) {
      const x = ((t * (9 + k * 4) + k * 140) % 460) - 40, y = 10 + k * 7 + Math.sin(t * 0.8 + k) * 3;
      g.drawImage(GULL[Math.floor(t * 3 + k) % 2], Math.round(x), Math.round(y));
    }
  }

  // ---------- flames, shells, smoke ----------
  const FLAME = WG.frames([
    ["....r....", "...rrr...", "...roo...", "..rooor..", ".rooyyor.", ".royyyor.", "rooyywyor", ".ooywwyo.", ".oyyyyyo.", "..ooyoo..", "...rrr..."],
    ["...r.....", "...rr.r..", "..rooorr.", "..rooyor.", ".rooyyor.", ".rooyyyor", ".oyywyyo.", ".oyywwyo.", ".ooyyyoo.", "..oooyo..", "...rrr..."],
    ["....r....", "....rr...", "..r.ror..", "..rooor..", ".roooyor.", "rooyyyor.", "rooyywyor", ".oyywwyo.", ".ooyyyyo.", "..oooyo..", "...rrr..."],
  ], { r: "#D93644", o: "#FF9A3C", y: "#FFD27A", w: "#FFF6D8" });
  const MINI_FLAME = WG.frames([
    ["..r..", ".roo.", "rooyo", "oyywo", ".ooo."],
    [".r...", ".roor", "rooyo", ".oywo", ".ooo."],
    ["...r.", "r.roo", ".rooo", "oyywo", ".ooo."],
  ], { r: "#D93644", o: "#FF9A3C", y: "#FFD27A", w: "#FFF6D8" });
  const SHELL = WG.sprite([".yw.", "ywwy", ".yy."], { y: "#FFD27A", w: "#FFFFFF" });

  // ======================================================================================================
  //  the admirals: ten portraits of 32×32, built from layers (coat, head, hair, hat…) with a mood and a blink
  // ======================================================================================================
  const OUTLINE = "#0A0F1E";
  function figure(look, mood, blink) {
    const c = WG.canvas(32, 32), g = c.getContext("2d");
    const R = (col, x, y, w, h) => { g.fillStyle = col; g.fillRect(x, y, w || 1, h || 1); };
    const D = (col, x, y, w, h, lvl) => art.dither(g, x, y, w, h, null, col, lvl === undefined ? 0.5 : lvl);
    // shoulders: a trapezoid whose left side is lit
    const body = (base, light, dark, o) => {
      o = o || {};
      const rows = [[9, 22], [7, 24], [5, 26], [4, 27], [3, 28], [2, 29], [2, 29], [2, 29]];
      rows.forEach(([a, b], i) => {
        const y = 24 + i;
        R(base, a, y, b - a + 1, 1);
        R(light, a, y, Math.max(2, Math.round((b - a) * 0.22)), 1);
        R(dark, b - Math.round((b - a) * 0.2), y, Math.round((b - a) * 0.2) + 1, 1);
      });
      if (o.seam !== false) { R(dark, 16, 27, 1, 5); }
    };
    // a head: a squarish ellipse, lit from the upper left, shaded on the right and under the chin
    const head = (skin, light, dark, o) => {
      o = o || {};
      const cx = 16, cy = o.cy || 13.5, rx = o.rx || 7, ry = o.ry || 8.5, p = o.p || 2.5, jaw = o.jaw === undefined ? 0.18 : o.jaw;
      R(dark, 14, 20, 5, 5); R(skin, 14, 20, 4, 3); // the neck
      for (let y = 3; y < 24; y++) for (let x = 5; x < 28; x++) {
        const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
        const w = ny > 0 ? 1 - jaw * ny * ny : 1;
        const v = Math.pow(Math.abs(nx) / w, p) + Math.pow(Math.abs(ny), p);
        if (v > 1) continue;
        let col = skin;
        if (nx < -0.2 && ny < 0.25) col = light;
        if (nx > 0.55 || ny > 0.82) col = dark;
        else if (nx > 0.4 && ny > 0.1) col = dark;
        R(col, x, y);
      }
      if (o.ears !== false) { R(skin, 8, 13, 1, 3); R(dark, 8, 15, 1, 1); R(skin, 24, 13, 1, 3); R(dark, 24, 15, 1, 1); R(light, 8, 13, 1, 1); }
    };
    const eyes = (iris, o) => {
      o = o || {};
      const big = o.big, y = o.y || 13, lid = o.lid || "#141A2B";
      for (const x of [11, 18]) {
        if (blink) { R(lid, x, y + 1, 3, 1); continue; }
        if (big) { R("#FFFFFF", x, y - 1, 3, 3); R(iris, x + 1, y - 1, 1, 3); R("#0A0F1E", x + 1, y, 1, 1); R("#FFFFFF", x + 1, y - 1, 1, 1); R(lid, x, y - 2, 3, 1); }
        else { R("#FFFFFF", x, y, 3, 2); R(iris, x + 1, y, 1, 2); R("#0A0F1E", x + 1, y + 1, 1, 1); R(lid, x, y - 1, 3, 1); }
      }
    };
    const brows = (col, o) => {
      o = o || {};
      const y = (o.y || 11) + (mood === "happy" ? -1 : 0), th = o.thick ? 2 : 1;
      if (mood === "sad") { R(col, 10, y + 1, 2, th); R(col, 12, y, 2, th); R(col, 18, y, 2, th); R(col, 20, y + 1, 2, th); }
      else if (o.stern) { R(col, 10, y, 2, th); R(col, 12, y + 1, 2, th); R(col, 18, y + 1, 2, th); R(col, 20, y, 2, th); }
      else { R(col, 10, y, 4, th); R(col, 18, y, 4, th); }
    };
    const nose = (dark, light) => { R(dark, 15, 16, 2, 1); R(dark, 15, 15, 1, 1); if (light) R(light, 16, 14, 1, 1); };
    const mouth = (o) => {
      o = o || {};
      const y = o.y || 19, col = o.col || "#9E2340";
      if (mood === "happy") { R("#5A0E24", 14, y, 4, 2); R("#FFFFFF", 14, y, 4, 1); R(col, 13, y - 1, 1, 1); R(col, 18, y - 1, 1, 1); }
      else if (mood === "sad") { R(col, 14, y + 1, 4, 1); R(col, 13, y + 2, 1, 1); R(col, 18, y + 2, 1, 1); }
      else if (o.smirk) { R(col, 14, y, 3, 1); R(col, 17, y - 1, 2, 1); }
      else if (o.smile) { R(col, 14, y, 4, 1); R(col, 13, y - 1, 1, 1); R(col, 18, y - 1, 1, 1); }
      else R(col, 14, y, 4, 1);
    };
    const buttons = (col, ys, xs) => { for (const y of ys) for (const x of xs) R(col, x, y, 1, 1); };

    if (look === "yunga") {
      body("#25498A", "#3B66B8", "#16305E");
      // the sailor collar
      for (let i = 0; i < 6; i++) { R("#EAF0FA", 9 + i, 24 + i, 5 - Math.max(0, i - 3), 1); R("#EAF0FA", 22 - i - 4 + Math.max(0, i - 3), 24 + i, 5 - Math.max(0, i - 3), 1); }
      R("#25498A", 11, 25, 1, 1); R("#25498A", 21, 25, 1, 1); R("#25498A", 12, 27, 1, 1); R("#25498A", 20, 27, 1, 1);
      R("#D93644", 15, 27, 3, 2); R("#FF6B7A", 15, 27, 1, 1);
      head("#F5CDA6", "#FFE3C4", "#D99B76", { ry: 8, jaw: 0.28 });
      R("#D9742B", 9, 8, 2, 5); R("#D9742B", 22, 8, 2, 5); R("#F59A4A", 9, 8, 1, 3); // ginger tufts
      eyes("#2E7FD8", { big: true, y: 14 }); brows("#B5561A", { y: 11 });
      for (const [x, y] of [[10, 16], [12, 17], [20, 16], [22, 17], [11, 18]]) R("#D58A5C", x, y);
      nose("#D99B76"); mouth({ smile: true, y: 19 });
      R("#FF9AA6", 10, 17, 2, 1); R("#FF9AA6", 21, 17, 2, 1);
      // the knitted cap with a pompom
      for (let y = 3; y < 10; y++) for (let x = 8; x < 25; x++) {
        const nx = (x + 0.5 - 16) / 8.4, ny = (y + 0.5 - 10) / 6.8;
        if (nx * nx + ny * ny > 1 || y > 9) continue;
        R(nx < -0.3 && ny < 0 ? "#7FE6F4" : nx > 0.5 ? "#0B6E8A" : "#22B8CF", x, y);
      }
      for (let x = 8; x < 25; x++) { R(x % 2 ? "#D2FAFF" : "#9AE8F4", x, 9, 1, 2); }
      for (let x = 9; x < 24; x += 3) R("#0B6E8A", x, 5, 1, 3);
      art.disc(g, 16, 3, 2.5, "#EAF0FA"); R("#FFFFFF", 15, 2, 1, 1); R("#9AA5C0", 17, 4, 1, 1);
    } else if (look === "bosun") {
      body("#4E3424", "#7A5236", "#2E1D12");
      // the striped sailor's shirt in the open jacket
      for (let y = 24; y < 32; y++) { const w = Math.min(5, 2 + (y - 24)); for (let x = 16 - w; x < 16 + w; x++) R((y + 0) % 2 ? "#EAF0FA" : "#25498A", x, y); }
      R("#7A5236", 16, 27, 1, 5);
      head("#E0A878", "#F2C497", "#B87A52", { rx: 7.4, ry: 8.2, p: 3.1, jaw: 0.08 });
      for (let x = 10; x < 23; x++) for (let y = 16; y < 22; y++) if ((x + y) % 2 === 0 && Math.hypot(x - 16, y - 16) < 7) R("#9B6A44", x, y); // stubble
      eyes("#4E3424", { y: 13 }); brows("#6B2E0A", { y: 11, thick: true, stern: true });
      nose("#B87A52", "#F2C497");
      // the walrus moustache and a grin under it
      R("#B3541F", 10, 17, 12, 2); R("#D9742B", 10, 17, 5, 1); R("#7A3410", 9, 19, 2, 2); R("#7A3410", 21, 19, 2, 2); R("#B3541F", 11, 19, 1, 1); R("#B3541F", 20, 19, 1, 1);
      if (mood === "sad") R("#7A3410", 14, 20, 4, 1); else { R("#3A0A14", 13, 19, 6, 2); R("#FFFFFF", 14, 19, 4, 1); }
      R("#FFD27A", 8, 16, 1, 2); // the earring
      // the red bandana with white dots, knotted at the side
      for (let y = 4; y < 10; y++) for (let x = 8; x < 25; x++) {
        const nx = (x + 0.5 - 16) / 8.6, ny = (y + 0.5 - 11) / 7.2;
        if (nx * nx + ny * ny > 1) continue;
        R(nx > 0.5 ? "#8E1F35" : "#D93644", x, y);
      }
      R("#8E1F35", 8, 10, 17, 1); R("#FF6B7A", 11, 5, 3, 1);
      for (const [x, y] of [[12, 6], [16, 5], [20, 7], [14, 8], [18, 8], [10, 9]]) R("#FFC2C9", x, y);
      R("#D93644", 24, 9, 4, 3); R("#8E1F35", 25, 11, 3, 2); R("#D93644", 5, 9, 3, 2);
    } else if (look === "captain") {
      body("#1D2F5C", "#35508F", "#101C3A");
      R("#EAF0FA", 13, 24, 6, 3); R("#141A2B", 15, 25, 2, 4); R("#C9D6F2", 13, 24, 1, 2); // shirt and tie
      R("#2C467E", 12, 24, 1, 4); R("#2C467E", 19, 24, 1, 4);
      buttons("#FFD27A", [28, 30], [11, 21]); R("#FFD27A", 5, 25, 4, 1); R("#FFD27A", 23, 25, 4, 1); R("#C98A1B", 5, 26, 4, 1); R("#C98A1B", 23, 26, 4, 1);
      // the long hair behind and the braid over the shoulder
      for (let y = 6; y < 28; y++) { const w = y < 20 ? 3 : y < 26 ? 4 : 3; R("#C46E14", 7 - (y > 22 ? 1 : 0), y, w, 1); R("#C46E14", 22 + (y > 22 ? 1 : 0) - 1, y, w, 1); }
      for (let i = 0; i < 6; i++) { R(i % 2 ? "#E8902A" : "#FFB347", 22 + (i % 2), 18 + i * 2, 3, 2); }
      head("#F5D0AE", "#FFE6CC", "#D9A07C", { ry: 8.2, jaw: 0.3 });
      R("#E8902A", 9, 8, 14, 3); R("#FFB347", 10, 8, 6, 1); R("#C46E14", 20, 9, 3, 2); // the fringe
      eyes("#1FA874", { y: 13 }); brows("#B8620F", { y: 11 });
      nose("#D9A07C"); mouth({ smirk: true, y: 18, col: "#D9566A" });
      // the peaked cap
      for (let y = 3; y < 9; y++) for (let x = 8; x < 25; x++) { const nx = (x + 0.5 - 16) / 8.5, ny = (y + 0.5 - 9) / 6; if (nx * nx + ny * ny <= 1) R(nx < -0.35 ? "#2C467E" : nx > 0.5 ? "#101C3A" : "#1D2F5C", x, y); }
      R("#EAF0FA", 8, 8, 17, 2); R("#9AA5C0", 8, 9, 17, 1); R("#0A0F1E", 9, 10, 15, 1); R("#26324F", 11, 10, 11, 1);
      R("#FFD27A", 15, 5, 3, 3); R("#FFF0C2", 16, 5, 1, 1); R("#C98A1B", 15, 7, 3, 1);
    } else if (look === "navigator") {
      body("#4E5E85", "#6B7FB0", "#2F3A5C");
      R("#FFD27A", 12, 24, 8, 3); R("#C98A1B", 12, 26, 8, 1); R("#FFF0C2", 13, 24, 3, 1); R("#FFD27A", 18, 27, 2, 4);
      R("#EAF0FA", 16, 27, 1, 5);
      // the hood: a ring of fur round the face
      for (let y = 1; y < 26; y++) for (let x = 3; x < 30; x++) {
        const nx = (x + 0.5 - 16) / 12, ny = (y + 0.5 - 12.5) / 11.5;
        const v = nx * nx + ny * ny;
        if (v > 1 || v < 0.38) continue;
        R(v > 0.82 ? "#EAF0FA" : v > 0.62 ? (nx < 0 ? "#6B7FB0" : "#3E4D78") : (nx < 0 ? "#566892" : "#2F3A5C"), x, y);
      }
      for (let i = 0; i < 26; i++) { const a = i / 26 * 6.283; const x = Math.round(16 + Math.cos(a) * 12.2), y = Math.round(12.5 + Math.sin(a) * 11.7); if (y < 24) { R("#FFFFFF", x, y); } }
      head("#E2B48C", "#F2CCA6", "#B98860", { rx: 6, ry: 7.4, cy: 13.5, jaw: 0.25, ears: false });
      for (let x = 11; x < 22; x++) for (let y = 17; y < 21; y++) if ((x + y) % 2 === 0 && Math.hypot(x - 16, y - 16.5) < 5.6) R("#8A6644", x, y);
      eyes("#4E3424", { y: 13 }); brows("#4E3424", { y: 10 });
      // round glasses with a glint
      for (const x of [10, 17]) { R("#141A2B", x, 11, 6, 1); R("#141A2B", x, 15, 6, 1); R("#141A2B", x, 12, 1, 3); R("#141A2B", x + 5, 12, 1, 3); R("#7FE6F4", x + 1, 12, 1, 1); R("#D2FAFF", x + 1, 12, 1, 1); R("#0B6E8A", x + 4, 14, 1, 1); }
      R("#141A2B", 16, 13, 1, 1);
      if (blink) { R("#E2B48C", 11, 13, 4, 2); R("#E2B48C", 18, 13, 4, 2); R("#141A2B", 11, 14, 3, 1); R("#141A2B", 18, 14, 3, 1); }
      nose("#B98860"); mouth({ y: 19, col: "#7A3A2A", smile: true });
    } else if (look === "beluga") {
      body("#DCE4F4", "#FFFFFF", "#9AA5C0");
      R("#2A4D9A", 10, 24, 3, 3); R("#2A4D9A", 19, 24, 3, 3); R("#1B326B", 11, 26, 1, 1);
      R("#FFD27A", 4, 25, 5, 1); R("#FFD27A", 23, 25, 5, 1); R("#C98A1B", 4, 26, 5, 1); R("#C98A1B", 23, 26, 5, 1); R("#FFD27A", 4, 27, 1, 1); R("#FFD27A", 8, 27, 1, 1);
      R("#D93644", 21, 28, 2, 2); R("#2E7FD8", 23, 28, 2, 2); R("#FFD27A", 25, 28, 2, 2);
      head("#F2D6BC", "#FFE9D4", "#CBA283", { rx: 7.2, ry: 8.4, jaw: 0.2 });
      R("#CBA283", 11, 9, 1, 1); R("#CBA283", 20, 9, 1, 1); R("#CBA283", 10, 16, 1, 2);
      eyes("#3B82C4", { y: 13 }); brows("#F4F8FF", { y: 10, thick: true });
      nose("#CBA283");
      // the white beard
      for (let y = 15; y < 28; y++) for (let x = 7; x < 26; x++) {
        const nx = (x + 0.5 - 16) / 9.4, ny = (y + 0.5 - 15) / 12.2;
        if (y < 17 && Math.abs(x - 16) > 6) continue;
        if (nx * nx + ny * ny > 1 || (y < 18 && Math.abs(x - 16) < 3 && y < 17)) continue;
        R(nx < -0.3 ? "#FFFFFF" : nx > 0.35 ? "#B4C0D8" : "#E4ECF8", x, y);
      }
      R("#FFFFFF", 10, 16, 5, 1); R("#FFFFFF", 17, 16, 5, 1); R("#9AA5C0", 21, 18, 1, 1); R("#9AA5C0", 11, 21, 1, 1); R("#9AA5C0", 16, 24, 2, 1);
      if (mood === "sad") R("#7A3A2A", 14, 19, 4, 1); else R("#C98270", 14, 18, 4, 1);
      // the white peaked cap with a gold laurel
      for (let y = 2; y < 9; y++) for (let x = 7; x < 26; x++) { const nx = (x + 0.5 - 16) / 9.2, ny = (y + 0.5 - 9) / 7; if (nx * nx + ny * ny <= 1) R(nx < -0.3 ? "#FFFFFF" : nx > 0.5 ? "#B4C0D8" : "#E8EEF9", x, y); }
      R("#2A4D9A", 7, 8, 19, 2); R("#1B326B", 7, 9, 19, 1); R("#0A0F1E", 9, 10, 15, 1);
      R("#FFD27A", 14, 4, 5, 4); R("#FFF0C2", 15, 4, 3, 1); R("#C98A1B", 14, 7, 5, 1); R("#D93644", 16, 5, 1, 2);
    } else if (look === "blizzard") {
      body("#1B4F6A", "#2F7898", "#0E2F42");
      for (let y = 24; y < 27; y++) R("#EAF0FA", 8 + (y - 24), y, 16 - (y - 24) * 2, 1);
      R("#FFFFFF", 9, 24, 5, 1); R("#C9D6F2", 12, 26, 8, 1);
      // the long ice-blue hair behind the head and down both sides
      for (let y = 7; y < 31; y++) { const w = y < 22 ? 4 : 3; R("#7FC8E8", 6 - (y > 24 ? 1 : 0), y, w, 1); R("#7FC8E8", 22 + (y > 24 ? 1 : 0), y, w, 1); R("#D2FAFF", 6 - (y > 24 ? 1 : 0), y, 1, 1); R("#5FB4DC", 24 + (y > 24 ? 1 : 0), y, 1, 1); }
      for (let y = 9; y < 29; y += 4) { R("#D2FAFF", 7, y, 1, 2); R("#D2FAFF", 23, y + 1, 1, 2); }
      head("#FCEBE6", "#FFF6F2", "#DDB4B0", { rx: 6.6, ry: 8, jaw: 0.35 });
      R("#F4A9A9", 10, 16, 3, 1); R("#F4A9A9", 20, 16, 3, 1);
      eyes("#5FB4DC", { y: 13 }); brows("#7FC8E8", { y: 11 });
      nose("#DDB4B0"); mouth({ smile: true, y: 19, col: "#E0617A" });
      // the grey fur ushanka with a red star and the flaps down
      for (let y = 2; y < 10; y++) for (let x = 7; x < 26; x++) { const nx = (x + 0.5 - 16) / 9.3, ny = (y + 0.5 - 9.5) / 7.5; if (nx * nx + ny * ny <= 1) R(nx < -0.3 ? "#C9D6F2" : nx > 0.5 ? "#7F8CAE" : "#A9B6CD", x, y); }
      for (let x = 7; x < 26; x++) { R(x % 2 ? "#FFFFFF" : "#DCE4F4", x, 9, 1, 2); }
      for (const fx of [6, 24]) for (let y = 10; y < 20; y++) { R(y % 3 ? "#DCE4F4" : "#FFFFFF", fx, y, 3, 1); }
      R("#FFFFFF", 6, 20, 3, 1); R("#FFFFFF", 24, 20, 3, 1);
      R("#D93644", 15, 5, 3, 3); R("#FF6B7A", 16, 5, 1, 1); R("#D93644", 16, 4, 1, 1); R("#D93644", 14, 6, 1, 1); R("#D93644", 18, 6, 1, 1);
    } else if (look === "iceberg") {
      body("#0E3B4A", "#1E6B80", "#08222C");
      for (let y = 24; y < 28; y++) R(y % 2 ? "#B4C0D8" : "#9AA5C0", 7, y, 18, 1);
      R("#DCE4F4", 7, 24, 5, 1); R("#6B7694", 12, 27, 8, 1);
      head("#C9A58C", "#E0C0A6", "#9B7A64", { rx: 7.6, ry: 8.6, p: 2.9, jaw: 0.1 });
      R("#E0C0A6", 12, 4, 7, 1); R("#F0D8C4", 13, 5, 4, 1); R("#E0C0A6", 10, 6, 3, 1);
      for (let x = 9; x < 24; x++) for (let y = 15; y < 23; y++) if ((x * 3 + y) % 2 === 0 && Math.hypot(x - 16, (y - 15) * 0.8) < 7.6) R("#8A98B8", x, y);
      R("#E8D5C4", 10, 14, 1, 1); R("#E8D5C4", 11, 15, 1, 1); R("#E8D5C4", 12, 16, 1, 1); R("#B88A74", 11, 14, 1, 1); R("#B88A74", 12, 15, 1, 1); // the scar
      eyes("#3B4766", { y: 13 }); brows("#3B4766", { y: 10, thick: true, stern: true });
      // the patch over the right eye with its strap across the head
      R("#0A0F1E", 17, 11, 6, 5); R("#26324F", 18, 12, 2, 1);
      for (let i = 0; i < 9; i++) R("#0A0F1E", 17 + Math.round(i * 0.7), 10 - i, 1, 1);
      for (let i = 0; i < 6; i++) R("#0A0F1E", 11 + i, 5 + Math.round(i * 0.9) , 1, 1);
      nose("#9B7A64", "#E0C0A6"); mouth({ y: 20, col: "#5A3A2E" });
      // the pipe, with smoke
      R("#5A3A24", 17, 21, 5, 1); R("#3A2418", 21, 19, 3, 3); R("#6B7694", 21, 18, 3, 1);
      R("#FFB36B", 22, 19, 1, 1); R("#C9D6F2", 23, 16, 1, 1); R("#A9B6CD", 24, 14, 1, 1); R("#7F8CAE", 23, 12, 1, 1);
    } else if (look === "polaris") {
      body("#1B2F5C", "#2F4E92", "#0E1A38");
      R("#EAF0FA", 14, 24, 4, 3); R("#2E7FD8", 15, 25, 2, 3);
      for (const x of [3, 23]) { R("#FFD27A", x, 24, 6, 3); R("#FFF0C2", x, 24, 6, 1); R("#C98A1B", x, 26, 6, 1); for (let i = 0; i < 6; i += 2) R("#C98A1B", x + i, 27, 1, 2); }
      buttons("#FFD27A", [28, 30], [12, 20]);
      R("#FFD27A", 10, 29, 12, 1); R("#2E7FD8", 10, 30, 12, 1);
      head("#8A5A3C", "#A8714E", "#5E3A25", { rx: 7, ry: 8.4, jaw: 0.22 });
      R("#EAF0FA", 8, 8, 2, 5); R("#EAF0FA", 23, 8, 2, 5); R("#C9D6F2", 8, 11, 2, 1);
      eyes("#2B1A10", { y: 13 }); brows("#EAF0FA", { y: 11 });
      nose("#5E3A25", "#A8714E"); mouth({ y: 19, col: "#3A1A10", smile: true });
      R("#C9D6F2", 14, 21, 4, 2); R("#EAF0FA", 15, 21, 2, 1); R("#9AA5C0", 16, 22, 1, 1);
      // the monocle on its chain
      R("#FFD27A", 17, 11, 6, 1); R("#FFD27A", 17, 15, 6, 1); R("#FFD27A", 17, 12, 1, 3); R("#FFD27A", 22, 12, 1, 3); R("#D2FAFF", 18, 12, 1, 1);
      for (let i = 0; i < 6; i++) R("#FFD27A", 22 + (i > 1 ? 1 : 0), 15 + i * 2, 1, 1);
      if (blink) { R("#8A5A3C", 11, 13, 3, 2); R("#8A5A3C", 18, 13, 3, 2); R("#2B1A10", 11, 14, 3, 1); R("#2B1A10", 18, 14, 3, 1); }
      // the midnight cap with the Polaris star
      for (let y = 2; y < 9; y++) for (let x = 7; x < 26; x++) { const nx = (x + 0.5 - 16) / 9, ny = (y + 0.5 - 9) / 7; if (nx * nx + ny * ny <= 1) R(nx < -0.35 ? "#2C467E" : nx > 0.5 ? "#0A1226" : "#14213D", x, y); }
      R("#FFD27A", 7, 8, 19, 1); R("#14213D", 7, 9, 19, 1); R("#0A0F1E", 9, 10, 15, 1); R("#FFD27A", 9, 7, 15, 1);
      R("#FFF0C2", 16, 3, 1, 5); R("#FFF0C2", 14, 5, 5, 1); R("#FFD27A", 15, 4, 3, 3); R("#FFFFFF", 16, 5, 1, 1);
    } else if (look === "storm") {
      body("#3A2E8A", "#5B4DC8", "#21194A");
      R("#C4BBFF", 13, 24, 7, 2); R("#8B7CF6", 13, 26, 7, 1); R("#EDE9FF", 15, 25, 3, 1); R("#C4BBFF", 15, 28, 3, 3); R("#FFFFFF", 16, 29, 1, 1);
      // the hood: a deep violet shape with a pointed top
      for (let y = 0; y < 26; y++) for (let x = 2; x < 31; x++) {
        const nx = (x + 0.5 - 16) / 13, ny = (y + 0.5 - 13) / 13.4;
        const v = Math.pow(Math.abs(nx), 2.2) + Math.pow(Math.abs(ny), 2.4);
        if (v > 1 || (y < 4 && Math.abs(x - 16) > y + 3)) continue;
        const inner = Math.pow(Math.abs(nx) / 0.56, 2.4) + Math.pow((ny + 0.02) / 0.6, 2.4);
        if (inner < 1) continue;
        R(nx < -0.2 ? "#6A5BDD" : nx > 0.5 ? "#21194A" : "#4B3BA8", x, y);
      }
      R("#8B7CF6", 14, 0, 4, 1);
      // the face in shadow, with glowing eyes
      for (let y = 8; y < 22; y++) for (let x = 8; x < 25; x++) { const nx = (x + 0.5 - 16) / 7.4, ny = (y + 0.5 - 15) / 7.2; if (Math.pow(Math.abs(nx), 2.4) + Math.pow(Math.abs(ny), 2.4) <= 1) R(y < 13 ? "#2A2150" : y < 15 ? "#5A4C92" : nx < -0.1 ? "#C9C2E8" : "#A59CCB", x, y); }
      D("#21194A", 9, 13, 15, 3, 0.55);
      if (blink) { R("#2A2150", 11, 13, 4, 2); R("#2A2150", 18, 13, 4, 2); } else { R("#7FE6F4", 11, 12, 4, 2); R("#D2FAFF", 12, 12, 2, 1); R("#7FE6F4", 18, 12, 4, 2); R("#D2FAFF", 19, 12, 2, 1); R("rgba(127,230,244,.4)", 10, 11, 6, 4); R("rgba(127,230,244,.4)", 17, 11, 6, 4); }
      brows("#C4BBFF", { y: 10, stern: true });
      nose("#8A82B0"); R("#E4DFF8", 12, 18, 8, 1); R("#C4BBFF", 11, 19, 2, 1); R("#C4BBFF", 19, 19, 2, 1); R("#C4BBFF", 15, 20, 3, 2); R("#EDE9FF", 16, 21, 1, 1);
      if (mood === "happy") R("#FFFFFF", 14, 18, 4, 1);
      for (const [x, y] of [[4, 6], [27, 9], [3, 20], [28, 24]]) { R("#FFFFFF", x, y); R("#C4BBFF", x + 1, y); R("#C4BBFF", x, y + 1); }
    } else { // aurora
      body("#0E1730", "#1D2D5E", "#070C1C");
      // the sash
      for (let i = 0; i < 8; i++) { R("#34D399", 5 + i * 3, 24 + i, 4, 1); R("#FFD27A", 5 + i * 3, 25 + i, 4, 1); }
      for (const x of [3, 23]) { R("#FFD27A", x, 24, 6, 3); R("#FFF0C2", x, 24, 6, 1); R("#C98A1B", x, 26, 6, 1); }
      R("#8EF0C6", 20, 28, 2, 2); R("#7FE6F4", 22, 28, 2, 2); R("#FFD27A", 24, 28, 2, 2); R("#EAF0FA", 14, 24, 4, 3); R("#FFD27A", 15, 28, 3, 3); R("#FFF0C2", 16, 29, 1, 1);
      // the long aurora hair: green at the crown, cyan, then violet at the ends
      for (let y = 5; y < 31; y++) {
        const col = y < 12 ? "#1FA874" : y < 20 ? "#22B8CF" : "#8B7CF6", hi = y < 12 ? "#8EF0C6" : y < 20 ? "#D2FAFF" : "#C4BBFF";
        const w = y < 22 ? 4 : 3;
        R(col, 5 - (y > 24 ? 1 : 0), y, w, 1); R(col, 23 + (y > 24 ? 1 : 0), y, w, 1); R(hi, 5 - (y > 24 ? 1 : 0), y, 1, 1); R(hi, 23 + (y > 24 ? 1 : 0), y + 1, 1, 1);
      }
      head("#F7D4B8", "#FFE8D4", "#D8A688", { rx: 6.8, ry: 8, jaw: 0.34 });
      for (let x = 9; x < 24; x++) { R(x < 14 ? "#34D399" : x < 19 ? "#22B8CF" : "#8B7CF6", x, 7, 1, 2); }
      R("#8EF0C6", 10, 8, 3, 1); R("#D2FAFF", 15, 8, 3, 1); R("#C4BBFF", 20, 8, 2, 1);
      eyes("#34D399", { y: 13 }); brows("#1FA874", { y: 11 });
      if (!blink) { R("#D2FAFF", 12, 13, 1, 1); R("#D2FAFF", 19, 13, 1, 1); }
      nose("#D8A688"); mouth({ smile: true, y: 19, col: "#D9566A" });
      // the bicorne with gold trim and a green plume
      for (let y = 1; y < 9; y++) for (let x = 3; x < 30; x++) { const nx = (x + 0.5 - 16.5) / 13, ny = (y + 0.5 - 8) / 7.2; if (Math.pow(Math.abs(nx), 2.2) + Math.pow(Math.abs(ny), 2) <= 1 && y >= 2 + Math.abs(nx) * 3) R(nx < -0.3 ? "#26324F" : nx > 0.5 ? "#070C1C" : "#0E1730", x, y); }
      R("#FFD27A", 5, 7, 23, 1); R("#C98A1B", 6, 8, 21, 1);
      R("#FFD27A", 15, 3, 3, 4); R("#FFF0C2", 16, 3, 1, 1); R("#34D399", 16, 5, 1, 1);
      for (let i = 0; i < 7; i++) { R("#34D399", 22 + i, 3 - Math.round(Math.sin(i / 6 * 3) * 2) - (i > 3 ? 0 : 0), 1, 2); R("#8EF0C6", 22 + i, 2 - Math.round(Math.sin(i / 6 * 3) * 2), 1, 1); }
    }
    // a ring of ink round the figure
    const w = 32, h = 32, src = g.getImageData(0, 0, w, h).data;
    const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && src[(y * w + x) * 4 + 3] > 0;
    g.fillStyle = OUTLINE;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!solid(x, y) && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) g.fillRect(x, y, 1, 1);
    return c;
  }
  const FIG_CACHE = {};
  const figureOf = (look, mood, blink) => {
    const k = look + "|" + (mood || "ok") + "|" + (blink ? 1 : 0);
    return FIG_CACHE[k] || (FIG_CACHE[k] = figure(look, mood || "ok", !!blink));
  };
  const PORTRAIT_BG = {
    yunga: ["#1B3A66", "#2E6FA8"], bosun: ["#3A1D1D", "#7A3A24"], captain: ["#16315A", "#2C6B8A"], navigator: ["#102844", "#2E5F8A"],
    beluga: ["#14284C", "#4A7CB8"], blizzard: ["#0F3A52", "#4FA6C8"], iceberg: ["#0B2A38", "#1E6B80"], polaris: ["#0E1A38", "#3B4DA8"],
    storm: ["#21194A", "#5B4DC8"], aurora: ["#04070F", "#142449"],
  };
  // a portrait in its frame at (x, y): the picture is 32×32 inside a 36×36 frame; t drives the blink and the sky of Aurora
  function drawPortrait(g, look, x, y, t, mood, o) {
    o = o || {};
    frame(g, x, y, 32, 32, { accent: o.accent });
    const bg = PORTRAIT_BG[look] || PORTRAIT_BG.yunga;
    if (look === "aurora") art.sky(g, x, y, 32, 32, t, { seed: 21, top: "#04070F", bottom: "#142449", curtain: 0.9, amount: 1.1 });
    else {
      art.bands(g, x, y, 32, 32, [bg[0], bg[1]]);
      for (let i = 0; i < 6; i++) { const sx = x + ((i * 11 + 5) % 32), sy = y + ((i * 7) % 12); if (Math.sin(t * 2 + i * 2) > 0.2) { g.fillStyle = "rgba(255,255,255,.7)"; g.fillRect(sx, sy, 1, 1); } }
    }
    const blink = (t * 0.37 + (look.length % 5) * 0.31) % 1 > 0.94;
    const bob = o.bob ? Math.round(Math.sin(t * 6) * o.bob) : 0;
    g.drawImage(figureOf(look, mood, blink), x, y + bob);
  }

  // ======================================================================================================
  //  sound: two songs (the calm of laying out the fleet, a march for the battle) and the effects of the sea
  // ======================================================================================================
  const bars = (list) => list.join(" ");
  const arpBar = (notes, pat) => pat.split(" ").map((p) => (p === "." ? "." : notes[+p])).join(" ");
  const PLACE_CH = ["Dm", "Bb", "F", "C", "Dm", "Bb", "C", "A"];
  const CHORDS = { Dm: ["D4", "F4", "A4", "D5"], Bb: ["Bb3", "D4", "F4", "Bb4"], F: ["F3", "A3", "C4", "F4"], C: ["C4", "E4", "G4", "C5"], A: ["A3", "C#4", "E4", "A4"] };
  const BASS = { Dm: "D2", Bb: "Bb1", F: "F2", C: "C2", A: "A1" };
  const SONG_PLACE = {
    bpm: 84,
    ch: [
      { w: "p25", v: 0.09, sus: 0.5, notes: bars([
        "A4 - - C5 - - D5 - E5 - - - D5 - - -", "D5 - - - F5 - - - E5 - D5 - C5 - - -", "C5 - - A4 - - C5 - F5 - - - E5 - - -", "G4 - - - C5 - E5 - D5 - - - C5 - - -",
        "A4 - - C5 - - D5 - F5 - - - E5 - D5 -", "D5 - - - F5 - A5 - G5 - - - F5 - - -", "E5 - - G5 - - E5 - D5 - C5 - D5 - - -", "C#5 - - E5 - - A4 - - - - - . . . ."]) },
      { w: "p12", v: 0.045, sus: 0.3, notes: bars(PLACE_CH.map((c) => arpBar(CHORDS[c], "0 . 1 . 2 . 3 . 2 . 1 . 0 . 1 ."))) },
      { w: "tri", v: 0.2, sus: 0.8, notes: bars(PLACE_CH.map((c) => BASS[c] + " - - - - - - - " + BASS[c] + " - - - - - - -")) },
      { w: "noise", v: 0.05, notes: ". . h . . . h . . . h . . . h ." },
    ],
  };
  const BAT_CH = ["Am", "Am", "F", "G", "Am", "Am", "F", "E"];
  const BASS2 = { Am: "A2", F: "F2", G: "G2", E: "E2" };
  const SONG_BATTLE = {
    bpm: 126,
    ch: [
      { w: "p25", v: 0.1, sus: 0.5, notes: bars([
        "A4 . . A4 C5 . E5 . D5 . C5 . B4 . A4 .", "A4 . . A4 C5 . E5 . A5 - - - G5 . E5 .", "F5 . . F5 A5 . F5 . E5 . D5 . C5 . . .", "D5 . . D5 G5 . F5 . E5 . D5 . B4 . D5 .",
        "A4 . . A4 C5 . E5 . D5 . C5 . B4 . A4 .", "E5 . . E5 A5 . G5 . E5 - - - C5 . E5 .", "F5 . A5 . C6 . A5 . F5 . A5 . G5 . F5 .", "E5 - - - G#5 - - - B5 - - - E5 . . ."]) },
      { w: "p12", v: 0.05, sus: 0.3, notes: bars(["Am", "Am", "F", "G", "Am", "Am", "F", "E"].map((c) => ({ Am: "E4 A4 C5 A4 E4 A4 C5 A4 E4 A4 C5 A4 E4 A4 C5 A4", F: "F4 A4 C5 A4 F4 A4 C5 A4 F4 A4 C5 A4 F4 A4 C5 A4", G: "G4 B4 D5 B4 G4 B4 D5 B4 G4 B4 D5 B4 G4 B4 D5 B4", E: "E4 G#4 B4 G#4 E4 G#4 B4 G#4 E4 G#4 B4 G#4 E4 G#4 B4 G#4" }[c]))) },
      { w: "tri", v: 0.22, sus: 0.8, notes: bars(BAT_CH.map((c) => { const r = BASS2[c], o = r.replace("2", "3"); return r + " . " + r + " . " + o + " . " + r + " . " + r + " . " + r + " . " + o + " . " + r + " ."; })) },
      { w: "noise", v: 0.2, notes: "k . h . s . h . k . k . s . h h" },
    ],
  };
  // a few more effects, named so they do not clash with the engine's
  Object.assign(WG.SFX, {
    sb_cannon: [{ w: "noise", f: 700, f2: 90, d: 0.22, v: 0.38, sus: 0.4, r: 0.1 }, { w: "tri", f: 150, f2: 45, d: 0.18, v: 0.32 }],
    sb_splash: [{ w: "noise", f: 4200, f2: 700, d: 0.3, v: 0.22, sus: 0.3, r: 0.15, hp: 800 }, { w: "p25", f: 900, f2: 280, d: 0.09, v: 0.09 }, { w: "p12", f: 1400, f2: 500, t: 0.08, d: 0.07, v: 0.05 }],
    sb_boom: [{ w: "noise", f: 1700, f2: 70, d: 0.5, v: 0.45, sus: 0.4, r: 0.25 }, { w: "tri", f: 120, f2: 35, d: 0.4, v: 0.4 }, { w: "p50", f: 280, f2: 70, d: 0.14, v: 0.12 }],
    sb_sunk: [{ w: "noise", f: 1500, f2: 50, d: 0.95, v: 0.46, sus: 0.45, r: 0.4 }, { w: "tri", f: 100, f2: 26, d: 0.85, v: 0.42 }, { w: "noise", f: 2600, f2: 120, t: 0.25, d: 0.4, v: 0.25, sus: 0.4, r: 0.2 },
      { w: "p25", f: 330, f2: 90, t: 0.1, d: 0.6, v: 0.12, vib: 7 }, { w: "p12", f: 700, f2: 1500, t: 0.55, d: 0.07, v: 0.07 }, { w: "p12", f: 600, f2: 1300, t: 0.68, d: 0.07, v: 0.06 }, { w: "p12", f: 800, f2: 1700, t: 0.78, d: 0.06, v: 0.05 }],
    sb_ping: [{ w: "p50", f: 1568, d: 0.06, v: 0.12, r: 0.25 }, { w: "p50", f: 1568, t: 0.26, d: 0.05, v: 0.05, r: 0.2 }],
    sb_nope: [{ w: "p50", f: 200, d: 0.07, v: 0.16 }, { w: "p50", f: 150, t: 0.08, d: 0.1, v: 0.16 }],
    sb_lock: [{ w: "p25", f: 1320, d: 0.03, v: 0.12 }, { w: "p25", f: 1760, t: 0.04, d: 0.05, v: 0.12 }],
    sb_horn: [{ w: "saw", f: 110, d: 0.5, v: 0.14, sus: 0.8, r: 0.2 }, { w: "tri", f: 165, d: 0.5, v: 0.16, sus: 0.8, r: 0.2 }],
  });

  // ======================================================================================================
  //  drawing the boards
  // ======================================================================================================
  const PL = { x: 26, y: 58, C: 15 };   // the grid while the fleet is laid out
  const EN = { x: 224, y: 58, C: 15 };  // the enemy's waters in the battle
  const MY = { x: 16, y: 58, C: 10 };   // your fleet, small, in the battle
  const cellAt = (L, px, py) => {
    const x = Math.floor((px - L.x) / L.C), y = Math.floor((py - L.y) / L.C);
    return x >= 0 && y >= 0 && x < N && y < N ? { x, y } : null;
  };
  const cellC = (L, x, y) => [L.x + x * L.C + L.C / 2, L.y + y * L.C + L.C / 2];
  const touchy = () => !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
  const shipDim = (s, C) => { const H = C % 2 ? C : C - 1; return s.dir === 0 ? [C * s.len, H] : [H, C * s.len]; };
  // the little ripple that marks a miss
  const RIPPLE = {};
  function rippleOf(C, big) {
    const key = C + (big ? "b" : "");
    if (RIPPLE[key]) return RIPPLE[key];
    const rx = Math.max(2, Math.round(C * (big ? 0.3 : 0.2))), ry = Math.max(1, Math.round(rx * 0.5));
    const c = WG.canvas(rx * 2 + 3, ry * 2 + 3), g = c.getContext("2d");
    g.fillStyle = "rgba(210,250,255,.62)";
    for (let a = 0; a < 64; a++) { const t = a / 64 * Math.PI * 2; g.fillRect(Math.round(rx + 1 + Math.cos(t) * rx), Math.round(ry + 1 + Math.sin(t) * ry), 1, 1); }
    return (RIPPLE[key] = c);
  }
  function drawLabels(g, L) {
    for (let i = 0; i < N; i++) {
      WG.text(g, LETTERS[i], L.x + i * L.C + Math.floor(L.C / 2) - 2, L.y - 10, { color: "#A9B6CD", shadow: "#04070F" });
      const s = String(i + 1);
      WG.text(g, s, L.x - 4 - WG.textWidth(s), L.y + i * L.C + Math.floor(L.C / 2) - 3, { color: "#A9B6CD", shadow: "#04070F" });
    }
  }
  function drawWater(g, L, t, tint) {
    const tiles = waterTiles(L.C);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) g.drawImage(tiles[(i + j) & 1][(Math.floor(t * 2.2) + i * 3 + j * 5) & 3], L.x + i * L.C, L.y + j * L.C);
    if (tint) { g.fillStyle = tint; g.fillRect(L.x, L.y, L.C * N, L.C * N); }
  }
  // one ship at its place on a board; `ship` is {len, x, y, dir}; alive/wreck, drop-in animation `k` (0…1), alpha
  function drawShip(g, L, ship, t, o) {
    o = o || {};
    const set = shipSet(L.C)[ship.len], d = ship.dir === 0 ? "h" : "v";
    const [w, h] = shipDim(ship, L.C);
    let x = L.x + ship.x * L.C + (ship.dir === 0 ? 0 : Math.floor((L.C - w) / 2)), y = L.y + ship.y * L.C + (ship.dir === 0 ? Math.floor((L.C - h) / 2) : 0);
    if (o.px !== undefined) { x = o.px; y = o.py; }
    const bob = o.still ? 0 : Math.round(Math.sin(t * 1.7 + ship.x * 0.9 + ship.y * 1.3) * 0.62);
    const drop = o.drop !== undefined && o.drop < 1 ? (1 - ease(o.drop)) * 10 : 0;
    const wreck = o.wreck;
    if (o.alpha !== undefined) g.globalAlpha = o.alpha;
    if (!wreck) {
      g.drawImage(set.shade[d], x + 1, y + 2 + (o.drop !== undefined && o.drop < 1 ? Math.round(drop * 0.4) : 0));
      if (!o.noFoam) g.drawImage(set.foam[Math.floor(t * 3 + ship.x + ship.y) & 1][d], x - 1, y - 1 + bob);
    }
    g.drawImage(wreck ? set.wreck[d] : set.ship[d], x, y + bob - Math.round(drop));
    if (o.glow && o.glow > 0) { g.globalAlpha = Math.min(1, o.glow) * (o.alpha === undefined ? 1 : o.alpha); g.drawImage(set.glow[d], x, y + bob); }
    g.globalAlpha = 1;
  }
  // the marks left by shots on a board: ripples for misses, fire on the wounded
  function drawMarks(g, L, board, t, seen) {
    const small = L.C < 12;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const v = board.shot[idx(i, j)];
      if (!v) continue;
      const [cx, cy] = cellC(L, i, j);
      if (v === 1) {
        const r = rippleOf(L.C, false), pulse = Math.sin(t * 2 + i + j * 2) > 0.2 ? 0 : 1;
        g.drawImage(r, Math.round(cx - r.width / 2), Math.round(cy - r.height / 2) + pulse);
        if (!small) { g.fillStyle = "rgba(255,255,255,.8)"; g.fillRect(Math.round(cx) - 1, Math.round(cy) - 1 + pulse, 1, 1); }
      } else if (v === 3) {
        g.fillStyle = "rgba(210,250,255,.55)"; g.fillRect(Math.round(cx) - 1, Math.round(cy) - 1, small ? 1 : 2, 1);
        if (!small) g.fillRect(Math.round(cx) - 1, Math.round(cy), 2, 1);
      } else if (v === 2) {
        const ship = board.ships[board.grid[idx(i, j)]];
        if (ship.sunk) continue;
        art.disc(g, cx, cy + 1, small ? 2.5 : 4.5, "rgba(20,8,6,.5)");
        art.dither(g, Math.round(cx) - (small ? 4 : 7), Math.round(cy) - (small ? 5 : 9), small ? 9 : 15, small ? 9 : 15, null, "rgba(255,154,60,.35)", 0.4 + 0.15 * Math.sin(t * 9 + i));
        const f = (small ? MINI_FLAME : FLAME)[Math.floor(t * 9 + i * 2 + j) % 3];
        g.drawImage(f, Math.round(cx - f.width / 2), Math.round(cy - f.height + (small ? 3 : 5)));
      }
    }
  }
  // the reticle: brackets that breathe, and a faint cross over the whole row and column
  function drawReticle(g, L, fx, fy, t, col, o) {
    o = o || {};
    const C = L.C, x = Math.round(L.x + fx * C), y = Math.round(L.y + fy * C);
    const grow = Math.round(Math.sin(t * 8) * 0.9 + 0.5), a = o.dim ? 0.07 : 0.14;
    g.fillStyle = "rgba(255,255,255," + a + ")";
    g.fillRect(L.x, y + (C >> 1), x - L.x, 1); g.fillRect(x + C, y + (C >> 1), L.x + N * C - x - C, 1);
    g.fillRect(x + (C >> 1), L.y, 1, y - L.y); g.fillRect(x + (C >> 1), y + C, 1, L.y + N * C - y - C);
    g.fillStyle = col;
    const n = Math.max(3, C >> 2) + grow;
    for (const [px, py, sx, sy] of [[x - grow, y - grow, 1, 1], [x + C - 1 + grow, y - grow, -1, 1], [x - grow, y + C - 1 + grow, 1, -1], [x + C - 1 + grow, y + C - 1 + grow, -1, -1]]) {
      g.fillRect(px, py, sx * n, 1); g.fillRect(px, py, 1, sy * n);
      if (sx < 0) g.fillRect(px - n + 1, py, n, 1);
      if (sy < 0) g.fillRect(px, py - n + 1, 1, n);
    }
    // the dot in the middle
    g.fillRect(x + (C >> 1), y + (C >> 1), 1, 1);
    if (o.cross) { g.fillRect(x + (C >> 1) - 2, y + (C >> 1), 5, 1); g.fillRect(x + (C >> 1), y + (C >> 1) - 2, 1, 5); }
  }
  function drawButton(g, b, t, o) {
    o = o || {};
    const on = b.enabled !== false, hot = o.focus || o.hover;
    const base = !on ? "#26324F" : b.kind === "go" ? "#1FA874" : b.kind === "fire" ? "#D93644" : "#46516F";
    const lite = !on ? "#3B4766" : b.kind === "go" ? "#8EF0C6" : b.kind === "fire" ? "#FF8F9B" : "#9AA5C0";
    const dark = !on ? "#1D2944" : b.kind === "go" ? "#0B4A33" : b.kind === "fire" ? "#8E1F35" : "#26324F";
    const dy = o.press ? 1 : 0;
    g.fillStyle = "#0A0F1E"; g.fillRect(b.x - 1, b.y, b.w + 2, b.h + 1); g.fillRect(b.x, b.y - 1, b.w, b.h + 3);
    g.fillStyle = dark; g.fillRect(b.x, b.y + 1, b.w, b.h - 1);
    g.fillStyle = base; g.fillRect(b.x, b.y + dy, b.w, b.h - 2);
    g.fillStyle = lite; g.fillRect(b.x, b.y + dy, b.w, 1); g.fillRect(b.x, b.y + dy, 1, b.h - 2);
    if (hot && on) { g.fillStyle = "rgba(255,255,255," + (0.12 + 0.08 * Math.sin(t * 8)) + ")"; g.fillRect(b.x + 1, b.y + dy + 1, b.w - 2, b.h - 4); }
    if (o.focus) { g.fillStyle = "#FFD27A"; const k = Math.floor(t * 6) & 1; g.fillRect(b.x - 2 - k, b.y + 3, 1, b.h - 6); g.fillRect(b.x + b.w + 1 + k, b.y + 3, 1, b.h - 6); }
    WG.text(g, b.label, b.x + Math.floor(b.w / 2), b.y + dy + Math.floor((b.h - 9) / 2), { align: "center", color: on ? "#FFFFFF" : "#5F6F93", shadow: on ? dark : null });
  }
  function drawBubble(g, x, y, w, h, lines, o) {
    o = o || {};
    plate(g, x, y, w, h, { edge: o.edge });
    g.fillStyle = "rgba(4,10,24,.0)";
    lines.forEach((ln, i) => WG.text(g, ln, x + 5, y + 5 + i * 9, { color: o.color || "#EAF0FA" }));
    // the little tail towards the portrait
    g.fillStyle = "#0A0F1E"; g.fillRect(x + 12, y - 4, 5, 4);
    g.fillStyle = "rgba(4,10,24,.8)"; g.fillRect(x + 13, y - 3, 3, 4);
  }
  const wrap = (text, n) => {
    const out = [];
    let line = "";
    for (const w of String(text).split(" ")) {
      if ((line + " " + w).trim().length > n) { if (line) out.push(line); line = w; } else line = (line + " " + w).trim();
    }
    if (line) out.push(line);
    return out;
  };
  // the fleet as little hulls: afloat, sunk (a red cross), wounded (red segments), grouped like the dock
  function drawFleetIcons(g, x, y, board, own, t) {
    const rows = [[0], [1, 2], [3, 4, 5], [6, 7, 8, 9]];
    rows.forEach((row, r) => {
      let px = x;
      for (const i of row) {
        const s = board.ships[i];
        if (!s) continue;
        const w = s.len * 5 - 1;
        if (s.sunk) {
          g.fillStyle = "#3D0C17"; g.fillRect(px, y + r * 8, w, 5);
          g.fillStyle = "#D93644"; for (let k = 0; k < w; k += 2) { g.fillRect(px + k, y + r * 8 + (k % 4 ? 0 : 4), 1, 1); g.fillRect(px + k, y + r * 8 + 2, 1, 1); }
        } else {
          g.fillStyle = "#0A0F1E"; g.fillRect(px - 1, y + r * 8 - 1, w + 2, 7);
          g.fillStyle = "#B4C0D8"; g.fillRect(px, y + r * 8, w, 5);
          g.fillStyle = "#EAF0FA"; g.fillRect(px, y + r * 8, w, 1);
          g.fillStyle = "#7F8CAE"; g.fillRect(px, y + r * 8 + 4, w, 1);
          if (own && s.hits) { g.fillStyle = Math.floor(t * 4) & 1 ? "#FF6B7A" : "#D93644"; for (let k = 0; k < s.hits; k++) g.fillRect(px + k * 5, y + r * 8 + 1, 4, 3); }
        }
        px += w + 5;
      }
    });
  }
  const TITLES = { easy: "yunga", normal: "captain", hard: "polaris", master: "aurora", adaptive: "storm" };
  const LEVEL_FOE = {
    easy: { rank: "Юнга", name: "Новичок" }, normal: { rank: "Капитан", name: "Бывалый" }, hard: { rank: "Адмирал", name: "Опытный" },
    master: { rank: "Великий адмирал", name: "Мастер" }, adaptive: { rank: "Адмирал", name: "Под вас" },
  };

  // ======================================================================================================
  //  the game
  // ======================================================================================================
  const LEVEL_IDS = ["easy", "normal", "hard", "master", "adaptive"];
  const SAY = {
    cpuMiss: ["Мимо...", "Эх, промах!", "Не туда.", "Ну ничего."], cpuHit: ["Попал!", "Есть пробитие!", "Ага!", "Горит!"],
    cpuSunk: ["Один ушёл на дно!", "Потоплен!", "Топим!"], youMiss: ["Ха, мимо!", "Не угадали.", "Вода."], youHit: ["Ай! Попали.", "Держимся!", "Ой-ой..."],
    youSunk: ["Мой корабль!", "Нет!", "Это было больно."], win: ["Победа за мной!", "Хорошая игра."], lose: ["Вы хороши!", "Сдаюсь..."],
  };
  const pick = (a) => a[(Math.random() * a.length) | 0];
  const HOWTO = "Расставь десять кораблей так, чтобы они не касались друг друга даже углами, и потопи вражеский флот. Попал — стреляешь ещё, мимо — ход соперника.";

  WG.game({
    id: "seabattle",
    portrait: true,
    controls: { dpad: true, a: "Пли", b: false, swipe: false, landscapeDpad: false },
    howto: HOWTO,
    keysHint: "Мышь или стрелки и пробел. Корабли — перетаскивать, нажатие на корабль — повернуть. Esc — пауза.",
    touchHowto: "Перетащи корабль на поле, нажатие на корабль — повернуть. В бою: коснись клетки, затем «Огонь» (или коснись её ещё раз).",
    titleColors: CYAN_T,
    stageNames: ADMIRALS.map((a) => a.rank + " " + a.name),
    music: SONG_PLACE,
    create(api) {
      if (!BG) BG = paintBackground();
      const ST = api.stage ? ADMIRALS[api.stage - 1] : null;
      const rnd = Math.random;
      const fx = new WG.Particles(700);
      const S = {
        t: 0, speed: 1, phase: "intro", phaseT: 0, playMs: 0, started: false,
        level: api.level, lvlSel: Math.max(0, LEVEL_IDS.indexOf(api.level)),
        ships: FLEET.map((len) => ({ len, x: 0, y: 0, dir: 0, placed: false, dropT: 1 })),
        hand: null, cursor: { x: 4, y: 4 }, focus: "grid", btnSel: 3, press: null, pdown: false, rep: { d: null, t: 0 }, lastIn: "key", nope: 0,
        mine: null, foe: null, cfg: null, ai: null, foeLook: null,
        turn: "you", sub: "banner", subT: 0, cur: { x: 4, y: 4 }, rx: 4, ry: 4, curSet: false, resultDelay: 0.8, lastR: null,
        cx: 4, cy: 4, cpuFrom: { x: 4, y: 4 }, cpuMove: null, cpuT: 0, cpuTotal: 1,
        shot: null, shots: 0, lost: 0, over: null, overT: 0, endCalled: false,
        booms: [], splashes: [], floaters: [], pings: [], smokeT: 0, fwT: 0, revealAll: false,
        bubble: null, mood: "ok", moodT: 0, banner: null, flashTurn: 0, hover: null, btnHover: -1, pressBtn: -1,
      };
      // the pointer's events, kept in order (a quick tap or drag may begin and end between two steps)
      S.q = []; S.ptr = { x: -99, y: -99 };
      const toLogical = (e) => { const r = WG.runner.el.canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * api.W / r.width, y: (e.clientY - r.top) * api.H / r.height }; };
      const evq = (k, cancel) => (e) => {
        if (k === "d" && (e.button > 0 || (e.target && e.target.closest && e.target.closest(".dpad, .abtn, .pbtn, .ov")))) return;
        const p = toLogical(e);
        if (S.q.length && k === "m" && S.q[S.q.length - 1].k === "m") S.q.pop();
        S.q.push({ k, x: p.x, y: p.y, cancel: !!cancel });
        if (S.q.length > 120) S.q.splice(0, 60);
      };
      const L_DOWN = evq("d"), L_MOVE = evq("m"), L_UP = evq("u"), L_CANCEL = evq("u", true);
      const rootEl = WG.runner && WG.runner.el && WG.runner.el.root;
      if (rootEl) {
        rootEl.addEventListener("pointerdown", L_DOWN);
        window.addEventListener("pointermove", L_MOVE); window.addEventListener("pointerup", L_UP); window.addEventListener("pointercancel", L_CANCEL);
      }
      const foeLook = ST ? ST.look : TITLES[S.level] || "captain";
      S.foeLook = foeLook;
      const tk = (...a) => api.tone(...a);
      const say = (key, hold) => { S.bubble = { lines: wrap(pick(SAY[key]), 13), t: 0, hold: hold || 2.6 }; };
      const sayText = (text, hold) => { S.bubble = { lines: wrap(text, 13).slice(0, 4), t: 0, hold: hold || 3.4 }; };
      const setMood = (m, sec) => { S.mood = m; S.moodT = sec || 1.6; };

      // ---------- the free battle's level, chosen on the first card ----------
      function chooseLevel(i) {
        S.lvlSel = (i + 5) % 5;
        const lv = LEVEL_IDS[S.lvlSel];
        S.level = lv; S.foeLook = TITLES[lv] || "captain";
        api.level = lv; api.levelName = WG.levelName(lv);
        try { if (WG.runner) WG.runner.level = lv; WG.store.set("level." + api.id, lv); } catch (e) { /* the level stays as it was */ }
      }
      const bestFor = (lv) => (WG.bestOf ? WG.bestOf(api.id, lv) : null);

      // ---------- laying the fleet out ----------
      const SLOTS = [];
      [[0], [1, 2], [3, 4, 5], [6, 7, 8, 9]].forEach((row, r) => {
        const gap = [0, 16, 18, 20][r];
        let x = 209;
        for (const i of row) { SLOTS[i] = { x, y: 73 + r * 24, w: FLEET[i] * 15, h: 15 }; x += FLEET[i] * 15 + gap; }
      });
      const BTN = [
        { id: "auto", label: "АВТО", x: 202, y: 172, w: 84, h: 17 }, { id: "clear", label: "СБРОС", x: 292, y: 172, w: 84, h: 17 },
        { id: "turn", label: "ПОВЕРНУТЬ", x: 202, y: 192, w: 84, h: 17 }, { id: "go", label: "В БОЙ!", x: 292, y: 192, w: 84, h: 17, kind: "go" },
      ];
      const FIRE = { id: "fire", label: "ОГОНЬ!", x: 121, y: 146, w: 86, h: 18, kind: "fire" };
      const placedCount = () => S.ships.filter((s) => s.placed).length;
      const allPlaced = () => placedCount() === 10;
      const inRect = (r, x, y, pad) => x >= r.x - (pad || 0) && y >= r.y - (pad || 0) && x < r.x + r.w + (pad || 0) && y < r.y + r.h + (pad || 0);
      const dockAt = (x, y) => { for (let i = 0; i < 10; i++) if (!S.ships[i].placed && !(S.hand && S.hand.id === i && S.hand.drag) && inRect(SLOTS[i], x, y, 2)) return i; return -1; };
      const btnAt = (x, y) => { for (let i = 0; i < BTN.length; i++) if (inRect(BTN[i], x, y, 1)) return i; return -1; };
      const shipAtCell = (x, y) => { const gr = gridOf(S.ships); return gr[idx(x, y)]; };
      // where a ship can stand so that its segment `k` lies on `cell` (the nearest way that fits)
      function anchorFor(len, dir, cell, k, ignore) {
        const grid = gridOf(S.ships, ignore);
        const order = [];
        for (let i = 0; i < len; i++) order.push(i);
        order.sort((a, b) => Math.abs(a - k) - Math.abs(b - k));
        for (const j of order) {
          const ax = cell.x - (dir === 0 ? j : 0), ay = cell.y - (dir === 1 ? j : 0);
          if (fits(grid, len, ax, ay, dir)) return { x: ax, y: ay };
        }
        return null;
      }
      function putShip(id, a, dir, quiet) {
        const s = S.ships[id];
        s.x = a.x; s.y = a.y; s.dir = dir; s.placed = true; s.dropT = 0;
        if (!quiet) {
          api.sfx("place");
          const [cx, cy] = cellC(PL, a.x + (dir === 0 ? (s.len - 1) / 2 : 0), a.y + (dir === 1 ? (s.len - 1) / 2 : 0));
          fx.emit({ x: cx, y: cy, n: 8, colors: ["#D2FAFF", "#7FE6F4", "#FFFFFF"], speed: [10, 35], life: [0.25, 0.5], drag: 3 });
        }
      }
      function nope() { api.sfx("sb_nope"); S.nope = 0.25; api.shake(1.5, 0.15); }
      function rotatePlaced(id, cell) {
        const s = S.ships[id];
        let k = 0;
        for (let i = 0; i < s.len; i++) if (s.x + (s.dir === 0 ? i : 0) === cell.x && s.y + (s.dir === 1 ? i : 0) === cell.y) k = i;
        const nd = 1 - s.dir;
        const a = anchorFor(s.len, nd, cell, k, id);
        if (a) { putShip(id, a, nd); } else nope();
      }
      function autoPlace() {
        const fleet = randomFleet(rnd, "random");
        fleet.forEach((f, i) => { const s = S.ships[i]; s.x = f.x; s.y = f.y; s.dir = f.dir; s.placed = true; s.dropT = -i * 0.07; });
        S.hand = null;
        api.sfx("whoosh");
      }
      function clearAll() { for (const s of S.ships) s.placed = false; S.hand = null; api.sfx("back"); }
      function rotateHand() {
        if (S.hand) { S.hand.dir = 1 - S.hand.dir; api.sfx("tick"); return true; }
        return false;
      }
      function activate(id) {
        if (id === "auto") autoPlace();
        else if (id === "clear") clearAll();
        else if (id === "turn") {
          if (!rotateHand()) {
            const sid = shipAtCell(S.cursor.x, S.cursor.y);
            if (sid >= 0) rotatePlaced(sid, S.cursor);
            else { const last = [...S.ships].reverse().findIndex((s) => s.placed); if (last >= 0) { const s = S.ships[9 - last]; rotatePlaced(9 - last, { x: s.x, y: s.y }); } else nope(); }
          }
        } else if (id === "go") { if (allPlaced()) startBattle(); else nope(); }
      }
      // pressing, dragging and letting go
      function beginDrag(pr) {
        const s = S.ships[pr.id];
        const from = s.placed ? { x: s.x, y: s.y, dir: s.dir } : null;
        S.hand = { id: pr.id, dir: s.placed ? s.dir : (S.hand && S.hand.id === pr.id ? S.hand.dir : 0), grab: pr.k, drag: true, armed: false, from };
        s.placed = false;
        api.sfx("tick");
      }
      function dropHand(p) {
        const h = S.hand, s = S.ships[h.id];
        const c = cellAt(PL, p.x, p.y);
        const a = c && anchorFor(s.len, h.dir, c, h.grab, h.id);
        if (a) putShip(h.id, a, h.dir);
        else {
          if (h.from) putShip(h.id, h.from, h.from.dir, true);
          if (c) nope();
        }
        S.hand = null;
      }
      function handGhost() { // where the ship in hand would stand: {x, y, ok} or a free position
        const h = S.hand;
        if (!h) return null;
        const s = S.ships[h.id], p = S.ptr;
        let c = null, k = h.grab;
        if (h.drag || (h.armed && S.lastIn === "pointer")) c = cellAt(PL, p.x, p.y);
        else if (h.armed) { c = S.cursor; k = 0; }
        if (!c) return { free: true, x: p.x, y: p.y };
        const a = anchorFor(s.len, h.dir, c, k, h.id);
        if (a) return { x: a.x, y: a.y, ok: true };
        return { x: c.x - (h.dir === 0 ? k : 0), y: c.y - (h.dir === 1 ? k : 0), ok: false };
      }
      function keyAction() {
        const c = S.cursor;
        if (S.hand) {
          const s = S.ships[S.hand.id];
          const a = anchorFor(s.len, S.hand.dir, c, 0, S.hand.id);
          if (a) { putShip(S.hand.id, a, S.hand.dir); S.hand = null; } else nope();
          return;
        }
        const sid = shipAtCell(c.x, c.y);
        if (sid >= 0) { const s = S.ships[sid]; S.hand = { id: sid, dir: s.dir, grab: 0, armed: true, drag: false, from: { x: s.x, y: s.y, dir: s.dir } }; s.placed = false; S.cursor = { x: s.x, y: s.y }; api.sfx("tick"); return; }
        const next = S.ships.findIndex((s) => !s.placed);
        if (next >= 0) { S.hand = { id: next, dir: 0, grab: 0, armed: true, drag: false, from: null }; keyAction(); if (S.hand) api.sfx("tick"); }
        else api.sfx("sb_nope");
      }
      // a click or a tap on the fleet screen
      function tapPlace(tap) {
          S.lastIn = "pointer";
          const bi = btnAt(tap.x, tap.y);
          const c = cellAt(PL, tap.x, tap.y);
          if (bi >= 0) { api.sfx("select"); activate(BTN[bi].id); }
          else if (S.hand && S.hand.armed) {
            const s = S.ships[S.hand.id];
            const d = dockAt(tap.x, tap.y);
            if (c) { const a = anchorFor(s.len, S.hand.dir, c, 0, S.hand.id); if (a) { putShip(S.hand.id, a, S.hand.dir); S.hand = null; } else nope(); }
            else if (d >= 0) { S.hand = d === S.hand.id ? (rotateHand(), S.hand) : { id: d, dir: 0, grab: 0, armed: true, drag: false, from: null }; api.sfx("tick"); }
            else { if (S.hand.from) putShip(S.hand.id, S.hand.from, S.hand.from.dir, true); S.hand = null; }
          } else {
            const d = dockAt(tap.x, tap.y);
            if (d >= 0) { S.hand = { id: d, dir: 0, grab: 0, armed: true, drag: false, from: null }; api.sfx("tick"); }
            else if (c) { const sid = shipAtCell(c.x, c.y); if (sid >= 0) rotatePlaced(sid, c); }
          }
      }
      function takeTaps() { // the pointer's events in order → the taps among them
        const taps = [];
        for (const e of S.q.splice(0)) {
          S.ptr = { x: e.x, y: e.y };
          if (e.k === "d") S.press = { x: e.x, y: e.y, moved: false };
          else if (e.k === "m") { if (S.press && !S.press.moved && Math.hypot(e.x - S.press.x, e.y - S.press.y) > 9) S.press.moved = true; }
          else if (S.press && !S.press.moved && !e.cancel) { taps.push({ x: e.x, y: e.y }); S.press = null; } else S.press = null;
        }
        return taps;
      }
      function updatePlace(dt) {
        const inp = api.input;
        for (const e of S.q.splice(0)) {
          S.ptr = { x: e.x, y: e.y };
          if (Math.abs(e.x - (S.lastPx || 0)) + Math.abs(e.y - (S.lastPy || 0)) > 2) { S.lastIn = "pointer"; S.lastPx = e.x; S.lastPy = e.y; }
          if (e.k === "d") {
            S.pdown = true;
            S.press = { x: e.x, y: e.y, moved: false, kind: null, id: -1, k: 0 };
            const bi = btnAt(e.x, e.y);
            if (bi >= 0) { S.press.kind = "btn"; S.pressBtn = bi; }
            else if (!(S.hand && S.hand.armed)) {
              const d = dockAt(e.x, e.y);
              if (d >= 0) { S.press.kind = "dock"; S.press.id = d; S.press.k = clamp(Math.floor((e.x - SLOTS[d].x) / 15), 0, FLEET[d] - 1); }
              else {
                const c = cellAt(PL, e.x, e.y), sid = c ? shipAtCell(c.x, c.y) : -1;
                if (sid >= 0) { const s = S.ships[sid]; S.press.kind = "ship"; S.press.id = sid; S.press.k = s.dir === 0 ? c.x - s.x : c.y - s.y; }
              }
            }
          } else if (e.k === "m") {
            if (S.press && !S.press.moved && Math.hypot(e.x - S.press.x, e.y - S.press.y) > 5) {
              S.press.moved = true;
              if (!S.hand && (S.press.kind === "dock" || S.press.kind === "ship")) beginDrag(S.press);
            }
          } else {
            S.pdown = false;
            const pr = S.press;
            S.press = null; S.pressBtn = -1;
            if (S.hand && S.hand.drag) dropHand(e);
            else if (pr && !pr.moved && !e.cancel) tapPlace(e);
          }
        }
        S.btnHover = !touchy() ? btnAt(S.ptr.x, S.ptr.y) : -1;
        // the keyboard and the pad
        let d = inp.dir();
        for (const k of ["up", "down", "left", "right"]) {
          if (inp.held(k)) { if (S.rep.d !== k) { S.rep.d = k; S.rep.t = 0; } else { S.rep.t += dt; if (S.rep.t > 0.3) { S.rep.t -= 0.07; d = d || k; } } }
          else if (S.rep.d === k) S.rep.d = null;
        }
        if (d) {
          S.lastIn = "key";
          if (S.focus === "grid") {
            const c = S.cursor;
            if (d === "right" && c.x === 9) { S.focus = "btn"; S.btnSel = c.y < 5 ? 1 : 3; api.sfx("blip"); }
            else { c.x = clamp(c.x + (d === "right") - (d === "left"), 0, 9); c.y = clamp(c.y + (d === "down") - (d === "up"), 0, 9); api.sfx("tick"); }
          } else {
            let r = S.btnSel >> 1, col = S.btnSel & 1;
            if (d === "left" && col === 0) { S.focus = "grid"; S.cursor.y = clamp(S.cursor.y, 0, 9); api.sfx("blip"); }
            else { col = clamp(col + (d === "right") - (d === "left"), 0, 1); r = clamp(r + (d === "down") - (d === "up"), 0, 1); S.btnSel = r * 2 + col; api.sfx("tick"); }
          }
        }
        if (inp.pressed("a")) { S.lastIn = "key"; if (S.focus === "grid") keyAction(); else { api.sfx("select"); activate(BTN[S.btnSel].id); } }
        if (inp.pressed("b")) { S.lastIn = "key"; if (!rotateHand()) { const sid = shipAtCell(S.cursor.x, S.cursor.y); if (sid >= 0) rotatePlaced(sid, S.cursor); } }
        for (const s of S.ships) if (s.placed && s.dropT < 1) { const was = s.dropT; s.dropT += dt / 0.3; if (was < 0 && s.dropT >= 0) api.sfx("place"); }
        if (S.nope > 0) S.nope -= dt;
      }

      // ---------- the battle ----------
      function startBattle() {
        const skill = S.level === "adaptive" ? (WG.adaptive ? WG.adaptive.get(api.id) : 0.35) : undefined;
        S.cfg = ST ? ST.cfg : levelConfig(S.level, skill);
        S.ai = aiState(rnd);
        S.mine = makeBoard(S.ships.map((s) => ({ len: s.len, x: s.x, y: s.y, dir: s.dir })));
        S.foe = makeBoard(randomFleet(rnd, S.cfg.hide));
        S.phase = "slide"; S.phaseT = 0; S.hand = null;
        api.music(SONG_BATTLE); api.sfx("sb_horn");
        sayText(ST ? ST.quote : "Готовьтесь к бою!", 4);
      }
      const centreOf = (L, ship) => cellC(L, ship.x + (ship.dir === 0 ? (ship.len - 1) / 2 : 0), ship.y + (ship.dir === 1 ? (ship.len - 1) / 2 : 0));
      function addSplash(x, y, s) { S.splashes.push({ x, y, s, t: 0 }); }
      function addBoom(x, y, s, delay) { S.booms.push({ x, y, s, t: -(delay || 0), fired: false }); }
      function addFloater(text, x, y, color) { S.floaters.push({ text, x, y, color, t: 0 }); }
      function launch(by, x, y) {
        const L = by === "you" ? EN : MY;
        const [ex, ey] = cellC(L, x, y);
        const from = by === "you" ? { x: 74, y: 226 } : { x: 412, y: -14 };
        const dur = by === "you" ? 0.55 : 0.62;
        S.shot = { by, x, y, t: 0, dur, sx: from.x, sy: from.y, ex, ey, arc: by === "you" ? 80 : 46 };
        api.sfx("sb_cannon");
        tk({ w: "p12", f: 2800, f2: 600, d: dur * 0.9, v: 0.05, sus: 0.6, t: 0.05 });
        if (by === "you") fx.emit({ x: 74, y: 212, n: 14, colors: ["#FFFFFF", "#FFD27A", "#FF9A3C"], speed: [30, 90], angle: [-2.4, -0.7], life: [0.1, 0.3], drag: 3, shape: "spark" });
        else fx.emit({ x: 384, y: 4, n: 12, colors: ["#FFFFFF", "#FFD27A", "#FF9A3C"], speed: [30, 90], angle: [1.8, 3.2], life: [0.1, 0.3], drag: 3, shape: "spark" });
        S.sub = "fly"; S.subT = 0;
      }
      function fireAt(x, y) {
        if (S.foe.shot[idx(x, y)]) { api.sfx("sb_nope"); addFloater("СЮДА УЖЕ БИЛИ", 224 + 75, 36, "#FFC2C9"); return; }
        S.shots++;
        launch("you", x, y);
      }
      function impact() {
        const sh = S.shot, mineSide = sh.by === "cpu";
        const board = mineSide ? S.mine : S.foe, L = mineSide ? MY : EN;
        const res = shoot(board, sh.x, sh.y);
        S.lastR = res.r;
        const [cx, cy] = cellC(L, sh.x, sh.y);
        const big = L.C >= 12 ? 1.25 : 0.8;
        S.shot = null; S.sub = "result"; S.subT = 0;
        if (res.r === "miss") {
          addSplash(cx, cy, big);
          api.sfx("sb_splash");
          fx.emit({ x: cx, y: cy, n: 12, colors: ["#FFFFFF", "#D2FAFF", "#7FE6F4"], speed: [25, 70], angle: [-2.5, -0.65], life: [0.3, 0.6], gravity: 160, shape: "dot" });
          addFloater("МИМО!", cx, cy - 12, "#D2FAFF");
          S.resultDelay = 0.85;
          if (mineSide) say("cpuMiss"); else say("youMiss");
          if (!mineSide) setMood("ok", 1);
        } else if (res.r === "hit") {
          addBoom(cx, cy, big, 0);
          api.sfx("sb_boom"); api.shake(mineSide ? 3 : 2.5, 0.25); api.flash("#FFB36B", 0.1);
          addFloater("ПОПАЛ!", cx, cy - 12, "#FFD27A");
          S.resultDelay = 0.8;
          if (mineSide) { say("cpuHit"); setMood("happy", 1.8); } else { say("youHit"); setMood("sad", 1.8); }
        } else {
          // sunk: the whole ship goes up one cell after another, then its wreck shows and the water round it is marked
          const ship = res.ship;
          ship.sunkAt = S.t;
          shipCells(ship).forEach(([x, y], i) => { const [bx, by] = cellC(L, x, y); addBoom(bx, by, big * (i === ship.len - 1 ? 1.25 : 1), i * 0.1); });
          api.sfx("sb_sunk"); api.shake(mineSide ? 6 : 5, 0.6); api.flash("#FFF0C2", 0.2);
          const [mx, my] = centreOf(L, ship);
          addFloater("ПОТОПЛЕН " + CLASS_UP[ship.len] + "!", mx, clamp(my - 16, L.y + 10, L.y + L.C * N - 10), "#FF8F9B");
          res.autos.forEach(([x, y], i) => { const [ax, ay] = cellC(L, x, y); S.pings.push({ x: ax, y: ay, t: -0.25 - i * 0.035 }); });
          S.resultDelay = 1.7;
          if (mineSide) { S.lost++; say("cpuSunk"); setMood("happy", 2.4); } else { say("youSunk"); setMood("sad", 2.4); }
          fx.emit({ x: mx, y: my, n: 30, colors: ["#FFFFFF", "#FFD27A", "#FF9A3C", "#D93644"], speed: [30, 130], life: [0.4, 1.0], drag: 2, shape: "spark" });
        }
        if (board.left === 0) { S.over = { won: !mineSide }; S.resultDelay = 1.9; }
      }
      function afterResult() {
        if (S.over) { S.phase = "over"; S.overT = 0; S.sub = "end"; return; }
        if (S.lastR === "miss") {
          S.turn = S.turn === "you" ? "cpu" : "you";
          S.sub = "banner"; S.subT = 0; S.flashTurn = 1;
          api.sfx("sb_ping");
          S.banner = { text: S.turn === "you" ? "ВАШ ХОД" : "ХОД СОПЕРНИКА", color: S.turn === "you" ? CYAN_T : RED_T, t: 0 };
        } else { S.sub = "aim"; S.subT = 0; if (S.turn === "cpu") beginCpuAim(); }
      }
      function beginCpuAim() {
        S.cpuMove = aiChoose(S.cfg, S.mine, rnd, S.ai);
        S.cpuT = 0; S.cpuTotal = lerp(S.cfg.delay[0], S.cfg.delay[1], rnd());
        S.cpuFrom = { x: S.cx, y: S.cy };
      }
      function playerAim(dt) {
        const inp = api.input, taps = takeTaps(), p = S.ptr;
        let d = inp.dir();
        for (const k of ["up", "down", "left", "right"]) {
          if (inp.held(k)) { if (S.rep.d !== k) { S.rep.d = k; S.rep.t = 0; } else { S.rep.t += dt; if (S.rep.t > 0.28) { S.rep.t -= 0.075; d = d || k; } } }
          else if (S.rep.d === k) S.rep.d = null;
        }
        if (d) { S.cur.x = clamp(S.cur.x + (d === "right") - (d === "left"), 0, 9); S.cur.y = clamp(S.cur.y + (d === "down") - (d === "up"), 0, 9); S.curSet = true; S.lastIn = "key"; api.sfx("tick"); }
        if (Math.abs(p.x - (S.lastPx || 0)) + Math.abs(p.y - (S.lastPy || 0)) > 2) { S.lastIn = "pointer"; S.lastPx = p.x; S.lastPy = p.y; }
        const hc = !touchy() && S.lastIn === "pointer" ? cellAt(EN, p.x, p.y) : null;
        S.hover = hc;
        if (hc && (hc.x !== S.cur.x || hc.y !== S.cur.y)) { S.cur.x = hc.x; S.cur.y = hc.y; S.curSet = true; api.sfx("tick"); }
        S.btnHover = !touchy() && inRect(FIRE, p.x, p.y, 1) ? 0 : -1;
        for (const tap of taps) {
          const c = cellAt(EN, tap.x, tap.y);
          if (inRect(FIRE, tap.x, tap.y, 1)) { if (S.curSet) fireAt(S.cur.x, S.cur.y); else api.sfx("sb_nope"); }
          else if (c) {
            if (!touchy()) { S.cur.x = c.x; S.cur.y = c.y; S.curSet = true; fireAt(c.x, c.y); }
            else if (S.curSet && S.cur.x === c.x && S.cur.y === c.y) fireAt(c.x, c.y);
            else { S.cur.x = c.x; S.cur.y = c.y; S.curSet = true; api.sfx("sb_lock"); }
          }
        }
        if (S.sub === "aim" && inp.pressed("a")) { S.curSet = true; fireAt(S.cur.x, S.cur.y); }
      }
      function cpuAim(dt) {
        S.cpuT += dt;
        const k = S.cpuT / S.cpuTotal, m = S.cpuMove;
        const e = clamp((k - 0.3) / 0.55, 0, 1), s = e * e * (3 - 2 * e);
        S.cx = lerp(S.cpuFrom.x, m.x, s); S.cy = lerp(S.cpuFrom.y, m.y, s);
        if (S.cpuT >= S.cpuTotal) { S.cx = m.x; S.cy = m.y; launch("cpu", m.x, m.y); }
      }

      // ---------- the end ----------
      function finish() {
        S.endCalled = true;
        const ms = Math.max(1000, Math.round(S.playMs));
        const won = !!S.over.won;
        const meta = { shots: S.shots, lost: S.lost };
        if (won) {
          const score = Math.max(1, 100 - S.shots);
          if (ST) {
            const fast = S.shots <= ST.par, clean = S.lost === 0, stars = 1 + (fast ? 1 : 0) + (clean ? 1 : 0);
            const need = [];
            if (!fast) need.push("победа за " + ST.par + " выстрелов или меньше");
            if (!clean) need.push("ни одного потерянного корабля");
            api.clear({ stars, score, ms, line: "Выстрелов: " + S.shots + " · потеряно кораблей: " + S.lost, hint: need.length ? "Ещё звезда: " + need.join(" или ") : "", meta });
          } else api.end({ score, ms, won: true, meta: Object.assign(meta, { level: S.level }) });
        } else if (ST) api.end({ ms, line: "Потоплено кораблей: " + (10 - S.foe.left) + " из 10 · выстрелов: " + S.shots, hint: "Адмирал " + ST.name + ": «" + ST.how + "»" });
        else api.end({ score: 0, ms, won: false, meta: Object.assign(meta, { level: S.level }) });
      }

      // ---------- the loop ----------
      function update(dt0) {
        const dt = dt0 * S.speed;
        S.t += dt;
        fx.update(dt);
        if (S.started && S.phase !== "intro") S.playMs += dt * 1000;
        if (S.bubble) { S.bubble.t += dt; if (S.bubble.t > S.bubble.hold) S.bubble = null; }
        if (S.moodT > 0) { S.moodT -= dt; if (S.moodT <= 0) S.mood = "ok"; }
        if (S.flashTurn > 0) S.flashTurn -= dt;
        for (const f of S.floaters) f.t += dt;
        S.floaters = S.floaters.filter((f) => f.t < 1.4);
        for (const s of S.splashes) s.t += dt;
        S.splashes = S.splashes.filter((s) => s.t < 0.8);
        for (const p of S.pings) p.t += dt;
        for (const b of S.booms) {
          b.t += dt;
          if (b.t >= 0 && !b.fired) {
            b.fired = true;
            fx.emit({ x: b.x, y: b.y, n: Math.round(14 * b.s), colors: ["#FFFFFF", "#FFD27A", "#FF9A3C", "#D93644"], speed: [25, 90 * b.s], life: [0.25, 0.7], drag: 2.5, shape: "spark" });
            fx.emit({ x: b.x, y: b.y - 2, n: Math.round(8 * b.s), colors: ["#2C3550", "#46516F", "#6B7694", "#1B2133"], speed: [8, 28], angle: [-2.6, -0.5], life: [0.7, 1.4], gravity: -14, drag: 0.8, size: 2, shape: "dot" });
            if (b.t < 0.2) api.sfx("hit");
          }
        }
        S.booms = S.booms.filter((b) => b.t < 0.7);
        // smoke from what burns
        S.smokeT -= dt;
        if (S.smokeT <= 0 && (S.phase === "battle" || S.phase === "over" || S.phase === "slide") && S.mine) {
          S.smokeT = 0.2;
          for (const [board, L] of [[S.foe, EN], [S.mine, MY]]) for (let i = 0; i < 100; i++) {
            if (board.shot[i] !== 2 || Math.random() > 0.45) continue;
            const ship = board.ships[board.grid[i]];
            const [cx, cy] = cellC(L, i % N, (i / N) | 0);
            if (!ship.sunk) fx.emit({ x: cx, y: cy - 3, n: 1, colors: ["#2C3550", "#46516F", "#6B7694"], speed: [3, 9], angle: [-2.2, -0.9], life: [0.8, 1.5], gravity: -10, size: 2, drag: 0.6 });
            else if (Math.random() < 0.3) fx.emit({ x: cx, y: cy - 2, n: 1, colors: ["#1B2133", "#2C3550"], speed: [2, 6], angle: [-2.1, -1.0], life: [0.8, 1.6], gravity: -8, size: 2, drag: 0.5 });
          }
        }
        if (S.phase === "intro") {
          S.phaseT += dt;
          const inp = api.input;
          if (!ST) {
            const d = inp.dir();
            if (d === "up") { chooseLevel(S.lvlSel - 1); api.sfx("tick"); }
            if (d === "down") { chooseLevel(S.lvlSel + 1); api.sfx("tick"); }
            for (const tap of takeTaps()) {
              for (let i = 0; i < 5; i++) if (inRect(INTRO_ROWS[i], tap.x, tap.y)) { if (i === S.lvlSel && S.phaseT > 0.3) { enterPlace(); return; } chooseLevel(i); api.sfx("select"); }
              if (inRect(INTRO_GO, tap.x, tap.y)) enterPlace();
            }
          } else if (takeTaps().length && S.phaseT > 0.25) { enterPlace(); return; }
          if ((inp.pressed("a") || inp.pressed("b")) && S.phaseT > 0.25) enterPlace();
          return;
        }
        if (S.phase === "place") { updatePlace(dt); return; }
        if (S.phase === "slide") {
          S.q.length = 0;
          S.phaseT += dt;
          if (S.phaseT >= 1.15) {
            S.phase = "battle"; S.sub = "banner"; S.subT = 0; S.turn = "you";
            S.banner = { text: "ВАШ ХОД", color: CYAN_T, t: 0 };
            api.sfx("sb_ping");
          }
          return;
        }
        if (S.phase === "battle") {
          S.subT += dt;
          if (!(S.sub === "aim" && S.turn === "you") && S.q.length) { const l = S.q[S.q.length - 1]; S.ptr = { x: l.x, y: l.y }; S.q.length = 0; S.press = null; }
          if (S.banner) { S.banner.t += dt; if (S.banner.t > 0.9) S.banner = null; }
          if (S.sub === "banner") { if (S.subT >= 0.8) { S.sub = "aim"; S.subT = 0; if (S.turn === "cpu") beginCpuAim(); } }
          else if (S.sub === "aim") { if (S.turn === "you") playerAim(dt); else cpuAim(dt); }
          else if (S.sub === "fly") {
            const sh = S.shot; sh.t += dt;
            const k = Math.min(1, sh.t / sh.dur);
            const x = lerp(sh.sx, sh.ex, k), y = lerp(sh.sy, sh.ey, k) - sh.arc * 4 * k * (1 - k);
            fx.emit({ x, y, n: 1, colors: ["#FFFFFF", "#FFD27A", "#FF9A3C"], speed: [2, 10], life: [0.15, 0.3], shape: "dot" });
            sh.px = x; sh.py = y;
            (sh.trail = sh.trail || []).push({ x, y }); if (sh.trail.length > 14) sh.trail.shift();
            if (sh.t >= sh.dur) impact();
          } else if (S.sub === "result") { if (S.subT >= S.resultDelay) afterResult(); }
          return;
        }
        if (S.phase === "over") {
          S.q.length = 0;
          S.overT += dt;
          if (S.overT > 0.5) S.revealAll = true;
          if (S.over.won) {
            S.fwT -= dt;
            if (S.fwT <= 0 && S.overT < 2.4) {
              S.fwT = 0.22;
              const x = 40 + Math.random() * 304, y = 18 + Math.random() * 90;
              fx.emit({ x, y, n: 34, colors: ["#8EF0C6", "#7FE6F4", "#C4BBFF", "#FFD27A", "#FFFFFF"], speed: [20, 95], life: [0.6, 1.2], gravity: 55, drag: 1.2, shape: "spark" });
              api.sfx("bonus");
            }
          }
          if (S.overT > (S.over.won ? 2.8 : 2.4) && !S.endCalled) finish();
        }
      }
      function enterPlace() {
        S.phase = "place"; S.phaseT = 0; S.started = true;
        api.sfx("confirm");
        if (!ST) { try { if (WG.runner) WG.runner.level = S.level; } catch (e) { /* fine */ } }
      }
      const INTRO_ROWS = [0, 1, 2, 3, 4].map((i) => ({ x: 96, y: 47 + i * 25, w: 192, h: 22 }));
      const INTRO_GO = { x: 140, y: 192, w: 104, h: 18 };

      // ---------- drawing ----------
      function drawBoardOwn(g, L, board, ships, t, o) { // the player's own fleet (placement and the small chart)
        o = o || {};
        frame(g, L.x, L.y, L.C * N, L.C * N, { accent: o.accent });
        drawWater(g, L, t);
        if (board) {
          board.ships.forEach((s) => {
            if (s.sunk) drawShip(g, L, s, t, { wreck: true, still: true, alpha: S.t - (s.sunkAt || 0) < 0.4 ? 0.3 + (S.t - (s.sunkAt || 0)) * 1.75 : 1, glow: S.t - (s.sunkAt || 0) < 0.3 ? 1 - (S.t - (s.sunkAt || 0)) / 0.3 : 0 });
            else drawShip(g, L, s, t, {});
          });
          drawMarks(g, L, board, t);
        } else {
          for (const s of ships) if (s.placed && s.dropT >= 0) drawShip(g, L, s, t, { drop: s.dropT });
        }
      }
      function drawIntro(g, t) {
        drawSea(g, t); drawSky(g, t);
        if (ST) {
          WG.text(g, "АДМИРАЛ " + api.stage, 192, 8, { scale: 2, align: "center", color: GOLD_T, outline: "#2A1E00" });
          plate(g, 24, 44, 336, 156);
          const pw = 64;
          // the portrait, doubled
          frame(g, 40, 58, pw, pw, { accent: "#FFD27A" });
          const pc = WG.canvas(32, 32), pg = pc.getContext("2d");
          drawPortrait(pg, ST.look, 0, 0, t, S.mood);
          g.drawImage(pc, 3, 3, 32, 32, 40, 58, 64, 64);
          WG.text(g, ST.rank.toUpperCase(), 40 + pw / 2, 128, { align: "center", color: "#A9B6CD" });
          WG.text(g, ST.name.toUpperCase(), 40 + pw / 2, 139, { align: "center", color: "#FFFFFF", scale: 1 });
          // what they say and how they play
          const lines = wrap("«" + ST.quote + "»", 34);
          lines.forEach((ln, i) => WG.text(g, ln, 124, 56 + i * 10, { color: "#EAF0FA" }));
          WG.text(g, "КАК ИГРАЕТ", 124, 90, { color: "#7FE6F4" });
          wrap(ST.how, 34).forEach((ln, i) => WG.text(g, ln, 124, 101 + i * 10, { color: "#C9D6F2" }));
          const prev = (WG.progress && WG.progress.local(api.id).stages[api.stage]) || 0;
          const goals = [["ПОБЕДИТЬ", "#EAF0FA"], ["ПОБЕДИТЬ ЗА " + ST.par + " ВЫСТРЕЛОВ ИЛИ МЕНЬШЕ", "#EAF0FA"], ["НЕ ПОТЕРЯТЬ НИ ОДНОГО КОРАБЛЯ", "#EAF0FA"]];
          WG.text(g, "ЗВЁЗДЫ", 124, 128, { color: "#FFD27A" });
          goals.forEach(([txt, col], i) => {
            WG.text(g, "★", 124, 140 + i * 11, { color: i === 0 || i < prev ? "#FFD27A" : "#FFD27A", shadow: "#2A1E00" });
            if (i < prev) WG.text(g, "✓", 340, 140 + i * 11, { color: "#8EF0C6" });
            WG.text(g, txt, 136, 140 + i * 11, { color: col });
          });
          if (prev) WG.text(g, "ПРОЙДЕНО: " + "★".repeat(prev) + "☆".repeat(3 - prev), 124, 176, { color: "#FFD27A" });
        } else {
          WG.text(g, "СВОБОДНЫЙ БОЙ", 192, 8, { scale: 2, align: "center", color: CYAN_T, outline: "#04231A" });
          WG.text(g, "ВЫБЕРИТЕ СОПЕРНИКА", 192, 28, { align: "center", color: "#C9D6F2", outline: "#04070F" });
          LEVEL_IDS.forEach((lv, i) => {
            const r = INTRO_ROWS[i], on = i === S.lvlSel;
            plate(g, r.x, r.y, r.w, r.h, { edge: on ? "#FFD27A" : "#46516F" });
            if (on) { g.fillStyle = "rgba(255,210,122," + (0.1 + 0.06 * Math.sin(t * 6)) + ")"; g.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2); }
            g.drawImage(figureOf(TITLES[lv], "ok", false), 7, 4, 18, 22, r.x + 3, r.y + 1, 18, 22);
            WG.text(g, WG.levelName(lv).toUpperCase(), r.x + 26, r.y + 4, { color: on ? "#FFFFFF" : "#C9D6F2" });
            WG.text(g, (WG.LEVELS[lv] || {}).hint || "", r.x + 26, r.y + 13, { color: "#8794B6" });
            const b = bestFor(lv);
            if (b !== null && b !== undefined) WG.text(g, "ЛУЧШИЙ " + b, r.x + r.w - 6, r.y + 4, { align: "right", color: "#FFD27A" });
          });
          WG.text(g, "ОЧКИ = 100 МИНУС ВЫСТРЕЛЫ: ЧЕМ МЕНЬШЕ, ТЕМ ЛУЧШЕ", 192, 176, { align: "center", color: "#A9B6CD", outline: "#04070F" });
        }
        const go = { x: INTRO_GO.x, y: INTRO_GO.y, w: INTRO_GO.w, h: INTRO_GO.h, label: "РАССТАВИТЬ ФЛОТ", kind: "go" };
        go.x = 112; go.w = 160;
        INTRO_GO.x = go.x; INTRO_GO.w = go.w;
        drawButton(g, go, t, { focus: true });
      }
      function drawPlace(g, t, dx) {
        g.save(); g.translate(dx, 0);
        WG.text(g, "РАССТАВЬТЕ ФЛОТ", 192, 6, { scale: 2, align: "center", color: CYAN_T, outline: "#04231A" });
        const hint = touchy() ? "Перетащите корабль на поле. Касание корабля — поворот." : "Перетащите корабль мышью или поставьте пробелом. X — поворот.";
        plate(g, 192 - Math.floor(WG.textWidth(hint) / 2) - 5, 25, WG.textWidth(hint) + 10, 13);
        WG.text(g, hint, 192, 28, { align: "center", color: "#EAF0FA" });
        // the grid
        drawLabels(g, PL);
        const hand = S.hand, ghost = handGhost();
        frame(g, PL.x, PL.y, 150, 150);
        drawWater(g, PL, t);
        if (hand) { // the water too close to a ship is forbidden: shown while one is in hand
          const gr = gridOf(S.ships, hand.id);
          for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
            let near = false;
            for (let dy = -1; dy <= 1 && !near; dy++) for (let ddx = -1; ddx <= 1; ddx++) { const nx = i + ddx, ny = j + dy; if (nx >= 0 && ny >= 0 && nx < N && ny < N && gr[idx(nx, ny)] >= 0) { near = true; break; } }
            if (near && gr[idx(i, j)] < 0) { art.dither(g, PL.x + i * 15, PL.y + j * 15, 14, 14, null, "rgba(217,54,68,.5)", 0.32); }
          }
        }
        for (const s of S.ships) if (s.placed && s.dropT >= 0) drawShip(g, PL, s, t, { drop: s.dropT });
        if (ghost && !ghost.free) {
          const s = S.ships[hand.id];
          g.globalAlpha = 0.78;
          const gs = { len: s.len, x: ghost.x, y: ghost.y, dir: hand.dir };
          if (ghost.x >= -s.len && ghost.y >= -s.len) {
            drawShip(g, PL, gs, t, { still: true, noFoam: !ghost.ok });
            g.globalAlpha = 1;
            const [w, h] = shipDim(gs, 15);
            g.fillStyle = ghost.ok ? "rgba(52,211,153,.3)" : "rgba(217,54,68,.45)";
            for (const [cx, cy] of shipCells(gs)) if (cx >= 0 && cy >= 0 && cx < N && cy < N) g.fillRect(PL.x + cx * 15, PL.y + cy * 15, 14, 14);
          }
          g.globalAlpha = 1;
        }
        // the cursor of the keyboard
        if (S.focus === "grid" && S.lastIn === "key") drawReticle(g, PL, S.cursor.x, S.cursor.y, t, "#FFD27A");
        // the dock
        plate(g, 200, 53, 176, 114);
        WG.text(g, "ФЛОТ", 208, 59, { color: "#A9B6CD" });
        WG.text(g, placedCount() + " ИЗ 10", 368, 59, { align: "right", color: allPlaced() ? "#8EF0C6" : "#FFD27A" });
        for (let i = 0; i < 10; i++) {
          const sl = SLOTS[i], s = S.ships[i];
          const inHand = hand && hand.id === i;
          if (s.placed) { g.fillStyle = "rgba(160,190,225,.16)"; g.fillRect(sl.x, sl.y + 2, sl.w - 1, 1); g.fillRect(sl.x, sl.y + 12, sl.w - 1, 1); g.fillRect(sl.x, sl.y + 2, 1, 11); g.fillRect(sl.x + sl.w - 2, sl.y + 2, 1, 11); continue; }
          if (hand && hand.drag && inHand) { g.fillStyle = "rgba(160,190,225,.16)"; g.fillRect(sl.x, sl.y + 2, sl.w - 1, 1); g.fillRect(sl.x, sl.y + 12, sl.w - 1, 1); continue; }
          if (inHand) { g.fillStyle = "rgba(255,210,122," + (0.18 + 0.1 * Math.sin(t * 8)) + ")"; g.fillRect(sl.x - 3, sl.y - 3, sl.w + 5, 21); }
          drawShip(g, { x: sl.x, y: sl.y, C: 15 }, { len: s.len, x: 0, y: 0, dir: 0 }, t + i, {});
        }
        for (let i = 0; i < BTN.length; i++) {
          const b = BTN[i];
          if (b.id === "go") b.enabled = allPlaced();
          if (b.id === "turn") b.label = "ПОВЕРНУТЬ";
          drawButton(g, b, t, { focus: S.focus === "btn" && S.btnSel === i, hover: S.btnHover === i, press: S.pressBtn === i && S.pdown });
        }
        // a ship carried by a finger or the mouse floats under it
        if (hand && ghost && ghost.free) {
          const s = S.ships[hand.id], [w, h] = shipDim({ len: s.len, dir: hand.dir }, 15);
          g.globalAlpha = 0.92;
          drawShip(g, PL, { len: s.len, x: 0, y: 0, dir: hand.dir }, t, { px: Math.round(ghost.x - (hand.dir === 0 ? hand.grab * 15 + 7 : w / 2)), py: Math.round(ghost.y - (hand.dir === 1 ? hand.grab * 15 + 7 : h / 2)), still: true });
          g.globalAlpha = 1;
        }
        g.restore();
      }
      function drawBattle(g, t, dx) {
        g.save(); g.translate(dx, 0);
        // the top line: whose turn, the shots, the admiral
        const you = S.turn === "you";
        const turnTxt = S.phase === "over" ? (S.over.won ? "ПОБЕДА!" : "ПОРАЖЕНИЕ") : you ? "ВАШ ХОД" : "ХОД СОПЕРНИКА";
        const pulse = S.flashTurn > 0 && Math.floor(t * 14) % 2;
        plate(g, 4, 4, 168, 21);
        WG.text(g, turnTxt, 10, 8, { scale: 2, color: S.phase === "over" ? (S.over.won ? GOLD_T : RED_T) : you ? CYAN_T : RED_T, shadow: "#04070F" });
        if (pulse) { g.fillStyle = "rgba(255,255,255,.18)"; g.fillRect(5, 5, 166, 19); }
        plate(g, 296, 4, 84, 31);
        WG.text(g, "ВЫСТРЕЛОВ " + S.shots, 374, 8, { align: "right", color: ST && S.shots > ST.par ? "#FF8F9B" : "#EAF0FA" });
        WG.text(g, ST ? "ПОТЕРИ " + S.lost : "ОЧКИ " + Math.max(0, 100 - S.shots), 374, 18, { align: "right", color: ST ? (S.lost ? "#FF8F9B" : "#8EF0C6") : "#FFD27A" });
        WG.text(g, ST ? "АДМИРАЛ " + api.stage : WG.levelName(S.level).toUpperCase(), 374, 27, { align: "right", color: "#7FE6F4" });
        // my fleet
        WG.text(g, "ВАШ ФЛОТ", MY.x, 45, { color: "#7FE6F4", outline: "#04070F" });
        WG.text(g, S.mine.left + " ИЗ 10", MY.x + 100, 45, { align: "right", color: S.mine.left < 4 ? "#FF8F9B" : "#EAF0FA", outline: "#04070F" });
        drawBoardOwn(g, MY, S.mine, null, t, {});
        // the enemy waters
        WG.text(g, "ВРАЖЕСКИЕ ВОДЫ", EN.x, 38, { color: "#FF8F9B", outline: "#04070F" });
        drawLabels(g, EN);
        frame(g, EN.x, EN.y, 150, 150, { accent: "#FF8F9B" });
        drawWater(g, EN, t);
        S.foe.ships.forEach((s, i) => {
          if (s.sunk) { const k = S.t - (s.sunkAt || 0); drawShip(g, EN, s, t, { wreck: true, still: true, alpha: Math.min(1, 0.2 + k * 1.6), glow: k < 0.35 ? 1 - k / 0.35 : 0 }); }
          else if (S.revealAll && !S.over.won) drawShip(g, EN, s, t, { alpha: 0.75 });
        });
        drawMarks(g, EN, S.foe, t);
        // the reticles
        if (S.phase === "battle" || S.phase === "slide") {
          if (S.turn === "you" && S.sub === "aim" && (S.curSet || S.lastIn === "key")) {
            const ok = !S.foe.shot[idx(S.cur.x, S.cur.y)];
            S.rx += (S.cur.x - S.rx) * 0.5; S.ry += (S.cur.y - S.ry) * 0.5;
            drawReticle(g, EN, Math.abs(S.rx - S.cur.x) < 0.05 ? S.cur.x : S.rx, Math.abs(S.ry - S.cur.y) < 0.05 ? S.cur.y : S.ry, t, ok ? "#FFD27A" : "#FF6B7A", { cross: true });
          } else if (S.turn === "you" && S.sub === "aim") drawReticle(g, EN, S.rx, S.ry, t, "rgba(255,210,122,.4)", { dim: true });
          if (S.turn === "cpu" && (S.sub === "aim" || S.sub === "fly")) drawReticle(g, MY, S.cx, S.cy, t, "#FF6B7A", { dim: true, cross: true });
        }
        // the admiral
        const px = 127, py = 58;
        const look = ST ? ST.look : S.foeLook;
        drawPortrait(g, look, px, py, t, S.mood, { accent: ST ? "#FFD27A" : "#7FE6F4", bob: S.mood === "happy" ? 1 : 0 });
        const rk = ST ? ST.rank : LEVEL_FOE[S.level].rank, nm = ST ? ST.name : LEVEL_FOE[S.level].name;
        const rl = wrap(rk.toUpperCase(), 7);
        rl.forEach((ln, i) => WG.text(g, ln, 166, 60 + i * 9, { color: "#A9B6CD", outline: "#04070F" }));
        WG.text(g, nm.toUpperCase(), 166, 60 + rl.length * 9 + 1, { color: "#FFFFFF", outline: "#04070F" });
        // what they say
        const bub = S.bubble ? S.bubble.lines : [];
        if (bub.length) drawBubble(g, 121, 99, 86, 7 + bub.length * 9, bub);
        // the fire button
        FIRE.enabled = S.phase === "battle" && S.turn === "you" && S.sub === "aim" && S.curSet && !S.foe.shot[idx(S.cur.x, S.cur.y)];
        drawButton(g, FIRE, t, { hover: S.btnHover === 0 && FIRE.enabled, press: false });
        // the fleets and the stars
        WG.text(g, "ВРАГ", MY.x, 165, { color: "#FF8F9B", outline: "#04070F" });
        WG.text(g, "ВАШ", MY.x + 52, 165, { color: "#7FE6F4", outline: "#04070F" });
        plate(g, MY.x - 3, 174, 46, 36); plate(g, MY.x + 49, 174, 46, 36);
        drawFleetIcons(g, MY.x + 1, 178, S.foe, false, t);
        drawFleetIcons(g, MY.x + 53, 178, S.mine, true, t);
        if (ST) {
          WG.text(g, "ЗВЁЗДЫ", 121, 169, { color: "#FFD27A", outline: "#04070F" });
          const goals = [["ПОБЕДА", true], ["ДО " + ST.par + " ВЫСТР.", S.shots <= ST.par], ["БЕЗ ПОТЕРЬ", S.lost === 0]];
          goals.forEach(([txt, on], i) => {
            WG.text(g, "★", 121, 179 + i * 10, { color: on ? "#FFD27A" : "#3B4766", shadow: "#04070F" });
            WG.text(g, txt, 133, 179 + i * 10, { color: on ? "#EAF0FA" : "#5F6F93", outline: "#04070F" });
          });
        } else {
          WG.text(g, "ОЧКИ", 121, 169, { color: "#FFD27A", outline: "#04070F" });
          WG.text(g, String(Math.max(0, 100 - S.shots)), 121, 179, { scale: 3, color: GOLD_T, shadow: "#2A1E00" });
          const b = bestFor(S.level);
          WG.text(g, b !== null && b !== undefined ? "ЛУЧШИЙ " + b : "ПЕРВАЯ ПОБЕДА — РЕКОРД", 121, 203, { color: "#A9B6CD", outline: "#04070F" });
        }
        if (!touchy()) { WG.text(g, "СТРЕЛКИ — ПРИЦЕЛ", 234, 6, { align: "center", color: "#A9B6CD", outline: "#04070F" }); WG.text(g, "ПРОБЕЛ — ОГОНЬ", 234, 15, { align: "center", color: "#A9B6CD", outline: "#04070F" }); WG.text(g, "ИЛИ МЫШЬ", 234, 24, { align: "center", color: "#A9B6CD", outline: "#04070F" }); }
        g.restore();
      }
      function drawEffects(g, t) {
        // ripples round the water marked after a sunk ship
        for (const p of S.pings) if (p.t >= 0 && p.t < 0.4) { const r = Math.round(p.t * 24); g.fillStyle = "rgba(210,250,255," + (0.7 - p.t) + ")"; g.fillRect(Math.round(p.x) - r, Math.round(p.y), 1, 1); g.fillRect(Math.round(p.x) + r, Math.round(p.y), 1, 1); g.fillRect(Math.round(p.x), Math.round(p.y) - (r >> 1), 1, 1); g.fillRect(Math.round(p.x), Math.round(p.y) + (r >> 1), 1, 1); }
        for (const s of S.splashes) {
          const k = s.t / 0.7, h = Math.round(s.s * 11 * Math.sin(Math.min(1, s.t / 0.22) * Math.PI / 2) * (k > 0.42 ? 1 - (k - 0.42) / 0.58 : 1));
          const rx = Math.round(3 + s.t * 20 * s.s), ry = Math.max(1, Math.round(rx * 0.5));
          g.globalAlpha = Math.max(0, 1 - k);
          g.fillStyle = "#D2FAFF";
          for (let a = 0; a < 40; a++) { const ang = a / 40 * Math.PI * 2; g.fillRect(Math.round(s.x + Math.cos(ang) * rx), Math.round(s.y + Math.sin(ang) * ry), 1, 1); }
          for (let r = 0; r < h; r++) {
            const w = r < 2 ? Math.round(5 * s.s) : r > h - 3 ? Math.round(4 * s.s) : Math.round(3 * s.s);
            g.fillStyle = r > h - 2 ? "#FFFFFF" : "#BFEFFA"; g.fillRect(Math.round(s.x - w / 2), Math.round(s.y - r), w, 1);
            g.fillStyle = "#7FE6F4"; g.fillRect(Math.round(s.x + w / 2) - 1, Math.round(s.y - r), 1, 1);
          }
          g.globalAlpha = 1;
        }
        for (const b of S.booms) {
          if (b.t < 0) continue;
          const k = b.t / 0.55;
          if (k > 1) continue;
          const r = (2.5 + 9 * Math.sqrt(k)) * b.s;
          g.globalAlpha = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1;
          art.disc(g, b.x, b.y, r, "#D93644"); art.disc(g, b.x, b.y, r * 0.78, "#FF9A3C"); art.disc(g, b.x, b.y, r * 0.52, "#FFD27A");
          if (k < 0.5) art.disc(g, b.x, b.y, r * 0.3, "#FFFFFF");
          g.globalAlpha = 1;
          // the shock ring
          g.fillStyle = "rgba(255,240,194," + Math.max(0, 0.8 - k) + ")";
          const rr = Math.round(k * 16 * b.s);
          for (let a = 0; a < 28; a++) { const ang = a / 28 * Math.PI * 2; g.fillRect(Math.round(b.x + Math.cos(ang) * rr), Math.round(b.y + Math.sin(ang) * rr * 0.7), 1, 1); }
        }
        fx.draw(g);
        if (S.shot && S.shot.px !== undefined) {
          const s = S.shot;
          const tr = s.trail || [];
          tr.forEach((p, i) => { const k = i / tr.length; g.fillStyle = k > 0.7 ? "#FFF0C2" : k > 0.4 ? "#FFB36B" : "rgba(255,120,60," + (0.25 + k) + ")"; const z = k > 0.6 ? 2 : 1; g.fillRect(Math.round(p.x) - 1, Math.round(p.y) - 1, z, z); });
          const k0 = s.t / s.dur;
          g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(Math.round(lerp(s.sx, s.ex, k0)) - 1, Math.round(lerp(s.sy, s.ey, k0)) + 1, 3, 1); // its shadow on the water
          art.disc(g, s.px, s.py, 3, "rgba(255,154,60,.45)"); art.disc(g, s.px, s.py, 2, "#FFD27A"); g.fillStyle = "#FFFFFF"; g.fillRect(Math.round(s.px) - 1, Math.round(s.py) - 1, 2, 2);
        }
        for (const f of S.floaters) {
          const k = f.t / 1.4, y = f.y - Math.round(Math.min(1, k * 2.5) * 12);
          if (k > 0.7 && Math.floor(f.t * 18) % 2) continue;
          WG.text(g, f.text, clamp(f.x, 4 + WG.textWidth(f.text) / 2, 380 - WG.textWidth(f.text) / 2), y, { align: "center", color: f.color, outline: "#04070F" });
        }
        if (S.banner && S.phase === "battle") {
          const k = S.banner.t / 0.9, slide = k < 0.2 ? (1 - k / 0.2) * 60 : k > 0.8 ? -(k - 0.8) / 0.2 * 60 : 0;
          g.globalAlpha = k < 0.15 ? k / 0.15 : k > 0.8 ? 1 - (k - 0.8) / 0.2 : 1;
          g.fillStyle = "rgba(4,10,24,.55)"; g.fillRect(0, 98, 384, 24);
          g.fillStyle = S.banner.color[2]; g.fillRect(0, 98, 384, 1); g.fillRect(0, 121, 384, 1);
          WG.text(g, S.banner.text, 192 + Math.round(slide), 102, { scale: 2, align: "center", color: S.banner.color, outline: "#04070F" });
          g.globalAlpha = 1;
        }
        if (S.phase === "over") {
          const k = Math.min(1, S.overT / 0.5);
          g.fillStyle = "rgba(4,10,24," + (0.45 * k) + ")"; g.fillRect(0, 88, 384, 40);
          WG.text(g, S.over.won ? "ПОБЕДА!" : "ПОРАЖЕНИЕ", 192, 98, { scale: 3, align: "center", color: S.over.won ? GOLD_T : RED_T, outline: S.over.won ? "#2A1E00" : "#3D0C17" });
        }
      }
      return {
        _state: S, _levels: LEVEL_IDS, _logic: { shoot, makeBoard, randomFleet, aiChoose, levelConfig, ADMIRALS, fits, gridOf },
        start() { S.started = true; api.sfx("start"); },
        update,
        draw(g) {
          const t = S.t;
          if (S.phase === "intro" && !S.started) { drawSea(g, t); drawSky(g, t); return; }
          if (S.phase === "intro") { drawIntro(g, t); fx.draw(g); return; }
          drawSea(g, t); drawSky(g, t);
          if (S.phase === "place") { drawPlace(g, t, 0); fx.draw(g); return; }
          if (S.phase === "slide") {
            const k = ease(S.phaseT / 1.1), dx = Math.round(k * 400);
            drawPlace(g, t, -dx);
            drawBattle(g, t, 400 - dx);
            fx.draw(g);
            return;
          }
          drawBattle(g, t, 0);
          drawEffects(g, t);
        },
        pause() { S.q.length = 0; S.press = null; S.pdown = false; S.pressBtn = -1; if (S.hand && S.hand.drag) { const h = S.hand; if (h.from) putShip(h.id, h.from, h.from.dir, true); S.hand = null; } },
        resume() { S.q.length = 0; S.press = null; },
        destroy() {
          if (rootEl) { rootEl.removeEventListener("pointerdown", L_DOWN); window.removeEventListener("pointermove", L_MOVE); window.removeEventListener("pointerup", L_UP); window.removeEventListener("pointercancel", L_CANCEL); }
        },
      };
    },
  });
})();
