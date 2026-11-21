import { describe, expect, it } from "vitest";
import { langFromPath, shikiHighlighter } from "./highlight.ts";

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

  it("shikiHighlighter : une chaîne ANSI par ligne de code", async () => {
    const lines = await shikiHighlighter("const x = 1\nconst y = 2", "typescript");
    expect(lines.slice(0, 2).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))).toEqual(["const x = 1", "const y = 2"]);
    expect(lines[0]).toContain("\x1b[");
  });

  it("thème opencode : les couleurs de syntaxe de opencode (vraie coloration)", async () => {
    const out = (await shikiHighlighter("// note\nexport const x: number = 1 + f('a');\n", "typescript")).join("\n");
    const colorOf = (text: string): string | undefined => new RegExp(`\\x1b\\[38;2;(\\d+;\\d+;\\d+)m${text.replace(/[/'+]/g, "\\$&")}\\x1b\\[39m`).exec(out)?.[1];
    expect(colorOf("// note")).toBe("128;128;128"); // commentaire #808080
    expect(colorOf("export")).toBe("157;124;216"); // mot-clé #9d7cd8
    expect(colorOf("const")).toBe("157;124;216");
    expect(colorOf("x")).toBe("224;108;117"); // variable #e06c75
    expect(colorOf("number")).toBe("229;192;123"); // type #e5c07b
    expect(colorOf("=")).toBe("86;182;194"); // opérateur #56b6c2
    expect(colorOf("1")).toBe("245;167;66"); // nombre #f5a742
    expect(colorOf("f")).toBe("250;178;131"); // fonction #fab283
    expect(colorOf("'a'")).toBe("127;216;143"); // chaîne #7fd88f
    expect(out).toContain("\x1b[3m"); // commentaire en italique
  });

  it("thème opencode : JSON, markdown et texte brut", async () => {
    const json = (await shikiHighlighter('{"a": 1, "b": "x", "c": true}', "json")).join("\n");
    expect(json).toContain("38;2;224;108;117"); // clés
    expect(json).toContain("38;2;245;167;66"); // nombre et booléen
    expect(json).toContain("38;2;127;216;143"); // chaîne
    const md = (await shikiHighlighter("# Titre\n\nun `code` et **gras**\n", "markdown")).join("\n");
    expect(md).toContain("38;2;157;124;216"); // titre
    expect(md).toContain("38;2;127;216;143"); // code en ligne
    expect(md).toContain("38;2;245;167;66"); // gras
    const text = (await shikiHighlighter("rien de special", "text")).join("\n");
    expect(text).toContain("38;2;238;238;238"); // texte #eeeeee
  });
});
