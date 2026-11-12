// --- Wiring-level test for keymap: the decisions this composition owns on top
// of its collaborators — directional pane focus, selection surviving a focus
// change, the close guards, the session-only startSearch re-arm and the vim
// off/on bind ownership. Uses the public keyRouter.commands() closures (the
// palette and keypresses run the same ones) plus the exported pure vim helper.
// No renderer is needed: every widget stays lazy until opened. ---
import { describe, expect, test } from "bun:test";
import { presetKeys } from "../config/keymap-presets";
import type { Config } from "../config/config-schema";
import { presetThreePane } from "../app/layout-presets";
import type { LayoutTree } from "../app/layout";
import { vimOffChanges, wireKeymap } from "./keymap";

type Ui = {
  vim: boolean;
  typeToSearch: boolean;
  viewMode: "grid" | "list" | "columns";
  sidebarVisible: boolean;
  previewEnabled: boolean;
  infoSidebar: boolean;
  dualPane: boolean;
  syncBrowsing: boolean;
  uiStyle: string;
  [key: string]: unknown;
};

const harness = (over: { tree?: LayoutTree; vim?: boolean; keys?: Config["keys"] } = {}) => {
  const calls: string[] = [];
  const cleared: string[] = [];
  let activeId = "p0";
  const tree = over.tree ?? presetThreePane();

  const config = {
    ui: {
      vim: over.vim ?? false,
      typeToSearch: false,
      viewMode: "grid",
      sidebarVisible: true,
      previewEnabled: false,
      infoSidebar: false,
      dualPane: true,
      syncBrowsing: false,
      uiStyle: "solid",
    } as Ui,
    keys: over.keys ?? presetKeys("tfm"),
    theme: {},
  };

  const selection = {
    clearTileSelection: () => cleared.push(activeId),
    selPaths: () => [],
  };
  const selections = new Map([
    ["p0", selection],
    ["p1", selection],
    ["p2", selection],
  ]);

  const tabList = (n: number) => Array.from({ length: n }, (_, i) => ({ history: [`/d${i}`], histIdx: 0 }));
  const tabModels = new Map([
    ["p0", { list: tabList(1), active: 0, closeTab: () => calls.push("tabs:close") }],
    ["p1", { list: tabList(1), active: 0, closeTab: () => calls.push("tabs:close") }],
    ["p2", { list: tabList(1), active: 0, closeTab: () => calls.push("tabs:close") }],
  ]);

  const core = {
    config,
    state: { cwd: "/tmp", showHidden: false },
    geometry: { sidebarEff: 20, previewEff: 0, splitPct: 50 },
    home: "/home/zeb",
    floats: { isOpen: () => false, depth: () => 0 },
    lookup: { byId: () => null, setOnId: () => {}, setTextOnId: () => {}, stripSelectable: () => {} },
    slots: { escHintBtn: () => ({}), drainIconQueue: () => {} },
    panes: {
      get tree() {
        return tree;
      },
      get activeId() {
        return activeId;
      },
      leafIds: () => ["p0", "p1", "p2"],
      setActiveId: (id: string) => {
        activeId = id;
        calls.push(`active:${id}`);
      },
      closePane: (id: string) => calls.push(`close:${id}`),
      splitPane: () => {},
      cyclePane: () => {
        activeId = activeId === "p0" ? "p1" : "p0";
        calls.push(`active:${activeId}`);
      },
      stateOf: () => core.state,
    },
    activeState: () => core.state,
    otherState: () => core.state,
    isTtyMode: () => false,
    isVirtualCwd: () => false,
    inTrashView: () => false,
    themeGet: () => ({}),
    setPointer: () => {},
  };

  const nav = {
    renderAll: () => calls.push("renderAll"),
    quitApp: () => calls.push("quit"),
    restartApp: () => {},
    navigate: () => {},
    goBack: () => {},
    goFwd: () => {},
    newTab: () => calls.push("tab:new"),
    closeTab: () => calls.push("tab:close"),
    nextTab: () => {},
    prevTab: () => {},
    tabModels,
    activeSearch: () => ({ getQuery: () => "" }),
    clearSearch: () => {},
    beginTypeToSearch: (ch: string) => calls.push(`search:${ch}`),
    searches: new Map(),
  };

  const chrome = {
    renderer: {
      terminalWidth: 120,
      terminalHeight: 40,
      root: { add: () => {} },
      keyInput: { on: () => {} },
    },
    notify: () => {},
    activeToolbar: () => ({ pathEditMode: () => false, enterPathEdit: () => {}, exitPathEdit: () => {} }),
    menu: {
      fileMenuState: () => null,
      closeFileMenu: () => {},
      renderFileMenu: () => {},
      openSubmenu: () => {},
      closeSubmenu: () => {},
      moveSub: () => {},
      activateSub: () => {},
    },
    toolbars: new Map(),
    toolbarEditor: { isActive: () => false, handleKey: () => false, toggle: () => {} },
    iconSlider: { refresh: () => {} },
    toolbarStrip: { refresh: () => {} },
    chrome: { placesHost: [], normalizePlaces: () => {}, mountDevice: () => {} },
    openFileDefault: () => {},
    connectServer: () => {},
  };

  const yesNo = {
    pending: [] as Array<{ msg: string; label: string; onYes: () => void }>,
    confirm(msg: string, label: string, onYes: () => void, danger?: boolean) {
      calls.push(`confirm:${msg}:${label}:${danger}`);
      this.pending.push({ msg, label, onYes });
    },
  };

  const deps = {
    core,
    nav,
    chrome,
    gridFoundation: {
      selection,
      selections,
      rename: { isRenaming: () => false },
      bulkRename: { handleKey: () => false },
    },
    grid: {
      renderGrid: () => {},
      renderPreview: () => {},
      columnsRenderer: () => ({ handleKey: () => false, renderColumns: () => {} }),
      props: { openProperties: () => {}, closeProps: () => {} },
      menuEntries: { emptyAreaEntries: () => [] },
    },
    fileops: {
      yesNo,
      conflict: { closeConflict: () => {} },
      terminal: { ownsKeyboard: () => false, openTerminalHere: () => {}, blurTerminal: () => {} },
      fileops: {
        runTransfer: async () => {},
        runExecutable: () => {},
        setClipboard: () => {},
        pasteSmart: () => {},
        duplicate: async () => {},
        extractArchive: async () => {},
      },
      trash: { trashPaths: async () => {}, restoreFromTrash: async () => {} },
      undo: { undoLast: () => {}, redoLast: () => {} },
    },
    settings: {
      escMenu: {
        isOpen: () => false,
        closeMenu: () => {},
        moveMenu: () => {},
        adjustSelectedSetting: () => {},
        menuActivate: () => {},
        menuTab: () => {},
        openMenu: () => {},
        toggleHelp: () => {},
        captureKey: () => false,
      },
    },
    plugins: { plugins: [], pluginViews: () => [], pluginOperations: () => [], refreshSlots: () => {} },
    getRetheme: () => ({
      applyConfig: (cfg: typeof config) => {
        config.ui = cfg.ui;
        config.keys = cfg.keys;
        calls.push("applyConfig");
      },
      scheduleSaveConfig: () => calls.push("save"),
    }),
  };

  const wired = wireKeymap(deps as never);
  const run = (id: string) => {
    const cmd = wired.keyRouter.commands().find((c) => c.id === id);
    if (!cmd) throw new Error(`no command ${id}`);
    cmd.run();
  };
  return { wired, calls, cleared, run, config, activeId: () => activeId, yesNo, tabModels };
};

describe("keymap wiring: directional pane focus", () => {
  test("steps by geometry: down goes to the pane below, not document order", () => {
    const h = harness(); // 3-pane preset, active p0
    h.run("focusPaneDown");
    // p0 is the full-height left column: no pane below its center
    expect(h.calls).not.toContain("active:p1");
    expect(h.calls).not.toContain("active:p2");
    h.run("focusPaneRight");
    expect(h.activeId()).toBe("p1");
    h.run("focusPaneDown");
    expect(h.activeId()).toBe("p2");
    h.run("focusPaneUp");
    expect(h.activeId()).toBe("p1");
  });

  test("no pane in a direction is a no-op (never wraps)", () => {
    const h = harness();
    h.run("focusPaneRight"); // p0 -> p1
    h.run("focusPaneRight"); // nothing right of the right column
    expect(h.activeId()).toBe("p1");
    expect(h.calls.filter((c) => c.startsWith("active:"))).toEqual(["active:p1"]);
  });
});

describe("keymap wiring: selection survives focus changes", () => {
  test("switchPane / directional focus never clear a pane's selection", () => {
    const h = harness();
    h.run("switchPane");
    h.run("focusPaneRight");
    expect(h.cleared).toEqual([]);
    expect(h.calls).toContain("renderAll");
  });
});

describe("keymap wiring: close guards", () => {
  test("closing a single-tab pane is immediate", () => {
    const h = harness();
    h.run("closePane");
    expect(h.calls).toContain("close:p0");
    expect(h.calls.some((c) => c.startsWith("confirm:"))).toBe(false);
  });

  test("closing a pane with open tabs asks first (layout-preset wording)", () => {
    const h = harness();
    const model = h.tabModels.get("p0");
    if (!model) throw new Error("no p0 model");
    model.list.push({ history: ["/b"], histIdx: 0 });
    h.run("closePane");
    expect(h.calls).toContain("confirm:Close 1 pane with open tabs?:Close panes:true");
    expect(h.calls).not.toContain("close:p0");
    h.yesNo.pending[0]?.onYes();
    expect(h.calls).toContain("close:p0");
  });

  test("the last tab close confirms the quit instead of quitting at once", () => {
    const h = harness();
    h.run("closeTab");
    expect(h.calls).toContain("confirm:Close the last tab and quit?:Quit:true");
    expect(h.calls).not.toContain("quit");
    h.yesNo.pending[0]?.onYes();
    expect(h.calls).toContain("quit");
  });

  test("a normal tab close stays immediate", () => {
    const h = harness();
    h.tabModels.get("p0")?.list.push({ history: ["/b"], histIdx: 0 });
    h.run("closeTab");
    expect(h.calls).toContain("tab:close");
    expect(h.calls.some((c) => c.startsWith("confirm:"))).toBe(false);
  });
});

describe("keymap wiring: startSearch is session-only", () => {
  test("does not persist type-to-search and opens/focuses the search box", () => {
    const h = harness();
    h.config.ui.typeToSearch = false;
    h.run("startSearch");
    // no applyConfig/save: a bare "/" must not rewrite the user's knob
    expect(h.calls).not.toContain("applyConfig");
    expect(h.calls).not.toContain("save");
    expect(h.config.ui.typeToSearch).toBe(false);
    // it opens through the normal opener path
    expect(h.calls).toContain("search:");
    // and the session flag re-arms the bare-key catch-all
    h.wired.keyRouter.handleKey({ name: "z" } as never);
    expect(h.calls).toContain("search:z");
  });
});

describe("keymap wiring: vim bind ownership", () => {
  test("vim off with the tfm preset drops hjkl/o", () => {
    const merged = presetKeys("tfm");
    merged.parentDir = [...(merged.parentDir ?? []), "h"];
    merged.moveUp = [...(merged.moveUp ?? []), "k"];
    merged.moveDown = [...(merged.moveDown ?? []), "j"];
    merged.openSelected = [...(merged.openSelected ?? []), "l", "o"];
    const changed = vimOffChanges(merged);
    expect(changed.parentDir).toEqual(["backspace", "alt+up"]);
    expect(changed.moveUp).toEqual(["up"]);
    expect(changed.moveDown).toEqual(["down"]);
    expect(changed.openSelected).toEqual(["return"]);
  });

  test("vim off with the yazi preset leaves every bind intact", () => {
    expect(vimOffChanges(presetKeys("yazi"))).toEqual({});
  });

  test("the wiring applies no change for a yazi table with vim off", () => {
    const h = harness({ vim: false, keys: presetKeys("yazi") });
    expect(h.calls).not.toContain("applyConfig");
    expect(h.config.keys.quit).toEqual(["ctrl+q", "q"]);
  });

  test("the wiring strips the persisted tfm+vim merge when vim turns off", () => {
    const merged = presetKeys("tfm");
    merged.moveUp = [...(merged.moveUp ?? []), "k"];
    merged.moveDown = [...(merged.moveDown ?? []), "j"];
    // boot runs applyVimBinds() with vim off — it must strip the persisted
    // merge through the same applyConfig path
    const h = harness({ vim: false, keys: merged });
    expect(h.calls).toContain("applyConfig");
    expect(h.config.keys.moveUp).toEqual(["up"]);
    expect(h.config.keys.moveDown).toEqual(["down"]);
  });
});
