// --- Pure math for the global toolbar strip (ui-toolbar-strip.ts): item
// geometry and the view-cycle icon name. No renderer, no tree — the strip
// itself only owns the DOM. The reference item width is 3 cells (the
// per-pane toolbar button shape). ---

import type { ViewMode } from "../config/config-schema";

// Insertion index for an x offset inside a row of fixed-width items: the
// nearest slot boundary, clamped to 0..count. `count` is a valid result —
// dropping after the last item. Used by the strip's drag/reorder pass.
export const dropIndexAt = (x: number, itemWidth: number, count: number): number => {
  if (itemWidth <= 0 || count <= 0) return 0;
  return Math.max(0, Math.min(count, Math.round(x / itemWidth)));
};

// How many items fit in availWidth: the cap a caller applies when the row must
// paint fewer buttons than were configured. Never more than `count`.
export const overflowCount = (availWidth: number, itemWidth: number, count: number): number => {
  if (itemWidth <= 0 || count <= 0) return 0;
  return Math.max(0, Math.min(count, Math.floor(availWidth / itemWidth)));
};

// The view-cycle button's icon follows the resolved view mode it would toggle
// (the caller already ran viewModeFor, so the tty grid->list fallback is in
// the value it passes here).
export const viewModeIcon = (mode: ViewMode): string =>
  mode === "grid" ? "view-grid" : mode === "columns" ? "view-columns" : "view-list";
