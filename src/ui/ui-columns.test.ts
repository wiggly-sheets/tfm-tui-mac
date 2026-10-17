import { describe, expect, test } from "bun:test";
import path from "node:path";
import { makeColumnsModel } from "../ui/ui-columns";
import type { Entry } from "../fs/listing";

// Fake listing backend: a simple in-memory tree rooted at /root.
const makeFs = () => {
  const tree: Record<string, Entry[]> = {
    "/root": [
      { name: "sub", isDir: true, abs: "/root/sub" },
      { name: "a.txt", isDir: false, abs: "/root/a.txt", size: 12, mtimeMs: 1 },
      { name: "b.txt", isDir: false, abs: "/root/b.txt", size: 4, mtimeMs: 2 },
    ],
    "/root/sub": [
      { name: "deep", isDir: true, abs: "/root/sub/deep" },
      { name: "c.txt", isDir: false, abs: "/root/sub/c.txt", size: 7, mtimeMs: 3 },
    ],
    "/root/sub/deep": [{ name: "d.txt", isDir: false, abs: "/root/sub/deep/d.txt", size: 1, mtimeMs: 4 }],
  };
  const listDir = async (dir: string): Promise<Entry[]> => tree[dir] ?? [];
  return { listDir, tree };
};

describe("columns model (path resolution)", () => {
  test("starts at the root with its entries", async () => {
    const fs = makeFs();
    const m = makeColumnsModel({ cwd: "/root", showHidden: false, sortBy: "name", sortAsc: true, listDir: fs.listDir });
    await m.init();
    const cols = m.getColumns();
    expect(cols.length).toBe(1);
    expect(cols[0]!.dir).toBe("/root");
    expect(cols[0]!.entries.map((e) => e.name)).toEqual(["sub", "a.txt", "b.txt"]);
    expect(m.getActiveCol()).toBe(0);
  });

  test("selecting a directory opens the next column with its children", async () => {
    const fs = makeFs();
    const m = makeColumnsModel({ cwd: "/root", showHidden: false, sortBy: "name", sortAsc: true, listDir: fs.listDir });
    await m.init();
    // click "sub" (index 0)
    await m.select(0, 0);
    const cols = m.getColumns();
    expect(cols.length).toBe(2);
    expect(cols[1]!.dir).toBe("/root/sub");
    expect(cols[1]!.entries.map((e) => e.name)).toEqual(["deep", "c.txt"]);
    expect(m.getActiveCol()).toBe(1);
  });

  test("selecting a directory deeper collapses columns past it", async () => {
    const fs = makeFs();
    const m = makeColumnsModel({ cwd: "/root", showHidden: false, sortBy: "name", sortAsc: true, listDir: fs.listDir });
    await m.init();
    await m.select(0, 0); // /root/sub
    await m.select(1, 0); // /root/sub/deep
    expect(m.getColumns().length).toBe(3);
    // now re-click the root's "sub" (col 0, idx 0) — must collapse cols 1..2 and reopen
    await m.select(0, 0);
    const cols = m.getColumns();
    expect(cols.length).toBe(2);
    expect(cols[1]!.dir).toBe("/root/sub");
    expect(m.getActiveCol()).toBe(1);
  });

  test("selecting a file collapses past it and shows a preview", async () => {
    const fs = makeFs();
    const m = makeColumnsModel({
      cwd: "/root",
      showHidden: false,
      sortBy: "name",
      sortAsc: true,
      listDir: fs.listDir,
      readFile: async (p) => `content of ${path.basename(p)}`,
    });
    await m.init();
    await m.select(0, 0); // /root/sub
    await m.select(1, 0); // /root/sub/deep
    expect(m.getColumns().length).toBe(3);
    // select a file in col 2 (d.txt)
    await m.select(2, 0);
    const cols = m.getColumns();
    expect(cols.length).toBe(3);
    expect(m.getPreview().path).toBe("/root/sub/deep/d.txt");
    expect(m.getPreview().text).toBe("content of d.txt");
  });

  test("backspace collapses one column", async () => {
    const fs = makeFs();
    const m = makeColumnsModel({ cwd: "/root", showHidden: false, sortBy: "name", sortAsc: true, listDir: fs.listDir });
    await m.init();
    await m.select(0, 0);
    expect(m.getColumns().length).toBe(2);
    const handled = await m.backspace();
    expect(handled).toBe(true);
    expect(m.getColumns().length).toBe(1);
    expect(m.getColumns()[0]!.dir).toBe("/root");
  });

  test("backspace on the root navigates to the parent directory", async () => {
    const fs = makeFs();
    let navigatedTo = "";
    const m = makeColumnsModel({
      cwd: "/root",
      showHidden: false,
      sortBy: "name",
      sortAsc: true,
      listDir: fs.listDir,
      onNavigate: (dir) => {
        navigatedTo = dir;
      },
    });
    await m.init();
    const handled = await m.backspace();
    expect(handled).toBe(true);
    expect(navigatedTo).toEqual("/");
    // backspace delegates to the caller's nav; the model keeps its column
    // until the rebuild lands the parent dir
    expect(m.getColumns()[0]!.dir).toBe("/root");
  });

  test("left/right move the active column", async () => {
    const fs = makeFs();
    const m = makeColumnsModel({ cwd: "/root", showHidden: false, sortBy: "name", sortAsc: true, listDir: fs.listDir });
    await m.init();
    await m.select(0, 0); // 2 columns, active=1
    m.moveCol(-1);
    expect(m.getActiveCol()).toBe(0);
    m.moveCol(1);
    expect(m.getActiveCol()).toBe(1);
    // clamped
    m.moveCol(9);
    expect(m.getActiveCol()).toBe(1);
    m.moveCol(-9);
    expect(m.getActiveCol()).toBe(0);
  });
});
