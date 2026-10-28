/* «Ночное шоссе» — the registry entry, its cover, and the art kit the game shares with the cover:
   cars, pines and other roadside things are painted pixel by pixel in code here, so the card and the game match.
   (stage 1) written by the road game's agent; the game itself is road.js. */
"use strict";
(function () {
  const { art } = WG;

  // ---------- pixel helpers ----------
  function pen(w, h) {
    const c = WG.canvas(w, h), g = c.getContext("2d");
    const r = (x, y, ww, hh, col) => { if (!col || ww <= 0 || hh <= 0) return; g.fillStyle = col; g.fillRect(x, y, ww, hh); };
    return { c, g, r };
  }
  // rings the opaque shape of a canvas with 1 px of colour (the canvas grows by 1 px on every side)
  function outline(src, color, skipBottom) {
    const sw = src.width, sh = src.height;
    const c = WG.canvas(sw + 2, sh + 2), g = c.getContext("2d");
    const d = src.getContext("2d").getImageData(0, 0, sw, sh).data;
    const on = (x, y) => x >= 0 && y >= 0 && x < sw && y < sh && d[(y * sw + x) * 4 + 3] > 200;
    g.fillStyle = color;
    for (let y = -1; y <= sh; y++) for (let x = -1; x <= sw; x++) {
      if (on(x, y) || (skipBottom && y >= sh)) continue;
      if (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1)) g.fillRect(x + 1, y + 1, 1, 1);
    }
    g.drawImage(src, 1, 1);
    return c;
  }
  const hexRgb = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  function mix(a, b, t) {
    const A = hexRgb(a), B = hexRgb(b);
    return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("");
  }

  // ---------- cars, seen from behind ----------
  // a body colour as five steps: L specular, H lit, R body, D shade, K deep
  const RAMPS = {
    red: { L: "#FFC2C9", H: "#FF6B7A", R: "#D93644", D: "#8E1F35", K: "#3D0C17" },
    cyan: { L: "#D2FAFF", H: "#7FE6F4", R: "#22B8CF", D: "#0B6E8A", K: "#0B3B4A" },
    violet: { L: "#E4DEFF", H: "#C4BBFF", R: "#8B7CF6", D: "#4B3BA8", K: "#21194A" },
    amber: { L: "#FFF0C2", H: "#FFD27A", R: "#E0A53A", D: "#9A6A12", K: "#3A2600" },
    green: { L: "#C8FBE3", H: "#8EF0C6", R: "#34D399", D: "#127A52", K: "#05291C" },
    white: { L: "#FFFFFF", H: "#EAF0FA", R: "#C9D2E4", D: "#7F8BA8", K: "#2C3550" },
    steel: { L: "#B9C9E6", H: "#7F96C0", R: "#4D6390", D: "#2E3D60", K: "#141C33" },
    beige: { L: "#F2E6CC", H: "#D9C49A", R: "#B09A6E", D: "#6E5E40", K: "#2C2416" },
    pine: { L: "#9CD8B8", H: "#5FA383", R: "#2F6E52", D: "#1A4434", K: "#0A1F17" },
    plum: { L: "#E8A0AE", H: "#B85A6E", R: "#7E2E42", D: "#4A1826", K: "#1E0810" },
    grey: { L: "#D5DBE6", H: "#9AA5C0", R: "#6B7694", D: "#46516F", K: "#1B2133" },
  };
  const TIRE = "#10131F", TREAD = "#262D45", TSIDE = "#3B4766", OUT = "#05070D";
  const GLASS = ["#111F3D", "#1A3159", "#284978", "#5A86B8"];
  const LIGHT = { off: ["#8E1F35", "#C8233F", "#6B1428"], on: ["#FFE1E5", "#FF6B7A", "#FF2E4C"] };
  function tire(r, x, y, w, h, f, outer) {
    r(x + 1, y, w - 2, 1, TIRE); r(x, y + 1, w, h - 2, TIRE); r(x + 1, y + h - 1, w - 2, 1, TIRE);
    for (let yy = y + 1; yy < y + h - 1; yy++) if ((yy - y + f) % 3 === 0) r(x + 1, yy, w - 2, 1, TREAD);
    r(outer < 0 ? x : x + w - 1, y + 2, 1, h - 4, TSIDE);
  }
  // car(kind, ramp, {lean -2…2, tire 0…2, brake, blink -1|0|1, blinkOn, hair 0…2, text, wing})
  //   kinds: "roadster" (the player's convertible), "coupe" (rivals), "sedan", "van" (traffic)
  // → a canvas whose bottom centre stands on the road
  function car(kind, ramp, o) {
    o = o || {};
    const C = typeof ramp === "string" ? RAMPS[ramp] : ramp;
    const lean = o.lean | 0, al = Math.abs(lean), sg = Math.sign(lean);
    const van = kind === "van", Hh = van ? 46 : 34, Wd = 64;
    const { c, g, r } = pen(Wd, Hh);
    const f = o.tire | 0;
    const lt = o.brake ? LIGHT.on : LIGHT.off;
    const amberL = o.blink === -1 && o.blinkOn ? "#FFD27A" : "#8A5A10", amberR = o.blink === 1 && o.blinkOn ? "#FFD27A" : "#8A5A10";
    const fx = kind === "roadster" || kind === "coupe" ? lean : 0;
    const ux = fx - sg * (al > 1 ? 1 : 0);
    const F = (x, y, w, h, col) => r(x + fx, y, w, h, col);
    const U = (x, y, w, h, col) => r(x + ux, y, w, h, col);
    const mir = (x, w) => Wd - x - w;
    if (kind === "roadster" || kind === "coupe") {
      const td = Math.trunc(lean / 2);
      tire(r, 4 + td, 21, 11, 12, f, -1); tire(r, 49 + td, 21, 11, 12, f, 1);
      // the flank shows on the outside of a turn
      if (al) {
        const sx = lean < 0 ? 61 + fx : 3 + fx - 2 * al;
        r(sx, 12, 2 * al, 13, C.D); r(sx, 12, 2 * al, 1, C.R); r(sx, 19, 2 * al, 6, C.K);
        r(sx, 21, 2 * al, 11, TIRE); r(lean < 0 ? sx + 2 * al - 1 : sx, 22, 1, 9, TSIDE);
      }
      // the rear face
      F(5, 12, 54, 1, C.H);
      F(3, 13, 58, 12, C.R);
      F(3, 13, 3, 11, C.H); F(58, 13, 3, 11, C.D);
      F(6, 13, 26, 1, C.L); F(32, 13, 24, 1, C.H);
      F(4, 20, 56, 4, C.D);
      for (const x0 of [5, 37]) {
        F(x0, 15, 22, 5, "#2A0710");
        F(x0 + 1, 16, 20, 1, lt[0]); F(x0 + 1, 17, 20, 1, lt[1]); F(x0 + 1, 18, 20, 1, lt[2]);
        for (let k = 4; k < 20; k += 4) F(x0 + k, 16, 1, 3, "#2A0710");
        F(x0 === 5 ? x0 + 1 : x0 + 18, 16, 3, 3, x0 === 5 ? amberL : amberR);
      }
      F(27, 15, 10, 5, C.K);
      for (const [x, y] of [[29, 16], [29, 17], [30, 18], [31, 17], [32, 17], [33, 18], [34, 16], [34, 17]]) F(x, y, 1, 1, "#C9D2E4");
      F(25, 20, 14, 4, "#1B2133"); F(26, 21, 12, 2, "#DDE5F2");
      for (const x of [27, 28, 30, 32, 33, 35, 36]) F(x, 21, 1, 2, "#26324F");
      F(3, 24, 58, 1, "#46516F"); F(3, 25, 58, 2, "#1B2133"); F(6, 27, 52, 1, TIRE);
      for (const x of [11, mir(11, 6)]) { F(x, 24, 6, 3, "#9AA5C0"); F(x + 1, 25, 4, 1, "#04070F"); F(x, 24, 6, 1, "#D5DBE6"); }
      F(20, 27, 24, 2, TIRE); for (let k = 0; k < 6; k++) F(22 + k * 4, 27, 1, 2, "#2C3550");
      if (kind === "roadster") {
        // the windscreen behind the people, then the seats, the people, the rear deck
        U(12, 1, 40, 1, OUT); U(11, 2, 1, 7, OUT); U(52, 2, 1, 7, OUT);
        U(12, 2, 40, 7, GLASS[1]); U(12, 2, 40, 2, GLASS[2]);
        for (let k = 0; k < 6; k++) U(17 + k * 2, 2 + k, 3, 1, GLASS[3]);
        U(37, 3, 9, 1, "#2E8F74"); U(40, 4, 6, 1, "#1F6B5A");
        U(29, 0, 6, 2, OUT); U(30, 0, 4, 1, "#6B7694");
        for (const x of [14, 42]) { U(x + 1, 5, 6, 1, "#46516F"); U(x, 6, 8, 4, "#26324F"); U(x, 6, 1, 3, "#3B4766"); }
        // the driver: dark hair, a neck; the passenger: long fair hair in the wind
        U(16, 0, 5, 1, "#2A1A12"); U(15, 1, 7, 4, "#2A1A12"); U(16, 5, 5, 1, "#2A1A12"); U(17, 6, 3, 2, "#B07A5E");
        U(16, 1, 2, 1, "#5A3A26"); U(16, 2, 1, 1, "#5A3A26"); U(15, 3, 1, 1, "#C98A6B"); U(21, 3, 1, 1, "#8F6248");
        U(44, 0, 5, 1, "#C98A1B"); U(43, 1, 7, 7, "#C98A1B"); U(44, 8, 5, 1, "#8A5A10");
        U(44, 1, 3, 1, "#FFD27A"); U(44, 2, 2, 2, "#FFD27A"); U(48, 4, 2, 4, "#8A5A10");
        const hair = [[[50, 2], [51, 3], [50, 4], [51, 5], [52, 6]], [[50, 2], [51, 2], [52, 3], [50, 5], [51, 6]], [[50, 3], [51, 4], [52, 4], [50, 6], [51, 7]]][(o.hair | 0) % 3];
        for (const [x, y] of hair) U(x, y, 1, 1, "#E0A53A");
        U(10, 8, 44, 1, C.H); U(7, 9, 50, 1, C.H); U(5, 10, 54, 1, C.H); U(4, 11, 56, 1, C.R);
        U(12, 9, 14, 1, C.L); U(8, 10, 6, 1, C.L); U(46, 10, 10, 1, C.R);
      } else {
        // a hard top: roof, pillars, the rear window with the driver's head in it
        U(18, 0, 28, 1, C.H); U(15, 1, 34, 1, C.R);
        U(13, 2, 4, 7, C.D); U(47, 2, 4, 7, C.K); U(13, 2, 1, 7, C.R);
        U(17, 2, 30, 7, GLASS[0]); U(17, 2, 30, 2, GLASS[1]);
        for (let k = 0; k < 5; k++) U(20 + k * 2, 2 + k, 2, 1, GLASS[2]);
        U(21, 4, 7, 5, "#05070D"); U(22, 3, 5, 1, "#05070D"); U(37, 5, 6, 4, "#0B1020");
        U(9, 9, 46, 1, C.H); U(6, 10, 52, 1, C.H); U(4, 11, 56, 1, C.R); U(10, 10, 10, 1, C.L);
        if (o.wing) { U(5, 6, 54, 2, C.K); U(5, 6, 54, 1, C.D); U(14, 8, 2, 2, C.K); U(48, 8, 2, 2, C.K); }
      }
    } else if (kind === "sedan") {
      tire(r, 7, 22, 9, 11, f, -1); tire(r, 48, 22, 9, 11, f, 1);
      r(5, 13, 54, 11, C.R); r(5, 13, 2, 10, C.H); r(57, 13, 2, 10, C.D); r(6, 20, 52, 3, C.D);
      r(8, 10, 48, 1, C.H); r(6, 11, 52, 2, C.H); r(10, 11, 12, 1, C.L);
      r(16, 0, 32, 1, C.H); r(14, 1, 36, 1, C.R); r(12, 2, 4, 8, C.D); r(48, 2, 4, 8, C.K);
      r(16, 2, 32, 8, GLASS[0]); r(16, 2, 32, 2, GLASS[1]); for (let k = 0; k < 5; k++) r(19 + k * 2, 3 + k, 2, 1, GLASS[2]);
      r(19, 5, 6, 5, "#05070D"); r(39, 5, 6, 5, "#05070D"); r(20, 4, 4, 1, "#05070D"); r(40, 4, 4, 1, "#05070D");
      r(28, 1, 8, 1, o.brake ? "#FF6B7A" : "#5A1020");
      for (const x of [6, mir(6, 9)]) {
        r(x, 14, 9, 6, "#2A0710"); r(x + 1, 15, 7, 1, lt[0]); r(x + 1, 16, 7, 1, lt[1]); r(x + 1, 17, 7, 1, lt[2]);
        r(x + 1, 18, 7, 1, x === 6 ? amberL : amberR);
      }
      r(25, 18, 14, 5, "#1B2133"); r(26, 19, 12, 2, "#DDE5F2"); for (const x of [27, 29, 31, 33, 35]) r(x, 19, 1, 2, "#26324F");
      r(4, 23, 56, 3, "#6B7694"); r(4, 23, 56, 1, "#B9C3D6"); r(4, 26, 56, 1, "#1B2133");
      r(12, 26, 4, 2, "#9AA5C0"); r(13, 27, 2, 1, "#04070F");
    } else {
      tire(r, 6, 34, 10, 11, f, -1); tire(r, 48, 34, 10, 11, f, 1);
      r(4, 0, 56, 36, C.R); r(4, 0, 56, 1, C.L); r(4, 1, 56, 1, C.H); r(4, 2, 3, 34, C.H); r(57, 2, 3, 34, C.D);
      r(7, 3, 50, 1, C.D); r(7, 33, 50, 1, C.D); r(31, 3, 2, 31, C.K);
      r(26, 18, 4, 1, "#9AA5C0"); r(34, 18, 4, 1, "#9AA5C0"); r(26, 19, 4, 1, "#46516F"); r(34, 19, 4, 1, "#46516F");
      for (const y of [7, 27]) { r(7, y, 2, 3, "#46516F"); r(55, y, 2, 3, "#46516F"); }
      r(8, 2, 2, 1, "#FFD27A"); r(54, 2, 2, 1, "#FFD27A"); r(29, 2, 6, 1, "#FFD27A");
      if (o.text) {
        r(8, 9, 48, 9, C.D);
        WG.text(g, o.text, 32, 10, { align: "center", color: C.L });
      }
      for (const x of [5, mir(5, 5)]) {
        r(x, 24, 5, 10, "#2A0710"); r(x + 1, 25, 3, 2, x === 5 ? amberL : amberR);
        r(x + 1, 27, 3, 2, lt[0]); r(x + 1, 29, 3, 2, lt[1]); r(x + 1, 31, 3, 2, lt[2]);
      }
      r(25, 28, 14, 5, "#1B2133"); r(26, 29, 12, 2, "#DDE5F2"); for (const x of [27, 29, 31, 33, 35]) r(x, 29, 1, 2, "#26324F");
      r(3, 35, 58, 3, "#2C3550"); r(3, 35, 58, 1, "#46516F"); r(22, 38, 20, 2, "#1B2133");
    }
    const out = outline(c, OUT);
    // a soft shadow on the road under it
    const og = out.getContext("2d");
    og.fillStyle = "rgba(2,4,10,.55)";
    og.fillRect(4, out.height - 1, out.width - 8, 1);
    return out;
  }

  // ---------- roadside things ----------
  // a pine: tiers that widen downward, lit from the upper left; snow on the tiers if o.snow
  function pine(h, o) {
    o = o || {};
    const w = Math.max(7, Math.round(h * 0.52) | 1);
    const { c, r } = pen(w, h);
    const rnd = WG.rng(o.seed || h * 7 + 1);
    const cx = (w - 1) / 2, trunk = Math.max(2, Math.round(h * 0.09)), bot = h - trunk;
    const tiers = Math.max(3, Math.round(h / 10)), th = bot / tiers;
    const D = o.dark || "#0A2E25", M = o.mid || "#11493A", L = o.light || "#1C6B52", HL = o.hi || "#2E8F6E";
    r(Math.round(cx) - 1, bot - 1, 3, trunk + 1, "#3A2618"); r(Math.round(cx) - 1, bot - 1, 1, trunk + 1, "#6B4A2E");
    for (let y = 0; y < bot; y++) {
      const t = Math.min(tiers - 1, Math.floor(y / th));
      const local = (y - t * th) / th;
      const full = (w / 2) * (0.32 + 0.68 * (t + 1) / tiers);
      let hw = full * (0.28 + 0.72 * local);
      if (y < 2) hw = 0.5;
      const x0 = Math.round(cx - hw), x1 = Math.round(cx + hw);
      for (let x = x0; x <= x1; x++) {
        const rel = (x - cx) / Math.max(1, hw);
        let col = rel < -0.4 ? L : rel < 0.3 ? M : D;
        if (local > 0.78 && rnd() < 0.45) col = D;
        if (rel < -0.55 && local < 0.6 && rnd() < 0.35) col = HL;
        if (o.snow && local < 0.42 && rnd() < 0.9) col = rel < 0.35 ? "#E3EBF8" : "#A9B9D8";
        if (local > 0.92 && (x === x0 || x === x1) && rnd() < 0.5) continue;
        r(x, y, 1, 1, col);
      }
    }
    return outline(c, o.out || "#03100C");
  }
  // a birch: a white trunk with dark marks, small clouds of leaves
  function birch(h, seed) {
    const w = Math.round(h * 0.42) | 1;
    const { c, r } = pen(w, h);
    const rnd = WG.rng(seed || 5), cx = Math.floor(w / 2);
    for (let i = 0; i < 26; i++) {
      const y = Math.floor(rnd() * h * 0.62), x = Math.floor(cx + (rnd() - 0.5) * w * (0.4 + y / h));
      const s = 2 + Math.floor(rnd() * 3);
      for (let yy = 0; yy < s; yy++) for (let xx = 0; xx < s + 1; xx++) {
        if ((xx === 0 || xx === s) && (yy === 0 || yy === s - 1)) continue;
        r(x + xx - 1, y + yy, 1, 1, rnd() < 0.3 ? "#2F7A52" : rnd() < 0.5 ? "#1F5A3E" : "#174532");
      }
      if (rnd() < 0.4) r(x, y, 1, 1, "#7DBA6E");
    }
    r(cx - 1, Math.round(h * 0.12), 3, h - Math.round(h * 0.12), "#DCE3EE");
    r(cx + 1, Math.round(h * 0.12), 1, h - Math.round(h * 0.12), "#A9B6CD");
    for (let y = Math.round(h * 0.15); y < h; y += 3 + Math.floor(rnd() * 4)) r(cx - 1 + Math.floor(rnd() * 2), y, 2, 1, "#1B2133");
    for (let k = 0; k < 4; k++) { const y = Math.round(h * (0.2 + k * 0.12)), dir = k % 2 ? 1 : -1; for (let i = 1; i < 4; i++) r(cx + dir * (i + 1), y - i, 1, 1, "#46516F"); }
    return outline(c, "#04100C");
  }
  // a boulder: a lumpy shape shaded from the upper left (o.snow: a white cap; o.ramp: its colours)
  function rock(w, h, o) {
    o = o || {};
    const { c, r } = pen(w, h);
    const rnd = WG.rng(o.seed || w * 13 + h);
    const R = o.ramp || ["#9AA5C0", "#6B7694", "#46516F", "#2C3550"];
    const cx = w / 2, rx = w / 2, ry = h, k1 = rnd() * 6, k2 = rnd() * 6;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (h - y - 0.5) / ry;
      const a = Math.atan2(dy, dx);
      const lim = 0.86 + 0.1 * Math.sin(a * 3 + k1) + 0.06 * Math.sin(a * 7 + k2);
      if (dx * dx + dy * dy > lim * lim) continue;
      const shade = -dx * 0.6 + (dy - 0.4) * 0.9 + (rnd() - 0.5) * 0.25;
      let col = shade > 0.45 ? R[0] : shade > 0 ? R[1] : shade > -0.45 ? R[2] : R[3];
      if (o.snow && dy > 0.62 - 0.1 * Math.sin(x * 0.9)) col = shade > 0.2 ? "#EAF0FA" : "#B6C4E2";
      if (o.moss && dy > 0.55 && rnd() < 0.25) col = "#1F7A55";
      r(x, y, 1, 1, col);
    }
    for (let i = 0; i < 3; i++) { const x = Math.floor(w * (0.3 + rnd() * 0.4)), y = Math.floor(h * (0.4 + rnd() * 0.3)); r(x, y, 1, 2, R[3]); r(x + 1, y + 2, 1, 1, R[3]); }
    return outline(c, o.out || "#0A0E1A");
  }

  WG.roadKit = { pen, outline, mix, RAMPS, car, pine, birch, rock };

  // ---------- the cover: night road toward the aurora, the convertible from behind ----------
  function cover(g, w, h) {
    art.sky(g, 0, 0, w, 40, 0, { still: true, seed: 14, top: "#03060E", bottom: "#152A58", curtain: 0.5 });
    art.moon(g, 104, 9, 4);
    art.ridge(g, 0, 37, w, 14, "#1A2B5C", 4, 40, 0.1);
    art.ridge(g, 0, 39, w, 6, "#122046", 8, 40, 0.06);
    const lr = WG.rng(3);
    for (let i = 0; i < 26; i++) { g.fillStyle = lr() < 0.6 ? "#FFD27A" : lr() < 0.5 ? "#7FE6F4" : "#FFF0C2"; g.fillRect(Math.floor(lr() * w), 37 + Math.floor(lr() * 3), 1, 1); }
    g.fillStyle = "#0B2119"; g.fillRect(0, 40, w, h - 40);
    // the road, row by row like the game: a gentle right-hand bend and red-white kerbs
    for (let y = 40; y < h; y++) {
      const t = (y - 40) / (h - 40), z = 1 / (t + 0.04);
      const cx = 64 + Math.pow(1 - t, 2) * 16, hw = 3 + t * 74, rw = hw / 6;
      const odd = Math.floor(z * 1.6) % 2;
      g.fillStyle = odd ? "#0E3326" : "#0B2B20"; g.fillRect(0, y, w, 1);
      g.fillStyle = odd ? "#C8304A" : "#D8DEEA"; g.fillRect(Math.round(cx - hw - rw), y, Math.round(2 * (hw + rw)), 1);
      g.fillStyle = odd ? "#343E5A" : "#2F3853"; g.fillRect(Math.round(cx - hw), y, Math.round(2 * hw), 1);
      if (odd) { g.fillStyle = "#C9D2E4"; for (const k of [-1 / 3, 1 / 3]) g.fillRect(Math.round(cx + k * 2 * hw - hw / 30), y, Math.max(1, Math.round(hw / 20)), 1); }
      const a = 0.16 * t; g.fillStyle = "rgba(255,236,190," + a.toFixed(3) + ")"; g.fillRect(Math.round(cx - 6 - t * 40), y, Math.round(12 + t * 80), 1);
    }
    // pines along both sides, smaller toward the bend
    const P = [pine(34, { seed: 2 }), pine(46, { seed: 5 })];
    for (const [x, y, s, i] of [[22, 46, 0.42, 0], [31, 43, 0.3, 1], [100, 44, 0.36, 1], [92, 42, 0.26, 0], [7, 58, 0.9, 1], [121, 56, 0.75, 0], [40, 41, 0.2, 0]]) {
      const im = P[i], dw = Math.round(im.width * s), dh = Math.round(im.height * s);
      g.drawImage(im, Math.round(x - dw / 2), y - dh, dw, dh);
    }
    // a rival ahead with its tail-lights, then the convertible
    const riv = car("coupe", "cyan", { brake: true });
    g.fillStyle = "rgba(255,46,76,.25)"; g.fillRect(70, 45, 13, 4);
    g.drawImage(riv, 70, 41, Math.round(riv.width * 0.2), Math.round(riv.height * 0.2));
    const me = car("roadster", "red", { lean: -1, hair: 1 });
    g.drawImage(me, Math.round(w / 2 - me.width / 2) - 4, h - me.height + 3);
    // speed lines
    g.fillStyle = "rgba(210,250,255,.5)";
    for (const [x, y, l] of [[6, 47, 6], [3, 54, 9], [118, 49, 7], [121, 60, 6]]) for (let i = 0; i < l; i++) g.fillRect(x + (x < 64 ? -i : i), y + Math.round(i * 0.35), 1, 1);
  }

  WG.registry.push({
    id: "road", title: "Ночное шоссе", genre: "race", levels: WG.VS_CPU, file: "road.js", cover,
    stages: 8, stageWord: "Трасса", stagesWord: "трассы", endless: "Свободная езда",
    blurb: "Кабриолет, ночная трасса и северное сияние: обгоняй соперников, успевай к контрольным точкам и выбирай развилкой, куда ехать дальше.",
  });
})();
