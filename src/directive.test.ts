// Directives de 1.3.0 : @copy, @mkdir, @stat, @expect_* (vérifications) et @history.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runFls, sandbox, type FakeOpts, type Files } from "./testing/io.ts";

async function run(argv: string[], files: Files = {}, o: FakeOpts & { setup?: (dir: string) => void } = {}) {
  const dir = sandbox(files, o.setup);
  return { dir, ...(await runFls(dir, argv, o)) };
}
const script = (s: string, files: Files = {}, argv: string[] = [], o: FakeOpts & { setup?: (dir: string) => void } = {}) =>
  run(argv, files, { stdin: s, ...o });
const content = (name: string, file: string, body: string): string => `@${name} ${file}\n<<<<<<< CONTENT\n${body}\n>>>>>>> END\n`;
const read = (dir: string, rel: string): string => fs.readFileSync(path.join(dir, rel), "utf8");
const exists = (dir: string, rel: string): boolean => fs.existsSync(path.join(dir, rel));
const sha = (s: string): string => createHash("sha1").update(s).digest("hex");

describe("@copy", () => {
  it("copie un fichier en gardant la source et les droits ; annulable", async () => {
    const r = await script("@copy a.sh sub/b.sh\n", { "a.sh": "echo\n" }, [], { setup: (d) => fs.chmodSync(path.join(d, "a.sh"), 0o755) });
    expect(r.code).toBe(0);
    expect(r.text).toContain("[1] OK    COPY a.sh -> sub/b.sh");
    expect(read(r.dir, "a.sh")).toBe("echo\n");
    expect(read(r.dir, "sub/b.sh")).toBe("echo\n");
    expect(fs.statSync(path.join(r.dir, "sub/b.sh")).mode & 0o777).toBe(0o755);
    expect((await runFls(r.dir, ["undo"])).code).toBe(0);
    expect(exists(r.dir, "sub/b.sh")).toBe(false);
    expect(exists(r.dir, "a.sh")).toBe(true);
  });

  it("refuse une destination existante, une source absente ou un dossier ; la suite est ignorée", async () => {
    const r = await script("@copy a.txt b.txt\n@copy nope c.txt\n@copy d c.txt\n@write z.txt\n<<<<<<< CONTENT\nz\n>>>>>>> END\n", { "a.txt": "a", "b.txt": "b", "d/x.txt": "x" });
    expect(r.code).toBe(1);
    expect(r.text).toContain("[1] FAIL  COPY a.txt b.txt : already_exists");
    expect(r.text).toContain("[2] SKIP  COPY nope c.txt : skipped");
    expect(read(r.dir, "b.txt")).toBe("b");
    expect((await script("@copy nope c.txt\n", {})).text).toContain("COPY nope c.txt : not_found");
    expect((await script("@copy d c.txt\n", { "d/x.txt": "x" })).text).toContain("COPY d c.txt : is_directory");
  });

  it("--dry-run n'écrit rien et un @read voit la copie", async () => {
    const r = await script("@copy a.txt b.txt\n@read b.txt\n", { "a.txt": "salut\n" }, ["--dry-run"]);
    expect(r.text).toContain("salut");
    expect(r.text).toContain("Modifierait : b.txt");
    expect(exists(r.dir, "b.txt")).toBe(false);
  });
});

describe("@mkdir", () => {
  it("crée le dossier et ses parents, vide, et le journalise", async () => {
    const r = await script("@mkdir apps/web/hooks\n");
    expect(r.code).toBe(0);
    expect(r.text).toContain("[1] OK    MKDIR apps/web/hooks/ (créé)");
    expect(r.text).toContain("Modifiés : apps/, apps/web/, apps/web/hooks/");
    expect(r.text).toContain("Annulable avec : fls undo");
    expect(fs.readdirSync(path.join(r.dir, "apps/web/hooks"))).toEqual([]);
    const log = await runFls(r.dir, ["log"]);
    expect(log.text).toMatch(/0 fichier\(s\), 3 dossier\(s\)\n/);
  });

  it("crée un dossier sous un dossier existant", async () => {
    const r = await script("@mkdir d/neuf\n", { "d/x.txt": "x" });
    expect(r.text).toContain("Modifiés : d/neuf/");
    expect(fs.statSync(path.join(r.dir, "d/neuf")).isDirectory()).toBe(true);
  });

  it("est idempotent : un dossier existant est un OK sans effet et sans run", async () => {
    const r = await script("@mkdir d\n@mkdir .\n", { "d/x.txt": "x" });
    expect(r.code).toBe(0);
    expect(r.text).toContain("MKDIR d/ (existe déjà)");
    expect(r.text).toContain("MKDIR ./ (existe déjà)");
    expect(r.text).toContain("Modifiés : aucun");
    expect(r.text).not.toContain("Annulable");
    expect(exists(r.dir, ".fls")).toBe(false);
  });

  it("refuse un fichier, un fichier parent, un lien symbolique ou un chemin hors du dossier", async () => {
    const r = await script("@mkdir f\n@mkdir f/sous\n@mkdir l\n@mkdir ../dehors\n", { f: "x" }, [], { setup: (d) => fs.symlinkSync("f", path.join(d, "l")) });
    expect(r.text).toContain("[1] FAIL  MKDIR f : not_a_directory");
    expect(r.text).toContain("[3] SKIP  MKDIR l : skipped");
    const a = await script("@mkdir f/sous\n", { f: "x" });
    expect(a.text).toContain("not_a_directory");
    expect(a.text).toContain("f est un fichier");
    expect((await script("@mkdir l\n", {}, [], { setup: (d) => fs.symlinkSync(".", path.join(d, "l")) })).text).toContain("MKDIR l : symlink");
    expect((await script("@mkdir ../dehors\n")).text).toContain("MKDIR ../dehors : outside_workspace");
  });

  it("le dossier vide est visible dans le même script (@tree, @read dossier) et refuse d'être un fichier", async () => {
    const r = await script("@mkdir vide/profond\n@tree\n");
    expect(r.text).toContain("└── vide/");
    expect(r.text).toContain("    └── profond/");
    const t = await script("@mkdir vide\n@write vide\n<<<<<<< CONTENT\nx\n>>>>>>> END\n");
    expect(t.text).toContain("WRITE vide : is_directory");
    const c = await script("@mkdir vide\n@create vide/f.txt\n<<<<<<< CONTENT\nx\n>>>>>>> END\n@tree\n");
    expect(c.text).toContain("vide/");
    expect(c.text).toContain("f.txt");
  });

  it("--dry-run n'écrit rien ; --tree d'un dossier vide créé après coup", async () => {
    const r = await script("@mkdir d\n", {}, ["--dry-run"]);
    expect(r.text).toContain("Modifierait : d/");
    expect(exists(r.dir, "d")).toBe(false);
  });

  it("undo retire les dossiers restés vides et conserve les autres, en le disant", async () => {
    const r = await script("@mkdir a/b\n@mkdir c\n");
    fs.writeFileSync(path.join(r.dir, "c/perso.txt"), "à moi");
    const u = await runFls(r.dir, ["undo"]);
    expect(u.code).toBe(0);
    expect(u.text).toContain("(0 fichier(s) restauré(s), 2 dossier(s) supprimé(s))");
    expect(u.text).toContain("    a/b/");
    expect(u.text).toContain("    c/ conservé : il n'est pas vide");
    expect(exists(r.dir, "a")).toBe(false);
    expect(exists(r.dir, "c/perso.txt")).toBe(true);
  });
});

describe("@stat", () => {
  it("décrit un fichier texte : type, taille, lignes, droits, sha1", async () => {
    const r = await script("@stat a.txt\n", { "a.txt": "un\ndeux\n" });
    expect(r.code).toBe(0);
    expect(r.text).toContain(
      `[1] OK    STAT a.txt\n    type   : fichier\n    taille : 8 octets\n    lignes : 2\n    droits : 0644\n    sha1   : ${sha("un\ndeux\n")}`,
    );
  });

  it("voit l'état simulé : un fichier créé dans le script", async () => {
    const r = await script(`${content("create", "n.txt", "x")}@stat n.txt\n`, {}, ["--dry-run"]);
    expect(r.text).toContain("lignes : 1");
    expect(r.text).toContain(`sha1   : ${sha("x\n")}`);
  });

  it("n'affiche pas de lignes pour un binaire ou un fichier trop gros", async () => {
    const bin = await script("@stat b.bin\n", { "b.bin": Buffer.from([0, 1, 2]) });
    expect(bin.text).toContain("taille : 3 octets");
    expect(bin.text).not.toContain("lignes");
    const big = await script("@stat g.txt\n", { "g.txt": "abcdef" }, ["--max-size", "3"]);
    expect(big.text).toContain("taille : 6 octets");
    expect(big.text).not.toContain("lignes");
  });

  it("décrit un dossier, la racine et un lien", async () => {
    const r = await script("@stat d\n@stat .\n@stat l\n", { "d/a": "1", "d/b": "2" }, [], { setup: (dir) => fs.symlinkSync("d/a", path.join(dir, "l")) });
    expect(r.text).toContain("STAT d\n    type   : dossier\n    éléments : 2");
    expect(r.text).toContain("STAT .\n");
    expect(r.text).toContain("STAT l\n    type   : lien symbolique -> d/a");
  });

  it("chemin absent : FAIL not_found (c'est @expect_exists qui teste l'existence)", async () => {
    const r = await script("@stat nope\n");
    expect(r.code).toBe(1);
    expect(r.text).toContain("[1] FAIL  STAT nope : not_found");
  });
});

describe("@expect_exists / @expect_missing", () => {
  it("OK quand le fait est vrai", async () => {
    const r = await script("@expect_exists a.txt\n@expect_exists d\n@expect_missing nope\n", { "a.txt": "a", "d/x": "x" });
    expect(r.code).toBe(0);
    expect(r.text).toContain("[1] OK    EXPECT_EXISTS a.txt");
    expect(r.text).toContain("[3] OK    EXPECT_MISSING nope");
  });

  it("FAIL expectation_failed avec le constat", async () => {
    const r = await script("@expect_exists nope\n@expect_missing a.txt\n@expect_missing d\n@expect_missing l\n", { "a.txt": "a", "d/x": "x" }, [], {
      setup: (dir) => fs.symlinkSync("a.txt", path.join(dir, "l")),
    });
    expect(r.code).toBe(1);
    expect(r.text).toContain("[1] FAIL  EXPECT_EXISTS nope : expectation_failed\n    attendu : nope existe ; trouvé : absent");
    expect(r.text).toContain("attendu : a.txt absent ; trouvé : fichier");
    expect(r.text).toContain("attendu : d absent ; trouvé : dossier");
    expect(r.text).toContain("attendu : l absent ; trouvé : lien symbolique");
  });
});

describe("@expect_contains", () => {
  it("au moins une fois par défaut ; exactement N avec --count", async () => {
    const files = { "a.txt": "x un\ny\nx duo\n" };
    const ok = await script('@expect_contains a.txt "x"\n@expect_contains a.txt x --count 2\n@expect_contains a.txt "absent" --count 0\n', files);
    expect(ok.code).toBe(0);
    expect(ok.text).toContain('[1] OK    EXPECT_CONTAINS a.txt "x" (2 occurrence(s))');
    const ko = await script('@expect_contains a.txt "absent"\n@expect_contains a.txt x --count 1\n', files);
    expect(ko.text).toContain("attendu : au moins 1 occurrence(s) dans a.txt ; trouvé : 0\n");
    expect(ko.text).toContain("attendu : 1 occurrence(s) dans a.txt ; trouvé : 2 (lignes 1, 3)");
  });

  it("compte toutes les occurrences, même sur une même ligne ou sur plusieurs lignes", async () => {
    const files = { "a.txt": "ab ab\nab\ncd\nef\n" };
    expect((await script("@expect_contains a.txt ab --count 3\n", files)).code).toBe(0);
    expect((await script('@expect_contains a.txt "cd\\\\sef" --regex --count 1\n', files)).code).toBe(0); // sur plusieurs lignes : par --regex
  });

  it("--regex ; expression invalide ; texte vide ; --count invalide", async () => {
    const files = { "a.txt": "id: 12\nid: 7\n" };
    expect((await script('@expect_contains a.txt "id: \\\\d+" --regex --count 2\n', files)).code).toBe(0);
    expect((await script('@expect_contains a.txt "(" --regex\n', files)).text).toContain("EXPECT_CONTAINS a.txt ( : invalid_argument");
    expect((await script('@expect_contains a.txt ""\n', files)).text).toContain("invalid_argument\n    le texte cherché est vide");
    expect((await script("@expect_contains a.txt x --count -1\n", files)).text).toContain("invalid_argument");
  });

  it("liste au plus 10 lignes puis « … »", async () => {
    const r = await script("@expect_contains a.txt x --count 1\n", { "a.txt": "x\n".repeat(12) });
    expect(r.text).toContain("trouvé : 12 (lignes 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, …)");
  });

  it("garde les codes de lecture : fichier absent, binaire", async () => {
    expect((await script("@expect_contains nope x\n")).text).toContain("EXPECT_CONTAINS nope x : not_found");
    expect((await script("@expect_contains b x\n", { b: Buffer.from([0, 1]) })).text).toContain("EXPECT_CONTAINS b x : binary_file");
  });
});

describe("vérifications : garde-fou des écritures", () => {
  const w = content("write", "out.txt", "écrit");

  it("un échec bloque les écritures suivantes (SKIP) mais pas les lectures", async () => {
    const r = await script(`@expect_exists absent\n${w}@read a.txt\n@mkdir d\n`, { "a.txt": "lu\n" });
    expect(r.code).toBe(1);
    expect(r.text).toContain("[2] SKIP  WRITE out.txt : skipped\n    ignoré : une écriture ou une vérification précédente a échoué");
    expect(r.text).toContain("[3] OK    READ a.txt");
    expect(r.text).toContain("[4] SKIP  MKDIR d : skipped");
    expect(exists(r.dir, "out.txt")).toBe(false);
    expect(r.text).toContain("Modifiés : aucun");
  });

  it("une vérification réussie ne bloque rien, et une vérification échouée n'est pas bloquée par un échec précédent", async () => {
    const ok = await script(`@expect_exists a.txt\n${w}`, { "a.txt": "a" });
    expect(ok.code).toBe(0);
    expect(read(ok.dir, "out.txt")).toBe("écrit\n");
    const two = await script("@expect_exists x\n@expect_exists y\n");
    expect(two.text).toContain("[2] FAIL  EXPECT_EXISTS y : expectation_failed");
  });

  it("voit l'état simulé : vérifier le résultat d'un @edit dans le même script", async () => {
    const edit = "@edit a.txt\n<<<<<<< SEARCH\nvieux\n=======\nneuf\n>>>>>>> REPLACE\n";
    const r = await script(`${edit}@expect_contains a.txt neuf --count 1\n@expect_contains a.txt vieux --count 0\n`, { "a.txt": "vieux\n" }, ["--dry-run"]);
    expect(r.code).toBe(0);
  });

  it("un échec après des écritures ne les annule pas : le run reste annulable", async () => {
    const r = await script(`${w}@expect_missing out.txt\n`);
    expect(r.code).toBe(1);
    expect(r.text).toContain("[2] FAIL  EXPECT_MISSING out.txt : expectation_failed");
    expect(read(r.dir, "out.txt")).toBe("écrit\n");
    expect(r.text).toContain("Annulable avec : fls undo");
  });

  it("forme collable #@ : acceptée pour les directives sans écriture, refusée pour @mkdir et @copy", async () => {
    const ok = await script("#@expect_exists a.txt\n#@stat a.txt\n#@history\n", { "a.txt": "a" });
    expect(ok.code).toBe(0);
    expect((await script("#@mkdir d\n")).errText).toContain("#@mkdir : les directives d'écriture exigent la forme @mkdir");
    expect((await script("#@copy a b\n")).code).toBe(2);
    expect((await script("#@expect_nope a\n")).errText).toContain("directive inconnue #@expect_nope");
    expect((await script("@expect_nope a\n")).code).toBe(2);
  });
});

describe("@history", () => {
  it("sans run : OK « aucun run »", async () => {
    const r = await script("@history\n@history a.txt\n");
    expect(r.code).toBe(0);
    expect(r.text).toContain("[1] OK    HISTORY 0 run(s)\n    aucun run");
    expect(r.text).toContain("[2] OK    HISTORY a.txt : 0 run(s)");
  });

  it("liste les runs, les plus récents d'abord, avec --limit ; filtre par chemin avec l'action", async () => {
    const dir = sandbox({ "a.txt": "v0\n" });
    const step = async (s: string, id: string) => runFls(dir, [], { stdin: s, id });
    await step(`${content("write", "a.txt", "v1")}`, "r1");
    await step(`${content("create", "n.txt", "n")}`, "r2");
    await step("@mkdir d\n", "r3");
    await step("@delete n.txt\n", "r4");
    await runFls(dir, ["undo", "--run", "r3"]);
    const all = await runFls(dir, [], { stdin: "@history\n" });
    const ids = [...all.text.matchAll(/^ {4}(r\d)  /gm)].map((m) => m[1]);
    expect(ids).toEqual(["r4", "r3", "r2", "r1"]);
    expect(all.text).toContain("HISTORY 4 run(s)");
    expect(all.text).toMatch(/r3  \S+  0 fichier\(s\), 1 dossier\(s\)  \(annulé\)/);
    expect(all.text).toMatch(/r1  \S+  1 fichier\(s\)\n/);
    const two = await runFls(dir, [], { stdin: "@history --limit 2\n" });
    expect([...two.text.matchAll(/^ {4}(r\d)  /gm)].map((m) => m[1])).toEqual(["r4", "r3"]);
    const file = await runFls(dir, [], { stdin: "@history n.txt\n@history a.txt\n@history d\n" });
    expect(file.text).toContain("HISTORY n.txt : 2 run(s)");
    expect(file.text).toMatch(/r4  \S+  supprimé\n\s+r2  \S+  créé/);
    expect(file.text).toMatch(/r1  \S+  modifié/);
    expect(file.text).toMatch(/r3  \S+  dossier créé  \(annulé\)/);
  });

  it("--limit doit être un entier >= 1", async () => {
    expect((await script("@history --limit 0\n")).text).toMatch(/HISTORY\s+: invalid_argument\n\s+--limit attend un entier >= 1/);
    expect((await script("@history --limit x\n")).text).toContain("invalid_argument");
  });
});

describe("aide", () => {
  it("fls help et fls spec décrivent les nouvelles directives", async () => {
    for (const name of ["copy", "mkdir", "stat", "history", "expect_exists", "expect_missing", "expect_contains"]) {
      const h = await runFls(sandbox(), ["help", name]);
      expect(h.code).toBe(0);
      expect(h.text).toContain(`@${name}`);
    }
    const spec = (await runFls(sandbox(), ["spec"])).text;
    expect(spec).toContain("expectation_failed");
    expect(spec).toContain("@expect_contains <fichier>");
    expect(spec).toContain("après un échec d'écriture ou de vérification (@expect_*)");
  });
});
