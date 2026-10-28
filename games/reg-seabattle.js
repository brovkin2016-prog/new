/* Морской бой — the registry entry of «seabattle» and its card: a night sea under the aurora with the chart's grid, three ships
   seen from above, a shell on its way, a ripple where it fell and a fire on a hit ship. Drawn by code on 128×72. */
"use strict";
(function () {
  const { art } = WG;
  // a warship seen from the side, bow to the right (to the left when flipped); (x, y) is the stern at the waterline
  function warship(g, x, y, flip, sc) {
    const R = (c, dx, dy, w, h) => { g.fillStyle = c; g.fillRect(flip ? Math.round(x - (dx + w) * sc) : Math.round(x + dx * sc), Math.round(y - (dy + h) * sc), Math.max(1, Math.round(w * sc)), Math.max(1, Math.round(h * sc))); };
    // the hull: a raked bow, a red waterline stripe
    for (let r = 0; r < 6; r++) { const a = 4 - Math.min(4, r) + (r === 0 ? 2 : 0), b = 46 + r * 2 + (r > 3 ? 1 : 0); R(r < 2 ? "#1B2133" : r < 4 ? "#46516F" : "#6B7694", a, r, b - a, 1); }
    R("#8E1F35", 6, 0, 40, 1); R("#9AA5C0", 0, 5, 56, 1); R("#2C3550", 0, 6, 55, 1);
    for (let i = 0; i < 12; i++) R("#2C3550", 6 + i * 4, 2, 1, 2);
    // funnels, bridge, mast
    R("#2C3550", 14, 7, 5, 6); R("#7FE6F4", 14, 10, 5, 1); R("#0A1020", 14, 12, 5, 1);
    R("#2C3550", 35, 7, 5, 5); R("#7FE6F4", 35, 9, 5, 1); R("#0A1020", 35, 11, 5, 1);
    R("#0A1020", 21, 6, 13, 9); R("#8794B6", 22, 6, 11, 7); R("#DCE4F4", 22, 12, 11, 1); R("#7FE6F4", 24, 9, 2, 1); R("#7FE6F4", 28, 9, 2, 1); R("#7FE6F4", 31, 9, 1, 1);
    R("#0A1020", 26, 15, 2, 8); R("#C9D6F2", 24, 21, 6, 1); R("#FFD27A", 26, 23, 2, 1);
    // turrets and their guns
    R("#0A1020", 44, 6, 8, 5); R("#5F6F93", 45, 6, 6, 4); R("#0A1020", 51, 8, 9, 1);
    R("#0A1020", 4, 6, 8, 5); R("#5F6F93", 5, 6, 6, 4); R("#0A1020", 11, 8, 8, 1);
    R("#EAF0FA", 1, 6, 2, 1);
  }
  function seabattleCover(g, w, h) {
    art.sky(g, 0, 0, w, 36, 0, { still: true, seed: 14, top: "#04070F", bottom: "#142449", curtain: 0.85 });
    art.moon(g, 112, 8, 3);
    art.ridge(g, 0, 34, w, 11, "#16264F", 4, 37, 0.1);
    art.pines(g, 0, 36, w, "#0A1530", 7, 3, 6, 5);
    art.bands(g, 0, 36, w, 36, ["#1B6E94", "#0F4A6E", "#0A3252", "#06182E"]);
    // the aurora's glow on the water
    art.dither(g, 20, 37, 50, 14, null, "rgba(52,211,153,.32)", 0.45);
    art.dither(g, 70, 37, 46, 12, null, "rgba(139,124,246,.3)", 0.4);
    const rnd = WG.rng(8);
    for (let k = 0; k < 120; k++) {
      const x = Math.floor(rnd() * w), y = 38 + Math.floor(rnd() * 33);
      g.fillStyle = rnd() > 0.72 ? "#7FE6F4" : rnd() > 0.4 ? "#2A86AE" : "#1B6E94"; g.fillRect(x, y, 2 + Math.floor(rnd() * 5), 1);
    }
    // the far ship (the enemy), hit: a fireball, smoke and a plume
    warship(g, 118, 46, true, 0.78);
    art.dither(g, 82, 26, 30, 24, null, "rgba(255,154,60,.4)", 0.35);
    art.disc(g, 100, 40, 6, "#D93644"); art.disc(g, 100, 40, 4.5, "#FF9A3C"); art.disc(g, 100, 40, 3, "#FFD27A"); art.disc(g, 99, 39, 1.5, "#FFFFFF");
    for (const [x, y, r, c] of [[103, 31, 3, "#46516F"], [106, 25, 4, "#3B4766"], [103, 19, 3, "#2C3550"], [108, 14, 3, "#1B2133"]]) art.disc(g, x, y, r, c);
    // a splash where a shell fell short
    for (let r = 0; r < 12; r++) { const wd = r < 2 ? 5 : r > 9 ? 3 : 4; g.fillStyle = r > 10 ? "#FFFFFF" : "#BFEFFA"; g.fillRect(70 - (wd >> 1), 52 - r, wd, 1); g.fillStyle = "#7FE6F4"; g.fillRect(70 + (wd >> 1) - 1, 52 - r, 1, 1); }
    g.fillStyle = "#D2FAFF";
    for (let a = 0; a < 40; a++) { const t = a / 40 * Math.PI * 2; g.fillRect(Math.round(70 + Math.cos(t) * 9), Math.round(53 + Math.sin(t) * 3), 1, 1); }
    for (const [x, y] of [[64, 44], [67, 41], [76, 43], [74, 46]]) { g.fillStyle = "#FFFFFF"; g.fillRect(x, y, 1, 1); }
    // our ship in front, firing: flash, smoke, the shell's path
    g.fillStyle = "rgba(2,10,24,.35)"; g.fillRect(4, 63, 62, 2);
    warship(g, 6, 63, false, 1);
    art.disc(g, 70, 55, 5, "#FF9A3C"); art.disc(g, 70, 55, 3, "#FFD27A"); art.disc(g, 70, 55, 1.5, "#FFFFFF");
    for (const [x, y, r, c] of [[74, 51, 3, "#9AA5C0"], [79, 47, 3, "#6B7694"], [76, 43, 2, "#46516F"]]) art.disc(g, x, y, r, c);
    for (let i = 0; i < 22; i++) {
      const k = i / 22, x = 76 + k * 12, y = 52 - k * 24 - Math.sin(k * Math.PI) * 6;
      g.fillStyle = i > 17 ? "#FFFFFF" : i % 2 ? "#FFD27A" : "#FF9A3C"; g.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
    // the sea in front: crests over the ship's feet
    for (let k = 0; k < 26; k++) { const x = Math.floor(rnd() * 70), y = 60 + Math.floor(rnd() * 11); g.fillStyle = rnd() > 0.5 ? "#7FE6F4" : "#2A86AE"; g.fillRect(x, y, 3 + Math.floor(rnd() * 5), 1); }
    for (const [x, y] of [[8, 14], [60, 8], [124, 28], [30, 22]]) { g.fillStyle = "#FFFFFF"; g.fillRect(x, y - 1, 1, 3); g.fillRect(x - 1, y, 3, 1); }
  }

  WG.registry.push(
    { id: "seabattle", title: "Морской бой", genre: "strategy", levels: WG.VS_CPU, file: "seabattle.js", cover: seabattleCover,
      stages: 10, stageWord: "Адмирал", stagesWord: "адмиралы", endless: "Свободный бой", rank: "score",
      blurb: "Расставь флот: линкор, два крейсера, три эсминца и четыре катера. Десять адмиралов со своим характером и свободный бой на пять уровней — очки считаются как сто минус твои выстрелы." },
  );
})();
