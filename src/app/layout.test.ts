import { describe, expect, test } from "bun:test";
import {
  closePane,
  cyclePane,
  defaultTree,
  findLeaf,
  findParent,
  layoutGeometry,
  leafIds,
  moveActiveTo,
  nextPaneId,
  normalizeTree,
  splitPane,
  type LayoutNode,
} from "./layout";

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
