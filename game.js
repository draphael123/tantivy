// TANTIVY — isometric horse racer. Point-to-point flight to sanctuary,
// the Wild Hunt sweeping the road behind the field.
// Vertical slice: gait ladder + stamina economy + commitment cornering,
// terraced hills, brook jumps, 3 AI rivals, the Hunt.

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
  { s: 340, latMin: -9.5, latMax: 2.5 },
  { s: 700, latMin: -2.5, latMax: 9.5 },
];
const MUD = [
  { s: 262, lat: 4, r: 5 },
  { s: 487, lat: -3.5, r: 5.5 },
  { s: 642, lat: 3, r: 5 },
].map((m) => { const p = routeAt(m.s); return { ...m, x: p.x + p.nx * m.lat, z: p.z + p.nz * m.lat }; });
const GATES = [
  { s: 415, gapLat: -3.5, gapHalf: 3.0 },
  { s: 748, gapLat: 3.0, gapHalf: 3.0 },
];
// everything jumpable, sorted by route distance
const JUMPS = [
  ...BROOKS.map((b) => ({ s: b.s, width: b.width, latMin: -b.half, latMax: b.half, kind: 'brook', x: b.x, z: b.z, tx: b.tx, tz: b.tz, nx: b.nx, nz: b.nz })),
  ...LOGS.map((l) => { const p = routeAt(l.s); return { s: l.s, width: 1.5, latMin: l.latMin, latMax: l.latMax, kind: 'log', x: p.x, z: p.z, tx: p.tx, tz: p.tz, nx: p.nx, nz: p.nz }; }),
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
// rotatable iso: 4 yaw stops, 90° apart, smoothly interpolated
const CAM_R = Math.hypot(52, 52), CAM_H = 46;
let camYawIdx = 0, camYawCur = Math.PI / 4;
function rotateCam(dir) { camYawIdx += dir; }
function camOffset() {
  return new THREE.Vector3(Math.cos(camYawCur) * CAM_R, CAM_H, Math.sin(camYawCur) * CAM_R);
}

const sun = new THREE.DirectionalLight(0xffe6bd, 2.1);
sun.position.set(-90, 120, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 10; sun.shadow.camera.far = 420;
const SB = 95;
sun.shadow.camera.left = -SB; sun.shadow.camera.right = SB;
sun.shadow.camera.top = SB; sun.shadow.camera.bottom = -SB;
sun.shadow.bias = -0.0015;
scene.add(sun); scene.add(sun.target);
scene.add(new THREE.HemisphereLight(0xfff1cf, 0x9a7c4e, 0.85));

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
  const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.18, 1.25, 0.18), woodMat, spots.length);
  posts.castShadow = true;
  const rails = new THREE.InstancedMesh(new THREE.BoxGeometry(3.05, 0.09, 0.14), woodMat, spots.length * 2);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
  let pi = 0, ri = 0;
  for (const { s, side } of spots) {
    const rp = routeAt(s);
    const x = rp.x + rp.nx * 10 * side, z = rp.z + rp.nz * 10 * side;
    q.setFromAxisAngle(UP, -Math.atan2(rp.tz, rp.tx));
    m4.compose(v.set(x, groundHeight(x, z) + 0.62, z), q, one);
    posts.setMatrixAt(pi++, m4);
    const rm = routeAt(s + 1.5);
    const xm = rm.x + rm.nx * 10 * side, zm = rm.z + rm.nz * 10 * side;
    const ym = groundHeight(xm, zm);
    q.setFromAxisAngle(UP, -Math.atan2(rm.tz, rm.tx));
    for (const h of [0.55, 1.0]) {
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
    for (const h of [0.5, 0.95, 1.35]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.1, 0.14), woodMat);
      rail.position.y = h; rail.castShadow = true; grp.add(rail);
    }
    for (const e of [a, b]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.7, 0.22), woodMat);
      post.position.set(e - mid, 0.85, 0);
      post.castShadow = true;
      grp.add(post);
      // gold flags mark the gap posts
      if (Math.abs(Math.abs(e - g.gapLat) - g.gapHalf) < 0.2) {
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5),
          new THREE.MeshBasicMaterial({ color: 0xd9a13b, side: THREE.DoubleSide }));
        flag.position.set(e - mid, 1.95, 0);
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
function placeCrowd(s, count) {
  const rp = routeAt(s);
  const cols = [0x8a5a7a, 0x4e6b8a, 0x6b7d3a, 0xb5502a, 0x9a6b3f, 0xd9a13b];
  for (let i = 0; i < count; i++) {
    const side = worldRng() < 0.5 ? -1 : 1;
    const lat = (11.5 + worldRng() * 2.5) * side;
    const along = (worldRng() - 0.5) * 22;
    const p = routeAt(Math.max(2, s + along));
    const x = p.x + p.nx * lat, z = p.z + p.nz * lat;
    const grp = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.7, 3, 8),
      new THREE.MeshLambertMaterial({ color: cols[Math.floor(worldRng() * cols.length)] }));
    body.position.y = 0.85; body.castShadow = true; grp.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 7, 5),
      new THREE.MeshLambertMaterial({ color: 0xe8c49a }));
    head.position.y = 1.6; grp.add(head);
    grp.position.set(x, groundHeight(x, z), z);
    grp.rotation.y = -Math.atan2(p.nz * -side, p.nx * -side);
    scene.add(grp);
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
  scene.add(g);
  return { group: g, legs, cape, blob, body };
}

// ---------------------------------------------------------------- racers
const GAIT_NAMES = ['WALK', 'TROT', 'CANTER', 'GALLOP'];
const GAIT_SPEED = [1.8, 4.6, 7.4, 10.6];
const GAIT_TURN = [2.8, 2.3, 1.55, 0.9];
const GAIT_STAM = [7, 4, 0, -6];   // per second; positive = recover. Canter is the sustainable cruise.

function makeRacer(name, coat, riderCol, lateral, isPlayer, skill) {
  const st = routeAt(0);
  return {
    name, isPlayer, skill, lateralHome: lateral,
    paceMul: isPlayer ? 1 : 0.965 + skill * 0.05,
    x: st.x + st.nx * lateral, z: st.z + st.nz * lateral,
    heading: Math.atan2(st.tz, st.tx),
    speed: 0, gait: 1, stamina: 100,
    s: 0, si: 0, lateral,
    air: 0, airT: 0, stumble: 0, blownLock: 0, shiftCd: 0,
    alive: true, finished: false, finishTime: 0, capturedTime: 0, captureHold: 0,
    inDread: false, jumpQueued: false, liftY: 0, wasInBand: false,
    vis: makeHorse(coat, riderCol), animPhase: Math.random() * 6,
  };
}

let racers = [];
function spawnField() {
  for (const r of racers) { scene.remove(r.vis.group); scene.remove(r.vis.blob); }
  racers = [
    makeRacer('You', 0x8a5a2e, 0xb5502a, 0, true, 1),
    makeRacer('Marrow', 0x6e6e78, 0x4e6b8a, -4.5, false, 0.9),
    makeRacer('Bracken', 0x9a4f28, 0x6b7d3a, 4.5, false, 0.75),
    makeRacer('Dove', 0xe8e2d4, 0x8a5a7a, -9, false, 0.68),
  ];
}

// ---------------------------------------------------------------- the hunt
const hunt = { s: -70, speed: 0, group: null, light: null, mist: null, wisps: [] };
(function buildHunt() {
  const g = new THREE.Group();
  const dark = new THREE.MeshLambertMaterial({ color: 0x241d33 });
  for (let i = 0; i < 4; i++) {
    const h = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), dark);
    body.scale.set(1.6, 0.9, 0.75); body.position.y = 1.5; h.add(body);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.45, 1.3, 6), dark);
    neck.position.set(1.2, 2.2, 0); neck.rotation.z = -0.6; h.add(neck);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 6, 5), dark);
    head.scale.set(1.5, 0.8, 0.7); head.position.set(1.8, 2.7, 0); h.add(head);
    const rider = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.6, 6), dark);
    rider.position.set(0, 3.0, 0); h.add(rider);
    // ember eyes
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.09, 4, 4),
      new THREE.MeshBasicMaterial({ color: 0xb99df0 }));
    eye.position.set(2.15, 2.75, 0.18); h.add(eye);
    const eye2 = eye.clone(); eye2.position.z = -0.18; h.add(eye2);
    h.position.set((i % 2) * 4 - 2, 0, Math.floor(i / 2) * 5 - 2.5);
    h.userData.bob = i * 1.7;
    g.add(h);
  }
  const mist = new THREE.Mesh(new THREE.CircleGeometry(16, 24),
    new THREE.MeshBasicMaterial({ color: 0x2c2350, transparent: true, opacity: 0.55, depthWrite: false }));
  mist.rotation.x = -Math.PI / 2; mist.position.y = 0.3;
  g.add(mist);
  for (let i = 0; i < 10; i++) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 3.2),
      new THREE.MeshBasicMaterial({ color: 0x8a75c9, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    w.position.set((Math.random() - 0.5) * 20, 2, (Math.random() - 0.5) * 20);
    w.userData.ph = Math.random() * 6;
    g.add(w); hunt.wisps.push(w);
  }
  const light = new THREE.PointLight(0x6b57a8, 160, 70);
  light.position.y = 5;
  g.add(light);
  hunt.group = g; hunt.light = light; hunt.mist = mist;
  scene.add(g);
})();

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
  const gaitMax = (r.blownLock > 0) ? 1 : 3;
  if (c.gaitUp && r.shiftCd <= 0 && r.gait < gaitMax) { r.gait++; r.shiftCd = 0.3; }
  if (c.gaitDown && r.shiftCd <= 0 && r.gait > 0) { r.gait--; r.shiftCd = 0.18; }
  if (r.gait > gaitMax) r.gait = gaitMax;

  // stamina
  const offPath = Math.abs(r.lateral) > 10;
  let stamRate = GAIT_STAM[r.gait];
  if (r.gait === 3 && slope > 0) stamRate -= slope * 34;      // climbing at gallop is ruinous
  if (offPath && stamRate < 0) stamRate *= 1.25;
  if (inMud && r.speed > 1) stamRate -= 3;                    // heavy going
  if (r.inDread) { stamRate = stamRate > 0 ? 0 : stamRate * 2.5; }
  r.stamina = Math.min(100, r.stamina + stamRate * dt);
  if (r.stamina <= 0 && r.blownLock <= 0) {
    r.stamina = 0; r.blownLock = 3; r.gait = Math.min(r.gait, 1);
    if (r.isPlayer) world.onBlown && world.onBlown();
  }
  if (r.blownLock > 0) {
    r.blownLock -= dt;
    if (r.blownLock <= 0 && r.stamina < 25) r.blownLock = 0.5; // stays locked till 25
  }

  // jumping
  if (r.air > 0) {
    r.airT += dt;
    if (r.airT >= r.air) { r.air = 0; r.liftY = 0; }
    else {
      const t = r.airT / r.air;
      r.liftY = 4 * 2.2 * t * (1 - t);   // 2.2m apex arc
    }
  } else if (c.jump && r.gait >= 2 && r.stumble <= 0) {
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
  const accel = target > r.speed ? 3.2 : 6.0;
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

  // desired gait — a kick-and-recover rhythm paced against the Hunt's gap
  const gap = r.s - (world.huntS !== undefined ? world.huntS : -999);
  let want = 2;
  const kickStam = 12 + (1 - r.skill) * 10;
  const uphill = slope > 0.04;
  if (gap > 110 && r.stamina < 55) want = 1;                          // comfortable: rebuild
  if (slope < -0.045 && r.stamina > 15) want = 3;                     // downhill is cheap speed
  if (slope < 0.02 && r.stamina > 70 && gap > 60) want = 3;           // spend surplus on the flat
  if (finalStretch && r.stamina > kickStam) want = 3;
  if (r.inDread && r.stamina > 4) want = 3;
  if (uphill && want === 3 && !finalStretch) want = 2;   // never gallop a climb — it's ruinous
  if (!r.inDread && r.stamina < 16 + (1 - r.skill) * 8) want = Math.min(want, 1);
  if (r.blownLock > 0) want = 1;
  // don't gallop into the two hard bends unless skilled
  if (r.gait !== want) { if (want > r.gait) c.gaitUp = true; else c.gaitDown = true; }

  // steering: lookahead point with a lateral target that respects gates and mud
  let latTarget = r.lateralHome * 0.5;
  const gate = GATES.find((g) => g.s > r.s - 2 && g.s - r.s < 45);
  if (gate) latTarget = gate.gapLat;
  const mud = MUD.find((m) => m.s > r.s && m.s - r.s < 30 && Math.abs(latTarget - m.lat) < m.r + 1.5);
  if (mud) latTarget = mud.lat > 0 ? mud.lat - (mud.r + 2.5) : mud.lat + (mud.r + 2.5);
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
    if (j.s - r.s < 26 && r.gait < 2 && r.blownLock <= 0) { c.gaitUp = true; }
  }
  return c;
}

// ---------------------------------------------------------------- hunt logic
// One core used by the live race AND the headless sim — mirrors drift.
function huntGrade(s) {
  const hp = routeAt(Math.max(0, s));
  const slope = slopeAlong(hp.x, hp.z, hp.tx, hp.tz);
  return Math.min(1.3, Math.max(0.5, 1 - slope * 2.4));
}
function stepHuntCore(h, field, time, dt, onCapture) {
  if (time < 4) { h.speed = 0; return; }  // a held breath after the start
  let base = 5.8 + Math.min(1, time / 150) * 1.3;   // 5.8 -> 7.1: below any canter, far above a blown trot
  // rubber band on the LAST living racer
  let lastS = Infinity;
  for (const r of field) if (r.alive && !r.finished) lastS = Math.min(lastS, r.s);
  if (lastS === Infinity) lastS = R.len;
  const gap = lastS - h.s;
  if (gap > 150) base *= 1.35;
  else if (gap < 30 && time < 60) base *= 0.9;
  base *= huntGrade(h.s);   // the Hunt rides the same ground
  h.speed = base;
  h.s += base * dt;

  // dread + capture
  for (const r of field) {
    if (!r.alive || r.finished) continue;
    const g = r.s - h.s;
    r.inDread = g < 40;
    if (g < 7) {
      r.captureHold += dt;
      if (r.captureHold > 2) {
        r.alive = false; r.capturedTime = time;
        onCapture && onCapture(r);
      }
    } else r.captureHold = Math.max(0, r.captureHold - dt * 2);
  }
}
function stepHunt(world, dt) {
  stepHuntCore(hunt, racers, world.time, dt, (r) => {
    if (r.isPlayer) world.onCaught && world.onCaught();
    else world.onRivalTaken && world.onRivalTaken(r);
  });
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
  gaitUp: 'KeyW', gaitDown: 'KeyS', left: 'KeyA', right: 'KeyD',
  jump: 'Space', camL: 'KeyQ', camR: 'KeyE', pause: 'Escape',
};
// arrows (and P for pause) always work as a fallback
const FALLBACK_KEYS = { gaitUp: 'ArrowUp', gaitDown: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pause: 'KeyP' };
const ACTION_LABELS = {
  gaitUp: 'Gait up', gaitDown: 'Gait down', left: 'Steer left', right: 'Steer right',
  jump: 'Jump', camL: 'Rotate camera ⟲', camR: 'Rotate camera ⟳', pause: 'Pause',
};
let KEYS = { ...DEFAULT_KEYS };
try { Object.assign(KEYS, JSON.parse(localStorage.getItem('tantivy.keys') || '{}')); } catch (e) { /* fresh */ }
function saveKeys() { try { localStorage.setItem('tantivy.keys', JSON.stringify(KEYS)); } catch (e) {} }
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
  if (e.code === 'KeyR' && state !== 'home') restart();
  if (e.code === 'Enter' && state === 'home') beginRace();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });

let prevUp = false, prevDown = false, prevJump = false;
function readPlayerControls() {
  const up = isDown('gaitUp'), down = isDown('gaitDown'), jump = isDown('jump');
  const c = {
    steer: (isDown('left') ? -1 : 0) + (isDown('right') ? 1 : 0),
    gaitUp: up && !prevUp, gaitDown: down && !prevDown, jump: jump && !prevJump,
  };
  prevUp = up; prevDown = down; prevJump = jump;
  return c;
}

// ---------------------------------------------------------------- HUD
const el = (id) => document.getElementById(id);
const hud = el('hud'), placard = el('placard'), gaitname = el('gaitname'),
  stambar = el('stambar'), blownEl = el('blown'), huntgap = el('huntgap'),
  huntbox = el('huntbox'), msgEl = el('msg'), bigmsg = el('bigmsg'),
  vignette = el('vignette');
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
  placard.innerHTML = `<span class="pos">${ordinal(pos)}</span> &nbsp;<span class="time">${fmtTime(world.time)}</span>`;
  gaitname.textContent = GAIT_NAMES[p.gait] + (p.air > 0 ? ' — AIRBORNE' : '');
  pips.forEach((pip, i) => pip.classList.toggle('lit', i <= p.gait));
  stambar.style.width = p.stamina + '%';
  stambar.className = p.stamina < 20 ? 'crit' : (p.stamina < 45 ? 'low' : '');
  stambar.id = 'stambar';
  blownEl.textContent = p.blownLock > 0 && p.stamina < 25 ? 'BLOWN — the horse needs breath' : '';
  const gap = Math.max(0, Math.round(p.s - hunt.s));
  huntgap.textContent = (p.alive && gap < 500) ? gap + 'm' : '—';
  huntbox.classList.toggle('close', p.inDread && p.alive);
  vignette.style.opacity = p.inDread && p.alive ? 1 : 0;
  if (msgTimer > 0) { msgTimer -= world.dt; if (msgTimer <= 0) msgEl.textContent = ''; }
  // jump prompt
  const j = nextJump(p.s, p.lateral);
  if (j && p.air <= 0 && j.s - p.s < 30 && j.s - p.s > 0 && msgTimer <= 0) {
    msgEl.textContent = j.s - p.s < p.speed * 0.55 + 3 ? 'JUMP!'
      : (j.kind === 'log' ? 'Log ahead…' : 'Brook ahead…');
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
  v.legs.forEach((leg, i) => {
    leg.rotation.z = Math.sin(r.animPhase + i * ((i < 2) ? Math.PI : Math.PI * 0.5)) * amp * 1.4;
  });
  v.group.position.y += Math.abs(Math.sin(r.animPhase)) * amp * 0.35;
  v.cape.rotation.x = 0.35 + Math.min(0.9, r.speed / 12);
  v.blob.position.set(r.x, gy + 0.08, r.z);
  const sh = 1 - Math.min(0.6, r.liftY / 4);
  v.blob.scale.set(sh, sh, sh);
  if (!r.alive) {
    // spirited away: lift and fade
    v.group.position.y += (world.time - r.capturedTime) * 3;
    v.group.rotation.y += dt * 2;
    v.group.traverse((o) => {
      if (o.material) { o.material.transparent = true; o.material.opacity = Math.max(0, 1 - (world.time - r.capturedTime) * 0.4); }
    });
    v.blob.visible = false;
  }
}
function updateHuntVisual(dt) {
  const hp = routeAt(Math.max(0, hunt.s));
  let hx = hp.x, hz = hp.z;
  if (hunt.s < 0) { hx += hp.tx * hunt.s; hz += hp.tz * hunt.s; } // extrapolate behind the start
  const gy = groundHeight(hx, hz);
  hunt.group.position.set(hx, gy, hz);
  hunt.group.rotation.y = -Math.atan2(hp.tz, hp.tx);
  const t = world.time;
  hunt.group.children.forEach((ch) => {
    if (ch.userData.bob !== undefined) {
      ch.position.y = Math.abs(Math.sin(t * 6 + ch.userData.bob)) * 0.5;
    }
  });
  for (const w of hunt.wisps) {
    w.position.y = 2 + Math.sin(t * 1.4 + w.userData.ph) * 1.2;
    w.rotation.y = t * 0.7 + w.userData.ph;
    w.material.opacity = 0.22 + 0.18 * Math.sin(t * 2 + w.userData.ph * 3);
  }
  hunt.mist.material.opacity = 0.32 + 0.1 * Math.sin(t * 1.8);
  hunt.light.intensity = 140 + Math.sin(t * 3) * 40;
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
  const lead = 7;
  const tx = p.x + Math.cos(p.heading) * lead;
  const tz = p.z + Math.sin(p.heading) * lead;
  const ty = groundHeight(p.x, p.z);
  if (!camInit) { camTarget.set(tx, ty, tz); camInit = true; }
  const k = 1 - Math.exp(-dt * 3.2);
  camTarget.x += (tx - camTarget.x) * k;
  camTarget.y += (ty - camTarget.y) * k;
  camTarget.z += (tz - camTarget.z) * k;
  const wantYaw = Math.PI / 4 + camYawIdx * Math.PI / 2;
  camYawCur += (wantYaw - camYawCur) * Math.min(1, dt * 6);
  camera.position.copy(camTarget).add(camOffset());
  camera.lookAt(camTarget);
  sun.position.set(camTarget.x - 90, 120, camTarget.z + 40);
  sun.target.position.copy(camTarget);
}

// ---------------------------------------------------------------- race flow
let state = 'home';
let tut = null;
const world = {
  time: 0, dt: 0, rng: mulberry32(Date.now() & 0xffff),
  onBlown: () => flash('BLOWN! Drop to trot and breathe', 2.5),
  onStumble: () => flash('Stumbled!', 2),
  onCaught: () => { if (state === 'tut') tutCaught(); else endRace(true); },
  onRivalTaken: (r) => flash(`${r.name} was taken by the Hunt…`, 3),
};
let countdown = 0;

function hideOverlays() { for (const id of ['home', 'settings', 'pause', 'results']) el(id).classList.remove('on'); }
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
}
function togglePause() {
  paused = !paused;
  el('pause').classList.toggle('on', paused);
}

function restart() {
  hideOverlays();
  paused = false;
  el('tutbox').classList.remove('on');
  spawnField();
  resetHazards();
  hunt.s = -70;
  world.time = 0;
  camInit = false;
  tut = null;
  state = 'count';
  countdown = 3.0;
  hud.classList.add('on');
  bigmsg.textContent = '3';
}
function beginRace() { restart(); }

// ---------------------------------------------------------------- settings UI
function openSettings() { el('home').classList.remove('on'); el('settings').classList.add('on'); buildKeyRows(); }
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
    `${keyName(KEYS.gaitUp)}/${keyName(KEYS.gaitDown)} gaits · ${keyName(KEYS.left)}/${keyName(KEYS.right)} steer · ` +
    `${keyName(KEYS.jump)} jump · ${keyName(KEYS.camL)}/${keyName(KEYS.camR)} camera · ${keyName(KEYS.pause)} pause`;
}

el('ridebtn').addEventListener('click', beginRace);
el('tutbtn').addEventListener('click', beginTutorial);
el('setbtn').addEventListener('click', openSettings);
el('setback').addEventListener('click', closeSettings);
el('resetkeys').addEventListener('click', () => { KEYS = { ...DEFAULT_KEYS }; saveKeys(); buildKeyRows(); });
el('againbtn').addEventListener('click', beginRace);
el('resmenubtn').addEventListener('click', gotoHome);
el('resumebtn').addEventListener('click', togglePause);
el('prestartbtn').addEventListener('click', restart);
el('pmenubtn').addEventListener('click', gotoHome);
updateHomeHint();

// ---------------------------------------------------------------- tutorial (guided ride)
function spawnSolo() {
  for (const r of racers) { scene.remove(r.vis.group); scene.remove(r.vis.blob); }
  racers = [makeRacer('You', 0x8a5a2e, 0xb5502a, 0, true, 1)];
}
function tutMsg(html) { const t = el('tutbox'); t.innerHTML = html; t.classList.add('on'); }
function beginTutorial() {
  hideOverlays();
  paused = false;
  spawnSolo();
  resetHazards();
  hunt.s = -2000;
  world.time = 0;
  camInit = false;
  state = 'tut';
  tut = { stage: 0, t: 0, gallopHeld: 0, dreadT: 0 };
  hud.classList.add('on');
  bigmsg.textContent = '';
  tutMsg(`The paddock road. Shift up through the gaits: press <kbd>${keyName(KEYS.gaitUp)}</kbd> until you reach <b>CANTER</b>.`);
}
function tutCaught() {
  tutMsg('The Hunt swept you up — in a true race, that is the end of your ride.');
  tut.stage = 99; tut.t = 0;
}
function tutStep(dt) {
  const p = racers[0];
  tut.t += dt;
  switch (tut.stage) {
    case 0:
      if (p.gait >= 2) {
        tut.stage = 1;
        tutMsg(`Steer with <kbd>${keyName(KEYS.left)}</kbd>/<kbd>${keyName(KEYS.right)}</kbd> and follow the road. The faster the gait, the wider your horse turns.`);
      }
      break;
    case 1:
      if (p.s > 150) {
        tut.stage = 2;
        tutMsg(`Now <b>GALLOP</b> (<kbd>${keyName(KEYS.gaitUp)}</kbd>). Watch the stamina bar — gallop is borrowed speed.`);
      }
      break;
    case 2:
      if (p.gait === 3) tut.gallopHeld += dt;
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
        tut.stage = 8; tut.dreadT = 0;
        hunt.s = p.s - 90;
        tutMsg('<b>The horns sound.</b> The Hunt rides behind you — inside its dread your stamina bleeds and will not return. <b>Gallop clear!</b>');
        flash('The horns sound behind you…', 3);
      }
      break;
    case 8: {
      // scripted hunt: closes to ~45m and hangs there — the player FEELS dread without real danger
      const want = p.s - 42;
      hunt.s += Math.min(10, Math.max(4.5, (want - hunt.s) * 0.6)) * dt;
      hunt.speed = 8;
      const gap = p.s - hunt.s;
      p.inDread = gap < 40;
      if (p.inDread) tut.dreadT += dt;
      if (gap < 7) { tutCaught(); break; }
      if (tut.dreadT > 6 && gap > 50) {
        tut.stage = 9; tut.t = 0; p.inDread = false;
        tutMsg('<b>Well ridden.</b> Reach the bells before the Hunt reaches you — and never be last when the horns sound.');
      }
      break;
    }
    case 9:
      if (tut.t > 5) gotoHome();
      break;
    case 99:
      if (tut.t > 4) gotoHome();
      break;
  }
}

function endRace(caught) {
  state = 'done';
  // fast-forward the rest of the field headlessly so results are complete
  let guard = 0;
  const dt = 1 / 30;
  while (racers.some((r) => r.alive && !r.finished) && guard++ < 30 * 240) {
    world.time += dt;
    world.huntS = hunt.s;
    for (const r of racers) if (!r.isPlayer || (!caught && !r.finished)) {
      if (r.alive && !r.finished) stepRacer(r, aiControls(r, world), dt, world);
    }
    collideField(racers);
    // player, if caught, is gone; if finished, skip
    stepHunt(world, dt);
    if (caught) {
      const p = racers[0];
      if (p.alive && !p.finished) { p.alive = false; p.capturedTime = world.time; }
    }
  }
  showResults(caught);
}
function showResults(caught) {
  const p = racers[0];
  const ranked = [...racers].sort((a, b) => {
    const ka = a.finished ? a.finishTime : 1e6 + (a.alive ? -a.s : 1e5 - a.capturedTime);
    const kb = b.finished ? b.finishTime : 1e6 + (b.alive ? -b.s : 1e5 - b.capturedTime);
    return ka - kb;
  });
  el('resh').textContent = caught ? 'Taken by the Hunt' : (ranked[0] === p ? 'First to the Bells!' : 'Sanctuary');
  el('ressub').textContent = caught
    ? 'The horns found you on the road.'
    : `You reached sanctuary in ${fmtTime(p.finishTime)}.`;
  const rows = ranked.map((r, i) => {
    const res = r.finished ? fmtTime(r.finishTime) : (r.alive ? 'on the road' : '☠ taken');
    return `<tr><td>${i + 1}.</td><td>${r.name}${r.isPlayer ? ' ⭑' : ''}</td><td class="t">${res}</td></tr>`;
  }).join('');
  el('restable').innerHTML = rows;
  el('results').classList.add('on');
  hud.classList.remove('on');
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
    bigmsg.textContent = String(Math.max(1, Math.ceil(countdown)));
    if (countdown <= 0) {
      state = 'run';
      bigmsg.textContent = 'RIDE!';
      setTimeout(() => { if (bigmsg.textContent === 'RIDE!') bigmsg.textContent = ''; }, 900);
      flash('The horns sound behind you…', 3);
    }
  }

  if (state === 'run') {
    world.time += dt;
    world.huntS = hunt.s;
    const pc = autopilot ? aiControls(racers[0], world) : readPlayerControls();
    stepRacer(racers[0], pc, dt, world);
    for (let i = 1; i < racers.length; i++) {
      stepRacer(racers[i], aiControls(racers[i], world), dt, world);
    }
    collideField(racers);
    stepDeer(dt);
    stepHunt(world, dt);
    const p = racers[0];
    if (p.finished) endRace(false);
  }

  if (state === 'tut') {
    world.time += dt;
    world.huntS = hunt.s;
    stepRacer(racers[0], readPlayerControls(), dt, world);
    stepDeer(dt);
    tutStep(dt);
  }

  if (state === 'run' || state === 'count' || state === 'done' || state === 'tut') {
    for (const r of racers) updateRacerVisual(r, dt);
    updateHuntVisual(dt);
    updateCamera(dt);
    occluderFade(dt);
    updateDeerVisuals(dt);
    if (state !== 'done') updateHUD(world);
  } else {
    // home menu: slow orbit over the start
    const st = routeAt(30);
    camTarget.set(st.x, groundHeight(st.x, st.z), st.z);
    const t = performance.now() / 1000;
    camera.position.set(st.x + Math.cos(t * 0.1) * 60, 62, st.z + Math.sin(t * 0.1) * 60);
    camera.lookAt(camTarget);
  }
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
// skill. Verifies the fight happened: reports captures, finish times, hunt reach.
function sim(n = 21, seed = 1234, trace = false) {
  const results = [];
  const traceLog = [];
  for (let race = 0; race < n; race++) {
    const rng = mulberry32(seed + race * 977);
    const w = { time: 0, rng, onBlown: null, onStumble: null, onCaught: null, onRivalTaken: null };
    // mirror of the live field: player-as-bot, Marrow, Bracken, Dove
    const field = [
      makeRacerHeadless('A', 0, 1.0), makeRacerHeadless('B', -4.5, 0.9),
      makeRacerHeadless('C', 4.5, 0.75), makeRacerHeadless('D', -9, 0.68),
    ];
    const h = { s: -70 };
    const dt = 1 / 30;
    let guard = 0, lastLog = -1;
    while (field.some((r) => r.alive && !r.finished) && guard++ < 30 * 300) {
      w.time += dt;
      w.huntS = h.s;
      for (const r of field) if (r.alive && !r.finished) stepRacer(r, aiControls(r, w), dt, w);
      collideField(field);
      stepHuntCore(h, field, w.time, dt, null);
      for (const r of field) if (r.inDread) r.maxDread = Math.max(r.maxDread || 0, 1);
      if (trace && race === 0 && Math.floor(w.time) > lastLog) {
        lastLog = Math.floor(w.time);
        traceLog.push({
          t: lastLog, hunt: +h.s.toFixed(0),
          f: field.map((r) => ({
            n: r.name, s: +r.s.toFixed(0), g: r.gait, v: +r.speed.toFixed(1),
            st: +r.stamina.toFixed(0), lat: +r.lateral.toFixed(1),
            air: +r.air.toFixed(2), stum: +r.stumble.toFixed(1),
            alive: r.alive, fin: r.finished,
          })),
        });
      }
    }
    results.push({
      timedOut: guard >= 30 * 300,
      huntS: Math.round(h.s),
      field: field.map((r) => ({
        name: r.name, skill: r.skill, finished: r.finished,
        time: r.finished ? +r.finishTime.toFixed(1) : null,
        captured: !r.alive, at: r.alive ? null : Math.round(r.s),
        maxDread: r.maxDread,
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
      capturedRate: +(runs.filter((r) => r.captured).length / n).toFixed(2),
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
      speed: 0, gait: 1, stamina: 100, s: 0, si: 0, lateral,
      air: 0, airT: 0, stumble: 0, blownLock: 0, shiftCd: 0,
      alive: true, finished: false, finishTime: 0, capturedTime: 0, captureHold: 0,
      inDread: false, maxDread: 0,
      vis: { group: { position: {}, rotation: {}, traverse: () => {} }, legs: [], cape: { rotation: {} }, blob: { position: {}, scale: {}, visible: true } },
      animPhase: 0,
    };
  }
}

let autopilot = false;
window.TANTIVY = {
  sim, world, routeLen: R.len,
  get racers() { return racers; }, get hunt() { return hunt; },
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
