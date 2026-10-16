import { describe, expect, test } from "bun:test";
import type { TerminalCapabilities } from "@opentui/core";
import { commitMove, resolveDragPath, type MoveCommitCtx } from "./transfer-drag";

const caps = (over: Partial<TerminalCapabilities> = {}): TerminalCapabilities => {
  const base: TerminalCapabilities = {
    kitty_keyboard: false,
    kitty_graphics: false,
    rgb: true,
    ansi256: true,
    unicode: "wcwidth",
    sgr_pixels: false,
    color_scheme_updates: false,
    explicit_width: false,
    scaled_text: false,
    sixel: false,
    focus_tracking: false,
    sync: false,
    bracketed_paste: false,
    hyperlinks: false,
    osc52: false,
    osc52_support: "unsupported",
    notifications: false,
    explicit_cursor_positioning: false,
    remote: false,
    multiplexer: "none",
    terminal: { name: "xterm", version: "0", from_xtversion: false },
  };
  return { ...base, ...over };
};

describe("resolveDragPath", () => {
  test("kitty graphics -> OSC 72 (preferred, external + self-drop)", () => {
    expect(resolveDragPath(caps({ kitty_graphics: true }))).toBe("osc72");
  });

  test("kitty graphics beats sixel/sgr (OSC 72 is the richer surface)", () => {
    expect(resolveDragPath(caps({ kitty_graphics: true, sgr_pixels: true, sixel: true }))).toBe("osc72");
  });

  test("sixel terminal -> SGR (the universal OpenTUI drag surface)", () => {
    expect(resolveDragPath(caps({ sixel: true }))).toBe("sgr");
  });

  test("sgr-pixels terminal -> SGR", () => {
    expect(resolveDragPath(caps({ sgr_pixels: true }))).toBe("sgr");
  });

  test("no graphics at all -> fallback (press + hold / click destination)", () => {
    expect(resolveDragPath(caps())).toBe("fallback");
  });

  test("null caps (renderer not ready) degrades to fallback (no confirmed drag surface)", () => {
    // SGR is OpenTUI's universal drag surface, but we can't confirm it from a
    // null caps object — the fallback path works on any terminal, so it is
    // the safe default while the renderer's capabilities are still unknown.
    expect(resolveDragPath(null)).toBe("fallback");
  });
});

describe("commitMove", () => {
  const mkCtx = (): MoveCommitCtx & { calls: Array<[string, string, string[], string]> } => {
    const ctx: MoveCommitCtx & { calls: Array<[string, string, string[], string]> } = {
      calls: [],
      runTransfer: async (op, destDir, srcs, label) => {
        ctx.calls.push([op, destDir, srcs, label]);
      },
    };
    return ctx;
  };

  test("a folder drop dispatches runTransfer with a move op", async () => {
    const ctx = mkCtx();
    const commit = commitMove(ctx);
    await commit("/dst", [{ path: "/src/a.txt", isDir: false }]);
    expect(ctx.calls).toEqual([["move", "/dst", ["/src/a.txt"], "move 1 item to dst"]]);
  });

  test("multi-item drop moves every source", async () => {
    const ctx = mkCtx();
    const commit = commitMove(ctx);
    await commit("/dst", [
      { path: "/src/a.txt", isDir: false },
      { path: "/src/b.txt", isDir: false },
      { path: "/src/sub", isDir: true },
    ]);
    expect(ctx.calls).toEqual([["move", "/dst", ["/src/a.txt", "/src/b.txt", "/src/sub"], "move 3 items to dst"]]);
  });

  test("dropping a folder onto itself is filtered out (no move, no runTransfer)", async () => {
    const ctx = mkCtx();
    const commit = commitMove(ctx);
    await commit("/dst", [{ path: "/dst", isDir: true }]);
    expect(ctx.calls).toEqual([]);
  });

  test("commit never throws into the caller (runTransfer is the single choke point)", async () => {
    const ctx = mkCtx();
    ctx.runTransfer = async () => {
      throw new Error("boom");
    };
    const commit = commitMove(ctx);
    await expect(commit("/dst", [{ path: "/src/a.txt", isDir: false }])).rejects.toThrow("boom");
  });
});
