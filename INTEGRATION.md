# Intégration du moteur 3D dans l'admin Gassien Paris (React + Ant Design)

Guide pour le Claude Code de l'admin. Le moteur est **`gassien-viewer.js`** : une classe
`GassienViewer` **framework-agnostic** (zéro UI), extraite du POC. La couche React/AntD
construit l'UX et appelle l'API. Ce document décrit quoi copier, comment servir les assets,
l'API, les formats de données, et un squelette d'intégration React.

---

## 1. Ce qu'on récupère du POC

| À copier dans l'admin | Rôle |
|---|---|
| `gassien-viewer.js` | **le moteur** (la seule logique à réutiliser) |
| `catalog.json` | métadonnées composants (anchor, depthLayer, slots, expect) |
| `offset.json` | décalages de placement par composant (mm) |
| `finishes.json` | finitions bois/métal + réglages |
| `glb/done/*.glb` | composants 3D nettoyés (servis en statique) |
| `textures/*.jpg` | textures bois (`oak_*`, `birch_*`, `wood_raw`) |

**À NE PAS reprendre** : `index.html`, `viewer.js`, `clean-glb.sh` (pipeline asset, reste côté POC),
tout le panneau UI. L'admin refait l'UX avec Ant Design.

> `viewer.js` (POC) et `gassien-viewer.js` partagent la même logique ; le POC reste la
> **référence/démo qui tourne**. Pour l'admin, seul `gassien-viewer.js` compte.

---

## 2. Dépendance & assets

- **Three.js en dépendance npm** (le moteur fait `import * as THREE from 'three'` + addons ;
  plus d'importmap CDN). `npm i three` (testé avec **r0.169**). Un bundler (Vite/CRA) résout.
- **Assets servis en statique** (dossier public). Le moteur fetch tout sous un `assetBaseUrl`.
  Arborescence attendue **identique** à celle du POC :

```
<assetBaseUrl>/
  catalog.json   offset.json   finishes.json
  glb/done/<type>.glb
  textures/<oak_face|oak_edge|birch_face|birch_edge|wood_raw>.jpg
```

  Ex. si tu mets tout sous `public/gassien/`, alors `assetBaseUrl = '/gassien/'`.
  (Les 3 JSON peuvent aussi être **injectés** déjà parsés, cf. constructeur — utile si l'admin
  les sert via son API plutôt qu'en fichiers.)

---

## 3. API de `GassienViewer`

```js
import { GassienViewer } from './gassien-viewer.js';

const viewer = new GassienViewer(canvasEl, {
  assetBaseUrl: '/gassien/',     // défaut './'
  helpers: false,                // axes/mur/sol de validation (défaut true)
  panKeys: true,                 // pan H/Espace + glisser (défaut true)
  defaultFinish: { wood: 'birch', metal: 'black' },
  // catalog / offsets / finishes : objets déjà parsés (sinon fetchés sous assetBaseUrl)
});
await viewer.init();             // charge config + précharge textures
```

### Composition (mode principal admin)
```js
const report = await viewer.loadComposition(schemaJSON);  // cf. format §4
//   report = { elementCount, gridCount, elements:[…], errors:[…] }
viewer.frame();                                            // recadre la caméra
```

### Finitions (live)
```js
viewer.getWoodFinishes();   // { oak:{label,…}, birch, black, white } -> peupler un <Select>
viewer.getMetalFinishes();  // { black, white, brass }
viewer.setWoodFinish('oak');            // ou { color: '#a8743f' }
viewer.setMetalFinish('brass');         // ou { color: '#c2a86e' }
viewer.setWoodParams({ repeat: 3.3, brightness: 0.45 });   // sliders texture bois
viewer.setMetalParams({ metalness: 0.2, roughness: 0.5 }); // sliders métal
```

### Audit composant (outil validation)
```js
const a = await viewer.audit('board60x15');   // affiche le composant + retourne les données (§4)
const list = await viewer.listComponents();   // string[] des glb présents dans glb/done/
```

### Décalages de placement (calibration)
```js
viewer.getOffset('board40x15');                 // { x, y, z } en mm
viewer.setOffset('board40x15', { x: 60, y: -47, z: -10 });
viewer.getOffsets();                            // table complète (à persister si calibrage admin)
```

### Affichage & export
```js
viewer.setHelpersVisible(false);                // masquer les repères de validation
const pngBlob = await viewer.snapshotPNG();     // PNG fond transparent, sans repères
const glbBlob = await viewer.exportGLB();       // GLB de la compo (objets + finitions)
await viewer.copyPNGToClipboard();              // copie le PNG dans le presse-papier
viewer.compositionName();                       // slug du titre (ex. 'ma-compo') pour nommer le download
```

### Cycle de vie
```js
viewer.resize();    // auto via ResizeObserver, mais dispo manuellement
viewer.dispose();   // OBLIGATOIRE au démontage React (libère WebGL, listeners, textures)
```

---

## 4. Formats de données

**Schema de composition** (produit par ton configurateur — inchangé) :
```jsonc
{ "data": {
  "woodColor": "black", "metalColor": "black",
  "elements": [
    { "id": 0, "type": "gridGF", "x": 80, "y": 44, "width": 320, "height": 308 }
  ]
}}
```
`type` = clé du catalogue ; `x/y` = coin haut-gauche en unités configurateur (Y vers le bas) ;
`width/height` = empreinte 2D (placement + validation, **jamais** pour scaler). Échelle `S = 2.5 mm/unité`.

**Retour `loadComposition`** :
```js
{ elementCount, gridCount,
  elements: [ { id, type, footprint:{w,h}, bbox:{w,h,d}, footprintDelta:{w,h},
               overhang:{L,R,T,B}|null } ],   // débord vs grille en mètres (0 si dans la grille)
  errors: [ "Type absent du CATALOG : …" ],
  unknownTypes: [ "…" ],   // types absents du catalogue (→ bannière d'avertissement, cf. §7)
  missingGlb:   [ "…" ] }  // dans le catalogue mais glb non chargeable
```

**Retour `audit`** :
```js
{ type, inCatalog,
  dimensions: [ { axis:'X', measured, expected|null, delta|null, status:'ok'|'warn'|'info' } ],
  origin: { min:{x,y,z}, max:{x,y,z}, atCorner:boolean },   // mètres
  materials: [ { name, role|null, count, status:'ok'|'rename'|'default'|'unknown', baked } ],
  recap: { ok, rename, todo, baked } }
```
(Toutes les longueurs sont en **mètres** ; formate en mm côté UI : `m*1000`.)

**Specs de finition** : clé string (`'oak'`, `'black'`, `'brass'`…) ou `{ color: '#rrggbb' }`.

---

## 5. Squelette React (à implémenter côté admin)

Le moteur n'impose rien : un composant qui crée le viewer au montage, le `dispose()` au démontage.

```jsx
import { useEffect, useRef } from 'react';
import { GassienViewer } from '@/lib/gassien-viewer';

export function Viewer3D({ schema, wood, metal, onReport }) {
  const canvasRef = useRef(null);
  const viewerRef = useRef(null);

  useEffect(() => {                          // montage : une seule fois
    let disposed = false;
    const v = new GassienViewer(canvasRef.current, { assetBaseUrl: '/gassien/', helpers: false });
    viewerRef.current = v;
    v.init().then(() => { if (!disposed && schema) v.loadComposition(schema).then(onReport); });
    return () => { disposed = true; v.dispose(); };
  }, []);

  useEffect(() => {                          // schema change
    const v = viewerRef.current;
    if (v && schema) v.loadComposition(schema).then(onReport);
  }, [schema]);

  useEffect(() => { viewerRef.current?.setWoodFinish(wood); }, [wood]);
  useEffect(() => { viewerRef.current?.setMetalFinish(metal); }, [metal]);

  return <div style={{ width: '100%', height: '100%' }}><canvas ref={canvasRef} /></div>;
}
```
Le `<canvas>` doit avoir un **parent dimensionné** (le moteur observe `canvas.parentElement`).
Boutons AntD → `viewer.snapshotPNG()` / `viewer.exportGLB()` (déclenche un download depuis le Blob).

---

## 6. Pièges / notes

- **Next.js** : le viewer est client-only → `dynamic(() => import(...), { ssr: false })` (WebGL/`window`).
- **`dispose()` impératif** au démontage (sinon fuite de contextes WebGL au fil des navigations).
- **GLB exporté lourd** (~25 Mo : textures bois pleine résolution embarquées). Si besoin côté
  admin : réduire les textures avant export, ou exporter en .gltf + textures séparées.
- **`helpers`** (axes/mur/sol + bbox) sont des aides de **validation** ; en B2C, `helpers:false`.
- **Matières figées** : `metal_hardware` (inox), `glass` (verre transparent), `wood_raw` (texture
  hêtre) ne suivent JAMAIS les finitions — c'est voulu (cf. CLAUDE.md).
- **Convention matières** : le moteur mappe par **nom de matériau SketchUp = rôle** ; les nouveaux
  glb doivent être nommés par rôle (`wood_face`/`wood_edge`/`wood_raw`/`metal_structure`/
  `metal_hardware`/`glass`). L'audit signale les non-conformités.
- Les **constantes/conventions** (échelle `S`, rôles, placement) sont documentées dans `CLAUDE.md`.

---

## 7. UX attendue côté Maker (admin)

Points demandés, et comment les réaliser avec le moteur :

1. **Changer une couleur ne réinitialise PAS la vue** — déjà géré : `setWoodFinish` /
   `setMetalFinish` / `setWoodParams` / `setMetalParams` **ré-appliquent les matériaux sur
   place** (pas de rebuild, caméra figée). Rien à faire côté admin.

2. **Légende des raccourcis clavier (en bas à gauche du viewer)** — à afficher par l'admin
   (le moteur gère les touches ; l'admin montre la légende) :
   > Glisser = rotation · Molette = zoom · **H** ou **Espace** + glisser = panoramique
   (Les flèches/PgUp/PgDn servent au calibrage des décalages — à n'exposer qu'en mode admin/validation.)

3. **Copier l'image dans le presse-papier** — bouton AntD →
   ```js
   await viewer.copyPNGToClipboard();   // ou : const b = await viewer.snapshotPNG();
                                         //       navigator.clipboard.write([new ClipboardItem({'image/png': b})])
   ```
   (Nécessite un contexte sécurisé : https ou localhost.)

4. **Nom du fichier PNG/GLB = titre de la composition** — le moteur retourne un Blob ; l'admin
   nomme le download :
   ```js
   const blob = await viewer.snapshotPNG();        // ou exportGLB()
   const a = Object.assign(document.createElement('a'),
     { href: URL.createObjectURL(blob), download: viewer.compositionName() + '.png' });
   a.click();
   ```
   `compositionName()` = slug de `schema.data.title` (sinon `'composition'`). Helper `slugify` aussi exporté.

5. **Avertissement si un composant n'est pas au catalogue, à l'ouverture du 3D** — `loadComposition`
   retourne `unknownTypes` (et `missingGlb`). Affiche une **bannière AntD** (`<Alert type="warning">`)
   si non vide :
   ```js
   const rep = await viewer.loadComposition(schema);
   if (rep.unknownTypes.length) showWarning(`Composants non modélisés : ${rep.unknownTypes.join(', ')}`);
   ```
   Ces composants ne sont pas affichés en 3D (le reste de la compo l'est).
