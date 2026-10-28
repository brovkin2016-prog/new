/* Теннис — the registry entry of «tennis» and its card: a floodlit court under the aurora, drawn by code on 128×72 */
"use strict";
(function () {
  const { art } = WG;
  const clamp = WG.util.clamp, lerp = WG.util.lerp;
  const BAY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  // the near player, seen from behind in the middle of a forehand; the far one, facing us
  const NEAR = [
    "......kkkkk.....",
    ".....khhhhhk....",
    "....khhHhhhhk...",
    "....kttttttk....",
    "....khhhhhhk....",
    "...kshhhhhhsk...",
    "...kkkssssskk...",
    "...kgggggggggkk.",
    "..kgllgggggGggk.",
    ".kgggggtgggGGggk",
    ".ksggggtggggGgsk",
    ".kskgggggggGgkk.",
    "..kk.gggggGGk...",
    "......ggggGGk...",
    "......kdddddk...",
    ".....kdDddddk...",
    ".....kdd.kddk...",
    ".....ksk.kssk...",
    ".....ksk.kssk...",
    ".....kwwk.kwwk..",
    "....kwwWk.kwwWk.",
    "....kkkkk.kkkkk.",
  ];
  const NEAR_PAL = { k: "#070B18", h: "#2B1B12", H: "#5B3A22", t: "#D8FFE9", s: "#F0C29B", g: "#34D399", G: "#1FA874", l: "#8EF0C6", d: "#0B4A33", D: "#127A52", w: "#F4FAFF", W: "#A9B6CD" };
  const RACKET = [
    "..kkkk..",
    ".kRRRRk.",
    "kRsRsRRk",
    "kRRsRsRk",
    "kRsRsRRk",
    ".kRRRRk.",
    "..kkkk..",
  ];
  const FAR = [
    "..kkkkk..",
    ".khhhhhk.",
    "kkhhhhhkk",
    "ksssssssk",
    "ksesssesk",
    ".ksssssk.",
    ".kyyyyyk.",
    "kyyyyyyyk",
    "ksyyyyysk",
    "ksyyyyysk",
    ".kkyyykk.",
    "..kdddk..",
    "..kd.dk..",
    "..kw.wk..",
  ];
  const FAR_PAL = { k: "#070B18", h: "#E0A24A", s: "#F2CBA6", e: "#2B1B12", y: "#FF9AAE", d: "#8E1F35", w: "#F4FAFF" };
  const BALL = ["..kkk..", ".kyYYk.", "kyYYYyk", "kyYYyyk", ".kyyyk.", "..kkk.."];
  const BALL_PAL = { k: "#2A3A06", y: "#9BC91E", Y: "#E8FF5A" };

  function tennisCover(g, w, h) {
    // the night and the aurora above the stands
    art.sky(g, 0, 0, w, 26, 3, { still: true, seed: 17, top: "#04070F", bottom: "#142449", curtain: 0.62, amount: 1 });
    // everything below the sky sits five pixels lower, so the aurora has room
    g.save(); g.translate(0, 5);
    art.ridge(g, 0, 20, w, 7, "#0F1B3D", 4, 28, 0.1);
    // the stands: tiers of the crowd, then the boards
    g.fillStyle = "#090D1F"; g.fillRect(0, 17, w, 13);
    art.bands(g, 0, 18, w, 11, ["#090D1F", "#10173A", "#1A2150"]);
    const rnd = WG.rng(41), tones = ["#7C4DB5", "#C85A6A", "#3A8FB5", "#D9A441", "#5BAE8F", "#B8C4D8", "#E8E1D0"];
    for (let r = 0; r < 3; r++) for (let x = 1 + r; x < w - 1; x += 2 + (rnd() < 0.3 ? 1 : 0)) {
      if (rnd() < 0.1) continue;
      const y = 19 + r * 3;
      g.fillStyle = "#1A2150"; g.fillRect(x - 1, y + 2, 3, 1);
      g.fillStyle = tones[(rnd() * tones.length) | 0]; g.fillRect(x, y + 1, 2, 2);
      g.fillStyle = "#E3B188"; g.fillRect(x, y, 2, 1);
    }
    g.fillStyle = "#0A0E1D"; g.fillRect(0, 15, w, 3); g.fillStyle = "#1D2944"; g.fillRect(0, 15, w, 1);
    for (let x = 3; x < w; x += 5) { g.fillStyle = "#FFF4C8"; g.fillRect(x, 17, 1, 1); }
    const boards = [["#0B4A33", "#8EF0C6"], ["#21194A", "#C4BBFF"], ["#0B3B4A", "#7FE6F4"], ["#6B4A0A", "#FFF0C2"]];
    for (let i = 0; i < 8; i++) {
      const [bg, fg] = boards[i % 4];
      g.fillStyle = bg; g.fillRect(i * 17, 29, 16, 3);
      g.fillStyle = fg; for (let k = 2; k < 14; k += 3) g.fillRect(i * 17 + k, 30, 2, 1);
    }
    // the floodlight masts at the corners
    for (const mx of [5, 120]) {
      art.dither(g, mx - 7, 0, 17, 14, null, "rgba(255,240,194,.35)", 0.5);
      g.fillStyle = "#0A0E1D"; g.fillRect(mx - 2, 3, 7, 4);
      g.fillStyle = "#FFF9DD"; for (let i = 0; i < 3; i++) g.fillRect(mx - 1 + i * 2, 4, 1, 2);
      g.fillStyle = "#0A0E1D"; g.fillRect(mx, 7, 1, 23);
    }
    // the court in perspective: the apron green, the court blue, dithered by the light
    const yF = 35, yN = 66, xFl = 42, xFr = 86, xNl = 14, xNr = 114;
    const edge = (y) => { const t = (y - yF) / (yN - yF); return [lerp(xFl, xNl, t), lerp(xFr, xNr, t)]; };
    const COURT = ["#0C3F61", "#0F5078", "#136290", "#1A76A6", "#2389BB"], APRON = ["#0A2A25", "#0D3A31", "#114A3D", "#175C4C", "#1F705C"];
    for (let y = 32; y < h; y++) {
      const t = clamp((y - yF) / (yN - yF), -0.2, 1.3);
      const [xl, xr] = edge(y);
      for (let x = 0; x < w; x++) {
        const inCourt = y >= yF && y <= yN && x >= xl && x <= xr;
        const ramp = inCourt ? COURT : APRON;
        const b = clamp(0.35 + 0.5 * (1 - Math.abs(x - 64) / 64) + 0.15 * (1 - Math.abs(t - 0.45)), 0, 1) * (inCourt ? 1 : 0.8);
        const v = b * (ramp.length - 1), base = Math.floor(v);
        g.fillStyle = ramp[clamp(base + (v - base > BAY[(y & 3) * 4 + (x & 3)] ? 1 : 0), 0, ramp.length - 1)];
        g.fillRect(x, y, 1, 1);
      }
    }
    // the lines
    g.fillStyle = "#EAF3FA";
    for (let y = yF; y <= yN; y++) { const [xl, xr] = edge(y); g.fillRect(Math.round(xl), y, 1, 1); g.fillRect(Math.round(xr), y, 1, 1); }
    for (const yy of [yF, yN, 42, 58]) { const [xl, xr] = edge(yy); g.fillRect(Math.round(xl), yy, Math.round(xr - xl) + 1, 1); }
    g.fillRect(64, 42, 1, 17);
    // the net: mesh, white tape, the posts
    const ny = 50, nl = 40, nr = 88;
    for (let x = nl; x <= nr; x++) for (let y = ny - 5; y <= ny; y++) { g.fillStyle = (x + y * 2) % 4 === 0 || (x - y * 2 + 400) % 4 === 0 ? "rgba(170,196,224,.6)" : "rgba(6,12,30,.55)"; g.fillRect(x, y, 1, 1); }
    g.fillStyle = "#EAF0FA"; g.fillRect(nl, ny - 6, nr - nl + 1, 1); g.fillStyle = "#9AA5C0"; g.fillRect(nl, ny - 5, nr - nl + 1, 1);
    g.fillStyle = "#0A0F1E"; g.fillRect(nl - 1, ny - 8, 3, 10); g.fillRect(nr - 1, ny - 8, 3, 10);
    g.fillStyle = "#6B7694"; g.fillRect(nl, ny - 7, 1, 8); g.fillRect(nr, ny - 7, 1, 8);
    art.dither(g, nl, ny + 1, nr - nl, 2, null, "rgba(0,8,20,.55)", 0.55);
    // the players: the far one over the net, the near one with her racket back
    g.fillStyle = "rgba(2,8,20,.45)"; g.fillRect(70, 38, 9, 1);
    g.drawImage(WG.sprite(FAR, FAR_PAL), 70, 25);
    g.fillStyle = "#070B18"; g.fillRect(68, 33, 3, 2); g.fillStyle = "#F2CBA6"; g.fillRect(68, 33, 2, 1);
    g.drawImage(WG.sprite(RACKET, { k: "#070B18", R: "#FF6B7A", s: "#D6ECFA" }), 61, 27);
    g.fillStyle = "rgba(2,8,20,.5)"; g.fillRect(39, 65, 15, 2); g.fillRect(41, 67, 11, 1);
    g.drawImage(WG.sprite(NEAR, NEAR_PAL), 38, 44);
    g.drawImage(WG.sprite(RACKET, { k: "#070B18", R: "#34D399", s: "#D6ECFA" }), 54, 52);
    // the ball with its trail and shadow, and a spark
    for (let i = 0; i < 5; i++) { g.fillStyle = "rgba(255,249,196," + (0.15 + i * 0.08).toFixed(2) + ")"; g.fillRect(60 - i * 3, 43 + i * 2, 2, 1); }
    g.fillStyle = "rgba(2,8,20,.5)"; g.fillRect(62, 56, 5, 1);
    g.drawImage(WG.sprite(BALL, BALL_PAL), 63, 41);
    for (const [x, y] of [[57, 59], [74, 49], [50, 44]]) { g.fillStyle = "#FFFFFF"; g.fillRect(x, y, 1, 1); g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3); }
    g.restore();
  }

  WG.registry.push({
    id: "tennis", title: "Теннис", genre: "sport", levels: WG.VS_CPU, file: "tennis.js", cover: tennisCover,
    stages: 7, stageWord: "Матч", stagesWord: "матчи", endless: "Тренировка",
    blurb: "Ночной корт под северным сиянием: подача, спин, свеча и укороченный. Кубок из семи матчей с разными соперниками — и бесконечная тренировка на очки.",
  });
})();
