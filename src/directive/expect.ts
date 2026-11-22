// Vérifications : constatent un fait sur l'état simulé. Un échec bloque les écritures suivantes
// (SKIP) sans rien annuler : après des écritures déjà faites, `fls undo` revient en arrière.

import { FlsError } from "../errors.ts";
import { normalizeRel } from "../paths.ts";
import type { Ctx, Done, Op, Spec } from "../types.ts";
import { compileRegex, directive, escapeAll, intOpt } from "./shared.ts";

const failed = (message: string): FlsError => new FlsError("expectation_failed", message);

const KIND_LABEL = { file: "fichier", dir: "dossier", link: "lien symbolique" };

function runExists(ctx: Ctx, op: Op): Done {
  const rel = normalizeRel(op.args[0]);
  if (ctx.ws.kind(rel) === null) throw failed(`attendu : ${rel} existe ; trouvé : absent`);
  return { title: rel, body: [] };
}

function runMissing(ctx: Ctx, op: Op): Done {
  const rel = normalizeRel(op.args[0]);
  const kind = ctx.ws.kind(rel);
  if (kind !== null) throw failed(`attendu : ${rel} absent ; trouvé : ${KIND_LABEL[kind]}`);
  return { title: rel, body: [] };
}

const MAX_LISTED = 10;

function runContains(ctx: Ctx, op: Op): Done {
  const rel = normalizeRel(op.args[0]);
  const needle = op.args[1];
  if (needle === "") throw new FlsError("invalid_argument", "le texte cherché est vide");
  const re = compileRegex(op.opts["regex"] === true ? needle : escapeAll(needle), "g");
  const text = ctx.ws.text(rel);
  const wanted = op.opts["count"] === undefined ? null : intOpt(op, "count", 0);
  const lines = [...text.matchAll(re)].map((m) => text.slice(0, m.index).split("\n").length);
  const found = lines.length;
  if (wanted === null ? found === 0 : found !== wanted) {
    const where = found === 0 ? "" : ` (lignes ${[...new Set(lines)].slice(0, MAX_LISTED).join(", ")}${new Set(lines).size > MAX_LISTED ? ", …" : ""})`;
    throw failed(`attendu : ${wanted === null ? "au moins 1" : wanted} occurrence(s) dans ${rel} ; trouvé : ${found}${where}`);
  }
  return { title: `${rel} ${JSON.stringify(needle)} (${found} occurrence(s))`, body: [] };
}

export const expectExists: Spec = directive({
  name: "expect_exists",
  summary: "vérifie qu'un chemin existe ; sinon FAIL et les écritures suivantes sont ignorées",
  usage: "@expect_exists <chemin>",
  guard: true,
  examples: ["@expect_exists src/user.ts"],
  run: runExists,
});

export const expectMissing: Spec = directive({
  name: "expect_missing",
  summary: "vérifie qu'un chemin n'existe pas ; sinon FAIL et les écritures suivantes sont ignorées",
  usage: "@expect_missing <chemin>",
  guard: true,
  examples: ["@expect_missing src/roles.ts"],
  run: runMissing,
});

export const expectContains: Spec = directive({
  name: "expect_contains",
  summary: "vérifie qu'un fichier contient un texte (au moins une fois, ou exactement N fois) ; sinon FAIL et les écritures suivantes sont ignorées",
  usage: '@expect_contains <fichier> "<texte>" [--regex] [--count N]',
  options: { regex: "flag", count: "value" },
  positional: [2, 2],
  guard: true,
  optionDocs: ["--regex : le motif est une expression régulière", "--count N : exactement N occurrences (toutes, même sur une même ligne) au lieu d'au moins une"],
  examples: ['@expect_contains src/user.ts "role: " --count 1'],
  run: runContains,
});
