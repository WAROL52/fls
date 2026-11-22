// Rendu stylé d'une lecture `--tree` : parcourt la structure de l'arbre (dossiers, fichiers, liens)
// et reprend la mise en page de la sortie brute. Le contenu d'un fichier reste à la colonne de son
// nom, avec gouttière et repli ; le fond ne couvre que le code.

import { palette, type Palette } from "../ansi.ts";
import { langFromPath } from "../highlight.ts";
import { branchOf, indentOf, treeText, type TreeNode } from "../tree.ts";
import { codeBlockRows } from "./code-block.ts";
import type { StyleOptions } from "./styled.ts";

type FileNode = Extract<TreeNode, { kind: "file" }>;

/** Contenu d'un fichier : marqueur discret, ou code numéroté à partir de 1. */
async function fileRows(n: FileNode, prefix: string, p: Palette, o: StyleOptions): Promise<string[]> {
  if (n.note !== undefined) return [p.dim(`${prefix}[${n.note}]`)];
  return codeBlockRows(n.lines, n.lines.map((_, k) => k + 1), langFromPath(n.name), prefix, p, o.columns, o.highlighter);
}

async function childRows(nodes: TreeNode[], prefix: string, p: Palette, o: StyleOptions): Promise<string[]> {
  const out: string[] = [];
  for (const [i, n] of nodes.entries()) {
    const last = i === nodes.length - 1;
    const next = indentOf(prefix, last);
    out.push(p.dim(prefix + branchOf(last)) + n.name);
    if (n.kind === "dir") out.push(...(await childRows(n.children, next, p, o)));
    else if (n.kind === "link") out.push(p.dim(`${next}-> ${n.target}`));
    else out.push(...(await fileRows(n, next, p, o)));
  }
  return out;
}

async function rootRows(root: TreeNode, p: Palette, o: StyleOptions): Promise<string> {
  const rows = [p.bold(root.name)];
  if (root.kind === "dir") rows.push(...(await childRows(root.children, "", p, o)));
  else if (root.kind === "link") rows.push(p.dim(`-> ${root.target}`));
  else rows.push(...(await fileRows(root, "", p, o)));
  return `${rows.join("\n")}\n`;
}

/** Racines rendues puis jointes par un retour à la ligne, comme en brut ; une racine absente donne un texte vide. */
export async function renderTreeStyled(roots: Array<TreeNode | null>, o: StyleOptions): Promise<string> {
  if (o.level === 0) return roots.map((r) => (r === null ? "" : treeText(r))).join("\n");
  const p = palette(o.level, o.bg);
  const parts = await Promise.all(roots.map((r) => (r === null ? "" : rootRows(r, p, o))));
  return parts.join("\n");
}
