import { FlsError } from "../errors.ts";
import { normalizeRel } from "../paths.ts";
import { blockLines, lineAt, splitLines } from "../text.ts";
import type { Ctx, Done, Op, Spec } from "../types.ts";
import { directive } from "./shared.ts";

const bigrams = (s: string): Set<string> => new Set(Array.from({ length: Math.max(s.length - 1, 0) }, (_, i) => s.slice(i, i + 2)));

function dice(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size + y.size === 0) return 0;
  let common = 0;
  for (const g of x) if (y.has(g)) common += 1;
  return (2 * common) / (x.size + y.size);
}

function closestHint(content: string, search: string): string {
  const target = search.split("\n")[0].trim();
  const lines = splitLines(content);
  let best = { score: 0, n: 0 };
  lines.forEach((l, i) => {
    const score = dice(target, l.trim());
    if (score > best.score) best = { score, n: i + 1 };
  });
  return best.score > 0 ? `ligne la plus proche (l.${best.n}) : ${JSON.stringify(lines[best.n - 1].trim())}` : "aucune ligne proche";
}

function findAll(hay: string, needle: string): number[] {
  const found: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) found.push(i);
  return found;
}

function runEdit(ctx: Ctx, op: Op): Done {
  const rel = normalizeRel(op.args[0]);
  const original = ctx.ws.text(rel);
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const all = op.opts.all === true;
  let current = original;
  let added = 0;
  let removed = 0;
  const hunks = op.edits.flatMap((ed, n) => {
    const search = ed.search.replaceAll("\n", eol);
    const found = findAll(current, search);
    if (found.length === 0) {
      throw new FlsError("not_found", `bloc ${n + 1} : SEARCH introuvable dans ${rel} (${closestHint(current, ed.search)})`);
    }
    if (!all && found.length > 1) {
      const where = found.slice(0, 5).map((p) => lineAt(current, p)).join(", ");
      throw new FlsError("ambiguous_match", `bloc ${n + 1} : SEARCH trouvé ${found.length} fois dans ${rel} (lignes ${where})`);
    }
    const replacement = ed.replace.replaceAll("\n", eol);
    const gone = blockLines(ed.search);
    const come = blockLines(ed.replace);
    let next = "";
    let cursor = 0;
    const blockHunks: { block: number; line: number; removed: string[]; added: string[] }[] = [];
    for (const at of found) {
      let end = at + search.length;
      if (replacement === "" && (at === 0 || current[at - 1] === "\n") && current.startsWith(eol, end)) end += eol.length;
      next += current.slice(cursor, at) + replacement;
      cursor = end;
      removed += gone.length;
      added += come.length;
      blockHunks.push({ block: n + 1, line: lineAt(current, at), removed: gone, added: come });
    }
    next += current.slice(cursor);
    current = next;
    return blockHunks;
  });
  ctx.ws.write(rel, Buffer.from(current, "utf8"));
  return { title: `${rel} (${op.edits.length} bloc(s), +${added} -${removed})`, body: [{ kind: "diff", hunks }] };
}

export const edit: Spec = directive({
  name: "edit",
  summary: "remplace du texte existant ; chaque SEARCH doit être trouvé exactement une fois (ou partout avec --all)",
  usage: "@edit <fichier> [--all]  puis un ou plusieurs blocs <<<<<<< SEARCH / ======= / >>>>>>> REPLACE",
  block: "edit",
  writes: true,
  options: { all: "flag" },
  optionDocs: [
    "--all : remplace toutes les occurrences de chaque SEARCH (sans ambiguous_match)",
    "REPLACE vide : supprime le texte (et la ligne entière si SEARCH couvre des lignes complètes)",
  ],
  examples: [
    "@edit src/user.ts\n<<<<<<< SEARCH\n  return { id, name }\n=======\n  return { id, name, role: \"member\" }\n>>>>>>> REPLACE",
    "@edit src/user.ts --all\n<<<<<<< SEARCH\nconsole.log($x)\n=======\nlogger.info($x)\n>>>>>>> REPLACE",
  ],
  run: runEdit,
});
