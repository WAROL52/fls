// Lecture d'options numériques de la ligne de commande.

import { FlsError } from "./errors.ts";
import type { Args } from "./types.ts";

/** Entier >= 1 passé avec `--nom valeur`, ou `fallback` si l'option est absente. */
export function numberArg<T extends number | undefined>(args: Args, name: string, fallback: T): number | T {
  const raw = args.values.get(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new FlsError("usage_error", `--${name} attend un entier >= 1 (reçu : ${raw})`);
  return n;
}
