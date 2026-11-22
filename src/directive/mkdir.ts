import { normalizeRel } from "../paths.ts";
import type { Ctx, Done, Op, Spec } from "../types.ts";
import { directive } from "./shared.ts";

function runMkdir(ctx: Ctx, op: Op): Done {
  const rel = normalizeRel(op.args[0]);
  const created = ctx.ws.mkdir(rel);
  return { title: `${rel === "" ? "." : rel}/ (${created ? "créé" : "existe déjà"})`, body: [] };
}

export const mkdir: Spec = directive({
  name: "mkdir",
  summary: "crée un dossier, parents compris (sans effet s'il existe déjà) ; annulable avec undo s'il est resté vide",
  usage: "@mkdir <dossier>",
  writes: true,
  examples: ["@mkdir apps/web/src/hooks"],
  run: runMkdir,
});
