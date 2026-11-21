import { applyLineBg, palette, safeTruncate, type ColorLevel, type Palette } from "./ansi.ts";
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
  return {
    stdout: auto(io.stdoutIsTTY),
    stderr: auto(io.stderrIsTTY),
    file: !off && force,
    clip: !off && force,
    level,
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
  if (m === null) return p.bgCode.wrap(line);
  const [, n, status, sp, rest] = m;
  return p.bgCode.wrap(p.dim(n) + statusColor(status, p) + sp + rest);
}

function highlightGrepMatch(text: string, pattern: string | null, p: Palette): string {
  if (pattern === null || pattern === "") return text;
  const idx = text.indexOf(pattern);
  if (idx === -1) return text;
  // simple single highlight; fallback chrome simple
  return text.slice(0, idx) + p.match(text.slice(idx, idx + pattern.length)) + text.slice(idx + pattern.length);
}

function colorGrepLine(line: string, p: Palette, pattern: string | null): string {
  // fichier:ligne: match  or fichier-ligne- context  or --
  if (line === "--") return p.bgCode.wrap(p.dim(line));
  const m = /^(.+?)([:\-])(\d+)([:\-])(.*)$/.exec(line);
  if (m === null) return p.bgCode.wrap(line);
  const [, file, a, ln, b, rest] = m;
  const isMatch = b === ":";
  const content = isMatch ? highlightGrepMatch(rest, pattern, p) : p.dim(rest);
  return p.bgCode.wrap(p.cyan(file) + p.dim(a) + p.yellow(ln) + p.dim(b) + content);
}

async function highlightBlock(lines: string[], lang: string, p: Palette): Promise<string[]> {
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

async function colorReadBody(body: string, p: Palette): Promise<string> {
  /* v8 ignore next */
  if (p.level === 0) return body;
  // blocs === path (...) === ... === fin ===
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^=== (.+?)(?: \([^)]+\))? ===$/.exec(lines[i]);
    if (m !== null && !lines[i].startsWith("=== fin ===")) {
      out.push(p.bgCode.wrap(p.bold(lines[i])));
      i += 1;
      const content: string[] = [];
      while (i < lines.length && lines[i] !== "=== fin ===") {
        content.push(lines[i]);
        i += 1;
      }
      const filePath = m[1];
      const lang = langFromPath(filePath);
      // line-numbers format: "  1 | code"
      const numbered = content.length > 0 && /^\s*\d+ \| /.test(content[0]);
      if (numbered) {
        const prefixes: string[] = [];
        const codes: string[] = [];
        for (const l of content) {
          const pm = /^(\s*\d+ \| )(.*)$/.exec(l);
          if (pm !== null) { prefixes.push(pm[1]); codes.push(pm[2]); }
          else { prefixes.push(""); codes.push(l); }
        }
        const hl = await highlightBlock(codes, lang, p);
        for (let k = 0; k < content.length; k++) out.push(p.bgCode.wrap(p.dim(prefixes[k]) + hl[k]));
      } else {
        const hl = await highlightBlock(content, lang, p);
        out.push(...hl.map((l) => p.bgCode.wrap(l)));
      }
      if (i < lines.length && lines[i] === "=== fin ===") { out.push(p.bgCode.wrap(p.bold(lines[i]))); i += 1; }
      continue;
    }
    out.push(p.bgCode.wrap(p.dim(lines[i])));
    i += 1;
  }
  return out.join("\n");
}

async function colorEditBody(body: string, p: Palette): Promise<string> {
  /* v8 ignore next */
  if (p.level === 0) return body;
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith("@@")) { out.push(p.bgCode.wrap(p.cyan(lines[i]))); i += 1; continue; }
    if (lines[i].startsWith("+ ") || lines[i].startsWith("- ")) {
      const sign = lines[i][0] as "+" | "-";
      const bg = sign === "+" ? p.bgAdd : p.bgDel;
      const chunk: string[] = [];
      while (i < lines.length && lines[i].startsWith(`${sign} `)) { chunk.push(lines[i].slice(2)); i += 1; }
      let hl: string[];
      try {
        const raw = await highlightCode(chunk.join("\n"), "text", THEME, p.level);
        hl = raw.split("\n");
      } catch { hl = chunk; }
      for (let k = 0; k < chunk.length; k++) {
        const code = hl[k] ?? chunk[k];
        out.push(bg.wrap((sign === "+" ? p.green("+ ") : p.red("- ")) + code));
      }
      continue;
    }
    out.push(p.bgCode.wrap(lines[i]));
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
      out.push(lines.map((l) => p.bgCode.wrap(p.dim(l))).join("\n"));
      continue;
    }
    if (lines[0].startsWith("Résumé :")) {
      out.push(lines.map((l) => p.bgCode.wrap(p.dim(l))).join("\n"));
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
        if (kind === "READ") bodyColored = await colorReadBody(body, p);
        else if (kind === "EDIT") bodyColored = await colorEditBody(body, p);
        else if (kind === "GREP") {
          const pm = /^"((?:[^"\\]|\\.)*)"/.exec(titleRest);
          const pat = pm ? pm[1].replace(/\\(.)/g, "$1") : null;
          bodyColored = body.split("\n").map((l) => colorGrepLine(l, p, pat)).join("\n");
        } else bodyColored = body.split("\n").map((l) => p.bgCode.wrap(l)).join("\n");
      }
      out.push(bodyColored === "" ? headColored : `${headColored}\n${bodyColored}`);
      continue;
    }
    out.push(lines.map((l) => p.bgCode.wrap(l)).join("\n"));
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
  const lines = raw.split("\n");
  const out: string[] = [];
  let i = 0;
  // root line
  /* v8 ignore next */
  if (i < lines.length) { out.push(p.bgCode.wrap(p.bold(lines[i]))); i += 1; }
  // We don't have full parse context; fallback: color structure vs content heuristically.
  // Heuristic: lines matching tree connectors are structure; others are content belonging to last file.
  let inFile: string | null = null;
  let fileContent: string[] = [];
  let filePrefix = "";
  const flushFile = async () => {
    if (inFile === null) return;
    const lang = langFromPath(inFile);
    const hl = await highlightBlock(fileContent, lang, p);
    for (const l of hl) out.push(p.bgCode.wrap(l));
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
      out.push(p.bgCode.wrap(p.dim(prefix + conn) + name));
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
        if (i < lines.length) { out.push(p.bgCode.wrap(p.dim(lines[i]))); i += 1; }
        continue;
      }
      i += 1;
      continue;
    }
    // root file content or link
    if (line.startsWith("-> ") || line === "[unreadable]" || line === "[output file]") {
      await flushFile();
      out.push(p.bgCode.wrap(p.dim(line)));
      i += 1;
      continue;
    }
    // content of root file
    if (inFile !== null) { fileContent.push(line); i += 1; continue; }
    // could be root file content - treat as file content
    fileContent.push(line); inFile = rootLabel; filePrefix = ""; i += 1;
  }
  await flushFile();
  return out.join("\n");
}
