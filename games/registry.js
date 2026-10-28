/* Winger Games — the list of genres and games. A new game is one entry here plus its own file:
     { id, title, genre, levels, file, cover(g, w, h), blurb, rank }
   id      — the game's name in the rating ("snake"); the same id the game file passes to WG.game({id})
   title   — what the family sees
   genre   — one of WG.GENRES below (a genre with no games is not shown)
   levels  — ["normal"] for single-player games; ["easy","normal","hard","master","adaptive"] against the computer
   file    — the game's script next to this file, loaded when the game is opened
   cover   — draws the card's picture on a 128×72 pixel canvas with the engine's helpers (no images)
   blurb   — one short line under the title on the game's page
   rank    — "score" (default: more is better) or "time" (finished faster is better: patience, minesweeper)
   stages  — games played stage by stage: how many (Змейка 10, Танчики 35…); up to 3 stars each, the next opens once
             the one before is passed. With it: stageWord ("Поле"), stagesWord ("поля"), endless (false, or the name
             of the endless mode that plays for the best score, e.g. "Бесконечный сад") */
"use strict";
(function () {
  const { art } = WG;
  WG.GENRES = [
    { id: "sport", title: "Спорт", icon: "g-sport" },
    { id: "race", title: "Гонки", icon: "g-race" },
    { id: "cards", title: "Карточные", icon: "g-cards" },
    { id: "arcade", title: "Аркады", icon: "g-arcade" },
    { id: "puzzle", title: "Головоломки", icon: "g-puzzle" },
    { id: "strategy", title: "Стратегия", icon: "g-strategy" },
    { id: "adventure", title: "Приключения", icon: "g-adventure" },
  ];
  WG.VS_CPU = ["easy", "normal", "hard", "master", "adaptive"];

  // ---------- Змейка ----------
  function snakeCover(g, w, h) {
    art.sky(g, 0, 0, w, 30, 0, { still: true, seed: 9, top: "#04070F", bottom: "#142449", curtain: 0.6 });
    art.moon(g, 104, 9, 4);
    art.ridge(g, 0, 26, w, 10, "#15234A", 5, 30, 0.1);
    art.pines(g, 0, 29, w, "#0A1530", 8, 4, 9, 5);
    // the lawn
    for (let j = 0; j < 6; j++) for (let i = 0; i < 16; i++) {
      g.fillStyle = (i + j) % 2 ? "#17443A" : "#1A4B40";
      g.fillRect(i * 8, 32 + j * 8, 8, 8);
    }
    const rnd = WG.rng(4);
    for (let k = 0; k < 160; k++) {
      const x = Math.floor(rnd() * w), y = 33 + Math.floor(rnd() * 38);
      g.fillStyle = rnd() > 0.5 ? "#235E4E" : "#2A6D58"; g.fillRect(x, y, 1, rnd() > 0.6 ? 2 : 1);
    }
    for (const [x, y, c] of [[20, 40, "#EAF0FA"], [58, 66, "#C4BBFF"], [116, 44, "#FF8F8F"], [8, 64, "#FFD27A"], [84, 36, "#7FE6F4"]]) {
      g.fillStyle = c; g.fillRect(x, y - 1, 1, 1); g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y + 1, 1, 1);
      g.fillStyle = "#FFF0C2"; g.fillRect(x, y, 1, 1);
    }
    // the wall
    g.fillStyle = "#1B2133"; g.fillRect(0, 28, w, 5);
    for (let x = -3; x < w; x += 9) { g.fillStyle = (x / 9) % 2 ? "#4A5573" : "#525D7D"; g.fillRect(x + 1, 29, 8, 3); g.fillStyle = "#7782A2"; g.fillRect(x + 1, 29, 8, 1); }
    for (let x = 0; x < w; x += 3) if ((x * 7) % 5 < 2) { g.fillStyle = "#1FA874"; g.fillRect(x, 27, 1, 2); }
    // the snake: a wave across the lawn, head to the right, an apple ahead
    const pts = [];
    for (let x = 93; x >= 12; x -= 2) pts.push({ x, y: 52 + Math.round(9 * Math.sin((x - 92) / 13)) });
    art.tube(g, pts, { r: 3.5, outline: "#04231A", fill: "#3BDB9E", shade: "#13865B", light: "#C8FBE3", taper: 14,
      pattern: (d) => ((d + 2) % 6 < 1.6 ? (Math.floor((d + 2) / 6) % 3 === 0 ? "#7FE6F4" : "#1A9C6B") : null) });
    // the head: as wide as the body at the neck, widest at the jaw, a round snout; eyes on both sides
    const hx = 92, hy = 52, HW = [4, 4, 5, 5, 5, 5, 4, 4, 3, 2];
    const inH = (i, j) => i >= 0 && i < HW.length && Math.abs(j) <= HW[i];
    for (let i = 0; i < HW.length; i++) for (let j = -HW[i]; j <= HW[i]; j++) {
      const edge = !inH(i + 1, j) || !inH(i, j - 1) || !inH(i, j + 1);
      g.fillStyle = edge ? "#04231A" : j >= HW[i] - 1 || !inH(i + 2, j) ? "#13865B" : j <= -(HW[i] - 1) ? "#8EF0C6" : "#3BDB9E";
      g.fillRect(hx + i, hy + j, 1, 1);
    }
    for (const s of [-1, 1]) {
      g.fillStyle = "#04231A"; g.fillRect(hx + 3, hy + s * 4 - 1, 4, 3); g.fillRect(hx + 4, hy + s * 4 - 2, 2, 5);
      g.fillStyle = "#FFFFFF"; g.fillRect(hx + 4, hy + s * 4 - 1, 2, 2);
      g.fillStyle = "#0A0F1E"; g.fillRect(hx + 5, hy + s * 4 - (s < 0 ? 0 : 1), 1, 1);
    }
    g.fillStyle = "#04231A"; g.fillRect(hx + 8, hy - 1, 1, 1); g.fillRect(hx + 8, hy + 1, 1, 1);
    g.fillStyle = "#FF4D6A"; g.fillRect(hx + 10, hy, 2, 1); g.fillRect(hx + 12, hy - 1, 1, 1); g.fillRect(hx + 12, hy + 1, 1, 1);
    const apple = WG.sprite(["...sG..", "..s....", ".lr.rr.", "lhlrrrd", "lhrrrrd", "lrrrrdd", ".rrrdd.", "..d.d.."],
      { s: "#7A5236", G: "#34D399", l: "#FF8A97", h: "#FFE1E5", r: "#E0475B", d: "#9E2340" }, { outline: "#2A0912" });
    g.fillStyle = "rgba(0,12,10,.45)"; g.fillRect(113, 58, 7, 1);
    g.drawImage(apple, 112, 47);
    for (const [x, y] of [[124, 46], [110, 44]]) { g.fillStyle = "#FFFFFF"; g.fillRect(x, y, 1, 1); g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3); }
  }

  WG.registry.push(
    { id: "snake", title: "Змейка", genre: "arcade", levels: ["normal"], file: "snake.js", cover: snakeCover,
      stages: 10, stageWord: "Поле", stagesWord: "поля", endless: "Бесконечный сад",
      blurb: "Ночной сад, яблоки и змейка, которая растёт и ускоряется. Десять полей с камнями и порталами — и бесконечный сад на рекорд." },
  );
})();
