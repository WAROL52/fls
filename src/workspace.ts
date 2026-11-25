// Surcouche en mémoire au-dessus du disque : dry-run et exécution réelle
// partagent le même code, seul `apply` (le commit) diffère.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { FlsError } from "./errors.ts";
import type { JournalEntry } from "./journal.ts";
import type { FileState, Kind, Pending } from "./types.ts";

const BINARY_SNIFF = 8000;
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const sha1 = (b: Buffer): string => createHash("sha1").update(b).digest("hex");
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
  changes: Map<string, FileState> = new Map();
  /** Dossiers créés par `@mkdir` (y compris vides), au-dessus du disque. */
  dirs: Set<string> = new Set();
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
    if (st === undefined) return this.dirs.has(rel) || this.hasVirtualChild(rel) ? "dir" : null;
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

  /** Octets validés (taille, binaire, UTF-8) : base des directives structurelles. */
  bytes(rel: string): Buffer {
    const buf = this.get(rel);
    if (buf.length > this.maxSize) throw new FlsError("too_large", `${rel} : ${buf.length} octets > --max-size ${this.maxSize}`);
    if (buf.subarray(0, BINARY_SNIFF).includes(0)) throw new FlsError("binary_file", `${rel} est un fichier binaire`);
    try {
      DECODER.decode(buf);
    } catch {
      throw new FlsError("not_utf8", `${rel} n'est pas de l'UTF-8 valide`);
    }
    return buf;
  }

  text(rel: string): string {
    return DECODER.decode(this.bytes(rel));
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

  /** Crée le dossier (et ses parents) ; renvoie false s'il existe déjà. */
  mkdir(rel: string): boolean {
    const k = this.kind(rel);
    if (k === "dir") return false;
    if (k === "link") throw new FlsError("symlink", `${rel} est un lien symbolique (non suivi)`);
    if (k === "file") throw new FlsError("not_a_directory", `${rel} est un fichier`);
    for (let p = path.posix.dirname(rel); p !== "."; p = path.posix.dirname(p)) {
      if (this.kind(p) === "file") throw new FlsError("not_a_directory", `${p} est un fichier`);
    }
    this.resolve(rel);
    for (let p = rel; p !== "."; p = path.posix.dirname(p)) {
      if (this.kind(p) === null) this.dirs.add(p);
    }
    return true;
  }

  /** Copie un fichier ; échoue si la destination existe (droits conservés). */
  copy(from: string, to: string): void {
    this.requireFile(from);
    if (this.kind(to) !== null) throw new FlsError("already_exists", `${to} existe déjà`);
    const data = this.get(from);
    const mode = this.modeOf(from);
    this.write(to, data);
    (this.changes.get(to) as FileState).mode = mode;
  }

  move(from: string, to: string): void {
    this.copy(from, to);
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
    for (const d of this.dirs) {
      if (d.startsWith(prefix) && d !== rel) names.add(d.slice(prefix.length).split("/")[0]);
    }
    return [...names].sort();
  }

  diskFile(rel: string): Buffer | null {
    const st = lstatSafe(path.join(this.root, rel));
    return st !== undefined && st.isFile() ? fs.readFileSync(this.resolve(rel)) : null;
  }

  /** Dossiers que le run créera réellement (absents du disque), parents avant enfants. */
  newDirs(): string[] {
    return [...this.dirs].filter((d) => lstatSafe(path.join(this.root, d)) === undefined).sort();
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
