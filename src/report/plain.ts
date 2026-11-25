// Rendu brut : le texte du Rapport défini par SPEC §8 (le contrat). Identique octet pour octet à
// ce que fls produisait avant que le Rapport soit une donnée.

import { fileTitle, lastLine, type Entry, type MatchRow, type ReportDoc, type Segment } from "./segments.ts";

const matchRow = (r: MatchRow): string =>
  r.type === "sep" ? "--" : `${r.file}${r.type === "match" ? ":" : "-"}${r.line}${r.type === "match" ? ":" : "-"} ${r.text}`;

export function renderSegment(s: Segment): string {
  switch (s.kind) {
    case "text":
      return s.text;
    case "file": {
      const width = String(lastLine(s)).length;
      const body = s.lines.map((l, i) => (s.numbered ? `${String(s.from + i).padStart(width)} | ${l}` : l));
      return [`=== ${fileTitle(s)} ===`, ...body, "=== fin ==="].join("\n");
    }
    case "omitted":
      return `=== ${s.path} ===\n[omis : ${s.code}]\n=== fin ===`;
    case "matches":
      return s.rows.map(matchRow).join("\n");
    case "diff":
      return s.hunks
        .flatMap((h) => [`@@ bloc ${h.block} (${h.file === undefined ? "" : `${h.file}:`}ligne ${h.line})`, ...h.removed.map((l) => `- ${l}`), ...h.added.map((l) => `+ ${l}`)])
        .join("\n");
  }
}

/** Corps d'une entrée : segments séparés par une ligne vide (un dossier lu = arbre, puis un bloc par fichier). */
export const renderBody = (body: Segment[]): string => body.map(renderSegment).join("\n\n");

export function renderEntry(n: number, e: Entry): string {
  const head = `[${n}] ${e.status.padEnd(4)}  ${e.kind} ${e.title}${e.code === "" ? "" : ` : ${e.code}`}`;
  const body = renderBody(e.body);
  return body === "" ? head : `${head}\n${body}`;
}

export function renderPlain(doc: ReportDoc): string {
  return `${[doc.header, ...doc.entries.map((e, i) => renderEntry(i + 1, e)), doc.footer.join("\n")].join("\n\n")}\n`;
}
