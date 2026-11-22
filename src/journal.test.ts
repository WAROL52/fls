import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FlsError } from "./errors.ts";
import { Journal } from "./journal.ts";
import { Workspace } from "./workspace.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fls-journal-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (rel: string, text: string, mode = 0o644): void => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, { mode });
  fs.chmodSync(abs, mode);
};
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as FlsError).code;
  }
  return undefined;
};

/** Un run qui modifie a.txt (existant) et crée b/c.txt. */
function record(journal: Journal, id: string): void {
  const ws = new Workspace(dir, 1e6);
  ws.write("a.txt", Buffer.from("nouveau"));
  ws.write("b/c.txt", Buffer.from("cree"));
  journal.record(ws, { id, now: new Date("2026-01-01T00:00:00Z"), pending: ws.pending(), script: "@read a.txt\n", report: "rapport\n" });
}

describe("Journal", () => {
  it("enregistre un run puis le relit : méta, script, rapport", () => {
    write("a.txt", "ancien", 0o755);
    const j = new Journal(dir, 1e6);
    expect(j.list()).toEqual([]);
    record(j, "r1");
    const [m] = j.list();
    expect(m).toMatchObject({ id: "r1", date: "2026-01-01T00:00:00.000Z", undone: false });
    expect(m?.files.map((f) => f.path).sort()).toEqual(["a.txt", "b/c.txt"]);
    expect(j.show("r1")).toEqual({ script: "@read a.txt\n", report: "rapport\n" });
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("nouveau");
  });

  it("refuse un id inconnu ou qui sort du dossier", () => {
    const j = new Journal(dir, 1e6);
    expect(code(() => j.meta("zzz"))).toBe("run_not_found");
    expect(code(() => j.show("../x"))).toBe("run_not_found");
  });

  it("annule le dernier run non annulé, restaure contenu et mode, supprime les créés", () => {
    write("a.txt", "ancien", 0o755);
    const j = new Journal(dir, 1e6);
    record(j, "r1");
    const { meta: undone } = j.undo(undefined, false);
    expect(undone.id).toBe("r1");
    expect(undone.undone).toBe(true);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("ancien");
    expect(fs.statSync(path.join(dir, "a.txt")).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(path.join(dir, "b/c.txt"))).toBe(false);
    expect(j.list()[0]?.undone).toBe(true);
    expect(code(() => j.undo(undefined, false))).toBe("nothing_to_undo");
    expect(code(() => j.undo("r1", false))).toBe("already_undone");
  });

  it("annule un run ciblé et recrée un dossier supprimé depuis", () => {
    write("a.txt", "ancien");
    const j = new Journal(dir, 1e6);
    record(j, "r1");
    fs.rmSync(path.join(dir, "a.txt"));
    fs.writeFileSync(path.join(dir, "a.txt"), "nouveau");
    expect(j.undo("r1", false).meta.id).toBe("r1");
  });

  it("refuse en cas de conflit, sauf --force", () => {
    write("a.txt", "ancien");
    const j = new Journal(dir, 1e6);
    record(j, "r1");
    fs.writeFileSync(path.join(dir, "a.txt"), "modifie depuis");
    expect(code(() => j.undo("r1", false))).toBe("conflict");
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("modifie depuis");
    j.undo("r1", true);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("ancien");
  });

  it("un fichier créé puis supprimé à la main est un conflit", () => {
    const j = new Journal(dir, 1e6);
    record(j, "r1");
    fs.rmSync(path.join(dir, "b/c.txt"));
    expect(code(() => j.undo("r1", false))).toBe("conflict");
  });

  it("journalise les dossiers créés ; undo retire ceux qui sont restés vides, laisse les autres", () => {
    const j = new Journal(dir, 1e6);
    const ws = new Workspace(dir, 1e6);
    ws.mkdir("x/y");
    ws.mkdir("z");
    expect(ws.newDirs()).toEqual(["x", "x/y", "z"]);
    j.record(ws, { id: "r1", now: new Date("2026-01-01T00:00:00Z"), pending: ws.pending(), script: "@mkdir x/y\n", report: "r\n" });
    expect(j.list()[0]?.dirs).toEqual(["x", "x/y", "z"]);
    expect(fs.statSync(path.join(dir, "x/y")).isDirectory()).toBe(true);
    write("z/garde.txt", "à moi");
    fs.rmSync(path.join(dir, "x/y"), { recursive: true });
    const undone = j.undo("r1", false);
    expect(undone.removedDirs).toEqual(["x"]); // x/y déjà disparu : ni retiré ni conservé
    expect(undone.keptDirs).toEqual(["z"]);
    expect(fs.existsSync(path.join(dir, "x"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "z/garde.txt"))).toBe(true);
  });

  it("un journal d'avant 1.3.0 (sans dirs) reste annulable", () => {
    write("a.txt", "ancien");
    const j = new Journal(dir, 1e6);
    record(j, "r1");
    const file = path.join(dir, ".fls/runs/r1/meta.json");
    const meta = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete meta["dirs"];
    fs.writeFileSync(file, JSON.stringify(meta));
    expect(j.undo("r1", false).removedDirs).toEqual([]);
  });

  it("history : récents d'abord, limite, filtre par chemin et action (créé, modifié, supprimé, dossier créé)", () => {
    write("a.txt", "v0");
    write("gone.txt", "x");
    const j = new Journal(dir, 1e6);
    const run = (id: string, fn: (ws: Workspace) => void): void => {
      const ws = new Workspace(dir, 1e6);
      fn(ws);
      j.record(ws, { id, now: new Date("2026-01-01T00:00:00Z"), pending: ws.pending(), script: "s\n", report: "r\n" });
    };
    run("r1", (ws) => ws.write("a.txt", Buffer.from("v1")));
    run("r2", (ws) => ws.write("new.txt", Buffer.from("n")));
    run("r3", (ws) => ws.remove("gone.txt"));
    run("r4", (ws) => ws.mkdir("d"));
    j.undo("r4", false);
    expect(j.history(null, 10).map((h) => h.id)).toEqual(["r4", "r3", "r2", "r1"]);
    expect(j.history(null, 2).map((h) => h.id)).toEqual(["r4", "r3"]);
    expect(j.history(null, 10)[0]).toMatchObject({ undone: true, files: 0, dirs: 1, action: null });
    expect(j.history("a.txt", 10)).toMatchObject([{ id: "r1", action: "modifié" }]);
    expect(j.history("new.txt", 10)).toMatchObject([{ id: "r2", action: "créé" }]);
    expect(j.history("gone.txt", 10)).toMatchObject([{ id: "r3", action: "supprimé" }]);
    expect(j.history("d", 10)).toMatchObject([{ id: "r4", action: "dossier créé", undone: true }]);
    expect(j.history("rien", 10)).toEqual([]);
  });
});
