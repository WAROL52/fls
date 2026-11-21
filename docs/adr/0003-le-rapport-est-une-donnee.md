# 0003 — Le Rapport est une donnée, rendue de deux façons

Date : 2026-11-21 · Version : fls 1.2.0 · Statut : accepté · Amende l'ADR-0002 (format de la copie)

## Contexte

Les directives renvoyaient un titre et un corps **en texte** ; le rendu coloré reparsait ce texte avec une douzaine de regex (titre `lignes A-B sur N` pour retrouver les numéros de ligne, `=== chemin ===` pour les blocs, `fichier:ligne:` pour `@grep`, `@@` et `+ ` / `- ` pour les diffs). Changer le format d'un titre cassait la coloration sans que rien ne le signale, et chaque jalon (couleur, numéros de ligne, `fls last`, thème) touchait à la fois le producteur et le consommateur.

## Décision

1. **Segments typés.** Le corps d'une entrée est une suite de segments : `text`, `file`, `omitted`, `matches`, `diff`. Les directives les produisent ; elles ne formatent plus de texte.
2. **Un module Rapport** (`src/report/`) avec une interface étroite : `renderPlain(doc)`, `renderStyled(doc, options)`, `encodeSnapshot` / `decodeSnapshot`.
3. **Remplacer, pas superposer.** `Result.body` (chaîne) n'existe plus ; le texte est dérivé. `Report.text` (rendu brut) et `Report.doc` viennent de la même donnée, construite à un seul endroit.
4. **Le rendu brut est le contrat** (SPEC §8) et reste identique octet pour octet. Les tests existants (qui passent par `main`) et une comparaison avec la version précédente en ont fait la preuve.
5. **Highlighter injecté** (`Io.highlighter`, Shiki par défaut) au lieu d'un mock de module.
6. **Dernière sortie** : la copie stocke le Rapport en donnée, avec un numéro de format. Une copie d'un autre format (dont la copie texte de 1.2.0) est traitée comme absente (`no_last_output`).
7. `Result` devient `Entry` ; l'ancien `Entry` du Workspace devient `FileState`.

## Alternatives écartées

- **Garder le texte et améliorer les regex** : la fragilité reste, et chaque nouveau format double le travail.
- **Superposer** (directives qui remplissent texte et données) : les deux peuvent diverger.
- **Migrer l'ancienne copie texte** : cela demanderait de reparser, ce qu'on cherche à supprimer ; la copie est un confort.

## Conséquences

- Un changement de format d'entrée se fait dans `report/` ; les directives n'ont plus à connaître le rendu.
- Le rendu stylé se teste par sa structure, sans mock de module ni dépendance au texte ANSI.
- Hors périmètre, volontairement : l'arbre `--tree` garde sa copie `{ kind: "tree" }` et `colorizeQuickTree` (candidat « un seul parcours d'arbre »), et `emit` garde sa logique par destination (candidat « livrer par destinations »).
- Les sorties sans entrées (aide, `log`, `expand`, `spec`) sont du texte brut : le rendu stylé ne les touche plus (l'ancien rendu ne faisait que griser leur première ligne).
- Les en-têtes colorés ont désormais le même espacement qu'en brut (l'ancien rendu ajoutait deux espaces après le statut).
