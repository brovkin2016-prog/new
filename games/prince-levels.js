/* Песчаная крепость — the levels. Loaded by prince.js; a new level is one more entry in this list (and the registry's
   `stages` count). Each level is a grid of rooms; a room is one screen: 3 rows of 12 cells (a cell is 32×64 px).
   A cell's floor is at its bottom; a stone block fills the whole cell, its top is the floor of the cell above.

     .  air                  =  floor                 #  stone block
     :  air, a torch on the wall behind              ;  air, a window behind
     t  floor + torch        w  floor + window        |  floor + a column (drawn in front of the hero)
     ^  spikes               ~  loose floor            K  chomper (blades that snap shut)
     A–D  gate               a–d  plate that lifts the gate of the same letter (for `gates[X]` seconds; 0 = for good)
     o  plate that opens the exit                     E  the exit door (open from the start unless the level has an
                                                         `o` plate or a commandant)
     h  potion: health       L  potion: one more life
     /  the sword            P  the hero starts here   g  a guard       X  the commandant
   Rooms on the edge are bounded by rock; falling below the last row is fatal.
   Per level: name, theme (dungeon | ramparts | palace | tower), outdoor (per room 1 = open sky), time (seconds for
   the level played on its own), star2 (seconds that must be left for ★★; ★★★ — the same and no life lost),
   tier (the guards' rank 0…3), sword (the hero starts with it), gates {A: seconds open}. */
"use strict";
(function () {
  WG.PRINCE_LEVELS = [
    {
      name: "Подземелье", theme: "dungeon", time: 300, star2: 160, tier: 0, sword: false, gates: { A: 9 },
      story: "Найди меч и выберись из подземелья.",
      rooms: [
        [
          ["#####.....##", "#.;...=/=t==", "#P=t=======#"],
          ["############", "=~====..==t=", "==L=====####"],
          ["####....####", "====.......#", "####=h=...:#"],
        ],
        [
          ["############", "#=E=t=====t=", "############"],
          ["############", "==A=.:....:=", "===a==g====="],
          ["#######===.#", "===^=====t=#", "############"],
        ],
      ],
    },
    {
      name: "Крепостная стена", theme: "ramparts", time: 330, star2: 160, tier: 1, sword: true, gates: { A: 9 },
      story: "Пройди по стене под сиянием и спустись во двор.",
      outdoor: [[1, 1, 1, 1], [0, 0, 0, 0]],
      rooms: [
        [
          ["............", "............", "P==t===^===="],
          ["............", "......==L=..", "===~~~~====="],
          ["............", "............", "====..===g=="],
          ["............", "............", "=====t=....."],
        ],
        [
          ["############", "..:.....:...", "=E==t=g==t=="],
          ["###....#####", "###^^^^#####", "===A====t==="],
          ["####..######", "####^^######", "======a=h==="],
          ["#######====.", "##########.=", "============"],
        ],
      ],
    },
    {
      name: "Дворец", theme: "palace", time: 360, star2: 170, tier: 2, sword: true, gates: { A: 7 },
      story: "Найди плиту, что открывает выход, и не попадись страже.",
      rooms: [
        [
          ["############", ";....;....;.", "P=|=K==|=g=="],
          ["############", "..==L=..;...", "=|=....=|==="],
          ["############", ";....;....;.", "==K=K==|=a=="],
          ["############", "...h....;...", "====A=g=...."],
        ],
        [
          ["############", ":....:....:.", "=E=|=====|=="],
          ["###....#####", "###^^^^#####", "=|==g=|==K=="],
          ["############", "....:....:..", "==o==K====h="],
          ["#######====.", "##########.=", "============"],
        ],
      ],
    },
    {
      name: "Звёздная башня", theme: "tower", time: 420, star2: 170, tier: 3, sword: true, gates: { A: 7 },
      story: "Поднимись на вершину башни и победи коменданта крепости.",
      outdoor: [[1, 1, 1], [0, 0, 0], [0, 0, 0]],
      rooms: [
        [
          ["............", "............", ".......=t==="],
          ["............", "............", "=~~=..==^==="],
          ["............", "........=E==", "==X=====...."],
        ],
        [
          ["....===.....", "==h=====t===", "############"],
          ["......==a=..", "=A====t====t", "############"],
          ["............", "===g=h===...", ".........=t="],
        ],
        [
          ["############", "..:.....:...", "P=t==^===h=="],
          ["############", "......:.....", "==~~====g==="],
          ["##.....===##", "....===.....", "============"],
        ],
      ],
    },
  ];
})();
