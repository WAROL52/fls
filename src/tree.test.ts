import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as fls from "./fls";
import { renderTree, treeRel } from "./tree";
import { Workspace } from "./workspace";

// ───────────────────────────── Aides ─────────────────────────────

type Files = Record<string, string | Buffer>;
const dirs: string[] = [];

function cleanup(d: string): void {
  try {
    for (const e of fs.readdirSync(d, { recursive: true, withFileTypes: true })) {
      const p = path.join(e.parentPath, e.name);
      try {
        fs.chmodSync(p, e.isDirectory() ? 0o755 : 0o644);
      } catch {
        // ignore
      }
    }
    fs.chmodSync(d, 0o755);
  } catch {
    // ignore
  }
  fs.rmSync(d, { recursive: true, force: true });
}

afterEach(() => {
  for (const d of dirs.splice(0)) cleanup(d);
});

function sb(files: Files = {}, setup?: (dir: string) => void): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fls-tree-")));
  dirs.push(dir);
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
    fs.chmodSync(path.join(dir, rel), 0o644);
  }
  if (setup !== undefined) setup(dir);
  return dir;
}

const wsOf = (dir: string): Workspace => new Workspace(dir, 1_048_576);
const show = (dir: string, label: string, rel: string, output: string | null = null): string =>
  renderTree(wsOf(dir), label, rel, output).toString("utf8");
const read = (dir: string, rel: string): string => fs.readFileSync(path.join(dir, rel), "utf8");

interface FakeOpts {
  stdin?: string;
  tty?: boolean;
  clipboard?: string;
  id?: string;
}

function fake(cwd: string, o: FakeOpts = {}) {
  const out: Array<string | Buffer> = [];
  const err: string[] = [];
  const clip = { text: o.clipboard ?? "" };
  const io: fls.Io = {
    cwd,
    stdinIsTTY: o.tty ?? false,
    readStdin: () => o.stdin ?? "",
    out: (t) => {
      out.push(t);
    },
    err: (t) => {
      err.push(t);
    },
    clipboard: {
      read: () => clip.text,
      write: (t) => {
        clip.text = t;
      },
    },
    now: () => new Date("2026-11-19T10:00:00.123Z"),
    newId: () => o.id ?? "r1",
  };
  return { io, out, err, clip };
}

async function call(dir: string, argv: string[], o: FakeOpts = {}) {
  const f = fake(dir, o);
  const code = await fls.main(argv, f.io);
  return { code, out: f.out, text: f.out.map((x) => x.toString()).join(""), errText: f.err.join(""), clip: f.clip };
}

async function script(s: string, files: Files = {}, argv: string[] = [], o: FakeOpts = {}) {
  const dir = sb(files);
  return { dir, ...(await call(dir, argv, { stdin: s, ...o })) };
}

// ───────────────────────────── Chemins stricts ─────────────────────────────

describe("treeRel", () => {
  it("normalise les chemins relatifs", async () => {
    expect(treeRel(".")).toBe("");
    expect(treeRel("")).toBe("");
    expect(treeRel("./")).toBe("");
    expect(treeRel("src/")).toBe("src");
    expect(treeRel("./a//b/")).toBe("a/b");
    expect(treeRel("a/./b")).toBe("a/b");
    expect(treeRel("a/.../b")).toBe("a/.../b");
  });

  it("refuse absolus et tout segment ..", async () => {
    for (const bad of ["/etc/passwd", "..", "../x", "a/../b", "a/..", "a/../", "//x"]) {
      expect(() => treeRel(bad)).toThrow(/outside_workspace|absolu|hors du dossier/);
    }
  });
});

// ───────────────────────────── Rendu ─────────────────────────────

describe("renderTree : fichiers", () => {
  it("newline final, absent, vide, lignes vides", async () => {
    expect(show(sb({ "f.txt": "a\nb\n" }), "f.txt", "f.txt")).toBe("f.txt\na\nb\n");
    expect(show(sb({ "f.txt": "a\nb" }), "f.txt", "f.txt")).toBe("f.txt\na\nb\n");
    expect(show(sb({ "f.txt": "" }), "f.txt", "f.txt")).toBe("f.txt\n");
    expect(show(sb({ "f.txt": "a\n\n" }), "f.txt", "f.txt")).toBe("f.txt\na\n\n");
    expect(show(sb({ "f.txt": "\n" }), "f.txt", "f.txt")).toBe("f.txt\n\n");
  });

  it("CRLF et NUL supprimés", async () => {
    expect(show(sb({ "f.txt": "a\r\nb\r\n" }), "f.txt", "f.txt")).toBe("f.txt\na\r\nb\r\n");
    expect(show(sb({ "f.txt": Buffer.from("a\0b\n") }), "f.txt", "f.txt")).toBe("f.txt\nab\n");
    expect(show(sb({ "f.txt": Buffer.from([0]) }), "f.txt", "f.txt")).toBe("f.txt\n");
  });

  it("octets non UTF-8 conservés", async () => {
    const dir = sb({ "f.txt": Buffer.from([0xff, 0x0a]) });
    const buf = renderTree(wsOf(dir), "f.txt", "f.txt", null);
    expect(buf.equals(Buffer.concat([Buffer.from("f.txt\n"), Buffer.from([0xff, 0x0a])]))).toBe(true);
  });
});

describe("renderTree : dossiers", () => {
  it("tri par octets, cachés et dossiers spéciaux inclus", async () => {
    const dir = sb({
      "z": "z\n",
      "é": "e\n",
      "a b": "ab\n",
      "A": "A\n",
      ".hidden": "h\n",
      ".git/config": "g\n",
      "node_modules/x/i.js": "n\n",
    });
    expect(show(dir, "d", "")).toBe(
      [
        "d",
        "├── .git",
        "│   └── config",
        "│       g",
        "├── .hidden",
        "│   h",
        "├── A",
        "│   A",
        "├── a b",
        "│   ab",
        "├── node_modules",
        "│   └── x",
        "│       └── i.js",
        "│           n",
        "├── z",
        "│   z",
        "└── é",
        "    e",
        "",
      ].join("\n"),
    );
  });

  it("dossier vide, sous-dossier vide, dossier non terminal", async () => {
    expect(show(sb({}), "d", "")).toBe("d\n");
    expect(show(sb({ "a/x": "x" }), "d", "")).toBe("d\n└── a\n    └── x\n        x\n");
    expect(show(sb({ "a/x.txt": "x", "b.txt": "b" }), "d", "")).toBe("d\n├── a\n│   └── x.txt\n│       x\n└── b.txt\n    b\n");
  });

  it("dossier racine unreadable : nom seul", async () => {
    if (process.geteuid?.() === 0) return;
    const dir = sb({ "sub/a.txt": "a\n" });
    fs.chmodSync(path.join(dir, "sub"), 0o000);
    try {
      expect(show(dir, "sub", "sub")).toBe("sub\n");
    } finally {
      fs.chmodSync(path.join(dir, "sub"), 0o755);
    }
  });

  it("sous-dossier unreadable : nom seul, on continue", async () => {
    if (process.geteuid?.() === 0) return;
    const dir = sb({ "d/ok.txt": "ok\n", "d/sub/a.txt": "a\n" });
    fs.chmodSync(path.join(dir, "d/sub"), 0o000);
    try {
      expect(show(dir, "d", "d")).toBe("d\n├── ok.txt\n│   ok\n└── sub\n");
    } finally {
      fs.chmodSync(path.join(dir, "d/sub"), 0o755);
    }
  });
});

describe("renderTree : liens", () => {
  it("racine lien : cible affichée, jamais suivie", async () => {
    const outside = sb({ "s.txt": "secret\n" });
    const dir = sb({ "real.txt": "ok\n" }, (d) => {
      fs.symlinkSync(path.join(outside, "s.txt"), path.join(d, "out"));
      fs.symlinkSync("real.txt", path.join(d, "in"));
      fs.symlinkSync("absent", path.join(d, "broken"));
    });
    expect(show(dir, "out", "out")).toBe(`out\n-> ${path.join(outside, "s.txt")}\n`);
    expect(show(dir, "in", "in")).toBe("in\n-> real.txt\n");
    expect(show(dir, "broken", "broken")).toBe("broken\n-> absent\n");
  });

  it("entrées liens non suivies, y compris vers un dossier", async () => {
    const dir = sb({ "real/a.txt": "a\n" }, (d) => {
      fs.symlinkSync("real/a.txt", path.join(d, "lf"));
      fs.symlinkSync("real", path.join(d, "ld"));
      fs.symlinkSync("nope", path.join(d, "lb"));
    });
    expect(show(dir, "d", "")).toBe(
      "d\n├── lb\n│   -> nope\n├── ld\n│   -> real\n├── lf\n│   -> real/a.txt\n└── real\n    └── a.txt\n        a\n",
    );
  });
});

describe("renderTree : illisibles, spéciaux, output", () => {
  it("fichier racine et entrée illisibles", async () => {
    if (process.geteuid?.() === 0) return;
    const dir = sb({ "f.txt": "x\n", "d/a.txt": "a\n" });
    fs.chmodSync(path.join(dir, "f.txt"), 0o000);
    fs.chmodSync(path.join(dir, "d/a.txt"), 0o000);
    try {
      expect(show(dir, "f.txt", "f.txt")).toBe("f.txt\n[unreadable]\n");
      expect(show(dir, "d", "d")).toBe("d\n└── a.txt\n    [unreadable]\n");
    } finally {
      fs.chmodSync(path.join(dir, "f.txt"), 0o644);
      fs.chmodSync(path.join(dir, "d/a.txt"), 0o644);
    }
  });

  it("fichier spécial : nom seul, jamais ouvert", async () => {
    const dir = sb({});
    execFileSync("mkfifo", [path.join(dir, "pipe")]);
    expect(show(dir, "pipe", "pipe")).toBe("pipe\n");
    expect(show(dir, "d", "")).toBe("d\n└── pipe\n");
  });

  it("fichier spécial illisible : [unreadable]", async () => {
    if (process.geteuid?.() === 0) return;
    const dir = sb({});
    execFileSync("mkfifo", [path.join(dir, "pipe")]);
    fs.chmodSync(path.join(dir, "pipe"), 0o000);
    try {
      expect(show(dir, "pipe", "pipe")).toBe("pipe\n[unreadable]\n");
    } finally {
      fs.chmodSync(path.join(dir, "pipe"), 0o644);
    }
  });

  it("--output dans l'arbre : [output file], jamais relu", async () => {
    const dir = sb({ "f.txt": "x\n", "d/a.txt": "a\n" });
    const out = path.join(dir, "d", "a.txt");
    expect(show(dir, "f.txt", "f.txt", out)).toBe("f.txt\nx\n");
    expect(show(dir, "d", "d", out)).toBe("d\n└── a.txt\n    [output file]\n");
    expect(show(dir, "d", "d", path.join(dir, "absent"))).toBe("d\n└── a.txt\n    a\n");
  });

  it("--output égal par chemin à un fichier virtuel", async () => {
    const dir = sb({});
    const ws = wsOf(dir);
    ws.write("new.txt", Buffer.from("n\n"));
    const out = path.join(dir, "new.txt");
    expect(renderTree(ws, "new.txt", "new.txt", out).toString()).toBe("new.txt\n[output file]\n");
  });

  it("--output lien dur ou symbolique vers l'entrée", async () => {
    const dir = sb({ "f.txt": "x\n" }, (d) => {
      fs.linkSync(path.join(d, "f.txt"), path.join(d, "hard"));
      fs.symlinkSync("f.txt", path.join(d, "sym"));
    });
    expect(show(dir, "f.txt", "f.txt", path.join(dir, "hard"))).toBe("f.txt\n[output file]\n");
    expect(show(dir, "f.txt", "f.txt", path.join(dir, "sym"))).toBe("f.txt\n[output file]\n");
  });
});

describe("renderTree : surcouche mémoire", () => {
  it("fichiers et dossiers virtuels, suppressions, contenus modifiés", async () => {
    const dir = sb({ "old.txt": "old\n", "keep.txt": "keep\n" });
    const ws = wsOf(dir);
    ws.write("gen/new.txt", Buffer.from("new\n"));
    ws.write("keep.txt", Buffer.from("changed\n"));
    ws.remove("old.txt");
    expect(renderTree(ws, "d", "", null).toString()).toBe("d\n├── gen\n│   └── new.txt\n│       new\n└── keep.txt\n    changed\n");
    expect(renderTree(ws, "gen", "gen", null).toString()).toBe("gen\n└── new.txt\n    new\n");
    expect(renderTree(ws, "new.txt", "gen/new.txt", null).toString()).toBe("new.txt\nnew\n");
  });

  it("racine absente", async () => {
    const dir = sb({});
    expect(() => renderTree(wsOf(dir), "nope", "nope", null)).toThrow(/introuvable/);
  });

  it("erreurs de listage : FlsError propagée, autre erreur ignorée", async () => {
    const dir = sb({ "d/a.txt": "a\n" });
    const ws1 = wsOf(dir);
    const orig = ws1.list.bind(ws1);
    ws1.list = (rel) => {
      if (rel === "d") throw new fls.FlsError("x", "y");
      return orig(rel);
    };
    expect(() => renderTree(ws1, "d", "d", null)).toThrow(/y/);

    const ws2 = wsOf(dir);
    const orig2 = ws2.list.bind(ws2);
    ws2.list = (rel) => {
      if (rel === "d") throw new Error("boom");
      return orig2(rel);
    };
    expect(renderTree(ws2, "d", "d", null).toString()).toBe("d\n");
  });

  it("entrée disparue du disque : [unreadable]", async () => {
    const dir = sb({});
    const ws = wsOf(dir);
    ws.list = () => ["ghost"];
    ws.kind = (rel) => (rel === "ghost" ? "file" : Workspace.prototype.kind.call(ws, rel));
    expect(renderTree(ws, "d", "", null).toString()).toBe("d\n└── ghost\n    [unreadable]\n");
  });

  it("entrée fantôme (kind null, pas output) : nom seul", async () => {
    const dir = sb({});
    const ws = wsOf(dir);
    ws.list = () => ["ghost"];
    ws.kind = (rel) => (rel === "" ? "dir" : null);
    expect(renderTree(ws, "d", "", null).toString()).toBe("d\n└── ghost\n");
  });
});

// ───────────────────────────── @read --tree et mode global ─────────────────────────────

describe("@read --tree", () => {
  const files: Files = { "f.txt": "a\nb\n", "d/x.txt": "x\n" };

  it("fichier, dossier et titre original", async () => {
    expect((await script("@read f.txt --tree\n", files)).text).toContain("[1] OK    READ f.txt\nf.txt\na\nb\n");
    expect((await script("@read d --tree\n", files)).text).toContain("[1] OK    READ d\nd\n└── x.txt\n    x\n");
    expect((await script("@read ./d/ --tree\n", files)).text).toContain("[1] OK    READ ./d/\n./d/\n└── x.txt");
    expect((await script('@read "" --tree\n', files)).text).toContain("[1] OK    READ .\n.");
  });

  it("état simulé", async () => {
    const text = `@create gen/new.txt\n<<<<<<< CONTENT\nnew\n>>>>>>> END\n@read gen --tree\n`;
    const r = await script(text, files);
    expect(r.text).toContain("gen\n└── new.txt\n    new\n");
    const removed = await script("@delete f.txt\n@read . --tree\n", files);
    expect(removed.text).not.toContain("├── f.txt");
  });

  it("liens affichés, jamais suivis", async () => {
    const dir = sb(files, (d) => fs.symlinkSync("f.txt", path.join(d, "link")));
    expect((await call(dir, [], { stdin: "@read link --tree\n" })).text).toContain("link\n-> f.txt\n");
  });

  it("erreurs", async () => {
    const missing = await script("@read nope --tree\n", files);
    expect(missing.code).toBe(1);
    expect(missing.text).toContain("FAIL  READ nope : not_found");
    for (const bad of ["/etc", "../x", "a/../b"]) {
      const r = await script(`@read ${bad} --tree\n`, files);
      expect(r.code).toBe(1);
      expect(r.text).toContain("outside_workspace");
    }
  });

  it("options incompatibles", async () => {
    for (const args of ["f.txt 1-2", "f.txt --lines 1-2", "f.txt --line-numbers", "f.txt --depth 2"]) {
      const r = await script(`@read ${args} --tree\n`, files);
      expect(r.code).toBe(1);
      expect(r.text).toContain("FAIL  READ");
      expect(r.text).toContain("invalid_argument");
      expect(r.text).toContain("--tree est incompatible");
    }
  });

  it("--output dans l'arbre", async () => {
    const r = await script("@read d --tree\n", files, ["--output", "d/report.txt"]);
    expect(r.text).toBe("");
    expect(read(r.dir, "d/report.txt")).toContain("├── report.txt\n│   [output file]\n└── x.txt");
  });
});

describe("--tree global", () => {
  const files: Files = { "f.txt": "a\nb\n", "d/x.txt": "x\n" };

  it("applique tree à tous les reads (stdin, --file, --clip)", async () => {
    const piped = await script("@read f.txt\n@read d\n", files, ["--tree"]);
    expect(piped.text).toContain("READ f.txt\nf.txt\na\nb\n");
    expect(piped.text).toContain("READ d\nd\n└── x.txt\n    x\n");

    const dir = sb(files);
    fs.writeFileSync(path.join(dir, "s.fls"), "@read f.txt\n");
    expect((await call(dir, ["--tree", "--file", "s.fls"])).text).toContain("READ f.txt\nf.txt\na\nb\n");

    const clip = await call(sb(files), ["--tree", "--clip"], { clipboard: "@read f.txt\n" });
    expect(clip.text).toContain("READ f.txt\nf.txt\na\nb\n");
    expect(clip.clip.text).toBe(clip.text);
  });

  it("ignore et max-size restent valides pour les autres directives", async () => {
    const r = await script("@read d\n", { "d/a.txt": "a\n", "d/skip.txt": "s\n" }, ["--tree", "--ignore", "a.txt", "--max-size", "1"]);
    expect(r.text).toContain("├── a.txt");
    expect(r.text).toContain("└── skip.txt");
    expect(r.text).toContain("    s");
  });

  it("un read incompatible échoue, les suivants continuent", async () => {
    const r = await script("@read f.txt --lines 1\n@read d\n", files, ["--tree"]);
    expect(r.code).toBe(1);
    expect(r.text).toContain("invalid_argument");
    expect(r.text).toContain("READ d\nd\n└── x.txt");
  });

  it("expand n'injecte pas --tree ; le journal stocke le script effectif", async () => {
    const expand = await script("@read f.txt\n", files, ["--tree", "expand"]);
    expect(expand.text).toBe("@read f.txt\n");

    const r = await script(`@create n.txt\n<<<<<<< CONTENT\nn\n>>>>>>> END\n@read f.txt\n`, files, ["--tree"], { id: "r1" });
    expect(read(r.dir, ".fls/runs/r1/script.fls")).toContain("@read f.txt --tree");
  });

  it("--dry-run et troncature du rapport", async () => {
    const dry = await script("@read f.txt\n", files, ["--tree", "--dry-run"]);
    expect(dry.text).toContain("| dry-run |");
    expect(dry.text).toContain("f.txt\na\nb\n");
    const big = await script("@read f.txt\n", { "f.txt": "x".repeat(500) }, ["--tree", "--max-output-chars", "100"]);
    expect(big.text).toMatch(/\[rapport tronqué : \d+ caractères omis/);
  });
});

// ───────────────────────────── Lecture rapide --tree ─────────────────────────────

describe("fls --tree", () => {
  const files: Files = { "d/a.txt": "a\n", "d/sub/x.txt": "x\n", "f.txt": "f\n" };

  it("sortie brute, plusieurs racines séparées par une ligne vide", async () => {
    const r = await call(sb(files), ["--tree", "f.txt", "d"]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toBeInstanceOf(Buffer);
    expect(r.text).toBe("f.txt\nf\n\nd\n├── a.txt\n│   a\n└── sub\n    └── x.txt\n        x\n");
  });

  it("sans chemin : . si stdin est un terminal, script sinon", async () => {
    const dir = sb(files);
    const tty = await call(dir, ["--tree"], { tty: true });
    expect(tty.text).toBe(".\n├── d\n│   ├── a.txt\n│   │   a\n│   └── sub\n│       └── x.txt\n│           x\n└── f.txt\n    f\n");
    const piped = await call(dir, ["--tree"], { stdin: "@read f.txt\n" });
    expect(piped.text).toContain("READ f.txt\nf.txt\nf\n");
    const empty = await call(dir, ["--tree"], { stdin: "" });
    expect(empty.text).toContain("Résumé : 0 OK");
  });

  it("--paths-from : ordre, lignes vides, CRLF, espaces, liste vide", async () => {
    const dir = sb({ ...files, " d2 /z.txt": "z\n", "list.txt": "f.txt\r\n\r\nd\r\n", "empty.txt": "", "spaces.txt": " d2 \n" });
    const r = await call(dir, ["--tree", "--paths-from", "list.txt"]);
    expect(r.text.startsWith("f.txt\nf\n\nd\n├── a.txt")).toBe(true);
    const empty = await call(dir, ["--tree", "--paths-from", "empty.txt"]);
    expect(empty.text).toBe("");
    expect(empty.code).toBe(0);
    const spaced = await call(dir, ["--tree", "--paths-from", "spaces.txt"]);
    expect(spaced.text).toContain(" d2 \n└── z.txt");
  });

  it("racine absente ou hors dossier : stderr, continue, exit 1", async () => {
    const r = await call(sb(files), ["--tree", "absent", "f.txt"]);
    expect(r.code).toBe(1);
    expect(r.errText).toBe("fls : not_found : introuvable : absent\n");
    expect(r.text).toBe("\nf.txt\nf\n");
    const outside = await call(sb(files), ["--tree", "/etc", "../x", "a/../b"]);
    expect(outside.code).toBe(1);
    expect(outside.errText).toContain("outside_workspace");
    expect(outside.text).toBe("\n\n");
  });

  it("--ignore et --max-size refusés", async () => {
    for (const argv of [["--tree", "d", "--ignore", "x"], ["--tree", "d", "--max-size", "1"]]) {
      const r = await call(sb(files), argv);
      expect(r.code).toBe(2);
      expect(r.errText).toContain("usage_error");
    }
  });

  it("--output dans ou hors de l'arbre, --clip et --clip-out", async () => {
    const insideDir = sb(files);
    const inside = await call(insideDir, ["--tree", "d", "--output", "d/out.txt"]);
    expect(inside.text).toBe("");
    expect(read(insideDir, "d/out.txt")).toBe("d\n├── a.txt\n│   a\n├── out.txt\n│   [output file]\n└── sub\n    └── x.txt\n        x\n");

    const outsideDir = sb(files);
    const outside = await call(outsideDir, ["--tree", "d", "--output", "report.txt"]);
    expect(outside.text).toBe("");
    expect(read(outsideDir, "report.txt")).toContain("d\n├── a.txt");

    const clip = await call(sb(files), ["--tree", "d", "--clip"]);
    expect(clip.clip.text).toBe(clip.text);
    const clipOut = await call(sb(files), ["--tree", "--clip-out"], { tty: true });
    expect(clipOut.clip.text).toBe(clipOut.text);
  });

  it("--max-output-chars : illimité par défaut, honoré si explicite", async () => {
    const dir = sb({ "big.txt": "x".repeat(250_000) });
    const unlimited = await call(dir, ["--tree", "big.txt"]);
    expect(unlimited.text.length).toBeGreaterThan(200_000);
    expect(unlimited.text).not.toContain("tronqué");
    const limited = await call(dir, ["--tree", "big.txt", "--max-output-chars", "100"]);
    expect(limited.text).toMatch(/\[rapport tronqué : \d+ caractères omis/);
    expect(limited.out[0]).toBeTypeOf("string");
  });

  it("--dry-run, --version, --help, sous-commande", async () => {
    expect((await call(sb(files), ["--tree", "f.txt", "--dry-run"])).text).toBe("f.txt\nf\n");
    expect((await call(sb(files), ["--tree", "--version"])).text).toBe("fls 1.2.0\n");
    expect((await call(sb(files), ["--tree", "--help"])).text).toContain("--tree");
    expect((await call(sb(files), ["--tree", "expand"], { stdin: "@read f.txt\n" })).text).toBe("@read f.txt\n");
  });

  it("chemin vide : traité comme .", async () => {
    const r = await call(sb(files), ["--tree", ""]);
    expect(r.code).toBe(0);
    expect(r.text.startsWith(".\n")).toBe(true);
  });

  it("octets non UTF-8 conservés dans la sortie brute", async () => {
    const r = await call(sb({ "f.bin": Buffer.from([0xff, 0x0a]) }), ["--tree", "f.bin"]);
    const buf = r.out[0] as Buffer;
    expect(buf.equals(Buffer.concat([Buffer.from("f.bin\n"), Buffer.from([0xff, 0x0a])]))).toBe(true);
  });

  it("--paths-from absent : erreur de commande", async () => {
    const r = await call(sb(files), ["--tree", "--paths-from", "nope"]);
    expect(r.code).toBe(1);
    expect(r.errText).toContain("ENOENT");
  });
});
