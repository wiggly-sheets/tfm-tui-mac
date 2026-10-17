// --- Pure layout presets: the named N-pane arrangements the toolbar's preset
// items apply. Inputs/outputs are layout.ts trees (leaf ids p0/p1/p2 in
// document order) and every output is normalizeTree-stable. No renderer/fs. ---
import { defaultTree, normalizeTree, type LayoutTree } from "./layout";

export type LayoutPresetId = "preset-single" | "preset-2col" | "preset-2row" | "preset-3pane";

// one pane
export const presetSingle = (): LayoutTree => ({ kind: "leaf", id: "p0" });

// two panes side by side (the boot layout)
export const presetTwoCol = (): LayoutTree => defaultTree();

// two panes stacked
export const presetTwoRow = (): LayoutTree => ({
  kind: "split",
  orientation: "v",
  children: [
    { kind: "leaf", id: "p0" },
    { kind: "leaf", id: "p1" },
  ],
});

// one pane on the left, two stacked on the right
export const presetThreePane = (): LayoutTree => ({
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

export const LAYOUT_PRESETS: Record<LayoutPresetId, () => LayoutTree> = {
  "preset-single": presetSingle,
  "preset-2col": presetTwoCol,
  "preset-2row": presetTwoRow,
  "preset-3pane": presetThreePane,
};

export const layoutPreset = (id: LayoutPresetId): LayoutTree => normalizeTree(LAYOUT_PRESETS[id]());
