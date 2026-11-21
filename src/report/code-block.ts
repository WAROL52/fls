// Bloc de code du rendu stylé : tabulations développées, gouttière (numéros de ligne), repli à la
// largeur du terminal. Partagé par le rendu stylé du Rapport et par la lecture rapide `--tree`.

import { wrapAnsi, type Palette } from "../ansi.ts";
import type { Highlighter } from "../highlight.ts";

const TAB_WIDTH = 8;
const GUTTER_SEP = " │ ";
const MIN_WRAP = 20;

/**
 * Remplace chaque tabulation par des espaces jusqu'au prochain taquet (8 colonnes), la ligne
 * commençant à la colonne `startCol`. Un terminal ne peint pas le fond sous une tabulation :
 * sans cela, l'indentation des fichiers indentés par tabulations resterait sans fond.
 */
export function expandTabs(line: string, startCol = 0): string {
  if (!line.includes("\t")) return line;
  let out = "";
  for (const ch of line) out += ch === "\t" ? " ".repeat(TAB_WIDTH - ((startCol + [...out].length) % TAB_WIDTH)) : ch;
  return out;
}

/** Largeur disponible pour le texte d'une ligne visuelle (marge d'une colonne contre le repli du terminal). */
export function room(columns: number | undefined, used: number): number {
  return columns === undefined ? Infinity : Math.max(columns - used - 1, MIN_WRAP);
}

/** Coloration d'un bloc ; une erreur du highlighter laisse le texte non coloré (jamais fatale). */
export async function highlightLines(rawLines: string[], lang: string, startCol: number, highlighter: Highlighter): Promise<string[]> {
  const lines = rawLines.map((l) => expandTabs(l, startCol));
  try {
    const hl = await highlighter(lines.join("\n"), lang);
    return lines.map((l, i) => hl[i] ?? l);
  } catch {
    return lines;
  }
}

/**
 * Lignes visuelles d'un bloc de code : numéro de ligne (sur la première ligne visuelle seulement),
 * puis le code replié. `prefix` est le préfixe de l'arbre (sans fond) : le fond commence à la
 * colonne du nom de fichier.
 */
export async function codeBlockRows(
  codes: string[],
  nums: number[],
  lang: string,
  prefix: string,
  p: Palette,
  columns: number | undefined,
  highlighter: Highlighter,
): Promise<string[]> {
  if (codes.length === 0) return [];
  const gw = String(Math.max(...nums)).length;
  const startCol = prefix.length + gw + GUTTER_SEP.length;
  const hl = await highlightLines(codes, lang, startCol, highlighter);
  const avail = room(columns, startCol);
  return hl.flatMap((line, i) =>
    wrapAnsi(line, avail).map((part, k) => {
      const num = k === 0 ? String(nums[i]).padStart(gw) : " ".repeat(gw);
      return p.dim(prefix) + p.bgCode.wrap(p.lineNo(num + GUTTER_SEP) + part);
    }),
  );
}
