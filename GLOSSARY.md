# Glossaire

**Directive** — Instruction d'un script fls (`@read`, `@grep`, `@edit`…), une par ligne, éventuellement suivie d'un bloc.

**Script source** — Script écrit avec la syntaxe v2 (il commence par `@fls 2`) : variables, boucles, conditions, macros, interpolation. Il n'est jamais exécuté tel quel ; l'Expansion le transforme en Script plat.

**Expansion** — Phase qui transforme un Script source en Script plat, avant toute exécution, en lisant le disque tel qu'il est au départ (jamais l'état simulé par le script). `fls expand` l'affiche.

**Macro** — Groupe de directives nommé et paramétré (`@def`), émis par `@call`. Elle ne peut appeler que des macros définies plus haut, donc jamais elle-même.

**Script plat** — Forme canonique d'un script : une directive par paragraphe, alias développés, sans commentaires. Produit par `fls expand` et enregistré dans le journal.

**Forme `#@`** — Écriture d'une directive de lecture précédée de `#`, équivalente à la forme `@`. Elle reste un commentaire pour un shell, ce qui permet de coller un script dans un terminal.

**Zone clip** — Portion d'un script délimitée par les marqueurs `clip start` et `clip end`. Quand elle existe, seul son contenu est lu.

**Vérification** — Directive `@expect_*` qui constate un fait sur l'état simulé (un chemin existe ou non, un fichier contient un texte). Si elle échoue, les écritures suivantes sont ignorées ; celles déjà faites ne sont pas annulées.

**Rapport** — Sortie d'une exécution : une entrée par directive (OK, FAIL, SKIP), puis un résumé. C'est une donnée (en-tête, entrées, pied) que l'on rend de deux façons : rendu brut ou rendu stylé.

**Entrée** — Ce que le Rapport dit d'une directive exécutée (le `[n] OK READ …` et son corps). À ne pas confondre avec la directive elle-même.

**Segment** — Partie typée du corps d'une entrée : texte, fichier lu, fichier omis, occurrences de `@grep`, diff de `@edit`. Les deux rendus partent des segments ; rien n'est reparsé.

**Rendu brut** — Le texte du Rapport défini par `SPEC.md` §8. C'est le contrat : il ne change pas d'un octet.

**Arbre** — Une lecture `--tree` en donnée : dossiers, fichiers (avec leurs lignes) et liens, lue une fois. La sortie brute (octets exacts façon `treecat`), le rendu stylé et la Dernière sortie en sont tirés ; aucun texte n'est reparsé.

**Destination** — Là où part une sortie : le terminal, le fichier de `--output`, le presse-papiers. Chacune a ses propres options (couleur, largeur, limite de taille) ; seul le terminal a une largeur.

**Rendu stylé** — Le Rapport pour un terminal : couleurs, gouttière, repli à la largeur.

**Ligne stylée** — Une ligne du rendu stylé, avant tout codage pour le terminal : des **spans**, un fond éventuel, un préfixe hors fond.

**Span** — Un morceau de texte et son style (couleur, gras, discret, italique, souligné, inversé).

**Journal** — Lieu où les Runs sont conservés (script plat, rapport, sauvegardes) ; `log` le lit et `undo` s'en sert pour restaurer.

**Run** — Exécution journalisée d'un script ayant produit au moins un changement effectif (fichier modifié ou dossier créé) ; annulable avec `undo`.

**Gouttière** — Colonne de numéros de ligne (`12 │ `) affichée devant le contenu d'un fichier en sortie colorée. Le numéro n'apparaît que sur la première ligne visuelle d'une ligne repliée.

**Ligne visuelle** — Une ligne telle qu'affichée par le terminal : une ligne de fichier trop longue en occupe plusieurs une fois repliée.

**Dernière sortie** — Copie non colorée de la sortie de la dernière lecture ou du dernier script, mémorisée pour être réaffichée par `fls last` sans réexécution.
