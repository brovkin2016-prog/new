/* A tiny example against the computer (not shipped: games/dev/ stays on the laptop). It shows the parts of the engine
   a vs-computer game uses: levels through api.skill, a landscape-only screen (portrait:false), the A button,
   parallax, particles, and api.end({score, won}). To try it: open the catalog, then in the console
     WG.registry.push({id:"example", title:"Пинг-понг", genre:"sport", levels:WG.VS_CPU, file:"dev/example_vs.js"});
     location.hash = "#/play/example"; */
"use strict";
(function () {
  const { art } = WG;
  let LAYERS = null;
  function layers() {
    const far = WG.canvas(384, 60), fg = far.getContext("2d");
    art.ridge(fg, 0, 60, 384, 30, "#15234A", 2, 60, 0.1);
    const near = WG.canvas(384, 40), ng = near.getContext("2d");
    art.pines(ng, 0, 40, 384, "#0A1530", 5, 10, 22, 7);
    return new WG.Parallax([{ img: far, speed: 0.2, y: 34 }, { img: near, speed: 0.5, y: 56 }]);
  }
  WG.game({
    id: "example",
    portrait: false,
    controls: { dpad: true, a: "Подача", swipe: false },
    howto: "Отбивай мяч ракеткой и не пропускай. Игра до пяти очков.",
    keysHint: "Стрелки вверх и вниз — ракетка, пробел — подача.",
    create(api) {
      if (!LAYERS) LAYERS = layers();
      const fx = new WG.Particles();
      const S = { you: 108, cpu: 108, bx: 192, by: 140, vx: 0, vy: 0, serve: true, ys: 0, cs: 0, t: 0 };
      const P = 24;
      const speedCpu = 60 + 160 * api.skill; // pixels a second the computer's paddle can move
      return {
        _state: S,
        update(dt) {
          S.t += dt;
          fx.update(dt);
          if (api.input.held("up")) S.you -= 150 * dt;
          if (api.input.held("down")) S.you += 150 * dt;
          S.you = Math.max(96 + P / 2, Math.min(206 - P / 2, S.you));
          if (S.serve) {
            S.bx = 30; S.by = S.you;
            if (api.input.pressed("a") || api.input.tap) { S.serve = false; S.vx = 140; S.vy = (Math.random() - 0.5) * 120; api.sfx("bounce"); }
            return;
          }
          S.bx += S.vx * dt; S.by += S.vy * dt;
          if (S.by < 98 || S.by > 204) { S.vy = -S.vy; S.by = Math.max(98, Math.min(204, S.by)); api.sfx("bounce"); }
          const aim = S.vx > 0 ? S.by + (1 - api.skill) * 30 * Math.sin(S.t * 3) : 150;
          S.cpu += Math.max(-speedCpu * dt, Math.min(speedCpu * dt, aim - S.cpu));
          for (const [x, y, dir] of [[24, S.you, 1], [360, S.cpu, -1]]) {
            if (Math.abs(S.bx - x) < 4 && Math.abs(S.by - y) < P / 2 + 2 && Math.sign(S.vx) === -dir) {
              S.vx = -S.vx * 1.06; S.vy += (S.by - y) * 6; api.sfx("hit");
              fx.emit({ x: S.bx, y: S.by, n: 10, colors: ["#FFFFFF", "#7FE6F4"], speed: [20, 60], life: [0.2, 0.4] });
            }
          }
          if (S.bx < 0 || S.bx > 384) {
            if (S.bx < 0) S.cs++; else S.ys++;
            api.sfx(S.bx < 0 ? "hurt" : "coin");
            api.shake(2, 0.2);
            S.serve = true;
            if (S.ys >= 5 || S.cs >= 5) api.end({ score: S.ys * 10 + (S.ys >= 5 ? 50 : 0), won: S.ys >= 5, meta: { you: S.ys, cpu: S.cs } });
          }
        },
        draw(g) {
          art.sky(g, 0, 0, 384, 96, S.t, { seed: 3, curtain: 0.45 });
          LAYERS.draw(g, S.t * 20);
          art.bands(g, 0, 96, 384, 120, ["#123A31", "#0B2A22", "#071A15"]);
          g.fillStyle = "#EAF0FA";
          for (let y = 98; y < 206; y += 8) g.fillRect(191, y, 2, 4);
          g.fillStyle = "#34D399"; g.fillRect(20, Math.round(S.you - P / 2), 4, P);
          g.fillStyle = "#FF8F8F"; g.fillRect(360, Math.round(S.cpu - P / 2), 4, P);
          art.disc(g, S.bx, S.by, 2.5, "#FFFFFF");
          fx.draw(g);
          WG.text(g, S.ys + " : " + S.cs, 192, 8, { scale: 3, align: "center", shadow: "#04070F" });
          WG.text(g, api.levelName.toUpperCase(), 192, 34, { align: "center", color: "#A9B6CD", shadow: "#04070F" });
          if (S.serve) WG.text(g, "ПОДАЧА", 192, 150, { scale: 2, align: "center", color: "#FFD27A", shadow: "#2A1E00" });
        },
      };
    },
  });
})();
