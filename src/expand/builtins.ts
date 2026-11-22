// Fonctions intégrées de la syntaxe v2. Lecture seule, mêmes règles que les directives de lecture :
// confinement au dossier courant, liens non suivis, binaires et fichiers trop gros refusés, règles
// d'ignore pour `glob`. Ni shell, ni réseau, ni horloge, ni aléatoire : une expansion est déterministe.

import * as path from "node:path";
import { collectFiles } from "../directive/shared.ts";
import { normalizeRel } from "../paths.ts";
import { splitLines } from "../text.ts";
import type { Ignore } from "../types.ts";
import type { Workspace } from "../workspace.ts";
import { fail, limitedList, limitedText, MAX_ITEMS, safeInt, typeName, type Value } from "./values.ts";

export interface BuiltinCtx {
  ws: Workspace;
  ignore: Ignore;
}

interface Builtin {
  name: string;
  /** Signature et résultat, pour `fls spec`. */
  usage: string;
  doc: string;
  /** Types des paramètres (`texte`, `entier`, `liste`, `tout`) ; `?` = facultatif. */
  params: string[];
  run: (a: Value[], c: BuiltinCtx) => Value;
}

// `*`, `**` et `?` comme dans les ignores ; un `**` suivi de `/` accepte aussi zéro dossier (`src/**/*.ts` inclut `src/a.ts`).
function globRegex(pattern: string): RegExp {
  const re = pattern.replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, (m) => {
    if (m === "**/") return "(?:.*/)?";
    if (m === "**") return ".*";
    if (m === "*") return "[^/]*";
    if (m === "?") return "[^/]";
    return `\\${m}`;
  });
  return new RegExp(`^${re}$`);
}

function glob(pattern: string, c: BuiltinCtx): Value {
  const clean = pattern.replace(/^\.\//, "");
  if (clean.startsWith("/") || clean.split("/").includes("..")) throw fail(`glob : motif hors du dossier courant : ${pattern}`);
  const re = globRegex(clean);
  const found = collectFiles(c, "").filter((rel) => re.test(rel) && c.ws.kind(rel) === "file");
  return limitedList(found.sort());
}

const pathKind = (c: BuiltinCtx, p: string) => c.ws.kind(normalizeRel(p));
const readText = (c: BuiltinCtx, p: string): string => c.ws.text(normalizeRel(p));

function sortedList(l: Value[]): Value {
  if (l.every((x) => typeof x === "string")) return [...l].sort();
  if (l.every((x) => typeof x === "number")) return [...l].sort((x, y) => (x as number) - (y as number));
  throw fail("sorted : une liste de textes ou d'entiers seulement");
}

function toInt(v: Value): Value {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return safeInt(Number(v));
  throw fail(`int : impossible de convertir ${typeof v === "string" ? JSON.stringify(v) : typeName(v)} en entier`);
}

function toText(v: Value): Value {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  throw fail(`str : un texte, un entier ou un booléen seulement (reçu : ${typeName(v)})`);
}

function sizeOf(v: Value): Value {
  if (typeof v === "string" || Array.isArray(v)) return v.length;
  if (v instanceof Map) return v.size;
  throw fail(`len : un texte, une liste ou un dictionnaire seulement (reçu : ${typeName(v)})`);
}

function rangeOf(a: Value[]): Value {
  const [from, to] = a.length === 1 ? [0, a[0] as number] : [a[0] as number, a[1] as number];
  if (to - from > MAX_ITEMS) throw fail(`range : plus de ${MAX_ITEMS} éléments`);
  return Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
}

function joinText(l: Value[], sep: string): Value {
  if (!l.every((x) => typeof x === "string")) throw fail("join : une liste de textes seulement");
  return limitedText(l.join(sep));
}

function splitText(s: string, sep: string): Value {
  if (sep === "") throw fail("split : le séparateur est vide");
  return limitedList(s.split(sep));
}

function replaceText(s: string, from: string, to: string): Value {
  if (from === "") throw fail("replace : le texte à remplacer est vide");
  return limitedText(s.split(from).join(to));
}

const baseName = (p: string): string => path.posix.basename(p);
const dirName = (p: string): string => path.posix.dirname(p).replace(/^\.$/, "");
const stemOf = (p: string): string => {
  const b = baseName(p);
  const dot = b.lastIndexOf(".");
  return dot <= 0 ? b : b.slice(0, dot);
};

export const BUILTINS: Builtin[] = [
  { name: "glob", usage: "glob(motif) -> liste", doc: "fichiers qui correspondent (`*`, `**`, `?`), triés, sans les fichiers ignorés", params: ["texte"], run: (a, c) => glob(a[0] as string, c) },
  { name: "exists", usage: "exists(chemin) -> booléen", doc: "le chemin existe sur le disque", params: ["texte"], run: (a, c) => pathKind(c, a[0] as string) !== null },
  { name: "is_file", usage: "is_file(chemin) -> booléen", doc: "c'est un fichier", params: ["texte"], run: (a, c) => pathKind(c, a[0] as string) === "file" },
  { name: "is_dir", usage: "is_dir(chemin) -> booléen", doc: "c'est un dossier", params: ["texte"], run: (a, c) => pathKind(c, a[0] as string) === "dir" },
  { name: "read", usage: "read(chemin) -> texte", doc: "contenu d'un fichier texte", params: ["texte"], run: (a, c) => readText(c, a[0] as string) },
  { name: "lines", usage: "lines(chemin) -> liste", doc: "lignes d'un fichier texte", params: ["texte"], run: (a, c) => splitLines(readText(c, a[0] as string)) },
  { name: "len", usage: "len(x) -> entier", doc: "taille d'un texte, d'une liste ou d'un dictionnaire", params: ["tout"], run: (a) => sizeOf(a[0]) },
  { name: "range", usage: "range(n) ou range(a, b) -> liste", doc: "entiers de 0 à n-1, ou de a à b-1", params: ["entier", "entier?"], run: (a) => rangeOf(a) },
  { name: "sorted", usage: "sorted(liste) -> liste", doc: "tri d'une liste de textes ou d'entiers", params: ["liste"], run: (a) => sortedList(a[0] as Value[]) },
  { name: "join", usage: "join(liste, séparateur) -> texte", doc: "assemble une liste de textes", params: ["liste", "texte"], run: (a) => joinText(a[0] as Value[], a[1] as string) },
  { name: "split", usage: "split(texte, séparateur) -> liste", doc: "découpe un texte", params: ["texte", "texte"], run: (a) => splitText(a[0] as string, a[1] as string) },
  { name: "replace", usage: "replace(texte, ancien, nouveau) -> texte", doc: "remplace toutes les occurrences (littéral)", params: ["texte", "texte", "texte"], run: (a) => replaceText(a[0] as string, a[1] as string, a[2] as string) },
  { name: "upper", usage: "upper(texte) -> texte", doc: "majuscules", params: ["texte"], run: (a) => (a[0] as string).toUpperCase() },
  { name: "lower", usage: "lower(texte) -> texte", doc: "minuscules", params: ["texte"], run: (a) => (a[0] as string).toLowerCase() },
  { name: "capitalize", usage: "capitalize(texte) -> texte", doc: "première lettre en majuscule, le reste inchangé (`buttonGroup` -> `ButtonGroup`)", params: ["texte"], run: (a) => (a[0] as string).replace(/^./, (c) => c.toUpperCase()) },
  { name: "strip", usage: "strip(texte) -> texte", doc: "retire les espaces au début et à la fin", params: ["texte"], run: (a) => (a[0] as string).trim() },
  { name: "startswith", usage: "startswith(texte, préfixe) -> booléen", doc: "commence par", params: ["texte", "texte"], run: (a) => (a[0] as string).startsWith(a[1] as string) },
  { name: "endswith", usage: "endswith(texte, suffixe) -> booléen", doc: "finit par", params: ["texte", "texte"], run: (a) => (a[0] as string).endsWith(a[1] as string) },
  { name: "basename", usage: "basename(chemin) -> texte", doc: "dernier élément (`a/b.ts` -> `b.ts`)", params: ["texte"], run: (a) => baseName(a[0] as string) },
  { name: "dirname", usage: "dirname(chemin) -> texte", doc: "dossier parent (`a/b.ts` -> `a`, vide à la racine)", params: ["texte"], run: (a) => dirName(a[0] as string) },
  { name: "stem", usage: "stem(chemin) -> texte", doc: "nom sans extension (`a/b.test.ts` -> `b.test`)", params: ["texte"], run: (a) => stemOf(a[0] as string) },
  { name: "int", usage: "int(x) -> entier", doc: "convertit un texte d'entier ou un booléen", params: ["tout"], run: (a) => toInt(a[0]) },
  { name: "str", usage: "str(x) -> texte", doc: "convertit un entier ou un booléen (`True` / `False`)", params: ["tout"], run: (a) => toText(a[0]) },
];

const BY_NAME = new Map(BUILTINS.map((b) => [b.name, b]));

/** Appelle une fonction intégrée : vérifie le nombre et le type des arguments. */
export function callBuiltin(name: string, args: Value[], c: BuiltinCtx): Value {
  const b = BY_NAME.get(name);
  if (b === undefined) throw fail(`fonction inconnue : ${name} (voir fls spec)`);
  const required = b.params.filter((p) => !p.endsWith("?")).length;
  if (args.length < required || args.length > b.params.length) {
    throw fail(`${name} attend ${required === b.params.length ? required : `${required} ou ${b.params.length}`} argument(s), reçu ${args.length}`);
  }
  args.forEach((arg, i) => {
    const want = b.params[i].replace("?", "");
    if (want !== "tout" && typeName(arg) !== want) throw fail(`${name} : l'argument ${i + 1} doit être de type ${want} (reçu : ${typeName(arg)})`);
  });
  return b.run(args, c);
}
