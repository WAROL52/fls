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

`@tree`, `@read`, `@grep`, `@note`, `@edit`, `@create`, `@overwrite`, `@write`, `@append`, `@delete`, `@move`. Détail : `fls help <directive>`, syntaxe complète : `fls spec` (et [SPEC.md](SPEC.md)).

### Sûreté

- `--dry-run` simule sans rien écrire ; chaque `@edit` est atomique et son SEARCH doit être unique.
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
