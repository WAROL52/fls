// Adapter de test unique pour l'Io de fls : dossiers temporaires réels, faux Io complet et appel de
// `main`. Les valeurs par défaut sont définies ici, une seule fois. Importer ce module installe le
// nettoyage des dossiers et des mocks après chaque test.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, vi } from "vitest";
import * as fls from "../fls.ts";
import type { Highlighter } from "../highlight.ts";

export type Files = Record<string, string | Buffer>;

export interface FakeOpts {
  stdin?: string;
  /** Stdin interactif (défaut : non). */
  tty?: boolean;
  stdoutTTY?: boolean;
  stderrTTY?: boolean;
  env?: Record<string, string | undefined>;
  clipboard?: string;
  id?: string;
  columns?: number;
  cacheDir?: string;
  highlighter?: Highlighter;
}

const dirs: string[] = [];

/** Supprime un dossier même si des tests y ont retiré des droits (on les rend avant de descendre). */
function remove(p: string): void {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (st === undefined) return;
  if (st.isDirectory()) {
    fs.chmodSync(p, 0o755);
    for (const name of fs.readdirSync(p)) remove(path.join(p, name));
  }
  fs.rmSync(p, { recursive: true, force: true });
}

afterEach(() => {
  for (const d of dirs.splice(0)) remove(d);
  vi.restoreAllMocks();
});

/** Écrit des fichiers (droits 644) sous `dir`, en créant les dossiers. */
export function put(dir: string, files: Files): void {
  for (const [rel, data] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    fs.chmodSync(abs, 0o644);
  }
}

/** Dossier temporaire réel (chemin résolu), nettoyé après le test ; `setup` s'exécute une fois les fichiers écrits. */
export function sandbox(files: Files = {}, setup?: (dir: string) => void): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fls-test-")));
  dirs.push(dir);
  put(dir, files);
  setup?.(dir);
  return dir;
}

/** Io complet de test : horloge fixe, id `r1`, aucun terminal, presse-papiers en mémoire. */
export function fake(cwd: string, o: FakeOpts = {}) {
  const out: Array<string | Buffer> = [];
  const err: string[] = [];
  const clip = { text: o.clipboard ?? "" };
  const io: fls.Io = {
    cwd,
    stdinIsTTY: o.tty ?? false,
    stdoutIsTTY: o.stdoutTTY ?? false,
    stderrIsTTY: o.stderrTTY ?? false,
    env: o.env ?? {},
    readStdin: () => o.stdin ?? "",
    out: (t) => {
      out.push(t);
    },
    err: (t) => {
      err.push(t);
    },
    clipboard: {
      read: () => clip.text,
      write: (t) => {
        clip.text = t;
      },
    },
    now: () => new Date("2026-11-19T10:00:00.123Z"),
    newId: () => o.id ?? "r1",
    columns: o.columns,
    cacheDir: o.cacheDir,
    highlighter: o.highlighter,
  };
  return { io, out, err, clip };
}

/** Lance `main` ; `out` garde les morceaux tels quels (string ou Buffer), `text` les concatène en UTF-8. */
export async function runFls(cwd: string, argv: string[], o: FakeOpts = {}) {
  const f = fake(cwd, o);
  const code = await fls.main(argv, f.io);
  return { code, out: f.out, text: f.out.map((x) => x.toString()).join(""), errText: f.err.join(""), clip: f.clip };
}

/** Une « session » : même dossier de travail et même cache d'une commande à l'autre. */
export function session(files: Files = {}) {
  const cwd = sandbox(files);
  const cache = path.join(sandbox(), "cache");
  return {
    cwd,
    cache,
    lastFile: path.join(cache, "last.json"),
    run: (argv: string[], o: FakeOpts & { noCache?: boolean } = {}) => runFls(cwd, argv, { ...o, cacheDir: o.noCache === true ? undefined : (o.cacheDir ?? cache) }),
    put: (f: Files) => put(cwd, f),
  };
}
