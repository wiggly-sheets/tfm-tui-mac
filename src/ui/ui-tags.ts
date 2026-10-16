import { Box, Input, type KeyEvent, type MouseEvent, Text } from "@opentui/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { destroyChildren } from "../lib/uiutil";
import { applySurface, btnSurface, rowSurface, type UiStyle } from "./style";
import type { Theme } from "../config/config";
import { isDarwin, mergeTagChange, readFinderTags, tagAddArgs, tagRemoveArgs, writeFinderTags } from "../fs/darwin";
import { hoverEvents } from "./ui-slots";
import type { MaybeNode, NodeLike } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";

// --- Finder tag section of the Properties dialog (macOS only): current tags
// read async via mdls (never blocks render), add/remove written through the
// `tag` CLI. The tag field is an inline Input — the reusable prompt overlay
// would tear the dialog down, because floats' modal policy closes props when
// another modal opens. Linux mounts nothing (Finder tags are darwin-only). ---

const execFileP = promisify(execFile);

export const TAG_LIST_ID = "tfm-props-tags-list";
export const TAG_INPUT_ID = "tfm-props-tags-input";
export const TAG_ADD_ID = "tfm-props-tags-add";

export type TagsCtx = {
  byId(id: string): MaybeNode;
  setOnId(id: string, fn: (n: NodeLike) => void): void;
  colors(): Theme;
  uiStyle(): UiStyle;
  setPointer?(style: PointerStyle): void;
};

const read = (p: string): Promise<string[]> =>
  readFinderTags({ run: (bin, args) => execFileP(bin, args, { timeout: 10_000 }) }, p);

const write = (argvs: string[][]): void =>
  writeFinderTags(
    {
      which: (bin) => Bun.which(bin),
      exec: (bin, args) => execFileP(bin, args, { timeout: 10_000 }).catch(() => {}),
    },
    argvs,
  );

// one section per open Properties dialog; `paths` is the selection the edits
// apply to (single file or the whole multi-selection).
export const mountTagsSection = (ctx: TagsCtx, panel: NodeLike, paths: string[]): void => {
  if (!isDarwin() || !paths.length) return;
  const colors = ctx.colors();

  // union across the selection; a single file is just its own tags
  let tags: string[] = [];

  panel.add(Box({ width: "100%", height: 1, paddingLeft: 1 }, Text({ content: " tags", fg: colors.sidebarFgMuted })));
  const list = Box({ id: TAG_LIST_ID, width: "100%", flexDirection: "column" });
  panel.add(list);

  const renderList = (): void => {
    // the async mdls read may land after the dialog closed — a reaped node
    // would throw on add
    if (list.isDestroyed) return;
    destroyChildren(list);
    tags.forEach((tag, i) => {
      const rowId = `tfm-props-tag-${i}`;
      list.add(
        Box(
          {
            id: rowId,
            width: "100%",
            height: 1,
            paddingLeft: 1,
            paddingRight: 1,
            ...rowSurface(ctx.uiStyle(), colors, "rest"),
            onMouseDown: (ev: MouseEvent) => {
              try {
                ev.stopPropagation?.();
              } catch {}
              removeTag(tag);
            },
            ...hoverEvents(
              (on) =>
                ctx.setOnId(rowId, (n) =>
                  applySurface(n, on ? { backgroundColor: colors.hoverBg } : rowSurface(ctx.uiStyle(), colors, "rest")),
                ),
              ctx.setPointer,
            ),
          },
          Text({ content: ` ${tag}`, fg: colors.white }),
          Box({ flexGrow: 1 }),
          Text({ content: "× ", fg: colors.sidebarFgMuted }),
        ),
      );
    });
  };

  // re-read mdls after a write and merge the user's intended change in, so the
  // displayed list is accurate even when Spotlight lags the index. Optimistic
  // update stays as the immediate feedback; the re-read only corrects drift.
  const syncAfterWrite = (changes: Array<{ op: "add" | "remove"; tag: string }>): void => {
    void Promise.all(paths.map(read)).then((lists) => {
      const seen = new Set<string>();
      for (const l of lists) for (const t of l) seen.add(t);
      tags = mergeTagChange([...seen], changes);
      renderList();
    });
  };

  const removeTag = (tag: string): void => {
    tags = tags.filter((t) => t !== tag);
    write(paths.map((p) => tagRemoveArgs(tag, p)));
    renderList();
    syncAfterWrite([{ op: "remove", tag }]);
  };

  const addTag = (raw: string): void => {
    const tag = raw.trim();
    if (!tag) return;
    if (!tags.includes(tag)) tags = [...tags, tag].sort((a, b) => a.localeCompare(b));
    write(paths.map((p) => tagAddArgs(tag, p)));
    try {
      const input = ctx.byId(TAG_INPUT_ID);
      if (input) input.value = "";
    } catch {}
    renderList();
    syncAfterWrite([{ op: "add", tag }]);
  };

  const inputEl = Input({
    id: TAG_INPUT_ID,
    width: 30,
    placeholder: "Add tag…",
    backgroundColor: colors.accentBg,
    focusedBackgroundColor: colors.accentBg,
    textColor: colors.white,
  });
  const inputNode = inputEl as unknown as NodeLike;
  // Enter adds while the field is focused — intercept at the source, else the
  // router sees the keypress and closes the dialog (same lesson as ui-goto).
  const prevKey = inputNode.handleKeyPress?.bind(inputNode);
  inputNode.handleKeyPress = (key: KeyEvent) => {
    if (key?.name === "return") {
      addTag(String(ctx.byId(TAG_INPUT_ID)?.value ?? ""));
      return true;
    }
    return prevKey ? prevKey(key) : false;
  };

  const addBtn = Box(
    {
      id: TAG_ADD_ID,
      height: 1,
      paddingLeft: 1,
      paddingRight: 1,
      ...btnSurface(ctx.uiStyle(), colors, false, colors.sidebarBg),
      onMouseDown: (ev: MouseEvent) => {
        try {
          ev.stopPropagation?.();
        } catch {}
        addTag(String(ctx.byId(TAG_INPUT_ID)?.value ?? ""));
      },
      ...hoverEvents(
        (on) =>
          ctx.setOnId(TAG_ADD_ID, (n) => applySurface(n, btnSurface(ctx.uiStyle(), colors, on, colors.sidebarBg))),
        ctx.setPointer,
      ),
    },
    Text({ content: "Add", fg: colors.accent }),
  );
  panel.add(
    Box(
      { width: "100%", height: 1, flexDirection: "row", alignItems: "center", paddingLeft: 1, columnGap: 1 },
      inputEl,
      addBtn,
    ),
  );

  renderList();
  void Promise.all(paths.map(read)).then((lists) => {
    const seen = new Set<string>();
    for (const l of lists) for (const t of l) seen.add(t);
    tags = [...seen].sort((a, b) => a.localeCompare(b));
    renderList();
  });
};
