// --- Selection + keyboard-focus state: the single source of truth for "which
// tiles are selected/focused" shared by the grid render, mouse pipeline
// (grid-input), OSC 72 drop targeting, keyboard router and status bar. The
// focus/anchor lets and the tileRefs map live HERE (not index) so ui-grid and
// keymap reach them through one injected object. Visual painting (surfaces,
// icon states) still flows through ctx — no renderer imports. ---
import { lstat, readdir } from "node:fs/promises";
import { applySurface, tileSurface, type UiStyle } from "../ui/style";
import { fmtBytes, inodeKey } from "../fs/propsinfo";
import type { Theme } from "../config/config";
import type { ClipItem } from "./grid-input";
import { TileVisual, type TileVisualMode } from "./grid-input";
import { IconStateIdx, type IconSpec } from "../ui/ui-slots";
import type { MaybeNode, ScrollerLike } from "../lib/node-like";

export type SelTileRef = {
  iconSpec?: IconSpec;
  iconSlotId?: string;
  selected: boolean;
  baseFg: string;
  tileId: string;
  labelId: string;
  isDir: boolean;
  // grid tiles with room for the configured hover distance/direction move
  // their icon on hover (rest layout untouched); the rest keep the highlight.
  hoverLift?: boolean;
  // Resolved DOM nodes cached at build time. setTileVisual reads these directly
  // instead of walking ctx.byId three times per tile (a 10k-folder selectAll
  // used to do 30k tree traversals). Test fakes that build refs by hand leave
  // them undefined and setTileVisual falls back to byId for those.
  tileNode?: MaybeNode;
  labelNode?: MaybeNode;
  slotNode?: MaybeNode;
};

export type SelectionCtx = {
  colors(): Theme;
  uiStyle(): UiStyle;
  byId(id: string): MaybeNode;
  // transparent-bg force: rest fills clear so the terminal shows through.
  // Optional so test fakes stay light; absent = opaque/transparent behavior.
  transparentForce?(): boolean;
  setText(id: string, s: string): void;
  setIconState(spec: IconSpec | undefined, mode: number): void;
  isCutKey(key: string): boolean;
  scroller(): ScrollerLike | null;
  viewH(): number;
  rowHInit(): number;
  renderPreview(): void | Promise<void>;
  // live info-sidebar refresh (selectAll/invert/clear/band paths reach here but
  // NOT renderPreview). Optional so test fakes keep working; debounced upstream.
  renderInfo?(): void;
  onSelection?: (paths: string[]) => void;
  // false for an inactive pane: its selection must not drive the shared status
  // bar or emit plugin selection events (the active pane owns those). Absent =
  // always active (single-pane callers / tests).
  isActive?: () => boolean;
  dimInactivePanes?: () => boolean;
};

export type Selection = ReturnType<typeof makeSelection>;

export const makeSelection = (ctx: SelectionCtx) => {
  const tileRefs = new Map<string, SelTileRef>();

  // keyboard focus over tiles
  let focusKeys: string[] = [];
  let focusIdx = -1;
  let colsAtBuild = 1;
  // per-row height of the last build (TILE_H for grid, 1 for list) — keyboard
  // scrolling uses it to page by the right amount in either view mode
  let rowHAtBuild = ctx.rowHInit();
  // anchor tile for shift+click range selection (index into focusKeys)
  let selAnchor: number | null = null;

  const setTileVisual = (key: string, mode: TileVisualMode): void => {
    const refs = tileRefs.get(key);
    if (!refs) return;
    // The keyboard cursor is not a raster state: it reuses the accent raster
    // (IconStateIdx.Active) with the accent label over the REST tile surface.
    // Selected tiles keep their selected surface (the cursor is invisible on
    // them — membership is the stronger signal).
    const cursor = mode === TileVisual.Cursor;
    const cut = mode === TileVisual.Rest && !refs.selected && ctx.isCutKey(key);
    ctx.setIconState(refs.iconSpec, cut ? IconStateIdx.Cut : cursor ? IconStateIdx.Active : mode);
    if (!refs.iconSpec) {
      // thumbnail slots have no state rasters — fade the whole slot instead
      try {
        const slot = refs.slotNode ?? ctx.byId(refs.iconSlotId ?? "");
        if (slot) slot.opacity = cut ? 0.45 : 1;
      } catch {}
    }
    const labelReal = refs.labelNode ?? ctx.byId(refs.labelId);
    if (labelReal) {
      try {
        // hover lifts the label to white (readable on the blue hover fill);
        // rest keeps the tile's own baseFg. No-op in presets (white == fg).
        labelReal.fg =
          mode === TileVisual.Selected || cursor
            ? ctx.colors().accent
            : mode === TileVisual.Hover
              ? ctx.colors().white
              : cut
                ? ctx.colors().sidebarFgMuted
                : refs.baseFg;
      } catch {}
    }
    const tileReal = ctx.byId(refs.tileId);
    if (tileReal) {
      let state: "selected" | "hover" | "cut" | "rest" | "inactive" =
        mode === TileVisual.Selected ? "selected" : mode === TileVisual.Hover ? "hover" : cut ? "cut" : "rest";
      if (state === "rest" && ctx.isActive && !ctx.isActive() && ctx.dimInactivePanes?.()) {
        state = "inactive";
      }
      applySurface(
        tileReal,
        tileSurface(ctx.uiStyle(), ctx.colors(), state, ctx.transparentForce?.() ? "force" : undefined),
      );
    }
  };

  const tileStates = (dim: boolean): Array<{ fg: string; bg: string }> => {
    const norm = dim ? ctx.colors().sidebarFgMuted : ctx.colors().sidebarFg;
    return [
      { fg: norm, bg: ctx.colors().bg }, // Rest
      { fg: norm, bg: ctx.colors().hoverBg }, // Hover
      { fg: ctx.colors().accent, bg: ctx.colors().accentBg }, // Selected
      { fg: ctx.colors().sidebarFgMuted, bg: ctx.colors().bg }, // Cut (pending move)
    ];
  };

  // keep the cursor row inside the viewport (grid: by row, list: by row)
  const scrollIntoView = (idx: number): void => {
    const scroller = ctx.scroller();
    if (!scroller) return;
    try {
      const row = Math.floor(idx / colsAtBuild);
      const vh = ctx.viewH();
      const top = scroller.scrollTop;
      if (row * rowHAtBuild < top) scroller.scrollTo?.({ x: 0, y: row * rowHAtBuild });
      else if ((row + 1) * rowHAtBuild > top + vh) scroller.scrollTo?.({ x: 0, y: (row + 1) * rowHAtBuild - vh });
    } catch {}
  };

  // --- keyboard cursor, distinct from the selected set --------------------
  // Arrow/page movement walks the cursor. Until the user builds an explicit
  // set (space/shift/ctrl/selectAll), the cursor tile IS the selection and
  // moves with it — so Delete can never act on a stale file while Enter and
  // the preview follow the cursor. Once a set exists, plain movement leaves
  // it alone (the docs' "moving the cursor does not change the selection").
  let explicitSet = false;

  const selectedCount = (): number => {
    let n = 0;
    for (const r of tileRefs.values()) if (r.selected) n++;
    return n;
  };

  const cursorKey = (): string | undefined => focusKeys[focusIdx];

  // repaint the tile the cursor sits on: selected surface wins, otherwise the
  // cursor cue (accent icon + accent label over the rest surface)
  const paintCursor = (): void => {
    const key = focusKeys[focusIdx];
    if (key === undefined) return;
    const refs = tileRefs.get(key);
    if (!refs) return;
    setTileVisual(key, refs.selected ? TileVisual.Selected : TileVisual.Cursor);
  };

  // the tile is no longer the cursor (or was never painted): fall back to what
  // the tile really is
  const clearCursorPaint = (idx: number): void => {
    const key = focusKeys[idx];
    if (key === undefined) return;
    const refs = tileRefs.get(key);
    if (!refs) return;
    setTileVisual(key, refs.selected ? TileVisual.Selected : TileVisual.Rest);
  };

  const moveCursorTo = (idx: number, keepAnchor = false): boolean => {
    if (idx < 0 || idx >= focusKeys.length) return false;
    const key = focusKeys[idx];
    if (key === undefined) return false;
    const oldKey = focusKeys[focusIdx];
    // follow only an implicit SINGLE selection: a band/ctrl-click set (even
    // if it was built by direct ref mutation) must survive plain movement
    const follow = !explicitSet && selectedCount() <= 1;
    clearCursorPaint(focusIdx);
    if (follow && oldKey !== undefined && oldKey !== key) {
      const oldRefs = tileRefs.get(oldKey);
      if (oldRefs?.selected) {
        oldRefs.selected = false;
        setTileVisual(oldKey, TileVisual.Rest);
      }
    }
    focusIdx = idx;
    // a plain move re-anchors (the mouse press does too); range-extend passes
    // keepAnchor so its own anchor survives the focus jump
    if (!keepAnchor) selAnchor = idx;
    const refs = tileRefs.get(key);
    if (refs) {
      // implicit single selection: it follows the cursor (Delete/Enter agree)
      if (follow) refs.selected = true;
      setTileVisual(key, refs.selected ? TileVisual.Selected : TileVisual.Cursor);
    }
    if (follow) updateSelectionStatusReal();
    void ctx.renderPreview();
    scrollIntoView(idx);
    return true;
  };

  // seed/repaint the cursor after a rebuild or a focus hand-back: the previous
  // focus key may be gone (navigate, delete) — landing on tile 0 keeps Enter
  // and arrows live instead of dead-ending on focusIdx -1. An empty selection
  // stays empty (nothing is acted on until the user selects), but the cursor
  // cue shows where the next open/arrow will land.
  const ensureCursor = (): void => {
    if (focusKeys.length === 0) {
      focusIdx = -1;
      return;
    }
    if (focusIdx < 0 || focusIdx >= focusKeys.length) focusIdx = 0;
    if (selAnchor === null) selAnchor = focusIdx;
    if (selectedCount() === 0) explicitSet = false;
    paintCursor();
    updateSelectionStatusReal();
  };

  const selPaths = (): ClipItem[] => {
    const out: ClipItem[] = [];
    tileRefs.forEach((r, k) => {
      if (r.selected) out.push({ path: k, isDir: r.isDir });
    });
    return out;
  };

  let selStatusGen = 0;
  // last emitted selection (joined): rubber-band moves and rebuilds call
  // updateSelectionStatusReal constantly with unchanged paths — plugins must
  // not be spammed with identical events.
  let lastEmittedSel = "";
  const updateSelectionStatusReal = (): void => {
    // an inactive pane's selection never drives the shared status/events
    if (ctx.isActive && !ctx.isActive()) return;
    try {
      const paths = selPaths().map((s) => s.path);
      const sig = paths.join("\0");
      if (sig !== lastEmittedSel) {
        lastEmittedSel = sig;
        ctx.onSelection?.(paths);
      }
    } catch {}
    ctx.renderInfo?.();
    const gen = ++selStatusGen;
    const sel: { key: string; isDir: boolean }[] = [];
    tileRefs.forEach((r, k) => {
      if (r.selected) sel.push({ key: k, isDir: r.isDir });
    });
    const setStatus = (s: string) => {
      if (gen !== selStatusGen) return;
      ctx.setText("tfm-status-label", s);
    };
    if (sel.length === 0) {
      setStatus("");
      return;
    }
    // total size is on-disk cost: links count their own bytes (the copy engine
    // preserves them via readlink/symlink, never the target), and hardlinked
    // names sharing one dev:ino count their body once — like du. lstat never
    // reports a link as a directory, so links-to-dirs land in bytes while real
    // dirs contribute their item count below instead.
    // The count renders immediately; the stat pass runs with bounded
    // concurrency (was one sequential lstat per selection, ~1s for 20k) and
    // aborts as soon as a newer selection supersedes it.
    setStatus(`${sel.length} selected`);
    void (async () => {
      let bytes = 0;
      const seen = new Set<string>();
      const files = sel.filter((s) => !s.isDir);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < files.length) {
          if (gen !== selStatusGen) return;
          const s = files[next++];
          if (!s) return;
          try {
            const lst = await lstat(s.key);
            if (lst.isDirectory()) continue;
            const k = inodeKey(lst);
            if (seen.has(k)) continue;
            seen.add(k);
            bytes += lst.size;
          } catch {}
        }
      };
      await Promise.all(Array.from({ length: Math.min(32, files.length) }, worker));
      if (gen !== selStatusGen) return;
      const dirs = sel.filter((s) => s.isDir);
      const bits = [`${sel.length} selected`];
      if (bytes > 0) bits.push(fmtBytes(bytes));
      if (dirs.length === 1 && sel.length === 1) {
        const d = dirs[0];
        if (d) {
          try {
            bits.push(`${(await readdir(d.key)).length} items`);
          } catch {}
        }
      }
      if (gen !== selStatusGen) return;
      setStatus(bits.join(" · "));
    })();
  };

  const clearTileSelection = (): void => {
    // an explicitly emptied selection is still "no set": the next arrow
    // re-seeds the cursor tile (selectRange/selectTileAt set their own flag)
    explicitSet = false;
    tileRefs.forEach((refs, k) => {
      if (refs.selected) {
        refs.selected = false;
        setTileVisual(k, TileVisual.Rest);
      }
    });
    // the cursor may have been hidden under the selected surface
    paintCursor();
    updateSelectionStatusReal();
  };

  const selectRange = (from: number, to: number): void => {
    clearTileSelection();
    explicitSet = true;
    if (focusKeys.length === 0) return;
    const lo = Math.max(0, Math.min(from, to));
    const hi = Math.min(focusKeys.length - 1, Math.max(from, to));
    for (let i = lo; i <= hi; i++) {
      const k = focusKeys[i];
      if (k === undefined) continue;
      const r = tileRefs.get(k);
      if (r) {
        r.selected = true;
        setTileVisual(k, TileVisual.Selected);
      }
    }
    paintCursor();
  };

  // explicit "select exactly this tile" (mouse-like, sidebar return, plugin
  // paths) — unlike arrow movement it DOES replace the selection
  const selectTileAt = (idx: number, keepAnchor = false): boolean => {
    if (idx < 0 || idx >= focusKeys.length) return false;
    const prevFocus = focusIdx;
    clearTileSelection();
    const key = focusKeys[idx];
    if (key === undefined) return false;
    // the old cursor cue is not the tile's real state any more
    clearCursorPaint(prevFocus);
    const refs = tileRefs.get(key);
    if (refs) {
      refs.selected = true;
      setTileVisual(key, TileVisual.Selected);
    }
    focusIdx = idx;
    // a click replaces the selection with one tile; from here arrows move the
    // cursor only (the selectTileAt "cursor vs selection" contract)
    explicitSet = true;
    // a plain move re-anchors (the mouse press does too); range-extend passes
    // keepAnchor so its own anchor survives the focus jump
    if (!keepAnchor) selAnchor = idx;
    updateSelectionStatusReal();
    void ctx.renderPreview();
    scrollIntoView(idx);
    return true;
  };

  const moveFocus = (dx: number, dy: number): boolean => {
    if (focusKeys.length === 0) return false;
    let next = focusIdx === -1 ? 0 : focusIdx + dx + dy * colsAtBuild;
    next = Math.max(0, Math.min(focusKeys.length - 1, next));
    if (next === focusIdx) return false;
    return moveCursorTo(next);
  };

  // page jump for the pageUp/pageDown keybinds: visible rows (viewH/rowH
  // from the build tail) times the column count, clamped to the listing
  const pageBy = (dir: number): boolean => {
    if (focusKeys.length === 0) return false;
    const rows = Math.max(1, Math.floor(ctx.viewH() / Math.max(1, rowHAtBuild)));
    const step = rows * Math.max(1, colsAtBuild);
    const base = focusIdx === -1 ? (dir > 0 ? -1 : focusKeys.length) : focusIdx;
    const next = Math.max(0, Math.min(focusKeys.length - 1, base + dir * step));
    if (next === focusIdx) return false;
    return moveCursorTo(next);
  };

  const selectAll = (): void => {
    explicitSet = true;
    tileRefs.forEach((r, k) => {
      r.selected = true;
      setTileVisual(k, TileVisual.Selected);
    });
    // re-anchor to the focus: a later shift+arrow must extend from here, not
    // from a stale pre-selectAll anchor
    selAnchor = focusIdx >= 0 ? focusIdx : null;
    paintCursor();
    updateSelectionStatusReal();
  };

  // flip every tile's membership (yazi ctrl+r)
  const invertSelection = (): void => {
    explicitSet = true;
    tileRefs.forEach((r, k) => {
      r.selected = !r.selected;
      setTileVisual(k, r.selected ? TileVisual.Selected : TileVisual.Rest);
    });
    selAnchor = focusIdx >= 0 ? focusIdx : null;
    paintCursor();
    updateSelectionStatusReal();
  };

  // flip the cursor's tile only, cursor stays put (yazi space toggles; unlike
  // yazi there is no auto-advance — repeat space walks with arrows). With no
  // cursor yet (fresh listing) space lands on the first tile, so
  // space+down+space builds a two-tile set.
  const toggleFocused = (): boolean => {
    if (focusKeys.length === 0) return false;
    if (focusIdx < 0 || focusIdx >= focusKeys.length) focusIdx = 0;
    const key = focusKeys[focusIdx];
    if (key === undefined) return false;
    const refs = tileRefs.get(key);
    if (!refs) return false;
    explicitSet = true;
    refs.selected = !refs.selected;
    setTileVisual(key, refs.selected ? TileVisual.Selected : TileVisual.Cursor);
    updateSelectionStatusReal();
    void ctx.renderPreview();
    return true;
  };

  // select an explicit set of paths (plugin api.select). Paths not currently
  // listed are ignored; focus lands on the first match. Used to drive the
  // selection from outside the mouse/keyboard pipeline.
  const selectPaths = (paths: string[]): void => {
    // clear refs inline: clearTileSelection() would emit a spurious empty
    // selection event to plugins before the real one
    clearCursorPaint(focusIdx);
    tileRefs.forEach((refs, k) => {
      if (refs.selected) {
        refs.selected = false;
        setTileVisual(k, TileVisual.Rest);
      }
    });
    const want = new Set(paths);
    let firstIdx = -1;
    for (let i = 0; i < focusKeys.length; i++) {
      const k = focusKeys[i];
      if (k === undefined || !want.has(k)) continue;
      const r = tileRefs.get(k);
      if (!r) continue;
      r.selected = true;
      setTileVisual(k, TileVisual.Selected);
      if (firstIdx < 0) firstIdx = i;
    }
    // focus/anchor always follow the new selection (-1/null when nothing matched)
    focusIdx = firstIdx;
    explicitSet = paths.length > 1;
    selAnchor = firstIdx < 0 ? null : firstIdx;
    if (firstIdx >= 0) {
      void ctx.renderPreview();
      scrollIntoView(firstIdx);
    }
    updateSelectionStatusReal();
  };

  // re-apply resting visuals after a cut/copy/paste so dimming tracks the
  // clipboard. The cursor keeps its cue (an unselected cursor tile is not a
  // plain rest tile) unless it is itself a cut key — the cut dim wins there.
  const refreshCutVisuals = (): void => {
    const key = cursorKey();
    tileRefs.forEach((refs, k) => {
      if (refs.selected) return;
      if (k === key) setTileVisual(k, ctx.isCutKey(k) ? TileVisual.Rest : TileVisual.Cursor);
      else setTileVisual(k, TileVisual.Rest);
    });
  };

  return {
    tileRefs,
    // let accessors — renderGrid (ui-grid) writes at every rebuild tail, the
    // keyboard router reads for paging/extend; never snapshot these
    focusKeys: (): string[] => focusKeys,
    setFocusKeys: (keys: string[]): void => {
      focusKeys = keys;
    },
    focusIdx: (): number => focusIdx,
    setFocusIdx: (v: number): void => {
      // the old tile is no longer the cursor: drop its cue (the new cursor is
      // painted by the caller — ensureCursor/paintCursor after a rebuild, the
      // tile-selection paint on a mouse press)
      if (v !== focusIdx) clearCursorPaint(focusIdx);
      focusIdx = v;
    },
    colsAtBuild: (): number => colsAtBuild,
    setCols: (v: number): void => {
      colsAtBuild = v;
    },
    rowHAtBuild: (): number => rowHAtBuild,
    setRowH: (v: number): void => {
      rowHAtBuild = v;
    },
    selAnchor: (): number | null => selAnchor,
    setSelAnchor: (v: number | null): void => {
      selAnchor = v;
    },
    // methods
    setTileVisual,
    tileStates,
    selPaths,
    updateSelectionStatusReal,
    clearTileSelection,
    selectRange,
    selectTileAt,
    moveFocus,
    moveCursorTo,
    ensureCursor,
    paintCursor,
    pageBy,
    selectAll,
    invertSelection,
    toggleFocused,
    selectPaths,
    refreshCutVisuals,
  };
};
