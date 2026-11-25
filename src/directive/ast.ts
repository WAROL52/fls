// Intégration ast-grep : recherche structurelle et réécriture.
//
// ast-grep calcule (patterns, matches, remplacements) ; fls valide les chemins et écrit
// via le Workspace, ce qui conserve dry-run, journal, undo et confinement.

import * as fs from "node:fs";
import * as path from "node:path";
import { FlsError } from "../errors.ts";
import { normalizeRel } from "../paths.ts";
import { splitLines } from "../text.ts";
import type { MatchRow } from "../report/segments.ts";
import type { Ctx, Op } from "../types.ts";

const MIN_VERSION = [0, 51, 0] as const;
const INSTALL = "npm i -g @ast-grep/cli (ou cargo install ast-grep --locked, brew install ast-grep)";

export interface AstRange {
  byteOffset: { start: number; end: number };
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export interface AstMatch {
  text: string;
  file: string;
  range: AstRange;
  replacement?: string;
  replacementOffsets?: { start: number; end: number };
  language?: string;
}

export interface CheckedMatch extends AstMatch {
  /** Chemin normalisé, relatif au dossier courant. */
  rel: string;
}

/** Langages courants : l'extension suffit pour un fichier unique ; un dossier exige --lang. */
const LANGS: Record<string, string> = {
  ".ts": "ts",
  ".cts": "ts",
  ".mts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".css": "css",
  ".json": "json",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".rb": "ruby",
  ".php": "php",
  ".sh": "bash",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".md": "markdown",
  ".lua": "lua",
  ".cs": "csharp",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".scala": "scala",
  ".ex": "elixir",
  ".exs": "elixir",
  ".hs": "haskell",
  ".sol": "solidity",
  ".zig": "zig",
  ".dart": "dart",
  ".nix": "nix",
  ".tf": "hcl",
};

export function inferLang(rel: string): string | null {
  return LANGS[path.extname(rel).toLowerCase()] ?? null;
}

export function parseAstGrepVersion(output: string): [number, number, number] | null {
  const m = /ast-grep\s+(\d+)\.(\d+)\.(\d+)/.exec(output.trim());
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function versionAtLeast(v: readonly [number, number, number], min: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** FLS_AST_GREP, puis node_modules/.bin/ast-grep, puis ast-grep du PATH. Jamais `sg` (shadow-utils). */
export function astGrepCandidates(ctx: Ctx): string[] {
  const env = ctx.env.FLS_AST_GREP;
  const local = path.join(ctx.ws.root, "node_modules", ".bin", "ast-grep");
  return [...(env === undefined || env === "" ? [] : [env]), ...(isExecutable(local) ? [local] : []), "ast-grep"];
}

export function resolveAstGrep(ctx: Ctx): string {
  for (const bin of astGrepCandidates(ctx)) {
    const r = ctx.runner.exec(bin, ["--version"], { cwd: ctx.ws.root, env: ctx.env });
    if (r.status !== 0) continue;
    const v = parseAstGrepVersion(r.stdout);
    if (v === null) throw new FlsError("ast_grep_version", `version d'ast-grep illisible : ${r.stdout.trim()}`);
    if (!versionAtLeast(v, MIN_VERSION)) {
      throw new FlsError("ast_grep_version", `ast-grep ${v.join(".")} trop ancien (minimum ${MIN_VERSION.join(".")})`);
    }
    return bin;
  }
  throw new FlsError("ast_grep_unavailable", `ast-grep introuvable : ${INSTALL}`);
}

/** Chemin et langage d'une directive AST : --lang, ou extension pour un fichier unique. */
export function astPath(ctx: Ctx, op: Op): { rel: string; lang: string | null } {
  const rel = normalizeRel(op.args[1] ?? ".");
  const kind = ctx.ws.kind(rel);
  if (kind === null) throw new FlsError("not_found", `introuvable : ${rel === "" ? "." : rel}`);
  if (kind === "link") throw new FlsError("symlink", `${rel} est un lien symbolique (non suivi)`);
  const langOpt = op.opts.lang;
  if (typeof langOpt === "string") {
    if (langOpt === "") throw new FlsError("invalid_argument", "--lang ne peut pas être vide");
    return { rel, lang: langOpt === "auto" ? null : langOpt };
  }
  if (kind === "dir") throw new FlsError("ast_grep_lang_required", `--lang est requis pour ${rel === "" ? "." : rel} (langage non déduit)`);
  const ext = path.extname(rel).toLowerCase();
  // HTML : laisser ast-grep déduire pour profiter des injections JS/CSS intégrées.
  if (ext === ".html" || ext === ".htm") return { rel, lang: null };
  const lang = inferLang(rel);
  if (lang === null) throw new FlsError("ast_grep_lang_required", `--lang est requis pour ${rel} (extension inconnue)`);
  return { rel, lang };
}

export function parseAstGrepJson(stdout: string): AstMatch[] {
  const matches: AstMatch[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new FlsError("ast_grep_failed", `sortie JSON d'ast-grep illisible : ${line.slice(0, 120)}`);
    }
    if (typeof raw !== "object" || raw === null) throw new FlsError("ast_grep_failed", "match ast-grep invalide");
    const m = raw as Partial<AstMatch>;
    const range = m.range as Partial<AstRange> | undefined;
    if (
      typeof m.file !== "string" ||
      typeof m.text !== "string" ||
      range === undefined ||
      typeof range.byteOffset?.start !== "number" ||
      typeof range.byteOffset.end !== "number" ||
      typeof range.start?.line !== "number" ||
      typeof range.end?.line !== "number"
    ) {
      throw new FlsError("ast_grep_failed", "match ast-grep incomplet (file, text, range)");
    }
    matches.push(m as AstMatch);
  }
  return matches;
}

/** Exécute ast-grep et renvoie les matches ; `rewrite` non nul ajoute `--rewrite`. */
export function runAstGrep(ctx: Ctx, op: Op, rewrite: string | null): AstMatch[] {
  const { rel, lang } = astPath(ctx, op);
  const bin = resolveAstGrep(ctx);
  const args = ["run", "--pattern", op.args[0], "--json=stream", "--color", "never"];
  if (lang !== null) args.push("--lang", lang);
  if (rewrite !== null) args.push("--rewrite", rewrite);
  args.push("--", rel === "" ? "." : rel);
  const r = ctx.runner.exec(bin, args, { cwd: ctx.ws.root, env: ctx.env });
  if (r.status === null) throw new FlsError("ast_grep_failed", `impossible d'exécuter ast-grep : ${r.stderr.trim()}`);
  if (r.status > 1) {
    const detail = r.stderr
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "" && !l.startsWith("[warn]"))
      .join("\n");
    throw new FlsError("ast_grep_failed", detail === "" ? `ast-grep a échoué (code ${r.status})` : detail);
  }
  if (r.stderr.includes("Pattern contains an ERROR node")) {
    throw new FlsError("ast_grep_failed", `motif refusé par ast-grep (nœud ERROR) : ${op.args[0]}`);
  }
  return parseAstGrepJson(r.stdout);
}

/** Valide les chemins renvoyés par ast-grep et applique les règles d'ignore de fls. */
export function checkMatches(ctx: Ctx, matches: AstMatch[]): CheckedMatch[] {
  const kept: CheckedMatch[] = [];
  for (const m of matches) {
    const rel = normalizeRel(m.file);
    if (ctx.ignore(rel, false)) continue;
    const kind = ctx.ws.kind(rel);
    if (kind === null) throw new FlsError("not_found", `ast-grep a renvoyé un fichier introuvable : ${m.file}`);
    if (kind === "link") throw new FlsError("symlink", `ast-grep a renvoyé un lien symbolique : ${m.file}`);
    if (kind === "dir") throw new FlsError("is_directory", `ast-grep a renvoyé un dossier : ${m.file}`);
    if (ctx.ws.changes.has(rel)) {
      throw new FlsError("ast_grep_stale", `${rel} a été modifié plus tôt dans ce script ; ast-grep lit le disque, relance fls`);
    }
    const buf = ctx.ws.bytes(rel);
    const off = m.range.byteOffset;
    if (off.start < 0 || off.end > buf.length || off.start > off.end) {
      throw new FlsError("ast_grep_failed", `offsets invalides pour ${m.file}:${m.range.start.line + 1}`);
    }
    if (!buf.subarray(off.start, off.end).equals(Buffer.from(m.text, "utf8"))) {
      throw new FlsError("conflict", `${m.file} a changé pendant l'exécution d'ast-grep ; relance fls`);
    }
    kept.push({ ...m, rel });
  }
  kept.sort((a, b) => a.rel.localeCompare(b.rel) || a.range.byteOffset.start - b.range.byteOffset.start);
  return kept;
}

/** Lignes de match et de contexte, groupées par fichier, avec séparateurs entre zones disjointes. */
export function matchRows(ctx: Ctx, matches: CheckedMatch[], context: number): MatchRow[] {
  const byFile = new Map<string, CheckedMatch[]>();
  for (const m of matches) {
    const list = byFile.get(m.rel) ?? [];
    list.push(m);
    byFile.set(m.rel, list);
  }
  const rows: MatchRow[] = [];
  for (const [rel, list] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    const lines = splitLines(ctx.ws.text(rel));
    const keep = new Map<number, "match" | "context">();
    for (const m of list) {
      const start = Math.max(0, m.range.start.line - context);
      const end = Math.min(lines.length - 1, m.range.end.line + context);
      for (let i = start; i <= end; i++) {
        const type = i >= m.range.start.line && i <= m.range.end.line ? "match" : "context";
        if (type === "match" || !keep.has(i)) keep.set(i, type);
      }
    }
    let prev = -2;
    for (const i of [...keep.keys()].sort((a, b) => a - b)) {
      if (rows.length > 0 && i !== prev + 1) rows.push({ type: "sep" });
      rows.push({ type: keep.get(i) as "match" | "context", file: rel, line: i + 1, text: lines[i] });
      prev = i;
    }
  }
  return rows;
}

export interface AppliedEdit {
  rel: string;
  line: number;
  removed: string[];
  added: string[];
}

/** Applique les remplacements dans l'ordre décroissant des offsets UTF-8, puis écrit via le Workspace. */
export function applyAstEdits(ctx: Ctx, matches: CheckedMatch[]): { files: string[]; hunks: AppliedEdit[] } {
  const byFile = new Map<string, CheckedMatch[]>();
  for (const m of matches) {
    if (m.replacement === undefined) {
      throw new FlsError("ast_grep_failed", `ast-grep n'a pas fourni de remplacement pour ${m.file}:${m.range.start.line + 1}`);
    }
    const list = byFile.get(m.rel) ?? [];
    list.push(m);
    byFile.set(m.rel, list);
  }
  const pending: Array<{ rel: string; buf: Buffer }> = [];
  const hunks: AppliedEdit[] = [];
  for (const [rel, list] of byFile) {
    const original = ctx.ws.bytes(rel);
    list.sort((a, b) => b.range.byteOffset.start - a.range.byteOffset.start);
    let buf = original;
    let lastStart = original.length + 1;
    const fileHunks: AppliedEdit[] = [];
    for (const m of list) {
      const off = m.replacementOffsets ?? m.range.byteOffset;
      if (off.start < 0 || off.end > original.length || off.start > off.end) {
        throw new FlsError("ast_grep_failed", `offsets invalides pour ${rel}:${m.range.start.line + 1}`);
      }
      if (off.end > lastStart) throw new FlsError("ast_grep_failed", `remplacements qui se chevauchent dans ${rel}`);
      buf = Buffer.concat([buf.subarray(0, off.start), Buffer.from(m.replacement as string, "utf8"), buf.subarray(off.end)]);
      lastStart = off.start;
      fileHunks.push({ rel, line: m.range.start.line + 1, removed: splitLines(m.text), added: splitLines(m.replacement as string) });
    }
    if (!buf.equals(original)) {
      pending.push({ rel, buf });
      hunks.push(...fileHunks);
    }
  }
  for (const { rel, buf } of pending) ctx.ws.write(rel, buf);
  hunks.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
  return { files: pending.map((p) => p.rel), hunks };
}
