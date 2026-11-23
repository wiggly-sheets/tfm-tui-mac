# Changelog

## [Unreleased]

## [1.1.0] - 2026-11-23

### Added

**Self-update for install.sh installs:**

- `tfm --update` downloads the latest release for this platform, verifies its
  `sha256`, smoke-tests the staged build and atomically replaces the installed
  binary. It also refreshes the `terminal-file-manager` name and the bundled
  `tfm-ffmpeg` sidecar when those already exist.
- A background check runs at most once a day and toasts when a newer release
  exists. Turn it off with `[update] check = false`.
- Copies not installed by install.sh — dev builds, package-manager installs,
  moved binaries — are refused with a short message.
- `install.sh` now records an install marker (`$XDG_DATA_HOME/tfm/install.json`)
  so the running binary can tell it was installed by this script.

**macOS support:**

- macOS is supported with full port parity on Intel and Apple Silicon, plus a
  lipo universal binary. Trash, servers, Finder tags and file opens go through
  the built-in macOS tools (`trash`, `diskutil`, `open`); the XDG config,
  state and cache paths apply there too. macOS builds and tests run in CI.

**Keyboard and navigation:**

- Cmd/Super is a distinct modifier (`cmd` / `super` / `command`) alongside alt.
- Go to Folder quick-jump popup (`shift+cmd+g`, remappable).
- New shortcuts: `ctrl+b` toggle sidebar, `alt+t` next theme, `alt+s` cycle
  sort, `alt+shift+s` reverse sort.

**Panes and view:**

- Per-pane view modes plus a new Miller columns view; `ctrl+g` cycles the
  active pane's mode (grid → list → columns).
- Split panes: `ctrl+shift+h`/`ctrl+shift+v` split the focused pane side by
  side or stacked, `ctrl+shift+w` closes it (no-op at one pane), `tab` cycles
  focus. The layout is a mixed vertical/horizontal tree of panes and lives in
  memory only, so it restarts clean. `[ui] dual-pane` still reconciles:
  turning it on splits to at least two panes, turning it off closes `p1` only
  (manual splits stay).
- Sync browsing (`[ui] sync-browsing`, off by default, `ctrl+shift+b`): entering
  a directory in the active pane opens it in the other pane.
- Toggleable right-hand info sidebar (`[ui] info-sidebar`, off by default, `f7`)
  showing details for the current selection; it shares the right column with the
  preview.

**Interaction:**

- Internal drag and drop on every terminal (OSC 72 on kitty, press-hold
  fallback elsewhere).
- Opt-in mouse drag-resize: `[ui] mouse-resize-sidebar`, `mouse-resize-split`
  and `mouse-resize-preview`, all off by default.

**Thumbnails:**

- `[ui] thumbnail-fit` chooses how thumbnails fill their box: `fit` shows the
  whole image, `crop` fills the box and crops overflow, and `stretch` fills it
  and distorts the source. The setting applies to grid thumbnails, the preview
  pane and properties, and changing it re-fits images already on screen.

### Changed

**Build and CI:**

- CI runs the compiled binary and checks its `--version` output; both workflows
  add concurrency groups and least-privilege permissions; releases publish the
  notes of the CHANGELOG and keep artifacts for seven days.
- The build interface now follows the shared contract of the estate: `make`
  prints the targets, `make build` compiles the binary, `make test` runs the
  checks and the test suite, `make release-artifacts` builds the universal
  binary with its checksum file, `make release VERSION=x.y.z` prepares a
  release without pushing, and `make clean` removes the build output.
- The release notes come from the section of this CHANGELOG for the released
  version. A stable version without a section fails the release.
- Dependabot for bun and GitHub Actions; issue and PR templates; `SECURITY.md`
  and `CONTRIBUTING.md`.

**Build and packaging:**

- `scripts/build.ts` builds any subset of the release targets (`linux-x64`,
  `linux-arm64`, `mac-x64`, `mac-arm64`, `mac-universal`) from one host, or
  `all` for the full matrix. `mac-universal` lipos both darwin slices into
  `dist/tfm-universal-macos` (macOS host required).
- Release CI ships macOS x64, arm64 and universal binaries; `install.sh`
  recognizes `Darwin-x86_64`.

### Fixed

**Installer:**

- The download bar reports the live speed and the ETA under the `/bin/bash`
  3.2 that macOS ships, which has no `$EPOCHREALTIME`; before, both stayed
  an em dash for the whole download.

**macOS fixes:**

- Renames work correctly on case-insensitive APFS.
- Writing a file no longer clobbers its Finder tags.
- Copy preserves extended attributes (Finder tags, quarantine, resource forks)
  on a bounded background lane, so per-file progress never waits on the
  attribute spawns.
- Finder tag sync uses the `tag` CLI only (writing the tag attribute directly
  would corrupt it); with no CLI installed tfm leaves the attribute untouched.
- `/System/Applications` is searched for bundled apps.

**Icon rendering:**

- Corrected the image-protocol fallback: iTerm2 now falls back to Nerd Font
  glyphs. Stable iTerm2 does not report pixel dimensions, so the previous
  sixel placements reserved cell space and rendered blank. kitty, WezTerm and
  Ghostty keep color rasters; tmux, the Linux console and terminals with no
  graphics protocol keep their glyphs.
- Icon glyphs are centered in their slot, so a list row's icon shares the row
  with its name instead of sitting above it. Rasters are drawn on an exact cell
  canvas, which removes the softening and sixel alpha holes caused by the
  terminal rescaling a non-square image.

**File safety and UI reliability:**

- Archive extraction keeps members that could not land in a recovery folder
  and reports its path, instead of deleting the staging directory and showing
  only FAILED.
- A trash move whose rollback fails reports the stranded file path. A
  cross-device move whose source removal fails keeps the trash entry
  restorable and reports the partial state.
- A failed remote drop clears its in-flight state, so later drops are not
  refused. Aborting a remote fetch rejects its pending request and removes its
  staging directory.
- Selection counts check that their pane is still active before writing, and a
  transient status message is not replaced early by a selection summary.
- Properties stats are scoped to the dialog that requested them, so a slow
  directory walk cannot paint into the next properties dialog.
- Sidebar focus is one validated value. Entering an empty sidebar is refused
  and clicking the grid clears sidebar focus, so the keyboard cannot become
  unresponsive.
- Inline rename in list view follows the name column instead of the grid tile
  width.
- Arrow keys mark their keypress handled, so the focused grid scroller no
  longer scrolls a second time.
- A failed mount listing is reported as unknown instead of as an empty device
  list.
- Grid zoom uses a fixed ladder of tile triples, so zooming in and back out
  returns to the starting size.

<!-- pre-versioning -->

## 1.0.0 — first stable release

Terminal file manager goes stable: the beta warning is lifted and the
version is `1.0.0`.

Stability work in this release:

- Quit refuses while file operations are in flight (same guard restart
  already had) instead of exiting mid-batch and stranding completed files
  with no undo entry.
- Plugin `beforeFileOp` veto now covers `extract` and `compress` (it
  previously covered only copy/move/rename/duplicate/trash paths).
- Archive extraction is staged + contained: tools that write outside the
  staging dir (`../` members) are refused with the escape moved to trash
  (recoverable, never deleted), and symlinks resolving outside staging are
  removed before entries move into place.
- Bulk rename re-checks each target at apply time so a file created
  between planning and applying is never silently overwritten.
- Per-mount trash sidecars no longer fall back to the home trash: a
  missing `$topdir/.Trash-$uid` sidecar (or unreadable original-path
  lookup) no longer touches or resolves to a same-named home entry.
- Undo journal `trash` steps are idempotent: undoing a copy whose target
  is already gone succeeds instead of reporting FAILED.
- Sudo outcomes keep their permission-qualified undo hint
  (`ctrl+z to undo (may need permission)`); trash/restore stay
  unprivileged by design, deletes escalate without an undo promise.
