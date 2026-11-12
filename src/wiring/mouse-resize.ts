// --- Drag-resize wiring: the pure gesture machine (./input/mouse-resize) plus
// the three LIVE writers it drives. Every writer is the same cell the feature
// already owns — the sidebar/preview widths go back through applyConfig (the
// hover drawer's convergence path), the split ratio is session-only geometry
// (there is no config key: the pane tree it divides is not persisted either).
// Bounds come from UI_SCHEMA's own int rows, so a drag can never leave the
// range the settings steppers allow. Disabled while the hover drawer owns a
// panel's width (auto-hide on): two writers on one width would fight. ---

import { UI_SCHEMA, type UiConfig } from "../config/config-schema";
import { sideInnerWidth } from "../ui/style";
import { gridDrag } from "../input/grid-input";
import { toolbarDrag } from "../input/toolbar-drag";
import { dlog } from "../app/log";
import {
  makeMouseResize,
  MIN_PANE_COLS,
  MIN_PANE_ROWS,
  type MouseResizeWiring,
  type ResizeBounds,
  type ResizeTarget,
  type SplitHandle,
} from "../input/mouse-resize";
import { splitChildGrows, splitDividers, type SplitDivider } from "../app/layout";
import type { NodeLike } from "../lib/node-like";
import type { CoreWiring } from "./core";
import type { RethemeWiring } from "./settings";
import type { ChromeWiring, GridFoundationWiring, GridWiring } from "./types";

const PROP: Record<ResizeTarget, string> = {
  sidebar: "sidebarWidth",
  preview: "previewWidth",
  split: "splitPct",
};

// the settings steppers' own bounds (single source: the schema rows)
const boundsOf = (prop: string): ResizeBounds => {
  for (const row of UI_SCHEMA) {
    if (row.kind === "int" && row.prop === prop) return { min: row.min, max: row.max };
  }
  throw new Error(`mouse-resize: no schema row for ${prop}`);
};

export type { MouseResizeWiring };

export const wireMouseResize = (deps: {
  core: CoreWiring;
  chrome: ChromeWiring;
  gridFoundation: GridFoundationWiring;
  grid: GridWiring;
  getRetheme: () => RethemeWiring;
}) => {
  const { core, chrome, gridFoundation, grid } = deps;
  const ui = (): UiConfig => core.config.ui;

  const setSidebarWidth = (w: number): void => {
    core.geometry.sw = w;
    core.geometry.sidebarEff = w;
    const inner = sideInnerWidth(ui().uiStyle, w);
    core.lookup.setOnId("tfm-sidebar-root", (n) => {
      n.width = w;
    });
    for (const id of ["tfm-title-box", "tfm-places"]) {
      core.lookup.setOnId(id, (n) => {
        n.width = inner;
      });
    }
  };

  const setPreviewWidth = (w: number): void => {
    core.geometry.previewEff = w;
    for (const id of ["tfm-preview", "tfm-info"]) {
      core.lookup.setOnId(id, (n) => {
        n.width = w;
      });
    }
  };

  // The divider node id carries its document-order index (`tfm-pane-divider`,
  // `tfm-pane-divider-1`, …), which splitDividers() maps back to the split
  // node + child boundary it divides. A press stores that pair so the ratio
  // write lands on the DRAGGED split's own children.
  const dividerIndex = (id: string): number => {
    const m = /^tfm-pane-divider(?:-(\d+))?$/.exec(id);
    if (!m) return -1;
    return m[1] ? Number(m[1]) : 0;
  };

  const dividerNodes = (): NodeLike[] => {
    const out: NodeLike[] = [];
    const walk = (n: NodeLike | null | undefined): void => {
      if (!n) return;
      if (typeof n.id === "string" && n.id.startsWith("tfm-pane-divider")) out.push(n);
      for (const c of n.getChildren?.() ?? []) walk(c as NodeLike);
    };
    walk(core.lookup.byId("tfm-panes") as NodeLike | null | undefined);
    return out;
  };

  let armedSplit: SplitDivider | null = null;
  let armedParent: NodeLike | null = null;

  // resolve the divider under (x, y): the rendered divider is 1 cell wide for
  // a side-by-side split and 1 row tall for a stacked one, and its parent box
  // is the split's live extent on that axis.
  const splitAt = (x: number, y: number): SplitHandle | null => {
    armedSplit = null;
    armedParent = null;
    if (core.panes.leafIds().length < 2) return null;
    const dividers = splitDividers(core.panes.tree);
    for (const node of dividerNodes()) {
      const idx = dividerIndex(node.id ?? "");
      const info = idx >= 0 ? dividers[idx] : undefined;
      if (!info || !node.parent) continue;
      const axis = node.width === 1 ? "x" : node.height === 1 ? "y" : null;
      if (!axis) continue;
      const dw = typeof node.width === "number" ? node.width : 0;
      const dh = typeof node.height === "number" ? node.height : 0;
      const onLine =
        axis === "x"
          ? x >= node.screenX - 1 && x <= node.screenX + 1 && y >= node.screenY && y < node.screenY + dh
          : y >= node.screenY - 1 && y <= node.screenY + 1 && x >= node.screenX && x < node.screenX + dw;
      if (!onLine) continue;
      const parent = node.parent;
      const origin = axis === "x" ? parent.screenX : parent.screenY;
      const extent = axis === "x" ? parent.width : parent.height;
      if (typeof origin !== "number" || typeof extent !== "number" || extent <= 0) continue;
      armedSplit = info;
      armedParent = parent;
      return {
        axis,
        origin,
        extent,
        min: axis === "x" ? MIN_PANE_COLS : MIN_PANE_ROWS,
        current: info.split.sizing?.pct ?? 50,
      };
    }
    return null;
  };

  const setSplitPct = (_h: SplitHandle, pct: number): void => {
    const info = armedSplit;
    const parent = armedParent;
    if (!info || !parent) return;
    const p = Math.round(Math.min(99, Math.max(1, pct)));
    core.geometry.splitPct = p;
    info.split.sizing = { index: info.index, pct: p };
    // live write: the split's rendered children sit at the even indices of its
    // box (the odd ones are the divider cells)
    const grows = splitChildGrows(info.split);
    const kids = parent.getChildren?.() ?? [];
    let child = 0;
    for (let i = 0; i < kids.length; i += 2) {
      const n = kids[i];
      if (n) n.flexGrow = grows[child] ?? 1;
      child++;
    }
  };

  return makeMouseResize({
    renderer: chrome.renderer,
    byId: core.lookup.byId,
    enabled: (t) => {
      const u = ui();
      if (t === "sidebar") return u.mouseResizeSidebar && u.sidebarVisible && !u.sidebarAutoHide;
      if (t === "preview") return u.mouseResizePreview && (u.previewEnabled || u.infoSidebar) && !u.previewAutoHide;
      if (t === "split") return u.mouseResizeSplit && core.panes.leafIds().length > 1;
      return u.mouseResizeSplit && u.dualPane;
    },
    termW: () => chrome.renderer.terminalWidth,
    splitAt,
    bounds: (t) => boundsOf(PROP[t]),
    setSidebarWidth,
    setPreviewWidth,
    setSplitPct,
    commit: (t) => {
      // the split has no config key: one repaint reads the new ratio
      if (t === "split") {
        void grid.renderGrid();
        return;
      }
      // widths ARE config values, so the commit is a plain applyConfig: it
      // writes the nodes, persists, and refresh()es the drawer onto the same
      // number (the drawer stays the single owner of panel width)
      const next: UiConfig = { ...ui() };
      if (t === "sidebar") next.sidebarWidth = Math.round(core.geometry.sw);
      else next.previewWidth = Math.round(core.geometry.previewEff);
      deps.getRetheme().applyConfig({ ...core.config, ui: next });
      deps.getRetheme().scheduleSaveConfig();
    },
    blocked: () =>
      core.floats.depth() > 0 ||
      chrome.activeToolbar().pathEditMode() ||
      gridFoundation.rename.isRenaming() ||
      toolbarDrag.active ||
      gridDrag.active,
    log: (msg) => dlog(msg),
  });
};
