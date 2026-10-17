import { describe, expect, test } from "bun:test";
import { defaultConfig, type UiConfig } from "../config/config-schema";
import { iconZoomLevel, iconZoomLevelCount, iconZoomPatchAt, showIconSlider } from "./icon-slider-model";

const withZoom = (level: number): UiConfig => ({ ...defaultConfig.ui, ...iconZoomPatchAt(defaultConfig.ui, level) });

describe("icon-slider model", () => {
  test("level count is 5 (the tightest axis: icon-cells 1..5)", () => {
    expect(iconZoomLevelCount()).toBe(5);
  });

  test("level 0 = the bottom of all three axes", () => {
    expect(iconZoomPatchAt(defaultConfig.ui, 0)).toEqual({ iconCells: 1, tileHeight: 3, tileWidth: 10 });
  });

  test("top level = level 4 (iconCells 5 / tileHeight 7 / tileWidth 14)", () => {
    expect(iconZoomPatchAt(defaultConfig.ui, 4)).toEqual({ iconCells: 5, tileHeight: 7, tileWidth: 14 });
  });

  test("patch clamps out-of-range levels", () => {
    expect(iconZoomPatchAt(defaultConfig.ui, -3)).toEqual(iconZoomPatchAt(defaultConfig.ui, 0));
    expect(iconZoomPatchAt(defaultConfig.ui, 99)).toEqual(iconZoomPatchAt(defaultConfig.ui, 4));
  });

  test("round-trip: iconZoomLevel(patch(level)) === level for every level", () => {
    for (let l = 0; l < iconZoomLevelCount(); l++) {
      expect(iconZoomLevel(withZoom(l))).toBe(l);
    }
  });

  test("level reads the lagging axis when the axes are out of lockstep", () => {
    // tileHeight (5-3)/1 = 2 is the minimum → level 2
    const ui: UiConfig = { ...defaultConfig.ui, iconCells: 5, tileHeight: 5, tileWidth: 20 };
    expect(iconZoomLevel(ui)).toBe(2);
  });
});

describe("showIconSlider gate", () => {
  const on = { enabled: true, viewMode: "grid", imageProtocol: "kitty" } as const;

  test("shown only when all three conditions hold", () => {
    expect(showIconSlider(on)).toBe(true);
  });

  test("hidden when disabled, non-grid, or no image protocol", () => {
    expect(showIconSlider({ ...on, enabled: false })).toBe(false);
    expect(showIconSlider({ ...on, viewMode: "list" })).toBe(false);
    expect(showIconSlider({ ...on, viewMode: "columns" })).toBe(false);
    // imageProtocolFor returns exactly `ImageRenderProtocol | null`, so null is
    // the "no protocol" sentinel the gate tests.
    expect(showIconSlider({ ...on, imageProtocol: null })).toBe(false);
  });
});
