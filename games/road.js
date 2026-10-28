/* Ночное шоссе — a night road race under the aurora in the spirit of the 16-bit arcade racers: the road is a chain of
   short segments projected toward the horizon and painted scanline by scanline (curves, hills, red-white kerbs),
   roadside things scale with distance, rivals and traffic share the lanes, checkpoints add time, and at the end of
   each track the road forks — the branch you take picks the scenery of the next track.
   Written against the Winger Games engine (engine.js, ENGINE.md); cars and pines come from reg-road.js (WG.roadKit).
   Things the engine has no API for live here: a continuous engine hum (an oscillator on WG.sound's own bus) and
   touch steering by screen halves (pointer listeners on the play screen, removed in destroy). */
"use strict";
(function () {
  const { art } = WG;
  const KIT = WG.roadKit;
  const { clamp, lerp } = WG.util;
  const W = 384, H = 216;
  // ---------- the world ----------
  const SEG = 200, ROAD = 1000, CAM_H = 1300, DEPTH = 0.84, PLAYER_Z = CAM_H * DEPTH;
  const DRAW = 170, RUMBLE = 3, HOR = 100, YS = 108, CURVE_K = 0.9;
  const MAXV = SEG * 60, KMH = 290;
  const UNIT = (ROAD / CAM_H) * (W / 2);   // pixels per road unit (half the road's width) at the player's depth
  const CAR_HW = 0.21;                     // half the player's car, in road units
  const ACCEL = MAXV / 4.2, BRAKE = MAXV / 1.5, COAST = MAXV / 7, OFF_DECEL = MAXV / 1.6, OFF_LIMIT = MAXV / 3.4;
  const CENTRIFUGAL = 0.3;
  const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
  const easeIn = (a, b, p) => a + (b - a) * p * p;
  const easeInOut = (a, b, p) => a + (b - a) * (-Math.cos(p * Math.PI) / 2 + 0.5);
  const ease3 = (p) => 1 - Math.pow(1 - clamp(p, 0, 1), 3);
  const mix = KIT.mix;
  const GOLD_T = ["#FFF0C2", "#FFF0C2", "#FFD27A", "#FFD27A", "#FFD27A", "#C98A1B", "#C98A1B"];
  const INK_T = ["#FFFFFF", "#FFFFFF", "#EAF0FA", "#EAF0FA", "#C9D6F2", "#C9D6F2", "#A9B6CD"];
  const RED_T = ["#FFE1E5", "#FFC2C9", "#FF8F9C", "#FF6B7A", "#FF6B7A", "#D93644", "#D93644"];
  const CYAN_T = ["#D2FAFF", "#D2FAFF", "#7FE6F4", "#7FE6F4", "#7FE6F4", "#22B8CF", "#22B8CF"];

  // ---------- sceneries ----------
  const SCN = {
    forest: { name: "Сосновый бор", short: "БОР", icon: "pine", song: 0,
      sky: { top: "#03060E", bottom: "#142A58", curtain: 0.48, amount: 1, seed: 3 }, moon: [322, 36, 7],
      grass: ["#0F3628", "#0C2D21"], rumble: ["#C8304A", "#D8DEEA"], road: ["#363F5B", "#313A55"], lane: "#C9D2E4", edge: "#A9B4CA",
      haze: "#1B2E5A", land: "#0A2219", lights: 18, dirt: ["#0F3628", "#1F5A3E", "#4E3424"] },
    city: { name: "Огни города", short: "ГОРОД", icon: "city", song: 1,
      sky: { top: "#05060F", bottom: "#2A2458", curtain: 0.42, amount: 0.75, seed: 7 }, moon: [76, 44, 5],
      grass: ["#343C55", "#2D344B"], rumble: ["#C9D2E4", "#5F6F93"], road: ["#2B3350", "#272E49"], lane: "#FFD27A", edge: "#C9D2E4",
      haze: "#2A2B5C", land: "#161B30", lights: 70, dirt: ["#46516F", "#6B7694", "#2C3550"] },
    coast: { name: "Северный берег", short: "БЕРЕГ", icon: "wave", song: 0,
      sky: { top: "#03060E", bottom: "#123264", curtain: 0.5, amount: 1, seed: 11 }, moon: [120, 36, 8],
      grass: ["#3A3830", "#34322B"], rumble: ["#C8304A", "#D8DEEA"], road: ["#363F5B", "#313A55"], lane: "#C9D2E4", edge: "#A9B4CA",
      haze: "#17305E", land: "#0E2145", water: ["#0E2853", "#0B2249"], foam: "#9FC0E6", lights: 10, dirt: ["#6E6450", "#4A4436", "#8A7E62"] },
    snow: { name: "Снежный перевал", short: "ПЕРЕВАЛ", icon: "snow", song: 1,
      sky: { top: "#040814", bottom: "#1C3570", curtain: 0.56, amount: 1, seed: 19 }, moon: [304, 38, 6],
      grass: ["#C4D0EA", "#B3C1E0"], rumble: ["#C8304A", "#EAF0FA"], road: ["#4A5573", "#444E6B"], lane: "#EAF0FA", edge: "#DCE3EE",
      haze: "#3A4E86", land: "#7F90BC", weather: "snow", lights: 8, dirt: ["#FFFFFF", "#DCE3EE", "#B3C1E0"] },
    lakes: { name: "Озёрный край", short: "ОЗЁРА", icon: "lake", song: 0,
      sky: { top: "#03070E", bottom: "#0F3146", curtain: 0.5, amount: 1, seed: 23 }, moon: [250, 34, 6],
      grass: ["#11403A", "#0E3631"], rumble: ["#C8304A", "#D8DEEA"], road: ["#353F5A", "#303953"], lane: "#C9D2E4", edge: "#A9B4CA",
      haze: "#123A50", land: "#0A2620", water: ["#0C3044", "#0A283A"], foam: "#7FBFC8", lights: 12, dirt: ["#11403A", "#2F7A52", "#4E3424"] },
    canyon: { name: "Каменная долина", short: "ДОЛИНА", icon: "mesa", song: 1,
      sky: { top: "#05040F", bottom: "#2E1F50", curtain: 0.5, amount: 0.95, seed: 29 }, moon: [92, 40, 7],
      grass: ["#4E2D36", "#45272F"], rumble: ["#FFD27A", "#3B2A40"], road: ["#3A3650", "#35314A"], lane: "#FFD27A", edge: "#C9B8C8",
      haze: "#3A2652", land: "#2A1A28", lights: 6, dirt: ["#6E3E44", "#9A5E58", "#4E2D36"] },
  };
  const SC_LIST = Object.keys(SCN);
  // the championship: track n is drawn in one of two sceneries, picked by the fork at the end of track n−1
  const STAGE_SC = [["forest"], ["city", "coast"], ["snow", "lakes"], ["canyon", "forest"], ["coast", "snow"], ["lakes", "city"], ["canyon", "snow"], ["city", "coast"]];
  const ROUTE_KEY = "road.route";
  const routeOf = (n) => { const r = WG.store.get(ROUTE_KEY, {}) || {}; return r[n] === 1 ? 1 : 0; };
  const sceneryOf = (n) => (n <= 1 ? STAGE_SC[0][0] : STAGE_SC[n - 1][routeOf(n)]);

  function palOf(sc) {
    if (sc.pal) return sc.pal;
    const lv = [];
    for (let l = 0; l <= 4; l++) {
      const k = l * 0.2;
      lv.push([0, 1].map((gp) => {
        const m = (c) => mix(c, sc.haze, k);
        return { grass: m(sc.grass[gp]), rumble: m(sc.rumble[gp]), road: m(sc.road[gp]), lane: m(sc.lane), edge: m(sc.edge),
          water: sc.water ? m(sc.water[gp]) : null, foam: sc.foam ? m(sc.foam) : null };
      }));
    }
    const lit = [0, 1].map((gp) => {
      const b = lv[0][gp], m = (c) => mix(c, "#FFE2A8", 0.2);
      return Object.assign({}, b, { grass: m(b.grass), road: m(b.road), rumble: m(b.rumble), lane: m(b.lane) });
    });
    return (sc.pal = { lv, lit });
  }

  // ---------- music: two tapes, one for the woods and the shore, one for the city, the snow and the canyon ----------
  const rep = (s, n) => Array(n).fill(s).join(" ");
  const SONGS = [
    { bpm: 148, ch: [
      { w: "p25", v: 0.11, sus: 0.55, notes: "A5 - - C6 - - E6 - D6 - C6 - A5 - G5 - B5 - - D6 - - G6 - - - F6 - E6 - D6 - E6 - - - B5 - - - D6 - E6 - G6 - E6 - C6 - - - - - - - A5 - B5 - C6 - E6 - A5 - - C6 - - E6 - D6 - C6 - E6 - F6 - G6 - - - D6 - - - B5 - D6 - G6 - A6 - G6 - - E6 - - D6 - E6 - - - B5 - D6 - C6 - - - - - - - . . . . G5 - B5 -" },
      { w: "p12", v: 0.045, sus: 0.4, notes: rep("A4 . C5 . E5 . C5 . A4 . C5 . E5 . C5 . B4 . D5 . F5 . D5 . B4 . D5 . F5 . D5 . G4 . B4 . D5 . B4 . G4 . B4 . D5 . B4 . A4 . C5 . E5 . C5 . A4 . C5 . E5 . C5 .", 2) },
      { w: "tri", v: 0.22, sus: 0.8, notes: rep("F2 . F3 . . F2 F3 . C3 . F3 . E3 . C3 . G2 . G3 . . G2 G3 . D3 . G3 . F3 . D3 . E2 . E3 . . E2 E3 . B2 . E3 . D3 . B2 . A2 . A3 . . A2 A3 . E3 . A3 . G3 . E3 .", 2) },
      { w: "noise", v: 0.2, notes: "k . h . s . h k . k h . s . h h" },
    ] },
    { bpm: 132, ch: [
      { w: "p50", v: 0.085, sus: 0.6, vib: 5, notes: "E5 - - - A5 - - - B5 - C6 - B5 - A5 - C6 - - - - - A5 - F5 - - - A5 - C6 - D6 - - - B5 - - - G5 - - - B5 - D6 - E6 - - - - - - - D6 - C6 - B5 - G5 - A5 - - - E6 - - - D6 - C6 - D6 - E6 - F6 - - - E6 - - - C6 - - - A5 - - - B5 - - - D6 - - - G6 - - - F6 - D6 - E6 - - - - - - - - - - - . . . ." },
      { w: "p12", v: 0.045, sus: 0.4, notes: rep("A4 . C5 . E5 . C5 . A4 . C5 . E5 . C5 . A4 . C5 . F5 . C5 . A4 . C5 . F5 . C5 . B4 . D5 . G5 . D5 . B4 . D5 . G5 . D5 . B4 . E5 . G#5 . E5 . B4 . E5 . G#5 . E5 .", 2) },
      { w: "tri", v: 0.23, sus: 0.8, notes: rep("A2 . . A2 A3 . A2 . . A2 . G2 . E2 G2 . F2 . . F2 F3 . F2 . . F2 . E2 . C2 E2 . G2 . . G2 G3 . G2 . . G2 . F2 . D2 F2 . E2 . . E2 E3 . E2 . . E2 . D2 . B1 D2 .", 2) },
      { w: "noise", v: 0.2, notes: "k . h . s . h . k k h . s . h o" },
    ] },
  ];
  Object.assign(WG.SFX, {
    road_check: [{ w: "p25", f: "E6", d: 0.06, v: 0.18 }, { w: "p25", f: "A6", t: 0.07, d: 0.06, v: 0.18 }, { w: "p25", f: "C#7", t: 0.14, d: 0.22, v: 0.18, sus: 0.5, r: 0.1 }, { w: "tri", f: "A4", t: 0.14, d: 0.22, v: 0.25 }],
    road_crash: [{ w: "noise", f: 1200, f2: 80, d: 0.5, v: 0.38, sus: 0.5, r: 0.2 }, { w: "p50", f: 200, f2: 60, d: 0.35, v: 0.2 }, { w: "noise", f: 4000, d: 0.08, v: 0.2, hp: 2000 }],
    road_bump: [{ w: "noise", f: 1500, d: 0.07, v: 0.28, sus: 0.3 }, { w: "p50", f: 180, f2: 90, d: 0.08, v: 0.16 }],
    road_scrape: [{ w: "noise", f: 5000, d: 0.06, v: 0.1, hp: 2500 }],
    road_skid: [{ w: "noise", f: 2600, f2: 2000, d: 0.14, v: 0.05, hp: 1400, sus: 0.6 }],
    road_pass: [{ w: "p25", f: "C6", d: 0.04, v: 0.12 }, { w: "p25", f: "G6", t: 0.05, d: 0.07, v: 0.12 }],
    road_shift: [{ w: "p12", f: 320, f2: 160, d: 0.05, v: 0.05 }],
    road_pop: [{ w: "noise", f: 700, f2: 200, d: 0.06, v: 0.12 }],
    road_beep: [{ w: "p50", f: "A5", d: 0.05, v: 0.1 }],
    road_fire: [{ w: "noise", f: 300, f2: 2000, d: 0.25, v: 0.06, hp: 800 }, { w: "noise", f: 3000, f2: 400, t: 0.25, d: 0.35, v: 0.1 }],
  });

  // ---------- the engine hum: one oscillator pair that follows the revs (the engine's tone() only plays notes) ----------
  function Hum() {
    const SND = WG.sound;
    let osc = null, osc2 = null, gain = null, lp = null;
    return {
      start() {
        if (osc || SND.muted) return;
        try {
          const a = SND.ensure();
          if (!a || !SND.sfxBus) return;
          gain = a.createGain(); gain.gain.value = 0;
          lp = a.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 800;
          osc = a.createOscillator(); osc.type = "sawtooth"; osc.frequency.value = 60;
          osc2 = a.createOscillator(); if (SND.waves.p25) osc2.setPeriodicWave(SND.waves.p25); osc2.frequency.value = 30;
          osc.connect(lp); osc2.connect(lp); lp.connect(gain); gain.connect(SND.sfxBus);
          osc.start(); osc2.start();
        } catch (e) { osc = osc2 = null; }
      },
      set(rpm, load, on) {
        if (!osc) { if (on && !SND.muted) this.start(); if (!osc) return; }
        const t = SND.ac.currentTime, f = 46 + rpm * 118;
        osc.frequency.setTargetAtTime(f, t, 0.04); osc2.frequency.setTargetAtTime(f * 0.5, t, 0.04);
        lp.frequency.setTargetAtTime(380 + rpm * 1300 + load * 300, t, 0.05);
        gain.gain.setTargetAtTime(on ? 0.035 + 0.035 * load : 0, t, 0.06);
      },
      stop() {
        if (!osc) return;
        try { const t = SND.ac.currentTime; gain.gain.setTargetAtTime(0, t, 0.03); osc.stop(t + 0.25); osc2.stop(t + 0.25); } catch (e) { /* gone */ }
        osc = osc2 = null;
      },
    };
  }

  // ---------- touch: left half steers left, right half right, both together brake ----------
  function TouchPad() {
    const E = WG.runner && WG.runner.el;
    const pts = new Map();
    if (!E) return { left: false, right: false, clear() {}, off() {} };
    const side = (e) => { const r = E.canvas.getBoundingClientRect(); return e.clientX < r.left + r.width / 2 ? -1 : 1; };
    const down = (e) => {
      if (e.target && e.target.closest && e.target.closest(".abtn, .dpad, .pbtn, .pbar, .ov")) return;
      pts.set(e.pointerId, side(e));
    };
    const move = (e) => { if (pts.has(e.pointerId)) pts.set(e.pointerId, side(e)); };
    const up = (e) => { pts.delete(e.pointerId); };
    E.root.addEventListener("pointerdown", down);
    E.root.addEventListener("pointermove", move);
    E.root.addEventListener("pointerup", up);
    E.root.addEventListener("pointercancel", up);
    return {
      get left() { for (const v of pts.values()) if (v < 0) return true; return false; },
      get right() { for (const v of pts.values()) if (v > 0) return true; return false; },
      clear() { pts.clear(); },
      off() {
        E.root.removeEventListener("pointerdown", down); E.root.removeEventListener("pointermove", move);
        E.root.removeEventListener("pointerup", up); E.root.removeEventListener("pointercancel", up);
      },
    };
  }

  // ---------- roadside sprites, painted once ----------
  let LIB = null;
  const ICON_ROWS = {
    pine: ["....w....", "...www...", "..wwwww..", "...www...", ".wwwwwww.", "wwwwwwwww", "....w....", "....w...."],
    city: ["..www.....", "..wyw.www.", "wwwww.wyw.", "wywyw.www.", "wwwww.wyw.", "wywwwwwww.", "wwwwwwwww."],
    wave: [".ww....ww..", "w..w..w..w.", "....ww....w", ".ww....ww..", "w..w..w..w.", "....ww....w"],
    snow: ["....w....", ".w..w..w.", "..w.w.w..", "...www...", "wwwwwwwww", "...www...", "..w.w.w..", ".w..w..w.", "....w...."],
    lake: ["..w.......", ".www......", "wwwww.....", "..w.......", "..w.......", "wwwwwwwwww", ".w.w.w.w.w"],
    mesa: ["...wwww....", "..wwwwww...", "..wwwwwww..", ".wwwwwwwww.", "wwwwwwwwwww", "wwwwwwwwwww"],
  };
  function lamp() {
    const { c, r } = KIT.pen(20, 64);
    r(2, 6, 2, 52, "#46516F"); r(2, 6, 1, 52, "#7782A2");
    r(0, 57, 6, 7, "#2C3550"); r(0, 57, 6, 1, "#46516F");
    r(3, 4, 11, 2, "#46516F"); r(3, 4, 11, 1, "#7782A2"); r(4, 6, 2, 2, "#46516F");
    r(12, 3, 8, 4, "#2C3550"); r(12, 3, 8, 1, "#46516F");
    r(13, 7, 6, 1, "#FFF0C2"); r(14, 7, 4, 1, "#FFFFFF");
    return { img: KIT.outline(c, "#05070D"), glow: [17, 9] };
  }
  function chevron() {
    const { c, r } = KIT.pen(16, 24);
    r(7, 12, 2, 12, "#6B7694"); r(7, 12, 1, 12, "#9AA5C0");
    r(0, 0, 16, 12, "#1B2133"); r(1, 1, 14, 10, "#FFD27A"); r(1, 1, 14, 1, "#FFF0C2"); r(1, 10, 14, 1, "#C98A1B");
    for (const x0 of [3, 8]) for (let y = 2; y <= 9; y++) r(x0 + (y <= 5 ? y - 2 : 9 - y), y, 2, 1, "#1B2133");
    return KIT.outline(c, "#05070D");
  }
  function post() {
    const { c, r } = KIT.pen(4, 18);
    r(0, 0, 4, 18, "#DCE3EE"); r(0, 0, 1, 18, "#FFFFFF"); r(3, 0, 1, 18, "#A9B6CD");
    r(0, 3, 4, 4, "#1B2133"); r(1, 4, 2, 2, "#FF4D63"); r(0, 16, 4, 2, "#6B7694");
    return KIT.outline(c, "#05070D");
  }
  function billboard(lines, bg, ink) {
    const { c, r, g } = KIT.pen(64, 48);
    r(14, 30, 3, 18, "#46516F"); r(14, 30, 1, 18, "#7782A2"); r(47, 30, 3, 18, "#46516F"); r(47, 30, 1, 18, "#7782A2");
    r(0, 0, 64, 32, "#0E1424"); r(1, 1, 62, 30, bg); r(1, 1, 62, 1, mix(bg, "#FFFFFF", 0.25));
    WG.text(g, lines[0], 32, 6, { align: "center", color: ink, shadow: "#05070D" });
    WG.text(g, lines[1], 32, 18, { align: "center", color: "#EAF0FA", shadow: "#05070D" });
    r(4, 32, 56, 2, "#2C3550"); r(10, 34, 3, 1, "#FFD27A"); r(51, 34, 3, 1, "#FFD27A");
    return KIT.outline(c, "#05070D");
  }
  function cabin(snow) {
    const { c, r } = KIT.pen(46, 36);
    r(5, 16, 36, 20, "#4E3424");
    for (let y = 17; y < 36; y += 3) { r(5, y, 36, 1, "#3A2618"); r(5, y + 1, 36, 1, "#7A5236"); }
    r(30, 2, 5, 9, "#46516F"); r(30, 2, 5, 1, "#6B7694");
    for (let y = 0; y < 16; y++) { const hw = 3 + y * 1.45; r(Math.round(23 - hw), y + 1, Math.round(hw * 2), 1, y < 3 && snow ? "#EAF0FA" : y % 4 === 3 ? "#1B2133" : "#2C3550"); }
    if (snow) { r(3, 14, 40, 3, "#EAF0FA"); r(3, 16, 40, 1, "#A9B9D8"); }
    r(11, 21, 10, 8, "#1B2133"); r(12, 22, 8, 6, "#FFD27A"); r(12, 22, 4, 2, "#FFF0C2"); r(15, 22, 1, 6, "#C98A1B"); r(12, 24, 8, 1, "#C98A1B");
    r(27, 21, 8, 15, "#24170F"); r(28, 22, 6, 14, "#4E3424"); r(32, 29, 1, 1, "#FFD27A");
    return KIT.outline(c, "#05070D");
  }
  function building(w, h, seed) {
    const { c, r } = KIT.pen(w, h);
    const rnd = WG.rng(seed * 31 + 7);
    const base = ["#1A2340", "#171F3A", "#1E2848", "#151C34", "#1C2242"][seed % 5];
    r(0, 4, w, h - 4, base); r(0, 4, 1, h - 4, "#2A3658"); r(w - 1, 4, 1, h - 4, "#0E1426");
    r(0, 3, w, 2, "#26324F"); r(Math.round(w * 0.25), 0, 7, 3, "#1B2133"); r(w - 5, 0, 1, 3, "#46516F");
    if (seed % 2) r(w - 5, 0, 1, 1, "#FF4D63");
    const lit = ["#FFD27A", "#FFB86B", "#FFF0C2", "#7FE6F4", "#FFD27A"];
    for (let y = 8; y < h - 17; y += 6) for (let x = 3; x < w - 4; x += 5) {
      if (rnd() < 0.36) { const col = lit[Math.floor(rnd() * lit.length)]; r(x, y, 3, 3, col); r(x, y + 2, 3, 1, mix(col, "#000000", 0.25)); }
      else { r(x, y, 3, 3, "#252F4F"); r(x, y, 3, 1, "#2E3A5E"); }
    }
    r(1, h - 14, w - 2, 3, seed % 3 === 0 ? "#22B8CF" : seed % 3 === 1 ? "#FF6B7A" : "#8B7CF6");
    r(2, h - 10, w - 4, 8, "#FFD27A"); r(2, h - 10, w - 4, 2, "#FFF0C2");
    for (let x = 6; x < w - 3; x += 7) r(x, h - 10, 1, 8, "#6B4A0A");
    r(0, h - 2, w, 2, "#0E1426");
    return KIT.outline(c, "#05070D");
  }
  function pillar(w, h, seed) {
    const { c, r } = KIT.pen(w, h);
    for (let y = 0; y < h; y++) {
      const t = y / h, hw = (w / 2) * (0.5 + 0.38 * t + 0.1 * Math.sin(y * 0.33 + seed * 2));
      const x0 = Math.round(w / 2 - hw), x1 = Math.round(w / 2 + hw);
      const band = Math.floor(y / 5 + seed) % 2 ? "#9A5E58" : "#8A5250";
      for (let x = x0; x < x1; x++) { const rel = (x - x0) / Math.max(1, x1 - x0); r(x, y, 1, 1, rel < 0.28 ? "#C98A7A" : rel > 0.72 ? "#5A3240" : band); }
    }
    r(Math.round(w * 0.2), 0, Math.round(w * 0.6), 1, "#E0A890");
    return KIT.outline(c, "#1A0E16");
  }
  function reeds(seed) {
    const { c, r } = KIT.pen(18, 16);
    const rnd = WG.rng(seed * 3 + 1);
    for (let i = 0; i < 10; i++) {
      const x = 1 + Math.floor(rnd() * 16), hh = 6 + Math.floor(rnd() * 9);
      r(x, 16 - hh, 1, hh, rnd() < 0.5 ? "#2F6E52" : "#5FA383");
      if (rnd() < 0.5) r(x, 16 - hh - 2, 1, 3, "#7A5236");
    }
    return KIT.outline(c, "#04100C");
  }
  function bush(seed) {
    const { c, r } = KIT.pen(24, 13);
    const rnd = WG.rng(seed * 5 + 2);
    for (let y = 0; y < 13; y++) for (let x = 0; x < 24; x++) {
      const dx = (x - 11.5) / 12, dy = (13 - y) / 13;
      if (dx * dx + dy * dy > 0.92 + 0.1 * Math.sin(x * 1.3 + seed)) continue;
      const sh = -dx * 0.5 + dy * 0.8 + (rnd() - 0.5) * 0.5;
      r(x, y, 1, 1, sh > 0.7 ? "#2F7A52" : sh > 0.35 ? "#1F5A3E" : sh > 0 ? "#14452F" : "#0E3326");
    }
    return KIT.outline(c, "#04100C");
  }
  function barrier() {
    const { c, r } = KIT.pen(24, 16);
    r(3, 8, 2, 8, "#6B7694"); r(19, 8, 2, 8, "#6B7694");
    for (let y = 0; y < 9; y++) for (let x = 0; x < 24; x++) r(x, y, 1, 1, ((x + y) >> 2) % 2 ? "#FFD27A" : "#1B2133");
    r(0, 0, 24, 1, "#FFF0C2");
    return KIT.outline(c, "#05070D");
  }
  function glowCanvas(rgb, n) {
    const { c, r } = KIT.pen(n, n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
      if (d >= 1) continue;
      const a = Math.pow(1 - d, 1.5);
      if (BAYER4[(y & 3) * 4 + (x & 3)] < a * 0.95) r(x, y, 1, 1, "rgba(" + rgb + "," + (0.18 + a * 0.45).toFixed(2) + ")");
    }
    return c;
  }
  function arrow(r, x, y, dir) {
    for (let i = 0; i < 5; i++) r(dir < 0 ? x + i : x - i, y + 4 - i, 1, 2 * i + 1, "#FFFFFF");
    r(dir < 0 ? x + 5 : x - 12, y + 3, 8, 3, "#FFFFFF");
  }
  const SIGNS = {};
  function forkSign(a, b) {
    const key = a + "|" + b;
    if (SIGNS[key]) return SIGNS[key];
    const { c, r, g } = KIT.pen(132, 62);
    for (const x of [22, 106]) { r(x, 36, 4, 26, "#6B7694"); r(x, 36, 1, 26, "#9AA5C0"); }
    r(0, 0, 132, 38, "#E3EBF8"); r(2, 2, 128, 34, "#14507E"); r(2, 2, 128, 1, "#2A6FA6"); r(65, 4, 2, 30, "#E3EBF8");
    arrow(r, 6, 7, -1); WG.text(g, SCN[a].short, 22, 8, { color: "#FFFFFF" });
    arrow(r, 125, 7, 1); WG.text(g, SCN[b].short, 109, 8, { color: "#FFFFFF", align: "right" });
    const ic = (n) => WG.sprite(ICON_ROWS[n], { w: "#FFFFFF", y: "#FFD27A" });
    const ia = ic(SCN[a].icon), ib = ic(SCN[b].icon);
    g.drawImage(ia, 33 - (ia.width >> 1), 21); g.drawImage(ib, 99 - (ib.width >> 1), 21);
    return (SIGNS[key] = KIT.outline(c, "#05070D"));
  }
  function sideSign(name, dir) {
    const key = "side|" + name + "|" + dir;
    if (SIGNS[key]) return SIGNS[key];
    const { c, r, g } = KIT.pen(70, 52);
    r(dir < 0 ? 54 : 12, 30, 4, 22, "#6B7694"); r(dir < 0 ? 54 : 12, 30, 1, 22, "#9AA5C0");
    r(0, 0, 70, 32, "#E3EBF8"); r(2, 2, 66, 28, "#14507E"); r(2, 2, 66, 1, "#2A6FA6");
    if (dir < 0) { arrow(r, 6, 5, -1); WG.text(g, SCN[name].short, 22, 6, { color: "#FFFFFF" }); }
    else { arrow(r, 63, 5, 1); WG.text(g, SCN[name].short, 48, 6, { color: "#FFFFFF", align: "right" }); }
    const ic = WG.sprite(ICON_ROWS[SCN[name].icon], { w: "#FFFFFF", y: "#FFD27A" });
    g.drawImage(ic, 35 - (ic.width >> 1), 18);
    return (SIGNS[key] = KIT.outline(c, "#05070D"));
  }
  function buildLib() {
    const L = {};
    L.pine = [KIT.pine(36, { seed: 3 }), KIT.pine(48, { seed: 8 }), KIT.pine(62, { seed: 12 })];
    L.pineSnow = [KIT.pine(36, { seed: 4, snow: true }), KIT.pine(48, { seed: 9, snow: true }), KIT.pine(62, { seed: 13, snow: true })];
    L.birch = [KIT.birch(44, 3), KIT.birch(54, 7), KIT.birch(38, 11)];
    L.rock = [KIT.rock(22, 13, { seed: 1, moss: true }), KIT.rock(30, 18, { seed: 2 }), KIT.rock(16, 10, { seed: 3 })];
    L.rockSnow = [KIT.rock(24, 14, { seed: 4, snow: true }), KIT.rock(32, 19, { seed: 5, snow: true })];
    const RED = ["#C98A7A", "#9A5E58", "#6E3E44", "#43242E"];
    L.rockRed = [KIT.rock(28, 18, { seed: 6, ramp: RED }), KIT.rock(40, 24, { seed: 7, ramp: RED }), KIT.rock(18, 11, { seed: 8, ramp: RED })];
    L.pillar = [pillar(22, 60, 1), pillar(18, 46, 2), pillar(26, 72, 3)];
    L.lamp = lamp();
    L.lampL = { img: WG.flipX(L.lamp.img), glow: [L.lamp.img.width - L.lamp.glow[0], L.lamp.glow[1]] };
    L.chevR = chevron(); L.chevL = WG.flipX(L.chevR);
    L.post = post();
    L.board = [billboard(["ДОБРОЙ", "ДОРОГИ!"], "#123A31", "#8EF0C6"), billboard(["ГОРЯЧИЙ", "ЧАЙ 24 Ч"], "#3A1420", "#FFD27A"), billboard(["ОГНИ", "СЕВЕРА"], "#21194A", "#C4BBFF")];
    L.cabin = cabin(false); L.cabinSnow = cabin(true);
    L.bldg = [building(34, 92, 1), building(42, 70, 2), building(30, 110, 3), building(46, 84, 4), building(38, 64, 5), building(36, 100, 6)];
    L.snowman = WG.sprite(["....kkk....", "....kkk....", "...kkkkk...", "...wwwww...", "..wwkwkww..", "..wwwaaaa..", "...wwwww...", "..rrrrrrr..", ".wwwwwrwww.", "wwwwwwrwwww", "wwwkwwwwwws", "wwwwwwwwwws", ".wwwkwwwws.", "..wwwwwss..", ".wwwwwwwww.", "wwwwwwwwwws", "wwwwwwwwwws", "wwwwwwwwwss", ".wwwwwwwss.", "..sssssss.."],
      { k: "#1B2133", w: "#EAF0FA", s: "#A9B9D8", a: "#E0A53A", r: "#D93644" }, { outline: "#2C3550" });
    L.cairn = WG.sprite(["....ss....", "...sSSs...", "....dd....", "..ssSSss..", ".sSSSSSds.", "..dddddd..", ".ssSSSSss.", "sSSSSSSSds", "sSSSSSSdds", ".dddddddd."],
      { s: "#9A5E58", S: "#C98A7A", d: "#5A3640" }, { outline: "#1A0E16" });
    L.reeds = [reeds(1), reeds(2)];
    L.bush = [bush(1), bush(2)];
    L.barrier = barrier();
    L.glow = glowCanvas("255,214,140", 32);
    L.glowRed = glowCanvas("255,60,90", 16);
    L.txt = {
      start: WG.textCanvas("СТАРТ", { color: "#FFFFFF" }), check: WG.textCanvas("КОНТРОЛЬ", { color: "#FFD27A" }),
      finish: WG.textCanvas("ФИНИШ", { color: "#FFFFFF" }), final: WG.textCanvas("ФИНАЛ", { color: "#FFD27A" }),
    };
    return L;
  }

  // ---------- backgrounds: sky, far range, near range, each tiling sideways ----------
  const TW = 768;
  function ridge(g, w, base, h, color, seed, rough) {
    const rnd = WG.rng(seed);
    const ks = [2, 3, 5, 8, 13, 21].map((k, i) => ({ k, a: (0.18 + rnd() * 0.22) / Math.pow(i + 1, rough || 0.9), p: rnd() * 6.283 }));
    g.fillStyle = color;
    for (let x = 0; x < w; x++) {
      let v = 0.5;
      for (const q of ks) v += q.a * Math.sin((6.283 * q.k * x) / w + q.p);
      const top = Math.round(base - h * clamp(v, 0.05, 1));
      g.fillRect(x, top, 1, base - top + 64);
    }
  }
  function treeRow(g, w, y, color, seed, minH, maxH, gap, tip) {
    const rnd = WG.rng(seed);
    let px = 2;
    while (px < w) {
      const h = Math.round(minH + rnd() * (maxH - minH));
      for (const ox of [0, -w, w]) {
        const X = px + ox;
        if (X < -10 || X > w + 10) continue;
        for (let j = 0; j < h; j++) {
          let half = Math.round((j / h) * h * 0.3 + (j % 3 === 2 ? 1 : 0));
          if (j < 2) half = 0;
          g.fillStyle = color; g.fillRect(X - half, y - h + j, half * 2 + 1, 1);
          if (tip && j % 3 === 0 && j > 1) { g.fillStyle = tip; g.fillRect(X - half, y - h + j, Math.max(1, half), 1); }
        }
        g.fillStyle = color; g.fillRect(X, y, 1, 2);
      }
      px += Math.round(gap + rnd() * gap);
    }
  }
  function skyline(g, w, base, minH, maxH, minW, maxW, color, lit, seed, winW) {
    const rnd = WG.rng(seed);
    let x = 0;
    while (x < w) {
      const bw = Math.round(minW + rnd() * (maxW - minW)), bh = Math.round(minH + rnd() * (maxH - minH));
      g.fillStyle = color; g.fillRect(x, base - bh, Math.min(bw, w - x), bh + 2);
      if (rnd() < 0.3) g.fillRect(x + (bw >> 1), base - bh - 3, 1, 3);
      for (let yy = base - bh + 2; yy < base - 1; yy += winW + 2) for (let xx = x + 1; xx < Math.min(x + bw - 1, w); xx += winW + 1) {
        if (rnd() < lit) { const q = rnd(); g.fillStyle = q < 0.55 ? "#FFD27A" : q < 0.75 ? "#FFF0C2" : q < 0.9 ? "#7FE6F4" : "#FFB86B"; g.fillRect(xx, yy, winW, winW === 1 ? 1 : 2); }
      }
      x += bw + (rnd() < 0.3 ? 1 : 0);
    }
  }
  function peaks(g, w, base, seed) {
    const rnd = WG.rng(seed);
    const list = [];
    for (let i = 0; i < 9; i++) list.push({ x: (i / 9) * w + rnd() * 40, h: 26 + rnd() * 30, s: 0.7 + rnd() * 0.5 });
    list.sort((a, b) => b.h - a.h);
    for (const p of list) for (const ox of [0, -w, w]) {
      const cx = p.x + ox, hw = p.h / p.s;
      for (let x = Math.max(0, Math.floor(cx - hw)); x < Math.min(w, Math.ceil(cx + hw)); x++) {
        const top = Math.round(base - p.h + Math.abs(x - cx) * p.s);
        const left = x < cx;
        for (let y = top; y < base + 1; y++) {
          const snow = y < top + 3 + p.h * 0.28 + ((x * 7) % 5 === 0 ? 2 : 0);
          g.fillStyle = snow ? (left ? "#D7E2F5" : "#8FA2CC") : left ? "#26386E" : "#1C2B58";
          g.fillRect(x, y, 1, 1);
        }
      }
    }
  }
  function mesas(g, w, base, seed, body, rim, strata) {
    const rnd = WG.rng(seed);
    let x = 0;
    while (x < w) {
      const mw = 40 + Math.round(rnd() * 90), mh = 12 + Math.round(rnd() * 26), slope = 3 + Math.round(rnd() * 5);
      for (let i = 0; i < mw + slope * 2 && x + i < w; i++) {
        const t = i < slope ? i / slope : i > mw + slope ? (mw + 2 * slope - i) / slope : 1;
        const top = Math.round(base - mh * t);
        g.fillStyle = body; g.fillRect(x + i, top, 1, base - top + 2);
        g.fillStyle = rim; g.fillRect(x + i, top, 1, 1);
        g.fillStyle = strata; for (let yy = top + 4; yy < base; yy += 5) if ((x + i + yy) % 9) g.fillRect(x + i, yy, 1, 1);
      }
      x += mw + slope + Math.round(rnd() * 30);
    }
  }
  const BG = {};
  function bgOf(name) {
    if (BG[name]) return BG[name];
    const far = KIT.pen(TW, 64), near = KIT.pen(TW, 44);
    const extra = {};
    if (name === "forest") {
      ridge(far.g, TW, 63, 46, "#2E4785", 3); ridge(far.g, TW, 64, 46, "#1A2B5C", 3);
      ridge(far.g, TW, 63, 22, "#22356C", 8, 0.7); ridge(far.g, TW, 64, 22, "#14224A", 8, 0.7);
      ridge(near.g, TW, 44, 8, "#0B1830", 23, 1.2);
      treeRow(near.g, TW, 42, "#0B1830", 31, 8, 22, 4);
    } else if (name === "city") {
      ridge(far.g, TW, 64, 14, "#1A2350", 5, 1.2);
      skyline(far.g, TW, 64, 8, 36, 8, 24, "#18234A", 0.22, 41, 1);
      far.r(500, 6, 3, 58, "#18234A"); far.r(498, 18, 7, 4, "#18234A"); far.r(501, 3, 1, 3, "#18234A"); extra.tower = [501, 3];
      skyline(near.g, TW, 44, 12, 40, 14, 38, "#0E1631", 0.32, 47, 2);
      for (let i = 0; i < 14; i++) { const x = (i * 131) % TW, y = 20 + ((i * 37) % 16); near.r(x, y, 10 + (i % 3) * 4, 2, ["#22B8CF", "#FF6B7A", "#8B7CF6", "#FFD27A"][i % 4]); }
    } else if (name === "coast") {
      ridge(far.g, TW, 49, 30, "#2E4785", 11); ridge(far.g, TW, 50, 30, "#1A2B5C", 11);
      for (let y = 50; y < 64; y++) { far.r(0, y, TW, 1, y % 3 ? "#0D2146" : "#10295A"); }
      const rr = WG.rng(5);
      for (let i = 0; i < 160; i++) far.r(Math.floor(rr() * TW), 51 + Math.floor(rr() * 13), 2 + Math.floor(rr() * 5), 1, "#1B3A70");
      // a cape with a lighthouse
      for (let x = 430; x < 640; x++) { const t = (x - 430) / 210, top = Math.round(44 - 14 * Math.sin(t * Math.PI) * (0.8 + 0.2 * Math.sin(x * 0.2))); near.r(x, top, 1, 44 - top, "#0B1530"); }
      near.r(556, 10, 6, 21, "#EAF0FA"); for (let y = 13; y < 31; y += 6) near.r(556, y, 6, 3, "#D93644");
      near.r(555, 6, 8, 4, "#2C3550"); near.r(557, 7, 4, 2, "#FFF0C2"); near.r(554, 5, 10, 1, "#46516F");
      extra.lighthouse = [559, 8];
    } else if (name === "snow") {
      peaks(far.g, TW, 64, 19);
      ridge(near.g, TW, 44, 6, "#7F90BC", 27, 1.2);
      treeRow(near.g, TW, 41, "#13213F", 37, 7, 18, 5, "#C9D6F2");
    } else if (name === "lakes") {
      ridge(far.g, TW, 55, 22, "#22406A", 23); ridge(far.g, TW, 56, 22, "#163055", 23);
      for (let y = 56; y < 64; y++) far.r(0, y, TW, 1, y % 2 ? "#0B2A3C" : "#0D3044");
      treeRow(near.g, TW, 42, "#0D2630", 43, 10, 20, 7);
      const rr = WG.rng(9);
      for (let i = 0; i < 70; i++) near.r(Math.floor(rr() * TW), 30 + Math.floor(rr() * 12), 1, 3 + Math.floor(rr() * 6), "#C9D2E4");
      ridge(near.g, TW, 44, 4, "#0A2620", 29, 1.2);
      extra.lake = true;
    } else {
      mesas(far.g, TW, 64, 29, "#3A2550", "#6A4580", "#33204A");
      mesas(near.g, TW, 44, 31, "#24162F", "#4A2E58", "#1E1228");
    }
    const sc = SCN[name], rr = WG.rng(sc.sky.seed * 7);
    const lights = [];
    for (let i = 0; i < sc.lights; i++) {
      const q = rr();
      lights.push({ x: Math.floor(rr() * TW), y: HOR - 1 + Math.floor(rr() * 3), c: q < 0.6 ? "#FFD27A" : q < 0.85 ? "#FFF0C2" : "#7FE6F4", p: rr() * 6.28 });
    }
    return (BG[name] = { far: far.c, near: near.c, extra, lights });
  }
  const wrapX = (x, speed, camX) => { let o = -Math.round(camX * speed) % TW; if (o > 0) o -= TW; return o + x; };
  function drawBg(g, name, t, camX) {
    const sc = SCN[name], B = bgOf(name);
    art.sky(g, 0, 0, W, HOR + 2, t, { seed: sc.sky.seed, top: sc.sky.top, bottom: sc.sky.bottom, curtain: sc.sky.curtain, amount: sc.sky.amount });
    if (sc.moon) {
      const mx = sc.moon[0] - ((camX * 0.05) % 60);
      art.moon(g, Math.round(mx), sc.moon[1], sc.moon[2]);
    }
    for (let k = 0; k < 2; k++) {
      const img = k ? B.near : B.far, speed = k ? 0.6 : 0.25, y = k ? HOR + 1 - 44 : HOR + 1 - 64;
      let ox = -Math.round(camX * speed) % TW;
      if (ox > 0) ox -= TW;
      for (let x = ox; x < W; x += TW) g.drawImage(img, x, y);
      if (k === 0) {
        // the far towns' lights along the horizon
        for (const L of B.lights) {
          const x = ((L.x - Math.round(camX * 0.25)) % TW + TW) % TW;
          if (x >= W) continue;
          if (Math.sin(t * 2.3 + L.p) < -0.6) continue;
          g.fillStyle = L.c; g.fillRect(x, L.y, 1, 1);
        }
        if (B.extra.tower) {
          const x = wrapX(B.extra.tower[0], 0.25, camX);
          for (const xx of [x, x + TW]) if (xx >= 0 && xx < W && Math.sin(t * 4) > 0) { g.fillStyle = "#FF4D63"; g.fillRect(xx, HOR + 1 - 64 + B.extra.tower[1], 1, 1); g.fillStyle = "rgba(255,77,99,.35)"; g.fillRect(xx - 1, HOR - 64 + B.extra.tower[1], 3, 3); }
        }
        if (name === "coast") {
          // moonlight on the sea
          const mx = Math.round(sc.moon[0] - ((camX * 0.05) % 60));
          for (let y = HOR - 13; y < HOR + 1; y++) {
            const w = 2 + Math.round((y - (HOR - 14)) * 0.6), s = Math.sin(t * 5 + y * 1.7);
            if (s > 0.2) { g.fillStyle = s > 0.75 ? "#EAF0FA" : "#8FA2CC"; g.fillRect(mx - (w >> 1) + Math.round(Math.sin(t * 3 + y) * 2), y, w, 1); }
          }
        }
        if (B.extra.lake) {
          // the aurora mirrored in the lake: the sky upside down, squeezed into the water's band
          g.save();
          g.beginPath(); g.rect(0, HOR - 7, W, 8); g.clip();
          g.globalAlpha *= 0.45;
          g.translate(0, HOR + 1); g.scale(1, -0.16);
          art.sky(g, 0, 0, W, HOR + 2, t, { seed: sc.sky.seed, top: sc.sky.top, bottom: sc.sky.bottom, curtain: sc.sky.curtain, amount: sc.sky.amount });
          g.restore();
          g.fillStyle = "#22406A"; g.fillRect(0, HOR - 8, W, 1);
        }
      }
      if (k === 1 && B.extra.lighthouse) {
        const lx = wrapX(B.extra.lighthouse[0], 0.6, camX), ly = HOR + 1 - 44 + B.extra.lighthouse[1];
        for (const X of [lx, lx + TW]) {
          if (X < -150 || X > W + 150) continue;
          const a = Math.sin(t * 1.3), len = Math.round(150 * Math.abs(a)), dir = a < 0 ? -1 : 1;
          for (let i = 3; i < len; i += 1) {
            const hh = 1 + Math.floor(i * 0.05);
            g.fillStyle = "rgba(255,240,194," + (0.22 * (1 - i / (len + 1))).toFixed(3) + ")";
            g.fillRect(X + dir * i, ly - (hh >> 1), 1, hh);
          }
          if (Math.abs(a) < 0.25) { g.fillStyle = "rgba(255,240,194,.6)"; g.fillRect(X - 2, ly - 2, 5, 5); }
          g.fillStyle = "#FFF0C2"; g.fillRect(X - 1, ly - 1, 3, 2);
        }
      }
    }
  }

  // ---------- the track: segments with curve, height and one or two road strips ----------
  const MAIN = [{ id: "M", c: 0, hw: 1, c2: 0, hw2: 1 }];
  class Track {
    constructor() { this.segs = []; this.base = 0; }
    get(i) { return this.segs[i - this.base]; }
    get end() { return this.base + this.segs.length; }
    lastY() { return this.segs.length ? this.segs[this.segs.length - 1].y2 : 0; }
    add(curve, y, sc) {
      const s = { i: this.end, y1: this.lastY(), y2: y, curve, roads: MAIN, sprites: null, sc, lit: 0, gate: null, water: 0, zone: null, fork: null };
      this.segs.push(s);
      return s;
    }
    road(enter, hold, leave, curve, hill, sc) {
      const y0 = this.lastY(), y1 = y0 + hill * SEG, total = enter + hold + leave;
      for (let n = 0; n < enter; n++) this.add(easeIn(0, curve, n / enter), easeInOut(y0, y1, (n + 1) / total), sc);
      for (let n = 0; n < hold; n++) this.add(curve, easeInOut(y0, y1, (enter + n + 1) / total), sc);
      for (let n = 0; n < leave; n++) this.add(easeInOut(curve, 0, n / leave), easeInOut(y0, y1, (enter + hold + n + 1) / total), sc);
    }
    prune(keepFrom) { const n = keepFrom - this.base; if (n > 0) { this.segs.splice(0, n); this.base += n; } }
  }
  function sections(T, rnd, target, diff, sc) {
    const stop = T.end + target;
    const sgn = () => (rnd() < 0.5 ? -1 : 1);
    const hill = () => Math.round((rnd() * 2 - 1) * (10 + 32 * diff));
    const cmag = () => 2.3 + 2.2 * diff + rnd() * 1.3;
    while (T.end < stop) {
      const left = stop - T.end, r = rnd();
      if (left < 90) { T.road(10, Math.max(4, left - 20), 10, 0, 0, sc); break; }
      if (r < 0.15) T.road(15, 20 + Math.floor(rnd() * 40), 15, 0, hill(), sc);
      else if (r < 0.45) T.road(18 + Math.floor(rnd() * 12), 25 + Math.floor(rnd() * 45), 18 + Math.floor(rnd() * 12), sgn() * cmag(), hill(), sc);
      else if (r < 0.6) { const c = sgn() * cmag() * 0.9; T.road(15, 22, 15, c, 0, sc); T.road(15, 22, 15, -c, Math.round(hill() * 0.5), sc); }
      else if (r < 0.74) { for (let k = 0; k < 3; k++) T.road(12, 8, 12, 0, (k % 2 ? -1 : 1) * Math.round(8 + 14 * diff * rnd()), sc); }
      else if (r < 0.88) T.road(30, 80 + Math.floor(rnd() * 70), 30, sgn() * (1.5 + rnd() * 1.2), hill(), sc);
      else if (diff > 0.3) { const c = sgn() * (3.8 + 1.4 * diff); T.road(10, 14, 10, c, 0, sc); T.road(10, 14, 10, -c, 0, sc); }
      else T.road(20, 40, 20, sgn() * 2.2, hill(), sc);
    }
  }
  // the fork: two roads part over FORK_LEN segments, a gate on each, then the chosen one swings back to the middle
  const FORK_LEN = 150, GATE_AT = 138, MERGE = 120, ISLAND = 24, SPLIT = 2.3;
  function addFork(T, sc, o) {
    const f0 = T.end, y = T.lastY();
    const fork = Object.assign({ f0, island: f0 + ISLAND, gate: f0 + GATE_AT, mergeEnd: f0 + FORK_LEN + MERGE, side: 0 }, o);
    for (let k = 0; k < FORK_LEN; k++) {
      const s = T.add(0, y, sc), S = SPLIT * ease3(k / 110), hw = 1 - 0.25 * Math.min(1, k / 30);
      s.roads = [{ id: "L", c: -S, hw }, { id: "R", c: S, hw }];
      s.zone = "fork"; s.fork = fork;
    }
    for (let k = 0; k < MERGE; k++) {
      const s = T.add(0, y, sc);
      s.roads = [{ id: "L", c: -SPLIT, hw: 0.75 }, { id: "R", c: SPLIT, hw: 0.75 }];
      s.zone = "post"; s.fork = fork;
    }
    T.get(fork.gate).gate = { kind: o.finish ? "finish" : "check" };
    for (const d of [70, 30]) { const q = T.get(f0 - d); if (q) q.signs = fork; }
    linkRoads(T, f0 - 1, fork.mergeEnd, null);
    return fork;
  }
  // each strip also knows where it is at the far end of its segment, so the road bends smoothly row by row
  function linkRoads(T, from, to, chosenId) {
    for (let i = Math.max(T.base, from); i < Math.min(T.end, to + 1); i++) {
      const s = T.get(i), n = T.get(i + 1);
      if (s.roads === MAIN) continue;
      for (const r of s.roads) {
        let m = n ? n.roads.find((q) => q.id === r.id) : null;
        if (!m && n && n.roads === MAIN && r.id === chosenId) m = MAIN[0];
        r.c2 = m ? m.c : r.c; r.hw2 = m ? m.hw : r.hw;
      }
    }
  }
  function commitFork(T, fork, side) {
    fork.side = side;
    const id = side < 0 ? "L" : "R", other = side < 0 ? "R" : "L";
    const scName = side < 0 ? fork.scL : fork.scR;
    fork.chosenId = id; fork.chosen = scName;
    const a = fork.gate + 1, b = fork.mergeEnd;
    for (let i = a; i < b; i++) {
      const s = T.get(i);
      if (!s) continue;
      const u = (i - a) / (b - a), e = easeInOut(0, 1, u);
      s.roads = [{ id, c: side * SPLIT * (1 - e), hw: 0.75 + 0.25 * e }, { id: other, c: -side * (SPLIT + 16 * u * u), hw: 0.75 }];
      s.sc = scName;
    }
    for (let i = b; i < T.end; i++) T.get(i).sc = scName;
    linkRoads(T, a - 1, b, id);
  }
  const extentOf = (s) => {
    let l = 0, r = 0;
    for (const q of s.roads) { l = Math.min(l, q.c - q.hw); r = Math.max(r, q.c + q.hw); }
    return [l, r];
  };
  function decorate(T, from, to, seed) {
    const L = LIB, rnd = WG.rng(seed >>> 0 || 1);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const sd = () => (rnd() < 0.5 ? -1 : 1);
    for (let i = Math.max(from, T.base); i < Math.min(to, T.end); i++) {
      const s = T.get(i);
      s.sprites = null; s.lit = 0; s.water = 0;
      const [el, er] = extentOf(s);
      const add = (img, x, k, solid, extra) => (s.sprites || (s.sprites = [])).push(Object.assign({ img, x, k, solid: solid || 0 }, extra));
      const put = (side, margin, img, k, solidFrac, extra) => {
        const half = (img.width * k) / UNIT / 2;
        add(img, side < 0 ? el - margin - half : er + margin + half, k, solidFrac ? half * solidFrac : 0, extra);
      };
      const near = (d) => { for (let j = -d; j <= d; j++) { const q = T.get(i + j); if (q && q.gate) return true; } return false; };
      const sc = s.sc;
      s.water = sc === "coast" ? -1 : sc === "lakes" && Math.floor(i / 260) % 2 ? 1 : 0;
      if (s.fork && s.zone === "fork") {
        const f = s.fork;
        if (i >= f.island && i < f.gate - 3 && (i - f.island) % 3 === 0 && i !== f.island + 15) add(L.barrier, 0, 1.3, 0.2);
        if (i === f.island + 15) add(forkSign(f.scL, f.scR), 0, 1.7, 0.62);
      }

      if (s.signs) {
        const f = s.signs, k = 1.9;
        for (const side of [-1, 1]) { const im = sideSign(side < 0 ? f.scL : f.scR, side); const half = (im.width * k) / UNIT / 2; add(im, side < 0 ? el - 0.35 - half : er + 0.35 + half, k, half * 0.5); }
        continue;
      }
      if (near(3)) continue;
      const lampsAt = sc === "city" ? 8 : 0;
      if (sc !== "city" && i % 6 === 0) { put(-1, 0.14, L.post, 1.7, 0); put(1, 0.14, L.post, 1.7, 0); }
      if (Math.abs(s.curve) > 3 && i % 4 === 0) { const side = s.curve > 0 ? -1 : 1; put(side, 0.4, side < 0 ? L.chevR : L.chevL, 1.7, 0.6); }
      if (sc === "forest") {
        if (rnd() < 0.62) put(sd(), 0.5 + rnd() * 1.4, pick(L.pine), 2.2 + rnd() * 0.6, 0.3);
        if (rnd() < 0.45) put(sd(), 2.0 + rnd() * 3.5, pick(L.pine), 2.5 + rnd() * 0.5, 0.3);
        if (rnd() < 0.035) put(sd(), 0.35 + rnd(), pick(L.rock), 1.9, 0.7);
        if (rnd() < 0.006) put(sd(), 2.4, L.cabin, 2.4, 0.8);
        if (rnd() < 0.005) put(sd(), 0.6, pick(L.board), 2.0, 0.8);
        if (rnd() < 0.08) put(sd(), 0.3 + rnd() * 0.8, pick(L.bush), 1.8, 0);
      } else if (sc === "city") {
        if (i % lampsAt === 0) for (const side of [-1, 1]) {
          const lp = side < 0 ? L.lamp : L.lampL, k = 2.1, half = (lp.img.width * k) / UNIT / 2, pole = (3 * k) / UNIT;
          add(lp.img, side < 0 ? el - 0.3 - pole + half : er + 0.3 + pole - half, k, 0.04, { glow: lp.glow, hit: side < 0 ? el - 0.3 - pole / 2 : er + 0.3 + pole / 2 });
        }
        const m = i % lampsAt; if (m <= 1 || m === lampsAt - 1) s.lit = 1;
        if (rnd() < 0.55) put(sd(), 0.85 + rnd() * 1.5, pick(L.bldg), 2.3 + rnd() * 0.5, 0.8);
        if (rnd() < 0.3) put(sd(), 2.8 + rnd() * 2.5, pick(L.bldg), 2.6, 0.8);
        if (rnd() < 0.014) put(sd(), 0.45, pick(L.board), 2.0, 0.8);
      } else if (sc === "coast") {
        if (rnd() < 0.35) put(1, 0.3 + rnd() * 1.5, pick(L.rock), 2.0 + rnd() * 0.5, 0.7);
        if (rnd() < 0.3) put(1, 1.2 + rnd() * 2.5, pick(L.pine), 2.4 + rnd() * 0.4, 0.3);
        if (rnd() < 0.05) put(-1, 1.3 + rnd() * 3, pick(L.rock), 2.5, 0.7);
        if (rnd() < 0.004) put(1, 0.6, pick(L.board), 2.0, 0.8);
      } else if (sc === "snow") {
        if (rnd() < 0.58) put(sd(), 0.5 + rnd() * 1.4, pick(L.pineSnow), 2.2 + rnd() * 0.6, 0.3);
        if (rnd() < 0.4) put(sd(), 2.0 + rnd() * 3.5, pick(L.pineSnow), 2.5 + rnd() * 0.5, 0.3);
        if (rnd() < 0.04) put(sd(), 0.35 + rnd(), pick(L.rockSnow), 1.9, 0.7);
        if (rnd() < 0.006) put(sd(), 0.5 + rnd(), L.snowman, 1.9, 0.6);
        if (rnd() < 0.004) put(sd(), 2.2, L.cabinSnow, 2.4, 0.8);
      } else if (sc === "lakes") {
        if (s.water) {
          if (rnd() < 0.3) put(1, 0.15 + rnd() * 0.2, pick(L.reeds), 1.6, 0);
          if (rnd() < 0.6) put(-1, 0.5 + rnd() * 1.6, pick(L.birch), 2.3 + rnd() * 0.5, 0.25);
        } else {
          if (rnd() < 0.62) put(sd(), 0.5 + rnd() * 1.8, pick(L.birch), 2.3 + rnd() * 0.5, 0.25);
          if (rnd() < 0.3) put(sd(), 2.2 + rnd() * 3, pick(L.pine), 2.4, 0.3);
        }
        if (rnd() < 0.12) put(sd(), 0.3 + rnd() * 0.8, pick(L.bush), 1.8, 0);
        if (rnd() < 0.005) put(-1, 2.0, L.cabin, 2.4, 0.8);
      } else if (sc === "canyon") {
        if (rnd() < 0.26) put(sd(), 0.45 + rnd() * 2, pick(L.rockRed), 2.0 + rnd() * 0.7, 0.7);
        if (rnd() < 0.11) put(sd(), 1.6 + rnd() * 3, pick(L.pillar), 2.6 + rnd() * 0.4, 0.5);
        if (rnd() < 0.025) put(sd(), 0.35, L.cairn, 1.8, 0.6);
      }
    }
  }

  // ---------- the championship's tracks, and the endless road ----------
  const G0 = 14; // the start line
  // the time limits: the best possible time over a stretch (full speed, slower only where a bend would throw the car
  // off the road), stretched by PACE — the share of that ideal the clock asks for
  const PACE = 0.72;
  function secsFor(T, a, b) {
    let t = 0;
    for (let i = a; i < b; i++) { const s = T.get(i); const v = s ? Math.min(1, 1 / Math.max(0.01, Math.abs(s.curve) * CENTRIFUGAL)) : 1; t += 1 / (60 * v); }
    return t / PACE;
  }
  function buildStage(n, skill) {
    const T = new Track(), rnd = WG.rng(7919 * n + 13), diff = (n - 1) / 7;
    const sc = sceneryOf(n);
    const total = 2300 + 300 * (n - 1);
    T.road(0, 40, 0, 0, 0, sc);
    T.get(G0).gate = { kind: "start" };
    const checks = [];
    for (const f of n <= 3 ? [0.5] : [1 / 3, 2 / 3]) {
      sections(T, rnd, Math.max(100, Math.round(40 + total * f) - T.end), diff, sc);
      T.road(0, 30, 0, 0, 0, sc);
      const idx = T.end - 15;
      T.get(idx).gate = { kind: "check" };
      checks.push({ idx });
    }
    sections(T, rnd, Math.max(100, 40 + total - T.end), diff, sc);
    T.road(0, 30, 0, 0, 0, sc);
    let fork = null, finish;
    if (n < 8) {
      const [a, b] = STAGE_SC[n];
      fork = addFork(T, sc, { scL: a, scR: b, finish: true });
      finish = fork.gate;
      T.road(0, 220, 0, 0, 0, sc);
    } else {
      T.road(0, 60, 0, 0, 0, sc);
      finish = T.end - 30;
      T.get(finish).gate = { kind: "final" };
      T.road(0, 260, 0, 0, 0, sc);
    }
    // the time: enough to reach the first checkpoint at the reference pace, then each leg's worth at each checkpoint
    const legs = [G0, ...checks.map((c) => c.idx), finish];
    const lvK = 1 + 0.1 * clamp(skill, 0, 1);   // denser traffic on the harder levels costs time: a little more on the clock
    const start = Math.round(secsFor(T, legs[0], legs[1]) * lvK + 8);
    checks.forEach((c, k) => { c.add = Math.round(secsFor(T, legs[k + 1], legs[k + 2]) * lvK); });
    const budget = start + checks.reduce((a, c) => a + c.add, 0);
    decorate(T, 0, T.end, 4242 + n * 17);
    return { T, sc, checks, finish, fork, start, budget, par2: Math.max(5, Math.round(budget * 0.1)), diff };
  }
  const pairFor = (rnd, cur) => {
    const pool = SC_LIST.filter((s) => s !== cur);
    const a = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
    return [a, pool[Math.floor(rnd() * pool.length)]];
  };
  function addSector(T, k, sc, rnd) {
    const diff = Math.min(1, 0.15 + k * 0.12), from = T.end;
    sections(T, rnd, 1250 + Math.min(650, k * 90), diff, sc);
    T.road(0, 30, 0, 0, 0, sc);
    const [a, b] = pairFor(rnd, sc);
    const fork = addFork(T, sc, { scL: a, scR: b, finish: false, sector: k, from, diff });
    decorate(T, from, T.end, 9001 + k * 131);
    return fork;
  }

  // ---------- the game ----------
  const RIVALS = [
    { ramp: "cyan", wing: true, dot: "#7FE6F4" }, { ramp: "violet", wing: false, dot: "#C4BBFF" }, { ramp: "amber", wing: true, dot: "#FFD27A" },
    { ramp: "green", wing: false, dot: "#8EF0C6" }, { ramp: "white", wing: true, dot: "#EAF0FA" },
  ];
  const TRAFFIC = [
    { kind: "sedan", ramp: "steel" }, { kind: "sedan", ramp: "beige" }, { kind: "sedan", ramp: "pine" }, { kind: "sedan", ramp: "plum" },
    { kind: "sedan", ramp: "grey" }, { kind: "van", ramp: "white", text: "ХЛЕБ" }, { kind: "van", ramp: "steel", text: "МОЛОКО" }, { kind: "van", ramp: "amber", text: "ЦВЕТЫ" },
  ];
  const CAR_IMG = new Map(), PL = new Map();
  function carImg(kind, ramp, o) {
    const key = kind + ramp + "|" + (o.lean | 0) + (o.tire | 0) + (o.brake ? 1 : 0) + (o.blink | 0) + (o.blinkOn ? 1 : 0) + (o.hair | 0) + (o.wing ? 1 : 0) + (o.text || "");
    let c = CAR_IMG.get(key);
    if (!c) { c = KIT.car(kind, ramp, o); CAR_IMG.set(key, c); }
    return c;
  }
  const fmt = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const clock = (sec) => Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0");
  const clockMs = (ms) => clock(ms / 1000) + "." + String(Math.floor((ms % 1000) / 10)).padStart(2, "0");

  WG.game({
    id: "road",
    portrait: false,
    controls: { dpad: false, a: false, b: "Тормоз", swipe: false, landscapeDpad: true },
    howto: "Ночная гонка под северным сиянием. Газ нажат сам — руль и тормоз твои. Обгоняй соперников, объезжай машины и успевай к контрольным точкам. В конце трассы развилка: какой дорогой поедешь, такой будет следующая трасса.",
    keysHint: "← → — руль, ↓ или X — тормоз (газ нажат всегда), Esc — пауза. Геймпад: стик и B.",
    touchHowto: "Держите палец на левой или правой половине экрана — руль. Обе сразу или кнопка «Тормоз» — тормоз. Газ нажат сам.",
    titleColors: ["#FFE1E5", "#FFE1E5", "#FF8F9C", "#FF8F9C", "#FF6B7A", "#D93644", "#D93644"],
    music: SONGS[0],
    create(api) {
      if (!LIB) LIB = buildLib();
      const skill = clamp(api.skill === undefined ? 0.45 : api.skill, 0, 1);
      const endless = !api.stage;
      const ST = endless ? null : buildStage(api.stage, skill);
      let T, forks = [], checks = [], finishIdx = Infinity;
      const erng = WG.rng(((Date.now() / 1000) | 0) ^ 0x5eed);
      if (ST) { T = ST.T; checks = ST.checks.map((c) => Object.assign({ done: false }, c)); finishIdx = ST.finish; if (ST.fork) forks.push(ST.fork); }
      else {
        T = new Track();
        T.road(0, 40, 0, 0, 0, "forest");
        T.get(G0).gate = { kind: "start" };
        decorate(T, 0, T.end, 77);
        forks.push(addSector(T, 0, "forest", erng));
      }
      const firstSc = ST ? ST.sc : "forest";
      const fx = new WG.Particles(700);
      const hum = Hum();
      const touch = TouchPad();
      const segAt = (z) => T.get(Math.floor(z / SEG));
      const S = {
        t: 0, phase: "grid", countT: 0, pos: G0 * SEG - 3 * SEG - PLAYER_Z, prevPos: 0, x: 0, prevX: 0, camX: 0, prevCamX: 0, speed: 0, leanV: 0, steer: 0,
        timeLeft: ST ? ST.start : Math.round(secsFor(T, G0, forks[0].gate) + 6), playMs: 0, crashes: 0, bumps: 0, overtakes: 0, nearMiss: 0,
        spin: 0, spinA: 0, place: 6, finished: false, finT: 0, endT: 0, ended: false, cps: 0, score: 0, dist: 0, bonus: 0,
        bg: firstSc, bgFrom: null, bgK: 1, bgX: 0, prevBgX: 0, msgs: [], pops: [], auto: null, gear: 1, shiftT: 0, skidT: 0, offT: 0, beepT: 0,
        tireT: 0, brake: false, flake: [], fireT: 0, scrapeT: 0, sector: 0, song: SCN[firstSc].song, lastSide: 0,
      };
      S.prevPos = S.pos; S.prevX = S.x;
      for (let i = 0; i < 110; i++) S.flake.push({ x: Math.random() * W, y: Math.random() * H, z: 0.4 + Math.random() * 0.6 });
      // ---------- the field: rivals on the grid, traffic along the road ----------
      const cars = [];
      const playerZ0 = S.pos + PLAYER_Z;
      if (ST) {
        const grid = [[0.6, -0.45], [0.6, 0.45], [3.6, -0.45], [3.6, 0.45], [6.6, 0]];
        RIVALS.forEach((R, k) => {
          cars.push({ rival: true, kind: "coupe", ramp: R.ramp, wing: R.wing, dot: R.dot, z: playerZ0 + grid[k][0] * SEG + 90, x: grid[k][1], lane: grid[k][1] < 0 ? -0.66 : grid[k][1] > 0 ? 0.66 : 0,
            branch: "M", speed: 0, hw: 0.22, top: Math.min(0.99, 0.77 + 0.2 * skill + 0.02 * ST.diff + [-0.06, -0.03, 0, 0.03, 0.05][k]),
            think: Math.random() * 0.3, lat: 0, ahead: true, brake: false, blink: 0 });
        });
      }
      function spawnTraffic(from, to, diff) {
        const rnd = WG.rng((from * 31 + to) ^ 0x7a11);
        const per100 = (0.35 + 0.75 * skill) * (0.8 + 0.4 * diff);
        const n = Math.round(((to - from) / 100) * per100);
        for (let k = 0; k < n; k++) {
          const i = from + Math.floor(((k + rnd() * 0.8) / n) * (to - from));
          const tp = TRAFFIC[Math.floor(rnd() * TRAFFIC.length)];
          const lane = [-0.66, 0, 0.66][Math.floor(rnd() * 3)];
          cars.push({ rival: false, kind: tp.kind, ramp: tp.ramp, text: tp.text, z: i * SEG + rnd() * SEG, x: lane, lane, branch: "M",
            speed: MAXV * (0.3 + 0.16 * rnd() + 0.1 * skill), hw: tp.kind === "van" ? 0.21 : 0.19, brake: false, blink: 0, blinkT: 0,
            changeT: 3 + rnd() * 8, ahead: true });
        }
      }
      if (ST) spawnTraffic(G0 + 60, (ST.fork ? ST.fork.f0 : ST.finish) - 40, ST.diff);
      else spawnTraffic(G0 + 60, forks[0].f0 - 40, 0.15);
      S.cars = cars;

      // ---------- helpers ----------
      const stripOf = (s, id) => (s ? s.roads.find((r) => r.id === id) || null : null);
      const onRoad = (s, x) => { for (const r of s.roads) if (Math.abs(x - r.c) <= r.hw + 0.1) return true; return false; };
      function pop(text, color, y) { S.pops.push({ text, color: color || "#FFFFFF", y: y || 150, t: 0 }); }
      function say(text, sub, color, dur, y) { S.msgs = [{ text, sub, color: color || GOLD_T, t: 0, d: dur || 1.6, y: y || 62 }]; }
      const pz = () => S.pos + PLAYER_Z;
      const placeNow = () => 1 + cars.filter((c) => c.rival && c.z > pz()).length;
      const progress = () => (ST ? clamp((pz() / SEG - G0) / (finishIdx - G0), 0, 1) : 0);
      function currentFork(i) { for (const f of forks) if (i >= f.f0 && i < f.mergeEnd) return f; return null; }
      const toEnd = () => { hum.stop(); };

      function commit(f, side) {
        commitFork(T, f, side);
        decorate(T, f.gate + 1, T.end, 3301 + f.f0);
        if (!ST || !f.finish) {
          // endless: the next stretch of road, in the scenery just chosen
          S.sector++;
          const nf = addSector(T, S.sector, f.chosen, erng);
          forks.push(nf);
          spawnTraffic(f.mergeEnd + 30, nf.f0 - 40, Math.min(1, 0.15 + S.sector * 0.12));
        }
        api.sfx("select");
        say("→ " + SCN[f.chosen].name.toUpperCase(), null, CYAN_T, 1.6);
      }
      function crash(hard, sx) {
        if (hard) {
          S.crashes++;
          S.spin = 1.15; S.spinA = 0;
          S.speed *= 0.35;
          api.sfx("road_crash"); api.shake(6, 0.45); api.flash("#FF6B7A", 0.2);
          fx.emit({ x: 192, y: 196, n: 34, colors: ["#FFFFFF", "#FFD27A", "#FF6B7A", "#9AA5C0"], speed: [40, 150], angle: [-Math.PI, 0], life: [0.3, 0.9], gravity: 260, drag: 1.5, shape: "spark" });
          fx.emit({ x: 192, y: 196, n: 18, colors: ["#6B7694", "#9AA5C0", "#46516F"], speed: [15, 50], angle: [-2.6, -0.5], life: [0.6, 1.3], drag: 1.2, size: 3 });
          if (ST) pop("АВАРИЯ!", "#FF8F9C", 120);
        } else {
          S.bumps++;
          api.sfx("road_bump"); api.shake(3, 0.2);
          fx.emit({ x: sx || 192, y: 186, n: 12, colors: ["#FFFFFF", "#FFD27A", "#FFF0C2"], speed: [40, 110], angle: [-Math.PI, 0], life: [0.2, 0.5], gravity: 300, shape: "spark" });
        }
      }

      // ---------- the player's car ----------
      function controls() {
        if (S.auto) return autopilot();
        const I = api.input, tl = touch.left, tr = touch.right;
        return {
          left: I.held("left") || (tl && !tr), right: I.held("right") || (tr && !tl),
          brake: I.held("down") || I.held("b") || (tl && tr), gas: true,
        };
      }
      // for automated checks: drives a sensible line, brakes for sharp bends ("good"), or just stands on the brake ("stop")
      function autopilot() {
        if (S.auto === "stop") return { left: false, right: false, brake: true, gas: false };
        const z = pz(), s = segAt(z);
        let tx = S.autoLane === undefined ? 0 : S.autoLane;
        const f = currentFork(s.i);
        let st = null;
        if (f && s.roads.length > 1) { const id = f.side ? f.chosenId : S.autoSide < 0 ? "L" : "R"; st = stripOf(s, id); }
        const c0 = st ? st.c : 0, hw = st ? st.hw : 1;
        const sp = S.speed / MAXV, look = SEG * (8 + 24 * sp);
        // the distance to the first car in the way if we hold line x (crossing in front of a near car counts)
        const room = (x) => {
          let d = look;
          for (const c of cars) {
            const dz = c.z - z;
            if (dz < -SEG * 0.8 || dz > look) continue;
            if (Math.abs(c.x - x) < CAR_HW + c.hw + 0.1 || (dz < SEG * (3 + 10 * sp) && (c.x - S.x) * (c.x - x) < 0)) d = Math.min(d, Math.max(0, dz));
          }
          return d;
        };
        const cands = [];
        for (let v = -0.72; v <= 0.73; v += 0.24) cands.push(c0 + v * hw);
        let bestX = S.autoX === undefined ? c0 : S.autoX, bestR = -1;
        for (const x of cands) { const r = room(x) - Math.abs(x - S.x) * SEG * 2; if (r > bestR + 1) { bestR = r; bestX = x; } }
        S.autoX = bestX;
        if (Math.abs(S.autoX - c0) > hw) S.autoX = c0;
        tx = S.autoX;
        let ok = true;
        for (const c of cars) {
          const dz = c.z - z;
          if (dz < 0 || dz > look || Math.abs(c.x - S.x) > CAR_HW + c.hw + 0.05) continue;
          const close = (S.speed - c.speed) / MAXV;
          if (close > 0 && dz < close * SEG * 30 + SEG * 1.5) ok = undefined;
        }
        let maxC = 0;
        for (let k = 0; k < 40; k++) { const q = T.get(s.i + k); if (q) maxC = Math.max(maxC, Math.abs(q.curve)); }
        const lim = 1 / Math.max(0.0001, maxC * CENTRIFUGAL * 1.05);
        const brake = sp > lim + 0.03 || (ok === undefined && sp > 0.3) || (Math.abs(S.x - tx) > 0.3 && sp > 0.85);
        const pull = -s.curve * sp * CENTRIFUGAL * 0.3;
        return { left: S.x > tx + 0.03 + pull, right: S.x < tx - 0.03 + pull, brake, gas: !brake };
      }
      function physics(dt, ctl) {
        const s = segAt(pz());
        if (!s) return;
        const sp = S.speed / MAXV;
        const steer = S.spin > 0 ? 0 : (ctl.right ? 1 : 0) - (ctl.left ? 1 : 0);
        S.steer = steer;
        S.leanV += (steer - S.leanV) * Math.min(1, dt * 7);
        const dxs = dt * 2 * sp;
        S.x += steer * dxs;
        S.x -= dxs * sp * s.curve * CENTRIFUGAL;
        S.brake = !!ctl.brake && S.spin <= 0;
        if (S.spin > 0) { S.spin -= dt; S.spinA += dt * 14 * Math.max(0.3, S.spin); S.speed -= MAXV * 0.5 * dt; }
        else if (ctl.brake) S.speed -= BRAKE * dt;
        else if (ctl.gas) S.speed += ACCEL * dt * (1 - 0.55 * sp);
        else S.speed -= COAST * dt;
        const on = onRoad(s, S.x);
        if (!on && S.speed > OFF_LIMIT) S.speed -= OFF_DECEL * dt;
        S.speed = clamp(S.speed, 0, MAXV);
        const [el, er] = extentOf(s);
        S.x = clamp(S.x, el - 2.5, er + 2.5);
        S.pos += S.speed * dt;
        S.camX += (S.x - S.camX) * Math.min(1, dt * 9);
        S.bgX += s.curve * sp * dt * 60 * 1.2;
        S.tireT += sp * dt * 30;
        const sp2 = S.speed / MAXV;
        S.dist += (sp2 * KMH / 3.6) * dt;
        // off the road: dust, gravel, a rumble
        if (!on && sp2 > 0.08) {
          S.offT -= dt;
          if (S.offT <= 0) { S.offT = 0.12; api.shake(1.5, 0.12); api.tone({ w: "noise", f: 400, d: 0.08, v: 0.08, lp: 900 }); }
          const dc = SCN[s.sc].dirt, cx = 192 + (S.x - S.camX) * UNIT;
          fx.emit({ x: cx + (Math.random() < 0.5 ? -24 : 24), y: 204, n: 2, colors: dc, speed: [20, 60], angle: [-2.8, -0.4], life: [0.3, 0.7], gravity: 160, size: 2 });
        }
        // a slide in a hard bend at speed: tyre smoke and a squeal
        const slip = Math.abs(s.curve) * sp2 * sp2;
        if (on && slip > 2.6 && S.spin <= 0) {
          S.skidT -= dt;
          if (S.skidT <= 0) { S.skidT = 0.14; api.sfx("road_skid"); }
          const cx = 192 + (S.x - S.camX) * UNIT;
          fx.emit({ x: cx + (Math.random() < 0.5 ? -24 : 24), y: 206, n: 1, colors: ["#C9D2E4", "#9AA5C0", "#6B7694"], speed: [8, 26], angle: [-2.4, -0.7], life: [0.4, 0.8], drag: 1, size: 3 });
        }
        // the gearbox: revs and shifts for the hum and the rev bar
        const gears = [0, 0.16, 0.34, 0.54, 0.76, 1.01];
        let gear = 1; while (gear < 5 && sp2 > gears[gear]) gear++;
        if (gear !== S.gear) {
          if (gear > S.gear && S.phase === "race") { api.sfx("road_shift"); S.shiftT = 0.12; if (gear >= 3 && Math.random() < 0.6) { api.sfx("road_pop"); backfire(); } }
          S.gear = gear;
        }
        S.rpm = clamp((sp2 - gears[gear - 1]) / (gears[gear] - gears[gear - 1]), 0, 1) * 0.7 + 0.3;
        if (S.shiftT > 0) { S.shiftT -= dt; S.rpm *= 0.8; }
        hum.set(S.rpm, ctl.gas && !ctl.brake ? 1 : 0.2, true);
        collide(s, sp2);
      }
      function backfire() {
        const cx = 192 + (S.x - S.camX) * UNIT;
        for (const d of [-19, 19]) fx.emit({ x: cx + d, y: 202, n: 4, colors: ["#FFF0C2", "#FFD27A", "#FF8A3D"], speed: [10, 40], angle: [1.2, 1.9], life: [0.1, 0.25], shape: "spark" });
      }
      function collide(s, sp2) {
        const z = pz();
        // roadside things
        if (s.sprites && S.spin <= 0) for (const p of s.sprites) {
          const hx = p.hit === undefined ? p.x : p.hit;
          if (!p.solid || Math.abs(S.x - hx) >= CAR_HW + p.solid) continue;
          if (p.img === LIB.barrier) continue;
          const back = hx === 0 ? (S.x < 0 ? -1 : 1) : hx > 0 ? -1 : 1;
          crash(sp2 > 0.25, 192);
          if (sp2 <= 0.25) S.speed = Math.min(S.speed, MAXV * 0.05);
          S.x = hx + back * (CAR_HW + p.solid + 0.03);
          S.pos -= SEG * 0.4;
          break;
        }
        // the island between the two roads of a fork is fenced off once it begins
        const f = s.fork;
        if (f && s.zone === "fork" && s.i >= f.island && s.roads.length === 2) {
          const R = s.roads[1], inner = R.c - R.hw;
          if (inner > 0.1 && Math.abs(S.x) < inner + CAR_HW * 0.4) {
            const side = f.side || (S.x < 0 ? -1 : 1);
            S.x += side * Math.min(0.035, inner + CAR_HW * 0.4 - Math.abs(S.x));
            S.speed *= 0.985;
            S.scrapeT -= 1 / 60;
            if (S.scrapeT <= 0) { S.scrapeT = 0.1; api.sfx("road_scrape"); fx.emit({ x: 192 + (S.x - S.camX) * UNIT - side * 28, y: 196, n: 5, colors: ["#FFFFFF", "#FFD27A"], speed: [30, 90], angle: [-Math.PI, 0], life: [0.15, 0.4], gravity: 300, shape: "spark" }); }
          }
        }
        // other cars
        for (const c of cars) {
          const dz = c.z - z;
          if (dz < -SEG * 0.7 || dz > SEG * 1.2) continue;
          const lim = CAR_HW + c.hw, ox = Math.abs(c.x - S.x);
          if (ox > lim * 0.9) continue;
          if (dz > SEG * 0.5 && S.speed > c.speed) {
            const rel = S.speed - c.speed;
            const hard = rel > MAXV * 0.5 && S.spin <= 0;
            crash(hard, 192 + (c.x - S.camX) * UNIT * 0.9);
            S.speed = c.speed * (hard ? 0.5 : 0.92);
            S.pos = c.z - PLAYER_Z - SEG * 0.55;
            c.speed = Math.min(MAXV, c.speed + rel * 0.2);
            c.x += (c.x >= S.x ? 1 : -1) * 0.05;
            c.hitT = 1;
          } else if (Math.abs(dz) <= SEG * 0.5) {
            const d = S.x < c.x ? -1 : 1, push = (lim * 0.9 - ox) * 0.5 + 0.01;
            S.x += d * push; c.x -= d * push;
            S.speed *= 0.99;
            S.scrapeT -= 1 / 60;
            if (S.scrapeT <= 0) { S.scrapeT = 0.12; api.sfx("road_scrape"); fx.emit({ x: 192 + (S.x - S.camX) * UNIT - d * 26, y: 194, n: 6, colors: ["#FFFFFF", "#FFD27A"], speed: [30, 90], angle: [-Math.PI, 0], life: [0.15, 0.4], gravity: 300, shape: "spark" }); }
          }
        }
        // passing: overtakes and close shaves
        for (const c of cars) {
          const was = c.ahead, now = c.z > z;
          c.ahead = now;
          if (was && !now && S.phase === "race") {
            S.overtakes++;
            if (c.rival) { api.sfx("road_pass"); pop("ОБГОН! " + placeNow() + "-Е МЕСТО", "#8EF0C6", 140); }
            else if (Math.abs(c.x - S.x) < CAR_HW + c.hw + 0.18 && !c.hitT && S.speed > MAXV * 0.6) {
              S.nearMiss++;
              if (endless) { S.bonus += 50; pop("ВПРИТИРКУ +50", "#FFD27A", 150); } else pop("ВПРИТИРКУ!", "#FFD27A", 150);
              api.sfx("whoosh");
            }
          } else if (!was && now && c.rival && S.phase === "race") pop(placeNow() + "-Е МЕСТО", "#A9B6CD", 140);
        }
      }

      // ---------- the others ----------
      function updateCars(dt) {
        const z = pz();
        cars.sort((a, b) => a.z - b.z);
        for (let k = 0; k < cars.length; k++) {
          const c = cars[k];
          const s = segAt(c.z);
          if (!s) { c.dead = true; continue; }
          if (c.hitT) c.hitT = Math.max(0, c.hitT - dt);
          // which strip it is on: forks split the road, the chosen branch becomes the road again
          let st = stripOf(s, c.branch);
          if (!st) {
            if (c.branch === "M" && s.roads.length > 1) { c.branch = c.x < 0 ? "L" : "R"; c.lane = c.lane < 0 ? -0.5 : c.lane > 0 ? 0.5 : Math.random() < 0.5 ? -0.5 : 0.5; }
            else if (s.roads === MAIN) {
              const f = forks.find((q) => q.chosenId && s.i >= q.mergeEnd - 2 && s.i < q.mergeEnd + 40);
              if (f && c.branch === f.chosenId) { c.branch = "M"; c.lane = clamp(c.lane * 1.3, -0.66, 0.66); } else { c.dead = true; continue; }
            }
            st = stripOf(s, c.branch) || s.roads[0];
          }
          const hwS = st.hw, lanes = hwS > 0.9 ? [-0.66, 0, 0.66] : [-0.5, 0.5];
          if (!lanes.includes(c.lane)) c.lane = lanes.reduce((a, b) => (Math.abs(b - c.lane) < Math.abs(a - c.lane) ? b : a));
          let want;
          if (S.phase === "grid" || S.phase === "count") want = 0;
          else if (c.rival) want = rivalBrain(c, s, st, lanes, k, dt, z);
          else want = trafficBrain(c, st, lanes, k, dt);
          const acc = want > c.speed ? (MAXV / 4.2) * (1 - 0.5 * (c.speed / MAXV)) : MAXV / 1.8;
          c.brake = want < c.speed - MAXV * 0.02;
          c.speed = want > c.speed ? Math.min(want, c.speed + acc * dt) : Math.max(want, c.speed - acc * dt);
          c.z += c.speed * dt;
          const tx = st.c + c.lane * st.hw, lat = (c.rival ? 0.8 + 0.7 * skill : 0.6) * dt * Math.max(0.3, c.speed / MAXV);
          c.x += clamp(tx - c.x, -lat, lat);
          // bumping the car in front
          for (let j = k + 1; j < cars.length && cars[j].z < c.z + SEG * 1.2; j++) {
            const o = cars[j];
            if (o.z > c.z && Math.abs(o.x - c.x) < (c.hw + o.hw) * 0.85 && c.speed > o.speed) { c.speed = o.speed * 0.95; c.z = Math.min(c.z, o.z - SEG * 0.8); }
          }
        }
        for (let k = cars.length - 1; k >= 0; k--) { const c = cars[k]; if (c.dead || (!c.rival && c.z < z - SEG * 40)) cars.splice(k, 1); }
      }
      function laneFree(c, x, look, k) {
        for (const o of cars) {
          if (o === c) continue;
          if (o.z > c.z - SEG * 1.5 && o.z < c.z + SEG * look && Math.abs(o.x - x) < 0.42 && (o.speed < c.speed || o.z < c.z + SEG * 2)) return false;
        }
        const z = pz();
        if (z > c.z - SEG * 1.5 && z < c.z + SEG * look && Math.abs(S.x - x) < 0.42) return false;
        return true;
      }
      function rivalBrain(c, s, st, lanes, k, dt, z) {
        let v = MAXV * c.top;
        let cv = Math.abs(s.curve);
        const ah = T.get(s.i + 12); if (ah) cv = Math.max(cv, Math.abs(ah.curve));
        v *= 1 - cv * 0.04 * (1.15 - skill);
        const gap = (c.z - z) / SEG;
        if (gap < -25) v *= 1 + 0.07 * (0.4 + skill);          // catching up from behind
        else if (gap > 70 && skill < 0.6) v *= 0.94;            // waiting a little on the easy levels
        if (ST && c.z > finishIdx * SEG + SEG * 30) v = MAXV * 0.45;
        c.think -= dt;
        const look = 7 + 16 * skill;
        if (c.think <= 0) {
          c.think = 0.6 - 0.45 * skill + Math.random() * 0.25;
          const here = st.c + c.lane * st.hw;
          if (!laneFree(c, here, look, k)) {
            if (Math.random() < 0.35 * (1 - skill)) c.sloppy = 0.8;   // did not see it in time
            else {
              const order = lanes.slice().sort((a, b) => Math.abs(a - c.lane) - Math.abs(b - c.lane));
              for (const l of order) if (l !== c.lane && laneFree(c, st.c + l * st.hw, look, k)) { c.lane = l; break; }
            }
          } else if (skill >= 0.7 && gap > 0 && gap < 7 && S.speed > c.speed * 0.95 && S.t > (c.blockT || 0) && Math.random() < (skill - 0.6) * 1.2) {
            c.blockT = S.t + 4;
            // the strong ones close the door on you
            const want = clamp((S.x - st.c) / st.hw, lanes[0], lanes[lanes.length - 1]);
            c.lane = lanes.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
          }
        }
        if (c.sloppy) c.sloppy = Math.max(0, c.sloppy - dt);
        // keep off the car ahead in this lane
        if (!c.sloppy) for (const o of cars) {
          if (o === c || o.z <= c.z || o.z > c.z + SEG * 3.5) continue;
          if (Math.abs(o.x - c.x) < 0.4) v = Math.min(v, o.speed * 0.98);
        }
        if (z > c.z && z < c.z + SEG * 3 && Math.abs(S.x - c.x) < 0.4) v = Math.min(v, S.speed * 0.97);
        return Math.min(v, MAXV);
      }
      function trafficBrain(c, st, lanes, k, dt) {
        let v = c.cruise || (c.cruise = c.speed);
        for (let j = k + 1; j < cars.length && cars[j].z < c.z + SEG * 4; j++) { const o = cars[j]; if (Math.abs(o.x - c.x) < 0.4) v = Math.min(v, o.speed); }
        // on the harder levels drivers change lanes, with the indicator on first
        if (skill >= 0.5) {
          c.changeT -= dt;
          if (c.blinkT > 0) {
            c.blinkT -= dt;
            if (c.blinkT <= 0) { const nl = lanes[lanes.indexOf(c.lane) + c.blink]; if (nl !== undefined) c.lane = nl; c.blinkT = -0.8; }
          } else if (c.blinkT < 0) { c.blinkT = Math.min(0, c.blinkT + dt); if (c.blinkT === 0) c.blink = 0; }
          else if (c.changeT <= 0) {
            c.changeT = (skill > 0.85 ? 3 : 6) + Math.random() * 7;
            const i = lanes.indexOf(c.lane), dir = Math.random() < 0.5 ? -1 : 1;
            if (lanes[i + dir] !== undefined) { c.blink = dir; c.blinkT = 1.1; }
          }
        }
        return v;
      }

      // ---------- checkpoints, the fork, the finish ----------
      function events() {
        const i = Math.floor(pz() / SEG);
        for (const c of checks) if (!c.done && i >= c.idx) {
          c.done = true; S.cps++;
          S.timeLeft += c.add;
          api.sfx("road_check"); api.flash("#7FE6F4", 0.18);
          say("КОНТРОЛЬНАЯ ТОЧКА", "+" + c.add + " С", CYAN_T, 1.8);
        }
        for (const f of forks) {
          if (!f.side && i >= f.island) commit(f, S.x < 0 ? -1 : 1);
          if (!f.passed && i >= f.gate) {
            f.passed = true;
            if (!ST) {
              S.cps++;
              const next = forks[forks.indexOf(f) + 1];
              const add = next ? Math.max(12, Math.round(secsFor(T, f.gate, next.gate) * Math.max(0.62, 0.92 - 0.05 * S.cps))) : 20;
              S.timeLeft += add;
              S.bonus += 500 * S.cps;
              api.sfx("road_check"); api.flash("#7FE6F4", 0.18);
              say("КОНТРОЛЬНАЯ ТОЧКА", "+" + add + " С · +" + 500 * S.cps + " ОЧКОВ", CYAN_T, 2);
            }
          }
          if (f.passed && !f.faded && i >= f.gate + 2 && f.chosen) {
            f.faded = true;
            if (f.chosen !== S.bg) { S.bgFrom = S.bg; S.bg = f.chosen; S.bgK = 0; }
            if (!ST && SCN[f.chosen].song !== S.song) { S.song = SCN[f.chosen].song; api.music(SONGS[S.song]); }
          }
        }
        if (ST && !S.finished && i >= finishIdx) finish();
      }
      function finish() {
        S.finished = true; S.phase = "finish"; S.finT = 0;
        S.place = placeNow();
        if (ST.fork && ST.fork.side) {
          const r = WG.store.get(ROUTE_KEY, {}) || {};
          r[api.stage + 1] = ST.fork.side < 0 ? 0 : 1;
          WG.store.set(ROUTE_KEY, r);
        }
        api.flash("#FFF0C2", 0.25);
        api.sfx(S.place === 1 ? "bonus" : "road_check");
        firework(); firework();
      }
      function firework() {
        const x = 40 + Math.random() * 304, y = 20 + Math.random() * 50;
        const cols = [["#8EF0C6", "#34D399", "#FFFFFF"], ["#7FE6F4", "#22B8CF", "#FFFFFF"], ["#C4BBFF", "#8B7CF6", "#FFFFFF"], ["#FFD27A", "#FFF0C2", "#FF6B7A"]][Math.floor(Math.random() * 4)];
        fx.emit({ x, y, n: 34, colors: cols, speed: [30, 85], life: [0.6, 1.3], gravity: 40, drag: 1.4, shape: "star" });
        api.sfx("road_fire");
      }
      function starsNow() {
        if (!ST) return 0;
        const s2 = S.timeLeft >= ST.par2, s3 = s2 && (placeNow() === 1 || S.crashes === 0);
        return 1 + (s2 ? 1 : 0) + (s3 ? 1 : 0);
      }
      function endStage() {
        S.ended = true; toEnd();
        const stars = starsNow(), ms = Math.round(S.playMs);
        const left = Math.max(0, Math.floor(S.timeLeft));
        const score = Math.round(left * 100 + (7 - S.place) * 500 + S.overtakes * 20);
        const hint = stars === 1 ? "★★ — финишируй, когда на часах ещё " + ST.par2 + " с" : stars === 2 ? "★★★ — приедь первым или без единой аварии" : "";
        api.clear({ stars, score, ms, hint,
          line: S.place + "-е место · " + clockMs(ms) + " · запас " + left + " с · " + (S.crashes ? "аварий: " + S.crashes : "без аварий"),
          meta: { place: S.place, left, crashes: S.crashes, overtakes: S.overtakes, route: ST.fork && ST.fork.side ? (ST.fork.side < 0 ? "L" : "R") : "" } });
      }
      function endRun() {
        S.ended = true; toEnd();
        const ms = Math.round(S.playMs);
        if (ST) {
          api.end({ score: 0, ms, line: "Время вышло · пройдено " + Math.round(progress() * 100) + "% трассы", hint: "Трасса " + api.stage + " — «" + SCN[ST.sc].name + "». Держись дороги, тормози только в крутых поворотах." });
        } else {
          const score = Math.round(S.dist + S.bonus + S.overtakes * 25);
          api.end({ score, ms, won: S.cps >= 3, title: "ВРЕМЯ ВЫШЛО",
            meta: { km: Math.round(S.dist / 100) / 10, cps: S.cps, overtakes: S.overtakes, crashes: S.crashes } });
        }
      }

      // ---------- the instance ----------
      return {
        _state: S, _track: T, _stage: ST, _forks: forks, _cars: cars,   // for automated checks (games/dev)
        start() {
          S.phase = "count"; S.countT = 0;
          api.music(SONGS[S.song]);
          hum.start();
        },
        pause() { hum.set(0, 0, false); touch.clear(); },
        resume() { touch.clear(); },
        destroy() { hum.stop(); touch.off(); },
        update(dt) {
          S.t += dt;
          S.prevPos = S.pos; S.prevX = S.x; S.prevCamX = S.camX; S.prevBgX = S.bgX;
          fx.update(dt);
          for (const p of S.pops) p.t += dt;
          S.pops = S.pops.filter((p) => p.t < 1.1);
          for (const m of S.msgs) m.t += dt;
          S.msgs = S.msgs.filter((m) => m.t < m.d);
          if (S.bgK < 1) S.bgK = Math.min(1, S.bgK + dt / 1.2);
          if (SCN[segAt(pz()) ? segAt(pz()).sc : "forest"].weather || SCN[S.bg].weather) updateSnow(dt);
          if (S.phase === "count") {
            const before = S.countT;
            S.countT += dt;
            for (const m of [0.5, 1.2, 1.9]) if (before < m && S.countT >= m) api.sfx("count");
            hum.set(0.35 + 0.25 * Math.max(0, Math.sin(S.countT * 9)) * (S.countT > 0.4 ? 1 : 0), 0.4, true);
            if (before < 2.6 && S.countT >= 2.6) { api.sfx("go"); S.phase = "race"; say("ВПЕРЁД!", null, GOLD_T, 1, 104); }
            updateCars(dt);
            return;
          }
          if (S.phase === "race") {
            S.playMs += dt * 1000;
            S.timeLeft -= dt;
            if (S.timeLeft <= 10 && S.timeLeft > 0) { S.beepT -= dt; if (S.beepT <= 0) { S.beepT = 1; api.sfx("road_beep"); } }
            physics(dt, controls());
            updateCars(dt);
            events();
            if (S.phase === "race" && S.timeLeft <= 0) { S.timeLeft = 0; S.phase = "timeout"; S.endT = 0; api.sfx("lose"); say("ВРЕМЯ ВЫШЛО", null, RED_T, 9); }
            if (!ST && S.t % 2 < dt) T.prune(Math.floor(S.pos / SEG) - 60);
            S.score = Math.round(S.dist + S.bonus + S.overtakes * 25);
            return;
          }
          if (S.phase === "finish") {
            S.finT += dt;
            const s = segAt(pz());
            const st = s && ST.fork && ST.fork.chosenId ? stripOf(s, ST.fork.chosenId) || s.roads[0] : s ? s.roads[0] : null;
            const tx = st ? st.c : 0;
            physics(dt, { left: S.x > tx + 0.05, right: S.x < tx - 0.05, brake: S.speed > MAXV * 0.55, gas: S.speed < MAXV * 0.45 });
            updateCars(dt);
            S.fireT -= dt; if (S.fireT <= 0) { S.fireT = 0.35; firework(); }
            if (!S.ended && S.finT > 3.2) endStage();
            return;
          }
          if (S.phase === "timeout") {
            S.endT += dt;
            physics(dt, { left: false, right: false, brake: S.speed > MAXV * 0.1, gas: false });
            updateCars(dt);
            if (!S.ended && (S.endT > 2.6 || (S.speed < MAXV * 0.02 && S.endT > 1.2))) endRun();
          }
        },
        draw(g, alpha) {
          const a = alpha || 0;
          const rp = lerp(S.prevPos, S.pos, a), rx = lerp(S.prevX, S.x, a), rcx = lerp(S.prevCamX, S.camX, a), rbg = lerp(S.prevBgX, S.bgX, a);
          // the sky and the ranges (the scenery crossfades after a fork)
          if (S.bgFrom && S.bgK < 1) {
            drawBg(g, S.bgFrom, S.t, rbg);
            g.save(); g.globalAlpha = S.bgK; drawBg(g, S.bg, S.t, rbg); g.restore();
          } else drawBg(g, S.bg, S.t, rbg);
          g.fillStyle = SCN[S.bg].land; g.fillRect(0, HOR + 1, W, H - HOR - 1);
          const vis = renderRoad(g, rp, rcx);
          const carX = 192 + (rx - rcx) * UNIT;
          headlights(g, carX);
          drawThings(g, vis, rp);
          drawPlayer(g, carX);
          fx.draw(g);
          if (SCN[S.bg].weather) drawSnow(g);
          speedLines(g);
          hud(g);
        },
      };

      // ---------- drawing: the road ----------
      function renderRoad(g, rp, camXu) {
        const bi = Math.floor(rp / SEG), base = T.get(bi);
        const vis = [];
        if (!base) return vis;
        const basePct = (rp - bi * SEG) / SEG;
        const pzz = rp + PLAYER_Z, ps = segAt(pzz) || base;
        const ppct = (pzz - ps.i * SEG) / SEG;
        const playerY = lerp(ps.y1, ps.y2, ppct);
        const camY = playerY + CAM_H, camX = camXu * ROAD;
        let maxy = H, x = 0, dx = -(base.curve * basePct) * CURVE_K;
        for (let n = 0; n < DRAW; n++) {
          const s = T.get(bi + n);
          if (!s) break;
          const z1 = s.i * SEG - rp, z2 = z1 + SEG;
          s._clip = maxy;
          const sc1 = DEPTH / Math.max(1, z1), sc2 = DEPTH / z2;
          const X1 = 192 + sc1 * (x - camX) * 192, X2 = 192 + sc2 * (x + dx - camX) * 192;
          const Y1 = HOR - sc1 * (s.y1 - camY) * YS, Y2 = HOR - sc2 * (s.y2 - camY) * YS;
          const W1 = sc1 * ROAD * 192, W2 = sc2 * ROAD * 192;
          x += dx; dx += s.curve * CURVE_K;
          if (z1 <= DEPTH) continue;
          s._x1 = X1; s._y1 = Y1; s._w1 = W1; s._x2 = X2; s._y2 = Y2; s._w2 = W2; s._n = n;
          vis.push(s);
          if (Y2 >= Y1 || Y2 >= maxy) continue;
          const top = Math.max(0, Math.ceil(Y2 - 0.5)), bot = Math.min(maxy, Math.round(Y1), H);
          if (bot <= top) continue;
          const sc = SCN[s.sc], P = palOf(sc), gp = Math.floor(s.i / RUMBLE) % 2;
          const fogF = clamp((n - 30) / (DRAW - 30), 0, 1) * 4;
          for (let y = top; y < bot; y++) {
            const t = (y + 0.5 - Y2) / (Y1 - Y2);
            const X = X2 + (X1 - X2) * t, Wd = W2 + (W1 - W2) * t;
            const lv = Math.min(4, Math.floor(fogF + BAYER4[(y & 3) * 4 + (s.i & 3)]));
            const C = lv === 0 && s.lit ? P.lit[gp] : P.lv[lv][gp];
            g.fillStyle = C.grass; g.fillRect(0, y, W, 1);
            let L = 1e9, Rr = -1e9;
            for (const r of s.roads) {
              const c = (r.c2 === undefined ? r.c : r.c2 + (r.c - r.c2) * t), hwU = (r.hw2 === undefined ? r.hw : r.hw2 + (r.hw - r.hw2) * t);
              const cx = X + c * Wd, hw = hwU * Wd;
              L = Math.min(L, cx - hw); Rr = Math.max(Rr, cx + hw);
            }
            if (s.water && C.water) {
              const shore = 0.5 * Wd + Wd / 6;
              if (s.water < 0) { const e = Math.round(L - shore); if (e > 0) { g.fillStyle = C.water; g.fillRect(0, y, e, 1); g.fillStyle = C.foam; g.fillRect(e - 1, y, Math.max(1, Math.round(Wd / 60)), 1); } }
              else { const e = Math.round(Rr + shore); if (e < W) { g.fillStyle = C.water; g.fillRect(e, y, W - e, 1); g.fillStyle = C.foam; g.fillRect(e, y, Math.max(1, Math.round(Wd / 60)), 1); } }
            }
            for (const r of s.roads) {
              const c = (r.c2 === undefined ? r.c : r.c2 + (r.c - r.c2) * t), hwU = (r.hw2 === undefined ? r.hw : r.hw2 + (r.hw - r.hw2) * t);
              const cx = X + c * Wd, hw = hwU * Wd, rw = Wd / 6;
              const xl = Math.round(cx - hw - rw), xr = Math.round(cx + hw + rw);
              g.fillStyle = C.rumble; g.fillRect(xl, y, xr - xl, 1);
              const a0 = Math.round(cx - hw), a1 = Math.round(cx + hw);
              g.fillStyle = C.road; g.fillRect(a0, y, a1 - a0, 1);
              const ew = Math.max(1, Math.round(Wd / 48));
              g.fillStyle = C.edge; g.fillRect(a0 + ew, y, ew, 1); g.fillRect(a1 - 2 * ew, y, ew, 1);
              if (gp === 0) {
                const lanes = hwU > 0.9 ? 3 : 2, lw = Math.max(1, Math.round(Wd / 40));
                g.fillStyle = C.lane;
                for (let q = 1; q < lanes; q++) g.fillRect(Math.round(cx - hw + (2 * hw * q) / lanes - lw / 2), y, lw, 1);
              }
            }
          }
          maxy = top;
        }
        return vis;
      }
      function headlights(g, cx) {
        if (S.phase === "grid") return;
        for (let y = HOR + 30; y < H; y += 1) {
          const k = (y - HOR - 30) / (H - HOR - 30);
          const hw = 14 + k * 92;
          g.fillStyle = "rgba(255,236,190," + (0.025 + 0.085 * k).toFixed(3) + ")";
          g.fillRect(Math.round(cx - hw), y, Math.round(hw * 2), 1);
        }
      }
      // sprites, gates and cars, from the horizon toward the camera, cut off below the crest of a nearer hill
      function drawThings(g, vis, rp) {
        const bySeg = new Map();
        const lo = Math.floor(rp / SEG), hi = lo + DRAW;
        for (const c of cars) {
          const i = Math.floor(c.z / SEG);
          if (i < lo || i >= hi) continue;
          (bySeg.get(i) || bySeg.set(i, []).get(i)).push(c);
        }
        for (let k = vis.length - 1; k >= 0; k--) {
          const s = vis[k], f = s._w1 / UNIT, clip = s._clip;
          if (s.sprites) for (const p of s.sprites) {
            const dw = p.img.width * p.k * f, dh = p.img.height * p.k * f;
            if (dw < 0.7) continue;
            const sx = s._x1 + p.x * s._w1, dx = sx - dw / 2, dy = s._y1 - dh;
            if (dx > W || dx + dw < 0 || dy >= clip) continue;
            blit(g, p.img, dx, dy, dw, dh, clip);
            if (p.glow && dy + p.glow[1] * p.k * f < clip) {
              const gw = 30 * p.k * f;
              g.drawImage(LIB.glow, Math.round(dx + p.glow[0] * p.k * f - gw / 2), Math.round(dy + p.glow[1] * p.k * f - gw / 2), Math.round(gw), Math.round(gw));
            }
          }
          if (s.gate) drawGate(g, s, clip);
          const list = bySeg.get(s.i);
          if (list) { list.sort((a, b) => b.z - a.z); for (const c of list) drawCar(g, s, c, clip); }
        }
      }
      function blit(g, img, dx, dy, dw, dh, clip) {
        const x = Math.round(dx), y = Math.round(dy), w = Math.max(1, Math.round(dw)), h = Math.max(1, Math.round(dh));
        if (y + h <= clip) { g.drawImage(img, x, y, w, h); return; }
        const vh = Math.round(clip) - y;
        if (vh <= 0) return;
        g.drawImage(img, 0, 0, img.width, Math.max(1, (img.height * vh) / h), x, y, w, vh);
      }
      function drawCar(g, s, c, clip) {
        const pct = clamp((c.z - s.i * SEG) / SEG, 0, 1);
        const sc = lerp(s._w1, s._w2, pct), f = sc / UNIT;
        const cx = lerp(s._x1, s._x2, pct) + c.x * sc, by = lerp(s._y1, s._y2, pct);
        const blinkOn = c.blink && Math.floor(S.t * 3) % 2 === 0;
        const img = carImg(c.kind, c.ramp, { tire: Math.floor(c.z / 60) % 3, brake: c.brake, blink: c.blink, blinkOn, wing: c.wing, text: c.text });
        const dw = img.width * f, dh = img.height * f;
        if (dw < 1 || cx + dw / 2 < 0 || cx - dw / 2 > W) return;
        blit(g, img, cx - dw / 2, by - dh, dw, dh, clip);
        // tail-light glow
        if (f > 0.18 && by - dh * 0.5 < clip) {
          const gw = (c.brake ? 22 : 13) * f, ly = by - (c.kind === "van" ? 13 : 18) * f;
          for (const d of [-17, 17]) g.drawImage(LIB.glowRed, Math.round(cx + d * f - gw / 2), Math.round(ly - gw / 2), Math.round(gw), Math.round(gw));
        }
      }
      function drawGate(g, s, clip) {
        const sc = s._w1, by = s._y1, kind = s.gate.kind;
        if (sc < 3) return;
        g.save(); g.beginPath(); g.rect(0, 0, W, Math.max(0, Math.round(clip))); g.clip();
        for (const rd of s.roads) {
          const cx = s._x1 + rd.c * sc, hw = rd.hw * sc;
          const pw = Math.max(1, Math.round(0.08 * sc)), ph = Math.round(1.25 * sc), bh = Math.max(3, Math.round(0.3 * sc));
          const xl = Math.round(cx - hw - sc / 6 - pw), xr = Math.round(cx + hw + sc / 6), top = Math.round(by - ph);
          if (xr + pw < 0 || xl > W) continue;
          for (const x of [xl, xr]) {
            g.fillStyle = "#46516F"; g.fillRect(x, top, pw, ph);
            g.fillStyle = "#9AA5C0"; g.fillRect(x, top, Math.max(1, Math.round(pw / 3)), ph);
            g.fillStyle = "#FFD27A"; for (let k = 1; k < 5; k++) g.fillRect(x, Math.round(top + bh + (k * (ph - bh)) / 5), pw, Math.max(1, Math.round(sc / 40)));
          }
          const bw = xr + pw - xl;
          g.fillStyle = "#05070D"; g.fillRect(xl - 1, top - 1, bw + 2, bh + 2);
          g.fillStyle = kind === "check" ? "#0B3B4A" : "#121B31"; g.fillRect(xl, top, bw, bh);
          if (kind === "finish" || kind === "final" || kind === "start") {
            const q = Math.max(1, Math.round(bh / 6));
            for (let x = xl, k = 0; x < xl + bw; x += q, k++) for (const yy of [top, top + bh - q]) { g.fillStyle = (k + (yy === top ? 0 : 1)) % 2 ? "#EAF0FA" : "#1B2133"; g.fillRect(x, yy, Math.min(q, xl + bw - x), q); }
          } else { g.fillStyle = "#7FE6F4"; g.fillRect(xl, top, bw, Math.max(1, Math.round(bh / 10))); g.fillRect(xl, top + bh - Math.max(1, Math.round(bh / 10)), bw, Math.max(1, Math.round(bh / 10))); }
          const txt = LIB.txt[kind === "final" ? "final" : kind];
          const k = Math.max(0.2, (bh * 0.5) / 7), kk = k >= 1 ? Math.floor(k) : k;
          g.drawImage(txt, Math.round(cx - (txt.width * kk) / 2), Math.round(top + bh / 2 - (txt.height * kk) / 2 - kk), Math.round(txt.width * kk), Math.round(txt.height * kk));
          if (kind === "start") {
            const lit = S.phase === "grid" ? 0 : S.phase === "count" ? (S.countT < 0.5 ? 0 : S.countT < 1.2 ? 1 : S.countT < 1.9 ? 2 : 3) : 4;
            const r = Math.max(1, Math.round(bh * 0.22));
            for (let i = 0; i < 3; i++) for (const side of [-1, 1]) {
              const lx = Math.round(cx + side * (hw * 0.55 + i * r * 2.6)), ly = Math.round(top + bh / 2);
              const on = lit === 4 || i < lit;
              g.fillStyle = "#05070D"; g.fillRect(lx - r - 1, ly - r - 1, 2 * r + 2, 2 * r + 2);
              g.fillStyle = lit === 4 ? "#34D399" : on ? "#FF4D63" : "#3D0C17"; g.fillRect(lx - r, ly - r, 2 * r, 2 * r);
            }
          }
        }
        g.restore();
      }

      // ---------- drawing: the convertible ----------
      function playerImg(lean, tire, brake, hair) {
        const key = lean + "|" + tire + "|" + (brake ? 1 : 0) + "|" + hair;
        let c = PL.get(key);
        if (!c) { c = KIT.car("roadster", "red", { lean, tire, brake, hair }); PL.set(key, c); }
        return c;
      }
      function drawPlayer(g, cx) {
        const sp = S.speed / MAXV;
        const lean = S.spin > 0 ? 0 : clamp(Math.round(S.leanV * 2.2), -2, 2);
        const img = playerImg(lean, Math.floor(S.tireT) % 3, S.brake || S.phase === "timeout", Math.floor(S.t * 9) % 3);
        const s = segAt(pz());
        const off = s && !onRoad(s, S.x) && sp > 0.05;
        const bounce = off ? (Math.floor(S.t * 30) % 2) : sp > 0.6 && Math.floor(S.t * 20) % 7 === 0 ? 1 : 0;
        const x = Math.round(cx - img.width / 2), y = 212 - img.height - bounce;
        if (S.spin > 0) {
          const k = Math.cos(S.spinA);
          g.save(); g.translate(Math.round(cx), y + img.height / 2);
          g.scale(Math.sign(k || 1) * Math.max(0.2, Math.abs(k)), 1);
          g.drawImage(img, -img.width / 2, -img.height / 2);
          g.restore();
          return;
        }
        g.drawImage(img, x, y);
        if (S.brake || S.phase === "timeout") {
          for (const d of [-17, 17]) g.drawImage(LIB.glowRed, x + img.width / 2 + d - 12, y + 17 - 12, 24, 24);
        } else for (const d of [-17, 17]) g.drawImage(LIB.glowRed, x + img.width / 2 + d - 6, y + 17 - 6, 12, 12);
      }
      function updateSnow(dt) {
        const sp = S.speed / MAXV;
        for (const f of S.flake) {
          f.x += ((f.x - 192) * sp * 1.4 + Math.sin(S.t + f.z * 9) * 8) * dt * f.z;
          f.y += ((f.y - HOR) * sp * 1.4 + 16) * dt * f.z;
          if (f.x < -2 || f.x > W + 2 || f.y > H + 2) { f.x = 192 + (Math.random() - 0.5) * 300; f.y = sp > 0.3 ? HOR - 30 + Math.random() * 60 : -2 - Math.random() * 20; f.z = 0.4 + Math.random() * 0.6; }
        }
      }
      function drawSnow(g) {
        for (const f of S.flake) {
          g.fillStyle = f.z > 0.85 ? "#FFFFFF" : "#C9D6F2";
          const s = f.z > 0.8 && f.y > HOR ? 2 : 1;
          g.fillRect(Math.round(f.x), Math.round(f.y), s, s);
        }
      }
      function speedLines(g) {
        const sp = S.speed / MAXV;
        if (sp < 0.78 || S.phase === "grid") return;
        const k = (sp - 0.78) / 0.22;
        for (let i = 0; i < 18; i++) {
          const side = i % 2 ? 1 : -1;
          const ang = (side > 0 ? 0 : Math.PI) + side * (-0.5 + ((i * 0.37) % 1) * 1.05);
          const ph = (S.t * (1.6 + (i % 5) * 0.25) + i * 0.137) % 1;
          const r0 = 80 + ph * 230, len = 12 + 34 * k * ph;
          const ca = Math.cos(ang), sa = Math.sin(ang);
          g.fillStyle = "rgba(210,250,255," + (0.25 + 0.45 * k * ph).toFixed(2) + ")";
          for (let d = 0; d < len; d += 1) {
            const x = Math.round(192 + ca * (r0 + d)), y = Math.round(HOR + 10 + sa * (r0 + d) * 0.55);
            if (x < 0 || x >= W || y < 0 || y >= H) break;
            g.fillRect(x, y, 1, 1);
          }
        }
      }

      // ---------- drawing: the dashboard ----------
      function plate(g, x, y, w, h) {
        g.fillStyle = "rgba(4,7,15,.5)"; g.fillRect(x + 1, y, w - 2, h); g.fillRect(x, y + 1, w, h - 2);
      }
      function hud(g) {
        const sp = S.speed / MAXV, sh = "#04070F";
        plate(g, 3, 2, Math.max(44, WG.textWidth(String(Math.max(0, Math.ceil(S.timeLeft))), 3) + 10), 37);
        plate(g, 3, 175, 86, 39);
        plate(g, 376 - WG.textWidth(clockMs(S.playMs), 2) - 6, 192, WG.textWidth(clockMs(S.playMs), 2) + 10, 20);
        // time
        const tl = Math.max(0, Math.ceil(S.timeLeft));
        WG.text(g, "ВРЕМЯ", 8, 5, { color: "#A9B6CD", shadow: sh });
        const warn = S.timeLeft <= 10 && S.phase !== "finish";
        if (!warn || S.timeLeft % 1 > 0.3 || S.phase !== "race") WG.text(g, String(tl), 8, 15, { scale: 3, color: warn ? RED_T : GOLD_T, outline: warn ? "#3D0C17" : "#2A1E00" });
        // the track and everyone on it, or the distance in free driving
        if (ST) {
          WG.text(g, "ТРАССА " + api.stage + " · " + SCN[ST.sc].name.toUpperCase(), 192, 4, { align: "center", color: "#C9D6F2", shadow: sh });
          const bx = 112, bw = 160, by = 15;
          g.fillStyle = "#05070D"; g.fillRect(bx - 1, by - 1, bw + 2, 6);
          g.fillStyle = "#1D2944"; g.fillRect(bx, by, bw, 4);
          const pr = progress();
          g.fillStyle = "#22B8CF"; g.fillRect(bx, by, Math.round(bw * pr), 4); g.fillStyle = "#7FE6F4"; g.fillRect(bx, by, Math.round(bw * pr), 1);
          for (const c of checks) { const x = bx + Math.round(((c.idx - G0) / (finishIdx - G0)) * bw); g.fillStyle = c.done ? "#7FE6F4" : "#FFD27A"; g.fillRect(x, by - 2, 1, 8); }
          for (let k = 0; k < 4; k++) { g.fillStyle = k % 2 ? "#1B2133" : "#EAF0FA"; g.fillRect(bx + bw + 1, by - 2 + k * 2, 2, 2); g.fillStyle = k % 2 ? "#EAF0FA" : "#1B2133"; g.fillRect(bx + bw + 3, by - 2 + k * 2, 2, 2); }
          for (const c of cars) if (c.rival) {
            const x = bx + Math.round(clamp((c.z / SEG - G0) / (finishIdx - G0), 0, 1) * bw);
            g.fillStyle = "#05070D"; g.fillRect(x - 1, by + 5, 3, 3); g.fillStyle = c.dot; g.fillRect(x, by + 6, 1, 1); g.fillRect(x - 1, by + 5, 3, 1);
          }
          const px = bx + Math.round(pr * bw);
          g.fillStyle = "#05070D"; g.fillRect(px - 3, by - 6, 7, 5);
          g.fillStyle = "#FF6B7A"; g.fillRect(px - 2, by - 5, 5, 1); g.fillRect(px - 1, by - 4, 3, 1); g.fillRect(px, by - 3, 1, 1);
          // place
          const pl = S.finished ? S.place : placeNow();
          plate(g, 330, 2, 51, 37);
          WG.text(g, "МЕСТО", 376, 5, { align: "right", color: "#A9B6CD", shadow: sh });
          const w2 = WG.textWidth("/6", 2);
          WG.text(g, "/6", 376, 22, { align: "right", scale: 2, color: "#A9B6CD", shadow: sh });
          WG.text(g, String(pl), 376 - w2 - 2, 15, { align: "right", scale: 3, color: pl === 1 ? GOLD_T : INK_T, outline: "#05070D" });
          // stars still in reach
          const n = starsNow();
          for (let i = 0; i < 3; i++) WG.text(g, "★", 342 + i * 8, 182, { color: i < n ? "#FFD27A" : "#2C3550", shadow: sh });
        } else {
          WG.text(g, "СВОБОДНАЯ ЕЗДА", 192, 4, { align: "center", color: "#C9D6F2", shadow: sh });
          const f = forks.find((q) => !q.passed);
          if (f) {
            const prev = forks[forks.indexOf(f) - 1], from = prev ? prev.gate : G0;
            const pr = clamp((pz() / SEG - from) / (f.gate - from), 0, 1), bx = 132, bw = 120, by = 15;
            g.fillStyle = "#05070D"; g.fillRect(bx - 1, by - 1, bw + 2, 6);
            g.fillStyle = "#1D2944"; g.fillRect(bx, by, bw, 4);
            g.fillStyle = "#22B8CF"; g.fillRect(bx, by, Math.round(bw * pr), 4); g.fillStyle = "#7FE6F4"; g.fillRect(bx, by, Math.round(bw * pr), 1);
            g.fillStyle = "#FFD27A"; g.fillRect(bx + bw, by - 2, 2, 8);
          }
          WG.text(g, (Math.floor(S.dist / 100) / 10).toFixed(1).replace(".", ",") + " КМ", 192, 24, { align: "center", color: "#A9B6CD", shadow: sh });
          plate(g, 376 - Math.max(40, WG.textWidth(fmt(S.score), 2)) - 6, 2, Math.max(40, WG.textWidth(fmt(S.score), 2)) + 10, 30);
          WG.text(g, "ОЧКИ", 376, 5, { align: "right", color: "#A9B6CD", shadow: sh });
          WG.text(g, fmt(S.score), 376, 15, { align: "right", scale: 2, color: INK_T, shadow: sh });
          const best = api.best;
          if (best) WG.text(g, S.score > best ? "РЕКОРД!" : "РЕКОРД " + fmt(best), 376, 31, { align: "right", color: S.score > best ? "#FFD27A" : "#7F8FB8", shadow: sh });
        }
        // speed and revs
        const kmh = Math.round(sp * KMH);
        const segs = 16, lit = Math.round((S.rpm || 0) * segs * (S.phase === "grid" ? 0 : 1));
        for (let i = 0; i < segs; i++) {
          const on = i < lit, col = i < 9 ? "#7FE6F4" : i < 13 ? "#FFD27A" : "#FF6B7A";
          g.fillStyle = "#05070D"; g.fillRect(7 + i * 4, 179 - Math.floor(i / 3), 4, 6 + Math.floor(i / 3));
          g.fillStyle = on ? col : "#1D2944"; g.fillRect(8 + i * 4, 180 - Math.floor(i / 3), 2, 4 + Math.floor(i / 3));
        }
        WG.text(g, String(kmh), 54, 190, { scale: 3, align: "right", color: INK_T, outline: "#05070D" });
        WG.text(g, "КМ/Ч", 59, 204, { color: "#A9B6CD", shadow: sh });
        g.fillStyle = "#05070D"; g.fillRect(74, 177, 11, 11); g.fillStyle = "#1D2944"; g.fillRect(75, 178, 9, 9);
        WG.text(g, String(S.gear || 1), 80, 179, { color: "#FFD27A", align: "center" });
        WG.text(g, clockMs(S.playMs), 376, 196, { align: "right", scale: 2, color: INK_T, shadow: sh });
        // the fork ahead: where each road goes
        const i = Math.floor(pz() / SEG);
        const f = forks.find((q) => !q.side && i > q.f0 - 260 && i < q.island);
        if (f && S.phase === "race") {
          g.fillStyle = "rgba(4,7,15,.72)"; g.fillRect(0, 36, W, 13);
          WG.text(g, "← " + SCN[f.scL].name.toUpperCase(), 8, 39, { color: "#EAF0FA" });
          WG.text(g, SCN[f.scR].name.toUpperCase() + " →", 376, 39, { color: "#EAF0FA", align: "right" });
          if (Math.floor(S.t * 3) % 2) WG.text(g, "РАЗВИЛКА", 192, 39, { color: "#FFD27A", align: "center" });
        }
        // words in the middle of the screen
        for (const m of S.msgs) {
          if (m.t < 0.08) continue;
          const yy = m.y;
          WG.text(g, m.text, 192, yy, { scale: 2, align: "center", color: m.color, outline: "#05070D" });
          if (m.sub) WG.text(g, m.sub, 192, yy + 20, { align: "center", color: "#FFF0C2", outline: "#05070D" });
        }
        for (const p of S.pops) {
          const k = p.t / 1.1;
          WG.text(g, p.text, 192, p.y - Math.round(k * 16), { align: "center", color: k > 0.75 && Math.floor(p.t * 20) % 2 ? "#A9B6CD" : p.color, outline: "#05070D" });
        }
        if (S.phase === "count") countdown(g);
        if (S.phase === "finish") {
          const pl = S.place;
          WG.text(g, "ФИНИШ!", 192, 56, { scale: 4, align: "center", color: GOLD_T, outline: "#2A1E00" });
          WG.text(g, pl + "-Е МЕСТО", 192, 90, { scale: 2, align: "center", color: pl === 1 ? GOLD_T : INK_T, outline: "#05070D" });
          if (ST.fork && ST.fork.chosen) WG.text(g, "ДАЛЬШЕ: " + SCN[ST.fork.chosen].name.toUpperCase(), 192, 112, { align: "center", color: "#7FE6F4", outline: "#05070D" });
        }
      }
      function countdown(g) {
        const c = S.countT;
        // a lower third with the track's name; the start lights are on the gantry
        const k = Math.min(1, c / 0.25);
        g.fillStyle = "rgba(4,7,15,.72)"; g.fillRect(0, 98, W, Math.round(30 * k));
        g.fillStyle = "#FF6B7A"; g.fillRect(0, 98, Math.round(W * k), 1);
        if (k < 1) return;
        if (ST) {
          WG.text(g, "ТРАССА " + api.stage + " · " + SCN[ST.sc].name.toUpperCase(), 192, 102, { scale: 2, align: "center", color: INK_T, shadow: "#05070D" });
          WG.text(g, "5 СОПЕРНИКОВ · " + ((finishIdx - G0) * 1.34 / 1000).toFixed(1).replace(".", ",") + " КМ · " + ST.checks.length + (ST.checks.length > 1 ? " КОНТРОЛЬНЫЕ ТОЧКИ" : " КОНТРОЛЬНАЯ ТОЧКА"), 192, 118, { align: "center", color: "#FFD27A", shadow: "#05070D" });
        } else {
          WG.text(g, "СВОБОДНАЯ ЕЗДА", 192, 102, { scale: 2, align: "center", color: INK_T, shadow: "#05070D" });
          WG.text(g, "УСПЕВАЙ К КОНТРОЛЬНЫМ ТОЧКАМ · ВЫБИРАЙ ДОРОГУ НА РАЗВИЛКАХ", 192, 118, { align: "center", color: "#FFD27A", shadow: "#05070D" });
        }
      }
    },
  });
})();
