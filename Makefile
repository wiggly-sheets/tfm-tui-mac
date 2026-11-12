# tfm — build interface.
#
# `make` prints the list of targets. Every target is phony.

SHELL := /bin/bash

# Root of the repository, so every target works from any directory.
ROOT := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))

DIST := $(ROOT)/dist
BIN  := $(DIST)/tfm

# The sources of the binary, plus package.json: the version is compiled into
# the binary, so a release bump must trigger a rebuild.
SRC := $(shell find "$(ROOT)/src" "$(ROOT)/assets/icons" -type f 2>/dev/null) \
	$(ROOT)/package.json

# The version of a release comes from the command line:
#   make release VERSION=1.2.3
# It never comes from a file in the repository, so the origin is kept.
VERSION_ORIGIN := $(origin VERSION)

.PHONY: help build test verify run install release-artifacts release-notes release clean

.DEFAULT_GOAL := help

## help — list every target

help:
	@printf '%s\n' \
		'tfm — build targets.' \
		'' \
		'  help                 List every target (default).' \
		'  build                Compile the binary into dist/tfm.' \
		'  test                 Run the changelog check, the checks, the tests and the version smoke test.' \
		'  verify               Check the compiled binary and the release checksum.' \
		'  run                  Run the compiled binary.' \
		'  install              Install the compiled binary with install.sh into ~/.local/bin.' \
		'  release-artifacts    Build the universal macOS binary and its verified checksum file.' \
		'  release-notes VERSION=x.y.z  Print the changelog section of a version.' \
		'  release VERSION=x.y.z  Bump the changelog and package.json, test, build, verify, commit and tag.' \
		'  clean                Remove the build output.' \
		'' \
		'Notes' \
		'  The version comes from the command line: `make release VERSION=1.2.3`.' \
		'  `make release` moves [Unreleased] to that version, updates package.json, runs the' \
		'  checks, builds and verifies the artifacts, commits the bump and creates the' \
		'  annotated tag. It prints the push commands and never pushes.' \
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
	cd "$(ROOT)" && ./scripts/changelog.sh check
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

## verify — check the compiled binary and the release checksum

verify: $(BIN)
	@expected="tfm $$(cd "$(ROOT)" && bun -e 'console.log(require("./package.json").version)')"; \
	actual="$$("$(BIN)" --version)"; \
	echo "Binary: $$actual (expected $$expected)"; \
	test "$$actual" = "$$expected" || { \
		echo "error: the binary reports $$actual, but package.json says $$expected."; \
		exit 1; \
	}
	@if [ -f "$(DIST)/tfm-universal-macos.gz.sha256" ]; then \
		cd "$(DIST)" && shasum -a 256 -c tfm-universal-macos.gz.sha256; \
	fi

## run — run the compiled binary

run: $(BIN)
	"$(BIN)"

## install — install the compiled binary with install.sh

install: $(BIN)
	TFM_LOCAL="$(BIN)" ./install.sh

## release-artifacts — the universal macOS binary and the sidecar the tap expects

release-artifacts:
	cd "$(ROOT)" && bun install --frozen-lockfile --os='*' --cpu='*'
	cd "$(ROOT)" && bun run scripts/build.ts mac-universal
	cd "$(DIST)" && gzip -kf tfm-universal-macos && shasum -a 256 tfm-universal-macos.gz > tfm-universal-macos.gz.sha256
	cd "$(DIST)" && shasum -a 256 -c tfm-universal-macos.gz.sha256
	@echo "$(DIST)/tfm-universal-macos.gz.sha256:"
	@cat "$(DIST)/tfm-universal-macos.gz.sha256"

## release-notes — print the changelog section of a version

release-notes:
	@if [ -z "$(strip $(VERSION))" ]; then \
		echo "error: make release-notes needs a version, for example: make release-notes VERSION=1.2.3"; \
		exit 1; \
	fi
	@./scripts/changelog.sh notes "$(VERSION)"

## release — bump, test, build, verify, commit and tag, without pushing

release:
	@if [ "$(VERSION_ORIGIN)" != "command line" ]; then \
		echo "error: make release needs the version on the command line, for example: make release VERSION=1.2.3"; \
		exit 1; \
	fi
	@if [ -z "$(strip $(VERSION))" ]; then \
		echo "error: make release needs a version, for example: make release VERSION=1.2.3"; \
		exit 1; \
	fi
	@APP_NAME="tfm" ./scripts/release.sh "$(VERSION)"

## clean — remove everything the build produces

clean:
	rm -rf "$(DIST)"
	@echo "Removed dist/."
