# tfm — build interface.
#
# `make` prints the list of targets. Every target is phony.

SHELL := /bin/bash

# Root of the repository, so every target works from any directory.
ROOT := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))

DIST    := $(ROOT)/dist
BIN     := $(DIST)/tfm
RELEASE := $(ROOT)/release

# The two darwin slices. Their names come from scripts/build.ts and are
# consumed by the release workflow as they are.
MAC_ARM   := $(DIST)/tfm-aarch64-macos
MAC_INTEL := $(DIST)/tfm-x86_64-macos
LINUX_ARM   := $(DIST)/tfm-aarch64-linux
LINUX_INTEL := $(DIST)/tfm-x86_64-linux

# verify checks the slices where lipo exists, so a Linux checkout still verifies.
ifeq ($(shell uname -s),Darwin)
VERIFY_SLICES := $(MAC_ARM) $(MAC_INTEL)
endif

# The sources of the binary, plus package.json: the version is compiled into
# the binary, so a release bump must trigger a rebuild.
SRC := $(shell find "$(ROOT)/src" "$(ROOT)/assets/icons" -type f 2>/dev/null) \
	$(ROOT)/package.json

# The version of a release comes from the command line:
#   make release VERSION=1.2.3
# It never comes from a file in the repository, so the origin is kept.
VERSION_ORIGIN := $(origin VERSION)

.PHONY: help build build-arm build-intel build-linux-arm build-linux-intel test \
	verify verify-macos verify-linux run install \
	release-artifacts release-artifacts-macos release-artifacts-linux \
	package-macos package-linux release-notes release clean

.DEFAULT_GOAL := help

## help — list every target

help:
	@printf '%s\n' \
		'tfm — build targets.' \
		'' \
		'  help                 List every target (default).' \
		'  build                Compile the binary into dist/tfm.' \
		'  build-arm            Cross-compile the arm64 macOS binary into dist/tfm-aarch64-macos.' \
		'  build-intel          Cross-compile the x86_64 macOS binary into dist/tfm-x86_64-macos.' \
		'  build-linux-arm      Cross-compile the arm64 Linux binary into dist/tfm-aarch64-linux.' \
		'  build-linux-intel    Cross-compile the x86_64 Linux binary into dist/tfm-x86_64-linux.' \
		'  test                 Run the changelog check, the checks, the tests and the version smoke test.' \
		'  verify               Check the compiled binary, the four slices, the architectures and the release checksums.' \
		'  run                  Run the compiled binary.' \
		'  install              Install the compiled binary with install.sh into ~/.local/bin.' \
		'  release-artifacts    Build the four archives, checksums.txt and the universal macOS binary.' \
		'  release-notes VERSION=x.y.z  Print the changelog section of a version.' \
		'  release VERSION=x.y.z  Bump the changelog and package.json, test, build, verify, commit and tag.' \
		'  clean                Remove the build output and the release archives.' \
		'' \
		'Notes' \
		'  The version comes from the command line: `make release VERSION=1.2.3`.' \
		'  `make release` moves [Unreleased] to that version, updates package.json, runs the' \
		'  checks, builds and verifies the artifacts, commits the bump and creates the' \
		'  annotated tag. It prints the push commands and never pushes.' \
		'  The release publishes release/tfm-<version>-{arm64,x86_64}-{linux,macos}.gz with' \
		'  release/checksums.txt.' \
		'  install.sh still downloads the unversioned dist/tfm-{aarch64,x86_64}-{linux,macos}.gz,' \
		'  and the Homebrew tap matches the universal tfm-universal-macos.gz with its' \
		'  tfm-universal-macos.gz.sha256 sidecar. Those names never change.' \
		'  The universal binary holds an arm64 and an x86_64 slice, so the build needs the' \
		'  dependencies of both architectures. `make release-artifacts` installs them for' \
		'  every OS and CPU, like the release workflow does.' \
		'  The targets need Bun 1.4 or newer and the installed dependencies:' \
		'  `bun install --frozen-lockfile`.'

## build — compile the binary

build: $(BIN)

$(BIN): $(SRC)
	cd "$(ROOT)" && bun run compile

## build-arm — cross-compile the arm64 macOS binary

build-arm: $(MAC_ARM)

$(MAC_ARM): $(SRC)
	cd "$(ROOT)" && bun install --frozen-lockfile --os='*' --cpu='*'
	cd "$(ROOT)" && bun run scripts/build.ts mac-arm64

## build-intel — cross-compile the x86_64 macOS binary

build-intel: $(MAC_INTEL)

$(MAC_INTEL): $(SRC)
	cd "$(ROOT)" && bun install --frozen-lockfile --os='*' --cpu='*'
	cd "$(ROOT)" && bun run scripts/build.ts mac-x64

## build-linux-arm — cross-compile the arm64 Linux binary

build-linux-arm: $(LINUX_ARM)

$(LINUX_ARM): $(SRC)
	cd "$(ROOT)" && bun install --frozen-lockfile --os='*' --cpu='*'
	cd "$(ROOT)" && bun run scripts/build.ts linux-arm64

## build-linux-intel — cross-compile the x86_64 Linux binary

build-linux-intel: $(LINUX_INTEL)

$(LINUX_INTEL): $(SRC)
	cd "$(ROOT)" && bun install --frozen-lockfile --os='*' --cpu='*'
	cd "$(ROOT)" && bun run scripts/build.ts linux-x64

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

## verify-macos — the macOS slices and the universal binary

verify-macos: $(VERIFY_SLICES)
	@if [ -z "$(VERIFY_SLICES)" ]; then \
		echo "macOS slices: skipped on $$(uname -s), the architecture check needs lipo."; \
	else \
		expected="tfm $$(cd "$(ROOT)" && bun -e 'console.log(require("./package.json").version)')"; \
		for pair in "aarch64:arm64" "x86_64:x86_64"; do \
			slice="$${pair%%:*}"; arch="$${pair##*:}"; \
			file="$(DIST)/tfm-$$slice-macos"; \
			test -f "$$file" || { echo "error: $$file is missing."; exit 1; }; \
			found="$$(lipo -archs "$$file")"; \
			echo "Slice: $$file ($$found, expected $$arch)"; \
			test "$$found" = "$$arch" || { \
				echo "error: $$file holds $$found, not $$arch."; \
				exit 1; \
			}; \
			if arch -$$arch /usr/bin/true 2>/dev/null; then \
				actual="$$("$$file" --version)"; \
				echo "  $$actual (expected $$expected)"; \
				test "$$actual" = "$$expected" || { \
					echo "error: $$file reports $$actual, but package.json says $$expected."; \
					exit 1; \
				}; \
			else \
				echo "  version: not runnable on this host, the architecture is checked."; \
			fi; \
		done; \
	fi
	@if [ -f "$(DIST)/tfm-universal-macos.gz.sha256" ]; then \
		cd "$(DIST)" && shasum -a 256 -c tfm-universal-macos.gz.sha256; \
	fi

## verify-linux — the Linux slices' ELF architecture, read and never executed

verify-linux: $(LINUX_ARM) $(LINUX_INTEL)
	@# The Linux slices are never executed: the check reads the ELF header, so it
	@# also runs on a macOS host.
	@for pair in "aarch64:ARM aarch64" "x86_64:x86-64"; do \
		slice="$${pair%%:*}"; want="$${pair##*:}"; \
		file="$(DIST)/tfm-$$slice-linux"; \
		test -f "$$file" || { echo "error: $$file is missing."; exit 1; }; \
		found="$$(file -b "$$file")"; \
		echo "Slice: $$file"; \
		echo "  $$found"; \
		case "$$found" in \
			*ELF*"$$want"*) ;; \
			*) echo "error: $$file is not an $$want ELF binary."; exit 1 ;; \
		esac; \
	done

## verify — the host binary, the four slices and the release checksums

verify: $(BIN) $(VERIFY_SLICES) $(LINUX_ARM) $(LINUX_INTEL)
	@expected="tfm $$(cd "$(ROOT)" && bun -e 'console.log(require("./package.json").version)')"; \
	actual="$$("$(BIN)" --version)"; \
	echo "Binary: $$actual (expected $$expected)"; \
	test "$$actual" = "$$expected" || { \
		echo "error: the binary reports $$actual, but package.json says $$expected."; \
		exit 1; \
	}
	@$(MAKE) --no-print-directory verify-macos
	@$(MAKE) --no-print-directory verify-linux
	@if [ -f "$(RELEASE)/checksums.txt" ]; then \
		cd "$(RELEASE)" && shasum -a 256 -c checksums.txt; \
	fi

## run — run the compiled binary

run: $(BIN)
	"$(BIN)"

## install — install the compiled binary with install.sh

install: $(BIN)
	TFM_LOCAL="$(BIN)" ./install.sh

## release-artifacts-macos — the macOS slices, the universal binary and the two macOS archives

release-artifacts-macos:
	cd "$(ROOT)" && bun install --frozen-lockfile --os='*' --cpu='*'
	cd "$(ROOT)" && bun run scripts/build.ts mac-arm64 mac-x64 mac-universal
	cd "$(DIST)" && gzip -kf tfm-universal-macos && shasum -a 256 tfm-universal-macos.gz > tfm-universal-macos.gz.sha256
	cd "$(DIST)" && shasum -a 256 -c tfm-universal-macos.gz.sha256
	@$(MAKE) --no-print-directory package-macos VERSION="$(VERSION)"

## release-artifacts-linux — the two Linux slices and the two Linux archives

release-artifacts-linux:
	cd "$(ROOT)" && bun install --frozen-lockfile --os='*' --cpu='*'
	cd "$(ROOT)" && bun run scripts/build.ts linux-arm64 linux-x64
	@$(MAKE) --no-print-directory package-linux VERSION="$(VERSION)"

## package-macos — the two versioned macOS archives from the built slices

package-macos:
	@version="$(strip $(VERSION))"; \
	[ -n "$$version" ] || version="$$(cd "$(ROOT)" && bun -e 'console.log(require("./package.json").version)')"; \
	mkdir -p "$(RELEASE)"; \
	for pair in "aarch64:arm64" "x86_64:x86_64"; do \
		slice="$${pair%%:*}"; arch="$${pair##*:}"; \
		test -f "$(DIST)/tfm-$$slice-macos" || { echo "error: $(DIST)/tfm-$$slice-macos is missing."; exit 1; }; \
		gzip -kf "$(DIST)/tfm-$$slice-macos"; \
		cp "$(DIST)/tfm-$$slice-macos.gz" "$(RELEASE)/tfm-$$version-$$arch-macos.gz"; \
	done

## package-linux — the versioned Linux archives of the slices that are built

package-linux:
	@version="$(strip $(VERSION))"; \
	[ -n "$$version" ] || version="$$(cd "$(ROOT)" && bun -e 'console.log(require("./package.json").version)')"; \
	mkdir -p "$(RELEASE)"; \
	packed=0; \
	for pair in "aarch64:arm64" "x86_64:x86_64"; do \
		slice="$${pair%%:*}"; arch="$${pair##*:}"; \
		[ -f "$(DIST)/tfm-$$slice-linux" ] || continue; \
		gzip -kf "$(DIST)/tfm-$$slice-linux"; \
		cp "$(DIST)/tfm-$$slice-linux.gz" "$(RELEASE)/tfm-$$version-$$arch-linux.gz"; \
		packed=1; \
	done; \
	[ "$$packed" -eq 1 ] || { echo "error: no Linux slice in $(DIST)."; exit 1; }

## release-artifacts — the four archives, checksums.txt and the universal binary

release-artifacts:
	rm -rf "$(RELEASE)"
	@$(MAKE) --no-print-directory release-artifacts-macos VERSION="$(VERSION)"
	@$(MAKE) --no-print-directory release-artifacts-linux VERSION="$(VERSION)"
	@cd "$(RELEASE)" && for f in tfm-*; do shasum -a 256 "$$f"; done > checksums.txt; \
	cd "$(RELEASE)" && shasum -a 256 -c checksums.txt
	@echo "$(RELEASE)/checksums.txt:"
	@cat "$(RELEASE)/checksums.txt"

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
	rm -rf "$(DIST)" "$(RELEASE)"
	@echo "Removed dist/ and release/."
