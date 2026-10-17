// --- Toolbar editor (stage B3): the drag-and-drop customization layer over the
// global toolbar strip. OWNS the edit-mode flag, the keyboard focus cursor and
// the palette drawer (a floating, NON-MODAL chip list of every catalog item).
// The strip renders the buttons and forwards its mouse surface here; the
// palette renders the chips. Pure list ops live in ./toolbar-edit-model, drop
// geometry in ./toolbar-strip-model. Every committed change writes
// config.ui.toolbar through ctx.applyToolbar (applyConfig + save) — the strip
// is rebuilt by the normal renderAll pass, never directly.
//
// Mouse surface: the strip buttons + the strip box carry onMouseDown/Drag/
// DragEnd/Over/Out/Drop; the palette chips carry onMouseDown/DragEnd/Up. The
// renderer ROOT handlers are owned by input/mouse-resize — this module never
// touches them. Drag reaches the strip because OpenTUI captures the drag on the
// pressed node and dispatches `drop` to whatever sits under the release point
// (bubbling to the strip box), while the source's `drag-end` fires first — the
// same release-before-drop ordering ./input/grid-input works around with a
// deferred finalize. ---

import { Box, Text } from "@opentui/core";
import type { Theme } from "../config/config";
import type { UiConfig } from "../config/config-schema";
import { TOOLBAR_ITEMS, sanitizeToolbar, type ToolbarItemId } from "../app/toolbar-items";
import { addItem, moveItem, removeItem } from "./toolbar-edit-model";
import { dropIndexAt } from "./toolbar-strip-model";
import { toolbarDrag } from "../input/toolbar-drag";
import { FLOAT_Z, type Floats } from "./floats";
import { btnSurface, floatSurface } from "./style";
import type { IconState, SlotElement } from "./ui-slots";
import type { MakeIconSlotFn } from "./ui-toolbar";
import type { MaybeNode } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";

// item buttons are 3 cells wide; the palette + caret math share the constant
export const TOOLBAR_ITEM_W = 3;
export const PALETTE_ID = "tfm-toolbar-palette";
const PALETTE_LIST_ID = `${PALETTE_ID}-list`;
// the insertion caret is a 1-cell absolute child the STRIP builds; the editor
// only moves it by id (a rebuild during a drag would destroy the drag capture)
export const TOOLBAR_CARET_ID = "tfm-toolbar-caret";
const PANEL_W = 34;

// shared drag state lives in ../input/toolbar-drag (a renderer-free leaf so
// index.ts's busy guard can import it without the app graph).

export type KeyLike = {
  name?: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  option?: boolean;
  super?: boolean;
};

export type ToolbarEditorCtx = {
  // live [ui] config (the edited list is sanitizeToolbar(ui().toolbar))
  ui(): UiConfig;
  // the one write path: applyConfig + scheduleSaveConfig
  applyToolbar(next: ToolbarItemId[]): void;
  byId(id: string): MaybeNode;
  rootAdd(node: unknown): void;
  destroyChildren(node: unknown): void;
  stripSelectable(node?: MaybeNode): void;
  colors(): Theme;
  uiStyle(): UiConfig["uiStyle"];
  makeIconSlot: MakeIconSlotFn;
  floats: Floats;
  stripLeft(): number;
  panelLeft(): number;
  transparentForce?(): boolean;
  setPointer?(style: PointerStyle): void;
  // strip rebuild after a focus-only change (wired once the strip exists)
  repaint?(): void;
};

export type ToolbarEditor = {
  isActive(): boolean;
  toggle(): void;
  enter(): void;
  exit(): void;
  /** toolbar item index under the keyboard cursor, -1 when the cursor is in the palette */
  focusIndex(): number;
  /** palette index under the keyboard cursor, -1 when the cursor is on the strip */
  paletteIndex(): number;
  handleKey(ev: KeyLike): boolean;
  // --- mouse surface (called by the strip) ---
  itemDragStart(index: number): void;
  dragMove(x: number, y: number): void;
  dragOver(x: number, y: number): void;
  dragOut(): void;
  dropAt(x: number): void;
  endGesture(): void;
  /** test seam: run the deferred finalize synchronously */
  finalize(): void;
};

export const makeToolbarEditor = (ctx: ToolbarEditorCtx): ToolbarEditor => {
  let active = false;
  let paletteOpen = false;
  let focus = -1;
  let paletteFocus = -1;

  const list = (): ToolbarItemId[] => sanitizeToolbar(ctx.ui().toolbar);
  const paletteIds = (): ToolbarItemId[] => Object.keys(TOOLBAR_ITEMS) as ToolbarItemId[];
  const repaint = (): void => {
    try {
      ctx.repaint?.();
    } catch {}
  };

  const commit = (next: ToolbarItemId[]): void => {
    ctx.applyToolbar(next);
    // the palette's "already on the toolbar" marks must follow the list; skip
    // while a drag owns the chip nodes (finalize refreshes instead)
    if (paletteOpen && !toolbarDrag.active) renderPalette();
  };

  // --- palette drawer -------------------------------------------------------
  const closePalette = (): void => {
    if (!paletteOpen) return;
    ctx.floats.close("toolbaritems");
  };

  const rawClosePalette = (): void => {
    paletteOpen = false;
    paletteFocus = -1;
    const n = ctx.byId(PALETTE_ID);
    try {
      n?.parent?.remove(n);
    } catch {}
  };

  const chipFor = (id: ToolbarItemId, on: boolean): SlotElement => {
    const item = TOOLBAR_ITEMS[id];
    const c = ctx.colors();
    const focused = paletteFocus >= 0 && paletteIds()[paletteFocus] === id;
    const chipId = `${PALETTE_ID}-${id}`;
    const states = (): IconState[] => [{ fg: on ? c.sidebarFgMuted : c.sidebarFg, bg: c.sidebarBg }];
    const slot = ctx.makeIconSlot(item.icon, states(), 1, 0);
    return Box(
      {
        id: chipId,
        height: 1,
        width: "100%",
        flexDirection: "row",
        alignItems: "center",
        columnGap: 1,
        paddingLeft: 1,
        paddingRight: 1,
        ...btnSurface(ctx.uiStyle(), c, focused, undefined, ctx.transparentForce?.() ? "force" : undefined),
        backgroundColor: focused ? c.accentBg : c.sidebarBg,
        onMouseDown: (ev: { stopPropagation?(): void }) => {
          try {
            ev.stopPropagation?.();
          } catch {}
          // no renderPalette here: rebuilding the pressed chip mid-gesture
          // would destroy the drag capture (the strip caret is the feedback)
          paletteFocus = paletteIds().indexOf(id);
          toolbarDrag.active = true;
          toolbarDrag.kind = "add";
          toolbarDrag.itemId = id;
          toolbarDrag.from = -1;
          toolbarDrag.moved = false;
          toolbarDrag.inside = false;
          toolbarDrag.dropped = false;
        },
        onMouseUp: () => endGesture(),
        onMouseDragEnd: () => endGesture(),
      },
      slot.el,
      Text({ content: item.label, fg: on ? c.sidebarFgMuted : c.sidebarFg }),
      ...(on ? [Text({ content: "✓", fg: c.accent })] : []),
    );
  };

  const renderPalette = (): void => {
    if (!paletteOpen) return;
    const listNode = ctx.byId(PALETTE_LIST_ID);
    if (!listNode) return;
    const present = new Set(list());
    ctx.destroyChildren(listNode);
    for (const id of paletteIds()) listNode.add(chipFor(id, present.has(id)));
    try {
      ctx.stripSelectable();
    } catch {}
  };

  const openPalette = (): void => {
    if (paletteOpen) return;
    ctx.floats.open("toolbaritems", rawClosePalette);
    paletteOpen = true;
    const c = ctx.colors();
    // chips are built EAGERLY into the panel VNode (a first refresh before the
    // mount would find no list node by id — renderPalette only serves updates)
    const present = new Set(list());
    const panel = Box(
      {
        id: PALETTE_ID,
        position: "absolute",
        left: ctx.panelLeft(),
        top: 2,
        width: PANEL_W,
        flexDirection: "column",
        zIndex: FLOAT_Z.toolbaritems,
        ...floatSurface(ctx.uiStyle(), c, c.sidebarBg),
        onMouseDown: (ev: { stopPropagation?(): void }) => {
          try {
            ev.stopPropagation?.();
          } catch {}
        },
      },
      Box(
        {
          width: "100%",
          height: 1,
          flexDirection: "row",
          paddingLeft: 1,
          paddingRight: 1,
          backgroundColor: c.sidebarBg,
        },
        Text({ content: "Toolbar items", fg: c.accent }),
      ),
      Box(
        { id: PALETTE_LIST_ID, width: "100%", flexDirection: "column" },
        ...paletteIds().map((id) => chipFor(id, present.has(id))),
      ),
    );
    ctx.rootAdd(panel);
    try {
      ctx.stripSelectable();
    } catch {}
  };

  // --- drag helpers ---------------------------------------------------------
  const caretAt = (index: number, count: number): void => {
    const caret = ctx.byId(TOOLBAR_CARET_ID);
    if (!caret) return;
    try {
      caret.left = Math.max(0, Math.min(index * TOOLBAR_ITEM_W, count * TOOLBAR_ITEM_W - 1));
      caret.visible = true;
    } catch {}
  };
  const hideCaret = (): void => {
    const caret = ctx.byId(TOOLBAR_CARET_ID);
    if (!caret) return;
    try {
      caret.visible = false;
    } catch {}
  };
  // shortcut: the drop math treats every item as the uniform TOOLBAR_ITEM_W
  // button (no gaps) and ignores the row's overflow clip, so an item scrolled
  // off the strip still counts as a slot. Upgrade when the strip gains
  // variable widths or horizontal scrolling.
  const indexAt = (x: number, count: number): number => dropIndexAt(x - ctx.stripLeft(), TOOLBAR_ITEM_W, count);

  const resetDrag = (): void => {
    toolbarDrag.active = false;
    toolbarDrag.kind = null;
    toolbarDrag.from = -1;
    toolbarDrag.itemId = null;
    toolbarDrag.moved = false;
    toolbarDrag.inside = false;
    toolbarDrag.dropped = false;
  };

  // release fires on the source (`drag-end`) BEFORE `drop` reaches the strip, so
  // the finalize is deferred one tick (same ordering trap as grid-input)
  const endGesture = (): void => {
    setTimeout(finalize, 0);
  };

  const finalize = (): void => {
    const d = toolbarDrag;
    if (!d.active && d.kind === null) return;
    const kind = d.kind;
    const itemId = d.itemId;
    const from = d.from;
    const { moved, inside, dropped } = d;
    resetDrag();
    hideCaret();
    if (!dropped) {
      const cur = list();
      if (kind === "add" && itemId && !moved) {
        // plain chip click = guaranteed append
        focus = cur.length;
        commit(addItem(cur, itemId, cur.length));
      } else if (kind === "reorder" && moved && !inside && from >= 0) {
        // dragged off the strip = remove
        const id = cur[from];
        if (id) {
          if (focus >= cur.length - 1) focus = cur.length - 2;
          commit(removeItem(cur, id));
        }
      }
    }
    if (paletteOpen) renderPalette();
    repaint();
  };

  // --- public ops -----------------------------------------------------------
  const enter = (): void => {
    if (active) return;
    active = true;
    paletteFocus = -1;
    focus = list().length ? 0 : -1;
    openPalette();
    repaint();
  };

  const exit = (): void => {
    if (!active) return;
    active = false;
    closePalette();
    resetDrag();
    focus = -1;
    paletteFocus = -1;
    hideCaret();
    repaint();
  };

  const removeFocused = (): void => {
    const cur = list();
    const id = cur[focus];
    if (!id) return;
    const next = removeItem(cur, id);
    if (focus >= next.length) focus = next.length - 1;
    commit(next);
  };

  const nudge = (delta: -1 | 1): void => {
    const cur = list();
    if (focus < 0 || focus >= cur.length) return;
    const to = delta > 0 ? focus + 2 : focus - 1;
    const nextFocus = Math.max(0, Math.min(cur.length - 1, focus + delta));
    const next = moveItem(cur, focus, to);
    focus = nextFocus;
    commit(next);
  };

  const handleKey = (ev: KeyLike): boolean => {
    if (!active) return false;
    if (ev.name === "escape") {
      exit();
      return true;
    }
    const alt = !!ev.meta || !!ev.option;
    const cur = list();
    const palette = paletteIds();

    if (paletteFocus >= 0) {
      if (ev.name === "left" || ev.name === "up") {
        if (paletteFocus <= 0) {
          paletteFocus = -1;
          focus = cur.length - 1;
          repaint();
        } else {
          paletteFocus -= 1;
          renderPalette();
        }
        return true;
      }
      if (ev.name === "right" || ev.name === "down") {
        if (paletteFocus < palette.length - 1) {
          paletteFocus += 1;
          renderPalette();
        }
        return true;
      }
      if (ev.name === "return") {
        const id = palette[paletteFocus];
        if (id) commit(addItem(cur, id, cur.length));
        return true;
      }
      return true; // palette owns the cursor: swallow the rest
    }

    if (ev.name === "left") {
      if (alt) nudge(-1);
      else if (focus > 0) {
        focus -= 1;
        repaint();
      }
      return true;
    }
    if (ev.name === "right") {
      if (alt) nudge(1);
      else if (focus < cur.length - 1) {
        focus += 1;
        repaint();
      } else if (palette.length) {
        paletteFocus = 0;
        renderPalette();
      }
      return true;
    }
    if (ev.name === "down" && palette.length) {
      paletteFocus = 0;
      renderPalette();
      return true;
    }
    if (ev.name === "up") return true;
    if (ev.name === "backspace" || ev.name === "delete") {
      removeFocused();
      return true;
    }
    if (ev.name === "return") return true;
    return false; // other keys fall through (ctrl+q, ctrl+shift+w, …)
  };

  return {
    isActive: () => active,
    toggle: () => (active ? exit() : enter()),
    enter,
    exit,
    focusIndex: () => focus,
    paletteIndex: () => paletteFocus,
    handleKey,
    itemDragStart: (index) => {
      focus = index;
      paletteFocus = -1;
      toolbarDrag.active = true;
      toolbarDrag.kind = "reorder";
      toolbarDrag.from = index;
      toolbarDrag.itemId = null;
      toolbarDrag.moved = false;
      toolbarDrag.inside = false;
      toolbarDrag.dropped = false;
      // NO repaint here: rebuilding the strip on mousedown would destroy the
      // pressed node and the renderer's drag capture with it. The caret is the
      // gesture's feedback; the focus paint comes back on the next repaint.
    },
    dragMove: (x) => {
      toolbarDrag.moved = true;
      caretAt(indexAt(x, list().length), list().length);
    },
    dragOver: (x) => {
      toolbarDrag.inside = true;
      caretAt(indexAt(x, list().length), list().length);
    },
    dragOut: () => {
      toolbarDrag.inside = false;
      hideCaret();
    },
    dropAt: (x) => {
      const d = toolbarDrag;
      if (d.kind === null) return;
      const cur = list();
      const index = dropIndexAt(x - ctx.stripLeft(), TOOLBAR_ITEM_W, cur.length);
      if (d.kind === "add" && d.itemId) {
        commit(addItem(cur, d.itemId, index));
      } else if (d.kind === "reorder" && d.from >= 0) {
        focus = Math.max(0, Math.min(cur.length - 1, index > d.from ? index - 1 : index));
        commit(moveItem(cur, d.from, index));
      }
      d.dropped = true;
      hideCaret();
    },
    endGesture,
    finalize,
  };
};
