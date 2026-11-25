// Erreurs typées : le code sert de contrat (rapport, code de sortie, --help).

export class FlsError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FlsError";
    this.code = code;
  }
}

export const syntaxError = (line: number, detail: string): FlsError =>
  new FlsError("syntax_error", `ligne ${line} : ${detail}`);

export const USAGE_CODES = new Set(["syntax_error", "usage_error", "unknown_directive", "expansion_error"]);

export const ERROR_CODES: Array<[string, string]> = [
  ["syntax_error", "script mal formé (rien n'a été exécuté, code de sortie 2)"],
  ["usage_error", "mauvaise utilisation de la ligne de commande (code de sortie 2)"],
  ["unknown_directive", "`fls help` : directive inconnue (code de sortie 2)"],
  ["not_found", "chemin ou texte SEARCH introuvable"],
  ["ambiguous_match", "SEARCH trouvé plusieurs fois (les numéros de ligne sont indiqués)"],
  ["ast_grep_unavailable", "ast-grep n'est pas installé (npm i -g @ast-grep/cli)"],
  ["ast_grep_version", "version d'ast-grep trop ancienne ou illisible"],
  ["ast_grep_failed", "ast-grep a échoué (sortie illisible, offsets invalides, chevauchement…)"],
  ["ast_grep_lang_required", "ast-grep : --lang est requis quand le langage n'est pas déduit (dossier)"],
  ["ast_grep_stale", "fichier déjà modifié dans ce script : ast-grep lit l'état sur disque"],
  ["already_exists", "la destination existe déjà"],
  ["outside_workspace", "chemin absolu, `..` ou lien symbolique sortant du dossier courant"],
  ["is_directory", "un fichier était attendu, c'est un dossier"],
  ["not_a_directory", "un dossier était attendu, c'est un fichier"],
  ["symlink", "les liens symboliques ne sont jamais suivis ni modifiés"],
  ["binary_file", "fichier binaire (octet nul détecté)"],
  ["too_large", "fichier plus grand que --max-size"],
  ["not_utf8", "le fichier n'est pas de l'UTF-8 valide"],
  ["invalid_argument", "valeur d'argument ou d'option invalide"],
  ["skipped", "écriture ignorée parce qu'une écriture ou une vérification précédente a échoué"],
  ["expansion_error", "syntaxe v2 : l'expansion du script a échoué (code de sortie 2, rien n'a été exécuté)"],
  ["expectation_failed", "une vérification `@expect_*` n'est pas satisfaite (les écritures suivantes sont ignorées)"],
  ["run_not_found", "identifiant de run inconnu"],
  ["already_undone", "ce run a déjà été annulé"],
  ["nothing_to_undo", "aucun run à annuler"],
  ["conflict", "des fichiers ont changé depuis le run (undo refusé sans --force)"],
  ["no_last_output", "`fls last` : aucune sortie mémorisée à réafficher"],
  ["clipboard_unavailable", "aucun outil de presse-papiers trouvé"],
];
