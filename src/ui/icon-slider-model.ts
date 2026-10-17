// --- Pure model for the bottom-bar icon-size slider. The slider is another
// way to drive the EXISTING grid zoom (settings.zoomUiPatch): it moves
// iconCells + tileHeight + tileWidth together, one step per level. Bounds and
// steps come from UI_SCHEMA's int rows — the single source, never hardcoded —
// so the slider can never drift from the layout steppers. ---

import { UI_SCHEMA, type UiConfig, type ViewMode } from "../config/config-schema";

// the three grid-zoom axes the slider drives in lockstep (the same trio
// settings.zoomUiPatch moves for grid view)
const ZOOM_KEYS = ["iconCells", "tileHeight", "tileWidth"] as const;
type ZoomKey = (typeof ZOOM_KEYS)[number];

type IntRow = { min: number; max: number; step: number };

const rowOf = (key: ZoomKey): IntRow => {
  const row = UI_SCHEMA.find((r) => r.prop === key);
  if (row?.kind !== "int") throw new Error(`icon-slider: no int schema row for ${key}`);
  return row;
};

// how many discrete levels the slider offers: the tightest of the three axes
// decides (icon-cells 1..5 = 5 levels).
export const iconZoomLevelCount = (): number =>
  Math.min(
    ...ZOOM_KEYS.map((k) => {
      const r = rowOf(k);
      return Math.floor((r.max - r.min) / r.step) + 1;
    }),
  );

// the shared zoom position: the minimum over the three axes of
// (value - min)/step, clamped to [0, count-1]. The keys move together, so the
// minimum is the true position (a hand-edited config with the axes out of
// lockstep reports the lagging one).
export const iconZoomLevel = (ui: UiConfig): number => {
  const raw = Math.min(...ZOOM_KEYS.map((k) => (ui[k] - rowOf(k).min) / rowOf(k).step));
  const max = iconZoomLevelCount() - 1;
  return Math.max(0, Math.min(max, Math.round(raw)));
};

// the config patch for a level: set each axis to min + level*step, clamped.
export const iconZoomPatchAt = (_ui: UiConfig, level: number): Partial<UiConfig> => {
  const lvl = Math.max(0, Math.min(iconZoomLevelCount() - 1, Math.round(level)));
  const patch: Partial<UiConfig> = {};
  for (const k of ZOOM_KEYS) {
    const r = rowOf(k);
    patch[k] = Math.max(r.min, Math.min(r.max, r.min + lvl * r.step));
  }
  return patch;
};

// visibility gate (pure): the slider needs the feature on, the ACTIVE pane in
// grid view, and a live image protocol — with no protocol the pane keeps
// Nerd-Font glyphs, where growing icon cells buys nothing.
export const showIconSlider = (o: { enabled: boolean; viewMode: ViewMode; imageProtocol: unknown | null }): boolean =>
  o.enabled && o.viewMode === "grid" && o.imageProtocol !== null;
