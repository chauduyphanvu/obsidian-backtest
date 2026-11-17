#!/bin/sh
# The whole check a change must pass before it is pushed or released: tests, type check, build,
# the built files, and the cross-check against the second backtester.
#
#   sh ci/check.sh            run everything; the cross-check is skipped when rvw is not found
#   CI_REQUIRE_XCHECK=1 ...   fail when the cross-check cannot run (a release sets this)
set -eu
cd "$(dirname "$0")/.."

# Settings of this machine, such as RVW=/path/to/rvw. Not in git.
[ -f ci/local.env ] && . ./ci/local.env
[ -n "${RVW:-}" ] && export RVW

started=$(date +%s)
step() { printf '\n== %s\n' "$1"; }
fail() { printf '\nci: %s\n' "$1" >&2; exit 1; }

[ -d node_modules ] || fail 'node_modules is missing. Run "npm ci" first.'

step 'Tests'
out=$(mktemp)
trap 'rm -f "$out"' EXIT
if npm test >"$out" 2>&1; then
  grep -E '^ℹ (tests|pass|fail) ' "$out"
else
  cat "$out"
  fail 'The tests failed.'
fi

step 'Type check and build'
npm run build >"$out" 2>&1 || { cat "$out"; fail 'The build failed.'; }
echo 'built dist/'

step 'Built files'
for f in main.js manifest.json styles.css; do
  [ -s "dist/$f" ] || fail "dist/$f is missing or empty."
done
version=$(node -p "require('./manifest.json').version")
[ "$(node -p "require('./dist/manifest.json').version")" = "$version" ] || fail 'dist/manifest.json has another version than manifest.json.'
[ "$(node -p "require('./package.json').version")" = "$version" ] || fail 'package.json has another version than manifest.json.'
node -e "const v=require('./versions.json'); if (!v['$version']) process.exit(1)" || fail "versions.json has no entry for $version."
echo "version $version, main.js $(wc -c <dist/main.js | tr -d ' ') bytes"

step 'Cross-check against the second backtester'
if [ -n "${RVW:-}" ] && [ -x "$RVW" ] || command -v rvw >/dev/null 2>&1; then
  node xcheck/run.ts >"$out" 2>&1 || { tail -40 "$out"; fail 'The cross-check failed.'; }
  tail -1 "$out" | grep -q '^All checks passed' || { tail -40 "$out"; fail 'The cross-check did not end with "All checks passed".'; }
  tail -1 "$out"
elif [ "${CI_REQUIRE_XCHECK:-0}" = 1 ]; then
  fail 'The cross-check cannot run: rvw was not found. Set RVW in ci/local.env, or put rvw on PATH.'
else
  echo 'skipped: rvw was not found (set RVW in ci/local.env to run it)'
fi

printf '\nci: all checks passed in %ss\n' "$(( $(date +%s) - started ))"
