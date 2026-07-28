#!/usr/bin/env bash
#
# Publish wiki/ to the GitHub wiki.
#
# The wiki is a separate git repository. GitHub does not create it until the wiki
# has at least one page and there is no API for creating that first page, so run
# this once manually the first time:
#
#   1. open https://github.com/AKogut/ai-flaky-test-triage/wiki
#   2. click "Create the first page" and save anything
#   3. re-run this script — it overwrites the placeholder
#
set -euo pipefail

REPO_SLUG="${WIKI_REPO_SLUG:-AKogut/ai-flaky-test-triage}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/wiki"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

if [ ! -d "$SOURCE_DIR" ]; then
  echo "error: $SOURCE_DIR does not exist" >&2
  exit 1
fi

REMOTE="git@github.com:${REPO_SLUG}.wiki.git"
echo "→ cloning $REMOTE"
if ! git clone --quiet "$REMOTE" "$WORK_DIR/wiki" 2>/dev/null; then
  cat >&2 <<MSG

error: could not clone the wiki repository.

The wiki has almost certainly never been initialised. GitHub creates the wiki's
git repository only after the first page exists, and no API can create it.

  1. open https://github.com/${REPO_SLUG}/wiki
  2. click "Create the first page" and save it with any content
  3. re-run this script

MSG
  exit 1
fi

echo "→ mirroring wiki/ (excluding README.md, which documents this process)"
find "$WORK_DIR/wiki" -maxdepth 1 -name '*.md' -delete
for f in "$SOURCE_DIR"/*.md; do
  [ "$(basename "$f")" = "README.md" ] && continue
  cp "$f" "$WORK_DIR/wiki/"
done

cd "$WORK_DIR/wiki"
if git diff --quiet && git diff --cached --quiet && [ -z "$(git status --porcelain)" ]; then
  echo "→ wiki already up to date"
  exit 0
fi

git add -A
git -c user.name="${GIT_AUTHOR_NAME:-Andrii Kohut}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-a.kogut01@gmail.com}" \
    commit --quiet -m "docs: sync wiki from wiki/ at $(git -C "$SOURCE_DIR/.." rev-parse --short HEAD 2>/dev/null || echo unknown)"
git push --quiet origin HEAD

echo "→ published: https://github.com/${REPO_SLUG}/wiki"
