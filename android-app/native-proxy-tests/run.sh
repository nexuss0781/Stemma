#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TEST_DIR="$ROOT/native-proxy-tests"
OUT="$TEST_DIR/build"
rm -rf "$OUT"
mkdir -p "$OUT"
find "$TEST_DIR/src" -name '*.java' -print > "$TEST_DIR/sources.list"
printf '%s\n' "$ROOT/native-src/StemmaBackendClient.java" >> "$TEST_DIR/sources.list"
javac -encoding UTF-8 -d "$OUT" @"$TEST_DIR/sources.list"
java -cp "$OUT" app.stemma.mobile.NativeProxyRegressionTest
