// Rendu stylé d'une lecture `--tree` : parcourt la structure de l'arbre (dossiers, fichiers, liens)
// et reprend la mise en page de la sortie brute. Le contenu d'un fichier reste à la colonne de son
// nom, avec gouttière et repli ; le fond ne couvre que le code.

import { langFromPath } from "../highlight.ts";
import { palette, span, type Line, type Palette } from "../style.ts";
import { branchOf, indentOf, type TreeNode } from "../tree.ts";
import { codeBlockRows } from "./code-block.ts";
import type { StyleOptions } from "./styled.ts";

type FileNode = Extract<TreeNode, { kind: "file" }>;

const row = (spans: Line["spans"]): Line => ({ spans });

/** Contenu d'un fichier : marqueur discret, ou code numéroté à partir de 1. */
async function fileRows(n: FileNode, prefix: string, p: Palette, o: StyleOptions): Promise<Line[]> {
  if (n.note !== undefined) return [row(span(`${prefix}[${n.note}]`, p.dim))];
  return codeBlockRows(n.lines, n.lines.map((_, k) => k + 1), langFromPath(n.name), prefix, p, o.columns, o.highlighter);
}

async function childRows(nodes: TreeNode[], prefix: string, p: Palette, o: StyleOptions): Promise<Line[]> {
  const out: Line[] = [];
  for (const [i, n] of nodes.entries()) {
    const last = i === nodes.length - 1;
    const next = indentOf(prefix, last);
    out.push(row([...span(prefix + branchOf(last), p.dim), ...span(n.name)]));
    if (n.kind === "dir") out.push(...(await childRows(n.children, next, p, o)));
    else if (n.kind === "link") out.push(row(span(`${next}-> ${n.target}`, p.dim)));
    else out.push(...(await fileRows(n, next, p, o)));
  }
  return out;
}

async function rootRows(root: TreeNode, p: Palette, o: StyleOptions): Promise<Line[]> {
  const rows = [row(span(root.name, p.bold))];
  if (root.kind === "dir") rows.push(...(await childRows(root.children, "", p, o)));
  else if (root.kind === "link") rows.push(row(span(`-> ${root.target}`, p.dim)));
  else rows.push(...(await fileRows(root, "", p, o)));
  return rows;
}

/**
 * Racines en lignes stylées. Chaque racine présente est suivie d'une ligne vide (le retour à la
 * ligne final, qui sépare aussi de la suivante) ; une racine absente ne donne qu'une ligne vide.
 */
export async function renderTreeStyled(roots: Array<TreeNode | null>, o: StyleOptions): Promise<Line[]> {
  const p = palette(o.bg);
  const parts = await Promise.all(roots.map((r) => (r === null ? Promise.resolve([row([])]) : rootRows(r, p, o).then((rows) => [...rows, row([])]))));
  return parts.flat();
}
