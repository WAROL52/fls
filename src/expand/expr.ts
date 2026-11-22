// Expressions de la syntaxe v2 : lexeur, analyseur et évaluateur écrits à la main (aucun `eval` :
// un script vient souvent d'un modèle). Le langage : littéraux, listes, dictionnaires, opérateurs
// façon Python, `a if c else b`, appels de fonctions intégrées. Ni lambda, ni compréhension.

import { FlsError } from "../errors.ts";
import { equal, fail, limitedList, limitedText, safeInt, truthy, typeName, type Dict, type Value } from "./values.ts";

export type Expr =
  | { k: "lit"; v: Value }
  | { k: "name"; name: string }
  | { k: "list"; items: Expr[] }
  | { k: "dict"; entries: Array<[Expr, Expr]> }
  | { k: "unary"; op: "-" | "not"; e: Expr }
  | { k: "bin"; op: string; l: Expr; r: Expr }
  | { k: "and" | "or"; l: Expr; r: Expr }
  | { k: "cond"; test: Expr; a: Expr; b: Expr }
  | { k: "index"; e: Expr; i: Expr }
  | { k: "call"; name: string; args: Expr[] };

const syn = (message: string): FlsError => new FlsError("syntax_error", message);

export const RESERVED = new Set(["and", "or", "not", "in", "if", "else", "True", "False"]);
const MAX_SOURCE = 2000;
const MAX_DEPTH = 64;

// ───────────────────────────── Lexeur ─────────────────────────────

interface Tok {
  kind: "num" | "str" | "name" | "op" | "end";
  value: string | number;
}

const OPS = ["//", "==", "!=", "<=", ">=", "+", "-", "*", "%", "<", ">", "(", ")", "[", "]", "{", "}", ",", ":"];
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", '"': '"', "'": "'" };

function lexString(src: string, start: number): { text: string; end: number } {
  const quote = src[start];
  let text = "";
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === quote) return { text, end: i + 1 };
    if (c !== "\\") {
      text += c;
      continue;
    }
    i += 1;
    if (!Object.hasOwn(ESCAPES, src[i] ?? "")) throw syn(`séquence d'échappement inconnue dans un texte : \\${src[i] ?? ""}`);
    text += ESCAPES[src[i]];
  }
  throw syn("texte non fermé");
}

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (/\d/.test(c)) {
      const digits = /^\d+/.exec(src.slice(i)) as RegExpExecArray;
      const end = i + digits[0].length;
      if (/^\.\d/.test(src.slice(end, end + 2))) throw syn("les nombres décimaux ne sont pas supportés (entiers seulement)");
      if (!Number.isSafeInteger(Number(digits[0]))) throw syn("entier trop grand");
      out.push({ kind: "num", value: Number(digits[0]) });
      i = end;
    } else if (/[A-Za-z_]/.test(c)) {
      const name = (/^\w+/.exec(src.slice(i)) as RegExpExecArray)[0];
      out.push({ kind: "name", value: name });
      i += name.length;
    } else if (c === '"' || c === "'") {
      const s = lexString(src, i);
      out.push({ kind: "str", value: s.text });
      i = s.end;
    } else {
      const op = OPS.find((o) => src.startsWith(o, i));
      if (op === undefined) throw syn(`caractère inattendu « ${c} » dans l'expression`);
      out.push({ kind: "op", value: op });
      i += op.length;
    }
  }
  out.push({ kind: "end", value: "" });
  return out;
}

// ───────────────────────────── Analyseur ─────────────────────────────

const COMPARE = new Set(["==", "!=", "<", "<=", ">", ">="]);

class Parser {
  toks: Tok[];
  pos = 0;
  depth = 0;

  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  peek(offset = 0): Tok {
    return this.toks[Math.min(this.pos + offset, this.toks.length - 1)];
  }
  isOp(v: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === "op" && t.value === v;
  }
  isKw(v: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === "name" && t.value === v;
  }
  expectOp(v: string): void {
    if (!this.isOp(v)) throw syn(`« ${v} » attendu dans l'expression`);
    this.pos += 1;
  }

  ternary(): Expr {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw syn("expression trop imbriquée");
    let e = this.or();
    if (this.isKw("if")) {
      this.pos += 1;
      const test = this.or();
      if (!this.isKw("else")) throw syn("« else » attendu après « a if condition »");
      this.pos += 1;
      e = { k: "cond", test, a: e, b: this.ternary() };
    }
    this.depth -= 1;
    return e;
  }

  or(): Expr {
    let e = this.and();
    while (this.isKw("or")) {
      this.pos += 1;
      e = { k: "or", l: e, r: this.and() };
    }
    return e;
  }

  and(): Expr {
    let e = this.not();
    while (this.isKw("and")) {
      this.pos += 1;
      e = { k: "and", l: e, r: this.not() };
    }
    return e;
  }

  not(): Expr {
    if (!this.isKw("not") || this.isKw("in", 1)) return this.compare();
    this.pos += 1;
    return { k: "unary", op: "not", e: this.not() };
  }

  compare(): Expr {
    let e = this.add();
    for (;;) {
      const t = this.peek();
      if (t.kind === "op" && COMPARE.has(t.value as string)) {
        this.pos += 1;
        e = { k: "bin", op: t.value as string, l: e, r: this.add() };
      } else if (this.isKw("in")) {
        this.pos += 1;
        e = { k: "bin", op: "in", l: e, r: this.add() };
      } else if (this.isKw("not") && this.isKw("in", 1)) {
        this.pos += 2;
        e = { k: "bin", op: "not in", l: e, r: this.add() };
      } else return e;
    }
  }

  add(): Expr {
    let e = this.mul();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.peek().value as string;
      this.pos += 1;
      e = { k: "bin", op, l: e, r: this.mul() };
    }
    return e;
  }

  mul(): Expr {
    let e = this.unary();
    while (this.isOp("*") || this.isOp("//") || this.isOp("%")) {
      const op = this.peek().value as string;
      this.pos += 1;
      e = { k: "bin", op, l: e, r: this.unary() };
    }
    return e;
  }

  unary(): Expr {
    if (!this.isOp("-")) return this.postfix();
    this.pos += 1;
    return { k: "unary", op: "-", e: this.unary() };
  }

  postfix(): Expr {
    let e = this.atom();
    while (this.isOp("[")) {
      this.pos += 1;
      const i = this.ternary();
      this.expectOp("]");
      e = { k: "index", e, i };
    }
    return e;
  }

  /** Éléments séparés par des virgules jusqu'à `close` (une virgule finale est permise). */
  sequence<T>(close: string, item: () => T): T[] {
    const items: T[] = [];
    while (!this.isOp(close)) {
      items.push(item());
      if (!this.isOp(",")) break;
      this.pos += 1;
    }
    this.expectOp(close);
    return items;
  }

  atom(): Expr {
    const t = this.peek();
    this.pos += 1;
    if (t.kind === "num" || t.kind === "str") return { k: "lit", v: t.value };
    if (t.kind === "op") return this.bracket(t.value as string);
    if (t.kind === "end") throw syn("expression incomplète");
    const name = t.value as string;
    if (name === "True" || name === "False") return { k: "lit", v: name === "True" };
    if (RESERVED.has(name)) throw syn(`« ${name} » est un mot réservé`);
    if (!this.isOp("(")) return { k: "name", name };
    this.pos += 1;
    return { k: "call", name, args: this.sequence(")", () => this.ternary()) };
  }

  bracket(op: string): Expr {
    if (op === "(") {
      const e = this.ternary();
      this.expectOp(")");
      return e;
    }
    if (op === "[") return { k: "list", items: this.sequence("]", () => this.ternary()) };
    if (op === "{") {
      return {
        k: "dict",
        entries: this.sequence("}", () => {
          const key = this.ternary();
          this.expectOp(":");
          return [key, this.ternary()] as [Expr, Expr];
        }),
      };
    }
    throw syn(`« ${op} » inattendu dans l'expression`);
  }
}

/** Analyse une expression ; lève `syntax_error` (sans numéro de ligne, ajouté par l'appelant). */
export function parseExpression(src: string): Expr {
  if (src.length > MAX_SOURCE) throw syn(`expression trop longue (plus de ${MAX_SOURCE} caractères)`);
  const p = new Parser(lex(src));
  const e = p.ternary();
  if (p.peek().kind !== "end") throw syn(`« ${String(p.peek().value)} » inattendu dans l'expression`);
  return e;
}

// ───────────────────────────── Évaluateur ─────────────────────────────

export interface Runtime {
  get(name: string): Value;
  call(name: string, args: Value[]): Value;
}

const both = (op: string, a: Value, b: Value): never => {
  throw fail(`« ${op} » ne s'applique pas à ${typeName(a)} et ${typeName(b)}`);
};

function arith(op: string, f: (x: number, y: number) => number): (a: Value, b: Value) => Value {
  return (a, b) => (typeof a === "number" && typeof b === "number" ? safeInt(f(a, b)) : both(op, a, b));
}

function nonZero(op: string, y: number): number {
  if (y === 0) throw fail(`« ${op} » : division par zéro`);
  return y;
}

function compare(op: string, test: (c: number) => boolean): (a: Value, b: Value) => Value {
  return (a, b) => {
    if ((typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string")) {
      return test(a < b ? -1 : a > b ? 1 : 0);
    }
    return both(op, a, b);
  };
}

function plus(a: Value, b: Value): Value {
  if (typeof a === "number" && typeof b === "number") return safeInt(a + b);
  if (typeof a === "string" && typeof b === "string") return limitedText(a + b);
  if (Array.isArray(a) && Array.isArray(b)) return limitedList([...a, ...b]);
  return both("+", a, b);
}

function times(a: Value, b: Value): Value {
  if (typeof a === "number" && typeof b === "number") return safeInt(a * b);
  const [text, n] = typeof a === "string" ? [a, b] : [b, a];
  if (typeof text !== "string" || typeof n !== "number") return both("*", a, b);
  if (n < 0 || text.length * n > 1_000_000) throw fail("« * » : répétition négative ou trop longue");
  return text.repeat(n);
}

function contains(a: Value, b: Value): boolean {
  if (typeof b === "string") {
    if (typeof a !== "string") throw fail(`« in » : un texte ne se cherche que dans un texte (reçu : ${typeName(a)})`);
    return b.includes(a);
  }
  if (Array.isArray(b)) return b.some((x) => equal(x, a));
  if (b instanceof Map) return typeof a === "string" || typeof a === "number" ? b.has(a) : both("in", a, b);
  return both("in", a, b);
}

const BIN: Record<string, (a: Value, b: Value) => Value> = {
  "+": plus,
  "-": arith("-", (x, y) => x - y),
  "*": times,
  "//": arith("//", (x, y) => Math.floor(x / nonZero("//", y))),
  "%": arith("%", (x, y) => ((x % nonZero("%", y)) + y) % y),
  "==": (a, b) => equal(a, b),
  "!=": (a, b) => !equal(a, b),
  "<": compare("<", (c) => c < 0),
  "<=": compare("<=", (c) => c <= 0),
  ">": compare(">", (c) => c > 0),
  ">=": compare(">=", (c) => c >= 0),
  in: contains,
  "not in": (a, b) => !contains(a, b),
};

function index(container: Value, key: Value): Value {
  if (container instanceof Map) {
    if ((typeof key === "string" || typeof key === "number") && container.has(key)) return container.get(key) as Value;
    throw fail(`clé absente du dictionnaire : ${typeof key === "string" ? JSON.stringify(key) : typeName(key)}`);
  }
  if (typeof container !== "string" && !Array.isArray(container)) throw fail(`[ ] ne s'applique pas à ${typeName(container)}`);
  if (typeof key !== "number") throw fail(`l'indice doit être un entier (reçu : ${typeName(key)})`);
  const at = key < 0 ? container.length + key : key;
  if (at < 0 || at >= container.length) throw fail(`indice hors limites : ${key} (taille ${container.length})`);
  return container[at];
}

export function evaluate(e: Expr, rt: Runtime): Value {
  switch (e.k) {
    case "lit":
      return e.v;
    case "name":
      return rt.get(e.name);
    case "list":
      return e.items.map((i) => evaluate(i, rt));
    case "dict": {
      const m: Dict = new Map();
      for (const [ke, ve] of e.entries) {
        const key = evaluate(ke, rt);
        if (typeof key !== "string" && typeof key !== "number") throw fail(`clé de dictionnaire : texte ou entier (reçu : ${typeName(key)})`);
        m.set(key, evaluate(ve, rt));
      }
      return m;
    }
    case "unary": {
      const v = evaluate(e.e, rt);
      if (e.op === "not") return !truthy(v);
      if (typeof v !== "number") throw fail(`« - » : un entier est attendu (reçu : ${typeName(v)})`);
      return safeInt(-v);
    }
    case "bin":
      return BIN[e.op](evaluate(e.l, rt), evaluate(e.r, rt));
    case "and": {
      const l = evaluate(e.l, rt);
      return truthy(l) ? evaluate(e.r, rt) : l;
    }
    case "or": {
      const l = evaluate(e.l, rt);
      return truthy(l) ? l : evaluate(e.r, rt);
    }
    case "cond":
      return truthy(evaluate(e.test, rt)) ? evaluate(e.a, rt) : evaluate(e.b, rt);
    case "index":
      return index(evaluate(e.e, rt), evaluate(e.i, rt));
    case "call":
      return rt.call(
        e.name,
        e.args.map((a) => evaluate(a, rt)),
      );
  }
}
