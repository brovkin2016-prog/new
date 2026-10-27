/* «Управление»: the owner's tab (the server, VPN for the family, the app's people). It is not part of the app the
   family installs: the server hands this file only to the owner's signed-in app (/api/owner_ui), which runs it with
   its own helpers. A family member's phone never gets it. */
(function (A) {
  "use strict";
  const { Native, S, api, ask, blobOf, confirmBox, copyText, el, nativeCall, problem, refreshTop, shareBlob, sheet, store, stream, toast, urlOf, viewer } = A;

  // ---------- the internet for the owner's mini-apps ----------
  // A mini-app's frame reaches only the few sites that let any page read them (and none on a day without mobile
  // internet); its fetch() then asks here («__maf», put into its page by the server) and the family server fetches the
  // site for it. Only the mini-app on the screen is listened to; the server allows only public sites, no cookies.
  if (!window.__maFetch) {
    window.__maFetch = true;
    window.addEventListener("message", async (e) => {
      const d = e.data;
      if (!d || d.__maf !== 1) return;
      const frame = [...document.querySelectorAll(".ma-view iframe")].find((f) => f.contentWindow === e.source);
      if (!frame) return;
      const reply = (ok, v) => { try { e.source.postMessage({ __maf: 1, id: d.id, ok, v }, "*"); } catch (er) { /* closed */ } };
      try {
        const r = await api("/api/miniapps", { op: "miniapp_fetch", url: String(d.url || ""), method: String(d.method || "GET"),
          headers: d.headers && typeof d.headers === "object" ? d.headers : {}, body: typeof d.body === "string" ? d.body : null });
        if (r.t === "done") reply(true, r); else reply(false, r.text || "не открылось");
      } catch (er) { reply(false, problem(er)); }
    });
  }

  // ---------- the owner's «Управление» tab: the server, VPN access and the app's people ----------
  function bytes(n) {
    n = +n || 0;
    for (const u of ["Б", "КБ", "МБ", "ГБ"]) { if (n < 1024) return (u === "Б" ? n : n.toFixed(1)) + " " + u; n /= 1024; }
    return n.toFixed(1) + " ТБ";
  }
  function ago(ts) {
    const s = Math.max(0, Date.now() / 1000 - ts);
    return s < 3600 ? Math.max(1, Math.round(s / 60)) + "\u00a0мин" : s < 86400 ? Math.round(s / 3600) + "\u00a0ч" : Math.round(s / 86400) + "\u00a0дн.";
  }
  function when(ts) {  // "сегодня 14:05", "вчера 09:12", "3 окт 18:40"
    const d = new Date(ts * 1000), now = new Date();
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
    return days === 0 ? "сегодня " + hm : days === 1 ? "вчера " + hm
      : d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", "") + " " + hm;
  }
  // the owner's tabs are lists of short rows: an icon, what it is with one small line under it, its value or button on
  // the right; a tap on a row — its details and actions in a sheet
  if (!document.getElementById("owner-css")) {
    document.head.append(el("style", { id: "owner-css", text: `
.seg.ow-seg { gap: 2px; }
.seg.ow-seg button { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
  min-width: 0; padding: 5px 0; font-size: 11px; line-height: 1.15; overflow: hidden; }
.seg.ow-seg button.on { font-weight: 500; }
.seg.ow-seg .ow-segi { font-size: 18px; line-height: 1.1; }
.ow-dot { position: absolute; top: 2px; right: 4px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: var(--danger);
  color: #fff; font-size: 11px; font-weight: 700; line-height: 16px; text-align: center; }
.ow-sec { display: flex; align-items: center; gap: 8px; margin: 14px 4px 6px; font-size: 13px; font-weight: 600; color: var(--muted); }
.ow-sec .grow { flex: 1; min-width: 0; }
.ow-list { background: var(--card); border-radius: var(--r); box-shadow: var(--shadow); padding: 0 12px; margin-bottom: 10px; }
.ow-row { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 8px 0; }
.ow-row + .ow-row { border-top: 1px solid var(--line); }
.ow-row[role=button] { cursor: pointer; }
.ow-row[role=button]:active { opacity: .7; }
.ow-ic { width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; font-size: 16px; flex: none; background: var(--accent-soft); }
.ow-ic.ok { background: rgba(31, 157, 107, .15); }
.ow-ic.bad { background: rgba(200, 32, 63, .15); }
.ow-ic.warn { background: rgba(234, 179, 8, .2); }
.ow-ic.off { background: var(--line); }
.ow-t { flex: 1; min-width: 0; font-size: 15px; line-height: 1.3; overflow-wrap: anywhere; }
.ow-t small { display: block; color: var(--muted); font-size: 13px; line-height: 1.35; margin-top: 1px; }
.ow-t small.bad { color: var(--danger-ink); }
.ow-t small.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.ow-v { flex: none; max-width: 46%; font-size: 14px; color: var(--muted); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ow-v.ok { color: var(--ok); }
.ow-v.bad { color: var(--danger-ink); font-weight: 600; }
.ow-go { flex: none; color: var(--muted); font-size: 20px; line-height: 1; }
.ow-btn { flex: none; min-height: 40px; padding: 6px 12px; border-radius: 12px; font-size: 14px; font-weight: 500; background: var(--accent-soft); color: var(--accent); }
.ow-btn.line { background: transparent; border: 1px solid var(--field); color: var(--ink); }
.ow-btn.main { background: var(--accent); color: var(--accent-ink); }
.ow-btn:disabled { opacity: .5; }
.ow-bar { height: 5px; border-radius: 3px; background: var(--line); overflow: hidden; margin-top: 5px; }
.ow-bar > i { display: block; height: 100%; }
.ow-status { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--r); margin-bottom: 10px; font-size: 15px;
  background: rgba(31, 157, 107, .12); }
.ow-status.bad { background: rgba(200, 32, 63, .12); }
.ow-status.off { background: var(--line); }
.ow-note { margin: 6px 4px 10px; font-size: 13px; line-height: 1.4; color: var(--muted); }
.ow-acts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0 0 10px; }
.ow-acts > * { min-height: 44px; padding: 8px 10px; font-size: 14px; }
.ow-foot { position: sticky; bottom: -16px; margin: 0 -12px 10px; padding: 10px 12px 14px; background: var(--bg); }
.ow-model { display: block; width: 100%; min-height: 36px; margin: 0 0 10px; padding: 6px 4px; text-align: left; font-size: 13px; color: var(--muted); }
details.ow-more > summary { list-style: none; cursor: pointer; }
details.ow-more > summary::-webkit-details-marker { display: none; }
details.ow-more > summary .ow-go { transition: transform .15s; }
details.ow-more[open] > summary .ow-go { transform: rotate(90deg); }
` }));
  }
  // a row: [icon, its tone] · title · small line (a string, or [text, "bad"]) · right side (a value, a button) · tap
  function line(icon, title, sub, right, tap, tone) {
    const small = Array.isArray(sub) ? el("small", { class: sub[1] || "", text: sub[0] }) : sub ? el("small", { text: sub }) : null;
    return el("div", { class: "ow-row", role: tap ? "button" : null, tabindex: tap ? "0" : null, onclick: tap || null },
      el("span", { class: "ow-ic" + (tone ? " " + tone : ""), text: icon }), el("div", { class: "ow-t" }, title, small),
      right === undefined || right === null ? null : typeof right === "string" ? el("span", { class: "ow-v", text: right }) : right,
      tap ? el("span", { class: "ow-go", text: "›" }) : null);
  }
  const value = (text, tone) => el("span", { class: "ow-v" + (tone ? " " + tone : ""), text });
  const section = (text, right) => el("div", { class: "ow-sec" }, el("span", { class: "grow", text }), right || null);
  function badge(n) {  // a red count on the Управление tab
    const tab = document.querySelector('.tab[data-tab="vpn"]');
    if (!tab) return;
    let b = tab.querySelector(".badge");
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = el("span", { class: "badge" }); tab.append(b); }
    b.textContent = n > 9 ? "9+" : String(n);
  }
  // the owner's tab «Управление»: the server, VPN for family, and who may use this app (never in a family member's app)
  function vpnView() {
    const root = el("div", { class: "view" });
    const scroll = el("div", { class: "scroll" });
    root.append(scroll);
    let part = store.get("accessPart", "server"), open = false;
    const cache = { server: null, vpn: null, app: null, claude: null, patrol: null };
    const OPS = { server: "status", vpn: "users", app: "app_list", claude: "agent_state", patrol: "agent_patrol_items" };
    const TABS = [["server", "🖥", "Сервер"], ["vpn", "🛡", "VPN"], ["app", "🤖", "Помощник"], ["claude", "🛠", "Claude"], ["patrol", "🔍", "Дозор"]];
    if (!TABS.some(([k]) => k === part)) part = "server";
    let data = null, segDot = null;
    const panel = (body, onStatus) => stream("/api/panel", body, (ev) => { if (ev.t === "status" && onStatus) onStatus(ev.text); });
    function enter() {  // only the owner has this tab, on the owner's own phone: it opens at once, no fingerprint
      open = true;
      load();
      if (part !== "patrol") panel({ op: OPS.patrol }).then((end) => { if (end.t === "done") { cache.patrol = end; dot(); } }).catch(() => {});
    }
    async function load() {
      if (!open) return;
      const want = part;
      if (!cache[want]) { draw(); scroll.append(el("div", { class: "status", style: "padding:20px" }, el("span", { class: "spin" }), "Загружаю…")); }
      try {
        const body = want === "claude" ? { op: OPS.claude, chat: claude.chat || undefined } : { op: OPS[want] };
        const end = await panel(body);
        if (end.t !== "done" && want === "claude") { cache.claude = { t: "done", installed: false, why: end.text }; if (part === want) draw(); return; }
        if (end.t !== "done" && want === "patrol") { cache.patrol = { t: "done", none: true, why: end.text }; if (part === want) draw(); return; }
        if (end.t !== "done") throw Object.assign(new Error(end.text || "Не получилось."), { said: true });
        cache[want] = end;
        if (part === want) draw();
      } catch (e) {
        const why = e.said ? "⚠️ " + e.message : problem(e);
        if (!cache[want]) { draw(); scroll.append(el("p", { class: "status", style: "padding:12px", text: why })); } else toast(why);
      }
    }
    // the patrol's findings that wait for the owner: a red count on «🔍 Дозор»
    const waiting = () => ((cache.patrol && cache.patrol.items) || []).filter((x) => x.status === "new").length;
    function dot() {
      if (!segDot) return;
      const n = waiting();
      segDot.textContent = n > 9 ? "9+" : String(n);
      segDot.style.display = n ? "" : "none";
    }
    function go(k) { part = k; store.set("accessPart", k); refreshTop(); draw(); load(); }
    function draw() {
      const keep = part === draw.last ? scroll.scrollTop : 0;  // a redraw of the same tab stays where the owner was
      draw.last = part;
      clearTimeout(draw.tick);
      scroll.innerHTML = "";
      if (claude.composer) { claude.composer.remove(); claude.composer = null; }
      const seg = el("div", { class: "seg ow-seg", style: "margin-bottom:12px", role: "tablist" });
      for (const [k, ic, name] of TABS) {
        const b = el("button", { class: k === part ? "on" : "", role: "tab", "aria-selected": k === part ? "true" : "false", "data-part": k, onclick: () => go(k) },
          el("span", { class: "ow-segi", "aria-hidden": "true", text: ic }), " ", el("span", { text: name }));
        if (k === "patrol") { segDot = el("span", { class: "ow-dot", "aria-label": "ждут решения" }); b.append(segDot); }
        seg.append(b);
      }
      scroll.append(seg);
      dot();
      data = cache[part];
      if (!data) return;
      if (part === "app") drawApp(data);
      else if (part === "server") drawServer(data);
      else if (part === "claude") return drawClaude(data);
      else if (part === "patrol") drawPatrol(data);
      else drawVpn(data);
      if (keep) scroll.scrollTop = keep;
    }
    // «🛡 VPN»: who has it, the apps to give, the bridges
    function drawVpn(data) {
      const on = data.users.filter((u) => u.online).length;
      scroll.append(el("div", { class: "ow-status" + (data.vpn ? "" : " bad") },
        el("span", { class: "ow-ic " + (data.vpn ? "ok" : "bad"), text: data.vpn ? "🟢" : "🔴" }),
        el("div", { class: "ow-t" }, data.vpn ? "VPN работает" : "VPN не работает",
          el("small", { text: data.host + " · людей " + data.users.length + (data.stats ? ", в сети " + on : "") }))),
        el("button", { class: "btn wide", style: "margin:0 0 8px", text: "➕ Выдать VPN", onclick: add }),
        el("div", { class: "ow-acts" },
          el("button", { class: "btn line", text: "📱 Winger Android", onclick: () => makeLink({ op: "dl_vpnapp" }, "Приложение Winger VPN") }),
          el("button", { class: "btn line", text: "💻 Winger Windows", onclick: () => makeLink({ op: "dl_winapp" }, "Winger для Windows") })));
      const list = el("div", { class: "ow-list" });
      for (const u of data.users) {
        const sub = [u.online ? "в сети" : "не в сети", u.laptop ? (u.laptop.online ? "💻 в сети" : "💻") : "",
          u.until ? "⏰ гость до " + when(u.until) : "", u.bridge ? "🌉 мост" : ""].filter(Boolean).join(" · ");
        list.append(line(u.online ? "🟢" : "⚪", u.name + (u.owner ? " 👑" : ""), sub, null, () => card(u.name), u.online ? "ok" : "off"));
      }
      scroll.append(section("Кому выдан VPN · " + data.users.length), list);
      // the bridges live with the VPN (the server's list of them comes with its state)
      const br = el("div");
      scroll.append(br);
      const putBridges = (st) => { br.innerHTML = ""; br.append(...bridgesCard(st)); };
      if (cache.server && cache.server.bridges) putBridges(cache.server);
      panel({ op: OPS.server }).then((end) => { if (end.t === "done") { cache.server = end; if (br.isConnected) putBridges(end); } }).catch(() => {});
    }
    // a temporary link (24 h) for downloading an app or connecting the VPN: copied and sent however the owner likes
    // ---- links that open everywhere in Russia: a folder on the owner's Yandex Disk, deleted after 24 hours ----
    const diskRows = new Set();  // every «📦 Яндекс Диск» row on screen: all of them change when the Disk is connected
    function diskSetup(d, after) {
      sheet("📦 Яндекс Диск для ссылок", (box, close) => {
        const inp = el("input", { class: "input", placeholder: "Вставьте токен", autocomplete: "off", spellcheck: "false" });
        const connect = async () => {
          const token = inp.value.trim();
          if (!token) { toast("Сначала вставьте токен"); return; }
          toast("⏳ Проверяю токен…", 20000);
          try {
            const end = await panel({ op: "disk_set", token });
            if (end.t !== "done") { toast("⚠️ " + end.text, 6000); return; }
            toast(`✅ Подключён: ${end.login || "Яндекс Диск"}` + (end.free_gb !== undefined ? ` · свободно ${end.free_gb} ГБ` : ""), 5000);
            close();
            diskRows.forEach((f) => f(end));
            if (after) after(end);
          } catch (e) { toast(problem(e)); }
        };
        box.append(
          el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 12px", text: "Ссылки на 24 часа будут лежать на вашем Яндекс Диске: "
            + "открываются в любом браузере в России, с VPN и без, и сами удаляются. Лучше завести для этого отдельный аккаунт Яндекса." }),
          el("ol", { style: "margin:0 0 12px;padding-left:20px;font-size:15px;line-height:1.5" },
            el("li", { text: "Нажмите «Получить токен» — откроется сайт Яндекса." }),
            el("li", { text: "Там нажмите «Получить OAuth-токен», войдите в Яндекс и скопируйте токен (длинная строка)." }),
            el("li", { text: "Вернитесь сюда, вставьте токен и нажмите «Подключить»." })),
          el("a", { class: "btn line wide", href: d.page || "https://yandex.ru/dev/disk/poligon/",
            style: "display:block;text-align:center;text-decoration:none;margin-bottom:10px", text: "🔑 Получить токен" }),
          inp,
          el("button", { class: "btn soft wide", style: "margin-top:8px", text: "📋 Вставить из буфера", onclick: async () => {
            let t = "";
            try { t = Native && Native.clipboard ? Native.clipboard() : await navigator.clipboard.readText(); } catch (e) { /* no access */ }
            if (t) inp.value = t.trim(); else toast("В буфере ничего нет — вставьте вручную");
          } }),
          el("button", { class: "btn wide", style: "margin-top:8px", text: "✅ Подключить", onclick: connect }),
          d.on ? el("button", { class: "btn line wide", style: "margin-top:14px;color:var(--danger-ink)", text: "Отключить Яндекс Диск", onclick: async () => {
            try {
              const end = await panel({ op: "disk_off" });
              close();
              diskRows.forEach((f) => f(end));
              if (after) after(end);
              toast("Отключён: ссылки не делаются, пока не подключите снова");
            } catch (e) { toast(problem(e)); }
          } }) : "");
      });
    }
    async function makeLink(body, title) {
      if (S.busy.vpn) return;
      S.busy.vpn = true;
      toast("⏳ Готовлю ссылку…", 120000);
      try {
        const end = await panel(body, (t) => toast("⏳ " + t.replace(/^\S+\s/, ""), 120000));
        if (end.need_disk) {  // no Disk yet: connect it, then the same link is made at once
          document.querySelectorAll(".toast").forEach((t) => t.remove());
          diskSetup(end.yadisk || {}, (d) => { if (d.on) setTimeout(() => makeLink(body, title), 300); });
          return;
        }
        if (end.t !== "done") { toast("⚠️ " + end.text, 6000); return; }
        document.querySelectorAll(".toast").forEach((t) => t.remove());
        const until = new Date(end.exp * 1000).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
        const msg = end.text || end.url;
        sheet("🔗 " + title, (box) => {
          box.append(
            el("div", { style: "font-size:14px;margin:-6px 0 10px;color:var(--muted)",
              text: `На Яндекс Диске: откроется в любом браузере в России, с VPN и без. Удалится ${until}.` }),
            el("div", { style: "font:14px/1.45 system-ui,sans-serif;white-space:pre-wrap;word-break:break-word;background:var(--card);border-radius:12px;padding:12px;margin-bottom:12px;user-select:all", text: msg }),
            el("button", { class: "btn wide", text: "📋 Копировать сообщение", onclick: () => { copyText(msg); toast("✅ Скопировано — отправьте как удобно"); } }),
            el("button", { class: "btn line wide", style: "margin-top:8px", text: "📋 Только ссылку", onclick: () => { copyText(end.url); toast("✅ Ссылка скопирована"); } }),
            el("a", { class: "btn line wide", href: end.url, style: "display:block;text-align:center;text-decoration:none;margin-top:8px", text: "👀 Открыть и посмотреть" }));
        });
      } catch (e) { toast(problem(e)); } finally { S.busy.vpn = false; }
    }
    async function delVpn(name) {
      if (S.busy.vpn || !(await confirmBox(`Удалить «${name}»? Его VPN сразу перестанет работать.`, "Удалить"))) return;
      S.busy.vpn = true;
      toast("⏳ Удаляю «" + name + "»…", 20000);
      try {
        const end = await panel({ op: "del", name });
        toast(end.t === "done" ? "🗑 Удалён: " + name : "⚠️ " + end.text, 4000);
        load();
      } catch (e) { toast(problem(e)); } finally { S.busy.vpn = false; }
    }
    // ---- the server at a glance and its bridges ----
    function dur(sec) {
      if (!sec && sec !== 0) return "";
      sec = Math.max(0, sec);
      return sec < 3600 ? Math.round(sec / 60) + " мин" : sec < 86400 ? Math.floor(sec / 3600) + " ч " + Math.round(sec % 3600 / 60) + " мин"
        : Math.floor(sec / 86400) + " д " + Math.round(sec % 86400 / 3600) + " ч";
    }
    const UNIT = { failed: "остановился", inactive: "выключен", activating: "запускается", deactivating: "останавливается" };
    // ---- new versions of the server: built elsewhere, encrypted for this server, installed by one tap. Two rows: the
    // version (a new one — its button right there), the night switch; the details and «🔎 Проверить» a tap away ----
    function updateRows(u) {
      const p = u.progress || {};
      const running = p.state === "running" && Date.now() / 1000 - (p.at || 0) < 3600;
      if (!u.ready) return [line("⬆️", "Версия сервера", "Обновления из приложения ещё не включены: нужна одна установка вручную — дальше здесь.", null, null, "off")];
      const rows = [];
      if (running) {
        rows.push(line("⏳", `Обновляется до v${p.version}…`, "5–10 минут. VPN может переподключиться, приложение — ненадолго потерять связь. Экран обновится сам.", null, null, "warn"));
        // looks again every 20 s while the row is on screen; while the server restarts the app has no answer: try later
        const tick = () => {
          if (!rows[0].isConnected) return;
          if (S.tab !== "vpn" || document.hidden) { setTimeout(tick, 20000); return; }
          panel({ op: "status" }).then((end) => (end.t === "done" ? load() : setTimeout(tick, 20000))).catch(() => setTimeout(tick, 20000));
        };
        setTimeout(tick, 20000);
      } else {
        const failed = p.state === "finished" && p.version && !p.ok;
        const sub = u.foreign ? ["Новая версия собрана не для этого сервера — нажмите", "bad"]
          : failed ? [`Обновление до v${p.version} не прошло — работает прежняя. Почему — спросите в «🛠 Claude».`, "bad"]
          : u.new ? [`есть v${u.latest}` + (u.notes ? ": " + u.notes : ""), "clamp"] : u.checked ? "проверено " + when(u.checked) : "";
        const right = u.new ? el("button", { class: "ow-btn main", text: `⬆️ v${u.latest}`, "aria-label": `Обновить до v${u.latest}`,
          onclick: (e) => { e.stopPropagation(); doUpdate(u); } }) : value(`v${u.current} ✓`, "ok");
        const r = line("⬆️", u.new ? `Версия v${u.current}` : "Версия сервера", sub, right, () => updateSheet(u), u.new || failed || u.foreign ? "bad" : "ok");
        r.classList.add("update-row");
        rows.push(r);
      }
      // new versions go in by themselves at night (checked after, the old one back if anything is wrong)
      rows.push(line("🌙", "Новые версии сами ночью", u.auto ? "после — проверка, сбой — прежняя версия" : "выключено: только кнопкой",
        el("button", { class: "toggle" + (u.auto ? " on" : ""), "aria-label": "Новые версии сами ночью", "aria-pressed": u.auto ? "true" : "false",
          onclick: async () => {
            const end = await panel({ op: "server_auto", on: !u.auto }).catch(() => null);
            if (end && end.t === "done") { toast(end.update && end.update.auto ? "🌙 Новые версии будут ставиться сами ночью" : "Новые версии — только кнопкой"); load(); }
            else toast("⚠️ " + ((end && end.text) || "не получилось"), 5000);
          } }), null, u.auto ? "ok" : "off"));
      return rows;
    }
    async function doUpdate(u) {
      if (!(await confirmBox(`Обновить сервер до v${u.latest}? Займёт 5–10 минут, VPN может переподключиться. Если что-то пойдёт не так, останется прежняя версия.`, "Обновить"))) return;
      try {
        const end = await panel({ op: "server_update" });
        if (end.t !== "done") { toast("⚠️ " + end.text, 6000); return; }
        toast("⏳ Обновление началось. Когда закончится — придёт уведомление.", 6000);
        setTimeout(load, 4000);
      } catch (e) { toast(problem(e)); }
    }
    function updateSheet(u) {
      sheet("⬆️ Версия сервера", (box, close) => {
        box.append(el("div", { style: "font-size:15px;margin:-6px 0 8px", text: u.new ? `Сейчас v${u.current}, есть v${u.latest}` : `v${u.current} — последняя ✓` }),
          u.new && u.notes ? el("div", { class: "card", style: "font-size:14px;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere", text: u.notes }) : "",
          u.checked ? el("p", { class: "ow-note", style: "margin:0 2px 10px", text: "Проверено " + when(u.checked) + ". Новые версии сервер ищет сам." }) : "");
        if (u.new) box.append(el("button", { class: "btn wide", text: `⬆️ Обновить до v${u.latest}`, onclick: () => { close(); doUpdate(u); } }));
        box.append(el("button", { class: "btn line wide", style: "margin-top:8px", text: "🔎 Проверить", onclick: async (e) => {
          const b = e.currentTarget;
          busyBtn(b, "⏳ Проверяю…");
          try {
            const end = await panel({ op: "server_check" });
            if (end.t !== "done") { toast("⚠️ " + end.text, 5000); freeBtn(b); return; }
            const v = end.update || {};
            toast(v.new ? `⬆️ Доступна v${v.latest}` : v.foreign ? "Новая версия собрана не для этого сервера" : `v${v.current} — последняя`, 4000);
            close(); load();
          } catch (x) { toast(problem(x)); freeBtn(b); }
        } }));
        if (u.key && u.foreign) {  // only when a version came built for another server: its builder needs this server's key
          box.append(el("p", { class: "ow-note", style: "margin:14px 2px 8px", text: "Новая версия собрана не для этого сервера. Открытый ключ этого сервера: им шифруются "
            + "новые версии, чтобы поставить их мог только он. Ключ не секретный — один раз пришлите его тому, кто собирает обновления." }),
          el("div", { style: "font:11px/1.35 ui-monospace,monospace;word-break:break-all;white-space:pre-wrap;background:var(--card);border-radius:12px;padding:10px;margin-bottom:10px", text: u.key }),
          el("button", { class: "btn wide", text: "📋 Скопировать ключ", onclick: () => { copyText(u.key); toast("✅ Ключ скопирован — отправьте его"); } }));
        }
      });
    }
    // ---------- «🛠 Claude»: the owner's chat with Claude Code on this server ----------
    // A message: Claude looks (files, services, journals) and answers; a change it only plans. «✅ Выполнить» carries the
    // plan out after the server copies its files; the server checks itself after it and puts the copy back if it broke.
    const claude = { chat: store.get("claudeChat", ""), box: null, head: null, composer: null, draft: "", shots: [], drawShots: null };
    // «📎»: screenshots with a question (an error is quicker shown than written) — up to 4, made smaller here (the
    // longest side 1600 px: still sharp text, what Claude looks at anyway); the free models get what is read off them
    const SHOTS_MAX = 4;
    function pickImage(camera) {
      return new Promise((resolve) => {
        const inp = el("input", { type: "file", accept: "image/*", capture: camera ? "environment" : null, class: "hidden" });
        inp.addEventListener("change", () => { resolve(inp.files && inp.files[0]); inp.remove(); });
        document.body.append(inp);
        inp.click();
      });
    }
    async function shotOf(file) {
      let bmp;
      try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) {
        try { bmp = await createImageBitmap(file); } catch (e2) { return null; }
      }
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = el("canvas");
      c.width = Math.round(bmp.width * k);
      c.height = Math.round(bmp.height * k);
      const g = c.getContext("2d");
      g.fillStyle = "#fff";  // a transparent screenshot stays readable as JPEG
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(bmp, 0, 0, c.width, c.height);
      return new Promise((res) => c.toBlob((b) => res(b), "image/jpeg", 0.85));
    }
    async function addShots(files, redraw) {
      let bad = 0;
      for (const f of files) {
        if (claude.shots.length >= SHOTS_MAX) { toast(`Не больше ${SHOTS_MAX} скриншотов за раз`); break; }
        const b = f && /^image\//.test(f.type || "image/") ? await shotOf(f) : null;
        if (b) claude.shots.push(b); else bad += 1;
      }
      if (bad) toast("Это не картинка — приложите снимок экрана или фото");
      redraw();
    }
    const b64of = (blob) => new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",", 2)[1] || "");
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
    const STEP_ICON = { Bash: "▶️", Read: "📄", Edit: "✏️", Write: "📝", Glob: "🔎", Grep: "🔎" };
    const html = (t) => (A.md ? A.md(t) : String(t || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/\n/g, "<br>"));
    const stepLine = (icon, what) => el("div", { style: "font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:2px 0;color:var(--muted)",
      text: icon + " " + what });
    function claudeMsg(m, asked, last, undoFor) {
      const wrap = el("div", { class: "msg " + (m.role === "me" ? "me" : "ai") });
      const b = el("div", { class: "bubble" + (m.err ? " err" : "") });
      if (m.role === "me") b.textContent = m.text; else b.innerHTML = html(m.text);
      if (m.thumbs && m.thumbs.length) {  // just sent from here: the pictures themselves
        b.append(el("div", { style: "display:flex;gap:6px;flex-wrap:wrap;margin-top:6px" },
          ...m.thumbs.map((u) => el("img", { src: u, alt: "Скриншот", style: "width:72px;height:72px;object-fit:cover;border-radius:8px" }))));
      } else if (m.shots) b.append(el("div", { style: "font-size:13px;opacity:.8;margin-top:4px", text: `📎 Скриншотов: ${m.shots}` }));
      wrap.append(b);
      if (String(m.text || "").length > 600) {  // a long answer folded: the chat stays short, the whole is a tap away
        b.style.maxHeight = "11em";
        b.style.overflow = "hidden";
        const more = el("button", { class: "hint", style: "margin:4px 4px 0", text: "Показать полностью", onclick: () => {
          const open = b.style.maxHeight === "none";
          b.style.maxHeight = open ? "11em" : "none";
          more.textContent = open ? "Показать полностью" : "Свернуть";
        } });
        wrap.append(more);
      }
      if (m.steps && m.steps.length) {
        const det = el("details", { style: "font-size:13px;color:var(--muted);margin:2px 4px 0" }, el("summary", { text: `🔧 Что Claude делал: ${m.steps.length}` }));
        for (const x of m.steps.slice(0, 60)) det.append(stepLine(STEP_ICON[x.tool] || "🔧", x.what));
        wrap.append(det);
      }
      // (v37) who answered: Claude on the key or the free models (and why, when Claude was meant; v38: no dollars here)
      if (m.role !== "me" && (m.model || m.free)) wrap.append(el("div", { class: "who-answered", style: "font-size:12px;margin:2px 4px 0;color:var(--muted)",
        text: m.model ? `🟠 ${m.model}` : "🆓 Бесплатные модели" + (m.fell ? " — " + m.fell : "") }));
      if (m.files && m.files.length) {
        const det = el("details", { style: "font-size:13px;color:var(--muted);margin:2px 4px 0" }, el("summary", { text: `📝 Изменено файлов: ${m.files.length}` }));
        for (const f of m.files) det.append(stepLine("·", f));
        wrap.append(det);
      }
      if (m.note) wrap.append(el("div", { style: "font-size:13px;margin:4px 4px 0;color:" + (m.note.startsWith("↩️") ? "#b45309" : "var(--muted)"), text: m.note }));
      // the result of «Выполнить»: put back from here (only under it, while no new plan waits)
      if (undoFor) wrap.append(el("div", { style: "margin:6px 4px 0" }, el("button", { class: "ow-btn line undo-btn", text: "↩️ Вернуть как было",
        onclick: () => undo(undoFor) })));
      if (last && m.role !== "me" && m.text) {
        // the answer for the project's developer (the Claude chat that makes new versions): question, answer, files in one copy
        const forDev = () => ["Из «🛠 Claude» на сервере.", asked ? "Вопрос: " + asked : "", "Ответ:\n" + m.text,
          m.files && m.files.length ? "Изменены файлы: " + m.files.join(", ") : "", m.note || ""].filter(Boolean).join("\n\n");
        wrap.append(el("div", { style: "margin:4px 4px 0" }, el("button", { class: "hint", text: "📋 Для разработчика",
          onclick: () => { copyText(forDev()); toast("✅ Скопировано — вставьте в чат с разработчиком", 5000); } })));
      }
      return wrap;
    }
    function liveBubble() {
      const wrap = el("div", { class: "msg ai" }), b = el("div", { class: "bubble" });
      const steps = el("div"), text = el("div"), st = el("div", { class: "status", style: "font-size:14px;margin-top:4px" }, el("span", { class: "spin" }), el("span", { text: "Отправляю…" }));
      b.append(steps, text, st);
      wrap.append(b);
      let raw = "", n = 0;
      const down = () => { scroll.scrollTop = scroll.scrollHeight; };
      return {
        el: wrap,
        status: (t) => { st.lastChild.textContent = t; },
        on: (ev) => {
          if (ev.t === "chat") { claude.chat = ev.chat; store.set("claudeChat", ev.chat); }
          else if (ev.t === "status") st.lastChild.textContent = ev.text;
          else if (ev.t === "tool") {  // the newest three steps in sight, the count of all: the bubble stays short
            steps.append(stepLine(ev.icon || "🔧", ev.what));
            n += 1;
            while (steps.childNodes.length > 3) steps.firstChild.remove();
            st.lastChild.textContent = `Работаю… шагов: ${n}`;
          }
          else if (ev.t === "out" && ev.err) steps.append(stepLine("⚠️", ev.text.slice(0, 300)));
          else if (ev.t === "text") { raw += (raw ? "\n\n" : "") + ev.text; text.innerHTML = html(raw); }
          else if (ev.t === "done" || ev.t === "error") st.remove();
          down();
        },
      };
    }
    function claudeIntro() {
      const hints = ["Всё ли в порядке с сервером?", "Почему мост не подключается?", "Сколько свободно места и памяти?", "Что было в событиях за сегодня?"];
      return el("div", { class: "msg note" }, el("div", { class: "bubble", text: "Здесь Claude Code прямо на вашем сервере. Спросите — он посмотрит сам. "
        + "Если нужно что-то поменять, сначала покажет план, а поменяет только после «✅ Выполнить»: сервер сначала сделает снимок файлов, "
        + "после — проверит себя и при поломке вернёт как было. Каждый откат Claude запоминает как урок; своё правило — "
        + "«Запомни: …» (его увидят все разговоры), «Забудь уроки» — стереть ваши правила." }),
        el("div", { class: "hints", style: "margin-top:8px" }, ...hints.map((t) => el("button", { class: "hint", text: t, onclick: () => send(t) }))));
    }
    // ---------- «🔍 Дозор»: the agent that keeps looking over the server, VPN and bridges, protection, the app and new
    // versions by itself. Everything it finds is for the developer: the owner sees a short list and sends it all in one
    // text («📋 Для разработчика»), then clears it («🧹 Очистить»); only a small breakage on the server (🔴 [сервер]) the
    // server's Claude may mend at once («🛠 Починить», a plan first) ----------
    function devSheet(text, found) {
      sheet("👨‍💻 Для разработчика", (box) => {
        const kb = Math.max(1, Math.round(new Blob([text]).size / 1024));
        box.append(el("small", { style: "display:block;color:var(--muted);margin:-4px 2px 8px;line-height:1.4",
          text: `Находки Дозора, ключи и все неполадки мостов (${kb} КБ). Скопируйте и вставьте в чат с разработчиком — или отправьте файлом. `
            + "Потом нажмите «🧹 Очистить»: в следующий текст попадёт только новое." }),
        el("div", { class: "card dev-preview", style: "white-space:pre-wrap;font-size:13px;line-height:1.35;overflow-wrap:anywhere;max-height:40vh;overflow:auto",
          text: text.length > 3000 ? text.slice(0, 3000) + "\n…" : text }),
        el("div", { class: "ow-acts" },
          el("button", { class: "btn", text: "📋 Скопировать всё", onclick: () => { copyText(text); toast("✅ Скопировано — вставьте в чат с разработчиком", 5000); } }),
          el("button", { class: "btn line", text: "📤 Файлом", onclick: () => shareBlob(new Blob([text], { type: "text/markdown" }),
            "dlya-razrabotchika-" + new Date().toISOString().slice(0, 10) + ".md", found ? `Дозор: находок ${found}` : "") })));
      });
    }
    const clean = (t) => String(t || "").replace(/`/g, "");
    function drawPatrol(d) {
      if (d.none) {
        scroll.append(el("div", { class: "ow-status off" }, el("span", { class: "ow-ic off", text: "🔍" }),
          el("div", { class: "ow-t" }, "Дозор недоступен", el("small", { text: d.why || "Он работает вместе с Claude на сервере." }))),
          el("p", { class: "ow-note", text: "Дозор — это Claude на сервере, который сам проверяет сервер раз в час. Он ставится с новой версией сервера: "
            + "«🖥 Сервер» → «Версия сервера»." }));
        return;
      }
      const st = d.status || {}, items = d.items || [];
      const open = items.filter((x) => x.status === "new");
      // how it goes: on or off, checking now, the last round and the next theme
      const hm = (ts) => new Date(ts * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      const off = st.on === false;
      const head = st.running ? (st.agent ? st.agent + ": " : "Проверяет: ") + (st.theme || "сервер") + "…" : st.applying ? "Выполняет отмеченное…"
        : off ? "Выключен" : st.rest ? "Отдыхает до " + hm(st.rest) : "Следит";
      const sub = off ? "сам не проверяет — только кнопкой ниже"
        : [st.at ? "проверял " + when(st.at) : "ещё не проверял", st.running ? "" : "дальше: " + (st.next_agent ? st.next_agent + " — " : "") + st.next].filter(Boolean).join(" · ");
      const toggle = st.on === null || st.on === undefined ? null : el("button", { class: "toggle" + (off ? "" : " on"), "aria-label": "Дозор следит сам",
        "aria-pressed": off ? "false" : "true", onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          try {
            const end = await panel({ op: "agent_patrol", on: off });
            if (end.t !== "done") { toast("⚠️ " + end.text, 7000); return; }
            cache.patrol = Object.assign({}, d, { status: end.status || Object.assign({}, st, { on: off }) });
            if (cache.claude) cache.claude.patrol_on = off;
            toast(off ? "🔍 Дозор снова следит сам" : "Дозор выключен — проверка только кнопкой", 4000);
            draw();
          } catch (x) { toast(problem(x)); } finally { b.disabled = false; }
        } });
      scroll.append(el("div", { class: "ow-status" + (off ? " off" : "") + " patrol-head" },
        st.running ? el("span", { class: "ow-ic" }, el("span", { class: "spin" })) : el("span", { class: "ow-ic" + (off ? " off" : " ok"), text: "🔍" }),
        el("div", { class: "ow-t" }, head, el("small", { text: sub })), toggle));
      const now = el("button", { class: "btn line", text: st.running ? "⏳ Проверяет…" : "▶️ Проверить сейчас", disabled: st.running || st.busy || null,
        onclick: async () => {
          now.disabled = true;
          try {
            const end = await panel({ op: "agent_patrol_now" });
            if (end.t !== "done") { toast("⚠️ " + end.text, 7000); now.disabled = false; return; }
            if (!end.started) { toast("⏳ " + (end.text || "сейчас нельзя") + ".", 6000); now.disabled = false; return; }
            toast("🔍 Дозор начал проверку — несколько минут. Что найдёт — появится здесь.", 6000);
            cache.patrol = Object.assign({}, d, { status: end.status || Object.assign({}, st, { running: true }) });
            draw();
          } catch (x) { toast(problem(x)); now.disabled = false; }
        } });
      const reports = el("button", { class: "btn line", text: "📄 Отчёты", disabled: st.chat ? null : true, onclick: async () => {
        claude.chat = st.chat;
        store.set("claudeChat", st.chat);
        try { await panel({ op: "agent_select", chat: st.chat }); } catch (e) { /* the chat opens all the same */ }
        cache.claude = null;
        go("claude");
      } });
      scroll.append(el("div", { class: "ow-acts" }, now, reports));
      if (st.busy && !st.running) scroll.append(el("p", { class: "ow-note", style: "margin-top:-4px", text: "Claude сейчас выполняет вашу просьбу — Дозор проверит после." }));
      // what it found: a short list (the whole text is the developer's)
      // (v36) each finding: what it is, how much it is needed, pluses and minuses against what works now — and the owner's
      // choice by whom: Claude on the key (Opus 5.5), the free Claude, the developer, or not at all; «Применить» carries
      // the choices out (Claude: plan, the change, a second look; the snapshot puts it back when broken)
      const BY = [["claude", "🟠 Claude"], ["free", "🆓 Бесплатный"], ["dev", "👨‍💻 Разработчику"], ["no", "✕ Не надо"]];
      const REC = { need: "👍 нужно", maybe: "🤔 можно", low: "💤 не особо" };
      const picks = draw.picks = draw.picks || {};
      const applyBtn = el("button", { class: "btn wide", text: "✅ Применить отмеченное", onclick: async () => {
        const items = Object.entries(picks).filter(([id, by]) => by && open.some((x) => x.id === id)).map(([id, by]) => ({ id, by }));
        if (!items.length) return toast("Отметьте у находок, кому их поручить, или «✕ Не надо».", 5000);
        const forClaude = items.filter((x) => x.by === "claude" || x.by === "free").length;
        if (forClaude && !(await confirmBox(`Поручить Claude ${forClaude} шт.? Он проверит, сделает и перепроверит сам; перед правками — снимок, при поломке вернёт как было. Правки программ уйдут разработчику.`, "Применить"))) return;
        applyBtn.disabled = true;
        try {
          const end = await panel({ op: "agent_patrol_apply", items });
          if (end.t !== "done") { applyBtn.disabled = false; return toast("⚠️ " + end.text, 7000); }
          for (const x of items) delete picks[x.id];
          cache.patrol = Object.assign({}, d, { items: end.items || [], status: end.status || st });
          toast([end.claude + end.free ? `🛠 Claude взялся (${end.claude + end.free}) — о результате придёт уведомление` : "", end.dev ? `👨‍💻 разработчику: ${end.dev}` : "",
            end.no ? `✕ убрано: ${end.no}` : ""].filter(Boolean).join(" · "), 7000);
          draw();
        } catch (x) { applyBtn.disabled = false; toast(problem(x)); }
      } });
      const paintApply = () => {
        const n = Object.values(picks).filter(Boolean).length;
        applyBtn.textContent = n ? `✅ Применить отмеченное (${n})` : "✅ Применить отмеченное";
        applyBtn.disabled = !n || !!st.applying;
      };
      const body = (x) => {  // what comes after the heading, up to the meta (👍 ➕ ➖ 🔗), at most 600 letters
        const t = clean(x.text), m = t.match(/\s+[—|]\s+/);
        return m ? t.slice(m.index + m[0].length).split(/\s+\|\s+(?=👍|➕|➖|🔗)/)[0].slice(0, 600) : "";
      };
      const item = (x) => {
        const rec = x.rec && REC[x.rec];
        const chips = el("div", { class: "chips patrol-by", style: "flex-wrap:wrap;margin:6px 0 2px;gap:6px" });
        const paintChips = () => {
          chips.innerHTML = "";
          for (const [k, name] of BY) {
            const on = picks[x.id] === k;
            chips.append(el("button", { class: "chip" + (on ? " on" : ""), "aria-pressed": on ? "true" : "false", style: "min-height:34px;padding:4px 10px;font-size:13px",
              text: name + (x.by === k && k !== "no" ? " ★" : ""), title: x.by === k ? "советует Дозор" : null,
              onclick: () => { picks[x.id] = on ? "" : k; paintChips(); paintApply(); } }));
          }
        };
        paintChips();
        return el("div", { class: "ow-row patrol-item", "data-id": x.id, style: "align-items:flex-start;flex-direction:column;gap:2px" },
          el("div", { class: "ow-t", style: "width:100%" }, el("div", { style: "font-weight:500", text: (x.kind === "fix" ? "🔴 " : "🟡 ") + clean(x.text).split(/\s+[—|]\s+/)[0] }),
            // (v37, the audit) the whole finding before it is ticked, not its heading only (a version: what changed in it)
            body(x) ? el("div", { class: "patrol-body", style: "font-size:13px;line-height:1.35;margin-top:2px;white-space:pre-wrap", text: body(x) }) : null,
            el("small", { style: "font-size:12px;margin-top:3px", text: [x.agent ? ((st.agents || []).find((a) => a.id === x.agent) || {}).name : x.theme, when(x.first), x.times > 1 ? `замечено ${x.times} раза` : ""].filter(Boolean).join(" · ") })),
          rec || x.pros || x.cons ? el("div", { class: "patrol-why", style: "font-size:13px;line-height:1.35;color:var(--muted);width:100%" },
            rec ? el("div", { text: rec + (x.by ? " · советует: " + ((BY.find((b) => b[0] === x.by) || [])[1] || "") : "") }) : null,
            x.pros ? el("div", { text: "➕ " + x.pros }) : null, x.cons ? el("div", { text: "➖ " + x.cons }) : null) : null,
          chips);
      };
      const notes = el("button", { class: "btn", text: "📋 Разработчику", onclick: async () => {
        notes.disabled = true;
        try {
          const end = await panel({ op: "agent_devnotes" });
          if (end.t !== "done") return toast("⚠️ " + end.text, 7000);
          devSheet(end.text, end.found);
        } catch (x) { toast(problem(x)); } finally { notes.disabled = false; }
      } });
      const wipe = el("button", { class: "btn line", text: "🧹 Очистить", onclick: async () => {  // (the reports and the bridges' journal too)
        if (!(await confirmBox("Отправили текст разработчику («📋 Разработчику»)? После очистки в нём будет только новое: находки, отчёты, журнал мостов. "
          + "Поломки на сервере (🔴 с «🛠 Починить») останутся, пока их не починят.", "Очистить", true))) return;
        wipe.disabled = true;
        try {
          const end = await panel({ op: "agent_devclear" });
          if (end.t !== "done") { wipe.disabled = false; return toast("⚠️ " + end.text, 7000); }
          cache.patrol = Object.assign({}, d, { items: end.items || [], status: end.status || st });
          toast("🧹 Очищено", 3000);
          draw();
        } catch (x) { wipe.disabled = false; toast(problem(x)); }
      } });
      if (open.length) {
        const these = open.slice().sort((p, q) => (p.kind === "fix" ? 0 : 1) - (q.kind === "fix" ? 0 : 1) || q.first - p.first);
        scroll.append(section(`Нашёл · ${these.length}`), el("div", { class: "ow-list patrol-found" }, ...these.slice(0, 30).map(item)),
          these.length > 30 ? el("p", { class: "ow-note", text: `И ещё ${these.length - 30} — в тексте для разработчика.` }) : null,
          el("div", { class: "ow-acts patrol-apply", style: "position:sticky;bottom:0;background:var(--bg);padding:8px 0" }, applyBtn));
        paintApply();
      } else {
        scroll.append(el("div", { class: "ow-list", style: "text-align:center;padding:16px 12px" },
          el("div", { style: "font-size:26px", text: "✅" }), el("div", { style: "font-weight:500", text: "Новых находок нет" }),
          el("small", { style: "display:block;color:var(--muted);margin-top:4px;font-size:13px",
            text: off ? "Дозор выключен: проверит, только когда нажмёте «Проверить сейчас»." : "Что найдёт — появится здесь; о поломке придёт уведомление." })));
      }
      notes.style.flex = "2";
      wipe.style.flex = "1";
      scroll.append(el("div", { class: "ow-foot", style: "display:flex;gap:8px" }, notes, wipe),
        el("p", { class: "ow-note", text: "У каждой находки выберите, кому поручить (★ — совет Дозора), и нажмите «Применить». «📋 Разработчику» собирает находки, "
          + "отчёты Дозора, ключи, неполадки мостов и правки программ, сделанные Claude на сервере, в один текст." }));
      const sent = items.filter((x) => x.status === "sent");
      if (sent.length) scroll.append(el("details", { class: "ow-more patrol-sent" },
        el("summary", { class: "ow-sec" }, el("span", { class: "grow", text: `🛠 Чинит Claude на сервере · ${sent.length}` }), el("span", { class: "ow-go", text: "›" })),
        el("div", { class: "ow-list" }, ...sent.slice().reverse().map((x) => el("div", { class: "ow-row", style: "min-height:40px" },
          el("div", { class: "ow-t", style: "font-size:14px" }, clean(x.text).split(/\s+—\s+/)[0], el("small", { text: when(x.first) })))))));
      // (v36) the six agents, each with its own themes
      const agents = st.agents && st.agents.length ? st.agents : [];
      scroll.append(el("details", { class: "ow-more" }, el("summary", { class: "ow-sec" }, el("span", { class: "grow", text: `Агенты · ${agents.length || 6}` }), el("span", { class: "ow-go", text: "›" })),
        el("div", { class: "ow-list patrol-agents" }, ...agents.map((a) => el("div", { class: "ow-row", style: "min-height:44px" },
          el("div", { class: "ow-t" }, el("div", { style: "font-weight:500", text: a.name + (a.name === st.next_agent && !off ? " · следующий" : "") }),
            el("small", { style: "font-size:12px", text: a.themes.join(" · ") }))))),
        el("p", { class: "ow-note", text: "Агенты смотрят по очереди, примерно раз в час, на бесплатных моделях; видео и фото — чаще всего. Сами ничего не меняют: "
          + "что поручите — делает Claude на сервере (по ключу Anthropic — Opus 5.5; без ключа или денег — бесплатный)." })));
      // while it checks, the tab looks again by itself
      if (st.running) draw.tick = setTimeout(() => { if (part === "patrol" && S.tab === "vpn" && !document.hidden) load(); }, 15000);
    }
    // the rescue console: Claude Code on the owner's Anthropic key and the repairs, in a browser, apart from this app
    function rescueCard() {
      const box = el("div", { class: "card", style: "padding:6px 10px" });
      const go = el("button", { class: "btn line wide", style: "min-height:40px", text: "🆘 Спасательная консоль (если этот чат сломается)", onclick: async () => {
        go.disabled = true;
        try {
          const end = await panel({ op: "rescue_link" });
          if (end.t !== "done") { toast("⚠️ " + end.text, 9000); go.disabled = false; return; }
          go.replaceWith(el("a", { class: "btn wide", href: end.url, target: "_blank", rel: "noopener", style: "display:block;text-align:center;text-decoration:none",
            text: "👉 Открыть консоль в браузере" }),
            el("small", { style: "display:block;color:var(--muted);margin-top:6px", text: "Там войдите своей ссылкой VPN (она в «🛡 VPN» → ваша карточка). "
              + "Без ввода — из Winger: «🆘 Спасение сервера». Отсюда консоль сама не впускает: так её не откроет никто, кто проберётся в приложение." }));
        } catch (e) { toast(problem(e)); go.disabled = false; }
      } });
      box.append(go);
      return box;
    }
    function drawClaude(d) {
      if (!d.installed) {
        scroll.append(rescueCard(), el("div", { class: "card" }, el("h3", { text: "🛠 Claude на сервере" }),
          el("p", { text: d.why || "Claude Code ещё не установлен." }),
          el("small", { style: "color:var(--muted)", text: "Он ставится вместе с новой версией сервера: «🖥 Сервер» → «⬆️ Версия сервера» → «⬆️ Обновить»." })));
        return;
      }
      claude.chat = d.chat;
      store.set("claudeChat", d.chat);
      // the talk: its name (a tap — the list of talks, the rescue console), a new one
      claude.head = el("span", { text: d.title });
      scroll.append(el("div", { class: "ow-list" }, line("💬", claude.head, d.chats.length > 1 ? `Разговоров: ${d.chats.length} · выбрать` : "Один разговор — одна тема",
        el("button", { class: "ow-btn", text: "➕ Новый", onclick: (e) => { e.stopPropagation(); newChat(); } }), () => chatsSheet(d))));
      // a long talk is read again with every answer: a new subject is quicker and cheaper in a new talk
      if (d.history.length >= 30) scroll.append(el("p", { class: "ow-note long-talk", style: "margin-top:-4px",
        text: "Длинный разговор: каждый ответ перечитывает всю историю — новую тему лучше начать в «➕ Новый» (быстрее и экономнее)." }));
      const box = claude.box = el("div", { class: "msgs", style: "padding:4px 2px 12px" });
      if (!d.history.length) box.append(claudeIntro());
      let asked = "";
      const lastAi = d.history.map((m) => m.role !== "me").lastIndexOf(true);
      const early = el("div", { class: "hidden" });
      d.history.forEach((m, i) => {
        (i < d.history.length - 6 ? early : box).append(claudeMsg(m, asked, i === lastAi, i === d.undo_at ? d : null));
        if (m.role === "me") asked = m.text;
      });
      if (early.childNodes.length) {
        box.prepend(el("button", { class: "hint", style: "margin:0 auto 8px;display:block", text: `Показать ранние (${early.childNodes.length})`,
          onclick: (e) => { early.classList.remove("hidden"); e.currentTarget.replaceWith(early); } }));
      }
      scroll.append(box);
      if (d.busy) {
        if (d.busy_chat === d.chat) follow(d.events);
        else scroll.append(el("p", { class: "ow-note", text: "⏳ Claude сейчас работает в другом разговоре" }));
      } else {
        if (d.patrol) scroll.append(el("p", { class: "ow-note", text: "🔍 Дозор сейчас проверяет сервер — ваш вопрос его прервёт" }));
        // a plan waits: carry it out (one tap) or turn it down
        if (d.can_run) scroll.append(el("div", { class: "card plan-card", style: "padding:12px" },
          el("div", { class: "ow-t" }, "📋 План готов", el("small", { text: "Перед правками сервер сделает снимок файлов, после — проверит себя; если что-то сломается — сам вернёт как было." })),
          el("div", { class: "ow-acts", style: "margin:10px 0 0" },
            el("button", { class: "btn", text: "✅ Выполнить", onclick: runPlan }),
            el("button", { class: "btn line", text: "✕ Отклонить", onclick: rejectPlan }))));
      }
      // who answers here, in one line; a tap — the choice
      const name = d.paid_key && d.on_claude
        ? "🟠 Claude · " + ((d.model || "auto") === "auto" ? "авто" : (((d.models || []).find((m) => m.id === d.model) || {}).name || d.model))
        : d.engines.length ? "🧠 " + d.engines[0] : "нет ключей — «Ещё» → «🔑 Ключи»";
      scroll.append(el("button", { class: "ow-model", onclick: () => modelSheet(d) }, "Модель: " + name + " ›"));
      const ta = el("textarea", { rows: 1, placeholder: d.busy ? "Claude работает… можно написать следующее" : "Что проверить или сделать?" });
      ta.value = claude.draft;
      ta.addEventListener("input", () => { claude.draft = ta.value; ta.style.height = "auto"; ta.style.height = Math.min(140, ta.scrollHeight) + "px"; });
      const shots = el("div", { class: "attach-row hidden" });
      const drawShots = () => {
        shots.innerHTML = "";
        shots.classList.toggle("hidden", !claude.shots.length);
        claude.shots.forEach((b, i) => shots.append(el("img", { src: urlOf(b), alt: "Скриншот " + (i + 1), title: "Посмотреть", style: "cursor:pointer",
          onclick: () => viewer(b, "скриншот.jpg") })));
        if (claude.shots.length) {
          shots.append(el("button", { class: "x", text: "✕", "aria-label": "Убрать скриншоты", onclick: () => { claude.shots = []; drawShots(); } }));
        }
      };
      drawShots();
      claude.drawShots = drawShots;
      // a screenshot pasted into the field (a computer's browser; some phone keyboards) comes in as one picked
      ta.addEventListener("paste", (e) => {
        const files = [...((e.clipboardData && e.clipboardData.items) || [])].filter((x) => x.kind === "file" && /^image\//.test(x.type)).map((x) => x.getAsFile());
        if (files.length) { e.preventDefault(); addShots(files, drawShots); }
      });
      const clip = el("button", { class: "round ghost", text: "📎", title: "Приложить скриншот", "aria-label": "Приложить скриншот", onclick: () => {
        if (claude.shots.length >= SHOTS_MAX) return toast(`Не больше ${SHOTS_MAX} скриншотов за раз`);
        sheet("Приложить скриншот", (box, close) => {
          const list = el("div", { class: "list" });
          for (const [ic, words, camera] of [["🖼️", "Скриншот или фото из галереи", false], ["📷", "Снять экран камерой", true]]) {
            list.append(el("button", { onclick: async () => { close(); const f = await pickImage(camera); if (f) addShots([f], drawShots); } },
              el("span", { class: "ic", text: ic }), el("span", { text: words })));
          }
          box.append(list, el("small", { style: "display:block;color:var(--muted);margin-top:8px",
            text: "Скриншот — кнопки громкости и питания вместе; он в галерее, в «Скриншотах». До 4 за раз. Claude видит сами картинки, бесплатные модели — прочитанный с них текст." }));
        });
      } });
      const go = el("button", { class: "round main", text: d.busy ? "⏹" : "➤", title: d.busy ? "Стоп" : "Отправить", onclick: () => {
        if (d.busy) return stopClaude();
        const t = ta.value.trim();
        if (t || claude.shots.length) { claude.draft = ""; ta.value = ""; ta.style.height = ""; send(t); }
      } });
      claude.composer = el("div", { class: "composer" }, shots, el("div", { class: "inrow" }, clip, ta, go));
      root.append(claude.composer);
      requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
    }
    async function talk(body, me, thumbs) {  // a request to Claude with its steps shown as they come; the chat redrawn after it
      if (!claude.box) return;
      if (me) {
        if (body.chat === "new") { claude.box.innerHTML = ""; if (claude.head) claude.head.textContent = me.slice(0, 40); }
        claude.box.querySelectorAll(".msg.note").forEach((n) => n.remove());
        claude.box.append(claudeMsg({ role: "me", text: me, thumbs }));
      }
      const live = liveBubble();
      claude.box.append(live.el);
      scroll.scrollTop = scroll.scrollHeight;
      const unwatch = phoneWatch();
      try {
        const end = await stream("/api/panel", body, live.on);
        if (end.t === "error") toast("⚠️ " + end.text, 6000);
      } catch (e) {
        live.status("Связь прервалась — Claude работает дальше, жду…");
        await waitFree();
      } finally {
        unwatch();
      }
      reloadClaude();
    }
    // Claude may ask this phone to check the bridges (srv-phone on the server): while it works, its ask goes on to Winger
    // at once (else Winger finds it itself within a few minutes while its VPN is on)
    function phoneWatch() {
      if (!(window.AIBridge && window.AIBridge.wingerCheck)) return () => {};
      let on = true;
      (async () => {
        while (on) {
          await new Promise((r) => setTimeout(r, 4000));
          if (!on) break;
          try {
            const r = await panel({ op: "phone_task" });
            if (on && r && r.task && window.AIBridge.wingerCheck(r.task)) toast("📱 Winger проверяет мосты с этого телефона — несколько минут", 6000);
          } catch (e) { /* the next look */ }
        }
      })();
      return () => { on = false; };
    }
    async function waitFree() {  // the phone lost the line: the server goes on; look again until it is done
      for (let i = 0; i < 180; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        try { const st = await panel({ op: "agent_state", chat: claude.chat }); if (st.t === "done" && !st.busy) return; } catch (e) { /* still away */ }
      }
    }
    function follow(from) {  // the app was away while Claude worked: its steps from where they are now
      talk({ op: "agent_follow", from: Math.max(0, (from || 0) - 1) });
    }
    function reloadClaude() {
      if (part !== "claude") return;
      cache.claude = null;
      load();
    }
    async function send(text) {
      const pics = claude.shots;
      claude.shots = [];
      if (claude.drawShots) claude.drawShots();
      const body = { op: "agent_ask", chat: claude.chat, text };
      if (pics.length) {
        try { body.images = await Promise.all(pics.map(b64of)); } catch (e) {
          claude.shots = pics;
          if (claude.drawShots) claude.drawShots();
          return toast("Скриншот не прочитался — приложите его снова");
        }
      }
      talk(body, text || "📎 Посмотри скриншот" + (pics.length > 1 ? "ы" : ""), pics.map(urlOf));
    }
    function runPlan() {  // the plan card says what happens: one tap
      talk({ op: "agent_run", chat: claude.chat }, "✅ Выполнить");
    }
    async function rejectPlan() {
      try {
        const end = await panel({ op: "agent_reject", chat: claude.chat });
        if (end.t !== "done") return toast("⚠️ " + end.text, 6000);
        cache.claude = end;
        draw();
        toast("План отклонён — сервер не менялся", 4000);
      } catch (e) { toast(problem(e)); }
    }
    async function undo(d) {
      if (!(await confirmBox(`Вернуть файлы сервера, как они были до «Выполнить» (${when(d.undo_ts)})? Сервер после проверит себя.`, "Вернуть"))) return;
      talk({ op: "agent_undo", chat: claude.chat }, "↩️ Вернуть как было");
    }
    // «Модель: …»: who answers in this chat — the free models in turn, or Claude itself on the owner's key
    function modelSheet(d) {
      sheet("🧠 Модель", (box, close) => {
        const pick = async (body) => {
          try {
            const end = await panel(body);
            if (end.t === "done") { close(); cache.claude = end; draw(); } else toast("⚠️ " + end.text, 7000);
          } catch (e) { toast(problem(e)); }
        };
        const chip = (on, text, body) => el("button", { class: "chip" + (on ? " on" : ""), text, "aria-pressed": on ? "true" : "false", onclick: () => { if (!on) pick(body); } });
        if (d.paid_key) {
          box.append(el("div", { class: "chips", style: "margin:0 0 10px;flex-wrap:wrap" },
            chip(!d.on_claude, "🆓 Бесплатные", { op: "agent_engine", engine: "free" }), chip(!!d.on_claude, "🟠 Claude", { op: "agent_engine", engine: "claude" })));
        }
        if (d.paid_key) {  // (v37) Claude Code on the key, end to end: what the last look said, and a look now
          const p = d.probe || {};
          const when = p.at ? new Date(p.at * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
          const said = !p.at ? "Claude по ключу ещё не проверялся" : p.ok ? "✅ Claude по ключу отвечает" : "⚠️ Claude по ключу не ответил";
          box.append(el("div", { class: "ow-list claude-probe" }, line("🧪", said, p.at ? (p.ok ? "проверено " + when : when + " · " + (p.why || "")) : "одно слово от Haiku, доли цента",
            el("button", { class: "ow-btn line", text: "Проверить", onclick: async (e) => {
              e.target.disabled = true;
              try { await panel({ op: "agent_probe" }); toast("Проверяю Claude по ключу — откройте это окно снова через минуту"); }
              catch (err) { toast(problem(err)); e.target.disabled = false; }
            } }), null, p.at && !p.ok ? "warn" : null)));
        }
        if (d.paid_key && d.on_claude) {
          box.append(el("div", { class: "chips", style: "margin:0 0 10px;flex-wrap:wrap" },
            chip((d.model || "auto") === "auto", "Авто", { op: "agent_model", model: "auto" }),
            ...(d.models || []).map((m) => chip(d.model === m.id, m.name.replace(/\s+[\d.]+$/, ""), { op: "agent_model", model: m.id }))),
          el("p", { class: "ow-note", text: (d.model || "auto") === "auto" ? "Авто: модель по сложности вопроса, «Выполнить» — не ниже Sonnet." : "Все ответы — эта модель." }),
          // (v38, the owner: the server's own count was wrong) what was spent — only in Anthropic's console
          el("p", { class: "ow-note claude-spent", text: "Сколько потрачено — смотрите в platform.claude.com → Usage (сервер деньги не считает). "
            + "Кончатся деньги на ключе — ответят бесплатные модели (здесь это будет видно)." }));
          return;
        }
        const list = el("div", { class: "ow-list" });
        d.engines.forEach((e, i) => list.append(line(i ? String(i + 1) : "🧠", e, i ? "если первая не ответит" : "отвечает сейчас", null, null, i ? "off" : "ok")));
        if (d.engines.length) box.append(list);
        else box.append(el("p", { class: "ow-note", text: "Нет ключей моделей — добавьте в «Ещё» → «🔑 Ключи»." }));
        if (d.paid_key) {
          box.append(el("div", { class: "ow-list" }, line("💳", "Кончились бесплатные — Claude по вашему ключу", d.paid ? "включено" : "выключено",
            el("button", { class: "toggle" + (d.paid ? " on" : ""), "aria-label": "Claude по вашему ключу, когда кончились бесплатные",
              "aria-pressed": d.paid ? "true" : "false", onclick: () => pick({ op: "agent_paid", on: !d.paid }) }))));
        } else {
          box.append(el("p", { class: "ow-note", text: "Claude по вашему ключу — добавьте ключ Anthropic в «Ещё» → «🔑 Ключи»." }));
        }
      });
    }
    async function stopClaude() {
      try { await panel({ op: "agent_stop" }); } catch (e) { toast(problem(e)); }
    }
    async function newChat() {
      try {
        const st = await panel({ op: "agent_new" });
        if (st.t !== "done") return toast("⚠️ " + st.text);
        claude.chat = st.chat; cache.claude = st; draw();
      } catch (e) { toast(problem(e)); }
    }
    function chatsSheet(d) {
      sheet("💬 Разговоры с Claude", (box, close) => {
        box.append(el("button", { class: "btn wide", style: "margin-bottom:10px", text: "➕ Новый разговор", onclick: () => { close(); newChat(); } }));
        for (const c of d.chats) {
          box.append(el("div", { class: "row", style: "cursor:pointer" + (c.id === d.chat ? ";font-weight:600" : ""),
            onclick: async () => { close(); claude.chat = c.id; try { await panel({ op: "agent_select", chat: c.id }); } catch (e) { /* the list stays */ } reloadClaude(); } },
          el("div", { class: "grow" }, (c.busy ? "⏳ " : "") + c.title, el("small", { text: c.upd ? when(c.upd) : "" })),
          el("button", { class: "round ghost", style: "width:36px;height:36px;font-size:15px", text: "✏️", title: "Переименовать", onclick: async (e) => {
            e.stopPropagation(); close();
            const t = await ask("Название разговора", "Например: Мост VK", c.title);
            if (t) { try { await panel({ op: "agent_rename", chat: c.id, title: t }); } catch (er) { toast(problem(er)); } reloadClaude(); }
          } }),
          el("button", { class: "round ghost", style: "width:36px;height:36px;font-size:15px;margin-left:6px", text: "🗑", title: "Удалить", onclick: async (e) => {
            e.stopPropagation(); close();
            if (!(await confirmBox(`Удалить разговор «${c.title}»? Изменения на сервере останутся.`, "Удалить"))) return;
            try { const r = await panel({ op: "agent_delete", chat: c.id }); if (r.t !== "done") toast("⚠️ " + r.text); } catch (er) { toast(problem(er)); }
            if (c.id === claude.chat) claude.chat = "";
            reloadClaude();
          } })));
        }
        box.append(el("div", { style: "margin-top:14px" }, rescueCard()));  // (under the list: for when this chat breaks)
      });
    }
    function drawServer(d) {
      const bad = [];
      if (!d.vpn.ok) bad.push("VPN не работает");
      if (d.obfs && !d.obfs.ok) bad.push("Hysteria с маскировкой не работает");
      if (d.vless && !d.vless.ok) bad.push("запасной VLESS не работает");
      if (d.tgproxy && !d.tgproxy.ok) bad.push("Telegram без VPN не работает");
      const brBad = d.bridges.filter((b) => !b.ok);
      if (brBad.length) bad.push(brBad.length === 1 ? `не работает мост «${brBad[0].label}»` : `не работают мосты: ${brBad.length}`);
      if (d.cert_days !== null && d.cert_days < 10) bad.push(`сертификат кончается через ${d.cert_days} дн.`);
      if (d.disk[1] && d.disk[0] / d.disk[1] > 0.92) bad.push("диск почти заполнен");
      const host = d.hosting;
      if (host && host.set && host.days_left < 5) bad.push(`хостинг: осталось ${Math.floor(host.days_left)} дн., пополните`);
      scroll.append(el("div", { class: "ow-status server-head" + (bad.length ? " bad" : "") },
        el("span", { class: "ow-ic " + (bad.length ? "bad" : "ok"), text: bad.length ? "⚠️" : "✅" }),
        el("div", { class: "ow-t" }, bad.length ? "Есть проблемы" : "Всё работает",
          el("small", { text: bad.length ? bad.join(" · ") : `${d.host} · ${d.ip}` + (d.online !== null ? ` · в сети: ${d.online}` : "") }))));
      // what the owner needs: the hosting's days left, the server's version, the VPN's programs; the backup, the disk, remote desktop
      const main = el("div", { class: "ow-list" });
      if (host) main.append(hostingRow(host));
      if (d.update) main.append(...updateRows(d.update));
      if (d.vpn_soft) main.append(vpnSoftRow(d.vpn_soft));  // (no versions read yet: nothing to show)
      scroll.append(section("Сервер"), main, section("Обслуживание"),
        el("div", { class: "ow-list" }, "backup" in d ? backupRow(d.backup) : null, storageRow(), line("🖥", "Удалённый доступ", "RustDesk для Windows и Android", null, remoteSheet)));
    }
    // ---- the last backup: when, made or not, where it went; one now by a tap ----
    function backupRow(b) {
      const now = el("button", { class: "ow-btn", text: "💾 Сейчас", onclick: async (e) => {
        e.stopPropagation();
        now.disabled = true;
        try {
          const end = await panel({ op: "backup" });
          toast(end.t === "done" ? "💾 Копия делается — о ней придёт событие через пару минут" : "⚠️ " + end.text, 6000);
        } catch (x) { toast(problem(x)); now.disabled = false; }
      } });
      const sub = !b ? "ещё не делалась — сервер сделает сам, когда изменится важное"
        : b.ok ? (b.where ? "Лежит " + b.where + "." : "Сделана.") : [String(b.text || "").replace(/^\S+\s*/, ""), "bad"];
      // (v36) the move to a new server in one command (the newest copy from the Yandex Disk): a tap shows it
      const move = b && b.move ? () => sheet("💾 Переезд на новый сервер", (box) => box.append(
        el("p", { style: "margin:0 0 8px;font-size:15px", text: "На новом сервере (Ubuntu 24.04, вход root) вставьте одну строку. Она возьмёт самую "
          + "новую копию с вашего Яндекс Диска, спросит пароль резервных копий и перенесёт всё: VPN и мосты, людей, ИИ-помощника, Claude и "
          + "Дозор. В конце скажет, что поменять в DNS. Старый сервер для этого не нужен." }),
        el("pre", { class: "dev-preview move-line", style: "white-space:pre-wrap;word-break:break-all;font-size:12px;max-height:30vh;overflow:auto", text: b.move }),
        el("div", { class: "ow-acts" }, el("button", { class: "btn", text: "📋 Скопировать строку", onclick: () => { copyText(b.move); toast("✅ Скопировано — вставьте на новом сервере", 5000); } })),
        el("p", { class: "ow-note", text: "Эта же строка лежит на Яндекс Диске, в папке «Семейный сервер — копии», файл «Как восстановить.txt». "
          + "Копии там зашифрованы вашим паролем резервных копий." }))) : null;
      const r = line("🗂", b ? `Копия: ${when(b.ts)} ${b.ok ? "✓" : "✗"}` : "Резервная копия", b && b.move && typeof sub === "string" ? sub + " Переезд на новый сервер — одной командой." : sub,
        now, move, !b ? "off" : b.ok ? "ok" : "bad");
      r.classList.add("backup-card");
      return r;
    }
    // ---- the VPN's programs: Hysteria and Xray as installed, the approved ones, the last nightly update's word (vpn-update) ----
    function vpnSoftRow(v) {
      const n = (s) => String(s || "").replace(/^app\//, "").replace(/^v/, "");
      const newer = (a, b) => {  // "2.13.0" after "2.12.1"
        const x = n(a).split(/[.-]/).map(Number), y = n(b).split(/[.-]/).map(Number);
        for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; }
        return false;
      };
      // latest: the version the server release approved (a week old, its sum pinned); only a newer one is installed
      const one = (name, cur, latest, bad) => !cur ? "" : `${name} ${cur}` + (!latest || !newer(latest, cur) ? ""
        : n(bad) === n(latest) ? ` (новая ${latest} не прошла проверку)` : ` (${latest} встанет ночью)`);
      const parts = [one("Hysteria", v.hysteria, v.hysteria_latest, v.hysteria_bad), one("Xray", v.xray, v.xray_latest, v.xray_bad)].filter(Boolean);
      const recent = v.note && v.note_at && Date.now() / 1000 - v.note_at < 7 * 86400;
      const warn = recent && /^(↩️|⚠️)/.test(v.note);
      const sub = (parts.join(" · ") || "версии не прочитались") + (warn ? ". " + v.note.replace(/^\S+\s*VPN:\s*/, "") : "");
      const r = line("🛡", "Программы VPN", [sub, warn ? "bad" : ""], value(warn ? "⚠️" : "✓", warn ? "bad" : "ok"), null, warn ? "bad" : "ok");
      r.classList.add("vpn-soft");
      return r;
    }
    // ---- the disk: free and taken; the clean-up of the server's leftovers a tap away ----
    const gb = (v) => String(Math.round((+v || 0) * 10) / 10).replace(".", ",") + " ГБ";
    function storageRow() {
      let cur = line("💾", "Диск", "проверяю…", null, null, "off");
      const fill = (s) => {
        const d = s.disk, pct = d.total ? Math.min(100, Math.round(d.used / d.total * 100)) : 0;
        const r = line("💾", "Диск · свободно " + gb(d.free), [`занято ${gb(d.used)} из ${gb(d.total)}`, pct > 90 ? "bad" : ""], null,
          () => storageSheet(s, fill), pct > 90 ? "bad" : pct > 75 ? "warn" : "ok");
        r.classList.add("storage-row");
        r.querySelector(".ow-t").append(el("div", { class: "ow-bar" },
          el("i", { style: `width:${pct}%;background:${pct > 90 ? "var(--danger)" : pct > 75 ? "#f79009" : "var(--ok)"}` })));
        if (cur.isConnected) cur.replaceWith(r);
        cur = r;
      };
      panel({ op: "storage" }).then((s) => (s.t === "done" ? fill(s) : cur.remove())).catch(() => cur.remove());
      return cur;
    }
    function storageSheet(s, fill) {
      sheet("💾 Диск", (box, close) => {
        const c = s.clean, d = s.disk;
        box.append(el("div", { style: "font-size:15px;margin:-6px 0 6px", text: `Свободно ${gb(d.free)} · занято ${gb(d.used)} из ${gb(d.total)}` }),
          el("p", { class: "ow-note", style: "margin:0 2px 12px", text: c ? `Последняя чистка ${when(c.ts)}: освобождено `
            + (c.freed_mb >= 100 ? gb(c.freed_mb / 1024) : (c.freed_mb || 0) + " МБ") + "." : "Чистки ещё не было." }),
          el("button", { class: "btn line wide", text: "🧹 Очистить сервер", onclick: async (e) => {
            if (!(await confirmBox("Убрать с сервера мусор: старые пакеты и ядра, кэши, временные файлы, старые журналы и копии установщика? "
              + "Резервные копии, ключи и данные людей не трогаются.", "Очистить"))) return;
            close();
            try {
              const end = await panel({ op: "storage_clean" });
              if (end.t !== "done") { toast("⚠️ " + end.text, 6000); return; }
              toast("🧹 Чистка идёт в фоне, 1–5 минут. Итог появится в «Диске».", 6000);
              setTimeout(() => panel({ op: "storage" }).then((r) => r.t === "done" && fill(r)).catch(() => {}), 180000);
            } catch (x) { toast(problem(x)); }
          } }));
      });
    }
    // the bridges: what they are for in one line, each one's state (a tap: its link, a restart), and one way to add more
    const BRIDGES = [
      ["wb", "⚡ WB Stream", "Самый быстрый. Нужен только ваш номер телефона: код придёт по СМС от WB."],
      ["vk", "VK Звонки", "Нужен ваш аккаунт VK: войдёте один раз по номеру телефона."],
      ["dion", "DION", "Нужна бесплатная учётная запись на dion.vc (почта и пароль)."],
      ["bitrix", "Битрикс24", "Нужен свой бесплатный портал на bitrix24.ru (почта не Gmail)."],
    ];
    // the bridges: each one's state and whether Winger gets it (a tap: its link, a restart), and one way to add more
    const WINGER = { yes: "в Winger ✓", copy: "у человека", nolink: "в Winger не попал: нет ссылки звонка", spare: "запасной: в Winger мост этого сервиса уже есть" };
    function bridgesCard(d) {
      const list = el("div", { class: "ow-list bridges" });
      for (const b of d.bridges) {
        const w = b.winger || (bridgeKind(b) ? "" : "nolink");
        const sub = [(b.ok ? "работает " + dur(b.since) : UNIT[b.state] || b.state) + (+b.restarts ? `, перезапусков: ${b.restarts}` : ""), WINGER[w] || ""]
          .filter(Boolean).join(" · ");
        // (v37) the owner: «в приложении кнопка добавить мост (определённый) в Winger» — this one bridge, right on its row
        const wl = wingerLink(b);
        const add = wl ? el("a", { class: "ow-btn bridge-to-winger", href: wl, style: "text-decoration:none;display:inline-flex;align-items:center;flex:none",
          "aria-label": "Добавить этот мост в Winger", text: "📲 В Winger", onclick: (e) => { e.stopPropagation(); toast("📲 Открываю Winger: мост «" + b.label.replace(/^\S+\s/, "") + "» добавится отдельно", 4000); } }) : null;
        list.append(line(b.ok ? "🟢" : "🔴", b.label, [sub, b.ok && w !== "nolink" ? "" : "bad"], add, () => bridgeSheet(b), b.ok ? "ok" : "bad"));
      }
      if (!d.bridges.length) list.append(line("🌉", "Мостов пока нет", "Мост нужен, когда сервер напрямую не открывается (белые списки).", null, null, "off"));
      const missing = BRIDGES.filter(([p]) => !d.bridges.some((b) => b.id.startsWith(p + "-")));
      if (missing.length) list.append(line("➕", "Добавить мост", "не подключены: " + missing.map(([, name]) => name.replace(/^\S+\s(?=WB)/, "")).join(", "),
        null, () => addBridge(d, missing)));
      return [section("🌉 Мосты · " + d.bridges.length), list,
        el("p", { class: "ow-note", style: "margin-top:-4px", text: "Winger берёт мосты сам, по одному на сервис; «📲 В Winger» — добавить один мост сразу, отдельно от остальных. Кому дать мост — в карточке человека («🌉 Мост»)." })];
    }
    // a bridge of the server as a Winger link, with its service's best settings ("" when its call is not there)
    // dual: Telemost's two-track trial (the screenshare as a second track) — a link of its own beside the usual one
    function wingerLink(b, dual) {
      const link = b.link || "", enc = encodeURIComponent(link);
      const short = b.label.replace(/^\S+\s/, "");  // «Телефон · Телемост»; a person's «Мама · Телемост» — their Winger needs no name
      const name = encodeURIComponent("Мост · " + (b.label.startsWith("👤") ? short.replace(/^[^·]+· /, "") : short));
      const kind = bridgeKind(b);
      if (kind === "tm" && dual) return "winger-bridge://telemost?link=" + enc + "&fps=24&batch=45&reliable=1&dual=1#" + encodeURIComponent(TM2);
      return kind === "tm" ? "winger-bridge://telemost?link=" + enc + "&fps=24&batch=45&reliable=1&dual=0#" + name
        : kind === "wb" ? "winger-bridge://wbstream?room=" + enc + "&mode=dc&fps=24&batch=30&reliable=1&dual=0#" + name
        : kind === "dion" ? "winger-bridge://dion?room=" + enc + "#" + name
        : kind === "bitrix" ? "winger-bridge://bitrix?link=" + enc + "&mode=dc&fps=24&batch=30&reliable=1&dual=0#" + name
        : kind === "vk" ? "winger-bridge://vk?link=" + enc + "&mode=dc#" + name : "";
    }
    const TM2 = "Мост · Телемост · 2 трека (проверка)";
    function bridgeKind(b) {
      const link = b.link || "";
      if (/^https:\/\/telemost(\.360)?\.yandex\.(ru|com)\/j\/[0-9A-Za-z_-]+$/.test(link)) return "tm";
      if (b.id.startsWith("wb-") && /^wbstream:\/\/[0-9A-Za-z_-]{6,64}$/.test(link)) return "wb";
      if (b.id.startsWith("dion-") && /^dion:\/\/[0-9A-Za-z_-]{4,64}$/.test(link)) return "dion";
      if (b.id.startsWith("bitrix-") && /^https:\/\/[0-9A-Za-z-]{2,63}\.bitrix24\.(ru|by|kz|com)\/video\/[0-9A-Za-z_-]{2,64}$/.test(link)) return "bitrix";
      if (b.id.startsWith("vk-") && /^https:\/\/vk\.(com|ru)\/call\/join\/[0-9A-Za-z_-]{10,200}$/.test(link)) return "vk";
      return "";
    }
    function bridgeSheet(b) {
      // what this bridge's service needs again when it stops (a new WB sign-in, another password), and Winger's link
      const link = b.link || "", w = wingerLink(b);
      const person = b.label.startsWith("👤");  // a person's own bridge: a copy of the owner's, nothing to sign in to
      // by the bridge's name, not its link: a bridge that has lost its call (no link) needs the sign-in most
      const wb = b.id.startsWith("wb-") && !person, dn = b.id.startsWith("dion-"), bx = b.id.startsWith("bitrix-"), vk = b.id.startsWith("vk-") && !person;
      sheet((b.ok ? "🟢 " : "🔴 ") + b.label, (box, close) => {
        box.append(el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 12px", text: b.ok
          ? "Работает " + dur(b.since) + ". Winger подключается к нему сам, когда сервер напрямую недоступен."
          : "Сейчас не работает (" + (UNIT[b.state] || b.state) + "). Сначала — перезапуск" + (wb ? "; не помог — войдите в WB заново." : vk ? "; не помог — войдите в VK заново." : dn || bx ? "; не помог — проверьте почту и пароль." : ".") }),
          el("button", { class: "btn wide", text: "🔄 Перезапустить", onclick: () => { close(); act({ op: "bridge_restart", id: b.id }, "🔄 Перезапускаю мост…"); } }));
        if (wb) box.append(el("button", { class: "btn line wide", style: "margin-top:8px", text: "🔑 Войти в WB заново", onclick: () => { close(); wbBridge(); } }));
        if (vk) box.append(el("button", { class: "btn line wide", style: "margin-top:8px", text: "🔑 Войти в VK заново", onclick: () => { close(); vkBridge(); } }));
        if (dn || bx) box.append(el("button", { class: "btn line wide", style: "margin-top:8px", text: "🔑 Сменить почту или пароль", onclick: () => { close(); acctBridge(dn ? "dion" : "bitrix"); } }));
        if (w) {
          box.append(el("a", { class: "btn line wide", href: w, style: "text-decoration:none;text-align:center;display:block;margin-top:8px", text: "📲 Добавить в Winger сейчас" }),
            el("div", { style: "font-size:12px;color:var(--muted);margin:4px 2px 0", text: "Не обязательно: Winger сам получает мосты в течение часа." }));
          if (bridgeKind(b) === "tm") box.append(el("a", { class: "btn line wide", href: wingerLink(b, true), style: "text-decoration:none;text-align:center;display:block;margin-top:8px", text: "📲 Добавить «2 трека (проверка)»" }),
            el("div", { style: "font-size:12px;color:var(--muted);margin:4px 2px 0", text: "Тот же звонок по двум трекам: вдвое быстрее, если Телемост пропускает второй. Обычная ссылка остаётся рядом." }));
        }
        if (link) box.append(el("button", { class: "btn soft wide", style: "margin-top:12px", text: "📋 Ссылка звонка — для другого устройства",
          onclick: () => { copyText(link); toast("✅ Ссылка скопирована"); } }));
      });
    }
    function addBridge(d, missing) {
      sheet("➕ Новый мост", (box, close) => {
        box.append(el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 12px", text: d.bridges.length
          ? "Обычно хватает одного моста. Ещё один пригодится, если имеющийся медленный или перестал подключаться."
          : "Выберите, через какой сервис поднять мост. Достаточно одного." }));
        for (const [p, name, need] of missing) {
          box.append(el("div", { class: "row", style: "cursor:pointer", onclick: () => { close(); p === "wb" ? wbBridge() : p === "vk" ? vkBridge() : acctBridge(p); } },
            el("div", { class: "grow" }, el("b", { text: name }), el("small", { text: need })), "›"));
        }
      });
    }
    // ---- remote desktop to the owner's laptop: RustDesk on its own public servers; here only where to get it ----
    const RUSTDESK = [
      ["💻", "RustDesk для Windows", "https://github.com/rustdesk/rustdesk/releases/download/1.5.0/rustdesk-1.5.0-x86_64.exe"],
      ["📱", "RustDesk для Android", "https://github.com/rustdesk/rustdesk/releases/download/1.5.0/rustdesk-1.5.0-universal-signed.apk"],
    ];
    function remoteSheet() {
      sheet("🖥 Удалённый доступ", (box) => {
        box.append(el("p", { class: "ow-note", style: "margin:-6px 2px 10px", text: "RustDesk — экран ноутбука с телефона. Поставьте на оба устройства." }));
        const list = el("div", { class: "ow-list" });
        for (const [icon, name, url] of RUSTDESK) {
          list.append(line(icon, name, null, el("span", { style: "display:flex;gap:6px;flex:none" },
            el("a", { class: "ow-btn", href: url, style: "text-decoration:none;display:inline-flex;align-items:center", text: "⬇️ Скачать" }),
            el("button", { class: "ow-btn line", title: "Скопировать ссылку", "aria-label": "Скопировать ссылку", text: "📋", onclick: () => { copyText(url); toast("✅ Ссылка скопирована"); } }))));
        }
        box.append(list);
      });
    }
    // the hosting: how many days the balance lasts, and when to pay (the balance is entered after a top-up, or taken from
    // the hoster's account by the app itself)
    function hostingRow(h) {
      const day = (t) => new Date(t * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
      const sign = { EUR: " €", USD: " $", RUB: " ₽" }[h.currency] || " €";
      const eur = (v) => v.toFixed(2).replace(".", ",") + sign;
      const n = h.set ? Math.floor(h.days_left) : 0;
      const auto = Native && Native.hostingBalance, linked = !!(auto && store.get("hostvds", false));
      if (linked && Date.now() - store.get("hostvdsAt", 0) > 30 * 60000) {  // not on every redraw: at most every half hour
        store.set("hostvdsAt", Date.now());
        nativeCall("hostingBalance").then(async (r) => {
          let js = {};
          try { js = JSON.parse(r.text); } catch (e) { /* nothing */ }
          if (js.ok) {
            const end = await panel({ op: "hosting_set", balance: String(js.balance), currency: js.currency, source: "auto" }).catch(() => null);
            if (end && end.t === "done") setTimeout(load, 500);
          } else if (js.why === "login") {
            store.set("hostvds", false);
            toast("🔗 Вход в кабинет хостинга истёк — включите автопроверку снова («Хостинг»)", 6000);
          }
        });
      }
      const sub = !h.set ? "Баланс не введён — нажмите" : (n > 0 ? "пополнить до " + day(h.pay_by) : "пополните сейчас, иначе сервер остановят")
        + (linked ? " · 🔗 из кабинета" + (h.source === "auto" && h.at ? " " + ago(h.at) + " назад" : "") : "");
      const r = line("💳", "Хостинг " + h.provider, [sub, h.set && n < 5 ? "bad" : ""],
        value(!h.set ? "—" : n > 0 ? `на ${n} дн.` : "баланс 0", h.set && n < 5 ? "bad" : h.set && n >= 10 ? "ok" : ""),
        () => hostingSheet(h, eur, day), !h.set ? "off" : n < 5 ? "bad" : n < 10 ? "warn" : "ok");
      r.classList.add("hosting-row");
      return r;
    }
    function hostingSheet(h, eur, day) {
      const auto = Native && Native.hostingBalance, linked = !!(auto && store.get("hostvds", false));
      sheet("💳 Хостинг " + h.provider, (box, close) => {
        if (h.set) box.append(el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 12px",
          text: `На балансе ≈ ${eur(h.balance)} · тариф ${eur(h.monthly)} в месяц (≈ ${eur(h.per_day)} в день). Баланс ${h.source === "auto" ? "из кабинета" : "введён"} ${day(h.at)}; за 5 дн. до конца напомню.` }));
        box.append(el("button", { class: "btn wide", text: h.set ? "💶 Пополнил — ввести баланс" : "💶 Ввести баланс", onclick: async () => {
          close();
          const v = await ask("Баланс HostVDS, €", "Например 12,40 — как в кабинете HostVDS → Биллинг");
          if (v) act({ op: "hosting_set", balance: v }, null, (r) => toast(`✅ Хватит примерно на ${Math.floor(r.hosting.days_left)} дн.`, 4000));
        } }), el("a", { class: "btn line wide", href: h.panel, style: "margin-top:8px;text-decoration:none;text-align:center", text: "🌐 Кабинет хостинга" }));
        if (auto) box.append(el("button", { class: "btn line wide", style: "margin-top:8px", text: linked ? "🔗 Автопроверка ✓ — выключить" : "🔗 Автопроверка баланса",
          onclick: async () => {
            close();
            if (linked) {
              if (!(await confirmBox("Выключить автопроверку? Приложение забудет вход в кабинет, баланс — вручную.", "Выключить"))) return;
              Native.hostingLogout(); store.set("hostvds", false); draw(); return;
            }
            const r = await nativeCall("hostingLogin");
            if (!r.ok) return;
            store.set("hostvds", true); store.set("hostvdsAt", 0);
            toast("✅ Кабинет подключён — беру баланс…"); draw();
          } }));
        box.append(el("button", { class: "btn line wide", style: "margin-top:8px", text: `⚙️ Тариф: ${eur(h.monthly)} в месяц`, onclick: async () => {
          close();
          const v = await ask("Сколько стоит сервер в месяц, €", "Сейчас " + eur(h.monthly) + " (HostVDS-4)", String(h.monthly).replace(".", ","));
          if (v) act({ op: "hosting_set", monthly: v }, null, () => toast("✅ Тариф сохранён"));
        } }));
      });
    }
    async function act(body, started, done) {  // a server action with its spinner; done(result) when it answers
      if (S.busy.vpn) { toast("Подождите, предыдущее действие ещё идёт"); return; }
      S.busy.vpn = true;
      if (started) toast(started, 4000);
      try {
        const end = await panel(body, (t) => toast(t, 120000));
        if (end.t !== "done") toast("⚠️ " + end.text, 6000);
        else { if (done) done(end); setTimeout(load, 1500); }
      } catch (e) { toast(problem(e)); } finally { S.busy.vpn = false; }
    }
    // the bridge over VK calls: sign in to VK once (in the app — or a cookies file in a browser), the server starts a
    // VK call of its own, Winger gets it by itself and joins it as a guest
    function vkBridge() {
      sheet("🌉 Мост через VK Звонки", (box, close) => {
        const go = async (cookies) => {
          close();
          try {
            const end = await panel({ op: "bridge_vk", cookies }, (t) => toast(t, 260000));
            document.querySelectorAll(".toast").forEach((t) => t.remove());
            if (end.t !== "done") { toast("⚠️ " + end.text, 9000); return; }
            toast("✅ Мост VK работает — Winger возьмёт его сам", 6000);
            load();
          } catch (e) { toast(problem(e)); }
        };
        box.append(el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 10px", text: "Мост через видеозвонки VK. "
          + "Нужен один раз войти в VK — дальше сервер держит звонок сам. Вход хранится только на вашем сервере." }));
        if (window.AIBridge && window.AIBridge.vkLogin) {
          box.append(el("ol", { style: "margin:0 0 12px;padding-left:20px;font-size:15px;line-height:1.5" },
            el("li", { text: "Нажмите «Войти в VK» — откроется страница VK." }),
            el("li", { text: "Войдите своим номером телефона и кодом — как обычно в VK." }),
            el("li", { text: "Нажмите «Готово» вверху. Через 1–2 минуты мост заработает." }),
            el("li", { text: "Winger получит мост сам. Если VK спросит «я не робот» — придёт уведомление, нажмите его." })),
          el("button", { class: "btn wide", text: "🔑 Войти в VK", onclick: async () => {
            const r = await nativeCall("vkLogin");
            if (!r.ok) { toast("Вход в VK не закончен", 4000); return; }
            go(r.text);
          } }));
        } else {  // a browser: a cookies file of vk.ru ([{name, value}, …]) instead of the sign-in
          const file = el("input", { type: "file", accept: ".json,application/json", style: "display:none" });
          file.onchange = async () => {
            try {
              const js = JSON.parse(await file.files[0].text());
              const list = (Array.isArray(js) ? js : js.cookies || []).filter((x) => x && x.name && typeof x.value === "string")
                .map((x) => ({ name: x.name, value: x.value }));
              if (!list.some((x) => x.name === "remixsid")) { toast("⚠️ В файле нет входа VK (remixsid)", 6000); return; }
              go(JSON.stringify(list));
            } catch (e) { toast("⚠️ Это не файл cookies VK", 5000); }
          };
          box.append(file, el("button", { class: "btn wide", text: "📂 Файл cookies VK", onclick: () => file.click() }));
        }
      });
    }
    // the quick bridge over WB Stream: sign in to WB once (in the app — or the creator's cookies file in a browser),
    // the server starts the bridge, Winger gets it by itself
    function wbBridge() {
      sheet("⚡ Мост через WB Stream", (box, close) => {
        const go = async (token) => {
          close();
          try {
            const end = await panel({ op: "bridge_wb", token }, (t) => toast(t, 260000));
            document.querySelectorAll(".toast").forEach((t) => t.remove());
            if (end.t !== "done") { toast("⚠️ " + end.text, 9000); return; }
            toast("✅ Мост WB Stream работает — Winger возьмёт его сам", 6000);
            load();
          } catch (e) { toast(problem(e)); }
        };
        box.append(el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 10px", text: "Мост через видеозвонки WB Stream (Wildberries). "
          + "Нужен один раз войти в WB Stream — дальше сервер держит мост сам." }));
        if (window.AIBridge && window.AIBridge.wbLogin) {
          box.append(el("ol", { style: "margin:0 0 12px;padding-left:20px;font-size:15px;line-height:1.5" },
            el("li", { text: "Нажмите «Войти в WB Stream» — откроется страница WB." }),
            el("li", { text: "Введите свой номер телефона и код из СМС — как при входе в Wildberries." }),
            el("li", { text: "Окно закроется само. Через 1–2 минуты мост заработает." }),
            el("li", { text: "Всё: Winger получит мост сам, в нём появится ещё одна кнопка моста." })),
          el("button", { class: "btn wide", text: "🔑 Войти в WB Stream", onclick: async () => {
            const r = await nativeCall("wbLogin");
            if (!r.ok) { toast("Вход в WB не закончен", 4000); return; }
            go(r.text);
          } }));
        } else {  // a browser: the creator app's cookies file (cookies-wbstream.json) instead of the sign-in
          const file = el("input", { type: "file", accept: ".json,application/json", style: "display:none" });
          file.onchange = async () => {
            try {
              const js = JSON.parse(await file.files[0].text());
              const c = (Array.isArray(js) ? js : js.cookies || []).find((x) => x && x.name === "wb_access_token");
              if (!c || !c.value) { toast("⚠️ В файле нет входа WB (wb_access_token)", 6000); return; }
              go(c.value);
            } catch (e) { toast("⚠️ Это не файл cookies-wbstream.json", 5000); }
          };
          box.append(file, el("button", { class: "btn wide", text: "📂 Файл cookies-wbstream.json", onclick: () => file.click() }),
            el("div", { style: "font-size:12px;color:var(--muted);margin-top:8px", text: "Файл — из WhitelistBypass Creator: WBStream → войти → Export Cookies. "
              + "В приложении на телефоне вход проще: кнопка «Войти в WB Stream»." }));
        }
      });
    }
    // a bridge over DION or Bitrix24: an account made there once (e-mail and password); the server signs in itself
    function acctBridge(platform) {
      const bx = platform === "bitrix", name = bx ? "Битрикс24" : "DION";
      sheet("➕ Мост " + name, (box, close) => {
        const email = el("input", { class: "input", type: "email", placeholder: "Почта аккаунта", autocomplete: "off" });
        const pass = el("input", { class: "input", type: "password", placeholder: "Пароль", autocomplete: "off", style: "margin-top:8px" });
        const portal = bx ? el("input", { class: "input", placeholder: "https://b24-xxxxxx.bitrix24.ru", autocomplete: "off", style: "margin-top:8px" }) : null;
        box.append(el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 12px", text: bx
          ? "Нужен свой бесплатный портал Битрикс24 — заведите его на сайте bitrix24.ru на почту НЕ Gmail (mail.ru, yandex.ru): "
            + "с Gmail звонки не создаются. Адрес портала — из адресной строки после входа. Сервер сам входит и держит мост."
          : "Нужен аккаунт DION — бесплатная регистрация на dion.vc по почте. Сервер сам входит этой почтой и паролем и держит мост." }),
          email, pass, ...(portal ? [portal] : []),
          el("button", { class: "btn wide", style: "margin-top:12px", text: "🌉 Поднять мост " + name, onclick: async () => {
            const body = { op: "bridge_acct", platform, email: email.value.trim(), password: pass.value, portal: portal ? portal.value.trim() : "" };
            if (!body.email || !body.password || (bx && !body.portal)) { toast("Заполните все поля", 3000); return; }
            close();
            try {
              const end = await panel(body, (t) => toast(t, 260000));
              document.querySelectorAll(".toast").forEach((t) => t.remove());
              if (end.t !== "done") { toast("⚠️ " + end.text, 9000); return; }
              toast(`✅ Мост ${name} работает — Winger возьмёт его сам`, 6000);
              load();
            } catch (e) { toast(problem(e)); }
          } }));
      });
    }
    // the AI app's people: add, send the app and a sign-in code, no limits, switch off, sign out, delete
    function drawApp(d) {
      // the main job first (people); then how the helper is doing: its models, a check of it all, the trends, the keys
      scroll.append(el("button", { class: "btn wide", style: "margin:0 0 8px", text: "➕ Добавить человека", onclick: addPerson }),
        el("button", { class: "btn line wide", style: "margin:0 0 4px", text: "🔗 Ссылка на приложение помощника",
          onclick: () => makeLink({ op: "dl_aiapp" }, "ИИ-помощник") }));
      const list = el("div", { class: "ow-list people" });
      for (const u of d.users) {
        const now = u.seen && Date.now() / 1000 - u.seen < 900;
        list.append(line(u.off ? "⏸" : now ? "🟢" : "⚪", u.name + (u.id === d.me ? " · вы" : ""),
          u.off ? "доступ отключён" : !u.seen ? "ещё не входил(а)" + (u.codes ? " · код создан — отправьте ссылку из карточки" : "")
            : (now ? "сейчас в приложении" : "был(а) " + ago(u.seen) + " назад") + (u.devices > 1 ? ` · телефонов: ${u.devices}` : ""),
          null, () => person(u.id), u.off ? "off" : now ? "ok" : "off"));
      }
      scroll.append(section("Кто пользуется · " + d.users.length), list, section("Помощник"),
        el("div", { class: "ow-list" }, line("🩺", "Проверить помощника", "модели, поиск, ссылки, видео, тренды и ключи — разом", null, () => helperCheck(d)),
          trendsRow(), line("🔑", "Ключи и подключения", "модели, Яндекс Диск, видео из фото, поиск", null, allKeys)));
      if (d.models && d.models.length) scroll.append(...modelsCard(d.models));
      panel({ op: "hf_get" }).then((v) => { if (v.t === "done") video = v; }).catch(() => {});  // (the people's «🎬 Видео» says what they get)
    }
    // ---- «🧠 Модели»: which of the helper's models answer, and the last word of those that do not ----
    const failing = (m) => m.err_at && (!m.ok || m.err_at > m.ok);
    function modelsCard(models) {
      const list = el("div", { class: "ow-list models-card" });
      for (const m of models) {
        const bad = failing(m);
        const ic = m.closed ? "⛔" : bad ? "🔴" : m.ok ? "🟢" : "⚪";
        const say = m.closed ? "закрыта для бесплатных ключей — пропускается до завтра"
          : bad ? String(m.err || "").replace(/^[^:]{1,30}:\s*/, "") + " · " + ago(m.err_at) + " назад"
          : m.ok ? "отвечала " + ago(m.ok) + " назад" : "ещё не спрашивали";
        list.append(line(ic, m.name.replace(/^\S+\s/, ""), say + (m.no_images ? " · фото не принимает" : ""), null, null,
          m.closed || bad ? "bad" : m.ok ? "ok" : "off"));
      }
      const up = models.filter((m) => m.ok && !failing(m) && !m.closed).length;
      return [section("🧠 Модели · отвечают " + up + " из " + models.length), list,
        el("p", { class: "ow-note", style: "margin-top:-4px", text: "Помощник сам берёт следующую модель, когда эта не отвечает." })];
    }
    // «🩺 Проверить помощника»: what the helper needs, looked at together — each line fills as its answer comes
    function helperCheck(d) {
      sheet("🩺 Проверка помощника", (box) => {
        const list = el("div", { class: "ow-list helper-check" });
        box.append(list);
        const step = (icon, title) => {
          let r = line(icon, title, "проверяю…", el("span", { class: "spin" }), null, "off");
          list.append(r);
          return (ok, sub, tap) => {
            const n = line(icon, title, [sub, ok === false ? "bad" : ""], value(ok === false ? "⚠️" : ok ? "✓" : "—", ok === false ? "bad" : ok ? "ok" : ""),
              tap || null, ok === false ? "bad" : ok ? "ok" : "off");
            n.dataset.ok = ok === false ? "no" : ok ? "yes" : "off";
            r.replaceWith(n);
            r = n;
          };
        };
        const ms = d.models || [];
        const up = ms.filter((m) => m.ok && !failing(m) && !m.closed);
        const down = ms.filter((m) => m.closed || failing(m)).map((m) => m.name.replace(/^\S+\s/, ""));
        step("🧠", "Модели")(!ms.length || (!up.length && !down.length) ? null : up.length > 0, !ms.length ? "нет ключей моделей"
          : !up.length && !down.length ? "ещё не спрашивали — с последнего перезапуска не было вопросов"
          : `отвечают ${up.length} из ${ms.length}` + (down.length ? " · не отвечают: " + down.join(", ") : ""));
        const keys = step("🔑", "Ключи"), disk = step("📦", "Ссылки на 24 часа"), video = step("🎬", "Видео из фото"), trends = step("🔥", "Тренды"),
          search = step("🌐", "Поиск в интернете");
        const ask = (op) => panel({ op }).catch((e) => ({ t: "error", text: problem(e) }));
        ask("agent_keys").then((r) => {
          if (r.t !== "done") return keys(false, r.text || "список ключей не открылся");
          const on = r.keys.filter((k) => k.on), unk = on.filter((k) => k.test === "unknown").map((k) => k.name);
          keys(unk.length ? false : true, `подключено ${on.length} из ${r.keys.length}` + (unk.length ? " · при проверке не ответили: " + unk.join(", ") : ""), allKeys);
        });
        ask("disk_get").then((v) => (v.t !== "done" ? disk(false, v.text || "не ответил")
          : disk(v.on ? true : null, v.on ? "Яндекс Диск подключён" + (v.free_gb !== undefined ? ` · свободно ${v.free_gb} ГБ` : "") : "Яндекс Диск не подключён — ссылки не делаются",
            () => diskSetup(v))));
        ask("hf_get").then((v) => {
          if (v.t !== "done") return video(false, v.text || "не ответил");
          if (!v.on) return video(null, "не подключено", () => videoSetup(v, () => {}));
          const sp = spaceState(v);
          video(!/danger/.test(sp.color), sp.short.replace(/\.$/, ""), () => videoSetup(v, () => {}));
        });
        ask("trends_get").then((v) => (v.t !== "done" ? trends(false, v.text || "не ответил")
          : trends(v.error ? false : (v.top || []).length ? true : null, v.error ? "последняя проверка: " + v.error
            : ((v.top || []).length ? `в топе: ${v.top.length}` : "подтверждённых трендов пока нет") + (v.at ? " · проверено " + ago(v.at) + " назад" : ""),
            () => trendsSheet(v, () => {}))));
        ask("search_get").then((v) => {
          if (v.t !== "done" || !v.on) return search(null, "поиск выключен");
          ask("search_test").then((r) => {  // (up to a minute: the search, a page, the weather, a table)
            if (r.t !== "done") return search(false, r.text || "не ответил");
            const k = r.check || {};
            search(!!(k.pages && k.weather && k.table), k.error ? "поиск не ответил" : `найдено ${k.results}, страниц ${k.pages} · погода ${k.weather ? "✓" : "⚠️"} · таблица ${k.table ? "✓" : "⚠️"}`,
              () => searchSheet(r, () => {}));
          });
        });
        box.append(el("p", { class: "ow-note", text: "Ничего не меняет и ключи не убирает. Нажмите строку — подробности и настройка." }));
      });
    }
    async function delPerson(u) {
      if (await confirmBox(`Удалить «${u.name}» из приложения? Доступ и память помощника о нём пропадут. VPN не затрагивается.`, "Удалить"))
        appOp({ op: "app_delete", id: u.id }, "🗑 Удалён(а): " + u.name);
    }
    async function appOp(body, done) {
      if (S.busy.vpn) return null;
      S.busy.vpn = true;
      try {
        const end = await panel(body);
        if (end.t !== "done") { toast("⚠️ " + end.text, 5000); return null; }
        if (done) toast(done);
        load();
        return end;
      } catch (e) { toast(problem(e)); return null; } finally { S.busy.vpn = false; }
    }
    async function addPerson() {
      const name = await ask("Как зовут?", "Например: Мама, Саша");
      if (!name) return;
      const r = await appOp({ op: "app_add", name: name.replace(/\s+/g, " ").trim().slice(0, 40) }, null);
      if (r) makeLink({ op: "dl_aiapp", id: r.id }, "ИИ-помощник — " + r.name);
    }
    // ---- video from a photo on Hugging Face: the owner's free minutes; the owner has it, others when allowed ----
    let video = null;
    const busyBtn = (b, text) => { b.disabled = true; b.dataset.was = b.textContent; b.textContent = text; };
    const freeBtn = (b) => { b.disabled = false; b.textContent = b.dataset.was || b.textContent; };
    // «Я в ролике» в HD: the own face-swap service on Hugging Face's GPUs (the server makes it with a Write token).
    // short: for the card (Russian, one line); long: for the sheet (the server's own words too)
    function spaceState(v) {
      const sp = v.space || {};
      const kind = { read: "Read", fineGrained: "Fine-grained" }[v.role] || v.role || "Read";
      if (!v.write) return { color: "var(--muted)", short: `⚡ «Я в ролике» в HD: нужен токен типа Write (сейчас — ${kind}).`,
        long: `⚡ Для «Я в ролике» в HD нужен токен типа Write — сейчас у вас ${kind}. Сделайте новый токен по шагам ниже и вставьте его.` };
      if (sp.ready) return { color: "var(--ok, #1a7f37)", short: "⚡ «Я в ролике» в HD: готов.", long: "⚡ «Я в ролике» в HD готов: ролики делаются на видеокарте за 1–3 минуты." };
      if (sp.error) {
        const plain = /^[А-Яа-яЁё«]/.test(sp.error) && sp.error.length < 140;
        return { color: "var(--danger-ink)", short: "⚡ «Я в ролике» в HD: " + (plain ? sp.error : "не создался — подробности в «Настроить»") + ".",
          long: "⚡ «Я в ролике» в HD не работает: " + sp.error + "." };
      }
      return { color: "var(--muted)", short: "⚡ «Я в ролике» в HD: готовится — пара минут.", long: "⚡ «Я в ролике» в HD готовится в вашем аккаунте — пара минут." };
    }
    // (v37, the audit) a read-only token of the same account for other people's Spaces: their code may see the token they
    // are given, and one with the right to write could change the owner's repositories (the own HD Space among them)
    function readTokenBox(v, close, fill) {
      const rin = el("input", { class: "input hf-read", placeholder: "hf_… (тип Read)", autocomplete: "off", spellcheck: "false" });
      return el("div", { class: "card hf-read-card", style: "margin-top:14px;font-size:14px;line-height:1.45" },
        el("b", { text: "🔒 Токен для чужих сервисов" }),
        el("div", { style: "margin:4px 0 8px;color:" + (v.read ? "var(--ok-ink, inherit)" : v.role === "write" ? "var(--danger-ink)" : "var(--muted)"),
          text: v.read ? "✅ Подключён: чужим сервисам (оживление, тренды) уходит токен только для чтения."
            : v.role === "write" ? "⚠️ Сейчас чужим сервисам уходит ваш токен с правом записи. Безопаснее добавить второй — тип Read: минуты те же, а менять ваши файлы на Hugging Face по нему нельзя."
            : "Можно добавить второй токен — тип Read: чужим сервисам будет уходить он." }),
        v.read ? "" : el("a", { class: "btn line wide", href: "https://huggingface.co/settings/tokens/new?tokenType=read",
          style: "display:block;text-align:center;text-decoration:none;margin-bottom:8px", text: "🔑 Получить токен Read" }),
        v.read ? "" : rin,
        v.read ? el("button", { class: "btn line wide", style: "margin-top:4px", text: "Убрать токен Read", onclick: async () => {
          try { const end = await panel({ op: "hf_read_off" }); close(); fill(end); toast("Токен Read убран"); } catch (e) { toast(problem(e)); }
        } }) : el("button", { class: "btn wide", style: "margin-top:8px", text: "✅ Подключить токен Read", onclick: async (e) => {
          const b = e.currentTarget;
          if (!rin.value.trim()) { toast("Сначала вставьте токен"); return; }
          busyBtn(b, "⏳ Проверяю токен…");
          try {
            const end = await panel({ op: "hf_read_set", token: rin.value.trim() });
            if (end.t !== "done") { toast("⚠️ " + end.text, 6000); freeBtn(b); return; }
            close(); fill(end); toast("✅ Токен Read подключён: чужим сервисам уходит только он", 5000);
          } catch (x) { toast(problem(x)); freeBtn(b); }
        } }));
    }
    function videoSetup(v, fill) {
      sheet("🎬 Видео из фото", (box, close) => {
        const inp = el("input", { class: "input", placeholder: "hf_…", autocomplete: "off", spellcheck: "false" });
        const sp = v.on ? spaceState(v) : null;
        box.append(
          sp ? el("div", { style: "font-size:15px;margin:-6px 0 10px;color:" + sp.color, text: sp.long }) : "",
          el("div", { style: "font-size:14px;color:var(--muted);margin:" + (sp ? "0" : "-6px") + " 0 10px", text: "Видео делают нейросети на видеокартах "
            + "Hugging Face. С токеном типа Write сервер сам создаст в вашем аккаунте закрытый сервис — и «Я в ролике» будет в HD за 1–3 минуты. "
            + "Бесплатно 5 минут видеокарты в день — на всех, кому вы включите." }),
          el("div", { style: "font-size:14px;margin:0 0 10px", text: "Новый аккаунт: «Я в ролике» в HD заработает через 30 дней после регистрации (и после подтверждения почты), остальное — сразу." }),
          el("ol", { style: "margin:0 0 12px;padding-left:20px;font-size:15px;line-height:1.5" },
            el("li", { text: "Нажмите «🔑 Получить токен» ниже — в браузере откроется сайт Hugging Face (huggingface.co), страница нового токена. Если сайт просит войти — войдите в свой аккаунт Hugging Face (нет аккаунта — «Sign Up», нужна только почта)." }),
            el("li", { text: "На этой странице вверху три вкладки: «Fine-grained», «Read», «Write» — нажмите «Write». В поле «Token name» впишите любое имя, например family. Внизу нажмите «Create token»." }),
            el("li", { text: "Появится окно с токеном (начинается с hf_) — нажмите «Copy» и вернитесь в это приложение." }),
            el("li", { text: "Вставьте сюда и нажмите «✅ " + (v.on ? "Заменить токен" : "Подключить") + "». В чаты токен не присылайте." })),
          el("a", { class: "btn line wide", href: "https://huggingface.co/settings/tokens/new?tokenType=write",
            style: "display:block;text-align:center;text-decoration:none;margin-bottom:10px", text: "🔑 Получить токен" }),
          inp,
          el("button", { class: "btn soft wide", style: "margin-top:8px", text: "📋 Вставить из буфера", onclick: async () => {
            let t = "";
            try { t = Native && Native.clipboard ? Native.clipboard() : await navigator.clipboard.readText(); } catch (e) { /* no access */ }
            if (t) inp.value = t.trim(); else toast("В буфере ничего нет — вставьте вручную");
          } }),
          el("button", { class: "btn wide", style: "margin-top:8px", text: "✅ " + (v.on ? "Заменить токен" : "Подключить"), onclick: async (e) => {
            const b = e.currentTarget;
            if (!inp.value.trim()) { toast("Сначала вставьте токен"); return; }
            busyBtn(b, "⏳ Проверяю токен…");
            try {
              const end = await panel({ op: "hf_set", token: inp.value.trim() });
              if (end.t !== "done") { toast("⚠️ " + end.text, 6000); freeBtn(b); return; }
              close(); fill(end);
              toast(`✅ Подключено${end.name ? ": " + end.name : ""}. Видео из фото — во вкладке «🎬 Видео»: «🖼️ Оживить фото»`, 5000);
            } catch (x) { toast(problem(x)); freeBtn(b); }
          } }),
          v.on ? readTokenBox(v, close, fill) : "",
          v.on && v.write ? el("button", { class: "btn line wide", style: "margin-top:14px", text: "🔄 Проверить HD-сервис", onclick: async (e) => {
            const b = e.currentTarget;
            busyBtn(b, "Проверяю… до минуты");
            try { const end = await panel({ op: "hf_space" }); close(); fill(end); toast(spaceState(end).short, 6000); }
            catch (x) { toast(problem(x)); freeBtn(b); }
          } }) : "",
          v.on ? el("button", { class: "btn line wide", style: "margin-top:14px;color:var(--danger-ink)", text: "Отключить видео из фото", onclick: async () => {
            if (!(await confirmBox("Отключить видео из фото? У всех пропадёт «🎬 Оживить», токен удалится с сервера.", "Отключить"))) return;
            try { const end = await panel({ op: "hf_off" }); close(); fill(end); toast("Видео из фото отключено"); } catch (e) { toast(problem(e)); }
          } }) : "");
      });
    }
    // ---- «🌐 Поиск в интернете» (in «🔑 Ключи»): how each source answered the chat last, and a check from the server now ----
    function searchWords(v) {
      const seen = (v.engines || []).filter((e) => e.at);
      const g = v.groq || {};
      const parts = seen.map((e) => e.name + (e.ok ? " ✓" : " ⚠️ " + e.why));
      if (g.key) parts.push("Groq" + (!g.at || g.ok ? " ✓" : " ⚠️ " + g.why));
      const c = v.check || {};
      const checked = c.at ? "Проверка " + ago(c.at) + " назад: " + (c.error ? "⚠️ поиск не ответил"
        : `найдено ${c.results}, прочитано страниц ${c.pages}`) + " · погода " + (c.weather ? "✓" : "⚠️") + " · таблица РПЛ "
        + (c.table ? "✓" : "⚠️") + (c.sec ? ` (за ${c.sec} с)` : "") + "." : "Проверки ещё не было.";
      return { last: parts.length ? "Последние ответы: " + parts.join(" · ") + "." : "С последнего перезапуска сервера в интернете ещё не искали.",
        checked, bad: !!(c.at && (c.error || !c.pages || !c.weather || !c.table)) };
    }
    function searchSheet(v, after) {
      sheet("🌐 Поиск в интернете", (box) => {
        const body = el("div");
        const fill = (x) => {
          const w = searchWords(x);
          body.innerHTML = "";
          body.append(el("p", { class: "ow-note", style: "margin:-6px 2px 8px", text: "Помощник сам ищет в интернете, когда вопросу нужны свежие факты. "
            + "Ключи Groq и Exa — в списке ключей ниже." }),
          el("div", { class: "card search-card", style: "font-size:14px;line-height:1.45" }, el("div", { text: w.last }),
            el("div", { style: "margin-top:6px" + (w.bad ? ";color:var(--danger-ink)" : ""), text: w.checked })));
        };
        fill(v);
        box.append(body, el("button", { class: "btn line wide", text: "🔎 Проверить сейчас", onclick: async (e) => {
          const b = e.currentTarget;
          busyBtn(b, "⏳ До минуты");
          try {
            const end = await panel({ op: "search_test" });
            if (end.t !== "done") { toast("⚠️ " + end.text, 6000); freeBtn(b); return; }
            fill(end); freeBtn(b);
            if (after) after(end);
            const k = end.check || {};
            toast(k.pages && k.weather && k.table ? "🌐 Поиск работает: страницы читаются, погода и таблица приходят"
              : "⚠️ Поиск ответил не полностью — подробности выше", 6000);
          } catch (x) { toast(problem(x)); freeBtn(b); }
        } }));
      });
    }

    // ---- «🔑 Ключи»: every key of the helper and Claude in one place — which are in, which are not, what each is for ----
    const KEY_SITE = {  // where each key is made
      dahl: "https://inference.dahl.global", orca: "https://orcarouter.ai", nvidia: "https://build.nvidia.com",
      zhipu: "https://open.bigmodel.cn", openrouter: "https://openrouter.ai/keys",
      groq: "https://console.groq.com/keys", exa: "https://dashboard.exa.ai/api-keys", giga: "https://developers.sber.ru/studio",
      cf: "https://dash.cloudflare.com",
      hf: "https://huggingface.co/settings/tokens/new?tokenType=write", coverr: "https://coverr.co/developers",
      viggle: "https://portal.viggle.ai/keys",
      anthropic: "https://console.anthropic.com/settings/keys",
    };
    // the keys the helper's own cards check and keep (search, video, trends): [set, off, the field the key goes in]
    const APP_KEY_OP = { groq: ["groq_set", "groq_off", "key"], exa: ["exa_set", "exa_off", "key"], hf: ["hf_set", "hf_off", "token"],
      coverr: ["coverr_set", "coverr_off", "key"], viggle: ["viggle_set", "viggle_off", "key"] };
    let keysNow = null, testedNow = null;  // the list and its last check, as the server last said them
    const KEY_PLACE = { claude: "🛠 Claude", app: "🤖 Помощник", draw: "🎨 рисование", video: "🎬 видео", search: "🔎 поиск" };
    function allKeys() {
      sheet("🔑 Ключи и подключения", (box) => {
        const conn = el("div", { class: "ow-list keys-conn" }, diskKeyRow(), searchKeyRow());
        const list = el("div", {}, el("div", { class: "status", style: "padding:12px" }, el("span", { class: "spin" }), "Загружаю…"));
        box.append(el("p", { class: "ow-note", style: "margin:-6px 2px 8px", text: "Нажмите строку — там написано, для чего это и где взять ключ; "
          + "там же его подключают, меняют и убирают. Ключи хранятся только на сервере — в чаты их не присылайте." }),
          section("Подключения"), conn, list);
        let hf = null;  // «🎬 Видео из фото»: its own sheet (the HD service's state, who has it)
        const openHf = async (k, fill) => {
          if (!hf) hf = await panel({ op: "hf_get" }).catch(() => null);
          if (hf && hf.t === "done") videoSetup(hf, (end) => { hf = end; video = end; panel({ op: "agent_keys" }).then((r) => r.t === "done" && fill(r.keys)).catch(() => {}); });
          else keyOne(k, fill);
        };
        const fill = (keys, tested) => {
          keysNow = keys;
          if (tested !== undefined) testedNow = tested;
          list.innerHTML = "";
          // each key: where it works (v30) and what its last check said; the ones in first, then the ones not
          const row = (k) => {
            const where = (k.places || []).map((p) => KEY_PLACE[p]).filter(Boolean).join(" · ");
            const bad = k.on && k.test === "unknown", busy = k.on && k.test === "busy";  // (v37) busy: the key good, its limit now
            const r = line(!k.on ? "➖" : bad ? "⚠️" : "✅", k.id === "hf" ? "Видео из фото (Hugging Face)" : k.name,
              [(where || k.use) + (bad ? " · ⚠️ при проверке не ответил" + (k.why ? ": " + k.why : "") : "")
                + (busy ? " · 🕓 ключ в порядке, у сервиса сейчас предел (норма на сегодня или занято)" : "") + (k.paid ? " · 💳 платный" : ""), bad ? "bad" : ""], null,
              () => (k.id === "hf" ? openHf(k, fill) : keyOne(k, fill)), k.on ? (bad ? "bad" : "ok") : "off");
            r.dataset.key = k.id;
            return r;
          };
          const on = keys.filter((k) => k.on), off = keys.filter((k) => !k.on);
          const t = testedNow;
          list.append(section(`Ключи · подключено ${on.length} из ${keys.length}`),
            el("p", { class: "ow-note keys-legend", style: "margin:-4px 2px 6px", text: "Где работает: 🛠 Claude — чат «🛠 Claude» и Дозор · "
              + "🤖 Помощник — ответы и фото · 🎨 рисование · 🎬 видео и «Я в ролике» · 🔎 поиск в интернете" }),
            on.length ? el("div", { class: "ow-list keys-list keys-on" }, ...on.map(row)) : null,
            off.length ? section(`Не подключены · ${off.length}`) : null,
            off.length ? el("div", { class: "ow-list keys-list keys-off" }, ...off.map(row)) : null,
            el("p", { class: "ow-note", text: t
              ? `🧪 Проверено ${ago(t.ts)} назад${t.auto ? " (само, после обновления)" : t.daily ? " (само, ночью — так каждую ночь)" : ""}`
                + (t.removed.length ? ` · убраны как не принятые: ${t.removed.join(", ")}` : " · не принятых не было")
              : "🧪 Все ключи ещё не проверялись разом." }),
            el("button", { class: "btn line wide", text: "🧪 Проверить все ключи", onclick: async (e) => {
              const b = e.currentTarget;
              busyBtn(b, "⏳ Пробую каждый ключ… до двух минут");
              const was = (testedNow && testedNow.ts) || 0;
              try {
                const r = await panel({ op: "agent_testkeys" });
                if (r.t !== "done") { toast("⚠️ " + r.text, 7000); freeBtn(b); return; }
                if (!r.started) { fill(r.keys, r.tested); toast(r.text, 9000); return; }  // (a server before 31: it waited itself)
                // (v31) the check goes on the server by itself: its result is asked for now and then (a line lost meanwhile
                // on a bridge or a white-list does not lose it)
                for (let i = 0; i < 60; i++) {
                  await new Promise((ok) => setTimeout(ok, 4000));
                  if (!document.body.contains(list)) return;  // the sheet was closed: the result waits in the list
                  let k;
                  try { k = await panel({ op: "agent_keys" }); } catch (x) { continue; }  // the line blinked: ask again
                  if (k.t === "done" && k.tested && k.tested.ts > was && !k.tested.running) {
                    fill(k.keys, k.tested);
                    if (k.tested.text) toast(k.tested.text, 9000);
                    return;
                  }
                }
                toast("⏳ Проверка идёт дольше обычного — откройте «🔑 Ключи» позже: итог будет там.", 7000);
                freeBtn(b);
              } catch (x) { toast(problem(x)); freeBtn(b); }
            } }));
        };
        const failed = (why) => {  // the list's service away: video and trends still have their own sheets
          list.innerHTML = "";
          list.append(el("p", { class: "status", style: "padding:8px 2px", text: "⚠️ " + why + " Список ключей ведёт служба «🛠 Claude»." }),
            el("div", { class: "ow-list" }, line("🎬", "Видео из фото (Hugging Face)", "токен и HD-сервис", null, () => openHf({ id: "hf", name: "Hugging Face" }, () => {})),
              line("🔥", "Тренды и Coverr", "ключ Coverr — в «Тренды»", null, () => panel({ op: "trends_get" }).then((v) => v.t === "done" && trendsSheet(v, () => {})).catch(() => {}))));
        };
        panel({ op: "agent_keys" }).then((r) => (r.t === "done" ? fill(r.keys, r.tested || null) : failed(r.text || "Список ключей не открылся.")))
          .catch((e) => failed(problem(e)));
      });
    }
    // «📦 Ссылки на 24 часа» lie on the owner's Yandex Disk (they open anywhere in Russia, with VPN and without)
    function diskKeyRow() {
      let cur = line("📦", "Яндекс Диск для ссылок", "проверяю…", null, null, "off");
      const fill = (d) => {
        const r = line("📦", "Яндекс Диск для ссылок", d.on ? "ссылки на 24 часа кладутся на ваш Диск" + (d.login ? " · " + d.login : "")
          : "не подключён: ссылки на приложения и VPN не делаются", value(d.on ? "✓" : "➖", d.on ? "ok" : ""), () => diskSetup(d, fill), d.on ? "ok" : "off");
        r.classList.add("disk-row");
        if (cur.isConnected) cur.replaceWith(r);
        cur = r;
      };
      diskRows.add((d) => (cur.isConnected ? fill(d) : null));
      panel({ op: "disk_get" }).then((d) => (d.t === "done" ? fill(d) : cur.remove())).catch(() => cur.remove());
      return cur;
    }
    function searchKeyRow() {
      let cur = line("🌐", "Поиск в интернете", "проверяю…", null, null, "off");
      const fill = (v) => {
        const w = searchWords(v);
        const r = line("🌐", "Поиск в интернете", [w.checked, w.bad ? "bad" : ""], value(w.bad ? "⚠️" : "✓", w.bad ? "bad" : "ok"), () => searchSheet(v, fill), w.bad ? "bad" : "ok");
        r.classList.add("search-row");
        if (cur.isConnected) cur.replaceWith(r);
        cur = r;
      };
      panel({ op: "search_get" }).then((v) => (v.t === "done" && v.on ? fill(v) : cur.remove())).catch(() => cur.remove());
      return cur;
    }
    async function keySave(k, key) {  // checked where it is used and kept; "" takes it away. The list as it is after
      const op = APP_KEY_OP[k.id];
      if (op && (key || !k.fixed)) {  // the helper's own card checks and keeps it
        const end = await panel(key ? { op: op[0], [op[2]]: key } : { op: op[1] });
        if (end.t !== "done") return end;
        if (!k.fixed) {  // (the list's service away: the key is kept all the same, the list shows it as it now is)
          const r = await panel({ op: "agent_keys" }).catch(() => null);
          return r && r.t === "done" ? r : { t: "done", keys: (keysNow || [k]).map((x) => (x.id === k.id ? Object.assign({}, x, { on: !!key }) : x)) };
        }
      }
      return panel({ op: "agent_setkey", id: k.id, key });  // (a key given to the installer: its copy in the settings follows)
    }
    function keyOne(k, fill) {
      sheet("🔑 " + k.name, (box, close) => {
        const inp = el("input", { class: "input", placeholder: k.two ? "токен Workers AI" : "вставьте ключ", autocomplete: "off", spellcheck: "false" });
        const acct = k.two ? el("input", { class: "input", style: "margin-bottom:8px", placeholder: "ID аккаунта (32 знака)", autocomplete: "off", spellcheck: "false" }) : null;
        box.append(
          el("div", { style: "font-size:15px;margin:-6px 0 8px", text: k.on ? "✅ Подключён" + (k.fixed ? " (задан при установке сервера)" : "")
            + (k.own ? " · у чата с Claude свой ключ" : "") : "➖ Не подключён" }),
          el("div", { style: "font-size:14px;color:var(--muted);margin:0 0 6px", text: "Для чего: " + k.use }),
          el("div", { style: "font-size:14px;color:var(--muted);margin:0 0 10px", text: "Где взять: " + k.get }),
          KEY_SITE[k.id] ? el("a", { class: "btn line wide", href: KEY_SITE[k.id], target: "_blank", rel: "noopener",
            style: "display:block;text-align:center;text-decoration:none;margin-bottom:10px", text: "🌐 Открыть сайт" }) : "",
          acct || "", inp,
          el("button", { class: "btn soft wide", style: "margin-top:8px", text: "📋 Вставить из буфера", onclick: async () => {
            let t = "";
            try { t = Native && Native.clipboard ? Native.clipboard() : await navigator.clipboard.readText(); } catch (e) { /* no access */ }
            if (t) inp.value = t.trim(); else toast("В буфере ничего нет — вставьте вручную");
          } }),
          el("button", { class: "btn wide", style: "margin-top:8px", text: "✅ " + (k.on ? "Заменить ключ" : "Подключить"), onclick: async (e) => {
            const b = e.currentTarget;
            const key = (acct ? acct.value.trim() + ":" : "") + inp.value.trim();
            if (!inp.value.trim() || (acct && !acct.value.trim())) { toast(acct ? "Вставьте и ID аккаунта, и токен" : "Сначала вставьте ключ"); return; }
            busyBtn(b, "⏳ Проверяю ключ…");
            try {
              const end = await keySave(k, key);
              if (end.t !== "done") { toast("⚠️ " + end.text, 7000); freeBtn(b); return; }
              close(); fill(end.keys);
              toast(`✅ ${k.name}: ключ подключён` + (k.app || ["nvidia", "anthropic"].includes(k.id) ? "" : " — помощник перезапустится и возьмёт его примерно через полминуты"), 6000);
            } catch (x) { toast(problem(x)); freeBtn(b); }
          } }),
          k.on ? el("button", { class: "btn line wide", style: "margin-top:8px", text: "Убрать ключ", onclick: async (e) => {
            const b = e.currentTarget;
            if (!(await confirmBox(`Убрать ключ ${k.name}? Для чего он был: ${k.use}.`, "Убрать"))) return;
            busyBtn(b, "⏳ Убираю…");
            try {
              const end = await keySave(k, "");
              if (end.t !== "done") { toast("⚠️ " + end.text, 7000); freeBtn(b); return; }
              close(); fill(end.keys); toast(`Ключ ${k.name} убран`);
            } catch (x) { toast(problem(x)); freeBtn(b); }
          } }) : "");
      });
    }

    // «🔥 Тренды»: the Instagram trends the family's «Я в ролике» and «Я на фото» put first; the server finds them once a day
    // (v36) its definition was lost in an earlier rework: the row failed with no error to see and vanished
    const coverrBad = (c) => !!(c && c.on && c.last && /ключ/.test(c.last.error || ""));  // the key refused: a new one is needed
    function trendsRow() {
      let cur = line("🔥", "Тренды для «Я в ролике»", "проверяю…", null, null, "off");
      const fill = (v) => {
        const top = v.top || [], c = v.coverr || {};
        const sub = v.error ? ["последняя проверка: " + v.error, "bad clamp"]
          : (top.length ? top.map((t) => t.title).join(", ") : "подтверждённых трендов пока нет") + (v.at ? " · " + ago(v.at) + " назад" : "")
            + (coverrBad(c) ? " · ⚠️ Coverr: нужен новый ключ" : "");
        const r = line("🔥", "Тренды для «Я в ролике»", Array.isArray(sub) ? sub : [sub, "clamp"], top.length ? value(String(top.length)) : null,
          () => trendsSheet(v, fill), v.error || coverrBad(c) ? "bad" : top.length ? "ok" : "off");
        r.classList.add("trends-row");
        if (cur.isConnected) cur.replaceWith(r);
        cur = r;
      };
      panel({ op: "trends_get" }).then((v) => (v.t === "done" ? fill(v) : cur.remove())).catch(() => cur.remove());
      return cur;
    }
    function trendsSheet(v, fill) {
      sheet("🔥 Тренды Instagram", (box, close) => {
        const top = v.top || [];
        box.append(el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 10px", text: "Сервер раз в день ищет, какие ролики сейчас "
          + "в топе Instagram. Тренд попадает сюда, только если на странице прямо написано, что он в тренде; 3 дня без подтверждения — уходит. "
          + (v.video || v.photo ? `Ролики под эти тренды стоят первыми в галерее «Я в ролике» (сейчас ${v.video})` + (v.photo ? ` и «Я на фото» (${v.photo}).` : ".") : "") }));
        if (v.error) box.append(el("div", { class: "card", style: "margin:0 0 8px;color:var(--danger-ink)", text: "⚠️ Последняя проверка не удалась: "
          + v.error + (top.length ? ". Ниже — тренды прошлой проверки." : ".") }));
        for (const t of top) {
          const src = el("div", { style: "font-size:13px;color:var(--muted);margin-top:4px" });
          const s = (t.sources || [])[0];
          if (s) {
            src.append(el("div", { style: "margin-top:4px" }, el("a", { href: s.url, target: "_blank", rel: "noopener", text: s.site,
              style: "display:inline-block;padding:6px 0" }), " — «" + s.quote + "»"));
            if (t.sources.length > 1) src.append(el("div", { text: "и ещё " + (t.sources.length - 1) + (t.sources.length - 1 === 1 ? " сайт" : " сайта") }));
          }
          box.append(el("div", { class: "card", style: "margin:0 0 8px" },
            el("b", { text: t.title + (t.people === 2 ? " · вдвоём" : t.people > 2 ? " · втроём" : "") }),
            t.why ? el("div", { style: "font-size:14px;margin-top:2px", text: t.why }) : "",
            el("div", { style: "font-size:12px;color:var(--muted);margin-top:2px", text: `В топе с ${dayRu(t.first)} · подтверждён ${daysRu(t.days)}` }), src));
        }
        if (!top.length && !v.error) box.append(el("p", { class: "muted", text: "Пока нет подтверждённых трендов." }));
        box.append(el("button", { class: "btn line wide", style: "margin-top:6px", text: "🔄 Пересмотреть сейчас", onclick: async (e) => {
          const b = e.currentTarget;
          busyBtn(b, "Ищу… до 3 минут");
          try {
            const end = await panel({ op: "trends_now" });
            if (end.t !== "done") { toast("⚠️ " + end.text, 6000); freeBtn(b); return; }
            close(); fill(end);
            toast(end.error ? "⚠️ Не удалось пересмотреть: " + end.error + ". Показаны тренды прошлой проверки." : "🔥 Тренды пересмотрены", 6000);
          } catch (x) { toast(problem(x)); freeBtn(b); }
        } }));
        // Coverr: new vertical clips for each trend through its free API (the owner's key)
        const c = v.coverr || {};
        box.append(el("h3", { style: "margin:18px 0 4px", text: "🎬 Новые ролики под тренды — Coverr" + (c.on && !coverrBad(c) ? " ✓" : "") }),
          coverrBad(c) ? el("div", { style: "font-size:14px;margin:0 0 8px;color:var(--danger-ink)", text: "⚠️ " + c.last.error + ". Вставьте новый ключ и нажмите «✅ Заменить ключ»." }) : "",
          el("div", { style: "font-size:14px;color:var(--muted);margin:0 0 8px", text: c.on
            ? "Каждый день сервер берёт с Coverr до 3 новых вертикальных роликов на каждый тренд; лица проверяются, как у всех шаблонов."
              + (!coverrBad(c) && c.last && c.last.error ? ` Последний раз ${c.last.error} — завтра снова.` : "")
              + (!coverrBad(c) && c.last && c.last.kept != null ? ` Сейчас роликов: ${c.last.kept}.` : "")
            : "С бесплатным ключом Coverr сервер сам будет брать новые вертикальные ролики под каждый тренд." }));
        if (!c.env) {
          const inp = el("input", { class: "input", placeholder: "ключ API Coverr", autocomplete: "off", spellcheck: "false" });
          box.append(
            c.on && !coverrBad(c) ? "" : el("ol", { style: "margin:0 0 12px;padding-left:20px;font-size:15px;line-height:1.5" },
              el("li", { text: "Нажмите «🔑 Кабинет Coverr» ниже — в браузере откроется сайт Coverr (coverr.co), раздел для разработчиков. Войдите (почта или Google)." }),
              el("li", { text: "На сайте Coverr создайте приложение (App) — ключ API выдаётся бесплатно (статус Demo). Скопируйте ключ и вернитесь в это приложение." }),
              el("li", { text: "Скопируйте ключ, вставьте сюда и нажмите «✅ " + (c.on ? "Заменить ключ" : "Подключить") + "». В чаты ключ не присылайте." })),
            c.on && !coverrBad(c) ? "" : el("a", { class: "btn line wide", href: "https://coverr.co/developers", target: "_blank", rel: "noopener",
              style: "display:block;text-align:center;text-decoration:none;margin-bottom:10px", text: "🔑 Кабинет Coverr" }),
            inp,
            el("button", { class: "btn soft wide", style: "margin-top:8px", text: "📋 Вставить из буфера", onclick: async () => {
              let t = "";
              try { t = Native && Native.clipboard ? Native.clipboard() : await navigator.clipboard.readText(); } catch (e) { /* no access */ }
              if (t) inp.value = t.trim(); else toast("В буфере ничего нет — вставьте вручную");
            } }),
            el("button", { class: "btn wide", style: "margin-top:8px", text: "✅ " + (c.on ? "Заменить ключ" : "Подключить"), onclick: async (e) => {
              const b = e.currentTarget;
              if (!inp.value.trim()) { toast("Сначала вставьте ключ"); return; }
              busyBtn(b, "⏳ Проверяю ключ…");
              try {
                const end = await panel({ op: "coverr_set", key: inp.value.trim() });
                if (end.t !== "done") { toast("⚠️ " + end.text, 6000); freeBtn(b); return; }
                close(); fill(end); toast("✅ Coverr подключён — новые ролики появятся в галерее к утру", 5000);
              } catch (x) { toast(problem(x)); freeBtn(b); }
            } }),
            c.on ? el("button", { class: "btn line wide", style: "margin-top:14px;color:var(--danger-ink)", text: "Отключить Coverr", onclick: async () => {
              if (!(await confirmBox("Отключить Coverr? Его ролики уйдут из галереи, ключ удалится с сервера.", "Отключить"))) return;
              try { const end = await panel({ op: "coverr_off" }); close(); fill(end); toast("Coverr отключён"); } catch (e) { toast(problem(e)); }
            } }) : "");
        }
      });
    }
    function person(id) {
      const d = cache.app;
      const u = d && d.users.find((x) => x.id === id);
      if (!u) return;
      const mine = u.id === d.me;
      const t = u.today || {};
      const lim = () => "";  // no limits in the family app
      sheet((u.off ? "⏸ " : "👤 ") + u.name, (box, close) => {
        const act = (label, fn, cls) => el("button", { class: "btn wide " + (cls || "line"), style: "margin-top:8px", text: label, onclick: async () => { close(); await fn(); } });
        box.append(el("div", { style: "color:var(--muted);font-size:14px;margin:-6px 0 6px",
          text: (u.off ? "Доступ отключён" : !u.seen ? "Ещё не входил(а)" : "Был(а) " + ago(u.seen) + " назад") + ` · телефонов: ${u.devices}` }),
          el("div", { style: "font-size:14px;margin-bottom:6px", text: `Сегодня: вопросов ${t.text || 0}${lim("text")}, картинок ${t.draw || 0}${lim("draw")}, фото ${t.photo || 0}${lim("photo")}` }),
          act(mine ? "🔗 Ссылка: приложение + код для второго телефона (24 ч)" : "🔗 Ссылка: приложение + код входа (24 ч)",
            () => makeLink({ op: "dl_aiapp", id: u.id }, "ИИ-помощник — " + u.name), ""));
        if (!mine) {  // video from a photo: the owner's Hugging Face minutes, only for whom the owner allows
          box.append(el("div", { class: "row", style: "margin-top:10px" },
            // «🎭 Я в ролике» is made on this server (no Hugging Face); «🖼 Оживить фото» needs its minutes too
            el("div", { class: "grow" }, "🎬 Видео", el("small", { text: u.video ? "Включено: во вкладке «🎬 Видео» есть «🎭 Я в ролике»"
              + (video && video.on ? " и «🖼 Оживить фото»." : ".") : "Выключено: ролик сервер делает несколько минут — включайте тем, кому нужно." })),
            el("button", { class: "toggle" + (u.video ? " on" : ""), onclick: () => {
              close(); appOp({ op: "app_set", id: u.id, video: !u.video }, u.video ? "🎬 Видео выключено" : "🎬 Видео включено");
            } })));
        }
        if (mine) {
          box.append(el("div", { style: "font-size:13px;color:var(--muted);margin-top:10px", text: "Это вы. Свой вход здесь не удаляется, чтобы не потерять управление. Новый телефон — ссылка выше; если потеряли все телефоны — на экране входа 5 раз нажмите на звёздочку ✦, появится «✉️ Я владелец — прислать код на почту»." }));
          return;
        }
        box.append(act(u.off ? "▶️ Включить доступ" : "⏸ Отключить доступ", () => appOp({ op: "app_set", id: u.id, off: !u.off }, u.off ? "▶️ Доступ включён" : "⏸ Доступ отключён")),
          act("🚪 Выйти на всех телефонах", async () => {
            if (await confirmBox(`Выйти у «${u.name}» на всех телефонах? Для входа понадобится новый код.`, "Выйти")) appOp({ op: "app_logout", id: u.id }, "🚪 Готово");
          }),
          act("🗑 Удалить из приложения", () => delPerson(u), "line danger"));
      });
    }
    async function add() {
      if (S.busy.vpn) return;
      const name = await ask("Имя для VPN", "Латиницей, например mama или ivan_phone");
      if (!name) return;
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) { toast("Только латиница, цифры, «_» и «-», до 32 знаков", 4000); return; }
      const days = await pickDays("Надолго ли VPN для «" + name + "»?");
      if (days === null) return;
      S.busy.vpn = true;
      toast("⏳ Добавляю «" + name + "»…", 20000);
      try {
        const end = await panel({ op: "add", name, days });
        if (end.t !== "done") toast("⚠️ " + end.text, 5000);
        else { toast("✅ Выдан VPN: " + name); await load(); card(name, end); }
      } catch (e) { toast(problem(e)); }
      S.busy.vpn = false;
    }
    // a guest's VPN goes by itself after these days; 0 — for good
    function pickDays(title, current) {
      return new Promise((resolve) => {
        sheet(title, (box, close) => {
          const list = el("div", { class: "list" });
          for (const [d, label] of [[0, "Бессрочно"], [1, "Гость на 1 день"], [3, "Гость на 3 дня"], [7, "Гость на неделю"], [30, "Гость на месяц"]]) {
            list.append(el("button", { onclick: () => { close(); resolve(d); } }, el("span", { class: "ic", text: d ? "⏰" : "♾️" }),
              el("span", { text: label + (current === d ? " ✓" : "") })));
          }
          box.append(el("div", { style: "color:var(--muted);font-size:14px;margin:-6px 0 10px",
            text: "Гостевой доступ выключится сам — удалять не нужно. Срок можно поменять потом в карточке человека." }), list);
        });
      });
    }
    async function rekey(u) {
      if (!(await confirmBox(`Сменить подключение для «${u.name}»? Старое подключение сразу перестанет работать (например, если телефон потерян или ссылка ушла не тому). Потом отправьте человеку новую ссылку.`, "Сменить ключ"))) return;
      toast("⏳ Меняю ключ…", 20000);
      try {
        const end = await panel({ op: "rekey", name: u.name });
        if (end.t !== "done") { toast("⚠️ " + end.text, 5000); return; }
        toast("✅ Ключ новый. Отправьте человеку новую ссылку — кнопка в карточке.", 6000);
        card(u.name, end);
      } catch (e) { toast(problem(e)); }
    }
    async function guestDays(u) {
      const days = await pickDays("Срок VPN для «" + u.name + "»", u.until ? -1 : 0);
      if (days === null) return;
      try {
        const end = await panel({ op: "guest", name: u.name, days });
        if (end.t !== "done") { toast("⚠️ " + end.text, 5000); return; }
        toast(days ? `✅ ${u.name}: гость до ${when(end.until)}` : `✅ ${u.name}: бессрочно`, 4000);
        await load();
        card(u.name, end);
      } catch (e) { toast(problem(e)); }
    }
    async function card(name, have) {
      let u = have;
      if (!u) {
        try {
          const end = await panel({ op: "user", name });
          if (end.t !== "done") { toast("⚠️ " + end.text); return; }
          u = end;
        } catch (e) { toast(problem(e)); return; }
      }
      sheet("👤 " + u.name + (u.owner ? " 👑" : ""), (box, close) => {
        box.append(el("div", { style: "color:var(--muted);font-size:14px;margin:-6px 0 10px",
          text: (u.online ? `🟢 в сети, подключений: ${u.online}` : "⚪ не в сети") + ` · ↓${bytes(u.tx)} ↑${bytes(u.rx)} с перезапуска VPN`
            + (u.until ? ` · ⏰ гость до ${when(u.until)}, потом выключится сам` : "")
            + (u.laptop ? ` · 💻 ноутбук: ${u.laptop.online ? "в сети" : "не в сети"}, ↓${bytes(u.laptop.tx)} ↑${bytes(u.laptop.rx)}` : "") }));
        const kinds = [["hy2", "Hysteria", "основной, быстрый (UDP)"],
          ["obfs", "Маскировка", "Hysteria с маскировкой salamander: если обычный режут, пакеты выглядят как шум. Winger берёт его сам"],
          ["vless", "VLESS", "запасной, когда режут UDP"],
          ["tg", "Telegram", "Только Telegram, без VPN — для iPhone или компьютера без Winger: Telegram сам ходит через этот прокси (ключ общий для всех)"]].filter((k) => u.links[k[0]]);
        const pane = el("div");
        const chips = el("div", { class: "chips", style: "margin-bottom:10px" });
        if (u.links.hy2) {  // what to give the person: three ways, each a ready message to send
          box.append(el("div", { style: "font-weight:600;margin:2px 2px 8px", text: "Выдать человеку" }),
            giveTile("📲", "Программа + VPN", "Winger с подключением внутри: человек скачает и нажмёт одну кнопку. Ссылка на сутки.",
              () => { close(); makeLink({ op: "dl_vpnlink", name: u.name }, "Winger и VPN — " + u.name); }),
            giveTile("💻", "Ноутбук (Windows)", "Winger для Windows с подключением и мостами внутри — своими, не телефона: они не мешают друг другу. Ссылка на сутки.",
              () => { close(); makeLink({ op: "dl_winapp", name: u.name }, "Winger для Windows — " + u.name); }),
            giveTile("🔗", "Только ссылка VPN", "Если Winger уже стоит: ссылка и QR-код — вставить или отсканировать.", () => { close(); vpnOnly(u); }),
            u.owner ? "" : giveTile("🌉", "Мост", "На дни, когда интернет пускает только разрешённые сайты: выберите, какой.",
              () => { close(); bridgePick(u); }, !u.can_bridge && !(u.bridges || []).length ? "Сначала поднимите свой мост: «🖥 Сервер» → «🌉 Мосты»." : ""));
        }
        const raw = el("details", { style: "margin-bottom:6px" }, el("summary", { style: "cursor:pointer;color:var(--muted);font-size:14px;padding:6px 0",
          text: "Для других программ (iPhone, v2RayTun, Telegram-прокси) ›" }));
        const pick = (k) => {
          chips.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", c.dataset.k === k[0]));
          const link = u.links[k[0]];
          const png = u.qr[k[0]] ? blobOf(u.qr[k[0]], "image/png") : null;
          const file = `vpn-${u.name}-${k[1].toLowerCase()}.png`;
          const text = k[0] === "tg" ? `Telegram без VPN для ${u.name}:\n${link}\n\nНажмите на ссылку — Telegram предложит подключить прокси.`
            : `VPN для ${u.name} (${k[1]}):\n${link}\n\nИмпорт: v2RayTun или v2rayN → «+» → из буфера обмена или по QR-коду.`;
          pane.innerHTML = "";
          pane.append(el("div", { style: "font-size:13px;color:var(--muted);margin-bottom:8px", text: k[1] + " — " + k[2] }),
            png ? el("img", { src: urlOf(png), style: "display:block;width:220px;max-width:70%;margin:0 auto 10px;background:#fff;border-radius:12px;padding:6px",
              onclick: () => viewer(png, file) }) : null,
            el("div", { style: "font:12px ui-monospace,monospace;word-break:break-all;background:var(--card);border-radius:10px;padding:8px;margin-bottom:10px", text: link }),
            el("div", { class: "big-actions" },
              el("button", { class: "btn", text: "📤 Поделиться", onclick: () => (png ? shareBlob(png, file, text) : copyText(text)) }),
              el("button", { class: "btn line", text: "📋 Копировать", onclick: () => copyText(link) })));
        };
        for (const k of kinds) chips.append(el("button", { class: "chip", "data-k": k[0], text: k[1], onclick: () => pick(k) }));
        if (kinds.length > 1) raw.append(chips);
        raw.append(pane);
        box.append(u.links.hy2 ? raw : pane);
        if (!u.links.hy2 && kinds.length > 1) pane.before(chips);
        pick(kinds[0]);
        if (!u.owner) {
          const mine = u.bridges || [], has = mine.length > 0;
          const links = mine.map(wingerLink).filter(Boolean);
          if (has) box.append(el("div", { class: "row", style: "margin-top:12px" },
            el("div", { class: "grow" }, "🌉 Мосты: " + mine.map((b) => (b.ok ? "🟢 " : "🔴 ") + b.label.replace(/^.*· /, "")).join(", "),
              el("small", { text: "Свои звонки для Winger этого человека: Winger берёт их сам и включает рабочий, когда сервер не отвечает." })),
            el("button", { class: "btn line", style: "flex:none;padding:8px 14px", text: "Убрать", onclick: () => { close(); userBridge(u, false); } })));
          if (links.length) {
            // when the person's phone cannot reach the server at all, Winger cannot fetch it: the link goes by messenger
            const msg = `Мосты для Winger (${u.name}):\n${links.join("\n")}\n\nСкопируйте всё сообщение, откройте Winger и нажмите «Вставить ссылку».`;
            box.append(el("button", { class: "btn soft wide", style: "margin-top:8px", text: "📤 Отправить мосты человеку",
              onclick: () => (navigator.share ? navigator.share({ text: msg }).catch(() => copyText(msg)) : copyText(msg)) }));
          }
        }
        box.append(el("div", { class: "big-actions", style: "margin-top:8px" },
          el("button", { class: "btn line", text: "🔄 Сменить подключение", onclick: () => { close(); rekey(u); } }),
          u.owner ? null : el("button", { class: "btn line", text: u.until ? "⏰ Срок" : "⏰ Сделать гостем", onclick: () => { close(); guestDays(u); } })));
        if (!u.owner) {
          box.append(el("button", { class: "btn line wide", style: "margin-top:14px;color:var(--danger-ink)", text: "🗑 Удалить", onclick: () => { close(); delVpn(u.name); } }));
        }
      });
    }
    // ---------- giving a person what they need: each a ready message, a QR, and «📤 Отправить» ----------
    function giveTile(icon, title, about, onclick, off) {
      return el("button", { class: "give-tile", disabled: !!off, onclick,
        style: "display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:var(--card);color:inherit;font:inherit;"
          + "border:1px solid rgba(127,127,127,.22);border-radius:16px;padding:12px 14px;margin:0 0 8px;cursor:pointer" + (off ? ";opacity:.55" : "") },
        el("span", { style: "font-size:28px;line-height:1;flex:none", text: icon }),
        el("span", { style: "flex:1;min-width:0" }, el("b", { style: "display:block;font-size:16px", text: title }),
          el("span", { style: "display:block;font-size:13px;color:var(--muted);margin-top:2px", text: off || about })),
        el("span", { style: "color:var(--muted);font-size:20px;flex:none", text: "›" }));
    }
    function shareSheet(title, msg, link, png, file, note) {
      sheet(title, (box) => {
        box.append(
          note ? el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 10px", text: note }) : "",
          png ? el("img", { src: urlOf(png), alt: "QR", onclick: () => viewer(png, file),
            style: "display:block;width:230px;max-width:72%;margin:0 auto 12px;background:#fff;border-radius:16px;padding:8px" }) : "",
          el("div", { class: "give-msg", text: msg, style: "font:14px/1.5 system-ui,sans-serif;white-space:pre-wrap;word-break:break-word;"
            + "background:var(--card);border-radius:16px 16px 16px 4px;padding:12px 14px;margin-bottom:12px;user-select:all" }),
          el("button", { class: "btn wide", text: "📤 Отправить", onclick: () => (png ? shareBlob(png, file, msg)
            : navigator.share ? navigator.share({ text: msg }).catch(() => {}) : (copyText(msg), toast("✅ Скопировано — отправьте как удобно"))) }),
          el("div", { class: "big-actions", style: "margin-top:8px" },
            el("button", { class: "btn line", text: "📋 Сообщение", onclick: () => { copyText(msg); toast("✅ Сообщение скопировано"); } }),
            el("button", { class: "btn line", text: "📋 Только ссылку", onclick: () => { copyText(link); toast("✅ Ссылка скопирована"); } })));
      });
    }
    function vpnOnly(u) {
      const link = u.links.hy2;
      const png = u.qr && u.qr.hy2 ? blobOf(u.qr.hy2, "image/png") : null;
      const msg = `🔐 VPN для «${u.name}»\n\nЕсли Winger уже стоит:\n1️⃣ Скопируйте ссылку ниже\n2️⃣ Откройте Winger → «📋 Вставить ссылку»`
        + `\n3️⃣ Нажмите большую кнопку — готово ✅\n\nИли в Winger «📷 Сканировать QR» — QR-код на картинке.\n\n${link}`;
      shareSheet("🔗 VPN для «" + u.name + "»", msg, link, png, `vpn-${u.name}.png`, "Нет Winger? Тогда в карточке «📲 Программа + VPN».");
    }
    const BRIDGE_ICON = { tm: "📹", vk: "💬", wb: "🛍", dion: "🟦", bitrix: "🏢" };
    function bridgePick(u) {
      const owned = u.owner_bridges || [], mine = u.bridges || [];
      sheet("🌉 Мост для «" + u.name + "»", (box, close) => {
        box.append(el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 12px",
          text: "Человек получит свою копию моста со своим звонком — ваш мост не мешает. Winger включает мост сам, когда обычный VPN не отвечает." }));
        if (!owned.length) box.append(el("p", { text: "У вас ещё нет мостов: «🖥 Сервер» → «🌉 Мосты» → поднимите хотя бы один." }));
        for (const b of owned) {
          const got = mine.find((x) => x.id.startsWith(b.plat + "-"));
          box.append(giveTile(BRIDGE_ICON[b.plat] || "🌉", b.name + (got ? " · уже выдан ✓" : ""),
            (got ? (got.ok ? "🟢 работает — нажмите, чтобы отправить ещё раз" : "🔴 сейчас не отвечает — отправить можно")
              : b.ok ? "🟢 ваш мост работает" : "🔴 ваш мост сейчас не отвечает — копия может не подняться"),
            () => { close(); giveBridge(u, b, got); }));
          if (b.plat === "tm") box.append(giveTile("📹", "Телемост · 2 трека (проверка)" + (got ? " · мост уже выдан ✓" : ""),
            "Тот же мост по двум трекам — вдвое быстрее, если Телемост пропускает второй. Отдельная ссылка рядом с обычной.",
            () => { close(); giveBridge(u, Object.assign({}, b, { name: "Телемост · 2 трека (проверка)", dual: true }), got); }));
        }
        if (owned.length > 1) box.append(el("button", { class: "btn line wide", style: "margin-top:6px", text: "🌉 Все мосты сразу",
          onclick: () => { close(); userBridge(u, true); } }));
      });
    }
    async function giveBridge(u, b, got) {
      if (!got) {
        toast(`⏳ Поднимаю мост «${b.name}» для «${u.name}»: свой звонок… до 3 минут`, 410000);
        try {
          const end = await panel({ op: "user_bridge", name: u.name, on: true, only: [b.plat] }, (t) => toast("⏳ " + t.replace(/^\S+\s/, ""), 410000));
          document.querySelectorAll(".toast").forEach((t) => t.remove());
          if (end.t !== "done") { toast("⚠️ " + end.text, 9000); return; }
          load();
          got = (end.bridges || []).find((x) => x.id.startsWith(b.plat + "-"));
          if (!got || !got.link) {
            toast((end.dropped || []).length ? `⚠️ «${b.name}» не выдан: второй звонок с вашего входа выбивал ваш мост.` : `⚠️ Мост «${b.name}» не поднялся — попробуйте позже.`, 9000);
            return;
          }
          u = end;
        } catch (e) { toast(problem(e)); return; }
      }
      const link = wingerLink(got, b.dual);
      if (!link) { toast(`⚠️ У моста «${b.name}» для «${u.name}» ещё нет звонка — он поднимается сам, попробуйте через пару минут.`, 7000); return; }
      let png = null;
      try {
        const q = await panel({ op: "qr", text: link });
        if (q.t === "done" && q.png) png = blobOf(q.png, "image/png");
      } catch (e) { /* no picture: the message alone */ }
      const msg = `🌉 Мост «${b.name}» для «${u.name}»\n\nНужен в дни, когда мобильный интернет пускает только разрешённые сайты.\n`
        + `1️⃣ Скопируйте это сообщение целиком\n2️⃣ Откройте Winger → «📋 Вставить ссылку»\nДальше Winger сам включит мост, когда обычный VPN не отвечает.`
        + `\n\n${link}`;
      shareSheet(`🌉 ${b.name} для «${u.name}»`, msg, link, png, `bridge-${b.plat}${b.dual ? "2" : ""}-${u.name}.png`,
        got.ok ? "🟢 Мост работает. Если у человека Winger уже с этим VPN — он возьмёт мост и сам, до 20 минут." : "🔴 Мост сейчас не отвечает — когда поднимется, Winger возьмёт его сам.");
    }
    async function userBridge(u, on) {
      if (!on && !(await confirmBox(`Убрать мосты у «${u.name}»? Их звонки закроются, Winger этого человека останется без мостов.`, "Убрать"))) return;
      try {
        const end = await panel({ op: "user_bridge", name: u.name, on }, (t) => toast(t, 410000));
        document.querySelectorAll(".toast").forEach((t) => t.remove());
        if (end.t !== "done") { toast("⚠️ " + end.text, 9000); return; }
        const drop = (end.dropped || []).length ? ` Без ${end.dropped.join(", ")}: второй звонок с вашего входа выбивал ваш мост.` : "";
        toast(on ? `✅ Мосты для «${u.name}» готовы — Winger этого человека возьмёт их сам (до 20 минут).` + drop : `Мосты у «${u.name}» убраны`, 8000);
        load();
        card(u.name, end);
      } catch (e) { toast(problem(e)); }
    }
    // the tab has no count of its own any more: a count left from an older version goes
    function peek() { badge(0); }
    return { root, peek, keys: allKeys, redraw: () => open && draw(),
      sub: () => ({ server: "хостинг, версия, копии, диск", vpn: "выдача VPN и мосты", app: "люди, модели, проверка", claude: "Claude Code на вашем сервере",
        patrol: "сам проверяет сервер" })[part],
      buttons: () => (open ? [["🔄", "Обновить", load]] : []),
      onShow: () => (open ? load() : enter()) };
  }
  return vpnView;
})
