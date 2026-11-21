import type { Spec } from "../types.ts";
import { CONTENT_EXAMPLE, directive, runPut } from "./shared.ts";

export const overwrite: Spec = directive({
  name: "overwrite",
  summary: "remplace tout le contenu d'un fichier existant ; échoue s'il n'existe pas",
  usage: "@overwrite <fichier>  puis un bloc <<<<<<< CONTENT / >>>>>>> END",
  block: "content",
  writes: true,
  examples: [CONTENT_EXAMPLE("overwrite")],
  run: runPut("overwrite"),
});
