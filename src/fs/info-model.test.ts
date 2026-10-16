import { describe, expect, test } from "bun:test";
import { mimeLabelFor } from "./propsinfo";
import { infoRows, type InfoRow, type InfoStat, type InfoSelection } from "./info-model";

// structural subset of node:fs Stats — real Stats satisfies it, and tests can
// build a literal without touching disk (see ./info-model).
const mkStat = (over: Partial<InfoStat> = {}): InfoStat => ({
  size: 0,
  mode: 0o644,
  uid: 0,
  gid: 0,
  mtimeMs: 0,
  atimeMs: 0,
  birthtimeMs: 0,
  isDirectory: () => false,
  ...over,
});

// mimeLabelFor reads shared-mime-info when present and falls back to the
// extension category otherwise — pin the kind row to a nameless file so the
// assertion is environment-independent (./propsinfo.test covers mimeLabelFor
// parity with both backends).
const NOEXT = "README";

const row = (rows: InfoRow[], i: number): InfoRow => rows[i]!;

describe("infoRows", () => {
  test("empty selection yields no rows", () => {
    expect(infoRows({ kind: "none" })).toEqual([]);
  });

  test("a single file carries every detail row", () => {
    const st = mkStat({
      size: 2048,
      mode: 0o644,
      mtimeMs: 1_700_000_000_000,
      atimeMs: 1_701_000_000_000,
      birthtimeMs: 1_699_000_000_000,
    });
    const sel: InfoSelection = { kind: "single", path: `/home/u/docs/${NOEXT}`, st, home: "/home/u" };
    const rows = infoRows(sel);
    expect(rows.map((r) => r.label)).toEqual([
      "name",
      "kind",
      "size",
      "created",
      "modified",
      "accessed",
      "permissions",
      "owner",
      "path",
    ]);
    expect(row(rows, 0).value).toBe(NOEXT);
    expect(row(rows, 1).value).toBe(mimeLabelFor(NOEXT));
    expect(row(rows, 2).value).toBe("2.0 KB (2048 bytes)");
    // fmtDate renders UTC fields (see ./propsinfo.test); 1_699/1_700/1_701e12
    // ms are 2023-11-03 08:26 / 2023-11-14 22:13 / 2023-11-26 12:00 UTC
    expect(row(rows, 3).value).toBe("2023-11-03 08:26");
    expect(row(rows, 4).value).toBe("2023-11-14 22:13");
    expect(row(rows, 5).value).toBe("2023-11-26 12:00");
    // 0o644: the info sidebar shows the OWNER triad only (read, write)
    expect(row(rows, 6).value).toBe("644 · read, write");
    expect(row(rows, 7).value).toBe("root:root");
    expect(row(rows, 8).value).toBe("~/docs/README");
  });

  test("a directory shows items/size instead of bytes", () => {
    const st = mkStat({ mode: 0o755, isDirectory: () => true });
    const sel: InfoSelection = {
      kind: "single",
      path: "/home/u/projects",
      st,
      home: "/home/u",
      dir: { bytes: 4096, files: 3, folders: 2 },
    };
    const rows = infoRows(sel);
    expect(rows.map((r) => r.label)).toEqual([
      "name",
      "kind",
      "items",
      "size",
      "created",
      "modified",
      "accessed",
      "permissions",
      "owner",
      "path",
    ]);
    expect(row(rows, 1).value).toBe("folder");
    expect(row(rows, 2).value).toBe("3 files · 2 folders");
    expect(row(rows, 3).value).toBe("4.0 KB");
    // 0o755 owner triad only: execute reads as "enter" for folders
    expect(row(rows, 7).value).toBe("755 · read, write, enter");
    expect(row(rows, 9).value).toBe("~/projects");
  });

  test("a directory with a pending walk shows calculating…", () => {
    const st = mkStat({ isDirectory: () => true });
    const sel: InfoSelection = { kind: "single", path: "/x", st, home: "/x", dir: "pending" };
    const rows = infoRows(sel);
    expect(row(rows, 2).value).toBe("calculating…");
    expect(row(rows, 3).value).toBe("calculating…");
  });

  test("a directory whose tree is too large to scan says so", () => {
    const st = mkStat({ isDirectory: () => true });
    const sel: InfoSelection = { kind: "single", path: "/x", st, home: "/x", dir: null };
    const rows = infoRows(sel);
    expect(row(rows, 2).value).toBe("200k+ entries — too large to scan");
    expect(row(rows, 3).value).toBe("200k+ entries — too large to scan");
  });

  test("a multi-selection summarizes count, size and item kinds", () => {
    const sel: InfoSelection = { kind: "multi", count: 4, bytes: 8192, files: 3, folders: 1 };
    const rows = infoRows(sel);
    expect(rows).toEqual([
      { label: "selected", value: "4 items" },
      { label: "size", value: "8.0 KB" },
      { label: "items", value: "3 files · 1 folders" },
    ]);
  });

  test("a multi-selection with no folders lists zero folders (matches the properties dialog)", () => {
    const sel: InfoSelection = { kind: "multi", count: 2, bytes: 512, files: 2, folders: 0 };
    expect(row(infoRows(sel), 2).value).toBe("2 files · 0 folders");
  });

  test("home is stripped from the path row", () => {
    const st = mkStat();
    expect(row(infoRows({ kind: "single", path: "/home/u/x.txt", st, home: "/home/u" }), 8).value).toBe("~/x.txt");
  });
});
