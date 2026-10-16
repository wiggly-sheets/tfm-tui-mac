// --- Mouse drag-resize: the three chrome edges (the places sidebar's right
// edge, the pane split divider, the right preview/info panel's left edge).
// ONE gesture machine on the renderer ROOT: every mouse event bubbles up to
// it, so a panel that moves out from under the cursor mid-drag keeps
// delivering drags (a per-node handler would lose the gesture the moment the
// edge the user grabs outruns the pointer, which is exactly what a resize
// does). The pure solvers are exported and tested; the factory only wires
// them to node lookups, the toggles and the geometry writers.
//
// The three gestures are stateless per frame: the cursor column IS the target
// width (x - panel left for the sidebar, terminal right edge - x for the right
// panel, x for the divider), so a plain press-and-release at the target column
// sets the same width a drag would.
//
// shortcut: drag-resize needs mouse-MOVE events. SGR-encoded pointers (kitty,
// ghostty, iTerm2, wezterm, xterm, tmux with mouse on) deliver them; the Linux
// console only does through gpm, and a few multiplexers drop motion. Without
// moves the gesture still lands: press on the edge and release at the target
// column (the release carries its own x), just with no live preview.

import type { CliRenderer, MouseEvent } from "@opentui/core";
import type { MaybeNode } from "../lib/node-like";

export type ResizeTarget = "sidebar" | "split" | "preview";
export type ResizeBounds = { min: number; max: number };

// cells at the panel edge that arm a resize (the last two sidebar columns,
// the divider ± 1)
export const EDGE_COLS = 2;
// cells each pane keeps on its side of the divider
export const MIN_PANE_COLS = 20;

export const clampResize = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(v)));

// the sidebar's right edge follows the cursor: x is the last visible column,
// left the panel's first column, so the width is x - left + 1
export const sidebarWidthAt = (x: number, left: number, min: number, max: number): number =>
  clampResize(x - left + 1, min, max);

// the right panel hangs off the terminal's right edge, so its LEFT edge is
// what moves: growing it means dragging left
export const previewWidthAt = (x: number, termW: number, min: number, max: number): number =>
  clampResize(termW - x, min, max);

// percent of the free width (the split area minus the 1-cell divider) the LEFT
// pane keeps — a percent, not a cell count, so a terminal resize keeps the
// proportion. A split area too narrow for two minimum panes keeps `current`.
export const splitPctAt = (x: number, mainLeft: number, mainW: number, minCols: number, current: number): number => {
  const inner = mainW - 1;
  if (inner < minCols * 2) return current;
  const left = clampResize(x - mainLeft, minCols, inner - minCols);
  return (left / inner) * 100;
};

export type MouseResizeCtx = {
  renderer: CliRenderer;
  byId(id: string): MaybeNode;
  // live [ui] mouse-resize-* toggles, one per target (all default off)
  enabled(t: ResizeTarget): boolean;
  termW(): number;
  // the split area's width (terminal minus both side panels)
  mainW(): number;
  // the settings steppers' own bounds, so a drag can never leave the range
  bounds(t: ResizeTarget): ResizeBounds;
  // live geometry writes — the same cells the hover drawer owns
  setSidebarWidth(w: number): void;
  setPreviewWidth(w: number): void;
  setSplitPct(pct: number): void;
  splitPct(): number;
  // release: one rebuild/persist per gesture, never per frame
  commit(t: ResizeTarget): void;
  // modal / file-drag / rename / live-resize suppression
  blocked(): boolean;
  log(msg: string): void;
};

export type MouseResizeWiring = {
  // a resize gesture is in flight (the drawer must not tween the same width)
  active(): boolean;
  // is this press on that target's moveable edge? (the sidebar rows ask before
  // treating a press as a place click)
  edgePress(t: ResizeTarget, x: number): boolean;
  // the root handlers, exposed for tests
  onMouseDown(ev: MouseEvent): void;
  onMouseDrag(ev: MouseEvent): void;
  onMouseUp(ev: MouseEvent): void;
  onMouseDragEnd(ev: MouseEvent): void;
};

const leftOf = (n: MaybeNode): number | null => (typeof n?.screenX === "number" ? n.screenX : null);
const widthOf = (n: MaybeNode): number | null => (typeof n?.width === "number" ? n.width : null);
const shown = (n: MaybeNode): boolean => !!n && n.visible !== false;

export const makeMouseResize = (ctx: MouseResizeCtx): MouseResizeWiring => {
  let target: ResizeTarget | null = null;

  // right panel: preview and the info sidebar share one column (info wins
  // when both are on), so the first visible one owns the edge
  const rightPanel = (): MaybeNode => {
    const preview = ctx.byId("tfm-preview");
    if (shown(preview)) return preview;
    return ctx.byId("tfm-info");
  };

  // is x on the target's moveable edge? Node screen coords, so the check
  // follows every width write (drawer, applyConfig, a live drag) for free.
  const onEdge = (t: ResizeTarget, x: number): boolean => {
    if (t === "sidebar") {
      const n = ctx.byId("tfm-sidebar-root");
      const left = leftOf(n);
      const w = widthOf(n);
      if (left === null || w === null || !shown(n) || w <= 0) return false;
      return x >= left + w - EDGE_COLS && x < left + w;
    }
    if (t === "preview") {
      const n = rightPanel();
      const left = leftOf(n);
      if (left === null) return false;
      return x >= left && x < left + EDGE_COLS;
    }
    const d = ctx.byId("tfm-pane-divider");
    const left = leftOf(d);
    if (left === null || !shown(d)) return false;
    return x >= left - 1 && x <= left + 1;
  };

  const edgePress = (t: ResizeTarget, x: number): boolean => ctx.enabled(t) && onEdge(t, x);

  const apply = (t: ResizeTarget, x: number): void => {
    if (t === "sidebar") {
      const left = leftOf(ctx.byId("tfm-sidebar-root"));
      if (left === null) return;
      const b = ctx.bounds("sidebar");
      ctx.setSidebarWidth(sidebarWidthAt(x, left, b.min, b.max));
      return;
    }
    if (t === "preview") {
      const b = ctx.bounds("preview");
      ctx.setPreviewWidth(previewWidthAt(x, ctx.termW(), b.min, b.max));
      return;
    }
    const mainLeft = leftOf(ctx.byId("tfm-panes"));
    if (mainLeft === null) return;
    ctx.setSplitPct(splitPctAt(x, mainLeft, ctx.mainW(), MIN_PANE_COLS, ctx.splitPct()));
  };

  const onMouseDown = (ev: MouseEvent): void => {
    target = null;
    if (ev.button !== 0 || ctx.blocked()) return;
    for (const t of ["sidebar", "preview", "split"] as ResizeTarget[]) {
      if (edgePress(t, ev.x)) {
        target = t;
        ctx.log(`arm ${t} at x=${ev.x}`);
        return;
      }
    }
  };

  const onMouseDrag = (ev: MouseEvent): void => {
    if (!target || ctx.blocked()) return;
    apply(target, ev.x);
  };

  // release: apply the final column (the click-to-set-width path for
  // terminals that never sent a move) and commit once
  const release = (ev: MouseEvent): void => {
    const t = target;
    if (!t) return;
    target = null;
    apply(t, ev.x);
    ctx.log(`commit ${t} at x=${ev.x}`);
    ctx.commit(t);
  };

  ctx.renderer.root.onMouseDown = onMouseDown;
  ctx.renderer.root.onMouseDrag = onMouseDrag;
  ctx.renderer.root.onMouseUp = release;
  ctx.renderer.root.onMouseDragEnd = release;

  return {
    active: () => target !== null,
    edgePress,
    onMouseDown,
    onMouseDrag,
    onMouseUp: release,
    onMouseDragEnd: release,
  };
};
