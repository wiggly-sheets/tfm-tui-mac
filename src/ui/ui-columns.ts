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
import { readFileSync, statSync } from "node:fs";
import { Box, Text } from "@opentui/core";
import { listDir, type Entry } from "../fs/listing";
import { fmtBytes } from "../fs/propsinfo";
import { destroyChildren } from "../lib/uiutil";
import type { GridRendererCtx } from "./ui-grid-types";
import type { SortMode } from "../lib/sort";
import type { KeyEventLike } from "../config/keyspec";

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
      const st = statSync(filePath);
      if (st.size > PREVIEW_MAX_BYTES) {
        previewText = `[File too large to preview: ${fmtBytes(st.size)}]`;
        return;
      }
      const raw = readFileSync(filePath, "utf8");
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
  };

  const moveCol = (delta: number): void => {
    if (columns.length === 0) return;
    const next = Math.max(0, Math.min(columns.length - 1, activeCol + delta));
    activeCol = next;
  };

  const moveRow = async (delta: number): Promise<void> => {
    const col = columns[activeCol];
    if (!col || col.entries.length === 0) return;
    const nextSel = Math.max(0, Math.min(col.entries.length - 1, col.sel + delta));
    if (nextSel !== col.sel) {
      await updateSelectionForCol(activeCol, nextSel);
    }
  };

  const openActive = async (): Promise<void> => {
    const col = columns[activeCol];
    if (!col) return;
    const entry = col.entries[col.sel];
    if (!entry) return;
    const itemPath = entry.abs ?? path.join(col.dir, entry.name);
    if (entry.isDir) {
      // enter on dir: focus next column if present
      if (activeCol + 1 < columns.length) {
        activeCol++;
      }
    } else {
      opts.openFile?.(itemPath);
    }
  };

  const backspace = async (): Promise<boolean> => {
    // If more than 1 column, pop the last one and step back
    if (columns.length > 1) {
      columns.pop();
      activeCol = Math.max(0, Math.min(activeCol, columns.length - 1));
      previewFile = null;
      previewText = null;
      return true;
    }
    // Only 1 column: navigate to parent directory
    const current = columns[0]?.dir ?? opts.cwd;
    const parent = path.dirname(current);
    if (parent !== current) {
      opts.onNavigate?.(parent);
      await init(parent);
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

export const makeColumnsRenderer = (ctx: GridRendererCtx): ColumnsRenderer => {
  const colors = ctx.colors();

  const model = makeColumnsModel({
    cwd: ctx.state.cwd,
    showHidden: ctx.state.showHidden,
    sortBy: ctx.state.sortBy,
    sortAsc: ctx.state.sortAsc,
    openFile: ctx.openFileDefault,
    onNavigate: (dir) => {
      ctx.state.cwd = dir;
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

      // Populate entries
      col.entries.forEach((entry, entryIdx) => {
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
      });

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

  const handleKey = (ev: KeyEventLike): boolean => {
    if (ctx.viewMode() !== "columns") return false;
    if (ev.name === "left") {
      model.moveCol(-1);
      void renderColumns();
      return true;
    }
    if (ev.name === "right") {
      model.moveCol(1);
      void renderColumns();
      return true;
    }
    if (ev.name === "up") {
      void model.moveRow(-1).then(() => renderColumns());
      return true;
    }
    if (ev.name === "down") {
      void model.moveRow(1).then(() => renderColumns());
      return true;
    }
    if (ev.name === "return") {
      void model.openActive().then(() => renderColumns());
      return true;
    }
    if (ev.name === "backspace") {
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
