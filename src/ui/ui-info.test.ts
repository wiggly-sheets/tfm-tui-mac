import { describe, expect, test } from "bun:test";
import { makeInfoSidebar } from "./ui-info";
import type { Scheduler } from "../lib/uiutil";

// Manual clock: debounced clears its pending handle, so a coalescing test can
// assert "N calls, one render" by flushing only what is still queued.
const mkClock = (): { sched: Scheduler; flush: () => void } => {
  let seq = 0;
  const timers = new Map<number, () => void>();
  return {
    sched: {
      setTimeout: (cb) => {
        const id = ++seq;
        timers.set(id, cb);
        return id;
      },
      clearTimeout: (h) => {
        timers.delete(h as number);
      },
    },
    flush: () => {
      const cbs = [...timers.values()];
      timers.clear();
      for (const cb of cbs) cb();
    },
  };
};

const mkPane = () => {
  const kids: any[] = [];
  return {
    node: {
      getChildren: () => kids,
      remove: (c: any) => {
        const i = kids.indexOf(c);
        if (i >= 0) kids.splice(i, 1);
      },
      add: (c: any) => {
        kids.push(c);
      },
    },
    childCount: () => kids.length,
  };
};

const COLORS: any = { sidebarFgMuted: "#666", white: "#fff" };

const mkInfo = (opts: { visible: boolean; clock: ReturnType<typeof mkClock>; pane: ReturnType<typeof mkPane> }) =>
  makeInfoSidebar({
    byId: () => opts.pane.node as any,
    colors: () => COLORS,
    infoEnabled: () => true,
    infoWidth: () => 40,
    home: "/home",
    focusKey: () => null,
    tileRefs: new Map(),
    sched: opts.clock.sched,
    infoVisible: () => opts.visible,
  });

describe("info visibility guard", () => {
  test("rebuilds nothing while the pane is hidden/collapsed", () => {
    const clock = mkClock();
    const pane = mkPane();
    const info = mkInfo({ visible: false, clock, pane });
    info.renderInfo();
    clock.flush();
    expect(pane.childCount()).toBe(0);
  });

  test("renders the no-selection state when visible", () => {
    const clock = mkClock();
    const pane = mkPane();
    const info = mkInfo({ visible: true, clock, pane });
    info.renderInfo();
    clock.flush();
    expect(pane.childCount()).toBeGreaterThan(0);
  });

  test("coalesces a burst into a single rebuild", () => {
    const clock = mkClock();
    const pane = mkPane();
    const info = mkInfo({ visible: true, clock, pane });
    for (let i = 0; i < 5; i++) info.renderInfo();
    clock.flush();
    expect(pane.childCount()).toBe(1); // one "no selection" Text, exactly once
  });

  test("absent infoVisible gate is treated as visible (test fakes stay light)", () => {
    const clock = mkClock();
    const pane = mkPane();
    const info = makeInfoSidebar({
      byId: () => pane.node as any,
      colors: () => COLORS,
      infoEnabled: () => true,
      infoWidth: () => 40,
      home: "/home",
      focusKey: () => null,
      tileRefs: new Map(),
      sched: clock.sched,
    });
    info.renderInfo();
    clock.flush();
    expect(pane.childCount()).toBeGreaterThan(0);
  });
});
