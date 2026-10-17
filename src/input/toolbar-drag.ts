// --- Shared toolbar-drag state (stage B3): one plain mutable object so the
// strip/editor mouse handlers and the drag-block guards (input/mouse-resize
// blocked(), index's wireResize busy) see the same fields without plumbing.
// Leaf module — no renderer imports, so index.ts can import it statically
// without pulling the app graph into --version. Mirrors input/grid-input's
// gridDrag singleton. ---

import type { ToolbarItemId } from "../app/toolbar-items";

export const toolbarDrag = {
  active: false,
  kind: null as "reorder" | "add" | null,
  // reorder source index (kind "reorder") / -1
  from: -1,
  // palette chip id (kind "add") / null
  itemId: null as ToolbarItemId | null,
  // the gesture passed the drag threshold (a real drag, not a click)
  moved: false,
  // the cursor was last seen inside the strip
  inside: false,
  // a drop committed on the strip this gesture (blocks the deferred remove)
  dropped: false,
};
