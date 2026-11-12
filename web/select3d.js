/* Arena Pokémon Online — palco 3D da tela de seleção (Three.js r128).
 * Expõe window.Select3D.create(container) → palco | null (null quando não há WebGL).
 * Cena procedural: túnel de velocidade, piso de grade neon, pedestal com anéis,
 * arte do Pokémon em billboard com silhueta ao fundo e partículas na GPU.
 */
(function () {
  "use strict";

  const ELEMENT_COLORS = {
    fire: 0xff6b2b, water: 0x38a3ff, grass: 0x54d169, electric: 0xffe042,
    ice: 0x7de8ff, fighting: 0xf05442, poison: 0xc259eb, ground: 0xe0aa4c,
    flying: 0x8fb8ff, psychic: 0xff65a8, bug: 0xa2d943, rock: 0xd4ad6a,
    ghost: 0x9b78ff, dragon: 0x6f68ff, steel: 0xb2c9db, dark: 0x8e72a6,
    fairy: 0xff94c2, normal: 0xd8e0e8,
  };
  const MAX_PIXEL_RATIO = 2;
  const MAX_CACHED_TEXTURES = 36;
  const MOTE_COUNT = 160;
  const ART_SIZE = 3.1;
  const ART_Y = 1.95;
  const CAM_BASE = { x: 0, y: 1.75, z: 7.4 };
  const LOOK_AT = { x: 0, y: 1.55, z: 0 };
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const easeOutBack = (k) => { const c = 1.9; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };
  const artworkUrl = (id) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`;
  const spriteUrl = (id) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${id}.png`;

  const UV_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const SKY_VS = `varying vec3 vP; void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  /* Túnel anime: faixas radiais correndo para o ponto de fuga atrás do pedestal. */
  const SKY_FS = `
    uniform float uTime; uniform vec3 uColor; uniform float uBoost; varying vec3 vP;
    float h(float n) { return fract(sin(n * 91.345) * 47453.5453); }
    void main() {
      vec3 d = normalize(vP);
      vec2 p = vec2(d.x, d.y - 0.12) / max(0.25, -d.z + 0.55);
      float r = length(p);
      float a = atan(p.y, p.x);
      float seg = floor(a * 28.0 / 6.2831853);
      float rnd = h(seg);
      float streak = smoothstep(0.62, 1.0, rnd) * smoothstep(0.0, 0.5, fract(r * (0.6 + rnd) - uTime * (0.35 + rnd * 0.9 + uBoost * 2.2)));
      streak *= smoothstep(0.12, 0.9, r);
      vec3 deep = mix(vec3(0.015, 0.02, 0.06), vec3(0.05, 0.03, 0.12), smoothstep(-0.4, 0.7, d.y));
      vec3 c = deep + uColor * (0.22 * smoothstep(1.3, 0.0, r) + streak * (0.3 + uBoost * 0.9));
      c += vec3(1.0) * smoothstep(0.34, 0.0, r) * (0.1 + uBoost * 0.5);
      gl_FragColor = vec4(c, 1.0);
    }`;
  const FLOOR_FS = `
    uniform float uTime; uniform vec3 uColor; uniform float uPulse; varying vec2 vUv;
    void main() {
      vec2 p = (vUv - 0.5) * 44.0;
      float r = length(p);
      vec2 g = abs(fract(vec2(p.x, p.y + uTime * 1.6) * 0.5) - 0.5);
      float line = smoothstep(0.47, 0.5, max(g.x, g.y));
      float fade = smoothstep(21.0, 2.0, r);
      float ring = smoothstep(0.35, 0.0, abs(r - (1.0 - uPulse) * 9.0)) * uPulse;
      float halo = smoothstep(4.2, 0.0, r);
      vec3 c = vec3(0.02, 0.03, 0.07) + uColor * (line * 0.75 * fade + halo * 0.35 + ring * 1.3);
      gl_FragColor = vec4(c, fade * 0.96 + 0.04);
    }`;
  const ART_FS = `
    uniform sampler2D uTex; uniform float uHasTex; uniform vec3 uColor; uniform float uFlash; uniform float uFade; uniform float uSilhouette;
    varying vec2 vUv;
    void main() {
      if (uHasTex < 0.5) discard;
      vec4 tex = texture2D(uTex, vUv);
      if (tex.a < 0.06) discard;
      vec3 col = mix(tex.rgb, vec3(1.0), uFlash);
      col = mix(col, uColor, uSilhouette);
      gl_FragColor = vec4(col, tex.a * uFade);
    }`;
  const PILLAR_FS = `
    uniform vec3 uColor; uniform float uTime; uniform float uPower; varying vec2 vUv;
    void main() {
      float band = 0.6 + 0.4 * sin(vUv.x * 50.0 + uTime * 2.0);
      float a = pow(1.0 - vUv.y, 2.2) * band * (0.28 + uPower);
      gl_FragColor = vec4(uColor * a, a);
    }`;
  const MOTES_VS = `
    attribute vec4 aSeed; uniform float uTime; uniform float uScale; varying float vA;
    void main() {
      float k = fract(aSeed.w + uTime * (0.05 + aSeed.z * 0.09));
      vec3 p = vec3(aSeed.x, k * 6.0, aSeed.y);
      p.x += sin(uTime * 0.7 + aSeed.w * 40.0) * 0.25;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = (14.0 + aSeed.z * 26.0) * uScale / -mv.z;
      vA = sin(k * 3.14159);
    }`;
  const MOTES_FS = `
    uniform vec3 uColor; varying float vA;
    void main() {
      float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5)) * vA;
      gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.35) * a, a);
    }`;

  function create(container) {
    const THREE = window.THREE;
    if (!THREE) return null;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    } catch (_) {
      return null;
    }
    renderer.setPixelRatio(Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1));
    renderer.outputEncoding = THREE.sRGBEncoding;
    container.appendChild(renderer.domElement);

    const disposables = [];
    const track = (d) => { disposables.push(d); return d; };
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 16 / 9, 0.1, 120);
    const uTime = { value: 0 };
    const uColor = { value: new THREE.Color(0xffb23e) };
    const targetColor = new THREE.Color(0xffb23e);
    const fx = { boost: 0, pulse: 0, flash: 0, pop: 1, whip: 0, power: 0 };

    const skyU = { uTime, uColor, uBoost: { value: 0 } };
    scene.add(new THREE.Mesh(track(new THREE.SphereGeometry(60, 32, 20)),
      track(new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms: skyU, side: THREE.BackSide, depthWrite: false }))));

    const floorU = { uTime, uColor, uPulse: { value: 0 } };
    const floor = new THREE.Mesh(track(new THREE.PlaneGeometry(44, 44)),
      track(new THREE.ShaderMaterial({ vertexShader: UV_VS, fragmentShader: FLOOR_FS, uniforms: floorU, transparent: true })));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    /* pedestal + anéis */
    const pedestalMat = track(new THREE.MeshBasicMaterial({ color: 0x0b1024 }));
    const pedestal = new THREE.Mesh(track(new THREE.CylinderGeometry(1.75, 2.05, 0.28, 48)), pedestalMat);
    pedestal.position.y = 0.14;
    scene.add(pedestal);
    const glowMat = () => track(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    const torusGeo = track(new THREE.TorusGeometry(1, 0.022, 8, 72));
    const rings = [1.78, 2.35, 2.9].map((radius, i) => {
      const ring = new THREE.Mesh(torusGeo, glowMat());
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.3 + i * 0.02;
      ring.userData = { radius, spin: (i % 2 ? -1 : 1) * (0.5 + i * 0.25) };
      scene.add(ring);
      return ring;
    });
    const orbit = new THREE.Mesh(torusGeo, glowMat());
    orbit.scale.setScalar(2.15);
    orbit.position.y = ART_Y;
    scene.add(orbit);

    const pillarU = { uColor, uTime, uPower: { value: 0 } };
    const pillar = new THREE.Mesh(track(new THREE.CylinderGeometry(1.7, 1.7, 5.2, 40, 1, true)),
      track(new THREE.ShaderMaterial({ vertexShader: UV_VS, fragmentShader: PILLAR_FS, uniforms: pillarU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide })));
    pillar.position.y = 2.85;
    scene.add(pillar);

    /* arte + silhueta */
    const artGeo = track(new THREE.PlaneGeometry(ART_SIZE, ART_SIZE));
    const artUniforms = (silhouette) => ({ uTex: { value: null }, uHasTex: { value: 0 }, uColor, uFlash: { value: 0 }, uFade: { value: 1 }, uSilhouette: { value: silhouette } });
    const artU = artUniforms(0);
    const ghostU = artUniforms(1);
    ghostU.uFade.value = 0.2;
    const artMat = (uniforms) => track(new THREE.ShaderMaterial({ vertexShader: UV_VS, fragmentShader: ART_FS, uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    const ghost = new THREE.Mesh(artGeo, artMat(ghostU));
    ghost.position.set(1.5, ART_Y + 0.9, -3.4);
    ghost.scale.setScalar(2.5);
    scene.add(ghost);
    const art = new THREE.Mesh(artGeo, artMat(artU));
    art.position.y = ART_Y;
    scene.add(art);

    /* partículas */
    const seeds = new Float32Array(MOTE_COUNT * 4);
    for (let i = 0; i < MOTE_COUNT; i++) {
      const a = Math.random() * Math.PI * 2, r = 1.2 + Math.random() * 7;
      seeds.set([Math.cos(a) * r, Math.sin(a) * r - 1.5, Math.random(), Math.random()], i * 4);
    }
    const motesGeo = track(new THREE.BufferGeometry());
    motesGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MOTE_COUNT * 3), 3));
    motesGeo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
    const motesU = { uTime, uColor, uScale: { value: 1 } };
    const motes = new THREE.Points(motesGeo, track(new THREE.ShaderMaterial({ vertexShader: MOTES_VS, fragmentShader: MOTES_FS, uniforms: motesU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
    motes.frustumCulled = false;
    scene.add(motes);

    /* texturas */
    const texLoader = new THREE.TextureLoader();
    texLoader.setCrossOrigin("anonymous");
    const texCache = new Map();
    function remember(id, tex) {
      texCache.set(id, tex);
      if (texCache.size <= MAX_CACHED_TEXTURES) return;
      const oldest = texCache.keys().next().value;
      const old = texCache.get(oldest);
      texCache.delete(oldest);
      if (old && old !== artU.uTex.value) old.dispose();
    }
    function loadTexture(id, onLoad) {
      if (texCache.has(id)) { onLoad(texCache.get(id)); return; }
      const done = (tex) => { if (tex) tex.encoding = THREE.sRGBEncoding; remember(id, tex); onLoad(tex); };
      texLoader.load(artworkUrl(id), done, undefined, () => texLoader.load(spriteUrl(id), done, undefined, () => done(null)));
    }

    let shownId = null;
    let requestId = 0;
    function applyTexture(tex) {
      for (const u of [artU, ghostU]) { u.uTex.value = tex; u.uHasTex.value = tex ? 1 : 0; }
    }
    /** Troca o Pokémon em destaque com flash, "pop" e chicote de câmera. */
    function show(def) {
      if (!def || def.id === shownId) return;
      shownId = def.id;
      targetColor.setHex(ELEMENT_COLORS[def.element] || ELEMENT_COLORS.normal);
      const ticket = ++requestId;
      loadTexture(def.id, (tex) => {
        if (ticket !== requestId || disposed) return;
        applyTexture(tex);
        fx.flash = 1; fx.pop = 0; fx.whip = 1; fx.boost = Math.max(fx.boost, 0.55); fx.pulse = 1;
      });
    }
    /** Confirmação de escolha: explosão de luz e anéis. */
    function slam(strength = 1) {
      fx.flash = 1; fx.boost = strength; fx.pulse = 1; fx.power = strength; fx.pop = Math.min(fx.pop, 0.72);
    }

    const pointer = { x: 0, y: 0 };
    const onPointer = (e) => {
      const b = container.getBoundingClientRect();
      if (!b.width || !b.height) return;
      pointer.x = ((e.clientX - b.left) / b.width - 0.5) * 2;
      pointer.y = ((e.clientY - b.top) / b.height - 0.5) * 2;
    };
    container.addEventListener("pointermove", onPointer);

    let running = false, wantRunning = false, disposed = false, rafId = 0, last = 0;
    const camPos = { x: CAM_BASE.x, y: CAM_BASE.y };
    function frame(now) {
      if (!running) return;
      rafId = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000 || 0); last = now;
      uTime.value += dt;
      const t = uTime.value;
      const decay = (v, rate) => Math.max(0, v - dt * rate);
      fx.flash = decay(fx.flash, 3.4); fx.boost = decay(fx.boost, 1.5); fx.pulse = decay(fx.pulse, 1.5);
      fx.whip = decay(fx.whip, 3.2); fx.power = decay(fx.power, 1.1);
      fx.pop = Math.min(1, fx.pop + dt * 3.6);
      uColor.value.lerp(targetColor, 1 - Math.exp(-9 * dt));

      skyU.uBoost.value = fx.boost;
      floorU.uPulse.value = fx.pulse;
      pillarU.uPower.value = fx.power + fx.flash * 0.35;
      artU.uFlash.value = fx.flash * 0.85;

      const pop = easeOutBack(fx.pop);
      const bob = reduceMotion ? 0 : Math.sin(t * 1.5) * 0.07;
      art.position.y = ART_Y + bob;
      art.scale.set(pop, pop * (1 + (1 - fx.pop) * 0.25), 1);
      ghost.scale.setScalar(2.5 + fx.flash * 0.35);
      rings.forEach((ring) => {
        ring.scale.setScalar(ring.userData.radius * (1 + fx.pulse * 0.22));
        ring.rotation.z = t * ring.userData.spin;
        ring.material.color.copy(uColor.value);
        ring.material.opacity = 0.5 + fx.pulse * 0.5;
      });
      orbit.rotation.set(Math.PI / 2 + Math.sin(t * 0.6) * 0.5, t * 0.8, 0);
      orbit.material.color.copy(uColor.value);
      orbit.material.opacity = 0.35 + fx.power * 0.5;

      const sway = reduceMotion ? 0 : Math.sin(t * 0.25) * 0.55;
      const goalX = CAM_BASE.x + sway + pointer.x * 0.7 + fx.whip * fx.whip * 1.6;
      const goalY = CAM_BASE.y - pointer.y * 0.3;
      const lerpK = 1 - Math.exp(-6 * dt);
      camPos.x += (goalX - camPos.x) * lerpK;
      camPos.y += (goalY - camPos.y) * lerpK;
      camera.position.set(camPos.x, camPos.y, camDist - fx.power * 0.9);
      camera.lookAt(LOOK_AT.x, LOOK_AT.y, LOOK_AT.z);
      art.lookAt(camera.position.x, art.position.y, camera.position.z);
      ghost.lookAt(camera.position.x, ghost.position.y, camera.position.z);
      renderer.render(scene, camera);
    }

    let camDist = CAM_BASE.z;
    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camDist = CAM_BASE.z * Math.max(1, 1.25 / camera.aspect);
      camera.updateProjectionMatrix();
      motesU.uScale.value = (h * renderer.getPixelRatio()) / 170;
    }
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    const onVisibility = () => { if (document.hidden) pause(); else if (wantRunning) start(); };
    document.addEventListener("visibilitychange", onVisibility);
    function start() {
      wantRunning = true;
      if (running || document.hidden || disposed) return;
      running = true; last = performance.now(); resize();
      rafId = requestAnimationFrame(frame);
    }
    function pause() { running = false; cancelAnimationFrame(rafId); }
    function stop() { wantRunning = false; pause(); }
    function dispose() {
      disposed = true;
      stop();
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      container.removeEventListener("pointermove", onPointer);
      texCache.forEach((tex) => { if (tex) tex.dispose(); });
      texCache.clear();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    }

    return { show, slam, start, stop, dispose };
  }

  window.Select3D = { create };
})();
