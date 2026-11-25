// Le Rapport comme donnée : une Entrée par directive exécutée, dont le corps est une suite de
// Segments typés. Les rendus (brut, stylé) et la Dernière sortie partent de cette donnée ; plus
// aucun texte n'est reparsé pour être coloré.

export type Segment =
  /** Texte libre (arbre, message d'erreur, note…). */
  | { kind: "text"; text: string }
  /** Lignes lues d'un fichier : `from` = numéro de la première ligne, `total` = lignes du fichier. */
  | { kind: "file"; path: string; from: number; total: number; ranged: boolean; numbered: boolean; lines: string[] }
  /** Fichier non lisible comme texte (binaire, trop gros, non UTF-8…). */
  | { kind: "omitted"; path: string; code: string }
  /** Résultat de `@grep` ; `pattern` sert à mettre la correspondance en évidence. */
  | { kind: "matches"; pattern: string | null; rows: MatchRow[] }
  /** Diff de `@edit`, un hunk par bloc SEARCH / REPLACE. */
  | { kind: "diff"; hunks: Hunk[] };

export type MatchRow = { type: "match" | "context"; file: string; line: number; text: string } | { type: "sep" };

export interface Hunk {
  block: number;
  line: number;
  /** Fichier d'origine quand le diff couvre plusieurs fichiers (`@edit_ast`) ; absent pour `@edit`. */
  file?: string;
  removed: string[];
  added: string[];
}

export interface Entry {
  status: "OK" | "FAIL" | "SKIP";
  kind: string;
  title: string;
  code: string;
  body: Segment[];
}

export interface ReportDoc {
  header: string;
  entries: Entry[];
  footer: string[];
}

/** Corps réduit à un texte (aucun segment si le texte est vide). */
export const textBody = (text: string): Segment[] => (text === "" ? [] : [{ kind: "text", text }]);

/** Numéro de la dernière ligne d'un segment fichier (0 pour un fichier vide). */
export const lastLine = (s: Extract<Segment, { kind: "file" }>): number => s.from + s.lines.length - 1;

/** `chemin (N lignes)` ou `chemin (lignes A-B sur N)` : titre de l'entrée et du bloc fichier. */
export const fileTitle = (s: Extract<Segment, { kind: "file" }>): string =>
  s.ranged ? `${s.path} (lignes ${s.from}-${lastLine(s)} sur ${s.total})` : `${s.path} (${s.total} lignes)`;
