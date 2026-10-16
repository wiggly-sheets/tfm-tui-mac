// --- Sync browsing: when the active pane enters a directory, the OTHER pane
// follows into it (Finder-style dual-pane browsing). The decision logic lives
// HERE (pure, testable) so the wiring layer stays thin; the only state this
// module holds is a re-entrancy guard. The driven pane can never drive back:
// `follow` is only ever called from the ENTERING pane's nav instance, and the
// guard suppresses a second follow while one is already in flight (the driven
// pane's own navigation would otherwise re-enter this function). ---
export type SyncBrowsingDeps = {
  enabled: () => boolean;
  leafIds: () => string[];
  // navigate the OTHER pane into `dir` (the wiring supplies the passive
  // pane's own nav instance, which has no follow hook of its own)
  navigateOther: (id: string, dir: string) => void;
};

export const makeSyncBrowsing = (deps: SyncBrowsingDeps) => {
  // re-entrancy guard: entering a dir in pane A drives pane B; pane B's
  // navigation must NOT drive pane A back on the same event
  let busy = false;

  const follow = (sourceId: string, dir: string): void => {
    if (!deps.enabled()) return;
    if (busy) return;
    const ids = deps.leafIds();
    // one pane (after a close) = nothing to follow into — degrade cleanly
    if (ids.length < 2) return;
    const other = ids.find((i) => i !== sourceId);
    if (!other) return;
    busy = true;
    try {
      deps.navigateOther(other, dir);
    } finally {
      busy = false;
    }
  };

  return { follow };
};
