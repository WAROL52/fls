import { FlsError } from "../errors.ts";
import { normalizeRel } from "../paths.ts";
import { blockLines, lineAt, splitLines } from "../text.ts";
import type { Ctx, Op, Spec } from "../types.ts";
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

function runEdit(ctx: Ctx, op: Op): { title: string; body: string } {
  const rel = normalizeRel(op.args[0]);
  const original = ctx.ws.text(rel);
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  let current = original;
  let added = 0;
  let removed = 0;
  const diff = op.edits.flatMap((ed, n) => {
    const search = ed.search.replaceAll("\n", eol);
    const found = findAll(current, search);
    if (found.length === 0) {
      throw new FlsError("not_found", `bloc ${n + 1} : SEARCH introuvable dans ${rel} (${closestHint(current, ed.search)})`);
    }
    if (found.length > 1) {
      const where = found.slice(0, 5).map((p) => lineAt(current, p)).join(", ");
      throw new FlsError("ambiguous_match", `bloc ${n + 1} : SEARCH trouvé ${found.length} fois dans ${rel} (lignes ${where})`);
    }
    const at = found[0];
    const replacement = ed.replace.replaceAll("\n", eol);
    let end = at + search.length;
    if (replacement === "" && (at === 0 || current[at - 1] === "\n") && current.startsWith(eol, end)) end += eol.length;
    const line = lineAt(current, at);
    current = current.slice(0, at) + replacement + current.slice(end);
    const gone = blockLines(ed.search);
    const come = blockLines(ed.replace);
    removed += gone.length;
    added += come.length;
    return [`@@ bloc ${n + 1} (ligne ${line})`, ...gone.map((l) => `- ${l}`), ...come.map((l) => `+ ${l}`)];
  });
  ctx.ws.write(rel, Buffer.from(current, "utf8"));
  return { title: `${rel} (${op.edits.length} bloc(s), +${added} -${removed})`, body: diff.join("\n") };
}

export const edit: Spec = directive({
  name: "edit",
  summary: "remplace du texte existant ; chaque SEARCH doit être trouvé exactement une fois",
  usage: "@edit <fichier>  puis un ou plusieurs blocs <<<<<<< SEARCH / ======= / >>>>>>> REPLACE",
  block: "edit",
  writes: true,
  optionDocs: ["REPLACE vide : supprime le texte (et la ligne entière si SEARCH couvre des lignes complètes)"],
  examples: ["@edit src/user.ts\n<<<<<<< SEARCH\n  return { id, name }\n=======\n  return { id, name, role: \"member\" }\n>>>>>>> REPLACE"],
  run: runEdit,
});
