// Locates the ffmpeg binary tfm uses for video thumbnails. The shipped
// sidecar comes first, then the dev dependency, then the system PATH (brew on
// macOS, distro ffmpeg on Linux) as a last resort so a copy without the
// sidecar still gets video thumbnails.
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { isDarwin, MACOS_FFMPEG_SIDECARS } from "./darwin";

export const SIDECAR_NAME = "tfm-ffmpeg";

export type VideoBinSource = "override" | "sidecar" | "dev" | "brew" | "path";
export type VideoBin = { bin: string; source: VideoBinSource };

export type VideoBinEnv = {
  override?: string | undefined; // $TFM_FFMPEG (test/ops seam, not a GUI knob)
  execDir?: string; // defaults to the running executable's directory
  devBin?: string | null; // require("ffmpeg-static") result, null when uninstalled
  brewBin?: string | null; // brew ffmpeg path (darwin fallback; injectable for tests)
  pathBin?: string | null; // system PATH ffmpeg (last resort; injectable for tests)
  platform?: string; // platform override so tests pin the darwin branch on Linux CI
};

const isRunnable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// Dynamic dev-only dep: missing/blocked postinstall is the normal null path.
const loadDevBin = (): string | null => {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: untyped CJS export (a path string)
    const mod: any = require("ffmpeg-static");
    return typeof mod === "string" ? mod : null;
  } catch {
    return null;
  }
};

export const resolveVideoBin = (env: VideoBinEnv = {}): VideoBin | null => {
  const {
    override = process.env.TFM_FFMPEG,
    execDir = path.dirname(process.execPath),
    devBin = loadDevBin(),
    brewBin = null,
    pathBin,
    platform = process.platform,
  } = env;
  if (override && isRunnable(override)) return { bin: override, source: "override" };
  const names = isDarwin(platform) ? [...MACOS_FFMPEG_SIDECARS, SIDECAR_NAME] : [SIDECAR_NAME];
  for (const name of names) {
    const sidecar = path.join(execDir, name);
    if (isRunnable(sidecar)) return { bin: sidecar, source: "sidecar" };
  }
  if (devBin && isRunnable(devBin)) return { bin: devBin, source: "dev" };
  // last resort: the system ffmpeg. Darwin prefers brew (documented install
  // path); Linux also accepts a distro ffmpeg so a source/package-manager
  // build without the sidecar still gets video thumbnails.
  if (isDarwin(platform)) {
    const brew = brewBin ?? Bun.which("ffmpeg");
    if (brew && isRunnable(brew)) return { bin: brew, source: "brew" };
  } else {
    const pathFfmpeg = pathBin === undefined ? Bun.which("ffmpeg") : pathBin;
    if (pathFfmpeg && isRunnable(pathFfmpeg)) return { bin: pathFfmpeg, source: "path" };
  }
  return null;
};

// Memoized per process: neither the sidecar nor node_modules moves mid-run.
let cached: VideoBin | null | undefined;
export const videoBin = (): VideoBin | null => (cached ??= resolveVideoBin());
export const resetVideoBin = (): void => {
  cached = undefined;
};
