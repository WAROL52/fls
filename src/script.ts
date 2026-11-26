// Parseur et sérialiseur du script plat (syntaxe v1) : lignes, directives, blocs littéraux,
// zone clip et forme `#@`. L'expansion de la syntaxe v2 (`src/expand/`) s'appuie sur les mêmes
// briques et produit des `Op` que ce module sait sérialiser.

import { SPEC_BY_NAME } from "./directive/index.ts";
import { syntaxError } from "./errors.ts";
import { blockLines, quote, tokenize } from "./text.ts";
import type { Op, Spec, Token } from "./types.ts";

// ───────────────────────────── Parseur de script ─────────────────────────────

export const M = {
  searchOpen: "<<<<<<< SEARCH",
  /** Syntaxe v2 : bloc dont le contenu est interpolé (`{{ expr }}`). */
  searchTemplateOpen: "<<<<<<< SEARCH TEMPLATE",
  templateOpen: "<<<<<<< TEMPLATE",
  sep: "=======",
  replaceClose: ">>>>>>> REPLACE",
  contentOpen: "<<<<<<< CONTENT",
  contentClose: ">>>>>>> END",
  rewriteOpen: "<<<<<<< REWRITE",
  rewriteClose: ">>>>>>> END",
};

export const nextNonBlank = (lines: string[], from: number): number => {
  let i = from;
  while (i < lines.length && lines[i].trim() === "") i += 1;
  return i;
};

export function takeUntil(lines: string[], from: number, end: string, opLine: number): { body: string[]; next: number } {
  const at = lines.indexOf(end, from);
  if (at === -1) throw syntaxError(opLine, `marqueur ${end} manquant`);
  return { body: lines.slice(from, at), next: at + 1 };
}

/** Ce qu'un lecteur de bloc rend : la ligne suivante, et quels blocs sont interpolés (syntaxe v2 seulement). */
export interface BlockRead {
  next: number;
  /** Un booléen par bloc SEARCH / REPLACE, ou un seul pour un bloc CONTENT. */
  templated: boolean[];
}

function readEdits(lines: string[], start: number, op: Op, v2: boolean): BlockRead {
  const templated: boolean[] = [];
  let i = nextNonBlank(lines, start);
  while (lines[i] === M.searchOpen || (v2 && lines[i] === M.searchTemplateOpen)) {
    templated.push(lines[i] === M.searchTemplateOpen);
    const search = takeUntil(lines, i + 1, M.sep, op.line);
    const replace = takeUntil(lines, search.next, M.replaceClose, op.line);
    const searchText = search.body.join("\n");
    if (searchText === "") throw syntaxError(op.line, "SEARCH vide (pour créer un fichier, utilise @create)");
    op.edits.push({ search: searchText, replace: replace.body.join("\n") });
    i = nextNonBlank(lines, replace.next);
  }
  if (op.edits.length === 0) throw syntaxError(op.line, `@edit attend un bloc ${M.searchOpen}`);
  return { next: i, templated };
}

function readContent(lines: string[], start: number, op: Op, v2: boolean): BlockRead {
  const i = nextNonBlank(lines, start);
  const templated = v2 && lines[i] === M.templateOpen;
  if (lines[i] !== M.contentOpen && !templated) throw syntaxError(op.line, `@${op.name} attend un bloc ${M.contentOpen}`);
  const body = takeUntil(lines, i + 1, M.contentClose, op.line);
  op.content = body.body.length === 0 ? "" : `${body.body.join("\n")}\n`;
  return { next: body.next, templated: [templated] };
}

/** Bloc REWRITE optionnel : son absence laisse la place à l'option `--rewrite`. */
function readRewrite(lines: string[], start: number, op: Op, _v2: boolean): BlockRead {
  const i = nextNonBlank(lines, start);
  if (lines[i] !== M.rewriteOpen) return { next: start, templated: [] };
  const body = takeUntil(lines, i + 1, M.rewriteClose, op.line);
  op.rewriteBlock = true;
  op.content = body.body.join("\n");
  return { next: body.next, templated: [] };
}

function readInsert(lines: string[], start: number, op: Op, _v2: boolean): BlockRead {
  let i = nextNonBlank(lines, start);
  if (lines[i] === M.searchOpen) {
    const anchor = takeUntil(lines, i + 1, M.contentClose, op.line);
    op.anchor = anchor.body.join("\n");
    op.anchorBlock = true;
    i = nextNonBlank(lines, anchor.next);
  }
  if (lines[i] !== M.contentOpen) throw syntaxError(op.line, `@${op.name} attend un bloc ${M.contentOpen}`);
  const body = takeUntil(lines, i + 1, M.contentClose, op.line);
  op.content = body.body.join("\n");
  return { next: body.next, templated: [] };
}

export const BLOCK_READERS: Record<Spec["block"], (lines: string[], start: number, op: Op, v2: boolean) => BlockRead> = {
  none: (_lines, start) => ({ next: start, templated: [] }),
  edit: readEdits,
  content: readContent,
  rewrite: readRewrite,
  insert: readInsert,
};

const optionName = (spec: Spec, tok: Token): string | null => {
  if (tok.quoted) return null;
  if (Object.hasOwn(spec.aliases, tok.text)) return spec.aliases[tok.text];
  return tok.text.startsWith("--") ? tok.text.slice(2) : null;
};

function parseDirective(line: string, lineNo: number): Op {
  const tokens = tokenize(line);
  if (tokens === null) throw syntaxError(lineNo, "guillemet non fermé");
  return opFromTokens(tokens, lineNo);
}

/** Une `Op` à partir des mots d'une ligne de directive (le premier est `@nom`) : options, arguments, arité. */
export function opFromTokens(tokens: Token[], lineNo: number): Op {
  const [head, ...rest] = tokens;
  const spec = SPEC_BY_NAME.get(head.text.slice(1));
  if (spec === undefined) throw syntaxError(lineNo, `directive inconnue ${head.text}`);
  const op: Op = { line: lineNo, name: spec.name, args: [], opts: {}, edits: [], content: "", anchor: "" };
  for (let i = 0; i < rest.length; i++) {
    const name = optionName(spec, rest[i]);
    if (name === null) {
      op.args.push(rest[i].text);
      continue;
    }
    const kind = Object.hasOwn(spec.options, name) ? spec.options[name] : undefined;
    if (kind === undefined) throw syntaxError(lineNo, `option inconnue --${name} pour @${spec.name}`);
    if (kind === "flag") {
      op.opts[name] = true;
      continue;
    }
    if (kind === "optvalue") {
      const next = rest[i + 1];
      if (next === undefined || (!next.quoted && next.text.startsWith("--"))) {
        op.opts[name] = true;
        continue;
      }
      i += 1;
      op.opts[name] = next.text;
      continue;
    }
    i += 1;
    if (i >= rest.length) throw syntaxError(lineNo, `--${name} attend une valeur`);
    op.opts[name] = rest[i].text;
  }
  const [min, max] = spec.positional;
  if (op.args.length < min || op.args.length > max) {
    throw syntaxError(lineNo, `@${spec.name} attend entre ${min} et ${max} argument(s), reçu ${op.args.length}`);
  }
  return op;
}

const CLIP_MARKER = /^\s*#{3,}\s*clip\s+(start|end)\s*#*\s*$/i;
export const HASH_DIRECTIVE = /^#@[A-Za-z]/;
export const HASH_NAME = /^#@([A-Za-z][A-Za-z_]*)/;

/**
 * Zone utile d'un script collé : si au moins un `clip start` existe, seules les lignes entre
 * `clip start` et `clip end` (ou la fin) sont gardées ; le reste est blanchi (la numérotation
 * des lignes est conservée pour les messages d'erreur).
 */
export function clipRegions(lines: string[]): string[] {
  const marks = lines.map((l) => CLIP_MARKER.exec(l)?.[1].toLowerCase());
  if (!marks.includes("start")) return lines;
  let inside = false;
  return lines.map((line, i) => {
    const mark = marks[i];
    if (mark !== undefined) {
      inside = mark === "start";
      return "";
    }
    return inside ? line : "";
  });
}

/** La forme `#@nom` est réservée aux directives qui n'écrivent pas. */
export function checkHashed(name: string, lineNo: number): void {
  const spec = SPEC_BY_NAME.get(name);
  if (spec === undefined) throw syntaxError(lineNo, `directive inconnue #@${name}`);
  if (spec.writes) throw syntaxError(lineNo, `#@${name} : les directives d'écriture exigent la forme @${name}`);
}

/** `#@nom …` (collé à une lettre) devient `@nom …` ; réservé aux directives de lecture. */
function unhash(trimmed: string, lineNo: number): string {
  checkHashed(HASH_NAME.exec(trimmed)?.[1] as string, lineNo);
  return trimmed.slice(1);
}

export function parseScript(text: string): Op[] {
  const lines = clipRegions(text.split(/\r?\n/));
  const ops: Op[] = [];
  let i = 0;
  while (i < lines.length) {
    let trimmed = lines[i].trim();
    if (HASH_DIRECTIVE.test(trimmed)) trimmed = unhash(trimmed, i + 1);
    else if (trimmed === "" || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }
    if (!trimmed.startsWith("@")) throw syntaxError(i + 1, "ligne inattendue (une directive commence par @)");
    const op = parseDirective(trimmed, i + 1);
    i = BLOCK_READERS[(SPEC_BY_NAME.get(op.name) as Spec).block](lines, i + 1, op, false).next;
    ops.push(op);
  }
  return ops;
}

export function makeOp(name: string, args: string[]): Op {
  return { line: 0, name, args, opts: {}, edits: [], content: "", anchor: "" };
}

// ───────────────────────────── Script plat (sérialisation) ─────────────────────────────

const BLOCK_WRITERS: Record<Spec["block"], (op: Op) => string[]> = {
  none: () => [],
  edit: (op) => op.edits.flatMap((e) => [M.searchOpen, ...blockLines(e.search), M.sep, ...blockLines(e.replace), M.replaceClose]),
  content: (op) => [M.contentOpen, ...blockLines(op.content.replace(/\n$/, "")), M.contentClose],
  rewrite: (op) => (op.rewriteBlock === true ? [M.rewriteOpen, ...blockLines(op.content), M.rewriteClose] : []),
  insert: (op) => [
    ...(op.anchorBlock === true ? [M.searchOpen, ...blockLines(op.anchor), M.contentClose] : []),
    M.contentOpen, ...blockLines(op.content), M.contentClose,
  ],
};

export function serializeOp(op: Op): string {
  const options = Object.entries(op.opts).flatMap(([k, v]) => (v === true ? [`--${k}`] : [`--${k}`, quote(v)]));
  const head = [`@${op.name}`, ...op.args.map(quote), ...options].join(" ");
  return [head, ...BLOCK_WRITERS[(SPEC_BY_NAME.get(op.name) as Spec).block](op)].join("\n");
}
export const serialize = (ops: Op[]): string => ops.map((o) => `${serializeOp(o)}\n`).join("\n");

