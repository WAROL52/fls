import { normalizeRel } from "../paths.ts";
import type { Ctx, Op, Spec } from "../types.ts";
import { directive } from "./shared.ts";

function runDelete(ctx: Ctx, op: Op): { title: string; body: string } {
  const rel = normalizeRel(op.args[0]);
  ctx.ws.remove(rel);
  return { title: rel, body: "" };
}

export const del: Spec = directive({
  name: "delete",
  summary: "supprime un fichier (les dossiers ne sont pas gérés en v1)",
  usage: "@delete <fichier>",
  writes: true,
  examples: ["@delete src/old-user.ts"],
  run: runDelete,
});
