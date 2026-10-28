/* Песчаная крепость — a cinematic platformer in a sandstone fortress under the aurora: flip-screen rooms, a hero
   animated from posed skeletons (keyframed like rotoscoped film, rasterised to outlined pixel art), traps, potions,
   sword fights with guards whose skill follows the level, and one hourglass for the whole run.
   Levels live in prince-levels.js (WG.PRINCE_LEVELS). Written against the Winger Games engine (engine.js, ENGINE.md). */
"use strict";
(function () {
  const ID = "prince";
  if (WG.PRINCE_LEVELS) boot();
  else {
    const s = document.createElement("script");
    s.src = "prince-levels.js" + (WG.version ? "?v=" + WG.version : "");
    s.onload = boot;
    s.onerror = () => WG.game({ id: ID, portrait: false, howto: "Уровни не загрузились — проверьте связь.",
      create() { return { update() {}, draw(g) { g.fillStyle = "#0A0F1E"; g.fillRect(0, 0, 384, 216); WG.text(g, "УРОВНИ НЕ ЗАГРУЗИЛИСЬ", 192, 100, { align: "center", color: "#FF8F8F" }); } }; } });
    document.head.append(s);
  }

  function boot() {
  const { art } = WG;
  const clamp = WG.util.clamp, lerp = WG.util.lerp;
  const LEVELS = WG.PRINCE_LEVELS;
  const TW = 32, TH = 64, RC = 12, RR = 3, RW = TW * RC, RH = TH * RR, HUD = 24, FLO = 60;
  const FL = (r) => r * TH + FLO;
  const colOf = (x) => Math.floor(x / TW);
  const RUN = 92, GRAV = 1150, HANG = 48, REACH = 42;
  const SKILL = { easy: 0.15, normal: 0.45, hard: 0.75, master: 1 };
  const LVL_KEYS = ["easy", "normal", "hard", "master", "adaptive"];
  const RUN_TIME = 20 * 60; // «Весь путь»: all the levels against one hourglass
  const LEVEL_POINTS = 600; // the run's score: 600 a level passed + the seconds left when the last door closes
  const sstep = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const D2R = Math.PI / 180;

  // the skeleton renderer and the costumes live in reg-prince.js (the catalog card uses them too)
  const { P, mix, renderPose, COS, FW, FH, OX, OY, darker } = WG.princeArt;

  // ---------- the poses ----------
  const STAND = P(0, 0, 2, 6, 12, -6, 2, 2, -1, -3, -3);
  const BREATH = P(0, 0.6, 3, 7, 14, -5, 4, 2, -1, -3, -3);
  const MID = P(0, 0, 0, 1, 4, -1, 2, 1, -1, -1, -2);
  const R1 = P(0, 0, 14, -32, -8, 30, 62, 40, 12, -32, -78), R2 = P(0, 1, 12, -20, 8, 28, 72, 22, -2, -16, -86);
  const R3 = P(0, 0, 11, 0, 22, 8, 42, 4, -10, 28, -42), R4 = P(0, -1, 13, 24, 70, -22, -6, -24, -42, 52, 14);
  const R5 = P(0, 0, 14, 30, 62, -32, -8, -32, -78, 40, 12), R6 = P(0, 1, 12, 28, 72, -20, 8, -16, -86, 22, -2);
  const R7 = P(0, 0, 11, 8, 42, 0, 22, 28, -42, 4, -10), R8 = P(0, -1, 13, -22, -6, 24, 70, 52, 14, -24, -42);
  const CROUCH = P(0, 0, 24, 30, 64, 18, 50, 80, -30, 64, -44);
  const LAND = P(0, 0, 20, 22, 44, 12, 34, 52, -30, 38, -44);
  const KNEEL = P(0, 0, 10, 16, 38, 6, 28, 84, -4, -46, -100, { ma: 40 });
  const DRINK1 = P(0, 0, 0, 62, 168, 6, 28, 84, -4, -46, -100, { h: -12, ma: 40, item: "bottle" });
  const DRINK2 = P(0, 0, -8, 74, 176, 6, 28, 84, -4, -46, -100, { h: -22, ma: 40, item: "bottle" });
  const HANGP = P(0, 0, -6, 162, 172, 158, 170, 3, -3, -5, -9, { air: true });
  const HANGP2 = P(0, 0, -4, 162, 172, 158, 170, 9, 1, -1, -5, { air: true });
  const C1 = P(0, 0, 6, 158, 206, 154, 200, 8, -14, 0, -22, { air: true });
  const C2 = P(0, 0, 30, 102, 186, 98, 180, 48, -8, 18, -40, { air: true });
  const C3 = P(0, 0, 42, 62, 112, 58, 106, 100, 10, 30, -52, { air: true });
  const C4 = P(0, 0, 22, 32, 64, 22, 52, 86, -8, -40, -98, { ma: 40 });
  const SJ1 = P(0, 0, 28, -46, -20, -52, -26, 52, -28, 40, -38);
  const SJ2 = P(0, 0, 22, 86, 106, 76, 98, 12, -6, -32, -44, { air: true });
  const SJ3 = P(0, 0, 16, 62, 86, 54, 80, 74, -18, 54, -40, { air: true });
  const SJ4 = P(0, 0, 10, 40, 62, 32, 52, 40, 6, 22, -12, { air: true });
  const RJ1 = P(0, 0, 18, -46, -12, 56, 92, -28, -62, 60, 30, { air: true });
  const RJ2 = P(0, 0, 14, 64, 104, -44, -24, 76, 44, -48, -86, { air: true });
  const RJ3 = P(0, 0, 10, 70, 110, -30, 0, 54, 22, -22, -60, { air: true });
  const F1 = P(0, 0, -6, 140, 170, -120, -150, 16, -22, -10, -36, { air: true });
  const F2 = P(0, 0, -9, 118, 150, -142, -172, -6, -36, 16, -10, { air: true });
  const DEAD = P(0, 0, -90, 84, 96, 70, 92, 88, 92, 94, 98);
  const FACEDOWN = P(0, 0, 76, 96, 100, 84, 104, 92, 86, 84, 80);
  const SPIKED = P(0, -6, 34, 48, 92, 36, 76, 70, -24, 58, -34, { air: true });
  // the sword stance and its moves
  const EG = P(0, 2, 4, 50, 94, -30, -150, 26, -4, -26, -22, { sa: 118 });
  const EG2 = P(0, 3, 5, 52, 96, -28, -146, 26, -4, -26, -22, { sa: 116 });
  const ADV = P(2, 1, 6, 50, 94, -32, -150, 34, -2, -20, -18, { sa: 118 });
  const RET = P(-2, 1, 2, 48, 94, -32, -150, 18, -6, -34, -26, { sa: 118 });
  const WIND = P(-2, 2, -6, 140, 206, -40, -82, 20, -6, -30, -24, { sa: 204 });
  const LUNGE = P(7, 4, 16, 86, 92, -70, -40, 54, 22, -42, -52, { sa: 92 });
  const PARRY = P(-1, 2, -2, 98, 162, -32, -150, 24, -4, -28, -22, { sa: 174 });
  const RECOIL = P(-3, 1, -14, 70, 150, -52, -100, 18, -8, -30, -26, { sa: 150 });
  const HITP = P(-4, 2, -20, 20, 60, -60, -30, 12, -12, -24, -30, { sa: 60 });
  const HITU = P(-4, 2, -20, -30, 10, -60, -30, 12, -12, -24, -30);
  const DRAW1 = P(0, 1, 0, -38, 30, -10, 0, 10, -4, -14, -12, { sa: -150 });

  const AN = {
    idle: { d: 2.4, loop: true, fps: 8, keys: [[0, STAND], [1.2, BREATH], [2.4, STAND]] },
    turn: { d: 0.18, fps: 30, keys: [[0, STAND], [0.09, MID], [0.18, STAND]] },
    runStart: { d: 0.24, fps: 30, keys: [[0, STAND], [0.1, P(0, 1, 10, -12, 10, 14, 40, 20, -10, -10, -32)], [0.24, R1]] },
    run: { d: 0.6, loop: true, fps: 30, keys: [[0, R1], [0.075, R2], [0.15, R3], [0.225, R4], [0.3, R5], [0.375, R6], [0.45, R7], [0.525, R8], [0.6, R1]] },
    walk: { d: 0.9, loop: true, fps: 20, keys: [[0, P(0, 0, 4, -14, -2, 14, 30, 18, 2, -16, -30)], [0.225, P(0, 0, 3, 0, 8, 0, 12, 2, -6, 8, -24)], [0.45, P(0, 0, 4, 14, 30, -14, -2, -16, -30, 18, 2)], [0.675, P(0, 0, 3, 0, 12, 0, 8, 8, -24, 2, -6)], [0.9, P(0, 0, 4, -14, -2, 14, 30, 18, 2, -16, -30)]] },
    runStop: { d: 0.26, fps: 30, keys: [[0, R5], [0.1, P(0, 2, -10, 32, 62, 22, 52, 44, 22, -12, -30)], [0.26, STAND]] },
    step: { d: 0.42, fps: 24, keys: [[0, STAND], [0.14, P(0, 0, 5, 10, 22, -8, 0, 32, -18, -4, -4)], [0.28, P(0, 0, 4, 8, 16, -6, 4, 16, 2, -12, -16)], [0.42, STAND]] },
    teeter: { d: 0.42, fps: 24, keys: [[0, STAND], [0.14, P(0, 0, 12, 30, 60, -30, -60, 30, -10, -4, -4)], [0.28, P(0, 0, -6, 60, 100, -50, -90, 10, -2, -6, -8)], [0.42, STAND]] },
    crouchDown: { d: 0.16, fps: 30, keys: [[0, STAND], [0.16, CROUCH]] },
    crouch: { d: 1, keys: [[0, CROUCH], [1, CROUCH]] },
    crouchUp: { d: 0.2, fps: 30, keys: [[0, CROUCH], [0.2, STAND]] },
    drink: { d: 1.3, fps: 20, keys: [[0, STAND], [0.24, KNEEL], [0.45, DRINK1], [0.75, DRINK2], [1.0, DRINK2], [1.12, KNEEL], [1.3, STAND]] },
    pick: { d: 1.1, fps: 20, keys: [[0, STAND], [0.24, KNEEL], [0.42, P(0, 0, 18, 44, 84, 6, 28, 84, -4, -46, -100, { ma: 40, sa: 92 })], [0.7, P(0, 0, 0, 150, 176, -12, 10, 84, -4, -46, -100, { ma: 40, sa: 178 })], [0.92, P(0, 0, 0, 150, 176, -12, 10, 10, -2, -6, -8, { sa: 178 })], [1.1, P(0, 0, 2, 50, 94, -6, 2, 2, -1, -3, -3, { sa: 118 })]] },
    jumpUp: { d: 0.5, fps: 30, keys: [[0, STAND], [0.12, P(0, 4, 14, -30, -10, -36, -14, 50, -24, 40, -34)], [0.24, P(0, 0, 0, 172, 178, 166, 174, 2, -4, -6, -10, { air: true })], [0.38, P(0, 0, 0, 160, 170, 150, 165, 6, -8, -6, -12, { air: true })], [0.5, STAND]] },
    hang: { d: 1.6, loop: true, fps: 12, keys: [[0, HANGP], [0.8, HANGP2], [1.6, HANGP]] },
    climb: { d: 1.0, fps: 24, keys: [[0, HANGP], [0.22, C1], [0.45, C2], [0.65, C3], [0.82, C4], [1.0, STAND]] },
    jumpPrep: { d: 0.16, fps: 30, keys: [[0, STAND], [0.16, SJ1]] },
    jumpAir: { d: 0.46, fps: 30, keys: [[0, SJ2], [0.2, SJ3], [0.46, SJ4]] },
    leap: { d: 0.52, fps: 30, keys: [[0, RJ1], [0.16, RJ2], [0.36, RJ3], [0.52, SJ4]] },
    fall: { d: 0.4, loop: true, fps: 12, keys: [[0, F1], [0.2, F2], [0.4, F1]] },
    land: { d: 0.26, fps: 30, keys: [[0, LAND], [0.26, STAND]] },
    landHard: { d: 0.7, fps: 20, keys: [[0, P(0, 0, 40, 60, 90, 50, 86, 70, -40, 60, -50)], [0.45, P(0, 0, 36, 56, 86, 46, 82, 70, -40, 60, -50)], [0.7, STAND]] },
    bump: { d: 0.3, fps: 24, keys: [[0, P(-2, 0, -14, -20, 10, -30, 0, 10, -10, -20, -20)], [0.3, STAND]] },
    die: { d: 0.9, fps: 20, keys: [[0, P(0, 1, -18, -30, 10, -50, 0, 18, -12, -10, -30)], [0.35, P(0, 0, -6, -10, 30, -20, 10, 92, -6, 84, -12)], [0.65, P(0, 0, 30, 40, 80, 30, 70, 95, -40, 90, -50)], [0.9, FACEDOWN]] },
    dead: { d: 1, keys: [[0, FACEDOWN], [1, FACEDOWN]] },
    deadBack: { d: 1, keys: [[0, DEAD], [1, DEAD]] },
    splat: { d: 0.25, fps: 24, keys: [[0, LAND], [0.25, FACEDOWN]] },
    spiked: { d: 1, keys: [[0, SPIKED], [1, SPIKED]] },
    guard: { d: 1.2, loop: true, fps: 10, keys: [[0, EG], [0.6, EG2], [1.2, EG]] },
    draw: { d: 0.32, fps: 30, keys: [[0, STAND], [0.14, DRAW1], [0.32, EG]] },
    sheathe: { d: 0.32, fps: 30, keys: [[0, EG], [0.18, DRAW1], [0.32, STAND]] },
    gturn: { d: 0.18, fps: 30, keys: [[0, EG], [0.09, P(0, 2, 0, 20, 60, -20, -40, 4, -2, -4, -4, { sa: 150 })], [0.18, EG]] },
    advance: { d: 0.3, fps: 30, keys: [[0, EG], [0.15, ADV], [0.3, EG]] },
    retreat: { d: 0.3, fps: 30, keys: [[0, EG], [0.15, RET], [0.3, EG]] },
    strike: { d: 0.44, fps: 30, keys: [[0, EG], [0.14, WIND], [0.2, LUNGE], [0.3, LUNGE], [0.44, EG]] },
    parry: { d: 0.3, fps: 30, keys: [[0, EG], [0.04, PARRY], [0.26, PARRY], [0.3, EG]] },
    recoil: { d: 0.3, fps: 30, keys: [[0, RECOIL], [0.3, EG]] },
    hit: { d: 0.3, fps: 30, keys: [[0, HITP], [0.3, EG]] },
    hitU: { d: 0.3, fps: 30, keys: [[0, HITU], [0.3, STAND]] },
  };
  function sample(an, t) {
    const K = an.keys;
    if (t <= K[0][0]) return K[0][1];
    for (let i = 1; i < K.length; i++) if (t <= K[i][0]) {
      const [t0, a] = K[i - 1], [t1, b] = K[i];
      return mix(a, b, sstep((t - t0) / Math.max(1e-6, t1 - t0)));
    }
    return K[K.length - 1][1];
  }
  const frameCache = new Map();
  function frame(cosName, anim, t, armed, sheath) {
    const an = AN[anim], fps = an.fps || 24;
    let tt = an.loop ? ((t % an.d) + an.d) % an.d : clamp(t, 0, an.d);
    const i = Math.min(Math.floor(tt * fps + 1e-6), Math.floor(an.d * fps));
    const key = cosName + "|" + anim + "|" + i + "|" + (armed ? 1 : 0) + (sheath ? 1 : 0);
    let c = frameCache.get(key);
    if (!c) { c = renderPose(sample(an, i / fps), COS[cosName], armed, sheath); frameCache.set(key, c); }
    return c;
  }
  function drawActor(g, img, x, y, face, alpha) {
    const X = Math.round(x), Y = Math.round(y);
    if (alpha !== undefined && alpha < 1) g.globalAlpha = Math.max(0, alpha);
    if (face > 0) g.drawImage(img, X - OX, Y - OY);
    else { g.save(); g.translate(X, 0); g.scale(-1, 1); g.drawImage(img, -OX, Y - OY); g.restore(); }
    g.globalAlpha = 1;
  }

  // ======================================================================= props
  const SPR = {};
  function sprites() {
    if (SPR.done) return;
    SPR.done = true;
    SPR.heal = WG.sprite(["..ccc..", "..gwg..", "..gRg..", ".grRrg.", "grRrrrg", "grrrrdg", "grrrddg", ".gdddg."],
      { c: "#A8774D", g: "#C9D6F2", w: "#FFFFFF", R: "#FF8A97", r: "#E0475B", d: "#8E1F35" }, { outline: "#1B0A10" });
    SPR.life = WG.sprite(["...ccc...", "...gwg...", "...gRg...", "..gRrrg..", ".gRrrrrg.", "gRrrrrrdg", "grrRrrrdg", "grrrrrddg", "grrrrrddg", ".grrrddg.", "..gdddg.."],
      { c: "#A8774D", g: "#EDE9FF", w: "#FFFFFF", R: "#D2FAFF", r: "#22B8CF", d: "#0B4A5C" }, { outline: "#061420" });
    SPR.swordFloor = WG.sprite(["..............wW.", "..........wwwWW..", "aa.k.wwwwwss.....", "AaKkkssss........", "aa.k............."],
      { w: "#DCE6F5", W: "#FFFFFF", s: "#8C98B4", a: "#C98A1B", A: "#FFD27A", k: "#4E3424", K: "#7A5236" }, { outline: "#070B16" });
    SPR.heart = WG.sprite([".rr.rr.", "rRrrrrd", "rrrrrrd", ".rrrrd.", "..rrd..", "...d..."], { r: "#E0475B", R: "#FFC2C9", d: "#8E1F35" }, { outline: "#1B0A10" });
    SPR.heartOff = WG.sprite([".rr.rr.", "rrrrrrr", "rrrrrrr", ".rrrrr.", "..rrr..", "...r..."], { r: "#26324F" }, { outline: "#0A0F1E" });
    SPR.hp = WG.sprite(["..r..", ".rRr.", ".rrr.", "rrrrd", "rrrdd"], { r: "#E0475B", R: "#FFC2C9", d: "#8E1F35" }, { outline: "#1B0A10" });
    SPR.hpOff = WG.sprite(["..r..", ".rrr.", ".rrr.", "rrrrr", "rrrrr"], { r: "#26324F" }, { outline: "#0A0F1E" });
    SPR.ghp = WG.sprite(["..r..", ".rRr.", ".rrr.", "rrrrd", "rrrdd"], { r: "#8B7CF6", R: "#EDE9FF", d: "#4B3BA8" }, { outline: "#0A0820" });
    SPR.glass = WG.sprite(["aaaaaaa", ".kSSSk.", ".kSSSk.", "..kSk..", "...s...", "..ksk..", ".k.s.k.", ".kssSk.", "aaaaaaa"],
      { a: "#C98A1B", k: "#C9D6F2", S: "#FFD27A", s: "#E0A84A" }, { outline: "#2A1E00" });
    SPR.bracket = WG.sprite(["k.....k", "kaaaaak", ".kAAAk.", "..kak..", "...a...", "...a...", "..aaa.."], { k: "#24170F", a: "#6B4A30", A: "#A8774D" });
    SPR.flames = [
      ["...y...", "..yo...", "..yoy..", ".yowoy.", ".owWwo.", "royWyor", ".ooroo."],
      ["....y..", "...oy..", "..yoy..", ".yowoy.", ".owWwo.", "royWyor", ".ooroo."],
      ["..y....", "..yo...", ".yooy..", ".yowoy.", "yowWwo.", "roWWyor", ".orroo."],
      ["...y...", "...oy..", "..yooy.", ".yowwy.", ".owWwoy", "royWwor", ".ooroo."],
    ].map((r) => WG.sprite(r, { y: "#FFF0C2", o: "#FFB347", w: "#FFE9A8", W: "#FFFFFF", r: "#D9572B" }));
    SPR.star = WG.sprite(["...W...", "...Y...", "yYYWYYy", ".yYYYy.", "..yYy..", ".yy.yy.", ".y...y."], { y: "#C98A1B", Y: "#FFD27A", W: "#FFF0C2" }, { outline: "#2A1E00" });
    SPR.starOff = WG.sprite(["...y...", "...y...", "yyyyyyy", ".yyyyy.", "..yyy..", ".yy.yy.", ".y...y."], { y: "#26324F" }, { outline: "#0A0F1E" });
  }

  // ======================================================================= themes and painting the level
  const THEMES = {
    dungeon: { amb: 0.56, bg: ["#121C38", "#15203F", "#192547"], bgHi: "#24325A", bgLo: "#0C1329", mortar: "#070C1B", brick: [18, 10],
      top: ["#B9C4DD", "#8592B3", "#66739A"], front: ["#4D5878", "#414B69", "#323B57"], edge: "#11172A",
      block: ["#3B4564", "#36405E", "#424D6D"], blockHi: "#66739A", blockLo: "#222A44", blockMortar: "#151B2E", out: "#0A0E1C",
      moss: ["#1FA874", "#127A52"], glow: "rgba(255,190,110,.10)", sky: { top: "#04070F", bottom: "#142449", curtain: 0.55 } },
    ramparts: { amb: 0.6, bg: ["#2E2119", "#35271D", "#3D2D21"], bgHi: "#4C3828", bgLo: "#1F160F", mortar: "#160F0A", brick: [16, 8],
      top: ["#F6DDB0", "#DDB683", "#B98D5C"], front: ["#9C6E45", "#86603C", "#6E4C2E"], edge: "#2B1B10",
      block: ["#A0744B", "#946A43", "#AC7E53"], blockHi: "#D2A877", blockLo: "#5E4028", blockMortar: "#5A3C25", out: "#24170F",
      moss: ["#8E6A3E", "#6B4A30"], glow: "rgba(255,190,110,.10)", sky: { top: "#04070F", bottom: "#1B2A55", curtain: 0.5 }, parapet: true },
    palace: { amb: 0.66, bg: ["#1B1543", "#1F184B", "#231B53"], bgHi: "#33287A", bgLo: "#110C2E", mortar: "#0D0924", brick: [16, 16],
      top: ["#F4F7FD", "#CBD6EE", "#A3B0CC"], front: ["#7F8FB8", "#6B7AA0", "#566389"], edge: "#1B2133", trim: "#C98A1B",
      block: ["#3E3184", "#382C78", "#45378F"], blockHi: "#7566CC", blockLo: "#241B52", blockMortar: "#1A1240", out: "#0E0A26",
      moss: ["#C98A1B", "#8B6A1B"], glow: "rgba(196,187,255,.10)", sky: { top: "#04070F", bottom: "#1C2452", curtain: 0.5 } },
    tower: { amb: 0.6, bg: ["#251A2C", "#2B1F33", "#31243A"], bgHi: "#40304A", bgLo: "#170F1C", mortar: "#100A14", brick: [16, 8],
      top: ["#F2D7B6", "#D4AE88", "#AE8762"], front: ["#93684A", "#7E5940", "#664631"], edge: "#2A1A12",
      block: ["#98704F", "#8C6748", "#A47B58"], blockHi: "#C9A27E", blockLo: "#5A3E2B", blockMortar: "#553A27", out: "#22160F",
      moss: ["#8B7CF6", "#4B3BA8"], glow: "rgba(255,190,110,.10)", sky: { top: "#03050C", bottom: "#17224A", curtain: 0.62 }, parapet: true },
  };
  const hash = (a, b, s) => { let h = (a * 374761393 + b * 668265263 + (s || 0) * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

  // torchlight baked into the walls: ambient darkness with warm pools around the flames and cool light under windows,
  // posterised into 8 steps with an ordered dither so it stays crisp pixel art
  const BAY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  function light(W, canvases) {
    const T = W.theme, w = W.C * TW, h = W.R * TH;
    const amb = T.amb || 0.6;
    const L = new Float32Array(w * h), warm = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) L[y * w + x] = W.outdoor(colOf(x), Math.floor(y / TH)) ? -1 : amb;
    const add = (cx, cy, R, k, isWarm) => {
      for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(h, cy + R); y++) for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(w, cx + R); x++) {
        const i = y * w + x;
        if (L[i] < 0) continue;
        const d = Math.hypot(x - cx, (y - cy) * 1.15) / R;
        if (d >= 1) continue;
        const v = k * (1 - d) * (1 - d);
        L[i] += v;
        if (isWarm) warm[i] += v;
      }
    };
    // the heart of a thick wall is darker than its faces
    const wallC = (c, r) => c < 0 || c >= W.C || r < 0 || r >= W.R || W.kind[r * W.C + c] === 2;
    for (let r = 0; r < W.R; r++) for (let c = 0; c < W.C; c++) {
      if (!wallC(c, r) || !(wallC(c - 1, r) && wallC(c + 1, r) && wallC(c, r - 1) && wallC(c, r + 1))) continue;
      for (let y = Math.max(0, r * TH - 6); y < Math.min(h, r * TH + 58); y++) for (let x = c * TW; x < c * TW + TW; x++) if (L[y * w + x] > 0) L[y * w + x] -= 0.12;
    }
    for (const tc of W.torches) if (!W.outdoor(colOf(tc.x), Math.floor((tc.y + 40) / TH))) add(tc.x, tc.y - 4, 110, 0.85, true);
    for (const wn of W.windows) add(wn.c * TW + 16, FL(wn.r) - 40, 56, 0.32, false);
    if (W.exit) add(W.exit.c * TW + 16, FL(W.exit.r) - 26, 60, 0.3, false);
    for (const cv of canvases) {
      const g = cv.getContext("2d"), img = g.getImageData(0, 0, w, h), d = img.data;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, j = i * 4;
        if (!d[j + 3] || L[i] < 0) continue;
        const q = Math.min(1.12, Math.max(0.3, Math.floor(L[i] * 8 + BAY[(y & 3) * 4 + (x & 3)]) / 8));
        const wm = Math.min(1, warm[i]);
        d[j] = Math.min(255, d[j] * q + 22 * wm); d[j + 1] = Math.min(255, d[j + 1] * q + 9 * wm); d[j + 2] = Math.min(255, d[j + 2] * q * (1 - 0.12 * wm));
      }
      g.putImageData(img, 0, 0);
    }
  }

  // a round dithered glow
  function halo(g, cx, cy, r, color, level) {
    g.fillStyle = color;
    const x0 = Math.round(cx - r), y0 = Math.round(cy - r);
    for (let y = y0; y <= y0 + 2 * r; y++) for (let x = x0; x <= x0 + 2 * r; x++) {
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d < 1 && BAY[(y & 3) * 4 + (x & 3)] < level * (1.2 - d)) g.fillRect(x, y, 1, 1);
    }
  }

  function parseLevel(idx) {
    const L = LEVELS[idx];
    const ry = L.rooms.length, rx = L.rooms[0].length;
    const C = rx * RC, R = ry * RR;
    const rows = [];
    for (let r = 0; r < R; r++) {
      let s = "";
      for (let k = 0; k < rx; k++) { const room = L.rooms[Math.floor(r / RR)][k]; s += room ? (room[r % RR] + "............").slice(0, RC) : "############"; }
      rows.push(s);
    }
    const W = { L, idx, C, R, rx, ry, rows, kind: new Uint8Array(C * R), theme: THEMES[L.theme] || THEMES.dungeon,
      loose: new Map(), spikes: [], chompers: [], gates: {}, plates: [], potions: [], sword: null, exit: null, start: { c: 1, r: R - 1 },
      guardSpawns: [], torches: [], windows: [], columns: [], rubble: [], exitPlate: false, hasSky: false };
    const outdoor = (c, r) => !!(L.outdoor && L.outdoor[Math.floor(r / RR)] && L.outdoor[Math.floor(r / RR)][Math.floor(c / RC)]);
    W.outdoor = outdoor;
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      const ch = rows[r][c];
      const kind = ch === "#" ? 2 : ".:;".includes(ch) ? 0 : 1;
      W.kind[r * C + c] = kind;
      if (outdoor(c, r)) W.hasSky = true;
      const k = r * 1000 + c;
      if (ch === "~") W.loose.set(k, { c, r, st: "rest", t: 0, y: FL(r) - 2, vy: 0, hitHero: false });
      else if (ch === "^") W.spikes.push({ c, r, ext: 0, hold: 0 });
      else if (ch === "K") W.chompers.push({ c, r, ph: (c * 0.37) % 1 * 1.7 });
      else if (ch >= "A" && ch <= "D") { (W.gates[ch] = W.gates[ch] || { cells: [], open: 0, timer: 0, target: 0, hold: L.gates && L.gates[ch] !== undefined ? L.gates[ch] : 8, moving: 0 }).cells.push({ c, r }); }
      else if ((ch >= "a" && ch <= "d") || ch === "o") { W.plates.push({ c, r, letter: ch === "o" ? "o" : ch.toUpperCase(), down: false }); if (ch === "o") W.exitPlate = true; }
      else if (ch === "h" || ch === "L") W.potions.push({ c, r, kind: ch, taken: false });
      else if (ch === "/") W.sword = { c, r, taken: false };
      else if (ch === "E") W.exit = { c, r, open: 0, opening: false };
      else if (ch === "P") W.start = { c, r };
      else if (ch === "g" || ch === "X") W.guardSpawns.push({ c, r, boss: ch === "X" });
      else if (ch === "t" || ch === ":") W.torches.push({ x: c * TW + 16, y: FL(r) - 40, ph: hash(c, r) * 6 });
      else if (ch === ";" || ch === "w") { W.windows.push({ c, r }); W.hasSky = true; }
      else if (ch === "|") W.columns.push({ c, r });
    }
    if (W.exit && !W.exitPlate && !W.guardSpawns.some((s) => s.boss)) W.exit.open = 1;
    return W;
  }

  function paintLevel(W) {
    const T = W.theme, C = W.C, R = W.R, w = C * TW, h = R * TH;
    const back = WG.canvas(w, h), g = back.getContext("2d");
    const front = WG.canvas(w, h), gf = front.getContext("2d");
    const K = (c, r) => (c < 0 || c >= C ? 2 : r < 0 ? 2 : r >= R ? 0 : W.kind[r * C + c]);
    const ch = (c, r) => (c < 0 || c >= C || r < 0 || r >= R ? "#" : W.rows[r][c]);
    const isFloor = (c, r) => K(c, r) === 1 && ch(c, r) !== "~";
    const isWall = (c, r) => K(c, r) === 2;
    const outd = W.outdoor;
    // 1. the back wall: bricks laid over the whole level so neighbouring cells join up
    const [bw, bh] = T.brick;
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      if (isWall(c, r) || outd(c, r)) continue;
      const x0 = c * TW, y0 = r * TH;
      for (let by = Math.floor(y0 / bh); by * bh < y0 + TH; by++) {
        const off = (by % 2) * (bw / 2);
        for (let bx = Math.floor((x0 - off) / bw); bx * bw + off < x0 + TW; bx++) {
          const X = bx * bw + off, Y = by * bh;
          const ax = Math.max(x0, X), ay = Math.max(y0, Y), ex = Math.min(x0 + TW, X + bw), ey = Math.min(y0 + TH, Y + bh);
          if (ex <= ax || ey <= ay) continue;
          const v = hash(bx, by, 3);
          g.fillStyle = T.bg[Math.floor(v * 3)]; g.fillRect(ax, ay, ex - ax, ey - ay);
          if (W.L.theme === "palace") {
            // tiles with a small star mosaic
            if (Y >= ay && Y < ey) { g.fillStyle = T.mortar; g.fillRect(ax, Y, ex - ax, 1); }
            if (X >= ax && X < ex) { g.fillStyle = T.mortar; g.fillRect(X, ay, 1, ey - ay); }
            const cx = X + 8, cy = Y + 8;
            if (cx >= ax && cx < ex && cy >= ay && cy < ey) {
              g.fillStyle = v > 0.5 ? "#2E2470" : "#2A2266"; g.fillRect(cx - 2, cy, 5, 1); g.fillRect(cx, cy - 2, 1, 5);
              g.fillStyle = v > 0.8 ? "#C98A1B" : "#4B3BA8"; g.fillRect(cx, cy, 1, 1);
            }
          } else {
            if (Y >= ay && Y < ey) { g.fillStyle = T.mortar; g.fillRect(ax, Y, ex - ax, 1); }
            if (X >= ax && X < ex) { g.fillStyle = T.mortar; g.fillRect(X, ay, 1, ey - ay); }
            if (Y + 1 >= ay && Y + 1 < ey) { g.fillStyle = T.bgHi; g.fillRect(Math.max(ax, X + 1), Y + 1, Math.min(ex, X + bw - 1) - Math.max(ax, X + 1), 1); }
            if (v > 0.86 && Y + 3 < ey && X + 4 < ex && X + 4 >= ax && Y + 3 >= ay) { g.fillStyle = T.bgLo; g.fillRect(X + 4, Y + 3, 3, 1); g.fillRect(X + 6, Y + 4, 2, 1); }
          }
        }
      }
      // darker towards the top of a room's ceiling and under floors: depth
      if (r % RR === 0 || isFloor(c, r - 1) || isWall(c, r - 1)) art.dither(g, x0, y0, TW, 10, null, "rgba(4,7,15,.55)", 0.5);
      if (r % RR === 0 || isFloor(c, r - 1) || isWall(c, r - 1)) art.dither(g, x0, y0 + 10, TW, 6, null, "rgba(4,7,15,.45)", 0.25);
    }
    // windows onto the night sky: cut through the back wall
    for (const wn of W.windows) {
      const x = wn.c * TW + 16, y = FL(wn.r) - 44;
      g.save(); g.globalCompositeOperation = "destination-out";
      g.fillRect(x - 6, y - 4, 12, 24); art.disc(g, x, y - 4, 6, "#000"); g.restore();
      g.fillStyle = W.L.theme === "palace" ? "#C98A1B" : T.block[0];
      for (let yy = y - 10; yy < y + 21; yy++) {
        const d = yy < y - 4 ? Math.sqrt(Math.max(0, 49 - (y - 4 - yy) * (y - 4 - yy))) : 7;
        g.fillRect(Math.round(x - d) - 1, yy, 1, 1); g.fillRect(Math.round(x + d), yy, 1, 1);
      }
      g.fillRect(x - 7, y + 20, 15, 2);
      g.fillStyle = W.L.theme === "palace" ? "#8B6A1B" : T.blockLo; g.fillRect(x - 7, y + 22, 15, 1);
      if (W.L.theme !== "palace") { g.fillStyle = "#1B2133"; g.fillRect(x - 3, y - 8, 1, 28); g.fillRect(x + 2, y - 8, 1, 28); g.fillRect(x - 6, y + 6, 12, 1); }
      else { g.fillStyle = "#C98A1B"; g.fillRect(x, y - 9, 1, 29); g.fillStyle = "#8B6A1B"; g.fillRect(x - 6, y + 4, 12, 1); }
    }
    // the outdoor parapet: a battlement behind the walkway with merlons against the sky
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      if (!outd(c, r) || !isFloor(c, r) && ch(c, r) !== "~") continue;
      const x0 = c * TW, yb = FL(r) - 1;
      g.fillStyle = darker(T.block[1], 0.62); g.fillRect(x0, yb - 20, TW, 20);
      for (let y = yb - 20; y < yb; y += 6) for (let x = x0 + ((y / 6) % 2 ? 0 : 6); x < x0 + TW; x += 12) { g.fillStyle = darker(T.block[0], 0.7); g.fillRect(x, y, 11, 5); g.fillStyle = darker(T.blockHi, 0.62); g.fillRect(x, y, 11, 1); }
      for (let x = x0; x < x0 + TW; x += 16) {
        g.fillStyle = darker(T.block[1], 0.62); g.fillRect(x + 2, yb - 30, 9, 10);
        g.fillStyle = darker(T.blockHi, 0.62); g.fillRect(x + 2, yb - 30, 9, 1); g.fillRect(x + 2, yb - 30, 1, 10);
        g.fillStyle = darker(T.blockLo, 0.8); g.fillRect(x + 10, yb - 29, 1, 9);
      }
      art.dither(g, x0, yb - 8, TW, 8, null, "rgba(10,6,4,.6)", 0.4);
    }
    // 2. torches: brackets, warm light on the wall
    for (const tc of W.torches) {
      if (outd(colOf(tc.x), Math.floor((tc.y + 40) / TH))) {
        // outdoors: a lantern on a pole
        g.fillStyle = T.out; g.fillRect(tc.x - 1, tc.y - 2, 3, 42);
        g.fillStyle = T.blockLo; g.fillRect(tc.x, tc.y - 2, 1, 42);
        continue;
      }
      g.drawImage(SPR.bracket, tc.x - 3, tc.y + 4);
    }
    // 3. stone blocks
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      if (!isWall(c, r)) continue;
      const x0 = c * TW, yTop = r * TH - 4 - 2, yBot = FL(r) + 10;
      const up = isWall(c, r - 1), dn = isWall(c, r + 1), lf = isWall(c - 1, r), rt = isWall(c + 1, r);
      const y0 = up ? r * TH - 6 : yTop, y1 = dn ? (r + 1) * TH - 6 : yBot;
      g.fillStyle = T.blockMortar; g.fillRect(x0, y0, TW, y1 - y0);
      // ashlar courses of 12 px
      for (let y = y0 - ((y0 + 6) % 12 + 12) % 12; y < y1; y += 12) {
        const row = Math.floor((y + 6) / 12);
        for (let x = x0 - ((row % 2) ? 8 : 0); x < x0 + TW; x += 16) {
          const ax = Math.max(x0, x + 1), ex = Math.min(x0 + TW, x + 16), ay = Math.max(y0, y + 1), ey = Math.min(y1, y + 12);
          if (ex <= ax || ey <= ay) continue;
          const v = hash(Math.floor(x / 16), row, 9);
          g.fillStyle = T.block[Math.floor(v * 3)]; g.fillRect(ax, ay, ex - ax, ey - ay);
          if (ay === y + 1) { g.fillStyle = T.blockHi; g.fillRect(ax, ay, ex - ax - 1, 1); }
          if (ax === x + 1) { g.fillStyle = T.blockHi; g.fillRect(ax, ay, 1, ey - ay - 1); }
          g.fillStyle = T.blockLo; if (ey === y + 12) g.fillRect(ax + 1, ey - 1, ex - ax - 1, 1);
          if (ex === x + 16) g.fillRect(ex - 1, ay + 1, 1, ey - ay - 1);
          for (let k = 0; k < 3; k++) { const px = ax + 2 + Math.floor(hash(k, Math.floor(x / 16), row) * Math.max(1, ex - ax - 4)), py = ay + 2 + Math.floor(hash(row, k, 7) * Math.max(1, ey - ay - 4)); if (px < ex - 1 && py < ey - 1) { g.fillStyle = T.blockLo; g.fillRect(px, py, 1, 1); g.fillStyle = T.block[(k + 1) % 3]; g.fillRect(px + 1, py, 1, 1); } }
          if (v > 0.9) { g.fillStyle = T.blockLo; g.fillRect(ax + 3, ay + 4, 3, 1); g.fillRect(ax + 6, ay + 5, 1, 2); g.fillRect(ax + 7, ay + 7, 2, 1); }
        }
      }
      // edges
      if (!lf) { g.fillStyle = T.out; g.fillRect(x0, y0, 1, y1 - y0); g.fillStyle = T.blockHi; g.fillRect(x0 + 1, y0, 1, y1 - y0); }
      if (!rt) { g.fillStyle = T.out; g.fillRect(x0 + TW - 1, y0, 1, y1 - y0); g.fillStyle = T.blockLo; g.fillRect(x0 + TW - 2, y0, 1, y1 - y0); art.dither(g, x0 + TW, y0 + 4, 4, y1 - y0 - 4, null, "rgba(4,7,15,.6)", 0.5); }
      if (!up) {
        g.fillStyle = T.top[1]; g.fillRect(x0, yTop, TW, 4);
        g.fillStyle = T.top[0]; g.fillRect(x0, yTop, TW, 1);
        g.fillStyle = T.top[2]; g.fillRect(x0, yTop + 3, TW, 1);
        if (T.moss && W.L.theme === "dungeon") for (let i = 0; i < TW; i++) if (hash(x0 + i, r, 5) < 0.18) { g.fillStyle = T.moss[hash(i, r) > 0.5 ? 0 : 1]; g.fillRect(x0 + i, yTop + 4, 1, 1 + Math.floor(hash(i, x0) * 2)); }
      }
      if (!dn) { g.fillStyle = T.out; g.fillRect(x0, y1 - 1, TW, 1); g.fillStyle = T.blockLo; g.fillRect(x0, y1 - 2, TW, 1); if (T.trim) { g.fillStyle = "#8B6A1B"; g.fillRect(x0, y1 - 6, TW, 3); g.fillStyle = T.trim; g.fillRect(x0, y1 - 6, TW, 1); for (let i = 2; i < TW; i += 8) { g.fillStyle = "#FFD27A"; g.fillRect(x0 + i, y1 - 5, 2, 1); } } }
    }
    // 4. floors: a top face you stand on and a front face of cut stone
    const slab = (gg, x0, r, c) => {
      const y = FL(r);
      gg.fillStyle = T.top[1]; gg.fillRect(x0, y - 2, TW, 4);
      gg.fillStyle = T.top[0]; gg.fillRect(x0, y - 2, TW, 1);
      for (let i = 0; i < TW; i += 2) if (hash(x0 + i, r, 11) < 0.3) { gg.fillStyle = T.top[2]; gg.fillRect(x0 + i, y - 1 + Math.floor(hash(i, r) * 2), 2, 1); }
      gg.fillStyle = T.top[2]; gg.fillRect(x0, y + 1, TW, 1);
      gg.fillStyle = T.front[1]; gg.fillRect(x0, y + 2, TW, 8);
      gg.fillStyle = T.front[0]; gg.fillRect(x0, y + 2, TW, 1);
      gg.fillStyle = T.front[2]; gg.fillRect(x0, y + 6, TW, 1);
      const o = (c % 2) * 8;
      for (let x = x0 + o; x < x0 + TW; x += 16) { gg.fillStyle = T.front[2]; gg.fillRect(x, y + 2, 1, 4); gg.fillRect(x + 8 < x0 + TW ? x + 8 : x, y + 7, 1, 3); }
      if (T.trim) { gg.fillStyle = T.trim; gg.fillRect(x0, y + 4, TW, 1); gg.fillStyle = "#8B6A1B"; gg.fillRect(x0, y + 5, TW, 1); }
      gg.fillStyle = T.edge; gg.fillRect(x0, y + 10, TW, 1);
    };
    W.slab = (gg, x0, r, c) => slab(gg, x0, r, c);
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      if (K(c, r) !== 1) continue;
      const cc = ch(c, r);
      if (cc === "~") continue; // drawn live: it shakes and falls
      const x0 = c * TW, y = FL(r);
      // the shadow a floor throws on the wall below it
      if (!outd(c, r) && r + 1 < R && !isWall(c, r + 1)) art.dither(g, x0, y + 11, TW, 7, null, "rgba(4,7,15,.55)", 0.5);
      slab(g, x0, r, c);
      const lf = isFloor(c - 1, r) || isWall(c - 1, r + 1) || ch(c - 1, r) === "~", rt = isFloor(c + 1, r) || isWall(c + 1, r + 1) || ch(c + 1, r) === "~";
      if (!lf) { g.clearRect(x0, y - 2, 1, 1); g.clearRect(x0, y + 10, 1, 1); g.fillStyle = T.edge; g.fillRect(x0, y - 1, 1, 11); }
      if (!rt) { g.clearRect(x0 + TW - 1, y - 2, 1, 1); g.clearRect(x0 + TW - 1, y + 10, 1, 1); g.fillStyle = T.edge; g.fillRect(x0 + TW - 1, y - 1, 1, 11); g.fillStyle = T.front[2]; g.fillRect(x0 + TW - 2, y + 2, 1, 8); }
      if (W.L.theme === "dungeon" && hash(c, r, 21) > 0.55) for (let i = 0; i < TW; i++) if (hash(x0 + i, r, 23) < 0.25) { g.fillStyle = T.moss[hash(i, c) > 0.5 ? 0 : 1]; g.fillRect(x0 + i, y + 10, 1, 1 + Math.floor(hash(i, r, 2) * 3)); }
      if (cc === "^") { g.fillStyle = T.edge; for (const sx of [5, 12, 19, 26]) g.fillRect(x0 + sx - 1, y - 1, 3, 2); }
      if (/[a-do]/.test(cc)) { g.fillStyle = T.edge; g.fillRect(x0 + 8, y - 2, 16, 3); }
      if (cc >= "A" && cc <= "D") {
        // the gate's frame: two posts and a lintel
        g.fillStyle = T.out; g.fillRect(x0 + 21, y - 60, 3, 60); g.fillRect(x0 + 29, y - 60, 3, 60); g.fillRect(x0 + 20, y - 62, 13, 3);
        g.fillStyle = T.blockHi; g.fillRect(x0 + 22, y - 59, 1, 58); g.fillRect(x0 + 30, y - 59, 1, 58); g.fillRect(x0 + 21, y - 61, 11, 1);
      }
      if (cc === "E") {
        // the exit: a stone arch with a golden keystone; the door and the night behind it are drawn live
        const cx = x0 + 16;
        const half = (yy) => (yy >= y - 41 ? 11 : Math.sqrt(Math.max(0, 121 - (y - 41 - yy) * (y - 41 - yy))));
        for (let yy = y - 58; yy < y; yy++) {
          const hw = half(yy), ow = yy >= y - 44 ? 15 : Math.sqrt(Math.max(0, 225 - (y - 44 - yy) * (y - 44 - yy)));
          if (ow <= 0) continue;
          g.fillStyle = T.out; g.fillRect(Math.round(cx - ow) - 1, yy, Math.round(ow * 2) + 2, 1);
          const band = Math.floor((yy - (y - 58)) / 6) % 2;
          g.fillStyle = band ? T.block[0] : T.block[2]; g.fillRect(Math.round(cx - ow), yy, Math.round(ow - hw), 1); g.fillRect(Math.round(cx + hw), yy, Math.round(ow - hw), 1);
          g.fillStyle = T.blockHi; g.fillRect(Math.round(cx - ow), yy, 1, 1);
          if (hw > 0) { g.fillStyle = "#04070F"; g.fillRect(Math.round(cx - hw), yy, Math.round(hw * 2), 1); }
        }
        g.fillStyle = "#2A1E00"; g.fillRect(cx - 3, y - 58, 7, 7);
        g.fillStyle = "#FFD27A"; g.fillRect(cx - 2, y - 57, 5, 5); g.fillStyle = "#FFF0C2"; g.fillRect(cx - 2, y - 57, 5, 1); g.fillStyle = "#C98A1B"; g.fillRect(cx - 2, y - 53, 5, 1);
      }
    }
    // 5. columns: the shaft is in front of whoever walks behind it
    for (const col of W.columns) {
      const x = col.c * TW + 16, y = FL(col.r);
      const pal = W.L.theme === "palace" ? ["#F4F7FD", "#CBD6EE", "#8E9CC0", "#4E5A80"] : [T.blockHi, T.block[2], T.block[0], T.blockLo];
      gf.fillStyle = T.out; gf.fillRect(x - 6, y - 58, 12, 58);
      gf.fillStyle = pal[1]; gf.fillRect(x - 5, y - 55, 10, 52);
      gf.fillStyle = pal[0]; gf.fillRect(x - 4, y - 55, 2, 52);
      gf.fillStyle = pal[2]; gf.fillRect(x + 1, y - 55, 2, 52);
      gf.fillStyle = pal[3]; gf.fillRect(x + 3, y - 55, 2, 52);
      gf.fillStyle = T.out; gf.fillRect(x - 8, y - 60, 16, 5); gf.fillRect(x - 8, y - 4, 16, 4);
      gf.fillStyle = W.L.theme === "palace" ? "#FFD27A" : pal[0]; gf.fillRect(x - 7, y - 59, 14, 2); gf.fillRect(x - 7, y - 3, 14, 2);
      gf.fillStyle = W.L.theme === "palace" ? "#C98A1B" : pal[2]; gf.fillRect(x - 7, y - 57, 14, 1); gf.fillRect(x - 7, y - 1, 14, 1);
    }
    // 6. small things: chains in the dungeon, banners in the palace and the tower
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      if (isWall(c, r) || outd(c, r) || K(c, r) === 2) continue;
      const v = hash(c, r, 31), x0 = c * TW, y0 = r * TH;
      if (W.L.theme === "dungeon" && v < 0.16 && (isWall(c, r - 1) || r % RR === 0) && !W.windows.some((w) => w.c === c && w.r === r)) {
        const len = 10 + Math.floor(v * 80);
        for (let i = 0; i < len; i += 3) { g.fillStyle = i % 6 ? "#3B4766" : "#5F6F93"; g.fillRect(x0 + 10 + (i % 6 ? 1 : 0), y0 + i, 2, 2); }
        g.fillStyle = "#6B7694"; g.fillRect(x0 + 8, y0 + len, 6, 2); g.fillRect(x0 + 8, y0 + len, 1, 4); g.fillRect(x0 + 13, y0 + len, 1, 4);
      }
      if ((W.L.theme === "palace" || W.L.theme === "tower") && v < 0.2 && !W.windows.some((w) => w.c === c && w.r === r) && !W.torches.some((t) => colOf(t.x) === c && Math.floor((t.y + 40) / TH) === r)) {
        const cols = W.L.theme === "palace" ? ["#8E1F35", "#D93644", "#FFD27A"] : ["#21194A", "#4B3BA8", "#FFD27A"];
        const bx = x0 + 9, by = y0 + 14;
        g.fillStyle = "#C98A1B"; g.fillRect(bx - 2, by - 2, 18, 2);
        g.fillStyle = cols[0]; g.fillRect(bx, by, 14, 26);
        g.fillStyle = cols[1]; g.fillRect(bx + 1, by, 12, 24);
        for (let i = 0; i < 7; i++) { g.fillStyle = cols[0]; g.fillRect(bx + i * 2, by + 26 - (i % 2) * 2, 2, 2 + (i % 2) * 2); }
        g.fillStyle = cols[2]; g.fillRect(bx + 6, by + 6, 2, 2); g.fillRect(bx + 5, by + 7, 4, 1); g.fillRect(bx + 6, by + 10, 2, 1); g.fillRect(bx + 3, by + 14, 8, 1);
      }
    }
    light(W, [back, front]);
    W.back = back; W.front = front;
    // the loose slab, painted once
    const ls = WG.canvas(TW, 14), lg = ls.getContext("2d");
    lg.translate(0, -(FL(0) - 2));
    slab(lg, 0, 0, 0);
    lg.setTransform(1, 0, 0, 1, 0, 0);
    lg.fillStyle = T.edge; lg.fillRect(0, 0, 1, 13); lg.fillRect(TW - 1, 0, 1, 13); lg.fillRect(9, 1, 1, 4); lg.fillRect(21, 6, 1, 5);
    W.looseImg = ls;
    const rb = WG.canvas(TW, 8), rg = rb.getContext("2d");
    for (let i = 0; i < 16; i++) { const x = Math.floor(hash(i, 1) * 28), yy = 3 + Math.floor(hash(i, 2) * 5); rg.fillStyle = T.out; rg.fillRect(x, yy, 4, 3); rg.fillStyle = i % 3 ? T.front[1] : T.top[1]; rg.fillRect(x, yy, 3, 2); }
    W.rubbleImg = rb;
  }

  // the far scenery for the open-air rooms
  let FAR = null;
  function farLayers() {
    if (FAR) return FAR;
    const dunes = WG.canvas(384, 70), d = dunes.getContext("2d");
    art.ridge(d, 0, 46, 384, 22, "#1A2550", 31, 70, 0.04);
    art.ridge(d, 0, 58, 384, 14, "#131C3E", 47, 70, 0.03);
    const towers = WG.canvas(384, 80), t = towers.getContext("2d");
    const rnd = WG.rng(808);
    for (let x = 4; x < 384; x += 30 + Math.floor(rnd() * 40)) {
      const w = 10 + Math.floor(rnd() * 12), hh = 24 + Math.floor(rnd() * 40);
      t.fillStyle = "#0F1630"; t.fillRect(x, 80 - hh, w, hh);
      for (let k = 0; k < w; k += 4) t.fillRect(x + k, 80 - hh - 3, 2, 3);
      if (rnd() > 0.4) { t.fillStyle = "#FFD27A"; t.fillRect(x + Math.floor(w / 2), 80 - hh + 6, 1, 2); }
      if (rnd() > 0.6) { art.disc(t, x + w / 2, 80 - hh - 4, w / 2, "#0F1630"); t.fillRect(x + w / 2, 80 - hh - 12, 1, 5); }
    }
    t.fillStyle = "#0F1630"; t.fillRect(0, 72, 384, 8);
    for (let x = 0; x < 384; x += 6) t.fillRect(x, 69, 3, 3);
    FAR = new WG.Parallax([{ img: dunes, speed: 0.12, y: 120 }, { img: towers, speed: 0.3, y: 128 }]);
    return FAR;
  }

  // ======================================================================= sound
  const SFX = WG.SFX;
  Object.assign(SFX, {
    pr_step: [{ w: "noise", f: 1800, d: 0.025, v: 0.05, hp: 1200 }],
    pr_land: [{ w: "tri", f: 130, f2: 50, d: 0.08, v: 0.32 }, { w: "noise", f: 900, d: 0.06, v: 0.1 }],
    pr_thud: [{ w: "tri", f: 110, f2: 40, d: 0.16, v: 0.45 }, { w: "noise", f: 600, f2: 200, d: 0.14, v: 0.22 }],
    pr_grab: [{ w: "p12", f: 520, d: 0.03, v: 0.1 }, { w: "noise", f: 2200, d: 0.03, v: 0.06 }],
    pr_climb: [{ w: "noise", f: 1400, d: 0.06, v: 0.06, hp: 900 }, { w: "p12", f: 400, f2: 600, t: 0.05, d: 0.08, v: 0.05 }],
    pr_draw: [{ w: "noise", f: 5000, f2: 9000, d: 0.2, v: 0.09, hp: 3500 }, { w: "p12", f: 1800, f2: 2600, d: 0.16, v: 0.05 }],
    pr_swing: [{ w: "noise", f: 900, f2: 3200, d: 0.1, v: 0.1, hp: 700 }],
    pr_clang: [{ w: "p12", f: 2350, d: 0.05, v: 0.16 }, { w: "p12", f: 3140, t: 0.01, d: 0.16, v: 0.1, sus: 0.4, r: 0.18 }, { w: "noise", f: 7000, d: 0.04, v: 0.12, hp: 5000 }],
    pr_slash: [{ w: "noise", f: 2600, f2: 600, d: 0.12, v: 0.22 }, { w: "p50", f: 300, f2: 120, d: 0.12, v: 0.16 }],
    pr_click: [{ w: "p50", f: 190, d: 0.04, v: 0.2 }, { w: "noise", f: 1500, d: 0.03, v: 0.08 }],
    pr_gate: [{ w: "noise", f: 260, d: 0.07, v: 0.1, lp: 700 }, { w: "p12", f: 90, d: 0.04, v: 0.06 }],
    pr_shake: [{ w: "noise", f: 700, d: 0.05, v: 0.08 }],
    pr_crash: [{ w: "noise", f: 1300, f2: 160, d: 0.34, v: 0.3, sus: 0.4 }, { w: "tri", f: 90, f2: 40, d: 0.2, v: 0.3 }],
    pr_spikes: [{ w: "p12", f: 3200, f2: 1600, d: 0.06, v: 0.1 }, { w: "noise", f: 5200, d: 0.05, v: 0.09, hp: 3000 }],
    pr_chomp: [{ w: "noise", f: 3400, d: 0.04, v: 0.14, hp: 1500 }, { w: "p50", f: 320, f2: 140, d: 0.05, v: 0.1 }],
    pr_gulp: [{ w: "tri", f: 300, f2: 180, d: 0.07, v: 0.25 }, { w: "tri", f: 300, f2: 170, t: 0.16, d: 0.07, v: 0.25 }, { w: "tri", f: 320, f2: 160, t: 0.32, d: 0.08, v: 0.25 }],
    pr_door: [{ w: "noise", f: 180, d: 1.4, v: 0.14, sus: 0.8, lp: 500 }, { w: "tri", f: 55, d: 1.4, v: 0.18, sus: 0.8 }],
    pr_tick: [{ w: "p12", f: 1600, d: 0.02, v: 0.07 }],
  });
  const MAIN = {
    bpm: 100,
    ch: [
      { w: "p25", v: 0.1, sus: 0.55, vib: 5, notes: [
        "A4 - - Bb4 C#5 - D5 - E5 - - - D5 C#5 Bb4 -", "A4 - - - - - . . E4 - F4 - G4 - F4 E4",
        "F4 - - G4 A4 - Bb4 - C#5 - - - Bb4 A4 G4 -", "A4 - - - - - - - . . . . E5 D5 C#5 Bb4",
        "C#5 - - D5 E5 - F5 - E5 - D5 - C#5 - Bb4 -", "A4 - - - Bb4 - A4 G4 F4 - E4 - F4 - G4 -",
        "A4 - E4 - F4 - G4 - Bb4 - A4 - G4 - F4 -", "E4 - - - - - - - . . . . . . . ."].join(" ") },
      { w: "p12", v: 0.04, sus: 0.3, notes: [
        "A3 E4 A4 C#5 A4 E4 A3 E4 A3 E4 A4 C#5 A4 E4 A3 E4", "A3 E4 A4 C#5 A4 E4 A3 E4 A3 E4 A4 C#5 A4 E4 A3 E4",
        "D4 A4 D5 F5 D5 A4 D4 A4 D4 A4 D5 F5 D5 A4 D4 A4", "E4 B4 E5 G#5 E5 B4 E4 B4 E4 B4 E5 G#5 E5 B4 E4 B4"].join(" ") },
      { w: "tri", v: 0.2, sus: 0.8, notes: [
        "A2 . . A3 . . E2 . A2 . . A3 . . E2 .", "A2 . . A3 . . E2 . A2 . . A3 . . E2 .",
        "D2 . . D3 . . A2 . D2 . . D3 . . A2 .", "E2 . . E3 . . B2 . E2 . . E3 . G#2 E2 ."].join(" ") },
      { w: "noise", v: 0.17, notes: "k . h k s . h . k . h k s h h ." },
    ],
  };
  const FIGHT = {
    bpm: 148,
    ch: [
      { w: "p50", v: 0.07, sus: 0.5, notes: "A4 . A4 Bb4 A4 . G4 . A4 . . . E5 . D5 C#5 D5 . C#5 Bb4 A4 . Bb4 . G4 . . . A4 . . ." },
      { w: "p12", v: 0.04, sus: 0.4, notes: "E5 . . . F5 . . . E5 . . . D5 . C#5 . Bb4 . . . A4 . . . Bb4 . . . C#5 . . ." },
      { w: "tri", v: 0.24, sus: 0.7, notes: "A2 A3 A2 A3 A2 A3 Bb2 Bb3 A2 A3 A2 A3 G2 G3 F2 F3 E2 E3 E2 E3 F2 F3 G2 G3 A2 A3 A2 A3 E2 E3 G#2 G#3" },
      { w: "noise", v: 0.2, notes: "k h s h k k s h k h s h k s s s" },
    ],
  };

  WG._prince = { frame, AN, COS, renderPose, sample }; // for the dev sheets (games/dev)

  // ======================================================================= the game
  const INK = ["#FFFFFF", "#FFFFFF", "#EAF0FA", "#EAF0FA", "#C9D6F2", "#C9D6F2", "#A9B6CD"];
  const GOLD = ["#FFF0C2", "#FFF0C2", "#FFD27A", "#FFD27A", "#FFD27A", "#C98A1B", "#C98A1B"];
  const clock = (sec) => { sec = Math.max(0, Math.ceil(sec)); return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0"); };

  WG.game({
    id: ID,
    portrait: false,
    controls: { dpad: true, a: "Прыжок", b: "Меч", swipe: false, landscapeDpad: true },
    howto: "Выберись из песчаной крепости, пока не пересыпались часы: прыгай через пропасти, цепляйся за уступы, обходи ловушки и бейся на мечах со стражей.",
    keysHint: "←→ — бег (коротко или с ↓ — осторожный шаг), ↑ — прыжок вверх и подтянуться, ↓ — присесть, слезть, выпить. Z/пробел — прыжок, в бою защита; X — меч и удар.",
    touchHowto: "Крестовина — бег (коротко — шаг), ↑ — вверх, ↓ — вниз и выпить. «Прыжок» — прыжок и защита в бою, «Меч» — удар.",
    titleColors: ["#FFF0C2", "#FFF0C2", "#FFD27A", "#FFD27A", "#E0A84A", "#E0A84A", "#C98A1B"],
    music: MAIN,
    create(api) {
      sprites();
      const endless = !api.stage;
      const I = api.input;
      const fx = new WG.Particles(700);
      let level = WG.store.get("level." + ID, api.level) || api.level;
      if (!LVL_KEYS.includes(level)) level = "normal";
      const baseSkill = (lv) => (lv === "adaptive" ? WG.adaptive.get(ID) : SKILL[lv]);
      const S = {
        t: 0, phase: "idle", phaseT: 0, li: endless ? 0 : api.stage - 1, W: null, cam: { x: 0, y: 0 }, camT: { x: 0, y: 0 },
        timeLeft: endless ? RUN_TIME : LEVELS[api.stage - 1].time, playMs: 0, lives: 3, livesLost: 0, levelsDone: 0,
        level, skill: baseSkill(level), adapt: 0, msgs: [], tip: null, tipsSeen: {}, fightT: 0, fighting: false, ended: false,
        lostWhy: "", introSel: LVL_KEYS.indexOf(level), checkpoint: null, roomKey: "", deathT: 0, fade: 0, endT: 0, warnT: 0, starsAtEnd: 0,
      };
      const hero = { x: 0, y: 0, px: 0, py: 0, face: 1, st: "stand", t: 0, row: 0, hp: 3, maxHp: 3, hasSword: false, armed: false,
        vx: 0, vy: 0, g: GRAV, startRow: 0, ledge: null, path: null, flip: false, stepD: 0, x0: 0, y0: 0, hitDone: false, potion: null,
        autoGrab: false, sheathT: 0, invuln: 0, blink: 0, runD: 0, lastStrike: -9, spam: 0, dead: false, deathKind: "", alpha: 1 };
      let guards = [];

      // ---------------------------------------------------------------- the world
      function loadLevel(i) {
        const W = parseLevel(i);
        paintLevel(W);
        S.W = W; S.li = i;
        guards = W.guardSpawns.map((sp, n) => makeGuard(sp, n));
        hero.x = W.start.c * TW + 16; hero.y = FL(W.start.r); hero.row = W.start.r; hero.face = 1; hero.px = hero.x; hero.py = hero.y;
        hero.st = "stand"; hero.t = 0; hero.armed = false; hero.dead = false; hero.alpha = 1;
        if (!endless) hero.hasSword = !!W.L.sword;
        if (W.sword && hero.hasSword) W.sword.taken = true;
        S.checkpoint = { x: hero.x, r: hero.row, face: 1 };
        snapCam();
        fx.clear();
      }
      function makeGuard(sp, n) {
        const tier = S.W.L.tier || 0;
        const cos = sp.boss ? "boss" : "g" + Math.min(3, tier);
        const hp = sp.boss ? 5 + (S.level === "master" ? 1 : 0) : [2, 3, 3, 4][Math.min(3, tier)];
        return { id: n, x: sp.c * TW + 16, y: FL(sp.r), px: sp.c * TW + 16, py: FL(sp.r), row: sp.r, homeRow: sp.r, home: sp.c * TW + 16, face: -1, st: "post", t: 0, hp, maxHp: hp,
          boss: sp.boss, tier, cos, alive: true, engaged: false, cd: 1.2, think: 0.4, parryAt: -1, riposte: false, feint: false, hitDone: false,
          vy: 0, lostT: 0, armed: false, deadAnim: "dead" };
      }
      function gSkill(g) {
        const s = clamp(S.skill + (S.level === "adaptive" ? S.adapt : 0), 0, 1);
        return clamp(s * (0.55 + 0.1 * g.tier) + 0.06 * g.tier + (g.boss ? 0.06 : 0), 0.04, 1);
      }
      const inMap = (c, r) => c >= 0 && c < S.W.C && r >= 0 && r < S.W.R;
      function wallAt(c, r) { const w = S.W; if (c < 0 || c >= w.C || r < 0) return true; if (r >= w.R) return false; return w.kind[r * w.C + c] === 2; }
      function floorAt(c, r) {
        const w = S.W;
        if (!inMap(c, r) || w.kind[r * w.C + c] !== 1) return false;
        const lt = w.loose.get(r * 1000 + c);
        return !(lt && (lt.st === "fall" || lt.st === "gone"));
      }
      const support = (c, r) => r >= 0 && r < S.W.R && !wallAt(c, r) && (floorAt(c, r) || (r + 1 < S.W.R && wallAt(c, r + 1)));
      const supportAt = (x, r) => support(colOf(x), r);
      const charAt = (c, r) => (inMap(c, r) ? S.W.rows[r][c] : "#");
      function gateClosedAt(c, r) {
        const ch = charAt(c, r);
        if (ch < "A" || ch > "D") return false;
        const gt = S.W.gates[ch];
        return !gt || gt.open < 0.62;
      }
      // move along a row: stopped by stone, closed gates and other fighters
      function moveX(a, dx, r, others, airborne) {
        let nx = a.x + dx;
        const half = 5;
        let blocked = false;
        const rows = airborne ? [r, Math.ceil((a.y - 38 - FLO) / TH - 1e-6)] : [r];
        for (const rr of rows) {
          if (dx > 0) { const c = colOf(nx + half); if (wallAt(c, rr)) { nx = Math.min(nx, c * TW - half - 0.01); blocked = true; } }
          if (dx < 0) { const c = colOf(nx - half); if (wallAt(c, rr)) { nx = Math.max(nx, (c + 1) * TW + half + 0.01); blocked = true; } }
        }
        for (let c = colOf(Math.min(a.x, nx)) - 1; c <= colOf(Math.max(a.x, nx)) + 1; c++) {
          if (!gateClosedAt(c, r)) continue;
          const bx = c * TW + 26;
          if (a.x <= bx && nx + half > bx) { nx = bx - half - 0.01; blocked = true; }
          else if (a.x >= bx && nx - half < bx) { nx = bx + half + 0.01; blocked = true; }
        }
        if (others) for (const o of others) {
          if (o === a || !o.alive || o.row !== r || o.dead) continue;
          const m = 15;
          if (a.x <= o.x && nx > o.x - m) { nx = Math.min(nx, Math.max(a.x, o.x - m)); blocked = true; }
          else if (a.x > o.x && nx < o.x + m) { nx = Math.max(nx, Math.min(a.x, o.x + m)); blocked = true; }
        }
        a.x = nx;
        return blocked;
      }
      const fighters = () => [hero].concat(guards);
      hero.alive = true;

      // edges for hanging: a floor whose side opens onto air
      function edgeRight(c, r) { return support(c, r) && !support(c - 1, r) && !wallAt(c - 1, r) && !wallAt(c - 1, r + 1); } // floor to the right of x=c*TW
      function edgeLeft(c, r) { return support(c, r) && !support(c + 1, r) && !wallAt(c + 1, r) && !wallAt(c + 1, r + 1); } // floor to the left of x=(c+1)*TW
      function findLedgeAbove(x, r, face) {
        const lr = r - 1;
        if (lr < 0) return null;
        let best = null;
        for (let c = colOf(x) - 2; c <= colOf(x) + 2; c++) {
          if (edgeRight(c, lr)) { const E = c * TW, hx = E - 7, d = Math.abs(hx - x) + (face < 0 ? 6 : 0); if (Math.abs(hx - x) <= 30 && !wallAt(colOf(hx), r) && (!best || d < best.d)) best = { E, r: lr, face: 1, hx, d }; }
          if (edgeLeft(c, lr)) { const E = (c + 1) * TW, hx = E + 7, d = Math.abs(hx - x) + (face > 0 ? 6 : 0); if (Math.abs(hx - x) <= 30 && !wallAt(colOf(hx), r) && (!best || d < best.d)) best = { E, r: lr, face: -1, hx, d }; }
        }
        return best;
      }
      function findDropEdge(x, r) {
        const c = colOf(x);
        let best = null;
        for (let cc = c - 1; cc <= c + 1; cc++) {
          // drop on the right of cell cc: the hero ends facing left, hanging at E + 7
          if (edgeLeft(cc, r)) { const E = (cc + 1) * TW; if (x <= E && x >= E - 22 && (!best || Math.abs(E - x) < best.d)) best = { E, r, face: -1, hx: E + 7, d: Math.abs(E - x) }; }
          if (edgeRight(cc, r)) { const E = cc * TW; if (x >= E && x <= E + 22 && (!best || Math.abs(E - x) < best.d)) best = { E, r, face: 1, hx: E - 7, d: Math.abs(E - x) }; }
        }
        return best;
      }
      function grabWhileFalling(a, yPrev) {
        // hands at y - HANG cross a floor line beside a ledge in front
        for (let r = 0; r < S.W.R; r++) {
          const ly = FL(r);
          if (!(yPrev - HANG <= ly + 6 && a.y - HANG >= ly - 2)) continue;
          if (a.face > 0) { const c = colOf(a.x + 12); if (edgeRight(c, r) && Math.abs((c * TW - 7) - a.x) <= 13) return { E: c * TW, r, face: 1, hx: c * TW - 7 }; }
          else { const c = colOf(a.x - 12); if (edgeLeft(c, r) && Math.abs(((c + 1) * TW + 7) - a.x) <= 13) return { E: (c + 1) * TW, r, face: -1, hx: (c + 1) * TW + 7 }; }
        }
        return null;
      }
      function landingRow(x, yPrev, y) {
        for (let r = Math.max(0, Math.ceil((yPrev - FLO) / TH - 1e-6)); r < S.W.R && FL(r) <= y + 0.01; r++) {
          if (FL(r) <= yPrev + 0.01) continue;
          for (const dx of [0, 4, -4]) if (supportAt(x + dx, r)) return { r, dx };
        }
        return null;
      }

      // ---------------------------------------------------------------- camera
      function roomOf(x, y) { return { rx: clamp(Math.floor(x / RW), 0, S.W.rx - 1), ry: clamp(Math.floor(y / RH), 0, S.W.ry - 1) }; }
      function heroFocusY() {
        if (hero.st === "hang" || hero.st === "climbUp" || hero.st === "climbDown" || (hero.st === "jumpUp" && hero.ledge)) return FL(hero.ledge ? hero.ledge.r : hero.row) - 20;
        return hero.y - 22;
      }
      function camTarget() { const r = roomOf(hero.x, heroFocusY()); return { x: r.rx * RW, y: r.ry * RH, rx: r.rx, ry: r.ry }; }
      function snapCam() { const t = camTarget(); S.cam.x = t.x; S.cam.y = t.y; }

      // ---------------------------------------------------------------- messages and tips
      function say(text, color, dur, big) { S.msgs = S.msgs.filter((m) => m.text !== text); S.msgs.push({ text, color: color || GOLD, t: 0, dur: dur || 1.6, big: big !== false }); }
      function tip(id, text) { if (S.tipsSeen[id]) return; S.tipsSeen[id] = true; S.tip = { text, t: 0 }; }

      // ---------------------------------------------------------------- hero states
      function setSt(a, st) { a.st = st; a.t = 0; a.hitDone = false; }
      function startFall(a, vx) { setSt(a, "fall"); a.vx = vx || 0; a.vy = Math.max(a.vy || 0, 0); a.g = GRAV; a.autoGrab = false; if (a === hero) a.startRow = a.row; }
      const grounded = (st) => !["fall", "jumpAir", "leap", "hang", "climbUp", "climbDown", "dead", "abyss"].includes(st) && !(st === "jumpUp" && hero.ledge && hero.t > 0.12);
      const fightSt = (st) => ["guard", "advance", "retreat", "strike", "parry", "recoil", "hit", "gturn", "draw", "sheathe"].includes(st);
      const dirH = () => (I.held("left") && !I.held("right") ? -1 : I.held("right") && !I.held("left") ? 1 : 0);
      function nearGuard(maxD, sameFace) {
        let best = null;
        for (const g of guards) {
          if (!g.alive || g.row !== hero.row || g.st === "fall") continue;
          const d = Math.abs(g.x - hero.x);
          if (d > maxD) continue;
          if (sameFace && Math.sign(g.x - hero.x) !== hero.face) continue;
          if (!best || d < Math.abs(best.x - hero.x)) best = g;
        }
        return best;
      }
      function potionHere() { return S.W.potions.find((p) => !p.taken && p.r === hero.row && Math.abs(p.c * TW + 16 - hero.x) < 12); }
      function heroHurt(n, kind) {
        if (hero.dead) return;
        hero.hp -= n;
        api.flash("#FF6B7A", 0.15);
        api.shake(3, 0.25);
        if (S.level === "adaptive") S.adapt = clamp(S.adapt - 0.04, -0.3, 0.3);
        if (hero.hp <= 0) { heroDie(kind || "sword"); return true; }
        return false;
      }
      function heroDie(kind) {
        if (hero.dead) return;
        hero.dead = true; hero.hp = 0;
        hero.deathKind = kind; S.lastDeath = kind;
        S.deathT = 0;
        api.sfx(kind === "abyss" ? "whoosh" : "die");
        api.shake(kind === "fall" ? 5 : 3, 0.35);
        if (kind !== "abyss") api.flash("#FF6B7A", 0.2);
        if (kind === "spikes") setSt(hero, "spiked");
        else if (kind === "fall") setSt(hero, "splat");
        else if (kind === "abyss") setSt(hero, "abyss");
        else if (kind === "chomp") { setSt(hero, "die"); fx.emit({ x: hero.x, y: hero.y - 24, n: 20, colors: ["#FFFFFF", "#DCE6F5", "#FF6B7A"], speed: [20, 80], life: [0.3, 0.6], drag: 3, shape: "spark" }); }
        else setSt(hero, "die");
        if (S.level === "adaptive") S.adapt = clamp(S.adapt - 0.1, -0.3, 0.3);
      }
      function afterDeath() {
        S.lives--; S.livesLost++;
        if (S.lives <= 0) { fail("lives"); return; }
        // back to the last safe place, healed; floors that fell are back in place (they may be the only way on)
        for (const lt of S.W.loose.values()) if (lt.st !== "rest") { lt.st = "rest"; lt.t = 0; lt.y = FL(lt.r) - 2; lt.vy = 0; lt.hitHero = false; }
        S.W.rubble.length = 0;
        const cp = S.checkpoint;
        hero.x = cp.x; hero.y = FL(cp.r); hero.row = cp.r; hero.face = cp.face; hero.px = hero.x; hero.py = hero.y;
        hero.hp = hero.maxHp; hero.dead = false; hero.armed = false; hero.vx = hero.vy = 0; hero.invuln = 1.2; hero.alpha = 1;
        setSt(hero, "stand");
        for (const g of guards) if (g.alive) { if (g.row === g.homeRow) g.x = g.home; g.st = "post"; g.t = 0; g.engaged = false; g.armed = false; g.parryAt = -1; g.riposte = false; }
        snapCam();
        S.fade = 0.6;
        say(S.lives === 1 ? "ПОСЛЕДНЯЯ ЖИЗНЬ" : "ЕЩЁ РАЗ", S.lives === 1 ? ["#FFC2C9", "#FFC2C9", "#FF8F8F", "#FF8F8F", "#FF6B7A", "#D93644", "#D93644"] : INK, 1.4);
      }
      function heroLanded(lr, dx) {
        hero.x += dx;
        hero.y = FL(lr); hero.row = lr; hero.vy = 0;
        const rows = lr - hero.startRow;
        // spikes kill whoever lands on them
        if (spikeUnder(hero.x, lr)) { spikeAt(hero.x, lr).ext = 1; api.sfx("pr_spikes"); heroDie("spikes"); return; }
        if (rows >= 3) { api.sfx("pr_thud"); heroDie("fall"); return; }
        if (rows === 2) {
          api.sfx("pr_thud"); setSt(hero, "landHard");
          fx.emit({ x: hero.x, y: hero.y, n: 14, colors: ["#A9B6CD", "#6B7694", "#EAF0FA"], speed: [15, 50], angle: [Math.PI * 1.05, Math.PI * 1.95], life: [0.3, 0.6], gravity: 120, drag: 2 });
          heroHurt(1, "fall");
          if (!hero.dead) say("ОХ!", ["#FFC2C9", "#FFC2C9", "#FF8F8F", "#FF8F8F", "#FF6B7A", "#D93644", "#D93644"], 0.8);
          return;
        }
        api.sfx("pr_land");
        fx.emit({ x: hero.x, y: hero.y, n: 7, colors: ["#A9B6CD", "#6B7694"], speed: [10, 35], angle: [Math.PI * 1.05, Math.PI * 1.95], life: [0.2, 0.45], gravity: 80, drag: 2 });
        setSt(hero, "land");
        jolt(lr, hero.x);
      }
      function spikeAt(x, r) { const c = colOf(x); return S.W.spikes.find((s) => s.c === c && s.r === r); }
      function spikeUnder(x, r) { const s = spikeAt(x, r); if (!s) return false; const lx = x - s.c * TW; return lx > 3 && lx < 29; }
      function jolt(r, x) { for (const lt of S.W.loose.values()) if (lt.r === r && lt.st === "rest" && Math.abs(lt.c * TW + 16 - x) < 48) { lt.st = "shake"; lt.t = 0.2; } }

      function heroUpdate(dt) {
        const h = hero;
        h.px = h.x; h.py = h.y;
        h.t += dt;
        if (h.invuln > 0) h.invuln -= dt;
        const d = dirH();
        const ah = I.pressed("a"), up = I.pressed("up"), dn = I.held("down"), bp = I.pressed("b");
        const others = guards;
        const toStand = () => setSt(h, "stand");
        const tryFight = () => {
          const g = nearGuard(86);
          if (g && g.engaged && h.hasSword && S.t - h.sheathT > 1.2) { h.face = Math.sign(g.x - h.x) || h.face; setSt(h, "draw"); return true; }
          return false;
        };
        const groundCheck = () => { if (!supportAt(h.x, h.row)) { startFall(h, h.st === "run" || h.st === "runStop" || h.st === "runStart" ? h.face * RUN * 0.55 : h.st === "step" ? h.face * 10 : 0); return true; } return false; };
        switch (h.st) {
          case "stand": {
            if (groundCheck() || tryFight()) break;
            if (bp && h.hasSword) { setSt(h, "draw"); break; }
            if (up && exitHere()) { enterExit(); break; }
            if (ah || up) {
              if (d === h.face && d !== 0) { setSt(h, "jumpPrep"); break; }
              startJumpUp(); break;
            }
            if (I.pressed("down") || (dn && h.t > 0.05)) {
              const pot = potionHere();
              if (pot) { h.potion = pot; setSt(h, "drink"); break; }
              const e = d === 0 && findDropEdge(h.x, h.row);
              if (e) { startClimbDown(e); break; }
              if (d === 0) { setSt(h, "crouchDown"); break; }
            }
            if (d !== 0) {
              if (d !== h.face) { setSt(h, "turn"); h.flip = false; break; }
              if (dn) { startStep(); break; }
              setSt(h, "runStart"); h.runD = 0; break;
            }
            break;
          }
          case "turn":
            if (h.t >= 0.09 && !h.flip) { h.face = -h.face; h.flip = true; }
            if (h.t >= 0.18) toStand();
            break;
          case "runStart": {
            const v = RUN * sstep(h.t / 0.24);
            const x0 = h.x;
            if (moveX(h, h.face * v * dt, h.row, others)) { setSt(h, "bump"); api.sfx("bounce"); break; }
            h.runD += Math.abs(h.x - x0);
            if (groundCheck()) break;
            if (d !== h.face) {
              if (h.t < 0.13) { startStep(Math.max(0, 12 - h.runD)); break; }
              setSt(h, "runStop"); break;
            }
            if ((ah || up) && h.t > 0.1) { startLeap(); break; }
            if (h.t >= 0.24) { setSt(h, "run"); }
            break;
          }
          case "run": {
            const x0 = h.x;
            if (moveX(h, h.face * RUN * dt, h.row, others)) { setSt(h, "bump"); api.sfx("bounce"); api.shake(1, 0.1); break; }
            h.runD += Math.abs(h.x - x0);
            if (Math.floor(h.runD / 33) !== Math.floor((h.runD - Math.abs(h.x - x0)) / 33)) api.sfx("pr_step");
            if (groundCheck()) break;
            if (tryFight()) break;
            if (ah || up) { startLeap(); break; }
            if (d === -h.face) { setSt(h, "runStop"); h.turnAfter = true; break; }
            if (d === 0 || dn) { setSt(h, "runStop"); h.turnAfter = false; break; }
            break;
          }
          case "runStop": {
            const v = RUN * Math.max(0, 1 - h.t / 0.26);
            if (moveX(h, h.face * v * dt, h.row, others)) { toStand(); break; }
            if (groundCheck()) break;
            if ((ah || up) && v > 55) { startLeap(); break; }
            if (h.t >= 0.26) { if (h.turnAfter && d === -h.face) { setSt(h, "turn"); h.flip = false; } else toStand(); h.turnAfter = false; }
            break;
          }
          case "step": {
            const k = sstep(h.t / 0.42);
            const target = h.x0 + h.face * h.stepD * k;
            moveX(h, target - h.x, h.row, others);
            if (h.t >= 0.42) { toStand(); groundCheck(); }
            break;
          }
          case "teeter": if (h.t >= 0.42) toStand(); break;
          case "jumpPrep":
            if (h.t >= 0.16) {
              setSt(h, "jumpAir"); h.vx = h.face * 132; h.vy = -150; h.g = 680; h.startRow = h.row; h.autoGrab = true; api.sfx("jump");
              jolt(h.row, h.x);
            }
            break;
          case "jumpAir": case "leap": case "fall": {
            const yPrev = h.y;
            h.vy = Math.min(h.vy + h.g * dt, 520);
            if (h.st === "fall") h.vx *= Math.pow(0.35, dt);
            const r = Math.ceil((h.y - FLO) / TH - 1e-6);
            if (moveX(h, h.vx * dt, r, null, true)) { h.vx = 0; if (h.st !== "fall") { const sr = h.startRow; startFall(h, 0); h.startRow = sr; api.sfx("bounce"); } }
            h.y += h.vy * dt;
            if (h.st !== "fall" && h.vy > 0 && h.y > FL(h.startRow) + 8) { const sr = h.startRow; startFall(h, h.vx * 0.6); h.startRow = sr; h.autoGrab = true; }
            if (h.vy > 0) {
              const lr = landingRow(h.x, yPrev, h.y);
              if (lr) { heroLanded(lr.r, lr.dx); break; }
              if (h.autoGrab || I.held("a") || I.held("up")) {
                const e = grabWhileFalling(h, yPrev);
                if (e) { grab(e); break; }
              }
            }
            if (h.y > S.W.R * TH + 40) heroDie("abyss");
            break;
          }
          case "land": if (h.t >= 0.24) { toStand(); groundCheck(); } break;
          case "landHard": if (h.t >= 0.7) toStand(); break;
          case "bump": if (h.t >= 0.3) toStand(); break;
          case "jumpUp": {
            const e = h.ledge;
            if (e) {
              if (h.t > 0.12) { const k = sstep((h.t - 0.12) / 0.12); h.x = lerp(h.x0, e.hx, k); h.y = lerp(h.y0, FL(e.r) + HANG, k); }
              if (h.t >= 0.24) { grab(e); }
            } else {
              const k = clamp((h.t - 0.12) / 0.26, 0, 1);
              h.y = h.y0 - Math.sin(k * Math.PI) * (floorAt(colOf(h.x), h.row - 1) ? 5 : 11);
              if (h.t >= 0.5) { h.y = h.y0; toStand(); }
            }
            break;
          }
          case "hang": {
            const e = h.ledge;
            const lt = S.W.loose.get(e.r * 1000 + (h.face > 0 ? colOf(e.E + 2) : colOf(e.E - 2)));
            if (lt && lt.st === "rest") { lt.st = "shake"; lt.t = 0; }
            if (!support(h.face > 0 ? colOf(e.E + 2) : colOf(e.E - 2), e.r)) { letGo(); break; }
            if ((I.held("up") || I.held("a")) && h.t > 0.16) { startClimbUp(); break; }
            if (I.pressed("down") && h.t > 0.12) { letGo(); break; }
            break;
          }
          case "climbUp": case "climbDown": {
            const dur = h.st === "climbUp" ? 1.0 : 0.85;
            let k = clamp(h.t / dur, 0, 1);
            if (h.st === "climbDown") k = 1 - k;
            const e = h.ledge;
            const P0 = [[0, 0, 0], [0.22, 0, -12], [0.45, 3, -30], [0.65, 8, -44], [0.82, 13, -48], [1, 17, -48]];
            let px = 0, py = 0;
            for (let i = 1; i < P0.length; i++) if (k <= P0[i][0]) { const a = P0[i - 1], b = P0[i], q = sstep((k - a[0]) / (b[0] - a[0])); px = a[1] + (b[1] - a[1]) * q; py = a[2] + (b[2] - a[2]) * q; break; }
            h.x = e.hx + h.face * px; h.y = FL(e.r) + HANG + py;
            if (h.st === "climbUp" && Math.abs(h.t - 0.45) < dt) api.sfx("pr_climb");
            if (h.t >= dur) {
              if (h.st === "climbUp") { h.row = e.r; h.y = FL(e.r); h.x = e.hx + h.face * 17; toStand(); jolt(h.row, h.x); }
              else { setSt(h, "hang"); h.y = FL(e.r) + HANG; h.x = e.hx; }
            }
            break;
          }
          case "crouchDown": if (h.t >= 0.16) setSt(h, "crouch"); break;
          case "crouch": {
            if (I.pressed("down")) { const pot = potionHere(); if (pot) { h.potion = pot; setSt(h, "drink"); break; } }
            if (!dn) setSt(h, "crouchUp");
            break;
          }
          case "crouchUp": if (h.t >= 0.2) toStand(); break;
          case "drink": {
            if (h.t >= 0.7 && !h.hitDone && h.potion) { h.hitDone = true; drinkPotion(h.potion); }
            if (h.t >= 1.3) { toStand(); h.potion = null; }
            break;
          }
          case "pick":
            if (h.t >= 0.42 && !h.hitDone) {
              h.hitDone = true; h.hasSword = true; if (S.W.sword) S.W.sword.taken = true;
              api.sfx("pr_draw"); api.sfx("bonus"); api.flash("#FFF0C2", 0.15);
              fx.emit({ x: h.x + h.face * 6, y: h.y - 40, n: 26, colors: ["#FFFFFF", "#FFF0C2", "#D2FAFF"], speed: [20, 70], life: [0.4, 0.9], drag: 2, shape: "star" });
              say("МЕЧ!", GOLD, 1.4);
            }
            if (h.t >= 1.1) { toStand(); tip("sword", "«МЕЧ» — достать меч и ударить, «ПРЫЖОК» в бою — защита"); }
            break;
          case "draw":
            if (h.t >= 0.12 && !h.armed) { h.armed = true; api.sfx("pr_draw"); }
            if (h.t >= 0.32) { setSt(h, "guard"); h.idleT = 0; }
            break;
          case "sheathe":
            if (h.t >= 0.18 && h.armed) { h.armed = false; api.sfx("pr_grab"); }
            if (h.t >= 0.32) { toStand(); h.sheathT = S.t; }
            break;
          case "guard": case "advance": case "retreat": case "gturn": case "strike": case "parry": case "recoil": case "hit":
            fightUpdate(h, dt, d);
            break;
          case "hitU": if (h.t >= 0.3) toStand(); break;
          case "exit": {
            const ex = S.W.exit, cx = ex.c * TW + 16;
            h.x += clamp(cx - h.x, -30 * dt, 30 * dt);
            h.alpha = clamp(1 - (h.t - 0.3) / 0.8, 0, 1);
            if (h.t >= 1.2 && S.phase === "play") levelCleared();
            break;
          }
          case "die": case "splat": case "spiked": case "abyss": break;
        }
        // grounded housekeeping: checkpoints, pick-ups, traps, plates
        if (!h.dead && grounded(h.st)) {
          if (h.st === "stand" || h.st === "run") {
            const rk = roomOf(h.x, h.y - 22);
            const key = rk.rx + "," + rk.ry;
            const safe = !S.W.loose.has(h.row * 1000 + colOf(h.x)) && !spikeAt(h.x, h.row) && !S.W.plates.some((p) => p.c === colOf(h.x) && p.r === h.row);
            if (key !== S.roomKey && safe) { S.roomKey = key; S.checkpoint = { x: h.x, r: h.row, face: h.face }; }
          }
          const sw = S.W.sword;
          if (sw && !sw.taken && !h.hasSword && sw.r === h.row && Math.abs(sw.c * TW + 16 - h.x) < 10 && ["stand", "run", "runStop", "step", "runStart"].includes(h.st)) { setSt(h, "pick"); }
          const lt = S.W.loose.get(h.row * 1000 + colOf(h.x));
          if (lt && lt.st === "rest") { lt.st = "shake"; lt.t = 0; api.sfx("pr_shake"); tip("loose", "Плита шатается — не стой на ней!"); }
          if (["run", "runStart", "runStop"].includes(h.st) && spikeUnder(h.x, h.row) && spikeAt(h.x, h.row).ext > 0.35) { api.sfx("pr_spikes"); heroDie("spikes"); }
        }
        if (!h.dead && h.y > S.W.R * TH + 40) heroDie("abyss");
      }
      function startStep(dist) {
        const h = hero;
        let D = dist === undefined ? 13 : dist;
        // stop at the edge: find how far the floor goes on
        let room = 0;
        for (let x = h.x; room < D + 1; room++) { x = h.x + h.face * (room + 1); if (!supportAt(x + h.face * 2, h.row)) break; }
        D = Math.min(D, room);
        if (D < 1.5) { setSt(h, "teeter"); tip("edge", "Край! «↓» — слезть и повиснуть, «Прыжок» — перепрыгнуть"); return; }
        setSt(h, "step"); h.stepD = D; h.x0 = h.x; api.sfx("pr_step");
      }
      function startJumpUp() {
        const h = hero;
        setSt(h, "jumpUp");
        h.x0 = h.x; h.y0 = h.y;
        const e = findLedgeAbove(h.x, h.row, h.face);
        h.ledge = e;
        if (e) h.face = e.face;
        api.sfx("jump");
      }
      function startLeap() {
        const h = hero;
        setSt(h, "leap"); h.vx = h.face * 186; h.vy = -168; h.g = 660; h.startRow = h.row; h.autoGrab = true;
        api.sfx("jump");
        fx.emit({ x: h.x, y: h.y, n: 5, colors: ["#A9B6CD"], speed: [10, 30], angle: [Math.PI * 1.1, Math.PI * 1.9], life: [0.2, 0.4], drag: 3 });
        jolt(h.row, h.x);
      }
      function grab(e) {
        const h = hero;
        setSt(h, "hang"); h.ledge = e; h.face = e.face; h.x = e.hx; h.y = FL(e.r) + HANG; h.vx = 0; h.vy = 0; h.row = e.r;
        api.sfx("pr_grab");
        tip("hang", "«↑» — подтянуться, «↓» — отпустить");
      }
      function letGo() {
        const h = hero;
        const lr = h.ledge.r;
        h.row = lr;
        startFall(h, 0);
        h.startRow = lr;
        h.x = h.ledge.hx - h.face * 2;
        h.autoGrab = false;
      }
      function startClimbUp() { const h = hero; setSt(h, "climbUp"); }
      function startClimbDown(e) {
        const h = hero;
        h.face = e.face; h.ledge = e; h.x = e.hx + h.face * 17; setSt(h, "climbDown");
        api.sfx("pr_climb");
      }
      function drinkPotion(p) {
        p.taken = true;
        api.sfx("pr_gulp");
        if (p.kind === "h") {
          hero.hp = Math.min(hero.maxHp, hero.hp + 1);
          setTimeout(() => api.sfx("powerup"), 300);
          api.flash("#FF8A97", 0.2);
          fx.emit({ x: hero.x, y: hero.y - 26, n: 24, colors: ["#FF8A97", "#FFC2C9", "#FFFFFF"], speed: [10, 50], angle: [-Math.PI, 0], life: [0.5, 1.0], drag: 2, shape: "star" });
          say("ЗДОРОВЬЕ +1", ["#FFE1E5", "#FFE1E5", "#FF8A97", "#FF8A97", "#E0475B", "#E0475B", "#8E1F35"], 1.3);
        } else {
          S.lives = Math.min(5, S.lives + 1);
          hero.hp = hero.maxHp;
          setTimeout(() => api.sfx("bonus"), 300);
          api.flash("#7FE6F4", 0.25);
          fx.emit({ x: hero.x, y: hero.y - 26, n: 40, colors: ["#D2FAFF", "#7FE6F4", "#22B8CF", "#FFFFFF"], speed: [15, 70], life: [0.6, 1.2], drag: 2, shape: "star" });
          say("+1 ЖИЗНЬ", ["#FFFFFF", "#FFFFFF", "#D2FAFF", "#D2FAFF", "#7FE6F4", "#22B8CF", "#22B8CF"], 1.6);
        }
      }
      function exitHere() { const ex = S.W.exit; return ex && ex.open >= 1 && ex.r === hero.row && Math.abs(ex.c * TW + 16 - hero.x) < 14; }
      function enterExit() { setSt(hero, "exit"); hero.armed = false; api.sfx("whoosh"); }

      // ---------------------------------------------------------------- sword fights (hero and guards alike)
      function windOf(a) { return a === hero ? 0.14 : lerp(0.48, 0.24, gSkill(a)); }
      function recOf(a) { return a === hero ? 0.3 : lerp(0.42, 0.2, gSkill(a)); }
      function startStrike(a) {
        setSt(a, "strike"); a.wind = windOf(a); a.rec = recOf(a);
        if (a !== hero) fx.emit({ x: a.x - a.face * 3, y: a.y - 60, n: 3, colors: ["#FFFFFF", "#FFF0C2"], speed: [4, 14], life: [0.15, 0.3], shape: "star" });
        if (a === hero) {
          hero.spam = (S.t - hero.lastStrike < 1.2 ? hero.spam + 1 : 0); hero.lastStrike = S.t;
          for (const g of guards) if (g.alive && g.engaged && g.row === hero.row && Math.abs(g.x - hero.x) < 70 && ["guard", "advance", "retreat"].includes(g.st)) {
            const s = gSkill(g);
            const p = clamp(lerp(0.08, 0.86, s) + Math.min(3, hero.spam) * 0.06 * s, 0, 0.94);
            if (Math.random() < p) g.parryAt = lerp(0.12, 0.04, s);
          }
        }
      }
      function opponentOf(a) {
        if (a !== hero) return hero;
        let best = null;
        for (const g of guards) if (g.alive && g.row === hero.row && g.st !== "fall" && Math.sign(g.x - hero.x) === hero.face) { const d = Math.abs(g.x - hero.x); if (!best || d < Math.abs(best.x - hero.x)) best = g; }
        return best;
      }
      function resolveStrike(a) {
        const o = opponentOf(a);
        api.sfx("pr_swing");
        if (!o || o.dead || (o !== hero && !o.alive)) { a.whiff = true; return; }
        const dist = Math.abs(o.x - a.x);
        if ((o === hero && !grounded(hero.st)) || Math.sign(o.x - a.x) !== a.face || dist > REACH + (a.boss ? 3 : 0) || dist < 6) { a.whiff = true; if (a === hero) guardsSeeWhiff(); return; }
        const facing = Math.sign(a.x - o.x) === o.face;
        if (o.st === "parry" && o.t < 0.3 && facing && (o === hero ? true : true)) {
          api.sfx("pr_clang"); api.shake(1.5, 0.12);
          const mx = (a.x + o.x) / 2, my = a.y - 30;
          fx.emit({ x: mx, y: my, n: 18, colors: ["#FFFFFF", "#FFF0C2", "#FFD27A"], speed: [30, 110], life: [0.15, 0.4], drag: 4, shape: "spark" });
          setSt(a, "recoil");
          if (o !== hero) { const s = gSkill(o); o.riposte = Math.random() < lerp(0.08, 0.9, s); o.think = 0; o.cd = Math.min(o.cd, 0.2); }
          else if (a !== hero) a.cd = Math.max(a.cd, 0.6);
          return;
        }
        // a hit
        api.sfx("pr_slash");
        fx.emit({ x: o.x - a.face * 2, y: o.y - 28, n: 12, colors: ["#FFFFFF", "#FFC2C9", "#FF6B7A"], speed: [20, 70], angle: a.face > 0 ? [-0.8, 0.8] : [Math.PI - 0.8, Math.PI + 0.8], life: [0.15, 0.4], drag: 3, shape: "spark" });
        if (o === hero) {
          if (hero.invuln > 0) return;
          const died = heroHurt(1, "sword");
          if (!died) { setSt(hero, hero.armed ? "hit" : "hitU"); knock(hero, a.face * 6); }
        } else {
          o.hp--;
          api.shake(2, 0.15);
          if (S.level === "adaptive") S.adapt = clamp(S.adapt + 0.03, -0.3, 0.3);
          if (o.hp <= 0) { guardDie(o); }
          else { setSt(o, "hit"); knock(o, a.face * 6); if (gSkill(o) > 0.6 && Math.random() < 0.5) o.retreatNext = true; }
        }
      }
      function guardsSeeWhiff() {
        for (const g of guards) if (g.alive && g.engaged && g.row === hero.row && Math.abs(g.x - hero.x) < 70) {
          const s = gSkill(g);
          if (s >= 0.5 && Math.random() < s) { g.riposte = true; g.think = 0; }
        }
      }
      function knock(a, dx) {
        moveX(a, dx, a.row, fighters());
        if (!supportAt(a.x, a.row)) {
          if (a === hero) { startFall(hero, dx * 4); }
          else { setSt(a, "fall"); a.vy = 0; a.startRow = a.row; a.vx = dx * 4; }
        }
      }
      function guardDie(g) {
        g.alive = false; setSt(g, "die"); g.engaged = false;
        api.sfx("hurt");
        api.sfx("pr_thud");
        if (g.boss) {
          say("КОМЕНДАНТ ПОВЕРЖЕН!", GOLD, 2.2);
          const ex = S.W.exit;
          if (ex && !ex.open) { ex.opening = true; api.sfx("pr_door"); setTimeout(() => say("ВЫХОД ОТКРЫТ!", GOLD, 1.8), 1300); }
        }
      }
      // shared by hero and guards while their swords are out
      function fightUpdate(a, dt, d) {
        const isHero = a === hero;
        const o = isHero ? nearGuard(140) : hero;
        switch (a.st) {
          case "guard": {
            if (isHero) {
              a.idleT = (a.idleT || 0) + dt;
              if (!supportAt(a.x, a.row)) { startFall(a, 0); a.armed = false; return; }
              if (o && Math.sign(o.x - a.x) !== a.face && Math.abs(o.x - a.x) > 4) { setSt(a, "gturn"); return; }
              if (I.pressed("b")) { startStrike(a); a.idleT = 0; return; }
              if (I.pressed("a") || I.pressed("up")) { setSt(a, "parry"); a.idleT = 0; return; }
              if (I.pressed("down") || (!o && (a.idleT > 0.8 || d !== 0))) { setSt(a, "sheathe"); return; }
              if (d === a.face) { setSt(a, "advance"); a.x0 = a.x; a.idleT = 0; return; }
              if (d === -a.face) { setSt(a, "retreat"); a.x0 = a.x; a.idleT = 0; return; }
            }
            break;
          }
          case "gturn": if (a.t >= 0.09 && !a.flip2) { a.face = -a.face; a.flip2 = true; } if (a.t >= 0.18) { a.flip2 = false; setSt(a, "guard"); } break;
          case "advance": case "retreat": {
            const dir = a.st === "advance" ? a.face : -a.face;
            const want = a.x0 + dir * 10 * sstep(a.t / 0.3);
            const nx = want;
            if (supportAt(nx + dir * 3, a.row)) moveX(a, nx - a.x, a.row, fighters());
            if (a.t >= 0.3) setSt(a, "guard");
            break;
          }
          case "strike": {
            if (!isHero && a.feint && a.t >= a.wind * 0.6) { a.feint = false; setSt(a, "guard"); a.think = 0.16; a.cd = 0; a.riposte = true; return; }
            if (a.t >= a.wind && !a.hitDone) { a.hitDone = true; resolveStrike(a); if (a.st !== "strike") return; }
            if (a.t >= a.wind + a.rec) setSt(a, "guard");
            break;
          }
          case "parry": if (a.t >= 0.3) setSt(a, "guard"); break;
          case "recoil": if (a.t >= (isHero ? 0.2 : 0.34)) setSt(a, "guard"); break;
          case "hit": if (a.t >= 0.3) setSt(a, "guard"); break;
        }
      }
      // the strike animation is retimed to the fighter's own wind-up and recovery
      function strikeAnimT(a) {
        if (a.t < a.wind) return (a.t / a.wind) * 0.14;
        return 0.14 + Math.min(1, (a.t - a.wind) / a.rec) * 0.3;
      }

      // ---------------------------------------------------------------- guards
      function wallBetween(x0, x1, r) { for (let c = colOf(Math.min(x0, x1)); c <= colOf(Math.max(x0, x1)); c++) if (wallAt(c, r) || gateClosedAt(c, r)) return true; return false; }
      function guardUpdate(g, dt) {
        g.px = g.x; g.py = g.y;
        g.t += dt;
        if (g.st === "die") { if (g.t >= 0.9) setSt(g, "dead"); return; }
        if (g.st === "dead") return;
        if (g.st === "fall") {
          const yPrev = g.y;
          g.vy = Math.min(g.vy + GRAV * dt, 520);
          moveX(g, (g.vx || 0) * dt, Math.ceil((g.y - FLO) / TH - 1e-6), null, true);
          g.vx = (g.vx || 0) * Math.pow(0.3, dt);
          g.y += g.vy * dt;
          const lr = landingRow(g.x, yPrev, g.y);
          if (lr) { g.y = FL(lr.r); const rows = lr.r - g.startRow; g.row = lr.r; api.sfx("pr_thud"); if (rows >= 2 || spikeUnder(g.x, lr.r)) { g.hp = 0; guardDie(g); setSt(g, "dead"); } else setSt(g, "guard"); }
          else if (g.y > S.W.R * TH + 60) { g.alive = false; g.st = "gone"; if (g.boss) guardDie(g); }
          return;
        }
        if (!g.alive) return;
        const h = hero, s = gSkill(g);
        const dx = h.x - g.x, dist = Math.abs(dx);
        const hr = roomOf(h.x, h.y - 22), gr = roomOf(g.x, g.y - 22);
        const sees = !h.dead && grounded(h.st) && h.row === g.row && dist < 300 && hr.rx === gr.rx && hr.ry === gr.ry && !wallBetween(g.x, h.x, g.row);
        if (g.st === "post") {
          if (sees || (g.engaged && !h.dead)) { g.engaged = true; g.face = Math.sign(dx) || g.face; setSt(g, "draw"); }
          return;
        }
        if (g.st === "draw") { if (g.t >= 0.12 && !g.armed) { g.armed = true; if (sees) api.sfx("pr_draw"); } if (g.t >= 0.32) setSt(g, "guard"); return; }
        if (g.st === "sheathe") { if (g.t >= 0.18) g.armed = false; if (g.t >= 0.32) setSt(g, "post"); return; }
        if (sees) g.lostT = 0; else g.lostT += dt;
        if (g.lostT > 2.5 && g.st === "guard") { g.engaged = false; setSt(g, "sheathe"); return; }
        if (g.parryAt >= 0) { g.parryAt -= dt; if (g.parryAt < 0 && ["guard", "advance", "retreat"].includes(g.st)) setSt(g, "parry"); }
        fightUpdate(g, dt, 0);
        if (g.st !== "guard" || h.dead || !sees) return;
        g.cd -= dt; g.think -= dt;
        const want = Math.sign(dx) || g.face;
        if (want !== g.face && dist > 3) { setSt(g, "gturn"); return; }
        if (g.think > 0) return;
        g.think = lerp(0.5, 0.1, s) * (0.7 + Math.random() * 0.6);
        if (g.retreatNext) { g.retreatNext = false; setSt(g, "retreat"); g.x0 = g.x; return; }
        if (g.riposte && dist <= REACH + 4) { g.riposte = false; startStrike(g); return; }
        g.riposte = false;
        const ideal = lerp(30, 34, s);
        if (dist > ideal + 12) { setSt(g, "advance"); g.x0 = g.x; return; }
        if (dist < 20) { setSt(g, "retreat"); g.x0 = g.x; return; }
        if (g.cd <= 0 && dist <= REACH) {
          g.cd = lerp(2.3, 0.75, s) * (0.65 + Math.random() * 0.7) * (g.boss && g.hp <= 2 ? 0.6 : 1);
          g.feint = s > 0.78 && Math.random() < 0.28;
          startStrike(g);
          return;
        }
        if (s > 0.4 && Math.random() < 0.3 * s) { setSt(g, dist > ideal ? "advance" : "retreat"); g.x0 = g.x; }
      }

      // ---------------------------------------------------------------- traps and things
      function trapsUpdate(dt) {
        const w = S.W, h = hero;
        const hr = roomOf(h.x, heroFocusY());
        const inRoom = (c, r) => Math.floor(c / RC) === hr.rx && Math.floor(r / RR) === hr.ry;
        // loose floors
        for (const lt of w.loose.values()) {
          if (lt.st === "shake") {
            lt.t += dt;
            if (Math.random() < dt * 14) fx.emit({ x: lt.c * TW + 4 + Math.random() * 24, y: FL(lt.r) + 10, n: 1, colors: [w.theme.front[1], w.theme.top[2]], speed: [5, 20], angle: [1.2, 1.9], life: [0.3, 0.6], gravity: 200 });
            if (lt.t >= 0.5) { lt.st = "fall"; lt.vy = 0; api.sfx("pr_shake"); }
          } else if (lt.st === "fall") {
            const yPrev = lt.y;
            lt.vy = Math.min(lt.vy + GRAV * dt, 560); lt.y += lt.vy * dt;
            const x = lt.c * TW + 16;
            // the hero under it
            if (!lt.hitHero && !h.dead && Math.abs(h.x - x) < 18 && lt.y + 12 > h.y - 42 && lt.y < h.y - 10 && grounded(h.st)) {
              lt.hitHero = true; api.sfx("hurt");
              if (!heroHurt(1, "fall")) { setSt(h, "landHard"); say("ОХ!", ["#FFC2C9", "#FFC2C9", "#FF8F8F", "#FF8F8F", "#FF6B7A", "#D93644", "#D93644"], 0.8); }
            }
            for (let r = lt.r + 1; r < w.R; r++) {
              const ly = FL(r) - 2;
              if (yPrev < ly && lt.y >= ly && support(lt.c, r)) {
                lt.st = "gone"; w.rubble.push({ c: lt.c, r });
                if (inRoom(lt.c, r) || inRoom(lt.c, lt.r)) { api.sfx("pr_crash"); api.shake(2, 0.2); }
                fx.emit({ x, y: FL(r) - 2, n: 26, colors: [w.theme.top[0], w.theme.front[1], w.theme.front[2]], speed: [20, 90], angle: [Math.PI, Math.PI * 2], life: [0.4, 0.9], gravity: 300, drag: 1, size: 2 });
                break;
              }
            }
            if (lt.y > w.R * TH + 40) lt.st = "gone";
          }
        }
        // spikes: they spring out when someone comes near
        for (const sp of w.spikes) {
          const cx = sp.c * TW + 16;
          const near = !h.dead && Math.abs(h.x - cx) < 46 && (h.row === sp.r || (!grounded(h.st) && Math.abs(h.y - FL(sp.r)) < 70));
          if (near) { if (sp.ext < 0.1 && inRoom(sp.c, sp.r)) api.sfx("pr_spikes"); sp.hold = 1.1; tip("spikes", "Шипы! Иди осторожным шагом (↓ + →) или перепрыгни"); }
          else sp.hold -= dt;
          sp.ext = sp.hold > 0 || (h.dead && h.deathKind === "spikes" && spikeAt(h.x, h.row) === sp) ? Math.min(1, sp.ext + dt * 12) : Math.max(0, sp.ext - dt * 3);
        }
        // chompers
        for (const ch of w.chompers) {
          const was = (ch.ph % 1.7) / 1.7;
          ch.ph += dt;
          const k = (ch.ph % 1.7) / 1.7;
          if (k < was && inRoom(ch.c, ch.r)) api.sfx("pr_chomp");
          ch.k = k;
          const shut = k < 0.1;
          if (shut && !h.dead && h.row === ch.r && Math.abs(h.x - (ch.c * TW + 16)) < 8 && (grounded(h.st) || Math.abs(h.y - FL(ch.r)) < 30)) heroDie("chomp");
          if (inRoom(ch.c, ch.r) && Math.abs(h.x - (ch.c * TW + 16)) < 60 && h.row === ch.r) tip("chomp", "Ножи! Проскакивай, когда они раскроются");
        }
        // plates and gates
        for (const p of w.plates) {
          let down = !h.dead && grounded(h.st) && h.row === p.r && colOf(h.x) === p.c;
          for (const g of guards) if (g.alive && g.row === p.r && colOf(g.x) === p.c && g.st !== "fall") down = true;
          if (down && !p.down) {
            api.sfx("pr_click");
            if (p.letter === "o") {
              const ex = w.exit;
              if (ex && ex.open < 1 && !ex.opening) { ex.opening = true; api.sfx("pr_door"); say("ВЫХОД ОТКРЫВАЕТСЯ!", GOLD, 1.8); api.shake(2, 0.6); }
            } else {
              const gt = w.gates[p.letter];
              if (gt) { gt.target = 1; gt.timer = gt.hold; if (gt.open < 0.05) say("ВОРОТА ПОДНИМАЮТСЯ", INK, 1.2, false); }
            }
          }
          if (down && p.letter !== "o") { const gt = w.gates[p.letter]; if (gt) { gt.target = 1; gt.timer = gt.hold; } }
          p.down = down;
        }
        for (const [L, gt] of Object.entries(w.gates)) {
          if (gt.target === 1 && gt.hold > 0) { gt.timer -= dt; if (gt.timer <= 0) gt.target = 0; }
          const before = gt.open;
          gt.open = gt.target ? Math.min(1, gt.open + dt * 1.1) : Math.max(0, gt.open - dt * 0.42);
          const moving = gt.open !== before;
          if (moving && gt.cells.some((c) => inRoom(c.c, c.r))) { gt.tick = (gt.tick || 0) + dt; if (gt.tick > 0.09) { gt.tick = 0; api.sfx("pr_gate"); } }
          if (gt.open < 0.62 && h.row === gt.cells[0].r && gt.cells.some((c) => Math.abs(h.x - (c.c * TW + 26)) < 40) && !gt.everOpen) tip("gate" + L, "Ворота заперты. Ищи плиту на полу — она их поднимет");
          if (gt.open > 0.9) gt.everOpen = true;
        }
        const ex = w.exit;
        if (ex && ex.opening && ex.open < 1) { ex.open = Math.min(1, ex.open + dt / 2.2); if (ex.open >= 1) ex.opening = false; }
        if (ex && ex.open >= 1 && grounded(h.st) && !h.dead && h.row === ex.r && Math.abs(ex.c * TW + 16 - h.x) < 9 && ["stand", "run", "runStop", "step", "runStart", "land"].includes(h.st)) enterExit();
        if (ex && ex.open < 1 && !ex.opening && h.row === ex.r && Math.abs(ex.c * TW + 16 - h.x) < 30) tip("exitShut", w.exitPlate ? "Выход заперт. Найди плиту, которая его открывает" : "Выход откроется, когда комендант будет повержен");
        // contextual tips for the first moves
        if (grounded(h.st) && h.st === "stand" && !h.dead) {
          if (findLedgeAbove(h.x, h.row, h.face)) tip("ledge", "«↑» или «Прыжок» на месте — зацепиться за уступ");
          if (potionHere()) tip("potion", "«↓» — выпить зелье");
          if (findDropEdge(h.x, h.row)) tip("drop", "«↓» у края — слезть и повиснуть");
        }
      }

      // ---------------------------------------------------------------- run flow
      const starsFor = (left) => { const L = S.W.L; return left >= L.star2 ? (S.livesLost === 0 ? 3 : 2) : 1; };
      function levelCleared() {
        S.phase = "won"; S.phaseT = 0;
        api.music(null);
        api.sfx("win");
        api.flash("#FFF0C2", 0.25);
        S.levelsDone++;
        S.starsAtEnd = endless ? 0 : starsFor(S.timeLeft);
        if (S.level === "adaptive" && !endless) WG.adaptive.report(ID, true);
      }
      function fail(why) {
        if (S.phase !== "play") return;
        S.phase = "lost"; S.phaseT = 0; S.lostWhy = why;
        api.music(null);
        if (why === "time") { api.sfx("gameover"); say("ВРЕМЯ ВЫШЛО", ["#FFC2C9", "#FFC2C9", "#FF8F8F", "#FF8F8F", "#FF6B7A", "#D93644", "#D93644"], 3); }
        if (S.level === "adaptive" && !endless) WG.adaptive.report(ID, false);
      }
      function finish() {
        if (S.ended) return;
        S.ended = true;
        const meta = { lv: S.li + 1, lives: S.lives, left: Math.round(S.timeLeft), lost: S.livesLost, level: S.level };
        if (S.phase === "won" && !endless) {
          const stars = S.starsAtEnd, L = S.W.L;
          const line = "Осталось " + clock(S.timeLeft) + " · " + (S.livesLost ? "потеряно жизней: " + S.livesLost : "без потерь");
          const hint = stars === 1 ? "★★ — закончи, когда в часах ещё " + clock(L.star2) : stars === 2 ? "★★★ — то же, но не теряя жизней" : "";
          api.clear({ stars, score: Math.round(S.timeLeft), ms: Math.round(S.playMs), line, hint, meta });
          return;
        }
        const score = S.levelsDone * LEVEL_POINTS + (S.phase === "won" ? Math.round(S.timeLeft) : 0);
        if (endless) {
          api.end({ score, ms: Math.round(S.playMs), won: S.phase === "won", meta,
            title: S.phase === "won" ? undefined : S.lostWhy === "time" ? "ВРЕМЯ ВЫШЛО" : undefined });
          return;
        }
        const L = S.W.L;
        api.end({ score: 0, ms: Math.round(S.playMs), meta,
          line: (S.lostWhy === "time" ? "Песок в часах кончился" : "Жизни кончились") + " · " + L.name,
          hint: S.lostWhy === "time" ? "Беги, где можно, а осторожный шаг — только у ловушек."
            : { spikes: "Через шипы — осторожным шагом (↓ и направление) или прыжком.", fall: "Падать можно на один ярус; ниже — слезай по краю (↓).",
              chomp: "Ножи раскрываются — тут и проскакивай.", abyss: "Над пропастью прыгай с разбега: «Прыжок» на бегу." }[S.lastDeath]
              || "Защищайся «Прыжком», когда страж заносит меч, и бей в ответ." });
      }
      function nextLevel() {
        const i = S.li + 1;
        const hp = hero.hp, sw = hero.hasSword;
        loadLevel(i);
        hero.hp = hp; hero.hasSword = sw || !!LEVELS[i].sword;
        S.roomKey = "";
        S.phase = "between"; S.phaseT = 0;
      }

      // ---------------------------------------------------------------- the intro card: the guards' strength
      function setLevel(lv) {
        S.level = lv; S.skill = baseSkill(lv); S.adapt = 0;
        WG.store.set("level." + ID, lv);
        if (WG.runner && WG.runner.def && WG.runner.def.id === ID) WG.runner.level = lv; // the run's score goes under this level
        for (const g of guards) if (g.boss) g.maxHp = g.hp = 5 + (lv === "master" ? 1 : 0);
      }
      function introInput() {
        let ch = 0;
        if (I.pressed("left")) ch = -1;
        if (I.pressed("right")) ch = 1;
        if (I.tap) {
          const t = I.tap;
          if (t.y >= 128 && t.y <= 148) { if (t.x < 150) ch = -1; else if (t.x > 234) ch = 1; else return true; }
          else return true;
        }
        if (ch) { S.introSel = (S.introSel + ch + LVL_KEYS.length) % LVL_KEYS.length; setLevel(LVL_KEYS[S.introSel]); api.sfx("tick"); }
        return I.pressed("a") || I.pressed("b") || I.pressed("up");
      }

      loadLevel(S.li);
      setLevel(S.level);

      // ---------------------------------------------------------------- the instance
      return {
        _state: S, _hero: hero, _guards: () => guards, // for automated checks (games/dev)
        _debug: { warp(x, r, face) { hero.x = x; hero.y = FL(r); hero.row = r; hero.px = x; hero.py = hero.y; hero.face = face || 1; setSt(hero, "stand"); snapCam(); S.roomKey = ""; },
          kill: () => heroDie("sword"), win: () => levelCleared(), time: (s) => { S.timeLeft = s; }, give: () => { hero.hasSword = true; },
          world: () => S.W, support, findLedgeAbove, findDropEdge },
        start() {
          S.phase = "intro"; S.phaseT = 0;
          api.music(null);
          api.sfx("start");
        },
        update(dt) {
          S.t += dt; S.phaseT += dt;
          fx.update(dt);
          for (const m of S.msgs) m.t += dt;
          S.msgs = S.msgs.filter((m) => m.t < m.dur);
          if (S.tip) { S.tip.t += dt; if (S.tip.t > 4.5) S.tip = null; }
          if (S.fade > 0) S.fade -= dt;
          // the camera slides between rooms
          const ct = camTarget();
          for (const k of ["x", "y"]) { const dd = ct[k] - S.cam[k]; S.cam[k] = Math.abs(dd) < 0.6 ? ct[k] : S.cam[k] + dd * Math.min(1, dt * 13); }
          // torches' embers
          if (Math.random() < dt * 6) {
            const tc = S.W.torches[Math.floor(Math.random() * S.W.torches.length)];
            if (tc && Math.abs(tc.x - S.cam.x - 192) < 220) fx.emit({ x: tc.x + (Math.random() * 4 - 2), y: tc.y - 6, n: 1, colors: ["#FFD27A", "#FFB347", "#FFF0C2"], speed: [6, 18], angle: [-1.9, -1.2], life: [0.4, 0.9] });
          }
          if (S.W.L.theme === "dungeon" && Math.random() < dt * 1.5) fx.emit({ x: S.cam.x + Math.random() * RW, y: S.cam.y + 2, n: 1, colors: ["#7FE6F4", "#A9B6CD"], speed: [0, 2], angle: [1.5, 1.6], life: [0.8, 1.2], gravity: 240 });
          if (S.phase === "intro") {
            if (introInput()) { S.phase = "play"; S.phaseT = 0; api.music(MAIN); api.sfx("go"); S.roomKey = ""; if (S.li === 0) tip("move", "←→ — бег, короткое нажатие — осторожный шаг"); }
            return;
          }
          if (S.phase === "between") {
            if (S.phaseT > 2.6 || (S.phaseT > 0.6 && (I.pressed("a") || I.pressed("b") || I.tap))) { S.phase = "play"; S.phaseT = 0; api.music(MAIN); api.sfx("go"); }
            return;
          }
          if (S.phase === "won") {
            if (hero.st === "exit") heroUpdate(dt);
            if (S.phaseT > 2.4) {
              if (endless && S.li + 1 < LEVELS.length) nextLevel();
              else finish();
            }
            return;
          }
          if (S.phase === "lost") {
            if (hero.dead) heroUpdate(dt);
            if (S.phaseT > 1.8) finish();
            return;
          }
          if (S.phase !== "play") return;
          // the hourglass
          S.playMs += dt * 1000;
          const before = S.timeLeft;
          S.timeLeft -= dt;
          if (S.timeLeft <= 60 && Math.floor(before) !== Math.floor(S.timeLeft) && S.timeLeft > 0) { api.sfx("pr_tick"); if (Math.floor(S.timeLeft) === 60) say("ОСТАЛАСЬ МИНУТА!", ["#FFC2C9", "#FFC2C9", "#FF8F8F", "#FF8F8F", "#FF6B7A", "#D93644", "#D93644"], 1.8); }
          if (S.timeLeft <= 0) { S.timeLeft = 0; fail("time"); return; }
          heroUpdate(dt);
          for (const g of guards) guardUpdate(g, dt);
          trapsUpdate(dt);
          if (hero.dead) {
            S.deathT += dt;
            if (S.deathT > 1.7 && S.phase === "play") { afterDeath(); }
          }
          // the fight music follows the swords
          const fighting = guards.some((g) => g.alive && g.engaged && g.row === hero.row && Math.abs(g.x - hero.x) < 160);
          if (fighting !== S.fighting) {
            S.fightT += dt;
            if (S.fightT > (fighting ? 0.05 : 1.6)) { S.fighting = fighting; S.fightT = 0; api.music(fighting ? FIGHT : MAIN); if (fighting) tip("fight", "«Меч» — удар, «Прыжок» — защита, когда страж замахнётся"); }
          } else S.fightT = 0;
        },
        draw(g, alpha) {
          const t = S.t, w = S.W, T = w.theme;
          const cx = Math.round(S.cam.x), cy = Math.round(S.cam.y);
          g.fillStyle = "#04070F"; g.fillRect(0, 0, 384, 216);
          // the sky (behind windows and the open battlements)
          if (w.hasSky) {
            art.sky(g, 0, HUD, 384, RH, t, { seed: 3 + S.li, top: T.sky.top, bottom: T.sky.bottom, curtain: T.sky.curtain, amount: 0.95 });
            const viewOut = w.outdoor(colOf(cx + 10), Math.floor((cy + 10) / TH)) || w.outdoor(colOf(cx + RW - 10), Math.floor((cy + 10) / TH)) || w.outdoor(colOf(cx + 10), Math.floor((cy + RH - 10) / TH));
            if (viewOut) {
              art.moon(g, 300 - Math.round(cx * 0.05) % 400, HUD + 26, 8);
              farLayers().draw(g, cx, 0);
            }
          }
          g.drawImage(w.back, cx, cy, RW, RH, 0, HUD, RW, RH);
          g.save();
          g.beginPath(); g.rect(0, HUD, 384, RH); g.clip();
          g.translate(-cx, HUD - cy);
          drawThings(g, t, cx, cy);
          drawActors(g, alpha);
          g.restore();
          g.drawImage(w.front, cx, cy, RW, RH, 0, HUD, RW, RH);
          g.save();
          g.beginPath(); g.rect(0, HUD, 384, RH); g.clip();
          g.translate(-cx, HUD - cy);
          drawGates(g, t);
          fx.draw(g);
          g.restore();
          if (S.fade > 0) { g.globalAlpha = clamp(S.fade / 0.6, 0, 1); g.fillStyle = "#04070F"; g.fillRect(0, HUD, 384, RH); g.globalAlpha = 1; }
          drawHud(g);
          drawMsgs(g);
          if (S.phase === "intro") drawIntro(g);
          if (S.phase === "between") drawBetween(g);
          if (S.phase === "won") drawWon(g);
        },
      };

      // ---------------------------------------------------------------- drawing
      function drawThings(g, t, cx, cy) {
        const w = S.W, T = w.theme;
        const vis = (x, y) => x > cx - 40 && x < cx + RW + 40 && y > cy - 70 && y < cy + RH + 70;
        // torches' flames and a soft glow
        for (const tc of w.torches) {
          if (!vis(tc.x, tc.y)) continue;
          const f = SPR.flames[Math.floor(t * 10 + tc.ph) % 4];
          const r = 9 + Math.round(Math.sin(t * 7 + tc.ph) * 1.5);
          halo(g, tc.x, tc.y - 2, r, "rgba(255,200,120,.2)", 0.5);
          if (w.outdoor(colOf(tc.x), Math.floor((tc.y + 40) / TH))) {
            g.fillStyle = "#24170F"; g.fillRect(tc.x - 4, tc.y - 4, 9, 10);
            g.fillStyle = "#FFD27A"; g.fillRect(tc.x - 3, tc.y - 3, 7, 8);
            g.fillStyle = "#FFF0C2"; g.fillRect(tc.x - 1, tc.y - 2 + (Math.floor(t * 8 + tc.ph) % 2), 3, 4);
            g.fillStyle = "#24170F"; g.fillRect(tc.x - 5, tc.y - 6, 11, 2); g.fillRect(tc.x - 4, tc.y + 5, 9, 2); g.fillRect(tc.x, tc.y - 9, 1, 3);
          } else g.drawImage(f, tc.x - 3, tc.y - 6);
        }
        // rubble of broken floors
        for (const rb of w.rubble) g.drawImage(w.rubbleImg, rb.c * TW, FL(rb.r) - 7);
        // loose floors
        for (const lt of w.loose.values()) {
          if (lt.st === "gone") continue;
          const x = lt.c * TW, y = lt.st === "fall" ? lt.y : FL(lt.r) - 2;
          if (!vis(x, y)) continue;
          const j = lt.st === "shake" ? (Math.floor(lt.t * 30) % 2 ? 1 : -1) : 0;
          g.drawImage(w.looseImg, x, Math.round(y) + j);
        }
        // spikes
        for (const sp of w.spikes) {
          if (sp.ext <= 0.02) continue;
          const x0 = sp.c * TW, y = FL(sp.r);
          const hh = Math.round(13 * sp.ext);
          for (const sx of [5, 12, 19, 26]) {
            for (let k = 0; k < hh; k++) {
              const wdt = k > hh - 4 ? 1 : k > hh - 8 ? 2 : 3;
              g.fillStyle = k > hh - 3 ? "#FFFFFF" : "#C9D6F2"; g.fillRect(x0 + sx - Math.floor(wdt / 2), y - k, wdt, 1);
              if (wdt > 1) { g.fillStyle = "#6B7694"; g.fillRect(x0 + sx + Math.ceil(wdt / 2) - 1, y - k, 1, 1); }
            }
          }
        }
        // chompers: two serrated steel jaws in a slot in the wall, snapping shut every 1.7 s
        for (const ch of w.chompers) {
          const x = ch.c * TW + 16, y = FL(ch.r);
          if (!vis(x, y)) continue;
          const k = ch.k || 0;
          const open = k < 0.05 ? 0 : k < 0.1 ? 0 : Math.min(1, (k - 0.1) * 5);
          const gap = Math.round(open * 42), mid = y - 28;
          const top = mid - Math.floor(gap / 2), bot = mid + Math.ceil(gap / 2);
          g.fillStyle = "#070B16"; g.fillRect(x - 7, y - 60, 14, 60);
          g.fillStyle = "#0E1424"; g.fillRect(x - 6, y - 59, 12, 58);
          const jaw = (y0, y1, down) => {
            if (y1 <= y0) return;
            g.fillStyle = "#2C3550"; g.fillRect(x - 5, y0, 11, y1 - y0);
            g.fillStyle = "#8590B0"; g.fillRect(x - 5, y0, 9, y1 - y0);
            g.fillStyle = "#C9D6F2"; g.fillRect(x - 5, y0, 2, y1 - y0);
            g.fillStyle = "#5F6F93"; g.fillRect(x + 2, y0, 2, y1 - y0);
            for (let yy = y0 + 4; yy < y1 - 3; yy += 9) { g.fillStyle = "#2C3550"; g.fillRect(x - 1, yy, 2, 2); g.fillStyle = "#E2E8F5"; g.fillRect(x - 1, yy, 1, 1); }
            // the teeth
            const e = down ? y1 : y0 - 1;
            for (let i = 0; i < 11; i++) {
              const tall = i % 3 === 1 ? 3 : i % 3 === 0 ? 2 : 1;
              g.fillStyle = i % 3 === 1 ? "#FFFFFF" : "#C9D6F2";
              if (down) g.fillRect(x - 5 + i, e, 1, tall); else g.fillRect(x - 5 + i, e - tall + 1, 1, tall);
            }
          };
          jaw(y - 59, top - 3, true);
          jaw(bot + 3, y - 1, false);
          if (gap < 4) { g.fillStyle = "#FFFFFF"; g.fillRect(x - 7, mid - 1, 15, 2); if (Math.random() < 0.5) fx.emit({ x: x + (Math.random() < 0.5 ? -7 : 7), y: mid, n: 2, colors: ["#FFFFFF", "#FFD27A"], speed: [20, 60], life: [0.1, 0.25], shape: "spark" }); }
        }
        // plates
        for (const p of w.plates) {
          const x0 = p.c * TW + 8, y = FL(p.r);
          g.fillStyle = p.letter === "o" ? (p.down ? "#C98A1B" : "#FFD27A") : p.down ? T.top[2] : T.top[0];
          g.fillRect(x0 + 1, y - (p.down ? 2 : 3), 14, p.down ? 2 : 3);
          g.fillStyle = T.edge; g.fillRect(x0, y - (p.down ? 2 : 3), 1, 3); g.fillRect(x0 + 15, y - (p.down ? 2 : 3), 1, 3);
          if (p.letter === "o" && !p.down) { g.fillStyle = "#FFF0C2"; g.fillRect(x0 + 7, y - 3, 2, 1); }
        }
        // potions and the sword
        for (const p of w.potions) {
          if (p.taken) continue;
          const x = p.c * TW + 16, y = FL(p.r);
          if (!vis(x, y)) continue;
          const img = p.kind === "h" ? SPR.heal : SPR.life;
          halo(g, x, y - img.height / 2, 9, p.kind === "h" ? "rgba(255,107,122,.22)" : "rgba(127,230,244,.26)", 0.55);
          g.drawImage(img, x - Math.floor(img.width / 2), y - img.height);
          if (Math.random() < 0.04) fx.emit({ x: x + Math.random() * 4 - 2, y: y - img.height + 2, n: 1, colors: p.kind === "h" ? ["#FFC2C9", "#FF8A97"] : ["#D2FAFF", "#7FE6F4"], speed: [4, 10], angle: [-1.8, -1.3], life: [0.4, 0.8], shape: "star" });
        }
        const sw = w.sword;
        if (sw && !sw.taken) {
          const x = sw.c * TW + 16, y = FL(sw.r);
          g.drawImage(SPR.swordFloor, x - 9, y - 7);
          if (Math.floor(t * 2) % 3 === 0) { const gx = x + 4 + Math.floor((t * 20) % 8); g.fillStyle = "#FFFFFF"; g.fillRect(gx, y - 6, 1, 1); g.fillRect(gx - 1, y - 5, 3, 1); g.fillRect(gx, y - 4, 1, 1); }
        }
        // the exit door
        const ex = w.exit;
        if (ex) {
          const x = ex.c * TW + 16, y = FL(ex.r);
          // behind the door: the open night, seen through the arch
          const dh = 52;
          g.save(); g.beginPath(); g.rect(x - 11, y - 41, 22, 41); g.arc(x, y - 41, 11, Math.PI, 0); g.clip();
          art.bands(g, x - 11, y - dh, 22, dh, ["#13204A", "#183A5A", "#1F6E68", "#34D399"]);
          for (let i = 0; i < 9; i++) { const sx = x - 10 + Math.floor(hash(i, 4) * 20), sy = y - dh + 2 + Math.floor(hash(i, 6) * 22); if (Math.sin(t * 3 + i) > -0.2) { g.fillStyle = "#FFFFFF"; g.fillRect(sx, sy, 1, 1); } }
          for (let k = 0; k < 4; k++) { g.fillStyle = k % 2 ? T.top[1] : T.top[2]; g.fillRect(x - 11, y - 3 - k * 3, 22, 2); }
          const open = ex.open;
          const ph = Math.round((dh - 2) * (1 - open));
          if (ph > 0) {
            g.fillStyle = "#4E3424"; g.fillRect(x - 11, y - dh, 22, ph);
            for (let xx = x - 10; xx < x + 11; xx += 4) { g.fillStyle = "#7A5236"; g.fillRect(xx, y - dh, 3, ph); g.fillStyle = "#A8774D"; g.fillRect(xx, y - dh, 1, ph); }
            g.fillStyle = "#24170F"; g.fillRect(x - 11, y - dh + ph - 2, 22, 2);
            for (const yy of [16, 30, 44]) if (yy < ph) { g.fillStyle = "#C98A1B"; g.fillRect(x - 11, y - dh + yy, 22, 2); g.fillStyle = "#FFD27A"; g.fillRect(x - 11, y - dh + yy, 22, 1); }
          }
          g.restore();
          if (open >= 1 && Math.random() < 0.08) fx.emit({ x: x + Math.random() * 18 - 9, y: y - 4, n: 1, colors: ["#8EF0C6", "#D2FAFF", "#FFFFFF"], speed: [4, 12], angle: [-1.8, -1.3], life: [0.6, 1.2], shape: "star" });
        }
      }
      function drawGates(g) {
        const w = S.W, T = w.theme;
        for (const gt of Object.values(w.gates)) for (const cell of gt.cells) {
          const x0 = cell.c * TW, y = FL(cell.r);
          const bottom = Math.round(y - 2 - gt.open * 50);
          const top = y - 58;
          if (bottom <= top) continue;
          for (const bx of [23, 26, 29]) {
            g.fillStyle = "#11172A"; g.fillRect(x0 + bx - 1, top, 3, bottom - top);
            g.fillStyle = "#6B7694"; g.fillRect(x0 + bx, top, 1, bottom - top);
          }
          for (let yy = bottom - 3; yy > top; yy -= 10) { g.fillStyle = "#11172A"; g.fillRect(x0 + 21, yy - 1, 11, 3); g.fillStyle = "#8590B0"; g.fillRect(x0 + 21, yy, 11, 1); }
          for (const bx of [23, 26, 29]) { g.fillStyle = "#C9D6F2"; g.fillRect(x0 + bx, bottom - 1, 1, 2); }
          g.fillStyle = T.out; g.fillRect(x0 + 20, top - 4, 13, 4);
        }
      }
      function drawActors(g, alpha) {
        const lerpA = (a, b) => a + (b - a) * (alpha || 0);
        const fighter = (a, cosName) => {
          let anim = a.st, tt = a.t, armed = a.armed;
          switch (a.st) {
            case "stand": case "post": anim = "idle"; tt = S.t; break;
            case "run": anim = "run"; tt = a === hero ? hero.runD / RUN : a.t; break;
            case "strike": tt = strikeAnimT(a); break;
            case "hang": tt = a.t; break;
            case "climbUp": anim = "climb"; tt = a.t; break;
            case "climbDown": anim = "climb"; tt = 0.85 - a.t; tt = (tt / 0.85) * 1.0; break;
            case "jumpUp": if (a.ledge && a.t > 0.24) { anim = "hang"; } break;
            case "exit": anim = "walk"; tt = a.t; break;
            case "die": anim = "die"; break;
            case "dead": anim = a === hero ? "dead" : "dead"; break;
            case "abyss": return;
            case "gone": return;
            case "fall": if (a !== hero) { anim = "fall"; } break;
          }
          if (!AN[anim]) anim = "idle";
          const img = frame(cosName, anim, tt, armed && a.st !== "pick" ? true : a.st === "pick" && a.t > 0.42, a.hasSword || a !== hero);
          const x = lerpA(a.px === undefined ? a.x : a.px, a.x), y = lerpA(a.py === undefined ? a.y : a.py, a.y);
          if (grounded(a.st) && a.st !== "abyss") { g.fillStyle = "rgba(4,7,15,.45)"; g.fillRect(Math.round(x) - 6, Math.round(y) - 1, 12, 2); }
          if (a === hero && hero.invuln > 0 && Math.floor(S.t * 16) % 2) return;
          drawActor(g, img, x, y, a.face, a === hero ? hero.alpha : 1);
        };
        for (const gd of guards) if (gd.st === "dead" || gd.st === "die") fighter(gd, gd.cos);
        for (const gd of guards) if (gd.st !== "dead" && gd.st !== "die") fighter(gd, gd.cos);
        fighter(hero, "hero");
      }
      function drawHud(g) {
        if (!SPR.hud) {
          SPR.hud = WG.canvas(384, HUD);
          const h = SPR.hud.getContext("2d");
          art.bands(h, 0, 0, 384, HUD, ["#04070F", "#070C1A", "#0B1226"]);
          h.fillStyle = "#26324F"; h.fillRect(0, HUD - 2, 384, 1);
          h.fillStyle = "#C98A1B"; h.fillRect(0, HUD - 1, 384, 1);
          for (let x = 0; x < 384; x += 8) { h.fillStyle = "#6B4A0A"; h.fillRect(x + 3, HUD - 1, 2, 1); }
        }
        g.drawImage(SPR.hud, 0, 0);
        // lives and health
        for (let i = 0; i < Math.max(3, S.lives); i++) g.drawImage(i < S.lives ? SPR.heart : SPR.heartOff, 5 + i * 10, 3);
        for (let i = 0; i < hero.maxHp; i++) g.drawImage(i < hero.hp ? SPR.hp : SPR.hpOff, 6 + i * 9, 13);
        if (hero.hp === 1 && !hero.dead && Math.floor(S.t * 4) % 2) { g.fillStyle = "rgba(255,107,122,.35)"; g.fillRect(5, 12, 9, 8); }
        // the hourglass
        const low = S.timeLeft <= 60;
        g.drawImage(SPR.glass, 160, 5);
        const tc = low && Math.floor(S.t * 4) % 2 ? ["#FFC2C9", "#FFC2C9", "#FF8F8F", "#FF8F8F", "#FF6B7A", "#FF6B7A", "#D93644"] : INK;
        WG.text(g, clock(S.timeLeft), 172, 5, { scale: 2, color: tc, shadow: "#04070F" });
        // the right: the opponent when fighting, otherwise the level and the stars still in reach
        const foe = guards.find((gd) => gd.alive && gd.engaged && gd.row === hero.row && Math.abs(gd.x - hero.x) < 160);
        if (foe) {
          WG.text(g, foe.boss ? "КОМЕНДАНТ" : "СТРАЖ", 378, 3, { align: "right", color: "#C4BBFF", shadow: "#04070F" });
          for (let i = 0; i < foe.maxHp; i++) g.drawImage(i < foe.hp ? SPR.ghp : SPR.hpOff, 372 - (foe.maxHp - 1 - i) * 9 - 2, 13);
        } else {
          WG.text(g, (endless ? "ПУТЬ · " : "") + (S.li + 1) + " · " + S.W.L.name.toUpperCase(), 378, 3, { align: "right", color: "#A9B6CD", shadow: "#04070F" });
          if (!endless) {
            const n = S.timeLeft >= S.W.L.star2 ? (S.livesLost ? 2 : 3) : 1;
            for (let i = 0; i < 3; i++) g.drawImage(i < n ? SPR.star : SPR.starOff, 349 + i * 10, 12);
          } else {
            WG.text(g, "ОЧКИ " + WG.fmtNum(S.levelsDone * LEVEL_POINTS), 378, 13, { align: "right", color: "#FFD27A", shadow: "#04070F" });
          }
        }
      }
      function drawMsgs(g) {
        let y = 74;
        for (const m of S.msgs) {
          const k = m.t / m.dur;
          if (k > 0.85 && Math.floor(m.t * 20) % 2) { y += 22; continue; }
          const sc = m.big ? 2 : 1;
          const rise = Math.round((1 - Math.min(1, m.t * 6)) * 6);
          WG.text(g, m.text, 192, y + rise, { scale: sc, align: "center", color: m.color, outline: "#04070F" });
          y += m.big ? 20 : 12;
        }
        if (S.tip && S.phase === "play") {
          const tw = WG.textWidth(S.tip.text) + 14;
          const a = Math.min(1, S.tip.t * 5, (4.5 - S.tip.t) * 3);
          g.globalAlpha = clamp(a, 0, 1);
          g.fillStyle = "rgba(10,15,30,.86)"; g.fillRect(192 - tw / 2, HUD + 5, tw, 13);
          g.fillStyle = "#26324F"; g.fillRect(192 - tw / 2, HUD + 5, tw, 1); g.fillRect(192 - tw / 2, HUD + 17, tw, 1);
          g.fillStyle = "#C98A1B"; g.fillRect(192 - tw / 2, HUD + 5, 2, 13);
          WG.text(g, S.tip.text, 192 + 1, HUD + 8, { align: "center", color: "#EAF0FA" });
          g.globalAlpha = 1;
        }
      }
      function panel(g, x, y, w, h) {
        g.fillStyle = "rgba(4,7,15,.55)"; g.fillRect(0, HUD, 384, RH);
        g.fillStyle = "#070B16"; g.fillRect(x - 1, y - 1, w + 2, h + 2);
        art.bands(g, x, y, w, h, ["#17213A", "#121B31", "#0E1730"]);
        g.fillStyle = "#26324F"; g.fillRect(x, y, w, 1); g.fillRect(x, y + h - 1, w, 1); g.fillRect(x, y, 1, h); g.fillRect(x + w - 1, y, 1, h);
        g.fillStyle = "#C98A1B"; g.fillRect(x + 6, y, w - 12, 1);
        g.fillStyle = "#FFD27A"; g.fillRect(x + w / 2 - 10, y, 20, 1);
      }
      function drawIntro(g) {
        const L = S.W.L;
        panel(g, 22, 34, 340, 170);
        WG.text(g, endless ? "ВЕСЬ ПУТЬ" : "УРОВЕНЬ " + (S.li + 1), 192, 44, { align: "center", color: "#A9B6CD" });
        WG.text(g, (endless ? "ЧЕТЫРЕ УРОВНЯ" : L.name).toUpperCase(), 192, 56, { scale: 2, align: "center", color: GOLD, outline: "#2A1E00" });
        WG.text(g, endless ? "Все " + LEVELS.length + " уровня подряд за " + clock(RUN_TIME) + " · 3 жизни" : L.story, 192, 78, { align: "center", color: "#EAF0FA" });
        if (endless) {
          WG.text(g, "Очки: 600 за уровень + секунды, что останутся", 192, 92, { align: "center", color: "#A9B6CD" });
          WG.text(g, "в часах, когда закроется последняя дверь", 192, 102, { align: "center", color: "#A9B6CD" });
        } else {
          WG.text(g, "★ дойти до выхода за " + clock(L.time), 120, 92, { color: "#FFD27A" });
          WG.text(g, "★★ и чтобы в часах осталось " + clock(L.star2), 120, 102, { color: "#FFD27A" });
          WG.text(g, "★★★ и не потерять ни одной жизни", 120, 112, { color: "#FFD27A" });
        }
        // the guards' strength
        const lv = LVL_KEYS[S.introSel];
        g.fillStyle = "#0A0F1E"; g.fillRect(60, 128, 264, 20);
        g.fillStyle = "#26324F"; g.fillRect(60, 128, 264, 1); g.fillRect(60, 147, 264, 1);
        const blink = Math.floor(S.t * 3) % 2;
        WG.text(g, "←", 70, 135, { color: blink ? "#FFD27A" : "#C98A1B" });
        WG.text(g, "→", 308, 135, { color: blink ? "#FFD27A" : "#C98A1B" });
        WG.text(g, "СТРАЖА: " + WG.levelName(lv).toUpperCase(), 192, 135, { align: "center", color: "#EAF0FA" });
        const hints = { easy: "Стражи медлительны и почти не защищаются", normal: "Стражи защищаются через раз", hard: "Защищаются часто и бьют в ответ",
          master: "Финты, ответные удары — бой в полную силу", adaptive: "Сила стражи подстроится под тебя" };
        WG.text(g, hints[lv], 192, 154, { align: "center", color: "#A9B6CD" });
        if (Math.floor(S.t * 2.5) % 3 !== 2) WG.text(g, "«ПРЫЖОК» — В ПУТЬ", 192, 180, { scale: 2, align: "center", color: INK, outline: "#04070F" });
      }
      function drawBetween(g) {
        const L = S.W.L;
        panel(g, 64, 70, 256, 82);
        WG.text(g, "УРОВЕНЬ " + (S.li + 1) + " ИЗ " + LEVELS.length, 192, 80, { align: "center", color: "#A9B6CD" });
        WG.text(g, L.name.toUpperCase(), 192, 93, { scale: 2, align: "center", color: GOLD, outline: "#2A1E00" });
        WG.text(g, L.story, 192, 114, { align: "center", color: "#EAF0FA" });
        WG.text(g, "В часах " + clock(S.timeLeft) + " · очки " + WG.fmtNum(S.levelsDone * LEVEL_POINTS), 192, 132, { align: "center", color: "#FFD27A" });
      }
      function drawWon(g) {
        if (S.phaseT < 0.9) return;
        const k = Math.min(1, (S.phaseT - 0.9) * 4);
        WG.text(g, endless && S.li + 1 >= LEVELS.length ? "КРЕПОСТЬ ПОЗАДИ!" : "УРОВЕНЬ ПРОЙДЕН!", 192, 96 - Math.round((1 - k) * 8), { scale: 3, align: "center", color: GOLD, outline: "#2A1E00" });
        if (!endless) for (let i = 0; i < 3; i++) {
          if (S.phaseT < 1.1 + i * 0.25) continue;
          const img = i < S.starsAtEnd ? SPR.star : SPR.starOff;
          g.drawImage(img, 178 + i * 10, 128, 9, 9);
        }
      }
    },
  });
  } // boot
})();
