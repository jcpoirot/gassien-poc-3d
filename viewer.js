// =============================================================================
// Gassien — Viewer 3D (POC) — couche UI
//
// Le POC consomme désormais LE MÊME moteur que l'admin : `GassienViewer`
// (gassien-viewer.js). Ce fichier ne contient QUE l'UI : il câble le panneau
// d'index.html sur l'API du moteur et rend les données retournées (audit /
// validation) dans le log. Toute la logique 3D est dans le moteur (source unique).
// =============================================================================

import { GassienViewer, intToHex, hexToInt } from './gassien-viewer.js';

const canvas = document.getElementById('canvas');

// Le moteur (helpers ON = repères de validation ; finition d'affichage Bouleau/Noir).
const viewer = new GassienViewer(canvas, {
  assetBaseUrl: './',
  helpers: true,
  defaultFinish: { wood: 'birch', metal: 'black' },
});

// =============================================================================
// Log (rendu des données dans #info)
// =============================================================================
const info = document.getElementById('info');
const clearLog = () => { info.innerHTML = ''; };
const mm = (m) => (m * 1000).toFixed(1);

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

// =============================================================================
// Rendu des résultats d'AUDIT (données moteur -> log)
// =============================================================================
function renderAudit(type, a) {
  clearLog();
  blockTitle(`Audit · ${type}`);

  blockTitle('Dimensions (bbox mesurée)');
  if (!a.dimensions.some((d) => d.expected !== null)) {
    log('Pas de dimensions attendues (expect) pour ce composant — audit informatif.', 'info');
  }
  for (const d of a.dimensions) {
    if (d.expected === null) {
      log(`${d.axis} = ${mm(d.measured)} mm`, 'info');
    } else {
      log(`${d.axis} = ${mm(d.measured)} mm  (attendu ${mm(d.expected)} mm, Δ ${d.delta >= 0 ? '+' : ''}${mm(d.delta)} mm)`, d.status);
    }
  }

  blockTitle('Origine / pivot');
  const { min, max, atCorner } = a.origin;
  log(`bbox.min = (${mm(min.x)}, ${mm(min.y)}, ${mm(min.z)}) mm`, 'info');
  log(`bbox.max = (${mm(max.x)}, ${mm(max.y)}, ${mm(max.z)}) mm`, 'info');
  log(
    atCorner
      ? 'Pivot au coin gauche-bas-arrière (min ≈ 0,0,0) ✓'
      : 'Pivot DÉCALÉ du coin attendu — à corriger dans SketchUp (origine au coin gauche-bas-arrière).',
    atCorner ? 'ok' : 'warn'
  );

  blockTitle('Conformité matières');
  if (!a.materials.length) log('Aucun matériau nommé trouvé.', 'warn');
  for (const m of a.materials) {
    const col = m.role ? '#' + roleColorHex(m.role) : 'transparent';
    const swatch = `<span class="swatch" style="background:${col}"></span>`;
    let tag, msg;
    switch (m.status) {
      case 'ok':
        tag = '<span class="tag ok">OK</span>';
        msg = `${swatch}<b>${m.name}</b> <span class="muted">(conforme)</span> ×${m.count}`;
        break;
      case 'rename':
        tag = '<span class="tag warn">RENOMMER</span>';
        msg = `${swatch}<b>${m.name}</b> → renommer en <b>${m.role}</b> dans SketchUp ×${m.count}`;
        break;
      case 'default':
        tag = '<span class="tag warn">À NOMMER</span>';
        msg = `<b>${m.name}</b> = nom par défaut SketchUp → nommer par rôle${m.role ? ` (probable <b>${m.role}</b>)` : ''} ×${m.count}`;
        break;
      default:
        tag = '<span class="tag err">À NOMMER</span>';
        msg = `<b>${m.name}</b> → rôle inconnu, à nommer par rôle ×${m.count}`;
    }
    logHTML(tag + msg);
    if (m.baked) {
      const isWood = m.role && m.role.startsWith('wood');
      logHTML(isWood
        ? `<span class="tag info">TEXTURE</span><b>${m.name}</b> : texture bois = porte les UV (sens du fil), OK. Réduite au nettoyage.`
        : `<span class="tag warn">TEXTURE</span><b>${m.name}</b> : texture inutile pour ce rôle (couleur unie attendue) — réduite au nettoyage.`);
    }
    if (m.role === 'metal_hardware') logHTML(`<span class="tag info">FIGÉ</span><b>${m.name}</b> : metal_hardware = inox, jamais piloté`);
    if (m.role === 'glass') logHTML(`<span class="tag info">FIGÉ</span><b>${m.name}</b> : glass = verre transparent, jamais piloté`);
  }
  const { ok, rename, todo, baked } = a.recap;
  log(`Récap : ${ok} conforme(s), ${rename} à renommer, ${todo} à nommer, ${baked} texture(s) bakée(s) (réduites au nettoyage).`,
    (rename + todo) === 0 ? 'ok' : 'warn');
}

// Couleur de debug par rôle (pour les pastilles du log) — alignée sur le moteur.
const ROLE_HEX = {
  wood: 'c98a3c', wood_face: 'c98a3c', wood_edge: '8a5a2b', wood_raw: 'dcb579',
  metal_structure: '5b9bd5', metal_hardware: 'c0c0c0', glass: '9fd8e6',
};
const roleColorHex = (role) => ROLE_HEX[role] || 'ff3b6b';

// =============================================================================
// Rendu de la VALIDATION de composition (données moteur -> log)
// =============================================================================
function renderComposition(rep) {
  clearLog();
  blockTitle('Composition');
  log(`${rep.elementCount} éléments · bois=${finishLabel(viewer.woodFinish)} · métal=${finishLabel(viewer.metalFinish)}`, 'info');
  for (const e of rep.errors) log(e, 'err');

  blockTitle('Validation placements');
  if (rep.gridCount > 1) log(`${rep.gridCount} grilles détectées → débord mesuré vs la grille la plus proche.`, 'info');
  for (const el of rep.elements) {
    const fp = el.footprint, bb = el.bbox, d = el.footprintDelta;
    const lvl = Math.abs(d.w) <= 0.01 ? 'ok' : 'warn';
    log(`#${el.id} ${el.type} · footprint JSON ${mm(fp.w)}×${mm(fp.h)} mm vs bbox ${mm(bb.w)}×${mm(bb.h)} mm (Δ ${mm(d.w)}×${mm(d.h)})`, lvl);
    const o = el.overhang;
    if (o) {
      if (o.L > 0.002) log(`#${el.id} dépasse de ${mm(o.L)} mm à GAUCHE de la grille`, 'warn');
      if (o.R > 0.002) log(`#${el.id} dépasse de ${mm(o.R)} mm à DROITE de la grille`, 'warn');
      if (o.T > 0.002) log(`#${el.id} dépasse de ${mm(o.T)} mm en HAUT de la grille`, 'warn');
      if (o.B > 0.002) log(`#${el.id} dépasse de ${mm(o.B)} mm en BAS de la grille`, 'warn');
    }
  }
}

const finishLabel = (f) => f?.label || (f?.maps ? 'texture' : ('couleur ' + intToHex(f?.color ?? 0)));

// =============================================================================
// Modes (audit / composition)
// =============================================================================
let mode = 'compo';
let currentSchema = null;
let firstCompo = true;

const btnAudit = document.getElementById('mode-audit');
const btnCompo = document.getElementById('mode-compo');
const ctrlAudit = document.getElementById('ctrl-audit');
const ctrlCompo = document.getElementById('ctrl-compo');
const auditSelect = document.getElementById('audit-select');

async function runAuditUI() {
  const type = auditSelect.value;
  if (!type) return;
  try {
    const a = await viewer.audit(type);
    renderAudit(type, a);
  } catch (e) {
    clearLog();
    log(`Échec de chargement : ${e.message}`, 'err');
  }
}

async function runCompositionUI() {
  if (!currentSchema) { clearLog(); log('Aucune composition chargée.', 'warn'); return; }
  const rep = await viewer.loadComposition(currentSchema);
  populateNudgeTypes(currentSchema.data);
  renderComposition(rep);
  updateOffsetReadout();
}

function setMode(m) {
  mode = m;
  btnAudit.classList.toggle('active', m === 'audit');
  btnCompo.classList.toggle('active', m === 'compo');
  ctrlAudit.style.display = m === 'audit' ? '' : 'none';
  ctrlCompo.style.display = m === 'compo' ? '' : 'none';
  if (m === 'audit') runAuditUI(); else runCompositionUI();
}

btnAudit.addEventListener('click', () => setMode('audit'));
btnCompo.addEventListener('click', () => setMode('compo'));
auditSelect.addEventListener('change', runAuditUI);

// =============================================================================
// Sélecteur d'audit : tous les composants présents (le moteur sonde glb/done/)
// =============================================================================
async function populateAuditSelect() {
  const types = await viewer.listComponents();
  const cat = viewer.getCatalog();
  const prev = auditSelect.value;
  auditSelect.innerHTML = '';
  for (const t of (types.length ? types : Object.keys(cat))) {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t + (cat[t]?.expect ? '' : ' •'); // • = pas d'expect (audit informatif)
    auditSelect.appendChild(opt);
  }
  if (types.includes(prev)) auditSelect.value = prev;
}

// =============================================================================
// Finitions (sélecteurs + sliders + couleurs perso)
// =============================================================================
const finishWoodSel = document.getElementById('finish-wood');
const finishMetalSel = document.getElementById('finish-metal');
const woodColorInput = document.getElementById('wood-color');
const metalColorInput = document.getElementById('metal-color');

const TEX_SLIDERS = [
  { id: 'tex-repeat', key: 'repeat', fmt: (v) => v.toFixed(1) },
  { id: 'tex-bright', key: 'brightness', fmt: (v) => v.toFixed(2) },
  { id: 'tex-rough', key: 'roughness', fmt: (v) => v.toFixed(2) },
  { id: 'tex-env', key: 'envIntensity', fmt: (v) => v.toFixed(1) },
];
const MET_SLIDERS = [
  { id: 'met-metal', key: 'metalness', fmt: (v) => v.toFixed(2), def: 1 },
  { id: 'met-rough', key: 'roughness', fmt: (v) => v.toFixed(2), def: 0.4 },
  { id: 'met-env', key: 'envIntensity', fmt: (v) => v.toFixed(1), def: 1 },
];

function populateFinishSelectors() {
  finishWoodSel.innerHTML = '';
  for (const [key, def] of Object.entries(viewer.getWoodFinishes())) finishWoodSel.appendChild(new Option(def.label, key));
  finishWoodSel.appendChild(new Option('Couleur perso…', 'custom'));
  finishMetalSel.innerHTML = '';
  for (const [key, def] of Object.entries(viewer.getMetalFinishes())) finishMetalSel.appendChild(new Option(def.label, key));
  finishMetalSel.appendChild(new Option('Couleur perso…', 'custom'));
}

// Aligne sélecteurs + sliders + color inputs sur la finition active du moteur.
function syncFinishUI() {
  const w = viewer.woodFinish, m = viewer.metalFinish;
  finishWoodSel.value = woodKeyOf(w);
  finishMetalSel.value = metalKeyOf(m);
  if (w.color !== undefined) woodColorInput.value = intToHex(w.color);
  if (m.color !== undefined) metalColorInput.value = intToHex(m.color);
  const wp = w.params || { repeat: 1, brightness: 1, roughness: 0.6, envIntensity: 1 };
  for (const s of TEX_SLIDERS) setSlider(s, wp[s.key]);
  for (const s of MET_SLIDERS) setSlider(s, m[s.key] ?? s.def);
}
function setSlider(s, v) {
  document.getElementById(s.id).value = v;
  document.getElementById(s.id + '-v').textContent = s.fmt(+v);
}
const woodKeyOf = (f) => Object.entries(viewer.getWoodFinishes()).find(([, d]) => d === f)?.[0] || 'custom';
const metalKeyOf = (f) => Object.entries(viewer.getMetalFinishes()).find(([, d]) => d === f)?.[0] || 'custom';

// finition d'affichage selon le JSON (1er rendu = Bouleau/Noir, sinon woodColor/metalColor)
function applyFinishFromSchema(data) {
  let w = data.woodColor, m = data.metalColor;
  if (firstCompo) { w = 'birch'; m = 'black'; firstCompo = false; }
  if (viewer.getWoodFinishes()[w]) viewer.setWoodFinish(w);
  if (viewer.getMetalFinishes()[m]) viewer.setMetalFinish(m);
  syncFinishUI();
}

finishWoodSel.addEventListener('change', () => {
  const v = finishWoodSel.value;
  viewer.setWoodFinish(v === 'custom' ? { color: woodColorInput.value } : v);
  syncFinishUI();
});
finishMetalSel.addEventListener('change', () => {
  const v = finishMetalSel.value;
  viewer.setMetalFinish(v === 'custom' ? { color: metalColorInput.value } : v);
  syncFinishUI();
});
woodColorInput.addEventListener('input', () => {
  viewer.setWoodFinish({ color: woodColorInput.value });
  finishWoodSel.value = 'custom';
});
metalColorInput.addEventListener('input', () => {
  viewer.setMetalFinish({ color: metalColorInput.value });
  finishMetalSel.value = 'custom';
});
for (const s of TEX_SLIDERS) {
  document.getElementById(s.id).addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    document.getElementById(s.id + '-v').textContent = s.fmt(v);
    viewer.setWoodParams({ [s.key]: v });
  });
}
for (const s of MET_SLIDERS) {
  document.getElementById(s.id).addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    document.getElementById(s.id + '-v').textContent = s.fmt(v);
    viewer.setMetalParams({ [s.key]: v });
  });
}

document.getElementById('finish-copy').addEventListener('click', () => {
  const json = JSON.stringify(viewer.serializeFinishes(), null, 2);
  copyToClipboard(json, 'finishes.json');
  blockTitle('finishes.json (à coller)');
  logHTML(`<pre style="white-space:pre-wrap;margin:0">${json.replace(/</g, '&lt;')}</pre>`);
});

// =============================================================================
// Réglage des décalages (offsets)
// =============================================================================
const nudgeType = document.getElementById('nudge-type');
const nudgeStep = document.getElementById('nudge-step');
const offsetReadout = document.getElementById('offset-readout');

function populateNudgeTypes(data) {
  const cat = viewer.getCatalog();
  const types = [...new Set(data.elements.map((e) => e.type))].filter((t) => cat[t]);
  const prev = nudgeType.value;
  nudgeType.innerHTML = '';
  for (const t of types) nudgeType.appendChild(new Option(t + (t.startsWith('grid') ? ' (réf.)' : ''), t));
  const def = types.find((t) => !t.startsWith('grid')) || types[0];
  nudgeType.value = types.includes(prev) ? prev : def;
}

function updateOffsetReadout() {
  const t = nudgeType.value;
  if (!t) { offsetReadout.textContent = ''; return; }
  const o = viewer.getOffset(t);
  offsetReadout.innerHTML = `<b>${t}</b>.offset = { x:${o.x}, y:${o.y}, z:${o.z} } mm`;
}

function nudge(axis, dir) {
  const t = nudgeType.value;
  if (!t) return;
  const o = viewer.getOffset(t);
  const step = parseFloat(nudgeStep.value) || 1;
  const next = { ...o, [axis]: +(o[axis] + dir * step).toFixed(2) };
  const rep = viewer.setOffset(t, next);     // re-place et renvoie la validation
  if (rep) renderComposition(rep);
  updateOffsetReadout();
}

for (const btn of document.querySelectorAll('.nudge')) {
  btn.addEventListener('click', () => nudge(btn.dataset.axis, parseInt(btn.dataset.dir, 10)));
}
nudgeType.addEventListener('change', updateOffsetReadout);
document.getElementById('offset-reset').addEventListener('click', () => {
  const t = nudgeType.value;
  if (!t) return;
  const rep = viewer.setOffset(t, { x: 0, y: 0, z: 0 });
  if (rep) renderComposition(rep);
  updateOffsetReadout();
});
document.getElementById('offset-copy').addEventListener('click', () => {
  const json = JSON.stringify(viewer.getOffsets(), null, 2);
  copyToClipboard(json, 'offset.json');
  blockTitle('offset.json (à coller)');
  logHTML(`<pre style="white-space:pre-wrap;margin:0">${json.replace(/</g, '&lt;')}</pre>`);
});

// =============================================================================
// Affichage / export
// =============================================================================
let helpersVisible = true;
document.getElementById('toggle-helpers').addEventListener('click', (e) => {
  helpersVisible = !helpersVisible;
  viewer.setHelpersVisible(helpersVisible);
  viewer.setBoundingBoxVisible(helpersVisible); // la bbox bleue suit le toggle « Repères »
  e.target.textContent = helpersVisible ? 'Repères ✓' : 'Repères ✗';
});

document.getElementById('snapshot').addEventListener('click', async () => {
  const blob = await viewer.snapshotPNG();
  downloadBlob(blob, 'gassien-render.png');
});
document.getElementById('export-glb').addEventListener('click', async () => {
  try {
    const blob = await viewer.exportGLB();
    downloadBlob(blob, 'gassien-composition.glb');
    log('Composition exportée : gassien-composition.glb ✓', 'ok');
  } catch (e) {
    log('Export GLB échoué : ' + (e?.message || e), 'err');
  }
});

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
function copyToClipboard(text, label) {
  navigator.clipboard?.writeText(text).then(
    () => log(`${label} copié dans le presse-papier ✓`, 'ok'),
    () => log('Copie auto impossible — copie le bloc ci-dessous', 'warn')
  );
}

// =============================================================================
// Chargement schema (fetch + drag-drop)
// =============================================================================
async function loadSchema() {
  try {
    const res = await fetch('./schema.json');
    currentSchema = await res.json();
    applyFinishFromSchema(currentSchema.data); // finition d'affichage au chargement
  } catch (e) {
    log(`Impossible de charger schema.json : ${e.message}`, 'err');
  }
}
document.getElementById('reload-json').addEventListener('click', async () => { await loadSchema(); setMode('compo'); });
document.getElementById('json-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      currentSchema = JSON.parse(reader.result);
      applyFinishFromSchema(currentSchema.data);
      setMode('compo');
    } catch (err) { log(`JSON invalide : ${err.message}`, 'err'); }
  };
  reader.readAsText(file);
});

// Flèches clavier (mode composition) = décalage X/Y, PgUp/PgDn = Z.
window.addEventListener('keydown', (e) => {
  if (mode !== 'compo') return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const map = { ArrowLeft: ['x', -1], ArrowRight: ['x', 1], ArrowDown: ['y', -1], ArrowUp: ['y', 1], PageDown: ['z', -1], PageUp: ['z', 1] };
  const m = map[e.key];
  if (!m) return;
  e.preventDefault();
  nudge(m[0], m[1]);
});

// =============================================================================
// Démarrage
// =============================================================================
(async () => {
  await viewer.init();
  viewer.setBoundingBoxVisible(true); // POC : bbox bleue visible avec les repères
  populateFinishSelectors();
  syncFinishUI();
  await populateAuditSelect();
  await loadSchema();
  setMode('compo');
})();
