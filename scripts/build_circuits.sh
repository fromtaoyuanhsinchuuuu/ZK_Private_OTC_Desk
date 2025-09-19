#!/usr/bin/env bash
set -euo pipefail

# Compile Noir circuits and copy artifacts to web/lib/noir
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
CIRCUITS_DIR="$ROOT_DIR/circuits"
WEB_NOIR_DIR="$ROOT_DIR/web/lib/noir"

mkdir -p "$WEB_NOIR_DIR"

cd "$CIRCUITS_DIR"
for pkg in common solvency kyc_freshness whitelist_merkle; do
  echo "Compiling $pkg ..."
  cd "$pkg"
  nargo compile
  cd ..
  # Attempt to copy artifact named after the package; tolerate missing
  if [ -f "$pkg/target/$pkg.json" ]; then
    cp -f "$pkg/target/$pkg.json" "$WEB_NOIR_DIR/$pkg.json" || true
  else
    # fallback: find first json in target
    if [ -d "$pkg/target" ]; then
      found=$(ls -1 "$pkg/target"/*.json 2>/dev/null | head -n1 || true)
      if [ -n "$found" ]; then
        cp -f "$found" "$WEB_NOIR_DIR/$pkg.json" || true
      else
        echo "WARN: No JSON artifact found for $pkg in $pkg/target"
      fi
    else
      echo "WARN: No target folder for $pkg"
    fi
  fi
  echo "Done $pkg"

done
