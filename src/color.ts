import { applyLineBg, palette, safeTruncate, wrapAnsi, type ColorLevel, type Palette } from "./ansi.ts";
import { FlsError } from "./errors.ts";
import { highlightCode, langFromPath } from "./highlight.ts";
import type { Args, Io } from "./types.ts";

export type ColorMode = "auto" | "always" | "never";

export interface ColorTargets {
  stdout: boolean;
  stderr: boolean;
  file: boolean;
  clip: boolean;
  level: ColorLevel;
  /** Largeur du terminal à respecter (lignes longues repliées dans le bloc) ; absente : aucun repli. */
  columns?: number;
}

const THEME = "github-dark";

export function colorMode(args: Args): ColorMode {
  if (args.flags.has("no-color")) return "never";
  if (args.flags.has("colored")) return "always";
  const v = args.values.get("color");
  if (v === undefined) return "auto";
  if (v === "auto" || v === "always" || v === "never") return v;
  throw new FlsError("usage_error", `--color attend auto|always|never (reçu : ${v})`);
}

export function resolveTargets(args: Args, io: Io): ColorTargets {
  const mode = colorMode(args);
  const noColor = io.env?.NO_COLOR !== undefined;
  const force = mode === "always";
  const off = mode === "never" || (mode === "auto" && noColor);
  const level: ColorLevel = off ? 0 : 3;
  const auto = (tty: boolean | undefined): boolean => !off && (force || (mode === "auto" && tty === true));
  const file = !off && force;
  const clip = !off && force;
  // Le repli suit la largeur du terminal : il n'a pas de sens si la sortie colorée part aussi
  // dans un fichier ou le presse-papiers.
  const otherSink = (file && args.values.has("output")) || (clip && (args.flags.has("clip") || args.flags.has("clip-out")));
  const stdout = auto(io.stdoutIsTTY);
  return {
    stdout,
    stderr: auto(io.stderrIsTTY),
    file,
    clip,
    level,
    columns: stdout && !otherSink ? io.columns : undefined,
  };
}

function pal(t: ColorTargets): Palette {
  return palette(t.level);
}

// ───────────────────────────── Rendu chrome ─────────────────────────────

function statusColor(status: string, p: Palette): string {
  if (status === "OK") return p.ok(status.padEnd(4));
  if (status === "FAIL") return p.fail(status.padEnd(4));
  if (status === "SKIP") return p.skip(status.padEnd(4));
  return p.dim(status.padEnd(4));
}

function colorResultHead(line: string, p: Palette): string {
  // [n] STATUS  KIND title : code
  const m = /^(\[\d+\] )(\S+)(\s+)(.*)$/.exec(line);
  if (m === null) return line;
  const [, n, status, sp, rest] = m;
  return p.dim(n) + statusColor(status, p) + sp + rest;
}

function highlightGrepMatch(text: string, pattern: string | null, p: Palette): string {
  if (pattern === null || pattern === "") return text;
  const idx = text.indexOf(pattern);
  if (idx === -1) return text;
  // simple single highlight; fallback chrome simple
  return text.slice(0, idx) + p.match(text.slice(idx, idx + pattern.length)) + text.slice(idx + pattern.length);
}

/** Lignes visuelles d'une ligne à fond, repliées à la largeur du terminal (continuation indentée). */
function bgRows(bg: Palette["bgCode"], text: string, columns: number | undefined, indent: string): string {
  return wrapAnsi(text, room(columns, 0), indent).map((row) => bg.wrap(row)).join("\n");
}

function colorGrepLine(line: string, p: Palette, pattern: string | null, columns: number | undefined): string {
  // fichier:ligne: match  or fichier-ligne- context  or --
  if (line === "--") return p.bgCode.wrap(p.dim(line));
  const m = /^(.+?)([:\-])(\d+)([:\-])(.*)$/.exec(line);
  if (m === null) return line;
  const [, file, a, ln, b, rest] = m;
  const isMatch = b === ":";
  const content = isMatch ? highlightGrepMatch(rest, pattern, p) : p.dim(rest);
  return bgRows(p.bgCode, p.cyan(file) + p.dim(a) + p.yellow(ln) + p.dim(b) + content, columns, "    ");
}

const TAB_WIDTH = 8;

/**
 * Remplace chaque tabulation par des espaces jusqu'au prochain taquet (8 colonnes), la ligne
 * commençant à la colonne `startCol`. Un terminal ne peint pas le fond sous une tabulation :
 * sans cela, l'indentation des fichiers indentés par tabulations resterait sans fond.
 */
export function expandTabs(line: string, startCol = 0): string {
  if (!line.includes("\t")) return line;
  let out = "";
  for (const ch of line) out += ch === "\t" ? " ".repeat(TAB_WIDTH - ((startCol + [...out].length) % TAB_WIDTH)) : ch;
  return out;
}

async function highlightBlock(rawLines: string[], lang: string, p: Palette, startCol = 0): Promise<string[]> {
  const lines = rawLines.map((l) => expandTabs(l, startCol));
  /* v8 ignore next */
  if (p.level === 0) return lines;
  const src = lines.join("\n");
  try {
    const out = await highlightCode(src, lang, THEME, p.level);
    const hl = out.split("\n");
    // shiki peut ajouter/supprimer une ligne finale vide; on aligne au mieux
    return lines.map((l, i) => (hl[i] !== undefined ? hl[i] : l));
  } catch {
    return lines;
  }
}

const GUTTER_SEP = " │ ";
const MIN_WRAP = 20;

/** Largeur disponible pour le texte d'une ligne visuelle (marge d'une colonne contre le repli du terminal). */
function room(columns: number | undefined, used: number): number {
  return columns === undefined ? Infinity : Math.max(columns - used - 1, MIN_WRAP);
}

/**
 * Bloc de code : numéro de ligne (affiché sur la première ligne visuelle seulement), puis le code,
 * replié à la largeur du terminal. `prefix` est le préfixe de l'arbre (sans fond) : le fond
 * commence à la colonne du nom de fichier.
 */
async function codeBlockRows(codes: string[], nums: number[], lang: string, prefix: string, p: Palette, columns: number | undefined): Promise<string[]> {
  /* v8 ignore next */
  if (codes.length === 0) return [];
  const gw = String(Math.max(...nums)).length;
  const startCol = prefix.length + gw + GUTTER_SEP.length;
  const hl = await highlightBlock(codes, lang, p, startCol);
  const avail = room(columns, startCol);
  return hl.flatMap((line, i) =>
    wrapAnsi(line, avail).map((part, k) => {
      const num = k === 0 ? String(nums[i]).padStart(gw) : " ".repeat(gw);
      return p.dim(prefix) + p.bgCode.wrap(p.dim(num + GUTTER_SEP) + part);
    }),
  );
}

async function colorReadBody(body: string, p: Palette, columns: number | undefined): Promise<string> {
  /* v8 ignore next */
  if (p.level === 0) return body;
  // blocs === path (...) === ... === fin ===
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^=== (.+?)(?: \(([^)]+)\))? ===$/.exec(lines[i]);
    if (m !== null && !lines[i].startsWith("=== fin ===")) {
      out.push(p.bold(lines[i]));
      i += 1;
      const content: string[] = [];
      while (i < lines.length && lines[i] !== "=== fin ===") {
        content.push(lines[i]);
        i += 1;
      }
      if (content.length === 1 && /^\[omis : .+\]$/.test(content[0])) out.push(p.dim(content[0]));
      else {
        const first = Number(/^lignes (\d+)-/.exec(m[2] ?? "")?.[1] ?? 1);
        // --line-numbers : "  1 | code" ; sinon, numérotation à partir de la première ligne lue
        const numbered = content.length > 0 && /^\s*\d+ \| /.test(content[0]);
        const nums: number[] = [];
        const codes: string[] = [];
        content.forEach((l, k) => {
          const pm = numbered ? /^\s*(\d+) \| (.*)$/.exec(l) : null;
          nums.push(pm !== null ? Number(pm[1]) : (nums[k - 1] ?? first - 1) + 1);
          codes.push(pm !== null ? pm[2] : l);
        });
        out.push(...(await codeBlockRows(codes, nums, langFromPath(m[1]), "", p, columns)));
      }
      if (i < lines.length && lines[i] === "=== fin ===") { out.push(p.bold(lines[i])); i += 1; }
      continue;
    }
    out.push(p.dim(lines[i]));
    i += 1;
  }
  return out.join("\n");
}

async function colorEditBody(body: string, p: Palette, columns: number | undefined): Promise<string> {
  /* v8 ignore next */
  if (p.level === 0) return body;
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("@@")) { out.push(p.cyan(lines[i])); i += 1; continue; }
    if (lines[i].startsWith("+ ") || lines[i].startsWith("- ")) {
      const sign = lines[i][0] as "+" | "-";
      const bg = sign === "+" ? p.bgAdd : p.bgDel;
      const chunk: string[] = [];
      while (i < lines.length && lines[i].startsWith(`${sign} `)) { chunk.push(expandTabs(lines[i].slice(2), 2)); i += 1; }
      let hl: string[];
      try {
        const raw = await highlightCode(chunk.join("\n"), "text", THEME, p.level);
        hl = raw.split("\n");
      } catch { hl = chunk; }
      for (let k = 0; k < chunk.length; k++) {
        const code = hl[k] ?? chunk[k];
        out.push(bgRows(bg, (sign === "+" ? p.green("+ ") : p.red("- ")) + code, columns, "  "));
      }
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  return out.join("\n");
}

export async function colorizeReportText(text: string, t: ColorTargets): Promise<string> {
  if (t.level === 0) return text;
  const p = pal(t);
  // split report into blocks separated by blank lines, keep structure
  const blocks = text.split("\n\n");
  const out: string[] = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const lines = block.split("\n");
    if (bi === 0 && lines[0].startsWith("fls ")) {
      out.push(lines.map((l) => p.dim(l)).join("\n"));
      continue;
    }
    if (lines[0].startsWith("Résumé :")) {
      out.push(lines.map((l) => p.dim(l)).join("\n"));
      continue;
    }
    if (/^\[\d+\] /.test(lines[0])) {
      const head = lines[0];
      const body = lines.slice(1).join("\n");
      const headColored = colorResultHead(head, p);
      const m = /^\[\d+\] \S+\s+(\S+)\s*(.*)$/.exec(head);
      const kind = m?.[1] ?? "";
      const titleRest = m?.[2] ?? "";
      let bodyColored = body;
      if (body !== "") {
        if (kind === "READ") bodyColored = await colorReadBody(body, p, t.columns);
        else if (kind === "EDIT") bodyColored = await colorEditBody(body, p, t.columns);
        else if (kind === "GREP") {
          const pm = /^"((?:[^"\\]|\\.)*)"/.exec(titleRest);
          const pat = pm ? pm[1].replace(/\\(.)/g, "$1") : null;
          bodyColored = body.split("\n").map((l) => colorGrepLine(l, p, pat, t.columns)).join("\n");
        } else bodyColored = body;
      }
      out.push(bodyColored === "" ? headColored : `${headColored}\n${bodyColored}`);
      continue;
    }
    out.push(lines.map((l) => l).join("\n"));
  }
  return out.join("\n\n");
}

export function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  return safeTruncate(text, limit);
}

// ───────────────────────────── Tree coloré ─────────────────────────────

import type { Workspace } from "./workspace.ts";

export async function colorizeQuickTree(raw: string, _ws: Workspace, _rootRel: string, rootLabel: string, t: ColorTargets): Promise<string> {
  if (t.level === 0) return raw;
  const p = pal(t);
  // Parse simple treecat: lignes structure "prefix+connector+name" ou "prefix+content" ou racine ou "-> ..."
  // On highlight le contenu fichier par blocs.
  // Le \n final n'est pas une ligne de contenu (sinon : ligne vide avec fond en fin de sortie).
  const trailingNewline = raw.endsWith("\n");
  const lines = (trailingNewline ? raw.slice(0, -1) : raw).split("\n");
  const out: string[] = [];
  let i = 0;
  // root line
  /* v8 ignore next */
  if (i < lines.length) { out.push(p.bold(lines[i])); i += 1; }
  // We don't have full parse context; fallback: color structure vs content heuristically.
  // Heuristic: lines matching tree connectors are structure; others are content belonging to last file.
  let inFile: string | null = null;
  let fileContent: string[] = [];
  let filePrefix = "";
  const flushFile = async () => {
    if (inFile === null) return;
    const lang = langFromPath(inFile);
    // Le contenu reste à la colonne du nom de fichier (comme en sortie brute) : le préfixe de
    // l'arbre est gardé, sans fond ; le fond ne démarre qu'à la colonne du nom.
    out.push(...(await codeBlockRows(fileContent, fileContent.map((_, k) => k + 1), lang, filePrefix, p, t.columns)));
    inFile = null; fileContent = []; filePrefix = "";
  };
  while (i < lines.length) {
    const line = lines[i];
    const m = /^((?:│   |    )*)(├── |└── )(.*)$/.exec(line);
    if (m) {
      await flushFile();
      const [, prefix, conn, name] = m;
      // determine if this entry is a file or dir/link by looking ahead
      const next = lines[i + 1];
      const childPrefix = prefix + (conn === "└── " ? "    " : "│   ");
      const isDir = next !== undefined && (next.startsWith(childPrefix + "├── ") || next.startsWith(childPrefix + "└── "));
      const isLink = next !== undefined && next.startsWith(childPrefix + "-> ");
      const isSpecial = next !== undefined && (next === childPrefix + "[unreadable]" || next === childPrefix + "[output file]");
      out.push(p.dim(prefix + conn) + name);
      if (!isDir && !isLink && !isSpecial && next !== undefined && next.startsWith(childPrefix) && !next.startsWith(childPrefix + "├── ") && !next.startsWith(childPrefix + "└── ")) {
        // file content follows
        inFile = name;
        filePrefix = childPrefix;
        i += 1;
        while (i < lines.length) {
          const cl = lines[i];
          if (cl.startsWith(filePrefix) && !cl.startsWith(filePrefix + "├── ") && !cl.startsWith(filePrefix + "└── ")) {
            fileContent.push(cl.slice(filePrefix.length));
            i += 1;
          } else break;
        }
        await flushFile();
        continue;
      }
      if (isLink || isSpecial) {
        i += 1;
        /* v8 ignore next */
        if (i < lines.length) { out.push(p.dim(lines[i])); i += 1; }
        continue;
      }
      i += 1;
      continue;
    }
    // root file content or link
    if (line.startsWith("-> ") || line === "[unreadable]" || line === "[output file]") {
      await flushFile();
      out.push(p.dim(line));
      i += 1;
      continue;
    }
    // content of root file
    if (inFile !== null) { fileContent.push(line); i += 1; continue; }
    // could be root file content - treat as file content
    fileContent.push(line); inFile = rootLabel; filePrefix = ""; i += 1;
  }
  await flushFile();
  return out.join("\n") + (trailingNewline ? "\n" : "");
}
