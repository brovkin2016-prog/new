/* Песчаная крепость (prince) — the registry entry with its catalog card, and the hero's pixel art kit shared with
   prince.js: posed skeletons rasterised into outlined 16-bit sprites (WG.princeArt). */
"use strict";
(function () {
  const { art } = WG;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const D2R = Math.PI / 180;
  // ======================================================================= the skeleton → pixel frames
  // A pose: hip offset (x, y: + is lower), torso lean t (0 upright, + forward), arms a (near) and b (far): upper and
  // lower segment angles from straight down (+ toward the facing side), legs l (near) and m (far): thigh and shin.
  // Grounded poses are set down so the lowest point touches the floor; `air` poses hang from the origin as drawn.
  const FW = 96, FH = 80, OX = 48, OY = 74;
  function P(x, y, t, a1, a2, b1, b2, l1, l2, m1, m2, o) {
    return Object.assign({ x, y, t, a1, a2, b1, b2, l1, l2, m1, m2, h: 0, fa: 0, ma: 0, sa: null, air: false, item: null }, o || {});
  }
  const NUM = ["x", "y", "t", "a1", "a2", "b1", "b2", "l1", "l2", "m1", "m2", "h", "fa", "ma"];
  function mix(a, b, k) {
    const p = Object.assign({}, a);
    for (const n of NUM) p[n] = a[n] + (b[n] - a[n]) * k;
    p.sa = a.sa !== null && b.sa !== null ? a.sa + (b.sa - a.sa) * k : k < 0.5 ? a.sa : b.sa;
    p.air = k < 0.5 ? a.air : b.air;
    p.item = k < 0.5 ? a.item : b.item;
    return p;
  }
  const u32 = (hex) => { const n = parseInt(hex.slice(1), 16); return ((255 << 24) | ((n & 255) << 16) | (n & 0xff00) | ((n >> 16) & 255)) >>> 0; };
  const pal3 = (a) => a.map(u32);
  const darker = (hex, k) => { const n = parseInt(hex.slice(1), 16); const f = (v) => Math.round(v * k); return "#" + [f(n >> 16 & 255), f(n >> 8 & 255), f(n & 255)].map((v) => v.toString(16).padStart(2, "0")).join(""); };

  // heads, facing right; the digit-free letters are looked up in the costume's head palette
  const HEAD_HERO = [
    "....hhhh...",
    "...hHHhhh..",
    "..hhhhhhhh.",
    "bbbBBBBBBb.",
    ".b.hhSSSSs.",
    "...hSSSeSS.",
    "...hsSSSSSs",
    "...hhsSSs..",
    "....hdss...",
    ".....dd....",
  ];
  const HEAD_GUARD = [
    "...tTTTt...",
    "..tTTTTTTt.",
    ".tTTtTTTTTt",
    ".ttttttjttt",
    "...sSSSSs..",
    "...sSSeSS..",
    "...sSSSSSs.",
    "...kkSSSk..",
    "...kkkkkk..",
    "....kkkk...",
    ".....kk....",
  ];
  const HEAD_HELM = [
    ".....j.....",
    "....tTt....",
    "..tTTTTTt..",
    ".tTTTTTTTt.",
    ".tttttttttt",
    "...sSSSSs..",
    "...sSSeSS..",
    "...sSSSSSs.",
    "...kkSSSk..",
    "...kkkkkk..",
    "....kkk....",
  ];
  const COS = {
    hero: { k: 1, torso: [3.3, 4.2], skin: ["#F6CFA8", "#E0A47A", "#A8643F"], pants: ["#FFFFFF", "#DCE4F2", "#97A3BF"],
      top: ["#7FE6F4", "#22B8CF", "#0B6E8A"], shirt: ["#FFFFFF", "#EAF0FA", "#A9B6CD"], sash: ["#FFF0C2", "#FFD27A", "#C98A1B"],
      shoe: ["#A8774D", "#7A5236", "#4E3424"], sleeve: "top", out: "#070B16", head: HEAD_HERO,
      hp: { h: "#3A2418", H: "#6B4A30", b: "#C98A1B", B: "#FFD27A", S: "#F6CFA8", s: "#E0A47A", d: "#A8643F", e: "#0A0F1E" } },
  };
  function guardCos(name, top, pants, turban, jewel, beard, k, head) {
    COS[name] = { k, torso: [3.7, 4.7], skin: ["#E6B48A", "#C98A5E", "#8A5634"], pants, top, shirt: top, sash: ["#FFF0C2", "#FFD27A", "#C98A1B"],
      shoe: ["#6B4A30", "#4E3424", "#24170F"], sleeve: "top", coat: top, out: "#070B16", head: head || HEAD_GUARD,
      hp: { t: turban[1], T: turban[0], j: jewel, S: "#E6B48A", s: "#C98A5E", e: "#0A0F1E", k: beard } };
  }
  guardCos("g0", ["#FF6B7A", "#D93644", "#8E1F35"], ["#6B7694", "#46516F", "#2C3550"], ["#FFFFFF", "#C9D6F2"], "#FFD27A", "#24170F", 1.03);
  guardCos("g1", ["#C4BBFF", "#8B7CF6", "#4B3BA8"], ["#46516F", "#3B4766", "#232B44"], ["#FFF0C2", "#FFD27A"], "#D93644", "#24170F", 1.04);
  guardCos("g2", ["#7FE6F4", "#1F9AB0", "#0B4A5C"], ["#3B4766", "#2C3550", "#1B2133"], ["#EAF0FA", "#A9B6CD"], "#34D399", "#3A2418", 1.05);
  guardCos("g3", ["#C9D6F2", "#8590B0", "#46516F"], ["#2C3550", "#1B2133", "#0E1424"], ["#EAF0FA", "#9AA5C0"], "#FF6B7A", "#1B0A10", 1.06, HEAD_HELM);
  guardCos("boss", ["#5A6688", "#2C3550", "#121826"], ["#2C3550", "#1B2133", "#0E1424"], ["#FFD27A", "#C98A1B"], "#FF4D6A", "#0A0F1E", 1.1, HEAD_HELM);
  COS.boss.sash = ["#FF8F8F", "#D93644", "#8E1F35"];
  for (const c of Object.values(COS)) {
    c.u = { skin: pal3(c.skin), pants: pal3(c.pants), top: pal3(c.top), shirt: pal3(c.shirt), sash: pal3(c.sash), shoe: pal3(c.shoe),
      coat: c.coat ? pal3(c.coat) : null, out: u32(c.out) };
    const far = (a) => pal3([darker(a[0], 0.78), darker(a[1], 0.74), darker(a[2], 0.72)]);
    c.f = { skin: far(c.skin), pants: far(c.pants), top: far(c.top), shirt: far(c.shirt), shoe: far(c.shoe) };
    c.headPx = [];
    c.head.forEach((row, y) => [...row].forEach((ch, x) => { if (c.hp[ch]) c.headPx.push([x - 5, y - 5, u32(c.hp[ch])]); }));
  }
  const BLADE = [u32("#FFFFFF"), u32("#DCE6F5"), u32("#8C98B4")], HILT = [u32("#FFD27A"), u32("#C98A1B"), u32("#4E3424")];
  const GLASS = [u32("#C9D6F2"), u32("#FF6B7A"), u32("#8E1F35")];

  function joints(p, k) {
    const S = (a) => Math.sin(a * D2R), C = (a) => Math.cos(a * D2R);
    const hip = [OX + p.x, OY - 21 * k + p.y];
    const leg = (a1, a2, dx, fa) => {
      const h = [hip[0] + dx, hip[1]];
      const kn = [h[0] + S(a1) * 11 * k, h[1] + C(a1) * 11 * k];
      const an = [kn[0] + S(a2) * 10 * k, kn[1] + C(a2) * 10 * k];
      const f = a2 + fa;
      return { h, kn, an, toe: [an[0] + C(f) * 4 * k, an[1] - S(f) * 4 * k] };
    };
    const L = leg(p.l1, p.l2, 0, p.fa), M = leg(p.m1, p.m2, -1, p.ma);
    const up = [S(p.t), -C(p.t)];
    const neck = [hip[0] + up[0] * 13 * k, hip[1] + up[1] * 13 * k];
    const sh = [hip[0] + up[0] * 10.5 * k, hip[1] + up[1] * 10.5 * k];
    const hd = [neck[0] + S(p.t + p.h) * 4 * k, neck[1] - C(p.t + p.h) * 4 * k];
    const arm = (a1, a2, dx) => {
      const s = [sh[0] + dx, sh[1]];
      const el = [s[0] + S(a1) * 8 * k, s[1] + C(a1) * 8 * k];
      return { s, el, hn: [el[0] + S(a2) * 8 * k, el[1] + C(a2) * 8 * k] };
    };
    const A = arm(p.a1, p.a2, 0), B = arm(p.b1, p.b2, -1);
    const J = { hip, L, M, neck, sh, hd, A, B, up };
    if (!p.air) {
      const ys = [L.an[1] + 1.6, L.toe[1] + 1.3, M.an[1] + 1.6, M.toe[1] + 1.3, L.kn[1] + 2.6, M.kn[1] + 2.6, hip[1] + 3.4, neck[1] + 4, hd[1] + 5, A.hn[1] + 1.7, B.hn[1] + 1.7, A.el[1] + 1.8];
      const dy = OY - Math.max(...ys);
      const sh2 = (q) => { q[1] += dy; };
      for (const q of [hip, L.h, L.kn, L.an, L.toe, M.h, M.kn, M.an, M.toe, neck, sh, hd, A.s, A.el, A.hn, B.s, B.el, B.hn]) sh2(q);
    }
    return J;
  }
  // a capsule from a to b, radius r0→r1, shaded in three tones with the light from the upper left
  function capsule(buf, a, b, r0, r1, col, fn) {
    const ax = a[0], ay = a[1], bx = b[0], by = b[1];
    const R = Math.max(r0, r1) + 1;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - R)), x1 = Math.min(FW - 1, Math.ceil(Math.max(ax, bx) + R));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - R)), y1 = Math.min(FH - 1, Math.ceil(Math.max(ay, by) + R));
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-6;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const t = clamp(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1);
      const ex = px - (ax + dx * t), ey = py - (ay + dy * t);
      const r = r0 + (r1 - r0) * t;
      if (ex * ex + ey * ey > r * r) continue;
      const s = (ex * -0.55 + ey * -0.83) / Math.max(r, 0.9);
      let c = s > 0.42 ? col[0] : s < -0.38 ? col[2] : col[1];
      if (fn) { const o = fn(t, ex, ey, r, s); if (o) c = o; }
      buf[y * FW + x] = c;
    }
  }
  const plot = (buf, x, y, c) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < FW && y < FH) buf[y * FW + x] = c; };
  function sword(buf, hn, ang, len) {
    const d = [Math.sin(ang * D2R), Math.cos(ang * D2R)], n = [d[1], -d[0]];
    for (let i = -3; i <= 0; i++) plot(buf, hn[0] + d[0] * i, hn[1] + d[1] * i, i === -3 ? HILT[0] : HILT[2]);
    for (let j = -2; j <= 2; j++) plot(buf, hn[0] + d[0] * 1 + n[0] * j, hn[1] + d[1] * 1 + n[1] * j, j === -2 ? HILT[0] : HILT[1]);
    for (let i = 2; i <= len; i++) {
      const c = Math.pow(i / len, 2) * 2.6;
      const x = hn[0] + d[0] * i + n[0] * c, y = hn[1] + d[1] * i + n[1] * c;
      plot(buf, x, y, i >= len - 1 ? BLADE[0] : BLADE[1]);
      if (i < len - 2) plot(buf, x - n[0], y - n[1], BLADE[2]);
    }
  }
  function scabbard(buf, hip, k) {
    const ang = -128, d = [Math.sin(ang * D2R), Math.cos(ang * D2R)], n = [d[1], -d[0]];
    const s = [hip[0] - 1, hip[1] + 1];
    for (let i = 0; i <= 11 * k; i++) {
      const c = Math.pow(i / 11, 2) * 1.6;
      const x = s[0] + d[0] * i - n[0] * c, y = s[1] + d[1] * i - n[1] * c;
      plot(buf, x, y, i > 9 ? HILT[0] : HILT[2]);
      plot(buf, x + n[0], y + n[1], HILT[2]);
    }
    for (let i = 1; i <= 3; i++) plot(buf, s[0] - d[0] * i, s[1] - d[1] * i, i === 3 ? HILT[0] : HILT[2]);
  }
  function outline(buf, col) {
    const o = new Uint32Array(buf);
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      const i = y * FW + x;
      if (buf[i]) continue;
      if ((x > 0 && buf[i - 1]) || (x < FW - 1 && buf[i + 1]) || (y > 0 && buf[i - FW]) || (y < FH - 1 && buf[i + FW])) o[i] = col;
    }
    return o;
  }
  function renderPose(p, cos, armed, sheath) {
    const k = cos.k, J = joints(p, k), U = cos.u, F = cos.f;
    const far = new Uint32Array(FW * FH), near = new Uint32Array(FW * FH);
    if (sheath && !armed) scabbard(far, J.hip, k);
    // the far leg and arm, a shade darker
    capsule(far, J.M.h, J.M.kn, 3.0 * k, 2.6 * k, F.pants);
    capsule(far, J.M.kn, J.M.an, 2.5 * k, 2.0 * k, F.pants);
    capsule(far, J.M.an, J.M.toe, 1.6, 1.3, F.shoe);
    capsule(far, J.B.s, J.B.el, 1.9, 1.7, cos.sleeve === "top" ? F.top : F.shirt);
    capsule(far, J.B.el, J.B.hn, 1.6, 1.4, F.skin);
    capsule(far, J.B.hn, J.B.hn, 1.8, 1.8, F.skin);
    // the near leg, the coat, the body, the head, the near arm, the sword
    capsule(near, J.L.h, J.L.kn, 3.1 * k, 2.7 * k, U.pants);
    capsule(near, J.L.kn, J.L.an, 2.6 * k, 2.0 * k, U.pants, (t) => (t > 0.82 && !cos.coat ? U.sash[2] : 0));
    capsule(near, J.L.an, J.L.toe, 1.7, 1.4, U.shoe);
    if (cos.coat) {
      const a = (p.l1 + p.m1) / 2, end = [J.hip[0] + Math.sin(a * D2R) * 9 * k, J.hip[1] + Math.cos(a * D2R) * 9 * k];
      capsule(near, J.hip, end, 3.8 * k, 5.0 * k, U.coat, (t) => (t > 0.94 ? U.coat[2] : 0));
    }
    const tc = Math.cos(p.t * D2R), ts = Math.sin(p.t * D2R);
    capsule(near, J.hip, J.neck, cos.torso[0] * k, cos.torso[1] * k, U.top, (t, ex, ey, r, s) => {
      if (t < 0.2) return s > 0.4 ? U.sash[0] : s < -0.35 ? U.sash[2] : U.sash[1];
      const front = (ex * tc + ey * ts) / r;
      if (!cos.coat && front > 0.5 && t > 0.3) return s > 0.3 ? U.shirt[0] : U.shirt[1];
      if (cos.coat && Math.abs(front - 0.45) < 0.14 && t > 0.25) return U.sash[1];
      return 0;
    });
    const hx = Math.round(J.hd[0]), hy = Math.round(J.hd[1]);
    for (const [x, y, c] of cos.headPx) plot(near, hx + x, hy + y, c);
    capsule(near, J.A.s, J.A.el, 2.0, 1.7, cos.sleeve === "top" ? U.top : U.shirt);
    capsule(near, J.A.el, J.A.hn, 1.7, 1.45, U.skin);
    capsule(near, J.A.hn, J.A.hn, 1.9, 1.9, U.skin);
    if (armed && p.sa !== null) sword(near, J.A.hn, p.sa, Math.round(15 * k));
    if (p.item === "bottle") {
      const h = J.A.hn;
      for (let j = 0; j < 4; j++) for (let i = -1; i <= 1; i++) plot(near, h[0] + i + 1, h[1] - 2 - j, j === 3 ? GLASS[0] : i === -1 ? GLASS[1] : GLASS[2]);
    }
    const A = outline(far, cos.out), B = outline(near, cos.out);
    for (let i = 0; i < A.length; i++) if (B[i]) A[i] = B[i];
    const c = WG.canvas(FW, FH);
    const img = new ImageData(new Uint8ClampedArray(A.buffer), FW, FH);
    c.getContext("2d").putImageData(img, 0, 0);
    return c;
  }

  WG.princeArt = { P, mix, renderPose, COS, FW, FH, OX, OY, darker };

  // ---------- the catalog card: a leap over the gap between two walls, a guard waiting on the far side ----------
  function cover(g, w, h) {
    art.sky(g, 0, 0, w, 56, 0, { still: true, seed: 12, top: "#04070F", bottom: "#1B2A55", curtain: 0.42, amount: 1 });
    art.moon(g, 17, 11, 5);
    art.ridge(g, 0, 50, w, 9, "#1A2550", 31, 56, 0.04);
    // far towers of the fortress
    g.fillStyle = "#0F1630";
    for (const [x, tw, th] of [[30, 7, 18], [44, 10, 26], [60, 6, 14], [98, 9, 22], [114, 7, 16]]) {
      g.fillRect(x, 56 - th, tw, th);
      for (let k = 0; k < tw; k += 3) g.fillRect(x + k, 56 - th - 2, 2, 2);
    }
    art.disc(g, 49, 28, 5, "#0F1630"); g.fillRect(49, 20, 1, 4);
    g.fillStyle = "#FFD27A"; g.fillRect(48, 36, 1, 2); g.fillRect(102, 40, 1, 2); g.fillRect(33, 44, 1, 1);
    g.fillStyle = "#0F1630"; g.fillRect(0, 54, w, 3);
    // the two walls and the gap
    const wall = (x0, x1) => {
      g.fillStyle = "#24170F"; g.fillRect(x0, 58, x1 - x0, 14);
      for (let y = 62; y < 72; y += 5) for (let x = x0 - ((y / 5) % 2 ? 0 : 5); x < x1; x += 10) {
        const a = Math.max(x0, x + 1), b = Math.min(x1, x + 10);
        if (b > a) { g.fillStyle = (x / 10) % 2 ? "#946A43" : "#A0744B"; g.fillRect(a, y, b - a, 4); g.fillStyle = "#D2A877"; g.fillRect(a, y, b - a, 1); }
      }
      g.fillStyle = "#DDB683"; g.fillRect(x0, 58, x1 - x0, 3);
      g.fillStyle = "#F6DDB0"; g.fillRect(x0, 58, x1 - x0, 1);
      g.fillStyle = "#B98D5C"; g.fillRect(x0, 60, x1 - x0, 1);
    };
    // the parapets behind
    g.fillStyle = "#5E4028";
    for (const [x0, x1] of [[0, 50], [84, 128]]) {
      g.fillRect(x0, 50, x1 - x0, 8);
      for (let x = x0 + 1; x < x1 - 4; x += 8) { g.fillRect(x, 46, 5, 4); g.fillStyle = "#7A5236"; g.fillRect(x, 46, 5, 1); g.fillStyle = "#5E4028"; }
    }
    wall(0, 50); wall(84, 128);
    art.bands(g, 50, 58, 34, 14, ["#0B1226", "#070B16", "#04070F"]);
    // a lantern on the right wall
    g.fillStyle = "#24170F"; g.fillRect(122, 34, 1, 24);
    g.fillStyle = "#24170F"; g.fillRect(119, 30, 7, 7); g.fillStyle = "#FFD27A"; g.fillRect(120, 31, 5, 5); g.fillStyle = "#FFF0C2"; g.fillRect(121, 32, 2, 3);
    art.dither(g, 112, 24, 20, 20, null, "rgba(255,210,122,.18)", 0.5);
    // the hero mid-leap with his sword out, the guard on guard
    const hero = renderPose(P(0, 0, 14, 70, 112, -40, -20, 76, 44, -50, -88, { air: true, sa: 128 }), COS.hero, true, false);
    g.drawImage(hero, 60 - OX, 50 - OY);
    const guard = renderPose(P(0, 2, 4, 50, 94, -46, -112, 26, -4, -26, -22, { sa: 118 }), COS.g1, true, true);
    g.save(); g.translate(110, 0); g.scale(-1, 1); g.drawImage(guard, -OX, 58 - OY); g.restore();
    // a glint on the blade
    for (const [x, y] of [[82, 21], [92, 33]]) { g.fillStyle = "#FFFFFF"; g.fillRect(x, y, 1, 1); g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3); }
  }

  WG.registry.push({
    id: "prince", title: "Песчаная крепость", genre: "adventure", levels: WG.VS_CPU, file: "prince.js", cover, rank: "score",
    stages: 4, stageWord: "Уровень", stagesWord: "уровни", endless: "Весь путь",
    blurb: "Подземелья и стены крепости под северным сиянием: прыжки через пропасти, ловушки, зелья и бой на мечах со стражей. Четыре уровня — и весь путь на одних часах.",
  });
})();
