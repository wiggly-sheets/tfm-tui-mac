// --- Self-update decisions, PURE (no fs, no network, no spawn). `tfm --update`
// (app/update-cli) and the startup check (wiring/update) both read their rules
// here so the reason strings and the "is this an install.sh copy" gate cannot
// drift apart. The impure half lives in ../fs/update-feed. ---

import path from "node:path";

// The canonical release repo. Hard-coded on purpose: the working clone's origin
// points at a fork, so reading `git remote` would fetch the wrong artifacts.
export const REPO = "wiggly-sheets/tfm-tui-mac";

// Latest-release endpoint; only `tag_name` is used.
export const latestReleaseApiUrl = `https://api.github.com/repos/${REPO}/releases/latest`;

// Download base for ONE explicit tag (never /releases/latest/download): the
// version we inspect must be the version we fetch.
export const releaseBaseUrl = (tag: string): string => `https://github.com/${REPO}/releases/download/${tag}`;

// Tag -> bare version ("v1.0.1" -> "1.0.1"), matching the install marker field.
export const versionOf = (tag: string): string => tag.replace(/^v/, "");

// --- release asset naming ---

// Release ARCH slug from process.platform + process.arch, or null when this
// host has no prebuilt release (the caller refuses instead of guessing).
export const updateAssetName = (platform: string, arch: string): string | null => {
  if (platform === "darwin") return arch === "arm64" ? "aarch64-macos" : arch === "x64" ? "x86_64-macos" : null;
  if (platform === "linux") return arch === "x64" ? "x86_64-linux" : arch === "arm64" ? "aarch64-linux" : null;
  return null;
};

// --- update-check cache (${XDG_DATA_HOME}/tfm/update-check.json) ---

export type UpdateCheckCache = { at: number; tag?: string; notifiedTag?: string };

// At most one GitHub poll per day.
export const checkIntervalMs = 24 * 60 * 60 * 1000;

// True when the cached check is missing/unreadable or older than the interval.
export const shouldCheck = (cache: UpdateCheckCache | null | undefined, nowMs: number): boolean => {
  const at = cache?.at;
  if (typeof at !== "number" || !Number.isFinite(at)) return true;
  return nowMs - at >= checkIntervalMs;
};

// --- refusal gate ---

// Every user-facing refusal lives here so update-cli and the tests share one
// wording. A package-manager copy must not be overwritten by a self-updater;
// a dev checkout has no install.sh marker to trust.
export const UPDATE_REFUSALS = {
  dev: "this is not a compiled tfm binary — install tfm with install.sh to use --update",
  marker: "this copy was not installed by install.sh — re-run install.sh to update it",
  repo: "this copy was not installed from wiggly-sheets/tfm-tui-mac — re-run install.sh to update it",
  method: "this copy is managed by a package manager — update it with that package manager",
  dir: "this copy is not the install.sh install directory — re-run install.sh to update it",
  arch: "no prebuilt tfm for this platform — re-run install.sh to build from source",
} as const;

// null = safe to self-update; otherwise the reason string to print.
export const installRefusalReason = (input: {
  marker: unknown;
  execPath: string;
  installDirResolved: string;
}): string | null => {
  if (path.basename(input.execPath) !== "tfm") return UPDATE_REFUSALS.dev;
  const m = input.marker;
  if (typeof m !== "object" || m === null) return UPDATE_REFUSALS.marker;
  const marker = m as Record<string, unknown>;
  if (
    typeof marker.version !== "string" ||
    typeof marker.installDir !== "string" ||
    typeof marker.repo !== "string" ||
    typeof marker.method !== "string"
  )
    return UPDATE_REFUSALS.marker;
  if (marker.repo !== REPO) return UPDATE_REFUSALS.repo;
  if (marker.method !== "script") return UPDATE_REFUSALS.method;
  if (marker.installDir !== input.installDirResolved) return UPDATE_REFUSALS.dir;
  return null;
};

// --- semver ---

export type ParsedVersion = { nums: [number, number, number]; pre: string[] };

// Lenient tag parse: optional leading `v`, numeric triple, optional prerelease,
// build metadata ignored. Anything else -> null ("no update known").
export const parseVersion = (tag: string): ParsedVersion | null => {
  if (typeof tag !== "string") return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
};

// semver identifier order: numeric < alphanumeric, else numeric value, else
// lexicographic ASCII (semver spec §11.4).
const cmpIdent = (a: string, b: string): number => {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

// null when either side is unparseable.
export const compareVersions = (a: string, b: string): number | null => {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const x = pa.nums[i] as number;
    const y = pb.nums[i] as number;
    if (x !== y) return x - y;
  }
  // a release outranks its own prereleases; two prereleases compare identifier
  // by identifier, and a shared prefix ranks shorter below longer
  if (!pa.pre.length && !pb.pre.length) return 0;
  if (!pa.pre.length) return 1;
  if (!pb.pre.length) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const c = cmpIdent(x, y);
    if (c !== 0) return c < 0 ? -1 : 1;
  }
  return 0;
};

// false for equal, older, and any unparseable tag on either side.
export const isNewer = (candidate: string, current: string): boolean => (compareVersions(candidate, current) ?? 0) > 0;
