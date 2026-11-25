# AGENTS

## Lire d’abord

- `SPEC.md` — comportement attendu de `fls` (référence).
- `PRD.md` — intention produit et feuille de route.
- `GLOSSARY.md` — vocabulaire du domaine.

## Vérifier

- `pnpm run test:coverage` — tests unitaires, e2e et couverture (seuil 100%).
- CI : `.github/workflows/test.yml` lance `pnpm test` sur Node 22/24.

## Conventions utiles

- Changements code : `@find_ast`/`@edit_ast` pour les motifs structurels (ast-grep, optionnel) ; `@grep`/`@edit` pour le texte exact. Lire `skills/fls/SKILL.md` avant un script fls non trivial.
- Après modif `src/`, relancer `pnpm run build:install` pour mettre à jour le binaire global.
- Syntaxe TypeScript effaçable uniquement ; pas de dépendance runtime hors Node/shiki.
