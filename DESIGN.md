---
name: Северное сияние
description: One style for the family AI helper (PWA) and the Winger VPN — a calm night sky, one «on» colour for what is switched on or listening.
colors:
  night-bg: "#0A0F1E"
  night-card: "#121B31"
  night-raise: "#17213A"
  night-well: "#1D2944"
  night-line: "#26324F"
  night-field: "#5F6F93"
  night-ink: "#EAF0FA"
  night-muted: "#A9B6CD"
  night-icon: "#7FE6F4"
  night-accent: "#34D399"
  night-accent-ink: "#05291C"
  night-accent-soft: "#123A31"
  night-me: "#24406B"
  night-bar: "#0C1326"
  night-danger: "#D93644"
  night-danger-ink: "#FF8F8F"
  dawn-bg: "#EEF2F8"
  dawn-card: "#FFFFFF"
  dawn-raise: "#F5F7FB"
  dawn-well: "#E4ECF7"
  dawn-line: "#D7DFEB"
  dawn-field: "#6E7C9B"
  dawn-ink: "#0D1630"
  dawn-muted: "#4A5670"
  dawn-icon: "#0B6E8A"
  dawn-accent: "#047857"
  dawn-accent-ink: "#FFFFFF"
  dawn-accent-soft: "#D5F3E6"
  dawn-me: "#1F3A68"
  dawn-bar: "#FFFFFF"
  dawn-danger: "#C8203F"
  dawn-danger-ink: "#B42335"
  on: "#34D399"
  on-ink: "#05291C"
  amber: "#FFD27A"
  amber-ink: "#2A1E00"
  new-badge: "#157A45"
  code-tint: "rgba(127, 127, 160, 0.16)"
  checker: "#DDDDDD"
  media-black: "#000000"
  media-scrim: "rgba(0, 0, 0, 0.6)"
  knob-shade: "rgba(0, 0, 0, 0.3)"
typography:
  display:
    fontFamily: "Onest, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "0.03em"
  title:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
  row:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.2
  label:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.2
  badge:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "0.05em"
  display-tablet:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "34px"
    fontWeight: 600
    lineHeight: 1.2
  display-landscape:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "40px"
    fontWeight: 600
    lineHeight: 1.2
  headline-tablet:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.15
  title-tablet:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 600
    lineHeight: 1.2
  title-sm:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.3
  row-lg:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 500
    lineHeight: 1.2
  row-sm:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: 1.25
  small:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.35
  glyph:
    fontFamily: "Onest, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 400
    lineHeight: 1
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  badge: "6px"
  count: "9px"
  seg-button: "12px"
  input: "14px"
  button: "16px"
  picture: "16px"
  card: "20px"
  pill: "22px"
  sheet: "24px"
  composer: "26px"
  round: "50%"
spacing:
  gutter-narrow: "12px"
  gutter: "16px"
  gutter-tablet: "32px"
  gap-sm: "8px"
  gap: "12px"
  gap-lg: "16px"
  section: "22px"
  row-min: "60px"
  touch: "44px"
components:
  button-primary:
    backgroundColor: "{colors.night-accent}"
    textColor: "{colors.night-accent-ink}"
    typography: "{typography.row}"
    rounded: "{rounded.button}"
    padding: "12px 20px"
    height: "48px"
  button-primary-dawn:
    backgroundColor: "{colors.dawn-accent}"
    textColor: "{colors.dawn-accent-ink}"
    rounded: "{rounded.button}"
    padding: "12px 20px"
    height: "48px"
  button-line:
    backgroundColor: "{colors.night-card}"
    textColor: "{colors.night-ink}"
    rounded: "{rounded.button}"
    padding: "12px 20px"
    height: "48px"
  chip:
    backgroundColor: "{colors.night-card}"
    textColor: "{colors.night-ink}"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
    height: "44px"
  chip-on:
    backgroundColor: "{colors.night-accent}"
    textColor: "{colors.night-accent-ink}"
    rounded: "{rounded.pill}"
    padding: "10px 16px"
    height: "44px"
  list-row:
    backgroundColor: "{colors.night-card}"
    textColor: "{colors.night-ink}"
    typography: "{typography.row}"
    padding: "9px 12px"
    height: "60px"
  icon-well:
    backgroundColor: "{colors.night-well}"
    textColor: "{colors.night-icon}"
    rounded: "{rounded.round}"
    size: "40px"
  orb:
    backgroundColor: "{colors.on}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.round}"
    size: "96px"
  tab-active:
    backgroundColor: "{colors.night-accent-soft}"
    textColor: "{colors.night-accent}"
    typography: "{typography.label}"
    rounded: "15px"
    width: "58px"
    height: "30px"
  composer:
    backgroundColor: "{colors.night-raise}"
    textColor: "{colors.night-ink}"
    rounded: "{rounded.composer}"
    padding: "3px"
    height: "52px"
  badge-hit:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.amber-ink}"
    typography: "{typography.badge}"
    rounded: "{rounded.badge}"
    padding: "2px 7px"
---

# Design System: Северное сияние

## Overview

**Creative North Star: "The family's night sky"**

Winger's glow became the sky the whole family lives under. Both apps — the AI helper (a PWA in the Android app and the
browser) and the Winger VPN (Android and Windows) — sit on the same calm night: deep blue-black surfaces layered by tone,
cool ink, a cyan line for icons, and one green that means *on*. The aurora is a band of light at the top of the screen,
never a texture on the controls. By day the same world turns into **dawn haze**: a cool pale sky, a rose-and-mint glow,
deep night ink; the roles stay identical, only the values change.

The people using it are a family — grandparents with a large system font, a school child, the owner on a 1280×800
tablet. The system is built for recognition rather than novelty: big rounded rows they already know from their phone's
settings, a single round thing to press and talk to, every control at least 44px, every text at AA. Expression lives in
three places only — the sky band, the «on» orb, and the emblem (the winged W shield) — everything else is quiet.

Dark is the default because the scene is evening and night at home (bedside tablet, phone on the sofa); the light «dawn
haze» follows the phone's setting or the in-app choice (Светлая / Тёмная / Как в телефоне, `data-theme` on `<html>`).

**Key Characteristics:**
- Dark-first «night», light «dawn haze», same token roles; forced colours supported.
- One «on» colour (#34D399) for switched on / listening: the helper's mic orb and Winger's power button are one object.
- Rows of one list (icon well + words + chevron) instead of tile grids; cards hold groups, never cards inside cards.
- Onest throughout; one stroke icon set on a 24px grid, no emoji as interface icons.
- The aurora is a still band behind the top of the screen; nothing in the chrome glows or animates for decoration.

## Colors

A restrained night palette: tinted neutrals do the layering, one green carries every «on» state, cyan marks icons.
Token roles (CSS custom properties in `ai-app/www/app.css`; the same names, snake-cased, in Winger's `colors.xml`):

| Role | CSS | Winger (Android) | night | dawn |
|---|---|---|---|---|
| Ground | `--bg` | `bg` | #0A0F1E | #EEF2F8 |
| Card / list | `--card` | `surf` | #121B31 | #FFFFFF |
| Raised field, composer | `--raise` | `surf2` | #17213A | #F5F7FB |
| Icon well | `--well` | `well` | #1D2944 | #E4ECF7 |
| Divider | `--line` | `line` | #26324F | #D7DFEB |
| Control edge (≥3:1) | `--field` | `line_strong` | #5F6F93 | #6E7C9B |
| Text | `--ink` | `text` | #EAF0FA | #0D1630 |
| Secondary text | `--muted` | `text2` | #A9B6CD | #4A5670 |
| Icon in a well | `--icon` | `cyan` | #7FE6F4 | #0B6E8A |
| Fill of buttons, chips, switches; accent text | `--accent` / `--accent-ink` | `accent` / `accent_ink`, `on_text` | #34D399 / #05291C | #047857 / #FFFFFF |
| Selected tint (active tab, current row) | `--accent-soft` | `on_tint` | #123A31 | #D5F3E6 |
| The «on» object (orb, power button) | `--on` / `--on-ink` | `on` / `on_ink` | #34D399 / #05291C | same |
| Your message | `--me` / `--me-ink` | — | #24406B / #F2F6FF | #1F3A68 / #FFFFFF |
| Tab bar | `--bar` | `bar` | #0C1326 | #FFFFFF |
| Danger fill / text | `--danger` / `--danger-ink` | `bad` (text) | #D93644 / #FF8F8F | #C8203F / #B42335 |
| «ХИТ» | `--amber` / `--amber-ink` | `amber` / `amber_ink` | #FFD27A / #2A1E00 | same |

### Primary
- **Aurora Green** (#34D399): «on», listening, protected. The orb and the power button are filled with it in both
  themes (dark ink on it, 8:1). In night it is also the accent for buttons, chips, switches and accent text (9.9:1 on
  the ground).
- **Deep Emerald** (#047857): the accent by day — the same role, darker for contrast (white on it 5.5:1, it on white 5.5:1).

### Secondary
- **Sky Cyan** (#7FE6F4 night / #0B6E8A dawn): icons inside their round wells and on line buttons. Never text.

### Tertiary
- **Lantern Amber** (#FFD27A on #2A1E00): only the «ХИТ» badge. **Badge Green** (#157A45, white text): only «НОВОЕ».

### Neutral
- **Night** (#0A0F1E), **Card** (#121B31), **Raised** (#17213A), **Well** (#1D2944): depth by tone, lighter = nearer.
- **Divider** (#26324F) separates; **Field** (#5F6F93) outlines a control so its edge reads at 3:1.
- **Dawn haze** (#EEF2F8 ground, #FFFFFF cards): the light theme's equivalents, listed in the table.

### Named Rules
**The One «On» Rule.** #34D399 filled means *on / listening / protected* and nothing else: the orb, the power button,
the connection in use. A decorative green is a lie about state.

**The Day Accent Rule.** By day the accent darkens to #047857; the «on» object keeps #34D399 with dark ink.

**The AA Floor Rule.** Text ≥4.5:1 on its own surface in both themes (muted on cards 7.3–8.4:1); control edges ≥3:1;
text over the sky band stays ≥4.5:1 because the band is faded behind the header and capped at 45–60% on working tabs.

## Typography

**Display Font:** Onest (with system-ui, -apple-system, Segoe UI, Roboto)
**Body Font:** Onest
**Label/Mono Font:** Onest; `ui-monospace` only for code inside answers

**Character:** Onest is a Russian humanist grotesque — round, friendly Cyrillic, clear at small sizes, warm without being
childish. One family at four weights (400 / 500 / 600 / 700) keeps both apps one voice. The helper embeds the variable
Cyrillic + Latin subsets as text (`ai-app/www/fonts.css`, OFL); Winger bundles the same face.

### Hierarchy
- **Display** (600, 28px phone / 34px portrait tablet / 40px landscape tablet, 1.2, -0.01em): the one question of a
  first screen — «Чем помочь?»; Winger's «Защищено» (700, in the «on» text colour).
- **Headline** (700, 24px / 30px landscape tablet, 1.15, +0.03em): a section that is the whole screen — «ТРЕНДЫ», written
  in capitals the way trend sites mark the section (the one capitalised heading).
- **Title** (600, 19–21px): header title, sheet title; card titles and list headings at 17px (20px on a tablet).
- **Body** (400, 16px, 1.45; answers 1.5): messages, descriptions; measure ≤ 40em for running text.
- **Row** (500, 16px; 17–18px on tablets): the words of a list row, a tile, a chip (15px).
- **Label** (500, 13px; 14px tablet): tab names, header subtitle, secondary lines 13–14px in the muted colour.
- **Badge** (700, 11px, +0.05em, capitals as written): «ХИТ», «НОВОЕ», «ИИ».

### Named Rules
**The Big Font Rule.** Every size is in px for the design, but layouts flex with the phone's font: rows go one a row when
a word no longer fits (CSS `9.6em` columns plus `fitTools()` for letter-only zoom), buttons wrap inside themselves, and
nothing is clipped at 1.3×.

**The No Shouting Rule.** No all-caps headings (the «ТРЕНДЫ» mark and the badges are the only capitals), no tracking on
body text, no gradient text. Emphasis is weight and size.

## Layout

Phone first (360–412px), one column with a 16px gutter (12px at ≤380px). Header 60px + safe area, tab bar 64px + safe
area, composer a floating pill above the tabs. Lists are the structure: a heading, then one rounded list of rows.

- **Rhythm:** 8 / 12 / 16 gaps; 22px above a section heading, 10px below it; rows ≥60px, every target ≥44px.
- **The tasks list** is two rows a line while every word fits, one a line otherwise (never more than two).
- **Tablet (≥720px):** gutter 32px, header 68px, tab bar 76px with a centred group of 120px tabs; reading column 760px
  centred; the chat's first screen and the trends widen to 1184px.
- **Landscape tablet (≥1000px, the owner's 1280×800):** the chat's first screen is two columns — orb, «Чем помочь?» and
  its line on the left (≤500px), the ready tasks two a row on the right; trends five across.
- **Safe areas:** header pads `env(safe-area-inset-top)`, tab bar and sheets pad the bottom inset.

## Elevation & Depth

Flat, tonal layering: ground → card → raised → well, each a step lighter at night (a step whiter by day), separated by
1px dividers rather than shadows. Shadows exist only for things that float above the page.

### Shadow Vocabulary
- **Lift** (`0 18px 40px -18px rgba(0,0,0,.85)` night, `0 18px 40px -20px rgba(13,22,48,.35)` dawn): sheets and the toast.
- **Orb** (`0 14px 30px -14px rgba(0,0,0,.9)` night, `… rgba(13,22,48,.45)` dawn): the orb / power button sitting on the sky.

### Named Rules
**The No Glow Rule.** No coloured halos, no neon edges, no blur-glass. The only light is the sky band itself.

**The Still Sky Rule.** The aurora (`aurora-night.svg` / `aurora-dawn.svg`, violet → green → cyan curtains with faint
vertical rays and stars, faded to nothing at its bottom) is one band behind the top of the screen: 300–320px over the
chat's first screen and Winger's main screen, ~170px over the trends, a 128px glow behind the header elsewhere (45%).
It never moves, and it is hidden in forced colours.

## Shapes

Soft and round, never sharp: circles for things you press to act (orb, round buttons, icon wells), pills for chips,
header buttons and the composer, 20px corners for cards, lists and bubbles (your bubble and the helper's pinch to 6px at
the speaker's corner), 16px for buttons and pictures, 6px for badges. Borders are 1px; a selected thing changes fill,
never border weight. No coloured side stripes.

## Components

### Buttons
- **Shape:** gently rounded (16px), 48px tall, label 600.
- **Primary:** accent fill, accent ink, icon 20px before the words.
- **Line:** card fill, 1px field edge, ink text, cyan icon.
- **Soft:** selected tint with accent text (secondary positive action, e.g. «Добавить»).
- **Danger:** danger fill with white, or danger text on a line button («Выйти»).
- **Press:** scale .98 in 120ms; disabled at 50% opacity; focus: 2px accent outline, 2px offset.

### Chips
- **Style:** pill (22px), 44px tall, card fill, 1px field edge; **on**: accent fill, accent ink, 600.
- Rows of chips scroll sideways with a fade at the edge; they never wrap off-screen.

### Cards / Containers
- **Corner Style:** 20px. **Background:** card. **Border:** 1px divider. **Shadow:** none at night, a 1px hairline by day.
- **Internal Padding:** 14–16px. Groups of rows live in one card; no card inside a card.

### Inputs / Fields
- **Style:** raised fill, 1px field edge, 14px corners, 44px tall; placeholders in the muted colour.
- **Composer:** one raised pill (26px) holding attach / camera (ghost round buttons), the text, and the main round
  button — microphone while empty, arrow once there is something to send; its edge turns accent while typing.

### Navigation
- **Tabs:** icon (22px, 24 on tablets) in a 58×30 pill + label 13px. Active: accent text 600 on the selected tint pill.
  The family has five tabs (Чат, Учёба, Фото, Видео, Ещё); the owner six (Управление before Ещё). A red dot with a
  bar-coloured ring marks a tab with something new.
- **Header:** emblem (34×30), title + one muted subtitle line, pill buttons on the right (icon + word; icon-only round
  when there is no word).

### List Row (shared with Winger)
The signature container. A row: a 38–42px round **well** (well fill, cyan icon), the words (row type; an optional muted
second line), and on the right a value, a «⋯» or a chevron. Rows divide with 1px lines inside one rounded list. The row
in use (Winger's connected bridge, the current chat) shows the selected tint, its well filled with «on» and its
second line in accent («Включено · 17 мс»).

### The Orb (signature)
The helper's microphone and Winger's power button are the same object: a circle filled with **#34D399**, dark ink icon
(38% of its size, stroke 1.9), two quiet rings (16% and 34% outside, at 42% and 16% green). 96px on a phone, 128px on a
portrait tablet, 150px landscape; Winger 120px. While recording the inner ring breathes outward (1.6s) — the only loop
in the system, and it stops under reduced motion.

### Trend Card
Picture first (2:3, 16px corners, cut from the bottom only so the picture's own «ИИ» mark at its top left stays in
sight), the name under it (500, 15–16px) with «ХИТ» (amber badge) beside the name, «НОВОЕ» (green badge) top right,
a play disc in the middle when there is an example clip.

### Icons
One set on a 24px grid: strokes 1.8 (1.9–2 on the orb and the main round button), round caps and joins, no fills
except the emblem and the play triangle, `currentColor`. Sizes: 22px tabs and rows, 20px header pills and buttons,
18px chips/acts. Inline SVG sprite (`ai-app/www/index.html`, `#i-<name>`); Winger draws the same paths as vectors.
Emoji may appear inside messages and the server's content (mode names, languages), never as interface icons.

### Motion
State changes only: 200ms `cubic-bezier(.2,.8,.2,1)` for tab pills, switches and presses; sheets rise in 240ms; the
toast fades in 200ms. `prefers-reduced-motion: reduce` turns transitions and animations off (the spinner only slows).

## Do's and Don'ts

### Do:
- **Do** use the token roles, never raw hex in components; both themes come from the same names.
- **Do** keep #34D399 for the orb / power button / connection in use, with #05291C ink.
- **Do** build screens from headings and one rounded list of rows (well + words + chevron).
- **Do** keep every target ≥44px and every text ≥4.5:1 in both themes; check the 360px phone at 1.3× font.
- **Do** keep the «ИИ» mark visible on every AI picture and «ХИТ» beside the trend's name.
- **Do** give icon-only buttons an `aria-label`; tabs and rows carry their words.

### Don't:
- **Don't** use emoji as icons in the chrome (tabs, header, composer, wells, buttons).
- **Don't** animate the aurora or put it behind controls as decoration; no glass, no glow, no gradient text.
- **Don't** use purple as the accent (the old helper's look) or a second «on» colour (Winger Android vs Windows used to
  differ).
- **Don't** nest cards, add coloured side stripes, or label a heading with a small eyebrow above it.
- **Don't** put the family's settings behind a ☰ in the header: «Ещё» is a tab.
