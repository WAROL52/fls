# Guide d'utilisation de fls

`fls` lit et modifie des fichiers en une seule commande, sans interaction. Il est pensé pour la boucle de travail avec un modèle de langage : on récupère le contexte du projet, le modèle répond par **un script**, `fls` l'exécute et produit un **rapport** à recoller au modèle.

Ce guide montre l'usage courant. La référence complète est dans [`SPEC.md`](../SPEC.md), le « pourquoi » dans [`PRD.md`](../PRD.md), le vocabulaire dans [`GLOSSARY.md`](../GLOSSARY.md). En cas de doute, le code et les tests font foi ; `fls spec` affiche la référence de la syntaxe, prête à coller dans un prompt.

## Installation

Prérequis : Node.js ≥ 22 pour lancer `node src/fls.ts`, ou [bun](https://bun.sh) pour compiler le binaire.

```bash
pnpm install
pnpm run build:install   # compile dist/fls puis l'installe dans ~/.local/share/fls
fls --version
```

`bin/install-fls.sh` crée le wrapper `~/.local/bin/fls` et ajoute `~/.local/bin` au `PATH` dans `~/.bashrc` s'il n'y est pas. `pnpm run uninstall:global` le retire.

## La boucle de travail

1. **Donner le contexte au modèle** : `fls src/ --clip` copie l'arbre et le contenu des fichiers dans le presse-papiers.
2. **Coller le résultat au modèle**, qui répond par un script de directives.
3. **Copier le script** de la réponse, puis lancer `fls --clip`. Il lit le presse-papiers, exécute le script et y recopie le rapport.
4. **Coller le rapport** au modèle (lectures, diffs, erreurs), et recommencer si besoin.

Si le résultat ne convient pas, `fls undo` annule le dernier run.

## Lecture rapide

```bash
fls src/ lib/a.ts            # arbre filtré, puis contenu de chaque fichier
fls src/ --clip              # idem, rapport copié dans le presse-papiers
fls --paths-from liste.txt   # chemins listés un par ligne
fls --tree src               # sortie brute façon treecat, sans aucun ignore
```

- Les dossiers sont filtrés : `.git/`, `node_modules/`, `.fls/`, plus `.gitignore`, `.flsignore` et `--ignore <motif>`. Un chemin explicite n'est jamais filtré.
- Les fichiers binaires, trop gros (`--max-size`) ou non UTF-8 sont signalés `[omis : <code>]` sans interrompre la lecture.
- `fls init` crée un `.flsignore` modèle et ajoute `.fls/` au `.gitignore`.
- `--tree` n'applique aucun ignore et n'ajoute pas de rapport fls ; il n'a pas de limite de taille par défaut.

## Scripts

Un script est une suite de directives, une par ligne, exécutées dans l'ordre. Trois façons de le fournir :

```bash
fls <<'FLS'
@read src/user.ts 1-30
@grep "export const authRoles" . --context 5
FLS

fls --file script.fls
fls --clip
```

| Directive | Rôle |
|---|---|
| `@tree [dossier] [--depth N] [--dirs-only]` | arborescence |
| `@read <chemin> [A-B] [--line-numbers] [--tree]` | lit un fichier, une plage de lignes ou un dossier |
| `@grep "<texte>" [chemin] [--context N] [--regex] [--ignore-case]` | recherche |
| `@stat <chemin>` | type, taille, lignes, droits et sha1 (pas de date) |
| `@history [chemin] [--limit N]` | runs du Journal, ou ceux qui ont touché un fichier |
| `@note "<texte>"` | recopie un texte dans le rapport |
| `@expect_exists <chemin>` / `@expect_missing <chemin>` | vérifie qu'un chemin existe / n'existe pas |
| `@expect_contains <fichier> "<texte>" [--regex] [--count N]` | vérifie qu'un fichier contient un texte (au moins une fois, ou exactement N) |
| `@edit <fichier>` + blocs `SEARCH` / `REPLACE` | remplace du texte exact (une seule occurrence) |
| `@create` / `@overwrite` / `@write` / `@append <fichier>` + bloc `CONTENT` | écrit un fichier entier |
| `@mkdir <dossier>` | crée un dossier (parents compris, même vide ; sans effet s'il existe) |
| `@copy <source> <destination>` | copie un fichier (droits conservés ; échoue si la destination existe) |
| `@delete <fichier>` / `@move <source> <destination>` | supprime ou déplace un fichier |

Exemple de modification :

```
@edit src/roles.ts
<<<<<<< SEARCH
export const ADMIN = "admin";
=======
export const ADMIN = "administrator";
>>>>>>> REPLACE

@create src/notes.md
<<<<<<< CONTENT
# Notes
>>>>>>> END
```

Règles à retenir :

- Les blocs sont **littéraux** : aucune interprétation du contenu (même sous `@fls 2`, sauf un bloc `TEMPLATE` explicite).
- `SEARCH` doit être trouvé **exactement une fois**, avec les espaces et l'indentation exacts, sinon `not_found` ou `ambiguous_match`.
- Les erreurs de syntaxe sont détectées **avant toute exécution** : rien n'est exécuté (code de sortie 2).
- Après l'échec d'une écriture **ou d'une vérification** (`@expect_*`), les écritures suivantes sont `SKIP` ; les lectures continuent.
- Un `@read` ou un `@tree` après une écriture voit le résultat (état simulé en mémoire).

### Vérifier avant d'écrire

Les vérifications constatent un fait sur l'état simulé. Si l'une échoue, elle est un `FAIL` (code `expectation_failed`, avec le constat : `attendu : 1 occurrence(s) ; trouvé : 2 (lignes 12, 40)`) et les écritures suivantes sont ignorées. Ce qui a déjà été écrit **n'est pas annulé** : `fls undo` revient en arrière.

```
@expect_exists src/user.ts
@expect_contains src/user.ts "return { id, name }" --count 1
@edit src/user.ts
<<<<<<< SEARCH
  return { id, name }
=======
  return { id, name, role: "member" }
>>>>>>> REPLACE
@expect_contains src/user.ts "role:" --count 1
```

Les placer **avant** les écritures pour qu'elles servent de garde-fou ; après, elles contrôlent le résultat (un `@expect_contains` voit le fichier tel que l'`@edit` précédent l'a simulé). `--count N` compte toutes les occurrences, même plusieurs sur une ligne ; un texte sur plusieurs lignes ne se cherche qu'avec `--regex`.

### Forme collable `#@` et zone clip

Pour un script de lecture que l'on peut coller tel quel dans un terminal, chaque directive de lecture peut s'écrire `#@nom …`. Pour un shell, c'est un commentaire ; pour fls, c'est la même directive. Les marqueurs `clip start` et `clip end` délimitent la partie lue, ce qui permet d'inclure la ligne de commande dans le bloc copié :

```
##### clip start #####
#@note "hook session et rôles"
#@read apps/web/src/hooks/use-get-user-session.ts
#@grep "export type RoleName" . --context 5
##### clip end #####
cd ~/DEV/HIVELAB && fls --clip
```

On copie tout le bloc, on le colle dans le terminal (les `#…` sont ignorés, `cd … && fls --clip` s'exécute), et fls relit le presse-papiers. Limites :

- `#@` accepte toute directive qui n'écrit pas (`tree`, `read`, `grep`, `stat`, `history`, `note`, `expect_*`). Les directives d'écriture (`edit`, `create`, `mkdir`, `copy`, `delete`…) exigent `@` (`syntax_error` sinon).
- `#@` collé à une lettre doit être une directive connue. `#@ texte` et `# @read` restent des commentaires.
- Sans `clip start`, tout le script est lu et la ligne `cd …` donne une erreur de syntaxe.

Voir [`adr/0001-forme-hash-arobase-et-zone-clip.md`](adr/0001-forme-hash-arobase-et-zone-clip.md).

## Répéter et paramétrer : la syntaxe v2 (`@fls 2`)

Quand le même travail se répète (une modification sur vingt fichiers, trois composants bâtis sur le même modèle, une étape conditionnelle), un script peut commencer par `@fls 2`. C'est un **Script source** : fls l'**étend** en un script plat ordinaire **avant** de l'exécuter. Le rapport, `--dry-run`, le Journal et `undo` ne changent donc pas, et `fls expand` montre exactement ce qui va s'exécuter. Sans `@fls 2`, un script se lit comme avant (`{{` reste du texte).

```
@fls 2
@let ext = ".tsx"

@def composant(nom)
@create src/components/{{ nom }}{{ ext }}
<<<<<<< TEMPLATE
export const {{ nom }} = () => <div className="{{ lower(nom) }}" style=\{{ margin: 0 }} />
>>>>>>> END
@end

@for nom in ["Button", "Card", "Modal"]
@call composant(nom)
@end

@for f in glob("src/**/*.ts")
@if exists(f + ".bak")
@note "{{ f }} a une sauvegarde"
@end
@end
```

### Les constructions

| Ligne | Effet |
|---|---|
| `@let nom = expression` | affecte une variable |
| `@for nom in expression` … `@end` | parcourt une liste (ou les clés d'un dictionnaire) |
| `@if expression` … `@elif …` … `@else` … `@end` | condition |
| `@def nom(a, b)` … `@end` | définit une macro (au premier niveau du script) |
| `@call nom(x, y)` | émet les directives de la macro avec ses paramètres |

L'indentation n'a aucun sens, `@end` ferme la construction ouverte la plus proche, et ces lignes n'apparaissent pas dans le rapport : seules les directives émises y figurent (une boucle sur 30 fichiers donne 30 entrées).

Une macro voit ses paramètres et les variables globales ; ses propres `@let` ne fuient pas. Elle ne peut appeler que des macros **définies plus haut** : pas de récursion.

### Interpolation et blocs

- `{{ expression }}` s'écrit dans les arguments et les valeurs d'option des directives (pas dans les lignes de contrôle, qui sont déjà des expressions : `@if exists(f + ".bak")`, pas `exists("{{ f }}.bak")`) : `@read {{ f }} --lines 1-{{ n }}`. Ses espaces ne coupent pas le mot. La valeur doit être un texte ou un entier. Un mot interpolé n'est jamais lu comme une option. `\{{` donne un `{{` littéral.
- Les blocs `SEARCH` / `REPLACE` / `CONTENT` restent **littéraux** : on peut y coller un composant Vue, Handlebars ou `style={{ … }}` tel quel, et même une ligne `@for`.
- Pour interpoler un bloc, on le **déclare** : `<<<<<<< TEMPLATE` à la place de `<<<<<<< CONTENT` (`@create`, `@overwrite`, `@write`, `@append`), ou `<<<<<<< SEARCH TEMPLATE` à la place de `<<<<<<< SEARCH` (`@edit` : le SEARCH et le REPLACE de ce bloc sont interpolés ; un `@edit` peut mêler blocs littéraux et `TEMPLATE`). Dans un bloc `TEMPLATE`, écrire `\{{` pour un `{{` littéral.

### Expressions et fonctions intégrées

Textes (`"…"` ou `'…'`), entiers, `True` / `False`, listes `[…]`, dictionnaires `{"a": 1}`, `+ - * // %`, `== != < <= > >=`, `and or not`, `in`, `x[i]`, `a if c else b`. Pas de flottants, de méthodes (`upper(x)`, pas `x.upper()`), de lambda ni de compréhension : la boucle est `@for`.

Fonctions intégrées, toutes en **lecture seule** (mêmes limites que `@read` : dossier courant, pas de lien suivi, pas de binaire) : `glob`, `exists`, `is_file`, `is_dir`, `read`, `lines`, `len`, `range`, `sorted`, `join`, `split`, `replace`, `upper`, `lower`, `capitalize`, `strip`, `startswith`, `endswith`, `basename`, `dirname`, `stem`, `int`, `str`. `fls spec` en donne les signatures. Il n'y a ni shell, ni réseau, ni date, ni aléatoire : deux expansions du même script sur le même disque donnent le même résultat.

### À savoir

- **L'expansion lit le disque tel qu'il est au départ**, jamais l'état simulé : un `@if exists("x")` placé après un `@create x` du même script ne voit pas ce fichier. Pour constater après coup, utiliser `@expect_*`.
- **Vérifier avant d'exécuter** : `fls expand` affiche le script plat, `fls --dry-run` le simule.
- **Variables de la ligne de commande** : `fls --file script.fls --set nom=Ada --set env=prod` (toujours des textes ; `int()` convertit).
- **Plafonds** : 2000 directives émises (`--max-expanded N` pour changer), 200 000 étapes, textes d'un million de caractères, listes de 10 000 éléments.
- **Erreurs** : une construction mal formée (`syntax_error`) ou une erreur à l'évaluation (`expansion_error` : variable inconnue, division par zéro, type invalide, lecture impossible…) indique la ligne du script source et, dans une macro, la chaîne d'appels. Code de sortie 2, **rien n'est exécuté**.
- **Forme `#@`** : les lignes de contrôle y sont permises (`#@fls 2`, `#@for`, `#@let`…), mais pas les écritures, même émises par une macro appelée avec `#@call`.

Voir [`adr/0008-la-couche-de-programmation-est-une-expansion.md`](adr/0008-la-couche-de-programmation-est-une-expansion.md) pour le pourquoi, et `SPEC.md` §4.6 pour la référence.

## Réafficher la dernière sortie : `fls last`

```bash
fls src --tree     # affiche, puis vous redimensionnez le terminal : l'affichage est décalé
fls last           # réaffiche la même sortie, à la largeur actuelle, sans rien réexécuter
```

Chaque lecture, lecture `--tree` ou script mémorise sa sortie (non colorée) dans `~/.cache/fls/last.json` (`$XDG_CACHE_HOME/fls` si défini). `fls last` la recolore et la replie à la largeur courante du terminal ; rien n'est relu ni réexécuté, donc un script d'écriture déjà joué n'est pas rejoué. Les options `--colored`, `--no-color`, `--output` et `--clip` fonctionnent aussi. S'il n'y a rien de mémorisé : `no_last_output`.

## Simuler, annuler, retrouver

```bash
fls --dry-run --file script.fls   # simule : aucune écriture, aucun journal ; le rapport dit « Modifierait »
fls expand                         # affiche le script plat canonique, sans l'exécuter
fls log                            # liste les runs
fls log --run <id>                 # script plat et rapport d'un run
# dans un script : @history [chemin] [--limit N] liste les runs, ou ceux qui ont touché un fichier
fls undo                           # annule le dernier run non annulé
fls undo --run <id>                # annule un run précis
fls undo --force                   # restaure même si les fichiers ont changé depuis
```

Un run n'est journalisé (dans `.fls/runs/<id>/`) que s'il a produit au moins un changement effectif (un fichier modifié, ou un dossier créé par `@mkdir`). `undo` retire les dossiers créés s'ils sont restés vides, et laisse (en le disant) ceux où l'on a ajouté des fichiers depuis. Le Journal (`src/journal.ts`) possède ce format ; `undo` refuse de restaurer si un fichier a été modifié depuis le run (`conflict`), sauf avec `--force`.

## Le rapport

Une entrée numérotée par directive (`OK`, `FAIL` ou `SKIP`), un résumé, la liste des fichiers modifiés, puis `Annulable avec : fls undo`. Les modifications apparaissent sous forme de diff (`- ` retiré, `+ ` ajouté).

Codes de sortie : `0` tout est `OK` ; `1` au moins un `FAIL` ou une erreur de commande ; `2` erreur de syntaxe ou d'usage (rien n'a été exécuté). Les codes d'erreur (`not_found`, `ambiguous_match`, `outside_workspace`…) sont listés dans `fls spec`.

## Couleur

| Option | Effet |
|---|---|
| `--color auto` (défaut) | colore sur un terminal ; `NO_COLOR` désactive |
| `--colored` / `--color always` | force la couleur, même vers un fichier ou le presse-papiers |
| `--no-color` / `--color never` | désactive |

Les couleurs sont celles du thème **opencode** (sombre) : code sur un fond `#141414`, mots-clés mauves, fonctions pêche, chaînes vertes, nombres orange, types jaunes, opérateurs cyan, numéros de ligne gris. Le fond n'est appliqué qu'aux contenus de fichier (lignes lues, résultats de `@grep`, lignes `+` / `-` d'un diff). Les tabulations sont développées en espaces (taquets de 8) en mode coloré pour que le fond couvre l'indentation. `expand` reste toujours brut.

Pour accorder le fond au thème de votre terminal, définissez `FLS_BG` avec une couleur `#rrggbb` (par exemple dans `~/.bashrc` : `export FLS_BG='#1e2127'`). Une valeur invalide est refusée (`usage_error`).

En sortie colorée, chaque ligne de fichier est précédée de son **numéro** (`12 │ code`). Sur un terminal, les lignes trop longues sont **repliées dans le bloc** (le numéro n'apparaît que sur la première ligne visuelle, les suivantes ont une gouttière vide) : plus de confusion entre une ligne repliée et une nouvelle ligne. Redimensionner le terminal ne reflue pas l'affichage déjà produit : relancez la commande ou tapez `fls last`. Le repli ne concerne que le terminal : la sortie écrite dans un fichier (`--output`) ou le presse-papiers (`--clip`) n'est jamais repliée, et ne l'empêche pas à l'écran. Pas de repli non plus si la sortie n'est pas un terminal.

## Options utiles

| Option | Rôle |
|---|---|
| `--output <chemin>` | écrit le rapport dans un fichier |
| `--clip`, `--clip-in`, `--clip-out` | presse-papiers dans les deux sens, ou un seul |
| `--max-size <octets>` | taille maximale d'un fichier lu ou modifié (défaut 1 048 576) |
| `--max-output-chars <n>` | taille maximale du rapport (défaut 200 000, sauf lecture brute `--tree`) |
| `--ignore <motif>` | motif d'ignore supplémentaire, répétable |
| `--set <nom=valeur>` | (script `@fls 2`) variable de texte, répétable |
| `--max-expanded <n>` | (script `@fls 2`) plafond de directives émises (défaut 2000) |

Les options sont en forme longue, valeur séparée par un espace (`--max-size 100`).

## Sécurité

- Les chemins absolus, `..` et les liens symboliques sortants sont refusés (`outside_workspace`) : fls ne touche rien hors du dossier courant.
- Les liens symboliques ne sont jamais suivis ni modifiés.
- Chaque fichier est écrit via un fichier temporaire puis renommé, avec ses permissions, fins de ligne et BOM d'origine.
- Aucune exécution de commande : la syntaxe v2 n'a ni shell, ni réseau, ni date, ni aléatoire ; ses fonctions ne font que lire le dossier courant, avec les mêmes limites que `@read`, et sont bornées (étapes, tailles, directives émises). Le script plat qu'elle produit est ce que `fls expand` affiche.

## Presse-papiers

Premier outil disponible, dans l'ordre : `wl-paste` / `wl-copy`, `xclip`, `xsel`, `pbpaste` / `pbcopy`, `powershell.exe` / `clip.exe` (WSL). Aucun : `clipboard_unavailable`.
