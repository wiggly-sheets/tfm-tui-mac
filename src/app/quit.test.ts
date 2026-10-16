import { describe, expect, test } from "bun:test";
import { makeQuit, resolveExitCwd, type QuitCtx } from "./quit";

const mkCtx = (
  calls: string[],
  fail?: "drops" | "release" | "destroy" | "session" | "terminal" | "gpm" | "onQuit",
): QuitCtx & { codes: number[] } => {
  const codes: number[] = [];
  return {
    codes,
    disableDrops: () => {
      calls.push("drops");
      if (fail === "drops") throw new Error("osc write failed");
    },
    releaseShiftCapture: () => {
      calls.push("release");
      if (fail === "release") throw new Error("stdout closed");
    },
    flushSession: () => {
      calls.push("session");
      if (fail === "session") throw new Error("journal write failed");
    },
    closeTerminal: () => {
      calls.push("terminal");
      if (fail === "terminal") throw new Error("pty close failed");
    },
    stopGpm: () => {
      calls.push("gpm");
      if (fail === "gpm") throw new Error("gpm close failed");
    },
    stopChromeTimers: () => {
      calls.push("chrome");
    },
    onQuit: () => {
      calls.push("onQuit");
      if (fail === "onQuit") throw new Error("plugin deactivate failed");
    },
    destroy: () => {
      calls.push("destroy");
      if (fail === "destroy") throw new Error("renderer gone");
    },
    exit: (code) => {
      calls.push(`exit:${code}`);
      codes.push(code);
    },
  };
};

describe("resolveExitCwd", () => {
  test("default hands back the launch directory", () => {
    expect(resolveExitCwd("default", "/browsed", "/launched", false)).toBe("/launched");
  });

  test("active-pane hands back the active pane's directory", () => {
    expect(resolveExitCwd("active-pane", "/browsed", "/launched", false)).toBe("/browsed");
  });

  test("a virtual place (recent://) is not cd-able — falls back to the launch dir", () => {
    expect(resolveExitCwd("active-pane", "recent://", "/launched", true)).toBe("/launched");
  });
});

describe("makeQuit", () => {
  test("teardown order: drops -> release -> session -> terminal -> gpm -> chrome -> onQuit -> destroy -> exit(0)", () => {
    const calls: string[] = [];
    makeQuit(mkCtx(calls))();
    expect(calls).toEqual(["drops", "release", "session", "terminal", "gpm", "chrome", "onQuit", "destroy", "exit:0"]);
  });

  test("a throwing disableDrops still completes teardown and exits 1", () => {
    const calls: string[] = [];
    makeQuit(mkCtx(calls, "drops"))();
    expect(calls).toEqual(["drops", "release", "session", "terminal", "gpm", "chrome", "onQuit", "destroy", "exit:1"]);
  });

  test("a throwing shift-release still completes teardown and exits 1", () => {
    const calls: string[] = [];
    makeQuit(mkCtx(calls, "release"))();
    expect(calls).toEqual(["drops", "release", "session", "terminal", "gpm", "chrome", "onQuit", "destroy", "exit:1"]);
  });

  test("a throwing renderer destroy still exits 1", () => {
    const calls: string[] = [];
    makeQuit(mkCtx(calls, "destroy"))();
    expect(calls).toEqual(["drops", "release", "session", "terminal", "gpm", "chrome", "onQuit", "destroy", "exit:1"]);
  });

  test("refuses to quit while file ops are in flight (no teardown, no exit)", () => {
    const calls: string[] = [];
    const ctx = mkCtx(calls);
    let busied = 0;
    const busyCtx: QuitCtx & { codes: number[] } = {
      ...ctx,
      codes: ctx.codes,
      isBusy: () => true,
      onBusy: () => {
        busied++;
      },
    };
    makeQuit(busyCtx)();
    expect(calls).toEqual([]);
    expect(busied).toBe(1);
  });

  test("exit code is 0 clean, 1 when any teardown step threw", () => {
    const okCalls: string[] = [];
    const okCtx = mkCtx(okCalls);
    makeQuit(okCtx)();
    expect(okCtx.codes).toEqual([0]);
    for (const fail of ["drops", "release", "destroy", "session", "terminal", "gpm", "onQuit"] as const) {
      const calls: string[] = [];
      const ctx = mkCtx(calls, fail);
      makeQuit(ctx)();
      expect(ctx.codes).toEqual([1]);
    }
  });

  test("writeCwdFile runs before destroy and is best-effort", () => {
    const calls: string[] = [];
    const ctx = mkCtx(calls);
    const withCwd: QuitCtx & { codes: number[] } = {
      ...ctx,
      writeCwdFile: () => {
        calls.push("cwd");
      },
    };
    makeQuit(withCwd)();
    expect(calls).toEqual([
      "drops",
      "release",
      "session",
      "cwd",
      "terminal",
      "gpm",
      "chrome",
      "onQuit",
      "destroy",
      "exit:0",
    ]);

    const throwCalls: string[] = [];
    const throwCtx = mkCtx(throwCalls);
    const throwing: QuitCtx & { codes: number[] } = {
      ...throwCtx,
      writeCwdFile: () => {
        throwCalls.push("cwd");
        throw new Error("read-only $TFM_CWD_FILE");
      },
    };
    makeQuit(throwing)();
    // the failure is reported in the exit code but never strands the teardown
    expect(throwCalls).toContain("exit:1");
  });
});
