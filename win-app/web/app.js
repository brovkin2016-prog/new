"use strict";
// Winger for Windows: the same screen as Winger on the phone (B «Северное сияние») — the big button and how it is; the
// connections in one list (a click: on through it, or off when it is the one in use; «⋯»: its speed, or removing it; a
// right click: remove it too); the settings below
const $ = (s) => document.querySelector(s);
// one of Winger's icons (the sprite in index.html: the same set as the phone's)
const icon = (name, cls) => {
  const ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg"), u = document.createElementNS(ns, "use");
  s.setAttribute("class", "i" + (cls ? " " + cls : ""));
  s.setAttribute("aria-hidden", "true");
  u.setAttribute("href", "#i-" + name);
  s.append(u);
  return s;
};
const el = (tag, props, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids) if (c !== null && c !== undefined) n.append(c);
  return n;
};
async function call(path, body) {
  const r = await fetch("/api/" + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const js = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(js.error || "Ошибка " + r.status);
  return js;
}
let toastTimer;
function toast(t, ms) {
  const n = $("#toast"); n.textContent = t; n.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (n.hidden = true), ms || 3500);
}
function sheet(title, fill) {
  const bg = $("#sheet"), body = $("#sheet-body");
  body.innerHTML = "";
  if (title) body.append(el("h3", { text: title }));
  const close = () => (bg.hidden = true);
  fill(body, close); bg.hidden = false;
  bg.onclick = (e) => { if (e.target === bg) close(); };
}
function since(t) {
  if (!t) return "сейчас";
  const min = Math.floor((Date.now() / 1000 - t) / 60);
  if (min < 1) return "только что";
  if (min < 60) return min + " мин";
  return Math.floor(min / 60) + " ч " + (min % 60) + " мин";
}
function rate(bps) {
  if (!(bps >= 1024)) return "0 КБ/с";
  if (bps < 1024 * 1024) return Math.round(bps / 1024) + " КБ/с";
  return (bps / 1024 / 1024).toFixed(1).replace(".", ",") + " МБ/с";
}
let S = null;
function draw(s) {
  S = s;
  const st = s.status, has = s.conns.length > 0, on = st.phase !== "off";
  $("#power").className = "power" + (st.phase === "on" ? " on" : on ? " wait" : "") + (has ? "" : " none");
  document.body.dataset.phase = st.phase === "on" ? "on" : on ? "wait" : "off";  // the sky follows it
  let t, d;
  switch (st.phase) {
    case "on": t = "Защищено"; d = "Включено " + since(st.since) + " · ↓ " + rate(s.down) + " · ↑ " + rate(s.up); break;
    case "connecting": t = "Подключаюсь…"; d = st.note || "Это занимает несколько секунд"; break;
    case "retrying": t = "Переподключаюсь…"; d = st.note; break;
    default:
      if (!has) { t = "Добавьте VPN"; d = "Вставьте ссылку, которую вам прислали"; }
      else { t = "Выключено"; d = st.note || "Нажмите на кнопку, чтобы включить"; }
  }
  $("#state").textContent = t;
  $("#state").className = "state" + (st.phase === "on" ? " on" : on ? " wait" : "");
  $("#note").textContent = d;
  $("#note").className = "note" + (!on && st.note ? " err" : "");
  const ping = $("#ping");
  ping.hidden = !on;
  if (on && !ping.dataset.asking) {
    const ms = st.ping;
    ping.textContent = ms < 0 ? "Отклик: проверяю…" : ms === 0 ? "Отклик: нет ответа" : "Отклик " + ms + " мс";
    ping.className = "ping " + (ms < 0 ? "" : ms === 0 ? "bad" : ms < 150 ? "good" : ms < 400 ? "slow" : "bad");
  }
  // VK wants a person before it lets the bridge in: its check, a page of the bridge program on this computer
  const cap = /^http:\/\/127\.0\.0\.1:\d{2,5}\/$/.test(s.captcha || "") ? s.captcha : "";
  let capBox = $("#captcha");
  if (cap && !capBox) {
    capBox = el("div", { id: "captcha", class: "card" }, el("b", {}, icon("shield"), "VK просит подтвердить, что вы не робот"),
      el("small", { text: "Пройдите проверку — после неё мост VK подключится сам." }),
      el("button", { class: "btn wide", text: "Я не робот — открыть проверку", onclick: () => window.open(capBox.dataset.url, "_blank") }));
    $(".hero").after(capBox);
  } else if (!cap && capBox) capBox.remove();
  if (cap) capBox.dataset.url = cap;  // a new check (the bridge started again) has its own page
  drawConns(s);
  $("#add").hidden = has;  // nothing yet: adding is the one thing to do
  $("#addRow").hidden = !has;  // (then the big button above does it)
  $("#connsHead").hidden = !has;
  $("#prep").hidden = !s.preparing;  // the laptop's own bridges being made on the server
  $("#rescue").hidden = !s.owner;  // the server owner's only
  $("#journal").hidden = !s.owner;  // the owner's only too (every Winger still sends its journal to the server by itself)
  // a list of its own for the server and for a bridge (the bridge's row once there is a bridge)
  const many = (only, list) => only && (list || []).length ? "Отмечено: " + list.length : "Все приложения";
  $("#appsRow").hidden = !has;
  $("#appsVal").textContent = many(s.onlyApps, s.apps);
  $("#bridgeAppsRow").hidden = !(s.conns || []).some((c) => c.bridge);
  $("#bridgeAppsVal").textContent = many(s.bridgeOnly, s.bridgeApps);
  const u = s.update || {};
  updating = u.state === "ready" ? Date.now() : updating;
  $("#verName").textContent = "Winger " + s.version + (u.state === "downloading" ? " · загружаю…" : u.state === "waiting" ? " · новая ждёт тихой минуты"
    : u.state === "ready" ? " · ставлю…" : "");
  $("#ver").title = u.state === "downloading" ? "Загружаю " + (u.name || "новую версию")
    : u.state === "waiting" ? "Новая версия " + (u.name || "") + " встанет сама, когда через VPN почти ничего не идёт (VPN прервётся на несколько секунд). Нажмите — поставить сейчас"
    : u.state === "ready" ? "Ставлю " + (u.name || "новую версию") + " — VPN прервётся на несколько секунд, окно обновится само" : "";
  // a new version came in (the service answers as it): the window takes its own new page, and says so once
  if (seenVersion && s.version !== seenVersion) {
    try { sessionStorage.setItem("wingerWas", seenVersion); } catch (e) { /* nothing */ }
    location.reload();
    return;
  }
  if (!seenVersion) {
    seenVersion = s.version;
    let was = "";
    try { was = sessionStorage.getItem("wingerWas") || ""; sessionStorage.removeItem("wingerWas"); } catch (e) { /* nothing */ }
    if (was && was !== s.version) toast("Winger обновился: " + s.version, 6000);
  }
}
let seenVersion = "", updating = 0;
// the connections in one list, as on the phone: made again only when the list changes (a click is never lost to a
// redraw); each row: its sign in a well (green: in use, amber: connecting, a ring: the chosen one), its name, and under it
// what it is doing now, its response time and speed (or what a bridge goes through); «⋯» at the end — speed, remove
let connsKey = "";
const short = (line) => (line || "").replace(/^⏱\s*(отклик\s*)?/, "").replace(/^⚡\s*/, "");
const first = (line) => short(line).split(" · ")[0];  // on the row: the number only (as on the phone); its time in the tooltip
function drawConns(s) {
  const st = s.status, on = st.phase !== "off", list = $("#conns");
  const key = s.conns.map((c) => (c.bridge ? "b|" : "s|") + c.name).join("\n");
  if (key !== connsKey) {
    connsKey = key;
    list.innerHTML = "";
    s.conns.forEach((c, i) => {
      list.append(el("div", { class: "conn", role: "button", tabindex: "0", onclick: () => use(i),
        onkeydown: (e) => { if (e.target !== e.currentTarget) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); use(i); } },
        oncontextmenu: (e) => { e.preventDefault(); closeMenu(); remove(i, S.conns[i]); } },
        el("span", { class: "well" }, icon(c.bridge ? "phone" : "server")),  // a bridge: through a call
        el("span", { class: "t" }, el("b", { class: "name", text: c.name }),
          el("small", { class: "cnote" }, el("span", { class: "st" }), el("span", { class: "rest" }))),
        el("button", { class: "more", title: "Скорость, удалить", "aria-label": "Скорость или удалить «" + c.name + "»",
          "aria-haspopup": "menu", "aria-expanded": "false",
          onclick: (e) => { e.stopPropagation(); openMenu(e.currentTarget, i); } }, icon("dots"))));
    });
    closeMenu();
  }
  const cur = Math.max(0, s.conns.findIndex((c) => c.chosen));
  let act = s.conns.findIndex((c) => c.active);
  if (act < 0) act = cur;
  s.conns.forEach((c, i) => {
    let chip = "", mark = "";
    if (on && i === act && st.phase === "on") { chip = st.auto ? "Включено само" : "Включено"; mark = "on"; }
    else if (on && i === act) { chip = st.phase === "connecting" ? "Подключаюсь…" : "Переподключаюсь…"; mark = "wait"; }
    else if (on && i === cur) { chip = "Не отвечает"; mark = "chosen"; }
    else if (i === cur) mark = "chosen";
    // its line: the response time (live for the one in use) and the last speed; a bridge: what it goes through
    const pg = on && i === act && st.phase === "on" && st.ping > 0 ? st.ping + " мс" : first(c.ping);
    const parts = c.foreign ? ["мост телефона — когда телефон не на нём"] : c.bridge ? ["мост через " + c.service] : [];
    if (pg) parts.push(pg);
    if (c.speed) parts.push(first(c.speed));
    const note = parts.join(" · ") || (chip ? "" : "сервер");
    const row = list.children[i];
    if (!row) return;
    const cls = ("conn " + mark).trim();
    if (row.className !== cls) row.className = cls;
    // its second line: what it is doing now (in its colour), then the numbers or what it is
    const n = row.querySelector(".cnote"), stn = n.querySelector(".st"), rest = n.querySelector(".rest");
    const tail = (chip && note ? " · " : "") + note;
    if (stn.textContent !== chip) stn.textContent = chip;
    const stc = "st " + (mark === "on" ? "on" : chip ? "wait" : "");
    if (stn.className !== stc) stn.className = stc;
    if (rest.textContent !== tail) rest.textContent = tail;
    n.title = [chip, c.ping ? short(c.ping) : "", c.speed ? short(c.speed) : ""].filter(Boolean).join(" · ") || tail;
  });
  // what a click does, said once under the list (and why another one is on by itself)
  const hint = !s.conns.length ? "" : st.auto && st.phase === "on" ? "Выбранное подключение не отвечает — Winger включил другое сам."
    : on ? "Нажмите на включённое, чтобы выключить, или на другое — чтобы перейти на него."
    : s.conns.length > 1 ? "Нажмите на подключение — Winger включится через него." : "";
  if ($("#hint").textContent !== hint) $("#hint").textContent = hint;
}
async function refresh() {
  try { draw(await call("state")); } catch (e) {
    $("#state").textContent = Date.now() - updating < 180000 ? "Winger обновляется — VPN вернётся сам" : "Служба Winger не отвечает";
  }
}
// a connection's button: on through it (switching over from another one), or off when it is the one in use
async function use(i) {
  try { await call("use", { i }); refresh(); } catch (e) { toast(e.message); }
}
async function speed(i, c) {
  if (c.bridge && !(S.status.phase === "on" && c.active)) {
    toast("Скорость моста проверяется, когда он включён: включите его кнопкой и проверьте снова", 6000);
    return;
  }
  toast("Проверяю скорость «" + c.name + "»… около 10 секунд", 15000);
  try {
    const r = await call("speed", { i });
    toast("«" + c.name + "»: " + short(r.line), 6000);
  } catch (e) { toast("«" + c.name + "»: не получилось проверить", 6000); }
  refresh();
}
function remove(i, c) {
  sheet("", (box, close) => {
    box.append(el("p", { class: "ask", text: "Удалить подключение «" + c.name + "» из приложения?" }),
      el("div", { class: "pair" },
        el("button", { class: "btn line", text: "Отмена", onclick: close }),
        el("button", { class: "btn danger", text: "Удалить", onclick: async () => {
          close();
          try { await call("remove", { i }); refresh(); } catch (e) { toast(e.message); }
        } })));
  });
}
// a connection's «⋯»: a small menu by it — «Скорость», «Удалить» (Esc, a click elsewhere or scrolling closes it)
let menuFor = -1;
function openMenu(btn, i) {
  const m = $("#menu");
  if (!m.hidden && menuFor === i) { closeMenu(); return; }
  closeMenu();
  menuFor = i;
  m.hidden = false;
  const r = btn.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
  const below = r.bottom + h + 8 <= window.innerHeight;
  m.style.top = (window.scrollY + (below ? r.bottom + 4 : r.top - h - 4)) + "px";
  m.style.left = Math.max(8, window.scrollX + r.right - w) + "px";
  btn.setAttribute("aria-expanded", "true");
  m.querySelector("button").focus({ preventScroll: true });
}
function closeMenu() {
  const m = $("#menu");
  if (m.hidden) return;
  m.hidden = true;
  menuFor = -1;
  document.querySelectorAll(".more[aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));
}
$("#menu").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const i = menuFor, c = S && S.conns[i];
  closeMenu();
  if (!c) return;
  if (b.dataset.act === "speed") speed(i, c); else remove(i, c);
};
document.addEventListener("click", (e) => { if (!e.target.closest("#menu, .more")) closeMenu(); });
document.addEventListener("keydown", (e) => {
  const m = $("#menu");
  if (m.hidden) return;
  if (e.key === "Escape") {
    const back = document.querySelector(".more[aria-expanded='true']");
    closeMenu();
    if (back) back.focus();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const items = [...m.querySelectorAll("button")], at = items.indexOf(document.activeElement);
    items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
  }
});
window.addEventListener("scroll", closeMenu, { passive: true });
window.addEventListener("resize", closeMenu);
function paste() {
  sheet("Ссылка VPN", (box, close) => {
    const t = el("textarea", { placeholder: "hysteria2://…" });
    const add = async () => {
      try {
        const r = await call("add", { text: t.value });
        close();
        toast((r.bridge ? "Добавлен мост «" : "Добавлен сервер «") + r.name + "»");
        refresh();
      } catch (e) { toast(e.message, 6000); }
    };
    box.append(el("p", { class: "note", text: "Вставьте ссылку из сообщения. Можно вставить сообщение целиком — ссылку я найду." }), t,
      el("div", { class: "pair" }, el("button", { class: "btn line", text: "Отмена", onclick: close }), el("button", { class: "btn", text: "Добавить", onclick: add })));
    navigator.clipboard && navigator.clipboard.readText().then((c) => { if (/(hysteria2|hy2|winger-bridge):\/\//i.test(c)) t.value = c; }).catch(() => {});
    t.focus();
  });
}
$("#power").onclick = async () => {
  if (!S || !S.conns.length) { paste(); return; }
  try {
    if (S.status.phase !== "off") await call("disconnect", {}); else await call("connect", {});
    refresh();
  } catch (e) { toast(e.message, 5000); }
};
// a click on the response time: «Проверяю отклик…» until the new one comes (the service answers when it knows)
$("#ping").onclick = async () => {
  const p = $("#ping");
  if (!S || S.status.phase !== "on" || p.dataset.asking) return;
  p.dataset.asking = "1";
  p.textContent = "Проверяю отклик…";
  p.className = "ping";
  try { await call("ping", {}); } catch (e) { /* the next look shows it */ }
  delete p.dataset.asking;
  refresh();
};
$("#add").onclick = paste;
$("#addRow").onclick = paste;
// «Какие приложения» / «Приложения через мост»: all programs, or only the ticked ones — the standard ones ticked from the start, then
// the programs running now and those ticked before
function appsSheet(bridge) {
  sheet(bridge ? "Какие приложения через мост" : "Какие приложения через сервер", (box, close) => {
    let only = !!(bridge ? S.bridgeOnly : S.onlyApps);
    const mine = (bridge ? S.bridgeApps : S.apps) || [], std = ((S.standard || {})[bridge ? "bridge" : "server"]) || [];
    const seg = el("div", { class: "seg", id: "mode" },
      el("button", { "data-only": "0", text: "Все приложения" }), el("button", { "data-only": "1", text: "Только выбранные" }));
    const list = el("div", { class: "apps", id: "apps" });
    const mark = () => seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", (b.dataset.only === "1") === only));
    const fill = async () => {
      list.innerHTML = "";
      if (!only) { list.append(el("small", { class: "note", text: (bridge ? "Через мост" : "Через сервер") + " идут все приложения этого компьютера." })); return; }
      let procs = [];
      try { procs = (await call("processes")).processes || []; } catch (e) { /* nothing */ }
      if (!only) return;  // switched back while the list was coming
      const chosen = new Set(mine.map((a) => a.toLowerCase()));
      const rest = [...new Set([...chosen, ...procs.map((p) => p.toLowerCase())])].filter((n) => !std.includes(n)).sort();
      const names = [...std, ...rest];  // the standard ones first, then the chosen and running ones
      list.innerHTML = "";
      list.append(el("small", { class: "note", text: bridge
        ? "Мост медленный: мессенджеры, ИИ и браузеры — да, музыку и видео лучше не пускать. Отметьте любые другие приложения."
        : "Через сервер — отмеченные приложения; русские сайты в браузерах (банки, Госуслуги) идут напрямую. Отметьте любые другие приложения." }));
      for (const n of names) {
        const cb = el("input", { type: "checkbox" }); cb.checked = chosen.has(n); cb.dataset.name = n;
        list.append(el("label", {}, cb, el("span", { text: n })));
      }
    };
    seg.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; only = b.dataset.only === "1"; mark(); fill(); };
    box.append(seg, list, el("div", { class: "pair" }, el("button", { class: "btn line", text: "Отмена", onclick: close }),
      el("button", { class: "btn", text: "Сохранить", onclick: async () => {
        const apps = only ? [...list.querySelectorAll("input:checked")].map((c) => c.dataset.name) : mine;
        try {
          await call("apps", { bridge: !!bridge, only: only && apps.length > 0, apps });
          close();
          const where = bridge ? "Через мост" : "Через сервер";
          toast(only && apps.length ? where + ": отмечено " + apps.length : where + " — все приложения");
          refresh();
        } catch (e) { toast(e.message); }
      } })));
    mark(); fill();
  });
}
$("#appsRow").onclick = () => appsSheet(false);
$("#bridgeAppsRow").onclick = () => appsSheet(true);
// «Проверить обновление»: the family server is asked; what came of it is said (newest already, a new one coming, or why not)
$("#ver").onclick = async () => {
  const b = $("#ver");
  if (b.disabled) return;
  b.disabled = true;
  const t0 = Math.floor(Date.now() / 1000) - 1;
  toast("Проверяю обновление…", 30000);
  try {
    await call("update", {});
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = await call("state");
      const u = st.update || {};
      if ((u.checked || 0) < t0 && u.state !== "downloading") continue;
      draw(st);
      if (u.state === "latest") toast("У вас последняя версия — Winger " + st.version, 4000);
      else if (u.state === "downloading") toast("Есть новая версия " + (u.name || "") + " — загружаю и ставлю; VPN прервётся на несколько секунд", 7000);
      else if (u.state === "ready") toast("Ставлю новую версию " + (u.name || "") + " — VPN прервётся на несколько секунд, окно обновится само", 7000);
      else if (u.state === "waiting") continue;
      else if ((u.state || "").startsWith("failed: ")) toast("Не получилось: " + u.state.slice(8), 7000);
      else continue;
      return;
    }
    toast("Сервер не ответил — попробуйте ещё раз через минуту", 5000);
  } catch (e) { toast(e.message); } finally { b.disabled = false; }
};
$("#rescue").onclick = async () => {
  toast("Открываю спасательную консоль…", 20000);
  try {
    const r = await call("rescue", {});
    window.open(r.url, "_blank");
    toast("Консоль открыта в браузере", 4000);
  } catch (e) { toast(e.message, 8000); }
};
$("#journal").onclick = async () => {
  toast("Проверяю связь с сервером…", 10000);
  try {
    const r = await call("journal");
    await navigator.clipboard.writeText(r.text);
    toast("Скопировано — вставьте в чат. Ключей и адресов в нём нет", 5000);
  } catch (e) { toast(e.message); }
};
refresh();
setInterval(refresh, 1500);
// every server's response time when the window opens or comes back (the service asks at most once a minute)
const pingAll = () => call("pingall", {}).catch(() => {});
pingAll();
document.addEventListener("visibilitychange", () => { if (!document.hidden) pingAll(); });
window.addEventListener("focus", pingAll);
// Winger's own window (opened as «…#win») is 500×900; on a small laptop screen (or at 125–150 %) its bottom would be
// past the screen's edge with no way to scroll to it: made to fit the screen above the taskbar
function fitScreen() {
  if (location.hash !== "#win") return;
  const left = screen.availLeft || 0, top = screen.availTop || 0;
  const w = Math.min(window.outerWidth, screen.availWidth), h = Math.min(window.outerHeight, screen.availHeight);
  try {
    if (w < window.outerWidth || h < window.outerHeight) window.resizeTo(w, h);
    const x = Math.min(Math.max(window.screenX, left), left + screen.availWidth - w);
    const y = Math.min(Math.max(window.screenY, top), top + screen.availHeight - h);
    if (x !== window.screenX || y !== window.screenY) window.moveTo(x, y);
  } catch (e) { /* a browser tab: nothing to fit */ }
}
fitScreen();
