// --- Internal drag commit: the single choke point for every in-app move.
//
// Two drag surfaces exist in tfm and BOTH must land here:
//   1. OSC 72 (kitty/ghostty): the terminal runs the drag; our self-drop
//      handler in ./dnd72 resolves the target and calls commitMove.
//   2. SGR mouse (every terminal): OpenTUI delivers drag/drag-end/drop
//      events to renderables; ./grid-input's tile handlers trip a drag and
//      its onMouseDrop calls moveInto, which funnels here.
//
// The decision below (terminal capability -> which drag path is active) is
// the ONLY place that chooses. It is pure and headless so it can be tested
// without a renderer; the wiring injects the live capabilities object.
//
// shortcut: the "fallback" path is press + hold -> pick up -> click a
// destination folder -> move. It exists only when the terminal neither
// speaks OSC 72 nor SGR mouse motion (a dumb serial console). It has no
// live drag preview and no cross-pane hover highlight: the user sees the
// selection, then the destination tile's click. Upgrade path: any terminal
// that reports SGR pixels or kitty graphics upgrades to the full drag.

import type { TerminalCapabilities } from "@opentui/core";
import type { ClipItem } from "../input/grid-input";

export type DragPath = "osc72" | "sgr" | "fallback";

// One decision, three outcomes. `null` caps (renderer not ready yet) degrade
// to SGR — the safe default, since SGR mouse is what OpenTUI enables by
// default on every terminal that speaks at all.
export const resolveDragPath = (caps: TerminalCapabilities | null): DragPath => {
  if (caps?.kitty_graphics) return "osc72";
  if (caps?.sgr_pixels || caps?.sixel) return "sgr";
  return "fallback";
};

// drag source (the items being moved) + drop target -> one runTransfer call.
// Reuses ./transfer's runTransfer via the injected ctx so the conflict
// prompt, undo units, progress toast and plugin veto all stay in one place.
export type MoveCommitCtx = {
  runTransfer(op: "copy" | "move", destDir: string, srcs: string[], label: string): Promise<void>;
};

export const commitMove = (ctx: MoveCommitCtx) => async (destDir: string, items: ClipItem[]): Promise<void> => {
  // dropping a folder onto itself / into its own subtree would recurse forever;
  // runTransfer's own isWithinOrEqual check handles it, but filtering here
  // keeps the label honest ("move N items" vs "Moved 0 items").
  const srcs = items
    .filter((it) => it.path !== destDir)
    .map((it) => it.path);
  if (!srcs.length) return;
  await ctx.runTransfer(
    "move",
    destDir,
    srcs,
    `move ${srcs.length} item${srcs.length === 1 ? "" : "s"} to ${destDir.split("/").pop() || "/"}`,
  );
};