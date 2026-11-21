import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyLineBg, palette, safeTruncate } from "./ansi.ts";
import { colorizeQuickTree, colorMode, resolveTargets } from "./color.ts";
import type { Highlighter } from "./highlight.ts";
import { expandTabs } from "./report/code-block.ts";
import * as fls from "./fls.ts";
import { Workspace } from "./workspace.ts";

/** Highlighter de test : entoure chaque ligne de <H>…</H> (assertions lisibles, indépendantes du thème). */
const markHighlighter: Highlighter = async (code) => code.split("\n").map((l) => `<H>${l}</H>`);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function sb(files: Record<string, string | Buffer> = {}): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fls-color-")));
  dirs.push(dir);
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
  }
  return dir;
}

function fake(cwd: string, o: { tty?: boolean; stdoutTTY?: boolean; stderrTTY?: boolean; env?: Record<string, string | undefined>; clipboard?: string; columns?: number; cacheDir?: string; highlighter?: Highlighter } = {}) {
  const out: Array<string | Buffer> = [];
  const err: string[] = [];
  const clip = { text: o.clipboard ?? "" };
  const io: fls.Io = {
    cwd,
    stdinIsTTY: o.tty ?? false,
    stdoutIsTTY: o.stdoutTTY ?? false,
    stderrIsTTY: o.stderrTTY ?? false,
    env: o.env ?? {},
    readStdin: () => "",
    out: (t) => { out.push(t); },
    err: (t) => { err.push(t); },
    clipboard: { read: () => clip.text, write: (t) => { clip.text = t; } },
    now: () => new Date("2026-11-19T10:00:00.123Z"),
    newId: () => "r1",
    columns: o.columns,
    cacheDir: o.cacheDir,
    highlighter: o.highlighter ?? markHighlighter,
  };
  return { io, out, err, clip };
}

describe("ansi", () => {
  it("palette niveau 0 est identity", () => {
    const p = palette(0);
    expect(p.ok("x")).toBe("x");
    expect(p.fail("x")).toBe("x");
    expect(p.bgCode.wrap("x")).toBe("x");
    expect(p.bgAdd.wrap("")).toBe("");
  });

  it("palette couleur wrap et reset", () => {
    const p = palette(3);
    for (const k of ["ok","fail","skip","note","dim","bold","cyan","red","green","yellow","match"] as const) {
      expect(p[k]("x")).toContain("\x1b[");
    }
    expect(p.bgCode.wrap("x")).toContain("\x1b[48;2;20;20;20m");
    expect(p.bgAdd.wrap("x")).toContain("48;2;32;48;59");
    expect(p.bgDel.wrap("x")).toContain("48;2;55;34;44");
  });

  it("niveaux 16 et 256", () => {
    expect(palette(1).ok("x")).toContain("\x1b[32m");
    expect(palette(2).ok("x")).toContain("38;5;");
  });

  it("applyLineBg réapplique fond après reset", () => {
    const p = palette(3);
    const s = applyLineBg("a\x1b[0mb\nc", p.bgCode);
    expect(s).toContain(p.bgCode.open);
    expect(s.split("\n")).toHaveLength(2);
    expect(applyLineBg("", p.bgCode)).toBe("");
    expect(applyLineBg("x", palette(0).bgCode)).toBe("x");
  });

  it("safeTruncate ne coupe pas dans une escape", () => {
    expect(safeTruncate("abc", 10)).toEqual({ text: "abc", truncated: false });
    const s = "ab\x1b[31mcd\x1b[0m";
    const t = safeTruncate(s, 4); // inside escape
    expect(t.truncated).toBe(true);
    expect(t.text).toBe("ab");
  });
});

describe("color mode", () => {
  it("résout modes et aliases", () => {
    const args = (flags: string[] = [], values: Record<string, string> = {}) =>
      ({ positional: [], flags: new Set(flags), values: new Map(Object.entries(values)), ignore: [] }) as fls.Args;
    expect(colorMode(args())).toBe("auto");
    expect(colorMode(args(["colored"]))).toBe("always");
    expect(colorMode(args(["no-color"]))).toBe("never");
    expect(colorMode(args([], { color: "always" }))).toBe("always");
    expect(colorMode(args([], { color: "never" }))).toBe("never");
    expect(colorMode(args([], { color: "auto" }))).toBe("auto");
    expect(() => colorMode(args([], { color: "nope" }))).toThrow(/usage_error|--color/);
  });

  it("resolveTargets suit TTY/NO_COLOR/always", () => {
    const args = (flags: string[] = [], values: Record<string, string> = {}) =>
      ({ positional: [], flags: new Set(flags), values: new Map(Object.entries(values)), ignore: [] }) as fls.Args;
    const io = (o: any = {}) => ({ stdoutIsTTY: false, stderrIsTTY: false, env: {}, ...o }) as fls.Io;
    expect(resolveTargets(args(), io()).stdout).toBe(false);
    expect(resolveTargets(args(), io({ stdoutIsTTY: true })).stdout).toBe(true);
    expect(resolveTargets(args(), io({ stdoutIsTTY: true, env: { NO_COLOR: "" } })).stdout).toBe(false);
    expect(resolveTargets(args(["colored"]), io({ env: { NO_COLOR: "" } })).stdout).toBe(true);
    expect(resolveTargets(args(["no-color"]), io({ stdoutIsTTY: true })).stdout).toBe(false);
    const t = resolveTargets(args([], { color: "always" }), io());
    expect(t.stdout).toBe(true);
    expect(t.file).toBe(true);
    expect(t.clip).toBe(true);
  });
});

describe("fond (bg) limité aux contenus de fichier", () => {
  const BG = "\x1b[48;2;20;20;20m";
  const targets = { stdout: true, stderr: true, file: true, clip: true, level: 3 as const, highlighter: markHighlighter };
  const lineOf = (out: string, needle: string): string => out.split("\n").find((l) => l.includes(needle)) as string;

  it("ligne vide de fichier : le fond remplit jusqu'au bord", () => {
    expect(palette(3).bgCode.wrap("")).toBe(`${BG}\x1b[K\x1b[0m`);
  });

  it("fls --tree : fond sur le contenu seulement, pas sur la racine ni les noms", async () => {
    const ws = new Workspace(fs.mkdtempSync(path.join(os.tmpdir(), "fls-bg-")));
    const raw = "d\n└── a.ts\n    const a = 1\n";
    const out = await colorizeQuickTree(raw, ws, "d", "d", targets);
    expect(lineOf(out, "a.ts")).not.toContain(BG);
    expect(lineOf(out, "const")).toContain(BG);
    expect(out.split("\n")[0]).not.toContain(BG);
  });
});

describe("tabulations : le fond doit couvrir l'indentation", () => {
  const BG = "\x1b[48;2;20;20;20m";
  const EOL = "\x1b[K\x1b[0m";
  const ts = "function f() {\n\tif (x) {\n\t\treturn 1;\n\t}\n}\n";

  it("expandTabs : taquets de 8 colonnes, colonne de départ, sans tabulation inchangé", () => {
    expect(expandTabs("\tx")).toBe("        x");
    expect(expandTabs("\t\tx")).toBe("                x");
    expect(expandTabs("ab\tx")).toBe("ab      x");
    expect(expandTabs("a\tb\tc")).toBe("a       b       c");
    expect(expandTabs("\tx", 4)).toBe("    x");
    expect(expandTabs("é\tx")).toBe("é       x");
    expect(expandTabs("sans tab")).toBe("sans tab");
  });

  /** Chaque ligne de contenu (marquée <H> par le mock) : fond au début, remplissage à la fin, aucune tabulation. */
  const assertPainted = (out: string, expected: number) => {
    const content = out.split("\n").filter((l) => l.includes("<H>"));
    expect(content).toHaveLength(expected);
    for (const l of content) {
      // en mode --tree, le contenu d'un fichier de dossier est précédé du préfixe d'arbre (sans fond)
      expect(l.replace(/^\x1b\[2m[^\x1b]*\x1b\[0m/, "").startsWith(BG), l).toBe(true);
      expect(l.endsWith(EOL), l).toBe(true);
    }
    expect(out).not.toContain("\t");
  };
  const runColored = async (argv: string[], files: Record<string, string>, stdin?: string) => {
    const dir = sb(files);
    const f = fake(dir, { stdoutTTY: false });
    if (stdin !== undefined) f.io.readStdin = () => stdin;
    await fls.main(["--colored", ...argv], f.io);
    return f.out.map(String).join("");
  };

  it("fls --tree --colored : indentation par tabulations peinte", async () => {
    const out = await runColored(["--tree", "a.ts"], { "a.ts": ts });
    assertPainted(out, 5);
    expect(out).toContain("<H>    if (x) {</H>"); // gouttière « 2 │ » (4 colonnes) : la tabulation va jusqu'à la colonne 8
  });

  it("fls <dossier> --tree --colored", async () => {
    assertPainted(await runColored(["--tree", "d"], { "d/a.ts": ts }), 5);
  });

  it("@read --colored : tabulations développées", async () => {
    assertPainted(await runColored([], { "a.ts": ts }, "@read a.ts\n"), 5);
  });

  it("@read --line-numbers --colored : colonne de départ après le préfixe", async () => {
    const out = await runColored([], { "a.ts": ts }, "@read a.ts --line-numbers\n");
    assertPainted(out, 5);
    expect(out).toContain("<H>    if (x) {</H>"); // préfixe « 2 | » (4 colonnes) : la tabulation va jusqu'à la colonne 8
  });

  it("@edit --colored : lignes +/- indentées par tabulations peintes", async () => {
    const script = "@edit a.ts\n<<<<<<< SEARCH\n\t\treturn 1;\n=======\n\t\treturn 2;\n>>>>>>> REPLACE\n";
    const out = await runColored(["--dry-run"], { "a.ts": ts }, script);
    expect(out).not.toContain("\t");
    const diff = out.split("\n").filter((l) => l.includes("return"));
    expect(diff.length).toBeGreaterThanOrEqual(2);
    for (const l of diff.filter((x) => x.includes("<H>"))) {
      expect(l.startsWith("\x1b[42m") || l.startsWith("\x1b[48;2;32;48;59m") || l.startsWith("\x1b[48;2;55;34;44m")).toBe(true);
      expect(l.endsWith(EOL)).toBe(true);
    }
  });
});

describe("fls --tree --colored : contenu aligné sur la colonne du nom de fichier", () => {
  const strip = (t: string) => t.replace(/\x1b\[[0-9;]*[mK]/g, "").replace(/<\/?H>/g, "");
  const BG = "\x1b[48;2;20;20;20m";
  const EOL = "\x1b[K\x1b[0m";
  const files = {
    "docs/adr/0001.md": "# titre\n\ntexte\n",
    "docs/adr/0002.md": "autre\n",
    "docs/guide.md": "un\ndeux\n",
    "docs/sub/deep/x.ts": "const x = 1;\n",
    "docs/z.txt": "fin\n",
  };
  const render = async (argv: string[], f: Record<string, string>, tty: boolean) => {
    const io = fake(sb(f), { stdoutTTY: tty });
    await fls.main(argv, io.io);
    return io.out.map(String).join("");
  };

  const GUTTER = /^ *\d* │ /;
  /** Sortie colorée ramenée à la sortie brute : codes ANSI et gouttière (numéros de ligne) retirés. */
  const toPlain = (colored: string) =>
    colored
      .split("\n")
      .map((l) => (l.includes(BG) ? strip(l.slice(0, l.indexOf(BG))) + strip(l.slice(l.indexOf(BG))).replace(GUTTER, "") : strip(l)))
      .join("\n");

  it("sortie colorée sans ANSI ni numéros == sortie brute, octet pour octet (arbre imbriqué, │ de continuation)", async () => {
    const colored = await render(["--tree", "--colored", "docs"], files, true);
    const plain = await render(["--tree", "--no-color", "docs"], files, false);
    expect(toPlain(colored)).toBe(plain);
  });

  it("le fond démarre exactement à la colonne du nom de fichier", async () => {
    const colored = await render(["--tree", "--colored", "docs"], files, true);
    const plain = (await render(["--tree", "--no-color", "docs"], files, false)).split("\n");
    const lines = colored.split("\n");
    expect(lines).toHaveLength(plain.length);
    let checked = 0;
    lines.forEach((l, i) => {
      if (!l.includes(BG)) return;
      checked += 1;
      const before = strip(l.slice(0, l.indexOf(BG)));
      // colonne du fond = largeur du préfixe de l'arbre ; ce qui suit est la gouttière puis le texte de la sortie brute
      expect(plain[i].startsWith(before), plain[i]).toBe(true);
      expect(strip(l.slice(l.indexOf(BG))).replace(GUTTER, "")).toBe(plain[i].slice(before.length));
      expect(before).toMatch(/^[ │]*$/);
      expect(before.length).toBeGreaterThan(0);
    });
    expect(checked).toBe(8); // 3 + 1 + 2 + 1 + 1 lignes de contenu
  });

  it("pas de ligne vide avec fond en fin de sortie ; \\n final conservé comme en brut", async () => {
    const out = await render(["--tree", "--colored", "docs"], { "docs/a.md": "x\n" }, true);
    expect(out.endsWith(`${EOL}\n`)).toBe(true);
    expect(out.endsWith(`\n${BG}${EOL}\n`)).toBe(false);
    expect(strip(out).endsWith("x\n")).toBe(true);
  });

  it("exemple de la capture : fichier unique dans un sous-dossier, contenu sous le nom", async () => {
    const out = strip(await render(["--tree", "--colored", "docs"], { "docs/adr/a.md": "# T\n\nligne\n" }, true));
    expect(out).toBe("docs\n└── adr\n    └── a.md\n        1 │ # T\n        2 │ \n        3 │ ligne\n");
  });

  it("fichier à la racine de l'arbre : contenu en colonne 0, fond dès le premier caractère", async () => {
    const out = await render(["--tree", "--colored", "a.ts"], { "a.ts": "x\n" }, true);
    const content = out.split("\n").find((l) => l.includes("<H>x</H>")) as string;
    expect(content.startsWith(BG)).toBe(true);
  });

  it("tabulations : colonne de départ = préfixe de l'arbre + gouttière", async () => {
    const out = strip(await render(["--tree", "--colored", "d"], { "d/a.ts": "\tx\n" }, true));
    expect(out).toBe("d\n└── a.ts\n    1 │         x\n"); // préfixe (4) + « 1 │ » (4) = colonne 8 ; la tabulation va jusqu'à la colonne 16
  });
});

describe("fls --tree --colored : aucune coupe par défaut (dossiers suivants visibles)", () => {
  // Régression : `fls src --tree --colored` coupait à 200 000 caractères (ANSI compris) au milieu du
  // premier gros fichier, et les sous-dossiers suivants (ex. `directive/`) n'apparaissaient jamais.
  const big = "const ligne = 1;\n".repeat(20_000); // ≈ 340 000 caractères, > 200 000 une fois coloré
  const files = { "src/ansi.ts": big, "src/color.test.ts": big, "src/directive/read.ts": "export const read = 1;\n", "src/zz.ts": "fin\n" };

  it("couleur forcée : tout l'arbre est présent, aucun message de troncature", async () => {
    const dir = sb(files);
    const f = fake(dir, { stdoutTTY: true });
    const code = await fls.main(["--tree", "--colored", "src"], f.io);
    const text = f.out.map(String).join("");
    expect(code).toBe(0);
    expect(text.length).toBeGreaterThan(200_000);
    expect(text).not.toContain("tronqué");
    expect(text).toContain("directive");
    expect(text).toContain("read.ts");
    expect(text).toContain("<H>export const read = 1;</H>");
    expect(text).toContain("zz.ts");
  });

  it("sans couleur : même arbre complet (parité)", async () => {
    const dir = sb(files);
    const f = fake(dir, { stdoutTTY: false });
    await fls.main(["--tree", "--no-color", "src"], f.io);
    const text = f.out.map(String).join("");
    expect(text).not.toContain("tronqué");
    expect(text).toContain("directive");
    expect(text).toContain("zz.ts");
  });

  it("--output et --clip : pas de coupe non plus", async () => {
    const dir = sb(files);
    const f = fake(dir, { stdoutTTY: false });
    await fls.main(["--tree", "--colored", "src", "--output", "out.txt", "--clip"], f.io);
    expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toContain("zz.ts");
    expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).not.toContain("tronqué");
    expect(f.clip.text).toContain("zz.ts");
  });

  it("--max-output-chars explicite coupe toujours", async () => {
    const dir = sb(files);
    const f = fake(dir, { stdoutTTY: true });
    await fls.main(["--tree", "--colored", "src", "--max-output-chars", "5000"], f.io);
    const text = f.out.map(String).join("");
    expect(text).toContain("tronqué");
    expect(text).not.toContain("zz.ts");
  });

  it("le rapport fls normal (@read) garde sa limite par défaut", async () => {
    const dir = sb(files);
    const f = fake(dir, { stdoutTTY: true });
    await fls.main(["src"], f.io);
    expect(f.out.map(String).join("")).toContain("tronqué");
  });
});

describe("fls --colored", () => {
  it("auto sur TTY stdout colore", async () => {
    const dir = sb({ "a.ts": "const a = 1\n" });
    const f = fake(dir, { stdoutTTY: true });
    const code = await fls.main(["a.ts"], f.io);
    expect(code).toBe(0);
    const text = f.out.map(String).join("");
    expect(text).toContain("\x1b[");
  });

  it("--no-color désactive", async () => {
    const dir = sb({ "a.ts": "const a = 1\n" });
    const f = fake(dir, { stdoutTTY: true });
    await fls.main(["--no-color", "a.ts"], f.io);
    expect(f.out.map(String).join("")).not.toContain("\x1b[");
  });

  it("NO_COLOR désactive en auto, --color=always force", async () => {
    const dir = sb({ "a.ts": "const a = 1\n" });
    const f1 = fake(dir, { stdoutTTY: true, env: { NO_COLOR: "1" } });
    await fls.main(["a.ts"], f1.io);
    expect(f1.out.map(String).join("")).not.toContain("\x1b[");
    const f2 = fake(dir, { stdoutTTY: true, env: { NO_COLOR: "1" } });
    await fls.main(["--color=always", "a.ts"], f2.io);
    expect(f2.out.map(String).join("")).toContain("\x1b[");
  });

  it("--output brut sauf always", async () => {
    const dir = sb({ "a.ts": "const a = 1\n" });
    const f = fake(dir, { stdoutTTY: true });
    await fls.main(["--colored", "a.ts", "--output", "out.txt"], f.io);
    const file = fs.readFileSync(path.join(dir, "out.txt"), "utf8");
    expect(file).toContain("\x1b[");
  });

  it("expand reste brut", async () => {
    const dir = sb({ "s.fls": '@read a.ts\n' });
    const f = fake(dir, { stdoutTTY: true, env: {} });
    f.io.readStdin = () => '@read a.ts\n';
    await fls.main(["--colored", "expand", "--file", "s.fls"], f.io);
    expect(f.out.map(String).join("")).not.toContain("\x1b[");
  });

  it("erreur stderr colorée si TTY", async () => {
    const dir = sb({});
    const f = fake(dir, { stderrTTY: true });
    const code = await fls.main(["--colored", "--file", "nope.fls"], f.io);
    expect(code).toBe(1);
    expect(f.err.join("")).toContain("\x1b[");
  });
});

describe("colorize intégration", () => {
  const targets = { stdout: true, stderr: true, file: true, clip: true, level: 3 as const, highlighter: markHighlighter };

  it("read avec line-numbers et dossier", async () => {
    const dir = sb({ "f.ts": "const a = 1\nconst b = 2\n", "d/x.ts": "export const x = 1\n" });
    const f = fake(dir, { stdoutTTY: true });
    await fls.main(["--colored", "f.ts", "--line-numbers"], { ...f.io, stdinIsTTY: false, readStdin: () => "", } as any);
    // via script path easier
    const f2 = fake(dir, { stdoutTTY: true });
    f2.io.readStdin = () => '@read f.ts --line-numbers\n@read d\n';
    await fls.main(["--colored"], f2.io);
    const text = f2.out.map(String).join("");
    expect(text).toContain("\x1b[");
    expect(text).toContain("<H>");
  });

  it("grep coloré", async () => {
    const dir = sb({ "a.ts": "const foo = 1\nconst bar = 2\n" });
    const f = fake(dir, { stdoutTTY: true });
    f.io.readStdin = () => '@grep "foo" a.ts -C 1\n';
    await fls.main(["--colored"], f.io);
    const text = f.out.map(String).join("");
    expect(text).toContain("\x1b[");
  });

  it("diff coloré", async () => {
    const dir = sb({ "a.ts": "const a = 1\nconst b = 2\n" });
    const f = fake(dir, { stdoutTTY: true });
    f.io.readStdin = () => '@edit a.ts\n<<<<<<< SEARCH\nconst a = 1\n=======\nconst a = 2\n>>>>>>> REPLACE\n';
    await fls.main(["--colored"], f.io);
    const text = f.out.map(String).join("");
    expect(text).toContain("48;2;55;34;44m");
    expect(text).toContain("48;2;32;48;59m");
  });

  it("quick tree coloré", async () => {
    const dir = sb({ "d/a.ts": "const a = 1\n", "d/b.txt": "hello\n" });
    const f = fake(dir, { stdoutTTY: true });
    await fls.main(["--tree", "--colored", "d"], f.io);
    const text = f.out.map(String).join("");
    expect(text).toContain("\x1b[");
  });

  it("tree coloré avec lien et unreadable", async () => {
    if (process.geteuid?.() === 0) return;
    const dir = sb({ "d/a.ts": "const a = 1\n" });
    fs.symlinkSync("a.ts", path.join(dir, "d/link.ts"));
    fs.writeFileSync(path.join(dir, "d/secret.ts"), "x\n");
    fs.chmodSync(path.join(dir, "d/secret.ts"), 0o000);
    const f = fake(dir, { stdoutTTY: true });
    try {
      await fls.main(["--tree", "--colored", "d"], f.io);
      const text = f.out.map(String).join("");
      expect(text).toContain("\x1b[");
    } finally {
      fs.chmodSync(path.join(dir, "d/secret.ts"), 0o644);
    }
  });

  it("--output avec --color=always écrit ANSI", async () => {
    const dir = sb({ "a.ts": "const a = 1\n" });
    const f = fake(dir, { stdoutTTY: false });
    await fls.main(["--color=always", "a.ts", "--output", "out.txt"], f.io);
    expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toContain("\x1b[");
  });

  it("--clip avec --color=always copie ANSI", async () => {
    const dir = sb({ "a.ts": "const a = 1\n" });
    const f = fake(dir, { stdoutTTY: false });
    await fls.main(["--color=always", "--clip", "a.ts"], f.io);
    expect(f.clip.text).toContain("\x1b[");
  });

  it("max-output-chars tronque sans casser ANSI", async () => {
    const dir = sb({ "a.ts": "const a = 1\n".repeat(200) });
    const f = fake(dir, { stdoutTTY: true });
    await fls.main(["--colored", "a.ts", "--max-output-chars", "120"], f.io);
    const text = f.out.map(String).join("");
    expect(text).toContain("tronqué");
  });

  it("expand reste brut même --color=always", async () => {
    const dir = sb({});
    const f = fake(dir, { stdoutTTY: true });
    f.io.readStdin = () => '@note "x"\n';
    await fls.main(["--color=always", "expand"], f.io);
    expect(f.out.map(String).join("")).not.toContain("\x1b[");
  });

  it("colorizeQuickTree direct", async () => {
    const dir = sb({ "d/a.ts": "const a = 1\n", "d/b": "hello\n" }, );
    fs.mkdirSync(path.join(dir, "d/sub"));
    fs.writeFileSync(path.join(dir, "d/sub/c.ts"), "x\n");
    fs.symlinkSync("a.ts", path.join(dir, "d/link"));
    const ws = new Workspace(dir, 1_048_576);
    const raw = `d\n├── a.ts\n│   const a = 1\n├── b\n│   hello\n├── link\n│   -> a.ts\n└── sub\n    └── c.ts\n        x\n`;
    const out = await colorizeQuickTree(raw, ws, "d", "d", targets);
    expect(out).toContain("\x1b[");
  });
});

describe("coverage extras", () => {
  const targets = { stdout: true, stderr: true, file: true, clip: true, level: 3 as const, highlighter: markHighlighter };

  it("safeTruncate recule dans escape incomplète", () => {
    const s = "ab\x1b[31mcd";
    const r = safeTruncate(s, 4);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe("ab");
    // complete escape at cut point: no backtrack
    const r2 = safeTruncate("ab\x1b[31mcd", 7);
    expect(r2.truncated).toBe(true);
    expect(r2.text).toBe("ab\x1b[31m");
    // no escape nearby
    expect(safeTruncate("abcdef", 3).text).toBe("abc");
  });

  it("colorizeQuickTree root link/unreadable/output et contenu racine", async () => {
    const dir = sb({ "a.ts": "x\n" });
    const ws = new Workspace(dir, 1_048_576);
    const raw = "a.ts\n-> b.ts\n";
    const out = await colorizeQuickTree(raw, ws, "a.ts", "a.ts", targets);
    expect(out).toContain("-> b.ts");
    const raw2 = "a.ts\n[unreadable]\n";
    expect(await colorizeQuickTree(raw2, ws, "a.ts", "a.ts", targets)).toContain("[unreadable]");
    const raw3 = "a.ts\n[output file]\n";
    expect(await colorizeQuickTree(raw3, ws, "a.ts", "a.ts", targets)).toContain("[output file]");
    const raw4 = "f.ts\nhello\nworld\n";
    expect(await colorizeQuickTree(raw4, ws, "f.ts", "f.ts", targets)).toContain("<H>hello</H>");
  });

  it("parseArgs --flag=value erreur", () => {
    expect(() => fls.parseArgs(["--tree=yes"])).toThrow(/n'attend pas de valeur/);
  });

  it("main catch colore stderr", async () => {
    const dir = sb({ "a.ts": "x\n" });
    const f = fake(dir, { stderrTTY: true });
    const code = await fls.main(["--colored", "--tree", "--ignore", "x", "a.ts"], f.io);
    expect(code).toBe(2);
    expect(f.err.join("")).toContain("\x1b[");
  });

  it("cmdQuickTree coloré multi-racines et erreur", async () => {
    const dir = sb({ "a.ts": "const a = 1\n", "b.ts": "const b = 1\n" });
    const f = fake(dir, { stdoutTTY: true });
    const code = await fls.main(["--tree", "--colored", "a.ts", "missing.ts", "b.ts"], f.io);
    expect(code).toBe(1);
    const text = f.out.map(String).join("");
    expect(text).toContain("\x1b[");
    expect(f.err.join("")).toContain("missing.ts");
  });

  it("emit stdout+file+clip combos colorés", async () => {
    const dir = sb({ "a.ts": "const a = 1\n" });
    const f = fake(dir, { stdoutTTY: true });
    await fls.main(["--color=always", "--clip", "a.ts", "--output", "out.txt"], f.io);
    expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toContain("\x1b[");
    expect(f.clip.text).toContain("\x1b[");
    const f2 = fake(dir, { stdoutTTY: true });
    await fls.main(["--color=always", "a.ts"], f2.io);
    expect(f2.out.map(String).join("")).toContain("\x1b[");
  });

  it("capture/feed helpers", () => {
    const ok = fls.realRunner.capture(process.execPath, ["-e", "process.stdout.write('x')"]);
    expect(ok).toBe("x");
    const bad = fls.realRunner.capture(process.execPath, ["-e", "process.exit(2)"]);
    expect(bad).toBeNull();
    const fed = fls.realRunner.feed(process.execPath, ["-e", "process.stdin.resume()"], "hi");
    expect(fed).toBe(true);
  });

  it("emit non coloré tronqué file/clip", async () => {
    const dir = sb({ "a.ts": "const a = 1\n".repeat(200) });
    const f = fake(dir, { stdoutTTY: false });
    await fls.main(["--no-color", "--clip", "a.ts", "--output", "out.txt", "--max-output-chars", "80"], f.io);
    expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toContain("tronqué");
    expect(f.clip.text).toContain("tronqué");
  });

  it("branches restantes color", async () => {
    const dir = sb({});
    const ws = new Workspace(dir, 1_048_576);
    // quickTree level 0
    expect(await colorizeQuickTree("a\n└── b\n    x\n", ws, "a", "a", { ...targets, level: 0 })).toBe("a\n└── b\n    x\n");
    // link at end of file (no line after -> target)
    const rawLink = "d\n└── link\n    -> target";
    const outLink = await colorizeQuickTree(rawLink, ws, "d", "d", targets);
    expect(outLink).toContain("-> target");
  });

});
