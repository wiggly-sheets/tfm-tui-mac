#!/usr/bin/env bash
# Prepare a release: bump the changelog and package.json, test, build,
# verify, commit and tag. The target never pushes.
#
# Usage: APP_NAME="tfm" scripts/release.sh X.Y.Z
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-}"
APP_NAME="${APP_NAME:-tfm}"
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
BUMPED=(CHANGELOG.md package.json)

die() {
	echo "error: $*" >&2
	exit 1
}

[[ -n "$VERSION" ]] || die "usage: scripts/release.sh X.Y.Z"
[[ "$VERSION" =~ $VERSION_RE ]] || die "the version \"$VERSION\" is not X.Y.Z with an optional prerelease suffix"
[[ -z "$(git status --porcelain)" ]] || {
	git status --short
	die "the working tree is dirty. Commit or stash your changes first."
}
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
	die "the tag v$VERSION already exists."
fi

# The tag must land on the default branch. The branch is read from the remote
# HEAD, with main and master as the fallback.
branch="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
branch="${branch#origin/}"
if [[ -z "$branch" ]]; then
	for candidate in main master; do
		if git rev-parse -q --verify "refs/remotes/origin/$candidate" >/dev/null; then
			branch="$candidate"
			break
		fi
	done
fi
[[ -n "$branch" ]] || die "the default branch is unknown; run git fetch origin first"
git rev-parse -q --verify "refs/remotes/origin/$branch" >/dev/null ||
	die "origin/$branch is not in this checkout; run git fetch origin first"
current="$(git symbolic-ref --quiet --short HEAD || true)"
[[ "$current" == "$branch" ]] ||
	die "the release must be cut from $branch, not ${current:-a detached HEAD}."

# Bump the changelog and package.json. A failure before the commit restores
# both files, so a stopped release leaves no half-bump.
./scripts/changelog.sh bump "$VERSION"
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" package.json
actual="$(bun -e 'console.log(require("./package.json").version)')"
[[ "$actual" == "$VERSION" ]] || die "package.json reports $actual, not $VERSION"

committed=0
restore() {
	local status=$?
	if [[ "$status" -ne 0 && "$committed" -eq 0 ]]; then
		git checkout -- "${BUMPED[@]}" 2>/dev/null || true
		echo "The release bump was restored." >&2
	fi
}
trap restore EXIT

make test
make release-artifacts VERSION="$VERSION"
make verify VERSION="$VERSION"

git add "${BUMPED[@]}"
git commit -m "chore(release): v$VERSION"
committed=1
git tag -a "v$VERSION" -m "$APP_NAME $VERSION"

echo ""
echo "Committed the release bump and tagged v$VERSION. Push it with:"
echo "  git push origin $branch"
echo "  git push origin v$VERSION"
