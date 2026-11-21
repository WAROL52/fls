// Table des directives, dans l'ordre d'affichage de `fls spec` et `fls help`.

import type { Spec } from "../types.ts";
import { append } from "./append.ts";
import { create } from "./create.ts";
import { del } from "./delete.ts";
import { edit } from "./edit.ts";
import { grep } from "./grep.ts";
import { move } from "./move.ts";
import { note } from "./note.ts";
import { overwrite } from "./overwrite.ts";
import { read } from "./read.ts";
import { tree } from "./tree.ts";
import { write } from "./write.ts";

export const DIRECTIVES: Spec[] = [tree, read, grep, note, edit, create, overwrite, write, append, del, move];

export const SPEC_BY_NAME: Map<string, Spec> = new Map(DIRECTIVES.map((d) => [d.name, d]));
