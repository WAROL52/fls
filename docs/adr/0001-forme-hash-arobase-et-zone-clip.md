# 0001 — Forme `#@` et zone clip pour les scripts collables

Date : 2026-11-21 · Version : fls 1.1.0 · Statut : accepté

## Contexte

Le flux d'usage principal est : une IA produit un script, l'utilisateur copie le bloc entier (ligne `cd … && fls --clip` comprise), le colle dans un shell, et `fls --clip` relit le presse-papiers, qui contient donc le bloc complet.

Avec la syntaxe 1.0, un tel bloc est inutilisable tel quel. Une ligne `@read …` collée dans un shell est interprétée comme une commande, et la ligne `cd …` donne une `syntax_error` dans fls, car toute ligne hors bloc doit commencer par `@`.

## Décision

1. **Forme `#@nom …`** : équivalente à `@nom …` et mélangeable avec elle. Un shell la traite comme un commentaire.
2. **Zone clip** : si le script contient une ligne `clip start` (`#{3,} clip start #*`, tolérante), seules les lignes entre `clip start` et `clip end` sont analysées. Plusieurs zones sont concaténées et le reste est ignoré, y compris la ligne `cd`.
3. **Lecture seule** : `#@` n'est accepté que pour `tree`, `read`, `grep` et `note`. Les directives d'écriture exigent `@` (`syntax_error` sinon).
4. **Faute de frappe** : `#@` collé à une lettre doit être une directive connue (`syntax_error` sinon). `#@ ` suivi d'un espace et `# @…` restent des commentaires.
5. **Forme canonique** : `expand`, le journal et le rapport écrivent toujours `@nom`.

## Alternatives écartées

- **Tolérer toute ligne `cd …` ou toute ligne non-directive** : cela masquerait de vraies erreurs de syntaxe. Les marqueurs délimitent explicitement la zone utile.
- **Autoriser `#@edit` et les autres écritures** : les corps de blocs (`<<<<<<< SEARCH`…) ne sont pas des commentaires pour le shell. Les coller exécuterait leurs lignes comme commandes.
- **Réserver `#@` à `--clip`** : une seule règle de lexique, valable pour toute source de script (stdin, `--file`, `--clip`), est plus simple à documenter et à tester.
- **Ignorer silencieusement `#@` suivi d'un nom inconnu** : une faute de frappe (`#@reed`) disparaîtrait sans message.

## Conséquences

- Un script collé dans un shell reste inoffensif : seules des lectures sont possibles en `#@`.
- Les scripts 1.0 existants sont compatibles. Seule différence : une ligne `#@lettre…` qui était un commentaire ignoré est désormais interprétée comme directive ou rejetée.
- `#@` interdit pour les écritures : si le besoin d'écrire par collage apparaît, il faudra une autre convention pour les blocs (par exemple un préfixe `#` sur chaque ligne de bloc).
- Les marqueurs étant tolérants, un `clip start` présent dans du texte ordinaire active le mode zone et fait ignorer le reste du script. Cette règle est documentée dans `SPEC.md` §4.1 bis.
