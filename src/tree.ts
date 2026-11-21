// Rendu « treecat » : arborescence puis contenu brut des fichiers.
// Aucun ignore, aucune validation UTF-8, NUL supprimés. Les liens ne sont
// jamais suivis ; les chemins restent confinés au dossier courant.

import * as fs from "node:fs";
import * as path from "node:path";
import { FlsError } from "./errors.ts";
import { joinRel } from "./text.ts";
import type { Workspace } from "./workspace.ts";

const NL = Buffer.from("\n");
const utf8 = (s: string): Buffer => Buffer.from(s, "utf8");

/** Validation stricte du mode tree : relatifs uniquement, aucun segment `..`. */
export function treeRel(p: string): string {
  if (path.isAbsolute(p)) throw new FlsError("outside_workspace", `chemin absolu refusé : ${p}`);
  if (p.split("/").includes("..")) throw new FlsError("outside_workspace", `chemin hors du dossier courant : ${p}`);
  const n = path.posix.normalize(p.replace(/\/+$/, ""));
  return n === "." ? "" : n;
}

/** Valide le parent (les liens parents internes restent autorisés), jamais le lien final. */
function resolveParent(ws: Workspace, rel: string): void {
  const parent = path.posix.dirname(rel);
  ws.resolve(parent === "." ? "" : parent);
}

const readable = (abs: string): boolean => {
  try {
    fs.accessSync(abs, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

const regular = (abs: string): boolean => fs.lstatSync(abs, { throwIfNoEntry: false })?.isFile() ?? false;

const sameFile = (a: string, b: string): boolean => {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
};

const isOutput = (abs: string, output: string | null): boolean => output !== null && sameFile(abs, output);

/** Noms triés comme `LC_ALL=C sort` : par octets UTF-8. */
function sortedNames(ws: Workspace, rel: string, output: string | null): string[] {
  let names: string[];
  try {
    names = ws.list(rel);
  } catch (e) {
    if (e instanceof FlsError) throw e;
    return [];
  }
  // treecat crée le fichier de sortie avant de parcourir : il apparaît dans l'arbre.
  if (output !== null && path.dirname(output) === path.resolve(ws.root, rel)) {
    const name = path.basename(output);
    if (!names.includes(name)) names.push(name);
  }
  return names.sort((a, b) => Buffer.compare(utf8(a), utf8(b)));
}

/** Lignes du contenu, chacune préfixée ; NUL retirés ; newline final ajoutée si absente. */
function contentParts(buf: Buffer, prefix: string): Buffer[] {
  let data = buf;
  if (data.includes(0)) {
    const clean = Buffer.allocUnsafe(data.length);
    let n = 0;
    for (const b of data) if (b !== 0) clean[n++] = b;
    data = clean.subarray(0, n);
  }
  if (data.length === 0) return [];
  const p = utf8(prefix);
  const parts: Buffer[] = [];
  let start = 0;
  for (;;) {
    const nl = data.indexOf(10, start);
    if (nl === -1) {
      parts.push(p, data.subarray(start), NL);
      return parts;
    }
    parts.push(p, data.subarray(start, nl), NL);
    start = nl + 1;
    if (start === data.length) return parts;
  }
}

function fileBody(ws: Workspace, rel: string, abs: string, prefix: string, output: string | null): Buffer[] {
  if (isOutput(abs, output)) return [utf8(`${prefix}[output file]\n`)];
  const entry = ws.changes.get(rel);
  const virtual = entry !== undefined && entry.data !== null;
  const canRead = virtual || readable(abs);
  if ((virtual || regular(abs)) && canRead) return contentParts(ws.get(rel), prefix);
  if (!canRead) return [utf8(`${prefix}[unreadable]\n`)];
  return [];
}

function walk(ws: Workspace, rel: string, prefix: string, output: string | null, parts: Buffer[]): void {
  const names = sortedNames(ws, rel, output);
  names.forEach((name, i) => {
    const child = joinRel(rel, name);
    const last = i === names.length - 1;
    const next = prefix + (last ? "    " : "│   ");
    parts.push(utf8(`${prefix}${last ? "└── " : "├── "}${name}\n`));
    const kind = ws.kind(child);
    const abs = path.join(ws.root, child);
    if (kind === "dir") walk(ws, child, next, output, parts);
    else if (kind === "link") parts.push(utf8(`${next}-> ${ws.linkTarget(child)}\n`));
    else if (kind === "file" || isOutput(abs, output)) parts.push(...fileBody(ws, child, abs, next, output));
  });
}

/** Rend une racine (fichier, dossier ou lien) en octets, façon treecat. */
export function renderTree(ws: Workspace, label: string, rel: string, output: string | null): Buffer {
  resolveParent(ws, rel);
  const kind = ws.kind(rel);
  if (kind === null) throw new FlsError("not_found", `introuvable : ${label}`);
  const abs = path.join(ws.root, rel);
  const parts: Buffer[] = [utf8(`${label}\n`)];
  if (kind === "dir") {
    if (!fs.existsSync(abs) || readable(abs)) walk(ws, rel, "", output, parts);
  } else if (kind === "link") {
    parts.push(utf8(`-> ${ws.linkTarget(rel)}\n`));
  } else {
    parts.push(...fileBody(ws, rel, abs, "", output));
  }
  return Buffer.concat(parts);
}
