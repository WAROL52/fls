// Chemins relatifs et motifs d'ignore (.gitignore, .flsignore, --ignore).

import * as path from "node:path";
import { FlsError } from "./errors.ts";
import { splitLines } from "./text.ts";
import type { Ignore } from "./types.ts";
import type { Workspace } from "./workspace.ts";

export function normalizeRel(p: string): string {
  if (path.isAbsolute(p)) throw new FlsError("outside_workspace", `chemin absolu refusé : ${p}`);
  const n = path.posix.normalize(p);
  if (n === ".." || n.startsWith("../")) throw new FlsError("outside_workspace", `chemin hors du dossier courant : ${p}`);
  return n === "." ? "" : n.replace(/\/$/, "");
}

const GLOB: Record<string, string> = { "**": ".*", "*": "[^/]*", "?": "[^/]" };
const escapeRe = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
const globToRegex = (g: string): RegExp => new RegExp("^" + escapeRe(g).replace(/\*\*|\*|\?/g, (m) => GLOB[m]) + "$");

interface Rule {
  re: RegExp;
  dirOnly: boolean;
  anchored: boolean;
}

function toRule(raw: string): Rule {
  const trimmed = raw.replace(/\/$/, "");
  return {
    re: globToRegex(trimmed.replace(/^\//, "")),
    dirOnly: raw.endsWith("/"),
    anchored: trimmed.includes("/"),
  };
}

export function compileIgnore(lines: string[]): Ignore {
  const rules = lines
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith("!"))
    .map(toRule);
  return (rel, isDir) => rules.some((r) => (!r.dirOnly || isDir) && r.re.test(r.anchored ? rel : path.posix.basename(rel)));
}

export function loadIgnore(ws: Workspace, extra: string[]): Ignore {
  const fromFiles = [".gitignore", ".flsignore"].flatMap((f) => (ws.kind(f) === "file" ? splitLines(ws.text(f)) : []));
  return compileIgnore([".git/", "node_modules/", ".fls/", ...extra, ...fromFiles]);
}
