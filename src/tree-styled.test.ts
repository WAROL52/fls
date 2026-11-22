// Rendu stylé d'un arbre `--tree` : il part de la structure (dossiers, fichiers, liens), jamais d'un
// texte reparsé. Le highlighter est injecté.
import { describe, expect, it } from "vitest";
import type { Highlighter } from "./highlight.ts";
import type { StyleOptions } from "./report/styled.ts";
import { renderTreeStyled } from "./report/tree-styled.ts";
import { treeText, type TreeNode } from "./tree.ts";

const BG = "\x1b[48;2;20;20;20m";
const EOL = "\x1b[K\x1b[0m";
const strip = (t: string): string => t.replace(/\x1b\[[0-9;]*[mK]/g, "");
const plain = (t: string): string => strip(t).replace(/<\/?H>/g, "");
const mark: Highlighter = async (code) => code.split("\n").map((l) => `<H>${l}</H>`);
const opts = (o: Partial<StyleOptions> = {}): StyleOptions => ({ level: 3, highlighter: mark, ...o });

const dir = (name: string, children: TreeNode[]): TreeNode => ({ kind: "dir", name, children });
const file = (name: string, lines: string[], note?: "output file" | "unreadable"): TreeNode => ({ kind: "file", name, lines, ...(note === undefined ? {} : { note }) });
const link = (name: string, target: string): TreeNode => ({ kind: "link", name, target });
const bgRows = (out: string): string[] => out.split("\n").filter((l) => l.includes(BG));

describe("rendu stylé d'un arbre : structure", () => {
  const tree = dir("d", [dir("x", [file("a.ts", ["const a = 1;", "const b = 2;"])]), link("lien", "z.txt"), file("z.txt", ["z"])]);

  it("noms, branches, contenu à la colonne du nom ; numéros de ligne par fichier", async () => {
    expect(plain(await renderTreeStyled([tree], opts()))).toBe(
      ["d", "├── x", "│   └── a.ts", "│       1 │ const a = 1;", "│       2 │ const b = 2;", "├── lien", "│   -> z.txt", "└── z.txt", "    1 │ z", ""].join("\n"),
    );
  });

  it("fond uniquement sur le code, à partir de la colonne du nom, jusqu'au bord ; noms et liens sans fond", async () => {
    const out = await renderTreeStyled([tree], opts());
    const rows = bgRows(out);
    expect(rows.map((r) => strip(r.slice(0, r.indexOf(BG))))).toEqual(["│       ", "│       ", "    "]);
    for (const r of rows) expect(r.endsWith(EOL)).toBe(true);
    for (const l of out.split("\n").filter((x) => !x.includes(BG))) expect(l).not.toContain("48;2;");
    expect(out.startsWith("\x1b[1md\x1b[0m\n")).toBe(true); // racine en gras
  });

  it("racines multiples : jointes par un retour à la ligne, racine absente = rien ; aucune racine = rien", async () => {
    const out = await renderTreeStyled([file("a.ts", ["x"]), null, file("b.ts", ["y"])], opts());
    expect(plain(out).split("\n")).toEqual(["a.ts", "1 │ x", "", "", "b.ts", "1 │ y", ""]);
    expect(await renderTreeStyled([], opts())).toBe("");
  });

  it("niveau 0 : le texte de l'arbre, sans couleur", async () => {
    expect(await renderTreeStyled([tree, null, link("l", "t")], opts({ level: 0 }))).toBe(`${treeText(tree)}\n\n${treeText(link("l", "t"))}`);
  });
});

describe("rendu stylé d'un arbre : racines et marqueurs", () => {
  it("racine fichier : contenu en colonne 0, fond dès le premier caractère ; racine lien ; marqueurs discrets", async () => {
    const f = await renderTreeStyled([file("f.ts", ["x"])], opts());
    expect(bgRows(f)[0].startsWith(BG)).toBe(true);
    expect(plain(f)).toBe("f.ts\n1 │ x\n");
    expect(plain(await renderTreeStyled([link("ln", "cible")], opts()))).toBe("ln\n-> cible\n");
    expect(plain(await renderTreeStyled([file("u", [], "unreadable")], opts()))).toBe("u\n[unreadable]\n");
    const d = await renderTreeStyled([dir("d", [file("o.txt", [], "output file"), link("l", "t"), file("p", [], "unreadable")])], opts());
    expect(plain(d)).toBe("d\n├── o.txt\n│   [output file]\n├── l\n│   -> t\n└── p\n    [unreadable]\n");
    expect(bgRows(d)).toHaveLength(0);
  });

  it("dossier vide, fichier vide : le nom seul", async () => {
    expect(plain(await renderTreeStyled([dir("d", [dir("vide", []), file("vide.txt", [])])], opts()))).toBe("d\n├── vide\n└── vide.txt\n");
    expect(plain(await renderTreeStyled([dir("d", [])], opts()))).toBe("d\n");
  });

  it("langue du code déduite du nom du fichier", async () => {
    const langs: string[] = [];
    const spy: Highlighter = async (code, lang) => {
      langs.push(lang);
      return code.split("\n");
    };
    await renderTreeStyled([dir("d", [file("a.ts", ["x"]), file("Dockerfile", ["y"]), file("n.txt", ["z"])])], opts({ highlighter: spy }));
    expect(langs).toEqual(["typescript", "dockerfile", "text"]);
  });

  it("fond réglable (FLS_BG) ; largeur : les lignes longues sont repliées, le préfixe de l'arbre repris", async () => {
    expect(await renderTreeStyled([file("a", ["x"])], opts({ bg: [1, 2, 3] }))).toContain("\x1b[48;2;1;2;3m");
    const out = await renderTreeStyled([dir("d", [dir("s", [file("a.ts", ["x".repeat(80)])]), file("z", ["z"])])], opts({ columns: 40 }));
    const rows = bgRows(out);
    const prefixes = rows.map((r) => strip(r.slice(0, r.indexOf(BG))));
    expect(rows.length).toBeGreaterThan(3);
    expect(new Set(prefixes.slice(0, -1))).toEqual(new Set(["│       "])); // le préfixe est repris sur chaque ligne visuelle
    for (const r of rows) expect([...strip(r)].length).toBeLessThanOrEqual(39);
  });

  it("un highlighter en erreur laisse le code lisible, numéroté et sur fond", async () => {
    const boom: Highlighter = async () => {
      throw new Error("boom");
    };
    const out = await renderTreeStyled([file("a.ts", ["un", "deux"])], opts({ highlighter: boom }));
    expect(bgRows(out).map(strip)).toEqual(["1 │ un", "2 │ deux"]);
  });
});

describe("régression : un fichier dont le contenu ressemble à un arbre", () => {
  // Avant, le rendu coloré reparsait le texte brut : ces lignes étaient prises pour de la structure
  // (numéros qui repartent à 1, fond interrompu, contenu sorti de son fichier).
  const lines = ["avant", "├── faux-fichier", "└── autre", "-> une-fleche", "[unreadable]", "[output file]", "après"];
  const tree = dir("d", [file("notes.md", lines), file("z.txt", ["x"])]);

  it("toutes les lignes restent le contenu du fichier : numéros continus, préfixe de l'arbre, fond partout", async () => {
    const out = await renderTreeStyled([tree], opts());
    expect(plain(out).split("\n")).toEqual([
      "d",
      "├── notes.md",
      "│   1 │ avant",
      "│   2 │ ├── faux-fichier",
      "│   3 │ └── autre",
      "│   4 │ -> une-fleche",
      "│   5 │ [unreadable]",
      "│   6 │ [output file]",
      "│   7 │ après",
      "└── z.txt",
      "    1 │ x",
      "",
    ]);
    expect(bgRows(out)).toHaveLength(8);
    for (const r of bgRows(out)) expect(r.endsWith(EOL)).toBe(true);
  });
});
