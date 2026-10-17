import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import {
  RECENT_URI,
  STARRED_URI,
  fileUriToPath,
  isVirtualUri,
  parseIso,
  pathToUri,
  uriToPath,
  xdgDataHome,
  xdgStateHome,
} from "./uri";

describe("isVirtualUri", () => {
  test("recognizes exactly the two virtual places", () => {
    expect(isVirtualUri(RECENT_URI)).toBe(true);
    expect(isVirtualUri(STARRED_URI)).toBe(true);
    expect(isVirtualUri("/home/clark")).toBe(false);
    expect(isVirtualUri("trash://")).toBe(false);
    expect(isVirtualUri("")).toBe(false);
  });

  test("URI constants are the documented values (config/session round-trips rely on them)", () => {
    expect(RECENT_URI).toBe("recent://");
    expect(STARRED_URI).toBe("starred://");
  });
});

describe("xdg homes", () => {
  test("honor env overrides", () => {
    const oldData = process.env.XDG_DATA_HOME;
    const oldState = process.env.XDG_STATE_HOME;
    try {
      process.env.XDG_DATA_HOME = "/tmp/opencode/xdg-data";
      process.env.XDG_STATE_HOME = "/tmp/opencode/xdg-state";
      expect(xdgDataHome()).toBe("/tmp/opencode/xdg-data");
      expect(xdgStateHome()).toBe("/tmp/opencode/xdg-state");
    } finally {
      if (oldData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = oldData;
      if (oldState === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = oldState;
    }
  });

  test("fall back to $HOME defaults when env unset", () => {
    const oldData = process.env.XDG_DATA_HOME;
    try {
      delete process.env.XDG_DATA_HOME;
      expect(xdgDataHome()).toBe(`${process.env.HOME}/.local/share`);
    } finally {
      if (oldData !== undefined) process.env.XDG_DATA_HOME = oldData;
    }
  });
});

describe("uri <-> path", () => {
  test("pathToUri percent-encodes every segment but the root slash", () => {
    expect(pathToUri("/home/clark/my file.txt")).toBe("file:///home/clark/my%20file.txt");
    expect(pathToUri("/tmp/a#b?c/d&e.txt")).toBe("file:///tmp/a%23b%3Fc/d%26e.txt");
  });

  test("uriToPath round-trips pathToUri", () => {
    const p = "/home/clark/über ordner/datei name (1).txt";
    expect(uriToPath(pathToUri(p))).toBe(p);
  });

  test("uriToPath rejects non-file schemes and malformed escapes", () => {
    expect(uriToPath("http://example.com/x")).toBeNull();
    expect(uriToPath("recent://")).toBeNull();
    expect(uriToPath("file:///a%ZZb")).toBeNull();
  });
});

describe("fileUriToPath", () => {
  const home = os.homedir();

  test("decodes a normal file:// URI (no root: lexical resolve only)", () => {
    expect(fileUriToPath("file:///home/me/a%20b.txt")).toBe("/home/me/a b.txt");
  });

  test("strips an authority part, keeping the leading slash", () => {
    expect(fileUriToPath("file://localhost/tmp/z")).toBe("/tmp/z");
  });

  test("rejects ../ traversal (the remote-drop escape vector)", () => {
    expect(fileUriToPath("file:///../../../etc/shadow")).toBeNull();
    expect(fileUriToPath("file:///home/me/../etc/shadow")).toBeNull();
    expect(fileUriToPath("file:///home/me/../../etc/shadow")).toBeNull();
  });

  test("rejects a traversal that decodes after escaping", () => {
    expect(fileUriToPath("file:///home/me/%2e%2e%2fetc%2fshadow")).toBeNull();
  });

  test("rejects a symlink target outside the root", () => {
    const now = Date.now();
    const dir = path.join(home, `tfm-uri-test-${now}`);
    mkdirSync(dir, { recursive: true });
    try {
      // sibling of dir under home, so the link escapes the root
      const outside = path.join(home, `tfm-uri-outside-${now + 1}`);
      writeFileSync(outside, "x");
      const link = path.join(dir, "escape");
      symlinkSync(outside, link);
      expect(fileUriToPath(`file://${link}`, dir)).toBeNull();
      rmSync(outside, { force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts a symlink whose target stays inside the root", () => {
    const dir = path.join(home, `tfm-uri-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const target = path.join(dir, "inner");
      writeFileSync(target, "x");
      const link = path.join(dir, "safe-link");
      symlinkSync(target, link);
      expect(fileUriToPath(`file://${link}`, dir)).toBe(link);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("accepts a non-existent path with no traversal", () => {
    expect(fileUriToPath("file:///home/me/brand-new.txt")).toBe("/home/me/brand-new.txt");
  });

  test("returns null for a relative path after host-strip", () => {
    expect(fileUriToPath("file://host")).toBeNull();
  });

  test("swallows malformed percent escapes (returns the raw slice)", () => {
    expect(fileUriToPath("file:///tmp/%zz.txt")).toBe("/tmp/%zz.txt");
  });

  test("an explicit root bounds the result", () => {
    expect(fileUriToPath("file:///etc/shadow", home)).toBeNull();
    expect(fileUriToPath("file:///tmp/x", "/tmp")).toBe("/tmp/x");
    expect(fileUriToPath("file:///tmp/../etc/shadow", "/tmp")).toBeNull();
  });
});

describe("parseIso", () => {
  test("parses ISO-8601 and zero-falls garbage", () => {
    expect(parseIso("2026-08-27T10:00:00Z")).toBe(Date.parse("2026-08-27T10:00:00Z"));
    expect(parseIso("2026-08-27T10:00:00.123Z")).toBe(Date.parse("2026-08-27T10:00:00.123Z"));
    expect(parseIso("not a date")).toBe(0);
    expect(parseIso("")).toBe(0);
  });
});
