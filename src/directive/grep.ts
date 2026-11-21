import { FlsError } from "../errors.ts";
import { normalizeRel } from "../paths.ts";
import { range, splitLines } from "../text.ts";
import type { Ctx, Op, Spec } from "../types.ts";
import type { Workspace } from "../workspace.ts";
import { collectFiles, directive, intOpt } from "./shared.ts";

const escapeAll = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function tryText(ws: Workspace, rel: string): string | null {
  try {
    return ws.text(rel);
  } catch {
    return null;
  }
}

function compileRegex(source: string, flags: string): RegExp {
  try {
    return new RegExp(source, flags);
  } catch {
    throw new FlsError("invalid_argument", `expression régulière invalide : ${source}`);
  }
}

function runGrep(ctx: Ctx, op: Op): { title: string; body: string } {
  const needle = op.args[0];
  const rel = normalizeRel(op.args[1] ?? ".");
  const re = compileRegex(op.opts["regex"] === true ? needle : escapeAll(needle), op.opts["ignore-case"] === true ? "i" : "");
  const context = intOpt(op, "context", 0);
  const isDir = ctx.ws.kind(rel) === "dir";
  const out: string[] = [];
  let hits = 0;
  let matchedFiles = 0;
  for (const f of isDir ? collectFiles(ctx, rel) : [rel]) {
    const text = isDir ? tryText(ctx.ws, f) : ctx.ws.text(f);
    if (text === null) continue;
    const lines = splitLines(text);
    const found = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
    if (found.length === 0) continue;
    hits += found.length;
    matchedFiles += 1;
    const keep = new Set(found.flatMap((i) => range(Math.max(0, i - context), Math.min(lines.length - 1, i + context))));
    let prev = -2;
    for (const i of [...keep].sort((a, b) => a - b)) {
      if (out.length > 0 && i !== prev + 1) out.push("--");
      out.push(found.includes(i) ? `${f}:${i + 1}: ${lines[i]}` : `${f}-${i + 1}- ${lines[i]}`);
      prev = i;
    }
  }
  const where = rel === "" ? "." : rel;
  return { title: `"${needle}" dans ${where} (${hits} correspondance(s) dans ${matchedFiles} fichier(s))`, body: out.join("\n") };
}

export const grep: Spec = directive({
  name: "grep",
  summary: "cherche un texte littéral (ou une regex) dans un fichier ou un dossier",
  usage: '@grep "<texte>" [chemin] [--context N] [--regex] [--ignore-case]',
  options: { context: "value", regex: "flag", "ignore-case": "flag" },
  aliases: { "-C": "context" },
  positional: [1, 2],
  optionDocs: ["--context N (ou -C N) : lignes de contexte autour de chaque correspondance", "--regex : le motif est une expression régulière", "--ignore-case : insensible à la casse"],
  examples: ['@grep "getUser" src --context 2'],
  run: runGrep,
});
