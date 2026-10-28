/* Падающие блоки — the registry entry of «blocks» and its card: the crystal well under the aurora, drawn by code on 128×72 */
"use strict";
(function () {
  const { art } = WG;
  const mix = (a, b, t) => {
    const A = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16)), B = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
    return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("");
  };
  // one beveled block at (x, y), n pixels square, in colour b
  function block(g, x, y, n, b) {
    const lt = mix(b, "#FFFFFF", 0.45), hi = mix(b, "#FFFFFF", 0.8), md = mix(b, "#04070F", 0.2), dk = mix(b, "#04070F", 0.66);
    g.fillStyle = dk; g.fillRect(x, y, n, n);
    g.fillStyle = lt; g.fillRect(x, y, n - 1, 1); g.fillRect(x, y, 1, n - 1);
    g.fillStyle = b; g.fillRect(x + 1, y + 1, n - 2, n - 2);
    g.fillStyle = md; g.fillRect(x + 1, y + n - 2, n - 2, 1); g.fillRect(x + n - 2, y + 1, 1, n - 2);
    g.fillStyle = hi; g.fillRect(x + 1, y + 1, 2, 1); g.fillRect(x + 1, y + 1, 1, 2);
  }
  function blocksCover(g, w, h) {
    art.sky(g, 0, 0, w, 56, 0, { still: true, seed: 12, top: "#04070F", bottom: "#142449", curtain: 0.62 });
    art.ridge(g, 0, 52, w, 14, "#1C2E5E", 5, 62, 0.1);
    art.ridge(g, 0, 58, w, 8, "#12214A", 11, 64, 0.06);
    art.pines(g, 0, 62, w, "#0A1530", 8, 4, 11, 5);
    g.fillStyle = "#0A1530"; g.fillRect(0, 62, w, 10);
    art.dither(g, 0, 60, w, 12, null, "#0F1A38", 0.4);
    // side panels: hold on the left, the next piece on the right
    for (const x of [6, 98]) { g.fillStyle = "rgba(6,10,24,.8)"; g.fillRect(x, 6, 24, 20); g.fillStyle = "#26324F"; g.fillRect(x, 6, 24, 1); g.fillRect(x, 25, 24, 1); g.fillRect(x, 6, 1, 20); g.fillRect(x + 23, 6, 1, 20); }
    const col = { I: "#5ED6EA", J: "#6F8BFF", L: "#FF9F5A", O: "#FFD27A", S: "#34D399", T: "#A08CFF", Z: "#FF6B7A" };
    const mini = (cells, c, x, y) => { for (const [i, j] of cells) block(g, x + i * 4, y + j * 4, 4, c); };
    mini([[0, 0], [0, 1], [1, 1], [2, 1]], col.J, 11, 12);
    mini([[0, 0], [1, 0], [1, 1], [2, 1]], col.Z, 105, 12);
    // the well: 10 cells of 6 px, cut by the card's bottom edge
    const C = 6, x0 = 34, wy = -6, ww = 60;
    g.fillStyle = "#04070F"; g.fillRect(x0 - 3, 0, ww + 6, h);
    g.fillStyle = "#3B4766"; g.fillRect(x0 - 2, 0, ww + 4, h);
    g.fillStyle = "#A9B6CD"; g.fillRect(x0 - 2, 0, 1, h); g.fillStyle = "#1D2944"; g.fillRect(x0 + ww + 1, 0, 1, h);
    art.bands(g, x0, 0, ww, h, ["#060B1A", "#0A1228", "#0F2438"]);
    for (let j = 1; j < 12; j++) for (let i = 1; i < 10; i++) { g.fillStyle = "rgba(127,230,244,.16)"; g.fillRect(x0 + i * C, j * C - 6 + 6, 1, 1); }
    // the stack in the well's bottom rows
    const rows = ["IIJJJ.LLLZ", "ITTTJ.LOOZ", "SSTJJ.LOOZ", "ZSSTOOLLZZ", "ZZSSOOTLLJ"];
    const clr = { I: col.I, J: col.J, L: col.L, O: col.O, S: col.S, T: col.T, Z: col.Z };
    rows.forEach((r, j) => [...r].forEach((ch, i) => { if (ch !== ".") block(g, x0 + i * C, h - (rows.length - j) * C, C, clr[ch]); }));
    // the long piece falling into the gap, with its ghost
    for (let k = 0; k < 4; k++) {
      g.fillStyle = "rgba(127,230,244,.18)"; g.fillRect(x0 + 5 * C, h - (6 - k) * C, C, C);
      g.fillStyle = "#7FE6F4"; g.fillRect(x0 + 5 * C, h - (6 - k) * C, C, 1); g.fillRect(x0 + 5 * C, h - (6 - k) * C, 1, C);
    }
    for (let k = 0; k < 4; k++) block(g, x0 + 5 * C, 4 + k * C, C, col.I);
    // a streak behind the falling piece and a few sparks
    for (const [x, y, a] of [[x0 + 5 * C + 1, 0, 0.35], [x0 + 5 * C + 3, 0, 0.55], [x0 + 5 * C + 5, 0, 0.3]]) { g.fillStyle = "rgba(210,250,255," + a + ")"; g.fillRect(x, y, 1, 4); }
    for (const [x, y] of [[x0 - 8, 50], [x0 + ww + 8, 44], [x0 + 20, 26], [x0 + 44, 16]]) { g.fillStyle = "#FFFFFF"; g.fillRect(x, y, 1, 1); g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3); }
    // the bright line-clear flash on the second row
    g.fillStyle = "rgba(255,255,255,.28)"; g.fillRect(x0, h - 3 * C, ww, 1);
    for (const [x, y] of [[x0 - 10, 30], [x0 + ww + 12, 34]]) { g.fillStyle = "#8EF0C6"; g.fillRect(x, y, 1, 1); }
  }
  WG.registry.push({
    id: "blocks", title: "Падающие блоки", genre: "puzzle", levels: ["normal"], file: "blocks.js", cover: blocksCover, rank: "score",
    blurb: "Хрустальный колодец под северным сиянием: складывай падающие фигуры в ряды, держи одну про запас и набирай комбо — скорость растёт каждые 10 рядов.",
  });
})();
