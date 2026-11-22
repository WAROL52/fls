// Table des directives, dans l'ordre d'affichage de `fls spec` et `fls help`.

import type { Spec } from "../types.ts";
import { append } from "./append.ts";
import { copy } from "./copy.ts";
import { create } from "./create.ts";
import { del } from "./delete.ts";
import { edit } from "./edit.ts";
import { expectContains, expectExists, expectMissing } from "./expect.ts";
import { grep } from "./grep.ts";
import { history } from "./history.ts";
import { mkdir } from "./mkdir.ts";
import { move } from "./move.ts";
import { note } from "./note.ts";
import { overwrite } from "./overwrite.ts";
import { read } from "./read.ts";
import { stat } from "./stat.ts";
import { tree } from "./tree.ts";
import { write } from "./write.ts";

export const DIRECTIVES: Spec[] = [tree, read, grep, stat, history, note, expectExists, expectMissing, expectContains, edit, create, overwrite, write, append, mkdir, copy, del, move];

export const SPEC_BY_NAME: Map<string, Spec> = new Map(DIRECTIVES.map((d) => [d.name, d]));
