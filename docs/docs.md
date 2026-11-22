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
| `@note "<texte>"` | recopie un texte dans le rapport |
| `@edit <fichier>` + blocs `SEARCH` / `REPLACE` | remplace du texte exact (une seule occurrence) |
| `@create` / `@overwrite` / `@write` / `@append <fichier>` + bloc `CONTENT` | écrit un fichier entier |
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

- Les blocs sont **littéraux** : aucune interprétation du contenu.
- `SEARCH` doit être trouvé **exactement une fois**, avec les espaces et l'indentation exacts, sinon `not_found` ou `ambiguous_match`.
- Les erreurs de syntaxe sont détectées **avant toute exécution** : rien n'est exécuté (code de sortie 2).
- Après l'échec d'une écriture, les écritures suivantes sont `SKIP` ; les lectures continuent.
- Un `@read` ou un `@tree` après une écriture voit le résultat (état simulé en mémoire).

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

- `#@` n'accepte que `tree`, `read`, `grep` et `note`. Les directives d'écriture exigent `@` (`syntax_error` sinon).
- `#@` collé à une lettre doit être une directive connue. `#@ texte` et `# @read` restent des commentaires.
- Sans `clip start`, tout le script est lu et la ligne `cd …` donne une erreur de syntaxe.

Voir [`adr/0001-forme-hash-arobase-et-zone-clip.md`](adr/0001-forme-hash-arobase-et-zone-clip.md).

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
fls undo                           # annule le dernier run non annulé
fls undo --run <id>                # annule un run précis
fls undo --force                   # restaure même si les fichiers ont changé depuis
```

Un run n'est journalisé (dans `.fls/runs/<id>/`) que s'il a produit au moins un changement effectif. `undo` refuse de restaurer si un fichier a été modifié depuis le run (`conflict`), sauf avec `--force`.

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

Les options sont en forme longue, valeur séparée par un espace (`--max-size 100`).

## Sécurité

- Les chemins absolus, `..` et les liens symboliques sortants sont refusés (`outside_workspace`) : fls ne touche rien hors du dossier courant.
- Les liens symboliques ne sont jamais suivis ni modifiés.
- Chaque fichier est écrit via un fichier temporaire puis renommé, avec ses permissions, fins de ligne et BOM d'origine.
- Aucune syntaxe de programmation : un script est une suite plate de directives.

## Presse-papiers

Premier outil disponible, dans l'ordre : `wl-paste` / `wl-copy`, `xclip`, `xsel`, `pbpaste` / `pbcopy`, `powershell.exe` / `clip.exe` (WSL). Aucun : `clipboard_unavailable`.
