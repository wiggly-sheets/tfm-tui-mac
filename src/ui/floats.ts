// --- Floating layers: THE single source of truth for which modal/cursor
// layer is open, in what order, and who gets dismissed when. Widgets keep
// their rendering and their internal render-guard flags, but every open/close
// transition routes through here — a layer can no longer be forgotten on
// screen because dismissal is POLICY, not per-call-site bookkeeping.
//
// Model: at most ONE modal layer (escmenu/props/conflict/yesno) plus at most
// ONE cursor popup (filemenu) on top of it — the popup legitimately spawns
// from inside a modal (the permission menu inside the properties dialog). The
// NON-MODAL layers (filemenu, quicklook) are the exception the set below
// spells out: they never count as modals and never dim the desktop.
//
// Policy (lives here, nowhere else):
// - opening a modal clears the whole desktop (popup + any other modal) first;
// - opening a non-modal layer replaces an existing layer of the same kind and
//   keeps the modals below;
// - closing a layer also closes everything opened above it (closing props
//   takes its permission popup with it);
// - closers are raw teardowns captured at open time — they must never call
//   back into this module (public close fns are floats.close wrappers).
//
// Pure module: no renderer imports. z-order table exported for the widgets. ---

export type FloatKind =
  | "filemenu"
  | "props"
  | "conflict"
  | "yesno"
  | "escmenu"
  | "pick"
  | "prompt"
  | "gotofolder"
  | "bulkrename"
  | "quicklook";

// layers that are NOT modals: they neither dim the desktop (hasModal stays
// false, so no raster scrim) nor swallow the keyboard, and opening one leaves
// the modals below it alone.
const NON_MODAL: ReadonlySet<FloatKind> = new Set<FloatKind>(["filemenu", "quicklook"]);

// z-order of the floating layers — the one table documenting which layer
// renders above which. Outside the stack: band rect 2500 (gesture), progress
// toast 3500 (non-modal chrome), drag ghost 4000 (gesture).
export const FLOAT_Z: Record<FloatKind, number> = {
  escmenu: 3000,
  props: 3300,
  conflict: 3400,
  yesno: 3450,
  // quicklook overlay (the preview without the preview pane): non-modal, so it
  // sits UNDER the cursor popup — a context menu opened over it stays on top
  quicklook: 3590,
  filemenu: 3600,
  // generic filter-list overlay (api.ui.pick, e.g. the palette plugin): the
  // newest modal wins, so it sits on top; opening one dismisses the rest
  // through the standard modal policy below
  pick: 3700,
  // single-line text prompt (plugin git-URL entry): above pick so it
  // replaces the palette via the modal policy instead of stacking scrims
  // (floats depth stays 1)
  prompt: 3750,
  // go-to-folder popup (Shift+Cmd+G): a peer of prompt — same replace-not-stack
  gotofolder: 3750,
  // bulk-rename editor (F2 on a multi-selection): newest modal, same
  // replace-don't-stack rule
  bulkrename: 3760,
};

export type Floats = {
  /** register a layer as open; `closer` is its raw teardown */
  open(kind: FloatKind, closer: () => void): void;
  /** close `kind` and everything opened above it; no-op when not open */
  close(kind: FloatKind): void;
  /** close everything, top-down */
  closeAll(): void;
  isOpen(kind: FloatKind): boolean;
  top(): FloatKind | null;
  depth(): number;
  /** any layer that is not one of the non-modal ones is a modal (a filemenu
   * popup may live inside one — props + its permission menu). Raster scrim. */
  hasModal(): boolean;
};

// `onModalChange` fires on every 0<->1 modal transition (the background
// raster scrim hooks here). Keep it optional so the pure module stays
// renderer-free and the existing tests call makeFloats() with no args.
export const makeFloats = (opts: { onModalChange?: (open: boolean) => void } = {}): Floats => {
  const { onModalChange } = opts;
  type Entry = { kind: FloatKind; closer: () => void };
  let stack: Entry[] = [];
  let modalLast = false;

  // top-down so children tear down before their parents
  const runClosers = (entries: Entry[]): void => {
    for (const e of [...entries].reverse()) e.closer();
  };

  const hasModal = (): boolean => stack.some((e) => !NON_MODAL.has(e.kind));

  const syncModal = (): void => {
    if (!onModalChange) return;
    const now = hasModal();
    if (now === modalLast) return;
    modalLast = now;
    try {
      onModalChange(now);
    } catch {}
  };

  const open = (kind: FloatKind, closer: () => void): void => {
    if (NON_MODAL.has(kind)) {
      // replaces an existing layer of its own kind; the modals below stay
      const old = stack.filter((e) => e.kind === kind);
      stack = stack.filter((e) => e.kind !== kind);
      runClosers(old);
    } else {
      const all = stack;
      stack = [];
      runClosers(all);
      // stack-emptied dip: a modal the closer itself just cleared (e.g. a
      // confirm opening over the esc-menu ran its setScrim(false)) must
      // refire below, or the new modal paints with rasters un-dimmed
      syncModal();
    }
    stack.push({ kind, closer });
    syncModal();
  };

  const close = (kind: FloatKind): void => {
    const idx = stack.findIndex((e) => e.kind === kind);
    if (idx < 0) return;
    const victims = stack.slice(idx); // kind + everything above it
    stack = stack.slice(0, idx);
    runClosers(victims);
    syncModal();
  };

  const closeAll = (): void => {
    const all = stack;
    stack = [];
    runClosers(all);
    syncModal();
  };

  return {
    open,
    close,
    closeAll,
    isOpen: (kind) => stack.some((e) => e.kind === kind),
    top: () => stack[stack.length - 1]?.kind ?? null,
    depth: () => stack.length,
    hasModal,
  };
};
