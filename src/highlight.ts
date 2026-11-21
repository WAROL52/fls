// Wrapper Shiki (async). Isolé pour faciliter les tests (mock du module).
import { codeToANSI } from "@shikijs/cli";
import path from "node:path";

export type ColorLevel = 0 | 1 | 2 | 3;

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

/** `theme` : nom d'un thème Shiki, ou un objet thème (ex. `OPENCODE_THEME`). */
export async function highlightCode(code: string, lang: string, theme: unknown, colorLevel: ColorLevel): Promise<string> {
  return codeToANSI(code, lang as never, theme as never, { colorLevel });
}
