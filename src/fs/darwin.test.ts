// Darwin branch pins: every pure helper in ./darwin runs here on Linux CI
// via platform mock, so the macOS lanes are covered without a mac runner.
import { describe, expect, test } from "bun:test";
import {
  applescriptString,
  copyXattrs,
  darwinMountEntries,
  darwinTrashMove,
  darwinVolumeTrash,
  defaultShell,
  diskutilEjectArgv,
  diskutilMountArgv,
  diskutilUnmountArgv,
  fdBinary,
  finderDeleteArgs,
  finderOpenArgs,
  findTrashedPath,
  hasFinderFileRefs,
  isDarwin,
  jxaTrashArgs,
  MACOS_FFMPEG_SIDECARS,
  mdlsTagsArgs,
  openerBin,
  parseDiskutilListPlist,
  parseMdlsTags,
  parseMountTable,
  parseSmbMounts,
  pbpasteFileUrlArgs,
  posixPathOfClipboardArgs,
  qlmanageThumbArgs,
  readFinderTags,
  sipsThumbArgs,
  syncStarTag,
  tagAddArgs,
  tagRemoveArgs,
  tagSetArgs,
  trashCliArgs,
  TRASH_CLI,
  writeFinderTags,
  XATTR_CLI,
  xattrListArgs,
  xattrReadArgs,
  xattrWriteArgs,
  type XattrRun,
} from "./darwin";

describe("isDarwin / openerBin", () => {
  test("gates on the platform string, defaulting to live", () => {
    expect(isDarwin("darwin")).toBe(true);
    expect(isDarwin("linux")).toBe(false);
    expect(isDarwin()).toBe(process.platform === "darwin");
    expect(openerBin("darwin")).toBe("open");
    expect(openerBin("linux")).toBe("xdg-open");
  });
});

describe("osascript builders", () => {
  test("AppleScript string escapes backslash and quote", () => {
    expect(applescriptString('/a"b\\c')).toBe('"/a\\"b\\\\c"');
  });
  test("Finder open targets the POSIX file", () => {
    expect(finderOpenArgs("/tmp/a b.txt")).toEqual([
      "-e",
      'tell application "Finder" to open POSIX file "/tmp/a b.txt"',
    ]);
  });
});

describe("trash lanes", () => {
  test("trash CLI is the absolute /usr/bin path", () => {
    expect(TRASH_CLI).toBe("/usr/bin/trash");
    expect(trashCliArgs("/a/b.txt")).toEqual(["/a/b.txt"]);
  });
  test("JXA lane drives NSFileManager, Finder lane deletes", () => {
    const jxa = jxaTrashArgs("/a/b.txt");
    expect(jxa.slice(0, 2)).toEqual(["-l", "JavaScript"]);
    expect(jxa[3]).toContain("trashItemAtURL");
    expect(jxa[3]).toContain("/a/b.txt");
    expect(finderDeleteArgs("/a/b.txt")).toEqual(["-e", 'tell application "Finder" to delete POSIX file "/a/b.txt"']);
  });
});

describe("findTrashedPath", () => {
  test("direct hit wins without listing", () => {
    let listed = false;
    const hit = findTrashedPath(
      "/T",
      "a.txt",
      () => true,
      () => {
        listed = true;
        return [];
      },
    );
    expect(hit).toBe("/T/a.txt");
    expect(listed).toBe(false);
  });
  test("collision rename resolves to the newest prefixed sibling", () => {
    const names = ["a.txt 12-04-44-650.txt", "a.txt 12-05-00-000.txt", "other.txt"];
    const mtime = (p: string): number | null => (p.endsWith("12-05-00-000.txt") ? 200 : 100);
    expect(
      findTrashedPath(
        "/T",
        "a.txt",
        () => false,
        () => names,
        mtime,
      ),
    ).toBe("/T/a.txt 12-05-00-000.txt");
  });
  test("no match yields null (caller guesses home)", () => {
    expect(
      findTrashedPath(
        "/T",
        "a.txt",
        () => false,
        () => ["b.txt"],
      ),
    ).toBeNull();
  });
});

describe("darwinTrashMove", () => {
  test("trash CLI first, resolves the landing", async () => {
    const calls: string[][] = [];
    const loc = await darwinTrashMove(
      "/src/a.txt",
      async (bin, args) => {
        calls.push([bin, ...args]);
        return { code: 0 };
      },
      { trashRoots: ["/T"], exists: (p) => p === "/T/a.txt" },
    );
    expect(calls[0]).toEqual(["/usr/bin/trash", "/src/a.txt"]);
    expect(loc).toBe("/T/a.txt");
  });
  test("falls through JXA to Finder delete, then throws (never rm)", async () => {
    const calls: string[] = [];
    const run = async (bin: string, _args: string[]): Promise<{ code: number }> => {
      calls.push(bin);
      return bin === "/usr/bin/osascript" && calls.filter((c) => c === bin).length === 2 ? { code: 0 } : { code: 1 };
    };
    const loc = await darwinTrashMove("/src/a.txt", run, {
      trashRoots: ["/T"],
      exists: () => true,
    });
    expect(calls).toEqual(["/usr/bin/trash", "/usr/bin/osascript", "/usr/bin/osascript"]);
    expect(loc).toBe("/T/a.txt");
    await expect(darwinTrashMove("/src/a.txt", async () => ({ code: 1 }))).rejects.toThrow("trash failed");
  });
  test("volume trash root shape", () => {
    expect(darwinVolumeTrash("/Volumes/USB", 501)).toBe("/Volumes/USB/.Trashes/501");
  });
});

describe("mount parsing", () => {
  const MOUNT = [
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
    "devfs on /dev (devfs, local, nobrowse)",
    "/dev/disk7s1 on /Volumes/Crucial X9 (apfs, local, journaled)",
    "//ZEB@nas/share on /Volumes/share (smbfs, nobrowse)",
    "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
  ].join("\n");
  test("parseMountTable keeps targets with spaces, drops garbage", () => {
    const rows = parseMountTable(`${MOUNT}\nnot a mount line\n`);
    expect(rows).toHaveLength(5);
    expect(rows[2]).toEqual({ device: "/dev/disk7s1", target: "/Volumes/Crucial X9", fstype: "apfs" });
    expect(rows[3]).toEqual({ device: "//ZEB@nas/share", target: "/Volumes/share", fstype: "smbfs" });
  });
  test("parseDiskutilListPlist pairs DeviceIdentifier/MountPoint/VolumeName", () => {
    const xml = `<dict>
      <key>DeviceIdentifier</key><string>disk7s1</string>
      <key>MountPoint</key><string>/Volumes/Crucial X9</string>
      <key>VolumeName</key><string>Crucial X9</string>
    </dict><dict>
      <key>DeviceIdentifier</key><string>disk3s1</string>
      <key>VolumeName</key><string>NoMount</string>
    </dict>`;
    expect(parseDiskutilListPlist(xml)).toEqual([
      { device: "/dev/disk7s1", mountPoint: "/Volumes/Crucial X9", volumeName: "Crucial X9" },
    ]);
  });
  test("darwinMountEntries prefers diskutil labels, skips system/autofs/smbfs", () => {
    const entries = darwinMountEntries(
      [{ device: "/dev/disk7s1", mountPoint: "/Volumes/Crucial X9", volumeName: "Crucial X9" }],
      parseMountTable(MOUNT),
    );
    const usb = entries.find((e) => e.target === "/Volumes/Crucial X9");
    expect(usb).toMatchObject({ label: "Crucial X9", removable: true, device: "/dev/disk7s1" });
    // smb share is a network mount (sidebar Network owns it), never Devices
    expect(entries.some((e) => e.target === "/Volumes/share")).toBe(false);
    expect(entries.some((e) => e.target === "/" || e.target.startsWith("/System/"))).toBe(false);
    // mount-table-only target degrades to its basename
    expect(entries.some((e) => e.target === "/dev")).toBe(false);
  });
  test("diskutil argv shapes", () => {
    expect(diskutilMountArgv("/dev/disk7")).toEqual(["mountDisk", "/dev/disk7"]);
    expect(diskutilUnmountArgv("/Volumes/X")).toEqual(["unmount", "/Volumes/X"]);
    expect(diskutilEjectArgv("/dev/disk7")).toEqual(["eject", "/dev/disk7"]);
  });
});

describe("parseSmbMounts", () => {
  test("user@host/share splits into uri + label", () => {
    const out = parseSmbMounts(parseMountTable("//ZEB@nas/share on /Volumes/share (smbfs, nobrowse)"));
    expect(out).toEqual([{ target: "/Volumes/share", uri: "smb://nas/share", label: "nas/share" }]);
  });
  test("guest and host-only forms degrade honestly", () => {
    expect(parseSmbMounts(parseMountTable("//nas/share on /V/s (smbfs, x)"))[0]?.uri).toBe("smb://nas/share");
    expect(parseSmbMounts(parseMountTable("//nas on /V/n (smbfs, x)"))[0]?.uri).toBe("smb://nas/");
    // non-smb rows never list
    expect(parseSmbMounts(parseMountTable("/dev/d1 on /Volumes/U (apfs, x)"))).toEqual([]);
  });
});

describe("clipboard", () => {
  test("furl detect is case-insensitive, readers target POSIX/file-url", () => {
    expect(hasFinderFileRefs("«class furl», 30")).toBe(true);
    expect(hasFinderFileRefs("FURL, 10")).toBe(true);
    expect(hasFinderFileRefs("string, 12")).toBe(false);
    expect(posixPathOfClipboardArgs()).toEqual(["-e", "POSIX path of (the clipboard)"]);
    expect(pbpasteFileUrlArgs()).toEqual(["-Prefer", "public.file-url"]);
  });
});

describe("parseMdlsTags", () => {
  test("parens list splits on commas, (null) is empty", () => {
    expect(parseMdlsTags("(\n Red,\n Starred\n)")).toEqual(["Red", "Starred"]);
    expect(parseMdlsTags("(null)")).toEqual([]);
    expect(parseMdlsTags("")).toEqual([]);
  });
});

describe("fdBinary / defaultShell", () => {
  test("darwin takes brew fd only, linux keeps the fdfind fallback", () => {
    const which = (bin: string): string | null => (bin === "fdfind" ? "/usr/bin/fdfind" : null);
    expect(fdBinary(which, "darwin")).toBeNull();
    expect(fdBinary(which, "linux")).toBe("/usr/bin/fdfind");
    expect(fdBinary((b) => (b === "fd" ? "/opt/homebrew/bin/fd" : null), "darwin")).toBe("/opt/homebrew/bin/fd");
  });
  test("defaultShell honors $SHELL, else zsh on darwin and bash on linux", () => {
    const prev = process.env.SHELL;
    delete process.env.SHELL;
    try {
      expect(defaultShell("darwin")).toBe("/bin/zsh");
      expect(defaultShell("linux")).toBe("/bin/bash");
    } finally {
      if (prev === undefined) delete process.env.SHELL;
      else process.env.SHELL = prev;
    }
  });
});

describe("thumbnail argv", () => {
  test("sips caps the long side, qlmanage writes into the out dir", () => {
    expect(sipsThumbArgs("/a/b.jpg", "/tmp/o.png", 128)).toEqual([
      "-Z",
      "128",
      "-s",
      "format",
      "png",
      "/a/b.jpg",
      "--out",
      "/tmp/o.png",
    ]);
    expect(qlmanageThumbArgs(512, "/tmp/q", "/a/b.mp4")).toEqual(["-t", "-s", "512", "-o", "/tmp/q", "/a/b.mp4"]);
  });
  test("mac sidecar names probe the arch build first", () => {
    expect(MACOS_FFMPEG_SIDECARS[0]).toBe("tfm-ffmpeg-macos-arm64");
    expect(MACOS_FFMPEG_SIDECARS).toContain("tfm-ffmpeg-macos-arm64");
  });
});

describe("syncStarTag", () => {
  test("no `tag` CLI: never touches the Finder tags attribute", () => {
    const calls: Array<[string, string[]]> = [];
    const deps = { which: () => null, exec: (bin: string, args: string[]) => void calls.push([bin, args]) };
    syncStarTag(deps, true, "/x/f.txt");
    syncStarTag(deps, false, "/x/f.txt");
    expect(calls).toEqual([]);
  });

  test("`tag` CLI present: add/remove Starred through it only", () => {
    const calls: Array<[string, string[]]> = [];
    const deps = {
      which: () => "/opt/homebrew/bin/tag",
      exec: (bin: string, args: string[]) => void calls.push([bin, args]),
    };
    syncStarTag(deps, true, "/x/f.txt");
    syncStarTag(deps, false, "/x/f.txt");
    expect(calls).toEqual([
      ["/opt/homebrew/bin/tag", ["-a", "Starred", "/x/f.txt"]],
      ["/opt/homebrew/bin/tag", ["-r", "Starred", "/x/f.txt"]],
    ]);
  });
});

describe("finder tags (read + write)", () => {
  test("argv builders keep the path as its own argument (spaces safe)", () => {
    expect(mdlsTagsArgs("/a b.txt")).toEqual(["-raw", "-name", "kMDItemUserTags", "/a b.txt"]);
    expect(tagAddArgs("Red", "/a b.txt")).toEqual(["-a", "Red", "/a b.txt"]);
    expect(tagRemoveArgs("Red", "/a b.txt")).toEqual(["-r", "Red", "/a b.txt"]);
    expect(tagSetArgs(["Red", "Blue"], "/a b.txt")).toEqual(["-s", "Red,Blue", "/a b.txt"]);
  });

  test("readFinderTags parses mdls output; off darwin never spawns", async () => {
    const calls: string[][] = [];
    const run = async (_bin: string, args: string[]): Promise<{ stdout: string }> => {
      calls.push(args);
      return { stdout: "(\n Red,\n Starred\n)" };
    };
    expect(await readFinderTags({ run, platform: "linux" }, "/x")).toEqual([]);
    expect(calls).toEqual([]);
    expect(await readFinderTags({ run, platform: "darwin" }, "/x")).toEqual(["Red", "Starred"]);
    expect(calls).toEqual([["-raw", "-name", "kMDItemUserTags", "/x"]]);
  });

  test("readFinderTags swallows a spawn failure to empty", async () => {
    const run = async (): Promise<{ stdout: string }> => {
      throw new Error("mdls failed");
    };
    await expect(readFinderTags({ run, platform: "darwin" }, "/x")).resolves.toEqual([]);
  });

  test("writeFinderTags: no CLI or off darwin is a silent no-op", () => {
    const calls: Array<[string, string[]]> = [];
    const deps = { which: () => null, exec: (b: string, a: string[]) => void calls.push([b, a]) };
    writeFinderTags({ ...deps, platform: "darwin" }, [["-a", "Red", "/x"]]);
    writeFinderTags({ which: () => "/opt/homebrew/bin/tag", exec: deps.exec, platform: "linux" }, [
      ["-a", "Red", "/x"],
    ]);
    expect(calls).toEqual([]);
  });

  test("writeFinderTags applies one argv per target through the CLI", () => {
    const calls: Array<[string, string[]]> = [];
    const deps = {
      which: () => "/opt/homebrew/bin/tag",
      exec: (b: string, a: string[]) => void calls.push([b, a]),
      platform: "darwin",
    };
    writeFinderTags(deps, [tagAddArgs("Red", "/x/a"), tagAddArgs("Red", "/x/b")]);
    expect(calls).toEqual([
      ["/opt/homebrew/bin/tag", ["-a", "Red", "/x/a"]],
      ["/opt/homebrew/bin/tag", ["-a", "Red", "/x/b"]],
    ]);
  });
});

describe("copyXattrs", () => {
  test("argv round-trips binary values as hex", () => {
    expect(XATTR_CLI).toBe("/usr/bin/xattr");
    expect(xattrListArgs("/s")).toEqual(["/s"]);
    expect(xattrReadArgs("com.apple.quarantine", "/s")).toEqual(["-p", "-x", "com.apple.quarantine", "/s"]);
    expect(xattrWriteArgs("com.apple.quarantine", "3030", "/d")).toEqual([
      "-w",
      "-x",
      "com.apple.quarantine",
      "3030",
      "/d",
    ]);
  });

  test("non-darwin: no calls at all", async () => {
    const calls: string[][] = [];
    const run: XattrRun = async (_bin, args) => {
      calls.push(args);
      return { stdout: "", code: 0 };
    };
    await copyXattrs("/s", "/d", { platform: "linux", run });
    expect(calls).toEqual([]);
  });

  test("source with no xattrs: list only, zero writes", async () => {
    const calls: string[][] = [];
    const run: XattrRun = async (_bin, args) => {
      calls.push(args);
      return { stdout: "", code: 0 };
    };
    await copyXattrs("/s", "/d", { platform: "darwin", run });
    expect(calls).toEqual([["/s"]]);
    expect(calls.some((a) => a[0] === "-w")).toBe(false);
  });

  test("source with attrs: one hex write per attr", async () => {
    const calls: string[][] = [];
    const run: XattrRun = async (_bin, args) => {
      calls.push(args);
      if (args.length === 1) return { stdout: "com.apple.quarantine\ncom.apple.ResourceFork\n", code: 0 };
      if (args[0] === "-p") return { stdout: "0a0b\n", code: 0 };
      return { stdout: "", code: 0 };
    };
    await copyXattrs("/s", "/d", { platform: "darwin", run });
    const writes = calls.filter((a) => a[0] === "-w");
    expect(writes).toEqual([
      ["-w", "-x", "com.apple.quarantine", "0a0b", "/d"],
      ["-w", "-x", "com.apple.ResourceFork", "0a0b", "/d"],
    ]);
  });

  test("write failure is swallowed (never throws)", async () => {
    const run: XattrRun = async (_bin, args) => {
      if (args.length === 1) return { stdout: "com.apple.quarantine\n", code: 0 };
      if (args[0] === "-p") return { stdout: "01", code: 0 };
      throw new Error("xattr failed");
    };
    await expect(copyXattrs("/s", "/d", { platform: "darwin", run })).resolves.toBeUndefined();
  });

  test("missing source (nonzero list) is a silent no-op", async () => {
    const calls: string[][] = [];
    const run: XattrRun = async (_bin, args) => {
      calls.push(args);
      return { stdout: "", code: 1 };
    };
    await expect(copyXattrs("/gone", "/d", { platform: "darwin", run })).resolves.toBeUndefined();
    expect(calls).toEqual([["/gone"]]);
  });
});
