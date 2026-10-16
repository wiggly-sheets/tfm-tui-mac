// --- Pane manager: owns the pane-column DOM and the per-leaf grid scrollers,
// and rebuilds the whole split subtree whenever the layout tree changes. It
// registers its onTreeChange listener LAST (after nav/chrome/grid-foundation/
// grid), so every per-leaf widget already exists by the time a new column is
// built. The boot skeleton (ui-boot-layout) leaves `tfm-panes` empty for this. ---

import type { ScrollBoxRenderable } from "@opentui/core";
import { buildPaneColumn, buildPaneScroller, buildPaneTree } from "../ui/ui-boot-layout";
import { hookScrollerScroll } from "../ui/ui-grid";
import type { SlotElement } from "../ui/ui-slots";
import { destroyChildren, destroyNode } from "../lib/uiutil";
import type { NodeLike } from "../lib/node-like";
import type { PaneId } from "../app/layout";
import type { CoreWiring } from "./core";
import type { ChromeWiring, FileopsWiring, GridFoundationWiring, GridWiring, NavWiring } from "./types";

export const wirePanes = (deps: {
  core: CoreWiring;
  nav: NavWiring;
  chrome: ChromeWiring;
  gridFoundation: GridFoundationWiring;
  grid: GridWiring;
  fileops: FileopsWiring;
}) => {
  const { core, nav, chrome, gridFoundation, grid, fileops } = deps;
  const columns = new Map<PaneId, SlotElement>();
  const scrollers = new Map<PaneId, ScrollBoxRenderable>();

  const makeColumn = (id: PaneId): void => {
    const toolbar = chrome.toolbars.get(id);
    if (!toolbar) throw new Error(`panes: no toolbar for ${id}`);
    const { col, host } = buildPaneColumn({
      id,
      toolbarShell: toolbar.makeToolbarShell(),
      tabBarVisible: core.config.ui.tabBar,
    });
    const scroller = buildPaneScroller({
      renderer: chrome.renderer,
      colors: core.colors,
      id,
      bandCtx: grid.bandCtx,
      focusPane: () => grid.focusPane(id),
      dropIntoPane: () => grid.dropIntoPane(id),
      closeFileMenu: chrome.menu.closeFileMenu,
      clearSearch: nav.clearSearch,
      blurTerminal: fileops.terminal.blurTerminal,
      pathEditMode: () => chrome.activeToolbar().pathEditMode(),
      exitPathEdit: () => chrome.activeToolbar().exitPathEdit(),
      isRenaming: gridFoundation.rename.isRenaming,
      finishInlineRename: gridFoundation.rename.finishInlineRename,
      clearTileSelection: gridFoundation.selection.clearTileSelection,
      openContextMenu: chrome.menu.openContextMenu,
      emptyAreaEntries: grid.menuEntries.emptyAreaEntries,
      isTtyMode: core.isTtyMode,
    });
    (host as unknown as NodeLike).add(scroller);
    columns.set(id, col);
    scrollers.set(id, scroller);
    const ref = core.scrollerRefs.get(id);
    if (ref) ref.current = scroller;
    else core.scrollerRefs.set(id, { current: scroller });
    // [ui] windowed-grid: hook the scroll position so a slide rebuilds only the
    // row window (same wiring the boot scrollers used)
    hookScrollerScroll(scroller, () => grid.syncWindowPane(id));
  };

  const dropColumn = (id: PaneId): void => {
    const col = columns.get(id);
    const scroller = scrollers.get(id);
    try {
      const n = col as unknown as NodeLike | undefined;
      n?.parent?.remove(col);
    } catch {}
    try {
      if (scroller) destroyNode(scroller);
      if (col) destroyNode(col);
    } catch {}
    columns.delete(id);
    scrollers.delete(id);
  };

  // legacy 2-pane h-split: the session split ratio rides the two columns'
  // flexGrow (mouse-resize-split writes the same cells by id)
  const applySplitRatio = (): void => {
    const t = core.panes.tree;
    if (t.kind !== "split" || t.orientation !== "h" || t.children.length !== 2) return;
    t.children.forEach((child, i) => {
      if (child.kind !== "leaf") return;
      const col = columns.get(child.id) as unknown as NodeLike | undefined;
      if (col) col.flexGrow = i === 0 ? core.geometry.splitPct : 100 - core.geometry.splitPct;
    });
  };

  const collectDividers = (): NodeLike[] => {
    const out: NodeLike[] = [];
    const walk = (n: NodeLike | null | undefined): void => {
      if (!n) return;
      if (typeof n.id === "string" && n.id.startsWith("tfm-pane-divider")) out.push(n);
      for (const c of n.getChildren?.() ?? []) walk(c as NodeLike);
    };
    walk(core.lookup.byId("tfm-panes") as NodeLike | null | undefined);
    return out;
  };

  const retheme = (): void => {
    for (const d of collectDividers()) {
      try {
        d.backgroundColor = core.colors.divider;
      } catch {}
    }
  };

  const rebuild = (): void => {
    const host = core.lookup.byId("tfm-panes") as NodeLike | null | undefined;
    if (!host) return;
    // detach the persistent columns before sweeping the old split boxes away
    for (const col of columns.values()) {
      try {
        (col as unknown as NodeLike).parent?.remove(col);
      } catch {}
    }
    destroyChildren(host);
    const root = buildPaneTree(
      core.panes.tree,
      (id) => {
        const col = columns.get(id);
        if (!col) throw new Error(`panes: missing column for ${id}`);
        return col;
      },
      core.colors.divider,
    );
    host.add(root);
    applySplitRatio();
    retheme();
  };

  const sync = (): void => {
    const ids = core.panes.leafIds();
    for (const id of ids) if (!columns.has(id)) makeColumn(id);
    for (const id of [...columns.keys()]) if (!ids.includes(id)) dropColumn(id);
    rebuild();
  };

  core.panes.onTreeChange(sync);
  sync();

  return { retheme };
};

export type PanesWiring = ReturnType<typeof wirePanes>;
