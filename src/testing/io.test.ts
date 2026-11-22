import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createRealIo } from "../fls.ts";
import { fake, put, runFls, sandbox, session } from "./io.ts";

describe("adapter de test de l'Io", () => {
  it("valeurs par défaut : horloge fixe, id r1, aucun terminal, env vide", () => {
    const { io } = fake("/w");
    expect(io).toMatchObject({ cwd: "/w", stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, env: {} });
    expect(io.now().toISOString()).toBe("2026-11-19T10:00:00.123Z");
    expect(io.newId(io.now())).toBe("r1");
    expect(io.readStdin()).toBe("");
    expect(io.cacheDir).toBeUndefined();
  });

  it("les options remplacent les défauts et le presse-papiers est en mémoire", () => {
    const f = fake("/w", { stdin: "s", tty: true, stdoutTTY: true, stderrTTY: true, env: { A: "1" }, clipboard: "c", id: "x", columns: 80, cacheDir: "/c" });
    expect(f.io).toMatchObject({ stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: true, env: { A: "1" }, columns: 80, cacheDir: "/c" });
    expect(f.io.readStdin()).toBe("s");
    expect(f.io.newId(f.io.now())).toBe("x");
    expect(f.io.clipboard.read()).toBe("c");
    f.io.clipboard.write("d");
    expect(f.clip.text).toBe("d");
  });

  it("expose exactement les champs du vrai Io (plus le highlighter injectable)", () => {
    const real = Object.keys(createRealIo(0)).sort();
    const faked = Object.keys(fake("/w").io).filter((k) => k !== "highlighter").sort();
    expect(faked).toEqual(real);
  });

  it("sandbox : dossier réel, fichiers en 644, setup après écriture", () => {
    const dir = sandbox({ "a/b.txt": "x", "bin.dat": Buffer.from([1, 2]) }, (d) => fs.writeFileSync(path.join(d, "late"), "l"));
    expect(fs.readFileSync(path.join(dir, "a/b.txt"), "utf8")).toBe("x");
    expect(fs.statSync(path.join(dir, "a/b.txt")).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(path.join(dir, "late"), "utf8")).toBe("l");
    put(dir, { "n/m.txt": "y" });
    expect(fs.existsSync(path.join(dir, "n/m.txt"))).toBe(true);
  });

  it("runFls garde les morceaux bruts (string ou Buffer) et décode le texte", async () => {
    const dir = sandbox({ "f.txt": "x\n" });
    const r = await runFls(dir, ["--tree", "f.txt"]);
    expect(r.code).toBe(0);
    expect(r.out.some((c) => Buffer.isBuffer(c))).toBe(true);
    expect(r.text).toContain("f.txt");
    expect((await runFls(dir, ["--version"])).errText).toBe("");
  });

  it("session : même dossier et même cache d'une commande à l'autre", async () => {
    const s = session({ "a.txt": "un\n" });
    await s.run(["a.txt", "--no-color"]);
    expect(fs.existsSync(s.lastFile)).toBe(true);
    s.put({ "a.txt": "deux\n" });
    expect((await s.run(["last", "--no-color"])).text).toContain("un");
    expect((await s.run(["last"], { noCache: true })).errText).toContain("no_last_output");
    expect((await s.run(["last"], { cacheDir: path.join(s.cwd, "autre") })).errText).toContain("no_last_output");
  });
});

describe("nettoyage", () => {
  const made: string[] = [];
  it("crée un dossier verrouillé", () => {
    const dir = sandbox({ "d/f.txt": "x" });
    fs.chmodSync(path.join(dir, "d"), 0o000);
    made.push(dir);
  });
  it("l'a supprimé malgré les droits retirés", () => {
    expect(made).toHaveLength(1);
    expect(fs.existsSync(made[0] as string)).toBe(false);
  });
});
