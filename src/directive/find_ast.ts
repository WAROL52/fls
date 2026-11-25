import { normalizeRel } from "../paths.ts";
import type { MatchRow } from "../report/segments.ts";
import type { Ctx, Done, Op, Spec } from "../types.ts";
import { checkMatches, matchRows, runAstGrep } from "./ast.ts";
import { directive, intOpt } from "./shared.ts";

function runFindAst(ctx: Ctx, op: Op): Done {
  const matches = checkMatches(ctx, runAstGrep(ctx, op, null));
  const rows: MatchRow[] = matchRows(ctx, matches, intOpt(op, "context", 0));
  const where = normalizeRel(op.args[1] ?? ".");
  const files = new Set(matches.map((m) => m.rel)).size;
  return {
    title: `"${op.args[0]}" dans ${where === "" ? "." : where} (${matches.length} correspondance(s) dans ${files} fichier(s))`,
    body: rows.length === 0 ? [] : [{ kind: "matches", pattern: null, rows }],
  };
}

export const findAst: Spec = directive({
  name: "find_ast",
  summary: "cherche un motif structurel (AST) avec ast-grep",
  usage: '@find_ast "<motif>" [chemin] [--lang ts] [--context N]',
  options: { lang: "value", context: "value" },
  positional: [1, 2],
  optionDocs: [
    "--lang <langage> : ts, tsx, js, jsx, html… (obligatoire pour un dossier ; auto = déduction par fichier, injections HTML)",
    "--context N : lignes de contexte autour de chaque correspondance",
  ],
  examples: ['@find_ast "console.log($ARG)" src --lang ts', '@find_ast "useEffect($$$ARGS)" src --lang tsx --context 2'],
  run: runFindAst,
});
