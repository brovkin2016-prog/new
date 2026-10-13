/* «Управление»: the owner's tab (the server, VPN for the family, the app's people). It is not part of the app the
   family installs: the server hands this file only to the owner's signed-in app (/api/owner_ui), which runs it with
   its own helpers. A family member's phone never gets it. */
(function (A) {
  "use strict";
  const { Native, S, api, ask, blobOf, confirmBox, copyText, el, nativeCall, problem, refreshTop, shareBlob, sheet, store, stream, toast, urlOf, viewer } = A;

  // ---------- the owner's «Управление» tab: the server, VPN access and the app's people ----------
  function bytes(n) {
    n = +n || 0;
    for (const u of ["Б", "КБ", "МБ", "ГБ"]) { if (n < 1024) return (u === "Б" ? n : n.toFixed(1)) + " " + u; n /= 1024; }
    return n.toFixed(1) + " ТБ";
  }
  function ago(ts) {
    const s = Math.max(0, Date.now() / 1000 - ts);
    return s < 3600 ? Math.max(1, Math.round(s / 60)) + " мин" : s < 86400 ? Math.round(s / 3600) + " ч" : Math.round(s / 86400) + " дн.";
  }
  function when(ts) {  // "сегодня 14:05", "вчера 09:12", "3 окт 18:40"
    const d = new Date(ts * 1000), now = new Date();
    const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
    return days === 0 ? "сегодня " + hm : days === 1 ? "вчера " + hm
      : d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", "") + " " + hm;
  }
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
    const cache = { server: null, vpn: null, app: null, claude: null, alerts: null };
    const OPS = { server: "status", vpn: "users", app: "app_list", claude: "agent_state" };
    let data = null;
    const panel = (body, onStatus) => stream("/api/panel", body, (ev) => { if (ev.t === "status" && onStatus) onStatus(ev.text); });
    function enter() {  // only the owner has this tab, on the owner's own phone: it opens at once, no fingerprint
      open = true;
      load();
    }
    async function load() {
      if (!open) return;
      const want = part;
      if (!cache[want]) { draw(); scroll.append(el("div", { class: "status", style: "padding:20px" }, el("span", { class: "spin" }), "Загружаю…")); }
      try {
        const body = want === "claude" ? { op: OPS.claude, chat: claude.chat || undefined } : { op: OPS[want] };
        const [end, ev, ag] = await Promise.all([panel(body), want === "server" ? panel({ op: "alerts", since: 0 }) : null,
          want === "server" ? panel({ op: "agent_state" }).catch(() => null) : null]);
        if (ag) cache.claudeOk = ag.t === "done" && !!ag.installed;
        if (end.t !== "done" && want === "claude") { cache.claude = { t: "done", installed: false, why: end.text }; if (part === want) draw(); return; }
        if (end.t !== "done") throw Object.assign(new Error(end.text || "Не получилось."), { said: true });
        cache[want] = end;
        if (ev && ev.t === "done") cache.alerts = ev.alerts.slice().reverse();
        if (part === want) draw();
      } catch (e) {
        const why = e.said ? "⚠️ " + e.message : problem(e);
        if (!cache[want]) { draw(); scroll.append(el("p", { class: "status", style: "padding:12px", text: why })); } else toast(why);
      }
    }
    function draw() {
      scroll.innerHTML = "";
      if (claude.composer) { claude.composer.remove(); claude.composer = null; }
      const seg = el("div", { class: "seg", style: "margin-bottom:12px" });
      for (const [k, v] of [["server", "🖥 Сервер"], ["vpn", "🛡 VPN"], ["app", "🤖 Помощник"], ["claude", "🛠 Claude"]]) {
        seg.append(el("button", { class: k === part ? "on" : "", style: "padding:8px 4px", text: v, onclick: () => { part = k; store.set("accessPart", k); refreshTop(); draw(); load(); } }));
      }
      scroll.append(seg);
      data = cache[part];
      if (!data) return;
      if (part === "app") return drawApp(data);
      if (part === "server") return drawServer(data);
      if (part === "claude") return drawClaude(data);
      const on = data.users.filter((u) => u.online).length;
      const head = el("div", { class: "card" },
        el("div", { class: "row" }, el("div", { class: "grow" }, (data.vpn ? "🟢 VPN работает" : "🔴 VPN не работает") + " · " + data.host,
          el("small", { text: data.stats ? `Людей: ${data.users.length}, сейчас в сети: ${on}` : `Людей: ${data.users.length}` }))));
      if (data.vless !== null) head.append(el("div", { class: "row" }, el("div", { class: "grow" }, (data.vless ? "🟢" : "🔴") + " Запасной вход в VPN (VLESS)",
        el("small", { text: "Если основной вход блокируют: для iPhone и v2RayTun, ссылка — в карточке человека" }))));
      if (data.tg !== null && data.tg !== undefined) head.append(el("div", { class: "row" }, el("div", { class: "grow" }, (data.tg ? "🟢" : "🔴") + " Telegram без VPN",
        el("small", { text: "Для iPhone и компьютеров: ссылка — в карточке человека (нажмите на него в списке ниже)" }))));
      scroll.append(head, diskRow(), el("button", { class: "btn wide", style: "margin:0 0 8px", text: "➕ Выдать VPN", onclick: add }),
        el("div", { class: "big-actions", style: "margin:0 0 12px" },
          el("button", { class: "btn line", text: "🔗 Только Winger для Android — без подключения", onclick: () => makeLink({ op: "dl_vpnapp" }, "Приложение Winger VPN") }),
          el("button", { class: "btn line", text: "💻 Только Winger для Windows — без подключения", onclick: () => makeLink({ op: "dl_winapp" }, "Winger для Windows") })));
      const list = el("div", { class: "card" }, el("h3", { text: "Кому выдан VPN" }),
        el("small", { style: "display:block;color:var(--muted);margin:-4px 0 6px", text: "Это только VPN. Помощник выдаётся отдельно — в «🤖 Помощник»." }));
      for (const u of data.users) {
        list.append(el("div", { class: "row", style: "cursor:pointer", onclick: () => card(u.name) },
          el("span", { style: "font-size:20px", text: u.online ? "🟢" : "⚪" }),
          el("div", { class: "grow" }, u.name + (u.owner ? " 👑" : ""),
            el("small", { text: (u.online ? `в сети, подключений: ${u.online}` : "не в сети") + (u.tx || u.rx ? ` · ↓${bytes(u.tx)} ↑${bytes(u.rx)} с перезапуска VPN` : "")
              + (u.until ? " · ⏰ гость до " + when(u.until) : "") + (u.bridge ? " · 🌉 мост" : "") })),
          u.owner ? null : el("button", { class: "icon-btn", title: "Удалить", text: "🗑", onclick: (e) => { e.stopPropagation(); delVpn(u.name); } }),
          "›"));
      }
      scroll.append(list, el("div", { style: "font-size:13px;color:var(--muted);padding:0 4px 12px",
        text: "Удалить — 🗑 в строке человека: его VPN сразу перестанет работать. Все добавления и удаления видны в «🖥 Сервер» → «▼ Подробнее» → «🔔 События»." }));
    }
    // a temporary link (24 h) for downloading an app or connecting the VPN: copied and sent however the owner likes
    // ---- links that open everywhere in Russia: a folder on the owner's Yandex Disk, deleted after 24 hours ----
    const diskRows = new Set();  // every «📦 Ссылки» row on screen: all of them change when the Disk is connected
    function diskRow() {
      const row = el("div", { class: "card", style: "margin:0 0 12px" }, el("small", { text: "📦 Ссылки: проверяю…" }));
      const fill = (d) => {
        row.innerHTML = "";
        row.append(el("div", { class: "row" },
          el("div", { class: "grow" }, d.on ? "📦 Ссылки — на Яндекс Диске ✓" : "📦 Для ссылок подключите Яндекс Диск",
            el("small", { text: d.on ? `Открываются в любом браузере в России, сами удаляются через 24 ч. Аккаунт: ${d.login || "—"}`
              : "Ссылки на 24 часа кладутся на ваш Яндекс Диск — так они открываются в любом браузере. Займёт минуту." })),
          el("button", { class: "btn" + (d.on ? " line" : ""), style: "flex:none;padding:8px 14px", text: d.on ? "Настроить" : "Подключить",
            onclick: () => diskSetup(d, fill) })));
      };
      diskRows.add((d) => (row.isConnected ? fill(d) : null));
      panel({ op: "disk_get" }).then((d) => (d.t === "done" ? fill(d) : row.remove())).catch(() => row.remove());
      return row;
    }
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
          d.on ? el("button", { class: "btn line wide", style: "margin-top:14px;color:var(--danger)", text: "Отключить Яндекс Диск", onclick: async () => {
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
    // ---- the server at a glance, its bridges, traffic, events and the big buttons ----
    function stat(title, value, sub, pct, bad) {
      return el("div", { class: "stat" + (bad ? " bad" : "") }, el("small", { text: title }), el("b", { text: value }),
        pct !== undefined ? el("div", { class: "bar" }, el("i", { style: `width:${Math.max(2, Math.min(100, pct))}%` + (pct > 85 ? ";background:var(--danger)" : "") })) : null,
        sub ? el("small", { text: sub }) : null);
    }
    function dur(sec) {
      if (!sec && sec !== 0) return "";
      sec = Math.max(0, sec);
      return sec < 3600 ? Math.round(sec / 60) + " мин" : sec < 86400 ? Math.floor(sec / 3600) + " ч " + Math.round(sec % 3600 / 60) + " мин"
        : Math.floor(sec / 86400) + " д " + Math.round(sec % 86400 / 3600) + " ч";
    }
    const UNIT = { failed: "остановился", inactive: "выключен", activating: "запускается", deactivating: "останавливается" };
    // ---- new versions of the server: built elsewhere, encrypted for this server, installed by one tap ----
    // part: "top" — the version and its buttons (on top when it needs the owner), "extras" — the night switch and the key
    // (under «Подробнее»), "all" — both (under «Подробнее» when nothing waits)
    function updateCard(u, part) {
      if (part === "extras") return updateExtras(u, el("div", { class: "card" }, el("h3", { text: "🌙 Автообновление сервера" })));
      const card = el("div", { class: "card" + (u.new ? " bad" : "") }, el("h3", { text: "⬆️ Версия сервера" }));
      const p = u.progress || {};
      const running = p.state === "running" && Date.now() / 1000 - (p.at || 0) < 3600;
      const line = (text, sub) => card.append(el("div", { class: "row" }, el("div", { class: "grow" }, text, sub ? el("small", { text: sub }) : "")));
      if (!u.ready) {
        line("Обновления из приложения ещё не включены", "Нужна одна установка вручную — дальше обновления здесь.");
        return card;
      }
      if (running) {
        line(`⏳ Обновляется до v${p.version}…`, "5–10 минут. VPN может переподключиться, приложение — ненадолго потерять связь. Экран обновится сам.");
        // looks again every 20 s while the card is on screen; while the server restarts the app has no answer: try later
        const tick = () => {
          if (!card.isConnected) return;
          if (S.tab !== "vpn" || document.hidden) { setTimeout(tick, 20000); return; }
          panel({ op: "status" }).then((end) => (end.t === "done" ? load() : setTimeout(tick, 20000))).catch(() => setTimeout(tick, 20000));
        };
        setTimeout(tick, 20000);
      }
      else if (u.new) line(`Доступна v${u.latest} · у вас v${u.current}`, u.notes || "");
      else line(`v${u.current} — последняя ✓`, u.checked ? "Проверено " + new Date(u.checked * 1000).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : "");
      if (!running && p.state === "finished" && p.version && !p.ok) line(`⚠️ Обновление до v${p.version} не прошло`, "Сервер работает на прежней версии. Подробности — в событиях.");
      if (u.foreign) line("Новая версия собрана не для этого сервера", "Пришлите ключ обновлений тому, кто её собирает (кнопка ниже).");
      const row = el("div", { class: "big-actions", style: "margin-top:8px" });
      if (u.new && !running) {
        row.append(el("button", { class: "btn", text: "⬆️ Обновить", onclick: async () => {
          if (!(await confirmBox(`Обновить сервер до v${u.latest}? Займёт 5–10 минут, VPN может переподключиться. Если что-то пойдёт не так, останется прежняя версия.`, "Обновить"))) return;
          try {
            const end = await panel({ op: "server_update" });
            if (end.t !== "done") { toast("⚠️ " + end.text, 6000); return; }
            toast("⏳ Обновление началось. Когда закончится — придёт уведомление.", 6000);
            setTimeout(load, 4000);
          } catch (e) { toast(problem(e)); }
        } }));
      }
      if (!running) {
        row.append(el("button", { class: "btn line", text: "🔎 Есть ли новее?", onclick: async () => {
          try {
            const end = await panel({ op: "server_check" }, (t) => toast(t, 30000));
            document.querySelectorAll(".toast").forEach((t) => t.remove());
            if (end.t !== "done") { toast("⚠️ " + end.text, 5000); return; }
            const v = end.update || {};
            toast(v.new ? `⬆️ Доступна v${v.latest}` : v.foreign ? "Новая версия собрана не для этого сервера" : `v${v.current} — последняя`, 4000);
            load();
          } catch (e) { toast(problem(e)); }
        } }));
      }
      card.append(row);
      return part === "all" ? updateExtras(u, card) : u.foreign ? updateExtras(u, card, true) : card;
    }
    function updateExtras(u, card, keyOnly) {
      // new versions go in by themselves at night (checked after, the old one back if anything is wrong)
      if (!keyOnly) card.append(el("div", { class: "row", style: "margin-top:6px" },
        el("div", { class: "grow" }, "🌙 Ставить новые версии сами ночью",
          el("small", { text: u.auto ? "Около 4 ч утра. После установки — проверка; если что-то не так, вернётся прежняя версия."
            : "Выключено: новые версии — только кнопкой «⬆️ Обновить»." })),
        el("button", { class: "btn" + (u.auto ? " line" : ""), style: "flex:none;padding:8px 14px", text: u.auto ? "Выключить" : "Включить",
          onclick: async () => {
            const end = await panel({ op: "server_auto", on: !u.auto }).catch(() => null);
            if (end && end.t === "done") { toast(end.update && end.update.auto ? "🌙 Новые версии будут ставиться сами ночью" : "Новые версии — только кнопкой"); load(); }
            else toast("⚠️ " + ((end && end.text) || "не получилось"), 5000);
          } })));
      if (u.key) {
        card.append(el("button", { class: "btn soft wide", style: "margin-top:8px", text: "🔑 Ключ обновлений", onclick: () => sheet("🔑 Ключ обновлений", (box) => {
          box.append(el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 10px", text: "Открытый ключ этого сервера: им шифруются новые версии, "
            + "чтобы поставить их мог только он. Ключ не секретный — один раз пришлите его тому, кто собирает обновления." }),
          el("div", { style: "font:11px/1.35 ui-monospace,monospace;word-break:break-all;white-space:pre-wrap;background:var(--card);border-radius:12px;padding:10px;margin-bottom:12px", text: u.key }),
          el("button", { class: "btn wide", text: "📋 Скопировать ключ", onclick: () => { copyText(u.key); toast("✅ Ключ скопирован — отправьте его"); } }));
        }) }));
      }
      return card;
    }
    // ---------- «🛠 Claude»: the owner's chat with Claude Code on this server ----------
    // A message: Claude looks (files, services, journals) and answers; a change it only plans. «✅ Выполнить» carries the
    // plan out after the server copies its files; the server checks itself after it and puts the copy back if it broke.
    const claude = { chat: store.get("claudeChat", ""), box: null, head: null, composer: null, draft: "" };
    const STEP_ICON = { Bash: "▶️", Read: "📄", Edit: "✏️", Write: "📝", Glob: "🔎", Grep: "🔎" };
    const html = (t) => (A.md ? A.md(t) : String(t || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/\n/g, "<br>"));
    const stepLine = (icon, what) => el("div", { style: "font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:2px 0;color:var(--muted)",
      text: icon + " " + what });
    function claudeMsg(m, asked) {
      const wrap = el("div", { class: "msg " + (m.role === "me" ? "me" : "ai") });
      const b = el("div", { class: "bubble" + (m.err ? " err" : "") });
      if (m.role === "me") b.textContent = m.text; else b.innerHTML = html(m.text);
      wrap.append(b);
      if (m.steps && m.steps.length) {
        const det = el("details", { style: "font-size:13px;color:var(--muted);margin:2px 4px 0" }, el("summary", { text: `🔧 Что Claude делал: ${m.steps.length}` }));
        for (const x of m.steps.slice(0, 60)) det.append(stepLine(STEP_ICON[x.tool] || "🔧", x.what));
        wrap.append(det);
      }
      if (m.files && m.files.length) {
        const det = el("details", { style: "font-size:13px;color:var(--muted);margin:2px 4px 0" }, el("summary", { text: `📝 Изменено файлов: ${m.files.length}` }));
        for (const f of m.files) det.append(stepLine("·", f));
        wrap.append(det);
      }
      if (m.note) wrap.append(el("div", { style: "font-size:13px;margin:4px 4px 0;color:" + (m.note.startsWith("↩️") ? "#b45309" : "var(--muted)"), text: m.note }));
      if (m.role !== "me" && m.text) {
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
      let raw = "";
      const down = () => { scroll.scrollTop = scroll.scrollHeight; };
      return {
        el: wrap,
        status: (t) => { st.lastChild.textContent = t; },
        on: (ev) => {
          if (ev.t === "chat") { claude.chat = ev.chat; store.set("claudeChat", ev.chat); }
          else if (ev.t === "status") st.lastChild.textContent = ev.text;
          else if (ev.t === "tool") { steps.append(stepLine(ev.icon || "🔧", ev.what)); st.lastChild.textContent = "Работаю…"; }
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
        + "после — проверит себя и при поломке вернёт как было." }),
        el("div", { class: "hints", style: "margin-top:8px" }, ...hints.map((t) => el("button", { class: "hint", text: t, onclick: () => send(t) }))));
    }
    function drawClaude(d) {
      if (!d.installed) {
        scroll.append(el("div", { class: "card" }, el("h3", { text: "🛠 Claude на сервере" }),
          el("p", { text: d.why || "Claude Code ещё не установлен." }),
          el("small", { style: "color:var(--muted)", text: "Он ставится вместе с новой версией сервера: «🖥 Сервер» → «⬆️ Версия сервера» → «⬆️ Обновить»." })));
        return;
      }
      claude.chat = d.chat;
      store.set("claudeChat", d.chat);
      claude.head = el("b", { text: d.title });
      scroll.append(el("div", { class: "card", style: "padding:8px 12px" },
        el("div", { class: "row", style: "min-height:40px;cursor:pointer", onclick: () => chatsSheet(d) },
          el("div", { class: "grow" }, claude.head, el("small", { text: d.chats.length > 1 ? `Разговоров: ${d.chats.length} · выбрать ›` : "Один разговор — одна тема" })),
          el("button", { class: "btn soft", text: "➕ Новый", onclick: (e) => { e.stopPropagation(); newChat(); } }))));
      const box = claude.box = el("div", { class: "msgs", style: "padding:4px 2px 12px" });
      if (!d.history.length) box.append(claudeIntro());
      let asked = "";
      for (const m of d.history) { box.append(claudeMsg(m, asked)); if (m.role === "me") asked = m.text; }
      scroll.append(box);
      const acts = el("div", { class: "big-actions", style: "margin:0 0 10px" });
      if (d.busy) {
        if (d.busy_chat === d.chat) follow(d.events);
        else acts.append(el("div", { class: "status", text: "⏳ Claude сейчас работает в другом разговоре" }));
      } else {
        if (d.can_run) acts.append(el("button", { class: "btn", text: "✅ Выполнить", onclick: runPlan }));
        if (d.can_undo) acts.append(el("button", { class: "btn line", text: "↩️ Вернуть как было", onclick: () => undo(d) }));
      }
      if (acts.childNodes.length) scroll.append(acts);
      scroll.append(el("div", { style: "font-size:12px;color:var(--muted);margin:0 4px 12px" },
        "Модели: " + (d.engines.length ? d.engines.join(" → ") : "нет ключей") + " · ",
        el("a", { href: "#", text: "🔑 Запасной ключ OpenRouter", onclick: (e) => { e.preventDefault(); keySheet(d); } })));
      const ta = el("textarea", { rows: 1, placeholder: d.busy ? "Claude работает… можно написать следующее" : "Что проверить или сделать?" });
      ta.value = claude.draft;
      ta.addEventListener("input", () => { claude.draft = ta.value; ta.style.height = "auto"; ta.style.height = Math.min(140, ta.scrollHeight) + "px"; });
      const go = el("button", { class: "round main", text: d.busy ? "⏹" : "➤", title: d.busy ? "Стоп" : "Отправить", onclick: () => {
        if (d.busy) return stopClaude();
        const t = ta.value.trim();
        if (t) { claude.draft = ""; ta.value = ""; send(t); }
      } });
      claude.composer = el("div", { class: "composer" }, el("div", { class: "inrow" }, ta, go));
      root.append(claude.composer);
      requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
    }
    async function talk(body, me) {  // a request to Claude with its steps shown as they come; the chat redrawn after it
      if (!claude.box) return;
      if (me) {
        if (body.chat === "new") { claude.box.innerHTML = ""; if (claude.head) claude.head.textContent = me.slice(0, 40); }
        claude.box.querySelectorAll(".msg.note").forEach((n) => n.remove());
        claude.box.append(claudeMsg({ role: "me", text: me }));
      }
      const live = liveBubble();
      claude.box.append(live.el);
      scroll.scrollTop = scroll.scrollHeight;
      try {
        const end = await stream("/api/panel", body, live.on);
        if (end.t === "error") toast("⚠️ " + end.text, 6000);
      } catch (e) {
        live.status("Связь прервалась — Claude работает дальше, жду…");
        await waitFree();
      }
      reloadClaude();
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
    function send(text) { talk({ op: "agent_ask", chat: claude.chat, text }, text); }
    async function runPlan() {
      if (!(await confirmBox("Claude поменяет сервер по плану выше. Сначала сервер сделает снимок файлов, а после проверит себя: если что-то сломается — сам вернёт как было.", "✅ Выполнить"))) return;
      talk({ op: "agent_run", chat: claude.chat }, "✅ Выполнить");
    }
    async function undo(d) {
      if (!(await confirmBox(`Вернуть файлы сервера, как они были до последнего «Выполнить» (${when(d.undo_ts)})?`, "↩️ Вернуть как было"))) return;
      talk({ op: "agent_undo", chat: claude.chat }, "↩️ Вернуть как было");
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
      });
    }
    function keySheet(d) {
      sheet("🔑 Ключ OpenRouter", (box, close) => {
        const inp = el("input", { class: "input", type: "password", placeholder: "sk-or-v1-…", autocomplete: "off" });
        box.append(el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 10px", text: (d.own_key ? "Сейчас стоит ваш ключ. " : "Сейчас — ключ сервера. ")
          + "Свой ключ (openrouter.ai → Keys) хранится только на сервере и идёт запасным после GLM. В чат его не присылайте." }),
          inp, el("div", { style: "height:10px" }),
          el("button", { class: "btn wide", text: "Сохранить", onclick: async () => {
            const key = inp.value.trim();
            if (!key) return;
            try { const r = await panel({ op: "agent_key", key }); if (r.t !== "done") return toast("⚠️ " + r.text, 6000); close(); toast("✅ Ключ сохранён"); reloadClaude(); } catch (e) { toast(problem(e)); }
          } }));
        if (d.own_key) box.append(el("button", { class: "btn line wide", style: "margin-top:8px", text: "Убрать свой ключ", onclick: async () => {
          try { await panel({ op: "agent_key", key: "" }); close(); toast("Свой ключ убран"); reloadClaude(); } catch (e) { toast(problem(e)); }
        } }));
      });
    }
    // «🛠 Разобрать с Claude» from the server's cards (only the owner has them): a new talk with the problem in it
    // the journal as Claude gets it: its newest part (where the trouble is) when it is long; the whole one is on the server
    const WLOG_ASK = "Разбери журнал Winger с моего телефона: почему мост или VPN работает плохо, и как исправить? "
      + "Полный журнал — на сервере: /var/lib/aibot/winger-log.json (прочитай его целиком).\n\n";
    const clip = (t) => t.length <= 7900 ? t : t.slice(0, t.indexOf("\n\n") > 0 && t.indexOf("\n\n") < 600 ? t.indexOf("\n\n") + 2 : 300)
      + "…(начало пропущено — новые строки ниже)…\n" + t.slice(-7300);
    async function toClaude(text) {
      part = "claude"; store.set("accessPart", "claude"); refreshTop();
      try {
        const st = await panel({ op: "agent_state" });
        if (st.t !== "done") return toast("⚠️ " + st.text, 6000);
        cache.claude = st; draw();
        if (!st.installed) return;
        if (st.busy) return toast("Claude ещё работает над прошлым — отправьте, когда закончит", 5000);
        talk({ op: "agent_ask", chat: "new", text: clip(text) }, clip(text));
      } catch (e) { toast(problem(e)); }
    }
    const claudeBtn = (text, close) => !cache.claudeOk ? null : el("button", { class: "btn line", text: "🛠 Разобрать с Claude",
      onclick: () => { if (close) close(); toClaude(typeof text === "function" ? text() : text); } });
    function drawServer(d) {
      const bad = [];
      if (!d.vpn.ok) bad.push("VPN не работает");
      if (d.vless && !d.vless.ok) bad.push("запасной VLESS не работает");
      if (d.tgproxy && !d.tgproxy.ok) bad.push("Telegram без VPN не работает");
      const brBad = d.bridges.filter((b) => !b.ok);
      if (brBad.length) bad.push(brBad.length === 1 ? `не работает мост «${brBad[0].label}»` : `не работают мосты: ${brBad.length}`);
      if (d.cert_days !== null && d.cert_days < 10) bad.push(`сертификат кончается через ${d.cert_days} дн.`);
      if (d.disk[1] && d.disk[0] / d.disk[1] > 0.92) bad.push("диск почти заполнен");
      const host = d.hosting;
      if (host && host.set && host.days_left < 5) bad.push(`хостинг: осталось ${Math.floor(host.days_left)} дн., пополните`);
      scroll.append(el("div", { class: "card hero" + (bad.length ? " bad" : "") },
        el("div", { class: "emoji", text: bad.length ? "⚠️" : "✅" }),
        el("div", { class: "grow" }, el("b", { text: bad.length ? "Есть проблемы" : "Всё работает" }),
          el("small", { text: bad.length ? bad.join(" · ") : `${d.host} · ${d.ip}` + (d.online !== null ? ` · в сети: ${d.online}` : "") }))));
      // on top only what needs the owner: money running out, a new version, the bridges, the report for Claude;
      // everything else waits under «Подробнее»
      const u = d.update, p = (u && u.progress) || {};
      const urgentHost = host && host.set && host.days_left < 7;
      const urgentUpdate = u && (!u.ready || u.new || u.foreign || p.state === "running" || (p.state === "finished" && p.version && !p.ok));
      const seen = store.get("alertsSeen", 0), fresh = (cache.alerts || []).some((x) => x.ts > seen && x.kind !== "log");
      if (urgentHost) drawHosting(host);
      if (urgentUpdate) scroll.append(updateCard(u, "top"));
      if (fresh) scroll.append(eventsCard());
      const cl = !!cache.claudeOk;  // Claude on the server: memory, traffic, the week, Winger's journal and checks — ask it
      scroll.append(bridgesCard(d), remoteCard(cl), diagCard(cl));
      const more = store.get("serverMore", false);
      scroll.append(el("button", { class: "btn line wide", style: "margin:0 0 12px",
        text: more ? "▲ Скрыть подробности" : cl ? "▼ Подробнее: события, хостинг, версия, перезагрузка" : "▼ Подробнее: события, память, трафик, хостинг, перезагрузка",
        onclick: () => { store.set("serverMore", !more); draw(); } }));
      if (!more) return;
      const brOk = d.bridges.length - brBad.length;
      scroll.append(el("div", { class: "stats" },
        stat("VPN", d.vpn.ok ? "работает" : "не работает", d.vpn.ok && d.vpn.since ? dur(d.vpn.since) + " без перерыва" : UNIT[d.vpn.state] || d.vpn.state, undefined, !d.vpn.ok),
        stat("Мосты", d.bridges.length ? `${brOk} из ${d.bridges.length}` : "нет", brBad.length ? "есть неработающие" : "", undefined, brBad.length > 0),
        stat("Память", `${Math.round(100 * d.mem[0] / d.mem[1])}%`, `${(d.mem[0] / 1024).toFixed(1)} из ${(d.mem[1] / 1024).toFixed(1)} ГБ`, 100 * d.mem[0] / d.mem[1]),
        stat("Диск", `${Math.round(100 * d.disk[0] / d.disk[1])}%`, `${d.disk[0]} из ${d.disk[1]} ГБ`, 100 * d.disk[0] / d.disk[1]),
        stat("Нагрузка", `${Math.round(100 * d.load[0] / d.cpus)}%`, `ядер: ${d.cpus} · работает ${dur(d.uptime)}`, 100 * d.load[0] / d.cpus),
        stat("Сертификат", d.cert_days !== null ? `ещё ${d.cert_days} дн.` : "?", "продлевается сам", undefined, d.cert_days !== null && d.cert_days < 10)));
      if (host && !urgentHost) drawHosting(host);
      if (u && u.ready) scroll.append(updateCard(u, urgentUpdate ? "extras" : "all"));
      // what takes the memory and the processor: the VPN and the assistant apart
      if (d.services && d.services.length && !cl) {
        const mb = (v) => (v === null || v === undefined ? "—" : v >= 1024 ? (v / 1024).toFixed(1) + " ГБ" : v + " МБ");
        const pc = (v) => (v === null || v === undefined ? "—" : v < 1 ? "<1%" : Math.round(v) + "%");
        const card = el("div", { class: "card" }, el("h3", { text: "📊 Ресурсы" }));
        let counted = 0;
        for (const [k, title] of [["vpn", "🛡 VPN"], ["ai", "🤖 Помощник"]]) {
          const xs = d.services.filter((x) => x.part === k);
          if (!xs.length) continue;
          const mem = xs.reduce((a, x) => a + (x.mem || 0), 0), cpu = xs.reduce((a, x) => a + (x.cpu || 0), 0);
          counted += mem;
          card.append(el("div", { class: "row" }, el("div", { class: "grow" }, el("b", { text: title })),
            el("small", { text: `${mb(mem)} · процессор ${pc(cpu)}` })));
          for (const x of xs) {
            card.append(el("div", { class: "row", style: "min-height:30px;padding-left:14px" }, el("div", { class: "grow", style: "font-size:14px", text: x.name }),
              el("small", { text: `${mb(x.mem)} · ${pc(x.cpu)}` })));
          }
        }
        const other = Math.round(d.mem[0] - counted);
        if (other > 0) card.append(el("div", { class: "row" }, el("div", { class: "grow" }, el("b", { text: "⚙️ Система и прочее" })), el("small", { text: mb(other) })));
        card.append(el("div", { style: "font-size:12px;color:var(--muted);margin-top:6px",
          text: `Процессор — доля одного ядра за последнюю секунду (ядер: ${d.cpus}). Помощнику больше всего памяти нужно, пока он обрабатывает фото и голос.` }));
        scroll.append(card);
      }
      if (!cl) scroll.append(weekCard(), wingerLogCard(), trafficCard());
      else scroll.append(wingerLogCard(true), el("div", { style: "font-size:13px;color:var(--muted);margin:-4px 4px 12px",
        text: "Память и нагрузку, трафик, итоги недели, скорость, проверку моста и почты спросите у Claude — раздел «🛠 Claude»." }));
      if (!fresh) scroll.append(eventsCard());
      scroll.append(actionsCard(d, cl));
    }
    // the bridges: what they are for in one line, each one's state (a tap: its link, a restart), and one way to add more
    const BRIDGES = [
      ["wb", "⚡ WB Stream", "Самый быстрый. Нужен только ваш номер телефона: код придёт по СМС от WB."],
      ["vk", "VK Звонки", "Нужен ваш аккаунт VK: войдёте один раз по номеру телефона."],
      ["dion", "DION", "Нужна бесплатная учётная запись на dion.vc (почта и пароль)."],
      ["bitrix", "Битрикс24", "Нужен свой бесплатный портал на bitrix24.ru (почта не Gmail)."],
    ];
    function bridgesCard(d) {
      const card = el("div", { class: "card" }, el("h3", { text: "🌉 Мосты" }),
        el("small", { style: "color:var(--muted);display:block;margin:-4px 0 6px", text: "Выручают, когда мобильный интернет пускает только отдельные сайты. "
          + "Winger получает мосты сам — в нём ничего настраивать не нужно." }));
      for (const b of d.bridges) {
        card.append(el("div", { class: "row", style: "cursor:pointer", onclick: () => bridgeSheet(b) },
          el("span", { style: "font-size:18px", text: b.ok ? "🟢" : "🔴" }),
          el("div", { class: "grow" }, b.label, el("small", { text: (b.ok ? "работает " + dur(b.since) : UNIT[b.state] || b.state) + (+b.restarts ? ` · перезапусков: ${b.restarts}` : "") })),
          "›"));
      }
      if (!d.bridges.length) card.append(el("div", { class: "row" }, el("div", { class: "grow", text: "Мостов пока нет" })));
      const missing = BRIDGES.filter(([p]) => !d.bridges.some((b) => b.id.startsWith(p + "-")));
      if (missing.length) card.append(el("button", { class: "btn soft wide", style: "margin-top:8px", text: "➕ Добавить мост", onclick: () => addBridge(d, missing) }));
      return card;
    }
    // a bridge of the server as a Winger link, with its service's best settings ("" when its call is not there)
    function wingerLink(b) {
      const link = b.link || "", enc = encodeURIComponent(link);
      const short = b.label.replace(/^\S+\s/, "");  // «Телефон · Телемост»; a person's «Мама · Телемост» — their Winger needs no name
      const name = encodeURIComponent("Мост · " + (b.label.startsWith("👤") ? short.replace(/^[^·]+· /, "") : short));
      const kind = bridgeKind(b);
      return kind === "tm" ? "winger-bridge://telemost?link=" + enc + "&fps=24&batch=45&reliable=1&dual=0#" + name
        : kind === "wb" ? "winger-bridge://wbstream?room=" + enc + "&mode=dc&fps=24&batch=30&reliable=1&dual=0#" + name
        : kind === "dion" ? "winger-bridge://dion?room=" + enc + "#" + name
        : kind === "bitrix" ? "winger-bridge://bitrix?link=" + enc + "&mode=dc&fps=24&batch=30&reliable=1&dual=0#" + name
        : kind === "vk" ? "winger-bridge://vk?link=" + enc + "&mode=dc#" + name : "";
    }
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
    // ---- remote desktop to the owner's Windows laptop: RustDesk through this server, only for the owner ----
    // The laptop is set up once by a command pasted into PowerShell (RustDesk as a service, this server and its key, a
    // long password; it tells the server its ID). Then a tap here opens RustDesk on the phone straight to it (the link
    // carries the server and its key), and another laptop gets a desktop shortcut from a command of its own. A command
    // stops working once it has done its job. The password stays hidden until «Показать».
    let remote = null;  // the last answer: a redraw shows it at once and asks again behind it
    const remoteQr = { cfg: "", png: null };
    const PS_HOW = "Откройте на ноутбуке PowerShell, вставьте команду, нажмите Enter и ответьте «Да» на вопрос Windows.";
    function remoteCard(cl) {
      const card = el("div", { class: "card" });
      let ticking = false;
      // something is on its way: the laptop's ID, the laptop taking a new password, the server's part set up again
      const waiting = (r) => r && (r.retrying || (r.ready && (!r.id || r.old_password)));
      const fill = (r) => {
        card.innerHTML = "";
        card.append(el("h3", { text: "🖥 Удалённый доступ" }));
        if (!r) { card.append(el("div", { class: "status", style: "font-size:14px" }, el("span", { class: "spin" }), "Проверяю…")); return; }
        if (!r.ready) remoteDown(card, r, cl, fill);
        else if (r.id) remoteReady(card, r, fill);
        else remoteFirst(card, r);
        if (!ticking && waiting(r)) { ticking = true; setTimeout(tick, 10000); }
      };
      const get = () => panel({ op: "remote_state" }).then((r) => {
        if (r.t !== "done") throw Object.assign(new Error(r.text || "Не получилось."), { said: true });
        const was = remote;
        remote = r;
        if (card.isConnected) fill(r);
        if (was && was.ready && !was.id && r.id) toast("✅ Ноутбук настроен — можно подключаться", 5000);
        else if (was && was.old_password && r.id && !r.old_password) toast("✅ Ноутбук получил новый пароль", 5000);
        if (was && was.retrying && !r.retrying && r.ready) toast("✅ Удалённый доступ на сервере работает", 5000);
      });
      // while something is on its way, look again every 10 s as long as the card is on screen
      const tick = () => {
        if (!card.isConnected || !waiting(remote)) { ticking = false; return; }
        if (S.tab !== "vpn" || document.hidden) { setTimeout(tick, 10000); return; }
        get().catch(() => {}).finally(() => setTimeout(tick, 10000));
      };
      fill(remote);
      get().catch((e) => {
        if (remote) return;  // the last answer stays on screen
        card.innerHTML = "";
        card.append(el("h3", { text: "🖥 Удалённый доступ" }),
          el("div", { style: "font-size:14px;color:var(--muted)", text: (e.said ? "⚠️ " + e.message : problem(e)) + " Нажмите 🔄 вверху." }));
      });
      return card;
    }
    // the server's part does not work: why, in one line; it tries again by itself every hour, «🔄 Повторить» at once,
    // and Claude on the server can look into it
    function remoteDown(card, r, cl, fill) {
      card.append(el("div", { class: r.retrying ? "status" : "", style: "font-size:14px;color:var(--muted)" },
        r.retrying ? el("span", { class: "spin" }) : "", r.why || "На сервере пока не готово."));
      if (r.retrying) return;
      const row = el("div", { class: "big-actions", style: "margin-top:10px" });
      if (r.retry) row.append(el("button", { class: "btn", text: "🔄 Повторить", onclick: async () => {
        try {
          const n = await panel({ op: "remote_retry" });
          if (n.t !== "done") { toast("⚠️ " + n.text, 6000); return; }
          remote = n;
          fill(n);
        } catch (e) { toast(problem(e)); }
      } }));
      if (cl) row.append(el("button", { class: "btn line", text: "🛠 Спросить Claude", onclick: () =>
        toClaude("Удалённый доступ к ноутбуку на сервере не работает. В приложении написано: «" + r.why + "». Найди причину и почини.") }));
      if (row.childNodes.length) card.append(row);
    }
    // a command for PowerShell: copied, or sent on (to oneself, then opened on the laptop) by the app's own share sheet
    // (the Android WebView has no navigator.share), or the browser's where there is one. It carries what opens the
    // laptop until it has done its job: only to oneself
    const SEND_HOW = "Перешлите команду только себе и откройте на ноутбуке: пока она не сработала, она как пароль.";
    function cmdButtons(cmd, done) {
      const send = Native && Native.shareFile ? () => shareBlob(new Blob([cmd], { type: "text/plain" }), "komanda.txt", cmd)
        : navigator.share ? () => navigator.share({ text: cmd }).catch(() => {}) : null;
      return el("div", { style: "margin-top:10px" },
        el("button", { class: "btn wide", text: "📋 Скопировать команду", onclick: () => { copyText(cmd); toast(done, 5000); } }),
        send ? el("button", { class: "btn line wide", style: "margin-top:8px", text: "📤 Отправить на ноутбук", onclick: send }) : null);
    }
    function remoteFirst(card, r) {
      card.append(el("div", { style: "font-size:14px;color:var(--muted);margin:-4px 0 6px", text: "Экран вашего ноутбука с Windows — на телефоне и на другом ноутбуке. Только для вас." }),
        el("div", { class: "row", style: "align-items:flex-start;padding-top:4px" }, el("span", { style: "font-size:22px;line-height:1.2", text: "1️⃣" }),
          el("div", { class: "grow" }, el("b", { text: "Этот ноутбук" }), el("small", { text: PS_HOW }))),
        cmdButtons(r.host_cmd, "✅ Команда скопирована — перешлите её себе и вставьте в PowerShell на ноутбуке"),
        el("div", { style: "font-size:13px;color:var(--muted);margin-top:8px", text: SEND_HOW + " Действует сутки, а когда ноутбук настроится — перестаёт, и здесь появится «💻 Подключиться»." }));
    }
    // a tap on «Подключиться»: when the app goes to the background at once, RustDesk opened (the phone has it, the hint
    // is not needed any more); still here after 4 s — nothing on this phone could open the link
    function remoteOpened(num, r) {
      let gone = false;
      const away = () => { gone = true; };
      document.addEventListener("visibilitychange", away, { once: true });
      window.addEventListener("blur", away, { once: true });
      setTimeout(() => {
        document.removeEventListener("visibilitychange", away);
        window.removeEventListener("blur", away);
        if (!gone) { toast("Если RustDesk не открылся — установите его: «📱 Телефон» ниже", 6000); return; }
        store.set("remotePhone", true);
        if (num) num.textContent = "Номер ноутбука: " + r.id;
      }, 4000);
    }
    function remoteReady(card, r, fill) {
      const pwRow = (label, value, title) => {
        const dots = "•".repeat(12);
        const pw = el("div", { style: "font:15px/1.4 ui-monospace,monospace;overflow-wrap:anywhere", text: dots });
        const show = el("button", { class: "btn line", style: "flex:none;padding:6px 12px;min-height:38px", text: "Показать", onclick: () => {
          const on = pw.textContent === dots;
          pw.textContent = on ? value : dots;
          show.textContent = on ? "Скрыть" : "Показать";
        } });
        return el("div", { class: "row" }, el("span", { style: "font-size:20px", text: "🔑" }), el("div", { class: "grow", style: "min-width:0" }, el("small", { text: label }), pw), show,
          el("button", { class: "icon-btn", title, text: "📋", onclick: () => { copyText(value); toast("✅ Пароль скопирован"); } }));
      };
      const go = (icon, title, sub, fn) => el("div", { class: "row", style: "cursor:pointer", onclick: fn },
        el("span", { style: "font-size:20px", text: icon }), el("div", { class: "grow" }, title, el("small", { text: sub })), "›");
      // until RustDesk has opened from here once: it must be on this phone for the button to work
      const num = el("div", { style: "font-size:13px;color:var(--muted);text-align:center;margin:6px 0 4px", text: "Номер ноутбука: " + r.id
        + (store.get("remotePhone", false) ? "" : " · на телефоне нужен RustDesk — «📱 Телефон» ниже") });
      card.append(
        el("a", { class: "btn wide", href: r.connect, style: "text-decoration:none;font-size:17px;min-height:54px", text: "💻 Подключиться к ноутбуку",
          onclick: () => remoteOpened(num, r) }),
        num);
      if (r.old_password) {  // a new password the laptop has not taken yet: the old one still opens it
        card.append(el("div", { style: "font-size:14px;margin:6px 0 2px", text: "⏳ Пароль сменён, но ноутбук его ещё не знает: подключитесь со старым и запустите на ноутбуке команду («🛠 Этот ноутбук» ниже)." }),
          pwRow("Старый пароль — работает сейчас", r.old_password, "Скопировать старый пароль"),
          pwRow("Новый — заработает после команды на ноутбуке", r.password, "Скопировать пароль"));
      } else card.append(pwRow("Пароль", r.password, "Скопировать пароль"));
      card.append(
        go("📱", "Телефон", "RustDesk — один раз", () => remotePhone(r, num)),
        go("💻", "Другой ноутбук", "Значок на рабочем столе — без паролей", () => remoteOther(r)),
        go("🛠", "Этот ноутбук", "Команда настройки — ещё раз", () => remoteHost(r)),
        el("div", { style: "font-size:13px;color:var(--muted);margin:8px 0 10px", text: "🎚 Качество или отклик — переключатель в окне подключения (значок экрана)." }),
        el("button", { class: "btn line wide", text: "🔑 Новый пароль", onclick: () => remoteNewPw(fill) }));
    }
    async function remoteQrPng(cfg) {  // the phone's RustDesk scans its server settings as a QR
      if (remoteQr.cfg === cfg && remoteQr.png) return remoteQr.png;
      try {
        const q = await panel({ op: "qr", text: cfg });
        if (q.t !== "done" || !q.png) return null;
        Object.assign(remoteQr, { cfg, png: blobOf(q.png, "image/png") });
        return remoteQr.png;
      } catch (e) { return null; }
    }
    function remotePhone(r, num) {
      sheet("📱 RustDesk на телефоне", (box) => {
        const step = (title, text) => el("div", { style: "margin:14px 0 8px" }, el("b", { text: title }),
          el("div", { style: "font-size:14px;color:var(--muted);margin-top:2px", text }));
        // not needed for «Подключиться» (its link carries the server and its key): only for typing the laptop's number
        // into RustDesk itself; the QR is asked for when this opens
        const qr = el("div", { style: "min-height:60px;display:grid;place-items:center;margin:4px 0 8px" }, el("span", { class: "spin" }));
        const more = el("details", { style: "margin-top:14px;font-size:14px;color:var(--muted)" },
          el("summary", { style: "cursor:pointer;padding:6px 0", text: "Необязательно: наш сервер в самом RustDesk" }),
          el("div", { style: "margin:4px 0 8px", text: "Нужно, только если набирать номер ноутбука в самом RustDesk. В RustDesk: «Настройки» → значок сканера вверху. "
            + "QR на этом же телефоне? Нажмите на него → «⬇️ Сохранить», а в сканере выберите картинку и подтвердите." }),
          qr,
          el("div", { text: "Или вручную: «Настройки» → «ID/Ретранслятор»: сервер — в «Сервер ID», ключ — в «Key»." }),
          el("div", { class: "big-actions", style: "margin-top:8px" },
            el("button", { class: "btn line", text: "📋 Сервер", onclick: () => { copyText(r.host); toast("✅ Сервер скопирован"); } }),
            el("button", { class: "btn line", text: "📋 Ключ", onclick: () => { copyText(r.key); toast("✅ Ключ скопирован"); } })));
        let asked = false;
        more.addEventListener("toggle", () => {
          if (!more.open || asked) return;
          asked = true;
          remoteQrPng(r.android_cfg).then((png) => {
            qr.innerHTML = "";
            qr.append(png ? el("img", { src: urlOf(png), alt: "QR для RustDesk", onclick: () => viewer(png, "rustdesk-server.png"),
              style: "display:block;width:220px;max-width:70%;background:#fff;border-radius:12px;padding:6px" })
              : el("div", { style: "font-size:14px;color:var(--muted)", text: "QR не получился — настройте вручную, ниже." }));
          });
        });
        box.append(el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 0", text: "Один раз — дальше «💻 Подключиться» сразу открывает ноутбук." }),
          step("1️⃣ Установите RustDesk", "Официальное приложение, с GitHub."),
          el("a", { class: "btn line wide", href: (r.android_apk || {}).url || "https://github.com/rustdesk/rustdesk/releases",
            style: "text-decoration:none", text: "⬇️ Скачать RustDesk" }),
          step("2️⃣ Первое подключение", "Нажмите «Подключиться», вставьте пароль и отметьте «Запомнить пароль». Наш сервер RustDesk узнает из ссылки сам."),
          el("button", { class: "btn wide", text: "📋 Скопировать пароль", onclick: () => {
            copyText(r.old_password || r.password); toast("✅ Пароль скопирован — вставьте его в RustDesk", 4000);
          } }),
          el("a", { class: "btn line wide", href: r.connect, style: "text-decoration:none;margin-top:8px", text: "💻 Подключиться к ноутбуку",
            onclick: () => remoteOpened(num, r) }),
          el("div", { style: "font-size:13px;color:var(--muted);margin-top:12px", text: "Интернет режут? Включите Winger — RustDesk пойдёт через него. "
            + "Если в Winger выбраны отдельные приложения, добавьте туда RustDesk." }),
          more);
      });
    }
    function remoteOther(r) {
      sheet("💻 Другой ноутбук", (box) => box.append(
        el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 10px", text: "Ноутбук с Windows, с которого подключаться: на нём появится значок «Ноутбук (удалённо)» — дальше в одно нажатие." }),
        el("ol", { style: "margin:0;padding-left:20px;font-size:15px;line-height:1.5" },
          el("li", { text: "Откройте на нём PowerShell, вставьте команду и нажмите Enter." }),
          el("li", { text: "Откройте значок «Ноутбук (удалённо)» на рабочем столе." }),
          el("li", { text: "В первый раз вставьте пароль (команда уже положила его в буфер) и отметьте «Запомнить пароль»." })),
        cmdButtons(r.client_cmd, "✅ Команда скопирована — перешлите её себе и вставьте в PowerShell на другом ноутбуке"),
        el("div", { style: "font-size:13px;color:var(--muted);margin-top:8px", text: SEND_HOW + " Сработает один раз (действует сутки). Права администратора не нужны." })));
    }
    function remoteHost(r, fresh) {
      sheet(fresh ? "🔑 Пароль новый" : "🛠 Этот ноутбук", (box) => box.append(
        fresh ? el("ol", { style: "margin:-6px 0 10px;padding-left:20px;font-size:15px;line-height:1.5" },
          el("li", { text: "Подключитесь к ноутбуку как обычно — старый пароль пока работает." }),
          el("li", { text: "Запустите на нём команду ниже — после неё работает только новый пароль." }),
          el("li", { text: "На другом ноутбуке запустите его команду ещё раз («💻 Другой ноутбук») — новый пароль окажется в буфере. На телефоне вставьте новый (📋 в карточке)." }))
          : el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 10px", text: "Ещё раз — после «Новый пароль» или если к ноутбуку перестало подключаться." }),
        el("div", { style: "font-size:15px", text: PS_HOW }),
        cmdButtons(r.host_cmd, "✅ Команда скопирована — перешлите её себе и вставьте в PowerShell на ноутбуке"),
        el("div", { style: "font-size:13px;color:var(--muted);margin-top:8px", text: SEND_HOW + " Действует сутки, после настройки ноутбука — перестаёт." })));
    }
    async function remoteNewPw(fill) {
      if (S.busy.vpn || !(await confirmBox("Сменить пароль ноутбука? Старый будет работать, пока вы не запустите команду на ноутбуке ещё раз.", "🔑 Сменить"))) return;
      S.busy.vpn = true;
      try {
        const r = await panel({ op: "remote_password" });
        if (r.t !== "done") { toast("⚠️ " + r.text, 6000); return; }
        remote = r;
        fill(r);
        if (r.ready) remoteHost(r, true); else toast("🔑 Пароль новый", 4000);
      } catch (e) { toast(problem(e)); } finally { S.busy.vpn = false; }
    }
    // one tap: the server checks everything a fault hides in (VPN, bridges, MAX, Winger's journal) and copies the report
    function diagCard(cl) {
      if (cl) {
        return el("button", { class: "btn line wide", style: "margin:0 0 12px", text: "🩺 Проверить сервер с Claude", onclick: async () => {
          try {
            const end = await panel({ op: "diag" }, (t) => toast(t, 60000));
            document.querySelectorAll(".toast").forEach((t) => t.remove());
            if (end.t !== "done") { toast("⚠️ " + end.text, 5000); return; }
            toClaude("Вот отчёт проверки сервера. Посмотри, всё ли в порядке, и если что-то не так — найди причину и предложи исправление.\n\n" + end.text);
          } catch (e) { toast(problem(e)); }
        } });
      }
      return el("div", { class: "card" }, el("h3", { text: "🩺 Проверка для Claude" }),
        el("small", { style: "color:var(--muted);display:block;margin:-4px 0 10px", text: "Сервер сам проверит VPN, мосты, MAX и журнал Winger "
          + "и скопирует отчёт — вставьте его в чат с Claude. Адресов и ключей в отчёте нет." }),
        el("button", { class: "btn wide", text: "🩺 Проверить и скопировать", onclick: async () => {
          try {
            const end = await panel({ op: "diag" }, (t) => toast(t, 60000));
            document.querySelectorAll(".toast").forEach((t) => t.remove());
            if (end.t !== "done") { toast("⚠️ " + end.text, 5000); return; }
            copyText(end.text);
            sheet("🩺 Проверка для Claude", (box, close) => box.append(
              el("div", { style: "font:11px/1.35 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--card);border-radius:12px;padding:10px;margin-bottom:12px;max-height:50vh;overflow:auto", text: end.text }),
              el("div", { class: "big-actions" }, claudeBtn("Разбери отчёт проверки сервера: что не так и как исправить?\n\n" + end.text, close),
                el("button", { class: "btn line", text: "📋 Скопировать", onclick: () => { copyText(end.text); toast("✅ Скопировано"); } }))));
            toast("✅ Отчёт скопирован — вставьте в чат с Claude", 5000);
          } catch (e) { toast(problem(e)); }
        } }));
    }
    // Winger's journal from the owner's phone: why the bridge works or not, how fast, where the errors are — to copy for Claude
    function wingerLogCard(short) {
      const card = el("div", { class: "card" }, el("h3", { text: "📋 Журнал Winger" }), el("div", { class: "status", text: "…" }));
      panel({ op: "winger_log" }).then((w) => {
        card.lastChild.remove();
        if (w.t !== "done" || !w.at) {
          card.append(el("small", { style: "color:var(--muted)", text: "Ещё не приходил. Winger присылает его сам раз в полчаса — только с вашего телефона (по вашему VPN)." }));
          return;
        }
        if (short) {
          card.append(el("div", { class: "row" }, el("div", { class: "grow" }, "Получен " + when(w.at), el("small", { text: [w.device, w.app ? "Winger " + w.app : ""].filter(Boolean).join(" · ") })),
            claudeBtn(() => WLOG_ASK
              + ["Журнал Winger (" + [w.device, w.app ? "Winger " + w.app : ""].filter(Boolean).join(", ") + "), получен " + when(w.at), "", ...w.lines].join("\n"))));
          return;
        }
        const m = w.summary || {};
        const row = (left, right, sub) => card.append(el("div", { class: "row", style: "min-height:32px" },
          el("div", { class: "grow" }, left, sub ? el("small", { text: sub }) : null), right ? el("b", { text: right }) : null));
        row("Получен " + when(w.at), "", [w.device, w.app ? "Winger " + w.app : ""].filter(Boolean).join(" · "));
        if (m.bridge_up || m.bridge_lost || m.bridge_errors) row("📞 Мост", `подключался ${m.bridge_up} · рвался ${m.bridge_lost} · ошибок ${m.bridge_errors}`);
        if (m.ping_avg) row("⏱ Отклик", `${m.ping_avg} мс`, `максимум ${m.ping_max} мс` + (m.ping_failed ? ` · без ответа ${m.ping_failed} раз` : ""));
        if (m.retries) row("🔁 Переподключений", String(m.retries));
        if (m.problems && m.problems.length) card.append(el("div", { style: "font:11px ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;background:var(--bg);border-radius:10px;padding:8px;margin:6px 0", text: m.problems.join("\n") }));
        const text = () => ["Журнал Winger (" + [w.device, w.app ? "Winger " + w.app : ""].filter(Boolean).join(", ") + "), получен " + when(w.at),
          `Мост: подключался ${m.bridge_up}, рвался ${m.bridge_lost}, ошибок ${m.bridge_errors}; отклик ср. ${m.ping_avg || "—"} мс, макс. ${m.ping_max || "—"}; без ответа ${m.ping_failed}; переподключений ${m.retries}`,
          "", ...w.lines].join("\n");
        card.append(el("div", { class: "big-actions", style: "margin-top:8px" },
          claudeBtn(() => WLOG_ASK + text()),
          el("button", { class: "btn line", text: "📋 Скопировать", onclick: () => { copyText(text()); toast("Скопировано", 4000); } })));
      }).catch(() => card.remove());
      return card;
    }
    // the last 7 days at a glance: who used the VPN how much, what broke and was fixed, backups, the hosting's money
    function weekCard() {
      const card = el("div", { class: "card" }, el("h3", { text: "📅 За неделю" }), el("div", { class: "status", text: "…" }));
      panel({ op: "week" }).then((w) => {
        if (w.t !== "done") { card.remove(); return; }
        card.lastChild.remove();
        const line = (left, right, sub) => card.append(el("div", { class: "row", style: "min-height:34px" },
          el("div", { class: "grow" }, left, sub ? el("small", { text: sub }) : null), right ? el("b", { text: right }) : null));
        const partial = w.counted_from && Date.parse(w.counted_from) > w.from * 1000;
        line("🛡 VPN всего", bytes(w.total), partial ? "считаю с " + new Date(w.counted_from).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) : "");
        for (const u of w.traffic.slice(0, 6)) line("· " + u.name, bytes(u.bytes));
        line(w.alerts ? `⚠️ Сбоев: ${w.alerts}` : "✅ Сбоев не было", w.fixed ? `починилось: ${w.fixed}` : "",
          w.problems.length ? w.problems[w.problems.length - 1] : "");
        line(w.backup ? (w.backup.ok ? "💾 Резервная копия" : "⚠️ Резервная копия не получилась") : "💾 Резервных копий не было",
          w.backup ? when(w.backup.ts) : "", w.backup ? "" : "Сделать — «💾 Резервная копия сейчас» ниже");
        const h = w.hosting || {};
        if (h.set) line(h.days_left < 7 ? "💳 Пора пополнить хостинг" : "💳 Хостинг", `≈ ${Math.floor(h.days_left)} дн.`);
        const u = w.update || {};
        if (u.current) line("⬆️ Версия сервера", "v" + u.current, u.new ? `есть v${u.latest}` : "последняя");
      }).catch(() => card.remove());
      return card;
    }
    function trafficCard() {
      const card = el("div", { class: "card" }, el("h3", { text: "📊 Трафик с перезапуска VPN" }), el("div", { class: "status", text: "…" }));
      panel({ op: "traffic" }).then((t) => {
        if (t.t !== "done") return;
        card.lastChild.remove();
        if (t.month !== null) {
          const pct = 100 * t.month / (t.cap_gb * 1024 ** 3);
          card.append(el("div", { class: "row" }, el("div", { class: "grow" }, "За месяц", el("small", { text: `сегодня ${bytes(t.today)}` })),
            el("b", { text: `${bytes(t.month)} из ${Math.round(t.cap_gb / 1024)} ТБ` })),
          el("div", { class: "bar", style: "margin:2px 0 8px" }, el("i", { style: `width:${Math.max(1, Math.min(100, pct))}%` })));
        }
        const top = t.users.map((u) => [u.name, (u.tx || 0) + (u.rx || 0)]).filter((u) => u[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
        for (const [n, v] of top) card.append(el("div", { class: "row", style: "min-height:34px" }, el("div", { class: "grow", text: n }), el("small", { text: bytes(v) })));
        if (!top.length) card.append(el("small", { style: "color:var(--muted)", text: "С последнего перезапуска VPN трафика ещё не было." }));
      }).catch(() => { card.lastChild.textContent = "не загрузилось"; });
      return card;
    }
    function eventsCard() {
      const items = cache.alerts || [];
      const card = el("div", { class: "card" }, el("h3", { text: "🔔 События" }));
      if (!items.length) card.append(el("small", { style: "color:var(--muted)", text: "Пока тихо. О сбоях и починке напишу сюда и пришлю уведомление." }));
      const seen = store.get("alertsSeen", 0);
      for (const a of items.slice(0, 12)) {
        card.append(el("div", { class: "event " + a.kind + (a.ts > seen && a.kind !== "log" ? " new" : ""), style: "cursor:pointer",
          onclick: () => sheet("🔔 Событие", (box, close) => box.append(el("div", { style: "font-size:13px;color:var(--muted)", text: when(a.ts) }),
            el("p", { text: a.text }), el("div", { class: "big-actions" }, claudeBtn(`Разбери событие сервера (${when(a.ts)}): «${a.text}». Что случилось и надо ли что-то исправить?`, close),
              el("button", { class: "btn line", text: "📋 Скопировать", onclick: () => { copyText(a.text); toast("✅ Скопировано"); } })))) },
          el("small", { text: when(a.ts) }), el("div", { text: a.text })));
      }
      if (items.length) store.set("alertsSeen", items[0].ts);
      badge(0);
      return card;
    }
    function actionsCard(d, cl) {
      const st = d.selftest;
      const checks = cl ? [] : [
        el("button", { class: "btn line wide", style: "margin-bottom:8px", text: "⚡ Скорость сервера", onclick: () => act({ op: "speed" }, null, (r) => toast(`⚡ Скорость сервера: ${r.mbit} Мбит/с`, 6000)) }),
        el("button", { class: "btn line wide", text: "🧪 Проверить мост", onclick: () => act({ op: "bridge_test" }, null, (r) => toast(r.selftest && r.selftest.ok ? `✓ Мост работает: ${r.selftest.mbit} Мбит/с` : "✗ Проверка не прошла", 5000)) }),
        el("div", { style: "font-size:13px;color:var(--muted);margin:4px 2px 8px", text: !st ? "Автопроверка моста: ещё не было"
          : st.ok ? `Последняя проверка ${when(st.ts)}: ✓ ${st.mbit} Мбит/с` : `Последняя проверка ${when(st.ts)}: ✗ ${st.err}` }),
        el("button", { class: "btn line wide", style: "margin-bottom:8px", text: "✉️ Проверить почту для оповещений", onclick: () => act({ op: "mail_test" }, null, (r) => toast("✉️ Письмо ушло" + (r.to ? " на " + r.to : ""), 5000)) })];
      return el("div", { class: "card" }, el("h3", { text: "🔧 Действия с сервером" }), ...checks,
        el("button", { class: "btn line wide", text: "💾 Резервная копия сейчас", onclick: async () => {
          if (await confirmBox("Сделать резервную копию сейчас? Через минуту-две она ляжет на Яндекс Диск (папка «Семейный сервер — копии»), а без Диска придёт на почту.", "Сделать")) act({ op: "backup" }, "💾 Делаю копию — на Яндекс Диск");
        } }),
        el("button", { class: "btn line wide danger", style: "margin-top:8px", text: "♻️ Перезагрузить сервер", onclick: async () => {
          if (await confirmBox("Перезагрузить сервер? VPN, мосты и помощник пропадут примерно на минуту.", "Перезагрузить")) act({ op: "reboot" }, "♻️ Перезагружаюсь, вернусь через минуту");
        } }),
        el("div", { style: "font-size:13px;color:var(--muted);margin-top:10px", text: (d.mail ? "Сбои приходят уведомлением и письмом на почту" : "Сбои приходят уведомлением (почта для оповещений не настроена)")
          + " и в MAX, если включено: «🤖 Помощник» → «🔔 Тревоги сервера в MAX»." }));
    }
    // the hosting: how many days the balance lasts, and when to pay (the balance is entered after a top-up)
    function drawHosting(h) {
      const day = (t) => new Date(t * 1000).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
      const sign = { EUR: " €", USD: " $", RUB: " ₽" }[h.currency] || " €";
      const eur = (v) => v.toFixed(2).replace(".", ",") + sign;
      const card = el("div", { class: "card" + (h.set && h.days_left < 5 ? " bad" : "") }, el("h3", { text: "💳 Хостинг " + h.provider }));
      if (h.set) {
        const n = Math.floor(h.days_left);
        card.append(el("div", { class: "row" }, el("span", { style: "font-size:22px", text: n < 5 ? "⚠️" : n < 10 ? "🟡" : "🟢" }),
          el("div", { class: "grow" }, el("b", { text: n > 0 ? `Хватит примерно на ${n} дн.` : "Баланс закончился" }),
            el("small", { text: n > 0 ? "Пополнить до " + day(h.pay_by) : "Пополните сейчас, иначе сервер остановят" }))),
          el("div", { style: "font-size:13px;color:var(--muted);margin:2px 0 8px",
            text: `Сейчас на балансе ≈ ${eur(h.balance)} · тариф ${eur(h.monthly)} в месяц (≈ ${eur(h.per_day)} в день). Считаю от баланса, ${h.source === "auto" ? "взятого из кабинета" : "введённого"} ${day(h.at)}; за 5 дн. до конца напомню.` }));
      } else {
        card.append(el("div", { style: "font-size:14px;margin-bottom:8px",
          text: "Введите баланс из кабинета HostVDS — дальше сервер сам считает, на сколько дней его хватит, и напомнит за 5 дней до конца." }));
      }
      const auto = Native && Native.hostingBalance;
      if (auto && store.get("hostvds", false)) {
        const st = el("div", { style: "font-size:13px;color:var(--muted);margin:0 0 8px",
          text: "🔗 Баланс берётся из кабинета HostVDS сам" + (h.source === "auto" && h.at ? " · обновлён " + ago(h.at) + " назад" : "") });
        card.append(st);
        if (Date.now() - store.get("hostvdsAt", 0) > 30 * 60000) {  // not on every redraw: at most every half hour
          store.set("hostvdsAt", Date.now());
          nativeCall("hostingBalance").then(async (r) => {
            let js = {};
            try { js = JSON.parse(r.text); } catch (e) { /* nothing */ }
            if (js.ok) {
              const end = await panel({ op: "hosting_set", balance: String(js.balance), currency: js.currency, source: "auto" }).catch(() => null);
              if (end && end.t === "done") { st.textContent = "🔗 Баланс из кабинета HostVDS обновлён только что"; setTimeout(load, 500); }
            } else if (js.why === "login") {
              store.set("hostvds", false);
              st.textContent = "🔗 Вход в кабинет HostVDS истёк — войдите снова, кнопка ниже";
            }
          });
        }
      }
      card.append(el("div", { class: "big-actions" },
        el("button", { class: "btn", text: h.set ? "💶 Пополнил — ввести баланс" : "💶 Ввести баланс", onclick: async () => {
          const v = await ask("Баланс HostVDS, €", "Например 12,40 — как в кабинете HostVDS → Биллинг");
          if (v) act({ op: "hosting_set", balance: v }, null, (r) => toast(`✅ Хватит примерно на ${Math.floor(r.hosting.days_left)} дн.`, 4000));
        } }),
        el("a", { class: "btn line", href: h.panel, style: "text-decoration:none;text-align:center", text: "🌐 Кабинет HostVDS" })),
        auto ? el("button", { class: "btn line wide", style: "margin-top:8px",
          text: store.get("hostvds", false) ? "🔌 Отключить кабинет HostVDS" : "🔗 Войти в кабинет — баланс будет обновляться сам",
          onclick: async () => {
            if (store.get("hostvds", false)) {
              if (!(await confirmBox("Отключить кабинет HostVDS? Приложение забудет вход, баланс снова вводится вручную.", "Отключить"))) return;
              Native.hostingLogout(); store.set("hostvds", false); draw(); return;
            }
            const r = await nativeCall("hostingLogin");
            if (!r.ok) return;
            store.set("hostvds", true); store.set("hostvdsAt", 0);
            toast("✅ Кабинет подключён — беру баланс…"); draw();
          } }) : null,
        el("button", { class: "btn line wide", style: "margin-top:8px", text: `⚙️ Тариф: ${eur(h.monthly)} в месяц`, onclick: async () => {
          const v = await ask("Сколько стоит сервер в месяц, €", "Сейчас " + eur(h.monthly) + " (HostVDS-4)", String(h.monthly).replace(".", ","));
          if (v) act({ op: "hosting_set", monthly: v }, null, () => toast("✅ Тариф сохранён"));
        } }));
      scroll.append(card);
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
      scroll.append(diskRow(), maxCard(), videoCard(), el("button", { class: "btn wide", style: "margin:0 0 8px", text: "➕ Добавить человека", onclick: addPerson }),
        el("button", { class: "btn line wide", style: "margin:0 0 12px", text: "🔗 Только приложение помощника — без входа (24 ч)",
          onclick: () => makeLink({ op: "dl_aiapp" }, "ИИ-помощник") }));
      const list = el("div", { class: "card" }, el("h3", { text: "Кто пользуется помощником" }),
        el("small", { style: "display:block;color:var(--muted);margin:-4px 0 6px", text: "Это только помощник. VPN выдаётся отдельно — в «🛡 VPN»." }));
      for (const u of d.users) {
        const now = u.seen && Date.now() / 1000 - u.seen < 900;
        list.append(el("div", { class: "row", style: "cursor:pointer", onclick: () => person(u.id) },
          el("span", { style: "font-size:20px", text: u.off ? "⏸" : now ? "🟢" : "⚪" }),
          el("div", { class: "grow" }, u.name + (u.id === d.me ? " · вы" : ""),
            el("small", { text: u.off ? "доступ отключён" : !u.seen ? "ещё не входил(а)" + (u.codes ? " · код создан — отправьте ссылку из карточки" : "")
              : (now ? "сейчас в приложении" : "был(а) " + ago(u.seen) + " назад") + (u.devices > 1 ? ` · телефонов: ${u.devices}` : "") })),
          u.id === d.me ? null : el("button", { class: "icon-btn", title: "Удалить", text: "🗑", onclick: (e) => { e.stopPropagation(); delPerson(u); } }),
          "›"));
      }
      scroll.append(list, el("div", { style: "font-size:13px;color:var(--muted);padding:0 4px 12px",
        text: (d.apk && d.apk.name ? `Версия приложения: ${d.apk.name}. ` : "") + "Удалить человека — 🗑 в его строке; отключить на время или выйти на его телефонах — в его карточке." }));
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
    // ---- the assistant in MAX: the owner connects the family's bot once; people link with a code ----
    async function maxCode(u) {
      try {
        const end = await panel({ op: "max_code", id: u.id });
        if (end.t !== "done") { toast("⚠️ " + end.text, 5000); return; }
        if (!end.on) { toast("Сначала подключите бота MAX: «🤖 Помощник» → «💬 Помощник в MAX»", 5000); return; }
        sheet("💬 MAX — " + u.name, (box) => box.append(
          el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 10px", text: end.link
            ? "Отправьте приглашение человеку: он откроет ссылку — MAX сам откроет помощника и подключит его. Одноразовое."
            : "Отправьте это сообщение человеку как удобно. Код одноразовый." }),
          el("div", { style: "font:15px/1.45 system-ui,sans-serif;white-space:pre-wrap;background:var(--card);border-radius:12px;padding:12px;margin-bottom:12px;user-select:all", text: end.text }),
          el("button", { class: "btn wide", text: "📤 Отправить приглашение", onclick: () => (navigator.share ? navigator.share({ text: end.text }).catch(() => {}) : (copyText(end.text), toast("✅ Скопировано — отправьте как удобно"))) }),
          el("button", { class: "btn line wide", style: "margin-top:8px", text: "📋 Копировать", onclick: () => { copyText(end.text); toast("✅ Скопировано — отправьте как удобно"); } })));
      } catch (e) { toast(problem(e)); }
    }
    // ---- video from a photo on Hugging Face: the owner's free minutes; the owner has it, others when allowed ----
    let video = null;
    function videoCard() {
      const card = el("div", { class: "card", style: "margin:0 0 12px" }, el("small", { text: "🎬 Видео из фото: проверяю…" }));
      const fill = (v) => {
        video = v;
        card.innerHTML = "";
        card.append(el("div", { class: "row" },
          el("div", { class: "grow" }, "🎬 Видео из фото" + (v.on ? " ✓" : ""),
            el("small", { text: v.on ? `Hugging Face${v.name ? " «" + v.name + "»" : ""}. Вам — сразу; другим — «🎬 Видео из фото» в их карточке ниже`
              + (v.people.length ? ` (включено: ${v.people.join(", ")})` : "") + "."
              : "Короткое видео из фото («оживи») на бесплатных минутах Hugging Face: несколько роликов в день." })),
          v.env ? null : el("button", { class: "btn" + (v.on ? " line" : ""), style: "flex:none;padding:8px 14px", text: v.on ? "Настроить" : "Подключить",
            onclick: () => videoSetup(v, fill) })));
      };
      panel({ op: "hf_get" }).then((v) => (v.t === "done" ? fill(v) : card.remove())).catch(() => card.remove());
      return card;
    }
    function videoSetup(v, fill) {
      sheet("🎬 Видео из фото", (box, close) => {
        const inp = el("input", { class: "input", placeholder: "hf_…", autocomplete: "off", spellcheck: "false" });
        box.append(
          el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 10px", text: "Видео делают модели на видеокартах Hugging Face "
            + "(Wan 2.2, запасная — LTX-2.3). Бесплатные минуты — вашего аккаунта, общие на всех, кому вы включите." }),
          el("ol", { style: "margin:0 0 12px;padding-left:20px;font-size:15px;line-height:1.5" },
            el("li", { text: "Войдите на huggingface.co (нужна только почта)." }),
            el("li", { text: "«🔑 Получить токен» → «Create new token» → тип «Read» → «Create token» → скопируйте (начинается с hf_)." }),
            el("li", { text: "Вставьте сюда и нажмите «✅ Подключить». В чаты токен не присылайте." })),
          el("a", { class: "btn line wide", href: "https://huggingface.co/settings/tokens",
            style: "display:block;text-align:center;text-decoration:none;margin-bottom:10px", text: "🔑 Получить токен" }),
          inp,
          el("button", { class: "btn soft wide", style: "margin-top:8px", text: "📋 Вставить из буфера", onclick: async () => {
            let t = "";
            try { t = Native && Native.clipboard ? Native.clipboard() : await navigator.clipboard.readText(); } catch (e) { /* no access */ }
            if (t) inp.value = t.trim(); else toast("В буфере ничего нет — вставьте вручную");
          } }),
          el("button", { class: "btn wide", style: "margin-top:8px", text: "✅ Подключить", onclick: async () => {
            try {
              const end = await panel({ op: "hf_set", token: inp.value.trim() });
              if (end.t !== "done") { toast("⚠️ " + end.text, 6000); return; }
              close(); fill(end);
              toast(`✅ Подключено${end.name ? ": " + end.name : ""}. Пишите в «🖼 Фото»: «оживи»`, 5000);
            } catch (e) { toast(problem(e)); }
          } }),
          v.on ? el("button", { class: "btn line wide", style: "margin-top:14px;color:var(--danger)", text: "Отключить видео из фото", onclick: async () => {
            if (!(await confirmBox("Отключить видео из фото? У всех пропадёт «🎬 Оживить», токен удалится с сервера.", "Отключить"))) return;
            try { const end = await panel({ op: "hf_off" }); close(); fill(end); toast("Видео из фото отключено"); } catch (e) { toast(problem(e)); }
          } }) : "");
      });
    }
    function maxCard() {
      const card = el("div", { class: "card", style: "margin:0 0 12px" }, el("small", { text: "💬 MAX: проверяю…" }));
      const fill = (m) => {
        card.innerHTML = "";
        card.append(el("div", { class: "row" },
          el("div", { class: "grow" }, m.on ? `💬 Помощник в MAX ✓ ${m.bot ? "@" + m.bot : ""}` : "💬 Помощник в MAX",
            el("small", { text: m.on ? (m.error === "token" ? "⚠️ MAX не принимает токен — подключите заново."
              : `Подключено людей: ${m.people.length}. Код для человека — в его карточке ниже.`)
              : "Родные пишут и говорят с помощником прямо в MAX — работает и при «белых списках»." })),
          el("button", { class: "btn" + (m.on ? " line" : ""), style: "flex:none;padding:8px 14px", text: m.on ? "Настроить" : "Подключить", onclick: () => maxSetup(m, fill) })));
        if (m.on) {  // the server's news to the owner's MAX: problems, fixes, new versions, the hosting's money
          card.append(el("div", { class: "row" },
            el("div", { class: "grow" }, "🔔 Тревоги сервера в MAX",
              el("small", { text: !m.owner_linked ? "Свяжите свой MAX: «💬 Пригласить в MAX» в своей карточке ниже."
                : m.alerts ? "Сбои, починки, новые версии, оплата хостинга. О VPN в MAX ни слова — только «посмотрите в приложении»."
                  : "Выключено: всё только в «🖥 Сервер» → «🔔 События»." })),
            el("button", { class: "btn" + (m.alerts ? " line" : ""), style: "flex:none;padding:8px 14px", text: m.alerts ? "Выключить" : "Включить",
              onclick: async () => {
                const end = await panel({ op: "max_alerts", on: !m.alerts }).catch(() => null);
                if (end && end.t === "done") { fill(end); toast(end.alerts ? "🔔 Тревоги сервера будут приходить в MAX" : "🔕 Тревоги в MAX выключены"); }
              } })));
        }
      };
      panel({ op: "max_get" }).then((m) => (m.t === "done" ? fill(m) : card.remove())).catch(() => card.remove());
      return card;
    }
    function maxSetup(m, after) {
      sheet("💬 Помощник в MAX", (box, close) => {
        const inp = el("input", { class: "input", placeholder: "Токен бота", autocomplete: "off", spellcheck: "false" });
        box.append(
          el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 10px", text: "Тот же помощник, что в приложении, но в MAX: вопросы, голосовые, фото, "
            + "документы, проверка сообщений на мошенников (вам придёт уведомление), напоминания. Без слов о VPN." }),
          el("ol", { style: "margin:0 0 12px;padding-left:20px;font-size:15px;line-height:1.5" },
            el("li", { text: "На платформе «MAX для партнёров» (нужен подтверждённый профиль ИП или самозанятого): «Чат-боты» → создайте бота → «Интеграция» → «Получить токен»." }),
            el("li", { text: "Скопируйте токен бота и вставьте сюда." }),
            el("li", { text: "Людям — «💬 Пригласить в MAX» в их карточке: они откроют ссылку и смогут писать. Или сами: «☰ Ещё» → «💬 Помощник в MAX»." })),
          m.on ? el("div", { style: "margin-bottom:10px", text: `Сейчас: @${m.bot || "бот"}. Подключены: ${m.people.map((p) => p.name).join(", ") || "пока никто"}` }) : "",
          inp,
          el("button", { class: "btn soft wide", style: "margin-top:8px", text: "📋 Вставить из буфера", onclick: async () => {
            let t = "";
            try { t = Native && Native.clipboard ? Native.clipboard() : await navigator.clipboard.readText(); } catch (e) { /* no access */ }
            if (t) inp.value = t.trim(); else toast("В буфере ничего нет — вставьте вручную");
          } }),
          el("button", { class: "btn wide", style: "margin-top:8px", text: "✅ Подключить", onclick: async () => {
            if (!inp.value.trim()) { toast("Сначала вставьте токен"); return; }
            toast("⏳ Проверяю токен…", 20000);
            try {
              const end = await panel({ op: "max_set", token: inp.value.trim() });
              if (end.t !== "done") { toast("⚠️ " + end.text, 6000); return; }
              toast(`✅ Бот подключён: @${end.bot || end.name}`, 5000);
              close(); after(end);
            } catch (e) { toast(problem(e)); }
          } }),
          ...(m.people || []).map((p) => el("button", { class: "btn line wide", style: "margin-top:8px", text: `✂️ Отвязать MAX от «${p.name}»`, onclick: async () => {
            if (!(await confirmBox(`Отвязать MAX от «${p.name}»? Чтобы снова пользоваться, понадобится новый код.`, "Отвязать"))) return;
            const end = await panel({ op: "max_unlink", max: p.max });
            close(); after(end); toast("Отвязан");
          } })),
          m.on ? el("button", { class: "btn line wide", style: "margin-top:14px;color:var(--danger)", text: "Отключить бота", onclick: async () => {
            if (!(await confirmBox("Отключить помощника в MAX? Люди перестанут получать ответы, пока не подключите снова.", "Отключить"))) return;
            const end = await panel({ op: "max_off" });
            close(); after(end); toast("Бот отключён");
          } }) : "");
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
            () => makeLink({ op: "dl_aiapp", id: u.id }, "ИИ-помощник — " + u.name), ""),
          act("💬 Пригласить в MAX", () => maxCode(u)));
        if (!mine) {  // video from a photo: the owner's Hugging Face minutes, only for whom the owner allows
          box.append(el("div", { class: "row", style: "margin-top:10px" },
            el("div", { class: "grow" }, "🎬 Видео из фото", el("small", { text: !(video && video.on) ? "Сначала подключите: «🎬 Видео из фото» выше в разделе."
              : u.video ? "Включено: в «🖼 Фото» есть «🎬 Оживить» (и в MAX)." : "Выключено: минуты Hugging Face общие — включайте тем, кому нужно." })),
            el("button", { class: "toggle" + (u.video ? " on" : ""), disabled: !(video && video.on), onclick: () => {
              close(); appOp({ op: "app_set", id: u.id, video: !u.video }, u.video ? "🎬 Видео из фото выключено" : "🎬 Видео из фото включено");
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
            + (u.until ? ` · ⏰ гость до ${when(u.until)}, потом выключится сам` : "") }));
        const kinds = [["hy2", "Hysteria", "основной, быстрый (UDP)"], ["vless", "VLESS", "запасной, когда режут UDP"],
          ["tg", "Telegram", "Telegram без VPN: iPhone, компьютер, любой телефон (ключ общий для всех)"]].filter((k) => u.links[k[0]]);
        const pane = el("div");
        const chips = el("div", { class: "chips", style: "margin-bottom:10px" });
        if (u.links.hy2) {  // what to give the person: three ways, each a ready message to send
          box.append(el("div", { style: "font-weight:600;margin:2px 2px 8px", text: "Выдать человеку" }),
            giveTile("📲", "Программа + VPN", "Winger с подключением внутри: человек скачает и нажмёт одну кнопку. Ссылка на сутки, там же Telegram без VPN.",
              () => { close(); makeLink({ op: "dl_vpnlink", name: u.name }, "VPN и Telegram — " + u.name); }),
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
          box.append(el("button", { class: "btn line wide", style: "margin-top:14px;color:var(--danger)", text: "🗑 Удалить", onclick: () => { close(); delVpn(u.name); } }));
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
      const link = wingerLink(got);
      if (!link) { toast(`⚠️ У моста «${b.name}» для «${u.name}» ещё нет звонка — он поднимается сам, попробуйте через пару минут.`, 7000); return; }
      let png = null;
      try {
        const q = await panel({ op: "qr", text: link });
        if (q.t === "done" && q.png) png = blobOf(q.png, "image/png");
      } catch (e) { /* no picture: the message alone */ }
      const msg = `🌉 Мост «${b.name}» для «${u.name}»\n\nНужен в дни, когда мобильный интернет пускает только разрешённые сайты.\n`
        + `1️⃣ Скопируйте это сообщение целиком\n2️⃣ Откройте Winger → «📋 Вставить ссылку»\nДальше Winger сам включит мост, когда обычный VPN не отвечает.`
        + `\n\n${link}`;
      shareSheet(`🌉 ${b.name} для «${u.name}»`, msg, link, png, `bridge-${b.plat}-${u.name}.png`,
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
    // unread events for the tab's badge, without opening the tab (and without the fingerprint question)
    async function peek() {
      try {
        const seen = store.get("alertsSeen", 0);
        const ev = await panel({ op: "alerts", since: seen });
        if (ev.t === "done" && S.tab !== "vpn") badge(ev.alerts.filter((a) => a.kind !== "log").length);
      } catch (e) { /* quiet */ }
    }
    return { root, peek, redraw: () => open && draw(),
      sub: () => ({ server: "состояние, мосты, события", vpn: "выдача VPN: ссылки и QR", app: "кто пользуется помощником", claude: "Claude Code на вашем сервере" })[part],
      buttons: () => (open ? [["🔄", "Обновить", load]] : []),
      onShow: () => (open ? load() : enter()) };
  }
  return vpnView;
})
