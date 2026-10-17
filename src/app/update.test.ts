import { describe, expect, test } from "bun:test";
import {
  checkIntervalMs,
  compareVersions,
  installRefusalReason,
  isNewer,
  parseVersion,
  REPO,
  shouldCheck,
  updateAssetName,
  versionOf,
} from "./update";

const goodMarker = {
  version: "1.0.0",
  installDir: "/home/u/.local/bin",
  repo: REPO,
  method: "script",
  installedAt: "2026-10-17T12:00:00Z",
};

describe("semver", () => {
  test("equal, newer, older", () => {
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(isNewer("v1.0.1", "v1.0.0")).toBe(true);
    expect(isNewer("v0.9.9", "v1.0.0")).toBe(false);
    expect(isNewer("v1.10.0", "v1.9.9")).toBe(true);
  });

  test("prerelease sorts before its release, and identifier by identifier", () => {
    expect(isNewer("v1.0.0", "v1.0.0-alpha.3")).toBe(true);
    expect(isNewer("v1.0.0-alpha.3", "v1.0.0")).toBe(false);
    expect(isNewer("v1.0.0-alpha.3", "v1.0.0-alpha.2")).toBe(true);
    expect(isNewer("v1.0.0-alpha", "v1.0.0-alpha.1")).toBe(false);
    expect(isNewer("v1.0.0-beta", "v1.0.0-alpha")).toBe(true);
  });

  test("garbage / missing tags are never newer", () => {
    for (const bad of ["", "garbage", "v1.0", "1.0.0.0", "v", "latest"]) {
      expect(parseVersion(bad)).toBeNull();
      expect(isNewer(bad, "v1.0.0")).toBe(false);
      expect(isNewer("v1.0.0", bad)).toBe(false);
    }
  });

  test("versionOf drops the leading v", () => {
    expect(versionOf("v1.2.3")).toBe("1.2.3");
    expect(versionOf("1.2.3")).toBe("1.2.3");
  });
});

describe("updateAssetName", () => {
  test("maps the four release targets", () => {
    expect(updateAssetName("darwin", "arm64")).toBe("aarch64-macos");
    expect(updateAssetName("darwin", "x64")).toBe("x86_64-macos");
    expect(updateAssetName("linux", "x64")).toBe("x86_64-linux");
    expect(updateAssetName("linux", "arm64")).toBe("aarch64-linux");
  });

  test("unknown platform or arch has no prebuilt release", () => {
    expect(updateAssetName("win32", "x64")).toBeNull();
    expect(updateAssetName("darwin", "ia32")).toBeNull();
    expect(updateAssetName("linux", "arm")).toBeNull();
  });
});

describe("shouldCheck", () => {
  const now = 1_700_000_000_000;

  test("missing or malformed cache always checks", () => {
    expect(shouldCheck(null, now)).toBe(true);
    expect(shouldCheck(undefined, now)).toBe(true);
    expect(shouldCheck({ at: Number.NaN }, now)).toBe(true);
  });

  test("boundary: just under the interval waits, at/over it checks", () => {
    expect(shouldCheck({ at: now - checkIntervalMs + 1 }, now)).toBe(false);
    expect(shouldCheck({ at: now - checkIntervalMs }, now)).toBe(true);
    expect(shouldCheck({ at: now - checkIntervalMs - 1 }, now)).toBe(true);
  });
});

describe("installRefusalReason", () => {
  const execPath = "/home/u/.local/bin/tfm";
  const dir = "/home/u/.local/bin";

  test("a good install.sh marker is accepted", () => {
    expect(installRefusalReason({ marker: goodMarker, execPath, installDirResolved: dir })).toBeNull();
  });

  test("a dev / uncompiled exec path is refused", () => {
    expect(
      installRefusalReason({ marker: goodMarker, execPath: "/usr/local/bin/bun", installDirResolved: dir }),
    ).toContain("compiled");
  });

  test("a missing or malformed marker is refused", () => {
    for (const marker of [null, {}, { repo: REPO }, "nope", 42, { ...goodMarker, version: 1 }]) {
      expect(installRefusalReason({ marker, execPath, installDirResolved: dir })).toContain("install.sh");
    }
  });

  test("a package-manager marker is refused", () => {
    const marker = { ...goodMarker, method: "brew" };
    expect(installRefusalReason({ marker, execPath, installDirResolved: dir })).toContain("package manager");
  });

  test("a foreign repo is refused", () => {
    const marker = { ...goodMarker, repo: "someone/else" };
    expect(installRefusalReason({ marker, execPath, installDirResolved: dir })).not.toBeNull();
  });

  test("a moved binary (install dir mismatch) is refused", () => {
    expect(installRefusalReason({ marker: goodMarker, execPath, installDirResolved: "/opt/tfm/bin" })).toContain(
      "install directory",
    );
  });
});
