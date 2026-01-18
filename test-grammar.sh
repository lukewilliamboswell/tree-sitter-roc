#!/bin/bash
# Test script for tree-sitter-roc grammar development
# Catches hangs and runs tests systematically

TIMEOUT_GENERATE=30
TIMEOUT_PARSE=5

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0

echo "=== Tree-sitter Grammar Test Script ==="
echo ""

# Kill any hanging tree-sitter processes first
pkill -f "tree-sitter generate" 2>/dev/null || true
pkill -f "tree-sitter parse" 2>/dev/null || true

# Step 1: Generate the parser with timeout
echo -n "1. Generating parser... "

tree-sitter generate > /tmp/ts-generate.log 2>&1 &
GEN_PID=$!

# Wait with timeout
WAITED=0
while kill -0 $GEN_PID 2>/dev/null; do
    sleep 1
    ((WAITED++))
    if [ $WAITED -ge $TIMEOUT_GENERATE ]; then
        kill -9 $GEN_PID 2>/dev/null || true
        echo -e "${RED}TIMEOUT (${TIMEOUT_GENERATE}s)${NC}"
        echo "   Grammar may have infinite recursion or conflict loop"
        exit 1
    fi
done

wait $GEN_PID
GEN_EXIT=$?

if [ $GEN_EXIT -eq 0 ]; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${RED}FAILED${NC}"
    echo "   Error output:"
    cat /tmp/ts-generate.log | head -20 | sed 's/^/   /'
    exit 1
fi

# Step 2: Run test cases
echo ""
echo "2. Running parse tests..."
echo ""

run_test() {
    local name="$1"
    local code="$2"
    local expect_error="${3:-false}"

    echo -n "   $name: "

    # Write code to temp file
    echo "$code" > /tmp/ts-test-input.roc

    # Run parse in background
    tree-sitter parse /tmp/ts-test-input.roc > /tmp/ts-parse.log 2>&1 &
    PARSE_PID=$!

    # Wait with timeout
    WAITED=0
    while kill -0 $PARSE_PID 2>/dev/null; do
        sleep 1
        ((WAITED++))
        if [ $WAITED -ge $TIMEOUT_PARSE ]; then
            kill -9 $PARSE_PID 2>/dev/null || true
            echo -e "${RED}TIMEOUT${NC}"
            ((FAILED++))
            return
        fi
    done

    wait $PARSE_PID || true
    RESULT=$(cat /tmp/ts-parse.log)

    HAS_ERROR=$(echo "$RESULT" | grep -c "ERROR\|MISSING" || true)

    if [ "$expect_error" = "true" ]; then
        if [ "$HAS_ERROR" -gt 0 ]; then
            echo -e "${GREEN}OK (expected error)${NC}"
            ((PASSED++))
        else
            echo -e "${RED}FAIL (expected error but parsed OK)${NC}"
            ((FAILED++))
        fi
    else
        if [ "$HAS_ERROR" -gt 0 ]; then
            echo -e "${RED}FAIL (parse error)${NC}"
            echo "$RESULT" | grep -E "ERROR|MISSING" | head -3 | sed 's/^/      /'
            ((FAILED++))
        else
            echo -e "${GREEN}OK${NC}"
            ((PASSED++))
        fi
    fi
}

# Basic tests
run_test "Simple value" 'x = 5'
run_test "Function def" 'add = |a, b| a + b'
run_test "Type annotation" 'x : Int'
run_test "Record" '{ name: "test", value: 42 }'
run_test "Tag" '[Ok, Err]'
run_test "If expression" 'x = if True then 1 else 2'
run_test "Match expression" 'x = match y {
    A => 1
    B => 2
}'
run_test "Effectful arrow" 'f : Int => Int'
run_test "Parenthesized type" 'x : List(Int)'

# Nominal type tests
run_test "Simple nominal type alias" 'Color :: [Red, Green, Blue]'
run_test "Simple opaque type" 'Color := [Red, Green, Blue]'
run_test "Opaque with methods empty" 'Color := [Red].{}'
# Full opaque with annotation + implementation in method block
run_test "Opaque with method" 'Color := [Red].{
  to_str : Color -> Str
  to_str = |c| "red"
}'

# Summary
echo ""
echo "=== Summary ==="
echo -e "Passed: ${GREEN}$PASSED${NC}"
echo -e "Failed: ${RED}$FAILED${NC}"

if [ $FAILED -gt 0 ]; then
    exit 1
fi
exit 0
