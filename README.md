# fls

Lire et modifier des fichiers en **une seule commande**, sans interaction. On écrit un petit script de directives (`@read`, `@grep`, `@edit`, …), `fls` l'exécute et rend un rapport numéroté (OK / FAIL / SKIP). Tout run est journalisé et annulable.

## Installation

Prérequis : [bun](https://bun.sh) (compilation du binaire), [pnpm](https://pnpm.io), Node ≥ 22.

```bash
git clone https://github.com/WAROL52/fls.git
cd fls
pnpm install
pnpm run build:install
fls --version
```

`build:install` compile le binaire dans `~/.local/share/fls/fls`, crée le wrapper `~/.local/bin/fls` et ajoute `~/.local/bin` au PATH (`~/.bashrc`) : ouvrez un nouveau terminal si besoin. Après une modification de `src/`, relancez la commande. Désinstaller : `pnpm run uninstall:global`.

`--clip` demande un outil de presse-papiers : `wl-clipboard`, `xclip`/`xsel` (Linux) ou `pbcopy` (macOS).

Les directives structurelles `@find_ast` / `@edit_ast` demandent en plus [`ast-grep`](https://ast-grep.github.io/) ≥ 0.51 (`npm i -g @ast-grep/cli`, `cargo install ast-grep --locked` ou `brew install ast-grep`). Le reste de `fls` fonctionne sans lui.

## Utilisation

```bash
fls src/user.ts src/types          # lecture rapide : arbre puis contenus
fls --tree src                     # arbre brut façon treecat
fls <<'FLS'                        # script sur l'entrée standard
@note "ajout du rôle"
@edit src/user.ts
<<<<<<< SEARCH
  return { id, name }
=======
  return { id, name, role: "member" }
>>>>>>> REPLACE
@read src/user.ts --line-numbers
FLS
```

### Coller depuis un chat : `fls --clip`

Le préfixe `#@` rend le bloc inoffensif dans un shell, et `fls --clip` lit le presse-papiers puis y copie le rapport :

```
##### clip start #####
#@note "hook session et rôles"
#@read apps/web/src/hooks/use-get-user-session.ts
#@grep "export const authRoles" . --context 40
##### clip end #####
cd ~/DEV/projet && fls --clip
```

### Directives

Lecture : `@tree`, `@read`, `@grep`, `@find_ast`, `@stat`, `@history`, `@note`. Écriture : `@edit`, `@edit_ast`, `@insert`, `@create`, `@overwrite`, `@write`, `@append`, `@mkdir`, `@copy`, `@delete`, `@move`. Vérifications : `@expect_exists`, `@expect_missing`, `@expect_contains`. Détail : `fls help <directive>`, syntaxe complète : `fls spec` (et [SPEC.md](SPEC.md)).

### Recherche structurelle : `@find_ast` / `@edit_ast` (optionnel)

**Quand l’utiliser** : préfère `@grep`/`@edit` pour du texte exact. Utilise `@find_ast`/`@edit_ast` quand la **structure du code** compte (appels, arguments, JSX, imports, wrappers, signatures) et que regex/espaces/guillemets/multi-ligne rendent le texte fragile. Prérequis : `ast-grep` ≥ 0.51 installé.

```
@find_ast "console.log($ARG)" src --lang ts --context 2
@edit_ast "console.log($ARG)" src --lang ts --all --rewrite "logger.info($ARG)"
```

`$ARG` capture un nœud, `$$$ARGS` zéro ou plusieurs. `@edit_ast` est **unique par défaut** (`ambiguous_match` sinon) ; `--all` ou `--first` tranchent. Le remplacement peut être inline (`--rewrite`) ou dans un bloc `<<<<<<< REWRITE` / `>>>>>>> END`. Pour un dossier, `--lang` est obligatoire ; `--lang auto` laisse ast-grep déduire par fichier (et active les injections JS/CSS dans HTML). Les directives AST lisent le disque au début du run : ne pas les mélanger avec des écritures sur les mêmes fichiers dans un même script.

### Répéter, paramétrer : la syntaxe `@fls 2`

Un script qui commence par `@fls 2` peut avoir des variables, des boucles, des conditions et des macros. Il est **étendu avant d'être exécuté** en un script plat ordinaire (`fls expand` l'affiche), donc `--dry-run`, le Journal et `undo` ne changent pas :

```
@fls 2
@def composant(nom)
@create src/components/{{ nom }}.tsx
<<<<<<< TEMPLATE
export const {{ nom }} = () => <div className="{{ lower(nom) }}" style=\{{ margin: 0 }} />
>>>>>>> END
@end
@for nom in ["Button", "Card", "Modal"]
@call composant(nom)
@end
@for f in glob("src/**/*.ts")
@if not startswith(basename(f), "index")
@expect_contains {{ f }} "export"
@end
@end
```

Les blocs restent littéraux, sauf `TEMPLATE` (`\{{` pour un `{{` littéral). L'expansion lit le disque tel qu'il est au départ. `fls spec` liste les fonctions intégrées ; `--set nom=valeur` passe une variable. Sans `@fls 2`, un script se lit exactement comme avant.

### Vérifier avant d'écrire

Une vérification qui échoue fait ignorer les écritures suivantes (les lectures continuent) ; ce qui a déjà été écrit reste, et `fls undo` le défait :

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
@history src/user.ts --limit 3
```

### Sûreté

- `--dry-run` simule sans rien écrire ; chaque `@edit` est atomique et son SEARCH doit être unique sans `--all` (`--all` remplace toutes les occurrences) ; `@edit_ast` est unique par défaut.
- `@mkdir` crée des dossiers vides ; `undo` retire ceux qui sont restés vides.
- `fls log` liste les runs, `fls undo [--run <id>] [--force]` annule ; le journal est dans `.fls/` (`fls init` le met dans `.gitignore`).
- Chemins confinés au dossier courant ; liens symboliques, binaires et fichiers trop gros refusés.
- Codes de sortie : `0` OK, `1` au moins un FAIL, `2` erreur de syntaxe ou d'usage.

### Affichage

`--colored` / `--no-color`, `FLS_BG` (fond du code), `fls last` (réaffiche sans réexécuter, à la largeur du terminal), `--output f`, `--max-output-chars n`.

## Skill Claude Code

Le dossier [`skills/fls`](skills/fls/SKILL.md) apprend à Claude à utiliser et installer `fls`. Installation :

```bash
mkdir -p ~/.claude/skills && cp -r skills/fls ~/.claude/skills/
```

(ou `ln -s "$PWD/skills/fls" ~/.claude/skills/fls` pour suivre les mises à jour du dépôt).

## Développement

```bash
pnpm test          # unitaires, e2e, couverture à 100 %
```

Voir [docs/test/test.md](docs/test/test.md), [GLOSSARY.md](GLOSSARY.md) et les décisions dans [docs/adr](docs/adr).
