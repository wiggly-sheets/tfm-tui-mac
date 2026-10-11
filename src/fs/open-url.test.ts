import { describe, expect, test } from "bun:test";
import { makeUrlOpener } from "./open-url";
import { writeFileSync } from "node:fs";

describe("makeUrlOpener", () => {
  test("opens the URL through xdg-open, silently on success", () => {
    const spawns: Array<{ cmd: string; args: string[] }> = [];
    const notifies: unknown[][] = [];
    const { openUrl } = makeUrlOpener({
      spawn: ((cmd: string, args: string[], _opts: unknown, _fail?: (err: Error) => void) => {
        spawns.push({ cmd, args });
        return { unref: () => {} };
      }) as never,
      notify: ((...a: unknown[]) => void notifies.push(a)) as never,
      platform: "linux",
    });
    openUrl("https://opentui.com");
    expect(spawns).toEqual([{ cmd: "xdg-open", args: ["https://opentui.com"] }]);
    expect(notifies).toEqual([]);
  });

  test("a spawn failure toasts instead of killing the TUI", () => {
    const fails: Array<(err: Error) => void> = [];
    const notifies: Array<[string, string?, string?]> = [];
    const { openUrl } = makeUrlOpener({
      spawn: ((_c: string, _a: string[], _o: unknown, fail?: (err: Error) => void) => {
        if (fail) fails.push(fail);
        return { unref: () => {} };
      }) as never,
      notify: ((msg: string, title?: string, level?: string) => void notifies.push([msg, title, level])) as never,
      platform: "linux",
    });
    openUrl("https://bun.sh");
    expect(fails.length).toBe(1);
    fails[0]?.(new Error("spawn xdg-open ENOENT"));
    expect(notifies.length).toBe(1);
    expect(notifies[0]?.[0]).toContain("https://bun.sh");
    expect(notifies[0]?.[2]).toBe("error");
  });

  test("a synchronous spawn throw degrades to a toast too", () => {
    const notifies: unknown[][] = [];
    const { openUrl } = makeUrlOpener({
      spawn: (() => {
        throw new Error("spawnSync-style ENOENT");
      }) as never,
      notify: ((...a: unknown[]) => void notifies.push(a)) as never,
      platform: "linux",
    });
    expect(() => openUrl("https://example.com")).not.toThrow();
    expect(notifies.length).toBe(1);
  });

  test("darwin opens through `open`, reveals with -R, and falls back to osascript", () => {
    const spawns: Array<{ cmd: string; args: string[] }> = [];
    const fails: Array<(err: Error) => void> = [];
    const notifies: unknown[][] = [];
    // create a temp file for reveal test
    const revealFile = `/tmp/tfm-reveal-test-${Date.now()}.txt`;
    writeFileSync(revealFile, "test");
    const { openUrl, revealPath } = makeUrlOpener({
      spawn: ((cmd: string, args: string[], _o: unknown, fail?: (err: Error) => void) => {
        spawns.push({ cmd, args });
        if (fail) fails.push(fail);
        return { unref: () => {} };
      }) as never,
      notify: ((...a: unknown[]) => void notifies.push(a)) as never,
      platform: "darwin",
    });
    openUrl("https://opentui.com");
    expect(spawns).toEqual([{ cmd: "open", args: ["https://opentui.com"] }]);
    revealPath(revealFile);
    expect(spawns[1]).toEqual({ cmd: "open", args: ["-R", revealFile] });
    // `open` failing routes one osascript Finder fallback before any toast
    fails[0]?.(new Error("spawn open ENOENT"));
    expect(spawns[2]?.cmd).toBe("/usr/bin/osascript");
    expect(notifies).toEqual([]);
  });
});
