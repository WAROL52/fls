// Livraison d'une sortie à ses destinations : le terminal, le fichier de `--output`, le presse-papiers.
// Chaque destination porte ses propres options (couleur, largeur, limite) ; le Rapport n'est rendu
// qu'une fois par jeu d'options distinct. Plus aucune destination ne recalcule la même décision.

import * as fs from "node:fs";
import * as path from "node:path";
import { numberArg } from "./args.ts";
import { toAnsi, type ColorLevel } from "./ansi.ts";
import { colorPlan } from "./color.ts";
import { shikiHighlighter } from "./highlight.ts";
import { saveLast } from "./last.ts";
import { renderStyled, type StyleOptions } from "./report/styled.ts";
import { renderTreeStyled } from "./report/tree-styled.ts";
import type { Line } from "./style.ts";
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
  /** Niveau de couleur de la sérialisation ANSI des destinations stylées. */
  level: ColorLevel;
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
  return { destinations, style: { bg: plan.bg, highlighter: io.highlighter ?? shikiHighlighter }, level: plan.level };
}

const renderContent = (content: Content, o: StyleOptions): Promise<Line[]> =>
  content.kind === "report" ? renderStyled(content.doc, o) : renderTreeStyled(content.roots, o);

const notice = (omitted: number): string => `\n[rapport tronqué : ${omitted} caractères omis ; relance avec --max-output-chars]\n`;

/** Texte brut : coupé à la limite, avec l'avis de troncature. */
function plainShown(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}${notice(text.length - limit)}`;
}

/** Rend le Rapport pour chaque destination, tronque, écrit, puis mémorise la Dernière sortie si demandé. */
export async function deliver(report: Report, delivery: Delivery, io: Io): Promise<void> {
  const laidOut = new Map<string, Promise<Line[]>>();
  const layout = (columns: number | undefined): Promise<Line[]> => {
    const key = `${columns}`;
    const known = laidOut.get(key);
    if (known !== undefined) return known;
    const fresh = renderContent(report.content as Content, { ...delivery.style, columns });
    laidOut.set(key, fresh);
    return fresh;
  };
  for (const d of delivery.destinations) {
    const styled = d.styled && report.content !== undefined;
    const limit = d.limit ?? (report.content?.kind === "tree" ? Infinity : DEFAULT_MAX_OUTPUT);
    let shown: string | Buffer;
    if (styled) {
      const s = toAnsi(await layout(d.columns), delivery.level, limit);
      shown = s.truncated ? `${s.text}${notice(s.total - s.text.length)}` : s.text;
    } else {
      shown = d.exactBytes && report.raw !== undefined && report.text.length <= limit ? report.raw : plainShown(report.text, limit);
    }
    if (d.to === "stdout") io.out(shown);
    else if (d.to === "file") fs.writeFileSync(d.path as string, shown);
    else io.clipboard.write(String(shown));
  }
  if (report.remember === true && report.content !== undefined) saveLast(io, report.content);
}
