// Rendu stylé : le Rapport pour un terminal, en lignes stylées (couleurs du thème opencode, fond des
// contenus de fichier, gouttière de numéros de ligne, repli à la largeur du terminal). Part des
// segments typés : aucun texte n'est reparsé et aucune séquence ANSI n'est écrite ici (`toAnsi`).

import type { Highlighter } from "../highlight.ts";
import { langFromPath } from "../highlight.ts";
import { lineText, palette, span, textLines, wrapSpans, type Color, type Line, type Palette, type Rgb, type Span } from "../style.ts";
import { codeBlockRows, expandTabs, highlightLines, room } from "./code-block.ts";
import { fileTitle, type Entry, type Hunk, type MatchRow, type ReportDoc, type Segment } from "./segments.ts";

export interface StyleOptions {
  /** Largeur du terminal à respecter ; absente : aucun repli. */
  columns?: number;
  /** Fond des contenus de fichier ; absent : #141414. */
  bg?: Rgb;
  highlighter: Highlighter;
}

const empty: Line = { spans: [] };

/** Des blocs séparés par une ligne vide ; un bloc sans ligne compte pour une ligne vide. */
export function joinBlocks(blocks: Line[][]): Line[] {
  return blocks.flatMap((b, i) => [...(i === 0 ? [] : [empty]), ...(b.length === 0 ? [empty] : b)]);
}

const statusStyle = (status: Entry["status"], p: Palette) => (status === "OK" ? p.ok : status === "FAIL" ? p.fail : p.skip);

/** Lignes visuelles d'une ligne à fond, repliées à la largeur du terminal (continuation indentée). */
function bgRows(bg: Color, spans: Span[], columns: number | undefined, indent: string): Line[] {
  return wrapSpans(spans, room(columns, 0), indent).map((row) => ({ spans: row, bg }));
}

function highlightMatch(text: string, pattern: string | null, p: Palette): Span[] {
  const idx = pattern === null || pattern === "" ? -1 : text.indexOf(pattern);
  if (pattern === null || idx === -1) return span(text);
  return [...span(text.slice(0, idx)), ...span(text.slice(idx, idx + pattern.length), p.match), ...span(text.slice(idx + pattern.length))];
}

function matchRow(r: MatchRow, pattern: string | null, p: Palette, columns: number | undefined): Line[] {
  if (r.type === "sep") return [{ spans: span("--", p.dim), bg: p.bgCode }];
  const sep = r.type === "match" ? ":" : "-";
  const content = r.type === "match" ? highlightMatch(r.text, pattern, p) : span(r.text, p.dim);
  const spans = [...span(r.file, p.cyan), ...span(sep, p.dim), ...span(String(r.line), p.yellow), ...span(sep, p.dim), ...span(" "), ...content];
  return bgRows(p.bgCode, spans, columns, "    ");
}

async function hunkRows(h: Hunk, p: Palette, o: StyleOptions): Promise<Line[]> {
  const side = async (lines: string[], sign: "+" | "-"): Promise<Line[]> => {
    const code = await highlightLines(lines.map((l) => expandTabs(l, 2)), "text", 2, o.highlighter);
    const bg = sign === "+" ? p.bgAdd : p.bgDel;
    const mark = sign === "+" ? span("+ ", p.green) : span("- ", p.red);
    return code.flatMap((c) => bgRows(bg, [...mark, ...c], o.columns, "  "));
  };
  const where = h.file === undefined ? `ligne ${h.line}` : `${h.file}:${h.line}`;
  return [{ spans: span(`@@ bloc ${h.block} (${where})`, p.cyan) }, ...(await side(h.removed, "-")), ...(await side(h.added, "+"))];
}

async function segmentRows(s: Segment, entry: Entry, p: Palette, o: StyleOptions): Promise<Line[]> {
  switch (s.kind) {
    case "text":
      // un dossier lu ou un arbre brut : texte discret ; les autres textes (erreurs, notes) restent tels quels
      return entry.kind === "READ" ? textLines(s.text, p.dim) : textLines(s.text);
    case "omitted":
      return [{ spans: span(`=== ${s.path} ===`, p.bold) }, { spans: span(`[omis : ${s.code}]`, p.dim) }, { spans: span("=== fin ===", p.bold) }];
    case "file": {
      const nums = s.lines.map((_, i) => s.from + i);
      const rows = await codeBlockRows(s.lines, nums, langFromPath(s.path), "", p, o.columns, o.highlighter);
      return [{ spans: span(`=== ${fileTitle(s)} ===`, p.bold) }, ...rows, { spans: span("=== fin ===", p.bold) }];
    }
    case "matches":
      return s.rows.flatMap((r) => matchRow(r, s.pattern, p, o.columns));
    case "diff":
      return (await Promise.all(s.hunks.map((h) => hunkRows(h, p, o)))).flat();
  }
}

async function entryRows(n: number, e: Entry, p: Palette, o: StyleOptions): Promise<Line[]> {
  const head: Line = {
    spans: [...span(`[${n}] `, p.dim), ...span(e.status.padEnd(4), statusStyle(e.status, p)), ...span(`  ${e.kind} ${e.title}${e.code === "" ? "" : ` : ${e.code}`}`)],
  };
  const blocks = await Promise.all(e.body.map((s) => segmentRows(s, e, p, o)));
  // un corps sans aucun contenu (aucun segment, ou un seul segment vide) n'ajoute rien à l'en-tête
  const none = blocks.length === 0 || (blocks.length === 1 && (blocks[0] as Line[]).map(lineText).join("\n") === "");
  return none ? [head] : [head, ...joinBlocks(blocks)];
}

/** Le Rapport en lignes stylées ; la dernière ligne, vide, termine la sortie par un retour à la ligne. */
export async function renderStyled(doc: ReportDoc, o: StyleOptions): Promise<Line[]> {
  const p = palette(o.bg);
  const entries = await Promise.all(doc.entries.map((e, i) => entryRows(i + 1, e, p, o)));
  const footer = doc.footer.map((l): Line => ({ spans: span(l, p.dim) }));
  return [...joinBlocks([[{ spans: span(doc.header, p.dim) }], ...entries, footer]), empty];
}
