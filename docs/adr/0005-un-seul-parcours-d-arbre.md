# 0005 — Un arbre lu en structure : un parcours, plusieurs rendus

Date : 2026-11-22 · Version : fls 1.2.0 · Statut : accepté · Amende l'ADR-0004 (emplacement du rendu stylé de l'arbre)

## Contexte

La lecture `--tree` produisait un texte (la sortie façon treecat). Le rendu coloré **reparsait ce texte** pour redeviner la structure : motifs `├── `, `└── `, regard sur la ligne suivante pour savoir si une entrée était un dossier, un lien ou un fichier. Un fichier dont le contenu ressemble à de l'arbre (lignes `├── x`, `-> y`, `[unreadable]`) était pris pour de la structure : numéros de ligne qui repartaient à 1, fond interrompu, contenu sorti de son fichier. La sortie brute, elle, était correcte.

## Décision

1. **`TreeNode`** (dossier, fichier avec ses lignes et un marqueur éventuel, lien) est la donnée d'un arbre. Un seul parcours (`walkTree`) produit **à la fois** les octets exacts (`Report.raw`, parité octet pour octet avec `bin/treecat`) et la structure.
2. **Le rendu stylé parcourt la structure** (`src/report/tree-styled.ts`) ; `colorizeQuickTree` et son heuristique disparaissent.
3. **La Dernière sortie d'un `--tree` stocke la structure** (`SNAPSHOT_FORMAT` 3). Les lignes sont décodées en UTF-8 : un fichier non UTF-8 relu par `fls last` apparaît avec ses caractères de remplacement (la copie est un confort, ADR-0002) ; le brut exact n'existe que pour la commande qui vient de s'exécuter.
4. **`treeText(node)`** reconstruit le texte depuis la structure pour `fls last`. Les glyphes (`├── `, `└── `, `│   `) sont définis une seule fois dans `tree.ts` et partagés par le parcours, `treeText` et le rendu stylé.
5. **Hors périmètre** : `treeLines` (`@tree`, `@read <dossier>`) a une autre politique (ignores, suffixe `/`, liens `nom -> cible`, pas de contenu) et ne reparse rien ; `@read <chemin> --tree` dans un script reste un segment `text`.

## Alternatives écartées

- **Unifier aussi `treeLines`** : cela ajouterait des options de politique au parcours sans supprimer de reparsage.
- **Un segment `tree` pour `@read --tree` dans un script** : son rendu brut exigerait un second formateur de texte à côté des octets exacts.
- **Stocker les octets exacts dans la copie** : la copie est en texte (JSON) et sert à réafficher ; elle n'a pas à garantir les octets.
- **Corriger l'heuristique** : on ne peut pas distinguer, à partir du seul texte, un contenu qui ressemble à de l'arbre d'une entrée réelle.

## Conséquences

- Le rendu coloré d'un fichier dont le contenu ressemble à de l'arbre est corrigé (test de régression). Pour tous les autres arbres, il est identique à celui d'avant (comparé sur de vrais dossiers, y compris tout `src` et `docs`).
- Le glyphe d'un arbre est connu d'un seul endroit ; `treeText` et la sortie brute sont vérifiés égaux sur un jeu de dossiers (test de cohérence).
- Une ancienne copie de la Dernière sortie (format 2, arbres en texte) est traitée comme absente.
