import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as fls from "./fls";
import { fake, runFls, sandbox, type FakeOpts, type Files } from "./testing/io.ts";

// ───────────────────────────── Aides ─────────────────────────────

const sb = sandbox;
const call = runFls;
const read = (dir: string, rel: string): string => fs.readFileSync(path.join(dir, rel), "utf8");
const exists = (dir: string, rel: string): boolean => fs.existsSync(path.join(dir, rel));

async function run(argv: string[], files: Files = {}, o: FakeOpts & { setup?: (dir: string) => void } = {}) {
  const dir = sb(files);
  if (o.setup !== undefined) o.setup(dir);
  return { dir, ...(await call(dir, argv, o)) };
}
const script = async (s: string, files: Files = {}, argv: string[] = [], o: FakeOpts & { setup?: (dir: string) => void } = {}) =>
  await run(argv, files, { stdin: s, ...o });
const content = (name: string, file: string, body: string): string => `@${name} ${file}\n<<<<<<< CONTENT\n${body}\n>>>>>>> END\n`;
const edit = (file: string, search: string, replace: string): string =>
  `@edit ${file}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`;

// ───────────────────────────── Texte ─────────────────────────────

describe("texte", () => {
  it("splitLines", async () => {
    expect(fls.splitLines("")).toEqual([]);
    expect(fls.splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(fls.splitLines("a\r\nb")).toEqual(["a", "b"]);
    expect(fls.splitLines("\n")).toEqual([""]);
  });

  it("quote", async () => {
    expect(fls.quote("abc")).toBe("abc");
    expect(fls.quote("a b")).toBe('"a b"');
    expect(fls.quote("")).toBe('""');
    expect(fls.quote("--x")).toBe('"--x"');
    expect(fls.quote('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it("tokenize", async () => {
    expect(fls.tokenize('@read "a b" c')).toEqual([
      { text: "@read", quoted: false },
      { text: "a b", quoted: true },
      { text: "c", quoted: false },
    ]);
    expect(fls.tokenize('x "a\\"b\\\\c" y"z')).toEqual([
      { text: "x", quoted: false },
      { text: 'a"b\\c', quoted: true },
      { text: 'y"z', quoted: false },
    ]);
    expect(fls.tokenize("   ")).toEqual([]);
    expect(fls.tokenize('x "abc')).toBeNull();
  });

  it("normalizeRel", async () => {
    expect(fls.normalizeRel(".")).toBe("");
    expect(fls.normalizeRel("")).toBe("");
    expect(fls.normalizeRel("src/")).toBe("src");
    expect(fls.normalizeRel("./a//b.ts")).toBe("a/b.ts");
    expect(fls.normalizeRel("a/../b")).toBe("b");
    expect(() => fls.normalizeRel("/etc/passwd")).toThrow(/absolu/);
    expect(() => fls.normalizeRel("..")).toThrow(/hors du dossier/);
    expect(() => fls.normalizeRel("../x")).toThrow(/hors du dossier/);
  });
});

describe("ignore", () => {
  it("motifs", async () => {
    const ig = fls.compileIgnore(["# commentaire", "", "!garde", "*.log", "dist/", "/build", "src/gen/*.ts", "a/**/z", "?x"]);
    expect(ig("app.log", false)).toBe(true);
    expect(ig("deep/er/app.log", false)).toBe(true);
    expect(ig("dist", true)).toBe(true);
    expect(ig("dist", false)).toBe(false);
    expect(ig("build", true)).toBe(true);
    expect(ig("x/build", true)).toBe(false);
    expect(ig("src/gen/a.ts", false)).toBe(true);
    expect(ig("src/gen/sub/a.ts", false)).toBe(false);
    expect(ig("a/b/c/z", false)).toBe(true);
    expect(ig("ax", false)).toBe(true);
    expect(ig("garde", false)).toBe(false);
    expect(ig("src/a.ts", false)).toBe(false);
  });
});

// ───────────────────────────── Workspace ─────────────────────────────

describe("Workspace", () => {
  it("kind, requireFile, get, text", async () => {
    const dir = sb({ "a.txt": "hello\n", "d/x.txt": "x", "big.txt": "0123456789", "bin.dat": Buffer.from([1, 0, 2]), "bad.txt": Buffer.from([0xc3, 0x28]) });
    fs.symlinkSync("a.txt", path.join(dir, "lnk"));
    const ws = new fls.Workspace(dir, 6);
    expect(ws.kind("a.txt")).toBe("file");
    expect(ws.kind("d")).toBe("dir");
    expect(ws.kind("lnk")).toBe("link");
    expect(ws.kind("nope")).toBeNull();
    expect(ws.linkTarget("lnk")).toBe("a.txt");
    expect(() => ws.requireFile("nope")).toThrow(/introuvable/);
    expect(() => ws.requireFile("d")).toThrow(/dossier/);
    expect(() => ws.requireFile("lnk")).toThrow(/lien symbolique/);
    expect(ws.get("a.txt").toString()).toBe("hello\n");
    expect(ws.text("a.txt")).toBe("hello\n");
    expect(() => ws.text("big.txt")).toThrow(/--max-size/);
    expect(() => ws.text("bin.dat")).toThrow(/binaire/);
    expect(() => ws.text("bad.txt")).toThrow(/UTF-8/);
  });

  it("surcouche : write, remove, move, list, kind virtuel", async () => {
    const dir = sb({ "src/a.ts": "a", "src/lib/b.ts": "b", "top.txt": "t", "run.sh": "#!/bin/sh\n" });
    fs.chmodSync(path.join(dir, "run.sh"), 0o755);
    const ws = new fls.Workspace(dir, 1000);
    ws.write("new/deep/c.ts", Buffer.from("c"));
    expect(ws.kind("new")).toBe("dir");
    expect(ws.kind("new/deep/c.ts")).toBe("file");
    expect(ws.get("new/deep/c.ts").toString()).toBe("c");
    ws.write("new/deep/c.ts", Buffer.from("c2"));
    expect(ws.text("new/deep/c.ts")).toBe("c2");
    ws.remove("src/lib/b.ts");
    expect(ws.kind("src/lib/b.ts")).toBeNull();
    expect(ws.list("src")).toEqual(["a.ts", "lib"]);
    ws.remove("src/a.ts");
    expect(ws.list("src")).toEqual(["lib"]);
    expect(ws.list("")).toEqual(["new", "run.sh", "src", "top.txt"]);
    expect(ws.list("new")).toEqual(["deep"]);
    ws.move("run.sh", "bin/run.sh");
    expect(ws.modeOf("bin/run.sh")).toBe(0o755);
    expect(ws.list("")).toEqual(["bin", "new", "src", "top.txt"]);
    expect(() => ws.move("top.txt", "new")).toThrow(/existe déjà/);
    expect(ws.modeOf("top.txt")).toBe(0o644);
    expect(ws.modeOf("absent.txt")).toBe(0o644);
  });

  it("surcouche : erreurs d'écriture", async () => {
    const dir = sb({ "d/x.txt": "x", "f.txt": "f" });
    fs.symlinkSync("f.txt", path.join(dir, "lnk"));
    const ws = new fls.Workspace(dir, 1000);
    expect(() => ws.write("d", Buffer.from("x"))).toThrow(/dossier/);
    expect(() => ws.write("lnk", Buffer.from("x"))).toThrow(/lien symbolique/);
    expect(() => ws.write("f.txt/sub.txt", Buffer.from("x"))).toThrow(/est un fichier/);
  });

  it("resolve refuse les liens sortants", async () => {
    const outside = sb({ "secret.txt": "s" });
    const dir = sb({});
    fs.symlinkSync(outside, path.join(dir, "out"));
    const ws = new fls.Workspace(dir, 1000);
    expect(ws.resolve("nouveau/fichier.txt")).toBe(path.join(dir, "nouveau/fichier.txt"));
    expect(() => ws.resolve("out/secret.txt")).toThrow(/lien symbolique/);
    expect(() => ws.write("out/new.txt", Buffer.from("x"))).toThrow(/lien symbolique/);
  });

  it("pending ignore les no-ops, apply écrit et sauvegarde", async () => {
    const dir = sb({ "keep.txt": "same", "edit.txt": "old", "gone.txt": "bye" });
    const ws = new fls.Workspace(dir, 1000);
    ws.write("keep.txt", Buffer.from("same"));
    ws.write("tmp.txt", Buffer.from("x"));
    ws.remove("tmp.txt");
    ws.write("edit.txt", Buffer.from("new"));
    ws.remove("gone.txt");
    ws.write("sub/created.txt", Buffer.from("c"));
    expect(ws.diskFile("sub")).toBeNull();
    const pending = ws.pending();
    expect(pending.map((p) => p.rel)).toEqual(["edit.txt", "gone.txt", "sub/created.txt"]);
    const backup = path.join(dir, "bk");
    fs.mkdirSync(backup);
    const entries = ws.apply(pending, backup);
    expect(entries.map((e) => [e.path, e.backup, e.after === null])).toEqual([
      ["edit.txt", "0", false],
      ["gone.txt", "1", true],
      ["sub/created.txt", null, false],
    ]);
    expect(read(dir, "edit.txt")).toBe("new");
    expect(exists(dir, "gone.txt")).toBe(false);
    expect(read(dir, "sub/created.txt")).toBe("c");
    expect(fs.readFileSync(path.join(backup, "0"), "utf8")).toBe("old");
  });
});

// ───────────────────────────── Parseur ─────────────────────────────

describe("parseScript", () => {
  it("script complet", async () => {
    const ops = fls.parseScript(
      [
        "# commentaire",
        "",
        '@read "src/a b.ts" 1-3 --line-numbers',
        "@grep x . -C 3",
        '@note "--tiret"',
        "@edit f.txt",
        "<<<<<<< SEARCH",
        "a",
        "=======",
        "b",
        ">>>>>>> REPLACE",
        "",
        "<<<<<<< SEARCH",
        "c",
        "=======",
        ">>>>>>> REPLACE",
        '@create "n f.txt"',
        "",
        "<<<<<<< CONTENT",
        "l1",
        "",
        "l3",
        ">>>>>>> END",
        "@write vide.txt",
        "<<<<<<< CONTENT",
        ">>>>>>> END",
        "@tree",
      ].join("\r\n"),
    );
    expect(ops.map((o) => o.name)).toEqual(["read", "grep", "note", "edit", "create", "write", "tree"]);
    expect(ops[0].args).toEqual(["src/a b.ts", "1-3"]);
    expect(ops[0].opts).toEqual({ "line-numbers": true });
    expect(ops[1].opts).toEqual({ context: "3" });
    expect(ops[2].args).toEqual(["--tiret"]);
    expect(ops[3].edits).toEqual([
      { search: "a", replace: "b" },
      { search: "c", replace: "" },
    ]);
    expect(ops[4].content).toBe("l1\n\nl3\n");
    expect(ops[5].content).toBe("");
    expect(ops[6].line).toBe(27);
  });

  const bad: Array<[string, string, RegExp]> = [
    ["ligne inattendue", "foo", /ligne 1 : ligne inattendue/],
    ["directive inconnue", "\n@nope x", /ligne 2 : directive inconnue @nope/],
    ["guillemet", '@note "abc', /guillemet non fermé/],
    ["option inconnue", "@tree --nope", /option inconnue --nope/],
    ["option prototype", "@tree --constructor", /option inconnue --constructor/],
    ["valeur manquante", "@tree --depth", /attend une valeur/],
    ["trop d'arguments", "@delete a b", /entre 1 et 1 argument/],
    ["pas assez d'arguments", "@delete", /reçu 0/],
    ["edit sans bloc", "@edit f", /attend un bloc <<<<<<< SEARCH/],
    ["SEARCH sans séparateur", "@edit f\n<<<<<<< SEARCH\na", /marqueur ======= manquant/],
    ["REPLACE non fermé", "@edit f\n<<<<<<< SEARCH\na\n=======\nb", /marqueur >>>>>>> REPLACE manquant/],
    ["SEARCH vide", "@edit f\n<<<<<<< SEARCH\n=======\nb\n>>>>>>> REPLACE", /SEARCH vide/],
    ["create sans bloc", "@create f", /attend un bloc <<<<<<< CONTENT/],
    ["CONTENT non fermé", "@create f\n<<<<<<< CONTENT\nx", /marqueur >>>>>>> END manquant/],
  ];
  for (const [name, text, re] of bad) {
    it(`erreur : ${name}`, async () => {
      expect(() => fls.parseScript(text)).toThrow(re);
    });
  }

  it("sérialisation : aller-retour stable", async () => {
    const text = [
      '@read "a b.ts" 2 --line-numbers',
      "@grep needle src -C 2 --regex",
      "@edit f.txt",
      "<<<<<<< SEARCH",
      "a",
      "b",
      "=======",
      ">>>>>>> REPLACE",
      "@create n.txt",
      "<<<<<<< CONTENT",
      "x",
      "",
      "y",
      ">>>>>>> END",
      "@write empty.txt",
      "<<<<<<< CONTENT",
      ">>>>>>> END",
      "@tree src --depth 2",
    ].join("\n");
    const flat = fls.serialize(fls.parseScript(text));
    expect(flat).toContain("@grep needle src --context 2 --regex");
    expect(flat).toContain('@read "a b.ts" 2 --line-numbers');
    expect(fls.serialize(fls.parseScript(flat))).toBe(flat);
    expect(fls.parseScript(flat)).toEqual(fls.parseScript(text).map((o) => ({ ...o, line: expect.any(Number) })));
  });
});

// ───────────────────────────── Directives de lecture ─────────────────────────────

describe("forme #@ et zone clip", () => {
  const names = (t: string) => fls.parseScript(t).map((o) => o.name);
  it("#@ équivaut à @ et se mélange", () => {
    const a = fls.parseScript('#@note "x"\n#@read f.ts 1-3\n@grep "y" . -C 2');
    const b = fls.parseScript('@note "x"\n@read f.ts 1-3\n@grep "y" . -C 2');
    expect(fls.serialize(a)).toBe(fls.serialize(b));
  });
  it("#@ + espace et # @read restent des commentaires", () => {
    expect(fls.parseScript("#@ texte\n# @read f\n#@\n#@1")).toEqual([]);
  });
  it("#@ inconnu ou d'écriture : syntax_error", () => {
    expect(() => fls.parseScript("#@reed f")).toThrow(/directive inconnue #@reed/);
    expect(() => fls.parseScript("#@edit f")).toThrow(/exigent la forme @edit/);
    expect(() => fls.parseScript("\n#@delete f")).toThrow(/ligne 2/);
  });
  it("zone clip : le reste est ignoré", () => {
    const t = ["avant ?", "##### clip start #####", '#@note "a"', "#@read f", "##### clip end #####", "cd ~/X && fls --clip"].join("\n");
    expect(names(t)).toEqual(["note", "read"]);
  });
  it("plusieurs zones, marqueurs tolérants, end manquant", () => {
    const t = ["### CLIP START", "#@read a", "### Clip End ###", "bruit", "###clip start", "@read b", "#@read c"].join("\n");
    expect(names(t)).toEqual(["read", "read", "read"]);
  });
  it("sans clip start : comportement inchangé", () => {
    expect(() => fls.parseScript("#@read a\ncd x && fls --clip")).toThrow(/ligne inattendue/);
    expect(names("##### clip end #####\n#@read a")).toEqual(["read"]);
  });
  it("numérotation conservée avec zone clip", () => {
    expect(() => fls.parseScript("x\n#### clip start ####\n@bogus")).toThrow(/ligne 3/);
  });
});

describe("forme #@ de bout en bout", () => {
  const paste = [
    "##### clip start #####",
    '#@note "hook session"',
    "#@read a.ts",
    '#@grep "needle" . --context 1',
    "##### clip end #####",
    "cd ~/DEV/X && fls --clip",
  ].join("\n");
  const files = { "a.ts": "un\ndeux\n", "b.ts": "avant\nneedle\naprès\n" };

  it("--clip : lit le bloc collé (ligne cd ignorée) et copie le rapport", async () => {
    const r = await run(["--clip"], files, { clipboard: paste });
    expect(r.code).toBe(0);
    expect(r.text).toContain("OK    NOTE hook session");
    expect(r.text).toContain("=== a.ts (2 lignes) ===");
    expect(r.text).toContain("b.ts:2: needle");
    expect(r.text).toContain("Résumé : 3 OK, 0 FAIL, 0 SKIP");
    expect(r.clip.text).toBe(r.text);
  });

  it("stdin : même résultat que la forme @", async () => {
    const hashed = await run([], files, { stdin: paste });
    const plain = await run([], files, { stdin: '@note "hook session"\n@read a.ts\n@grep "needle" . --context 1\n' });
    const body = (t: string) => t.split("\n").slice(1).join("\n");
    expect(body(hashed.text)).toBe(body(plain.text));
  });

  it("--file : lit un fichier contenant des #@", async () => {
    const r = await run(["--file", "s.fls"], { ...files, "s.fls": paste });
    expect(r.code).toBe(0);
    expect(r.text).toContain("Résumé : 3 OK");
  });

  it("expand écrit la forme canonique @", async () => {
    const r = await run(["expand"], files, { stdin: paste });
    expect(r.text).toBe('@note "hook session"\n\n@read a.ts\n\n@grep needle . --context 1\n');
  });

  it("directive d'écriture en #@ : exit 2, rien d'exécuté", async () => {
    const dir = sb(files);
    const r = await call(dir, [], { stdin: '#@note "x"\n#@create n.txt\n' });
    expect(r.code).toBe(2);
    expect(r.errText).toMatch(/syntax_error : ligne 2 : .*exigent la forme @create/);
    expect(exists(dir, "n.txt")).toBe(false);
  });

  it("sans clip start, la ligne cd reste une erreur de syntaxe", async () => {
    const r = await run([], files, { stdin: "#@read a.ts\ncd ~/X && fls --clip\n" });
    expect(r.code).toBe(2);
    expect(r.errText).toMatch(/ligne 2/);
  });
});

describe("@tree", () => {
  const files: Files = { "src/a.ts": "a\n", "src/lib/b.ts": "b\n", "README.md": "# hi\n", ".git/config": "x", "node_modules/x/index.js": "y" };
  const setup = (dir: string) => fs.symlinkSync("README.md", path.join(dir, "link"));

  it("racine, ignores et liens", async () => {
    const r = await script("@tree\n", files, [], { setup });
    expect(r.code).toBe(0);
    expect(r.text).toContain("├── README.md");
    expect(r.text).toContain("├── link -> README.md");
    expect(r.text).toContain("└── src/");
    expect(r.text).toContain("    ├── a.ts");
    expect(r.text).toContain("    └── lib/");
    expect(r.text).not.toContain("node_modules");
    expect(r.text).not.toContain(".git");
    expect(r.text).toContain("fls 1.5.0 | run r1 |");
  });

  it("dossier non terminal : le tronc continue", async () => {
    const r = await script("@tree\n", { "a/x.txt": "x", "b.txt": "b" });
    expect(r.text).toContain("├── a/\n│   └── x.txt\n└── b.txt");
  });

  it("profondeur, dossiers seuls, profondeur 0", async () => {
    expect((await script("@tree src --depth 1\n", files)).text).not.toContain("b.ts");
    const dirsOnly = (await script("@tree src --dirs-only\n", files)).text;
    expect(dirsOnly).toContain("lib/");
    expect(dirsOnly).not.toContain("a.ts");
    expect((await script("@tree src --depth 0\n", files)).text).not.toContain("a.ts");
  });

  it("erreurs", async () => {
    expect((await script("@tree nope\n", files)).text).toContain("not_found");
    expect((await script("@tree README.md\n", files)).text).toContain("not_a_directory");
    const r = await script("@tree --depth abc\n", files);
    expect(r.code).toBe(1);
    expect(r.text).toContain("invalid_argument");
  });
});

describe("@read", () => {
  const files: Files = { "f.txt": "l1\nl2\nl3\nl4\n", "empty.txt": "" };

  it("fichier entier, plages et numéros de ligne", async () => {
    const all = (await script("@read f.txt\n", files)).text;
    expect(all).toContain("=== f.txt (4 lignes) ===\nl1\nl2\nl3\nl4\n=== fin ===");
    expect((await script("@read f.txt --lines 2-3\n", files)).text).toContain("=== f.txt (lignes 2-3 sur 4) ===\nl2\nl3\n");
    expect((await script("@read f.txt 2-3\n", files)).text).toContain("(lignes 2-3 sur 4)");
    expect((await script("@read f.txt 3-\n", files)).text).toContain("(lignes 3-4 sur 4)");
    expect((await script("@read f.txt 2\n", files)).text).toContain("(lignes 2-2 sur 4)");
    expect((await script("@read f.txt 3-99\n", files)).text).toContain("(lignes 3-4 sur 4)");
    expect((await script("@read f.txt --line-numbers --lines 3-4\n", files)).text).toContain("3 | l3\n4 | l4");
    expect((await script("@read empty.txt\n", files)).text).toContain("(0 lignes)");
  });

  it("plages invalides et fichier absent", async () => {
    for (const bad of ["abc", "5-2", "0", "9-9"]) {
      const r = await script(`@read f.txt ${bad}\n`, files);
      expect(r.code).toBe(1);
      expect(r.text).toContain("invalid_argument");
    }
    expect((await script("@read nope.txt\n", files)).text).toContain("not_found");
  });

  it("dossier : arbre puis contenus, avec omissions", async () => {
    const r = await script(
      "@read .\n@read . --depth 1 --line-numbers\n",
      { "a.txt": "A\n", "sub/b.txt": "B\n", "bin.dat": Buffer.from([1, 0, 2]), "big.txt": "x".repeat(200) },
      ["--max-size", "100"],
      { setup: (dir) => fs.symlinkSync("a.txt", path.join(dir, "lnk")) },
    );
    expect(r.text).toContain("READ . (dossier, 5 fichier(s))");
    expect(r.text).toContain("=== a.txt (1 lignes) ===\nA\n=== fin ===");
    expect(r.text).toContain("=== sub/b.txt (1 lignes) ===");
    expect(r.text).toContain("=== bin.dat ===\n[omis : binary_file]");
    expect(r.text).toContain("=== big.txt ===\n[omis : too_large]");
    expect(r.text).toContain("=== lnk ===\n[omis : symlink]");
    expect(r.text).toContain("1 | A");
  });

  it("dossier nommé", async () => {
    expect((await script("@read src\n", { "src/a.txt": "A\n" })).text).toContain("READ src (dossier, 1 fichier(s))");
  });
});

describe("@grep", () => {
  const files: Files = {
    "a.txt": "one\nfoo\nthree\nfour\nfive\nfoo bar\nseven\n",
    "b.txt": "FOO\nfoo\n",
    "bin.dat": Buffer.from([102, 111, 111, 0]),
  };

  it("contexte, séparateurs et comptage", async () => {
    const r = (await script('@grep "foo" . --context 1\n', files)).text;
    expect(r).toContain('"foo" dans . (3 correspondance(s) dans 2 fichier(s))');
    expect(r).toContain("a.txt-1- one\na.txt:2: foo\na.txt-3- three\n--\na.txt-5- five\na.txt:6: foo bar\na.txt-7- seven\n--\nb.txt-1- FOO\nb.txt:2: foo");
  });

  it("chemin par défaut : le dossier courant", async () => {
    expect((await script('@grep "FOO"\n', files)).text).toContain('"FOO" dans . (1 correspondance(s) dans 1 fichier(s))');
  });

  it("contexte contigu fusionné, forme -C", async () => {
    const r = (await script('@grep "foo" . -C 2\n', files)).text;
    expect(r.match(/^--$/gm)).toHaveLength(1);
  });

  it("regex, casse, fichier précis, dossier précis", async () => {
    expect((await script('@grep "^f.o$" b.txt --regex\n', files)).text).toContain("(1 correspondance(s) dans 1 fichier(s))");
    expect((await script('@grep "foo" b.txt --ignore-case\n', files)).text).toContain("(2 correspondance(s) dans 1 fichier(s))");
    expect((await script('@grep "a.c" a.txt\n', files)).text).toContain("(0 correspondance(s) dans 0 fichier(s))");
    expect((await script('@grep "x" sub\n', { "sub/s.txt": "x\n" })).text).toContain('"x" dans sub (1 correspondance(s)');
  });

  it("erreurs", async () => {
    expect((await script('@grep "(" a.txt --regex\n', files)).text).toContain("invalid_argument");
    expect((await script('@grep "x" nope.txt\n', files)).text).toContain("not_found");
    expect((await script('@grep "foo" bin.dat\n', files)).text).toContain("binary_file");
  });
});

describe("@note", () => {
  it("annote le rapport", async () => {
    expect((await script('@note "étape 1"\n')).text).toContain("[1] OK    NOTE étape 1");
  });
});

// ───────────────────────────── Directives d'écriture ─────────────────────────────

describe("@edit", () => {
  const user = "export interface User {\n  id: string\n  name: string\n}\n\nexport function make(id, name) {\n  return { id, name }\n}\n";

  it("plusieurs blocs, diff dans le rapport", async () => {
    const text =
      "@edit user.ts\n<<<<<<< SEARCH\n  name: string\n}\n=======\n  name: string\n  role: string\n}\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n  return { id, name }\n=======\n  return { id, name, role: 'x' }\n>>>>>>> REPLACE\n";
    const r = await script(text, { "user.ts": user });
    expect(r.code).toBe(0);
    expect(read(r.dir, "user.ts")).toContain("  role: string\n}");
    expect(read(r.dir, "user.ts")).toContain("return { id, name, role: 'x' }");
    expect(r.text).toContain("EDIT user.ts (2 bloc(s), +4 -3)");
    expect(r.text).toContain("@@ bloc 1 (ligne 3)\n-   name: string\n- }\n+   name: string\n+   role: string\n+ }");
    expect(r.text).toContain("Modifiés : user.ts");
    expect(r.text).toContain("Annulable avec : fls undo");
  });

  it("introuvable avec ligne proche, ou sans ligne proche", async () => {
    const near = await script(edit("user.ts", "  return { id, nam }", "x"), { "user.ts": user });
    expect(near.code).toBe(1);
    expect(near.text).toContain("not_found");
    expect(near.text).toContain('ligne la plus proche (l.7) : "return { id, name }"');
    const none = await script(edit("u.txt", "~", "x"), { "u.txt": "ab\n\ncd\n" });
    expect(none.text).toContain("aucune ligne proche");
  });

  it("ambigu", async () => {
    const r = await script(edit("x.txt", "x", "y"), { "x.txt": "x\nx\n" });
    expect(r.text).toContain("ambiguous_match");
    expect(r.text).toContain("trouvé 2 fois");
    expect(r.text).toContain("lignes 1, 2");
  });

  it("atomique : un bloc faux n'écrit rien", async () => {
    const text = `${edit("f.txt", "a", "A")}<<<<<<< SEARCH\nzzz\n=======\nq\n>>>>>>> REPLACE\n`;
    const r = await script(text, { "f.txt": "a\n" });
    expect(r.code).toBe(1);
    expect(read(r.dir, "f.txt")).toBe("a\n");
    expect(exists(r.dir, ".fls")).toBe(false);
  });

  it("fins de ligne CRLF conservées", async () => {
    const r = await script(edit("c.txt", "a\nb", "A\nB"), { "c.txt": "a\r\nb\r\nc\r\n" });
    expect(read(r.dir, "c.txt")).toBe("A\r\nB\r\nc\r\n");
  });

  it("REPLACE vide : suppression de lignes entières ou de texte", async () => {
    expect(read((await script(edit("f", "b", ""), { f: "a\nb\nc\n" })).dir, "f")).toBe("a\nc\n");
    expect(read((await script(edit("f", "a", ""), { f: "a\nb\n" })).dir, "f")).toBe("b\n");
    expect(read((await script(edit("f", "def", ""), { f: "abc def\n" })).dir, "f")).toBe("abc \n");
    expect(read((await script(edit("f", "abc", ""), { f: "abc def\n" })).dir, "f")).toBe(" def\n");
    expect(read((await script(edit("f", "abc", ""), { f: "x\nabc def\n" })).dir, "f")).toBe("x\n def\n");
    expect(read((await script(edit("f", "b\nc", ""), { f: "a\r\nb\r\nc\r\nd\r\n" })).dir, "f")).toBe("a\r\nd\r\n");
  });

  it("erreurs de fichier", async () => {
    expect((await script(edit("nope.txt", "a", "b"))).text).toContain("not_found");
    expect((await script(edit("bin", "a", "b"), { bin: Buffer.from([0, 1]) })).text).toContain("binary_file");
  });
});

describe("@create, @overwrite, @write, @append", () => {
  it("create", async () => {
    const r = await script(content("create", "sub/new.txt", "l1\nl2"));
    expect(read(r.dir, "sub/new.txt")).toBe("l1\nl2\n");
    expect(r.text).toContain("CREATE sub/new.txt (nouveau, 2 lignes)");
    expect((await script(content("create", "x.txt", "y"), { "x.txt": "z" })).text).toContain("already_exists");
    expect((await script("@create e.txt\n<<<<<<< CONTENT\n>>>>>>> END\n")).text).toContain("(nouveau, 0 lignes)");
  });

  it("overwrite", async () => {
    const r = await script(content("overwrite", "x.txt", "new"), { "x.txt": "old" });
    expect(read(r.dir, "x.txt")).toBe("new\n");
    expect(r.text).toContain("(remplacé, 1 lignes)");
    expect((await script(content("overwrite", "x.txt", "n"))).text).toContain("not_found");
  });

  it("write crée ou remplace", async () => {
    expect(read((await script(content("write", "x.txt", "a"))).dir, "x.txt")).toBe("a\n");
    expect(read((await script(content("write", "x.txt", "b"), { "x.txt": "a" })).dir, "x.txt")).toBe("b\n");
  });

  it("append", async () => {
    expect(read((await script(content("append", "x.txt", "b"), { "x.txt": "a\n" })).dir, "x.txt")).toBe("a\nb\n");
    expect(read((await script(content("append", "x.txt", "b"), { "x.txt": "a" })).dir, "x.txt")).toBe("a\nb\n");
    expect(read((await script(content("append", "x.txt", "b"), { "x.txt": "" })).dir, "x.txt")).toBe("b\n");
    const created = await script(content("append", "y.txt", "b"));
    expect(read(created.dir, "y.txt")).toBe("b\n");
    expect(created.text).toContain("APPEND y.txt (+1 lignes)");
    expect((await script(content("append", "d", "b"), { "d/f": "x" })).text).toContain("is_directory");
  });

  it("erreurs d'emplacement", async () => {
    expect((await script(content("write", "d", "b"), { "d/f": "x" })).text).toContain("is_directory");
    expect((await script(content("write", "f/sub.txt", "b"), { f: "x" })).text).toContain("not_a_directory");
    const link = await script(content("write", "lnk", "b"), { "t.txt": "x" }, [], { setup: (d) => fs.symlinkSync("t.txt", path.join(d, "lnk")) });
    expect(link.text).toContain("symlink");
  });

  it("un contenu identique n'est pas un changement", async () => {
    const r = await script(content("overwrite", "x.txt", "same"), { "x.txt": "same\n" });
    expect(r.code).toBe(0);
    expect(r.text).toContain("Modifiés : aucun");
    expect(exists(r.dir, ".fls")).toBe(false);
  });
});

describe("@delete, @move", () => {
  it("delete", async () => {
    const r = await script("@delete a.txt\n", { "a.txt": "x" });
    expect(exists(r.dir, "a.txt")).toBe(false);
    expect((await script("@delete nope\n")).text).toContain("not_found");
    expect((await script("@delete d\n", { "d/x": "x" })).text).toContain("is_directory");
  });

  it("move conserve le mode et refuse d'écraser", async () => {
    const r = await script("@move run.sh bin/run.sh\n", { "run.sh": "#!/bin/sh\n" }, [], { setup: (d) => fs.chmodSync(path.join(d, "run.sh"), 0o755) });
    expect(exists(r.dir, "run.sh")).toBe(false);
    expect(fs.statSync(path.join(r.dir, "bin/run.sh")).mode & 0o777).toBe(0o755);
    expect((await script("@move a b\n", { a: "1", b: "2" })).text).toContain("already_exists");
    expect((await script("@move nope b\n")).text).toContain("not_found");
    expect((await script("@move d e\n", { "d/x": "x" })).text).toContain("is_directory");
  });
});

// ───────────────────────────── Exécution, politique d'échec, chemins ─────────────────────────────

describe("exécution", () => {
  it("après un échec d'écriture : écritures SKIP, lectures et lectures échouées sans blocage", async () => {
    const text = [
      "@read missing.txt\n",
      content("create", "one.txt", "1"),
      edit("nope.txt", "a", "b"),
      content("create", "two.txt", "2"),
      "@read one.txt",
    ].join("");
    const r = await script(text);
    expect(r.code).toBe(1);
    expect(exists(r.dir, "one.txt")).toBe(true);
    expect(exists(r.dir, "two.txt")).toBe(false);
    expect(r.text).toContain("[1] FAIL  READ missing.txt : not_found");
    expect(r.text).toContain("[4] SKIP  CREATE two.txt : skipped\n    ignoré");
    expect(r.text).toContain("=== one.txt (1 lignes) ===\n1\n=== fin ===");
    expect(r.text).toContain("Résumé : 2 OK, 2 FAIL, 1 SKIP");
  });

  it("les lectures voient l'état simulé (dossiers virtuels, suppressions)", async () => {
    const text = [content("create", "gen/new.txt", "n"), "@delete old.txt\n", "@tree\n", "@read gen\n"].join("");
    const r = await script(text, { "old.txt": "o" });
    expect(r.text).toContain("└── gen/\n    └── new.txt");
    expect(r.text).not.toContain("old.txt\n└");
    expect(r.text).toContain("=== gen/new.txt (1 lignes) ===");
  });

  it("chemins hors du dossier", async () => {
    expect((await script("@read /etc/hostname\n")).text).toContain("outside_workspace");
    expect((await script("@read ../x\n")).text).toContain("outside_workspace");
    const outside = sb({ "secret.txt": "s" });
    const r = await script(`${"@read out/secret.txt\n"}${content("create", "out/new.txt", "x")}`, {}, [], { setup: (d) => fs.symlinkSync(outside, path.join(d, "out")) });
    expect(r.text).toContain("outside_workspace");
    expect(exists(outside, "new.txt")).toBe(false);
  });

  it("ignore : .gitignore, .flsignore et --ignore", async () => {
    const files: Files = { ".gitignore": "ignored.txt\n", ".flsignore": "*.tmp\n", "ignored.txt": "1", "x.tmp": "2", "skip.bak": "3", "keep.txt": "4" };
    const r = await script("@tree\n", files, ["--ignore", "*.bak"]);
    expect(r.text).toContain("keep.txt");
    for (const hidden of ["ignored.txt", "x.tmp", "skip.bak"]) expect(r.text).not.toContain(hidden);
  });

  it("--dry-run : simule sans écrire", async () => {
    const r = await script(`${content("create", "n.txt", "x")}@read n.txt\n`, {}, ["--dry-run"]);
    expect(r.code).toBe(0);
    expect(exists(r.dir, "n.txt")).toBe(false);
    expect(exists(r.dir, ".fls")).toBe(false);
    expect(r.text).toContain("| dry-run |");
    expect(r.text).toContain("Modifierait : n.txt");
    expect(r.text).toContain("=== n.txt (1 lignes) ===");
    expect(r.text).not.toContain("Annulable");
  });

  it("script vide", async () => {
    const r = await script("");
    expect(r.code).toBe(0);
    expect(r.text).toContain("Résumé : 0 OK, 0 FAIL, 0 SKIP");
  });
});

// ───────────────────────────── Sources de script, lecture rapide, sorties ─────────────────────────────

describe("sources et sorties", () => {
  it("--file, relatif au dossier courant", async () => {
    const r = await run(["--file", "s.fls"], { "s.fls": "@note ok\n" });
    expect(r.text).toContain("NOTE ok");
  });

  it("--clip lit le presse-papiers et y copie le rapport ; --clip-in et --clip-out séparés", async () => {
    const both = await run(["--clip"], {}, { clipboard: "@note via-clip\n" });
    expect(both.text).toContain("NOTE via-clip");
    expect(both.clip.text).toBe(both.text);
    const clipIn = await run(["--clip-in"], {}, { clipboard: "@note seul\n" });
    expect(clipIn.clip.text).toBe("@note seul\n");
    const clipOut = await run(["--clip-out"], {}, { stdin: "@note out\n" });
    expect(clipOut.clip.text).toBe(clipOut.text);
  });

  it("sans argument : affiche l'usage", async () => {
    const r = await run([], {}, { tty: true });
    expect(r.code).toBe(0);
    expect(r.text).toContain("Usage :");
    expect(r.errText).toBe("");
  });

  it("expand sans script : erreur d'usage", async () => {
    const r = await run(["expand"], {}, { tty: true });
    expect(r.code).toBe(2);
    expect(r.errText).toContain("usage_error");
    expect(r.errText).toContain("aucun script");
  });

  it("lecture rapide : chemins, --paths-from, --output, --clip", async () => {
    const files: Files = { "src/a.ts": "A\n", "lib/b.ts": "B\n", "list.txt": "src\n\nlib/b.ts\n" };
    const q = await run(["src/", "lib/b.ts"], files);
    expect(q.code).toBe(0);
    expect(q.text).toContain("[1] OK    READ src (dossier, 1 fichier(s))");
    expect(q.text).toContain("[2] OK    READ lib/b.ts (1 lignes)");
    const fromFile = await run(["--paths-from", "list.txt"], files);
    expect(fromFile.text).toContain("[2] OK    READ lib/b.ts");
    const out = await run(["src", "--output", "rapport.txt"], files);
    expect(out.text).toBe("");
    expect(read(out.dir, "rapport.txt")).toContain("READ src");
    const clip = await run(["src", "--clip"], files);
    expect(clip.clip.text).toBe(clip.text);
    expect((await run(["absent"], files)).code).toBe(1);
  });

  it("troncature du rapport et validation des nombres", async () => {
    const files: Files = { "a.txt": "x".repeat(500) };
    const r = await run(["a.txt", "--max-output-chars", "100"], files);
    expect(r.text.startsWith("fls 1.5.0")).toBe(true);
    expect(r.text).toMatch(/\[rapport tronqué : \d+ caractères omis/);
    for (const bad of ["0", "abc"]) {
      const e = await run(["a.txt", "--max-output-chars", bad], files);
      expect(e.code).toBe(2);
      expect(e.errText).toContain("usage_error");
    }
    expect((await run(["a.txt", "--max-size", "0"], files)).code).toBe(2);
  });

  it("expand affiche le script plat", async () => {
    const r = await script('# c\n@grep "a b" . -C 2\n@read f 1-2\n', {}, ["expand"]);
    expect(r.code).toBe(0);
    expect(r.text).toBe('@grep "a b" . --context 2\n\n@read f 1-2\n');
    expect((await script("@bad\n", {}, ["expand"])).code).toBe(2);
  });
});

// ───────────────────────────── Journal : log et undo ─────────────────────────────

describe("journal", () => {
  async function twoRuns() {
    const dir = sb({ "a.txt": "one\n", "gone.txt": "bye\n", "run.sh": "#!/bin/sh\n" });
    fs.chmodSync(path.join(dir, "run.sh"), 0o755);
    const first = await call(dir, [], {
      stdin: `${edit("a.txt", "one", "ONE")}${content("create", "new.txt", "n")}@delete gone.txt\n@move run.sh bin/run.sh\n`,
      id: "r1",
    });
    const second = await call(dir, [], { stdin: edit("a.txt", "ONE", "TWO"), id: "r2" });
    return { dir, first, second };
  }

  it("log liste les runs et détaille un run", async () => {
    const empty = await run(["log"]);
    expect(empty.text).toBe("Aucun run enregistré.\n");
    const { dir } = await twoRuns();
    const list = (await call(dir, ["log"])).text;
    expect(list).toContain("r1  2026-11-19T10:00:00.123Z  5 fichier(s)");
    expect(list).toContain("r2  2026-11-19T10:00:00.123Z  1 fichier(s)");
    const detail = (await call(dir, ["log", "--run", "r1"])).text;
    expect(detail).toContain("=== script plat (r1) ===");
    expect(detail).toContain("@delete gone.txt");
    expect(detail).toContain("=== rapport ===");
    expect(detail).toContain("Annulable avec : fls undo");
    expect((await call(dir, ["log", "--run", "zzz"])).errText).toContain("run_not_found");
    expect((await call(dir, ["log", "--run", "../x"])).code).toBe(1);
  });

  it("undo annule le dernier run non annulé, puis le précédent", async () => {
    const { dir } = await twoRuns();
    const u2 = await call(dir, ["undo"]);
    expect(u2.code).toBe(0);
    expect(u2.text).toContain("UNDO r2 (1 fichier(s) restauré(s))");
    expect(read(dir, "a.txt")).toBe("ONE\n");
    expect((await call(dir, ["log"])).text).toContain("[annulé]");
    const u1 = await call(dir, ["undo"]);
    expect(u1.text).toContain("UNDO r1 (5 fichier(s) restauré(s))");
    expect(read(dir, "a.txt")).toBe("one\n");
    expect(exists(dir, "new.txt")).toBe(false);
    expect(read(dir, "gone.txt")).toBe("bye\n");
    expect(exists(dir, "bin/run.sh")).toBe(false);
    expect(fs.statSync(path.join(dir, "run.sh")).mode & 0o777).toBe(0o755);
    const none = await call(dir, ["undo"]);
    expect(none.code).toBe(1);
    expect(none.errText).toContain("nothing_to_undo");
  });

  it("undo ciblé, déjà annulé, inconnu", async () => {
    const { dir } = await twoRuns();
    expect((await call(dir, ["undo", "--run", "r1"])).code).toBe(1);
    expect((await call(dir, ["undo", "--run", "r2"])).code).toBe(0);
    const again = await call(dir, ["undo", "--run", "r2"]);
    expect(again.code).toBe(1);
    expect(again.errText).toContain("already_undone");
    expect((await call(dir, ["undo", "--run", "nope"])).errText).toContain("run_not_found");
  });

  it("undo refuse en cas de conflit, sauf --force", async () => {
    const { dir } = await twoRuns();
    fs.writeFileSync(path.join(dir, "a.txt"), "modifié à la main\n");
    const refused = await call(dir, ["undo", "--run", "r2"]);
    expect(refused.code).toBe(1);
    expect(refused.errText).toContain("conflict");
    expect(refused.errText).toContain("a.txt");
    expect(read(dir, "a.txt")).toBe("modifié à la main\n");
    expect((await call(dir, ["undo", "--run", "r2", "--force"])).code).toBe(0);
    expect(read(dir, "a.txt")).toBe("ONE\n");
  });
});

// ───────────────────────────── Aide, spec, init ─────────────────────────────

describe("aide", () => {
  it("--help, -h, --version", async () => {
    expect((await run(["--help"])).text).toContain("fls <chemin...>");
    expect((await run(["-h"])).text).toContain("Sous-commandes".length ? "Usage :" : "");
    expect((await run(["--version"])).text).toBe("fls 1.5.0\n");
  });

  it("spec contient toutes les directives et tous les codes d'erreur", async () => {
    const spec = (await run(["spec"])).text;
    for (const d of fls.DIRECTIVES) expect(spec).toContain(`@${d.name} —`);
    for (const [code] of fls.ERROR_CODES) expect(spec).toContain(code);
    expect(spec).toContain("# Référence de la syntaxe fls (v1)");
  });

  it("chaque exemple de directive est un script valide", async () => {
    for (const d of fls.DIRECTIVES) {
      for (const example of d.examples) expect(() => fls.parseScript(example)).not.toThrow();
      expect(fls.helpText(d)).toContain(d.usage);
    }
  });

  it("help", async () => {
    expect((await run(["help"])).text).toContain("@tree, @read, @grep");
    expect((await run(["help", "@read"])).text).toContain("Usage : @read <chemin>");
    const unknown = await run(["help", "nope"]);
    expect(unknown.code).toBe(2);
    expect(unknown.errText).toContain("unknown_directive");
  });

  it("init est idempotent", async () => {
    const dir = sb({});
    const first = await call(dir, ["init"]);
    expect(first.text).toContain(".flsignore (créé)");
    expect(first.text).toContain(".gitignore (mis à jour)");
    expect(read(dir, ".gitignore")).toBe(".fls/\n");
    const second = await call(dir, ["init"]);
    expect(second.text).toContain(".flsignore (déjà présent)");
    expect(second.text).toContain(".gitignore (déjà à jour)");
    const noNewline = sb({ ".gitignore": "node_modules" });
    await call(noNewline, ["init"]);
    expect(read(noNewline, ".gitignore")).toBe("node_modules\n.fls/\n");
    const withNewline = sb({ ".gitignore": "node_modules\n" });
    await call(withNewline, ["init"]);
    expect(read(withNewline, ".gitignore")).toBe("node_modules\n.fls/\n");
  });
});

// ───────────────────────────── Ligne de commande ─────────────────────────────

describe("parseArgs et main", () => {
  it("parseArgs", async () => {
    const a = fls.parseArgs(["a", "--dry-run", "-h", "--ignore", "x", "--ignore", "y", "--file", "f", "b"]);
    expect(a.positional).toEqual(["a", "b"]);
    expect([...a.flags].sort()).toEqual(["dry-run", "help"]);
    expect(a.ignore).toEqual(["x", "y"]);
    expect(a.values.get("file")).toBe("f");
    expect(() => fls.parseArgs(["--nope"])).toThrow(/option inconnue/);
    expect(() => fls.parseArgs(["--constructor"])).toThrow(/option inconnue/);
    expect(() => fls.parseArgs(["--file"])).toThrow(/attend une valeur/);
  });

  it("codes de sortie et messages d'erreur", async () => {
    const syntax = await script("???\n");
    expect(syntax.code).toBe(2);
    expect(syntax.errText).toContain("syntax_error : ligne 1");
    expect((await run(["--nope"])).code).toBe(2);
    const missing = await run(["--file", "absent.fls"]);
    expect(missing.code).toBe(1);
    expect(missing.errText).toContain("ENOENT");
    const plain = fake(sb({}), { stdin: "@note x\n" });
    plain.io.readStdin = () => {
      throw new TypeError("boom");
    };
    expect(await fls.main([], plain.io)).toBe(1);
    expect(plain.err.join("")).toBe("fls : boom\n");
  });

  it("presse-papiers indisponible", async () => {
    const f = fake(sb({}), { stdin: "@note x\n" });
    f.io.clipboard = {
      read: () => {
        throw new fls.FlsError("clipboard_unavailable", "non");
      },
      write: () => {
        throw new fls.FlsError("clipboard_unavailable", "non");
      },
    };
    expect(await fls.main(["--clip"], f.io)).toBe(1);
    expect(f.err.join("")).toContain("clipboard_unavailable");
    expect(await fls.main(["--clip-out"], f.io)).toBe(1);
  });
});

// ───────────────────────────── Presse-papiers, E/S réelles, point d'entrée ─────────────────────────────

describe("presse-papiers", () => {
  it("createClipboard essaie chaque outil dans l'ordre", async () => {
    const calls: string[] = [];
    const runner: fls.Runner = {
      capture: (cmd) => {
        calls.push(`capture:${cmd}`);
        return cmd === "xsel" ? "du texte" : null;
      },
      feed: (cmd) => {
        calls.push(`feed:${cmd}`);
        return cmd === "pbcopy";
      },
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
    };
    const clip = fls.createClipboard(runner);
    expect(clip.read()).toBe("du texte");
    expect(calls).toEqual(["capture:wl-paste", "capture:xclip", "capture:xsel"]);
    clip.write("x");
    expect(calls.slice(3)).toEqual(["feed:wl-copy", "feed:xclip", "feed:xsel", "feed:pbcopy"]);
  });

  it("createClipboard échoue proprement sans outil", async () => {
    const clip = fls.createClipboard({ capture: () => null, feed: () => false, exec: () => ({ status: 0, stdout: "", stderr: "" }) });
    expect(() => clip.read()).toThrow(/presse-papiers/);
    expect(() => clip.write("x")).toThrow(/presse-papiers/);
  });

  it("realRunner exécute de vrais processus", async () => {
    expect(fls.realRunner.capture(process.execPath, ["-e", "process.stdout.write('hi')"])).toBe("hi");
    expect(fls.realRunner.capture(process.execPath, ["-e", "process.exit(3)"])).toBeNull();
    expect(fls.realRunner.capture("fls-commande-inexistante", [])).toBeNull();
    const eat = "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))";
    expect(fls.realRunner.feed(process.execPath, ["-e", eat], "x")).toBe(true);
    expect(fls.realRunner.feed("fls-commande-inexistante", [], "x")).toBe(false);
    const ex = fls.realRunner.exec(process.execPath, ["-e", "process.stdout.write('out');process.stderr.write('err')"]);
    expect(ex).toEqual({ status: 0, stdout: "out", stderr: "err" });
    const bad = fls.realRunner.exec("fls-commande-inexistante", []);
    expect(bad.status).not.toBe(0);
    expect(typeof bad.stdout).toBe("string");
    expect(typeof bad.stderr).toBe("string");
  });
});

describe("E/S réelles et point d'entrée", () => {
  it("makeId", async () => {
    expect(fls.makeId(new Date("2026-11-19T10:00:00.123Z"))).toMatch(/^20261119-100000123-[0-9a-f]{4}$/);
  });

  it("createRealIo", async () => {
    const dir = sb({ "in.txt": "entrée" });
    const fd = fs.openSync(path.join(dir, "in.txt"), "r");
    const io = fls.createRealIo(fd);
    expect(io.readStdin()).toBe("entrée");
    expect(io.stdinIsTTY).toBe(false);
    expect(typeof io.stdoutIsTTY).toBe("boolean");
    expect(typeof io.stderrIsTTY).toBe("boolean");
    expect(io.env).toBe(process.env);
    expect(io.cwd).toBe(process.cwd());
    expect(io.now()).toBeInstanceOf(Date);
    expect(io.newId(new Date())).toMatch(/^\d{8}-\d{9}-[0-9a-f]{4}$/);
    expect(typeof io.clipboard.read).toBe("function");
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    io.out("sortie");
    io.err("erreur");
    expect(out).toHaveBeenCalledWith("sortie");
    expect(err).toHaveBeenCalledWith("erreur");
    fs.closeSync(fd);
  });

  it("isEntry, setExitCode, startReal, bootstrap", async () => {
    const self = fileURLToPath(import.meta.url);
    expect(fls.isEntry(undefined, "file:///x")).toBe(false);
    expect(fls.isEntry(self, pathToFileURL(self).href)).toBe(true);
    expect(fls.isEntry(self, "file:///autre")).toBe(false);
    const before = process.exitCode;
    fls.setExitCode(0);
    expect(process.exitCode).toBe(0);
    process.exitCode = before;
    const set = vi.fn();
    await fls.startReal(["--version"], fake(sb({})).io, set);
    expect(set).toHaveBeenCalledWith(0);
    const start = vi.fn();
    fls.bootstrap(false, start);
    expect(start).not.toHaveBeenCalled();
    fls.bootstrap(true, start);
    expect(start).toHaveBeenCalledOnce();
  });

  it("isEntry : chemin absent (catch) avec href identique ou différent", async () => {
    const absent = path.join(os.tmpdir(), `fls-absent-${process.pid}`);
    expect(fls.isEntry(absent, pathToFileURL(absent).href)).toBe(true);
    expect(fls.isEntry(absent, pathToFileURL(path.join(os.tmpdir(), "fls-autre")).href)).toBe(false);
  });

  it("main accepte un Io sans env ni runner explicite", async () => {
    const dir = sb({ "a.txt": "ok\n" });
    const f = fake(dir, { stdin: '@read a.txt\n' });
    const io = { ...f.io } as any;
    delete io.env;
    delete io.runner;
    const code = await fls.main([], io);
    expect(code).toBe(0);
    expect(f.out.map((x) => x.toString()).join("")).toContain("ok");
  });

  it("le binaire fonctionne vraiment (processus réel)", async () => {
    const { spawnSync } = await import("node:child_process");
    const dir = sb({ "a.txt": "hello\n" });
    const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "fls.ts");
    const r = spawnSync(process.execPath, [entry, "a.txt"], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("=== a.txt (1 lignes) ===\nhello");
    const piped = spawnSync(process.execPath, [entry], { cwd: dir, input: '@note "via stdin"\n', encoding: "utf8" });
    expect(piped.stdout).toContain("NOTE via stdin");
  });
});
