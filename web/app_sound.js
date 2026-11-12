/* Som do aplicativo: escolhe a trilha de fundo conforme a tela e toca os sons de
 * interface (passar o cursor, selecionar, trocar de aba, abrir ficha, capturar).
 * Usa o motor de window.BattleAudio (battle_audio.js). O áudio só começa depois do
 * primeiro toque ou tecla, como os navegadores exigem.
 */
(function () {
  "use strict";

  const HOVER_GAP_MS = 70;
  const HOVER_TARGETS = ".card, .pick, .evo button, .gallery-item, .cand, .act:not(:disabled), .bench-btn:not(:disabled)";
  /* do mais específico para o mais genérico: o primeiro seletor que casar define o som */
  const CLICK_SOUNDS = [
    [".tab[data-view]", "tab"],
    ["#btnShot", "scan"],
    [".card, .evo button, .cand", "open"],
    ["#modalClose, #teachClose", "back"],
    [".pick, .act, .bench-btn, #btnLockTeam, #btnSound", null],
    ["button, .btn, select, summary, [role='tab']", "select"],
  ];
  const audio = () => window.BattleAudio;
  const play = (name) => { const a = audio(); if (a) a.playSfx(name); };
  let unlocked = false;
  let lastHover = 0;
  let lastHoverEl = null;

  const isOpen = (id) => { const el = document.getElementById(id); return Boolean(el && !el.hidden); };

  /** Trilha que deveria estar tocando agora, pela tela visível (null = silêncio). */
  function wantedTrack() {
    const view = document.querySelector(".view.active");
    if (!view) return null;
    if (view.id === "view-scanner") return "scanner";
    if (view.id === "view-browse") return "pokedex";
    if (view.id !== "view-battle") return null;
    if (isOpen("duelDraft")) return "select";
    if (!isOpen("duelArena")) return "lobby";
    const intro = document.getElementById("vsIntro");
    const result = document.getElementById("duelResult");
    if ((intro && intro.classList.contains("show")) || (result && result.open)) return null;
    return "battle";
  }
  function refresh() {
    const a = audio();
    if (!a || !unlocked) return;
    const track = wantedTrack();
    if (track) a.startBgm(track); else a.stopBgm();
  }
  function renderToggle() {
    const btn = document.getElementById("btnSound");
    const a = audio();
    if (!btn || !a) return;
    const on = a.isSfxEnabled();
    btn.classList.toggle("off", !on);
    btn.setAttribute("aria-pressed", String(on));
    btn.title = on ? "Silenciar som e música" : "Ativar som e música";
    btn.setAttribute("aria-label", btn.title);
  }
  function unlock() {
    if (unlocked || !audio()) return;
    unlocked = true;
    audio().unlock();
    refresh();
  }

  document.addEventListener("pointerdown", unlock, { capture: true });
  document.addEventListener("keydown", unlock, { capture: true });
  document.addEventListener("viewchange", () => setTimeout(refresh, 0));

  document.addEventListener("click", (e) => {
    const toggle = e.target.closest("#btnSound");
    if (toggle && audio()) {
      audio().setSfx(!audio().isSfxEnabled());
      renderToggle();
      refresh();
      play("select");
      return;
    }
    for (const [selector, sound] of CLICK_SOUNDS) {
      if (!e.target.closest(selector)) continue;
      if (sound) play(sound);
      return;
    }
  });
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const el = e.target.closest(HOVER_TARGETS);
    if (!el || el === lastHoverEl) return;
    lastHoverEl = el;
    const now = performance.now();
    if (now - lastHover < HOVER_GAP_MS) return;
    lastHover = now;
    play("hover");
  });

  renderToggle();
  window.AppSound = { refresh, renderToggle };
})();
