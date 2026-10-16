# Quicklook + preview feature verification (post-merge)

Date: 2026-10-16
Scope: verify that commit `a81b073` ("feat: audio/GIF/archive preview and floating quicklook pane") actually landed in the merged `main` tree at `/Users/Zeb/Developer/tfm-tui`.

## Point verdicts

### 1. `src/ui/ui-quicklook.ts` — PRESENT

File exists (6,183 bytes, created 2026-10-16 13:34). Implements a non-modal floating pane.

- `src/ui/ui-quicklook.ts:18` — comment: `// non-modal means here.`
- `src/ui/ui-quicklook.ts:163` — `export const makeQuicklook = ...`

### 2. `src/ui/floats.ts` — PRESENT

Quicklook is a first-class float kind, non-modal, z-ordered just under `filemenu`.

- `src/ui/floats.ts:34` — `| "quicklook";`
- `src/ui/floats.ts:39` — `const NON_MODAL: ReadonlySet<FloatKind> = new Set<FloatKind>(["filemenu", "quicklook"]);`
- `src/ui/floats.ts:51` — `quicklook: 3590,` (under `filemenu: 3600`)

### 3. `src/ui/ui-preview.ts` — PRESENT-WITH-CAVEAT

- Audio branch: `src/ui/ui-preview.ts:311` — `if (fileIsAudio(key)) {`
- GIF branch: `src/ui/ui-preview.ts:360` — `if (fileIsGif(key) && st.size <= GIF_COUNT_MAX) {`
- Archive listing: `src/ui/ui-preview.ts:292` — `const entries = await readArchiveEntries(key, archiveFmt);`

**Caveat:** the GIF branch renders the first frame plus a frame-count label. No animated frame loop exists in the renderer pipeline, so true kitty animation is not implemented. This matches the documented shortcut from the originating worktree.

### 4. `src/fs/filetype.ts` — PRESENT

Audio extensions mapped to `file-music`:

- `src/fs/filetype.ts:88-92` — `mp3`, `flac`, `wav`, `ogg`, `oga`, `m4a`, `opus`, `aac`, `wma`, `aiff`
- `src/fs/filetype.ts:393` — `export const fileIsAudio = ...`

### 5. `src/fs/archive-read.ts` — PRESENT

File exists (5,357 bytes, created 2026-10-16 13:34). Pure JS reader for `tar`, `tar.gz`, `zip` listings.

- `src/fs/archive-read.ts:101` — `export const readArchiveEntries = ...`
- `src/ui/ui-preview.ts:292` — preview pane calls it and displays `name` + `size` rows.

### 6. Preview-inside-archive — MISSING

`src/ui/ui-preview.ts` routes archive files through `readArchiveEntries()` to display an entry list in the right preview pane, but it does **not** allow descending into an entry, opening a member, or rendering a member's contents from the preview pane.

Archive-as-folder browsing is implemented separately in the grid via `archive:///` URIs:

- `src/app/archive-nav.ts` — the virtual-folder model (descent, parent, breadcrumb).
- `src/ui/ui-grid.ts` — renders archive locations as grid rows.

So the two paths exist but are disconnected: the preview pane shows the top-level entry list only, and you must open the archive as a folder in the grid to go deeper. No integration in `ui-preview.ts` for inner-member preview.

### 7. `src/config/config-schema.ts` — PRESENT

- `src/config/config-schema.ts:411` — `| "toggleQuicklook";`
- `src/config/config-schema.ts:2010` — `["toggleQuicklook", "toggle quicklook", ["f8"], "view", "Preview the selection in a float"],`

### 8. Keymap wiring — PRESENT

- `src/input/keymap.ts:772` — `toggleQuicklook` in `ACTION_TABLE`
- `src/input/keymap.ts:867` — handled in `handleKey`
- `src/input/keymap.ts:825` — included in `commands()` for the palette
- `src/wiring/keymap.ts:138` — `const quicklook = makeQuicklook({...})`
- `src/wiring/keymap.ts:276` — `toggleQuicklook: () => quicklook.toggle(),`

## Merge gaps

1. **Preview-inside-archive (point 6).** The originating archive-ux worktree documented this as a merge step, and it did not land. Users cannot inspect individual file contents inside archives from the preview pane; they must open the archive as a folder in the grid.
2. **Animated GIF (point 3).** Kitty frame animation is a documented shortcut, not implemented. All terminals show the first frame plus a frame-count label.

## Notes

- The quicklook pane is non-modal (no desktop dimming, no modal capture), so it coexists with the grid rather than blocking it.
- Esc dismisses the quicklook pane; the same `f8` key toggles it off.