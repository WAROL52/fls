import { normalizeRel } from "../paths.ts";
import type { Ctx, Done, Op, Spec } from "../types.ts";
import { directive } from "./shared.ts";

function runCopy(ctx: Ctx, op: Op): Done {
  const from = normalizeRel(op.args[0]);
  const to = normalizeRel(op.args[1]);
  ctx.ws.copy(from, to);
  return { title: `${from} -> ${to}`, body: [] };
}

export const copy: Spec = directive({
  name: "copy",
  summary: "copie un fichier (droits conservés) ; échoue si la destination existe",
  usage: "@copy <source> <destination>",
  positional: [2, 2],
  writes: true,
  examples: ["@copy src/user.ts src/user.backup.ts"],
  run: runCopy,
});
