// --- Global toolbar strip: the customizable button row at the top of the main
// region. ONE fixed 3-cell hover button per configured item (catalog in
// app/toolbar-items.ts); a click runs that item's command out of the keymap's
// command table, so a button and its keybind are literally the same closure.
// The per-pane toolbar's button plumbing (makeHoverBtn) is reused, so both rows
// keep one visual language. The strip mounts itself into the boot-built
// `tfm-toolbar` row (same seam as the icon slider's `tfm-status`); ui-boot-layout
// owns that row and its boot-time height.
//
// Edit mode (stage B3, ui-toolbar-editor.ts): the same row becomes editable —
// items gain the editor's drag surface (onMouseDrag/Over/Out/Drop), a 1-cell
// insertion caret appears between items, and a trailing pencil button toggles
// the mode. The strip never writes config itself; every gesture routes to the
// editor, which commits through applyConfig and lets the renderAll pass rebuild
// this row. ---

import { Box } from "@opentui/core";
import type { UiConfig, ViewMode } from "../config/config-schema";
import type { Command } from "../lib/command";
import type { MaybeNode } from "../lib/node-like";
import { swallow } from "../app/log";
import { TOOLBAR_ITEMS, sanitizeToolbar, type ToolbarItemId } from "../app/toolbar-items";
import { destroyChildren } from "../lib/uiutil";
import { type HoverBtnCtx, makeHoverBtn } from "./ui-toolbar";
import { viewModeIcon } from "./toolbar-strip-model";
import { TOOLBAR_CARET_ID, TOOLBAR_ITEM_W, type ToolbarEditor } from "./ui-toolbar-editor";
import { toggleIconState, hoverEvents, type SlotElement } from "./ui-slots";
import { btnSurface } from "./style";

export const TOOLBAR_STRIP_ID = "tfm-toolbar-strip";
// the boot-built row the strip mounts into (ui-boot-layout) — its height is
// what collapses when the configured list is empty
export const TOOLBAR_ROW_ID = "tfm-toolbar";

export type ToolbarStripCtx = HoverBtnCtx & {
  ui(): UiConfig;
  // the ACTIVE pane's resolved view mode (app/panes.viewModeFor at the call
  // site, so the tty grid->list fallback is already applied)
  viewMode(): ViewMode;
  // the keymap's core command table — items dispatch by commandId
  commands(): Command[];
  // hover labels land on the status bar; "" clears one
  setStatus(msg: string): void;
  // text renderables default selectable, and the renderer's selection drag
  // would hijack the tile drag flows. refresh() runs outside renderAll too
  // (view-mode toggle), so the strip strips its OWN subtree instead of relying
  // on the pipeline's stripSelectable step.
  stripSelectable(node?: MaybeNode): void;
  // edit-mode owner (ui-toolbar-editor.ts). Absent = plain strip (old fakes,
  // headless callers): no pencil button, no drag surface.
  editor?: ToolbarEditor;
};

export const makeToolbarStrip = (ctx: ToolbarStripCtx) => {
  const el = Box({
    id: TOOLBAR_STRIP_ID,
    width: "100%",
    height: 1,
    flexDirection: "row",
    // fixed-width children never shrink, so past the row width the tail clips
    // here instead of spilling over the panes (boxes do not clip by default)
    overflow: "hidden",
    // drag: the strip box is the drop target for its own children's bubbled
    // `drop`/`over`/`out`. Guarded by edit mode so a normal-strip click never
    // reads them.
    onMouseOver: (ev: { x: number; y: number }) => {
      if (ctx.editor?.isActive()) ctx.editor.dragOver(ev.x, ev.y);
    },
    onMouseOut: () => {
      if (ctx.editor?.isActive()) ctx.editor.dragOut();
    },
    onMouseDrop: (ev: { x: number }) => {
      if (ctx.editor?.isActive()) ctx.editor.dropAt(ev.x);
    },
  });

  // a catalog id with no matching command (renamed action, removed plugin
  // command) must never throw out of a click handler
  const runItem = (commandId: string): void => {
    try {
      const cmd = ctx.commands().find((c) => c.id === commandId);
      if (!cmd) {
        swallow(`toolbar item ${commandId}`, new Error("no matching command"));
        return;
      }
      cmd.run();
    } catch (err) {
      swallow(`toolbar item ${commandId}`, err);
    }
  };

  const iconFor = (itemId: ToolbarItemId): string => {
    const item = TOOLBAR_ITEMS[itemId];
    return itemId === "view-cycle" ? viewModeIcon(ctx.viewMode()) : item.icon;
  };

  const buttonFor = (itemId: ToolbarItemId) => {
    const item = TOOLBAR_ITEMS[itemId];
    return makeHoverBtn(
      ctx,
      `${TOOLBAR_STRIP_ID}-${itemId}`,
      iconFor(itemId),
      () => runItem(item.commandId),
      (hover) => ctx.setStatus(hover ? item.label : ""),
    );
  };

  // edit-mode item: makeHoverBtn's shape plus the editor's drag surface, and a
  // focus paint (accent bg) so the keyboard cursor is visible.
  const editButtonFor = (itemId: ToolbarItemId, index: number) => {
    const item = TOOLBAR_ITEMS[itemId];
    const id = `${TOOLBAR_STRIP_ID}-${itemId}`;
    const tForce = () => (ctx.transparentForce?.() ? "force" : undefined);
    const focused = ctx.editor?.focusIndex() === index;
    const states = () => [
      { fg: ctx.colors().sidebarFg, bg: ctx.colors().bg },
      { fg: ctx.colors().sidebarFg, bg: ctx.colors().hoverBg },
    ];
    const slot = ctx.makeIconSlot(iconFor(itemId), states(), 1, 0, undefined, states);
    const paint = (on: boolean) => {
      ctx.setIconState(slot.spec, toggleIconState(on, false));
      ctx.setStatus(on ? item.label : "");
    };
    return Box(
      {
        id,
        height: 1,
        width: TOOLBAR_ITEM_W,
        justifyContent: "center",
        ...btnSurface(ctx.uiStyle(), ctx.colors(), focused, undefined, tForce()),
        onMouseDown: () => ctx.editor?.itemDragStart(index),
        onMouseDrag: (ev: { x: number; y: number }) => ctx.editor?.dragMove(ev.x, ev.y),
        onMouseDragEnd: () => ctx.editor?.endGesture(),
        onMouseUp: () => ctx.editor?.endGesture(),
        ...hoverEvents(paint, ctx.setPointer),
      },
      slot.el,
    );
  };

  // trailing pencil: toggles edit mode (the in-place entry point, alongside
  // the editToolbar key action)
  const editToggleButton = (): SlotElement =>
    makeHoverBtn(
      ctx,
      `${TOOLBAR_STRIP_ID}-edit`,
      "pencil",
      () => ctx.editor?.toggle(),
      (hover) => ctx.setStatus(hover ? "Edit toolbar" : ""),
    );

  // the insertion caret: a 1-cell absolute child the editor moves by id during
  // a drag (never rebuilt mid-gesture, or the drag capture would be destroyed)
  const caret = (): SlotElement =>
    Box({
      id: TOOLBAR_CARET_ID,
      position: "absolute",
      left: 0,
      top: 0,
      width: 1,
      height: 1,
      visible: false,
      backgroundColor: ctx.colors().accent,
    });

  // Rebuild the buttons from the live [ui] toolbar list. The strip el is a
  // VNode, so post-mount writes must go through the instantiated node by id —
  // the first refresh before the mount (or without one) is a no-op.
  const refresh = (): void => {
    const ids = sanitizeToolbar(ctx.ui().toolbar);
    const editing = !!ctx.editor?.isActive();
    // boot height comes from ui-boot-layout, so a runtime [ui] toolbar edit
    // flips the row here: an empty list must not occupy a row (but edit mode
    // keeps it open so the palette has somewhere to drop)
    try {
      const row = ctx.byId(TOOLBAR_ROW_ID);
      if (row) row.height = ids.length || editing ? 1 : 0;
    } catch {}
    const strip = ctx.byId(TOOLBAR_STRIP_ID);
    if (!strip) return;
    destroyChildren(strip);
    if (editing) {
      ids.forEach((itemId, i) => {
        strip.add(editButtonFor(itemId, i));
      });
      strip.add(caret());
    } else {
      for (const itemId of ids) strip.add(buttonFor(itemId));
    }
    strip.add(editToggleButton());
    try {
      ctx.stripSelectable(strip);
    } catch {}
  };

  try {
    ctx.byId(TOOLBAR_ROW_ID)?.add(el);
  } catch {}
  refresh();

  return { el, refresh };
};
