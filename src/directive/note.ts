import type { Spec } from "../types.ts";
import { directive } from "./shared.ts";

export const note: Spec = directive({
  name: "note",
  summary: "recopie un texte dans le rapport (pour annoter les étapes d'un script)",
  usage: '@note "<texte>"',
  examples: ['@note "étape 1 : ajout du champ role"'],
  run: (_ctx, op) => ({ title: op.args[0], body: "" }),
});
