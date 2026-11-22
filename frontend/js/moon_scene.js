import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

const SCALE = 1 / 1000;

const STATUS_COLORS = {
  CLEARED: 0x67e8f9,
  SELECTED: 0x67e8f9,
  NOMINAL: 0x38bdf8,
  WATCH: 0xf59e0b,
  ELEVATED: 0xfb7185,
};

function heightCanvasToNormalMap(heightCanvas, strength = 2.6, attenuatePoles = false) {
  const w = heightCanvas.width;
  const h = heightCanvas.height;
  const ctx = heightCanvas.getContext("2d");
  const src = ctx.getImageData(0, 0, w, h).data;

  const normalCanvas = document.createElement("canvas");
  normalCanvas.width = w;
  normalCanvas.height = h;
  const nCtx = normalCanvas.getContext("2d");
  const dst = nCtx.createImageData(w, h);
  const out = dst.data;

  const sample = (x, y) => {
    const wx = (x + w) % w;
    const wy = Math.max(0, Math.min(h - 1, y));
    return src[(wy * w + wx) * 4] / 255;
  };

  for (let y = 0; y < h; y++) {
    let localStrength = strength;
    if (attenuatePoles) {
      const v = y / (h - 1);
      const poleDist = Math.min(v, 1 - v) * 2;
      const fade = Math.pow(Math.min(1, poleDist / 0.32), 2.2);
      localStrength = strength * fade;
    }

    for (let x = 0; x < w; x++) {
      const tl = sample(x - 1, y - 1);
      const t = sample(x, y - 1);
      const tr = sample(x + 1, y - 1);
      const l = sample(x - 1, y);
      const r = sample(x + 1, y);
      const bl = sample(x - 1, y + 1);
      const b = sample(x, y + 1);
      const br = sample(x + 1, y + 1);

      const dX = (tr + 2 * r + br - (tl + 2 * l + bl)) * localStrength;
      const dY = (bl + 2 * b + br - (tl + 2 * t + tr)) * localStrength;
      const dZ = 1.0;

      const invLen = 1.0 / Math.hypot(dX, dY, dZ);
      const idx = (y * w + x) * 4;
      out[idx] = ((dX * invLen) * 0.5 + 0.5) * 255;
      out[idx + 1] = ((dY * invLen) * 0.5 + 0.5) * 255;
      out[idx + 2] = ((dZ * invLen) * 0.5 + 0.5) * 255;
      out[idx + 3] = 255;
    }
  }

  nCtx.putImageData(dst, 0, 0);
  const tex = new THREE.CanvasTexture(normalCanvas);
  tex.anisotropy = 16;
  return tex;
}

/**
 * Processes moon_map.jpg so BOTH front and back hemispheres feature
 * realistic dark basaltic maria alongside crisp silver highlands & craters.
 */
function processLunarTextureFromImage(img) {
  const w = Math.min(img.width || 2048, 4096);
  const h = Math.min(img.height || 1024, 2048);

  const albedoCanvas = document.createElement("canvas");
  albedoCanvas.width = w;
  albedoCanvas.height = h;
  const aCtx = albedoCanvas.getContext("2d");
  aCtx.drawImage(img, 0, 0, w, h);

  const imgData = aCtx.getImageData(0, 0, w, h);
  const d = imgData.data;

  // Compute baseline luminance array first
  const lumArr = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    let lum = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) / 255;
    lum = Math.pow(lum, 1.32);
    const sCurve = lum * lum * (3 - 2 * lum);
    lumArr[i] = sCurve * 0.62 + lum * 0.38;
  }

  // Blend subtle maria tonal variation from opposite longitude onto bright farside highlands
  // so rotating 360° behind the Moon shows consistent dark seas + silver craters
  for (let y = 0; y < h; y++) {
    const latWeight = Math.sin((y / (h - 1)) * Math.PI); // strongest near equator, 0 at poles
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      let lum = lumArr[idx];

      // Sample opposite hemisphere (shifted by half-width + slight vertical offset for organic look)
      const oppX = (x + Math.floor(w * 0.52)) % w;
      const oppY = Math.min(h - 1, Math.max(0, h - 1 - y));
      const oppLum = lumArr[oppY * w + oppX];

      // Where current side is uniformly bright highlands (> 0.48) and opposite side has dark maria (< 0.38),
      // subtly infuse realistic basaltic sea shading while preserving 100% of local craters
      if (lum > 0.44 && oppLum < 0.40) {
        const mariaBlend = (0.40 - oppLum) * 1.15 * latWeight;
        lum = lum * (1.0 - Math.min(0.48, mariaBlend));
      }

      const val = Math.max(0, Math.min(255, lum * 246));
      const p = idx * 4;
      d[p] = val;
      d[p + 1] = val;
      d[p + 2] = Math.min(255, val * 1.01);
    }
  }
  aCtx.putImageData(imgData, 0, 0);

  const smoothHeight = document.createElement("canvas");
  smoothHeight.width = w;
  smoothHeight.height = h;
  const sCtx = smoothHeight.getContext("2d");
  sCtx.filter = "blur(0.95px)";
  sCtx.drawImage(albedoCanvas, 0, 0, w, h);

  const map = new THREE.CanvasTexture(albedoCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 16;

  const normalMap = heightCanvasToNormalMap(smoothHeight, 1.35, true);
  const bumpMap = new THREE.CanvasTexture(smoothHeight);
  bumpMap.anisotropy = 16;

  return { map, normalMap, bumpMap };
}

function createSpacecraftMaterialMaps() {
  const foilCanvas = document.createElement("canvas");
  foilCanvas.width = 256;
  foilCanvas.height = 256;
  const fCtx = foilCanvas.getContext("2d");
  fCtx.fillStyle = "#808080";
  fCtx.fillRect(0, 0, 256, 256);

  let s = 9012;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  for (let i = 0; i < 420; i++) {
    const x1 = rnd() * 256;
    const y1 = rnd() * 256;
    const x2 = x1 + (rnd() - 0.5) * 42;
    const y2 = y1 + (rnd() - 0.5) * 42;
    const lum = Math.floor(70 + rnd() * 140);
    fCtx.strokeStyle = `rgb(${lum},${lum},${lum})`;
    fCtx.lineWidth = 1 + rnd() * 2;
    fCtx.beginPath();
    fCtx.moveTo(x1, y1);
    fCtx.lineTo(x2, y2);
    fCtx.stroke();
  }
  const foilNormal = heightCanvasToNormalMap(foilCanvas, 3.0, false);
  foilNormal.wrapS = foilNormal.wrapT = THREE.RepeatWrapping;

  const sw = 1024;
  const sh = 512;
  const solarCanvas = document.createElement("canvas");
  solarCanvas.width = sw;
  solarCanvas.height = sh;
  const sCtx = solarCanvas.getContext("2d");

  const solarHeight = document.createElement("canvas");
  solarHeight.width = sw;
  solarHeight.height = sh;
  const shCtx = solarHeight.getContext("2d");

  sCtx.fillStyle = "#080b10";
  sCtx.fillRect(0, 0, sw, sh);
  shCtx.fillStyle = "#404040";
  shCtx.fillRect(0, 0, sw, sh);

  const subPanels = 3;
  const panelGap = 10;
  const subW = (sw - panelGap * (subPanels - 1)) / subPanels;

  for (let p = 0; p < subPanels; p++) {
    const px = p * (subW + panelGap);
    sCtx.fillStyle = "#334155";
    sCtx.fillRect(px, 0, subW, sh);
    shCtx.fillStyle = "#e0e0e0";
    shCtx.fillRect(px, 0, subW, sh);

    const pad = 8;
    const innerX = px + pad;
    const innerY = pad;
    const innerW = subW - pad * 2;
    const innerH = sh - pad * 2;

    sCtx.fillStyle = "#090d16";
    sCtx.fillRect(innerX, innerY, innerW, innerH);

    const cols = 6;
    const rows = 10;
    const cw = innerW / cols;
    const ch = innerH / rows;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = innerX + c * cw + 2;
        const cy = innerY + r * ch + 2;
        const wCell = cw - 4;
        const hCell = ch - 4;
        const cut = Math.min(wCell, hCell) * 0.16;

        const v = 16 + Math.floor(rnd() * 8);
        sCtx.fillStyle = `rgb(${v}, ${v + 6}, ${v + 18})`;
        sCtx.beginPath();
        sCtx.moveTo(cx + cut, cy);
        sCtx.lineTo(cx + wCell - cut, cy);
        sCtx.lineTo(cx + wCell, cy + cut);
        sCtx.lineTo(cx + wCell, cy + hCell - cut);
        sCtx.lineTo(cx + wCell - cut, cy + hCell);
        sCtx.lineTo(cx + cut, cy + hCell);
        sCtx.lineTo(cx, cy + hCell - cut);
        sCtx.lineTo(cx, cy + cut);
        sCtx.closePath();
        sCtx.fill();

        shCtx.fillStyle = "#b8b8b8";
        shCtx.fillRect(cx + 1, cy + 1, wCell - 2, hCell - 2);

        sCtx.fillStyle = "rgba(148, 163, 184, 0.32)";
        sCtx.fillRect(cx + wCell * 0.28, cy + 2, 1.0, hCell - 4);
        sCtx.fillRect(cx + wCell * 0.72, cy + 2, 1.0, hCell - 4);

        sCtx.fillStyle = "#94a3b8";
        sCtx.fillRect(cx + wCell * 0.26, cy - 2, 3, 4);
        sCtx.fillRect(cx + wCell * 0.70, cy - 2, 3, 4);
      }
    }
  }

  const solarMap = new THREE.CanvasTexture(solarCanvas);
  solarMap.colorSpace = THREE.SRGBColorSpace;
  solarMap.anisotropy = 16;

  const solarNormal = heightCanvasToNormalMap(solarHeight, 2.2, false);

  return { foilNormal, solarMap, solarNormal };
}

let SHARED_SAT_MAPS = null;

function buildRealisticSolarWing(length, width, sideSign, solarMat, frameMat) {
  const wingGroup = new THREE.Group();

  const yokeLen = length * 0.22;
  const strutGeo = new THREE.CylinderGeometry(width * 0.014, width * 0.014, yokeLen * 1.15, 8);
  const strutTop = new THREE.Mesh(strutGeo, frameMat);
  strutTop.position.set(sideSign * (yokeLen * 0.5), 0, width * 0.24);
  strutTop.rotation.z = Math.PI / 2;
  strutTop.rotation.y = sideSign * 0.36;

  const strutBot = new THREE.Mesh(strutGeo, frameMat);
  strutBot.position.set(sideSign * (yokeLen * 0.5), 0, -width * 0.24);
  strutBot.rotation.z = Math.PI / 2;
  strutBot.rotation.y = -sideSign * 0.36;

  const crossBar = new THREE.Mesh(
    new THREE.CylinderGeometry(width * 0.016, width * 0.016, width * 0.88, 8),
    frameMat
  );
  crossBar.position.set(sideSign * yokeLen, 0, 0);
  crossBar.rotation.x = Math.PI / 2;

  wingGroup.add(strutTop, strutBot, crossBar);

  const panelLen = length * 0.78;
  const thickness = width * 0.022;
  const panelCenterX = sideSign * (yokeLen + panelLen * 0.5);

  const panelMesh = new THREE.Mesh(
    new THREE.BoxGeometry(panelLen, thickness, width),
    [
      frameMat,
      frameMat,
      solarMat,
      frameMat,
      frameMat,
      frameMat,
    ]
  );
  panelMesh.position.set(panelCenterX, 0, 0);
  wingGroup.add(panelMesh);

  [-0.17, 0.17].forEach((offsetFrac) => {
    const rib = new THREE.Mesh(
      new THREE.BoxGeometry(panelLen * 0.022, thickness * 1.45, width * 1.02),
      frameMat
    );
    rib.position.set(panelCenterX + offsetFrac * panelLen, 0, 0);
    wingGroup.add(rib);
  });

  return wingGroup;
}

function createCleanFallbackLunarTextures() {
  const width = 2048;
  const height = 1024;

  const colorCanvas = document.createElement("canvas");
  colorCanvas.width = width;
  colorCanvas.height = height;
  const ctx = colorCanvas.getContext("2d");

  const bumpCanvas = document.createElement("canvas");
  bumpCanvas.width = width;
  bumpCanvas.height = height;
  const bCtx = bumpCanvas.getContext("2d");

  ctx.fillStyle = "#8a909a";
  ctx.fillRect(0, 0, width, height);
  bCtx.fillStyle = "#808080";
  bCtx.fillRect(0, 0, width, height);

  let seed = 7741;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  const maria = [
    [620, 340, 230, 155],
    [790, 295, 175, 125],
    [475, 460, 195, 140],
    [1060, 410, 215, 165],
    [1380, 360, 180, 125],
    [930, 560, 150, 115],
  ];
  maria.forEach(([x, y, rx, ry]) => {
    for (let k = 0; k < 7; k++) {
      const ox = x + (rand() - 0.5) * rx * 0.7;
      const oy = y + (rand() - 0.5) * ry * 0.7;
      const rSub = rx * (0.38 + rand() * 0.42);
      const grad = ctx.createRadialGradient(ox, oy, rSub * 0.1, ox, oy, rSub);
      grad.addColorStop(0, "rgba(38, 42, 48, 0.65)");
      grad.addColorStop(0.65, "rgba(56, 61, 70, 0.35)");
      grad.addColorStop(1, "rgba(56, 61, 70, 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(ox, oy, rSub, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  for (let i = 0; i < 950; i++) {
    const cx = rand() * width;
    const cy = 60 + rand() * (height - 120);
    const r = 2 + Math.pow(rand(), 3.2) * 38;

    const cGrad = ctx.createRadialGradient(cx - r * 0.12, cy - r * 0.12, r * 0.08, cx, cy, r);
    cGrad.addColorStop(0, "rgba(46, 50, 58, 0.48)");
    cGrad.addColorStop(0.74, "rgba(82, 88, 98, 0.28)");
    cGrad.addColorStop(0.9, "rgba(195, 202, 212, 0.46)");
    cGrad.addColorStop(1, "rgba(138, 144, 154, 0)");
    ctx.fillStyle = cGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    const bGrad = bCtx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
    bGrad.addColorStop(0, "rgba(55, 55, 55, 0.65)");
    bGrad.addColorStop(0.78, "rgba(115, 115, 115, 0.35)");
    bGrad.addColorStop(0.92, "rgba(195, 195, 195, 0.65)");
    bGrad.addColorStop(1, "rgba(128, 128, 128, 0)");
    bCtx.fillStyle = bGrad;
    bCtx.beginPath();
    bCtx.arc(cx, cy, r, 0, Math.PI * 2);
    bCtx.fill();
  }

  const map = new THREE.CanvasTexture(colorCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 16;

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.anisotropy = 16;

  return { map, bumpMap };
}

function buildDetailedSpacecraft(statusColorHex, isSelected, isDebris = false) {
  if (!SHARED_SAT_MAPS) {
    SHARED_SAT_MAPS = createSpacecraftMaterialMaps();
  }

  const group = new THREE.Group();
  const s = isSelected ? 1.3 : 1.0;

  if (isDebris) {
    const hullMat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      normalMap: SHARED_SAT_MAPS.foilNormal,
      normalScale: new THREE.Vector2(0.4, 0.4),
      metalness: 0.85,
      roughness: 0.38,
    });
    const stage = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022 * s, 0.028 * s, 0.085 * s, 16),
      hullMat
    );
    stage.rotation.set(0.65, 0.25, 0.85);
    group.add(stage);

    const nozzle = new THREE.Mesh(
      new THREE.ConeGeometry(0.018 * s, 0.025 * s, 14, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.9, roughness: 0.3, side: THREE.DoubleSide })
    );
    nozzle.position.set(0.028 * s, -0.028 * s, 0.01 * s);
    nozzle.rotation.set(0.65, 0.25, 0.85);
    group.add(nozzle);
  } else {
    const goldFoilMat = new THREE.MeshStandardMaterial({
      color: 0xd97706,
      emissive: 0x291002,
      emissiveIntensity: 0.2,
      normalMap: SHARED_SAT_MAPS.foilNormal,
      normalScale: new THREE.Vector2(1.1, 1.1),
      metalness: 0.92,
      roughness: 0.26,
    });

    const bus = new THREE.Mesh(
      new THREE.BoxGeometry(0.044 * s, 0.044 * s, 0.062 * s),
      goldFoilMat
    );
    group.add(bus);

    const titaniumMat = new THREE.MeshStandardMaterial({
      color: 0xcbd5e1,
      metalness: 0.88,
      roughness: 0.24,
    });
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(0.048 * s, 0.008 * s, 0.066 * s),
      titaniumMat
    );
    deck.position.y = 0.024 * s;
    group.add(deck);

    const dish = new THREE.Mesh(
      new THREE.SphereGeometry(0.024 * s, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.42),
      titaniumMat
    );
    dish.position.set(0, 0.042 * s, 0.008 * s);
    dish.rotation.x = Math.PI;
    group.add(dish);

    const feedHorn = new THREE.Mesh(
      new THREE.CylinderGeometry(0.002 * s, 0.003 * s, 0.022 * s, 8),
      titaniumMat
    );
    feedHorn.position.set(0, 0.036 * s, 0.008 * s);
    group.add(feedHorn);

    const solarMat = new THREE.MeshStandardMaterial({
      map: SHARED_SAT_MAPS.solarMap,
      normalMap: SHARED_SAT_MAPS.solarNormal,
      normalScale: new THREE.Vector2(0.55, 0.55),
      metalness: 0.78,
      roughness: 0.2,
    });

    const wingL = buildRealisticSolarWing(0.145 * s, 0.04 * s, -1, solarMat, titaniumMat);
    wingL.position.set(-0.022 * s, 0, 0);
    const wingR = buildRealisticSolarWing(0.145 * s, 0.04 * s, 1, solarMat, titaniumMat);
    wingR.position.set(0.022 * s, 0, 0);
    group.add(wingL, wingR);

    const thruster = new THREE.Mesh(
      new THREE.ConeGeometry(0.012 * s, 0.02 * s, 14, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.9, roughness: 0.25, side: THREE.DoubleSide })
    );
    thruster.position.set(0, 0, -0.038 * s);
    thruster.rotation.x = -Math.PI / 2;
    group.add(thruster);
  }

  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.013 * s, 12, 12),
    new THREE.MeshBasicMaterial({ color: statusColorHex })
  );
  beacon.position.set(0, 0, 0.036 * s);
  group.add(beacon);

  const hitSphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.15, 8, 8),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  group.add(hitSphere);

  return { group, hitSphere };
}

export class CislunarScene {
  constructor(container, onSelectSpacecraft) {
    this.container = container;
    this.onSelectSpacecraft = onSelectSpacecraft;
    this.selectedId = null;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      40,
      container.clientWidth / container.clientHeight,
      0.1,
      100
    );
    this.camera.position.set(4.6, 1.35, 4.9);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      0.22,
      0.45,
      0.92
    );
    this.composer.addPass(bloomPass);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 2.35;
    this.controls.maxDistance = 16.0;

    this.orbitGroup = new THREE.Group();
    this.cpaGroup = new THREE.Group();
    this.scene.add(this.orbitGroup);
    this.scene.add(this.cpaGroup);

    this.satHitTargets = [];
    this.previewLine = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    this._setupLightsAndStars();
    this._setupMoon();
    this._bindEvents();
    this._animate();
  }

  _setupLightsAndStars() {
    const ambient = new THREE.AmbientLight(0x94a3b8, 0.42);
    this.scene.add(ambient);

    const sunFront = new THREE.DirectionalLight(0xffffff, 2.55);
    sunFront.position.set(7.5, 3.4, 5.5);
    this.scene.add(sunFront);

    const sunBack = new THREE.DirectionalLight(0xf8fafc, 2.45);
    sunBack.position.set(-7.5, 2.8, -6.2);
    this.scene.add(sunBack);

    const rimLeft = new THREE.DirectionalLight(0xcbd5e1, 0.72);
    rimLeft.position.set(-6.5, -1.6, 4.2);
    this.scene.add(rimLeft);

    const rimRight = new THREE.DirectionalLight(0xcbd5e1, 0.72);
    rimRight.position.set(6.5, -1.6, -4.2);
    this.scene.add(rimRight);

    const starCount = 2200;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);
    const palette = [
      new THREE.Color(0xffffff),
      new THREE.Color(0xcbd5e1),
      new THREE.Color(0xbae6fd),
      new THREE.Color(0xfef3c7),
    ];

    for (let i = 0; i < starCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 85;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 85;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 85;
      const c = palette[i % palette.length];
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.075,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
    });
    this.scene.add(new THREE.Points(geo, mat));
  }

  _setupMoon() {
    const fallback = createCleanFallbackLunarTextures();
    const geometry = new THREE.SphereGeometry(1737.4 * SCALE, 224, 224);
    const material = new THREE.MeshStandardMaterial({
      map: fallback.map,
      bumpMap: fallback.bumpMap,
      bumpScale: 0.024,
      roughness: 0.95,
      metalness: 0.0,
    });

    const loader = new THREE.TextureLoader();
    loader.load(
      "/assets/textures/moon_map.jpg",
      (loadedTex) => {
        if (loadedTex.image) {
          const processed = processLunarTextureFromImage(loadedTex.image);
          material.map = processed.map;
          material.normalMap = processed.normalMap;
          material.normalScale = new THREE.Vector2(0.75, 0.75);
          material.bumpMap = processed.bumpMap;
          material.bumpScale = 0.024;
        } else {
          loadedTex.colorSpace = THREE.SRGBColorSpace;
          material.map = loadedTex;
          material.bumpMap = loadedTex;
          material.bumpScale = 0.024;
        }
        material.needsUpdate = true;
      },
      undefined,
      () => {}
    );

    this.moonMesh = new THREE.Mesh(geometry, material);
    this.moonMesh.rotation.y = -0.82;
    this.scene.add(this.moonMesh);

    const rimGeo = new THREE.SphereGeometry(1737.4 * SCALE * 1.007, 96, 96);
    const rimMat = new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      uniforms: {
        glowColor: { value: new THREE.Color(0x93c5fd) },
      },
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 glowColor;
        varying vec3 vNormal;
        void main() {
          float intensity = pow(0.58 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.6);
          gl_FragColor = vec4(glowColor, intensity * 0.34);
        }
      `,
    });
    this.scene.add(new THREE.Mesh(rimGeo, rimMat));
  }

  _toVector3(coordsKm) {
    return new THREE.Vector3(
      coordsKm[0] * SCALE,
      coordsKm[2] * SCALE,
      -coordsKm[1] * SCALE
    );
  }

  updateState(snapshot, selectedId) {
    this.selectedId = selectedId;

    while (this.orbitGroup.children.length > 0) {
      this.orbitGroup.remove(this.orbitGroup.children[0]);
    }
    while (this.cpaGroup.children.length > 0) {
      this.cpaGroup.remove(this.cpaGroup.children[0]);
    }
    this.satHitTargets = [];

    snapshot.objects.forEach((sc) => {
      const isSelected = sc.id === selectedId;
      let colorHex = STATUS_COLORS[sc.status] || STATUS_COLORS.NOMINAL;
      if (isSelected && sc.status === "NOMINAL") {
        colorHex = STATUS_COLORS.SELECTED;
      }

      const points = sc.trajectory_km.map((pt) => this._toVector3(pt));
      const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
      const lineMat = new THREE.LineBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: isSelected ? 0.98 : 0.65,
      });
      this.orbitGroup.add(new THREE.Line(lineGeo, lineMat));

      const isDebris = sc.id.startsWith("DEB") || sc.name.toLowerCase().includes("debris");
      const { group: satModel, hitSphere } = buildDetailedSpacecraft(colorHex, isSelected, isDebris);

      const pos = this._toVector3(sc.position_km);
      satModel.position.copy(pos);

      if (points.length > 2) {
        satModel.lookAt(points[1]);
      }

      hitSphere.userData = { spacecraftId: sc.id };
      this.satHitTargets.push(hitSphere);
      this.orbitGroup.add(satModel);

      if (isSelected || sc.status === "ELEVATED") {
        const ringGeo = new THREE.RingGeometry(0.115, 0.138, 36);
        const ringMat = new THREE.MeshBasicMaterial({
          color: colorHex,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.72,
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.position.copy(pos);
        ring.lookAt(this.camera.position);
        this.orbitGroup.add(ring);
      }
    });

    snapshot.conjunctions.forEach((cnj) => {
      const cpaGeo = new THREE.OctahedronGeometry(0.068, 0);
      const cpaMat = new THREE.MeshBasicMaterial({
        color: cnj.severity === "ELEVATED" ? STATUS_COLORS.ELEVATED : STATUS_COLORS.WATCH,
        wireframe: true,
      });
      const beacon = new THREE.Mesh(cpaGeo, cpaMat);
      beacon.position.copy(this._toVector3(cnj.cpa_position_km));
      this.cpaGroup.add(beacon);
    });
  }

  renderPreviewTrajectory(trajectoryKm) {
    if (this.previewLine) {
      this.scene.remove(this.previewLine);
      this.previewLine = null;
    }
    if (!trajectoryKm || trajectoryKm.length === 0) return;

    const points = trajectoryKm.map((pt) => this._toVector3(pt));
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineDashedMaterial({
      color: 0x67e8f9,
      dashSize: 0.12,
      gapSize: 0.07,
    });
    this.previewLine = new THREE.Line(geo, mat);
    this.previewLine.computeLineDistances();
    this.scene.add(this.previewLine);
  }

  _bindEvents() {
    window.addEventListener("resize", () => {
      if (!this.container.clientWidth || !this.container.clientHeight) return;
      this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
      this.composer.setSize(this.container.clientWidth, this.container.clientHeight);
    });

    this.renderer.domElement.addEventListener("pointerdown", (event) => {
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hits = this.raycaster.intersectObjects(this.satHitTargets, false);
      if (hits.length > 0) {
        const scId = hits[0].object.userData.spacecraftId;
        if (scId && this.onSelectSpacecraft) {
          this.onSelectSpacecraft(scId);
        }
      }
    });
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    this.moonMesh.rotation.y += 0.00025;
    this.cpaGroup.children.forEach((b) => {
      b.rotation.y += 0.03;
    });
    this.controls.update();
    this.composer.render();
  }
}

export function initLidarHeroBanner(canvas) {
  if (!canvas) return;
  if (!SHARED_SAT_MAPS) {
    SHARED_SAT_MAPS = createSpacecraftMaterialMaps();
  }

  const parent = canvas.parentElement;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, parent.clientWidth / parent.clientHeight, 0.1, 50);
  camera.position.set(0, 1.38, 3.85);
  camera.lookAt(0, -0.18, 0);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(parent.clientWidth, parent.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  scene.add(new THREE.AmbientLight(0x94a3b8, 0.42));
  const sun = new THREE.DirectionalLight(0xf8fafc, 2.85);
  sun.position.set(5.5, 4.2, 4.5);
  scene.add(sun);

  const rimLight = new THREE.DirectionalLight(0x93c5fd, 0.65);
  rimLight.position.set(-4.0, 2.5, 2.5);
  scene.add(rimLight);

  const fallback = createCleanFallbackLunarTextures();
  const horizonMat = new THREE.MeshStandardMaterial({
    map: fallback.map,
    bumpMap: fallback.bumpMap,
    bumpScale: 0.024,
    roughness: 0.95,
  });

  new THREE.TextureLoader().load("/assets/textures/moon_map.jpg", (t) => {
    if (t.image) {
      const processed = processLunarTextureFromImage(t.image);
      horizonMat.map = processed.map;
      horizonMat.normalMap = processed.normalMap;
      horizonMat.normalScale = new THREE.Vector2(0.75, 0.75);
      horizonMat.bumpMap = processed.bumpMap;
      horizonMat.bumpScale = 0.024;
    } else {
      t.colorSpace = THREE.SRGBColorSpace;
      horizonMat.map = t;
      horizonMat.bumpMap = t;
    }
    horizonMat.needsUpdate = true;
  });

  // Upright equatorial horizon (rotation.x = 0) so the pinched North Pole UV seam NEVER shows
  const moonHorizon = new THREE.Mesh(new THREE.SphereGeometry(3.45, 224, 224), horizonMat);
  moonHorizon.position.set(0.25, -3.62, -0.4);
  moonHorizon.rotation.set(0.0, -0.85, 0.08);
  scene.add(moonHorizon);

  const satGroup = new THREE.Group();
  const titaniumMat = new THREE.MeshStandardMaterial({
    color: 0xcbd5e1,
    metalness: 0.88,
    roughness: 0.24,
  });

  const bus = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.19, 0.4, 24),
    new THREE.MeshStandardMaterial({
      color: 0xd97706,
      normalMap: SHARED_SAT_MAPS.foilNormal,
      normalScale: new THREE.Vector2(1.2, 1.2),
      metalness: 0.92,
      roughness: 0.25,
    })
  );
  bus.rotation.z = -0.55;
  satGroup.add(bus);

  [-0.19, 0.19].forEach((offset) => {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.185, 0.185, 0.028, 24), titaniumMat);
    ring.position.set(-Math.sin(-0.55) * offset, Math.cos(-0.55) * offset, 0);
    ring.rotation.z = -0.55;
    satGroup.add(ring);
  });

  const dish = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.44),
    titaniumMat
  );
  dish.position.set(-0.14, 0.22, 0.02);
  dish.rotation.z = 2.6;
  satGroup.add(dish);

  const lidarTurret = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.088, 0.13, 20),
    titaniumMat
  );
  lidarTurret.position.set(0.13, -0.13, 0.04);
  lidarTurret.rotation.z = -0.55;
  satGroup.add(lidarTurret);

  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 0.02, 20),
    new THREE.MeshStandardMaterial({
      color: 0x0f172a,
      emissive: 0x881337,
      emissiveIntensity: 0.5,
      metalness: 0.95,
      roughness: 0.08,
    })
  );
  lens.position.set(0.16, -0.16, 0.05);
  lens.rotation.z = -0.55;
  satGroup.add(lens);

  const solarMat = new THREE.MeshStandardMaterial({
    map: SHARED_SAT_MAPS.solarMap,
    normalMap: SHARED_SAT_MAPS.solarNormal,
    normalScale: new THREE.Vector2(0.65, 0.65),
    metalness: 0.78,
    roughness: 0.2,
  });

  const wingL = buildRealisticSolarWing(0.98, 0.27, -1, solarMat, titaniumMat);
  wingL.position.set(-0.15, 0.08, 0);
  wingL.rotation.set(0.38, 0.15, -0.45);

  const wingR = buildRealisticSolarWing(0.98, 0.27, 1, solarMat, titaniumMat);
  wingR.position.set(0.15, -0.08, 0);
  wingR.rotation.set(0.38, -0.15, -0.45);

  satGroup.add(wingL, wingR);

  // Positioned cleanly in frame so neither wing clips the top border
  satGroup.position.set(-0.32, 0.5, 0.6);
  scene.add(satGroup);

  const beamGeo = new THREE.CylinderGeometry(0.005, 0.036, 2.45, 16);
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xf43f5e, transparent: true, opacity: 0.72 });
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.position.set(0.82, 0.04, 0.22);
  beam.rotation.z = 1.15;
  scene.add(beam);

  function animate() {
    requestAnimationFrame(animate);
    const t = Date.now() * 0.0018;
    moonHorizon.rotation.y += 0.00045;
    satGroup.position.y = 0.5 + Math.sin(t) * 0.022;
    beamMat.opacity = 0.58 + Math.sin(t * 4.5) * 0.18;
    renderer.render(scene, camera);
  }
  animate();
}