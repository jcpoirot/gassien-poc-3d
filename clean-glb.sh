#!/usr/bin/env bash
# =============================================================================
# clean-glb.sh — nettoyage d'un .glb exporté depuis SketchUp
#
# Convention dossiers :
#   glb/        = composants À FAIRE (exports SketchUp bruts) — source par défaut
#   glb/done/   = composants NETTOYÉS — utilisés par le viewer
#
# Usage :   ./clean-glb.sh                       # nettoie les glb/*.glb -> glb/done/
#           ./clean-glb.sh glb/board40x15.glb    # un fichier précis
#           FORCE=1 ./clean-glb.sh               # refait même ceux déjà à jour
#
# Un composant déjà présent et À JOUR dans glb/done/ (sortie pas plus ancienne que
# la source) est IGNORÉ — pour ne pas tout refaire à chaque fois. FORCE=1 force.
#
# Fait, via @gltf-transform/cli (téléchargé à la demande par npx) :
#   - prune  : retire accessors / matériaux / textures / NŒUDS VIDES orphelins
#              (nettoie les parasites SketchUp type "Active View", "Scène 1")
#   - dedup  : fusionne géométries / matériaux / textures dupliqués
#   - weld   : soude les sommets identiques (allège la géométrie)
#   - resize : RÉDUIT les textures bakées à MAXTEX px (poids) en CONSERVANT
#              les UV du maillage. Pas besoin de retirer les textures à la main
#              dans SketchUp : l'apparence des rôles pilotés est remplacée au
#              runtime ; seules les UV (sens du fil bois) comptent, et elles
#              vivent sur le maillage, pas sur l'image.
# Écrit le résultat dans glb/done/<nom>.glb et logge un rapport avant/après.
#
# Régler la taille max des textures : MAXTEX=32 ./clean-glb.sh
# =============================================================================
set -euo pipefail

GLTF="npx --yes @gltf-transform/cli"
SRCDIR="glb"
OUTDIR="glb/done"
MAXTEX="${MAXTEX:-64}"   # taille max (px) des textures après nettoyage
mkdir -p "$OUTDIR"

# Compte les images embarquées d'un glb (via `inspect`), 0 si indispo.
count_images () {
  $GLTF inspect "$1" 2>/dev/null | grep -iE "textures|images" | grep -oE "[0-9]+" | head -1 || echo "?"
}

human () { # taille lisible
  if command -v numfmt >/dev/null 2>&1; then numfmt --to=iec "$1"; else echo "${1}o"; fi
}

# Sans argument : nettoie tous les .glb du dossier source (glb/), pas ceux de glb/done/.
if [ "$#" -eq 0 ]; then
  shopt -s nullglob
  set -- "$SRCDIR"/*.glb
  shopt -u nullglob
  [ "$#" -gt 0 ] || { echo "Aucun .glb à nettoyer dans $SRCDIR/"; exit 0; }
fi

for SRC in "$@"; do
  [ -f "$SRC" ] || { echo "✗ introuvable: $SRC"; continue; }
  NAME="$(basename "$SRC")"
  OUT="$OUTDIR/$NAME"
  BEFORE=$(wc -c < "$SRC")

  # déjà nettoyé et à jour (sortie pas plus ancienne que la source) -> on saute.
  # FORCE=1 ./clean-glb.sh pour tout refaire.
  if [ -z "${FORCE:-}" ] && [ -f "$OUT" ] && [ ! "$SRC" -nt "$OUT" ]; then
    echo "⏭  $NAME déjà dans $OUTDIR/ (à jour) — ignoré"
    continue
  fi

  echo "──────────────────────────────────────────────"
  echo "▶ $SRC"
  $GLTF prune  "$SRC" "$OUT" >/dev/null
  $GLTF dedup  "$OUT" "$OUT" >/dev/null
  $GLTF weld   "$OUT" "$OUT" >/dev/null
  # réduit les textures bakées (poids) ; UV conservées sur le maillage
  $GLTF resize "$OUT" "$OUT" --width "$MAXTEX" --height "$MAXTEX" >/dev/null 2>&1 || true

  AFTER=$(wc -c < "$OUT")
  IMG=$($GLTF inspect "$OUT" 2>/dev/null | grep -ciE "image/jpeg|image/png" || true)

  echo "  taille : $(human "$BEFORE") → $(human "$AFTER")"
  echo "  sortie : $OUT"
  if [ "${IMG:-0}" -gt 0 ]; then
    echo "  ℹ $IMG texture(s) réduite(s) à ${MAXTEX}px max (UV conservées)."
  else
    echo "  ✓ aucune texture embarquée."
  fi
done
echo "──────────────────────────────────────────────"
echo "Terminé. Vérifie les fichiers dans $OUTDIR/ (audit Mode 1 du viewer)."
