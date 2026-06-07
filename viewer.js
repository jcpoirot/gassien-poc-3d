// =============================================================================
// Gassien — Viewer 3D (POC)
// Moteur Three.js de visualisation/validation des compositions.
// Monolithique volontairement (cf. plan) ; sera découpé en modules pour React.
// Source de vérité des constantes : CLAUDE.md
// =============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// -----------------------------------------------------------------------------
// Constantes (validées en session — cf. CLAUDE.md)
// -----------------------------------------------------------------------------
const S = 0.0025; // m / unité configurateur (constante unique validée)
const TOL = 0.002; // tolérance d'audit bbox : 2 mm

// type -> asset + métadonnées validées
// `offset` = décalage de placement EN MILLIMÈTRES (x: droite+, y: haut+, z: avant+),
// appliqué APRÈS le calcul worldPosition. Origine .glb laissée telle quelle (coin
// gauche-bas-arrière) ; on corrige le placement ici, type par type. Se calibre
// visuellement via le panneau « Réglage décalage / grille » puis « Copier la table ».
const CATALOG = {
  gridGF: {
    glb: 'glb/gridGF.glb',
    slots: ['metal_structure'],
    anchor: 'bottom',
    depthLayer: 0,
    offset: { x: 0, y: 0, z: 0 },
    expect: { sizeX: 0.800, sizeY: 0.770, sizeZ: 0.012 },
  },
  board40x15: {
    glb: 'glb/board40x15.glb',
    slots: ['wood', 'metal_structure', 'metal_hardware'],
    anchor: 'bottom',
    depthLayer: 0.012,
    offset: { x: 0, y: 0, z: 0 },
    expect: { sizeX: 0.400, sizeY: 0.121, sizeZ: 0.161 },
  },
};

// Décalages "live" (mm). Seed depuis le CATALOG puis ÉCRASÉ par offset.json (init).
// offset.json est la source de vérité persistante (tous les composants y figurent).
const OFFSETS = {};
for (const [type, def] of Object.entries(CATALOG)) {
  OFFSETS[type] = { ...(def.offset || { x: 0, y: 0, z: 0 }) };
}

function ensureOffset(type) {
  if (!OFFSETS[type]) OFFSETS[type] = { x: 0, y: 0, z: 0 };
  return OFFSETS[type];
}

// Charge offset.json et fusionne dans OFFSETS (clés "_*" ignorées).
async function loadOffsets() {
  try {
    const res = await fetch('./offset.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    for (const [type, o] of Object.entries(data)) {
      if (type.startsWith('_') || !o || typeof o !== 'object') continue;
      OFFSETS[type] = { x: +o.x || 0, y: +o.y || 0, z: +o.z || 0 };
    }
  } catch (e) {
    console.warn('offset.json non chargé (valeurs par défaut utilisées) :', e.message);
  }
}

// --- Convention de nommage des matières ---
// STRATÉGIE : dans SketchUp, le NOM du matériau == son RÔLE (couleur plate, sans
// texture). Le moteur pilote la finition au runtime selon ce nom. Pas de table de
// traduction à maintenir pour les nouveaux glb : nom == rôle (identité).
const CANONICAL_ROLES = [
  'wood_face',        // faces dessus/dessous (placage contreplaqué, plateau)
  'wood_edge',        // chants (contreplaqué)
  'wood_raw',         // bois brut (ex. tubes hêtre)
  'wood',             // bois massif générique (toléré)
  'metal_structure',  // structure métal peinte (pilotable)
  'metal_hardware',   // visserie — inox FIGÉ
];
const WOOD_ROLES = ['wood_face', 'wood_edge', 'wood_raw', 'wood'];

// Alias hérités : anciens noms (apparence) des glb actuels -> rôle. À RENOMMER
// dans SketchUp ; gardés pour que les glb existants marchent pendant la transition.
const LEGACY_ALIASES = {
  'GASSIEN - Solid Oak': 'wood_face',
  '[Color M09]': 'metal_structure',
  '*1': 'metal_structure',
  '[Steel Brushed Stainless]': 'metal_hardware',
};

// Résout un nom de matériau -> rôle (canonique d'abord, puis alias hérité).
function roleOfMaterial(name) {
  if (CANONICAL_ROLES.includes(name)) return name;
  return LEGACY_ALIASES[name] || null;
}

// Couleur de debug par rôle (vue Audit colorée par slot)
const ROLE_DEBUG_COLOR = {
  wood: 0xc98a3c,
  wood_face: 0xc98a3c,
  wood_edge: 0x8a5a2b,
  wood_raw: 0xdcb579,
  metal_structure: 0x5b9bd5,
  metal_hardware: 0xc0c0c0,
  _none: 0xff3b6b, // matériau sans rôle => alerte visuelle
};

// --- Finitions (set fixe) ---
// Bois : finitions "texture" (maps par rôle face/edge/raw) ou "couleur" (unie).
//   wood_raw utilise toujours wood_raw.jpg ; les rôles inconnus retombent sur wood_face.
// params (par essence) : { repeat, brightness, roughness, envIntensity } — réglés via sliders.
const WOOD_FINISHES = {
  oak:   { label: 'Chêne Massif', maps: { wood_face: 'oak_face.jpg',   wood_edge: 'oak_edge.jpg',   wood_raw: 'wood_raw.jpg' }, params: { repeat: 3.3, brightness: 0.45, roughness: 0.50, envIntensity: 0.4 } },
  birch: { label: 'Bouleau CP',   maps: { wood_face: 'birch_face.jpg', wood_edge: 'birch_edge.jpg', wood_raw: 'wood_raw.jpg' }, params: { repeat: 5.9, brightness: 0.45, roughness: 0.25, envIntensity: 0.4 } },
  black: { label: 'Noir',         color: 0x111111, params: { repeat: 1, brightness: 1, roughness: 0.50, envIntensity: 1 } },
  white: { label: 'Blanc',        color: 0xeaeaea, params: { repeat: 1, brightness: 1, roughness: 0.60, envIntensity: 1 } },
};
const DEFAULT_WOOD_PARAMS = { repeat: 1, brightness: 1, roughness: 0.6, envIntensity: 1 };
const METAL_FINISHES = {
  black: { label: 'Noir',   color: 0x141414, metalness: 1, roughness: 0.42 },
  white: { label: 'Blanc',  color: 0xf0f0f0, metalness: 0, roughness: 0.45 }, // peinture = diélectrique
  brass: { label: 'Laiton', color: 0xc2a86e, metalness: 0.85, roughness: 0.62 }, // satiné/mat (cf. réf.)
};

// Toutes les images bois à précharger à l'init.
const WOOD_TEXTURE_FILES = ['oak_face.jpg', 'oak_edge.jpg', 'birch_face.jpg', 'birch_edge.jpg', 'wood_raw.jpg'];

// Finitions "actives" (def objet). Initialisées depuis le JSON, modifiées par l'UI.
//  bois : { maps:{role->file}, roughness } | { color, roughness }
//  métal: { color, metalness, roughness, label }
let woodFinish = { ...WOOD_FINISHES.black };
let metalFinish = { ...METAL_FINISHES.black };

// Cache de textures (path -> THREE.Texture), config albédo correcte.
const texCache = new Map();
const texLoader = new THREE.TextureLoader();
function getTexture(path) {
  if (texCache.has(path)) return texCache.get(path);
  const tex = texLoader.load(path, undefined, undefined, () => console.warn('Texture introuvable :', path));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texCache.set(path, tex);
  return tex;
}

// Précharge les textures bois à l'initialisation.
function preloadTextures() {
  for (const f of WOOD_TEXTURE_FILES) getTexture('textures/' + f);
}

// Applique la finition bois courante à un matériau cloné, selon le rôle.
function applyWoodFinish(m, role) {
  const p = woodFinish.params || DEFAULT_WOOD_PARAMS;
  m.metalness = 0;
  m.roughness = p.roughness;
  m.envMapIntensity = p.envIntensity;
  if (woodFinish.maps) {
    const file = woodFinish.maps[role] || woodFinish.maps.wood_face;
    const tex = getTexture('textures/' + file);
    tex.repeat.set(p.repeat, p.repeat);
    tex.needsUpdate = true;
    m.map = tex;
    m.color.setScalar(p.brightness); // multiplie l'albédo (assombrit si <1)
  } else {
    m.map = null;
    m.color.set(woodFinish.color); // finition couleur unie : pas de luminosité texture
  }
}

function applyMetalFinish(m) {
  m.map = null;
  m.color.set(metalFinish.color);
  m.metalness = metalFinish.metalness ?? 1;
  m.roughness = metalFinish.roughness ?? 0.4;
}

// =============================================================================
// Scène / renderer
// =============================================================================
const canvas = document.getElementById('canvas');
const stage = document.getElementById('stage');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true, // requis pour le snapshot PNG
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0); // fond transparent
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();

// Environnement studio (PMREM) pour éclairage diffus + reflets métal
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
camera.position.set(0.9, 0.7, 1.4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

// Lumière d'appoint douce (l'essentiel vient de l'environnement)
const key = new THREE.DirectionalLight(0xffffff, 1.2);
key.position.set(1.5, 2, 2.5);
scene.add(key);
scene.add(new THREE.AmbientLight(0xffffff, 0.15));

// -----------------------------------------------------------------------------
// Helpers de repère (axes monde, plan du mur Z=0, sol)
// -----------------------------------------------------------------------------
const helpers = new THREE.Group();
scene.add(helpers);

const axes = new THREE.AxesHelper(0.25); // rouge=X, vert=Y, bleu=Z
helpers.add(axes);

// Plan du mur à Z = 0 (face arrière de la composition)
const wallGeo = new THREE.PlaneGeometry(2, 2);
const wallMat = new THREE.MeshBasicMaterial({
  color: 0x6ab0ff, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false,
});
const wall = new THREE.Mesh(wallGeo, wallMat);
wall.position.set(0, 0.5, 0); // centré, posé devant le repère
helpers.add(wall);

// Grille de sol (plan XZ à Y=0)
const grid = new THREE.GridHelper(2, 20, 0x4a5560, 0x33373d);
grid.position.y = 0;
helpers.add(grid);

let helpersVisible = true;

// =============================================================================
// Chargement GLB (cache par type + clone)
// =============================================================================
const loader = new GLTFLoader();
const glbCache = new Map(); // type -> gltf.scene (template, non ajouté à la scène)

async function loadTemplate(type) {
  if (glbCache.has(type)) return glbCache.get(type);
  const def = CATALOG[type];
  if (!def) throw new Error(`Type inconnu dans le CATALOG : ${type}`);
  const gltf = await loader.loadAsync(def.glb);
  glbCache.set(type, gltf.scene);
  return gltf.scene;
}

function instanceOf(type) {
  // clone profond pour les composants répétés ; matériaux clonés à l'application finition
  return glbCache.get(type).clone(true);
}

// Groupe contenant tout ce qui est "contenu" (à vider entre les rendus)
const content = new THREE.Group();
scene.add(content);

function clearContent() {
  // NB : les clones partagent géométries ET matériaux avec le template en cache
  // (THREE clone() copie par référence). On ne dispose donc PAS ici — sinon on
  // casserait le template réutilisé. Seuls les matériaux clonés en finition et
  // les géométries de marqueurs/box-helper fuient légèrement (acceptable POC).
  content.clear();
}

// =============================================================================
// Mesures & rôles
// =============================================================================
function measure(object3d) {
  const box = new THREE.Box3().setFromObject(object3d);
  const size = new THREE.Vector3();
  box.getSize(size);
  return { box, size };
}

// Statut de conformité d'un nom de matériau vis-à-vis de la convention.
//  'ok'      : nom == rôle canonique
//  'rename'  : alias hérité reconnu -> à renommer en <role>
//  'default' : nom par défaut SketchUp (*1, Material, sans nom) -> à nommer
//  'unknown' : nom inconnu -> à nommer/mapper
function namingStatus(name) {
  if (CANONICAL_ROLES.includes(name)) return 'ok';
  if (LEGACY_ALIASES[name]) return 'rename';
  if (name === '(sans nom)' || /^\*\d+$/.test(name) || /^material(\s|_|\d|$)/i.test(name)) return 'default';
  return 'unknown';
}

function listMaterials(object3d) {
  const found = new Map(); // name -> { role, count, baked }
  object3d.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      const name = m.name || '(sans nom)';
      const role = roleOfMaterial(name);
      // texture incrustée (bakée) : baseColor map ou autres maps présentes
      const baked = !!(m.map || m.aoMap || m.roughnessMap || m.metalnessMap || m.normalMap);
      const e = found.get(name) || { role, count: 0, baked: false, status: namingStatus(name) };
      e.count++;
      e.baked = e.baked || baked;
      found.set(name, e);
    }
  });
  return found;
}

// =============================================================================
// Finitions
// =============================================================================
function applyFinishes(object3d) {
  object3d.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const role = roleOfMaterial(o.material.name);
    if (!role || role === 'metal_hardware') return; // figé (inox)
    const m = o.material.clone(); // jamais muter un matériau partagé
    if (WOOD_ROLES.includes(role)) applyWoodFinish(m, role);
    else if (role === 'metal_structure') applyMetalFinish(m);
    else return;
    m.needsUpdate = true;
    o.material = m;
  });
}

// Colore chaque mesh par son rôle (vue Audit)
function colorByRole(object3d) {
  object3d.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const role = roleOfMaterial(o.material.name) || '_none';
    const m = o.material.clone();
    m.color = new THREE.Color(ROLE_DEBUG_COLOR[role] ?? ROLE_DEBUG_COLOR._none);
    m.map = null;
    m.metalness = role.startsWith('metal') ? 0.8 : 0.0;
    m.roughness = 0.5;
    m.needsUpdate = true;
    o.material = m;
  });
}

// =============================================================================
// Placement 2D -> 3D (cf. CLAUDE.md)
// =============================================================================
function worldPosition(el, assetMeta, H_MAX) {
  let X = el.x * S; // coin gauche
  const yTop = (H_MAX - el.y) * S; // bord haut de l'élément (Y JSON vers le bas)
  let Y;
  if (assetMeta.anchor === 'bottom') {
    Y = yTop - assetMeta.runtimeSizeY; // caler le haut, origine .glb en bas
  } else {
    Y = yTop;
  }
  let Z = assetMeta.depthLayer;
  // décalage par composant (table OFFSETS, en mm -> m)
  const off = assetMeta.offset || { x: 0, y: 0, z: 0 };
  X += off.x / 1000;
  Y += off.y / 1000;
  Z += off.z / 1000;
  return new THREE.Vector3(X, Y, Z);
}

// =============================================================================
// UI / log
// =============================================================================
const info = document.getElementById('info');

function clearLog() { info.innerHTML = ''; }

function log(text, level = 'info') {
  const line = document.createElement('div');
  line.className = 'log-line';
  if (level) {
    const tag = document.createElement('span');
    tag.className = `tag ${level}`;
    tag.textContent = { ok: 'OK', warn: 'WARN', err: 'ERR', info: 'INFO' }[level] || level;
    line.appendChild(tag);
  }
  line.appendChild(document.createTextNode(text));
  info.appendChild(line);
}

function logHTML(html) {
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = html;
  info.appendChild(line);
}

function blockTitle(t) {
  const h = document.createElement('h3');
  h.className = 'block';
  h.textContent = t;
  info.appendChild(h);
}

const mm = (m) => (m * 1000).toFixed(1);

// =============================================================================
// Cadrage caméra
// =============================================================================
function frame(object3d, margin = 1.6) {
  const { box, size } = measure(object3d);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 0.5;
  const dist = (radius * margin) / Math.tan((camera.fov * Math.PI) / 360);
  const dir = new THREE.Vector3(0.6, 0.45, 1).normalize();
  camera.position.copy(center).add(dir.multiplyScalar(dist + radius));
  controls.target.copy(center);
  controls.update();
}

// =============================================================================
// MODE 1 — Audit composant
// =============================================================================
async function runAudit(type) {
  clearContent();
  clearLog();
  const def = CATALOG[type];

  blockTitle(`Audit · ${type}`);

  let template;
  try {
    template = await loadTemplate(type);
  } catch (e) {
    log(`Échec de chargement : ${e.message}`, 'err');
    return;
  }

  const model = template.clone(true);
  content.add(model);

  // --- Mesure bbox vs expect ---
  const { box, size } = measure(model);
  blockTitle('Dimensions (bbox mesurée)');
  for (const axis of ['x', 'y', 'z']) {
    const got = size[axis];
    const exp = def.expect[`size${axis.toUpperCase()}`];
    const delta = got - exp;
    const level = Math.abs(delta) <= TOL ? 'ok' : 'warn';
    log(`${axis.toUpperCase()} = ${mm(got)} mm  (attendu ${mm(exp)} mm, Δ ${delta >= 0 ? '+' : ''}${mm(delta)} mm)`, level);
  }

  // --- Origine / pivot (sujet n°1) ---
  blockTitle('Origine / pivot');
  const min = box.min, max = box.max;
  log(`bbox.min = (${mm(min.x)}, ${mm(min.y)}, ${mm(min.z)}) mm`, 'info');
  log(`bbox.max = (${mm(max.x)}, ${mm(max.y)}, ${mm(max.z)}) mm`, 'info');
  const atCorner = Math.abs(min.x) <= TOL && Math.abs(min.y) <= TOL && Math.abs(min.z) <= TOL;
  log(
    atCorner
      ? 'Pivot au coin gauche-bas-arrière (min ≈ 0,0,0) ✓'
      : 'Pivot DÉCALÉ du coin attendu — à corriger dans SketchUp (origine au coin gauche-bas-arrière).',
    atCorner ? 'ok' : 'warn'
  );

  // --- Matériaux & rôles ---
  blockTitle('Conformité matières');
  const mats = listMaterials(model);
  if (mats.size === 0) log('Aucun matériau nommé trouvé.', 'warn');
  let nbOk = 0, nbRename = 0, nbTodo = 0, nbBaked = 0;
  for (const [name, e] of mats) {
    const col = e.role ? '#' + new THREE.Color(ROLE_DEBUG_COLOR[e.role]).getHexString() : 'transparent';
    const swatch = `<span class="swatch" style="background:${col}"></span>`;
    let tag, msg;
    switch (e.status) {
      case 'ok':
        tag = '<span class="tag ok">OK</span>'; nbOk++;
        msg = `${swatch}<b>${name}</b> <span class="muted">(conforme)</span> ×${e.count}`;
        break;
      case 'rename':
        tag = '<span class="tag warn">RENOMMER</span>'; nbRename++;
        msg = `${swatch}<b>${name}</b> → renommer en <b>${e.role}</b> dans SketchUp ×${e.count}`;
        break;
      case 'default':
        tag = '<span class="tag warn">À NOMMER</span>'; nbTodo++;
        msg = `<b>${name}</b> = nom par défaut SketchUp → nommer par rôle${e.role ? ` (probable <b>${e.role}</b>)` : ''} ×${e.count}`;
        break;
      default:
        tag = '<span class="tag err">À NOMMER</span>'; nbTodo++;
        msg = `<b>${name}</b> → rôle inconnu, à nommer par rôle ×${e.count}`;
    }
    logHTML(tag + msg);
    if (e.baked) {
      nbBaked++;
      const isWood = WOOD_ROLES.includes(e.role);
      if (isWood) {
        logHTML(`<span class="tag info">TEXTURE</span><b>${name}</b> : texture bois = porte les UV (sens du fil), OK. Réduite au nettoyage (clean-glb.sh).`);
      } else {
        logHTML(`<span class="tag warn">TEXTURE</span><b>${name}</b> : texture inutile pour ce rôle (couleur unie attendue) — réduite au nettoyage.`);
      }
    }
    // rappel visserie figée
    if (e.role === 'metal_hardware') {
      logHTML(`<span class="tag info">FIGÉ</span><b>${name}</b> : metal_hardware = inox, jamais piloté`);
    }
  }
  // Niveau basé sur le NOMMAGE seul : les textures sont gérées au nettoyage (resize).
  const recap = `Récap : ${nbOk} conforme(s), ${nbRename} à renommer, ${nbTodo} à nommer, ${nbBaked} texture(s) bakée(s) (réduites au nettoyage).`;
  log(recap, (nbRename + nbTodo) === 0 ? 'ok' : 'warn');

  // --- Marqueurs visuels min/max + axes à l'origine ---
  addCornerMarker(min, 0x5bd17a); // vert = min (pivot attendu)
  addCornerMarker(max, 0xff6b6b); // rouge = max

  // coloration par rôle pour vérifier visuellement le mapping matière
  colorByRole(model);

  helpers.position.set(0, 0, 0);
  wall.visible = false; // pas pertinent en audit isolé
  grid.visible = true;
  frame(model);
}

function addCornerMarker(pos, color) {
  const g = new THREE.SphereGeometry(0.008, 16, 16);
  const m = new THREE.MeshBasicMaterial({ color });
  const s = new THREE.Mesh(g, m);
  s.position.copy(pos);
  content.add(s);
}

// =============================================================================
// MODE 2 — Composition
// =============================================================================
let currentSchema = null;

// Point d'entrée mode 2 : (re)charge les templates puis place + recadre.
async function runComposition(schema) {
  currentSchema = schema;
  const data = schema?.data;
  if (!data || !Array.isArray(data.elements)) {
    clearContent(); clearLog();
    log('JSON invalide : data.elements manquant.', 'err');
    return;
  }
  // Pré-charger les templates uniques (une seule fois)
  const types = [...new Set(data.elements.map((e) => e.type))];
  for (const t of types) {
    if (!CATALOG[t]) continue;
    if (!glbCache.has(t)) { try { await loadTemplate(t); } catch (e) { /* loggé dans placeAll */ } }
  }
  populateNudgeTypes(data);
  initFinishesFromJSON(data); // finitions par défaut + peuplement des sélecteurs
  placeAll(true); // refit la caméra
}

// Place tous les éléments selon les OFFSETS courants. refit=false => garde la caméra
// (utile pendant le réglage live des décalages).
function placeAll(refit) {
  clearContent();
  clearLog();
  wall.visible = true;
  grid.visible = true;
  helpers.position.set(0, 0, 0);

  const data = currentSchema?.data;
  if (!data) return;

  blockTitle('Composition');
  log(`${data.elements.length} éléments · bois=${woodLabel()} · métal=${metalLabel()}`, 'info');

  const H_MAX = Math.max(...data.elements.map((e) => e.y + e.height));

  const placed = [];
  const gridBoxes = []; // toutes les grilles (peut y en avoir plusieurs)

  for (const el of data.elements) {
    const def = CATALOG[el.type];
    if (!def) { log(`Type absent du CATALOG : ${el.type} (ignoré)`, 'err'); continue; }
    if (!glbCache.has(el.type)) { log(`Template non chargé : ${el.type}`, 'err'); continue; }

    const model = instanceOf(el.type);

    const { size } = measure(model);
    // offset live (table OFFSETS) injecté dans le meta
    const meta = { ...def, runtimeSizeY: size.y, offset: ensureOffset(el.type) };

    const pos = worldPosition(el, meta, H_MAX);
    model.position.copy(pos);

    applyFinishes(model);
    content.add(model);

    const { box } = measure(model);
    placed.push({ el, def, box, size });
    if (el.type === 'gridGF') gridBoxes.push(box);
  }

  // Enveloppe (union) de toutes les grilles → référence pour le débord
  let gridEnvelope = null;
  if (gridBoxes.length) {
    gridEnvelope = gridBoxes[0].clone();
    for (let i = 1; i < gridBoxes.length; i++) gridEnvelope.union(gridBoxes[i]);
  }

  // Une planche déborde si elle sort de TOUTES les grilles à la fois (X) ;
  // on rapporte le débord minimal vs la grille la plus proche.
  function overhangVsGrids(box) {
    if (!gridBoxes.length) return null;
    // débord = plus petite "sortie" parmi les grilles (la planche peut appartenir à l'une d'elles)
    let best = null;
    for (const g of gridBoxes) {
      const o = {
        L: g.min.x - box.min.x, R: box.max.x - g.max.x,
        B: g.min.y - box.min.y, T: box.max.y - g.max.y,
      };
      // "score" = pire débord vs cette grille (0 si entièrement dedans en X/Y)
      const worst = Math.max(o.L, o.R, o.B, o.T, 0);
      if (best === null || worst < best.worst) best = { ...o, worst };
    }
    return best;
  }

  // --- Validation des placements ---
  blockTitle('Validation placements');
  if (gridBoxes.length > 1) log(`${gridBoxes.length} grilles détectées → débord mesuré vs la grille la plus proche.`, 'info');
  for (const p of placed) {
    const { el, size, box } = p;

    const fpW = el.width * S, fpH = el.height * S;
    const dW = size.x - fpW, dH = size.y - fpH;
    const wLevel = Math.abs(dW) <= 0.01 ? 'ok' : 'warn';
    log(`#${el.id} ${el.type} · footprint JSON ${mm(fpW)}×${mm(fpH)} mm vs bbox ${mm(size.x)}×${mm(size.y)} mm (Δ ${mm(dW)}×${mm(dH)})`, wLevel);

    if (el.type !== 'gridGF') {
      const o = overhangVsGrids(box);
      if (o) {
        if (o.L > TOL) log(`#${el.id} dépasse de ${mm(o.L)} mm à GAUCHE de la grille`, 'warn');
        if (o.R > TOL) log(`#${el.id} dépasse de ${mm(o.R)} mm à DROITE de la grille`, 'warn');
        if (o.T > TOL) log(`#${el.id} dépasse de ${mm(o.T)} mm en HAUT de la grille`, 'warn');
        if (o.B > TOL) log(`#${el.id} dépasse de ${mm(o.B)} mm en BAS de la grille`, 'warn');
      }
    }
  }

  // bbox globale
  if (placed.length) {
    const gb = new THREE.Box3().setFromObject(content);
    content.add(new THREE.Box3Helper(gb, new THREE.Color(0x6ab0ff)));
    if (refit) frameBox(gb);
  }

  updateOffsetReadout();
}

function frameBox(box, margin = 1.5) {
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 0.5;
  const dist = (radius * margin) / Math.tan((camera.fov * Math.PI) / 360);
  const dir = new THREE.Vector3(0.4, 0.25, 1).normalize();
  camera.position.copy(center).add(dir.multiplyScalar(dist + radius));
  controls.target.copy(center);
  controls.update();
}

// =============================================================================
// Réglage des décalages (offsets) — calibration visuelle
// =============================================================================
const nudgeType = document.getElementById('nudge-type');
const nudgeStep = document.getElementById('nudge-step');
const offsetReadout = document.getElementById('offset-readout');

// Remplit le sélecteur de composant à régler à partir des types présents (hors grille = référence).
function populateNudgeTypes(data) {
  const types = [...new Set(data.elements.map((e) => e.type))].filter((t) => CATALOG[t]);
  const prev = nudgeType.value;
  nudgeType.innerHTML = '';
  for (const t of types) {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = t + (t === 'gridGF' ? ' (référence)' : '');
    nudgeType.appendChild(o);
  }
  // défaut : premier non-grille si dispo
  const def = types.find((t) => t !== 'gridGF') || types[0];
  nudgeType.value = types.includes(prev) ? prev : def;
}

function updateOffsetReadout() {
  const t = nudgeType.value;
  if (!t || !OFFSETS[t]) { offsetReadout.textContent = ''; return; }
  const o = OFFSETS[t];
  offsetReadout.innerHTML = `<b>${t}</b>.offset = { x:${o.x}, y:${o.y}, z:${o.z} } mm`;
}

function nudge(axis, dir) {
  const t = nudgeType.value;
  if (!t) return;
  const o = ensureOffset(t);
  const step = parseFloat(nudgeStep.value) || 1;
  o[axis] = +(o[axis] + dir * step).toFixed(2);
  placeAll(false); // re-place sans recadrer ; met aussi à jour le readout + la validation
}

function resetOffsets() {
  const t = nudgeType.value;
  if (!t) return;
  OFFSETS[t] = CATALOG[t]?.offset ? { ...CATALOG[t].offset } : { x: 0, y: 0, z: 0 };
  placeAll(false);
}

// Produit le contenu de offset.json (tous les composants), prêt à coller.
function copyOffsetTable() {
  const ordered = {};
  for (const [t, o] of Object.entries(OFFSETS)) ordered[t] = { x: o.x, y: o.y, z: o.z };
  const json = JSON.stringify(ordered, null, 2);
  navigator.clipboard?.writeText(json).then(
    () => log('offset.json copié dans le presse-papier ✓ — colle-le dans offset.json', 'ok'),
    () => log('Copie auto impossible — copie le bloc ci-dessous à la main', 'warn')
  );
  blockTitle('offset.json (à coller)');
  logHTML(`<pre style="white-space:pre-wrap;margin:0">${json.replace(/</g, '&lt;')}</pre>`);
}

// =============================================================================
// Finitions (sélecteurs bois/métal + couleurs perso)
// =============================================================================
const finishWoodSel = document.getElementById('finish-wood');
const finishMetalSel = document.getElementById('finish-metal');
const woodColorInput = document.getElementById('wood-color');
const metalColorInput = document.getElementById('metal-color');

const hexToInt = (hex) => parseInt(hex.replace('#', ''), 16);
const intToHex = (n) => '#' + n.toString(16).padStart(6, '0');

function woodLabel() {
  if (woodFinish.maps) return woodFinish.label || 'texture';
  return woodFinish.label || ('couleur ' + intToHex(woodFinish.color));
}
function metalLabel() {
  return metalFinish.label || ('couleur ' + intToHex(metalFinish.color));
}

// Construit une fois les <option> des sélecteurs (set fixe).
function populateFinishSelectors() {
  finishWoodSel.innerHTML = '';
  for (const [key, def] of Object.entries(WOOD_FINISHES)) {
    finishWoodSel.appendChild(new Option(def.label, key));
  }
  finishWoodSel.appendChild(new Option('Couleur perso…', 'custom'));
  finishMetalSel.innerHTML = '';
  for (const [key, def] of Object.entries(METAL_FINISHES)) {
    finishMetalSel.appendChild(new Option(def.label, key));
  }
  finishMetalSel.appendChild(new Option('Couleur perso…', 'custom'));
}
let finishSelectorsReady = false;

// Initialise les finitions depuis le JSON et aligne l'UI.
function initFinishesFromJSON(data) {
  if (!finishSelectorsReady) { populateFinishSelectors(); finishSelectorsReady = true; }
  const w = data.woodColor, m = data.metalColor;
  woodFinish = WOOD_FINISHES[w] ? { ...WOOD_FINISHES[w] } : { ...WOOD_FINISHES.black };
  metalFinish = METAL_FINISHES[m] ? { ...METAL_FINISHES[m] } : { ...METAL_FINISHES.black };
  finishWoodSel.value = WOOD_FINISHES[w] ? w : 'black';
  finishMetalSel.value = METAL_FINISHES[m] ? m : 'black';
  if (woodFinish.color !== undefined) woodColorInput.value = intToHex(woodFinish.color);
  if (metalFinish.color !== undefined) metalColorInput.value = intToHex(metalFinish.color);
  syncWoodSliders();
}

function onWoodSelect() {
  const v = finishWoodSel.value;
  if (v === 'custom') {
    woodFinish = { color: hexToInt(woodColorInput.value), label: 'perso', params: { ...DEFAULT_WOOD_PARAMS } };
  } else {
    woodFinish = { ...WOOD_FINISHES[v] }; // params partagé par réf -> les sliders persistent dans la session
    if (woodFinish.color !== undefined) woodColorInput.value = intToHex(woodFinish.color);
  }
  syncWoodSliders();
  if (currentSchema) placeAll(false);
}

// Config des sliders texture bois (id, clé params, format).
const TEX_SLIDERS = [
  { id: 'tex-repeat', key: 'repeat',       fmt: (v) => v.toFixed(1) },
  { id: 'tex-bright', key: 'brightness',   fmt: (v) => v.toFixed(2) },
  { id: 'tex-rough',  key: 'roughness',    fmt: (v) => v.toFixed(2) },
  { id: 'tex-env',    key: 'envIntensity', fmt: (v) => v.toFixed(1) },
];

// Charge finishes.json et fusionne dans WOOD_FINISHES / METAL_FINISHES.
async function loadFinishes() {
  try {
    const res = await fetch('./finishes.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const toInt = (c) => (typeof c === 'string' ? hexToInt(c) : c);
    for (const [k, o] of Object.entries(data.wood || {})) {
      if (k.startsWith('_')) continue;
      const f = { label: o.label };
      if (o.maps) f.maps = { ...o.maps };
      if (o.color !== undefined) f.color = toInt(o.color);
      f.params = { ...DEFAULT_WOOD_PARAMS, ...(o.params || {}) };
      WOOD_FINISHES[k] = f;
    }
    for (const [k, o] of Object.entries(data.metal || {})) {
      if (k.startsWith('_')) continue;
      METAL_FINISHES[k] = { label: o.label, color: toInt(o.color), metalness: o.metalness ?? 1, roughness: o.roughness ?? 0.4 };
    }
  } catch (e) {
    console.warn('finishes.json non chargé (défauts utilisés) :', e.message);
  }
}

// Sérialise l'état courant des finitions au format finishes.json.
function serializeFinishes() {
  const wood = {};
  for (const [k, f] of Object.entries(WOOD_FINISHES)) {
    const o = { label: f.label };
    if (f.maps) o.maps = { ...f.maps };
    if (f.color !== undefined) o.color = intToHex(f.color);
    o.params = { ...f.params };
    wood[k] = o;
  }
  const metal = {};
  for (const [k, f] of Object.entries(METAL_FINISHES)) {
    metal[k] = { label: f.label, color: intToHex(f.color), metalness: f.metalness, roughness: f.roughness };
  }
  return { wood, metal };
}

function copyFinishesTable() {
  const json = JSON.stringify(serializeFinishes(), null, 2);
  navigator.clipboard?.writeText(json).then(
    () => log('finishes.json copié ✓ — colle-le dans finishes.json', 'ok'),
    () => log('Copie auto impossible — copie le bloc ci-dessous', 'warn')
  );
  blockTitle('finishes.json (à coller)');
  logHTML(`<pre style="white-space:pre-wrap;margin:0">${json.replace(/</g, '&lt;')}</pre>`);
}

// Aligne les sliders sur les params de la finition bois active.
function syncWoodSliders() {
  const p = woodFinish.params || DEFAULT_WOOD_PARAMS;
  for (const s of TEX_SLIDERS) {
    const input = document.getElementById(s.id);
    const out = document.getElementById(s.id + '-v');
    input.value = p[s.key];
    out.textContent = s.fmt(p[s.key]);
  }
}

function onMetalSelect() {
  const v = finishMetalSel.value;
  if (v === 'custom') {
    metalFinish = { color: hexToInt(metalColorInput.value), metalness: 0.6, roughness: 0.4, label: 'perso' };
  } else {
    metalFinish = { ...METAL_FINISHES[v] };
    metalColorInput.value = intToHex(metalFinish.color);
  }
  if (currentSchema) placeAll(false);
}

// =============================================================================
// Snapshot PNG transparent
// =============================================================================
function snapshot() {
  const prevVisible = helpers.visible;
  helpers.visible = false; // pas de repères dans l'export
  const prevRatio = renderer.getPixelRatio();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * 2); // ×2 supplémentaire
  onResize();
  renderer.render(scene, camera);

  renderer.domElement.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gassien-render.png';
    a.click();
    URL.revokeObjectURL(url);
    // restore
    renderer.setPixelRatio(prevRatio);
    helpers.visible = prevVisible;
    onResize();
  }, 'image/png');
}

// =============================================================================
// Boucle de rendu & resize
// =============================================================================
function onResize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// =============================================================================
// Câblage UI
// =============================================================================
let mode = 'audit';

const btnAudit = document.getElementById('mode-audit');
const btnCompo = document.getElementById('mode-compo');
const ctrlAudit = document.getElementById('ctrl-audit');
const ctrlCompo = document.getElementById('ctrl-compo');
const auditSelect = document.getElementById('audit-select');

// peupler le sélecteur d'audit
for (const type of Object.keys(CATALOG)) {
  const opt = document.createElement('option');
  opt.value = type; opt.textContent = type;
  auditSelect.appendChild(opt);
}

function setMode(m) {
  mode = m;
  btnAudit.classList.toggle('active', m === 'audit');
  btnCompo.classList.toggle('active', m === 'compo');
  ctrlAudit.style.display = m === 'audit' ? '' : 'none';
  ctrlCompo.style.display = m === 'compo' ? '' : 'none';
  if (m === 'audit') runAudit(auditSelect.value);
  else runComposition(currentSchema);
}

btnAudit.addEventListener('click', () => setMode('audit'));
btnCompo.addEventListener('click', () => setMode('compo'));
auditSelect.addEventListener('change', () => runAudit(auditSelect.value));

document.getElementById('toggle-helpers').addEventListener('click', (e) => {
  helpersVisible = !helpersVisible;
  helpers.visible = helpersVisible;
  e.target.textContent = helpersVisible ? 'Repères ✓' : 'Repères ✗';
});

document.getElementById('snapshot').addEventListener('click', snapshot);

// --- Réglage des décalages ---
for (const btn of document.querySelectorAll('.nudge')) {
  btn.addEventListener('click', () => nudge(btn.dataset.axis, parseInt(btn.dataset.dir, 10)));
}
nudgeType.addEventListener('change', updateOffsetReadout);
document.getElementById('offset-reset').addEventListener('click', resetOffsets);
document.getElementById('offset-copy').addEventListener('click', copyOffsetTable);

// --- Finitions ---
finishWoodSel.addEventListener('change', onWoodSelect);
finishMetalSel.addEventListener('change', onMetalSelect);
woodColorInput.addEventListener('input', () => {
  woodFinish = { color: hexToInt(woodColorInput.value), roughness: 0.6 };
  finishWoodSel.value = 'custom';
  if (currentSchema) placeAll(false);
});
metalColorInput.addEventListener('input', () => {
  metalFinish = { color: hexToInt(metalColorInput.value), metalness: 0.6, roughness: 0.4, label: 'perso' };
  finishMetalSel.value = 'custom';
  if (currentSchema) placeAll(false);
});

document.getElementById('finish-copy').addEventListener('click', copyFinishesTable);

// --- Réglages texture bois (sliders) : éditent les params de la finition active ---
for (const s of TEX_SLIDERS) {
  const input = document.getElementById(s.id);
  const out = document.getElementById(s.id + '-v');
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (!woodFinish.params) woodFinish.params = { ...DEFAULT_WOOD_PARAMS };
    woodFinish.params[s.key] = v;
    out.textContent = s.fmt(v);
    if (currentSchema) placeAll(false);
  });
}

// Flèches clavier (uniquement en mode composition, hors saisie)
window.addEventListener('keydown', (e) => {
  if (mode !== 'compo') return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const map = {
    ArrowLeft: ['x', -1], ArrowRight: ['x', 1],
    ArrowDown: ['y', -1], ArrowUp: ['y', 1],
    PageDown: ['z', -1], PageUp: ['z', 1],
  };
  const m = map[e.key];
  if (!m) return;
  e.preventDefault();
  nudge(m[0], m[1]);
});

async function loadSchema() {
  try {
    const res = await fetch('./schema.json');
    currentSchema = await res.json();
    if (mode === 'compo') runComposition(currentSchema);
  } catch (e) {
    log(`Impossible de charger schema.json : ${e.message}`, 'err');
  }
}
document.getElementById('reload-json').addEventListener('click', loadSchema);

document.getElementById('json-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      currentSchema = JSON.parse(reader.result);
      setMode('compo');
    } catch (err) {
      log(`JSON invalide : ${err.message}`, 'err');
    }
  };
  reader.readAsText(file);
});

// =============================================================================
// Démarrage
// =============================================================================
onResize();
animate();
(async () => {
  await loadOffsets();   // table de décalages persistante (offset.json)
  await loadFinishes();  // finitions persistantes (finishes.json)
  preloadTextures();     // textures bois (textures/*.jpg)
  await loadSchema();    // composition courante
  setMode('audit');      // démarre sur l'audit du 1er composant
})();
