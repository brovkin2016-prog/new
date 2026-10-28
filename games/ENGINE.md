# Winger Games — how to write a game

Everything runs in the browser, plain JS, no build step, nothing loaded from outside (the server's CSP allows only
itself; no `eval`). Text files only: sprites are drawn by code, sounds are synthesised. File names `[A-Za-z0-9._-]`,
flat in `games/` (no `x.v2.js`, `.bak`, `~`); `games/dev/` and `*.md` are not shipped.

## Adding a game: two steps

1. **One entry in `registry.js`:**

```js
WG.registry.push({
  id: "tennis",                  // the id in the rating, the same as in WG.game({id})
  title: "Теннис",
  genre: "sport",                // sport | race | cards | arcade | puzzle | strategy | adventure
  levels: WG.VS_CPU,             // ["easy","normal","hard","master","adaptive"]; single-player: ["normal"]
  file: "tennis.js",             // loaded when the game is opened
  cover(g, w, h) { … },          // the card's picture on a 128×72 canvas, drawn with the helpers below
  blurb: "Одна строка о игре",
  rank: "score",                 // or "time" for patience / spider / minesweeper (finished faster is better)
  // stages: 35, stageWord: "Карта", stagesWord: "карты", endless: false,   ← a game played stage by stage
});
```

2. **The game file** (`tennis.js`), wrapped in an IIFE, calls `WG.game({...})`:

```js
WG.game({
  id: "tennis",
  portrait: false,               // false: on an upright phone it asks to turn it; true: screen on top, pad below
  controls: { dpad: true, a: "Удар", b: false, swipe: false, landscapeDpad: true },
  howto: "Отбивай мяч…",         // the start card
  keysHint: "Стрелки — ракетка, пробел — удар.",
  touchHowto: (l) => l.dpad ? "Крестовина — ракетка, кнопка — удар." : "Проведите пальцем…", // or a string
  titleColors: ["#D8FFE9", …],   // optional bands of the pixel title on the start card
  music: SONG,                   // optional loop while playing (format below)
  create(api) {
    // build the round; return the instance
    return {
      start() {},                // «Играть» pressed (count-in, music cues…)
      update(dt) {},             // fixed step, dt = 1/60 s, only while playing
      draw(g, alpha) {},         // g: the 384×216 2D context; alpha 0…1 between steps for smooth motion
      pause() {}, resume() {}, destroy() {},   // optional
    };
  },
});
```

The engine owns the screen, the loop, pause (button, Esc / P / Start, leaving the tab), the start card / **level
picker** (Лёгкий · Средний · Сложный · Мастер · Подстроиться, shown when `levels` has more than one), the **results**
screen (posts the score, shows the family's top 5 for that game and level, «Ещё раз», «Уровень», «К играм»), sign-in
and «играть без рейтинга» (guests: nothing is sent).

## Stages, stars, progress

A game played stage by stage (Змейка 10 fields, Танчики 35 maps, Арканоид 40…) says so in its registry entry:
`stages: 10, stageWord: "Поле", stagesWord: "поля", endless: "Бесконечный сад"` (`endless: false` when there is no
score mode). The engine then shows the **stage map** instead of the start card: numbered tiles with up to three stars,
locks on the stages not yet open (stage n opens once n−1 is passed), «Дальше: поле N», the endless mode, «К играм».
With `levels: WG.VS_CPU` the map also has a row «Уровень соперников» (stored per game, as on the start card); a game
that picks the level on its own card says `levelPick: "game"` and keeps `WG.runner.level` in step (Дурак, Морской бой).
`WG.fmtNum`'s thin space between thousands is drawn as the pixel font's space.

- `api.stage` — the stage being played (1…`api.stages`), or `null` in the endless mode; `api.mode` —
  `"stage" | "endless" | "single"`.
- `api.clear({stars, score, ms, line, hint, meta})` — the stage is passed: `stars` 1…3 (1 = passed; 2 and 3 for the
  game's own extra goals — time, lives, accuracy). The engine saves the progress and shows the shared **«Поле 3
  пройдено!» ★★☆** card: «Дальше», «Ещё раз», «Все поля». `line` replaces «очки · время» under the stars, `hint` says
  how to get the next star («★★★ — быстрее 0:40»).
- `api.end({line, hint})` during a stage — not passed: the «НЕ ПОЛУЧИЛОСЬ» card («Ещё раз», «Все поля»); nothing is
  saved or sent. In the endless mode `api.end` posts the score as usual.
- `WG.progress.get(game)` → `{stages: {"1": 3, "2": 1}, furthest}` (server merged with this device);
  `WG.progress.save(game, stage, stars)` → `{progress, before, improved}`; `WG.progress.local(game)` (no network),
  `.unlocked(p, n)`, `.next(p, count)`, `.totalStars(p)`. Progress lives on the server (`/api/games/progress`) and on
  the device per player; stages passed while the server could not take them go up, in order, on the next `get`.
  The server refuses stars 0 and a stage whose previous one is not passed.
- The game's page shows «Пройдено N из M ★» and two boards: «Дальше всех» (`/api/games/top?kind=furthest`) and
  «Лучший счёт».

## `api` (passed to `create`)

| | |
|---|---|
| `W`, `H` | 384, 216 |
| `level`, `levelName` | `"normal"`, `"Средний"` |
| `skill` | 0…1: easy .15, normal .45, hard .75, master 1; adaptive = the player's own rating on this device |
| `best` | the player's best for this game and level, or `null` |
| `time` | seconds of play so far (pauses excluded) |
| `input` | see below |
| `sfx(name)`, `jingle(name)`, `tone(spec)`, `music(song \| null)` | sound |
| `shake(px, sec)`, `flash(color, sec)` | screen effects |
| `stage`, `stages`, `mode`, `clear({stars, …})` | stages (above) |
| `end({score, ms, meta, won, title})` | finishes the round → results. `ms` defaults to `time`; `meta` ≤ 300 chars of JSON; `won` (true/false) feeds «Подстроиться» and the heading (ПОБЕДА / ПОРАЖЕНИЕ); `title` overrides it. Time-ranked games send `score ≥ 1` for a finished game, 0 otherwise. |

## Input — `api.input`

Buttons: `up down left right a b start`. Keyboard: arrows/WASD, Z/Space/Enter/J = a, X/Shift/K = b, Esc/P = start.
Gamepad: d-pad or left stick, A/X = a, B/Y = b, Start. Touch: the on-screen cross (slide between directions), A/B
buttons, swipes (when `controls.swipe`), taps.

- `held(b)` — down now; `pressed(b)` / `released(b)` — changed since the last step; `dir()` — the direction pressed
  this step or `null`; `any()`.
- `swipe` — `"up" | … | null` this step (a swipe also counts as `pressed(dir)`).
- `tap` — `{x, y}` in screen pixels this step, `pointer` — `{x, y, down}`.

## Drawing (all crisp: whole pixels, no smoothing)

- **Text, with Cyrillic:** `WG.text(g, "ОЧКИ 120", x, y, {color, scale, align: "left|center|right", shadow, outline, upper})`
  — `y` is the top of the capitals (7 px × scale); `color` may be a list of colours for banded lettering. Lowercase,
  digits, `.,:;!?-+=()/'"«»%×—…*<>↑↓←→♥★°·` are there. `WG.textWidth(s, scale)`; `WG.textCanvas(s, o)`.
- **Sprites:** `WG.sprite(["..aa..", ".abba."], {a: "#05291C", b: "#34D399"}, {outline: "#000"})` → canvas
  (`.` is clear; rows may be one string joined by `/`; `outline` rings the shape). `WG.frames(list, pal)`,
  `WG.flipX(c)`, `WG.flipY(c)`, `WG.rotate(c, quarterTurns)`, `WG.anim(frames, fps, t)`, `WG.draw(g, c, cx, cy)`,
  `WG.canvas(w, h)`.
- **Art kit (`WG.art`):** `sky(g, x, y, w, h, t, {seed, top, bottom, curtain, amount, still})` — the night with the
  aurora, dithered, cached; `bands(g, x, y, w, h, colors)` — 16-bit gradient; `dither(g, x, y, w, h, a, b, level)`;
  `disc`, `ellipse`; `tube(g, points, {r, outline, fill, shade, light, taper, bulge(d), marks})` — bodies, ropes;
  `ridge(g, x, y, w, h, color, seed, bottom)`, `pines(g, x, y, w, color, seed, minH, maxH)`, `moon(g, x, y, r)`.
- **Palette:** `WG.PAL` — night greys `void night deep card well line slate field mist ink`, greens `g0…g5` (`g4` is
  the «on» #34D399), cyans `c0…c4`, violets `v0…v3`, ambers `a0…a4`, reds `r0…r4`, woods `w0…w3`, stones `s0…s4`.
- **Particles:** `const fx = new WG.Particles(); fx.emit({x, y, n, colors, speed: [a, b], angle: [a, b], life: [a, b],
  gravity, drag, size, spread, shape: "dot|spark|star"}); fx.update(dt); fx.draw(g)`.
- **Parallax:** `new WG.Parallax([{img, speed: .2, y: 40}, …]).draw(g, cameraX, cameraY)` — layers tile sideways.
- `WG.rng(seed)` — a seeded random; `WG.util.clamp/lerp/ease`.

## Sound (`WG.sound`, muted state remembered)

- Effects: `blip select confirm back pause eat coin bonus powerup jump hit bounce shoot explode hurt die whoosh card
  place tick count go`; jingles: `start gameover record win lose`. Add your own: `WG.SFX.name = [tone, …]`.
- A tone: `{w: "p12|p25|p50|tri|saw|noise", f: 440 | "A4", f2 (slide), t (delay), d (length), v (0…1), a, r, sus, vib, hp, lp}`.
- Music: `{bpm, ch: [{w: "p25", v: .12, notes: "E5 . G5 - C6 …"}, {w: "noise", v: .2, notes: "k . h . s . h ."}]}` —
  one token per sixteenth, `.` rest, `-` holds; noise: `k` kick, `s` snare, `h` hat, `o` open hat. Channels loop on
  their own lengths.

## The screen

384×216, scaled by a whole number of device pixels and letterboxed (if whole steps would waste a quarter of the room,
an exact fit). Landscape: the bar (back, title, sound, pause) above the screen, or its buttons in the side margins.
Upright phone/tablet: `portrait: true` games get the screen on top and a handheld's deck below (cross pad, A/B);
`portrait: false` ones show «Поверните телефон боком». Touch devices in landscape get the pad over the screen's
corners unless `landscapeDpad: false`. The play screen is always night; the catalog follows the helper's theme.

## Checking locally

`python3 games/dev/fake_server.py` → `http://localhost:8765/dev/login` (signed in as «Тест» with a seeded family
board and progress; token `off` = games switched off, no token = sign-in screen; any `XXXX-XXXX` code signs in;
`--no-progress` answers the progress endpoints with 404, to check the on-device fallback).
`games/dev/example_vs.js` is a small vs-computer example (levels, `portrait:false`, A button, parallax): in the
console `WG.registry.push({id:"example", title:"Пинг-понг", genre:"sport", levels:WG.VS_CPU, file:"dev/example_vs.js"}); location.hash="#/play/example"`.
Expose `_state` on the instance for automated checks (`WG.runner.inst._state`), as `snake.js` does.
