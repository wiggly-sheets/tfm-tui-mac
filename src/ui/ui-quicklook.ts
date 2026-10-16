import { Box, ScrollBoxRenderable, Text } from "@opentui/core";
import { FLOAT_Z, type Floats } from "./floats";
import { makeModalScrim } from "./ui-dialogs";
import type { Theme } from "../config/config";
import type { UiStyle } from "../config/config-schema";
import type { MaybeNode } from "../lib/node-like";
import type { PointerStyle } from "../lib/pointer";
import type { SlotElement } from "./ui-slots";

// --- Quick Look: a floating, NON-MODAL preview overlay (macOS space-bar Quick
// Look) that shows the current selection when the preview pane and the info
// sidebar are both hidden. The CONTENT is not rendered here: the preview
// module owns it and registers a renderer through setQuicklookRenderer below,
// so the pane and the float paint the same thing through one implementation.
//
// Keys while open: esc (or the toggle bind) closes, up/down/… scroll the
// content. Everything else falls through to the app on purpose — that is what
// non-modal means here. ---

export type QuicklookGeometry = { w: number; h: number };
export type QuicklookRenderer = (target: MaybeNode, geo: QuicklookGeometry) => void;

// The preview instance is built by the grid wiring, which this feature must
// not reach into (another worktree owns it) and which cannot see this module
// either — so the single live preview instance registers its float renderer
// here at boot instead of the keymap wiring passing it down.
let renderer: QuicklookRenderer | null = null;
export const setQuicklookRenderer = (fn: QuicklookRenderer | null): void => {
  renderer = fn;
};

// the open float, if any: the preview module calls refreshQuicklook() on every
// selection change so the overlay follows the cursor like the pane does.
// makeQuicklook assigns this once at boot; refreshQuicklook reads it live.
let live: Quicklook | null = null;
export const refreshQuicklook = (): void => live?.refresh();

export type Quicklook = {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  refresh(): void;
  /** scroll the rendered body by `lines` (negative = up) */
  scroll(lines: number): void;
  /** scroll by roughly one viewport (dir -1 = up) */
  page(dir: -1 | 1): void;
};

type QuicklookCtx = {
  byId(id: string): MaybeNode;
  rootAdd(node: unknown): void;
  stripSelectable(): void;
  colors(): Theme;
  uiStyle(): UiStyle;
  floats: Floats;
  termW(): number;
  termH(): number;
  previewWidth(): number;
  escHintBtn(id: string, onClose: () => void): SlotElement;
  drainIconQueue(): void | Promise<void>;
  // injectable for headless tests (absent = the real 60ms debounce)
  schedule?(fn: () => void): void;
  setPointer?(style: PointerStyle): void;
};

const ID = "tfm-quicklook";
const BODY_ID = "tfm-quicklook-body";
const REFRESH_MS = 60;
// geometry the shared render expects (mirrors the pane's): body height is
// termH - 6 and the media fit is termH - 8, so the float passes its own rows + 6
const ROW_OVERHEAD = 6;

export const makeQuicklook = (ctx: QuicklookCtx): Quicklook => {
  let opened = false;

  const panelWidth = (): number => Math.max(24, Math.min(ctx.previewWidth() + 2, ctx.termW() - 4));
  const bodyRows = (): number => Math.max(4, ctx.termH() - ROW_OVERHEAD - 2);

  // the float renders into a plain box: it needs no scrim plumbing of its own,
  // only the shared skeleton (panel chrome + click-outside dismissal)
  const bodyNode = (): MaybeNode => ctx.byId(BODY_ID);

  const render = (): void => {
    const body = bodyNode();
    if (!body || !renderer) return;
    renderer(body, { w: Math.max(8, panelWidth() - 2), h: bodyRows() + ROW_OVERHEAD });
  };

  let pending: ReturnType<typeof setTimeout> | null = null;
  const refresh = (): void => {
    if (!opened) return;
    if (ctx.schedule) {
      ctx.schedule(render);
      return;
    }
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      render();
    }, REFRESH_MS);
  };

  const rawClose = (): void => {
    opened = false;
    if (pending) {
      clearTimeout(pending);
      pending = null;
    }
    ctx.setPointer?.("default");
    const scrim = ctx.byId(ID);
    scrim?.parent?.remove(scrim);
  };

  const close = (): void => {
    ctx.floats.close("quicklook");
  };

  const open = (): void => {
    if (opened) return;
    ctx.floats.open("quicklook", rawClose);
    opened = true;
    const c = ctx.colors();
    const scrim = makeModalScrim(
      { uiStyle: ctx.uiStyle, colors: ctx.colors },
      { id: ID, zIndex: FLOAT_Z.quicklook, panelWidth: panelWidth(), onClose: () => close() },
      Box(
        { width: "100%", height: 1, flexDirection: "row", alignItems: "center", paddingLeft: 2, paddingRight: 1 },
        Text({ id: `${ID}-title`, content: "Quick Look", fg: c.accent }),
        Box({ flexGrow: 1 }),
        ctx.escHintBtn(`${ID}-esc`, () => close()),
      ),
      // the preview body: the shared render adds its own scroller for the
      // content that needs one (code/markdown bodies), which scroll() finds;
      // plain cards (info, listings) just clip
      Box({ id: BODY_ID, width: "100%", height: bodyRows(), flexDirection: "column", marginTop: 1 }),
    );
    ctx.rootAdd(scrim);
    ctx.stripSelectable();
    void ctx.drainIconQueue();
    render();
  };

  // the scrollbox the shared render mounted inside the body (code/markdown
  // bodies carry one; plain cards do not, and then scrolling is a no-op)
  const scroller = (node: MaybeNode): ScrollBoxRenderable | null => {
    for (const k of (node as { getChildren?: () => unknown[] })?.getChildren?.() ?? []) {
      if (k instanceof ScrollBoxRenderable) return k;
      const deep = scroller(k as MaybeNode);
      if (deep) return deep;
    }
    return null;
  };

  const scroll = (lines: number): void => {
    const sc = scroller(bodyNode());
    if (!sc) return;
    sc.scrollTop = Math.max(0, sc.scrollTop + lines);
  };

  const page = (dir: -1 | 1): void => scroll(dir * Math.max(1, bodyRows() - 2));

  const api: Quicklook = {
    open,
    close,
    toggle: () => (opened ? close() : open()),
    isOpen: () => opened,
    refresh,
    scroll,
    page,
  };
  live = api;
  return api;
};
