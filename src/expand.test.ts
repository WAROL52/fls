// Syntaxe v2 (`@fls 2`) : expressions, fonctions intégrées, interpolation, expansion en Script plat.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { callBuiltin } from "./expand/builtins.ts";
import { expandScript, isV2 } from "./expand/expand.ts";
import { evaluate, parseExpression } from "./expand/expr.ts";
import type { Value } from "./expand/values.ts";
import { compileIgnore } from "./paths.ts";
import { parseScript, serialize } from "./script.ts";
import { runFls, sandbox, type Files } from "./testing/io.ts";
import { Workspace } from "./workspace.ts";

// ───────────────────────────── Aides ─────────────────────────────

const env = (files: Files = {}, o: { vars?: Record<string, string>; max?: number } = {}) => {
  const dir = sandbox(files);
  const ws = new Workspace(dir, 1e6);
  return { ws, ignore: compileIgnore([".git/", "node_modules/"]), vars: o.vars ?? {}, maxExpanded: o.max ?? 2000, dir };
};

/** Le Script plat d'un script v2. */
const flat = (script: string, files: Files = {}, o: Parameters<typeof env>[1] = {}): string => serialize(expandScript(`@fls 2\n${script}`, env(files, o)));

function code(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (e) {
    return { code: (e as { code: string }).code, message: (e as Error).message };
  }
  return { code: "", message: "" };
}

const fails = (script: string, files: Files = {}, o: Parameters<typeof env>[1] = {}) => code(() => flat(script, files, o));

/** Valeur d'une expression, avec quelques variables et le disque d'un dossier de test. */
function val(src: string, vars: Record<string, Value> = {}, files: Files = {}): Value {
  const e = env(files);
  return evaluate(parseExpression(src), {
    get: (n) => {
      if (!(n in vars)) throw new Error(`pas de ${n}`);
      return vars[n];
    },
    call: (n, a) => callBuiltin(n, a, e),
  });
}
const valErr = (src: string, vars: Record<string, Value> = {}, files: Files = {}) => code(() => val(src, vars, files));
const synErr = (src: string) => code(() => parseExpression(src));

// ───────────────────────────── Expressions ─────────────────────────────

describe("expressions : valeurs et opérateurs", () => {
  it("littéraux", () => {
    expect(val("42")).toBe(42);
    expect(val('"a\\nb\\t\\\\ \\"q\\" \\\'s\\\'"')).toBe("a\nb\t\\ \"q\" 's'");
    expect(val("'x'")).toBe("x");
    expect(val("True")).toBe(true);
    expect(val("False")).toBe(false);
    expect(val("[1, 2, 3,]")).toEqual([1, 2, 3]);
    expect(val("[]")).toEqual([]);
    expect(val('{"a": 1, 2: "b",}')).toEqual(
      new Map<string | number, Value>([
        ["a", 1],
        [2, "b"],
      ]),
    );
    expect(val("{}")).toEqual(new Map());
    expect(val("(1 + 2) * 3")).toBe(9);
  });

  it("arithmétique entière, à la Python pour // et %", () => {
    expect(val("1 + 2 * 3")).toBe(7);
    expect(val("10 - 4 - 3")).toBe(3);
    expect(val("7 // 2")).toBe(3);
    expect(val("-7 // 2")).toBe(-4);
    expect(val("7 % 3")).toBe(1);
    expect(val("-7 % 3")).toBe(2);
    expect(val("--4")).toBe(4);
    expect(val("x * 2", { x: 4 })).toBe(8);
  });

  it("texte et listes : + et *", () => {
    expect(val('"a" + "b"')).toBe("ab");
    expect(val("[1] + [2]")).toEqual([1, 2]);
    expect(val('"ab" * 2')).toBe("abab");
    expect(val('2 * "ab"')).toBe("abab");
  });

  it("comparaisons, égalité profonde", () => {
    expect(val("1 < 2")).toBe(true);
    expect(val("2 <= 2")).toBe(true);
    expect(val("3 > 4")).toBe(false);
    expect(val("4 > 3")).toBe(true);
    expect(val("3 >= 4")).toBe(false);
    expect(val('"a" < "b"')).toBe(true);
    expect(val("1 == 1")).toBe(true);
    expect(val("1 != 1")).toBe(false);
    expect(val("[1, [2]] == [1, [2]]")).toBe(true);
    expect(val("[1] == [1, 2]")).toBe(false);
    expect(val('{"a": 1} == {"a": 1}')).toBe(true);
    expect(val('{"a": 1} == {"a": 2}')).toBe(false);
    expect(val('{"a": 1} == {"b": 1}')).toBe(false);
    expect(val('{"a": 1} == {"a": 1, "b": 2}')).toBe(false);
    expect(val('1 == "1"')).toBe(false);
    expect(val("1 == True")).toBe(false);
    expect(val("2 == 2 and 3 == 3")).toBe(true);
  });

  it("in et not in : texte, liste, dictionnaire", () => {
    expect(val('"at" in "cat"')).toBe(true);
    expect(val('"z" not in "cat"')).toBe(true);
    expect(val("1 in [1, 2]")).toBe(true);
    expect(val("3 not in [1, 2]")).toBe(true);
    expect(val('"k" in {"k": 1}')).toBe(true);
    expect(val("1 in {1: 2}")).toBe(true);
    expect(val("1 in {2: 2}")).toBe(false);
    expect(val("not 1 in [2]")).toBe(true);
  });

  it("and, or, not, a if c else b (valeurs façon Python)", () => {
    expect(val('0 or "défaut"')).toBe("défaut");
    expect(val('"x" or "défaut"')).toBe("x");
    expect(val('"" and 1')).toBe("");
    expect(val("1 and 2")).toBe(2);
    expect(val("not []")).toBe(true);
    expect(val("not [0]")).toBe(false);
    expect(val("not {}")).toBe(true);
    expect(val('not {"a": 1}')).toBe(false);
    expect(val("not 0")).toBe(true);
    expect(val('not ""')).toBe(true);
    expect(val('"a" if 1 else "b"')).toBe("a");
    expect(val('"a" if 0 else "b" if 0 else "c"')).toBe("c");
  });

  it("indices : texte, liste (négatifs permis), dictionnaire", () => {
    expect(val('"abc"[1]')).toBe("b");
    expect(val('"abc"[-1]')).toBe("c");
    expect(val("[1, 2, 3][0]")).toBe(1);
    expect(val('{"a": 1}["a"]')).toBe(1);
    expect(val("{1: 2}[1]")).toBe(2);
    expect(val("[[1, 2], [3]][0][1]")).toBe(2);
  });

  it("variables et fonctions intégrées", () => {
    expect(val("len(xs)", { xs: [1, 2] })).toBe(2);
    expect(valErr("zz", {}).message).toContain("pas de zz");
  });
});

describe("expressions : erreurs", () => {
  it("analyse : syntax_error sans numéro de ligne", () => {
    for (const src of ["1 +", "(1", "1 2", "$", "1.5", "'abc", '"a\\q"', '"a\\', "if", "x if y", "a and", "in", "f(1,", "{1}", "[1,2", ")", "not in 3", "}", "1 )"]) {
      expect(synErr(src).code, src).toBe("syntax_error");
    }
    expect(synErr("1.5").message).toContain("décimaux");
    expect(synErr("in").message).toContain("mot réservé");
    expect(synErr("x" + " + 1".repeat(1000)).message).toContain("trop longue");
    expect(synErr("(".repeat(70) + "1" + ")".repeat(70)).message).toContain("trop imbriquée");
    expect(synErr("99999999999999999999").message).toContain("entier trop grand");
    expect(synErr("").message).toContain("incomplète");
  });

  it("évaluation : expansion_error", () => {
    const cases: Array<[string, string]> = [
      ['"a" + 1', "ne s'applique pas à texte et entier"],
      ['1 - "a"', "ne s'applique pas"],
      ["1 // 0", "division par zéro"],
      ["1 % 0", "division par zéro"],
      ['"a" * -1', "répétition"],
      ['"a" * 2000000', "répétition"],
      ['-"x"', "un entier est attendu"],
      ["9007199254740991 + 1", "entier trop grand"],
      ["99999999999 * 99999999999", "entier trop grand"],
      ['1 < "a"', "ne s'applique pas"],
      ["1 in 5", "ne s'applique pas"],
      ["1 in \"x\"", "un texte ne se cherche que dans un texte"],
      ['True in {"a": 1}', "ne s'applique pas"],
      ["[1] * 2", "ne s'applique pas"],
      ["{[1]: 2}", "clé de dictionnaire"],
      ['{"a": 1}["z"]', "clé absente"],
      ["{1: 2}[True]", "clé absente"],
      ["[1][5]", "hors limites"],
      ["[1][-2]", "hors limites"],
      ["5[0]", "ne s'applique pas à entier"],
      ['"abc"["x"]', "doit être un entier"],
      ["nope(1)", "fonction inconnue"],
    ];
    for (const [src, msg] of cases) {
      const e = valErr(src);
      expect(e.code, src).toBe("expansion_error");
      expect(e.message, src).toContain(msg);
    }
  });

  it("le texte ne peut pas exploser en taille", () => {
    expect(valErr('("a" * 600000) + ("a" * 600000)').message).toContain("texte trop long");
    expect(valErr('split("a" * 10001, "b")', {}).code).toBe("");
    expect(valErr('split("a" * 10001, "a")').message).toContain("liste trop longue");
    expect(valErr('(range(9000) + range(9000))').message).toContain("liste trop longue");
  });
});

// ───────────────────────────── Fonctions intégrées ─────────────────────────────

describe("fonctions intégrées", () => {
  const files: Files = { "src/a.ts": "1\n2\n", "src/x/y.ts": "y\n", "src/x/z.js": "z", "b.txt": "b", "src/.hid/c.ts": "c", "node_modules/m/i.ts": "m" };

  it("glob : `**` accepte zéro dossier, tri, sans dossiers ni ignorés", () => {
    expect(val('glob("src/**/*.ts")', {}, files)).toEqual(["src/.hid/c.ts", "src/a.ts", "src/x/y.ts"]);
    expect(val('glob("**/*.ts")', {}, files)).toEqual(["src/.hid/c.ts", "src/a.ts", "src/x/y.ts"]);
    expect(val('glob("*.txt")', {}, files)).toEqual(["b.txt"]);
    expect(val('glob("./b.t?t")', {}, files)).toEqual(["b.txt"]);
    expect(val('glob("src/**")', {}, files)).toHaveLength(4);
    expect(val('glob("src")', {}, files)).toEqual([]);
    expect(val('glob("src/a.ts")', {}, files)).toEqual(["src/a.ts"]);
    expect(val('glob("nope/*")', {}, files)).toEqual([]);
  });

  it("glob : refuse un motif hors du dossier ; ne liste pas les liens", () => {
    expect(valErr('glob("../*")').message).toContain("hors du dossier courant");
    expect(valErr('glob("/etc/*")').message).toContain("hors du dossier courant");
    expect(valErr('glob("a/../../x")').message).toContain("hors du dossier courant");
    const e = env({ "a.txt": "a" });
    fs.symlinkSync("a.txt", path.join(e.dir, "l.txt"));
    expect(callBuiltin("glob", ["*.txt"], e)).toEqual(["a.txt"]);
  });

  it("exists, is_file, is_dir, read, lines", () => {
    expect(val('exists("b.txt")', {}, files)).toBe(true);
    expect(val('exists("src")', {}, files)).toBe(true);
    expect(val('exists("nope")', {}, files)).toBe(false);
    expect(val('is_file("b.txt")', {}, files)).toBe(true);
    expect(val('is_file("src")', {}, files)).toBe(false);
    expect(val('is_dir("src")', {}, files)).toBe(true);
    expect(val('is_dir("b.txt")', {}, files)).toBe(false);
    expect(val('read("b.txt")', {}, files)).toBe("b");
    expect(val('lines("src/a.ts")', {}, files)).toEqual(["1", "2"]);
    expect(valErr('exists("../x")').code).toBe("outside_workspace");
    expect(valErr('read("nope")').code).toBe("not_found");
    expect(valErr('read("b")', {}, { b: Buffer.from([0, 1]) }).code).toBe("binary_file");
  });

  it("len, range, sorted", () => {
    expect(val('len("abc")')).toBe(3);
    expect(val("len([1, 2])")).toBe(2);
    expect(val('len({"a": 1})')).toBe(1);
    expect(valErr("len(1)").message).toContain("len : un texte, une liste ou un dictionnaire");
    expect(val("range(3)")).toEqual([0, 1, 2]);
    expect(val("range(2, 5)")).toEqual([2, 3, 4]);
    expect(val("range(5, 2)")).toEqual([]);
    expect(valErr("range(20000)").message).toContain("range : plus de");
    expect(valErr("range(1, 2, 3)").message).toContain("attend 1 ou 2 argument(s), reçu 3");
    expect(valErr("range()").message).toContain("attend 1 ou 2 argument(s), reçu 0");
    expect(valErr('range("a")').message).toContain("l'argument 1 doit être de type entier (reçu : texte)");
    expect(val('sorted(["b", "a", "c"])')).toEqual(["a", "b", "c"]);
    expect(val("sorted([10, 9, 100])")).toEqual([9, 10, 100]);
    expect(val("sorted([])")).toEqual([]);
    expect(valErr('sorted([1, "a"])').message).toContain("sorted");
    expect(valErr("len(1, 2)").message).toContain("attend 1 argument(s), reçu 2");
  });

  it("join, split, replace", () => {
    expect(val('join(["a", "b"], ", ")')).toBe("a, b");
    expect(valErr("join([1], \",\")").message).toContain("une liste de textes");
    expect(valErr('join(["a" * 600000, "b" * 600000], "")').message).toContain("texte trop long");
    expect(val('split("a,b,c", ",")')).toEqual(["a", "b", "c"]);
    expect(valErr('split("a", "")').message).toContain("séparateur est vide");
    expect(val('replace("aXbX", "X", "-")')).toBe("a-b-");
    expect(valErr('replace("a", "", "-")').message).toContain("texte à remplacer est vide");
  });

  it("textes : upper, lower, capitalize, strip, startswith, endswith", () => {
    expect(val('upper("aé")')).toBe("AÉ");
    expect(val('lower("AB")')).toBe("ab");
    expect(val('capitalize("buttonGroup")')).toBe("ButtonGroup");
    expect(val('capitalize("")')).toBe("");
    expect(val('strip("  a b \\n")')).toBe("a b");
    expect(val('startswith("abc", "ab")')).toBe(true);
    expect(val('startswith("abc", "bc")')).toBe(false);
    expect(val('endswith("abc", "bc")')).toBe(true);
  });

  it("chemins : basename, dirname, stem", () => {
    expect(val('basename("a/b.test.ts")')).toBe("b.test.ts");
    expect(val('dirname("a/b/c.ts")')).toBe("a/b");
    expect(val('dirname("c.ts")')).toBe("");
    expect(val('stem("a/b.test.ts")')).toBe("b.test");
    expect(val('stem("Makefile")')).toBe("Makefile");
    expect(val('stem(".gitignore")')).toBe(".gitignore");
  });

  it("int et str", () => {
    expect(val('int("12")')).toBe(12);
    expect(val('int("-3")')).toBe(-3);
    expect(val("int(5)")).toBe(5);
    expect(val("int(True)")).toBe(1);
    expect(val("int(False)")).toBe(0);
    expect(valErr('int("x")').message).toContain('impossible de convertir "x" en entier');
    expect(valErr("int([1])").message).toContain("impossible de convertir liste en entier");
    expect(valErr('int("99999999999999999999")').message).toContain("entier trop grand");
    expect(val("str(5)")).toBe("5");
    expect(val("str(True)")).toBe("True");
    expect(val("str(False)")).toBe("False");
    expect(val('str("a")')).toBe("a");
    expect(valErr("str([1])").message).toContain("str : un texte, un entier ou un booléen");
  });
});

// ───────────────────────────── Interpolation ─────────────────────────────

describe("interpolation dans les arguments", () => {
  it("{{ }} est une unité (ses espaces ne coupent pas le mot) et se mêle au texte", () => {
    expect(flat('@note {{ "a" + "b" }}\n@note x{{ 1 + 1 }}y\n@note "a {{ upper("b") }} c"')).toBe('@note ab\n\n@note x2y\n\n@note "a B c"\n');
  });

  it("valeurs d'option et plages", () => {
    expect(flat("@let n = 3\n@read f.txt --lines 1-{{ n }}\n@grep x . --context {{ n }}")).toBe("@read f.txt --lines 1-3\n\n@grep x . --context 3\n");
  });

  it("guillemets, \\\" et \\\\ comme en v1, mot guillemeté vide, mots collés", () => {
    expect(flat('@note "a \\"q\\" \\\\"\n@note ""\n@move "a"b')).toBe('@note "a \\"q\\" \\\\"\n\n@note ""\n\n@move a b\n');
  });

  it("accolades dans l'expression : dictionnaires, textes contenant }}, \\{{ littéral", () => {
    expect(flat('@note {{ {"a": {"b": 7}}["a"]["b"] }}')).toBe("@note 7\n");
    expect(flat('@note {{ "}}" }}')).toBe("@note }}\n");
    expect(flat('@note {{ "a\\"}}" }}')).toBe('@note "a\\"}}"\n');
    expect(flat('@note "\\{{ x }}"')).toBe('@note "{{ x }}"\n');
    expect(flat('@note "\\{{ x }} {{ 1 }}"')).toBe('@note "{{ x }} 1"\n');
  });

  it("seuls un texte ou un entier s'interpolent", () => {
    expect(fails("@note {{ [1] }}").message).toContain("{{ }} attend un texte ou un entier (reçu : liste)");
    expect(fails("@note {{ True }}").message).toContain("reçu : booléen");
  });

  it("un mot interpolé n'est jamais une option", () => {
    const [op] = expandScript('@fls 2\n@let v = "--lines"\n@read {{ v }}', env());
    expect(op.args).toEqual(["--lines"]);
    expect(op.opts).toEqual({});
  });

  it("erreurs d'analyse : {{ non fermé, guillemet non fermé, expression invalide", () => {
    expect(fails("@note {{ 1").message).toContain("« {{ » sans « }} » correspondant");
    expect(fails('@note "abc').message).toContain("guillemet non fermé");
    expect(fails("@note {{ 1 + }}").message).toMatch(/^ligne 2 : /);
    expect(fails("@note {{ } }}").code).toBe("syntax_error");
    expect(fails("@note {{ 'a }}").code).toBe("syntax_error");
  });
});

describe("blocs : littéraux sauf TEMPLATE", () => {
  it("un bloc CONTENT ou SEARCH/REPLACE garde ses {{ }} et ses lignes @for", () => {
    const script = "@create a.tsx\n<<<<<<< CONTENT\n<div style={{ a: 1 }}>\n@for x in y\n@end\n>>>>>>> END\n@edit b.txt\n<<<<<<< SEARCH\n{{ vieux }}\n=======\n{{ neuf }}\n>>>>>>> REPLACE\n";
    expect(flat(script)).toBe(script.replace("@edit", "\n@edit"));
  });

  it("<<<<<<< TEMPLATE interpole un contenu ; \\{{ y reste littéral", () => {
    const out = flat('@let n = "Card"\n@create {{ n }}.tsx\n<<<<<<< TEMPLATE\nexport const {{ n }} = <div style=\\{{ a: 1 }}>{{ upper(n) }}</div>\n>>>>>>> END');
    expect(out).toBe("@create Card.tsx\n<<<<<<< CONTENT\nexport const Card = <div style={{ a: 1 }}>CARD</div>\n>>>>>>> END\n");
  });

  it("<<<<<<< SEARCH TEMPLATE interpole SEARCH et REPLACE de ce bloc seulement", () => {
    const out = flat(
      '@let a = "ancien"\n@let b = "nouveau"\n@edit f.txt\n<<<<<<< SEARCH TEMPLATE\n{{ a }}\n=======\n{{ b }}\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n{{ a }}\n=======\n{{ b }}\n>>>>>>> REPLACE',
    );
    expect(out).toBe("@edit f.txt\n<<<<<<< SEARCH\nancien\n=======\nnouveau\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n{{ a }}\n=======\n{{ b }}\n>>>>>>> REPLACE\n");
  });

  it("SEARCH vide après interpolation, expression invalide dans un bloc", () => {
    expect(fails('@edit f.txt\n<<<<<<< SEARCH TEMPLATE\n{{ "" }}\n=======\nx\n>>>>>>> REPLACE').message).toContain("SEARCH vide après interpolation");
    expect(fails("@create f\n<<<<<<< TEMPLATE\n{{ 1 + }}\n>>>>>>> END").message).toMatch(/^ligne 2 : /);
    expect(fails('@edit f.txt\n<<<<<<< SEARCH TEMPLATE\n{{ 1 + }}\n=======\nx\n>>>>>>> REPLACE').code).toBe("syntax_error");
  });

  it("les marqueurs TEMPLATE n'existent pas en syntaxe v1", async () => {
    const dir = sandbox({});
    const a = await runFls(dir, [], { stdin: "@create f\n<<<<<<< TEMPLATE\nx\n>>>>>>> END\n" });
    expect(a.errText).toContain("@create attend un bloc <<<<<<< CONTENT");
    const b = await runFls(dir, [], { stdin: "@edit f\n<<<<<<< SEARCH TEMPLATE\nx\n=======\ny\n>>>>>>> REPLACE\n" });
    expect(b.errText).toContain("@edit attend un bloc <<<<<<< SEARCH");
  });
});

// ───────────────────────────── Pragma ─────────────────────────────

describe("@fls 2", () => {
  it("sans pragma, un script v1 reste littéral : {{ n'est pas une interpolation", async () => {
    expect(isV2("@grep \"{{\" src\n")).toBe(false);
    expect(isV2("# commentaire\n\n@read a\n")).toBe(false);
    const r = await runFls(sandbox({ "a.txt": "x {{ y }}\n" }), [], { stdin: '@grep "{{" .\n' });
    expect(r.code).toBe(0);
    expect(r.text).toContain("x {{ y }}");
  });

  it("première ligne utile, après commentaires ; forme #@ ; zone clip", () => {
    expect(isV2("# note\n\n@fls 2\n")).toBe(true);
    expect(isV2("#@fls 2\n")).toBe(true);
    expect(isV2("##### clip start #####\n#@fls 2\n##### clip end #####\n")).toBe(true);
    expect(isV2("bruit\n##### clip start #####\n@fls 2\n##### clip end #####\n")).toBe(true);
  });

  it("autre version, ou rien : syntax_error ; @fls ailleurs qu'en tête : refusé", () => {
    expect(code(() => isV2("@fls 3\n")).message).toContain("reçu : 3");
    expect(code(() => isV2("@fls\n")).message).toContain("reçu : rien");
    expect(code(() => isV2("@fls 2 3\n")).message).toContain("reçu : 2 3");
    expect(fails("@fls 2").message).toContain("@fls doit être la première ligne");
    expect(code(() => parseScript("@read a\n@fls 2\n")).message).toContain("directive inconnue @fls");
  });
});

// ───────────────────────────── Contrôle ─────────────────────────────

describe("variables, boucles, conditions", () => {
  it("@let, @for sur liste et sur clés de dictionnaire, imbrication, variable de boucle conservée", () => {
    expect(flat('@let xs = ["a", "b"]\n@for x in xs\n@for i in range(2)\n@note {{ x }}{{ i }}\n@end\n@end\n@note "fin {{ x }}{{ i }}"')).toBe(
      '@note a0\n\n@note a1\n\n@note b0\n\n@note b1\n\n@note "fin b1"\n',
    );
    expect(flat('@for k in {"z": 1, "y": 2}\n@note {{ k }}\n@end')).toBe("@note z\n\n@note y\n");
    expect(flat("@let n = 1\n@let n = n + 1\n@note {{ n }}")).toBe("@note 2\n");
    expect(flat("@let a = 1 == 1\n@note {{ int(a) }}")).toBe("@note 1\n");
  });

  it("@if, @elif, @else", () => {
    const f = (v: number): string => flat(`@let v = ${v}\n@if v == 1\n@note un\n@elif v == 2\n@note deux\n@else\n@note autre\n@end`);
    expect(f(1)).toBe("@note un\n");
    expect(f(2)).toBe("@note deux\n");
    expect(f(3)).toBe("@note autre\n");
    expect(flat("@if 0\n@note x\n@end\n@note fin")).toBe("@note fin\n");
    expect(flat("@if 0\n@note x\n@else\n@note y\n@end")).toBe("@note y\n");
  });

  it("les lignes de contrôle ne laissent aucune trace dans le script plat ; commentaires et lignes vides permis", () => {
    expect(flat("# commentaire\n\n@let x = 1\n  @if x\n  # encore\n  @note ok\n  @end")).toBe("@note ok\n");
  });

  it("--set définit des variables de texte ; une macro voit les variables globales", () => {
    expect(flat("@note {{ nom }}", {}, { vars: { nom: "Ada" } })).toBe("@note Ada\n");
    expect(flat('@let ext = ".ts"\n@def f(n)\n@note {{ n }}{{ ext }}\n@end\n@call f("a")')).toBe("@note a.ts\n");
  });

  it("erreurs d'exécution : variable inconnue, @for sur autre chose qu'une liste", () => {
    expect(fails("@note {{ nope }}").message).toBe("ligne 2 : variable inconnue : nope");
    expect(fails('@for x in "abc"\n@end').message).toContain("@for parcourt une liste ou un dictionnaire");
    expect(fails("@for x in 3\n@end").message).toContain("@for parcourt");
    expect(fails("@for x in True\n@end").message).toContain("@for parcourt");
    expect(fails("@let x = 1 // 0").message).toBe("ligne 2 : « // » : division par zéro");
    expect(fails("@if 1 // 0\n@end").code).toBe("expansion_error");
  });

  it("erreurs de lecture : le code d'origine est rappelé", () => {
    expect(fails('@let t = read("nope.txt")').message).toBe("ligne 2 : introuvable : nope.txt (not_found)");
  });
});

describe("macros", () => {
  const def = "@def comp(nom, ext)\n@create src/{{ nom }}.{{ ext }}\n<<<<<<< TEMPLATE\n// {{ nom }}\n>>>>>>> END\n@end\n";

  it("@def puis @call émettent les directives de la macro", () => {
    expect(flat(`${def}@call comp("A", "ts")\n@call comp("B", "js")`)).toBe(
      "@create src/A.ts\n<<<<<<< CONTENT\n// A\n>>>>>>> END\n\n@create src/B.js\n<<<<<<< CONTENT\n// B\n>>>>>>> END\n",
    );
    expect(flat("@def vide()\n@note x\n@end\n@call vide()")).toBe("@note x\n");
  });

  it("variables locales : les paramètres masquent les globales, les @let d'une macro ne fuient pas", () => {
    expect(flat('@let n = "global"\n@def f(n)\n@let m = n\n@note {{ m }}\n@end\n@call f("param")\n@note {{ n }}')).toBe("@note param\n\n@note global\n");
    expect(fails('@def f()\n@let m = 1\n@end\n@call f()\n@note {{ m }}').message).toContain("variable inconnue : m");
  });

  it("une macro peut appeler une macro définie plus haut, dans une boucle ou une condition", () => {
    const script = "@def a()\n@note a\n@end\n@def b()\n@for i in range(2)\n@if i == 1\n@call a()\n@end\n@end\n@end\n@call b()";
    expect(flat(script)).toBe("@note a\n");
  });

  it("pas de récursion : appel d'une macro inconnue ou définie plus bas", () => {
    expect(fails("@def f()\n@call f()\n@end").message).toContain("pas de récursion");
    expect(fails("@def f()\n@call g()\n@end\n@def g()\n@note x\n@end").message).toContain("g, inconnue ou définie plus bas");
    expect(fails("@def f()\n@for i in range(1)\n@call f()\n@end\n@end").message).toContain("pas de récursion");
    expect(fails("@def f()\n@if 1\n@call f()\n@end\n@end").message).toContain("pas de récursion");
  });

  it("erreurs d'appel : macro inconnue, nombre d'arguments, redéfinition", () => {
    expect(fails("@call nope()").message).toBe("ligne 2 : macro inconnue : nope");
    expect(fails(`${def}@call comp("A")`).message).toContain("comp attend 2 argument(s), reçu 1");
    expect(fails("@def f()\n@end\n@def f()\n@end").message).toContain("la macro f est déjà définie");
  });

  it("une erreur dans une macro indique la chaîne d'appel", () => {
    const e = fails("@def a(x)\n@let y = 1 // x\n@end\n@def b()\n@call a(0)\n@end\n@call b()");
    expect(e.message).toBe("ligne 3 : « // » : division par zéro (dans la macro a, appelée ligne 6) (dans la macro b, appelée ligne 8)");
  });
});

describe("structure du script source : syntax_error", () => {
  it("constructions mal formées", () => {
    const cases: Array<[string, string]> = [
      ["@end", "@end sans @if, @for ou @def ouvert"],
      ["@else", "@else sans @if"],
      ["@elif 1", "@elif sans @if"],
      ["@for x in [1]\n@note a", "@for sans @end"],
      ["@if 1\n@note a", "@if sans @end"],
      ["@if 1\n@else\n@note a", "@if sans @end"],
      ["@def f()\n@note a", "@def sans @end"],
      ["@if 1\n@else\n@elif 1\n@end", "@elif sans @if"],
      ["@if 1\n@end x\n", "@end n'attend rien après lui"],
      ["@if 1\n@else x\n@end", "@else n'attend rien après lui"],
      ["@if", "@if attend une condition"],
      ["@if 1\n@elif\n@end", "@elif attend une condition"],
      ["@if 1 +\n@end", "expression incomplète"],
      ["@if 1\n@elif 2 +\n@end", "expression incomplète"],
      ["@let x", "@let attend : @let nom = expression"],
      ["@let x == 1", "@let attend"],
      ["@let in = 1", 'nom de variable invalide : "in"'],
      ["@for x of y\n@end", "@for attend : @for nom in expression"],
      ["@for True in [1]\n@end", "nom de variable invalide"],
      ["@for x in [1\n@end", "« ] » attendu"],
      ["@def f(x\n@end", "@def attend : @def nom(paramètre, …)"],
      ["@def f(1)\n@end", "nom de paramètre invalide"],
      ["@def f(a, a)\n@end", "paramètre en double"],
      ["@def f()\n@def g()\n@end\n@end", "@def n'est permis qu'au premier niveau"],
      ["@if 1\n@def f()\n@end\n@end", "@def n'est permis qu'au premier niveau"],
      ["@def in()\n@end", 'nom de macro invalide : "in"'],
      ["@call x", "@call attend : @call macro(arguments)"],
      ["@call f(1 +)", "ligne 2"],
      ["@nope a", "directive inconnue @nope"],
      ["@ a", "nom de directive attendu après @"],
      ["du texte", "ligne inattendue"],
    ];
    for (const [script, msg] of cases) {
      const e = fails(script);
      expect(e.code, script).toBe("syntax_error");
      expect(e.message, script).toContain(msg);
    }
  });

  it("arité d'une directive émise : erreur v1 avec la ligne du source", () => {
    expect(fails("@read").message).toBe("ligne 2 : @read attend entre 1 et 2 argument(s), reçu 0");
    expect(fails("@read a --nope").message).toContain("option inconnue --nope");
  });

  it("imbrication limitée", () => {
    const deep = "@if 1\n".repeat(60) + "@note x\n" + "@end\n".repeat(60);
    expect(fails(deep).message).toContain("constructions trop imbriquées");
  });
});

describe("forme #@ sous @fls 2", () => {
  it("les lignes de contrôle et les lectures y sont permises", () => {
    expect(flat("#@let n = 2\n#@for i in range(n)\n#@read f{{ i }}.txt\n#@end")).toBe("@read f0.txt\n\n@read f1.txt\n");
    expect(flat("#@def m()\n#@note x\n#@end\n#@call m()")).toBe("@note x\n");
  });

  it("les écritures sont refusées, y compris celles qu'émet une macro appelée par #@call", () => {
    expect(fails("#@write f").message).toContain("les directives d'écriture exigent la forme @write");
    expect(fails("#@nope f").message).toContain("directive inconnue @nope");
    const def = "@def w()\n@write f\n<<<<<<< CONTENT\nx\n>>>>>>> END\n@end\n";
    expect(flat(`${def}@call w()`)).toContain("@write f");
    const e = fails(`${def}#@call w()`);
    expect(e.code).toBe("expansion_error");
    expect(e.message).toContain("@write écrit : refusé sous #@call");
    expect(flat(`@def r()\n@note x\n@end\n#@call r()\n@call r()`)).toBe("@note x\n\n@note x\n");
  });
});

describe("plafonds", () => {
  it("--max-expanded : trop de directives émises", () => {
    expect(fails("@for i in range(5)\n@note {{ i }}\n@end", {}, { max: 3 }).message).toContain("plus de 3 directives émises (--max-expanded");
    expect(flat("@for i in range(3)\n@note {{ i }}\n@end", {}, { max: 3 })).toContain("@note 2");
  });

  it("un script qui boucle sans rien émettre est arrêté", () => {
    const e = fails("@for a in range(10000)\n@for b in range(10000)\n@let x = a + b\n@end\n@end");
    expect(e.code).toBe("expansion_error");
    expect(e.message).toContain("dépasse 200000 étapes");
  });
});

// ───────────────────────────── En ligne de commande ─────────────────────────────

describe("fls : script @fls 2", () => {
  it("fls expand affiche le script plat ; le journal l'enregistre ; le rapport est celui du plat", async () => {
    const dir = sandbox({ "a.txt": "un\n" });
    const script = '@fls 2\n@for n in ["x", "y"]\n@create {{ n }}.txt\n<<<<<<< TEMPLATE\nfichier {{ n }}\n>>>>>>> END\n@end\n@expect_contains a.txt un --count 1\n';
    const expanded = await runFls(dir, ["expand"], { stdin: script });
    expect(expanded.code).toBe(0);
    expect(expanded.text).toBe("@create x.txt\n<<<<<<< CONTENT\nfichier x\n>>>>>>> END\n\n@create y.txt\n<<<<<<< CONTENT\nfichier y\n>>>>>>> END\n\n@expect_contains a.txt un --count 1\n");
    const r = await runFls(dir, [], { stdin: script });
    expect(r.code).toBe(0);
    expect(r.text).toContain("[1] OK    CREATE x.txt (nouveau, 1 lignes)");
    expect(r.text).toContain('[3] OK    EXPECT_CONTAINS a.txt "un" (1 occurrence(s))');
    expect(fs.readFileSync(path.join(dir, "y.txt"), "utf8")).toBe("fichier y\n");
    const log = await runFls(dir, ["log", "--run", "r1"]);
    expect(log.text).toContain("@create x.txt");
    expect(log.text).not.toContain("@for");
    expect(log.text).not.toContain("@fls");
  });

  it("--set, --max-expanded, et le même script rejoué avec une autre valeur", async () => {
    const dir = sandbox({});
    const script = "@fls 2\n@note {{ nom }}\n";
    expect((await runFls(dir, ["expand", "--set", "nom=Ada"], { stdin: script })).text).toBe("@note Ada\n");
    expect((await runFls(dir, ["expand", "--set", "nom=a=b c"], { stdin: script })).text).toBe('@note "a=b c"\n');
    expect((await runFls(dir, ["expand", "--set=nom=Bob"], { stdin: script })).text).toBe("@note Bob\n");
    expect((await runFls(dir, ["expand", "--set", "nom=x", "--set", "nom=y"], { stdin: script })).text).toBe("@note y\n");
    const loop = "@fls 2\n@for i in range(5)\n@note {{ i }}\n@end\n";
    expect((await runFls(dir, ["expand", "--max-expanded", "2"], { stdin: loop })).code).toBe(2);
    expect((await runFls(dir, ["expand", "--max-expanded", "5"], { stdin: loop })).code).toBe(0);
  });

  it("options invalides : usage_error (code 2)", async () => {
    const dir = sandbox({});
    const v2 = "@fls 2\n@note x\n";
    const bad = await runFls(dir, ["expand", "--set", "pas-un-nom"], { stdin: v2 });
    expect(bad.code).toBe(2);
    expect(bad.errText).toContain("--set attend nom=valeur");
    expect((await runFls(dir, ["expand", "--set", "1x=2"], { stdin: v2 })).code).toBe(2);
    expect((await runFls(dir, ["expand", "--max-expanded", "0"], { stdin: v2 })).code).toBe(2);
    const v1 = await runFls(dir, ["expand", "--set", "a=b"], { stdin: "@note x\n" });
    expect(v1.code).toBe(2);
    expect(v1.errText).toContain("--set et --max-expanded n'ont de sens que pour un script qui commence par @fls 2");
    expect((await runFls(dir, ["expand", "--max-expanded", "9"], { stdin: "@note x\n" })).code).toBe(2);
  });

  it("erreur d'expansion : code 2, rien n'est exécuté, message avec la ligne", async () => {
    const dir = sandbox({});
    const r = await runFls(dir, [], { stdin: "@fls 2\n@create a.txt\n<<<<<<< CONTENT\nx\n>>>>>>> END\n@let x = 1 // 0\n" });
    expect(r.code).toBe(2);
    expect(r.errText).toContain("fls : expansion_error : ligne 6 : « // » : division par zéro");
    expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(false);
    const syntax = await runFls(dir, [], { stdin: "@fls 2\n@end\n" });
    expect(syntax.code).toBe(2);
    expect(syntax.errText).toContain("syntax_error");
  });

  it("fls spec décrit la syntaxe v2 et les fonctions ; code expansion_error documenté", async () => {
    const spec = (await runFls(sandbox(), ["spec"])).text;
    expect(spec).toContain("## Syntaxe v2 (script qui commence par @fls 2)");
    expect(spec).toContain("glob(motif) -> liste");
    expect(spec).toContain("expansion_error");
    expect(spec).toContain("--max-expanded");
  });

  it("macro et glob sur un vrai dossier, avec --dry-run", async () => {
    const dir = sandbox({ "src/a.ts": "export const a = 1\n", "src/b.ts": "export const b = 2\n", "src/c.md": "# c\n" });
    const script = '@fls 2\n@def ajoute(f, nom)\n@edit {{ f }}\n<<<<<<< SEARCH TEMPLATE\nexport const {{ nom }} =\n=======\nexport const {{ nom }}: number =\n>>>>>>> REPLACE\n@end\n@for f in glob("src/**/*.ts")\n@call ajoute(f, stem(f))\n@end\n@expect_missing src/c.ts\n';
    const r = await runFls(dir, ["--dry-run"], { stdin: script });
    expect(r.code).toBe(0);
    expect(r.text).toContain("EDIT src/a.ts");
    expect(r.text).toContain("EDIT src/b.ts");
    expect(r.text).toContain("Modifierait : src/a.ts, src/b.ts");
    expect(fs.readFileSync(path.join(dir, "src/a.ts"), "utf8")).toBe("export const a = 1\n");
  });
});
