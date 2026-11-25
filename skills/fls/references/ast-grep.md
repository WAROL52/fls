# ast-grep : recherche et réécriture structurelles

`@find_ast` et `@edit_ast` délèguent à [`ast-grep`](https://ast-grep.github.io/). Le motif est un **fragment de code**, pas une regex : il tient compte de l'arbre syntaxique (appels, arguments, JSX, imports…). Utiliser ast-grep quand `@grep`/`@edit` deviennent fragiles (espaces, guillemets, multi-ligne, variantes d'appel) ; garder `@grep`/`@edit` pour du texte simple, des commentaires, du Markdown ou des fichiers non supportés.

## Vérifier le binaire

```bash
ast-grep --version     # jamais `sg` : sur Linux, /usr/bin/sg est shadow-utils
```

Minimum **0.51.0**. Installation : `npm i -g @ast-grep/cli`, `cargo install ast-grep --locked`, `brew install ast-grep`. `fls` cherche dans l'ordre `FLS_AST_GREP`, `node_modules/.bin/ast-grep`, puis le `PATH`. Absent : `ast_grep_unavailable` avec la commande d'installation ; le reste de fls continue de fonctionner.

## Syntaxe des motifs

| Écriture | Sens |
|---|---|
| `$ARG` | capture **un** nœud (identifiant, littéral, expression…) |
| `$$$ARGS` | capture **zéro ou plusieurs** nœuds (arguments, paramètres, statements…) |
| `$_` | un nœud, ignoré |
| texte | doit correspondre littéralement (ponctuation comprise) |

- `console.log($ARG)` ne matche que les appels à **un** argument ; pour zéro, un ou plusieurs : `console.log($$$ARGS)`.
- Un motif peut couvrir plusieurs lignes :
  ```
  function $F($$$PARAMS) {
    $$$BODY
  }
  ```
- Le motif doit être **du code valide** dans le langage visé. Un motif partiel refusé par ast-grep donne `ast_grep_failed` (« nœud ERROR ») ; commencer par `@find_ast` pour le vérifier.
- Les noms de métavariables sont libres ; la convention est `$MAJUSCULES`.

## Chercher

```text
@find_ast "console.log($$$ARGS)" src --lang ts --context 2
@find_ast "useEffect($$$ARGS)" src --lang tsx
@find_ast "import { $$$IMPORTS } from '$MOD'" src --lang ts
@find_ast "print($ARG)" script.py
```

- Sortie comme `@grep` : `fichier:ligne: texte`, lignes de contexte en `fichier-ligne- texte`, `--` entre groupes. Un match multi-ligne affiche toutes ses lignes.
- `--context N` ajoute N lignes autour.
- Aucun match n'est **pas** une erreur (code 0).
- `@find_ast` est une lecture : `#@find_ast` fonctionne, aucun run n'est créé.

## Réécrire

```text
@edit_ast "console.log($$$ARGS)" src --lang ts --all --rewrite "logger.info($$$ARGS)"
```

```text
@edit_ast "console.log($$$ARGS)" src --lang ts --all
<<<<<<< REWRITE
logger.info($$$ARGS, { scope: "app" })
>>>>>>> END
```

- **Unique par défaut** : plusieurs matches → `ambiguous_match` avec les positions ; ajouter `--all` (tous) ou `--first` (le premier, ordre fichier puis position).
- `--all` et `--first` sont exclusifs.
- Bloc `REWRITE` pour le multi-ligne, `--rewrite "…"` pour une ligne ; **jamais les deux**. Bloc vide = suppression du match.
- Le remplacement est calculé par ast-grep : `$ARG` / `$$$ARGS` y sont substitués. Pour un `$` littéral dans un remplacement, tester d'abord en `--dry-run`.
- Diff : `@@ bloc k (fichier:ligne)`, lignes `- ` / `+ `.
- Écriture via le Workspace : `--dry-run`, journal et `fls undo` fonctionnent ; ne jamais utiliser `--update-all` (fls ne le fait pas).

## Langage

- Fichier unique : déduit de l'extension (`.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.rs`, `.go`, `.java`, `.c`, `.cpp`, `.rb`, `.php`, `.sh`, `.yaml`, `.json`, `.css`, `.html`…).
- Dossier : `--lang` **obligatoire** (sinon `ast_grep_lang_required`).
- `--lang auto` : ast-grep déduit **par fichier** ; active les injections HTML/JS/CSS intégrées. Un fichier `.html` / `.htm` sans `--lang` utilise déjà ce mode.
- Alias courants : `ts`, `tsx`, `js`, `jsx`, `python` (`py`), `rust` (`rs`), `bash`, `yaml`, `html`, `css`, `json`, `go`, `java`, `c`, `cpp`, `ruby`, `php`. La liste exacte dépend de la version d'ast-grep.

## Pièges et limites

- **Disque au début du run** : ast-grep lit le disque, pas l'état simulé. Un fichier déjà modifié dans le même script donne `ast_grep_stale` s'il est renvoyé. Faire les recherches AST **avant** les écritures, ou dans un second run.
- **Pas de `--rule` / `sgconfig.yml` / `scan` en 1.5** : seuls les motifs `run --pattern` sont exposés.
- **Un seul langage par appel** (sauf `auto`/injections) : TS et TSX sont deux langages ; un dossier mixte exige `--lang auto` ou plusieurs appels.
- **Offsets en octets UTF-8** : gérés par fls ; ne pas bricoler les offsets à la main.
- **Fichiers ignorés** : ast-grep applique `.gitignore` ; fls revalide avec ses propres règles (`.gitignore`, `.flsignore`, `--ignore`, `.git/`, `node_modules/`, `.fls/`).

## Codes utiles

| Code | Réflexe |
|---|---|
| `ast_grep_unavailable` | installer ast-grep (message avec la commande) |
| `ast_grep_version` | mettre à jour ast-grep (≥ 0.51.0) |
| `ast_grep_failed` | motif invalide (nœud ERROR), sortie illisible, offsets incohérents, chevauchement |
| `ast_grep_lang_required` | ajouter `--lang` (ou `--lang auto` pour un dossier) |
| `ast_grep_stale` | fichier modifié plus tôt dans le script : relancer dans un nouveau run |
| `ambiguous_match` | ajouter `--all` ou `--first`, ou préciser le motif |
| `conflict` | le fichier a changé pendant l'exécution : relancer |

## Méthode

1. `@find_ast` pour vérifier le motif et le nombre de matches.
2. `fls --dry-run` avec `@edit_ast --all` (ou `--first`).
3. Relire le diff, puis exécuter sans `--dry-run`.
4. `@read` / `@expect_contains` pour contrôler, `fls undo` si besoin.
