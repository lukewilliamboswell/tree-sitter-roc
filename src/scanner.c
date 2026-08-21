#include "tree_sitter/parser.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define MAX(a, b) ((a) > (b) ? (a) : (b))

#define VEC_RESIZE(vec, _cap)                                                  \
  void *tmp = realloc((vec).data, (_cap) * sizeof((vec).data[0]));             \
  assert(tmp != NULL);                                                         \
  (vec).data = tmp;                                                            \
  (vec).cap = (_cap);

#define VEC_GROW(vec, _cap)                                                    \
  if ((vec).cap < (_cap)) {                                                    \
    VEC_RESIZE((vec), (_cap));                                                 \
  }

#define VEC_PUSH(vec, el)                                                      \
  if ((vec).cap == (vec).len) {                                                \
    VEC_RESIZE((vec), MAX(16, (vec).len * 2));                                 \
  }                                                                            \
  (vec).data[(vec).len++] = (el);

#define VEC_POP(vec) (vec).len--;

#define VEC_NEW                                                                \
  { .len = 0, .cap = 0, .data = NULL }

#define VEC_BACK(vec) ((vec).data[(vec).len - 1])

#define VEC_FREE(vec)                                                          \
  {                                                                            \
    if ((vec).data != NULL)                                                    \
      free((vec).data);                                                        \
  }

#define VEC_CLEAR(vec) (vec).len = 0;

enum TokenType {
  NEWLINE,
  END_NEWLINE,
  INDENT,
  DEDENT,
  COMMENT,
  CLOSE_BRACKET,
  CLOSE_PAREN,
  CLOSE_BRACE,
  EXCEPT,
  ELSE_IF_START,
  RECORD_FUNCTION_PARAM_COMMA,
  TIGHT_BINARY_MINUS,
};

typedef enum {
  SingleQuote = 1 << 0,
  DoubleQuote = 1 << 1,
  BackQuote = 1 << 2,
  Raw = 1 << 3,
  Format = 1 << 4,
  Triple = 1 << 5,
  Bytes = 1 << 6,
} Flags;

typedef struct {
  char flags;
} Delimiter;

static inline Delimiter new_delimiter() { return (Delimiter){0}; }

static inline bool is_format(Delimiter *delimiter) {
  return delimiter->flags & Format;
}

static inline bool is_raw(Delimiter *delimiter) {
  return delimiter->flags & Raw;
}

static inline bool is_triple(Delimiter *delimiter) {
  return delimiter->flags & Triple;
}

static inline bool is_bytes(Delimiter *delimiter) {
  return delimiter->flags & Bytes;
}

static inline int32_t end_character(Delimiter *delimiter) {
  if (delimiter->flags & SingleQuote) {
    return '\'';
  }
  if (delimiter->flags & DoubleQuote) {
    return '"';
  }
  if (delimiter->flags & BackQuote) {
    return '`';
  }
  return 0;
}

static inline void set_format(Delimiter *delimiter) {
  delimiter->flags |= Format;
}

static inline void set_raw(Delimiter *delimiter) { delimiter->flags |= Raw; }

static inline void set_triple(Delimiter *delimiter) {
  delimiter->flags |= Triple;
}

static inline void set_bytes(Delimiter *delimiter) {
  delimiter->flags |= Bytes;
}

static inline void set_end_character(Delimiter *delimiter, int32_t character) {
  switch (character) {
  case '\'':
    delimiter->flags |= SingleQuote;
    break;
  case '"':
    delimiter->flags |= DoubleQuote;
    break;
  case '`':
    delimiter->flags |= BackQuote;
    break;
  default:
    assert(false);
  }
}

typedef struct {
  uint32_t len;
  uint32_t cap;
  uint16_t *data;
} indent_vec;

static indent_vec indent_vec_new() {
  indent_vec vec = VEC_NEW;
  vec.data = calloc(1, sizeof(uint16_t));
  vec.cap = 1;
  return vec;
}

typedef struct {
  uint32_t len;
  uint32_t cap;
  Delimiter *data;
} delimiter_vec;

static delimiter_vec delimiter_vec_new() {
  delimiter_vec vec = VEC_NEW;
  vec.data = calloc(1, sizeof(Delimiter));
  vec.cap = 1;
  return vec;
}

typedef struct {
  indent_vec indents;
  delimiter_vec delimiters;
  bool inside_f_string;
} Scanner;

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

bool tree_sitter_roc_external_scanner_scan(void *payload, TSLexer *lexer,
                                           const bool *valid_symbols) {
  Scanner *scanner = (Scanner *)payload;

  bool error_recovery_mode =
       valid_symbols[INDENT];

  lexer->mark_end(lexer);

  if (valid_symbols[ELSE_IF_START] && lexer->lookahead == 'e') {
    advance(lexer);
    if (lexer->lookahead != 'l') return false;
    advance(lexer);
    if (lexer->lookahead != 's') return false;
    advance(lexer);
    if (lexer->lookahead != 'e') return false;
    advance(lexer);
    if ((lexer->lookahead >= 'a' && lexer->lookahead <= 'z') ||
        (lexer->lookahead >= 'A' && lexer->lookahead <= 'Z') ||
        (lexer->lookahead >= '0' && lexer->lookahead <= '9') ||
        lexer->lookahead == '_') return false;
    bool separated = false;
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t' ||
           lexer->lookahead == '\r' || lexer->lookahead == '\n') {
      separated = true;
      skip(lexer);
    }
    if (separated && lexer->lookahead == 'i') {
      advance(lexer);
      if (lexer->lookahead != 'f') return false;
      advance(lexer);
      if ((lexer->lookahead >= 'a' && lexer->lookahead <= 'z') ||
          (lexer->lookahead >= 'A' && lexer->lookahead <= 'Z') ||
          (lexer->lookahead >= '0' && lexer->lookahead <= '9') ||
          lexer->lookahead == '_') return false;
      lexer->mark_end(lexer);
      lexer->result_symbol = ELSE_IF_START;
      return true;
    }
    return false;
  }

  // Record fields and multi-parameter function types both use commas. This
  // zero-lookahead discriminator keeps the function parse alive without the
  // former grammar tokens that swallowed the following type, trivia, and
  // sometimes even the arrow. Its source range is exactly the comma.
  if (valid_symbols[RECORD_FUNCTION_PARAM_COMMA] &&
      lexer->lookahead == ',') {
    advance(lexer);
    lexer->mark_end(lexer);
    unsigned depth = 0;
    while (!lexer->eof(lexer)) {
      if (lexer->lookahead == '(' || lexer->lookahead == '[' ||
          lexer->lookahead == '{') {
        depth++;
      } else if (lexer->lookahead == ')' || lexer->lookahead == ']' ||
                 lexer->lookahead == '}') {
        if (depth == 0) return false;
        depth--;
      } else if (depth == 0 && lexer->lookahead == ':') {
        return false;
      } else if (depth == 0 &&
                 (lexer->lookahead == '-' || lexer->lookahead == '=')) {
        skip(lexer);
        if (lexer->lookahead == '>') {
          lexer->result_symbol = RECORD_FUNCTION_PARAM_COMMA;
          return true;
        }
        continue;
      } else if (lexer->lookahead == '#') {
        while (lexer->lookahead && lexer->lookahead != '\n') skip(lexer);
        continue;
      }
      skip(lexer);
    }
    return false;
  }

  // Roc treats `value-1` as subtraction, even though `-1` is otherwise one
  // numeric token. Return a distinct binary-minus token only when the minus is
  // directly at the current position and is immediately followed by a digit.
  if (!error_recovery_mode && valid_symbols[TIGHT_BINARY_MINUS] &&
      lexer->lookahead == '-') {
    advance(lexer);
    if (lexer->lookahead >= '0' && lexer->lookahead <= '9') {
      lexer->mark_end(lexer);
      lexer->result_symbol = TIGHT_BINARY_MINUS;
      return true;
    }
    return false;
  }

  // Avoid running the indentation scanner when this narrow token is the only
  // external symbol that is valid in the current parse state.
  if ((valid_symbols[TIGHT_BINARY_MINUS] || valid_symbols[ELSE_IF_START] ||
       valid_symbols[RECORD_FUNCTION_PARAM_COMMA]) &&
      !valid_symbols[NEWLINE] &&
      !valid_symbols[END_NEWLINE] && !valid_symbols[INDENT] &&
      !valid_symbols[DEDENT] && !valid_symbols[EXCEPT]) {
    return false;
  }

  bool found_end_of_line = false;
  uint32_t indent_length = 0;
  int32_t first_comment_indent_length = -1;
  for (;;) {
    if (valid_symbols[DEDENT] && lexer->lookahead == ')') {
      skip(lexer);
    }
    if (lexer->lookahead == '\n') {
      found_end_of_line = true;
      indent_length = 0;
      skip(lexer);
    } else if (lexer->lookahead == ' ') {
      indent_length++;
      skip(lexer);
    } else if (lexer->lookahead == '\r' || lexer->lookahead == '\f') {
      indent_length = 0;
      skip(lexer);
    } else if (lexer->lookahead == '\t') {
      indent_length += 8;
      skip(lexer);
    } else if (lexer->lookahead == '#' &&
               (valid_symbols[INDENT] || valid_symbols[DEDENT] ||
                valid_symbols[NEWLINE] || valid_symbols[EXCEPT])) {
      // If we haven't found an EOL yet,
      // then this is a comment after an expression:
      //   foo = bar # comment
      // Just return, since we don't want to generate an indent/dedent
      // token.
      if (!found_end_of_line) {
        return false;
      }
      if (first_comment_indent_length == -1) {
        first_comment_indent_length = (int32_t)indent_length;
      }
      while (lexer->lookahead && lexer->lookahead != '\n') {
        skip(lexer);
      }
      skip(lexer);
      indent_length = 0;
    }
    else if (lexer->eof(lexer)) {
      indent_length = 0;
      found_end_of_line = true;
      break;
    } else {
      break;
    }
  }

  if (found_end_of_line) {
    if (scanner->indents.len > 0) {
      uint16_t current_indent_length = VEC_BACK(scanner->indents);

      if (valid_symbols[INDENT] && indent_length > current_indent_length) {
        VEC_PUSH(scanner->indents, indent_length);
        lexer->result_symbol = INDENT;
        return true;
      }


      if ((valid_symbols[DEDENT] ||
           (!valid_symbols[NEWLINE] 
         )
        ) &&
          indent_length < current_indent_length && !scanner->inside_f_string &&

          // Wait to create a dedent token until we've consumed any
          // comments
          // whose indentation matches the current block.
          first_comment_indent_length < (int32_t)current_indent_length) {
        VEC_POP(scanner->indents);
        lexer->result_symbol = DEDENT;
        return true;
      }
      // This is a newline that is not followed by an indent, and is thus the
      // end of a declaration newlines follwed by an indent are likely just a
      // declaration with more content on a seperate line
      if (valid_symbols[END_NEWLINE] &&
          indent_length <= current_indent_length) {
        lexer->result_symbol = END_NEWLINE;
        return true;
      }
    }

    if (valid_symbols[NEWLINE] && !error_recovery_mode) {
      lexer->result_symbol = NEWLINE;
      return true;
    }
  }

  return false;
}

unsigned tree_sitter_roc_external_scanner_serialize(void *payload,
                                                    char *buffer) {
  Scanner *scanner = (Scanner *)payload;

  size_t size = 0;

  buffer[size++] = (char)scanner->inside_f_string;

  size_t delimiter_count = scanner->delimiters.len;
  if (delimiter_count > UINT8_MAX) {
    delimiter_count = UINT8_MAX;
  }
  buffer[size++] = (char)delimiter_count;

  if (delimiter_count > 0) {
    memcpy(&buffer[size], scanner->delimiters.data, delimiter_count);
  }
  size += delimiter_count;

  unsigned int iter = 1;
  for (; iter < scanner->indents.len &&
         size < TREE_SITTER_SERIALIZATION_BUFFER_SIZE;
       ++iter) {
    buffer[size++] = (char)scanner->indents.data[iter];
  }

  return size;
}

void tree_sitter_roc_external_scanner_deserialize(void *payload,
                                                  const char *buffer,
                                                  unsigned length) {
  Scanner *scanner = (Scanner *)payload;

  VEC_CLEAR(scanner->delimiters);
  VEC_CLEAR(scanner->indents);
  VEC_PUSH(scanner->indents, 0);

  if (length > 0) {
    size_t size = 0;

    scanner->inside_f_string = (bool)buffer[size++];

    size_t delimiter_count = (uint8_t)buffer[size++];
    if (delimiter_count > 0) {
      VEC_GROW(scanner->delimiters, delimiter_count);
      scanner->delimiters.len = delimiter_count;
      memcpy(scanner->delimiters.data, &buffer[size], delimiter_count);
      size += delimiter_count;
    }

    for (; size < length; size++) {
      VEC_PUSH(scanner->indents, (unsigned char)buffer[size]);
    }
  }
}

void *tree_sitter_roc_external_scanner_create() {
#if defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)
  _Static_assert(sizeof(Delimiter) == sizeof(char), "");
#else
  assert(sizeof(Delimiter) == sizeof(char));
#endif
  Scanner *scanner = calloc(1, sizeof(Scanner));
  scanner->indents = indent_vec_new();
  scanner->delimiters = delimiter_vec_new();
  tree_sitter_roc_external_scanner_deserialize(scanner, NULL, 0);
  return scanner;
}

void tree_sitter_roc_external_scanner_destroy(void *payload) {
  Scanner *scanner = (Scanner *)payload;
  VEC_FREE(scanner->indents);
  VEC_FREE(scanner->delimiters);
  free(scanner);
}
