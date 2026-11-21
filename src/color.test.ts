import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyLineBg, palette, safeTruncate } from "./ansi.ts";
import { colorizeQuickTree, colorizeReportText, colorMode, resolveTargets } from "./color.ts";
import * as highlight from "./highlight.ts";
import * as fls from "./fls.ts";
import { Workspace } from "./workspace.ts";

vi.mock("./highlight.ts", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./highlight.ts")>();
  return {
    ...orig,
    highlightCode: vi.fn(async (code: string, _lang: string, _theme: string, level: number) =>
      level === 0 ? code : code.split("\n").map((l) => `<H>${l}</H>`).join("\n"),
    ),
  };
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.clearAllMocks();
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

function fake(cwd: string, o: { tty?: boolean; stdoutTTY?: boolean; stderrTTY?: boolean; env?: Record<string, string | undefined>; clipboard?: string } = {}) {
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
    expect(p.bgCode.wrap("x")).toContain("\x1b[48;2;36;36;36m");
    expect(p.bgAdd.wrap("x")).toContain("48;2;30;60;30");
    expect(p.bgDel.wrap("x")).toContain("48;2;60;30;30");
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

describe("colorizeReportText", () => {
  it("colorise rapport, read, diff, grep, résumé", async () => {
    const targets = { stdout: true, stderr: true, file: true, clip: true, level: 3 as const };
    const report = [
      "fls 1.0.0 | run r1 | /x | 2026",
      "",
      "[1] OK    READ f.ts (1 lignes)",
      "=== f.ts (1 lignes) ===",
      "const x = 1",
      "=== fin ===",
      "",
      "[2] FAIL  EDIT f.ts : not_found",
      "@@ bloc 1 (ligne 1)",
      "- old",
      "+ new",
      "",
      "[3] OK    GREP \"x\" dans . (1 correspondance(s) dans 1 fichier(s))",
      "f.ts:1: const x = 1",
      "--",
      "f.ts-2- ctx",
      "",
      "Résumé : 2 OK, 1 FAIL, 0 SKIP",
      "Modifiés : aucun",
    ].join("\n");
    const out = await colorizeReportText(report, targets);
    expect(out).toContain("\x1b[");
    expect(out).toContain("<H>const x = 1</H>");
    expect(out).toContain("48;2;60;30;30m"); // del bg
    expect(out).toContain("48;2;30;60;30m"); // add bg
  });

  it("niveau 0 ne modifie pas", async () => {
    const t = { stdout: false, stderr: false, file: false, clip: false, level: 0 as const };
    expect(await colorizeReportText("fls\n\nRésumé : 0 OK", t)).toBe("fls\n\nRésumé : 0 OK");
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
  const targets = { stdout: true, stderr: true, file: true, clip: true, level: 3 as const };

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
    expect(text).toContain("48;2;60;30;30m");
    expect(text).toContain("48;2;30;60;30m");
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

describe("colorizeReportText branches", () => {
  const targets = { stdout: true, stderr: true, file: true, clip: true, level: 3 as const };
  it("NOTE, unknown kind, bloc omis, grep sep", async () => {
    const report = [
      "fls 1.0.0 | run r1 | /x | 2026",
      "",
      "[1] OK    NOTE hello world",
      "",
      "[2] OK    CUSTOM thing",
      "    body line",
      "",
      "[3] OK    READ d (dossier, 1 fichier(s))",
      "d/",
      "└── a.bin",
      "=== a.bin ===",
      "[omis : binary_file]",
      "=== fin ===",
      "",
      "[4] OK    GREP \"x\" dans . (1 correspondance(s) dans 1 fichier(s))",
      "--",
      "f.ts:1: x",
      "",
      "Résumé : 4 OK, 0 FAIL, 0 SKIP",
    ].join("\n");
    const out = await colorizeReportText(report, targets);
    expect(out).toContain("\x1b[");
  });

  it("highlightBlock catch fallback", async () => {
    const mod = await import("./highlight.ts");
    (mod.highlightCode as any).mockRejectedValueOnce(new Error("boom"));
    const report = ["fls 1.0.0 | run r1 | /x | 2026", "", "[1] OK    READ f.ts (1 lignes)", "=== f.ts (1 lignes) ===", "x", "=== fin ===", "", "Résumé : 1 OK, 0 FAIL, 0 SKIP"].join("\n");
    const out = await colorizeReportText(report, targets);
    expect(out).toContain("x");
  });
});

describe("coverage extras", () => {
  const targets = { stdout: true, stderr: true, file: true, clip: true, level: 3 as const };

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

  it("colorResultHead fallback et edit body context", async () => {
    const report = [
      "fls 1.0.0 | run r1 | /x | 2026",
      "",
      "[1] ",
      "body",
      "",
      "[2] OK    EDIT f.ts (1 bloc(s), +0 -0)",
      "@@ bloc 1",
      " ctx",
      "",
      "Résumé : 1 OK, 0 FAIL, 0 SKIP",
    ].join("\n");
    const out = await colorizeReportText(report, targets);
    expect(out).toContain("\x1b[");
  });

  it("grep met en évidence le match", async () => {
    const report = [
      "fls 1.0.0 | run r1 | /x | 2026",
      "",
      '[1] OK    GREP "foo" dans . (1 correspondance(s) dans 1 fichier(s))',
      "a.ts:1: const foo = 1",
      "--",
      "a.ts-2- const bar = 2",
      "",
      "Résumé : 1 OK, 0 FAIL, 0 SKIP",
    ].join("\n");
    const out = await colorizeReportText(report, targets);
    expect(out).toContain(";7m"); // match style (bold+inverse)
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

  it("status SKIP/dim, numbered non-match, hl shorter, edit catch", async () => {
    const mod = await import("./highlight.ts");
    (mod.highlightCode as any).mockImplementationOnce(async (code: string) => `<H>${code.split("\n")[0]}</H>`); // shorter
    (mod.highlightCode as any).mockRejectedValueOnce(new Error("boom")); // edit catch
    const report = [
      "fls 1.0.0 | run r1 | /x | 2026",
      "",
      "[1] SKIP  EDIT a.ts",
      "    ignoré : une écriture précédente a échoué",
      "",
      "[2] WARN  NOTE x",
      "",
      "[3] OK    READ f.ts (2 lignes)",
      "=== f.ts (2 lignes) ===",
      "  1 | first",
      "weird-no-prefix",
      "=== fin ===",
      "",
      "[4] OK    EDIT f.ts (1 bloc(s), +2 -0)",
      "@@ bloc 1",
      "+ a",
      "+ b",
      "",
      "Résumé : 2 OK, 0 FAIL, 1 SKIP",
    ].join("\n");
    const out = await colorizeReportText(report, targets);
    expect(out).toContain("\x1b[");
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
    // GREP with no quoted pattern, match not found, and non-grep line
    const report = [
      "fls 1.0.0 | run r1 | /x | 2026",
      "",
      '[1] OK    GREP "foo" dans . (1 correspondance(s) dans 1 fichier(s))',
      "a.ts:1: bar baz",
      "plain line",
      "",
      "[2] OK    GREP foo dans . (1 correspondance(s) dans 1 fichier(s))",
      "a.ts:1: foo bar",
      "",
      "Résumé : 2 OK, 0 FAIL, 0 SKIP",
    ].join("\n");
    const out = await colorizeReportText(report, targets);
    expect(out).toContain("bar");
    expect(out).toContain("foo");
  });

  it("read sans fin et edit hl court", async () => {
    const mod = await import("./highlight.ts");
    (mod.highlightCode as any)
      .mockImplementationOnce(async (code: string) => code.split("\n").map((l) => `<H>${l}</H>`).join("\n")) // read
      .mockImplementationOnce(async (code: string) => `<H>${code.split("\n")[0]}</H>`); // edit shorter
    const report = [
      "fls 1.0.0 | run r1 | /x | 2026",
      "",
      "[1] OK    READ f.ts (1 lignes)",
      "=== f.ts (1 lignes) ===",
      "hello",
      "",
      "[2] OK    EDIT f.ts (1 bloc(s), +2 -0)",
      "@@ bloc 1",
      "+ a",
      "+ b",
      "",
      "Résumé : 2 OK, 0 FAIL, 0 SKIP",
    ].join("\n");
    const out = await colorizeReportText(report, targets);
    expect(out).toContain("hello");
    expect(out).toContain("\x1b[");
  });
});
