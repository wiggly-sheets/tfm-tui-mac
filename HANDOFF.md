# Handoff: upstream parity and OpenTUI migration

This document records what was ported from upstream, what was deliberately left
out, and what remains before this fork can be considered at parity with
`clarkarch/tfm-tui`. It also sets out the OpenTUI migration plan.

The work below is committed on `main` but not pushed. The fork point is
`510b64a` (2026-10-11). Upstream `main` was last inspected at `ae8ad34`
(2026-11-13), roughly 270 commits ahead. Upstream is not configured as a remote;
that commit is reachable locally as `FETCH_HEAD`.

## Current state

Commits made for this port:

| Commit | Scope |
| --- | --- |
| `5600d49` | Data-safety fixes in extraction, trash, and mount listing |
| `fa5e9e6` | Incoming drop state and aborted remote fetch |
| `4099bfb` | Status/props races, sidebar focus, arrow scrolling, rename width, zoom ladder |
| `e5085d4` | `[ui] thumbnail-fit` |

Verification at the time of writing:

- `bun run check` passes (Biome plus `tsgo --noEmit`).
- `bun test` passes: 2605 tests passed, 25 skipped, 0 failed across 137 files.
- Both the Linux and macOS code paths were preserved. macOS-specific trash
  layout and platform leaves were not restructured.

## Ported from upstream

These are the high-value fixes that were missing from the fork:

1. **Extraction no longer deletes stranded members** (`75125d8`).
   `src/fs/fsutil.ts` gained an extraction-stage model and a kept-stage name;
   `src/fs/fileops.ts` retains members that fail to land and reports their
   path instead of deleting the staging directory in `finally`.
2. **Stranded and partial trash moves are reported** (`5fba131`, `21ff182`).
   `TrashStrandedError`, `TrashPartialMoveError`, `SourceRemovalFailedError`,
   and `TrashMoveOutcome` make a failed rollback or a half-removed source
   visible and restorable. `src/fs/trashops.ts` reports partial results.
3. **Incoming drops and remote fetches recover** (`ce306ec`, `257ede3`).
   A single `IncomingDrop` record is cleared on error, so one failed drop no
   longer wedges the session. Remote fetches carry a token; abort rejects the
   pending request and removes its staging directory.
4. **Stale selection and status writes are rejected** (`8ebf1fc`, `bcf624e`).
   Selection counts use a status ticket and re-check the active pane at write
   time. `src/ui/ui-status.ts` owns a transient/summary phase so a selection
   count cannot cut a transient message short.
5. **Properties stats are generation-scoped** (`1967fee`). Single and multiple
   target dialogs share one open state with a generation, so an old directory
   walk cannot paint into the next dialog.
6. **Sidebar focus is explicit** (`05ae487`). One `SidebarFocus` value replaces
   the boolean plus index pair. Entering an empty sidebar is refused, and a
   grid click blurs sidebar focus, so the keyboard cannot become dead.
7. **List rename width follows the row** (`53d0d4d`). `renameWidth` is
   published by grid and list row builders instead of inheriting tile width.
8. **Icon glyphs are centered** (`f8f98f9`).
9. **Icon rasters fill the exact cell box** (`d8ce90f`). `planLetterboxedSvg`
   keeps the art centered on an exact-cell canvas, with a new disk-cache salt.
10. **Failed mount listing is not an empty device list** (`f3d2c5e`).
    `listMounts` returns `null` on failure on both platforms.
11. **Arrow keys do not double-scroll** (`21b19a3`). The key router reports
    consumption and calls `preventDefault`; pane scrollers and their bars are
    not focusable.
12. **Grid zoom uses a ladder** (`7fb5ede`). New `src/ui/zoom.ts` moves through
    fixed tile triples so zoom in and out return to the starting size.
13. **`[ui] thumbnail-fit`** (`ae8ad34`). Values are `fit`, `crop`, and
    `stretch`, applied to grid thumbnails, the preview, and mounted images
    when the setting changes. Grid thumbnails now take the tile width and the
    preview takes the pane box.

The remaining upstream commits in the assessed set are refactors that encode
the same state-machine hygiene. They are useful as reference when touching the
same code, but porting all of them wholesale would be a large rewrite with no
user-visible change.

## Deliberately skipped optional features

These were assessed and not ported. Each needs a fresh decision rather than a
mechanical cherry-pick.

- **Configurable modal scrim** (`6e89e3b` and the follow-up series through
  `988394c`, `3b93c7a`). Upstream replaced a fixed dark backdrop with
  `fill`, `dim`, and `none` modes, plus a separate `scrim-dim` value and a
  live fill overlay. The fork has a working raster scrim in
  `src/ui/ui-slots.ts` and `src/ui/floats.ts` but a different modal/floats
  architecture. A direct port would touch the modal stack, icon dimming,
  hover resets, and the theme path. Medium-to-high risk, mostly visual.
- **Smooth scrolling** (`cffec00`, `effc732`). Upstream added a wheel smoother
  and grid keyboard-jump glide, then changed the drain to use the glide time.
  The fork has no equivalent module and its grid scroller setup differs.
  This is roughly a thousand lines of new timing behavior with a real risk of
  double-scroll or lost-input regressions. High effort.
- **`tfm uninstall`** (`c08e377`, `21bceac`, and the UI follow-ups). Upstream
  assumes its Linux install layout and service/desktop integration. The fork
  has a macOS-oriented install path and an existing `--update` flow. Porting
  the command means re-deriving removal targets per platform, which is a
  separate project.
- **Confirmation dialog redesign** (`8eebb2b`, 22 files). This is a visual
  preference, not a correctness fix. The current confirmation dialog works.

## Remaining work toward parity

### 1. Data-integrity follow-ups

These should be checked against the fork before anything else. Some may
already be covered by the port, but they have not been individually verified.

- `3d9fe00` — an update check's own settle must clear only its own flight.
  The fork has a self-update path. Confirm that overlapping checks cannot
  clear each other's state.
- `4130c61` — copy landing should have one phase and one ownership rule.
  This is adjacent to the extraction fix and may reveal the same class of
  `finally` cleanup bug in the copy path.
- `3d9bc1f` — review holes in trash claim, update check, and the places
  loader. The places fix was ported; the other two need inspection.
- `222b0c9` — tighten the icon-slot no-drift rule. The extraction and raster
  changes have altered icon lifecycle code, so re-check the invariant.

### 2. User-visible fixes not yet ported

- `782000f` — reap tfm when the terminal closes instead of orphaning it.
  Worth verifying against the fork's quit and signal handling.
- `5078228` — paste plain kitty drags onto the embedded terminal.
- `195ee4d` — stop path-resolving archive URIs in the path bar and labels.
- `451824d` — number the preview gutter to the bottom of the code viewport.
- `7990967` — paint the settings cursor instead of rebuilding the panel.
- `0f5441e` — put the cache-miss input where it belongs.
- `8b31fd2` — remove the extra row above the files sidebar title.
- `72e9677` — expire the gpm press memory instead of arming it forever.
- `3bcad5d` — the fork's aspect-preserving icon raster placement. This is
  related to the exact-cell raster fix and should be reviewed together.
- `b46372e` — replace the open modal when a right-click context menu opens.
  Confirm whether the fork's floats modal stack has the same problem.
- `8cd8f2f`, `a76182c`, `22d0c92` — honest op status, missing-release
  wording, and user-triggered op notifications.

### 3. Features absent from the fork

These are larger, independent features. Porting them is not required for the
correctness fixes above.

- **RAR browsing** (`5d694b1`). Upstream added read-only RAR browsing and
  extraction after the archive virtual-directory work. The fork's archive
  reader lists tar, zip, and 7z only. RAR needs a decoder or an external tool
  decision, so treat it as its own feature.
- **Default file manager integration** (`9062411` through `ac18a5f`). Linux
  desktop-file, D-Bus, and first-boot prompt work. Not applicable to macOS as
  written.
- **USB watcher and safe removal** (`f99d92b`, `7d1ea92`). Linux-only
  `lsblk` polling and power-off behavior.
- **`tfm update` notices and the update command surface** (`675c2cc`,
  `2bac23a`, `a31f841`, `fc5677f`, `d828f9d`). The fork has self-update via
  `--update`; it does not have the toast redesign, grow-on-click messages, or
  the full notice flow. Take these as a set if the update UX matters.
- **Every action in the command palette and keybinds** (`1c41900`). The fork
  has a palette and an action table. Audit for gaps rather than porting the
  commit.
- **System ffmpeg instead of the bundled sidecar** (`6516b9b`). This affects
  packaging and Linux distributions more than macOS.
- **Lazy startup** (`b5c5de1`, `50c87f2`, `31cd362`) and the paint trace /
  shared-clock spinner (`d0d8661`). These are performance features tied to
  the OpenTUI migration. Do them after the migration, not before.
- **AOT release and plugin sealing** (`e5852b8`, `870a272`, `2dbd05e`,
  `c274798`, and the CI series). This changes how releases are built and how
  plugins are trusted. It is a build/release project, not an app fix.
- **Command palette promoted to a core `ctrl+p` action** (`5f81691`). Check
  the fork's palette binding first.

### 4. Refactor debt worth adopting opportunistically

Upstream invested heavily in replacing nullable booleans and loose fields with
explicit records. The ported fixes already use this style in trash, extraction,
DnD, status, properties, sidebar focus, and zoom. When touching adjacent code,
follow the same pattern. Do not schedule a standalone sweep: the 90-odd
refactor commits cover grid rendering, hover, search, prompts, permissions,
menus, tabs, plugin lifecycle, and boot phases, and they are unlikely to be
worth the regression risk without a concrete bug to fix.

## OpenTUI migration

### Target

- Current dependency: `@opentui/core` `0.5.16`.
- Upstream migrated to `0.6.0` in `b368dac`, then adapted to the patched fork
  in `00dc5c5`. Upstream `main` now pins
  `"@opentui/core": "npm:@clarkarch/opentui-fork@0.8.1-fork.2"`.
- Use `0.8.1-fork.2` first. It is the version upstream actually runs. Do not
  jump to the latest npm tag (`0.9.0-fork.1`) without a separate API review.

### Why this is a separate project

The migration is not a dependency bump. Upstream's 0.6/0.8 commits touch 48
and 10 files respectively and change renderer lifecycle, animation ownership,
ScrollBox internals, layout rounding, image placement, and text styling. The
fork also carries its own patches for pane trees, drag and drop, mouse resize,
macOS images, and the Linux console fallback. Each of those needs to be
re-tested against the new runtime.

### Required changes

1. **Renderer lifecycle.** `renderer.closed` must be awaited by quit and
   restart paths. Tests that create renderers must dispose them and await
   closure so the process does not hang.
2. **Animation timelines.** Use the per-renderer timeline engine rather than a
   single global engine. The grid, sidebar, hover, and notification animations
   each need to resolve their engine from the renderer they belong to.
3. **SyntaxStyle and text.** Give each style an explicit owner, dispose it with
   the renderer, and adapt to `getLayout` observables, integer colors, and
   control-character stripping.
4. **ScrollBox.** Native scrollbar parts replace the current bar construction.
   Remove writes that assume the bar is focusable, move bar change handling to
   the native hook, and route wheel input through `onMouseScroll`.
5. **Layout rounding.** Yoga now rounds centered content differently. Upstream
   had to give centered labels explicit widths and adjust the rename input's
   primary axis. Expect small one-cell shifts in the sidebar, topbar, toolbar,
   and dialogs.
6. **Images.** The patched fork exposes `placementOpacity` and
   `fillDimsImages`. These interact with the fork's scrim, icon dimming, and
   thumbnail-fit work. Re-check that raster placement still honors the exact
   cell box after the migration.
7. **Input and platform paths.** Re-test terminal mouse and DnD (OSC 72 and the
   press-hold fallback), drag resize, preview rendering, and the Linux console
   fallback. These are the most likely regressions because they depend on
   terminal capability reporting and pixel metrics.

### Suggested sequence

1. Work in a throwaway worktree. Keep `main` on 0.5.16 until the migration is
   verified.
2. Bump to `0.8.1-fork.2`, run `bun run check`, and fix the compile errors
   first. Do not change behavior while the tree is failing to typecheck.
3. Fix renderer lifecycle and test teardown. Get the suite to exit cleanly
   before touching visuals.
4. Port the animation-engine and SyntaxStyle changes.
5. Port ScrollBox and layout changes.
6. Re-test images, scrim, thumbnails, DnD, and mouse resize.
7. Run the full suite on Linux and macOS. Include a real terminal smoke test
   for kitty graphics, sixel, and the Linux console fallback.
8. Only then consider the lazy-startup and paint-trace work.

### Effort and risk

Rough effort: one working week for a careful migration with verification. The
highest risks are hangs from undisposed renderers, silent animation engines
spinning on the wrong renderer, ScrollBox input regressions, and image
placement drift on non-square cells. The thumbnail-fit and exact-cell raster
work from this port should make the image checks easier, but it also means
those paths must be in the migration test matrix.

## Verification checklist

Before declaring parity or completing the migration:

- `bun run check` passes.
- `bun test` passes with no new skips.
- Manual smoke test on macOS and Linux: start, browse, preview an image,
  preview a video, switch view modes, split and close panes, rename in list
  view, open properties on a directory, trash and restore, extract an archive
  with a deliberately failing member, and drag a file within the grid.
- Mouse drag-resize and DnD still work on kitty and on a non-kitty terminal.
- The Linux console fallback still renders list view with ASCII glyphs.
- No orphaned process after closing the terminal running tfm.

## How to inspect upstream

Upstream is not a configured remote. Fetch it read-only when needed:

```sh
git fetch https://github.com/clarkarch/tfm-tui main
git log --oneline 510b64a..FETCH_HEAD
git show <commit> -- <path>
```

Do not merge upstream wholesale. The fork's pane tree, macOS leaves, archive
browsing, self-update, and palette are independent implementations.
