import type { Spec } from "../types.ts";
import { CONTENT_EXAMPLE, directive, runPut } from "./shared.ts";

export const write: Spec = directive({
  name: "write",
  summary: "crée ou remplace un fichier, sans condition",
  usage: "@write <fichier>  puis un bloc <<<<<<< CONTENT / >>>>>>> END",
  block: "content",
  writes: true,
  examples: [CONTENT_EXAMPLE("write")],
  run: runPut("write"),
});
