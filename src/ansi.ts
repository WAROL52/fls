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

function makePalette(level: ColorLevel): Palette {
	const none = makeBg("");
	if (level === 0) {
		const id = (s: string): string => s;
		return { level, ok: id, fail: id, skip: id, note: id, dim: id, bold: id, cyan: id, red: id, green: id, yellow: id, match: id, bgCode: none, bgAdd: none, bgDel: none };
	}
	const fg = (n: number, n256: number, rgb: [number, number, number]): string =>
		level === 1 ? sgr(n) : level === 2 ? sgr(38, 5, n256) : sgr(38, 2, ...rgb);
	const bg = (n: number, n256: number, rgb: [number, number, number]): string =>
		level === 1 ? sgr(n) : level === 2 ? sgr(48, 5, n256) : sgr(48, 2, ...rgb);
	return {
		level,
		ok: (s) => wrap(fg(32, 78, [80, 200, 120]), s),
		fail: (s) => wrap(fg(31, 203, [255, 100, 100]), s),
		skip: (s) => wrap(fg(33, 221, [240, 200, 80]), s),
		note: (s) => wrap(fg(36, 117, [120, 220, 255]), s),
		dim: (s) => wrap(sgr(2), s),
		bold: (s) => wrap(sgr(1), s),
		cyan: (s) => wrap(fg(36, 81, [120, 220, 255]), s),
		red: (s) => wrap(fg(31, 203, [255, 100, 100]), s),
		green: (s) => wrap(fg(32, 78, [80, 200, 120]), s),
		yellow: (s) => wrap(fg(33, 221, [240, 200, 80]), s),
		match: (s) => wrap(sgr(1, 7), s),
		bgCode: makeBg(bg(49, 236, [36, 36, 36])),
		bgAdd: makeBg(bg(42, 22, [30, 60, 30])),
		bgDel: makeBg(bg(41, 52, [60, 30, 30])),
	};
}

export function palette(level: ColorLevel): Palette {
	return makePalette(level);
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
