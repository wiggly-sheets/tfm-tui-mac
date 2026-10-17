// --- External URL opener (About links): fire-and-forget open/xdg-open with
// a failure toast. Success stays silent (a toast per link click is noise).
// spawnSafe arms the async error listener a bare spawn misses (missing
// binary would otherwise ride uncaughtException into exit(1)); the sync
// try/catch covers Bun-style throwers. No timeout: nothing waits on the
// child, so a wedged helper holds no queue. `spawn` is injectable for tests.
import { spawnSafe } from "./spawn-safe";
import { finderOpenArgs, isDarwin, openerBin } from "./darwin";
import path from "node:path";
import type { NotifyLevel } from "../lib/notify-level";

export type UrlOpenerDeps = {
  spawn?: typeof spawnSafe;
  notify: (message: string, title?: string, level?: NotifyLevel) => void;
  log?: (message: string) => void;
  /** platform override so tests pin the darwin branch on Linux CI */
  platform?: string;
};

// one fire-and-forget open spawn: `open` (darwin) / xdg-open (Linux), with an
// osascript Finder fallback when `open` itself fails. Shared by the About
// opener below and the default-open + config-file spawns (same binary,
// same fallback, one place).
export const spawnOpenTarget = (
  spawn: typeof spawnSafe,
  target: string,
  onFail: (err: Error) => void,
  opts?: { reveal?: boolean; detached?: boolean; platform?: string },
): void => {
  const platform = opts?.platform ?? process.platform;
  // reveal: Finder select (`open -R`) on darwin; Linux has no reveal verb,
  // so open the containing dir instead of the file itself
  const reveal = opts?.reveal === true;
  const darwin = isDarwin(platform);
  const finalTarget = reveal && !darwin ? path.dirname(target) : target;
  // check existence before spawning — on darwin `open` exits 0 even for missing
  // files, which would silently swallow the error. Skip for URLs (have scheme).
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
  if ((!darwin || reveal) && !isUrl) {
    try {
      const { statSync } = require("node:fs");
      if (!statSync(finalTarget).isFile() && !statSync(finalTarget).isDirectory()) {
        onFail(new Error(`not a file or directory: ${finalTarget}`));
        return;
      }
    } catch {
      onFail(new Error(`no such file or directory: ${finalTarget}`));
      return;
    }
  }
  const args = reveal && darwin ? ["-R", target] : [finalTarget];
  const child = spawn(
    openerBin(platform),
    args,
    { stdio: "ignore", ...(opts?.detached ? { detached: true } : {}) },
    (err) => {
      // `open` missing/broken essentially never happens; Finder fallback is
      // the last resort before the honest failure toast. Path is passed as a
      // script parameter (see finderOpenArgs) — never interpolated.
      if (darwin) {
        try {
          const script = reveal
            ? [
                "-e",
                "on run {f}",
                "-e",
                'tell application "Finder" to reveal POSIX file f',
                "-e",
                "end run",
                "--",
                target,
              ]
            : finderOpenArgs(target);
          spawn("/usr/bin/osascript", script, { stdio: "ignore" }, onFail).unref?.();
          return;
        } catch (e) {
          onFail(e instanceof Error ? e : new Error(String(e)));
          return;
        }
      }
      onFail(err);
    },
  );
  try {
    child.unref?.();
  } catch {}
};

export const makeUrlOpener = (deps: UrlOpenerDeps) => {
  const platform = deps.platform ?? process.platform;
  const bin = openerBin(platform);
  const failToast = (url: string, err: unknown): void => {
    try {
      deps.notify(`Couldn't open ${url} — is ${bin} installed?`, "open", "error");
    } catch {}
    deps.log?.(`open-url failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
  };

  const openUrl = (url: string): void => {
    try {
      spawnOpenTarget(deps.spawn ?? spawnSafe, url, (err) => failToast(url, err), { platform });
    } catch (err) {
      failToast(url, err);
    }
  };

  // reveal in the file manager: Finder select (`open -R`) on darwin, open
  // the containing dir on Linux (no xdg reveal verb exists)
  const revealPath = (p: string): void => {
    try {
      spawnOpenTarget(deps.spawn ?? spawnSafe, p, (err) => failToast(p, err), { reveal: true, platform });
    } catch (err) {
      failToast(p, err);
    }
  };

  return { openUrl, revealPath };
};
