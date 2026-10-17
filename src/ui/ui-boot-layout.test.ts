import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Box } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { defaultConfig } from "../config/config-schema";
import type { LayoutNode } from "../app/layout";
import { paneColId } from "../app/layout";
import {
  buildAppContainer,
  buildPaneColumn,
  buildPaneScroller,
  buildPaneTree,
  buildTitle,
  scrollbarTrackColors,
  setPathbarPosition,
} from "./ui-boot-layout";

// the grid scrollers' bars must wear the theme (not the upstream gray
// defaults), and rethemeChrome must be able to recompute the same mapping
// for the live bars without rebuilding the scrollers.

let t: TestRendererSetup;
beforeAll(async () => {
  t = await createTestRenderer({ width: 100, height: 40 });
});
afterAll(() => t.renderer.destroy());

const hexInts = (h: string): [number, number, number, number] => [
  Number.parseInt(h.slice(1, 3), 16),
  Number.parseInt(h.slice(3, 5), 16),
  Number.parseInt(h.slice(5, 7), 16),
  255,
];

const noop = () => {};

describe("tab strip containers", () => {
  test("both pane tabbars clip instead of bleeding over the grid", async () => {
    const theme = defaultConfig.theme;
    t.renderer.root.add(
      buildAppContainer({
        sw: 26,
        sideInnerW: 24,
        colors: theme,
        uiStyle: "solid",
        previewWidth: 40,
        previewEnabled: false,
        title: buildTitle({ width: 24, colors: theme }),
      }),
    );
    const host: any = t.renderer.root.findDescendantById("tfm-panes");
    const cols = new Map<string, any>();
    const tree = buildPaneTree(
      {
        kind: "split",
        orientation: "h",
        children: [
          { kind: "leaf", id: "p0" },
          { kind: "leaf", id: "p1" },
        ],
      },
      (id) => {
        let col = cols.get(id);
        if (!col) {
          col = buildPaneColumn({ id, toolbarShell: Box({}), tabBarVisible: true }).col;
          cols.set(id, col);
        }
        return col;
      },
      theme.divider,
    );
    host.add(tree);
    await t.renderOnce();
    for (const id of ["tfm-p0-tabbar", "tfm-p1-tabbar"]) {
      const bar: any = t.renderer.root.findDescendantById(id);
      expect(bar).toBeTruthy();
      expect(bar.overflow).toBe("hidden"); // shrunk chips clip here past the minimum
    }
  });
});

describe("pathbar position", () => {
  const childIds = (pos: "top" | "bottom" | "hidden"): string[] => {
    setPathbarPosition(() => pos);
    const { col } = buildPaneColumn({
      id: "p0",
      toolbarShell: Box({ id: "tfm-p0-toolbar" }),
      tabBarVisible: false,
    });
    return ((col as any).children ?? []).map((c: any) => c.props?.id ?? c.id);
  };

  test("top keeps the legacy order; bottom moves the bar below the grid; hidden drops it", () => {
    try {
      expect(childIds("top")).toEqual(["tfm-p0-toolbar", "tfm-p0-tabbar", "tfm-pane-0"]);
      expect(childIds("bottom")).toEqual(["tfm-p0-tabbar", "tfm-pane-0", "tfm-p0-toolbar"]);
      expect(childIds("hidden")).toEqual(["tfm-p0-tabbar", "tfm-pane-0"]);
    } finally {
      setPathbarPosition(() => "top");
    }
  });
});

describe("sidebar title block", () => {
  const theme = defaultConfig.theme;

  const mountTitle = async (mode: "tfm" | "files" | "none") => {
    // one title block per assertion: the ids are fixed, so a previously
    // mounted block would win findDescendantById
    node("tfm-title-box")?.destroy?.();
    t.renderer.root.add(buildTitle({ width: 24, colors: theme, mode }));
    await t.renderOnce();
  };
  const node = (id: string): any => t.renderer.root.findDescendantById(id);

  test("tfm mode keeps the original title: accent wordmark + tagline", async () => {
    await mountTitle("tfm");
    expect(node("tfm-title-font").text).toBe("tfm");
    expect(node("tfm-title-font").color).toBe(theme.accent);
    expect(node("tfm-title-sub").visible).toBe(true);
    expect(t.captureCharFrame()).toContain("terminal file manager");
  });

  test("files mode spells Files in the sidebar white, no tagline", async () => {
    await mountTitle("files");
    expect(node("tfm-title-font").text).toBe("Files");
    expect(node("tfm-title-font").color).toBe(theme.white);
    expect(node("tfm-title-sub").visible).toBe(false);
  });

  test("none mode hides the block but keeps it in the layout", async () => {
    await mountTitle("none");
    expect(node("tfm-title-box").visible).toBe(false);
  });
});

describe("grid scrollbar theming", () => {
  test("scrollbarTrackColors maps the quiet thumb + invisible bed roles", () => {
    const m = scrollbarTrackColors(defaultConfig.theme);
    expect(m.foregroundColor).toBe(defaultConfig.theme.sidebarFgMuted);
    expect(m.backgroundColor).toBe(defaultConfig.theme.bg);
  });

  test("both boot scrollers build their bars in theme colors", async () => {
    const theme = { ...defaultConfig.theme };
    const mkScroller = (id: "p0" | "p1") => {
      const { host } = buildPaneColumn({ id, toolbarShell: Box({}), tabBarVisible: false });
      t.renderer.root.add(host);
      const s = buildPaneScroller({
        renderer: t.renderer,
        colors: theme,
        id,
        bandCtx: {} as any,
        focusPane: noop,
        dropIntoPane: noop,
        closeFileMenu: noop,
        clearSearch: noop,
        blurTerminal: noop,
        pathEditMode: () => false,
        exitPathEdit: noop,
        isRenaming: () => false,
        finishInlineRename: noop,
        clearTileSelection: noop,
        openContextMenu: () => {},
        emptyAreaEntries: () => [],
      });
      (host as any).add(s);
      return s;
    };
    const s0 = mkScroller("p0");
    const s1 = mkScroller("p1");
    await t.renderOnce();
    for (const s of [s0, s1]) {
      const slider = (s as any).verticalScrollBar?.slider as any;
      expect(slider).toBeTruthy();
      expect([...slider.backgroundColor.toInts()]).toEqual(hexInts(theme.bg));
      expect([...slider.foregroundColor.toInts()]).toEqual(hexInts(theme.sidebarFgMuted));
    }
  });
});

describe("global toolbar row", () => {
  const theme = defaultConfig.theme;
  // the pre-mount skeleton IS a vnode tree, so the child order is asserted
  // before anything mounts (no ids to collide with — see the tests above)
  const mainKids = (toolbarHeight?: number): any[] => {
    const container: any = buildAppContainer({
      sw: 26,
      sideInnerW: 24,
      colors: theme,
      uiStyle: "solid",
      previewWidth: 40,
      previewEnabled: false,
      ...(toolbarHeight === undefined ? {} : { toolbarHeight }),
      title: buildTitle({ width: 24, colors: theme }),
    });
    const main = container.children.find((c: any) => c.props?.id === "tfm-main");
    return main.children;
  };

  test("tfm-toolbar is the FIRST child of tfm-main, above the panes", () => {
    expect(mainKids().map((c: any) => c.props?.id)).toEqual([
      "tfm-toolbar",
      "tfm-panes",
      "tfm-status",
      "tfm-term-host",
    ]);
  });

  test("an empty [ui] toolbar requests a zero-height row", () => {
    expect(mainKids(1)[0].props.height).toBe(1);
    expect(mainKids(0)[0].props.height).toBe(0);
  });
});

// A mixed tree is the case a flat pair never exercised: the h-split and the
// v-split must lay out as a row and a column, and each pair of siblings gets
// its own divider (the second no longer collides with the first).
describe("pane tree geometry", () => {
  const theme = defaultConfig.theme;

  // one mount per assertion: the id set is fixed, so a stale tree would win
  // findDescendantById
  const mount = async (tree: LayoutNode) => {
    (t.renderer.root.findDescendantById("tfm-panes") as any)?.destroy?.();
    t.renderer.root.add(
      buildAppContainer({
        sw: 26,
        sideInnerW: 24,
        colors: theme,
        uiStyle: "solid",
        previewWidth: 40,
        previewEnabled: false,
        title: buildTitle({ width: 24, colors: theme }),
      }),
    );
    const host: any = t.renderer.root.findDescendantById("tfm-panes");
    const cols = new Map<string, any>();
    host.add(
      buildPaneTree(
        tree,
        (id) => {
          let col = cols.get(id);
          if (!col) {
            col = buildPaneColumn({ id, toolbarShell: Box({}), tabBarVisible: false }).col;
            cols.set(id, col);
          }
          return col;
        },
        theme.divider,
      ),
    );
    await t.renderOnce();
  };

  test("a mixed h+v tree renders every leaf and orients its dividers", async () => {
    await mount({
      kind: "split",
      orientation: "h",
      children: [
        { kind: "leaf", id: "p0" },
        {
          kind: "split",
          orientation: "v",
          children: [
            { kind: "leaf", id: "p1" },
            { kind: "leaf", id: "p2" },
          ],
        },
      ],
    });
    const find = (id: string): any => t.renderer.root.findDescendantById(id);

    for (const id of ["p0", "p1", "p2"]) {
      expect(find(`tfm-${id}-tabbar`)).toBeTruthy();
      expect(find(paneColId(id))).toBeTruthy();
    }

    // h-split → a 1-wide vertical bar; v-split → a 1-tall horizontal bar.
    // (The bars also prove nesting: each sits in its own split box.)
    const outer = find("tfm-pane-divider");
    expect(outer.width).toBe(1);
    const inner = find("tfm-pane-divider-1");
    expect(inner.height).toBe(1);
    expect(outer.parent).not.toBe(inner.parent);
  });
});
