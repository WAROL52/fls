// Interpolation `{{ expr }}` : découpe un texte, ou une ligne de directive, en parties littérales
// et expressions. `\{{` donne un `{{` littéral. Dans une ligne de directive, `{{ … }}` est une
// unité (comme un guillemet) : ses espaces ne séparent pas les mots.

import { FlsError } from "../errors.ts";
import { parseExpression, type Expr } from "./expr.ts";

export type Part = { lit: string } | { expr: Expr };

export interface TokenParts {
  parts: Part[];
  quoted: boolean;
}

const syn = (message: string): FlsError => new FlsError("syntax_error", message);

/** Position de la `}}` qui ferme une expression ouverte en `from` (les textes et les `{ }` internes sont sautés). */
function findClose(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") {
      for (i += 1; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i += 1;
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      if (depth > 0) depth -= 1;
      else if (text[i + 1] === "}") return i;
    }
  }
  throw syn("« {{ » sans « }} » correspondant");
}

/** Une expression entre `{{` et `}}` à partir de `at` (juste après `{{`) : l'expression et la position suivante. */
function readExpr(text: string, at: number): { expr: Expr; next: number } {
  const end = findClose(text, at);
  return { expr: parseExpression(text.slice(at, end)), next: end + 2 };
}

const flush = (parts: Part[], lit: string): string => {
  if (lit !== "") parts.push({ lit });
  return "";
};

/** Un texte entier (un bloc) en parties. */
export function parseTemplate(text: string): Part[] {
  const parts: Part[] = [];
  let lit = "";
  for (let i = 0; i < text.length; ) {
    if (text.startsWith("\\{{", i)) {
      lit += "{{";
      i += 3;
    } else if (text.startsWith("{{", i)) {
      lit = flush(parts, lit);
      const r = readExpr(text, i + 2);
      parts.push({ expr: r.expr });
      i = r.next;
    } else {
      lit += text[i];
      i += 1;
    }
  }
  flush(parts, lit);
  return parts;
}

/** Les mots d'une ligne de directive : guillemets droits, `\"` et `\\` dans un mot guillemeté, `{{ … }}` comme unité. */
export function tokenizeLine(line: string): TokenParts[] {
  const tokens: TokenParts[] = [];
  let i = 0;
  for (;;) {
    while (i < line.length && /\s/.test(line[i])) i += 1;
    if (i >= line.length) return tokens;
    const quoted = line[i] === '"';
    if (quoted) i += 1;
    const parts: Part[] = [];
    let lit = "";
    for (;;) {
      if (i >= line.length) {
        if (quoted) throw syn("guillemet non fermé");
        break;
      }
      const c = line[i];
      if (quoted && c === '"') {
        i += 1;
        break;
      }
      if (!quoted && /\s/.test(c)) break;
      if (line.startsWith("\\{{", i)) {
        lit += "{{";
        i += 3;
      } else if (line.startsWith("{{", i)) {
        lit = flush(parts, lit);
        const r = readExpr(line, i + 2);
        parts.push({ expr: r.expr });
        i = r.next;
      } else if (quoted && c === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) {
        lit += line[i + 1];
        i += 2;
      } else {
        lit += c;
        i += 1;
      }
    }
    flush(parts, lit);
    tokens.push({ parts, quoted });
  }
}
