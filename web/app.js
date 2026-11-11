/* Pokédex Local — front-end */
const $ = (s, el = document) => el.querySelector(s);
const TYPE_PT = {
  normal: "Normal", fire: "Fogo", water: "Água", grass: "Planta", electric: "Elétrico", ice: "Gelo",
  fighting: "Lutador", poison: "Venenoso", ground: "Terrestre", flying: "Voador", psychic: "Psíquico",
  bug: "Inseto", rock: "Pedra", ghost: "Fantasma", dragon: "Dragão", dark: "Sombrio", steel: "Aço", fairy: "Fada",
};
const STAT_LABELS = [
  ["hp", "HP", "#ff5959"], ["attack", "Ataque", "#f5ac78"], ["defense", "Defesa", "#fae078"],
  ["sp_attack", "Atq. Esp.", "#9db7f5"], ["sp_defense", "Def. Esp.", "#a7db8d"], ["speed", "Velocidade", "#fa92b2"],
];
const HABITAT_PT = {
  cave: "Caverna", forest: "Floresta", grassland: "Campo", mountain: "Montanha", rare: "Raro",
  "rough-terrain": "Terreno acidentado", sea: "Mar", urban: "Urbano", "waters-edge": "Beira d'água",
};

let ALL = [];
const cache = new Map();
let stream = null;
let facing = "environment";
let busy = false;
let autoTimer = null;
let lastCapturedBlob = null;

const POKE_ART_URL = (id) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`;
const POKE_SPRITE_URL = (id) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${id}.png`;

let authToken = localStorage.getItem("pokedex_auth_token") || "";

async function authFetch(url, options = {}) {
  const opts = { ...options };
  opts.headers = new Headers(opts.headers || {});
  if (authToken) {
    opts.headers.set("Authorization", `Bearer ${authToken}`);
  }
  const res = await fetch(url, opts);
  if (res.status === 401) {
    authToken = "";
    localStorage.removeItem("pokedex_auth_token");
    showAuthOverlay();
    throw new Error("Acesso não autorizado. Código de acesso necessário.");
  }
  return res;
}

function showAuthOverlay() {
  const overlay = $("#authOverlay");
  if (overlay) overlay.style.display = "grid";
  $("#btnLock") && ($("#btnLock").style.display = "none");
  setTimeout(() => $("#authPassword")?.focus(), 100);
}

function hideAuthOverlay() {
  const overlay = $("#authOverlay");
  if (overlay) overlay.style.display = "none";
  $("#btnLock") && ($("#btnLock").style.display = "inline-block");
}

/* ---------------- utilidades ---------------- */
const pad = (n) => String(n).padStart(3, "0");
const typeBadge = (t) => `<span class="type t-${t}">${TYPE_PT[t] || t}</span>`;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function getPokemon(id) {
  if (!cache.has(id)) cache.set(id, await authFetch(`/api/pokemon/${id}`).then((r) => r.json()));
  return cache.get(id);
}
function setBusy(on) {
  busy = on;
  $("#statusLed").classList.toggle("busy", on);
  $("#scanline").hidden = !on;
}

/* ---------------- render de detalhes ---------------- */
function renderDetail(p, confidence = null) {
  const confHtml = confidence == null ? "" :
    `<span class="conf ${confidence < 0.5 ? "low" : ""}">${(confidence * 100).toFixed(1)}%</span>`;
  const teachBtn = confidence != null ? `<button class="btn-teach" id="btnTeachOpen">🎯 Não é esse? Ensinar Pokédex</button>` : "";
  const warn = confidence != null && confidence < 0.4
    ? `<p class="desc" style="border-color:#ffb300">⚠️ Não tenho muita certeza. Tente aproximar, centralizar o Pokémon na mira e melhorar a iluminação. ${teachBtn}</p>`
    : (confidence != null ? `<div style="margin:4px 0">${teachBtn}</div>` : "");
  const stats = STAT_LABELS.map(([k, label, color]) => `
    <div class="stat"><span>${label}</span><b>${p.stats[k]}</b>
      <div class="bar"><i style="width:${Math.min(100, (p.stats[k] / 180) * 100)}%;background:${color}"></i></div></div>`).join("");
  const abilities = p.abilities.map((a) =>
    `<div class="abil"><b>${esc(a.name)}</b>${a.hidden ? " <small>(oculta)</small>" : ""}<br><small>${esc(a.description)}</small></div>`).join("");
  const evo = p.evolution.length > 1 ? p.evolution.map((stage) => `
      <div class="stage">${stage.map((id) => {
        const e = ALL.find((x) => x.id === id);
        return `<button data-id="${id}" class="${id === p.id ? "cur" : ""}"><img src="${e?.sprite || POKE_SPRITE_URL(id)}" alt="" onerror="this.onerror=null;this.src='${POKE_SPRITE_URL(id)}'"><span>${esc(e?.name || id)}</span></button>`;
      }).join("")}</div>`).join('<span class="arrow">➜</span>') : "<small>Este Pokémon não possui evolução nesta geração.</small>";

  return `
    <div class="dex-head">
      <span class="dex-num">#${pad(p.id)}</span><h2>${esc(p.name)}</h2>
      <span class="genus">${esc(p.genus)}</span>${confHtml}
    </div>
    ${warn}
    <div class="dex-body">
      <div>
        <div class="art">
          <img class="main" src="${p.image}" alt="${esc(p.name)}" onerror="this.onerror=null;this.src='${POKE_ART_URL(p.id)}'">
          ${p.animated ? `<img class="anim" src="${p.animated}" alt="" onerror="this.remove()">` : ""}
        </div>
        <div class="types">${p.types.map(typeBadge).join("")}${p.is_legendary ? '<span class="type" style="background:#d4af37">Lendário</span>' : ""}${p.is_mythical ? '<span class="type" style="background:#b388ff">Mítico</span>' : ""}</div>
        <button class="btn small" data-speak>🔊 Ouvir</button>
      </div>
      <div>
        <p class="desc">${esc(p.description)}</p>
        <div class="facts">
          <div class="fact"><span>Altura</span>${p.height_m.toFixed(1)} m</div>
          <div class="fact"><span>Peso</span>${p.weight_kg.toFixed(1)} kg</div>
          <div class="fact"><span>Taxa de captura</span>${p.capture_rate}</div>
          <div class="fact"><span>Habitat</span>${HABITAT_PT[p.habitat] || p.habitat || "—"}</div>
          <div class="fact"><span>Exp. base</span>${p.base_experience}</div>
          <div class="fact"><span>Total status</span>${p.stats.total}</div>
          ${p.percentage_male != null ? `<div class="fact"><span>Gênero</span>♂ ${p.percentage_male}% ♀ ${(100 - p.percentage_male).toFixed(1)}%</div>` : ""}
          ${p.base_egg_steps ? `<div class="fact"><span>Passos do Ovo</span>${Number(p.base_egg_steps).toLocaleString("pt-BR")}</div>` : ""}
          ${p.japanese_name ? `<div class="fact"><span>Nome japonês</span>${esc(p.japanese_name)}</div>` : ""}
        </div>
        <h3>Status base (PokémonDB)</h3>${stats}
      </div>
    </div>
    <h3>Fraco contra</h3><div class="types">${p.weaknesses.map((t) => typeBadge(t) + (p.effectiveness[t] >= 4 ? "<b>×4</b>" : "")).join("") || "—"}</div>
    <h3>Resistente a</h3><div class="types">${p.resistances.map(typeBadge).join("") || "—"}</div>
    ${p.immunities.length ? `<h3>Imune a</h3><div class="types">${p.immunities.map(typeBadge).join("")}</div>` : ""}
    <h3>Habilidades</h3>${abilities}
    <h3>Evolução</h3><div class="evo">${evo}</div>
    ${p.gallery && p.gallery.length ? `
    <h3>Galeria e Variações 3D (RogerKoala) <small style="font-size:11px;color:#555">(${p.gallery.length} imagens)</small></h3>
    <div class="gallery-scroll">
      ${p.gallery.map((g) => `
        <div class="gallery-item" data-src="${g.url}" title="${esc(g.name)}">
          <img src="${g.url}" alt="" loading="lazy" />
          ${g.is_3d ? '<span class="tag-3d">3D</span>' : ""}
          ${g.is_shiny ? '<span class="tag-shiny">✨</span>' : ""}
        </div>`).join("")}
    </div>` : ""}`;
}

function bindDetail(container, p) {
  container.querySelectorAll(".evo button").forEach((b) =>
    b.addEventListener("click", () => openModal(Number(b.dataset.id))));
  container.querySelector("[data-speak]")?.addEventListener("click", () => speak(p));
  container.querySelector("#btnTeachOpen")?.addEventListener("click", () => {
    populateTeachSelect(p.id);
    const tm = $("#teachModal");
    if (!tm.open) tm.showModal();
  });
  const mainImg = container.querySelector(".art img.main");
  container.querySelectorAll(".gallery-item").forEach((it) => {
    it.addEventListener("click", () => {
      if (mainImg) mainImg.src = it.dataset.src;
      container.querySelectorAll(".gallery-item").forEach((x) => x.classList.remove("active"));
      it.classList.add("active");
    });
  });
}

function populateTeachSelect(currentId) {
  const sel = $("#teachSelect");
  sel.innerHTML = ALL.map((x) =>
    `<option value="${x.id}" ${x.id === currentId ? "selected" : ""}>#${pad(x.id)} ${esc(x.name)}</option>`
  ).join("");
  $("#teachStatus").textContent = "";
}

function speak(p) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(`${p.name}. ${p.genus}. ${p.description}`);
  u.lang = "pt-BR";
  const voices = speechSynthesis.getVoices();
  const brVoice = voices.find((v) => v.lang === "pt-BR" || v.lang === "pt_BR" || v.lang.startsWith("pt"));
  if (brVoice) u.voice = brVoice;
  speechSynthesis.speak(u);
}

async function showResult(id, confidence) {
  const p = await getPokemon(id);
  const el = $("#result");
  el.innerHTML = renderDetail(p, confidence);
  bindDetail(el, p);
}

async function openModal(id) {
  const p = await getPokemon(id);
  const body = $("#modalBody");
  body.innerHTML = renderDetail(p);
  bindDetail(body, p);
  const m = $("#modal");
  if (!m.open) m.showModal();
  body.scrollTop = 0;
}

/* ---------------- câmera ---------------- */
async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    $("#camMsg").textContent = "Câmera indisponível. Use http://localhost ou inicie com  python run.py --https  para acessar de outro dispositivo.";
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false,
    });
    const v = $("#video");
    v.srcObject = stream;
    $("#preview").hidden = true;
    $("#camMsg").hidden = true;
    $("#btnShot").disabled = false;
    $("#btnCam").textContent = "⏹️ Desligar";
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
      $("#btnFlip").style.display = cams.length > 1 ? "inline-flex" : "none";
    } catch (_) {}
  } catch (err) {
    $("#camMsg").hidden = false;
    $("#camMsg").textContent = "Não foi possível acessar a câmera: " + err.message;
  }
}
function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  $("#btnShot").disabled = true;
  $("#btnCam").textContent = "🎥 Ligar câmera";
  $("#btnFlip").style.display = "none";
  if ($("#autoScan").checked) {
    $("#autoScan").checked = false;
    clearInterval(autoTimer);
    $("#autoBadge").style.display = "none";
  }
}

/** Recorta o quadrado central (área da mira) do vídeo. */
function grabFrame() {
  const v = $("#video");
  const w = v.videoWidth, h = v.videoHeight;
  const side = Math.min(w, h);
  const inner = side * 0.76; // mira = 12% de margem em cada lado
  const sx = (w - inner) / 2, sy = (h - inner) / 2;
  const c = $("#canvas");
  c.width = c.height = 448;
  c.getContext("2d").drawImage(v, sx, sy, inner, inner, 0, 0, 448, 448);
  return new Promise((res) => c.toBlob(res, "image/jpeg", 0.92));
}

async function readJson(r) {
  const txt = await r.text();
  try {
    return JSON.parse(txt);
  } catch {
    return { detail: txt || r.statusText || `Erro HTTP ${r.status}` };
  }
}

async function classify(blob, previewUrl) {
  if (busy) return;
  lastCapturedBlob = blob;
  setBusy(true);
  if (previewUrl) {
    const img = $("#preview");
    img.src = previewUrl;
    img.hidden = false;
    $("#camMsg").hidden = true;
  }
  try {
    const fd = new FormData();
    fd.append("file", blob, "captura.jpg");
    const r = await authFetch("/api/predict", { method: "POST", body: fd });
    const j = await readJson(r);
    if (!r.ok) throw new Error(j.detail || r.statusText);
    const { results } = j;
    results.forEach((x) => cache.set(x.pokemon.id, x.pokemon));
    renderCandidates(results);
    await showResult(results[0].pokemon.id, results[0].confidence);
    if ("vibrate" in navigator && results[0].confidence > 0.4) {
      navigator.vibrate([40, 50, 40]);
    }
  } catch (err) {
    $("#result").innerHTML = `<div class="placeholder"><p>❌ Erro: ${esc(err.message)}</p></div>`;
  } finally {
    setBusy(false);
  }
}

function renderCandidates(results) {
  const el = $("#candidates");
  el.innerHTML = results.map((r, i) => `
    <div class="cand ${i === 0 ? "sel" : ""}" data-id="${r.pokemon.id}" data-c="${r.confidence}">
      <img src="${r.pokemon.sprite}" alt="" onerror="this.onerror=null;this.src='${POKE_SPRITE_URL(r.pokemon.id)}'"><b>${esc(r.pokemon.name)}</b>
      <div class="bar"><i style="width:${(r.confidence * 100).toFixed(1)}%"></i></div>
      <small>${(r.confidence * 100).toFixed(1)}%</small></div>`).join("");
  el.querySelectorAll(".cand").forEach((c) => c.addEventListener("click", () => {
    el.querySelectorAll(".cand").forEach((x) => x.classList.remove("sel"));
    c.classList.add("sel");
    showResult(Number(c.dataset.id), Number(c.dataset.c));
  }));
}

/* ---------------- navegar ---------------- */
function renderGrid() {
  const q = $("#search").value.trim().toLowerCase();
  const t = $("#typeFilter").value;
  const list = ALL.filter((p) =>
    (!t || p.types.includes(t)) &&
    (!q || p.name.toLowerCase().includes(q) || String(p.id) === q.replace(/^#?0*/, "") ||
      p.types_pt.some((x) => x.toLowerCase().includes(q))));
  $("#grid").innerHTML = list.map((p) => {
    const spriteUrl = p.sprite || POKE_SPRITE_URL(p.id);
    return `
    <div class="card" data-id="${p.id}">
      <div class="n">#${pad(p.id)}</div><img src="${spriteUrl}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${POKE_SPRITE_URL(p.id)}'">
      <div class="nm">${esc(p.name)}</div><div class="types">${p.types.map(typeBadge).join("")}</div>
    </div>`;
  }).join("");
}

/* ---------------- eventos ---------------- */
document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + tab.dataset.view));
  window.location.hash = tab.dataset.view;
}));

function switchTab(viewName) {
  const tab = document.querySelector(`.tab[data-view="${viewName}"]`);
  if (!tab) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + viewName));
}

if (window.location.hash) {
  switchTab(window.location.hash.replace("#", ""));
}
window.addEventListener("hashchange", () => {
  if (window.location.hash) switchTab(window.location.hash.replace("#", ""));
});

$("#btnCam").addEventListener("click", () => (stream ? stopCamera() : startCamera()));
$("#btnFlip").addEventListener("click", () => { facing = facing === "environment" ? "user" : "environment"; startCamera(); });
$("#btnShot").addEventListener("click", async () => {
  const blob = await grabFrame();
  classify(blob, URL.createObjectURL(blob));
  setTimeout(() => { if (stream) $("#preview").hidden = true; }, 1500);
});
$("#file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) classify(f, URL.createObjectURL(f));
  e.target.value = "";
});
$("#autoScan").addEventListener("change", async (e) => {
  clearInterval(autoTimer);
  const badge = $("#autoBadge");
  if (e.target.checked) {
    badge.style.display = "block";
    if (!stream) await startCamera();
    autoTimer = setInterval(async () => {
      if (stream && !busy) {
        const blob = await grabFrame();
        classify(blob);
      }
    }, 2200);
  } else {
    badge.style.display = "none";
  }
});
$("#search").addEventListener("input", renderGrid);
$("#typeFilter").addEventListener("change", renderGrid);
$("#grid").addEventListener("click", (e) => { const c = e.target.closest(".card"); if (c) openModal(Number(c.dataset.id)); });
$("#modalClose").addEventListener("click", () => $("#modal").close());
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").close(); });

$("#teachClose")?.addEventListener("click", () => $("#teachModal").close());
$("#teachModal")?.addEventListener("click", (e) => { if (e.target.id === "teachModal") $("#teachModal").close(); });

// Alternar abas do modal Ensinar
$("#tabTeachExisting")?.addEventListener("click", () => {
  $("#tabTeachExisting").classList.add("active");
  $("#tabTeachNew").classList.remove("active");
  $("#sectionTeachExisting").style.display = "block";
  $("#sectionTeachNew").style.display = "none";
  $("#teachStatus").textContent = "";
});

$("#tabTeachNew")?.addEventListener("click", () => {
  $("#tabTeachNew").classList.add("active");
  $("#tabTeachExisting").classList.remove("active");
  $("#sectionTeachExisting").style.display = "none";
  $("#sectionTeachNew").style.display = "block";
  $("#teachStatus").textContent = "";
});

// Confirmar Pokémon existente
$("#btnTeachSubmit")?.addEventListener("click", async () => {
  if (!lastCapturedBlob) return;
  const pid = Number($("#teachSelect").value);
  const st = $("#teachStatus");
  st.textContent = "Gravando amostra no modelo...";
  try {
    const fd = new FormData();
    fd.append("pokemon_id", pid);
    fd.append("file", lastCapturedBlob, "sample.jpg");
    const r = await authFetch("/api/feedback", { method: "POST", body: fd });
    const j = await readJson(r);
    if (!r.ok) throw new Error(j.detail || "Erro ao salvar");
    st.textContent = "✔ " + j.message;
    setTimeout(() => {
      $("#teachModal").close();
      showResult(pid, 1.0);
    }, 900);
  } catch (err) {
    st.textContent = "❌ " + err.message;
  }
});

// Cadastrar novo Pokémon que não está na base
$("#btnCreatePokeSubmit")?.addEventListener("click", async () => {
  if (!lastCapturedBlob) {
    alert("Capture ou envie uma imagem primeiro.");
    return;
  }
  const name = $("#newPokeName").value.trim();
  const type1 = $("#newPokeType1").value;
  const type2 = $("#newPokeType2").value;
  const genus = $("#newPokeGenus").value.trim();
  const desc = $("#newPokeDesc").value.trim();

  if (!name) {
    alert("Por favor, digite o nome do Pokémon.");
    return;
  }
  if (!type1) {
    alert("Por favor, selecione pelo menos a classe / Tipo 1.");
    return;
  }

  const st = $("#teachStatus");
  st.textContent = "Registrando novo Pokémon e treinando modelo...";
  try {
    const fd = new FormData();
    fd.append("name", name);
    fd.append("type1", type1);
    fd.append("type2", type2);
    fd.append("genus", genus);
    fd.append("description", desc);
    fd.append("file", lastCapturedBlob, "new_pokemon.jpg");

    const r = await authFetch("/api/register_custom", { method: "POST", body: fd });
    const j = await readJson(r);
    if (!r.ok) throw new Error(j.detail || "Erro ao registrar");

    st.textContent = "✔ " + j.message;
    cache.set(j.pokemon.id, j.pokemon);
    ALL.push({
      id: j.pokemon.id,
      name: j.pokemon.name,
      types: j.pokemon.types,
      types_pt: j.pokemon.types_pt,
      sprite: j.pokemon.sprite,
      image: j.pokemon.image,
    });
    renderGrid();

    setTimeout(() => {
      $("#teachModal").close();
      $("#newPokeName").value = "";
      $("#newPokeGenus").value = "";
      $("#newPokeDesc").value = "";
      showResult(j.pokemon.id, 1.0);
    }, 900);
  } catch (err) {
    st.textContent = "❌ " + err.message;
  }
});

// colar imagem (Ctrl+V)
window.addEventListener("paste", (e) => {
  const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
  if (item) { const f = item.getAsFile(); classify(f, URL.createObjectURL(f)); }
});

// Eventos de Autenticação / Senha
$("#btnAuthSubmit")?.addEventListener("click", async () => {
  const pwd = $("#authPassword").value;
  const msg = $("#authMsg");
  msg.textContent = "";
  if (!pwd) return;

  const fd = new FormData();
  fd.append("password", pwd);
  try {
    const res = await fetch("/api/auth/login", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Código incorreto");
    authToken = data.token;
    localStorage.setItem("pokedex_auth_token", authToken);
    hideAuthOverlay();
    $("#authPassword").value = "";
    await loadInitialData();
  } catch (err) {
    msg.textContent = "❌ " + err.message;
  }
});

$("#btnLock")?.addEventListener("click", () => {
  authToken = "";
  localStorage.removeItem("pokedex_auth_token");
  showAuthOverlay();
});

async function loadInitialData() {
  ALL = await authFetch("/api/pokemon").then((r) => r.json());
  const tf = $("#typeFilter");
  tf.innerHTML = '<option value="">Todos os tipos</option>';
  $("#newPokeType1") && ($("#newPokeType1").innerHTML = "");
  $("#newPokeType2") && ($("#newPokeType2").innerHTML = '<option value="">Nenhum</option>');

  Object.entries(TYPE_PT).forEach(([k, v]) => {
    if (ALL.some((p) => p.types.includes(k))) tf.insertAdjacentHTML("beforeend", `<option value="${k}">${v}</option>`);
    $("#newPokeType1")?.insertAdjacentHTML("beforeend", `<option value="${k}">${v}</option>`);
    $("#newPokeType2")?.insertAdjacentHTML("beforeend", `<option value="${k}">${v}</option>`);
  });
  renderGrid();
}

/* ---------------- init ---------------- */
(async function init() {
  try {
    const status = await fetch("/api/auth/status", {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    }).then((r) => r.json());

    if (status.required && !status.authenticated) {
      showAuthOverlay();
      return;
    }
    if (status.required) {
      $("#btnLock") && ($("#btnLock").style.display = "inline-block");
    }
    await loadInitialData();
  } catch (err) {
    console.error("Erro na inicialização:", err);
  }
})();

