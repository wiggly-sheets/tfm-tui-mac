import { describe, expect, jest, test } from "bun:test";
import { nativeMemLine, startMemHygiene } from "./mem-hygiene";

describe("nativeMemLine", () => {
  test("formats allocator stats + rss", () => {
    const line = nativeMemLine({ activeAllocations: 1234, totalRequestedBytes: 52 * 1048576 });
    expect(line).toContain("native active=1234");
    expect(line).toContain("mem=52.0MB");
    expect(line).toContain("rss=");
  });

  test("n/a when the private stats call is unavailable", () => {
    const line = nativeMemLine(null);
    expect(line).toContain("n/a");
    expect(line).toContain("rss=");
  });
});

describe("startMemHygiene", () => {
  test("heartbeats on the interval and stop() ends it", () => {
    jest.useFakeTimers();
    try {
      const lines: string[] = [];
      let statsReads = 0;
      const stop = startMemHygiene({
        allocatorStats: () => {
          statsReads++;
          return { activeAllocations: 7, totalRequestedBytes: 0 };
        },
        debugLog: (msg) => lines.push(msg),
        poke: () => {},
        intervalMs: 1000,
      });
      jest.advanceTimersByTime(3000);
      stop();
      const afterStop = lines.length;
      jest.advanceTimersByTime(4000);
      expect(statsReads).toBe(3);
      expect(lines.length).toBe(afterStop);
      expect(lines[0]).toMatch(/^mem native active=7/);
    } finally {
      jest.useRealTimers();
    }
  });

  test("gc poke is growth-gated: a flat allocator is not collected every tick", () => {
    jest.useFakeTimers();
    try {
      let pokes = 0;
      let active = 5;
      const stop = startMemHygiene({
        allocatorStats: () => ({ activeAllocations: active, totalRequestedBytes: 0 }),
        poke: () => {
          pokes++;
        },
        intervalMs: 1000,
      });
      jest.advanceTimersByTime(3000);
      // first tick establishes the baseline (pokes), the rest see no growth
      expect(pokes).toBe(1);
      const before = pokes;
      active = 9; // native churn outran the finalizers
      jest.advanceTimersByTime(1000);
      stop();
      expect(pokes).toBe(before + 1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("unavailable allocator stats keep the unconditional poke (pressure guard)", () => {
    jest.useFakeTimers();
    try {
      let pokes = 0;
      const stop = startMemHygiene({
        allocatorStats: () => null,
        poke: () => {
          pokes++;
        },
        intervalMs: 1000,
      });
      jest.advanceTimersByTime(3000);
      stop();
      expect(pokes).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });
});
