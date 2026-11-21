import { describe, expect, it } from "vitest";
import { highlightCode, langFromPath } from "./highlight.ts";

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

  it("highlightCode renvoie du texte", async () => {
    const out = await highlightCode("const x = 1", "typescript", "github-dark", 0);
    expect(out).toContain("const");
    const c = await highlightCode("const x = 1", "typescript", "github-dark", 3);
    expect(c).toContain("\x1b[");
  });
});
