import { FlsError } from "../errors.ts";
import { normalizeRel } from "../paths.ts";
import { textBody } from "../report/segments.ts";
import type { Ctx, Done, Op, Spec } from "../types.ts";
import { directive, intOpt } from "./shared.ts";

const DEFAULT_LIMIT = 10;

function runHistory(ctx: Ctx, op: Op): Done {
  const rel = op.args[0] === undefined ? null : normalizeRel(op.args[0]);
  const limit = intOpt(op, "limit", DEFAULT_LIMIT);
  if (limit < 1) throw new FlsError("invalid_argument", "--limit attend un entier >= 1");
  const runs = ctx.journal.history(rel, limit);
  const lines = runs.map((r) => {
    const what = r.action ?? `${r.files} fichier(s)${r.dirs > 0 ? `, ${r.dirs} dossier(s)` : ""}`;
    return `    ${r.id}  ${r.date}  ${what}${r.undone ? "  (annulé)" : ""}`;
  });
  const count = `${runs.length} run(s)`;
  return { title: rel === null ? count : `${rel} : ${count}`, body: textBody(lines.length === 0 ? "    aucun run" : lines.join("\n")) };
}

export const history: Spec = directive({
  name: "history",
  summary: "liste les runs du Journal, les plus récents d'abord ; avec un chemin, ceux qui l'ont touché",
  usage: "@history [chemin] [--limit N]",
  options: { limit: "value" },
  positional: [0, 1],
  optionDocs: ["--limit N : nombre de runs affichés (défaut 10)"],
  examples: ["@history src/user.ts --limit 5"],
  run: runHistory,
});
