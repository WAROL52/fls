#!/usr/bin/env bash
# Désinstalle fls : supprime le wrapper ~/.local/bin/fls, le binaire
# ~/.local/share/fls/fls et l'entrée PATH ajoutée dans ~/.bashrc.
set -euo pipefail

DEST_DIR="$HOME/.local/share/fls"
BIN_DIR="$HOME/.local/bin"
BASHRC="$HOME/.bashrc"
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'

rm -f "$BIN_DIR/fls"
rm -f "$DEST_DIR/fls" "$DEST_DIR/fls.mjs"
rmdir "$DEST_DIR" 2>/dev/null || true

if [ -f "$BASHRC" ] && grep -qxF "$PATH_LINE" "$BASHRC"; then
  grep -vxF "$PATH_LINE" "$BASHRC" > "$BASHRC.tmp"
  mv -f "$BASHRC.tmp" "$BASHRC"
fi

echo "ok : fls désinstallé"
