// The global toolbar strip mounts an item button per [ui] toolbar id, runs the
// matching command on click, tracks the active view mode on the view-cycle
// button, and collapses the boot row when the list is empty.

import { describe, expect, test } from "bun:test";
import { Box, Text } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { ViewMode } from "../config/config-schema";
import type { Command } from "../lib/command";
import type { IconState } from "./ui-slots";
import { makeLookup } from "./ui-lookup";
import { makeToolbarStrip, TOOLBAR_ROW_ID, TOOLBAR_STRIP_ID } from "./ui-toolbar-strip";

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

// row 0 = the boot toolbar row, row 1+ = the panes
const PANES = "PANES";

const harness = async (opts: { toolbar: string[]; viewMode?: ViewMode; commands?: Command[] }) => {
  const t = await createTestRenderer({ width: 80, height: 4 });
  t.renderer.root.add(
    Box(
      { width: "100%", height: "100%", flexDirection: "column" },
      // the boot row exactly as ui-boot-layout builds it
      Box({ id: TOOLBAR_ROW_ID, width: "100%", height: 1, flexDirection: "row", overflow: "hidden" }),
      Box({ flexGrow: 1, width: "100%" }, Text({ content: PANES })),
    ),
  );
  const names: string[] = [];
  const status: string[] = [];
  const ran: string[] = [];
  let slotSeq = 0;
  let mode: ViewMode = opts.viewMode ?? "grid";
  const lookup = makeLookup({ root: () => t.renderer.root });
  const strip = makeToolbarStrip({
    byId: lookup.byId,
    colors: () => COLORS,
    uiStyle: () => "solid",
    makeIconSlot: (name, states: IconState[]) => {
      names.push(name);
      const slotId = `slot-${slotSeq++}`;
      return {
        // the glyph Text stands in for makeIconSlot's real selectable node
        el: Box({ id: slotId, width: 2, height: 1 }, Text({ id: `${slotId}-g`, content: "." })),
        slotId,
        spec: { slotId, name, heightCells: 1, states, initialState: 0 },
      };
    },
    setIconState: () => {},
    stripSelectable: lookup.stripSelectable,
    ui: () => ({ toolbar: opts.toolbar }) as any,
    viewMode: () => mode,
    commands: () => opts.commands ?? [],
    setStatus: (m) => status.push(m),
  });
  await t.renderOnce();
  const node = (id: string): any => t.renderer.root.findDescendantById(id);
  return {
    t,
    strip,
    names,
    status,
    ran,
    node,
    lines: (): string[] => t.captureCharFrame().split("\n"),
    click: (id: string): void => node(`${TOOLBAR_STRIP_ID}-${id}`)._mouseListeners.down({ x: 0, y: 0 }),
    setMode: (m: ViewMode): void => {
      mode = m;
    },
  };
};

describe("makeToolbarStrip", () => {
  test("mounts one 3-cell button per configured item, above the panes", async () => {
    const h = await harness({ toolbar: ["back", "view-cycle"] });
    const back = h.node(`${TOOLBAR_STRIP_ID}-back`);
    expect(back).toBeTruthy();
    expect(back.width).toBe(3);
    expect(h.node(`${TOOLBAR_STRIP_ID}-view-cycle`)).toBeTruthy();
    expect(h.lines()[1]).toContain(PANES); // the row sits above the panes
    h.t.renderer.destroy();
  });

  test("an empty list drops the buttons and collapses the row; a later edit restores it", async () => {
    const toolbar: string[] = [];
    const h = await harness({ toolbar });
    expect(h.node(`${TOOLBAR_STRIP_ID}-back`)).toBeFalsy();
    expect(h.lines()[0]).toContain(PANES); // row collapsed to zero height

    toolbar.push("back", "view-cycle");
    h.strip.refresh();
    await h.t.renderOnce();
    expect(h.lines()[1]).toContain(PANES);
    expect(h.node(`${TOOLBAR_STRIP_ID}-view-cycle`)).toBeTruthy();
    h.t.renderer.destroy();
  });

  test("view-cycle tracks the resolved mode; other items keep their catalog icon", async () => {
    const h = await harness({ toolbar: ["back", "view-cycle"], viewMode: "grid" });
    // the trailing pencil edit button adds its own slot after the items
    expect(h.names).toEqual(["chevron-left", "view-grid", "pencil"]);

    h.setMode("columns");
    h.strip.refresh();
    await h.t.renderOnce();
    expect(h.names.slice(-3)).toEqual(["chevron-left", "view-columns", "pencil"]);

    h.setMode("list");
    h.strip.refresh();
    await h.t.renderOnce();
    expect(h.names[h.names.length - 2]).toBe("view-list");
    h.t.renderer.destroy();
  });

  test("click runs the matching command; a missing one is swallowed", async () => {
    const h = await harness({
      toolbar: ["refresh"],
      commands: [{ id: "refresh", title: "Refresh", hint: "", run: () => h.ran.push("refresh") }],
    });
    h.click("refresh");
    expect(h.ran).toEqual(["refresh"]);

    // no command with that id (renamed/removed action): a click must not throw
    const bare = await harness({ toolbar: ["refresh"] });
    expect(() => bare.click("refresh")).not.toThrow();
    h.t.renderer.destroy();
    bare.t.renderer.destroy();
  });

  test("hover writes the item label to the status bar, leaving clears it", async () => {
    const h = await harness({ toolbar: ["refresh"] });
    const btn = h.node(`${TOOLBAR_STRIP_ID}-refresh`);
    btn._mouseListeners.move({});
    btn._mouseListeners.out({});
    expect(h.status).toEqual(["Refresh", ""]);
    h.t.renderer.destroy();
  });

  test("unknown [ui] toolbar ids are dropped before any button exists", async () => {
    const h = await harness({ toolbar: ["nope", "back", "back"] });
    expect(h.node(`${TOOLBAR_STRIP_ID}-back`)).toBeTruthy();
    expect(h.node(`${TOOLBAR_STRIP_ID}-nope`)).toBeFalsy();
    expect(h.names).toEqual(["chevron-left", "pencil"]); // deduped, then the edit button
    h.t.renderer.destroy();
  });

  test("refresh strips selectable from its own glyph nodes (runs outside renderAll too)", async () => {
    const h = await harness({ toolbar: ["back", "refresh"] });
    const selectables: boolean[] = [];
    const walk = (node: any): void => {
      for (const c of node.getChildren()) {
        selectables.push(!!c.selectable);
        walk(c);
      }
    };
    walk(h.node(TOOLBAR_STRIP_ID));
    // both glyph Texts were seen, and neither can start a selection drag
    expect(selectables.length).toBeGreaterThanOrEqual(2);
    expect(selectables.some((s) => s)).toBe(false);
    h.t.renderer.destroy();
  });
});
