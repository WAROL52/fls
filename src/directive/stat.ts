import { sha1 } from "../workspace.ts";
import { normalizeRel } from "../paths.ts";
import { FlsError } from "../errors.ts";
import { splitLines } from "../text.ts";
import { textBody } from "../report/segments.ts";
import type { Ctx, Done, Op, Spec } from "../types.ts";
import { directive } from "./shared.ts";

const mode = (n: number): string => n.toString(8).padStart(4, "0");

function fileFacts(ctx: Ctx, rel: string): string[] {
  const buf = ctx.ws.get(rel);
  const facts = [`type   : fichier`, `taille : ${buf.length} octets`];
  try {
    facts.push(`lignes : ${splitLines(ctx.ws.text(rel)).length}`);
  } catch {
    // binaire, trop gros ou non UTF-8 : pas de nombre de lignes
  }
  return [...facts, `droits : ${mode(ctx.ws.modeOf(rel))}`, `sha1   : ${sha1(buf)}`];
}

function runStat(ctx: Ctx, op: Op): Done {
  const rel = normalizeRel(op.args[0]);
  const kind = ctx.ws.kind(rel);
  if (kind === null) throw new FlsError("not_found", `introuvable : ${rel}`);
  const facts =
    kind === "file"
      ? fileFacts(ctx, rel)
      : kind === "dir"
        ? ["type   : dossier", `éléments : ${ctx.ws.list(rel).length}`]
        : [`type   : lien symbolique -> ${ctx.ws.linkTarget(rel)}`];
  return { title: rel === "" ? "." : rel, body: textBody(facts.map((f) => `    ${f}`).join("\n")) };
}

export const stat: Spec = directive({
  name: "stat",
  summary: "décrit un chemin : type, taille, lignes, droits et empreinte sha1 (sans date)",
  usage: "@stat <chemin>",
  examples: ["@stat src/user.ts"],
  run: runStat,
});
