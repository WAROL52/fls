import { FlsError } from "../errors.ts";
import { normalizeRel } from "../paths.ts";
import { splitLines } from "../text.ts";
import { fileTitle, textBody, type Segment } from "../report/segments.ts";
import { renderTree, treeRel } from "../tree.ts";
import type { Ctx, Done, Op, Spec } from "../types.ts";
import type { Workspace } from "../workspace.ts";
import { collectFiles, directive, intOpt, treeLines } from "./shared.ts";

function parseRange(text: string, total: number): [number, number] {
  const m = /^(\d+)(?:-(\d*))?$/.exec(text);
  if (m === null) throw new FlsError("invalid_argument", `plage invalide : ${text} (attendu A, A-B ou A-)`);
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : m[2] === "" ? total : Number(m[2]);
  if (from < 1 || to < from) throw new FlsError("invalid_argument", `plage invalide : ${text}`);
  if (from > total) throw new FlsError("invalid_argument", `la plage commence après la fin du fichier (${total} lignes)`);
  return [from, Math.min(to, total)];
}

type FileSegment = Extract<Segment, { kind: "file" }>;

function fileSegment(ws: Workspace, rel: string, rangeText: string | null, numbered: boolean): FileSegment {
  const lines = splitLines(ws.text(rel));
  const total = lines.length;
  const [from, to] = rangeText === null ? [1, total] : parseRange(rangeText, total);
  return { kind: "file", path: rel, from, total, ranged: rangeText !== null, numbered, lines: lines.slice(from - 1, to) };
}

/** Un fichier illisible n'interrompt pas la lecture d'un dossier : il devient un segment « omis ». */
function omitOnError(file: string, produce: () => FileSegment): Segment {
  try {
    return produce();
  } catch (e) {
    return { kind: "omitted", path: file, code: (e as FlsError).code };
  }
}

function readDir(ctx: Ctx, op: Op, rel: string): Done {
  const label = rel === "" ? "." : rel;
  const files = collectFiles(ctx, rel);
  const tree = [`${label}/`, ...treeLines(ctx, rel, intOpt(op, "depth", Infinity), false, "")].join("\n");
  const numbered = op.opts["line-numbers"] === true;
  const blocks = files.map((f) => omitOnError(f, () => fileSegment(ctx.ws, f, null, numbered)));
  return { title: `${label} (dossier, ${files.length} fichier(s))`, body: [...textBody(tree), ...blocks] };
}

function runTreeRead(ctx: Ctx, op: Op): Done {
  const conflicts = [
    op.args.length > 1 ? "plage positionnelle" : null,
    op.opts["lines"] !== undefined ? "--lines" : null,
    op.opts["line-numbers"] === true ? "--line-numbers" : null,
    op.opts["depth"] !== undefined ? "--depth" : null,
  ].filter((c): c is string => c !== null);
  if (conflicts.length > 0) throw new FlsError("invalid_argument", `--tree est incompatible avec ${conflicts.join(", ")}`);
  const raw = op.args[0];
  const label = raw === "" ? "." : raw;
  return { title: label, body: textBody(renderTree(ctx.ws, label, treeRel(raw), ctx.output ?? null).toString("utf8")) };
}

function runRead(ctx: Ctx, op: Op): Done {
  if (op.opts["tree"] === true) return runTreeRead(ctx, op);
  const rel = normalizeRel(op.args[0]);
  if (ctx.ws.kind(rel) === "dir") return readDir(ctx, op, rel);
  const wanted = op.opts["lines"] ?? op.args[1];
  const seg = fileSegment(ctx.ws, rel, wanted === undefined ? null : String(wanted), op.opts["line-numbers"] === true);
  return { title: fileTitle(seg), body: [seg] };
}

export const read: Spec = directive({
  name: "read",
  summary: "affiche un fichier, ou un dossier (arbre filtré puis contenus) ; --tree reproduit treecat",
  usage: "@read <chemin> [A-B] [--lines A-B] [--line-numbers] [--depth N] [--tree]",
  options: { lines: "value", "line-numbers": "flag", depth: "value", tree: "flag" },
  positional: [1, 2],
  optionDocs: [
    "--lines A-B : plage de lignes (A, A-B ou A-) ; la forme positionnelle `@read f 1-30` est acceptée",
    "--line-numbers : préfixe chaque ligne de son numéro",
    "--depth N : profondeur de l'arbre quand le chemin est un dossier",
    "--tree : sortie brute façon treecat (aucun ignore, liens non suivis) ; incompatible avec les autres options",
  ],
  examples: ['@read src/user.ts\n@read "src/types/api client.ts" --lines 1-30 --line-numbers'],
  run: runRead,
});
