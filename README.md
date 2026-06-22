# Gassien — Viewer 3D (POC)

Moteur web (Three.js) de **visualisation et validation** des compositions Gassien :
charge une librairie de composants `.glb` (issus de SketchUp) + un JSON de composition,
assemble la scène en 3D, applique les finitions bois/métal et exporte un PNG fond transparent.

Outil destiné au backoffice (validation), réutilisable ensuite côté site B2C.
Le moteur sera intégré dans l'admin **GassienCalculFront** (React/JS).

> 📖 La documentation technique détaillée (conventions, faits mesurés, décisions) est dans [`CLAUDE.md`](CLAUDE.md) — **source de vérité**.

## Lancer

Aucun build, aucune dépendance npm. Il faut juste **servir les fichiers en HTTP local**
(`fetch` du JSON et des `.glb` ne marche pas en `file://`).

- VS Code : clic droit sur `index.html` → **Open with Live Server**.
- ou : `python3 -m http.server 8123` puis ouvrir http://localhost:8123

Three.js (r169) est chargé via importmap CDN.

## Deux modes

- **1 · Audit composant** — charge un `.glb` isolé, mesure la bbox (vs `expect`), affiche
  l'origine/pivot et la **conformité des matières** (noms de rôle, textures bakées). Sert à
  fiabiliser la modélisation SketchUp.
- **2 · Composition** — place les éléments du `schema.json`, signale les anomalies de
  placement, et permet de régler **décalages** et **finitions** en live, puis d'exporter un PNG.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | UI + importmap Three.js |
| `viewer.js` | moteur (monolithique) |
| `schema.json` | composition d'exemple |
| `catalog.json` | registre des composants (anchor, depthLayer, slots, expect) |
| `offset.json` | décalages de placement par composant (mm), persistants |
| `finishes.json` | finitions bois/métal + réglages texture, persistants |
| `glb/` | composants **à faire** (exports SketchUp bruts) |
| `glb/done/` | composants **nettoyés**, chargés par le viewer |
| `textures/` | textures bois (`oak_*`, `birch_*`, `wood_raw`) |
| `clean-glb.sh` | nettoyage `glb/` → `glb/done/` (prune/dedup/weld/resize via gltf-transform) |
| `gassien-viewer.js` | **moteur réutilisable** (classe `GassienViewer`, framework-agnostic) — source unique de la logique 3D ; le POC le consomme |
| `INTEGRATION.md` | guide d'intégration du moteur dans l'admin (React + Ant Design) |
| `EVOLUTIONS.md` | checklist : que fournir au POC pour chaque type d'évolution (composant, finition, rôle…) |

## Conventions clés

- **Échelle** : `S = 2.5 mm/unité` (constante unique).
- **Matières nommées par rôle** dans SketchUp (couleur plate, sans image bakée) :
  `wood_face`, `wood_edge`, `wood_raw`, `metal_structure`, `metal_hardware` (inox figé).
- **Placement** : origine `.glb` au coin gauche-bas-arrière ; correction par composant via `offset.json`.

## Nettoyage des glb

Place les exports SketchUp bruts dans `glb/`, puis :

```bash
./clean-glb.sh             # nettoie tous les glb/*.glb → glb/done/ (utilisés par le viewer)
MAXTEX=32 ./clean-glb.sh   # idem, textures réduites à 32px
```
