// Rendu stylé : le Rapport pour un terminal (couleurs du thème opencode, fond des contenus de
// fichier, gouttière de numéros de ligne, repli à la largeur du terminal). Part des segments
// typés : aucun texte n'est reparsé.

import { palette, wrapAnsi, type ColorLevel, type Palette, type Rgb } from "../ansi.ts";
import { langFromPath, type Highlighter } from "../highlight.ts";
import { codeBlockRows, expandTabs, highlightLines, room } from "./code-block.ts";
import { renderPlain } from "./plain.ts";
import { fileTitle, type Entry, type Hunk, type MatchRow, type ReportDoc, type Segment } from "./segments.ts";

export interface StyleOptions {
  level: ColorLevel;
  /** Largeur du terminal à respecter ; absente : aucun repli. */
  columns?: number;
  /** Fond des contenus de fichier ; absent : #141414. */
  bg?: Rgb;
  highlighter: Highlighter;
}

const statusColor = (status: Entry["status"], p: Palette): string => {
  const padded = status.padEnd(4);
  return status === "OK" ? p.ok(padded) : status === "FAIL" ? p.fail(padded) : p.skip(padded);
};

/** Lignes visuelles d'une ligne à fond, repliées à la largeur du terminal (continuation indentée). */
function bgRows(bg: Palette["bgCode"], text: string, columns: number | undefined, indent: string): string {
  return wrapAnsi(text, room(columns, 0), indent).map((row) => bg.wrap(row)).join("\n");
}

function highlightMatch(text: string, pattern: string | null, p: Palette): string {
  if (pattern === null || pattern === "") return text;
  const idx = text.indexOf(pattern);
  if (idx === -1) return text;
  return text.slice(0, idx) + p.match(text.slice(idx, idx + pattern.length)) + text.slice(idx + pattern.length);
}

function matchRow(r: MatchRow, pattern: string | null, p: Palette, columns: number | undefined): string {
  if (r.type === "sep") return p.bgCode.wrap(p.dim("--"));
  const sep = r.type === "match" ? ":" : "-";
  const content = r.type === "match" ? highlightMatch(r.text, pattern, p) : p.dim(r.text);
  return bgRows(p.bgCode, p.cyan(r.file) + p.dim(sep) + p.yellow(String(r.line)) + p.dim(sep) + " " + content, columns, "    ");
}

async function hunkRows(h: Hunk, p: Palette, o: StyleOptions): Promise<string[]> {
  const side = async (lines: string[], sign: "+" | "-"): Promise<string[]> => {
    const code = await highlightLines(lines.map((l) => expandTabs(l, 2)), "text", 2, o.highlighter);
    const bg = sign === "+" ? p.bgAdd : p.bgDel;
    return code.map((c) => bgRows(bg, (sign === "+" ? p.green("+ ") : p.red("- ")) + c, o.columns, "  "));
  };
  return [p.cyan(`@@ bloc ${h.block} (ligne ${h.line})`), ...(await side(h.removed, "-")), ...(await side(h.added, "+"))];
}

async function segmentRows(s: Segment, entry: Entry, p: Palette, o: StyleOptions): Promise<string> {
  switch (s.kind) {
    case "text":
      // un dossier lu ou un arbre brut : texte discret ; les autres textes (erreurs, notes) restent tels quels
      return entry.kind === "READ" ? s.text.split("\n").map((l) => p.dim(l)).join("\n") : s.text;
    case "omitted":
      return [p.bold(`=== ${s.path} ===`), p.dim(`[omis : ${s.code}]`), p.bold("=== fin ===")].join("\n");
    case "file": {
      const nums = s.lines.map((_, i) => s.from + i);
      const rows = await codeBlockRows(s.lines, nums, langFromPath(s.path), "", p, o.columns, o.highlighter);
      return [p.bold(`=== ${fileTitle(s)} ===`), ...rows, p.bold("=== fin ===")].join("\n");
    }
    case "matches":
      return s.rows.map((r) => matchRow(r, s.pattern, p, o.columns)).join("\n");
    case "diff":
      return (await Promise.all(s.hunks.map((h) => hunkRows(h, p, o)))).flat().join("\n");
  }
}

async function entryRows(n: number, e: Entry, p: Palette, o: StyleOptions): Promise<string> {
  const head = p.dim(`[${n}] `) + statusColor(e.status, p) + `  ${e.kind} ${e.title}${e.code === "" ? "" : ` : ${e.code}`}`;
  const body = (await Promise.all(e.body.map((s) => segmentRows(s, e, p, o)))).join("\n\n");
  return body === "" ? head : `${head}\n${body}`;
}

export async function renderStyled(doc: ReportDoc, o: StyleOptions): Promise<string> {
  if (o.level === 0) return renderPlain(doc);
  const p = palette(o.level, o.bg);
  const entries = await Promise.all(doc.entries.map((e, i) => entryRows(i + 1, e, p, o)));
  const footer = doc.footer.map((l) => p.dim(l)).join("\n");
  return `${[p.dim(doc.header), ...entries, footer].join("\n\n")}\n`;
}
