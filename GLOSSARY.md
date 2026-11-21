# Glossaire

**Directive** — Instruction d'un script fls (`@read`, `@grep`, `@edit`…), une par ligne, éventuellement suivie d'un bloc.

**Script plat** — Forme canonique d'un script : une directive par paragraphe, alias développés, sans commentaires. Produit par `fls expand` et enregistré dans le journal.

**Forme `#@`** — Écriture d'une directive de lecture précédée de `#`, équivalente à la forme `@`. Elle reste un commentaire pour un shell, ce qui permet de coller un script dans un terminal.

**Zone clip** — Portion d'un script délimitée par les marqueurs `clip start` et `clip end`. Quand elle existe, seul son contenu est lu.

**Rapport** — Sortie d'une exécution : une entrée par directive (OK, FAIL, SKIP), puis un résumé.

**Run** — Exécution journalisée d'un script ayant produit au moins un changement effectif ; annulable avec `undo`.

**Gouttière** — Colonne de numéros de ligne (`12 │ `) affichée devant le contenu d'un fichier en sortie colorée. Le numéro n'apparaît que sur la première ligne visuelle d'une ligne repliée.

**Ligne visuelle** — Une ligne telle qu'affichée par le terminal : une ligne de fichier trop longue en occupe plusieurs une fois repliée.

**Dernière sortie** — Copie non colorée de la sortie de la dernière lecture ou du dernier script, mémorisée pour être réaffichée par `fls last` sans réexécution.
