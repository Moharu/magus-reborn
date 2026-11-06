#!/usr/bin/env bash
# Exits 0 only if the checked-out code is exactly a tagged release (vX.Y.Z).
#
# Releases are tagged on dev and then merged into main, so the commit on main is usually a
# new merge commit that carries no tag itself. Comparing trees accepts a merge, squash or
# fast-forward of the tagged code, and refuses anything that differs from it by even one file,
# such as commits that reached dev after the tag was created.
set -euo pipefail

head_tree="$(git rev-parse 'HEAD^{tree}')"

while IFS= read -r tag; do
    if [[ "$(git rev-parse "refs/tags/${tag}^{tree}")" == "${head_tree}" ]]; then
        echo "Deploying release ${tag}: its tree matches $(git rev-parse --short HEAD)."
        exit 0
    fi
done < <(git tag --list 'v[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true)

echo "::error::$(git rev-parse --short HEAD) does not match any vX.Y.Z tag. Only tagged releases are deployed."
exit 1
