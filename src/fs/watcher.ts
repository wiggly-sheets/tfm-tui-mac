// --- Live directory watching: external changes refresh the grid. Owns the
// FSWatcher lifecycle for the active cwd; the app-facing surface is
// syncCwdWatcher(), called from renderAll so the watched dir always matches
// state.cwd. Renderer-free — cwd/renaming/renderGrid arrive as getters.
//
// Limits (documented, not hidden): single non-recursive node:fs.watch on cwd
// only — rapid external changes during a long transfer surface on the next
// renderAll/sync. Errors are logged via the injected log (default silent for
// backwards compat) instead of being swallowed invisibly. Events for the
// app's own sink files (dnd/debug logs, see ignorePaths) never schedule a
// rebuild — otherwise browsing /tmp rebuilds the grid after every click. ---

import { lstatSync, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { debounced, type Scheduler } from "../lib/uiutil";

type CwdWatcherCtx = {
  cwd: () => string;
  isVirtualCwd: () => boolean;
  // our own create+inline-edit would wipe the editor mid-keystroke
  isRenaming: () => boolean;
  renderGrid: () => void | Promise<void>;
  // self-written sink files (DND_LOG/DEBUG_LOG) that may live inside the
  // watched dir: their events are our own noise, never an external change
  ignorePaths?: () => string[];
  // injectable for tests; defaults to node:fs watch. Returns a handle with
  // an "error" subscription and close() — the structural surface used here.
  // The callback receives the event's filename (null on platforms that
  // don't report one — then we can't filter and refresh as before).
  watchImpl?: (
    dir: string,
    cb: (filename?: string | null) => void,
    opts?: { recursive?: boolean },
  ) => { on(ev: string, cb: (e: unknown) => void): unknown; close(): void };
  // injectable clock for the coalesce debounce (tests use a virtual one)
  sched?: Scheduler;
  // called on every raw fs event, before the debounce coalesces. nav.ts caches
  // statSync results by path to avoid SMB stalls; this invalidates that cache
  // so an external change is never served from stale data.
  clearStatCache?: () => void;
  // errors are surfaced (default silent for backwards compat), never swallowed
  log?: (msg: string) => void;
  // platform override (tests pin "linux"); the recursive watch capability
  // and the readdir-diff fallback both key off it
  platform?: string;
  // injectable readdir for the diff fallback (tests fake it); default =
  // node:fs/promises readdir
  readDir?: (dir: string) => Promise<string[]>;
  // injectable stat for the diff fallback (tests fake it); default = lstat
  stat?: (p: string) => Promise<{ mtimeMs?: number; size?: number } | null>;
};

export const makeCwdWatcher = (ctx: CwdWatcherCtx) => {
  let watcher: ReturnType<typeof watch> | null = null;
  let watchedDir: string | null = null;
  let watchErrored = false;
  // node:fs.watch is non-recursive by design: a file moved INTO a subdirectory
  // of cwd, or cwd itself renamed, is invisible until the next navigation —
  // the transfer engine landing a copy in a subfolder shows a stale listing.
  // Platforms that support recursive watch get it; the rest fall back to a
  // periodic readdir diff on the debounce tick.
  const recursiveSupported = (ctx.platform ?? process.platform) !== "linux" || process.versions.bun >= "1.2";
  const doWatch =
    ctx.watchImpl ??
    ((dir: string, cb: (filename?: string | null) => void) =>
      watch(dir, { recursive: recursiveSupported }, (_ev, fname) => cb(fname)));
  const readDir = ctx.readDir ?? ((d: string) => readdir(d));
  const stat =
    ctx.stat ??
    ((p: string) => {
      try {
        const s = lstatSync(p);
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    });

  // snapshot of the watched dir's name→mtime+size, taken on arm; the diff
  // fallback compares it on every tick. A null entry means "absent".
  let snapshot = new Map<string, { mtimeMs?: number; size?: number } | null>();

  const takeSnapshot = async (dir: string): Promise<Map<string, { mtimeMs?: number; size?: number } | null>> => {
    const out = new Map<string, { mtimeMs?: number; size?: number } | null>();
    let names: string[];
    try {
      names = await readDir(dir);
    } catch {
      return out; // vanished: the next sync re-arms
    }
    for (const n of names) {
      if (n === "." || n === "..") continue;
      try {
        const s = await stat(path.join(dir, n));
        out.set(n, s ? { mtimeMs: s.mtimeMs, size: s.size } : null);
      } catch {
        out.set(n, null);
      }
    }
    return out;
  };

  // fs events burst in clusters; coalesce them into one grid rebuild. The
  // callback fires from inside renderAll (syncCwdWatcher is a step), so a
  // re-entrant renderGrid — a pane switch or theme flip mid-paint — would
  // stack. Gate on a flag: a render in flight drops the tick, and the debounce
  // reschedules it for the next settle.
  let rendering = false;
  const onCwdChanged = debounced(
    200,
    async () => {
      if (ctx.isRenaming()) return;
      if (path.resolve(ctx.cwd()) !== watchedDir) return;
      if (rendering) {
        // a render is in flight; the next fs burst will re-arm the debounce
        return;
      }
      if (!recursiveSupported && watchedDir) {
        // non-recursive platform: the kernel watch only sees cwd-level
        // events, so a change inside a subdirectory would otherwise slip
        // through. Diff the snapshot; a mismatch means something moved in
        // or out and the grid must rebuild.
        try {
          const cur = await takeSnapshot(watchedDir);
          let changed = cur.size !== snapshot.size;
          if (!changed)
            for (const [k, v] of cur) {
              const prev = snapshot.get(k);
              if (
                prev === undefined ||
                prev === null ||
                v === null ||
                prev.mtimeMs !== v.mtimeMs ||
                prev.size !== v.size
              ) {
                changed = true;
                break;
              }
            }
          if (!changed) return;
          snapshot = cur;
        } catch (err) {
          ctx.log?.(`watcher readdir diff failed: ${err}`);
        }
      }
      rendering = true;
      try {
        const r = ctx.renderGrid();
        if (r && typeof (r as Promise<void>).then === "function") {
          (r as Promise<void>).finally(() => {
            rendering = false;
          });
        } else {
          rendering = false;
        }
      } catch {
        rendering = false;
      }
    },
    ctx.sched ?? globalThis,
  );

  const isIgnoredEvent = (filename?: string | null): boolean => {
    if (!filename || !watchedDir || !ctx.ignorePaths) return false;
    // node reports a dir-relative name; be lenient if an impl sends absolute
    const abs = path.isAbsolute(filename) ? path.normalize(filename) : path.join(watchedDir, filename);
    return ctx.ignorePaths().some((p) => path.resolve(p) === abs);
  };

  const onFsEvent = (filename?: string | null): void => {
    if (isIgnoredEvent(filename)) return;
    ctx.clearStatCache?.();
    onCwdChanged();
  };

  const closeWatcher = (): void => {
    if (watcher) {
      try {
        watcher.close();
      } catch (err) {
        ctx.log?.(`watcher close failed: ${err}`);
      }
      watcher = null;
    }
    watchErrored = false;
  };

  const syncCwdWatcher = (): void => {
    if (ctx.isVirtualCwd()) {
      closeWatcher();
      watchedDir = null;
      return;
    }
    const dir = path.resolve(ctx.cwd());
    // recorded == alive is NOT an invariant: a watch() throw or a kernel
    // error event (dir replaced under us) leaves the recorded dir with a
    // DEAD watcher. Track both conditions and re-arm — the grid otherwise
    // goes permanently stale with no signal.
    if (watchedDir === dir && !watchErrored && watcher) return;
    watchedDir = dir;
    closeWatcher();
    try {
      watcher = doWatch(dir, onFsEvent) as ReturnType<typeof watch>;
      watcher.on("error", (err) => {
        // never swallow silently: mark dead so the next sync re-arms (ANY
        // error — ENOENT or otherwise — means the kernel watch is gone)
        watchErrored = true;
        ctx.log?.(`watcher error on ${dir}: ${err}`);
      });
    } catch (err) {
      // dir vanished between resolve and watch — retried on the next sync
      watchErrored = true;
      ctx.log?.(`watcher failed on ${dir}: ${err}`);
    }
  };

  return { syncCwdWatcher, close: closeWatcher };
};
