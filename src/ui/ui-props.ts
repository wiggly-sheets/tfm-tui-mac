import { Box, type MouseEvent, Text } from "@opentui/core";
import { execFile } from "node:child_process";
import { lstatSync, type Stats } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { applySurface, btnSurface, slotBg, type UiStyle } from "./style";
import type { Theme } from "../config/config";
import { fileIconFor, fileIsImage, fileIsVideo } from "../fs/filetype";
import { canThumbVideo } from "./icons";
import type { IconSlotHandle, IconSpec, IconState, SlotElement, ThumbJob } from "./ui-slots";
import { dirWalkStats, fmtBytes, fmtDate, inodeKey, mimeLabelFor, type DirStats } from "../fs/propsinfo";
import { readStarredList, starredRegistryAdd, starredRegistryRemove } from "../fs/recent";
import { isAppBundle, isDarwin, parseMdlsTags, syncStarTag } from "../fs/darwin";
import { isBookmarked, setBookmarked, loadSystemPlaces } from "../fs/places";
import type { ListEntry } from "./ui-menu";
import { FLOAT_Z, type Floats } from "./floats";
import { hoverEvents, IconStateIdx, toggleIconState } from "./ui-slots";
import { mountPermsEditor } from "./ui-props-perms";
import { mountTagsSection } from "./ui-tags";
import type { NotifyLevel } from "../lib/notify-level";
import type { MaybeNode, NodeLike } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";

// --- Properties dialog (floating, right-click -> Properties…): star/bookmark
// toggles, hero icon/thumbnail, nautilus-style permissions editor. Theme +
// renderer arrive via ctx (same seam as ui-dialogs); every tfm-props-* id
// must stay byte-identical for rethemeChrome. ---

// The dialog's ONE explicit state. `closed` = no dialog on screen; `open` =
// a dialog is mounted, `target` is the selection it shows (the repaint
// rebuild uses it) and `gen` is the generation of THIS dialog.
//
// The generation makes the async size walks safe: a walk resolves AFTER the
// user closed the dialog and opened another one. ONE counter, checked by
// EVERY settle, prevents the first dialog's counts from painting into the
// second one in either direction (single -> multi, multi -> single).
type PropsState = { kind: "closed"; gen: number } | { kind: "open"; gen: number; target: string | string[] };

// shared slot/thumb types live in ./ui-slots (the queue they feed) — the old
// byte-identical local mirrors drifted when ui-slots gained a field

type PropsCtx = {
  byId(id: string): MaybeNode;
  openDialog(opts: {
    id: string;
    zIndex: number;
    width: number;
    paddingDiv?: number;
    rows: () => SlotElement[];
    onClose: () => void;
  }): void;
  closeDialog(id: string): void;
  setTextOnId(nodeId: string, s: string): void;
  setOnId(id: string, fn: (n: NodeLike) => void): void;
  stripSelectable(): void;
  drainIconQueue(): void;
  drainThumbs(): void;
  pushThumbJob(job: ThumbJob): void;
  nextIconId(): string;
  escHintBtn(id: string, onClose: () => void): SlotElement;
  closeFileMenu(): void;
  openContextMenu(x: number, y: number, title: string, entries: ListEntry[]): void;
  floats: Floats;
  renderAll(): void;
  notify(msg: string, title?: string, level?: NotifyLevel): void;
  uiStyle(): UiStyle;
  colors(): Theme;
  home: string;
  // live terminal width: fixed-width dialogs clamp to termW-2 on narrow
  // terminals. Absent = the design width (old fakes keep working).
  termW?(): number;
  makeIconSlot(
    name: string,
    states: IconState[],
    heightCells?: number,
    initialState?: number,
    onMouseDown?: (ev: MouseEvent) => void,
    statesFactory?: () => IconState[],
  ): IconSlotHandle;
  setIconState(spec: IconSpec | undefined, stateIdx: number): boolean;
  fallbackGlyphFor(name: string): string;
  cellMetrics(): { aspect: number };
  // the directory-walk seam: the aggregate size of a folder (and of a
  // multi-selection that contains folders). It resolves ASYNCHRONOUSLY, so
  // it is also the seam the generation guard is tested through.
  dirStats?(root: string): Promise<DirStats | null>;
  // tty mode (linux console): hero falls back to the icon slot, the thumb
  // raster could never land. force-glyph does the same for buggy kitty impls.
  // Optional so test fakes keep working.
  isTtyMode?(): boolean;
  forceGlyph?(): boolean;
  // mouse pointer shape (OSC 22 via the wiring's tty-guarded setter).
  // Absent = no pointer changes (old fakes keep working).
  setPointer?(style: PointerStyle): void;
};

const execFileP = promisify(execFile);

export const makeProps = (ctx: PropsCtx) => {
  // --- Properties dialog (floating, right-click -> Properties…) ---
  const PROPS_W = 46;
  // the design width, clamped so the panel never overflows a narrow terminal
  // (min 32 keeps the two-column rows readable)
  const propsW = (): number => Math.max(32, Math.min(PROPS_W, (ctx.termW?.() ?? PROPS_W) - 2));
  // the walk seam: the real dirWalkStats by default, the injected one in
  // tests (the walk resolves on its own schedule, which no test can pin)
  const statsFor = (root: string): Promise<DirStats | null> => (ctx.dirStats ? ctx.dirStats(root) : dirWalkStats(root));
  let propsState: PropsState = { kind: "closed", gen: 0 };

  // raw teardown — registered with floats at open time; the public closeProps
  // is floats.close("props"), which also takes any popup spawned on top of
  // the dialog (the permission menu) with it
  const rawCloseProps = (): void => {
    ctx.closeDialog("tfm-props");
    // the generation SURVIVES the close: the next open is a NEW generation,
    // so a walk still in flight from the closed dialog stays stale
    propsState = { kind: "closed", gen: propsState.gen };
    // hovered toggles/rows have no out (their nodes are gone) — restore here
    ctx.setPointer?.("default");
  };
  const closeProps = (): void => {
    ctx.floats.close("props");
  };

  // shared preamble: floats open + the (empty) dialog skeleton + panel
  // lookup — single and multi selection open the same shell
  const openPropsDialog = (target: string | string[]): MaybeNode => {
    // the state is set AFTER floats.open: opening props can dismiss a
    // PREVIOUS props dialog, and that teardown writes the closed state
    const gen = propsState.gen + 1;
    ctx.floats.open("props", rawCloseProps);
    propsState = { kind: "open", gen, target };
    ctx.openDialog({
      id: "tfm-props",
      zIndex: FLOAT_Z.props,
      width: propsW(),
      paddingDiv: 4,
      rows: () => [],
      onClose: () => closeProps(),
    });
    return ctx.byId("tfm-props-panel");
  };

  // the generation of the dialog on screen — every async settle captures it
  // and refuses to paint once the state moved on
  const currentGen = (): number => propsState.gen;
  const isCurrent = (gen: number): boolean => propsState.kind === "open" && propsState.gen === gen;

  const openSingle = (targetPath: string): void => {
    const colors = ctx.colors();
    const W = propsW();
    let st: Stats | null = null;
    try {
      // on-disk cost: a symlink reports its own bytes, never the target's
      // (copies preserve links; broken links stay openable instead of
      // toasting "source gone")
      st = lstatSync(targetPath);
    } catch {
      // right-click → Properties on a just-deleted file must say so, not blink
      ctx.notify("Can't show properties (source gone)", "properties", "error");
      return;
    }
    const isDirTarget = st.isDirectory();

    const panel = openPropsDialog(targetPath);
    if (!panel) return;

    // star & bookmark are on/off toggles AND hovers — 4 baked rasters each
    // (idx = on*1 + hover*2), plus matching wrapper-box bg swaps. The rasters
    // flatten onto the DIALOG's fill (role "float"): the dialog is filled in
    // solid + outline-partial, so the chrome role would bake a canvas-colored
    // square into the panel.
    const propsToggleStates = (): IconState[] => [
      { fg: colors.sidebarFgMuted, bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg, "float") },
      { fg: colors.accent, bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg, "float") },
      { fg: colors.sidebarFgMuted, bg: colors.hoverBg },
      { fg: colors.accent, bg: colors.hoverBg },
    ];
    const propsTogglePaint = (btnId: string, spec: IconSpec | undefined, on: boolean, hover: boolean) => {
      ctx.setIconState(spec, toggleIconState(on, hover));
      try {
        const n = ctx.byId(btnId);
        if (n) applySurface(n, btnSurface(ctx.uiStyle(), colors, hover, colors.sidebarBg));
      } catch {}
    };

    const starSlot = ctx.makeIconSlot("star", propsToggleStates(), 1, 0, () => {
      starred = !starred;
      propsTogglePaint("tfm-props-star", starSlot.spec, starred, starHover);
      if (starred) starredRegistryAdd(targetPath);
      else starredRegistryRemove(targetPath);
      if (isDarwin()) {
        // Finder tags via the `tag` CLI only. Without it the tfm starred
        // registry (above) is the source of truth — never the tags xattr.
        syncStarTag(
          {
            which: (bin) => Bun.which(bin),
            exec: (bin, args) => execFileP(bin, args, { timeout: 10_000 }).catch(() => {}),
          },
          starred,
          targetPath,
        );
        return;
      }
      void execFileP("gio", ["set", "-t", "string", targetPath, "metadata::starred", starred ? "true" : ""], {
        timeout: 10_000,
      }).catch(() => {});
    });
    let starHover = false;
    let starred = readStarredList().includes(targetPath);
    if (starred) ctx.setIconState(starSlot.spec, IconStateIdx.Active);
    if (isDarwin()) {
      // adopt Finder-side stars (mdls user tags); missing mdls/tag stays silent
      void execFileP("mdls", ["-raw", "-name", "kMDItemUserTags", targetPath], { timeout: 10_000 })
        .then(({ stdout }) => {
          if (parseMdlsTags(String(stdout ?? "")).includes("Starred") && !starred) {
            starred = true;
            starredRegistryAdd(targetPath); // adopt stars made outside tfm
          }
          ctx.setIconState(starSlot.spec, toggleIconState(starred, starHover));
        })
        .catch(() => {});
    } else {
      void execFileP("gio", ["info", "-a", "metadata::starred", targetPath], { timeout: 10_000 })
        .then(({ stdout }) => {
          const m = stdout.match(/metadata::starred:\s*(\S+)/);
          const gioStarred = !!m && m[1] !== "";
          if (gioStarred && !starred) {
            starred = true;
            starredRegistryAdd(targetPath); // adopt stars made outside tfm
          }
          ctx.setIconState(starSlot.spec, toggleIconState(starred, starHover));
        })
        .catch(() => {});
    }
    // folders can be bookmarked (gtk bookmarks → sidebar); files can't.
    // created unconditionally like starSlot — just not rendered for files
    let bmHover = false;
    let bookmarked = isBookmarked(targetPath);
    const bmSlot = ctx.makeIconSlot("bookmark", propsToggleStates(), 1, toggleIconState(bookmarked, false), () => {
      bookmarked = !bookmarked;
      propsTogglePaint("tfm-props-bm", bmSlot.spec, bookmarked, bmHover);
      void setBookmarked(targetPath, bookmarked)
        .then(() => loadSystemPlaces())
        .then(() => ctx.renderAll());
    });
    panel.add(
      Box(
        { width: "100%", height: 1, flexDirection: "row", alignItems: "center" },
        (() => {
          const b = Box(
            {
              id: "tfm-props-star",
              paddingLeft: 1,
              ...btnSurface(ctx.uiStyle(), colors, false, colors.sidebarBg),
              ...hoverEvents((on) => {
                starHover = on;
                propsTogglePaint("tfm-props-star", starSlot.spec, starred, on);
              }, ctx.setPointer),
            },
            starSlot.el,
          );
          return b;
        })(),
        ...(isDirTarget
          ? [
              Box(
                {
                  id: "tfm-props-bm",
                  paddingLeft: 1,
                  ...btnSurface(ctx.uiStyle(), colors, false, colors.sidebarBg),
                  ...hoverEvents((on) => {
                    bmHover = on;
                    propsTogglePaint("tfm-props-bm", bmSlot.spec, bookmarked, on);
                  }, ctx.setPointer),
                },
                bmSlot.el,
              ),
            ]
          : []),
        Box({ flexGrow: 1 }),
        ctx.escHintBtn("tfm-esc-props", closeProps),
      ),
    );

    // hero: big category icon below the title, or the actual picture for images
    const iconName = isDirTarget ? "folder" : fileIconFor(targetPath);
    const ICON_H = 6;
    const { aspect } = ctx.cellMetrics();
    const heroW = Math.max(1, Math.round(aspect * ICON_H));
    const isVideo = !isDirTarget && fileIsVideo(targetPath);
    const wantsThumb =
      !ctx.isTtyMode?.() &&
      !ctx.forceGlyph?.() &&
      !isDirTarget &&
      (fileIsImage(targetPath) || (isVideo && canThumbVideo())) &&
      st.size > 0 &&
      st.size <= 26214400;
    let heroEl: SlotElement;
    if (wantsThumb) {
      const slotId = ctx.nextIconId();
      // flex row + center, exactly like the grid/list thumb slots: the raster
      // is narrower than the slot when the image aspect differs from the cell
      // aspect, and without this it sits left-aligned instead of centered
      heroEl = Box({ id: slotId, width: heroW, height: ICON_H, flexDirection: "row", justifyContent: "center" });
      ctx.pushThumbJob({
        slotId,
        path: targetPath,
        mtimeMs: st.mtimeMs ?? 0,
        size: st.size,
        wCells: heroW,
        hCells: ICON_H,
        bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg, "float"),
        vector: targetPath.toLowerCase().endsWith(".svg"),
        video: isVideo,
        fallbackGlyph: ctx.fallbackGlyphFor(iconName),
        priority: true,
      });
    } else {
      heroEl = ctx.makeIconSlot(
        iconName,
        [{ fg: colors.white, bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg, "float") }],
        ICON_H,
      ).el;
    }
    panel.add(
      Box(
        {
          width: "100%",
          height: ICON_H + 1,
          flexDirection: "row",
          justifyContent: "center",
          alignItems: "center",
          // kitty rasters are fixed pixel surfaces (cell box minus the 2px
          // bleed inset) anchored at the slot's top-left, so they read one
          // cell right of the flex-centered box — nudge the whole hero left
          paddingRight: 2,
        },
        heroEl,
      ),
    );
    // one blank row of breathing room between the hero and the filename
    // (a plain " " measures empty — the nbsp forces the row to lay out)
    panel.add(Box({ width: "100%", height: 1 }, Text({ content: "\u00A0" })));
    panel.add(
      Box(
        { width: "100%", height: 1, flexDirection: "row", justifyContent: "center", paddingLeft: 1, paddingRight: 1 },
        Text({
          content:
            path.basename(targetPath).length > W - 4
              ? `${path.basename(targetPath).slice(0, W - 5)}…`
              : path.basename(targetPath),
          fg: colors.white,
        }),
      ),
    );
    panel.add(
      Box(
        { width: "100%", height: 1, flexDirection: "row", justifyContent: "center", paddingLeft: 1, paddingRight: 1 },
        Text({
          id: "tfm-props-size",
          content: isDirTarget ? "calculating…" : `${fmtBytes(st.size ?? 0)} (${st.size ?? 0} bytes)`,
          fg: colors.accent,
        }),
      ),
    );
    panel.add(
      Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: ` ${"~".repeat(W - 2)}`, fg: colors.divider }),
      ),
    );

    const row = (label: string, value: string, id?: string) => {
      const v = String(value);
      return Box(
        { width: "100%", height: 1, flexDirection: "row", paddingLeft: 1 },
        Text({ content: ` ${label}`.padEnd(12), fg: colors.sidebarFgMuted }),
        Text({
          ...(id ? { id } : {}),
          content: v.length > W - 14 ? `${v.slice(0, W - 15)}…` : v,
          fg: colors.white,
        }),
      );
    };

    if (isDirTarget) {
      // generation guard: closing and reopening Properties must not paint
      // THIS walk's stats into the new dialog (one counter, every path)
      const walkGen = currentGen();
      void statsFor(targetPath).then((s) => {
        if (!isCurrent(walkGen)) return;
        const n = ctx.byId("tfm-props-size");
        if (!n) return;
        try {
          n.content = s
            ? `${fmtBytes(s.bytes)} · ${s.files} files · ${s.folders} folders`
            : // dirWalkStats gives up past 200k entries (null) — say that
              // instead of a bare word that reads like a bug
              "200k+ entries — too large to scan";
        } catch {}
      });
    }
    panel.add(
      row(
        "type",
        isDirTarget
          ? isDarwin() && isAppBundle(targetPath)
            ? "application/x-mac-application"
            : "inode/directory"
          : mimeLabelFor(targetPath),
      ),
    );
    panel.add(row("location", path.dirname(targetPath).replace(ctx.home, "~")));
    panel.add(row("modified", fmtDate(st.mtimeMs)));
    panel.add(row("accessed", fmtDate(st.atimeMs)));

    // --- nautilus-style permissions editor: widget + state live in
    // ./ui-props-perms (perm-class menu, exec checkbox, chmod plumbing) ---
    mountPermsEditor(
      {
        byId: ctx.byId,
        setTextOnId: ctx.setTextOnId,
        setOnId: ctx.setOnId,
        openContextMenu: ctx.openContextMenu,
        closeFileMenu: ctx.closeFileMenu,
        notify: ctx.notify,
        uiStyle: ctx.uiStyle,
        colors: () => colors,
        makeIconSlot: ctx.makeIconSlot,
      },
      { panel, targetPath, st, isDirTarget, row },
    );
    // Finder tags (macOS only — the helper no-ops elsewhere)
    mountTagsSection(
      {
        byId: ctx.byId,
        setOnId: ctx.setOnId,
        colors: () => colors,
        uiStyle: ctx.uiStyle,
        setPointer: ctx.setPointer,
      },
      panel,
      [targetPath],
    );
    ctx.stripSelectable();
    void ctx.drainIconQueue();
    void ctx.drainThumbs();
  };

  // --- multi-selection properties: count + aggregate size + capped name
  // list; no star/bookmark/perms (those are per-file semantics) ---
  const PROPS_LIST_MAX = 6;

  const openMulti = (items: { path: string; st: Stats }[], target: string | string[]): void => {
    const colors = ctx.colors();
    const W = propsW();
    const panel = openPropsDialog(target);
    if (!panel) return;

    panel.add(
      Box(
        { width: "100%", height: 1, flexDirection: "row" },
        Box({ flexGrow: 1 }),
        ctx.escHintBtn("tfm-esc-props", closeProps),
      ),
    );

    const ICON_H = 6;
    const heroEl = ctx.makeIconSlot(
      "select-all",
      [{ fg: colors.white, bg: slotBg(ctx.uiStyle(), colors, colors.sidebarBg, "float") }],
      ICON_H,
    ).el;
    panel.add(
      Box(
        {
          width: "100%",
          height: ICON_H + 1,
          flexDirection: "row",
          justifyContent: "center",
          alignItems: "center",
          // same raster offset as the single-file hero (see above)
          paddingRight: 2,
        },
        heroEl,
      ),
    );
    panel.add(
      Box(
        { width: "100%", height: 1, flexDirection: "row", justifyContent: "center", paddingLeft: 1, paddingRight: 1 },
        Text({ content: `${items.length} items selected`, fg: colors.white }),
      ),
    );
    panel.add(
      Box(
        { width: "100%", height: 1, flexDirection: "row", justifyContent: "center", paddingLeft: 1, paddingRight: 1 },
        Text({ id: "tfm-props-size", content: "calculating…", fg: colors.accent }),
      ),
    );
    panel.add(
      Box(
        { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
        Text({ content: ` ${"~".repeat(W - 2)}`, fg: colors.divider }),
      ),
    );

    // aggregate size: files are already stat'd, folders walk async (same
    // settle-guarded byId update as the single-dir flow)
    let totalBytes = 0;
    let nFiles = 0;
    let nFolders = 0;
    const dirPaths: string[] = [];
    // Stats arrive via lstat (openProperties), so links never masquerade as
    // dirs here; bodies shared by hardlinks count once, like the status bar.
    const seen = new Set<string>();
    for (const it of items) {
      if (it.st.isDirectory()) dirPaths.push(it.path);
      else {
        const k = inodeKey(it.st);
        if (!seen.has(k)) {
          seen.add(k);
          totalBytes += it.st.size ?? 0;
        }
        nFiles++;
      }
    }
    // the generation of THIS dialog — the walk below resolves long after the
    // user may have closed it and opened another one
    const walkGen = currentGen();
    const settle = (): void => {
      if (!isCurrent(walkGen)) return;
      const n = ctx.byId("tfm-props-size");
      if (n) {
        const counts = dirPaths.length ? ` · ${nFiles} files · ${nFolders} folders` : ` · ${nFiles} files`;
        try {
          n.content = `${fmtBytes(totalBytes)}${counts}`;
        } catch {}
      }
    };
    if (dirPaths.length) {
      void Promise.all(dirPaths.map((d) => statsFor(d))).then((walks) => {
        for (const s of walks) {
          if (s) {
            totalBytes += s.bytes;
            nFiles += s.files;
            nFolders += s.folders;
          }
        }
        settle();
      });
    } else {
      settle();
    }

    const shown = items.slice(0, PROPS_LIST_MAX);
    for (const it of shown) {
      panel.add(
        Box(
          { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
          Text({
            content: (() => {
              const s = ` ${path.basename(it.path)}`;
              return s.length > W - 1 ? `${s.slice(0, W - 2)}…` : s;
            })(),
            fg: colors.white,
          }),
        ),
      );
    }
    if (items.length > PROPS_LIST_MAX) {
      panel.add(
        Box(
          { width: "100%", height: 1, paddingLeft: 1, paddingRight: 1 },
          Text({ content: ` …and ${items.length - PROPS_LIST_MAX} more`, fg: colors.sidebarFgMuted }),
        ),
      );
    }
    // Finder tags apply to the whole selection (macOS only; no-op elsewhere)
    mountTagsSection(
      {
        byId: ctx.byId,
        setOnId: ctx.setOnId,
        colors: () => colors,
        uiStyle: ctx.uiStyle,
        setPointer: ctx.setPointer,
      },
      panel,
      items.map((it) => it.path),
    );
    ctx.stripSelectable();
    void ctx.drainIconQueue();
  };

  const openProperties = (target: string | string[]): void => {
    if (!Array.isArray(target)) {
      openSingle(target);
      return;
    }
    const stats: { path: string; st: Stats }[] = [];
    for (const p of target) {
      try {
        stats.push({ path: p, st: lstatSync(p) });
      } catch {}
    }
    // nothing survives (all sources vanished since the selection was made):
    // say so instead of a silent no-op
    if (stats.length === 0) {
      ctx.notify("Can't show properties (source gone)", "properties", "error");
      return;
    }
    const only = stats[0];
    if (stats.length === 1 && only) {
      openSingle(only.path);
      return;
    }
    // the ORIGINAL selection is the retained target: the repaint re-filters
    // it, so a path that vanished in the meantime simply drops out
    if (stats.length > 1) openMulti(stats, target);
  };

  // theme-switch repaint while open: rebuild with the retained target (live
  // colors throughout — icon slots, rows, perms, tags). Only the tag field
  // holds user input, so a theme flip mid-type drops the unsubmitted tag; the
  // perm-class cursor popup above the dialog (if any) closes with the rebuild
  // by floats policy.
  const repaint = (): void => {
    if (propsState.kind !== "open") return;
    const target = propsState.target;
    try {
      closeProps();
    } catch {}
    try {
      openProperties(target);
    } catch {}
  };

  return { openProperties, closeProps, isOpen: () => propsState.kind === "open", repaint };
};
