// Helpers ANSI : couleurs, fonds, troncature sûre, utilitaires.

export type ColorLevel = 0 | 1 | 2 | 3;

export const ESC = "\x1b[";
export const RESET = `${ESC}0m`;

const sgr = (...codes: Array<number | string>): string => `${ESC}${codes.join(";")}m`;

export interface Bg {
	open: string;
	wrap: (s: string) => string;
}

export interface Palette {
	level: ColorLevel;
	ok: (s: string) => string;
	fail: (s: string) => string;
	skip: (s: string) => string;
	note: (s: string) => string;
	dim: (s: string) => string;
	bold: (s: string) => string;
	cyan: (s: string) => string;
	red: (s: string) => string;
	green: (s: string) => string;
	yellow: (s: string) => string;
	match: (s: string) => string;
	lineNo: (s: string) => string;
	bgCode: Bg;
	bgAdd: Bg;
	bgDel: Bg;
}

const wrap = (open: string, s: string): string => (s === "" ? "" : `${open}${s}${RESET}`);

function makeBg(open: string): Bg {
	const wrapBg = (s: string): string => {
		if (open === "") return s;
		// Réapplique le fond après chaque reset complet pour ne pas perdre le bg.
		// EL (\x1b[K) remplit jusqu'au bord droit du terminal avec le fond actif.
		if (s === "") return `${open}${ESC}K${RESET}`;
		const body = s.replaceAll(RESET, `${RESET}${open}`);
		return `${open}${body}${ESC}K${RESET}`;
	};
	return { open, wrap: wrapBg };
}

function makePalette(level: ColorLevel, codeBg: Rgb): Palette {
	const none = makeBg("");
	if (level === 0) {
		const id = (s: string): string => s;
		return { level, ok: id, fail: id, skip: id, note: id, dim: id, bold: id, cyan: id, red: id, green: id, yellow: id, match: id, lineNo: id, bgCode: none, bgAdd: none, bgDel: none };
	}
	const fg = (n: number, n256: number, rgb: [number, number, number]): string =>
		level === 1 ? sgr(n) : level === 2 ? sgr(38, 5, n256) : sgr(38, 2, ...rgb);
	const bg = (n: number, n256: number, rgb: [number, number, number]): string =>
		level === 1 ? sgr(n) : level === 2 ? sgr(48, 5, n256) : sgr(48, 2, ...rgb);
	return {
		level,
		// couleurs du thème opencode (sombre)
		ok: (s) => wrap(fg(32, 78, [127, 216, 143]), s),
		fail: (s) => wrap(fg(31, 203, [224, 108, 117]), s),
		skip: (s) => wrap(fg(33, 214, [245, 167, 66]), s),
		note: (s) => wrap(fg(36, 74, [86, 182, 194]), s),
		dim: (s) => wrap(sgr(2), s),
		bold: (s) => wrap(sgr(1), s),
		cyan: (s) => wrap(fg(36, 74, [86, 182, 194]), s),
		red: (s) => wrap(fg(31, 203, [224, 108, 117]), s),
		green: (s) => wrap(fg(32, 78, [127, 216, 143]), s),
		yellow: (s) => wrap(fg(33, 180, [229, 192, 123]), s),
		match: (s) => wrap(sgr(1, 7), s),
		lineNo: (s) => wrap(fg(90, 245, [143, 143, 143]), s),
		bgCode: makeBg(bg(40, 233, codeBg)),
		bgAdd: makeBg(bg(42, 23, [32, 48, 59])),
		bgDel: makeBg(bg(41, 52, [55, 34, 44])),
	};
}

export type Rgb = [number, number, number];

/** Fond des contenus de fichier : #141414 (panneau du thème opencode) par défaut ; `codeBg` l'adapte au thème du terminal (niveau 3 seulement). */
export function palette(level: ColorLevel, codeBg: Rgb = [20, 20, 20]): Palette {
	return makePalette(level, codeBg);
}

// Applique un fond à chaque ligne, en préservant les resets ANSI internes.
export function applyLineBg(text: string, bg: Bg): string {
	if (text === "" || bg.open === "") return text;
	return text.split("\n").map((l) => bg.wrap(l)).join("\n");
}

// Ne coupe jamais au milieu d'une séquence d'échappement ANSI.
export function safeTruncate(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	let cut = limit;
	// recule si on tombe dans une séquence CSI: ESC [ ... lettre
	const back = text.lastIndexOf("\x1b", cut);
	if (back !== -1 && back >= cut - 32) {
		const tail = text.slice(back, cut);
		if (/^\x1b(?:\[[0-9;?]*[ -/]*[@-~]?|\][^\x07\x1b]*(?:\x07|\x1b\\)?)?$/.test(tail) && !/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))$/.test(tail)) {
			cut = back;
		}
	}
	return { text: text.slice(0, cut), truncated: true };
}

const SGR = /\x1b\[[0-9;]*m/y;

/**
 * Découpe une ligne (éventuellement stylée en ANSI) en lignes visuelles de `width` colonnes
 * au plus : chaque ligne est refermée par un reset et la suivante rouvre les styles actifs.
 * Les lignes suivantes commencent par `indent` (comptée dans la largeur). Une colonne = un
 * point de code (pas de gestion des caractères larges ou combinants).
 */
export function wrapAnsi(line: string, width: number, indent = ""): string[] {
  if (!Number.isFinite(width) || width < 1) return [line];
  const rows: string[] = [];
  let active = "";
  let cur = "";
  let col = 0;
  let i = 0;
  while (i < line.length) {
    SGR.lastIndex = i;
    const seq = SGR.exec(line);
    if (seq !== null) {
      cur += seq[0];
      active = seq[0] === RESET ? "" : active + seq[0];
      i += seq[0].length;
      continue;
    }
    if (col === width) {
      rows.push(active === "" ? cur : cur + RESET);
      cur = active + indent;
      col = indent.length;
    }
    const ch = String.fromCodePoint(line.codePointAt(i) as number);
    cur += ch;
    col += 1;
    i += ch.length;
  }
  rows.push(cur);
  return rows;
}
