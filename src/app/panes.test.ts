import { describe, expect, test } from "bun:test";
import {
  activeFacade,
  activeMapFacade,
  activeState,
  makeLeafRegistry,
  makePanePair,
  mergedMapFacade,
  otherState,
  pointPaneAt,
  setActivePane,
  togglePane,
  viewModeFor,
} from "./panes";

describe("pane pair", () => {
  test("starts on the first pane with both states held independently", () => {
    const p = makePanePair({ cwd: "/a" }, { cwd: "/b" });
    expect(p.active).toBe(0);
    expect(activeState(p).cwd).toBe("/a");
    expect(otherState(p).cwd).toBe("/b");
  });

  test("setActivePane selects a pane; toggling flips between them", () => {
    const p = makePanePair("left", "right");
    setActivePane(p, 1);
    expect(activeState(p)).toBe("right");
    expect(otherState(p)).toBe("left");
    togglePane(p);
    expect(activeState(p)).toBe("left");
    togglePane(p);
    expect(activeState(p)).toBe("right");
  });

  test("mutating the active state does not touch the other pane", () => {
    const p = makePanePair({ cwd: "/a" }, { cwd: "/b" });
    activeState(p).cwd = "/a/sub";
    expect(otherState(p).cwd).toBe("/b");
  });
});

describe("pointPaneAt", () => {
  test("moves a pane's active tab to a dir with fresh one-entry history", () => {
    const dst = { cwd: "/boot", history: ["/boot", "/boot/stale"], histIdx: 1 };
    pointPaneAt(dst, "/current");
    expect(dst.cwd).toBe("/current");
    expect(dst.history).toEqual(["/current"]);
    expect(dst.histIdx).toBe(0);
  });
});

describe("active facade", () => {
  test("reads and writes follow the active pane", () => {
    const p = makePanePair({ cwd: "/a", n: 1 }, { cwd: "/b", n: 2 });
    const f = activeFacade(() => activeState(p));
    expect(f.cwd).toBe("/a");
    f.cwd = "/a2";
    expect(p.states[0].cwd).toBe("/a2");
    expect(p.states[1].cwd).toBe("/b");
    togglePane(p);
    expect(f.cwd).toBe("/b");
    expect(f.n).toBe(2);
  });

  test("methods are bound to the real target, not the facade", () => {
    const p = makePanePair(
      {
        v: 10,
        read(this: { v: number }) {
          return this.v;
        },
      },
      {
        v: 20,
        read(this: { v: number }) {
          return this.v;
        },
      },
    );
    const f = activeFacade(() => activeState(p));
    expect(f.read()).toBe(10);
    togglePane(p);
    expect(f.read()).toBe(20);
  });

  test("a method reference captured before a pane switch stays pane-live", () => {
    const p = makePanePair(
      {
        v: 10,
        read(this: { v: number }) {
          return this.v;
        },
      },
      {
        v: 20,
        read(this: { v: number }) {
          return this.v;
        },
      },
    );
    const f = activeFacade(() => activeState(p));
    // captured once at construction-time object build (bandCtx/menu/dnd)
    const read = f.read as () => number;
    expect(read()).toBe(10);
    togglePane(p);
    expect(read()).toBe(20);
  });

  test("overrides return a stable live value regardless of active pane", () => {
    const live = new Map<string, unknown>([["fixed", true]]);
    const p = makePanePair({ tile: new Map<string, unknown>() }, { tile: new Map<string, unknown>() });
    const f = activeFacade(() => activeState(p), { tile: live });
    expect(f.tile).toBe(live);
    togglePane(p);
    expect(f.tile).toBe(live);
  });
});

describe("active map facade", () => {
  test("forwards all map operations to the active pane's map", () => {
    const a = new Map<string, number>([["x", 1]]);
    const b = new Map<string, number>([["y", 2]]);
    const p = makePanePair(a, b);
    const f = activeMapFacade(() => activeState(p));
    expect(f.get("x")).toBe(1);
    expect(f.size).toBe(1);
    expect([...f.keys()]).toEqual(["x"]);
    f.set("z", 9);
    expect(a.get("z")).toBe(9);
    togglePane(p);
    expect(f.get("y")).toBe(2);
    expect(f.has("x")).toBe(false);
    expect([...f.keys()]).toEqual(["y"]);
  });

  test("forEach and iteration see the active pane after a switch", () => {
    const p = makePanePair(
      new Map([["a", 1]]),
      new Map([
        ["b", 2],
        ["c", 3],
      ]),
    );
    const f = activeMapFacade(() => activeState(p));
    const seen: string[] = [];
    f.forEach((_v, k) => {
      seen.push(k);
    });
    expect(seen).toEqual(["a"]);
    togglePane(p);
    seen.length = 0;
    f.forEach((_v, k) => {
      seen.push(k);
    });
    expect(seen).toEqual(["b", "c"]);
  });
});

describe("merged map facade", () => {
  test("get/has/size/iteration/forEach span every map", () => {
    const a = new Map<string, number>([["a", 1]]);
    const b = new Map<string, number>([
      ["b", 2],
      ["c", 3],
    ]);
    const f = mergedMapFacade(() => [a, b]);
    expect(f.get("a")).toBe(1);
    expect(f.get("c")).toBe(3);
    expect(f.get("missing")).toBeUndefined();
    expect(f.has("b")).toBe(true);
    expect(f.size).toBe(3);
    expect([...f.keys()].sort()).toEqual(["a", "b", "c"]);
    const seen: string[] = [];
    f.forEach((_v, k) => {
      seen.push(k);
    });
    expect(seen.sort()).toEqual(["a", "b", "c"]);
  });

  test("writes throw instead of silently eating (the old fall-through bug)", () => {
    const a = new Map<string, number>([["a", 1]]);
    const f = mergedMapFacade(() => [a]);
    // a write used to hit a throwaway Map and appear to succeed while
    // mutating nothing — it must fail loudly
    expect(() => f.set("b", 2)).toThrow("read-only");
    expect(() => f.delete("a")).toThrow("read-only");
    expect(() => f.clear()).toThrow("read-only");
  });
});

describe("makeLeafRegistry", () => {
  const fakePanes = () => {
    let ids = ["p0"];
    const listeners: Array<() => void> = [];
    return {
      panes: {
        leafIds: () => ids,
        onTreeChange: (cb: () => void) => {
          listeners.push(cb);
        },
      },
      set: (next: string[]) => {
        ids = next;
        for (const l of listeners) l();
      },
    };
  };

  test("builds one value per leaf, disposes dropped ones, keeps survivors", () => {
    const f = fakePanes();
    const made: string[] = [];
    const disposed: string[] = [];
    const m = makeLeafRegistry(
      f.panes,
      (id) => {
        made.push(id);
        return { id };
      },
      (_v, id) => disposed.push(id),
    );
    expect(made).toEqual(["p0"]);
    expect([...m.keys()]).toEqual(["p0"]);

    f.set(["p0", "p1"]);
    expect(made).toEqual(["p0", "p1"]);
    expect([...m.keys()]).toEqual(["p0", "p1"]);

    f.set(["p1"]);
    expect(disposed).toEqual(["p0"]);
    expect([...m.keys()]).toEqual(["p1"]);
  });

  test("a throwing dispose does not stop the sweep", () => {
    const f = fakePanes();
    const m = makeLeafRegistry(
      f.panes,
      (id) => ({ id }),
      () => {
        throw new Error("boom");
      },
    );
    expect(() => f.set(["p1"])).not.toThrow();
    expect([...m.keys()]).toEqual(["p1"]);
  });
});

describe("viewModeFor (per-pane view mode)", () => {
  const isTty = () => false;
  test("returns the pane's stored mode when set", () => {
    expect(viewModeFor({ viewMode: "list" }, "grid", isTty)).toBe("list");
    expect(viewModeFor({ viewMode: "columns" }, "grid", isTty)).toBe("columns");
  });

  test("falls back to the global default when the pane stores none", () => {
    expect(viewModeFor({}, "grid", isTty)).toBe("grid");
    expect(viewModeFor({}, "list", isTty)).toBe("list");
  });

  test("tty forces list off the grid (no icon tiles on the console)", () => {
    const tty = () => true;
    expect(viewModeFor({ viewMode: "grid" }, "grid", tty)).toBe("list");
    expect(viewModeFor({}, "grid", tty)).toBe("list");
    // list and columns are both text-cell layouts and survive the console
    expect(viewModeFor({ viewMode: "list" }, "grid", tty)).toBe("list");
    expect(viewModeFor({ viewMode: "columns" }, "grid", tty)).toBe("columns");
  });
});
