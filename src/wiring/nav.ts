// --- Nav wiring: renderAll orchestration, quit, status bar, history nav,
// tabs, session sync, type-to-search. renderAll is created FIRST (the widgets
// below hand it to their factories directly) but its steps close over
// later-built widgets through the injected getters — the same TDZ seam rule
// the old flat wiring used, just parameterized. ---

import { makeRenderAll } from "../app/render-all";
import { makeQuit, resolveExitCwd } from "../app/quit";
import { makeRestart, restartArgs } from "../app/restart";
import { writeFileSync } from "node:fs";
import { sharedOpQueue } from "../lib/op-queue";
import { makeStatus } from "../ui/ui-status";
import { makeNav, makeSessionSync } from "../app/nav";
import { makeSyncBrowsing } from "../app/sync-browsing";
import { makeLeafRegistry } from "../app/panes";
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
  // [ui] exit-cwd: the directory tfm was launched in (index captures it before
  // the launch PATH chdir) — what the `default` hand-back writes out.
  launchCwd: string;
  // plugin teardown at quit (wired after nav; lazy getter). Best-effort sync.
  getPlugins?: () => {
    deactivateAll(): void;
    refreshSlots?(): void;
    disposeSlots?(): void;
  };
}) => {
  const {
    core,
    launchCwd,
    getChrome,
    getDnd,
    getGridFoundation,
    getGrid,
    getTermHasFocus,
    getTerm,
    getWatcher,
    getPlugins,
  } = deps;
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
        // tab-chip vocabulary stays p0/p1 (see ui-chrome); new leaves get a
        // hidden, empty strip so the pane column shape stays uniform
        for (const pane of [0, 1] as const) {
          if (core.panes.leafIds().includes(pane === 1 ? "p1" : "p0")) getChrome().chrome.renderTabbar(pane);
        }
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
      // bottom-bar icon-size slider: re-evaluate visibility (active pane view
      // mode + image protocol) on every repaint — covers resize, pane switch
      // and boot, where no config apply runs
      iconSlider: () => getChrome().iconSlider.refresh(),
      // global toolbar strip: rebuild from the live [ui] toolbar and repaint
      // the view-cycle icon from the active pane's resolved view mode. Covers
      // every config change ([ui] toolbar is not RENDER_EXEMPT), pane
      // switches and boot.
      toolbarStrip: () => getChrome().toolbarStrip.refresh(),
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
    // [ui] exit-cwd: a menu-style child can't chdir its parent shell, so the
    // directory travels through $TFM_CWD_FILE for the wrapper to read. Never
    // written when the variable is unset (plain `tfm` exits write nothing).
    // $TFM_CWD_FILE is set by the user's own shell wrapper (like $HOME and
    // $XDG_STATE_HOME above) — a user-controlled write target, not a privilege
    // boundary, so no path validation is applied.
    writeCwdFile: () => {
      const file = process.env.TFM_CWD_FILE;
      if (!file) return;
      writeFileSync(file, resolveExitCwd(core.config.ui.exitCwd, core.state.cwd, launchCwd, core.isVirtualCwd()));
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
    node: core.lookup.byId,
    refresh: () => getGridFoundation().selection.updateSelectionStatusReal(),
  });

  // --- History navigation — pure state machine lives in ./nav (tested).
  // ONE nav instance PER LEAF (each bound to its own AppState) so the passive
  // pane can be navigated without switching the active pane — the active
  // facade's `navigate`/`goBack`/`goFwd` read the live active id at call
  // time, exactly like the old single instance read the facade. The sync-
  // browsing follow hook closes over `syncBrowsing`, which is built after the
  // instances (TDZ: the hook only fires post-boot). ---
  const exitPathEdit = () => getChrome().activeToolbar().exitPathEdit();
  const closeFileMenuIfOpen = () => {
    if (getChrome().menu.isFileMenuOpen()) getChrome().menu.closeFileMenu();
  };
  const navHooks = (id: PaneId) => ({
    renderAll,
    clearSearch: () => clearSearch(),
    exitPathEdit,
    closeFileMenuIfOpen,
    onNavigate: (dir: string) => sharedPluginEvents().emit("navigate", { dir }),
    onSyncFollow: (dir: string) => syncBrowsing?.follow(id, dir),
  });
  let syncBrowsing: ReturnType<typeof makeSyncBrowsing> | null = null;
  const navInstances = makeLeafRegistry(core.panes, (id) => makeNav(core.panes.stateOf(id), navHooks(id)));
  syncBrowsing = makeSyncBrowsing({
    enabled: () => core.config.ui.syncBrowsing,
    leafIds: () => core.panes.leafIds(),
    navigateOther: (otherId: PaneId, dir: string) => {
      const n = navInstances.get(otherId);
      if (n) n.navigate(dir);
    },
  });
  const activeNav = () => {
    const n = navInstances.get(core.panes.activeId);
    if (!n) throw new Error(`no nav instance for active pane ${core.panes.activeId}`);
    return n;
  };
  // live facades: the active pane can change under us, so each accessor
  // re-resolves the active nav instance at call time (same rule as the old
  // single instance, which read `core.state` — a facade over the active
  // pane — at call time too)
  const canBack = () => activeNav().canBack();
  const canFwd = () => activeNav().canFwd();
  const goBack = () => activeNav().goBack();
  const goFwd = () => activeNav().goFwd();
  const navigate = (dir: string) => activeNav().navigate(dir);

  // --- Tabs: ONE model per pane — each pane is a browser-like tab list. The
  // focused pane's model backs the tab keybinds/menu; both get painted. Model
  // lives in ./tabs (pure, tested) — rendering/session I/O stay out. ---
  const tabModels = makeLeafRegistry(core.panes, (id) =>
    makeTabs(core.panes.stateOf(id), { onChanged: renderAll, status: setStatusMsg, quit: quitApp }),
  );
  const activeTabModel = () => {
    const m = tabModels.get(core.panes.activeId);
    if (!m) throw new Error(`no tab model for active pane ${core.panes.activeId}`);
    return m;
  };
  const syncTabsFromState = (): void => {
    for (const m of tabModels.values()) m.syncTabFromState();
  };
  // p0/p1 may not both be leaves after a close — a missing pane persists an
  // empty tab set instead of throwing (quit/session save must never break).
  const paneTabs = (): [PaneTabs, PaneTabs] => {
    const one = (id: PaneId): PaneTabs => {
      const m = tabModels.get(id);
      return m ? { tabs: m.list, activeTab: m.active } : { tabs: [], activeTab: 0 };
    };
    return [one("p0"), one("p1")];
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
  const searches = makeLeafRegistry(core.panes, mkSearch);
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
    // the raw teardown steps, for the signal path (index.ts): SIGHUP/SIGTERM/
    // SIGINT must run the SAME sequence the interactive quit does, with the
    // signal's own exit code instead of quit's 0/1 health code
    quitSteps,
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
