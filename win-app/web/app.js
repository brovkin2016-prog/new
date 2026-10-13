"use strict";
// Winger for Windows: the same screen as Winger on the phone — the big button, the connections as buttons (a tap: on
// through it, or off when it is the one in use; ⋯: the speed, the automatic choice, removing), the programs, a link
const $ = (s) => document.querySelector(s);
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
let S = null, appsOpen = false;
function draw(s) {
  S = s;
  const st = s.status, has = s.conns.length > 0, on = st.phase !== "off";
  $("#power").className = "power" + (st.phase === "on" ? " on" : on ? " wait" : "") + (has ? "" : " none");
  let t, d;
  switch (st.phase) {
    case "on": t = "Защищено"; d = "Включено " + since(st.since) + "\n↓ " + rate(s.down) + "   ↑ " + rate(s.up); break;
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
    ping.textContent = "●  " + (ms < 0 ? "Отклик: проверяю…" : ms === 0 ? "Отклик: нет ответа" : "Отклик " + ms + " мс");
    ping.className = "ping " + (ms < 0 ? "" : ms === 0 ? "bad" : ms < 150 ? "good" : ms < 400 ? "slow" : "bad");
  }
  // VK wants a person before it lets the bridge in: its check, a page of the bridge program on this computer
  const cap = /^http:\/\/127\.0\.0\.1:\d{2,5}\/$/.test(s.captcha || "") ? s.captcha : "";
  let capBox = $("#captcha");
  if (cap && !capBox) {
    capBox = el("div", { id: "captcha", class: "card" }, el("b", { text: "VK просит подтвердить, что вы не робот" }),
      el("small", { text: "Пройдите проверку — после неё мост VK подключится сам." }),
      el("button", { class: "btn wide", text: "✅ Я не робот — открыть проверку", onclick: () => window.open(capBox.dataset.url, "_blank") }));
    $("#ping").after(capBox);
  } else if (!cap && capBox) capBox.remove();
  if (cap) capBox.dataset.url = cap;  // a new check (the bridge started again) has its own page
  drawConns(s);
  $("#appsCard").hidden = !has;
  document.querySelectorAll("#mode button").forEach((b) => b.classList.toggle("on", (b.dataset.only === "1") === (!!s.onlyApps || appsOpen)));
  $("#ver").textContent = "Winger " + s.version + " · Проверить обновление" + (s.update && s.update.state === "downloading" ? " · загружаю новую версию…" : "");
  if (!appsOpen) drawApps();
}
// the connections as buttons, as on the phone: made again only when the list changes (a click is never lost to a
// redraw), their lines follow the VPN — what a tap does now, and the last speed check
let connsKey = "";
function drawConns(s) {
  const st = s.status, on = st.phase !== "off", list = $("#conns");
  const key = s.conns.map((c) => (c.bridge ? "b|" : "s|") + c.name).join("\n");
  if (key !== connsKey) {
    connsKey = key;
    list.innerHTML = "";
    s.conns.forEach((c, i) => {
      list.append(el("div", { class: "conn", onclick: () => use(i), oncontextmenu: (e) => { e.preventDefault(); remove(i, S.conns[i]); } },
        el("span", { class: "ic", text: c.bridge ? "🌉" : "🌐" }),
        el("div", { class: "grow" }, el("b", { class: "name", text: c.name }), el("small", { class: "cnote" })),
        el("button", { class: "icon", title: "Ещё", text: "⋯", onclick: (e) => { e.stopPropagation(); options(i, S.conns[i]); } })));
    });
  }
  const cur = Math.max(0, s.conns.findIndex((c) => c.chosen));
  let act = s.conns.findIndex((c) => c.active);
  if (act < 0) act = cur;
  s.conns.forEach((c, i) => {
    let note, color = "", edge = "";
    if (on && i === act && st.phase === "on") {
      note = st.auto ? "● Включено само: выбранный не отвечает" : "● Включено — нажмите, чтобы выключить";
      color = edge = "on";
    } else if (on && i === act) {
      note = st.phase === "connecting" ? "Подключаюсь…" : "Переподключаюсь…";
      color = edge = "wait";
    } else if (on && i === cur) {
      note = "Не отвечает — нажмите, чтобы попробовать снова";
      color = "wait"; edge = "chosen";
    } else {
      note = c.bridge ? "Нажмите — через " + c.service + ", когда обычный не работает" : "Нажмите, чтобы включить через этот сервер";
      if (i === cur) edge = "chosen";
    }
    // the response time: live for the one in use, else its last check (a bridge's: when it was last on)
    const pg = on && i === act && st.phase === "on" && st.ping > 0 ? "⏱ отклик " + st.ping + " мс"
      : c.ping || (c.bridge ? "⏱ отклик — когда мост включён" : "");
    if (pg) note += "\n" + pg;
    if (c.speed) note += "\n" + c.speed;
    const row = list.children[i];
    if (!row) return;
    if (row.className !== "conn " + edge) row.className = "conn " + edge;
    const n = row.querySelector(".cnote");
    if (n.textContent !== note) n.textContent = note;
    if (n.className !== "cnote " + color) n.className = "cnote " + color;
  });
}
async function refresh() {
  try { draw(await call("state")); } catch (e) { $("#state").textContent = "Служба Winger не отвечает"; }
}
// a connection's button: on through it (switching over from another one), or off when it is the one in use
async function use(i) {
  try { await call("use", { i }); refresh(); } catch (e) { toast(e.message); }
}
// ⋯ on a connection: its speed, the automatic choice (for all of them), removing this one
function options(i, c) {
  sheet(c.name, (box, close) => {
    const item = (text, fn) => el("button", { class: "menu", text, onclick: () => { close(); fn(); } });
    box.append(
      item("⚡ Проверить скорость", () => speed(i, c)),
      item((S.auto ? "✓ " : "") + "Сам выбирать рабочее подключение", async () => {
        try {
          await call("auto", { on: !S.auto });
          toast(!S.auto ? "Если выбранный не отвечает — Winger сам включит другой (мост) и вернётся, когда тот оживёт"
            : "Только выбранное подключение", 6000);
          refresh();
        } catch (e) { toast(e.message); }
      }),
      item("Удалить подключение", () => remove(i, c)),
      el("button", { class: "btn line wide", text: "Закрыть", onclick: close }));
  });
}
async function speed(i, c) {
  if (c.bridge && !(S.status.phase === "on" && c.active)) {
    toast("Скорость моста проверяется, когда он включён: включите его кнопкой и проверьте снова", 6000);
    return;
  }
  toast("⚡ Проверяю скорость «" + c.name + "»… около 10 секунд", 15000);
  try {
    const r = await call("speed", { i });
    toast("«" + c.name + "»: " + r.line, 6000);
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
async function drawApps() {
  const box = $("#apps"); box.innerHTML = "";
  if (!S || (!S.onlyApps && !appsOpen)) return;
  let procs = [];
  try { procs = (await call("processes")).processes || []; } catch (e) { /* nothing */ }
  const chosen = new Set((S.apps || []).map((a) => a.toLowerCase()));
  const names = [...new Set([...chosen, ...procs.map((p) => p.toLowerCase())])].sort();
  box.innerHTML = "";
  box.append(el("small", { class: "note", text: "Отметьте программы — через VPN пойдут только они. Список — запущенные сейчас программы." }));
  for (const n of names) {
    const cb = el("input", { type: "checkbox" }); cb.checked = chosen.has(n); cb.dataset.name = n;
    box.append(el("label", {}, cb, el("span", { text: n })));
  }
  box.append(el("button", { class: "btn wide", text: "Сохранить", onclick: async () => {
    const apps = [...box.querySelectorAll("input:checked")].map((c) => c.dataset.name);
    try { await call("apps", { only: apps.length > 0, apps }); appsOpen = false; toast(apps.length ? "Через VPN: " + apps.length + " прогр." : "Через VPN — все программы"); refresh(); }
    catch (e) { toast(e.message); }
  } }));
}
$("#mode").onclick = async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.only === "1") { appsOpen = true; draw(S); drawApps(); return; }
  appsOpen = false;
  try { await call("apps", { only: false, apps: S.apps || [] }); refresh(); } catch (err) { toast(err.message); }
};
$("#ver").onclick = async () => { await call("update", {}).catch(() => {}); toast("Проверяю обновление…"); setTimeout(refresh, 4000); };
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
