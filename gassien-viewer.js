// =============================================================================
// GassienViewer — moteur 3D framework-agnostic (Three.js)
//
// Extrait du POC (viewer.js) pour réutilisation dans l'admin React+AntD.
// AUCUNE dépendance à un panneau UI : la classe ne touche que le <canvas> fourni
// et RETOURNE des données (audit, validation) au lieu d'écrire dans le DOM.
// La couche React construit son UX et appelle cette API.
//
// Dépendances : `three` (npm) + ses addons (OrbitControls, GLTFLoader,
// GLTFExporter, RoomEnvironment). Aucune importmap : un bundler (Vite…) résout.
//
// Assets attendus sous `assetBaseUrl` (servis en statique) :
//   <assetBaseUrl>glb/done/<type>.glb       composants nettoyés
//   <assetBaseUrl>textures/<*.jpg>           textures bois
//   <assetBaseUrl>catalog.json | offset.json | finishes.json   (ou injectés)
//
// Source de vérité des constantes/conventions : CLAUDE.md
// =============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// -----------------------------------------------------------------------------
// Constantes / conventions (cf. CLAUDE.md) — partagées, immuables
// -----------------------------------------------------------------------------
const S = 0.0025;  // m / unité configurateur
const TOL = 0.002; // tolérance d'audit bbox : 2 mm

const CANONICAL_ROLES = [
  'wood_face', 'wood_edge', 'wood_raw', 'wood',
  'metal_structure', 'metal_hardware', 'glass',
];
const WOOD_ROLES = ['wood_face', 'wood_edge', 'wood_raw', 'wood'];

// Anciens noms (apparence) -> rôle. À renommer en SketchUp ; gérés en transition.
const LEGACY_ALIASES = {
  'GASSIEN - Solid Oak': 'wood_face',
  '[Color M09]': 'metal_structure',
  '*1': 'metal_structure',
  '[Steel Brushed Stainless]': 'metal_hardware',
};

const ROLE_DEBUG_COLOR = {
  wood: 0xc98a3c, wood_face: 0xc98a3c, wood_edge: 0x8a5a2b, wood_raw: 0xdcb579,
  metal_structure: 0x5b9bd5, metal_hardware: 0xc0c0c0, glass: 0x9fd8e6,
  _none: 0xff3b6b,
};

// Verre — matière transparente FIGÉE.
const GLASS = { color: 0xeaf6fb, roughness: 0.05, transmission: 0.92, ior: 1.45, thickness: 0.004 };

// wood_raw (tubes hêtre) — toujours sa texture, FIGÉ.
const WOOD_RAW = { map: 'wood_raw.jpg', repeat: 3.3, brightness: 0.45, roughness: 0.40, envIntensity: 0.4 };

const WOOD_TEXTURE_FILES = ['oak_face.jpg', 'oak_edge.jpg', 'birch_face.jpg', 'birch_edge.jpg', 'wood_raw.jpg'];
const DEFAULT_WOOD_PARAMS = { repeat: 1, brightness: 1, roughness: 0.6, envIntensity: 1 };

// Défauts (surchargés par finishes.json / opts.finishes).
const DEFAULT_WOOD_FINISHES = {
  oak:   { label: 'Chêne Massif', maps: { wood_face: 'oak_face.jpg',   wood_edge: 'oak_edge.jpg',   wood_raw: 'wood_raw.jpg' }, params: { repeat: 3.3, brightness: 0.45, roughness: 0.50, envIntensity: 0.4 } },
  birch: { label: 'Bouleau CP',   maps: { wood_face: 'birch_face.jpg', wood_edge: 'birch_edge.jpg', wood_raw: 'wood_raw.jpg' }, params: { repeat: 5.9, brightness: 0.45, roughness: 0.25, envIntensity: 0.4 } },
  black: { label: 'Noir',  color: 0x111111, params: { repeat: 1, brightness: 1, roughness: 0.50, envIntensity: 1 } },
  white: { label: 'Blanc', color: 0xeaeaea, params: { repeat: 1, brightness: 1, roughness: 0.60, envIntensity: 1 } },
};
const DEFAULT_METAL_FINISHES = {
  black: { label: 'Noir',   color: 0x141414, metalness: 0, roughness: 0.5, envIntensity: 1 },
  white: { label: 'Blanc',  color: 0xf0f0f0, metalness: 0, roughness: 0.5, envIntensity: 1 },
  brass: { label: 'Laiton', color: 0xc2a86e, metalness: 0.85, roughness: 0.5, envIntensity: 1 },
};

// Catalogue minimal par défaut (le vrai vient de catalog.json / opts.catalog).
const DEFAULT_CATALOG = {
  gridGF:     { anchor: 'bottom', depthLayer: 0,     slots: ['metal_structure'], expect: { sizeX: 0.800, sizeY: 0.770, sizeZ: 0.012 } },
  board40x15: { anchor: 'bottom', depthLayer: 0.012, slots: ['wood_face', 'wood_edge', 'metal_structure', 'metal_hardware'], expect: { sizeX: 0.400, sizeY: 0.121, sizeZ: 0.161 } },
};

// -----------------------------------------------------------------------------
// Helpers purs (sans état d'instance)
// -----------------------------------------------------------------------------
function roleOfMaterial(name) {
  if (CANONICAL_ROLES.includes(name)) return name;
  return LEGACY_ALIASES[name] || null;
}
function namingStatus(name) {
  if (CANONICAL_ROLES.includes(name)) return 'ok';
  if (LEGACY_ALIASES[name]) return 'rename';
  if (name === '(sans nom)' || /^\*\d+$/.test(name) || /^material(\s|_|\d|$)/i.test(name)) return 'default';
  return 'unknown';
}
const hexToInt = (hex) => (typeof hex === 'string' ? parseInt(hex.replace('#', ''), 16) : hex);
const intToHex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');

// Nom de fichier sûr à partir d'un titre (accents retirés, espaces -> tirets).
export function slugify(s, fallback = 'composition') {
  const slug = (s || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || fallback;
}

// =============================================================================
// GassienViewer
// =============================================================================
export class GassienViewer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} [opts]
   * @param {string} [opts.assetBaseUrl='./']  base des assets (glb/done/, textures/, *.json)
   * @param {Object} [opts.catalog]   catalog.json déjà parsé (sinon fetché)
   * @param {Object} [opts.offsets]   offset.json déjà parsé (sinon fetché)
   * @param {Object} [opts.finishes]  finishes.json déjà parsé (sinon fetché)
   * @param {boolean} [opts.helpers=true]   afficher axes/mur/sol (repères de validation)
   * @param {boolean} [opts.panKeys=true]   pan SketchUp via H/Espace + glisser
   * @param {{wood:string, metal:string}} [opts.defaultFinish]  finition d'affichage par défaut
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.assetBaseUrl = opts.assetBaseUrl ?? './';
    this.glbDir = this.assetBaseUrl + 'glb/done/';
    this.texDir = this.assetBaseUrl + 'textures/';
    this._injected = { catalog: opts.catalog, offsets: opts.offsets, finishes: opts.finishes };
    this._defaultFinish = opts.defaultFinish ?? { wood: 'birch', metal: 'black' };

    // état config (live)
    this.catalog = JSON.parse(JSON.stringify(DEFAULT_CATALOG));
    this.offsets = {};
    this.woodFinishes = JSON.parse(JSON.stringify(DEFAULT_WOOD_FINISHES));
    this.metalFinishes = JSON.parse(JSON.stringify(DEFAULT_METAL_FINISHES));
    // finition active = RÉFÉRENCE vers l'entrée du registre (les réglages sliders y persistent)
    this.woodFinish = this.woodFinishes.black;
    this.metalFinish = this.metalFinishes.black;

    this._glbCache = new Map();
    this._texCache = new Map();
    this._loader = new GLTFLoader();
    this._texLoader = new THREE.TextureLoader();
    this.currentSchema = null;
    this._bboxWanted = false; // cadre bleu (bounding box) — piloté par le bouton Dimensions

    this._setupRenderer();
    this._setupScene();
    this._setupHelpers(opts.helpers !== false);
    if (opts.panKeys !== false) this._setupPanKeys();
    this._setupResize();
    this._animate = this._animate.bind(this);
    this._raf = requestAnimationFrame(this._animate);
  }

  // --- init : charge la config + précharge les textures ---
  async init() {
    await Promise.all([this._loadCatalog(), this._loadOffsets(), this._loadFinishes()]);
    this.woodFinish = this.woodFinishes[this._defaultFinish.wood] || this.woodFinishes.black;
    this.metalFinish = this.metalFinishes[this._defaultFinish.metal] || this.metalFinishes.black;
    this._preloadTextures();
    return this;
  }

  // ===========================================================================
  // Setup
  // ===========================================================================
  _setupRenderer() {
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.setClearColor(0x000000, 0);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    this.renderer = r;
  }

  _setupScene() {
    this.scene = new THREE.Scene();
    this._pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = this._pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    this.camera.position.set(0.9, 0.7, 1.4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(1.5, 2, 2.5);
    this.scene.add(key, new THREE.AmbientLight(0xffffff, 0.15));

    this.content = new THREE.Group();
    this.scene.add(this.content);
  }

  _setupHelpers(visible) {
    this.helpers = new THREE.Group();
    this.helpers.add(new THREE.AxesHelper(0.25));
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ color: 0x6ab0ff, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false })
    );
    wall.position.set(0, 0.5, 0);
    this._wall = wall;
    this.helpers.add(wall);
    this.helpers.add(new THREE.GridHelper(2, 20, 0x4a5560, 0x33373d));
    this.helpers.visible = visible;
    this._helpersWanted = visible;
    this.scene.add(this.helpers);
  }

  _setupPanKeys() {
    this._onKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.isContentEditable) return;
      if ((e.code === 'Space' || e.key === 'h' || e.key === 'H') && !this._panKeyHeld) {
        this._panKeyHeld = true;
        this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
        this.renderer.domElement.style.cursor = 'grab';
        e.preventDefault();
      }
    };
    this._onKeyUp = (e) => {
      if (e.code === 'Space' || e.key === 'h' || e.key === 'H') {
        this._panKeyHeld = false;
        this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
        this.renderer.domElement.style.cursor = '';
      }
    };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  _setupResize() {
    this.resize();
    const target = this.canvas.parentElement || this.canvas;
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(target);
    }
    this._onWinResize = () => this.resize();
    window.addEventListener('resize', this._onWinResize);
  }

  /** Recadre le renderer sur la taille du conteneur (ou w/h fournis). */
  resize(w, h) {
    const el = this.canvas.parentElement || this.canvas;
    const width = w ?? el.clientWidth ?? this.canvas.width;
    const height = h ?? el.clientHeight ?? this.canvas.height;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  _animate() {
    this._raf = requestAnimationFrame(this._animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // ===========================================================================
  // Chargement config (fetch sous assetBaseUrl, ou injecté)
  // ===========================================================================
  async _fetchJSON(file) {
    const res = await fetch(this.assetBaseUrl + file);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async _loadCatalog() {
    let data = this._injected.catalog;
    if (!data) { try { data = await this._fetchJSON('catalog.json'); } catch (e) { console.warn('catalog.json:', e.message); return; } }
    for (const [type, o] of Object.entries(data)) {
      if (type.startsWith('_') || !o) continue;
      this.catalog[type] = {
        ...(this.catalog[type] || {}),
        glb: this.glbDir + type + '.glb',
        anchor: o.anchor || 'bottom',
        depthLayer: o.depthLayer ?? 0,
        slots: o.slots || [],
        expect: o.expect || undefined,
      };
    }
  }

  async _loadOffsets() {
    // seed depuis le catalog
    for (const [type, def] of Object.entries(this.catalog)) this.offsets[type] = { ...(def.offset || { x: 0, y: 0, z: 0 }) };
    let data = this._injected.offsets;
    if (!data) { try { data = await this._fetchJSON('offset.json'); } catch (e) { console.warn('offset.json:', e.message); return; } }
    for (const [type, o] of Object.entries(data)) {
      if (type.startsWith('_') || !o || typeof o !== 'object') continue;
      this.offsets[type] = { x: +o.x || 0, y: +o.y || 0, z: +o.z || 0 };
    }
  }

  async _loadFinishes() {
    let data = this._injected.finishes;
    if (!data) { try { data = await this._fetchJSON('finishes.json'); } catch (e) { console.warn('finishes.json:', e.message); return; } }
    for (const [k, o] of Object.entries(data.wood || {})) {
      if (k.startsWith('_')) continue;
      const f = { label: o.label };
      if (o.maps) f.maps = { ...o.maps };
      if (o.color !== undefined) f.color = hexToInt(o.color);
      f.params = { ...DEFAULT_WOOD_PARAMS, ...(o.params || {}) };
      this.woodFinishes[k] = f;
    }
    for (const [k, o] of Object.entries(data.metal || {})) {
      if (k.startsWith('_')) continue;
      this.metalFinishes[k] = { label: o.label, color: hexToInt(o.color), metalness: o.metalness ?? 1, roughness: o.roughness ?? 0.4, envIntensity: o.envIntensity ?? 1 };
    }
  }

  // ===========================================================================
  // GLB / textures
  // ===========================================================================
  _glbPath(type) { return this.catalog[type]?.glb || (this.glbDir + type + '.glb'); }

  async _loadTemplate(type) {
    if (this._glbCache.has(type)) return this._glbCache.get(type);
    const gltf = await this._loader.loadAsync(this._glbPath(type));
    this._glbCache.set(type, gltf.scene);
    return gltf.scene;
  }

  _getTexture(file) {
    const path = this.texDir + file;
    if (this._texCache.has(path)) return this._texCache.get(path);
    const tex = this._texLoader.load(path, undefined, undefined, () => console.warn('Texture introuvable :', path));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this._texCache.set(path, tex);
    return tex;
  }

  _preloadTextures() { for (const f of WOOD_TEXTURE_FILES) this._getTexture(f); }

  // ===========================================================================
  // Mesures / matériaux
  // ===========================================================================
  _measure(object3d) {
    const box = new THREE.Box3().setFromObject(object3d);
    const size = new THREE.Vector3();
    box.getSize(size);
    return { box, size };
  }

  _listMaterials(object3d) {
    const found = new Map();
    object3d.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        const name = m.name || '(sans nom)';
        const baked = !!(m.map || m.aoMap || m.roughnessMap || m.metalnessMap || m.normalMap);
        const e = found.get(name) || { role: roleOfMaterial(name), count: 0, baked: false, status: namingStatus(name) };
        e.count++; e.baked = e.baked || baked;
        found.set(name, e);
      }
    });
    return found;
  }

  // ===========================================================================
  // Finitions
  // ===========================================================================
  _applyWoodFinish(m, role) {
    if (role === 'wood_raw') {
      m.metalness = 0; m.roughness = WOOD_RAW.roughness; m.envMapIntensity = WOOD_RAW.envIntensity;
      const tex = this._getTexture(WOOD_RAW.map);
      tex.repeat.set(WOOD_RAW.repeat, WOOD_RAW.repeat); tex.needsUpdate = true;
      m.map = tex; m.color.setScalar(WOOD_RAW.brightness);
      return;
    }
    const p = this.woodFinish.params || DEFAULT_WOOD_PARAMS;
    m.metalness = 0; m.roughness = p.roughness; m.envMapIntensity = p.envIntensity;
    if (this.woodFinish.maps) {
      const tex = this._getTexture(this.woodFinish.maps[role] || this.woodFinish.maps.wood_face);
      tex.repeat.set(p.repeat, p.repeat); tex.needsUpdate = true;
      m.map = tex; m.color.setScalar(p.brightness);
    } else {
      m.map = null; m.color.set(this.woodFinish.color);
    }
  }

  _applyMetalFinish(m) {
    m.map = null;
    m.color.set(this.metalFinish.color);
    m.metalness = this.metalFinish.metalness ?? 1;
    m.roughness = this.metalFinish.roughness ?? 0.4;
    m.envMapIntensity = this.metalFinish.envIntensity ?? 1;
  }

  _applyFinishes(object3d) {
    object3d.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const role = roleOfMaterial(o.material.name);
      if (!role || role === 'metal_hardware') return;       // inox figé
      if (role === 'glass') { o.material = this._makeGlass(); return; } // verre figé
      const m = o.material.clone();
      if (WOOD_ROLES.includes(role)) this._applyWoodFinish(m, role);
      else if (role === 'metal_structure') this._applyMetalFinish(m);
      else return;
      m.needsUpdate = true;
      o.material = m;
    });
  }

  _makeGlass() {
    return new THREE.MeshPhysicalMaterial({
      color: GLASS.color, metalness: 0, roughness: GLASS.roughness,
      transmission: GLASS.transmission, ior: GLASS.ior, thickness: GLASS.thickness,
      transparent: true, envMapIntensity: 1,
    });
  }

  _colorByRole(object3d) {
    object3d.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const role = roleOfMaterial(o.material.name) || '_none';
      const m = o.material.clone();
      m.color = new THREE.Color(ROLE_DEBUG_COLOR[role] ?? ROLE_DEBUG_COLOR._none);
      m.map = null; m.metalness = role.startsWith('metal') ? 0.8 : 0.0; m.roughness = 0.5;
      m.needsUpdate = true;
      o.material = m;
    });
  }

  // ===========================================================================
  // Placement
  // ===========================================================================
  _worldPosition(el, meta, H_MAX) {
    let X = el.x * S;
    const yTop = (H_MAX - el.y) * S;
    let Y = meta.anchor === 'bottom' ? yTop - meta.runtimeSizeY : yTop;
    let Z = meta.depthLayer;
    const off = meta.offset || { x: 0, y: 0, z: 0 };
    X += off.x / 1000; Y += off.y / 1000; Z += off.z / 1000;
    return new THREE.Vector3(X, Y, Z);
  }

  _clearContent() { this.content.clear(); }

  _setAllHelpersVisible(v) {
    this.helpers.visible = v;
    this.content.traverse((o) => { if (o.userData?.helper) o.visible = v; });
  }

  _frameObject(object3d, margin = 1.3, dir = new THREE.Vector3(0.6, 0.45, 1)) {
    const { box, size } = this._measure(object3d);
    this._frameBox(box, margin, dir);
    return { box, size };
  }

  /**
   * Cadre la caméra sur `box` en tenant compte du ratio du viewport (largeur ET
   * hauteur) pour que la composition remplisse réellement la vue. Le point de
   * rotation (controls.target) est placé au centre de la box.
   * margin = 1.0 → la compo touche les bords ; 1.2 ≈ remplit ~83 %.
   */
  _frameBox(box, margin = 1.2, dir = new THREE.Vector3(0.5, 0.32, 1)) {
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    const fov = (this.camera.fov * Math.PI) / 180;
    const aspect = this.camera.aspect || 1;
    const tan = Math.tan(fov / 2);
    // Distance pour faire tenir la hauteur, et pour faire tenir la largeur
    // (le FOV horizontal vaut le FOV vertical × aspect).
    const fitH = (size.y * 0.5) / tan;
    const fitW = (size.x * 0.5) / (tan * aspect);
    let dist = Math.max(fitH, fitW, 0.001) * margin + size.z * 0.5;
    if (!Number.isFinite(dist) || dist <= 0) dist = 1;
    this.camera.position.copy(center).add(dir.clone().normalize().multiplyScalar(dist));
    this.camera.near = Math.max(dist / 100, 0.005);
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
  }

  // ===========================================================================
  // API PUBLIQUE
  // ===========================================================================

  /** Liste les composants réellement présents dans glb/done/ (sondage HEAD). */
  async listComponents() {
    const candidates = new Set([...Object.keys(this.offsets), ...Object.keys(this.catalog)]);
    const checks = await Promise.all([...candidates].map(async (t) => {
      try { const r = await fetch(this._glbPath(t), { method: 'HEAD' }); return r.ok ? t : null; }
      catch (e) { return null; }
    }));
    return checks.filter(Boolean).sort();
  }

  /**
   * Audit d'un composant : l'affiche (coloré par rôle) ET retourne les données.
   * @returns {Promise<Object>} { type, inCatalog, dimensions, origin, materials, recap }
   */
  async audit(type) {
    this._clearContent();
    const def = this.catalog[type];
    const template = await this._loadTemplate(type);
    const model = template.clone(true);
    this.content.add(model);

    const { box, size } = this._measure(model);
    const dimensions = ['x', 'y', 'z'].map((ax) => {
      const measured = size[ax];
      const expected = def?.expect?.[`size${ax.toUpperCase()}`] ?? null;
      const delta = expected === null ? null : measured - expected;
      const status = expected === null ? 'info' : (Math.abs(delta) <= TOL ? 'ok' : 'warn');
      return { axis: ax.toUpperCase(), measured, expected, delta, status };
    });

    const min = box.min, max = box.max;
    const atCorner = Math.abs(min.x) <= TOL && Math.abs(min.y) <= TOL && Math.abs(min.z) <= TOL;

    const matsMap = this._listMaterials(model);
    const materials = [];
    let ok = 0, rename = 0, todo = 0, baked = 0;
    for (const [name, e] of matsMap) {
      if (e.status === 'ok') ok++; else if (e.status === 'rename') rename++; else todo++;
      if (e.baked) baked++;
      materials.push({ name, role: e.role, count: e.count, status: e.status, baked: e.baked });
    }

    this._addCornerMarker(min, 0x5bd17a);
    this._addCornerMarker(max, 0xff6b6b);
    this._colorByRole(model);
    this._wall.visible = false;
    this._frameObject(model);

    return {
      type, inCatalog: !!def,
      dimensions, origin: { min: { ...min }, max: { ...max }, atCorner },
      materials, recap: { ok, rename, todo, baked },
    };
  }

  _addCornerMarker(pos, color) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.008, 16, 16), new THREE.MeshBasicMaterial({ color }));
    s.position.copy(pos);
    s.userData.helper = true;
    s.visible = this._helpersWanted;
    this.content.add(s);
  }

  /**
   * Charge & place une composition (schema du configurateur). Applique les finitions.
   * @returns {Promise<Object>} { elementCount, gridCount, elements, errors }
   */
  async loadComposition(schema) {
    this.currentSchema = schema;
    const data = schema?.data;
    if (!data || !Array.isArray(data.elements)) { this._clearContent(); return { errors: ['JSON invalide : data.elements manquant'], elements: [] }; }

    const types = [...new Set(data.elements.map((e) => e.type))];
    for (const t of types) {
      if (!this.catalog[t] || this._glbCache.has(t)) continue;
      try { await this._loadTemplate(t); } catch (e) { /* signalé dans _place */ }
    }
    this._wall.visible = this._helpersWanted;
    return this._place(true);
  }

  _place(refit) {
    this._clearContent();
    const data = this.currentSchema?.data;
    if (!data) return { errors: [], elements: [] };

    const H_MAX = Math.max(...data.elements.map((e) => e.y + e.height));
    const placed = [];
    const gridBoxes = [];
    const errors = [];
    const unknownTypes = new Set();   // types absents du catalogue
    const missingGlb = new Set();     // dans le catalogue mais glb non chargeable

    for (const el of data.elements) {
      const def = this.catalog[el.type];
      if (!def) { errors.push(`Type absent du CATALOG : ${el.type}`); unknownTypes.add(el.type); continue; }
      if (!this._glbCache.has(el.type)) { errors.push(`Template non chargé : ${el.type}`); missingGlb.add(el.type); continue; }
      const model = this._glbCache.get(el.type).clone(true);
      const { size } = this._measure(model);
      const meta = { ...def, runtimeSizeY: size.y, offset: this.getOffset(el.type) };
      model.position.copy(this._worldPosition(el, meta, H_MAX));
      this._applyFinishes(model);
      this.content.add(model);
      const { box } = this._measure(model);
      placed.push({ el, box, size });
      if (el.type.startsWith('grid')) gridBoxes.push(box);
    }

    const overhang = (box) => {
      if (!gridBoxes.length) return null;
      let best = null;
      for (const g of gridBoxes) {
        const o = { L: g.min.x - box.min.x, R: box.max.x - g.max.x, B: g.min.y - box.min.y, T: box.max.y - g.max.y };
        const worst = Math.max(o.L, o.R, o.B, o.T, 0);
        if (best === null || worst < best.worst) best = { ...o, worst };
      }
      return best;
    };

    const elements = placed.map(({ el, box, size }) => {
      const fpW = el.width * S, fpH = el.height * S;
      const o = el.type.startsWith('grid') ? null : overhang(box);
      return {
        id: el.id, type: el.type,
        footprint: { w: fpW, h: fpH }, bbox: { w: size.x, h: size.y, d: size.z },
        footprintDelta: { w: size.x - fpW, h: size.y - fpH },
        overhang: o ? { L: Math.max(o.L, 0), R: Math.max(o.R, 0), T: Math.max(o.T, 0), B: Math.max(o.B, 0) } : null,
      };
    });

    if (placed.length) {
      const gb = new THREE.Box3().setFromObject(this.content);
      const helper = new THREE.Box3Helper(gb, new THREE.Color(0x6ab0ff));
      helper.userData.bbox = true;       // cadre bleu (piloté par setBoundingBoxVisible)
      helper.visible = this._bboxWanted;  // masqué par défaut, découplé des repères
      this.content.add(helper);
      if (refit) this._frameBox(gb);
    }
    return {
      elementCount: data.elements.length, gridCount: gridBoxes.length, elements, errors,
      unknownTypes: [...unknownTypes], missingGlb: [...missingGlb],
    };
  }

  // --- Finitions (pilotage) ---
  getWoodFinishes() { return this.woodFinishes; }
  getMetalFinishes() { return this.metalFinishes; }

  // Ré-applique les finitions aux objets DÉJÀ placés (sans rebuild ni recadrage).
  // -> un changement de couleur/finition ne réinitialise PAS la vue (caméra figée).
  _reapplyFinishes() { this._applyFinishes(this.content); }

  // spec : clé ('oak'…) -> référence le registre (les sliders y persistent),
  // ou { color:'#rrggbb' } -> finition perso (objet à part).
  setWoodFinish(spec) {
    if (typeof spec === 'string' && this.woodFinishes[spec]) this.woodFinish = this.woodFinishes[spec];
    else if (spec && spec.color !== undefined) this.woodFinish = { color: hexToInt(spec.color), label: 'perso', params: { ...DEFAULT_WOOD_PARAMS } };
    if (this.currentSchema) this._reapplyFinishes();
  }
  setMetalFinish(spec) {
    if (typeof spec === 'string' && this.metalFinishes[spec]) this.metalFinish = this.metalFinishes[spec];
    else if (spec && spec.color !== undefined) this.metalFinish = { color: hexToInt(spec.color), metalness: 0.6, roughness: 0.5, envIntensity: 1, label: 'perso' };
    if (this.currentSchema) this._reapplyFinishes();
  }
  /** Ajuste les params de la finition bois active (repeat/brightness/roughness/envIntensity). */
  setWoodParams(partial) {
    if (!this.woodFinish.params) this.woodFinish.params = { ...DEFAULT_WOOD_PARAMS };
    Object.assign(this.woodFinish.params, partial); // mutation -> persiste dans le registre
    if (this.currentSchema) this._reapplyFinishes();
  }
  setMetalParams(partial) {
    Object.assign(this.metalFinish, partial); // mutation -> persiste dans le registre
    if (this.currentSchema) this._reapplyFinishes();
  }

  /** État courant des finitions au format finishes.json (couleurs en hex). */
  serializeFinishes() {
    const wood = {};
    for (const [k, f] of Object.entries(this.woodFinishes)) {
      const o = { label: f.label };
      if (f.maps) o.maps = { ...f.maps };
      if (f.color !== undefined) o.color = intToHex(f.color);
      o.params = { ...f.params };
      wood[k] = o;
    }
    const metal = {};
    for (const [k, f] of Object.entries(this.metalFinishes)) {
      metal[k] = { label: f.label, color: intToHex(f.color), metalness: f.metalness, roughness: f.roughness, envIntensity: f.envIntensity ?? 1 };
    }
    return { wood, metal };
  }

  // --- Offsets (calibration de placement) ---
  getOffset(type) {
    if (!this.offsets[type]) this.offsets[type] = { x: 0, y: 0, z: 0 };
    return this.offsets[type];
  }
  /** @returns le rapport de validation re-calculé (ou null), pour rafraîchir l'UI. */
  setOffset(type, xyz) {
    this.offsets[type] = { x: 0, y: 0, z: 0, ...xyz };
    return this.currentSchema ? this._place(false) : null;
  }
  getOffsets() { return this.offsets; }
  getCatalog() { return this.catalog; }

  // --- Affichage ---
  setHelpersVisible(v) { this._helpersWanted = v; this._setAllHelpersVisible(v); }

  /** Recadre sur la composition. margin plus petit = plus serré (remplit plus l'écran). */
  frame(margin = 1.2) {
    if (!this.content.children.length) return;
    this.resize(); // garantit le bon aspect avant de calculer la distance
    this._frameBox(new THREE.Box3().setFromObject(this.content), margin);
  }

  /** Affiche/masque le cadre bleu (bounding box) de la composition. */
  setBoundingBoxVisible(v) {
    this._bboxWanted = v;
    this.content.traverse((o) => { if (o.userData?.bbox) o.visible = v; });
  }

  /** Dimensions hors-tout de la composition en mètres, ou null si vide. */
  getDimensions() {
    if (!this.content.children.length) return null;
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(this.content).getSize(size);
    return { w: size.x, h: size.y, d: size.z };
  }

  // --- Export ---
  /** PNG fond transparent, sans repères. @returns {Promise<Blob>} */
  snapshotPNG({ scale = 2 } = {}) {
    return new Promise((resolve) => {
      const prev = this.helpers.visible;
      const prevBbox = this._bboxWanted;
      this._setAllHelpersVisible(false);
      this.setBoundingBoxVisible(false);
      const prevRatio = this.renderer.getPixelRatio();
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * scale);
      this.resize();
      this.renderer.render(this.scene, this.camera);
      this.renderer.domElement.toBlob((blob) => {
        this.renderer.setPixelRatio(prevRatio);
        this._setAllHelpersVisible(this._helpersWanted);
        this.helpers.visible = prev && this._helpersWanted;
        this.setBoundingBoxVisible(prevBbox);
        this.resize();
        resolve(blob);
      }, 'image/png');
    });
  }

  /** Rend le PNG (sans repères) et le copie dans le presse-papier. @returns {Promise<Blob>} */
  async copyPNGToClipboard(opts) {
    const blob = await this.snapshotPNG(opts);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return blob;
  }

  /** Nom de fichier (slug) basé sur le titre de la composition courante. */
  compositionName() { return slugify(this.currentSchema?.data?.title); }

  /** Composition (objets + finitions) en .glb binaire, sans repères. @returns {Promise<Blob>} */
  exportGLB() {
    return new Promise((resolve, reject) => {
      const prevBbox = this._bboxWanted;
      this._setAllHelpersVisible(false);
      this.setBoundingBoxVisible(false);
      const restore = () => { this._setAllHelpersVisible(this._helpersWanted); this.setBoundingBoxVisible(prevBbox); };
      new GLTFExporter().parse(
        this.content,
        (result) => { restore(); resolve(new Blob([result], { type: 'model/gltf-binary' })); },
        (err) => { restore(); reject(err); },
        { binary: true, onlyVisible: true }
      );
    });
  }

  // --- Cycle de vie ---
  dispose() {
    cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    window.removeEventListener('resize', this._onWinResize);
    if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
    if (this._onKeyUp) window.removeEventListener('keyup', this._onKeyUp);
    this.controls.dispose();
    this._pmrem.dispose();
    this.scene.environment?.dispose?.();
    this._texCache.forEach((t) => t.dispose());
    this.renderer.dispose();
  }
}

// Exports utilitaires (utiles côté UI React)
export { roleOfMaterial, namingStatus, CANONICAL_ROLES, WOOD_ROLES, intToHex, hexToInt };
