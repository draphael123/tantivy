// TANTIVY — isometric horse racer. A point-to-point steeplechase to sanctuary:
// gait ladder + stamina economy + commitment cornering, terraced hills,
// jumps, gates, mud, wildlife, and 3 AI rivals.

import * as THREE from './vendor/three.module.js';

// ---------------------------------------------------------------- rng (fixed world)
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const worldRng = mulberry32(7);

// ---------------------------------------------------------------- route
const CTRL = [
  [60, 60], [150, 120], [240, 150], [330, 200], [400, 270], [455, 345],
  [505, 395], [545, 455], [600, 505], [660, 555], [720, 615], [780, 665],
];
// Catmull-Rom through control points, sampled every ~3m.
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
const R = { pts: [], tan: [], nrm: [], step: 3, len: 0 };
(function buildRoute() {
  const raw = [];
  for (let i = 0; i < CTRL.length - 1; i++) {
    const p0 = CTRL[Math.max(0, i - 1)], p1 = CTRL[i],
      p2 = CTRL[i + 1], p3 = CTRL[Math.min(CTRL.length - 1, i + 2)];
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const n = Math.max(2, Math.round(segLen / 1.5));
    for (let j = 0; j < n; j++) {
      const t = j / n;
      raw.push([catmull(p0[0], p1[0], p2[0], p3[0], t), catmull(p0[1], p1[1], p2[1], p3[1], t)]);
    }
  }
  raw.push(CTRL[CTRL.length - 1].slice());
  // resample at even spacing
  let acc = 0, prev = raw[0];
  R.pts.push(prev.slice());
  for (let i = 1; i < raw.length; i++) {
    const d = Math.hypot(raw[i][0] - prev[0], raw[i][1] - prev[1]);
    acc += d; prev = raw[i];
    if (acc >= R.step) { R.pts.push(raw[i].slice()); acc = 0; }
  }
  R.len = (R.pts.length - 1) * R.step;
  for (let i = 0; i < R.pts.length; i++) {
    const a = R.pts[Math.max(0, i - 1)], b = R.pts[Math.min(R.pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], m = Math.hypot(dx, dz) || 1;
    R.tan.push([dx / m, dz / m]);
    R.nrm.push([-dz / m, dx / m]);
  }
})();
function routeAt(s) {
  const f = Math.min(Math.max(s / R.step, 0), R.pts.length - 1.001);
  const i = Math.floor(f), t = f - i;
  const p = R.pts[i], q = R.pts[i + 1] || p;
  return {
    x: p[0] + (q[0] - p[0]) * t, z: p[1] + (q[1] - p[1]) * t,
    tx: R.tan[i][0], tz: R.tan[i][1], nx: R.nrm[i][0], nz: R.nrm[i][1],
  };
}

// ---------------------------------------------------------------- brooks
const BROOKS = [560, 845].map((s) => {
  const r = routeAt(s);
  return { s, x: r.x, z: r.z, nx: r.nx, nz: r.nz, tx: r.tx, tz: r.tz, half: 42, width: 3.4 };
});
function brookCarve(x, z) {
  let c = 0;
  for (const b of BROOKS) {
    // distance along brook axis (its normal = route tangent direction)
    const dx = x - b.x, dz = z - b.z;
    const along = dx * b.nx + dz * b.nz;     // along the brook's length
    const across = dx * b.tx + dz * b.tz;    // across it (route direction)
    if (Math.abs(along) < b.half + 10) {
      const d = Math.abs(across);
      if (d < 7) c = Math.max(c, 2.0 * (1 - d / 7));
    }
  }
  return c;
}

// ---------------------------------------------------------------- hazards
const LOGS = [
  { s: 195, latMin: -9.5, latMax: 3.0 },
  { s: 340, latMin: -9.5, latMax: 2.5 },
  { s: 700, latMin: -2.5, latMax: 9.5 },
];
const WALLS = [
  { s: 520, latMin: -7, latMax: 7 },
];
const MUD = [
  { s: 95, lat: -3, r: 4.5 },
  { s: 262, lat: 4, r: 5 },
  { s: 487, lat: -3.5, r: 5.5 },
  { s: 642, lat: 3, r: 5 },
].map((m) => { const p = routeAt(m.s); return { ...m, x: p.x + p.nx * m.lat, z: p.z + p.nz * m.lat }; });
const GATES = [
  { s: 415, gapLat: -3.5, gapHalf: 3.0 },
  { s: 748, gapLat: 3.0, gapHalf: 3.0 },
];
// hay bales: round obstacles ON the road — steer around them (or bounce off)
const BALES = [
  { s: 130, lat: -4 }, { s: 370, lat: 5 }, { s: 450, lat: -6 },
  { s: 597, lat: 2 }, { s: 660, lat: -5 }, { s: 770, lat: 6 },
].map((b) => { const p = routeAt(b.s); return { ...b, r: 1.25, x: p.x + p.nx * b.lat, z: p.z + p.nz * b.lat }; });
// everything jumpable, sorted by route distance
const JUMPS = [
  ...BROOKS.filter((b) => b.s < R.len - 30)
    .map((b) => ({ s: b.s, width: b.width, latMin: -b.half, latMax: b.half, kind: 'brook', x: b.x, z: b.z, tx: b.tx, tz: b.tz, nx: b.nx, nz: b.nz })),
  ...LOGS.map((l) => { const p = routeAt(l.s); return { s: l.s, width: 1.5, latMin: l.latMin, latMax: l.latMax, kind: 'log', x: p.x, z: p.z, tx: p.tx, tz: p.tz, nx: p.nx, nz: p.nz }; }),
  ...WALLS.map((l) => { const p = routeAt(l.s); return { s: l.s, width: 1.3, latMin: l.latMin, latMax: l.latMax, kind: 'wall', x: p.x, z: p.z, tx: p.tx, tz: p.tz, nx: p.nx, nz: p.nz }; }),
].sort((a, b) => a.s - b.s);
function nextJump(s, lateral) {
  for (const j of JUMPS) {
    if (j.s + 3 <= s) continue;
    if (lateral !== undefined && (lateral < j.latMin - 1 || lateral > j.latMax + 1)) continue;
    return j;
  }
  return null;
}
function inMudAt(x, z) {
  for (const m of MUD) { const dx = x - m.x, dz = z - m.z; if (dx * dx + dz * dz < m.r * m.r) return true; }
  return false;
}
// side fences pen the corridor; broken at the start, the finish, and brook crossings
function fenceActive(s) {
  if (s < 14 || s > R.len - 18) return false;
  for (const b of BROOKS) if (Math.abs(s - b.s) < 12) return false;
  return true;
}
function collideField(field) {
  for (let i = 0; i < field.length; i++) for (let j = i + 1; j < field.length; j++) {
    const a = field[i], b = field[j];
    if (!a.alive || a.finished || !b.alive || b.finished) continue;
    if (a.air > 0 || b.air > 0) continue;
    const dx = b.x - a.x, dz = b.z - a.z, d2 = dx * dx + dz * dz, min = 1.7;
    if (d2 < min * min && d2 > 1e-6) {
      const d = Math.sqrt(d2), push = (min - d) / 2, ux = dx / d, uz = dz / d;
      a.x -= ux * push; a.z -= uz * push;
      b.x += ux * push; b.z += uz * push;
      a.speed *= 0.985; b.speed *= 0.985;
    }
  }
}

// ---------------------------------------------------------------- heightfield
const TERRACE = 1.6;
function rawHeight(x, z) {
  const hill = (cx, cz, r, h) => {
    const d = Math.hypot(x - cx, z - cz);
    if (d > r) return 0;
    const t = 1 - d / r;
    return h * t * t * (3 - 2 * t);
  };
  let v = 2.2;
  v += hill(390, 255, 165, 13);
  v += hill(630, 530, 115, 7);
  v += hill(160, 260, 120, 5);      // scenery hill off-route
  v += hill(620, 320, 110, 6);      // scenery
  v += 1.0 * Math.sin(x * 0.021) * Math.cos(z * 0.017);
  v += 0.6 * Math.sin(x * 0.043 + 1.7) * Math.sin(z * 0.031 + 0.6);
  v -= brookCarve(x, z);
  return v;
}
function smoothstep(a, b, t) { t = Math.min(Math.max((t - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); }
// terraced height the sim rides on: flat steps with short smooth ramps at edges
function groundHeight(x, z) {
  const v = rawHeight(x, z) / TERRACE;
  const fl = Math.floor(v), fr = v - fl;
  return TERRACE * (fl + smoothstep(0.62, 1.0, fr));
}
function terraceLevel(x, z) { return Math.floor(rawHeight(x, z) / TERRACE); }

// ---------------------------------------------------------------- three setup
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color(0xf6dcae);
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 180, 420);

let VIEW_H = 24;
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 900);
function sizeCamera() {
  const a = innerWidth / innerHeight;
  camera.left = -VIEW_H * a; camera.right = VIEW_H * a;
  camera.top = VIEW_H; camera.bottom = -VIEW_H;
  camera.updateProjectionMatrix();
}
sizeCamera();
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); sizeCamera(); });
// rotatable iso: 4 yaw stops, 90° apart, smoothly interpolated; V cycles elevation presets
const CAM_R = Math.hypot(52, 52);
let CAM_H = 46;
let camYawIdx = 0, camYawCur = Math.PI / 4;
const VIEWS = [
  { name: 'CLASSIC', h: 46, view: 24 },
  { name: 'LOW', h: 30, view: 20 },
  { name: 'HIGH', h: 72, view: 30 },
];
let viewIdx = 0, viewBase = 24;
function cycleView() {
  viewIdx = (viewIdx + 1) % VIEWS.length;
  CAM_H = VIEWS[viewIdx].h;
  viewBase = VIEWS[viewIdx].view;
  if (state !== 'home') flash('View: ' + VIEWS[viewIdx].name, 1.2);
}
function rotateCam(dir) { camYawIdx += dir; }
function camOffset() {
  return new THREE.Vector3(Math.cos(camYawCur) * CAM_R, CAM_H, Math.sin(camYawCur) * CAM_R);
}

const sun = new THREE.DirectionalLight(0xffd9a4, 2.3);
sun.position.set(-110, 85, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 10; sun.shadow.camera.far = 420;
const SB = 95;
sun.shadow.camera.left = -SB; sun.shadow.camera.right = SB;
sun.shadow.camera.top = SB; sun.shadow.camera.bottom = -SB;
sun.shadow.bias = -0.0015;
scene.add(sun); scene.add(sun.target);
scene.add(new THREE.HemisphereLight(0xffeccb, 0x8a6f45, 0.8));
renderer.toneMappingExposure = 1.12;

// ---------------------------------------------------------------- terrain mesh
let terrainMesh = null;
function distToRoute(x, z) {
  // coarse: nearest sample (route samples every 3m) — fine for coloring
  let best = 1e9;
  for (let i = 0; i < R.pts.length; i += 2) {
    const d = Math.hypot(x - R.pts[i][0], z - R.pts[i][1]);
    if (d < best) best = d;
  }
  return best;
}
(function buildTerrain() {
  const X0 = -20, Z0 = -20, X1 = 860, Z1 = 760, CELL = 4;
  const nx = Math.round((X1 - X0) / CELL), nz = Math.round((Z1 - Z0) / CELL);
  const geo = new THREE.PlaneGeometry(X1 - X0, Z1 - Z0, nx, nz);
  geo.rotateX(-Math.PI / 2);
  geo.translate((X0 + X1) / 2, 0, (Z0 + Z1) / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, groundHeight(pos.getX(i), pos.getZ(i)));
  }
  const ng = geo.toNonIndexed();
  const p = ng.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const cLow = new THREE.Color(0x8fae52), cHigh = new THREE.Color(0xd9c684);
  const cDirt = new THREE.Color(0xc49a63), cWater = new THREE.Color(0x6fa3c8);
  const cRough = new THREE.Color(0x74904a);
  const col = new THREE.Color();
  for (let f = 0; f < p.count; f += 3) {
    const cx = (p.getX(f) + p.getX(f + 1) + p.getX(f + 2)) / 3;
    const cz = (p.getZ(f) + p.getZ(f + 1) + p.getZ(f + 2)) / 3;
    const lvl = terraceLevel(cx, cz);
    const dr = distToRoute(cx, cz);
    if (brookCarve(cx, cz) > 1.1) {
      col.copy(cWater);
    } else if (dr < 5.5) {
      col.copy(cDirt);
    } else if (dr < 8.5) {
      col.copy(cDirt).lerp(cLow, 0.6);
    } else {
      const t = Math.min(Math.max((lvl - 1) / 8, 0), 1);
      col.copy(dr > 80 ? cRough : cLow).lerp(cHigh, t);
      // meadow patchwork: broad soft drifts of deeper and yellower grass
      const patch = Math.sin(cx * 0.013 + 3.1) * Math.sin(cz * 0.011 + 1.2);
      if (patch > 0.45) col.lerp(new THREE.Color(0x7c9a48), (patch - 0.45) * 0.6);
      else if (patch < -0.45) col.lerp(new THREE.Color(0xb1b45e), (-patch - 0.45) * 0.5);
    }
    // painterly per-face jitter + alternating terrace bands (the topo-map read)
    const j = (Math.sin(cx * 12.9898 + cz * 78.233) * 43758.5453) % 1;
    let k = 1 + (j - 0.5) * 0.07;
    if (((lvl % 2) + 2) % 2 === 1) k *= 0.93;
    for (let v = 0; v < 3; v++) {
      colors[(f + v) * 3] = col.r * k;
      colors[(f + v) * 3 + 1] = col.g * k;
      colors[(f + v) * 3 + 2] = col.b * k;
    }
  }
  ng.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  ng.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const mesh = new THREE.Mesh(ng, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);
  terrainMesh = mesh;
})();

// ---------------------------------------------------------------- props
const trees = [];   // {x,z,r, group, mats[]}
(function plantTrees() {
  const canopyCols = [0xc96f2f, 0xd98f35, 0xb8552e, 0x889a3f, 0xd9a13b];
  let placed = 0, guard = 0;
  while (placed < 150 && guard++ < 4000) {
    const s = worldRng() * R.len;
    const r = routeAt(s);
    const side = worldRng() < 0.5 ? -1 : 1;
    const off = 14 + worldRng() * 70;
    const x = r.x + r.nx * off * side + (worldRng() - 0.5) * 20;
    const z = r.z + r.nz * off * side + (worldRng() - 0.5) * 20;
    if (x < 0 || z < 0 || x > 840 || z > 740) continue;
    if (distToRoute(x, z) < 13) continue;
    if (brookCarve(x, z) > 0.2) continue;
    if (R.len - s < 40) continue;
    const g = new THREE.Group();
    const sc = 0.8 + worldRng() * 0.9;
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x7a5230 });
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35 * sc, 0.5 * sc, 2.6 * sc, 6), trunkMat);
    trunk.position.y = 1.3 * sc; trunk.castShadow = true;
    g.add(trunk);
    const mats = [trunkMat];
    const cc = canopyCols[Math.floor(worldRng() * canopyCols.length)];
    const nBlobs = 2 + Math.floor(worldRng() * 2);
    for (let b = 0; b < nBlobs; b++) {
      const cm = new THREE.MeshLambertMaterial({ color: cc });
      const rad = (1.6 - b * 0.35) * sc;
      const blob = new THREE.Mesh(new THREE.SphereGeometry(rad, 8, 6), cm);
      blob.position.set((worldRng() - 0.5) * 0.8 * sc, (2.4 + b * 1.1) * sc, (worldRng() - 0.5) * 0.8 * sc);
      blob.castShadow = true;
      g.add(blob); mats.push(cm);
    }
    const y = groundHeight(x, z);
    g.position.set(x, y, z);
    scene.add(g);
    trees.push({ x, z, r: 1.1 * sc, group: g, mats, fade: 1 });
    placed++;
  }
})();

// brooks: water strip + landing ring on the far side
for (const b of BROOKS) {
  const geo = new THREE.PlaneGeometry(b.width + 3, b.half * 2);
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x5f96c2 }));
  const y = groundHeight(b.x, b.z);
  m.position.set(b.x, y + 0.12, b.z);
  m.rotation.y = Math.atan2(b.nx, b.nz);
  scene.add(m);
  // pale landing ring past the far bank — the "you land here" read
  const lr = routeAt(b.s + 9);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.2, 3.4, 24),
    new THREE.MeshBasicMaterial({ color: 0xfff3d6, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(lr.x, groundHeight(lr.x, lr.z) + 0.15, lr.z);
  scene.add(ring);
  // takeoff hint bar on the near bank
  const tk = routeAt(b.s - 6);
  const bar = new THREE.Mesh(
    new THREE.PlaneGeometry(9, 1.1),
    new THREE.MeshBasicMaterial({ color: 0xfff3d6, transparent: true, opacity: 0.6, side: THREE.DoubleSide })
  );
  bar.rotation.x = -Math.PI / 2;
  bar.rotation.z = -Math.atan2(b.tz, b.tx) + Math.PI / 2;
  bar.position.set(tk.x, groundHeight(tk.x, tk.z) + 0.15, tk.z);
  scene.add(bar);
}

// sanctuary at the finish
(function buildSanctuary() {
  const end = routeAt(R.len - 4);
  const g = new THREE.Group();
  const stone = new THREE.MeshLambertMaterial({ color: 0xe8dcc0 });
  const roofM = new THREE.MeshLambertMaterial({ color: 0xb5502a });
  const nave = new THREE.Mesh(new THREE.BoxGeometry(10, 6, 7), stone);
  nave.position.y = 3; nave.castShadow = true; g.add(nave);
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 5.4, 4, 4, 1), roofM);
  roof.position.y = 8; roof.rotation.y = Math.PI / 4; roof.scale.z = 0.72; g.add(roof);
  const tower = new THREE.Mesh(new THREE.BoxGeometry(3.4, 12, 3.4), stone);
  tower.position.set(-6, 6, 0); tower.castShadow = true; g.add(tower);
  const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 2.6, 3.6, 4), roofM);
  spire.position.set(-6, 13.8, 0); spire.rotation.y = Math.PI / 4; g.add(spire);
  const bell = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6),
    new THREE.MeshLambertMaterial({ color: 0xd9a13b, emissive: 0x734d10 }));
  bell.position.set(-6, 11.2, 0); g.add(bell);
  const glow = new THREE.PointLight(0xffd98a, 60, 60);
  glow.position.set(0, 6, 0); g.add(glow);
  const fin = routeAt(R.len - 2);
  g.position.set(end.x + end.tx * 16 + end.nx * 9, groundHeight(end.x, end.z), end.z + end.tz * 16 + end.nz * 9);
  g.rotation.y = Math.atan2(end.tx, end.tz) + Math.PI;
  scene.add(g);
  // finish posts
  for (const side of [-1, 1]) {
    const px = fin.x + fin.nx * 7 * side, pz = fin.z + fin.nz * 7 * side;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 4.5, 6),
      new THREE.MeshLambertMaterial({ color: 0x7a5230 }));
    post.position.set(px, groundHeight(px, pz) + 2.2, pz);
    post.castShadow = true;
    scene.add(post);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.3),
      new THREE.MeshBasicMaterial({ color: 0xd9a13b, side: THREE.DoubleSide }));
    flag.position.set(px, groundHeight(px, pz) + 4.1, pz);
    flag.rotation.y = Math.atan2(fin.tx, fin.tz);
    scene.add(flag);
  }
})();

// start banner
(function startBanner() {
  const st = routeAt(2);
  for (const side of [-1, 1]) {
    const px = st.x + st.nx * 7 * side, pz = st.z + st.nz * 7 * side;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 5, 6),
      new THREE.MeshLambertMaterial({ color: 0x7a5230 }));
    post.position.set(px, groundHeight(px, pz) + 2.5, pz);
    scene.add(post);
  }
})();

// ---------------------------------------------------------------- race dressing & beauty pass
const UP = new THREE.Vector3(0, 1, 0);

// dawn sky dome (fog-free, follows the camera target)
const skyDome = (function buildSky() {
  const geo = new THREE.SphereGeometry(650, 20, 12);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(0x9db8d6), horizon = new THREE.Color(0xffe3b0), glow = new THREE.Color(0xf6c98a);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(Math.max((pos.getY(i) / 650 + 0.08) / 0.85, 0), 1);
    c.copy(horizon).lerp(top, t * t);
    if (t < 0.22) c.lerp(glow, (0.22 - t) / 0.22 * 0.5);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
  }));
  mesh.renderOrder = -1;
  scene.add(mesh);
  return mesh;
})();
scene.fog = new THREE.Fog(SKY, 160, 520);

// distant ridge silhouettes, hazed by the fog
for (const [rx, rz, rr, rh] of [[1020, 320, 260, 70], [900, 880, 220, 55], [280, 1030, 260, 65], [-190, 520, 230, 60], [430, -220, 250, 58]]) {
  const ridge = new THREE.Mesh(new THREE.ConeGeometry(rr, rh, 7),
    new THREE.MeshLambertMaterial({ color: 0xb3a37a }));
  ridge.scale.z = 0.55;
  ridge.position.set(rx, rh / 2 - 8, rz);
  ridge.rotation.y = (rx + rz) % 3;
  scene.add(ridge);
}

// post-and-rail fences lining the corridor
(function buildFences() {
  const woodMat = new THREE.MeshLambertMaterial({ color: 0x8a6a42 });
  const spots = [];
  for (let s = 15; s < R.len - 18; s += 3) {
    if (!fenceActive(s)) continue;
    for (const side of [-1, 1]) spots.push({ s, side });
  }
  const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 1.7, 0.2), woodMat, spots.length);
  posts.castShadow = true;
  const rails = new THREE.InstancedMesh(new THREE.BoxGeometry(3.05, 0.09, 0.14), woodMat, spots.length * 3);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
  let pi = 0, ri = 0;
  for (const { s, side } of spots) {
    const rp = routeAt(s);
    const x = rp.x + rp.nx * 10 * side, z = rp.z + rp.nz * 10 * side;
    q.setFromAxisAngle(UP, -Math.atan2(rp.tz, rp.tx));
    m4.compose(v.set(x, groundHeight(x, z) + 0.85, z), q, one);
    posts.setMatrixAt(pi++, m4);
    const rm = routeAt(s + 1.5);
    const xm = rm.x + rm.nx * 10 * side, zm = rm.z + rm.nz * 10 * side;
    const ym = groundHeight(xm, zm);
    q.setFromAxisAngle(UP, -Math.atan2(rm.tz, rm.tx));
    for (const h of [0.55, 1.05, 1.5]) {
      m4.compose(v.set(xm, ym + h, zm), q, one);
      rails.setMatrixAt(ri++, m4);
    }
  }
  posts.count = pi; rails.count = ri;
  scene.add(posts, rails);
})();

// cross-fence gates with flagged gaps
for (const g of GATES) {
  const rp = routeAt(g.s);
  const woodMat = new THREE.MeshLambertMaterial({ color: 0x7a5230 });
  for (const [a, b] of [[-9.6, g.gapLat - g.gapHalf], [g.gapLat + g.gapHalf, 9.6]]) {
    if (b - a < 0.4) continue;
    const mid = (a + b) / 2, len = b - a;
    const x = rp.x + rp.nx * mid, z = rp.z + rp.nz * mid;
    const grp = new THREE.Group();
    for (const h of [0.5, 1.0, 1.5]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.1, 0.14), woodMat);
      rail.position.y = h; rail.castShadow = true; grp.add(rail);
    }
    for (const e of [a, b]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.24, 2.0, 0.24), woodMat);
      post.position.set(e - mid, 1.0, 0);
      post.castShadow = true;
      grp.add(post);
      // gold flags mark the gap posts
      if (Math.abs(Math.abs(e - g.gapLat) - g.gapHalf) < 0.2) {
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5),
          new THREE.MeshBasicMaterial({ color: 0xd9a13b, side: THREE.DoubleSide }));
        flag.position.set(e - mid, 2.3, 0);
        grp.add(flag);
      }
    }
    grp.position.set(x, groundHeight(x, z), z);
    grp.rotation.y = -Math.atan2(rp.nz, rp.nx);
    scene.add(grp);
  }
}

// fallen logs (jumpable) + takeoff bars
for (const l of LOGS) {
  const p = routeAt(l.s);
  const len = l.latMax - l.latMin, mid = (l.latMin + l.latMax) / 2;
  const x = p.x + p.nx * mid, z = p.z + p.nz * mid;
  const grp = new THREE.Group();
  const log = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.4, len, 9),
    new THREE.MeshLambertMaterial({ color: 0x6e4c2a }));
  log.rotation.z = Math.PI / 2;
  log.position.y = 0.36;
  log.castShadow = true;
  grp.add(log);
  for (let i = 0; i < 3; i++) {
    const stub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.7, 5),
      new THREE.MeshLambertMaterial({ color: 0x5c3f22 }));
    stub.position.set((i - 1) * len * 0.3, 0.65, (i % 2 ? 0.2 : -0.2));
    stub.rotation.x = (i % 2 ? -0.7 : 0.7);
    grp.add(stub);
  }
  grp.position.set(x, groundHeight(x, z), z);
  grp.rotation.y = -Math.atan2(p.nz, p.nx);
  scene.add(grp);
  const tk = routeAt(l.s - 5);
  const bar = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.1),
    new THREE.MeshBasicMaterial({ color: 0xfff3d6, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
  bar.rotation.x = -Math.PI / 2;
  bar.rotation.z = -Math.atan2(tk.tz, tk.tx) + Math.PI / 2;
  bar.position.set(tk.x, groundHeight(tk.x, tk.z) + 0.15, tk.z);
  scene.add(bar);
}

// stone walls (jumpable) + takeoff bars
for (const w of WALLS) {
  const p = routeAt(w.s);
  const len = w.latMax - w.latMin, mid = (w.latMin + w.latMax) / 2;
  const x = p.x + p.nx * mid, z = p.z + p.nz * mid;
  const grp = new THREE.Group();
  const stoneMat = new THREE.MeshLambertMaterial({ color: 0xb8ad94 });
  const wall = new THREE.Mesh(new THREE.BoxGeometry(len, 0.95, 0.55), stoneMat);
  wall.position.y = 0.48; wall.castShadow = true; grp.add(wall);
  for (let i = 0; i < Math.floor(len / 1.1); i++) {
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.28, 0.62),
      new THREE.MeshLambertMaterial({ color: 0xa79c82 }));
    cap.position.set(w.latMin - mid + 0.6 + i * 1.1, 1.05, 0);
    cap.rotation.y = (i % 3 - 1) * 0.1;
    cap.castShadow = true;
    grp.add(cap);
  }
  grp.position.set(x, groundHeight(x, z), z);
  grp.rotation.y = -Math.atan2(p.nz, p.nx);
  scene.add(grp);
  const tk = routeAt(w.s - 5);
  const bar = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.1),
    new THREE.MeshBasicMaterial({ color: 0xfff3d6, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
  bar.rotation.x = -Math.PI / 2;
  bar.rotation.z = -Math.atan2(tk.tz, tk.tx) + Math.PI / 2;
  bar.position.set(tk.x, groundHeight(tk.x, tk.z) + 0.15, tk.z);
  scene.add(bar);
}

// hay bales
for (const b of BALES) {
  const bale = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.0, 1.4, 12),
    new THREE.MeshLambertMaterial({ color: 0xd9b45c }));
  bale.rotation.z = Math.PI / 2;
  bale.rotation.y = (b.s % 7) * 0.4;
  bale.position.set(b.x, groundHeight(b.x, b.z) + 1.0, b.z);
  bale.castShadow = true;
  scene.add(bale);
  const band = new THREE.Mesh(new THREE.TorusGeometry(1.02, 0.05, 6, 16),
    new THREE.MeshLambertMaterial({ color: 0xa8813a }));
  band.rotation.y = Math.PI / 2 + bale.rotation.y;
  band.position.copy(bale.position);
  scene.add(band);
}

// mud bogs
for (const m of MUD) {
  const outer = new THREE.Mesh(new THREE.CircleGeometry(m.r, 20),
    new THREE.MeshLambertMaterial({ color: 0x5f4326 }));
  outer.rotation.x = -Math.PI / 2;
  outer.position.set(m.x, groundHeight(m.x, m.z) + 0.13, m.z);
  scene.add(outer);
  const inner = new THREE.Mesh(new THREE.CircleGeometry(m.r * 0.55, 16),
    new THREE.MeshLambertMaterial({ color: 0x4a3319 }));
  inner.rotation.x = -Math.PI / 2;
  inner.position.set(m.x + 0.4, groundHeight(m.x, m.z) + 0.14, m.z - 0.3);
  scene.add(inner);
}

// brook foam edges
for (const b of BROOKS) {
  const y = groundHeight(b.x, b.z);
  for (const edge of [-1, 1]) {
    const fg = new THREE.PlaneGeometry(0.5, b.half * 2);
    fg.rotateX(-Math.PI / 2);
    const foam = new THREE.Mesh(fg,
      new THREE.MeshBasicMaterial({ color: 0xf6efdd, transparent: true, opacity: 0.55 }));
    foam.rotation.y = Math.atan2(b.nx, b.nz);
    foam.position.set(b.x + b.tx * edge * (b.width / 2 + 1.4), y + 0.14, b.z + b.tz * edge * (b.width / 2 + 1.4));
    scene.add(foam);
  }
}

// pennant strings + crowds at the start and the finish
function pennantString(x1, y1, z1, x2, y2, z2) {
  const cols = [0xd9a13b, 0xb5502a, 0x7d9a45, 0xe8e2d4];
  const n = 11;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const sag = Math.sin(t * Math.PI) * 0.7;
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.45, 0.6),
      new THREE.MeshBasicMaterial({ color: cols[i % cols.length], side: THREE.DoubleSide }));
    flag.position.set(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t - sag - 0.3, z1 + (z2 - z1) * t);
    flag.rotation.y = Math.atan2(x2 - x1, z2 - z1);
    scene.add(flag);
  }
}
const crowdFigures = [];
function placeCrowd(s, count) {
  const rp = routeAt(s);
  const cols = [0x8a5a7a, 0x4e6b8a, 0x6b7d3a, 0xb5502a, 0x9a6b3f, 0xd9a13b];
  const skins = [0xe8c49a, 0xd9a878, 0xb98455, 0x8a5f3a];
  const hairCols = [0x46311f, 0x7a5230, 0xd9c684, 0x9a9a9a, 0x2e2118];
  for (let i = 0; i < count; i++) {
    const side = worldRng() < 0.5 ? -1 : 1;
    const lat = (11.5 + worldRng() * 2.5) * side;
    const along = (worldRng() - 0.5) * 22;
    const p = routeAt(Math.max(2, s + along));
    const x = p.x + p.nx * lat, z = p.z + p.nz * lat;
    const grp = new THREE.Group();
    const tunicMat = new THREE.MeshLambertMaterial({ color: cols[Math.floor(worldRng() * cols.length)] });
    const skinMat = new THREE.MeshLambertMaterial({ color: skins[Math.floor(worldRng() * skins.length)] });
    // legs
    const legGeo = new THREE.CylinderGeometry(0.09, 0.08, 0.55, 6);
    const legMat = new THREE.MeshLambertMaterial({ color: 0x5c4632 });
    for (const lx of [-0.12, 0.12]) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(0, 0.28, lx);
      grp.add(leg);
    }
    // tunic
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 0.75, 8), tunicMat);
    body.position.y = 0.9; body.castShadow = true; grp.add(body);
    // arms — some raised, cheering
    const cheering = worldRng() < 0.45;
    const armGeo = new THREE.CylinderGeometry(0.06, 0.055, 0.5, 5);
    for (const az of [-0.28, 0.28]) {
      const arm = new THREE.Mesh(armGeo, tunicMat);
      const up = cheering && (az > 0 || worldRng() < 0.5);
      if (up) { arm.position.set(0.05, 1.42, az); arm.rotation.x = az > 0 ? 0.5 : -0.5; }
      else { arm.position.set(0, 1.0, az); arm.rotation.x = az > 0 ? 0.35 : -0.35; }
      grp.add(arm);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 5, 4), skinMat);
      hand.position.set(up ? 0.08 : 0.02, up ? 1.72 : 0.76, az * (up ? 1.45 : 1.35));
      grp.add(hand);
    }
    // head + face
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), skinMat);
    head.position.y = 1.55; grp.add(head);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x2e2118 });
    for (const ez of [-0.09, 0.09]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.03, 4, 3), eyeMat);
      eye.position.set(0.21, 1.59, ez);
      grp.add(eye);
    }
    // hair or hat
    const hatRoll = worldRng();
    if (hatRoll < 0.35) {
      const hat = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.34, 7),
        new THREE.MeshLambertMaterial({ color: cols[Math.floor(worldRng() * cols.length)] }));
      hat.position.y = 1.85; grp.add(hat);
    } else if (hatRoll < 0.6) {
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.06, 9),
        new THREE.MeshLambertMaterial({ color: 0xc9a86a }));
      brim.position.y = 1.74; grp.add(brim);
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.16, 0.16, 8),
        new THREE.MeshLambertMaterial({ color: 0xc9a86a }));
      crown.position.y = 1.84; grp.add(crown);
    } else {
      const hair = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.55),
        new THREE.MeshLambertMaterial({ color: hairCols[Math.floor(worldRng() * hairCols.length)] }));
      hair.position.y = 1.6; hair.rotation.z = -0.25; grp.add(hair);
    }
    grp.position.set(x, groundHeight(x, z), z);
    // face the road
    grp.rotation.y = -Math.atan2(-p.nz * side, -p.nx * side);
    scene.add(grp);
    crowdFigures.push({ grp, ph: worldRng() * 6, cheering, baseY: grp.position.y });
  }
}
function updateCrowd() {
  const t = performance.now() / 1000;
  for (const c of crowdFigures) {
    if (c.cheering) c.grp.position.y = c.baseY + Math.abs(Math.sin(t * 4 + c.ph)) * 0.12;
  }
}
(function dressStartAndFinish() {
  const st = routeAt(2);
  pennantString(st.x + st.nx * 7, groundHeight(st.x + st.nx * 7, st.z + st.nz * 7) + 4.9, st.z + st.nz * 7,
    st.x - st.nx * 7, groundHeight(st.x - st.nx * 7, st.z - st.nz * 7) + 4.9, st.z - st.nz * 7);
  const fin = routeAt(R.len - 2);
  pennantString(fin.x + fin.nx * 7, groundHeight(fin.x + fin.nx * 7, fin.z + fin.nz * 7) + 4.3, fin.z + fin.nz * 7,
    fin.x - fin.nx * 7, groundHeight(fin.x - fin.nx * 7, fin.z - fin.nz * 7) + 4.3, fin.z - fin.nz * 7);
  placeCrowd(8, 10);
  placeCrowd(R.len - 10, 9);
})();

// mile markers every 200m
for (let ms = 200; ms < R.len - 40; ms += 200) {
  const p = routeAt(ms);
  const x = p.x + p.nx * -11.2, z = p.z + p.nz * -11.2;
  const stone = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.1, 0.5),
    new THREE.MeshLambertMaterial({ color: 0xcfc4a8 }));
  stone.position.set(x, groundHeight(x, z) + 0.55, z);
  stone.castShadow = true;
  scene.add(stone);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55),
    new THREE.MeshBasicMaterial({ color: 0xb5502a, side: THREE.DoubleSide }));
  flag.position.set(x, groundHeight(x, z) + 1.6, z);
  flag.rotation.y = Math.atan2(p.tx, p.tz);
  scene.add(flag);
}

// the TANTIVY banner cloth over the start line
(function startBannerCloth() {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 128;
  const c2 = cv.getContext('2d');
  c2.fillStyle = '#b5502a'; c2.fillRect(0, 0, 512, 128);
  c2.fillStyle = '#d9a13b'; c2.fillRect(0, 0, 512, 12); c2.fillRect(0, 116, 512, 12);
  c2.fillStyle = '#f7ecd4';
  c2.font = 'bold 74px Georgia';
  c2.textAlign = 'center'; c2.textBaseline = 'middle';
  c2.fillText('T A N T I V Y', 256, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;   // unflagged canvas textures render washed-out
  const st = routeAt(2);
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(12.8, 2.2),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  cloth.position.set(st.x, groundHeight(st.x, st.z) + 4.2, st.z);
  cloth.rotation.y = Math.atan2(st.nx, st.nz) + Math.PI / 2;
  scene.add(cloth);
})();

// painted start line + checkered finish band on the road
(function roadBands() {
  const st = routeAt(3);
  const startBand = new THREE.Mesh(new THREE.PlaneGeometry(13.5, 1.2),
    new THREE.MeshBasicMaterial({ color: 0xf6efdd, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
  startBand.rotation.x = -Math.PI / 2;
  startBand.rotation.z = -Math.atan2(st.tz, st.tx) + Math.PI / 2;
  startBand.position.set(st.x, groundHeight(st.x, st.z) + 0.16, st.z);
  scene.add(startBand);
  const fin = routeAt(R.len - 6);
  for (let i = 0; i < 8; i++) {
    for (let jj = 0; jj < 2; jj++) {
      const lat = -7 + i * 1.75 + 0.875;
      const sq = new THREE.Mesh(new THREE.PlaneGeometry(1.75, 0.7),
        new THREE.MeshBasicMaterial({ color: (i + jj) % 2 ? 0x46311f : 0xf6efdd, side: THREE.DoubleSide }));
      sq.rotation.x = -Math.PI / 2;
      sq.rotation.z = -Math.atan2(fin.tz, fin.tx) + Math.PI / 2;
      const fs = routeAt(R.len - 6 + jj * 0.7);
      sq.position.set(fs.x + fs.nx * lat, groundHeight(fs.x, fs.z) + 0.16, fs.z + fs.nz * lat);
      scene.add(sq);
    }
  }
})();

// drifting storybook clouds
const clouds = [];
for (let i = 0; i < 7; i++) {
  const grp = new THREE.Group();
  const cm = new THREE.MeshLambertMaterial({ color: 0xfdf6e8, transparent: true, opacity: 0.92 });
  const nBlobs = 3 + Math.floor(worldRng() * 3);
  for (let bIdx = 0; bIdx < nBlobs; bIdx++) {
    const r = 4 + worldRng() * 6;
    const blob = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), cm);
    blob.position.set((bIdx - nBlobs / 2) * r * 1.1, (worldRng() - 0.3) * 2, (worldRng() - 0.5) * 5);
    blob.scale.y = 0.55;
    grp.add(blob);
  }
  grp.position.set(worldRng() * 900 - 50, 55 + worldRng() * 18, worldRng() * 800 - 50);
  scene.add(grp);
  clouds.push({ grp, vx: 0.9 + worldRng() * 0.9 });
}
function updateClouds(dt) {
  for (const c of clouds) {
    c.grp.position.x += c.vx * dt;
    if (c.grp.position.x > 950) c.grp.position.x = -120;
  }
}

// water shimmer + blinking sparkles on the brooks
const waterMeshes = [];
scene.traverse((o) => {
  if (o.isMesh && o.material && o.material.color && o.material.color.getHex() === 0x5f96c2) waterMeshes.push(o);
});
const sparkles = [];
for (const b of BROOKS) {
  for (let i = 0; i < 7; i++) {
    const sp = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.24),
      new THREE.MeshBasicMaterial({ color: 0xfff8ea, transparent: true, opacity: 0, depthWrite: false }));
    sp.rotation.x = -Math.PI / 2;
    const along = (Math.random() - 0.5) * b.half * 1.5;
    const across = (Math.random() - 0.5) * b.width * 0.5;
    sp.position.set(b.x + b.nx * along + b.tx * across, groundHeight(b.x, b.z) + 0.18, b.z + b.nz * along + b.tz * across);
    scene.add(sp);
    sparkles.push({ mesh: sp, ph: Math.random() * 6, spd: 2 + Math.random() * 2 });
  }
}
function updateWater(t) {
  for (const wmesh of waterMeshes) {
    wmesh.material.color.setHSL(0.57, 0.35, 0.55 + Math.sin(t * 1.6 + wmesh.position.x) * 0.05);
  }
  for (const sp of sparkles) {
    sp.mesh.material.opacity = Math.max(0, Math.sin(t * sp.spd + sp.ph)) * 0.75;
  }
}

// finish cloth between the posts
(function finishCloth() {
  const fin = routeAt(R.len - 2);
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(13.4, 1.1),
    new THREE.MeshBasicMaterial({ color: 0xd9a13b, side: THREE.DoubleSide }));
  cloth.position.set(fin.x, groundHeight(fin.x, fin.z) + 3.9, fin.z);
  cloth.rotation.y = Math.atan2(fin.nx, fin.nz) + Math.PI / 2;
  scene.add(cloth);
  const text = new THREE.Mesh(new THREE.PlaneGeometry(13.4, 0.18),
    new THREE.MeshBasicMaterial({ color: 0xb5502a, side: THREE.DoubleSide }));
  text.position.copy(cloth.position); text.position.y -= 0.4;
  text.rotation.copy(cloth.rotation);
  scene.add(text);
})();

// hoof-dust puffs: a small pooled particle system
const dustPool = [];
for (let i = 0; i < 40; i++) {
  const p = new THREE.Mesh(new THREE.SphereGeometry(0.22, 5, 4),
    new THREE.MeshBasicMaterial({ color: 0xd9c9a8, transparent: true, opacity: 0 }));
  p.visible = false;
  scene.add(p);
  dustPool.push({ mesh: p, life: 0, vx: 0, vy: 0, vz: 0 });
}
let dustIdx = 0;
function spawnDust(x, y, z, kick) {
  const d = dustPool[dustIdx++ % dustPool.length];
  d.mesh.visible = true;
  d.mesh.position.set(x + (Math.random() - 0.5) * 0.5, y + 0.15, z + (Math.random() - 0.5) * 0.5);
  d.life = 0.7;
  d.vx = (Math.random() - 0.5) * 1.2; d.vy = 0.8 + kick; d.vz = (Math.random() - 0.5) * 1.2;
}
function updateDust(dt) {
  for (const d of dustPool) {
    if (d.life <= 0) continue;
    d.life -= dt;
    if (d.life <= 0) { d.mesh.visible = false; continue; }
    d.mesh.position.x += d.vx * dt;
    d.mesh.position.y += d.vy * dt;
    d.mesh.position.z += d.vz * dt;
    d.vy -= 2.2 * dt;
    d.mesh.material.opacity = d.life * 0.6;
    const k = 1 + (0.7 - d.life) * 1.6;
    d.mesh.scale.set(k, k * 0.7, k);
  }
}

// flowers and bushes
(function flowersAndBushes() {
  const flowerCols = [0xfff3d6, 0xd9a13b, 0xc25a4a, 0xe8e2d4, 0x8a5a7a].map((c) => new THREE.Color(c));
  const n = 420;
  const flowers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.12, 4, 3),
    new THREE.MeshLambertMaterial({ color: 0xffffff }), n);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3();
  let placed = 0, guard = 0;
  while (placed < n && guard++ < 4000) {
    const s = worldRng() * R.len;
    const side = worldRng() < 0.5 ? -1 : 1;
    const lat = (10.5 + worldRng() * 26) * side;
    const p = routeAt(s);
    const x = p.x + p.nx * lat + (worldRng() - 0.5) * 8, z = p.z + p.nz * lat + (worldRng() - 0.5) * 8;
    if (x < 0 || z < 0 || x > 840 || z > 740) continue;
    if (brookCarve(x, z) > 0.15) continue;
    const k = 0.7 + worldRng() * 0.8;
    m4.compose(v.set(x, groundHeight(x, z) + 0.1, z), q, sc.set(k, k, k));
    flowers.setMatrixAt(placed, m4);
    flowers.setColorAt(placed, flowerCols[Math.floor(worldRng() * flowerCols.length)]);
    placed++;
  }
  flowers.count = placed;
  scene.add(flowers);
  for (let i = 0; i < 60; i++) {
    const s = worldRng() * R.len;
    const side = worldRng() < 0.5 ? -1 : 1;
    const lat = (10.6 + worldRng() * 8) * side;
    const p = routeAt(s);
    const x = p.x + p.nx * lat, z = p.z + p.nz * lat;
    if (x < 0 || z < 0 || x > 840 || z > 740 || brookCarve(x, z) > 0.15) continue;
    const k = 0.5 + worldRng() * 0.8;
    const bush = new THREE.Mesh(new THREE.SphereGeometry(1, 7, 5),
      new THREE.MeshLambertMaterial({ color: [0x6f8c3e, 0x8c8c3a, 0xa8642e][Math.floor(worldRng() * 3)] }));
    bush.scale.set(k * 1.3, k * 0.8, k * 1.1);
    bush.position.set(x, groundHeight(x, z) + k * 0.5, z);
    bush.castShadow = true;
    scene.add(bush);
  }
})();

// ---------------------------------------------------------------- landmarks & life (round 2 dressing)
function cottage(x, z, rotY, scale = 1, wallCol = 0xe8dcc0, roofCol = 0xb5502a) {
  const g = new THREE.Group();
  const walls = new THREE.Mesh(new THREE.BoxGeometry(5 * scale, 3 * scale, 4 * scale),
    new THREE.MeshLambertMaterial({ color: wallCol }));
  walls.position.y = 1.5 * scale; walls.castShadow = true; g.add(walls);
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 3.4 * scale, 2.4 * scale, 4, 1),
    new THREE.MeshLambertMaterial({ color: roofCol }));
  roof.position.y = (3 + 1.2) * scale; roof.rotation.y = Math.PI / 4; roof.scale.z = 0.75;
  roof.castShadow = true; g.add(roof);
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.6 * scale, 1.6 * scale, 0.6 * scale),
    new THREE.MeshLambertMaterial({ color: 0xa79c82 }));
  chimney.position.set(1.4 * scale, 4.0 * scale, 0.8 * scale); g.add(chimney);
  const door = new THREE.Mesh(new THREE.PlaneGeometry(0.9 * scale, 1.7 * scale),
    new THREE.MeshLambertMaterial({ color: 0x5c3f22 }));
  door.position.set(0, 0.85 * scale, 2.01 * scale); g.add(door);
  g.position.set(x, groundHeight(x, z), z);
  g.rotation.y = rotY;
  scene.add(g);
  // world-space chimney mouth for smoke
  const cm = new THREE.Vector3(1.4 * scale, 4.8 * scale, 0.8 * scale).applyAxisAngle(UP, rotY);
  return { x: x + cm.x, y: groundHeight(x, z) + cm.y, z: z + cm.z };
}
const smokeSources = [];

// farmstead near the start
(function farmstead() {
  const p = routeAt(70);
  const fx = p.x + p.nx * 38, fz = p.z + p.nz * 38;
  smokeSources.push(cottage(fx, fz, 0.6));
  // barn
  const bg = new THREE.Group();
  const barn = new THREE.Mesh(new THREE.BoxGeometry(9, 4.5, 6),
    new THREE.MeshLambertMaterial({ color: 0x9a4f28 }));
  barn.position.y = 2.25; barn.castShadow = true; bg.add(barn);
  const broof = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 7.2, 3.2, 4, 1),
    new THREE.MeshLambertMaterial({ color: 0x6e4c2a }));
  broof.position.y = 6.1; broof.rotation.y = Math.PI / 4; broof.scale.z = 0.62; bg.add(broof);
  bg.position.set(fx + 12, groundHeight(fx + 12, fz + 4), fz + 4);
  bg.rotation.y = 0.4;
  scene.add(bg);
  // sheep in the yard
  for (let i = 0; i < 8; i++) {
    const sx = fx + 4 + worldRng() * 14, sz = fz - 12 + worldRng() * 9;
    const sheep = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.55, 7, 5),
      new THREE.MeshLambertMaterial({ color: 0xf2ead4 }));
    body.scale.set(1.25, 0.9, 0.9); body.position.y = 0.62; body.castShadow = true; sheep.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 6, 5),
      new THREE.MeshLambertMaterial({ color: 0x46311f }));
    head.position.set(0.62, 0.62, 0); sheep.add(head);
    sheep.position.set(sx, groundHeight(sx, sz), sz);
    sheep.rotation.y = worldRng() * 6.3;
    scene.add(sheep);
  }
})();

// windmill on the hill crest — the course landmark
let windmillSails = null;
(function windmill() {
  const p = routeAt(400);
  const wx = p.x + p.nx * -35, wz = p.z + p.nz * -35;
  const g = new THREE.Group();
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3.2, 11, 9),
    new THREE.MeshLambertMaterial({ color: 0xe0d4b8 }));
  tower.position.y = 5.5; tower.castShadow = true; g.add(tower);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(2.5, 9, 6, 0, Math.PI * 2, 0, Math.PI * 0.5),
    new THREE.MeshLambertMaterial({ color: 0xb5502a }));
  cap.position.y = 11; g.add(cap);
  const sails = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const sail = new THREE.Mesh(new THREE.BoxGeometry(0.35, 7.5, 0.12),
      new THREE.MeshLambertMaterial({ color: 0x8a6a42 }));
    sail.position.y = 3.4;
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 5.4),
      new THREE.MeshLambertMaterial({ color: 0xf2ead4, side: THREE.DoubleSide }));
    cloth.position.set(0.85, 3.8, 0);
    const arm = new THREE.Group();
    arm.add(sail); arm.add(cloth);
    arm.rotation.z = i * Math.PI / 2;
    sails.add(arm);
  }
  sails.position.set(0, 10.6, 2.6);
  g.add(sails);
  windmillSails = sails;
  const face = -Math.atan2(p.z - wz, p.x - wx);
  g.position.set(wx, groundHeight(wx, wz), wz);
  g.rotation.y = face + Math.PI / 2;
  scene.add(g);
})();

// orchard rows along the far meadow
for (let os = 590; os <= 665; os += 15) {
  for (const lat of [16, 22]) {
    const p = routeAt(os);
    const x = p.x + p.nx * lat, z = p.z + p.nz * lat;
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 1.6, 6),
      new THREE.MeshLambertMaterial({ color: 0x7a5230 }));
    trunk.position.y = 0.8; g.add(trunk);
    const crown = new THREE.Mesh(new THREE.SphereGeometry(1.4, 8, 6),
      new THREE.MeshLambertMaterial({ color: 0x889a3f }));
    crown.position.y = 2.4; crown.scale.y = 0.85; crown.castShadow = true; g.add(crown);
    for (let a = 0; a < 4; a++) {
      const apple = new THREE.Mesh(new THREE.SphereGeometry(0.12, 5, 4),
        new THREE.MeshBasicMaterial({ color: 0xc25a4a }));
      apple.position.set(Math.cos(a * 1.7) * 1.1, 2.2 + Math.sin(a * 2.3) * 0.7, Math.sin(a * 1.7) * 1.1);
      g.add(apple);
    }
    g.position.set(x, groundHeight(x, z), z);
    scene.add(g);
  }
}

// standing stones off the climb
(function stones() {
  const p = routeAt(452);
  const cx = p.x + p.nx * -32, cz = p.z + p.nz * -32;
  for (let i = 0; i < 7; i++) {
    const a = i / 7 * Math.PI * 2;
    const sx = cx + Math.cos(a) * 8, sz = cz + Math.sin(a) * 8;
    const h = 2 + worldRng() * 1.6;
    const stone = new THREE.Mesh(new THREE.BoxGeometry(1.1, h, 0.7),
      new THREE.MeshLambertMaterial({ color: 0x9a9484 }));
    stone.position.set(sx, groundHeight(sx, sz) + h / 2 - 0.2, sz);
    stone.rotation.y = a + worldRng() * 0.5;
    stone.rotation.z = (worldRng() - 0.5) * 0.15;
    stone.castShadow = true;
    scene.add(stone);
  }
})();

// a village around the sanctuary
(function village() {
  const p = routeAt(R.len - 14);
  smokeSources.push(cottage(p.x + p.nx * -14, p.z + p.nz * -14, 1.2, 0.9));
  smokeSources.push(cottage(p.x + p.nx * 15, p.z + p.nz * 20, -0.4, 1.05, 0xdccdb0));
  cottage(p.x + p.nx * -18, p.z + p.nz * 8, 2.4, 0.8, 0xe0d0b8, 0x8a6a42);
})();

// hedgerow stretches outside the fences
for (const [h0, h1] of [[100, 160], [565, 620]]) {
  for (let hs = h0; hs <= h1; hs += 4) {
    for (const side of [-1, 1]) {
      const p = routeAt(hs);
      const x = p.x + p.nx * 12.6 * side, z = p.z + p.nz * 12.6 * side;
      const hedge = new THREE.Mesh(new THREE.SphereGeometry(1.5, 6, 5),
        new THREE.MeshLambertMaterial({ color: (hs + side) % 3 ? 0x6f8c3e : 0x7d9a45 }));
      hedge.scale.set(1.5, 0.75, 1.0);
      hedge.position.set(x, groundHeight(x, z) + 0.6, z);
      scene.add(hedge);
    }
  }
}

// denser trackside planting — close objects flicking past are the speed read
(function tracksideTrees() {
  const canopyCols = [0xc96f2f, 0xd98f35, 0xb8552e, 0x889a3f, 0xd9a13b];
  let placed = 0, guard = 0;
  while (placed < 90 && guard++ < 3000) {
    const s = worldRng() * (R.len - 60) + 20;
    const side = worldRng() < 0.5 ? -1 : 1;
    const off = 12.5 + worldRng() * 13;
    const p = routeAt(s);
    const x = p.x + p.nx * off * side, z = p.z + p.nz * off * side;
    if (x < 0 || z < 0 || x > 840 || z > 740) continue;
    if (distToRoute(x, z) < 11.5 || brookCarve(x, z) > 0.2) continue;
    const g = new THREE.Group();
    const sc = 0.7 + worldRng() * 0.7;
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x7a5230 });
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3 * sc, 0.45 * sc, 2.4 * sc, 6), trunkMat);
    trunk.position.y = 1.2 * sc; trunk.castShadow = true; g.add(trunk);
    const mats = [trunkMat];
    const cc = canopyCols[Math.floor(worldRng() * canopyCols.length)];
    for (let b = 0; b < 2; b++) {
      const cm2 = new THREE.MeshLambertMaterial({ color: cc });
      const blob = new THREE.Mesh(new THREE.SphereGeometry((1.5 - b * 0.4) * sc, 7, 5), cm2);
      blob.position.set((worldRng() - 0.5) * 0.6 * sc, (2.2 + b * 1.0) * sc, (worldRng() - 0.5) * 0.6 * sc);
      blob.castShadow = true;
      g.add(blob); mats.push(cm2);
    }
    g.position.set(x, groundHeight(x, z), z);
    scene.add(g);
    trees.push({ x, z, r: 1.0 * sc, group: g, mats, fade: 1 });
    placed++;
  }
})();

// bird flocks circling
const flocks = [];
for (const [bx, bz] of [[350, 250], [620, 520]]) {
  const fg = new THREE.Group();
  const birds = [];
  for (let i = 0; i < 5; i++) {
    const bird = new THREE.Group();
    for (const wz of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.35),
        new THREE.MeshBasicMaterial({ color: 0x46311f, side: THREE.DoubleSide }));
      wing.position.z = wz * 0.42;
      wing.rotation.x = wz * 0.4;
      bird.add(wing);
    }
    bird.position.set((i - 2) * 2.2, (i % 2) * 0.8, Math.abs(i - 2) * 1.4);
    fg.add(bird); birds.push(bird);
  }
  scene.add(fg);
  flocks.push({ fg, birds, cx: bx, cz: bz, r: 55 + worldRng() * 25, a: worldRng() * 6, y: 38 + worldRng() * 8, spd: 0.14 + worldRng() * 0.06 });
}

// chimney smoke pool
const smokePool = [];
for (let i = 0; i < 18; i++) {
  const p = new THREE.Mesh(new THREE.SphereGeometry(0.4, 5, 4),
    new THREE.MeshLambertMaterial({ color: 0xcfc8bc, transparent: true, opacity: 0 }));
  p.visible = false;
  scene.add(p);
  smokePool.push({ mesh: p, life: 0 });
}
let smokeIdx = 0, smokeTimer = 0;
function updateAmbient(dt, t) {
  if (windmillSails) windmillSails.rotation.z += dt * 0.6;
  for (const f of flocks) {
    f.a += dt * f.spd;
    f.fg.position.set(f.cx + Math.cos(f.a) * f.r, f.y, f.cz + Math.sin(f.a) * f.r * 0.7);
    f.fg.rotation.y = -f.a - Math.PI / 2;
    for (let i = 0; i < f.birds.length; i++) {
      const flap = Math.sin(t * 7 + i * 1.3) * 0.5;
      f.birds[i].children[0].rotation.x = -0.4 - flap;
      f.birds[i].children[1].rotation.x = 0.4 + flap;
    }
  }
  smokeTimer -= dt;
  if (smokeTimer <= 0 && smokeSources.length) {
    smokeTimer = 0.55;
    const src = smokeSources[Math.floor(Math.random() * smokeSources.length)];
    const sp = smokePool[smokeIdx++ % smokePool.length];
    sp.mesh.visible = true;
    sp.mesh.position.set(src.x, src.y, src.z);
    sp.life = 3.2;
  }
  for (const sp of smokePool) {
    if (sp.life <= 0) continue;
    sp.life -= dt;
    if (sp.life <= 0) { sp.mesh.visible = false; continue; }
    sp.mesh.position.y += dt * 1.1;
    sp.mesh.position.x += dt * 0.5;
    sp.mesh.material.opacity = Math.min(0.5, sp.life * 0.22);
    const k = 1 + (3.2 - sp.life) * 0.5;
    sp.mesh.scale.set(k, k, k);
  }
}

// place-anchored one-shot sounds as the player passes through the course
let zoneCd = 0;
function updateZoneAudio(dt, p) {
  zoneCd -= dt;
  if (zoneCd > 0) return;
  if (p.s < 35 || p.s > R.len - 45) { sfxCheer(); zoneCd = 1.4 + Math.random(); }
  else if (p.s < 150) { if (Math.random() < 0.5) sfxBaa(); zoneCd = 2.5 + Math.random() * 2; }
  else if (p.s > 340 && p.s < 460) { sfxCreak(); zoneCd = 2.2 + Math.random(); }
  else zoneCd = 0.5;
}

// petals at the finish + drifting autumn leaves around the rider
const petalPool = [];
{
  const cols = [0xd9a13b, 0xc25a4a, 0xf7ecd4, 0xd98f9d];
  for (let i = 0; i < 30; i++) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3),
      new THREE.MeshBasicMaterial({ color: cols[i % cols.length], side: THREE.DoubleSide, transparent: true, opacity: 0 }));
    p.visible = false;
    scene.add(p);
    petalPool.push({ mesh: p, life: 0, vx: 0, vy: 0, vz: 0, ph: Math.random() * 6 });
  }
}
function spawnPetals() {
  const fin = routeAt(R.len - 6);
  const gy = groundHeight(fin.x, fin.z);
  for (const pt of petalPool) {
    pt.mesh.visible = true;
    pt.mesh.position.set(fin.x + (Math.random() - 0.5) * 13, gy + 3 + Math.random() * 3.5, fin.z + (Math.random() - 0.5) * 13);
    pt.life = 2.4 + Math.random() * 1.4;
    pt.vx = (Math.random() - 0.5) * 2;
    pt.vy = 1.2 + Math.random() * 2;
    pt.vz = (Math.random() - 0.5) * 2;
  }
}
const leafPool = [];
{
  const cols = [0xc96f2f, 0xd98f35, 0xb8552e, 0xd9a13b];
  for (let i = 0; i < 16; i++) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.2),
      new THREE.MeshBasicMaterial({ color: cols[i % cols.length], side: THREE.DoubleSide, transparent: true, opacity: 0 }));
    p.visible = false;
    scene.add(p);
    leafPool.push({ mesh: p, life: 0, ph: Math.random() * 6 });
  }
}
let leafIdx = 0, leafTimer = 0;
function updatePetalsAndLeaves(dt, t) {
  // leaves spawn gently around the player during rides
  if (state === 'run' || state === 'tut' || state === 'count') {
    leafTimer -= dt;
    if (leafTimer <= 0 && racers.length) {
      leafTimer = 0.45;
      const p = racers[0];
      const lf = leafPool[leafIdx++ % leafPool.length];
      lf.mesh.visible = true;
      lf.mesh.position.set(p.x + (Math.random() - 0.5) * 34, 8 + Math.random() * 4, p.z + (Math.random() - 0.5) * 34);
      lf.life = 7;
    }
  }
  for (const lf of leafPool) {
    if (lf.life <= 0) continue;
    lf.life -= dt;
    lf.mesh.position.y -= dt * 1.25;
    lf.mesh.position.x += Math.sin(t * 2 + lf.ph) * dt * 1.4;
    lf.mesh.rotation.x = t * 1.6 + lf.ph;
    lf.mesh.rotation.z = Math.sin(t * 1.3 + lf.ph);
    const gy = groundHeight(lf.mesh.position.x, lf.mesh.position.z);
    lf.mesh.material.opacity = Math.min(0.9, lf.life);
    if (lf.mesh.position.y < gy + 0.1 || lf.life <= 0) { lf.life = 0; lf.mesh.visible = false; }
  }
  for (const pt of petalPool) {
    if (pt.life <= 0) continue;
    pt.life -= dt;
    if (pt.life <= 0) { pt.mesh.visible = false; continue; }
    pt.mesh.position.x += pt.vx * dt;
    pt.mesh.position.y += pt.vy * dt;
    pt.mesh.position.z += pt.vz * dt;
    pt.vy -= dt * 2.4;
    pt.mesh.rotation.x = t * 3 + pt.ph;
    pt.mesh.rotation.y = t * 2 + pt.ph;
    pt.mesh.material.opacity = Math.min(0.95, pt.life * 0.8);
  }
}

// wind streaks past the player at gallop
const windPool = [];
for (let i = 0; i < 14; i++) {
  const p = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.09),
    new THREE.MeshBasicMaterial({ color: 0xfff8ea, transparent: true, opacity: 0, side: THREE.DoubleSide }));
  p.visible = false;
  scene.add(p);
  windPool.push({ mesh: p, life: 0, vx: 0, vz: 0 });
}
let windIdx = 0;
function spawnWind(px, py, pz, heading, speed) {
  const w = windPool[windIdx++ % windPool.length];
  w.mesh.visible = true;
  const ox = (Math.random() - 0.5) * 16, oz = (Math.random() - 0.5) * 16;
  w.mesh.position.set(px + ox + Math.cos(heading) * 10, py + 0.6 + Math.random() * 2.2, pz + oz + Math.sin(heading) * 10);
  w.mesh.rotation.y = -heading;
  w.vx = -Math.cos(heading) * speed * 2.4;
  w.vz = -Math.sin(heading) * speed * 2.4;
  w.life = 0.5;
}
function updateWind(dt) {
  for (const w of windPool) {
    if (w.life <= 0) continue;
    w.life -= dt;
    if (w.life <= 0) { w.mesh.visible = false; continue; }
    w.mesh.position.x += w.vx * dt;
    w.mesh.position.z += w.vz * dt;
    w.mesh.material.opacity = Math.min(0.4, w.life * 1.2);
  }
}

// ---------------------------------------------------------------- horse factory
function makeHorse(coat, riderCol) {
  const g = new THREE.Group();
  const cm = new THREE.MeshLambertMaterial({ color: coat });
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), cm);
  body.scale.set(1.5, 0.85, 0.72); body.position.y = 1.35; body.castShadow = true;
  g.add(body);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.42, 1.1, 8), cm);
  neck.position.set(1.15, 2.0, 0); neck.rotation.z = -0.7; neck.castShadow = true;
  g.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 6), cm);
  head.scale.set(1.5, 0.8, 0.7); head.position.set(1.72, 2.42, 0); head.castShadow = true;
  g.add(head);
  // ears
  const earM = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.32, 5), cm);
  earM.position.set(1.45, 2.75, 0.14); g.add(earM);
  const ear2 = earM.clone(); ear2.position.z = -0.14; g.add(ear2);
  // tail
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.1, 6),
    new THREE.MeshLambertMaterial({ color: 0x46311f }));
  tail.position.set(-1.5, 1.35, 0); tail.rotation.z = 1.9; g.add(tail);
  // legs
  const legs = [];
  const legGeo = new THREE.CylinderGeometry(0.14, 0.11, 1.3, 6);
  for (const [lx, lz] of [[0.85, 0.35], [0.85, -0.35], [-0.85, 0.35], [-0.85, -0.35]]) {
    const leg = new THREE.Mesh(legGeo, cm);
    leg.position.set(lx, 0.65, lz); leg.castShadow = true;
    g.add(leg); legs.push(leg);
  }
  // rider: torso + head + cape
  const rm = new THREE.MeshLambertMaterial({ color: riderCol });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.6, 3, 8), rm);
  torso.position.set(0.1, 2.45, 0); torso.castShadow = true; g.add(torso);
  const rhead = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 6),
    new THREE.MeshLambertMaterial({ color: 0xe8c49a }));
  rhead.position.set(0.1, 3.15, 0); g.add(rhead);
  const hood = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.45, 8), rm);
  hood.position.set(0.1, 3.38, 0); g.add(hood);
  const cape = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.1), new THREE.MeshLambertMaterial({ color: riderCol, side: THREE.DoubleSide }));
  cape.position.set(-0.45, 2.35, 0); cape.rotation.y = Math.PI / 2; cape.rotation.x = 0.35;
  g.add(cape);
  // blob shadow (altitude read during jumps)
  const blob = new THREE.Mesh(new THREE.CircleGeometry(1.3, 16),
    new THREE.MeshBasicMaterial({ color: 0x2a1d10, transparent: true, opacity: 0.3, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2;
  scene.add(blob);
  // floating rider marker (hidden for the player)
  const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.32),
    new THREE.MeshBasicMaterial({ color: riderCol }));
  marker.position.y = 4.4;
  g.add(marker);
  scene.add(g);
  return { group: g, legs, cape, blob, body, marker };
}

// ---------------------------------------------------------------- racers
// three tiers: TROT recovers, CANTER cruises, GALLOP spends
const GAIT_NAMES = ['TROT', 'CANTER', 'GALLOP'];
const GAIT_SPEED = [4.6, 7.4, 10.6];
const GAIT_TURN = [2.3, 1.55, 0.9];
const GAIT_STAM = [4.5, 0, -6];   // per second; positive = recover. Canter is the sustainable cruise.

function makeRacer(name, coat, riderCol, lateral, isPlayer, skill) {
  const st = routeAt(0);
  const vis = makeHorse(coat, riderCol);
  if (isPlayer) vis.marker.visible = false;
  return {
    name, isPlayer, skill, lateralHome: lateral, riderCol,
    paceMul: isPlayer ? 1 : 0.965 + skill * 0.05,
    x: st.x + st.nx * lateral, z: st.z + st.nz * lateral,
    heading: Math.atan2(st.tz, st.tx),
    speed: 0, gait: 0, stamina: 100,
    s: 0, si: 0, lateral,
    air: 0, airT: 0, stumble: 0, blownLock: 0, shiftCd: 0,
    alive: true, finished: false, finishTime: 0,
    liftY: 0, wasInBand: false, overBand: false, boost: 0,
    vis, animPhase: Math.random() * 6,
  };
}

let racers = [];
const DIFF_OFFSET = { easy: -0.18, fair: 0, hard: 0.14 };
let difficulty = 'fair';
function spawnField() {
  for (const r of racers) { scene.remove(r.vis.group); scene.remove(r.vis.blob); }
  const off = DIFF_OFFSET[difficulty] || 0;
  const sk = (base) => Math.min(1.2, Math.max(0.3, base + off));
  racers = [
    makeRacer('You', 0x8a5a2e, 0xb5502a, 0, true, 1),
    makeRacer('Marrow', 0x6e6e78, 0x4e6b8a, -4.5, false, sk(0.9)),
    makeRacer('Bracken', 0x9a4f28, 0x6b7d3a, 4.5, false, sk(0.75)),
    makeRacer('Dove', 0xe8e2d4, 0x8a5a7a, -9, false, sk(0.68)),
  ];
}


// ---------------------------------------------------------------- sim: one racer step
function slopeAlong(x, z, hx, hz) {
  const ahead = groundHeight(x + hx * 4, z + hz * 4);
  const behind = groundHeight(x - hx * 2, z - hz * 2);
  return (ahead - behind) / 6;
}
function projectToRoute(r) {
  let bi = r.si, bd = 1e9;
  const lo = Math.max(0, r.si - 10), hi = Math.min(R.pts.length - 1, r.si + 10);
  for (let i = lo; i <= hi; i++) {
    const d = (r.x - R.pts[i][0]) ** 2 + (r.z - R.pts[i][1]) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  r.si = bi;
  // refine s with the tangential offset — 3m quantization is too coarse for jump timing
  const along = (r.x - R.pts[bi][0]) * R.tan[bi][0] + (r.z - R.pts[bi][1]) * R.tan[bi][1];
  r.s = bi * R.step + Math.min(Math.max(along, -R.step / 2), R.step / 2);
  r.lateral = (r.x - R.pts[bi][0]) * R.nrm[bi][0] + (r.z - R.pts[bi][1]) * R.nrm[bi][1];
}
// controls: {steer:-1..1, gaitUp:bool, gaitDown:bool, jump:bool}
function stepRacer(r, c, dt, world) {
  if (!r.alive || r.finished) return;
  const sPrev = r.s;
  const hx = Math.cos(r.heading), hz = Math.sin(r.heading);
  const slope = slopeAlong(r.x, r.z, hx, hz);
  const inMud = r.air <= 0 && inMudAt(r.x, r.z);

  // gait shifting (discrete, small cooldown so it steps not slides)
  if (r.shiftCd > 0) r.shiftCd -= dt;
  const gaitMax = (r.blownLock > 0) ? 0 : 2;
  if (c.gaitUp && r.shiftCd <= 0 && r.gait < gaitMax) { r.gait++; r.shiftCd = 0.3; }
  if (c.gaitDown && r.shiftCd <= 0 && r.gait > 0) { r.gait--; r.shiftCd = 0.18; }
  if (r.gait > gaitMax) r.gait = gaitMax;

  // stamina
  const offPath = Math.abs(r.lateral) > 10;
  let stamRate = GAIT_STAM[r.gait];
  if (r.gait === 2 && slope > 0) stamRate -= slope * 34;      // climbing at gallop is ruinous
  if (offPath && stamRate < 0) stamRate *= 1.25;
  if (inMud && r.speed > 1) stamRate -= 3;                    // heavy going
  r.stamina = Math.min(100, r.stamina + stamRate * dt);
  if (r.stamina <= 0 && r.blownLock <= 0) {
    r.stamina = 0; r.blownLock = 3; r.gait = 0;
    if (r.isPlayer) world.onBlown && world.onBlown();
  }
  if (r.blownLock > 0) {
    r.blownLock -= dt;
    if (r.blownLock <= 0 && r.stamina < 25) r.blownLock = 0.5; // stays locked till 25
  }

  // jumping
  if (r.air > 0) {
    r.airT += dt;
    // note any obstacle band passed while airborne — a clean jump earns a surge
    for (const j of JUMPS) {
      if (Math.abs(j.s - r.s) > 6) continue;
      const across = (r.x - j.x) * j.tx + (r.z - j.z) * j.tz;
      const along = (r.x - j.x) * j.nx + (r.z - j.z) * j.nz;
      if (Math.abs(across) < j.width / 2 + 0.6 && along > j.latMin && along < j.latMax) { r.overBand = true; break; }
    }
    if (r.airT >= r.air) {
      r.air = 0; r.liftY = 0;
      if (r.overBand) {
        r.boost = 1.15;
        r.speed = Math.min(13, r.speed + 1.6);
        if (r.isPlayer && world.onSurge) world.onSurge();
      }
      r.overBand = false;
    } else {
      const t = r.airT / r.air;
      r.liftY = 4 * 2.2 * t * (1 - t);   // 2.2m apex arc
    }
  } else if (c.jump && r.gait >= 1 && r.stumble <= 0) {
    r.air = 0.75; r.airT = 0; // launch
  }

  // jumpable-obstacle stumble check — edge-triggered on ENTERING, no re-trigger loop
  let inBand = false;
  if (r.air <= 0) {
    for (const j of JUMPS) {
      if (Math.abs(j.s - r.s) > 6) continue;
      const across = (r.x - j.x) * j.tx + (r.z - j.z) * j.tz;
      const along = (r.x - j.x) * j.nx + (r.z - j.z) * j.nz;
      if (Math.abs(across) < j.width / 2 && along > j.latMin && along < j.latMax) { inBand = true; break; }
    }
    if (inBand && !r.wasInBand && r.stumble <= 0) {
      r.stumble = 1.2; r.speed *= 0.3; r.stamina = Math.max(0, r.stamina - 12);
      if (r.isPlayer) world.onStumble && world.onStumble();
    }
  }
  r.wasInBand = inBand;
  if (r.stumble > 0) r.stumble -= dt;

  // steering — commitment cornering: turn rate collapses with gait, worse downhill
  let turn = GAIT_TURN[r.gait];
  if (slope < 0) turn *= Math.max(0.55, 1 + slope * 2.5);
  if (r.stumble > 0) turn *= 0.4;
  if (r.air > 0) turn *= 0.15;
  r.heading += c.steer * turn * dt;

  // speed
  const gradeFactor = Math.min(1.3, Math.max(0.5, 1 - slope * 2.4));
  let target = GAIT_SPEED[r.gait] * gradeFactor * (r.paceMul || 1);
  if (offPath) target *= 0.82;
  if (Math.abs(r.lateral) > 55) target *= 0.5;
  if (r.stumble > 0) target *= 0.45;
  if (inMud) target *= 0.62;
  if (r.boost > 0) { target = Math.max(target, 12.4); r.boost -= dt; }
  const accel = target > r.speed ? 2.7 : 4.6;   // momentum: slower to build, slower to shed
  r.speed += Math.sign(target - r.speed) * Math.min(Math.abs(target - r.speed), accel * dt);

  // integrate
  r.x += Math.cos(r.heading) * r.speed * dt;
  r.z += Math.sin(r.heading) * r.speed * dt;

  // tree collision: soft push-out
  for (const t of trees) {
    const dx = r.x - t.x, dz = r.z - t.z;
    const d2 = dx * dx + dz * dz, rr = t.r + 0.8;
    if (d2 < rr * rr && d2 > 0.0001) {
      const d = Math.sqrt(d2);
      r.x = t.x + (dx / d) * rr; r.z = t.z + (dz / d) * rr;
      r.speed *= 0.94;
    }
  }
  // hay bales on the road: firmer bump
  if (r.air <= 0) for (const t of BALES) {
    const dx = r.x - t.x, dz = r.z - t.z;
    const d2 = dx * dx + dz * dz, rr = t.r + 0.8;
    if (d2 < rr * rr && d2 > 0.0001) {
      const d = Math.sqrt(d2);
      r.x = t.x + (dx / d) * rr; r.z = t.z + (dz / d) * rr;
      r.speed *= 0.9;
    }
  }

  projectToRoute(r);

  // cross-fence gates: hit the rails and you all but stop — thread the gap, or jump the fence
  if (r.air <= 0) {
    for (const g of GATES) {
      if (sPrev < g.s && r.s >= g.s - 0.3 && Math.abs(r.lateral - g.gapLat) > g.gapHalf) {
        const back = r.s - (g.s - 1.0);
        r.x -= Math.cos(r.heading) * back;
        r.z -= Math.sin(r.heading) * back;
        r.speed *= 0.15;
        r.stumble = Math.max(r.stumble, 0.5);
        if (r.isPlayer && world.onStumble) world.onStumble();
        projectToRoute(r);
        break;
      }
    }
  }
  // side fences pen the corridor (a scrape, not a wall of glass)
  if (r.air <= 0 && fenceActive(r.s) && Math.abs(r.lateral) > 9.6) {
    const rp = routeAt(r.s), sign = r.lateral > 0 ? 1 : -1;
    r.x = rp.x + rp.nx * 9.6 * sign;
    r.z = rp.z + rp.nz * 9.6 * sign;
    r.lateral = 9.6 * sign;
    r.speed *= 0.965;
  }

  // finish
  if (r.s >= R.len - 6) {
    r.finished = true; r.finishTime = world.time;
  }
}

// ---------------------------------------------------------------- AI
function aiControls(r, world) {
  const c = { steer: 0, gaitUp: false, gaitDown: false, jump: false };
  const hx = Math.cos(r.heading), hz = Math.sin(r.heading);
  const slope = slopeAlong(r.x, r.z, hx, hz);
  const finalStretch = (R.len - r.s) < 180;

  // desired gait — a kick-and-recover racing rhythm (0 trot, 1 canter, 2 gallop)
  let want = 1;
  const kickStam = 12 + (1 - r.skill) * 10;
  const uphill = slope > 0.04;
  if (r.stamina < 45 && !finalStretch) want = 0;                      // rebuild for the next kick
  if (slope < -0.045 && r.stamina > 15) want = 2;                     // downhill is cheap speed
  if (slope < 0.02 && r.stamina > 65) want = 2;                       // spend surplus on the flat
  if (finalStretch && r.stamina > kickStam) want = 2;
  if (uphill && want === 2 && !finalStretch) want = 1;   // never gallop a climb — it's ruinous
  if (r.stamina < 16 + (1 - r.skill) * 8) want = Math.min(want, 0);
  if (r.blownLock > 0) want = 0;
  // don't gallop into the two hard bends unless skilled
  if (r.gait !== want) { if (want > r.gait) c.gaitUp = true; else c.gaitDown = true; }

  // steering: lookahead point with a lateral target that respects gates and mud
  let latTarget = r.lateralHome * 0.5;
  const gate = GATES.find((g) => g.s > r.s - 2 && g.s - r.s < 45);
  if (gate) latTarget = gate.gapLat;
  const mud = MUD.find((m) => m.s > r.s && m.s - r.s < 30 && Math.abs(latTarget - m.lat) < m.r + 1.5);
  if (mud) latTarget = mud.lat > 0 ? mud.lat - (mud.r + 2.5) : mud.lat + (mud.r + 2.5);
  const bale = BALES.find((b) => b.s > r.s && b.s - r.s < 25 && Math.abs(latTarget - b.lat) < b.r + 1.2);
  if (bale) latTarget = bale.lat > 0 ? bale.lat - 3.4 : bale.lat + 3.4;
  const look = 9 + r.speed * 1.5;
  const tp = routeAt(r.s + look);
  const targetX = tp.x + tp.nx * latTarget;
  const targetZ = tp.z + tp.nz * latTarget;
  const want_h = Math.atan2(targetZ - r.z, targetX - r.x);
  let dh = want_h - r.heading;
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  c.steer = Math.min(1, Math.max(-1, dh * 2.2));

  // jumpables: launch just before the near edge
  const j = nextJump(r.s, r.lateral);
  if (j && r.air <= 0) {
    const edge = j.s - j.width / 2;      // near edge
    const toEdge = edge - r.s;
    if (toEdge < 1.6 && toEdge > -0.2) {
      if (world.rng() > (1 - r.skill) * 0.15) c.jump = true;
      // a failed roll: just doesn't jump this frame — may still catch next frame or stumble
    }
    if (j.s - r.s < 26 && r.gait < 1 && r.blownLock <= 0) { c.gaitUp = true; }
  }
  return c;
}

// ---------------------------------------------------------------- wildlife (live races only, not sim)
function makeDeerMesh() {
  const g = new THREE.Group();
  const cm = new THREE.MeshLambertMaterial({ color: 0x9a6b3f });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6), cm);
  body.scale.set(1.5, 0.95, 0.7); body.position.y = 1.05; body.castShadow = true; g.add(body);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 0.8, 6), cm);
  neck.position.set(0.72, 1.6, 0); neck.rotation.z = -0.5; g.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 6, 5), cm);
  head.scale.set(1.5, 0.8, 0.7); head.position.set(1.05, 1.95, 0); g.add(head);
  for (const zz of [0.1, -0.1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.24, 5), cm);
    ear.position.set(0.9, 2.2, zz); g.add(ear);
  }
  const tail = new THREE.Mesh(new THREE.SphereGeometry(0.14, 5, 4),
    new THREE.MeshLambertMaterial({ color: 0xf2ead4 }));
  tail.position.set(-0.85, 1.15, 0); g.add(tail);
  const legGeo = new THREE.CylinderGeometry(0.06, 0.05, 1.0, 5);
  for (const [lx, lz] of [[0.5, 0.2], [0.5, -0.2], [-0.5, 0.2], [-0.5, -0.2]]) {
    const leg = new THREE.Mesh(legGeo, cm);
    leg.position.set(lx, 0.5, lz); g.add(leg);
  }
  scene.add(g); g.visible = false;
  return g;
}
const DEER = [
  { s: 305, dir: 1 }, { s: 625, dir: -1 },
].map((d) => ({ ...d, p: routeAt(d.s), state: 'idle', lat: 28 * d.dir, x: 0, z: 0, mesh: makeDeerMesh() }));
function resetHazards() {
  for (const d of DEER) { d.state = 'idle'; d.lat = 28 * d.dir; d.mesh.visible = false; }
}
function stepDeer(dt) {
  let leadS = -1e9;
  for (const r of racers) if (r.alive && !r.finished) leadS = Math.max(leadS, r.s);
  for (const d of DEER) {
    if (d.state === 'idle' && leadS > d.s - 50 && leadS < d.s) {
      d.state = 'run'; d.mesh.visible = true;
      if (Math.abs(racers[0].s - d.s) < 70) flash('A deer bursts from the treeline!', 2);
    }
    if (d.state === 'run') {
      d.lat -= 8.5 * dt * d.dir;
      if (d.dir > 0 ? d.lat < -30 : d.lat > 30) { d.state = 'gone'; d.mesh.visible = false; continue; }
      d.x = d.p.x + d.p.nx * d.lat;
      d.z = d.p.z + d.p.nz * d.lat;
      for (const r of racers) {
        if (!r.alive || r.finished || r.air > 0 || r.stumble > 0) continue;
        const dx = r.x - d.x, dz = r.z - d.z;
        if (dx * dx + dz * dz < 2.1) {
          r.stumble = 1.2; r.speed *= 0.3; r.stamina = Math.max(0, r.stamina - 8);
          if (r.isPlayer) flash('The deer clips your horse!', 2);
        }
      }
    }
  }
}
function updateDeerVisuals(dt) {
  for (const d of DEER) {
    if (d.state !== 'run') continue;
    const vy = Math.abs(Math.sin(world.time * 9)) * 0.45;
    d.mesh.position.set(d.x, groundHeight(d.x, d.z) + vy, d.z);
    d.mesh.rotation.y = -Math.atan2(-d.p.nz * d.dir, -d.p.nx * d.dir);
  }
}

// ---------------------------------------------------------------- input & keybinds
const keys = {};
const DEFAULT_KEYS = {
  up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD',
  gaitUp: 'ShiftLeft', gaitDown: 'KeyX',
  jump: 'Space', camL: 'KeyQ', camR: 'KeyE', view: 'KeyV', pause: 'Escape',
};
// arrows (and P for pause) always work as a fallback
const FALLBACK_KEYS = { gaitUp: 'ArrowUp', gaitDown: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pause: 'KeyP' };
const ACTION_LABELS = {
  up: 'Ride up-screen', down: 'Ride down-screen', left: 'Ride left', right: 'Ride right',
  gaitUp: 'Speed up', gaitDown: 'Slow down',
  jump: 'Jump', camL: 'Rotate camera ⟲', camR: 'Rotate camera ⟳', view: 'Camera view', pause: 'Pause',
};
let KEYS = { ...DEFAULT_KEYS };
try { Object.assign(KEYS, JSON.parse(localStorage.getItem('tantivy.keys2') || '{}')); } catch (e) { /* fresh */ }
function saveKeys() { try { localStorage.setItem('tantivy.keys2', JSON.stringify(KEYS)); } catch (e) {} }
function isDown(a) { return !!(keys[KEYS[a]] || (FALLBACK_KEYS[a] && keys[FALLBACK_KEYS[a]])); }
function keyName(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return { Space: 'SPACE', Escape: 'ESC', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    ShiftLeft: 'L-SHIFT', ShiftRight: 'R-SHIFT', ControlLeft: 'L-CTRL', Enter: 'ENTER', Tab: 'TAB' }[code] || code;
}

let listeningAction = null;   // settings rebind capture
let paused = false;

addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  // settings rebind capture eats the next key
  if (listeningAction) {
    e.preventDefault();
    if (e.code !== 'Escape') { KEYS[listeningAction] = e.code; saveKeys(); }
    listeningAction = null;
    buildKeyRows();
    return;
  }
  keys[e.code] = true;
  const isPause = e.code === KEYS.pause || e.code === FALLBACK_KEYS.pause;
  if (isPause) {
    if (el('settings').classList.contains('on')) { closeSettings(); return; }
    if (state === 'run' || state === 'count' || state === 'tut') togglePause();
    return;
  }
  if (paused) return;
  if (e.code === KEYS.camL) rotateCam(1);
  if (e.code === KEYS.camR) rotateCam(-1);
  if (e.code === KEYS.view) cycleView();
  if (e.code === 'Digit1') tierReq = 0;
  if (e.code === 'Digit2') tierReq = 1;
  if (e.code === 'Digit3') tierReq = 2;
  if (e.code === 'KeyR' && state !== 'home') restart();
  if (e.code === 'Enter' && state === 'home') beginRace();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });

let prevUp = false, prevDown = false, prevJump = false;
let tierReq = null;   // 1/2/3 direct tier request
function readPlayerControls() {
  const up = isDown('gaitUp'), down = isDown('gaitDown'), jump = isDown('jump');
  const p = racers[0];
  const c = {
    steer: 0,
    gaitUp: up && !prevUp, gaitDown: down && !prevDown, jump: jump && !prevJump,
  };
  prevUp = up; prevDown = down; prevJump = jump;
  // direct tier select (1/2/3): keep nudging until the horse is there
  if (tierReq !== null && p) {
    if (p.gait < tierReq) c.gaitUp = true;
    else if (p.gait > tierReq) c.gaitDown = true;
    else tierReq = null;
  }
  // WASD rides camera-relative; arrow left/right stay plain steering
  const ix = (keys[KEYS.right] ? 1 : 0) - (keys[KEYS.left] ? 1 : 0);
  const iy = (keys[KEYS.up] ? 1 : 0) - (keys[KEYS.down] ? 1 : 0);
  const arrowSteer = (keys.ArrowLeft ? -1 : 0) + (keys.ArrowRight ? 1 : 0);
  if (arrowSteer !== 0) {
    c.steer = arrowSteer;
  } else if ((ix !== 0 || iy !== 0) && p) {
    // screen up = camera forward (ground-projected); screen right = its perpendicular
    const fx = -Math.cos(camYawCur), fz = -Math.sin(camYawCur);
    const rx = -fz, rz = fx;
    const dx = fx * iy + rx * ix, dz = fz * iy + rz * ix;
    let dh = Math.atan2(dz, dx) - p.heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    c.steer = Math.min(1, Math.max(-1, dh * 2.4));
  }
  return c;
}

// ---------------------------------------------------------------- audio (procedural WebAudio, no assets)
let AC = null, masterGain = null;
let soundOn = localStorage.getItem('tantivy.sound') !== 'off';
function ensureAudio() {
  if (!soundOn) return;
  if (!AC) {
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = AC.createGain();
      masterGain.gain.value = 0.5;
      masterGain.connect(AC.destination);
      startAmbient();
    } catch (e) { AC = null; }
  }
  if (AC && AC.state === 'suspended') AC.resume();
}
function setSound(on) {
  soundOn = on;
  try { localStorage.setItem('tantivy.sound', on ? 'on' : 'off'); } catch (e) {}
  if (on) ensureAudio();
  if (masterGain) masterGain.gain.value = on ? 0.5 : 0;
}
function tone(freq, dur, vol, type = 'sine', slide = 0) {
  if (!AC || !soundOn) return;
  const t = AC.currentTime;
  const o = AC.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  const g = AC.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(masterGain);
  o.start(t); o.stop(t + dur + 0.05);
}
function noiseBurst(dur, freq, vol, when = 0) {
  if (!AC || !soundOn) return;
  const len = Math.max(1, (dur * AC.sampleRate) | 0);
  const buf = AC.createBuffer(1, len, AC.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = AC.createBufferSource();
  src.buffer = buf;
  const f = AC.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = freq;
  const g = AC.createGain();
  g.gain.value = vol;
  src.connect(f); f.connect(g); g.connect(masterGain);
  src.start(AC.currentTime + when);
}
// real gait rhythms: trot is 2-beat, canter 3-beat, gallop 4-beat
const GAIT_PATTERN = [[0, 0.5], [0, 0.24, 0.44], [0, 0.13, 0.26, 0.38]];
function sfxHoof(gait, strideT, surface) {
  if (!AC || !soundOn) return;
  const base = surface === 'mud' ? 150 : surface === 'dirt' ? 320 : 240;
  const vol = (surface === 'mud' ? 0.3 : 0.17) + gait * 0.05;
  for (const frac of GAIT_PATTERN[gait]) {
    noiseBurst(surface === 'mud' ? 0.12 : 0.07, base + Math.random() * 60, vol * (0.8 + Math.random() * 0.4), frac * strideT);
  }
}
function sfxWhinny() {
  if (!AC || !soundOn) return;
  const t = AC.currentTime;
  const o = AC.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(640, t);
  o.frequency.exponentialRampToValueAtTime(270, t + 0.5);
  const lfo = AC.createOscillator();
  lfo.frequency.value = 15;
  const lfoGain = AC.createGain();
  lfoGain.gain.value = 45;
  lfo.connect(lfoGain); lfoGain.connect(o.frequency);
  const f = AC.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 1400;
  const g = AC.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.09, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
  o.connect(f); f.connect(g); g.connect(masterGain);
  o.start(t); lfo.start(t);
  o.stop(t + 0.6); lfo.stop(t + 0.6);
}
function sfxCheer() {
  if (!AC || !soundOn) return;
  noiseBurst(0.5, 1100, 0.07);
  for (let i = 0; i < 3; i++) {
    tone(320 + Math.random() * 320, 0.16, 0.035, 'sawtooth', 60);
  }
}
function sfxBaa() {
  tone(230, 0.16, 0.06, 'sawtooth', -25);
  setTimeout(() => tone(195, 0.22, 0.05, 'sawtooth', -20), 140);
}
function sfxCreak() { tone(85, 0.5, 0.06, 'sawtooth', 22); }
function sfxClick() { ensureAudio(); tone(500, 0.05, 0.1, 'square'); }
function sfxDing() { tone(880, 1.2, 0.16, 'sine'); tone(880 * 2.7, 0.7, 0.05, 'sine'); }
function sfxThud() { noiseBurst(0.25, 140, 0.55); tone(75, 0.3, 0.35, 'sine'); }
function sfxJump() { tone(300, 0.25, 0.14, 'sine', 260); }
function sfxSurge() {
  tone(520, 0.18, 0.12, 'sine', 340);
  setTimeout(() => tone(780, 0.15, 0.1, 'sine', 260), 80);
}
function sfxTick() { tone(330, 0.12, 0.16, 'square'); }
function sfxBlip(up) {
  if (up) { tone(520, 0.1, 0.12, 'sine'); setTimeout(() => tone(660, 0.12, 0.12, 'sine'), 70); }
  else { tone(330, 0.1, 0.1, 'sine'); setTimeout(() => tone(262, 0.12, 0.1, 'sine'), 70); }
}
// gallop wind: a loop whose volume follows the player's speed
let windGainNode = null;
function ensureWindLoop() {
  if (!AC || windGainNode) return;
  const len = AC.sampleRate;
  const buf = AC.createBuffer(1, len, AC.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  const src = AC.createBufferSource();
  src.buffer = buf; src.loop = true;
  const f = AC.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 0.6;
  windGainNode = AC.createGain();
  windGainNode.gain.value = 0;
  src.connect(f); f.connect(windGainNode); windGainNode.connect(masterGain);
  src.start();
}
function setWindLevel(v) { if (windGainNode) windGainNode.gain.value = v; }
function sfxLand(sp) { noiseBurst(0.12, 300, Math.min(0.45, sp / 25)); }
function sfxHorn(n = 1) {
  if (!AC || !soundOn) return;
  for (let i = 0; i < n; i++) {
    setTimeout(() => { tone(196, 0.5, 0.22, 'sawtooth'); tone(294, 0.5, 0.1, 'sawtooth'); }, i * 550);
  }
}
function sfxBells() {
  ensureAudio();
  if (!AC || !soundOn) return;
  const notes = [523, 659, 784, 1047];
  for (let i = 0; i < 6; i++) {
    setTimeout(() => {
      const f = notes[i % notes.length];
      tone(f, 1.6, 0.16, 'sine');
      tone(f * 2.76, 1.0, 0.04, 'sine');
    }, i * 420);
  }
}
// music — Kevin MacLeod (incompetech.com), CC-BY 4.0; credited in settings + README
let musicOn = localStorage.getItem('tantivy.music') !== 'off';
const menuMusic = new Audio('music/menu.mp3');
const raceMusic = new Audio('music/race.mp3');
menuMusic.loop = raceMusic.loop = true;
menuMusic.volume = 0.28;
raceMusic.volume = 0.33;
let musicUnlocked = false;
function playMusic(which) {
  if (!musicOn || !musicUnlocked) return;
  const target = which === 'race' ? raceMusic : menuMusic;
  const other = which === 'race' ? menuMusic : raceMusic;
  other.pause();
  if (target.paused) { target.play().catch(() => {}); }
}
function stopMusic() { menuMusic.pause(); raceMusic.pause(); }
function setMusic(on) {
  musicOn = on;
  try { localStorage.setItem('tantivy.music', on ? 'on' : 'off'); } catch (e) {}
  if (!on) stopMusic();
  else playMusic(state === 'run' || state === 'count' || state === 'tut' ? 'race' : 'menu');
}
addEventListener('pointerdown', () => {
  if (!musicUnlocked) {
    musicUnlocked = true;
    if (state === 'home') playMusic('menu');
  }
});

function startAmbient() {
  // soft wind loop + occasional bird chirps
  const len = AC.sampleRate * 2;
  const buf = AC.createBuffer(1, len, AC.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  const src = AC.createBufferSource();
  src.buffer = buf; src.loop = true;
  const f = AC.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 420;
  const g = AC.createGain();
  g.gain.value = 0.028;
  src.connect(f); f.connect(g); g.connect(masterGain);
  src.start();
  ensureWindLoop();
  (function chirp() {
    setTimeout(() => {
      if (AC && soundOn) {
        const base = 2200 + Math.random() * 1400;
        tone(base, 0.08, 0.045, 'sine', 500);
        setTimeout(() => tone(base * 1.1, 0.07, 0.035, 'sine', -300), 120);
      }
      chirp();
    }, 2500 + Math.random() * 5000);
  })();
}

// ---------------------------------------------------------------- HUD
const el = (id) => document.getElementById(id);
const hud = el('hud'), placard = el('placard'), gaitname = el('gaitname'),
  stambar = el('stambar'), blownEl = el('blown'),
  msgEl = el('msg'), bigmsg = el('bigmsg');
// minimap: the whole route, hazard ticks, and live rider dots
const mmap = el('minimap'), mctx = mmap.getContext('2d');
const MM = (() => {
  let minX = 1e9, minZ = 1e9, maxX = -1e9, maxZ = -1e9;
  for (const p of R.pts) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
  }
  const pad = 12, w = 240 - pad * 2, h = 150 - pad * 2;
  const sc = Math.min(w / (maxX - minX), h / (maxZ - minZ));
  const ox = pad + (w - (maxX - minX) * sc) / 2, oy = pad + (h - (maxZ - minZ) * sc) / 2;
  return { x: (x) => ox + (x - minX) * sc, y: (z) => oy + (z - minZ) * sc };
})();
function mmTick(s, color) {
  const p = routeAt(s);
  mctx.beginPath();
  mctx.moveTo(MM.x(p.x - p.nx * 7), MM.y(p.z - p.nz * 7));
  mctx.lineTo(MM.x(p.x + p.nx * 7), MM.y(p.z + p.nz * 7));
  mctx.strokeStyle = color; mctx.lineWidth = 2.5; mctx.stroke();
}
function drawMinimap() {
  mctx.clearRect(0, 0, 240, 150);
  mctx.beginPath();
  for (let i = 0; i < R.pts.length; i += 2) {
    const X = MM.x(R.pts[i][0]), Y = MM.y(R.pts[i][1]);
    if (i) mctx.lineTo(X, Y); else mctx.moveTo(X, Y);
  }
  mctx.strokeStyle = '#c49a63'; mctx.lineWidth = 5; mctx.lineCap = 'round'; mctx.stroke();
  for (const b of BROOKS) if (b.s < R.len - 30) mmTick(b.s, '#5f96c2');
  for (const g of GATES) mmTick(g.s, '#d9a13b');
  const f = routeAt(R.len - 4);
  mctx.fillStyle = '#b5502a';
  mctx.beginPath(); mctx.arc(MM.x(f.x), MM.y(f.z), 4, 0, 7); mctx.fill();
  for (const r of racers) {
    mctx.beginPath();
    mctx.arc(MM.x(r.x), MM.y(r.z), r.isPlayer ? 4.5 : 3, 0, 7);
    mctx.fillStyle = '#' + r.riderCol.toString(16).padStart(6, '0');
    mctx.fill();
    mctx.lineWidth = 1.4; mctx.strokeStyle = '#46311f'; mctx.stroke();
  }
}
function updateGaitHint() {
  el('gaithint').innerHTML =
    `<kbd>${keyName(KEYS.gaitUp)}</kbd> faster · <kbd>${keyName(KEYS.gaitDown)}</kbd> slower · ` +
    `<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> direct · <kbd>${keyName(KEYS.jump)}</kbd> jump`;
}
const pips = [...document.querySelectorAll('.pip')];
let msgTimer = 0;
function flash(text, secs = 2) { msgEl.textContent = text; msgTimer = secs; }
function ordinal(n) { return n + (['th', 'st', 'nd', 'rd'][((n % 100) - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th'); }
function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}
function updateHUD(world) {
  const p = racers[0];
  let pos = 1;
  for (const r of racers) {
    if (r === p) continue;
    if ((r.finished ? R.len + 1000 - r.finishTime : r.s) > (p.finished ? R.len + 1000 - p.finishTime : p.s)) pos++;
  }
  if (world.lastPos !== undefined && pos !== world.lastPos && state === 'run' && world.time > 4) {
    placard.classList.remove('bump'); void placard.offsetWidth; placard.classList.add('bump');
    sfxBlip(pos < world.lastPos);
    if (pos < world.lastPos) flash('You take ' + ordinal(pos) + '!', 1.2);
  }
  world.lastPos = pos;
  placard.innerHTML = `<span class="pos">${ordinal(pos)}</span> &nbsp;<span class="time">${fmtTime(world.time)}</span>`;
  gaitname.textContent = GAIT_NAMES[p.gait] + (p.air > 0 ? ' — AIRBORNE' : '');
  pips.forEach((pip, i) => pip.classList.toggle('lit', i <= p.gait));
  stambar.style.width = p.stamina + '%';
  stambar.className = p.stamina < 20 ? 'crit' : (p.stamina < 45 ? 'low' : '');
  stambar.id = 'stambar';
  blownEl.textContent = p.blownLock > 0 && p.stamina < 25 ? 'BLOWN — the horse needs breath' : '';
  drawMinimap();
  if (msgTimer > 0) { msgTimer -= world.dt; if (msgTimer <= 0) msgEl.textContent = ''; }
  // jump prompt
  const j = nextJump(p.s, p.lateral);
  if (j && p.air <= 0 && j.s - p.s < 30 && j.s - p.s > 0 && msgTimer <= 0) {
    msgEl.textContent = j.s - p.s < p.speed * 0.55 + 3 ? 'JUMP!'
      : ({ log: 'Log ahead…', wall: 'Stone wall ahead…', brook: 'Brook ahead…' }[j.kind]);
  } else if (msgTimer <= 0 && (msgEl.textContent.endsWith('ahead…') || msgEl.textContent === 'JUMP!')) {
    msgEl.textContent = '';
  }
}

// ---------------------------------------------------------------- visuals update
function updateRacerVisual(r, dt) {
  const v = r.vis;
  const gy = groundHeight(r.x, r.z);
  v.group.position.set(r.x, gy + r.liftY, r.z);
  v.group.rotation.y = -r.heading;   // model faces +x
  r.animPhase += dt * (2 + r.speed * 1.6);
  const amp = Math.min(0.5, r.speed / 14);
  const ph = r.animPhase;
  v.legs.forEach((leg, i) => {
    // front pair leads, back pair follows; trot alternates sides, gallop reaches together
    const pairOff = (i < 2) ? 0 : Math.PI * (0.4 + r.gait * 0.25);
    const sideOff = (i % 2) * Math.PI * (r.gait === 0 ? 1 : 0.12);
    leg.rotation.z = Math.sin(ph + pairOff + sideOff) * amp * (1.1 + r.gait * 0.25);
  });
  v.group.position.y += Math.abs(Math.sin(ph)) * amp * 0.35;
  // body language: rock at speed, nose-up launch and nose-down landing in air, dip on stumble
  let pitch = Math.sin(ph) * amp * 0.14;
  if (r.air > 0) {
    const at = r.airT / r.air;
    pitch = at < 0.5 ? -0.28 * (1 - at * 2) - 0.05 : 0.3 * (at - 0.5) * 2;
  } else if (r.stumble > 0.4) {
    pitch = 0.35;
  }
  v.group.rotation.z = pitch;
  v.body.scale.x = 1.5 * (1 + Math.min(0.09, r.speed * 0.007) + (r.air > 0 ? 0.1 : 0));
  v.cape.rotation.x = 0.35 + Math.min(0.9, r.speed / 12);
  // landing dust for every horse
  if (r.air <= 0 && r.prevAirAll) {
    for (let d = 0; d < 3; d++) spawnDust(r.x + (Math.random() - 0.5), gy, r.z + (Math.random() - 0.5), 0.6);
  }
  r.prevAirAll = r.air > 0;
  if (v.marker.visible) v.marker.rotation.y += dt * 2.2;
  // a burst of streaks on the player's up-shift sells the gear change
  if (r.isPlayer) {
    if (r.prevGaitVis !== undefined && r.gait > r.prevGaitVis && r.speed > 4) {
      for (let i = 0; i < 4; i++) spawnWind(r.x, gy, r.z, r.heading, Math.max(9, r.speed));
    }
    r.prevGaitVis = r.gait;
  }
  v.blob.position.set(r.x, gy + 0.08, r.z);
  const sh = 1 - Math.min(0.6, r.liftY / 4);
  v.blob.scale.set(sh, sh, sh);
  // hoof dust at speed
  if (r.air <= 0 && r.speed > 7) {
    r.dustAcc = (r.dustAcc || 0) + dt * r.speed;
    if (r.dustAcc > 3.2) {
      r.dustAcc = 0;
      spawnDust(r.x - Math.cos(r.heading) * 1.3, gy, r.z - Math.sin(r.heading) * 1.3, r.speed / 14);
    }
  }
  // wind streaks whipping past at gallop
  if (r.isPlayer && r.speed > 8.6) {
    r.windAcc = (r.windAcc || 0) + dt;
    if (r.windAcc > 0.09) { r.windAcc = 0; spawnWind(r.x, gy, r.z, r.heading, r.speed); }
  }
  // player audio: hoofbeats, jump, landing
  if (r.isPlayer) {
    if (r.air <= 0 && r.speed > 1.2) {
      r.hoofAcc = (r.hoofAcc || 0) + dt * r.speed;
      if (r.hoofAcc > 2.6) {
        r.hoofAcc %= 2.6;
        const strideT = 2.6 / Math.max(2, r.speed);
        const surface = inMudAt(r.x, r.z) ? 'mud' : (Math.abs(r.lateral) < 5.5 ? 'dirt' : 'grass');
        sfxHoof(r.gait, strideT, surface);
      }
    }
    if (r.air > 0 && !r.wasAirVis) sfxJump();
    if (r.air <= 0 && r.wasAirVis) sfxLand(r.speed);
    r.wasAirVis = r.air > 0;
  }
}

// ---------------------------------------------------------------- occluder fade
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
function occluderFade(dt) {
  const p = racers[0];
  _v2.set(p.x, groundHeight(p.x, p.z) + 1.5, p.z).project(camera);
  for (const t of trees) {
    const dx = t.x - p.x, dz = t.z - p.z;
    let target = 1;
    if (dx * dx + dz * dz < 3600) {
      _v1.set(t.x, t.group.position.y + 3, t.z).project(camera);
      const ndc = Math.hypot(_v1.x - _v2.x, (_v1.y - _v2.y) * 0.7);
      if (ndc < 0.11 && _v1.z < _v2.z) target = 0.22;
    }
    if (Math.abs(t.fade - target) > 0.01) {
      t.fade += (target - t.fade) * Math.min(1, dt * 8);
      for (const m of t.mats) {
        m.transparent = t.fade < 0.98;
        m.opacity = t.fade;
        m.depthWrite = t.fade > 0.6;
      }
    }
  }
}

// ---------------------------------------------------------------- camera
const camTarget = new THREE.Vector3();
let camInit = false;
function updateCamera(dt) {
  const p = racers[0];
  // the camera leads harder and pulls back as speed builds — the speed read
  const lead = 5 + p.speed * 0.85;
  const tx = p.x + Math.cos(p.heading) * lead;
  const tz = p.z + Math.sin(p.heading) * lead;
  const ty = groundHeight(p.x, p.z);
  if (!camInit) { camTarget.set(tx, ty, tz); camInit = true; }
  const k = 1 - Math.exp(-dt * 3.2);
  camTarget.x += (tx - camTarget.x) * k;
  camTarget.y += (ty - camTarget.y) * k;
  camTarget.z += (tz - camTarget.z) * k;
  const spd = Math.min(1, p.speed / 11);
  VIEW_H += (viewBase * (1 + spd * 0.16) - VIEW_H) * Math.min(1, dt * 2.5);
  sizeCamera();
  const wantYaw = Math.PI / 4 + camYawIdx * Math.PI / 2;
  camYawCur += (wantYaw - camYawCur) * Math.min(1, dt * 6);
  camera.position.copy(camTarget).add(camOffset());
  if (p.gait === 2 && p.air <= 0 && p.speed > 8) {
    camera.position.x += (Math.random() - 0.5) * 0.22;
    camera.position.z += (Math.random() - 0.5) * 0.22;
  }
  camera.lookAt(camTarget);
  sun.position.set(camTarget.x - 110, 85, camTarget.z + 30);
  sun.target.position.copy(camTarget);
}

// ---------------------------------------------------------------- race flow
let state = 'home';
let tut = null;
const world = {
  time: 0, dt: 0, rng: mulberry32(Date.now() & 0xffff),
  onBlown: () => { flash('BLOWN! Drop to trot and breathe', 2.5); sfxThud(); },
  onStumble: () => { flash('Stumbled!', 2); sfxThud(); sfxWhinny(); },
  onSurge: () => { flash('Clean jump — surge!', 1.4); sfxSurge(); },
};
let countdown = 0;

function hideOverlays() { for (const id of ['home', 'settings', 'pause', 'results', 'levels']) el(id).classList.remove('on'); }
function gotoHome() {
  paused = false;
  hideOverlays();
  el('home').classList.add('on');
  hud.classList.remove('on');
  el('tutbox').classList.remove('on');
  bigmsg.textContent = ''; msgEl.textContent = '';
  tut = null;
  state = 'home';
  updateHomeHint();
  setWindLevel(0);
  playMusic('menu');
}
function togglePause() {
  paused = !paused;
  el('pause').classList.toggle('on', paused);
  if (paused) setWindLevel(0);
}

function restart() {
  hideOverlays();
  paused = false;
  el('tutbox').classList.remove('on');
  spawnField();
  resetHazards();
  world.time = 0;
  camInit = false;
  tut = null;
  state = 'count';
  countdown = 3.0;
  hud.classList.add('on');
  updateGaitHint();
  delete world.lastPos;
  bigmsg.textContent = '';
}
function beginRace() { ensureAudio(); restart(); playMusic('race'); raceMusic.volume = 0.16; }

// ---------------------------------------------------------------- settings UI
function openSettings() { el('home').classList.remove('on'); el('settings').classList.add('on'); buildKeyRows(); refreshSoundBtn(); }
function closeSettings() {
  listeningAction = null;
  el('settings').classList.remove('on');
  el('home').classList.add('on');
  updateHomeHint();
}
function buildKeyRows() {
  const rows = el('keyrows');
  rows.innerHTML = '';
  for (const a of Object.keys(ACTION_LABELS)) {
    const name = document.createElement('div');
    name.className = 'kname'; name.textContent = ACTION_LABELS[a];
    const chip = document.createElement('button');
    chip.className = 'keychip' + (listeningAction === a ? ' listening' : '');
    chip.textContent = listeningAction === a ? 'press a key…' : keyName(KEYS[a]);
    chip.addEventListener('click', () => { listeningAction = a; buildKeyRows(); });
    rows.append(name, chip);
  }
}
function updateHomeHint() {
  el('homekeys').textContent =
    `WASD ride · ${keyName(KEYS.gaitUp)}/${keyName(KEYS.gaitDown)} or 1/2/3 speed · ` +
    `${keyName(KEYS.jump)} jump · ${keyName(KEYS.camL)}/${keyName(KEYS.camR)}/${keyName(KEYS.view)} camera · ${keyName(KEYS.pause)} pause`;
}

// ---------------------------------------------------------------- level select
const LEVELS = [
  { id: 'vale', name: 'The Vale Road', desc: '807m · a hard climb, three logs, a stone wall, a brook, two gates. First to the bells.' },
];
function openLevels() {
  el('home').classList.remove('on');
  el('levels').classList.add('on');
  const list = el('levellist');
  list.innerHTML = '';
  for (const lv of LEVELS) {
    const b = document.createElement('button');
    b.className = 'levelcard';
    b.innerHTML = `<div class="lname">${lv.name}</div><div class="ldesc">${lv.desc}</div>`;
    b.addEventListener('click', () => beginRace(lv.id));
    list.appendChild(b);
  }
}
function refreshSoundBtn() {
  el('soundbtn').textContent = 'SOUND: ' + (soundOn ? 'ON' : 'OFF');
  el('musicbtn').textContent = 'MUSIC: ' + (musicOn ? 'ON' : 'OFF');
}

for (const btn of document.querySelectorAll('.diffbtn')) {
  btn.addEventListener('click', () => {
    difficulty = btn.dataset.diff;
    document.querySelectorAll('.diffbtn').forEach((b) => b.classList.toggle('active', b === btn));
  });
}
el('ridebtn').addEventListener('click', openLevels);
el('levelback').addEventListener('click', () => { el('levels').classList.remove('on'); el('home').classList.add('on'); });
el('tutbtn').addEventListener('click', beginTutorial);
el('setbtn').addEventListener('click', openSettings);
el('setback').addEventListener('click', closeSettings);
el('soundbtn').addEventListener('click', () => { setSound(!soundOn); refreshSoundBtn(); });
el('musicbtn').addEventListener('click', () => { setMusic(!musicOn); refreshSoundBtn(); });
el('resetkeys').addEventListener('click', () => { KEYS = { ...DEFAULT_KEYS }; saveKeys(); buildKeyRows(); });
el('againbtn').addEventListener('click', beginRace);
el('resmenubtn').addEventListener('click', gotoHome);
el('resumebtn').addEventListener('click', togglePause);
el('prestartbtn').addEventListener('click', () => restart());
el('pmenubtn').addEventListener('click', gotoHome);
updateHomeHint();

// ---------------------------------------------------------------- tutorial (guided ride)
function spawnSolo() {
  for (const r of racers) { scene.remove(r.vis.group); scene.remove(r.vis.blob); }
  racers = [makeRacer('You', 0x8a5a2e, 0xb5502a, 0, true, 1)];
}
function tutMsg(html) { const t = el('tutbox'); t.innerHTML = html; t.classList.add('on'); }
function beginTutorial() {
  ensureAudio();
  hideOverlays();
  paused = false;
  spawnSolo();
  resetHazards();
  world.time = 0;
  camInit = false;
  state = 'tut';
  tut = { stage: 0, t: 0, gallopHeld: 0 };
  hud.classList.add('on');
  updateGaitHint();
  playMusic('race');
  bigmsg.textContent = '';
  tutMsg(`The paddock road. Press <kbd>${keyName(KEYS.gaitUp)}</kbd> (or <kbd>2</kbd>) to shift up to <b>CANTER</b>.`);
}
function tutStep(dt) {
  const p = racers[0];
  tut.t += dt;
  switch (tut.stage) {
    case 0:
      if (p.gait >= 1) {
        tut.stage = 1;
        tutMsg('Ride with <kbd>WASD</kbd> and follow the road. The faster the gait, the wider your horse turns.');
      }
      break;
    case 1:
      if (p.s > 150) {
        tut.stage = 2;
        tutMsg(`Now <b>GALLOP</b> (<kbd>${keyName(KEYS.gaitUp)}</kbd>). Watch the stamina bar — gallop is borrowed speed.`);
      }
      break;
    case 2:
      if (p.gait === 2) tut.gallopHeld += dt;
      if (tut.gallopHeld > 3 && p.stamina < 70) {
        tut.stage = 3;
        tutMsg(`Drop to <b>TROT</b> (<kbd>${keyName(KEYS.gaitDown)}</kbd>) and let the horse breathe. Stamina only returns at trot and walk.`);
      }
      break;
    case 3:
      if (p.stamina > 80) {
        tut.stage = 4;
        tutMsg('Dark ground ahead is <b>mud</b> — heavy going that slows and drains. Pick a line around it.');
      }
      break;
    case 4:
      if (p.s > 300) {
        tut.stage = 5;
        tutMsg(`A fallen <b>log</b> ahead — press <kbd>${keyName(KEYS.jump)}</kbd> at the pale bar to jump it. You need canter or better to leave the ground.`);
      }
      break;
    case 5:
      if (p.s > 355) {
        tut.stage = 6;
        tutMsg('The climb. Hold <b>CANTER</b> uphill — galloping a climb ruins a horse. Thread the gap in the cross-fence.');
      }
      break;
    case 6:
      if (p.s > 470) {
        tut.stage = 7;
        tutMsg('A <b>brook</b> crosses the road ahead. Jump at the pale bar, land past the ring.');
      }
      break;
    case 7:
      if (p.s > 575) {
        tut.stage = 8; tut.t = 0;
        tutMsg('<b>Well ridden — that is the whole craft.</b> Gates, mud, logs, brooks and a fresh horse between you and the bells. Off to a true race!');
      }
      break;
    case 8:
      if (tut.t > 6) gotoHome();
      break;
  }
}

function endRace() {
  state = 'done';
  setWindLevel(0);
  // fast-forward the rest of the field headlessly so results are complete
  let guard = 0;
  const dt = 1 / 30;
  while (racers.some((r) => !r.finished) && guard++ < 30 * 240) {
    world.time += dt;
    for (const r of racers) if (!r.finished && !r.isPlayer) stepRacer(r, aiControls(r, world), dt, world);
    collideField(racers);
  }
  showResults();
}
function showResults() {
  const p = racers[0];
  const ranked = [...racers].sort((a, b) =>
    (a.finished ? a.finishTime : 1e9 - a.s) - (b.finished ? b.finishTime : 1e9 - b.s));
  const place = ranked.indexOf(p) + 1;
  const flavor = ['A famous victory.', 'Beaten by a stride.', 'Respectable riding.', 'The field had your measure today.'][place - 1];
  el('resh').textContent = place === 1 ? 'First to the Bells!' : `${ordinal(place)} to the Bells`;
  el('ressub').textContent = `${fmtTime(p.finishTime)} — ${flavor}`;
  const winT = ranked[0].finished ? ranked[0].finishTime : 0;
  const rows = ranked.map((r, i) => {
    const t = r.finished
      ? fmtTime(r.finishTime) + (i > 0 ? ` <span style="opacity:.55">+${(r.finishTime - winT).toFixed(1)}</span>` : '')
      : 'on the road';
    return `<tr><td>${i + 1}.</td><td>${r.name}${r.isPlayer ? ' ⭑' : ''}</td><td class="t">${t}</td></tr>`;
  }).join('');
  el('restable').innerHTML = rows;
  el('results').classList.add('on');
  hud.classList.remove('on');
  sfxBells();
  playMusic('menu');
}

// ---------------------------------------------------------------- main loop
let lastT = performance.now(), lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  lastFrame = now;
  let dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  advance(dt);
}
function advance(dt) {
  world.dt = dt;
  if (paused) { renderer.render(scene, camera); return; }

  if (state === 'count') {
    countdown -= dt;
    const disp = String(Math.max(1, Math.ceil(countdown)));
    if (bigmsg.textContent !== disp) {
      bigmsg.textContent = disp;
      bigmsg.classList.remove('pop'); void bigmsg.offsetWidth; bigmsg.classList.add('pop');
      sfxTick();
    }
    if (countdown <= 0) {
      state = 'run';
      bigmsg.textContent = 'RIDE!';
      setTimeout(() => { if (bigmsg.textContent === 'RIDE!') bigmsg.textContent = ''; }, 900);
      flash(`${keyName(KEYS.gaitUp)} shifts up a gait — gallop drains the horse, trot restores it`, 4.5);
      sfxHorn(2);
      raceMusic.volume = 0.33;
    }
  }

  if (state === 'run') {
    world.time += dt;
    const pc = autopilot ? aiControls(racers[0], world) : readPlayerControls();
    stepRacer(racers[0], pc, dt, world);
    for (let i = 1; i < racers.length; i++) {
      stepRacer(racers[i], aiControls(racers[i], world), dt, world);
    }
    collideField(racers);
    stepDeer(dt);
    const p = racers[0];
    setWindLevel(Math.max(0, Math.min(1, p.speed / 11) - 0.62) * 0.35);
    updateZoneAudio(dt, p);
    if (p.finished) { sfxDing(); spawnPetals(); endRace(); }
  }

  if (state === 'tut') {
    world.time += dt;
    stepRacer(racers[0], readPlayerControls(), dt, world);
    stepDeer(dt);
    tutStep(dt);
  }

  if (state === 'run' || state === 'count' || state === 'done' || state === 'tut') {
    for (const r of racers) updateRacerVisual(r, dt);
    updateCamera(dt);
    occluderFade(dt);
    updateDeerVisuals(dt);
    updateDust(dt);
    if (state !== 'done') updateHUD(world);
  } else {
    // home menu: a slow cinematic tour of the whole course behind the card
    const t = performance.now() / 1000;
    const s = 20 + (t * 7) % (R.len - 70);
    const p0 = routeAt(s);
    const gy = groundHeight(p0.x, p0.z);
    camTarget.set(p0.x, gy, p0.z);
    camera.position.set(p0.x + 33, gy + 22, p0.z + 33);
    const ahead = routeAt(s + 28);
    camera.lookAt(ahead.x, groundHeight(ahead.x, ahead.z) + 2, ahead.z);
    sun.position.set(camTarget.x - 110, 85, camTarget.z + 30);
    sun.target.position.copy(camTarget);
  }
  const tNow = performance.now() / 1000;
  updateClouds(dt);
  updateWater(tNow);
  updateCrowd();
  updateAmbient(dt, tNow);
  updateWind(dt);
  updatePetalsAndLeaves(dt, tNow);
  skyDome.position.copy(camTarget);
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// render watchdog — hidden-panel RAF stalls
setInterval(() => {
  if (performance.now() - lastFrame > 700) {
    renderer.render(scene, camera);
  }
}, 500);

// ---------------------------------------------------------------- headless sim
// TANTIVY.sim(n): n races, all four saddles ridden by the AI policy at varied
// skill. Verifies the race happened: reports finish rates and times.
function sim(n = 21, seed = 1234, trace = false) {
  const results = [];
  const traceLog = [];
  for (let race = 0; race < n; race++) {
    const rng = mulberry32(seed + race * 977);
    const w = { time: 0, rng, onBlown: null, onStumble: null };
    // mirror of the live field: player-as-bot, Marrow, Bracken, Dove
    const field = [
      makeRacerHeadless('A', 0, 1.0), makeRacerHeadless('B', -4.5, 0.9),
      makeRacerHeadless('C', 4.5, 0.75), makeRacerHeadless('D', -9, 0.68),
    ];
    const dt = 1 / 30;
    let guard = 0, lastLog = -1;
    while (field.some((r) => !r.finished) && guard++ < 30 * 300) {
      w.time += dt;
      for (const r of field) if (!r.finished) stepRacer(r, aiControls(r, w), dt, w);
      collideField(field);
      if (trace && race === 0 && Math.floor(w.time) > lastLog) {
        lastLog = Math.floor(w.time);
        traceLog.push({
          t: lastLog,
          f: field.map((r) => ({
            n: r.name, s: +r.s.toFixed(0), g: r.gait, v: +r.speed.toFixed(1),
            st: +r.stamina.toFixed(0), lat: +r.lateral.toFixed(1),
            air: +r.air.toFixed(2), stum: +r.stumble.toFixed(1), fin: r.finished,
          })),
        });
      }
    }
    results.push({
      timedOut: guard >= 30 * 300,
      field: field.map((r) => ({
        name: r.name, skill: r.skill, finished: r.finished,
        time: r.finished ? +r.finishTime.toFixed(1) : null,
      })),
    });
  }
  // aggregate
  const agg = {};
  for (const name of ['A', 'B', 'C', 'D']) {
    const runs = results.map((r) => r.field.find((f) => f.name === name));
    agg[name] = {
      skill: runs[0].skill,
      finishRate: +(runs.filter((r) => r.finished).length / n).toFixed(2),
      avgTime: +(runs.filter((r) => r.finished).reduce((a, r) => a + r.time, 0) /
        Math.max(1, runs.filter((r) => r.finished).length)).toFixed(1),
    };
  }
  return { races: n, routeLen: Math.round(R.len), agg, sample: results.slice(0, 3), trace: traceLog };
  function makeRacerHeadless(name, lateral, skill) {
    const st = routeAt(0);
    return {
      name, isPlayer: false, skill, lateralHome: lateral,
      paceMul: 0.965 + skill * 0.05, wasInBand: false,
      x: st.x + st.nx * lateral, z: st.z + st.nz * lateral,
      heading: Math.atan2(st.tz, st.tx),
      speed: 0, gait: 0, stamina: 100, s: 0, si: 0, lateral,
      air: 0, airT: 0, stumble: 0, blownLock: 0, shiftCd: 0,
      alive: true, finished: false, finishTime: 0, overBand: false, boost: 0,
      vis: { group: { position: {}, rotation: {}, traverse: () => {} }, legs: [], cape: { rotation: {} }, blob: { position: {}, scale: {}, visible: true } },
      animPhase: 0,
    };
  }
}

let autopilot = false;
document.addEventListener('click', (e) => {
  if (e.target && e.target.closest && e.target.closest('button')) sfxClick();
});

window.TANTIVY = {
  sim, world, routeLen: R.len,
  get racers() { return racers; },
  get state() { return state; },
  debug: {
    start: () => beginRace(),
    setAutopilot: (v) => { autopilot = !!v; },
    tick: (n = 1, dt = 1 / 30) => { for (let i = 0; i < n; i++) advance(dt); },
    shot: () => fetch('/shot', { method: 'POST', body: renderer.domElement.toDataURL('image/png') }).then(() => 'shot saved'),
    probe: () => {
      const g = terrainMesh.geometry;
      const p = g.attributes.position;
      let nan = 0, minY = 1e9, maxY = -1e9;
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i);
        if (Number.isNaN(y) || Number.isNaN(p.getX(i))) nan++;
        else { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      }
      g.computeBoundingSphere();
      renderer.render(scene, camera);
      return {
        verts: p.count, nan, minY: +minY.toFixed(1), maxY: +maxY.toFixed(1),
        bs: { c: g.boundingSphere.center.toArray().map((v) => +v.toFixed(0)), r: +g.boundingSphere.radius.toFixed(0) },
        tris: renderer.info.render.triangles, calls: renderer.info.render.calls,
        cam: camera.position.toArray().map((v) => +v.toFixed(0)),
        sceneKids: scene.children.length,
        sampleH: [groundHeight(60, 60), groundHeight(400, 260), groundHeight(700, 600)].map((v) => +v.toFixed(1)),
      };
    },
  },
};
spawnField();
console.log('TANTIVY ready — route ' + Math.round(R.len) + 'm');
