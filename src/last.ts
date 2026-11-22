// Dernière sortie : la copie non colorée de la dernière lecture ou du dernier script, mémorisée dans
// `<cache>/last.json` pour `fls last` (ADR-0002). Une copie illisible ou d'un autre format est
// traitée comme absente ; un échec d'écriture n'est jamais fatal.

import * as fs from "node:fs";
import * as path from "node:path";
import { FlsError } from "./errors.ts";
import { decodeSnapshot, encodeSnapshot } from "./report/snapshot.ts";
import type { Content, Io } from "./types.ts";
import { VERSION } from "./version.ts";

const lastFile = (io: Io): string | null => (io.cacheDir === undefined ? null : path.join(io.cacheDir, "last.json"));

/** Mémorise la sortie non colorée ; un échec d'écriture (cache illisible, disque plein…) n'est jamais fatal. */
export function saveLast(io: Io, content: Content): void {
  const file = lastFile(io);
  if (file === null) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...encodeSnapshot(content), version: VERSION, date: io.now().toISOString(), cwd: io.cwd }));
  } catch {
    // la mémorisation est un confort
  }
}

export function loadLast(io: Io): Content {
  const file = lastFile(io);
  const none = new FlsError("no_last_output", "aucune sortie mémorisée : lance d'abord une lecture ou un script");
  if (file === null || !fs.existsSync(file)) throw none;
  try {
    const content = decodeSnapshot(JSON.parse(fs.readFileSync(file, "utf8")));
    if (content !== null) return content;
  } catch {
    // fichier corrompu
  }
  // copie d'un autre format (ex. 1.2.0) ou illisible : même message que « rien de mémorisé »
  throw none;
}
