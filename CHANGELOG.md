# Changelog

## Unreleased

macOS is now supported with full port parity. Releases ship
`aarch64-macos`; trash, servers, Finder tags and file opens go through the
built-in macOS tools (`trash`, `diskutil`, `open`). macOS is added to CI.

macOS fixes in this release:

- Renames work correctly on case-insensitive APFS.
- Writing a file no longer clobbers its Finder tags.
- Copy preserves extended attributes (Finder tags, quarantine, resource forks)
  on a bounded background lane, so per-file progress never waits on the
  attribute spawns.
- Finder tag sync uses the `tag` CLI only (writing the tag attribute directly
  would corrupt it); with no CLI installed tfm leaves the attribute untouched.
- `/System/Applications` is searched for bundled apps.

Icon rendering fix in this release:

- Corrected the image-protocol fallback: iTerm2 now falls back to Nerd Font
  glyphs. Stable iTerm2 does not report pixel dimensions, so the previous
  sixel placements reserved cell space and rendered blank. kitty, WezTerm and
  Ghostty keep color rasters; tmux, the Linux console and terminals with no
  graphics protocol keep their glyphs.

Build and packaging in this release:

- `scripts/build.ts` builds any subset of the release targets (`linux-x64`,
  `linux-arm64`, `mac-x64`, `mac-arm64`, `mac-universal`) from one host, or
  `all` for the full matrix. `mac-universal` lipos both darwin slices into
  `dist/tfm-universal-macos` (macOS host required).
- Release CI ships macOS x64, arm64 and universal binaries; `install.sh`
  recognizes `Darwin-x86_64`.

Keyboard and navigation in this release:

- Cmd/Super is a distinct modifier (`cmd` / `super` / `command`) alongside alt.
- Go to Folder quick-jump popup (`shift+cmd+g`, remappable).
- New shortcuts: `ctrl+b` toggle sidebar, `alt+t` next theme, `alt+s` cycle
  sort, `alt+shift+s` reverse sort.

Panes and view in this release:

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

Interaction in this release:

- Internal drag and drop on every terminal (OSC 72 on kitty, press-hold
  fallback elsewhere).
- Opt-in mouse drag-resize: `[ui] mouse-resize-sidebar`, `mouse-resize-split`
  and `mouse-resize-preview`, all off by default.

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
