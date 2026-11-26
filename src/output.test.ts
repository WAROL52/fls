// Le module de sortie par son interface : destinationsFor (règles par destination) et deliver
// (un rendu par jeu d'options, troncature, octets exacts, mémorisation).
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as fls from "./fls.ts";
import { shikiHighlighter, type Highlighter } from "./highlight.ts";
import { span } from "./style.ts";
import { DEFAULT_MAX_OUTPUT, deliver, destinationsFor, type Delivery } from "./output.ts";
import type { ReportDoc } from "./report/segments.ts";
import type { Args, Io, Report } from "./types.ts";

const BG = "\x1b[48;2;20;20;20m";
const strip = (t: string): string => t.replace(/\x1b\[[0-9;]*[mK]/g, "");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fls-out-")));
  dirs.push(d);
  return d;
};
const args = (flags: string[] = [], values: Record<string, string> = {}): Args =>
  ({ positional: [], flags: new Set(flags), values: new Map(Object.entries(values)), ignore: [] }) as Args;
const ioOf = (o: Partial<Io> = {}): Io => ({ cwd: "/work", stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, env: {}, ...o }) as Io;

describe("destinationsFor", () => {
  it("par défaut : stdout seul, brut hors terminal, octets exacts autorisés, aucune limite explicite", () => {
    const { destinations, level } = destinationsFor(args(), ioOf());
    expect(destinations).toEqual([{ to: "stdout", styled: false, columns: undefined, limit: undefined, exactBytes: true }]);
    expect(level).toBe(3);
  });

  it("terminal : stdout stylé et largeur du terminal ; hors terminal, la largeur n'est pas retenue", () => {
    expect(destinationsFor(args(), ioOf({ stdoutIsTTY: true, columns: 120 })).destinations[0]).toMatchObject({ styled: true, columns: 120 });
    expect(destinationsFor(args(), ioOf({ stdoutIsTTY: false, columns: 120 })).destinations[0]).toMatchObject({ styled: false, columns: undefined });
  });

  it("--output : le fichier remplace stdout ; stylé seulement avec --colored", () => {
    const plain = destinationsFor(args([], { output: "o.txt" }), ioOf({ stdoutIsTTY: true, columns: 80 })).destinations;
    expect(plain).toEqual([{ to: "file", path: path.resolve("/work", "o.txt"), styled: false, limit: undefined, exactBytes: false }]);
    const colored = destinationsFor(args(["colored"], { output: "o.txt" }), ioOf({ columns: 80 })).destinations;
    expect(colored).toEqual([{ to: "file", path: path.resolve("/work", "o.txt"), styled: true, limit: undefined, exactBytes: false }]);
  });

  it("--clip et --clip-out ajoutent le presse-papiers : sans largeur, stylé seulement avec --colored", () => {
    for (const flag of ["clip", "clip-out"]) {
      const [stdout, clip] = destinationsFor(args([flag]), ioOf({ stdoutIsTTY: true, columns: 90 })).destinations;
      expect(stdout).toMatchObject({ to: "stdout", styled: true, columns: 90 });
      expect(clip).toEqual({ to: "clip", styled: false, limit: undefined, exactBytes: false });
    }
    const forced = destinationsFor(args(["clip", "colored"]), ioOf()).destinations;
    expect(forced.map((d) => [d.to, d.styled])).toEqual([["stdout", true], ["clip", true]]);
  });

  it("repli : le terminal garde sa largeur même quand la sortie part aussi dans le presse-papiers ou un fichier", () => {
    const [stdout] = destinationsFor(args(["clip", "colored"]), ioOf({ stdoutIsTTY: true, columns: 70 })).destinations;
    expect(stdout.columns).toBe(70);
    const toFile = destinationsFor(args(["colored", "clip"], { output: "o.txt" }), ioOf({ stdoutIsTTY: true, columns: 70 })).destinations;
    expect(toFile.map((d) => [d.to, d.columns])).toEqual([["file", undefined], ["clip", undefined]]);
  });

  it("--max-output-chars : limite de chaque destination ; valeur invalide : usage_error", () => {
    const ds = destinationsFor(args(["clip"], { "max-output-chars": "500" }), ioOf()).destinations;
    expect(ds.map((d) => d.limit)).toEqual([500, 500]);
    expect(() => destinationsFor(args([], { "max-output-chars": "0" }), ioOf())).toThrow(/entier >= 1/);
    expect(() => destinationsFor(args([], { "max-output-chars": "abc" }), ioOf())).toThrow(/usage_error|entier/);
  });

  it("style : couleur éteinte (--no-color, NO_COLOR), fond FLS_BG, highlighter injecté sinon Shiki", () => {
    expect(destinationsFor(args(["no-color"]), ioOf({ stdoutIsTTY: true })).level).toBe(0);
    expect(destinationsFor(args(), ioOf({ stdoutIsTTY: true, env: { NO_COLOR: "1" } })).destinations[0].styled).toBe(false);
    expect(destinationsFor(args(), ioOf({ env: { FLS_BG: "#010203" } })).style.bg).toEqual([1, 2, 3]);
    const mine: Highlighter = async (c) => c.split("\n").map((l) => span(l));
    expect(destinationsFor(args(), ioOf({ highlighter: mine })).style.highlighter).toBe(mine);
    expect(destinationsFor(args(), ioOf()).style.highlighter).toBe(shikiHighlighter);
  });
});

describe("deliver", () => {
  const doc: ReportDoc = {
    header: "fls 1.7.0 | run r1 | /x | 2026",
    entries: [{ status: "OK", kind: "READ", title: "a.ts (1 lignes)", code: "", body: [{ kind: "file", path: "a.ts", from: 1, total: 1, ranged: false, numbered: false, lines: ["const x = 1;"] }] }],
    footer: ["Résumé : 1 OK, 0 FAIL, 0 SKIP"],
  };
  const report = (over: Partial<Report> = {}): Report => ({ text: "BRUT\n", content: { kind: "report", doc }, code: 0, ...over });
  const harness = (o: Partial<Io> = {}) => {
    const out: Array<string | Buffer> = [];
    const clip: string[] = [];
    const calls: string[] = [];
    const highlighter: Highlighter = async (code, lang) => {
      calls.push(lang);
      return code.split("\n").map((l) => span(`<H>${l}</H>`));
    };
    const io = ioOf({ out: (t) => { out.push(t); }, clipboard: { read: () => "", write: (t) => { clip.push(t); } }, highlighter, ...o });
    return { io, out, clip, calls };
  };
  const delivery = (destinations: Delivery["destinations"], io: Io): Delivery => ({ destinations, level: 3, style: { highlighter: io.highlighter as Highlighter } });
  const dest = (over: Partial<Delivery["destinations"][number]> = {}) => ({ to: "stdout" as const, styled: false, exactBytes: true, ...over });

  it("brut : le texte du Rapport, sans rendu stylé", async () => {
    const h = harness();
    await deliver(report(), delivery([dest()], h.io), h.io);
    expect(h.out).toEqual(["BRUT\n"]);
    expect(h.calls).toEqual([]);
  });

  it("stylé : rendu depuis la donnée ; une destination sans donnée (aide, log) reste brute", async () => {
    const h = harness();
    await deliver(report(), delivery([dest({ styled: true })], h.io), h.io);
    expect(String(h.out[0])).toContain(BG);
    const h2 = harness();
    await deliver(report({ content: undefined }), delivery([dest({ styled: true })], h2.io), h2.io);
    expect(h2.out).toEqual(["BRUT\n"]);
  });

  it("un seul rendu pour deux destinations de mêmes options ; une largeur différente = un autre rendu", async () => {
    const h = harness();
    await deliver(report(), delivery([dest({ to: "file", path: path.join(tmp(), "o.txt"), styled: true, exactBytes: false }), dest({ to: "clip", styled: true, exactBytes: false })], h.io), h.io);
    expect(h.calls).toHaveLength(1); // un seul fichier lu, un seul rendu pour deux destinations
    const h2 = harness();
    await deliver(report(), delivery([dest({ styled: true, columns: 80 }), dest({ to: "clip", styled: true, exactBytes: false })], h2.io), h2.io);
    expect(h2.calls).toHaveLength(2);
  });

  it("repli par destination : le terminal est replié, le presse-papiers non (même rendu coloré)", async () => {
    const wide: Report = report({ content: { kind: "report", doc: { ...doc, entries: [{ ...doc.entries[0], body: [{ kind: "file", path: "a.ts", from: 1, total: 1, ranged: false, numbered: false, lines: ["x".repeat(100)] }] }] } } });
    const h = harness();
    await deliver(wide, delivery([dest({ styled: true, columns: 40 }), dest({ to: "clip", styled: true, exactBytes: false })], h.io), h.io);
    const rows = (t: string) => t.split("\n").filter((l) => l.includes(BG)).map(strip);
    expect(rows(String(h.out[0])).length).toBeGreaterThan(2);
    for (const r of rows(String(h.out[0]))) expect([...r].length).toBeLessThanOrEqual(39);
    expect(rows(h.clip[0])).toHaveLength(1);
  });

  it("troncature : limite propre à chaque destination ; coupe sans casser une séquence ANSI", async () => {
    const h = harness();
    await deliver(report({ text: "x".repeat(100) }), delivery([dest({ limit: 10 }), dest({ to: "clip", exactBytes: false, limit: 50 })], h.io), h.io);
    expect(h.out[0]).toBe(`${"x".repeat(10)}\n[rapport tronqué : 90 caractères omis ; relance avec --max-output-chars]\n`);
    expect(h.clip[0]).toBe(`${"x".repeat(50)}\n[rapport tronqué : 50 caractères omis ; relance avec --max-output-chars]\n`);
    const h2 = harness();
    await deliver(report(), delivery([dest({ styled: true, limit: 75 })], h2.io), h2.io);
    const cut = String(h2.out[0]);
    expect(cut).toContain("[rapport tronqué :");
    expect(cut.replace(/\n\[rapport tronqué[^\n]*\n$/, "")).not.toMatch(/\x1b(\[[0-9;]*)?$/);
  });

  it("limite par défaut : 200 000 caractères, sauf une lecture --tree (aucune limite)", async () => {
    const big = "y".repeat(DEFAULT_MAX_OUTPUT + 5);
    const h = harness();
    await deliver(report({ text: big }), delivery([dest({ exactBytes: false })], h.io), h.io);
    expect(String(h.out[0])).toContain("[rapport tronqué : 5 caractères omis");
    const h2 = harness();
    await deliver(report({ text: big, content: { kind: "tree", roots: [{ kind: "file", name: "d", lines: ["y"] }] } }), delivery([dest({ exactBytes: false })], h2.io), h2.io);
    expect(h2.out[0]).toBe(big);
  });

  it("octets exacts : seulement stdout brut ; fichier et presse-papiers reçoivent le texte ; tronqué, le texte", async () => {
    const raw = Buffer.from([0x61, 0xff, 0x62]); // octet non UTF-8 : le texte ne peut pas le représenter
    const h = harness();
    const file = path.join(tmp(), "o.txt");
    await deliver(report({ text: "a�b", raw }), delivery([dest(), dest({ to: "file", path: file, exactBytes: false }), dest({ to: "clip", exactBytes: false })], h.io), h.io);
    expect(h.out[0]).toBe(raw);
    expect(fs.readFileSync(file, "utf8")).toBe("a�b");
    expect(h.clip[0]).toBe("a�b");
    const h2 = harness();
    await deliver(report({ text: "a�b", raw }), delivery([dest({ limit: 2 })], h2.io), h2.io);
    expect(String(h2.out[0])).toContain("[rapport tronqué");
    const h3 = harness();
    await deliver(report({ text: "a�b", raw }), delivery([dest({ styled: true })], h3.io), h3.io);
    expect(Buffer.isBuffer(h3.out[0])).toBe(false);
  });

  it("mémorise la Dernière sortie seulement si le Rapport le demande", async () => {
    const cacheDir = path.join(tmp(), "cache");
    const h = harness({ cacheDir, now: () => new Date(0), cwd: "/work" });
    await deliver(report(), delivery([dest()], h.io), h.io);
    expect(fs.existsSync(path.join(cacheDir, "last.json"))).toBe(false);
    await deliver(report({ remember: true, content: undefined }), delivery([dest()], h.io), h.io);
    expect(fs.existsSync(path.join(cacheDir, "last.json"))).toBe(false);
    await deliver(report({ remember: true }), delivery([dest()], h.io), h.io);
    expect(fs.readFileSync(path.join(cacheDir, "last.json"), "utf8")).toContain('"kind":"report"');
  });
});

describe("de bout en bout : le terminal est replié, le presse-papiers non", () => {
  it("fls --colored --clip sur un terminal étroit", async () => {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, "a.ts"), `const long = "${"abcdefghij".repeat(12)}";\n`);
    const out: string[] = [];
    let clipText = "";
    const io = ioOf({
      cwd,
      stdoutIsTTY: true,
      columns: 40,
      out: (t) => { out.push(String(t)); },
      clipboard: { read: () => "", write: (t) => { clipText = t; } },
      now: () => new Date(0),
      newId: () => "r1",
    });
    expect(await fls.main(["--colored", "--clip", "a.ts"], io)).toBe(0);
    const rows = (t: string) => t.split("\n").filter((l) => l.includes(BG)).map(strip);
    expect(rows(out.join("")).length).toBeGreaterThan(3); // à l'écran : replié
    for (const r of rows(out.join(""))) expect([...r].length).toBeLessThanOrEqual(39);
    expect(rows(clipText)).toHaveLength(1); // dans le presse-papiers : une ligne
  });
});
