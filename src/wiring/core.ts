// --- Core wiring: config, theme, glyph fallbacks, post-mount lookup, icon
// slots, floats, app state — everything created before the renderer boots,
// plus the mutable geometry cell that applyConfig() rewrites (never baked
// into consts) and the scroller ref the boot layout assigns. Renderer- and
// fileops-coupled deps arrive as getters (TDZ seam rule — the renderer is
// created later by the chrome wiring, the clipboard by the fileops wiring;
// both are only read at runtime, post-boot). ---

import os from "node:os";
import type { CliRenderer, ScrollBoxRenderable } from "@opentui/core";
import { loadConfig, type Theme } from "../config/config";
import { ensureThemeSample } from "../config/themes";
import { deriveColors } from "../config/color";
import { applySurface, sideInnerWidth } from "../ui/style";
import { ensureGlyphFallbacks, glyphFor } from "../ui/glyphs";
import { asciiGlyphFor, resolveTtyMode, ttyStaticTheme } from "../ui/tty";
import { FILE_ICON_BY_EXT } from "../fs/filetype";
import { isVirtualUri } from "../fs/uri";
import { isTrashFilesDir } from "../fs/fsutil";
import { isCutKeyFor } from "../fs/clipboard";
import { makeLookup, makeResolutionGate } from "../ui/ui-lookup";
import { makePointerSetter, makeSlots } from "../ui/ui-slots";
import { makeFloats } from "../ui/floats";
import { initialAppState, type AppState } from "../app/nav";
import { appendLog } from "../app/log";
import { activeFacade } from "../app/panes";
import {
  closePane,
  cyclePane,
  defaultTree,
  findLeaf,
  indexFromId,
  leafIds,
  moveActiveTo,
  paneColId,
  splitPane,
  type LayoutNode,
  type LayoutTree,
  type PaneId,
  type SplitOrientation,
} from "../app/layout";

export type CoreWiring = ReturnType<typeof wireCore>;

export const wireCore = (deps: {
  // () => renderer — TDZ: the chrome wiring creates it later
  renderer(): CliRenderer;
  // live fileops clipboard read (isCutKey tile dimming)
  clipboard(): { mode: "copy" | "cut"; items: { path: string }[] } | null;
  // a launch FILE path (`tfm some/file.txt`) to highlight after the first build
  pendingSelect?: string | null;
}) => {
  // --- Config (TOML at ~/.config/tfm/config.toml, TFM_CONFIG overrides path) ---
  const config = loadConfig();
  // first run only: drop a sample theme template into ~/.config/tfm/themes so
  // porting another theme is copy/paste instead of reverse-engineering the schema
  ensureThemeSample();

  // --- Color palette (theme from config; transparent-bg nudge lives in ./color).
  // Tty mode forces opaque AND ignores the user's [theme] hues: the VT ignores
  // 48;2 truecolor, so a snapped custom theme always went muddy — one static
  // console palette (dark/light by configured-bg brightness) paints instead.
  // config.theme is still STORED untouched, so leaving the console restores it.
  const ttyMode = resolveTtyMode(config.ui.ttyMode, process.env.TERM);
  const colors = ttyMode ? ttyStaticTheme<Theme>(config.theme) : deriveColors(config.theme, config.ui.transparentBg);
  const themeGet = (): Theme => colors;

  // --- Geometry applyConfig() rewrites through this cell — never bake into consts ---
  const geometry = {
    sw: config.ui.sidebarWidth,
    tileW: config.ui.tileWidth,
    tileH: config.ui.tileHeight,
    iconCells: config.ui.iconCells,
    // effective pane widths the grid reads for column math. The hover drawer
    // rewrites these as panes collapse/expand; `sw` above stays the config
    // width for sidebar CONTENT (baked at full size and clipped, not rebuilt).
    sidebarEff: config.ui.sidebarWidth,
    // the shared RIGHT region: preview and the info sidebar are mutually
    // exclusive and equally wide, so the reserved width is preview-width if
    // EITHER is on
    previewEff: config.ui.previewEnabled || config.ui.infoSidebar ? config.ui.previewWidth : 0,
    // the pane split ratio (mouse-resize-split): percent of the split area the
    // LEFT pane keeps. Session-only, like the pane tree it divides — the boot
    // layout's even flexGrow pair IS 50.
    splitPct: 50,
  };

  // inner width available to children of the sidebar panel (outline border
  // math lives in ./style)
  const sideInnerW = (): number => sideInnerWidth(config.ui.uiStyle, geometry.sw);

  // --- Tty mode (Linux console / dumb terms): single effective switch.
  // `auto` follows the TERM prefix; `on`/`off` override. Live-read so a
  // settings flip or live-reload applies without restart.
  const isTtyMode = (): boolean => resolveTtyMode(config.ui.ttyMode, process.env.TERM);
  // ASCII glyphs on the console (no Nerd PUA there), Nerd glyphs elsewhere
  // (style-aware: an icon-style toggle re-resolves via resetIconQueue)
  const ttyGlyphFor = (name: string): string =>
    isTtyMode() ? asciiGlyphFor(name) : glyphFor(name, config.ui.iconStyle);
  // force-glyph: same raster skip as tty mode, but WITHOUT the console extras
  // (list view, ASCII glyphs, anim/transparent forcing), live-read like tty mode
  const forceGlyph = (): boolean => config.ui.forceGlyph;

  // --- Nerd Font glyphs live in ./glyphs (FALLBACK ONLY); every category the
  // ./filetype classifier can emit gets a file-glyph fallback ---
  ensureGlyphFallbacks(new Set(Object.values(FILE_ICON_BY_EXT)));

  // --- Pixel-resolution gate (./ui-lookup, tested): ONE per process, shared by
  // the boot wait (settle: full budget, then latch "this terminal never
  // reports pixels") and the grid's render path (wait: instant on the console
  // and tmux, short-bounded parking only after a resize requery). Owning it
  // here is what keeps the two from disagreeing — a per-call-site gate could
  // never latch across the whole app. Lazy renderer getter (TDZ seam rule).
  const resolutionGate = makeResolutionGate(() => deps.renderer(), {
    log: (msg) => appendLog(msg),
    // no rasters here (the console, or a terminal with broken kitty graphics) —
    // cell pixels would never be read, so the boot wait is skipped entirely
    rasterless: () => isTtyMode() || config.ui.forceGlyph,
  });

  // --- Post-mount node lookup seam — lives in ./ui-lookup (tested). Created
  // before the widget factories that capture byId/stripSelectable in ctx; the
  // renderer boots further down, so root arrives as an arrow (TDZ seam rule).
  // Every lookup must tolerate a miss (nodes die on every rebuild). ---
  const lookup = makeLookup({ root: () => deps.renderer().root });

  // --- Floating layers: THE single source of truth for which modal/cursor
  // layer is open + the dismiss-others policy. Pure module, created before
  // any widget (makeSlots reads its escmenu state through a getter). Modal
  // open/close dims the background rasters via slots.setScrim (the scrim used
  // to be esc-menu-only, so props/conflict/pick rasters floated over modals).
  // `slots` is TDZ here — the callback fires post-construction only.
  const floats = makeFloats({
    onModalChange: (open) => {
      try {
        slots.setScrim(open);
      } catch {}
    },
  });

  // --- Mouse pointer shapes (OSC 22): ONE tty-guarded, deduping sink for
  // the whole app, shared by every widget ctx. Per-cluster instances were
  // tried first and diverged: each kept its own `last`, so cluster A
  // emitting `default` left cluster B believing `pointer` and skipping the
  // re-set — the shape stuck wrong across widget boundaries depending on
  // the approach path. Arrows defer renderer access (pre-boot safe).
  const setPointer = makePointerSetter({
    setMousePointer: (s) => deps.renderer().setMousePointer(s),
    isTtyMode,
  });

  // --- Icon slots / thumbs / modal scrim — widget lives in ./ui-slots.
  // Called before the renderer boots: every ctx field the drain path needs is
  // an arrow wrapper (post-boot evaluation), per the widget-seam rules. ---
  const slots = makeSlots({
    renderer: () => deps.renderer(),
    byId: lookup.byId,
    colors: themeGet,
    uiStyle: () => config.ui.uiStyle,
    iconsMode: () => config.ui.icons,
    // TTY-guarded like the terminal pane's own seam (no alpha on the Linux
    // console — without this a TTY+force run clears the X while its header
    // keeps its fill). The icon drain early-returns under TTY before ever
    // reading this, so the guard only affects the new button path.
    transparentForce: () => config.ui.transparentBg === "force" && !isTtyMode(),
    iconStyle: () => config.ui.iconStyle,
    iconCells: () => geometry.iconCells,
    modalOpen: () => floats.hasModal(),
    glyphFor: ttyGlyphFor,
    isTtyMode,
    forceGlyph,
    setPointer,
  });

  // --- App state & history: a layout TREE of N panes, each an independent
  // AppState. `state` is a stable facade over the ACTIVE leaf's AppState, so
  // every existing `core.state` consumer keeps reading/writing the active view.
  // The legacy 0|1 index (`panes.active`) mirrors the active leaf's id for the
  // default 2-pane tree — it is a shim, not the canonical identifier.
  // [ui] dual-pane chooses the INITIAL tree (2 leaves vs 1); it does not prevent
  // later splits. leafIds() is the render source of truth.
  const home = os.homedir();
  const layout = { current: (config.ui.dualPane ? defaultTree() : { kind: "leaf", id: "p0" }) as LayoutNode };
  const stateMap = new Map<PaneId, AppState>([
    ["p0", initialAppState(config, process.cwd(), deps.pendingSelect ?? null)],
    ["p1", initialAppState(config, process.cwd())],
  ]);
  // legacy 2-tuple shim (p0/p1) — indexed by 0|1 where the leaf exists
  const statesShim: [AppState, AppState] = [
    stateMap.get("p0") ?? initialAppState(config, process.cwd(), deps.pendingSelect ?? null),
    stateMap.get("p1") ?? initialAppState(config, process.cwd()),
  ];

  let activeId: PaneId = "p0";
  const setActiveId = (id: PaneId): void => {
    if (!findLeaf(layout.current, id)) return;
    activeId = id;
  };
  const activeStateFor = (): AppState => stateMap.get(activeId) ?? statesShim[0];

  // --- Pane lifecycle fan-out: splitPane/closePane mutate the tree, then ping
  // every listener so each wiring can create/dispose its per-leaf widgets. The
  // DOM rebuild (wiring/panes) registers LAST, after every widget exists.
  const treeListeners: Array<() => void> = [];
  const fireTreeChange = (): void => {
    for (const cb of treeListeners) {
      try {
        cb();
      } catch {}
    }
  };

  const panes = {
    get tree(): LayoutTree {
      return layout.current;
    },
    stateMap,
    states: statesShim,
    get active(): 0 | 1 {
      return indexFromId(activeId);
    },
    get activeId(): PaneId {
      return activeId;
    },
    setActivePane: (i: 0 | 1): void => setActiveId(i === 0 ? "p0" : "p1"),
    setActiveId,
    togglePane: (): void => {
      const ids = leafIds(layout.current);
      if (ids.length < 2) return;
      const idx = ids.indexOf(activeId);
      setActiveId(ids[(idx + 1) % ids.length] ?? activeId);
    },
    splitPane: (id: PaneId, orientation: SplitOrientation): void => {
      if (!findLeaf(layout.current, id)) return;
      const { tree, newId } = splitPane(layout.current, id, orientation);
      layout.current = tree;
      stateMap.set(newId, initialAppState(config, process.cwd()));
      scrollerRefs.set(newId, { current: null });
      setActiveId(newId);
      fireTreeChange();
    },
    closePane: (id: PaneId): void => {
      const before = leafIds(layout.current);
      if (before.length <= 1 || !before.includes(id)) return;
      layout.current = closePane(layout.current, id);
      stateMap.delete(id);
      scrollerRefs.delete(id);
      if (activeId === id) setActiveId(leafIds(layout.current)[0] ?? activeId);
      fireTreeChange();
    },
    // replace the whole tree (layout presets). States/scroller refs are
    // reconciled to the new leaf set; existing leaves keep their state, new
    // leaves get a fresh one. Fires the same tree-change fan-out as split/close.
    setTree: (tree: LayoutTree): void => {
      layout.current = tree;
      const ids = leafIds(tree);
      for (const id of ids) {
        if (!stateMap.has(id)) stateMap.set(id, initialAppState(config, process.cwd()));
        if (!scrollerRefs.has(id)) scrollerRefs.set(id, { current: null });
      }
      for (const id of [...stateMap.keys()]) if (!ids.includes(id)) stateMap.delete(id);
      for (const id of [...scrollerRefs.keys()]) if (!ids.includes(id)) scrollerRefs.delete(id);
      if (!findLeaf(layout.current, activeId)) setActiveId(ids[0] ?? activeId);
      fireTreeChange();
    },
    cyclePane: (delta: 1 | -1 = 1): void => {
      const next = cyclePane(layout.current, activeId, delta);
      setActiveId(next);
    },
    moveActiveTo: (orientation: SplitOrientation): void => {
      moveActiveTo(layout.current, activeId, orientation);
    },
    leafIds: (): PaneId[] => leafIds(layout.current),
    stateOf: (id: PaneId): AppState => stateMap.get(id) ?? activeStateFor(),
    // reconcile hook: fires after any tree change (split/close). Each wiring
    // diffs leafIds() against its own per-leaf map. In-memory only.
    onTreeChange: (cb: () => void): void => {
      treeListeners.push(cb);
    },
  };

  const state = activeFacade(activeStateFor);

  // --- Grid scroll containers — assigned during boot (buildLayout step), one
  // per leaf. `scrollerRef` stays the active pane's live ref for the same
  // facade reason as `state`. The legacy `scrollerRefs` tuple (p0/p1) is kept
  // for callers that still index by 0|1.
  const scrollerRefs = new Map<PaneId, { current: ScrollBoxRenderable | null }>();
  for (const id of leafIds(layout.current)) scrollerRefs.set(id, { current: null });
  const scrollerRef = {
    get current(): ScrollBoxRenderable | null {
      return scrollerRefs.get(activeId)?.current ?? null;
    },
    set current(v: ScrollBoxRenderable | null) {
      scrollerRefs.set(activeId, { current: v });
    },
  };
  // legacy p0/p1 tuple shim (still indexed by 0|1 in some callers)
  const legacyScrollerRefs: [{ current: ScrollBoxRenderable | null }, { current: ScrollBoxRenderable | null }] = [
    scrollerRefs.get("p0") ?? { current: null },
    scrollerRefs.get("p1") ?? { current: null },
  ];

  // --- Virtual places: Recent (freedesktop recently-used.xbel) & Starred.
  // URI/XDG primitives live in ./uri.
  function isVirtualCwd(): boolean {
    return isVirtualUri(state.cwd);
  }

  // --- Trash view detection: the path comparison is pure (./fsutil, honors
  // $XDG_DATA_HOME); this wrapper reads the live cwd. ---
  function inTrashView(): boolean {
    return isTrashFilesDir(state.cwd);
  }

  // --- The cut check itself is pure (./clipboard); this wrapper reads the
  // live internal clipboard, created later by the fileops wiring. ---
  const isCutKey = (key: string): boolean => isCutKeyFor(deps.clipboard(), key);

  // --- Dual-pane focus cue: no per-pane background. Tinting the inactive pane
  // (sidebarBg) fought the tiles/empty states, which paint the main bg, giving
  // a patchwork in solid mode. Clear any stale fill instead; focus reads from
  // the selection, preview and divider. No-op before the boot layout exists. ---
  const refreshPaneFocus = (): void => {
    for (const id of leafIds(layout.current)) {
      const node = lookup.byId(paneColId(id));
      if (!node) continue;
      try {
        applySurface(node, {});
      } catch {}
    }
  };

  return {
    config,
    colors,
    themeGet,
    isTtyMode,
    forceGlyph,
    setPointer,
    geometry,
    sideInnerW,
    lookup,
    resolutionGate,
    floats,
    slots,
    home,
    state,
    panes,
    activeState: activeStateFor,
    otherState: (): AppState => {
      const ids = leafIds(layout.current);
      const other = ids.find((id) => id !== activeId) ?? activeId;
      return stateMap.get(other) ?? activeStateFor();
    },
    setActivePane: (i: 0 | 1) => panes.setActivePane(i),
    setActiveId,
    togglePane: () => panes.togglePane(),
    refreshPaneFocus,
    scrollerRef,
    scrollerRefs,
    scrollerRefsLegacy: legacyScrollerRefs,
    isVirtualCwd,
    inTrashView,
    isCutKey,
  };
};
