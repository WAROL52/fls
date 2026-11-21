# SPEC — fls v1

Spécification du comportement de `fls.ts` (version `1.0.0`). Le « pourquoi » est dans `PRD.md`. La sortie de `fls spec` et `fls help <directive>` est générée à partir de la même table de directives que le parseur : en cas de doute, le code et les tests font foi.

Prérequis : Node.js ≥ 22.18 (ou 22.6+ avec `--experimental-strip-types`). Lancement : `node fls.ts …` (ou un alias vers ce fichier).

## 1. Invocation

| Forme | Effet |
|---|---|
| `fls` | affiche l'usage (comme `--help`) |
| `fls <chemin...>` | lecture rapide : équivaut à un `@read` par chemin |
| `fls --tree [chemin...]` | lecture rapide brute façon `treecat` (aucun ignore, aucun rapport fls) |
| `fls <<'FLS' … FLS` | script lu sur l'entrée standard |
| `fls --file script.fls` | script lu dans un fichier (relatif au dossier courant) |
| `fls --clip` | script lu dans le presse-papiers **et** rapport copié dans le presse-papiers |
| `fls <sous-commande> …` | `expand`, `undo`, `log`, `spec`, `help`, `init` |
| `fls --dry-run …` | exécute un script en simulation |

**Résolution** (dans cet ordre) :

1. `--help` / `-h` affiche l'usage ; `--version` affiche la version.
2. Si le **premier argument positionnel** est un nom de sous-commande, c'est la sous-commande (pour lire un fichier nommé `log`, écrire `./log`).
3. Sinon, s'il y a des chemins ou `--paths-from` : **lecture rapide** (`@read` normal, ou sortie brute avec `--tree`).
4. Sinon, si `--tree` est présent et l'entrée standard est un terminal : lecture rapide de `.`.
5. Sinon : **exécution de script**. Source du script : `--file`, puis `--clip` / `--clip-in`, puis l'entrée standard. `--tree` s'applique alors à tous les `@read` du script. Sans argument et sans source (entrée standard terminal), `fls` affiche l'usage (code 0) ; pour une sous-commande comme `fls expand`, l'absence de script reste une erreur `usage_error`.

Avec des chemins, `--clip` ne lit pas le presse-papiers : il y **copie** seulement le rapport (`fls src/ --clip` copie le contexte du projet).

## 2. Options globales

Toutes en forme longue, valeur séparée par un espace (`--max-size 100`, pas de `=`). Seule abréviation : `-h`.

| Option | Valeur | Rôle |
|---|---|---|
| `--tree` | — | lecture brute façon `treecat` : en lecture rapide, sortie brute ; dans un script, applique `@read --tree` à tous les reads |
| `--dry-run` | — | simule, n'écrit rien |
| `--file` | chemin | lit le script dans un fichier |
| `--clip` | — | lit le script dans le presse-papiers et y copie le rapport |
| `--clip-in` / `--clip-out` | — | un seul des deux sens |
| `--output` | chemin | écrit le rapport dans un fichier au lieu de l'afficher |
| `--paths-from` | chemin | (lecture rapide) chemins listés un par ligne |
| `--ignore` | motif | motif d'ignore supplémentaire, répétable |
| `--max-size` | entier ≥ 1 | taille maximale (octets) d'un fichier lu ou modifié ; défaut 1 048 576 |
| `--max-output-chars` | entier ≥ 1 | taille maximale du rapport ; défaut 200 000 |
| `--run` | identifiant | (`undo`, `log`) cible un run |
| `--force` | — | (`undo`) restaure malgré un conflit |
| `--help`, `-h`, `--version` | — | aide, version |

Option inconnue, valeur manquante ou nombre invalide : `usage_error`, code de sortie 2.

## 3. Sous-commandes

| Commande | Comportement |
|---|---|
| (défaut) | analyse le script, l'exécute, journalise, affiche le rapport |
| `expand` | affiche le **script plat canonique** sans l'exécuter (voir §4.5) |
| `--dry-run` | même exécution que le défaut, sans aucune écriture ni journal ; le rapport indique `dry-run` et « Modifierait » |
| `undo [--run <id>]` | annule le dernier run non annulé, ou le run indiqué (§9) |
| `log` | liste les runs : `id  date  N fichier(s)  [annulé]` ; « Aucun run enregistré. » s'il n'y en a pas |
| `log --run <id>` | affiche le script plat puis le rapport du run |
| `spec` | référence complète de la syntaxe, prête à coller dans un prompt |
| `help [directive]` | liste des directives, ou aide détaillée d'une directive (`@` facultatif) ; directive inconnue : `unknown_directive` (code 2) |
| `init` | crée `.flsignore` (modèle) s'il manque ; ajoute `.fls/` à `.gitignore` (le crée au besoin) ; idempotent |

## 4. Format de script

### 4.1 Lexique

- Le script est découpé en lignes (`\n` ou `\r\n`).
- Une ligne vide, ou dont le premier caractère non blanc est `#`, est ignorée.
- Toute autre ligne **hors bloc** doit commencer (après les espaces) par `@` suivi d'un nom de directive connu. Sinon : `syntax_error` (« ligne inattendue »).
- Il n'y a pas de commentaire en fin de ligne de directive.

### 4.2 Arguments et options

- Mots séparés par des espaces ; un mot entre guillemets droits `"…"` peut contenir des espaces ; seuls `\"` et `\\` sont des échappements (tout autre `\x` reste littéral). Guillemet non fermé : `syntax_error`.
- Un mot **non guillemeté** qui commence par `--` est une option (`--nom`, ou `--nom valeur` si l'option prend une valeur). Un mot guillemeté est toujours un argument positionnel : `@note "--tiret"` est valide.
- Alias : `-C` pour `--context` (`@grep`).
- Option inconnue pour la directive, ou valeur manquante : `syntax_error`.
- Le nombre d'arguments positionnels est contrôlé (borne min–max propre à chaque directive) : `syntax_error` sinon.

Les erreurs de syntaxe sont détectées **avant toute exécution** : rien n'est exécuté, code de sortie 2, message sur la sortie d'erreur : `fls : syntax_error : ligne N : …`.

### 4.3 Blocs

Les blocs sont **littéraux** : aucune interprétation du contenu (pas de commentaire, pas de directive, pas d'interpolation). Les lignes de marqueur sont exactes, sans espace superflu.

```
@edit chemin
<<<<<<< SEARCH
texte à trouver
=======
texte de remplacement
>>>>>>> REPLACE
<<<<<<< SEARCH        (autant de blocs que voulu, séparés ou non par des lignes vides)
…
```

```
@create|@overwrite|@write|@append chemin
<<<<<<< CONTENT
contenu
>>>>>>> END
```

- `@edit` exige au moins un bloc ; `SEARCH` ne peut pas être vide (pour créer un fichier : `@create`).
- Le premier `=======` après `SEARCH` sépare les deux moitiés ; le premier `>>>>>>> REPLACE` (resp. `>>>>>>> END`) termine le bloc. Marqueur manquant : `syntax_error`.
- Des lignes vides sont admises entre la directive et son premier bloc, et entre les blocs.
- Le contenu d'un bloc `CONTENT` se termine par un retour à la ligne s'il comporte au moins une ligne ; un bloc vide produit un fichier vide.

### 4.4 Directives acceptées sous deux formes

Pour rester compatible avec les premiers exemples : `@read f 1-30` (plage positionnelle) équivaut à `@read f --lines 1-30`, et `@write` existe en plus de `@create` / `@overwrite`. La forme explicite est la forme canonique.

### 4.5 Script plat canonique (`fls expand`)

Commentaires et lignes vides supprimés, alias remplacés par leur forme longue (`-C 2` → `--context 2`), arguments re-guillemetés au besoin, blocs conservés, une directive par paragraphe, séparés par une ligne vide. `parse(expand(x))` est équivalent à `parse(x)`. Le journal enregistre cette forme.

## 5. Directives

Convention : `[x]` facultatif, `<x>` obligatoire.

### `@tree [dossier] [--depth N] [--dirs-only]`

Arborescence (`├──`, `└──`, `│`), dossiers suffixés de `/`, liens symboliques affichés `nom -> cible` (non suivis). Dossier par défaut : `.`. Profondeur par défaut : illimitée ; `--depth 0` n'affiche que la racine. Les entrées ignorées (§7) sont exclues. Erreurs : `not_found`, `not_a_directory`, `invalid_argument`.

### `@read <chemin> [A-B] [--lines A-B] [--line-numbers] [--depth N] [--tree]`

**Fichier** : bloc

```
=== chemin (N lignes) ===
<lignes brutes, sans préfixe>
=== fin ===
```

Avec une plage : titre `(lignes A-B sur N)`. Formes de plage : `A`, `A-B`, `A-` (jusqu'à la fin) ; `B` supérieur à la fin est ramené à la fin. Plage mal formée, `A < 1`, `B < A`, ou `A` après la dernière ligne : `invalid_argument`. `--line-numbers` préfixe chaque ligne de `numéro | ` (largeur alignée).

**Dossier** (sans `--tree`) : l'arbre filtré par ignores (`--depth`), puis le bloc de chaque fichier non ignoré, séparés par une ligne vide. Un fichier illisible n'interrompt pas la lecture : il apparaît sous la forme `=== chemin ===` / `[omis : <code>]` / `=== fin ===` (`binary_file`, `too_large`, `not_utf8`, `symlink`).

**Mode `--tree`** : reproduit la sortie de `bin/treecat` (arbre, puis contenu brut de chaque fichier préfixé par la continuation). Aucun ignore n'est appliqué (`.git/`, `node_modules/`, fichiers cachés inclus). Les octets sont lus tels quels (NUL supprimés, pas de validation UTF-8), un newline final est ajouté si absent. Les liens symboliques ne sont jamais suivis : `nom -> cible`. Les fichiers/dossiers illisibles donnent `[unreadable]`. Les chemins absolus et tout segment `..` sont refusés (`outside_workspace`) ; la politique fls de confinement par lien symbolique s'applique. En lecture rapide, la sortie est brute (pas de rapport fls) et `--ignore` / `--max-size` sont refusés ; dans un script, le corps du résultat est brut mais enveloppé dans le rapport fls normal. `--tree` est incompatible avec la plage positionnelle, `--lines`, `--line-numbers` et `--depth`.

Un chemin explicite n'est **jamais filtré** par les règles d'ignore (mode normal).

### `@grep "<texte>" [chemin] [--context N | -C N] [--regex] [--ignore-case]`

Recherche littérale (ou `--regex`) ligne par ligne, dans un fichier ou récursivement dans un dossier (défaut `.`, ignores appliqués, fichiers illisibles sautés). Sortie : `fichier:ligne: texte` pour une correspondance, `fichier-ligne- texte` pour une ligne de contexte, et `--` entre deux groupes non contigus (y compris entre fichiers). Titre : `"texte" dans chemin (N correspondance(s) dans M fichier(s))`. Aucune correspondance n'est **pas** une erreur. Sur un fichier explicite, une erreur de lecture est remontée. `--regex` invalide : `invalid_argument`.

### `@note "<texte>"`

Recopie le texte dans le rapport (`NOTE texte`). Utile pour annoter les étapes d'un script.

### `@edit <fichier>` + blocs SEARCH / REPLACE

Remplace du texte existant. Règles :

1. Les blocs s'appliquent **dans l'ordre**, sur le contenu résultant des blocs précédents.
2. `SEARCH` est une **sous-chaîne exacte** (les retours à la ligne internes comptent, pas le dernier) : aucune tolérance sur les espaces ou l'indentation.
3. Il doit être trouvé **exactement une fois** : zéro → `not_found` (avec « ligne la plus proche (l.N) : … » ou « aucune ligne proche ») ; plusieurs → `ambiguous_match` (jusqu'à 5 numéros de ligne).
4. Si le fichier contient `\r\n`, `SEARCH` et `REPLACE` sont écrits avec `\r\n` ; sinon `\n`.
5. `REPLACE` vide supprime le texte ; si `SEARCH` couvre des **lignes entières**, la ligne (son retour à la ligne) disparaît aussi.
6. **Atomique** : si un bloc échoue, le fichier n'est pas modifié.

Rapport : `EDIT chemin (K bloc(s), +ajoutées -retirées)` puis, par bloc, `@@ bloc k (ligne L)`, les lignes retirées préfixées `- ` et les lignes ajoutées préfixées `+ `.

### Écritures de fichiers entiers

| Directive | Fichier existe | Fichier absent |
|---|---|---|
| `@create` | `already_exists` | créé |
| `@overwrite` | remplacé | `not_found` |
| `@write` | remplacé | créé |
| `@append` | contenu ajouté à la fin (un `\n` est inséré avant si le fichier est non vide et ne se termine pas par un retour à la ligne) | créé |

Les dossiers parents sont créés au commit. Un dossier à la place du fichier : `is_directory` ; un parent qui est un fichier : `not_a_directory` ; un lien symbolique : `symlink`. Rapport : `(nouveau|remplacé, N lignes)` ou `(+N lignes)`.

### `@delete <fichier>` et `@move <source> <destination>`

Fichiers uniquement en v1 (un dossier donne `is_directory`, un lien symbolique `symlink`). `@move` échoue (`already_exists`) si la destination existe, **conserve les permissions**, et crée les dossiers parents. Les dossiers laissés vides ne sont pas supprimés.

## 6. Sémantique d'exécution

- **Surcouche en mémoire** : toutes les directives lisent et écrivent un état simulé au-dessus du disque. Un `@read` ou un `@tree` après une écriture voit le résultat ; un dossier créé virtuellement apparaît dans l'arbre.
- **Politique d'échec** : un `FAIL` sur une directive d'**écriture** (`@edit`, `@create`, `@overwrite`, `@write`, `@append`, `@delete`, `@move`) fait passer les écritures suivantes en `SKIP` (code `skipped`) ; les lectures continuent. Un `FAIL` sur une lecture ne bloque rien.
- **Commit** (hors `--dry-run`) : seuls les changements **effectifs** sont écrits (un fichier recréé à l'identique, ou créé puis supprimé dans le même script, n'est pas un changement). Chaque fichier est écrit dans un fichier temporaire `<chemin>.fls-tmp` puis renommé (atomique), avec ses permissions d'origine (644 pour un nouveau fichier).
- **Conservation** : fins de ligne, BOM et permissions sont préservés ; un fichier non UTF-8 valide est refusé (`not_utf8`), comme un binaire (octet nul dans les 8000 premiers octets : `binary_file`) ou un fichier de plus de `--max-size` octets (`too_large`).

## 7. Chemins et ignores

- **Confinement** : un chemin absolu, un chemin qui remonte au-dessus du dossier courant, ou qui traverse un lien symbolique menant hors de ce dossier : `outside_workspace`.
- **Liens symboliques** : jamais suivis ni modifiés ; listés `nom -> cible` ; `[omis : symlink]` dans une lecture de dossier.
- **Règles d'ignore** (pour `@tree`, `@read <dossier>` sans `--tree`, `@grep <dossier>`) : toujours `.git/`, `node_modules/`, `.fls/` ; plus les lignes de `.gitignore` et `.flsignore` à la racine, plus `--ignore`. Syntaxe reconnue : lignes vides et `#` ignorées ; `*`, `**`, `?` ; `/` final = dossiers seulement ; un motif contenant `/` est ancré sur le chemin relatif à la racine, sinon il s'applique au nom à toute profondeur. Les lignes de négation `!` sont ignorées. `@read --tree` / `fls --tree` n'applique aucun ignore.

## 8. Rapport

```
fls 1.0.0 | run 20261119-100000123-a1b2 | /chemin/du/projet | 2026-11-19T10:00:00.123Z

[1] OK    TREE src
…
[2] FAIL  EDIT src/x.ts : not_found
    bloc 1 : SEARCH introuvable dans src/x.ts (ligne la plus proche (l.42) : "…")

[3] SKIP  CREATE a.ts : skipped
    ignoré : une écriture précédente a échoué

Résumé : 1 OK, 1 FAIL, 1 SKIP
Modifiés : src/user.ts, src/roles.ts
Annulable avec : fls undo
```

- Une entrée numérotée par directive : `[n] STATUT  DIRECTIVE titre[ : code]`, suivie du corps éventuel ; entrées séparées par une ligne vide.
- En-tête : version, `run <id>` (ou `dry-run`), dossier courant, date ISO. L'identifiant est `AAAAMMJJ-HHMMSSmmm-xxxx` (ordre chronologique).
- Pied : résumé, `Modifiés` (ou `Modifierait` en simulation ; « aucun » s'il n'y a rien), et `Annulable avec : fls undo` si le run a été journalisé.
- **Troncature** : au-delà de `--max-output-chars`, le rapport est coupé et se termine par `[rapport tronqué : N caractères omis ; relance avec --max-output-chars]`.
- Les erreurs de syntaxe, d'usage et de commande (`undo`, `log`…) vont sur la **sortie d'erreur** : `fls : <code> : <message>`.

## 9. Journal, `log`, `undo`

Un run n'est journalisé que s'il a produit au moins un changement effectif. Contenu de `.fls/runs/<id>/` :

| Fichier | Contenu |
|---|---|
| `meta.json` | `id`, `date`, `undone`, et pour chaque fichier touché : `path`, `backup` (nom du fichier de sauvegarde ou `null` s'il n'existait pas), `mode`, `after` (empreinte SHA-1 du contenu écrit, `null` si supprimé) |
| `script.fls` | script plat canonique |
| `report.txt` | rapport complet |
| `backup/<n>` | contenu d'origine de chaque fichier existant avant le run |

`undo` :

1. choisit `--run <id>` ou, à défaut, le **plus récent run non annulé** (`nothing_to_undo` s'il n'y en a pas) ;
2. refuse un run déjà annulé (`already_undone`) ou inconnu (`run_not_found`, l'identifiant doit correspondre à `[\w-]+`) ;
3. vérifie, pour chaque fichier, que le contenu actuel correspond à `after` ; sinon `conflict` (liste des fichiers) et **rien n'est restauré**, sauf avec `--force` ;
4. restaure les contenus et permissions d'origine, supprime les fichiers que le run avait créés, marque le run `undone`.

Les dossiers créés par le run ne sont pas supprimés.

## 10. Codes d'erreur et de sortie

**Codes de sortie** : `0` tout est `OK` ; `1` au moins un `FAIL`, ou erreur de commande (`undo`, `log`, fichier de script absent, presse-papiers…) ; `2` erreur de syntaxe ou d'usage (**rien n'a été exécuté**).

| Code | Sens |
|---|---|
| `syntax_error` | script mal formé (exit 2) |
| `usage_error` | ligne de commande invalide (exit 2) |
| `unknown_directive` | `fls help` sur une directive inconnue (exit 2) |
| `not_found` | chemin ou texte SEARCH introuvable |
| `ambiguous_match` | SEARCH trouvé plusieurs fois |
| `already_exists` | destination existante |
| `outside_workspace` | chemin hors du dossier courant |
| `is_directory` / `not_a_directory` | mauvais type de chemin |
| `symlink` | lien symbolique non géré |
| `binary_file` / `too_large` / `not_utf8` | fichier non lisible comme texte |
| `invalid_argument` | valeur d'argument ou d'option invalide |
| `skipped` | écriture ignorée après un échec |
| `run_not_found` / `already_undone` / `nothing_to_undo` / `conflict` | journal et `undo` |
| `clipboard_unavailable` | aucun outil de presse-papiers |

## 11. Presse-papiers

Premier outil qui réussit, dans l'ordre : `wl-paste` / `wl-copy`, `xclip -selection clipboard`, `xsel --clipboard`, `pbpaste` / `pbcopy`, `powershell.exe Get-Clipboard` / `clip.exe` (WSL). Aucun : `clipboard_unavailable`. Les écritures redirigent la sortie standard et d'erreur de l'outil vers rien, pour ne pas bloquer sur les outils qui restent en arrière-plan (`wl-copy`, `xclip`).

## 12. Limites connues de la v1

- Pas de repli sur les espaces de fin de ligne : la correspondance de SEARCH est exacte (aux fins de ligne CRLF/LF près).
- `@delete` et `@move` ne gèrent pas les dossiers ; pas de globs ni de `--all`.
- `undo` ne supprime pas les dossiers vides créés ; il ne protège que les fichiers touchés par le run.
- Un chemin dont un parent est un fichier est traité comme absent en lecture et refusé en écriture (`not_a_directory`).
- Pas de Windows natif (chemins POSIX uniquement).
- Aucune syntaxe de programmation : la v2 produira, par une phase d'expansion préalable, le script plat décrit ici.

## 13. Architecture et tests

- **Entrées/sorties injectées** (`Io` : dossier courant, entrée standard, sorties, presse-papiers, horloge, identifiant) ; `main(argv, io)` renvoie le code de sortie. Le vrai `Io` n'est construit qu'au chargement du module, et le démarrage passe par `bootstrap(isEntry(...), start)`, entièrement testable.
- **Tables** plutôt que chaînes de `if` : directives (`DIRECTIVES`, utilisées par le parseur, l'aide et la spec), sous-commandes, options globales, lecteurs/écrivains de blocs, vérifications d'écriture, outils de presse-papiers.
- **Modules** : `src/fls.ts` (parseur, exécution, rapport, journal, aide, CLI), `src/directive/<nom>.ts` (une `Spec` par directive, assemblées par `src/directive/index.ts`), et les modules de base `types.ts`, `errors.ts`, `text.ts`, `paths.ts`, `workspace.ts`.
- **`Workspace`** : surcouche en mémoire au-dessus du disque ; le dry-run et l'exécution réelle partagent tout le code, seul `apply` (commit) diffère.
- **Syntaxe TypeScript effaçable uniquement** (ni `enum` ni propriétés de paramètre) : `node src/fls.ts` suffit.

Lancer les tests (à la racine du projet) :

```
pnpm add -D vitest @vitest/coverage-v8
pnpm run test:coverage
```

La suite utilise de vrais dossiers temporaires, des liens symboliques réels, de vrais sous-processus pour le presse-papiers, le binaire et la parité `treecat`, et exige 100 % de couverture sur statements, branches, fonctions et lignes pour tous les modules de `src/`.
