import { describe, expect, test } from "bun:test";
import {
  closePane,
  cyclePane,
  defaultTree,
  findLeaf,
  findParent,
  layoutGeometry,
  leafIds,
  leafRectsOf,
  moveActiveTo,
  nextPaneId,
  normalizeTree,
  paneInDirection,
  splitChildGrows,
  splitDividers,
  splitPane,
  type LayoutNode,
  type SplitNode,
} from "./layout";
import { presetThreePane } from "./layout-presets";

describe("layout tree - invariants & leaf lookup", () => {
  test("defaultTree produces 2 leaves (p0 and p1)", () => {
    const tree = defaultTree();
    expect(tree.kind).toBe("split");
    expect(tree.orientation).toBe("h");
    expect(leafIds(tree)).toEqual(["p0", "p1"]);
  });

  test("findLeaf finds target leaf or null", () => {
    const tree = defaultTree();
    expect(findLeaf(tree, "p0")?.id).toBe("p0");
    expect(findLeaf(tree, "p1")?.id).toBe("p1");
    expect(findLeaf(tree, "p99")).toBeNull();
  });

  test("findParent locates parent SplitNode and child index", () => {
    const tree = defaultTree();
    const p0 = findParent(tree, "p0");
    expect(p0?.parent).toBe(tree);
    expect(p0?.index).toBe(0);

    const p1 = findParent(tree, "p1");
    expect(p1?.parent).toBe(tree);
    expect(p1?.index).toBe(1);

    expect(findParent(tree, "missing")).toBeNull();
  });

  test("nextPaneId increments highest numerical ID", () => {
    const tree = defaultTree();
    expect(nextPaneId(tree)).toBe("p2");

    const { tree: tree2 } = splitPane(tree, "p1", "h", "p2");
    expect(nextPaneId(tree2)).toBe("p3");
  });
});

describe("layout tree - split, close, cycle, reorient", () => {
  test("split of a leaf produces 2 leaves under a new SplitNode", () => {
    const tree = defaultTree();
    const { tree: newTree, newId } = splitPane(tree, "p0", "h");
    expect(newId).toBe("p2");
    expect(leafIds(newTree)).toEqual(["p0", "p2", "p1"]);
  });

  test("close collapses a 2-leaf tree to 1 leaf", () => {
    const tree = defaultTree();
    const closed = closePane(tree, "p1");
    expect(closed.kind).toBe("leaf");
    expect(leafIds(closed)).toEqual(["p0"]);
  });

  test("close does NOT allow empty trees (1 leaf left is a no-op)", () => {
    const singleLeaf: LayoutNode = { kind: "leaf", id: "p0" };
    const res = closePane(singleLeaf, "p0");
    expect(res).toBe(singleLeaf);
    expect(leafIds(res)).toEqual(["p0"]);
  });

  test("cyclePane wraps around leaves in document order", () => {
    const tree = defaultTree();
    const { tree: tree3 } = splitPane(tree, "p1", "v", "p2");
    // leaves: p0, p1, p2
    expect(cyclePane(tree3, "p0", 1)).toBe("p1");
    expect(cyclePane(tree3, "p1", 1)).toBe("p2");
    expect(cyclePane(tree3, "p2", 1)).toBe("p0");

    // reverse
    expect(cyclePane(tree3, "p0", -1)).toBe("p2");
    expect(cyclePane(tree3, "p2", -1)).toBe("p1");
  });

  test("moveActiveTo re-orients the split containing the active leaf", () => {
    const tree = defaultTree(); // v split
    const updated = moveActiveTo(tree, "p0", "h");
    expect(updated.kind).toBe("split");
    if (updated.kind === "split") {
      expect(updated.orientation).toBe("h");
    }
  });

  test("moveActiveTo is pure: the input tree is not mutated", () => {
    const tree = splitPane(defaultTree(), "p1", "v").tree; // h[p0, v[p1,p2]]
    const before = JSON.stringify(tree);
    const updated = moveActiveTo(tree, "p1", "h");
    expect(JSON.stringify(tree)).toBe(before);
    expect(updated).not.toBe(tree);
  });

  test("normalizeTree merges adjacent splits with same orientation", () => {
    const rawTree: LayoutNode = {
      kind: "split",
      orientation: "v",
      children: [
        {
          kind: "split",
          orientation: "v",
          children: [
            { kind: "leaf", id: "p0" },
            { kind: "leaf", id: "p1" },
          ],
        },
        { kind: "leaf", id: "p2" },
      ],
    };
    const norm = normalizeTree(rawTree);
    expect(norm.kind).toBe("split");
    if (norm.kind === "split") {
      expect(norm.children.length).toBe(3);
      expect(leafIds(norm)).toEqual(["p0", "p1", "p2"]);
    }
  });
});

describe("layout→geometry mapping", () => {
  test("a v-split divides height, an h-split divides width", () => {
    const tree: LayoutNode = {
      kind: "split",
      orientation: "v",
      children: [
        { kind: "leaf", id: "p0" },
        { kind: "leaf", id: "p1" },
      ],
    };

    layoutGeometry(tree, { x: 0, y: 0, w: 100, h: 40 });

    const p0 = findLeaf(tree, "p0");
    const p1 = findLeaf(tree, "p1");

    expect(p0?.rect).toEqual({ x: 0, y: 0, w: 100, h: 20 });
    expect(p1?.rect).toEqual({ x: 0, y: 20, w: 100, h: 20 });
  });

  test("h-split divides width", () => {
    const tree: LayoutNode = {
      kind: "split",
      orientation: "h",
      children: [
        { kind: "leaf", id: "p0" },
        { kind: "leaf", id: "p1" },
      ],
    };

    layoutGeometry(tree, { x: 0, y: 0, w: 100, h: 40 });

    const p0 = findLeaf(tree, "p0");
    const p1 = findLeaf(tree, "p1");

    expect(p0?.rect).toEqual({ x: 0, y: 0, w: 50, h: 40 });
    expect(p1?.rect).toEqual({ x: 50, y: 0, w: 50, h: 40 });
  });

  test("nested splits compute correct child rects", () => {
    // v-split of [p0, h-split([p1, p2])]
    const tree: LayoutNode = {
      kind: "split",
      orientation: "v",
      children: [
        { kind: "leaf", id: "p0" },
        {
          kind: "split",
          orientation: "h",
          children: [
            { kind: "leaf", id: "p1" },
            { kind: "leaf", id: "p2" },
          ],
        },
      ],
    };

    layoutGeometry(tree, { x: 0, y: 0, w: 100, h: 40 });

    const p0 = findLeaf(tree, "p0");
    const p1 = findLeaf(tree, "p1");
    const p2 = findLeaf(tree, "p2");

    expect(p0?.rect).toEqual({ x: 0, y: 0, w: 100, h: 20 });
    expect(p1?.rect).toEqual({ x: 0, y: 20, w: 50, h: 20 });
    expect(p2?.rect).toEqual({ x: 50, y: 20, w: 50, h: 20 });
  });
});

describe("layout→geometry min-size clamp", () => {
  // a 3-leaf h-split in a 20-column terminal: floor 8 each. 20 - 24 = -4
  // shortfall; the first two leaves keep 8, the last absorbs -4 (extends past
  // the area edge — the renderer clips, which is acceptable).
  test("narrow terminal with 3 h-split panes: floor on the first two, last absorbs shortfall", () => {
    const tree: LayoutNode = {
      kind: "split",
      orientation: "h",
      children: [
        { kind: "leaf", id: "p0" },
        { kind: "leaf", id: "p1" },
        { kind: "leaf", id: "p2" },
      ],
    };
    layoutGeometry(tree, { x: 0, y: 0, w: 20, h: 40 });

    const p0 = findLeaf(tree, "p0");
    const p1 = findLeaf(tree, "p1");
    const p2 = findLeaf(tree, "p2");

    expect(p0?.rect).toEqual({ x: 0, y: 0, w: 8, h: 40 });
    expect(p1?.rect).toEqual({ x: 8, y: 0, w: 8, h: 40 });
    // last leaf absorbs the shortfall: 20 - 8 - 8 = 4, i.e. -4 past the edge
    expect(p2?.rect).toEqual({ x: 16, y: 0, w: 4, h: 40 });
  });

  // a 3-leaf v-split in a 10-row terminal: floor 3 each. 10 - 9 = +1 surplus,
  // base 0, remainder 1 to the last child.
  test("short terminal with 3 v-split panes: floor on the first two, last gets the remainder", () => {
    const tree: LayoutNode = {
      kind: "split",
      orientation: "v",
      children: [
        { kind: "leaf", id: "p0" },
        { kind: "leaf", id: "p1" },
        { kind: "leaf", id: "p2" },
      ],
    };
    layoutGeometry(tree, { x: 0, y: 0, w: 100, h: 10 });

    const p0 = findLeaf(tree, "p0");
    const p1 = findLeaf(tree, "p1");
    const p2 = findLeaf(tree, "p2");

    expect(p0?.rect).toEqual({ x: 0, y: 0, w: 100, h: 3 });
    expect(p1?.rect).toEqual({ x: 0, y: 3, w: 100, h: 3 });
    expect(p2?.rect).toEqual({ x: 0, y: 6, w: 100, h: 4 });
  });

  // the normal case must not change: floor + evenly-divided surplus with the
  // remainder to the last child reproduces the old division exactly.
  test("normal 2-leaf h-split at 101 columns keeps the old division", () => {
    const tree: LayoutNode = {
      kind: "split",
      orientation: "h",
      children: [
        { kind: "leaf", id: "p0" },
        { kind: "leaf", id: "p1" },
      ],
    };
    layoutGeometry(tree, { x: 0, y: 0, w: 101, h: 40 });

    const p0 = findLeaf(tree, "p0");
    const p1 = findLeaf(tree, "p1");

    expect(p0?.rect).toEqual({ x: 0, y: 0, w: 50, h: 40 });
    expect(p1?.rect).toEqual({ x: 50, y: 0, w: 51, h: 40 });
  });

  test("too many panes never produce a negative child size", () => {
    const leaves = (): LayoutNode[] => Array.from({ length: 10 }, (_, i) => ({ kind: "leaf" as const, id: `p${i}` }));
    const hTree: LayoutNode = { kind: "split", orientation: "h", children: leaves() };
    layoutGeometry(hTree, { x: 0, y: 0, w: 20, h: 10 });
    for (const id of leafIds(hTree)) expect(findLeaf(hTree, id)?.rect?.w ?? 0).toBeGreaterThanOrEqual(1);

    const vTree: LayoutNode = { kind: "split", orientation: "v", children: leaves() };
    layoutGeometry(vTree, { x: 0, y: 0, w: 100, h: 10 });
    for (const id of leafIds(vTree)) expect(findLeaf(vTree, id)?.rect?.h ?? 0).toBeGreaterThanOrEqual(1);
  });
});

describe("directional pane focus (geometry, not document order)", () => {
  const rectsOf = (tree: LayoutNode) => leafRectsOf(tree, { x: 0, y: 0, w: 100, h: 40 });

  test("the 2-pane row: right/left cross, up/down have nowhere to go", () => {
    const rects = rectsOf(defaultTree());
    expect(paneInDirection(rects, "p0", "right")).toBe("p1");
    expect(paneInDirection(rects, "p1", "left")).toBe("p0");
    expect(paneInDirection(rects, "p0", "up")).toBeNull();
    expect(paneInDirection(rects, "p0", "down")).toBeNull();
  });

  test("the 3-pane preset: down/up step between the stacked right panes", () => {
    const rects = rectsOf(presetThreePane());
    // p0 is the full-height left column; p1/p2 split the right column
    expect(paneInDirection(rects, "p1", "down")).toBe("p2");
    expect(paneInDirection(rects, "p2", "up")).toBe("p1");
    expect(paneInDirection(rects, "p0", "right")).toBe("p1");
    // the full-height left pane has nothing directly above/below it, and the
    // right column has no pane further right nor the left column none left
    expect(paneInDirection(rects, "p0", "up")).toBeNull();
    expect(paneInDirection(rects, "p0", "down")).toBeNull();
    expect(paneInDirection(rects, "p1", "right")).toBeNull();
    expect(paneInDirection(rects, "p0", "left")).toBeNull();
  });

  test("a 2-row stack: down/up cross, left/right have nowhere to go", () => {
    const tree: LayoutNode = {
      kind: "split",
      orientation: "v",
      children: [
        { kind: "leaf", id: "p0" },
        { kind: "leaf", id: "p1" },
      ],
    };
    const rects = rectsOf(tree);
    expect(paneInDirection(rects, "p0", "down")).toBe("p1");
    expect(paneInDirection(rects, "p1", "up")).toBe("p0");
    expect(paneInDirection(rects, "p0", "right")).toBeNull();
  });

  test("unknown source / no panes resolve to null", () => {
    expect(paneInDirection(new Map(), "p0", "right")).toBeNull();
    expect(paneInDirection(rectsOf(defaultTree()), "p9", "left")).toBeNull();
  });
});

describe("session split sizing", () => {
  test("splitDividers walks in buildPaneTree's divider order", () => {
    const tree = presetThreePane(); // h[p0, v[p1,p2]]
    const dividers = splitDividers(tree);
    expect(dividers).toHaveLength(2);
    expect(dividers[0]?.split.orientation).toBe("h");
    expect(dividers[0]?.index).toBe(1);
    expect(dividers[1]?.split.orientation).toBe("v");
    expect(dividers[1]?.index).toBe(1);
  });

  test("no sizing means even shares (no ratio leaks across splits)", () => {
    const tree = presetThreePane();
    if (tree.kind !== "split") throw new Error("preset is a split");
    expect(splitChildGrows(tree)).toEqual([50, 50]);
    const vSplit = splitDividers(tree)[1]?.split;
    expect(vSplit && splitChildGrows(vSplit)).toEqual([50, 50]);
  });

  test("a dragged boundary moves its own children proportionally", () => {
    const split: SplitNode = {
      kind: "split",
      orientation: "h",
      children: [
        { kind: "leaf", id: "p0" },
        { kind: "leaf", id: "p1" },
        { kind: "leaf", id: "p2" },
      ],
    };
    split.sizing = { index: 2, pct: 60 };
    // two children before the divider share 60%, the one after keeps 40%
    expect(splitChildGrows(split)).toEqual([30, 30, 40]);
    split.sizing = { index: 1, pct: 70 };
    expect(splitChildGrows(split)).toEqual([70, 15, 15]);
  });

  test("sizing survives normalizeTree/close (spread-copied nodes)", () => {
    const two = presetThreePane(); // h[p0, v[p1,p2]]
    if (two.kind === "split") two.sizing = { index: 1, pct: 30 };
    // closing p1 collapses the nested v-split but keeps the root node (and its
    // session sizing) as the same shaped split
    const kept = closePane(two, "p1");
    expect(kept.kind).toBe("split");
    if (kept.kind === "split") expect(kept.sizing).toEqual({ index: 1, pct: 30 });
    // closing p2 leaves h[p0,p1] with the same preserved sizing
    const two2 = presetThreePane();
    if (two2.kind === "split") two2.sizing = { index: 1, pct: 30 };
    const kept2 = closePane(two2, "p2");
    expect(leafIds(kept2)).toEqual(["p0", "p1"]);
    if (kept2.kind === "split") expect(kept2.sizing).toEqual({ index: 1, pct: 30 });
  });
});
