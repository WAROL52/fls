import { palette, safeTruncate, type ColorLevel, type Rgb } from "./ansi.ts";
import { FlsError } from "./errors.ts";
import type { Args, Io } from "./types.ts";

export type ColorMode = "auto" | "always" | "never";

/** Quelles sorties sont colorées (la décision seulement : le rendu et la largeur sont par destination). */
export interface ColorPlan {
  stdout: boolean;
  stderr: boolean;
  file: boolean;
  clip: boolean;
  level: ColorLevel;
  /** Fond des contenus de fichier (`FLS_BG`) ; absent : #141414. */
  bg?: Rgb;
}

export function colorMode(args: Args): ColorMode {
  if (args.flags.has("no-color")) return "never";
  if (args.flags.has("colored")) return "always";
  const v = args.values.get("color");
  if (v === undefined) return "auto";
  if (v === "auto" || v === "always" || v === "never") return v;
  throw new FlsError("usage_error", `--color attend auto|always|never (reçu : ${v})`);
}

/** `FLS_BG=#rrggbb` (ou `rrggbb`) : couleur de fond des contenus, pour l'accorder au thème du terminal. */
export function parseBg(value: string | undefined): Rgb | undefined {
  if (value === undefined || value === "") return undefined;
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (m === null) throw new FlsError("usage_error", `FLS_BG attend une couleur #rrggbb (reçu : ${value})`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

export function colorPlan(args: Args, io: Io): ColorPlan {
  const mode = colorMode(args);
  const noColor = io.env?.NO_COLOR !== undefined;
  const force = mode === "always";
  const off = mode === "never" || (mode === "auto" && noColor);
  const auto = (tty: boolean | undefined): boolean => !off && (force || (mode === "auto" && tty === true));
  return {
    stdout: auto(io.stdoutIsTTY),
    stderr: auto(io.stderrIsTTY),
    file: !off && force,
    clip: !off && force,
    level: off ? 0 : 3,
    bg: parseBg(io.env?.FLS_BG),
  };
}

/** Message d'erreur sur stderr : en rouge quand stderr est coloré. */
export const colorizeError = (msg: string, plan: ColorPlan): string => palette(plan.level, plan.bg).fail(msg);

export function truncate(text: string, limit: number): { text: string; truncated: boolean } {
  return safeTruncate(text, limit);
}
