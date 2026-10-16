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
import { dlog } from "../app/log";
import { makeMouseResize, type MouseResizeWiring, type ResizeBounds, type ResizeTarget } from "../input/mouse-resize";
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
  return { min: 1, max: 200 };
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

  const setSplitPct = (pct: number): void => {
    const p = Math.round(pct);
    core.geometry.splitPct = p;
    core.lookup.setOnId("tfm-pane-col-0", (n) => {
      n.flexGrow = p;
    });
    core.lookup.setOnId("tfm-pane-col-1", (n) => {
      n.flexGrow = 100 - p;
    });
  };

  return makeMouseResize({
    renderer: chrome.renderer,
    byId: core.lookup.byId,
    enabled: (t) => {
      const u = ui();
      if (t === "sidebar") return u.mouseResizeSidebar && u.sidebarVisible && !u.sidebarAutoHide;
      if (t === "preview") return u.mouseResizePreview && (u.previewEnabled || u.infoSidebar) && !u.previewAutoHide;
      return u.mouseResizeSplit && u.dualPane;
    },
    termW: () => chrome.renderer.terminalWidth,
    mainW: () => chrome.renderer.terminalWidth - core.geometry.sidebarEff - core.geometry.previewEff,
    bounds: (t) => boundsOf(PROP[t]),
    setSidebarWidth,
    setPreviewWidth,
    setSplitPct,
    splitPct: () => core.geometry.splitPct,
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
      gridDrag.active,
    log: (msg) => dlog(msg),
  });
};
