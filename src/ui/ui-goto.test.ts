// Headless tests for the Go to Folder popup. Resolution/completion are pure
// and take an injected dir lister, so ~, absolute, relative and nonexistent
// paths are covered without touching the real fs; the widget is pinned through
// its public surface (open/setValue/suggestions/handleKey/close).
import { describe, expect, test } from "bun:test";
import { Box } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import {
  completeGotoPath,
  defaultDirLister,
  expandTilde,
  makeGoToFolder,
  resolveGotoPath,
  type DirEntry,
  type DirLister,
} from "./ui-goto";
import { destroyChildren } from "../lib/uiutil";
import { makeFloats } from "./floats";
import { defaultConfig } from "../config/config-schema";
import type { Theme } from "../config/config";
import type { NotifyLevel } from "../lib/notify-level";

const HOME = "/home/zeb";
const CWD = "/work/proj";

// flat fake tree: dir path -> child names
const TREE: Record<string, DirEntry[]> = {
  "/home/zeb": [
    { name: "Documents", isDir: true },
    { name: "Downloads", isDir: true },
    { name: ".zshrc", isDir: false },
  ],
  "/work/proj": [
    { name: "src", isDir: true },
    { name: "scripts", isDir: true },
    { name: "readme.md", isDir: false },
  ],
  "/usr": [{ name: "local", isDir: true }],
  "/usr/local": [{ name: "bin", isDir: true }],
};

const list: DirLister = (dir) => TREE[dir] ?? [];

describe("expandTilde", () => {
  test("expands a leading ~ only", () => {
    expect(expandTilde("~/Doc", HOME)).toBe("/home/zeb/Doc");
    expect(expandTilde("~", HOME)).toBe(HOME);
    expect(expandTilde("/abs", HOME)).toBe("/abs");
    expect(expandTilde("~zeb", HOME)).toBe("~zeb"); // not a home tilde
  });
});

describe("resolveGotoPath", () => {
  test("home, absolute, relative and empty", () => {
    expect(resolveGotoPath("~/Documents", HOME, CWD)).toBe("/home/zeb/Documents");
    expect(resolveGotoPath("/usr/local", HOME, CWD)).toBe("/usr/local");
    expect(resolveGotoPath("src", HOME, CWD)).toBe("/work/proj/src");
    expect(resolveGotoPath("", HOME, CWD)).toBe(CWD);
  });

  test("nonexistent path still resolves (validation happens at commit)", () => {
    expect(resolveGotoPath("/nope/missing", HOME, CWD)).toBe("/nope/missing");
  });
});

describe("completeGotoPath", () => {
  test("tilde prefix lists matching home dirs, files dropped", () => {
    const { base, dirs } = completeGotoPath("~/Do", HOME, CWD, list);
    expect(base).toBe("/home/zeb");
    expect(dirs).toEqual(["/home/zeb/Documents", "/home/zeb/Downloads"]);
  });

  test("absolute prefix completes", () => {
    expect(completeGotoPath("/usr/l", HOME, CWD, list).dirs).toEqual(["/usr/local"]);
  });

  test("relative prefix resolves against cwd", () => {
    expect(completeGotoPath("s", HOME, CWD, list).dirs).toEqual(["/work/proj/scripts", "/work/proj/src"]);
  });

  test("trailing slash lists every child dir", () => {
    expect(completeGotoPath("~/", HOME, CWD, list).dirs).toEqual(["/home/zeb/Documents", "/home/zeb/Downloads"]);
  });

  test("nonexistent base yields no suggestions", () => {
    const { dirs } = completeGotoPath("/nope/x", HOME, CWD, list);
    expect(dirs).toEqual([]);
  });
});

// --- widget smoke: public surface + injected lister, real render root ---

const colors = defaultConfig.theme as Theme;

const mkGoto = (
  t: TestRendererSetup,
  floats: ReturnType<typeof makeFloats>,
  navigate: (dir: string) => void,
  notify: (msg: string, title?: string, level?: NotifyLevel) => void,
) =>
  makeGoToFolder({
    renderer: () => t.renderer,
    byId: (id) => t.renderer.root.findDescendantById(id),
    rootAdd: (n) => t.renderer.root.add(n),
    destroyChildren,
    stripSelectable: () => {},
    colors: () => colors,
    uiStyle: () => "solid",
    floats,
    escHintBtn: (id) => Box({ id, width: 3, height: 1 }),
    drainIconQueue: () => {},
    cwd: () => CWD,
    home: HOME,
    navigate,
    notify,
    list,
    isNavigable: (target) => target === "/home/zeb/Documents" || target === "/work/proj/src",
    setPointer: () => {},
  });

describe("go-to-folder widget", () => {
  test("open mounts panel + input; esc closes", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      const goto = mkGoto(
        t,
        floats,
        () => {},
        () => {},
      );
      goto.open();
      await t.renderOnce();
      expect(t.renderer.root.findDescendantById("tfm-goto")).toBeTruthy();
      expect(t.renderer.root.findDescendantById("tfm-goto-input")).toBeTruthy();
      expect(floats.isOpen("gotofolder")).toBe(true);
      goto.handleKey({ name: "escape" });
      expect(floats.isOpen("gotofolder")).toBe(false);
      expect(t.renderer.root.findDescendantById("tfm-goto")).toBeFalsy();
    } finally {
      t.renderer.destroy();
    }
  });

  test("typing updates suggestions; enter navigates the active pane", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      let jumped = "";
      const goto = mkGoto(
        t,
        floats,
        (dir) => (jumped = dir),
        () => {},
      );
      goto.open();
      await t.renderOnce();
      goto.setValue("~/Do");
      expect(goto.suggestions()).toEqual(["/home/zeb/Documents", "/home/zeb/Downloads"]);
      goto.setValue("~/Documents");
      goto.handleKey({ name: "return" }); // router path; input path is the same submit
      expect(jumped).toBe("/home/zeb/Documents");
      expect(floats.isOpen("gotofolder")).toBe(false);
    } finally {
      t.renderer.destroy();
    }
  });

  test("nonexistent path notifies and stays open", async () => {
    const t = await createTestRenderer({ width: 90, height: 24 });
    try {
      const floats = makeFloats();
      let note = "";
      const goto = mkGoto(
        t,
        floats,
        () => {},
        (m) => (note = m),
      );
      goto.open();
      await t.renderOnce();
      goto.setValue("/nope/missing");
      goto.handleKey({ name: "return" });
      expect(note).toContain("No such folder");
      expect(floats.isOpen("gotofolder")).toBe(true);
    } finally {
      t.renderer.destroy();
    }
  });

  test("defaultDirLister reads a real dir and never throws on a miss", () => {
    expect(defaultDirLister("/definitely/not/here/xyz").length).toBe(0);
    expect(Array.isArray(defaultDirLister(import.meta.dir))).toBe(true);
  });
});
