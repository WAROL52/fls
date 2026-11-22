// Texte stylé : modèle (Span, Line), couleurs dégradées, repli de spans, palette, et sérialisation ANSI
// (le seul endroit où des séquences d'échappement sont écrites).
import { describe, expect, it } from "vitest";
import { ESC, RESET, toAnsi } from "./ansi.ts";
import { hexColor, lineText, palette, plainLine, rgbColor, span, textLines, wrapSpans, type Line, type Style } from "./style.ts";

const red: Style = { fg: { rgb: [224, 108, 117], c256: 203, c16: 31 } };
const row = (spans: Line["spans"], extra: Partial<Line> = {}): Line => ({ spans, ...extra });
const text = (rows: Array<Array<{ text: string }>>): string[] => rows.map((r) => r.map((s) => s.text).join(""));

describe("couleurs", () => {
  it("un RVB se dégrade vers 256 couleurs (cube ou gris) et vers 16 couleurs", () => {
    expect(rgbColor([255, 0, 0])).toEqual({ rgb: [255, 0, 0], c256: 196, c16: 91 });
    expect(rgbColor([0, 0, 0])).toMatchObject({ c256: 16, c16: 30 });
    expect(rgbColor([128, 128, 128])).toMatchObject({ c256: 244 }); // rampe de gris
    expect(rgbColor([229, 229, 229]).c16).toBe(37);
    expect(rgbColor([0, 205, 0]).c16).toBe(32);
    expect(rgbColor([255, 255, 255]).c16).toBe(97);
    expect(rgbColor([300, 300, 300]).c256).toBe(231); // au-delà : le blanc du cube
  });

  it("hexColor lit #rrggbb avec ou sans dièse", () => {
    expect(hexColor("#0a0b0c").rgb).toEqual([10, 11, 12]);
    expect(hexColor("0A0B0C").rgb).toEqual([10, 11, 12]);
  });
});

describe("palette", () => {
  it("rôles : styles du thème opencode ; couleurs 16 et 256 fixes", () => {
    const p = palette();
    expect(p.ok.fg).toEqual({ rgb: [127, 216, 143], c256: 78, c16: 32 });
    expect(p.fail).toBe(p.red);
    expect(p.note).toBe(p.cyan);
    expect(p.dim).toEqual({ dim: true });
    expect(p.match).toEqual({ bold: true, inverse: true });
    expect(p.bgCode).toEqual({ rgb: [20, 20, 20], c256: 233, c16: 40 });
    expect(p.bgAdd.rgb).toEqual([32, 48, 59]);
    expect(p.bgDel.rgb).toEqual([55, 34, 44]);
  });

  it("le fond choisi (FLS_BG) ne vaut qu'en 24 bits : 16 et 256 couleurs gardent le fond sombre", () => {
    expect(palette([1, 2, 3]).bgCode).toEqual({ rgb: [1, 2, 3], c256: 233, c16: 40 });
  });
});

describe("construction", () => {
  it("span : un texte vide ne produit rien ; textLines : une ligne par retour à la ligne", () => {
    expect(span("")).toEqual([]);
    expect(span("x")).toEqual([{ text: "x" }]);
    expect(span("x", red)).toEqual([{ text: "x", style: red }]);
    expect(plainLine("")).toEqual({ spans: [] });
    expect(textLines("a\n\nb", red).map(lineText)).toEqual(["a", "", "b"]);
    expect(textLines("")).toEqual([{ spans: [] }]);
  });

  it("lineText : le préfixe et le texte, sans style", () => {
    expect(lineText(row(span("ab", red), { lead: span("> ") }))).toBe("> ab");
  });
});

describe("wrapSpans", () => {
  it("ligne qui tient, ligne vide, largeur invalide : une seule ligne visuelle", () => {
    expect(text(wrapSpans(span("abc"), 10))).toEqual(["abc"]);
    expect(wrapSpans([], 10)).toEqual([[]]);
    expect(text(wrapSpans(span("abcdef"), Infinity))).toEqual(["abcdef"]);
    expect(text(wrapSpans(span("abcdef"), 0))).toEqual(["abcdef"]);
  });

  it("coupe à la largeur, sans ligne vide en trop quand le texte remplit exactement", () => {
    expect(text(wrapSpans(span("abcdef"), 3))).toEqual(["abc", "def"]);
    expect(text(wrapSpans(span("abcdefg"), 3))).toEqual(["abc", "def", "g"]);
  });

  it("indentation des lignes suivantes, non stylée et comptée dans la largeur", () => {
    expect(text(wrapSpans(span("abcdefgh"), 5, "  "))).toEqual(["abcde", "  fgh"]);
    expect(text(wrapSpans(span("abcdefghijkl"), 5, "  "))).toEqual(["abcde", "  fgh", "  ijk", "  l"]);
    expect(wrapSpans(span("abcdefgh", red), 5, "  ")[1]).toEqual([{ text: "  " }, { text: "fgh", style: red }]);
  });

  it("chaque ligne coupée garde le style de ses spans, sans rien rouvrir", () => {
    expect(wrapSpans(span("abcdef", red), 3)).toEqual([[{ text: "abc", style: red }], [{ text: "def", style: red }]]);
    const mixed = [...span("ab", red), ...span("cdef")];
    expect(wrapSpans(mixed, 3)).toEqual([[{ text: "ab", style: red }, { text: "c" }], [{ text: "def" }]]);
  });

  it("un caractère hors BMP compte pour une colonne", () => {
    expect(text(wrapSpans(span("a😀b😀c"), 2))).toEqual(["a😀", "b😀", "c"]);
  });
});

describe("toAnsi", () => {
  const BG20 = `${ESC}48;2;20;20;20m`;

  it("niveau 0 : le texte seul (préfixe compris), lignes séparées par un retour à la ligne", () => {
    expect(toAnsi([row(span("a", red), { lead: span("> ") }), row([])], 0)).toEqual({ text: "> a\n", truncated: false, total: 4 });
  });

  it("un span stylé est refermé par un reset ; un span sans style est écrit tel quel", () => {
    expect(toAnsi([row([...span("a", red), ...span("b")])], 3).text).toBe(`${ESC}38;2;224;108;117ma${RESET}b`);
  });

  it("styles cumulés : gras, discret, italique, souligné, inversé puis couleur, dans une même séquence", () => {
    const all: Style = { bold: true, dim: true, italic: true, underline: true, inverse: true, fg: red.fg };
    expect(toAnsi([row(span("x", all))], 3).text).toBe(`${ESC}1;2;3;4;7;38;2;224;108;117mx${RESET}`);
    expect(toAnsi([row(span("x", { bold: false }))], 3).text).toBe("x"); // aucun attribut actif : pas de séquence
  });

  it("niveaux 16 et 256 : la couleur de chaque rôle, le fond sombre par défaut", () => {
    const line = row(span("x", red), { bg: palette().bgCode });
    expect(toAnsi([line], 1).text).toBe(`${ESC}40m${ESC}31mx${RESET}${ESC}40m${ESC}K${RESET}`);
    expect(toAnsi([line], 2).text).toBe(`${ESC}48;5;233m${ESC}38;5;203mx${RESET}${ESC}48;5;233m${ESC}K${RESET}`);
  });

  it("fond : rouvert après chaque reset, prolongé jusqu'au bord ; ligne vide : le fond seul", () => {
    const p = palette();
    expect(toAnsi([row([...span("a", red), ...span("b")], { bg: p.bgCode })], 3).text).toBe(`${BG20}${ESC}38;2;224;108;117ma${RESET}${BG20}b${ESC}K${RESET}`);
    expect(toAnsi([row([], { bg: p.bgCode })], 3).text).toBe(`${BG20}${ESC}K${RESET}`);
  });

  it("le préfixe précède le fond et n'est pas sur fond", () => {
    const p = palette();
    const out = toAnsi([row(span("x"), { lead: span("│ ", p.dim), bg: p.bgCode })], 3).text;
    expect(out).toBe(`${ESC}2m│ ${RESET}${BG20}x${ESC}K${RESET}`);
  });

  it("limite : la sortie est coupée à N caractères, séquences comprises, jamais au milieu d'une séquence", () => {
    const lines = [row([...span("ab", red), ...span("cd")])];
    const full = `${ESC}38;2;224;108;117mab${RESET}cd`;
    expect(toAnsi(lines, 3, 100)).toEqual({ text: full, truncated: false, total: full.length });
    expect(toAnsi(lines, 3, full.length)).toMatchObject({ text: full, truncated: false });
    // dans la première séquence : rien d'écrit
    expect(toAnsi(lines, 3, 4)).toEqual({ text: "", truncated: true, total: full.length });
    // dans un texte : coupé net, sans refermer le style
    expect(toAnsi(lines, 3, `${ESC}38;2;224;108;117ma`.length).text).toBe(`${ESC}38;2;224;108;117ma`);
    // juste après une séquence complète : elle est gardée
    expect(toAnsi(lines, 3, `${ESC}38;2;224;108;117mab`.length).text).toBe(`${ESC}38;2;224;108;117mab`);
    // le reset ne tient pas : on s'arrête avant lui
    expect(toAnsi(lines, 3, `${ESC}38;2;224;108;117mab${ESC}0`.length).text).toBe(`${ESC}38;2;224;108;117mab`);
    // le retour à la ligne entre deux lignes compte aussi
    expect(toAnsi([row(span("ab")), row(span("cd"))], 3, 4)).toEqual({ text: "ab\nc", truncated: true, total: 5 });
  });
});
