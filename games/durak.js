/* Дурак — подкидной on 36 cards against the computer, at a felt table under a lamp, the aurora in the window.
   Classic rules: the bottom card of the deck is trump; the lowest trump leads; the defender beats each card with a
   higher one of its suit or with a trump, or takes; the attacker adds cards of ranks already on the table — at most 6
   and never more than the defender held when the bout began; after the bout the attacker draws up to six first.
   «Лига»: ten opponents, each a series to two wins; «Свободная игра»: wins in a row at the chosen level.
   The card art lives in reg-durak.js (WG.durakArt). Written against the Winger Games engine (ENGINE.md). */
"use strict";
(function () {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;

  // ======================================================================= the rules
  const suitOf = (c) => (c / 9) | 0, rankOf = (c) => (c % 9) + 6;
  const beats = (a, d, tr) => (suitOf(a) === suitOf(d) ? d > a : suitOf(d) === tr);
  const val = (c, tr) => rankOf(c) + (suitOf(c) === tr ? 9 : 0);
  const rm = (arr, c) => { const i = arr.indexOf(c); if (i >= 0) arr.splice(i, 1); };
  function ranksOn(G) { const s = new Set(); for (const p of G.table) { s.add(rankOf(p.a)); if (p.d !== null) s.add(rankOf(p.d)); } return s; }
  function canAdd(G) {
    if (G.table.length >= G.limit) return false;
    const rs = ranksOn(G);
    return G.hands[G.att].some((c) => rs.has(rankOf(c)));
  }
  const mover = (G) => (G.phase === "defend" ? 1 - G.att : G.att);

  function newGame(rnd) {
    const deck = [];
    for (let i = 0; i < 36; i++) deck.push(i);
    for (let i = 35; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const x = deck[i]; deck[i] = deck[j]; deck[j] = x; }
    // deck[0] is the bottom card: the trump, face up, drawn last
    const G = { deck, trumpCard: deck[0], trump: suitOf(deck[0]), hands: [[], []], table: [], discard: [], att: 0, phase: "attack",
      limit: 6, took: [0, 0], seen: [new Set(), new Set()], winner: null, bouts: 0, order: [], moves: 0 };
    for (let i = 0; i < 6; i++) for (const p of [0, 1]) { const c = deck.pop(); G.hands[p].push(c); G.order.push(c); }
    const low = [99, 99];
    for (const p of [0, 1]) for (const c of G.hands[p]) if (suitOf(c) === G.trump) low[p] = Math.min(low[p], c);
    G.att = low[0] < low[1] ? 0 : low[1] < low[0] ? 1 : rnd() < 0.5 ? 0 : 1;
    G.lowTrump = Math.min(low[0], low[1]) < 99 ? Math.min(low[0], low[1]) : null;
    return G;
  }
  function legal(G) {
    const att = G.att, def = 1 - att, H = G.hands, out = [];
    if (G.phase === "defend") {
      const a = G.table[G.table.length - 1].a;
      for (const c of H[def]) if (beats(a, c, G.trump)) out.push({ t: "card", c });
      out.push({ t: "take" });
    } else if (G.phase === "attack" && !G.table.length) {
      for (const c of H[att]) out.push({ t: "card", c });
    } else if (G.phase === "attack" || G.phase === "add") {
      const rs = ranksOn(G);
      if (G.table.length < G.limit) for (const c of H[att]) if (rs.has(rankOf(c))) out.push({ t: "card", c });
      out.push({ t: "pass" });
    }
    return out;
  }
  // the bout ends: the table goes to the discard or to the defender; the attacker draws first, then the defender
  function endBout(G, took, ev) {
    const att = G.att, def = 1 - att, cards = [];
    for (const p of G.table) { cards.push(p.a); if (p.d !== null) cards.push(p.d); }
    G.table = [];
    if (took) { for (const c of cards) { G.hands[def].push(c); G.seen[def].add(c); } G.took[def]++; ev.push({ t: "took", cards, who: def }); }
    else { for (const c of cards) G.discard.push(c); ev.push({ t: "bito", cards }); }
    for (const p of [att, def]) while (G.hands[p].length < 6 && G.deck.length) {
      const c = G.deck.pop();
      G.hands[p].push(c);
      if (c === G.trumpCard) G.seen[p].add(c);
      ev.push({ t: "draw", c, who: p });
    }
    G.bouts++;
    if (!took) G.att = def;
    G.phase = "attack";
    if (!G.deck.length) {
      const e0 = !G.hands[0].length, e1 = !G.hands[1].length;
      if (e0 || e1) { G.phase = "over"; G.winner = e0 && e1 ? -1 : e0 ? 0 : 1; ev.push({ t: "over", winner: G.winner }); }
    }
  }
  function apply(G, m) {
    const ev = [], att = G.att, def = 1 - att, who = mover(G);
    G.moves++;
    if (m.t === "card") {
      rm(G.hands[who], m.c); G.seen[who].delete(m.c);
      if (G.phase === "defend") {
        const a = G.table[G.table.length - 1].a;
        G.table[G.table.length - 1].d = m.c;
        ev.push({ t: "beat", c: m.c, a, who, trump: suitOf(m.c) === G.trump && suitOf(a) !== G.trump });
        if (!G.hands[def].length || !G.hands[att].length || !canAdd(G)) endBout(G, false, ev);
        else G.phase = "attack";
      } else {
        if (!G.table.length) G.limit = Math.min(6, G.hands[def].length);
        G.table.push({ a: m.c, d: null });
        ev.push({ t: "play", c: m.c, who });
        if (G.phase === "attack") G.phase = "defend";
        else if (!canAdd(G)) endBout(G, true, ev);
      }
    } else if (m.t === "take") {
      ev.push({ t: "takes", who: def });
      G.phase = "add";
      if (!canAdd(G)) endBout(G, true, ev);
    } else if (m.t === "pass") {
      endBout(G, G.phase === "add", ev);
    }
    return ev;
  }

  // ======================================================================= the computer
  // tier 0 «Лёгкий»: any legal move; 1 «Средний»: plain sensible rules; 2 «Сложный»: remembers every card that has
  // gone and every card it saw you pick up; 3 «Мастер»: counts the odds and, once the deck is out, searches the end.
  const LEVEL_AI = {
    easy: { tier: 0, err: 0, greed: 0.5, thrift: 0.3, think: 1.15 },
    normal: { tier: 1, err: 0.08, greed: 0.6, thrift: 1, think: 0.9 },
    hard: { tier: 2, err: 0.03, greed: 0.8, thrift: 1, think: 0.7 },
    master: { tier: 3, err: 0, greed: 0.8, thrift: 1, think: 0.55 },
  };
  function adaptiveAI(s) {
    s = clamp(s, 0, 1);
    const bands = [0.22, 0.48, 0.76];
    const tier = s < bands[0] ? 0 : s < bands[1] ? 1 : s < bands[2] ? 2 : 3;
    const lo = [0, 0.22, 0.48, 0.76][tier], hi = [0.22, 0.48, 0.76, 1.01][tier];
    return { tier, err: tier ? clamp((hi - s) / (hi - lo), 0, 1) * 0.22 : 0, greed: 0.7, thrift: 1, think: lerp(1.1, 0.5, s), skill: s };
  }
  function unknownPool(G, me, memory) {
    const opp = 1 - me, known = new Set(G.hands[me]);
    if (memory) { for (const c of G.discard) known.add(c); for (const c of G.seen[opp]) known.add(c); }
    for (const p of G.table) { known.add(p.a); if (p.d !== null) known.add(p.d); }
    if (G.deck.length) known.add(G.trumpCard);
    const pool = [];
    for (let c = 0; c < 36; c++) if (!known.has(c)) pool.push(c);
    return pool;
  }
  // the chance that the other player holds a card that beats c
  function pBeats(G, me, c, pool, memory) {
    const opp = 1 - me;
    let known = 0;
    if (memory) for (const k of G.seen[opp]) { known++; if (beats(c, k, G.trump)) return 1; }
    const k = G.hands[opp].length - known;
    if (k <= 0) return 0;
    const u = pool.length;
    let b = 0;
    for (const x of pool) if (beats(c, x, G.trump)) b++;
    if (!b) return 0;
    if (k >= u) return 1;
    let none = 1;
    for (let i = 0; i < k; i++) none *= Math.max(0, (u - b - i) / (u - i));
    return 1 - none;
  }
  function randomMove(G, moves, rnd) {
    const cards = moves.filter((m) => m.t === "card"), other = moves.find((m) => m.t !== "card");
    if (G.phase === "defend") return cards.length && rnd() < 0.85 ? cards[Math.floor(rnd() * cards.length)] : other;
    if (!cards.length) return other;
    if (other && rnd() < 0.45) return other;
    return cards[Math.floor(rnd() * cards.length)];
  }
  function plainMove(G, me, P, moves) {
    const tr = G.trump, deck = G.deck.length;
    const cards = moves.filter((m) => m.t === "card").map((m) => m.c).sort((a, b) => val(a, tr) - val(b, tr));
    const isT = (c) => suitOf(c) === tr;
    if (G.phase === "attack" && !G.table.length) {
      const hand = G.hands[me];
      let best = cards[0], bs = 1e9;
      for (const c of cards) {
        const dup = hand.filter((x) => rankOf(x) === rankOf(c)).length - 1;
        const s = val(c, tr) - dup * 1.5 + (isT(c) ? 4 : 0);
        if (s < bs) { bs = s; best = c; }
      }
      return { t: "card", c: best };
    }
    if (G.phase === "attack" || G.phase === "add") {
      const lim = deck ? 10 + P.greed * 1.5 : 14;
      const c = cards.find((x) => !isT(x) && rankOf(x) <= lim);
      return c !== undefined ? { t: "card", c } : { t: "pass" };
    }
    // defend: the cheapest card that beats; an early high trump on a small card is not worth it
    if (!cards.length) return { t: "take" };
    const c = cards[0], a = G.table[G.table.length - 1].a;
    if (isT(c) && !isT(a) && deck > 8 && rankOf(c) >= 12 - Math.round(P.thrift) && rankOf(a) <= 9 && G.table.length <= 2) return { t: "take" };
    return { t: "card", c };
  }
  function smartMove(G, me, P, moves) {
    const tr = G.trump, opp = 1 - me, deck = G.deck.length, memory = P.tier >= 2;
    const K = Object.assign({ lead: 8, take: 7.5, pick: 2.5, tw: 0.25, thr: 21 }, P.k || {});
    const pool = unknownPool(G, me, memory);
    const exact = P.tier >= 3;
    const pb = (c) => {
      const p = pBeats(G, me, c, pool, memory);
      return exact ? p : p > 0.97 ? 1 : p < 0.03 ? 0 : 0.25 + p * 0.5; // the hard one only roughly weighs the odds
    };
    const late = deck === 0 ? 1 : deck <= 6 ? 0.5 : 0;
    const hand = G.hands[me];
    const cards = moves.filter((m) => m.t === "card").map((m) => m.c);
    const isT = (c) => suitOf(c) === tr;
    const dup = (c) => hand.filter((x) => rankOf(x) === rankOf(c)).length - 1;
    const oppN = G.hands[opp].length;
    if (G.phase === "attack" && !G.table.length) {
      let best = cards[0], bs = 1e9;
      for (const c of cards) {
        let s = val(c, tr) - 1.6 * dup(c);
        if (isT(c)) s += 4 + (deck / 24) * 8 * P.thrift;
        s -= late * K.lead * (1 - pb(c));
        if (!deck && oppN <= 2) s -= 10 * (1 - pb(c));
        if (s < bs) { bs = s; best = c; }
      }
      return { t: "card", c: best };
    }
    if (G.phase === "attack" || G.phase === "add") {
      let best = null, bs = 1e9;
      const adding = G.phase === "add";
      for (const c of cards) {
        let s = val(c, tr);
        if (isT(c)) s += 5 + (deck / 24) * 10 * P.thrift;
        if (!adding) s -= (1 - pb(c)) * 4 * late;
        // early, only small change goes on the table; late, anything the other side has to take is a gift
        const thr = K.thr + P.greed + late * (adding ? 6 : 7) - (hand.length <= 2 && deck ? 3 : 0) - (adding && deck ? 1 : 0);
        if (s <= thr && s < bs) { bs = s; best = c; }
      }
      return best !== null ? { t: "card", c: best } : { t: "pass" };
    }
    // defend
    const a = G.table[G.table.length - 1].a;
    const on = ranksOn(G);
    let best = null, bc = 1e9;
    for (const c of cards) {
      let cost = (val(c, tr) - val(a, tr)) * K.tw;
      if (isT(c)) cost += P.thrift * (2 + deck / 4) + Math.max(0, val(c, tr) - 15) * 0.4;
      if (!on.has(rankOf(c)) && G.table.length < G.limit) {
        // a new rank on the table: how many of them might come back at me
        let n = 0;
        for (const x of pool) if (rankOf(x) === rankOf(c) && x !== c) n += memory ? Math.min(1, oppN / Math.max(1, pool.length)) : 0.3;
        if (memory) for (const x of G.seen[opp]) if (rankOf(x) === rankOf(c)) n += 1;
        cost += n * 0.8;
      }
      if (cost < bc) { bc = cost; best = c; }
    }
    if (best === null) return { t: "take" };
    const picked = G.table.length * 2 - 1;
    const take = K.take + picked * K.pick + (deck === 0 ? 14 : deck < 6 ? 6 : 0) + (hand.length >= 8 ? 3 : 0);
    return bc > take ? { t: "take" } : { t: "card", c: best };
  }

  // ---- the end with the deck gone: both hands are known by counting, so the master searches it out ----
  function searchMove(G, me, budget) {
    const opp = 1 - me;
    const pool = unknownPool(G, me, true);
    const oh = [...G.seen[opp], ...pool];
    if (oh.length !== G.hands[opp].length) return null;
    const tr = G.trump;
    const root = { h: [null, null], t: G.table.map((p) => [p.a, p.d]), att: G.att, ph: G.phase, lim: G.limit, over: null };
    root.h[me] = G.hands[me].slice(); root.h[opp] = oh;
    let nodes = 0, aborted = false;
    const sRanks = (N) => { const s = new Set(); for (const p of N.t) { s.add(rankOf(p[0])); if (p[1] !== null) s.add(rankOf(p[1])); } return s; };
    const sCanAdd = (N) => { if (N.t.length >= N.lim) return false; const rs = sRanks(N); return N.h[N.att].some((c) => rs.has(rankOf(c))); };
    function sEnd(N, took) {
      const att = N.att, def = 1 - att;
      if (took) for (const p of N.t) { N.h[def].push(p[0]); if (p[1] !== null) N.h[def].push(p[1]); }
      N.t = [];
      if (!took) N.att = def;
      N.ph = "attack";
      const e0 = !N.h[0].length, e1 = !N.h[1].length;
      if (e0 || e1) N.over = e0 && e1 ? -1 : e0 ? 0 : 1;
    }
    function next(S, m) {
      const N = { h: [S.h[0].slice(), S.h[1].slice()], t: S.t.map((p) => p.slice()), att: S.att, ph: S.ph, lim: S.lim, over: null };
      const att = N.att, def = 1 - att;
      if (m.t === "card") {
        if (N.ph === "defend") {
          rm(N.h[def], m.c); N.t[N.t.length - 1][1] = m.c;
          if (!N.h[def].length || !N.h[att].length || !sCanAdd(N)) sEnd(N, false); else N.ph = "attack";
        } else {
          rm(N.h[att], m.c);
          if (!N.t.length) N.lim = Math.min(6, N.h[def].length);
          N.t.push([m.c, null]); N.ph = "defend";
        }
      } else if (m.t === "addall") { for (const c of m.cs) { rm(N.h[att], c); N.t.push([c, null]); } sEnd(N, true); }
      else if (m.t === "take") { N.ph = "add"; if (!sCanAdd(N)) sEnd(N, true); }
      else sEnd(N, N.ph === "add");
      return N;
    }
    function gen(N) {
      const att = N.att, def = 1 - att, out = [];
      if (N.ph === "defend") {
        const a = N.t[N.t.length - 1][0];
        for (const c of N.h[def]) if (beats(a, c, tr)) out.push({ t: "card", c });
        out.sort((x, y) => val(x.c, tr) - val(y.c, tr));
        out.push({ t: "take" });
        return out;
      }
      const rs = sRanks(N);
      const cs = N.h[att].filter((c) => !N.t.length || rs.has(rankOf(c))).sort((x, y) => val(x, tr) - val(y, tr));
      if (N.ph === "add") {
        const room = N.lim - N.t.length;
        const all = cs.slice(0, room), soft = cs.filter((c) => suitOf(c) !== tr).slice(0, room);
        out.push({ t: "pass" });
        if (soft.length) out.push({ t: "addall", cs: soft });
        if (all.length && all.length !== soft.length) out.push({ t: "addall", cs: all });
        return out;
      }
      if (N.t.length < N.lim || !N.t.length) for (const c of cs) out.push({ t: "card", c });
      if (N.t.length) out.push({ t: "pass" });
      return out;
    }
    const evalN = (N) => {
      const avg = (h) => (h.length ? h.reduce((s, c) => s + val(c, tr), 0) / h.length : 0);
      return (N.h[opp].length - N.h[me].length) * 8 + (avg(N.h[me]) - avg(N.h[opp])) * 1.5;
    };
    function mm(N, depth, alpha, beta) {
      if (N.over !== null) return N.over === me ? 1000 + depth : N.over === -1 ? 0 : -1000 - depth;
      if (++nodes > budget) { aborted = true; return 0; }
      if (depth <= 0) return evalN(N);
      const who = N.ph === "defend" ? 1 - N.att : N.att;
      const ms = gen(N);
      if (who === me) {
        let v = -1e9;
        for (const m of ms) { v = Math.max(v, mm(next(N, m), depth - 1, alpha, beta)); if (v > alpha) alpha = v; if (alpha >= beta || aborted) break; }
        return v;
      }
      let v = 1e9;
      for (const m of ms) { v = Math.min(v, mm(next(N, m), depth - 1, alpha, beta)); if (v < beta) beta = v; if (alpha >= beta || aborted) break; }
      return v;
    }
    let best = null;
    for (let depth = 3; depth <= 60; depth += 2) {
      aborted = false;
      let bm = null, bv = -1e9;
      for (const m of gen(root)) {
        const v = mm(next(root, m), depth - 1, bv, 1e9);
        if (aborted) break;
        if (v > bv) { bv = v; bm = m; }
      }
      if (aborted) break;
      best = bm;
      if (Math.abs(bv) >= 1000) break;
    }
    if (!best) return null;
    return best.t === "addall" ? { t: "card", c: best.cs[0] } : best;
  }
  function aiMove(G, me, P, rnd) {
    const moves = legal(G);
    if (moves.length === 1) return moves[0];
    if (P.tier === 0 || rnd() < P.err) return randomMove(G, moves, rnd);
    if (P.tier >= 3 && !G.deck.length) {
      const m = searchMove(G, me, 24000);
      if (m && moves.some((x) => x.t === m.t && x.c === m.c)) return m;
    }
    if (P.tier === 1) return plainMove(G, me, P, moves);
    return smartMove(G, me, P, moves);
  }

  // ======================================================================= the opponents
  // look: a portrait drawn by code (see bust()); say: what they say at the table
  const LEAGUE = [
    { id: "petya", name: "Петька", title: "Соседский мальчишка", about: "Только учится: ходит чем попало.", ai: { tier: 0, err: 0, greed: 0.5, thrift: 0.3, think: 1.2 },
      look: { skin: "#F6CBA8", skinS: "#D69A7A", hair: "#C9702E", hairS: "#7A3D16", style: "spiky", cloth: "#22B8CF", clothS: "#0B6E8A", clothL: "#7FE6F4", collar: "stripes", freckles: true, blush: true },
      say: { hello: ["Чур, я первый!", "Давай играть!"], lead: ["Вот тебе!", "Ага!"], trump: ["Козырем — бац!"], take: ["Ой, беру…", "Ну во-от…"], ptake: ["Ха-ха, бери!"], win: ["Ура! Я выиграл!"], lose: ["Нечестно! Ещё раз!"] } },
    { id: "nyura", name: "Бабушка Нюра", short: "Баба Нюра", title: "Печёт пироги", about: "Играет по-доброму и жалеет козыри.", ai: { tier: 1, err: 0.3, greed: 0.3, thrift: 2, think: 1.25 },
      look: { skin: "#F2C29E", skinS: "#C98F70", hair: "#C9D6F2", hairS: "#8F9BB8", style: "bun", hat: "kerchief", hatC: "#D93644", hatS: "#8E1F35", cloth: "#7E1A2E", clothS: "#4A0E1C", clothL: "#C04A5E", collar: "shawl", glasses: true, blush: true },
      say: { hello: ["Садись, внучок", "Пирожок будешь?"], lead: ["Вот так, милок"], trump: ["Уж не обессудь"], take: ["Ох, возьму…", "Ай-яй-яй"], ptake: ["Бери, бери, не жалко"], win: ["Вот и славно"], lose: ["Ох, молодец какой!"] } },
    { id: "bayun", name: "Кот Баюн", title: "Мурлычет и путает", about: "Подкидывает всё, что блестит.", ai: { tier: 1, err: 0.18, greed: 1.4, thrift: 0.6, think: 0.85 },
      look: { cat: true, fur: "#9AA5C0", furS: "#5F6F93", furD: "#46516F", cloth: "#D93644", clothS: "#8E1F35", clothL: "#FF8F8F", collar: "cat" },
      say: { hello: ["Мур-р… Сдавай.", "Мяу."], lead: ["Мур!"], trump: ["Фыр-р!"], take: ["Мяу…", "Ш-ш-ш…"], ptake: ["Мур-мур-мур"], win: ["Мур-р-р!"], lose: ["Мяу?!"] } },
    { id: "gosha", name: "Дядя Гоша", title: "Шофёр", about: "Не жалеет козырей и любит подкинуть.", ai: { tier: 1, err: 0.08, greed: 1.5, thrift: 0.4, think: 0.75 },
      look: { skin: "#E8B48C", skinS: "#B97E5E", hair: "#3B2A1C", hairS: "#24170F", style: "short", hat: "cap", hatC: "#6B7694", hatS: "#3B4766", cloth: "#7A5236", clothS: "#4E3424", clothL: "#A8774D", collar: "jacket", beard: "moustache", beardC: "#3B2A1C", stubble: true },
      say: { hello: ["Ну, поехали!"], lead: ["Газуем!", "Держи подарочек"], trump: ["Козырной поворот!"], take: ["Эх, занесло…", "Ладно, беру"], ptake: ["Гружу, принимай!"], win: ["Приехали!"], lose: ["Эх, заглох…"] } },
    { id: "galya", name: "Почтальонша Галя", short: "Галя", title: "Всё помнит", about: "Помнит, какие карты уже вышли.", ai: { tier: 2, err: 0.12, greed: 0.7, thrift: 0.9, think: 0.85 },
      look: { skin: "#F6CBA8", skinS: "#D69A7A", hair: "#E0B04A", hairS: "#9A6A1C", style: "pony", hat: "postcap", hatC: "#24406B", hatS: "#142449", cloth: "#2F5A9E", clothS: "#1B3566", clothL: "#6F95D6", collar: "uniform", blush: true, lips: true },
      say: { hello: ["Вам письмо!"], lead: ["Распишитесь"], trump: ["Срочная доставка!"], take: ["Ой, не туда…"], ptake: ["Посылочка вам!"], win: ["Доставлено!"], lose: ["Адресат выбыл…"] } },
    { id: "kuzmich", name: "Боцман Кузьмич", short: "Кузьмич", title: "Морской волк", about: "Бьёт крепко, козыри бережёт до шторма.", ai: { tier: 2, err: 0.05, greed: 0.9, thrift: 1.3, think: 0.75 },
      look: { skin: "#E0A982", skinS: "#B07656", hair: "#C9D6F2", hairS: "#8F9BB8", style: "short", hat: "captain", cloth: "#1E2A52", clothS: "#0E1730", clothL: "#3B4C86", collar: "telnyashka", beard: "full", beardC: "#D7DFEB" },
      say: { hello: ["Свистать всех наверх!"], lead: ["Полундра!"], trump: ["Бортовой залп!"], take: ["Тысяча якорей…"], ptake: ["Принимай груз!"], win: ["Полный вперёд!"], lose: ["Пробоина…"] } },
    { id: "zina", name: "Тётя Зина", title: "С рынка", about: "Считает каждую карту до копейки.", ai: { tier: 3, err: 0.1, greed: 0.9, thrift: 1, think: 0.7, nosearch: true },
      look: { skin: "#F2C29E", skinS: "#C98F70", hair: "#D9622B", hairS: "#8A3412", style: "curly", cloth: "#1FA874", clothS: "#0B4A33", clothL: "#8EF0C6", collar: "dress", lips: true, blush: true, earrings: true },
      say: { hello: ["Подходи, не стесняйся!"], lead: ["Свежачок!"], trump: ["Почём козыри?"], take: ["Обвесили!"], ptake: ["Сдачи не надо!"], win: ["Торг окончен!"], lose: ["Ну и торгуешься!"] } },
    { id: "prof", name: "Профессор Звездочётов", short: "Звездочётов", title: "Учёный", about: "Считает карты и просчитывает конец.", ai: { tier: 3, err: 0.05, greed: 0.8, thrift: 1, think: 0.75 },
      look: { skin: "#F6CBA8", skinS: "#D69A7A", hair: "#EAF0FA", hairS: "#A9B6CD", style: "bald", cloth: "#7A5236", clothS: "#4E3424", clothL: "#A8774D", collar: "tweed", glasses: true, beard: "goatee", beardC: "#EAF0FA" },
      say: { hello: ["Любопытно…"], lead: ["Элементарно"], trump: ["Предсказуемо"], take: ["Погрешность…"], ptake: ["Как и ожидалось"], win: ["Что и требовалось доказать"], lose: ["Пересчитаю…"] } },
    { id: "marfa", name: "Ведунья Марфа", short: "Марфа", title: "Видит насквозь", about: "К концу игры знает всю твою руку.", ai: { tier: 3, err: 0.02, greed: 0.9, thrift: 1.1, think: 0.6 },
      look: { skin: "#E9D3C4", skinS: "#B79A8A", hair: "#1B1530", hairS: "#0A0F1E", style: "long", hat: "hood", hatC: "#4B3BA8", hatS: "#21194A", cloth: "#4B3BA8", clothS: "#21194A", clothL: "#8B7CF6", collar: "robe", glow: "#7FE6F4", lips: true },
      say: { hello: ["Вижу, вижу…"], lead: ["Карты не лгут"], trump: ["Так звёзды легли"], take: ["Тьфу-тьфу…"], ptake: ["Я это видела"], win: ["Всё сбылось"], lose: ["Не к добру…"] } },
    { id: "knyaz", name: "Князь Сияния", short: "Князь", title: "Хозяин северного неба", about: "Не ошибается. Совсем.", ai: { tier: 3, err: 0, greed: 0.9, thrift: 1, think: 0.5 },
      look: { skin: "#EFC8AA", skinS: "#C08C6E", hair: "#C9D6F2", hairS: "#6B7694", style: "long", hat: "crown", cloth: "#127A52", clothS: "#05291C", clothL: "#34D399", collar: "ermine", beard: "full", beardC: "#B9C6E4", beardS: "#7F8FB8", glow: "#34D399" },
      say: { hello: ["Сыграем под сиянием"], lead: ["Склонись"], trump: ["Небо со мной"], take: ["Любопытно…"], ptake: ["Так и должно быть"], win: ["Достойно. Для смертного"], lose: ["Достойно…"] } },
  ];
  const FREE = { easy: "petya", normal: "gosha", hard: "kuzmich", master: "prof", adaptive: "bayun" };
  const LEVEL_LINES = [
    ["easy", "Лёгкий", "ходит наугад"],
    ["normal", "Средний", "играет по правилам"],
    ["hard", "Сложный", "помнит вышедшие карты"],
    ["master", "Мастер", "считает карты до конца"],
    ["adaptive", "Подстроиться", "растёт вместе с тобой"],
  ];

  // ======================================================================= pictures
  // the opponent: head and shoulders, 32×32, drawn by code; moods: idle, happy, sad, think; blink; talk
  const busts = {};
  function bust(L, mood, blink, talk) {
    const key = (L.id || "") + "|" + mood + (blink ? "b" : "") + (talk ? "t" : "");
    if (busts[key]) return busts[key];
    const c = WG.canvas(32, 32), g = c.getContext("2d");
    const px = (x, y, col) => { g.fillStyle = col; g.fillRect(x, y, 1, 1); };
    const rect = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
    const lk = L.look;
    if (lk.cat) drawCat(g, lk, mood, blink, talk, px, rect);
    else drawPerson(g, lk, mood, blink, talk, px, rect);
    // the outline round the whole figure
    const img = g.getImageData(0, 0, 32, 32), d = img.data;
    const on = (x, y) => x >= 0 && y >= 0 && x < 32 && y < 32 && d[(y * 32 + x) * 4 + 3] > 0;
    const edge = [];
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (!on(x, y) && (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1))) edge.push([x, y]);
    g.fillStyle = "#0A0F1E";
    for (const [x, y] of edge) g.fillRect(x, y, 1, 1);
    busts[key] = c;
    return c;
  }
  function shoulders(g, lk, rect, px) {
    for (let y = 24; y < 32; y++) {
      const hw = Math.min(15, Math.round(5 + (y - 24) * 2.3));
      rect(16 - hw, y, hw * 2, 1, lk.cloth);
      rect(16 + Math.round(hw * 0.4), y, Math.max(0, hw - Math.round(hw * 0.4)), 1, lk.clothS);
      px(16 - hw, y, lk.clothL);
    }
    const col = lk.collar;
    if (col === "stripes") { for (let y = 26; y < 32; y += 2) for (let x = 0; x < 32; x++) { const hw = Math.min(15, Math.round(5 + (y - 24) * 2.3)); if (Math.abs(x + 0.5 - 16) < hw) px(x, y, x > 18 ? "#C9D6F2" : "#FFFFFF"); } rect(13, 24, 6, 1, lk.clothS); }
    else if (col === "shawl") { for (let y = 24; y < 32; y++) for (let x = 2; x < 30; x++) if ((x * 3 + y * 5) % 7 === 0 && Math.abs(x - 16) < Math.min(15, 5 + (y - 24) * 2.3) - 1) px(x, y, (x + y) % 2 ? "#FFD27A" : "#FFC2C9"); for (let y = 25; y < 31; y++) px(16, y, lk.clothS); }
    else if (col === "jacket") { for (let y = 24; y < 31; y++) { const w = Math.max(0, 5 - Math.floor((y - 24) * 0.8)); rect(16 - Math.floor(w / 2), y, w, 1, "#C9D6F2"); px(16 - Math.floor(w / 2) - 1, y, lk.clothL); } px(16, 29, "#0A0F1E"); }
    else if (col === "uniform") { for (let i = 0; i < 9; i++) px(7 + i * 2, 24 + i, "#4E3424"), px(8 + i * 2, 24 + i, "#7A5236"); px(16, 27, "#FFD27A"); px(16, 30, "#FFD27A"); rect(13, 24, 6, 1, "#EAF0FA"); }
    else if (col === "telnyashka") { for (let y = 24; y < 32; y++) { const w = Math.max(1, 7 - Math.floor((y - 24) * 0.7)); rect(16 - Math.floor(w / 2), y, w, 1, y % 2 ? "#FFFFFF" : "#2F5A9E"); } px(9, 28, "#FFD27A"); px(23, 28, "#FFD27A"); }
    else if (col === "dress") { for (let y = 25; y < 32; y++) for (let x = 2; x < 30; x++) if ((x * 5 + y * 3) % 6 === 0 && Math.abs(x - 16) < Math.min(15, 5 + (y - 24) * 2.3) - 1) { px(x, y, "#FFF0C2"); } rect(13, 24, 6, 2, lk.skinS); }
    else if (col === "tweed") { for (let y = 24; y < 32; y++) for (let x = 2; x < 30; x++) if ((x + y) % 3 === 0 && Math.abs(x - 16) < Math.min(15, 5 + (y - 24) * 2.3)) px(x, y, lk.clothS); for (let y = 24; y < 31; y++) { const w = Math.max(0, 5 - Math.floor((y - 24) * 0.8)); rect(16 - Math.floor(w / 2), y, w, 1, "#FFFDF4"); } rect(14, 24, 5, 2, "#D93644"); px(16, 24, "#8E1F35"); px(16, 25, "#8E1F35"); }
    else if (col === "robe") { for (const [x, y] of [[6, 29], [11, 27], [21, 28], [25, 30], [9, 31], [18, 30]]) px(x, y, "#C4BBFF"); px(16, 25, "#D2FAFF"); px(15, 26, "#7FE6F4"); px(17, 26, "#7FE6F4"); }
    else if (col === "ermine") { for (let y = 24; y < 28; y++) { const hw = Math.min(15, Math.round(5 + (y - 24) * 2.3)) + 1; rect(16 - hw, y, hw * 2, 1, y === 27 ? "#C9D6F2" : "#FFFFFF"); } for (const x of [8, 13, 19, 24]) px(x, 25 + (x % 2), "#0A0F1E"); px(16, 28, "#FFD27A"); px(16, 29, "#C4BBFF"); }
    else if (col === "cat") { rect(11, 24, 10, 2, "#D93644"); rect(11, 25, 10, 1, "#8E1F35"); px(15, 26, "#FFD27A"); px(16, 26, "#FFD27A"); px(15, 27, "#C98A1B"); px(16, 27, "#FFD27A"); }
  }
  function drawPerson(g, lk, mood, blink, talk, px, rect) {
    const inHead = (x, y) => { const rx = y > 15 ? 7 - (y - 15) * 0.28 : 7; const dx = (x + 0.5 - 16) / rx, dy = (y + 0.5 - 14) / 8.5; return dx * dx + dy * dy <= 1; };
    // long hair and the hood fall behind the shoulders
    if (lk.hat === "hood") { for (let y = 2; y < 30; y++) for (let x = 4; x < 28; x++) { const dx = (x + 0.5 - 16) / 11, dy = (y + 0.5 - 15) / 13; if (dx * dx + dy * dy <= 1) px(x, y, x > 18 ? lk.hatS : lk.hatC); } }
    if (lk.style === "long") { for (let y = 8; y < 28; y++) { const o = y > 22 ? Math.round((y - 22) * 0.6) : 0; rect(7 + o, y, 4 - Math.min(2, o), 1, lk.hairS); rect(21 + Math.min(2, o) - o + o, y, 4 - Math.min(2, o), 1, lk.hairS); if (y < 25) { px(8 + o, y, lk.hair); px(9 + o, y, (y % 4) ? lk.hair : lk.hairS); px(22, y, lk.hair); } } }
    shoulders(g, lk, rect, px);
    rect(13, 20, 6, 5, lk.skinS);
    rect(13, 20, 2, 4, lk.skin);
    // ears, then the head with its light from above left
    rect(8, 13, 2, 4, lk.skinS); px(8, 14, lk.skin);
    rect(22, 13, 2, 4, lk.skinS);
    for (let y = 4; y < 24; y++) for (let x = 6; x < 26; x++) {
      if (!inHead(x, y)) continue;
      let col = lk.skin;
      if (!inHead(x + 1, y) || !inHead(x + 2, y) || !inHead(x, y + 1)) col = lk.skinS;
      else if (!inHead(x - 1, y - 1) && x < 14) col = "#FFE6D2";
      px(x, y, col);
    }
    if (lk.glow) { for (let y = 5; y < 23; y++) for (let x = 7; x < 25; x++) if (inHead(x, y) && !inHead(x + 1, y)) px(x, y, lk.skinS); }
    if (lk.stubble) for (let y = 17; y < 22; y++) for (let x = 10; x < 23; x++) if (inHead(x, y) && (x + y) % 2 === 0) px(x, y, lk.skinS);
    if (lk.blush) { px(11, 17, "#F08A8A"); px(12, 17, "#F4A3A3"); px(20, 17, "#F4A3A3"); px(21, 17, "#F08A8A"); }
    if (lk.freckles) { px(12, 16, "#C98F70"); px(14, 17, "#C98F70"); px(19, 16, "#C98F70"); px(21, 16, "#C98F70"); }
    // the hair
    const H = lk.hair, HS = lk.hairS;
    const cap = (y0, y1) => { for (let y = y0; y <= y1; y++) for (let x = 6; x < 26; x++) { const dx = (x + 0.5 - 16) / 8, dy = (y + 0.5 - 13.5) / 9.5; if (dx * dx + dy * dy <= 1) px(x, y, x > 19 || y === y1 ? HS : H); } };
    if (lk.style === "spiky") { cap(3, 8); for (const [x, h] of [[9, 3], [12, 4], [15, 5], [18, 4], [21, 3]]) for (let i = 0; i < h; i++) { px(x + (i > 1 ? 1 : 0), 4 - i + 1, i === h - 1 ? H : HS); } rect(9, 9, 2, 3, HS); rect(21, 9, 2, 3, HS); px(13, 9, H); px(16, 9, H); px(18, 9, HS); }
    else if (lk.style === "short") { cap(4, 8); rect(9, 9, 2, 4, HS); rect(21, 9, 2, 4, HS); px(14, 9, HS); px(17, 9, H); }
    else if (lk.style === "bun") { cap(4, 8); for (let y = 0; y < 5; y++) for (let x = 13; x < 20; x++) { const dx = x + 0.5 - 16.5, dy = y + 0.5 - 2.5; if (dx * dx + dy * dy <= 7) px(x, y, x > 17 ? HS : H); } rect(9, 9, 2, 5, HS); rect(21, 9, 2, 5, HS); }
    else if (lk.style === "long") { cap(4, 9); rect(9, 9, 2, 6, H); rect(21, 9, 2, 6, HS); px(12, 9, H); px(13, 10, H); px(19, 9, HS); }
    else if (lk.style === "bald") { rect(7, 10, 3, 6, H); rect(22, 10, 3, 6, HS); px(8, 9, H); px(23, 9, HS); px(12, 6, "#FFFFFF"); px(13, 6, "#FFF0E6"); px(11, 7, "#FFF0E6"); }
    else if (lk.style === "curly") { for (const [x, y] of [[9, 6], [12, 4], [16, 3], [20, 4], [23, 6], [7, 10], [25, 10], [7, 14], [25, 14], [8, 18], [24, 18]]) for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) if (i * i + j * j <= 4) px(x + i, y + j, i + j > 1 ? HS : H); cap(4, 8); for (const [x, y] of [[11, 9], [15, 9], [19, 9]]) { px(x, y, H); px(x + 1, y, HS); } }
    else if (lk.style === "pony") { cap(4, 8); rect(9, 9, 2, 4, HS); rect(21, 9, 2, 4, HS); for (let y = 8; y < 22; y++) rect(24 + Math.round(Math.sin(y * 0.5)), y, 3, 1, y % 3 ? H : HS); rect(23, 8, 2, 2, "#D93644"); }
    // the hats
    if (lk.hat === "kerchief") {
      for (let y = 2; y < 21; y++) for (let x = 5; x < 27; x++) { const dx = (x + 0.5 - 16) / 10, dy = (y + 0.5 - 12) / 10; const face = Math.abs(x + 0.5 - 16) < 7 - (y < 9 ? (9 - y) * 2 : 0) && y > 6; if (dx * dx + dy * dy <= 1 && !face && !(y > 8 && Math.abs(x + 0.5 - 16) < 7.5)) px(x, y, x > 19 ? lk.hatS : lk.hatC); }
      for (let x = 7; x < 25; x++) px(x, 8, lk.hatS);
      for (const [x, y] of [[9, 4], [14, 3], [19, 4], [23, 7], [7, 10], [24, 12], [12, 6], [17, 6], [7, 15], [25, 16]]) px(x, y, "#FFFFFF");
      rect(14, 22, 4, 2, lk.hatC); px(13, 23, lk.hatS); px(18, 23, lk.hatS); px(15, 22, "#FF8F8F");
    } else if (lk.hat === "cap") {
      for (let y = 2; y < 8; y++) for (let x = 7; x < 25; x++) { const dx = (x + 0.5 - 16) / 8.5, dy = (y + 0.5 - 8) / 6; if (dx * dx + dy * dy <= 1) px(x, y, x > 19 ? lk.hatS : (x + y) % 4 === 0 ? lk.hatS : lk.hatC); }
      rect(6, 7, 19, 2, lk.hatS); rect(5, 8, 14, 1, "#24170F"); px(16, 3, "#9AA5C0");
    } else if (lk.hat === "postcap") {
      rect(10, 2, 12, 5, lk.hatC); rect(10, 6, 12, 1, lk.hatS); rect(10, 2, 12, 1, "#3B5A90"); rect(9, 7, 14, 1, "#0A0F1E");
      px(16, 4, "#FFD27A"); px(15, 4, "#C98A1B"); px(17, 4, "#C98A1B"); px(16, 3, "#FFF0C2");
    } else if (lk.hat === "captain") {
      for (let y = 1; y < 6; y++) for (let x = 6; x < 26; x++) { const dx = (x + 0.5 - 16) / 10, dy = (y + 0.5 - 6) / 5; if (dx * dx + dy * dy <= 1) px(x, y, x > 20 ? "#C9D6F2" : "#FFFFFF"); }
      rect(8, 5, 16, 2, "#1B2133"); rect(7, 7, 18, 2, "#0A0F1E"); rect(8, 7, 10, 1, "#3B4766");
      px(16, 5, "#FFD27A"); px(15, 6, "#FFD27A"); px(17, 6, "#FFD27A"); px(16, 6, "#C98A1B");
    } else if (lk.hat === "hood") {
      for (let y = 2; y < 24; y++) for (let x = 5; x < 27; x++) { const dx = (x + 0.5 - 16) / 10.5, dy = (y + 0.5 - 13) / 11.5; const inner = Math.abs(x + 0.5 - 16) < 6.6 && y > 6; if (dx * dx + dy * dy <= 1 && !inner && !inHead(x, y)) px(x, y, x > 19 ? lk.hatS : lk.hatC); if (dx * dx + dy * dy <= 1 && y <= 6 && y >= 2) px(x, y, x > 19 ? lk.hatS : lk.hatC); }
      for (let x = 9; x < 24; x++) { const dx = (x + 0.5 - 16) / 7.5; px(x, Math.round(7 - (1 - dx * dx) * 1.5), "#8B7CF6"); }
      for (const [x, y] of [[9, 4], [21, 3], [6, 12], [25, 15], [7, 19]]) px(x, y, "#C4BBFF");
    } else if (lk.hat === "crown") {
      rect(9, 4, 14, 3, "#FFD27A"); rect(9, 6, 14, 1, "#C98A1B");
      for (const [x, h] of [[9, 3], [12, 2], [15, 4], [16, 4], [19, 2], [22, 3]]) for (let i = 1; i <= h; i++) px(x, 4 - i, i === h ? "#FFF0C2" : "#FFD27A");
      px(12, 5, "#7FE6F4"); px(16, 5, "#34D399"); px(15, 5, "#8EF0C6"); px(20, 5, "#8B7CF6"); px(10, 4, "#FFF0C2");
    }
    // the face: brows, eyes, nose, mouth by mood
    const eye = lk.glow || "#1B2133";
    const brow = lk.hairS && lk.style !== "bald" ? lk.hairS : "#6B7694";
    const by = 12;
    if (mood === "sad") { px(11, by, brow); px(12, by, brow); px(13, by - 1, brow); px(19, by - 1, brow); px(20, by, brow); px(21, by, brow); }
    else if (mood === "think") { px(11, by - 1, brow); px(12, by - 1, brow); px(13, by - 1, brow); px(19, by, brow); px(20, by, brow); px(21, by, brow); }
    else { px(11, by, brow); px(12, by - 1, brow); px(13, by - 1, brow); px(19, by - 1, brow); px(20, by - 1, brow); px(21, by, brow); }
    if (blink || (mood === "happy")) {
      // closed or smiling eyes
      if (mood === "happy" && !blink) { px(11, 14, eye); px(12, 13, eye); px(13, 14, eye); px(19, 14, eye); px(20, 13, eye); px(21, 14, eye); }
      else { rect(11, 14, 3, 1, lk.skinS); rect(19, 14, 3, 1, lk.skinS); }
    } else {
      const look = mood === "think" ? 1 : 0;
      rect(11, 13, 3, 3, "#FFFFFF"); rect(19, 13, 3, 3, "#FFFFFF");
      rect(12 + look, 13, 2, 3, eye); rect(19 + look, 13, 2, 3, eye);
      px(12 + look, 13, "#FFFFFF"); px(19 + look, 13, "#FFFFFF");
      rect(11, 12, 3, 1, "#0A0F1E"); rect(19, 12, 3, 1, "#0A0F1E");
      if (lk.lips) { px(10, 12, "#0A0F1E"); px(22, 12, "#0A0F1E"); }
    }
    if (lk.glasses) {
      const fr = "#C9D6F2";
      for (const x0 of [10, 18]) { rect(x0, 11, 5, 1, fr); rect(x0, 16, 5, 1, fr); rect(x0, 12, 1, 4, fr); rect(x0 + 4, 12, 1, 4, fr); px(x0 + 1, 12, "rgba(210,250,255,.7)"); }
      rect(15, 13, 3, 1, fr); px(9, 13, fr); px(23, 13, fr);
    }
    px(16, 16, lk.skinS); px(16, 17, lk.skinS); px(17, 17, "#9A5A48");
    if (lk.earrings) { px(8, 17, "#FFD27A"); px(23, 17, "#FFD27A"); px(8, 18, "#C98A1B"); px(23, 18, "#C98A1B"); }
    const lip = lk.lips ? "#C0394F" : "#8E3A3A";
    const beardC = lk.beardC, beardS = "#A9B6CD";
    if (lk.beard === "full") {
      for (let y = 15; y < 28; y++) for (let x = 7; x < 25; x++) { const dx = (x + 0.5 - 16) / 8, dy = (y + 0.5 - 19) / 8; if (dx * dx + dy * dy <= 1 && (y >= 18 || x < 11 || x > 20) && (inHead(x, y) || y > 19)) px(x, y, x > 19 ? (lk.beardS || beardS) : beardC); }
      rect(12, 18, 8, 1, beardC); px(11, 19, beardC); px(20, 19, beardC);
    } else if (lk.beard === "goatee") {
      rect(14, 20, 4, 3, beardC); rect(15, 23, 2, 2, beardC); px(17, 22, "#A9B6CD");
    }
    // the mouth
    const my = 19;
    if (talk) { rect(14, my, 4, 2, "#4A0E1C"); px(15, my + 1, "#D93644"); px(16, my + 1, "#D93644"); rect(14, my, 4, 1, "#0A0F1E"); }
    else if (mood === "happy") { px(13, my - 1, lip); rect(14, my, 4, 1, lip); px(18, my - 1, lip); px(15, my + 1, "#4A0E1C"); px(16, my + 1, "#4A0E1C"); }
    else if (mood === "sad") { rect(14, my, 4, 1, lip); px(13, my + 1, lip); px(18, my + 1, lip); }
    else if (mood === "think") { rect(15, my, 3, 1, lip); }
    else rect(14, my, 4, 1, lip);
    if (lk.beard === "moustache" || lk.beard === "full") { rect(12, my - 1, 8, 1, beardC); px(11, my, beardC); px(20, my, beardC); px(12, my, beardC); px(19, my, beardC); }
  }
  function drawCat(g, lk, mood, blink, talk, px, rect) {
    shoulders(g, Object.assign({}, lk, { cloth: lk.fur, clothS: lk.furS, clothL: "#C9D6F2" }), rect, px);
    rect(11, 24, 10, 2, lk.cloth); rect(11, 25, 10, 1, lk.clothS); px(15, 26, "#FFD27A"); px(16, 26, "#FFD27A"); px(15, 27, "#C98A1B"); px(16, 27, "#FFF0C2");
    const inH = (x, y) => { const dx = (x + 0.5 - 16) / 9, dy = (y + 0.5 - 15) / 8; return dx * dx + dy * dy <= 1; };
    // ears
    for (const [x0, dir] of [[8, 1], [24, -1]]) for (let i = 0; i < 6; i++) for (let j = 0; j <= i; j++) { const x = x0 + dir * j; px(x, 3 + i, j === 0 || j === i ? lk.furD : i > 2 && j > 0 && j < i ? "#F4A3B5" : lk.fur); }
    for (let y = 6; y < 24; y++) for (let x = 6; x < 26; x++) if (inH(x, y)) px(x, y, !inH(x + 1, y) || !inH(x, y + 1) ? lk.furS : !inH(x - 1, y - 1) ? "#C9D6F2" : lk.fur);
    // stripes on the brow
    for (const x of [13, 16, 19]) { px(x, 7, lk.furD); px(x, 8, lk.furD); px(x, 9, lk.furD); }
    px(9, 12, lk.furD); px(8, 13, lk.furD); px(23, 12, lk.furD); px(24, 13, lk.furD);
    // the white muzzle
    for (let y = 16; y < 22; y++) for (let x = 11; x < 22; x++) { const dx = (x + 0.5 - 16) / 5, dy = (y + 0.5 - 18.5) / 3.2; if (dx * dx + dy * dy <= 1) px(x, y, x > 18 ? "#D7DFEB" : "#FFFFFF"); }
    // eyes
    if (blink || mood === "happy") { const e = "#1B2133"; for (const x0 of [11, 18]) { px(x0, 14, e); px(x0 + 1, 13, e); px(x0 + 2, 13, e); px(x0 + 3, 14, e); } }
    else { for (const x0 of [11, 18]) { rect(x0, 12, 4, 4, "#0A0F1E"); rect(x0 + 1, 12, 2, 4, "#8EF0C6"); rect(x0, 13, 4, 2, "#34D399"); px(x0 + 1, 13, "#0A0F1E"); px(x0 + 2, 13, "#0A0F1E"); px(x0 + 1, 14, "#0A0F1E"); px(x0 + 2, 14, "#0A0F1E"); px(x0, 13, "#FFFFFF"); } if (mood === "sad") { px(11, 11, lk.furD); px(21, 11, lk.furD); } }
    // nose, mouth, whiskers
    rect(15, 16, 3, 1, "#F47A9A"); px(16, 17, "#C94A6A");
    if (talk) { rect(15, 18, 3, 2, "#4A0E1C"); px(16, 19, "#F47A9A"); }
    else { px(15, 18, "#46516F"); px(17, 18, "#46516F"); px(14, 17, "#46516F"); px(18, 17, "#46516F"); }
    const wh = "#EAF0FA";
    rect(4, 17, 7, 1, wh); rect(5, 19, 6, 1, wh); rect(22, 17, 7, 1, wh); rect(22, 19, 6, 1, wh);
  }

  // ---------- the room: wall, window, shelf, chalkboard; the table: rim and felt lit by the lamp ----------
  const RIM = 44;
  const PAPER = "#F3ECD8";
  let ROOM = null, FRAME = null, TABLE = null, LAYERS = null, SAMOVAR = null;
  function paintRoom() {
    const c = WG.canvas(384, RIM + 2), g = c.getContext("2d"), art = WG.art;
    art.bands(g, 0, 0, 384, RIM, ["#0A0F1E", "#0E1730", "#121B31", "#17213A"]);
    // wallpaper: a quiet diamond print
    for (let y = 3; y < 33; y += 8) for (let x = (y / 8) % 2 ? 4 : 0; x < 384; x += 8) { g.fillStyle = "#1D2944"; g.fillRect(x, y, 1, 1); g.fillRect(x - 1, y + 1, 3, 1); g.fillRect(x, y + 2, 1, 1); }
    // wainscot
    g.fillStyle = "#24170F"; g.fillRect(0, 33, 384, 11);
    for (let x = 0; x < 384; x += 24) { g.fillStyle = "#4E3424"; g.fillRect(x + 1, 35, 22, 8); g.fillStyle = "#3A2618"; g.fillRect(x + 1, 42, 22, 1); g.fillRect(x + 22, 35, 1, 8); g.fillStyle = "#6A4630"; g.fillRect(x + 1, 35, 22, 1); }
    g.fillStyle = "#7A5236"; g.fillRect(0, 33, 384, 2); g.fillStyle = "#A8774D"; g.fillRect(0, 33, 384, 1);
    // the shelf with a samovar and cups
    g.fillStyle = "#24170F"; g.fillRect(102, 27, 48, 4); g.fillStyle = "#7A5236"; g.fillRect(102, 27, 48, 2); g.fillStyle = "#A8774D"; g.fillRect(102, 27, 48, 1);
    g.fillStyle = "#3A2618"; g.fillRect(106, 31, 2, 3); g.fillRect(144, 31, 2, 3);
    g.drawImage(SAMOVAR, 111, 6);
    const cup = WG.sprite([".wwwww.", "wwbwbww.", "wwwwwwwh", ".wwwww.h", "..www..", ".ccccc."], { w: "#EAF0FA", b: "#22B8CF", h: "#C9D6F2", c: "#9AA5C0" }, { outline: "#0A0F1E" });
    g.drawImage(cup, 133, 20); g.drawImage(cup, 141, 20);
    // the chalkboard's frame (the chalk itself is drawn live)
    g.fillStyle = "#0A0F1E"; g.fillRect(299, 3, 80, 30);
    g.fillStyle = "#7A5236"; g.fillRect(300, 4, 78, 28); g.fillStyle = "#A8774D"; g.fillRect(300, 4, 78, 1); g.fillRect(300, 4, 1, 28);
    g.fillStyle = "#16302A"; g.fillRect(302, 6, 74, 24);
    WG.art.dither(g, 302, 6, 74, 24, null, "#1B3A33", 0.3);
    g.fillStyle = "#EAF0FA"; g.fillRect(366, 31, 6, 1); g.fillStyle = "#A9B6CD"; g.fillRect(372, 31, 1, 1);
    return c;
  }
  function paintFrame() {
    // the window frame over the moving view
    const c = WG.canvas(384, RIM), g = c.getContext("2d");
    g.fillStyle = "#0A0F1E"; g.fillRect(12, 2, 80, 32);
    g.clearRect(15, 5, 74, 26);
    g.fillStyle = "#4E3424"; g.fillRect(13, 3, 78, 2); g.fillRect(13, 31, 78, 2); g.fillRect(13, 3, 2, 30); g.fillRect(89, 3, 2, 30); g.fillRect(51, 5, 2, 26); g.fillRect(15, 17, 74, 1);
    g.fillStyle = "#7A5236"; g.fillRect(13, 3, 78, 1); g.fillRect(13, 3, 1, 30); g.fillRect(51, 5, 1, 26);
    g.fillStyle = "#A8774D"; g.fillRect(11, 32, 82, 2); g.fillStyle = "#24170F"; g.fillRect(11, 34, 82, 1);
    // a little frost in the corners
    for (const [x, y] of [[15, 5], [16, 5], [15, 6], [87, 5], [88, 5], [88, 6], [15, 29], [16, 30], [15, 30], [53, 5], [54, 5], [53, 6], [49, 29], [50, 30], [48, 30]]) { g.fillStyle = "rgba(210,250,255,.55)"; g.fillRect(x, y, 1, 1); }
    return c;
  }
  function paintLayers() {
    const far = WG.canvas(160, 26), fg = far.getContext("2d");
    WG.art.ridge(fg, 0, 14, 160, 12, "#15234A", 3, 26, 0.1);
    const mid = WG.canvas(140, 26), mg = mid.getContext("2d");
    WG.art.ridge(mg, 0, 19, 140, 7, "#0F1A38", 7, 26, 0.05);
    WG.art.pines(mg, 0, 26, 140, "#0A1530", 11, 5, 11, 6);
    const near = WG.canvas(120, 26), ng = near.getContext("2d");
    WG.art.pines(ng, 0, 26, 120, "#07101F", 23, 3, 7, 10);
    // a snowy field and a lit hut far off
    ng.fillStyle = "#C9D6F2"; ng.fillRect(0, 25, 120, 1);
    ng.fillStyle = "#1B2133"; ng.fillRect(70, 19, 9, 6); ng.fillRect(71, 17, 7, 2); ng.fillRect(73, 16, 3, 1);
    ng.fillStyle = "#FFD27A"; ng.fillRect(73, 21, 2, 2);
    return new WG.Parallax([{ img: far, speed: 0.15, y: 0 }, { img: mid, speed: 0.35, y: 0 }, { img: near, speed: 0.7, y: 0 }]);
  }
  function paintTable() {
    const h = 216 - RIM, c = WG.canvas(384, h), g = c.getContext("2d");
    // felt lit from the lamp: rings of dithered tone around the pool of light
    const tones = ["#0A2A25", "#0D352F", "#104038", "#134B41", "#17574B", "#1B6253"];
    const img = g.createImageData(384, h), d = img.data;
    const B = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const hex = tones.map((t) => [parseInt(t.slice(1, 3), 16), parseInt(t.slice(3, 5), 16), parseInt(t.slice(5, 7), 16)]);
    const rnd = WG.rng(808);
    for (let y = 0; y < h; y++) for (let x = 0; x < 384; x++) {
      const dx = (x - 192) / 210, dy = (y + RIM - 112) / 120;
      const r = Math.sqrt(dx * dx + dy * dy);
      let f = clamp(1 - r, 0, 1) * (tones.length - 1) + 0.15;
      f += (B[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * 0.9;
      const k = clamp(Math.floor(f), 0, tones.length - 1);
      const n = (y * 384 + x) * 4;
      d[n] = hex[k][0]; d[n + 1] = hex[k][1]; d[n + 2] = hex[k][2]; d[n + 3] = 255;
      // the felt's nap
      if (rnd() < 0.05) { const m = rnd() > 0.5 ? 10 : -8; d[n] = clamp(d[n] + m, 0, 255); d[n + 1] = clamp(d[n + 1] + m, 0, 255); d[n + 2] = clamp(d[n + 2] + m, 0, 255); }
    }
    g.putImageData(img, 0, 0);
    // the near rim's shadow and the far rim of polished wood
    g.fillStyle = "#24170F"; g.fillRect(0, 0, 384, 7);
    g.fillStyle = "#7A5236"; g.fillRect(0, 1, 384, 4); g.fillStyle = "#A8774D"; g.fillRect(0, 1, 384, 1); g.fillStyle = "#C9925E"; for (let x = 150; x < 234; x++) if (x % 3) g.fillRect(x, 1, 1, 1);
    g.fillStyle = "#4E3424"; g.fillRect(0, 5, 384, 1);
    WG.art.dither(g, 0, 7, 384, 4, null, "#061A16", 0.6);
    WG.art.dither(g, 0, 11, 384, 3, null, "#061A16", 0.25);
    // a stitched border on the felt
    g.fillStyle = "#1F6B5B";
    for (let x = 8; x < 376; x += 4) { g.fillRect(x, 16, 2, 1); g.fillRect(x, h - 5, 2, 1); }
    for (let y = 18; y < h - 5; y += 4) { g.fillRect(6, y, 1, 2); g.fillRect(377, y, 1, 2); }
    return c;
  }
  function paintSamovar() {
    return WG.sprite([
      ".....oo.....",
      "....oyyo....",
      "...oyYYyo...",
      "..oyyyyyyo..",
      ".oyYyyyyyyo.",
      "oyYyyyyyyyyo",
      "oyYyyddyyyyo",
      "oyYyyddyyyyy",
      "oyYyyyyyyyyo",
      ".oyYyyyyyyo.",
      "..oyyyyyyo..",
      "...oyyyyo...",
      "....oyyo....",
      "...oyyyyo...",
      "..oyyyyyyo..",
      "..oooooooo..",
      "..o......o..",
      ".oo......oo.",
    ].map((r) => r.padEnd(12, ".")), { o: "#6B4A0A", y: "#C98A1B", Y: "#FFF0C2", d: "#2A1E00" }, { outline: "#0A0F1E" });
  }

  // ======================================================================= the music: «У лампы», A minor
  const SONG = {
    bpm: 96,
    ch: [
      { w: "p25", v: 0.1, sus: 0.6, vib: 4, notes:
        "A4 . C5 . E5 - - . D5 . C5 . B4 . C5 . D5 - - . F5 . A5 . G5 . F5 . E5 . D5 . B4 . D5 . G5 - - . F5 . E5 . D5 . B4 . C5 - E5 . G5 . E5 . C5 - - - . . . . " +
        "F5 . E5 . F5 . A5 - - . G5 . F5 . E5 . D5 . C5 . D5 . F5 - - . E5 . D5 . C5 . B4 . C5 . D5 . E5 - G#5 - B5 - A5 . G#5 . A5 - - - E5 . C5 . A4 - - - . . . ." },
      { w: "p12", v: 0.03, sus: 0.3, notes:
        "E4 . A4 . C5 . A4 . E4 . A4 . C5 . A4 . F4 . A4 . D5 . A4 . F4 . A4 . D5 . A4 . D4 . G4 . B4 . G4 . D4 . G4 . B4 . G4 . E4 . G4 . C5 . G4 . E4 . G4 . C5 . G4 . " +
        "F4 . A4 . C5 . A4 . F4 . A4 . C5 . A4 . F4 . A4 . D5 . A4 . F4 . A4 . D5 . A4 . E4 . G#4 . B4 . G#4 . E4 . G#4 . B4 . G#4 . E4 . A4 . C5 . A4 . E4 . A4 . C5 . A4 ." },
      { w: "tri", v: 0.2, sus: 0.7, notes:
        "A2 . . . A3 . . . E3 . . . A3 . . . D3 . . . D4 . . . A3 . . . D4 . . . G2 . . . G3 . . . D3 . . . G3 . . . C3 . . . C4 . . . G3 . . . C4 . . . " +
        "F2 . . . F3 . . . C3 . . . F3 . . . D3 . . . D4 . . . A3 . . . D4 . . . E2 . . . E3 . . . B2 . . . E3 . . . A2 . . . A3 . . . E3 . . . A2 . . ." },
      { w: "noise", v: 0.09, notes: "k . . . h . . . s . . . h . . h k . . . h . . . s . . . h . h ." },
    ],
  };
  WG.SFX.durakShuffle = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35].map((t, i) => ({ w: "noise", f: 4000 + (i % 3) * 900, t, d: 0.03, v: 0.09, hp: 2200 }));
  WG.SFX.durakTrump = [{ w: "p25", f: "E6", d: 0.05, v: 0.14 }, { w: "p25", f: "B6", t: 0.05, d: 0.05, v: 0.14 }, { w: "p25", f: "E7", t: 0.1, d: 0.12, v: 0.12, sus: 0.4 }, { w: "noise", f: 6000, d: 0.05, v: 0.05, hp: 4000 }];
  WG.SFX.durakTake = [{ w: "p50", f: "E4", f2: "A3", d: 0.18, v: 0.13 }, { w: "noise", f: 1500, f2: 400, d: 0.2, v: 0.08 }];
  WG.SFX.durakBuzz = [{ w: "p50", f: 160, d: 0.08, v: 0.12 }, { w: "p50", f: 140, t: 0.09, d: 0.08, v: 0.12 }];

  // ======================================================================= the game
  const CW = 31, CH = 43, MW = 19, MH = 27;
  const TABLE_Y = 66, HAND_Y = 168;
  const DECK = { x: 22, y: 78 }, TRUMP = { x: 6, y: 84 }, DISC = { x: 336, y: 80 };
  const BTN = { x: 318, y: 139, w: 60, h: 17 };
  const INK_T = ["#FFFFFF", "#FFFFFF", "#EAF0FA", "#EAF0FA", "#C9D6F2", "#C9D6F2", "#A9B6CD"];
  const GOLD_T = ["#FFF0C2", "#FFF0C2", "#FFD27A", "#FFD27A", "#FFD27A", "#C98A1B", "#C98A1B"];
  const RED_T = ["#FFC2C9", "#FFC2C9", "#FF8F8F", "#FF8F8F", "#FF6B7A", "#D93644", "#D93644"];
  const SUIT_NAME = ["пики", "трефы", "бубны", "червы"];
  const ease = (k) => 1 - Math.pow(1 - k, 3);
  const jit = (c, k) => ((c * 37 + k * 11) % 7) - 3;
  const plural = (n, a, b, c) => (WG.plural ? WG.plural(n, a, b, c) : n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);

  WG.game({
    id: "durak",
    portrait: true,
    controls: { dpad: true, a: "Ход", b: false, swipe: false, landscapeDpad: false },
    howto: "Подкидной дурак на 36 карт. Отбивайся старшей картой той же масти или козырем — или бери. Подкидывай карты тех же достоинств, что на столе. Кто первым избавится от карт — победил.",
    keysHint: "Стрелки ← → — выбрать карту, ↑ или пробел — сыграть, X — «Беру» / «Бито», Esc — пауза.",
    touchHowto: (l) => (l.dpad ? "Крестовина ← → — выбрать карту, «Ход» — сыграть, ↓ — «Беру» / «Бито». Или нажми карту дважды." : "Нажми карту, чтобы выбрать, и ещё раз — чтобы сыграть. Зелёная кнопка на столе — «Беру» / «Бито».") ,
    titleColors: ["#FFF0C2", "#FFF0C2", "#FFD27A", "#FFD27A", "#FF8F8F", "#FF6B7A", "#D93644"],
    stageNames: LEAGUE.map((o) => o.name),
    music: SONG,
    _core: { newGame, legal, apply, aiMove, mover, beats, val, LEVEL_AI, adaptiveAI, LEAGUE, searchMove, bust },
    create(api) {
      const ART = WG.durakArt;
      if (!ROOM) { SAMOVAR = paintSamovar(); ROOM = paintRoom(); FRAME = paintFrame(); TABLE = paintTable(); LAYERS = paintLayers(); }
      const stage = api.stage ? LEAGUE[api.stage - 1] : null;
      const fx = new WG.Particles(400);
      const motes = [];
      const mr = WG.rng(5);
      for (let i = 0; i < 14; i++) motes.push({ x: 150 + mr() * 84, y: 10 + mr() * 120, p: mr() * 6.28, s: 0.3 + mr() * 0.5 });
      const rnd = WG.rng((Date.now() ^ (Math.random() * 1e9)) >>> 0);
      const S = {
        t: 0, phase: stage ? "intro" : "pick", G: null, vis: [], wait: 0, timers: [], cursor: 0, pickI: 0,
        level: api.level, opp: stage || LEAGUE.find((o) => o.id === FREE[api.level]) || LEAGUE[3], prof: null,
        series: [0, 0], games: 0, draws: 0, wins: 0, played: 0, lastTook: 0, ended: false, toast: null, bubble: null, sayT: 0,
        mood: "idle", moodT: 0, blinkT: 2, talkT: 0, think: 0, thinking: false, msg: "", hint: null, hintT: 0, dealT: 0,
        overT: 0, result: null, btnDown: 0, speed: 1, auto: false, px: -1, py: -1, downCur: -1, wasDown: false, shake: {}, shakeT: 0,
        endT: 0, panelT: 0, lampT: 0, playMs: 0, revealed: false,
      };
      for (let c = 0; c < 36; c++) S.vis.push({ x: DECK.x, y: DECK.y, fx: DECK.x, fy: DECK.y, tx: DECK.x, ty: DECK.y, t0: -1, dur: 0.3, del: 0, face: 0, f0: 0, mini: 0, m0: 0, key: "", z: 0 });
      S.pickI = Math.max(0, LEVEL_LINES.findIndex((l) => l[0] === api.level));
      function profileFor(level) {
        if (stage) return Object.assign({}, stage.ai);
        if (level === "adaptive") return adaptiveAI(WG.adaptive ? WG.adaptive.get("durak") : api.skill);
        return Object.assign({}, LEVEL_AI[level] || LEVEL_AI.normal);
      }
      S.prof = profileFor(S.level);
      const later = (sec, fn) => S.timers.push({ t: sec, fn });
      const toast = (text, color, sub) => { S.toast = { text, color: color || GOLD_T, sub: sub || "", t: 0 }; };
      const say = (kind, force) => {
        const lines = S.opp.say[kind];
        if (!lines || (!force && (S.sayT > 0 || rnd() < 0.45))) return;
        S.bubble = { text: lines[Math.floor(rnd() * lines.length)], t: 0 };
        S.sayT = 4; S.talkT = 0.9;
      };
      const setMood = (m, sec) => { S.mood = m; S.moodT = sec || 1.6; };

      // ---------------- the deal ----------------
      function startGame() {
        S.G = newGame(rnd);
        const G = S.G;
        S.phase = "deal"; S.dealT = 0; S.revealed = false; S.result = null; S.overT = 0;
        S.toast = null; S.hint = null; S.cursor = 0;
        for (let c = 0; c < 36; c++) { const v = S.vis[c]; v.x = v.fx = v.tx = DECK.x; v.y = v.fy = v.ty = DECK.y; v.t0 = -1; v.face = v.f0 = 0; v.mini = v.m0 = 0; v.key = ""; v.del = 0; }
        api.sfx("durakShuffle");
        const base = 0.75;
        G.order.forEach((c, i) => { S.vis[c].pendDel = base + i * 0.085; later(base + i * 0.085, () => api.sfx("card")); });
        S.vis[G.trumpCard].pendDel = base + 12 * 0.085 + 0.15;
        later(base + 12 * 0.085 + 0.2, () => api.sfx("place"));
        S.wait = base + 12 * 0.085 + 0.75;
        later(S.wait - 0.1, () => {
          const low = G.lowTrump;
          const who = G.att === 0 ? "Ты ходишь первым" : S.opp.name + " ходит первым";
          toast("КОЗЫРЬ — " + SUIT_NAME[G.trump].toUpperCase(), suitColorT(G.trump), low !== null ? "Младший козырь " + (G.att === 0 ? "у тебя" : "у соперника") + " · " + who : who);
          S.phase = "play";
          if (S.played === 0) say("hello", true);
        });
      }
      const suitColorT = (s) => (s >= 2 ? RED_T : INK_T);

      // ---------------- layout: where each card should be ----------------
      function sortedHand() {
        const G = S.G, tr = G.trump;
        return G.hands[0].slice().sort((a, b) => {
          const sa = suitOf(a) === tr ? 9 : suitOf(a), sb = suitOf(b) === tr ? 9 : suitOf(b);
          return sa - sb || a - b;
        });
      }
      function handPos(n, i) {
        const span = Math.min(33 * (n - 1), 300);
        const step = n > 1 ? span / (n - 1) : 0;
        return Math.round(192 - (span + CW) / 2 + i * step);
      }
      function oppPos(n, i) {
        const span = Math.min(13 * (n - 1), 150);
        const step = n > 1 ? span / (n - 1) : 0;
        const x = 192 - (span + MW) / 2 + i * step;
        const k = n > 1 ? i / (n - 1) - 0.5 : 0;
        return [Math.round(x), Math.round(33 + k * k * 10)];
      }
      function tablePos(n, i) {
        const pw = n > 5 ? 36 : 40;
        const x = 192 - (n * pw - (pw - CW - 7)) / 2 + i * pw;
        return Math.round(x);
      }
      function layout() {
        const G = S.G;
        if (!G) return;
        const T = {};
        G.deck.forEach((c, i) => {
          if (c === G.trumpCard) T[c] = { x: TRUMP.x, y: TRUMP.y, face: 1, mini: 0, z: 0, rot: 1 };
          else T[c] = { x: DECK.x - Math.floor(i / 5), y: DECK.y - Math.floor(i / 5), face: 0, mini: 0, z: 1 + i };
        });
        G.discard.forEach((c, i) => { T[c] = { x: DISC.x + jit(c, 1), y: DISC.y + jit(c, 2) - Math.floor(i / 6), face: 0, mini: 0, z: 40 + i }; });
        const n = G.table.length;
        G.table.forEach((p, i) => {
          const x = tablePos(n, i);
          T[p.a] = { x, y: TABLE_Y, face: 1, mini: 0, z: 80 + i * 2 };
          if (p.d !== null) T[p.d] = { x: x + 7, y: TABLE_Y + 10, face: 1, mini: 0, z: 81 + i * 2 };
        });
        const reveal = S.revealed;
        const oh = G.hands[1];
        oh.forEach((c, i) => {
          if (reveal) { const span = Math.min(16 * (oh.length - 1), 200), x = 192 - (span + CW) / 2 + (oh.length > 1 ? (i * span) / (oh.length - 1) : 0); T[c] = { x: Math.round(x), y: 30, face: 1, mini: 0, z: 120 + i }; }
          else { const [x, y] = oppPos(oh.length, i); T[c] = { x, y: y - (S.thinking && i === S.peek ? 3 : 0), face: 0, mini: 1, z: 120 + i }; }
        });
        const hand = sortedHand();
        const my = humanTurn();
        const L = my ? legalSet() : null;
        hand.forEach((c, i) => {
          let y = HAND_Y;
          if (my && i === S.cursor) y -= 9;
          else if (my && L.has(c)) y -= 2;
          T[c] = { x: handPos(hand.length, i), y, face: 1, mini: 0, z: 160 + i, quick: true };
        });
        for (let c = 0; c < 36; c++) {
          const t = T[c];
          if (!t) continue;
          const v = S.vis[c];
          v.z = t.z; v.rot = t.rot || 0;
          const key = t.x + "," + t.y + "," + t.face + "," + t.mini;
          if (key === v.key) continue;
          const moved = t.x !== v.tx || t.y !== v.ty;
          const cur = visPos(v);
          v.fx = cur.x; v.fy = cur.y; v.f0 = cur.face; v.m0 = cur.mini;
          v.tx = t.x; v.ty = t.y; v.face = t.face; v.mini = t.mini;
          v.t0 = S.t; v.del = v.pendDel || 0; v.pendDel = 0;
          const dist = Math.hypot(v.tx - v.fx, v.ty - v.fy);
          v.dur = t.quick && dist < 24 ? 0.09 : clamp(0.18 + dist / 900, 0.2, 0.42);
          v.arc = moved && dist > 30 ? Math.min(12, dist * 0.06) : 0;
          v.key = key;
        }
      }
      function visPos(v) {
        if (v.t0 < 0) return { x: v.tx, y: v.ty, face: v.face, mini: v.mini, k: 1, flip: 1 };
        const k = clamp((S.t - v.t0 - v.del) / v.dur, 0, 1);
        const e = ease(k);
        const x = lerp(v.fx, v.tx, e), y = lerp(v.fy, v.ty, e) - Math.sin(Math.PI * k) * (v.arc || 0);
        const flipping = v.f0 !== v.face;
        const face = flipping ? (k < 0.5 ? v.f0 : v.face) : v.face;
        const mini = lerp(v.m0, v.mini, e);
        return { x, y, face, mini, k, flip: flipping ? Math.abs(Math.cos(Math.PI * k)) : 1 };
      }

      // ---------------- the human's moves ----------------
      function humanTurn() { return S.phase === "play" && S.G && S.G.phase !== "over" && mover(S.G) === 0 && S.wait <= 0 && !S.auto; }
      let LCACHE = null, LKEY = -1;
      function legalSet() {
        const G = S.G;
        if (LKEY === G.moves && LCACHE) return LCACHE;
        LCACHE = new Set(legal(G).filter((m) => m.t === "card").map((m) => m.c));
        LKEY = G.moves;
        return LCACHE;
      }
      function actionLabel() {
        const G = S.G;
        if (!G || S.phase !== "play" || G.phase === "over") return null;
        if (mover(G) !== 0) return null;
        if (G.phase === "defend") return "БЕРУ";
        if (G.phase === "add") return "ХВАТИТ";
        if (G.phase === "attack" && G.table.length) return "БИТО";
        return null;
      }
      function act(m) {
        const G = S.G, who = mover(G);
        const ev = apply(G, m);
        LKEY = -1;
        onEvents(ev, who, m);
      }
      function playHuman(c) {
        const L = legalSet();
        if (!L.has(c)) {
          api.sfx("durakBuzz");
          S.shake[c] = 0.3;
          const G = S.G;
          S.hint = G.phase === "defend" ? "Бей старшей картой той же масти или козырем" : G.table.length >= G.limit ? "Больше подкидывать нельзя" : "Подкидывать можно только карты тех достоинств, что на столе";
          S.hintT = 2.4;
          return;
        }
        act({ t: "card", c });
      }
      function humanAction() {
        const G = S.G, lab = actionLabel();
        if (!lab) return;
        S.btnDown = 0.15;
        act(G.phase === "defend" ? { t: "take" } : { t: "pass" });
      }
      function hitHand(x, y) {
        const hand = sortedHand();
        for (let i = hand.length - 1; i >= 0; i--) {
          const v = S.vis[hand[i]], p = visPos(v);
          if (x >= p.x && x < p.x + CW && y >= p.y - 2 && y < p.y + CH + 12) return i;
        }
        return -1;
      }
      const inBtn = (x, y) => x >= BTN.x - 3 && x < BTN.x + BTN.w + 3 && y >= BTN.y - 4 && y < BTN.y + BTN.h + 4;
      const coarse = !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
      function humanInput() {
        const I = api.input, G = S.G;
        const hand = sortedHand();
        if (S.cursor >= hand.length) S.cursor = hand.length - 1;
        if (S.cursor < 0) S.cursor = 0;
        const P = I.pointer;
        // a mouse chooses by hovering and plays with a click; a finger taps once to choose and again to play
        if (!coarse && P && (P.x !== S.px || P.y !== S.py)) {
          S.px = P.x; S.py = P.y;
          const i = hitHand(P.x, P.y);
          if (i >= 0 && i !== S.cursor) { S.cursor = i; api.sfx("tick"); }
        }
        if (I.pressed("left")) { S.cursor = (S.cursor - 1 + hand.length) % hand.length; api.sfx("tick"); }
        if (I.pressed("right")) { S.cursor = (S.cursor + 1) % hand.length; api.sfx("tick"); }
        if (I.pressed("up") || I.pressed("a")) { if (hand.length) playHuman(hand[S.cursor]); return; }
        if (I.pressed("b") || I.pressed("down")) { humanAction(); return; }
        if (I.tap) {
          const { x, y } = I.tap;
          if (inBtn(x, y) && actionLabel()) { humanAction(); return; }
          const i = hitHand(x, y);
          if (i >= 0) { if (i === S.cursor) playHuman(hand[i]); else { S.cursor = i; api.sfx("tick"); } return; }
          if (y > TABLE_Y - 6 && y < HAND_Y - 8 && x > 64 && x < 320 && hand.length) playHuman(hand[S.cursor]);
        }
        void G;
      }
      // the cursor goes to a sensible card when the turn comes round
      let lastTurnKey = "";
      function aimCursor() {
        const G = S.G, hand = sortedHand(), L = legalSet();
        const key = G.moves + ":" + G.phase;
        if (key === lastTurnKey) return;
        lastTurnKey = key;
        if (L.has(hand[S.cursor])) return;
        let best = -1, bv = 99;
        hand.forEach((c, i) => { if (L.has(c) && val(c, G.trump) < bv) { bv = val(c, G.trump); best = i; } });
        if (best >= 0) S.cursor = best;
      }

      // ---------------- what the moves look like ----------------
      function onEvents(ev, who, m) {
        const G = S.G;
        let wait = 0.32, nDraw = 0;
        const after = ev.some((e) => e.t === "took" || e.t === "bito") ? 0.55 : 0.1;
        for (const e of ev) {
          if (e.t === "play") {
            api.sfx("place");
            if (who === 1) { if (!G.table.length || G.table.length === 1) say("lead"); }
          } else if (e.t === "beat") {
            api.sfx("place");
            if (e.trump) {
              later(0.22, () => {
                api.sfx("durakTrump");
                const p = S.vis[e.c];
                fx.emit({ x: p.tx + CW / 2, y: p.ty + CH / 2, n: 18, colors: ["#FFF0C2", "#FFD27A", "#7FE6F4", "#FFFFFF"], speed: [20, 70], life: [0.3, 0.7], drag: 3, shape: "star" });
              });
              if (who === 1) say("trump");
            }
          } else if (e.t === "takes") {
            if (e.who === 0) { toast("БЕРУ", RED_T); } else { toast((S.opp.short || S.opp.name).toUpperCase() + " БЕРЁТ", GOLD_T, G.phase === "add" ? "Можно подкинуть ещё" : ""); setMood("sad", 2); say("take"); }
          } else if (e.t === "took") {
            e.cards.forEach((c, i) => { S.vis[c].pendDel = 0.25 + i * 0.05; });
            later(0.25, () => api.sfx("durakTake"));
            if (e.who === 0) { later(0.3, () => api.shake(2, 0.2)); setMood("happy", 2); say("ptake"); }
            wait = Math.max(wait, 0.9);
          } else if (e.t === "bito") {
            e.cards.forEach((c, i) => { S.vis[c].pendDel = 0.25 + i * 0.04; });
            later(0.22, () => api.sfx("whoosh"));
            toast("БИТО", INK_T);
            wait = Math.max(wait, 0.85);
          } else if (e.t === "draw") {
            const d = after + 0.35 + nDraw * 0.09;
            S.vis[e.c].pendDel = d;
            later(d, () => api.sfx("card"));
            nDraw++;
            wait = Math.max(wait, d + 0.35);
          } else if (e.t === "over") {
            later(wait + 0.2, () => gameOver(e.winner));
            wait += 10;
          }
        }
        S.wait = wait;
        if (G.phase !== "over" && mover(G) === 1) S.think = -1;
        void m;
      }
      function gameOver(w) {
        const G = S.G;
        S.result = w; S.overT = 0; S.played++;
        S.revealed = true;
        const took = G.took[0];
        if (w === 0) {
          S.series[0]++; S.wins++;
          api.sfx("win"); setMood("sad", 3); say("lose", true);
          toast("ТЫ ВЫИГРАЛ!", GOLD_T, took ? "" : "И ни разу не брал карты!");
          for (let i = 0; i < 3; i++) later(i * 0.25, () => fx.emit({ x: 120 + rnd() * 144, y: 110 + rnd() * 30, n: 26, colors: ["#FFF0C2", "#FFD27A", "#8EF0C6", "#7FE6F4", "#C4BBFF"], speed: [40, 130], angle: [-2.8, -0.3], gravity: 140, life: [0.6, 1.3], shape: "star" }));
          api.flash("#FFF0C2", 0.15);
        } else if (w === 1) {
          S.series[1]++;
          api.sfx("lose"); setMood("happy", 4); say("win", true);
          toast("ТЫ ОСТАЛСЯ В ДУРАКАХ", RED_T, "У тебя " + G.hands[0].length + " " + plural(G.hands[0].length, "карта", "карты", "карт"));
          api.shake(3, 0.3);
        } else {
          S.draws++;
          api.sfx("bonus");
          toast("НИЧЬЯ!", INK_T, "Оба вышли одновременно — партия не считается");
        }
        S.lastTook = took;
        if (api.level === "adaptive" && !stage && w !== -1 && WG.adaptive) {
          WG.adaptive.report("durak", w === 0);
          S.prof = adaptiveAI(WG.adaptive.get("durak"));
        }
        later(2.2, () => {
          if (stage && (S.series[0] >= 2 || S.series[1] >= 2)) { S.phase = S.series[0] >= 2 ? "won" : "lost"; S.endT = 0; return; }
          if (!stage && w === 1) { S.phase = "lost"; S.endT = 0; return; }
          S.phase = "between"; S.panelT = 0;
        });
      }
      function finish() {
        if (S.ended) return;
        S.ended = true;
        const ms = Math.round(S.playMs);
        if (stage) {
          const [a, b] = S.series;
          if (a >= 2) {
            const stars = b === 0 ? (S.lastTook === 0 ? 3 : 2) : 1;
            const hint = stars === 1 ? "★★ — выиграй серию 2:0" : stars === 2 ? "★★★ — 2:0 и ни разу не брать карты во второй партии" : "";
            api.clear({ stars, score: 100 * stars, ms, line: "Серия " + a + ":" + b + " · " + stage.name, hint, meta: { s: a + ":" + b, took: S.lastTook } });
          } else api.end({ ms, line: "Серия " + a + ":" + b + " · " + stage.name, hint: stage.about, meta: { s: a + ":" + b } });
        } else {
          const w = S.wins;
          api.end({ score: w, ms, meta: { wins: w, games: S.played, draws: S.draws }, title: w ? w + " " + plural(w, "ПОБЕДА", "ПОБЕДЫ", "ПОБЕД") + " ПОДРЯД" : "ПОРАЖЕНИЕ" });
        }
      }

      // ---------------- the computer's turn ----------------
      function cpuTurn(dt) {
        const G = S.G;
        if (S.think < 0) {
          const P = S.prof;
          const nMoves = legal(G).length;
          S.think = (nMoves <= 1 ? 0.45 : P.think * (0.75 + rnd() * 0.5)) + (G.phase === "defend" ? 0.1 : 0);
          S.thinking = true; S.peek = Math.floor(rnd() * Math.max(1, G.hands[1].length));
        }
        S.think -= dt;
        if (S.think > 0) return;
        S.thinking = false; S.think = -1;
        const m = aiMove(G, 1, S.prof, rnd);
        act(m);
      }
      function autoHuman(dt) {
        // used by automated checks: the human's seat played by the master
        S.think2 = (S.think2 || 0) - dt;
        if (S.think2 > 0) return;
        S.think2 = 0.05;
        act(aiMove(S.G, 0, S.autoProf || LEVEL_AI.master, rnd));
      }

      // ---------------- panels: intro, level pick, between games, the end ----------------
      function panelInput(kind) {
        const I = api.input;
        if (kind === "pick") {
          if (I.pressed("up")) { S.pickI = (S.pickI + 4) % 5; api.sfx("tick"); }
          if (I.pressed("down")) { S.pickI = (S.pickI + 1) % 5; api.sfx("tick"); }
          let go = I.pressed("a") || I.pressed("right");
          if (I.tap) { const i = Math.floor((I.tap.y - 62) / 25); if (i >= 0 && i < 5 && I.tap.x > 70 && I.tap.x < 314) { if (i === S.pickI) go = true; else { S.pickI = i; api.sfx("tick"); } } }
          if (I.pointer && (I.pointer.x !== S.px || I.pointer.y !== S.py)) { S.px = I.pointer.x; S.py = I.pointer.y; const i = Math.floor((S.py - 62) / 25); if (i >= 0 && i < 5 && S.px > 70 && S.px < 314 && i !== S.pickI) { S.pickI = i; api.sfx("tick"); } }
          if (go) {
            const lv = LEVEL_LINES[S.pickI][0];
            S.level = lv;
            // the engine posts the score under the runner's level: keep it in step with the choice made here
            if (WG.runner) WG.runner.level = lv;
            WG.store && WG.store.set("level.durak", lv);
            S.opp = LEAGUE.find((o) => o.id === FREE[lv]);
            S.prof = profileFor(lv);
            api.sfx("confirm");
            startGame();
          }
          return;
        }
        if (kind === "intro") {
          if (S.panelT > 0.3 && (I.pressed("a") || I.pressed("b") || I.tap || I.pressed("up"))) { api.sfx("confirm"); startGame(); }
          return;
        }
        if (kind === "between") {
          if (S.panelT < 0.4) return;
          const endBtn = !stage && I.tap && I.tap.y > 150 && I.tap.x > 196;
          if (!stage && (I.pressed("b") || endBtn)) { api.sfx("back"); finish(); return; }
          if (I.pressed("a") || I.pressed("up") || I.tap) { api.sfx("confirm"); startGame(); }
        }
      }

      const inst = {
        _state: S,
        _core: { legal, apply, aiMove },
        _act: (m) => act(m),
        start() { S.t = 0; api.sfx("start"); },
        update(dt0) {
          const dt = dt0 * S.speed;
          S.t += dt;
          fx.update(dt);
          for (let i = S.timers.length - 1; i >= 0; i--) { const tm = S.timers[i]; tm.t -= dt; if (tm.t <= 0) { S.timers.splice(i, 1); tm.fn(); } }
          if (S.toast) { S.toast.t += dt; if (S.toast.t > 1.7) S.toast = null; }
          if (S.bubble) { S.bubble.t += dt; if (S.bubble.t > 2.4) S.bubble = null; }
          S.sayT -= dt; S.talkT -= dt; S.hintT -= dt; S.btnDown -= dt;
          S.moodT -= dt; if (S.moodT <= 0 && S.mood !== "idle") S.mood = "idle";
          S.blinkT -= dt; if (S.blinkT < -0.13) S.blinkT = 1.5 + rnd() * 3;
          for (const k in S.shake) { S.shake[k] -= dt; if (S.shake[k] <= 0) delete S.shake[k]; }
          for (const m of motes) { m.p += dt * m.s; m.x += Math.cos(m.p) * 3 * dt; m.y += (Math.sin(m.p * 0.7) * 2 + 1.5) * dt; if (m.y > 140) { m.y = 12; m.x = 150 + Math.random() * 84; } }
          S.panelT += dt;
          if (S.phase === "intro" || S.phase === "pick" || S.phase === "between") { panelInput(S.phase); return; }
          if (S.phase === "won" || S.phase === "lost") { S.endT += dt; if (S.endT > (S.phase === "won" ? 1.4 : 0.8)) finish(); return; }
          if (S.phase === "deal") { S.dealT += dt; layout(); S.wait -= dt; return; }
          if (S.phase !== "play") return;
          const G = S.G;
          S.playMs += dt0 * 1000;
          if (S.wait > 0) { S.wait -= dt; layout(); return; }
          if (G.phase === "over") { layout(); return; }
          if (mover(G) === 1) cpuTurn(dt);
          else if (S.auto) autoHuman(dt);
          else {
            aimCursor();
            humanInput();
            // nothing to beat with: say so, then take
            if (G.phase === "defend" && legalSet().size === 0 && mover(G) === 0) {
              S.noBeat = (S.noBeat || 0) + dt;
              if (S.noBeat > 2.2) { S.noBeat = 0; humanAction(); }
            } else S.noBeat = 0;
          }
          layout();
        },
        draw(g, alpha) {
          drawScene(g);
          if (S.G) drawCards(g);
          drawHud(g);
          fx.draw(g);
          if (S.phase === "intro") drawIntro(g);
          else if (S.phase === "pick") drawPick(g);
          else if (S.phase === "between") drawBetween(g);
          else if (S.phase === "won" || S.phase === "lost") drawEnd(g);
          void alpha;
        },
      };

      // ======================================================= drawing
      function drawScene(g) {
        const t = S.t;
        g.drawImage(ROOM, 0, 0);
        // the window: the sky, then hills and pines drifting past at their own speeds
        g.save();
        g.beginPath(); g.rect(15, 5, 74, 26); g.clip();
        WG.art.sky(g, 15, 5, 74, 26, t, { seed: 3, top: "#04070F", bottom: "#1A2C5A", curtain: 0.32, amount: 1.25 });
        WG.art.moon(g, 76, 10, 3);
        const cam = t * 4 + (S.cursor || 0) * 3;
        g.translate(15, 5);
        LAYERS.draw(g, cam, 0);
        g.restore();
        g.drawImage(FRAME, 0, 0);
        // the samovar steams
        const st = (t * 0.7) % 1;
        g.fillStyle = "rgba(234,240,250," + (0.35 * (1 - st)).toFixed(2) + ")";
        g.fillRect(116 + Math.round(Math.sin(t * 2) * 1), 4 - Math.round(st * 6), 1, 2);
        g.fillRect(118 + Math.round(Math.sin(t * 2 + 1) * 1), 3 - Math.round(((t * 0.7 + 0.5) % 1) * 6), 1, 1);
        // the chalkboard
        drawBoard(g);
        // the lamp sways a little
        const sw = Math.round(Math.sin(t * 0.8) * 1.2);
        // the opponent under the lamp
        const bob = Math.round(Math.sin(t * 1.4) * 0.6 + 0.3);
        const blink = S.blinkT < 0;
        const talk = S.talkT > 0 && Math.floor(t * 9) % 2 === 0;
        const mood = S.thinking && S.mood === "idle" ? "think" : S.mood;
        const img = bust(S.opp, mood, blink, talk);
        g.drawImage(img, 176, 13 + bob);
        // the light falls from the shade over the table
        g.fillStyle = "rgba(255,240,194,.05)";
        g.beginPath(); g.moveTo(178 + sw, 9); g.lineTo(206 + sw, 9); g.lineTo(240, RIM); g.lineTo(144, RIM); g.closePath(); g.fill();
        g.drawImage(TABLE, 0, RIM);
        g.fillStyle = "rgba(255,240,194,.035)";
        WG.art.ellipse(g, 192 + sw * 3, 112, 120, 56, "rgba(255,240,194,.04)");
        // the lamp: cord, green enamel shade, the warm rim
        g.fillStyle = "#04070F"; g.fillRect(191 + sw, 0, 2, 3);
        g.fillStyle = "#0B4A33"; g.fillRect(181 + sw, 2, 22, 2); g.fillRect(179 + sw, 4, 26, 3);
        g.fillStyle = "#1FA874"; g.fillRect(182 + sw, 2, 12, 1); g.fillRect(180 + sw, 4, 10, 1);
        g.fillStyle = "#05291C"; g.fillRect(179 + sw, 7, 26, 1);
        g.fillStyle = "#FFF0C2"; g.fillRect(180 + sw, 8, 24, 1);
        g.fillStyle = "#FFD27A"; g.fillRect(183 + sw, 9, 18, 1);
        // dust in the light
        for (const m of motes) { if (Math.sin(t * 1.3 + m.p * 4) < 0.2) continue; g.fillStyle = "rgba(255,240,194,.45)"; g.fillRect(Math.round(m.x + sw), Math.round(m.y), 1, 1); }
        // the opponent's name on a brass plate on the wall
        const nm = (S.opp.short || S.opp.name).toUpperCase();
        const w = WG.textWidth(nm) + 8;
        g.fillStyle = "#2A1E00"; g.fillRect(213, 23, w + 2, 10);
        g.fillStyle = "#C98A1B"; g.fillRect(214, 24, w, 8); g.fillStyle = "#FFD27A"; g.fillRect(214, 24, w, 1); g.fillStyle = "#6B4A0A"; g.fillRect(214, 31, w, 1);
        WG.text(g, nm, 218, 24, { color: "#2A1E00" });
        if (S.bubble) drawBubble(g, S.bubble);
      }
      function drawBoard(g) {
        const chalk = "#EAF0FA", dim = "#A9B6CD";
        if (stage) {
          WG.text(g, "СЕРИЯ", 339, 8, { align: "center", color: dim });
          WG.text(g, S.series[0] + ":" + S.series[1], 339, 16, { scale: 2, align: "center", color: chalk });
          // two marks per side
          for (let i = 0; i < 2; i++) { g.fillStyle = i < S.series[0] ? "#FFD27A" : "#3B5A50"; g.fillRect(306 + i * 5, 21, 3, 3); g.fillStyle = i < S.series[1] ? "#FF8F8F" : "#3B5A50"; g.fillRect(367 - i * 5, 21, 3, 3); }
        } else {
          WG.text(g, S.phase === "pick" ? "ВЫБЕРИ" : WG.levelName(S.level).toUpperCase(), 339, 8, { align: "center", color: dim });
          WG.text(g, String(S.wins), 339, 16, { scale: 2, align: "center", color: chalk });
          WG.text(g, plural(S.wins, "победа", "победы", "побед"), 339, 16 + 15, { align: "center", color: dim });
        }
      }
      function wrap(text, max) {
        const words = text.split(" "), lines = [];
        let cur = "";
        for (const w of words) { const t = cur ? cur + " " + w : w; if (WG.textWidth(t) > max && cur) { lines.push(cur); cur = w; } else cur = t; }
        if (cur) lines.push(cur);
        return lines;
      }
      function drawBubble(g, b) {
        const lines = wrap(b.text, 74);
        const w = Math.max(...lines.map((l) => WG.textWidth(l))) + 10, h = lines.length * 8 + 5;
        const x = 214, y = Math.max(1, 21 - h);
        const k = Math.min(1, b.t / 0.12);
        if (k < 1 && Math.floor(b.t * 30) % 2) return;
        g.fillStyle = "#0A0F1E"; g.fillRect(x - 1, y, w + 2, h); g.fillRect(x, y - 1, w, h + 2);
        g.fillStyle = PAPER; g.fillRect(x, y, w, h);
        g.fillStyle = "#D9CCAC"; g.fillRect(x, y + h - 1, w, 1);
        // the tail toward the speaker
        g.fillStyle = "#0A0F1E"; g.fillRect(x - 4, y + h - 3, 4, 3); g.fillRect(x - 6, y + h - 1, 3, 2);
        g.fillStyle = PAPER; g.fillRect(x - 3, y + h - 2, 4, 1); g.fillRect(x - 5, y + h, 1, 0);
        lines.forEach((l, i) => WG.text(g, l, x + 5, y + 3 + i * 8, { color: "#14182A" }));
      }
      function drawCardAt(g, c, p, extra) {
        const v = S.vis[c];
        const sx = S.shake[c] ? Math.round(Math.sin(S.shake[c] * 60) * 2) : 0;
        let w = Math.round(lerp(CW, MW, p.mini)), h = Math.round(lerp(CH, MH, p.mini));
        const x0 = Math.round(p.x) + sx, y0 = Math.round(p.y);
        const fw = Math.max(1, Math.round(w * p.flip));
        const x = x0 + Math.round((w - fw) / 2);
        // the shadow: further when the card is in the air
        const lift = p.k < 1 ? Math.round(Math.sin(Math.PI * p.k) * 4) : 0;
        if (v.rot) {
          g.fillStyle = "rgba(4,10,9,.35)"; g.fillRect(x0 + 2, y0 + 2, CH, CW);
          g.drawImage(ART.trump(c), x0, y0);
          return;
        }
        g.fillStyle = "rgba(4,10,9,.38)"; g.fillRect(x + 1 + lift, y0 + 2 + lift, fw, h - 1);
        let img;
        if (!p.face) img = p.mini > 0.5 ? ART.mini() : ART.back();
        else img = ART.face(c);
        if (fw === img.width && h === img.height) g.drawImage(img, x, y0);
        else g.drawImage(img, x, y0, fw, h);
        if (extra && extra.dim) { g.fillStyle = "rgba(8,14,30,.42)"; g.fillRect(x, y0, fw, h); }
        if (extra && extra.ring) {
          const on = Math.floor(S.t * 4) % 2 ? "#7FE6F4" : "#D2FAFF";
          g.fillStyle = on;
          g.fillRect(x + 1, y0 - 1, fw - 2, 1); g.fillRect(x + 1, y0 + h, fw - 2, 1); g.fillRect(x - 1, y0 + 1, 1, h - 2); g.fillRect(x + fw, y0 + 1, 1, h - 2);
          g.fillRect(x, y0, 1, 1); g.fillRect(x + fw - 1, y0, 1, 1); g.fillRect(x, y0 + h - 1, 1, 1); g.fillRect(x + fw - 1, y0 + h - 1, 1, 1);
        }
      }
      function drawCards(g) {
        const G = S.G;
        const my = humanTurn();
        const L = my ? legalSet() : null;
        const hand = sortedHand();
        const cur = my ? hand[S.cursor] : -1;
        const list = [];
        for (let c = 0; c < 36; c++) {
          const v = S.vis[c];
          const p = visPos(v);
          list.push({ c, p, z: p.k < 1 && v.t0 >= 0 && S.t - v.t0 >= v.del ? 500 + v.z : v.z });
        }
        // the deck's riffle during the first moments of a deal
        if (S.phase === "deal" && S.dealT < 0.7) {
          for (const it of list) if (G.deck.includes(it.c) || G.order.includes(it.c)) {
            const s = Math.sin(Math.min(1, S.dealT / 0.7) * Math.PI);
            it.p = Object.assign({}, it.p, { x: it.p.x + (it.c % 2 ? -1 : 1) * Math.round(s * 12), y: it.p.y - (it.c % 3) });
          }
        }
        list.sort((a, b) => a.z - b.z);
        // the trump stays visible under the deck; once the deck is gone the trump suit is shown where it lay
        for (const it of list) {
          const inDeck = G.deck.includes(it.c) && it.p.k >= 1 && it.c !== G.trumpCard;
          const di = inDeck ? G.deck.indexOf(it.c) : -1;
          if (inDeck && di < G.deck.length - 8 && di % 3) continue; // only the visible edge of a tall deck
          drawCardAt(g, it.c, it.p, it.c === cur ? { ring: true } : L && G.hands[0].includes(it.c) && !L.has(it.c) ? { dim: true } : null);
        }
        if (!G.deck.length || (G.deck.length === 1)) {
          // the trump's suit, stitched into the felt
          if (!G.deck.length) {
            const sp = ART.suit(G.trump, 13, { ring: "#0A2A25" });
            g.drawImage(sp, 30, 92);
            WG.text(g, "КОЗЫРЬ", 37, 110, { align: "center", color: "#8FB8AA" });
          }
        }
      }
      function drawHud(g) {
        const G = S.G;
        if (!G || S.phase === "pick" || S.phase === "intro") return;
        // the deck count on the deck, the trump's suit under it
        if (G.deck.length > 1) {
          const n = String(G.deck.length), top = Math.floor((G.deck.length - 1) / 5);
          const w = WG.textWidth(n) + 6, x = DECK.x + CW - w + 3 - top, y = DECK.y - 5 - top;
          g.fillStyle = "#04070F"; g.fillRect(x - 1, y, w + 2, 9); g.fillRect(x, y - 1, w, 11);
          g.fillStyle = "#26324F"; g.fillRect(x, y, w, 9);
          WG.text(g, n, x + 3, y + 1, { color: "#EAF0FA" });
        }
        if (G.deck.length) {
          const sp = ART.suit(G.trump, 7);
          const lw = WG.textWidth("козырь") + 10;
          const x0 = DECK.x + 15 - Math.round(lw / 2);
          g.drawImage(sp, x0, 127);
          WG.text(g, "козырь", x0 + 10, 127, { color: "#8FB8AA" });
        }
        if (G.discard.length) WG.text(g, "БИТО " + G.discard.length, DISC.x + 15, DISC.y + 50, { align: "center", color: "#8FB8AA" });
        // the status line and the action button
        let msg = "", col = "#EAF0FA";
        if (S.phase === "play" && G.phase !== "over") {
          if (S.auto) msg = "";
          else if (mover(G) === 1) msg = S.opp.name + (G.phase === "defend" ? " отбивается…" : " думает…");
          else if (G.phase === "defend") { msg = legalSet().size ? "Отбей карту или «Беру»" : "Нечем крыть — придётся брать"; col = legalSet().size ? "#EAF0FA" : "#FF8F8F"; }
          else if (G.phase === "add") msg = "Соперник берёт — подкинь ещё или «Хватит»";
          else if (G.table.length) msg = "Подкинь или «Бито»";
          else msg = "Твой ход — выбери карту";
          if (S.hintT > 0 && S.hint) { msg = S.hint; col = "#FFD27A"; }
        }
        if (msg && S.wait <= 0 && !S.toast) WG.text(g, msg, 192, 125, { align: "center", color: col, shadow: "#04231A" });
        // the opponent's card count, a small pill under the fan
        if (G.hands[1].length && !S.revealed) {
          const n = G.hands[1].length, [x, y] = oppPos(n, n - 1);
          const t = String(n), w = WG.textWidth(t) + 6;
          g.fillStyle = "#04070F"; g.fillRect(x + MW - 3, y + MH - 4, w + 2, 10);
          g.fillStyle = "#7E1A2E"; g.fillRect(x + MW - 2, y + MH - 3, w, 8);
          WG.text(g, t, x + MW + 1, y + MH - 3, { color: "#FFE1E5" });
        }
        // toasts
        if (S.toast) {
          const T = S.toast, k = T.t;
          if (!(k > 1.4 && Math.floor(k * 20) % 2)) {
            const y = 112 - Math.round((1 - ease(Math.min(1, k / 0.18))) * 8);
            const pw = Math.max(WG.textWidth(T.text, 2), T.sub ? WG.textWidth(T.sub) : 0) + 20;
            const ph = T.sub ? 30 : 20;
            const x0 = Math.round(192 - pw / 2);
            g.fillStyle = "rgba(4,7,15,.78)"; g.fillRect(x0, y - 4, pw, ph);
            g.fillStyle = "#26324F"; g.fillRect(x0, y - 4, pw, 1); g.fillRect(x0, y - 4 + ph - 1, pw, 1);
            WG.text(g, T.text, 192, y, { scale: 2, align: "center", color: T.color, outline: "#04070F" });
            if (T.sub) WG.text(g, T.sub, 192, y + 17, { align: "center", color: "#C9D6F2" });
          }
        }
        const lab = actionLabel();
        if (lab && S.wait <= 0) drawButton(g, BTN.x, BTN.y, BTN.w, BTN.h, lab, S.btnDown > 0, G.phase === "defend" && !legalSet().size);
      }
      function drawButton(g, x, y, w, h, label, down, hot) {
        const o = down ? 1 : 0;
        g.fillStyle = "#04070F"; g.fillRect(x - 1, y + 1, w + 2, h + 1); g.fillRect(x, y, w, h + 2);
        const pulse = hot && Math.floor(S.t * 3) % 2;
        g.fillStyle = pulse ? "#8EF0C6" : "#34D399"; g.fillRect(x, y + o, w, h);
        g.fillStyle = "#C8FBE3"; g.fillRect(x + 1, y + o, w - 2, 1);
        g.fillStyle = "#1FA874"; g.fillRect(x, y + o + h - 2, w, 2);
        WG.text(g, label, x + w / 2, y + o + 4, { align: "center", color: "#05291C" });
        if (!down) { g.fillStyle = "#127A52"; g.fillRect(x, y + h, w, 1); }
      }
      function panelBox(g, x, y, w, h) {
        g.fillStyle = "rgba(4,7,15,.62)"; g.fillRect(0, 0, 384, 216);
        g.fillStyle = "#04070F"; g.fillRect(x - 2, y - 2, w + 4, h + 4);
        g.fillStyle = "#121B31"; g.fillRect(x, y, w, h);
        g.fillStyle = "#26324F"; g.fillRect(x, y, w, 1); g.fillRect(x, y, 1, h);
        g.fillStyle = "#0E1730"; g.fillRect(x, y + h - 1, w, 1); g.fillRect(x + w - 1, y, 1, h);
        // the aurora band across the top of the panel
        const band = ["#8B7CF6", "#22B8CF", "#34D399"];
        for (let i = 0; i < 3; i++) { g.fillStyle = band[i]; g.fillRect(x + 1, y + 1 + i, w - 2, 1); }
      }
      function drawIntro(g) {
        const o = S.opp, k = Math.min(1, S.panelT / 0.25);
        const x = 62, y = 30 + Math.round((1 - ease(k)) * 10), w = 260, h = 154;
        panelBox(g, x, y, w, h);
        WG.text(g, "СОПЕРНИК " + api.stage + " ИЗ " + LEAGUE.length, x + w / 2, y + 9, { align: "center", color: "#A9B6CD" });
        // the portrait, three times larger, in a frame
        const P = bust(o, S.panelT % 4 < 0.6 ? "happy" : "idle", S.blinkT < 0, false);
        g.fillStyle = "#04070F"; g.fillRect(x + 12, y + 22, 100, 100);
        g.fillStyle = "#1D2944"; g.fillRect(x + 14, y + 24, 96, 96);
        WG.art.sky(g, x + 14, y + 24, 96, 40, S.t, { seed: 21, top: "#04070F", bottom: "#142449", curtain: 0.5 });
        g.drawImage(P, x + 14, y + 24, 96, 96);
        WG.text(g, o.name.toUpperCase(), x + 120, y + 26, { color: GOLD_T, shadow: "#2A1E00" });
        WG.text(g, o.title, x + 120, y + 38, { color: "#A9B6CD" });
        wrap(o.about, 128).forEach((l, i) => WG.text(g, l, x + 120, y + 54 + i * 10, { color: "#EAF0FA" }));
        WG.text(g, "Серия до двух побед", x + 120, y + 84, { color: "#8EF0C6" });
        WG.text(g, "★★ — 2:0", x + 120, y + 96, { color: "#FFD27A" });
        WG.text(g, "★★★ — 2:0, во второй", x + 120, y + 106, { color: "#FFD27A" });
        WG.text(g, "партии не брать карты", x + 120, y + 115, { color: "#FFD27A" });
        drawButton(g, x + w / 2 - 40, y + h - 26, 80, 17, "СДАВАТЬ", false, false);
      }
      function drawPick(g) {
        const x = 62, y = 8, w = 260, h = 200;
        panelBox(g, x, y, w, h);
        WG.text(g, "СВОБОДНАЯ ИГРА", x + w / 2, y + 10, { scale: 2, align: "center", color: GOLD_T, shadow: "#2A1E00" });
        WG.text(g, "Побед подряд, пока не проиграешь", x + w / 2, y + 30, { align: "center", color: "#A9B6CD" });
        WG.text(g, "Выбери соперника и нажми ещё раз", x + w / 2, y + h - 14, { align: "center", color: "#7F8FB8" });
        LEVEL_LINES.forEach(([lv, name, about], i) => {
          const ry = 62 + i * 25 - 8, on = i === S.pickI;
          const op = LEAGUE.find((o) => o.id === FREE[lv]);
          if (on) { g.fillStyle = "#123A31"; g.fillRect(x + 6, ry, w - 12, 23); g.fillStyle = "#34D399"; g.fillRect(x + 6, ry, 2, 23); }
          g.drawImage(bust(op, on ? "happy" : "idle", false, false), x + 12, ry - 5 + 3, 24, 24);
          WG.text(g, name, x + 42, ry + 4, { color: on ? "#FFFFFF" : "#EAF0FA" });
          WG.text(g, op.short || op.name, x + 44 + WG.textWidth(name) + 6, ry + 4, { color: on ? "#FFD27A" : "#7F8FB8" });
          WG.text(g, about, x + 42, ry + 13, { color: on ? "#8EF0C6" : "#7F8FB8" });
          const best = WG.bestOf ? WG.bestOf("durak", lv) : null;
          if (best !== null && best !== undefined) WG.text(g, "★" + best, x + w - 12, ry + 8, { align: "right", color: "#FFD27A" });
        });
      }
      function drawBetween(g) {
        const x = 82, y = 52, w = 220, h = 112;
        panelBox(g, x, y, w, h);
        const r = S.result;
        const head = r === 0 ? "ПАРТИЯ ТВОЯ!" : r === 1 ? "ПАРТИЯ ПРОИГРАНА" : "НИЧЬЯ";
        WG.text(g, head, x + w / 2, y + 12, { scale: 2, align: "center", color: r === 0 ? GOLD_T : r === 1 ? RED_T : INK_T, shadow: "#04070F" });
        if (stage) {
          WG.text(g, "Серия", x + w / 2, y + 36, { align: "center", color: "#A9B6CD" });
          WG.text(g, "ТЫ  " + S.series[0] + " : " + S.series[1] + "  " + (S.opp.short || S.opp.name).toUpperCase(), x + w / 2, y + 48, { align: "center", scale: 1, color: "#EAF0FA" });
          WG.text(g, r === -1 ? "Ничья не считается — сдаём заново" : "Играем до двух побед", x + w / 2, y + 62, { align: "center", color: "#7F8FB8" });
          drawButton(g, x + w / 2 - 50, y + h - 28, 100, 17, "ДАЛЬШЕ", false, false);
        } else {
          WG.text(g, "Побед подряд: " + S.wins, x + w / 2, y + 40, { align: "center", color: "#EAF0FA" });
          WG.text(g, api.level === "adaptive" || S.level === "adaptive" ? "Соперник подстраивается под тебя" : "Проиграешь — серия закончится", x + w / 2, y + 54, { align: "center", color: "#7F8FB8" });
          drawButton(g, x + 14, y + h - 28, 92, 17, "ДАЛЬШЕ", false, false);
          g.fillStyle = "#04070F"; g.fillRect(x + w - 107, y + h - 28, 94, 19);
          g.fillStyle = "#1D2944"; g.fillRect(x + w - 106, y + h - 27, 92, 17);
          g.fillStyle = "#5F6F93"; g.fillRect(x + w - 106, y + h - 27, 92, 1);
          WG.text(g, "ЗАКОНЧИТЬ", x + w - 60, y + h - 22, { align: "center", color: "#EAF0FA" });
        }
      }
      function drawEnd(g) {
        const won = S.phase === "won";
        const k = Math.min(1, S.endT / 0.3);
        if (stage) {
          g.fillStyle = "rgba(4,7,15," + (0.55 * k).toFixed(2) + ")"; g.fillRect(0, 70, 384, 70);
          WG.text(g, won ? "СЕРИЯ ВЗЯТА!" : "СЕРИЯ ПРОИГРАНА", 192, 96, { scale: 3, align: "center", color: won ? GOLD_T : RED_T, outline: "#04070F" });
        } else {
          g.fillStyle = "rgba(4,7,15," + (0.55 * k).toFixed(2) + ")"; g.fillRect(0, 70, 384, 70);
          WG.text(g, "ПОБЕД ПОДРЯД: " + S.wins, 192, 96, { scale: 2, align: "center", color: GOLD_T, outline: "#04070F" });
        }
      }
      return inst;
    },
  });
})();
