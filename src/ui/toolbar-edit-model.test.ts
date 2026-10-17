import { describe, expect, test } from "bun:test";
import type { ToolbarItemId } from "../app/toolbar-items";
import { addItem, moveItem, removeItem, toggleItem } from "./toolbar-edit-model";

// three real catalog ids stand in for a..b..c
const A: ToolbarItemId = "back";
const B: ToolbarItemId = "forward";
const C: ToolbarItemId = "up";
const Z: ToolbarItemId = "refresh";
const L = (...ids: ToolbarItemId[]): ToolbarItemId[] => ids;

describe("addItem", () => {
  test("appends at the end for an out-of-range index", () => {
    expect(addItem(L(A), B, 99)).toEqual([A, B]);
  });

  test("middle insert lands before the boundary", () => {
    expect(addItem(L(A, C), B, 1)).toEqual([A, B, C]);
  });

  test("clamps negatives to the front", () => {
    expect(addItem(L(B), A, -5)).toEqual([A, B]);
  });

  test("a present id is a no-op (dedupe, no reorder)", () => {
    expect(addItem(L(A, B), A, 5)).toEqual([A, B]);
  });

  test("does not mutate the input", () => {
    const src = L(A);
    addItem(src, B, 0);
    expect(src).toEqual([A]);
  });
});

describe("moveItem", () => {
  test("forward: drop after the source subtracts the removed slot", () => {
    expect(moveItem(L(A, B, C), 0, 2)).toEqual([B, A, C]);
    expect(moveItem(L(A, B, C), 0, 3)).toEqual([B, C, A]);
  });

  test("backward: drop before the source keeps the boundary", () => {
    expect(moveItem(L(A, B, C), 2, 0)).toEqual([C, A, B]);
    expect(moveItem(L(A, B, C), 1, 1)).toEqual([A, B, C]);
  });

  test("reverses a forward then backward move to the same list", () => {
    const src = L(A, B, C);
    expect(moveItem(moveItem(src, 0, 2), 1, 0)).toEqual([A, B, C]);
  });

  test("an out-of-range source is a no-op", () => {
    expect(moveItem(L(A, B), 5, 0)).toEqual([A, B]);
    expect(moveItem(L(A, B), -1, 0)).toEqual([A, B]);
  });

  test("does not mutate the input", () => {
    const src = L(A, B);
    moveItem(src, 0, 2);
    expect(src).toEqual([A, B]);
  });
});

describe("removeItem", () => {
  test("drops the id, keeps order", () => {
    expect(removeItem(L(A, B, C), B)).toEqual([A, C]);
  });

  test("an absent id is a no-op", () => {
    expect(removeItem(L(A, B), Z)).toEqual([A, B]);
  });
});

describe("toggleItem", () => {
  test("appends when absent, removes when present", () => {
    expect(toggleItem(L(A), B)).toEqual([A, B]);
    expect(toggleItem(L(A, B), A)).toEqual([B]);
  });

  test("double toggle is identity", () => {
    const src = L(A, B);
    expect(toggleItem(toggleItem(src, C), C)).toEqual(src);
  });
});
