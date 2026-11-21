// Format versionné de la Dernière sortie (`<cache>/last.json`) : la copie non colorée du Rapport.
// Une copie d'un autre format (ou illisible) n'est jamais une erreur : elle est traitée comme absente.

import type { Snapshot } from "../types.ts";

/** À incrémenter à chaque changement de forme de `Snapshot`. 1 = copie texte (fls 1.2.0). */
export const SNAPSHOT_FORMAT = 2;

export const encodeSnapshot = (snapshot: Snapshot): { format: number; snapshot: Snapshot } => ({ format: SNAPSHOT_FORMAT, snapshot });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Relit une copie ; `null` si le format ou la forme ne sont pas ceux attendus. */
export function decodeSnapshot(data: unknown): Snapshot | null {
  if (!isRecord(data) || data.format !== SNAPSHOT_FORMAT || !isRecord(data.snapshot)) return null;
  const s = data.snapshot;
  if (s.kind === "tree" && Array.isArray(s.roots)) return s as unknown as Snapshot;
  const doc = s.doc;
  if (s.kind === "report" && isRecord(doc) && typeof doc.header === "string" && Array.isArray(doc.entries) && Array.isArray(doc.footer)) return s as unknown as Snapshot;
  return null;
}
