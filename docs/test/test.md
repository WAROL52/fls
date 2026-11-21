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
| `src/color.test.ts` | palette ANSI, modes de couleur, fond limité aux contenus de fichier, tabulations, `--tree --colored` sans coupe par défaut, coloration du rapport, de l'arbre et des diffs |
| `src/tree.test.ts` | `renderTree` (fichiers, dossiers, liens, illisibles, surcouche mémoire), `@read --tree`, `--tree` global, lecture rapide `fls --tree` |
| `src/tree.e2e.test.ts` | parité octet pour octet avec `bin/treecat`, divergences volontaires de sécurité, mode script |
| `src/highlight.test.ts` | coloration syntaxique (Shiki) |

## Principes

- **Entrées/sorties injectées.** `main(argv, io)` reçoit un objet `Io` (dossier courant, entrée standard, sorties, presse-papiers, horloge, identifiant). Les tests en fabriquent un faux ; le vrai `Io` n'est construit qu'au chargement du module.
- **Vrais dossiers temporaires.** Chaque test crée son arborescence dans un dossier temporaire (`sb({ "a.ts": "…" })`) et le supprime après coup. Liens symboliques, permissions et fichiers illisibles sont réels.
- **Vrais sous-processus quand c'est le sujet.** Le presse-papiers, le binaire et la parité `treecat` passent par de vrais processus.
- **Tables plutôt que chaînes de `if`.** Le code est organisé pour que chaque branche soit atteignable sans astuce de test.
- **Le mock de Shiki.** `color.test.ts` remplace `highlightCode` par une fonction qui entoure chaque ligne de `<H>…</H>`. Cela rend les assertions sur le fond et les tabulations lisibles et indépendantes du thème. La vraie coloration est couverte dans `highlight.test.ts` et vérifiée à la main sur un fichier réel.

## Écrire un test

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
| `fls src --tree --colored` coupé au milieu de l'arbre, sous-dossiers invisibles | `aucune coupe par défaut` : arbre de plus de 200 000 caractères complet, `--max-output-chars` explicite coupe toujours |

## Couverture

Après `pnpm run test:coverage`, le rapport HTML est dans `coverage/`. Le dossier est ignoré par git.

Les rares exclusions utilisent `/* v8 ignore … */` avec un commentaire qui explique pourquoi la branche est inatteignable (par exemple une garde défensive). Ne pas en ajouter pour contourner le seuil : écrire le test.
