// Directives AST : @find_ast et @edit_ast, avec un faux ast-grep (aucune dépendance au binaire).

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecResult, Runner } from "./types.ts";
import { applyAstEdits, astPath, checkMatches, parseAstGrepJson, parseAstGrepVersion, resolveAstGrep, runAstGrep, versionAtLeast } from "./directive/ast.ts";
import { loadIgnore } from "./paths.ts";
import { Journal } from "./journal.ts";
import { Workspace } from "./workspace.ts";
import { runFls, sandbox, type FakeOpts, type Files } from "./testing/io.ts";

type Reply = Partial<ExecResult> & { stdout?: string };

/** Faux ast-grep : `--version` répond toujours, le reste est délégué au test. */
function fakeAst(run: (args: string[]) => Reply, version = "ast-grep 0.51.3"): Runner {
  return {
    capture: () => null,
    feed: () => false,
    exec: (_cmd, args) => {
      if (args[0] === "--version") return { status: 0, stdout: `${version}\n`, stderr: "" };
      return { status: 0, stdout: "", stderr: "", ...run(args) };
    },
  };
}

async function run(argv: string[], files: Files = {}, o: FakeOpts & { setup?: (dir: string) => void } = {}) {
  const dir = sandbox(files, o.setup);
  return { dir, ...(await runFls(dir, argv, o)) };
}
const script = (s: string, files: Files = {}, argv: string[] = [], o: FakeOpts & { setup?: (dir: string) => void } = {}) => run(argv, files, { stdin: s, ...o });
const read = (dir: string, rel: string): string => fs.readFileSync(path.join(dir, rel), "utf8");

/** Un match NDJSON brut (offsets et lignes choisis par le test). */
function raw(
  file: string,
  text: string,
  start: number,
  end: number,
  line = 0,
  endLine = line,
  replacement?: string,
  replacementOffsets?: { start: number; end: number },
): string {
  return JSON.stringify({
    text,
    file,
    range: { byteOffset: { start, end }, start: { line, column: 0 }, end: { line: endLine, column: 0 } },
    ...(replacement === undefined ? {} : { replacement }),
    ...(replacementOffsets === undefined ? {} : { replacementOffsets }),
  });
}

/** Un match NDJSON à partir du texte exact et de son occurrence dans le fichier. */
function match(files: Files, file: string, needle: string, replacement?: string, occurrence = 0): string {
  const content = String(files[file]);
  let at = -1;
  let from = 0;
  for (let k = 0; k <= occurrence; k++) {
    at = content.indexOf(needle, from);
    from = at + 1;
  }
  if (at < 0) throw new Error(`introuvable dans le fixture : ${needle}`);
  const start = Buffer.byteLength(content.slice(0, at), "utf8");
  const end = start + Buffer.byteLength(needle, "utf8");
  const line = content.slice(0, at).split("\n").length - 1;
  const endLine = line + needle.split("\n").length - 1;
  return raw(file, needle, start, end, line, endLine, replacement, replacement === undefined ? undefined : { start, end });
}

const ast = (args: string[]): ExecResult => ({ status: 0, stdout: "", stderr: "" });
const opt = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

describe("socle ast-grep", () => {
  it("lit et compare les versions", () => {
    expect(parseAstGrepVersion("ast-grep 0.51.3\n")).toEqual([0, 51, 3]);
    expect(parseAstGrepVersion("n'importe quoi")).toBeNull();
    expect(versionAtLeast([0, 51, 0], [0, 51, 0])).toBe(true);
    expect(versionAtLeast([0, 51, 1], [0, 51, 0])).toBe(true);
    expect(versionAtLeast([1, 0, 0], [0, 51, 0])).toBe(true);
    expect(versionAtLeast([0, 50, 9], [0, 51, 0])).toBe(false);
  });

  it("refuse une sortie JSON incomplète", () => {
    const base = { text: "x", file: "a.ts", range: { byteOffset: { start: 0, end: 1 }, start: { line: 0 }, end: { line: 0 } } };
    expect(parseAstGrepJson("\n")).toEqual([]);
    expect(() => parseAstGrepJson("pas du json")).toThrow(/illisible/);
    expect(() => parseAstGrepJson("1")).toThrow(/invalide/);
    expect(() => parseAstGrepJson("null")).toThrow(/invalide/);
    for (const bad of [
      { ...base, file: undefined },
      { ...base, text: undefined },
      { ...base, range: undefined },
      { ...base, range: { start: { line: 0 }, end: { line: 0 } } },
      { ...base, range: { byteOffset: { start: 0 }, start: { line: 0 }, end: { line: 0 } } },
      { ...base, range: { byteOffset: { start: 0, end: 1 }, end: { line: 0 } } },
      { ...base, range: { byteOffset: { start: 0, end: 1 }, start: { line: 0 } } },
    ]) {
      expect(() => parseAstGrepJson(JSON.stringify(bad))).toThrow(/incomplet/);
    }
  });
});

describe("@find_ast", () => {
  it("affiche les matches et le contexte, avec le langage déduit d'un fichier", async () => {
    const files = { "a.ts": 'const x = 1;\nconsole.log(x);\nconsole.log("hi");\n' };
    const r = await script('@find_ast "console.log($ARG)" a.ts --context 1\n', files, [], {
      runner: fakeAst((args) => {
        expect(opt(args, "--lang")).toBe("ts");
        expect(args.at(-1)).toBe("a.ts");
        return { stdout: `${match(files, "a.ts", "console.log(x)")}\n${match(files, "a.ts", 'console.log("hi")')}\n` };
      }),
    });
    expect(r.code).toBe(0);
    expect(r.text).toContain("FIND_AST");
    expect(r.text).toContain("2 correspondance(s) dans 1 fichier(s)");
    expect(r.text).toContain('a.ts:2: console.log(x);');
    expect(r.text).toContain('a.ts:3: console.log("hi");');
    expect(r.text).toContain("a.ts-1- const x = 1;");
  });

  it("un dossier exige --lang et un fichier inconnu aussi", async () => {
    const dir = await script('@find_ast "x" sub\n', { "sub/a.ts": "x\n" });
    expect(dir.text).toContain("ast_grep_lang_required");
    const unknown = await script('@find_ast "x" a.zzz\n', { "a.zzz": "x\n" });
    expect(unknown.text).toContain("ast_grep_lang_required");
    const explicit = await script('@find_ast "x" sub --lang ts\n', { "sub/a.ts": "x\n" }, [], {
      runner: fakeAst(() => ({ status: 1 })),
    });
    expect(explicit.code).toBe(0);
    expect(explicit.text).toContain("0 correspondance(s) dans 0 fichier(s)");
  });

  it("laisse ast-grep déduire le HTML (injections JS/CSS) et accepte --lang auto", async () => {
    const files = { "page.html": '<script>\nconsole.log("hi");\n</script>\n' };
    const html = await script('@find_ast "console.log($ARG)" page.html\n', files, [], {
      runner: fakeAst((args) => {
        expect(opt(args, "--lang")).toBeUndefined();
        return { stdout: `${match(files, "page.html", 'console.log("hi")')}\n` };
      }),
    });
    expect(html.code).toBe(0);
    expect(html.text).toContain("1 correspondance(s) dans 1 fichier(s)");

    const auto = await script('@find_ast "x" sub --lang auto\n', { "sub/a.ts": "x\n" }, [], {
      runner: fakeAst((args) => {
        expect(opt(args, "--lang")).toBeUndefined();
        return { status: 1 };
      }),
    });
    expect(auto.code).toBe(0);
  });

  it("groupe plusieurs fichiers, sépare les zones et accepte le chemin par défaut", async () => {
    const files = { "a.ts": "foo();\nbar();\nfoo();\n", "b.ts": "foo();\n" };
    const r = await script('@find_ast "foo()" . --lang ts\n', files, [], {
      runner: fakeAst(() => ({
        stdout: `${match(files, "a.ts", "foo()")}\n${match(files, "a.ts", "foo()", undefined, 1)}\n${match(files, "b.ts", "foo()")}\n`,
      })),
    });
    expect(r.code).toBe(0);
    expect(r.text).toContain("3 correspondance(s) dans 2 fichier(s)");
    expect(r.text).toContain("a.ts:1: foo();");
    expect(r.text).toContain("a.ts:3: foo();");
    expect(r.text).toContain("b.ts:1: foo();");
    expect((r.text.match(/^--$/gm) ?? []).length).toBeGreaterThanOrEqual(2);

    const noPath = await script('@find_ast "foo()" --lang auto\n', files, [], {
      runner: fakeAst((args) => {
        expect(args.at(-1)).toBe(".");
        return { status: 1 };
      }),
    });
    expect(noPath.code).toBe(0);
  });

  it("filtre les fichiers ignorés et refuse les chemins invalides", async () => {
    const files = { ".gitignore": "ignored.ts\n", "ignored.ts": "foo()\n", "a.ts": "foo()\n" };
    const ignored = await script('@find_ast "foo()" . --lang ts\n', files, [], {
      runner: fakeAst(() => ({ stdout: `${match(files, "ignored.ts", "foo()")}\n` })),
    });
    expect(ignored.text).toContain("0 correspondance(s) dans 0 fichier(s)");

    const missing = await script('@find_ast "x" a.ts\n', { "a.ts": "x\n" }, [], {
      runner: fakeAst(() => ({ stdout: `${raw("missing.ts", "x", 0, 1)}\n` })),
    });
    expect(missing.text).toContain("not_found");
    expect(missing.text).toContain("fichier introuvable");

    const dir = await script('@find_ast "x" a.ts --lang ts\n', { "a.ts": "x\n", "sub/z.ts": "x\n" }, [], {
      runner: fakeAst(() => ({ stdout: `${raw("sub", "x", 0, 1)}\n` })),
    });
    expect(dir.text).toContain("is_directory");

    const link = await script('@find_ast "x" a.ts --lang ts\n', { "a.ts": "x\n" }, [], {
      setup: (d) => fs.symlinkSync("a.ts", path.join(d, "l.ts")),
      runner: fakeAst(() => ({ stdout: `${raw("l.ts", "x", 0, 1)}\n` })),
    });
    expect(link.text).toContain("symlink");

    const badOffsets = await script('@find_ast "x" a.ts\n', { "a.ts": "x\n" }, [], {
      runner: fakeAst(() => ({ stdout: `${raw("a.ts", "x", 0, 999)}\n` })),
    });
    expect(badOffsets.text).toContain("offsets invalides");
  });

  it("refuse un chemin absent, un lien symbolique et --lang vide", async () => {
    const missing = await script('@find_ast "x" nope.ts --lang ts\n', {});
    expect(missing.text).toContain("not_found");
    const link = await script('@find_ast "x" l --lang ts\n', { "a.ts": "x\n" }, [], {
      setup: (d) => fs.symlinkSync("a.ts", path.join(d, "l")),
    });
    expect(link.text).toContain("symlink");
    const empty = await script('@find_ast "x" a.ts --lang ""\n', { "a.ts": "x\n" });
    expect(empty.text).toContain("invalid_argument");
    expect(empty.text).toContain("ne peut pas être vide");
    const dot = await script('@find_ast "x" .\n', { "a.ts": "x\n" });
    expect(dot.text).toContain("ast_grep_lang_required");
    expect(dot.text).toContain("pour .");
  });

  it("refuse un motif invalide et un fichier hors du dossier", async () => {
    const bad = await script('@find_ast "console.log(" a.ts\n', { "a.ts": "x\n" }, [], {
      runner: fakeAst(() => ({ stdout: "", stderr: "Warning: Pattern contains an ERROR node and may cause unexpected results.\n" })),
    });
    expect(bad.text).toContain("ast_grep_failed");
    expect(bad.text).toContain("nœud ERROR");
    const evil = await script('@find_ast "x" a.ts\n', { "a.ts": "x\n" }, [], {
      runner: fakeAst(() => ({ stdout: `${match({ "a.ts": "x\n" }, "a.ts", "x").replace('"a.ts"', '"../evil.ts"')}\n` })),
    });
    expect(evil.text).toContain("outside_workspace");
  });
});

describe("@edit_ast", () => {
  it("est unique par défaut et n'écrit rien si ambigu", async () => {
    const files = { "a.ts": "console.log(a);\nconsole.log(b);\n" };
    const r = await script('@edit_ast "console.log($ARG)" a.ts --rewrite "logger.info($ARG)"\n', files, [], {
      runner: fakeAst(() => ({ stdout: `${match(files, "a.ts", "console.log(a)")}\n${match(files, "a.ts", "console.log(b)")}\n` })),
    });
    expect(r.code).toBe(1);
    expect(r.text).toContain("ambiguous_match");
    expect(r.text).toContain("a.ts:1, a.ts:2");
    expect(read(r.dir, "a.ts")).toBe(files["a.ts"] as string);
  });

  it("--all réécrit plusieurs fichiers en respectant les offsets UTF-8", async () => {
    const files = { "a.ts": "const café = 1;\nconsole.log(café);\n", "sub/b.ts": "console.log(b);\n" };
    let replacement: string | undefined;
    const r = await script('@edit_ast "console.log($ARG)" . --lang ts --all --rewrite "logger.info($ARG)"\n', files, [], {
      runner: fakeAst((args) => {
        replacement = opt(args, "--rewrite");
        return { stdout: `${match(files, "a.ts", "console.log(café)", "logger.info(café)")}\n${match(files, "sub/b.ts", "console.log(b)", "logger.info(b)")}\n` };
      }),
    });
    expect(r.code).toBe(0);
    expect(replacement).toBe("logger.info($ARG)");
    expect(read(r.dir, "a.ts")).toBe("const café = 1;\nlogger.info(café);\n");
    expect(read(r.dir, "sub/b.ts")).toBe("logger.info(b);\n");
    expect(r.text).toContain("2 remplacement(s), 2 fichier(s)");
    expect(r.text).toContain("a.ts:ligne 2");
    expect(r.text).toContain("sub/b.ts:ligne 1");
  });

  it("--first ne touche que le premier match, --dry-run n'écrit rien", async () => {
    const files = { "a.ts": "console.log(a);\nconsole.log(b);\n" };
    const replies = () => ({ stdout: `${match(files, "a.ts", "console.log(a)", "x(a)")}\n${match(files, "a.ts", "console.log(b)", "x(b)")}\n` });
    const first = await script('@edit_ast "console.log($ARG)" a.ts --first --rewrite "x($ARG)"\n', files, [], { runner: fakeAst(replies) });
    expect(first.code).toBe(0);
    expect(read(first.dir, "a.ts")).toBe("x(a);\nconsole.log(b);\n");

    const dry = await script('@edit_ast "console.log($ARG)" a.ts --all --rewrite "x($ARG)"\n', files, ["--dry-run"], { runner: fakeAst(replies) });
    expect(dry.code).toBe(0);
    expect(dry.text).toContain("Modifierait");
    expect(read(dry.dir, "a.ts")).toBe(files["a.ts"] as string);
  });

  it("le bloc REWRITE accepte une suppression et reste annulable", async () => {
    const files = { "a.ts": "console.log(a);\n" };
    const r = await script('@edit_ast "console.log($ARG)" a.ts\n<<<<<<< REWRITE\n>>>>>>> END\n', files, [], {
      runner: fakeAst(() => ({ stdout: `${match(files, "a.ts", "console.log(a)", "")}\n` })),
    });
    expect(r.code).toBe(0);
    expect(r.text).toContain("- console.log(a)");
    expect(read(r.dir, "a.ts")).toBe(";\n");
    expect(r.text).toContain("Annulable avec : fls undo");

    const undo = await runFls(r.dir, ["undo"]);
    expect(undo.code).toBe(0);
    expect(read(r.dir, "a.ts")).toBe(files["a.ts"] as string);
  });

  it("refuse --rewrite et bloc ensemble, ou aucun des deux, ou --all et --first", async () => {
    const both = await script('@edit_ast "x" a.ts --rewrite "y"\n<<<<<<< REWRITE\nz\n>>>>>>> END\n', { "a.ts": "x\n" }, [], { runner: fakeAst(ast) });
    expect(both.text).toContain("invalid_argument");
    expect(both.text).toContain("pas les deux");
    const none = await script('@edit_ast "x" a.ts\n', { "a.ts": "x\n" }, [], { runner: fakeAst(ast) });
    expect(none.text).toContain("invalid_argument");
    expect(none.text).toContain("il faut --rewrite");
    const flags = await script('@edit_ast "x" a.ts --all --first --rewrite "y"\n', { "a.ts": "x\n" }, [], { runner: fakeAst(ast) });
    expect(flags.text).toContain("invalid_argument");
    expect(flags.text).toContain("exclusifs");
  });

  it("refuse un fichier modifié plus tôt dans le script et un contenu qui a changé", async () => {
    const files = { "a.ts": "console.log(a);\n" };
    const stale = await script('@write a.ts\n<<<<<<< CONTENT\nconsole.log(a);\n>>>>>>> END\n@find_ast "console.log($ARG)" a.ts\n', files, [], {
      runner: fakeAst(() => ({ stdout: `${match(files, "a.ts", "console.log(a)")}\n` })),
    });
    expect(stale.text).toContain("ast_grep_stale");

    const changed = { "a.ts": "zzzzzzzzzzzzzz\n" };
    const conflict = await script('@edit_ast "console.log($ARG)" a.ts --rewrite "x"\n', changed, [], {
      runner: fakeAst(() => ({ stdout: `${match({ "a.ts": "console.log(a);\n" }, "a.ts", "console.log(a)", "x")}\n` })),
    });
    expect(conflict.text).toContain("conflict");
    expect(read(conflict.dir, "a.ts")).toBe(changed["a.ts"] as string);
  });

  it("applique plusieurs matches dans un même fichier, dans l'ordre des lignes", async () => {
    const files = { "a.ts": "console.log(a);\nconsole.log(b);\n" };
    const r = await script('@edit_ast "console.log($ARG)" a.ts --all --rewrite "log($ARG)"\n', files, [], {
      runner: fakeAst(() => ({
        stdout: `${match(files, "a.ts", "console.log(a)", "log(a)")}\n${match(files, "a.ts", "console.log(b)", "log(b)")}\n`,
      })),
    });
    expect(r.code).toBe(0);
    expect(read(r.dir, "a.ts")).toBe("log(a);\nlog(b);\n");
    expect(r.text.indexOf("a.ts:ligne 1")).toBeLessThan(r.text.indexOf("a.ts:ligne 2"));
  });

  it("refuse un remplacement absent, des offsets invalides et un changement identique", async () => {
    const files = { "a.ts": "x\n" };
    const absent = await script('@edit_ast "x" a.ts --rewrite "y"\n', files, [], {
      runner: fakeAst(() => ({ stdout: `${raw("a.ts", "x", 0, 1)}\n` })),
    });
    expect(absent.text).toContain("pas fourni de remplacement");

    const bad = await script('@edit_ast "x" a.ts --rewrite "y"\n', files, [], {
      runner: fakeAst(() => ({ stdout: `${raw("a.ts", "x", 0, 1, 0, 0, "y", { start: 0, end: 99 })}\n` })),
    });
    expect(bad.text).toContain("offsets invalides");

    const same = await script('@edit_ast "x" --lang ts --rewrite "x"\n', files, [], {
      runner: fakeAst(() => ({ stdout: `${raw("a.ts", "x", 0, 1, 0, 0, "x")}\n` })),
    });
    expect(same.code).toBe(0);
    expect(same.text).toContain("aucun changement");
    expect(read(same.dir, "a.ts")).toBe("x\n");

    const noOffsets = await script('@edit_ast "x" a.ts --rewrite "y"\n', files, [], {
      runner: fakeAst(() => ({ stdout: `${raw("a.ts", "x", 0, 1, 0, 0, "y")}\n` })),
    });
    expect(noOffsets.code).toBe(0);
    expect(read(noOffsets.dir, "a.ts")).toBe("y\n");

    const noMatch = await script('@edit_ast "x" a.ts --rewrite "y"\n', files, [], {
      runner: fakeAst(() => ({ status: 1 })),
    });
    expect(noMatch.text).toContain("not_found");
    expect(noMatch.text).toContain("aucun match");
  });

  it("refuse des remplacements qui se chevauchent", async () => {
    const files = { "a.ts": "console.log(a);\n" };
    const one = match(files, "a.ts", "console.log(a)", "x");
    const r = await script('@edit_ast "console.log($ARG)" a.ts --all --rewrite "x"\n', files, [], {
      runner: fakeAst(() => ({ stdout: `${one}\n${one}\n` })),
    });
    expect(r.code).toBe(1);
    expect(r.text).toContain("chevauchent");
    expect(read(r.dir, "a.ts")).toBe(files["a.ts"] as string);
  });
});

describe("ast-grep indisponible", () => {
  it("donne le code et la commande d'installation", async () => {
    const r = await script('@find_ast "x" a.ts\n', { "a.ts": "x\n" }, [], {
      runner: { capture: () => null, feed: () => false, exec: () => ({ status: 127, stdout: "", stderr: "not found" }) },
    });
    expect(r.code).toBe(1);
    expect(r.text).toContain("ast_grep_unavailable");
    expect(r.text).toContain("npm i -g @ast-grep/cli");
  });

  it("gère l'absence de binaire, la version, l'exécution impossible et les erreurs ast-grep", async () => {
    const missing = await script('@find_ast "x" a.ts\n', { "a.ts": "x\n" }, [], {
      runner: { capture: () => null, feed: () => false, exec: (cmd, args) => (args[0] === "--version" ? { status: 127, stdout: "", stderr: "nope" } : ast(args)) },
    });
    expect(missing.text).toContain("ast_grep_unavailable");

    const envMissing = await script('@find_ast "x" a.ts\n', { "a.ts": "x\n" }, [], {
      env: { FLS_AST_GREP: "/nope/ast-grep" },
      runner: { capture: () => null, feed: () => false, exec: () => ({ status: 127, stdout: "", stderr: "nope" }) },
    });
    expect(envMissing.text).toContain("ast_grep_unavailable");

    const old = await script('@find_ast "x" a.ts\n', { "a.ts": "x\n" }, [], {
      runner: fakeAst(() => ({ status: 1 }), "ast-grep 0.10.0"),
    });
    expect(old.text).toContain("ast_grep_version");
    expect(old.text).toContain("trop ancien");

    const unreadable = await script('@find_ast "x" a.ts\n', { "a.ts": "x\n" }, [], {
      runner: fakeAst(() => ({ status: 1 }), "ast-grep nope"),
    });
    expect(unreadable.text).toContain("ast_grep_version");
    expect(unreadable.text).toContain("illisible");

    const cannotRun = await script('@find_ast "x" a.ts\n', { "a.ts": "x\n" }, [], {
      runner: fakeAst(() => ({ status: null, stdout: "", stderr: "spawn failed" })),
    });
    expect(cannotRun.text).toContain("impossible d'exécuter ast-grep");

    const failed = await script('@find_ast "x" a.ts\n', { "a.ts": "x\n" }, [], {
      runner: fakeAst(() => ({ status: 2, stdout: "", stderr: "[warn] noise\nreal error\n" })),
    });
    expect(failed.text).toContain("ast_grep_failed");
    expect(failed.text).toContain("real error");
    expect(failed.text).not.toContain("[warn]");

    const failedEmpty = await script('@find_ast "x" a.ts\n', { "a.ts": "x\n" }, [], {
      runner: fakeAst(() => ({ status: 2, stdout: "", stderr: "[warn] only\n" })),
    });
    expect(failedEmpty.text).toContain("ast-grep a échoué (code 2)");
  });
});

describe("helpers ast-grep", () => {
  it("couvre les branches défensives", async () => {
    const dir = sandbox({ "a.ts": "x\n", "sub/b.ts": "y\n" });
    const ws = new Workspace(dir, 1_048_576);
    const journal = new Journal(dir);
    const base = { ws, journal, ignore: loadIgnore(ws, []), runner: fakeAst(() => ({ status: 1 })), env: {}, output: null };
    const op = (args: string[], opts: Record<string, string | true> = {}) => ({ line: 1, name: "find_ast", args, opts, edits: [], content: "" });

    expect(() => astPath(base as never, op(["x", "missing.ts"]))).toThrow(/introuvable/);
    expect(() => astPath(base as never, op(["x", "."]))).toThrow(/--lang est requis/);
    expect(() => astPath(base as never, op(["x", "a.ts"], { lang: "" }))).toThrow(/ne peut pas être vide/);
    const emptyRel = { ...base, ws: { ...ws, kind: (r: string) => (r === "" ? null : ws.kind(r)) } } as never;
    expect(() => astPath(emptyRel, op(["x", "."]))).toThrow(/introuvable : \./);

    // candidat local node_modules/.bin/ast-grep
    const binDir = path.join(dir, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const localBin = path.join(binDir, "ast-grep");
    fs.writeFileSync(localBin, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(localBin, 0o755);
    const localCtx = { ...base, runner: { capture: () => null, feed: () => false, exec: (cmd: string, args: string[]) => args[0] === "--version" && cmd === localBin ? { status: 0, stdout: "ast-grep 0.51.3\n", stderr: "" } : { status: 1, stdout: "", stderr: "" } } } as never;
    expect(resolveAstGrep(localCtx)).toBe(localBin);

    const ignored = checkMatches({ ...base, ignore: () => true } as never, [{ text: "x", file: "a.ts", range: { byteOffset: { start: 0, end: 1 }, start: { line: 0, column: 0 }, end: { line: 0, column: 1 } } }]);
    expect(ignored).toEqual([]);
    expect(() => checkMatches(base as never, [{ text: "x", file: "nope.ts", range: { byteOffset: { start: 0, end: 1 }, start: { line: 0, column: 0 }, end: { line: 0, column: 1 } } }])).toThrow(/introuvable/);
    fs.symlinkSync("a.ts", path.join(dir, "l.ts"));
    expect(() => checkMatches(base as never, [{ text: "x", file: "l.ts", range: { byteOffset: { start: 0, end: 1 }, start: { line: 0, column: 0 }, end: { line: 0, column: 1 } } }])).toThrow(/lien symbolique/);
    expect(() => checkMatches(base as never, [{ text: "x", file: "sub", range: { byteOffset: { start: 0, end: 1 }, start: { line: 0, column: 0 }, end: { line: 0, column: 1 } } }])).toThrow(/dossier/);
    expect(() => checkMatches(base as never, [{ text: "x", file: "a.ts", range: { byteOffset: { start: 0, end: 9 }, start: { line: 0, column: 0 }, end: { line: 0, column: 1 } } }])).toThrow(/offsets invalides/);
    fs.writeFileSync(path.join(dir, "a.ts"), "z\n");
    expect(() => checkMatches(base as never, [{ text: "x", file: "a.ts", range: { byteOffset: { start: 0, end: 1 }, start: { line: 0, column: 0 }, end: { line: 0, column: 1 } } }])).toThrow(/a changé/);
  });

  it("couvre runAstGrep/resolve et applyAstEdits défensifs", async () => {
    const dir = sandbox({ "a.ts": "x\n" });
    const ws = new Workspace(dir, 1_048_576);
    const journal = new Journal(dir);
    const ctx = { ws, journal, ignore: loadIgnore(ws, []), runner: fakeAst(() => ({ status: 1 })), env: {}, output: null } as never;
    const op = { line: 1, name: "find_ast", args: ["x", "a.ts"], opts: {}, edits: [], content: "" } as never;

    expect(resolveAstGrep(ctx)).toBe("ast-grep");
    expect(() => runAstGrep({ ...ctx, runner: fakeAst(() => ({ status: null, stdout: "", stderr: "boom" })) } as never, op, null)).toThrow(/impossible d'exécuter/);
    expect(() => runAstGrep({ ...ctx, runner: fakeAst(() => ({ status: 2, stdout: "", stderr: "[warn] x\nbad\n" })) } as never, op, null)).toThrow(/bad/);
    expect(() => runAstGrep({ ...ctx, runner: fakeAst(() => ({ status: 2, stdout: "", stderr: "[warn] only\n" })) } as never, op, null)).toThrow(/code 2/);

    const badApply = [{ text: "x", file: "a.ts", rel: "a.ts", range: { byteOffset: { start: 0, end: 1 }, start: { line: 0, column: 0 }, end: { line: 0, column: 1 } } }] as never;
    expect(() => applyAstEdits(ctx, badApply)).toThrow(/pas fourni de remplacement/);
  });
});
