# 0007 — Une vérification bloque les écritures suivantes, sans retour en arrière

Date : 2026-11-22 · Version : fls 1.3.0 · Statut : accepté · Prolonge la politique d'échec de SPEC §6

## Contexte

Un script fls modifie plusieurs fichiers à la suite, et la seule politique d'échec était : un `FAIL` sur une écriture fait passer les écritures suivantes en `SKIP`. Il manquait une façon de dire « ne modifie rien si cette précondition est fausse » (un fichier attendu, un texte à remplacer, un fichier qui ne doit pas déjà exister), et de vérifier un résultat après coup.

## Décision

1. **Vérifications `@expect_*`** (`@expect_exists`, `@expect_missing`, `@expect_contains`) : elles constatent un fait sur l'état simulé, donc après un `@edit` elles voient son résultat. Un échec a le code `expectation_failed`.
2. **Un échec de vérification se comporte comme un échec d'écriture** : les écritures suivantes sont `SKIP`, les lectures continuent. La `Spec` d'une directive porte pour cela un champ `guard`, distinct de `writes` : une vérification ne modifie rien et n'est donc jamais bloquée elle-même.
3. **Pas de retour en arrière.** Les écritures déjà appliquées avant l'échec restent (« les écritures réussies sont appliquées », SPEC §6). Le run est journalisé, donc `fls undo` revient en arrière ; le pied du rapport l'indique.
4. **Dossiers vides.** `@mkdir` ajoute au Workspace un ensemble de dossiers créés, et au Journal un champ `dirs` : les dossiers réellement créés par le run. `undo` les retire s'ils sont restés vides et signale ceux qu'il conserve ; un `meta.json` sans `dirs` (avant 1.3.0) se lit comme une liste vide.

## Alternatives écartées

- **Une transaction : rien n'est écrit si une vérification échoue.** Cela changerait un contrat de 1.0 (les écritures réussies sont appliquées), obligerait à évaluer tout le script avant d'écrire et ferait de `--dry-run` un mode implicite. Les gardes placées avant les écritures donnent déjà l'effet voulu.
- **Un simple `FAIL` sans blocage.** Une précondition fausse laisserait quand même les écritures suivantes s'appliquer : c'est exactement ce qu'on veut éviter.
- **Faire échouer le script entier avec un autre code de sortie.** Le code 1 (au moins un `FAIL`) dit déjà la chose, et l'entrée `FAIL` montre laquelle.
- **Retirer un dossier non vide à l'annulation.** `undo` ne détruirait alors que ce que le run avait créé, mais des fichiers ajoutés depuis par l'utilisateur seraient perdus. Il les laisse et le dit.

## Conséquences

- Un script d'agent s'écrit : `@expect_exists …`, `@expect_contains … --count 1`, puis les `@edit`. Si une garde échoue, rien d'autre n'est écrit.
- Une vérification placée **après** des écritures ne peut pas les empêcher : elle sert à constater, et à décider d'un `undo`.
- Le nom d'une directive accepte `_` (`[A-Za-z][A-Za-z_]*`) ; la forme collable `#@` reste réservée aux directives sans écriture, et accepte donc `@stat`, `@history` et les vérifications.
- Un texte sur plusieurs lignes ne peut se chercher qu'avec `--regex` : une directive tient sur une ligne.
