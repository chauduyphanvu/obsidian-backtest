#!/bin/sh
# Releases the version in manifest.json from this machine: checks everything, tags the commit,
# pushes the tag and publishes a GitHub release with main.js, manifest.json and styles.css.
#
#   sh ci/release.sh             release
#   sh ci/release.sh --dry-run   run every check and say what would happen, change nothing
#   sh ci/release.sh --draft     create the GitHub release as a draft
#
# Release notes come from ci/notes/<version>.md when that file exists, else GitHub writes them
# from the commits. Needs the GitHub command-line tool, gh, signed in.
set -eu
cd "$(dirname "$0")/.."

dry=0
draft=''
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry=1 ;;
    --draft) draft='--draft' ;;
    *) echo "release: unknown option $arg" >&2; exit 2 ;;
  esac
done
fail() { printf '\nrelease: %s\n' "$1" >&2; exit 1; }

command -v gh >/dev/null 2>&1 || fail 'gh, the GitHub command-line tool, is not installed.'
version=$(node -p "require('./manifest.json').version")
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = main ] || fail "Releases are made from main; this is $branch."
[ -z "$(git status --porcelain)" ] || fail 'There are uncommitted changes. Commit or stash them first.'
git fetch --quiet --tags origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail 'main and origin/main differ. Push or pull first, so the release is of what is on GitHub.'
if git rev-parse -q --verify "refs/tags/$version" >/dev/null; then
  fail "Tag $version already exists. Raise the version in manifest.json, package.json and versions.json first."
fi
gh release view "$version" >/dev/null 2>&1 && fail "A GitHub release called $version already exists."

CI_REQUIRE_XCHECK=1 sh ci/check.sh

notes="ci/notes/$version.md"
if [ -f "$notes" ]; then set -- --notes-file "$notes"; else set -- --generate-notes; fi

if [ "$dry" = 1 ]; then
  printf '\nrelease: dry run. Would tag %s at %s, push the tag and publish the release (%s).\n' "$version" "$(git rev-parse --short HEAD)" "$*"
  exit 0
fi

git tag "$version"
git push origin "$version"
# shellcheck disable=SC2086
gh release create "$version" dist/main.js dist/manifest.json dist/styles.css --title "$version" --verify-tag $draft "$@"
printf '\nrelease: %s is out.\n' "$version"
