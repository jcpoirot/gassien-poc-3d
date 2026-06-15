# CLAUDE.md — Moteur de visualisation/validation Gassien

## Objectif du projet

Construire un **moteur web (Three.js)** qui :
1. charge une **librairie de composants** `.glb` (issus de SketchUp) ;
2. lit un **JSON de composition** produit par le configurateur ;
3. **assemble la composition en 3D** (placement des composants en vue de face) ;
4. applique les **finitions** (bois / métal) à la volée ;
5. permet de **naviguer** (OrbitControls) et d'exporter un **PNG fond transparent** ;
6. fournit un **mode validation** qui contrôle chaque composant et chaque placement et signale les anomalies.

Cible : d'abord un outil de validation dans le backoffice, puis réutilisation du même moteur de rendu côté site B2C.

---

## ⚠️ Faits validés (ne pas re-deviner — mesurés en session)

### Format & unités
- Les composants sont modélisés dans **SketchUp** puis exportés en **`.glb`** (SketchUp 2025+ natif `File > Export > 3D Model > GLTF Binary`, ou plugin SimLab/Khronos).
- Les `.glb` sont en **mètres** (norme glTF) **une fois les transforms de nodes appliqués**. Pas de mise à l'échelle à l'import.
- ⚠️ **Piège mesuré** : les `accessor.min/max` glTF **bruts ne sont PAS en mètres** (SketchUp stocke la géométrie en pouces et applique une échelle pouce→m sur les nodes). Toujours mesurer la bbox via `THREE.Box3().setFromObject(model)` (qui applique les transforms), **jamais** via les accessors bruts.
- Repère monde : **X = largeur (droite)**, **Y = hauteur (haut)**, **Z = profondeur (vers le spectateur, hors du mur)**.

### Origine / pivot des composants
- Origine au **coin gauche-bas-arrière** : `min = (0, 0, 0)`, la géométrie s'étend vers `+X`, `+Y` (haut), `+Z` (avant).
- `Z = 0` = **plan du mur** (face arrière). Le composant pousse vers l'avant.
- ✅ **Confirmé par audit (2026-06-05, parsing direct des `.glb`)** : `gridGF` et `board40x15` ont bien leur pivot au coin gauche-bas-arrière (`min ≈ 0,0,0`). Tailles monde mesurées : `gridGF` **800×770×12 mm**, `board40x15` **400×121,1×161,1 mm** — conformes à `expect`. Matériaux conformes au mapping (`*1` ; `GASSIEN - Solid Oak` / `[Color M09]` / `[Steel Brushed Stainless]`).
- ⚠️ **Nœuds parasites présents** dans les deux `.glb` : `Active View`, `Scène 1`, `Rendu 3DW`, `Assembly-*`, `3DGeom-*`. Sans mesh utile pour la plupart → inoffensifs pour la bbox, mais à **purger au pipeline** (cf. section Pipeline assets).

### Dimensions de référence (mesurées)
- `board40x15.glb` : **400 × 121 × 161 mm** (X×Y×Z). Le « 40 » du SKU = 400 mm en X.
- `gridGF.glb` : **800 × 770 × 12 mm** (panneau de grille, fin).

### Calibration coordonnées JSON → monde
**`S = 2.5 mm/unité`** (= `0.0025 m/unité`). Vérifié :
- grille `width = 320` unités × 2.5 = **800 mm** ✓
- grille `height = 308` unités × 2.5 = **770 mm** ✓

`S` doit être **une constante unique** de config. Ne pas la dériver des noms de SKU (non linéaire).

### Matériaux → rôles (slots) — STRATÉGIE NOMMAGE (décidée 2026-06-05)
**Le NOM du matériau SketchUp == son RÔLE** (identité), avec une **couleur plate, AUCUNE texture incrustée**. Le moteur applique la finition au runtime selon ce nom — pas d'image bakée dans le `.glb`.

Rôles canoniques (= nom exact à donner au matériau dans SketchUp) :

| Nom matériau = rôle  | Usage                                             | Pilotable ?                |
|----------------------|---------------------------------------------------|----------------------------|
| `wood_face`          | faces dessus/dessous (placage contreplaqué, plateau) | oui (`woodColor`)       |
| `wood_edge`          | chants (contreplaqué)                             | oui (`woodColor`)          |
| `wood_raw`           | bois brut (ex. tubes hêtre)                       | oui (`woodColor`)          |
| `metal_structure`    | structure métal peinte                            | oui (`metalColor`)         |
| `metal_hardware`     | visserie                                          | **NON — inox figé**        |

(`wood` générique encore toléré pour bois massif/compat.)

- **Règle absolue** : `metal_hardware` (la visserie) **ne change jamais**, quelle que soit la finition.
- **Alias hérités** (glb actuels, à renommer dans SketchUp) gérés par le moteur le temps de la transition : `GASSIEN - Solid Oak`→`wood_face`, `[Color M09]`→`metal_structure`, `*1`→`metal_structure`, `[Steel Brushed Stainless]`→`metal_hardware`. L'**audit Mode 1** signale chaque matériau à RENOMMER / À NOMMER et toute **texture bakée à retirer**.

### UV (sens du fil) — nuance bois vs métal
Les UV (`TEXCOORD_0`) vivent sur le **maillage**, pas sur l'image. Constat mesuré : seules les faces où une **image a été appliquée + positionnée** dans SketchUp ont des UV (chêne, inox en avaient ; les couleurs unies `[Color M09]`, `*1` n'en ont pas).
- **Rôles métal** (`metal_structure`, `metal_hardware`) : **couleur unie, pas d'image, pas d'UV** nécessaires (rendu uniforme/réfléchissant). Aucun fichier dans SketchUp.
- **Rôles bois** (`wood_face`/`wood_edge`/`wood_raw`) : le **fil a un sens** → il FAUT des UV. Méthode SketchUp : appliquer une image bois (placeholder), **clic droit face → Texture → Position** (4 épingles) pour orienter le fil (longueur de la planche ; sens de la tranche pour `wood_edge`), puis valider. Le matériau reste **nommé par rôle**.
- **Conciliation « glb léger »** : exporter avec les UV + l'image, puis **réduire/retirer l'image au nettoyage** (les UV restent) ; le moteur ré-applique la vraie texture bois au runtime sur ces UV. ⚠️ pour la phase finitions runtime : veiller à ce que `gltf-transform prune` ne supprime pas `TEXCOORD_0` (garder une référence texture minimale ou flag adéquat).

---

## Structure du JSON de composition

```jsonc
{
  "data": {
    "metalColor": "black",   // finition métal GLOBALE (s'applique à metal_structure)
    "woodColor":  "black",   // finition bois GLOBALE (s'applique à wood / wood_face / wood_edge)
    "res": 6, "baseRes": 3.5, "vRes": 2,   // logique de grille du configurateur (non utilisée pour le placement)
    "elements": [
      {
        "id": 0,
        "type": "gridGF",     // clé du registre composant
        "x": 80, "y": 44,     // coin HAUT-GAUCHE, unités configurateur, Y vers le BAS
        "width": 320, "height": 308   // empreinte 2D : placement + validation, JAMAIS pour redimensionner
      }
    ]
  }
}
```

**Règle d'or** : la taille réelle vient du `.glb`. Les `width/height` du JSON servent à *positionner* et à *valider* (logguer un écart si le footprint diffère trop), jamais à scaler le modèle.

---

## Mapping coordonnées 2D → 3D

```js
const S = 0.0025;                          // m / unité (constante validée)
const H_MAX = Math.max(...elements.map(e => e.y + e.height));  // réf. pour inverser Y

function worldPosition(el, assetMeta) {
  const X = el.x * S;                      // coin gauche
  // Y : le JSON donne le BORD HAUT (convention top-left, Y vers le bas)
  const yTop = (H_MAX - el.y) * S;         // hauteur monde du bord haut de l'élément
  let Y, Z;
  if (assetMeta.anchor === 'bottom') {     // origine .glb en bas → caler le haut
    Y = yTop - assetMeta.sizeY;            // sizeY = hauteur bbox du modèle
  } else {                                 // origine .glb en haut (crochet)
    Y = yTop;
  }
  Z = assetMeta.depthLayer;                // grille = 0 ; éléments montés devant = épaisseur grille (0.012)
  return new THREE.Vector3(X, Y, Z);
}
```

Conventions retenues (à reconfirmer en validation) :
- `gridGF` : origine en bas-gauche, `depthLayer = 0`.
- `board40x15` : origine en bas, on cale le **crochet (haut)** sur `yTop` ; `depthLayer = 0.012` (devant la grille).

### Décalage par composant (`offset`) — décision actée (2026-06-05)
On **ne change PAS l'origine SketchUp** (elle est propre : coin gauche-bas-arrière). À la place, chaque composant porte un **`offset` de placement en millimètres** `{x, y, z}` (x droite+, y haut+, z=profondeur/avant+), appliqué **après** `worldPosition`. Voir `worldPosition` dans `viewer.js` (conversion mm→m).

**Source de vérité persistante = `offset.json`** (à la racine, chargé à l'init). Il liste **tous** les composants du configurateur (cf. `allComponents`) ; en ajouter un = ajouter une entrée. Le `CATALOG`/`viewer.js` ne sert que de défaut ; `offset.json` écrase.

Calibration **visuelle** : mode Composition → panneau « Réglage décalage / grille » → boutons X/Y/Z ± (pas 0,5/1/2/5/10 mm, défaut 1) ou flèches clavier (X/Y) + PgUp/PgDn (Z). Lecture live `type.offset = {x,y,z} mm`, validation du débord recalculée en direct. Bouton **« Copier la table »** → **JSON complet** à coller dans `offset.json`.

🔑 **Lien avec le configurateur (mesuré)** : les champs `offsetX/offsetY/offsetWidth/offsetHeight` des composants 2D **expliquent le placement**. Ex. `board40x15` a `offsetX = 24` ⇒ `24 × S(2,5) = 60 mm` = exactement le débord constaté. **Caler `board40x15.offset.x = 60` aligne parfaitement les planches sur la grille (débord → 0).** C'est la **seule valeur calibrée à ce jour**.

**Décision (2026-06-05)** : on **ne pré-remplit PAS** les autres planches depuis `offsetX × 2,5`. Bien que `offsetX` semble encoder la position réelle (donc *a priori* variable : board60x15→40, board80x15→60…), une seule planche a un glb et est vérifiée. Toutes les autres planches (`board*`, `desk*`, `wardrobe*`) restent à **0** dans `offset.json` et seront **calibrées une par une** quand leur glb existera. Le sens de `offsetY` / `offset*Height` (axe Y) reste aussi à valider visuellement.

---

## Registre des composants (à construire et compléter)

```js
// type -> asset + métadonnées validées
const CATALOG = {
  gridGF: {
    glb: 'gridGF.glb',
    slots: ['metal_structure'],
    anchor: 'bottom', depthLayer: 0,
    offset: { x: 0, y: 0, z: 0 },                          // décalage mm, calibré via l'UI
    expect: { sizeX: 0.800, sizeY: 0.770, sizeZ: 0.012 },  // pour la validation
  },
  board40x15: {
    glb: 'board40x15.glb',
    slots: ['wood', 'metal_structure', 'metal_hardware'],
    anchor: 'bottom', depthLayer: 0.012,
    offset: { x: 0, y: 0, z: 0 },
    expect: { sizeX: 0.400, sizeY: 0.121, sizeZ: 0.161 },
  },
  // board40x20, board60x20, potHolder_11_with_pot, ... à ajouter
};
```

Chaque composant **déclare ses slots** : le moteur sait alors quoi piloter et quoi laisser figé.

---

## Finitions (swap au runtime) — implémenté

Sélecteur **Finitions** en mode Composition (`index.html`/`viewer.js`) : applique en live une finition **bois** et **métal** sur la composition. `applyFinishes(model)` clone le matériau (jamais muter le partagé), pilote `wood*` via la finition bois et `metal_structure` via la finition métal ; `metal_hardware` jamais touché (inox figé).

**Persistance** : `finishes.json` (racine) est chargé à l'init et **écrase** les défauts de `viewer.js` (`loadFinishes`). Workflow identique aux offsets : régler via sliders/sélecteurs → bouton **« Copier les finitions »** → coller dans `finishes.json`. Couleurs en hex.

Set de finitions (`WOOD_FINISHES` / `METAL_FINISHES`, surchargés par `finishes.json`) :

**Bois** (`woodFinish`) :
- **Chêne Massif** (`oak`) : maps par rôle `wood_face→oak_face.jpg`, `wood_edge→oak_edge.jpg`, `wood_raw→wood_raw.jpg` (face et tranche identiques).
- **Bouleau CP** (`birch`) : `wood_face→birch_face.jpg`, `wood_edge→birch_edge.jpg`, `wood_raw→wood_raw.jpg` (face ≠ tranche).
- **Noir**, **Blanc** : couleur unie sur tous les rôles bois.
- **Couleur perso** : sélecteur `Couleur bois`.

**Métal** (`metalFinish`) : **Noir**, **Blanc** (peinture, `metalness 0`, pas du chrome), **Laiton**, + **Couleur perso** (`Couleur métal`).

**Textures** : fichiers attendus dans `textures/` = `oak_face/oak_edge`, `birch_face/birch_edge`, `wood_raw` (.jpg), **préchargés à l'init** (`preloadTextures`). Chargement via `getTexture()` (cache, `colorSpace = SRGBColorSpace`, `wrapS/T = RepeatWrapping`, `anisotropy = getMaxAnisotropy()`). Les UV viennent du `.glb` (positionnées dans SketchUp → sens du fil). `wood_raw` utilise toujours `wood_raw.jpg` ; un rôle bois absent des maps retombe sur `wood_face`.

**Réglages texture bois** — `params` **par essence** (`WOOD_FINISHES[x].params`), éditables via sliders (se re-synchronisent au changement d'essence) :
- **Échelle** (`repeat`) : répétition du motif sur les UV — corrige une texture étirée/zoomée.
- **Luminosité** (`brightness`) : multiplie l'albédo (`m.color.setScalar`, <1 assombrit) — corrige un bois trop clair.
- **Rugosité** (`roughness`) et **Reflets env.** (`envMapIntensity`) : brillance / éclaircissement par l'environnement (par matériau, n'affecte pas le métal).
- Défauts calibrés : **Chêne** `repeat 3.3, brightness 0.45, roughness 0.50, env 0.4` ; **Bouleau** `5.9 / 0.45 / 0.25 / 0.4`.

Pièges retenus : `m.map = null` pour une finition unie ; `woodColor`/`metalColor` du JSON = **finition par défaut** à l'ouverture (`initFinishesFromJSON`) ; visserie `metal_hardware` jamais touchée.

---

## Moteur de validation (le livrable de cette étape)

Deux modes :

### Mode 1 — Audit des composants
Pour chaque `.glb` du `CATALOG` :
- charge et vérifie qu'il parse ;
- mesure la **bbox** → compare à `expect` (tolérance ~2 mm), signale tout écart d'échelle ;
- vérifie que l'**origine** est au coin attendu (gauche-bas-arrière) ;
- liste les **noms de matériaux** et vérifie qu'ils ont tous un rôle dans `ROLE_BY_MATERIAL` (sinon : warning « rôle manquant ») ;
- indique si des **textures de finition** sont encore incrustées (devraient être génériques) ;
- rend une **vignette** par composant (3/4) colorée par slot.

### Mode 2 — Validation de composition
- charge un JSON, place tous les éléments via `worldPosition` ;
- applique `woodColor`/`metalColor` ;
- affiche en Three.js (OrbitControls), avec repères : axes monde, plan du mur (Z=0), bbox globale ;
- signale les **anomalies de placement** : composant hors de la grille, chevauchement anormal, écart entre footprint JSON et bbox réelle ;
- bouton **snapshot PNG transparent** (rendu ×2–3, `ShadowMaterial` pour l'ombre de contact).

### Setup Three.js
- `WebGLRenderer({ antialias:true, alpha:true, preserveDrawingBuffer:true })`, `setClearColor(0,0)`.
- `outputColorSpace = SRGBColorSpace`, `toneMapping = ACESFilmicToneMapping`.
- Environnement studio (`RoomEnvironment` ou HDRI) pour l'éclairage/reflets.
- Cache des `.glb` par `type` + **clone** pour les composants répétés ; `InstancedMesh` si une composition devient lourde ; `dispose()` au démontage.

---

## Problèmes connus à résoudre (constatés sur la 1ʳᵉ composition)

1. **Débord planche / grille** : avec `board.x=56` et `grid.x=80`, la planche dépasse ~60 mm à gauche de la grille. Déterminer si c'est voulu (overhang) ou si l'**ancre X du board doit être au crochet** (et non au bord gauche du plateau). À trancher en regardant la logique du configurateur.
2. **`height` JSON vs hauteur réelle** : `board.height=84` → 210 mm avec `S`, alors que la bbox du modèle fait 121 mm en Y. Clarifier ce que représente `height` (hauteur physique ? réservation verticale dans la grille ?) pour caler l'ancre Y proprement.
3. **Point d'ancrage** : confirmer, dans SketchUp, l'origine exacte (crochet arrière-gauche recommandé) et la reproduire à l'identique sur tous les composants — c'est ce qui garantit le placement sans offset en code.

---

## Nettoyage glb (pipeline)

Objectif : `.glb` **léger, sans texture bakée, matériaux nommés par rôle, sans nœud parasite**.

**Dans SketchUp (avant export)** — l'essentiel = les NOMS, pas les images :
1. **Renommer chaque matériau par son rôle** (`wood_face`/`wood_edge`/`wood_raw`/`metal_structure`/`metal_hardware`) — cf. tableau plus haut.
2. **Métal** = couleur unie (pas d'image, pas d'UV). **Bois** = image (placeholder) + *Texture → Position* pour figer le **sens du fil** (UV). Pas besoin de reconvertir le bois en couleur plate : le poids des images est géré au nettoyage (voir ci-dessous).
3. Assigner les matériaux aux bonnes faces ; vérifier l'orientation des faces.
4. **Supprimer scènes / onglets de vue** (sinon nœuds parasites `Scène 1` / `Active View` / `Rendu 3DW`) ; **purger** matériaux/composants inutilisés.
5. Garder l'**origine au coin gauche-bas-arrière** ; nom de sortie = `type` du JSON.

**Dossiers** : `glb/` = composants **à faire** (exports bruts) ; `glb/done/` = composants **nettoyés**, **chargés par le viewer** (`GLB_DIR = 'glb/done/'`).

**Après export** — script `./clean-glb.sh` (sans argument : nettoie tous les `glb/*.glb` ; utilise `npx @gltf-transform/cli`) :
- `prune` (retire accessors/matériaux/**nœuds vides** orphelins) → nettoie les parasites,
- `dedup` (fusionne dupliqués), `weld` (soude les sommets),
- `resize` (**réduit les textures à 64 px**, surchargeable `MAXTEX=32`) → **les UV restent sur le maillage**, le poids chute (mesuré : `board40x15` 1,66 Mo → **244 Ko**),
- lit les bruts dans `glb/`, écrit les nettoyés dans `glb/done/`, logge taille avant/après.

**Contrôle final** : ouvrir le glb nettoyé dans le viewer (Mode 1 Audit) → section **« Conformité matières »** : tous les noms en `OK conforme`. Une texture bois (porteuse d'UV) est normale ; seul un nom non conforme est bloquant.

## Lancer le POC

- Fichiers : `index.html` (UI + importmap CDN Three.js r169) + `viewer.js` (moteur monolithique) + `schema.json` (composition) + `offset.json` (décalages persistants) + `finishes.json` (finitions persistantes) + `clean-glb.sh` (nettoyage glb). Aucun build, aucune dépendance npm.
- **Live Server** sur `index.html` (clic droit → « Open with Live Server »). Il faut un serveur HTTP local : `fetch('./schema.json')`, `fetch('./offset.json')` et les `.glb` ne se chargent pas en `file://`.
- UI : bascule **1·Audit composant** / **2·Composition** ; recharger/ouvrir un JSON ; toggle repères ; bouton **PNG transparent**.
- Le moteur recopie les constantes de ce fichier (`S`, `CATALOG`, rôles/alias matières, finitions). **Ce CLAUDE.md reste la source de vérité** — toute correction de constante doit être répercutée dans `viewer.js`.
- Découpage en modules ES (pour réutilisation dans `GassienCalculFront` React) prévu plus tard ; v1 volontairement monolithique.

## Ordre de travail recommandé
1. Mode 1 (audit) sur `gridGF` + `board40x15` → fiabiliser origines/échelle/rôles. ✅ origines/échelle/rôles confirmés (2026-06-05).
2. Résoudre les 3 problèmes connus de placement.
3. Mode 2 sur la composition `ICHIGO` (3 planches + grille).
4. Ajouter les composants restants (`board40x20`, `board60x20`, `potHolder_11_with_pot`).
5. Finitions + snapshot.
6. Réutilisation côté B2C.