import type { Spec } from "../types.ts";
import { CONTENT_EXAMPLE, directive, runPut } from "./shared.ts";

export const create: Spec = directive({
  name: "create",
  summary: "crée un fichier ; échoue s'il existe déjà",
  usage: "@create <fichier>  puis un bloc <<<<<<< CONTENT / >>>>>>> END",
  block: "content",
  writes: true,
  examples: [CONTENT_EXAMPLE("create")],
  run: runPut("create"),
});
