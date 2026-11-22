// Journal : les Runs conservés dans `.fls/runs/<id>/` (meta.json, script.fls, report.txt, backup/).
// Il possède le format sur disque, la validation des ids et la logique d'annulation (détection des
// conflits, restauration). Il renvoie des données, jamais un Rapport.

import * as fs from "node:fs";
import * as path from "node:path";
import { FlsError } from "./errors.ts";
import type { Pending } from "./types.ts";
import { sha1, Workspace } from "./workspace.ts";

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

export interface RunRecord {
  id: string;
  now: Date;
  pending: Pending[];
  /** Script plat du run. */
  script: string;
  /** Rapport brut déjà rendu. */
  report: string;
}

export class Journal {
  private cwd: string;
  private maxSize: number;
  private runs: string;

  constructor(cwd: string, maxSize: number) {
    this.cwd = cwd;
    this.maxSize = maxSize;
    this.runs = path.join(cwd, ".fls", "runs");
  }

  /** Applique les changements du Workspace sur le disque et journalise le run. */
  record(ws: Workspace, r: RunRecord): void {
    const dir = path.join(this.runs, r.id);
    const backupDir = path.join(dir, "backup");
    fs.mkdirSync(backupDir, { recursive: true });
    const meta: RunMeta = { id: r.id, date: r.now.toISOString(), undone: false, files: ws.apply(r.pending, backupDir) };
    this.writeMeta(meta);
    fs.writeFileSync(path.join(dir, "script.fls"), r.script);
    fs.writeFileSync(path.join(dir, "report.txt"), r.report);
  }

  /** Tous les runs, du plus ancien au plus récent. */
  list(): RunMeta[] {
    return (fs.existsSync(this.runs) ? fs.readdirSync(this.runs).sort() : []).map((id) => this.meta(id));
  }

  meta(id: string): RunMeta {
    const file = path.join(this.runs, id, "meta.json");
    if (!/^[\w-]+$/.test(id) || !fs.existsSync(file)) throw new FlsError("run_not_found", `run introuvable : ${id}`);
    return JSON.parse(fs.readFileSync(file, "utf8")) as RunMeta;
  }

  show(id: string): { script: string; report: string } {
    this.meta(id);
    const read = (f: string): string => fs.readFileSync(path.join(this.runs, id, f), "utf8");
    return { script: read("script.fls"), report: read("report.txt") };
  }

  /** Annule le run `id` (défaut : le dernier non annulé) ; refuse en cas de conflit sauf `force`. */
  undo(id: string | undefined, force: boolean): RunMeta {
    const meta = this.meta(id ?? this.latest());
    if (meta.undone) throw new FlsError("already_undone", `le run ${meta.id} est déjà annulé`);
    const ws = new Workspace(this.cwd, this.maxSize);
    const conflicts = meta.files
      .filter((f) => {
        const current = ws.diskFile(f.path);
        return (current === null ? null : sha1(current)) !== f.after;
      })
      .map((f) => f.path);
    if (conflicts.length > 0 && !force) {
      throw new FlsError("conflict", `fichiers modifiés depuis le run : ${conflicts.join(", ")} (--force pour restaurer quand même)`);
    }
    const backupDir = path.join(this.runs, meta.id, "backup");
    meta.files.forEach((f) => this.restore(ws, backupDir, f));
    meta.undone = true;
    this.writeMeta(meta);
    return meta;
  }

  private latest(): string {
    const run = this.list()
      .reverse()
      .find((m) => !m.undone);
    if (run === undefined) throw new FlsError("nothing_to_undo", "aucun run à annuler");
    return run.id;
  }

  private writeMeta(meta: RunMeta): void {
    fs.writeFileSync(path.join(this.runs, meta.id, "meta.json"), JSON.stringify(meta, null, 2));
  }

  private restore(ws: Workspace, backupDir: string, f: JournalEntry): void {
    const abs = ws.resolve(f.path);
    if (f.backup === null) {
      fs.rmSync(abs, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, fs.readFileSync(path.join(backupDir, f.backup)));
    fs.chmodSync(abs, f.mode);
  }
}
