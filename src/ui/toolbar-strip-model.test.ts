import { describe, expect, test } from "bun:test";
import type { ViewMode } from "../config/config-schema";
import { dropIndexAt, overflowCount, viewModeIcon } from "./toolbar-strip-model";

describe("dropIndexAt", () => {
  test("snaps x to the nearest slot boundary", () => {
    expect(dropIndexAt(0, 3, 4)).toBe(0);
    expect(dropIndexAt(1, 3, 4)).toBe(0);
    expect(dropIndexAt(2, 3, 4)).toBe(1);
    expect(dropIndexAt(3, 3, 4)).toBe(1);
    expect(dropIndexAt(13, 3, 4)).toBe(4);
  });

  test("clamps to 0..count", () => {
    expect(dropIndexAt(-9, 3, 4)).toBe(0);
    expect(dropIndexAt(999, 3, 4)).toBe(4);
  });

  test("empty row yields 0", () => {
    expect(dropIndexAt(7, 3, 0)).toBe(0);
  });

  test("a non-positive item width cannot divide", () => {
    expect(dropIndexAt(5, 0, 4)).toBe(0);
    expect(dropIndexAt(5, -3, 4)).toBe(0);
  });
});

describe("overflowCount", () => {
  test("counts whole items that fit", () => {
    expect(overflowCount(9, 3, 5)).toBe(3);
    expect(overflowCount(10, 3, 5)).toBe(3);
    expect(overflowCount(15, 3, 5)).toBe(5);
  });

  test("never exceeds the configured count", () => {
    expect(overflowCount(100, 3, 2)).toBe(2);
  });

  test("empty row or no width fits nothing", () => {
    expect(overflowCount(0, 3, 5)).toBe(0);
    expect(overflowCount(9, 3, 0)).toBe(0);
    expect(overflowCount(-4, 3, 5)).toBe(0);
    expect(overflowCount(9, 0, 5)).toBe(0);
  });
});

describe("viewModeIcon", () => {
  test("each mode maps to its own catalog icon", () => {
    expect(viewModeIcon("grid" as ViewMode)).toBe("view-grid");
    expect(viewModeIcon("list" as ViewMode)).toBe("view-list");
    expect(viewModeIcon("columns" as ViewMode)).toBe("view-columns");
  });
});
