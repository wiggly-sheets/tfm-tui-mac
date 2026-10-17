// --- Startup update check: fire-and-forget background work, wired LAST so the
// load-bearing boot order above it is untouched. It never blocks boot and never
// rejects. Only an install.sh copy is eligible (compiled basename + marker +
// matching install dir), and only when [update] check is on and the 24h cache
// has expired. A newer GitHub tag raises a plain toast — installing is the
// user's call (`tfm --update`), never an automatic swap. ---

import type { NotifyLevel } from "../lib/notify-level";
import pkg from "../../package.json";
import { fetchLatestTag, installDirOf, readInstallMarker, readUpdateCheck, writeUpdateCheck } from "../fs/update-feed";
import { installRefusalReason, isNewer, shouldCheck, type UpdateCheckCache, versionOf } from "../app/update";
import type { CoreWiring } from "./core";
import type { ChromeWiring } from "./types";

export type UpdateCheckDeps = {
  execPath?: string;
  installDirResolved?: string;
  marker?: unknown;
  now?: () => number;
  latestTag?: () => Promise<string | null>;
  readCache?: () => UpdateCheckCache | null;
  writeCache?: (cache: UpdateCheckCache) => Promise<void>;
};

export type UpdateCheckCtx = {
  check: boolean;
  notify: (message: string, title?: string, level?: NotifyLevel) => void;
};

export const runUpdateCheck = async (ctx: UpdateCheckCtx, deps: UpdateCheckDeps = {}): Promise<void> => {
  if (!ctx.check) return;
  const execPath = deps.execPath ?? process.execPath;
  const installDir = deps.installDirResolved ?? installDirOf(execPath);
  const marker = deps.marker !== undefined ? deps.marker : readInstallMarker();
  // dev run / package-manager copy / moved binary: not ours to update
  if (installRefusalReason({ marker, execPath, installDirResolved: installDir }) !== null) return;
  const now = deps.now?.() ?? Date.now();
  const cache = deps.readCache ? deps.readCache() : readUpdateCheck();
  if (!shouldCheck(cache, now)) return;

  const latest = await (deps.latestTag ?? fetchLatestTag)();
  const next: UpdateCheckCache = { at: now };
  if (typeof cache?.tag === "string") next.tag = cache.tag;
  if (latest !== null) next.tag = latest;
  if (latest !== null && isNewer(latest, pkg.version) && latest !== cache?.notifiedTag) {
    // remember before notifying: a throwing toast must not re-toast next launch
    next.notifiedTag = latest;
    try {
      ctx.notify(`tfm ${versionOf(latest)} is available · run tfm --update`, "Update", "info");
    } catch {}
  } else if (typeof cache?.notifiedTag === "string") {
    next.notifiedTag = cache.notifiedTag;
  }
  try {
    await (deps.writeCache ?? writeUpdateCheck)(next);
  } catch {}
};

// returns immediately: the check runs in the background, errors are swallowed
export const wireUpdate = (deps: { core: CoreWiring; chrome: ChromeWiring }): void => {
  let check = true;
  try {
    check = deps.core.config.update.check;
  } catch {
    return;
  }
  runUpdateCheck({ check, notify: (m, t, l) => deps.chrome.notify(m, t, l) }).catch(() => {});
};
