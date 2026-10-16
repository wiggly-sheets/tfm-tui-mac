// --- Sync browsing: the pure follow logic is tested here (the wiring layer
// is thin by design — it only supplies the deps). Three invariants:
//   1. a directory entry in the active pane drives the OTHER pane once
//   2. the driven pane does NOT drive back (re-entrancy guard)
//   3. single-pane and config-off are no-ops
import { describe, expect, test } from "bun:test";
import { makeSyncBrowsing } from "./sync-browsing";

describe("makeSyncBrowsing", () => {
  test("config off: the other pane is never driven", () => {
    const calls: Array<[string, string]> = [];
    const sb = makeSyncBrowsing({
      enabled: () => false,
      leafIds: () => ["p0", "p1"],
      navigateOther: (id, dir) => calls.push([id, dir]),
    });
    sb.follow("p0", "/a");
    expect(calls).toEqual([]);
  });

  test("single pane: nothing to follow into (degrades cleanly)", () => {
    const calls: Array<[string, string]> = [];
    const sb = makeSyncBrowsing({
      enabled: () => true,
      leafIds: () => ["p0"],
      navigateOther: (id, dir) => calls.push([id, dir]),
    });
    sb.follow("p0", "/a");
    expect(calls).toEqual([]);
  });

  test("entering a dir in pane A drives pane B into it exactly once", () => {
    const calls: Array<[string, string]> = [];
    const sb = makeSyncBrowsing({
      enabled: () => true,
      leafIds: () => ["p0", "p1"],
      navigateOther: (id, dir) => calls.push([id, dir]),
    });
    sb.follow("p0", "/a");
    expect(calls).toEqual([["p1", "/a"]]);
    // a second, independent entry drives again
    sb.follow("p0", "/b");
    expect(calls).toEqual([
      ["p1", "/a"],
      ["p1", "/b"],
    ]);
  });

  test("the driven pane does not drive back on the same event (no infinite loop)", () => {
    // pane B's navigation would re-enter follow() — the guard suppresses it
    const calls: Array<[string, string]> = [];
    const sb = makeSyncBrowsing({
      enabled: () => true,
      leafIds: () => ["p0", "p1"],
      // simulate the wiring: driving pane B also calls follow from B's side
      navigateOther: (id, dir) => {
        calls.push([id, dir]);
        sb.follow(id, dir);
      },
    });
    sb.follow("p0", "/a");
    // A -> B once; B's follow() is swallowed by the guard (busy === true)
    expect(calls).toEqual([["p1", "/a"]]);
  });

  test("entering from pane B drives pane A", () => {
    const calls: Array<[string, string]> = [];
    const sb = makeSyncBrowsing({
      enabled: () => true,
      leafIds: () => ["p0", "p1"],
      navigateOther: (id, dir) => calls.push([id, dir]),
    });
    sb.follow("p1", "/x");
    expect(calls).toEqual([["p0", "/x"]]);
  });
});
