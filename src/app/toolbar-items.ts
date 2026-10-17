// --- Global toolbar item catalog: the fixed set of items a toolbar can show.
// Each item maps to an existing key action (config-schema KeyAction, dispatched
// by input/keymap.ts) and to a real SVG in assets/icons/. Pure data — parsing
// lives in config-schema.ts, the renderer in the toolbar UI stage. ---

export type ToolbarItemId =
  | "split-h"
  | "split-v"
  | "close-pane"
  | "preset-single"
  | "preset-2col"
  | "preset-2row"
  | "preset-3pane"
  | "view-cycle"
  | "info-toggle"
  | "preview-toggle"
  | "back"
  | "forward"
  | "up"
  | "refresh"
  | "hidden-toggle"
  | "sync-toggle"
  | "terminal-toggle"
  | "sort";

export type ToolbarItem = { icon: string; label: string; commandId: string };

// icon names must exist as files in assets/icons/; commandId must be a KeyAction.
// split-h splits side by side (a vertical divider) and split-v stacks (a
// horizontal divider), matching layout.ts's "h"/"v" orientation names.
export const TOOLBAR_ITEMS: Record<ToolbarItemId, ToolbarItem> = {
  "split-h": { icon: "view-split-vertical", label: "Split left/right", commandId: "splitPaneHorizontal" },
  "split-v": { icon: "view-split-horizontal", label: "Split top/bottom", commandId: "splitPaneVertical" },
  "close-pane": { icon: "close", label: "Close pane", commandId: "closePane" },
  "preset-single": { icon: "view-grid", label: "Single pane", commandId: "presetSingle" },
  "preset-2col": { icon: "view-split-vertical", label: "Two columns", commandId: "presetTwoCol" },
  "preset-2row": { icon: "view-split-horizontal", label: "Two rows", commandId: "presetTwoRow" },
  // view-dashboard-vertical is a renamed upstream glyph (view-dashboard-variant)
  "preset-3pane": { icon: "view-dashboard-vertical", label: "Three panes", commandId: "presetThreePane" },
  "view-cycle": { icon: "view-list", label: "View mode", commandId: "toggleView" },
  "info-toggle": { icon: "information", label: "Info sidebar", commandId: "toggleInfoSidebar" },
  "preview-toggle": { icon: "eye", label: "Preview", commandId: "togglePreview" },
  back: { icon: "chevron-left", label: "Back", commandId: "histBack" },
  forward: { icon: "chevron-right", label: "Forward", commandId: "histForward" },
  up: { icon: "arrow-up", label: "Up", commandId: "parentDir" },
  refresh: { icon: "refresh", label: "Refresh", commandId: "refresh" },
  "hidden-toggle": { icon: "file-hidden", label: "Hidden files", commandId: "toggleHidden" },
  "sync-toggle": { icon: "sync", label: "Sync browsing", commandId: "toggleSyncBrowsing" },
  "terminal-toggle": { icon: "terminal", label: "Terminal", commandId: "openTerminal" },
  sort: { icon: "sort", label: "Sort", commandId: "cycleSort" },
};

// the [ui] toolbar default, left to right
export const DEFAULT_TOOLBAR: ToolbarItemId[] = [
  "back",
  "forward",
  "up",
  "refresh",
  "view-cycle",
  "info-toggle",
  "preview-toggle",
  "sort",
  "sync-toggle",
  "hidden-toggle",
  "terminal-toggle",
];

const isToolbarItemId = (id: string): id is ToolbarItemId => Object.hasOwn(TOOLBAR_ITEMS, id);

// drop unknown ids, dedupe (first wins), preserve input order
export const sanitizeToolbar = (ids: readonly string[]): ToolbarItemId[] => {
  const seen = new Set<ToolbarItemId>();
  const out: ToolbarItemId[] = [];
  for (const id of ids) {
    if (!isToolbarItemId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
};
