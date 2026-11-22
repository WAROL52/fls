// `fls last` : réafficher la dernière sortie, sans rien réexécuter, à la largeur actuelle du terminal.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as fls from "./fls.ts";
import { session as baseSession } from "./testing/io.ts";

const BG = "\x1b[48;2;20;20;20m";
const strip = (t: string): string => t.replace(/\x1b\[[0-9;]*[mK]/g, "");
const width = (t: string): number => [...strip(t)].length;

interface Opts {
  columns?: number;
  tty?: boolean;
  stdin?: string;
  cacheDir?: string | null;
}
/** Une « session » : même dossier de travail et même cache d'une commande à l'autre. */
function session(files: Record<string, string> = {}) {
  const s = baseSession(files);
  async function run(argv: string[], o: Opts = {}) {
    const r = await s.run(argv, { tty: o.stdin === undefined, stdoutTTY: o.tty ?? false, stdin: o.stdin, columns: o.columns, cacheDir: o.cacheDir ?? undefined, noCache: o.cacheDir === null });
    return { code: r.code, text: r.text, errText: r.errText, clip: r.clip.text };
  }
  return { ...s, run };
}
const rowsOf = (text: string): string[] => text.split("\n").filter((l) => l.includes(BG));

describe("fls last : réaffichage sans réexécution", () => {
  it("rapport de script : même sortie, même si le fichier a changé depuis", async () => {
    const s = session({ "a.ts": "avant\n" });
    const first = await s.run(["--no-color"], { stdin: "@read a.ts\n" });
    s.put({ "a.ts": "après\n" });
    const again = await s.run(["last", "--no-color"]);
    expect(again.code).toBe(0);
    expect(again.text).toBe(first.text);
    expect(again.text).toContain("avant");
    expect(again.text).not.toContain("après");
  });

  it("n'exécute rien : un @create déjà joué n'est pas rejoué", async () => {
    const s = session();
    const script = "@create n.txt\n<<<<<<< CONTENT\nx\n>>>>>>> END\n";
    const first = await s.run(["--no-color"], { stdin: script });
    expect(first.code).toBe(0);
    fs.rmSync(path.join(s.cwd, "n.txt"));
    const again = await s.run(["last", "--no-color"]);
    expect(again.code).toBe(0);
    expect(again.text).toContain("CREATE n.txt");
    expect(fs.existsSync(path.join(s.cwd, "n.txt"))).toBe(false);
    expect(fs.readdirSync(path.join(s.cwd, ".fls", "runs"))).toEqual(["r1"]); // un seul run : `last` n'en a pas créé d'autre
  });

  it("la lecture rapide et le --dry-run sont mémorisés aussi", async () => {
    const s = session({ "a.ts": "un\n" });
    const quick = await s.run(["a.ts", "--no-color"]);
    expect((await s.run(["last", "--no-color"])).text).toBe(quick.text);
    const dry = await s.run(["--dry-run", "--no-color"], { stdin: '@note "simulé"\n' });
    const again = await s.run(["last", "--no-color"]);
    expect(again.text).toBe(dry.text);
    expect(again.text).toContain("dry-run");
  });

  it("--tree : même arbre brut ; racine absente conservée (stderr déjà affiché, rien n'est rejoué)", async () => {
    const s = session({ "d/a.ts": "a\n", "d/sub/b.ts": "b\n", "e.ts": "e\n" });
    const first = await s.run(["--tree", "d", "missing", "e.ts", "--no-color"]);
    expect(first.code).toBe(1);
    expect(first.errText).toContain("missing");
    const again = await s.run(["last", "--no-color"]);
    expect(again.code).toBe(0);
    expect(again.errText).toBe("");
    expect(again.text).toBe(first.text);
  });

  it("réajuste la largeur : même contenu, relu à la largeur actuelle du terminal", async () => {
    const long = `const message = "${"abcdefghij".repeat(12)}";`;
    const s = session({ "a.ts": `${long}\n` });
    const wide = await s.run(["--tree", "--colored", "a.ts"], { tty: true, columns: 300 });
    expect(rowsOf(wide.text)).toHaveLength(1);
    const narrow = await s.run(["last", "--colored"], { tty: true, columns: 40 });
    const rows = rowsOf(narrow.text);
    expect(rows.length).toBeGreaterThan(3);
    for (const l of rows) expect(width(l)).toBeLessThanOrEqual(39);
    expect(rows.map((l) => strip(l).slice(4)).join("")).toBe(long);
    // et de nouveau plus large
    const wider = await s.run(["last", "--colored"], { tty: true, columns: 200 });
    expect(rowsOf(wider.text).length).toBeLessThan(rows.length);
    for (const l of rowsOf(wider.text)) expect(width(l)).toBeLessThanOrEqual(199);
  });

  it("réajuste aussi un rapport (@read) mémorisé", async () => {
    const long = `const message = "${"abcdefghij".repeat(12)}";`;
    const s = session({ "a.ts": `${long}\n` });
    const first = await s.run(["--colored"], { tty: true, columns: 300, stdin: "@read a.ts\n" });
    expect(rowsOf(first.text)).toHaveLength(1);
    const narrow = await s.run(["last"], { tty: true, columns: 40 });
    expect(rowsOf(narrow.text).length).toBeGreaterThan(3);
    for (const l of rowsOf(narrow.text)) expect(width(l)).toBeLessThanOrEqual(39);
    expect(narrow.text).toContain("Résumé : 1 OK");
  });

  it("la couleur se choisit au réaffichage : sortie brute mémorisée, rendu coloré ou non à la demande", async () => {
    const s = session({ "a.ts": "x\n" });
    await s.run(["a.ts", "--no-color"]);
    const colored = await s.run(["last", "--colored"]);
    expect(colored.text).toContain("\x1b[");
    expect(rowsOf(colored.text).map(strip)).toEqual(["1 │ x"]);
    const plain = await s.run(["last", "--no-color"], { tty: true });
    expect(plain.text).not.toContain("\x1b[");
  });

  it("--output et --clip s'appliquent au réaffichage", async () => {
    const s = session({ "a.ts": "x\n" });
    await s.run(["a.ts", "--no-color"]);
    const r = await s.run(["last", "--no-color", "--output", "o.txt", "--clip"]);
    expect(r.text).toBe("");
    const saved = fs.readFileSync(path.join(s.cwd, "o.txt"), "utf8");
    expect(saved).toContain("=== a.ts (1 lignes) ===");
    expect(r.clip).toBe(saved);
  });

  it("`last` ne remplace pas la sortie mémorisée (réaffichages répétables)", async () => {
    const s = session({ "a.ts": "x\n" });
    await s.run(["a.ts", "--no-color"]);
    const before = fs.readFileSync(s.lastFile, "utf8");
    await s.run(["last", "--no-color"]);
    await s.run(["last", "--no-color"]);
    expect(fs.readFileSync(s.lastFile, "utf8")).toBe(before);
  });

  it("une nouvelle sortie remplace la précédente", async () => {
    const s = session({ "a.ts": "premier\n", "b.ts": "second\n" });
    await s.run(["a.ts", "--no-color"]);
    await s.run(["b.ts", "--no-color"]);
    const again = await s.run(["last", "--no-color"]);
    expect(again.text).toContain("second");
    expect(again.text).not.toContain("premier");
  });
});

describe("fls last : erreurs et cas limites", () => {
  it("rien de mémorisé : no_last_output, code 1", async () => {
    const s = session();
    const r = await s.run(["last"]);
    expect(r.code).toBe(1);
    expect(r.errText).toContain("no_last_output");
    expect(r.text).toBe("");
  });

  it("sans dossier de cache : pas de mémorisation, `last` répond no_last_output, la commande d'origine réussit", async () => {
    const s = session({ "a.ts": "x\n" });
    const first = await s.run(["a.ts", "--no-color"], { cacheDir: null });
    expect(first.code).toBe(0);
    expect(fs.existsSync(s.cache)).toBe(false);
    expect((await s.run(["last"], { cacheDir: null })).errText).toContain("no_last_output");
  });

  it("fichier mémorisé corrompu ou de forme inconnue : no_last_output", async () => {
    const s = session();
    fs.mkdirSync(s.cache, { recursive: true });
    const oldFormat = JSON.stringify({ version: "1.2.0", snapshot: { kind: "report", text: "[1] OK  NOTE x\n" } }); // copie texte de fls 1.2.0
    for (const bad of ["pas du json", "{}", '{"snapshot":{"kind":"autre"}}', '{"snapshot":null}', oldFormat]) {
      fs.writeFileSync(s.lastFile, bad);
      const r = await s.run(["last"]);
      expect(r.code, bad).toBe(1);
      expect(r.errText, bad).toContain("no_last_output");
    }
  });

  it("une écriture impossible du cache n'est jamais fatale", async () => {
    const s = session({ "a.ts": "x\n" });
    const blocker = path.join(s.cwd, "pas-un-dossier");
    fs.writeFileSync(blocker, "");
    const r = await s.run(["a.ts", "--no-color"], { cacheDir: blocker });
    expect(r.code).toBe(0);
    expect(r.text).toContain("=== a.ts");
  });

  it("seules les lectures, scripts et --tree sont mémorisés (pas help, spec, log, usage, version, erreurs)", async () => {
    const s = session({ "a.ts": "x\n" });
    for (const argv of [["--help"], ["--version"], ["spec"], ["help", "read"], ["log"], ["init"]]) await s.run(argv);
    await s.run([]); // usage (entrée standard terminal, aucune source)
    const bad = await s.run(["--no-color"], { stdin: "n'importe quoi\n" });
    expect(bad.code).toBe(2);
    expect(fs.existsSync(s.lastFile)).toBe(false);
  });

  it("le contenu mémorisé est la sortie non colorée (jamais de codes ANSI sur le disque)", async () => {
    const s = session({ "a.ts": "x\n" });
    await s.run(["--tree", "--colored", "a.ts"], { tty: true, columns: 80 });
    expect(fs.readFileSync(s.lastFile, "utf8")).not.toContain("\\u001b");
    await s.run(["--colored", "a.ts"], { tty: true, columns: 80 });
    expect(fs.readFileSync(s.lastFile, "utf8")).not.toContain("\\u001b");
  });

  it("loadLast / saveLast : aller-retour direct", () => {
    const s = session();
    const io = { cwd: s.cwd, cacheDir: s.cache, now: () => new Date(0) } as fls.Io;
    const doc = { header: "h", entries: [{ status: "OK" as const, kind: "NOTE", title: "t", code: "", body: [] }], footer: ["f"] };
    fls.saveLast(io, { kind: "report", doc });
    expect(fls.loadLast(io)).toEqual({ kind: "report", doc });
    expect(() => fls.loadLast({ cwd: s.cwd } as fls.Io)).toThrow(/aucune sortie mémorisée/);
  });
});

describe("aide, version et environnement réel", () => {
  it("l'usage et la liste des codes mentionnent last / no_last_output", () => {
    expect(fls.usage()).toContain("fls last");
    expect(fls.buildSpec()).toContain("no_last_output");
  });

  it("version 1.4.0", async () => {
    const s = session();
    expect((await s.run(["--version"])).text).toBe("fls 1.4.0\n");
  });

  it("cacheDirFor : XDG_CACHE_HOME sinon ~/.cache", () => {
    expect(fls.cacheDirFor({ XDG_CACHE_HOME: "/x/cache" }, "/home/u")).toBe("/x/cache/fls");
    expect(fls.cacheDirFor({}, "/home/u")).toBe("/home/u/.cache/fls");
    expect(fls.cacheDirFor({ XDG_CACHE_HOME: "" }, "/home/u")).toBe("/home/u/.cache/fls");
  });

  it("terminalColumns : seulement sur un terminal qui connaît sa largeur", () => {
    expect(fls.terminalColumns(true, 120)).toBe(120);
    expect(fls.terminalColumns(false, 120)).toBeUndefined();
    expect(fls.terminalColumns(true, undefined)).toBeUndefined();
    expect(fls.terminalColumns(true, 0)).toBeUndefined();
  });

  it("l'Io réel fournit le dossier de cache", () => {
    expect(fls.createRealIo(0).cacheDir?.endsWith(path.join("fls"))).toBe(true);
  });
});
