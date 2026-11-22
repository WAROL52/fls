// Wrapper Shiki (async) : renvoie des spans (couleur, gras, italique, souligné), jamais de l'ANSI.
import { codeToTokensBase } from "shiki";
import path from "node:path";
import { hexColor, span, type Span } from "./style.ts";
import { OPENCODE_THEME } from "./theme.ts";

const BASENAMES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  ".gitignore": "gitignore",
  ".gitattributes": "gitattributes",
  ".bashrc": "bash",
  ".bash_profile": "bash",
  ".zshrc": "zsh",
  ".zprofile": "zsh",
  ".profile": "bash",
  ".env": "dotenv",
};

const EXTS: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  mdx: "mdx",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  sh: "bash",
  bash: "bash",
  zsh: "zsh",
  fish: "fish",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  php: "php",
  sql: "sql",
  xml: "xml",
  svg: "xml",
  diff: "diff",
  patch: "diff",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  txt: "text",
};

export function langFromPath(filePath: string): string {
  const base = path.posix.basename(filePath.replace(/\\/g, "/")).toLowerCase();
  const byBase = BASENAMES[base];
  if (byBase !== undefined) return byBase;
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  return EXTS[ext] ?? "text";
}

/** Coloration syntaxique : les spans de chaque ligne de `code` (texte sans style si la langue est inconnue). */
export type Highlighter = (code: string, lang: string) => Promise<Span[][]>;

// bits de `fontStyle` d'un token Shiki
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

/** Adapter réel (Shiki, thème opencode sombre). Un token sans couleur prend celle du thème. */
export const shikiHighlighter: Highlighter = async (code, lang) => {
  const lines = await codeToTokensBase(code, { lang: lang as never, theme: OPENCODE_THEME as never });
  return lines.map((line) =>
    line.flatMap((t) =>
      span(t.content, {
        fg: hexColor(t.color ?? OPENCODE_THEME.fg),
        bold: ((t.fontStyle ?? 0) & BOLD) !== 0,
        italic: ((t.fontStyle ?? 0) & ITALIC) !== 0,
        underline: ((t.fontStyle ?? 0) & UNDERLINE) !== 0,
      }),
    ),
  );
};
