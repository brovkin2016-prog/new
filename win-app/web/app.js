"use strict";
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
  body.innerHTML = ""; body.append(el("h3", { text: title }));
  const close = () => (bg.hidden = true);
  fill(body, close); bg.hidden = false;
  bg.onclick = (e) => { if (e.target === bg) close(); };
}
const PHASE = { off: "Выключено", connecting: "Подключаюсь…", on: "Включено", retrying: "Переподключаюсь…" };
let S = null, appsOpen = false;
function draw(s) {
  S = s;
  const st = s.status, on = st.phase === "on", wait = st.phase === "connecting" || st.phase === "retrying";
  const active = s.conns.find((c) => c.active);
  $("#power").className = "power" + (on ? " on" : wait ? " wait" : "");
  $("#state").textContent = PHASE[st.phase] + (on && active ? (active.bridge ? " · мост " + active.service : " · сервер") : "");
  $("#note").textContent = st.note || (on ? (st.auto ? "Выбрано само: выбранный сервер не отвечает. " : "") + (st.ping ? "Отклик " + st.ping + " мс" : "") : "");
  const list = $("#conns"); list.innerHTML = "";
  if (!s.conns.length) list.append(el("div", { class: "row" }, el("div", { class: "grow", text: "Пока ни одного — вставьте ссылку из сообщения." })));
  s.conns.forEach((c, i) => {
    list.append(el("div", { class: "row conn", onclick: () => use(i, c) },
      el("span", { class: "dot" + (c.active && on ? " on" : c.chosen ? " chosen" : "") }),
      el("div", { class: "grow" }, el("b", { text: c.name }), el("small", { text: (c.bridge ? "Мост · " + c.service : "Сервер")
        + (c.active && on ? " · ● включено" : c.active ? " · подключаюсь" : c.chosen ? " · выбрано" : "") })),
      el("button", { class: "icon", title: "Ещё", text: "⋯", onclick: (e) => { e.stopPropagation(); more(i, c); } })));
  });
  document.querySelectorAll("#mode button").forEach((b) => b.classList.toggle("on", (b.dataset.only === "1") === !!s.onlyApps || (appsOpen && b.dataset.only === "1")));
  $("#auto").checked = s.auto;
  $("#ver").textContent = "Winger " + s.version + " · Проверить обновление" + (s.update && s.update.state === "downloading" ? " · загружаю новую версию…" : "");
  if (!appsOpen) drawApps();
}
async function refresh() {
  try { draw(await call("state")); } catch (e) { $("#state").textContent = "Служба Winger не отвечает"; }
}
async function use(i, c) {
  try { await call("use", { i }); toast(c.bridge ? "Включаю мост…" : "Подключаюсь…"); refresh(); } catch (e) { toast(e.message); }
}
function more(i, c) {
  sheet(c.name, (box, close) => {
    box.append(
      el("button", { class: "btn wide", text: "⚡ Проверить скорость", onclick: async () => {
        close(); toast("Меряю скорость, около 10 секунд…", 12000);
        try { const r = await call("speed", { i }); toast(`⚡ ${c.name}: ${r.mbit.toFixed(1)} Мбит/с`, 6000); } catch (e) { toast(e.message, 5000); }
      } }),
      el("button", { class: "btn line wide", text: "Удалить подключение", onclick: async () => {
        if (!confirm(`Удалить «${c.name}»?`)) return;
        close(); try { await call("remove", { i }); refresh(); } catch (e) { toast(e.message); }
      } }));
  });
}
$("#power").onclick = async () => {
  try {
    if (S && S.status.phase !== "off") await call("disconnect", {}); else await call("connect", {});
    refresh();
  } catch (e) { toast(e.message, 5000); }
};
$("#add").onclick = () => sheet("Добавить подключение", (box, close) => {
  const t = el("textarea", { placeholder: "Вставьте сообщение со ссылкой hysteria2://… или winger-bridge://…" });
  box.append(el("p", { class: "note", text: "Можно вставить сообщение целиком — ссылку я найду." }), t,
    el("button", { class: "btn wide", text: "Добавить", onclick: async () => {
      try { const r = await call("add", { text: t.value }); close(); toast((r.bridge ? "Добавлен мост «" : "Добавлен сервер «") + r.name + "»"); refresh(); }
      catch (e) { toast(e.message, 5000); }
    } }));
  navigator.clipboard && navigator.clipboard.readText().then((c) => { if (/(hysteria2|hy2|winger-bridge):\/\//i.test(c)) t.value = c; }).catch(() => {});
  t.focus();
});
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
$("#auto").onchange = async (e) => { try { await call("auto", { on: e.target.checked }); } catch (err) { toast(err.message); } };
$("#ver").onclick = async () => { await call("update", {}).catch(() => {}); toast("Проверяю обновление и мосты…"); setTimeout(refresh, 4000); };
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
