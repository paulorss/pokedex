/**
 * Pokédex Local - Módulo de Batalha Pokémon Online (Estilo Pokémon GO)
 * Gerencia autenticação de treinadores, matchmaking em tempo real via WebSocket,
 * sala de draft com timer de 60s e limite de stamina, motor de arena e efeitos audiovisuais.
 */
(function () {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // Limite de stamina regulamentar por equipe
  const TEAM_STAMINA_LIMIT = 1550;

  // Estado local do módulo
  let currentUser = null;
  let ws = null;
  let currentRoomId = null;
  let myRole = 1; // 1 (P1) ou 2 (P2)
  let battleState = null;
  let selectedTeam = []; // Lista de objetos pokemon [p1, p2, p3]
  let isTeamLocked = false;
  let shieldTimerInterval = null;

  // Cache da Pokédex completa
  let pokedexList = [];

  // ==================== SÍNTESE DE ÁUDIO (Web Audio API) ====================
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function playSound(type) {
    try {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const t = ctx.currentTime;

      if (type === "fast_hit") {
        // Impacto rápido (punch/tackle)
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.setValueAtTime(180, t);
        osc.frequency.exponentialRampToValueAtTime(40, t + 0.12);
        gain.gain.setValueAtTime(0.35, t);
        gain.gain.linearRampToValueAtTime(0.01, t + 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.12);
      } else if (type === "charged_hit") {
        // Explosão de ataque carregado
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(320, t);
        osc.frequency.exponentialRampToValueAtTime(30, t + 0.35);
        gain.gain.setValueAtTime(0.5, t);
        gain.gain.linearRampToValueAtTime(0.01, t + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.35);
      } else if (type === "shield") {
        // Escudo holográfico
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(600, t);
        osc.frequency.linearRampToValueAtTime(1200, t + 0.25);
        gain.gain.setValueAtTime(0.3, t);
        gain.gain.linearRampToValueAtTime(0.01, t + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.25);
      } else if (type === "victory") {
        // Fanfarra de vitória (Tríade ascendente alegre)
        [523.25, 659.25, 783.99, 1046.5].forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const start = t + idx * 0.12;
          osc.type = "sine";
          osc.frequency.setValueAtTime(freq, start);
          gain.gain.setValueAtTime(0.3, start);
          gain.gain.linearRampToValueAtTime(0.01, start + 0.28);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(start);
          osc.stop(start + 0.28);
        });
      } else if (type === "defeat") {
        // Derrota descendente
        [440, 415.3, 392, 349.2].forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const start = t + idx * 0.15;
          osc.type = "triangle";
          osc.frequency.setValueAtTime(freq, start);
          gain.gain.setValueAtTime(0.25, start);
          gain.gain.linearRampToValueAtTime(0.01, start + 0.22);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(start);
          osc.stop(start + 0.22);
        });
      } else if (type === "beep") {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, t);
        gain.gain.setValueAtTime(0.2, t);
        gain.gain.linearRampToValueAtTime(0.01, t + 0.08);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.08);
      }
    } catch (e) {
      // AudioContext bloqueado pelo navegador antes do primeiro clique
    }
  }

  // ==================== GERENCIAMENTO DE TELAS ====================
  function showView(screenId) {
    ["battleAuth", "battleLobby", "battleDraft", "battleArena"].forEach((id) => {
      const el = $(`#${id}`);
      if (el) el.style.display = id === screenId ? "block" : "none";
    });
  }

  // ==================== COMUNICAÇÃO WEBSOCKET ====================
  function connectWebSocket(token) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws/battle?token=${encodeURIComponent(token)}`;

    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log("✔ Conectado ao servidor de batalha WebSocket.");
    };

    ws.onmessage = (event) => {
      try {
        const msg = jsonParseSafe(event.data);
        if (!msg) return;
        handleServerMessage(msg);
      } catch (err) {
        console.error("Erro ao processar mensagem do servidor:", err);
      }
    };

    ws.onclose = () => {
      console.warn("Conexão WebSocket de batalha fechada.");
      // Tenta reconectar após 3s se o usuário ainda estiver autenticado
      if (currentUser) {
        setTimeout(() => connectWebSocket(localStorage.getItem("pokedex_battle_token")), 3000);
      }
    };

    ws.onerror = (e) => {
      console.error("Erro no WebSocket de batalha:", e);
    };
  }

  function sendWs(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    } else {
      console.warn("WebSocket não está pronto para enviar:", data);
    }
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case "auth_success":
        currentUser = msg.user;
        updateTrainerProfile(msg.user);
        showView("battleLobby");
        loadLeaderboard();
        break;

      case "auth_error":
        localStorage.removeItem("pokedex_battle_token");
        currentUser = null;
        showView("battleAuth");
        break;

      case "lobby_update":
        renderOnlineTrainers(msg.online_users);
        break;

      case "challenge_received":
        showChallengePrompt(msg);
        break;

      case "challenge_sent":
        alert(`⚔️ Convite enviado para ${msg.target}! Aguardando resposta...`);
        break;

      case "challenge_declined":
        alert(`❌ ${msg.by} recusou o desafio.`);
        break;

      case "battle_matched":
        // Sala de draft iniciada!
        currentRoomId = msg.room_id;
        myRole = msg.role;
        battleState = msg.state;
        selectedTeam = [];
        isTeamLocked = false;
        enterDraftRoom(msg);
        break;

      case "draft_tick":
        updateDraftTimer(msg.timer, msg);
        break;

      case "draft_updated":
        handleDraftSync(msg);
        break;

      case "battle_started":
        battleState = msg.state;
        enterBattleArena(msg.state);
        break;

      case "fast_attack_done":
        handleFastAttackDone(msg.result, msg.state);
        break;

      case "charged_prompt":
        handleChargedPrompt(msg.pending, msg.state);
        break;

      case "charged_resolved":
        handleChargedResolved(msg.result, msg.state);
        break;

      case "switch_done":
        handleSwitchDone(msg.result, msg.state);
        break;

      case "battle_ended":
        handleBattleEnded(msg);
        break;

      case "error":
        alert(`Aviso: ${msg.message}`);
        break;
    }
  }

  // ==================== AUTENTICAÇÃO DO TREINADOR ====================
  async function initAuth() {
    const token = localStorage.getItem("pokedex_battle_token");
    if (!token) {
      showView("battleAuth");
      return;
    }

    try {
      const res = await fetch("/api/battle/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        currentUser = data.user;
        updateTrainerProfile(data.user);
        connectWebSocket(token);
        showView("battleLobby");
        loadLeaderboard();
      } else {
        localStorage.removeItem("pokedex_battle_token");
        showView("battleAuth");
      }
    } catch {
      showView("battleAuth");
    }
  }

  function updateTrainerProfile(u) {
    if (!u) return;
    $("#trainerName").textContent = u.display_name || u.username;
    $("#trainerUsername").textContent = `@${u.username}`;
    $("#trainerRating").textContent = `🏆 ${u.rating} PTS`;
    $("#trainerWins").textContent = `${u.wins} V`;
    $("#trainerLosses").textContent = `${u.losses} D`;
    $("#trainerAvatar").src = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${u.avatar_id || 25}.png`;
  }

  async function loadLeaderboard() {
    try {
      const res = await fetch("/api/battle/leaderboard");
      const data = await res.json();
      if (!data.ok) return;

      const list = $("#leaderboardRows");
      if (!list) return;

      list.innerHTML = data.leaderboard
        .map(
          (u, idx) => `
        <div class="trainer-row">
          <div class="trainer-row-left">
            <span style="font-weight:900;width:20px;font-size:12px;color:#666">${idx + 1}º</span>
            <img src="https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${u.avatar_id || 25}.png" alt="" />
            <div>
              <div style="font-weight:700;font-size:13px">${esc(u.display_name)}</div>
              <div style="font-size:11px;color:#777">@${esc(u.username)} • ${u.wins}V / ${u.losses}D</div>
            </div>
          </div>
          <span style="font-weight:800;font-size:12px;color:#e65100">🏆 ${u.rating}</span>
        </div>
      `
        )
        .join("");
    } catch (e) {
      console.warn("Erro ao carregar ranking:", e);
    }
  }

  function renderOnlineTrainers(users) {
    const container = $("#onlineTrainersList");
    if (!container) return;

    const others = users.filter((u) => !currentUser || u.id !== currentUser.id);
    if (!others.length) {
      container.innerHTML = `<div style="text-align:center;color:#666;font-size:13px;padding:12px">Nenhum outro treinador no lobby. Use o botão <b>Treinar contra IA</b>!</div>`;
      return;
    }

    container.innerHTML = others
      .map(
        (u) => `
      <div class="trainer-row">
        <div class="trainer-row-left">
          <img src="https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${u.avatar_id || 25}.png" alt="" />
          <div>
            <div style="font-weight:700;font-size:13px">${esc(u.display_name)}</div>
            <div style="font-size:11px;color:#777">@${esc(u.username)} • 🏆 ${u.rating} PTS</div>
          </div>
        </div>
        <button class="btn-challenge" ${u.in_battle ? "disabled" : ""} data-uid="${u.id}">
          ${u.in_battle ? "⚔️ Em Batalha" : "⚔️ Desafiar"}
        </button>
      </div>
    `
      )
      .join("");

    container.querySelectorAll(".btn-challenge").forEach((btn) => {
      btn.addEventListener("click", () => {
        const uid = Number(btn.dataset.uid);
        if (uid) sendWs({ action: "challenge", target_id: uid });
      });
    });
  }

  function showChallengePrompt(msg) {
    const modal = $("#challengeModal");
    if (!modal) return;
    $("#challengeChallengerName").textContent = msg.challenger.display_name;
    $("#challengeChallengerRating").textContent = `🏆 ${msg.challenger.rating} PTS`;
    $("#challengeAvatar").src = `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${msg.challenger.avatar_id || 25}.png`;

    let left = msg.timeout || 30;
    $("#challengeTimer").textContent = `${left}s`;

    const timer = setInterval(() => {
      left--;
      $("#challengeTimer").textContent = `${left}s`;
      if (left <= 0) {
        clearInterval(timer);
        modal.close();
      }
    }, 1000);

    $("#btnAcceptChallenge").onclick = () => {
      clearInterval(timer);
      modal.close();
      sendWs({ action: "accept_challenge", invite_id: msg.invite_id });
    };

    $("#btnDeclineChallenge").onclick = () => {
      clearInterval(timer);
      modal.close();
      sendWs({ action: "decline_challenge", invite_id: msg.invite_id });
    };

    modal.showModal();
    playSound("beep");
  }

  // ==================== SALA DE ESCOLHA (DRAFT ROOM - 60s) ====================
  function enterDraftRoom(msg) {
    showView("battleDraft");
    $("#draftTimerVal").textContent = "60s";
    $("#draftTimerBox").classList.remove("urgent");
    $("#draftOpponentName").textContent = msg.opponent.display_name || msg.opponent.username;

    // Reseta equipe
    selectedTeam = [];
    isTeamLocked = false;
    updateDraftTeamUI();
    renderDraftPokeGrid();
  }

  function updateDraftTimer(timer, msg) {
    const el = $("#draftTimerVal");
    const box = $("#draftTimerBox");
    if (el) el.textContent = `${timer}s`;

    if (timer <= 10) {
      box?.classList.add("urgent");
      if (timer <= 5) playSound("beep");
    } else {
      box?.classList.remove("urgent");
    }

    if (msg) {
      const oppLocked = myRole === 1 ? msg.p2_locked : msg.p1_locked;
      $("#draftOpponentStatus").textContent = oppLocked ? "✔ Oponente confirmou a equipe!" : "⏳ Oponente escolhendo...";
    }
  }

  function handleDraftSync(msg) {
    const oppLocked = myRole === 1 ? msg.p2_locked : msg.p1_locked;
    $("#draftOpponentStatus").textContent = oppLocked ? "✔ Oponente confirmou a equipe!" : "⏳ Oponente escolhendo...";
  }

  function calculateTeamStamina(team) {
    return team.reduce((acc, p) => acc + (p.stamina_cost || 500), 0);
  }

  function updateDraftTeamUI() {
    const totalStamina = calculateTeamStamina(selectedTeam);
    const remaining = TEAM_STAMINA_LIMIT - totalStamina;
    const pct = Math.min(100, Math.round((totalStamina / TEAM_STAMINA_LIMIT) * 100));

    $("#teamStaminaVal").textContent = `${totalStamina} / ${TEAM_STAMINA_LIMIT} SP (Restam: ${remaining} SP)`;
    const fill = $("#teamStaminaFill");
    if (fill) {
      fill.style.width = `${pct}%`;
      fill.classList.toggle("danger", totalStamina > TEAM_STAMINA_LIMIT);
    }

    // Renderiza os 3 slots
    for (let i = 0; i < 3; i++) {
      const slotEl = $(`#teamSlot${i + 1}`);
      const p = selectedTeam[i];
      if (p) {
        slotEl.className = "team-slot filled";
        slotEl.innerHTML = `
          ${!isTeamLocked ? `<button class="btn-remove-slot" data-idx="${i}">✕</button>` : ""}
          <img src="${p.sprite || `/img/sprites/${p.id}.png`}" alt="${esc(p.name)}" />
          <div class="poke-name">#${String(p.id).padStart(3, "0")} ${esc(p.name)}</div>
          <div class="poke-cost">⚡ ${p.stamina_cost || 500} SP</div>
        `;
        slotEl.querySelector(".btn-remove-slot")?.addEventListener("click", (e) => {
          e.stopPropagation();
          removePokemonFromTeam(i);
        });
      } else {
        slotEl.className = "team-slot";
        slotEl.innerHTML = `
          <div style="font-size:26px;color:#aaa">➕</div>
          <div style="font-size:12px;color:#888;font-weight:700">Slot ${i + 1}</div>
        `;
      }
    }

    const btnLock = $("#btnLockTeam");
    if (btnLock) {
      btnLock.disabled = isTeamLocked || selectedTeam.length !== 3 || totalStamina > TEAM_STAMINA_LIMIT;
      btnLock.textContent = isTeamLocked ? "✔ Equipe Confirmada!" : `🔒 Confirmar Equipe (${selectedTeam.length}/3)`;
    }

    // Atualiza cards no grid (desabilita os que estourariam a stamina restante)
    updateGridStaminaAvailability();
  }

  function addPokemonToTeam(p) {
    if (isTeamLocked || selectedTeam.length >= 3) return;
    if (selectedTeam.some((x) => x.id === p.id)) {
      alert("Este Pokémon já está na sua equipe!");
      return;
    }
    const total = calculateTeamStamina(selectedTeam) + (p.stamina_cost || 500);
    if (total > TEAM_STAMINA_LIMIT) {
      alert(`Stamina insuficiente! Adicionar ${p.name} ultrapassaria o limite máximo de ${TEAM_STAMINA_LIMIT} SP.`);
      return;
    }

    selectedTeam.push(p);
    updateDraftTeamUI();
    syncDraftSelection(false);
  }

  function removePokemonFromTeam(idx) {
    if (isTeamLocked) return;
    selectedTeam.splice(idx, 1);
    updateDraftTeamUI();
    syncDraftSelection(false);
  }

  function syncDraftSelection(locked) {
    if (!currentRoomId) return;
    sendWs({
      action: "draft_update",
      room_id: currentRoomId,
      team_ids: selectedTeam.map((p) => p.id),
      locked: locked,
    });
  }

  function renderDraftPokeGrid() {
    const grid = $("#draftPokeGrid");
    if (!grid) return;

    const search = ($("#draftSearch")?.value || "").toLowerCase().trim();
    const typeFilter = $("#draftTypeFilter")?.value || "";

    const filtered = pokedexList.filter((p) => {
      const matchText = !search || p.name.toLowerCase().includes(search) || String(p.id).includes(search);
      const matchType = !typeFilter || p.types.includes(typeFilter);
      return matchText && matchType;
    });

    grid.innerHTML = filtered.slice(0, 150).map((p) => {
      const isSelected = selectedTeam.some((x) => x.id === p.id);
      return `
        <div class="draft-card-item ${isSelected ? "selected" : ""}" data-pid="${p.id}">
          <img src="${p.sprite || `/img/sprites/${p.id}.png`}" loading="lazy" alt="" />
          <div class="item-name">${esc(p.name)}</div>
          <div class="item-cost">⚡ ${p.stamina_cost || 500} SP</div>
        </div>
      `;
    }).join("");

    grid.querySelectorAll(".draft-card-item").forEach((card) => {
      card.addEventListener("click", () => {
        const pid = Number(card.dataset.pid);
        const p = pokedexList.find((x) => x.id === pid);
        if (p) addPokemonToTeam(p);
      });
    });

    updateGridStaminaAvailability();
  }

  function updateGridStaminaAvailability() {
    const remaining = TEAM_STAMINA_LIMIT - calculateTeamStamina(selectedTeam);
    $$(".draft-card-item").forEach((card) => {
      const pid = Number(card.dataset.pid);
      const p = pokedexList.find((x) => x.id === pid);
      if (!p) return;
      const isSelected = selectedTeam.some((x) => x.id === pid);
      if (isSelected) {
        card.classList.remove("disabled");
      } else if (selectedTeam.length >= 3 || (p.stamina_cost || 500) > remaining) {
        card.classList.add("disabled");
      } else {
        card.classList.remove("disabled");
      }
    });
  }

  // ==================== ARENA DE COMBATE (Estilo Pokémon GO) ====================
  function enterBattleArena(state) {
    showView("battleArena");
    playSound("beep");
    renderArenaState(state);
  }

  function renderArenaState(state) {
    if (!state) return;

    const isP1 = myRole === 1;
    const myName = isP1 ? state.p1_name : state.p2_name;
    const oppName = isP1 ? state.p2_name : state.p1_name;

    const myTeam = isP1 ? state.p1_combatants : state.p2_combatants;
    const oppTeam = isP1 ? state.p2_combatants : state.p1_combatants;

    const myActiveIdx = isP1 ? state.p1_active_idx : state.p2_active_idx;
    const oppActiveIdx = isP1 ? state.p2_active_idx : state.p1_active_idx;

    const myActive = myTeam[myActiveIdx] || {};
    const oppActive = oppTeam[oppActiveIdx] || {};

    const myShields = isP1 ? state.p1_shields : state.p2_shields;
    const oppShields = isP1 ? state.p2_shields : state.p1_shields;

    // 1. HUD do Oponente
    $("#oppHudName").textContent = `${esc(oppName)} - ${esc(oppActive.name || "")}`;
    $("#oppShields").textContent = "🛡️ ".repeat(oppShields);
    const oppHpPct = oppActive.max_hp ? Math.max(0, Math.round((oppActive.current_hp / oppActive.max_hp) * 100)) : 0;
    const oppHpFill = $("#oppHpFill");
    if (oppHpFill) {
      oppHpFill.style.width = `${oppHpPct}%`;
      oppHpFill.className = `hp-bar-fill ${oppHpPct < 25 ? "low" : oppHpPct < 55 ? "mid" : ""}`;
    }
    $("#oppHpText").textContent = `${oppHpPct}%`;

    // 2. Sprite do Oponente
    const oppImg = $("#oppSprite");
    if (oppImg && oppActive.id) {
      oppImg.src = oppActive.animated || `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/showdown/${oppActive.id}.gif`;
      oppImg.onerror = () => {
        oppImg.src = oppActive.artwork || `/img/artwork/${oppActive.id}.png`;
      };
    }

    // 3. HUD do Jogador
    $("#myHudName").textContent = `${esc(myName)} - ${esc(myActive.name || "")}`;
    $("#myShields").textContent = "🛡️ ".repeat(myShields);
    const myHpPct = myActive.max_hp ? Math.max(0, Math.round((myActive.current_hp / myActive.max_hp) * 100)) : 0;
    const myHpFill = $("#myHpFill");
    if (myHpFill) {
      myHpFill.style.width = `${myHpPct}%`;
      myHpFill.className = `hp-bar-fill ${myHpPct < 25 ? "low" : myHpPct < 55 ? "mid" : ""}`;
    }
    $("#myHpText").textContent = `${myActive.current_hp || 0} / ${myActive.max_hp || 0} HP`;

    // Barra de Energia do Jogador
    const energy = myActive.energy || 0;
    const energyFill = $("#myEnergyFill");
    if (energyFill) {
      energyFill.style.width = `${energy}%`;
      energyFill.classList.toggle("charged", energy >= 50);
    }

    // 4. Sprite do Jogador (Em Primeiro Plano)
    const myImg = $("#mySprite");
    if (myImg && myActive.id) {
      myImg.src = myActive.animated || `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/showdown/${myActive.id}.gif`;
      myImg.onerror = () => {
        myImg.src = myActive.artwork || `/img/artwork/${myActive.id}.png`;
      };
    }

    // 5. Botões de Ataque
    const fastMove = myActive.fast_move || { name: "Ataque Rápido", icon: "⚪" };
    $("#btnFastAtk").innerHTML = `${fastMove.icon || "⚡"} <b>${esc(fastMove.name)}</b> (+${fastMove.energy || 15}⚡)`;

    const c1 = myActive.charged_move_1 || { name: "Carregado 1", energy: 50 };
    const c2 = myActive.charged_move_2 || { name: "Carregado 2", energy: 65 };

    const btnC1 = $("#btnCharged1");
    if (btnC1) {
      btnC1.innerHTML = `${c1.icon || "💥"} ${esc(c1.name)}<br><small>${energy}/${c1.energy}⚡</small>`;
      btnC1.classList.toggle("ready", energy >= c1.energy);
      btnC1.disabled = energy < c1.energy;
    }

    const btnC2 = $("#btnCharged2");
    if (btnC2) {
      btnC2.innerHTML = `${c2.icon || "✨"} ${esc(c2.name)}<br><small>${energy}/${c2.energy}⚡</small>`;
      btnC2.classList.toggle("ready", energy >= c2.energy);
      btnC2.disabled = energy < c2.energy;
    }

    // 6. Banco de Reserva
    renderBench(myTeam, myActiveIdx, isP1 ? state.p1_switch_cooldown : state.p2_switch_cooldown);

    // 7. Ticker de Logs
    if (state.logs && state.logs.length) {
      const ticker = $("#battleTicker");
      if (ticker) {
        ticker.innerHTML = state.logs.map((l) => `<div>${esc(l)}</div>`).join("");
        ticker.scrollTop = ticker.scrollHeight;
      }
    }
  }

  function renderBench(team, activeIdx, cooldown) {
    const benchContainer = $("#benchList");
    if (!benchContainer) return;

    benchContainer.innerHTML = team
      .map((p, idx) => {
        if (idx === activeIdx) return "";
        const isFainted = p.current_hp <= 0;
        const canSwitch = !isFainted && cooldown <= 0;
        return `
          <div class="bench-item ${!canSwitch ? "disabled" : ""}" data-idx="${idx}">
            <img src="${p.sprite || `/img/sprites/${p.id}.png`}" alt="" />
            <div>
              <div>${esc(p.name)}</div>
              <div style="font-size:10px;color:${isFainted ? "#d32f2f" : "#2e7d32"}">
                ${isFainted ? "💀 Desmaiado" : cooldown > 0 ? `⏳ ${cooldown}s` : `💚 ${p.current_hp} HP`}
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    benchContainer.querySelectorAll(".bench-item:not(.disabled)").forEach((el) => {
      el.addEventListener("click", () => {
        const targetIdx = Number(el.dataset.idx);
        sendWs({ action: "switch_pokemon", room_id: currentRoomId, target_idx: targetIdx });
      });
    });
  }

  // ==================== EVENTOS DE COMBATE E ANIMAÇÕES ====================
  function handleFastAttackDone(res, state) {
    battleState = state;
    const isAttackerMe = res.attacker === myRole;

    // Animação de investida
    const attackerStage = isAttackerMe ? $("#myPokeStage") : $("#oppPokeStage");
    const defenderStage = isAttackerMe ? $("#oppPokeStage") : $("#myPokeStage");

    attackerStage?.classList.add(isAttackerMe ? "lunge-p1" : "lunge-p2");
    setTimeout(() => {
      attackerStage?.classList.remove("lunge-p1", "lunge-p2");
      defenderStage?.classList.add("hurt");
      playSound("fast_hit");

      // Texto de dano flutuante
      spawnFloatingText(defenderStage, `-${res.damage}`, res.multiplier >= 2.0 ? "super" : res.multiplier <= 0.5 ? "low" : "normal");

      setTimeout(() => defenderStage?.classList.remove("hurt"), 350);
    }, 120);

    renderArenaState(state);
  }

  function handleChargedPrompt(pending, state) {
    battleState = state;
    renderArenaState(state);

    const isDefenderMe = pending.defender === myRole;
    if (isDefenderMe && pending.shields_available > 0) {
      // Exibe modal de escudo por 3 segundos
      showShieldPrompt(pending);
    }
  }

  function showShieldPrompt(pending) {
    const overlay = $("#shieldAlertOverlay");
    if (!overlay) return;

    $("#shieldMoveName").textContent = pending.move.name;
    let left = 3;
    $("#shieldCountdown").textContent = `${left}s`;
    overlay.style.display = "grid";

    clearInterval(shieldTimerInterval);
    shieldTimerInterval = setInterval(() => {
      left--;
      $("#shieldCountdown").textContent = `${left}s`;
      if (left <= 0) {
        clearInterval(shieldTimerInterval);
        overlay.style.display = "none";
        // Não usou escudo no tempo
        sendWs({ action: "resolve_shield", room_id: currentRoomId, use_shield: false });
      }
    }, 1000);

    $("#btnUseShield").onclick = () => {
      clearInterval(shieldTimerInterval);
      overlay.style.display = "none";
      sendWs({ action: "resolve_shield", room_id: currentRoomId, use_shield: true });
    };
  }

  function handleChargedResolved(res, state) {
    battleState = state;
    const isDefenderMe = res.defender === myRole;
    const defenderStage = isDefenderMe ? $("#myPokeStage") : $("#oppPokeStage");

    if (res.shield_used) {
      playSound("shield");
      spawnFloatingText(defenderStage, "ESCUDO BLOQUEOU! 🛡️", "shield");
      const dome = document.createElement("div");
      dome.className = "shield-dome";
      defenderStage?.appendChild(dome);
      setTimeout(() => dome.remove(), 800);
    } else {
      playSound("charged_hit");
      defenderStage?.classList.add("hurt");
      const text = res.eff_text ? `${res.eff_text} (-${res.damage})` : `-${res.damage}`;
      spawnFloatingText(defenderStage, text, res.multiplier >= 2.0 ? "super" : "normal");
      setTimeout(() => defenderStage?.classList.remove("hurt"), 500);
    }

    renderArenaState(state);
  }

  function handleSwitchDone(res, state) {
    battleState = state;
    playSound("beep");
    renderArenaState(state);
  }

  function handleBattleEnded(msg) {
    const isWinnerMe = msg.winner === myRole;
    if (isWinnerMe) {
      playSound("victory");
    } else {
      playSound("defeat");
    }

    const modal = $("#battleResultModal");
    if (!modal) return;

    $("#battleResultTitle").textContent = isWinnerMe ? "🏆 VITÓRIA!" : "💀 DERROTA!";
    $("#battleResultTitle").style.color = isWinnerMe ? "#2e7d32" : "#d32f2f";
    $("#battleResultMsg").textContent = isWinnerMe
      ? `Parabéns, Treinador! Você venceu a partida contra ${msg.winner_name === currentUser?.display_name ? "o oponente" : msg.winner_name}! (+25 PTS)`
      : `Não foi dessa vez! O oponente venceu a disputa. (-15 PTS)`;

    modal.showModal();

    $("#btnBackToLobby").onclick = () => {
      modal.close();
      showView("battleLobby");
      initAuth(); // Recarrega dados atualizados do usuário e ranking
    };
  }

  function spawnFloatingText(targetEl, text, type) {
    if (!targetEl) return;
    const f = document.createElement("div");
    f.className = `floating-text ${type}`;
    f.textContent = text;
    f.style.left = "40%";
    f.style.top = "20%";
    targetEl.appendChild(f);
    setTimeout(() => f.remove(), 1100);
  }

  // ==================== INICIALIZAÇÃO DE EVENTOS ====================
  function bindEvents() {
    // Abas de Login / Cadastro
    $("#tabLogin")?.addEventListener("click", () => {
      $("#tabLogin").classList.add("active");
      $("#tabRegister").classList.remove("active");
      $("#formLogin").style.display = "block";
      $("#formRegister").style.display = "none";
    });
    $("#tabRegister")?.addEventListener("click", () => {
      $("#tabRegister").classList.add("active");
      $("#tabLogin").classList.remove("active");
      $("#formLogin").style.display = "none";
      $("#formRegister").style.display = "block";
    });

    // Seletor de Avatar
    $$(".avatar-opt").forEach((opt) => {
      opt.addEventListener("click", () => {
        $$(".avatar-opt").forEach((o) => o.classList.remove("selected"));
        opt.classList.add("selected");
        const aid = opt.dataset.avatar;
        if ($("#regAvatarInput")) $("#regAvatarInput").value = aid;
      });
    });

    // Submissão Login
    $("#formLogin")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const u = $("#loginUsername").value.trim();
      const p = $("#loginPassword").value;
      const msg = $("#authStatusMsg");
      msg.textContent = "Conectando...";
      try {
        const res = await fetch("/api/battle/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: u, password: p }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Erro ao entrar");

        localStorage.setItem("pokedex_battle_token", data.user.token);
        currentUser = data.user;
        updateTrainerProfile(data.user);
        connectWebSocket(data.user.token);
        showView("battleLobby");
        loadLeaderboard();
      } catch (err) {
        msg.textContent = `❌ ${err.message}`;
      }
    });

    // Submissão Cadastro
    $("#formRegister")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const u = $("#regUsername").value.trim();
      const p = $("#regPassword").value;
      const d = $("#regDisplayName").value.trim();
      const a = Number($("#regAvatarInput").value || 25);
      const msg = $("#authStatusMsg");
      msg.textContent = "Criando conta de treinador...";
      try {
        const res = await fetch("/api/battle/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: u, password: p, display_name: d, avatar_id: a }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Erro ao cadastrar");

        localStorage.setItem("pokedex_battle_token", data.user.token);
        currentUser = data.user;
        updateTrainerProfile(data.user);
        connectWebSocket(data.user.token);
        showView("battleLobby");
        loadLeaderboard();
      } catch (err) {
        msg.textContent = `❌ ${err.message}`;
      }
    });

    // Botão Sair da Conta
    $("#btnLogoutTrainer")?.addEventListener("click", () => {
      localStorage.removeItem("pokedex_battle_token");
      if (ws) ws.close();
      currentUser = null;
      showView("battleAuth");
    });

    // Batalhar contra IA / Bot
    $("#btnQuickBot")?.addEventListener("click", () => {
      sendWs({ action: "start_bot_battle" });
    });

    // Desafiar por Nome / ID
    $("#btnChallengeDirect")?.addEventListener("click", () => {
      const target = $("#challengeDirectInput")?.value.trim();
      if (!target) {
        alert("Digite o nome de usuário ou ID do treinador.");
        return;
      }
      sendWs({ action: "challenge", target_username: target });
    });

    // Filtros da tela de Draft
    $("#draftSearch")?.addEventListener("input", renderDraftPokeGrid);
    $("#draftTypeFilter")?.addEventListener("change", renderDraftPokeGrid);

    // Confirmar Equipe no Draft
    $("#btnLockTeam")?.addEventListener("click", () => {
      if (selectedTeam.length !== 3) return;
      isTeamLocked = true;
      updateDraftTeamUI();
      syncDraftSelection(true);
    });

    // Botões de Ação na Arena
    $("#btnFastAtk")?.addEventListener("click", () => {
      if (!currentRoomId) return;
      sendWs({ action: "fast_attack", room_id: currentRoomId });
    });

    $("#btnCharged1")?.addEventListener("click", () => {
      if (!currentRoomId) return;
      sendWs({ action: "charged_attack", room_id: currentRoomId, slot: 1 });
    });

    $("#btnCharged2")?.addEventListener("click", () => {
      if (!currentRoomId) return;
      sendWs({ action: "charged_attack", room_id: currentRoomId, slot: 2 });
    });

    $("#btnSurrender")?.addEventListener("click", () => {
      if (!currentRoomId) return;
      if (confirm("Deseja realmente se render e desistir desta batalha?")) {
        sendWs({ action: "surrender", room_id: currentRoomId });
      }
    });
  }

  // ==================== INICIALIZAÇÃO GERAL ====================
  async function loadPokemonList() {
    try {
      const res = await fetch("/api/pokemon");
      if (res.ok) {
        pokedexList = await res.json();
      }
    } catch (e) {
      console.warn("Aviso ao carregar Pokédex para batalha:", e);
    }
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function jsonParseSafe(str) {
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  // Inicializa quando a página carregar
  window.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    await loadPokemonList();
    initAuth();
  });
})();
