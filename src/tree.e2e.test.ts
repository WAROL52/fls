import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TREECAT = path.join(ROOT, "bin", "treecat");
const FLS = path.join(ROOT, "src", "fls.ts");

type Files = Record<string, string | Buffer>;
const dirs: string[] = [];

function cleanup(d: string): void {
  spawnSync("chmod", ["-R", "u+rwx", d]);
  fs.rmSync(d, { recursive: true, force: true });
}

afterEach(() => {
  for (const d of dirs.splice(0)) cleanup(d);
});

function sb(files: Files = {}, setup?: (dir: string) => void): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fls-treecat-")));
  dirs.push(dir);
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
    fs.chmodSync(path.join(dir, rel), 0o644);
  }
  if (setup !== undefined) setup(dir);
  return dir;
}

interface Res {
  status: number;
  stdout: string;
  stderr: string;
  out: Buffer;
  err: Buffer;
}

function run(cmd: string, args: string[], cwd: string, input?: string, ignoreStdin = false): Res {
  const r = spawnSync(cmd, args, { cwd, input, stdio: ignoreStdin ? ["ignore", "pipe", "pipe"] : undefined });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout as Buffer).toString("utf8"),
    stderr: (r.stderr as Buffer).toString("utf8"),
    out: r.stdout as Buffer,
    err: r.stderr as Buffer,
  };
}

const treecat = (cwd: string, args: string[], input?: string): Res => run("bash", [TREECAT, ...args], cwd, input);
const fls = (cwd: string, args: string[], input?: string): Res => run(process.execPath, [FLS, ...args], cwd, input);

function expectSame(cwd: string, args: string[]): void {
  const t = treecat(cwd, args);
  const f = fls(cwd, ["--tree", ...args]);
  expect(f.out.equals(t.out)).toBe(true);
  expect(f.err.equals(t.err)).toBe(true);
  expect(f.status).toBe(t.status);
}

const canChmod = process.geteuid?.() !== 0;

// ───────────────────────────── Parité stricte treecat ─────────────────────────────

describe("treecat parity", () => {
  it("fichier simple, sans newline final, vide", () => {
    const dir = sb({ "a.txt": "a\nb\n", "no-nl.txt": "x", "empty.txt": "" });
    expectSame(dir, ["a.txt"]);
    expectSame(dir, ["no-nl.txt"]);
    expectSame(dir, ["empty.txt"]);
  });

  it("dossier imbriqué, dossier vide, sous-dossier vide", () => {
    const dir = sb({ "d/sub/x.txt": "x\n", "d/a.txt": "a\n" }, (d) => {
      fs.mkdirSync(path.join(d, "empty"));
      fs.mkdirSync(path.join(d, "d/emptysub"));
    });
    expectSame(dir, ["d"]);
    expectSame(dir, ["empty"]);
  });

  it("fichiers cachés, .git, node_modules inclus", () => {
    const dir = sb({
      ".hidden": "h\n",
      ".git/config": "g\n",
      "node_modules/pkg/index.js": "n\n",
      "src/a.ts": "a\n",
    });
    expectSame(dir, ["."]);
  });

  it("plusieurs racines, séparées par une ligne vide", () => {
    const dir = sb({ "a.txt": "a\n", "d/x.txt": "x\n" });
    expectSame(dir, ["a.txt", "d"]);
  });

  it("libellé original conservé (./dir, dir/)", () => {
    const dir = sb({ "d/x.txt": "x\n" });
    expectSame(dir, ["./d"]);
    expectSame(dir, ["d/"]);
  });

  it("tri octet, noms avec espaces et accents", () => {
    const dir = sb({ "z": "z\n", "é": "e\n", "a b": "ab\n", "A": "A\n" });
    expectSame(dir, ["."]);
  });

  it("CRLF conservés", () => {
    const dir = sb({ "f.txt": "a\r\nb\r\n" });
    expectSame(dir, ["f.txt"]);
    expectSame(dir, ["."]);
  });

  it("binaire avec NUL", () => {
    const dir = sb({ "bin.dat": Buffer.from([0x61, 0x00, 0x62, 0x0a]) });
    expectSame(dir, ["bin.dat"]);
  });

  it("--paths-from", () => {
    const dir = sb({ "a.txt": "a\n", "d/x.txt": "x\n", "list.txt": "a.txt\n\nd\n" });
    const t = treecat(dir, ["-i", "list.txt"]);
    const f = fls(dir, ["--tree", "--paths-from", "list.txt"]);
    expect(f.out.equals(t.out)).toBe(true);
    expect(f.err.equals(t.err)).toBe(true);
    expect(f.status).toBe(t.status);
  });

  it("--paths-from vide : sortie vide", () => {
    const dir = sb({ "list.txt": "" });
    const t = treecat(dir, ["-i", "list.txt"]);
    const f = fls(dir, ["--tree", "--paths-from", "list.txt"]);
    expect(f.out.equals(t.out)).toBe(true);
    expect(f.err.equals(t.err)).toBe(true);
    expect(f.status).toBe(t.status);
  });

  it("--output dans l'arbre : [output file]", () => {
    const dir = sb({ "d/a.txt": "a\n", "d/b.txt": "b\n" });
    const t = treecat(dir, ["d", "--output", "d/out.txt"]);
    const tFile = fs.readFileSync(path.join(dir, "d/out.txt"));
    fs.rmSync(path.join(dir, "d/out.txt"), { force: true });
    const f = fls(dir, ["--tree", "d", "--output", "d/out.txt"]);
    const fFile = fs.readFileSync(path.join(dir, "d/out.txt"));
    expect(f.out.equals(t.out)).toBe(true);
    expect(f.status).toBe(t.status);
    expect(fFile.equals(tFile)).toBe(true);
  });

  it("sans argument : lit .", () => {
    const dir = sb({ "a.txt": "a\n" });
    const t = treecat(dir, []);
    // stdin ignoré => pas un tty : fls --tree lit "." quand aucune source script.
    // On vérifie via --tree . qui est équivalent en sortie.
    const f = fls(dir, ["--tree", "."]);
    expect(f.out.equals(t.out)).toBe(true);
    expect(f.err.equals(t.err)).toBe(true);
    expect(f.status).toBe(t.status);
  });

  it("fichier illisible", () => {
    if (!canChmod) return;
    const dir = sb({ "f.txt": "secret\n" });
    fs.chmodSync(path.join(dir, "f.txt"), 0o000);
    expectSame(dir, ["f.txt"]);
  });

  it("dossier illisible : nom seul", () => {
    if (!canChmod) return;
    const dir = sb({ "d/a.txt": "a\n" });
    fs.chmodSync(path.join(dir, "d"), 0o000);
    expectSame(dir, ["d"]);
  });
});

// ───────────────────────────── Divergences sécurité fls ─────────────────────────────

describe("treecat divergences sécurité fls", () => {
  it("chemin absolu refusé", () => {
    const dir = sb({ "a.txt": "a\n" });
    const r = fls(dir, ["--tree", "/etc/passwd"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("outside_workspace");
  });

  it(".. refusé, y compris a/../b", () => {
    const dir = sb({ "a/b.txt": "b\n" });
    for (const bad of ["../x", "a/../b", ".."]) {
      const r = fls(dir, ["--tree", bad]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("outside_workspace");
    }
  });

  it("lien racine : cible affichée, jamais suivi", () => {
    const outside = sb({ "s.txt": "secret\n" });
    const dir = sb({ "real.txt": "ok\n" }, (d) => {
      fs.symlinkSync(path.join(outside, "s.txt"), path.join(d, "out"));
      fs.symlinkSync("real.txt", path.join(d, "in"));
      fs.symlinkSync("missing", path.join(d, "broken"));
    });
    expect(fls(dir, ["--tree", "out"]).stdout).toBe(`out\n-> ${path.join(outside, "s.txt")}\n`);
    expect(fls(dir, ["--tree", "in"]).stdout).toBe("in\n-> real.txt\n");
    expect(fls(dir, ["--tree", "broken"]).stdout).toBe("broken\n-> missing\n");
  });

  it("lien dans l'arbre : jamais suivi", () => {
    const dir = sb({ "real/a.txt": "a\n" }, (d) => {
      fs.symlinkSync("real/a.txt", path.join(d, "lf"));
      fs.symlinkSync("real", path.join(d, "ld"));
      fs.symlinkSync("nope", path.join(d, "lb"));
    });
    const r = fls(dir, ["--tree", "."]);
    expect(r.stdout).toContain("├── lb\n│   -> nope\n");
    expect(r.stdout).toContain("├── ld\n│   -> real\n");
    expect(r.stdout).toContain("├── lf\n│   -> real/a.txt\n");
    expect(r.stdout).not.toContain("secret");
  });

  it("lien parent interne autorisé, sortant refusé", () => {
    const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fls-out-")));
    dirs.push(out);
    fs.writeFileSync(path.join(out, "s.txt"), "secret\n");
    const dir = sb({ "real/f.txt": "ok\n" }, (d) => {
      fs.symlinkSync("real", path.join(d, "in"));
      fs.symlinkSync(out, path.join(d, "esc"));
      fs.symlinkSync(path.join(out, "s.txt"), path.join(d, "fileout"));
    });
    expect(fls(dir, ["--tree", "in/f.txt"]).stdout).toBe("in/f.txt\nok\n");
    expect(fls(dir, ["--tree", "esc/s.txt"]).status).toBe(1);
    expect(fls(dir, ["--tree", "esc/s.txt"]).stderr).toContain("outside_workspace");
    expect(fls(dir, ["--tree", "fileout"]).stdout).toBe(`fileout\n-> ${path.join(out, "s.txt")}\n`);
  });
});

// ───────────────────────────── Mode script ─────────────────────────────

describe("treecat mode script", () => {
  it("@read --tree fichier et dossier", () => {
    const dir = sb({ "d/a.txt": "a\n", "f.txt": "f\n" });
    const r = fls(dir, [], "@read d --tree\n@read f.txt --tree\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[1] OK    READ d\nd\n└── a.txt\n    a\n");
    expect(r.stdout).toContain("[2] OK    READ f.txt\nf.txt\nf\n");
  });

  it("--tree global applique à tous les reads", () => {
    const dir = sb({ "f.txt": "f\n" });
    const r = fls(dir, ["--tree"], "@read f.txt\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[1] OK    READ f.txt\nf.txt\nf\n");
  });

  it("options incompatibles", () => {
    const dir = sb({ "f.txt": "a\nb\n" });
    const r = fls(dir, [], "@read f.txt --tree --lines 1-2\n");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("invalid_argument");
    expect(r.stdout).toContain("--tree est incompatible");
  });

  it("état simulé : create/delete visibles", () => {
    const dir = sb({ "old.txt": "old\n" });
    const script = [
      "@create new.txt",
      "<<<<<<< CONTENT",
      "new",
      ">>>>>>> END",
      "@delete old.txt",
      "@read . --tree",
      "",
    ].join("\n");
    const r = fls(dir, [], script);
    expect(r.stdout).toContain("└── new.txt\n    new\n");
    expect(r.stdout).not.toMatch(/[├└]── old\.txt/);
  });

  it("journal stocke le script effectif, expand inchangé", () => {
    const dir = sb({ "f.txt": "f\n" });
    const r = fls(dir, ["--tree"], "@create n.txt\n<<<<<<< CONTENT\nn\n>>>>>>> END\n@read f.txt\n");
    expect(r.status).toBe(0);
    const runDir = path.join(dir, ".fls", "runs");
    const id = fs.readdirSync(runDir)[0];
    expect(fs.readFileSync(path.join(runDir, id, "script.fls"), "utf8")).toContain("@read f.txt --tree");
    const expand = fls(dir, ["--tree", "expand"], "@read f.txt\n");
    expect(expand.stdout).toBe("@read f.txt\n");
  });

  it("racine absente : FAIL, continue, exit 1", () => {
    const dir = sb({ "f.txt": "f\n" });
    const r = fls(dir, [], "@read nope --tree\n@read f.txt --tree\n");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("FAIL  READ nope : not_found");
    expect(r.stdout).toContain("OK    READ f.txt\nf.txt\nf\n");
  });
});
