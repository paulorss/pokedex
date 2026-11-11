/* Duelo dos Encantados — arena 3D (Three.js r128).
 * Expõe window.Arena3D.create(container) → arena | null (null quando não há WebGL).
 * Tudo é procedural: criaturas montadas com primitivas, materiais em GLSL próprio
 * e um único sistema de partículas animado na GPU.
 */
(function () {
  "use strict";

  const SIDES = { me: { x: -1.9, z: 1.3 }, foe: { x: 1.9, z: -1.3 } };
  const ELEMENT_COLORS = {
    fire: 0xff6b2b, water: 0x38a3ff, grass: 0x54d169, electric: 0xffe042,
    ice: 0x7de8ff, fighting: 0xf05442, poison: 0xc259eb, ground: 0xe0aa4c,
    flying: 0x8fb8ff, psychic: 0xff65a8, bug: 0xa2d943, rock: 0xd4ad6a,
    ghost: 0x9b78ff, dragon: 0x6f68ff, steel: 0xb2c9db, dark: 0x8e72a6,
    fairy: 0xff94c2, normal: 0xd8e0e8,
  };
  const MAX_PARTICLES = 700;
  const MAX_PIXEL_RATIO = 2;
  const POINT_SCALE_DIVISOR = 170; // partícula de tamanho 60 ≈ 20 px na distância da câmera
  const LUNGE_DISTANCE = 3.1;
  const CHEST_HEIGHT = 0.95;
  const HEAD_HEIGHT = 2.25;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const easeOut = (k) => 1 - Math.pow(1 - k, 3);
  const easeIn = (k) => k * k;
  const easeBack = (k) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- shaders ---------- */
  const TOON_VS = `
    varying vec3 vN; varying vec3 vV;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal);
      vV = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`;
  const TOON_FS = `
    uniform vec3 uColor; uniform vec3 uRim; uniform float uFlash; uniform float uFade;
    varying vec3 vN; varying vec3 vV;
    void main() {
      vec3 n = normalize(vN);
      float d = dot(n, normalize(vec3(0.45, 0.8, 0.5)));
      float shade = 0.52 + 0.26 * smoothstep(-0.05, 0.05, d) + 0.22 * smoothstep(0.5, 0.58, d);
      float rim = pow(1.0 - max(dot(n, normalize(vV)), 0.0), 3.0);
      vec3 c = uColor * shade + uRim * rim * 0.7;
      gl_FragColor = vec4(mix(c, vec3(1.0), uFlash), uFade);
    }`;
  const SPRITE_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const SPRITE_FS = `
    uniform sampler2D uTex; uniform float uHasTex; uniform float uFlip;
    uniform vec3 uColor; uniform vec3 uRim; uniform float uFlash; uniform float uFade;
    varying vec2 vUv;
    void main() {
      if (uHasTex > 0.5) {
        vec2 uv = vec2(uFlip > 0.5 ? 1.0 - vUv.x : vUv.x, vUv.y);
        vec4 tex = texture2D(uTex, uv);
        if (tex.a < 0.08) discard;
        vec3 col = mix(tex.rgb, vec3(1.0), uFlash);
        gl_FragColor = vec4(col, tex.a * uFade);
      } else {
        float d = length(vUv - 0.5);
        if (d > 0.42) discard;
        float glow = smoothstep(0.42, 0.05, d);
        vec3 c = mix(uColor, uRim, 0.35) * glow;
        gl_FragColor = vec4(mix(c, vec3(1.0), uFlash), glow * 0.85 * uFade);
      }
    }`;
  const GROUND_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const GROUND_FS = `
    uniform float uTime; uniform vec3 uA; uniform vec3 uB; uniform float uPulse; uniform vec2 uPulsePos;
    varying vec2 vUv;
    void main() {
      vec2 p = (vUv - 0.5) * 2.0;
      float r = length(p);
      vec3 tint = mix(uA, uB, smoothstep(-0.45, 0.45, p.x * 0.8 + p.y * 0.55));
      float rings = smoothstep(0.86, 1.0, 0.5 + 0.5 * sin(r * 26.0 - uTime * 1.2)) * (1.0 - r);
      float rays = smoothstep(0.75, 1.0, sin(atan(p.y, p.x) * 12.0 + uTime * 0.2)) * smoothstep(0.25, 0.6, r) * (1.0 - r) * 0.25;
      float pulse = uPulse * smoothstep(0.3, 0.0, abs(length(p - uPulsePos) - (1.0 - uPulse) * 0.8));
      vec3 base = mix(vec3(0.04, 0.09, 0.085), vec3(0.09, 0.2, 0.18), 1.0 - r);
      vec3 c = base + tint * (rings * 0.55 + rays + pulse * 0.9 + 0.1 * (1.0 - r));
      gl_FragColor = vec4(c, smoothstep(1.0, 0.8, r));
    }`;
  const SKY_VS = `varying vec3 vP; void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const SKY_FS = `
    uniform float uTime; varying vec3 vP;
    float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main() {
      vec3 d = normalize(vP);
      float t = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
      vec3 c = mix(vec3(0.05, 0.17, 0.18), vec3(0.02, 0.04, 0.09), smoothstep(0.45, 1.0, t));
      c += vec3(0.1, 0.22, 0.2) * smoothstep(0.64, 0.48, t) * 0.6;
      vec2 g = floor(d.xz / max(d.y, 0.05) * 18.0);
      float star = step(0.985, h(g)) * smoothstep(0.1, 0.5, d.y);
      c += star * (0.5 + 0.5 * sin(uTime * 2.0 + h(g + 1.0) * 40.0)) * 0.8;
      gl_FragColor = vec4(c, 1.0);
    }`;
  const SHIELD_FS = `
    uniform vec3 uColor; uniform float uAlpha; uniform float uTime;
    varying vec3 vN; varying vec3 vV;
    void main() {
      float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
      float band = 0.5 + 0.5 * sin(vN.y * 16.0 + uTime * 3.0);
      gl_FragColor = vec4(uColor * (f * 1.5 + band * 0.1) * uAlpha, 1.0);
    }`;
  const POINTS_VS = `
    attribute vec3 aVel; attribute vec4 aInfo; attribute vec3 aColor;
    uniform float uTime; uniform float uScale;
    varying vec3 vColor; varying float vA;
    void main() {
      float t = uTime - aInfo.x;
      float k = t / aInfo.y;
      if (t < 0.0 || k > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; vColor = vec3(0.0); return; }
      vec3 p = position + aVel * t + vec3(0.0, -aInfo.w * t * t, 0.0);
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = aInfo.z * (1.0 - k * 0.6) * uScale / -mv.z;
      vColor = aColor; vA = 1.0 - k;
    }`;
  const POINTS_FS = `
    varying vec3 vColor; varying float vA;
    void main() {
      float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5)) * vA;
      gl_FragColor = vec4(vColor * a, a);
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 80);
    const lookTarget = new THREE.Vector3(0, 0.95, 0);
    const uTime = { value: 0 };
    const tweens = new Set();
    const disposables = [];
    let running = false, rafId = 0, last = 0, shake = 0, fireflyClock = 0, camDist = 8.2, hitStop = 0;
    const camGoal = { x: 0, y: 0.95, z: 0, zoom: 0, timer: 0 };
    const camCur = { x: 0, y: 0.95, z: 0, zoom: 0 };
    function focusOn(side, zoomDelta = 1.15, dur = 0.65) {
      if (reduceMotion) return;
      const s = side ? SIDES[side] : null;
      camGoal.x = s ? s.x * 0.42 : 0;
      camGoal.y = s ? 1.15 : 0.95;
      camGoal.z = s ? s.z * 0.35 : 0;
      camGoal.zoom = zoomDelta;
      camGoal.timer = dur;
    }
    function triggerHitStop(sec = 0.09) {
      if (!reduceMotion) hitStop = Math.max(hitStop, sec);
    }

    const track = (obj) => { disposables.push(obj); return obj; };
    const geo = {
      sphere: track(new THREE.SphereGeometry(1, 20, 14)),
      cone: track(new THREE.ConeGeometry(1, 1, 10)),
      cyl: track(new THREE.CylinderGeometry(1, 1, 1, 10)),
      octa: track(new THREE.OctahedronGeometry(1)),
      torus: track(new THREE.TorusGeometry(1, 0.06, 6, 28)),
      ring: track(new THREE.RingGeometry(0.72, 1, 40)),
      disc: track(new THREE.CircleGeometry(1, 24)),
      plane: track(new THREE.PlaneGeometry(2.55, 2.55)),
    };
    const texLoader = new THREE.TextureLoader();
    texLoader.setCrossOrigin("anonymous");
    const texCache = new Map();
    const artworkUrl = (id) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`;
    const spriteUrl = (id) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${id}.png`;
    function loadPokemonTex(id, onLoad) {
      if (texCache.has(id)) {
        const cached = texCache.get(id);
        if (cached) onLoad(cached);
        return;
      }
      texLoader.load(
        artworkUrl(id),
        (tex) => {
          tex.encoding = THREE.sRGBEncoding;
          texCache.set(id, tex);
          onLoad(tex);
        },
        undefined,
        () => {
          texLoader.load(
            spriteUrl(id),
            (tex) => { tex.encoding = THREE.sRGBEncoding; texCache.set(id, tex); onLoad(tex); },
            undefined,
            () => { texCache.set(id, null); }
          );
        }
      );
    }
    const matWhite = track(new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const matPupil = track(new THREE.MeshBasicMaterial({ color: 0x101418 }));
    const matShadow = track(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));

    function tween(seconds, fn, ease = easeOut) {
      if (!running) { fn(1); return Promise.resolve(); }
      return new Promise((resolve) => tweens.add({ t: 0, dur: seconds, fn, ease, resolve }));
    }

    /* ---------- cenário ---------- */
    const sky = new THREE.Mesh(track(new THREE.SphereGeometry(40, 24, 16)),
      track(new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms: { uTime }, side: THREE.BackSide, depthWrite: false })));
    scene.add(sky);

    const groundU = { uTime, uA: { value: new THREE.Color(0x3a9bff) }, uB: { value: new THREE.Color(0xff7a3d) },
      uPulse: { value: 0 }, uPulsePos: { value: new THREE.Vector2() } };
    const ground = new THREE.Mesh(track(new THREE.CircleGeometry(7, 64)),
      track(new THREE.ShaderMaterial({ vertexShader: GROUND_VS, fragmentShader: GROUND_FS, uniforms: groundU, transparent: true })));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    const treeMat = track(new THREE.MeshBasicMaterial({ color: 0x07201c }));
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + 0.2, r = 8.5 + (i % 3) * 0.9, h = 3 + ((i * 7) % 5) * 0.6;
      const tree = new THREE.Mesh(geo.cone, treeMat);
      tree.scale.set(1.1 + (i % 2) * 0.4, h, 1.1);
      tree.position.set(Math.cos(a) * r, h / 2 - 0.1, Math.sin(a) * r);
      scene.add(tree);
    }

    /* ---------- partículas (animadas no vertex shader) ---------- */
    const pGeo = track(new THREE.BufferGeometry());
    const pPos = new Float32Array(MAX_PARTICLES * 3), pVel = new Float32Array(MAX_PARTICLES * 3);
    const pInfo = new Float32Array(MAX_PARTICLES * 4).fill(-100), pCol = new Float32Array(MAX_PARTICLES * 3);
    pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
    pGeo.setAttribute("aVel", new THREE.BufferAttribute(pVel, 3));
    pGeo.setAttribute("aInfo", new THREE.BufferAttribute(pInfo, 4));
    pGeo.setAttribute("aColor", new THREE.BufferAttribute(pCol, 3));
    const pointsU = { uTime, uScale: { value: 300 } };
    const points = new THREE.Points(pGeo, track(new THREE.ShaderMaterial({
      vertexShader: POINTS_VS, fragmentShader: POINTS_FS, uniforms: pointsU,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
    points.frustumCulled = false;
    scene.add(points);
    let pCursor = 0;
    const tmpColor = new THREE.Color();

    function emit(origin, o) {
      const count = o.count || 12;
      tmpColor.set(o.color || 0xffffff);
      for (let n = 0; n < count; n++) {
        const i = pCursor; pCursor = (pCursor + 1) % MAX_PARTICLES;
        const a = Math.random() * Math.PI * 2, up = (o.up || 0) + (Math.random() - 0.5) * (o.spread ?? 1);
        const sp = (o.speed || 2) * (0.4 + Math.random() * 0.6), jitter = o.radius || 0;
        pPos[i * 3] = origin.x + Math.cos(a) * jitter; pPos[i * 3 + 1] = origin.y + (Math.random() - 0.5) * jitter; pPos[i * 3 + 2] = origin.z + Math.sin(a) * jitter;
        const dir = o.inward ? -1 : 1;
        pVel[i * 3] = Math.cos(a) * sp * dir; pVel[i * 3 + 1] = up * sp + (o.lift || 0); pVel[i * 3 + 2] = Math.sin(a) * sp * dir;
        pInfo[i * 4] = uTime.value; pInfo[i * 4 + 1] = (o.life || 0.7) * (0.6 + Math.random() * 0.4);
        pInfo[i * 4 + 2] = o.size || 60; pInfo[i * 4 + 3] = o.gravity ?? 1.5;
        const tone = 0.7 + Math.random() * 0.3;
        pCol[i * 3] = tmpColor.r * tone; pCol[i * 3 + 1] = tmpColor.g * tone; pCol[i * 3 + 2] = tmpColor.b * tone;
      }
      for (const name of ["position", "aVel", "aInfo", "aColor"]) pGeo.attributes[name].needsUpdate = true;
    }

    /* ---------- efeitos reutilizáveis ---------- */
    const ringMat = () => track(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    const rings = [0, 1, 2].map(() => { const m = new THREE.Mesh(geo.ring, ringMat()); m.visible = false; scene.add(m); return m; });
    let ringCursor = 0;
    function burst(pos, color, size) {
      const ring = rings[ringCursor]; ringCursor = (ringCursor + 1) % rings.length;
      ring.position.copy(pos); ring.material.color.set(color); ring.visible = true;
      return tween(0.42, (k) => {
        ring.scale.setScalar(0.3 + k * size); ring.material.opacity = 1 - k; ring.quaternion.copy(camera.quaternion);
        if (k >= 1) ring.visible = false;
      });
    }
    const orb = new THREE.Mesh(geo.sphere, track(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
    orb.visible = false; scene.add(orb);

    function groundPulse(side) {
      const s = SIDES[side];
      groundU.uPulsePos.value.set(s.x / 7, -s.z / 7);
      return tween(0.7, (k) => { groundU.uPulse.value = k >= 1 ? 0 : 1 - k; });
    }
    function addShake(amount) { if (!reduceMotion) shake = Math.max(shake, amount); }

    /* ---------- Pokémon 3D (artwork oficial + aura elemental) ---------- */
    function spriteMat(hex, rimHex, flipX) {
      return track(new THREE.ShaderMaterial({
        vertexShader: SPRITE_VS,
        fragmentShader: SPRITE_FS,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uTex: { value: null },
          uHasTex: { value: 0 },
          uFlip: { value: flipX ? 1 : 0 },
          uColor: { value: new THREE.Color(hex) },
          uRim: { value: new THREE.Color(rimHex) },
          uFlash: { value: 0 },
          uFade: { value: 1 },
        },
      }));
    }

    function buildModel(def, side) {
      const [c1, c2] = def.colors || ["#3a9bff", "#ffe082"];
      const mat = spriteMat(c1, c2, side === "me");
      const ringMat = track(new THREE.MeshBasicMaterial({
        color: c1, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      const model = new THREE.Group();
      const billboard = new THREE.Mesh(geo.plane, mat);
      billboard.position.set(0, 1.32, 0);
      model.add(billboard);

      const baseRing = new THREE.Mesh(geo.torus, ringMat);
      baseRing.rotation.x = Math.PI / 2;
      baseRing.position.set(0, 0.05, 0);
      baseRing.scale.setScalar(0.95);
      model.add(baseRing);

      const isFlyer = (def.types || []).includes("flying") || (def.types || []).includes("ghost") || (def.types || []).includes("psychic");
      const anim = {
        billboard,
        baseRing,
        hover: isFlyer ? 0.22 : 0.04,
        phase: Math.random() * 6,
      };
      let disposed = false;
      loadPokemonTex(def.id, (tex) => {
        if (disposed) return;
        mat.uniforms.uTex.value = tex;
        mat.uniforms.uHasTex.value = 1;
      });
      return {
        model,
        anim,
        mats: [mat],
        owned: [mat, ringMat],
        markDisposed() { disposed = true; },
      };
    }

    const slots = {};
    for (const side of ["me", "foe"]) {
      const holder = new THREE.Group();
      const s = SIDES[side], o = SIDES[side === "me" ? "foe" : "me"];
      holder.position.set(s.x, 0, s.z);
      holder.rotation.y = Math.atan2(-(o.z - s.z), o.x - s.x);
      const actor = new THREE.Group(); holder.add(actor);
      const shadow = new THREE.Mesh(geo.disc, matShadow); shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.02; shadow.scale.set(0.9, 0.9, 1); holder.add(shadow);
      const shieldU = { uColor: { value: new THREE.Color(0x9fe8ff) }, uAlpha: { value: 0 }, uTime };
      const shield = new THREE.Mesh(geo.sphere, track(new THREE.ShaderMaterial({ vertexShader: TOON_VS, fragmentShader: SHIELD_FS, uniforms: shieldU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
      shield.scale.setScalar(1.5); shield.position.y = CHEST_HEIGHT; shield.visible = false; holder.add(shield);
      scene.add(holder);
      slots[side] = { holder, actor, shadow, shield, shieldU, current: null, color: new THREE.Color(0xffffff), offsetX: 0, lift: 0, squash: 1 };
    }
    const chestOf = (side) => new THREE.Vector3(SIDES[side].x, CHEST_HEIGHT, SIDES[side].z);
    const other = (side) => (side === "me" ? "foe" : "me");

    function disposeCreature(slot) {
      if (!slot.current) return;
      if (slot.current.markDisposed) slot.current.markDisposed();
      slot.actor.remove(slot.current.model);
      slot.current.owned.forEach((m) => { m.dispose(); const i = disposables.indexOf(m); if (i >= 0) disposables.splice(i, 1); });
      slot.current = null;
    }

    function setCreature(side, def, opts = {}) {
      const slot = slots[side];
      disposeCreature(slot);
      slot.current = buildModel(def, side);
      slot.element = def.element || "normal";
      const col = (def.colors && def.colors[0]) || "#3a9bff";
      const col2 = (def.colors && def.colors[1]) || "#ffe082";
      slot.color.set(col);
      slot.actor.add(slot.current.model);
      slot.offsetX = 0; slot.lift = 0; slot.squash = 1;
      slot.actor.rotation.set(0, 0, 0);
      slot.shadow.visible = true;
      groundU[side === "me" ? "uA" : "uB"].value.set(col);
      if (!opts.animate) { slot.actor.scale.setScalar(1); return Promise.resolve(); }
      slot.actor.scale.setScalar(0.01);
      focusOn(side, 0.7, 0.45);
      // Feixe branco-vermelho de invocação pela Pokébola
      burst(chestOf(side), 0xffffff, 2.5);
      emit(chestOf(side), { count: 24, color: 0xff5252, speed: 2.0, life: 0.55, size: 65, up: 1.4, gravity: -0.6 });
      emit(chestOf(side), { count: 30, color: col2, speed: 2.8, life: 0.75, size: 75, up: 0.7 });
      groundPulse(side);
      flash(side, 0.85);
      return tween(0.5, (k) => { slot.actor.scale.setScalar(Math.max(0.01, k)); slot.lift = (1 - k) * 2.2; }, easeBack);
    }

    function flash(side, amount = 1) {
      const slot = slots[side];
      if (!slot.current) return Promise.resolve();
      return tween(0.3, (k) => slot.current && slot.current.mats.forEach((m) => { m.uniforms.uFlash.value = amount * (1 - k); }));
    }
    function recoil(side, strength) {
      const slot = slots[side];
      return tween(0.4, (k) => { slot.offsetX = -strength * Math.sin(k * Math.PI); slot.squash = 1 - 0.14 * Math.sin(k * Math.PI); });
    }
    async function impact(target, color, heavy, guarded, mult = 1) {
      const pos = chestOf(target);
      const isSuper = mult > 1;
      if (!guarded && (heavy || isSuper)) triggerHitStop(isSuper ? 0.11 : 0.085);
      focusOn(target, isSuper ? 1.45 : heavy ? 1.15 : 0.55, heavy ? 0.55 : 0.32);
      addShake(isSuper ? 0.58 : heavy ? 0.44 : 0.22);
      emit(pos, { count: heavy || isSuper ? 64 : 24, color, speed: heavy || isSuper ? 5.4 : 3.4, life: 0.8, size: heavy || isSuper ? 105 : 72, up: 0.55 });
      if (isSuper) {
        emit(pos, { count: 28, color: 0xffffff, speed: 6.0, life: 0.65, size: 80, up: 0.8 });
        burst(pos, 0xffe066, 3.8);
      }
      if (guarded) { slots[target].shieldU.uAlpha.value = 2.2; tween(0.4, (k) => { slots[target].shieldU.uAlpha.value = 2.2 - 1.2 * k; }); }
      await Promise.all([
        burst(pos, color, heavy || isSuper ? 3.4 : 1.9),
        flash(target, guarded ? 0.35 : 1),
        recoil(target, guarded ? 0.12 : isSuper ? 0.65 : heavy ? 0.55 : 0.3),
      ]);
    }

    async function playAttack(side, ev) {
      const slot = slots[side], target = other(side);
      const color = ELEMENT_COLORS[ev.element] || slot.color.getHex();
      const mult = ev.mult || 1;
      const guarded = ev.guarded && !ev.broke_guard;
      if (ev.kind === "golpe") {
        focusOn(side, 0.55, 0.25);
        await tween(0.14, (k) => { slot.offsetX = -0.35 * k; slot.squash = 1 - 0.1 * k; });
        await tween(0.18, (k) => {
          slot.offsetX = -0.35 + (LUNGE_DISTANCE + 0.35) * k;
          slot.squash = 0.9 + 0.2 * k;
          emit(chestOf(side), { count: 2, color, speed: 1.4, life: 0.25, size: 44, gravity: 0 });
        }, easeIn);
        const hit = impact(target, color, mult > 1, guarded, mult);
        await tween(0.34, (k) => { slot.offsetX = LUNGE_DISTANCE * (1 - k); slot.squash = 1.1 - 0.1 * k; });
        await hit;
        return;
      }
      const from = chestOf(side), to = chestOf(target);
      focusOn(side, 1.45, 0.65);
      groundPulse(side);
      emit(from, { count: 42, color, speed: 2.7, life: 0.5, size: 68, radius: 1.65, inward: true, gravity: 0, spread: 0.45 });
      await tween(0.48, (k) => { slot.squash = 1 + 0.2 * k; slot.lift = 0.28 * k; });
      orb.material.color.set(color); orb.visible = true;
      tween(0.25, (k) => { slot.squash = 1.2 - 0.2 * k; slot.lift = 0.28 * (1 - k); });
      focusOn(target, 1.15, 0.45);
      await tween(0.32, (k) => {
        orb.position.lerpVectors(from, to, k); orb.position.y += Math.sin(k * Math.PI) * 0.72;
        orb.scale.setScalar(0.28 + 0.12 * Math.sin(k * 22));
        emit(orb.position, { count: 4, color, speed: 0.85, life: 0.38, size: 62, gravity: 0 });
      }, easeIn);
      orb.visible = false;
      groundPulse(target);
      await impact(target, color, true, guarded, mult);
    }

    function playGuard(side) {
      const slot = slots[side];
      slot.shield.visible = true;
      emit(chestOf(side), { count: 16, color: 0x9fe8ff, speed: 1.6, life: 0.6, size: 50, gravity: -0.5, radius: 0.9 });
      return tween(0.35, (k) => { slot.shieldU.uAlpha.value = k; slot.shield.scale.setScalar(1.1 + 0.4 * k); }, easeBack);
    }
    function clearGuards() {
      for (const side of ["me", "foe"]) {
        const slot = slots[side];
        if (!slot.shield.visible) continue;
        const start = slot.shieldU.uAlpha.value;
        tween(0.3, (k) => { slot.shieldU.uAlpha.value = start * (1 - k); if (k >= 1) slot.shield.visible = false; });
      }
    }
    async function playFaint(side) {
      const slot = slots[side];
      const pos = chestOf(side);
      slot.shield.visible = false;
      focusOn(side, 1.3, 0.8);
      triggerHitStop(0.08);
      addShake(0.5);
      // 1) Impacto vermelho/branco + anéis de choque
      flash(side, 1.0);
      burst(pos, 0xff5252, 3.6);
      emit(pos, { count: 48, color: 0xff6b6b, speed: 3.4, life: 0.9, size: 75, up: 0.6 });
      await tween(0.22, (k) => {
        slot.offsetX = Math.sin(k * 28) * 0.14;
        slot.squash = 1 - 0.2 * Math.sin(k * Math.PI);
      });
      // 2) Recolhimento estilo Pokébola com espiral e desintegração em partículas
      emit(pos, { count: 55, color: slot.color.getHex(), speed: 2.2, life: 1.15, size: 65, gravity: -1.3, radius: 0.85, inward: true, lift: 1.0 });
      groundPulse(side);
      burst(pos, 0xffffff, 2.4);
      await tween(0.68, (k) => {
        slot.actor.rotation.z = 1.65 * k;
        slot.actor.scale.setScalar(Math.max(0.01, 1 - k));
        slot.lift = Math.sin(k * Math.PI) * 0.45 - 0.35 * k;
        if (slot.current) {
          slot.current.mats.forEach((m) => { m.uniforms.uFade.value = Math.max(0, 1 - k * 1.15); });
        }
      }, easeIn);
      slot.shadow.visible = false;
      disposeCreature(slot);
    }
    function aura(side, color, o = {}) {
      emit(chestOf(side), { count: o.count || 28, color, speed: o.speed || 1.2, life: 0.9, size: 55, gravity: o.gravity ?? -1.2, radius: 0.8, lift: o.lift ?? 0.6 });
      return wait(450);
    }

    async function play(ev, side, def) {
      switch (ev.t) {
        case "attack": return playAttack(side, ev);
        case "guard": return playGuard(side);
        case "switch":
          await tween(0.22, (k) => slots[side].actor.scale.setScalar(Math.max(0.01, 1 - k)), easeIn);
          return setCreature(side, def, { animate: true });
        case "enter": return setCreature(side, def, { animate: true });
        case "faint": return playFaint(side);
        case "status": return aura(side, 0xff7a3d, { count: 22 });
        case "burn": flash(side, 0.5); return aura(side, 0xff5a2a, { count: 30, speed: 1.6 });
        case "heal": return aura(side, 0x7dffb0, { count: 34, lift: 1.4 });
        case "drain": return aura(side, 0x6fb7ff, { count: 26, gravity: 2.2, lift: -0.2 });
        default: return Promise.resolve();
      }
    }

    async function celebrate(side) {
      const slot = slots[side];
      const top = new THREE.Vector3(SIDES[side].x, 2.6, SIDES[side].z);
      focusOn(side, 1.35, 1.25);
      emit(top, { count: 110, color: 0xffd166, speed: 3.8, life: 1.7, size: 85, up: 0.95, gravity: 1.7 });
      emit({ x: 0, y: 3.1, z: 0 }, { count: 80, color: 0x69f0ae, speed: 4.2, life: 1.8, size: 70, up: 0.7, gravity: 1.4 });
      burst(top, 0xffd166, 4.2);
      groundPulse(side);
      setTimeout(() => {
        emit(top, { count: 75, color: 0xffffff, speed: 3.2, life: 1.4, size: 70, up: 1.0, gravity: 1.5 });
      }, 360);
      await tween(1.15, (k) => { slot.lift = Math.abs(Math.sin(k * Math.PI * 3)) * 0.78; });
    }
    async function defeatEffect(side) {
      const top = new THREE.Vector3(SIDES[side].x, 3.3, SIDES[side].z);
      emit(top, { count: 75, color: 0x89a8ff, speed: 1.5, life: 1.6, size: 50, up: -0.6, gravity: 1.3, spread: 1.2 });
      emit({ x: 0, y: 3.4, z: 0 }, { count: 60, color: 0x7c6b86, speed: 1.2, life: 1.7, size: 46, up: -0.7, gravity: 1.1, spread: 2.2 });
      addShake(0.28);
      await wait(950);
    }

    const projected = new THREE.Vector3();
    function screenPos(side) {
      projected.set(SIDES[side].x, HEAD_HEIGHT, SIDES[side].z).project(camera);
      return { x: (projected.x * 0.5 + 0.5) * container.clientWidth, y: (0.5 - projected.y * 0.5) * container.clientHeight };
    }

    /* ---------- laço ---------- */
    function idle(slot, t) {
      const cur = slot.current;
      if (!cur) return;
      const a = cur.anim, ph = t * 2 + a.phase;
      const bob = Math.sin(ph) * 0.045 + a.hover + Math.sin(ph * 0.5) * a.hover * 0.35;
      slot.actor.position.set(slot.offsetX, bob + slot.lift, 0);
      cur.model.scale.set(1 / Math.sqrt(slot.squash), slot.squash * (1 + Math.sin(ph) * 0.02), 1 / Math.sqrt(slot.squash));
      if (a.billboard) {
        a.billboard.lookAt(camera.position.x, a.billboard.getWorldPosition(projected).y, camera.position.z);
      }
      if (a.baseRing) a.baseRing.rotation.z = t * 1.4;
      slot.shadow.scale.setScalar(0.95 - Math.min(0.45, (bob + slot.lift) * 0.25));
      slot.shadow.position.x = slot.offsetX;
    }

    function frame(now) {
      if (!running) return;
      rafId = requestAnimationFrame(frame);
      const rawDt = Math.min(0.05, (now - last) / 1000 || 0); last = now;
      if (hitStop > 0) hitStop = Math.max(0, hitStop - rawDt);
      const dt = hitStop > 0 ? 0 : rawDt;
      uTime.value += dt;
      const t = uTime.value;
      if (dt > 0) {
        for (const tw of [...tweens]) {
          tw.t += dt;
          const k = Math.min(1, tw.t / tw.dur);
          tw.fn(tw.ease(k));
          if (k >= 1) { tweens.delete(tw); tw.resolve(); }
        }
        idle(slots.me, t); idle(slots.foe, t);
        fireflyClock += dt;
        if (fireflyClock > 0.28) {
          fireflyClock = 0;
          const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 4.5;
          const elSide = Math.random() < 0.5 ? slots.me.element : slots.foe.element;
          const ambColor = ELEMENT_COLORS[elSide] || 0xd8ffb0;
          const isRain = elSide === "water" || elSide === "ice";
          emit(
            { x: Math.cos(a) * r, y: isRain ? 3.2 : 0.35 + Math.random() * 2, z: Math.sin(a) * r },
            { count: 1, color: ambColor, speed: isRain ? 0.45 : 0.25, life: isRain ? 1.8 : 3.2, size: isRain ? 22 : 28, gravity: isRain ? 0.55 : -0.04 }
          );
        }
      }
      if (camGoal.timer > 0) {
        camGoal.timer = Math.max(0, camGoal.timer - rawDt);
        if (camGoal.timer === 0) { camGoal.x = 0; camGoal.y = 0.95; camGoal.z = 0; camGoal.zoom = 0; }
      }
      const lerpK = 1 - Math.exp(-8.5 * rawDt);
      camCur.x += (camGoal.x - camCur.x) * lerpK;
      camCur.y += (camGoal.y - camCur.y) * lerpK;
      camCur.z += (camGoal.z - camCur.z) * lerpK;
      camCur.zoom += (camGoal.zoom - camCur.zoom) * lerpK;
      shake = Math.max(0, shake - rawDt * 1.6);
      const sway = reduceMotion ? 0 : Math.sin(t * 0.22) * 0.7;
      const dist = Math.max(4.6, camDist - camCur.zoom);
      camera.position.set(
        sway + camCur.x * 0.65 + (Math.random() - 0.5) * shake,
        dist * 0.42 + (camCur.y - 0.95) * 0.5 + (Math.random() - 0.5) * shake,
        dist + camCur.z * 0.35
      );
      lookTarget.set(camCur.x, camCur.y, camCur.z);
      camera.lookAt(lookTarget);
      renderer.render(scene, camera);
    }

    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camDist = 8.2 * Math.max(1, 1.45 / camera.aspect);
      camera.updateProjectionMatrix();
      pointsU.uScale.value = (h * renderer.getPixelRatio()) / POINT_SCALE_DIVISOR;
    }
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    const onVisibility = () => { if (document.hidden) pause(); else if (wantRunning) start(); };
    let wantRunning = false;
    function start() {
      wantRunning = true;
      if (running || document.hidden) return;
      running = true; last = performance.now(); resize();
      rafId = requestAnimationFrame(frame);
    }
    function pause() {
      running = false; cancelAnimationFrame(rafId);
      for (const tw of [...tweens]) { tw.fn(1); tw.resolve(); }
      tweens.clear();
    }
    function stop() { wantRunning = false; pause(); }
    document.addEventListener("visibilitychange", onVisibility);

    function dispose() {
      stop();
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      disposeCreature(slots.me); disposeCreature(slots.foe);
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    }

    return { setCreature, play, clearGuards, celebrate, defeatEffect, focusOn, triggerHitStop, screenPos, start, stop, dispose };
  }

  window.Arena3D = { create };
})();
