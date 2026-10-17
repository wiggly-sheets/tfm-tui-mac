// --- Quit: the single teardown path (tab-close-last, esc-menu, ctrl+q all
// route here). Order is load-bearing: drops disabled BEFORE the renderer dies
// so no OSC 72 frame is written to a dead terminal, and the XTSHIFTESCAPE
// request made at boot is released before exiting. Every step is
// best-effort — a throwing teardown must never strand the user in the TUI —
// but the exit code stays honest: 0 clean, 1 when any step threw (a masked
// teardown failure used to exit 0, hiding broken shutdowns from scripts). ---

import type { ExitCwdMode } from "../config/config-schema";

// --- [ui] exit-cwd: which directory the shell wrapper that set $TFM_CWD_FILE
// lands in. A virtual place (recent://, starred://) is not a directory a shell
// can cd to, so it falls back to the launch directory. Pure — the write itself
// is a quit step wired in nav. ---
export const resolveExitCwd = (mode: ExitCwdMode, activeCwd: string, launchCwd: string, isVirtual: boolean): string =>
  mode === "active-pane" && !isVirtual ? activeCwd : launchCwd;

export type QuitCtx = {
  disableDrops(): void;
  releaseShiftCapture(): void;
  // kill the embedded PTY pane — it would otherwise rely on EIO from the
  // dead master and a shell with a foreground child can linger
  closeTerminal?(): void;
  // close the gpm client socket (Linux text console only) so the daemon
  // doesn't re-point it at a default console after we're gone
  stopGpm?(): void;
  // clear pending chrome timers (sidebar device-reload) so they can't fire
  // loadSystemPlaces+renderAll into a destroyed renderer post-teardown
  stopChromeTimers?(): void;
  // synchronous final session write — process.exit kills pending async IO,
  // so the debounced 400ms save loses the last navigation
  flushSession?(): void;
  // [ui] exit-cwd: write the directory the shell wrapper should cd into
  // ($TFM_CWD_FILE — wired in nav; absent = no write). Sync, because
  // process.exit follows immediately.
  writeCwdFile?(): void;
  destroy(): void;
  exit(code: number): void;
  onQuit?: () => void;
  // file-op activity probe (wiring: shared queue depth) — refusing while
  // busy beats exiting mid-transfer (same reason restart refuses: completed
  // files would strand with no undo batch, .tfm-part-* swept only next run)
  isBusy?: () => boolean;
  // busy-refusal feedback (wiring: error toast). Best-effort, never throws.
  onBusy?: () => void;
};

export const makeQuit =
  (ctx: QuitCtx): (() => void) =>
  () => {
    if (ctx.isBusy?.()) {
      try {
        ctx.onBusy?.();
      } catch {}
      return;
    }
    let failed = runTeardownSteps(ctx);
    try {
      ctx.destroy();
    } catch {
      failed = true;
    }
    ctx.exit(failed ? 1 : 0);
  };

// --- The pre-destroy teardown steps, shared with restart (which runs them,
// then waits out the child, and only destroys/exits once it's gone). Order is
// load-bearing (see makeQuit) — keep the sequence here, not at call sites. ---
export const runTeardownSteps = (ctx: QuitCtx): boolean => {
  let failed = false;
  try {
    ctx.disableDrops();
  } catch {
    failed = true;
  }
  try {
    ctx.releaseShiftCapture();
  } catch {
    failed = true;
  }
  try {
    ctx.flushSession?.();
  } catch {
    failed = true;
  }
  try {
    ctx.writeCwdFile?.();
  } catch {
    failed = true;
  }
  try {
    ctx.closeTerminal?.();
  } catch {
    failed = true;
  }
  try {
    ctx.stopGpm?.();
  } catch {
    failed = true;
  }
  try {
    ctx.stopChromeTimers?.();
  } catch {
    failed = true;
  }
  try {
    ctx.onQuit?.();
  } catch {
    failed = true;
  }
  return failed;
};

// --- Signal shutdown (SIGHUP/SIGTERM/SIGINT). Closing the terminal window
// sends SIGHUP to the foreground process group, and OpenTUI's own exit handler
// only runs renderer.destroy() — it never exits, and a registered listener
// suppresses the OS default terminate action, so the tfm process outlived the
// window while its PTY shell child (killed only by closeTerminal) stayed
// orphaned. Fix: the signal path runs the SAME runTeardownSteps + destroy
// sequence as quit — a second, divergent teardown is how the shell survived. ---

// Conventional 128+signal codes: SIGHUP 129, SIGINT 130, SIGTERM 143 — what
// shells and scripts already expect from a signal-killed process.
const SIGNAL_EXIT_CODES: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

export const makeSignalShutdown = (ctx: QuitCtx, beforeExit?: () => Promise<void>): ((signal: string) => void) => {
  // teardown runs ONCE: the signals can arrive in any combination and
  // OpenTUI's exitHandler fires on the same events (its destroy is
  // idempotent, ours must be too)
  let shuttingDown = false;
  return (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      // the PTY dies FIRST: teardown is synchronous, so the async work that
      // must land before process.exit (config save, xattr drain) waits behind
      // it and cannot delay closeTerminal past the bounded cap
      try {
        runTeardownSteps(ctx);
      } catch {}
      try {
        await beforeExit?.();
      } catch {}
      try {
        ctx.destroy();
      } catch {}
      // the signal code wins over quit's 0/1 health code — a signal-killed
      // process reports the signal. No isBusy refusal either: file ops cannot
      // veto a window that is already gone.
      ctx.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
    })();
  };
};
