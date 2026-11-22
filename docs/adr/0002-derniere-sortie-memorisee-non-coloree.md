# 0002 — Mémoriser la dernière sortie non colorée (`fls last`) et replier à la largeur du terminal

Date : 2026-11-21 · Version : fls 1.2.0 · Statut : accepté

## Contexte

Un terminal replie les lignes trop longues sans que le fond ni la numérotation de fls ne suivent : le texte déborde du bloc et on ne distingue plus une ligne repliée d'une nouvelle ligne. Redimensionner le terminal après coup ne reflue pas ce qui est déjà affiché. Il faut un moyen de réafficher le même résultat à la largeur actuelle, sans réexécuter (un script d'écriture ne doit pas être rejoué, et une lecture ne doit pas changer de contenu).

## Décision

1. **Repli dans le bloc** : en sortie colorée vers un terminal, fls replie lui-même les lignes à la largeur du terminal (`Io.columns`). Chaque ligne visuelle a son fond ; les numéros de ligne (gouttière `N │ `) sont toujours affichés en sortie colorée, et seulement sur la première ligne visuelle.
2. **`fls last`** : sous-commande qui réaffiche la dernière sortie sans rien réexécuter.
3. **Ce qui est mémorisé** : la sortie **non colorée** (le Rapport en donnée, ou les racines brutes d'un `--tree`), pas le rendu ANSI. *(Amendé par l'ADR-0003 : à l'origine, le texte du rapport.)* Le rendu est refait à chaque affichage, avec la couleur et la largeur du moment.
4. **Où** : `$XDG_CACHE_HOME/fls/last.json` (sinon `~/.cache/fls/last.json`), propre à l'utilisateur et non au projet. Une seule entrée, remplacée à chaque nouvelle sortie.
5. **Quoi mémoriser** : lecture rapide, `--tree`, scripts (`--dry-run` compris). Pas `last`, l'aide, `log`, `undo`, `init`, `expand`, les erreurs.
6. **Pas de repli** quand la sortie n'est pas un terminal. *(Amendé par l'ADR-0004 : à l'origine, aussi quand la sortie colorée était écrite dans un fichier ou le presse-papiers.)*
7. L'écriture du cache n'est jamais fatale.

## Alternatives écartées

- **Mémoriser le rendu ANSI** : il resterait figé à l'ancienne largeur, ce qui est exactement le défaut à corriger.
- **Réexécuter la commande** : rejouerait les écritures et pourrait montrer des fichiers modifiés entre-temps.
- **Cache dans le projet (`.fls/`)** : il n'existe pas toujours (lecture rapide sans `init`), il faudrait créer un dossier dans des projets où l'on ne fait que lire, et `last` ne marcherait pas depuis un autre dossier.
- **Laisser le terminal replier** : le fond ne suit pas, et rien n'indique qu'une ligne est la suite de la précédente.
- **Reflux automatique au redimensionnement** : demanderait de contrôler l'écran (écran alternatif, pagination). Hors de portée d'une commande qui écrit sur stdout.

## Conséquences

- Le cache contient le texte des fichiers lus (jusqu'à plusieurs Mo pour un gros `--tree`) : il ne doit pas être partagé. C'est un confort, jamais une source de vérité.
- Redimensionner reste « un désastre » visuel jusqu'à la prochaine commande ; `fls last` est le moyen de réajuster, comme voulu.
- Les numéros de ligne en sortie colorée changent le rendu : la sortie colorée n'est plus une version coloriée de la sortie brute (elle a une gouttière). La sortie sans couleur est inchangée.
- Une colonne est comptée comme un point de code : les caractères larges (CJK, emoji) ou combinants peuvent décaler le repli d'une colonne.
- Tout changement du format de `last.json` doit rester lisible ou donner `no_last_output` (un fichier illisible n'est jamais une erreur de plus). Le format porte un numéro (`format`) depuis l'ADR-0003 ; une copie d'un autre format est traitée comme absente.
