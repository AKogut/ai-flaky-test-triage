#!/usr/bin/env bash
#
# Publish wiki/ to the GitHub wiki.
#
# The one way the wiki gets written. .github/workflows/wiki.yml runs this on
# every push to main that changes wiki/, and a maintainer can run it by hand
# with `npm run wiki:publish`. Both mirror the same files the same way.
#
#   ./scripts/publish-wiki.sh             clone, mirror, commit, push
#   ./scripts/publish-wiki.sh --dry-run   clone, mirror, print the diff, push nothing
#
# Environment, all optional:
#
#   WIKI_REPO_SLUG  owner/name of the repository (default AKogut/ai-flaky-test-triage)
#   WIKI_REMOTE     the wiki repository to clone and push to. The default is the
#                   SSH remote, which uses your key. CI passes the https one.
#   WIKI_TOKEN      a token for an https WIKI_REMOTE. CI passes its GITHUB_TOKEN.
#
# The wiki is a separate git repository. GitHub does not create it until the wiki
# has at least one page and there is no API for creating that first page, so do
# this once by hand the first time:
#
#   1. open https://github.com/AKogut/ai-flaky-test-triage/wiki
#   2. click "Create the first page" and save anything
#   3. re-run this script — it overwrites the placeholder
#
set -euo pipefail

DRY_RUN=false
case "${1:-}" in
  '') ;;
  --dry-run) DRY_RUN=true ;;
  *)
    echo "usage: $0 [--dry-run]" >&2
    exit 2
    ;;
esac

REPO_SLUG="${WIKI_REPO_SLUG:-AKogut/ai-flaky-test-triage}"
REMOTE="${WIKI_REMOTE:-git@github.com:${REPO_SLUG}.wiki.git}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/wiki"

# Wiki commits carry the owner's name and GitHub's public noreply address,
# whoever or whatever runs this. Not a bot persona, and not a private address.
AUTHOR_NAME='Andrii Kohut'
AUTHOR_EMAIL='AKogut@users.noreply.github.com'

if [ ! -d "$SOURCE_DIR" ]; then
  echo "error: $SOURCE_DIR does not exist" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Runs git with the token, when there is one, for this one command only.
#
# The token reaches git through the environment, read by a credential helper
# that exists for the length of the command. Nothing is written to a config
# file and the token is never on a command line. The empty `credential.helper=`
# clears any helper already configured first, so no keychain stores it.
with_token() {
  if [ -n "${WIKI_TOKEN:-}" ]; then
    GIT_TERMINAL_PROMPT=0 git \
      -c credential.helper= \
      -c 'credential.helper=!f() { test "$1" = get && printf "username=x-access-token\npassword=%s\n" "$WIKI_TOKEN"; }; f' \
      "$@"
  else
    git "$@"
  fi
}

echo "→ cloning $REMOTE"
if ! with_token clone --quiet "$REMOTE" "$WORK_DIR/wiki"; then
  cat >&2 <<MSG

error: could not clone the wiki repository.

If the wiki has never been published, it has never been initialised. GitHub
creates the wiki's git repository only after the first page exists, and no API
can create it.

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
git add -A
if git diff --cached --quiet; then
  echo "→ wiki already up to date"
  exit 0
fi

git --no-pager diff --cached --stat
if [ "$DRY_RUN" = true ]; then
  git --no-pager diff --cached
  echo "→ dry run: nothing committed, nothing pushed"
  exit 0
fi

SOURCE_REV="$(git -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
GIT_AUTHOR_NAME="$AUTHOR_NAME" GIT_AUTHOR_EMAIL="$AUTHOR_EMAIL" \
  GIT_COMMITTER_NAME="$AUTHOR_NAME" GIT_COMMITTER_EMAIL="$AUTHOR_EMAIL" \
  git commit --quiet -m "docs: sync wiki from wiki/ at $SOURCE_REV"
with_token push --quiet "$REMOTE" HEAD

echo "→ published: https://github.com/${REPO_SLUG}/wiki"
