# Glossaire

**Directive** — Instruction d'un script fls (`@read`, `@grep`, `@edit`…), une par ligne, éventuellement suivie d'un bloc.

**Script plat** — Forme canonique d'un script : une directive par paragraphe, alias développés, sans commentaires. Produit par `fls expand` et enregistré dans le journal.

**Forme `#@`** — Écriture d'une directive de lecture précédée de `#`, équivalente à la forme `@`. Elle reste un commentaire pour un shell, ce qui permet de coller un script dans un terminal.

**Zone clip** — Portion d'un script délimitée par les marqueurs `clip start` et `clip end`. Quand elle existe, seul son contenu est lu.

**Rapport** — Sortie d'une exécution : une entrée par directive (OK, FAIL, SKIP), puis un résumé. C'est une donnée (en-tête, entrées, pied) que l'on rend de deux façons : rendu brut ou rendu stylé.

**Entrée** — Ce que le Rapport dit d'une directive exécutée (le `[n] OK READ …` et son corps). À ne pas confondre avec la directive elle-même.

**Segment** — Partie typée du corps d'une entrée : texte, fichier lu, fichier omis, occurrences de `@grep`, diff de `@edit`. Les deux rendus partent des segments ; rien n'est reparsé.

**Rendu brut** — Le texte du Rapport défini par `SPEC.md` §8. C'est le contrat : il ne change pas d'un octet.

**Rendu stylé** — Le Rapport pour un terminal : couleurs, gouttière, repli à la largeur.

**Run** — Exécution journalisée d'un script ayant produit au moins un changement effectif ; annulable avec `undo`.

**Gouttière** — Colonne de numéros de ligne (`12 │ `) affichée devant le contenu d'un fichier en sortie colorée. Le numéro n'apparaît que sur la première ligne visuelle d'une ligne repliée.

**Ligne visuelle** — Une ligne telle qu'affichée par le terminal : une ligne de fichier trop longue en occupe plusieurs une fois repliée.

**Dernière sortie** — Copie non colorée de la sortie de la dernière lecture ou du dernier script, mémorisée pour être réaffichée par `fls last` sans réexécution.
