import { describe, expect, test } from "bun:test";
import {
  archiveBreadcrumb,
  archiveInnerParent,
  archiveParent,
  archiveUri,
  buildArchiveTree,
  listArchiveDir,
  parseArchiveUri,
} from "./archive-nav";
import type { ArchiveEntryInfo } from "../fs/archive";

const member = (name: string, isDir = false, size?: number): ArchiveEntryInfo => ({ name, isDir, size });

describe("archiveUri / parseArchiveUri", () => {
  test("round-trips a root location", () => {
    const uri = archiveUri("/home/u/data.zip");
    expect(uri).toBe("archive:///home/u/data.zip");
    expect(parseArchiveUri(uri)).toEqual({ archive: "/home/u/data.zip", inner: "" });
  });

  test("round-trips an inner path", () => {
    const uri = archiveUri("/home/u/data.zip", "sub/deep");
    expect(parseArchiveUri(uri)).toEqual({ archive: "/home/u/data.zip", inner: "sub/deep" });
  });

  test("escapes a ? in the archive path (the inner path follows it)", () => {
    const uri = archiveUri("/home/u/we?ird.zip", "a/b");
    expect(uri).toBe("archive:///home/u/we%3Fird.zip?a/b");
    expect(parseArchiveUri(uri)).toEqual({ archive: "/home/u/we?ird.zip", inner: "a/b" });
  });

  test("refuses a non-archive location and a non-archive uri", () => {
    expect(parseArchiveUri("archive:///home/u/notes.txt")).toBeNull();
    expect(parseArchiveUri("/home/u/data.zip")).toBeNull();
  });
});

describe("buildArchiveTree / listArchiveDir", () => {
  test("synthesizes intermediate dirs and groups children by their dir", () => {
    const tree = buildArchiveTree([
      member("a.txt", false, 2),
      member("sub/b.txt", false, 3),
      member("deep/x/y.txt"),
      member(".hidden", false, 1),
    ]);
    // root: the container's own entries first, then the synthesized intermediate
    // dirs (the caller sorts with the pane's own sort mode — order here is the
    // container's, not a guarantee)
    expect(listArchiveDir(tree, "", true)).toEqual([
      { name: "a.txt", isDir: false, size: 2 },
      { name: ".hidden", isDir: false, size: 1 },
      { name: "sub", isDir: true, size: undefined },
      { name: "deep", isDir: true, size: undefined },
    ]);
    // hidden members are dropped unless asked for (the listDir rule)
    expect(listArchiveDir(tree, "")).toEqual([
      { name: "a.txt", isDir: false, size: 2 },
      { name: "sub", isDir: true, size: undefined },
      { name: "deep", isDir: true, size: undefined },
    ]);
    // descent: one level in at a time, through synthesized dirs
    expect(listArchiveDir(tree, "sub")).toEqual([{ name: "b.txt", isDir: false, size: 3 }]);
    expect(listArchiveDir(tree, "deep")).toEqual([{ name: "x", isDir: true }]);
    expect(listArchiveDir(tree, "deep/x")).toEqual([{ name: "y.txt", isDir: false }]);
    // unknown inner path lists empty, like an empty folder
    expect(listArchiveDir(tree, "nope")).toEqual([]);
  });

  test("an explicitly stored dir member still lists as a dir", () => {
    const tree = buildArchiveTree([member("sub/", true), member("sub/b.txt", false, 3)]);
    expect(listArchiveDir(tree, "")).toEqual([{ name: "sub", isDir: true }]);
    expect(listArchiveDir(tree, "sub")).toEqual([{ name: "b.txt", isDir: false, size: 3 }]);
  });

  test("an empty archive yields an empty tree", () => {
    const tree = buildArchiveTree([]);
    expect(tree.size).toBe(0);
    expect(listArchiveDir(tree, "")).toEqual([]);
  });

  test("blank member names are skipped", () => {
    const tree = buildArchiveTree([{ name: "", isDir: false }, member("a.txt")]);
    expect(listArchiveDir(tree, "")).toEqual([{ name: "a.txt", isDir: false }]);
  });
});

describe("archiveInnerParent / archiveParent", () => {
  test("inner parent walks one member level up, null at the root", () => {
    expect(archiveInnerParent("")).toBeNull();
    expect(archiveInnerParent("a")).toBe("");
    expect(archiveInnerParent("a/b")).toBe("a");
  });

  test("backspace target: up the member chain, then out to the archive's folder", () => {
    // not an archive location: the caller keeps its own rule
    expect(archiveParent("/home/u/data")).toBeNull();
    // at the archive root: the folder holding the container
    expect(archiveParent(archiveUri("/home/u/data.zip"))).toBe("/home/u");
    // inside: up one inner level, still an archive location
    expect(archiveParent(archiveUri("/home/u/data.zip", "a/b"))).toBe(archiveUri("/home/u/data.zip", "a"));
    expect(archiveParent(archiveUri("/home/u/data.zip", "a"))).toBe(archiveUri("/home/u/data.zip"));
  });
});

describe("archiveBreadcrumb", () => {
  test("short labels print whole", () => {
    expect(archiveBreadcrumb(archiveUri("/home/u/data.zip"))).toBe("data.zip");
    expect(archiveBreadcrumb(archiveUri("/home/u/data.zip", "a/b"))).toBe("data.zip/a/b");
  });

  test("long labels cut from the left (the deepest component says where you are)", () => {
    const uri = archiveUri("/home/u/data.zip", "a/b/c/d/e/f/g/h");
    const out = archiveBreadcrumb(uri, 20);
    expect(out.length).toBe(20);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("d/e/f/g/h")).toBe(true);
  });

  test("a non-archive location passes through", () => {
    expect(archiveBreadcrumb("/home/u/data.zip")).toBe("/home/u/data.zip");
  });
});
