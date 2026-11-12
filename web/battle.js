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
  const PAGE_STEP = 60;
  const VS_INTRO_MS = 1700;
  const PREVIEW_DELAY_MS = 55;
  const STAT_ROWS = [["hp", "HP"], ["atk", "ATQ"], ["def", "DEF"], ["spd", "VEL"]];
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
    stage: null, preview: null, previewTimer: null, statMax: null, justPicked: null,
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
    if (id === "duelDraft") syncStage(); else disposeStage();
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
  /* palco 3D da seleção (com alternativa em imagem quando não há WebGL) */
  function stageFallback(container) {
    container.innerHTML = `<div class="sel-flat"></div>`;
    const host = $(".sel-flat", container);
    return {
      show(def) { host.className = `sel-flat e-${def.element}`; host.innerHTML = portrait(def, true); },
      slam() { host.classList.remove("slam"); void host.offsetWidth; host.classList.add("slam"); },
      start() {}, stop() {}, dispose() { container.innerHTML = ""; },
    };
  }
  function syncStage() {
    if (!S.stage) {
      const container = $("#select3d");
      container.innerHTML = "";
      S.stage = (window.Select3D && window.Select3D.create(container)) || stageFallback(container);
      const def = S.preview ? creature(S.preview) : null;
      if (def) S.stage.show(def);
    }
    if (battleTabActive()) S.stage.start(); else S.stage.stop();
  }
  function disposeStage() {
    clearTimeout(S.previewTimer);
    if (S.stage) { S.stage.dispose(); S.stage = null; }
  }
  function statMax() {
    if (!S.statMax) {
      S.statMax = Object.fromEntries(STAT_ROWS.map(([key]) => [key, Math.max(1, ...S.rules.roster.map((c) => c[key] || 0))]));
    }
    return S.statMax;
  }
  function restart(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }
  function callout(text, kind = "") {
    const el = $("#selCallout");
    el.textContent = text;
    el.className = `sel-callout ${kind}`;
    restart(el, "show");
  }
  function stageFlash() { restart($("#selFlash"), "show"); }

  /** Painel do lutador em destaque: nome, tipos, atributos e técnica. */
  function renderPreview() {
    const c = S.preview ? creature(S.preview) : null;
    const el = $("#selInfo");
    if (!c) { el.innerHTML = ""; return; }
    const max = statMax(), koSec = cooldownLeft(c.id);
    const types = c.types || [c.element];
    el.className = `sel-info e-${c.element}`;
    el.innerHTML = `
      <span class="si-no">Nº ${String(c.id).padStart(4, "0")}</span>
      <b class="si-name">${esc(c.name)}</b>
      <div class="si-types">${types.map(elChip).join("")}<span class="si-cost">${c.cost} SP</span></div>
      <dl class="si-stats">${STAT_ROWS.map(([key, label], i) =>
        `<div style="--i:${i}"><dt>${label}</dt><dd><i style="--v:${Math.min(1, (c[key] || 0) / max[key]).toFixed(3)}"></i></dd><span>${c[key] ?? "-"}</span></div>`).join("")}</dl>
      <p class="si-tech"><b>${esc(c.tech.name)}</b>${esc(c.tech.effect_text)}</p>
      ${koSec > 0 ? `<p class="si-ko">Centro Pokémon · volta em ${formatCooldown(koSec)}</p>` : ""}`;
    restart(el, "swap");
  }
  function setPreview(id) {
    const def = creature(id);
    if (!def || S.preview === def.id) return;
    S.preview = def.id;
    renderPreview();
    if (S.stage) S.stage.show(def);
    $("#rosterGrid").querySelectorAll(".pick.cursor").forEach((n) => n.classList.remove("cursor"));
    const tile = $(`#rosterGrid [data-pick="${def.id}"]`);
    if (tile) tile.classList.add("cursor");
  }
  function queuePreview(id) {
    clearTimeout(S.previewTimer);
    S.previewTimer = setTimeout(() => setPreview(id), PREVIEW_DELAY_MS);
  }
  function renderSlots() {
    const r = S.rules;
    $("#draftSlots").innerHTML = Array.from({ length: r.team_size }, (_, i) => {
      const c = S.team[i] ? creature(S.team[i]) : null;
      if (!c) return `<div class="slot"><i class="slot-n">${i + 1}</i><span>Vaga livre</span></div>`;
      const fresh = S.justPicked === c.id ? " fresh" : "";
      return `<button class="slot filled e-${c.element}${fresh}" data-remove="${c.id}" ${S.locked ? "disabled" : ""} aria-label="Remover ${esc(c.name)}">
        <i class="slot-n">${i + 1}</i>${portrait(c, true)}<span><b>${esc(c.name)}</b>${esc((c.types_pt || [elName(c.element)]).join(" / "))} · ${c.cost} SP</span></button>`;
    }).join("");
  }
  function pickTile(c, left) {
    const r = S.rules;
    const order = S.team.indexOf(c.id);
    const picked = order >= 0;
    const koSec = cooldownLeft(c.id);
    const blocked = S.locked || (!picked && (koSec > 0 || S.team.length >= r.team_size || c.cost > left));
    const cls = [`pick e-${c.element}`, koSec > 0 ? "ko" : "", blocked ? "blocked" : "", S.preview === c.id ? "cursor" : "", S.justPicked === c.id ? "fresh" : ""].filter(Boolean).join(" ");
    const label = `#${c.id} ${c.name}, ${(c.types_pt || [elName(c.element)]).join("/")}, ${c.cost} SP${koSec > 0 ? ", em recuperação" : ""}`;
    return `<button class="${cls}" data-pick="${c.id}" aria-pressed="${picked}" aria-disabled="${blocked}" aria-label="${esc(label)}">
      ${portrait(c)}<span class="pick-no">${c.id}</span><span class="cost" title="Custo em Stamina">${c.cost}</span>
      <b>${esc(c.name)}</b>${picked ? `<i class="pick-order">${order + 1}</i>` : ""}
      ${koSec > 0 ? `<span class="ko-badge" title="Derrotado recentemente">${formatCooldown(koSec)}</span>` : ""}</button>`;
  }
  function renderDraft() {
    const r = S.rules, cost = teamCost(), left = r.team_budget - cost;
    $("#budgetFill").style.transform = `scaleX(${Math.min(1, cost / r.team_budget)})`;
    $("#budgetText").textContent = `${cost} / ${r.team_budget} SP (${left} SP livres)`;
    renderSlots();
    $("#elementChips").innerHTML = [["", "Todos"], ...Object.keys(r.elements).map((el) => [el, elName(el)])].map(([el, name]) =>
      `<button class="chip ${el ? `e-${el}` : ""}" aria-pressed="${S.filter === el}" data-filter="${el}">${el ? elIcon(el) : ""}${esc(name)}</button>`).join("");

    const filtered = getFilteredRoster();
    const visible = filtered.slice(0, S.limit);
    $("#draftMatchCount").textContent = `Exibindo ${visible.length} de ${filtered.length} Pokémon disponíveis`;
    $("#rosterMoreWrap").hidden = visible.length >= filtered.length;
    if (!S.preview && visible.length) { S.preview = visible[0].id; renderPreview(); if (S.stage) S.stage.show(visible[0]); }

    const grid = $("#rosterGrid");
    const focusId = grid.contains(document.activeElement) ? document.activeElement.dataset.pick : null;
    grid.innerHTML = visible.map((c) => pickTile(c, left)).join("")
      || `<p style="grid-column:1/-1;color:var(--fg-soft)">Nenhum Pokémon encontrado para este filtro.</p>`;
    if (focusId) $(`[data-pick="${focusId}"]`, grid)?.focus({ preventScroll: true });
    S.justPicked = null;

    const btn = $("#btnLockTeam");
    btn.disabled = S.locked || S.team.length !== r.team_size;
    btn.classList.toggle("ready", !S.locked && S.team.length === r.team_size);
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
    const lead = creature(picked[picked.length - 1]);
    if (lead) { setPreview(lead.id); callout("Trio sorteado!"); }
    if (S.stage) S.stage.slam(0.8);
    stageFlash();
    renderDraft();
    send("draft_update", { room_id: S.roomId, team_ids: S.team, locked: false });
  }
  /** Motivo pelo qual o Pokémon não pode entrar no trio agora (ou "" quando pode). */
  function pickBlockReason(c) {
    if (cooldownLeft(c.id) > 0) return "Em recuperação";
    if (S.team.length >= S.rules.team_size) return "Trio completo";
    if (c.cost > S.rules.team_budget - teamCost()) return "Sem Stamina";
    return "";
  }
  function togglePick(id) {
    const c = creature(id);
    if (S.locked || !c) return;
    sfx("unlock");
    setPreview(id);
    const removing = S.team.includes(id);
    const reason = removing ? "" : pickBlockReason(c);
    if (reason) { callout(reason, "deny"); buzz(30); return; }
    sfx("playSfx", "click");
    S.team = removing ? S.team.filter((x) => x !== id) : [...S.team, id];
    if (!removing) {
      S.justPicked = id;
      sfx("playSfx", "cutIn");
      sfx("playCry", c.id, c.name, false);
      callout(c.name);
      stageFlash();
      if (S.stage) S.stage.slam(0.75);
    }
    renderDraft();
    send("draft_update", { room_id: S.roomId, team_ids: S.team, locked: false });
  }
  function lockTeam() {
    if (S.locked || S.team.length !== S.rules.team_size) return;
    S.locked = true;
    sfx("unlock");
    sfx("playSfx", "critImpact");
    callout("Trio pronto!", "lock");
    stageFlash();
    if (S.stage) S.stage.slam(1);
    buzz([40, 50, 90]);
    renderDraft();
    send("draft_update", { room_id: S.roomId, team_ids: S.team, locked: true });
  }
  function setDraftTimer(seconds) {
    const el = $("#draftTimer");
    el.style.setProperty("--p", String(seconds / DRAFT_SECONDS));
    el.classList.toggle("low", seconds <= 10);
    $("b", el).textContent = seconds;
  }
  function setOpponentDraft(count, locked) {
    const name = S.opponent.display_name, size = S.rules.team_size;
    $("#draftOpp").textContent = locked ? `${name} já confirmou o trio.` : `${name} escolheu ${count} de ${size}.`;
    const face = avatarOf(S.opponent.avatar_id);
    const el = $("#selVs");
    el.className = `sel-vs e-${face.element}${locked ? " locked" : ""}`;
    el.innerHTML = `
      <span class="vs-tag">VS</span>
      <span class="vs-face">${portrait(face, true)}</span>
      <b>${esc(name)}</b>
      <small>${S.opponent.is_bot ? "IA" : `${S.opponent.rating ?? 1000} pts`} · ${locked ? "PRONTO" : "escolhendo"}</small>
      <span class="vs-pips">${Array.from({ length: size }, (_, i) => `<i class="${i < count ? "on" : ""}"></i>`).join("")}</span>`;
  }

  /* ---------- abertura "VS" ---------- */
  async function playVsIntro(g) {
    const host = $("#vsIntro");
    const side = (player, cls) => {
      const team = teamOf(g, player) || [];
      return `<div class="vs-side ${cls} e-${team[0]?.element || "normal"}">
        <div class="vs-team">${team.map((c, i) => `<span class="e-${c.element}" style="--i:${i}">${portrait(c, true).replace(' loading="lazy"', "")}</span>`).join("")}</div>
        <b>${esc(g[`p${player}_name`])}</b></div>`;
    };
    host.innerHTML = `${side(S.role, "me")}${side(3 - S.role, "foe")}<div class="vs-mark"><span>VS</span></div>`;
    host.className = "vs-intro show";
    sfx("playSfx", "cutIn");
    setTimeout(() => sfx("playSfx", "critImpact"), 420);
    await sleep(reduceMotion ? 600 : VS_INTRO_MS);
    host.className = "vs-intro";
    host.innerHTML = "";
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
      <span class="plate-face" data-face></span>
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
    const face = $("[data-face]", root);
    if (face.dataset.id !== String(c.id)) { face.dataset.id = String(c.id); face.innerHTML = portrait(c); }
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
  function triggerSpeedlines(element = "normal") {
    const sl = $("#speedlines");
    if (!sl) return;
    sl.className = `speedlines e-${esc(element || "normal")}`;
    void sl.offsetWidth;
    sl.classList.add("active");
  }
  function showCutIn(side, actor, ev) {
    const host = $("#animeCutIn");
    if (!host || !actor) return;
    const element = ev.element || actor.element || "normal";
    const superHit = ev.mult > 1;
    host.className = `anime-cutin ${side} e-${esc(element)}${superHit ? " super" : ""}`;
    host.innerHTML = `
      <div class="cutin-band">
        <div class="cutin-art"><img src="${artUrl(actor.id)}" alt="${esc(actor.name)}" onerror="this.onerror=null;this.src='${spriteUrl(actor.id)}'"/></div>
        <div class="cutin-info">
          <span class="cutin-tag">${superHit ? "SUPER EFICAZ!" : "TÉCNICA ESPECIAL"}</span>
          <b class="cutin-move">${esc(ev.name || actor.tech?.name || "Técnica")}</b>
          <span class="cutin-who">${esc(actor.name)} · ${esc(elName(element))}</span>
        </div>
      </div>`;
    void host.offsetWidth;
    host.classList.add("show");
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
        showCutIn(side, actor, ev);
        triggerSpeedlines(ev.element);
        sfx("playSfx", "cutIn");
        sfx("playSfx", "tech");
      } else if (ev.mult > 1) {
        triggerSpeedlines(ev.element);
      }
      const cls = ev.mult > 1 ? "strong" : ev.mult < 1 ? "weak" : "";
      setTimeout(() => {
        sfx("playSfx", ev.mult > 1 ? "superHit" : ev.mult < 1 ? "weakHit" : "hit");
        if (ev.kind === "tecnica" || ev.mult > 1) sfx("playSfx", "critImpact");
        floatText(targetSide, `-${ev.dmg}`, cls);
        if (ev.broke_guard) floatText(targetSide, "Guarda atravessada", "info");
        else if (ev.guarded) floatText(targetSide, "Amortecido", "info");
        else if (ev.mult > 1) floatText(targetSide, "Super eficaz!", "info");
        if (targetSide === "me") buzz(ev.kind === "tecnica" ? [30, 40, 60] : 25);
        if (ev.kind === "tecnica" || ev.mult > 1) {
          const st = $("#stage");
          if (st) {
            st.classList.remove("shake", "hit-impact");
            void st.offsetWidth;
            st.classList.add("shake", "hit-impact");
          }
        }
        updatePlate(targetSide, live);
      }, ev.kind === "tecnica" ? 780 : 330);
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
      const stepMs = (ev.t === "attack" && ev.kind === "tecnica") ? 1480 : EVENT_MS;
      await Promise.all([Promise.race([S.arena.play(ev, side, def), sleep(stepMs)]), sleep(stepMs - 150)]);
      updatePlate("me", live); updatePlate("foe", live);
    }
    S.arena.clearGuards();
    S.game = msg.state;
    if (S.game.phase === "BATTLE") { updatePlate("me", S.game); updatePlate("foe", S.game); }
  }

  function leaveRoom() {
    sfx("stopBgm");
    S.roomId = null; S.game = null; S.chosen = null; S.queue = Promise.resolve();
    if ($("#animeCutIn")) { $("#animeCutIn").className = "anime-cutin"; $("#animeCutIn").innerHTML = ""; }
    if ($("#speedlines")) $("#speedlines").className = "speedlines";
    if ($("#vsIntro")) { $("#vsIntro").className = "vs-intro"; $("#vsIntro").innerHTML = ""; }
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
      Object.assign(S, { roomId: msg.room_id, role: msg.role, opponent: msg.opponent, game: msg.state, team: [], locked: false, filter: "", search: "", sort: "id", limit: PAGE_STEP, preview: null, justPicked: null });
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
        if ($("#animeCutIn")) { $("#animeCutIn").className = "anime-cutin"; $("#animeCutIn").innerHTML = ""; }
        if ($("#speedlines")) $("#speedlines").className = "speedlines";
        if ($("#stage")) $("#stage").classList.remove("victory-glow", "defeat-dim", "ko-flash", "hit-impact", "shake");
        buildPlate("me"); buildPlate("foe");
        updatePlate("me", S.game); updatePlate("foe", S.game);
        $("#roundChip").textContent = "Preparar";
        renderControls(false);
        setHint("Os Pokémon entram na arena!");
        show("duelArena");
        createArena();
        S.arena.start();
        updateAudioButtons();
        await playVsIntro(S.game);
        if (!S.roomId || !S.arena) return;
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

    const grid = $("#rosterGrid");
    grid.addEventListener("click", (e) => { const b = e.target.closest("[data-pick]"); if (b) togglePick(Number(b.dataset.pick)); });
    grid.addEventListener("pointerover", (e) => {
      if (e.pointerType !== "mouse") return;
      const b = e.target.closest("[data-pick]");
      if (b) queuePreview(Number(b.dataset.pick));
    });
    grid.addEventListener("focusin", (e) => { const b = e.target.closest("[data-pick]"); if (b) setPreview(Number(b.dataset.pick)); });
    grid.addEventListener("keydown", (e) => {
      const tiles = [...grid.querySelectorAll("[data-pick]")];
      const at = tiles.indexOf(document.activeElement);
      if (at < 0) return;
      const cols = Math.max(1, tiles.filter((t) => t.offsetTop === tiles[0].offsetTop).length);
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
      if (!step) return;
      const next = tiles[at + step];
      if (!next) return;
      e.preventDefault();
      next.focus();
    });
    $("#draftSlots").addEventListener("pointerover", (e) => { const b = e.target.closest("[data-remove]"); if (b) queuePreview(Number(b.dataset.remove)); });
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
    $("#btnLockTeam").addEventListener("click", lockTeam);

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
    if (S.stage) { if (e.detail === "battle") S.stage.start(); else S.stage.stop(); }
  });
  if (battleTabActive()) boot();
})();
