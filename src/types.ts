// Types partagés par tous les modules de fls.

import type { Highlighter } from "./highlight.ts";
import type { ReportDoc, Segment } from "./report/segments.ts";
import type { Workspace } from "./workspace.ts";

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

/** Ce que renvoie une directive : le titre de son entrée et le corps (segments typés). */
export interface Done {
  title: string;
  body: Segment[];
}

/** Copie non colorée de la sortie, de quoi la réafficher (`fls last`) sans réexécuter. */
export type Snapshot =
  | { kind: "report"; doc: ReportDoc }
  | { kind: "tree"; roots: Array<{ p: string; label: string; raw: string } | null> };

export interface Report {
  /** Rendu brut (SPEC §8) : troncature, journal, --clip, sortie non colorée. */
  text: string;
  /** Le Rapport en donnée (lectures rapides et scripts) : rendu stylé et Dernière sortie. */
  doc?: ReportDoc;
  /** Mémorisée par `emit` pour `fls last` (absente : sortie non mémorisable). */
  snapshot?: Snapshot;
  /** Sortie brute (mode tree) : écrite telle quelle si elle n'est pas tronquée. */
  raw?: Buffer;
  /** Sortie `--tree` déjà colorée (ANSI) : emit ne la rend pas une seconde fois. */
  preColored?: boolean;
  code: number;
}

export type Ignore = (rel: string, isDir: boolean) => boolean;

export interface Ctx {
  ws: Workspace;
  ignore: Ignore;
  /** Chemin absolu de --output, pour marquer `[output file]` en mode tree. */
  output?: string | null;
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
  stdoutIsTTY?: boolean;
  stderrIsTTY?: boolean;
  env?: Record<string, string | undefined>;
  readStdin(): string;
  out(text: string | Buffer): void;
  err(text: string): void;
  clipboard: Clipboard;
  now(): Date;
  newId(now: Date): string;
  /** Dossier où `fls last` mémorise la dernière sortie (absent : pas de mémorisation). */
  cacheDir?: string;
  /** Largeur du terminal (stdout) quand c'est un terminal : sert à replier les lignes longues. */
  columns?: number;
  /** Coloration syntaxique (Shiki par défaut) : injectable pour les tests. */
  highlighter?: Highlighter;
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
  run: (ctx: Ctx, op: Op) => Done | Promise<Done>;
}

/** État d'un fichier dans la surcouche en mémoire du Workspace. */
export interface FileState {
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

export interface Token {
  text: string;
  quoted: boolean;
}
