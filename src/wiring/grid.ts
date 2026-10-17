// --- Grid wiring, phase 2: preview pane (tree-sitter + thumbnails), the
// shared mouse-pipeline ctx (rubber band, selection, drag prep, drop-into),
// the grid renderer, properties dialog and the menu entry builders. Runs
// AFTER the fileops wiring — gridCtx takes moveInto directly. ---

import path from "node:path";
import { errMessage } from "../lib/uiutil";
import { existsSync, statSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { spawnSafe } from "../fs/spawn-safe";
import { addExecBits, classifyPath, executableChoiceLabels, type ExecutableInfo } from "../fs/executable";
import { registerSyntaxParsers } from "../ui/syntax";
import {
  availableCompressionFormats,
  canExtract,
  compressionExt,
  compressionHint,
  detectArchiveFormat,
  listArchiveContents,
  type ArchiveEntryInfo,
} from "../fs/archive";
import { appsForFile, launchApp } from "../fs/apps";
import { runSudo, sudoCatArgv } from "../fs/elevate";
import type { makePick } from "../ui/ui-pick";
import { makePreview } from "../ui/ui-preview";
import { makeInfoSidebar } from "../ui/ui-info";
import { finishDragState, gridDrag, makeEntryMouseHandlers, type BandCtx } from "../input/grid-input";
import { makeGridRenderer } from "../ui/ui-grid";
import { makeColumnsRenderer } from "../ui/ui-columns";
import { type EaseKey, fileAnimStyleFrom, makeFileAnim, makeTileHoverAnim, type SlideDir } from "../ui/ui-grid-anim";
import { makeProps } from "../ui/ui-props";
import { makeMenuEntries } from "../ui/menu-entries";
import { FILE_GLYPH, glyph } from "../ui/glyphs";
import { rasterSigOf } from "../ui/tty";
import { activeFacade, makeLeafRegistry, type PaneId, viewModeFor } from "../app/panes";
import { leafRectsOf } from "../app/layout";
import { isVirtualUri } from "../fs/uri";
import { isTrashFilesDir, canReadSync } from "../fs/fsutil";
import { dlog } from "../app/log";
import type { ListEntry } from "../ui/ui-menu";
import type { CoreWiring } from "./core";
import type { ChromeWiring, FileopsWiring, GridFoundationWiring, NavWiring } from "./types";
import type { PluginsWiring } from "./plugins";
import { isPluginEnabled } from "../plugins/plugin-api";
import type { RethemeWiring } from "./settings";

export const wireGrid = (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  gridFoundation: GridFoundationWiring;
  fileops: FileopsWiring;
  plugins: PluginsWiring;
  // pick overlay wires LAST (wiring/keymap) — lazy getter, action-time only
  getPick(): ReturnType<typeof makePick>;
  // retheme wires after grid — lazy getter, action-time only (same seam)
  getRetheme: () => RethemeWiring;
  // fallback drag (no-mouse terminals): a long-press picks up the selection
  // and arms the EXISTING drop pipeline, so the next folder click moves it.
  // Shared by every pane — one pickup timer for the whole app. Lazy getter:
  // the decision (terminal capability -> drag path) lives in the dnd wiring,
  // which is built AFTER the grid, so the grid reads it at press time.
  getFallbackDrag: () => { pickupMs(): number } | null;
}) => {
  const { core, nav, chrome, gridFoundation, fileops, plugins, getPick, getRetheme, getFallbackDrag } = deps;
  const { selection, selections, rename } = gridFoundation;
  const { byId, stripSelectable } = core.lookup;
  const { themeGet, home, state } = core;
  const uiStyle = () => core.config.ui.uiStyle;

  // --- Preview pane — widget lives in ./ui-preview ---
  registerSyntaxParsers();
  // focused tile's key (shared by preview + info sidebar): resolve the index
  // once and read through `?? null`
  const focusKey = (): string | null => {
    const idx = selection.focusIdx();
    if (idx < 0) return null;
    return selection.focusKeys()[idx] ?? null;
  };
  const { renderPreview: renderPreviewPane } = makePreview({
    renderer: chrome.renderer,
    byId,
    colors: themeGet,
    uiStyle,
    previewEnabled: () => core.config.ui.previewEnabled,
    previewWidth: () => core.config.ui.previewWidth,
    // global wrap mode ([ui] wrap-mode) drives preview bodies too —
    // keymap reads config.keys live, the preview reads this live the same way
    wrapMode: () => core.config.ui.wrapMode,
    // skip preview rebuilds while the pane is collapsed (auto-hide) — the
    // effective width is 0 then, and the work is invisible native churn
    visible: () => core.geometry.previewEff > 0 && core.config.ui.previewEnabled && !core.config.ui.infoSidebar,
    termH: () => chrome.renderer.terminalHeight,
    cellMetrics: core.slots.cellMetrics,
    focusKey,
    tileRefs: selection.tileRefs,
    pushThumbJob: core.slots.pushThumbJob,
    drainThumbs: core.slots.drainThumbs,
    drainIconQueue: core.slots.drainIconQueue,
    nextIconId: core.slots.nextIconId,
    fallbackGlyphFor: (name) => glyph[name] ?? FILE_GLYPH,
    isTtyMode: core.isTtyMode,
    forceGlyph: core.forceGlyph,
    // root preview: non-interactive `sudo -n cat` only (cached timestamp) —
    // a preview must never pop a password prompt on every focus move
    sudoCat: async (p) => {
      try {
        const r = await runSudo(sudoCatArgv(p), { timeoutMs: 10_000 });
        return r.status === 0 ? r.stdout : null;
      } catch {
        return null;
      }
    },
    pluginPreview: async (filePath) => {
      // path.extname, not split(".").pop(): dotfiles (".bashrc") have no ext,
      // "foo." has none either — the naive split claims "bashrc"/"".
      const ext = path.extname(filePath).slice(1).toLowerCase();
      if (!ext) return null;
      // first matching ext in load order wins; a throwing/empty render falls
      // through to the next plugin, then to core — never a blank pane.
      for (const p of plugins.plugins.filter(isPluginEnabled)) {
        for (const pv of p.preview) {
          if (!pv.exts.includes(ext)) continue;
          try {
            const text = await pv.render(filePath);
            if (typeof text === "string" && text.length) return text;
          } catch {}
        }
      }
      return null;
    },
  });

  // --- Info sidebar — widget lives in ./ui-info: a live read-out of the
  // active selection (file details / dir totals / multi summary). Shares the
  // right column with the preview (info wins when both are on). ---
  const { renderInfo } = makeInfoSidebar({
    byId,
    colors: themeGet,
    infoEnabled: () => core.config.ui.infoSidebar,
    infoWidth: () => core.config.ui.previewWidth, // shared right-region width
    home,
    focusKey,
    tileRefs: selection.tileRefs,
  });
  // ONE entry for every selection/pane change: the preview and the info
  // sidebar refresh together (kept in lockstep so they can't drift)
  const renderPreview = (): void => {
    renderPreviewPane();
    renderInfo();
  };

  // Rubber-band gesture state + commit logic live in ./grid-input; this is the
  // ctx object it renders through (built here because it closes over the live
  // selection/preview state below).
  const bandCtx: BandCtx = {
    byId,
    tileRefs: selection.tileRefs,
    clearTileSelection: selection.clearTileSelection,
    setTileVisual: selection.setTileVisual,
    updateSelectionStatusReal: selection.updateSelectionStatusReal,
    renderPreview,
    setSelAnchor: (v: number | null) => {
      selection.setSelAnchor(v);
    },
  };

  // Focus a pane on mouse press WITHOUT a full renderAll: a grid rebuild mid-
  // gesture would destroy the pressed tile's node and break the drag. Only the
  // focus-dependent things repaint — pane dim, the sidebar cwd highlight (moved
  // in place, no rebuild), the newly-active preview + status. The per-pane top
  // bars and tab strips already show the right thing, so re-rendering them here
  // only re-created their icon slots (fallback-glyph flash on every pane click).
  const focusPane = (id: PaneId): void => {
    const prev = core.panes.activeId;
    if (prev === id) return;
    // a selection must not survive a pane switch: drop the pane we're leaving
    selections.get(prev)?.clearTileSelection();
    core.setActiveId(id);
    core.refreshPaneFocus();
    // per-pane view mode differs: re-evaluate the bottom-bar slider (this path
    // deliberately skips a full renderAll)
    chrome.iconSlider.refresh();
    try {
      chrome.chrome.normalizePlaces();
      plugins.refreshSlots?.();
    } catch {}
    void renderPreview();
    selections.get(id)?.updateSelectionStatusReal();
  };

  // Mouse behavior shared by grid tiles AND list rows: selection (plain/ctrl/
  // shift), double-click open, drag payload prep, drop-into-folder, hover. Built
  // PER PANE so a tile's handlers always act on their own pane's selection/map
  // regardless of focus timing. All state lives in tileRefs + the drag module
  // vars, keyed by path.
  // Mouse pointer shapes (OSC 22): the single shared tty-guarded sink from
  // wireCore (see there for why per-cluster instances diverged).
  const setPointer = core.setPointer;
  const getSelection = (id: PaneId) => {
    const s = selections.get(id);
    if (!s) throw new Error(`no selection for pane ${id}`);
    return s;
  };
  const get = <K, V>(m: Map<K, V>, key: K): V => {
    const v = m.get(key);
    if (!v) throw new Error(`missing entry ${String(key)}`);
    return v;
  };
  const makePaneGridCtx = (id: PaneId) => {
    const s = getSelection(id);
    return {
      byId,
      termW: () => chrome.renderer.terminalWidth,
      termH: () => chrome.renderer.terminalHeight,
      // --- selection deps (GridSelectionDeps) ---
      tileRefs: s.tileRefs,
      setTileVisual: s.setTileVisual,
      updateSelectionStatusReal: s.updateSelectionStatusReal,
      renderPreview,
      clearTileSelection: s.clearTileSelection,
      selectRange: s.selectRange,
      getSelAnchor: () => s.selAnchor(),
      setSelAnchor: (v: number | null) => {
        s.setSelAnchor(v);
      },
      getFocusIdx: () => s.focusIdx(),
      setFocusIdx: (v: number) => {
        s.setFocusIdx(v);
      },
      selPaths: s.selPaths,
      dblClickMs: () => core.config.ui.doubleClickMs,
      dragThresholdCells: () => core.config.ui.dragThresholdCells,
      // --- nav deps (GridNavDeps) ---
      navigate: nav.navigate,
      openFileDefault: chrome.openFileDefault,
      moveInto: fileops.fileops.moveInto,
      // --- menu deps (GridMenuDeps) ---
      openContextMenu: (x: number, y: number, title: string, entries: ListEntry[]) =>
        chrome.menu.openContextMenu(x, y, title, entries),
      fileEntriesFor: (key: string, isDir: boolean, x: number, y: number): ListEntry[] =>
        menuEntries.fileEntriesFor(key, isDir, x, y),
      closeFileMenu: chrome.menu.closeFileMenu,
      renameEditKey: rename.renameEditKey,
      finishInlineRename: rename.finishInlineRename,
      // --- host ---
      setStatusMsg: nav.setStatusMsg,
      focusPane: () => focusPane(id),
      blurTerminal: () => fileops.terminal.blurTerminal(),
      hoverAnim: (key: string, hovered: boolean) => {
        const a = hoverAnims.get(id);
        if (!a) throw new Error(`no hover anim for pane ${id}`);
        a.playHover(key, hovered);
      },
      setPointer,
      log: (msg: string) => dlog(msg),
      // pass the getter, don't call it: the capability decision (wireDnd) is
      // built AFTER the grid, so invoking here would hit `dnd` before init
      fallbackDrag: getFallbackDrag,
    };
  };
  const gridCtxs = makeLeafRegistry(core.panes, (id) => makePaneGridCtx(id));
  // active-facing ctx for drag commit/cleanup — its tileRefs resolve to the
  // active pane's map through the facade
  const gridCtx = activeFacade(() => {
    const c = gridCtxs.get(core.panes.activeId);
    if (!c) throw new Error(`no grid ctx for active pane ${core.panes.activeId}`);
    return c;
  });
  const finishDragCtx = () => finishDragState(gridCtx);

  // A drag released over a pane's EMPTY background moves into that pane's cwd
  // (the tile drop handles dropping onto a specific folder tile). The fallback
  // drag (no-mouse terminals) arms its pickup on a tile press, so the same
  // pane-background and place/tab drop handlers must clear the fallback state
  // when a fallback drop lands here — otherwise a long-press could never land
  // on an empty destination pane. gridDrag.keys = null clears both the motion
  // drag and the fallback's keys through its setter.
  const dropIntoPane = (id: PaneId): void => {
    const keys = gridDrag.keys;
    if (!keys?.length) return;
    const dest = core.panes.stateOf(id).cwd;
    gridDrag.keys = null; // clears motion drag + fallback keys
    gridDrag.fallback = false;
    if (isVirtualUri(dest) || isTrashFilesDir(dest)) return;
    if (dest === core.state.cwd) {
      chrome.notify("Already here", "move", "info");
      return;
    }
    const items = keys.filter((k) => k.path !== dest);
    if (items.length) void fileops.fileops.moveInto(dest, items);
  };

  const entryMouseHandlers = makeLeafRegistry(core.panes, (id) => {
    const ctx = gridCtxs.get(id);
    if (!ctx) throw new Error(`no grid ctx for pane ${id}`);
    return makeEntryMouseHandlers(ctx);
  });

  // --- Grid renderer lives in ./ui-grid (tile/list-row builders, empty and
  // restricted states, thumbnail handoff, gen-counter stale guards) ---
  // per-pane grid renderers: each reads its own pane's state/selection/scroller
  // and a unique tile-id prefix (ids are global in the renderable registry).
  // Dual pane splits the main area in half (minus the 1-cell divider).
  // per-pane width from the layout tree's rects (an h-split divides width, a
  // v-split divides height); `main` is the panes region after the sidebar and
  // the shared right column.
  const paneAvailW = (id: PaneId): number => {
    const main = chrome.renderer.terminalWidth - core.geometry.sidebarEff - core.geometry.previewEff;
    const rects = leafRectsOf(core.panes.tree, { x: 0, y: 0, w: main, h: chrome.renderer.terminalHeight });
    return Math.max(0, rects.get(id)?.w ?? main);
  };
  // one animator per pane (each owns its reused timeline so a rebuild in one
  // pane can't clobber the other's); reads [ui] file-animation-* live
  const makeFileAnimator = () =>
    makeFileAnim({
      renderer: chrome.renderer,
      byId: core.lookup.byId,
      opts: () => ({
        // text-cell opacity/translate needs no graphics protocol, so file
        // anims stay enabled in tty mode (rasters/thumbs/list-force aside)
        style: fileAnimStyleFrom({
          enabled: core.config.ui.fileAnimation,
          slide: core.config.ui.fileAnimationSlide,
          stagger: core.config.ui.fileAnimationStagger,
        }),
        ms: core.config.ui.fileAnimationMs,
        staggerPct: core.config.ui.fileAnimationStaggerPct,
        slidePct: core.config.ui.fileAnimationSlidePct,
        dir: core.config.ui.fileAnimationSlideDir as SlideDir,
        ease: core.config.ui.fileAnimationEase as EaseKey,
        containerFade: core.config.ui.fileAnimationContainerFade,
        rowsGranularity: core.config.ui.fileAnimationRowGranularity,
        maxFiles: core.config.ui.fileAnimationMaxFiles,
      }),
    });
  const fileAnims = makeLeafRegistry(core.panes, () => makeFileAnimator());
  // one hover animator per pane (whole-cell icon lift, synchronous) — reads
  // [ui] file-hover-* live, lifts each pane's own reserved tiles
  const makeHoverAnimator = (id: PaneId) =>
    makeTileHoverAnim({
      byId,
      tileRefs: () => getSelection(id).tileRefs,
      colors: themeGet,
      uiStyle,
      transparentForce: () => core.config.ui.transparentBg === "force",
      setIconState: core.slots.setIconState,
      isCutKey: core.isCutKey,
      hoverLiftOpts: () => ({
        enabled: core.config.ui.fileHoverAnimation,
        direction: core.config.ui.fileHoverDirection,
        includeLabel: core.config.ui.fileHoverIncludeLabel,
      }),
    });
  const hoverAnims = makeLeafRegistry(core.panes, (id) => makeHoverAnimator(id));

  // --- Archive folder view (fs/archive lists the members, app/archive-nav owns
  // the model). ONE container is cached, keyed on its mtime: every repaint
  // re-asks, and a tar listing decompresses the whole container. A container
  // longer than the js fallback's memory ceiling is refused by the engine, so
  // the cache never holds more than one listing. ---
  let archiveCache: { archive: string; sig: string; entries: ArchiveEntryInfo[] | null } | null = null;
  const archiveMembers = async (archive: string): Promise<ArchiveEntryInfo[] | null> => {
    const fmt = detectArchiveFormat(archive);
    if (!fmt) return null;
    let sig: string;
    try {
      const st = statSync(archive);
      if (!st.isFile()) return null;
      sig = String(st.mtimeMs);
    } catch {
      return null;
    }
    if (archiveCache && archiveCache.archive === archive && archiveCache.sig === sig) return archiveCache.entries;
    const entries = await listArchiveContents(fmt, archive);
    archiveCache = { archive, sig, entries };
    return entries;
  };
  const archiveBrowse = (id: PaneId) => ({
    // columns view has its own listing path (ui-columns) and would show an
    // unreadable folder for an archive location: there the tile stays a file
    enterable: (name: string): boolean =>
      viewModeFor(core.panes.stateOf(id), core.config.ui.viewMode, core.isTtyMode) !== "columns" && canExtract(name),
    list: archiveMembers,
  });
  const makeRenderer = (id: PaneId) =>
    makeGridRenderer({
      termW: () => chrome.renderer.terminalWidth,
      termH: () => chrome.renderer.terminalHeight,
      scroller: () => core.scrollerRefs.get(id)?.current ?? null,
      state: core.panes.stateOf(id),
      searchQuery: () => nav.searches.get(id)?.getQuery() ?? "",
      recursiveSearch: () => core.config.ui.recursiveSearch,
      pathEditMode: () => chrome.toolbars.get(id)?.pathEditMode() ?? false,
      // column math reads the EFFECTIVE sidebar width (hover drawer rewrites it
      // as the sidebar collapses); core.geometry.sw is the config width used for
      // sidebar content, which stays baked at full size and clips
      sw: () => core.geometry.sidebarEff,
      tileW: () => core.geometry.tileW,
      tileH: () => core.geometry.tileH,
      iconCells: () => core.geometry.iconCells,
      hoverLiftOpts: () => ({
        enabled: core.config.ui.fileHoverAnimation,
        direction: core.config.ui.fileHoverDirection,
        includeLabel: core.config.ui.fileHoverIncludeLabel,
      }),
      listRowH: () => core.config.ui.listRowHeight,
      uiStyle,
      colors: themeGet,
      transparentForce: () => core.config.ui.transparentBg === "force",
      previewEnabled: () => core.config.ui.previewEnabled,
      previewWidth: () => core.config.ui.previewWidth,
      // per-pane view mode: the pane's own stored mode wins, falling back to
      // the global [ui] viewMode default; the tty console forces list/columns
      // (no icon tiles — no graphics, no Nerd PUA)
      viewMode: () => viewModeFor(core.panes.stateOf(id), core.config.ui.viewMode, core.isTtyMode),
      // raster-affecting state the grid rebuild keys off (force-glyph/icons/
      // tty mode/transparent-bg flips must rebuild even though the listing
      // is unchanged)
      rasterSig: () =>
        rasterSigOf(
          core.config.ui.icons,
          core.isTtyMode(),
          core.config.ui.forceGlyph,
          core.config.ui.iconStyle,
          core.config.ui.transparentBg,
        ),
      wrapMode: () => core.config.ui.wrapMode,
      reservedRight: () => core.geometry.previewEff,
      availW: () => paneAvailW(id),
      tileIdPrefix: `tfm-tile-${id}-`,
      cellMetrics: core.slots.cellMetrics,
      makeIconSlot: core.slots.makeIconSlot,
      pushThumbJob: core.slots.pushThumbJob,
      nextIconId: core.slots.nextIconId,
      drainIconQueue: core.slots.drainIconQueue,
      drainThumbs: core.slots.drainThumbs,
      stripSelectable,
      setTextOnId: core.lookup.setTextOnId,
      log: (msg) => dlog(msg),
      fileAnim: (target) => get(fileAnims, id).play(target),
      fileAnimVisibleOnly: () => core.config.ui.fileAnimationVisibleOnly,
      fileAnimScrollRevealDelayMs: () => core.config.ui.fileAnimationScrollRevealDelayMs,
      windowedGrid: () => core.config.ui.windowedGrid,
      isRenaming: rename.isRenaming,
      listingsCache: () => core.config.ui.listingsCache,
      listingsCacheStats: () => core.config.ui.listingsCacheStats,
      listingsCacheTtlMs: () => core.config.ui.listingsCacheTtl * 1000,
      loadingDelayMs: () => core.config.ui.loadingDelayMs,
      isTtyMode: core.isTtyMode,
      selection: get(selections, id),
      entryMouseHandlers: get(entryMouseHandlers, id),
      isCutKey: core.isCutKey,
      // render path: the gate's cheap wait. Once boot latched "this terminal
      // never reports pixels" this is an instant no-op — the old unbounded
      // 2s park here stalled EVERY navigation on the console.
      waitForResolution: () => core.resolutionGate.wait(),
      clearRenameEdit: rename.clearRenameEdit,
      archive: archiveBrowse(id),
    });
  const renderers = makeLeafRegistry(core.panes, (id) => makeRenderer(id));

  const makeColRenderer = (id: PaneId) =>
    makeColumnsRenderer({
      termW: () => chrome.renderer.terminalWidth,
      termH: () => chrome.renderer.terminalHeight,
      scroller: () => core.scrollerRefs.get(id)?.current ?? null,
      state: core.panes.stateOf(id),
      searchQuery: () => nav.searches.get(id)?.getQuery() ?? "",
      recursiveSearch: () => core.config.ui.recursiveSearch,
      pathEditMode: () => chrome.toolbars.get(id)?.pathEditMode() ?? false,
      sw: () => core.geometry.sidebarEff,
      tileW: () => core.geometry.tileW,
      tileH: () => core.geometry.tileH,
      iconCells: () => core.geometry.iconCells,
      listRowH: () => core.config.ui.listRowHeight,
      uiStyle,
      colors: themeGet,
      transparentForce: () => core.config.ui.transparentBg === "force",
      previewEnabled: () => core.config.ui.previewEnabled,
      previewWidth: () => core.config.ui.previewWidth,
      viewMode: () => viewModeFor(core.panes.stateOf(id), core.config.ui.viewMode, core.isTtyMode),
      wrapMode: () => core.config.ui.wrapMode,
      reservedRight: () => core.geometry.previewEff,
      availW: () => paneAvailW(id),
      tileIdPrefix: `tfm-tile-${id}-`,
      cellMetrics: core.slots.cellMetrics,
      makeIconSlot: core.slots.makeIconSlot,
      pushThumbJob: core.slots.pushThumbJob,
      nextIconId: core.slots.nextIconId,
      drainIconQueue: core.slots.drainIconQueue,
      drainThumbs: core.slots.drainThumbs,
      stripSelectable,
      log: (msg) => dlog(msg),
      waitForResolution: () => core.resolutionGate.wait(),
      clearRenameEdit: rename.clearRenameEdit,
      selection: get(selections, id),
      entryMouseHandlers: get(entryMouseHandlers, id),
      isCutKey: core.isCutKey,
      openFileDefault: chrome.openFileDefault,
      fileAnim: (target) => get(fileAnims, id).play(target),
      fileAnimVisibleOnly: () => core.config.ui.fileAnimationVisibleOnly,
    });
  const columnsRenderers = makeLeafRegistry(core.panes, (id) => makeColRenderer(id));

  const renderPane = (pane: PaneId | 0 | 1): Promise<void> => {
    const id: PaneId = typeof pane === "string" ? pane : pane === 1 ? "p1" : "p0";
    // Custom plugin view (see wiring/plugins): it replaces the core renderers
    // for this pane. `leftPluginView` reports (once) that the pane came back
    // from one — its cached paint signature still describes the grid content
    // the plugin mount destroyed, so that rebuild must be forced.
    const pv = plugins.pluginViewFor(id);
    if (pv) return plugins.renderPluginView(id, pv);
    const force = plugins.leftPluginView(id);
    const mode = viewModeFor(core.panes.stateOf(id), core.config.ui.viewMode, core.isTtyMode);
    if (mode === "columns") {
      return get(columnsRenderers, id).renderColumns();
    }
    return get(renderers, id).renderGrid(force);
  };
  // [ui] windowed-grid: the boot layout's scrollers get their scrollTop
  // hooked to this (wiring/io) — a slide rebuilds only the row window
  const syncWindowPane = (pane: PaneId | 0 | 1): void => {
    const id: PaneId = typeof pane === "string" ? pane : pane === 1 ? "p1" : "p0";
    // a plugin view is not a grid window: sliding it would rebuild core rows
    // over the plugin's node
    if (plugins.pluginViewFor(id)) return;
    const mode = viewModeFor(core.panes.stateOf(id), core.config.ui.viewMode, core.isTtyMode);
    if (mode === "columns") {
      get(columnsRenderers, id).syncWindow();
    } else {
      get(renderers, id).syncWindow();
    }
  };
  // render pane 0 always; pane 1 only while dual pane is on (its scroller is
  // hidden otherwise, so building its tiles would be wasted native allocs)
  const renderGrid = async (): Promise<void> => {
    for (const id of core.panes.leafIds()) {
      await renderPane(id);
    }
  };

  const props = makeProps({
    byId,
    openDialog: chrome.dialogs.openDialog,
    closeDialog: chrome.dialogs.closeDialog,
    floats: core.floats,
    setTextOnId: core.lookup.setTextOnId,
    setOnId: core.lookup.setOnId,
    stripSelectable,
    drainIconQueue: core.slots.drainIconQueue,
    drainThumbs: core.slots.drainThumbs,
    pushThumbJob: core.slots.pushThumbJob,
    nextIconId: core.slots.nextIconId,
    escHintBtn: core.slots.escHintBtn,
    closeFileMenu: chrome.menu.closeFileMenu,
    openContextMenu: (x, y, title, entries) => chrome.menu.openContextMenu(x, y, title, entries),
    renderAll: nav.renderAll,
    notify: chrome.notify,
    uiStyle,
    colors: themeGet,
    home,
    makeIconSlot: core.slots.makeIconSlot,
    setIconState: core.slots.setIconState,
    fallbackGlyphFor: (name) => glyph[name] ?? FILE_GLYPH,
    isTtyMode: core.isTtyMode,
    forceGlyph: core.forceGlyph,
    cellMetrics: core.slots.cellMetrics,
    setPointer,
  });

  // open a folder in the inactive pane, enabling dual-pane when off: enable
  // through the single applyConfig path (normalizePanes points the fresh pane
  // at the current cwd), then switch + navigate the now-active other pane
  // through the tested navigate path (tab sync, hooks, renderAll included).
  const openInOtherPane = (dir: string): void => {
    if (core.panes.leafIds().length < 2) {
      getRetheme().applyConfig({ ...core.config, ui: { ...core.config.ui, dualPane: true } });
      getRetheme().scheduleSaveConfig();
    }
    const active = core.panes.activeId;
    const other: PaneId = core.panes.leafIds().find((id) => id !== active) ?? active;
    // a selection must not survive a pane switch (same rule as switchPane)
    gridFoundation.selections.get(active)?.clearTileSelection();
    core.setActiveId(other);
    nav.navigate(dir);
  };

  // --- Menu entry builders (what the menus contain) live in ./menu-entries;
  // the floating menu widget itself lives in ./ui-menu ---
  // --- Executable launches: a +x file (or ELF/shebang content) runs instead
  // of landing in the browser/editor via xdg-open. Detached spawn uses the
  // file's own dir as cwd; terminal runs feed the absolute quoted path into
  // the embedded pane. needsChmod files gain exec bits (where read exists)
  // first, with a toast saying so. ---
  const spawnDetached = (p: string): void => {
    try {
      spawnSafe(p, [], { stdio: "ignore", detached: true, cwd: path.dirname(p) }, (err) => {
        dlog(`run ${p}: ${err.message}`);
        chrome.notify(`Can't run ${path.basename(p)} · ${err.message}`, "run", "error");
      }).unref?.();
    } catch (err) {
      chrome.notify(`Can't run ${path.basename(p)} · ${errMessage(err)}`, "run", "error");
      return;
    }
    chrome.notify(`Running ${path.basename(p)}`, "run", "info");
  };

  const ensureExec = async (p: string): Promise<boolean> => {
    try {
      await chmod(p, addExecBits(statSync(p).mode));
      return true;
    } catch (err) {
      chrome.notify(`Chmod failed (${errMessage(err)})`, "run", "error");
      return false;
    }
  };

  const runExecutable = (p: string): void => {
    const info = classifyPath(p);
    if (!info.executable) {
      chrome.notify(`Can't run ${path.basename(p)}`, "run", "error");
      return;
    }
    if (!info.needsChmod) {
      spawnDetached(p);
      return;
    }
    void (async () => {
      if (await ensureExec(p)) spawnDetached(p);
    })();
  };

  const runExecutableInTerminal = (p: string): void => {
    const info = classifyPath(p);
    if (!info.executable) {
      chrome.notify(`Can't run ${path.basename(p)}`, "run", "error");
      return;
    }
    if (!info.needsChmod) {
      fileops.terminal.execInTerminal(p);
      return;
    }
    void (async () => {
      if (await ensureExec(p)) fileops.terminal.execInTerminal(p);
    })();
  };

  // the Run prompt behind openFileDefault's executable fork (same pick
  // overlay as Open With…/Compress to… — no new float kind)
  const askExecutable = (p: string, info: ExecutableInfo, openAnyway: () => void): void => {
    const [runLabel, termLabel, openLabel] = executableChoiceLabels(info);
    getPick().open({
      title: `Run "${path.basename(p)}"?`,
      placeholder: "Choose how to open…",
      items: [
        { label: runLabel, run: () => runExecutable(p) },
        { label: termLabel, run: () => runExecutableInTerminal(p) },
        { label: openLabel, run: openAnyway },
      ],
    });
  };

  const menuEntries = makeMenuEntries({
    closeFileMenu: chrome.menu.closeFileMenu,
    navigate: nav.navigate,
    newTab: nav.newTab,
    openInOtherPane,
    // "Open With…": enumerate handlers for the file's mime, then let the
    // generic pick overlay choose (same pick instance the compress picker uses).
    // Unreadable files escalate: the chosen app launches elevated after the
    // password prompt, same honest-toast contract as the adaptive open.
    openWith: (p) => {
      void appsForFile(p).then((apps) => {
        if (!apps.length) {
          chrome.notify("No applications found", "open", "error");
          return;
        }
        getPick().open({
          title: "Open with…",
          placeholder: "Filter applications…",
          items: apps.map((a) => ({
            label: a.name,
            hint: a.id.replace(/\.desktop$/, ""),
            run: () => {
              // ENOENT (deleted between listing and pick, dangling symlink)
              // launches unprivileged and errors honestly — no sudo prompt
              // for something that isn't there
              if (!canReadSync(p) && existsSync(p)) {
                void chrome.launchAppAsRoot(a.file, a.name, p);
                return;
              }
              launchApp(a.file, p, (err) => dlog(`gio launch failed: ${err.message}`));
              chrome.notify(`Opening ${path.basename(p)} · ${a.name}`, "open");
            },
          })),
        });
      });
    },
    renderAll: nav.renderAll,
    renderGrid,
    openTerminalHere: fileops.terminal.openTerminalHere,
    connectServer: chrome.connectServer,
    disconnectServer: chrome.disconnectServer,
    clipboard: fileops.fileops.clipboard,
    pasteSmart: fileops.fileops.pasteSmart,
    confirmEmptyTrash: fileops.confirmEmptyTrash,
    confirmDeleteForever: fileops.confirmDeleteForever,
    ejectDevice: chrome.chrome.ejectDevice,
    mountDevice: chrome.chrome.mountDevice,
    inTrashView: core.inTrashView,
    tileRefs: selection.tileRefs,
    selPaths: selection.selPaths,
    openFileDefault: chrome.openFileDefault,
    isExecutable: (p: string): boolean => classifyPath(p).executable,
    runExecutable,
    runExecutableInTerminal,
    setClipboard: fileops.fileops.setClipboard,
    duplicate: (paths) => void fileops.fileops.duplicate(paths),
    startInlineRename: rename.startInlineRename,
    startInlineCreate: rename.startInlineCreate,
    startBulkRename: gridFoundation.startBulkRename,
    trashPaths: fileops.trash.trashPaths,
    restoreFromTrash: fileops.trash.restoreFromTrash,
    openProperties: props.openProperties,
    selectAll: selection.selectAll,
    cwd: () => state.cwd,
    canExtract: canExtract,
    extractArchive: (files, dest) => {
      void fileops.fileops.extractArchive(files, dest);
    },
    compressionFormats: () => availableCompressionFormats(),
    compressTo: (paths) => {
      const cwd = state.cwd;
      getPick().open({
        title: "Compress to…",
        placeholder: "Filter formats…",
        items: availableCompressionFormats().map((fmt) => ({
          label: compressionExt(fmt),
          hint: compressionHint(fmt),
          run: () => {
            void fileops.fileops.compressPaths(paths, fmt, cwd);
          },
        })),
      });
    },
    sortState: state,
    plugins: () => plugins.plugins.filter(isPluginEnabled),
    onPluginError: (name, err) => {
      const msg = `plugin ${name} failed: ${errMessage(err)}`;
      dlog(msg);
      try {
        chrome.notify(msg, "plugins");
      } catch {}
    },
  });

  return {
    renderPreview,
    renderInfo,
    renderGrid,
    syncWindowPane,
    renderPane,
    focusPane: (pane: PaneId | 0 | 1) => {
      const id: PaneId = typeof pane === "string" ? pane : pane === 1 ? "p1" : "p0";
      focusPane(id);
    },
    dropIntoPane: (pane: PaneId | 0 | 1) => {
      const id: PaneId = typeof pane === "string" ? pane : pane === 1 ? "p1" : "p0";
      dropIntoPane(id);
    },
    finishDrag: finishDragCtx,
    bandCtx,
    props,
    menuEntries,
    columnsRenderer: (pane: PaneId | 0 | 1) => {
      const id: PaneId = typeof pane === "string" ? pane : pane === 1 ? "p1" : "p0";
      return get(columnsRenderers, id);
    },
    runExecutable,
    runExecutableInTerminal,
    askExecutable,
  };
};
