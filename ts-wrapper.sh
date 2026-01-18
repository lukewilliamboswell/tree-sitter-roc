#!/bin/bash
# Wrapper for tree-sitter commands with timeout handling
# Usage: ./ts-wrapper.sh <command> [args...]
# Commands: generate, parse <file>, test [filter], quick-test

set -e

TIMEOUT_GENERATE=30
TIMEOUT_PARSE=10
TIMEOUT_TEST=120  # 2 minutes for full test suite

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Kill any hanging tree-sitter processes
cleanup_hanging() {
    pkill -f "tree-sitter generate" 2>/dev/null || true
    pkill -f "tree-sitter parse" 2>/dev/null || true
    pkill -f "tree-sitter test" 2>/dev/null || true
}

run_with_timeout() {
    local timeout=$1
    local name=$2
    shift 2
    local cmd="$@"

    echo -n "$name... "

    # Run command in background
    eval "$cmd" > /tmp/ts-wrapper.log 2>&1 &
    local PID=$!

    # Wait with timeout
    local WAITED=0
    while kill -0 $PID 2>/dev/null; do
        sleep 1
        ((WAITED++))
        if [ $WAITED -ge $timeout ]; then
            kill -9 $PID 2>/dev/null || true
            echo -e "${RED}TIMEOUT (${timeout}s)${NC}"
            echo "Command was: $cmd"
            return 1
        fi
    done

    wait $PID
    local EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
        echo -e "${GREEN}OK${NC}"
        return 0
    else
        echo -e "${RED}FAILED${NC}"
        cat /tmp/ts-wrapper.log | head -30
        return $EXIT_CODE
    fi
}

cmd_generate() {
    cleanup_hanging
    run_with_timeout $TIMEOUT_GENERATE "Generating parser" "tree-sitter generate"
}

cmd_parse() {
    local file="$1"
    if [ -z "$file" ]; then
        echo "Usage: $0 parse <file>"
        exit 1
    fi

    cleanup_hanging

    echo "Parsing: $file"
    tree-sitter parse "$file" > /tmp/ts-wrapper.log 2>&1 &
    local PID=$!

    local WAITED=0
    while kill -0 $PID 2>/dev/null; do
        sleep 1
        ((WAITED++))
        if [ $WAITED -ge $TIMEOUT_PARSE ]; then
            kill -9 $PID 2>/dev/null || true
            echo -e "${RED}TIMEOUT (${TIMEOUT_PARSE}s)${NC}"
            exit 1
        fi
    done

    wait $PID || true
    cat /tmp/ts-wrapper.log

    # Check for errors
    if grep -qE "ERROR|MISSING" /tmp/ts-wrapper.log; then
        echo ""
        echo -e "${YELLOW}Parse errors detected${NC}"
        exit 1
    fi
}

cmd_test() {
    local filter="$1"
    cleanup_hanging

    local cmd="tree-sitter test"
    if [ -n "$filter" ]; then
        cmd="tree-sitter test -f \"$filter\""
        echo "Running tests matching: $filter"
    else
        echo "Running full test suite..."
    fi

    eval "$cmd" > /tmp/ts-wrapper.log 2>&1 &
    local PID=$!

    local WAITED=0
    while kill -0 $PID 2>/dev/null; do
        sleep 1
        ((WAITED++))
        # Show progress every 10 seconds
        if [ $((WAITED % 10)) -eq 0 ]; then
            echo "  ... still running (${WAITED}s)"
        fi
        if [ $WAITED -ge $TIMEOUT_TEST ]; then
            kill -9 $PID 2>/dev/null || true
            echo -e "${RED}TIMEOUT (${TIMEOUT_TEST}s)${NC}"
            echo "Tests are hanging. Check for infinite loops in grammar."
            exit 1
        fi
    done

    wait $PID
    local EXIT_CODE=$?

    cat /tmp/ts-wrapper.log

    if [ $EXIT_CODE -eq 0 ]; then
        echo ""
        echo -e "${GREEN}All tests passed!${NC}"
    else
        echo ""
        echo -e "${YELLOW}Some tests failed${NC}"
    fi

    return $EXIT_CODE
}

cmd_quick() {
    # Quick sanity check - generate + basic parse tests
    cleanup_hanging

    echo "=== Quick Grammar Check ==="
    echo ""

    if ! cmd_generate; then
        exit 1
    fi

    echo ""
    echo "Running quick parse tests..."

    # Test a few basic constructs
    local TESTS=(
        'x = 5'
        'add = |a, b| a + b'
        'x : Int'
        '{ name: "test" }'
        'x = if True then 1 else 2'
        'x = match y { A => 1 }'
    )

    local PASSED=0
    local FAILED=0

    for test in "${TESTS[@]}"; do
        echo "$test" > /tmp/ts-quick-test.roc
        tree-sitter parse /tmp/ts-quick-test.roc > /tmp/ts-quick.log 2>&1 &
        local PID=$!

        local WAITED=0
        while kill -0 $PID 2>/dev/null; do
            sleep 1
            ((WAITED++))
            if [ $WAITED -ge 5 ]; then
                kill -9 $PID 2>/dev/null || true
                echo -e "  ${RED}TIMEOUT${NC}: $test"
                ((FAILED++))
                continue 2
            fi
        done

        wait $PID || true

        if grep -qE "ERROR|MISSING" /tmp/ts-quick.log; then
            echo -e "  ${RED}FAIL${NC}: $test"
            ((FAILED++))
        else
            echo -e "  ${GREEN}OK${NC}: $test"
            ((PASSED++))
        fi
    done

    echo ""
    echo "Quick check: $PASSED passed, $FAILED failed"

    if [ $FAILED -gt 0 ]; then
        exit 1
    fi
}

cmd_count() {
    # Count passing/failing tests without running full suite
    cleanup_hanging

    echo "Counting test results..."

    tree-sitter test 2>&1 | tee /tmp/ts-count.log &
    local PID=$!

    local WAITED=0
    while kill -0 $PID 2>/dev/null; do
        sleep 1
        ((WAITED++))
        if [ $WAITED -ge $TIMEOUT_TEST ]; then
            kill -9 $PID 2>/dev/null || true
            echo -e "${RED}TIMEOUT${NC}"
            exit 1
        fi
    done

    wait $PID || true

    # Extract summary
    echo ""
    echo "=== Summary ==="
    grep -E "^\s*[0-9]+ of [0-9]+" /tmp/ts-count.log || echo "Could not extract summary"
}

# Main dispatcher
case "${1:-help}" in
    generate|gen)
        cmd_generate
        ;;
    parse)
        cmd_parse "$2"
        ;;
    test)
        cmd_test "$2"
        ;;
    quick)
        cmd_quick
        ;;
    count)
        cmd_count
        ;;
    help|--help|-h)
        echo "Tree-sitter wrapper with timeout handling"
        echo ""
        echo "Usage: $0 <command> [args]"
        echo ""
        echo "Commands:"
        echo "  generate, gen    Generate the parser (${TIMEOUT_GENERATE}s timeout)"
        echo "  parse <file>     Parse a single file (${TIMEOUT_PARSE}s timeout)"
        echo "  test [filter]    Run test suite, optionally filtered (${TIMEOUT_TEST}s timeout)"
        echo "  quick            Quick sanity check (generate + basic parses)"
        echo "  count            Run tests and show pass/fail count"
        echo ""
        echo "Examples:"
        echo "  $0 generate"
        echo "  $0 parse example.roc"
        echo "  $0 test 'match'"
        echo "  $0 quick"
        ;;
    *)
        echo "Unknown command: $1"
        echo "Run '$0 help' for usage"
        exit 1
        ;;
esac
