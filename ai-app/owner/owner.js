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
    const cache = { server: null, vpn: null, app: null, alerts: null };
    const OPS = { server: "status", vpn: "users", app: "app_list" };
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
        const [end, ev] = await Promise.all([panel({ op: OPS[want] }), want === "server" ? panel({ op: "alerts", since: 0 }) : null]);
        if (end.t !== "done") throw new HttpError(500, end.text);
        cache[want] = end;
        if (ev && ev.t === "done") cache.alerts = ev.alerts.slice().reverse();
        if (part === want) draw();
      } catch (e) { if (!cache[want]) { draw(); scroll.append(el("p", { class: "status", style: "padding:12px", text: problem(e) })); } else toast(problem(e)); }
    }
    function draw() {
      scroll.innerHTML = "";
      const seg = el("div", { class: "seg", style: "margin-bottom:12px" });
      for (const [k, v] of [["server", "🖥 Сервер"], ["vpn", "🛡 VPN"], ["app", "🤖 Приложение"]]) {
        seg.append(el("button", { class: k === part ? "on" : "", text: v, onclick: () => { part = k; store.set("accessPart", k); refreshTop(); draw(); load(); } }));
      }
      scroll.append(seg);
      data = cache[part];
      if (!data) return;
      if (part === "app") return drawApp(data);
      if (part === "server") return drawServer(data);
      const on = data.users.filter((u) => u.online).length;
      const head = el("div", { class: "card" },
        el("div", { class: "row" }, el("div", { class: "grow" }, (data.vpn ? "🟢 VPN работает" : "🔴 VPN не работает") + " · " + data.host,
          el("small", { text: data.stats ? `Людей: ${data.users.length}, сейчас в сети: ${on}` : `Людей: ${data.users.length}` }))));
      if (data.vless !== null) head.append(el("div", { class: "row" }, el("div", { class: "grow" }, (data.vless ? "🟢" : "🔴") + " Запасной VLESS (TCP 443)",
        el("small", { text: "Когда Hysteria режут, работает он" }))));
      if (data.tg !== null && data.tg !== undefined) head.append(el("div", { class: "row" }, el("div", { class: "grow" }, (data.tg ? "🟢" : "🔴") + " Telegram без VPN",
        el("small", { text: "Для iPhone и компьютеров: ссылка — в карточке человека и в ссылке «VPN и Telegram»" }))));
      scroll.append(head, diskRow(), el("button", { class: "btn wide", style: "margin:0 0 8px", text: "➕ Выдать VPN", onclick: add }),
        el("button", { class: "btn line wide", style: "margin:0 0 12px", text: "🔗 Ссылка на приложение Winger VPN (24 ч)",
          onclick: () => makeLink({ op: "dl_vpnapp" }, "Приложение Winger VPN") }));
      const list = el("div", { class: "card" }, el("h3", { text: "Кому выдан" }));
      for (const u of data.users) {
        list.append(el("div", { class: "row", style: "cursor:pointer", onclick: () => card(u.name) },
          el("span", { style: "font-size:20px", text: u.online ? "🟢" : "⚪" }),
          el("div", { class: "grow" }, u.name + (u.owner ? " 👑" : ""),
            el("small", { text: (u.online ? `в сети, подключений: ${u.online}` : "не в сети") + (u.tx || u.rx ? ` · ↓${bytes(u.tx)} ↑${bytes(u.rx)}` : "")
              + (u.until ? " · ⏰ гость до " + when(u.until) : "") })),
          u.owner ? null : el("button", { class: "icon-btn", title: "Удалить", text: "🗑", onclick: (e) => { e.stopPropagation(); delVpn(u.name); } }),
          "›"));
      }
      scroll.append(list, el("div", { style: "font-size:13px;color:var(--muted);padding:0 4px 12px",
        text: "Удалить — 🗑 в строке человека: его VPN сразу перестанет работать. Все добавления и удаления видны в «🖥 Сервер» → «События»." }));
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
          el("button", { class: "btn" + (d.on ? " line" : ""), style: "flex:none;padding:8px 14px", text: d.on ? "⚙️" : "Подключить",
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
    function updateCard(u) {
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
        row.append(el("button", { class: "btn line", text: "🔎 Проверить", onclick: async () => {
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
      const brOk = d.bridges.length - brBad.length;
      scroll.append(el("div", { class: "stats" },
        stat("VPN", d.vpn.ok ? "работает" : "не работает", d.vpn.ok && d.vpn.since ? dur(d.vpn.since) + " без перерыва" : UNIT[d.vpn.state] || d.vpn.state, undefined, !d.vpn.ok),
        stat("Мосты", d.bridges.length ? `${brOk} из ${d.bridges.length}` : "нет", brBad.length ? "есть неработающие" : "", undefined, brBad.length > 0),
        stat("Память", `${Math.round(100 * d.mem[0] / d.mem[1])}%`, `${(d.mem[0] / 1024).toFixed(1)} из ${(d.mem[1] / 1024).toFixed(1)} ГБ`, 100 * d.mem[0] / d.mem[1]),
        stat("Диск", `${Math.round(100 * d.disk[0] / d.disk[1])}%`, `${d.disk[0]} из ${d.disk[1]} ГБ`, 100 * d.disk[0] / d.disk[1]),
        stat("Нагрузка", `${Math.round(100 * d.load[0] / d.cpus)}%`, `ядер: ${d.cpus} · работает ${dur(d.uptime)}`, 100 * d.load[0] / d.cpus),
        stat("Сертификат", d.cert_days !== null ? `ещё ${d.cert_days} дн.` : "?", "продлевается сам", undefined, d.cert_days !== null && d.cert_days < 10)));
      if (host) drawHosting(host);
      if (d.update) scroll.append(updateCard(d.update));
      // what takes the memory and the processor: the VPN and the assistant apart
      if (d.services && d.services.length) {
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
      // bridges
      if (d.bridges.length) {
        const card = el("div", { class: "card" }, el("h3", { text: "🌉 Мосты" }));
        for (const b of d.bridges) {
          card.append(el("div", { class: "row" }, el("span", { style: "font-size:18px", text: b.ok ? "🟢" : "🔴" }),
            el("div", { class: "grow" }, b.label, el("small", { text: (b.ok ? "работает " + dur(b.since) : UNIT[b.state] || b.state) + (+b.restarts ? ` · перезапусков: ${b.restarts}` : "") })),
            b.link ? el("button", { class: "icon-btn", title: "Ссылка", text: "🔗", onclick: () => bridgeLink(b) }) : null,
            el("button", { class: "icon-btn", title: "Перезапустить", text: "🔄", onclick: async () => {
              if (await confirmBox(`Перезапустить «${b.label}»? Ссылка останется прежней.`, "Перезапустить")) {
                act({ op: "bridge_restart", id: b.id }, "🔄 Перезапускаю мост…");
              }
            } })));
        }
        const st = d.selftest;
        card.append(el("div", { style: "font-size:13px;color:var(--muted);margin:8px 0", text: !st ? "Автопроверка моста: ещё не было"
          : st.ok ? `Проверка ${when(st.ts)}: ✓ ${st.mbit} Мбит/с, выход ${st.ip}` : `Проверка ${when(st.ts)}: ✗ ${st.err}` }),
          el("div", { class: "big-actions" },
            el("button", { class: "btn line", text: "🧪 Проверить", onclick: () => act({ op: "bridge_test" }, null, (r) => toast(r.selftest && r.selftest.ok ? `✓ Мост работает: ${r.selftest.mbit} Мбит/с` : "✗ Проверка не прошла", 5000)) }),
            el("button", { class: "btn line", text: "✉️ Тест почты", onclick: () => act({ op: "mail_test" }, null, (r) => toast("✉️ Письмо ушло" + (r.to ? " на " + r.to : ""), 5000)) })));
        scroll.append(card);
      }
      scroll.append(trafficCard(), eventsCard(), actionsCard(d));
    }
    function trafficCard() {
      const card = el("div", { class: "card" }, el("h3", { text: "📊 Трафик" }), el("div", { class: "status", text: "…" }));
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
        card.append(el("div", { class: "event " + a.kind + (a.ts > seen && a.kind !== "log" ? " new" : "") },
          el("small", { text: when(a.ts) }), el("div", { text: a.text })));
      }
      if (items.length) store.set("alertsSeen", items[0].ts);
      badge(0);
      return card;
    }
    function actionsCard(d) {
      return el("div", { class: "card" }, el("h3", { text: "⚙️ Сервер" }),
        el("button", { class: "btn line wide", text: "⚡ Скорость сервера", onclick: () => act({ op: "speed" }, null, (r) => toast(`⚡ Скорость сервера: ${r.mbit} Мбит/с`, 6000)) }),
        el("button", { class: "btn line wide", style: "margin-top:8px", text: "💾 Резервная копия сейчас", onclick: async () => {
          if (await confirmBox("Сделать резервную копию сейчас? Через минуту-две она ляжет на Яндекс Диск (папка «Семейный сервер — копии»), а без Диска придёт на почту.", "Сделать")) act({ op: "backup" }, "💾 Делаю копию — на Яндекс Диск");
        } }),
        el("button", { class: "btn line wide danger", style: "margin-top:8px", text: "♻️ Перезагрузить сервер", onclick: async () => {
          if (await confirmBox("Перезагрузить сервер? VPN, мосты и помощник пропадут примерно на минуту.", "Перезагрузить")) act({ op: "reboot" }, "♻️ Перезагружаюсь, вернусь через минуту");
        } }),
        el("div", { style: "font-size:13px;color:var(--muted);margin-top:10px", text: d.mail ? "Сбои приходят уведомлением и письмом на почту." : "Почта для оповещений не настроена." }));
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
    function bridgeLink(b) {
      sheet("🔗 " + b.label, (box) => {
        box.append(el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 10px", text: "Ссылку вставляют в приложение моста (whitelist-bypass) на этом устройстве." }),
          el("div", { style: "font:12px ui-monospace,monospace;word-break:break-all;background:var(--card);border-radius:10px;padding:10px;margin-bottom:10px", text: b.link }),
          el("div", { class: "big-actions" },
            el("button", { class: "btn", text: "📋 Копировать", onclick: () => copyText(b.link) }),
            el("button", { class: "btn line", text: "📤 Поделиться", onclick: () => (navigator.share ? navigator.share({ text: b.link }).catch(() => copyText(b.link)) : copyText(b.link)) })));
      });
    }

    // the AI app's people: add, send the app and a sign-in code, no limits, switch off, sign out, delete
    function drawApp(d) {
      scroll.append(diskRow(), maxCard(), el("button", { class: "btn wide", style: "margin:0 0 8px", text: "➕ Добавить человека", onclick: addPerson }),
        el("button", { class: "btn line wide", style: "margin:0 0 12px", text: "🔗 Ссылка на ИИ-приложение (24 ч)",
          onclick: () => makeLink({ op: "dl_aiapp" }, "ИИ-помощник") }));
      const list = el("div", { class: "card" }, el("h3", { text: "Кто пользуется приложением" }));
      for (const u of d.users) {
        const now = u.seen && Date.now() / 1000 - u.seen < 900;
        list.append(el("div", { class: "row", style: "cursor:pointer", onclick: () => person(u.id) },
          el("span", { style: "font-size:20px", text: u.off ? "⏸" : now ? "🟢" : "⚪" }),
          el("div", { class: "grow" }, u.name + (u.id === d.me ? " · вы" : ""),
            el("small", { text: u.off ? "доступ отключён" : !u.seen ? "ещё не входил(а)" + (u.codes ? " · код отправлен" : "")
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
        if (!end.on) { toast("Сначала подключите бота MAX: «Приложение» → «💬 Помощник в MAX»", 5000); return; }
        sheet("💬 MAX — " + u.name, (box) => box.append(
          el("div", { style: "font-size:14px;color:var(--muted);margin:-6px 0 10px", text: "Отправьте это сообщение человеку как удобно. Код одноразовый." }),
          el("div", { style: "font:15px/1.45 system-ui,sans-serif;white-space:pre-wrap;background:var(--card);border-radius:12px;padding:12px;margin-bottom:12px;user-select:all", text: end.text }),
          el("button", { class: "btn wide", text: "📋 Копировать сообщение", onclick: () => { copyText(end.text); toast("✅ Скопировано — отправьте как удобно"); } })));
      } catch (e) { toast(problem(e)); }
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
          el("button", { class: "btn" + (m.on ? " line" : ""), style: "flex:none;padding:8px 14px", text: m.on ? "⚙️" : "Подключить", onclick: () => maxSetup(m, fill) })));
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
            el("li", { text: "В MAX для партнёров (нужен подтверждённый профиль ИП или самозанятого) создайте чат-бота." }),
            el("li", { text: "Скопируйте токен бота и вставьте сюда." }),
            el("li", { text: "Людям — «💬 Код для помощника в MAX» в их карточке: они отправят код боту и смогут писать." })),
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
      sheet((u.off ? "⏸ " : "🤖 ") + u.name, (box, close) => {
        const act = (label, fn, cls) => el("button", { class: "btn wide " + (cls || "line"), style: "margin-top:8px", text: label, onclick: async () => { close(); await fn(); } });
        box.append(el("div", { style: "color:var(--muted);font-size:14px;margin:-6px 0 6px",
          text: (u.off ? "Доступ отключён" : !u.seen ? "Ещё не входил(а)" : "Был(а) " + ago(u.seen) + " назад") + ` · телефонов: ${u.devices}` }),
          el("div", { style: "font-size:14px;margin-bottom:6px", text: `Сегодня: вопросов ${t.text || 0}${lim("text")}, картинок ${t.draw || 0}${lim("draw")}, фото ${t.photo || 0}${lim("photo")}` }),
          act(mine ? "🔗 Ссылка: приложение + код для второго телефона (24 ч)" : "🔗 Ссылка: приложение + код входа (24 ч)",
            () => makeLink({ op: "dl_aiapp", id: u.id }, "ИИ-помощник — " + u.name), ""),
          act("💬 Код для помощника в MAX", () => maxCode(u)));
        if (mine) {
          box.append(el("div", { style: "font-size:13px;color:var(--muted);margin-top:10px", text: "Это вы. Свой вход здесь не удаляется, чтобы не потерять управление. Новый телефон — ссылка выше; если потеряли все телефоны — на экране входа «✉️ Я владелец — прислать код на почту»." }));
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
      if (!(await confirmBox(`Новый ключ для «${u.name}»? Старое подключение сразу перестанет работать (например, если телефон потерян или ссылка ушла не тому). Потом отправьте человеку новую ссылку.`, "Сменить ключ"))) return;
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
          text: (u.online ? `🟢 в сети, подключений: ${u.online}` : "⚪ не в сети") + ` · ↓${bytes(u.tx)} ↑${bytes(u.rx)}`
            + (u.until ? ` · ⏰ гость до ${when(u.until)}, потом выключится сам` : "") }));
        const kinds = [["hy2", "Hysteria", "основной, быстрый (UDP)"], ["vless", "VLESS", "запасной, когда режут UDP"],
          ["tg", "Telegram", "Telegram без VPN: iPhone, компьютер, любой телефон (ключ общий для всех)"]].filter((k) => u.links[k[0]]);
        const pane = el("div");
        const chips = el("div", { class: "chips", style: "margin-bottom:10px" });
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
        if (kinds.length > 1) box.append(chips);
        box.append(pane);
        pick(kinds[0]);
        if (u.links.hy2) {
          // Winger made for this person: the connection is inside, they only press the big button
          box.append(el("button", { class: "btn wide", style: "margin-top:14px", text: "📲 Winger с подключением + Telegram — ссылка (24 ч)",
            onclick: () => { close(); makeLink({ op: "dl_vpnlink", name: u.name }, "VPN и Telegram — " + u.name); } }));
        }
        box.append(el("div", { class: "big-actions", style: "margin-top:8px" },
          el("button", { class: "btn line", text: "🔄 Новый ключ", onclick: () => { close(); rekey(u); } }),
          u.owner ? null : el("button", { class: "btn line", text: u.until ? "⏰ Срок" : "⏰ Сделать гостем", onclick: () => { close(); guestDays(u); } })));
        if (!u.owner) {
          box.append(el("button", { class: "btn line wide", style: "margin-top:14px;color:var(--danger)", text: "🗑 Удалить", onclick: () => { close(); delVpn(u.name); } }));
        }
      });
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
      sub: () => ({ server: "состояние, мосты, события", vpn: "выдача VPN: ссылки и QR", app: "кто пользуется приложением" })[part],
      buttons: () => (open ? [["🔄", "Обновить", load]] : []),
      onShow: () => (open ? load() : enter()) };
  }
  return vpnView;
})
