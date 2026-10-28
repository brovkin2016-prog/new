/* (stage 1) the registry entry of «tennis» — written by its game agent */
"use strict";
(function () {
  WG.registry.push({
    id: "tennis", title: "Теннис", genre: "sport", levels: WG.VS_CPU, file: "tennis.js",
    stages: 7, stageWord: "Матч", stagesWord: "матчи", endless: "Тренировка",
    cover(g, w, h) { g.fillStyle = "#123"; g.fillRect(0, 0, w, h); },
    blurb: "Ночной корт под северным сиянием: бей, выигрывай геймы и пройди Кубок из семи матчей.",
  });
})();
