test-gen: 
    tree-sitter generate && tree-sitter test 

test-gen-filter TEST:
    tree-sitter generate && tree-sitter test -f {{TEST}}
test:
    tree-sitter test

test-update:
    tree-sitter test --update

# run tree-sitter generate and verify generated files are clean
generate-check:
    tree-sitter generate && git diff --exit-code src/parser.c src/grammar.json src/node-types.json

# fail when generated parser complexity exceeds the reviewed budget
parser-metrics-check:
    node tools/check-parser-metrics.js

# generate editor-specific queries from mappings
queries-generate:
    node tools/template-queries.js --queries-dir queries

# generate queries and verify output is clean
queries-check:
    node tools/template-queries.js --queries-dir queries && git diff --exit-code queries-generated

# run CI checks: generation, parser metrics, tests, and queries
ci:
    just generate-check && just parser-metrics-check && tree-sitter test && just queries-check

#generate and build wasm
build-all:
    tree-sitter generate && tree-sitter wasm
