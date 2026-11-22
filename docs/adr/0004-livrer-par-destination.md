# 0004 — Livrer une sortie à des destinations, pas à des drapeaux

Date : 2026-11-22 · Version : fls 1.2.0 · Statut : accepté · Amende l'ADR-0002 (repli)

## Contexte

`emit` recalculait trois fois la même décision (couleur ? troncature ? octets bruts ?), une fois par sortie : stdout, `--output`, `--clip`. `Report` portait quatre indicateurs qui se recoupaient (`doc`, `snapshot`, `preColored`, `raw`), et la lecture `--tree` décidait seule de sa couleur avant `emit`. `resolveTargets` connaissait `--output` et `--clip` pour décider du repli, et le désactivait partout : avec `--colored --clip`, même le terminal n'était plus replié.

## Décision

1. **`Report.content`** (une donnée : `report` ou `tree`) remplace `doc`, `snapshot` et `preColored` ; `Report.remember` dit s'il faut la mémoriser ; `text` (rendu brut) et `raw` (octets exacts d'un `--tree`) restent.
2. **Destinations.** `destinationsFor(args, io)` renvoie la liste des destinations (stdout, sauf avec `--output`, le fichier de `--output`, le presse-papiers) avec, pour chacune, `styled`, `columns`, `limit` et `exactBytes`. `deliver(report, delivery, io)` rend, tronque, écrit, puis mémorise.
3. **Un rendu par jeu d'options.** Deux destinations de mêmes options partagent un rendu.
4. **Le repli est une propriété du terminal.** Seule la destination stdout reçoit une largeur ; fichier et presse-papiers n'en ont pas. `--colored --clip` replie donc l'écran et copie des lignes entières.
5. **Le rendu stylé d'un `--tree`** (`renderTreeStyled`) vit avec les autres rendus stylés et est appelé par `deliver` ; `finishTree` n'a plus à connaître la couleur. *(Amendé par l'ADR-0005 : il vit dans `src/report/tree-styled.ts` et part de la structure de l'arbre.)*
6. `emit`, `resolveTargets` et `ColorTargets` disparaissent ; `colorPlan` ne garde que la décision de couleur par sortie, utilisée aussi pour les erreurs sur stderr (hors périmètre).

## Alternatives écartées

- **Garder `emit` et ajouter des options** : le défaut (la décision recalculée par sortie) restait.
- **Mémoriser dans `main`** : plus simple, mais le module de sortie aurait dû renvoyer ce qu'il rend ; la mémorisation fait partie de la livraison.
- **Mettre les erreurs stderr dans le module** : une seule chaîne, sans rendu ni troncature ; le `catch` de `main` doit fonctionner même si la lecture des arguments échoue.

## Conséquences

- Changement de comportement voulu : `--colored --clip` (ou avec `--output`) replie le terminal. Avant, rien n'était replié, effet de bord du code plutôt qu'un choix.
- Ajouter une destination (un fichier de journal, par exemple) revient à ajouter une entrée de liste : l'Io a déjà deux vrais adapters (terminal et fake de test).
- `saveLast`, `loadLast`, `VERSION` et `numberArg` sont sortis de `fls.ts` (`last.ts`, `version.ts`, `args.ts`) pour éviter des imports circulaires ; `fls.ts` les ré-exporte.
- Les sorties sont identiques à celles de la version précédente en brut et en coloré (comparées sur des scripts réels, mêmes codes de sortie), hors le repli ci-dessus.
