const PREC = {
	FIELD_ACCESS_START: 0,
	WHERE_IMPLEMENTS: 1,
	PATTERN: 0,
	TAG: 1,
	FUNCTION_START: 1,
	PART: 1,
	TYPEALIAS: 2,
	FUNC: 10,
	IMPORT: 20,
};

module.exports = grammar({
	name: "roc",

	// Tell tree-sitter which token represents identifiers, so keywords like 'if' are properly reserved
	word: ($) => $._lower_identifier,

	// The external scanner (scanner.cc) allows us to inject "dummy" tokens into the grammar.
	// These tokens are used to track the indentation-based scoping used in Roc

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
	],

	extras: ($) => [
		$.line_comment,
		$.doc_comment,
		/[\s\f\uFEFF\u2060\u200B]/,
	],

	conflicts: ($) => [
		[$._function_call_target, $._atom_expr],
		[$.function_call_expr],
		[$._pattern, $._atom_expr],
		[$._atomic_pattern, $._atom_expr],
		[$.tag_pattern, $.tag_expr],
		[$.record_pattern, $.record_expr],
		[$.record_field_pattern, $.record_field_expr],
		[$.identifier_pattern, $.long_identifier],
		[$.list_pattern, $.list_expr],
		[$._module_elem, $.value_declaration],
		[$._module_elem, $._expr_inner],
		//Introduced because of the bang expression
		[$._atom_expr, $.expr_body],
		[$._atom_expr],
		// Block body conflicts (for lambda bodies with { })
		[$.long_identifier, $.record_field_expr, $.record_field_pattern],
		[$.record_field_expr, $.record_field_builder, $.record_field_pattern, $.annotation_pre_colon],
		// Type arguments vs parenthesized type: List(a) vs (Type)
		[$.parenthesized_type, $.paren_type_args],
		[$.tuple_type, $.paren_type_args],
		// Method type annotations conflicts
		[$.parenthesized_type, $.method_paren_type_args],
		[$.tuple_type, $.method_paren_type_args],
		[$._method_type_annotation_no_fun, $._type_annotation_no_fun],
		[$._method_type_annotation, $._method_type_annotation_paren_fun],
		[$.method_apply_type, $.apply_type],
		// Conflict between qualified type name (Module.Type) and nominal_methods start (.{)
		[$.concrete_type],
		// Spread patterns in lists vs range pattern
		[$.list_spread_pattern, $.range_pattern],
	],

	inline: ($) => [
		$._type_annotation_paren_fun,
		$.module,
		$.tag,
		$.field_name,
		$.bound_variable,
		$.operator,
		$.variable_expr,
		$.inferred,
	],

	rules: {
		file: ($) =>
			seq(
				optional(seq($._header, $._end_newline)),
				repeat1(seq($._module_elem, $._end_newline)),
			),
		_module_elem: ($) =>
			choice(
				$.annotation_type_def,
				$.alias_type_def,
				$.nominal_type_def,
				$.expect,
				$.value_declaration,
				$.expr_body,
				$.import_expr,
				$.import_file_expr,
			),

		expect: ($) => prec(1, seq("expect", field("body", $.expr_body))),
		value_declaration: ($) =>
			prec(
				0,
				seq(
					optional(seq($.annotation_type_def, $._end_newline)),
					alias($._assigment_pattern, $.decl_left),
					"=",
					field("body", alias($.expr_body_terminal, $.expr_body)),
				),
			),

		expr_body: ($) =>
			choice(
				seq(
					$._indent,
					field(
						"declarations",
						repeat(
							choice(
								$.value_declaration,
								$.var_declaration,
								$.backpassing_expr,
								$.dbg_expr,
								$.bang_expr,
								$.for_expr,
							),
						),
					),
					field("result", $._expr_inner),
					$._dedent,
				),
				seq(
					repeat(choice($.value_declaration, $.var_declaration, $.backpassing_expr, $.dbg_expr, $.for_expr)),
					field("result", $._expr_inner),
				),
			),

		/**
		An expression body that should contain a newline after, like within a value declaration
		*/
		expr_body_terminal: ($) =>
			choice(
				seq(
					$._indent,
					field(
						"declarations",
						repeat(
							choice(
								$.value_declaration,
								$.var_declaration,
								$.backpassing_expr,
								$.dbg_expr,
								$.bang_expr,
								$.for_expr,
							),
						),
					),
					field("result", $._expr_inner),
					$._dedent,
				),
				seq(
					repeat(choice($.value_declaration, $.var_declaration, $.backpassing_expr, $.dbg_expr, $.for_expr)),
					field("result", $._expr_inner),
					choice($._dedent, $._end_newline),
				),
			),

		// Mutable variable declaration: var $name = value
		var_declaration: ($) =>
			seq(
				"var",
				alias($.var_identifier, $.decl_left),
				"=",
				field("body", $._expr_inner),
			),

		// Mutable variable identifier: $name
		var_identifier: ($) => /\$[a-z][0-9a-zA-Z_]*/,

		// For loop: for item in collection { body }
		for_expr: ($) =>
			seq(
				"for",
				field("binding", $._atomic_pattern),
				"in",
				field("collection", $._expr_inner),
				"{",
				field("body", repeat(choice($.value_declaration, $.var_declaration, $.var_assignment))),
				"}",
			),

		// Variable reassignment: $name = value
		var_assignment: ($) =>
			seq(
				$.var_identifier,
				"=",
				field("value", $._expr_inner),
			),

		_atom_expr: ($) =>
			choice(
				$.anon_fun_expr,
				$.const,
				$.record_expr,
				$.record_update_expr,
				$.if_expr,
				$.match_expr,
				$.variable_expr,
				$.parenthesized_expr,
				$.operator_as_function_expr,
				$.tag_expr,
				$.tuple_expr,
				$.list_expr,
				$.bang_expr,
				$.field_access_expr,
				$.crash_expr,
				$.var_identifier,
			),

		// Crash/unimplemented placeholder: ...
		crash_expr: ($) => "...",

		// Return expression for early returns
		return_expr: ($) => seq("return", $._expr_inner),

		_call_or_atom: ($) => choice($.function_call_expr, $.method_call_expr, $.pipe_call_expr, $._atom_expr),
		_expr_inner: ($) =>
			choice(
				$.prefixed_expression,
				$.bin_op_expr,
				$._call_or_atom,
				$.import_expr,
				$.import_file_expr,
				$.return_expr,
			),

		// Prefix operators: ! (NOT) and - (negation)
		prefixed_expression: ($) => prec.left(seq(choice("!", "-"), $._call_or_atom)),
		dbg_expr: ($) => seq("dbg", alias($.expr_body_terminal, $.expr_body)),

		variable_expr: ($) => alias($.long_identifier, $.variable_expr),
		long_identifier: ($) => seq(repeat(seq($.module, ".")), $.identifier),
		parenthesized_expr: ($) => seq("(", field("expression", $.expr_body), ")"),
		// If expression: if cond { block } else { block }
		if_expr: ($) =>
			seq(
				"if",
				field("guard", $._expr_inner),
				field("then", choice(prec.dynamic(25, $.block_body), prec.dynamic(5, $.expr_body))),
				repeat($.else_if),
				$.else,
			),
		else_if: ($) =>
			prec.left(
				seq(
					"else",
					"if",
					field("guard", $._expr_inner),
					field("then", choice(prec.dynamic(25, $.block_body), prec.dynamic(5, $.expr_body))),
				),
			),
		else: ($) =>
			seq("else", field("else", choice(prec.dynamic(25, $.block_body), prec.dynamic(5, $.expr_body)))),
		backpassing_expr: ($) =>
			seq(
				field("assignee", $._assigment_pattern),
				$.back_arrow,
				field("value", $._expr_inner),
				$._end_newline,
			),
		_field_access_start: ($) =>
			prec(
				PREC.FIELD_ACCESS_START,
				choice(
					$.variable_expr,
					$.parenthesized_expr,
					$.record_expr,
					$.record_update_expr,
					$.method_call_expr,
					$.const,
					$.list_expr,
					$.tuple_expr,
				),
			),
		field_access_expr: ($) =>
			prec.left(
				seq(
					field("target", $._field_access_start),
					repeat1(seq(".", $.identifier)),
				),
			),

		// Method call with parentheses: expr.method() or expr.method(args)
		method_call_expr: ($) =>
			prec.left(
				PREC.FUNC,
				seq(
					field("target", $._field_access_start),
					repeat(seq(".", $.identifier)),
					".",
					field("method", $.identifier),
					"(",
					optional(sep1_tail($._expr_inner, ",")),
					")",
				),
			),

		// Pipe call syntax: expr->function(args) - calls function with expr as first arg
		pipe_call_expr: ($) =>
			prec.left(
				PREC.FUNC,
				seq(
					field("target", $._field_access_start),
					"->",
					field("function", $.identifier),
					"(",
					optional(sep1_tail($._expr_inner, ",")),
					")",
				),
			),

		function_call_expr: ($) =>
			prec.dynamic(
				PREC.FUNC,
				seq(
					field("caller", $._function_call_target),
					field("args", repeat1($._atom_expr)),
				),
			),
		operator_as_function_expr: ($) => $._operator_as_function_inner,

		_operator_as_function_inner: ($) =>
			seq("(", field("operator", $.operator_identifier), ")"),

		_function_call_target: ($) =>
			choice(
				$.field_access_expr,
				$.variable_expr,
				$.operator_as_function_expr,
				$.parenthesized_expr,
			),
		bin_op_expr: ($) =>
			field(
				"part",
				prec(
					PREC.PART,
					seq(
						$._call_or_atom,
						prec.right(repeat1(seq($.operator, $._call_or_atom))),
					),
				),
			),
		bang_expr: ($) => prec(PREC.PART, seq($._atom_expr, "!")),

		// Modern match expression: match expr { pattern => result ... }
		match_expr: ($) =>
			seq(
				"match",
				field("target", $._expr_inner),
				"{",
				repeat($.match_branch),
				"}",
			),

		match_branch: ($) =>
			seq(
				field("pattern", $._pattern),
				optional(seq("if", alias($._expr_inner, $.guard))),
				"=>",
				field("expr", $._expr_inner),
			),

		tag_expr: ($) =>
			prec.left(
				PREC.TAG,
				seq(
					choice(
						$.opaque_tag,
						$.tag,
						// Qualified tag: Module.Tag
						seq($.module, ".", $.tag),
					),
					repeat($._atom_expr),
				),
			),
		anon_fun_expr: ($) =>
			prec.left(
				seq(
					"|",
					optional($.argument_patterns),
					"|",
					choice($.block_body, $.expr_body),
					optional($._newline),
				),
			),

		// Block body with curly braces: { declarations... result }
		block_body: ($) =>
			prec.dynamic(
				20, // Higher precedence than record patterns
				seq(
					"{",
					field(
						"statements",
						repeat(choice(
							$.block_declaration,
							$.var_declaration,
							$.for_expr,
							$.var_assignment,
							$.expect,
							// Allow effectful expressions as statements
							$.block_statement,
						)),
					),
					field("result", $._expr_inner),
					"}",
				),
			),

		// Effectful expression as a statement in a block (ends with ! or is a function call)
		block_statement: ($) =>
			prec.dynamic(
				-1, // Lower precedence than declarations
				$._expr_inner,
			),

		// Simplified value declaration for use inside block bodies
		block_declaration: ($) =>
			seq(
				alias($._assigment_pattern, $.decl_left),
				"=",
				field("body", $._expr_inner),
			),

		//RECORDS

		record_field_expr: ($) =>
			prec.right(seq($.field_name, optional(seq(":", $.expr_body)))),
		record_field_builder: ($) =>
			seq($.field_name, seq(":", "<-", choice($.function_call_expr, $._function_call_target))),

		record_expr: ($) =>
			prec.dynamic(
				10, // Lower than block_body's 20, so { x } prefers block
				seq(
					"{",
					optional($.record_update_ext),
					sep_tail(choice($.record_field_expr, $.record_field_builder), ","),
					"}",
				),
			),

		// Modern record update prefix: { ..person, field: value }
		record_update_ext: ($) => seq("..", $._expr_inner, ","),

		// Old style record update: { person & field: value }
		record_update_expr: ($) =>
			seq("{", $.identifier, "&", sep1_tail($.record_field_expr, ","), "}"),

		list_expr: ($) =>
			seq("[", optional(sep1_tail(field("exprList", $._expr_inner), ",")), "]"),

		tuple_expr: ($) =>
			seq(
				"(",
				optional_indent(
					seq(
						field("expr", $._expr_inner),
						",",
						sep1_tail(field("expr", $._expr_inner), ","),
					),
					$,
				),
				")",
			),

		// PATTERNS
		_pattern: ($) =>
			choice(
				alias("_", $.wildcard_pattern),
				alias($.const, $.const_pattern),
				$.identifier_pattern,
				$.as_pattern,
				$.disjunct_pattern,
				$.conjunct_pattern,
				$.paren_pattern,
				$.list_pattern,
				$.tag_pattern,
				$.record_pattern,
				$.tuple_pattern,
				$.range_pattern,
			),

		identifier_pattern: ($) => $.identifier,
		as_pattern: ($) => prec.left(0, seq($._pattern, "as", $.identifier)),
		disjunct_pattern: ($) => prec.left(0, seq($._pattern, "|", $._pattern)),
		conjunct_pattern: ($) => prec.left(0, seq($._pattern, "&", $._pattern)),

		paren_pattern: ($) => seq("(", $._pattern, ")"),
		range_pattern: ($) =>
			prec.left(0, seq("..", optional(seq("as", $.identifier)))),

		tag_pattern: ($) =>
			prec.left(
				PREC.TAG,
				seq(choice($.opaque_tag, $.tag), repeat($._atomic_pattern)),
			),
		tuple_pattern: ($) =>
			prec.right(
				seq(
					"(",
					$._atomic_pattern,
					",",
					repeat(prec.right(seq($._atomic_pattern, ","))),
					$._atomic_pattern,
					")",
				),
			),

		argument_patterns: ($) =>
			seq($._atomic_pattern, repeat(seq(",", $._atomic_pattern))),
		_atomic_pattern: ($) =>
			choice(
				alias("_", $.wildcard_pattern),
				$.const,
				$.identifier_pattern,
				$.list_pattern,
				$.tuple_pattern,
				$.record_pattern,
				$.tag_pattern,
				$.range_pattern,
				seq("(", $._pattern, ")"),
			),
		_assigment_pattern: ($) =>
			choice(
				alias("_", $.wildcard_pattern),
				$.identifier_pattern,
				$.list_pattern,
				$.tuple_pattern,
				$.record_pattern,
			),

		list_pattern: ($) =>
			choice(
				seq("[", "]"),
				seq(
					"[",
					sep1_tail(choice($._atomic_pattern, $.list_spread_pattern), ","),
					"]",
				),
			),

		// Spread pattern in lists: [.., x] or [x, ..] or [.. as rest]
		list_spread_pattern: ($) =>
			prec(10, seq("..", optional(seq("as", $.identifier)))),

		record_pattern: ($) =>
			seq(
				"{",
				sep_tail(
					choice(
						$.record_field_pattern,
						$.record_field_optional_pattern,
					),
					",",
				),
				"}",
			),
		record_field_optional_pattern: ($) => seq($.field_name, "?", $.expr_body),
		record_field_pattern: ($) =>
			seq($.field_name, optional(seq(":", $._atomic_pattern))),

		// HEADERS
		_header: ($) =>
			choice(
				$.app_header,
				$.platform_header,
				$.module_header,
				$.package_header,
			),
		package_header: ($) => seq("package", $.provides_list, $.packages_list),
		app_header: ($) => seq("app", $.provides_list, $.packages_list),
		platform_header: ($) =>
			seq(
				"platform",
				alias($.string, $.name),
				$._indent,
				$.platform_header_body,
				$._dedent,
			),
		platform_header_body: ($) =>
			sep1(
				choice(
					$.requires,
					$.exposes,
					$.packages,
					$.imports,
					$.provides,
					$.effects,
				),
				"\n",
			),

		module_header: ($) => seq("module", $.exposes_list),

		packages: ($) => seq("packages", $.record_pattern),

		packages_list: ($) =>
			seq("{", sep_tail(choice($.package_ref, $.platform_ref), ","), "}"),
		package_ref: ($) => seq($.identifier, ":", $.string),
		platform_ref: ($) =>
			seq($.identifier, ":", "platform", alias($.string, $.package_uri)),

		exposed_list: ($) => seq("{", sep_tail($.ident, ","), "}"),
		exposes: ($) => seq("exposes", $.exposes_list),
		exposes_list: ($) => seq("[", sep_tail($.ident, ","), "]"),
		import_expr: ($) =>
			prec(
				PREC.IMPORT,
				seq(
					"import",
					optional(seq($.identifier, ".")),
					sep1($.module, "."),
					optional(
						choice(
							alias(seq("exposing", $.exposes_list), $.exposing),
							seq(alias("as", $.as), $.module),
						),
					),
				),
			),
		import_file_expr: ($) =>
			prec(
				PREC.IMPORT,
				seq("import", $.string, seq("as", $.identifier, ":", $.concrete_type)),
			),
		imports: ($) => seq("imports", "[", sep_tail($.imports_entry, ","), "]"),
		imports_entry: ($) =>
			seq(
				choice(
					seq(
						optional(seq($.identifier, ".")),
						seq($.module, repeat(seq(".", $.module))),
						optional(seq(".", $.exposed_list)),
					),
					alias($.string, $.import_path),
				),
				optional(
					seq(alias("as", $.import_as), $.identifier, ":", $._type_annotation),
				),
			),
		to: ($) => "to",
		provides: ($) =>
			seq(
				"provides",
				"[",
				optional($.ident),
				repeat(seq(",", $.ident)),
				optional(","),
				"]",
				optional(seq($.to, choice($.string, $.ident))),
			),
		provides_list: ($) =>
			seq(
				"[",
				optional($.ident),
				repeat(seq(",", $.ident)),
				optional(","),
				"]",
			),
		requires: ($) =>
			seq("requires", $.requires_rigids, "{", $.typed_ident, "}"),

		requires_rigids: ($) =>
			seq(
				"{",
				optional(
					seq(
						$.requires_rigid,
						repeat(seq(",", $.requires_rigid)),
						optional(","),
					),
				),
				"}",
			),

		requires_rigid: ($) =>
			seq($.identifier, optional(seq("=>", $._upper_identifier))),

		// TYPES
		annotation_type_def: ($) =>
			seq($.annotation_pre_colon, ":", $._type_annotation),
		alias_type_def: ($) =>
			seq($.apply_type, ":", field("body", $._type_annotation)),
		// Nominal types: `Name :: Type` (simple) or `Name := Type.{ methods }`
		nominal_type_def: ($) =>
			seq(
				$.apply_type,
				choice(alias("::", $.double_colon), alias(":=", $.colon_equals)),
				$._type_annotation,
				optional($.nominal_methods),
			),

		// Method block for nominal types: `.{ method_def ... }`
		nominal_methods: ($) =>
			seq(
				".",
				token.immediate("{"),
				repeat($._method_member),
				"}",
			),

		// Members inside nominal methods block - either type annotation or implementation
		_method_member: ($) =>
			choice(
				$.method_annotation,
				$.method_declaration,
			),

		// Type annotation inside method block (uses restricted types that don't allow space-separated args)
		method_annotation: ($) =>
			seq(
				alias($.annotation_pre_colon, $.annotation_pre_colon),
				":",
				$._method_type_annotation,
			),

		// Method implementation inside nominal type: `name = expr`
		method_declaration: ($) =>
			seq(
				alias($._assigment_pattern, $.decl_left),
				"=",
				field("body", $._expr_inner),
			),

		// Restricted type annotations for method blocks - only parenthesized type args allowed
		_method_type_annotation: ($) =>
			prec.left(
				choice(
					seq(
						$._indent,
						choice($._method_type_annotation_no_fun, $.method_function_type),
						$._dedent,
					),
					choice($._method_type_annotation_no_fun, $.method_function_type),
				),
			),

		method_function_type: ($) =>
			seq(
				sep1(field("param", $._method_type_annotation_paren_fun), ","),
				$._function_arrow,
				sep1($._method_type_annotation_paren_fun, $._function_arrow),
			),

		_method_type_annotation_paren_fun: ($) =>
			choice(
				$._method_type_annotation_no_fun,
				alias(seq("(", $.method_function_type, ")"), $.type_annotation_paren),
			),

		_method_type_annotation_no_fun: ($) =>
			choice(
				alias(seq("(", $._method_type_annotation, ")"), $.parenthesized_type),
				$.record_type,
				$.method_apply_type,  // Uses restricted apply_type
				$.where_clause,
				$.tags_type,
				$.bound_variable,
				$.inferred,
				alias($._method_tuple_type, $.tuple_type),
			),

		_method_tuple_type: ($) =>
			seq(
				"(",
				$._method_type_annotation,
				",",
				sep1_tail($._method_type_annotation, ","),
				")",
			),

		// Apply type that only allows parenthesized args (no space-separated)
		// High precedence to win over regular apply_type in method contexts
		method_apply_type: ($) =>
			prec.right(200, seq($.concrete_type, optional($.method_paren_type_args))),

		method_paren_type_args: ($) =>
			prec.dynamic(
				100,
				prec.right(
					100,
					seq(
						"(",
						$._method_type_annotation,
						repeat(prec.right(100, seq(",", $._method_type_annotation))),
						optional(","),
						")",
					),
				),
			),

		_type_annotation: ($) =>
			prec.left(
				choice(
					seq(
						$._indent,
						choice($._type_annotation_no_fun, $.function_type),
						$._dedent,
					),
					choice($._type_annotation_no_fun, $.function_type),
				),
			),

		_type_annotation_paren_fun: ($) =>
			choice(
				$._type_annotation_no_fun,
				alias(seq("(", $.function_type, ")"), $.type_annotation_paren),
			),

		// Helper for either pure (->) or effectful (=>) arrows
		_function_arrow: ($) => choice($.arrow, $.effect_arrow),

		function_type: ($) =>
			seq(
				sep1(field("param", $._type_annotation_paren_fun), ","),
				$._function_arrow,
				sep1($._type_annotation_paren_fun, $._function_arrow),
			),

		parenthesized_type: ($) => seq("(", $._type_annotation, ")"),
		_type_annotation_no_fun: ($) =>
			choice(
				$.parenthesized_type,
				$.record_type,
				$.apply_type,
				$.where_clause,
				$.tags_type,
				$.bound_variable,
				$.inferred,
				$.wildcard,
				$.tuple_type,
			),
		tuple_type: ($) =>
			seq(
				"(",
				$._type_annotation,
				",",
				sep1_tail($._type_annotation, ","),
				")",
			),

		// Where clause: Type where [a.method : a -> Str]
		where_clause: ($) =>
			prec.right(
				seq(
					$._type_annotation_no_fun,
					alias("where", $.where),
					"[",
					sep1_tail($.where_constraint, ","),
					"]",
				),
			),
		// Where constraint: a.method : a -> Str
		where_constraint: ($) =>
			seq(
				$.bound_variable,
				".",
				$.identifier,
				":",
				$._type_annotation,
			),

		tags_type: ($) => seq("[", optional($._tags_only), "]"),

		_tags_only: ($) =>
			choice(
				// Open tag union: [A, B, ..] or [A, B, ..others]
				seq(
					$.apply_type,
					repeat(seq(",", $.apply_type)),
					",",
					$.open_tag_union,
				),
				// Closed tag union: [A, B, C]
				seq(
					$.apply_type,
					repeat(seq(",", $.apply_type)),
					optional(","),
				),
				// Just open: [..]
				$.open_tag_union,
			),

		// Open tag union marker: .. or ..typevar
		open_tag_union: ($) =>
			seq("..", optional($.bound_variable)),

		bound_variable: ($) => alias($._lower_identifier, $.bound_variable),

		wildcard: ($) => "*",

		inferred: ($) => alias("_", $.inferred),

		apply_type: ($) =>
			prec.right(seq($.concrete_type, optional($.apply_type_args))),

		concrete_type: ($) =>
			prec(
				PREC.TYPEALIAS,
				seq(
					$._upper_identifier,
					repeat(prec(PREC.TYPEALIAS, seq(".", $._upper_identifier))),
				),
			),

		// Type arguments: List(a, b) or List a b (space-separated for backwards compat)
		apply_type_args: ($) =>
			choice(
				// New parenthesized syntax: List(a, b)
				$.paren_type_args,
				// Old space-separated syntax: List a b
				prec.right(repeat1($.apply_type_arg)),
			),

		paren_type_args: ($) =>
			prec.dynamic(
				100,
				prec.right(
					100,
					seq(
						"(",
						$._type_annotation,
						repeat(prec.right(100, seq(",", $._type_annotation))),
						optional(","),
						")",
					),
				),
			),

		apply_type_arg: ($) => prec.left($._type_annotation_no_fun),

		typed_ident: ($) => seq($.identifier, ":", $._type_annotation),

		record_type: ($) =>
			seq(
				"{",
				sep_tail(
					choice($.record_field_type, $.record_field_type_optional),
					",",
				),
				"}",
			),

		record_field_type: ($) => seq($.field_name, ":", $._type_annotation),
		record_field_type_optional: ($) =>
			seq($.field_name, "?", $._type_annotation),

		annotation_pre_colon: ($) => $.identifier,

		effects: ($) =>
			seq("effects", $.effect_name, $.record_type),

		effect_name: ($) => seq($.identifier, ".", $._upper_identifier),

		// CONSTANTS
		const: ($) =>
			choice(
				$.float,
				$.xint,
				$.decimal,
				$.natural,
				$.uint,
				$.iint,
				$.char,
				$.string,
				$.multiline_string,
				$.line_string,
				$.int,
				"false",
				"true",
			),

		// STRINGS
		string: ($) =>
			seq(
				'"',
				repeat(
					choice(imm(prec(0, /[^\n\\"]/)), $.interpolation_char, $.escape_char),
				),
				'"',
			),

		multiline_string: ($) =>
			seq(
				'"""',
				repeat(
					choice(imm(prec(0, /[^\\]/)), $.interpolation_char, $.escape_char),
				),
				'"""',
			),

		// Line-prefix multiline string: \\Line 1\n\\Line 2
		line_string: ($) =>
			prec.right(
				repeat1($.line_string_segment),
			),

		line_string_segment: ($) =>
			seq(
				"\\\\",
				repeat(
					choice(
						imm(prec(0, /[^\n\\$]+/)),
						$.interpolation_char,
						$.escape_char,
					),
				),
			),

		// Escape sequences including unicode: \n, \t, \u(XXXX), etc.
		escape_char: ($) => imm(/\\([\\"\'ntbrafv]|u\([0-9a-fA-F]+\))/),
		// String interpolation: ${expr}
		interpolation_char: ($) =>
			seq(
				imm(/\$\{/),
				$._expr_inner,
				"}",
			),
		_simple_char_char: ($) => imm(/[^\n\t\r\u0008\a\f\v'\\]/),
		char: ($) => seq("'", choice($.escape_char, $._simple_char_char), imm("'")),

		// NUMBERS
		int: ($) => token(seq(/[0-9][0-9_]*/)),
		uint: ($) => token(seq(/[0-9][0-9_]*/, imm(/u(32|8|16|64|128)/))),
		iint: ($) => token(seq(/[0-9][0-9_]*/, imm(/i(32|8|16|64|128)/))),
		decimal: ($) => token(/[0-9]+(\.)?[0-9]*(dec)/),
		natural: ($) => token(/[0-9]+(nat)/),

		float: ($) => token(seq(/[0-9]+(\.)?[0-9]*(e-?[0-9]*)?((f32)|(f64))?/)),
		_hex_int: ($) => token(seq(/0[x][0-9a-fA-F][0-9a-fA-F_]*/)),
		_octal_int: ($) => token(seq(/0[o][0-7][0-7_]*/)),
		_binary_int: ($) => token(seq(/0[b]/, /[01][01_]*/)),
		xint: ($) => choice($._binary_int, $._octal_int, $._hex_int),

		// PRIMITIVES
		back_arrow: ($) => "<-",
		arrow: ($) => "->",
		effect_arrow: ($) => "=>",
		identifier: ($) => $._lower_identifier,
		field_name: ($) => alias($.identifier, $.field_name),
		ident: ($) => choice($._lower_identifier, $._upper_identifier),
		// Allow ! suffix for effectful function names
		_lower_identifier: ($) => /_?[a-z][0-9a-zA-Z_]*!?/,
		_upper_identifier: ($) => /[A-Z][0-9a-zA-Z_]*/,
		tag: ($) => alias($._upper_identifier, $.tag),
		opaque_tag: ($) => /@[A-Z][0-9a-zA-Z_]*/,
		module: ($) => alias($._upper_identifier, $.module),

		doc_comment: ($) => token(prec(-1, /##[^\n]*/)),
		line_comment: ($) => token(prec(-1, /#[^\n]*/)),

		operator: ($) => alias($.operator_identifier, $.operator),
		operator_identifier: ($) =>
			choice(
				"+",
				"-",
				"*",
				"/",
				"%",
				"//",
				"==",
				"!=",
				"<",
				">",
				"<=",
				">=",
				"and",
				"or",
			),
	},
});

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
function optional_indent(rule, $) {
	return choice(seq($._indent, rule, $._dedent), rule);
}
function imm(x) {
	return token.immediate(x);
}
