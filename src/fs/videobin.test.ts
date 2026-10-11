// Resolver contract: bundled sidecar first, never the system PATH.
import { mkdtempSync, rmSync } from "node:fs";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { resetVideoBin, resolveVideoBin, SIDECAR_NAME, videoBin } from "./videobin";

const mkBin = (dir: string, name: string): string => {
  const p = path.join(dir, name);
  writeFileSync(p, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
};

describe("resolveVideoBin lookup order", () => {
  test("explicit override wins over sidecar and dev binary", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "tfm-videobin-"));
    try {
      const override = mkBin(tmp, "custom-ffmpeg");
      const execDir = mkdtempSync(path.join(tmpdir(), "tfm-videobin-exec-"));
      try {
        mkBin(execDir, SIDECAR_NAME);
        const dev = mkBin(tmp, "dev-ffmpeg");
        expect(resolveVideoBin({ platform: "linux", override, execDir, devBin: dev })).toEqual({
          bin: override,
          source: "override",
        });
      } finally {
        rmSync(execDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("sidecar next to the executable beats the dev binary", () => {
    const execDir = mkdtempSync(path.join(tmpdir(), "tfm-videobin-exec-"));
    const tmp = mkdtempSync(path.join(tmpdir(), "tfm-videobin-"));
    try {
      const sidecar = mkBin(execDir, SIDECAR_NAME);
      const dev = mkBin(tmp, "dev-ffmpeg");
      expect(resolveVideoBin({ platform: "linux", execDir, devBin: dev })).toEqual({ bin: sidecar, source: "sidecar" });
    } finally {
      rmSync(execDir, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("dev binary used when no override or sidecar exists", () => {
    const execDir = mkdtempSync(path.join(tmpdir(), "tfm-videobin-exec-"));
    const tmp = mkdtempSync(path.join(tmpdir(), "tfm-videobin-"));
    try {
      const dev = mkBin(tmp, "dev-ffmpeg");
      expect(resolveVideoBin({ platform: "linux", execDir, devBin: dev })).toEqual({ bin: dev, source: "dev" });
    } finally {
      rmSync(execDir, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("null when nothing is runnable", () => {
    const execDir = mkdtempSync(path.join(tmpdir(), "tfm-videobin-exec-"));
    try {
      expect(resolveVideoBin({ platform: "linux", execDir, devBin: null })).toBeNull();
    } finally {
      rmSync(execDir, { recursive: true, force: true });
    }
  });

  test("non-runnable override falls through to the sidecar", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "tfm-videobin-"));
    const execDir = mkdtempSync(path.join(tmpdir(), "tfm-videobin-exec-"));
    try {
      const dead = path.join(tmp, "not-executable");
      writeFileSync(dead, "nope");
      const sidecar = mkBin(execDir, SIDECAR_NAME);
      expect(resolveVideoBin({ platform: "linux", override: dead, execDir, devBin: null })).toEqual({
        bin: sidecar,
        source: "sidecar",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(execDir, { recursive: true, force: true });
    }
  });

  test("missing override path falls through instead of failing", () => {
    const execDir = mkdtempSync(path.join(tmpdir(), "tfm-videobin-exec-"));
    const tmp = mkdtempSync(path.join(tmpdir(), "tfm-videobin-"));
    try {
      const dev = mkBin(tmp, "dev-ffmpeg");
      expect(resolveVideoBin({ platform: "linux", override: path.join(tmp, "ghost"), execDir, devBin: dev })).toEqual({
        bin: dev,
        source: "dev",
      });
    } finally {
      rmSync(execDir, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("videoBin memoization", () => {
  test("caches the first resolution until reset", () => {
    resetVideoBin();
    try {
      const first = videoBin();
      expect(videoBin()).toBe(first);
    } finally {
      resetVideoBin();
    }
  });
});

describe("darwin sidecar and brew fallback", () => {
  test("arch sidecar name wins over the plain name", async () => {
    const { resolveVideoBin, SIDECAR_NAME } = await import("./videobin");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { default: path } = await import("node:path");
    const { default: fs } = await import("node:fs");
    const dir = mkdtempSync(path.join(tmpdir(), "tfm-vb-dar-"));
    try {
      const arch = path.join(dir, "tfm-ffmpeg-macos-arm64");
      const plain = path.join(dir, SIDECAR_NAME);
      fs.writeFileSync(arch, "x");
      fs.writeFileSync(plain, "x");
      fs.chmodSync(arch, 0o755);
      fs.chmodSync(plain, 0o755);
      expect(resolveVideoBin({ execDir: dir, devBin: null, platform: "darwin" })).toEqual({
        bin: arch,
        source: "sidecar",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("brew ffmpeg is the last resort on darwin only", async () => {
    const { resolveVideoBin } = await import("./videobin");
    const { mkdtempSync, rmSync, writeFileSync, chmodSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { default: path } = await import("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "tfm-vb-brew-"));
    try {
      const fake = path.join(dir, "ffmpeg");
      writeFileSync(fake, "x");
      chmodSync(fake, 0o755);
      expect(resolveVideoBin({ execDir: dir, devBin: null, platform: "darwin", brewBin: fake })?.source).toBe("brew");
      expect(resolveVideoBin({ execDir: dir, devBin: null, platform: "linux", brewBin: fake })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
