import { normalizeRel } from "../paths.ts";
import type { Ctx, Done, Op, Spec } from "../types.ts";
import { directive } from "./shared.ts";

function runMove(ctx: Ctx, op: Op): Done {
  const from = normalizeRel(op.args[0]);
  const to = normalizeRel(op.args[1]);
  ctx.ws.move(from, to);
  return { title: `${from} -> ${to}`, body: [] };
}

export const move: Spec = directive({
  name: "move",
  summary: "déplace ou renomme un fichier ; échoue si la destination existe",
  usage: "@move <source> <destination>",
  positional: [2, 2],
  writes: true,
  examples: ["@move src/helpers.ts src/utils/helpers.ts"],
  run: runMove,
});
