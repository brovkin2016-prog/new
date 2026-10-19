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
    return s < 3600 ? Math.max(1, Math.round(s / 60)) + "\u00a0мин" : s < 86400 ? Math.round(s / 3600) + "\u00a0ч" : Math.round(s / 86400) + "\u00a0дн.";
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
    const cache = { server: null, vpn: null, app: null, claude: null };
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
        const end = await panel(body);
        if (end.t !== "done" && want === "claude") { cache.claude = { t: "done", installed: false, why: end.text }; if (part === want) draw(); return; }
        if (end.t !== "done") throw Object.assign(new Error(end.text || "Не получилось."), { said: true });
        cache[want] = end;
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
      scroll.append(head, diskRow(), el("button", { class: "btn wide", style: "margin:0 0 8px", text: "➕ Выдать VPN", onclick: add }),
        el("div", { class: "big-actions", style: "margin:0 0 12px" },
          el("button", { class: "btn line", text: "📱 Winger для Android", onclick: () => makeLink({ op: "dl_vpnapp" }, "Приложение Winger VPN") }),
          el("button", { class: "btn line", text: "💻 Winger для Windows", onclick: () => makeLink({ op: "dl_winapp" }, "Winger для Windows") })));
      const list = el("div", { class: "card" }, el("h3", { text: "Кому выдан VPN" }));
      for (const u of data.users) {
        list.append(el("div", { class: "row", style: "cursor:pointer", onclick: () => card(u.name) },
          el("span", { style: "font-size:20px", text: u.online ? "🟢" : "⚪" }),
          el("div", { class: "grow" }, u.name + (u.owner ? " 👑" : ""),
            el("small", { text: (u.online ? "в сети" : "не в сети") + (u.until ? " · ⏰ гость до " + when(u.until) : "") + (u.bridge ? " · 🌉 мост" : "") })),
          u.owner ? null : el("button", { class: "icon-btn", title: "Удалить", text: "🗑", onclick: (e) => { e.stopPropagation(); delVpn(u.name); } }),
          "›"));
      }
      scroll.append(list);
    }
    // a temporary link (24 h) for downloading an app or connecting the VPN: copied and sent however the owner likes
    // ---- links that open everywhere in Russia: a folder on the owner's Yandex Disk, deleted after 24 hours ----
    const diskRows = new Set();  // every «📦 Ссылки» row on screen: all of them change when the Disk is connected
    function diskRow() {
      const row = el("div", { class: "card", style: "margin:0 0 12px" }, el("small", { text: "📦 Ссылки: проверяю…" }));
      const fill = (d) => {
        row.innerHTML = "";
        row.append(el("div", { class: "row" },
          el("div", { class: "grow" }, d.on ? "📦 Ссылки — через Яндекс Диск ✓" : "📦 Для ссылок подключите Яндекс Диск",
            d.on ? null : el("small", { text: "Ссылки на 24 часа кладутся на ваш Яндекс Диск — так они открываются в любом браузере. Займёт минуту." })),
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
      if (!running && p.state === "finished" && p.version && !p.ok) line(`⚠️ Обновление до v${p.version} не прошло`, "Сервер работает на прежней версии. Почему — спросите в «🛠 Claude».");
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
        row.append(el("button", { class: "btn line", text: "🔎 Проверить обновление", onclick: async () => {
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
        + "после — проверит себя и при поломке вернёт как было. Каждый откат Claude запоминает как урок; своё правило — "
        + "«Запомни: …» (его увидят все разговоры), «Забудь уроки» — стереть ваши правила." }),
        el("div", { class: "hints", style: "margin-top:8px" }, ...hints.map((t) => el("button", { class: "hint", text: t, onclick: () => send(t) }))));
    }
    // the rescue console: Claude Code on the owner's Anthropic key and the repairs, in a browser, apart from this app
    function rescueCard() {
      const box = el("div", { class: "card", style: "padding:10px 12px" });
      const go = el("button", { class: "btn line wide", text: "🛟 Открыть спасательную консоль", onclick: async () => {
        go.disabled = true;
        try {
          const end = await panel({ op: "rescue_link" });
          if (end.t !== "done") { toast("⚠️ " + end.text, 9000); go.disabled = false; return; }
          go.replaceWith(el("a", { class: "btn wide", href: end.url, style: "display:block;text-align:center;text-decoration:none",
            text: "👉 Открыть в браузере (ссылка на 3 минуты)" }));
        } catch (e) { toast(problem(e)); go.disabled = false; }
      } });
      box.append(el("small", { style: "display:block;color:var(--muted);margin-bottom:6px",
        text: "Claude Code по вашему ключу Anthropic (сам выбирает Haiku, Sonnet или Opus 5.5) и откат правок — в браузере, отдельно от приложения. "
          + "Если «Управление» или этот чат сломаются, консоль откроется и из Winger: «🛟 Спасение сервера»." }), go);
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
      scroll.append(rescueCard());
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
        el("a", { href: "#", text: "🔑 Ключи", onclick: (e) => { e.preventDefault(); allKeys(); } }),
        // when the free models' day is used up: Claude itself on the owner's key from the rescue console
        el("br"), d.paid_key
          ? el("a", { href: "#", text: (d.paid ? "💳 Кончились бесплатные — дальше Claude по вашему ключу: вкл" : "💳 Claude по вашему ключу, когда кончились бесплатные: выкл")
              + ` · $${(d.spent || 0).toFixed(2)} из $${d.cap || 5} в месяц`, onclick: async (e) => {
              e.preventDefault();
              const end = await panel({ op: "agent_paid", on: !d.paid });
              if (end.t === "done") { cache.claude = end; draw(); } else toast("⚠️ " + end.text);
            } })
          : el("a", { href: "#", text: "💳 Когда бесплатные модели кончатся за день, ответит Claude по вашему ключу — добавьте ключ Anthropic в «🔑 Ключи»",
              onclick: (e) => { e.preventDefault(); allKeys(); } })));
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
      scroll.append(el("div", { class: "card hero" + (bad.length ? " bad" : "") },
        el("div", { class: "emoji", text: bad.length ? "⚠️" : "✅" }),
        el("div", { class: "grow" }, el("b", { text: bad.length ? "Есть проблемы" : "Всё работает" }),
          el("small", { text: bad.length ? bad.join(" · ") : `${d.host} · ${d.ip}` + (d.online !== null ? ` · в сети: ${d.online}` : "") }))));
      // what the owner needs: the hosting's days left and the server's version (always), the bridges, remote desktop
      const u = d.update;
      scroll.append(keysRow());  // every key of the helper and Claude: which are in
      if (host) drawHosting(host);  // how many days the hosting's money lasts: always in sight
      if (u) scroll.append(updateCard(u, "all"));  // the version, «🔎 Проверить обновление», «⬆️ Обновить», the night switch
      if ("vpn_soft" in d) scroll.append(vpnSoftCard(d.vpn_soft));
      scroll.append(storageCard(), bridgesCard(d), remoteCard());
    }
    // ---- the VPN's programs: Hysteria and Xray as installed, the latest, the last nightly update's word (vpn-update) ----
    function vpnSoftCard(v) {
      const card = el("div", { class: "card", style: "margin:0 0 12px" });
      if (!v) return card.append(el("small", { text: "🛡 Программы VPN: версии ещё не проверялись — появятся здесь в течение часа." })), card;
      const n = (s) => String(s || "").replace(/^app\//, "").replace(/^v/, "");
      const one = (name, cur, latest, bad) => !cur ? "" : `${name} ${cur}` + (!latest || n(latest) === n(cur) ? " ✓ последняя"
        : n(bad) === n(latest) ? ` — новая ${latest} не прошла проверку, оставлена рабочая` : ` — вышла ${latest}, обновится сама ночью`);
      const parts = [one("Hysteria", v.hysteria, v.hysteria_latest, v.hysteria_bad), one("Xray", v.xray, v.xray_latest, v.xray_bad)].filter(Boolean);
      const recent = v.note && v.note_at && Date.now() / 1000 - v.note_at < 7 * 86400;
      const warn = recent && /^(↩️|⚠️)/.test(v.note);
      card.append(el("div", { class: "grow" }, "🛡 Программы VPN",
        el("small", { text: (parts.join(" · ") || "версии не прочитались") + (v.at ? `. Проверено ${ago(v.at)} назад.` : "") }),
        recent ? el("small", { style: "display:block;margin-top:4px" + (warn ? ";color:var(--danger-ink)" : ""),
          text: `Последнее обновление (${ago(v.note_at)} назад): ` + v.note.replace(/^\S+\s*VPN:\s*/, "") }) : ""));
      return card;
    }
    // ---- the disk: how full it is, what the templates take, how fast it is (the last test), what the last cleanup freed ----
    function storageCard() {
      const card = el("div", { class: "card" }, el("h3", { text: "💾 Диск" }), el("small", { text: "Проверяю…" }));
      const gb = (v) => String(Math.round((+v || 0) * 10) / 10).replace(".", ",") + " ГБ";
      const note = (text) => el("div", { style: "font-size:13px;color:var(--muted);margin:2px 0 6px", text });
      const fill = (s) => {
        const t = s.test, c = s.clean, tp = s.templates || {};
        card.innerHTML = "";
        card.append(el("h3", { text: "💾 Диск" }),
          el("div", { class: "row" }, el("div", { class: "grow" }, el("b", { text: `Свободно ${gb(s.disk.free)} из ${gb(s.disk.total)}` }),
            el("small", { text: `Занято ${gb(s.disk.used)} · шаблоны: ${tp.videos || 0} роликов и ${tp.photos || 0} фото — ${gb(tp.gb)}` }))));
        if (t && !t.err) {
          card.append(el("div", { class: "row" }, el("span", { style: "font-size:20px", text: t.fast ? "🟢" : "🟡" }),
            el("div", { class: "grow" }, el("b", { text: "Диск " + t.verdict }),
              el("small", { text: `запись ${t.write} МБ/с · чтение ${t.read === null ? "—" : t.read} МБ/с`
                + (t.iops !== null && t.iops !== undefined ? ` · ${t.iops} IOPS` : "") + " · проверен " + when(t.ts) }))));
        } else card.append(note(t ? "Проверка не получилась: " + t.err : "Скорость диска ещё не проверялась."));
        if (c) card.append(note(`Последняя чистка ${when(c.ts)}: освобождено ` + (c.freed_mb >= 100 ? gb(c.freed_mb / 1024) : (c.freed_mb || 0) + " МБ")));
        const btn = el("button", { class: "btn soft wide", style: "margin-top:6px", text: "🔎 Проверить диск", onclick: async () => {
          if (S.busy.vpn) { toast("Подождите, предыдущее действие ещё идёт"); return; }
          S.busy.vpn = true; btn.disabled = true; btn.textContent = "⏳ Проверяю диск, до 30 секунд…";
          try {
            const end = await panel({ op: "storage_test" });
            if (end.t !== "done") toast("⚠️ " + end.text, 6000);
            else { fill(end); toast(end.test && !end.test.err ? "✅ Диск " + end.test.verdict : "⚠️ Проверка не получилась", 5000); }
          } catch (e) { toast(problem(e)); } finally {
            S.busy.vpn = false;
            if (btn.isConnected) { btn.disabled = false; btn.textContent = "🔎 Проверить диск"; }
          }
        } });
        card.append(btn);
      };
      panel({ op: "storage" }).then((s) => (s.t === "done" ? fill(s) : card.remove())).catch(() => card.remove());
      return card;
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
        el("small", { style: "color:var(--muted);display:block;margin:-4px 0 6px", text: "Winger получает мосты сам. Нажмите на мост — его ссылки и перезапуск." }));
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
    function remoteCard() {
      const card = el("div", { class: "card" }, el("h3", { text: "🖥 Удалённый доступ" }));
      for (const [icon, name, url] of RUSTDESK) {
        card.append(el("div", { class: "row" }, el("span", { style: "font-size:20px", text: icon }), el("div", { class: "grow", text: name }),
          el("a", { class: "btn line", href: url, style: "flex:none;padding:8px 14px;text-decoration:none", text: "⬇️ Скачать" }),
          el("button", { class: "icon-btn", title: "Скопировать ссылку", text: "📋", onclick: () => { copyText(url); toast("✅ Ссылка скопирована"); } })));
      }
      return card;
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
      // the main job first (people), then the services the helper uses
      scroll.append(el("button", { class: "btn wide", style: "margin:0 0 8px", text: "➕ Добавить человека", onclick: addPerson }),
        el("button", { class: "btn line wide", style: "margin:0 0 12px", text: "🔗 Приложение помощника — ссылка",
          onclick: () => makeLink({ op: "dl_aiapp" }, "ИИ-помощник") }));
      const list = el("div", { class: "card" }, el("h3", { text: "Кто пользуется помощником" }));
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
      scroll.append(list, el("h3", { style: "margin:18px 2px 8px", text: "Подключения" }), keysRow(), diskRow(), videoCard(), trendsCard(), searchCard());
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
    function videoCard() {
      const card = el("div", { class: "card", style: "margin:0 0 12px" }, el("small", { text: "🎬 Видео из фото: проверяю…" }));
      const fill = (v) => {
        video = v;
        card.innerHTML = "";
        const n = (v.people || []).length;
        const sp = v.on ? spaceState(v) : null;
        card.append(el("div", { class: "row" },
          el("div", { class: "grow" }, "🎬 Видео из фото" + (v.on ? " ✓" : ""),
            el("small", { text: v.on ? `Hugging Face${v.name ? " «" + v.name + "»" : ""}. Вам — сразу; другим — переключатель «🎬 Видео» в карточке человека (список ниже)`
              + (n ? `: включено у ${n}` : "") + "."
              : "Короткое видео из фото («оживи») и «Я в ролике» в HD на бесплатных минутах Hugging Face." }),
            sp ? el("small", { style: "display:block;margin-top:4px;color:" + sp.color, text: sp.short }) : null),
          v.env ? null : el("button", { class: "btn" + (v.on ? " line" : ""), style: "flex:none;padding:8px 14px", text: v.on ? "Настроить" : "Подключить",
            onclick: () => videoSetup(v, fill) })));
      };
      panel({ op: "hf_get" }).then((v) => (v.t === "done" ? fill(v) : card.remove())).catch(() => card.remove());
      return card;
    }
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
    // ---- «🌐 Поиск в интернете»: how each source answered the chat last, and a check from the server now ----
    function searchCard() {
      const card = el("div", { class: "card", style: "margin:0 0 12px" }, el("small", { text: "🌐 Поиск: проверяю…" }));
      const fill = (v) => {
        card.innerHTML = "";
        const seen = (v.engines || []).filter((e) => e.at);
        const g = v.groq || {};
        const parts = seen.map((e) => e.name + (e.ok ? " ✓" : " ⚠️ " + e.why));
        if (g.key) parts.push("Groq" + (!g.at || g.ok ? " ✓" : " ⚠️ " + g.why));
        const c = v.check || {};
        const checked = c.at ? "Проверка " + ago(c.at) + " назад: " + (c.error ? "⚠️ поиск не ответил"
          : `найдено ${c.results}, прочитано страниц ${c.pages}`) + " · погода " + (c.weather ? "✓" : "⚠️") + " · таблица РПЛ "
          + (c.table ? "✓" : "⚠️") + (c.sec ? ` (за ${c.sec} с)` : "") + "." : "Проверки ещё не было.";
        const bad = c.at && (c.error || !c.pages || !c.weather || !c.table);
        card.append(el("div", { class: "row" },
          el("div", { class: "grow" }, "🌐 Поиск в интернете",
            el("small", { text: (parts.length ? "Последние ответы: " + parts.join(" · ") + ". " : "С последнего перезапуска сервера в интернете ещё не искали. ") }),
            el("small", { style: "display:block;margin-top:4px" + (bad ? ";color:var(--danger-ink)" : ""), text: checked }),
            ...["exa", "groq"].filter((k) => !(v[k] || {}).env).map((k) => el("a", { href: "#",
              style: "display:block;padding:8px 0 0;font-size:14px", text: (v[k] || {}).key ? `🔑 ${KEYS[k].name} подключён · изменить`
                : `🔑 Подключить ${KEYS[k].name} (${KEYS[k].hint})`, onclick: (e) => { e.preventDefault(); keySheet(k, v, fill); } }))),
          el("button", { class: "btn line", style: "flex:none;padding:8px 14px", text: "Проверить", onclick: async (e) => {
            const b = e.currentTarget;
            busyBtn(b, "⏳ До минуты");
            try {
              const end = await panel({ op: "search_test" });
              if (end.t !== "done") { toast("⚠️ " + end.text, 6000); freeBtn(b); return; }
              fill(end);
              const k = end.check || {};
              toast(k.pages && k.weather && k.table ? "🌐 Поиск работает: страницы читаются, погода и таблица приходят"
                : "⚠️ Поиск ответил не полностью — подробности в карточке", 6000);
            } catch (x) { toast(problem(x)); freeBtn(b); }
          } })));
      };
      panel({ op: "search_get" }).then((v) => (v.t === "done" && v.on ? fill(v) : card.remove())).catch(() => card.remove());
      return card;
    }

    // ---- «🔑 Ключи»: every key of the helper and Claude in one place — which are in, which are not, what each is for ----
    const KEY_SITE = {  // where each key is made
      dahl: "https://inference.dahl.global", orca: "https://orcarouter.ai", nvidia: "https://build.nvidia.com",
      zhipu: "https://open.bigmodel.cn", gemini: "https://aistudio.google.com/apikey", openrouter: "https://openrouter.ai/keys",
      groq: "https://console.groq.com/keys", exa: "https://dashboard.exa.ai/api-keys", giga: "https://developers.sber.ru/studio",
      salute: "https://developers.sber.ru/studio", cf: "https://dash.cloudflare.com", ovh: "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/",
      hf: "https://huggingface.co/settings/tokens/new?tokenType=write", coverr: "https://coverr.co/developers",
      anthropic: "https://console.anthropic.com/settings/keys",
    };
    // the keys the helper's own cards check and keep (search, video, trends): [set, off, the field the key goes in]
    const APP_KEY_OP = { groq: ["groq_set", "groq_off", "key"], exa: ["exa_set", "exa_off", "key"], hf: ["hf_set", "hf_off", "token"],
      coverr: ["coverr_set", "coverr_off", "key"] };
    let keysNow = null;  // the list as the server last said it
    function keysRow() {
      const sub = el("small", { text: keysNow ? `подключено ${keysNow.filter((k) => k.on).length} из ${keysNow.length}` : "все ключи помощника и Claude" });
      const card = el("div", { class: "card", style: "margin:0 0 12px;padding:8px 12px" },
        el("div", { class: "row", style: "min-height:44px;cursor:pointer", onclick: () => allKeys() },
          el("span", { style: "font-size:22px", text: "🔑" }), el("div", { class: "grow" }, "Ключи", sub),
          el("span", { class: "muted", style: "font-size:22px", text: "›" })));
      panel({ op: "agent_keys" }).then((r) => {
        if (r.t !== "done") return;
        keysNow = r.keys;
        const off = r.keys.filter((k) => !k.on).length;
        sub.textContent = `подключено ${r.keys.length - off} из ${r.keys.length}` + (off ? " · нажмите, чтобы увидеть, каких нет" : "");
      }).catch(() => {});
      return card;
    }
    function allKeys() {
      sheet("🔑 Ключи", (box) => {
        const list = el("div", {}, el("div", { class: "status", style: "padding:12px" }, el("span", { class: "spin" }), "Загружаю…"));
        box.append(el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 10px", text:
          "Все ключи помощника и Claude в одном месте: ✅ — подключён, ➖ — нет. Нажмите строку — там написано, для чего ключ "
          + "и где его взять; там же его подключают, меняют и убирают. Ключи хранятся только на сервере — в чаты их не присылайте." }), list);
        const fill = (keys) => {
          keysNow = keys;
          list.innerHTML = "";
          list.append(el("div", { style: "font-size:14px;margin:0 2px 6px", text: `Подключено ${keys.filter((k) => k.on).length} из ${keys.length}` }));
          for (const k of keys) {
            list.append(el("div", { class: "row", style: "cursor:pointer", onclick: () => keyOne(k, fill) },
              el("span", { style: "font-size:18px;width:26px;flex:none;text-align:center", text: k.on ? "✅" : "➖" }),
              el("div", { class: "grow" }, k.name, el("small", { text: k.use })),
              el("span", { class: "muted", style: "font-size:22px", text: "›" })));
          }
        };
        panel({ op: "agent_keys" }).then((r) => {
          if (r.t === "done") return fill(r.keys);
          list.innerHTML = "";
          list.append(el("p", { class: "status", style: "padding:8px 0", text: "⚠️ " + (r.text || "Список ключей не открылся.")
            + " Список ведёт служба «🛠 Claude» — если она не отвечает, ключи поиска, видео и трендов есть в их карточках («🤖 Помощник»)." }));
        }).catch((e) => { list.innerHTML = ""; list.append(el("p", { class: "status", style: "padding:8px 0", text: problem(e) })); });
      });
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

    // the search's own keys: Exa (a search made for AI: the pages' text with the results), Groq (its web search beside)
    const KEYS = {
      exa: { name: "Exa", hint: "бесплатно, лучше поиск", site: "dashboard.exa.ai", url: "https://dashboard.exa.ai/api-keys", ph: "ключ Exa",
        about: "С ключом Exa помощник ищет ещё и в Exa — поиске, сделанном для ИИ: он сразу отдаёт текст страниц, поэтому ответы "
          + "точнее и быстрее. Бесплатно: $10 в месяц (это больше тысячи поисков), карта не нужна.",
        steps: ["Нажмите «🔑 Кабинет Exa» ниже — в браузере откроется сайт Exa (dashboard.exa.ai). Войдите через Google или почту.",
          "На сайте Exa откроется раздел «API Keys». Ключ там уже есть — нажмите значок копирования рядом с ним. Если ключа нет — нажмите «Create Key», затем скопируйте его."] },
      groq: { name: "Groq", hint: "по желанию", site: "console.groq.com", url: "https://console.groq.com/keys", ph: "ключ Groq (gsk_…)",
        about: "С ключом Groq к каждому поиску добавляется ещё и его поиск — ответы полнее. Бесплатно. По правилам Groq им пользуются не из России.",
        steps: ["Нажмите «🔑 Кабинет Groq» ниже — в браузере откроется сайт Groq (console.groq.com). Войдите через Google или почту.",
          "На сайте Groq: слева «API Keys» → кнопка «Create API Key» → любое имя → «Submit». Нажмите «Copy» — ключ начинается с gsk_."] },
    };
    function keySheet(kind, v, fill) {
      const k = KEYS[kind], on = !!(v[kind] || {}).key;
      sheet(`🔑 ${k.name} — ещё один поиск`, (box, close) => {
        const inp = el("input", { class: "input", placeholder: k.ph, autocomplete: "off", spellcheck: "false" });
        box.append(
          el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 10px", text: "Помощник и без этого ищет в интернете сам. " + k.about }),
          el("ol", { style: "margin:0 0 12px;padding-left:20px;font-size:15px;line-height:1.5" },
            ...k.steps.map((s) => el("li", { text: s })),
            el("li", { text: "Вернитесь в это приложение, вставьте ключ сюда и нажмите «✅ " + (on ? "Заменить ключ" : "Подключить") + "». В чаты ключ не присылайте." })),
          el("a", { class: "btn line wide", href: k.url, target: "_blank", rel: "noopener",
            style: "display:block;text-align:center;text-decoration:none;margin-bottom:10px", text: `🔑 Кабинет ${k.name}` }),
          inp,
          el("button", { class: "btn soft wide", style: "margin-top:8px", text: "📋 Вставить из буфера", onclick: async () => {
            let t = "";
            try { t = Native && Native.clipboard ? Native.clipboard() : await navigator.clipboard.readText(); } catch (e) { /* no access */ }
            if (t) inp.value = t.trim(); else toast("В буфере ничего нет — вставьте вручную");
          } }),
          el("button", { class: "btn wide", style: "margin-top:8px", text: "✅ " + (on ? "Заменить ключ" : "Подключить"), onclick: async (e) => {
            const b = e.currentTarget;
            if (!inp.value.trim()) { toast("Сначала вставьте ключ"); return; }
            busyBtn(b, "⏳ Проверяю ключ…");
            try {
              const end = await panel({ op: kind + "_set", key: inp.value.trim() });
              if (end.t !== "done") { toast("⚠️ " + end.text, 6000); freeBtn(b); return; }
              close(); fill(end); toast(`✅ ${k.name} подключён — помощник ищет и через него`, 5000);
            } catch (x) { toast(problem(x)); freeBtn(b); }
          } }),
          on ? el("button", { class: "btn line wide", style: "margin-top:8px", text: `Отключить ${k.name}`, onclick: async (e) => {
            const b = e.currentTarget;
            busyBtn(b, "⏳ Отключаю…");
            try {
              const end = await panel({ op: kind + "_off" });
              if (end.t !== "done") { toast("⚠️ " + end.text, 6000); freeBtn(b); return; }
              close(); fill(end); toast(`${k.name} отключён — поиск идёт без него`);
            } catch (x) { toast(problem(x)); freeBtn(b); }
          } }) : "");
      });
    }

    // ---- «🔥 Тренды»: the formats people film most on Instagram now (the server looks once a day), with their proof ----
    const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
    const dayRu = (iso) => { const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(iso || ""); return m ? `${+m[3]} ${MONTHS[+m[2] - 1]}` : iso || ""; };
    const daysRu = (n) => n + " " + (n % 10 === 1 && n % 100 !== 11 ? "день" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "дня" : "дней");
    const coverrBad = (c) => !!(c.on && c.last && /ключ/.test(c.last.error || ""));  // the key refused: a new one is needed
    function trendsCard() {
      const card = el("div", { class: "card", style: "margin:0 0 12px" }, el("small", { text: "🔥 Тренды: проверяю…" }));
      const fill = (v) => {
        card.innerHTML = "";
        const top = v.top || [];
        const when = v.at ? "Проверено " + ago(v.at) + " назад" : "Ещё не проверялось";
        const c = v.coverr || {};
        card.append(el("div", { class: "row" },
          el("div", { class: "grow" }, "🔥 Тренды Instagram" + (top.length ? " · " + top.length : ""),
            el("small", { text: (top.length ? top.map((t) => t.title).join(", ") + ". " : "Пока нет подтверждённых трендов. ") + when + "."
              + (coverrBad(c) ? " ⚠️ Coverr: нужен новый ключ." : c.on ? " Новые ролики — с Coverr." : "") }),
            v.error ? el("small", { style: "display:block;margin-top:4px;color:var(--danger-ink)", text: "⚠️ Последняя проверка: " + v.error }) : null),
          el("button", { class: "btn line", style: "flex:none;padding:8px 14px", text: "Подробнее", onclick: () => trendsSheet(v, fill) })));
      };
      panel({ op: "trends_get" }).then((v) => (v.t === "done" ? fill(v) : card.remove())).catch(() => card.remove());
      return card;
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
            + (u.until ? ` · ⏰ гость до ${when(u.until)}, потом выключится сам` : "") }));
        const kinds = [["hy2", "Hysteria", "основной, быстрый (UDP)"],
          ["obfs", "Маскировка", "Hysteria с маскировкой salamander: если обычный режут, пакеты выглядят как шум. Winger берёт его сам"],
          ["vless", "VLESS", "запасной, когда режут UDP"],
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
      sub: () => ({ server: "состояние, мосты, удалённый доступ", vpn: "выдача VPN: ссылки и QR", app: "кто пользуется помощником", claude: "Claude Code на вашем сервере" })[part],
      buttons: () => (open ? [["🔄", "Обновить", load]] : []),
      onShow: () => (open ? load() : enter()) };
  }
  return vpnView;
})
