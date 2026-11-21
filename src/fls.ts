#!/usr/bin/env node
/**
 * fls v1 — lire et modifier des fichiers en une seule commande, sans interaction.
 * Voir SPEC.md. Aucune dépendance hors Node.js (>= 22).
 *
 * Choix de conception pour tenir 100 % de couverture sans astuces :
 *  - toutes les E/S « de l'environnement » passent par `Io` (cwd, stdin, stdout, presse-papiers, horloge, id) ;
 *  - les directives et sous-commandes sont des tables, pas des chaînes de if/else ;
 *  - tout le travail se fait sur une surcouche en mémoire (`Workspace`) : le dry-run et l'exécution
 *    réelle partagent le même code, seul le « commit » final diffère ;
 *  - seulement de la syntaxe TypeScript effaçable (pas d'enum ni de propriétés de paramètre),
 *    donc `node fls.ts` fonctionne directement.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isatty } from "node:tty";
import { pathToFileURL } from "node:url";

export const VERSION = "1.0.0";
const DEFAULT_MAX_SIZE = 1_048_576;
const DEFAULT_MAX_OUTPUT = 200_000;
const BINARY_SNIFF = 8000;
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// ───────────────────────────── Types ─────────────────────────────

export type Kind = "file" | "dir" | "link";
export interface Edit {
  search: string;
  replace: string;
}
export interface Op {
  line: number;
  name: string;
  args: string[];
  opts: Record<string, string | true>;
  edits: Edit[];
  content: string;
}
export interface Result {
  status: "OK" | "FAIL" | "SKIP";
  kind: string;
  title: string;
  body: string;
  code: string;
}
export interface Report {
  text: string;
  code: number;
}
export type Ignore = (rel: string, isDir: boolean) => boolean;
export interface Ctx {
  ws: Workspace;
  ignore: Ignore;
}
export interface Clipboard {
  read(): string;
  write(text: string): void;
}
export interface Runner {
  capture(cmd: string, args: string[]): string | null;
  feed(cmd: string, args: string[], text: string): boolean;
}
export interface Io {
  cwd: string;
  stdinIsTTY: boolean;
  readStdin(): string;
  out(text: string): void;
  err(text: string): void;
  clipboard: Clipboard;
  now(): Date;
  newId(now: Date): string;
}
export interface Args {
  positional: string[];
  flags: Set<string>;
  values: Map<string, string>;
  ignore: string[];
}
export interface Spec {
  name: string;
  summary: string;
  usage: string;
  options: Record<string, "flag" | "value">;
  aliases: Record<string, string>;
  positional: [number, number];
  block: "none" | "edit" | "content";
  writes: boolean;
  optionDocs: string[];
  examples: string[];
  run: (ctx: Ctx, op: Op) => { title: string; body: string };
}
interface Entry {
  data: Buffer | null;
  mode: number;
}
export interface Pending {
  rel: string;
  before: Buffer | null;
  data: Buffer | null;
  mode: number;
}
export interface JournalEntry {
  path: string;
  backup: string | null;
  mode: number;
  after: string | null;
}
export interface RunMeta {
  id: string;
  date: string;
  undone: boolean;
  files: JournalEntry[];
}

// ───────────────────────────── Erreurs ─────────────────────────────

export class FlsError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FlsError";
    this.code = code;
  }
}
const syntaxError = (line: number, detail: string): FlsError =>
  new FlsError("syntax_error", `ligne ${line} : ${detail}`);
const USAGE_CODES = new Set(["syntax_error", "usage_error", "unknown_directive"]);

export const ERROR_CODES: Array<[string, string]> = [
  ["syntax_error", "script mal formé (rien n'a été exécuté, code de sortie 2)"],
  ["usage_error", "mauvaise utilisation de la ligne de commande (code de sortie 2)"],
  ["unknown_directive", "`fls help` : directive inconnue (code de sortie 2)"],
  ["not_found", "chemin ou texte SEARCH introuvable"],
  ["ambiguous_match", "SEARCH trouvé plusieurs fois (les numéros de ligne sont indiqués)"],
  ["already_exists", "la destination existe déjà"],
  ["outside_workspace", "chemin absolu, `..` ou lien symbolique sortant du dossier courant"],
  ["is_directory", "un fichier était attendu, c'est un dossier"],
  ["not_a_directory", "un dossier était attendu, c'est un fichier"],
  ["symlink", "les liens symboliques ne sont jamais suivis ni modifiés"],
  ["binary_file", "fichier binaire (octet nul détecté)"],
  ["too_large", "fichier plus grand que --max-size"],
  ["not_utf8", "le fichier n'est pas de l'UTF-8 valide"],
  ["invalid_argument", "valeur d'argument ou d'option invalide"],
  ["skipped", "écriture ignorée parce qu'une écriture précédente a échoué"],
  ["run_not_found", "identifiant de run inconnu"],
  ["already_undone", "ce run a déjà été annulé"],
  ["nothing_to_undo", "aucun run à annuler"],
  ["conflict", "des fichiers ont changé depuis le run (undo refusé sans --force)"],
  ["clipboard_unavailable", "aucun outil de presse-papiers trouvé"],
];

// ───────────────────────────── Texte ─────────────────────────────

export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
const blockLines = (t: string): string[] => (t === "" ? [] : t.split("\n"));
const lineAt = (text: string, pos: number): number => text.slice(0, pos).split("\n").length;
const joinRel = (rel: string, name: string): string => (rel === "" ? name : `${rel}/${name}`);
const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, k) => a + k);

export function quote(t: string): string {
  return /^[^\s"\\-][^\s"\\]*$/.test(t) ? t : `"${t.replace(/(["\\])/g, "\\$1")}"`;
}

interface Token {
  text: string;
  quoted: boolean;
}
export function tokenize(line: string): Token[] | null {
  const tokens: Token[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\[\s\S])*)"|([^\s"]\S*))/y;
  let pos = 0;
  for (;;) {
    re.lastIndex = pos;
    const m = re.exec(line);
    if (m === null) break;
    tokens.push(m[1] !== undefined ? { text: m[1].replace(/\\(["\\])/g, "$1"), quoted: true } : { text: m[2], quoted: false });
    pos = re.lastIndex;
  }
  return line.slice(pos).trim() === "" ? tokens : null;
}

// ───────────────────────────── Chemins et ignore ─────────────────────────────

export function normalizeRel(p: string): string {
  if (path.isAbsolute(p)) throw new FlsError("outside_workspace", `chemin absolu refusé : ${p}`);
  const n = path.posix.normalize(p);
  if (n === ".." || n.startsWith("../")) throw new FlsError("outside_workspace", `chemin hors du dossier courant : ${p}`);
  return n === "." ? "" : n.replace(/\/$/, "");
}

const GLOB: Record<string, string> = { "**": ".*", "*": "[^/]*", "?": "[^/]" };
const escapeRe = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
const escapeAll = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const globToRegex = (g: string): RegExp => new RegExp("^" + escapeRe(g).replace(/\*\*|\*|\?/g, (m) => GLOB[m]) + "$");

interface Rule {
  re: RegExp;
  dirOnly: boolean;
  anchored: boolean;
}
function toRule(raw: string): Rule {
  const trimmed = raw.replace(/\/$/, "");
  return {
    re: globToRegex(trimmed.replace(/^\//, "")),
    dirOnly: raw.endsWith("/"),
    anchored: trimmed.includes("/"),
  };
}
export function compileIgnore(lines: string[]): Ignore {
  const rules = lines
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith("!"))
    .map(toRule);
  return (rel, isDir) => rules.some((r) => (!r.dirOnly || isDir) && r.re.test(r.anchored ? rel : path.posix.basename(rel)));
}
export function loadIgnore(ws: Workspace, extra: string[]): Ignore {
  const fromFiles = [".gitignore", ".flsignore"].flatMap((f) => (ws.kind(f) === "file" ? splitLines(ws.text(f)) : []));
  return compileIgnore([".git/", "node_modules/", ".fls/", ...extra, ...fromFiles]);
}

// ───────────────────────────── Workspace (surcouche en mémoire) ─────────────────────────────

const sha1 = (b: Buffer): string => createHash("sha1").update(b).digest("hex");
const same = (a: Buffer | null, b: Buffer | null): boolean => (a === null || b === null ? a === b : a.equals(b));
const prefixOf = (rel: string): string => (rel === "" ? "" : `${rel}/`);
/** lstat qui renvoie undefined pour ENOENT *et* ENOTDIR (un parent est un fichier). */
const lstatSafe = (abs: string): fs.Stats | undefined => {
  try {
    return fs.lstatSync(abs);
  } catch {
    return undefined;
  }
};

export class Workspace {
  root: string;
  maxSize: number;
  changes: Map<string, Entry> = new Map();
  private realRoot: string;

  constructor(root: string, maxSize: number) {
    this.root = root;
    this.maxSize = maxSize;
    this.realRoot = fs.realpathSync(root);
  }

  /** Chemin absolu validé : refuse tout ce qui, liens symboliques compris, sort du dossier courant. */
  resolve(rel: string): string {
    const abs = path.join(this.root, rel);
    let probe = abs;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    const outside = path.relative(this.realRoot, fs.realpathSync(probe));
    if (outside === ".." || outside.startsWith(".." + path.sep) || path.isAbsolute(outside)) {
      throw new FlsError("outside_workspace", `${rel} sort du dossier courant (lien symbolique)`);
    }
    return abs;
  }

  kind(rel: string): Kind | null {
    const e = this.changes.get(rel);
    if (e !== undefined) return e.data === null ? null : "file";
    const st = lstatSafe(path.join(this.root, rel));
    if (st === undefined) return this.hasVirtualChild(rel) ? "dir" : null;
    return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file";
  }

  private hasVirtualChild(rel: string): boolean {
    const prefix = prefixOf(rel);
    return [...this.changes].some(([p, e]) => e.data !== null && p.startsWith(prefix));
  }

  linkTarget(rel: string): string {
    return fs.readlinkSync(path.join(this.root, rel));
  }

  requireFile(rel: string): void {
    const k = this.kind(rel);
    if (k === null) throw new FlsError("not_found", `introuvable : ${rel}`);
    if (k === "dir") throw new FlsError("is_directory", `${rel} est un dossier (seuls les fichiers sont gérés en v1)`);
    if (k === "link") throw new FlsError("symlink", `${rel} est un lien symbolique (non suivi)`);
  }

  get(rel: string): Buffer {
    this.requireFile(rel);
    const e = this.changes.get(rel);
    return e === undefined ? fs.readFileSync(this.resolve(rel)) : (e.data as Buffer);
  }

  text(rel: string): string {
    const buf = this.get(rel);
    if (buf.length > this.maxSize) throw new FlsError("too_large", `${rel} : ${buf.length} octets > --max-size ${this.maxSize}`);
    if (buf.subarray(0, BINARY_SNIFF).includes(0)) throw new FlsError("binary_file", `${rel} est un fichier binaire`);
    try {
      return DECODER.decode(buf);
    } catch {
      throw new FlsError("not_utf8", `${rel} n'est pas de l'UTF-8 valide`);
    }
  }

  modeOf(rel: string): number {
    const e = this.changes.get(rel);
    if (e !== undefined) return e.mode;
    const st = fs.statSync(this.resolve(rel), { throwIfNoEntry: false });
    return st === undefined ? 0o644 : st.mode & 0o777;
  }

  write(rel: string, data: Buffer): void {
    const k = this.kind(rel);
    if (k === "dir") throw new FlsError("is_directory", `${rel} est un dossier`);
    if (k === "link") throw new FlsError("symlink", `${rel} est un lien symbolique (non suivi)`);
    for (let p = path.posix.dirname(rel); p !== "."; p = path.posix.dirname(p)) {
      if (this.kind(p) === "file") throw new FlsError("not_a_directory", `${p} est un fichier`);
    }
    this.resolve(rel);
    this.changes.set(rel, { data, mode: this.modeOf(rel) });
  }

  remove(rel: string): void {
    this.requireFile(rel);
    this.changes.set(rel, { data: null, mode: 0o644 });
  }

  move(from: string, to: string): void {
    this.requireFile(from);
    if (this.kind(to) !== null) throw new FlsError("already_exists", `${to} existe déjà`);
    const data = this.get(from);
    const mode = this.modeOf(from);
    this.write(to, data);
    (this.changes.get(to) as Entry).mode = mode;
    this.remove(from);
  }

  list(rel: string): string[] {
    const st = lstatSafe(path.join(this.root, rel));
    const names = new Set<string>(st !== undefined && st.isDirectory() ? fs.readdirSync(this.resolve(rel)) : []);
    const prefix = prefixOf(rel);
    for (const [p, e] of this.changes) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (e.data !== null) names.add(slash === -1 ? rest : rest.slice(0, slash));
      else if (slash === -1) names.delete(rest);
    }
    return [...names].sort();
  }

  diskFile(rel: string): Buffer | null {
    const st = lstatSafe(path.join(this.root, rel));
    return st !== undefined && st.isFile() ? fs.readFileSync(this.resolve(rel)) : null;
  }

  /** Changements réels (ceux qui laissent le disque différent de l'état simulé). */
  pending(): Pending[] {
    return [...this.changes]
      .map(([rel, e]) => ({ rel, before: this.diskFile(rel), data: e.data, mode: e.mode }))
      .filter((p) => !same(p.before, p.data));
  }

  /** Écrit sur le disque (fichier temporaire puis rename) et sauvegarde l'état d'avant. */
  apply(pending: Pending[], backupDir: string): JournalEntry[] {
    return pending.map((p, k) => {
      const abs = this.resolve(p.rel);
      const backup = p.before === null ? null : String(k);
      const mode = p.before === null ? 0o644 : fs.statSync(abs).mode & 0o777;
      if (p.before !== null) fs.writeFileSync(path.join(backupDir, String(k)), p.before);
      if (p.data === null) {
        fs.unlinkSync(abs);
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const tmp = `${abs}.fls-tmp`;
        fs.writeFileSync(tmp, p.data);
        fs.chmodSync(tmp, p.mode);
        fs.renameSync(tmp, abs);
      }
      return { path: p.rel, backup, mode, after: p.data === null ? null : sha1(p.data) };
    });
  }
}

// ───────────────────────────── Parseur de script ─────────────────────────────

const M = {
  searchOpen: "<<<<<<< SEARCH",
  sep: "=======",
  replaceClose: ">>>>>>> REPLACE",
  contentOpen: "<<<<<<< CONTENT",
  contentClose: ">>>>>>> END",
};

const nextNonBlank = (lines: string[], from: number): number => {
  let i = from;
  while (i < lines.length && lines[i].trim() === "") i += 1;
  return i;
};

function takeUntil(lines: string[], from: number, end: string, opLine: number): { body: string[]; next: number } {
  const at = lines.indexOf(end, from);
  if (at === -1) throw syntaxError(opLine, `marqueur ${end} manquant`);
  return { body: lines.slice(from, at), next: at + 1 };
}

function readEdits(lines: string[], start: number, op: Op): number {
  let i = nextNonBlank(lines, start);
  while (lines[i] === M.searchOpen) {
    const search = takeUntil(lines, i + 1, M.sep, op.line);
    const replace = takeUntil(lines, search.next, M.replaceClose, op.line);
    const searchText = search.body.join("\n");
    if (searchText === "") throw syntaxError(op.line, "SEARCH vide (pour créer un fichier, utilise @create)");
    op.edits.push({ search: searchText, replace: replace.body.join("\n") });
    i = nextNonBlank(lines, replace.next);
  }
  if (op.edits.length === 0) throw syntaxError(op.line, `@edit attend un bloc ${M.searchOpen}`);
  return i;
}

function readContent(lines: string[], start: number, op: Op): number {
  const i = nextNonBlank(lines, start);
  if (lines[i] !== M.contentOpen) throw syntaxError(op.line, `@${op.name} attend un bloc ${M.contentOpen}`);
  const body = takeUntil(lines, i + 1, M.contentClose, op.line);
  op.content = body.body.length === 0 ? "" : `${body.body.join("\n")}\n`;
  return body.next;
}

const BLOCK_READERS: Record<Spec["block"], (lines: string[], start: number, op: Op) => number> = {
  none: (_lines, start) => start,
  edit: readEdits,
  content: readContent,
};

const optionName = (spec: Spec, tok: Token): string | null => {
  if (tok.quoted) return null;
  if (Object.hasOwn(spec.aliases, tok.text)) return spec.aliases[tok.text];
  return tok.text.startsWith("--") ? tok.text.slice(2) : null;
};

function parseDirective(line: string, lineNo: number): Op {
  const tokens = tokenize(line);
  if (tokens === null) throw syntaxError(lineNo, "guillemet non fermé");
  const [head, ...rest] = tokens;
  const spec = SPEC_BY_NAME.get(head.text.slice(1));
  if (spec === undefined) throw syntaxError(lineNo, `directive inconnue ${head.text}`);
  const op: Op = { line: lineNo, name: spec.name, args: [], opts: {}, edits: [], content: "" };
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

export function parseScript(text: string): Op[] {
  const lines = text.split(/\r?\n/);
  const ops: Op[] = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }
    if (!trimmed.startsWith("@")) throw syntaxError(i + 1, "ligne inattendue (une directive commence par @)");
    const op = parseDirective(trimmed, i + 1);
    i = BLOCK_READERS[(SPEC_BY_NAME.get(op.name) as Spec).block](lines, i + 1, op);
    ops.push(op);
  }
  return ops;
}

export function makeOp(name: string, args: string[]): Op {
  return { line: 0, name, args, opts: {}, edits: [], content: "" };
}

// ───────────────────────────── Script plat (sérialisation) ─────────────────────────────

const BLOCK_WRITERS: Record<Spec["block"], (op: Op) => string[]> = {
  none: () => [],
  edit: (op) => op.edits.flatMap((e) => [M.searchOpen, ...blockLines(e.search), M.sep, ...blockLines(e.replace), M.replaceClose]),
  content: (op) => [M.contentOpen, ...blockLines(op.content.replace(/\n$/, "")), M.contentClose],
};

export function serializeOp(op: Op): string {
  const options = Object.entries(op.opts).flatMap(([k, v]) => (v === true ? [`--${k}`] : [`--${k}`, quote(v)]));
  const head = [`@${op.name}`, ...op.args.map(quote), ...options].join(" ");
  return [head, ...BLOCK_WRITERS[(SPEC_BY_NAME.get(op.name) as Spec).block](op)].join("\n");
}
export const serialize = (ops: Op[]): string => ops.map((o) => `${serializeOp(o)}\n`).join("\n");

// ───────────────────────────── Directives ─────────────────────────────

function intOpt(op: Op, name: string, fallback: number): number {
  const raw = op.opts[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new FlsError("invalid_argument", `--${name} attend un entier >= 0 (reçu : ${raw})`);
  return n;
}

function requireDir(ws: Workspace, rel: string): void {
  const k = ws.kind(rel);
  if (k === null) throw new FlsError("not_found", `introuvable : ${rel}`);
  if (k !== "dir") throw new FlsError("not_a_directory", `${rel} n'est pas un dossier`);
}

interface Child {
  name: string;
  rel: string;
  kind: Kind;
}
function children(ctx: Ctx, rel: string): Child[] {
  return ctx.ws
    .list(rel)
    .map((name) => ({ name, rel: joinRel(rel, name), kind: ctx.ws.kind(joinRel(rel, name)) as Kind }))
    .filter((c) => !ctx.ignore(c.rel, c.kind === "dir"));
}
const LABELS: Record<Kind, (ws: Workspace, c: Child) => string> = {
  dir: (_ws, c) => `${c.name}/`,
  link: (ws, c) => `${c.name} -> ${ws.linkTarget(c.rel)}`,
  file: (_ws, c) => c.name,
};
function treeLines(ctx: Ctx, rel: string, depth: number, dirsOnly: boolean, prefix: string): string[] {
  if (depth === 0) return [];
  const items = children(ctx, rel).filter((c) => !dirsOnly || c.kind === "dir");
  return items.flatMap((c, i) => {
    const last = i === items.length - 1;
    const line = prefix + (last ? "└── " : "├── ") + LABELS[c.kind](ctx.ws, c);
    const sub = c.kind === "dir" ? treeLines(ctx, c.rel, depth - 1, dirsOnly, prefix + (last ? "    " : "│   ")) : [];
    return [line, ...sub];
  });
}
const collectFiles = (ctx: Ctx, rel: string): string[] =>
  children(ctx, rel).flatMap((c) => (c.kind === "dir" ? collectFiles(ctx, c.rel) : [c.rel]));

function runTree(ctx: Ctx, op: Op): { title: string; body: string } {
  const rel = normalizeRel(op.args[0] ?? ".");
  requireDir(ctx.ws, rel);
  const label = rel === "" ? "." : rel;
  const lines = treeLines(ctx, rel, intOpt(op, "depth", Infinity), op.opts["dirs-only"] === true, "");
  return { title: label, body: [`${label}/`, ...lines].join("\n") };
}

function parseRange(text: string, total: number): [number, number] {
  const m = /^(\d+)(?:-(\d*))?$/.exec(text);
  if (m === null) throw new FlsError("invalid_argument", `plage invalide : ${text} (attendu A, A-B ou A-)`);
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : m[2] === "" ? total : Number(m[2]);
  if (from < 1 || to < from) throw new FlsError("invalid_argument", `plage invalide : ${text}`);
  if (from > total) throw new FlsError("invalid_argument", `la plage commence après la fin du fichier (${total} lignes)`);
  return [from, Math.min(to, total)];
}

function fileBlock(ws: Workspace, rel: string, rangeText: string | null, numbered: boolean): { title: string; block: string } {
  const lines = splitLines(ws.text(rel));
  const total = lines.length;
  const [from, to] = rangeText === null ? [1, total] : parseRange(rangeText, total);
  const width = String(to).length;
  const body = lines.slice(from - 1, to).map((l, i) => (numbered ? `${String(from + i).padStart(width)} | ${l}` : l));
  const title = rangeText === null ? `${rel} (${total} lignes)` : `${rel} (lignes ${from}-${to} sur ${total})`;
  return { title, block: [`=== ${title} ===`, ...body, "=== fin ==="].join("\n") };
}

function omitOnError(file: string, produce: () => string): string {
  try {
    return produce();
  } catch (e) {
    return `=== ${file} ===\n[omis : ${(e as FlsError).code}]\n=== fin ===`;
  }
}

function readDir(ctx: Ctx, op: Op, rel: string): { title: string; body: string } {
  const label = rel === "" ? "." : rel;
  const files = collectFiles(ctx, rel);
  const tree = [`${label}/`, ...treeLines(ctx, rel, intOpt(op, "depth", Infinity), false, "")].join("\n");
  const numbered = op.opts["line-numbers"] === true;
  const blocks = files.map((f) => omitOnError(f, () => fileBlock(ctx.ws, f, null, numbered).block));
  return { title: `${label} (dossier, ${files.length} fichier(s))`, body: [tree, ...blocks].join("\n\n") };
}

function runRead(ctx: Ctx, op: Op): { title: string; body: string } {
  const rel = normalizeRel(op.args[0]);
  if (ctx.ws.kind(rel) === "dir") return readDir(ctx, op, rel);
  const wanted = op.opts["lines"] ?? op.args[1];
  const res = fileBlock(ctx.ws, rel, wanted === undefined ? null : String(wanted), op.opts["line-numbers"] === true);
  return { title: res.title, body: res.block };
}

function tryText(ws: Workspace, rel: string): string | null {
  try {
    return ws.text(rel);
  } catch {
    return null;
  }
}
function compileRegex(source: string, flags: string): RegExp {
  try {
    return new RegExp(source, flags);
  } catch {
    throw new FlsError("invalid_argument", `expression régulière invalide : ${source}`);
  }
}

function runGrep(ctx: Ctx, op: Op): { title: string; body: string } {
  const needle = op.args[0];
  const rel = normalizeRel(op.args[1] ?? ".");
  const re = compileRegex(op.opts["regex"] === true ? needle : escapeAll(needle), op.opts["ignore-case"] === true ? "i" : "");
  const context = intOpt(op, "context", 0);
  const isDir = ctx.ws.kind(rel) === "dir";
  const out: string[] = [];
  let hits = 0;
  let matchedFiles = 0;
  for (const f of isDir ? collectFiles(ctx, rel) : [rel]) {
    const text = isDir ? tryText(ctx.ws, f) : ctx.ws.text(f);
    if (text === null) continue;
    const lines = splitLines(text);
    const found = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
    if (found.length === 0) continue;
    hits += found.length;
    matchedFiles += 1;
    const keep = new Set(found.flatMap((i) => range(Math.max(0, i - context), Math.min(lines.length - 1, i + context))));
    let prev = -2;
    for (const i of [...keep].sort((a, b) => a - b)) {
      if (out.length > 0 && i !== prev + 1) out.push("--");
      out.push(found.includes(i) ? `${f}:${i + 1}: ${lines[i]}` : `${f}-${i + 1}- ${lines[i]}`);
      prev = i;
    }
  }
  const where = rel === "" ? "." : rel;
  return { title: `"${needle}" dans ${where} (${hits} correspondance(s) dans ${matchedFiles} fichier(s))`, body: out.join("\n") };
}

const runNote = (_ctx: Ctx, op: Op): { title: string; body: string } => ({ title: op.args[0], body: "" });

const bigrams = (s: string): Set<string> => new Set(Array.from({ length: Math.max(s.length - 1, 0) }, (_, i) => s.slice(i, i + 2)));
function dice(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size + y.size === 0) return 0;
  let common = 0;
  for (const g of x) if (y.has(g)) common += 1;
  return (2 * common) / (x.size + y.size);
}
function closestHint(content: string, search: string): string {
  const target = search.split("\n")[0].trim();
  const lines = splitLines(content);
  let best = { score: 0, n: 0 };
  lines.forEach((l, i) => {
    const score = dice(target, l.trim());
    if (score > best.score) best = { score, n: i + 1 };
  });
  return best.score > 0 ? `ligne la plus proche (l.${best.n}) : ${JSON.stringify(lines[best.n - 1].trim())}` : "aucune ligne proche";
}
function findAll(hay: string, needle: string): number[] {
  const found: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) found.push(i);
  return found;
}

function runEdit(ctx: Ctx, op: Op): { title: string; body: string } {
  const rel = normalizeRel(op.args[0]);
  const original = ctx.ws.text(rel);
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  let current = original;
  let added = 0;
  let removed = 0;
  const diff = op.edits.flatMap((ed, n) => {
    const search = ed.search.replaceAll("\n", eol);
    const found = findAll(current, search);
    if (found.length === 0) {
      throw new FlsError("not_found", `bloc ${n + 1} : SEARCH introuvable dans ${rel} (${closestHint(current, ed.search)})`);
    }
    if (found.length > 1) {
      const where = found.slice(0, 5).map((p) => lineAt(current, p)).join(", ");
      throw new FlsError("ambiguous_match", `bloc ${n + 1} : SEARCH trouvé ${found.length} fois dans ${rel} (lignes ${where})`);
    }
    const at = found[0];
    const replacement = ed.replace.replaceAll("\n", eol);
    let end = at + search.length;
    if (replacement === "" && (at === 0 || current[at - 1] === "\n") && current.startsWith(eol, end)) end += eol.length;
    const line = lineAt(current, at);
    current = current.slice(0, at) + replacement + current.slice(end);
    const gone = blockLines(ed.search);
    const come = blockLines(ed.replace);
    removed += gone.length;
    added += come.length;
    return [`@@ bloc ${n + 1} (ligne ${line})`, ...gone.map((l) => `- ${l}`), ...come.map((l) => `+ ${l}`)];
  });
  ctx.ws.write(rel, Buffer.from(current, "utf8"));
  return { title: `${rel} (${op.edits.length} bloc(s), +${added} -${removed})`, body: diff.join("\n") };
}

const PUT_CHECKS: Record<string, (existed: boolean, rel: string) => void> = {
  create: (existed, rel) => {
    if (existed) throw new FlsError("already_exists", `${rel} existe déjà (utilise @overwrite)`);
  },
  overwrite: (existed, rel) => {
    if (!existed) throw new FlsError("not_found", `${rel} n'existe pas (utilise @create)`);
  },
  write: () => undefined,
};
function runPut(mode: string): (ctx: Ctx, op: Op) => { title: string; body: string } {
  return (ctx, op) => {
    const rel = normalizeRel(op.args[0]);
    const existed = ctx.ws.kind(rel) !== null;
    PUT_CHECKS[mode](existed, rel);
    ctx.ws.write(rel, Buffer.from(op.content, "utf8"));
    return { title: `${rel} (${existed ? "remplacé" : "nouveau"}, ${splitLines(op.content).length} lignes)`, body: "" };
  };
}

function runAppend(ctx: Ctx, op: Op): { title: string; body: string } {
  const rel = normalizeRel(op.args[0]);
  const existing = ctx.ws.kind(rel) === null ? "" : ctx.ws.text(rel);
  const glue = existing === "" || existing.endsWith("\n") ? "" : "\n";
  ctx.ws.write(rel, Buffer.from(existing + glue + op.content, "utf8"));
  return { title: `${rel} (+${splitLines(op.content).length} lignes)`, body: "" };
}

function runDelete(ctx: Ctx, op: Op): { title: string; body: string } {
  const rel = normalizeRel(op.args[0]);
  ctx.ws.remove(rel);
  return { title: rel, body: "" };
}

function runMove(ctx: Ctx, op: Op): { title: string; body: string } {
  const from = normalizeRel(op.args[0]);
  const to = normalizeRel(op.args[1]);
  ctx.ws.move(from, to);
  return { title: `${from} -> ${to}`, body: "" };
}

const directive = (d: Partial<Spec> & Pick<Spec, "name" | "summary" | "usage" | "examples" | "run">): Spec => ({
  options: {},
  aliases: {},
  positional: [1, 1],
  block: "none",
  writes: false,
  optionDocs: [],
  ...d,
});

const CONTENT_EXAMPLE = (name: string): string =>
  `@${name} src/roles.ts\n<<<<<<< CONTENT\nexport const ROLES = ["admin", "member"] as const\n>>>>>>> END`;

export const DIRECTIVES: Spec[] = [
  directive({
    name: "tree",
    summary: "affiche l'arborescence d'un dossier (fichiers ignorés exclus)",
    usage: "@tree [dossier] [--depth N] [--dirs-only]",
    options: { depth: "value", "dirs-only": "flag" },
    positional: [0, 1],
    optionDocs: ["--depth N : profondeur maximale (défaut : illimitée)", "--dirs-only : n'affiche que les dossiers"],
    examples: ["@tree src --depth 2"],
    run: runTree,
  }),
  directive({
    name: "read",
    summary: "affiche un fichier (ou, pour un dossier, l'arbre puis tous les contenus, comme treecat)",
    usage: "@read <chemin> [A-B] [--lines A-B] [--line-numbers] [--depth N]",
    options: { lines: "value", "line-numbers": "flag", depth: "value" },
    positional: [1, 2],
    optionDocs: [
      "--lines A-B : plage de lignes (A, A-B ou A-) ; la forme positionnelle `@read f 1-30` est acceptée",
      "--line-numbers : préfixe chaque ligne de son numéro",
      "--depth N : profondeur de l'arbre quand le chemin est un dossier",
    ],
    examples: ['@read src/user.ts\n@read "src/types/api client.ts" --lines 1-30 --line-numbers'],
    run: runRead,
  }),
  directive({
    name: "grep",
    summary: "cherche un texte littéral (ou une regex) dans un fichier ou un dossier",
    usage: '@grep "<texte>" [chemin] [--context N] [--regex] [--ignore-case]',
    options: { context: "value", regex: "flag", "ignore-case": "flag" },
    aliases: { "-C": "context" },
    positional: [1, 2],
    optionDocs: ["--context N (ou -C N) : lignes de contexte autour de chaque correspondance", "--regex : le motif est une expression régulière", "--ignore-case : insensible à la casse"],
    examples: ['@grep "getUser" src --context 2'],
    run: runGrep,
  }),
  directive({
    name: "note",
    summary: "recopie un texte dans le rapport (pour annoter les étapes d'un script)",
    usage: '@note "<texte>"',
    examples: ['@note "étape 1 : ajout du champ role"'],
    run: runNote,
  }),
  directive({
    name: "edit",
    summary: "remplace du texte existant ; chaque SEARCH doit être trouvé exactement une fois",
    usage: "@edit <fichier>  puis un ou plusieurs blocs <<<<<<< SEARCH / ======= / >>>>>>> REPLACE",
    block: "edit",
    writes: true,
    optionDocs: ["REPLACE vide : supprime le texte (et la ligne entière si SEARCH couvre des lignes complètes)"],
    examples: ["@edit src/user.ts\n<<<<<<< SEARCH\n  return { id, name }\n=======\n  return { id, name, role: \"member\" }\n>>>>>>> REPLACE"],
    run: runEdit,
  }),
  directive({
    name: "create",
    summary: "crée un fichier ; échoue s'il existe déjà",
    usage: "@create <fichier>  puis un bloc <<<<<<< CONTENT / >>>>>>> END",
    block: "content",
    writes: true,
    examples: [CONTENT_EXAMPLE("create")],
    run: runPut("create"),
  }),
  directive({
    name: "overwrite",
    summary: "remplace tout le contenu d'un fichier existant ; échoue s'il n'existe pas",
    usage: "@overwrite <fichier>  puis un bloc <<<<<<< CONTENT / >>>>>>> END",
    block: "content",
    writes: true,
    examples: [CONTENT_EXAMPLE("overwrite")],
    run: runPut("overwrite"),
  }),
  directive({
    name: "write",
    summary: "crée ou remplace un fichier, sans condition",
    usage: "@write <fichier>  puis un bloc <<<<<<< CONTENT / >>>>>>> END",
    block: "content",
    writes: true,
    examples: [CONTENT_EXAMPLE("write")],
    run: runPut("write"),
  }),
  directive({
    name: "append",
    summary: "ajoute le bloc à la fin d'un fichier (le crée s'il n'existe pas)",
    usage: "@append <fichier>  puis un bloc <<<<<<< CONTENT / >>>>>>> END",
    block: "content",
    writes: true,
    examples: [CONTENT_EXAMPLE("append")],
    run: runAppend,
  }),
  directive({
    name: "delete",
    summary: "supprime un fichier (les dossiers ne sont pas gérés en v1)",
    usage: "@delete <fichier>",
    writes: true,
    examples: ["@delete src/old-user.ts"],
    run: runDelete,
  }),
  directive({
    name: "move",
    summary: "déplace ou renomme un fichier ; échoue si la destination existe",
    usage: "@move <source> <destination>",
    positional: [2, 2],
    writes: true,
    examples: ["@move src/helpers.ts src/utils/helpers.ts"],
    run: runMove,
  }),
];
export const SPEC_BY_NAME: Map<string, Spec> = new Map(DIRECTIVES.map((d) => [d.name, d]));

// ───────────────────────────── Exécution et rapport ─────────────────────────────

export function execute(ops: Op[], ctx: Ctx): Result[] {
  let blocked = false;
  return ops.map((op) => {
    const spec = SPEC_BY_NAME.get(op.name) as Spec;
    const kind = op.name.toUpperCase();
    const title = op.args.map(quote).join(" ");
    if (blocked && spec.writes) {
      return { status: "SKIP", kind, title, body: "    ignoré : une écriture précédente a échoué", code: "skipped" };
    }
    try {
      const done = spec.run(ctx, op);
      return { status: "OK", kind, title: done.title, body: done.body, code: "" };
    } catch (e) {
      if (spec.writes) blocked = true;
      return { status: "FAIL", kind, title, body: `    ${(e as Error).message}`, code: String((e as FlsError).code) };
    }
  });
}

export function renderResult(n: number, r: Result): string {
  const head = `[${n}] ${r.status.padEnd(4)}  ${r.kind} ${r.title}${r.code === "" ? "" : ` : ${r.code}`}`;
  return r.body === "" ? head : `${head}\n${r.body}`;
}
export function renderReport(header: string, results: Result[], footer: string[]): string {
  return `${[header, ...results.map((r, i) => renderResult(i + 1, r)), footer.join("\n")].join("\n\n")}\n`;
}
const count = (results: Result[], status: Result["status"]): number => results.filter((r) => r.status === status).length;

const runsDir = (cwd: string): string => path.join(cwd, ".fls", "runs");

function writeJournal(io: Io, ws: Workspace, id: string, now: Date, pending: Pending[], flat: string, text: string): void {
  const dir = path.join(runsDir(io.cwd), id);
  const backupDir = path.join(dir, "backup");
  fs.mkdirSync(backupDir, { recursive: true });
  const meta: RunMeta = { id, date: now.toISOString(), undone: false, files: ws.apply(pending, backupDir) };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(dir, "script.fls"), flat);
  fs.writeFileSync(path.join(dir, "report.txt"), text);
}

export function execAndReport(args: Args, io: Io, ops: Op[], dry: boolean): Report {
  const ws = new Workspace(io.cwd, numberArg(args, "max-size", DEFAULT_MAX_SIZE));
  const results = execute(ops, { ws, ignore: loadIgnore(ws, args.ignore) });
  const pending = ws.pending();
  const paths = pending.map((p) => p.rel);
  const now = io.now();
  const id = io.newId(now);
  const footer = [
    `Résumé : ${count(results, "OK")} OK, ${count(results, "FAIL")} FAIL, ${count(results, "SKIP")} SKIP`,
    `${dry ? "Modifierait" : "Modifiés"} : ${paths.length === 0 ? "aucun" : paths.join(", ")}`,
  ];
  const journaled = !dry && pending.length > 0;
  if (journaled) footer.push("Annulable avec : fls undo");
  const header = `fls ${VERSION} | ${dry ? "dry-run" : `run ${id}`} | ${io.cwd} | ${now.toISOString()}`;
  const text = renderReport(header, results, footer);
  if (journaled) writeJournal(io, ws, id, now, pending, serialize(ops), text);
  return { text, code: results.some((r) => r.status === "FAIL") ? 1 : 0 };
}

// ───────────────────────────── Journal : log et undo ─────────────────────────────

function listRuns(cwd: string): string[] {
  return fs.existsSync(runsDir(cwd)) ? fs.readdirSync(runsDir(cwd)).sort() : [];
}
function readMeta(cwd: string, id: string): RunMeta {
  const file = path.join(runsDir(cwd), id, "meta.json");
  if (!/^[\w-]+$/.test(id) || !fs.existsSync(file)) throw new FlsError("run_not_found", `run introuvable : ${id}`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as RunMeta;
}
function latestRun(cwd: string): string {
  const id = listRuns(cwd)
    .reverse()
    .find((r) => !readMeta(cwd, r).undone);
  if (id === undefined) throw new FlsError("nothing_to_undo", "aucun run à annuler");
  return id;
}
function restoreEntry(ws: Workspace, backupDir: string, f: JournalEntry): void {
  const abs = ws.resolve(f.path);
  if (f.backup === null) {
    fs.rmSync(abs, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, fs.readFileSync(path.join(backupDir, f.backup)));
  fs.chmodSync(abs, f.mode);
}

function cmdUndo(args: Args, io: Io): Report {
  const id = args.values.get("run") ?? latestRun(io.cwd);
  const meta = readMeta(io.cwd, id);
  if (meta.undone) throw new FlsError("already_undone", `le run ${id} est déjà annulé`);
  const ws = new Workspace(io.cwd, DEFAULT_MAX_SIZE);
  const conflicts = meta.files
    .filter((f) => {
      const current = ws.diskFile(f.path);
      return (current === null ? null : sha1(current)) !== f.after;
    })
    .map((f) => f.path);
  if (conflicts.length > 0 && !args.flags.has("force")) {
    throw new FlsError("conflict", `fichiers modifiés depuis le run : ${conflicts.join(", ")} (--force pour restaurer quand même)`);
  }
  const backupDir = path.join(runsDir(io.cwd), id, "backup");
  meta.files.forEach((f) => restoreEntry(ws, backupDir, f));
  meta.undone = true;
  fs.writeFileSync(path.join(runsDir(io.cwd), id, "meta.json"), JSON.stringify(meta, null, 2));
  const result: Result = {
    status: "OK",
    kind: "UNDO",
    title: `${id} (${meta.files.length} fichier(s) restauré(s))`,
    body: meta.files.map((f) => `    ${f.path}`).join("\n"),
    code: "",
  };
  const now = io.now();
  const footer = [`Résumé : 1 OK, 0 FAIL, 0 SKIP`];
  return { text: renderReport(`fls ${VERSION} | undo | ${io.cwd} | ${now.toISOString()}`, [result], footer), code: 0 };
}

function cmdLog(args: Args, io: Io): Report {
  const id = args.values.get("run");
  if (id === undefined) {
    const lines = listRuns(io.cwd).map((r) => {
      const m = readMeta(io.cwd, r);
      return `${m.id}  ${m.date}  ${m.files.length} fichier(s)${m.undone ? "  [annulé]" : ""}`;
    });
    return { text: `${lines.length === 0 ? "Aucun run enregistré." : lines.join("\n")}\n`, code: 0 };
  }
  readMeta(io.cwd, id);
  const read = (f: string): string => fs.readFileSync(path.join(runsDir(io.cwd), id, f), "utf8");
  return { text: `=== script plat (${id}) ===\n${read("script.fls")}\n=== rapport ===\n${read("report.txt")}`, code: 0 };
}

// ───────────────────────────── Aide : usage, spec, help, init ─────────────────────────────

const GLOBAL_DOCS: string[] = [
  "--dry-run               simule sans rien écrire",
  "--file <chemin>         lit le script dans un fichier",
  "--clip                  lit le script dans le presse-papiers ET copie le rapport",
  "--clip-in / --clip-out  un seul des deux sens",
  "--output <chemin>       écrit le rapport dans un fichier au lieu de l'afficher",
  "--paths-from <chemin>   (lecture rapide) chemins listés un par ligne dans un fichier",
  "--ignore <motif>        motif d'ignore supplémentaire (répétable)",
  "--max-size <octets>     taille maximale d'un fichier lu ou modifié (défaut 1048576)",
  "--max-output-chars <n>  taille maximale du rapport (défaut 200000)",
  "--run <id>              (undo, log) cible un run précis",
  "--force                 (undo) restaure même si des fichiers ont changé depuis",
  "-h, --help / --version",
];

export function usage(): string {
  return [
    "fls — lire et modifier des fichiers en une seule commande",
    "",
    "Usage :",
    "  fls <chemin...>              lecture rapide (arbre puis contenus)",
    "  fls <<'FLS' ... FLS          script lu sur l'entrée standard",
    "  fls --file script.fls        script lu dans un fichier",
    "  fls --clip                   script lu dans le presse-papiers, rapport copié",
    "  fls expand                   affiche le script plat sans l'exécuter",
    "  fls --dry-run                simule les effets sans rien écrire",
    "  fls undo [--run <id>]        annule le dernier run (ou un run précis)",
    "  fls log [--run <id>]         liste les runs ou affiche le détail d'un run",
    "  fls spec                     référence complète de la syntaxe",
    "  fls help <directive>         aide d'une directive",
    "  fls init                     crée .flsignore et ajoute .fls/ au .gitignore",
    "",
    "Options :",
    ...GLOBAL_DOCS.map((d) => `  ${d}`),
    "",
  ].join("\n");
}

export function helpText(s: Spec): string {
  return [
    `@${s.name} — ${s.summary}`,
    `  Usage : ${s.usage}`,
    ...s.optionDocs.map((d) => `  ${d}`),
    "  Exemple :",
    ...s.examples.flatMap((e) => e.split("\n").map((l) => `    ${l}`)),
  ].join("\n");
}

const SPEC_INTRO = [
  "# Référence de la syntaxe fls (v1)",
  "",
  "Un script est une suite de directives, exécutées dans l'ordre.",
  "- une directive par ligne, qui commence par @ ; les lignes vides et celles qui commencent par # sont ignorées ;",
  '- arguments séparés par des espaces ; guillemets droits pour les espaces (\\" et \\\\ échappés) ;',
  "- options toujours en forme longue : --nom ou --nom valeur (seule exception : -C pour --context) ;",
  "- blocs littéraux (aucune interprétation) :",
  "    <<<<<<< SEARCH / ======= / >>>>>>> REPLACE   (un ou plusieurs, pour @edit)",
  "    <<<<<<< CONTENT / >>>>>>> END                (pour @create, @overwrite, @write, @append)",
  "- chemins relatifs au dossier courant ; absolus, `..` et liens symboliques sortants sont refusés ;",
  "- toutes les directives voient l'état simulé : un @read après un @edit montre le résultat ;",
  "- après un échec d'écriture, les écritures suivantes sont SKIP mais les lectures continuent ;",
  "- chaque @edit est atomique (tous ses blocs passent ou aucun) ; les écritures réussies sont appliquées.",
  "",
  "Rapport : une entrée numérotée par directive (OK, FAIL ou SKIP), puis un résumé.",
  "Codes de sortie : 0 tout OK ; 1 au moins un FAIL ; 2 erreur de syntaxe ou d'usage (rien n'a été exécuté).",
].join("\n");

export function buildSpec(): string {
  const errors = ["## Codes d'erreur", ...ERROR_CODES.map(([c, d]) => `  ${c.padEnd(22)} ${d}`)].join("\n");
  return `${[SPEC_INTRO, "## Directives", ...DIRECTIVES.map(helpText), errors].join("\n\n")}\n`;
}

const cmdSpec = (): Report => ({ text: buildSpec(), code: 0 });

function cmdHelp(args: Args): Report {
  const name = (args.positional[0] ?? "").replace(/^@/, "");
  if (name === "") return { text: `Directives : ${DIRECTIVES.map((d) => `@${d.name}`).join(", ")}\nDétail : fls help <directive>\n`, code: 0 };
  const spec = SPEC_BY_NAME.get(name);
  if (spec === undefined) throw new FlsError("unknown_directive", `directive inconnue : ${name}`);
  return { text: `${helpText(spec)}\n`, code: 0 };
}

const FLSIGNORE_TEMPLATE = [
  "# fls : motifs ignorés par @tree, @read (dossiers) et @grep.",
  "# .git/, node_modules/ et .fls/ sont toujours ignorés.",
  "dist/",
  "build/",
  "coverage/",
  "*.log",
  "",
].join("\n");

function cmdInit(_args: Args, io: Io): Report {
  const ignoreFile = path.join(io.cwd, ".flsignore");
  const created = !fs.existsSync(ignoreFile);
  if (created) fs.writeFileSync(ignoreFile, FLSIGNORE_TEMPLATE);
  const gitignore = path.join(io.cwd, ".gitignore");
  const before = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8") : "";
  const has = splitLines(before).includes(".fls/");
  if (!has) fs.writeFileSync(gitignore, `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}.fls/\n`);
  const results: Result[] = [
    { status: "OK", kind: "INIT", title: `.flsignore (${created ? "créé" : "déjà présent"})`, body: "", code: "" },
    { status: "OK", kind: "INIT", title: `.gitignore (${has ? "déjà à jour" : "mis à jour"})`, body: "", code: "" },
  ];
  const header = `fls ${VERSION} | init | ${io.cwd} | ${io.now().toISOString()}`;
  return { text: renderReport(header, results, ["Résumé : 2 OK, 0 FAIL, 0 SKIP"]), code: 0 };
}

// ───────────────────────────── Presse-papiers ─────────────────────────────

const CLIP_TOOLS: Array<{ read: string[]; write: string[] }> = [
  { read: ["wl-paste", "--no-newline"], write: ["wl-copy"] },
  { read: ["xclip", "-selection", "clipboard", "-o"], write: ["xclip", "-selection", "clipboard"] },
  { read: ["xsel", "--clipboard", "--output"], write: ["xsel", "--clipboard", "--input"] },
  { read: ["pbpaste"], write: ["pbcopy"] },
  { read: ["powershell.exe", "-NoProfile", "-Command", "Get-Clipboard"], write: ["clip.exe"] },
];
const noClipboard = (): FlsError =>
  new FlsError("clipboard_unavailable", "aucun outil de presse-papiers (wl-paste/wl-copy, xclip, xsel, pbpaste/pbcopy, powershell.exe/clip.exe)");

export const realRunner: Runner = {
  capture: (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0 ? r.stdout : null;
  },
  feed: (cmd, args, text) => spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] }).status === 0,
};

export function createClipboard(runner: Runner): Clipboard {
  return {
    read() {
      for (const t of CLIP_TOOLS) {
        const out = runner.capture(t.read[0], t.read.slice(1));
        if (out !== null) return out;
      }
      throw noClipboard();
    },
    write(text) {
      if (!CLIP_TOOLS.some((t) => runner.feed(t.write[0], t.write.slice(1), text))) throw noClipboard();
    },
  };
}

// ───────────────────────────── Ligne de commande ─────────────────────────────

const GLOBAL: Record<string, "flag" | "value" | "list"> = {
  "dry-run": "flag",
  clip: "flag",
  "clip-in": "flag",
  "clip-out": "flag",
  force: "flag",
  help: "flag",
  version: "flag",
  file: "value",
  output: "value",
  "paths-from": "value",
  "max-size": "value",
  "max-output-chars": "value",
  run: "value",
  ignore: "list",
};
const SHORT: Record<string, string> = { "-h": "help" };

export function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [], flags: new Set(), values: new Map(), ignore: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const name = Object.hasOwn(SHORT, tok) ? SHORT[tok] : tok.startsWith("--") ? tok.slice(2) : null;
    if (name === null) {
      args.positional.push(tok);
      continue;
    }
    const kind = Object.hasOwn(GLOBAL, name) ? GLOBAL[name] : undefined;
    if (kind === undefined) throw new FlsError("usage_error", `option inconnue : ${tok}`);
    if (kind === "flag") {
      args.flags.add(name);
      continue;
    }
    i += 1;
    if (i >= argv.length) throw new FlsError("usage_error", `--${name} attend une valeur`);
    if (kind === "list") args.ignore.push(argv[i]);
    else args.values.set(name, argv[i]);
  }
  return args;
}

function numberArg(args: Args, name: string, fallback: number): number {
  const raw = args.values.get(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new FlsError("usage_error", `--${name} attend un entier >= 1 (reçu : ${raw})`);
  return n;
}

function scriptText(args: Args, io: Io): string {
  const file = args.values.get("file");
  if (file !== undefined) return fs.readFileSync(path.resolve(io.cwd, file), "utf8");
  if (args.flags.has("clip") || args.flags.has("clip-in")) return io.clipboard.read();
  if (io.stdinIsTTY) throw new FlsError("usage_error", "aucun script : utilise un heredoc (<<'FLS'), --file ou --clip");
  return io.readStdin();
}

const cmdRun = (args: Args, io: Io): Report => execAndReport(args, io, parseScript(scriptText(args, io)), args.flags.has("dry-run"));
const cmdExpand = (args: Args, io: Io): Report => ({ text: serialize(parseScript(scriptText(args, io))), code: 0 });

function cmdQuickRead(args: Args, io: Io): Report {
  const listFile = args.values.get("paths-from");
  const extra = listFile === undefined ? [] : splitLines(fs.readFileSync(path.resolve(io.cwd, listFile), "utf8")).filter((l) => l.trim() !== "");
  return execAndReport(args, io, [...args.positional, ...extra].map((p) => makeOp("read", [p])), false);
}

const SUBCOMMANDS: Record<string, (args: Args, io: Io) => Report> = {
  expand: cmdExpand,
  undo: cmdUndo,
  log: cmdLog,
  spec: cmdSpec,
  help: cmdHelp,
  init: cmdInit,
};

export function route(args: Args, io: Io): Report {
  if (args.flags.has("help")) return { text: usage(), code: 0 };
  if (args.flags.has("version")) return { text: `fls ${VERSION}\n`, code: 0 };
  const [first, ...rest] = args.positional;
  if (first !== undefined && Object.hasOwn(SUBCOMMANDS, first)) return SUBCOMMANDS[first]({ ...args, positional: rest }, io);
  if (args.positional.length > 0 || args.values.has("paths-from")) return cmdQuickRead(args, io);
  return cmdRun(args, io);
}

export function emit(args: Args, io: Io, text: string): void {
  const limit = numberArg(args, "max-output-chars", DEFAULT_MAX_OUTPUT);
  const shown =
    text.length > limit
      ? `${text.slice(0, limit)}\n[rapport tronqué : ${text.length - limit} caractères omis ; relance avec --max-output-chars]\n`
      : text;
  const output = args.values.get("output");
  if (output !== undefined) fs.writeFileSync(path.resolve(io.cwd, output), shown);
  else io.out(shown);
  if (args.flags.has("clip") || args.flags.has("clip-out")) io.clipboard.write(shown);
}

export function main(argv: string[], io: Io): number {
  try {
    const args = parseArgs(argv);
    const report = route(args, io);
    emit(args, io, report.text);
    return report.code;
  } catch (e) {
    io.err(`fls : ${[(e as FlsError).code, (e as Error).message].filter(Boolean).join(" : ")}\n`);
    return USAGE_CODES.has(String((e as FlsError).code)) ? 2 : 1;
  }
}

// ───────────────────────────── Point d'entrée ─────────────────────────────

export function makeId(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 23).replace(/[:.]/g, "")}-${randomBytes(2).toString("hex")}`;
}

export function createRealIo(stdinFd: number): Io {
  return {
    cwd: process.cwd(),
    stdinIsTTY: isatty(stdinFd),
    readStdin: () => fs.readFileSync(stdinFd, "utf8"),
    out: (text) => {
      process.stdout.write(text);
    },
    err: (text) => {
      process.stderr.write(text);
    },
    clipboard: createClipboard(realRunner),
    now: () => new Date(),
    newId: makeId,
  };
}

export function isEntry(argv1: string | undefined, metaUrl: string): boolean {
  if (argv1 === undefined) return false;
  // Dans un binaire bun compilé, argv[1] est un chemin virtuel (/$bunfs/...),
  // inexistant sur le disque : realpathSync échoue et on compare directement.
  let entry: string;
  try {
    entry = fs.realpathSync(argv1);
  } catch {
    entry = argv1;
  }
  return pathToFileURL(entry).href === metaUrl;
}
export function setExitCode(code: number): void {
  process.exitCode = code;
}
export function startReal(argv: string[], io: Io, setExit: (code: number) => void): void {
  setExit(main(argv, io));
}
export function bootstrap(isMain: boolean, start: () => void): void {
  if (isMain) start();
}

bootstrap(isEntry(process.argv[1], import.meta.url), startReal.bind(null, process.argv.slice(2), createRealIo(0), setExitCode));
