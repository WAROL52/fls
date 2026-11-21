#!/usr/bin/env bash
# usage: ./install-fls.sh /chemin/vers/fls.ts
set -euo pipefail

SRC="$(realpath "${1:?usage: install-fls.sh /chemin/vers/fls.ts}")"
DEST_DIR="$HOME/.local/share/fls"
BIN_DIR="$HOME/.local/bin"

command -v node >/dev/null || { echo "node manque"; exit 1; }
[ -f "$SRC" ] || { echo "fichier absent: $SRC"; exit 1; }

mkdir -p "$DEST_DIR" "$BIN_DIR"

# un seul fichier JS, deps incluses
npx --yes esbuild "$SRC" --bundle --platform=node --format=esm --target=node20 \
  --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" \
  --outfile="$DEST_DIR/fls.mjs"

cat > "$BIN_DIR/fls" <<'EOF'
#!/usr/bin/env bash
exec node "$HOME/.local/share/fls/fls.mjs" "$@"
EOF
chmod +x "$BIN_DIR/fls"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
     echo "PATH ajouté à ~/.bashrc : ouvre un nouveau terminal" ;;
esac

"$BIN_DIR/fls" help >/dev/null && echo "ok : fls installé" || echo "fls help a échoué"
