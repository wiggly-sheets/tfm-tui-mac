#!/usr/bin/env bash
# Print the section of CHANGELOG.md that belongs to VERSION.
#
# Usage: release-notes.sh VERSION [CHANGELOG.md]
#
# The section starts at the heading of the version and ends before the next
# heading that starts with "## ". Both heading styles are matched:
# "## 1.0.0" and "## [1.0.0] - 2026-01-01".
#
# Exit codes:
#   0  the section was printed on stdout
#   2  bad usage: no version was given
#   3  the changelog holds no section for the version
set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
	echo "usage: $0 VERSION [CHANGELOG.md]" >&2
	exit 2
fi

CHANGELOG="${2:-CHANGELOG.md}"
if [[ ! -f "$CHANGELOG" ]]; then
	echo "error: no changelog at $CHANGELOG" >&2
	exit 3
fi

# The heading of the tag carries a "v", the heading of the changelog does not.
WANT="${VERSION#v}"

# The heading is matched on its version token, so the section of "1.0.0" is
# never taken from the heading of "1.0.0-rc.1".
if ! awk -v want="$WANT" '
  /^## / {
    if (found) exit
    head = $0
    sub(/^##[ \t]+/, "", head)
    sub(/^v/, "", head)
    split(head, part, /[ \t]+/)
    token = part[1]
    sub(/^\[/, "", token)
    sub(/\]$/, "", token)
    sub(/—.*$/, "", token)
    if (token == want) { found = 1; print }
    next
  }
  found { print }
  END { if (!found) exit 3 }
' "$CHANGELOG"; then
	echo "error: $CHANGELOG has no section for $VERSION" >&2
	exit 3
fi
