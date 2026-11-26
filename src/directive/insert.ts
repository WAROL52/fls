import { FlsError } from "../errors.ts";
import { normalizeRel } from "../paths.ts";
import { lineAt, splitLines } from "../text.ts";
import type { Ctx, Done, Op, Spec } from "../types.ts";
import { directive } from "./shared.ts";

const codepoints = (s: string): string[] => Array.from(s);

function findAll(hay: string, needle: string): number[] {
  const found: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) found.push(i);
  return found;
}

function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function lineStart(text: string, n: number): number {
  if (n <= 1) return 0;
  let line = 1;
  let i = 0;
  for (; i < text.length && line < n; i += 1) if (text[i] === "\n") line += 1;
  return i;
}

function lineCount(text: string): number {
  if (text === "") return 0;
  let n = 1;
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") n += 1;
  return n;
}

function runInsert(ctx: Ctx, op: Op): Done {
  const rel = normalizeRel(op.args[0]);
  const lineOpt = typeof op.opts.line === "string" ? op.opts.line : undefined;
  const colOpt = typeof op.opts.col === "string" ? op.opts.col : undefined;
  const eof = op.opts.eof === true;
  const before = op.opts.before;
  const after = op.opts.after;
  const all = op.opts.all === true;
  const hasBefore = before !== undefined;
  const hasAfter = after !== undefined;
  const anchorBlock = op.anchorBlock === true;

  const hasLine = lineOpt !== undefined;
  const searchInline = typeof before === "string" || typeof after === "string";
  const searchFlag = (before === true || after === true) && !hasLine && !eof;
  const lineAfter = hasLine && after === true;
  const hasSearch = searchInline || searchFlag || anchorBlock;

  if ([hasLine, eof, hasSearch].filter(Boolean).length !== 1) {
    throw new FlsError("invalid_argument", "@insert : donne exactement une ancre (--line, --eof, ou --before/--after)");
  }
  if (hasLine && before !== undefined) throw new FlsError("invalid_argument", "@insert : --before est incompatible avec --line (utilise --after pour insérer après la ligne)");
  if (eof && (hasBefore || hasAfter)) throw new FlsError("invalid_argument", "@insert : --before/--after est incompatible avec --eof");
  if (colOpt !== undefined && !hasLine) throw new FlsError("invalid_argument", "@insert : --col exige --line");
  if (colOpt !== undefined && lineAfter) throw new FlsError("invalid_argument", "@insert : --after est interdit avec --col");
  if (all && !hasSearch) throw new FlsError("invalid_argument", "@insert : --all n'est utilisable qu'avec une ancre SEARCH");
  if (hasSearch && !hasBefore && !hasAfter) throw new FlsError("invalid_argument", "@insert : ancre SEARCH exige --before ou --after");
  if (hasSearch && hasBefore && hasAfter) throw new FlsError("invalid_argument", "@insert : --before et --after sont exclusifs");
  if (searchInline && anchorBlock) throw new FlsError("invalid_argument", "@insert : utilise --before/--after texte ou un bloc SEARCH, pas les deux");
  if (searchFlag && !anchorBlock) throw new FlsError("invalid_argument", "@insert : --before/--after sans valeur exige un bloc SEARCH");

  const original = ctx.ws.text(rel);
  const eol = eolOf(original);
  const content = op.content.replaceAll("\n", eol);
  const added = splitLines(op.content);

  if (eof) {
    const out = original + content;
    ctx.ws.write(rel, Buffer.from(out, "utf8"));
    const at = original === "" ? 1 : lineCount(original) + (original.endsWith("\n") ? 1 : 0);
    return { title: `${rel} (eof, +${added.length} ligne(s))`, body: [{ kind: "diff", hunks: [{ block: 1, line: Math.max(1, at), removed: [], added }] }] };
  }

  if (hasLine) {
    const n = Number(lineOpt);
    if (!Number.isInteger(n) || n < 1) throw new FlsError("invalid_argument", `@insert : --line attend un entier >= 1 (reçu : ${lineOpt})`);
    const count = lineCount(original);
    const max = count + 1;
    if (n > max) throw new FlsError("invalid_argument", `@insert : --line ${n} hors bornes (fichier: ${count} ligne(s))`);
    const afterLine = after === true;

    if (colOpt !== undefined) {
      const c = Number(colOpt);
      if (!Number.isInteger(c) || c < 1) throw new FlsError("invalid_argument", `@insert : --col attend un entier >= 1 (reçu : ${colOpt})`);
      if (n > count) throw new FlsError("invalid_argument", `@insert : --col exige une ligne existante (ligne ${n} hors bornes)`);
      const start = lineStart(original, n);
      let end = start;
      while (end < original.length && original[end] !== "\n") end += 1;
      const lineText = original.slice(start, end);
      const chars = codepoints(lineText);
      if (c > chars.length + 1) throw new FlsError("invalid_argument", `@insert : --col ${c} hors bornes (ligne ${n}: ${chars.length} caractère(s))`);
      const idx = chars.slice(0, c - 1).join("").length;
      const out = original.slice(0, start + idx) + content + original.slice(start + idx);
      ctx.ws.write(rel, Buffer.from(out, "utf8"));
      return { title: `${rel} (ligne ${n}, col ${c}, +${added.length} ligne(s))`, body: [{ kind: "diff", hunks: [{ block: 1, line: n, removed: [], added }] }] };
    }

    let pos: number;
    if (afterLine) {
      if (n > count) pos = original.length;
      else {
        pos = lineStart(original, n);
        while (pos < original.length && original[pos] !== "\n") pos += 1;
        if (pos < original.length) pos += 1; // after eol
      }
    } else {
      pos = n > count ? original.length : lineStart(original, n);
    }
    const out = original.slice(0, pos) + content + original.slice(pos);
    ctx.ws.write(rel, Buffer.from(out, "utf8"));
    const reportLine = lineAt(out, pos);
    return { title: `${rel} (${afterLine ? "après" : "avant"} ligne ${n}, +${added.length} ligne(s))`, body: [{ kind: "diff", hunks: [{ block: 1, line: reportLine, removed: [], added }] }] };
  }

  const needleRaw = anchorBlock ? op.anchor : (typeof before === "string" ? before : (after as string));
  const needle = needleRaw.replaceAll("\n", eol);
  if (needle === "") throw new FlsError("invalid_argument", "@insert : l'ancre SEARCH ne peut pas être vide");
  const found = findAll(original, needle);
  if (found.length === 0) throw new FlsError("not_found", `ancre introuvable dans ${rel}`);
  if (!all && found.length > 1) {
    const where = found.slice(0, 5).map((p) => lineAt(original, p)).join(", ");
    throw new FlsError("ambiguous_match", `ancre trouvée ${found.length} fois dans ${rel} (lignes ${where})`);
  }
  const beforeAnchor = hasBefore;
  let out = "";
  let cursor = 0;
  const hunks: { block: number; line: number; removed: string[]; added: string[] }[] = [];
  for (const at of found) {
    const pos = beforeAnchor ? at : at + needle.length;
    out += original.slice(cursor, pos) + content;
    cursor = pos;
    hunks.push({ block: 1, line: lineAt(original, pos), removed: [], added });
  }
  out += original.slice(cursor);
  ctx.ws.write(rel, Buffer.from(out, "utf8"));
  return { title: `${rel} (${hunks.length} insertion(s), +${added.length * hunks.length} ligne(s))`, body: [{ kind: "diff", hunks }] };
}

export const insert: Spec = directive({
  name: "insert",
  summary: "insère du contenu à une position (ligne, colonne, fin de fichier, ou ancre SEARCH)",
  usage: "@insert <fichier> (--line N [--col C] [--after] | --eof | --before/--after <texte>) + bloc CONTENT",
  block: "insert",
  writes: true,
  options: { line: "value", col: "value", after: "optvalue", before: "optvalue", eof: "flag", all: "flag" },
  optionDocs: [
    "--line <N> : insère avant la ligne N (1-based) ; avec --after, insère après",
    "--col <C> : insère dans la ligne N à la colonne C (1-based, codepoints) ; exige --line",
    "--eof : insère en fin de fichier",
    '--before/--after "<texte>" : ancre SEARCH inline (unique par défaut)',
    "--before/--after + bloc SEARCH + bloc CONTENT : ancre SEARCH multi-ligne",
    "--all : applique à toutes les occurrences de l'ancre SEARCH",
  ],
  examples: [
    '@insert src/app.ts --line 1\n<<<<<<< CONTENT\nimport { x } from "./x"\n>>>>>>> END',
    '@insert src/app.ts --before "export default"\n<<<<<<< CONTENT\n// header\n>>>>>>> END',
  ],
  run: runInsert,
});
