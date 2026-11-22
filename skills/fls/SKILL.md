---
name: fls
description: Apprendre à utiliser fls (CLI qui lit et modifie des fichiers en une seule commande, sans interaction) et à l'installer. À utiliser dès que l'utilisateur mentionne fls, un script @read / @edit / @grep / @note / @create / @write, la syntaxe collable `#@` avec `fls --clip`, `fls undo`, `fls last`, ou veut lire/modifier plusieurs fichiers d'un coup, annuler un run, installer ou mettre à jour fls, même s'il ne dit pas « fls » explicitement.
---

# fls

`fls` exécute un **script** de directives (`@read`, `@edit`, …) en une commande et rend un **rapport** numéroté. Il sert à lire ou modifier plusieurs fichiers d'un coup, sans interaction, avec un journal pour tout annuler. La référence complète vit dans l'outil lui-même : lance `fls spec` (syntaxe) ou `fls help <directive>` plutôt que de te fier à ta mémoire, elle suit la version installée.

## Installer

Prérequis : `bun` (compilation) et `git`. Node ≥ 22 et pnpm pour le développement.

```bash
git clone https://github.com/WAROL52/fls.git && cd fls
pnpm install
pnpm run build:install     # compile avec bun, installe ~/.local/share/fls/fls + wrapper ~/.local/bin/fls
fls --version
```

Le script ajoute `~/.local/bin` au PATH dans `~/.bashrc` : ouvrir un nouveau terminal si `fls` est introuvable. Après toute modification de `src/`, relancer `pnpm run build:install`, sinon le binaire installé reste l'ancien. Désinstaller : `pnpm run uninstall:global`. Presse-papiers (`--clip`) : nécessite `wl-clipboard`, `xclip`/`xsel` (Linux) ou `pbcopy` (macOS) ; sinon erreur `clipboard_unavailable`.

## Les trois façons de lancer un script

```bash
fls src/user.ts src/types              # lecture rapide : arbre puis contenus
fls <<'FLS'                            # script sur l'entrée standard
@read src/user.ts --lines 1-30 --line-numbers
@grep "getUser" src --context 2
FLS
fls --clip                             # script lu dans le presse-papiers, rapport copié
```

Forme collable (le `#@` rend le bloc inoffensif s'il est collé dans un shell) :

```
##### clip start #####
#@note "hook session"
#@read apps/web/src/hooks/use-session.ts
#@grep "export const authRoles" . --context 40
##### clip end #####
cd ~/projet && fls --clip
```

## Bonnes pratiques

- **Grouper** : un seul script pour plusieurs lectures/modifications, avec des `@note` pour annoter les étapes ; le rapport garde l'ordre.
- **`@edit` d'abord en `--dry-run`** quand le changement est risqué : `fls --dry-run` simule sans écrire. Chaque SEARCH doit être trouvé **exactement une fois** (`ambiguous_match` donne les numéros de ligne : allonger le contexte du SEARCH). Chaque `@edit` est atomique.
- **Garder avant d'écrire** : `@expect_exists`, `@expect_missing`, `@expect_contains <fichier> "texte" [--regex] [--count N]` constatent un fait sur l'état simulé. Si l'une échoue (`expectation_failed`), les écritures suivantes sont SKIP, les lectures continuent ; ce qui a déjà été écrit n'est pas annulé (`fls undo`). Les placer avant les `@edit` ; après, elles servent à contrôler le résultat. Un texte sur plusieurs lignes ne se cherche qu'avec `--regex`.
- **Inspecter** : `@stat <chemin>` (type, taille, lignes, droits, sha1) et `@history [chemin] [--limit N]` (runs du Journal, ou ceux qui ont touché un fichier) sont des lectures, utilisables aussi en `#@`.
- **Structure** : `@mkdir <dossier>` (parents compris, idempotent, annulable s'il reste vide) et `@copy <source> <destination>` (fichiers, droits conservés).
- **Relire après écriture** : les directives voient l'état simulé, donc un `@read` placé après un `@edit` montre le résultat dans le même run.
- **Après un FAIL d'écriture**, les écritures suivantes sont SKIP mais les lectures continuent : lire le rapport en entier avant de relancer.
- **Annuler** : `fls log` liste les runs, `fls undo` annule le dernier (`--run <id>` pour un précis, `--force` si des fichiers ont changé depuis, sinon `conflict`). Le journal est dans `.fls/` (`fls init` crée `.flsignore` et l'ajoute au `.gitignore`).
- **Sortie** : `fls last` réaffiche la dernière sortie à la largeur du terminal sans rien réexécuter ; `--colored` / `--no-color` forcent la couleur ; `--output f` écrit le rapport dans un fichier ; `--max-output-chars n` borne la taille.
- **Limites de sécurité** : chemins relatifs au dossier courant uniquement (absolus, `..` et liens sortants refusés), fichiers binaires et > `--max-size` refusés.

## Codes de sortie

0 tout OK · 1 au moins un FAIL · 2 erreur de syntaxe ou d'usage (rien exécuté).

## Quand l'utilisateur apprend fls

Partir de son besoin réel, proposer d'abord la lecture rapide, puis un petit script `@read` + `@grep`, puis un `@edit` en `--dry-run`, puis `fls undo`. Montrer chaque commande avec son rapport attendu plutôt que d'expliquer la grammaire en entier.
