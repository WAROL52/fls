// Le module Rapport : segments typés, rendu brut (contrat SPEC §8), rendu stylé, copie versionnée.
// Les tests passent par l'interface du module (renderPlain, renderStyled, encode/decodeSnapshot) :
// aucun texte n'est reparsé, le highlighter est injecté.
import { describe, expect, it } from "vitest";
import type { Highlighter } from "./highlight.ts";
import { renderPlain, renderSegment } from "./report/plain.ts";
import { fileTitle, lastLine, textBody, type Entry, type ReportDoc, type Segment } from "./report/segments.ts";
import { decodeSnapshot, encodeSnapshot, SNAPSHOT_FORMAT } from "./report/snapshot.ts";
import { renderStyled as layout, type StyleOptions } from "./report/styled.ts";
import { toAnsi } from "./ansi.ts";
import { span } from "./style.ts";

const BG = "\x1b[48;2;20;20;20m";
const EOL = "\x1b[K\x1b[0m";
const strip = (t: string): string => t.replace(/\x1b\[[0-9;]*[mK]/g, "");
/** Sans ANSI ni marqueurs <H> du highlighter de test. */
const plain = (t: string): string => strip(t).replace(/<\/?H>/g, "");
const mark: Highlighter = async (code) => code.split("\n").map((l) => span(`<H>${l}</H>`));
const opts = (o: Partial<StyleOptions> = {}): StyleOptions => ({ highlighter: mark, ...o });
/** Le rendu stylé sérialisé en ANSI 24 bits. */
const renderStyled = async (d: ReportDoc, o: StyleOptions): Promise<string> => toAnsi(await layout(d, o), 3).text;
const entry = (kind: string, body: Segment[], over: Partial<Entry> = {}): Entry => ({ status: "OK", kind, title: "t", code: "", body, ...over });
const doc = (entries: Entry[]): ReportDoc => ({ header: "fls 1.3.0 | run r1 | /x | 2026", entries, footer: ["Résumé : 1 OK, 0 FAIL, 0 SKIP", "Modifiés : aucun"] });
const file = (over: Partial<Extract<Segment, { kind: "file" }>> = {}): Segment => ({ kind: "file", path: "a.ts", from: 1, total: 2, ranged: false, numbered: false, lines: ["un", "deux"], ...over });
const rowsWithBg = (out: string): string[] => out.split("\n").filter((l) => l.includes(BG));

describe("segments", () => {
  it("textBody : aucun segment pour un texte vide", () => {
    expect(textBody("")).toEqual([]);
    expect(textBody("x")).toEqual([{ kind: "text", text: "x" }]);
  });

  it("titre d'un fichier : entier ou plage, numéro de dernière ligne", () => {
    const whole = file() as Extract<Segment, { kind: "file" }>;
    const part = file({ from: 10, total: 100, ranged: true, lines: ["a", "b", "c"] }) as Extract<Segment, { kind: "file" }>;
    expect(fileTitle(whole)).toBe("a.ts (2 lignes)");
    expect(fileTitle(part)).toBe("a.ts (lignes 10-12 sur 100)");
    expect(lastLine(part)).toBe(12);
    expect(lastLine(file({ total: 0, lines: [] }) as Extract<Segment, { kind: "file" }>)).toBe(0); // fichier vide
  });
});

describe("rendu brut (SPEC §8)", () => {
  it("fichier : bloc, numéros alignés à droite, plage, fichier vide", () => {
    expect(renderSegment(file())).toBe("=== a.ts (2 lignes) ===\nun\ndeux\n=== fin ===");
    expect(renderSegment(file({ numbered: true }))).toBe("=== a.ts (2 lignes) ===\n1 | un\n2 | deux\n=== fin ===");
    const long = file({ from: 9, total: 30, ranged: true, numbered: true, lines: ["a", "b", "c"] });
    expect(renderSegment(long)).toBe("=== a.ts (lignes 9-11 sur 30) ===\n 9 | a\n10 | b\n11 | c\n=== fin ===");
    expect(renderSegment(file({ total: 0, lines: [] }))).toBe("=== a.ts (0 lignes) ===\n=== fin ===");
  });

  it("fichier omis, texte, grep (correspondance, contexte, séparateur), diff", () => {
    expect(renderSegment({ kind: "omitted", path: "b.bin", code: "binary_file" })).toBe("=== b.bin ===\n[omis : binary_file]\n=== fin ===");
    expect(renderSegment({ kind: "text", text: "libre" })).toBe("libre");
    const matches: Segment = {
      kind: "matches",
      pattern: "x",
      rows: [{ type: "match", file: "a.ts", line: 2, text: "x" }, { type: "context", file: "a.ts", line: 3, text: "y" }, { type: "sep" }, { type: "match", file: "b.ts", line: 1, text: "x" }],
    };
    expect(renderSegment(matches)).toBe("a.ts:2: x\na.ts-3- y\n--\nb.ts:1: x");
    const diff: Segment = { kind: "diff", hunks: [{ block: 1, line: 4, removed: ["a"], added: ["b", "c"] }, { block: 2, line: 9, removed: ["d"], added: [] }] };
    expect(renderSegment(diff)).toBe("@@ bloc 1 (ligne 4)\n- a\n+ b\n+ c\n@@ bloc 2 (ligne 9)\n- d");
  });

  it("entrée : en-tête, code d'erreur, segments séparés par une ligne vide ; rapport complet", () => {
    const d = doc([
      entry("READ", [{ kind: "text", text: "d/\n└── a.ts" }, file()], { title: "d (dossier, 1 fichier(s))" }),
      entry("EDIT", textBody("    bloc 1 : SEARCH introuvable"), { status: "FAIL", code: "not_found" }),
      entry("NOTE", []),
      entry("CREATE", [], { status: "SKIP", code: "skipped" }),
    ]);
    expect(renderPlain(d)).toBe(
      [
        "fls 1.3.0 | run r1 | /x | 2026",
        "",
        "[1] OK    READ d (dossier, 1 fichier(s))\nd/\n└── a.ts\n\n=== a.ts (2 lignes) ===\nun\ndeux\n=== fin ===",
        "",
        "[2] FAIL  EDIT t : not_found\n    bloc 1 : SEARCH introuvable",
        "",
        "[3] OK    NOTE t",
        "",
        "[4] SKIP  CREATE t : skipped",
        "",
        "Résumé : 1 OK, 0 FAIL, 0 SKIP\nModifiés : aucun",
        "",
      ].join("\n"),
    );
  });
});

describe("rendu stylé : structure", () => {
  it("fond uniquement sur les lignes de code ; en-tête, titres, marqueurs, notes et résumé n'en ont pas", async () => {
    const d = doc([entry("NOTE", textBody("une note")), entry("READ", [file()])]);
    const out = await renderStyled(d, opts());
    expect(rowsWithBg(out).map(plain)).toEqual(["1 │ un", "2 │ deux"]);
    for (const l of out.split("\n").filter((x) => !x.includes(BG))) expect(l).not.toContain("48;2;");
    expect(strip(out)).toContain("=== a.ts (2 lignes) ===");
    expect(strip(out)).toContain("=== fin ===");
    expect(strip(out).startsWith("fls 1.3.0 | run r1")).toBe(true);
    expect(strip(out).endsWith("Modifiés : aucun\n")).toBe(true);
  });

  it("numéros de ligne : ceux du fichier pour une plage ; largeur alignée", async () => {
    const d = doc([entry("READ", [file({ from: 9, total: 30, ranged: true, lines: ["a", "b", "c"] })])]);
    expect(rowsWithBg(await renderStyled(d, opts())).map(plain)).toEqual([" 9 │ a", "10 │ b", "11 │ c"]);
  });

  it("une ligne de code est repliée : numéro sur la première ligne visuelle seulement", async () => {
    const d = doc([entry("READ", [file({ total: 1, lines: ["x".repeat(50)] })])]);
    const rows = rowsWithBg(await renderStyled(d, opts({ columns: 40 }))).map(strip);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0].startsWith("1 │ ")).toBe(true);
    for (const r of rows.slice(1)) expect(r.startsWith("  │ ")).toBe(true);
    for (const r of rows) expect([...r].length).toBeLessThanOrEqual(39);
  });

  it("un fichier vide n'a que ses marqueurs ; un fichier omis n'a ni gouttière ni fond", async () => {
    const out = await renderStyled(doc([entry("READ", [file({ total: 0, lines: [] }), { kind: "omitted", path: "b.bin", code: "too_large" }])]), opts());
    expect(rowsWithBg(out)).toHaveLength(0);
    expect(strip(out)).toContain("=== a.ts (0 lignes) ===\n=== fin ===");
    expect(strip(out)).toContain("=== b.bin ===\n[omis : too_large]\n=== fin ===");
  });

  it("texte d'un READ (arbre, dossier) discret ; texte d'une autre directive inchangé ; statuts colorés", async () => {
    const d = doc([
      entry("READ", [{ kind: "text", text: "d/\n└── a.ts" }]),
      entry("TREE", textBody("d/")),
      entry("EDIT", textBody("    erreur"), { status: "FAIL", code: "not_found" }),
      entry("CREATE", textBody("    ignoré"), { status: "SKIP", code: "skipped" }),
    ]);
    const out = await renderStyled(d, opts());
    expect(out).toContain("\x1b[2md/\x1b[0m"); // texte de READ : dim
    expect(out).toContain("\nd/\n"); // texte de TREE : tel quel
    expect(out).toContain("\x1b[38;2;224;108;117mFAIL\x1b[0m");
    expect(out).toContain("\x1b[38;2;245;167;66mSKIP\x1b[0m");
    expect(out).toContain("\x1b[38;2;127;216;143mOK  \x1b[0m");
    expect(strip(out)).toContain("[2] OK    TREE t");
  });

  it("entrée sans corps (note, écriture) : l'en-tête seul, comme en brut", async () => {
    const d = doc([entry("NOTE", [], { title: "hello" }), entry("CREATE", [], { title: "n.txt (nouveau, 1 lignes)" })]);
    expect(strip(await renderStyled(d, opts()))).toBe(renderPlain(d));
  });

  it("segments sans contenu : même mise en page qu'en brut (texte vide, grep sans ligne, entre d'autres segments)", async () => {
    const noRows: Segment = { kind: "matches", pattern: "x", rows: [] };
    const d = doc([
      entry("A", [{ kind: "text", text: "" }]),
      entry("B", [noRows]),
      entry("C", [{ kind: "text", text: "avant" }, noRows, { kind: "text", text: "après" }]),
      entry("D", [{ kind: "text", text: "a\n" }]),
    ]);
    expect(strip(await renderStyled(d, opts()))).toBe(renderPlain(d));
  });

  it("plusieurs segments : séparés par une ligne vide, comme en brut", async () => {
    const d = doc([entry("READ", [{ kind: "text", text: "d/" }, file({ lines: ["x"], total: 1 }), file({ path: "b.ts", lines: ["y"], total: 1 })])]);
    expect(plain(await renderStyled(d, opts()))).toContain("d/\n\n=== a.ts (1 lignes) ===\n1 │ x\n=== fin ===\n\n=== b.ts (1 lignes) ===");
  });

  it("la couleur de fond se règle (bg) ; langue déduite du chemin", async () => {
    const langs: string[] = [];
    const spy: Highlighter = async (code, lang) => {
      langs.push(lang);
      return code.split("\n").map((l) => span(l));
    };
    const out = await renderStyled(doc([entry("READ", [file({ path: "src/a.ts" }), file({ path: "Dockerfile" })])]), opts({ bg: [1, 2, 3], highlighter: spy }));
    expect(out).toContain("\x1b[48;2;1;2;3m");
    expect(out).not.toContain(BG);
    expect(langs).toEqual(["typescript", "dockerfile"]);
  });

  it("highlighter en erreur ou trop court : le code reste lisible, numéroté et sur fond", async () => {
    const boom: Highlighter = async () => {
      throw new Error("boom");
    };
    const short: Highlighter = async () => [span("<H>un</H>")];
    for (const highlighter of [boom, short]) {
      const out = await renderStyled(doc([entry("READ", [file()])]), opts({ highlighter }));
      expect(rowsWithBg(out).map(strip).map((l) => l.replace(/<\/?H>/g, ""))).toEqual(["1 │ un", "2 │ deux"]);
    }
  });
});

describe("rendu stylé : grep et diff", () => {
  const rows: Segment = {
    kind: "matches",
    pattern: "foo",
    rows: [{ type: "match", file: "a.ts", line: 1, text: "const foo = 1" }, { type: "context", file: "a.ts", line: 2, text: "bar" }, { type: "sep" }, { type: "match", file: "b.ts", line: 7, text: "sans le motif" }],
  };

  it("occurrences : fond partout, correspondance en évidence, contexte discret, séparateur", async () => {
    const out = await renderStyled(doc([entry("GREP", [rows])]), opts());
    const lines = rowsWithBg(out);
    expect(lines.map(strip)).toEqual(["a.ts:1: const foo = 1", "a.ts-2- bar", "--", "b.ts:7: sans le motif"]);
    expect(lines[0]).toContain("\x1b[1;7mfoo\x1b[0m"); // correspondance : gras + inversé
    expect(lines[1]).toContain("\x1b[2mbar\x1b[0m"); // contexte : dim
    expect(lines[3]).not.toContain("\x1b[1;7m"); // motif absent de la ligne
    for (const l of lines) expect(l.endsWith(EOL)).toBe(true);
  });

  it("motif absent ou vide : pas de mise en évidence ; ligne longue repliée avec retrait", async () => {
    const none: Segment = { kind: "matches", pattern: null, rows: [{ type: "match", file: "a.ts", line: 1, text: "x".repeat(60) }] };
    const out = await renderStyled(doc([entry("GREP", [none])]), opts({ columns: 40 }));
    const lines = rowsWithBg(out).map(strip);
    expect(out).not.toContain("\x1b[1;7m");
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines.slice(1)) expect(l.startsWith("    ")).toBe(true);
    const empty: Segment = { kind: "matches", pattern: "", rows: [{ type: "match", file: "a.ts", line: 1, text: "x" }] };
    expect(await renderStyled(doc([entry("GREP", [empty])]), opts())).not.toContain("\x1b[1;7m");
  });

  it("diff : en-tête de hunk, fond rouge puis vert, tabulations développées (jusqu'à la colonne 8, préfixe « - » compris)", async () => {
    const diff: Segment = { kind: "diff", hunks: [{ block: 1, line: 3, removed: ["\told"], added: ["\tnew", "autre"] }, { block: 2, line: 9, removed: ["seul"], added: [] }] };
    const out = await renderStyled(doc([entry("EDIT", [diff])]), opts());
    expect(out).not.toContain("\t");
    expect(plain(out)).toContain("@@ bloc 1 (ligne 3)\n-       old\n+       new\n+ autre\n@@ bloc 2 (ligne 9)\n- seul\n");
    const del = out.split("\n").filter((l) => l.includes("\x1b[48;2;55;34;44m"));
    const add = out.split("\n").filter((l) => l.includes("\x1b[48;2;32;48;59m"));
    expect(del).toHaveLength(2);
    expect(add).toHaveLength(2);
    for (const l of [...del, ...add]) expect(l.endsWith(EOL)).toBe(true);
  });

  it("diff : lignes longues repliées avec retrait de deux colonnes", async () => {
    const diff: Segment = { kind: "diff", hunks: [{ block: 1, line: 1, removed: ["x".repeat(80)], added: ["y"] }] };
    const del = (await renderStyled(doc([entry("EDIT", [diff])]), opts({ columns: 40 }))).split("\n").filter((l) => l.includes("\x1b[48;2;55;34;44m")).map(strip);
    expect(del.length).toBeGreaterThan(2);
    for (const l of del.slice(1)) expect(l.startsWith("  ")).toBe(true);
    for (const l of del) expect([...l].length).toBeLessThanOrEqual(39);
  });
});

describe("copie de la Dernière sortie", () => {
  const report = { kind: "report" as const, doc: doc([entry("READ", [file()])]) };
  const tree = {
    kind: "tree" as const,
    roots: [{ kind: "dir" as const, name: "d", children: [{ kind: "file" as const, name: "a.ts", lines: ["x"] }, { kind: "file" as const, name: "b", lines: [], note: "unreadable" as const }, { kind: "link" as const, name: "l", target: "a.ts" }] }, null],
  };

  it("aller-retour : le Rapport (et les arbres) reviennent à l'identique", () => {
    expect(decodeSnapshot(JSON.parse(JSON.stringify(encodeSnapshot(report))))).toEqual(report);
    expect(decodeSnapshot(JSON.parse(JSON.stringify(encodeSnapshot(tree))))).toEqual(tree);
    expect(encodeSnapshot(report).format).toBe(SNAPSHOT_FORMAT);
  });

  it("une copie d'un autre format ou de forme inattendue est ignorée (jamais une erreur)", () => {
    const bad: unknown[] = [
      null, 3, "x", {}, { format: 1, snapshot: { kind: "report", text: "t" } }, // copie texte de fls 1.2.0
      { format: SNAPSHOT_FORMAT }, { format: SNAPSHOT_FORMAT, snapshot: null },
      { format: SNAPSHOT_FORMAT, snapshot: { kind: "autre" } },
      { format: SNAPSHOT_FORMAT, snapshot: { kind: "tree", roots: "non" } },
      { format: 2, snapshot: { kind: "tree", roots: [{ p: "d", label: "d", raw: "d\n" }] } }, // arbres en texte (format 2)
      { format: SNAPSHOT_FORMAT, snapshot: { kind: "tree", roots: [3] } },
      { format: SNAPSHOT_FORMAT, snapshot: { kind: "tree", roots: [{ kind: "dir", name: "d", children: [{ kind: "autre", name: "x" }] }] } },
      { format: SNAPSHOT_FORMAT, snapshot: { kind: "tree", roots: [{ kind: "dir", name: 1, children: [] }] } },
      { format: SNAPSHOT_FORMAT, snapshot: { kind: "tree", roots: [{ kind: "dir", name: "d", children: "non" }] } },
      { format: SNAPSHOT_FORMAT, snapshot: { kind: "tree", roots: [{ kind: "file", name: "f", lines: [1] }] } },
      { format: SNAPSHOT_FORMAT, snapshot: { kind: "tree", roots: [{ kind: "file", name: "f", lines: [], note: "inconnue" }] } },
      { format: SNAPSHOT_FORMAT, snapshot: { kind: "tree", roots: [{ kind: "link", name: "l" }] } },
      { format: SNAPSHOT_FORMAT, snapshot: { kind: "report" } },
      { format: SNAPSHOT_FORMAT, snapshot: { kind: "report", doc: { header: 1, entries: [], footer: [] } } },
      { format: SNAPSHOT_FORMAT, snapshot: { kind: "report", doc: { header: "h", entries: {}, footer: [] } } },
      { format: SNAPSHOT_FORMAT, snapshot: { kind: "report", doc: { header: "h", entries: [], footer: "f" } } },
    ];
    for (const b of bad) expect(decodeSnapshot(b), JSON.stringify(b)).toBeNull();
  });
});
