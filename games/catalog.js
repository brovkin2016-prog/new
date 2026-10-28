/* Winger Games — the catalog: games by genre, the family's hall of fame, each game's page with its leaderboard,
   and the sign-in (the helper's own code from the owner's message, or «играть без рейтинга»).
   Views live in the address (#/, #/fame, #/game/snake, #/play/snake) so the phone's Back button works. */
"use strict";
(function () {
  const { el, icon } = WG.ui;
  const S = { ready: false, loading: false, error: null, off: false, genre: WG.store.get("genre", "all"), tops: {}, tab: {}, fame: null, loginMsg: "" };
  const app = document.getElementById("app");

  // ---------- data ----------
  async function load() {
    if (S.loading) return;
    S.loading = true; S.error = null;
    render();
    try {
      const [me, fame] = await Promise.all([WG.loadMe(), WG.api("/api/games/fame").catch((e) => { if (e.kind === "login" || e.kind === "off") throw e; return { items: [] }; })]);
      S.fame = WG.fame = fame.items || [];
      S.ready = true;
      void me;
      // the server's progress for games with stages: the cards' «Пройдено» lines follow it when it comes
      for (const g of WG.registry.filter((x) => x.stages)) WG.progress.get(g.id).then((p) => {
        for (const b of document.querySelectorAll('[data-prog="' + g.id + '"]')) b.textContent = progressText(g, p).passed + " из " + g.stages;
      }, () => {});
    } catch (e) {
      if (e.kind === "login") { forget(); S.loginMsg = "Вход устарел — войдите снова."; }
      else if (e.kind === "off") S.off = true;
      else S.error = e;
    }
    S.loading = false;
    render();
  }
  function forget() { try { localStorage.setItem("token", JSON.stringify("")); } catch (e) { /* private mode */ } WG.me = null; S.ready = false; }
  async function loadTop(id, level, force) {
    const key = id + "/" + level;
    if (S.tops[key] && !force && S.tops[key].state !== "error") return;
    S.tops[key] = { state: "loading" };
    paintBoard(id, level);
    try {
      const g = WG.entry(id);
      const q = level === "furthest" ? "&kind=furthest&level=" + encodeURIComponent((g && g.levels[0]) || "normal") : "&level=" + encodeURIComponent(level);
      const r = await WG.api("/api/games/top?game=" + encodeURIComponent(id) + q + "&n=20");
      S.tops[key] = { state: "done", top: r.top || [], me: r.me || null };
    } catch (e) {
      S.tops[key] = { state: "error", error: e };
    }
    paintBoard(id, level);
  }
  const famous = (id) => (S.fame || []).filter((f) => f.game === id).sort((a, b) => b.score - a.score)[0] || null;
  const myBest = (g) => {
    let best = null, lvl = null;
    for (const l of g.levels) {
      const b = WG.bestOf(g.id, l);
      if (b !== null && (best === null || b > best)) { best = b; lvl = l; }
    }
    return best === null ? null : { score: best, level: lvl };
  };

  // ---------- covers: drawn once by each game's entry ----------
  const covers = {};
  function cover(g, cls) {
    if (!covers[g.id]) {
      const c = WG.canvas(128, 72);
      try { g.cover ? g.cover(c.getContext("2d"), 128, 72) : null; } catch (e) { console.error(e); }
      covers[g.id] = c;
    }
    const c = WG.canvas(128, 72);
    c.getContext("2d").drawImage(covers[g.id], 0, 0);
    c.className = "cover" + (cls ? " " + cls : "");
    c.setAttribute("aria-hidden", "true");
    return c;
  }
  const genreOf = (id) => WG.GENRES.find((x) => x.id === id) || { id, title: id, icon: "g-arcade" };

  // ---------- the header ----------
  function header(o) {
    const top = el("header", { class: "top" });
    if (o.back) top.append(el("a", { class: "icon-btn", href: o.back, "aria-label": "Назад", onclick: (e) => { if (history.length > 1 && S.cameFromApp) { e.preventDefault(); history.back(); } } }, icon("back")));
    else top.append(el("span", { class: "mark", "aria-hidden": "true" }, icon("logo")));
    top.append(el("h1", {}, o.title, o.sub ? el("span", { class: "sub", text: o.sub }) : null));
    for (const b of o.buttons || []) top.append(b);
    return top;
  }
  const pill = (text, ic, href, extra) => el("a", Object.assign({ class: "icon-btn pill", href }, extra || {}), icon(ic), el("span", { class: "pl", text }));
  const helperBtn = () => el("a", { class: "icon-btn pill only", href: "../", "aria-label": "В помощник", title: "В помощник" }, icon("chat"));

  // ---------- views ----------
  function render() {
    const hash = location.hash || "#/";
    const parts = hash.replace(/^#\/?/, "").split("/");
    const view = parts[0] || "";
    if (view !== "play") WG.close();
    if (!WG.signedIn() && !WG.guest) return renderLogin();
    if (S.off) return renderOff();
    if (!WG.guest && !S.ready) {
      if (!S.loading && !S.error) { load(); return; }
      return renderWait();
    }
    if (view === "fame") return renderFame();
    if (view === "game" && WG.entry(parts[1])) return renderGame(WG.entry(parts[1]));
    if (view === "play" && WG.entry(parts[1])) return renderPlay(WG.entry(parts[1]));
    return renderCatalog();
  }
  function shell(cls, ...kids) {
    const s = el("div", { class: "shell " + (cls || "") }, ...kids);
    app.replaceChildren(s);
    const sc = s.querySelector(".scroll");
    if (sc) sc.scrollTop = 0;
    return s;
  }
  function renderWait() {
    const main = el("main", { class: "scroll" });
    if (S.error) {
      main.append(el("div", { class: "empty" },
        el("span", { class: "well big" }, icon("refresh")),
        el("p", { class: "empty-t", text: S.error.message }),
        el("p", { class: "empty-s", text: "Проверьте интернет и попробуйте ещё раз." }),
        el("button", { class: "btn", onclick: () => load() }, icon("refresh"), el("span", { text: "Повторить" }))));
    } else {
      main.append(el("div", { class: "skeleton" }, el("div", { class: "sk sk-h" }), el("div", { class: "sk sk-chips" }), el("div", { class: "cards" }, el("div", { class: "sk sk-card" }), el("div", { class: "sk sk-card" }), el("div", { class: "sk sk-card" }))));
    }
    shell("home", header({ title: "Игры", sub: "Winger Games", buttons: [helperBtn()] }), main);
  }

  function renderCatalog() {
    const name = WG.me && WG.me.user && WG.me.user.name;
    const buttons = WG.guest ? [pill("Войти", "key", "#/login")] : [pill("Зал славы", "trophy", "#/fame")];
    buttons.push(helperBtn());
    const main = el("main", { class: "scroll" });
    main.append(el("h2", { class: "display", text: "Во что сыграем?" }));
    if (WG.guest) main.append(el("a", { class: "note", href: "#/login" }, el("span", { class: "well" }, icon("key")),
      el("span", { class: "note-w" }, el("b", { text: "Игра без рейтинга" }), el("small", { text: "Результаты не сохраняются. Войдите, чтобы попасть в рейтинг семьи." })), icon("chev", "chev")));
    // only the genres that have games
    const genres = WG.GENRES.filter((gn) => WG.registry.some((g) => g.genre === gn.id));
    if (S.genre !== "all" && !genres.some((g) => g.id === S.genre)) S.genre = "all";
    const chips = el("div", { class: "chips", role: "tablist", "aria-label": "Жанры" });
    const chip = (id, title, ic) => el("button", { class: "chip" + (S.genre === id ? " on" : ""), role: "tab", "aria-selected": S.genre === id ? "true" : "false",
      onclick: () => { S.genre = id; WG.store.set("genre", id); renderCatalog(); } }, ic ? icon(ic) : null, el("span", { text: title }));
    chips.append(chip("all", "Все игры", "grid"));
    for (const gn of genres) chips.append(chip(gn.id, gn.title, gn.icon));
    main.append(el("div", { class: "chips-wrap" }, chips));
    const shown = S.genre === "all" ? genres : genres.filter((g) => g.id === S.genre);
    for (const gn of shown) {
      const games = WG.registry.filter((g) => g.genre === gn.id);
      const sec = el("section", { class: "genre", "aria-label": gn.title });
      sec.append(el("h3", { class: "sect" }, icon(gn.icon), el("span", { text: gn.title }), el("small", { text: String(games.length) })));
      const grid = el("div", { class: "cards" });
      for (const g of games) grid.append(card(g));
      sec.append(grid);
      main.append(sec);
    }
    shell("home", header({ title: "Игры", sub: "Winger Games" + (name ? " · " + name : ""), buttons }), main);
  }
  function card(g) {
    const fam = famous(g.id), mine = myBest(g);
    const lines = el("span", { class: "glines" });
    if (WG.guest) lines.append(el("span", { class: "gline muted", text: g.levels.length > 1 ? "Против компьютера · 5 уровней" : "Для одного игрока" }));
    else {
      lines.append(el("span", { class: "gline" }, icon("trophy"), fam ? el("span", {}, el("b", { text: g.rank === "time" ? WG.fmtTime(fam.ms) : WG.fmtNum(fam.score) }), " · " + fam.name) : el("span", { class: "muted", text: "Рекорда пока нет" })));
      if (g.stages) { const t = progressText(g, WG.progress.local(g.id)); lines.append(el("span", { class: "gline" }, icon("flag"), el("span", {}, "Пройдено ", el("b", { "data-prog": g.id, text: t.passed + " из " + g.stages })))); }
      lines.append(el("span", { class: "gline mine" }, icon("me"), mine ? el("span", {}, "Твой лучший ", el("b", { text: WG.fmtNum(mine.score) })) : el("span", { class: "muted", text: "Ты ещё не играл" })));
    }
    return el("a", { class: "gcard", href: "#/game/" + g.id },
      el("span", { class: "cover-box" }, cover(g)),
      el("span", { class: "gname", text: g.title }), lines);
  }

  // the board's tabs: «Дальше всех» for games with stages, then the score board per level
  function boardTabs(g) {
    const tabs = [];
    if (g.stages) tabs.push({ key: "furthest", label: "Дальше всех" });
    for (const l of g.levels) tabs.push({ key: l, label: g.levels.length > 1 ? WG.levelName(l) : "Лучший счёт" });
    return tabs;
  }
  function progressText(g, p) {
    const passed = Object.keys(p.stages).filter((k) => +k <= g.stages).length;
    return { passed, stars: WG.progress.totalStars(p) };
  }
  function renderGame(g) {
    const levels = g.levels, tabs = boardTabs(g);
    if (!S.tab[g.id] || !tabs.some((t) => t.key === S.tab[g.id])) {
      const saved = WG.store.get("level." + g.id, "");
      S.tab[g.id] = g.stages ? "furthest" : levels.includes(saved) ? saved : levels.includes("normal") ? "normal" : levels[0];
    }
    const level = S.tab[g.id];
    const main = el("main", { class: "scroll" });
    const play = el("a", { class: "btn wide play-btn", href: "#/play/" + g.id, onclick: () => { S.pushedPlay = true; } }, icon("play"), el("span", { text: "Играть" }));
    const mine = myBest(g);
    const facts = el("div", { class: "gfacts" });
    const progFact = el("div", { class: "gfact" });
    const paintProg = (p) => {
      const t = progressText(g, p);
      progFact.replaceChildren(el("small", { text: "Пройдено" }), el("b", { text: t.passed + " из " + g.stages }), el("span", { class: "star-n", text: "★ " + t.stars + " из " + g.stages * 3 }));
    };
    if (g.stages) { paintProg(WG.progress.local(g.id)); facts.append(progFact); }
    if (!WG.guest) {
      facts.append(el("div", { class: "gfact" }, el("small", { text: "Твой лучший" + (g.stages ? " счёт" : "") }), el("b", { text: mine ? WG.fmtNum(mine.score) : "—" }), mine && levels.length > 1 ? el("span", { text: WG.levelName(mine.level) }) : g.stages ? el("span", { text: typeof g.endless === "string" ? g.endless : "Бесконечный" }) : null));
      const fam = famous(g.id);
      if (!g.stages) facts.append(el("div", { class: "gfact" }, el("small", { text: "Рекорд семьи" }), el("b", { text: fam ? (g.rank === "time" ? WG.fmtTime(fam.ms) : WG.fmtNum(fam.score)) : "—" }), fam ? el("span", { text: fam.name }) : null));
    }
    const hero = el("div", { class: "hero" },
      el("div", { class: "hero-pic" }, cover(g, "big")),
      el("div", { class: "hero-w" },
        el("p", { class: "blurb", text: g.blurb || "" }),
        facts.childNodes.length ? facts : null,
        play));
    const boardBox = el("section", { class: "board-box", id: "board-" + g.id, "aria-label": "Рейтинг семьи" });
    boardBox.append(el("h3", { class: "sect" }, icon("people"), el("span", { text: "Рейтинг семьи" })));
    if (tabs.length > 1) {
      const seg = el("div", { class: "seg", role: "tablist", "aria-label": "Рейтинг" });
      for (const t of tabs) seg.append(el("button", { class: t.key === level ? "on" : "", role: "tab", "aria-selected": t.key === level ? "true" : "false", "data-key": t.key,
        onclick: () => { S.tab[g.id] = t.key; for (const b of seg.children) { const on = b.dataset.key === t.key; b.className = on ? "on" : ""; b.setAttribute("aria-selected", on ? "true" : "false"); } paintBoard(g.id, t.key); loadTop(g.id, t.key); } }, t.label));
      boardBox.append(el("div", { class: "seg-wrap" }, seg));
    }
    boardBox.append(el("div", { class: "board-slot" }));
    main.append(el("div", { class: "game-page" }, hero, boardBox));
    shell("sub", header({ title: g.title, sub: genreOf(g.genre).title, back: "#/", buttons: [helperBtn()] }), main);
    if (g.stages) WG.progress.get(g.id).then(paintProg, () => {});
    if (WG.guest) paintBoard(g.id, level);
    else loadTop(g.id, level);
  }
  function paintBoard(id, level) {
    const box = document.getElementById("board-" + id);
    if (!box) return;
    if (S.tab[id] && S.tab[id] !== level) return;
    const slot = box.querySelector(".board-slot");
    const g = WG.entry(id);
    if (WG.guest) {
      slot.replaceChildren(el("div", { class: "empty small" },
        el("p", { class: "empty-t", text: "Рейтинг виден после входа" }),
        el("p", { class: "empty-s", text: "Войдите кодом из сообщения владельца помощника." }),
        el("a", { class: "btn line", href: "#/login" }, icon("key"), el("span", { text: "Войти" }))));
      return;
    }
    const st = S.tops[id + "/" + level];
    if (!st || st.state === "loading") { slot.replaceChildren(el("div", { class: "board sk-board" }, ...[0, 1, 2].map(() => el("div", { class: "sk sk-row" })))); return; }
    if (st.state === "error") {
      slot.replaceChildren(el("div", { class: "empty small" }, el("p", { class: "empty-t", text: st.error.message }),
        el("button", { class: "btn line", onclick: () => loadTop(id, level, true) }, icon("refresh"), el("span", { text: "Повторить" }))));
      return;
    }
    if (!st.top.length) {
      slot.replaceChildren(el("div", { class: "empty small" }, el("p", { class: "empty-t", text: level === "furthest" ? "Пока никто не прошёл ни одного" + ((g && g.stageWord) === "Поле" ? " поля" : " уровня") : "Пока никто не играл" }), el("p", { class: "empty-s", text: "Сыграй первым — и твоё имя будет здесь." })));
      return;
    }
    const far = level === "furthest";
    const kids = [WG.ui.board(st.top, { rank: g && g.rank, kind: far ? "furthest" : "score", stageWord: g && g.stageWord })];
    const inTop = st.top.some((r) => r.me === true || (WG.me && r.name === WG.me.user.name));
    if (st.me && st.me.rank && !inTop) kids.push(el("p", { class: "board-me" }, "Ты — ", el("b", { text: WG.place(st.me.rank) }), " · " +
      (far ? (g.stageWord || "Уровень") + " " + (st.me.stage || 0) : g && g.rank === "time" ? WG.fmtTime(st.me.ms) : WG.fmtNum(st.me.score))));
    slot.replaceChildren(...kids);
  }

  function renderFame() {
    const main = el("main", { class: "scroll" });
    main.append(el("p", { class: "lead", text: "Лучший результат семьи в каждой игре." }));
    const items = (S.fame || []).filter((f) => WG.entry(f.game));
    if (!items.length) {
      main.append(el("div", { class: "empty" }, el("span", { class: "well big" }, icon("trophy")),
        el("p", { class: "empty-t", text: "Рекордов пока нет" }), el("p", { class: "empty-s", text: "Сыграйте — и первый рекорд семьи появится здесь." }),
        el("a", { class: "btn", href: "#/" }, icon("grid"), el("span", { text: "К играм" }))));
    } else {
      const list = el("div", { class: "list fame" });
      // in the order of the catalog: genre, then game
      const order = (f) => { const g = WG.entry(f.game); return WG.GENRES.findIndex((x) => x.id === g.genre) * 1000 + WG.registry.indexOf(g); };
      for (const f of items.sort((a, b) => order(a) - order(b))) {
        const g = WG.entry(f.game);
        list.append(el("a", { class: "row", href: "#/game/" + g.id },
          el("span", { class: "thumb" }, cover(g)),
          el("span", { class: "words" }, el("b", { text: g.title }), el("small", { text: [f.name, g.levels.length > 1 ? WG.levelName(f.level) : "", WG.fmtDate(f.at)].filter(Boolean).join(" · ") })),
          el("span", { class: "val" }, el("b", { text: g.rank === "time" ? WG.fmtTime(f.ms) : WG.fmtNum(f.score) }), el("small", { text: g.rank === "time" ? "время" : WG.plural(f.score, "очко", "очка", "очков") })),
          icon("chev", "chev")));
      }
      main.append(list);
    }
    shell("sub fame-v", header({ title: "Зал славы", sub: "Рекорды семьи", back: "#/", buttons: [helperBtn()] }), main);
  }

  function renderPlay(g) {
    if (WG.runner.state !== "idle" && WG.runner.entry === g) return;
    if (!document.querySelector(".shell")) renderCatalog();
    WG.open(g.id, {
      onExit: (result, wantLogin) => {
        if (result) { delete S.tops[result.game + "/" + result.level]; delete S.tops[result.game + "/furthest"]; }
        if (wantLogin) { WG.setGuest(false); S.pushedPlay = false; location.replace("#/login"); return; }
        if (S.pushedPlay) { S.pushedPlay = false; history.back(); }
        else location.replace("#/game/" + g.id);
      },
    });
  }

  // ---------- sign-in, as in the helper ----------
  const NO_CODE = "Не вижу кода. Скопируйте сообщение от владельца помощника целиком и нажмите «Вставить скопированное».";
  function renderLogin() {
    const inp = el("input", { class: "input", placeholder: "Строка из сообщения", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", "aria-label": "Строка из сообщения" });
    const err = el("div", { class: "msg-err", role: "alert", text: S.loginMsg || "" });
    const go = el("button", { class: "btn line wide" }, el("span", { text: "Войти" }));
    async function login() {
      if (!WG.parseLogin(inp.value)) { err.textContent = NO_CODE; return; }
      go.disabled = true; err.textContent = "";
      try {
        await WG.login(inp.value);
        S.loginMsg = ""; S.off = false; S.ready = false; S.error = null;
        if (/^#\/login/.test(location.hash)) location.replace("#/"); else render();
      } catch (e) {
        err.textContent = e.kind === "login" ? "Код не подошёл. Попросите у владельца новый." : e.message;
      }
      go.disabled = false;
    }
    go.onclick = login;
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
    const paste = el("button", { class: "btn wide", onclick: async () => {
      let t = "";
      try { t = window.AIBridge && window.AIBridge.clipboard ? window.AIBridge.clipboard() : await navigator.clipboard.readText(); } catch (e) { /* no access */ }
      if (!t || !t.trim()) { err.textContent = "Ничего не скопировано — скопируйте строку из сообщения или вставьте её в поле."; inp.focus(); return; }
      inp.value = t.trim();
      if (WG.parseLogin(t)) login(); else err.textContent = NO_CODE;
    } }, icon("paste"), el("span", { text: "Вставить скопированное" }));
    const guest = el("button", { class: "btn ghost wide", onclick: () => { WG.setGuest(true); S.loginMsg = ""; if (/^#\/login/.test(location.hash)) location.replace("#/"); else render(); } }, icon("play"), el("span", { text: "Играть без рейтинга" }));
    app.replaceChildren(el("div", { class: "login" },
      el("div", { class: "logo", "aria-hidden": "true" }, icon("logo")),
      el("h1", { text: "Winger Games" }),
      el("p", { text: "Игры для всей семьи с общим рейтингом: кто съел больше яблок, кто быстрее разложил пасьянс." }),
      el("p", { text: "Для входа нужен код — его присылает владелец помощника. Если помощник на этом телефоне уже открыт, вход общий." }),
      inp, err, paste, go,
      el("div", { class: "or" }, el("span", { text: "или" })),
      guest));
  }
  function renderOff() {
    const main = el("main", { class: "scroll" });
    main.append(el("div", { class: "empty" }, el("span", { class: "well big" }, icon("power")),
      el("p", { class: "empty-t", text: "Игры для этого входа выключены" }),
      el("p", { class: "empty-s", text: "Их включает владелец помощника. Попросите его, если хотите поиграть." }),
      el("a", { class: "btn line", href: "../" }, icon("chat"), el("span", { text: "В помощник" }))));
    shell("home", header({ title: "Игры", sub: "Winger Games", buttons: [helperBtn()] }), main);
  }

  // ---------- start ----------
  window.addEventListener("hashchange", () => {
    if (/^#\/login/.test(location.hash) && WG.guest) WG.setGuest(false);
    render();
  });
  window.addEventListener("storage", (e) => {
    if (e.key === "theme") WG.applyTheme();
    if (e.key === "token" && WG.runner.state === "idle") { S.ready = false; render(); }
  });
  if (/^#\/login/.test(location.hash) && WG.guest) WG.setGuest(false);
  S.cameFromApp = false;
  render();
  window.addEventListener("hashchange", () => { S.cameFromApp = true; }, { once: true });
})();
