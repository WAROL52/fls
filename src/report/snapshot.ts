// Format versionné de la Dernière sortie (`<cache>/last.json`) : la copie non colorée du Rapport.
// Une copie d'un autre format (ou illisible) n'est jamais une erreur : elle est traitée comme absente.

import type { Content } from "../types.ts";

/** À incrémenter à chaque changement de forme de `Content`. 1 = copie texte (fls 1.2.0), 2 = Rapport en donnée, 3 = arbres en structure. */
export const SNAPSHOT_FORMAT = 3;

export const encodeSnapshot = (content: Content): { format: number; snapshot: Content } => ({ format: SNAPSHOT_FORMAT, snapshot: content });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Vérifie la forme d'un arbre relu (une copie modifiée à la main ne doit pas faire planter le rendu). */
function isTreeNode(v: unknown): boolean {
  if (!isRecord(v) || typeof v.name !== "string") return false;
  if (v.kind === "dir") return Array.isArray(v.children) && v.children.every(isTreeNode);
  if (v.kind === "file") return Array.isArray(v.lines) && v.lines.every((l) => typeof l === "string") && (v.note === undefined || v.note === "output file" || v.note === "unreadable");
  return v.kind === "link" && typeof v.target === "string";
}

/** Relit une copie ; `null` si le format ou la forme ne sont pas ceux attendus. */
export function decodeSnapshot(data: unknown): Content | null {
  if (!isRecord(data) || data.format !== SNAPSHOT_FORMAT || !isRecord(data.snapshot)) return null;
  const s = data.snapshot;
  if (s.kind === "tree" && Array.isArray(s.roots) && s.roots.every((r) => r === null || isTreeNode(r))) return s as unknown as Content;
  const doc = s.doc;
  if (s.kind === "report" && isRecord(doc) && typeof doc.header === "string" && Array.isArray(doc.entries) && Array.isArray(doc.footer)) return s as unknown as Content;
  return null;
}
