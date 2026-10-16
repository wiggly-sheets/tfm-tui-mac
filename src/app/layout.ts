// --- N-pane layout tree: pure data structure for splitting, closing,
// cycling, and computing geometry for arbitrary N-pane trees. ---

export type PaneId = string;
export type SplitOrientation = "v" | "h";

export type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type LeafPane = {
  kind: "leaf";
  id: PaneId;
  rect?: Rect;
};

export type SplitNode = {
  kind: "split";
  orientation: SplitOrientation;
  children: LayoutNode[];
  rect?: Rect;
};

export type LayoutNode = SplitNode | LeafPane;
export type LayoutTree = LayoutNode;

/**
 * Returns the default 2-pane tree (p0 and p1).
 */
export const defaultTree = (): SplitNode => ({
  kind: "split",
  orientation: "v",
  children: [
    { kind: "leaf", id: "p0" },
    { kind: "leaf", id: "p1" },
  ],
});

/**
 * Collects all leaf IDs in document order.
 */
export const leafIds = (tree: LayoutNode): PaneId[] => {
  if (tree.kind === "leaf") return [tree.id];
  const ids: PaneId[] = [];
  for (const child of tree.children) {
    ids.push(...leafIds(child));
  }
  return ids;
};

/**
 * Finds a leaf node by its PaneId.
 */
export const findLeaf = (tree: LayoutNode, id: PaneId): LeafPane | null => {
  if (tree.kind === "leaf") {
    return tree.id === id ? tree : null;
  }
  for (const child of tree.children) {
    const found = findLeaf(child, id);
    if (found) return found;
  }
  return null;
};

/**
 * Finds the parent SplitNode and child index for a given PaneId.
 */
export const findParent = (tree: LayoutNode, id: PaneId): { parent: SplitNode; index: number } | null => {
  if (tree.kind === "leaf") return null;
  for (let i = 0; i < tree.children.length; i++) {
    const child = tree.children[i];
    if (!child) continue;
    if (child.kind === "leaf" && child.id === id) {
      return { parent: tree, index: i };
    }
    const found = findParent(child, id);
    if (found) return found;
  }
  return null;
};

/**
 * Generates the next available PaneId (e.g. p0, p1, p2, ...).
 */
export const nextPaneId = (tree: LayoutNode): PaneId => {
  const ids = leafIds(tree);
  let maxIdx = -1;
  for (const id of ids) {
    const match = /^p(\d+)$/.exec(id);
    if (match) {
      const idx = Number(match[1]);
      if (!Number.isNaN(idx) && idx > maxIdx) maxIdx = idx;
    }
  }
  return `p${maxIdx + 1}`;
};

/**
 * Merges adjacent SplitNodes of the same orientation.
 */
export const mergeAdjacentSplits = (node: LayoutNode): LayoutNode => {
  if (node.kind === "leaf") return node;
  const mergedChildren: LayoutNode[] = [];
  for (const child of node.children) {
    const normalizedChild = mergeAdjacentSplits(child);
    if (normalizedChild.kind === "split" && normalizedChild.orientation === node.orientation) {
      mergedChildren.push(...normalizedChild.children);
    } else {
      mergedChildren.push(normalizedChild);
    }
  }
  return {
    ...node,
    children: mergedChildren,
  };
};

/**
 * Normalizes tree by collapsing single-child splits and merging adjacent same-orientation splits.
 */
export const normalizeTree = (node: LayoutNode): LayoutNode => {
  if (node.kind === "leaf") return node;

  const normalizedChildren: LayoutNode[] = [];
  for (const child of node.children) {
    const norm = normalizeTree(child);
    normalizedChildren.push(norm);
  }

  if (normalizedChildren.length === 1) {
    const only = normalizedChildren[0];
    return only ?? { ...node, children: normalizedChildren };
  }

  return mergeAdjacentSplits({
    ...node,
    children: normalizedChildren,
  });
};

/**
 * Splits the target leaf pane in the given orientation.
 * If target leaf does not exist, tree is returned unchanged.
 */
export const splitPane = (
  tree: LayoutTree,
  targetId: PaneId,
  orientation: SplitOrientation,
  newId?: PaneId,
): { tree: LayoutTree; newId: PaneId } => {
  const freshId = newId ?? nextPaneId(tree);

  const replaceInTree = (node: LayoutNode): LayoutNode => {
    if (node.kind === "leaf") {
      if (node.id === targetId) {
        return {
          kind: "split",
          orientation,
          children: [
            { kind: "leaf", id: targetId },
            { kind: "leaf", id: freshId },
          ],
        };
      }
      return node;
    }

    return {
      ...node,
      children: node.children.map(replaceInTree),
    };
  };

  const updated = replaceInTree(tree);
  const normalized = normalizeTree(updated);
  return { tree: normalized, newId: freshId };
};

/**
 * Closes the pane with the given ID.
 * Collapses 2-leaf trees to 1 leaf.
 * Does NOT allow empty trees (if only 1 leaf exists, closing is a no-op).
 */
export const closePane = (tree: LayoutTree, targetId: PaneId): LayoutTree => {
  const ids = leafIds(tree);
  if (ids.length <= 1) {
    return tree;
  }
  if (!ids.includes(targetId)) {
    return tree;
  }

  const removeLeaf = (node: LayoutNode): LayoutNode | null => {
    if (node.kind === "leaf") {
      return node.id === targetId ? null : node;
    }

    const remainingChildren: LayoutNode[] = [];
    for (const child of node.children) {
      const res = removeLeaf(child);
      if (res !== null) remainingChildren.push(res);
    }

    if (remainingChildren.length === 0) return null;
    if (remainingChildren.length === 1) {
      const only = remainingChildren[0];
      return only ?? null;
    }

    return {
      ...node,
      children: remainingChildren,
    };
  };

  const result = removeLeaf(tree);
  if (!result) return tree;
  return normalizeTree(result);
};

/**
 * Cycles the active pane focus through leaves in document order.
 */
export const cyclePane = (tree: LayoutTree, currentActive: PaneId, delta: 1 | -1 = 1): PaneId => {
  const ids = leafIds(tree);
  if (ids.length === 0) return currentActive;
  const idx = ids.indexOf(currentActive);
  if (idx < 0) return ids[0] ?? currentActive;
  const nextIdx = (idx + delta + ids.length) % ids.length;
  return ids[nextIdx] ?? currentActive;
};

/**
 * Re-orients the split containing the active leaf (or root split if applicable).
 */
export const moveActiveTo = (tree: LayoutTree, activeId: PaneId, orientation: SplitOrientation): LayoutTree => {
  const parentInfo = findParent(tree, activeId);
  if (parentInfo) {
    parentInfo.parent.orientation = orientation;
    return normalizeTree(tree);
  }
  if (tree.kind === "split") {
    return {
      ...tree,
      orientation,
    };
  }
  return tree;
};

/**
 * Computes geometry rects for all nodes in the tree:
 * a v-split divides height, an h-split divides width.
 * Remainder pixels are distributed to the last child.
 */
export const layoutGeometry = (tree: LayoutNode, rect: Rect): void => {
  tree.rect = { ...rect };
  if (tree.kind === "leaf") return;

  const count = tree.children.length;
  if (count === 0) return;

  if (tree.orientation === "v") {
    // vertical split divides height
    const baseH = Math.floor(rect.h / count);
    const remainder = rect.h - baseH * count;
    let curY = rect.y;

    for (let i = 0; i < count; i++) {
      const child = tree.children[i];
      if (!child) continue;
      const childH = baseH + (i === count - 1 ? remainder : 0);
      const childRect: Rect = {
        x: rect.x,
        y: curY,
        w: rect.w,
        h: childH,
      };
      layoutGeometry(child, childRect);
      curY += childH;
    }
  } else {
    // horizontal split divides width
    const baseW = Math.floor(rect.w / count);
    const remainder = rect.w - baseW * count;
    let curX = rect.x;

    for (let i = 0; i < count; i++) {
      const child = tree.children[i];
      if (!child) continue;
      const childW = baseW + (i === count - 1 ? remainder : 0);
      const childRect: Rect = {
        x: curX,
        y: rect.y,
        w: childW,
        h: rect.h,
      };
      layoutGeometry(child, childRect);
      curX += childW;
    }
  }
};

// --- DOM id helpers: p0 and p1 keep their byte-identical legacy ids so the
// boot layout, retheme, hit-target and toolbar tests keep working. New leaves
// (p2, p3, …) get `tfm-<id>-` prefixed ids that share the same shape.

export const paneColId = (id: PaneId): string =>
  id === "p0" ? "tfm-pane-col-0" : id === "p1" ? "tfm-pane-col-1" : `tfm-pane-col-${id}`;

export const paneHostId = (id: PaneId): string =>
  id === "p0" ? "tfm-pane-0" : id === "p1" ? "tfm-pane-1" : `tfm-pane-${id}`;

export const scrollerId = (id: PaneId): string =>
  id === "p0" ? "tfm-scroll" : id === "p1" ? "tfm-scroll-2" : `tfm-scroll-${id}`;

// `tfm-p0-` / `tfm-p1-` — the toolbar, tabbar and crumb prefix shape
export const panePrefix = (id: PaneId): string => `tfm-${id}-`;

export const tilePrefix = (id: PaneId): string => `tfm-tile-${id}-`;

// legacy 0|1 index for p0/p1 (the only ids that have one)
export const indexFromId = (id: PaneId): 0 | 1 => (id === "p1" ? 1 : 0);
