// --- Nav wiring: renderAll orchestration, quit, status bar, history nav,
// tabs, session sync, type-to-search. renderAll is created FIRST (the widgets
// below hand it to their factories directly) but its steps close over
// later-built widgets through the injected getters — the same TDZ seam rule
// the old flat wiring used, just parameterized. ---

import { makeRenderAll } from "../app/render-all";
import { makeQuit } from "../app/quit";
import { makeRestart, restartArgs } from "../app/restart";
import { sharedOpQueue } from "../lib/op-queue";
import { makeStatus } from "../ui/ui-status";
import { makeNav, makeSessionSync } from "../app/nav";
import type { PaneId } from "../app/layout";
import { saveSessionSync, type PaneTabs } from "../fs/session";
import { makeTabs, nextTab as cycleNextTab, prevTab as cyclePrevTab } from "../app/tabs";
import { makeSearch } from "../input/search";
import { appendLog } from "../app/log";
import { xtShiftEscapeFrame } from "../ui/ui-term";
import { sharedPluginEvents } from "../lib/plugin-events";
import type { CoreWiring } from "./core";
import type { ChromeWiring, GridFoundationWiring, GridWiring } from "./types";

export const wireNav = (deps: {
  core: CoreWiring;
  // late clusters — every field below is only read at runtime, post-boot
  getChrome: () => ChromeWiring;
  getDnd: () => { disableDrops(): void; enableDrops(): void };
  getGridFoundation: () => GridFoundationWiring;
  getGrid: () => GridWiring;
  getTermHasFocus: () => boolean;
  getTerm: () => { closeTerminalPane(): void };
  getWatcher: () => { syncCwdWatcher(): void };
  // plugin teardown at quit (wired after nav; lazy getter). Best-effort sync.
  getPlugins?: () => {
    deactivateAll(): void;
    refreshSlots?(): void;
    disposeSlots?(): void;
  };
}) => {
  const { core, getChrome, getDnd, getGridFoundation, getGrid, getTermHasFocus, getTerm, getWatcher, getPlugins } =
    deps;

  // --- renderAll orchestration lives in ./render-all (tested): tab-sync +
  // cwd-sync, then the named steps in insertion order, each guarded. ---
  const renderAll = makeRenderAll({
    state: core.state,
    syncTabFromState: () => syncTabsFromState(),
    scheduleSaveSession: () => scheduleSaveSession(),
    syncPaneCwds: () => {
      for (const s of core.panes.stateMap.values()) s.cwd = s.history[s.histIdx] ?? s.cwd;
    },
    log: (msg) => appendLog(msg),
    steps: {
      cwdWatcher: () => getWatcher().syncCwdWatcher(),
      tabbar: () => {
        for (const id of core.panes.leafIds()) getChrome().chrome.renderTabbar(id === "p1" ? 1 : 0);
      },
      nav: () => {
        for (const t of getChrome().toolbars.values()) t.refreshNav();
      },
      crumbs: () => {
        for (const t of getChrome().toolbars.values()) t.renderCrumbs();
      },
      sidebar: () => getChrome().chrome.renderSidebar(),
      iconQueue: () => {
        void core.slots.drainIconQueue();
      },
      grid: () => {
        void getGrid().renderGrid();
      },
      paneFocus: () => core.refreshPaneFocus(),
      preview: () => {
        void getGrid().renderPreview();
      },
      pluginSlots: () => getPlugins?.().refreshSlots?.(),
      stripSelectable: () => core.lookup.stripSelectable(),
    },
  });

  // --- Quit: the single teardown path lives in ./quit (tested). closeTerminal
  // kills the PTY child (it would otherwise rely on EIO from the dead master —
  // a shell with a foreground child can linger) and flushSession writes the
  // final session.json synchronously (process.exit kills pending async IO, so
  // the debounced save loses the last navigation). Both arrive as arrows —
  // they close over later-defined bindings. The same step object feeds restart
  // below (RestartCtx extends QuitCtx), so the two teardowns can't drift. ---
  const quitSteps = {
    disableDrops: () => getDnd().disableDrops(),
    releaseShiftCapture: () => process.stdout.write(xtShiftEscapeFrame(false)),
    onQuit: () => {
      sharedPluginEvents().emit("quit", {});
      // best-effort: call each plugin's deactivate (sync prefix only — quit is
      // synchronous, see docs/plugins.md)
      try {
        getPlugins?.().disposeSlots?.();
        getPlugins?.().deactivateAll();
      } catch {}
    },
    closeTerminal: () => getTerm().closeTerminalPane(),
    stopGpm: () => getChrome().stopGpm(),
    stopChromeTimers: () => getChrome().stopChromeTimers(),
    flushSession: () => {
      // no isVirtualCwd() guard: restore deliberately accepts recent:// and
      // starred:// tabs, so quitting from a virtual place must still persist
      // the session (the old guard silently dropped BOTH panes' real-dir tabs)
      syncTabsFromState();
      saveSessionSync(paneTabs(), core.panes.activeId === "p1" ? 1 : 0);
    },
    destroy: () => getChrome().renderer.destroy(),
    exit: (code: number) => process.exit(code),
    // refuse quit while file ops are in flight (same guard as restart):
    // exiting mid-batch strands completed files with no undo batch
    isBusy: () => !sharedOpQueue().isIdle(),
    onBusy: () => {
      try {
        getChrome().notify("Can't quit during file operations — cancel (✕) or wait for it to finish", "quit", "error");
      } catch {}
    },
  };
  const quitApp = makeQuit(quitSteps);

  // --- Restart: same binary+args, parent WAITS (spawnSync) so the shell never
  // wakes mid-handoff — fire-and-forget left the child competing with the
  // shell for input (echoed mouse bytes, dead keys). Notify/recover arrive
  // lazily; recover re-arms drops + shift-capture and re-renders (the renderer
  // survives a failed spawn; the PTY pane and plugin instances don't — the
  // failure toast says so). ---
  const restartApp = makeRestart({
    ...quitSteps,
    execPath: process.execPath,
    // NOT slice(1): the compiled binary's argv carries the /$bunfs/ virtual
    // entry at [1] — re-passing it makes the child treat it as a PATH (exit
    // 1). The dev runner (argv[0] === execPath) keeps its script instead.
    argv: restartArgs(process.argv, process.execPath),
    // the shared serial queue: a live op would race the child's orphan sweep
    // while the parent loop is frozen inside spawnSync (see app/restart)
    isBusy: () => !sharedOpQueue().isIdle(),
    recover: () => {
      try {
        getDnd().enableDrops();
      } catch {}
      try {
        process.stdout.write(xtShiftEscapeFrame(true));
      } catch {}
      renderAll();
    },
    notify: (msg, title, level) => getChrome().notify(msg, title, level),
  });

  // --- Status bar writes live in ./ui-status (tested). The refresh target is
  // selection's, created further down the wiring — arrow defers it. ---
  const { setStatusMsg } = makeStatus({
    setText: core.lookup.setTextOnId,
    refresh: () => getGridFoundation().selection.updateSelectionStatusReal(),
  });

  // --- History navigation — pure state machine lives in ./nav (tested);
  // hooks close over later-defined bindings (TDZ seam rule) ---
  const { canBack, canFwd, goBack, goFwd, navigate } = makeNav(core.state, {
    renderAll,
    clearSearch: () => clearSearch(),
    exitPathEdit: () => getChrome().activeToolbar().exitPathEdit(),
    closeFileMenuIfOpen: () => {
      if (getChrome().menu.isFileMenuOpen()) getChrome().menu.closeFileMenu();
    },
    onNavigate: (dir) => sharedPluginEvents().emit("navigate", { dir }),
  });

  // --- Tabs: ONE model per pane — each pane is a browser-like tab list. The
  // focused pane's model backs the tab keybinds/menu; both get painted. Model
  // lives in ./tabs (pure, tested) — rendering/session I/O stay out. ---
  const tabModels = new Map<PaneId, ReturnType<typeof makeTabs>>();
  for (const id of core.panes.leafIds())
    tabModels.set(id, makeTabs(core.panes.stateOf(id), { onChanged: renderAll, status: setStatusMsg, quit: quitApp }));
  const activeTabModel = () => {
    const m = tabModels.get(core.panes.activeId);
    if (!m) throw new Error(`no tab model for active pane ${core.panes.activeId}`);
    return m;
  };
  const syncTabsFromState = (): void => {
    for (const m of tabModels.values()) m.syncTabFromState();
  };
  const paneTabs = (): [PaneTabs, PaneTabs] => {
    const p0 = tabModels.get("p0");
    const p1 = tabModels.get("p1");
    if (!p0 || !p1) throw new Error("paneTabs: p0/p1 tab models missing");
    return [
      { tabs: p0.list, activeTab: p0.active },
      { tabs: p1.list, activeTab: p1.active },
    ];
  };
  const switchTab = (i: number): void => activeTabModel().switchTab(i);
  const newTab = (dir?: string): void => activeTabModel().newTab(dir);
  const closeTab = (i?: number): void => activeTabModel().closeTab(i);
  const nextTab = (): void => cycleNextTab(activeTabModel());
  const prevTab = (): void => cyclePrevTab(activeTabModel());

  // --- Session save/restore scheduling — logic lives in ./nav (tested) ---
  const { scheduleSaveSession, restoreSession } = makeSessionSync({
    paneTabs,
    syncTabsFromState,
    adoptPaneTabs: (pane, tabs, activeTab) => {
      const m = tabModels.get(pane === 1 ? "p1" : "p0");
      if (m) m.adoptTabs(tabs, activeTab);
    },
    adoptDefaultTabs: () => {
      tabModels.get("p0")?.adoptTab();
      tabModels.get("p1")?.adoptTab();
    },
    activePane: () => (core.panes.activeId === "p1" ? 1 : 0),
    setActivePane: core.setActivePane,
    config: core.config,
    isVirtualCwd: core.isVirtualCwd,
  });

  // --- Type-to-search: ONE query + input per pane (each pane's toolbar has
  // its own search box). The keymap drives the focused pane's; its grid reads
  // its own query so a search filters only that side. ---
  // Mouse pointer shapes (OSC 22): the single shared tty-guarded sink from
  // wireCore (see there for why per-cluster instances diverged).
  const setPointer = core.setPointer;
  const mkSearch = (id: PaneId) =>
    makeSearch({
      byId: core.lookup.byId,
      inputId: `tfm-${id}-search`,
      // arrow wrappers: termHasFocus/renderGrid belong to later wirings (TDZ)
      termHasFocus: getTermHasFocus,
      renderGrid: () => getGrid().renderPane(id),
      setPointer,
    });
  const searches = new Map<PaneId, ReturnType<typeof makeSearch>>();
  for (const id of core.panes.leafIds()) searches.set(id, mkSearch(id));
  const activeSearch = () => {
    const s = searches.get(core.panes.activeId);
    if (!s) throw new Error(`no search for active pane ${core.panes.activeId}`);
    return s;
  };
  const clearSearch = (): void => activeSearch().clearSearch();
  const beginTypeToSearch = (ch: string): void => activeSearch().beginTypeToSearch(ch);
  const wireSearchInput = (): void => {
    for (const s of searches.values()) s.wireSearchInput();
  };

  return {
    renderAll,
    quitApp,
    restartApp,
    setStatusMsg,
    canBack,
    canFwd,
    goBack,
    goFwd,
    navigate,
    tabModels,
    switchTab,
    newTab,
    closeTab,
    nextTab,
    prevTab,
    restoreSession,
    searches,
    activeSearch,
    clearSearch,
    beginTypeToSearch,
    wireSearchInput,
  };
};
