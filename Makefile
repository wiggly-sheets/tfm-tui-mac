# tfm — build interface.
#
# `make` prints the list of targets. Every target is phony.

SHELL := /bin/bash

# Root of the repository, so every target works from any directory.
ROOT := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))

DIST := $(ROOT)/dist
BIN  := $(DIST)/tfm

# The sources of the binary. It is compiled again when one of them changes.
SRC := $(shell find "$(ROOT)/src" "$(ROOT)/assets/icons" -type f 2>/dev/null)

# The version of a release comes from the command line:
#   make release VERSION=1.2.3
# It never comes from a file in the repository, so the origin is kept.
VERSION_ORIGIN := $(origin VERSION)

.PHONY: help build test release-artifacts release clean

.DEFAULT_GOAL := help

## help — list every target

help:
	@printf '%s\n' \
		'tfm — build targets.' \
		'' \
		'  help                 List every target (default).' \
		'  build                Compile the binary into dist/tfm.' \
		'  test                 Run the checks, the test suite and the version smoke test.' \
		'  release-artifacts    Build the universal macOS binary and write its checksum file.' \
		'  release VERSION=x.y.z  Build the artifacts, tag v<x.y.z> locally, print the push command.' \
		'  clean                Remove the build output.' \
		'' \
		'Notes' \
		'  The version comes from the command line: `make release VERSION=1.2.3`.' \
		'  It never comes from a file in the repository.' \
		'  `make release` never pushes. It builds the artifacts, creates the annotated tag' \
		'  v<x.y.z> and prints the command that pushes it.' \
		'  The release publishes tfm-universal-macos.gz with the sidecar' \
		'  tfm-universal-macos.gz.sha256. The Homebrew tap matches those two names, so they' \
		'  never change.' \
		'  The universal binary holds an arm64 and an x86_64 slice, so the build needs the' \
		'  dependencies of both architectures. `make release-artifacts` installs them for' \
		'  every OS and CPU, like the release workflow does.' \
		'  The targets need Bun 1.4 or newer and the installed dependencies:' \
		'  `bun install --frozen-lockfile`.'

## build — compile the binary

build: $(BIN)

$(BIN): $(SRC)
	cd "$(ROOT)" && bun run compile

## test — the checks, the test suite and the version smoke test

test: $(BIN)
	cd "$(ROOT)" && bun run check
	cd "$(ROOT)" && bun run test
	@# --version must answer without loading the app graph (see the lazy imports in
	@# src/index.ts), print exactly "tfm <package.json version>" and exit 0. A hang
	@# would block the run, so the 20s spawn timeout fails it instead.
	cd "$(ROOT)" && \
		expected="tfm $$(bun -e 'console.log(require("./package.json").version)')" && \
		actual=$$(bun -e 'const p = Bun.spawnSync(["./dist/tfm", "--version"], { timeout: 20000 }); process.stdout.write(p.stdout.toString()); process.exit(p.exitCode)') && \
		echo "expected: $$expected" && \
		echo "actual:   $$actual" && \
		test "$$actual" = "$$expected"

## release-artifacts — the universal macOS binary and the sidecar the tap expects

release-artifacts:
	cd "$(ROOT)" && bun install --frozen-lockfile --os='*' --cpu='*'
	cd "$(ROOT)" && bun run scripts/build.ts mac-universal
	cd "$(DIST)" && gzip -kf tfm-universal-macos && shasum -a 256 tfm-universal-macos.gz > tfm-universal-macos.gz.sha256
	@echo "$(DIST)/tfm-universal-macos.gz.sha256:"
	@cat "$(DIST)/tfm-universal-macos.gz.sha256"

## release — build the artifacts and tag them, without pushing

release:
	@if [ "$(VERSION_ORIGIN)" != "command line" ]; then \
		echo "error: make release needs the version on the command line, for example: make release VERSION=1.2.3"; \
		exit 1; \
	fi
	@if [ -z "$(strip $(VERSION))" ]; then \
		echo "error: make release needs a version, for example: make release VERSION=1.2.3"; \
		exit 1; \
	fi
	@if ! printf '%s\n' "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$$'; then \
		echo "error: the version \"$(VERSION)\" is not x.y.z with an optional suffix."; \
		exit 1; \
	fi
	@# A stable version must be the version of package.json, so the tag and the
	@# project never disagree. A prerelease carries its own suffix and is exempt.
	@pkg="$$(cd "$(ROOT)" && bun -e 'console.log(require("./package.json").version)')"; \
	case "$(VERSION)" in *-*) prerelease=1 ;; *) prerelease=0 ;; esac; \
	if [ "$$prerelease" -eq 0 ] && [ "$(VERSION)" != "$$pkg" ]; then \
		echo "error: the version $(VERSION) is not the version $$pkg of package.json."; \
		exit 1; \
	fi
	@if [ -n "$$(git -C "$(ROOT)" status --porcelain)" ]; then \
		echo "error: the working tree is dirty. Commit or stash your changes first."; \
		git -C "$(ROOT)" status --short; \
		exit 1; \
	fi
	@if git -C "$(ROOT)" rev-parse -q --verify "refs/tags/v$(VERSION)" >/dev/null; then \
		echo "error: the tag v$(VERSION) already exists."; \
		exit 1; \
	fi
	$(MAKE) --no-print-directory -C "$(ROOT)" release-artifacts VERSION=$(VERSION)
	git -C "$(ROOT)" tag -a "v$(VERSION)" -m "tfm $(VERSION)"
	@echo ""
	@echo "Tagged v$(VERSION). Push the commit and the tag with:"
	@echo "  git push origin HEAD"
	@echo "  git push origin v$(VERSION)"

## clean — remove everything the build produces

clean:
	rm -rf "$(DIST)"
	@echo "Removed dist/."
