import { palette, safeTruncate, type Rgb } from "./ansi.ts";
import { FlsError } from "./errors.ts";
import { langFromPath, shikiHighlighter } from "./highlight.ts";
import { codeBlockRows } from "./report/code-block.ts";
import type { StyleOptions } from "./report/styled.ts";
import type { Workspace } from "./workspace.ts";
import type { Args, Io } from "./types.ts";

export type ColorMode = "auto" | "always" | "never";

/** Quelles sorties sont colorées, et avec quelles options de rendu (largeur, fond, coloration). */
export interface ColorTargets extends StyleOptions {
  stdout: boolean;
  stderr: boolean;
  file: boolean;
  clip: boolean;
}

export function colorMode(args: Args): ColorMode {
  if (args.flags.has("no-color")) return "never";
  if (args.flags.has("colored")) return "always";
  const v = args.values.get("color");
  if (v === undefined) return "auto";
  if (v === "auto" || v === "always" || v === "never") return v;
  throw new FlsError("usage_error", `--color attend auto|always|never (reçu : ${v})`);
}

/** `FLS_BG=#rrggbb` (ou `rrggbb`) : couleur de fond des contenus, pour l'accorder au thème du terminal. */
export function parseBg(value: string | undefined): Rgb | undefined {
  if (value === undefined || value === "") return undefined;
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (m === null) throw new FlsError("usage_error", `FLS_BG attend une couleur #rrggbb (reçu : ${value})`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

export function resolveTargets(args: Args, io: Io): ColorTargets {
  const mode = colorMode(args);
  const noColor = io.env?.NO_COLOR !== undefined;
  const force = mode === "always";
  const off = mode === "never" || (mode === "auto" && noColor);
  const level = off ? 0 : 3;
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
    bg: parseBg(io.env?.FLS_BG),
    highlighter: io.highlighter ?? shikiHighlighter,
  };
}

/** Message d'erreur sur stderr : en rouge quand stderr est coloré. */
export const colorizeError = (msg: string, t: ColorTargets): string => palette(t.level, t.bg).fail(msg);

export function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  return safeTruncate(text, limit);
}

// ───────────────────────────── Tree coloré ─────────────────────────────

export async function colorizeQuickTree(raw: string, _ws: Workspace, _rootRel: string, rootLabel: string, t: ColorTargets): Promise<string> {
  if (t.level === 0) return raw;
  const p = palette(t.level, t.bg);
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
    out.push(...(await codeBlockRows(fileContent, fileContent.map((_, k) => k + 1), lang, filePrefix, p, t.columns, t.highlighter)));
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
