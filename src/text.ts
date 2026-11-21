// Aides de texte : découpage, échappement, tokenisation d'une ligne de directive.

import type { Token } from "./types.ts";

export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export const blockLines = (t: string): string[] => (t === "" ? [] : t.split("\n"));
export const lineAt = (text: string, pos: number): number => text.slice(0, pos).split("\n").length;
export const joinRel = (rel: string, name: string): string => (rel === "" ? name : `${rel}/${name}`);
export const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, k) => a + k);

export function quote(t: string): string {
  return /^[^\s"\\-][^\s"\\]*$/.test(t) ? t : `"${t.replace(/(["\\])/g, "\\$1")}"`;
}

export function tokenize(line: string): Token[] | null {
  const tokens: Token[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\[\s\S])*)"|([^\s"]\S*))/y;
  let pos = 0;
  for (;;) {
    re.lastIndex = pos;
    const m = re.exec(line);
    if (m === null) break;
    tokens.push(m[1] !== undefined ? { text: m[1].replace(/\\(["\\])/g, "$1"), quoted: true } : { text: m[2], quoted: false });
    pos = re.lastIndex;
  }
  return line.slice(pos).trim() === "" ? tokens : null;
}
