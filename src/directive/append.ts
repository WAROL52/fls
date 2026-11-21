import { normalizeRel } from "../paths.ts";
import { splitLines } from "../text.ts";
import type { Ctx, Op, Spec } from "../types.ts";
import { CONTENT_EXAMPLE, directive } from "./shared.ts";

function runAppend(ctx: Ctx, op: Op): { title: string; body: string } {
  const rel = normalizeRel(op.args[0]);
  const existing = ctx.ws.kind(rel) === null ? "" : ctx.ws.text(rel);
  const glue = existing === "" || existing.endsWith("\n") ? "" : "\n";
  ctx.ws.write(rel, Buffer.from(existing + glue + op.content, "utf8"));
  return { title: `${rel} (+${splitLines(op.content).length} lignes)`, body: "" };
}

export const append: Spec = directive({
  name: "append",
  summary: "ajoute le bloc à la fin d'un fichier (le crée s'il n'existe pas)",
  usage: "@append <fichier>  puis un bloc <<<<<<< CONTENT / >>>>>>> END",
  block: "content",
  writes: true,
  examples: [CONTENT_EXAMPLE("append")],
  run: runAppend,
});
