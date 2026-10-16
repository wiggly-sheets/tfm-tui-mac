// --- Go to Folder popup (Finder's Shift+Cmd+G): a centered floating panel
// with a path Input + live directory completion. Resolution reuses the path
// edit's rules (leading ~ expands to home, relative paths resolve against the
// active pane's cwd) and isNavigableTarget decides whether Enter may jump.
// The fs is behind an injectable lister so resolution/completion stay headless.
// Widget-extraction seam (see ui-dialogs.ts): live deps arrive via ctx. ---

import { Box, type CliRenderer, type KeyEvent, Input, Text } from "@opentui/core";
import path from "node:path";
import { readdirSync } from "node:fs";
import type { Theme } from "../config/config";
import { makeModalScrim } from "./ui-dialogs";
import { isNavigableTarget } from "./ui-toolbar";
import type { UiStyle } from "../config/config-schema";
import type { Floats } from "./floats";
import type { MaybeNode } from "../lib/node-like";
import type { NotifyLevel } from "../lib/notify-level";
import type { PointerStyle } from "../lib/pointer";
import type { SlotElement } from "./ui-slots";

export type DirEntry = { name: string; isDir: boolean };
export type DirLister = (dir: string) => DirEntry[];

// real-fs default: one readdir, errors (missing/permission) read as empty
export const defaultDirLister: DirLister = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }
};

// same rule as the breadcrumb path edit: a leading ~ (alone or before /) is home
export const expandTilde = (input: string, home: string): string => input.replace(/^~(?=\/|$)/, home);

// absolute target the input points at (no existence check): absolute stays,
// ~ expands, relative resolves against cwd. Empty input resolves to cwd.
export const resolveGotoPath = (input: string, home: string, cwd: string): string =>
  path.resolve(cwd, expandTilde(input, home));

// directory suggestions for the CURRENT input: the parent dir it names plus its
// typed basename prefix (empty after a trailing slash = list everything).
export const completeGotoPath = (
  input: string,
  home: string,
  cwd: string,
  list: DirLister,
): { base: string; dirs: string[] } => {
  const expanded = expandTilde(input, home);
  const trailingSep = expanded.endsWith(path.sep);
  const base = path.resolve(cwd, trailingSep ? expanded : path.dirname(expanded));
  const prefix = trailingSep ? "" : path.basename(expanded);
  const dirs = list(base)
    .filter((e) => e.isDir && e.name.startsWith(prefix))
    .map((e) => path.join(base, e.name))
    .sort();
  return { base, dirs };
};

type GoToCtx = {
  renderer(): CliRenderer;
  byId(id: string): MaybeNode;
  rootAdd(node: unknown): void;
  destroyChildren(node: unknown): void;
  stripSelectable(): void;
  colors(): Theme;
  uiStyle(): UiStyle;
  floats: Floats;
  escHintBtn(id: string, onClose: () => void): SlotElement;
  drainIconQueue(): void | Promise<void>;
  cwd(): string;
  home: string;
  navigate(dir: string): void;
  notify(msg: string, title?: string, level?: NotifyLevel): void;
  // injectable for headless tests (default = real readdir); isNavigable mirrors
  // the path edit's commit check (default = isNavigableTarget)
  list?: DirLister;
  isNavigable?: (target: string) => boolean;
  setPointer?(style: PointerStyle): void;
};

const PANEL_W = 60;
const MAX_ROWS = 6;

export const makeGoToFolder = (ctx: GoToCtx) => {
  let opened = false;
  let suggestions: string[] = [];
  let selIdx = -1;

  const lister = (): DirLister => ctx.list ?? defaultDirLister;
  const navigable = (target: string): boolean => (ctx.isNavigable ?? isNavigableTarget)(target);

  const readValue = (): string => {
    try {
      return String(ctx.byId("tfm-goto-input")?.value ?? "");
    } catch {
      return "";
    }
  };

  const rawClose = (): void => {
    opened = false;
    suggestions = [];
    selIdx = -1;
    try {
      ctx.byId("tfm-goto-input")?.blur?.();
    } catch {}
    const scrim = ctx.byId("tfm-goto");
    scrim?.parent?.remove(scrim);
    ctx.setPointer?.("default");
  };

  const close = (): void => {
    ctx.floats.close("gotofolder");
  };

  const renderList = (): void => {
    const list = ctx.byId("tfm-goto-list");
    if (!list) return;
    const colors = ctx.colors();
    ctx.destroyChildren(list);
    suggestions.slice(0, MAX_ROWS).forEach((dir, i) => {
      const active = i === selIdx;
      list.add(
        Box(
          {
            id: `tfm-goto-row-${i}`,
            width: "100%",
            height: 1,
            paddingLeft: 2,
            paddingRight: 1,
            backgroundColor: active ? colors.accentBg : undefined,
            onMouseDown: () => {
              setInput(dir);
            },
          },
          Text({ content: dir, fg: active ? colors.white : colors.sidebarFgMuted }),
        ),
      );
    });
  };

  // recompute suggestions from the current input and repaint the list
  // shortcut: one sync readdir per keystroke (a single dir is cheap); swap the
  // injected lister for a debounced/async one if a folder ever hitches on input
  const refresh = (): void => {
    suggestions = completeGotoPath(readValue(), ctx.home, ctx.cwd(), lister()).dirs;
    if (selIdx >= suggestions.length) selIdx = -1;
    renderList();
  };

  const setInput = (value: string): void => {
    try {
      const input = ctx.byId("tfm-goto-input");
      if (input) input.value = value;
    } catch {}
    selIdx = -1;
    refresh();
  };

  // Tab / click: fill the highlighted (or first) suggestion and keep typing
  const complete = (): void => {
    if (!suggestions.length) return;
    const pick = suggestions[selIdx] ?? suggestions[0];
    if (pick) setInput(pick + path.sep);
  };

  // up/down walk the suggestion cursor (down from nothing picks the first)
  const moveCursor = (delta: number): void => {
    if (!suggestions.length) return;
    selIdx = delta < 0 ? (selIdx <= 0 ? suggestions.length : selIdx) - 1 : (selIdx + 1) % suggestions.length;
    renderList();
  };

  const submit = (): void => {
    const raw = readValue().trim();
    if (!raw) return; // nothing typed: leave the popup open
    const target = resolveGotoPath(raw, ctx.home, ctx.cwd());
    if (!navigable(target)) {
      ctx.notify(`No such folder: ${target}`, "navigate", "error");
      return;
    }
    close();
    ctx.navigate(target);
  };

  const open = (): void => {
    if (opened) close();
    ctx.floats.open("gotofolder", rawClose);
    opened = true;
    suggestions = [];
    selIdx = -1;
    const c = ctx.colors();
    const scrim = makeModalScrim(
      { uiStyle: ctx.uiStyle, colors: ctx.colors },
      {
        id: "tfm-goto",
        zIndex: 3750,
        panelWidth: PANEL_W,
        onClose: () => close(),
      },
      Box(
        { width: "100%", height: 1, flexDirection: "row", alignItems: "center", paddingLeft: 2, paddingRight: 1 },
        Text({ id: "tfm-goto-title", content: "Go to Folder", fg: c.accent }),
        Box({ flexGrow: 1 }),
        ctx.escHintBtn("tfm-goto-esc", () => close()),
      ),
      Box(
        // no fixed height: height 1 + paddingTop 1 overflows a 1-row box
        { width: "100%", paddingLeft: 2, paddingRight: 2, paddingTop: 1 },
        Input({
          id: "tfm-goto-input",
          width: PANEL_W - 6,
          placeholder: "Path (Tab completes)",
          backgroundColor: c.accentBg,
          focusedBackgroundColor: c.accentBg,
          textColor: c.white,
        }),
      ),
      Box({ id: "tfm-goto-list", width: "100%", flexDirection: "column", paddingTop: 1 }),
    );
    ctx.rootAdd(scrim);
    ctx.stripSelectable();
    void ctx.drainIconQueue();
    const input = ctx.byId("tfm-goto-input");
    const prevHandler = input?.handleKeyPress?.bind(input);
    if (input) {
      input.on?.("input", refresh);
      // intercept enter/tab/arrows at the source (focused Inputs consume keys
      // before the global handler, same lesson as the path edit)
      input.handleKeyPress = (key: KeyEvent) => {
        if (key?.name === "escape") {
          close();
          return true;
        }
        if (key?.name === "return") {
          submit();
          return true;
        }
        if (key?.name === "tab") {
          complete();
          return true;
        }
        if (key?.name === "up" || key?.name === "down") {
          moveCursor(key.name === "up" ? -1 : 1);
          return true;
        }
        return prevHandler ? prevHandler(key) : false;
      };
    }
    // focus after mount (same deferred pattern as pick/prompt)
    setTimeout(() => {
      try {
        ctx.byId("tfm-goto-input")?.focus?.();
      } catch {}
    }, 10);
    refresh();
  };

  // router fallback (the input usually consumes these first — see the source
  // handler in open()); keeps esc/enter/tab alive even before focus lands
  const handleKey = (ev: { name?: string }): boolean => {
    if (ev.name === "escape") close();
    else if (ev.name === "return") submit();
    else if (ev.name === "tab") complete();
    else if (ev.name === "up") moveCursor(-1);
    else if (ev.name === "down") moveCursor(1);
    return true;
  };

  return {
    open,
    close,
    handleKey,
    isOpen: (): boolean => opened,
    // test seams: drive the value + read live suggestions without Input events
    setValue: (v: string): void => setInput(v),
    suggestions: (): string[] => suggestions,
  };
};
