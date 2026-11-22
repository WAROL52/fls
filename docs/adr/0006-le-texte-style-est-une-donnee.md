# 0006 — Le texte stylé est une donnée ; l'ANSI s'écrit en un seul endroit

Date : 2026-11-22 · Version : fls 1.2.0 · Statut : accepté · Complète l'ADR-0003 (le rendu stylé part des segments typés)

## Contexte

Le rendu stylé partait de segments typés (ADR-0003), mais il fabriquait des **chaînes ANSI** puis les **reparsait** à trois endroits : `wrapAnsi` rescannait les séquences SGR pour rouvrir les styles actifs à chaque ligne repliée, `Bg.wrap` faisait un `replaceAll(RESET, RESET + fond)`, `safeTruncate` détectait à la regex une séquence coupée en deux. La coloration syntaxique (`codeToANSI` de Shiki) renvoyait elle-même de l'ANSI, toujours en 24 bits, quel que soit le niveau de couleur demandé.

## Décision

1. **Une Ligne stylée est une donnée** (`src/style.ts`) : une suite de **Spans** (texte + style : couleur, gras, discret, italique, souligné, inversé), un fond éventuel (`bg`) et un préfixe hors fond (`lead`, le préfixe de l'arbre). Une couleur porte ses trois formes (24 bits, 256, 16).
2. **La mise en page travaille sur des spans** : `wrapSpans` coupe à la largeur sans rien rescanner ; la gouttière, l'indentation des lignes repliées et le fond sont des données de la ligne. `renderStyled` et `renderTreeStyled` renvoient des `Line[]`.
3. **Un seul sérialiseur** (`toAnsi`, `src/ansi.ts`) écrit les séquences d'échappement, au dernier moment, au niveau de couleur demandé. Il connaît ses frontières d'échappement : `--max-output-chars` y est appliqué (la limite compte toujours les caractères de la sortie, séquences comprises), sans regex ni retour en arrière.
4. **Le `Highlighter` renvoie des spans** (`Span[][]`). L'adapter Shiki utilise `codeToTokensBase` (dépendance directe `shiki`) ; `@shikijs/cli` n'est plus nécessaire. Un RVB se dégrade vers 256 ou 16 couleurs dans `style.ts`.
5. **Les couleurs des rôles** (`ok`, `fail`, `lineNo`…) gardent leurs codes 16 et 256 d'origine ; seules les couleurs du code, qui n'avaient pas d'équivalent, sont calculées.

## Alternatives écartées

- **Garder l'ANSI de Shiki et le reparser** : c'est la situation d'avant ; chaque nouvelle mise en page (repli, fond, troncature) devait comprendre l'ANSI.
- **Un fond par span** plutôt que par ligne : il fallait le répéter sur chaque span et ajouter un indicateur de remplissage ; le fond de ligne reproduit exactement le comportement du terminal (`EL`).
- **Tronquer sur le texte visible** : cela changerait la valeur de `--max-output-chars` pour les sorties colorées ; la limite garde son sens (caractères de la sortie).

## Conséquences

- Le texte visible et le style de chaque caractère sont identiques à ceux d'avant, vérifiés sur de vrais dossiers (`--tree src docs`, `@read`, `@grep`, `@edit`, `fls last`, à 60 et 200 colonnes) avec un interpréteur SGR qui compare caractère par caractère. Les octets ANSI diffèrent légèrement (resets).
- Une sortie colorée tronquée par `--max-output-chars` n'est plus coupée au même endroit qu'avant : le code coloré n'est plus émis avec les mêmes séquences, donc la même limite en caractères couvre un autre nombre de lignes.
- Le repli ne rouvre plus de style : l'indentation d'une ligne repliée n'est plus teintée de la couleur du token coupé (invisible, un espace).
- `toAnsi` sait servir les niveaux 16 et 256 couleurs ; la décision de couleur actuelle ne demande que 24 bits ou rien.
- Le rendu stylé se teste par sa structure (`Line[]`) ; quelques tests d'octets ANSI restent sur le sérialiseur seul.
