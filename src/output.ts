// Livraison d'une sortie à ses destinations : le terminal, le fichier de `--output`, le presse-papiers.
// Chaque destination porte ses propres options (couleur, largeur, limite) ; le Rapport n'est rendu
// qu'une fois par jeu d'options distinct. Plus aucune destination ne recalcule la même décision.

import * as fs from "node:fs";
import * as path from "node:path";
import { numberArg } from "./args.ts";
import { colorPlan, truncate } from "./color.ts";
import { shikiHighlighter } from "./highlight.ts";
import { saveLast } from "./last.ts";
import { renderStyled, type StyleOptions } from "./report/styled.ts";
import { renderTreeStyled } from "./report/tree-styled.ts";
import type { Args, Content, Io, Report } from "./types.ts";

export const DEFAULT_MAX_OUTPUT = 200_000;

export interface Destination {
  to: "stdout" | "file" | "clip";
  /** Chemin absolu du fichier de `--output` (`to === "file"`). */
  path?: string;
  /** Rendu stylé (couleur) ; sinon rendu brut. */
  styled: boolean;
  /** Largeur à respecter : seulement un terminal (jamais un fichier ni le presse-papiers). */
  columns?: number;
  /** `--max-output-chars` explicite ; absent : 200 000, et aucune limite pour une lecture `--tree`. */
  limit?: number;
  /** Prend les octets exacts de `report.raw` (lecture `--tree` brute) quand ils tiennent dans la limite. */
  exactBytes: boolean;
}

/** Options de rendu communes à toutes les destinations (hors largeur, propre à chacune). */
export type Style = Omit<StyleOptions, "columns">;

export interface Delivery {
  destinations: Destination[];
  style: Style;
}

/** Destinations d'une commande : stdout (sauf avec `--output`), le fichier de `--output`, le presse-papiers. */
export function destinationsFor(args: Args, io: Io): Delivery {
  const plan = colorPlan(args, io);
  const limit = numberArg(args, "max-output-chars", undefined);
  const output = args.values.get("output");
  const destinations: Destination[] =
    output === undefined
      ? [{ to: "stdout", styled: plan.stdout, columns: plan.stdout ? io.columns : undefined, limit, exactBytes: true }]
      : [{ to: "file", path: path.resolve(io.cwd, output), styled: plan.file, limit, exactBytes: false }];
  if (args.flags.has("clip") || args.flags.has("clip-out")) destinations.push({ to: "clip", styled: plan.clip, limit, exactBytes: false });
  return { destinations, style: { level: plan.level, bg: plan.bg, highlighter: io.highlighter ?? shikiHighlighter } };
}

const renderContent = (content: Content, o: StyleOptions): Promise<string> =>
  content.kind === "report" ? renderStyled(content.doc, o) : renderTreeStyled(content.roots, o);

function withTruncation(text: string, limit: number, styled: boolean): string {
  if (text.length <= limit) return text;
  const cut = styled ? truncate(text, limit).text : text.slice(0, limit);
  return `${cut}\n[rapport tronqué : ${text.length - cut.length} caractères omis ; relance avec --max-output-chars]\n`;
}

/** Rend le Rapport pour chaque destination, tronque, écrit, puis mémorise la Dernière sortie si demandé. */
export async function deliver(report: Report, delivery: Delivery, io: Io): Promise<void> {
  const rendered = new Map<string, Promise<string>>();
  const render = (styled: boolean, columns: number | undefined): Promise<string> => {
    if (!styled) return Promise.resolve(report.text);
    const key = `${columns}`;
    const known = rendered.get(key);
    if (known !== undefined) return known;
    const fresh = renderContent(report.content as Content, { ...delivery.style, columns });
    rendered.set(key, fresh);
    return fresh;
  };
  for (const d of delivery.destinations) {
    const styled = d.styled && report.content !== undefined;
    const limit = d.limit ?? (report.content?.kind === "tree" ? Infinity : DEFAULT_MAX_OUTPUT);
    const text = await render(styled, d.columns);
    const shown: string | Buffer = !styled && d.exactBytes && report.raw !== undefined && text.length <= limit ? report.raw : withTruncation(text, limit, styled);
    if (d.to === "stdout") io.out(shown);
    else if (d.to === "file") fs.writeFileSync(d.path as string, shown);
    else io.clipboard.write(String(shown));
  }
  if (report.remember === true && report.content !== undefined) saveLast(io, report.content);
}
