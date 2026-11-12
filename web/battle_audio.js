/* Áudio original da Arena Pokémon: Gritos oficiais (PokeAPI / Showdown) + SFX & Tema de Batalha Web Audio. */
(function () {
  "use strict";

  const SFX_KEY = "duelo_sfx";
  const BGM_KEY = "duelo_bgm";
  const CRY_OGG = (id) => `https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/latest/${id}.ogg`;
  const CRY_MP3 = (slug) => `https://play.pokemonshowdown.com/audio/cries/${slug}.mp3`;

  function toSlug(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/♀/g, "f")
      .replace(/♂/g, "m")
      .replace(/[^a-z0-9]/g, "");
  }

  let sfxOn = localStorage.getItem(SFX_KEY) !== "0";
  let bgmOn = localStorage.getItem(BGM_KEY) !== "0";
  let ctx = null;
  let activeCry = null;
  let bgmTimer = null;
  let bgmStep = 0;

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  function unlock() {
    ensureCtx();
  }

  function tone(freq, dur, { type = "square", vol = 0.08, delay = 0, slideTo = null } = {}) {
    if (!sfxOn) return;
    const ac = ensureCtx();
    if (!ac) return;
    const t0 = ac.currentTime + delay;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(40, freq), t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise(dur, { vol = 0.1, delay = 0, highpass = 400, lowpass = 3600 } = {}) {
    if (!sfxOn) return;
    const ac = ensureCtx();
    if (!ac) return;
    const len = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;

    const hp = ac.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = highpass;
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = lowpass;

    const gain = ac.createGain();
    const t0 = ac.currentTime + delay;
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(hp);
    hp.connect(lp);
    lp.connect(gain);
    gain.connect(ac.destination);
    src.start(t0);
  }

  function playCry(id, name = "", faint = false) {
    if (!sfxOn || !id) return;
    try {
      if (activeCry) {
        activeCry.pause();
        activeCry = null;
      }
      const audio = new Audio();
      const canOgg = Boolean(audio.canPlayType && audio.canPlayType("audio/ogg; codecs=vorbis"));
      const slug = toSlug(name);
      audio.src = canOgg ? CRY_OGG(id) : (slug ? CRY_MP3(slug) : CRY_OGG(id));
      audio.volume = faint ? 0.42 : 0.52;
      if (faint) audio.playbackRate = 0.72;
      let retried = false;
      audio.onerror = () => {
        if (retried) return;
        retried = true;
        if (slug && !audio.src.endsWith(".mp3")) {
          audio.src = CRY_MP3(slug);
          audio.play().catch(() => {});
        }
      };
      activeCry = audio;
      audio.play().catch(() => {});
    } catch (_) {
      // Silencioso caso navegador bloqueie autoplay antes da interação
    }
  }

  const SFX = {
    click() {
      tone(880, 0.05, { type: "square", vol: 0.045 });
      tone(1320, 0.06, { type: "square", vol: 0.04, delay: 0.035 });
    },
    sendOut() {
      noise(0.14, { vol: 0.08, highpass: 900, lowpass: 5200 });
      tone(523.25, 0.07, { type: "square", vol: 0.07, delay: 0.06 });
      tone(783.99, 0.09, { type: "square", vol: 0.07, delay: 0.13 });
      tone(1046.5, 0.14, { type: "triangle", vol: 0.09, delay: 0.21 });
    },
    hit() {
      noise(0.14, { vol: 0.13, highpass: 120, lowpass: 1600 });
      tone(190, 0.13, { type: "sawtooth", vol: 0.1, slideTo: 65 });
    },
    superHit() {
      noise(0.22, { vol: 0.16, highpass: 180, lowpass: 3800 });
      tone(320, 0.09, { type: "square", vol: 0.11, slideTo: 110 });
      tone(640, 0.1, { type: "square", vol: 0.11, delay: 0.07, slideTo: 210 });
      tone(960, 0.14, { type: "sawtooth", vol: 0.09, delay: 0.14, slideTo: 300 });
    },
    weakHit() {
      noise(0.1, { vol: 0.08, highpass: 80, lowpass: 700 });
      tone(130, 0.12, { type: "triangle", vol: 0.09, slideTo: 70 });
    },
    tech() {
      tone(330, 0.24, { type: "sawtooth", vol: 0.07, slideTo: 990 });
      tone(440, 0.22, { type: "triangle", vol: 0.06, delay: 0.05, slideTo: 1320 });
      noise(0.2, { vol: 0.07, delay: 0.08, highpass: 1400, lowpass: 6000 });
    },
    cutIn() {
      // Corte estilo anime (shing + energia subindo)
      noise(0.18, { vol: 0.11, highpass: 2400, lowpass: 8500 });
      tone(1180, 0.11, { type: "sine", vol: 0.075, slideTo: 2200 });
      tone(587.33, 0.16, { type: "triangle", vol: 0.065, delay: 0.04, slideTo: 1174.66 });
    },
    critImpact() {
      // Soco pesado / hit-stop com grave profundo
      tone(110, 0.22, { type: "triangle", vol: 0.14, slideTo: 36 });
      noise(0.16, { vol: 0.12, delay: 0.02, highpass: 90, lowpass: 900 });
    },
    guard() {
      tone(659.25, 0.12, { type: "sine", vol: 0.08 });
      tone(987.77, 0.18, { type: "triangle", vol: 0.08, delay: 0.07 });
      tone(1318.5, 0.24, { type: "sine", vol: 0.06, delay: 0.14 });
    },
    heal() {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((n, i) => tone(n, 0.14, { type: "triangle", vol: 0.075, delay: i * 0.075 }));
    },
    burn() {
      noise(0.28, { vol: 0.1, highpass: 1200, lowpass: 5500 });
      tone(220, 0.22, { type: "sawtooth", vol: 0.05, slideTo: 140 });
    },
    drain() {
      tone(587.33, 0.28, { type: "sine", vol: 0.08, slideTo: 196 });
      tone(440, 0.24, { type: "triangle", vol: 0.06, delay: 0.08, slideTo: 146.8 });
    },
    faint() {
      // Som dramático de nocaute estilo Pokémon clássico + impacto de Pokébola
      tone(520, 0.14, { type: "sawtooth", vol: 0.09, slideTo: 280 });
      tone(340, 0.52, { type: "square", vol: 0.095, delay: 0.12, slideTo: 72 });
      noise(0.36, { vol: 0.14, delay: 0.14, highpass: 140, lowpass: 1600 });
    },
    victory() {
      // Fanfarra épica de vitória Pokémon
      const seq = [
        [523.25, 0.10, 0.00], [523.25, 0.10, 0.12], [523.25, 0.10, 0.24],
        [523.25, 0.26, 0.36], [415.30, 0.20, 0.65], [466.16, 0.20, 0.88],
        [523.25, 0.15, 1.12], [466.16, 0.10, 1.30], [523.25, 0.24, 1.42],
        [659.25, 0.24, 1.68], [783.99, 0.55, 1.94],
      ];
      seq.forEach(([f, d, at]) => {
        tone(f, d, { type: "square", vol: 0.08, delay: at });
        tone(f / 2, d, { type: "triangle", vol: 0.065, delay: at });
      });
    },
    defeat() {
      // Cadência dramática de derrota (ida ao Centro Pokémon)
      const seq = [[392, 0.20, 0], [349.23, 0.20, 0.22], [311.13, 0.24, 0.44], [277.18, 0.26, 0.70], [220, 0.65, 0.98]];
      seq.forEach(([f, d, at]) => {
        tone(f, d, { type: "triangle", vol: 0.09, delay: at });
        tone(f * 0.5, d, { type: "sine", vol: 0.06, delay: at });
      });
    },
  };

  function playEmote(emoji = "") {
    if (!sfxOn) return;
    ensureCtx();
    const e = String(emoji);
    if (e.includes("🤡")) {
      // Som cômico "Wah-Wah-Waaah"
      tone(311.13, 0.18, { type: "sawtooth", vol: 0.075, delay: 0.00, slideTo: 293.66 });
      tone(293.66, 0.18, { type: "sawtooth", vol: 0.075, delay: 0.20, slideTo: 277.18 });
      tone(277.18, 0.18, { type: "sawtooth", vol: 0.075, delay: 0.40, slideTo: 261.63 });
      tone(246.94, 0.48, { type: "sawtooth", vol: 0.08,  delay: 0.60, slideTo: 207.65 });
    } else if (e.includes("😈") || e.includes("💀")) {
      // Risadinha provocativa / tom sombrio
      [622.25, 554.37, 493.88, 622.25, 440].forEach((f, i) =>
        tone(f, 0.09, { type: "square", vol: 0.07, delay: i * 0.085 })
      );
      tone(130.8, 0.25, { type: "sawtooth", vol: 0.09, delay: 0.36, slideTo: 82 });
    } else if (e.includes("👑") || e.includes("💪")) {
      // Fanfarra de confiança / provocação estilosa
      tone(523.25, 0.08, { type: "square", vol: 0.07, delay: 0 });
      tone(659.25, 0.08, { type: "square", vol: 0.07, delay: 0.09 });
      tone(783.99, 0.24, { type: "square", vol: 0.08, delay: 0.18 });
      tone(1046.5, 0.30, { type: "triangle", vol: 0.08, delay: 0.18 });
    } else if (e.includes("🥶")) {
      // Tremor cristalino gelado
      [1318, 1174, 1318, 1174, 1567].forEach((f, i) =>
        tone(f, 0.07, { type: "sine", vol: 0.07, delay: i * 0.06 })
      );
    } else if (e.includes("😱") || e.includes("🫣")) {
      // Susto animado
      tone(440, 0.14, { type: "square", vol: 0.085, slideTo: 1240 });
      tone(987, 0.16, { type: "triangle", vol: 0.075, delay: 0.15, slideTo: 620 });
    } else if (e.includes("🔥") || e.includes("⚡")) {
      // Estalo elétrico / chama intensa
      noise(0.18, { vol: 0.11, highpass: 1100, lowpass: 6200 });
      tone(740, 0.14, { type: "sawtooth", vol: 0.08, slideTo: 1480 });
      tone(1108, 0.15, { type: "square", vol: 0.07, delay: 0.09, slideTo: 520 });
    } else {
      // Sino divertido (👏, 🫡, 🤝, ❤️)
      tone(783.99, 0.09, { type: "triangle", vol: 0.08 });
      tone(1046.5, 0.18, { type: "sine", vol: 0.08, delay: 0.09 });
    }
  }

  /* Tema de batalha original em chiptune: melodia sincopada, baixo saltitante e bateria.
   * Oito compassos de 16 semicolcheias (parte A: C–Am–F–G; parte B: F–G–Em–Am/G).
   * As notas são agendadas no relógio do AudioContext para o ritmo não oscilar. */
  const BGM_STEP_SECONDS = 0.11;
  const BGM_LOOKAHEAD_SECONDS = 0.25;
  const BGM_TICK_MS = 60;
  const STEPS_PER_BAR = 16;
  const NOTE_INDEX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const noteFreq = (name) => 440 * Math.pow(2, (NOTE_INDEX[name[0]] + (Number(name.slice(1)) + 1) * 12 - 69) / 12);
  const bar = (text) => text.trim().split(/\s+/).map((n) => (n === "-" ? 0 : noteFreq(n)));
  const BGM_LEAD = [
    "C5 - E5 G5 - E5 - C6 - B5 - G5 A5 - G5 -",
    "A5 - C6 A5 - E5 - A5 - G5 - E5 D5 - E5 -",
    "F5 - A5 C6 - A5 - F5 - A5 - C6 D6 - C6 -",
    "B5 - G5 - D6 - B5 - G5 A5 B5 - D6 - - -",
    "A5 A5 - F5 - A5 C6 - C6 - A5 - F5 - A5 -",
    "B5 B5 - G5 - B5 D6 - D6 - B5 - G5 - B5 -",
    "G5 - E5 - B5 - G5 - E6 - D6 - B5 - G5 -",
    "A5 - C6 - E6 - C6 - D6 - B5 - G5 A5 B5 -",
  ].flatMap(bar);
  const BGM_ROOTS = ["C3", "A2", "F2", "G2", "F2", "G2", "E2", "A2"].map(noteFreq);
  /* multiplicador da fundamental por semicolcheia: 1 = tônica, 2 = oitava, 1.5 = quinta, 0 = pausa */
  const BGM_BASS_SHAPE = [1, 0, 1, 0, 2, 0, 1, 0, 1, 0, 1, 0, 2, 0, 1.5, 0];
  const BGM_KICK = new Set([0, 8, 10]);
  const BGM_SNARE = new Set([4, 12]);
  let bgmNextTime = 0;

  function scheduleBgmStep(step, delay) {
    const pos = step % STEPS_PER_BAR;
    const lead = BGM_LEAD[step % BGM_LEAD.length];
    const bass = BGM_ROOTS[Math.floor(step / STEPS_PER_BAR) % BGM_ROOTS.length] * BGM_BASS_SHAPE[pos];
    if (lead) {
      tone(lead, BGM_STEP_SECONDS * 1.5, { type: "square", vol: 0.026, delay });
      tone(lead * 2.005, BGM_STEP_SECONDS, { type: "square", vol: 0.007, delay });
    }
    if (bass) tone(bass, BGM_STEP_SECONDS * 1.7, { type: "triangle", vol: 0.05, delay });
    if (BGM_KICK.has(pos)) tone(150, 0.1, { type: "sine", vol: 0.06, delay, slideTo: 48 });
    if (BGM_SNARE.has(pos)) noise(0.09, { vol: 0.03, delay, highpass: 900, lowpass: 7000 });
    if (pos % 2 === 0) noise(0.03, { vol: 0.01, delay, highpass: 6000, lowpass: 12000 });
  }

  function startBgm() {
    stopBgm();
    if (!sfxOn || !bgmOn) return;
    const ac = ensureCtx();
    if (!ac) return;
    bgmStep = 0;
    bgmNextTime = ac.currentTime + 0.08;
    bgmTimer = setInterval(() => {
      if (!sfxOn || !bgmOn || document.hidden) { bgmNextTime = 0; return; }
      const now = ac.currentTime;
      if (bgmNextTime < now) bgmNextTime = now + 0.05;
      while (bgmNextTime < now + BGM_LOOKAHEAD_SECONDS) {
        scheduleBgmStep(bgmStep, bgmNextTime - now);
        bgmNextTime += BGM_STEP_SECONDS;
        bgmStep++;
      }
    }, BGM_TICK_MS);
  }

  function stopBgm() {
    if (bgmTimer) {
      clearInterval(bgmTimer);
      bgmTimer = null;
    }
  }

  function playSfx(name) {
    if (SFX[name]) SFX[name]();
  }

  function setSfx(enabled) {
    sfxOn = Boolean(enabled);
    localStorage.setItem(SFX_KEY, sfxOn ? "1" : "0");
    if (!sfxOn) {
      stopBgm();
      if (activeCry) { activeCry.pause(); activeCry = null; }
    }
  }

  function setBgm(enabled) {
    bgmOn = Boolean(enabled);
    localStorage.setItem(BGM_KEY, bgmOn ? "1" : "0");
    if (!bgmOn) stopBgm();
  }

  window.BattleAudio = {
    unlock,
    playCry,
    playSfx,
    playEmote,
    startBgm,
    stopBgm,
    setSfx,
    setBgm,
    isSfxEnabled: () => sfxOn,
    isBgmEnabled: () => bgmOn,
  };
})();

