// --- Keyboard wiring: the modal precedence chain router lives in ./keymap
// (capture > quit/restart > overlay-modals (prompt/bulk-rename/conflict/yes-no/rename/props) >
// pick > esc-menu > terminal > path-edit > file menu > search > sidebar >
// grid > actions — mirrored from its header) + sidebar kb-focus state + the
// generic pick overlay widget (api.ui.pick primitive) and the single-line
// prompt overlay (plugin git-URL entry). Last wiring step — everything it
// reads exists by now. ---

import type { KeyEvent } from "@opentui/core";
import type { KeyAction } from "../config/config-schema";
import type { KeyEventLike } from "../config/keyspec";
import { makeKeyRouter } from "../input/keymap";
import { makePick } from "../ui/ui-pick";
import { makePrompt } from "../ui/ui-prompt";
import { makeGoToFolder } from "../ui/ui-goto";
import { makeQuicklook } from "../ui/ui-quicklook";
import { themePresetIdx, zoomUiPatch } from "../ui/settings";
import { THEME_PRESETS } from "../config/themes";
import { presetKeys } from "../config/keymap-presets";
import { cycleSortMode } from "../lib/sort";
import { currentViewSlot, nextViewSlot, setPluginViewId, viewCycle, viewModeFor } from "../app/panes";
import { activeFacade } from "../app/panes";
import { destroyChildren, errMessage } from "../lib/uiutil";
import {
  flattenPluginCommands,
  flattenPluginOperations,
  getPluginCommandBinds,
  isPluginEnabled,
} from "../plugins/plugin-api";
import { isVirtualUri } from "../fs/uri";
import { isTrashFilesDir } from "../fs/fsutil";
import { dlog } from "../app/log";
import type { Command } from "../lib/command";
import type { CoreWiring } from "./core";
import type { ChromeWiring, FileopsWiring, GridFoundationWiring, GridWiring, NavWiring, SettingsWiring } from "./types";
import type { PluginsWiring } from "./plugins";
import type { RethemeWiring } from "./settings";

export const wireKeymap = (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  gridFoundation: GridFoundationWiring;
  grid: GridWiring;
  fileops: FileopsWiring;
  settings: SettingsWiring;
  plugins: PluginsWiring;
  getRetheme: () => RethemeWiring;
}) => {
  const { core, nav, chrome, gridFoundation, grid, fileops, settings, plugins, getRetheme } = deps;
  const { state, floats } = core;
  const { byId } = core.lookup;

  // --- Generic pick overlay (api.ui.pick): created before the router so the
  // interception branch closes over it directly; its item source reads the
  // merged core+plugin command list fresh on every open (remaps and plugin
  // contributions apply without rebuilds). coreCommands is backfilled after
  // the router exists — keypresses can't precede the wiring return. ---
  let coreCommands: () => Command[] = () => [];
  // Mouse pointer shapes (OSC 22): the single shared tty-guarded sink from
  // wireCore (see there for why per-cluster instances diverged).
  const setPointer = core.setPointer;
  const pick = makePick({
    renderer: () => chrome.renderer,
    byId,
    rootAdd: (node) => chrome.renderer.root.add(node),
    destroyChildren,
    stripSelectable: core.lookup.stripSelectable,
    colors: core.themeGet,
    uiStyle: () => core.config.ui.uiStyle,
    floats,
    escHintBtn: core.slots.escHintBtn,
    drainIconQueue: core.slots.drainIconQueue,
    commands: () =>
      [
        ...coreCommands(),
        ...flattenPluginCommands(plugins.plugins.filter(isPluginEnabled)),
        // plugin FS operations: the palette half of api.operations.register
        // (the file context menu half is synthesized onto LoadedPlugin.fileMenu)
        ...flattenPluginOperations(plugins.pluginOperations(), () =>
          gridFoundation.selection.selPaths().map((s) => s.path),
        ),
      ].map((c) => ({
        label: c.title,
        hint: c.hint || undefined,
        run: c.run,
      })),
    onError: (err) => {
      const msg = `plugin command failed: ${errMessage(err)}`;
      dlog(msg);
      // a failing operation (palette half) must be visible, not just logged
      try {
        chrome.notify(msg, "plugins");
      } catch {}
    },
    setPointer,
  });

  // --- Single-line prompt overlay (plugin git-URL entry): same Input-native
  // typing rule as pick; the router delegates to it above pick so pasting a
  // URL never leaks keys into the grid or type-to-search. ---
  const prompt = makePrompt({
    renderer: () => chrome.renderer,
    byId,
    rootAdd: (node) => chrome.renderer.root.add(node),
    stripSelectable: core.lookup.stripSelectable,
    escHintBtn: core.slots.escHintBtn,
    drainIconQueue: core.slots.drainIconQueue,
    colors: core.themeGet,
    uiStyle: () => core.config.ui.uiStyle,
    floats,
    setPointer,
  });

  // --- Go to Folder popup (Shift+Cmd+G): path Input + live dir completion;
  // Enter jumps the ACTIVE pane, esc cancels. Reuses the path edit's rules
  // (see ../ui/ui-goto) and the shared modal scrim. ---
  const goToFolder = makeGoToFolder({
    renderer: () => chrome.renderer,
    byId,
    rootAdd: (node) => chrome.renderer.root.add(node),
    destroyChildren,
    stripSelectable: core.lookup.stripSelectable,
    escHintBtn: core.slots.escHintBtn,
    drainIconQueue: core.slots.drainIconQueue,
    colors: core.themeGet,
    uiStyle: () => core.config.ui.uiStyle,
    floats,
    cwd: () => core.state.cwd,
    home: core.home,
    navigate: nav.navigate,
    notify: chrome.notify,
    setPointer,
  });

  // --- Quick Look float (space-bar Quick Look): a NON-MODAL overlay that
  // previews the selection when the preview pane is hidden. The content is
  // painted by the preview module through ./ui-quicklook's registry, so this
  // wiring only builds the widget + routes its keys. ---
  const quicklook = makeQuicklook({
    byId,
    rootAdd: (node) => chrome.renderer.root.add(node),
    stripSelectable: core.lookup.stripSelectable,
    colors: core.themeGet,
    uiStyle: () => core.config.ui.uiStyle,
    floats,
    termW: () => chrome.renderer.terminalWidth,
    termH: () => chrome.renderer.terminalHeight,
    previewWidth: () => core.config.ui.previewWidth,
    escHintBtn: core.slots.escHintBtn,
    drainIconQueue: core.slots.drainIconQueue,
    setPointer,
  });

  // Copy/move the active selection into the other pane's directory through the
  // same runTransfer path as every other transfer (conflict prompt, undo,
  // progress). Destination guards mirror pasteSmart's.
  const transferToOtherPane = (op: "copy" | "move"): void => {
    if (core.panes.leafIds().length < 2) {
      chrome.notify("Dual pane is off", op, "info");
      return;
    }
    const selected = gridFoundation.selection.selPaths();
    if (!selected.length) {
      chrome.notify(`Nothing to ${op}`, op, "info");
      return;
    }
    const dest = core.otherState().cwd;
    if (core.isVirtualCwd() || isVirtualUri(dest) || isTrashFilesDir(dest)) {
      chrome.notify(`Can't ${op} to the other pane`, op, "error");
      return;
    }
    void fileops.fileops.runTransfer(
      op,
      dest,
      selected.map((s) => s.path),
      `${op} to other pane`,
    );
  };

  // [ui] vim: merge the yazi preset's file-nav binds (h/j/k/l + o) onto the
  // live config. The yazi preset table IS the canonical vim set — arrows never
  // change (moveUp/Down/Left/Right keep their binds, and the yazi table keeps
  // them too). Re-running after a user remap re-owns the five keys (the yazi
  // switcher already behaves this way — a preset commit overwrites every bind);
  // any other hand edit is left untouched. No vim state machine: the binds ARE
  // the mode.
  const applyVimBinds = (): void => {
    const vim = core.config.ui.vim;
    const yazi = presetKeys("yazi");
    const keys = core.config.keys;
    const changed: Partial<Record<KeyAction, string[]>> = {};
    for (const action of ["parentDir", "moveUp", "moveDown", "openSelected"] as KeyAction[]) {
      const want = yazi[action];
      if (want && !want.every((spec) => (keys[action] ?? []).includes(spec))) changed[action] = want;
    }
    // vim off: drop the bare j/k/h/l/o that the vim mode added (the yazi preset
    // also owns these; it stays intact because its table matches verbatim)
    if (!vim) {
      const vimKeys: Array<[KeyAction, string]> = [
        ["parentDir", "h"],
        ["moveUp", "k"],
        ["moveDown", "j"],
        ["openSelected", "l"],
        ["openSelected", "o"],
      ];
      for (const [action, spec] of vimKeys) {
        if ((keys[action] ?? []).includes(spec)) changed[action] = (keys[action] ?? []).filter((s) => s !== spec);
      }
    }
    const any = Object.keys(changed).length > 0;
    if (any) core.config.keys = { ...keys, ...changed };
  };

  // boot: [ui] vim on means the vim binds are already live before the first
  // keypress (no applyConfig — config is loaded, not committed)
  applyVimBinds();

  const keyRouter = makeKeyRouter({
    byId,
    state,
    keybinds: (action) => core.config.keys[action] ?? [],
    quit: nav.quitApp,
    restart: nav.restartApp,
    // layer-open reads go through floats — the single source of truth; the
    // close fns are the widgets' (they route back through floats themselves)
    conflict: {
      isOpen: () => floats.isOpen("conflict"),
      closeConflict: (p: "skip") => fileops.conflict.closeConflict(p),
    },
    yesNo: {
      isOpen: () => floats.isOpen("yesno"),
      close: fileops.yesNo.close,
      moveFocus: fileops.yesNo.moveFocus,
      submit: fileops.yesNo.submit,
    },
    typeToSearchEnabled: () => core.config.ui.typeToSearch,
    // startSearch re-arms the filter (yazi preset leaves it off) through the
    // single applyConfig -> save path like every other config flip
    enableTypeToSearch: () => {
      if (core.config.ui.typeToSearch) return;
      getRetheme().applyConfig({ ...core.config, ui: { ...core.config.ui, typeToSearch: true } });
      getRetheme().scheduleSaveConfig();
    },
    isRenaming: gridFoundation.rename.isRenaming,
    bulkRename: {
      isOpen: () => floats.isOpen("bulkrename"),
      handleKey: gridFoundation.bulkRename.handleKey,
    },
    propsIsOpen: () => floats.isOpen("props"),
    closeProps: grid.props.closeProps,
    escMenu: { ...settings.escMenu, isOpen: () => floats.isOpen("escmenu") },
    termOwnsKeyboard: fileops.terminal.ownsKeyboard,
    pathEditMode: () => chrome.activeToolbar().pathEditMode(),
    pathInputVisible: () => !!byId(`tfm-${core.panes.activeId}-path-input`)?.visible,
    searchQuery: () => nav.activeSearch().getQuery(),
    searchVisible: () => !!byId(`tfm-${core.panes.activeId}-search`)?.visible,
    clearSearch: nav.clearSearch,
    exitPathEdit: () => chrome.activeToolbar().exitPathEdit(),
    beginTypeToSearch: nav.beginTypeToSearch,
    renderGrid: grid.renderGrid,
    renderPreview: grid.renderPreview,
    renderAll: nav.renderAll,
    selection: gridFoundation.selection,
    // columns (Miller/Finder) view: the active pane's renderer owns the
    // column-stack keyboard semantics. Resolved live so switching panes
    // hands keys to the new side without a rebuild.
    columns: activeFacade(() => grid.columnsRenderer(core.panes.activeId), {
      isActive: () =>
        viewModeFor(core.panes.stateOf(core.panes.activeId), core.config.ui.viewMode, core.isTtyMode) === "columns",
      handleKey: (ev: KeyEventLike) => grid.columnsRenderer(core.panes.activeId).handleKey(ev),
      renderColumns: () => grid.columnsRenderer(core.panes.activeId).renderColumns(),
    }),
    placesHost: chrome.chrome.placesHost,
    normalizePlaces: chrome.chrome.normalizePlaces,
    mountDevice: chrome.chrome.mountDevice,
    navigate: nav.navigate,
    goBack: nav.goBack,
    goFwd: nav.goFwd,
    openFileDefault: chrome.openFileDefault,
    home: core.home,
    getFileMenuState: chrome.menu.fileMenuState,
    closeFileMenu: chrome.menu.closeFileMenu,
    renderFileMenu: chrome.menu.renderFileMenu,
    openFileSubmenu: chrome.menu.openSubmenu,
    closeFileSubmenu: chrome.menu.closeSubmenu,
    moveFileSubmenu: chrome.menu.moveSub,
    activateFileSubmenu: chrome.menu.activateSub,
    nextTab: nav.nextTab,
    prevTab: nav.prevTab,
    newTab: nav.newTab,
    closeTab: nav.closeTab,
    inTrashView: core.inTrashView,
    confirmDeleteForever: fileops.confirmDeleteForever,
    trashPaths: fileops.trash.trashPaths,
    restoreFromTrash: fileops.trash.restoreFromTrash,
    startInlineRename: gridFoundation.rename.startInlineRename,
    startInlineCreate: gridFoundation.rename.startInlineCreate,
    startBulkRename: gridFoundation.startBulkRename,
    openProperties: grid.props.openProperties,
    enterPathEdit: () => chrome.activeToolbar().enterPathEdit(),
    openTerminal: () => fileops.terminal.openTerminalHere(),
    connectServer: chrome.connectServer,
    // config flips go through the single applyConfig -> save path (same as
    // the settings GUI rows) so geometry repaints and persistence stay in sync
    togglePreview: () => {
      const ui = core.config.ui;
      getRetheme().applyConfig({ ...core.config, ui: { ...ui, previewEnabled: !ui.previewEnabled } });
      getRetheme().scheduleSaveConfig();
    },
    toggleInfoSidebar: () => {
      const ui = core.config.ui;
      getRetheme().applyConfig({ ...core.config, ui: { ...ui, infoSidebar: !ui.infoSidebar } });
      getRetheme().scheduleSaveConfig();
    },
    toggleQuicklook: () => quicklook.toggle(),
    quicklook: {
      isOpen: () => quicklook.isOpen(),
      close: () => quicklook.close(),
      scroll: (lines) => quicklook.scroll(lines),
      page: (dir) => quicklook.page(dir),
    },
    // the drawer owns panel visibility/width, so the flip publishes through
    // applyConfig -> onConfigApplied -> hover.refresh() like every other knob
    toggleSidebar: () => {
      const ui = core.config.ui;
      getRetheme().applyConfig({ ...core.config, ui: { ...ui, sidebarVisible: !ui.sidebarVisible } });
      getRetheme().scheduleSaveConfig();
    },
    // theme cycler: hand-edited [theme] matches no preset (idx -1), so the
    // first press lands on the first preset, then the list wraps
    nextTheme: () => {
      const idx = themePresetIdx(THEME_PRESETS, core.config.theme);
      const next = THEME_PRESETS[(idx + 1) % THEME_PRESETS.length];
      if (!next) return;
      getRetheme().applyConfig({
        ...core.config,
        ui: { ...core.config.ui },
        theme: { ...next.theme },
        keys: { ...core.config.keys },
      });
      getRetheme().scheduleSaveConfig();
      chrome.notify(next.name, "theme", "info");
    },
    toggleDualPane: () => {
      const ui = core.config.ui;
      getRetheme().applyConfig({ ...core.config, ui: { ...ui, dualPane: !ui.dualPane } });
      getRetheme().scheduleSaveConfig();
      // applyConfig handles the repaint + its normalizePanes hook resets the
      // active pane when turning off
    },
    toggleSyncBrowsing: () => {
      const ui = core.config.ui;
      getRetheme().applyConfig({ ...core.config, ui: { ...ui, syncBrowsing: !ui.syncBrowsing } });
      getRetheme().scheduleSaveConfig();
    },
    toggleViewMode: () => {
      const s = core.activeState();
      // cycle = core modes then every registered plugin view (app/panes owns
      // the order + the tty restriction). Selecting a plugin view clears the
      // core mode and vice versa, so viewModeFor stays the core fallback.
      const next = nextViewSlot(
        viewCycle(core.isTtyMode, plugins.pluginViews()),
        currentViewSlot(s, core.config.ui.viewMode, core.isTtyMode),
      );
      if (typeof next === "string") {
        setPluginViewId(s, null);
        s.viewMode = next;
      } else {
        setPluginViewId(s, next.pluginView);
      }
      void grid.renderGrid();
      // view mode decides the slider's visibility — renderGrid (not renderAll)
      // is this path's only repaint
      chrome.iconSlider.refresh();
    },
    // single-key sort cycle on the ACTIVE pane's state (same nautilus
    // semantics + renderGrid tail as the sort menu's pick)
    cycleSort: () => {
      const s = core.activeState();
      const next = cycleSortMode(s.sortBy);
      s.sortBy = next.sortBy;
      s.sortAsc = next.sortAsc;
      void grid.renderGrid();
    },
    // same-mode flip: the cycle picks a mode's natural direction, this one
    // reverses whatever the current mode sorts by (grid rebuild only — the
    // sort state is per-pane and neither key touches config)
    reverseSort: () => {
      const s = core.activeState();
      s.sortAsc = !s.sortAsc;
      void grid.renderGrid();
    },
    zoomTiles: (dir) => {
      const ui = core.config.ui;
      const patch = zoomUiPatch(ui, dir);
      const keys = Object.keys(patch) as (keyof typeof patch)[];
      if (!keys.some((k) => patch[k] !== ui[k])) return; // saturated at min/max
      getRetheme().applyConfig({ ...core.config, ui: { ...ui, ...patch } });
      getRetheme().scheduleSaveConfig();
    },
    switchPane: () => {
      if (core.panes.leafIds().length < 2) return;
      // a selection must not survive a pane switch
      gridFoundation.selections.get(core.panes.activeId)?.clearTileSelection();
      core.panes.cyclePane(1);
      nav.renderAll();
    },
    splitPaneHorizontal: () => {
      core.panes.splitPane(core.panes.activeId, "h");
      nav.renderAll();
    },
    splitPaneVertical: () => {
      core.panes.splitPane(core.panes.activeId, "v");
      nav.renderAll();
    },
    closePane: () => {
      if (core.panes.leafIds().length < 2) return;
      core.panes.closePane(core.panes.activeId);
      nav.renderAll();
    },
    copyToOtherPane: () => transferToOtherPane("copy"),
    moveToOtherPane: () => transferToOtherPane("move"),
    setClipboard: fileops.fileops.setClipboard,
    duplicate: (paths) => void fileops.fileops.duplicate(paths),
    isVirtualCwd: core.isVirtualCwd,
    pasteSmart: fileops.fileops.pasteSmart,
    notify: chrome.notify,
    undoLast: fileops.undo.undoLast,
    redoLast: fileops.undo.redoLast,
    pluginCommands: () =>
      plugins.plugins
        .filter(isPluginEnabled)
        .flatMap((p) => p.commands.map((c) => ({ id: c.id, binds: getPluginCommandBinds(p, c.id), run: c.run }))),
    pick: {
      isOpen: () => pick.isOpen(),
      handleKey: pick.handleKey,
    },
    prompt: {
      isOpen: () => prompt.isOpen(),
      handleKey: prompt.handleKey,
    },
    openGoToFolder: () => goToFolder.open(),
    goToFolder: {
      isOpen: () => goToFolder.isOpen(),
      handleKey: goToFolder.handleKey,
    },
  });

  coreCommands = () => keyRouter.commands();

  chrome.renderer.keyInput.on("keypress", (e: KeyEvent) => keyRouter.handleKey(e));

  return { keyRouter, pick, prompt, goToFolder, quicklook };
};
