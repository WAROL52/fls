# 0008 — La couche de programmation est une expansion préalable, pas un interpréteur

Date : 2026-11-22 · Version : fls 1.4.0 · Statut : accepté · Réalise la « v2 » de la feuille de route du PRD (§10)

## Contexte

La même modification sur trente fichiers, un gabarit répété trois fois, une étape qui dépend de la présence d'un fichier : la v1 oblige à les écrire à la main ou à les faire générer par le modèle. Le PRD prévoyait une couche de programmation « évaluée en une phase d'expansion sur l'état initial » et classait comme risque la dérive vers un langage complet.

## Décision

1. **Un Script source devient un Script plat avant toute exécution.** La v1 n'a pas changé : elle exécute, simule (`--dry-run`), journalise et annule un script plat comme avant. `fls expand` montre exactement ce qui va se passer.
2. **L'expansion lit le disque initial**, jamais l'état simulé : `exists`, `read` et `glob` ne voient pas les écritures du même script.
3. **Un pragma `@fls 2`, première ligne du script.** Sans lui, `{{`, `@for`… ne veulent rien dire : un `@grep "{{" src` ou un `@edit` sur un composant `style={{ … }}` de la v1 continue de marcher à l'identique. C'est pourquoi la version est `1.4.0` et non `2.0.0` : rien de ce qui marchait ne casse.
4. **Lignes de contrôle `@let / @for / @if / @def / @call / @end`**, de la même famille que les directives, sans indentation significative : un bloc `CONTENT` collé garde n'importe quelle indentation sans ambiguïté.
5. **Les blocs restent littéraux.** Un bloc interpolé se déclare (`<<<<<<< TEMPLATE`, `<<<<<<< SEARCH TEMPLATE`). `{{ }}` dans les arguments ne produit qu'un texte ou un entier, et un mot interpolé n'est jamais une option.
6. **Des macros, pas de fonctions de valeur.** Une macro ne peut appeler qu'une macro déjà définie : la récursion est exclue par construction, sans détection de cycle. Le calcul passe par une liste fermée de fonctions intégrées, en lecture seule.
7. **Un langage d'expressions écrit à la main, sans `eval`**, avec des plafonds (taille, étapes, directives émises). Une erreur d'expansion est un code de sortie 2 : rien n'est exécuté.

## Alternatives écartées

- **Évaluer pendant l'exécution** (les lectures voient l'état simulé). Un `@if exists(…)` verrait le fichier qu'un `@create` précédent vient de simuler, mais le script plat n'existerait plus avant d'exécuter : `expand`, `--dry-run` et le Journal perdraient leur sens, et chaque directive deviendrait potentiellement une décision.
- **Une vraie syntaxe Python avec indentation.** Plus familière, mais ambiguë à côté d'un `CONTENT` collé depuis un terminal (les tabulations y sont déjà un risque connu).
- **Interpoler partout, avec `\{{` pour le littéral.** Casserait les scripts de la v1 qui contiennent déjà `{{`, et obligerait à échapper chaque composant Vue, Handlebars ou React collé.
- **Fonctions de valeur définies par l'utilisateur.** Elles obligeraient à gérer la récursion et la portée : c'est le chemin vers « un langage complet ».
- **Globs dans les arguments des directives et `--all`.** `glob()` avec `@for` fait le même travail, par un seul mécanisme ; `@delete` et `@move` restent sur des fichiers.

## Conséquences

- L'état à l'expansion est le disque d'avant le run : un script ne peut pas décider d'après ses propres écritures. C'est la limite à connaître ; les vérifications `@expect_*` (ADR-0007) servent à constater après coup.
- Le Journal et le Rapport ne changent pas : ils parlent le script plat. Une boucle de 30 fichiers donne 30 entrées.
- `src/script.ts` (parseur et sérialiseur du script plat) est sorti de `fls.ts` pour que `src/expand/` s'appuie sur les mêmes briques sans import circulaire.
- Les prochaines étapes de la feuille de route (directives structurelles, snippets) peuvent produire du script plat sans toucher à l'exécution.
