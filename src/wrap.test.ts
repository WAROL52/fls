// Repli des lignes longues à la largeur du terminal et numéros de ligne (sortie colorée).
// Sans mock : la vraie coloration Shiki est utilisée.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { RESET, wrapAnsi } from "./ansi.ts";
import { parseBg } from "./color.ts";
import { palette } from "./ansi.ts";
import { runFls, sandbox } from "./testing/io.ts";

const BG = "\x1b[48;2;20;20;20m";
const EOL = "\x1b[K\x1b[0m";
const strip = (t: string): string => t.replace(/\x1b\[[0-9;]*[mK]/g, "");
const width = (t: string): number => [...strip(t)].length;

interface Opts {
  columns?: number;
  tty?: boolean;
  stdin?: string;
  env?: Record<string, string>;
}
/** Sans `stdin`, l'entrée est un terminal ; sans `tty`, la sortie en est un (c'est ce qu'on veut replier). */
async function run(files: Record<string, string | Buffer>, argv: string[], o: Opts = {}) {
  const dir = sandbox(files);
  const r = await runFls(dir, argv, { tty: o.stdin === undefined, stdoutTTY: o.tty ?? true, stdin: o.stdin, env: o.env, columns: o.columns });
  return { dir, code: r.code, text: r.text, clip: r.clip.text };
}
const rowsOf = (text: string): string[] => text.split("\n").filter((l) => l.includes(BG));

describe("wrapAnsi", () => {
  it("ligne qui tient, ligne vide, largeur invalide : une seule ligne visuelle", () => {
    expect(wrapAnsi("abc", 10)).toEqual(["abc"]);
    expect(wrapAnsi("", 10)).toEqual([""]);
    expect(wrapAnsi("abcdef", Infinity)).toEqual(["abcdef"]);
    expect(wrapAnsi("abcdef", 0)).toEqual(["abcdef"]);
  });

  it("coupe à la largeur, sans ligne vide en trop quand le texte remplit exactement", () => {
    expect(wrapAnsi("abcdef", 3)).toEqual(["abc", "def"]);
    expect(wrapAnsi("abcdefg", 3)).toEqual(["abc", "def", "g"]);
  });

  it("indentation des lignes suivantes, comptée dans la largeur", () => {
    expect(wrapAnsi("abcdefgh", 5, "  ")).toEqual(["abcde", "  fgh"]);
    expect(wrapAnsi("abcdefghijkl", 5, "  ")).toEqual(["abcde", "  fgh", "  ijk", "  l"]);
  });

  it("rouvre les styles actifs sur chaque ligne et referme chaque ligne coupée", () => {
    const rows = wrapAnsi("\x1b[31mabcdef\x1b[0m", 3);
    expect(rows).toEqual([`\x1b[31mabc${RESET}`, "\x1b[31mdef\x1b[0m"]);
    // plusieurs styles cumulés, puis reset : le reset vide la pile
    const two = wrapAnsi("\x1b[1m\x1b[32mabcd\x1b[0mef", 3);
    expect(two).toEqual([`\x1b[1m\x1b[32mabc${RESET}`, "\x1b[1m\x1b[32md\x1b[0mef"]);
    expect(wrapAnsi("\x1b[31mab\x1b[0mcdef", 3)).toEqual(["\x1b[31mab\x1b[0mc", "def"]);
  });

  it("une séquence d'échappement ne compte pas dans la largeur ; un caractère hors BMP = une colonne", () => {
    expect(wrapAnsi("\x1b[31mab\x1b[39mcd", 4)).toEqual(["\x1b[31mab\x1b[39mcd"]);
    expect(wrapAnsi("a😀b😀c", 2)).toEqual(["a😀", "b😀", "c"]);
  });
});

describe("numéros de ligne (sortie colorée)", () => {
  it("@read : chaque ligne est numérotée, numéros alignés à droite", async () => {
    const body = Array.from({ length: 10 }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n");
    const r = await run({ "a.ts": `${body}\n` }, ["--colored"], { stdin: "@read a.ts\n" });
    const rows = rowsOf(r.text).map(strip);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toBe(" 1 │ const v1 = 1;");
    expect(rows[8]).toBe(" 9 │ const v9 = 9;");
    expect(rows[9]).toBe("10 │ const v10 = 10;");
  });

  it("@read d'une plage : les numéros sont ceux du fichier", async () => {
    const r = await run({ "a.ts": "l1\nl2\nl3\nl4\nl5\n" }, ["--colored"], { stdin: "@read a.ts 3-4\n" });
    expect(rowsOf(r.text).map(strip)).toEqual(["3 │ l3", "4 │ l4"]);
  });

  it("@read --line-numbers : mêmes numéros, un seul préfixe", async () => {
    const r = await run({ "a.ts": "l1\nl2\n" }, ["--colored"], { stdin: "@read a.ts --line-numbers\n" });
    expect(rowsOf(r.text).map(strip)).toEqual(["1 │ l1", "2 │ l2"]);
  });

  it("--tree : numérotation par fichier, gouttière après le préfixe de l'arbre", async () => {
    const r = await run({ "d/a.ts": "a1\na2\n", "d/b.ts": "b1\n" }, ["--tree", "--colored", "d"]);
    const before = (l: string) => strip(l.slice(0, l.indexOf(BG)));
    expect(rowsOf(r.text).map((l) => before(l) + strip(l.slice(l.indexOf(BG))))).toEqual(["│   1 │ a1", "│   2 │ a2", "    1 │ b1"]);
  });

  it("fichier omis (binaire) : pas de gouttière, pas de fond", async () => {
    const r = await run({ "d/a.bin": Buffer.from([1, 0, 2]) }, ["--colored"], { stdin: "@read d\n" });
    expect(r.text).toContain("[omis : binary_file]");
    expect(rowsOf(r.text)).toHaveLength(0);
  });

  it("sans couleur : aucune numérotation (sortie brute inchangée)", async () => {
    const r = await run({ "a.ts": "x\n" }, ["--no-color"], { stdin: "@read a.ts\n", tty: false });
    expect(r.text).not.toContain("│");
    expect(r.text).toContain("=== a.ts (1 lignes) ===\nx\n=== fin ===");
  });
});

describe("repli à la largeur du terminal", () => {
  const long = `const message = "${"abcdefghij".repeat(12)}";`; // 135 colonnes
  const files = { "a.ts": `short\n${long}\nend\n` };

  /** Chaque ligne visuelle respecte la largeur ; la 1re de chaque ligne source porte le numéro. */
  const check = (text: string, columns: number) => {
    const rows = rowsOf(text);
    for (const l of rows) {
      expect(width(l), strip(l)).toBeLessThanOrEqual(columns - 1);
      expect(l.startsWith(BG)).toBe(true);
      expect(l.endsWith(EOL)).toBe(true);
    }
    return rows.map(strip);
  };

  it("--tree : la ligne longue est repliée dans le bloc, numéro sur la première ligne visuelle seulement", async () => {
    const r = await run(files, ["--tree", "--colored", "a.ts"], { columns: 40 });
    const rows = check(r.text, 40);
    expect(rows.length).toBeGreaterThan(3);
    expect(rows[0]).toBe("1 │ short");
    expect(rows[1].startsWith("2 │ const message")).toBe(true);
    const cont = rows.slice(2, -1);
    expect(cont.length).toBeGreaterThanOrEqual(3);
    for (const c of cont) expect(c.startsWith("  │ ")).toBe(true);
    expect(rows[rows.length - 1]).toBe("3 │ end");
    // rien ne se perd : les morceaux recollés redonnent la ligne d'origine
    const joined = [rows[1], ...cont].map((c) => c.slice(4)).join("");
    expect(joined).toBe(long);
  });

  it("--tree dans un dossier : le préfixe de l'arbre est repris sur chaque ligne visuelle", async () => {
    const r = await run({ "d/x/a.ts": `${long}\n`, "d/z.ts": "z\n" }, ["--tree", "--colored", "d"], { columns: 50 });
    const lines = r.text.split("\n");
    const start = lines.findIndex((l) => l.includes(BG));
    const block = lines.slice(start).filter((l) => l.includes(BG));
    const prefixes = block.map((l) => strip(l.slice(0, l.indexOf(BG))));
    // x/ n'est pas le dernier : « │   » ; a.ts est seul dans x/ : « │       » (continuation de d/ puis de x/)
    expect(new Set(prefixes.slice(0, -1))).toEqual(new Set(["│       "]));
    expect(prefixes[prefixes.length - 1]).toBe("    ");
    expect(block.length).toBeGreaterThan(3);
    for (const l of block) expect(width(l)).toBeLessThanOrEqual(49);
  });

  it("@read : même repli et mêmes numéros dans le rapport", async () => {
    const r = await run(files, ["--colored"], { columns: 40, stdin: "@read a.ts\n" });
    const rows = check(r.text, 40);
    expect(rows[1].startsWith("2 │ const message")).toBe(true);
    expect(rows[2].startsWith("  │ ")).toBe(true);
  });

  it("@grep : ligne repliée, continuation indentée", async () => {
    const r = await run(files, ["--colored"], { columns: 40, stdin: '@grep "message" a.ts\n' });
    const rows = check(r.text, 40);
    expect(rows[0].startsWith("a.ts:2:")).toBe(true);
    expect(rows.length).toBeGreaterThan(2);
    for (const c of rows.slice(1)) expect(c.startsWith("    ")).toBe(true);
  });

  it("@edit : lignes + et - repliées, continuation indentée de deux colonnes", async () => {
    const script = `@edit a.ts\n<<<<<<< SEARCH\n${long}\n=======\n${long.replace("message", "texte")}\n>>>>>>> REPLACE\n`;
    const r = await run(files, ["--colored", "--dry-run"], { columns: 40, stdin: script });
    const rows = r.text.split("\n").filter((l) => /\x1b\[48;2;(55;34;44|32;48;59)m/.test(l));
    expect(rows.length).toBeGreaterThan(4);
    for (const l of rows) expect(width(l)).toBeLessThanOrEqual(39);
    const plain = rows.map(strip);
    expect(plain[0].startsWith("- const message")).toBe(true);
    expect(plain[1].startsWith("  ")).toBe(true);
    expect(plain.some((l) => l.startsWith("+ const texte"))).toBe(true);
  });

  it("aucun repli sans largeur connue (sortie non terminal) : une ligne visuelle par ligne", async () => {
    const r = await run(files, ["--tree", "--colored", "a.ts"], { tty: false });
    const rows = rowsOf(r.text).map(strip);
    expect(rows).toEqual(["1 │ short", `2 │ ${long}`, "3 │ end"]);
  });

  it("couleur vers un fichier ou le presse-papiers : pas de repli, même sur un terminal", async () => {
    const toFile = await run(files, ["--tree", "--colored", "a.ts", "--output", "o.txt"], { columns: 40 });
    const saved = fs.readFileSync(path.join(toFile.dir, "o.txt"), "utf8");
    expect(rowsOf(saved).map(strip)).toEqual(["1 │ short", `2 │ ${long}`, "3 │ end"]);
    const toClip = await run(files, ["--tree", "--colored", "a.ts", "--clip"], { columns: 40 });
    expect(rowsOf(toClip.clip).map(strip)).toEqual(["1 │ short", `2 │ ${long}`, "3 │ end"]);
  });

  it("terminal très étroit : largeur minimale de 20 colonnes de texte", async () => {
    const r = await run({ "a.ts": `${"x".repeat(60)}\n` }, ["--tree", "--colored", "a.ts"], { columns: 5 });
    const rows = rowsOf(r.text).map(strip);
    expect(rows.map((l) => l.slice(4))).toEqual(["x".repeat(20), "x".repeat(20), "x".repeat(20)]);
  });
});

describe("couleur de fond (#141414 du thème opencode par défaut, FLS_BG pour s'accorder au terminal)", () => {
  it("fond par défaut : #141414 (panneau du thème opencode)", async () => {
    const r = await run({ "a.ts": "x\n" }, ["--tree", "--colored", "a.ts"]);
    expect(r.text).toContain("\x1b[48;2;20;20;20m");
    expect(r.text).not.toContain("48;2;0;0;0");
  });

  it("FLS_BG : fond choisi, avec ou sans #", async () => {
    const withHash = await run({ "a.ts": "x\n" }, ["--tree", "--colored", "a.ts"], { env: { FLS_BG: "#1e2127" } });
    expect(rowsOf(withHash.text.replace(/\x1b\[48;2;20;20;20m/g, "")).length).toBe(0);
    expect(withHash.text).toContain("\x1b[48;2;30;33;39m");
    expect(withHash.text).not.toContain("\x1b[48;2;20;20;20m");
    const bare = await run({ "a.ts": "x\n" }, ["--tree", "--colored", "a.ts"], { env: { FLS_BG: "FFFFFF" } });
    expect(bare.text).toContain("\x1b[48;2;255;255;255m");
  });

  it("FLS_BG s'applique aussi à @read et reste sans effet sur les fonds de diff", async () => {
    const r = await run({ "a.ts": "x\n" }, ["--colored", "--dry-run"], {
      env: { FLS_BG: "#101820" },
      stdin: "@read a.ts\n@edit a.ts\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n",
    });
    expect(r.text).toContain("\x1b[48;2;16;24;32m");
    expect(r.text).toContain("\x1b[48;2;55;34;44m");
    expect(r.text).toContain("\x1b[48;2;32;48;59m");
  });

  it("FLS_BG vide : ignoré ; FLS_BG invalide : usage_error, code 2", async () => {
    expect((await run({ "a.ts": "x\n" }, ["--tree", "--colored", "a.ts"], { env: { FLS_BG: "" } })).text).toContain("48;2;20;20;20");
    const bad = await run({ "a.ts": "x\n" }, ["--tree", "--colored", "a.ts"], { env: { FLS_BG: "rouge" } });
    expect(bad.code).toBe(2);
  });

  it("parseBg", () => {
    expect(parseBg(undefined)).toBeUndefined();
    expect(parseBg("")).toBeUndefined();
    expect(parseBg("#0a0b0c")).toEqual([10, 11, 12]);
    expect(parseBg("0A0B0C")).toEqual([10, 11, 12]);
    expect(() => parseBg("#12345")).toThrow(/FLS_BG attend une couleur #rrggbb/);
    expect(() => parseBg("#gggggg")).toThrow(/usage_error|FLS_BG/);
  });

  it("palette : niveaux 16 et 256 gardent le fond sombre par défaut (la couleur choisie ne vaut qu'en 24 bits)", () => {
    expect(palette(1).bgCode.open).toBe("\x1b[40m");
    expect(palette(2).bgCode.open).toBe("\x1b[48;5;233m");
    expect(palette(3, [1, 2, 3]).bgCode.open).toBe("\x1b[48;2;1;2;3m");
  });
});
