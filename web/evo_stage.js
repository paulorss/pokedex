/* Pokédex — palco 3D da seção "Evolução" da ficha (scanner e modal).
 * Um único palco por ficha percorre os estágios da linha evolutiva; passar o mouse
 * ou focar um estágio o mostra no palco. Depende de app.js (ALL, esc, pad, typeBadge)
 * e de window.Select3D. Sem WebGL, a lista de evolução continua como estava.
 */
(function () {
  "use strict";

  const CYCLE_MS = 2600;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** Um palco persistente por contêiner de ficha: o canvas é reaproveitado a cada render. */
  const instances = new Map();

  function createInstance() {
    const host = document.createElement("div");
    host.className = "sel-stage dex-stage evo-stage";
    host.innerHTML = `
      <div class="sel-canvas" aria-hidden="true"></div>
      <div class="sel-vignette" aria-hidden="true"></div>
      <div class="sel-info" aria-live="polite"></div>
      <div class="sel-flash" aria-hidden="true"></div>`;
    return { host, stage: null, timer: null, ids: [], index: 0, evo: null };
  }
  function flashOnce(inst) {
    const el = inst.host.querySelector(".sel-flash");
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
  }
  function showAt(inst, index) {
    const id = inst.ids[index];
    const p = ALL.find((x) => x.id === id);
    if (!p || !inst.stage) return;
    inst.index = index;
    inst.stage.show({ id: p.id, element: p.types[0] });
    const info = inst.host.querySelector(".sel-info");
    info.className = `sel-info t-${p.types[0]}`;
    info.innerHTML = `
      <span class="si-no">Estágio ${index + 1} de ${inst.ids.length} · Nº ${pad(p.id)}</span>
      <b class="si-name">${esc(p.name)}</b>
      <div class="si-types types">${p.types.map(typeBadge).join("")}</div>`;
    info.classList.remove("swap");
    void info.offsetWidth;
    info.classList.add("swap");
    inst.evo.querySelectorAll("button").forEach((b) => b.classList.toggle("on-stage", Number(b.dataset.id) === id));
  }
  function stopCycle(inst) {
    clearInterval(inst.timer);
    inst.timer = null;
  }
  function startCycle(inst) {
    stopCycle(inst);
    if (reduceMotion || inst.ids.length < 2) return;
    inst.timer = setInterval(() => {
      if (document.hidden || !inst.host.isConnected || inst.host.offsetParent === null) return;
      showAt(inst, (inst.index + 1) % inst.ids.length);
    }, CYCLE_MS);
  }
  function release(inst) {
    stopCycle(inst);
    if (inst.stage) { inst.stage.dispose(); inst.stage = null; }
    inst.host.remove();
  }

  /** Liga o palco à ficha recém-renderizada em `container` (chamado por bindDetail). */
  function mount(container, pokemon) {
    const evo = container.querySelector(".evo");
    const ids = evo ? [...evo.querySelectorAll("button[data-id]")].map((b) => Number(b.dataset.id)) : [];
    let inst = instances.get(container);
    if (!window.Select3D || ids.length < 2) {
      if (inst) { release(inst); instances.delete(container); }
      return;
    }
    if (!inst) { inst = createInstance(); instances.set(container, inst); }
    stopCycle(inst);
    inst.ids = ids;
    inst.evo = evo;
    evo.before(inst.host);
    if (!inst.stage) inst.stage = window.Select3D.create(inst.host.querySelector(".sel-canvas"));
    if (!inst.stage) { release(inst); instances.delete(container); return; }
    inst.stage.start();
    showAt(inst, Math.max(0, ids.indexOf(pokemon.id)));
    startCycle(inst);

    const preview = (target) => {
      const b = target.closest("button[data-id]");
      if (!b) return;
      stopCycle(inst);
      const at = inst.ids.indexOf(Number(b.dataset.id));
      if (at >= 0 && at !== inst.index) { showAt(inst, at); flashOnce(inst); inst.stage.slam(0.5); }
    };
    evo.addEventListener("pointerover", (e) => { if (e.pointerType === "mouse") preview(e.target); });
    evo.addEventListener("focusin", (e) => preview(e.target));
    evo.addEventListener("pointerleave", () => startCycle(inst));
    evo.addEventListener("focusout", () => startCycle(inst));
  }
  function unmount(container) {
    const inst = instances.get(container);
    if (!inst) return;
    release(inst);
    instances.delete(container);
  }
  /** Pausa a renderização dos palcos que ficaram fora da tela (troca de aba). */
  function syncVisibility() {
    instances.forEach((inst) => {
      if (!inst.stage) return;
      if (inst.host.isConnected && inst.host.offsetParent !== null) inst.stage.start(); else inst.stage.stop();
    });
  }

  document.addEventListener("viewchange", () => setTimeout(syncVisibility, 0));
  const modal = document.getElementById("modal");
  if (modal) modal.addEventListener("close", () => unmount(document.getElementById("modalBody")));

  window.EvoStage = { mount, unmount };
})();
