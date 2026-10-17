import { describe, expect, test } from "bun:test";
import { parseDepsArgs, runDepsCli } from "./deps-cli";

describe("parseDepsArgs", () => {
  test("defaults to list", () => {
    expect(parseDepsArgs([])).toEqual({ cmd: "list", targets: [], error: null });
    expect(parseDepsArgs(["list"])).toEqual({ cmd: "list", targets: [], error: null });
    expect(parseDepsArgs(["ls"])).toEqual({ cmd: "list", targets: [], error: null });
  });

  test("help recognized", () => {
    expect(parseDepsArgs(["help"]).cmd).toBe("help");
    expect(parseDepsArgs(["--help"]).cmd).toBe("help");
    expect(parseDepsArgs(["-h"]).cmd).toBe("help");
  });

  test("check recognized", () => {
    expect(parseDepsArgs(["check"])).toEqual({ cmd: "check", targets: [], error: null });
  });

  test("install recognized with targets", () => {
    expect(parseDepsArgs(["install", "fd", "ffmpeg"])).toEqual({
      cmd: "install",
      targets: ["fd", "ffmpeg"],
      error: null,
    });
    expect(parseDepsArgs(["i", "7z"])).toEqual({
      cmd: "install",
      targets: ["7z"],
      error: null,
    });
  });

  test("install --help falls through to help", () => {
    expect(parseDepsArgs(["install", "--help"])).toEqual({ cmd: "help", targets: [], error: null });
    expect(parseDepsArgs(["install", "-h"])).toEqual({ cmd: "help", targets: [], error: null });
  });

  test("unknown subcommand", () => {
    const res = parseDepsArgs(["foobar"]);
    expect(res.cmd).toBe("help");
    expect(res.error).toContain("unknown deps subcommand");
  });
});

describe("runDepsCli", () => {
  test("list prints package status", async () => {
    const lines: string[] = [];
    const which = (b: string) => (b === "brew" || b === "rg" ? `/bin/${b}` : null);
    const code = await runDepsCli(["list"], {
      which,
      platform: "darwin",
      out: (s) => lines.push(s),
    });
    expect(code).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("Package Manager: Homebrew");
    expect(output).toContain("ripgrep");
    expect(output).toContain("[installed] (rg)");
    expect(output).toContain("ImageMagick");
    expect(output).toContain("[missing]");
  });

  test("check returns 0 when all installed", async () => {
    const which = (_b: string) => "/bin/mock";
    const out: string[] = [];
    const code = await runDepsCli(["check"], {
      which,
      platform: "darwin",
      out: (s) => out.push(s),
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("All optional dependencies are installed.");
  });

  test("check returns 1 when any missing", async () => {
    const which = (b: string) => (b === "brew" ? "/bin/brew" : null);
    const err: string[] = [];
    const code = await runDepsCli(["check"], {
      which,
      platform: "darwin",
      err: (s) => err.push(s),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/Missing \d+ optional dependencies/);
  });

  test("install executes plan command", async () => {
    const executed: Array<{ bin: string; args: string[] }> = [];
    const which = (b: string) => (b === "brew" ? "/bin/brew" : null);
    const code = await runDepsCli(["install", "fd"], {
      which,
      platform: "darwin",
      exec: async (bin, args) => {
        executed.push({ bin, args });
        return { status: 0 };
      },
    });
    expect(code).toBe(0);
    expect(executed).toEqual([{ bin: "brew", args: ["install", "fd"] }]);
  });

  test("install elevates with sudo on linux if required", async () => {
    const executed: Array<{ bin: string; args: string[] }> = [];
    const which = (b: string) => (b === "apt-get" || b === "sudo" ? `/usr/bin/${b}` : null);
    const code = await runDepsCli(["install", "ripgrep"], {
      which,
      platform: "linux",
      exec: async (bin, args) => {
        executed.push({ bin, args });
        return { status: 0 };
      },
    });
    expect(code).toBe(0);
    expect(executed).toEqual([{ bin: "sudo", args: ["apt-get", "install", "-y", "ripgrep"] }]);
  });
});
