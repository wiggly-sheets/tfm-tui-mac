import { describe, expect, test } from "bun:test";
import {
  checkAllPkgs,
  checkPkgStatus,
  detectPkgManager,
  makeInstallPlan,
  OPTIONAL_PACKAGES,
  PACKAGE_MANAGERS,
} from "./deps";

describe("detectPkgManager", () => {
  test("detects brew on darwin", () => {
    const which = (b: string) => (b === "brew" ? "/opt/homebrew/bin/brew" : null);
    const pm = detectPkgManager(which, "darwin");
    expect(pm?.id).toBe("brew");
  });

  test("returns null on darwin when brew is absent", () => {
    const which = (_b: string) => null;
    const pm = detectPkgManager(which, "darwin");
    expect(pm).toBeNull();
  });

  test("detects apt on linux", () => {
    const which = (b: string) => (b === "apt-get" ? "/usr/bin/apt-get" : null);
    const pm = detectPkgManager(which, "linux");
    expect(pm?.id).toBe("apt");
  });

  test("detects pacman on linux", () => {
    const which = (b: string) => (b === "pacman" ? "/usr/bin/pacman" : null);
    const pm = detectPkgManager(which, "linux");
    expect(pm?.id).toBe("pacman");
  });

  test("detects dnf on linux", () => {
    const which = (b: string) => (b === "dnf" ? "/usr/bin/dnf" : null);
    const pm = detectPkgManager(which, "linux");
    expect(pm?.id).toBe("dnf");
  });

  test("detects zypper on linux", () => {
    const which = (b: string) => (b === "zypper" ? "/usr/bin/zypper" : null);
    const pm = detectPkgManager(which, "linux");
    expect(pm?.id).toBe("zypper");
  });

  test("detects apk on linux", () => {
    const which = (b: string) => (b === "apk" ? "/sbin/apk" : null);
    const pm = detectPkgManager(which, "linux");
    expect(pm?.id).toBe("apk");
  });

  test("returns null when no known pm is found", () => {
    const which = (_b: string) => null;
    expect(detectPkgManager(which, "linux")).toBeNull();
  });
});

describe("checkPkgStatus", () => {
  const brew = PACKAGE_MANAGERS.find((p) => p.id === "brew")!;
  const apt = PACKAGE_MANAGERS.find((p) => p.id === "apt")!;

  test("detects installed via primary or fallback binary", () => {
    const fdPkg = OPTIONAL_PACKAGES.find((p) => p.id === "fd")!;
    // neither present
    expect(checkPkgStatus(fdPkg, brew, () => null).installed).toBe(false);

    // primary binary present
    const whichFd = (b: string) => (b === "fd" ? "/usr/local/bin/fd" : null);
    const resFd = checkPkgStatus(fdPkg, brew, whichFd);
    expect(resFd.installed).toBe(true);
    expect(resFd.foundBin).toBe("fd");

    // fallback binary present (fdfind on debian/ubuntu)
    const whichFdfind = (b: string) => (b === "fdfind" ? "/usr/bin/fdfind" : null);
    const resApt = checkPkgStatus(fdPkg, apt, whichFdfind);
    expect(resApt.installed).toBe(true);
    expect(resApt.foundBin).toBe("fdfind");
    expect(resApt.pkgName).toBe("fd-find");
  });

  test("checks all packages", () => {
    const which = (b: string) => (b === "rg" || b === "ffmpeg" ? `/bin/${b}` : null);
    const { statuses } = checkAllPkgs(which, "darwin");
    expect(statuses).toHaveLength(10);
    const rg = statuses.find((s) => s.spec.id === "ripgrep")!;
    expect(rg.installed).toBe(true);
    const fd = statuses.find((s) => s.spec.id === "fd")!;
    expect(fd.installed).toBe(false);
  });
});

describe("makeInstallPlan", () => {
  test("generates homebrew plan without sudo", () => {
    const which = (b: string) => (b === "brew" ? "/opt/homebrew/bin/brew" : null);
    const plan = makeInstallPlan(["fd", "ripgrep"], which, "darwin");
    expect(plan.pm.id).toBe("brew");
    expect(plan.sudo).toBe(false);
    expect(plan.bin).toBe("brew");
    expect(plan.args).toEqual(["install", "fd", "ripgrep"]);
  });

  test("generates apt plan with sudo", () => {
    const which = (b: string) => (b === "apt-get" ? "/usr/bin/apt-get" : null);
    const plan = makeInstallPlan(["fd", "7zip"], which, "linux");
    expect(plan.pm.id).toBe("apt");
    expect(plan.sudo).toBe(true);
    expect(plan.bin).toBe("apt-get");
    expect(plan.args).toEqual(["install", "-y", "fd-find", "p7zip-full"]);
  });

  test("empty targets installs all optional packages", () => {
    const which = (b: string) => (b === "pacman" ? "/usr/bin/pacman" : null);
    const plan = makeInstallPlan([], which, "linux");
    expect(plan.pkgsToInstall).toEqual([
      "imagemagick",
      "fd",
      "ffmpeg",
      "p7zip",
      "ripgrep",
      "git",
      "glib",
      "zip",
      "unzip",
    ]);
    expect(plan.args).toEqual([
      "-S",
      "--noconfirm",
      "imagemagick",
      "fd",
      "ffmpeg",
      "p7zip",
      "ripgrep",
      "git",
      "glib",
      "zip",
      "unzip",
    ]);
  });

  test("throws if unknown target given", () => {
    const which = (b: string) => (b === "brew" ? "/usr/bin/brew" : null);
    expect(() => makeInstallPlan(["unknownpkg"], which, "darwin")).toThrow("Unknown optional tool");
  });

  test("throws if no package manager detected", () => {
    const which = () => null;
    expect(() => makeInstallPlan(["fd"], which, "linux")).toThrow("No supported package manager found");
  });
});

// Every external binary tfm probes via which() must be covered by
// OPTIONAL_PACKAGES so it can be installed through the same path. This test
// keeps the registry from silently drifting out of sync with the codebase.
describe("OPTIONAL_PACKAGES coverage", () => {
  test("every spec has a non-empty bins list and at least one package name", () => {
    for (const p of OPTIONAL_PACKAGES) {
      expect(p.bins.length).toBeGreaterThan(0);
      expect(Object.keys(p.pkgs).length).toBeGreaterThan(0);
    }
  });

  test("no duplicate ids or bins across specs", () => {
    const ids = new Set<string>();
    const bins = new Set<string>();
    for (const p of OPTIONAL_PACKAGES) {
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
      for (const b of p.bins) {
        expect(bins.has(b)).toBe(false);
        bins.add(b);
      }
    }
  });

  test("every known external binary is covered by a spec", () => {
    // Add a binary here when tfm starts probing it.
    const covered = new Set<string>();
    for (const p of OPTIONAL_PACKAGES) for (const b of p.bins) covered.add(b);
    const required = [
      "magick",
      "convert",
      "fd",
      "fdfind",
      "ffmpeg",
      "7z",
      "7za",
      "7zr",
      "rg",
      "git",
      "gio",
      "zip",
      "unzip",
      "tag",
    ];
    for (const b of required) {
      expect(covered.has(b)).toBe(true);
    }
  });
});
