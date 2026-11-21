#!/usr/bin/env bash
# Installe fls globalement :
#   - binaire       ~/.local/share/fls/fls (compilé depuis src/fls.ts avec bun)
#   - wrapper       ~/.local/bin/fls
#   - PATH          ajouté à ~/.bashrc si absent
set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

DEST_DIR="$HOME/.local/share/fls"
BIN_DIR="$HOME/.local/bin"

command -v bun >/dev/null || { echo "bun manque : https://bun.sh"; exit 1; }
mkdir -p "$DEST_DIR" "$BIN_DIR"

bun build --compile src/fls.ts --outfile "$DEST_DIR/fls"

cat > "$BIN_DIR/fls" <<'EOF'
#!/usr/bin/env bash
exec "$HOME/.local/share/fls/fls" "$@"
EOF
chmod +x "$BIN_DIR/fls"

if ! grep -qF 'export PATH="$HOME/.local/bin:$PATH"' "$HOME/.bashrc" 2>/dev/null; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
  echo "PATH ajouté à ~/.bashrc : ouvre un nouveau terminal"
fi

"$BIN_DIR/fls" --version >/dev/null && echo "ok : fls installé" || { echo "fls --version a échoué"; exit 1; }
