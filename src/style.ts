// Texte stylé : le modèle de ce que le rendu coloré affiche, indépendant de tout terminal. Une
// Ligne est une suite de Spans (texte + style) avec, au besoin, un fond ; la mise en page (repli,
// indentation, gouttière, fond) travaille sur ces données et seul `toAnsi` (ansi.ts) écrit des
// séquences d'échappement, au dernier moment (ADR-0006).

export type Rgb = [number, number, number];

/** Une couleur sous ses trois formes : 24 bits, 256 couleurs, 16 couleurs (code SGR 30-37 / 90-97 ou 40-47). */
export interface Color {
  rgb: Rgb;
  c256: number;
  c16: number;
}

export interface Style {
  fg?: Color;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface Span {
  text: string;
  /** Absent : texte sans style. */
  style?: Style;
}

/**
 * Une ligne stylée. `bg` couvre `spans` jusqu'au bord droit du terminal ; `lead` précède le fond
 * (le préfixe de l'arbre, hors du fond).
 */
export interface Line {
  lead?: Span[];
  spans: Span[];
  bg?: Color;
}

const ANSI16: Rgb[] = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
const dist = (a: Rgb, b: Rgb): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const LEVELS = [0, 95, 135, 175, 215, 255];

/** Couleur la plus proche en 256 couleurs : cube 6×6×6 ou rampe de gris. */
function nearest256(rgb: Rgb): number {
  const step = (v: number): number => LEVELS.reduce((best, l, i) => (Math.abs(l - v) < Math.abs((LEVELS[best] as number) - v) ? i : best), 0);
  const [ri, gi, bi] = [step(rgb[0]), step(rgb[1]), step(rgb[2])] as const;
  const cube: Rgb = [LEVELS[ri] as number, LEVELS[gi] as number, LEVELS[bi] as number];
  const grayStep = Math.min(23, Math.max(0, Math.round((((rgb[0] + rgb[1] + rgb[2]) / 3) - 8) / 10)));
  const gv = 8 + 10 * grayStep;
  return dist(rgb, [gv, gv, gv]) < dist(rgb, cube) ? 232 + grayStep : 16 + 36 * ri + 6 * gi + bi;
}

/** Couleur la plus proche parmi les 16 couleurs ANSI (premier plan : 30-37 puis 90-97). */
function nearest16(rgb: Rgb): number {
  const best = ANSI16.reduce((b, c, i) => (dist(rgb, c) < dist(rgb, ANSI16[b] as Rgb) ? i : b), 0);
  return best < 8 ? 30 + best : 90 + best - 8;
}

/** Une couleur 24 bits, dégradée au plus proche pour les terminaux à 256 ou 16 couleurs. */
export const rgbColor = (rgb: Rgb): Color => ({ rgb, c256: nearest256(rgb), c16: nearest16(rgb) });

/** Texte hexadécimal `#rrggbb` (ou `rrggbb`) vers une couleur. */
export function hexColor(hex: string): Color {
  const h = hex.replace("#", "");
  return rgbColor([parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]);
}

/** Les styles par rôle du rendu (couleurs du thème opencode). Les couleurs 16 et 256 des rôles sont fixes. */
export interface Palette {
  ok: Style;
  fail: Style;
  skip: Style;
  note: Style;
  dim: Style;
  bold: Style;
  cyan: Style;
  red: Style;
  green: Style;
  yellow: Style;
  match: Style;
  lineNo: Style;
  bgCode: Color;
  bgAdd: Color;
  bgDel: Color;
}

const role = (c16: number, c256: number, rgb: Rgb): Style => ({ fg: { rgb, c256, c16 } });
const GREEN = role(32, 78, [127, 216, 143]);
const RED = role(31, 203, [224, 108, 117]);
const CYAN = role(36, 74, [86, 182, 194]);

/** Fond des contenus de fichier : #141414 (panneau du thème opencode) par défaut ; `codeBg` l'adapte (24 bits seulement). */
export function palette(codeBg: Rgb = [20, 20, 20]): Palette {
  return {
    ok: GREEN,
    fail: RED,
    skip: role(33, 214, [245, 167, 66]),
    note: CYAN,
    dim: { dim: true },
    bold: { bold: true },
    cyan: CYAN,
    red: RED,
    green: GREEN,
    yellow: role(33, 180, [229, 192, 123]),
    match: { bold: true, inverse: true },
    lineNo: role(90, 245, [143, 143, 143]),
    bgCode: { rgb: codeBg, c256: 233, c16: 40 },
    bgAdd: { rgb: [32, 48, 59], c256: 23, c16: 42 },
    bgDel: { rgb: [55, 34, 44], c256: 52, c16: 41 },
  };
}

/** Un span stylé ; un texte vide ne produit rien. */
export const span = (text: string, style?: Style): Span[] => (text === "" ? [] : style === undefined ? [{ text }] : [{ text, style }]);

/** Ligne de texte sans style. */
export const plainLine = (text: string): Line => ({ spans: span(text) });

/** Les lignes d'un texte multi-lignes, avec un même style (un texte vide donne une ligne vide). */
export const textLines = (text: string, style?: Style): Line[] => text.split("\n").map((l) => ({ spans: span(l, style) }));

/**
 * Coupe une ligne en lignes visuelles de `width` colonnes au plus. Les lignes suivantes commencent
 * par `indent` (non stylée, comptée dans la largeur). Une colonne = un point de code (pas de
 * gestion des caractères larges ou combinants). Une largeur invalide ne coupe rien.
 */
export function wrapSpans(spans: Span[], width: number, indent = ""): Span[][] {
  if (!Number.isFinite(width) || width < 1) return [spans];
  const rows: Span[][] = [];
  let cur: Span[] = [];
  let col = 0;
  for (const s of spans) {
    let piece = "";
    const flush = (): void => {
      cur.push(...span(piece, s.style));
      piece = "";
    };
    for (const ch of s.text) {
      if (col === width) {
        flush();
        rows.push(cur);
        cur = span(indent);
        col = indent.length;
      }
      piece += ch;
      col += 1;
    }
    flush();
  }
  rows.push(cur);
  return rows;
}

/** Le texte d'une ligne, sans style. */
export const lineText = (l: Line): string => [...(l.lead ?? []), ...l.spans].map((s) => s.text).join("");
