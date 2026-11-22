# Syntaxe v2 de fls (`@fls 2`)

À lire quand il faut **écrire** ou **corriger** un script qui répète un travail (boucle sur des fichiers, gabarit répété, étape conditionnelle). La référence exacte, à jour avec la version installée, est `fls spec` ; ce fichier donne le modèle mental, les motifs qui marchent et les pièges.

## Le modèle mental en une phrase

Un script qui commence par `@fls 2` est **étendu en un script plat ordinaire avant d'être exécuté**, en lisant le disque tel qu'il est **au départ**. Tout ce qui suit découle de là : `fls expand` montre le résultat, `--dry-run` le simule, le Journal enregistre le script plat, `undo` fonctionne comme d'habitude.

## Ce qu'on peut écrire

```
@fls 2
@let ext = ".ts"                                  # variable
@for f in glob("src/**/*.ts")                     # boucle (liste ou clés d'un dictionnaire)
@if exists(f + ".bak")                         # condition : @if / @elif / @else / @end
@note "{{ f }}"                                   # {{ expr }} dans un argument
@end
@end
@def composant(nom, props)                        # macro, au premier niveau seulement
@create src/{{ nom }}.tsx
<<<<<<< TEMPLATE                                  # bloc INTERPOLÉ (sinon littéral)
export const {{ nom }} = () => <div style=\{{ margin: 0 }} />   # \{{ = {{ littéral
>>>>>>> END
@end
@call composant("Button", [])                     # émet la macro
```

- `@end` ferme la construction ouverte la plus proche ; l'indentation ne compte pas.
- Modifier un fichier avec un SEARCH/REPLACE paramétré : `<<<<<<< SEARCH TEMPLATE` ouvre un hunk dont le SEARCH **et** le REPLACE sont interpolés. Les hunks `<<<<<<< SEARCH` voisins restent littéraux.
- Variables de la ligne de commande : `fls --file s.fls --set nom=Ada` (toujours du texte ; `int("3")` convertit).
- `#@` : les lignes de contrôle y sont permises (`#@fls 2`, `#@for`), les écritures non.

## Expressions

Textes `"…"`/`'…'`, entiers, `True`/`False`, listes, dictionnaires ; `+ - * // %`, comparaisons, `and or not`, `in`, `x[i]`, `a if c else b`. Pas de flottants, de méthodes (`upper(x)`, jamais `x.upper()`), de lambda, de compréhension.

Fonctions (lecture seule) : `glob exists is_file is_dir read lines len range sorted join split replace upper lower capitalize strip startswith endswith basename dirname stem int str`. `capitalize` ne change que la première lettre (`buttonGroup` → `ButtonGroup`). `glob("src/**/*.ts")` inclut `src/a.ts` (le `**/` accepte zéro dossier), est trié, et applique `.gitignore` / `.flsignore`.

## Pièges fréquents (et la parade)

| Piège | Pourquoi | Parade |
|---|---|---|
| `@if exists("x")` après un `@create x` voit « absent » | l'expansion lit le disque **initial**, pas l'état simulé | décider avant ; constater après avec `@expect_exists` |
| `@if exists("{{ f }}.bak")` ne trouve jamais rien | `{{ }}` n'existe que dans les arguments et les blocs `TEMPLATE` ; une ligne de contrôle est déjà une expression | `@if exists(f + ".bak")` |
| `{{ ma_liste }}` donne `expansion_error` | une interpolation n'accepte qu'un texte ou un entier | `join(ma_liste, ", ")` ou une boucle |
| `{{ x }}` dans un bloc `CONTENT` reste `{{ x }}` | les blocs sont **littéraux** par défaut | ouvrir le bloc par `<<<<<<< TEMPLATE` |
| `{{` voulu littéral dans un bloc `TEMPLATE` ou un argument | il serait interpolé | écrire `\{{` |
| un mot `{{ v }}` valant `--lines` n'est pas une option | une valeur calculée ne fabrique jamais d'option | écrire l'option en dur : `--lines {{ n }}` |
| `@def` dans une boucle ou un `@if` | refusé (`syntax_error`) | `@def` au premier niveau, avant les appels |
| une macro qui s'appelle, ou appelle une macro plus bas | pas de récursion | n'appeler que des macros définies plus haut |
| « plus de 2000 directives émises » | plafond contre les explosions | réduire la boucle, ou `--max-expanded N` |
| texte sur plusieurs lignes dans `@expect_contains` | une directive tient sur une ligne | `--regex` avec `\s` / `\n`, ou un bloc `TEMPLATE` plus tard |
| un `@fls 2` oublié | sans lui, `{{ }}` et `@for` ne veulent rien dire | première ligne utile : `@fls 2` |

## Méthode de travail conseillée

1. Écrire le script, **`fls expand --file s.fls`** : relire le script plat (c'est exactement ce qui sera exécuté).
2. `fls --dry-run --file s.fls` : relire le rapport (`Modifierait : …`).
3. Exécuter, puis `fls undo` si le résultat ne convient pas.
4. Une erreur d'expansion sort en code **2** et n'exécute **rien** : le message donne la ligne du script source (et, dans une macro, `dans la macro m, appelée ligne N`).
