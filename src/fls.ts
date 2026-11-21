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
 *  - chaque directive vit dans src/directive/<nom>.ts et exporte sa `Spec` ;
 *  - seulement de la syntaxe TypeScript effaçable (pas d'enum ni de propriétés de paramètre),
 *    donc `node src/fls.ts` fonctionne directement.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isatty } from "node:tty";
import { pathToFileURL } from "node:url";
import { DIRECTIVES, SPEC_BY_NAME } from "./directive/index.ts";
import { ERROR_CODES, FlsError, syntaxError, USAGE_CODES } from "./errors.ts";
import { loadIgnore } from "./paths.ts";
import { blockLines, quote, splitLines, tokenize } from "./text.ts";
import { colorizeQuickTree, colorizeReportText, resolveTargets, truncate as safeAnsiTruncate } from "./color.ts";
import { renderTree, treeRel } from "./tree.ts";
import type {
  Args,
  Clipboard,
  Ctx,
  Ignore,
  Io,
  JournalEntry,
  Op,
  Pending,
  Report,
  Result,
  RunMeta,
  Runner,
  Spec,
  Token,
} from "./types.ts";
import { sha1, Workspace } from "./workspace.ts";

export const VERSION = "1.1.0";
const DEFAULT_MAX_SIZE = 1_048_576;
const DEFAULT_MAX_OUTPUT = 200_000;

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

const CLIP_MARKER = /^\s*#{3,}\s*clip\s+(start|end)\s*#*\s*$/i;
const HASH_DIRECTIVE = /^#@[A-Za-z]/;

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

/** `#@nom …` (collé à une lettre) devient `@nom …` ; réservé aux directives de lecture. */
function unhash(trimmed: string, lineNo: number): string {
  const name = /^#@([A-Za-z]+)/.exec(trimmed)?.[1] as string;
  const spec = SPEC_BY_NAME.get(name);
  if (spec === undefined) throw syntaxError(lineNo, `directive inconnue #@${name}`);
  if (spec.writes) throw syntaxError(lineNo, `#@${name} : les directives d'écriture exigent la forme @${name}`);
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

// ───────────────────────────── Exécution et rapport ─────────────────────────────

export async function execute(ops: Op[], ctx: Ctx): Promise<Result[]> {
  let blocked = false;
  const out: Result[] = [];
  for (const op of ops) {
    const spec = SPEC_BY_NAME.get(op.name) as Spec;
    const kind = op.name.toUpperCase();
    const title = op.args.map(quote).join(" ");
    if (blocked && spec.writes) {
      out.push({ status: "SKIP", kind, title, body: "    ignoré : une écriture précédente a échoué", code: "skipped" });
      continue;
    }
    try {
      const done = await spec.run(ctx, op);
      out.push({ status: "OK", kind, title: done.title, body: done.body, code: "" });
    } catch (e) {
      if (spec.writes) blocked = true;
      out.push({ status: "FAIL", kind, title, body: `    ${(e as Error).message}`, code: String((e as FlsError).code) });
    }
  }
  return out;
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

export async function execAndReport(args: Args, io: Io, ops: Op[], dry: boolean): Promise<Report> {
  const ws = new Workspace(io.cwd, numberArg(args, "max-size", DEFAULT_MAX_SIZE));
  const out = args.values.get("output");
  const results = await execute(ops, { ws, ignore: loadIgnore(ws, args.ignore), output: out === undefined ? null : path.resolve(io.cwd, out) });
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

async function cmdUndo(args: Args, io: Io): Promise<Report> {
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

async function cmdLog(args: Args, io: Io): Promise<Report> {
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
  "--tree                  (lecture rapide ou script) sortie brute façon treecat",
  "--color <mode>          auto|always|never (défaut auto)",
  "--colored               alias de --color=always",
  "--no-color              alias de --color=never",
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
    "  fls --tree [chemin...]       sortie brute façon treecat (aucun ignore)",
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
  "- --tree (global) applique @read --tree à tous les reads ; --tree seul en lecture rapide produit la sortie brute ;",
  "- toutes les directives voient l'état simulé : un @read après un @edit montre le résultat ;",
  "- après un échec d'écriture, les écritures suivantes sont SKIP mais les lectures continuent ;",
  "- chaque @edit est atomique (tous ses blocs passent ou aucun) ; les écritures réussies sont appliquées.",
  "",
  "Rapport : une entrée numérotée par directive (OK, FAIL ou SKIP), puis un résumé.",
  "Codes de sortie : 0 tout OK ; 1 au moins un FAIL ; 2 erreur de syntaxe ou d'usage (rien n'a été exécuté).",
].join("\n");

export function buildSpec(): string {
  const globals = ["## Options globales", ...GLOBAL_DOCS.map((d) => `  ${d}`)].join("\n");
  const errors = ["## Codes d'erreur", ...ERROR_CODES.map(([c, d]) => `  ${c.padEnd(22)} ${d}`)].join("\n");
  return `${[SPEC_INTRO, globals, "## Directives", ...DIRECTIVES.map(helpText), errors].join("\n\n")}\n`;
}

const cmdSpec = async (): Promise<Report> => ({ text: buildSpec(), code: 0 });

async function cmdHelp(args: Args): Promise<Report> {
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

async function cmdInit(_args: Args, io: Io): Promise<Report> {
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
  tree: "flag",
  color: "value",
  colored: "flag",
  "no-color": "flag",
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
    const rawName = Object.hasOwn(SHORT, tok) ? SHORT[tok] : tok.startsWith("--") ? tok.slice(2) : null;
    if (rawName === null) {
      args.positional.push(tok);
      continue;
    }
    const eq = rawName.indexOf("=");
    const name = eq === -1 ? rawName : rawName.slice(0, eq);
    const inline = eq === -1 ? undefined : rawName.slice(eq + 1);
    const kind = Object.hasOwn(GLOBAL, name) ? GLOBAL[name] : undefined;
    if (kind === undefined) throw new FlsError("usage_error", `option inconnue : ${tok}`);
    if (kind === "flag") {
      if (inline !== undefined) throw new FlsError("usage_error", `--${name} n'attend pas de valeur`);
      args.flags.add(name);
      continue;
    }
    const val = inline ?? argv[++i];
    if (val === undefined) throw new FlsError("usage_error", `--${name} attend une valeur`);
    if (kind === "list") args.ignore.push(val);
    else args.values.set(name, val);
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

const hasScriptSource = (args: Args, io: Io): boolean =>
  args.values.has("file") || args.flags.has("clip") || args.flags.has("clip-in") || !io.stdinIsTTY;

async function cmdRun(args: Args, io: Io): Promise<Report> {
  const ops = parseScript(scriptText(args, io));
  if (args.flags.has("tree")) for (const op of ops) if (op.name === "read") op.opts["tree"] = true;
  return execAndReport(args, io, ops, args.flags.has("dry-run"));
}
const cmdExpand = async (args: Args, io: Io): Promise<Report> => ({ text: serialize(parseScript(scriptText(args, io))), code: 0 });

function quickPaths(args: Args, io: Io): string[] {
  const listFile = args.values.get("paths-from");
  const extra = listFile === undefined ? [] : splitLines(fs.readFileSync(path.resolve(io.cwd, listFile), "utf8")).filter((l) => l.trim() !== "");
  return [...args.positional, ...extra];
}

async function cmdQuickRead(args: Args, io: Io): Promise<Report> {
  return execAndReport(args, io, quickPaths(args, io).map((p) => makeOp("read", [p])), false);
}

async function cmdQuickTree(args: Args, io: Io): Promise<Report> {
  if (args.ignore.length > 0) throw new FlsError("usage_error", "--ignore n'a pas de sens avec --tree (aucun ignore)");
  if (args.values.has("max-size")) throw new FlsError("usage_error", "--max-size n'a pas de sens avec --tree (aucune limite de taille)");
  const listed = args.values.has("paths-from");
  const paths = quickPaths(args, io);
  if (paths.length === 0 && !listed) paths.push(".");
  const outputRaw = args.values.get("output");
  const output = outputRaw === undefined ? null : path.resolve(io.cwd, outputRaw);
  if (output !== null) fs.writeFileSync(output, "");
  const ws = new Workspace(io.cwd, DEFAULT_MAX_SIZE);
  const rendered: Array<{ p: string; label: string; raw: Buffer } | null> = [];
  let code = 0;
  for (const p of paths) {
    const label = p === "" ? "." : p;
    try {
      rendered.push({ p, label, raw: renderTree(ws, label, treeRel(p), output) });
    } catch (e) {
      code = 1;
      const msg = `fls : ${[(e as FlsError).code, (e as Error).message].filter(Boolean).join(" : ")}`;
      io.err(`${msg}\n`);
      rendered.push(null);
    }
  }
  const plain = Buffer.concat(rendered.map((r, i) => (i > 0 ? Buffer.concat([Buffer.from("\n"), r?.raw ?? Buffer.alloc(0)]) : (r?.raw ?? Buffer.alloc(0))))).toString("utf8");
  const targets = resolveTargets(args, io);
  const wantColor = targets.stdout || targets.file || targets.clip;
  if (!wantColor) return { text: plain, raw: Buffer.concat(rendered.map((r, i) => (i > 0 ? Buffer.concat([Buffer.from("\n"), r?.raw ?? Buffer.alloc(0)]) : (r?.raw ?? Buffer.alloc(0))))), code };
  const coloredRoots: string[] = [];
  for (const r of rendered) {
    if (r === null) { coloredRoots.push(""); continue; }
    const chunk = r.raw.toString("utf8");
    /* v8 ignore start */
    try {
      coloredRoots.push(await colorizeQuickTree(chunk, ws, treeRel(r.p), r.label, targets));
    } catch {
      coloredRoots.push(chunk);
    }
    /* v8 ignore stop */
  }
  return { text: coloredRoots.join("\n"), preColored: true, code };
}

const SUBCOMMANDS: Record<string, (args: Args, io: Io) => Promise<Report>> = {
  expand: cmdExpand,
  undo: cmdUndo,
  log: cmdLog,
  spec: cmdSpec as (args: Args, io: Io) => Promise<Report>,
  help: cmdHelp as (args: Args, io: Io) => Promise<Report>,
  init: cmdInit,
};

export async function route(args: Args, io: Io): Promise<Report> {
  if (args.flags.has("help")) return { text: usage(), code: 0 };
  if (args.flags.has("version")) return { text: `fls ${VERSION}\n`, code: 0 };
  const [first, ...rest] = args.positional;
  if (first !== undefined && Object.hasOwn(SUBCOMMANDS, first)) return SUBCOMMANDS[first]({ ...args, positional: rest }, io);
  if (args.positional.length > 0 || args.values.has("paths-from")) {
    return args.flags.has("tree") ? cmdQuickTree(args, io) : cmdQuickRead(args, io);
  }
  if (args.flags.has("tree")) return hasScriptSource(args, io) ? cmdRun(args, io) : cmdQuickTree(args, io);
  // `fls` seul, sans aucune source de script : affiche l'usage plutôt qu'une erreur.
  if (!hasScriptSource(args, io)) return { text: usage(), code: 0 };
  return cmdRun(args, io);
}

function isExpand(args: Args): boolean {
  return args.positional[0] === "expand";
}

function withTruncation(text: string, limit: number, color: boolean): string {
  if (text.length <= limit) return text;
  if (!color) return `${text.slice(0, limit)}\n[rapport tronqué : ${text.length - limit} caractères omis ; relance avec --max-output-chars]\n`;
  const cut = safeAnsiTruncate(text, limit);
  return `${cut.text}\n[rapport tronqué : ${text.length - cut.text.length} caractères omis ; relance avec --max-output-chars]\n`;
}

export async function emit(args: Args, io: Io, report: Report): Promise<void> {
  const targets = resolveTargets(args, io);
  // Lecture brute `--tree` (colorée ou non) : pas de limite par défaut, sinon la coupe tombe au milieu
  // de l'arborescence et masque les dossiers suivants (les codes ANSI comptent dans la taille).
  const rawTree = report.raw !== undefined || report.preColored === true;
  const limit = numberArg(args, "max-output-chars", rawTree ? Infinity : DEFAULT_MAX_OUTPUT);
  const plainBase = report.text;
  const expand = isExpand(args);
  const preColored = report.preColored === true;
  const stdoutColored = !expand && targets.stdout && report.raw === undefined && !preColored;
  const fileColored = !expand && targets.file && report.raw === undefined && !preColored;
  const clipColored = !expand && targets.clip && report.raw === undefined && !preColored;

  const coloredBase = preColored ? plainBase : ((stdoutColored || fileColored || clipColored) ? await colorizeReportText(plainBase, targets) : null);

  const useColoredStdout = preColored ? targets.stdout : stdoutColored;
  const useColoredFile = preColored ? targets.file : fileColored;
  const useColoredClip = preColored ? targets.clip : clipColored;

  const outShown: string | Buffer = useColoredStdout
    ? withTruncation(coloredBase as string, limit, true)
    : (plainBase.length > limit
      ? withTruncation(plainBase, limit, false)
      : (report.raw ?? plainBase));
  const output = args.values.get("output");
  if (output !== undefined) {
    const fileShown = useColoredFile ? withTruncation(coloredBase as string, limit, true) : (plainBase.length > limit ? withTruncation(plainBase, limit, false) : plainBase);
    fs.writeFileSync(path.resolve(io.cwd, output), fileShown);
  } else {
    io.out(outShown);
  }
  if (args.flags.has("clip") || args.flags.has("clip-out")) {
    const clipShown = useColoredClip ? withTruncation(coloredBase as string, limit, true) : (plainBase.length > limit ? withTruncation(plainBase, limit, false) : plainBase);
    io.clipboard.write(clipShown);
  }
}

export async function main(argv: string[], io: Io): Promise<number> {
  try {
    const args = parseArgs(argv);
    const report = await route(args, io);
    await emit(args, io, report);
    return report.code;
  } catch (e) {
    let msg = `fls : ${[(e as FlsError).code, (e as Error).message].filter(Boolean).join(" : ")}`;
    try {
      const args = parseArgs(argv);
      const t = resolveTargets(args, io);
      if (t.stderr) msg = (await colorizeReportText(msg, t));
    } catch {
      // ignore color failure on error path
    }
    io.err(`${msg}\n`);
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
    stdoutIsTTY: isatty(1),
    stderrIsTTY: isatty(2),
    env: process.env,
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
export async function startReal(argv: string[], io: Io, setExit: (code: number) => void): Promise<void> {
  setExit(await main(argv, io));
}
export function bootstrap(isMain: boolean, start: () => void): void {
  if (isMain) start();
}

bootstrap(isEntry(process.argv[1], import.meta.url), startReal.bind(null, process.argv.slice(2), createRealIo(0), setExitCode));

// ───────────────────────────── API publique (compatibilité) ─────────────────────────────

export { DIRECTIVES, SPEC_BY_NAME } from "./directive/index.ts";
export { ERROR_CODES, FlsError } from "./errors.ts";
export { compileIgnore, loadIgnore, normalizeRel } from "./paths.ts";
export { quote, splitLines, tokenize } from "./text.ts";
export type {
  Args,
  Clipboard,
  Ctx,
  Edit,
  Entry,
  Ignore,
  Io,
  JournalEntry,
  Kind,
  Op,
  Pending,
  Report,
  Result,
  RunMeta,
  Runner,
  Spec,
  Token,
} from "./types.ts";
export { Workspace } from "./workspace.ts";
