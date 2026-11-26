# SPEC — fls v1

Spécification du comportement de `fls.ts` (version `1.7.0`). Le « pourquoi » est dans `PRD.md`. La sortie de `fls spec` et `fls help <directive>` est générée à partir de la même table de directives que le parseur : en cas de doute, le code et les tests font foi.

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
| `fls last` | réaffiche la dernière sortie, sans rien réexécuter (§3, §8 bis) |
| `fls <sous-commande> …` | `expand`, `undo`, `log`, `last`, `spec`, `help`, `init` |
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
| `--color <mode>` | `auto` | `auto` colore sur TTY (stdout/stderr selon la sortie), `always` force la couleur même hors TTY/fichier/clip, `never` désactive |
| `--colored` | — | alias de `--color=always` |
| `--no-color` | — | alias de `--color=never` ; `NO_COLOR` est honoré en `auto` |
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

**Couleur.** `--color=auto|always|never` (défaut `auto`), `--colored` = `always`, `--no-color` = `never`. En `auto`, la couleur s'active sur TTY et `NO_COLOR` la désactive. `always` force la couleur sur stdout/stderr, `--output` et `--clip`. `expand` reste toujours brut. `--tree --colored` colore l'arborescence et les contenus (Shiki, thème **opencode** sombre : commentaire `#808080`, mot-clé `#9d7cd8`, fonction `#fab283`, variable `#e06c75`, chaîne `#7fd88f`, nombre `#f5a742`, type `#e5c07b`, opérateur `#56b6c2`, texte `#eeeeee`; diffs `+` `#20303b` et `-` `#37222c`) ; `--tree` sans couleur conserve la parité treecat octet pour octet. Le **fond** (`#141414`, le panneau de code du thème opencode, jusqu'au bord droit ; `FLS_BG=#rrggbb` le change) n'est appliqué qu'aux contenus de fichier : lignes lues par `@read` / `--tree`, résultats de `@grep` et lignes `+` / `-` de `@edit` (fond vert / rouge). L'en-tête, les titres, les notes, le résumé, l'arbre, l'usage et l'aide n'ont pas de fond.

## 3. Sous-commandes

| Commande | Comportement |
|---|---|
| (défaut) | analyse le script, l'exécute, journalise, affiche le rapport |
| `expand` | affiche le **script plat canonique** sans l'exécuter (voir §4.5) |
| `--dry-run` | même exécution que le défaut, sans aucune écriture ni journal ; le rapport indique `dry-run` et « Modifierait » |
| `undo [--run <id>]` | annule le dernier run non annulé, ou le run indiqué (§9) |
| `log` | liste les runs : `id  date  N fichier(s)  [annulé]` ; « Aucun run enregistré. » s'il n'y en a pas |
| `log --run <id>` | affiche le script plat puis le rapport du run |
| `last` | réaffiche la **dernière sortie** (lecture rapide, `--tree` ou script, `--dry-run` compris) **sans rien réexécuter**, recolorée et repliée à la largeur actuelle du terminal (§8 bis). Accepte `--color`, `--colored`, `--no-color`, `--output`, `--clip` ; code de sortie 0. `no_last_output` (code 1) s'il n'y a rien de mémorisé |
| `spec` | référence complète de la syntaxe, prête à coller dans un prompt |
| `help [directive]` | liste des directives, ou aide détaillée d'une directive (`@` facultatif) ; directive inconnue : `unknown_directive` (code 2) |
| `init` | crée `.flsignore` (modèle) s'il manque ; ajoute `.fls/` à `.gitignore` (le crée au besoin) ; idempotent |

## 4. Format de script

### 4.1 Lexique

- Le script est découpé en lignes (`\n` ou `\r\n`).
- Une ligne vide, ou dont le premier caractère non blanc est `#`, est ignorée.
- Toute autre ligne **hors bloc** doit commencer (après les espaces) par `@` suivi d'un nom de directive connu. Sinon : `syntax_error` (« ligne inattendue »).
- Il n'y a pas de commentaire en fin de ligne de directive.

### 4.1 bis Forme collable `#@` et zone clip (depuis 1.1.0)

Pour qu'un script puisse être collé tel quel dans un shell (où `#…` est un commentaire) puis relu par `fls --clip` :

- **`#@nom …`** (le `@` collé au `#`, suivi d'une lettre) est strictement équivalent à `@nom …` et se mélange librement avec la forme `@`. Limité aux directives de **lecture** (`tree`, `read`, `grep`, `find_ast`, `stat`, `history`, `note`, vérifications) : une directive d'écriture donne `syntax_error` (« les directives d'écriture exigent la forme `@nom` »), car leurs blocs ne sont pas des commentaires pour le shell. `#@` suivi d'un nom inconnu : `syntax_error`. `#@ texte` (espace) et `# @read` restent des commentaires.
- **Zone clip** : si le script contient au moins une ligne `clip start` (regex `^\s*#{3,}\s*clip\s+(start|end)\s*#*\s*$`, insensible à la casse, ex. `##### clip start #####`), seules les lignes situées entre `clip start` et `clip end` sont analysées (jusqu'à la fin si `clip end` manque). Plusieurs zones sont concaténées dans l'ordre ; tout le reste (texte avant, entre, après, y compris `cd … && fls --clip`) est ignoré. Sans marqueur `clip start`, aucun changement. La numérotation des lignes des erreurs reste celle du texte complet.
- `fls expand`, le journal et le rapport écrivent toujours la forme canonique `@nom`.

Exemple :

```
##### clip start #####
#@note "rendu de la nav"
#@read apps/web/src/components/app-sidebar.tsx
#@grep "export type RoleName" . --context 5
##### clip end #####
cd ~/DEV/HIVELAB && fls --clip
```

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

```
@edit_ast "motif" [chemin]
<<<<<<< REWRITE
remplacement
>>>>>>> END
```

```
@insert chemin --before|--after
<<<<<<< SEARCH
ancre
>>>>>>> END
<<<<<<< CONTENT
contenu à insérer
>>>>>>> END
```

- `@edit` exige au moins un bloc ; `SEARCH` ne peut pas être vide (pour créer un fichier : `@create`).
- `@edit_ast` accepte un bloc `REWRITE` **ou** l'option `--rewrite "…"`, pas les deux. Un bloc vide supprime le match ; sans bloc ni `--rewrite` : `invalid_argument`.
- Le premier `=======` après `SEARCH` sépare les deux moitiés ; le premier `>>>>>>> REPLACE` (resp. `>>>>>>> END`) termine le bloc. Marqueur manquant : `syntax_error`.
- Des lignes vides sont admises entre la directive et son premier bloc, et entre les blocs.
- Le contenu d'un bloc `CONTENT` se termine par un retour à la ligne s'il comporte au moins une ligne pour `@create`, `@overwrite`, `@write`, `@append` ; un bloc vide produit un fichier vide. Pour `@insert`, le contenu est **brut** (inséré tel quel).

### 4.4 Directives acceptées sous deux formes

Pour rester compatible avec les premiers exemples : `@read f 1-30` (plage positionnelle) équivaut à `@read f --lines 1-30`, et `@write` existe en plus de `@create` / `@overwrite`. La forme explicite est la forme canonique.

### 4.5 Script plat canonique (`fls expand`)

Commentaires et lignes vides supprimés, alias remplacés par leur forme longue (`-C 2` → `--context 2`), arguments re-guillemetés au besoin, blocs conservés, une directive par paragraphe, séparés par une ligne vide. `parse(expand(x))` est équivalent à `parse(x)`. Le journal enregistre cette forme.

### 4.6 Syntaxe v2 : `@fls 2` (depuis 1.4.0)

Un script dont la **première ligne utile** est `@fls 2` (en zone clip : `#@fls 2`) est un **Script source** : il est **étendu avant toute exécution** en un Script plat (la syntaxe v1, §4.5). Sans cette ligne, rien ne change : `{{` reste du texte, et un script v1 s'exécute à l'identique. Toute autre version (`@fls 3`) ou un `@fls` ailleurs qu'en tête est une `syntax_error`.

**Modèle d'évaluation.** L'expansion lit le disque **tel qu'il est au départ** (`exists`, `read`, `glob`…) ; elle ne voit jamais l'état simulé par les écritures du script. Elle produit un Script plat que `fls expand` affiche, que `--dry-run` simule, que le Journal enregistre et que `undo` annule comme avant. Le Rapport est celui du script plat : une entrée par directive émise, les lignes de contrôle n'y figurent pas.

**Lignes de contrôle** (une par ligne ; l'indentation n'a aucun sens ; `@end` ferme la construction ouverte la plus proche) :

| Ligne | Effet |
|---|---|
| `@let nom = expression` | affecte une variable |
| `@for nom in expression` … `@end` | parcourt une liste (ou les clés d'un dictionnaire) ; la variable reste définie après la boucle |
| `@if expression` … `@elif expression` … `@else` … `@end` | condition (vrai/faux à la façon de Python : `0`, `""`, `[]`, `{}` sont faux) |
| `@def nom(a, b)` … `@end` | définit une **macro** (premier niveau seulement) |
| `@call nom(x, y)` | émet les directives de la macro, paramètres remplacés |

Une macro voit ses paramètres, ses propres `@let` et les variables globales ; ses `@let` ne fuient pas. Elle ne peut appeler que des macros **déjà définies plus haut** : la récursion est donc impossible par construction (`expansion_error` sinon). Il n'y a pas de fonction de valeur écrite par l'utilisateur : le calcul passe par les fonctions intégrées.

**Interpolation `{{ expression }}`** dans les arguments et les valeurs d'option d'une directive. Dans une ligne de directive, `{{ … }}` est une unité (ses espaces ne coupent pas le mot) ; la valeur doit être un **texte ou un entier** (liste, dictionnaire, booléen : `expansion_error`). `\{{` donne un `{{` littéral. Un mot qui contient une interpolation n'est **jamais une option** : une valeur calculée ne peut pas en fabriquer une.

**Blocs.** `SEARCH`/`REPLACE` et `CONTENT` restent **littéraux** (même `{{ }}`, même une ligne `@for`) : un composant React avec `style={{ … }}` se colle tel quel. Un bloc interpolé s'ouvre par `<<<<<<< TEMPLATE` (au lieu de `CONTENT`, pour `@create`, `@overwrite`, `@write`, `@append`) ou par `<<<<<<< SEARCH TEMPLATE` (au lieu de `SEARCH`, pour `@edit` : le SEARCH et le REPLACE de ce bloc sont interpolés ; un `@edit` peut mêler blocs littéraux et blocs `TEMPLATE`). Un SEARCH vide après interpolation est une erreur. Ces marqueurs n'existent pas en syntaxe v1.

**Expressions** (analyseur écrit à la main, aucun `eval`) : textes (`"…"` ou `'…'`, échappements `\n \t \\ \" \'`), entiers, `True`/`False`, listes `[…]`, dictionnaires `{"a": 1}` (clés texte ou entier) ; `+ - * // %` (entiers ; `+` aussi sur textes et listes, `*` texte × entier ; `//` et `%` à la Python), `== != < <= > >=`, `and or not` (valeurs à la Python), `in` / `not in`, `x[i]` (indice négatif permis), `a if c else b`. Pas de flottants, de `None`, de méthodes (`upper(x)`, pas `x.upper()`), de lambda ni de compréhension. Plafonds : expression de 2000 caractères et 64 niveaux d'imbrication, texte de 1 000 000 de caractères, liste de 10 000 éléments, entiers sûrs de JavaScript.

**Fonctions intégrées** (lecture seule ; mêmes règles que les lectures : confinement au dossier courant, liens non suivis, binaires et fichiers trop gros refusés ; ni shell, ni réseau, ni horloge, ni aléatoire, donc une expansion est déterministe) : `glob(motif)` (fichiers, triés, règles d'ignore ; `*`, `**`, `?` ; `src/**/*.ts` inclut `src/a.ts`), `exists`, `is_file`, `is_dir`, `read`, `lines`, `len`, `range`, `sorted`, `join`, `split`, `replace`, `upper`, `lower`, `capitalize` (première lettre seulement), `strip`, `startswith`, `endswith`, `basename`, `dirname`, `stem`, `int`, `str`. La liste exacte et les signatures sont dans `fls spec`.

**Options.** `--set nom=valeur` (répétable ; toujours un texte ; `int()` convertit) définit une variable globale avant l'expansion ; `--max-expanded N` (défaut 2000) plafonne les directives émises. Les deux n'ont de sens que pour un script `@fls 2` (sinon `usage_error`). L'expansion est aussi bornée à 200 000 étapes, et 50 niveaux de constructions imbriquées.

**Forme `#@`.** Les lignes de contrôle sont permises en `#@`. Les directives restent soumises à la règle de la forme `#@` : une écriture est refusée, y compris celle qu'émet une macro appelée par `#@call` (`expansion_error`).

**Erreurs.** Script mal formé (construction non fermée, `@end` orphelin, expression invalide, directive inconnue…) : `syntax_error`. Erreur à l'évaluation (variable inconnue, division par zéro, type invalide, plafond, lecture impossible…) : `expansion_error`, avec la ligne du script source et, dans une macro, la chaîne d'appel (`dans la macro m, appelée ligne N`). Dans les deux cas : **code de sortie 2, rien n'est exécuté**.

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

### `@find_ast "<motif>" [chemin] [--lang <langage>|auto] [--context N]`

Recherche **structurelle** déléguée à `ast-grep` (binaire externe optionnel, §12) : le motif est un fragment de code, pas une expression régulière. `$X` capture un nœud, `$$$X` capture zéro ou plusieurs nœuds, `$_` ignore un nœud. Exemples : `console.log($ARG)`, `useEffect($$$ARGS)`, `function $F($$$P) { $$$B }`.

- Chemin par défaut : `.`. Les fichiers ignorés (§7) sont exclus et les chemins renvoyés par ast-grep sont validés (fichier ordinaire, dans le dossier, UTF-8, taille).
- **Langage** : déduit de l'extension pour un fichier unique ; **obligatoire** pour un dossier (`ast_grep_lang_required`). `--lang auto` laisse ast-grep déduire **par fichier** et active les injections HTML intégrées (JS/CSS dans `<script>` / `<style>`) ; un fichier `.html`/`.htm` sans `--lang` utilise déjà ce mode.
- Sortie : comme `@grep` (`fichier:ligne: texte`, `fichier-ligne- texte` pour le contexte, `--` entre groupes). Un match multi-ligne affiche toutes ses lignes. Aucune correspondance n'est **pas** une erreur.
- `@find_ast` est une lecture : `#@find_ast` est accepté, aucun run n'est créé.
- Erreurs : `ast_grep_unavailable` (binaire absent), `ast_grep_version` (version < 0.51.0), `ast_grep_failed` (motif invalide, sortie illisible, offsets incohérents), `ast_grep_stale` (fichier déjà modifié dans ce script, §6), `ast_grep_lang_required`.

### `@note "<texte>"`

Recopie le texte dans le rapport (`NOTE texte`). Utile pour annoter les étapes d'un script.

### `@edit <fichier> [--all]` + blocs SEARCH / REPLACE

Remplace du texte existant. Règles :

1. Les blocs s'appliquent **dans l'ordre**, sur le contenu résultant des blocs précédents.
2. `SEARCH` est une **sous-chaîne exacte** (les retours à la ligne internes comptent, pas le dernier) : aucune tolérance sur les espaces ou l'indentation.
3. Sans `--all`, il doit être trouvé **exactement une fois** : zéro → `not_found` (avec « ligne la plus proche (l.N) : … » ou « aucune ligne proche ») ; plusieurs → `ambiguous_match` (jusqu'à 5 numéros de ligne).
4. Avec `--all`, **toutes les occurrences** non chevauchantes de chaque bloc sont remplacées (ordre des blocs conservé, chaque bloc s'applique sur le contenu résultant). Zéro occurrence → `not_found` ; pas d'`ambiguous_match`.
5. Si le fichier contient `\r\n`, `SEARCH` et `REPLACE` sont écrits avec `\r\n` ; sinon `\n`.
6. `REPLACE` vide supprime le texte ; si `SEARCH` couvre des **lignes entières**, la ligne (son retour à la ligne) disparaît aussi, par occurrence.
7. **Atomique** : si un bloc échoue, le fichier n'est pas modifié.

Rapport : `EDIT chemin (K bloc(s), +ajoutées -retirées)` puis, par occurrence, `@@ bloc k (ligne L)`, les lignes retirées préfixées `- ` et les lignes ajoutées préfixées `+ ` (plusieurs hunks pour un même bloc en mode `--all`).

### `@edit_ast "<motif>" [chemin] [--lang <langage>|auto] [--all | --first] [--rewrite "…"]` + bloc REWRITE

Réécriture **structurelle** : ast-grep calcule les matches et leurs remplacements, fls valide puis écrit via le Workspace (donc `--dry-run`, journal et `undo` fonctionnent, et aucun fichier hors dossier n'est touché). Le remplacement utilise la syntaxe ast-grep (`$X`, `$$$X`).

- **Unique par défaut** : plusieurs matches → `ambiguous_match` avec jusqu'à 5 positions `fichier:ligne` ; `--all` les applique tous, `--first` seulement le premier (ordre fichier puis position). `--all` et `--first` sont exclusifs.
- Remplacement : bloc `REWRITE` (multi-ligne, vide = suppression) ou `--rewrite "…"` (une ligne), jamais les deux. Un seul des deux est obligatoire.
- **Atomique** : tous les offsets (octets UTF-8), textes et chevauchements sont validés pour tous les fichiers avant la première écriture ; un fichier modifié entre-temps donne `conflict`. Les fichiers inchangés ne sont pas réécrits.
- `--lang` : mêmes règles que `@find_ast` (obligatoire pour un dossier, `auto` pour la déduction par fichier et les injections HTML).
- Les directives AST lisent le disque **au début du run** ; un fichier déjà modifié par une directive précédente du même script donne `ast_grep_stale` (§6).
- Rapport : `EDIT_AST "motif" dans chemin (K remplacement(s), M fichier(s))` puis un diff multi-fichiers, un bloc par match : `@@ bloc k (fichier:ligne)`, lignes retirées `- ` et ajoutées `+ `.

### `@insert <fichier> <ancre> [--all]` + bloc CONTENT

Insère du contenu **brut** (tel quel, sans ajout automatique de retour à la ligne final) à une position donnée. Une seule insertion par directive.

**Ancres (mutuellement exclusives)** :

- `--line <N> [--after]` : avant la ligne N (1-based) ; avec `--after`, après la ligne N. `N = nombre_de_lignes + 1` est accepté (fin de fichier).
- `--line <N> --col <C>` : dans la ligne N, à la colonne C (1-based, codepoints Unicode ; `1` = avant le premier caractère, `len+1` = fin de ligne). `--after` interdit avec `--col`.
- `--eof` : fin de fichier.
- `--before "<texte>"` / `--after "<texte>"` : ancre SEARCH inline (texte exact). Unicité par défaut ; `--all` applique à toutes les occurrences non chevauchantes.
- `--before` / `--after` (sans valeur) + bloc `<<<<<<< SEARCH` / `>>>>>>> END` puis bloc `<<<<<<< CONTENT` / `>>>>>>> END` : ancre SEARCH multi-ligne.

**Règles** :

- `--all` uniquement avec une ancre SEARCH. 0 occurrence → `not_found` ; plusieurs sans `--all` → `ambiguous_match`.
- `--col` hors `[1, len+1]` ou ligne hors bornes → `invalid_argument`.
- Le contenu inséré est brut : `@insert ... --line 2 --col 3` avec CONTENT `X` dans `abc` donne `abXc`.
- Fins de ligne du contenu normalisées sur le fichier cible (`\r\n` ou `\n`).
- **Atomique** : en cas d'échec, le fichier n'est pas modifié.

Rapport : `INSERT chemin (...)` puis un hunk diff `@@ bloc 1 (ligne L)` avec les lignes ajoutées préfixées `+ ` (un hunk par occurrence en mode `--all`).

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

### Nouveautés de 1.3.0

#### `@copy <source> <destination>`

Comme `@move` sans supprimer la source : fichiers uniquement, `already_exists` si la destination existe, **permissions conservées**, dossiers parents créés. Écriture (bloquée par un échec précédent).

#### `@mkdir <dossier>`

Crée le dossier et ses parents (comme `mkdir -p`), **même vide**. Un dossier déjà présent est un `OK` « existe déjà » sans effet : il ne produit pas de run. Un fichier à cet endroit ou en parent : `not_a_directory` ; un lien symbolique : `symlink`. Le dossier est visible dans la surcouche (`@tree`, `--tree`) dès sa création. Le Journal enregistre les dossiers réellement créés (`dirs` dans `meta.json`) ; `undo` les supprime du plus profond au plus haut **s'ils sont restés vides**, sinon il les conserve et le dit. Écriture.

#### `@stat <chemin>`

Lecture. Un fichier : `type`, `taille` (octets), `lignes` (seulement s'il est lisible comme texte), `droits` (`0644`), `sha1`. Un dossier : `type`, `éléments`. Un lien : `type : lien symbolique -> cible`. Pas de date de modification (le rapport doit être reproductible). Chemin absent : `not_found`. Il voit l'état simulé.

#### `@history [chemin] [--limit N]`

Lecture du Journal (jamais enregistrée comme run). Sans chemin : les runs, du plus récent au plus ancien, avec le nombre de fichiers et de dossiers ; avec un chemin : seulement ceux qui l'ont touché, avec l'action (`créé`, `modifié`, `supprimé`, `dossier créé`). Un fichier déplacé apparaît sous ses deux noms. Les runs annulés restent listés avec `(annulé)`. `--limit` : entier >= 1, défaut 10. Sans run : `OK`, « aucun run ».

#### Vérifications `@expect_exists <chemin>`, `@expect_missing <chemin>`, `@expect_contains <fichier> "<texte>" [--regex] [--count N]`

Constatent un fait sur l'état simulé (un `@expect_contains` après un `@edit` vérifie son résultat). Un échec est un `FAIL` de code `expectation_failed` dont le message donne le constat (`attendu : … ; trouvé : …`) ; **il bloque les écritures suivantes** (`SKIP`, code `skipped`) comme un échec d'écriture, mais les lectures continuent. Les écritures déjà appliquées **ne sont pas annulées** : `fls undo` revient en arrière. `@expect_contains` : au moins une occurrence, ou exactement `N` avec `--count` ; les occurrences sont toutes comptées dans le texte entier (deux sur la même ligne = deux) ; le message d'échec donne au plus 10 numéros de ligne. Un texte sur plusieurs lignes ne s'écrit qu'avec `--regex` (`\s`, `\n`), parce qu'une directive tient sur une ligne. Les erreurs de lecture gardent leur code (`not_found`, `binary_file`…). `@stat`, `@history` et les vérifications s'écrivent aussi en forme `#@` ; `@copy` et `@mkdir` non.

## 6. Sémantique d'exécution

- **Surcouche en mémoire** : toutes les directives lisent et écrivent un état simulé au-dessus du disque. Un `@read` ou un `@tree` après une écriture voit le résultat ; un dossier créé virtuellement apparaît dans l'arbre.
- **Exception AST** : `@find_ast` et `@edit_ast` délèguent à un binaire externe qui lit le disque **au début du run**. Les fichiers modifiés par une directive précédente du même script ne sont donc pas visibles ; si ast-grep renvoie un de ces fichiers, la directive échoue avec `ast_grep_stale` (jamais de résultat ou d'écriture sur une base périmée). Les écritures calculées passent ensuite par le Workspace : dry-run, journal et undo restent valables.
- **Politique d'échec** : un `FAIL` sur une directive d'**écriture** (`@edit`, `@edit_ast`, `@insert`, `@create`, `@overwrite`, `@write`, `@append`, `@mkdir`, `@copy`, `@delete`, `@move`) ou sur une **vérification** (`@expect_*`) fait passer les écritures suivantes en `SKIP` (code `skipped`) ; les lectures continuent. Un `FAIL` sur une lecture ne bloque rien.
- **Commit** (hors `--dry-run`) : seuls les changements **effectifs** sont écrits (un fichier recréé à l'identique, ou créé puis supprimé dans le même script, n'est pas un changement). Chaque fichier est écrit dans un fichier temporaire `<chemin>.fls-tmp` puis renommé (atomique), avec ses permissions d'origine (644 pour un nouveau fichier).
- **Conservation** : fins de ligne, BOM et permissions sont préservés ; un fichier non UTF-8 valide est refusé (`not_utf8`), comme un binaire (octet nul dans les 8000 premiers octets : `binary_file`) ou un fichier de plus de `--max-size` octets (`too_large`).

## 7. Chemins et ignores

- **Confinement** : un chemin absolu, un chemin qui remonte au-dessus du dossier courant, ou qui traverse un lien symbolique menant hors de ce dossier : `outside_workspace`.
- **Liens symboliques** : jamais suivis ni modifiés ; listés `nom -> cible` ; `[omis : symlink]` dans une lecture de dossier.
- **Règles d'ignore** (pour `@tree`, `@read <dossier>` sans `--tree`, `@grep <dossier>`, `@find_ast <dossier>`, `@edit_ast <dossier>`) : toujours `.git/`, `node_modules/`, `.fls/` ; plus les lignes de `.gitignore` et `.flsignore` à la racine, plus `--ignore`. Syntaxe reconnue : lignes vides et `#` ignorées ; `*`, `**`, `?` ; `/` final = dossiers seulement ; un motif contenant `/` est ancré sur le chemin relatif à la racine, sinon il s'applique au nom à toute profondeur. Les lignes de négation `!` sont ignorées. ast-grep applique en plus ses propres règles (`.gitignore`) ; fls revalide chaque chemin renvoyé. `@read --tree` / `fls --tree` n'applique aucun ignore.

## 8. Rapport

```
fls 1.7.0 | run 20261119-100000123-a1b2 | /chemin/du/projet | 2026-11-19T10:00:00.123Z

[1] OK    TREE src
…
[2] FAIL  EDIT src/x.ts : not_found
    bloc 1 : SEARCH introuvable dans src/x.ts (ligne la plus proche (l.42) : "…")

[3] SKIP  CREATE a.ts : skipped
    ignoré : une écriture ou une vérification précédente a échoué

Résumé : 1 OK, 1 FAIL, 1 SKIP
Modifiés : src/user.ts, src/roles.ts
Annulable avec : fls undo
```

- Une entrée numérotée par directive : `[n] STATUT  DIRECTIVE titre[ : code]`, suivie du corps éventuel ; entrées séparées par une ligne vide.
- En-tête : version, `run <id>` (ou `dry-run`), dossier courant, date ISO. L'identifiant est `AAAAMMJJ-HHMMSSmmm-xxxx` (ordre chronologique).
- Pied : résumé, `Modifiés` (ou `Modifierait` en simulation ; « aucun » s'il n'y a rien), et `Annulable avec : fls undo` si le run a été journalisé.
- **Troncature** : au-delà de `--max-output-chars`, le rapport est coupé et se termine par `[rapport tronqué : N caractères omis ; relance avec --max-output-chars]`.
- Les erreurs de syntaxe, d'usage et de commande (`undo`, `log`…) vont sur la **sortie d'erreur** : `fls : <code> : <message>`.

## 8 bis. Affichage coloré : numéros de ligne, repli et `fls last` (depuis 1.2.0)

**Numéros de ligne.** En sortie colorée, tout contenu de fichier (`@read`, `--tree`) est précédé d'une gouttière `N │ ` : numéro réel de la ligne dans le fichier (une plage `@read f 10-20` affiche 10 à 20 ; `--line-numbers` donne le même rendu), aligné à droite, dim, dans le bloc à fond. En `--tree`, le fond et la gouttière commencent à la colonne du nom de fichier ; le préfixe de l'arbre (`│   `) est repris, sans fond, devant chaque ligne visuelle. Les fichiers omis (`[omis : …]`) n'ont ni gouttière ni fond. La sortie sans couleur est inchangée.

**Repli.** Quand la sortie colorée va vers un **terminal** dont la largeur est connue, les lignes plus larges que le terminal sont repliées dans le bloc : chaque ligne visuelle a son fond (jusqu'au bord droit), le numéro n'apparaît que sur la première (les suivantes ont une gouttière vide `  │ `), les lignes `@grep` et les diffs `+`/`-` de `@edit` continuent avec une indentation (4 et 2 colonnes). La largeur utile est `largeur du terminal − gouttière − préfixe − 1` (au moins 20 colonnes de texte). Une colonne = un point de code (caractères larges et combinants non gérés). **Le repli est propre à la destination terminal** : la sortie écrite dans un fichier (`--output`) ou le presse-papiers (`--clip`) n'a pas de largeur et n'est jamais repliée ; elle n'empêche pas le repli à l'écran (`--colored --clip` replie le terminal et copie des lignes entières). Aucun repli non plus si stdout n'est pas un terminal. Redimensionner le terminal après coup ne reflue pas ce qui est déjà affiché : relancer la commande, ou `fls last`.

**`fls last`.** Chaque lecture rapide, lecture `--tree` ou exécution de script (`--dry-run` compris) mémorise sa sortie **non colorée** dans `<cache>/last.json`, où `<cache>` est `$XDG_CACHE_HOME/fls` ou `~/.cache/fls` (la nouvelle sortie remplace la précédente). `fls last` relit cette copie et passe par le même rendu que la commande d'origine, avec la couleur et la largeur d'**aujourd'hui** : rien n'est relu sur le disque du projet ni réexécuté (un `@create` déjà joué n'est pas rejoué). `last`, `help`, `spec`, `log`, `undo`, `init`, `expand`, `--version`, l'usage et les erreurs ne mémorisent rien. L'écriture du cache est un confort : son échec ne fait jamais échouer la commande. La copie contient le texte des fichiers lus : ne pas partager le dossier de cache.

## 9. Journal, `log`, `undo`

Un run n'est journalisé que s'il a produit au moins un changement effectif. Contenu de `.fls/runs/<id>/` :

| Fichier | Contenu |
|---|---|
| `meta.json` | `id`, `date`, `undone`, `dirs` (dossiers créés par `@mkdir`, absent avant 1.3.0), et pour chaque fichier touché : `path`, `backup` (nom du fichier de sauvegarde ou `null` s'il n'existait pas), `mode`, `after` (empreinte SHA-1 du contenu écrit, `null` si supprimé) |
| `script.fls` | script plat canonique |
| `report.txt` | rapport complet |
| `backup/<n>` | contenu d'origine de chaque fichier existant avant le run |

`undo` :

1. choisit `--run <id>` ou, à défaut, le **plus récent run non annulé** (`nothing_to_undo` s'il n'y en a pas) ;
2. refuse un run déjà annulé (`already_undone`) ou inconnu (`run_not_found`, l'identifiant doit correspondre à `[\w-]+`) ;
3. vérifie, pour chaque fichier, que le contenu actuel correspond à `after` ; sinon `conflict` (liste des fichiers) et **rien n'est restauré**, sauf avec `--force` ;
4. restaure les contenus et permissions d'origine, supprime les fichiers que le run avait créés, marque le run `undone`.

5. retire les dossiers de `dirs`, du plus profond au plus haut, s'ils sont vides ; un dossier devenu non vide est conservé et signalé (`conservé : il n'est pas vide`).

Un run qui ne fait que créer des dossiers est un run (`Modifiés : d/`).

## 10. Codes d'erreur et de sortie

**Codes de sortie** : `0` tout est `OK` ; `1` au moins un `FAIL`, ou erreur de commande (`undo`, `log`, fichier de script absent, presse-papiers…) ; `2` erreur de syntaxe ou d'usage (**rien n'a été exécuté**).

| Code | Sens |
|---|---|
| `syntax_error` | script mal formé, y compris une construction v2 ou une expression invalide (exit 2) |
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
| `skipped` | écriture ignorée après un échec d'écriture ou de vérification |
| `expectation_failed` | une vérification `@expect_*` n'est pas satisfaite |
| `expansion_error` | syntaxe v2 : l'expansion a échoué (exit 2, rien n'est exécuté) |
| `run_not_found` / `already_undone` / `nothing_to_undo` / `conflict` | journal et `undo` |
| `no_last_output` | `fls last` : aucune sortie mémorisée |
| `clipboard_unavailable` | aucun outil de presse-papiers |
| `ast_grep_unavailable` | binaire `ast-grep` absent (commande d'installation dans le message) |
| `ast_grep_version` | version d'`ast-grep` < 0.51.0 ou illisible |
| `ast_grep_failed` | motif refusé, sortie JSON illisible, offsets invalides ou chevauchement |
| `ast_grep_lang_required` | dossier ou extension inconnue sans `--lang` |
| `ast_grep_stale` | fichier déjà modifié dans ce script : la lecture disque d'ast-grep serait périmée |

## 11. Presse-papiers

Premier outil qui réussit, dans l'ordre : `wl-paste` / `wl-copy`, `xclip -selection clipboard`, `xsel --clipboard`, `pbpaste` / `pbcopy`, `powershell.exe Get-Clipboard` / `clip.exe` (WSL). Aucun : `clipboard_unavailable`. Les écritures redirigent la sortie standard et d'erreur de l'outil vers rien, pour ne pas bloquer sur les outils qui restent en arrière-plan (`wl-copy`, `xclip`).

## 12. ast-grep (directives structurelles, depuis 1.5.0)

`@find_ast` et `@edit_ast` s'appuient sur le binaire **`ast-grep`** (jamais `sg`, qui est shadow-utils sur Linux). Il est **optionnel** : le reste de fls fonctionne sans lui.

- **Résolution** : `FLS_AST_GREP` (chemin explicite), puis `node_modules/.bin/ast-grep` du projet, puis `ast-grep` du `PATH`. La version est vérifiée une fois par directive ; minimum **0.51.0**.
- **Installation** : `npm i -g @ast-grep/cli`, `cargo install ast-grep --locked`, `brew install ast-grep`, ou un binaire des releases GitHub.
- **Appel** : `ast-grep run --pattern <motif> [--lang <langage>] --json=stream --color never [--rewrite <texte>] -- <chemin>`. `--json=stream` évite de charger tous les matches en mémoire ; `--update-all` n'est **jamais** utilisé. Un code de sortie `1` signifie « aucun match », pas une erreur.
- **Calcul et écriture séparés** : ast-grep fournit `text`, `range.byteOffset` (octets UTF-8) et `replacement` ; fls valide chaque fichier (confinement, lien, ignore, UTF-8, taille), vérifie que les octets correspondent au match, détecte les chevauchements, puis écrit via le `Workspace`. Le dry-run, le journal et `undo` restent donc valables.
- **Langage** : un fichier unique déduit son langage de son extension ; un dossier exige `--lang`. `--lang auto` laisse ast-grep déduire par fichier (et active les injections HTML JS/CSS) ; `.html`/`.htm` sans `--lang` utilise déjà ce mode.
- **État lu** : ast-grep lit le disque au début du run. Un fichier modifié plus tôt dans le script donne `ast_grep_stale` s'il est renvoyé ; c'est volontaire (pas de résultat ni d'écriture sur une base périmée).
- **Non exposé en 1.5** : `--rule` / `sgconfig.yml`, `scan`, les transformations YAML et les règles de projet. Seuls les motifs `run --pattern` sont disponibles.

## 13. Limites connues

- Pas de repli sur les espaces de fin de ligne : la correspondance de SEARCH est exacte (aux fins de ligne CRLF/LF près).
- `@delete`, `@move` et `@copy` ne gèrent pas les dossiers ; pas de globs ni de `--all`.
- `undo` ne supprime que les dossiers créés par `@mkdir` et restés vides ; il ne protège que les fichiers touchés par le run.
- Un chemin dont un parent est un fichier est traité comme absent en lecture et refusé en écriture (`not_a_directory`).
- Pas de Windows natif (chemins POSIX uniquement).
- Pas de `--rule` ni de `sgconfig.yml` pour ast-grep : seuls les motifs `--pattern` sont exposés en 1.5.
- Les directives AST lisent le disque au début du run : ne pas les mélanger avec des écritures sur les mêmes fichiers dans un même script (`ast_grep_stale`).

## 14. Architecture et tests

- **Entrées/sorties injectées** (`Io` : dossier courant, entrée standard, sorties, presse-papiers, horloge, identifiant) ; `main(argv, io)` renvoie le code de sortie. Le vrai `Io` n'est construit qu'au chargement du module, et le démarrage passe par `bootstrap(isEntry(...), start)`, entièrement testable.
- **Tables** plutôt que chaînes de `if` : directives (`DIRECTIVES`, utilisées par le parseur, l'aide et la spec), sous-commandes, options globales, lecteurs/écrivains de blocs, vérifications d'écriture, outils de presse-papiers.
- **Modules** : `src/fls.ts` (parseur, exécution, aide, CLI), `src/journal.ts` (le Journal : format de `.fls/runs/<id>/`, enregistrement, liste, relecture, annulation avec détection des conflits ; il renvoie des données, `fls.ts` construit les rapports de `log` et `undo`), `src/tree.ts` (lecture d'un arbre en **structure** `TreeNode` — dossiers, fichiers avec leurs lignes, liens — et sortie brute façon treecat produites par un seul parcours : `walkTree`, `treeText`) et `src/report/tree-styled.ts` (rendu stylé d'un `--tree`, qui parcourt la structure), `src/output.ts` (livraison d'une sortie à ses **destinations** : terminal, fichier de `--output`, presse-papiers ; chacune porte sa couleur, sa largeur et sa limite, et le Rapport n'est rendu qu'une fois par jeu d'options), `src/last.ts` (Dernière sortie), `src/args.ts`, `src/version.ts`, `src/style.ts` (le texte stylé comme donnée : spans, lignes, couleurs dégradées, palette, repli), `src/ansi.ts` (le seul sérialiseur ANSI, avec la limite de `--max-output-chars`), `src/highlight.ts` (coloration syntaxique Shiki, renvoie des spans), `src/report/` (le Rapport comme donnée : `segments.ts` types `Segment` / `Entry` / `ReportDoc`, `plain.ts` rendu brut, `styled.ts` rendu stylé en lignes stylées, `code-block.ts` gouttière et repli, `snapshot.ts` copie versionnée de la Dernière sortie), `src/script.ts` (parseur et sérialiseur du script plat), `src/expand/` (la syntaxe v2 : `values.ts`, `expr.ts` expressions, `builtins.ts` fonctions intégrées, `template.ts` interpolation, `expand.ts` l'expansion en Script plat), `src/directive/<nom>.ts` (une `Spec` par directive ; `expect.ts` en regroupe trois, `ast.ts` porte la résolution d'`ast-grep`, le parsing JSON et l'application des offsets, assemblés par `src/directive/index.ts`), et les modules de base `types.ts`, `errors.ts`, `text.ts`, `paths.ts`, `workspace.ts`.
- **`Workspace`** : surcouche en mémoire au-dessus du disque ; le dry-run et l'exécution réelle partagent tout le code, seul `apply` (commit) diffère.
- **Dépendance externe optionnelle** : seules les directives AST appellent un processus (`ast-grep`) ; le reste de fls tient dans un binaire unique (Shiki inclus). Le `Runner` est injecté pour les tests, comme les autres E/S.
- **Syntaxe TypeScript effaçable uniquement** (ni `enum` ni propriétés de paramètre) : `node src/fls.ts` suffit.

Lancer les tests (à la racine du projet) :

```
pnpm add -D vitest @vitest/coverage-v8
pnpm run test:coverage
```

La suite utilise de vrais dossiers temporaires, des liens symboliques réels, de vrais sous-processus pour le presse-papiers, le binaire et la parité `treecat`, et exige 100 % de couverture sur statements, branches, fonctions et lignes pour tous les modules de `src/`.
