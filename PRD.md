# PRD — fls v1

> Statut : v1 implémentée (`fls.ts`, 86 tests, couverture 100 %). Spécification détaillée : `SPEC.md`.

## 1. Contexte et problème

Modifier du code avec l'aide d'un modèle (Claude, ou une IA locale moins fiable) se passe en allers-retours : le modèle demande à voir un fichier, l'utilisateur le colle, le modèle répond par des étapes, l'utilisateur les applique à la main, puis revient avec le résultat. C'est lent et source d'erreurs de recopie.

Un outil maison, `treecat`, règle la moitié du problème (sortir le contexte du projet en un bloc de texte). Il a des défauts : préfixe d'arbre devant chaque ligne de code (qui dégrade le copier-coller et les correspondances exactes), aucun filtre (`.git`, `node_modules`, binaires), pas de limite de taille, et il ne sait pas écrire.

## 2. Objectif

**Fermer la boucle avec une seule commande, `fls`, qui lit et écrit.**

1. L'utilisateur lance `fls <chemins> --clip` : le contexte est dans le presse-papiers.
2. Il le colle au modèle, qui répond par **un seul script** mêlant lectures et modifications.
3. Il lance `fls --clip` : le script s'exécute, et le **rapport** (historique de haut en bas : lectures, diffs, erreurs) est copié, prêt à être recollé au modèle.

Le script est conçu pour être écrit par un modèle, y compris un modèle faible : syntaxe explicite, erreurs à codes stables, aucune devinette de la part de l'outil.

## 3. Utilisateur

Un développeur (usage personnel d'abord), sous Linux / macOS / WSL, qui travaille avec des modèles de langage et veut des modifications **vérifiables, annulables et reproductibles**.

## 4. Périmètre v1

### Inclus

- Lecture rapide : `fls src/ lib/a.ts` (remplace `treecat`, avec ignores, limites et binaires gérés).
- Scripts par entrée standard (heredoc), `--file`, `--clip`.
- Sous-commandes : `expand`, `--dry-run`, `undo`, `log`, `spec`, `help`, `init`.
- Directives : `@tree`, `@read`, `@grep`, `@note`, `@edit` (SEARCH/REPLACE), `@create`, `@overwrite`, `@write`, `@append`, `@delete`, `@move`.
- Journal et annulation de chaque run.

### Hors périmètre v1 (volontairement)

| Sujet | Quand |
|---|---|
| Syntaxe de programmation (variables, boucles, conditions, fonctions) | livrée en 1.4.0 (`@fls 2`), voir l'ADR-0008 |
| Directives `@copy`, `@mkdir`, `@stat`, `@expect_*`, `@history` | livrées en 1.3.0 |
| Directives structurelles (ast-grep) | livrées en 1.5.0 (`@find_ast` / `@edit_ast`) |
| Snippets, codegen, registry de partage | après v2 |
| `@delete` / `@move` sur des dossiers, `--all` | non planifié ; les globs passent par `glob()` + `@for` (1.4.0) |
| Sortie JSON, interface TUI/web, Windows natif | non planifié |

## 5. Exigences fonctionnelles

| # | Exigence |
|---|---|
| F1 | Un script s'exécute de haut en bas ; les lectures voient l'état simulé par les écritures précédentes — sauf `@find_ast` / `@edit_ast`, qui lisent le disque au début du run et refusent un fichier déjà modifié (`ast_grep_stale`). |
| F2 | `@edit` désigne l'endroit par le texte existant : un SEARCH doit être trouvé **exactement une fois**, sinon échec explicite (avec la ligne la plus proche ou les numéros de ligne). |
| F3 | Chaque `@edit` est atomique ; les écritures réussies d'un script sont appliquées même si une autre échoue. |
| F4 | Après un échec d'écriture, les écritures suivantes sont `SKIP` mais les lectures continuent (le rapport reflète l'état réel). |
| F5 | `--dry-run` exécute le même code que l'exécution réelle, sans écrire. |
| F6 | Chaque run qui modifie des fichiers est journalisé et annulable ; `undo` refuse d'écraser des changements manuels sans `--force`. |
| F7 | Le rapport est un texte brut numéroté, collable tel quel ; un marqueur indique toute troncature. |
| F8 | `fls spec` et `fls help` décrivent la syntaxe exacte (sortie générée depuis la même table que le parseur). |
| F9 | `fls expand` affiche le script plat canonique (base de la future phase d'expansion de la v2). |

## 6. Exigences non fonctionnelles

- **Sécurité** : chemins confinés au dossier courant (absolus, `..` et liens symboliques sortants refusés) ; aucune exécution de commande shell ; liens symboliques jamais suivis ni modifiés.
- **Robustesse** : écriture atomique (fichier temporaire puis `rename`) ; conservation des fins de ligne (CRLF/LF), du BOM, des permissions ; refus explicite des binaires, des fichiers trop gros et de l'UTF-8 invalide.
- **Déterminisme** : mêmes entrées, même rapport (hors horodatage et identifiant de run).
- **Portabilité** : un seul fichier, zéro dépendance hors Node.js, exécutable par `node fls.ts` ; `ast-grep` est une dépendance externe **optionnelle**, réservée aux directives structurelles.
- **Qualité** : couverture de tests de 100 % (statements, branches, fonctions, lignes), obtenue par conception (E/S injectées, directives en table, aucun code défensif inatteignable).

## 7. Décisions de conception clés

1. **Texte comme ancre, pas numéros de ligne** pour écrire : les modèles se trompent sur les numéros, et ils se décalent après la première modification. Les numéros restent disponibles pour *lire*.
2. **Surcouche en mémoire** : tout s'exécute sur un état simulé, le « commit » n'a lieu qu'à la fin. Le dry-run vient donc gratuitement et reste fidèle.
3. **Échec partiel assumé** (F3, F4) plutôt que tout-ou-rien : un bloc faux ne doit pas annuler tout le travail, et le rapport dit exactement ce qui a été fait.
4. **Options longues et noms explicites** (`@create` vs `@overwrite`) : lisibilité pour l'humain et le modèle avant la concision.
5. **Erreurs à codes stables** (`not_found`, `ambiguous_match`, …) que le modèle peut lire et corriger sans ambiguïté.
6. **ast-grep calcule, fls écrit** : aucune écriture directe par ast-grep (`--update-all` n'est jamais utilisé) ; ses matches sont revalidés (confinement, ignore, offsets UTF-8) et appliqués via le Workspace, donc dry-run, journal et undo restent la seule voie d'écriture.

## 8. Critères de succès

- Un cycle complet « contexte → script → rapport » se fait en **deux collages** (un vers le modèle, un depuis le modèle), sans question intermédiaire du modèle dans les cas courants.
- Le script d'exemple du cahier des charges (arbre, lectures, grep, `@edit` à deux blocs, `@write`, `@move`, `@delete`, relecture) s'exécute tel quel, se simule avec `--dry-run` et s'annule avec `undo`.
- `npx vitest run --coverage --coverage.thresholds.100` passe.
- Aucun fichier hors du dossier courant n'est lisible ni modifiable, liens symboliques compris.

## 9. Risques et parades

| Risque | Parade |
|---|---|
| Un SEARCH écrit de mémoire par le modèle ne correspond plus au fichier | Échec explicite avec la ligne la plus proche ; le rapport contient le fichier relu, donc la correction se fait en un tour. |
| Coller un gros heredoc dans un terminal corrompt les tabulations / tronque les longues lignes | `--clip` et `--file` contournent le terminal ; recommandés comme mode principal. |
| Exécuter un script produit par un LLM | Confinement des chemins, pas de shell, `--dry-run`, `expand`, journal et `undo`. |
| Dérive de périmètre vers un langage complet | La couche de programmation est une expansion séparée qui produit le script plat de la v1 ; pas de fonctions de valeur ni de récursion, pas d'accès hors du disque du projet, plafonds de taille et d'étapes. |
| `undo` écrase un travail manuel | Détection de conflit par empreinte du contenu écrit ; refus sans `--force`. |
| ast-grep absent ou trop ancien | Erreur typée `ast_grep_unavailable` / `ast_grep_version` avec la commande d'installation ; le reste de fls fonctionne sans lui. |
| Un fichier change entre le calcul d'ast-grep et l'écriture | Vérification des octets et des offsets ; `conflict` / `ast_grep_stale`, rien n'est écrit. |

## 10. Feuille de route

- **v1** (ce document) : directives plates, journal, undo, `--clip`.
- **v2 (livrée en 1.4.0, `@fls 2`)** : couche de programmation (variables, `@for`, `@if`, macros sans récursion, interpolation `{{ expr }}`, fonctions intégrées en lecture seule), évaluée **en une phase d'expansion** sur l'état initial, qui produit un script plat exécuté par la v1 ; les globs passent par `glob()`. Voir `SPEC.md` §4.6 et l'ADR-0008.
- **v3 (partiellement livrée en 1.5.0)** : `@find_ast` / `@edit_ast` (ast-grep calcule, fls valide et écrit), snippets et codegen d'infrastructure idempotents, distribution par registry.

## 11. Questions ouvertes

- Faut-il un repli sur les espaces de fin de ligne pour les correspondances SEARCH (signalé dans le rapport) ?
- `undo` doit-il supprimer les dossiers vides créés par le run ?
- ~~Quels dictionnaires / fonctions intégrées exige la v2 dès sa première version ?~~ Réglé en 1.4.0 : dictionnaires de texte/entier, et la liste fermée de `fls spec` (lecture seule).
