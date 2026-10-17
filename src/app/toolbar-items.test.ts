import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { KEY_SCHEMA } from "../config/config-schema";
import { DEFAULT_TOOLBAR, TOOLBAR_ITEMS, sanitizeToolbar, type ToolbarItemId } from "./toolbar-items";

const itemIds = Object.keys(TOOLBAR_ITEMS) as ToolbarItemId[];

describe("toolbar item catalog", () => {
  test("every item's icon is a real, non-empty SVG on disk", () => {
    for (const id of itemIds) {
      const icon = TOOLBAR_ITEMS[id].icon;
      const url = new URL(`../../assets/icons/${icon}.svg`, import.meta.url);
      const svg = readFileSync(url, "utf8");
      expect(svg.length, `${id} -> ${icon}.svg is empty`).toBeGreaterThan(0);
      expect(svg.includes("<svg"), `${id} -> ${icon}.svg has no <svg`).toBe(true);
      // chevron glyphs are polylines, not paths
      expect(
        /<(path|polyline|polygon|rect|circle|line|ellipse)\b/.test(svg),
        `${id} -> ${icon}.svg has no geometry`,
      ).toBe(true);
    }
  });

  test("every item's commandId is a real KeyAction", () => {
    const actions = new Set(KEY_SCHEMA.map((r) => r.action));
    for (const id of itemIds) {
      expect(actions.has(TOOLBAR_ITEMS[id].commandId as never), `${id} -> ${TOOLBAR_ITEMS[id].commandId}`).toBe(true);
    }
  });

  test("sanitizeToolbar drops unknown ids, dedupes, preserves order", () => {
    expect(sanitizeToolbar(["up", "nope", "back", "up", "back"])).toEqual(["up", "back"]);
    expect(sanitizeToolbar([])).toEqual([]);
    expect(sanitizeToolbar(["bogus"])).toEqual([]);
  });

  test("DEFAULT_TOOLBAR survives sanitizeToolbar unchanged", () => {
    expect(sanitizeToolbar(DEFAULT_TOOLBAR)).toEqual(DEFAULT_TOOLBAR);
  });
});
