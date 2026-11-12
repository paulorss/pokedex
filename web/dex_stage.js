/* Pokédex — palco 3D de destaque sobre a grade (mesmo efeito da seleção do Duelo).
 * Depende dos globais de app.js (ALL, getPokemon, typeBadge, esc, pad, openModal)
 * e de window.Select3D (select3d.js). Sem WebGL, mostra a arte em imagem.
 */
(function () {
  "use strict";

  const PREVIEW_DELAY_MS = 55;
  const STAT_MAX = 180;
  const STAT_ROWS = [["hp", "HP"], ["attack", "ATQ"], ["defense", "DEF"], ["speed", "VEL"]];
  const view = document.getElementById("view-browse");
  const grid = document.getElementById("grid");
  const host = document.getElementById("dexStage");
  if (!view || !grid || !host) return;
  const canvasBox = host.querySelector(".sel-canvas");
  const info = host.querySelector(".sel-info");
  const flash = host.querySelector(".sel-flash");

  const state = { stage: null, previewId: null, timer: null };

  function restart(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }
  function imageStage(container) {
    container.innerHTML = `<div class="sel-flat"></div>`;
    const flat = container.firstElementChild;
    return {
      show(def) { flat.innerHTML = `<img src="${POKE_ART_URL(def.id)}" alt="" onerror="this.onerror=null;this.src='${POKE_SPRITE_URL(def.id)}'">`; },
      slam() { restart(flat, "slam"); },
      start() {}, stop() {}, dispose() { container.innerHTML = ""; },
    };
  }
  const findPokemon = (id) => ALL.find((p) => p.id === id);
  const stageDef = (p) => ({ id: p.id, element: p.types[0] });

  function statRows(stats) {
    return STAT_ROWS.map(([key, label], i) =>
      `<div style="--i:${i}"><dt>${label}</dt><dd><i style="--v:${Math.min(1, (stats[key] || 0) / STAT_MAX).toFixed(3)}"></i></dd><span>${stats[key] ?? "-"}</span></div>`).join("");
  }
  function renderInfo(p) {
    info.className = `sel-info t-${p.types[0]}`;
    info.innerHTML = `
      <span class="si-no">Nº ${pad(p.id)}</span>
      <b class="si-name">${esc(p.name)}</b>
      <div class="si-types types">${p.types.map(typeBadge).join("")}</div>
      <dl class="si-stats" data-stats></dl>
      <p class="si-tech" data-genus hidden></p>`;
    restart(info, "swap");
  }
  /** Completa atributos e categoria quando a ficha chega (a lista traz só o resumo). */
  async function fillDetails(id) {
    try {
      const full = await getPokemon(id);
      if (state.previewId !== id || !full) return;
      if (full.stats) info.querySelector("[data-stats]").innerHTML = statRows(full.stats);
      const genus = info.querySelector("[data-genus]");
      if (full.genus) { genus.hidden = false; genus.innerHTML = `<b>${esc(full.genus)}</b>Toque para abrir a ficha completa`; }
    } catch (_) {
      /* sem a ficha, o painel fica só com nome e tipos */
    }
  }
  function markCursor(id) {
    grid.querySelectorAll(".card.cursor").forEach((n) => n.classList.remove("cursor"));
    const card = grid.querySelector(`.card[data-id="${id}"]`);
    if (card) card.classList.add("cursor");
  }
  function setPreview(id) {
    const p = findPokemon(id);
    if (!p) return;
    markCursor(id);
    if (state.previewId === id) return;
    state.previewId = id;
    renderInfo(p);
    if (state.stage) state.stage.show(stageDef(p));
    fillDetails(id);
  }
  function queuePreview(id) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => setPreview(id), PREVIEW_DELAY_MS);
  }
  function slam() {
    restart(flash, "show");
    if (state.stage) state.stage.slam(0.75);
  }

  function openStage() {
    if (!state.stage) {
      canvasBox.innerHTML = "";
      state.stage = (window.Select3D && window.Select3D.create(canvasBox)) || imageStage(canvasBox);
      const p = state.previewId ? findPokemon(state.previewId) : null;
      if (p) state.stage.show(stageDef(p));
    }
    state.stage.start();
    syncWithGrid();
  }
  function closeStage() {
    clearTimeout(state.timer);
    if (state.stage) { state.stage.dispose(); state.stage = null; }
  }
  /** Depois de cada render da grade: mantém o destaque atual ou assume o primeiro cartão. */
  function syncWithGrid() {
    const cards = grid.querySelectorAll(".card");
    host.hidden = cards.length === 0;
    if (!cards.length) return;
    const current = state.previewId && grid.querySelector(`.card[data-id="${state.previewId}"]`);
    if (current) markCursor(state.previewId);
    else setPreview(Number(cards[0].dataset.id));
  }

  const cardId = (target) => { const c = target.closest(".card"); return c ? Number(c.dataset.id) : null; };
  grid.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const id = cardId(e.target);
    if (id) queuePreview(id);
  });
  grid.addEventListener("focusin", (e) => { const id = cardId(e.target); if (id) setPreview(id); });
  grid.addEventListener("click", (e) => { const id = cardId(e.target); if (id) { setPreview(id); slam(); } });
  grid.addEventListener("keydown", (e) => {
    const cards = [...grid.querySelectorAll(".card")];
    const at = cards.indexOf(document.activeElement);
    if (at < 0) return;
    const cols = Math.max(1, cards.filter((c) => c.offsetTop === cards[0].offsetTop).length);
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
    const next = step ? cards[at + step] : null;
    if (!next) return;
    e.preventDefault();
    next.focus();
  });
  host.addEventListener("click", () => { if (state.previewId) { slam(); openModal(state.previewId); } });

  document.addEventListener("gridrender", syncWithGrid);
  document.addEventListener("viewchange", (e) => { if (e.detail === "browse") openStage(); else closeStage(); });
  syncWithGrid();
  if (view.classList.contains("active")) openStage();
})();
