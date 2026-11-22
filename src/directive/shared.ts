// Aides partagées par plusieurs directives : options entières, parcours de
// dossiers, écriture conditionnelle et fabrique de spécification.

import { FlsError } from "../errors.ts";
import { normalizeRel } from "../paths.ts";
import { joinRel, splitLines } from "../text.ts";
import type { Ctx, Done, Kind, Op, Spec } from "../types.ts";
import type { Workspace } from "../workspace.ts";

export function intOpt(op: Op, name: string, fallback: number): number {
  const raw = op.opts[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new FlsError("invalid_argument", `--${name} attend un entier >= 0 (reçu : ${raw})`);
  return n;
}

export const escapeAll = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function compileRegex(source: string, flags: string): RegExp {
  try {
    return new RegExp(source, flags);
  } catch {
    throw new FlsError("invalid_argument", `expression régulière invalide : ${source}`);
  }
}

export interface Child {
  name: string;
  rel: string;
  kind: Kind;
}

export function children(ctx: Ctx, rel: string): Child[] {
  return ctx.ws
    .list(rel)
    .map((name) => ({ name, rel: joinRel(rel, name), kind: ctx.ws.kind(joinRel(rel, name)) as Kind }))
    .filter((c) => !ctx.ignore(c.rel, c.kind === "dir"));
}

const LABELS: Record<Kind, (ws: Workspace, c: Child) => string> = {
  dir: (_ws, c) => `${c.name}/`,
  link: (ws, c) => `${c.name} -> ${ws.linkTarget(c.rel)}`,
  file: (_ws, c) => c.name,
};

export function treeLines(ctx: Ctx, rel: string, depth: number, dirsOnly: boolean, prefix: string): string[] {
  if (depth === 0) return [];
  const items = children(ctx, rel).filter((c) => !dirsOnly || c.kind === "dir");
  return items.flatMap((c, i) => {
    const last = i === items.length - 1;
    const line = prefix + (last ? "└── " : "├── ") + LABELS[c.kind](ctx.ws, c);
    const sub = c.kind === "dir" ? treeLines(ctx, c.rel, depth - 1, dirsOnly, prefix + (last ? "    " : "│   ")) : [];
    return [line, ...sub];
  });
}

export function collectFiles(ctx: Ctx, rel: string): string[] {
  return children(ctx, rel).flatMap((c) => (c.kind === "dir" ? collectFiles(ctx, c.rel) : [c.rel]));
}

const PUT_CHECKS: Record<string, (existed: boolean, rel: string) => void> = {
  create: (existed, rel) => {
    if (existed) throw new FlsError("already_exists", `${rel} existe déjà (utilise @overwrite)`);
  },
  overwrite: (existed, rel) => {
    if (!existed) throw new FlsError("not_found", `${rel} n'existe pas (utilise @create)`);
  },
  write: () => undefined,
};

export function runPut(mode: string): (ctx: Ctx, op: Op) => Done {
  return (ctx, op) => {
    const rel = normalizeRel(op.args[0]);
    const existed = ctx.ws.kind(rel) !== null;
    PUT_CHECKS[mode](existed, rel);
    ctx.ws.write(rel, Buffer.from(op.content, "utf8"));
    return { title: `${rel} (${existed ? "remplacé" : "nouveau"}, ${splitLines(op.content).length} lignes)`, body: [] };
  };
}

export const directive = (
  d: Partial<Spec> & Pick<Spec, "name" | "summary" | "usage" | "examples" | "run">,
): Spec => ({
  options: {},
  aliases: {},
  positional: [1, 1],
  block: "none",
  writes: false,
  guard: false,
  optionDocs: [],
  ...d,
});

export const CONTENT_EXAMPLE = (name: string): string =>
  `@${name} src/roles.ts\n<<<<<<< CONTENT\nexport const ROLES = ["admin", "member"] as const\n>>>>>>> END`;
