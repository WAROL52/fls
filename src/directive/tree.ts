import { FlsError } from "../errors.ts";
import { normalizeRel } from "../paths.ts";
import type { Ctx, Op, Spec } from "../types.ts";
import type { Workspace } from "../workspace.ts";
import { directive, intOpt, treeLines } from "./shared.ts";

function requireDir(ws: Workspace, rel: string): void {
  const k = ws.kind(rel);
  if (k === null) throw new FlsError("not_found", `introuvable : ${rel}`);
  if (k !== "dir") throw new FlsError("not_a_directory", `${rel} n'est pas un dossier`);
}

function runTree(ctx: Ctx, op: Op): { title: string; body: string } {
  const rel = normalizeRel(op.args[0] ?? ".");
  requireDir(ctx.ws, rel);
  const label = rel === "" ? "." : rel;
  const lines = treeLines(ctx, rel, intOpt(op, "depth", Infinity), op.opts["dirs-only"] === true, "");
  return { title: label, body: [`${label}/`, ...lines].join("\n") };
}

export const tree: Spec = directive({
  name: "tree",
  summary: "affiche l'arborescence d'un dossier (fichiers ignorés exclus)",
  usage: "@tree [dossier] [--depth N] [--dirs-only]",
  options: { depth: "value", "dirs-only": "flag" },
  positional: [0, 1],
  optionDocs: ["--depth N : profondeur maximale (défaut : illimitée)", "--dirs-only : n'affiche que les dossiers"],
  examples: ["@tree src --depth 2"],
  run: runTree,
});
