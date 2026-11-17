#!/usr/bin/env bash
# Runs all tests of this app: JS unit tests (node >= 22), service tests, browser test (if playwright is installed)
set -e
cd "$(dirname "$0")/.."
echo "== JS unit tests";  node --test tests/js/*.test.mjs
echo "== service tests";  python3 -m unittest -v tests.test_server
echo "== browser test";   python3 -m unittest -v tests.test_e2e
