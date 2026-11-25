---
name: fls
description: Apprendre à utiliser fls (CLI qui lit et modifie des fichiers en une seule commande, sans interaction) et à l'installer. À utiliser dès que l'utilisateur mentionne fls, un script @read / @edit / @grep / @note / @create / @write, la syntaxe collable `#@` avec `fls --clip`, `fls undo`, `fls last`, `/fls on|off|init|status`, ou veut lire/modifier plusieurs fichiers d'un coup, annuler un run, installer ou mettre à jour fls, même s'il ne dit pas « fls » explicitement.
---

# fls

`fls` exécute un **script** de directives (`@read`, `@edit`, …) en une commande et rend un **rapport** numéroté. Il sert à lire ou modifier plusieurs fichiers d'un coup, sans interaction, avec un journal pour tout annuler. La référence complète vit dans l'outil lui-même : lance `fls spec` (syntaxe) ou `fls help <directive>` plutôt que de te fier à ta mémoire, elle suit la version installée.

## Mode `/fls`

- **`/fls on`** : active le mode fls pour la session. Tant qu'il est actif, l'agent privilégie `fls` pour les lectures/modifications par lots (grep, reads multiples, edits ciblés, vérifications) sans que l'utilisateur ait à retaper `/fls`. Confirmer l'activation en une ligne.
- **`/fls off`** : désactive le mode fls. L'agent reprend son comportement normal. Confirmer la désactivation en une ligne.
- **`/fls init`** : exécute `fls init` dans le projet courant (crée `.fls/`, `.flsignore`, ajoute `.fls` au `.gitignore` si besoin), puis confirme le résultat. N'active pas le mode sauf demande explicite.
- **`/fls status`** : indique si le mode fls est actif ou non pour la session, sans changer l'état.

En mode actif, l'agent choisit `fls` quand il apporte un gain (script groupé, rapport, guards `@expect_*`, `undo`). Pour un changement trivial isolé, l'outil natif reste acceptable.

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
- **`@edit` d'abord en `--dry-run`** quand le changement est risqué : `fls --dry-run` simule sans écrire. Chaque SEARCH doit être trouvé **exactement une fois** (`ambiguous_match` donne les numéros de ligne : allonger le contexte du SEARCH). Chaque `@edit` est atomique. Forme canonique (marqueurs `SEARCH`/`REPLACE`, pas des marqueurs de conflit git) :
  ```
  @edit chemin/fichier.ext
  <<<<<<< SEARCH
  texte exact à trouver
  =======
  texte de remplacement
  >>>>>>> REPLACE
  ```
- **Garder avant d'écrire** : `@expect_exists`, `@expect_missing`, `@expect_contains <fichier> "texte" [--regex] [--count N]` constatent un fait sur l'état simulé. Si l'une échoue (`expectation_failed`), les écritures suivantes sont SKIP, les lectures continuent ; ce qui a déjà été écrit n'est pas annulé (`fls undo`). Les placer avant les `@edit` ; après, elles servent à contrôler le résultat. Un texte sur plusieurs lignes ne se cherche qu'avec `--regex`.
- **Inspecter** : `@stat <chemin>` (type, taille, lignes, droits, sha1) et `@history [chemin] [--limit N]` (runs du Journal, ou ceux qui ont touché un fichier) sont des lectures, utilisables aussi en `#@`.
- **Structure** : `@mkdir <dossier>` (parents compris, idempotent, annulable s'il reste vide) et `@copy <source> <destination>` (fichiers, droits conservés).
- **Répéter ou paramétrer** : un script qui commence par `@fls 2` accepte variables, `@for`, `@if`, macros (`@def` / `@call`) et `{{ expr }}` dans les arguments ; il est **étendu en script plat avant d'être exécuté**, sur le disque initial. Les blocs restent littéraux sauf `<<<<<<< TEMPLATE`. Vérifier avec `fls expand` puis `--dry-run`. **Lire `references/syntaxe-v2.md` avant d'écrire ou de corriger un tel script** (motifs, fonctions, pièges).
- **Relire après écriture** : les directives voient l'état simulé, donc un `@read` placé après un `@edit` montre le résultat dans le même run.
- **Après un FAIL d'écriture**, les écritures suivantes sont SKIP mais les lectures continuent : lire le rapport en entier avant de relancer.
- **Annuler** : `fls log` liste les runs, `fls undo` annule le dernier (`--run <id>` pour un précis, `--force` si des fichiers ont changé depuis, sinon `conflict`). Le journal est dans `.fls/` (`fls init` crée `.flsignore` et l'ajoute au `.gitignore`).
- **Sortie** : `fls last` réaffiche la dernière sortie à la largeur du terminal sans rien réexécuter ; `--colored` / `--no-color` forcent la couleur ; `--output f` écrit le rapport dans un fichier ; `--max-output-chars n` borne la taille.
- **Limites de sécurité** : chemins relatifs au dossier courant uniquement (absolus, `..` et liens sortants refusés), fichiers binaires et > `--max-size` refusés.

## Codes de sortie

0 tout OK · 1 au moins un FAIL · 2 erreur de syntaxe ou d'usage (rien exécuté).

## Quand l'utilisateur apprend fls

Partir de son besoin réel, proposer d'abord la lecture rapide, puis un petit script `@read` + `@grep`, puis un `@edit` en `--dry-run`, puis `fls undo`. Les gardes `@expect_*` et la syntaxe `@fls 2` viennent ensuite, quand un travail se répète. Montrer chaque commande avec son rapport attendu plutôt que d'expliquer la grammaire en entier.
