// Les valeurs de la syntaxe v2 : texte, entier, booléen, liste, dictionnaire. Aucune autre (ni
// flottant, ni null) : le langage reste petit et ses erreurs lisibles.

import { FlsError } from "../errors.ts";

export type Dict = Map<string | number, Value>;
export type Value = string | number | boolean | Value[] | Dict;

export const fail = (message: string): FlsError => new FlsError("expansion_error", message);

/** Plafonds contre les explosions de taille (un texte qui double à chaque tour de boucle). */
export const MAX_TEXT = 1_000_000;
export const MAX_ITEMS = 10_000;

export function typeName(v: Value): string {
  if (typeof v === "string") return "texte";
  if (typeof v === "number") return "entier";
  if (typeof v === "boolean") return "booléen";
  return Array.isArray(v) ? "liste" : "dictionnaire";
}

export function truthy(v: Value): boolean {
  if (typeof v === "string" || Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  return Boolean(v);
}

export function equal(a: Value, b: Value): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (a instanceof Map && b instanceof Map) return a.size === b.size && [...a].every(([k, v]) => b.has(k) && equal(v, b.get(k) as Value));
  return a === b;
}

export function limitedText(s: string): string {
  if (s.length > MAX_TEXT) throw fail(`texte trop long (plus de ${MAX_TEXT} caractères)`);
  return s;
}

export function limitedList<T>(l: T[]): T[] {
  if (l.length > MAX_ITEMS) throw fail(`liste trop longue (plus de ${MAX_ITEMS} éléments)`);
  return l;
}

export function safeInt(n: number): number {
  if (!Number.isSafeInteger(n)) throw fail("entier trop grand");
  return n;
}

/** Ce qu'une interpolation `{{ … }}` accepte : un texte ou un entier. */
export function interpolated(v: Value): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  throw fail(`{{ }} attend un texte ou un entier (reçu : ${typeName(v)})`);
}
