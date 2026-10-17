// --- Status bar writes: transient messages land on tfm-status-label and the
// selection summary reclaims the bar after a quiet period (the reset fires
// `resetDelayMs` after the LAST message, like a debounce). The refresh fn is
// injected (selection's updateSelectionStatusReal) so this module stays
// renderer-free — nodes arrive through byId. ---

import { debounced, type Scheduler } from "../lib/uiutil";

type StatusCtx = {
  setText(id: string, s: string): void;
  // node existence probe: setStatusMsg must no-op when the bar node is absent
  // (rebuilds kill it constantly), like every other chrome write
  node?: (id: string) => unknown;
  refresh(): void;
  resetDelayMs?: number;
  // injectable clock (tests use a virtual one); defaults to real timers
  sched?: Scheduler;
};

export const makeStatus = (ctx: StatusCtx) => {
  const clearStatusMsg = debounced(ctx.resetDelayMs ?? 2500, () => ctx.refresh(), ctx.sched ?? globalThis);

  const setStatusMsg = (text: string): void => {
    // guard on the node: the bar is rebuilt on every renderAll, so a status
    // write can arrive before it exists (or after a rename) and must no-op
    // like every other chrome write. Fakes without a node probe fall back to
    // the unguarded write (they own their own nodes).
    if (ctx.node) {
      if (!ctx.node("tfm-status-label")) return;
    }
    ctx.setText("tfm-status-label", text);
    clearStatusMsg();
  };

  return { setStatusMsg, clearStatusMsg };
};
