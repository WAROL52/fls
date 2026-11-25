import { FlsError } from "../errors.ts";
import { normalizeRel } from "../paths.ts";
import type { Ctx, Done, Op, Spec } from "../types.ts";
import { applyAstEdits, checkMatches, runAstGrep } from "./ast.ts";
import { directive } from "./shared.ts";

function runEditAst(ctx: Ctx, op: Op): Done {
  const inline = typeof op.opts.rewrite === "string" ? op.opts.rewrite : null;
  if (inline !== null && op.rewriteBlock === true) {
    throw new FlsError("invalid_argument", "@edit_ast : utilise --rewrite ou un bloc REWRITE, pas les deux");
  }
  const rewrite = inline ?? (op.rewriteBlock === true ? op.content : null);
  if (rewrite === null) throw new FlsError("invalid_argument", "@edit_ast : il faut --rewrite ou un bloc REWRITE");
  if (op.opts.all === true && op.opts.first === true) {
    throw new FlsError("invalid_argument", "@edit_ast : --all et --first sont exclusifs");
  }

  let matches = checkMatches(ctx, runAstGrep(ctx, op, rewrite));
  if (matches.length === 0) throw new FlsError("not_found", `aucun match pour "${op.args[0]}"`);
  if (op.opts.all !== true) {
    if (op.opts.first === true) {
      matches = matches.slice(0, 1);
    } else if (matches.length > 1) {
      const where = matches
        .slice(0, 5)
        .map((m) => `${m.rel}:${m.range.start.line + 1}`)
        .join(", ");
      throw new FlsError("ambiguous_match", `motif trouvé ${matches.length} fois (${where}) ; ajoute --all ou --first`);
    }
  }

  const { files, hunks } = applyAstEdits(ctx, matches);
  const where = normalizeRel(op.args[1] ?? ".");
  const place = where === "" ? "." : where;
  if (hunks.length === 0) return { title: `"${op.args[0]}" dans ${place} (aucun changement)`, body: [] };
  return {
    title: `"${op.args[0]}" dans ${place} (${hunks.length} remplacement(s), ${files.length} fichier(s))`,
    body: [{ kind: "diff", hunks: hunks.map((h, i) => ({ block: i + 1, line: h.line, file: h.rel, removed: h.removed, added: h.added })) }],
  };
}

export const editAst: Spec = directive({
  name: "edit_ast",
  summary: "remplace un motif structurel (AST) ; unique par défaut, --all ou --first",
  usage: '@edit_ast "<motif>" [chemin] [--lang ts] [--all|--first] [--rewrite "…"] puis un bloc <<<<<<< REWRITE / >>>>>>> END',
  block: "rewrite",
  writes: true,
  options: { lang: "value", all: "flag", first: "flag", rewrite: "value" },
  positional: [1, 2],
  optionDocs: [
    "--lang <langage> : ts, tsx, js, jsx, html… (obligatoire pour un dossier ; auto = déduction par fichier, injections HTML)",
    "--all : applique tous les matches",
    "--first : applique seulement le premier",
    "--rewrite <texte> : remplacement inline (alternative au bloc REWRITE)",
  ],
  examples: [
    '@edit_ast "console.log($ARG)" src --lang ts --all\n<<<<<<< REWRITE\nlogger.info($ARG)\n>>>>>>> END',
    '@edit_ast "console.log($ARG)" src --lang ts --rewrite "logger.info($ARG)" --all',
  ],
  run: runEditAst,
});
