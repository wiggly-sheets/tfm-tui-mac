// --- Columns (Miller/Finder) view renderer: a horizontal row of narrow
// columns. The leftmost lists the pane's cwd; selecting a directory opens the
// next column with its children (and collapses any columns to its right);
// selecting a file makes the rightmost column show that file's text preview.
// Backspace collapses one column (or goes to the parent dir on the root).
//
// This is a SEPARATE renderer from ui-grid: it reuses the pure entry builders
// (buildListRow via makeGridBuilders) for consistent icon/row rendering, but
// owns its own column-stack state machine and its own scroll containers.

import path from "node:path";
import { stat, readFile } from "node:fs/promises";
import { Box, Text } from "@opentui/core";
import { listDir, type Entry } from "../fs/listing";
import { fmtBytes } from "../fs/propsinfo";
import { destroyChildren } from "../lib/uiutil";
import type { GridRendererCtx } from "./ui-grid-types";
import type { KeyAction } from "../config/config-schema";
import type { KeyEventLike } from "../config/keyspec";
import { keyMatch, parseKeySpec } from "../config/keyspec";
import { isAppBundle, isDarwin } from "../fs/darwin";
import type { SortMode } from "../lib/sort";

const PREVIEW_MAX_BYTES = 1_048_576;
const PREVIEW_MAX_LINES = 2000;

export type ColumnData = {
  dir: string;
  entries: Entry[];
  sel: number;
};

export type ColumnsModelOpts = {
  cwd: string;
  showHidden: boolean;
  sortBy: SortMode;
  sortAsc: boolean;
  listDir?: (dir: string, showHidden: boolean, sortBy: SortMode, sortAsc: boolean) => Promise<Entry[]>;
  readFile?: (filePath: string) => Promise<string | null>;
  openFile?: (filePath: string) => void;
  onNavigate?: (dir: string) => void;
  // active-column entry sink: the wiring feeds the shared selection model, so
  // the status bar / preview / info sidebar and every file action see the
  // columns view's cursor. Empty path = column has no entry.
  onSelect?: (path: string, isDir: boolean) => void;
};

// Pure column-stack state machine: testable without a terminal renderer.
export const makeColumnsModel = (opts: ColumnsModelOpts) => {
  const lister = opts.listDir ?? listDir;
  let columns: ColumnData[] = [];
  let activeCol = 0;
  let previewText: string | null = null;
  let previewFile: string | null = null;

  const getColumns = (): readonly ColumnData[] => columns;
  const getActiveCol = (): number => activeCol;
  const getPreview = (): { path: string | null; text: string | null } => ({
    path: previewFile,
    text: previewText,
  });

  const entryPath = (col: ColumnData, entry: Entry): string => entry.abs ?? path.join(col.dir, entry.name);

  // the active column's entry IS the columns view's cursor
  const emitSelection = (): void => {
    if (!opts.onSelect) return;
    const col = columns[activeCol];
    const entry = col ? col.entries[col.sel] : undefined;
    if (!col || !entry) {
      opts.onSelect("", false);
      return;
    }
    opts.onSelect(entryPath(col, entry), entry.isDir);
  };

  const loadEntries = async (dir: string): Promise<Entry[]> => {
    try {
      const res = await lister(dir, opts.showHidden, opts.sortBy, opts.sortAsc);
      return res;
    } catch {
      return [];
    }
  };

  const loadPreview = async (filePath: string): Promise<void> => {
    previewFile = filePath;
    previewText = null;
    if (opts.readFile) {
      previewText = await opts.readFile(filePath);
      return;
    }
    try {
      const st = await stat(filePath);
      if (st.size > PREVIEW_MAX_BYTES) {
        previewText = `[File too large to preview: ${fmtBytes(st.size)}]`;
        return;
      }
      const raw = await readFile(filePath, "utf8");
      const lines = raw.split("\n").slice(0, PREVIEW_MAX_LINES);
      previewText = lines.join("\n");
      if (lines.length === PREVIEW_MAX_LINES) {
        previewText += `\n[Preview truncated at ${PREVIEW_MAX_LINES} lines]`;
      }
    } catch (err) {
      previewText = `[Error loading preview: ${err instanceof Error ? err.message : String(err)}]`;
    }
  };

  const init = async (dir?: string): Promise<void> => {
    const rootDir = dir ?? opts.cwd;
    const entries = await loadEntries(rootDir);
    columns = [{ dir: rootDir, entries, sel: 0 }];
    activeCol = 0;
    previewText = null;
    previewFile = null;
    emitSelection();
  };

  const updateSelectionForCol = async (colIdx: number, selIdx: number): Promise<void> => {
    const col = columns[colIdx];
    if (!col) return;
    col.sel = Math.max(0, Math.min(selIdx, col.entries.length - 1));
    const entry = col.entries[col.sel];
    if (!entry) {
      columns = columns.slice(0, colIdx + 1);
      previewFile = null;
      previewText = null;
      activeCol = Math.min(activeCol, columns.length - 1);
      return;
    }

    const itemPath = entry.abs ?? path.join(col.dir, entry.name);
    if (entry.isDir) {
      // dir selected: collapse everything past colIdx, push children as colIdx + 1
      const subEntries = await loadEntries(itemPath);
      columns = columns.slice(0, colIdx + 1);
      columns.push({ dir: itemPath, entries: subEntries, sel: 0 });
      activeCol = columns.length - 1;
      previewFile = null;
      previewText = null;
    } else {
      // file selected: collapse everything past colIdx, rightmost shows preview
      columns = columns.slice(0, colIdx + 1);
      activeCol = colIdx;
      await loadPreview(itemPath);
    }
  };

  // Click or arrow select within column `colIdx` at entry `selIdx`
  const select = async (colIdx: number, selIdx: number): Promise<void> => {
    if (colIdx < 0 || colIdx >= columns.length) return;
    activeCol = colIdx;
    await updateSelectionForCol(colIdx, selIdx);
    emitSelection();
  };

  const moveCol = (delta: number): void => {
    if (columns.length === 0) return;
    const next = Math.max(0, Math.min(columns.length - 1, activeCol + delta));
    activeCol = next;
    emitSelection();
  };

  const moveRow = async (delta: number): Promise<void> => {
    const col = columns[activeCol];
    if (!col || col.entries.length === 0) return;
    const nextSel = Math.max(0, Math.min(col.entries.length - 1, col.sel + delta));
    if (nextSel !== col.sel) {
      await updateSelectionForCol(activeCol, nextSel);
    }
    emitSelection();
  };

  // re-list the open columns IN PLACE: watcher ticks, delete/rename and the
  // refresh action all land here (there is no other signal for a columns
  // pane). The stack, active column and row cursor stay put unless an entry
  // vanished.
  const reload = async (): Promise<void> => {
    if (!columns.length) return;
    const next: ColumnData[] = [];
    for (const col of columns) {
      const entries = await loadEntries(col.dir);
      // keep a child column whose folder still exists even when it lists
      // empty (or only hidden dotfiles): Finder shows an empty column, and
      // dropping it made Enter on an empty folder a dead end. Only a truly
      // vanished folder (and everything below) drops out.
      const alive = await (async () => {
        try {
          return (await stat(col.dir)).isDirectory();
        } catch {
          // test/fake listings have no real dirs; a non-empty entry set is the
          // best available evidence that the folder still exists
          return entries.length > 0;
        }
      })();
      if (!alive && next.length > 0) break;
      next.push({ dir: col.dir, entries, sel: Math.max(0, Math.min(col.sel, entries.length - 1)) });
      if (!alive) break;
    }
    columns = next;
    activeCol = Math.max(0, Math.min(activeCol, columns.length - 1));
    const col = columns[activeCol];
    const entry = col ? col.entries[col.sel] : undefined;
    const itemPath = col && entry ? entryPath(col, entry) : null;
    // a preview of a vanished/renamed file must not linger
    if (previewFile !== null && previewFile !== itemPath) {
      previewFile = null;
      previewText = null;
    }
    emitSelection();
  };

  const openActive = async (forceFolder = false): Promise<void> => {
    const col = columns[activeCol];
    if (!col) return;
    const entry = col.entries[col.sel];
    if (!entry) return;
    const itemPath = entry.abs ?? path.join(col.dir, entry.name);
    if (entry.isDir && isDarwin() && isAppBundle(itemPath) && !forceFolder) {
      opts.openFile?.(itemPath);
    } else if (entry.isDir) {
      // enter on dir: focus the next column, or materialize it when this is
      // the last one (an empty/childless folder still gets its column)
      if (activeCol + 1 < columns.length) {
        activeCol++;
      } else {
        await updateSelectionForCol(activeCol, col.sel);
      }
    } else {
      opts.openFile?.(itemPath);
    }
    emitSelection();
  };

  const backspace = async (): Promise<boolean> => {
    // If more than 1 column, pop the last one and step back
    if (columns.length > 1) {
      columns.pop();
      activeCol = Math.max(0, Math.min(activeCol, columns.length - 1));
      previewFile = null;
      previewText = null;
      emitSelection();
      return true;
    }
    // Only 1 column: navigate to parent directory through the app nav
    const current = columns[0]?.dir ?? opts.cwd;
    const parent = path.dirname(current);
    if (parent !== current) {
      opts.onNavigate?.(parent);
      return true;
    }
    return false;
  };

  return {
    init,
    getColumns,
    getActiveCol,
    getPreview,
    select,
    moveCol,
    moveRow,
    reload,
    openActive,
    backspace,
  };
};

export type ColumnsRenderer = {
  renderColumns: () => Promise<void>;
  syncWindow: () => void;
  handleKey: (ev: KeyEventLike) => boolean;
  isActive: () => boolean;
  getModel: () => ReturnType<typeof makeColumnsModel>;
};

// the columns pane reads the config bindings so its nav keys never shadow a
// modifier/remap (alt+left history, alt+up parent, shift+arrow extend…)
export type ColumnsRendererCtx = GridRendererCtx & {
  keybinds?(action: KeyAction): string[];
  // active-entry sink: wiring feeds the shared selection model (status bar,
  // preview/info, file actions)
  onSelect?(path: string, isDir: boolean): void;
};

export const makeColumnsRenderer = (ctx: ColumnsRendererCtx): ColumnsRenderer => {
  const colors = ctx.colors();

  const model = makeColumnsModel({
    cwd: ctx.state.cwd,
    showHidden: ctx.state.showHidden,
    sortBy: ctx.state.sortBy,
    sortAsc: ctx.state.sortAsc,
    openFile: ctx.openFileDefault,
    onSelect: (p, isDir) => ctx.onSelect?.(p, isDir),
    onNavigate: (dir) => {
      ctx.navigate?.(dir);
    },
  });

  let initialized = false;
  let lastCwd = "";
  let lastHidden = ctx.state.showHidden;
  let lastSort = ctx.state.sortBy;
  let lastAsc = ctx.state.sortAsc;

  const renderColumns = async (): Promise<void> => {
    const scroller = ctx.scroller();
    if (!scroller) return;

    if (
      !initialized ||
      lastCwd !== ctx.state.cwd ||
      lastHidden !== ctx.state.showHidden ||
      lastSort !== ctx.state.sortBy ||
      lastAsc !== ctx.state.sortAsc
    ) {
      lastCwd = ctx.state.cwd;
      lastHidden = ctx.state.showHidden;
      lastSort = ctx.state.sortBy;
      lastAsc = ctx.state.sortAsc;
      await model.init(ctx.state.cwd);
      initialized = true;
    } else {
      // a watcher tick / refresh / hover-drawer settle lands here with no other
      // signal: re-list the open columns so deletes/renames show up in place
      // (listDir is TTL-cached, so a repaint is not a disk storm)
      await model.reload();
    }

    destroyChildren(scroller.content);

    const cols = model.getColumns();
    const activeColIdx = model.getActiveCol();
    const preview = model.getPreview();

    // Default column width: 28 cells
    const colWidth = 28;

    const rowContainer = Box({
      id: "tfm-columns-row",
      width: "100%",
      height: "100%",
      flexDirection: "row",
      backgroundColor: ctx.transparentForce?.() ? "transparent" : colors.bg,
    });

    // Populate columns
    cols.forEach((col, colIdx) => {
      const isActive = colIdx === activeColIdx;
      const colBox = Box({
        id: `tfm-col-${colIdx}`,
        width: colWidth,
        height: "100%",
        flexDirection: "column",
        border: ["right"],
        borderColor: colors.divider,
        backgroundColor: isActive ? colors.hoverBg : "transparent",
      });

      // Populate entries: only the viewport slice around the cursor is built.
      // A 2k-entry folder used to create 2k Box+Text nodes on every arrow key;
      // the padding rows keep the selected row at the same screen position.
      const viewH = (() => {
        const h = scroller.viewport?.height;
        return Math.max(3, (typeof h === "number" ? h : ctx.termH() - 4) - 1);
      })();
      const total = col.entries.length;
      const start = Math.max(0, Math.min(col.sel - Math.floor(viewH / 2), total - viewH));
      const end = Math.min(total, start + viewH);
      if (start > 0) colBox.add(Box({ width: "100%", height: start }));
      for (let entryIdx = start; entryIdx < end; entryIdx++) {
        const entry = col.entries[entryIdx];
        if (!entry) continue;
        const isSelected = col.sel === entryIdx;
        const entryRow = Box(
          {
            id: `tfm-col-${colIdx}-entry-${entryIdx}`,
            width: "100%",
            height: 1,
            flexDirection: "row",
            alignItems: "center",
            paddingLeft: 1,
            paddingRight: 1,
            backgroundColor: isSelected ? colors.accentBg : "transparent",
            onMouseDown: () => {
              void model.select(colIdx, entryIdx).then(() => renderColumns());
            },
          },
          Text({
            content: entry.name + (entry.isDir ? "/" : ""),
            fg: isSelected ? colors.accent : entry.name.startsWith(".") ? colors.sidebarFgMuted : colors.sidebarFg,
            truncate: true,
          }),
        );
        colBox.add(entryRow);
      }
      if (end < total) colBox.add(Box({ width: "100%", height: total - end }));

      rowContainer.add(colBox);
    });

    // Rightmost preview column if a file is selected
    if (preview.text !== null) {
      const previewBox = Box(
        {
          id: "tfm-col-preview",
          flexGrow: 1,
          height: "100%",
          flexDirection: "column",
          paddingLeft: 1,
          paddingRight: 1,
        },
        Text({
          content: preview.text,
          fg: colors.sidebarFg,
        }),
      );
      rowContainer.add(previewBox);
    }

    scroller.content.add(rowContainer);
  };

  const syncWindow = (): void => {
    // Columns view does not use windowed slide; no-op
  };

  const enterAlias = (name: string): string | null =>
    name === "enter" ? "return" : name === "return" ? "enter" : null;

  // does this event match the configured bind for `action`? With no keybind
  // seam (older fakes) only the unmodified default key name matches — a
  // modifier always falls through to the remapped-action block above/below.
  const bound = (ev: KeyEventLike, action: KeyAction, fallbackName: string): boolean => {
    const specs = ctx.keybinds?.(action);
    if (specs?.length) {
      for (const specText of specs) {
        const spec = parseKeySpec(specText);
        if (!spec) continue;
        if (keyMatch(ev, spec)) return true;
        const alias = enterAlias(spec.name);
        if (alias && keyMatch(ev, { ...spec, name: alias })) return true;
      }
      return false;
    }
    if (ev.name !== fallbackName) return false;
    return !ev.ctrl && !ev.shift && !ev.meta && !ev.option && !ev.super;
  };

  const handleKey = (ev: KeyEventLike): boolean => {
    if (ctx.viewMode() !== "columns") return false;
    // only the CONFIGURED nav binds claim a key: alt+left (history), alt+up
    // (parent) and shift+arrows (extend) must reach the remapped-action block
    if (bound(ev, "moveLeft", "left")) {
      model.moveCol(-1);
      void renderColumns();
      return true;
    }
    if (bound(ev, "moveRight", "right")) {
      model.moveCol(1);
      void renderColumns();
      return true;
    }
    if (bound(ev, "moveUp", "up")) {
      void model.moveRow(-1).then(() => renderColumns());
      return true;
    }
    if (bound(ev, "moveDown", "down")) {
      void model.moveRow(1).then(() => renderColumns());
      return true;
    }
    // option+Enter opens a macOS bundle as a folder (grid's "Open as Folder"
    // equivalent). It is checked BEFORE the configured binding because keyMatch
    // is modifier-strict and alt+Enter is bound to Properties globally.
    if ((ev.name === "return" || ev.name === "enter") && ev.option) {
      void model.openActive(true).then(() => renderColumns());
      return true;
    }
    if (bound(ev, "openSelected", "return")) {
      void model.openActive().then(() => renderColumns());
      return true;
    }
    if (bound(ev, "parentDir", "backspace")) {
      void model.backspace().then((handled) => {
        if (handled) void renderColumns();
      });
      return true;
    }
    return false;
  };

  return {
    renderColumns,
    syncWindow,
    handleKey,
    isActive: () => ctx.viewMode() === "columns",
    getModel: () => model,
  };
};
