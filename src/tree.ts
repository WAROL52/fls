// Rendu « treecat » : arborescence puis contenu brut des fichiers.
// Aucun ignore, aucune validation UTF-8, NUL supprimés. Les liens ne sont
// jamais suivis ; les chemins restent confinés au dossier courant.

import * as fs from "node:fs";
import * as path from "node:path";
import { FlsError } from "./errors.ts";
import { joinRel } from "./text.ts";
import type { Workspace } from "./workspace.ts";

const NL = Buffer.from("\n");
const EMPTY = Buffer.alloc(0);
const utf8 = (s: string): Buffer => Buffer.from(s, "utf8");

// ───────────────────────────── Structure d'un arbre ─────────────────────────────

export type TreeNote = "output file" | "unreadable";

/**
 * Un arbre lu, en donnée : de quoi produire la sortie brute (octets exacts), le rendu stylé et la
 * copie de la Dernière sortie sans jamais reparser un texte. `name` est le nom affiché (le libellé
 * donné par l'utilisateur pour la racine). Les lignes d'un fichier sont décodées en UTF-8 (NUL retirés).
 */
export type TreeNode =
  | { kind: "dir"; name: string; children: TreeNode[] }
  | { kind: "file"; name: string; lines: string[]; note?: TreeNote }
  | { kind: "link"; name: string; target: string };

// Glyphes de l'arbre : un seul endroit pour les connaître.
const BRANCH = "├── ";
const LAST = "└── ";
const BAR = "│   ";
const GAP = "    ";
export const branchOf = (last: boolean): string => (last ? LAST : BRANCH);
export const indentOf = (prefix: string, last: boolean): string => prefix + (last ? GAP : BAR);

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

/** Contenu d'un fichier tel que treecat l'affiche : NUL retirés. */
const withoutNul = (buf: Buffer): Buffer => {
  if (!buf.includes(0)) return buf;
  const clean = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (const b of buf) if (b !== 0) clean[n++] = b;
  return clean.subarray(0, n);
};

/** Lignes du contenu, sans retour à la ligne ; un newline final ne crée pas de ligne vide. */
function slicesOf(data: Buffer): Buffer[] {
  if (data.length === 0) return [];
  const out: Buffer[] = [];
  let start = 0;
  for (;;) {
    const nl = data.indexOf(10, start);
    if (nl === -1) {
      out.push(data.subarray(start));
      return out;
    }
    out.push(data.subarray(start, nl));
    start = nl + 1;
    if (start === data.length) return out;
  }
}

/** Ce qu'un fichier montre : son contenu, ou un marqueur (`[output file]`, `[unreadable]`). */
interface FileView {
  note?: TreeNote;
  data: Buffer;
}

function viewOf(ws: Workspace, rel: string, abs: string, output: string | null): FileView {
  if (isOutput(abs, output)) return { note: "output file", data: EMPTY };
  const entry = ws.changes.get(rel);
  const virtual = entry !== undefined && entry.data !== null;
  const canRead = virtual || readable(abs);
  if ((virtual || regular(abs)) && canRead) return { data: withoutNul(ws.get(rel)) };
  if (!canRead) return { note: "unreadable", data: EMPTY };
  return { data: EMPTY };
}

/** Octets du contenu, chaque ligne préfixée (newline final ajoutée si absente). */
const bytesOf = (v: FileView, prefix: string): Buffer[] =>
  v.note !== undefined ? [utf8(`${prefix}[${v.note}]\n`)] : slicesOf(v.data).flatMap((s) => [utf8(prefix), s, NL]);

const fileNode = (name: string, v: FileView): TreeNode => ({
  kind: "file",
  name,
  lines: slicesOf(v.data).map((s) => s.toString("utf8")),
  ...(v.note === undefined ? {} : { note: v.note }),
});

function walk(ws: Workspace, rel: string, prefix: string, output: string | null, parts: Buffer[]): TreeNode[] {
  const names = sortedNames(ws, rel, output);
  return names.map((name, i): TreeNode => {
    const child = joinRel(rel, name);
    const last = i === names.length - 1;
    const next = indentOf(prefix, last);
    parts.push(utf8(`${prefix}${branchOf(last)}${name}\n`));
    const kind = ws.kind(child);
    const abs = path.join(ws.root, child);
    if (kind === "dir") return { kind: "dir", name, children: walk(ws, child, next, output, parts) };
    if (kind === "link") {
      const target = ws.linkTarget(child);
      parts.push(utf8(`${next}-> ${target}\n`));
      return { kind: "link", name, target };
    }
    if (kind === "file" || isOutput(abs, output)) {
      const view = viewOf(ws, child, abs, output);
      parts.push(...bytesOf(view, next));
      return fileNode(name, view);
    }
    return { kind: "file", name, lines: [] };
  });
}

/** Lit une racine (fichier, dossier ou lien) : les octets exacts façon treecat, et la structure. */
export function walkTree(ws: Workspace, label: string, rel: string, output: string | null): { raw: Buffer; node: TreeNode } {
  resolveParent(ws, rel);
  const kind = ws.kind(rel);
  if (kind === null) throw new FlsError("not_found", `introuvable : ${label}`);
  const abs = path.join(ws.root, rel);
  const parts: Buffer[] = [utf8(`${label}\n`)];
  let node: TreeNode;
  if (kind === "dir") {
    const children = !fs.existsSync(abs) || readable(abs) ? walk(ws, rel, "", output, parts) : [];
    node = { kind: "dir", name: label, children };
  } else if (kind === "link") {
    const target = ws.linkTarget(rel);
    parts.push(utf8(`-> ${target}\n`));
    node = { kind: "link", name: label, target };
  } else {
    const view = viewOf(ws, rel, abs, output);
    parts.push(...bytesOf(view, ""));
    node = fileNode(label, view);
  }
  return { raw: Buffer.concat(parts), node };
}

/** Les octets d'une racine, façon treecat. */
export const renderTree = (ws: Workspace, label: string, rel: string, output: string | null): Buffer => walkTree(ws, label, rel, output).raw;

const fileLines = (n: Extract<TreeNode, { kind: "file" }>, prefix: string): string[] =>
  n.note !== undefined ? [`${prefix}[${n.note}]`] : n.lines.map((l) => prefix + l);

function layout(nodes: TreeNode[], prefix: string, out: string[]): void {
  nodes.forEach((n, i) => {
    const last = i === nodes.length - 1;
    const next = indentOf(prefix, last);
    out.push(`${prefix}${branchOf(last)}${n.name}`);
    if (n.kind === "dir") layout(n.children, next, out);
    else if (n.kind === "link") out.push(`${next}-> ${n.target}`);
    else out.push(...fileLines(n, next));
  });
}

/** Le texte d'une racine reconstruit depuis la structure (pour `fls last`) : celui de `renderTree`, à l'UTF-8 près. */
export function treeText(root: TreeNode): string {
  const lines = [root.name];
  if (root.kind === "dir") layout(root.children, "", lines);
  else if (root.kind === "link") lines.push(`-> ${root.target}`);
  else lines.push(...fileLines(root, ""));
  return `${lines.join("\n")}\n`;
}
