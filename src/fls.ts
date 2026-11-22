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
import * as os from "node:os";
import * as path from "node:path";
import { isatty } from "node:tty";
import { pathToFileURL } from "node:url";
import { DIRECTIVES, SPEC_BY_NAME } from "./directive/index.ts";
import { ERROR_CODES, FlsError, syntaxError, USAGE_CODES } from "./errors.ts";
import { loadIgnore } from "./paths.ts";
import { blockLines, quote, splitLines, tokenize } from "./text.ts";
import { numberArg } from "./args.ts";
import { colorizeError, colorPlan } from "./color.ts";
import { treeRel, treeText, walkTree, type TreeNode } from "./tree.ts";
import type {
  Args,
  Clipboard,
  Ctx,
  Ignore,
  Io,
  Op,
  Pending,
  Content,
  Report,
  Runner,
  Spec,
  Token,
} from "./types.ts";
import { renderPlain } from "./report/plain.ts";
import { textBody, type Entry, type ReportDoc } from "./report/segments.ts";
import { Journal } from "./journal.ts";
import { loadLast } from "./last.ts";
import { deliver, destinationsFor } from "./output.ts";
import { VERSION } from "./version.ts";
import { Workspace } from "./workspace.ts";

export { VERSION };
const DEFAULT_MAX_SIZE = 1_048_576;

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

export async function execute(ops: Op[], ctx: Ctx): Promise<Entry[]> {
  let blocked = false;
  const out: Entry[] = [];
  for (const op of ops) {
    const spec = SPEC_BY_NAME.get(op.name) as Spec;
    const kind = op.name.toUpperCase();
    const title = op.args.map(quote).join(" ");
    if (blocked && spec.writes) {
      out.push({ status: "SKIP", kind, title, body: textBody("    ignoré : une écriture précédente a échoué"), code: "skipped" });
      continue;
    }
    try {
      const done = await spec.run(ctx, op);
      out.push({ status: "OK", kind, title: done.title, body: done.body, code: "" });
    } catch (e) {
      if (spec.writes) blocked = true;
      out.push({ status: "FAIL", kind, title, body: textBody(`    ${(e as Error).message}`), code: String((e as FlsError).code) });
    }
  }
  return out;
}

const count = (results: Entry[], status: Entry["status"]): number => results.filter((r) => r.status === status).length;

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
  const doc: ReportDoc = { header, entries: results, footer };
  const text = renderPlain(doc);
  if (journaled) new Journal(io.cwd, DEFAULT_MAX_SIZE).record(ws, { id, now, pending, script: serialize(ops), report: text });
  return { text, content: { kind: "report", doc }, remember: true, code: results.some((r) => r.status === "FAIL") ? 1 : 0 };
}

// ───────────────────────────── Dernière sortie : mémorisation et `fls last` ─────────────────────────────

/** Réaffiche la dernière sortie (sans rien réexécuter), recolorée et repliée à la largeur actuelle du terminal. */
async function cmdLast(_args: Args, io: Io): Promise<Report> {
  const snap = loadLast(io);
  if (snap.kind === "report") return { text: renderPlain(snap.doc), content: snap, code: 0 };
  return treeReport(snap.roots.map((r) => (r === null ? null : { raw: Buffer.from(treeText(r), "utf8"), node: r })), 0);
}

// ───────────────────────────── Journal : log et undo ─────────────────────────────

async function cmdUndo(args: Args, io: Io): Promise<Report> {
  const meta = new Journal(io.cwd, DEFAULT_MAX_SIZE).undo(args.values.get("run"), args.flags.has("force"));
  const entry: Entry = {
    status: "OK",
    kind: "UNDO",
    title: `${meta.id} (${meta.files.length} fichier(s) restauré(s))`,
    body: textBody(meta.files.map((f) => `    ${f.path}`).join("\n")),
    code: "",
  };
  const now = io.now();
  const doc: ReportDoc = { header: `fls ${VERSION} | undo | ${io.cwd} | ${now.toISOString()}`, entries: [entry], footer: ["Résumé : 1 OK, 0 FAIL, 0 SKIP"] };
  return { text: renderPlain(doc), content: { kind: "report", doc }, code: 0 };
}

async function cmdLog(args: Args, io: Io): Promise<Report> {
  const journal = new Journal(io.cwd, DEFAULT_MAX_SIZE);
  const id = args.values.get("run");
  if (id === undefined) {
    const lines = journal.list().map((m) => `${m.id}  ${m.date}  ${m.files.length} fichier(s)${m.undone ? "  [annulé]" : ""}`);
    return { text: `${lines.length === 0 ? "Aucun run enregistré." : lines.join("\n")}\n`, code: 0 };
  }
  const { script, report } = journal.show(id);
  return { text: `=== script plat (${id}) ===\n${script}\n=== rapport ===\n${report}`, code: 0 };
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
    "  fls last                     réaffiche la dernière sortie (sans réexécuter), à la largeur du terminal",
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
  const entries: Entry[] = [
    { status: "OK", kind: "INIT", title: `.flsignore (${created ? "créé" : "déjà présent"})`, body: [], code: "" },
    { status: "OK", kind: "INIT", title: `.gitignore (${has ? "déjà à jour" : "mis à jour"})`, body: [], code: "" },
  ];
  const doc: ReportDoc = { header: `fls ${VERSION} | init | ${io.cwd} | ${io.now().toISOString()}`, entries, footer: ["Résumé : 2 OK, 0 FAIL, 0 SKIP"] };
  return { text: renderPlain(doc), content: { kind: "report", doc }, code: 0 };
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
  const rendered: TreeRoot[] = [];
  let code = 0;
  for (const p of paths) {
    const label = p === "" ? "." : p;
    try {
      rendered.push(walkTree(ws, label, treeRel(p), output));
    } catch (e) {
      code = 1;
      const msg = `fls : ${[(e as FlsError).code, (e as Error).message].filter(Boolean).join(" : ")}`;
      io.err(`${msg}\n`);
      rendered.push(null);
    }
  }
  return { ...treeReport(rendered, code), remember: true };
}

type TreeRoot = { raw: Buffer; node: TreeNode } | null;

/** Rapport d'une lecture `--tree` : texte brut, octets exacts et racines en donnée (rendu stylé par `deliver`). */
function treeReport(rendered: TreeRoot[], code: number): Report {
  const raw = Buffer.concat(rendered.map((r, i) => (i > 0 ? Buffer.concat([Buffer.from("\n"), r?.raw ?? Buffer.alloc(0)]) : (r?.raw ?? Buffer.alloc(0)))));
  const content: Content = { kind: "tree", roots: rendered.map((r) => (r === null ? null : r.node)) };
  return { text: raw.toString("utf8"), raw, content, code };
}

const SUBCOMMANDS: Record<string, (args: Args, io: Io) => Promise<Report>> = {
  expand: cmdExpand,
  undo: cmdUndo,
  log: cmdLog,
  last: cmdLast,
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

export async function main(argv: string[], io: Io): Promise<number> {
  try {
    const args = parseArgs(argv);
    const report = await route(args, io);
    await deliver(report, destinationsFor(args, io), io);
    return report.code;
  } catch (e) {
    let msg = `fls : ${[(e as FlsError).code, (e as Error).message].filter(Boolean).join(" : ")}`;
    try {
      const args = parseArgs(argv);
      const plan = colorPlan(args, io);
      if (plan.stderr) msg = colorizeError(msg, plan);
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
    cacheDir: cacheDirFor(process.env, os.homedir()),
    columns: terminalColumns(isatty(1), process.stdout.columns),
  };
}

/** `$XDG_CACHE_HOME/fls`, sinon `~/.cache/fls`. */
export function cacheDirFor(env: Record<string, string | undefined>, home: string): string {
  const base = env.XDG_CACHE_HOME;
  return path.join(base !== undefined && base !== "" ? base : path.join(home, ".cache"), "fls");
}

/** Largeur utilisable du terminal : seulement si stdout est un terminal qui la connaît. */
export function terminalColumns(isTty: boolean, columns: number | undefined): number | undefined {
  return isTty && columns !== undefined && columns > 0 ? columns : undefined;
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
  FileState,
  Ignore,
  Io,
  Kind,
  Op,
  Pending,
  Report,
  Runner,
  Spec,
  Token,
} from "./types.ts";
export type { JournalEntry, RunMeta } from "./journal.ts";
export { loadLast, saveLast } from "./last.ts";
export { Workspace } from "./workspace.ts";
