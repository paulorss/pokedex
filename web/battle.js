/* Arena Pokémon Online — cliente (salão, draft dos 1.025 Pokémon, rodadas 3D e narração). */
(function () {
  "use strict";

  const $ = (s, el = document) => el.querySelector(s);
  const TOKEN_KEY = "duelo_token";
  const EVENT_MS = 1150;
  const DRAFT_SECONDS = 60;
  const INVITE_SECONDS = 30;
  const TOAST_MS = 4200;
  const TICKER_LINES = 3;
  const LOW_HP = 0.25, MID_HP = 0.5;
  const PAGE_STEP = 48;
  const STARTER_AVATARS = [1, 4, 7, 25, 39, 94, 133, 143, 150, 248, 448, 658];

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (n) => `<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const spriteUrl = (id) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${id}.png`;
  const artUrl = (id) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`;

  const S = {
    token: localStorage.getItem(TOKEN_KEY) || "", user: null, rules: null, rosterMap: new Map(), cooldowns: {}, ws: null, started: false,
    role: 1, roomId: null, opponent: null, game: null, live: null,
    team: [], locked: false, filter: "", search: "", sort: "id", limit: PAGE_STEP, avatar: 25, mode: "login",
    inviteId: null, inviteTimer: null, offlineTarget: null, arena: null, chosen: null, queue: Promise.resolve(),
  };

  function setCooldowns(raw) {
    const next = {};
    const now = Date.now();
    for (const [k, v] of Object.entries(raw || {})) {
      const pid = Number(k);
      const sec = Number(v?.remaining_seconds || 0);
      if (pid > 0 && sec > 0) next[pid] = now + sec * 1000;
    }
    S.cooldowns = next;
  }
  function cooldownLeft(pid) {
    const exp = S.cooldowns[pid];
    if (!exp) return 0;
    const left = Math.ceil((exp - Date.now()) / 1000);
    if (left <= 0) { delete S.cooldowns[pid]; return 0; }
    return left;
  }
  function formatCooldown(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m > 0) return `${m}m ${String(sec % 60).padStart(2, "0")}s`;
    return `${sec}s`;
  }
  const sfx = (fn, ...args) => { if (window.BattleAudio?.[fn]) window.BattleAudio[fn](...args); };

  /* ================= retratos Pokémon ================= */
  function portrait(c, useArt = false) {
    const id = c?.id || 25;
    const primary = useArt ? artUrl(id) : spriteUrl(id);
    const fallback = useArt ? spriteUrl(id) : artUrl(id);
    return `<span class="portrait"><img src="${primary}" alt="${esc(c?.name || "")}" loading="lazy" onerror="this.onerror=null;this.src='${fallback}'"/></span>`;
  }
  const creature = (id) => S.rosterMap.get(Number(id)) || S.rules?.roster?.[0];
  const avatarOf = (avatarId) => S.rosterMap.get(Number(avatarId)) || S.rosterMap.get(25) || S.rules?.roster?.[0] || { id: 25, name: "Pikachu", element: "electric" };
  const elName = (el) => S.rules?.elements?.[el]?.name || el;
  const elIcon = (el) => `<span class="type-dot e-${esc(el)}" aria-hidden="true"></span>`;
  const elChip = (el) => `<span class="el-chip e-${esc(el)}">${elIcon(el)}${esc(elName(el))}</span>`;
  function setAvatar(node, avatarId) {
    const c = avatarOf(avatarId);
    node.className = `avatar lg e-${c.element}`;
    node.innerHTML = portrait(c, false);
  }
  function trainerTier(rating = 1000) {
    if (rating >= 1300) return "Campeão";
    if (rating >= 1150) return "Elite Four";
    if (rating >= 1060) return "Líder de Ginásio";
    if (rating >= 980) return "Desafiante";
    return "Iniciante";
  }

  /* ================= notificações ================= */
  function toast(title, text = "", kind = "info") {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.style.setProperty("--life", `${TOAST_MS}ms`);
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    el.innerHTML = `${icon(kind === "error" ? "x" : kind === "ok" ? "check" : "spark")}<div><b>${esc(title)}</b>${text ? `<span>${esc(text)}</span>` : ""}</div><button aria-label="Dispensar">${icon("x")}</button>`;
    const close = () => {
      if (el.classList.contains("leaving")) return;
      el.classList.add("leaving");
      el.addEventListener("animationend", () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 400);
    };
    el.querySelector("button").addEventListener("click", close);
    $("#toasts").appendChild(el);
    setTimeout(close, TOAST_MS);
  }

  /* ================= API e conexão ================= */
  async function api(path, options = {}) {
    const headers = { "Content-Type": "application/json" };
    if (S.token) headers.Authorization = `Bearer ${S.token}`;
    const res = await fetch(`/api/battle${path}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "O servidor não respondeu como esperado.");
    return data;
  }
  const send = (action, payload = {}) => {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify({ action, ...payload }));
    else toast("Sem conexão", "Reconectando ao salão. Tente de novo em instantes.", "error");
  };

  function connect() {
    if (S.ws) { S.ws.onclose = null; S.ws.close(); }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/battle?token=${encodeURIComponent(S.token)}`);
    S.ws = ws;
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      const handler = HANDLERS[msg.type];
      if (handler) handler(msg);
    };
    ws.onclose = () => {
      if (S.ws !== ws || !S.token) return;
      if (S.roomId) { leaveRoom(); toast("Conexão perdida", "O duelo foi encerrado.", "error"); }
      setTimeout(() => { if (S.token && S.ws === ws) connect(); }, 2500);
    };
  }

  /* ================= telas ================= */
  const PANELS = ["duelAuth", "duelLobby", "duelDraft", "duelArena"];
  function show(id) {
    PANELS.forEach((p) => { $(`#${p}`).hidden = p !== id; });
    if (S.arena) { if (id === "duelArena" && battleTabActive()) S.arena.start(); else S.arena.stop(); }
  }
  const battleTabActive = () => $("#view-battle").classList.contains("active");

  /* ---------- entrar ---------- */
  function setAuthMode(mode) {
    S.mode = mode;
    const isRegister = mode === "register";
    $("#tabLogin").classList.toggle("active", !isRegister);
    $("#tabRegister").classList.toggle("active", isRegister);
    $("#tabLogin").setAttribute("aria-selected", String(!isRegister));
    $("#tabRegister").setAttribute("aria-selected", String(isRegister));
    $("#registerOnly").hidden = !isRegister;
    $("#btnDuelAuth").textContent = isRegister ? "Criar conta e entrar" : "Entrar";
    $("#duelPass").autocomplete = isRegister ? "new-password" : "current-password";
    $("#duelAuthMsg").textContent = "";
  }
  function renderAvatarPicker() {
    $("#avatarPicker").innerHTML = STARTER_AVATARS.map((id) => {
      const c = avatarOf(id);
      return `<button type="button" role="radio" class="e-${c.element}" aria-checked="${c.id === S.avatar}" aria-label="${esc(c.name)}" title="${esc(c.name)}" data-id="${c.id}">${portrait(c)}</button>`;
    }).join("");
  }
  async function submitAuth() {
    const username = $("#duelUser").value.trim(), password = $("#duelPass").value;
    const msg = $("#duelAuthMsg"), btn = $("#btnDuelAuth");
    if (username.length < 3) { msg.textContent = "O usuário precisa de pelo menos 3 caracteres."; $("#duelUser").focus(); return; }
    if (password.length < 4) { msg.textContent = "A senha precisa de pelo menos 4 caracteres."; $("#duelPass").focus(); return; }
    btn.disabled = true; msg.textContent = "";
    try {
      const body = S.mode === "register"
        ? { username, password, display_name: $("#duelDisplay").value.trim() || null, avatar_id: S.avatar }
        : { username, password };
      const data = await api(`/${S.mode}`, { method: "POST", body: JSON.stringify(body) });
      S.token = data.user.token;
      localStorage.setItem(TOKEN_KEY, S.token);
      $("#duelPass").value = "";
      enterLobby(data.user);
      connect();
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }
  function logout() {
    S.token = ""; S.user = null;
    localStorage.removeItem(TOKEN_KEY);
    if (S.ws) { S.ws.onclose = null; S.ws.close(); S.ws = null; }
    show("duelAuth");
  }

  /* ---------- salão ---------- */
  function enterLobby(user) {
    if (user) S.user = user;
    setAvatar($("#meAvatar"), S.user.avatar_id);
    $("#meName").textContent = S.user.display_name;
    $("#meTier").textContent = trainerTier(S.user.rating);
    $("#meStats").textContent = `${S.user.rating} pts · ${S.user.wins} vitórias · ${S.user.losses} derrotas`;
    renderCooldownBanner();
    show("duelLobby");
    refreshBoards();
  }
  function renderCooldownBanner() {
    const el = $("#pokemonCenterBanner");
    if (!el) return;
    const ids = Object.keys(S.cooldowns).map(Number).filter((id) => cooldownLeft(id) > 0);
    if (!ids.length) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    el.innerHTML = `
      <div class="ko-banner-head">
        <b>Centro Pokémon · ${ids.length} em recuperação (24h)</b>
        <small>Pokémon derrotados em batalha retornam após 24 horas</small>
      </div>
      <div class="ko-pills">${ids.map((id) => {
        const c = creature(id);
        return `<span class="ko-pill"><img src="${spriteUrl(id)}" alt="" onerror="this.style.display='none'"/><span>#${id} ${esc(c?.name || id)}</span><small>${formatCooldown(cooldownLeft(id))}</small></span>`;
      }).join("")}</div>`;
  }
  async function refreshBoards() {
    try {
      const [rank, hist] = await Promise.all([api("/leaderboard"), api(`/history?user_id=${S.user.id}`)]);
      $("#rankList").innerHTML = rank.leaderboard.map((u) =>
        `<li class="${u.id === S.user.id ? "is-me" : ""}"><span class="who"><b>${esc(u.display_name)}</b><small>${u.wins} V · ${u.losses} D</small></span><span class="num">${u.rating}</span></li>`).join("")
        || `<li class="empty-row">Ninguém no ranking ainda.</li>`;
      $("#historyList").innerHTML = hist.history.map((h) => {
        const iAmP1 = h.player1_id === S.user.id, won = h.winner_id === S.user.id;
        return `<li><span class="result-tag ${won ? "win" : "loss"}">${won ? "Vitória" : "Derrota"}</span><span class="who"><b>${esc(iAmP1 ? h.player2_name : h.player1_name)}</b><small>${h.turns_played} rodadas</small></span></li>`;
      }).join("") || `<li class="empty-row">Você ainda não duelou. Comece treinando contra a IA.</li>`;
    } catch (err) {
      toast("Não foi possível carregar o ranking", err.message, "error");
    }
  }
  function renderTrainers(trainers) {
    const others = trainers.filter((t) => t.id !== S.user.id);
    const onlineCount = others.filter((t) => t.is_online).length;
    if ($("#onlineBadge")) $("#onlineBadge").textContent = `${onlineCount} online`;
    $("#trainerList").innerHTML = others.map((t) => {
      const c = avatarOf(t.avatar_id);
      const status = t.in_battle ? "busy" : t.is_online ? "on" : "";
      const statusTxt = t.in_battle ? "Em batalha" : t.is_online ? "Online" : "Offline";
      const label = t.in_battle ? "Ocupado" : t.is_online ? "Desafiar" : "Vs Eco IA";
      return `<li><span class="presence ${status}" title="${statusTxt}"></span><span class="avatar e-${c.element}">${portrait(c)}</span>
        <span class="who"><b>${esc(t.display_name)}</b><small>@${esc(t.username)} · ${t.rating} pts · ${statusTxt}</small></span>
        <button class="btn" data-challenge="${t.id}" ${t.in_battle ? "disabled" : ""}>${label}</button></li>`;
    }).join("") || `<li class="empty-row">Nenhum outro treinador cadastrado ainda. Convide um amigo ou treine contra a IA!</li>`;
  }
  function renderRules() {
    const r = S.rules;
    const wheel = Object.keys(r.elements).filter((el) => (r.strong_against[el] || []).length > 0).map((el) =>
      `<li>${elChip(el)} vence ${(r.strong_against[el] || []).map(elChip).join(" ")}</li>`).join("");
    $("#rulesBody").innerHTML = `
      <p>Escolha <b>${r.team_size} Pokémon</b> dentre os <b>${r.roster.length} da Pokédex</b> respeitando o limite de <b>${r.team_budget} SP (Stamina)</b>. Você tem ${r.draft_seconds}s para montar o trio (se o tempo acabar, o restante é preenchido automaticamente). A cada rodada, os dois treinadores escolhem em segredo em até ${r.round_seconds}s.</p>
      <ul>
        <li><b>Golpe</b>: ataque físico/rápido de base e gera <b>+1 Foco</b>.</li>
        <li><b>Técnica</b>: gasta <b>${r.tech_cost} de Foco</b>, golpe especial do tipo com alto dano e efeito tático (Queimar, Drenar Foco, Regenerar, Quebrar Guarda ou Ímpeto prioritário).</li>
        <li><b>Guarda</b>: amortece ataques e rende <b>+2 de Foco</b>. Não pode ser usada 2 rodadas seguidas.</li>
        <li><b>Trocar</b>: envia outro Pokémon do trio antes dos golpes, aproveitando vantagens de tipo.</li>
        <li><b>Centro Pokémon (24h)</b>: qualquer Pokémon seu que for derrotado (0 HP) em duelo fica indisponível por <b>24 horas</b> até se recuperar.</li>
      </ul>
      <p>O mais rápido ataca primeiro. Vence quem derrotar os ${r.team_size} Pokémon do adversário.</p>
      <ul class="wheel">${wheel}</ul>`;
  }

  /* ---------- draft ---------- */
  const teamCost = () => S.team.reduce((sum, id) => sum + (creature(id)?.cost || 0), 0);
  function getFilteredRoster() {
    const q = (S.search || "").trim().toLowerCase();
    const list = S.rules.roster.filter((c) => {
      if (S.filter && !(c.types || [c.element]).includes(S.filter)) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q)
        || String(c.id).includes(q)
        || (c.types_pt || []).some((t) => t.toLowerCase().includes(q));
    });
    if (S.sort === "cost-asc") list.sort((a, b) => a.cost - b.cost || a.id - b.id);
    else if (S.sort === "cost-desc") list.sort((a, b) => b.cost - a.cost || a.id - b.id);
    else if (S.sort === "spd-desc") list.sort((a, b) => b.spd - a.spd || a.id - b.id);
    else if (S.sort === "atk-desc") list.sort((a, b) => b.atk - a.atk || a.id - b.id);
    else if (S.sort === "hp-desc") list.sort((a, b) => b.hp - a.hp || a.id - b.id);
    else list.sort((a, b) => a.id - b.id);
    return list;
  }
  function renderDraft() {
    const r = S.rules, cost = teamCost(), left = r.team_budget - cost;
    $("#budgetFill").style.transform = `scaleX(${Math.min(1, cost / r.team_budget)})`;
    $("#budgetText").textContent = `${cost} / ${r.team_budget} SP (${left} SP livres)`;
    $("#draftSlots").innerHTML = Array.from({ length: r.team_size }, (_, i) => {
      const c = S.team[i] ? creature(S.team[i]) : null;
      return c
        ? `<button class="slot filled e-${c.element}" data-remove="${c.id}" ${S.locked ? "disabled" : ""} aria-label="Remover ${esc(c.name)}">${portrait(c)}<span><b>#${c.id} ${esc(c.name)}</b>${esc((c.types_pt || [elName(c.element)]).join(" / "))} · ${c.cost} SP</span></button>`
        : `<div class="slot">Vaga ${i + 1}</div>`;
    }).join("");
    $("#elementChips").innerHTML = [["", "Todos"], ...Object.keys(r.elements).map((el) => [el, elName(el)])].map(([el, name]) =>
      `<button class="chip ${el ? `e-${el}` : ""}" aria-pressed="${S.filter === el}" data-filter="${el}">${el ? elIcon(el) : ""}${esc(name)}</button>`).join("");

    const filtered = getFilteredRoster();
    const visible = filtered.slice(0, S.limit);
    $("#draftMatchCount").textContent = `Exibindo ${visible.length} de ${filtered.length} Pokémon disponíveis`;
    $("#rosterMoreWrap").hidden = visible.length >= filtered.length;

    $("#rosterGrid").innerHTML = visible.map((c) => {
      const picked = S.team.includes(c.id);
      const koSec = cooldownLeft(c.id);
      const blocked = S.locked || (!picked && (koSec > 0 || S.team.length >= r.team_size || c.cost > left));
      return `<button class="pick e-${c.element}${koSec > 0 ? " ko" : ""}" data-pick="${c.id}" aria-pressed="${picked}" ${blocked ? "disabled" : ""}>
        ${portrait(c)}<b>${elIcon(c.element)}#${c.id} ${esc(c.name)}</b><span class="cost" title="Custo em Stamina">${c.cost} SP</span>
        <span class="meta">${esc((c.types_pt || [elName(c.element)]).join("/"))} · HP ${c.hp} · Atq ${c.atk} · Def ${c.def} · Vel ${c.spd}</span>
        <span class="tech">${esc(c.tech.name)}: ${esc(c.tech.effect_text)}</span>
        ${koSec > 0 ? `<span class="ko-badge" title="Derrotado recentemente">Centro Pokémon · ${formatCooldown(koSec)}</span>` : ""}</button>`;
    }).join("") || `<p style="grid-column:1/-1;color:var(--fg-soft)">Nenhum Pokémon encontrado para este filtro.</p>`;

    const btn = $("#btnLockTeam");
    btn.disabled = S.locked || S.team.length !== r.team_size;
    $("span", btn).textContent = S.locked ? "Trio confirmado" : S.team.length === r.team_size ? "Confirmar trio" : `Escolha ${r.team_size - S.team.length}`;
    if ($("#btnAutoPick")) $("#btnAutoPick").disabled = S.locked || S.team.length >= r.team_size;
  }
  function autoFillDraft() {
    if (S.locked) return;
    sfx("unlock");
    sfx("playSfx", "click");
    const r = S.rules;
    const picked = [...S.team];
    let spent = teamCost();
    const usedEls = new Set(picked.map((id) => creature(id)?.element));
    while (picked.length < r.team_size) {
      const slotsLeft = r.team_size - picked.length;
      const maxAllow = r.team_budget - spent - 200 * (slotsLeft - 1);
      let candidates = r.roster.filter((c) => !picked.includes(c.id) && cooldownLeft(c.id) === 0 && c.cost <= maxAllow);
      if (!candidates.length) candidates = [...r.roster].filter((c) => !picked.includes(c.id) && cooldownLeft(c.id) === 0).sort((a, b) => a.cost - b.cost);
      if (!candidates.length) break;
      const diverse = candidates.filter((c) => !usedEls.has(c.element) && c.cost >= 320 && c.cost <= 560);
      const pool = diverse.length ? diverse : candidates;
      const chosen = pool[Math.floor(Math.random() * pool.length)];
      picked.push(chosen.id);
      usedEls.add(chosen.element);
      spent += chosen.cost;
    }
    S.team = picked;
    renderDraft();
    send("draft_update", { room_id: S.roomId, team_ids: S.team, locked: false });
  }
  function togglePick(id) {
    if (S.locked || (!S.team.includes(id) && cooldownLeft(id) > 0)) return;
    sfx("unlock");
    sfx("playSfx", "click");
    S.team = S.team.includes(id) ? S.team.filter((x) => x !== id) : [...S.team, id];
    renderDraft();
    send("draft_update", { room_id: S.roomId, team_ids: S.team, locked: false });
  }
  function setDraftTimer(seconds) {
    const el = $("#draftTimer");
    el.style.setProperty("--p", String(seconds / DRAFT_SECONDS));
    el.classList.toggle("low", seconds <= 10);
    $("b", el).textContent = seconds;
  }
  function setOpponentDraft(count, locked) {
    const name = S.opponent.display_name;
    $("#draftOpp").textContent = locked ? `${name} já confirmou o trio.` : `${name} escolheu ${count} de ${S.rules.team_size}.`;
  }

  /* ---------- arena ---------- */
  const sideOf = (player) => (player === S.role ? "me" : "foe");
  const playerOf = (side) => (side === "me" ? S.role : 3 - S.role);
  const teamOf = (g, player) => g[`p${player}_team`];
  const activeOf = (g, player) => teamOf(g, player)[g[`p${player}_active_idx`]];

  function arena2D(container) {
    container.innerHTML = `<div class="flat"><div class="fig me"></div><div class="fig foe"></div></div>`;
    const fig = (side) => $(`.fig.${side}`, container);
    const pulse = async (el, cls, ms) => { el.classList.add(cls); await sleep(ms); el.classList.remove(cls); };
    return {
      setCreature(side, def) { const el = fig(side); el.classList.remove("down", "guard"); el.innerHTML = portrait(def, true); return Promise.resolve(); },
      async play(ev, side, def) {
        const el = fig(side), foe = fig(side === "me" ? "foe" : "me");
        if (ev.t === "attack") { await pulse(el, side === "me" ? "lunge-r" : "lunge-l", 260); await pulse(foe, "hit", 220); }
        else if (ev.t === "guard") el.classList.add("guard");
        else if (ev.t === "faint") el.classList.add("down");
        else if (ev.t === "switch" || ev.t === "enter") this.setCreature(side, def);
        else if (ev.t === "burn") await pulse(el, "hit", 200);
      },
      clearGuards() { container.querySelectorAll(".fig").forEach((f) => f.classList.remove("guard")); },
      celebrate() { return Promise.resolve(); },
      screenPos(side) {
        const a = fig(side).getBoundingClientRect(), b = container.getBoundingClientRect();
        return { x: a.left - b.left + a.width / 2, y: a.top - b.top };
      },
      start() {}, stop() {}, dispose() { container.innerHTML = ""; },
    };
  }
  function createArena() {
    if (S.arena) S.arena.dispose();
    const container = $("#stage3d");
    container.innerHTML = "";
    S.arena = (window.Arena3D && window.Arena3D.create(container)) || arena2D(container);
  }

  function buildPlate(side) {
    const pips = Array.from({ length: S.rules.max_foco }, () => "<i></i>").join("");
    $(side === "me" ? "#plateMe" : "#plateFoe").innerHTML = `
      <div class="plate-owner"><span data-owner></span><span class="ready" data-ready hidden>pronto</span></div>
      <div class="plate-top"><span data-el></span><b data-name></b><span data-hp></span></div>
      <div class="hp" data-bar><i class="ghost"></i><i class="fill"></i></div>
      <div class="plate-row"><span>Foco</span><div class="pips" data-pips>${pips}</div><span class="badge-burn" data-burn hidden>Queimando</span><div class="team-dots" data-dots></div></div>`;
  }
  function updatePlate(side, g) {
    const player = playerOf(side), c = activeOf(g, player);
    const root = $(side === "me" ? "#plateMe" : "#plateFoe");
    root.className = `plate ${side} e-${c.element}`;
    $("[data-owner]", root).textContent = g[`p${player}_name`];
    $("[data-el]", root).innerHTML = elIcon(c.element);
    $("[data-name]", root).textContent = c.name;
    $("[data-hp]", root).textContent = `${c.hp}/${c.max_hp}`;
    const ratio = c.hp / c.max_hp, bar = $("[data-bar]", root);
    bar.className = `hp ${ratio <= LOW_HP ? "low" : ratio <= MID_HP ? "mid" : ""}`;
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `Vida ${c.hp} de ${c.max_hp}`);
    bar.querySelectorAll("i").forEach((i) => { i.style.transform = `scaleX(${ratio})`; });
    root.querySelectorAll("[data-pips] i").forEach((p, i) => p.classList.toggle("on", i < c.foco));
    $("[data-burn]", root).hidden = !(c.burn > 0);
    $("[data-dots]", root).innerHTML = teamOf(g, player).map((m) => `<i class="e-${m.element} ${m.hp <= 0 ? "out" : ""}"></i>`).join("");
  }
  function setReady(g) {
    for (const side of ["me", "foe"]) {
      $(`${side === "me" ? "#plateMe" : "#plateFoe"} [data-ready]`).hidden = !g[`p${playerOf(side)}_ready`];
    }
  }
  function renderControls(enabled) {
    const g = S.game, me = activeOf(g, S.role), allowed = g[`p${S.role}_actions`] || { golpe: false, tecnica: false, guarda: false, trocar: [] };
    const panel = $("#actions");
    panel.className = `actions e-${me.element}`;
    $("#techName").textContent = me.tech.name;
    $("#techInfo").textContent = `${S.rules.tech_cost} de Foco · ${me.tech.effect_text}`;
    panel.querySelectorAll(".act").forEach((b) => {
      const kind = b.dataset.kind;
      b.disabled = !enabled || !allowed[kind];
      b.classList.toggle("chosen", S.chosen?.kind === kind);
      b.title = kind === "tecnica" && !allowed.tecnica ? `Faltam ${Math.max(0, S.rules.tech_cost - me.foco)} de Foco`
        : kind === "guarda" && !allowed.guarda ? "A Guarda não pode ser usada duas rodadas seguidas" : "";
    });
    const team = teamOf(g, S.role), activeIdx = g[`p${S.role}_active_idx`];
    $("#bench").innerHTML = team.map((c, i) => i === activeIdx ? "" :
      `<button class="bench-btn e-${c.element} ${S.chosen?.kind === "trocar" && S.chosen.idx === i ? "chosen" : ""}" data-switch="${i}" ${!enabled || !allowed.trocar.includes(i) ? "disabled" : ""}>
        ${portrait(c)}<span><b>${c.hp > 0 ? "Trocar para " : ""}${esc(c.name)}</b><small>${c.hp > 0 ? `Vida ${c.hp}/${c.max_hp} · Foco ${c.foco}` : "Vencido"}</small></span></button>`).join("");
  }
  function setHint(text) { $("#turnHint").textContent = text; }
  function runTurnBar(seconds) {
    const bar = $("#turnBar");
    bar.classList.remove("run");
    if (!seconds) return;
    bar.style.setProperty("--dur", `${seconds}s`);
    void bar.offsetWidth;
    bar.classList.add("run");
  }
  function narrate(text) {
    if (!text) return;
    const list = $("#ticker");
    const li = document.createElement("li");
    li.textContent = text;
    list.appendChild(li);
    while (list.children.length > TICKER_LINES) list.firstElementChild.remove();
  }
  function announce(title, sub = "") {
    const el = $("#announcer");
    el.innerHTML = `${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ""}`;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
  }
  function floatText(side, text, cls = "") {
    const pos = S.arena.screenPos(side);
    const el = document.createElement("span");
    el.className = `float ${cls}`;
    el.textContent = text;
    el.style.left = `${pos.x + (Math.random() - 0.5) * 30}px`;
    el.style.top = `${pos.y}px`;
    $("#floats").appendChild(el);
    el.addEventListener("animationend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 1500);
  }
  function buzz(pattern) { if (navigator.vibrate) navigator.vibrate(pattern); }

  function choose(choice) {
    if (S.chosen) return;
    S.chosen = choice;
    renderControls(false);
    setHint("Ação escolhida. Aguardando o oponente…");
    send("choose_action", { room_id: S.roomId, ...choice });
  }

  /** Aplica um evento ao estado local e devolve o lado que ele anima. */
  function applyEvent(ev, live) {
    const actor = activeOf(live, ev.p), foePlayer = 3 - ev.p;
    switch (ev.t) {
      case "switch": case "enter": live[`p${ev.p}_active_idx`] = ev.idx; break;
      case "guard": actor.foco = ev.foco; break;
      case "attack": actor.foco = ev.foco; activeOf(live, foePlayer).hp = ev.target_hp; break;
      case "status": actor.burn = 1; break;
      case "burn": case "heal": actor.hp = ev.hp; break;
      case "drain": actor.foco = ev.foco; break;
      case "faint": actor.hp = 0; actor.burn = 0; break;
      default: break;
    }
  }
  function decorateEvent(ev, live) {
    const side = sideOf(ev.p), targetSide = sideOf(3 - ev.p);
    const actor = activeOf(live, ev.p);
    if (ev.t === "attack") {
      if (ev.kind === "tecnica") {
        announce(ev.name, elName(ev.element));
        sfx("playSfx", "tech");
      }
      const cls = ev.mult > 1 ? "strong" : ev.mult < 1 ? "weak" : "";
      setTimeout(() => {
        sfx("playSfx", ev.mult > 1 ? "superHit" : ev.mult < 1 ? "weakHit" : "hit");
        floatText(targetSide, `-${ev.dmg}`, cls);
        if (ev.broke_guard) floatText(targetSide, "Guarda atravessada", "info");
        else if (ev.guarded) floatText(targetSide, "Amortecido", "info");
        else if (ev.mult > 1) floatText(targetSide, "Super eficaz!", "info");
        if (targetSide === "me") buzz(ev.kind === "tecnica" ? [30, 40, 60] : 25);
        if (ev.kind === "tecnica" || ev.mult > 1) { const st = $("#stage"); st.classList.remove("shake"); void st.offsetWidth; st.classList.add("shake"); }
        updatePlate(targetSide, live);
      }, ev.kind === "tecnica" ? 720 : 330);
    } else if (ev.t === "heal") {
      sfx("playSfx", "heal");
      floatText(side, `+${ev.heal}`, "heal");
    } else if (ev.t === "burn") {
      sfx("playSfx", "burn");
      floatText(side, `-${ev.dmg}`, "weak");
    } else if (ev.t === "drain") {
      sfx("playSfx", "drain");
      floatText(side, "Foco drenado", "info");
    } else if (ev.t === "status") {
      sfx("playSfx", "burn");
      floatText(side, "Em chamas", "info");
    } else if (ev.t === "guard") {
      sfx("playSfx", "guard");
      floatText(side, "Guarda", "info");
    } else if (ev.t === "switch" || ev.t === "enter") {
      sfx("playSfx", "sendOut");
      if (actor) setTimeout(() => sfx("playCry", actor.id, actor.name, false), 140);
    } else if (ev.t === "faint") {
      if (actor) {
        announce("NOCAUTE!", `${actor.name} fora de combate!`);
        sfx("playCry", actor.id, actor.name, true);
      }
      const st = $("#stage");
      if (st) { st.classList.remove("ko-flash"); void st.offsetWidth; st.classList.add("ko-flash"); }
      setTimeout(() => sfx("playSfx", "faint"), 160);
    }
  }
  async function playRound(msg) {
    runTurnBar(0);
    S.chosen = null;
    renderControls(false);
    setHint("Resolvendo a rodada…");
    const live = JSON.parse(JSON.stringify(S.game));
    S.live = live;
    for (const ev of msg.events) {
      if (!S.roomId) return;
      if (ev.t === "end") { narrate(ev.text); continue; }
      applyEvent(ev, live);
      const side = sideOf(ev.p);
      narrate(ev.text);
      decorateEvent(ev, live);
      const def = activeOf(live, ev.p);
      await Promise.all([Promise.race([S.arena.play(ev, side, def), sleep(EVENT_MS)]), sleep(EVENT_MS - 150)]);
      updatePlate("me", live); updatePlate("foe", live);
    }
    S.arena.clearGuards();
    S.game = msg.state;
    if (S.game.phase === "BATTLE") { updatePlate("me", S.game); updatePlate("foe", S.game); }
  }

  function leaveRoom() {
    sfx("stopBgm");
    S.roomId = null; S.game = null; S.chosen = null; S.queue = Promise.resolve();
    if (S.arena) { S.arena.dispose(); S.arena = null; }
    for (const id of ["duelResult", "duelConfirm"]) if ($(`#${id}`).open) $(`#${id}`).close();
    if (S.user) enterLobby();
  }
  const enqueue = (fn) => { S.queue = S.queue.then(fn).catch((err) => toast("Algo saiu do roteiro", err.message, "error")); };

  /* ================= mensagens do servidor ================= */
  const HANDLERS = {
    auth_success(msg) {
      S.user = { ...S.user, ...msg.user };
      if (msg.cooldowns) setCooldowns(msg.cooldowns);
      if (!S.roomId) enterLobby();
    },
    cooldowns_update(msg) {
      setCooldowns(msg.cooldowns || {});
      renderCooldownBanner();
    },
    battle_chat(msg) { showChatBubble(msg); },
    auth_error(msg) { toast("Sessão encerrada", msg.message, "error"); logout(); },
    error(msg) { toast("Não foi possível", msg.message, "error"); },
    lobby_update(msg) { if (S.user) renderTrainers(msg.trainers); },
    challenge_sent(msg) { toast("Convite enviado", `Aguardando ${msg.target} responder.`); },
    challenge_declined(msg) {
      toast("Convite recusado", `${msg.by} não pode duelar agora.`);
      if ($("#btnRematch")) { $("#btnRematch").disabled = false; $("#btnRematch").textContent = "Propor Revanche"; }
      if ($("#rematchBanner")) { $("#rematchBanner").hidden = true; $("#rematchBanner").innerHTML = ""; }
    },
    rematch_sent(msg) {
      if ($("#btnRematch")) { $("#btnRematch").disabled = true; $("#btnRematch").textContent = "Aguardando..."; }
      const ban = $("#rematchBanner");
      if (ban && $("#duelResult")?.open) {
        ban.hidden = false;
        ban.innerHTML = `<b>Convite de revanche enviado!</b><span>Aguardando ${esc(msg.target)} aceitar para escolher novas equipes...</span>`;
      } else {
        toast("Revanche enviada", `Aguardando ${msg.target} aceitar.`);
      }
    },
    rematch_received(msg) {
      S.inviteId = msg.invite_id;
      sfx("playEmote", "🔥");
      buzz([70, 40, 70]);
      clearTimeout(S.inviteTimer);
      S.inviteTimer = setTimeout(() => answerInvite(false), INVITE_SECONDS * 1000);
      const ban = $("#rematchBanner");
      if (ban && $("#duelResult")?.open) {
        ban.hidden = false;
        ban.innerHTML = `
          <b>🔥 ${esc(msg.challenger.display_name)} quer uma revanche!</b>
          <div class="dialog-actions">
            <button type="button" class="btn shoot small" id="btnRematchAccept">Aceitar Revanche</button>
            <button type="button" class="btn ghost small" id="btnRematchDecline">Recusar</button>
          </div>`;
        $("#btnRematchAccept", ban).addEventListener("click", () => answerInvite(true));
        $("#btnRematchDecline", ban).addEventListener("click", () => {
          answerInvite(false);
          ban.hidden = true;
          ban.innerHTML = "";
        });
        return;
      }
      setAvatar($("#inviteAvatar"), msg.challenger.avatar_id);
      $("#inviteTitle").textContent = `Revanche: ${msg.challenger.display_name}`;
      $("#inviteMsg").textContent = `${msg.challenger.rating} pontos · Aceita ir para a escolha de equipe?`;
      const bar = $("#inviteBar"); bar.style.animation = "none"; void bar.offsetWidth; bar.style.animation = "";
      if (!$("#duelInvite").open) $("#duelInvite").showModal();
    },
    challenge_received(msg) {
      S.inviteId = msg.invite_id;
      setAvatar($("#inviteAvatar"), msg.challenger.avatar_id);
      $("#inviteTitle").textContent = `${msg.challenger.display_name} desafia você`;
      $("#inviteMsg").textContent = `${msg.challenger.rating} pontos no ranking. O convite vale por ${INVITE_SECONDS} segundos.`;
      const bar = $("#inviteBar"); bar.style.animation = "none"; void bar.offsetWidth; bar.style.animation = "";
      if (!$("#duelInvite").open) $("#duelInvite").showModal();
      buzz([60, 40, 60]);
      clearTimeout(S.inviteTimer);
      S.inviteTimer = setTimeout(() => answerInvite(false), INVITE_SECONDS * 1000);
    },
    trainer_offline_prompt(msg) {
      S.offlineTarget = msg.target;
      setAvatar($("#offlineAvatar"), msg.target.avatar_id);
      $("#offlineTitle").textContent = `${msg.target.display_name} está fora`;
      $("#duelOffline").showModal();
    },
    battle_matched(msg) {
      if (S.arena) { S.arena.dispose(); S.arena = null; }
      if (msg.cooldowns) setCooldowns(msg.cooldowns);
      Object.assign(S, { roomId: msg.room_id, role: msg.role, opponent: msg.opponent, game: msg.state, team: [], locked: false, filter: "", search: "", sort: "id", limit: PAGE_STEP });
      if ($("#draftSearch")) $("#draftSearch").value = "";
      if ($("#draftSort")) $("#draftSort").value = "id";
      if ($("#rematchBanner")) { $("#rematchBanner").hidden = true; $("#rematchBanner").innerHTML = ""; }
      for (const id of ["duelInvite", "duelOffline", "duelResult", "duelConfirm"]) if ($(`#${id}`)?.open) $(`#${id}`).close();
      setDraftTimer(msg.state.draft_timer);
      setOpponentDraft(msg.opponent.is_bot ? S.rules.team_size : 0, Boolean(msg.opponent.is_bot));
      renderDraft();
      show("duelDraft");
    },
    draft_tick(msg) { setDraftTimer(msg.timer); },
    draft_updated(msg) { const foe = 3 - S.role; setOpponentDraft(msg[`p${foe}_count`], msg[`p${foe}_locked`]); },
    battle_started(msg) {
      enqueue(async () => {
        S.game = msg.state; S.chosen = null;
        $("#ticker").innerHTML = ""; $("#floats").innerHTML = "";
        if ($("#chatBubbles")) $("#chatBubbles").innerHTML = "";
        if ($("#stage")) $("#stage").classList.remove("victory-glow", "defeat-dim", "ko-flash");
        buildPlate("me"); buildPlate("foe");
        updatePlate("me", S.game); updatePlate("foe", S.game);
        $("#roundChip").textContent = "Preparar";
        renderControls(false);
        setHint("Os Pokémon entram na arena!");
        createArena();
        show("duelArena");
        updateAudioButtons();
        sfx("startBgm");
        sfx("playSfx", "sendOut");
        const meFirst = activeOf(S.game, S.role);
        const foeFirst = activeOf(S.game, 3 - S.role);
        sfx("playCry", meFirst.id, meFirst.name, false);
        setTimeout(() => sfx("playCry", foeFirst.id, foeFirst.name, false), 650);
        narrate(S.game.logs[S.game.logs.length - 1]);
        announce("Duelo!", `${S.game.p1_name} contra ${S.game.p2_name}`);
        await Promise.race([Promise.all([
          S.arena.setCreature("me", meFirst, { animate: true }),
          S.arena.setCreature("foe", foeFirst, { animate: true }),
        ]), sleep(1200)]);
      });
    },
    round_start(msg) {
      enqueue(() => {
        if (!S.roomId) return;
        S.game = msg.state; S.chosen = null;
        $("#roundChip").textContent = `Rodada ${S.game.round_no}`;
        updatePlate("me", S.game); updatePlate("foe", S.game); setReady(S.game);
        renderControls(true);
        setHint("Escolha sua ação. Sem escolha, seu Pokémon usa Golpe.");
        runTurnBar(S.game.round_seconds);
      });
    },
    ready_update(msg) { if (S.game) { Object.assign(S.game, msg); setReady(S.game); } },
    action_rejected(msg) { S.chosen = null; renderControls(true); setHint(msg.message); toast("Ação indisponível", msg.message, "error"); },
    round_result(msg) { enqueue(() => playRound(msg)); },
    battle_ended(msg) {
      enqueue(async () => {
        if (!S.roomId) return;
        sfx("stopBgm");
        runTurnBar(0); renderControls(false);
        const won = msg.winner === S.role;
        S.game = msg.state;
        const st = $("#stage");
        if (st) st.classList.add(won ? "victory-glow" : "defeat-dim");
        announce(won ? "VITÓRIA!" : "DERROTA...", won ? "Campeão da Arena!" : "Retorno ao Centro Pokémon");
        sfx("playSfx", won ? "victory" : "defeat");
        if (S.arena) {
          const anim = won
            ? S.arena.celebrate(sideOf(msg.winner || S.role))
            : (S.arena.defeatEffect ? S.arena.defeatEffect("me") : Promise.resolve());
          await Promise.race([anim, sleep(1250)]);
        }
        const dlg = $("#duelResult");
        dlg.classList.toggle("win", won);
        if ($("#resultBadge")) $("#resultBadge").textContent = won ? "🏆 Vitória na Arena" : "🏥 Derrota no Duelo";
        $("#resultArt").innerHTML = (teamOf(msg.state, msg.winner || S.role) || []).map((c) => `<span class="e-${c.element}">${portrait(c, true)}</span>`).join("");
        $("#resultTitle").textContent = won ? "Vitória Épica!" : "Derrota...";
        const last = msg.state.logs[msg.state.logs.length - 1] || "";
        $("#resultMsg").textContent = won
          ? `Você derrotou ${S.opponent.display_name} em ${msg.state.round_no} rodadas! ${/desistiu|saiu/.test(last) ? last : ""}`
          : `${msg.winner_name || S.opponent.display_name} venceu em ${msg.state.round_no} rodadas. Que tal uma revanche com um novo trio?`;
        const koList = (teamOf(msg.state, S.role) || []).filter((c) => c.hp <= 0 || c.fainted).map((c) => c.name);
        if ($("#resultSub")) {
          if (koList.length) {
            $("#resultSub").hidden = false;
            $("#resultSub").textContent = `Centro Pokémon (24h em recuperação): ${koList.join(", ")}`;
          } else {
            $("#resultSub").hidden = true;
          }
        }
        if ($("#rematchBanner")) { $("#rematchBanner").hidden = true; $("#rematchBanner").innerHTML = ""; }
        if ($("#btnRematch")) {
          $("#btnRematch").disabled = false;
          $("#btnRematch").textContent = S.opponent?.is_bot ? "Jogar Revanche" : "Propor Revanche";
        }
        buzz(won ? [40, 60, 40, 60, 120] : 140);
        if ($("#duelConfirm").open) $("#duelConfirm").close();
        dlg.showModal();
      });
    },
  };
  function answerInvite(accept) {
    clearTimeout(S.inviteTimer);
    if ($("#duelInvite").open) $("#duelInvite").close();
    if (!S.inviteId) return;
    send(accept ? "accept_challenge" : "decline_challenge", { invite_id: S.inviteId });
    S.inviteId = null;
  }

  /* ================= eventos da interface ================= */
  function bind() {
    $("#tabLogin").addEventListener("click", () => setAuthMode("login"));
    $("#tabRegister").addEventListener("click", () => setAuthMode("register"));
    $("#duelAuthForm").addEventListener("submit", submitAuth);
    $("#avatarPicker").addEventListener("click", (e) => {
      const b = e.target.closest("[data-id]");
      if (!b) return;
      S.avatar = Number(b.dataset.id);
      renderAvatarPicker();
    });
    $("#btnLogout").addEventListener("click", logout);
    $("#btnBot").addEventListener("click", () => { sfx("unlock"); send("start_bot_battle"); });
    $("#challengeForm").addEventListener("submit", () => {
      sfx("unlock");
      const name = $("#challengeUser").value.trim();
      if (!name) { $("#challengeUser").focus(); return; }
      send("challenge", { target_username: name });
      $("#challengeUser").value = "";
    });
    $("#trainerList").addEventListener("click", (e) => {
      sfx("unlock");
      const b = e.target.closest("[data-challenge]");
      if (b) send("challenge", { target_id: Number(b.dataset.challenge) });
    });
    $("#btnInviteAccept").addEventListener("click", () => answerInvite(true));
    $("#btnInviteDecline").addEventListener("click", () => answerInvite(false));
    $("#duelInvite").addEventListener("cancel", () => answerInvite(false));
    $("#btnOfflineGo").addEventListener("click", () => {
      $("#duelOffline").close();
      if (S.offlineTarget) send("challenge_offline_bot", { target_id: S.offlineTarget.id });
    });
    $("#btnOfflineCancel").addEventListener("click", () => $("#duelOffline").close());

    $("#rosterGrid").addEventListener("click", (e) => { const b = e.target.closest("[data-pick]"); if (b) togglePick(Number(b.dataset.pick)); });
    $("#draftSlots").addEventListener("click", (e) => { const b = e.target.closest("[data-remove]"); if (b) togglePick(Number(b.dataset.remove)); });
    $("#elementChips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-filter]");
      if (!b) return;
      S.filter = b.dataset.filter;
      S.limit = PAGE_STEP;
      renderDraft();
    });
    $("#draftSearch").addEventListener("input", (e) => {
      S.search = e.target.value;
      S.limit = PAGE_STEP;
      renderDraft();
    });
    $("#draftSort").addEventListener("change", (e) => {
      S.sort = e.target.value;
      S.limit = PAGE_STEP;
      renderDraft();
    });
    $("#btnLoadMoreRoster").addEventListener("click", () => {
      S.limit += PAGE_STEP;
      renderDraft();
    });
    $("#btnAutoPick").addEventListener("click", autoFillDraft);
    $("#btnLockTeam").addEventListener("click", () => {
      S.locked = true;
      renderDraft();
      send("draft_update", { room_id: S.roomId, team_ids: S.team, locked: true });
    });

    $("#actions").addEventListener("click", (e) => { sfx("unlock"); const b = e.target.closest(".act"); if (b && !b.disabled) { sfx("playSfx", "click"); choose({ kind: b.dataset.kind }); } });
    $("#bench").addEventListener("click", (e) => { sfx("unlock"); const b = e.target.closest("[data-switch]"); if (b && !b.disabled) { sfx("playSfx", "click"); choose({ kind: "trocar", idx: Number(b.dataset.switch) }); } });
    if ($("#quickChat")) $("#quickChat").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-emoji], [data-text]");
      if (!btn || !S.roomId) return;
      sfx("unlock");
      send("battle_chat", {
        room_id: S.roomId,
        emoji: btn.dataset.emoji || "",
        text: btn.dataset.text || "",
      });
    });
    if ($("#btnAudioToggle")) $("#btnAudioToggle").addEventListener("click", () => {
      sfx("unlock");
      const next = !(window.BattleAudio?.isSfxEnabled?.() ?? true);
      sfx("setSfx", next);
      if (next && !$("#duelArena").hidden && window.BattleAudio?.isBgmEnabled?.()) sfx("startBgm");
      updateAudioButtons();
    });
    if ($("#btnMusicToggle")) $("#btnMusicToggle").addEventListener("click", () => {
      sfx("unlock");
      const next = !(window.BattleAudio?.isBgmEnabled?.() ?? true);
      sfx("setBgm", next);
      if (next && !$("#duelArena").hidden && window.BattleAudio?.isSfxEnabled?.()) sfx("startBgm");
      updateAudioButtons();
    });
    document.addEventListener("keydown", (e) => {
      if ($("#duelArena").hidden || !battleTabActive() || e.target.closest("input, textarea, select, dialog")) return;
      const btn = $("#actions").querySelectorAll(".act")[Number(e.key) - 1];
      if (btn && !btn.disabled) choose({ kind: btn.dataset.kind });
    });
    $("#btnSurrender").addEventListener("click", () => $("#duelConfirm").showModal());
    $("#btnConfirmNo").addEventListener("click", () => $("#duelConfirm").close());
    $("#btnConfirmYes").addEventListener("click", () => { $("#duelConfirm").close(); send("surrender", { room_id: S.roomId }); });
    if ($("#btnRematch")) $("#btnRematch").addEventListener("click", () => {
      sfx("unlock");
      sfx("playSfx", "click");
      send("propose_rematch");
    });
    $("#btnBackToLobby").addEventListener("click", async () => {
      leaveRoom();
      try {
        const me = await api("/me");
        if (me.cooldowns) setCooldowns(me.cooldowns);
        enterLobby({ ...S.user, ...me.user });
      } catch (_) { logout(); }
    });
    $("#duelResult").addEventListener("cancel", (e) => e.preventDefault());
  }
  function showChatBubble(msg) {
    const host = $("#chatBubbles");
    if (!host) return;
    const isMe = msg.from_player === S.role;
    host.querySelectorAll(`.chat-bubble.${isMe ? "me" : "foe"}`).forEach((n) => n.remove());
    const el = document.createElement("div");
    el.className = `chat-bubble ${isMe ? "me" : "foe"}`;
    const whoLabel = msg.from_name || (isMe ? "Você" : "Oponente");
    el.innerHTML = `${msg.emoji ? `<span class="cb-emoji">${esc(msg.emoji)}</span>` : ""}<div><span class="cb-who">${esc(whoLabel)}</span><span class="cb-text">${esc(msg.text || (isMe ? "Provocou!" : "Emote!"))}</span></div>`;
    host.appendChild(el);
    sfx("playEmote", msg.emoji || msg.text || "");
    setTimeout(() => el.remove(), 3400);
  }
  function updateAudioButtons() {
    const sfxOn = window.BattleAudio?.isSfxEnabled?.() ?? true;
    const bgmOn = window.BattleAudio?.isBgmEnabled?.() ?? true;
    const bSfx = $("#btnAudioToggle"), bBgm = $("#btnMusicToggle");
    if (bSfx) {
      bSfx.classList.toggle("off", !sfxOn);
      $("span", bSfx).textContent = sfxOn ? "Som" : "Mudo";
    }
    if (bBgm) {
      bBgm.classList.toggle("off", !sfxOn || !bgmOn);
      $("span", bBgm).textContent = (sfxOn && bgmOn) ? "Música" : "Música off";
    }
  }

  async function boot() {
    if (S.started) return;
    S.started = true;
    try {
      S.rules = await api("/rules");
      S.rosterMap = new Map((S.rules.roster || []).map((c) => [c.id, c]));
    } catch (err) {
      S.started = false;
      $("#duelAuth").hidden = false;
      $("#duelAuthMsg").textContent = `Não foi possível carregar o jogo: ${err.message} Recarregue a página.`;
      return;
    }
    bind();
    renderAvatarPicker();
    renderRules();
    setAuthMode("login");
    if (!S.token) { show("duelAuth"); return; }
    try {
      const me = await api("/me");
      if (me.cooldowns) setCooldowns(me.cooldowns);
      enterLobby(me.user);
      connect();
    } catch (_) {
      S.token = "";
      localStorage.removeItem(TOKEN_KEY);
      show("duelAuth");
    }
  }

  document.addEventListener("viewchange", (e) => {
    if (e.detail === "battle") boot();
    if (S.arena) { if (e.detail === "battle" && !$("#duelArena").hidden) S.arena.start(); else S.arena.stop(); }
  });
  if (battleTabActive()) boot();
})();
