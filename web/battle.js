/* Duelo dos Encantados — cliente (salão, draft, rodadas e narração). */
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

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (n) => `<svg class="ic" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const S = {
    token: localStorage.getItem(TOKEN_KEY) || "", user: null, rules: null, ws: null, started: false,
    role: 1, roomId: null, opponent: null, game: null, live: null,
    team: [], locked: false, filter: "", avatar: 1, mode: "login",
    inviteId: null, inviteTimer: null, offlineTarget: null, arena: null, chosen: null, queue: Promise.resolve(),
  };

  /* ================= retratos 2D (SVG procedural) ================= */
  const eye = (x, y) => `<circle cx="${x}" cy="${y}" r="4.6" fill="#fff"/><circle cx="${x + 1}" cy="${y + 0.4}" r="2.3" fill="#101418"/>`;
  const ADORN = {
    brasa: (x, y, c) => `<path d="M${x} ${y - 15}q7 8 3 14q-3 4-6 0q-4-6 3-14z" fill="${c}"/>`,
    mata: (x, y, c) => `<path d="M${x} ${y}q-12-9-5-17q11 2 5 17z" fill="${c}"/><path d="M${x} ${y}q12-7 8-16q-10 1-8 16z" fill="${c}" opacity=".8"/>`,
    mare: (x, y, c) => `<path d="M${x} ${y - 15}q8 9 0 15q-8-6 0-15z" fill="${c}"/>`,
    pedra: (x, y, c) => `<path d="M${x} ${y - 15}l6 8-6 8-6-8z" fill="${c}"/>`,
    vento: (x, y, c) => `<path d="M${x - 9} ${y - 5}q9-10 16-1q-3 7-9 2" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/>`,
  };
  const FORMS = {
    bicho: (a, b) => [`<path d="M34 36L29 10 47 27zM66 36L71 10 53 27z" fill="${a}"/><ellipse cx="50" cy="66" rx="26" ry="23" fill="${a}"/><ellipse cx="50" cy="71" rx="15" ry="14" fill="${b}"/><ellipse cx="38" cy="88" rx="9" ry="5" fill="${a}"/><ellipse cx="62" cy="88" rx="9" ry="5" fill="${a}"/><circle cx="50" cy="39" r="20" fill="${a}"/>${eye(42, 37)}${eye(58, 37)}`, 50, 20],
    quadrupede: (a, b) => [`<path d="M18 58q-12-4-10-16" fill="none" stroke="${b}" stroke-width="6" stroke-linecap="round"/><rect x="20" y="68" width="9" height="20" rx="4.500" fill="${a}"/><rect x="33" y="70" width="9" height="18" rx="4.500" fill="${a}"/><rect x="52" y="70" width="9" height="18" rx="4.500" fill="${a}"/><rect x="64" y="68" width="9" height="20" rx="4.500" fill="${a}"/><ellipse cx="46" cy="62" rx="30" ry="17" fill="${a}"/><path d="M64 34l-2-14 11 9zM82 32l5-13 4 14z" fill="${b}"/><circle cx="74" cy="44" r="16" fill="${a}"/><ellipse cx="86" cy="50" rx="8" ry="6" fill="${b}"/>${eye(70, 41)}${eye(81, 40)}`, 74, 26],
    ave: (a, b) => [`<path d="M34 52Q6 38 8 66q14 5 27-2zM66 52q28-14 26 14q-14 5-27-2z" fill="${a}"/><path d="M44 80l-4 10M56 80l4 10" stroke="${b}" stroke-width="4" stroke-linecap="round"/><ellipse cx="50" cy="60" rx="20" ry="24" fill="${a}"/><ellipse cx="50" cy="66" rx="12" ry="15" fill="${b}"/><circle cx="50" cy="33" r="15" fill="${a}"/><path d="M45 37h10l-5 9z" fill="${b}"/>${eye(43, 31)}${eye(57, 31)}`, 50, 16],
    serpente: (a, b) => [`<path d="M20 84q24 10 40-6t-10-22t12-24" fill="none" stroke="${a}" stroke-width="18" stroke-linecap="round"/><path d="M20 84q24 10 40-6t-10-22" fill="none" stroke="${b}" stroke-width="5" stroke-linecap="round" stroke-dasharray="2 14"/><circle cx="62" cy="30" r="16" fill="${a}"/><ellipse cx="70" cy="37" rx="8" ry="5" fill="${b}"/>${eye(56, 27)}${eye(68, 26)}`, 60, 12],
    golem: (a, b) => [`<circle cx="19" cy="56" r="13" fill="${a}"/><circle cx="81" cy="56" r="13" fill="${a}"/><circle cx="17" cy="74" r="9" fill="${b}"/><circle cx="83" cy="74" r="9" fill="${b}"/><rect x="34" y="76" width="12" height="14" rx="5" fill="${a}"/><rect x="54" y="76" width="12" height="14" rx="5" fill="${a}"/><rect x="26" y="34" width="48" height="48" rx="19" fill="${a}"/><ellipse cx="50" cy="62" rx="14" ry="12" fill="${b}"/><circle cx="50" cy="26" r="13" fill="${a}"/>${eye(45, 25)}${eye(55, 25)}`, 50, 11],
  };
  function portrait(c) {
    const [a, b] = c.colors;
    const [body, ax, ay] = (FORMS[c.form] || FORMS.bicho)(a, b);
    const adorn = (ADORN[c.element] || (() => ""))(ax, ay, b);
    return `<span class="portrait"><svg viewBox="0 0 100 100" aria-hidden="true"><ellipse cx="50" cy="91" rx="28" ry="5" fill="#0005"/>${body}${adorn}</svg></span>`;
  }
  const creature = (id) => S.rules.roster.find((c) => c.id === id);
  const avatarOf = (avatarId) => S.rules.roster[(Math.max(1, Number(avatarId) || 1) - 1) % S.rules.roster.length];
  const elName = (el) => S.rules.elements[el].name;
  const elChip = (el) => `<span class="el-chip e-${el}">${icon(el)}${esc(elName(el))}</span>`;
  function setAvatar(node, avatarId) {
    const c = avatarOf(avatarId);
    node.className = `avatar lg e-${c.element}`;
    node.innerHTML = portrait(c);
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
    $("#avatarPicker").innerHTML = S.rules.roster.map((c) =>
      `<button type="button" role="radio" class="e-${c.element}" aria-checked="${c.id === S.avatar}" aria-label="${esc(c.name)}" title="${esc(c.name)}" data-id="${c.id}">${portrait(c)}</button>`).join("");
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
    $("#meStats").textContent = `${S.user.rating} pontos · ${S.user.wins} vitórias · ${S.user.losses} derrotas`;
    show("duelLobby");
    refreshBoards();
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
    $("#trainerList").innerHTML = others.map((t) => {
      const c = avatarOf(t.avatar_id);
      const status = t.in_battle ? "busy" : t.is_online ? "on" : "";
      const label = t.in_battle ? "Em duelo" : t.is_online ? "Desafiar" : "Enfrentar eco";
      return `<li><span class="presence ${status}" title="${t.is_online ? "Conectado" : "Desconectado"}"></span><span class="avatar e-${c.element}">${portrait(c)}</span>
        <span class="who"><b>${esc(t.display_name)}</b><small>${t.rating} pontos</small></span>
        <button class="btn" data-challenge="${t.id}" ${t.in_battle ? "disabled" : ""}>${label}</button></li>`;
    }).join("") || `<li class="empty-row">Nenhum outro treinador cadastrado. Convide alguém ou treine contra a IA.</li>`;
  }
  function renderRules() {
    const r = S.rules;
    const wheel = Object.keys(r.elements).map((el) =>
      `<li>${elChip(el)} vence ${r.strong_against[el].map(elChip).join(" e ")}</li>`).join("");
    $("#rulesBody").innerHTML = `
      <p>Escolha <b>${r.team_size} Encantados</b> gastando até <b>${r.team_budget} pontos</b>. A cada rodada, você e o oponente escolhem uma ação ao mesmo tempo, em até ${r.round_seconds} segundos.</p>
      <ul>
        <li><b>Golpe</b>: dano básico e +1 de Foco.</li>
        <li><b>Técnica</b>: gasta ${r.tech_cost} de Foco, causa dano alto e aplica o efeito próprio do Encantado.</li>
        <li><b>Guarda</b>: amortece o que vier e rende +2 de Foco. Não pode ser usada duas rodadas seguidas.</li>
        <li><b>Trocar</b>: o reserva entra antes dos ataques. Não dá para trocar duas rodadas seguidas.</li>
      </ul>
      <p>O mais veloz ataca primeiro. Vence quem derrubar os três adversários.</p>
      <ul class="wheel">${wheel}</ul>`;
  }

  /* ---------- draft ---------- */
  const teamCost = () => S.team.reduce((sum, id) => sum + creature(id).cost, 0);
  function renderDraft() {
    const r = S.rules, cost = teamCost(), left = r.team_budget - cost;
    $("#budgetFill").style.transform = `scaleX(${cost / r.team_budget})`;
    $("#budgetText").textContent = `${cost} de ${r.team_budget} pontos`;
    $("#draftSlots").innerHTML = Array.from({ length: r.team_size }, (_, i) => {
      const c = creature(S.team[i]);
      return c
        ? `<button class="slot filled e-${c.element}" data-remove="${c.id}" ${S.locked ? "disabled" : ""} aria-label="Remover ${esc(c.name)}">${portrait(c)}<span><b>${esc(c.name)}</b>${esc(elName(c.element))} · ${c.cost} pts</span></button>`
        : `<div class="slot">Vaga ${i + 1}</div>`;
    }).join("");
    $("#elementChips").innerHTML = [["", "Todos"], ...Object.keys(r.elements).map((el) => [el, elName(el)])].map(([el, name]) =>
      `<button class="chip ${el ? `e-${el}` : ""}" aria-pressed="${S.filter === el}" data-filter="${el}">${el ? icon(el) : ""}${esc(name)}</button>`).join("");
    $("#rosterGrid").innerHTML = r.roster.filter((c) => !S.filter || c.element === S.filter).map((c) => {
      const picked = S.team.includes(c.id);
      const blocked = S.locked || (!picked && (S.team.length >= r.team_size || c.cost > left));
      return `<button class="pick e-${c.element}" data-pick="${c.id}" aria-pressed="${picked}" ${blocked ? "disabled" : ""}>
        ${portrait(c)}<b>${icon(c.element)}${esc(c.name)}</b><span class="cost" title="Custo em pontos">${c.cost} pts</span>
        <span class="meta">${esc(elName(c.element))} · Vida ${c.hp} · Atq ${c.atk} · Def ${c.def} · Vel ${c.spd}</span>
        <span class="tech">${esc(c.tech.name)}: ${esc(c.tech.effect_text.toLowerCase())}</span></button>`;
    }).join("");
    const btn = $("#btnLockTeam");
    btn.disabled = S.locked || S.team.length !== r.team_size;
    $("span", btn).textContent = S.locked ? "Trio confirmado" : S.team.length === r.team_size ? "Confirmar trio" : `Escolha ${r.team_size - S.team.length}`;
  }
  function togglePick(id) {
    if (S.locked) return;
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
      setCreature(side, def) { const el = fig(side); el.classList.remove("down", "guard"); el.innerHTML = portrait(def); return Promise.resolve(); },
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
    $("[data-el]", root).innerHTML = icon(c.element);
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
    if (ev.t === "attack") {
      if (ev.kind === "tecnica") announce(ev.name, elName(ev.element));
      const cls = ev.mult > 1 ? "strong" : ev.mult < 1 ? "weak" : "";
      setTimeout(() => {
        floatText(targetSide, `-${ev.dmg}`, cls);
        if (ev.broke_guard) floatText(targetSide, "Guarda atravessada", "info");
        else if (ev.guarded) floatText(targetSide, "Amortecido", "info");
        else if (ev.mult > 1) floatText(targetSide, "Vantagem!", "info");
        if (targetSide === "me") buzz(ev.kind === "tecnica" ? [30, 40, 60] : 25);
        if (ev.kind === "tecnica" || ev.mult > 1) { const st = $("#stage"); st.classList.remove("shake"); void st.offsetWidth; st.classList.add("shake"); }
        updatePlate(targetSide, live);
      }, ev.kind === "tecnica" ? 720 : 330);
    } else if (ev.t === "heal") floatText(side, `+${ev.heal}`, "heal");
    else if (ev.t === "burn") floatText(side, `-${ev.dmg}`, "weak");
    else if (ev.t === "drain") floatText(side, "Foco drenado", "info");
    else if (ev.t === "status") floatText(side, "Em chamas", "info");
    else if (ev.t === "guard") floatText(side, "Guarda", "info");
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
    S.roomId = null; S.game = null; S.chosen = null; S.queue = Promise.resolve();
    if (S.arena) { S.arena.dispose(); S.arena = null; }
    for (const id of ["duelResult", "duelConfirm"]) if ($(`#${id}`).open) $(`#${id}`).close();
    if (S.user) enterLobby();
  }
  const enqueue = (fn) => { S.queue = S.queue.then(fn).catch((err) => toast("Algo saiu do roteiro", err.message, "error")); };

  /* ================= mensagens do servidor ================= */
  const HANDLERS = {
    auth_success(msg) { S.user = { ...S.user, ...msg.user }; if (!S.roomId) enterLobby(); },
    auth_error(msg) { toast("Sessão encerrada", msg.message, "error"); logout(); },
    error(msg) { toast("Não foi possível", msg.message, "error"); },
    lobby_update(msg) { if (S.user) renderTrainers(msg.trainers); },
    challenge_sent(msg) { toast("Convite enviado", `Aguardando ${msg.target} responder.`); },
    challenge_declined(msg) { toast("Convite recusado", `${msg.by} não pode duelar agora.`); },
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
      Object.assign(S, { roomId: msg.room_id, role: msg.role, opponent: msg.opponent, game: msg.state, team: [], locked: false, filter: "" });
      for (const id of ["duelInvite", "duelOffline"]) if ($(`#${id}`).open) $(`#${id}`).close();
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
        buildPlate("me"); buildPlate("foe");
        updatePlate("me", S.game); updatePlate("foe", S.game);
        $("#roundChip").textContent = "Preparar";
        renderControls(false);
        setHint("Os Encantados entram na arena…");
        createArena();
        show("duelArena");
        narrate(S.game.logs[S.game.logs.length - 1]);
        announce("Duelo!", `${S.game.p1_name} contra ${S.game.p2_name}`);
        await Promise.race([Promise.all([
          S.arena.setCreature("me", activeOf(S.game, S.role), { animate: true }),
          S.arena.setCreature("foe", activeOf(S.game, 3 - S.role), { animate: true }),
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
        setHint("Escolha sua ação. Sem escolha, seu Encantado usa Golpe.");
        runTurnBar(S.game.round_seconds);
      });
    },
    ready_update(msg) { if (S.game) { Object.assign(S.game, msg); setReady(S.game); } },
    action_rejected(msg) { S.chosen = null; renderControls(true); setHint(msg.message); toast("Ação indisponível", msg.message, "error"); },
    round_result(msg) { enqueue(() => playRound(msg)); },
    battle_ended(msg) {
      enqueue(async () => {
        if (!S.roomId) return;
        runTurnBar(0); renderControls(false);
        const won = msg.winner === S.role;
        S.game = msg.state;
        if (S.arena && msg.winner) await Promise.race([S.arena.celebrate(sideOf(msg.winner)), sleep(900)]);
        const dlg = $("#duelResult");
        dlg.classList.toggle("win", won);
        $("#resultArt").innerHTML = (teamOf(msg.state, msg.winner || S.role) || []).map((c) => `<span class="e-${c.element}">${portrait(c)}</span>`).join("");
        $("#resultTitle").textContent = won ? "Vitória!" : "Derrota";
        const last = msg.state.logs[msg.state.logs.length - 1] || "";
        $("#resultMsg").textContent = won
          ? `Você venceu ${S.opponent.display_name} em ${msg.state.round_no} rodadas. ${/desistiu|saiu/.test(last) ? last : ""}`
          : `${msg.winner_name || S.opponent.display_name} levou a melhor em ${msg.state.round_no} rodadas. Ajuste o trio e tente a revanche.`;
        buzz(won ? [40, 60, 40, 60, 120] : 120);
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
    $("#btnBot").addEventListener("click", () => send("start_bot_battle"));
    $("#challengeForm").addEventListener("submit", () => {
      const name = $("#challengeUser").value.trim();
      if (!name) { $("#challengeUser").focus(); return; }
      send("challenge", { target_username: name });
      $("#challengeUser").value = "";
    });
    $("#trainerList").addEventListener("click", (e) => {
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
      renderDraft();
    });
    $("#btnLockTeam").addEventListener("click", () => {
      S.locked = true;
      renderDraft();
      send("draft_update", { room_id: S.roomId, team_ids: S.team, locked: true });
    });

    $("#actions").addEventListener("click", (e) => { const b = e.target.closest(".act"); if (b && !b.disabled) choose({ kind: b.dataset.kind }); });
    $("#bench").addEventListener("click", (e) => { const b = e.target.closest("[data-switch]"); if (b && !b.disabled) choose({ kind: "trocar", idx: Number(b.dataset.switch) }); });
    document.addEventListener("keydown", (e) => {
      if ($("#duelArena").hidden || !battleTabActive() || e.target.closest("input, textarea, select, dialog")) return;
      const btn = $("#actions").querySelectorAll(".act")[Number(e.key) - 1];
      if (btn && !btn.disabled) choose({ kind: btn.dataset.kind });
    });
    $("#btnSurrender").addEventListener("click", () => $("#duelConfirm").showModal());
    $("#btnConfirmNo").addEventListener("click", () => $("#duelConfirm").close());
    $("#btnConfirmYes").addEventListener("click", () => { $("#duelConfirm").close(); send("surrender", { room_id: S.roomId }); });
    $("#btnBackToLobby").addEventListener("click", async () => {
      leaveRoom();
      try { const me = await api("/me"); enterLobby({ ...S.user, ...me.user }); } catch (_) { logout(); }
    });
    $("#duelResult").addEventListener("cancel", (e) => e.preventDefault());
  }

  async function boot() {
    if (S.started) return;
    S.started = true;
    try {
      S.rules = await api("/rules");
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
