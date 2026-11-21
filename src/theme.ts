// Thème « opencode » (variante sombre) pour la coloration syntaxique : mêmes couleurs que celles
// que opencode affiche pour le code dans le terminal. Valeurs reprises du thème `opencode` :
// commentaire #808080, mot-clé #9d7cd8, fonction #fab283, variable #e06c75, chaîne #7fd88f,
// nombre #f5a742, type #e5c07b, opérateur #56b6c2, ponctuation et texte #eeeeee.

export const OPENCODE = {
  text: "#eeeeee",
  comment: "#808080",
  keyword: "#9d7cd8",
  function: "#fab283",
  variable: "#e06c75",
  string: "#7fd88f",
  number: "#f5a742",
  type: "#e5c07b",
  operator: "#56b6c2",
  link: "#fab283",
} as const;

const rule = (scope: string[], foreground: string, fontStyle?: string) => ({
  scope,
  settings: fontStyle === undefined ? { foreground } : { foreground, fontStyle },
});

export const OPENCODE_THEME = {
  name: "opencode",
  type: "dark" as const,
  fg: OPENCODE.text,
  bg: "#141414",
  settings: [
    { settings: { foreground: OPENCODE.text } },
    rule(["comment", "punctuation.definition.comment"], OPENCODE.comment, "italic"),
    rule(["keyword", "keyword.control", "storage", "storage.type", "storage.modifier", "keyword.operator.new", "keyword.operator.expression", "keyword.operator.logical.python", "constant.language.import-export-all"], OPENCODE.keyword),
    rule(["keyword.operator", "keyword.operator.assignment", "keyword.operator.arithmetic", "keyword.operator.comparison", "keyword.operator.relational", "keyword.operator.logical", "punctuation.accessor", "punctuation.separator.key-value"], OPENCODE.operator),
    rule(["entity.name.function", "support.function", "meta.function-call entity.name.function", "variable.function", "entity.name.function.member"], OPENCODE.function),
    rule(["variable", "variable.other", "variable.other.readwrite", "variable.parameter", "support.variable", "meta.object-literal.key", "variable.other.property", "support.type.property-name", "entity.name.tag", "invalid", "markup.deleted"], OPENCODE.variable),
    rule(["string", "string.quoted", "string.template", "string.regexp", "markup.inline.raw", "markup.fenced_code.block", "markup.inserted"], OPENCODE.string),
    // les guillemets et les accents graves font partie de la chaîne (sinon la ponctuation les reprend)
    rule(["punctuation.definition.string", "punctuation.definition.raw"], OPENCODE.string),
    rule(["constant.numeric", "constant.language", "constant.character", "constant.other", "support.constant", "keyword.other.unit"], OPENCODE.number),
    rule(["entity.name.type", "entity.name.class", "entity.other.inherited-class", "support.type", "support.class", "entity.name.namespace", "support.type.primitive"], OPENCODE.type),
    rule(["punctuation", "meta.brace", "punctuation.definition.block", "punctuation.terminator", "punctuation.separator"], OPENCODE.text),
    rule(["markup.heading", "entity.name.section", "punctuation.definition.heading"], OPENCODE.keyword, "bold"),
    rule(["markup.bold"], OPENCODE.number, "bold"),
    rule(["markup.italic", "markup.quote"], OPENCODE.type, "italic"),
    rule(["markup.underline.link", "string.other.link", "punctuation.definition.list.begin.markdown", "beginning.punctuation.definition.list.markdown"], OPENCODE.link),
    rule(["entity.other.attribute-name"], OPENCODE.function),
  ],
};
