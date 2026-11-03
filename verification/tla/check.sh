#!/usr/bin/env bash
# Model-checks every spec here with TLC (exits non-zero on any violation).
# TLA_JAR points at tla2tools.jar.
set -euo pipefail
cd "$(dirname "$0")"
jar="${TLA_JAR:?set TLA_JAR to tla2tools.jar}"
for spec in *.tla; do
  name="${spec%.tla}"
  echo "== $name"
  java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -config "$name.cfg" -workers auto \
    -cleanup -metadir "${TMPDIR:-/tmp}/tlc-$name" "$spec" |
    grep -E 'No error|violated|Error|distinct states found'
done
