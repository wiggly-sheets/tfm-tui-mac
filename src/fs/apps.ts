import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import { errMessage } from "../lib/uiutil";
import path from "node:path";
import { spawnSafe } from "./spawn-safe";
import { runSudo, sudoLaunchArgv, sudoOpenArgv } from "./elevate";
import { extOf, mimeForExt, mimeForPath } from "./filetype";
import { isDarwin } from "./darwin";
import type { NotifyLevel } from "../lib/notify-level";
import { xdgDataHome } from "./uri";

// --- Resolving what xdg-open would launch, so the "open" toast can say what
// launched, plus the "Open With…" chooser (enumerate `gio mime` handlers).
// Process/FS probing only — no renderer/state imports. ---

// run a command with a short timeout; returns trimmed stdout, "" on failure
export const runOutShort = async (cmd: string[], timeoutMs = 1500): Promise<string> => {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: timeoutMs });
    return (await new Response(proc.stdout).text()).trim();
  } catch {
    return "";
  }
};

const applicationDirs = (): string[] => [
  path.join(xdgDataHome(), "applications"),
  "/usr/local/share/applications",
  "/usr/share/applications",
  "/var/lib/flatpak/exports/share/applications",
  path.join(os.homedir(), ".local/share/flatpak/exports/share/applications"),
];

// human name for a desktop id: first non-localized Name= inside [Desktop Entry]
export const desktopAppName = async (desktopId: string): Promise<string> => {
  if (!desktopId) return "";
  for (const d of applicationDirs()) {
    try {
      // first non-localized Name= inside [Desktop Entry]
      const m = readFileSync(path.join(d, desktopId), "utf8").match(/^\[Desktop Entry\][\s\S]*?^Name=(.+)$/m);
      if (m?.[1]) return m[1].trim();
    } catch {}
  }
  return desktopId.replace(/\.desktop$/, "");
};

// absolute path of a desktop id (needed by `gio launch`), or null when unknown
export const desktopFilePath = (desktopId: string): string | null => {
  if (!desktopId) return null;
  for (const d of applicationDirs()) {
    const p = path.join(d, desktopId);
    if (existsSync(p)) return p;
  }
  return null;
};

// what the default open would launch for p: mime probe → default handler →
// app name. Darwin has no queryable default-handler API (duti stalls on
// macOS 26.4+, so no silent default-app set — and no read either): the toast
// degrades to no app name, honestly.
export const appForFile = async (p: string, platform: string = process.platform): Promise<string> => {
  if (isDarwin(platform)) return "";
  try {
    const mime = await runOutShort(["xdg-mime", "query", "filetype", p]);
    if (mime) return await desktopAppName(await runOutShort(["xdg-mime", "query", "default", mime]));
  } catch {}
  return "";
};

// `gio mime <type>` output → desktop ids, in order (default first, deduped)
export const parseGioMime = (out: string): string[] => {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const m of out.matchAll(/([A-Za-z0-9_.+-]+\.desktop)/g)) {
    const id = m[1];
    if (id === undefined) continue;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
};

export type AppChoice = { id: string; name: string; file: string };

// macOS app dirs for the Open With… chooser (no .desktop registry exists)
const darwinAppDirs = (home: string = os.homedir()): string[] => ["/Applications", path.join(home, "Applications")];

// launchable .app bundles: `<Name>.app` → choice id = bundle name. `ls`
// injectable so tests never touch /Applications.
export const darwinApps = (
  ls: (dir: string) => string[] = readdirSync,
  dirs: string[] = darwinAppDirs(),
): AppChoice[] => {
  const out: AppChoice[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = ls(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".app")) continue;
      const id = name.slice(0, -".app".length);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: id, file: path.join(dir, name) });
    }
  }
  return out;
};

// launchable handlers for a file: default + registered apps that resolve to a
// real .desktop file. `run` is injectable so tests never shell out. Content
// probe first (accurate for shebangs/odd bytes); when it fails (EACCES on a
// root-owned file) OR yields zero handlers (empty files sniff as
// inode/x-empty, which nothing registers), fall back to ext→mime — `gio mime`
// needs no file access. `mimeByExt` is injectable so tests don't depend on
// the boot-loaded globs2 cache.
export const appsForFile = async (
  p: string,
  run: (cmd: string[]) => Promise<string> = runOutShort,
  mimeByExt: (ext: string) => string | undefined = mimeForExt,
  platform: string = process.platform,
  lsApps: () => AppChoice[] = darwinApps,
): Promise<AppChoice[]> => {
  // darwin: no gio/xdg-mime registry — Open With… lists installed .app
  // bundles, launched via `open -a`. Content probe (mdls UTI → file → ext)
  // still runs so the toast path shares one probe, but the app list is
  // mime-independent (LaunchServices matching isn't queryable from CLI).
  if (isDarwin(platform)) {
    try {
      await mimeForPath(p, run);
    } catch {}
    try {
      return lsApps();
    } catch {
      return [];
    }
  }
  const collect = async (mime: string): Promise<AppChoice[]> => {
    const ids = parseGioMime(await run(["gio", "mime", mime]));
    const out: AppChoice[] = [];
    for (const id of ids) {
      const file = desktopFilePath(id);
      if (!file) continue;
      out.push({ id, name: await desktopAppName(id), file });
    }
    return out;
  };
  // one mime's probe failure must not skip the other mime's chance (custom
  // runners can throw; the default never does)
  const tryCollect = async (mime: string): Promise<AppChoice[]> => {
    try {
      return await collect(mime);
    } catch {
      return [];
    }
  };
  try {
    const probed = await run(["xdg-mime", "query", "filetype", p]);
    if (probed) {
      const apps = await tryCollect(probed);
      if (apps.length) return apps;
    }
    const extMime = mimeByExt(extOf(p));
    if (extMime && extMime !== probed) return tryCollect(extMime);
    return [];
  } catch {
    return [];
  }
};

// fire-and-forget launch (detached so the app outlives the spawn): gio on
// Linux, `open -a <app> <file>` on darwin (file = .app bundle path)
export const launchApp = (
  desktopFile: string,
  file: string,
  onFail?: (e: Error) => void,
  platform: string = process.platform,
): void => {
  if (isDarwin(platform)) {
    spawnSafe("open", ["-a", desktopFile, file], { stdio: "ignore", detached: true }, onFail).unref?.();
    return;
  }
  spawnSafe("gio", ["launch", desktopFile, file], { stdio: "ignore", detached: true }, onFail).unref?.();
};

// Shared gate+exec core behind both escalation primitives below: one password
// gate, then the awaited elevated child with honest toasts (never a lying
// "Opening …"). Never rejects (gate-cancel stays silent), so callers can
// fire-and-forget it.
type ElevatedDeps = {
  ensureSudo: (opLabel: string) => Promise<boolean>;
  exec?: (argv: string[]) => Promise<{ status: number | null; stderr: string }>;
  notify: (msg: string, title?: string, level?: NotifyLevel) => void;
  log: (msg: string) => void;
};

const runElevated = async (
  deps: ElevatedDeps,
  tag: "open-as-root" | "launch-as-root",
  opLabel: string,
  file: string,
  argv: string[],
  openedMsg: string,
  failedPrefix: string,
): Promise<void> => {
  const exec =
    deps.exec ??
    ((a: string[]): Promise<{ status: number | null; stderr: string }> => runSudo(a, { timeoutMs: 30_000 }));
  let ok = false;
  try {
    ok = await deps.ensureSudo(opLabel);
  } catch (err) {
    deps.log(`${tag} gate failed: ${err}`);
  }
  if (!ok) return;
  let r: { status: number | null; stderr: string };
  try {
    r = await exec(argv);
  } catch (err) {
    deps.log(`${tag} exec failed: ${err}`);
    deps.notify(`${failedPrefix} · ${errMessage(err)}`, "open", "error");
    return;
  }
  if (r.status === 0) {
    deps.notify(openedMsg, "open", "info");
    return;
  }
  const why =
    r.stderr
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? `exit ${r.status}`;
  deps.log(`${tag} failed for ${file}: ${why}`);
  deps.notify(
    `${failedPrefix} · ${why}${tag === "open-as-root" ? " (try sudoedit in a terminal)" : ""}`,
    "open",
    "error",
  );
};

// Escalation primitive behind the adaptive open: password gate first, then
// the default app as root. `exec` is injectable so tests capture argv without
// spawning.
export const makeOpenAsRoot = (
  deps: ElevatedDeps,
  platform: string = process.platform,
): ((p: string) => Promise<void>) => {
  return (p: string): Promise<void> =>
    runElevated(
      deps,
      "open-as-root",
      `open ${path.basename(p)} as root`,
      p,
      sudoOpenArgv(p, platform),
      `Opening ${path.basename(p)} as root`,
      `Can't open ${path.basename(p)} as root`,
    );
};

// Escalation primitive behind Open With… on unreadable files: password gate
// first, then the CHOSEN app as root. Same honest-toast contract as above
// (GUI apps as root may still fail on Wayland — the toast will say why).
export const makeLaunchAppAsRoot = (
  deps: ElevatedDeps,
  platform: string = process.platform,
): ((desktopFile: string, appName: string, p: string) => Promise<void>) => {
  return (desktopFile: string, appName: string, p: string): Promise<void> =>
    runElevated(
      deps,
      "launch-as-root",
      `open ${path.basename(p)} with ${appName} as root`,
      p,
      sudoLaunchArgv(desktopFile, p, platform),
      `Opening ${path.basename(p)} · ${appName} as root`,
      `Can't open ${path.basename(p)} with ${appName} as root`,
    );
};
