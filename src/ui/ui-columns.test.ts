import { describe, expect, test } from "bun:test";
import path from "node:path";
import { makeColumnsModel, makeColumnsRenderer } from "../ui/ui-columns";
import type { Entry } from "../fs/listing";
import type { KeyAction } from "../config/config-schema";
import type { GridRendererCtx } from "../ui/ui-grid-types";

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

describe("columns selection sink (status/preview/actions)", () => {
  test("emits the active entry on init/select/moveRow/moveCol/backspace", async () => {
    const fs = makeFs();
    const seen: Array<[string, boolean]> = [];
    const m = makeColumnsModel({
      cwd: "/root",
      showHidden: false,
      sortBy: "name",
      sortAsc: true,
      listDir: fs.listDir,
      readFile: async (p) => `content of ${path.basename(p)}`,
      onSelect: (p, isDir) => seen.push([p, isDir]),
    });
    await m.init();
    expect(seen.at(-1)).toEqual(["/root/sub", true]);
    await m.select(0, 1); // a.txt (file)
    expect(seen.at(-1)).toEqual(["/root/a.txt", false]);
    await m.select(0, 2); // b.txt (file)
    expect(seen.at(-1)).toEqual(["/root/b.txt", false]);
    await m.select(0, 0); // sub dir -> second column (deep)
    expect(seen.at(-1)).toEqual(["/root/sub/deep", true]);
    await m.moveRow(1); // c.txt
    expect(seen.at(-1)).toEqual(["/root/sub/c.txt", false]);
    await m.backspace(); // pop back to the root column (its cursor is "sub")
    expect(seen.at(-1)).toEqual(["/root/sub", true]);
  });

  test("reload re-lists the open columns in place and drops a stale preview", async () => {
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
    await m.select(0, 2); // b.txt with a preview
    expect(m.getPreview().path).toBe("/root/b.txt");
    // external delete + rename: b.txt gone, z.txt appeared
    fs.tree["/root"] = [
      { name: "sub", isDir: true, abs: "/root/sub" },
      { name: "a.txt", isDir: false, abs: "/root/a.txt", size: 12, mtimeMs: 1 },
      { name: "z.txt", isDir: false, abs: "/root/z.txt", size: 3, mtimeMs: 9 },
    ];
    await m.reload();
    const names = m.getColumns()[0]!.entries.map((e) => e.name);
    expect(names).toEqual(["sub", "a.txt", "z.txt"]);
    expect(names).not.toContain("b.txt");
    // the vanished file's preview must not linger
    expect(m.getPreview().path).toBeNull();
  });

  test("reload keeps the column stack and the row cursor", async () => {
    const fs = makeFs();
    const m = makeColumnsModel({ cwd: "/root", showHidden: false, sortBy: "name", sortAsc: true, listDir: fs.listDir });
    await m.init();
    await m.select(0, 0); // root + sub
    await m.moveRow(1); // c.txt in the sub column
    expect(m.getActiveCol()).toBe(1);
    await m.reload();
    expect(m.getColumns().map((c) => c.dir)).toEqual(["/root", "/root/sub"]);
    expect(m.getActiveCol()).toBe(1);
    expect(m.getColumns()[1]!.sel).toBe(1);
  });

  test("reload recovers an initially empty folder once it fills", async () => {
    const tree: Record<string, Entry[]> = { "/root": [] };
    const m = makeColumnsModel({
      cwd: "/root",
      showHidden: false,
      sortBy: "name",
      sortAsc: true,
      listDir: async (dir) => tree[dir] ?? [],
    });
    await m.init();
    expect(m.getColumns()).toHaveLength(1);
    tree["/root"] = [{ name: "later.txt", isDir: false, abs: "/root/later.txt", size: 1, mtimeMs: 1 }];
    await m.reload();
    expect(m.getColumns()[0]!.entries.map((e) => e.name)).toEqual(["later.txt"]);
  });
});

describe("columns key claims (modifiers/remaps fall through)", () => {
  const COLORS: any = {
    bg: "#111111",
    hoverBg: "#222222",
    accent: "#7aa2f7",
    accentBg: "#333333",
    sidebarFg: "#aaaaaa",
    sidebarFgMuted: "#666666",
    divider: "#333333",
  };
  const defaults: Record<string, string[]> = {
    moveLeft: ["left"],
    moveRight: ["right"],
    moveUp: ["up"],
    moveDown: ["down"],
    openSelected: ["return", "enter"],
    parentDir: ["backspace"],
  };
  const makeRenderer = (binds: Record<string, string[]> | null) => {
    const ctx: GridRendererCtx = {
      termW: () => 80,
      termH: () => 24,
      scroller: () => null,
      state: { cwd: "/root", showHidden: false, sortBy: "name", sortAsc: true },
      searchQuery: () => "",
      recursiveSearch: () => false,
      pathEditMode: () => false,
      sw: () => 0,
      tileW: () => 10,
      tileH: () => 3,
      iconCells: () => 2,
      listRowH: () => 1,
      uiStyle: () => "solid",
      colors: () => COLORS,
      previewEnabled: () => false,
      previewWidth: () => 0,
      viewMode: () => "columns",
      wrapMode: () => "none",
      reservedRight: () => 0,
      cellMetrics: () => ({ cellW: 10, cellH: 20, aspect: 0.5 }),
      makeIconSlot: () => ({ el: null, slotId: "s", spec: {} }) as any,
      pushThumbJob: () => {},
      nextIconId: () => "x",
      drainIconQueue: () => {},
      drainThumbs: () => {},
      stripSelectable: () => {},
      waitForResolution: async () => {},
      clearRenameEdit: () => {},
      selection: {} as any,
      entryMouseHandlers: () => ({}) as any,
      isCutKey: () => false,
      fileAnim: () => null,
      fileAnimVisibleOnly: () => false,
      ...(binds ? { keybinds: (a: KeyAction) => binds[a] ?? [] } : {}),
    };
    return makeColumnsRenderer(ctx);
  };

  test("plain arrows/enter/backspace are claimed", () => {
    const r = makeRenderer(defaults);
    expect(r.handleKey({ name: "left" })).toBe(true);
    expect(r.handleKey({ name: "right" })).toBe(true);
    expect(r.handleKey({ name: "up" })).toBe(true);
    expect(r.handleKey({ name: "down" })).toBe(true);
    expect(r.handleKey({ name: "return" })).toBe(true);
    expect(r.handleKey({ name: "backspace" })).toBe(true);
  });

  test("modifier chords fall through (alt+left history, alt+up parent, shift+arrow extend)", () => {
    const r = makeRenderer(defaults);
    expect(r.handleKey({ name: "left", meta: true })).toBe(false);
    expect(r.handleKey({ name: "up", option: true })).toBe(false);
    expect(r.handleKey({ name: "down", shift: true })).toBe(false);
    expect(r.handleKey({ name: "right", super: true })).toBe(false);
  });

  test("a remap moves the claim to the new key and frees the old one", () => {
    const r = makeRenderer({ ...defaults, moveLeft: ["ctrl+b"] });
    expect(r.handleKey({ name: "left" })).toBe(false);
    expect(r.handleKey({ name: "b", ctrl: true })).toBe(true);
  });

  test("without a keybind seam only unmodified defaults match (old fakes)", () => {
    const r = makeRenderer(null);
    expect(r.handleKey({ name: "left" })).toBe(true);
    expect(r.handleKey({ name: "left", meta: true })).toBe(false);
  });
});

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
