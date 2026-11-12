// --- Native memory hygiene: OpenTUI's native objects (TextBuffers, images)
// are freed from bun GC finalizers, but bun only runs GC when the JS HEAP
// demands it — native memory pressure never triggers it. Sustained UI churn
// (theme flips, panel rebuilds) grows the native allocator unbounded until
// small allocations start failing ("Failed to create TextBuffer" = the
// floating-UI-vanishes crash). Poke the GC on a schedule so finalizers drain
// regularly, and trace allocator stats under --debug. Renderer-free — the
// (private) allocator-stats reach happens at the call site. ---

export type AllocatorStats = { activeAllocations: number; totalRequestedBytes: number };

// CliRenderer.lib is private with no public stats accessor, so the two
// diagnostics reaches (wiring/io's sampler, ui-settings' failure log) share
// this one narrowed shape instead of going through `any`.
export type NativeStatsReach = { lib?: { getAllocatorStats?: () => AllocatorStats | null } };

// one "mem ..." heartbeat line: allocator activity + process RSS
export const nativeMemLine = (stats: AllocatorStats | null): string => {
  let out = "n/a";
  if (stats) {
    out = `native active=${stats.activeAllocations} mem=${(stats.totalRequestedBytes / 1048576).toFixed(1)}MB`;
  }
  try {
    out += ` rss=${(process.memoryUsage().rss / 1048576).toFixed(0)}MB`;
  } catch {}
  return out;
};

type MemHygieneCtx = {
  // renderer.lib.getAllocatorStats() is private — narrow-cast it at the call
  // site (see NativeStatsReach in wiring/io)
  allocatorStats: () => AllocatorStats | null;
  // heartbeat lines are only interesting under --debug
  debugLog?: (msg: string) => void;
  intervalMs?: number;
  // GC seam (tests observe whether a tick actually poked); default pokeGc
  poke?: () => void;
};

// Best-effort native-allocator drain, safe to call from anywhere (including
// UI close paths and tests). Bun.gc(false) runs finalizers that free OpenTUI's
// native buffers; without an explicit poke they wait for heap pressure that
// native growth never provides.
export const pokeGc = (): void => {
  try {
    Bun.gc(false);
  } catch {}
};

// returns a stop() so tests (or a future settings knob) can tear it down.
//
// The poke is GROWTH-GATED: a full GC every tick even while the native
// allocator is flat is a periodic frame-loop hitch for nothing. Native
// allocations only climb when churn outruns finalizers (the failure mode this
// exists for), so a tick that sees a HIGHER active count than the last one
// pokes; a steady or shrinking count skips. Stats unavailable (the private
// reach failing) keeps the old unconditional poke — that is the pressure
// guard, not an optimization target.
export const startMemHygiene = (ctx: MemHygieneCtx): (() => void) => {
  const poke = ctx.poke ?? pokeGc;
  let lastActive = -1;
  const timer = setInterval(() => {
    const stats = ctx.allocatorStats();
    const active = stats?.activeAllocations ?? -1;
    if (active < 0 || active > lastActive) poke();
    lastActive = active;
    if (ctx.debugLog) ctx.debugLog(`mem ${nativeMemLine(stats)}`);
  }, ctx.intervalMs ?? 10000);
  timer.unref?.();
  return () => clearInterval(timer);
};
