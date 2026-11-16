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
  let adds = 0;
  return {
    node: {
      getChildren: () => kids,
      remove: (c: any) => {
        const i = kids.indexOf(c);
        if (i >= 0) kids.splice(i, 1);
      },
      add: (c: any) => {
        adds++;
        kids.push(c);
      },
    },
    childCount: () => kids.length,
    addCount: () => adds,
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

  test("a burst of visible renders paints the no-selection state exactly once", () => {
    const clock = mkClock();
    const pane = mkPane();
    const info = mkInfo({ visible: true, clock, pane });
    for (let i = 0; i < 5; i++) info.renderInfo();
    clock.flush();
    expect(pane.addCount()).toBe(1); // debounced: one paint, not five
    expect(pane.childCount()).toBe(1); // one "no selection" Text
  });

  test("an absent infoVisible gate is treated as visible", () => {
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
    expect(pane.addCount()).toBe(1);
  });
});
