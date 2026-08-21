/// <reference types="tree-sitter-cli/dsl" />
// @ts-check
const PREC = {
  PATTERN: 0,
  FIELD_ACCESS_START: 2,
  WHERE_IMPLEMENTS: 1,
  TAG: 1,
  FUNCTION_START: 1,
  PART: 1,
  PREFIX_EXPR: 1,
  TYPEALIAS: 2,
  CASE_OF_BRANCH: 6,
  FUNC: 10,
  IMPORT: 20,
  ARGS: 20,
};

const DECIMAL_INTEGER = /[0-9][0-9_]*/;
const EXPONENT = /[eE][+-]?[0-9][0-9_]*/;
const HEX_INTEGER = /0[xX][0-9a-fA-F][0-9a-fA-F_]*/;
const OCTAL_INTEGER = /0[oO][0-7][0-7_]*/;
const BINARY_INTEGER = /0[bB][01][01_]*/;
const NUMERIC_TYPE_NAME = /[\p{Lu}][\p{XID_Continue}]*/;
const IDENTIFIER = /\$?_*[\p{Ll}][\p{XID_Continue}]*!?/;

module.exports = grammar({
  name: "roc",

  // The external scanner (scanner.cc) allows us to inject "dummy" tokens into the grammar.
  // These tokens are used to track the indentation-based scoping used in F#

  externals: ($) => [
    $._newline,
    $._end_newline,
    $._indent,
    $._dedent,

    // Mark comments as external tokens so that the external scanner is always
    // invoked, even if no external token is expected. This allows for better
    // error recovery, because the external scanner can maintain the overall
    // structure by returning dedent tokens whenever a dedent occurs, even
    // if no dedent is expected.
    $.comment,

    // Allow the external scanner to check for the validity of closing brackets
    // so that it can avoid returning dedent tokens between brackets.
    "]",
    ")",
    "}",
    "except",
    $._else_if_start,
    $._record_function_param_comma,
    $._tight_binary_minus,
  ],

  extras: ($) => [$.line_comment, $.doc_comment, /[ \s\f\uFEFF\u2060\u200B]|\\\r?n/],

  conflicts: ($) => [
    // [$.function_call_expr],
    //
    //
    // === conflicts that must exist:
    //Expressions and patterns will always need to be in conflict because we except expressions in the top level so it's impossible to tell if a list is a list experssion or a list destructuring untill you get to the =
    [$._atomic_pattern, $._primary_expr],
    [$._pattern, $._primary_expr],
    [$.body_expression, $.record_expr],
    [$.tag_pattern, $.tag_expr],
    [$.nominal_record_expr, $.nominal_record_pattern],
    //records are ambiguous with expresion bodies with parens this all makes sense:
    [$.record_field_pattern, $.record_field_expr],
    [$.record_field_pattern, $.record_field_expr, $.annotation_pre_colon],

    [$.record_field_expr, $.annotation_pre_colon],
    [$.record_field_expr, $._atomic_pattern],
    [$.expr_body, $._tuple_body],
    [$._expr_inner, $.suffix_op_expr],
    [$._postfix_expr, $._pipe_operand],
    [$._atom_expr, $._pipe_operand],
    [$.bin_op_expr, $.suffix_op_expr],
    [$._pipe_operand, $.suffix_op_expr],
    [$.bin_op_expr, $._operator_chain_ending_in_pipe_call],
    [$.record_expr, $.body_expression, $.record_pattern],
    [$._pattern, $._atomic_pattern],
    [$._primary_expr, $._pattern, $._atomic_pattern],
    [$.string, $._string_pattern_char],
    [$.function_type, $.record_function_type],

    // ===== conflicts that maybe don't need to exist ====
    [$._tags_only],
    [$.identifier_pattern, $.long_identifier],

    [$.list_pattern, $.list_expr],
    [$._module_elem, $.value_declaration],
    [$._module_elem, $.var_declaration],

    // [$.record_type],
  ],
  words: ($) => /\s+/,
  word: ($) => $._lower_identifier,

  inline: ($) => [
    //ELI: temporary while we work out if these two can just go
    // $.expr_body,
    // $.expr_body_terminal,

    $._non_atomic_type,
    // $.module,
    // $.tag,
    $.field_name,
    $.bound_variable,
    $.operator,
    $.suffix_operator,
    // $.variable_expr,
    $.inferred,
  ],

  // supertypes: ($) => [$._module_elem, $._pattern, $._expr_inner],

  rules: {
    file: ($) => seq(optional($._header), repeat1($._module_elem)),
    //TODO i could make a different version of this for when the module is an interface
    _module_elem: ($) =>
      choice(
        $.annotation_type_def,
        $.alias_type_def,
        $.opaque_type_def,
        $.nominal_type_def,
        $.expect,
        $.value_declaration,
        $.var_declaration,
        $.expr_body,
        $.import_expr,
        $.import_file_expr,
      ),

    expect: ($) => prec(1, seq("expect", field("body", $.expr_body))),
    value_declaration: ($) =>
      seq(
        //TODO i should be able to find a better solution that this silly /n
        optional(seq($.annotation_type_def)),

        // $._newline,
        alias($._assignment_pattern, $.decl_left),
        "=",
        field("body", alias($.expr_body_terminal, $.expr_body)),
      ),

    // Mutable variable binding: `var $name = expr`
    // Supports optional type annotations for parity with value declarations.
    var_declaration: ($) =>
      seq(
        optional(seq($.annotation_type_def)),
        "var",
        field("name", $.identifier),
        "=",
        field("body", alias($.expr_body_terminal, $.expr_body)),
      ),

    /**
      Expressions that can appear anywhere in the body of an expression.
      */
    body_expression: ($) =>
      seq(
        "{",
        repeat(choice($.value_declaration, $.var_declaration, $.local_type_binding, $._expr_inner)),
        "}",
      ),

    local_type_binding: ($) => seq($.concrete_type, ":", $.bound_variable),

    expr_body: ($) => $._expr_inner,
    expr_body_terminal: ($) => $._expr_inner,

    /**
    atomic expressions can be used as function args without being wrapped in parens
    */
    _primary_expr: ($) =>
      choice(
        $.anon_fun_expr,
        $.const,
        $.record_expr,
        $._variable_expr,
        $.parenthesized_expr,
        alias($._parenthesized_negative_expr, $.parenthesized_expr),
        $.body_expression,
        $.operator_as_function_expr,
        $.tag_expr,
        $.tuple_expr,
        $.list_expr,
        $.todo_expr,
        $.nominal_constructor_expr,
        $.nominal_record_expr,
        $.crash_expr,
        $.break_expr,
      ),

    // Calls, field/tuple accesses, and the immediate `?` suffix form one
    // left-recursive postfix tier. Each rule consumes exactly one postfix step,
    // so mixed chains have an unambiguous, left-to-right CST.
    _postfix_expr: ($) =>
      choice(
        $._primary_expr,
        $.field_access_expr,
        $.tuple_access_expr,
        $.function_call_pnc_expr,
        $.suffix_op_expr,
      ),

    _atom_expr: ($) => choice($._postfix_expr, $.prefixed_expression),

    _expr_inner: ($) =>
      choice(
        $.bin_op_expr,
        $._atom_expr,
        $.for_expr,
        $.while_expr,
        $.if_expr,
        $.match_expr,
        $.early_return_expr,
        $.dbg_expr,
        // $.chain_expr,
      ),

    //orginally this had all operators, but it was making the parser almost twice as large so I cut the list down
    prefixed_expression: ($) =>
      prec(
        PREC.PREFIX_EXPR,
        seq(choice("!", "*", "-", "^"), choice($._postfix_expr, $.prefixed_expression)),
      ),
    dbg_expr: ($) => seq("dbg", alias($.expr_body_terminal, $.expr_body)),

    // `for` loop expression: `for pattern in iterable { ... }`
    for_expr: ($) =>
      seq(
        "for",
        field("pattern", $._pattern),
        "in",
        field("iterable", $._expr_inner),
        field("body", $._expr_inner),
      ),
    while_expr: ($) =>
      seq("while", field("guard", $._expr_inner), field("body", $.body_expression)),
    break_expr: () => "break",
    crash_expr: ($) => seq("crash", field("message", $.expr_body)),
    early_return_expr: ($) => seq("return", field("body", $.expr_body)),

    _variable_expr: ($) => alias($.long_identifier, $.variable_expr),
    parenthesized_expr: ($) => seq("(", field("expression", $.expr_body), ")"),
    _parenthesized_negative_expr: ($) =>
      prec(
        PREC.ARGS + 1,
        seq(
          "(",
          field("expression", alias($._parenthesized_negative_value, $.prefixed_expression)),
          ")",
        ),
      ),
    _parenthesized_negative_value: ($) =>
      prec(
        PREC.ARGS + 1,
        seq(
          field("operator", alias($._tight_binary_minus, $.operator_identifier)),
          $._unsigned_number,
        ),
      ),

    if_expr: ($) =>
      prec.right(
        seq(
          "if",
          field("guard", $._expr_inner),
          $.then,
          optional(choice(seq(repeat1($.else_if), optional($.else)), $.else)),
        ),
      ),
    else: ($) => seq("else", $._expr_inner),
    // biome-ignore lint/suspicious/noThenProperty: <explanation>
    then: ($) => seq(field("then", $._expr_inner)),
    else_if: ($) =>
      prec.left(seq(alias($._else_if_start, "else if"), field("guard", $._expr_inner), $.then)),

    field_access_expr: ($) =>
      prec.left(
        PREC.FIELD_ACCESS_START,
        seq(
          field("target", $._postfix_expr),
          choice(
            seq(".", alias(imm(IDENTIFIER), $.identifier)),
            seq(alias(".?", $.optional_access), alias(imm(IDENTIFIER), $.identifier)),
          ),
        ),
      ),

    tuple_access_expr: ($) =>
      prec.left(
        PREC.FIELD_ACCESS_START,
        seq(
          field("target", $._postfix_expr),
          ".",
          field("index", alias(imm(DECIMAL_INTEGER), $.int)),
        ),
      ),

    nominal_constructor_expr: ($) =>
      seq(
        $.tag,
        imm(".("),
        choice(
          seq(field("value", $.expr_body), optional(",")),
          field("value", alias($._tuple_body, $.tuple_expr)),
        ),
        ")",
      ),

    nominal_record_expr: ($) =>
      seq($.tag, imm(".{"), sep_tail(choice($.record_field_expr, $.spread_expr), ","), "}"),

    // chain_expr: ($) =>
    //   prec(
    //     5,
    //     seq(
    //       $.function_call_pnc_expr,
    //       repeat1(prec.right(5, seq(".", $.function_call_pnc_expr))),
    //     ),
    //   ),

    function_call_pnc_expr: ($) =>
      prec.left(
        PREC.FUNC,
        seq(
          field("caller", $._postfix_expr),
          seq(imm("("), field("args", sep_tail($._expr_inner, ",")), ")"),
        ),
      ),

    operator_as_function_expr: ($) => $._operator_as_function_inner,

    _operator_as_function_inner: ($) =>
      seq("(", field("operator", $.operator_identifier), imm(")")),

    //OPERTATOR CALLING
    bin_op_expr: ($) =>
      field(
        "part",
        prec(
          PREC.PART,
          seq(
            $._atom_expr,
            prec.right(
              repeat1(
                choice(
                  // Keep ordinary operands atomic so the enclosing repeat owns
                  // subsequent operators. Match and if remain explicit RHS
                  // forms without reopening the full expression hierarchy.
                  seq($._non_pipe_operator, choice($._atom_expr, $.match_expr, $.if_expr)),
                  seq(alias("|>", $.operator), $._pipe_operand),
                ),
              ),
            ),
          ),
        ),
      ),
    suffix_op_expr: ($) =>
      choice(
        field("part", prec.left(PREC.PART + 1, seq($._postfix_expr, $.suffix_operator))),
        prec.dynamic(
          -1,
          field("part", prec.left(0, seq(choice($.match_expr, $.if_expr), $.suffix_operator))),
        ),
        // The completed pipe is the target when its direct-call RHS is followed
        // by `?`: `a |> f()?` means `(a |> f())?`. Naming the exact ending
        // avoids making every binary expression compete as a suffix target.
        field(
          "part",
          prec.left(
            PREC.PART + 1,
            seq(alias($._operator_chain_ending_in_pipe_call, $.bin_op_expr), $.suffix_operator),
          ),
        ),
      ),

    _operator_chain_ending_in_pipe_call: ($) =>
      field(
        "part",
        prec(
          PREC.PART,
          seq(
            $._atom_expr,
            repeat(seq(alias("|>", $.operator), $._pipe_operand)),
            alias("|>", $.operator),
            $.function_call_pnc_expr,
          ),
        ),
      ),
    // A pipe RHS intentionally excludes only the shape `direct_call?`; that
    // suffix belongs to the completed pipe. Other immediate suffixes, including
    // `f?` and `f().field?`, stay inside the RHS postfix chain.
    _pipe_operand: ($) =>
      choice(
        $._primary_expr,
        $.field_access_expr,
        $.tuple_access_expr,
        $.function_call_pnc_expr,
        alias($._pipe_non_call_suffix_expr, $.suffix_op_expr),
        $.prefixed_expression,
        $.match_expr,
        $.if_expr,
      ),
    _pipe_non_call_suffix_expr: ($) =>
      field(
        "part",
        prec.left(
          PREC.PART + 1,
          seq(
            choice($._primary_expr, $.field_access_expr, $.tuple_access_expr, $.suffix_op_expr),
            $.suffix_operator,
          ),
        ),
      ),
    //PATTERN MATCHING
    _match_start: ($) => seq(alias("match", $.match), $._expr_inner),

    match_expr: ($) => seq($._match_start, "{", repeat1(field("branch", $.match_branch)), "}"),

    match_branch: ($) =>
      seq(
        field("pattern", $._pattern),
        optional(seq("if", alias($._expr_inner, $.if))),
        $.fat_arrow,
        //TODO: evaluate what options can got here
        field("expr", $.expr_body),
        optional(","),
      ),
    tag_expr: ($) => prec.left(seq($.tag, repeat(seq("(", $._atom_expr, ")")))),
    anon_fun_expr: ($) =>
      prec.left(
        seq("|", field("args", optional($.argument_patterns)), "|", field("body", $.expr_body)),
      ),

    //RECORDS

    record_field_expr: ($) =>
      prec.right(
        seq(
          $.field_name,
          optional(seq(":", choice($.expr_body, alias("_", $.unset_record_field)))),
        ),
      ),

    record_expr: ($) =>
      seq(
        "{",
        sep_tail(choice($.record_field_expr, $.spread_expr), ","),
        "}",
        optional(field("builder", $.record_builder_suffix)),
      ),

    record_builder_suffix: ($) =>
      imm(/\.[\p{Lu}][\p{XID_Continue}]*(\.[\p{Lu}][\p{XID_Continue}]*)*/),

    //LISTS

    _list_body: ($) => sep1_tail(field("exprList", choice($._expr_inner, $.spread_expr)), ","),
    list_expr: ($) => seq("[", optional($._list_body), "]"),

    spread_expr: ($) => seq("..", $._expr_inner),

    _tuple_body: ($) =>
      seq(field("expr", $._expr_inner), ",", sep1_tail(field("expr", $._expr_inner), ",")),
    tuple_expr: ($) => seq("(", $._tuple_body, ")"),
    todo_expr: ($) => "...",

    //####---------###
    //#### PATTERN ###
    //####---------###
    // Pattern rules (BEGIN)
    _pattern: ($) =>
      choice(
        alias("_", $.wildcard_pattern),
        alias($.const, $.const_pattern),
        alias($.string_pattern, $.const_pattern),
        $.identifier_pattern,
        $.disjunct_pattern,
        $.conjunct_pattern,
        $.cons_pattern,
        $.paren_pattern,
        $.list_pattern,
        prec(3, $.tag_pattern),
        $.nominal_constructor_pattern,
        $.nominal_record_pattern,
        $.record_pattern,
        $.tuple_pattern,
        $.spread_pattern,
        $.as_pattern,
      ),

    as_pattern: ($) => prec.left(seq(field("pattern", $._atomic_pattern), "as", $.identifier)),

    identifier_pattern: ($) => prec(PREC.FIELD_ACCESS_START + 1, $.identifier),
    nominal_constructor_pattern: ($) =>
      seq(
        $.tag,
        imm(".("),
        choice(
          seq(field("value", $._pattern), optional(",")),
          field("value", alias($._tuple_pattern_body, $.tuple_pattern)),
        ),
        ")",
      ),
    nominal_record_pattern: ($) =>
      seq($.tag, imm(".{"), sep_tail(choice($.record_field_pattern, $.spread_pattern), ","), "}"),
    cons_pattern: ($) => prec.left(0, seq($._pattern, "::", $._pattern)),
    disjunct_pattern: ($) => prec.left(0, seq($._pattern, "|", $._pattern)),
    conjunct_pattern: ($) => prec.left(0, seq($._pattern, "&", $._pattern)),

    paren_pattern: ($) => seq("(", $._pattern, ")"),
    spread_pattern: ($) =>
      prec.left(seq("..", optional(choice(seq("as", $.identifier), $.identifier)))),

    tag_pattern: ($) =>
      prec.left(
        seq($.tag, optional(seq("(", field("args", sep_tail($._atomic_pattern, ",")), ")"))),
      ),
    tuple_pattern: ($) => seq("(", $._tuple_pattern_body, ")"),

    _tuple_pattern_body: ($) =>
      seq($._atomic_pattern, ",", optional(sep1_tail($._atomic_pattern, ","))),

    argument_patterns: ($) =>
      seq($._atomic_pattern, repeat(seq(",", $._atomic_pattern)), optional(",")),
    _atomic_pattern: ($) =>
      choice(
        "null",
        alias("_", $.wildcard_pattern),
        $.const,
        alias($.string_pattern, $.const_pattern),
        $.identifier_pattern,
        $.list_pattern,
        $.tuple_pattern,
        $.record_pattern,
        prec(2, $.tag_pattern),
        $.nominal_constructor_pattern,
        $.nominal_record_pattern,
        $.mutable_pattern,
        //TODO: this shhouldn't realy be here
        $.spread_pattern,
        $.paren_pattern,

        // :? atomic_type
      ),
    mutable_pattern: ($) => seq("var", $.identifier_pattern),
    _assignment_pattern: ($) =>
      choice(
        alias("_", $.wildcard_pattern),
        $.identifier_pattern,
        $.list_pattern,
        $.tuple_pattern,
        $.record_pattern,
        prec(3, $.tag_pattern),
        $.nominal_constructor_pattern,
        $.nominal_record_pattern,
      ),

    list_pattern: ($) =>
      choice(seq("[", "]"), seq("[", $._atomic_pattern, repeat(seq(",", $._atomic_pattern)), "]")),

    record_pattern: ($) =>
      seq(
        "{",
        sep_tail(
          choice(
            // $.record_field_type,
            $.spread_pattern,
            $.record_field_pattern,
            // $.identifier_pattern,
          ),
          ",",
        ),
        "}",
      ),

    record_field_pattern: ($) => seq($.field_name, optional(seq(":", $._atomic_pattern))),
    //###--------####
    //### HEADER ####
    //###--------###

    _header: ($) => choice($.app_header, $.platform_header, $.module_header, $.package_header),
    package_header: ($) => seq("package", $.provides_list, $.packages_list),
    app_header: ($) => seq("app", $.provides_list, $.packages_list),
    //TODO make this a function for app and platform
    platform_header: ($) => seq("platform", alias($.string, $.name), $.platform_header_body),
    platform_header_body: ($) =>
      seq(
        $.requires,
        $.platform_exposes,
        $.packages,
        $.provides,
        optional($.hosted),
        optional($.targets),
      ),

    module_header: ($) => seq("module", $.exposes_list),

    //TODO: should this actually be a record_pattern?
    packages: ($) => seq("packages", $.record_pattern),

    packages_list: ($) => seq("{", sep_tail(choice($.package_ref, $.platform_ref), ","), "}"),

    package_ref: ($) => seq($.identifier, ":", $.string),
    platform_ref: ($) => seq($.identifier, ":", "platform", alias($.string, $.package_uri)),

    exposed_list: ($) => seq("{", sep_tail($.ident, ","), "}"),
    exposes: ($) => seq("exposes", $.exposes_list),
    platform_exposes: ($) => seq("exposes", "[", sep_tail($.platform_exposed_item, ","), "]"),
    platform_exposed_item: ($) =>
      seq(
        choice($.identifier, $.module),
        repeat(seq(imm("."), choice($.identifier, $.module, "*"))),
      ),
    exposes_list: ($) => seq("exposing", seq("[", sep_tail($.ident, ","), "]")),
    import_ident: ($) => seq(optional(seq($.identifier, ".")), sep1($.module, ".")),
    import_path: ($) =>
      choice(
        seq(
          field("root", choice("/", "./", token(/(\.\.\/)+/))),
          repeat(seq(choice($.identifier, $.module), imm("/"))),
          $.module,
          repeat(seq(imm("."), $.module)),
        ),
        seq($.module, repeat1(seq(imm("/"), $.module)), repeat(seq(imm("."), $.module))),
      ),
    _import_body: ($) =>
      seq(
        choice($.import_ident, $.import_path),
        optional(seq(alias("as", $.as), $.module)),
        optional(alias($.exposes_list, $.exposing)),
      ),
    import_expr: ($) => prec(PREC.IMPORT, seq("import", $._import_body)),
    import_file_expr: ($) =>
      prec(
        PREC.IMPORT,
        seq("import", $.string, seq(alias("as", $.as), $.identifier, ":", $.concrete_type)),
      ),
    //TODO make a function for all these comma separated trailing comma things
    to: ($) => "to",
    provides: ($) =>
      seq(
        "provides",
        choice(
          seq(
            "[",
            optional($.identifier),
            repeat(seq(",", $.identifier)),
            optional(","),
            "]",
            optional(seq($.to, choice($.string, $.ident))),
          ),
          $.platform_symbol_map,
        ),
      ),

    hosted: ($) => seq("hosted", $.platform_symbol_map),

    platform_symbol_map: ($) =>
      seq(
        "{",
        sep_tail(
          seq(
            field("symbol", choice($.string, $.identifier)),
            ":",
            field("implementation", $._variable_expr),
          ),
          ",",
        ),
        "}",
      ),

    targets: ($) => seq("targets", ":", $.record_expr),
    provides_list: ($) =>
      seq(
        "[",
        optional(choice($.identifier, $.module)),
        repeat(seq(",", choice($.identifier, $.module))),
        optional(","),
        "]",
      ),
    requires: ($) =>
      choice(
        seq("requires", "{", optional($.requires_entries), "}"),
        seq("requires", "{", "}", "{", sep_tail($.typed_ident, ","), "}"),
      ),

    requires_entries: ($) =>
      seq($.requires_entry, repeat(prec.left(3, seq(",", $.requires_entry))), optional(",")),

    requires_entry: ($) => prec(2, choice($.typed_ident, $.requires_for_clause)),

    requires_for_clause: ($) =>
      seq(
        "[",
        sep_tail(seq($.module, ":", $.bound_variable), ","),
        "]",
        "for",
        $.identifier,
        ":",
        $._type_annotation,
      ),

    //####-------###
    //#### TYPES ###
    //####-------###

    annotation_type_def: ($) => seq($.annotation_pre_colon, ":", $._type_annotation),
    alias_type_def: ($) => seq($.apply_type, ":", field("body", $._type_annotation)),

    opaque_type_def: ($) =>
      seq(
        $.apply_type,
        alias("::", $.double_colon),
        $._type_annotation,
        optional($.nominal_methods),
      ),

    // Nominal types: `Name := Type.{ methods }`
    // Use a tight ".{" token so this doesn't conflict with `Type.Module` paths.
    nominal_type_def: ($) =>
      seq(
        $.apply_type,
        alias(":=", $.colon_equals),
        $._type_annotation,
        optional($.nominal_methods),
      ),

    // Nominal method blocks: `.{ ... }`
    // Allow any top-level items (defs, types, expects, expressions) inside.
    // Keep the grammar tight to avoid conflicts with module paths like `Type.Module`.
    nominal_methods: ($) => seq(token.immediate(".{"), repeat($._module_elem), "}"),

    _type_annotation: ($) => prec.left(choice($.where_implements, $._non_atomic_type)),
    _non_atomic_type: ($) => choice($.function_type, $._atomic_type),

    _atomic_type: ($) =>
      choice(
        $.parenthesized_type,
        $.record_type,
        $.apply_type,
        // $.where_implements,
        // $.implements_implementation,
        $.tags_type,
        $.bound_variable,
        $.inferred,
        "*",
        $.tuple_type,
      ),

    function_type: ($) =>
      seq(
        choice(seq("(", ")"), sep1(field("param", $._atomic_type), ",")),
        choice($.arrow, $.fat_arrow),
        $._atomic_type,
      ),

    parenthesized_type: ($) => seq("(", $._type_annotation, ")"),
    tuple_type: ($) => seq("(", $._type_annotation, ",", sep1_tail($._type_annotation, ","), ")"),

    // Static dispatch constraints: `Type where [a.to_str : a -> b]`.
    // This attaches a constraint list to any type annotation or function type.
    where_implements: ($) =>
      prec.right(
        seq(
          field("type", choice($._atomic_type, $.function_type)),
          alias("where", $.where),
          field("implements", $.static_dispatch_list),
        ),
      ),

    static_dispatch_list: ($) => seq("[", sep_tail($.static_dispatch, ","), "]"),

    static_dispatch: ($) => seq($.static_dispatch_target, ":", $.function_type),

    static_dispatch_target: ($) => seq($.bound_variable, ".", $.identifier),
    spread_type: ($) => seq("..", optional($.type_variable)),
    tags_type: ($) => seq("[", sep_tail(choice($._tags_only, $.spread_type), ","), "]"),

    _tags_only: ($) => seq(sep1(choice($.tag_type), ",")),

    tag_type: ($) => seq(field("name", $._upper_identifier), optional($._apply_type_args)),
    type_variable: ($) => choice($.bound_variable),

    bound_variable: ($) => alias(token(/_*[\p{Ll}][\p{XID_Continue}]*/), $.bound_variable),

    inferred: ($) => alias(token("_"), $.inferred),

    apply_type: ($) => prec.right(seq($.concrete_type, optional($._apply_type_args))),

    //GOOD
    concrete_type: ($) =>
      prec.right(
        PREC.TYPEALIAS,
        seq($._upper_identifier, repeat(prec(PREC.TYPEALIAS, seq(".", $._upper_identifier)))),
      ),

    //we need a n optional \n to stop this eating the value that follows it
    _apply_type_args: ($) =>
      field(
        "type_args",
        prec.right(seq(imm("("), prec.right(PREC.ARGS, sep1_tail($.apply_type_arg, ",")), ")")),
      ),

    apply_type_arg: ($) => prec.left(choice($._atomic_type, $.function_type)),

    typed_ident: ($) => seq($.identifier, ":", $._type_annotation),

    record_type: ($) => seq("{", sep_tail(choice($.record_field_type, $.spread_type), ","), "}"),

    record_field_type: ($) =>
      choice(
        seq($._record_type_field_name, alias("?:", $.optional_field), $._type_annotation),
        seq(
          $._record_type_field_name,
          ":",
          alias($.record_function_type, $.function_type),
          optional(seq(alias("??", $.default_value), $.expr_body)),
        ),
        seq(
          $._record_type_field_name,
          ":",
          $._type_annotation,
          optional(seq(alias("??", $.default_value), $.expr_body)),
        ),
      ),
    // A distinct nonterminal lets GLR retain a comma as a function parameter
    // separator instead of prematurely ending the surrounding record field.
    // Unlike the old workaround, punctuation, trivia, and arrows remain
    // separate tokens with accurate source ranges.
    record_function_type: ($) =>
      seq(
        choice(seq("(", ")"), sep1(field("param", $._atomic_type), $._record_function_param_comma)),
        choice($.arrow, $.fat_arrow),
        $._atomic_type,
      ),
    _record_type_field_name: ($) => choice($.field_name, alias("_", $.field_name)),
    /** can be used to make tag unions or records open*/

    annotation_pre_colon: ($) =>
      choice(
        //TODO implimeent apply $.apply,
        //tag seems not needed when we have alias
        // $.tag,
        $.identifier,
      ),

    //##------------##
    //##-- consts --##
    //##------------##

    const: ($) =>
      choice(
        $.negative_number,
        $._unsigned_number,
        $.char,
        $.typed_string,
        $.string,
        $.multiline_string,
        "false",
        "true",
        // $.unit,
      ),

    _unsigned_number: ($) =>
      choice(
        // Dot-suffix literals must come before their unsuffixed prefixes.
        $.number_with_suffix,
        $.float,
        $.xint,
        $.int,
      ),

    // Roc lexes signed numerals as one token. A narrow external binary-minus
    // token handles the overlapping no-space subtraction form `value-1`.
    negative_number: ($) =>
      choice(
        alias(token(seq("-", numberWithSuffixLiteral())), $.number_with_suffix),
        alias(token(seq("-", floatLiteral())), $.float),
        alias(token(seq("-", HEX_INTEGER)), $.xint),
        alias(token(seq("-", OCTAL_INTEGER)), $.xint),
        alias(token(seq("-", BINARY_INTEGER)), $.xint),
        alias(token(seq("-", DECIMAL_INTEGER)), $.int),
      ),

    //STRINGS
    typed_string: ($) =>
      choice(
        seq($.string, $.literal_type_suffix),
        seq($.multiline_string, alias($.multiline_literal_type_suffix, $.literal_type_suffix)),
      ),
    literal_type_suffix: ($) => imm(/\.[\p{Lu}][\p{XID_Continue}]*/),
    multiline_literal_type_suffix: ($) => /\.[\p{Lu}][\p{XID_Continue}]*/,
    string: ($) =>
      seq('"', repeat(choice(imm(prec(0, /[^\n\\"]/)), $.interpolation_char, $.escape_char)), '"'),

    multiline_string: ($) =>
      prec.right(
        repeat1(
          seq(
            "\\\\",
            repeat(choice(imm(prec(0, /[^\\\n]/)), $.interpolation_char, $.escape_char)),
            $._newline,
          ),
        ),
      ),

    escape_char: ($) => imm(/\\([\\"\'ntbrafv]|(\$\{))|(\\u\([0-9A-Fa-f]{1,8}\))/),
    interpolation_char: ($) =>
      seq(
        imm("${"), //This is the new interpolation syntax
        $._expr_inner,
        "}",
      ),
    string_pattern: ($) =>
      seq(
        '"',
        repeat($._string_pattern_char),
        $.string_pattern_capture,
        repeat(choice($._string_pattern_char, $.string_pattern_capture)),
        '"',
      ),
    _string_pattern_char: ($) => choice(imm(prec(0, /[^\n\\"$]/)), imm("$"), $.escape_char),
    string_pattern_capture: ($) => seq(imm("${"), $._pattern, "}"),
    _simple_string_char: ($) => /[^\t\r\u0008\a\f\v\\"]/,
    _simple_char_char: ($) => imm(/[^\n\t\r\u0008\a\f\v'\\]/),
    char: ($) => seq("'", choice($.escape_char, $._simple_char_char), imm("'")),

    //NUMBERS
    int: ($) => token(DECIMAL_INTEGER),
    // Modern numeric suffixes use an immediate `.UpperType`, including custom
    // numeric types. The compiler tokenizes the numeric core and suffix together.
    number_with_suffix: ($) => token(numberWithSuffixLiteral()),

    float: ($) => token(floatLiteral()),
    _hex_int: ($) => token(HEX_INTEGER),
    _ocal_int: ($) => token(OCTAL_INTEGER),
    _binary_int: ($) => token(BINARY_INTEGER),
    xint: ($) => choice($._binary_int, $._hex_int, $._ocal_int),

    //PRIMATIVES
    arrow: ($) => "->",
    fat_arrow: ($) => "=>",
    field_name: ($) => alias($.identifier, $.field_name),

    long_identifier: ($) =>
      prec.right(PREC.FIELD_ACCESS_START + 1, seq(repeat(seq($.module, imm("."))), $.identifier)),
    _long_upper_identifier: ($) =>
      prec.right(seq(repeat(seq($.module, imm("."))), alias($._upper_identifier, $.identifier))),
    ident: ($) => choice($.identifier, $.module),

    identifier: ($) =>
      choice(
        token(prec(101, /\$?_*[\p{Ll}][\p{XID_Continue}]*!/)),
        token(prec(101, /\$?_+[\p{Ll}][\p{XID_Continue}]*/)),
        prec(100, seq(optional("$"), $._lower_identifier)),
      ),

    _lower_identifier: ($) => /[\p{Ll}][\p{XID_Continue}]*/,

    _upper_identifier: ($) => /[\p{Lu}][\p{XID_Continue}]*/,
    tag: ($) => $._long_upper_identifier,
    module: ($) => $._upper_identifier,
    backslash: ($) => "\\",

    doc_comment: ($) => token(prec(-1, /##[^\n]*/)),
    line_comment: ($) => token(prec(-1, /#[^\n]*/)),

    suffix_operator: ($) => alias($.suffix_operator_identifier, $.suffix_operator),
    suffix_operator_identifier: ($) => imm("?"),

    operator: ($) => alias($.operator_identifier, $.operator),
    _non_pipe_operator: ($) => alias($._non_pipe_operator_identifier, $.operator),
    operator_identifier: ($) => choice("|>", $._non_pipe_operator_identifier),
    _non_pipe_operator_identifier: ($) =>
      choice(
        "and",
        "or",
        "&&",
        "||",
        "+",
        "*",
        "-",
        "//",
        "/",
        "<=",
        "<",
        ">=",
        ">",
        "^",
        "%",
        "..<",
        "..=",
        "->",
        "==",
        "!=",
        alias($._tight_binary_minus, "-"),
        token(prec(1, "??")),
        "?",
      ),
  },
});

function decimalFractionLiteral() {
  return seq(DECIMAL_INTEGER, ".", DECIMAL_INTEGER, optional(EXPONENT));
}

function floatLiteral() {
  return choice(
    seq(decimalFractionLiteral(), optional(choice("f32", "f64"))),
    seq(DECIMAL_INTEGER, EXPONENT, optional(choice("f32", "f64"))),
  );
}

function numberWithSuffixLiteral() {
  return seq(
    choice(
      HEX_INTEGER,
      OCTAL_INTEGER,
      BINARY_INTEGER,
      decimalFractionLiteral(),
      seq(DECIMAL_INTEGER, EXPONENT),
      DECIMAL_INTEGER,
    ),
    imm(/\./),
    imm(NUMERIC_TYPE_NAME),
  );
}

function sep1(rule, separator) {
  return seq(rule, repeat(seq(separator, rule)));
}
function sep1end(rule, separator, end) {
  return seq(repeat(seq(rule, separator)), end);
}
function sep1_tail(rule, separator) {
  return seq(rule, repeat(seq(separator, rule)), optional(separator));
}
function sep_tail(rule, separator) {
  return optional(sep1_tail(rule, separator));
}

function imm(x) {
  return token.immediate(x);
}
