import { describe, expect, it } from "vitest";
import { langFromPath, shikiHighlighter } from "./highlight.ts";
import type { Span } from "./style.ts";

describe("highlight", () => {
  it("langFromPath", () => {
    expect(langFromPath("foo.ts")).toBe("typescript");
    expect(langFromPath("foo.TSX")).toBe("tsx");
    expect(langFromPath("Dockerfile")).toBe("dockerfile");
    expect(langFromPath("Makefile")).toBe("makefile");
    expect(langFromPath(".gitignore")).toBe("gitignore");
    expect(langFromPath("noext")).toBe("text");
    expect(langFromPath("a/b/c.py")).toBe("python");
  });

  it("shikiHighlighter : les spans de chaque ligne de code, sans ANSI", async () => {
    const lines = await shikiHighlighter("const x = 1\nconst y = 2", "typescript");
    expect(lines.slice(0, 2).map((l) => l.map((s) => s.text).join(""))).toEqual(["const x = 1", "const y = 2"]);
    expect(lines[0]?.every((s) => s.style?.fg !== undefined)).toBe(true);
    expect(lines.flat().some((s) => s.text.includes("\x1b"))).toBe(false);
  });

  // couleur 24 bits d'un token, retrouvée par son texte exact
  const colorOf = (lines: Span[][], text: string): string | undefined => lines.flat().find((s) => s.text === text)?.style?.fg?.rgb.join(";");

  it("thème opencode : les couleurs de syntaxe de opencode (vraie coloration)", async () => {
    const lines = await shikiHighlighter("// note\nexport const x: number = 1 + f('a');\n", "typescript");
    expect(colorOf(lines, "// note")).toBe("128;128;128"); // commentaire #808080
    expect(colorOf(lines, "export")).toBe("157;124;216"); // mot-clé #9d7cd8
    expect(colorOf(lines, "const")).toBe("157;124;216");
    expect(colorOf(lines, "x")).toBe("224;108;117"); // variable #e06c75
    expect(colorOf(lines, "number")).toBe("229;192;123"); // type #e5c07b
    expect(colorOf(lines, "=")).toBe("86;182;194"); // opérateur #56b6c2
    expect(colorOf(lines, "1")).toBe("245;167;66"); // nombre #f5a742
    expect(colorOf(lines, "f")).toBe("250;178;131"); // fonction #fab283
    expect(colorOf(lines, "'a'")).toBe("127;216;143"); // chaîne #7fd88f
    expect(lines[0]?.[0]?.style?.italic).toBe(true); // commentaire en italique
    expect(lines[0]?.[0]?.style?.bold).toBe(false);
  });

  it("thème opencode : JSON, markdown et texte brut", async () => {
    const colors = (lines: Span[][]): Set<string> => new Set(lines.flat().map((s) => s.style?.fg?.rgb.join(";") as string));
    const json = colors(await shikiHighlighter('{"a": 1, "b": "x", "c": true}', "json"));
    for (const c of ["224;108;117", "245;167;66", "127;216;143"]) expect(json.has(c)).toBe(true); // clés, nombre et booléen, chaîne
    const md = colors(await shikiHighlighter("# Titre\n\nun `code` et **gras**\n", "markdown"));
    for (const c of ["157;124;216", "127;216;143", "245;167;66"]) expect(md.has(c)).toBe(true); // titre, code en ligne, gras
    expect(colors(await shikiHighlighter("rien de special", "text"))).toEqual(new Set(["238;238;238"])); // texte #eeeeee
  });

  it("un token sans couleur prend celle du thème ; gras et souligné sont repris", async () => {
    const lines = await shikiHighlighter("# T\n\n__u__ **b**", "markdown");
    const flags = lines.flat().map((s) => [s.style?.bold, s.style?.underline]);
    expect(flags.some(([b]) => b === true)).toBe(true);
  });
});
