# Tests de fls

La suite utilise [Vitest](https://vitest.dev) et exige **100 % de couverture** (statements, branches, fonctions, lignes) sur tous les modules de `src/`. Le seuil est configuré dans `vitest.config.ts` : un seul chemin non testé fait échouer `pnpm test`.

## Lancer les tests

```bash
pnpm test                 # tout : unitaires, e2e, puis couverture
pnpm run test:unit        # tests rapides (sans binaire ni sous-processus lourds)
pnpm run test:e2e         # tests avec vrai binaire, vrai exécuteur de presse-papiers, parité treecat
pnpm run test:coverage    # toute la suite avec le rapport de couverture et le seuil de 100 %
```

`test:unit` et `test:e2e` se partagent la suite par nom de test : sont « e2e » les tests dont le titre contient `le binaire fonctionne`, `realRunner` ou `treecat`. Les autres sont « unitaires ».

Un test précis : `pnpm exec vitest run -t "forme #@"`.

## Organisation

| Fichier | Contenu |
|---|---|
| `src/fls.test.ts` | parseur, directives (`@tree`, `@read`, `@grep`, `@note`, `@edit`, écritures, `@delete`, `@move`), exécution et politique d'échec, sources et sorties, journal / `undo` / `log`, aide, `parseArgs` et `main`, presse-papiers, E/S réelles et point d'entrée |
| `src/report.test.ts` | le module Rapport par son interface : rendu brut (chaque segment, rapport complet), rendu stylé (fond, gouttière, repli, grep, diff, highlighter en erreur), copie versionnée de la Dernière sortie |
| `src/output.test.ts` | les destinations : `destinationsFor` (règles par destination) et `deliver` (un rendu par jeu d'options, repli du terminal seul, troncature, octets exacts, mémorisation), et le cas de bout en bout `--colored --clip` |
| `src/color.test.ts` | modes de couleur, fond limité aux contenus de fichier, tabulations, `--tree --colored` sans coupe par défaut, coloration du rapport, de l'arbre et des diffs |
| `src/wrap.test.ts` | numéros de ligne et repli à la largeur du terminal (`@read`, `--tree`, `@grep`, `@edit`), absence de repli vers fichier / presse-papiers ; utilise la vraie coloration Shiki |
| `src/last.test.ts` | `fls last` : réaffichage sans réexécution, réajustement de la largeur, mémorisation, erreurs (`no_last_output`, cache corrompu ou illisible), `cacheDirFor`, `terminalColumns` |
| `src/tree-styled.test.ts` | le rendu stylé d'un arbre par sa structure (branches, contenu à la colonne du nom, marqueurs, repli, langue) et la régression « fichier dont le contenu ressemble à un arbre » |
| `src/tree.test.ts` | `renderTree` et `walkTree` (fichiers, dossiers, liens, illisibles, surcouche mémoire, structure), `treeText` (texte reconstruit == sortie brute), `@read --tree`, `--tree` global, lecture rapide `fls --tree` |
| `src/tree.e2e.test.ts` | parité octet pour octet avec `bin/treecat`, divergences volontaires de sécurité, mode script |
| `src/directive.test.ts` | les directives de 1.3.0 : `@copy`, `@mkdir` (dossiers vides, `undo`), `@stat`, `@expect_*` (constat, garde-fou des écritures, forme `#@`), `@history`, aide |
| `src/highlight.test.ts` | coloration syntaxique (Shiki) : spans, couleurs du thème opencode |
| `src/style.test.ts` | le texte stylé : couleurs dégradées, palette, `wrapSpans`, et le sérialiseur `toAnsi` (niveaux, fond, préfixe, limite sans couper une séquence) |
| `src/journal.test.ts` | le Journal : enregistrement, relecture, annulation, conflits et `--force`, sur de vrais dossiers |
| `src/testing/io.ts` | l'adapter de test unique de l'`Io` (voir ci-dessous) ; `src/testing/io.test.ts` le vérifie |

## Principes

- **Entrées/sorties injectées.** `main(argv, io)` reçoit un objet `Io` (dossier courant, entrée standard, sorties, presse-papiers, horloge, identifiant). Les tests en fabriquent un faux ; le vrai `Io` n'est construit qu'au chargement du module.
- **Vrais dossiers temporaires.** Chaque test crée son arborescence dans un dossier temporaire (`sb({ "a.ts": "…" })`) et le supprime après coup. Liens symboliques, permissions et fichiers illisibles sont réels.
- **Vrais sous-processus quand c'est le sujet.** Le presse-papiers, le binaire et la parité `treecat` passent par de vrais processus.
- **Tables plutôt que chaînes de `if`.** Le code est organisé pour que chaque branche soit atteignable sans astuce de test.
- **Le highlighter est injecté, pas mocké.** Le rendu stylé reçoit un `Highlighter` (`Io.highlighter` en production, Shiki par défaut). Les tests passent un highlighter de test qui renvoie, pour chaque ligne, un span `<H>…</H>` : les assertions restent lisibles et indépendantes du thème. Les vraies couleurs du thème sont vérifiées dans `highlight.test.ts` et sur la vraie coloration dans `wrap.test.ts`.

## Écrire un test

**Adapter de test (`src/testing/io.ts`).** Les valeurs par défaut du faux `Io` (horloge fixe, id `r1`, aucun terminal, `env` vide, presse-papiers en mémoire) sont définies une seule fois. Importer le module installe le nettoyage des dossiers temporaires (même ceux dont les droits ont été retirés) et `vi.restoreAllMocks()` après chaque test. Il exporte `sandbox(files, setup?)`, `put`, `fake(cwd, options)` (renvoie `{ io, out, err, clip }`), `runFls(cwd, argv, options)` (`out` garde les morceaux bruts, `text` les décode) et `session(files)` (même dossier et même cache d'une commande à l'autre). Le faux `Io` est typé `Io` sans cast, et un test vérifie qu'il expose les mêmes champs que `createRealIo`. Les fichiers de test n'y ajoutent que de minces enveloppes (`run`, `script`).

Helpers de `fls.test.ts` :

- `sb(files)` crée un dossier temporaire contenant `files` et renvoie son chemin.
- `run(argv, files, options)` lance `fls` dans un tel dossier et renvoie `{ code, text, errText, clip }`.
- `script(texte, files)` lance directement un script.
- `call(dir, argv, options)` lance `fls` dans un dossier existant (pour vérifier le disque après coup).
- Les options simulent `stdin`, le presse-papiers (`clipboard`) et les terminaux (`stdoutTTY`).

Exemple, tiré de la forme `#@` :

```ts
it("--clip : lit le bloc collé (ligne cd ignorée) et copie le rapport", async () => {
  const r = await run(["--clip"], files, { clipboard: paste });
  expect(r.code).toBe(0);
  expect(r.text).toContain("OK    NOTE hook session");
  expect(r.clip.text).toBe(r.text);
});
```

Pour une correction de bug, ajouter un test qui échoue avant le correctif et passe après, en reproduisant le cas réel (par exemple fichier indenté par tabulations, ou arbre dépassant 200 000 caractères colorés).

## Régressions couvertes en couleur

| Bug | Garde-fou |
|---|---|
| Fond appliqué à tout le rapport (en-tête, usage, notes, arbre) | `fond (bg) limité aux contenus de fichier` |
| Fond absent sous l'indentation par tabulations | `tabulations : le fond doit couvrir l'indentation` : plus de tabulation dans la sortie, chaque ligne de contenu commence par le fond et se termine par `ESC[K` |
| Texte replié par le terminal : lignes longues qui sortent du bloc, numéro de ligne introuvable | `repli à la largeur du terminal` et `numéros de ligne (sortie colorée)` |
| Affichage figé après un redimensionnement | `fls last : réaffichage sans réexécution` (largeur réajustée dans les deux sens) |
| `fls src --tree --colored` coupé au milieu de l'arbre, sous-dossiers invisibles | `aucune coupe par défaut` : arbre de plus de 200 000 caractères complet, `--max-output-chars` explicite coupe toujours |

## Tester l'affichage et `fls last`

- La largeur du terminal est injectée : `Io.columns` (`undefined` hors terminal). Un test choisit `columns: 40` et vérifie que chaque ligne visuelle, ANSI retirés, fait au plus `columns - 1` colonnes, que le fond commence et finit chaque ligne et que les morceaux recollés redonnent la ligne source.
- Le Rapport se teste **par sa structure** (`ReportDoc` → `renderPlain` / `renderStyled`, qui renvoie des lignes stylées ; les tests les sérialisent avec `toAnsi`), pas en reparsant du texte ou de l'ANSI.
- Le dossier de mémorisation est injecté : `Io.cacheDir`. `last.test.ts` construit une « session » (même dossier de travail et même cache d'une commande à l'autre) pour enchaîner une commande puis `fls last`.
- Preuve de non-réexécution : modifier ou supprimer un fichier entre la commande et `fls last`, et constater que la sortie réaffichée est l'ancienne.

## Couverture

Après `pnpm run test:coverage`, le rapport HTML est dans `coverage/`. Le dossier est ignoré par git.

Les rares exclusions utilisent `/* v8 ignore … */` avec un commentaire qui explique pourquoi la branche est inatteignable (par exemple une garde défensive). Ne pas en ajouter pour contourner le seuil : écrire le test.
