// Expansion de la syntaxe v2 : un Script source (avec `@fls 2`) devient un Script plat (des `Op`
// de la v1). Elle se fait avant toute exécution, sur l'état initial du disque : `exists`, `read`
// et `glob` ne voient jamais l'état simulé par les écritures du script. Les lignes de contrôle
// (`@let`, `@for`, `@if`, `@def`, `@call`) disparaissent ; seules les directives émises restent.

import { SPEC_BY_NAME } from "../directive/index.ts";
import { FlsError, syntaxError } from "../errors.ts";
import { BLOCK_READERS, HASH_DIRECTIVE, HASH_NAME, checkHashed, clipRegions, opFromTokens } from "../script.ts";
import type { Edit, Ignore, Op, Spec, Token } from "../types.ts";
import type { Workspace } from "../workspace.ts";
import { callBuiltin } from "./builtins.ts";
import { evaluate, parseExpression, RESERVED, type Expr, type Runtime } from "./expr.ts";
import { parseTemplate, tokenizeLine, type Part, type TokenParts } from "./template.ts";
import { fail, interpolated, truthy, type Dict, type Value } from "./values.ts";

export interface ExpandEnv {
  ws: Workspace;
  ignore: Ignore;
  /** Variables de `--set nom=valeur` : toujours des textes. */
  vars: Record<string, string>;
  /** Plafond de directives émises (`--max-expanded`). */
  maxExpanded: number;
}

const MAX_STEPS = 200_000;
const MAX_NESTING = 50;

// ───────────────────────────── Source : pragma et arbre ─────────────────────────────

type Node =
  | { t: "emit"; line: number; spec: Spec; tokens: TokenParts[]; edits: Array<{ search: Part[]; replace: Part[] }>; content: Part[] }
  | { t: "let"; line: number; name: string; expr: Expr }
  | { t: "for"; line: number; name: string; expr: Expr; body: Node[] }
  | { t: "if"; line: number; branches: Array<{ test: Expr | null; body: Node[] }> }
  | { t: "def"; line: number; name: string; params: string[]; body: Node[] }
  | { t: "call"; line: number; hash: boolean; name: string; args: Expr[] };

const CONTROL = new Set(["let", "for", "if", "elif", "else", "end", "def", "call", "fls"]);
const PRAGMA = /^#?@fls(?:\s|$)/;
const isComment = (t: string): boolean => t === "" || (t.startsWith("#") && !HASH_DIRECTIVE.test(t));

/** Index de la ligne `@fls …` si c'est la première ligne utile, sinon -1. */
function pragmaIndex(lines: string[]): number {
  const first = lines.findIndex((l) => !isComment(l.trim()));
  return first !== -1 && PRAGMA.test(lines[first].trim()) ? first : -1;
}

/** Vrai si le script commence par `@fls 2` ; `syntax_error` pour toute autre version. */
export function isV2(text: string): boolean {
  const lines = clipRegions(text.split(/\r?\n/));
  const at = pragmaIndex(lines);
  if (at === -1) return false;
  const version = (/^#?@fls\s*(.*)$/.exec(lines[at].trim()) as RegExpExecArray)[1].trim();
  if (version === "2") return true;
  throw syntaxError(at + 1, `@fls attend la version de syntaxe « 2 » (reçu : ${version === "" ? "rien" : version}) ; sans @fls, un script suit la syntaxe v1`);
}

const IDENT = /^[A-Za-z_]\w*$/;
const identifier = (line: number, name: string, what: string): string => {
  if (!IDENT.test(name) || RESERVED.has(name)) throw syntaxError(line, `${what} invalide : ${JSON.stringify(name)}`);
  return name;
};

/** Convertit une erreur d'analyse (sans numéro de ligne) en `syntax_error` de cette ligne. */
function at<T>(line: number, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw syntaxError(line, (e as Error).message);
  }
}

interface Stop {
  nodes: Node[];
  stop: string | null;
  line: number;
}

class SourceParser {
  lines: string[];
  pos: number;

  constructor(lines: string[], pos: number) {
    this.lines = lines;
    this.pos = pos;
  }

  /** Lit des nœuds jusqu'à l'un des mots de `stops` (consommé) ou la fin du script. */
  nodes(stops: string[], depth: number, top: boolean): Stop {
    if (depth > MAX_NESTING) throw syntaxError(this.pos + 1, "constructions trop imbriquées");
    const nodes: Node[] = [];
    while (this.pos < this.lines.length) {
      const lineNo = this.pos + 1;
      let trimmed = this.lines[this.pos].trim();
      if (isComment(trimmed)) {
        this.pos += 1;
        continue;
      }
      const hash = HASH_DIRECTIVE.test(trimmed);
      if (hash) trimmed = trimmed.slice(1);
      if (!trimmed.startsWith("@")) throw syntaxError(lineNo, "ligne inattendue (une directive commence par @)");
      this.pos += 1;
      const word = /^@([A-Za-z][A-Za-z_]*)/.exec(trimmed)?.[1];
      if (word === undefined) throw syntaxError(lineNo, "nom de directive attendu après @");
      if (stops.includes(word)) {
        if (/^@\w+\s+\S/.test(trimmed) && word !== "elif") throw syntaxError(lineNo, `@${word} n'attend rien après lui`);
        return { nodes, stop: word === "elif" ? trimmed : word, line: lineNo };
      }
      nodes.push(CONTROL.has(word) ? this.control(word, trimmed, lineNo, hash, depth, top) : this.emit(word, trimmed, lineNo, hash));
    }
    return { nodes, stop: null, line: this.lines.length };
  }

  control(word: string, text: string, line: number, hash: boolean, depth: number, top: boolean): Node {
    const rest = text.slice(word.length + 1).trim();
    switch (word) {
      case "let": {
        const m = /^([A-Za-z_]\w*)\s*=(?!=)\s*(.+)$/.exec(rest);
        if (m === null) throw syntaxError(line, "@let attend : @let nom = expression");
        return { t: "let", line, name: identifier(line, m[1], "nom de variable"), expr: at(line, () => parseExpression(m[2])) };
      }
      case "for": {
        const m = /^([A-Za-z_]\w*)\s+in\s+(.+)$/.exec(rest);
        if (m === null) throw syntaxError(line, "@for attend : @for nom in expression");
        const body = this.nodes(["end"], depth + 1, false);
        if (body.stop === null) throw syntaxError(line, "@for sans @end");
        return { t: "for", line, name: identifier(line, m[1], "nom de variable"), expr: at(line, () => parseExpression(m[2])), body: body.nodes };
      }
      case "if":
        return this.conditional(rest, line, depth);
      case "def":
        return this.definition(rest, line, depth, top);
      case "call": {
        const e = at(line, () => parseExpression(rest));
        if (e.k !== "call") throw syntaxError(line, "@call attend : @call macro(arguments)");
        return { t: "call", line, hash, name: e.name, args: e.args };
      }
      case "fls":
        throw syntaxError(line, "@fls doit être la première ligne du script");
      default:
        throw syntaxError(line, `@${word} sans @if, @for ou @def ouvert`);
    }
  }

  conditional(first: string, line: number, depth: number): Node {
    if (first === "") throw syntaxError(line, "@if attend une condition");
    const branches: Array<{ test: Expr | null; body: Node[] }> = [];
    let test: Expr | null = at(line, () => parseExpression(first));
    let from = line;
    let stops = ["elif", "else", "end"];
    for (;;) {
      const body = this.nodes(stops, depth + 1, false);
      if (body.stop === null) throw syntaxError(from, "@if sans @end");
      branches.push({ test, body: body.nodes });
      if (body.stop === "end") return { t: "if", line, branches };
      from = body.line;
      if (body.stop === "else") {
        test = null;
        stops = ["end"];
      } else {
        const cond = body.stop.replace(/^@elif\s*/, "");
        if (cond === "") throw syntaxError(from, "@elif attend une condition");
        test = at(from, () => parseExpression(cond));
      }
    }
  }

  definition(rest: string, line: number, depth: number, top: boolean): Node {
    if (!top) throw syntaxError(line, "@def n'est permis qu'au premier niveau du script");
    const m = /^([A-Za-z_]\w*)\s*\(([^)]*)\)$/.exec(rest);
    if (m === null) throw syntaxError(line, "@def attend : @def nom(paramètre, …)");
    const params = m[2].trim() === "" ? [] : m[2].split(",").map((p) => identifier(line, p.trim(), "nom de paramètre"));
    if (new Set(params).size !== params.length) throw syntaxError(line, `@def ${m[1]} : paramètre en double`);
    const body = this.nodes(["end"], depth + 1, false);
    if (body.stop === null) throw syntaxError(line, "@def sans @end");
    return { t: "def", line, name: identifier(line, m[1], "nom de macro"), params, body: body.nodes };
  }

  emit(word: string, text: string, line: number, hash: boolean): Node {
    const spec = SPEC_BY_NAME.get(word);
    if (spec === undefined) throw syntaxError(line, `directive inconnue @${word}`);
    if (hash) checkHashed(word, line);
    const tokens = at(line, () => tokenizeLine(text));
    const dummy: Op = { line, name: spec.name, args: [], opts: {}, edits: [], content: "" };
    const block = BLOCK_READERS[spec.block](this.lines, this.pos, dummy, true);
    this.pos = block.next;
    const lit = (s: string): Part[] => [{ lit: s }];
    const edits = dummy.edits.map((e: Edit, i) => (block.templated[i] ? at(line, () => ({ search: parseTemplate(e.search), replace: parseTemplate(e.replace) })) : { search: lit(e.search), replace: lit(e.replace) }));
    const content = block.templated[0] === true ? at(line, () => parseTemplate(dummy.content)) : lit(dummy.content);
    return { t: "emit", line, spec, tokens, edits, content };
  }
}

// ───────────────────────────── Exécution ─────────────────────────────

class Scope {
  vars: Map<string, Value> = new Map();
  parent: Scope | null;

  constructor(parent: Scope | null) {
    this.parent = parent;
  }

  get(name: string): Value | undefined {
    return this.vars.get(name) ?? this.parent?.get(name);
  }
}

interface Frame {
  name: string;
  line: number;
}

type Def = Extract<Node, { t: "def" }>;

const callNames = (nodes: Node[]): string[] =>
  nodes.flatMap((n) => {
    if (n.t === "call") return [n.name];
    if (n.t === "for") return callNames(n.body);
    return n.t === "if" ? n.branches.flatMap((b) => callNames(b.body)) : [];
  });

class Expander {
  env: ExpandEnv;
  out: Op[] = [];
  steps = 0;
  macros: Map<string, Def> = new Map();
  frames: Frame[] = [];
  restrict = false;
  globals: Scope = new Scope(null);

  constructor(env: ExpandEnv) {
    this.env = env;
    for (const [k, v] of Object.entries(env.vars)) this.globals.vars.set(k, v);
  }

  /** Une erreur d'expansion à la ligne `line`, avec la chaîne des macros en cours. */
  error(line: number, message: string): FlsError {
    const chain = [...this.frames].reverse().map((f) => ` (dans la macro ${f.name}, appelée ligne ${f.line})`);
    return new FlsError("expansion_error", `ligne ${line} : ${message}${chain.join("")}`);
  }

  /** Évalue en convertissant toute erreur de lecture ou de calcul en erreur d'expansion de cette ligne. */
  guard<T>(line: number, fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      const err = e as FlsError;
      throw this.error(line, err.code === "expansion_error" ? err.message : `${err.message} (${err.code})`);
    }
  }

  runtime(scope: Scope): Runtime {
    return {
      get: (name) => {
        const v = scope.get(name);
        if (v === undefined) throw fail(`variable inconnue : ${name}`);
        return v;
      },
      call: (name, args) => callBuiltin(name, args, this.env),
    };
  }

  value(line: number, e: Expr, scope: Scope): Value {
    return this.guard(line, () => evaluate(e, this.runtime(scope)));
  }

  render(line: number, parts: Part[], scope: Scope): string {
    return parts.map((p) => ("lit" in p ? p.lit : this.guard(line, () => interpolated(evaluate(p.expr, this.runtime(scope)))))).join("");
  }

  tick(line: number): void {
    this.steps += 1;
    if (this.steps > MAX_STEPS) throw this.error(line, `l'expansion dépasse ${MAX_STEPS} étapes`);
  }

  run(nodes: Node[], scope: Scope): void {
    for (const n of nodes) {
      this.tick(n.line);
      this.exec(n, scope);
    }
  }

  exec(n: Node, scope: Scope): void {
    switch (n.t) {
      case "let":
        scope.vars.set(n.name, this.value(n.line, n.expr, scope));
        return;
      case "for":
        return this.loop(n, scope);
      case "if": {
        const branch = n.branches.find((b) => b.test === null || truthy(this.value(n.line, b.test, scope)));
        if (branch !== undefined) this.run(branch.body, scope);
        return;
      }
      case "def":
        return this.define(n);
      case "call":
        return this.call(n, scope);
      case "emit":
        return this.emit(n, scope);
    }
  }

  loop(n: Extract<Node, { t: "for" }>, scope: Scope): void {
    const v = this.value(n.line, n.expr, scope);
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") throw this.error(n.line, "@for parcourt une liste ou un dictionnaire");
    for (const item of v instanceof Map ? [...(v as Dict).keys()] : v) {
      this.tick(n.line);
      scope.vars.set(n.name, item);
      this.run(n.body, scope);
    }
  }

  define(n: Def): void {
    if (this.macros.has(n.name)) throw this.error(n.line, `la macro ${n.name} est déjà définie`);
    const unknown = callNames(n.body).find((c) => !this.macros.has(c));
    if (unknown !== undefined) throw this.error(n.line, `@def ${n.name} appelle ${unknown}, inconnue ou définie plus bas (une macro ne peut appeler que des macros déjà définies : pas de récursion)`);
    this.macros.set(n.name, n);
  }

  call(n: Extract<Node, { t: "call" }>, scope: Scope): void {
    const def = this.macros.get(n.name);
    if (def === undefined) throw this.error(n.line, `macro inconnue : ${n.name}`);
    const args = n.args.map((a) => this.value(n.line, a, scope));
    if (args.length !== def.params.length) throw this.error(n.line, `${n.name} attend ${def.params.length} argument(s), reçu ${args.length}`);
    const inner = new Scope(this.globals);
    def.params.forEach((p, i) => inner.vars.set(p, args[i]));
    const restrict = this.restrict;
    this.restrict = restrict || n.hash;
    this.frames.push({ name: n.name, line: n.line });
    this.run(def.body, inner);
    this.frames.pop();
    this.restrict = restrict;
  }

  emit(n: Extract<Node, { t: "emit" }>, scope: Scope): void {
    if (this.out.length >= this.env.maxExpanded) throw this.error(n.line, `plus de ${this.env.maxExpanded} directives émises (--max-expanded pour changer le plafond)`);
    if (n.spec.writes && this.restrict) throw this.error(n.line, `@${n.spec.name} écrit : refusé sous #@call (la forme #@ est réservée aux lectures)`);
    const tokens: Token[] = n.tokens.map((t) => ({
      text: this.render(n.line, t.parts, scope),
      // un mot interpolé n'est jamais une option : une valeur calculée ne doit pas pouvoir en fabriquer une
      quoted: t.quoted || t.parts.some((p) => "expr" in p),
    }));
    const op = opFromTokens(tokens, n.line);
    op.edits = n.edits.map((e) => ({ search: this.render(n.line, e.search, scope), replace: this.render(n.line, e.replace, scope) }));
    if (n.spec.block === "edit" && op.edits.some((e) => e.search === "")) throw this.error(n.line, "SEARCH vide après interpolation");
    op.content = this.render(n.line, n.content, scope);
    this.out.push(op);
  }
}

/** Étend un Script source (`@fls 2`) en Script plat. */
export function expandScript(text: string, env: ExpandEnv): Op[] {
  const lines = clipRegions(text.split(/\r?\n/));
  const parser = new SourceParser(lines, pragmaIndex(lines) + 1);
  const { nodes } = parser.nodes([], 0, true);
  const ex = new Expander(env);
  ex.run(nodes, ex.globals);
  return ex.out;
}
