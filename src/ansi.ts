// Sérialisation du texte stylé en séquences ANSI : le seul endroit où elles sont écrites.

import { lineText, type Color, type Line, type Span, type Style } from "./style.ts";

export type ColorLevel = 0 | 1 | 2 | 3;

export const ESC = "\x1b[";
export const RESET = `${ESC}0m`;

const sgr = (codes: Array<number | string>): string => `${ESC}${codes.join(";")}m`;

const fgOpen = (c: Color, level: ColorLevel): Array<number | string> => (level === 1 ? [c.c16] : level === 2 ? [38, 5, c.c256] : [38, 2, ...c.rgb]);
const bgOpen = (c: Color, level: ColorLevel): string => sgr(level === 1 ? [c.c16] : level === 2 ? [48, 5, c.c256] : [48, 2, ...c.rgb]);

function styleOpen(s: Style | undefined, level: ColorLevel): string {
  if (s === undefined) return "";
  const codes: Array<number | string> = [];
  if (s.bold === true) codes.push(1);
  if (s.dim === true) codes.push(2);
  if (s.italic === true) codes.push(3);
  if (s.underline === true) codes.push(4);
  if (s.inverse === true) codes.push(7);
  if (s.fg !== undefined) codes.push(...fgOpen(s.fg, level));
  return codes.length === 0 ? "" : sgr(codes);
}

/** Un morceau de sortie : une séquence d'échappement (jamais coupée) ou du texte (coupable). */
interface Atom {
  esc: boolean;
  s: string;
}
const esc = (s: string): Atom => ({ esc: true, s });
const txt = (s: string): Atom => ({ esc: false, s });

/** Une ligne : styles refermés après chaque span ; le fond est rouvert après chaque reset, puis `EL` le prolonge jusqu'au bord droit. */
function lineAtoms(l: Line, level: ColorLevel, out: Atom[]): void {
  const bg = l.bg === undefined ? "" : bgOpen(l.bg, level);
  const spans = (list: Span[], reopen: string): void => {
    for (const sp of list) {
      const open = styleOpen(sp.style, level);
      if (open === "") {
        out.push(txt(sp.text));
        continue;
      }
      out.push(esc(open), txt(sp.text), esc(RESET));
      if (reopen !== "") out.push(esc(reopen));
    }
  };
  spans(l.lead ?? [], "");
  if (bg !== "") out.push(esc(bg));
  spans(l.spans, bg);
  if (bg !== "") out.push(esc(`${ESC}K`), esc(RESET));
}

export interface Serialized {
  text: string;
  /** La limite a coupé la sortie. */
  truncated: boolean;
  /** Longueur de la sortie complète (avant la limite). */
  total: number;
}

/**
 * Les lignes séparées par un retour à la ligne, en ANSI au niveau demandé (0 : aucun style).
 * `limit` compte les caractères de la sortie, séquences comprises : la sortie est coupée à cette
 * longueur, mais jamais au milieu d'une séquence d'échappement.
 */
export function toAnsi(lines: Line[], level: ColorLevel, limit = Infinity): Serialized {
  const atoms: Atom[] = [];
  for (const [i, l] of lines.entries()) {
    if (i > 0) atoms.push(txt("\n"));
    if (level === 0) atoms.push(txt(lineText(l)));
    else lineAtoms(l, level, atoms);
  }
  const total = atoms.reduce((n, a) => n + a.s.length, 0);
  if (total <= limit) return { text: atoms.map((a) => a.s).join(""), truncated: false, total };
  let text = "";
  for (const a of atoms) {
    if (text.length + a.s.length <= limit) text += a.s;
    else {
      if (!a.esc) text += a.s.slice(0, limit - text.length);
      break;
    }
  }
  return { text, truncated: true, total };
}
