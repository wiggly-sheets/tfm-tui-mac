// The toolbar editor (stage B3) over a real render root + strip: enter/exit both
// ways, the palette drawer (chips, click-to-add, non-modal), the mouse drag
// surface (add / reorder / drag-off-remove) and the keyboard cursor (arrows,
// alt-nudge, delete, esc). The shared toolbarDrag singleton is reset by exit().

import { describe, expect, test } from "bun:test";
import { Box, Text } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { ToolbarItemId } from "../app/toolbar-items";
import { makeLookup } from "./ui-lookup";
import { makeFloats } from "./floats";
import { destroyChildren } from "../lib/uiutil";
import type { IconState } from "./ui-slots";
import { makeToolbarStrip, TOOLBAR_ROW_ID, TOOLBAR_STRIP_ID } from "./ui-toolbar-strip";
import { makeToolbarEditor, PALETTE_ID } from "./ui-toolbar-editor";

const COLORS: any = {
  bg: "#111111",
  sidebarBg: "#000000",
  sidebarFg: "#cccccc",
  sidebarFgMuted: "#888888",
  accent: "#7aa2f7",
  accentBg: "#333333",
  hoverBg: "#222222",
  border: "#333333",
  divider: "#333333",
  white: "#ffffff",
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

const harness = async (opts: { toolbar: ToolbarItemId[] }) => {
  const t = await createTestRenderer({ width: 80, height: 24 });
  t.renderer.root.add(
    Box(
      { width: "100%", height: "100%", flexDirection: "column" },
      Box({ id: TOOLBAR_ROW_ID, width: "100%", height: 1, flexDirection: "row", overflow: "hidden" }),
      Box({ flexGrow: 1, width: "100%" }, Text({ content: "PANES" })),
    ),
  );
  let toolbar = [...opts.toolbar];
  const floats = makeFloats();
  const lookup = makeLookup({ root: () => t.renderer.root });
  let slotSeq = 0;
  const slot = (name: string, states: IconState[]) => {
    const slotId = `slot-${slotSeq++}`;
    return {
      el: Box({ id: slotId, width: 2, height: 1 }, Text({ id: `${slotId}-g`, content: "." })),
      slotId,
      spec: { slotId, name, heightCells: 1, states, initialState: 0 },
    };
  };
  let repaint = () => {};
  const editor = makeToolbarEditor({
    ui: () => ({ toolbar }) as any,
    applyToolbar: (next) => {
      toolbar = next;
    },
    byId: lookup.byId,
    rootAdd: (node) => t.renderer.root.add(node),
    destroyChildren,
    stripSelectable: lookup.stripSelectable,
    colors: () => COLORS,
    uiStyle: () => "solid",
    makeIconSlot: slot,
    floats,
    stripLeft: () => 0,
    panelLeft: () => 2,
    setPointer: () => {},
    repaint: () => repaint(),
  });
  const strip = makeToolbarStrip({
    byId: lookup.byId,
    colors: () => COLORS,
    uiStyle: () => "solid",
    makeIconSlot: slot,
    setIconState: () => {},
    stripSelectable: lookup.stripSelectable,
    ui: () => ({ toolbar }) as any,
    viewMode: () => "grid",
    commands: () => [],
    setStatus: () => {},
    setPointer: () => {},
    editor,
  });
  repaint = () => strip.refresh();
  await t.renderOnce();
  const node = (id: string): any => t.renderer.root.findDescendantById(id);
  return {
    t,
    editor,
    strip,
    floats,
    node,
    list: (): ToolbarItemId[] => [...toolbar],
    click: (id: string): void => node(id)._mouseListeners.down({ x: 0, y: 0 }),
  };
};

describe("makeToolbarEditor", () => {
  test("outside edit mode handleKey is inert and nothing commits", async () => {
    const h = await harness({ toolbar: ["back"] });
    expect(h.editor.isActive()).toBe(false);
    expect(h.editor.handleKey({ name: "left" })).toBe(false);
    expect(h.list()).toEqual(["back"]);
    h.t.renderer.destroy();
  });

  test("enter opens a NON-MODAL palette with a chip per catalog item", async () => {
    const h = await harness({ toolbar: ["back"] });
    h.editor.enter();
    await h.t.renderOnce();
    expect(h.editor.isActive()).toBe(true);
    expect(h.floats.isOpen("toolbaritems")).toBe(true);
    expect(h.floats.hasModal()).toBe(false); // must not dim the live strip
    expect(h.node(PALETTE_ID)).toBeTruthy();
    expect(h.node(`${PALETTE_ID}-up`)).toBeTruthy();
    h.editor.exit();
    h.t.renderer.destroy();
  });

  test("a chip click appends the item", async () => {
    const h = await harness({ toolbar: ["back"] });
    h.editor.enter();
    await h.t.renderOnce();
    h.click(`${PALETTE_ID}-up`); // down arms the add gesture
    h.node(`${PALETTE_ID}-up`)._mouseListeners.up({});
    await tick();
    expect(h.list()).toEqual(["back", "up"]);
    h.editor.exit();
    h.t.renderer.destroy();
  });

  test("a chip dropped on the strip inserts at the drop boundary", async () => {
    const h = await harness({ toolbar: ["back", "forward"] });
    h.editor.enter();
    await h.t.renderOnce();
    h.click(`${PALETTE_ID}-up`);
    h.editor.dragMove(9, 0);
    h.editor.dropAt(3); // boundary 1 (x/strip left 0, width 3)
    expect(h.list()).toEqual(["back", "up", "forward"]);
    h.editor.endGesture();
    await tick(); // deferred finalize must not also remove
    expect(h.list()).toEqual(["back", "up", "forward"]);
    h.editor.exit();
    h.t.renderer.destroy();
  });

  test("reorder within the strip moves the item to the drop boundary", async () => {
    const h = await harness({ toolbar: ["back", "forward", "up"] });
    h.editor.enter();
    h.editor.itemDragStart(0);
    h.editor.dragMove(9, 0);
    h.editor.dropAt(6); // boundary 2
    expect(h.list()).toEqual(["forward", "back", "up"]);
    expect(h.editor.focusIndex()).toBe(1);
    h.editor.endGesture();
    await tick();
    expect(h.list()).toEqual(["forward", "back", "up"]);
    h.editor.exit();
    h.t.renderer.destroy();
  });

  test("dragging an item off the strip removes it", async () => {
    const h = await harness({ toolbar: ["back", "forward", "up"] });
    h.editor.enter();
    h.editor.itemDragStart(0);
    h.editor.dragMove(0, 0);
    h.editor.dragOut();
    h.editor.endGesture();
    await tick();
    expect(h.list()).toEqual(["forward", "up"]);
    h.editor.exit();
    h.t.renderer.destroy();
  });

  test("keyboard: right walks items, enters the palette at the end, left returns", async () => {
    const h = await harness({ toolbar: ["back", "forward"] });
    h.editor.enter();
    await h.t.renderOnce();
    expect(h.editor.focusIndex()).toBe(0);
    expect(h.editor.handleKey({ name: "right" })).toBe(true);
    expect(h.editor.focusIndex()).toBe(1);
    expect(h.editor.handleKey({ name: "right" })).toBe(true); // past the last item
    expect(h.editor.paletteIndex()).toBe(0);
    expect(h.editor.handleKey({ name: "left" })).toBe(true);
    expect(h.editor.paletteIndex()).toBe(-1);
    expect(h.editor.focusIndex()).toBe(1);
    h.editor.exit();
    h.t.renderer.destroy();
  });

  test("alt+right nudges the focused item one slot forward", async () => {
    const h = await harness({ toolbar: ["back", "forward", "up"] });
    h.editor.enter();
    h.editor.handleKey({ name: "right", meta: true });
    expect(h.list()).toEqual(["forward", "back", "up"]);
    expect(h.editor.focusIndex()).toBe(1);
    h.editor.exit();
    h.t.renderer.destroy();
  });

  test("delete removes the focused item", async () => {
    const h = await harness({ toolbar: ["back", "forward"] });
    h.editor.enter();
    h.editor.handleKey({ name: "delete" });
    expect(h.list()).toEqual(["forward"]);
    expect(h.editor.focusIndex()).toBe(0);
    h.editor.exit();
    h.t.renderer.destroy();
  });

  test("escape exits edit mode and closes the palette", async () => {
    const h = await harness({ toolbar: ["back"] });
    h.editor.enter();
    await h.t.renderOnce();
    expect(h.node(PALETTE_ID)).toBeTruthy();
    expect(h.editor.handleKey({ name: "escape" })).toBe(true);
    expect(h.editor.isActive()).toBe(false);
    expect(h.floats.isOpen("toolbaritems")).toBe(false);
    expect(h.node(PALETTE_ID)).toBeFalsy();
    h.t.renderer.destroy();
  });

  test("the strip pencil toggles edit mode and its buttons carry the drag surface", async () => {
    const h = await harness({ toolbar: ["back", "forward", "up"] });
    h.click(`${TOOLBAR_STRIP_ID}-edit`);
    expect(h.editor.isActive()).toBe(true);
    await h.t.renderOnce();
    const back = h.node(`${TOOLBAR_STRIP_ID}-back`);
    back._mouseListeners.down({ x: 0, y: 0 });
    h.node(TOOLBAR_STRIP_ID)._mouseListeners.over({ x: 6, y: 0 });
    h.node(TOOLBAR_STRIP_ID)._mouseListeners.drop({ x: 6, y: 0 });
    expect(h.list()).toEqual(["forward", "back", "up"]);
    back._mouseListeners["drag-end"]({});
    await tick();
    expect(h.list()).toEqual(["forward", "back", "up"]);
    h.editor.exit();
    h.t.renderer.destroy();
  });
});
