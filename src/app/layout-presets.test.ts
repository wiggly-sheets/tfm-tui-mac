import { describe, expect, test } from "bun:test";
import { leafIds, normalizeTree, type LayoutNode } from "./layout";
import { LAYOUT_PRESETS, layoutPreset, type LayoutPresetId } from "./layout-presets";

const presetIds = Object.keys(LAYOUT_PRESETS) as LayoutPresetId[];

describe("layout presets", () => {
  test("each preset yields the expected leaf ids", () => {
    expect(leafIds(layoutPreset("preset-single"))).toEqual(["p0"]);
    expect(leafIds(layoutPreset("preset-2col"))).toEqual(["p0", "p1"]);
    expect(leafIds(layoutPreset("preset-2row"))).toEqual(["p0", "p1"]);
    expect(leafIds(layoutPreset("preset-3pane"))).toEqual(["p0", "p1", "p2"]);
  });

  test("each preset has the expected orientation shape", () => {
    expect(layoutPreset("preset-single").kind).toBe("leaf");

    const twoCol = layoutPreset("preset-2col");
    expect(twoCol.kind).toBe("split");
    if (twoCol.kind === "split") expect(twoCol.orientation).toBe("h");

    const twoRow = layoutPreset("preset-2row");
    expect(twoRow.kind).toBe("split");
    if (twoRow.kind === "split") expect(twoRow.orientation).toBe("v");

    const three = layoutPreset("preset-3pane");
    expect(three.kind).toBe("split");
    if (three.kind === "split") {
      expect(three.orientation).toBe("h");
      const right: LayoutNode | undefined = three.children[1];
      expect(right?.kind).toBe("split");
      if (right?.kind === "split") expect(right.orientation).toBe("v");
    }
  });

  test("every preset is normalizeTree-stable", () => {
    for (const id of presetIds) {
      const tree = layoutPreset(id);
      expect(normalizeTree(tree)).toEqual(tree);
    }
  });
});
