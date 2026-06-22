# Intégrer une évolution dans le POC / moteur Gassien

**Règle générale**
- **Données** (composants / finitions / calibration) → fichiers JSON + assets
- **Logique moteur** → `gassien-viewer.js` (puis copier côté admin/B2C)
- **UI du POC** → `viewer.js` + `index.html`
- **Doc** (source de vérité) → `CLAUDE.md`

---

## 1. Nouveau composant 3D
- [ ] Modéliser le `.glb` (SketchUp : matériaux **nommés par rôle**, origine = coin gauche-bas-arrière) → déposer dans `glb/`
- [ ] Lancer `./clean-glb.sh` → génère `glb/done/<type>.glb`
- [ ] Ajouter l'entrée dans **`catalog.json`** :
  ```json
  { "anchor": "bottom", "depthLayer": 0.012, "slots": ["wood_face", "metal_structure"], "expect": { "sizeX": 0.4, "sizeY": 0.121, "sizeZ": 0.161 } }
  ```
  `depthLayer` = `0` pour une grille, `0.012` si monté devant ; `expect` en **mètres** (mesurés via l'audit) ou `null`.
- [ ] Ajouter l'entrée dans **`offset.json`** : `{ "x": 0, "y": 0, "z": 0 }` (mm)
- [ ] Vérifs : le `type` = nom du fichier glb = `type` du configurateur ; **présence dans `offset.json` obligatoire** (c'est la liste sondée en HEAD pour peupler l'audit)
- [ ] Calibrer l'offset via l'UI → **« Copier la table »** → coller dans `offset.json`

## 2. Nouvelle finition (bois ou métal)
- [ ] Ajouter l'entrée dans **`finishes.json`** (section `wood` ou `metal`) : `label`, `color` (hex) **ou** `maps` (par rôle), `params`
- [ ] Si texture bois : placer les images dans **`textures/`** + ajouter le nom à `WOOD_TEXTURE_FILES` dans `gassien-viewer.js`
- [ ] Calibrer via sliders → **« Copier les finitions »** → coller dans `finishes.json`

## 3. Nouveau rôle de matière (ex. `glass`)
- [ ] `gassien-viewer.js` : ajouter à `CANONICAL_ROLES` + une couleur dans `ROLE_DEBUG_COLOR`
- [ ] `gassien-viewer.js` : logique dans `_applyFinishes` (piloté ou **FIGÉ**)
- [ ] Convention SketchUp : nommer le matériau **exactement** par ce rôle

## 4. Tester une composition
- [ ] Remplacer `schema.json`, ou bouton **« Ouvrir… »** dans le POC

## 5. Évolution de logique moteur (placement, rendu, export, audit…)
- [ ] Modifier **uniquement** `gassien-viewer.js`
- [ ] Tester via le POC (Live Server)
- [ ] Copier `gassien-viewer.js` côté admin / B2C

## 6. Changer une constante / convention (échelle `S`, tolérance, `depthLayer`…)
- [ ] `gassien-viewer.js` **+** répercuter dans `CLAUDE.md`

---

> Le moteur (`gassien-viewer.js`) est la **source unique** de la logique 3D ; le POC le consomme
> (`viewer.js`/`index.html`). Pour l'intégration côté admin/B2C, voir [`INTEGRATION.md`](INTEGRATION.md).
